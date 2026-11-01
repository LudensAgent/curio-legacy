import type { InvItem } from '../adapter/types.ts';
import { config } from '../config.ts';
import { ResourceKnowledge } from './knowledge.ts';

/**
 * 材料缺口：想做 N 个 X → 拿背包里已有的东西抵扣 → 还差哪些原材料、各差多少。
 * 这是玩家脑子里的那笔账（“做个门要 6 块木板 = 2 根原木，我有 1 根，再砍 1 根”），
 * 让采集按缺口来，而不是随手定个 8、16。只用配方/掉落知识，不知道资源在哪。
 */

let shared: ResourceKnowledge | null = null;
export const knowledge = () => (shared ??= new ResourceKnowledge(config.mc.version));

const WOOD_PREFIX = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_/;
const COLOR = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/;
const family = (n: string) => n.replace(COLOR, '');
/** 掉落自己的“天然”方块：原木、泥土、圆石、矿石掉的东西 → 当作要去采的原材料 */
const NATURAL_BLOCK = /_ore$|_log$|^(grass_block|dirt|stone|cobblestone|gravel|sand|red_sand|clay|snow_block|netherrack|deepslate|cobbled_deepslate|.*_leaves|.*_wool|melon|pumpkin|sugar_cane|cactus|kelp|short_grass|grass|tall_grass|fern)$/;

export interface MaterialPlan {
  item: string;
  count: number;
  enough: boolean;
  /** 还差的原材料（要去采/打/找的）；anyWood：哪种原木都行（工作台、木棍、木镐这类不挑木种） */
  raw: { item: string; count: number; from: string[]; anyWood?: boolean }[];
  /** 扣掉这次要用的之后背包还剩什么（连着算几样东西时用） */
  leftover: InvItem[];
  /** 需要先做的中间品（按顺序） */
  crafts: { item: string; count: number }[];
  smelts: { item: string; count: number }[];
}

export function materialPlan(item: string, count: number, inventory: InvItem[], k: ResourceKnowledge = knowledge()): MaterialPlan {
  const pool = new Map<string, number>();
  for (const i of inventory) pool.set(i.name, (pool.get(i.name) ?? 0) + i.count);
  const raw = new Map<string, { count: number; from: string[] }>();
  const crafts: { item: string; count: number }[] = [];
  const smelts: { item: string; count: number }[] = [];
  const cache = new Map<string, ReturnType<ResourceKnowledge['query']> | null>();
  const query = (name: string, n: number) => {
    const key = `${name}:${n}`;
    if (!cache.has(key)) { try { cache.set(key, k.query(name, Math.min(2304, n))); } catch { cache.set(key, null); } }
    return cache.get(key)!;
  };
  const natural = (name: string) => (query(name, 1)?.methods ?? []).some((m) => m.kind === 'gather' && NATURAL_BLOCK.test(m.block ?? ''));
  const craftableFromPool = (name: string) => (query(name, 1)?.methods ?? []).some((m) => m.kind === 'craft' && m.inputs.every((i) => (pool.get(i.item) ?? 0) > 0));

  const need = (name: string, n: number, depth: number, path: Set<string>) => {
    const have = pool.get(name) ?? 0, used = Math.min(have, n), missing = n - used;
    pool.set(name, have - used);
    if (missing <= 0) return;
    const addRaw = (from: string[]) => { const r = raw.get(name) ?? { count: 0, from }; r.count += missing; raw.set(name, r); };
    const q = query(name, missing);
    if (!q) return addRaw([]);
    const gathers = q.methods.filter((m) => m.kind === 'gather').map((m) => m.block!).filter(Boolean);
    // 木板、门、熔炉这类方块也“掉落自己”，但那是做出来的，不是采来的
    const naturalGather = gathers.filter((b) => NATURAL_BLOCK.test(b));
    if (naturalGather.length || depth >= 7) return addRaw((naturalGather.length ? naturalGather : gathers).slice(0, 4));
    const craftsM = q.methods.filter((m) => m.kind === 'craft' && !m.inputs.some((i) => path.has(i.item)));
    // 选最顺手的做法：手上已有的不算缺；缺的是能直接采的原材料（原木、圆石）代价小，
    // 能用手上东西再做出来的代价也小；“染料 + 别色床”这种改色配方要先有成品，排到最后
    const score = (m: typeof craftsM[number]) => m.inputs.reduce((sum, i) => {
      const short = Math.max(0, i.required - (pool.get(i.item) ?? 0));
      if (!short) return sum;
      if (i.item !== name && family(i.item) === family(name)) return sum + 1000;
      return sum + short * (natural(i.item) ? 0.4 : craftableFromPool(i.item) ? 0.25 : 1);
    }, 0);
    const best = craftsM.length ? craftsM.map((m) => ({ m, s: score(m) })).sort((a, b) => a.s - b.s)[0] : undefined;
    const smelt = q.methods.find((m) => m.kind === 'smelt' && !path.has(m.inputs[0].item));
    const next = new Set(path).add(name);
    // 铁锭这类：手上没有铁粒/铁块时，正常办法是烧，而不是“9 个铁粒合成”
    if (best && (!smelt || best.s === 0)) {
      for (const input of best.m.inputs) need(input.item, input.required, depth + 1, next);
      const made = best.m.batches * best.m.outputCount;
      crafts.push({ item: name, count: made });
      pool.set(name, (pool.get(name) ?? 0) + made - missing);
      return;
    }
    if (smelt) {
      need(smelt.inputs[0].item, missing, depth + 1, next);
      smelts.push({ item: name, count: missing });
      return;
    }
    addRaw(gathers.slice(0, 4));
  };
  need(item, count, 0, new Set());
  // 目标本身不带木种（工作台、木棍、木镐、箱子……）时，缺的原木哪种都行，别只认橡木
  const anyWood = !WOOD_PREFIX.test(item);
  const merged = new Map<string, { item: string; count: number; from: string[]; anyWood?: boolean }>();
  for (const [i, r] of raw) {
    if (anyWood && i.endsWith('_log')) {
      const cur = merged.get('*log') ?? { item: i, count: 0, from: [] as string[], anyWood: true };
      cur.count += r.count;
      merged.set('*log', cur);
    } else merged.set(i, { item: i, count: r.count, from: r.from });
  }
  return { item, count, enough: raw.size === 0, raw: [...merged.values()], crafts, smelts,
    leftover: [...pool].filter(([, c]) => c > 0).map(([name, c]) => ({ name, count: c }) as InvItem) };
}

/** 一句话描述缺口 */
export function describePlan(p: MaterialPlan): string {
  const pre = p.crafts.filter((c) => c.item !== p.item);
  if (p.enough) return `做 ${p.item}×${p.count} 的材料已经够了${pre.length ? `（会顺带先做 ${pre.map((c) => `${c.item}×${c.count}`).join('、')}）` : ''}`;
  return `做 ${p.item}×${p.count} 还差：${p.raw.map((r) => r.anyWood ? `原木×${r.count}（哪种都行）` : `${r.item}×${r.count}${r.from.length && r.from[0] !== r.item ? `（采 ${r.from.slice(0, 2).join('/')}）` : ''}`).join('、')}${p.smelts.length ? `；要烧 ${p.smelts.map((s) => `${s.item}×${s.count}`).join('、')}` : ''}`;
}

/** 一个方块挖掉掉出的物品名（把"采 stone"和"背包里的 cobblestone"对上账）；无掉落记录退回方块名本身 */
export const dropItemsOf = (block: string): string[] => knowledge().dropsOf(block);

/** 背包还能不能再装一件 item：有空槽，或已有一叠没堆满的同名物品（堆叠上限以内）。 */
export const canAcceptItem = (inv: InvItem[], emptySlots: number, item: string): boolean => {
  if (emptySlots > 0) return true;
  const entry = inv.find((i) => i.name === item);
  if (!entry) return false;
  const stackSize = entry.stackSize ?? 64;
  if (entry.stacks?.length) return entry.stacks.some((st) => st.count < stackSize);
  return entry.count < stackSize;
};
