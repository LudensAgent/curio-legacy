/**
 * 出生点群系的难度分级（1.20.1 主世界）。按这个 AI 开局要的东西打分：
 * 木头（工具、木板、床架）、羊（羊毛做床）和别的被动生物（吃的）、平整的地（盖房）、露出来的石头（石器）、水，
 * 以及危险（冻、摔、迷路、怪多、一眼望不到树）。
 *
 *  easy    树多、动物多、地平：平原、森林、桦木林、繁花森林、草甸、樱花林
 *  normal  能活但要多费点劲：针叶林（树多羊少、坡多）、热带草原、黑森林（白天也暗、刷怪）、沼泽、河边、海滩、稀疏丛林、丛林
 *  hard    缺一样关键资源或地形很难走：沙漠、恶地（没树没羊）、雪原和雪林（冻、动物少）、竹林、红树林沼泽、风袭丘陵、雪坡、雪林地、石岸
 *  extreme 开局几乎什么都没有：冰刺、山峰、蘑菇岛（没树）、海洋、洞穴群系
 */
export type SpawnTier = 'easy' | 'normal' | 'hard' | 'extreme';
export const TIERS: SpawnTier[] = ['easy', 'normal', 'hard', 'extreme'];

export const BIOME_TIER: Record<string, SpawnTier> = {
  plains: 'easy', sunflower_plains: 'easy', forest: 'easy', flower_forest: 'easy', birch_forest: 'easy', old_growth_birch_forest: 'easy', meadow: 'easy', cherry_grove: 'easy',
  taiga: 'normal', old_growth_pine_taiga: 'normal', old_growth_spruce_taiga: 'normal', savanna: 'normal', savanna_plateau: 'normal', dark_forest: 'normal', swamp: 'normal',
  river: 'normal', beach: 'normal', sparse_jungle: 'normal', jungle: 'normal', windswept_forest: 'normal',
  desert: 'hard', badlands: 'hard', eroded_badlands: 'hard', wooded_badlands: 'hard', snowy_plains: 'hard', snowy_taiga: 'hard', bamboo_jungle: 'hard', mangrove_swamp: 'hard',
  windswept_hills: 'hard', windswept_gravelly_hills: 'hard', windswept_savanna: 'hard', grove: 'hard', snowy_slopes: 'hard', stony_shore: 'hard', snowy_beach: 'hard', frozen_river: 'hard',
  ice_spikes: 'extreme', frozen_peaks: 'extreme', jagged_peaks: 'extreme', stony_peaks: 'extreme', mushroom_fields: 'extreme',
  ocean: 'extreme', deep_ocean: 'extreme', warm_ocean: 'extreme', lukewarm_ocean: 'extreme', deep_lukewarm_ocean: 'extreme', cold_ocean: 'extreme', deep_cold_ocean: 'extreme',
  frozen_ocean: 'extreme', deep_frozen_ocean: 'extreme', dripstone_caves: 'extreme', lush_caves: 'extreme', deep_dark: 'extreme',
};
export const ALL_BIOMES = Object.keys(BIOME_TIER);

export const TIER_LABEL: Record<SpawnTier, string> = { easy: '简单', normal: '普通', hard: '困难', extreme: '极难' };

export interface SpawnFilter {
  /** 接受的群系（空 = 不筛选） */
  accept: Set<string>;
  /** 说明（给日志看） */
  describe: string;
}

/**
 * 读配置：WORLD_SPAWN_BIOMES（逗号分隔的群系名，优先）或 WORLD_SPAWN_DIFFICULTY（easy|normal|hard|extreme|any，可以逗号写几档）。
 */
export function spawnFilter(difficulty: string, biomes: string): SpawnFilter {
  const list = biomes.split(',').map((s) => s.trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean);
  if (list.length) {
    const bad = list.filter((b) => !BIOME_TIER[b]);
    if (bad.length) throw new Error(`WORLD_SPAWN_BIOMES 里有不认识的群系：${bad.join('、')}（可用：${ALL_BIOMES.join(', ')}）`);
    return { accept: new Set(list), describe: `指定群系：${list.join('、')}` };
  }
  const tiers = difficulty.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!tiers.length || tiers.includes('any')) return { accept: new Set(), describe: '不筛选出生点' };
  const bad = tiers.filter((t) => !TIERS.includes(t as SpawnTier));
  if (bad.length) throw new Error(`WORLD_SPAWN_DIFFICULTY 只能是 easy / normal / hard / extreme / any（可以逗号写几档），不认识：${bad.join('、')}`);
  const accept = new Set(ALL_BIOMES.filter((b) => tiers.includes(BIOME_TIER[b])));
  return { accept, describe: `出生难度 ${tiers.map((t) => `${t}（${TIER_LABEL[t as SpawnTier]}）`).join('、')}` };
}

/** 没筛到时挑最接近的：和想要的档位差得最少的那个 */
export function tierDistance(biome: string, filter: SpawnFilter): number {
  if (!filter.accept.size || filter.accept.has(biome)) return 0;
  const want = [...filter.accept].map((b) => TIERS.indexOf(BIOME_TIER[b]));
  const have = TIERS.indexOf(BIOME_TIER[biome] ?? 'extreme');
  return Math.min(...want.map((w) => Math.abs(w - have))) + 0.5;
}
