import type { Vec3Like } from '../adapter/types.ts';

/**
 * 水面寻路：只在已观察到的水格里找一条从身体到调用方目标的水路。
 *
 * 这是执行辅助，不是策略：目标仍由调用方给，规划器只决定怎么游过去。
 * - 只用已加载/已观察的水格；不挖墙、不垫方块、不换目标。
 * - 支持水里上升、下潜和八向横游；最后一步必须能从水面爬上不高于水面 1 格的岸。
 * - 规划不出来就把原因交回；调用方仍可尝试直游或改用别的办法。
 */

type BlockAt = (p: Vec3Like) => string | null;

const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const PASS = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom', 'red_mushroom', 'torch', 'wall_torch',
  'vine', 'glow_lichen', 'pink_petals', 'sugar_cane', 'sweet_berry_bush', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

const isWater = (name: string | null) => name !== null && WATER.has(name);
const isPass = (name: string | null) => name !== null && PASS.has(name);
/** 能呼吸/能站人的空格；水草/海带虽然可穿过，但本身在水里，不算“露头空气”。 */
const isBreathable = (name: string | null) => isPass(name) && !isWater(name);
/** 已观察到的实心支撑；null（未加载）、岩浆、火、门等空心方块都不算支撑。 */
const NO_SUPPORT = new Set(['lava', 'fire', 'soul_fire', 'cobweb', 'nether_portal', 'end_portal', 'end_gateway', 'bubble_column']);
const isSolid = (name: string | null) => name !== null && !isPass(name) && !isWater(name) && !NO_SUPPORT.has(name);
/** 脚能站在空气里、下面是实心支撑：这是“上岸”的落脚格。 */
const isDryFooting = (blockAt: BlockAt, cell: Vec3Like) =>
  isBreathable(blockAt(cell)) && isPass(blockAt({ x: cell.x, y: cell.y + 1, z: cell.z })) && isSolid(blockAt({ x: cell.x, y: cell.y - 1, z: cell.z }));

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export type WaterRoute = {
  /** 水路段点（整数脚格）；最后一个点是最后一次下水的位置，之后由调用方走最后一段。 */
  cells: Vec3Like[];
  /** 找不到水路时给调用方看的事实。 */
  why?: string;
  /** 目标干岸比观察到的最高的水面还高 1 格以上：从水里直接爬不上去。 */
  reason?: 'SHORE_TOO_HIGH';
  /** 目标脚格 y（取整后）。 */
  targetY?: number;
  /** 目标附近观察到的最高的水面顶 y。 */
  waterTop?: number;
  /** 目标脚位比水面顶高几格（从水里直接上岸最多 1 格）。 */
  climbNeeded?: number;
};

/**
 * @param from 身体脚位置（可含小数）
 * @param to 调用方给的目标脚坐标（原样使用，不取整、不改写）
 * @returns 起点不在水里/目标不临水时返回 null（调用方照旧直游）；否则返回路点或空路点+原因。
 */
export function planWaterRoute(blockAt: BlockAt, from: Vec3Like, to: Vec3Like, opts: { maxNodes?: number; reach?: number } = {}): WaterRoute | null {
  const toCell = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
  const targetInWater = isWater(blockAt(toCell));
  const startCell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  // 起点只认身体所在的水格；脚刚好在水面空气里/流动水里时，就近找一格水（上下各两格）。
  const start = isWater(blockAt(startCell)) ? startCell
    : [0, 1, 2, -1, -2].map((dy) => ({ ...startCell, y: startCell.y + dy })).find((c) => isWater(blockAt(c)));
  if (!start) return null;
  // 目标不临水（干岸离水太远）：交回直游，不把“走到内陆”伪装成水路。
  if (!targetInWater && !dryLaunch(blockAt, to, toCell)) {
    // 目标附近确实观察到露出空气的水面，但最高的水面也比目标脚位低 1 格以上：
    // 从水里直接上岸够不着。只用已观察到的方块；未加载（null）不猜能不能爬。
    let waterTop: number | null = null;
    for (let dy = -6; dy <= 0; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (Math.hypot(dx, dz) > 2) continue;
      const c = { x: toCell.x + dx, y: toCell.y + dy, z: toCell.z + dz };
      if (!isWater(blockAt(c)) || !isBreathable(blockAt({ x: c.x, y: c.y + 1, z: c.z }))) continue;
      waterTop = waterTop === null ? c.y + 1 : Math.max(waterTop, c.y + 1);
    }
    if (waterTop !== null && isDryFooting(blockAt, toCell) && toCell.y - waterTop > 1) {
      const climbNeeded = toCell.y - waterTop;
      return { cells: [], reason: 'SHORE_TOO_HIGH', targetY: toCell.y, waterTop, climbNeeded,
        why: `目标脚位 (y=${toCell.y}) 比观察到的水面 (y=${waterTop}) 高 ${climbNeeded} 格；从水里直接爬上岸最多高 1 格` };
    }
    return null;
  }

  const reach = opts.reach ?? 48;
  const minX = Math.min(start.x, toCell.x) - reach, maxX = Math.max(start.x, toCell.x) + reach;
  const minZ = Math.min(start.z, toCell.z) - reach, maxZ = Math.max(start.z, toCell.z) + reach;
  const minY = Math.min(start.y, toCell.y) - 8, maxY = Math.max(start.y, toCell.y) + 10;
  const heuristic = (c: Vec3Like) => Math.hypot(c.x + 0.5 - to.x, c.y - to.y, c.z + 0.5 - to.z);
  const goal = (c: Vec3Like) => targetInWater
    ? Math.hypot(c.x + 0.5 - to.x, c.z + 0.5 - to.z) <= 1.0 && Math.abs(c.y - to.y) <= 1.5
    : canLaunchTo(blockAt, c, to, toCell);

  type Node = { x: number; y: number; z: number; g: number; f: number; parent: Node | null };
  const heap: Node[] = [];
  const push = (n: Node) => { heap.push(n); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  const best = new Map<string, number>([[key(start.x, start.y, start.z), 0]]);
  const closed = new Set<string>();
  push({ ...start, g: 0, f: heuristic(start), parent: null });
  let found: Node | null = null, closest: Node | null = null;
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let n = 0; heap.length && n < (opts.maxNodes ?? 6000) && !found; n++) {
    const cur = pop();
    const k = key(cur.x, cur.y, cur.z);
    if (closed.has(k)) continue;
    closed.add(k);
    if (!closest || heuristic(cur) < heuristic(closest)) closest = cur;
    if (goal(cur)) { found = cur; break; }
    const neighbors: Node[] = [];
    for (const [dx, dz] of dirs) {
      const nx = cur.x + dx, nz = cur.z + dz;
      if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
      if (!isWater(blockAt({ x: nx, y: cur.y, z: nz }))) continue;
      // 斜向不切角：两条正交边都必须是水。
      if (dx && dz && (!isWater(blockAt({ x: cur.x + dx, y: cur.y, z: cur.z })) || !isWater(blockAt({ x: cur.x, y: cur.y, z: cur.z + dz })))) continue;
      neighbors.push({ x: nx, y: cur.y, z: nz, g: 0, f: 0, parent: null });
    }
    for (const dy of [1, -1]) {
      const ny = cur.y + dy;
      if (ny < minY || ny > maxY) continue;
      if (isWater(blockAt({ x: cur.x, y: ny, z: cur.z }))) neighbors.push({ x: cur.x, y: ny, z: cur.z, g: 0, f: 0, parent: null });
    }
    for (const nb of neighbors) {
      const nk = key(nb.x, nb.y, nb.z);
      if (closed.has(nk)) continue;
      const diagonal = Math.abs(nb.x - cur.x) + Math.abs(nb.z - cur.z) === 2;
      const g = cur.g + (diagonal ? Math.SQRT2 : 1);
      if (g >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, g);
      const node = { ...nb, g, f: g + heuristic(nb), parent: cur };
      push(node);
    }
  }
  const end = found ?? closest;
  if (!found || !end) {
    const targetCell = blockAt(toCell);
    const why = targetInWater
      ? `已观察到 ${Math.round(heuristic(closest ?? start))} 格内的水里没有连到目标水点的路`
      : targetCell !== null && !isPass(targetCell) && !isWater(targetCell)
        ? `目标格 (${toCell.x},${toCell.y},${toCell.z}) 是 ${targetCell}，不是脚能站的空气格`
        : `已观察到的水域连不到能上岸到目标的水点（可能需要挖开/垫块，或目标被实心方块封住）`;
    return { cells: [], why };
  }
  const path: Vec3Like[] = [];
  for (let n: Node | null = end; n; n = n.parent) path.push({ x: n.x, y: n.y, z: n.z });
  path.reverse();
  // 拉直：沿水格直线可见就合并，减少来回切换委托的次数。
  const clear = (a: Vec3Like, b: Vec3Like) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const c = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), z: Math.round(a.z + (b.z - a.z) * t) };
      if (!isWater(blockAt(c))) return false;
    }
    return true;
  };
  const cells: Vec3Like[] = [];
  for (let i = 0; i < path.length - 1;) {
    let j = path.length - 1;
    while (j > i + 1 && !clear(path[i], path[j])) j--;
    // 起点已经在身体所在格（三维都近）：不需要为它再下一道游泳委托。
    if (i > 0 || Math.hypot(path[j].x + 0.5 - from.x, path[j].y - from.y, path[j].z + 0.5 - from.z) >= 0.6) cells.push(path[j]);
    i = j;
  }
  return { cells };
}

/** 干岸目标是否紧邻可下水的水面（离水太远就不属于 swim_to 的水路委托）。 */
function dryLaunch(blockAt: BlockAt, to: Vec3Like, toCell: Vec3Like): boolean {
  // 岸最多比水面高 1 格，所以发射水格在目标脚下方 2 格以内（再低就不是这个岸了）。
  for (let dy = -3; dy <= 0; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const c = { x: toCell.x + dx, y: toCell.y + dy, z: toCell.z + dz };
    if (Math.hypot(c.x + 0.5 - to.x, c.z + 0.5 - to.z) > 2) continue;
    if (canLaunchTo(blockAt, c, to, toCell)) return true;
  }
  return false;
}

/** 这个水格能否作为最后一段：是水面（上方两格可呼吸）且目标不高于水面 1 格、是真实落脚格。 */
function canLaunchTo(blockAt: BlockAt, c: Vec3Like, to: Vec3Like, toCell: Vec3Like): boolean {
  if (!isWater(blockAt(c))) return false;
  if (!isBreathable(blockAt({ x: c.x, y: c.y + 1, z: c.z })) || !isPass(blockAt({ x: c.x, y: c.y + 2, z: c.z }))) return false;
  if (Math.hypot(c.x + 0.5 - to.x, c.z + 0.5 - to.z) > 2) return false;
  // 从水里上岸：岸脚最多比水面（水格上方）高 1 格；目标本身必须是能站的空气格。
  if (toCell.y - (c.y + 1) > 1) return false;
  if (toCell.y < c.y - 1) return false;
  if (!isDryFooting(blockAt, toCell)) return false;
  return approachClear(blockAt, c, toCell);
}

/** 出水后到岸脚这一小段必须没有实心墙；未知（null）不算墙，由最后一段实测确认。 */
function approachClear(blockAt: BlockAt, from: Vec3Like, toCell: Vec3Like): boolean {
  const dx = toCell.x - from.x, dz = toCell.z - from.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) * 2));
  for (const y of [toCell.y, toCell.y + 1, from.y + 1]) {
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(from.x + dx * t), z = Math.round(from.z + dz * t);
      if (x === from.x && z === from.z) continue;
      if (isSolid(blockAt({ x, y, z }))) return false;
    }
  }
  return true;
}
