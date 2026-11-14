import type { AgentState, InvItem } from '../adapter/types.ts';
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

/** Agent 写的材料预算 → 按配方与背包+记得的箱子算每项差额；不改数量、不自动采集。 */
export function budgetFacts(needs: readonly { item: string; count: number; why?: string }[], inv: Inv, stock?: Stock): string[] {
  let pool = withChests(inv, stock);
  return needs.flatMap((n) => {
    const have = pool.filter((i) => i.name === n.item).reduce((sum, i) => sum + i.count, 0);
    const plan = materialPlan(n.item, n.count, pool);
    pool = plan.leftover;
    return [`${n.item}×${n.count}${n.why ? `（${n.why}）` : ''}：现有 ${have}；${describePlan(plan)}`];
  });
}

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
    const charcoalNote = c.coal === 0 ? '；火把要煤或木炭，木炭只能烧原木/木头得到，菌柄/菌核不是原木、烧不出木炭' : '';
    const chestNote = (c.chestCoal > 0 || c.chestSticks > 0) ? `（其中箱子里 煤/木炭 ${c.chestCoal}、木棍 ${c.chestSticks}）` : '';
    const spawn = opts.difficulty === 'peaceful' ? '（和平没怪，火把只为照明）' : opts.difficulty ? `（${DIFFICULTY_ZH[opts.difficulty] ?? opts.difficulty}，会刷怪）` : '';
    out.push(`火把 ${torches} 支（torch_every≈${every} → 约能照亮 ${torches * every} 格暗处）${spawn}${craft}${charcoalNote}${chestNote}`);
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

/** 镐的档次从低到高；不同档次能挖的方块不同，材料稀缺时先看更便宜的替代。 */
const PICK_TIERS = ['wooden', 'stone', 'iron', 'diamond'] as const;
type PickTier = typeof PICK_TIERS[number];
/** 原版镐的挖掘速度系数（对应材质的方块，无附魔）。 */
const PICK_SPEED: Record<PickTier, number> = { wooden: 2, stone: 4, iron: 6, diamond: 8 };
const PICK_ZH: Record<PickTier, string> = { wooden: '木镐', stone: '石镐', iron: '铁镐', diamond: '钻石镐' };

/**
 * 工具分级事实：最高档是铁/钻石镐、对应材料稀缺（≤6）时，把「高阶镐还剩多少、
 * 便宜镐有没有/还能不能做/还能挖多少、哪些方块其实不用高阶镐」摆成事实。
 * 换不换、做不做由 Agent 定；只在挖掘时投放。key 供上层状态签名去重。
 */
export function toolTierFact(input: {
  inventory: AgentState['inventory'];
  stock?: readonly StockRow[];
  held?: string | null;
  digging: boolean;
}): { text: string; key: string } | null {
  if (!input.digging) return null;
  const { inventory: inv, stock, held } = input;

  const pickAt = (tier: PickTier) => inv.find((i) => i.name === `${tier}_pickaxe` && i.count > 0);
  const high = [...PICK_TIERS].reverse().find((t) => pickAt(t));
  if (high !== 'iron' && high !== 'diamond') return null;

  // 稀缺材料：箱子账本有这一行就用它（含背包部分），否则按背包合计
  const mat = high === 'iron' ? 'iron_ingot' : 'diamond';
  const scarce = stock?.find((s) => s.item === mat)?.total
    ?? inv.filter((i) => i.name === mat).reduce((n, i) => n + i.count, 0);
  if (scarce > 6) return null; // ≤6 与 frugal 的稀缺线一致

  // durabilities 已按从好到差排列；没有耐久信息时当作可用，避免误报
  const levelsOf = (it: InvItem) => it.durabilities?.length ? it.durabilities : it.durability ? [it.durability.left] : [];
  const maxOf = (it: InvItem) => it.durability?.max ?? 0;
  const usable = (it: InvItem) => {
    const max = maxOf(it), levels = levelsOf(it);
    return !max || !levels.length || Math.max(...levels) >= max * 0.15;
  };
  const durText = (it: InvItem) => {
    const max = maxOf(it), levels = levelsOf(it);
    if (!max || !levels.length) return '耐久未知';
    const best = levels[0], worst = levels.at(-1)!;
    return best === worst ? `耐久 ${best}/${max}` : `耐久最好 ${best}/${max}、最差 ${worst}/${max}`;
  };
  const bucket = (it: InvItem | undefined) => {
    if (!it) return 'none';
    const max = maxOf(it), levels = levelsOf(it);
    if (!max || !levels.length) return 'ok';
    const ratio = Math.max(...levels) / max;
    return ratio < 0.15 ? '<15%' : ratio < 0.5 ? '<50%' : 'ok';
  };

  const highItem = pickAt(high)!;
  const highZh = PICK_ZH[high];
  const candidates = PICK_TIERS.slice(0, PICK_TIERS.indexOf(high)).reverse();
  const combined = withChests(inv, stock);
  const alternatives = candidates.map((tier) => {
    const item = pickAt(tier);
    // 问的是「再做一把」：先把手上同名的（可能快坏的）镐从料池里拿掉，否则 materialPlan 会把
    // 已有那把当成“目标已经够了”，报不出做一把的真实缺口。
    const plan = materialPlan(`${tier}_pickaxe`, 1, combined.filter((i) => i.name !== `${tier}_pickaxe`));
    return { tier, item, plan };
  });
  // 优先用手上还能用的便宜镐；没有就找能现做的一档；手上有快坏的也先摆它；
  // 都没有就默认石镐/铁镐最低档，把“还差什么”如实摆出来——这正是线上“石镐没补”的场景，不能沉默。
  const choice = alternatives.find((a) => a.item && usable(a.item))
    ?? alternatives.find((a) => a.plan.enough)
    ?? alternatives.find((a) => a.item)
    ?? alternatives[0];

  const cheapZh = PICK_ZH[choice.tier];
  const cheapName = `${choice.tier}_pickaxe`;
  // 原版 1.20.1 的镐档：木=石/煤；石=+铜/铁/青金石；铁=+红石/金/钻石/绿宝石；钻石=+远古残骸/黑曜石
  const scope = [
    choice.tier === 'wooden' ? '木镐能挖石头/煤'
      : choice.tier === 'stone' ? '石镐能挖石头/煤/铜/铁/青金石'
        : '铁镐能挖石头/煤/铜/铁/金/青金石/红石/绿宝石/钻石',
    choice.tier === 'wooden' ? '铜/铁/青金石至少要石镐' : null,
    high === 'iron' ? '红石/金/钻石/绿宝石才必须铁镐'
      : choice.tier === 'iron' ? '只有远古残骸/黑曜石才必须钻石镐'
        : '红石/金/钻石/绿宝石至少要铁镐，远古残骸/黑曜石才必须钻石镐',
  ].filter(Boolean).join('；');
  const heldPick = held?.endsWith('_pickaxe') ? held : null;
  const alreadyHeld = heldPick === cheapName;
  // 正拿着不可补的高阶镐在挖：这正是要掂量的时刻，必须单独说清代价（实机：给了铁镐马上换上去挖石头阶梯）
  const heldHigh = heldPick === `${high}_pickaxe`;
  const matZh = high === 'iron' ? '铁锭' : '钻石';
  const parts = [`你包里有${highZh}×${highItem.count}（${durText(highItem)}），${matZh}只剩 ${scarce} 个${scarce < 3 ? `，现在做不出新的${highZh}` : ''}（做一把新的要 3 个）`];
  if (choice.item) {
    const left = levelsOf(choice.item).reduce((a, b) => a + b, 0);
    parts.push(usable(choice.item)
      ? `包里还有${cheapZh}×${choice.item.count}（${durText(choice.item)}，合计还能挖约 ${left} 格）`
      : `包里的${cheapZh}×${choice.item.count}（${durText(choice.item)}）剩余都不足 15%，合计还能挖约 ${left} 格`);
  } else parts.push(`包里没有${cheapZh}`);
  if (heldHigh) parts.push(`现在主手就是${highZh}：每挖一格都耗它 1 点耐久${scarce < 3 ? '，坏了没得补' : ''}`);
  else if (heldPick) parts.push(`现在主手是 ${heldPick}`);
  // 速度是换高阶镐唯一的好处，把它也量化摆出来（原版 1.20.1：石头硬度 1.5，镐速 木2/石4/铁6/钻8，无附魔、站在地上）
  const stoneSecs = (tier: PickTier) => Math.round(1.5 * 1.5 / PICK_SPEED[tier] * 20) / 20;
  parts.push(`挖普通石头每格约：${cheapZh} ${stoneSecs(choice.tier)} 秒、${highZh} ${stoneSecs(high)} 秒（无附魔；深板岩约翻倍）`);
  // 便宜镐能不能补、补一把要什么，是和高阶镐“坏了没得补”对照的关键事实；即使现有便宜镐还可用也报，
  // 否则很容易被理解成“石镐是稀缺备份，留着别用”。
  // 背包和箱子分开算：箱子里有材料不等于现在能做；否则会提示“材料已经够了”，
  // 而 craft 立刻报缺料，Agent 在箱子和合成之间来回空转。
  const bagPlan = materialPlan(`${choice.tier}_pickaxe`, 1, inv.filter((i) => i.name !== `${choice.tier}_pickaxe`));
  const bagGap = bagPlan.raw.map((r) => r.anyWood ? `原木×${r.count}（哪种都行）` : `${r.item}×${r.count}`).join('、');
  const pickPlanText = bagPlan.enough ? describePlan(choice.plan)
    : choice.plan.enough ? `箱子里够，但背包里还差 ${bagGap}；先 take_items 取回再合成`
      : describePlan(choice.plan);
  parts.push(`再做一把${cheapZh}：${pickPlanText}`);
  parts.push(scope);
  // 稀缺材料 < 3 时高阶镐是不可补的；把“哪把坏了没得补、哪把能补”直接对照出来
  if (scarce < 3) parts.push(`${highZh}坏了做不出新的；${cheapZh}坏了能再做`);
  // 已经有便宜镐（哪怕快坏）时也把“怎么用现有这把”说清；主手已经是它就别再叫它去拿
  parts.push(choice.item
    ? `${alreadyHeld ? `主手就是${cheapZh}，直接开挖即可` : `要用现有${cheapZh}就先 hold_item ${cheapName}，或给 mine_cell / excavate_run 写 tool:"${cheapName}"`}。换不换、做不做由你定`
    : '做不做由你定');

  // key 只收“会改变建议”的粗状态：held 只区分“主手是不是镐”而不记具体名字，
  // 避免铁镐/石镐来回换手时同一句提示反复重发；缺口只记缺哪些原料而不记数量。
  const refill = choice.plan.enough ? 'ready' : choice.plan.raw.map((r) => (r.anyWood ? '*log' : r.item)).sort().join(',') || 'unknown';
  const gap = `${choice.item && usable(choice.item) ? 'usable' : 'worn'}:${refill}`;
  const key = [
    `tier:${high}`,
    // 主手换到不可补的高阶镐要重新说一次；便宜镐之间来回换不重发
    `held:${heldHigh ? 'high' : heldPick ? 'pickaxe' : 'none'}`,
    `cheap:${choice.tier}:${choice.item?.count ?? 0}:${bucket(choice.item)}`,
    `high:${highItem.count}:${bucket(highItem)}`,
    `mat:${scarce}`,
    `craft:${gap}`,
  ].join('|');
  return { text: parts.join('；'), key };
}
