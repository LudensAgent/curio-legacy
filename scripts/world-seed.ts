/**
 * npm run world:seed：给还没生成的新世界挑种子（按 .env 的 WORLD_SPAWN_DIFFICULTY / WORLD_SPAWN_BIOMES / WORLD_SEED）。
 * 先停掉 Minecraft 服务器；地图目录已经存在时拒绝（先 npm run agents:new 或 memory:reset）。
 * npm run world:seed -- --tiers 打印群系难度表。
 */
import { fileURLToPath } from 'node:url';
import { config, requireLocalMode } from '../src/config.ts';
import { assertResetOffline } from '../src/maintenance/offline.ts';
import { inspectWorldReset } from '../src/maintenance/world-reset.ts';
import { BIOME_TIER, TIER_LABEL, TIERS } from '../src/seeds/biome-tiers.ts';
import { prepareNewWorld } from '../src/seeds/new-world.ts';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
try {
  if (process.argv.includes('--tiers')) {
    for (const t of TIERS) console.log(`${t}（${TIER_LABEL[t]}）：${Object.entries(BIOME_TIER).filter(([, v]) => v === t).map(([b]) => b).join(', ')}`);
  } else {
    requireLocalMode('世界种子筛选');
    const serverDir = config.serverDir;
    const plan = inspectWorldReset(serverDir, projectDir);
    await assertResetOffline([{ host: plan.serverHost, port: plan.serverPort, label: 'Minecraft 服务器' }]);
    await prepareNewWorld({ serverDir, projectDir, rcon: { host: config.observer.rconHost, port: config.observer.rconPort, password: config.observer.rconPassword } }, (s) => console.log(`· ${s}`));
  }
} catch (e: any) {
  console.error(`挑种子失败：${e?.message ?? e}`);
  process.exitCode = 1;
}
