import type { AgentState } from '../adapter/types.ts';
import type { StockRow } from '../memory/chest-memory.ts';
import { fuelBurn } from '../methods/fuel.ts';
import { describePlan, materialPlan } from '../methods/shortfall.ts';

/**
 * 消耗品预算：把「按可算单价消耗、中途耗尽代价高」的东西统一成事实——
 * 结构只测度（存量、覆盖、还能做多少），策略（备多少、何时采）由 Agent 定。
 *
 * 单价不写死：这里只给原版默认与常识估算；难度/规则门控与实测校正由后续阶段接入。
 */

export type ConsumeDriver =
  | { kind: 'placement'; spacing: number }       // 每 spacing 格放一支（火把的 torch_every）
  | { kind: 'per_use' }                           // 用一次少一个（箭、垫脚方块）
  | { kind: 'game_time' }                         // 随游戏时长消耗（食物）
  | { kind: 'durability'; per: 'block' | 'hit' }  // 每挖一格 / 每挨一下掉耐久（阶段 2）
  | { kind: 'per_item_smelted' };                 // 每烧一件物品耗燃料（阶段 3）

export interface SupplyProfile {
  id: string;
  match: RegExp;
  driver: ConsumeDriver;
  /** materialPlan 的补货目标物品 */
  restock: string;
}

type Inv = AgentState['inventory'];
type Stock = readonly StockRow[];
const sum = (items: Inv, re: RegExp) => items.filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
/** 某类材料在箱子里有多少（精确账本 inChests）；没有箱子记忆返回 0 */
const chestCount = (stock: Stock | undefined, re: RegExp) => (stock ?? []).filter((s) => re.test(s.item)).reduce((n, s) => n + s.inChests, 0);
/** 把箱子里的材料并进背包，供 materialPlan 精确抵扣（不区分来源，只管合计够不够） */
const withChests = (inv: Inv, stock?: Stock): Inv => {
  const out = inv.map((i) => ({ name: i.name, count: i.count }));
  for (const s of stock ?? []) {
    if (s.inChests <= 0) continue;
    const e = out.find((i) => i.name === s.item);
    if (e) e.count += s.inChests; else out.push({ name: s.item, count: s.inChests });
  }
  return out;
};

const DIFFICULTY_ZH: Record<string, string> = { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' };

const FOOD = /^(bread|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_cod|cooked_salmon|apple|baked_potato|carrot|beef|porkchop|chicken|mutton|rabbit|cooked_rabbit|potato|sweet_berries|melon_slice|cookie|pumpkin_pie|beetroot|dried_kelp)$/;
const BRIDGE_BLOCKS = /^(cobblestone|cobbled_deepslate|stone|dirt|sand|gravel|netherrack|.*_planks)$/;

export const SUPPLY_PROFILES: SupplyProfile[] = [
  { id: 'torch', match: /^torch$/, driver: { kind: 'placement', spacing: 8 }, restock: 'torch' },
  { id: 'food', match: FOOD, driver: { kind: 'game_time' }, restock: 'bread' },
  { id: 'arrow', match: /arrow$/, driver: { kind: 'per_use' }, restock: 'arrow' },
  { id: 'blocks', match: BRIDGE_BLOCKS, driver: { kind: 'per_use' }, restock: 'cobblestone' },
];

/** 背包 + 箱子合计能直接做几支火把（1 煤/木炭 + 1 木棍 = 4 支；木棍不够可用原木补） */
export function torchCraftable(inv: Inv, stock?: Stock): { coal: number; sticks: number; craftable: number; chestCoal: number; chestSticks: number } {
  const coal = sum(inv, /^(coal|charcoal)$/) + chestCount(stock, /^(coal|charcoal)$/);
  const sticks = sum(inv, /^stick$/) + chestCount(stock, /^stick$/);
  const chestCoal = chestCount(stock, /^(coal|charcoal)$/), chestSticks = chestCount(stock, /^stick$/);
  return { coal, sticks, craftable: Math.min(coal, sticks) * 4, chestCoal, chestSticks };
}

export interface SupplyFacts {
  inv: Inv;
  /** torch_every 习惯；未设为 0/undefined 时用常识 8 格估算 */
  torchEvery?: number;
  /** 只生成这些 profile 的事实；缺省全部 */
  only?: Set<string>;
  /** 世界难度：和平下火把只为照明，不压刷怪 */
  difficulty?: AgentState['difficulty'];
  /** 世界规则：keepInventory 开时风险前提不同 */
  gamerules?: AgentState['gamerules'];
  /** 精确箱子账本（StockRow[]）：有箱子记忆时，煤/木棍/燃料等材料按合计算 */
  stock?: Stock;
}

export function supplyFacts(opts: SupplyFacts): string[] {
  const { inv, only } = opts;
  const out: string[] = [];
  const want = (id: string) => !only || only.has(id);

  if (want('torch')) {
    const torches = sum(inv, /^torch$/);
    const every = opts.torchEvery && opts.torchEvery > 0 ? opts.torchEvery : 8;
    const c = torchCraftable(inv, opts.stock);
    const craft = c.craftable > 0 ? `；煤/木炭 ${c.coal}、木棍 ${c.sticks}，还能直接做 ${c.craftable} 支` : `；煤/木炭 ${c.coal}、木棍 ${c.sticks}，眼下不够直接做火把`;
    const chestNote = (c.chestCoal > 0 || c.chestSticks > 0) ? `（其中箱子里 煤/木炭 ${c.chestCoal}、木棍 ${c.chestSticks}）` : '';
    const spawn = opts.difficulty === 'peaceful' ? '（和平没怪，火把只为照明）' : opts.difficulty ? `（${DIFFICULTY_ZH[opts.difficulty] ?? opts.difficulty}，会刷怪）` : '';
    out.push(`火把 ${torches} 支（torch_every≈${every} → 约能照亮 ${torches * every} 格暗处）${spawn}${craft}${chestNote}`);
  }
  if (want('food')) {
    const cooked = sum(inv, /cooked_|bread|baked_potato/);
    const food = sum(inv, FOOD);
    out.push(`路上食物 ${food} 个（其中熟食 ${cooked} 个）`);
  }
  if (want('arrow')) {
    const arrows = sum(inv, /arrow$/);
    if (arrows > 0) out.push(`箭 ${arrows} 发`);
  }
  if (want('blocks')) {
    const blocks = sum(inv, BRIDGE_BLOCKS);
    if (blocks > 0) out.push(`能垫路的方块 ${blocks} 块`);
  }
  return out;
}

/**
 * 工具的耐久事实：剩余耐久合计 → 按「每挖一格耗 1 耐久」估算还能挖多少格，
 * 并附换一把的材料缺口（materialPlan 按版本查，不写死配方）。
 * kinds 缺省只看镐（下矿的账里最要紧）。
 */
/** 冶炼燃料预算：烧 count 个 input 需要多少件燃料位、背包燃料合计够不够（按原版默认燃烧值，明标） */
export function fuelFacts(inv: Inv, input: string, count: number, stock?: Stock): string | null {
  const fuels: string[] = [];
  let capacity = 0;
  for (const i of inv) {
    if (i.name === input || i.count <= 0) continue; // 原木既是原料也可是燃料，别烧自己
    const per = fuelBurn(i.name);
    if (per <= 0) continue;
    capacity += i.count * per;
    fuels.push(`${i.name}×${i.count} 可烧 ${Math.round(i.count * per)}`);
  }
  for (const s of stock ?? []) {
    if (s.item === input || s.inChests <= 0) continue;
    const per = fuelBurn(s.item);
    if (per <= 0) continue;
    capacity += s.inChests * per;
    fuels.push(`${s.item}×${s.inChests}（箱子）可烧 ${Math.round(s.inChests * per)}`);
  }
  if (capacity <= 0) return `要烧 ${input}×${count}，但背包和箱子里都没有燃料（煤/木炭/木板/原木）`;
  const enough = capacity >= count;
  return `要烧 ${input}×${count}，现有燃料合计能烧约 ${Math.round(capacity)} 件${enough ? '，够' : `，还差约 ${Math.round(count - capacity)}`}（${fuels.slice(0, 3).join('、')}；1 煤=8 件，原版默认）`;
}

/** 最近几段活消耗掉的消耗品（火把/食物/箭/方块），给回想看「出门带没带够」；只报事实，不给结论 */
export function consumptionSummary(lost: Record<string, number>[]): string | null {
  const totals = new Map<string, number>();
  for (const l of lost) for (const [k, v] of Object.entries(l)) {
    if (v > 0 && SUPPLY_PROFILES.some((p) => p.match.test(k))) totals.set(k, (totals.get(k) ?? 0) + v);
  }
  const parts = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`);
  return parts.length ? `最近消耗的消耗品：${parts.join('、')}` : null;
}

export function durabilityFacts(inv: Inv, kinds: string[] = ['pickaxe'], stock?: Stock): string[] {
  const out: string[] = [];
  const combined = withChests(inv, stock);
  for (const kind of kinds) {
    for (const t of inv.filter((i) => i.name.endsWith(`_${kind}`) && i.durability)) {
      const totalLeft = t.durabilities?.length ? t.durabilities.reduce((a, b) => a + b, 0) : t.durability!.left;
      let gap = '';
      try { gap = describePlan(materialPlan(t.name, 1, combined)); } catch { /* 配方未知时略去换料 */ }
      out.push(`${t.name} ×${t.count}，剩余耐久合计 ${totalLeft}（按每挖一格耗 1 耐久，约还能挖 ${totalLeft} 格）${gap ? `；换一把：${gap}` : ''}`);
    }
  }
  return out;
}

/**
 * 控制台「消耗品预算」卡的结构化读数：常驻基线，不看具体意图。
 * 每样消耗品一条：存量 + 单价投影（还能覆盖多少）+ 补货缺口。只报事实，
 * 不替 Agent 判「够不够」（那需要它说出的规模 extent，见 supply-budget.md 分工边界）。
 */
export interface SupplyReading {
  id: string;
  label: string;
  /** 现有数量（支 / 个 / 发 / 块 / 耐久格 / 可烧件数） */
  reserve: number;
  unit: string;
  /** 单价投影 + 补货缺口，一句话 */
  note: string;
  /** 稀缺 / 不足提示：bad = 归零，warn = 偏少 */
  tone: 'ok' | 'warn' | 'bad' | null;
}

export function supplyReading(inv: Inv, opts: { stock?: Stock; torchEvery?: number; difficulty?: AgentState['difficulty'] } = {}): SupplyReading[] {
  const { stock, torchEvery, difficulty } = opts;
  const sum = (re: RegExp) => inv.filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
  const rows: SupplyReading[] = [];

  // 火把：存量 × torch_every = 能照亮多少格；煤/木棍还能直接做多少支
  const torches = sum(/^torch$/);
  const every = torchEvery && torchEvery > 0 ? torchEvery : 8;
  const c = torchCraftable(inv, stock);
  const torchNote = [`约能照亮 ${torches * every} 格暗处`];
  if (c.coal || c.sticks) torchNote.push(`煤/木炭 ${c.coal}、木棍 ${c.sticks}，还能直接做 ${c.craftable} 支`);
  if (difficulty === 'peaceful') torchNote.push('和平没怪，火把只为照明');
  rows.push({ id: 'torch', label: '火把', reserve: torches, unit: '支', note: torchNote.join('；'),
    tone: torches === 0 ? 'bad' : torches <= 4 ? 'warn' : null });

  // 食物：路上能吃的，以及其中能回饱食度的熟食
  const food = sum(FOOD), cooked = sum(/cooked_|bread|baked_potato/);
  rows.push({ id: 'food', label: '食物', reserve: food, unit: '个', note: cooked ? `其中熟食 ${cooked} 个` : '没有熟食',
    tone: food === 0 ? 'bad' : food <= 3 ? 'warn' : null });

  // 箭 / 垫脚方块：per_use，就是存量本身
  const arrows = sum(/arrow$/);
  if (arrows > 0) rows.push({ id: 'arrow', label: '箭', reserve: arrows, unit: '发', note: '', tone: null });
  const blocks = sum(BRIDGE_BLOCKS);
  if (blocks > 0) rows.push({ id: 'blocks', label: '垫脚方块', reserve: blocks, unit: '块', note: '', tone: null });

  // 镐：剩余耐久合计 → 按每挖一格耗 1 耐久估算还能挖多少格；附换一把的材料缺口
  const picks = inv.filter((i) => i.name.endsWith('_pickaxe'));
  if (picks.length) {
    const total = picks.reduce((n, i) => n + (i.durabilities?.length ? i.durabilities.reduce((a, b) => a + b, 0) : i.durability?.left ?? 0), 0);
    const primary = picks.reduce((a, b) => (b.count ?? 1) > (a.count ?? 1) ? b : a);
    let gap = '';
    try { gap = describePlan(materialPlan(primary.name, 1, withChests(inv, stock))); } catch { /* 配方未知略去换料 */ }
    rows.push({ id: 'pickaxe', label: '镐耐久', reserve: total, unit: '格', note: `还能挖约 ${total} 格${gap ? `；换一把：${gap}` : ''}`,
      tone: total === 0 ? 'bad' : total <= 30 ? 'warn' : null });
  }

  // 燃料：现有燃料（背包 + 箱子）合计能烧多少件，不针对某次冶炼
  let capacity = 0; const fuels: string[] = [];
  for (const i of inv) { const per = fuelBurn(i.name); if (per > 0 && i.count > 0) { capacity += i.count * per; fuels.push(`${i.name}×${i.count}`); } }
  for (const s of stock ?? []) { const per = fuelBurn(s.item); if (per > 0 && s.inChests > 0) { capacity += s.inChests * per; fuels.push(`${s.item}×${s.inChests}（箱子）`); } }
  if (capacity > 0) rows.push({ id: 'fuel', label: '燃料', reserve: Math.round(capacity), unit: '件', note: `现有燃料能烧约 ${Math.round(capacity)} 件${fuels.length ? `（${fuels.slice(0, 3).join('、')}）` : ''}`, tone: null });

  return rows;
}

// ---------------------------------------------------------------------------
// 顺手采集与不可替代工具：把「看见什么 + 现在这类料有多少 + 能拿来做啥」摆成中性事实。
// 只测度与查配方，采不采、采多少、做不做备用工具，全部由 Agent 按当前目标和余力权衡（AGENTS.md）。
// ---------------------------------------------------------------------------

/** 矿石 → 主要产物 + 一句客观用途（能做什么）。配方/材料事实，稳定原版知识。 */
const ORE_DEFS: Record<string, { out: string; raw?: string; use: string }> = {
  coal: { out: 'coal', use: '火把/燃料' },
  iron: { out: 'iron_ingot', raw: 'raw_iron', use: '铁工具/盔甲/桶/盾' },
  copper: { out: 'copper_ingot', raw: 'raw_copper', use: '避雷针/望远镜/铜块' },
  gold: { out: 'gold_ingot', raw: 'raw_gold', use: '金苹果/动力铁轨/与猪灵交易' },
  diamond: { out: 'diamond', use: '钻石工具/盔甲/附魔台' },
  redstone: { out: 'redstone', use: '红石机械' },
  lapis: { out: 'lapis_lazuli', use: '附魔' },
  emerald: { out: 'emerald', use: '与村民交易' },
};
const ORE_INFO = new Map<string, { out: string; raw?: string; use: string }>();
for (const [kind, info] of Object.entries(ORE_DEFS)) {
  ORE_INFO.set(`${kind}_ore`, info);
  ORE_INFO.set(`deepslate_${kind}_ore`, info);
}
ORE_INFO.set('nether_gold_ore', ORE_DEFS.gold);
ORE_INFO.set('ancient_debris', { out: 'netherite_scrap', use: '下界合金（配金锭）' });

/** 附近资源里可顺手采集的矿石，最多两块、按距离近的优先。没有可采的矿返回 null。 */
export function oreOpportunityFact(
  resources: readonly { block: string; count: number; nearest: number; dir?: string; seen?: 'now' | 'memory' }[],
  stock: readonly StockRow[] | undefined,
  inventory: readonly { name: string; count: number }[],
): string | null {
  const candidates = resources.filter((r) => ORE_INFO.has(r.block)).sort((a, b) => a.nearest - b.nearest);
  if (!candidates.length) return null;
  const have = (name: string) => {
    const row = stock?.find((s) => s.item === name);
    if (row) return row.total;
    return inventory.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
  };
  const parts = candidates.slice(0, 2).map((r) => {
    const info = ORE_INFO.get(r.block)!;
    const items = [info.out, ...(info.raw ? [info.raw] : [])];
    const haveText = items.map((n) => `${n}×${have(n)}`).join('、');
    return `${r.seen === 'memory' ? '记得' : '看见'}${r.block}×${r.count}（${r.dir ?? ''}${r.nearest}格），现在有 ${haveText}；可做${info.use}`;
  });
  return `顺手采集：${parts.join('；')}（采不采、采多少由你按当前目标和余力权衡）`;
}

/** 有铁/钻石镐、材料又不够再做一把（< 3），且没有「还耐用」的更便宜镐：把工具分级的事实摆出来，做不做备用由 Agent 定。 */
export function toolBackupFact(
  inventory: readonly { name: string; count: number; durability?: { left: number; max: number }; durabilities?: number[] }[],
  stock: readonly StockRow[] | undefined,
): string | null {
  const have = (name: string) => {
    const row = stock?.find((s) => s.item === name);
    if (row) return row.total;
    return inventory.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
  };
  // 有一把「还耐用」的便宜镐（最好那件耐久 ≥ 15%）：不算没得用，别啰嗦；1 点耐久的等于没有
  const hasUsable = (...tiers: string[]) => tiers.some((t) => inventory.some((i) => {
    if (i.name !== `${t}_pickaxe`) return false;
    const d = i.durability;
    if (!d || !d.max) return true; // 没耐久信息：默认当它可用，避免误报
    const best = i.durabilities?.length ? Math.max(...i.durabilities) : d.left;
    return best >= d.max * 0.15;
  }));
  for (const [t, mat, zh, cheap, need] of [
    ['diamond', 'diamond', '钻石', '铁镐或石镐', '远古残骸/黑曜石'] as const,
    ['iron', 'iron_ingot', '铁锭', '石镐（3 圆石 + 2 木棍）', '红石/金/钻石/绿宝石'] as const,
  ]) {
    const owned = inventory.some((i) => i.name === `${t}_pickaxe`);
    if (!owned) continue;
    const n = have(mat);
    if (n >= 3) continue; // 材料还够再做一把，不算紧缺
    if (t === 'diamond' ? hasUsable('iron', 'stone', 'wooden') : hasUsable('stone', 'wooden')) continue;
    return `你包里有${t === 'iron' ? '铁镐' : '钻石镐'}，而${zh}只有 ${n} 个（做一把新的要 3 个）：挖石头/煤/铜/铁/青金石用石镐就够，只有${need}才必须${t === 'iron' ? '铁镐' : '钻石镐'}。要不要先做把${cheap}挖普通方块、把${t === 'iron' ? '铁镐' : '钻石镐'}耐久留给${need}，由你定`;
  }
  return null;
}
