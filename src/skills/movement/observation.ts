import type { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../../adapter/types.ts';
import { standingContactCells, supportTop } from '../../perception/geometry.ts';
import type { LandSearchBoundary } from '../../spatial/land-search.ts';
import { assessLanding } from '../landing.ts';
import type { LandingOption, SkillCtx } from '../types.ts';

/**
 * 边界观察：只对与当前搜索边界相关的有限格集合发起一次观察。
 * 观察结果必须让“相关格”的证据版本变化，才允许重新搜索；单纯新增无关格、
 * 进入新区块或总 observedCells 增加都不能单独授权重搜。
 *
 * 对横向阻挡同时观察阻挡两侧的授权空间；对下降/未知落点复用当前可见落点
 * （assess_landings 的同一份 LandingOption 几何）观察落点、支撑、身体与两侧，
 * 但不执行任何落点。
 */

export interface ObservationReceipt {
  boundary: LandSearchBoundary;
  cells: Vec3Like[];
  attempted: boolean;
  observed: number;
  /** 本批观察造成的 VoxelMap 已观测格增量（与“相关证据变化”分开报告）。 */
  newObservedCells: number;
  /** 边界相关格中证据版本/可观测性发生变化的具体格。 */
  relatedCells: Vec3Like[];
  relatedChanged: boolean;
  turned: boolean;
  /** 下降边界附近当前可见的落点候选；只是观察证据，不是执行授权。 */
  landingCandidates?: (LandingOption & { descend: { target: Vec3Like } })[];
  /** 本次追加的落点候选观察格（已包含在 cells 里）。 */
  landingCells?: Vec3Like[];
}

export interface Corridor {
  origin: Vec3Like;
  bearing: { x: number; z: number };
  maxLateral: number;
}

const PROBE_LIMIT = 32;
const LANDING_RADIUS = 4;
const directionStep: Record<LandSearchBoundary['direction'], Vec3Like> = {
  N: { x: 0, y: 0, z: -1 },
  E: { x: 1, y: 0, z: 0 },
  S: { x: 0, y: 0, z: 1 },
  W: { x: -1, y: 0, z: 0 },
  UP: { x: 0, y: 1, z: 0 },
  DOWN: { x: 0, y: -1, z: 0 },
  HERE: { x: 0, y: 0, z: 0 },
};

const cellOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const keyOf = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
const lateralOf = (p: Vec3Like, corridor: Corridor | undefined): number => corridor === undefined
  ? 0
  : Math.abs((p.x - corridor.origin.x) * corridor.bearing.z - (p.z - corridor.origin.z) * corridor.bearing.x);
const withinCorridor = (p: Vec3Like, corridor: Corridor | undefined): boolean => corridor === undefined
  || lateralOf(p, corridor) <= corridor.maxLateral + 0.01;

/**
 * 与边界相关的观察格：
 * - 边界终点/起点、落点支撑、身体占用格、transition 前方一格；
 * - 水平阻挡的两侧（以及两侧的脚/头/支撑）；
 * - 垂直边界的落体列、落点、支撑和两侧；
 * - 下降边界的可见落点候选（目标、支撑、身体、落点两侧）单独追加。
 * 不扫全向；有横向授权时，超授权格不观察。
 */
export function boundaryProbeCells(
  boundary: LandSearchBoundary,
  limit = PROBE_LIMIT,
  corridor?: Corridor,
  landingOptions: readonly LandingOption[] = [],
): { cells: Vec3Like[]; landingCells: Vec3Like[] } {
  const to = cellOf(boundary.to);
  const from = cellOf(boundary.from);
  const step = directionStep[boundary.direction];
  const cells: Vec3Like[] = [];
  const seen = new Set<string>();
  const add = (cell: Vec3Like, stance = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }) => {
    const key = keyOf(cell);
    if (seen.has(key) || !withinCorridor(stance, corridor)) return;
    seen.add(key);
    cells.push(cell);
  };
  // 先补齐真实起/终脚位的身体与支撑；侧向探测不能挤掉非整数头部或跨列接触格。
  // corridor 限制脚位；合法脚位的身体可能压到边界外的相邻格，不能按格心丢掉这些接触格。
  for (const feet of [boundary.to, boundary.from]) standingContactCells(feet).forEach((cell) => add(cell, feet));
  if (boundary.kind === 'step' || boundary.kind === 'drop') {
    // step 先在起点上升再横移；drop 先在原高度横移再沿终点列下降。
    // 两端站位之间的身体扫掠也需要可见证据，不能只补终点脚/头两格。
    const column = boundary.kind === 'step' ? boundary.from : boundary.to;
    const bottom = Math.min(boundary.from.y, boundary.to.y), top = Math.max(boundary.from.y, boundary.to.y);
    for (let y = bottom; y < top; y += 1) standingContactCells({ ...column, y }).forEach((cell) => add(cell, column));
    standingContactCells({ ...column, y: top }).forEach((cell) => add(cell, column));
  }
  add({ x: to.x + step.x, y: to.y, z: to.z + step.z });
  add({ x: to.x + step.x, y: to.y - 1, z: to.z + step.z });

  const horizontal = boundary.direction === 'N' || boundary.direction === 'S' || boundary.direction === 'E' || boundary.direction === 'W';
  if (horizontal) {
    // 阻挡两侧（垂直于边界方向）的必要空间：脚/头/支撑与起点侧。
    const sides = boundary.direction === 'E' || boundary.direction === 'W'
      ? [{ x: 0, z: 1 }, { x: 0, z: -1 }] : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
    for (const side of sides) {
      for (const base of [to, from]) {
        add({ x: base.x + side.x, y: base.y, z: base.z + side.z });
        add({ x: base.x + side.x, y: base.y - 1, z: base.z + side.z });
        add({ x: base.x + side.x, y: base.y + 1, z: base.z + side.z });
        add({ x: base.x + side.x, y: base.y - 2, z: base.z + side.z });
      }
    }
  } else if (boundary.direction === 'DOWN') {
    const bottom = Math.min(from.y, to.y), top = Math.max(from.y, to.y);
    for (let y = bottom - 1; y <= top; y++) add({ x: to.x, y, z: to.z });
    add({ x: to.x, y: to.y - 2, z: to.z });
    for (const side of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
      add({ x: to.x + side.x, y: to.y, z: to.z + side.z });
      add({ x: to.x + side.x, y: to.y - 1, z: to.z + side.z });
      add({ x: to.x + side.x, y: to.y - 2, z: to.z + side.z });
    }
  } else if (boundary.direction === 'UP') {
    add({ x: to.x, y: to.y + 2, z: to.z });
    for (const side of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
      add({ x: to.x + side.x, y: to.y + 1, z: to.z + side.z });
      add({ x: to.x + side.x, y: to.y, z: to.z + side.z });
    }
  }

  // 可见落点候选：任何证据不足/阻挡边界都可能藏着下一级可连接落点（水平 UNKNOWN 也可能是
  // 落差），因此统一检查有限半径内的可见落点；只观察目标/支撑/身体/两侧与落体列，不执行。
  const landingCells: Vec3Like[] = [];
  for (const option of landingOptions) {
    if (option.clearance === 'blocked' || option.corridor === 'blocked') continue;
    const target = cellOf(option.target);
    const columnTop = Math.max(from.y - 1, target.y + 1);
    const column = [
      target,
      { x: target.x, y: target.y + 1, z: target.z },
      cellOf(option.support.pos),
      ...Array.from({ length: Math.min(6, Math.max(0, columnTop - target.y)) }, (_, index) => ({ x: target.x, y: columnTop - index, z: target.z })),
      { x: target.x + 1, y: target.y, z: target.z },
      { x: target.x - 1, y: target.y, z: target.z },
      { x: target.x, y: target.y, z: target.z + 1 },
      { x: target.x, y: target.y, z: target.z - 1 },
    ];
    for (const cell of column) {
      const key = keyOf(cell);
      if (seen.has(key) || !withinCorridor({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, corridor)) continue;
      seen.add(key);
      landingCells.push(cell);
    }
  }
  return { cells: [...cells, ...landingCells].slice(0, limit), landingCells: landingCells.slice(0, limit) };
}

/** 内容变化或过期证据恢复才是新依据；仍有效的同内容刷新不触发重复搜索。 */
function signatureOf(voxel: VoxelMap, dim: string, cell: Vec3Like, now: number): string {
  const view = voxel.cellAt(dim, cell.x, cell.y, cell.z);
  if (!view.observed) return 'unknown';
  return `${view.evidence.revision}:${view.evidence.freshness}:${view.evidence.validUntil >= now}:${view.evidence.observation.sessionId}`;
}

function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export async function observeBoundary(
  ctx: SkillCtx,
  opts: { boundary: LandSearchBoundary; maxCells: number; corridor?: Corridor },
): Promise<ObservationReceipt> {
  const spatial = ctx.spatial;
  const state = ctx.adapter.state();
  const voxel = spatial?.session?.voxel;
  const landingOptions = ctx.senses.landingOptions?.(LANDING_RADIUS) ?? [];
  const corridor = opts.corridor;
  const eligibleLandings = landingOptions.filter((option) =>
    (corridor === undefined || withinCorridor(option.target, corridor))
    && option.clearance !== 'blocked' && option.corridor !== 'blocked').slice(0, 4);
  const { cells, landingCells } = boundaryProbeCells(opts.boundary, Math.max(0, Math.min(PROBE_LIMIT, opts.maxCells)), corridor, eligibleLandings);
  const now = Date.now();
  const before = new Map(cells.map((cell) => [keyOf(cell), voxel === undefined ? 'unknown' : signatureOf(voxel, state.dim, cell, now)]));
  const base = {
    boundary: opts.boundary, cells, attempted: false, observed: 0, newObservedCells: 0,
    relatedCells: [] as Vec3Like[], relatedChanged: false, turned: false,
  };
  const landingCandidates = eligibleLandings.map((option) => {
    const support = option.surface === 'water' ? undefined : ctx.adapter.blockStateAt?.(option.support.pos);
    return {
      ...assessLanding(option, state.hp, support === undefined || support === null ? undefined : supportTop(support.name, support.properties ?? {})),
      descend: { target: { ...option.target } },
    };
  });
  if (voxel === undefined || ctx.senses.observeBlocks === undefined || cells.length === 0) {
    return {
      ...base,
      ...(landingCandidates.length ? { landingCandidates } : {}),
      ...(landingCells.length ? { landingCells } : {}),
    };
  }
  const observedCellsBefore = voxel.checkpointFullCounts().observedCells;

  const observeOnce = () => ctx.senses.observeBlocks!(cells);
  let observed = observeOnce();
  let turned = false;
  // 看见邻近的新鲜格不代表补齐了边界：对仍未知/过期的相关格最多定向一次。
  // cells 是整数方块格；不能给 boundary.to 的连续脚位再加半格当作观察目标。
  const target = cells.find((cell) => {
    const view = voxel.cellAt(state.dim, cell.x, cell.y, cell.z);
    return !view.observed || view.evidence.freshness !== 'FRESH' || view.evidence.validUntil < now
      || view.evidence.observation.sessionId !== state.sessionId || !view.evidence.observation.stateComplete;
  });
  if (target !== undefined) {
    const eye = ctx.adapter.eye();
    if (eye !== null) {
      const dx = target.x + 0.5 - eye.x, dy = target.y + 0.5 - eye.y, dz = target.z + 0.5 - eye.z;
      await ctx.adapter.look(yawTo(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)), ctx.signal);
      turned = true;
      observed = observeOnce();
    }
  }

  const relatedCells = cells.filter((cell) => signatureOf(voxel, state.dim, cell, now) !== before.get(keyOf(cell)));
  return {
    ...base,
    attempted: true,
    observed: observed.length,
    newObservedCells: voxel.checkpointFullCounts().observedCells - observedCellsBefore,
    relatedCells,
    relatedChanged: relatedCells.length > 0,
    turned,
    ...(landingCandidates.length ? { landingCandidates } : {}),
    ...(landingCells.length ? { landingCells } : {}),
  };
}
