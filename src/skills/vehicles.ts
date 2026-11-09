import type { BlockHit, Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import type { SkillCtx } from './types.ts';

/** 水面导航基础设施：只规划船身能通过的路线，不决定造船、上船或下船。 */

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const WATERISH = new Set(['water', 'bubble_column']);
const NOT_GROUND = new Set([...AIRISH, 'water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'lily_pad']);
const PASSABLE = new Set([...AIRISH, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'snow']);

type Ctx = SkillCtx;

const fluidAt = (ctx: Ctx, p: Vec3Like) => WATERISH.has(ctx.adapter.blockAt(p) ?? '');
/** 水面：水方块且上面是空气 */
export const isWaterSurface = (ctx: Ctx, p: Vec3Like) => fluidAt(ctx, p) && AIRISH.has(ctx.adapter.blockAt({ x: p.x, y: p.y + 1, z: p.z }) ?? 'air');
/** 周围 5×5 里有几格水面（衡量是不是一片开阔水域，而不是一个小水坑） */
export function openWater(ctx: Ctx, p: Vec3Like, r = 2): number {
  let n = 0;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (isWaterSurface(ctx, { x: p.x + dx, y: p.y, z: p.z + dz })) n++;
  return n;
}

/** 船身碰撞箱（1.375 宽、0.5625 高）浮在液面时会伸进相邻 8 列的水面那一层和上一层：这两层的 3×3 里不能有实心方块。 */
const BOAT_CLEAR = new Set([...AIRISH, ...WATERISH, 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
/** 船能不能放在这格水面上：服务器放船前会检查船身碰撞箱，贴着岸/堤/墙的一格水面会被拒（不扣船、不出实体）。 */
export function boatFits(ctx: Ctx, p: Vec3Like): boolean {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [0, 1]) {
    if (!BOAT_CLEAR.has(ctx.adapter.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz }) ?? '')) return false;
  }
  return true;
}

/** 能站人的格子：脚下实心、不是液体，脚和头两格可通过 */
export function standable(ctx: Ctx, p: Vec3Like): boolean {
  const below = ctx.adapter.blockAt({ x: p.x, y: p.y - 1, z: p.z });
  if (!below || NOT_GROUND.has(below)) return false;
  return [0, 1].every((dy) => PASSABLE.has(ctx.adapter.blockAt({ x: p.x, y: p.y + dy, z: p.z }) ?? 'air'));
}

/** 水面方块旁边、离自己最近的一块能站的岸边 */
export function shoreSpot(ctx: Ctx, water: Vec3Like, from: Vec3Like): Vec3Like | null {
  let best: { p: Vec3Like; d: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [1, 2, 0]) {
    if (!dx && !dz) continue;
    const p = { x: water.x + dx, y: water.y + dy, z: water.z + dz };
    if (!standable(ctx, p)) continue;
    const d = Math.hypot(dx, dz) * 2 + dist3(p, from) * 0.2;
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p ?? null;
}

/** 看得见的水面，优先朝 want 方向、开阔一些、近一些的 */
export function findWaterSurface(ctx: Ctx, maxDist: number, opts: { want?: { x: number; z: number }; minOpen?: number; shore?: boolean } = {}): BlockHit | null {
  ctx.senses.refresh();
  const here = ctx.adapter.state().pos;
  const hits = ctx.senses.knownBlocks(['water'], maxDist).filter((h) => isWaterSurface(ctx, h.pos));
  let best: { h: BlockHit; score: number } | null = null;
  for (const h of hits.slice(0, 400)) {
    const open = openWater(ctx, h.pos);
    if (open < (opts.minOpen ?? 4)) continue;
    // shore：只要旁边有能站人的岸（站在岸上放船/甩竿，不用先下水）
    if (opts.shore && !shoreSpot(ctx, h.pos, here)) continue;
    let score = h.dist;
    if (opts.want) {
      const vx = h.pos.x + 0.5 - here.x, vz = h.pos.z + 0.5 - here.z, len = Math.hypot(vx, vz) || 1;
      const cos = (vx * opts.want.x + vz * opts.want.z) / len;
      score -= cos * 6; // 朝着要去的方向的水面更好（不用回头绕）
    }
    score -= Math.min(open, 25) * 0.15;
    if (!best || score < best.score) best = { h, score };
  }
  return best?.h ?? null;
}

// ------------------------------------------------------------------ 水路寻路
type XZ = { x: number; z: number };
/** 船能浮着过去的格子：水（海草、海带也是水），上面是空气或睡莲（船会压碎睡莲） */
const BOAT_FLUID = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const BOAT_ABOVE = new Set([...AIRISH, 'lily_pad']);

/** 船所在的水面高度（水方块的 y）：船/坐船的人在水面方块里或高出一格；脚下那格不是水就看周围一圈 */
export function surfaceYAt(ctx: Ctx, p: Vec3Like): number | null {
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (const dy of [0, -1, -2, 1]) {
      const y = by + dy;
      if (BOAT_FLUID.has(ctx.adapter.blockAt({ x: bx + dx, y, z: bz + dz }) ?? '') && BOAT_ABOVE.has(ctx.adapter.blockAt({ x: bx + dx, y: y + 1, z: bz + dz }) ?? 'air')) return y;
    }
  }
  return null;
}

export type BoatRoute = {
  /** 水面高度 */
  sy: number;
  /** 依次经过的点（格子中心，已拉直）；最后一个是终点 */
  waypoints: XZ[];
  /** 靠岸后要踏上去的那格（人站的位置）；目标本身在水上、或水路到不了岸时为 null */
  landing: Vec3Like | null;
  /** water：目标就在水上；shore：停在离目标最近的低岸边；partial：水路只能走到离目标最近的地方 */
  reach: 'water' | 'shore' | 'partial';
};

/**
 * 在已加载的方块里沿水面找一条船能走的路（A*，8 邻接，不切角）：
 * - 目标在水上：划到目标旁边；
 * - 目标在陆上：在所有“旁边有能从船上直接跨上去的岸”的水格里，挑「划过去 + 上岸后步行到目标」总代价最小的那个停靠。
 *   能跨上去 = 岸上落脚处和水面齐平或只高一格（从船上跳得上去）；两格以上的土坎不算。
 * 一格宽的水道船身挤不过去，代价很高；没加载的区块当作走不通。
 */
export function planBoatRoute(ctx: Ctx, from: Vec3Like, target: XZ, opts: { maxNodes?: number; avoid?: Set<string> } = {}): BoatRoute | null {
  const sy = surfaceYAt(ctx, from);
  if (sy === null) return null;
  const key = (x: number, z: number) => `${x},${z}`;
  const navCache = new Map<string, boolean>();
  const nav = (x: number, z: number) => {
    const k = key(x, z);
    let v = navCache.get(k);
    if (v === undefined) {
      v = !opts.avoid?.has(k) && BOAT_FLUID.has(ctx.adapter.blockAt({ x, y: sy, z }) ?? '') && BOAT_ABOVE.has(ctx.adapter.blockAt({ x, y: sy + 1, z }) ?? 'air');
      navCache.set(k, v);
    }
    return v;
  };
  // 起点：船所在的格子（贴岸时可能落在岸上那格，取周围最近的水格）
  const fx = Math.floor(from.x), fz = Math.floor(from.z);
  let start: XZ | null = nav(fx, fz) ? { x: fx, z: fz } : null;
  if (!start) {
    let bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!nav(fx + dx, fz + dz)) continue;
      const d = Math.hypot(fx + dx + 0.5 - from.x, fz + dz + 0.5 - from.z);
      if (d < bd) { bd = d; start = { x: fx + dx, z: fz + dz }; }
    }
  }
  if (!start) return null;
  const tx = Math.floor(target.x), tz = Math.floor(target.z);
  const targetWater = nav(tx, tz);
  const h = (x: number, z: number) => Math.hypot(x - tx, z - tz);
  // 搜索范围：起点和目标的包围盒外扩 48 格
  const minX = Math.min(start.x, tx) - 48, maxX = Math.max(start.x, tx) + 48, minZ = Math.min(start.z, tz) - 48, maxZ = Math.max(start.z, tz) + 48;
  // 船身 1.375 格宽：船心在格子正中时会探进四周 8 格各 0.19 格，旁边（含斜角）有方块就会蹭上、卡在角上。
  // 所以四周 8 格都是水的格子才算“宽裕”，贴岸的格子代价高（只在不得不走、或者最后靠岸时才走）
  const narrowCost = (x: number, z: number) => {
    const w = !nav(x - 1, z), e = !nav(x + 1, z), n = !nav(x, z - 1), s = !nav(x, z + 1);
    // 一格宽（左右或前后都被方块夹住）：船身 1.375 格宽根本挤不过去，直接不可达，而不是“代价很高”。
    // 以前给 12 的代价，绕路更远时 A* 仍会选这条一格宽水道，船卡在里面反复纠结。
    if ((w && e) || (n && s)) return Infinity;
    let blocked = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz) && !nav(x + dx, z + dz)) blocked++;
    return blocked ? 3 + blocked * 0.5 : 0;
  };
  // 水格旁边能直接从船上跨上去的岸：返回最好的落脚处和额外代价
  const landingCache = new Map<string, { p: Vec3Like; extra: number } | null>();
  const landingNear = (x: number, z: number) => {
    const k = key(x, z);
    if (landingCache.has(k)) return landingCache.get(k)!;
    let best: { p: Vec3Like; extra: number; score: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if ((!dx && !dz) || nav(x + dx, z + dz)) continue;
      for (const [dy, extra] of [[1, 0], [2, 2]] as const) {
        const p = { x: x + dx, y: sy + dy, z: z + dz };
        if (!standable(ctx, p)) continue;
        const walk = Math.hypot(p.x - tx, p.z - tz) * 1.2 + extra + (dx && dz ? 0.5 : 0);
        if (!best || walk < best.score) best = { p, extra: walk, score: walk };
        break;
      }
    }
    const v = best ? { p: best.p, extra: best.extra } : null;
    landingCache.set(k, v);
    return v;
  };

  type Node = { x: number; z: number; g: number; f: number; parent: Node | null; goal?: Vec3Like | null };
  const heap: Node[] = [];
  const push = (n: Node) => {
    heap.push(n);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = (): Node | undefined => {
    const top = heap[0], last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const best = new Map<string, number>();
  const closed = new Set<string>();
  push({ ...start, g: 0, f: h(start.x, start.z), parent: null });
  best.set(key(start.x, start.z), 0);
  let closest: Node | null = null;
  let found: Node | null = null;
  const maxNodes = opts.maxNodes ?? 20000;
  for (let expanded = 0; heap.length && expanded < maxNodes;) {
    const cur = pop()!;
    if (cur.goal !== undefined) { found = cur; break; } // 虚拟终点：停在这里上岸
    const k = key(cur.x, cur.z);
    if (closed.has(k)) continue;
    closed.add(k);
    expanded++;
    if (!closest || h(cur.x, cur.z) < h(closest.x, closest.z)) closest = cur;
    if (targetWater) {
      if (h(cur.x, cur.z) <= 1.5) { found = { ...cur, goal: null }; break; }
    } else {
      const land = landingNear(cur.x, cur.z);
      if (land) push({ x: cur.x, z: cur.z, g: cur.g + land.extra, f: cur.g + land.extra, parent: cur.parent, goal: land.p });
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cur.x + dx, nz = cur.z + dz;
      if (nx < minX || nx > maxX || nz < minZ || nz > maxZ || !nav(nx, nz)) continue;
      if (dx && dz && (!nav(cur.x + dx, cur.z) || !nav(cur.x, cur.z + dz))) continue; // 不切角
      const nk = key(nx, nz);
      if (closed.has(nk)) continue;
      const g = cur.g + (dx && dz ? Math.SQRT2 : 1) + narrowCost(nx, nz);
      if (g >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, g);
      push({ x: nx, z: nz, g, f: g + h(nx, nz), parent: cur });
    }
  }
  const end = found ?? closest;
  if (!end) return null;
  // 终点那格本身：虚拟终点节点的 parent 指向它之前的格子，补回来
  const cells: XZ[] = [];
  for (let n: Node | null = found && found.goal !== undefined && found.goal !== null ? { ...found, goal: undefined } : end; n; n = n.parent) cells.push({ x: n.x, z: n.z });
  cells.reverse();
  const centers = cells.map((c) => ({ x: c.x + 0.5, z: c.z + 0.5 }));
  // 拉直：能直线划过去（沿线及两侧都是水）的中间点省掉
  const clear = (a: XZ, b: XZ) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) return true;
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    for (let t = 0; t <= len; t += 0.25) {
      const px = a.x + ux * t, pz = a.z + uz * t;
      // 两侧各看出半个船身多一点（0.75），不让拉直后的直线从岸角边擦过去
      for (const off of [-0.75, 0, 0.75]) if (!nav(Math.floor(px - uz * off), Math.floor(pz + ux * off))) return false;
    }
    return true;
  };
  const waypoints: XZ[] = [];
  for (let i = 0; i < centers.length - 1;) {
    let j = i + 1;
    for (let k = centers.length - 1; k > i + 1; k--) if (clear(centers[i], centers[k])) { j = k; break; }
    waypoints.push(centers[j]);
    i = j;
  }
  if (!waypoints.length) waypoints.push(centers[centers.length - 1]);
  const landing = found && found.goal ? found.goal : null;
  return { sy, waypoints, landing, reach: found ? (targetWater ? 'water' : landing ? 'shore' : 'partial') : 'partial' };
}
