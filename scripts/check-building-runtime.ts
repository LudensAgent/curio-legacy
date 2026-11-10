/** Manual, isolated-world smoke check. No LLM requests and no server/operator commands.
 * Prepare the independent server fixture through its console, then run this script.
 * It waits for the operator to provide inventory and teleport BuildCheck to the site.
 */
import path from 'node:path';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { build } from '../src/skills/build.ts';
import { sleep, throwIfAborted } from '../src/util.ts';

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] ?? fallback : fallback; };
const mode = option('--mode', 'doors');
const port = Number(option('--port', '25585'));
const coordinates = option('--origin', '32,64,32').split(',').map(Number);
if (!['doors', 'house'].includes(mode) || !Number.isInteger(port) || port < 1 || port > 65535 || coordinates.length !== 3 || coordinates.some((n) => !Number.isInteger(n))) throw new Error('参数：--mode doors|house --port 25585 --origin 32,64,32');
const origin = { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
const bus = new EventBus();
const adapter = new MineflayerAdapter({ ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'BuildCheck' }, memory: { ...config.memory, worldId: `qa:${port}` }, viewerPort: 0, observerFeed: false }, bus);
const memory = new WorldMemory(path.join(config.dataDir, 'building-runtime-check', `${mode}-${Date.now()}`, 'memory.json'));
const controller = new AbortController();
process.once('SIGINT', () => { controller.abort('SIGINT'); adapter.stopAll(); adapter.quit(); });
try {
  adapter.connect();
  const readyUntil = Date.now() + 60000;
  while (!adapter.state().observationReady) { if (Date.now() > readyUntil) throw new Error('服务器观测就绪超时'); await sleep(200, controller.signal); }
  memory.setWorld(adapter.state().worldId);
  const required: Record<string, number> = mode === 'doors' ? { oak_door: 4 } : { cobblestone: 180, glass: 3, oak_door: 1 };
  const marker = option('--fixture-marker', '');
  if (marker) { if (!/^[a-z][a-z0-9_]+$/.test(marker)) throw new Error('fixture-marker 需要具体物品名'); required[marker] = 1; }
  console.log(JSON.stringify({ event: 'fixture_waiting', username: 'BuildCheck', mode, origin, required, note: '仅在独立测试世界通过服务端控制台准备平地/物资，并将 BuildCheck 传送到现场；脚本不会执行管理命令。' }));
  const fixtureUntil = Date.now() + 180000;
  while (true) {
    throwIfAborted(controller.signal);
    const state = adapter.state(), inventory = new Map(state.inventory.map((i) => [i.name, i.count]));
    if (state.observationReady && Math.hypot(state.pos.x - origin.x, state.pos.y - origin.y, state.pos.z - origin.z) < 12 && Object.entries(required).every(([name, count]) => (inventory.get(name) ?? 0) >= count!)) break;
    if (Date.now() > fixtureUntil) throw new Error('等待独立世界夹具超时');
    await sleep(200, controller.signal);
  }
  await sleep(500, controller.signal);
  if (mode === 'doors') {
    const outcomes: unknown[] = [];
    for (const [i, facing] of ['north', 'east', 'south', 'west'].entries()) {
      const pos = { ...origin, x: origin.x + i * 3 };
      await adapter.moveTo({ kind: 'place_block', pos }, { signal: controller.signal, timeoutMs: 30000 });
      const requested = { facing, half: 'lower', hinge: 'left', open: false };
      const result = await adapter.placeBlockStateAt(pos, 'oak_door', requested, controller.signal);
      const actualLower = adapter.blockStateAt(pos), actualUpper = adapter.blockStateAt({ ...pos, y: pos.y + 1 });
      outcomes.push({ pos, requested, result, actualLower, actualUpper });
      console.log(JSON.stringify({ event: 'door_observed', pos, requested, result, actualLower, actualUpper }));
    }
    if (outcomes.some((outcome: any) => !outcome.result.ok)) process.exitCode = 1;
  } else {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 32 });
    const validation = build.validate({ blueprint: 'hut', origin, rotation: 0 }, adapter);
    if (!validation.ok) throw new Error(validation.error);
    const result = await build.run({ adapter, memory, senses: vision, bus, signal: controller.signal, deadline: Date.now() + 12 * 60000, taskId: 'live-building-check', progress: (value, note) => console.log(JSON.stringify({ event: 'building_progress', value, note })) }, validation.args);
    const observed = adapter.state();
    console.log(JSON.stringify({ event: 'building_result', result, site: { worldId: observed.worldId, dimension: observed.dim, sessionId: observed.sessionId, pos: observed.pos, observationReady: observed.observationReady } }));
    if (result.status !== 'succeeded') process.exitCode = 1;
  }
} finally { memory.close(); adapter.quit(); }
