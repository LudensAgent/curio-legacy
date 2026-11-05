import type { GameAdapter, InvItem } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { StockRow } from '../memory/chest-memory.ts';

/**
 * 效率洞察（"偷懒 / 抠门"的依据）：给出两个方向的取舍——
 * - better：换一把更快的工具能快多少（省时间）
 * - cheaper：换一把更便宜的工具只慢多少、省下什么稀缺材料（省资源）
 * avg_s 用实测中位（去首挖离群），快慢倍数按「理论耗时比」（延迟相互抵消，不被网络/走位延迟夸大）；
 * 只给数据和建议，做不做由 LLM（或规则目标）权衡。
 */
export interface EfficiencyInsight {
  block: string;
  mined: number;
  avg_s: number;
  tool: string;
  better: { tool: string; est_s: number; speedup: number; have: boolean; materials: string }[];
  cheaper: { tool: string; est_s: number; slowdown: number; savesItem: string; savesZh: string; have: boolean }[];
}

const TIERS = ['wooden', 'stone', 'iron', 'diamond'];
const MATERIAL: Record<string, string> = { wooden: '木板', stone: '圆石', iron: '铁锭', diamond: '钻石' };
/** 材料的物品注册名（用于查库存算稀缺度） */
const MATERIAL_ITEM: Record<string, string> = { wooden: 'stick', stone: 'cobblestone', iron: 'iron_ingot', diamond: 'diamond' };
const kindFor = (block: string): 'axe' | 'pickaxe' | 'shovel' | null => {
  if (/_log$|_planks$|_wood$|crafting_table|chest|pumpkin|melon/.test(block)) return 'axe';
  if (/stone|_ore$|deepslate|andesite|granite|diorite|tuff|cobble|netherrack|basalt/.test(block)) return 'pickaxe';
  if (/dirt|grass_block|sand|gravel|clay|snow|mud|podzol/.test(block)) return 'shovel';
  return null;
};
const BLOCK_FAMILY = (b: string) => (b.endsWith('_log') ? 'log' : b.replace(/^deepslate_/, ''));
const tierOf = (tool: string) => TIERS.findIndex((t) => tool.startsWith(t));

export function efficiencyInsights(adapter: GameAdapter, memory: WorldMemory, inventory: InvItem[]): EfficiencyInsight[] {
  // 寻路/外部挖的方块没有实测耗时（ms<=0），不参与效率估算；分组键带上工具，
  // 否则同族里 iron@500 与 stone@750 会混在一起，用“多数工具”配“混合中位”，算错快慢倍数。
  const digs = memory.recentDigs().filter((d) => d.ms > 0);
  const groups = new Map<string, { block: string; tool: string; times: number[] }>();
  for (const d of digs) {
    const tool = d.tool ?? '空手';
    const key = `${BLOCK_FAMILY(d.block)}|${tool}`;
    const g = groups.get(key) ?? { block: d.block, tool, times: [] };
    g.times.push(d.ms);
    groups.set(key, g);
  }
  const has = (n: string) => inventory.some((i) => i.name === n);
  const out: EfficiencyInsight[] = [];
  for (const g of groups.values()) {
    if (g.times.length < 3) continue;
    const kind = kindFor(g.block);
    if (!kind) continue;
    // 用中位而非平均：首挖常含接近/走位，一个离群样本会把均值抬高（日志里出现过 5.6s 的首挖）
    const sorted = [...g.times].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const avg = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const tool = g.tool;
    // 快慢倍数按「理论耗时比」算：当前工具的 estCur 与候选 est 同为理论值，延迟相互抵消，
    // 不把网络/走位延迟算进「快多少倍」。空手/挖不动时退回实测中位。
    const estCur = adapter.digTimeEstimate(g.block, tool === '空手' ? null : tool) ?? avg;
    const better: EfficiencyInsight['better'] = [];
    for (const tier of TIERS) {
      const name = `${tier}_${kind}`;
      if (name === tool) continue;
      const est = adapter.digTimeEstimate(g.block, name);
      if (!est) continue;
      const speedup = estCur / est;
      if (speedup < 1.4) continue;
      better.push({ tool: name, est_s: Math.round(est / 100) / 10, speedup: Math.round(speedup * 10) / 10, have: has(name), materials: `3 ${MATERIAL[tier]} + 2 木棍` });
      if (better.length >= 2) break;
    }
    // 抠门：用铁/钻石这类稀缺材料挖方块时，换低一级的工具只慢一点，却能不耗稀缺材料
    const cheaper: EfficiencyInsight['cheaper'] = [];
    const curTier = tierOf(tool);
    if (curTier >= 2) {
      for (let t = curTier - 1; t >= 0; t--) {
        const name = `${TIERS[t]}_${kind}`;
        const est = adapter.digTimeEstimate(g.block, name);
        if (!est) continue;
        const slowdown = est / estCur;
        if (slowdown > 2) continue;
        cheaper.push({ tool: name, est_s: Math.round(est / 100) / 10, slowdown: Math.round(slowdown * 10) / 10, savesItem: MATERIAL_ITEM[TIERS[curTier]], savesZh: MATERIAL[TIERS[curTier]], have: has(name) });
        break;
      }
    }
    if (better.length || cheaper.length) out.push({ block: g.block, mined: g.times.length, avg_s: Math.round(avg / 100) / 10, tool, better, cheaper });
  }
  return out.sort((a, b) => b.mined - a.mined).slice(0, 4);
}

/** 把一条效率洞察说成事实（更快/更省两个方向 + 稀缺度），不处方；由调用方决定怎么摆进提示词。
 * `totals` 是精确账本的总表（箱子+背包）：给出来就把箱子里的也算进去，并按「最后打开时」诚实标注；不给就只看背包。 */
export function effortFacts(e: EfficiencyInsight, inventory: { name: string; count: number }[], totals?: readonly StockRow[]): string[] {
  const count = (item: string) => inventory.filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);
  const facts = [`最近用${e.tool}挖了 ${e.mined} 个 ${e.block}，实测约 ${e.avg_s} 秒/个`];
  for (const b of e.better.slice(0, 1)) facts.push(`${b.tool} 约 ${b.est_s} 秒/个（快 ${b.speedup} 倍${b.have ? '，已有' : `，做一把要 ${b.materials}`}）`);
  for (const c of e.cheaper.slice(0, 1)) {
    const row = totals?.find((t) => t.item === c.savesItem);
    const scarce = row && row.inChests > 0
      ? `背包 ${row.inBackpack} 个、箱子里 ${row.inChests} 个（共 ${row.total} 个，按最后打开时记）`
      : `背包 ${row?.total ?? count(c.savesItem)} 个`;
    facts.push(`${c.tool} 约 ${c.est_s} 秒/个（慢 ${Math.round((c.slowdown - 1) * 100)}%），但不耗${c.savesZh}（${scarce}）`);
  }
  return facts;
}
