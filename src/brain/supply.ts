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
    const spawn = opts.difficulty === 'peaceful' ? '（和平没怪，火把只为照明）' : opts.difficulty ? `（${DIFFICULTY_ZH[opts.difficulty] ?? opts.difficulty}，会刷怪，得多备）` : '';
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
