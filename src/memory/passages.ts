import type { Vec3Like } from '../adapter/types.ts';
import type { PassageRecord, WorldMemory } from './store.ts';
import { isSoftBlock, LIQUID_BLOCKS } from '../perception/surroundings.ts';

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
/** 两个脚点是否 Chebyshev 相邻（单步/斜步/上下一格）；link 只记这种亲自走过的单步边，不把冲刺跨格或绕墙的位移误当直边 */
const adjacent = (a: Vec3Like, b: Vec3Like) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= 1 && d3(a, b) > 0;

/** 自己挖掉至少这么多格，才算“我挖的通道”（走进天然洞穴不算） */
export const MIN_DUG = 4;
const STEP = 3;
/** 两条通道脚点挨到多近算「同一条」；和 passageRoute 跨通道连网的 link 保持一致 */
export const PASSAGE_LINK = 3.5;
const MAX_POINTS = 160;

/** 这一下站的位置、或刚挖开的格子，落在另一条通道脚点附近（亲身的证据，不是臆造）。
 * 脚点既看稀疏的 path、也看亲手一步步走过的 links 端点：path 每隔几格才记一个，大矿道里大片走过的地方没有 path 点，
 * 只看 path 会把重进同一段矿道误判成新矿道、越记越碎。 */
const touchesPassage = (rec: Pick<PassageRecord, 'path' | 'links'>, pos: Vec3Like, dug: DugBlock[]) => {
  const near = (p: Vec3Like) =>
    rec.path.some((q) => d3(q, p) <= PASSAGE_LINK) ||
    (rec.links ?? []).some((l) => d3(l.a, p) <= PASSAGE_LINK || d3(l.b, p) <= PASSAGE_LINK);
  return near(pos) || dug.some((b) => near(cell(b.pos)));
};

/** 通道里离 pos 最近、且在 PASSAGE_LINK 内的脚点（path 或 links 端点）；并进/重进旧道时用它补一条连接边。
 *  阈值必须和 touchesPassage 一致（3.5 格）：以前用 adjacent（1 格）过严，并进了旧道（3.5 格内）却补不上边（要 1 格内），
 *  于是同一条 record 里碎成几百个互不相连的岛。 */
const bridgeNode = (rec: Pick<PassageRecord, 'path' | 'links'>, pos: Vec3Like): Vec3Like | null => {
  let best: Vec3Like | null = null, bd = PASSAGE_LINK;
  for (const q of rec.path) { const d = d3(q, pos); if (d > 0 && d <= bd) { bd = d; best = q; } }
  for (const l of rec.links ?? []) {
    for (const p of [l.a, l.b]) { const d = d3(p, pos); if (d > 0 && d <= bd) { bd = d; best = p; } }
  }
  return best;
};

/**
 * 跟着身体记通道：进了地下就开始一段，一路记脚下的点和自己挖掉的格子，回到地表就收尾。
 * 走进以前挖过的通道（站的位置或刚挖开的格子，挨到它脚点 3.5 格内）就接着那一条记，算又用了一次。
 * 只看亲身走过、亲手挖过的；死了被传送、换了世界，就不把两头连起来。
 */
export class PassageTracker {
  private active: { rec: PassageRecord; existing: boolean } | null = null;
  private lastSurface: { pos: Vec3Like; dim: string; worldId: string; ts: number } | null = null;
  private lastPos: { pos: Vec3Like; dim: string; worldId: string } | null = null;
  /** 最近一次在地下的位置：回地表时用于记录地表参考点，未验证实际开口。 */
  private lastBelow: { pos: Vec3Like; ts: number } | null = null;
  /** 最近一次在通道里的脚点：用来记「亲自走过的相邻格对」（links） */
  private lastPassage: { pos: Vec3Like; dim: string; worldId: string } | null = null;
  /** 这次行程里自己挖掉的格子：回地表时用最近的挖开格当洞口，而不是站的位置 */
  private dugBlocks: DugBlock[] = [];
  /** 并进/重进旧道时脚下还没挨到旧脚点：接下来几步里一旦挨到就补一条连接边，让 links 连成一体（不是两团互不相连的岛） */
  private pendingBridge: { dim: string; worldId: string; steps: number } | null = null;

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
      const old = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && touchesPassage(p, pos, dug));
      if (old) {
        old.uses += 1;
        old.lastUsedAt = now;
        this.active = { rec: old, existing: true };
        this.beginBridge(old, pos, s.dim, s.worldId);
      } else {
        this.active = { existing: false, rec: { id: this.newId(), worldId: s.worldId, dim: s.dim, kind: 'walked', entrances: [], path: [pos], deepestY: pos.y, dug: 0, ores: {}, createdAt: now, lastUsedAt: now, uses: 1 } };
      }
      // 刚从地表下来：记录最后的地表位置，并未确认实际开口。
      const surf = this.lastSurface;
      if (surf && surf.dim === s.dim && surf.worldId === s.worldId && now - surf.ts < 120_000 && flat(surf.pos, pos) <= 16) this.addEntrance(this.active.rec, this.openingNear(surf.pos, this.active.rec));
    }
    // 接进了另一条已经记下的通道：两条其实是同一条，并成一条（多一个地表参考点），不另记。
    // observe 记的是脚下真实站过的点，能从一条走到另一条的 3 格内，就证明这一段连通，不是臆造。
    const neighbor = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && p.id !== this.active!.rec.id && touchesPassage(p, pos, dug));
    if (neighbor) {
      const keep = neighbor.uses > this.active!.rec.uses || (neighbor.uses === this.active!.rec.uses && neighbor.path.length > this.active!.rec.path.length) ? neighbor : this.active!.rec;
      this.mergeInto(keep, keep === neighbor ? this.active!.rec : neighbor);
      this.active = { rec: keep, existing: true };
      this.beginBridge(keep, pos, s.dim, s.worldId);
    }
    const rec = this.active.rec;
    // 记「亲自走过的相邻格对」：和上一次通道脚点 Chebyshev 相邻且无瞬移，就是一条真实可走的边
    if (this.lastPassage && this.lastPassage.dim === s.dim && this.lastPassage.worldId === s.worldId && adjacent(this.lastPassage.pos, pos)) {
      this.addLink(rec, this.lastPassage.pos, pos);
    }
    this.lastPassage = { pos, dim: s.dim, worldId: s.worldId };
    // 上一步并进/重进旧道、脚下还没挨到旧脚点：现在挨到了就补连接边，让 links 连成一体；几步还没挨到就放弃
    if (this.pendingBridge && this.pendingBridge.dim === s.dim && this.pendingBridge.worldId === s.worldId) {
      const bridge = bridgeNode(rec, pos);
      if (bridge) { this.addLink(rec, bridge, pos); this.pendingBridge = null; }
      else if (--this.pendingBridge.steps <= 0) this.pendingBridge = null;
    }
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
    this.lastPassage = null;
    this.pendingBridge = null;
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

  /** 把 drop 并进 keep：合并脚点、入口、挖格、矿、最深处和次数，drop 不再单列 */
  private mergeInto(keep: PassageRecord, drop: PassageRecord) {
    // 两条都有 links 时，取两串链接链之间最近的一对脚点：单步相邻（Chebyshev ≤1）就补一条边。
    // 不补，并成一条 record 后两串仍是互不相连的岛，passageRoute 会卡在只差一格的缺口上；隔得更远可能是两条真支道，不硬连。
    // 只有一边有 links 时没有链端点可补，沿用既有机制（无 links 一侧的 path 点不参与 links 图），这里不改变。
    const endpoints = (r: PassageRecord) => (r.links ?? []).flatMap((l) => [l.a, l.b]);
    let bridge: [Vec3Like, Vec3Like] | null = null, bd = Infinity;
    for (const a of endpoints(keep)) for (const b of endpoints(drop)) {
      const d = d3(a, b);
      if (d < bd) { bd = d; bridge = [a, b]; }
    }
    for (const e of drop.entrances) this.addEntrance(keep, e);
    for (const q of drop.path) if (!keep.path.some((o) => d3(o, q) < STEP)) keep.path.push(q);
    for (const l of drop.links ?? []) this.addLink(keep, l.a, l.b);
    if (bridge && adjacent(bridge[0], bridge[1])) this.addLink(keep, bridge[0], bridge[1]);
    keep.dug += drop.dug;
    for (const [n, c] of Object.entries(drop.ores)) keep.ores[n] = (keep.ores[n] ?? 0) + c;
    keep.deepestY = Math.min(keep.deepestY, drop.deepestY);
    keep.uses += 1;
    this.memory.forgetPassage?.(drop.id);
  }

  /** 记一条亲自走过的相邻格对（无向、去重）。反复走同一条走廊不会新增，links 只随真正走过的新格子增长，天然有界。 */
  private addLink(rec: PassageRecord, a: Vec3Like, b: Vec3Like) {
    const links = (rec.links ??= []);
    const same = (u: Vec3Like, v: Vec3Like) => u.x === v.x && u.y === v.y && u.z === v.z;
    if (links.some((l) => (same(l.a, a) && same(l.b, b)) || (same(l.a, b) && same(l.b, a)))) return;
    links.push({ a, b });
  }

  /** 并进/重进旧道时，把当下脚点和旧道里相邻的脚点连起来：不补这条边，合并后的 links 就是两团互不相连的岛，passageRoute 走不通 */
  private beginBridge(rec: PassageRecord, pos: Vec3Like, dim: string, worldId: string) {
    const n = bridgeNode(rec, pos);
    if (n) { this.addLink(rec, n, pos); this.pendingBridge = null; }
    else this.pendingBridge = { dim, worldId, steps: 8 };
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
 * 沿自己挖过、走过的通道找一条路：优先沿亲自走过的相邻格对（links，真实可走的边）连成网；
 * 旧数据没有 links 时退回「同一条里前后相邻的脚点」的推断；不同条之间仍按几何距离做碎片自愈（挨得很近就当接得上）。
 * 返回从离自己最近的点到离目标最近的点的连接；未验证点间通行或当前地形，不能作为自动导航路线。
 * 两头离通道太远、或者连不上，就返回 null。
 */
/** 通道脚点 + 真实边走成的无向图：节点是脚点（path 或 links 端点），边是 links（或旧数据的时间相邻脚点）+ 跨 record 的碎片自愈 + 同 record 的 1 格缺口自愈。 */
export function passageGraph(recs: Pick<PassageRecord, 'path' | 'links'>[], opts: { hop?: number; link?: number } = {}): { nodes: Vec3Like[]; owner: number[]; edges: Map<number, Set<number>> } {
  const hop = opts.hop ?? 7, link = opts.link ?? PASSAGE_LINK;
  const nodes: Vec3Like[] = [];
  const owner: number[] = [];
  const edges = new Map<number, Set<number>>();
  const add = (a: number, b: number) => { if (a === b) return; (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b); (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a); };
  const indexOf = (p: Vec3Like, recIdx: number) => {
    const i = nodes.findIndex((q) => q.x === p.x && q.y === p.y && q.z === p.z);
    if (i >= 0) return i;
    nodes.push(p);
    owner.push(recIdx);
    return nodes.length - 1;
  };
  recs.forEach((r, recIdx) => {
    if (r.links?.length) {
      // 有真实边：只沿亲自走过的相邻格对连，不按几何距离抄近道（那会穿墙/穿落差）；只差一步的相邻缺口在后面统一补
      for (const { a, b } of r.links) add(indexOf(a, recIdx), indexOf(b, recIdx));
    } else {
      // 旧数据没有 links：退回时间相邻脚点的推断（原行为）
      let prev = -1;
      for (const p of r.path) {
        const i = indexOf(p, recIdx);
        if (prev >= 0 && d3(nodes[prev], p) <= hop) add(prev, i);
        prev = i;
      }
    }
  });
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    // 跨 record：挨得近的点连起来（碎片自愈）。
    if (owner[i] !== owner[j]) { if (d3(nodes[i], nodes[j]) <= link) add(i, j); continue; }
    // 同一条 record：只补「两个已记录脚点水平正交相邻（|Δy|≤1）」这一个缺口——它们本来就是一步之遥的落脚点，
    // 旧数据里漏记这一步会把一条道断成两团。不按 ≤link 的几何距离硬连，也不补 2 格以上的缺口或斜角缺口。
    const a = nodes[i], b = nodes[j];
    if (Math.abs(a.y - b.y) <= 1 && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1) add(i, j);
  }
  return { nodes, owner, edges };
}

/** 通道网的碎片化：所有脚点按真实边连起来，数有几个连通分量（碎片）；>1 说明有互不相连的旧矿道岛。 */
export function passageFragmentation(recs: Pick<PassageRecord, 'path' | 'links'>[]): { records: number; points: number; components: number; pieces: { points: number; records: number }[] } {
  const { nodes, owner, edges } = passageGraph(recs);
  const comp = new Array<number>(nodes.length).fill(-1);
  const pieces: { points: number; records: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] >= 0) continue;
    const id = pieces.length;
    let points = 0;
    const recs = new Set<number>();
    const q = [i];
    comp[i] = id;
    while (q.length) {
      const u = q.pop()!;
      points++;
      recs.add(owner[u]);
      for (const v of edges.get(u) ?? []) if (comp[v] < 0) { comp[v] = id; q.push(v); }
    }
    pieces.push({ points, records: recs.size });
  }
  pieces.sort((a, b) => b.points - a.points);
  return { records: recs.length, points: nodes.length, components: pieces.length, pieces };
}

export function passageRoute(recs: Pick<PassageRecord, 'path' | 'links'>[], from: Vec3Like, to: Vec3Like,
  opts: { near?: number; hop?: number; link?: number } = {}): Vec3Like[] | null {
  const near = opts.near ?? 5, hop = opts.hop ?? 7, link = opts.link ?? PASSAGE_LINK;
  const { nodes, edges } = passageGraph(recs, { hop, link });
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

/**
 * 想回地面时，从**从 here 连得上的通道分量**里挑地表锚点：
 * 先要够得着，再取最高（最接近地表）的入口；没有有效入口就取该分量最高的脚点。
 * 不能只按水平距离取最近的入口——归档里的旧入口可能在脚下方几十格，
 * 选中它会让 follow_passage 在“深处入口”报到达，然后另一个动作再挖上去。
 */
export function passageSurfaceAnchor(recs: Pick<PassageRecord, 'path' | 'entrances' | 'links'>[], here: Vec3Like): Vec3Like | null {
  const { nodes, owner, edges } = passageGraph(recs);
  let start = -1, bd = 6;
  nodes.forEach((q, i) => { const d = flat(q, here); if (d < bd) { bd = d; start = i; } });
  let pool = recs;
  if (start >= 0) {
    const owners = new Set<number>();
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const u = stack.pop()!;
      owners.add(owner[u]!);
      for (const v of edges.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
    const reachable = recs.filter((_, i) => owners.has(i));
    if (reachable.length) pool = reachable;
  }
  const anchors: Vec3Like[] = [];
  for (const r of pool) {
    const surfaceY = r.path.length ? Math.max(...r.path.map((p) => p.y)) : Math.max(...r.entrances.map((e) => e.y));
    for (const e of r.entrances) if (surfaceY - e.y <= 6) anchors.push(e);
  }
  if (anchors.length) return [...anchors].sort((a, b) => b.y - a.y || flat(a, here) - flat(b, here))[0] ?? null;
  // 没有入口记录时退回该分量最高的脚点；同高保持记录顺序，不按水平距离改变旧目标。
  return [...pool.flatMap((r) => r.path)].sort((a, b) => b.y - a.y)[0] ?? null;
}

/** 洞口正下方、离它最近的一个下降脚点：洞口还空着时，用它往里一步验证通道地板是否还在（被炸成坑时地板会一起没了）。
 *  取 path 里不高于洞口、水平 4 格内最高的脚点（优先最高，同高取最近的）；没有就返回 null。 */
export function passageEntranceDescent(rec: Pick<PassageRecord, 'path'>, entrance: Vec3Like): Vec3Like | null {
  const below = rec.path.filter((p) => p.y <= entrance.y && !(p.x === entrance.x && p.y === entrance.y && p.z === entrance.z) && Math.hypot(p.x - entrance.x, p.z - entrance.z) <= 4);
  if (!below.length) return null;
  return below.reduce((a, b) => b.y > a.y || (b.y === a.y && Math.hypot(b.x - entrance.x, b.z - entrance.z) < Math.hypot(a.x - entrance.x, a.z - entrance.z)) ? b : a);
}

/** 想下更深时，取「从 here 能连到的脚点里最深」的脚点当目标；here 没给（或离网太远）时退回全网最深。
 * 碎片化时全网最深可能在另一团互不相连的岛里，直接当目标会 route 不通；这里按连通分量挑，只给够得着的。 */
export function passageDeepestAnchor(recs: Pick<PassageRecord, 'path' | 'links'>[], here?: Vec3Like, opts: { near?: number } = {}): Vec3Like | null {
  const all = recs.flatMap((r) => r.path);
  if (!all.length) return null;
  const globalDeepest = () => [...all].sort((a, b) => a.y - b.y)[0]!;
  if (!here) return globalDeepest();
  const { nodes, edges } = passageGraph(recs);
  const near = opts.near ?? 6;
  let start = -1, bd = near;
  nodes.forEach((q, i) => { const d = d3(q, here); if (d < bd) { bd = d; start = i; } });
  if (start < 0) return globalDeepest();
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of edges.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  let best: Vec3Like | null = null;
  for (let i = 0; i < nodes.length; i++) if (seen.has(i) && (!best || nodes[i].y < best.y)) best = nodes[i];
  return best ?? globalDeepest();
}

/** 沿全部记下的通道连成的网，取朝 to 走的下一个路点（几何记忆，未验证当前地形）；连不上返回 null。
 * 以前回入口/下更深只对单条通道路由，碎片一多就接不回地表；这里把全部通道一起连网。 */
export function passageNext(recs: Pick<PassageRecord, 'path' | 'kind'>[], here: Vec3Like, to: Vec3Like): { next: Vec3Like; inside: boolean; kind: 'dug' | 'walked' | 'bridge' } | null {
  const route = passageRoute(recs, here, to, { near: 6 });
  if (!route || route.length < 2) return null;
  const inside = recs.some((r) => r.path.some((q) => d3(q, here) <= 3));
  const nearest = recs.map((r) => ({ r, d: Math.min(...r.path.map((q) => d3(q, here))) })).sort((a, b) => a.d - b.d)[0]?.r;
  return { next: route[1], inside, kind: nearest?.kind === 'bridge' ? 'bridge' : nearest?.kind === 'dug' ? 'dug' : 'walked' };
}

/** 全部记下的通道里离 pos 最近的一个脚点：离矿道网太远时，先走到它把 agent 接回网里；没有脚点返回 null */
export function passageNearestNode(recs: Pick<PassageRecord, 'path'>[], pos: Vec3Like): Vec3Like | null {
  let best: Vec3Like | null = null;
  let bestD = Infinity;
  for (const r of recs) for (const p of r.path) {
    const d = d3(p, pos);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ------------------------------------------------------------------ 自己搭的桥/路

/** 连续自放方块至少这么多块，才算一条「我搭的桥/路」（再短的多半是垫高、门框这类散块） */
export const MIN_BRIDGE = 5;
/** 短轴超过这个宽度就不算「一条路」而算成片的平台/地板，不纳入（避免把房子地面、满铺平台误判成桥） */
export const MAX_BRIDGE_WIDTH = 3;

/** 桥面脚点（人站上去那格）沿主轴排成端点→端点；主轴取水平跨度更大的那根轴。 */
export function orderBridgeFoot(foot: Vec3Like[]): Vec3Like[] {
  if (foot.length < 2) return foot;
  const xs = foot.map((f) => f.x), zs = foot.map((f) => f.z);
  const longAxis = (Math.max(...xs) - Math.min(...xs)) >= (Math.max(...zs) - Math.min(...zs)) ? 'x' : 'z';
  const key = (f: Vec3Like) => longAxis === 'x' ? f.x - f.z - f.y : f.z - f.x - f.y;
  return [...foot].sort((a, b) => key(a) - key(b));
}

/**
 * 从自己放下的方块里找出「长条、不成片」的连续段（桥/路）：只算实心桥料（火把、梯子、草、水不算），
 * 水平相邻（Chebyshev x/z ≤1、|Δy|≤1）连成一段，再要求主轴跨度 ≥ minLen、短轴 ≤ maxWidth。
 * 返回每条桥的有序脚点（人站上去那格）和主材料名。
 */
export function bridgeRuns(placed: { pos: Vec3Like; name: string }[], minLen = MIN_BRIDGE, maxWidth = MAX_BRIDGE_WIDTH): { path: Vec3Like[]; material: string }[] {
  const cells = new Map<string, Vec3Like>();
  const names = new Map<string, string>();
  for (const { pos, name } of placed) {
    if (LIQUID_BLOCKS.has(name) || isSoftBlock(name)) continue;
    const b = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const k = `${b.x},${b.y},${b.z}`;
    if (!cells.has(k)) { cells.set(k, b); names.set(k, name); }
  }
  const seen = new Set<string>();
  const runs: { path: Vec3Like[]; material: string }[] = [];
  for (const key of cells.keys()) {
    if (seen.has(key)) continue;
    const comp = new Set<string>();
    const q = [key];
    seen.add(key);
    while (q.length) {
      const k = q.pop()!;
      comp.add(k);
      const [x, y, z] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const nk = `${x + dx},${y + dy},${z + dz}`;
          if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); q.push(nk); }
        }
      }
    }
    if (comp.size < minLen) continue;
    const blocks = [...comp].map((k) => cells.get(k)!);
    const xs = blocks.map((b) => b.x), zs = blocks.map((b) => b.z);
    const xSpan = Math.max(...xs) - Math.min(...xs), zSpan = Math.max(...zs) - Math.min(...zs);
    const longSpan = Math.max(xSpan, zSpan), shortSpan = Math.min(xSpan, zSpan);
    if (longSpan + 1 < minLen || shortSpan + 1 > maxWidth) continue;
    const tally = new Map<string, number>();
    for (const k of comp) { const n = names.get(k)!; tally.set(n, (tally.get(n) ?? 0) + 1); }
    const material = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    const path = orderBridgeFoot(blocks.map((b) => ({ x: b.x, y: b.y + 1, z: b.z })));
    runs.push({ path, material });
  }
  return runs;
}
