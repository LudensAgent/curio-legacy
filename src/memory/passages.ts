import type { Vec3Like } from '../adapter/types.ts';
import type { PassageRecord, WorldMemory } from './store.ts';

/** 一次观察：身体在哪、是在地表还是在地下（看【身体】where 的判断） */
export interface PassageSample {
  worldId: string;
  dim: string;
  pos: Vec3Like;
  /** surface：地表或屋里（头顶见天、能走）；underground：在地下；other：水里、坑里等，既不开始也不结束 */
  place: 'surface' | 'underground' | 'other';
}

export interface DugBlock { pos: Vec3Like; name: string; ts: number }

const flat = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.z - b.z);
const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** 自己挖掉至少这么多格，才算“我挖的通道”（走进天然洞穴不算） */
export const MIN_DUG = 4;
const STEP = 3;
const MAX_POINTS = 160;

/**
 * 跟着身体记通道：进了地下就开始一段，一路记脚下的点和自己挖掉的格子，回到地表就收尾。
 * 走进以前挖过的通道（离它的路线 3 格以内）就接着那一条记，算又用了一次。
 * 只看亲身走过、亲手挖过的；死了被传送、换了世界，就不把两头连起来。
 */
export class PassageTracker {
  private active: { rec: PassageRecord; existing: boolean } | null = null;
  private lastSurface: { pos: Vec3Like; dim: string; worldId: string; ts: number } | null = null;
  private lastPos: { pos: Vec3Like; dim: string; worldId: string } | null = null;
  /** 最近一次在地下的位置：回地表时用于记录地表参考点，未验证实际开口。 */
  private lastBelow: { pos: Vec3Like; ts: number } | null = null;
  /** 这次行程里自己挖掉的格子：回地表时用最近的挖开格当洞口，而不是站的位置 */
  private dugBlocks: DugBlock[] = [];

  constructor(private memory: Pick<WorldMemory, 'passages' | 'savePassage'> & Partial<Pick<WorldMemory, 'forgetPassage'>>, private newId: () => string = () => `psg_${Math.random().toString(36).slice(2, 8)}`) {}

  observe(s: PassageSample, dug: DugBlock[], now = Date.now()) {
    const pos = cell(s.pos);
    // 瞬移（死了重生、传送、换维度）：前后两段不能连成一条
    const jumped = !this.lastPos || this.lastPos.dim !== s.dim || this.lastPos.worldId !== s.worldId || d3(this.lastPos.pos, pos) > 24;
    this.lastPos = { pos, dim: s.dim, worldId: s.worldId };
    if (jumped) { this.finish(); this.lastSurface = null; }
    for (const b of dug) { this.dugBlocks.push(b); if (this.dugBlocks.length > 160) this.dugBlocks.shift(); }

    if (s.place === 'surface') {
      // 记录从地下回到地表的位置；这只是参考点，不保证是实际开口。
      const below = this.lastBelow;
      if (this.active && below && now - below.ts < 120_000 && flat(below.pos, pos) <= 16 && pos.y >= below.pos.y) {
        this.addEntrance(this.active.rec, this.openingNear(pos, this.active.rec));
        this.save();
      }
      this.finish();
      this.lastBelow = null;
      this.lastSurface = { pos, dim: s.dim, worldId: s.worldId, ts: now };
      return;
    }
    // 在自己挖的竖井、台阶里往上爬时，身体常常判断成“坑里”（四周比脚下高、头顶开着或是自己垫的方块），
    // 以前这种时候既不开始也不记点，挖上来的通道就漏了。手上正在这儿挖、而且比地表低，就当在地下记
    const digging = dug.some((b) => d3(cell(b.pos), pos) <= 6);
    const belowSurface = !this.lastSurface || pos.y <= this.lastSurface.pos.y - 2;
    const inShaft = s.place === 'other' && digging && (!!this.active || belowSurface);
    if (s.place !== 'underground' && !inShaft) {
      // 坑里、水里：不开始也不结束，但手上挖的照样算在这一段里
      if (this.active) this.count(this.active.rec, pos, dug);
      return;
    }
    this.lastBelow = { pos, ts: now };

    if (!this.active) {
      const old = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && p.path.some((q) => d3(q, pos) <= 3));
      if (old) {
        old.uses += 1;
        old.lastUsedAt = now;
        this.active = { rec: old, existing: true };
      } else {
        this.active = { existing: false, rec: { id: this.newId(), worldId: s.worldId, dim: s.dim, kind: 'walked', entrances: [], path: [pos], deepestY: pos.y, dug: 0, ores: {}, createdAt: now, lastUsedAt: now, uses: 1 } };
      }
      // 刚从地表下来：记录最后的地表位置，并未确认实际开口。
      const surf = this.lastSurface;
      if (surf && surf.dim === s.dim && surf.worldId === s.worldId && now - surf.ts < 120_000 && flat(surf.pos, pos) <= 16) this.addEntrance(this.active.rec, this.openingNear(surf.pos, this.active.rec));
    }
    // 新挖的这一段接近以前的路线：并进那一条（多一个地表参考点），不另记
    if (!this.active.existing) {
      const joined = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && p.id !== this.active!.rec.id && p.path.some((q) => d3(q, pos) <= 3));
      if (joined) {
        const fresh = this.active.rec;
        for (const e of fresh.entrances) this.addEntrance(joined, e);
        for (const q of fresh.path) if (!joined.path.some((o) => d3(o, q) < STEP)) joined.path.push(q);
        joined.dug += fresh.dug;
        for (const [n, c] of Object.entries(fresh.ores)) joined.ores[n] = (joined.ores[n] ?? 0) + c;
        joined.deepestY = Math.min(joined.deepestY, fresh.deepestY);
        joined.uses += 1;
        this.memory.forgetPassage?.(fresh.id);
        this.active = { rec: joined, existing: true };
      }
    }
    const rec = this.active.rec;
    const last = rec.path[rec.path.length - 1];
    if (!last || d3(last, pos) >= STEP) {
      // 走回已经记过的那段路上，不重复记点
      if (!rec.path.some((q) => d3(q, pos) < STEP)) rec.path.push(pos);
      if (rec.path.length > MAX_POINTS) rec.path = rec.path.filter((_, i) => i === 0 || i % 2 === 1 || i === rec.path.length - 1);
    }
    rec.deepestY = Math.min(rec.deepestY, pos.y);
    rec.lastUsedAt = now;
    this.count(rec, pos, dug);
    this.save();
  }

  /** 回到地表、瞬移或者关掉时收尾 */
  finish() {
    if (this.active) this.save();
    this.active = null;
    this.dugBlocks = [];
  }

  /** 最近的挖开格（洞口）：回地表时优先记自己挖开的那一格，而不是站的位置；只找贴近地表那层的挖开格。
   * 复用旧通道时当次的挖开格里可能没有原始洞口，就退回这条通道自己记下、离地表最近的脚点（那才是真实洞口），最后才退回站的位置 */
  private openingNear(ref: Vec3Like, rec?: PassageRecord): Vec3Like {
    let best: Vec3Like | null = null, bd = Infinity;
    for (const b of this.dugBlocks) {
      if (Math.abs(b.pos.y - ref.y) > 4) continue;
      const d = flat(b.pos, ref);
      if (d <= 16 && (d < bd || (d === bd && (best === null || b.pos.y > best.y)))) { bd = d; best = b.pos; }
    }
    if (best) return best;
    if (rec?.path.length) {
      let top: Vec3Like | null = null;
      for (const p of rec.path) {
        if (Math.abs(p.y - ref.y) > 4) continue;
        const d = flat(p, ref);
        if (d > 16) continue;
        if (!top || p.y > top.y || (p.y === top.y && d < flat(top, ref))) top = p;
      }
      if (top) return top;
    }
    return ref;
  }

  private count(rec: PassageRecord, pos: Vec3Like, dug: DugBlock[]) {
    for (const b of dug) {
      if (d3(cell(b.pos), pos) > 6) continue;
      rec.dug += 1;
      if (/_ore$|^ancient_debris$/.test(b.name)) rec.ores[b.name] = (rec.ores[b.name] ?? 0) + 1;
    }
  }

  private addEntrance(rec: PassageRecord, p: Vec3Like) {
    if (rec.entrances.some((e) => d3(e, p) <= 4)) return;
    rec.entrances.push(p);
    if (rec.entrances.length > 3) rec.entrances.shift();
  }

  /** 走进去的天然洞穴也记（用于原路返回）；挖够了就升级成"我挖的通道"；接着以前那条走的随时存 */
  private save() {
    const a = this.active;
    if (!a) return;
    a.rec.kind = a.rec.dug >= MIN_DUG ? 'dug' : 'walked';
    if (a.existing || a.rec.dug >= MIN_DUG || a.rec.path.length >= 3) this.memory.savePassage(a.rec);
  }
}

/** 一条通道里横着推过的层：同一高度（±1）记了至少 4 个点的 */
export function passageLevels(rec: Pick<PassageRecord, 'path'>): number[] {
  const byY = new Map<number, number>();
  for (const p of rec.path) byY.set(p.y, (byY.get(p.y) ?? 0) + 1);
  const levels: number[] = [];
  for (const [y] of [...byY].sort((a, b) => a[0] - b[0])) {
    const n = (byY.get(y - 1) ?? 0) + (byY.get(y) ?? 0) + (byY.get(y + 1) ?? 0);
    if (n >= 4 && !levels.some((l) => Math.abs(l - y) <= 2)) levels.push(y);
  }
  return levels;
}

/**
 * 沿自己挖过、走过的通道找一条路：把各条通道记下的脚下点连成网（同一条里前后相邻的点、不同条里挨得很近的点），
 * 返回从离自己最近的点到离目标最近的点的几何连接；未验证点间通行或当前地形，不能作为自动导航路线。
 * 两头离通道太远、或者连不上，就返回 null。
 */
export function passageRoute(recs: Pick<PassageRecord, 'path'>[], from: Vec3Like, to: Vec3Like,
  opts: { near?: number; hop?: number; link?: number } = {}): Vec3Like[] | null {
  const near = opts.near ?? 5, hop = opts.hop ?? 7, link = opts.link ?? 3.5;
  const nodes: Vec3Like[] = [];
  const edges = new Map<number, Set<number>>();
  const add = (a: number, b: number) => { if (a === b) return; (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b); (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a); };
  const indexOf = (p: Vec3Like) => {
    const i = nodes.findIndex((q) => q.x === p.x && q.y === p.y && q.z === p.z);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  for (const r of recs) {
    let prev = -1;
    for (const p of r.path) {
      const i = indexOf(p);
      if (prev >= 0 && d3(nodes[prev], p) <= hop) add(prev, i);
      prev = i;
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (d3(nodes[i], nodes[j]) <= link) add(i, j);
  const closest = (p: Vec3Like) => {
    let best = -1, bd = Infinity;
    nodes.forEach((q, i) => { const d = d3(q, p); if (d < bd) { bd = d; best = i; } });
    return bd <= near ? best : -1;
  };
  const a = closest(from), b = closest(to);
  if (a < 0 || b < 0) return null;
  if (a === b) return [nodes[a]];
  // 最短路（点不多，朴素 Dijkstra 就够）
  const dist = new Array<number>(nodes.length).fill(Infinity), prevOf = new Array<number>(nodes.length).fill(-1), done = new Set<number>();
  dist[a] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === b) break;
    done.add(u);
    for (const v of edges.get(u) ?? []) {
      const nd = dist[u] + d3(nodes[u], nodes[v]);
      if (nd < dist[v]) { dist[v] = nd; prevOf[v] = u; }
    }
  }
  if (dist[b] === Infinity) return null;
  const route: Vec3Like[] = [];
  for (let v = b; v >= 0; v = prevOf[v]) route.unshift(nodes[v]);
  return route;
}
