import type { BlockHit, Vec3Like } from '../adapter/types.ts';
import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import { lookAround, sighted } from './movement.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { craft } from './work.ts';

/**
 * 坐船：把“做船 → 找水面放船 → 坐上去 → 划到目标 → 靠岸下船 → 把船收回背包”合成一个像人一样的动作。
 * 底层仍是 use_item / interact / ride / dismount 这几个通用原语。
 */

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const WATERISH = new Set(['water', 'bubble_column']);
const NOT_GROUND = new Set([...AIRISH, 'water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'lily_pad']);
const PASSABLE = new Set([...AIRISH, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'snow']);

/** 有船的木种（bamboo 做的叫 bamboo_raft） */
const BOAT_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo'] as const;
const boatOf = (w: string) => (w === 'bamboo' ? 'bamboo_raft' : `${w}_boat`);
export const isBoatItem = (n: string) => /_boat$|_raft$/.test(n) && !/chest_(boat|raft)$/.test(n);
const isBoatEntity = (n: string) => /(^|_)(boat|raft)$/.test(n);
/** 普通船（不含运输船 chest_boat：打碎会把箱子里的东西撒出来） */
const isPlainBoat = (n: string) => isBoatEntity(n) && !/chest_(boat|raft)$/.test(n);

type Ctx = SkillCtx;
type Inv = { name: string; count: number }[];
const countOf = (inv: Inv, n: string) => inv.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);

/** 按背包里的木料挑一种能凑齐 5 块同种木板的船；返回 null 表示不够 */
export function chooseBoat(inv: Inv): { item: string; planks: number } | null {
  let best: { item: string; planks: number; direct: number } | null = null;
  for (const w of BOAT_WOODS) {
    const direct = countOf(inv, `${w}_planks`);
    const logs = w === 'bamboo'
      ? countOf(inv, 'bamboo_block') * 2 + countOf(inv, 'stripped_bamboo_block') * 2
      : (countOf(inv, `${w}_log`) + countOf(inv, `stripped_${w}_log`) + countOf(inv, `${w}_wood`) + countOf(inv, `stripped_${w}_wood`)) * 4;
    const planks = direct + logs;
    if (planks < 5) continue;
    if (!best || (direct >= 5 ? 1 : 0) > (best.direct >= 5 ? 1 : 0) || planks > best.planks) best = { item: boatOf(w), planks, direct };
  }
  return best ? { item: best.item, planks: best.planks } : null;
}

const describeWood = (inv: Inv) => {
  const wood = inv.filter((i) => /_(planks|log|wood)$|^bamboo_block$/.test(i.name)).map((i) => `${i.name}×${i.count}`);
  return wood.length ? wood.join('、') : '没有任何木头';
};

const fluidAt = (ctx: Ctx, p: Vec3Like) => WATERISH.has(ctx.adapter.blockAt(p) ?? '');
/** 水面：水方块且上面是空气 */
export const isWaterSurface = (ctx: Ctx, p: Vec3Like) => fluidAt(ctx, p) && AIRISH.has(ctx.adapter.blockAt({ x: p.x, y: p.y + 1, z: p.z }) ?? 'air');
/** 周围 5×5 里有几格水面（衡量是不是一片开阔水域，而不是一个小水坑） */
export function openWater(ctx: Ctx, p: Vec3Like, r = 2): number {
  let n = 0;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (isWaterSurface(ctx, { x: p.x + dx, y: p.y, z: p.z + dz })) n++;
  return n;
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

/**
 * 放得下船的水面：船有 1.375 格宽，放在紧贴岸边的那格水上，船身会压进岸上的方块，服务器直接不放（报 Failed to place entity）。
 * 四周 8 格都是水面才算宽裕；返回宽裕的格子数（8 = 完全开阔）。
 */
export function boatRoom(ctx: Ctx, p: Vec3Like): number {
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((dx || dz) && isWaterSurface(ctx, { x: p.x + dx, y: p.y, z: p.z + dz })) n++;
  return n;
}

/**
 * 站在岸边伸手放船：够得着（眼睛到水面 4.5 格内，服务器按 5 格视线找水面）、四周宽裕的水面里挑最近的。
 * 船的碰撞箱 1.375 格宽，会和人（以及别的船）相撞：服务器放船前检查船身碰不碰到人，碰到就报 Failed to place entity。
 * 所以船心离自己水平方向至少 minGap 格（默认 1.3，船半宽 0.69 + 人半宽 0.3 再留点余量），也不放在已有的船上。
 */
export function boatSpot(ctx: Ctx, fallback: BlockHit, opts: { minGap?: number; exclude?: Set<string> } = {}): BlockHit {
  const eye = ctx.adapter.eye();
  const here = ctx.adapter.state().pos;
  const from = eye ? { x: eye.x, y: eye.y, z: eye.z } : { x: here.x, y: here.y + 1.62, z: here.z };
  const minGap = opts.minGap ?? 1.3;
  const boats = ctx.senses.perceivedEntities(8).filter((e) => e.kind !== 'item' && isBoatEntity(e.name));
  const clearOf = (p: Vec3Like) => {
    const cx = p.x + 0.5, cz = p.z + 0.5;
    if (Math.max(Math.abs(cx - here.x), Math.abs(cz - here.z)) < minGap) return false;
    if (opts.exclude?.has(`${p.x},${p.z}`)) return false;
    return !boats.some((b) => Math.max(Math.abs(b.pos.x - cx), Math.abs(b.pos.z - cz)) < 1.5);
  };
  let best: { h: BlockHit; score: number } | null = null;
  for (const h of ctx.senses.knownBlocks(['water'], 6).filter((b) => isWaterSurface(ctx, b.pos))) {
    const d = dist3(from, { x: h.pos.x + 0.5, y: h.pos.y + 0.9, z: h.pos.z + 0.5 });
    if (d > 4.5 || !clearOf(h.pos)) continue;
    const room = boatRoom(ctx, h.pos);
    const score = (8 - room) * 3 + d;
    if (!best || score < best.score) best = { h, score };
  }
  return best?.h ?? fallback;
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

/** 把一个向量归到最近的 8 方位 */
export function nearestDir(vx: number, vz: number): string {
  let best = 'N', bestDot = -Infinity;
  const len = Math.hypot(vx, vz) || 1;
  for (const [k, [dx, dz]] of Object.entries(DIRS)) {
    const dot = (vx * dx + vz * dz) / len;
    if (dot > bestDot) { bestDot = dot; best = k; }
  }
  return best;
}

const parseXZ = (v: unknown): { x: number; z: number } | null | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'object') {
    const o = obj(v);
    return Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.z)) ? { x: Number(o.x), z: Number(o.z) } : null;
  }
  const m = String(v).match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(?:-?\d+(?:\.\d+)?[ ,]+)?(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { x: +m[1], z: +m[2] } : null;
};

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
  const narrowCost = (x: number, z: number) => {
    const w = !nav(x - 1, z), e = !nav(x + 1, z), n = !nav(x, z - 1), s = !nav(x, z + 1);
    if ((w && e) || (n && s)) return 8; // 一格宽：船身 1.375 格，挤不过去
    return ((w ? 1 : 0) + (e ? 1 : 0) + (n ? 1 : 0) + (s ? 1 : 0)) * 0.4; // 贴岸走容易蹭停，稍微离岸
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
      for (const off of [-0.45, 0, 0.45]) if (!nav(Math.floor(px - uz * off), Math.floor(pz + ux * off))) return false;
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

const footOverWater = (ctx: Ctx) => {
  const p = ctx.adapter.state().pos;
  const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  return ctx.adapter.state().inWater || fluidAt(ctx, f) || fluidAt(ctx, { ...f, y: f.y - 1 });
};

/**
 * 下船后脚下还是水（被放在船顶上、或掉进水里）：先朝岸边那格跳上去（从船顶踏上岸，寻路在船上/水里走不动），
 * 不行再游/走到旁边最近的岸上。prefer = 规划好的上岸点。
 */
async function stepAshore(ctx: Ctx, heading: { x: number; z: number }, prefer: Vec3Like | null = null) {
  if (!footOverWater(ctx)) return true;
  const p = ctx.adapter.state().pos;
  const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  let best: { p: Vec3Like; s: number } | null = null;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1, -1]) {
    const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
    if (!standable(ctx, q)) continue;
    const s = Math.hypot(dx, dz) - (dx * heading.x + dz * heading.z) * 0.3; // 优先往前（对岸）
    if (!best || s < best.s) best = { p: q, s };
  }
  const land = (prefer && standable(ctx, prefer) && dist3(prefer, p) <= 4 ? prefer : null) ?? best?.p ?? ctx.senses.nearestLand?.(p)?.pos ?? null;
  if (!land) return false;
  // 近在一两格：面朝那格按住前进+跳，像人一样从船上/浅水里一步跨上去
  if (ctx.adapter.drive && Math.hypot(land.x + 0.5 - p.x, land.z + 0.5 - p.z) <= 2.6) {
    const face = { x: land.x + 0.5, y: land.y + 1.2, z: land.z + 0.5 };
    for (let i = 0; i < 3 && footOverWater(ctx); i++) {
      try { await ctx.adapter.drive({ forward: true, jump: true }, 600, ctx.signal, { facePoint: face }); } catch (e) { if (isAbort(e)) throw e; }
      await sleep(250, ctx.signal);
    }
    if (!footOverWater(ctx)) return true;
  }
  try {
    if (ctx.adapter.state().inWater && ctx.adapter.swimTo) await ctx.adapter.swimTo(land, ctx.signal, { timeoutMs: 12000 });
    else await ctx.adapter.moveTo({ kind: 'xyz', x: land.x, y: land.y, z: land.z }, { signal: ctx.signal, timeoutMs: 10000 });
  } catch (e) {
    if (isAbort(e)) throw e;
  }
  return !footOverWater(ctx);
}

/** 被取消时还坐在船上：用独立的信号尽量下船（原任务的信号已经中止了） */
async function bailOut(ctx: Ctx) {
  try {
    if (ctx.adapter.state().riding && ctx.adapter.dismount) await ctx.adapter.dismount(AbortSignal.timeout(4000));
  } catch { /* ignore */ }
}

/** 把靠岸的船打掉（1.20 里连打几下船就会碎成船物品），再把掉落的船捡回背包 */
async function retrieveBoat(ctx: Ctx, boatId: number | null, boatItems: () => number, boatPos: Vec3Like): Promise<{ kept: boolean; note: string }> {
  const { adapter, senses, signal } = ctx;
  const before = boatItems();
  const findBoat = () => {
    senses.refresh();
    const ents = senses.perceivedEntities(8);
    // 只打自己坐的那条；认不出 id 时（本来就坐在船上开始的）只认下船处 3 格内的普通船，别人的船/运输船不碰
    return ents.find((e) => e.id === boatId)
      ?? (boatId === null ? ents.filter((e) => e.kind !== 'item' && isPlainBoat(e.name) && dist3(e.pos, boatPos) <= 3).sort((a, b) => dist3(a.pos, boatPos) - dist3(b.pos, boatPos))[0] : undefined);
  };
  let boat: ReturnType<typeof findBoat> | undefined = findBoat();
  /** 低头看向脚边某处（掉落物很矮，平视看不到） */
  const lookToward = async (p: Vec3Like, h = 0.3) => {
    const eye = adapter.eye();
    if (!eye) return;
    const vx = p.x - eye.x, vz = p.z - eye.z, vy = p.y + h - eye.y;
    await adapter.look(Math.hypot(vx, vz) > 0.2 ? Math.atan2(-vx, -vz) : eye.yaw, Math.atan2(vy, Math.max(0.3, Math.hypot(vx, vz))), signal);
    await sleep(200, signal);
  };
  if (!boat) {
    // 上岸后船多半在身后：回头看一眼下船的地方
    await lookToward(boatPos);
    boat = findBoat();
  }
  if (!boat) return { kept: false, note: '下船处附近看不见自己的船，没去收' };
  try { await adapter.equipWeapon(signal); } catch (e) { if (isAbort(e)) throw e; }
  let hits = 0;
  let lastPos: Vec3Like = boat.pos;
  for (; hits < 16 && boat && Date.now() < ctx.deadline - 3000; hits++) {
    if (boat.dist > 2.8) {
      try { await adapter.moveTo({ kind: 'near', pos: boat.pos, range: 2 }, { signal, timeoutMs: 6000 }); } catch (e) { if (isAbort(e)) throw e; }
    }
    await adapter.attack(boat.id, signal);
    await sleep(300, signal); // 等攻击冷却，满蓄力的一下伤害才高
    const id = boat.id;
    lastPos = boat.pos;
    senses.refresh();
    boat = senses.perceivedEntities(8).find((e) => e.id === id);
  }
  if (boat) return { kept: false, note: `打了 ${hits} 下船还没碎，留在岸边了` };
  // 捡回掉落的船
  for (let i = 0; i < 4 && boatItems() <= before; i++) {
    await lookToward(lastPos, 0.1);
    senses.refresh();
    const drop = senses.perceivedEntities(10).find((e) => e.kind === 'item' && isBoatItem(e.name.replace(/^item:/, '')));
    if (!drop) { await adapter.collectNearbyDrops(signal, 6, 2000); continue; }
    try { await adapter.moveTo({ kind: 'near', pos: drop.pos, range: 1 }, { signal, timeoutMs: 6000 }); } catch (e) { if (isAbort(e)) throw e; }
  }
  return boatItems() > before ? { kept: true, note: '船已收回背包' } : { kept: false, note: '船打碎了但掉落物没捡到（可能漂走了）' };
}

// ------------------------------------------------------------------ boat
type BoatArgs = { to?: { x: number; z: number }; direction?: string; distance: number; until?: string; keep: boolean };

export const boat: Skill<BoatArgs> = {
  name: 'boat',
  description: '过河/渡湖/沿海岸远行时坐船：没船先用 5 块同种木板做一条，沿水路绕弯划向目标，目标在陆上就停到离它最近、跨得上去的岸边下船并收船；比游泳快不会淹死',
  argsDoc: '{"to"?:"x,z","direction"?:"N|E|S|W|NE…","distance"?:8-240,"until"?,"keep"?}',
  timeoutMs: 180000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const direction = typeof a.direction === 'string' && a.direction.trim() ? a.direction.trim().toUpperCase() : undefined;
    if (direction && !DIRS[direction]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    const to = parseXZ(a.to);
    if (to === null) return { ok: false, error: 'to 的格式是 "x,z"' };
    const until = typeof a.until === 'string' && a.until.trim() ? a.until.trim().toLowerCase().slice(0, 80) : undefined;
    const keep = !(a.keep === false || a.keep === 'false');
    return { ok: true, args: { ...(to ? { to } : {}), ...(direction ? { direction } : {}), distance: clampInt(a.distance, 8, 240, 64), ...(until ? { until } : {}), keep } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.ride || !adapter.useItemOn || !adapter.interactEntity || !adapter.dismount) return fail('ERROR', '当前适配器不支持坐船');
    const s0 = adapter.state();
    const boatItems = () => adapter.state().inventory.filter((i) => isBoatItem(i.name)).reduce((n, i) => n + i.count, 0);
    // 想去的方向（单位向量）：坐标 > 方位 > 稍后按找到的水面定
    const wantOf = (from: Vec3Like): { x: number; z: number } | undefined => {
      if (args.to) { const dx = args.to.x - from.x, dz = args.to.z - from.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; }
      if (args.direction) { const [dx, dz] = DIRS[args.direction]; return { x: dx, z: dz }; }
      return undefined;
    };
    let crafted: string | null = null;
    let boatId: number | null = null;
    let direction = args.direction;
    const notes: string[] = [];

    try {
      if (s0.riding && !isBoatEntity(s0.riding)) return fail('BAD_ARGS', `正在乘坐 ${s0.riding}，先 dismount 再坐船`);
      if (!s0.riding) {
        // ---- b) 准备一条船
        let item = adapter.state().inventory.find((i) => isBoatItem(i.name) && i.count > 0)?.name;
        if (!item) {
          const inv = adapter.state().inventory;
          const pick = chooseBoat(inv);
          if (!pick) return fail('MISSING_MATERIALS', `背包里没有船，也凑不齐做船的材料：一条船要 5 块同种木板（约 2 块同种原木），附近没工作台还要多 4 块木板；现有：${describeWood(inv)}`,
            { shortfall: '5 块同种木板（约 2 块同种原木）' });
          ctx.progress(0.05, `先用木板做一条 ${pick.item}`);
          const r = await craft.run(ctx, { item: pick.item, count: 1 });
          if (r.status !== 'succeeded') return fail(r.failureCode ?? 'MISSING_MATERIALS', `做船失败：${r.summary}${r.failureCode === 'NO_CRAFTING_TABLE' ? '（船要在工作台上做：背包里没有工作台，也没走到记得的工作台；先做一个放身上，或者先 craft 好船再来）' : ''}`, r.data);
          item = adapter.state().inventory.find((i) => isBoatItem(i.name) && i.count > 0)?.name;
          if (!item) return fail('ERROR', `合成报告成功，但背包里没看到船（${r.summary}）`);
          crafted = item;
        }

        // ---- c) 找水面、走到岸边、放船、坐上去
        const here = adapter.state().pos;
        let water = findWaterSurface(ctx, 24, { want: wantOf(here), shore: !s0.inWater });
        if (!water && !s0.inWater) {
          ctx.progress(0.12, '四下找找水面');
          await lookAround.run(ctx, { seconds: 3, for: 'water', ...(direction ? { direction } : {}) });
          water = findWaterSurface(ctx, 24, { want: wantOf(adapter.state().pos), shore: true });
        }
        if (!water && s0.inWater) water = findWaterSurface(ctx, 6, { minOpen: 1 });
        if (!water) return fail('NOT_FOUND', `附近 24 格内看不见能放船的开阔水面${crafted ? `（船已经做好放在背包里：${crafted}）` : ''}`, crafted ? { crafted } : undefined);
        if (!direction && !args.to) direction = nearestDir(water.pos.x + 0.5 - here.x, water.pos.z + 0.5 - here.z);

        if (!adapter.state().inWater && dist3(adapter.state().pos, { x: water.pos.x + 0.5, y: water.pos.y + 0.5, z: water.pos.z + 0.5 }) > 3.5) {
          ctx.progress(0.2, `走到水边（${Math.round(water.dist)} 格）`);
          const spot = shoreSpot(ctx, water.pos, adapter.state().pos);
          try {
            if (spot) await adapter.moveTo({ kind: 'xyz', x: spot.x, y: spot.y, z: spot.z }, { signal, timeoutMs: Math.min(40000, Math.max(5000, ctx.deadline - Date.now() - 60000)) });
            else await adapter.moveTo({ kind: 'near', pos: water.pos, range: 2 }, { signal, timeoutMs: 30000 });
          } catch (e) {
            if (isAbort(e)) throw e;
            if (dist3(adapter.state().pos, water.pos) > 4.5) return fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `走不到水边：${(e as Error).message}`);
          }
        }
        // 走到岸边后重新挑最近的水面放船（够得着、船身不压着自己）；没放成就换一格离自己更远的再放一次
        ctx.progress(0.3, `把 ${item} 放到水面上`);
        const knownBoats = new Set(ctx.senses.perceivedEntities(12).filter((e) => isBoatEntity(e.name)).map((e) => e.id));
        const tried = new Set<string>();
        let near: BlockHit = water;
        let ent: ReturnType<typeof ctx.senses.perceivedEntities>[number] | undefined;
        let lastWhy = '';
        for (let attempt = 0; attempt < 2 && !ent; attempt++) {
          near = boatSpot(ctx, findWaterSurface(ctx, 5, { want: wantOf(adapter.state().pos), minOpen: 2 }) ?? water, { minGap: attempt ? 2 : 1.3, exclude: tried });
          if (tried.has(`${near.pos.x},${near.pos.z}`)) break; // 没有别的格子可换了
          tried.add(`${near.pos.x},${near.pos.z}`);
          const before = boatItems();
          const placed = await adapter.useItemOn(item, { kind: 'block', pos: near.pos }, signal);
          const target = near.pos;
          const findNew = () => {
            ctx.senses.refresh();
            return ctx.senses.perceivedEntities(12).filter((e) => e.kind !== 'item' && isPlainBoat(e.name) && !knownBoats.has(e.id))
              .sort((a, b) => dist3(a.pos, target) - dist3(b.pos, target))[0];
          };
          ent = findNew();
          for (let i = 0; !ent && i < 8; i++) { await sleep(250, signal); ent = findNew(); }
          if (!ent) {
            const room = boatRoom(ctx, near.pos);
            const p = adapter.state().pos;
            const gap = Math.max(Math.abs(near.pos.x + 0.5 - p.x), Math.abs(near.pos.z + 0.5 - p.z));
            lastWhy = `${placed.ok ? '船没有出现在水面上' : placed.reason}${boatItems() < before ? '（背包里的船少了一条，可能放到别处了）' : ''}；对着的水面 (${near.pos.x},${near.pos.y},${near.pos.z}) 周围 8 格里 ${room} 格是水`
              + `${room < 8 ? '（船身比一格宽，挨着岸放不下：往开阔些的水边走几步再放）' : ''}${gap < 1.3 ? '（离自己太近，船身会压着自己）' : ''}`;
          }
        }
        if (!ent) {
          const inWater = adapter.state().inWater;
          return fail('ERROR', `放船失败：${lastWhy}${inWater ? '；人泡在水里，船放不到身边——先上岸，站在岸上朝离自己两三格的开阔水面放' : ''}`);
        }
        boatId = ent.id;
        ctx.progress(0.38, '坐上船');
        let mounted = false;
        for (let attempt = 0; attempt < 3 && !mounted; attempt++) {
          ctx.senses.refresh();
          const cur = ctx.senses.perceivedEntities(12).find((e) => e.id === boatId) ?? ent;
          if (cur.dist > 2.8) {
            try { await adapter.moveTo({ kind: 'follow_entity', entityId: cur.id, range: 2 }, { signal, timeoutMs: 8000 }); } catch (e) { if (isAbort(e)) throw e; }
          }
          const r = await adapter.interactEntity(cur.id, null, signal);
          mounted = r.ok && !!adapter.state().riding;
          if (!mounted) await sleep(300, signal);
        }
        if (!mounted) return fail('ERROR', '船放下了但坐不上去（船还在水边，可以用 interact 再试）', { boatId });
      } else notes.push(`本来就坐在 ${s0.riding} 上`);

      // ---- d) 划船：沿水面寻路（绕弯、避开一格宽的水道），目标在陆上就停到离它最近、人能跨上去的低岸边
      const start = adapter.state().pos;
      if (!direction && !args.to) {
        const w = findWaterSurface(ctx, 24, { minOpen: 4 });
        direction = w ? nearestDir(w.pos.x + 0.5 - start.x, w.pos.z + 0.5 - start.z) : undefined;
        if (!direction) { await bailOut(ctx); return fail('BAD_ARGS', '已经在船上，但没给 direction/to，前方也看不见水面'); }
      }
      const [dx, dz] = direction ? DIRS[direction] : [0, 0];
      const target = args.to ?? { x: start.x + dx * args.distance, z: start.z + dz * args.distance };
      const heading = (() => { const vx = target.x - start.x, vz = target.z - start.z, l = Math.hypot(vx, vz) || 1; return { x: vx / l, z: vz / l }; })();
      ctx.progress(0.45, `划船去 ${Math.round(target.x)},${Math.round(target.z)}`);
      let seen: { what: string; dist: number } | null = null;
      const stop = () => { if (!args.until) return false; ctx.senses.refresh(); seen = sighted(ctx, args.until); return !!seen; };
      const avoid = new Set<string>();
      let route: BoatRoute | null = null;
      let r: Awaited<ReturnType<NonNullable<typeof adapter.ride>>> = { ok: true, arrived: false, moved: 0 };
      let moved = 0, replans = 0;
      for (let leg = 0; leg < 4; leg++) {
        const here = adapter.state().pos;
        route = planBoatRoute(ctx, here, target, { avoid });
        const end = route ? route.waypoints[route.waypoints.length - 1] : target;
        const via = route ? route.waypoints.slice(0, -1) : [];
        // 已经停在上岸点旁边（或目标旁边）就不用再划
        if (route && Math.hypot(end.x - here.x, end.z - here.z) <= 1.2) { r = { ok: true, arrived: true, moved: 0 }; break; }
        r = await adapter.ride(end, signal, {
          timeoutMs: Math.max(3000, ctx.deadline - Date.now() - 25000), // 留时间靠岸、收船
          stop, via, arriveWithin: route ? 0.8 : 2,
        });
        moved += r.moved;
        if (seen || !r.ok || !r.blocked || !route) break;
        // 半路蹭到岸/障碍：离终点不远就算到了，否则把前面那格记成走不通、从这里重新规划
        const p = adapter.state().pos;
        if (Math.hypot(end.x - p.x, end.z - p.z) <= 1.8) { r = { ...r, arrived: true }; break; }
        const next = route.waypoints.find((w) => Math.hypot(w.x - p.x, w.z - p.z) > 1) ?? end;
        const l = Math.hypot(next.x - p.x, next.z - p.z) || 1;
        avoid.add(`${Math.floor(p.x + ((next.x - p.x) / l) * 1.2)},${Math.floor(p.z + ((next.z - p.z) / l) * 1.2)}`);
        replans++;
        if (Date.now() > ctx.deadline - 30000) break;
      }
      moved = Math.round(moved);
      const found = seen as { what: string; dist: number } | null;
      const how = found ? `看见 ${found.what}（${found.dist} 格外）停下`
        : route?.reach === 'shore' && r.arrived ? '划到离目标最近、能上岸的岸边'
          : route?.reach === 'partial' ? '水路到不了目标，划到了水路上离目标最近的地方'
            : r.arrived ? '到了目标附近' : r.blocked ? '前方靠岸/有障碍停下' : r.ok ? '停下' : `中途出问题（${r.reason}）`;
      if (replans) notes.push(`途中蹭到岸重新找了 ${replans} 次路`);

      // ---- e) 下船（先面朝要上的那块岸：服务器按乘客朝向挑下船落点）、上岸、收船
      ctx.progress(0.85, '下船');
      const landing = route?.landing && route.reach === 'shore' && r.arrived ? route.landing : null;
      if (adapter.state().riding) {
        const d = await adapter.dismount(signal, landing ? { toward: { x: landing.x + 0.5, y: landing.y, z: landing.z + 0.5 } } : undefined);
        if (!d.ok) return fail('ERROR', `划了 ${moved} 格（${how}），但下不了船：${d.reason}`, { moved });
      }
      const boatPos = adapter.state().pos;
      const ashore = await stepAshore(ctx, heading, landing);
      if (!ashore) notes.push(landing ? `靠岸了但没能跨上岸（岸边落脚处 ${landing.x},${landing.y},${landing.z}），还在水里` : '附近没有能从水里直接上去的岸（岸太高或太远），还在水里');
      let kept = false;
      if (args.keep && ashore) {
        ctx.progress(0.92, '把船收回背包');
        const k = await retrieveBoat(ctx, boatId, boatItems, boatPos);
        kept = k.kept;
        notes.push(k.note);
      } else if (args.keep) notes.push('没上岸，船先不收');
      else notes.push(ashore ? '船留在岸边' : '船留在水上');
      if (crafted) notes.unshift(`先做了一条 ${crafted}`);
      const p = adapter.state().pos;
      const at = `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
      const walkLeft = args.to && !found ? Math.round(Math.hypot(args.to.x - p.x, args.to.z - p.z)) : 0;
      if (walkLeft > 3 && ashore) notes.push(`离目标还有 ${walkLeft} 格陆路`);
      const data = { moved, landed: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, kept, ...(found ? { found: found.what } : {}), ...(r.arrived ? { arrived: true } : {}), ...(crafted ? { crafted } : {}), ...(route ? { route: route.reach } : {}) };
      if (!r.ok && moved < 3) return fail(r.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', `坐上船但没划动：${r.reason}；${notes.join('，')}`, data);
      return ok(`坐船划了 ${moved} 格，${how}，在 ${at} ${ashore ? '上岸' : '下船'}；${notes.join('，')}`, data);
    } catch (e) {
      if (isAbort(e)) { await bailOut(ctx); throw e; }
      await bailOut(ctx); // 任何出错路径都不能把自己留在船上（坐船时物理模拟是关着的）
      return fail(codeFromError(e), `坐船出错：${(e as Error).message}`);
    }
  },
};

export const vehicleSkills: Skill[] = [boat];
