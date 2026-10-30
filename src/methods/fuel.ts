/**
 * 燃料燃烧值（原版默认）：一份燃料能烧几件物品。
 * 这是「这世界规则」的默认假设——世界若用数据包/模组改过燃烧值，实测校正另做。
 * 集中在这一处，避免 arbiter / economy / supply 各自写死。
 */

/** 可选燃料（按优先级：煤类 → 木板 → 原木 → 木棍） */
export const FUELS = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];

/** 一份燃料能烧几件物品；不是燃料返回 0 */
export function fuelBurn(fuel: string): number {
  const name = fuel.replace(/^minecraft:/, '');
  if (/^coal_block$/.test(name)) return 80;
  if (/^(coal|charcoal)$/.test(name)) return 8;
  if (/_planks$|_log$/.test(name)) return 1.5;
  if (/^stick$/.test(name)) return 0.5;
  return 0;
}
