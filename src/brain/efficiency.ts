import type { GameAdapter, InvItem } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';

/**
 * 效率洞察（“偷懒”的依据）：根据真实挖掘耗时，估算换一把更好的工具能快多少。
 * 例如：最近空手砍了 8 块原木，平均 3.0 秒/块；做一把木斧约 1.5 秒/块（快 2 倍），石斧约 0.75 秒/块。
 * 只给出数据和建议，做不做由 LLM（或规则目标）权衡。
 */
export interface EfficiencyInsight {
  block: string;
  mined: number;
  avg_s: number;
  tool: string;
  better: { tool: string; est_s: number; speedup: number; have: boolean; materials: string }[];
}

const TIERS = ['wooden', 'stone', 'iron', 'diamond'];
const MATERIAL: Record<string, string> = { wooden: '木板', stone: '圆石', iron: '铁锭', diamond: '钻石' };
const kindFor = (block: string): 'axe' | 'pickaxe' | 'shovel' | null => {
  if (/_log$|_planks$|_wood$|crafting_table|chest|pumpkin|melon/.test(block)) return 'axe';
  if (/stone|_ore$|deepslate|andesite|granite|diorite|tuff|cobble|netherrack|basalt/.test(block)) return 'pickaxe';
  if (/dirt|grass_block|sand|gravel|clay|snow|mud|podzol/.test(block)) return 'shovel';
  return null;
};
const BLOCK_FAMILY = (b: string) => (b.endsWith('_log') ? 'log' : b.replace(/^deepslate_/, ''));

export function efficiencyInsights(adapter: GameAdapter, memory: WorldMemory, inventory: InvItem[]): EfficiencyInsight[] {
  const digs = memory.recentDigs();
  const groups = new Map<string, { block: string; n: number; ms: number; tools: Map<string, number> }>();
  for (const d of digs) {
    const fam = BLOCK_FAMILY(d.block);
    const g = groups.get(fam) ?? { block: d.block, n: 0, ms: 0, tools: new Map<string, number>() };
    g.n++;
    g.ms += d.ms;
    g.tools.set(d.tool ?? '空手', (g.tools.get(d.tool ?? '空手') ?? 0) + 1);
    groups.set(fam, g);
  }
  const has = (n: string) => inventory.some((i) => i.name === n);
  const out: EfficiencyInsight[] = [];
  for (const g of groups.values()) {
    if (g.n < 3) continue;
    const kind = kindFor(g.block);
    if (!kind) continue;
    const avg = g.ms / g.n;
    const tool = [...g.tools].sort((a, b) => b[1] - a[1])[0][0];
    const better: EfficiencyInsight['better'] = [];
    for (const tier of TIERS) {
      const name = `${tier}_${kind}`;
      if (name === tool) continue;
      const est = adapter.digTimeEstimate(g.block, name);
      if (!est) continue;
      const speedup = avg / est;
      if (speedup < 1.4) continue;
      better.push({ tool: name, est_s: Math.round(est / 100) / 10, speedup: Math.round(speedup * 10) / 10, have: has(name), materials: `3 ${MATERIAL[tier]} + 2 木棍` });
      if (better.length >= 2) break;
    }
    if (better.length) out.push({ block: g.block, mined: g.n, avg_s: Math.round(avg / 100) / 10, tool, better });
  }
  return out.sort((a, b) => b.mined - a.mined).slice(0, 4);
}
