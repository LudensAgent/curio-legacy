import type { Vec3Like } from '../adapter/types.ts';

const CONTAINER_LABELS = new Set(['箱子', '陷阱箱', '木桶', '潜影盒', 'chest', 'trapped_chest', 'barrel', 'shulker_box']);
/** Recall projection policy only; adopting it does not rewrite or revalidate saved observations. */
export const CHEST_LOCATION_MODEL_VERSION = 1;
/** Static local containers; ender chests share inventory across locations and are not independent stores. */
export const isContainerLandmark = (label: string) => {
  const name = label.replace(/^我的/, '').match(/（([^（）]+)）$/)?.[1] ?? label.replace(/^我的/, '');
  return CONTAINER_LABELS.has(name) || /^[a-z_]+_shulker_box$/.test(name);
};

/**
 * 箱子记忆：像人一样记“我往这个箱子放过什么”，而不是“里面现在有什么”。
 *
 * 以前每次开箱把整张清单抄下来，缺料时直接说“(x,y,z) 里有 oak_log×38，拿 3 根”——那是开了外挂的记忆。
 * 人玩游戏记不住箱子里的东西，只记得自己放过、拿过、顺眼瞥见过什么，数量是“几个、一些、不少”，
 * 时间一长、别的箱子用得多了就模糊，于是缺东西时去自己用过的箱子里挨个翻。
 * 位置记得比内容牢：“我有个箱子在屋里”几乎不忘，“里面有啥”很快就只剩个大概。
 */
export type ChestQty = 'few' | 'some' | 'lots';
export type TraceKind = 'put' | 'took' | 'glimpsed' | 'absent';

export interface ChestTrace {
  item: string;
  /** put：我放过（最牢）；took：我拿过（还剩多少没把握）；glimpsed：开箱时顺眼看到（最弱）；absent：翻过没有（近期有效） */
  kind: TraceKind;
  /** 模糊数量；没有就是“不知道还剩多少” */
  qty?: ChestQty;
  ts: number;
  /** 当时的游戏日（有的话） */
  day?: number;
  /** 当时的开箱序号：中间又开过多少次别的箱子，是遗忘的主要原因 */
  op: number;
  /** 同一种印象重复了几次：放了三回木头，就记牢了 */
  times: number;
}

export interface ChestRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  /** 用过几次：常用的箱子记得牢 */
  uses: number;
  /** 最近一次用 */
  ts: number;
  day?: number;
  /** 自己给箱子起的名（“放矿的”）：分过类的箱子，里面的东西记得更牢 */
  note?: string;
  traces: ChestTrace[];
  /** 旧版的整箱快照；加载时转成 traces 后删掉 */
  items?: { name: string; count: number }[];
}

export type Confidence = 'sure' | 'likely' | 'vague';
export interface ChestRecall {
  chest: ChestRecord;
  /** 实际记得的物品名（找木板时可能记起的是原木） */
  item: string;
  kind: TraceKind;
  qty?: ChestQty;
  confidence: Confidence;
  score: number;
  observedAt: number;
}

export interface ChestUse {
  put?: { name: string; count: number }[];
  took?: { name: string; count: number }[];
  /** 开箱时看到的全部内容；只会记住最显眼的几样 */
  seen?: { name: string; count: number }[];
  /** 这次是来找什么的：找了没有，就记成“这里没有” */
  sought?: string[];
  note?: string;
  day?: number;
  now?: number;
}

export interface Clock { day?: number; now?: number; op: number }

// 遗忘参数（可调）：每过一个游戏日、每开一次别的箱子，印象各淡多少；低于 FORGET 就当忘了
const DECAY_PER_DAY = 0.15;
const DECAY_PER_OP = 0.1;
const FORGET = 0.3;
const BASE: Record<TraceKind, number> = { put: 3, glimpsed: 1.5, took: 1, absent: 2 };
/** 几个游戏日/几次开箱之内，“翻过没有”还算数 */
const ABSENT_DAYS = 1.5;
const ABSENT_OPS = 6;
/** 开箱时只会注意到最多的这几样 */
const GLANCE = 3;

export const bucket = (count: number): ChestQty => (count <= 4 ? 'few' : count <= 24 ? 'some' : 'lots');
export const qtyWord = (q?: ChestQty) => (q === 'few' ? '几个' : q === 'some' ? '一些' : q === 'lots' ? '不少' : '');
const lessQty = (q?: ChestQty): ChestQty | undefined => (q === 'lots' ? 'some' : q === 'some' ? 'few' : undefined);

/** 过了多少“天”：有游戏日就用游戏日，没有就按一个游戏日 20 分钟折算 */
function daysBetween(t: { ts: number; day?: number }, clock: Clock): number {
  if (t.day != null && clock.day != null) return Math.max(0, clock.day - t.day);
  return Math.max(0, ((clock.now ?? Date.now()) - t.ts) / (20 * 60_000));
}

/** 一条印象现在还有多清楚 */
export function traceScore(t: ChestTrace, chest: Pick<ChestRecord, 'note' | 'uses'>, clock: Clock): number {
  const days = daysBetween(t, clock);
  const ops = Math.max(0, clock.op - t.op);
  const repeated = Math.min(t.times - 1, 3) * 0.5; // 同一印象重复过
  const familiar = Math.min((chest.uses ?? 1) - 1, 4) * 0.25; // 常用的箱子，里面的东西也记得牢些
  const organized = chest.note ? 0.5 : 1; // 自己分过类的箱子，忘得慢
  return BASE[t.kind] + repeated + familiar - (days * DECAY_PER_DAY + ops * DECAY_PER_OP) * organized;
}

export const confidenceOf = (score: number): Confidence | null => (score >= 2.5 ? 'sure' : score >= 1.2 ? 'likely' : score > FORGET ? 'vague' : null);

/** “翻过没有”还算新鲜吗 */
export function checkedRecently(chest: ChestRecord, item: string, clock: Clock): boolean {
  const t = chest.traces.find((x) => x.kind === 'absent' && x.item === item);
  return !!t && daysBetween(t, clock) <= ABSENT_DAYS && clock.op - t.op <= ABSENT_OPS;
}

function upsert(chest: ChestRecord, item: string, kind: TraceKind, qty: ChestQty | undefined, clock: Clock) {
  const now = clock.now ?? Date.now();
  const same = chest.traces.find((t) => t.item === item && t.kind === kind);
  if (same) { same.times++; same.ts = now; same.day = clock.day; same.op = clock.op; if (qty) same.qty = qty; return same; }
  const t: ChestTrace = { item, kind, qty, ts: now, day: clock.day, op: clock.op, times: 1 };
  chest.traces.push(t);
  return t;
}
const drop = (chest: ChestRecord, item: string, kinds: TraceKind[]) => { chest.traces = chest.traces.filter((t) => !(t.item === item && kinds.includes(t.kind))); };

/** 用了一次箱子：按人的注意力更新印象，而不是抄清单 */
export function applyUse(chest: ChestRecord, use: ChestUse, clock: Clock) {
  chest.uses++;
  chest.ts = clock.now ?? Date.now();
  chest.day = clock.day ?? chest.day;
  if (use.note) chest.note = use.note.slice(0, 30);
  const after = new Map((use.seen ?? []).map((i) => [i.name, i.count]));
  const touched = new Set<string>();
  for (const p of use.put ?? []) {
    if (p.count <= 0) continue;
    drop(chest, p.name, ['absent']);
    upsert(chest, p.name, 'put', bucket(after.get(p.name) ?? p.count), clock);
    touched.add(p.name);
  }
  for (const w of use.took ?? []) {
    if (w.count <= 0) continue;
    touched.add(w.name);
    const left = after.get(w.name);
    if (use.seen && !left) { // 拿光了：以后别再来这找
      drop(chest, w.name, ['put', 'glimpsed', 'took']);
      upsert(chest, w.name, 'absent', undefined, clock);
      continue;
    }
    const put = chest.traces.find((t) => t.item === w.name && t.kind === 'put');
    if (put) put.qty = left != null ? bucket(left) : lessQty(put.qty); // 拿过之后对还剩多少就没把握了
    upsert(chest, w.name, 'took', left != null ? bucket(left) : undefined, clock);
  }
  for (const s of use.sought ?? []) {
    if (touched.has(s) || after.has(s)) continue;
    drop(chest, s, ['put', 'glimpsed', 'took']);
    upsert(chest, s, 'absent', undefined, clock);
  }
  if (use.seen) {
    // 顺眼看到的：只有最多的几样会留下印象；以前记得有、现在却没看见的，悄悄忘掉
    const glance = [...use.seen].filter((i) => i.count > 0 && !touched.has(i.name)).sort((a, b) => b.count - a.count).slice(0, GLANCE);
    for (const g of glance) {
      drop(chest, g.name, ['absent']);
      // 自己放过的东西又看见了：是“哦我的木头还在”，加深原来的印象，不另记一条
      const put = chest.traces.find((t) => t.item === g.name && t.kind === 'put');
      if (put) { put.times++; put.ts = clock.now ?? Date.now(); put.day = clock.day; put.op = clock.op; put.qty = bucket(g.count); continue; }
      upsert(chest, g.name, 'glimpsed', bucket(g.count), clock);
    }
    chest.traces = chest.traces.filter((t) => t.kind === 'absent' || after.has(t.item));
  }
}

/** 旧快照 → 印象：整箱抄下来的清单，当作当时瞥见的最多几样 */
export function migrateRecord(raw: Partial<ChestRecord> & { items?: { name: string; count: number }[] }, op: number): ChestRecord {
  const rec: ChestRecord = { worldId: raw.worldId, dim: raw.dim!, pos: raw.pos!, uses: raw.uses ?? 1, ts: raw.ts ?? Date.now(), day: raw.day, note: raw.note, traces: raw.traces ?? [] };
  if (raw.items && !raw.traces) {
    rec.traces = [...raw.items].filter((i) => i.count > 0).sort((a, b) => b.count - a.count).slice(0, 6)
      .map((i) => ({ item: i.name, kind: 'glimpsed' as const, qty: bucket(i.count), ts: rec.ts, day: rec.day, op, times: 1 }));
  }
  return rec;
}

/** 忘干净的印象清掉，别让文件无限长 */
export function prune(chest: ChestRecord, clock: Clock) {
  chest.traces = chest.traces.filter((t) => (t.kind === 'absent' ? checkedRecently(chest, t.item, clock) : traceScore(t, chest, clock) > FORGET - 1));
}

/** 想找某样东西：记得哪些箱子里可能有（放过/拿过/见过），确定的在前；刚翻过没有的不算 */
export function recall(chests: ChestRecord[], accept: (name: string) => boolean, clock: Clock): ChestRecall[] {
  const out: ChestRecall[] = [];
  for (const chest of chests) {
    let best: ChestRecall | null = null;
    for (const t of chest.traces) {
      if (t.kind === 'absent' || !accept(t.item) || checkedRecently(chest, t.item, clock)) continue;
      const score = traceScore(t, chest, clock);
      const confidence = confidenceOf(score);
      if (!confidence) continue;
      if (!best || score > best.score) best = { chest, item: t.item, kind: t.kind, qty: t.qty, confidence, score, observedAt: t.ts };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

const at = (p: Vec3Like) => `(${p.x},${p.y},${p.z})`;

/** 近期工作记忆保留位置；更久只记区域，中心是范围标记，不能作为箱子的精确交互坐标。 */
export function chestLocation(c: Pick<ChestRecord, 'pos' | 'ts'>, clock: Pick<Clock, 'now'> = {}) {
  const precise = Math.max(0, (clock.now ?? Date.now()) - c.ts) <= 120_000;
  const pos = precise ? { ...c.pos } : { x: Math.floor(c.pos.x / 32) * 32 + 16, y: Math.floor(c.pos.y / 16) * 16 + 8, z: Math.floor(c.pos.z / 32) * 32 + 16 };
  const radius = precise ? 0 : 24;
  return { pos, radius, precise, observedAt: c.ts, text: precise ? at(pos) : `中心 ${at(pos)}、半径约 ${radius} 格的区域（范围中心，不是箱子坐标）` };
}

/** 名称只能带当前记忆精度允许的位置。 */
export const chestName = (c: ChestRecord, clock?: Pick<Clock, 'now'>) => `${c.note ? `${c.note}的箱子` : '箱子'} ${chestLocation(c, clock).text}`;

function recalledTraces(c: ChestRecord, clock: Clock, max: number) {
  return c.traces.filter((trace) => trace.kind !== 'absent').map((trace) => ({ trace, confidence: confidenceOf(traceScore(trace, c, clock)) }))
    .filter((entry) => entry.confidence !== null).sort((a, b) => traceScore(b.trace, c, clock) - traceScore(a.trace, c, clock)).slice(0, max);
}

/** A newly used box must not sharpen the location of an older, independently fading item impression. */
export function chestRecollectionLocation(c: ChestRecord, clock: Clock, max = 4) {
  const traces = recalledTraces(c, clock, max);
  return chestLocation({ pos: c.pos, ts: Math.min(c.ts, ...traces.map((entry) => entry.trace.ts)) }, clock);
}

/** 一条回忆说成人话 */
export function describeRecall(r: ChestRecall, dist?: number, clock?: Pick<Clock, 'now'>): string {
  const location = chestLocation({ pos: r.chest.pos, ts: r.observedAt }, clock);
  const where = `${chestName({ ...r.chest, ts: r.observedAt }, clock)}${location.precise && dist != null ? `（${dist} 格外）` : ''}`;
  const q = qtyWord(r.qty);
  const some = q ? `${q} ` : '';
  if (!location.precise) return `记得${location.text}的箱子里${r.kind === 'put' ? '放过' : r.kind === 'took' ? '拿过' : '见过'}${some}${r.item}，不确定是哪只箱子或还剩多少`;
  if (r.confidence === 'sure') {
    if (r.kind === 'put') return `记得往 ${where} 放过${some}${r.item}`;
    if (r.kind === 'took') return `在 ${where} 拿过 ${r.item}，应该还有${q ? ` ${q}` : ''}`;
    return `记得 ${where} 里有${some}${r.item}`;
  }
  if (r.confidence === 'likely') return `好像${r.kind === 'put' ? `往 ${where} 放过` : `在 ${where} ${r.kind === 'took' ? '拿过' : '见过'}`} ${r.item}，不确定还剩多少`;
  return `隐约记得哪个箱子里${r.kind === 'put' ? '放过' : '见过'} ${r.item}，可能是 ${where} 那个`;
}

/** 一个箱子现在记得的样子：“放矿的箱子 (x,y,z)：放过不少 raw_iron、几个 coal；好像还有 cobblestone” */
export function describeChest(c: ChestRecord, clock: Clock, max = 4): string {
  const traces = recalledTraces(c, clock, max), location = chestRecollectionLocation(c, clock, max);
  const sure = traces.filter((entry) => entry.confidence !== 'vague').map(({ trace }) => `${trace.kind === 'took' ? '拿过' : trace.kind === 'put' ? '放过' : '有'}${qtyWord(trace.qty) ? `${qtyWord(trace.qty)} ` : ''}${trace.item}`);
  const vague = traces.filter((entry) => entry.confidence === 'vague').map(({ trace }) => trace.item);
  const body = [sure.join('、'), vague.length ? `好像还有 ${vague.join('、')}` : ''].filter(Boolean).join('；');
  return `${chestName({ ...c, ts: location.observedAt }, clock)}：${body || (c.uses ? '用过，里面有什么记不清了' : '没打开过')}${location.precise ? '' : '；历史区域印象，具体箱子需重新看见'}`;
}

/** 所有箱子里记得的东西合起来（给“家里大概有什么”用），同一样东西取最清楚的那条 */
export function rememberedStock(chests: ChestRecord[], clock: Clock): { item: string; qty?: ChestQty; confidence: Confidence; chests: number }[] {
  const m = new Map<string, { item: string; qty?: ChestQty; confidence: Confidence; score: number; chests: number }>();
  for (const c of chests) for (const t of c.traces) {
    if (t.kind === 'absent') continue;
    const s = traceScore(t, c, clock), conf = confidenceOf(s);
    if (!conf) continue;
    const cur = m.get(t.item);
    if (!cur) m.set(t.item, { item: t.item, qty: t.qty, confidence: conf, score: s, chests: 1 });
    else { cur.chests++; if (s > cur.score) Object.assign(cur, { qty: t.qty, confidence: conf, score: s }); }
  }
  return [...m.values()].sort((a, b) => b.score - a.score);
}
