import path from 'node:path';
import { spawnFilter } from './biome-tiers.ts';
import { pickSeed, setLevelSeed, type SeedPick } from './seed-picker.ts';

/**
 * 新世界的种子（.env）：
 * - WORLD_SEED：固定种子，直接用，不筛
 * - WORLD_SPAWN_BIOMES：只接受这些出生群系（逗号分隔，优先于难度）
 * - WORLD_SPAWN_DIFFICULTY：easy | normal | hard | extreme | any（可以逗号写几档）
 * - WORLD_REQUIRE_VILLAGE：true 时出生点 WORLD_VILLAGE_RADIUS（默认 512）格内必须有村庄（强制，难度可以退而求其次，村庄不行）
 * - WORLD_SEED_TRIES：最多试几个种子
 * - SERVER_DIR / SERVER_JAR / SERVER_JAVA / SERVER_JAVA_ARGS：试种子时怎么启动服务端
 */
export interface NewWorldEnv { serverDir: string; projectDir: string; rcon: { host: string; port: number; password: string } }

export function seedSettings(env: NodeJS.ProcessEnv = process.env) {
  const v = (k: string, d = '') => (env[k] ?? d).trim();
  const tries = Number(v('WORLD_SEED_TRIES', '8'));
  const requireVillage = /^(1|true|yes|on)$/i.test(v('WORLD_REQUIRE_VILLAGE', 'false'));
  const radius = Number(v('WORLD_VILLAGE_RADIUS', '512'));
  if (requireVillage && (!Number.isInteger(radius) || radius < 32 || radius > 1600)) throw new Error('WORLD_VILLAGE_RADIUS 要是 32–1600 的整数（格）');
  return {
    villageWithin: requireVillage ? radius : 0,
    seed: v('WORLD_SEED'),
    filter: spawnFilter(v('WORLD_SPAWN_DIFFICULTY', 'any'), v('WORLD_SPAWN_BIOMES')),
    tries: Number.isInteger(tries) && tries >= 1 && tries <= 50 ? tries : 8,
    java: v('SERVER_JAVA', 'java'),
    javaArgs: v('SERVER_JAVA_ARGS', '-Xmx2G').split(/\s+/).filter(Boolean),
    jar: v('SERVER_JAR') || undefined,
  };
}

export function defaultServerDir(projectDir: string, env: NodeJS.ProcessEnv = process.env) {
  return path.resolve(projectDir, (env.SERVER_DIR ?? '').trim() || 'world');
}

/** 给一个刚清空、还没生成的新世界定种子：固定种子直接写；配了出生难度/群系就试种子；都没配就保持随机 */
export async function prepareNewWorld(w: NewWorldEnv, log: (s: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env): Promise<SeedPick | { seed: string } | null> {
  const s = seedSettings(env);
  if (s.seed) {
    if (!/^-?\d{1,20}$/.test(s.seed) && /[\r\n=:\\]/.test(s.seed)) throw new Error('WORLD_SEED 不能含换行、=、: 或 \\');
    setLevelSeed(w.serverDir, s.seed);
    log(`新世界用固定种子 ${s.seed}（WORLD_SEED）`);
    return { seed: s.seed };
  }
  if (!s.filter.accept.size && !s.villageWithin) { log('新世界随机种子（没配出生难度、群系或村庄要求）'); return null; }
  log(`按「${s.filter.describe}」${s.villageWithin ? `、出生点 ${s.villageWithin} 格内必须有村庄` : ''}挑种子，最多试 ${s.tries} 个（每个要启动一次服务端，几十秒）`);
  const pick = await pickSeed({ serverDir: w.serverDir, projectDir: w.projectDir, filter: s.filter, villageWithin: s.villageWithin || undefined, tries: s.tries, java: s.java, javaArgs: s.javaArgs, jar: s.jar, rcon: w.rcon, log });
  const v = pick.village ? `，村庄在 ${pick.village.dist} 格外 (${pick.village.x},${pick.village.z})` : '';
  log(pick.matched ? `选中种子 ${pick.seed}：出生在 ${pick.biome}${v}，世界已经生成好了` : `没有完全符合的，用 ${pick.seed}（${pick.biome}${v}）`);
  return pick;
}
