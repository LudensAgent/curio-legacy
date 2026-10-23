/** Isolated-server geometry check. Uses only ShelterCheck's provided inventory
 * and ordinary game actions; no LLM calls or server/operator commands. */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { shelter } from '../src/skills/survival.ts';
import { sleep, throwIfAborted } from '../src/util.ts';

const port = Number(process.env.AGENT_REVIEW_PORT ?? 25585);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid QA port');
const origin = { x: 104, y: 64, z: 104 };
const dataDir = path.resolve('.roadmap-validation');
const directory = path.join(dataDir, 'shelter-check');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `shelter-${Date.now()}.json`);
const bus = new EventBus(), memory = new WorldMemory(null);
const adapter = new MineflayerAdapter({ ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'ShelterCheck' }, memory: { ...config.memory, provider: 'local', worldId: `qa:${port}` }, dataDir, viewerPort: 0, observerFeed: false }, bus);
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240000)]);
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), origin, port, username: 'ShelterCheck' };
const progress: unknown[] = [];
const column = () => [4, 3, 2, 1, 0].map((dy) => ({ pos: { ...origin, y: origin.y - dy }, name: adapter.blockAt({ ...origin, y: origin.y - dy }) }));
process.once('SIGINT', () => controller.abort('SIGINT'));

try {
  adapter.connect();
  const readyBy = Date.now() + 30000;
  while (!adapter.state().observationReady) {
    if (Date.now() >= readyBy) throw new Error('No ready QA observation');
    await sleep(200, signal);
  }
  console.log(JSON.stringify({ event: 'shelter_fixture_waiting', username: 'ShelterCheck', origin, marker: 'purple_wool', required: { dirt: 1, purple_wool: 1 }, hp: 20, note: '等待独立世界夹具：四层安全实心地基、可挖脚下三层的工具，角色位于目标列中心；发放紫色羊毛后开始。' }));
  const fixtureReady = () => {
    const state = adapter.state();
    return state.observationReady && state.onGround && state.hp >= 20 && !state.inWater && !state.inLava
      && Math.floor(state.pos.x) === origin.x && Math.floor(state.pos.z) === origin.z && Math.abs(state.pos.y - origin.y) < 0.1
      && ['dirt', 'purple_wool'].every((name) => state.inventory.some((item) => item.name === name && item.count > 0))
      && [1, 2, 3].every((dy) => adapter.canHarvest({ ...origin, y: origin.y - dy }));
  };
  const fixtureBy = Date.now() + 180000;
  while (!fixtureReady()) {
    throwIfAborted(signal);
    if (Date.now() >= fixtureBy) throw new Error('Shelter fixture timeout');
    await sleep(200, signal);
  }
  await sleep(500, signal);
  if (!fixtureReady()) throw new Error('Shelter fixture changed during settling');
  memory.setWorld(adapter.state().worldId);
  evidence.before = adapter.state();
  evidence.beforeColumn = column();
  const result = await shelter.run({ adapter, memory, bus, signal, taskId: 'live-shelter-check', deadline: Date.now() + 90000,
    senses: { knownBlocks: () => [], perceivedEntities: () => [], refresh() {}, markSweep() {} },
    progress: (value, note) => { const entry = { ts: Date.now(), value, note }; progress.push(entry); console.log(JSON.stringify({ event: 'shelter_progress', ...entry })); },
  }, { until: 'healed' });
  const after = adapter.state();
  const verified = result.status === 'succeeded' && after.onGround && Math.abs(after.pos.y - (origin.y - 3)) < 0.1
    && after.hp >= 18 && !after.inWater && !after.inLava && adapter.blockAt({ ...origin, y: origin.y - 1 }) === 'dirt'
    && [2, 3].every((dy) => ['air', 'cave_air'].includes(adapter.blockAt({ ...origin, y: origin.y - dy }) ?? ''));
  Object.assign(evidence, { result, after, afterColumn: column(), verified });
  console.log(JSON.stringify({ event: 'shelter_result', result, after, column: evidence.afterColumn, verified, evidence: file }));
  if (!verified) process.exitCode = 1;
} catch (error) {
  evidence.error = { name: (error as Error).name, message: (error as Error).message };
  console.error(JSON.stringify({ event: 'shelter_error', error: evidence.error, evidence: file }));
  process.exitCode = 1;
} finally {
  Object.assign(evidence, { endedAt: new Date().toISOString(), progress, events: bus.recent(300) });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  controller.abort();
  memory.close();
  adapter.quit();
}
