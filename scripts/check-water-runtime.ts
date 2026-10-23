/** Isolated swimming smoke check. No LLM calls, commands, or production world access. */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { surface } from '../src/skills/movement.ts';
import { sleep } from '../src/util.ts';

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const port = Number(option('--port', '25585'));
if (!Number.isInteger(port) || port === config.mc.port || port < 1 || port > 65535) throw new Error('测试端口必须是独立的本地 QA 服务端端口');
const bus = new EventBus(), memory = new WorldMemory(null);
const adapter = new MineflayerAdapter({ ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'WaterCheck' },
  memory: { ...config.memory, worldId: `qa-water:${port}` }, observerFeed: false, viewerPort: 0 }, bus);
const controller = new AbortController();
const trace: unknown[] = [];
let timer: NodeJS.Timeout | undefined;
process.once('SIGINT', () => { controller.abort('SIGINT'); adapter.stopAll(); adapter.quit(); });
try {
  adapter.connect();
  const until = Date.now() + 180000;
  console.log(JSON.stringify({ event: 'water_fixture_waiting', username: 'WaterCheck', port,
    required: '在独立 QA 世界 x76..90,z76..86 建立水深4格、东岸高1格的池塘；将 WaterCheck 放到80.5,60,80.5并给予cyan_wool标记。脚本不执行管理命令。' }));
  while (true) {
    const state = adapter.state();
    if (state.observationReady && state.inWater && state.pos.x > 75 && state.pos.x < 90 && state.pos.z > 75 && state.pos.z < 87 && state.inventory.some((i) => i.name === 'cyan_wool')) break;
    if (Date.now() > until) throw new Error('等待独立水域夹具超时');
    await sleep(100, controller.signal);
  }
  await sleep(750, controller.signal); // let the fixture teleport/chunk packets settle
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 });
  await adapter.look(-Math.PI / 2, -0.1);
  timer = setInterval(() => {
    const state = adapter.state();
    trace.push({ ts: Date.now(), pos: state.pos, oxygen: state.oxygen, inWater: state.inWater, onGround: state.onGround });
  }, 250);
  const before = adapter.state();
  const result = await surface.run({ adapter, memory, bus, senses: vision, signal: controller.signal, deadline: Date.now() + 35000, taskId: 'water-live-check',
    progress: (_value, note) => {
      const state = adapter.state(), eye = adapter.eye();
      console.log(JSON.stringify({ event: 'water_progress', note, pos: state.pos, oxygen: state.oxygen, eye,
        light: eye ? adapter.lightAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) : null,
        knownLand: vision.knownBlocks(['stone', 'grass_block', 'dirt'], 24).slice(0, 5), knownCount: vision.knownCount(), view: vision.summary(state.pos).view }));
    } }, {});
  adapter.stopAll();
  await sleep(3000, controller.signal);
  const after = adapter.state();
  const stableDry = !after.inWater && after.onGround && after.oxygen >= 18;
  const evidence = { before, result, after, stableDry, trace };
  const file = path.resolve('.roadmap-validation', `water-check-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: 'water_result', result, stableDry, after: { pos: after.pos, oxygen: after.oxygen, inWater: after.inWater, onGround: after.onGround }, evidence: file }));
  if (result.status !== 'succeeded' || !stableDry) process.exitCode = 1;
} finally { if (timer) clearInterval(timer); memory.close(); adapter.quit(); }
