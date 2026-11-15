import type { Vec3Like } from '../adapter/types.ts';

const CONTAINER_LABELS = new Set(['箱子', '陷阱箱', '木桶', '潜影盒', 'chest', 'trapped_chest', 'barrel', 'shulker_box']);
/** 静态本地容器；末影箱跨位置共享内容，不当作独立存放点。 */
export const isContainerLandmark = (label: string) => {
  const name = label.replace(/^我的/, '').match(/（([^（）]+)）$/)?.[1] ?? label.replace(/^我的/, '');
  return CONTAINER_LABELS.has(name) || /^[a-z_]+_shulker_box$/.test(name);
};

/**
 * 精确仓储账本：像本子一样记「这个箱子最后一次打开时里面有什么」，而不是模仿人的遗忘。
 *
 * 只记真实观测（开箱/存取时适配器给的完整 after 快照），不凭空捏造；精确到「最后一次打开」为止，
 * 之后世界若在未观察期间推进，用 possiblyStale 标记「内容可能变了」，不假装还是准的。重新打开即自纠。
 */
export interface ChestContents {
  /** 精确内容；空数组 = 确认过是空的 */
  items: { name: string; count: number }[];
  /** 墙钟时间戳：最后一次打开/存取 */
  observedAt: number;
  /** 当时的游戏日（有的话） */
  day?: number;
  /** 世界在此之后推进且可能未观察 → 内容可能变了（只标记，不衰减） */
  possiblyStale?: boolean;
  /** 容器总格数（双箱 54、单箱/木桶 27、潜影盒 27）；全量快照才有 */
  capacity?: number;
  /** 全量确认时完全空着的格子数；增量操作后不再可靠，随 possiblyStale 一起弃用。
   *  注意不是「还能塞多少」也不是总容量：0 格空时已有未满同名堆叠仍能补同类 */
  freeSlots?: number;
}

export interface ChestRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  /** 容器类型：chest | trapped_chest | barrel | *_shulker_box */
  block: string;
  /** 用过几次 */
  uses: number;
  /** 最近一次用 */
  ts: number;
  day?: number;
  /** 自己给箱子起的名（"放矿的"） */
  note?: string;
  contents: ChestContents;
}

export interface ChestUse {
  put?: { name: string; count: number }[];
  took?: { name: string; count: number }[];
  /** 开箱后看到的全部内容（完整快照，精确） */
  seen?: { name: string; count: number }[];
  /** 这次是来找什么的 */
  sought?: string[];
  note?: string;
  day?: number;
  now?: number;
  /** 容器方块名 */
  block?: string;
  /** 全量快照时顺带记下的容器总格数与空余格数 */
  capacity?: number;
  freeSlots?: number;
}

export interface Clock { day?: number; now?: number; op?: number }

/** 一个箱子里命中物品的精确结果 */
export interface ChestRecall {
  chest: ChestRecord;
  /** 命中的物品名 */
  item: string;
  /** 该箱里最后确认的数量 */
  count: number;
  /** 内容最后一次被观察到的时间 */
  observedAt: number;
  /** 到查询坐标的距离（给了 from 才算） */
  dist?: number;
}

/** 把一次用箱子（存/取/开）写成精确账本 */
export function applyContents(chest: ChestRecord, use: ChestUse, clock: Clock) {
  chest.uses++;
  chest.ts = clock.now ?? Date.now();
  chest.day = clock.day ?? chest.day;
  if (use.note) chest.note = use.note.slice(0, 30);
  if (use.block) chest.block = use.block;
  const now = clock.now ?? Date.now();
  if (use.seen) {
    // 完整快照：整表覆盖，内容精确、不再陈旧
    chest.contents = { items: [...use.seen].filter((i) => i.count > 0).map((i) => ({ name: i.name, count: i.count })), observedAt: now, day: clock.day,
      ...(use.capacity !== undefined ? { capacity: use.capacity } : {}), ...(use.freeSlots !== undefined ? { freeSlots: use.freeSlots } : {}) };
  } else {
    // 只有增量：在已有账本上加减；没有全量快照就标陈旧
    const map = new Map((chest.contents?.items ?? []).map((i) => [i.name, i.count]));
    for (const p of use.put ?? []) if (p.count > 0) map.set(p.name, (map.get(p.name) ?? 0) + p.count);
    for (const w of use.took ?? []) if (w.count > 0) map.set(w.name, Math.max(0, (map.get(w.name) ?? 0) - w.count));
    chest.contents = { items: [...map].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })), observedAt: now, day: clock.day, possiblyStale: true };
  }
}

/** 旧数据迁移：直接丢弃旧印象（items/traces），只保留箱子身份，内容等下次打开再精确补上 */
export function migrateChest(raw: Partial<ChestRecord> & { items?: unknown; traces?: unknown }, now = Date.now()): ChestRecord {
  return {
    worldId: raw.worldId, dim: raw.dim!, pos: raw.pos!, block: (raw.block as string) ?? 'chest',
    uses: raw.uses ?? 1, ts: raw.ts ?? now, day: raw.day, note: raw.note,
    contents: { items: [], observedAt: 0, possiblyStale: true },
  };
}

const at = (p: Vec3Like) => `(${p.x},${p.y},${p.z})`;

/** 精确账本：容器位置恒精确（内容与位置都不再按时间/次数衰减）。 */
export function chestLocation(c: Pick<ChestRecord, 'pos' | 'ts'>, _clock?: Clock) {
  return { pos: { ...c.pos }, radius: 0, precise: true, observedAt: c.ts, text: at(c.pos) };
}

const BLOCK_ZH: Record<string, string> = { chest: '箱子', trapped_chest: '陷阱箱', barrel: '木桶', shulker_box: '潜影盒' };
export const chestName = (c: ChestRecord) => {
  const zh = BLOCK_ZH[c.block] ?? (c.block.endsWith('shulker_box') ? '潜影盒' : '箱子');
  return `${c.note ? `${c.note}的` : ''}${zh} ${at(c.pos)}`;
};

/** 想找某样东西：记得哪些箱子里有、各多少，近的在前 */
export function recall(chests: ChestRecord[], accept: (name: string) => boolean, _clock: Clock, from?: Vec3Like): ChestRecall[] {
  const out: ChestRecall[] = [];
  for (const c of chests) {
    const matches = (c.contents?.items ?? []).filter((i) => i.count > 0 && accept(i.name));
    if (!matches.length) continue;
    const best = matches.sort((a, b) => b.count - a.count)[0];
    out.push({ chest: c, item: best.name, count: best.count, observedAt: c.contents.observedAt, ...(from ? { dist: Math.round(Math.hypot(c.pos.x - from.x, c.pos.z - from.z)) } : {}) });
  }
  return out.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
}

/** 箱子内容的公共事实：最多几样、空位、增量记录；两个描述函数共用，避免各写一套排序/空位口径。 */
function chestFacts(c: ChestRecord, max: number) {
  const items = (c.contents?.items ?? []).filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
  return { items: items.slice(0, max), total: items.length, freeSlots: c.contents?.freeSlots, stale: c.contents?.possiblyStale === true };
}

/** 一个箱子现在精确的样子："放矿的箱子 (293,68,-369)：raw_iron×9（还剩 3 格空）" */
export function describeChest(c: ChestRecord, _clock?: Clock, max = 6): string {
  const { items, freeSlots, stale } = chestFacts(c, max);
  const body = items.map((i) => `${i.name}×${i.count}`).join('、');
  const label = body || (freeSlots != null ? '空的' : '内容未知（重新打开才确认）');
  return `${chestName(c)}：${label}${freeSlots != null ? `（还剩 ${freeSlots} 格空）` : ''}${stale ? '（最近一次是增量操作，未确认全量）' : ''}`;
}

/** 设施列表用的一句摘要：只给类数、最多的几样和空位；完整数量仍用 find_item 查。 */
export function describeChestSummary(c: ChestRecord, max = 2): string {
  const { items, total, freeSlots, stale } = chestFacts(c, max);
  return total
    ? `${total} 类，${items.map((i) => `${i.name}×${i.count}`).join('、')}${total > max ? ' 等' : ''}${freeSlots != null ? `，剩 ${freeSlots} 格空` : ''}${stale ? '，增量记录未确认全量' : ''}；完整数量用 find_item 查`
    : freeSlots != null ? `空，剩 ${freeSlots} 格；重新打开才更新` : '内容未知（重新打开才确认）';
}

export interface FurnaceState {
  input: { name: string; count: number } | null;
  output: { name: string; count: number } | null;
  fuel: { name: string; count: number } | null;
  burning: boolean;
}

/** 熔炉上次看到的样子：空也是一条确认事实；只剩燃料时单独说，避免误读成还有产物。 */
export const furnaceContents = (f: FurnaceState) => {
  const parts = [f.input ? `原料 ${f.input.name}×${f.input.count}` : '', f.output ? `产物 ${f.output.name}×${f.output.count}` : '', f.fuel ? `燃料 ${f.fuel.name}×${f.fuel.count}` : ''].filter(Boolean);
  if (f.input || f.output) return `${parts.join('、')}${f.burning ? '，当时还在烧' : ''}`;
  return f.fuel ? `空（只剩燃料 ${f.fuel.name}×${f.fuel.count}）` : '空（已确认没有可取的东西）';
};

/** 一条精确回忆说成人话 */
export function describeRecall(r: ChestRecall, dist?: number, _clock?: Pick<Clock, 'now'>): string {
  const where = `${chestName(r.chest)}${dist != null ? `（${dist} 格外）` : ''}`;
  return `记得 ${where} 里有 ${r.item}×${r.count}（上次观察到的数量）`;
}

/** 总表里的一行：某样东西在箱子里多少、背包里多少、合计多少 */
export interface StockRow {
  item: string;
  total: number;
  inChests: number;
  chestCount: number;
  inBackpack: number;
}

/** 所有箱子 + 背包合起来的精确库存（给"家里/身上总共有多少"用） */
export function totalStock(chests: ChestRecord[], backpack: { name: string; count: number }[]): StockRow[] {
  const m = new Map<string, StockRow>();
  for (const c of chests) for (const i of c.contents?.items ?? []) {
    const e = m.get(i.name) ?? { item: i.name, total: 0, inChests: 0, chestCount: 0, inBackpack: 0 };
    e.inChests += i.count; e.chestCount++;
    m.set(i.name, e);
  }
  for (const i of backpack) {
    const e = m.get(i.name) ?? { item: i.name, total: 0, inChests: 0, chestCount: 0, inBackpack: 0 };
    e.inBackpack += i.count;
    m.set(i.name, e);
  }
  for (const e of m.values()) e.total = e.inChests + e.inBackpack;
  return [...m.values()].sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------- 历史叙述的模糊化（episodic / hindsight 用）
// 精确账本不用这些；recollection.ts 对「历史经历文字」里的容器数量做模糊化时仍用 bucket/qtyWord。
export type ChestQty = 'few' | 'some' | 'lots';
export const bucket = (count: number): ChestQty => (count <= 4 ? 'few' : count <= 24 ? 'some' : 'lots');
export const qtyWord = (q?: ChestQty) => (q === 'few' ? '几个' : q === 'some' ? '一些' : q === 'lots' ? '不少' : '');
