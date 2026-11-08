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
/** 两条记录并成一条时补桥用：Chebyshev ≤1 才算单步相邻。
 *  记录走过的边用 observedStep（允许观测间隔漏掉中间步），两者口径不同，不要混用。 */
const adjacent = (a: Vec3Like, b: Vec3Like) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= 1 && d3(a, b) > 0;

/** 两次观测之间身体真实发生过的位移，算一条“走过的边”：
 *  同层最多 10 格（正常步行/被击退时观测会漏掉中间步），或 3.5 格内带 ≤2 格高差。
 *  这不是几何抄近道——两端都是同一段行程里亲脚到过的点；更远的瞬移已在 observe 里按 >24 格换段。 */
const observedStep = (a: Vec3Like, b: Vec3Like) => {
  const d = d3(a, b), dy = Math.abs(a.y - b.y);
  if (d <= 0) return false;
  return (d <= PASSAGE_LINK && dy <= 2) || (d <= 10 && dy <= 1);
};

/** 旧记录没有 run 标记：建图补漏时不假设它们属于同一段连续行程，只补更保守的小缺口。 */
const legacyStep = (a: Vec3Like, b: Vec3Like) => {
  const d = d3(a, b), dy = Math.abs(a.y - b.y);
  return d > 0 && ((d <= PASSAGE_LINK && dy <= 2) || (d <= 6 && dy <= 1));
};

/** 自己挖掉至少这么多格，才算“我挖的通道”（走进天然洞穴不算） */
export const MIN_DUG = 4;
const STEP = 3;
/** 两条通道脚点挨到多近算「同一条」；和 passageRoute 跨通道连网的 link 保持一致 */
export const PASSAGE_LINK = 3.5;
const MAX_POINTS = 160;

/** 同一份 records 在一次动作里会被 passageRoute / passageSurfaceCandidates / 调用方反复建图。
 *  图只由 path/links 的数量决定（uses、lastUsedAt 等字段不影响拓扑），用计数做失效信号；
 *  动作内的数组引用作为缓存键，动作结束后数组被回收，图随之释放。 */
const graphCache = new WeakMap<object, {
  hop: number; link: number; heal: boolean; points: number; links: number; cuts: number; reverses: number;
  graph: { nodes: Vec3Like[]; owner: number[]; edges: Map<number, Set<number>>; blocked: Map<number, Set<number>> };
}>();

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
  /** 当前这段连续观测的编号：只有同一段里相邻的 link 才允许在建图时补漏采的小缺口 */
  private run = 0;

  constructor(private memory: Pick<WorldMemory, 'passages' | 'archivedPassages' | 'savePassage'> & Partial<Pick<WorldMemory, 'forgetPassage'>>, private newId: () => string = () => `psg_${Math.random().toString(36).slice(2, 8)}`) {}

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
      // 坑里、水里：不开始也不结束，但手上挖的照样算在这一段里。
      // 这段位移没有被当作通道观测，回来时不能用旧的 lastPassage 直连，否则会把中间没看过的一段接成假边。
      if (this.active) this.count(this.active.rec, pos, dug);
      this.lastPassage = null;
      return;
    }
    this.lastBelow = { pos, ts: now };

    if (!this.active) {
      this.run++;
      // 先找 live；没有再找归档。归档记录被重进时也要接着它记，并在下次 savePassage 时升回 live，
      // 否则每次走进旧矿道都会另起一条新记录，归档原记录永远回不到工作集。
      // 归档里常有同一段的重复/桥记录；命中多条时取最完整的一条（links/脚点多），别随便认一条 stub。
      const old = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && touchesPassage(p, pos, dug))
        ?? this.memory.archivedPassages(s.dim)
          .filter((p) => p.worldId === s.worldId && touchesPassage(p, pos, dug))
          .sort((a, b) => (b.links?.length ?? 0) - (a.links?.length ?? 0) || b.path.length - a.path.length || b.uses - a.uses)[0];
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
      this.run++;
    }
    const rec = this.active.rec;
    // 记「亲自走过的边」：上一次观测到这里没有瞬移，且位移在合理的观测间隔内。
    // 只记严格相邻单步会把正常步行/下落时漏采的中间步全丢掉，一条走过的路会在图里断成几十团。
    if (this.lastPassage && this.lastPassage.dim === s.dim && this.lastPassage.worldId === s.worldId && observedStep(this.lastPassage.pos, pos)) {
      this.addLink(rec, this.lastPassage.pos, pos, { run: this.run });
    }
    this.lastPassage = { pos, dim: s.dim, worldId: s.worldId };
    // 上一步并进/重进旧道、脚下还没挨到旧脚点：现在挨到了就补连接边，让 links 连成一体；几步还没挨到就放弃
    if (this.pendingBridge && this.pendingBridge.dim === s.dim && this.pendingBridge.worldId === s.worldId) {
      const bridge = bridgeNode(rec, pos);
      if (bridge) { this.addLink(rec, bridge, pos, { cut: true }); this.pendingBridge = null; }
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
    const beforeLinks = keep.links?.length ?? 0;
    for (const l of drop.links ?? []) this.addLink(keep, l.a, l.b, { ...(l.cut ? { cut: true } : {}), ...(l.reverse ? { reverse: true } : {}) });
    // 拼接进来的第一条是新的连续段起点：建图不能把它和前一条当成一次连续观测。
    if ((keep.links?.length ?? 0) > beforeLinks && keep.links) keep.links[beforeLinks] = { ...keep.links[beforeLinks]!, cut: true };
    if (bridge && adjacent(bridge[0], bridge[1])) this.addLink(keep, bridge[0], bridge[1], { cut: true });
    keep.dug += drop.dug;
    for (const [n, c] of Object.entries(drop.ores)) keep.ores[n] = (keep.ores[n] ?? 0) + c;
    keep.deepestY = Math.min(keep.deepestY, drop.deepestY);
    keep.uses += 1;
    this.memory.forgetPassage?.(drop.id);
  }

  /** 记一条亲自走过的边（无向、去重）。run 标记同一段连续观测；合并/重进旧道补的桥用 cut 切断连续性。
   *  同一对格子后来反方向走过时标 reverse：第一次记录的顺序不再能证明“只能按这个方向走”。 */
  private addLink(rec: PassageRecord, a: Vec3Like, b: Vec3Like, mark: { run?: number; cut?: boolean; reverse?: boolean } = {}) {
    const links = (rec.links ??= []);
    const same = (u: Vec3Like, v: Vec3Like) => u.x === v.x && u.y === v.y && u.z === v.z;
    const existing = links.find((l) => (same(l.a, a) && same(l.b, b)) || (same(l.a, b) && same(l.b, a)));
    if (existing) {
      // 反向走过同一对格子、或并入的 link 本身带 reverse，都说明方向证据是双向的；合并时不能把它吞掉。
      if (!existing.reverse && same(existing.a, b) && same(existing.b, a)) existing.reverse = true;
      if (mark.reverse) existing.reverse = true;
      return;
    }
    links.push({ a, b, ...(mark.run !== undefined ? { run: mark.run } : {}), ...(mark.cut ? { cut: true } : {}), ...(mark.reverse ? { reverse: true } : {}) });
  }

  /** 并进/重进旧道时，把当下脚点和旧道里相邻的脚点连起来：不补这条边，合并后的 links 就是两团互不相连的岛，passageRoute 走不通 */
  private beginBridge(rec: PassageRecord, pos: Vec3Like, dim: string, worldId: string) {
    const n = bridgeNode(rec, pos);
    if (n) { this.addLink(rec, n, pos, { cut: true }); this.pendingBridge = null; }
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
/** 通道脚点 + 真实边走成的图：节点是脚点（path 或 links 端点），边是 links（或旧数据的时间相邻脚点）
 *  + 跨 record 的碎片自愈 + 同一段连续观测（run 相同）里漏采样的小缺口；merge/dedupe 的 cut 边界不跨。
 *  边仍按无向存储（碎片化/分量判断需要）；`blocked` 只标出「反向没有证据」的有向禁行：
 *  显式 link 是纯垂直下坠（同 x/z，a 高、b 低、差 ≥2）时，只证明 a→b，反向 climb 不可走；
 *  带水平位移的 dy≤-2 可能是跨了两级台阶，保持双向。 */
export function passageGraph(recs: Pick<PassageRecord, 'path' | 'links'>[], opts: { hop?: number; link?: number; heal?: boolean } = {}): { nodes: Vec3Like[]; owner: number[]; edges: Map<number, Set<number>>; blocked: Map<number, Set<number>> } {
  const hop = opts.hop ?? 7, link = opts.link ?? PASSAGE_LINK, heal = opts.heal ?? true;
  let points = 0, linkCount = 0, cuts = 0, reverses = 0;
  for (const r of recs) {
    points += r.path.length;
    linkCount += r.links?.length ?? 0;
    // 方向签名：同一条 record 的 links 数组可能在反复 observe 中原地补上 cut/reverse，计数变化必须让图失效。
    for (const l of r.links ?? []) { if (l.cut) cuts++; if (l.reverse) reverses++; }
  }
  const hit = graphCache.get(recs);
  if (hit && hit.hop === hop && hit.link === link && hit.heal === heal && hit.points === points && hit.links === linkCount
    && hit.cuts === cuts && hit.reverses === reverses) return hit.graph;

  const nodes: Vec3Like[] = [];
  const owner: number[] = [];
  const edges = new Map<number, Set<number>>();
  const blocked = new Map<number, Set<number>>();
  /** 同一对脚点上的方向证据：任一 link 能双向走（水平/向上爬/ cut / 反向走过）就覆盖单向落差。 */
  const oneWay = new Map<string, [number, number]>();
  const twoWay = new Set<string>();
  const pairKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
  const index = new Map<string, number>();
  const add = (a: number, b: number) => { if (a === b) return; (edges.get(a) ?? edges.set(a, new Set()).get(a)!).add(b); (edges.get(b) ?? edges.set(b, new Set()).get(b)!).add(a); };
  const indexOf = (p: Vec3Like, recIdx: number) => {
    const key = `${p.x},${p.y},${p.z}`;
    const i = index.get(key);
    if (i !== undefined) return i;
    const id = nodes.length;
    nodes.push(p);
    owner.push(recIdx);
    index.set(key, id);
    return id;
  };
  recs.forEach((r, recIdx) => {
    if (r.links?.length) {
      // 有真实边：只沿亲自走过的边连，不按几何距离抄近道（那会穿墙/穿落差）；只差一步的相邻缺口在后面统一补
      for (const l of r.links) {
        const u = indexOf(l.a, recIdx), v = indexOf(l.b, recIdx);
        add(u, v);
        if (u === v) continue;
        // 只有显式 link 有方向证据，而且只有「纯垂直」的下坠才判单向：两次观测之间带着水平位移的
        // dy≤-2 很可能是跨了两级 1 格台阶，不能当成不能爬的落差。向上爬、水平、cut、reverse 都保持双向。
        const key = pairKey(u, v);
        const vertical = l.a.x === l.b.x && l.a.z === l.b.z;
        if (l.cut || l.reverse || !vertical || l.a.y - l.b.y < 2) twoWay.add(key);
        else oneWay.set(key, [u, v]);
      }
      // 同一段连续观测（同一个 run）里相邻两条 link 之间漏采了中间步时补上，不然走过的一条道会断成多团。
      // merge/dedupe 拼进来的那条带 cut：数组相邻不代表连续行程，不能跨过去补。旧记录没有 run：
      // 只按更保守的 legacyStep 补，避免把历史上的拼接边界接成假边。
      for (let i = 0; i + 1 < r.links.length; i++) {
        const prev = r.links[i]!, next = r.links[i + 1]!;
        if (next.cut) continue;
        const from = prev.b, to = next.a;
        const sameRun = prev.run !== undefined && prev.run === next.run;
        if (sameRun ? observedStep(from, to) : legacyStep(from, to)) add(indexOf(from, recIdx), indexOf(to, recIdx));
      }
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
  // 跨 record 连网 + 同 record 正交缺口：按 link 大小分桶只查相邻桶，
  // 不再对全部节点做 O(N²) 两两比较（线上 9000 节点时约从 450ms 降到几十 ms）。
  const size = Math.max(link, 1);
  const grid = new Map<string, number[]>();
  const cellKey = (p: Vec3Like, ox: number, oy: number, oz: number) =>
    `${Math.floor(p.x / size) + ox},${Math.floor(p.y / size) + oy},${Math.floor(p.z / size) + oz}`;
  for (let i = 0; i < nodes.length; i++) {
    const key = cellKey(nodes[i]!, 0, 0, 0);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i); else grid.set(key, [i]);
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(cellKey(nodes[i]!, dx, dy, dz));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const a = nodes[i]!, b = nodes[j]!;
        // 跨 record：挨得近的点连起来（碎片自愈）。
        if (owner[i] !== owner[j]) { if (heal && d3(a, b) <= link) add(i, j); continue; }
        // 同一条 record：只补「两个已记录脚点水平正交相邻（|Δy|≤1）」这一个缺口——它们本来就是一步之遥的落脚点，
        // 旧数据里漏记这一步会把一条道断成两团。不按 ≤link 的几何距离硬连，也不补 2 格以上的缺口或斜角缺口。
        if (Math.abs(a.y - b.y) <= 1 && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1) add(i, j);
      }
    }
  }
  for (const [key, [u, v]] of oneWay) if (!twoWay.has(key)) (blocked.get(v) ?? blocked.set(v, new Set()).get(v)!).add(u);
  const graph = { nodes, owner, edges, blocked };
  graphCache.set(recs, { hop, link, heal, points, links: linkCount, cuts, reverses, graph });
  return graph;
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

/** 图上单源最短路（正权；二叉堆 + 惰性删除，几千节点下比每次线性扫最小值的 O(n²) 快一个量级）。
 *  edges 按无向拓扑存储；blocked 给出有向禁行（记录顺序只证明掉下去、没证明能爬回去）。
 *  stopAt 给定时算到它为止。 */
function graphShortest(nodes: Vec3Like[], edges: Map<number, Set<number>>, origin: number, stopAt = -1, blocked?: Map<number, Set<number>>): { dist: number[]; prev: number[] } {
  const n = nodes.length;
  const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Uint8Array(n);
  dist[origin] = 0;
  const ids: number[] = [origin], keys: number[] = [0];
  const push = (id: number, key: number) => {
    ids.push(id); keys.push(key);
    let i = ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!; keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id; keys[i] = key;
  };
  const pop = () => {
    const id = ids[0]!, key = keys[0]!;
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const len = ids.length;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let c = -1;
        if (l < len && keys[l]! < lastKey) c = l;
        if (r < len && keys[r]! < (c < 0 ? lastKey : keys[c]!)) c = r;
        if (c < 0) break;
        ids[i] = ids[c]!; keys[i] = keys[c]!;
        i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return { id, key };
  };
  while (ids.length) {
    const { id: u, key: du } = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === stopAt) break;
    const blockedFrom = blocked?.get(u);
    for (const v of edges.get(u) ?? []) {
      if (done[v] || blockedFrom?.has(v)) continue;
      const nd = du + d3(nodes[u]!, nodes[v]!);
      if (nd < dist[v]!) { dist[v] = nd; prev[v] = u; push(v, nd); }
    }
  }
  return { dist, prev };
}

export type PassageTransition = 'walk' | 'step' | 'drop' | 'climb';
export type PassageLegEvidence = 'linked' | 'adjacent' | 'legacy' | 'healed';

export interface PassageRouteLeg {
  from: Vec3Like;
  to: Vec3Like;
  points: Vec3Like[];
  transitions: PassageTransition[];
  recordId?: string;
  kind?: PassageRecord['kind'];
  deepestY?: number;
  reversible: boolean;
  evidence: PassageLegEvidence;
}

export interface PassageRouteInspection {
  status: 'route' | 'gap';
  waypoints: Vec3Like[];
  legs: PassageRouteLeg[];
  snapped: { from: Vec3Like; to: Vec3Like; fromDistance: number | null; toDistance: number | null };
  near: number;
  hop: number;
  heal: boolean;
  nearest?: Vec3Like;
  reason?: 'empty' | 'from_far_from_records' | 'to_far_from_records' | 'disconnected' | 'disallowed_transition';
}

type RouteRecord = Pick<PassageRecord, 'path' | 'links'> & Partial<Pick<PassageRecord, 'id' | 'kind' | 'deepestY'>>;

/** 只看几何：同高平走、一格上下 step、更大的下坠 drop、上爬 climb（不声称是梯子）。 */
function routeTransition(from: Vec3Like, to: Vec3Like): PassageTransition {
  const dy = to.y - from.y;
  const horizontal = Math.abs(to.x - from.x) + Math.abs(to.z - from.z);
  if (horizontal === 0) return dy < 0 ? 'drop' : 'climb';
  if (Math.abs(dy) < 0.5) return 'walk';
  if (dy >= 1.5) return 'climb';
  if (dy <= -1.5) return 'drop';
  return 'step';
}

const pointPairKey = (a: Vec3Like, b: Vec3Like) => `${a.x},${a.y},${a.z}|${b.x},${b.y},${b.z}`;

/**
 * 历史通道图上的只读路线检查：返回稀疏路点 + 每段 transition/可逆性/证据，或结构化缺口。
 * 只读历史几何，不验证当前通行、不执行、不改图。
 */
export function passageRouteInspection(
  recs: RouteRecord[],
  from: Vec3Like,
  to: Vec3Like,
  opts: { near?: number; hop?: number; link?: number; heal?: boolean; allowed?: readonly PassageTransition[]; fallbackNear?: boolean } = {},
): PassageRouteInspection {
  const near = opts.near ?? 5, hop = opts.hop ?? 7, link = opts.link ?? PASSAGE_LINK, heal = opts.heal ?? false;
  const { nodes, owner, edges, blocked } = passageGraph(recs, { hop, link, heal });
  const allowed = new Set<PassageTransition>(opts.allowed ?? ['walk', 'step', 'drop', 'climb']);
  const links = new Set<string>();
  for (const rec of recs) for (const l of rec.links ?? []) {
    links.add(pointPairKey(l.a, l.b));
    links.add(pointPairKey(l.b, l.a));
  }
  const closest = (p: Vec3Like) => {
    let best = -1, bd = Infinity;
    nodes.forEach((q, i) => { const d = d3(q, p); if (d < bd) { bd = d; best = i; } });
    return bd <= near ? { index: best, distance: bd } : null;
  };
  const fromHit = closest(from), toHit = closest(to);
  const snapped = {
    from: fromHit === null ? { ...from } : { ...nodes[fromHit.index]! },
    to: toHit === null ? { ...to } : { ...nodes[toHit.index]! },
    fromDistance: fromHit?.distance ?? null,
    toDistance: toHit?.distance ?? null,
  };
  const gap = (reason: PassageRouteInspection['reason'], nearest?: Vec3Like): PassageRouteInspection => ({
    status: 'gap', waypoints: [], legs: [], snapped, near, hop, heal, ...(nearest === undefined ? {} : { nearest }), ...(reason === undefined ? {} : { reason }),
  });
  if (nodes.length === 0) return gap('empty');
  if (fromHit === null) return gap('from_far_from_records');
  if (toHit === null) return gap('to_far_from_records');
  const a = fromHit.index, b = toHit.index;
  if (a === b) return { status: 'route', waypoints: [{ ...nodes[a]! }], legs: [], snapped, near, hop, heal };

  const pathIndex = new Map<number, Map<string, number>>();
  const indexOfPoint = (recIndex: number, p: Vec3Like) => {
    let index = pathIndex.get(recIndex);
    if (index === undefined) {
      index = new Map();
      recs[recIndex]!.path.forEach((q, i) => index!.set(`${q.x},${q.y},${q.z}`, i));
      pathIndex.set(recIndex, index);
    }
    return index.get(`${p.x},${p.y},${p.z}`) ?? -1;
  };
  const legCache = new Map<string, PassageRouteLeg>();
  const legInfo = (u: number, v: number): PassageRouteLeg => {
    const cacheKey = `${u},${v}`;
    const cached = legCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const sameRecord = owner[u] !== undefined && owner[u] === owner[v];
    const rec = sameRecord ? recs[owner[u]!] : undefined;
    const points: Vec3Like[] = (() => {
      if (rec === undefined) return [{ ...nodes[u]! }, { ...nodes[v]! }];
      const i = indexOfPoint(owner[u]!, nodes[u]!);
      const j = indexOfPoint(owner[u]!, nodes[v]!);
      if (i < 0 || j < 0) return [{ ...nodes[u]! }, { ...nodes[v]! }];
      const slice = i <= j ? rec.path.slice(i, j + 1) : rec.path.slice(j, i + 1).reverse();
      return slice.length >= 2 ? slice.map((p) => ({ ...p })) : [{ ...nodes[u]! }, { ...nodes[v]! }];
    })();
    const transitions = [...new Set(points.slice(1).map((p, i) => routeTransition(points[i]!, p)))];
    const linked = links.has(pointPairKey(nodes[u]!, nodes[v]!));
    const evidence: PassageLegEvidence = linked
      ? 'linked'
      : !sameRecord
        ? 'healed'
        : d3(nodes[u]!, nodes[v]!) <= 1.5 ? 'adjacent' : 'legacy';
    const leg = {
      from: { ...nodes[u]! }, to: { ...nodes[v]! }, points, transitions,
      ...(sameRecord && rec?.id !== undefined ? { recordId: rec.id } : {}),
      ...(sameRecord && rec?.kind !== undefined ? { kind: rec.kind } : {}),
      ...(sameRecord && typeof rec?.deepestY === 'number' ? { deepestY: rec.deepestY } : {}),
      reversible: !blocked.get(v)?.has(u),
      evidence,
    } satisfies PassageRouteLeg;
    legCache.set(cacheKey, leg);
    return leg;
  };
  const legAllowed = (u: number, v: number) => legInfo(u, v).transitions.every((transition) => allowed.has(transition));
  const filtered = new Map<number, Set<number>>();
  for (const [u, vs] of edges) for (const v of vs) {
    if (!legAllowed(u, v)) continue;
    (filtered.get(u) ?? filtered.set(u, new Set()).get(u)!).add(v);
  }
  const reconstruct = (prev: number[], target: number) => {
    const route: number[] = [];
    for (let v = target; v >= 0; v = prev[v]!) route.unshift(v);
    return route;
  };

  let { dist, prev } = graphShortest(nodes, filtered, a, b, blocked);
  let target = b;
  if (dist[target] === Infinity) {
    // 未过滤的图若本来能走，说明是 allowed 把某段排除了；把该段作为缺口事实交回。
    const raw = graphShortest(nodes, edges, a, b, blocked);
    if (raw.dist[b] !== Infinity) {
      const rawRoute = reconstruct(raw.prev, b);
      const offending = rawRoute.slice(1).map((v, i) => legInfo(rawRoute[i]!, v)).find((leg) => leg.transitions.some((transition) => !allowed.has(transition)));
      return gap('disallowed_transition', offending?.from ?? nodes[a]);
    }
    const all = graphShortest(nodes, filtered, a, -1, blocked);
    // 旧 passageRoute：目标附近换一个真正可达的节点（兼容行为，只在显式开启时用）。
    if (opts.fallbackNear === true) {
      let reachable = -1, bd = Infinity;
      nodes.forEach((q, i) => {
        if (all.dist[i] !== Infinity) { const d = d3(q, to); if (d <= near && d < bd) { bd = d; reachable = i; } }
      });
      if (reachable >= 0) { dist = all.dist; prev = all.prev; target = reachable; }
      else {
        let nearest = -1, nd = Infinity;
        nodes.forEach((q, i) => {
          if (all.dist[i] !== Infinity) { const d = d3(q, to); if (d < nd) { nd = d; nearest = i; } }
        });
        return gap('disconnected', nearest < 0 ? undefined : nodes[nearest]);
      }
    } else {
      // 新查询：目标分量不连通就如实报缺口，不悄悄改到附近另一个点。
      let nearest = -1, nd = Infinity;
      nodes.forEach((q, i) => {
        if (all.dist[i] !== Infinity) { const d = d3(q, to); if (d < nd) { nd = d; nearest = i; } }
      });
      return gap('disconnected', nearest < 0 ? undefined : nodes[nearest]);
    }
  }
  const route = reconstruct(prev, target);
  return {
    status: 'route',
    waypoints: route.map((index) => ({ ...nodes[index]! })),
    legs: route.slice(1).map((v, i) => legInfo(route[i]!, v)),
    snapped, near, hop, heal,
  };
}

export function passageRoute(recs: RouteRecord[], from: Vec3Like, to: Vec3Like,
  opts: { near?: number; hop?: number; link?: number; heal?: boolean } = {}): Vec3Like[] | null {
  // 旧 API 保留“目标附近换一个可达节点”的兼容行为；新查询默认关闭。
  const inspection = passageRouteInspection(recs, from, to, { ...opts, heal: opts.heal ?? true, fallbackNear: true });
  return inspection.status === 'route' ? inspection.waypoints : null;
}

/** 从 here 连得上的通道分量（here 水平离网 >6 格时退回全部记录）。 */
function surfacePool(recs: (Pick<PassageRecord, 'path' | 'entrances' | 'links'> & { id?: string })[], here: Vec3Like, near = 6) {
  const { nodes, owner, edges, blocked } = passageGraph(recs);
  let start = -1, bd = near;
  nodes.forEach((q, i) => { const d = flat(q, here); if (d < bd) { bd = d; start = i; } });
  let pool = recs;
  if (start >= 0) {
    const owners = new Set<number>();
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const u = stack.pop()!;
      owners.add(owner[u]!);
      for (const v of edges.get(u) ?? []) {
        if (seen.has(v) || blocked.get(u)?.has(v)) continue;
        seen.add(v); stack.push(v);
      }
    }
    // start 自己所属的 record 一定在 owners 里，所以过滤结果不会是空。
    pool = recs.filter((_, i) => owners.has(i));
  }
  return { nodes, edges, blocked, start, pool };
}

/**
 * 想回地面时的地表出口候选：从**从 here 连得上的分量**里，取靠近地表（最高入口以下 band 格内）的入口，
 * 按沿记录网的实际路长排序，而不是按 y 高或水平直线距离。
 * 「最高 y」只是“接近地表”的代理：多个入口都在地表时，y 高 2 格可能要多绕几十格、先下潜再爬回；
 * 水平最近也可能是脚下方很深的旧入口。两者都不能单独当判据，代价才行。
 * 同一个出口被多条记录重复记成相距 ≤3 格的几个点时只算一个候选，recordIds 给出可用的记录 ID。
 */
export function passageSurfaceCandidates(recs: (Pick<PassageRecord, 'path' | 'entrances' | 'links'> & { id?: string })[], here: Vec3Like,
  opts: { band?: number; near?: number; limit?: number } = {}): { anchor: Vec3Like; cost: number; recordIds: string[] }[] {
  // band 与“入口离本 record 最高点 ≤6 格才算地表”保持一致：便宜且合法的地表出口不能因为低 5–6 格就被筛掉。
  const band = opts.band ?? 6, near = opts.near ?? 6, limit = opts.limit ?? 3;
  const { nodes, edges, blocked, start, pool } = surfacePool(recs, here, near);
  const hits: { anchor: Vec3Like; recordIds: string[] }[] = [];
  for (const r of pool) {
    const surfaceY = r.path.length ? Math.max(...r.path.map((p) => p.y)) : Math.max(...r.entrances.map((e) => e.y));
    for (const e of r.entrances) {
      if (surfaceY - e.y > 6) continue;
      // 同一个出口：保留先遇到的点，但把记录 ID 都带上，方便 agent 用 id 指定。
      const same = hits.find((h) => d3(h.anchor, e) <= 3);
      if (same) { if (r.id && !same.recordIds.includes(r.id)) same.recordIds.push(r.id); }
      else hits.push({ anchor: e, recordIds: r.id ? [r.id] : [] });
    }
  }
  if (!hits.length) return [];
  // 先从 here 最近的节点出发做一次最短路；here 离网太远时也用它当起点（follow_passage 会先走过去）。
  let origin = start;
  if (origin < 0) {
    let bd = Infinity;
    nodes.forEach((q, i) => { const d = flat(q, here); if (d < bd) { bd = d; origin = i; } });
  }
  if (origin < 0) return [];
  const { dist } = graphShortest(nodes, edges, origin, -1, blocked);
  // 代价和 passageRoute 用同一口径：取入口 near 范围内所有节点里**可达**的那条最短路。
  // 不能只看几何最近的那个节点——它可能属于另一团互不相连的通道，会把可达出口误判成 Infinity。
  const costOf = (p: Vec3Like) => {
    let best = Infinity;
    nodes.forEach((q, i) => { if (d3(q, p) <= near) best = Math.min(best, dist[i]!); });
    return best;
  };
  // 先去掉走不到的候选，再按可达候选的最高 y 划地表带：否则远处一个接不上的高入口
  // 会把地表带整体抬高，把真正够得着的地表出口全筛掉。
  const priced = hits.map((h) => ({ ...h, cost: costOf(h.anchor) })).filter((h) => h.cost < Infinity);
  if (!priced.length) return [];
  const top = Math.max(...priced.map((h) => h.anchor.y));
  return priced
    .filter((h) => top - h.anchor.y <= band)
    .sort((a, b) => a.cost - b.cost || b.anchor.y - a.anchor.y || flat(a.anchor, here) - flat(b.anchor, here))
    .slice(0, limit);
}

/** 想回地面时取代价最小的地表出口；没有有效入口就取**从 here 按记录方向可达**的最高脚点。
 * 不能只按水平距离取最近的入口——归档里的旧入口可能在脚下方几十格，
 * 选中它会让 follow_passage 在“深处入口”报到达，然后另一个动作再挖上去。
 * 兜底也不能只按 y 取最高点：反向没有证据的落差（有向禁行）之外的更高点到不了，返回它只会让路由 null。 */
export function passageSurfaceAnchor(recs: Pick<PassageRecord, 'path' | 'entrances' | 'links'>[], here: Vec3Like,
  opts: { allowUnreachable?: boolean } = {}): Vec3Like | null {
  const best = passageSurfaceCandidates(recs, here, { limit: 1 })[0];
  if (best) return best.anchor;
  // 带施工权限时，目标可以是记录里更高的不可达出口：follow_passage 的 dig:true 会先尝试接上小断口。
  // 不带施工权限时只给有向可达的点，避免拿一个当前根本到不了的锚点当目标。
  if (opts.allowUnreachable) {
    const { pool } = surfacePool(recs, here);
    return [...pool.flatMap((r) => r.path)].sort((a, b) => b.y - a.y)[0] ?? null;
  }
  const { nodes, edges, blocked } = passageGraph(recs);
  // 起点按三维距离取最近脚点（竖直井里同一 x/z 的上下点不能混为一谈）；离网远时 follow_passage 会先走过去。
  let origin = -1, bd = Infinity;
  nodes.forEach((q, i) => { const d = d3(q, here); if (d < bd) { bd = d; origin = i; } });
  if (origin < 0) return null;
  const seen = new Set<number>([origin]);
  const stack = [origin];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of edges.get(u) ?? []) {
      if (seen.has(v) || blocked.get(u)?.has(v)) continue;
      seen.add(v); stack.push(v);
    }
  }
  let highest: Vec3Like | null = null;
  for (let i = 0; i < nodes.length; i++) if (seen.has(i) && (!highest || nodes[i]!.y > highest.y)) highest = nodes[i]!;
  return highest;
}

/**
 * 同一段路被重复记成多条 record（点基本重合，≈1.5 格内）时，导航只留一条代表：
 * 重复记录会在图上形成并行的伪岔路，让“最短路径”在两团几乎相同的点之间来回穿。
 * 只影响本次读取，不改存储。live 优先于归档，links/点数多的优先，最近用过的优先。
 * 两个方向的重合度都要达标：一条长巷里包含另一条短巷时，短巷反向覆盖不了长巷，不会被误删。
 * 只合并带 links 的记录：它们的边全在 links 里，合并后可原样保留；没有 links 的旧记录靠 path
 * 推断边，拼 path 会改变路网，所以不参与去重。被合并记录的 links/entrances 并进代表记录，
 * 不能像“直接丢掉”那样删掉唯一的桥。
 */
export function dedupePassages<T extends { path: Vec3Like[]; links?: { a: Vec3Like; b: Vec3Like; run?: number; cut?: boolean; reverse?: boolean }[]; entrances?: Vec3Like[]; lastUsedAt?: number; archivedAt?: number }>(
  recs: T[], opts: { cover?: number; near?: number } = {},
): T[] {
  const cover = opts.cover ?? 0.8, near = opts.near ?? 1.5;
  // path 是稀疏采样（多则 160 点）；只有 links 的旧记录才退回边的端点。
  // 两种来源都均匀抽到 ≤64 点，避免两两比较在密集记录上变成 O(160²)。
  const sample = (r: T): Vec3Like[] => {
    const pts = r.path.length ? r.path : [...new Map((r.links ?? []).flatMap((l) => [l.a, l.b]).map((p) => [`${p.x},${p.y},${p.z}`, p])).values()];
    const step = Math.max(1, Math.ceil(pts.length / 64));
    return step === 1 ? pts : pts.filter((_, i) => i % step === 0);
  };
  const eligible = recs.map((r, i) => ({ r, i })).filter(({ r }) => (r.links?.length ?? 0) > 0);
  if (eligible.length < 2) return [...recs];
  const ptsOf = new Map(eligible.map(({ r, i }) => [i, sample(r)]));
  const boxOf = (pts: Vec3Like[]) => pts.length ? {
    min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)), z: Math.min(...pts.map((p) => p.z)) },
    max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)), z: Math.max(...pts.map((p) => p.z)) },
  } : null;
  const boxes = new Map(eligible.map(({ i }) => [i, boxOf(ptsOf.get(i)!)]));
  const overlaps = (i: number, j: number) => { const a = boxes.get(i), b = boxes.get(j); return !!a && !!b
    && a.min.x - near <= b.max.x && b.min.x - near <= a.max.x
    && a.min.y - near <= b.max.y && b.min.y - near <= a.max.y
    && a.min.z - near <= b.max.z && b.min.z - near <= a.max.z; };
  // 提前退出：剩余点全命中也达不到阈值时立刻判否，密集场景下不必把 64×64 比完。
  const covered = (a: Vec3Like[], b: Vec3Like[]) => {
    if (!a.length || !b.length) return false;
    const need = Math.ceil(cover * a.length);
    let hit = 0;
    for (let i = 0; i < a.length; i++) {
      if (b.some((q) => d3(a[i]!, q) <= near)) hit++;
      if (hit + (a.length - i - 1) < need) return false;
    }
    return hit >= need;
  };
  const rank = eligible.map(({ r, i }) => ({ i, key: [r.archivedAt === undefined ? 0 : 1, -(r.links?.length ?? 0), -(r.lastUsedAt ?? 0), -r.path.length] }));
  rank.sort((a, b) => { for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k]! - b.key[k]!; return a.i - b.i; });
  const clusters: { rep: number; members: number[] }[] = [];
  for (const { i } of rank) {
    const pts = ptsOf.get(i)!;
    const c = clusters.find((c) => overlaps(i, c.rep) && covered(pts, ptsOf.get(c.rep)!) && covered(ptsOf.get(c.rep)!, pts));
    if (c) c.members.push(i); else clusters.push({ rep: i, members: [] });
  }
  const merged = new Map<number, T>(), dropped = new Set<number>();
  for (const c of clusters) {
    if (!c.members.length) continue;
    const rep = recs[c.rep]!;
    // 拼接进来的每组第一条是新的连续段起点：建图不能把它和前一条当成一次连续观测。
    const links = [...(rep.links ?? [])];
    for (const m of c.members) {
      const start = links.length;
      links.push(...(recs[m]!.links ?? []));
      if (links.length > start) links[start] = { ...links[start]!, cut: true };
    }
    const entrances = [...(rep.entrances ?? []), ...c.members.flatMap((m) => recs[m]!.entrances ?? [])]
      .filter((e, i, all) => all.findIndex((q) => d3(q, e) < 0.5) === i);
    merged.set(c.rep, { ...rep, links, entrances } as T);
    for (const m of c.members) dropped.add(m);
  }
  if (!merged.size) return [...recs];
  return recs.flatMap((r, i) => merged.has(i) ? [merged.get(i)!] : dropped.has(i) ? [] : [r]);
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
  const { nodes, edges, blocked } = passageGraph(recs);
  const near = opts.near ?? 6;
  let start = -1, bd = near;
  nodes.forEach((q, i) => { const d = d3(q, here); if (d < bd) { bd = d; start = i; } });
  if (start < 0) return globalDeepest();
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of edges.get(u) ?? []) {
      if (seen.has(v) || blocked.get(u)?.has(v)) continue;
      seen.add(v); stack.push(v);
    }
  }
  let best: Vec3Like | null = null;
  for (let i = 0; i < nodes.length; i++) if (seen.has(i) && (!best || nodes[i].y < best.y)) best = nodes[i];
  return best ?? globalDeepest();
}

/** 想往远处走时，取「从 here 能连到的脚点里水平距离最远」的脚点当目标。
 *  主世界下矿要的是最深（passageDeepestAnchor）；下界找要塞/结构探索要的是更远，不能拿最深点当目标。
 *  here 没给时没有“更远”的参照，返回 null；here 离网太远且 reachableOnly 时也返回 null，
 *  否则退回全网水平最远点，交给 follow_passage 先接回网/报断口（由调用方决定是否接受回退）。 */
export function passageFarthestAnchor(recs: Pick<PassageRecord, 'path' | 'links'>[], here?: Vec3Like,
  opts: { near?: number; reachableOnly?: boolean } = {}): Vec3Like | null {
  if (!here) return null;
  const { nodes, edges, blocked } = passageGraph(recs);
  const near = opts.near ?? 6;
  let start = -1, bd = near;
  nodes.forEach((q, i) => { const d = d3(q, here); if (d < bd) { bd = d; start = i; } });
  const farthestFromHere = (pool: number[]) => {
    let best: Vec3Like | null = null, bh = -1;
    for (const i of pool) {
      const p = nodes[i]!;
      const h = Math.hypot(p.x - here.x, p.z - here.z);
      if (h > bh) { bh = h; best = p; }
    }
    return best;
  };
  if (start < 0) return opts.reachableOnly ? null : farthestFromHere(nodes.map((_, i) => i));
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of edges.get(u) ?? []) {
      if (seen.has(v) || blocked.get(u)?.has(v)) continue;
      seen.add(v); stack.push(v);
    }
  }
  return farthestFromHere([...seen]);
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
