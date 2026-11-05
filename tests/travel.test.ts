import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { equipmentSkills } from '../src/skills/equipment.ts';
import { SKILLS } from '../src/skills/index.ts';
import { travelSkills, useEndGateway } from '../src/skills/travel.ts';
import { travel } from '../src/skills/overland.ts';
import { TravelStore, travelStore } from '../src/travel/store.ts';
import { AbortedError, sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

Object.assign(SKILLS, travelSkills, equipmentSkills);
const setup = () => {
  const adapter = new FakeAdapter();
  adapter.speed = 1000;
  const memory = new WorldMemory(null);
  const bus = new EventBus();
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const run = (skill: string, args: unknown = {}) => {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill, args }, 'llm');
    if ('error' in started) throw new Error(started.error);
    return done;
  };
  return { adapter, memory, bus, vision, arbiter, run };
};

test('build_portal places exactly ten obsidian and records only the activated portal observation', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.blocks.filter((b) => b.name === 'obsidian').length, 10);
  assert.equal(adapter.inv.get('obsidian'), 0);
  const snapshot = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(snapshot.endpoints.length, 1);
  assert.equal(snapshot.endpoints[0].portalObserved, true);
  assert.equal(adapter.blockAt(snapshot.endpoints[0].pos), 'nether_portal');
  assert.deepEqual(snapshot.routes, []);
});

test('a refused ignition cannot produce a successful portal record', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.useBlockAt = async () => ({ ok: false, reason: 'NO_FIRE' });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).endpoints, []);
});

test('build_portal on a suspended base fills the gap with scaffold first', async () => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 20);
  // 底座中间两列下方挖空（斜坡悬空），应先用脚手架垫平再立框
  adapter.removed.add('4,62,0');
  adapter.removed.add('5,62,0');
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.blockAt({ x: 4, y: 62, z: 0 }), 'cobblestone', '底座悬空处被脚手架填上');
  assert.equal(adapter.blockAt({ x: 5, y: 62, z: 0 }), 'cobblestone');
});

test('a refused ignition still leaves a resumable partial-frame landmark', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.useBlockAt = async () => ({ ok: false, reason: 'NO_FIRE' });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  const partial = memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）');
  assert.equal(partial.length, 1, '点火失败仍留下未完成门框地标，可回来补全');
  assert.deepEqual(partial[0].pos, { x: 3, y: 63, z: 0 });
});

test('successful ignition clears the partial-frame landmark', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）').length, 0, '点着后清掉未完成地标');
});

test('a partial frame is recorded even when obsidian is insufficient to finish', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('flint_and_steel', 1);
  // 预摆两块黑曜石（部分门框），背包 0 块：缺料也要记下门框位置，便于回来补全
  adapter.blocks.push({ name: 'obsidian', pos: { x: 4, y: 63, z: 0 } });
  adapter.blocks.push({ name: 'obsidian', pos: { x: 5, y: 63, z: 0 } });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'MISSING_MATERIALS');
  const partial = memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）');
  assert.equal(partial.length, 1, '缺料也记下部分门框');
  assert.deepEqual(partial[0].pos, { x: 3, y: 63, z: 0 });
});

test('portal travel records observed coordinates in both dimensions and verifies a return only after returning', async () => {
  const { adapter, memory, vision, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  const destinationPos = { x: 71, y: 55, z: -33 }; // deliberately unrelated to coordinate scaling
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: destinationPos });
  adapter.portalDestinations.set('fake-world:the_nether:71,55,-33', { dim: 'overworld', pos: sourcePos });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  const outbound = await run('travel_portal', { portalId: source.id });
  assert.equal(outbound.result.status, 'succeeded', outbound.result.summary);
  const first = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(first.routes.length, 1);
  assert.equal(first.routes[0].returnVerified, false);
  const destination = first.endpoints.find((e) => e.dim === 'the_nether')!;
  assert.deepEqual(destination.pos, destinationPos);
  assert.equal(destination.portalObserved, false, 'arrival inside a portal is not a fresh sight line to it');
  adapter.groundY = destinationPos.y - 1;
  adapter.pos = { ...destinationPos, x: destinationPos.x - 3 };
  await adapter.look(-Math.PI / 2, -0.3);
  vision.scan();
  assert.equal(vision.observeBlocks([destinationPos])[0]?.name, 'nether_portal');
  assert.equal((await run('observe_portal')).result.status, 'succeeded');
  assert.equal(travelStore(memory).get(destination.id, adapter.worldId)?.portalObserved, true);
  assert.ok(memory.landmarks().some((l) => l.label.includes('下界门') && l.dim === 'the_nether'), '观察到的下界门也记进常规地标');
  const returned = await run('recall_portal', { returnId: destination.id });
  assert.equal(returned.result.status, 'succeeded', returned.result.summary);
  assert.equal(adapter.dim, 'overworld');
  const final = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(final.routes.length, 2);
  assert.ok(final.routes.every((r) => r.returnVerified));
});

test('already inside a portal: timeout carries the in-portal timeline', async () => {
  const { adapter, memory, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos }, { name: 'nether_portal', pos: { x: 3, y: 65, z: 0 } });
  adapter.blocks.push({ name: 'obsidian', pos: { x: 3, y: 63, z: 0 } });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: { x: 8, y: 64, z: 0 } });
  adapter.pos = { x: 3.5, y: 64, z: 0.5 };
  adapter.portalNeedsExit = true;
  adapter.portalInsideMs = 30000;
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  const outcome = await run('travel_portal', { portalId: source.id });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'ERROR');
  assert.match(outcome.result.summary, /开始时身体已在门方块里/);
  assert.match(outcome.result.summary, /在门方块里连续 30\.0s/);
  assert.match(outcome.result.summary, /维度 overworld/);
  assert.equal(adapter.dim, 'overworld', '没有实际换维度，不能改状态');
});

test('End arrival without a portal does not invent a usable return route', async () => {
  const { adapter, memory, run } = setup();
  const source = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_portal', pos: source });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_end', pos: { x: 100, y: 49, z: 0 }, arrivalPortal: false });
  const endpoint = travelStore(memory).observe(adapter.state(), source, 'end_portal');
  assert.equal((await run('travel_portal', { portalId: endpoint.id })).result.status, 'succeeded');
  const arrival = travelStore(memory).snapshot(adapter.worldId).endpoints.find((e) => e.dim === 'the_end')!;
  assert.equal(arrival.portalObserved, false);
  const returned = await run('recall_portal', { returnId: arrival.id });
  assert.equal(returned.result.failureCode, 'NOT_FOUND');
});

test('cancelled portal entry never persists a transition and wrong-dimension IDs never move', async () => {
  const { adapter, memory, arbiter, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: { x: 8, y: 64, z: 0 } });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  adapter.speed = 1;
  const pending = run('travel_portal', { portalId: source.id });
  await sleep(10);
  arbiter.setPaused(true);
  assert.equal((await pending).result.status, 'cancelled');
  assert.equal(adapter.dim, 'overworld');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).routes, []);
  arbiter.setPaused(false);
  adapter.dim = 'the_nether';
  const actions = adapter.actions.length;
  assert.equal((await run('travel_portal', { portalId: source.id })).result.failureCode, 'WRONG_DIMENSION');
  assert.equal(adapter.actions.length, actions);
});

test('portal store persists actual two-end evidence and isolates other servers', () => {
  const { adapter } = setup();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-travel-test-'));
  const file = path.join(directory, 'travel-memory.json');
  try {
    const store = new TravelStore(file);
    const from = adapter.state();
    const a = store.observe(from, { x: 1, y: 64, z: 0 }, 'nether_portal');
    adapter.dim = 'the_nether'; adapter.sessionId = 'second-session';
    const to = adapter.state();
    const b = store.observe(to, { x: 70, y: 40, z: -11 }, 'nether_portal');
    store.record(a.id, b.id, from, to);
    const restored = new TravelStore(file);
    assert.equal(restored.snapshot('fake-world').routes.length, 1);
    assert.deepEqual(restored.snapshot('unrelated-world'), { endpoints: [], routes: [], gateways: [] });
    assert.throws(() => store.record(a.id, b.id, from, { ...to, observationReady: false }), /Unverified/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing existing End frames fail without crafting or manufacturing frames', async () => {
  const { adapter, run } = setup();
  adapter.inv.set('ender_eye', 12);
  assert.equal((await run('activate_end_portal')).result.failureCode, 'NOT_FOUND');
  assert.deepEqual(adapter.actions, []);
});

test('equip_armor confirms real slots and ranged_defend spends arrows without claiming a kill', async () => {
  const { adapter, vision, run } = setup();
  adapter.inv.set('iron_helmet', 1);
  adapter.inv.set('diamond_chestplate', 1);
  adapter.inv.set('shield', 1);
  const equipment = await run('equip_armor');
  assert.equal(equipment.result.status, 'succeeded');
  assert.equal(adapter.equipped.get('head'), 'iron_helmet');
  assert.equal(adapter.equipped.get('torso'), 'diamond_chestplate');
  assert.equal(adapter.equipped.get('off-hand'), 'shield');
  adapter.inv.set('bow', 1); adapter.inv.set('arrow', 3);
  adapter.entities.push({ id: 12, name: 'skeleton', kind: 'hostile', pos: { x: 12, y: 64, z: 0 }, dist: 12 });
  vision.scan();
  const ranged = await run('ranged_defend', { entityId: 12, shots: 2 });
  assert.equal(ranged.result.status, 'succeeded', ranged.result.summary);
  assert.equal(adapter.inv.get('arrow'), 1);
  assert.equal(ranged.result.data?.defeatVerified, false);
});

test('End gateway records actual same-session displacement and only verifies return after a second teleport', async () => {
  const { adapter, memory, vision, run } = setup();
  adapter.dim = 'the_end'; adapter.inv.set('ender_pearl', 2);
  const sourcePos = { x: 3, y: 64, z: 0 }, outerPos = { x: 1011, y: 74, z: -202 };
  adapter.blocks.push({ name: 'end_gateway', pos: sourcePos }, { name: 'end_gateway', pos: outerPos });
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) adapter.blocks.push({ name: 'end_stone', pos: { x: outerPos.x + dx, y: outerPos.y - 1, z: outerPos.z + dz } });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'end_gateway');
  adapter.useItem = async (item) => {
    adapter.actions.push(`use:${item}`);
    adapter.inv.set(item, (adapter.inv.get(item) ?? 0) - 1);
    adapter.pos = adapter.pos.x < 100 ? { ...outerPos } : { ...sourcePos };
    return { ok: true };
  };
  const outbound = await run('use_end_gateway', { portalId: source.id });
  assert.equal(outbound.result.status, 'succeeded', outbound.result.summary);
  const first = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(first.gateways.length, 1);
  assert.equal(first.gateways[0].returnVerified, false);
  const destination = first.endpoints.find((e) => e.pos.x > 100)!;
  assert.deepEqual(destination.pos, outerPos);
  adapter.pos = { ...outerPos, x: outerPos.x - 3 };
  await adapter.look(-Math.PI / 2, -0.3);
  vision.scan();
  assert.equal(vision.observeBlocks([outerPos])[0]?.name, 'end_gateway');
  assert.equal((await run('observe_portal')).result.status, 'succeeded');
  assert.equal((await run('use_end_gateway', { portalId: destination.id })).result.status, 'succeeded');
  assert.ok(travelStore(memory).snapshot(adapter.worldId).gateways.every((r) => r.returnVerified));
  assert.equal(adapter.inv.get('ender_pearl'), 0);
});

test('travel cancellation keeps the measured partial position, request, resolved target and backend', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  t.mock.method(a, 'moveTo', async () => {
    a.pos = { x: 2.5, y: 64, z: 0.5 };
    throw new AbortedError('task cancelled');
  });
  let caught: (Error & { partial?: { nav: Record<string, unknown>; originalRequest: unknown; backend: string } }) | undefined;
  try { await travel.run(ctx, { to: '10,64,0' }); } catch (e) { caught = e as typeof caught; }
  assert.ok(caught, '取消仍保留 AbortedError 语义');
  const partial = caught.partial!;
  assert.equal(partial.nav.outcome, 'CANCELLED');
  assert.equal(partial.nav.confirmed, false);
  assert.deepEqual(partial.nav.lastPosition, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(partial.nav.resolvedTarget, { x: 10, y: 64, z: 0 });
  assert.deepEqual(partial.originalRequest, { to: '10,64,0' });
  assert.equal(partial.nav.backend, 'land_water_plan');
  assert.ok((partial.nav.trace as unknown[]).length >= 2);
});

test('travel does not substitute same-XZ/different-Y for a three-dimensional target', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  const result = await travel.run(ctx, { to: '0,60,0' });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /目标高度 60/);
  assert.equal(result.data?.arrived, false);
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, false);
  assert.equal((result.data?.nav as { outcome: string }).outcome, 'NO_PATH');
  assert.deepEqual(result.data?.resolvedTarget, { x: 0, y: 60, z: 0 }, '原三维目标不被水平接近替换');
});

test('a pearl use without observed teleport cannot become an outer-island success', async () => {
  const { adapter, memory, bus, vision } = setup();
  adapter.dim = 'the_end'; adapter.inv.set('ender_pearl', 1);
  const pos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_gateway', pos });
  const endpoint = travelStore(memory).observe(adapter.state(), pos, 'end_gateway');
  const result = await useEndGateway.run({ adapter, memory, bus, senses: vision, signal: new AbortController().signal, deadline: Date.now() + 350, taskId: 'gateway-timeout', progress() {} }, { portalId: endpoint.id });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).gateways, []);
});
