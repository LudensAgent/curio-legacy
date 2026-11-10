/** NON-LLM physics audit, restricted to the explicitly owned localhost QA server.
 * Fixture commands belong to the operator, never to this runner or a product skill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { sleep } from '../src/util.ts';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1] ?? fallback; };
const port = Number(option('--port', '25586'));
const attempt = option('--attempt', String(Date.now()));
if (port !== 25586 || port === config.mc.port || !/^[\w-]+$/.test(attempt)) throw new Error('Only independent QA port 25586 and a simple attempt label are allowed');
const directory = path.resolve('.roadmap-validation', 'ballistics');
fs.mkdirSync(directory, { recursive: true });
const adapter = new MineflayerAdapter({ ...config, mc: { ...config.mc, host: '127.0.0.1', port, username: 'BallisticsCheck' },
  memory: { ...config.memory, worldId: 'qa:crystal-ballistics' }, observerFeed: false, viewerPort: 0 }, new EventBus());
const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 64 });
const controller = new AbortController(), started = Date.now();
const evidence: Record<string, any> = { started, port, llmCalls: 0, fixture: { groundFeet: 100, crystalFeet: 135, cage: '5x5 perimeter y135..137, complete roof y138; no removed bars' }, cases: [], events: [], packets: [] };
const hardLimit = setTimeout(() => { controller.abort('180s audit limit'); adapter.stopAll(); adapter.quit(); }, 180000);
process.once('SIGINT', () => { controller.abort('SIGINT'); adapter.stopAll(); adapter.quit(); });
const arrows = () => adapter.state().inventory.filter(i => ['arrow', 'spectral_arrow', 'tipped_arrow'].includes(i.name)).reduce((n, i) => n + i.count, 0);
const eventFor = (id: number) => evidence.events.filter((e: any) => e.id === id);
const aimAndObserve = async (at: Vec3Like) => {
  const eye = adapter.eye(); if (!eye) throw new Error('No current eye');
  const dx = at.x - eye.x, dz = at.z - eye.z;
  await adapter.look(Math.atan2(-dx, -dz), Math.atan2(at.y + 1 - eye.y, Math.hypot(dx, dz)));
  await sleep(200, controller.signal);
  vision.scan();
  return vision.perceivedEntities(48).filter(e => e.name === 'end_crystal' && e.perception === 'seen'
    && Math.hypot(e.pos.x - at.x, e.pos.y - at.y, e.pos.z - at.z) < 2);
};
const move = async (x: number, z: number) => {
  await adapter.moveTo({ kind: 'xz', x, z, range: 0.7 }, { signal: controller.signal, timeoutMs: 18000 });
  await sleep(250, controller.signal);
};
const shotCase = async (name: string, at: Vec3Like, shots: number) => {
  const entry: Record<string, any> = { name, at, position: adapter.state().pos, beforeArrows: arrows(), shots: [] };
  evidence.cases.push(entry);
  for (let i = 0; i < shots; i++) {
    const seen = await aimAndObserve(at);
    entry.seenProof = { at: Date.now(), worldId: adapter.state().worldId, sessionId: adapter.state().sessionId, observationId: adapter.state().observationId, entities: seen };
    if (!seen.length) { entry.outcome = i ? 'NO_LONGER_SEEN' : 'NOT_SEEN'; break; }
    const id = seen[0].id, beforeArrows = arrows(), timestamp = Date.now();
    const result = await adapter.rangedAttack(id, controller.signal);
    await sleep(3500, controller.signal);
    const afterArrows = arrows(), events = eventFor(id), tracked = !!adapter.bot?.entities[id]?.isValid;
    const shot = { id, timestamp, result, beforeArrows, afterArrows, spent: beforeArrows - afterArrows, events, tracked };
    entry.shots.push(shot);
    console.log(JSON.stringify({ event: 'crystal_shot', name, ...shot }));
    if (result.reason === 'BLOCKED_AIM') {
      if (beforeArrows !== afterArrows) throw new Error(`${name}: blocked aim spent an arrow`);
      entry.outcome = 'BLOCKED_AIM'; break;
    }
    if (!result.ok) { entry.outcome = result.reason; break; }
    if (!tracked && events.some((e: any) => e.event === 'entityGone' || e.event === 'entityDead')) {
      entry.outcome = 'ENTITY_REMOVED_AFTER_SHOT'; break;
    }
    entry.outcome = 'SHOT_WITHOUT_REMOVAL_PROOF';
  }
  entry.afterArrows = arrows();
  console.log(JSON.stringify({ event: 'crystal_case', ...entry }));
  return entry;
};
try {
  adapter.connect();
  console.log(JSON.stringify({ event: 'crystal_fixture_waiting', username: 'BallisticsCheck', port, marker: 'magenta_wool', spawn: { x: 0.5, y: 100, z: -22.5 } }));
  while (true) {
    const s = adapter.state();
    if (s.observationReady && s.dim === 'overworld' && Math.abs(s.pos.y - 100) < 1
      && s.inventory.some(i => i.name === 'magenta_wool') && s.inventory.some(i => i.name === 'bow') && arrows() >= 16) break;
    if (Date.now() - started > 45000) throw new Error('Fixture was not ready within 45 seconds');
    await sleep(100, controller.signal);
  }
  await sleep(750, controller.signal);
  const bot = adapter.bot;
  for (const event of ['entityGone', 'entityDead']) bot.on(event, (entity: any) => {
    if (entity.name === 'end_crystal') evidence.events.push({ event, id: entity.id, name: entity.name, at: Date.now(), pos: { ...entity.position } });
  });
  // Audit only these non-sensitive outgoing action packets; keep the existing
  // guarded writer intact and never install another cancellation implementation.
  const write = bot._client.write.bind(bot._client);
  let onDraw: (() => void) | undefined;
  bot._client.write = (name: string, data: any) => {
    if (['use_item', 'held_item_slot'].includes(name) || name === 'block_dig' && data.status === 5) {
      evidence.packets.push({ name, at: Date.now(), status: data.status, slotId: data.slotId });
      if (name === 'use_item') onDraw?.();
    }
    return write(name, data);
  };
  evidence.initial = adapter.state();
  await move(0.5, -22.5);
  const exposed = await shotCase('exposed_35_above_ground', { x: 0.5, y: 135, z: 0.5 }, 3);

  await move(-20.5, -22.5);
  const cancelAt = { x: -20.5, y: 135, z: 0.5 }, seen = await aimAndObserve(cancelAt);
  const cancellation: Record<string, any> = { name: 'cancel_1s_draw_and_swap', position: adapter.state().pos, seenProof: seen, beforeArrows: arrows() };
  evidence.cases.push(cancellation);
  if (!seen.length) throw new Error('Cancellation crystal was not actually seen');
  const shotController = new AbortController();
  let drew = false;
  const drawn = new Promise<void>(resolve => { onDraw = () => { drew = true; onDraw = undefined; resolve(); }; });
  const attack = adapter.rangedAttack(seen[0].id, shotController.signal).then(result => ({ result }), error => ({ error: String(error?.message ?? error) }));
  await Promise.race([drawn, sleep(2500, controller.signal)]);
  if (!drew) throw new Error('The cancellation case never started drawing');
  cancellation.drawnAt = Date.now();
  await sleep(1000, controller.signal);
  cancellation.stoppedAt = Date.now();
  adapter.stopAll(); shotController.abort('QA cancel after one second of actual drawing');
  cancellation.equip = await adapter.equipItem('stone_sword', 'hand', controller.signal);
  cancellation.attack = await attack;
  await sleep(3000, controller.signal);
  cancellation.afterArrows = arrows();
  cancellation.events = eventFor(seen[0].id);
  cancellation.tracked = !!bot.entities[seen[0].id]?.isValid;
  cancellation.pass = cancellation.beforeArrows === cancellation.afterArrows && cancellation.tracked && adapter.state().held === 'stone_sword';
  console.log(JSON.stringify({ event: 'crystal_cancel', ...cancellation }));

  await move(20.5, -22.5);
  const cageFront = await shotCase('closed_cage_front_ground', { x: 20.5, y: 135, z: 0.5 }, 1);
  await move(42.5, 0.5);
  const cageSide = await shotCase('closed_cage_side_ground', { x: 20.5, y: 135, z: 0.5 }, 1);
  evidence.capabilities = { exposedRemoved: exposed.outcome === 'ENTITY_REMOVED_AFTER_SHOT', cancelledWithoutArrow: cancellation.pass,
    cageGroundDestroyed: [cageFront, cageSide].some(c => c.outcome === 'ENTITY_REMOVED_AFTER_SHOT'),
    cageGroundOutcomes: [cageFront.outcome, cageSide.outcome] };
  evidence.pass = evidence.capabilities.exposedRemoved && cancellation.pass;
  if (!evidence.pass) process.exitCode = 1;
} catch (error) { evidence.pass = false; evidence.error = String((error as Error).message ?? error); process.exitCode = 1; }
finally {
  clearTimeout(hardLimit); onCleanup();
}
function onCleanup() {
  evidence.finished = Date.now(); evidence.final = adapter.state();
  const file = path.join(directory, `crystal-result-${attempt}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: 'crystal_result', pass: evidence.pass, error: evidence.error, capabilities: evidence.capabilities, evidence: file, durationMs: Date.now() - started }));
  adapter.stopAll(); adapter.quit();
}
