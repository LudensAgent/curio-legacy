/** Non-LLM capability check against an explicitly independent, locally owned QA server.
 * The runner never issues server commands or discovers resources outside normal vision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { buildPortal, travelPortal, recallPortal } from '../src/skills/travel.ts';
import { gather } from '../src/skills/work.ts';
import type { Skill, SkillResult } from '../src/skills/types.ts';
import { travelStore } from '../src/travel/store.ts';
import { sleep } from '../src/util.ts';

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const port = Number(option('--port', '25586')), seed = option('--seed', '1729'), attempt = option('--attempt', '1');
if (!Number.isInteger(port) || port === config.mc.port || port !== 25586 || !/^-?\d+$/.test(seed) || !/^\d+$/.test(attempt)) throw new Error('仅允许独立 QA 端口25586和数值 seed/attempt 标签');
const directory = path.resolve('.roadmap-validation', 'portal-seeds', seed);
fs.mkdirSync(directory, { recursive: true });
const bus = new EventBus(), memory = new WorldMemory(path.join(directory, `agent-attempt${attempt}`, 'memory.json'));
const adapter = new MineflayerAdapter({ ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'PortalCheck' },
  memory: { ...config.memory, worldId: `portal-qa:seed:${seed}` }, observerFeed: false, viewerPort: 0 }, bus);
const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 32 });
const controller = new AbortController(), started = Date.now();
const hardLimit = setTimeout(() => { controller.abort('per-seed 240s limit'); adapter.stopAll(); adapter.quit(); }, 240000);
const evidence: Record<string, any> = { seed, attempt, port, started, fixture: { supplied: { obsidian: 10, flint_and_steel: 1, dirt: 32, iron_pickaxe: 1, bread: 8 }, difficulty: 'peaceful', overworldPad: { x: 0, y: 99, z: 0 }, netherTerrainModified: false, llmCalls: 0 }, steps: [] };
process.once('SIGINT', () => { controller.abort('SIGINT'); adapter.stopAll(); adapter.quit(); });
const run = async (skill: Skill, args: unknown, timeoutMs: number) => {
  const validation = skill.validate(args, adapter);
  if (!validation.ok) throw new Error(validation.error);
  const before = adapter.state(), stepStart = Date.now();
  const result = await skill.run({ adapter, memory, senses: vision, bus, signal: controller.signal, deadline: Math.min(started + 240000, Date.now() + timeoutMs),
    taskId: `portal-qa-${skill.name}`, progress: (_value, note) => console.log(JSON.stringify({ event: 'portal_progress', seed, skill: skill.name, note })) }, validation.args);
  evidence.steps.push({ skill: skill.name, args, before, result, after: adapter.state(), durationMs: Date.now() - stepStart });
  console.log(JSON.stringify({ event: 'portal_step', seed, skill: skill.name, result }));
  return result;
};
const requireSuccess = (result: SkillResult) => { if (result.status !== 'succeeded') throw new Error(result.summary); };
try {
  adapter.connect();
  console.log(JSON.stringify({ event: 'portal_fixture_waiting', seed, username: 'PortalCheck', port, supplied: evidence.fixture.supplied, marker: 'lime_wool', pad: '-2,100,4' }));
  while (true) {
    const state = adapter.state(), inventory = new Map(state.inventory.map((i) => [i.name, i.count]));
    if (state.observationReady && state.dim === 'overworld' && Math.hypot(state.pos.x + 2, state.pos.y - 100, state.pos.z - 4) < 2
      && inventory.get('obsidian') === 10 && inventory.get('flint_and_steel') === 1 && inventory.has('lime_wool')) break;
    if (Date.now() - started > 45000) throw new Error('等待独立夹具超时');
    await sleep(100, controller.signal);
  }
  await sleep(750, controller.signal);
  memory.setWorld(adapter.state().worldId);
  evidence.initial = adapter.state();
  const built = await run(buildPortal, { origin: { x: 0, y: 99, z: 0 }, axis: 'x' }, 100000);
  requireSuccess(built);
  if (built.data?.placed !== 10 || adapter.state().inventory.some((i) => i.name === 'obsidian' && i.count !== 0)) throw new Error('没有证实仅消耗10块黑曜石搭建门框');
  const outbound = await run(travelPortal, { portalId: built.data!.portalId }, 45000);
  requireSuccess(outbound);
  if (adapter.state().dim !== 'the_nether') throw new Error('没有实际下界观察');
  const arrivedAt = Date.now();
  // Look around in place, then gather only a block that ordinary vision records.
  for (let turn = 0; turn < 4; turn++) {
    await adapter.look((adapter.eye()?.yaw ?? 0) + Math.PI / 2, -0.2);
    vision.refresh(); await sleep(200, controller.signal);
  }
  evidence.visibleNaturalResources = vision.knownBlocks(['netherrack'], 32);
  if (!evidence.visibleNaturalResources.length) throw new Error('当前视野没有自然下界岩，不能伪造资源采集');
  const beforeNetherrack = adapter.state().inventory.find((i) => i.name === 'netherrack')?.count ?? 0;
  const material = await run(gather, { block: 'netherrack', count: 1 }, 35000);
  requireSuccess(material);
  // The block update can precede the server's dropped-item spawn packet. Do
  // not equate a dig result with inventory: allow one bounded ordinary pickup
  // reconciliation, then require the actual material delta below.
  await sleep(300, controller.signal);
  const collected = await adapter.collectNearbyDrops(controller.signal, 6, 2500);
  await sleep(300, controller.signal);
  evidence.pickupReconciliation = { collected, after: adapter.state() };
  const afterNetherrack = adapter.state().inventory.find((i) => i.name === 'netherrack')?.count ?? 0;
  evidence.naturalMaterialDelta = afterNetherrack - beforeNetherrack;
  if (evidence.naturalMaterialDelta < 1) throw new Error('挖掘返回后没有真实下界岩库存增量');
  // Vanilla portal cooldown is allowed to expire outside the arrival portal.
  await sleep(Math.max(0, 15500 - (Date.now() - arrivedAt)), controller.signal);
  const returned = await run(recallPortal, { returnId: outbound.data!.toId }, 45000);
  requireSuccess(returned);
  evidence.travel = travelStore(memory).snapshot(adapter.state().worldId);
  evidence.returnedMaterialDelta = (adapter.state().inventory.find((i) => i.name === 'netherrack')?.count ?? 0) - beforeNetherrack;
  evidence.pass = adapter.state().dim === 'overworld' && evidence.travel.endpoints.some((e: any) => e.dim === 'the_nether' && e.portalObserved)
    && evidence.travel.routes.length >= 2 && evidence.travel.routes.every((r: any) => r.returnVerified)
    && evidence.naturalMaterialDelta >= 1 && evidence.returnedMaterialDelta >= 1;
  if (!evidence.pass) throw new Error('实际往返或双向路线证据未完成');
} catch (error) { evidence.pass = false; evidence.error = String((error as Error).message ?? error); process.exitCode = 1; }
finally {
  clearTimeout(hardLimit); evidence.finished = Date.now(); evidence.final = adapter.state();
  evidence.travel ??= travelStore(memory).snapshot(adapter.state().worldId);
  const file = path.join(directory, `portal-result-attempt${attempt}.json`); fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(directory, 'portal-result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: 'portal_result', seed, pass: evidence.pass, error: evidence.error, evidence: file, durationMs: Date.now() - started }));
  adapter.stopAll(); memory.close(); adapter.quit();
}
