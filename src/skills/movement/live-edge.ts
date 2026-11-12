import type { GameAdapter, Vec3Like } from '../../adapter/types.ts';
import { collisionBoxes, isPassableDoor, shapeKnown, supportSurfaces } from '../../perception/geometry.ts';
import { isDangerousBlock, isWaterBlock, supportColumnsUnder, sweptBodyCells } from '../../spatial/land-edge-policy.ts';
import type { MoveMode } from './session.ts';

/**
 * 执行期的“眼前这一小步”确认。
 *
 * 路线仍然只由共享 VoxelMap 的 A* 规划；这个模块不搜索、不改目标，也不参与 make-way。
 * 它只在执行器准备保留速度跨过下一格时，用当前已加载的客户端方块再看一眼这一格：
 * 体素里该格还没被感知写进来（UNKNOWN/INCOMPLETE/STALE）并不等于世界不能走。
 * 能看到当前几何就继续走；看不到（区块未加载/状态未知）或看到阻挡/危险就停，交回原流程观察或重规划。
 *
 * 这是“当前身体感知”的即时确认，不把客户端方块伪装成历史证据：不写 VoxelMap，也不改变搜索结论。
 */

export type LiveEdgeStatus = {
  status: 'open' | 'blocked' | 'unknown';
  reason?: string;
  /** 阻挡格，用于让回执保留 blocker 位置。 */
  cell?: Vec3Like;
  /** 阻挡类别，帮助上层区分碰撞/危险/缺支撑，不冒充已观测的搜索结论。 */
  problem?: 'collision' | 'danger' | 'support';
};

const HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
const EPS = 1e-9;
/** 与库 evaluateWalkTo 的 MAX_WALK_TO_DISTANCE 一致：身体在起点格列角落时到下一格中心仍可走。 */
const MAX_WALK_TO_DISTANCE = Math.SQRT2 * 1.5 + 0.01;
const NON_COLLIDING = new Set(['air', 'cave_air', 'void_air', 'light', 'structure_void']);

const finite = (p: Vec3Like): boolean => [p.x, p.y, p.z].every(Number.isFinite);
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

type CellFacts =
  | { kind: 'clear' }
  | { kind: 'water' }
  | { kind: 'dangerous'; name: string }
  | { kind: 'solid'; name: string; properties: Record<string, string | number | boolean>; boxes: readonly number[][] }
  | { kind: 'unknown'; reason: string };

/**
 * 一个已加载方块的碰撞事实。不能只看视觉分类 `Optics.kind === 'clear'`：
 * 玻璃、屏障等对视线是透明的，但对身体是实心；必须以 blockstate 的碰撞盒为准。
 * 空气类方块仍走快路径，不必为每一步的扫掠格创建方块对象。
 */
function cellFacts(adapter: GameAdapter, x: number, y: number, z: number): CellFacts {
  const optics = adapter.blockOptics(x, y, z);
  if (optics === null) return { kind: 'unknown', reason: `格 (${x},${y},${z}) 未加载` };
  const name = optics.name.replace(/^minecraft:/, '');
  if (isDangerousBlock(name)) return { kind: 'dangerous', name };
  if (isWaterBlock(name)) return { kind: 'water' };
  if (NON_COLLIDING.has(name)) return { kind: 'clear' };
  const state = adapter.blockStateAt?.({ x, y, z }) ?? null;
  if (state === null) return { kind: 'unknown', reason: `格 (${x},${y},${z}) 形状未加载` };
  if (isPassableDoor(state.name, state.properties)) return { kind: 'clear' };
  if (!shapeKnown(state.name, state.properties)) return { kind: 'unknown', reason: `${state.name} 的碰撞形状未确认` };
  const boxes = collisionBoxes(state.name, state.properties);
  return boxes.length === 0 ? { kind: 'clear' } : { kind: 'solid', name: state.name, properties: state.properties, boxes };
}

/**
 * 连续扫掠 AABB 与单个方块盒的重叠时间。X/Y/Z 必须存在共同的**正长度**时间区间；
 * 只在扫掠包络里、身体从未占据的角落不算碰撞（与库的 segmentHitsBox 同口径）。
 */
function axisTimes(min0: number, max0: number, delta: number, sMin: number, sMax: number): [number, number] | null {
  if (delta === 0) return max0 - sMin > EPS && sMax - min0 > EPS ? [0, 1] : null;
  const a = (sMin - max0) / delta, b = (sMax - min0) / delta;
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(1, Math.max(a, b));
  return hi - lo > EPS ? [lo, hi] : null;
}

function segmentHitsBox(cell: Vec3Like, box: readonly number[], from: Vec3Like, to: Vec3Like): boolean {
  const xt = axisTimes(from.x - HALF_WIDTH, from.x + HALF_WIDTH, to.x - from.x, cell.x + box[0]!, cell.x + box[3]!);
  if (xt === null) return false;
  const yt = axisTimes(from.y, from.y + BODY_HEIGHT, to.y - from.y, cell.y + box[1]!, cell.y + box[4]!);
  if (yt === null) return false;
  const zt = axisTimes(from.z - HALF_WIDTH, from.z + HALF_WIDTH, to.z - from.z, cell.z + box[2]!, cell.z + box[5]!);
  if (zt === null) return false;
  return Math.min(xt[1], yt[1], zt[1]) - Math.max(xt[0], yt[0], zt[0]) > EPS;
}

/**
 * step 与 drop 在库里的规范走廊是两段：step 先在原 XZ 竖直抬升、再按目标脚高平移；
 * drop 先按原脚高平移、再在目标 XZ 竖直下落。只按 from→to 一条斜线扫掠会把台阶本身误判成墙。
 */
function legsOf(from: Vec3Like, to: Vec3Like, kind: 'walk' | 'step' | 'drop'): [{ from: Vec3Like; to: Vec3Like }, ...{ from: Vec3Like; to: Vec3Like }[]] {
  if (kind === 'walk') return [{ from, to }];
  const lift = { x: from.x, y: to.y, z: from.z };
  return kind === 'step'
    ? [{ from, to: lift }, { from: lift, to }]
    : [{ from, to: { x: to.x, y: from.y, z: to.z } }, { from: { x: to.x, y: from.y, z: to.z }, to }];
}

/**
 * 目的脚位正下方/同格支撑：脚底范围与至少一个可站立顶面有正面积交集，且顶面高度就是计划脚高。
 * 半砖、雪层、台阶等分数脚高都按真实碰撞形状算，不按方块名猜。
 */
function supportStatus(adapter: GameAdapter, to: Vec3Like): LiveEdgeStatus {
  const integerFeet = Math.abs(to.y - Math.round(to.y)) <= 0.05;
  const supportY = integerFeet ? Math.round(to.y) - 1 : Math.floor(to.y);
  const footprint = { minX: to.x - HALF_WIDTH, maxX: to.x + HALF_WIDTH, minZ: to.z - HALF_WIDTH, maxZ: to.z + HALF_WIDTH };
  let sawUnknown = false;
  for (const cell of supportColumnsUnder(to, supportY)) {
    const facts = cellFacts(adapter, cell.x, cell.y, cell.z);
    if (facts.kind === 'dangerous') return { status: 'blocked', reason: `落点支撑是 ${facts.name}`, cell, problem: 'danger' };
    if (facts.kind === 'water' || facts.kind === 'unknown') { sawUnknown = true; continue; }
    if (facts.kind === 'clear') continue;
    for (const surface of supportSurfaces(facts.name, facts.properties)) {
      if (!(cell.x + surface.maxX > footprint.minX + EPS && cell.x + surface.minX < footprint.maxX - EPS
        && cell.z + surface.maxZ > footprint.minZ + EPS && cell.z + surface.minZ < footprint.maxZ - EPS)) continue;
      if (Math.abs(supportY + surface.top - to.y) <= 0.05) return { status: 'open' };
    }
  }
  return sawUnknown
    ? { status: 'unknown', reason: '落点支撑形状/区块未加载' }
    : { status: 'blocked', reason: '落点脚下没有与计划脚高相符的可站立面', problem: 'support' };
}

/**
 * 当前已加载方块下，这一小步（相邻 walk/step/drop）是否可执行。
 * 只在执行器已经由 A* 选定这条边、且 VoxelMap 证据不足时作为补充确认使用。
 */
export function liveEdgeStatus(
  adapter: GameAdapter,
  from: Vec3Like,
  to: Vec3Like,
  kind: MoveMode,
  opts: { wade?: boolean } = {},
): LiveEdgeStatus {
  if (kind !== 'walk' && kind !== 'step' && kind !== 'drop') return { status: 'unknown', reason: `不即时确认 ${kind}` };
  if (!finite(from) || !finite(to)) return { status: 'unknown', reason: '坐标不是有限数' };
  if (Math.hypot(to.x - from.x, to.z - from.z) > MAX_WALK_TO_DISTANCE) return { status: 'unknown', reason: '不是相邻一小步' };
  if (kind === 'walk' && Math.abs(to.y - from.y) > 0.05) return { status: 'unknown', reason: 'walk 脚高不一致' };
  if (kind === 'step' && to.y <= from.y + 0.05) return { status: 'unknown', reason: 'step 没有向上' };
  if (kind === 'drop' && to.y >= from.y - 0.05) return { status: 'unknown', reason: 'drop 没有向下' };

  const legs = legsOf(from, to, kind);
  const checked = new Set<string>();
  for (const leg of legs) {
    for (const cell of sweptBodyCells(leg.from, leg.to)) {
      const key = cellKey(cell.x, cell.y, cell.z);
      if (checked.has(key)) continue;
      checked.add(key);
      const facts = cellFacts(adapter, cell.x, cell.y, cell.z);
      if (facts.kind === 'unknown') return { status: 'unknown', reason: facts.reason };
      if (facts.kind === 'dangerous') return { status: 'blocked', reason: `身体会碰到 ${facts.name}`, cell, problem: 'danger' };
      if (facts.kind === 'water') {
        // 涉水只允许脚部接触水；头格在水里会窒息，仍按阻挡处理。
        if (!opts.wade) return { status: 'blocked', reason: '脚/身体会碰到水', cell, problem: 'danger' };
        if (cell.y >= Math.floor(to.y) + 1) return { status: 'blocked', reason: '头部会进入水', cell, problem: 'danger' };
        continue;
      }
      if (facts.kind === 'clear') continue;
      for (const box of facts.boxes) {
        if (legs.some((entry) => segmentHitsBox(cell, box, entry.from, entry.to))) {
          return { status: 'blocked', reason: `身体扫到 ${facts.name}`, cell, problem: 'collision' };
        }
      }
    }
  }
  // 库的涉水规则：落点脚格本身是水时不要求可站立支撑；头格已在上面的扫掠里检查。
  const feet = { x: Math.floor(to.x), y: Math.floor(to.y + 0.05), z: Math.floor(to.z) };
  const wading = opts.wade === true && cellFacts(adapter, feet.x, feet.y, feet.z).kind === 'water';
  if (!wading) {
    const support = supportStatus(adapter, to);
    if (support.status !== 'open') return support;
  }
  return { status: 'open' };
}

/** 某一格的脚、头两层是否无碰撞、不是危险格/水；不要求支撑。 */
function cellBodyClear(adapter: GameAdapter, x: number, feetY: number, z: number): LiveEdgeStatus {
  for (const y of [feetY, feetY + 1]) {
    const facts = cellFacts(adapter, x, y, z);
    if (facts.kind === 'unknown') return { status: 'unknown', reason: facts.reason, cell: { x, y, z } };
    if (facts.kind === 'dangerous') return { status: 'blocked', reason: `格是 ${facts.name}`, cell: { x, y, z }, problem: 'danger' };
    if (facts.kind === 'water') return { status: 'blocked', reason: '格是水', cell: { x, y, z }, problem: 'danger' };
    if (facts.kind === 'solid') return { status: 'blocked', reason: `格被 ${facts.name} 占住`, cell: { x, y, z }, problem: 'collision' };
  }
  return { status: 'open' };
}

/** 某一格作为“身体可能压过去”的落脚空间：两层无碰撞，脚下有支撑，不是危险格/水。 */
function standingCellStatus(adapter: GameAdapter, x: number, feetY: number, z: number, wade: boolean): LiveEdgeStatus {
  const body = cellBodyClear(adapter, x, feetY, z);
  if (body.status !== 'open') return body;
  if (!wade) {
    const support = supportStatus(adapter, { x: x + 0.5, y: feetY, z: z + 0.5 });
    if (support.status !== 'open') return support;
  }
  return { status: 'open' };
}

/**
 * 带速度转弯的净空：A→B→C 时身体会擦过切角格 A+C−B；保留前进键的惯性还会把身体
 * 往原方向多带一段（B+(B−A) 那一格）。两格都必须能容纳身体，转弯才带速度；
 * 任一未加载/被挡就回退为原来的停车转弯。只对同高度的整格脚高 walk 转弯启用。
 */
export function liveTurnStatus(
  adapter: GameAdapter,
  a: Vec3Like, b: Vec3Like, c: Vec3Like,
  opts: { wade?: boolean } = {},
): LiveEdgeStatus {
  if (!finite(a) || !finite(b) || !finite(c)) return { status: 'unknown', reason: '坐标不是有限数' };
  if (Math.abs(a.y - b.y) > 0.05 || Math.abs(b.y - c.y) > 0.05) return { status: 'unknown', reason: '带速度转弯只用于同脚高' };
  if (Math.abs(a.y - Math.round(a.y)) > 0.05) return { status: 'unknown', reason: '带速度转弯只用于整格脚高' };
  if (Math.hypot(b.x - a.x, b.z - a.z) > 1.5 + 1e-6 || Math.hypot(c.x - b.x, c.z - b.z) > 1.5 + 1e-6) {
    return { status: 'unknown', reason: '转弯不是相邻一小步' };
  }
  const ax = Math.floor(a.x), az = Math.floor(a.z), bx = Math.floor(b.x), bz = Math.floor(b.z), cx = Math.floor(c.x), cz = Math.floor(c.z);
  const feetY = Math.round(a.y);
  const wade = opts.wade === true;
  const cut = { x: ax + cx - bx, z: az + cz - bz };
  const overshoot = { x: bx + (bx - ax), z: bz + (bz - az) };
  for (const cell of [cut, overshoot]) {
    const status = standingCellStatus(adapter, cell.x, feetY, cell.z, wade);
    if (status.status !== 'open') return status;
  }
  // 带速度转弯时身体会向两侧甩；角点周围一圈有墙就退回停车转弯（窄走廊/门框），
  // 不拿一次擦墙的代价换速度。开阔地这一圈为空，仍然连续。
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = bx + dx, z = bz + dz;
      if ((dx === 0 && dz === 0) || (x === cut.x && z === cut.z) || (x === overshoot.x && z === overshoot.z)) continue;
      const status = cellBodyClear(adapter, x, feetY, z);
      if (status.status !== 'open') return status;
    }
  }
  return { status: 'open' };
}
