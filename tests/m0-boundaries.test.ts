import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { RESOURCE_MEMORY_TTL_MS, Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  return { adapter, bus, memory, vision, arbiter };
};

test('pause cancels the active task and gates reflex and all new task sources until resume', async () => {
  const { adapter, bus, vision, arbiter } = setup();
  adapter.speed = 1;
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'explore', args: { distance: 64 } }, 'llm');
  arbiter.setPaused(true);
  assert.equal((await done).result.status, 'cancelled');
  adapter.inLava = true;
  const reflex = new Reflex(adapter, arbiter, bus, vision);
  reflex.tick();
  assert.equal(reflex.triggers, 0);
  for (const source of ['llm', 'rule', 'filler', 'reflex', 'user'] as const) assert.ok('error' in arbiter.start({ skill: 'look_around' }, source));
  arbiter.setPaused(false);
  assert.ok(!('error' in arbiter.start({ skill: 'look_around', args: { seconds: 2 } }, 'user')));
  arbiter.cancel('test cleanup');
});

test('cancelled tasks cannot place, sleep, smelt, transfer, till, plant or stop a newer task', async () => {
  const { adapter, arbiter } = setup();
  const methods = ['placeBlockAt', 'placeBlockStateAt', 'sleepInBed', 'smelt', 'useChest', 'till', 'plant', 'stopAll'];
  // Optional future primitives still use the same cancellation guard contract.
  for (const name of methods) if (typeof (adapter as any)[name] !== 'function') (adapter as any)[name] = async () => { throw new Error('A cancelled task must not reach the primitive'); };
  SKILLS.test_late_facilities = {
    name: 'test_late_facilities', description: '', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await sleep(25);
      for (const name of methods) {
        try { await (ctx.adapter as any)[name](); } catch { /* each call must be rejected */ }
      }
      return { status: 'succeeded', summary: 'late' };
    },
  };
  try {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    arbiter.start({ skill: 'test_late_facilities' }, 'llm');
    arbiter.cancel('cancelled');
    const stops = adapter.stopAllCount;
    assert.equal((await done).result.status, 'cancelled');
    assert.equal(arbiter.blockedActions, methods.length);
    assert.equal(adapter.stopAllCount, stops);
    assert.deepEqual(adapter.actions, []);
  } finally { delete SKILLS.test_late_facilities; }
});

test('Mineflayer late equip continuations cannot consume or write a packet after cancellation', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const packets: string[] = [];
  let consumed = 0;
  const bot: any = {
    entity: {}, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'bread' }] },
    _client: { write: (name: string) => packets.push(name) },
    async equip() { await wait; bot._client.write('held_item_slot'); },
    async consume() { consumed++; },
  };
  adapter.bot = bot;
  adapter.mcData = { foodsByName: { bread: { foodPoints: 5 } } };
  (adapter as any).connectedFlag = true;
  const controller = new AbortController();
  const pending = adapter.eat(controller.signal);
  controller.abort('paused');
  adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  release();
  await sleep(0);
  assert.equal(consumed, 0);
  assert.deepEqual(packets, []);
});

test('a task from an earlier dimension cannot issue a new action even before the next executive tick', async () => {
  const { adapter, arbiter } = setup();
  SKILLS.test_old_dimension = {
    name: 'test_old_dimension', description: '', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await sleep(20);
      ctx.adapter.chat('old world');
      return { status: 'succeeded', summary: 'old' };
    },
  };
  try {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    arbiter.start({ skill: 'test_old_dimension' }, 'llm');
    adapter.dim = 'the_end';
    assert.equal((await done).result.status, 'cancelled');
    assert.deepEqual(adapter.actions, []);
    assert.equal(arbiter.blockedActions, 1);
  } finally { delete SKILLS.test_old_dimension; }
});

test('vision isolates identical coordinates between worlds and dimensions and expires every resource view consistently', () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'iron_ore', pos: { x: 6, y: 64, z: 0 } });
  vision.scan();
  assert.equal(vision.knownBlocks(['iron_ore'], 32).length, 1);
  adapter.dim = 'the_nether';
  assert.equal(vision.knownBlocks(['iron_ore'], 32).length, 0);
  assert.deepEqual(vision.summary(adapter.pos).visible_resources, []);
  adapter.dim = 'overworld';
  assert.equal(vision.knownBlocks(['iron_ore'], 32).length, 1);
  adapter.worldId = 'other-server';
  assert.equal(vision.knownBlocks(['iron_ore'], 32).length, 0);
  adapter.worldId = 'fake-world';
  adapter.yaw = Math.PI / 2;
  vision.scan();
  assert.ok(vision.summary(adapter.pos).remembered_resources.some((r) => r.block === 'iron_ore'));
  const originalNow = Date.now;
  const expired = originalNow() + RESOURCE_MEMORY_TTL_MS + 1;
  try {
    Date.now = () => expired;
    assert.equal(vision.summary(adapter.pos).remembered_resources.some((r) => r.block === 'iron_ore'), false);
    assert.equal(vision.knownBlocks(['iron_ore'], 32).length, 0);
  } finally { Date.now = originalNow; }
});

test('a new unready session invalidates cached perception and cannot create fresh exploration facts', () => {
  const { adapter, bus, memory, vision } = setup();
  const perception = new Perception(adapter, memory, bus, vision);
  const first = perception.update();
  const visits = memory.visitedChunkCount;
  adapter.sessionId = 'after-respawn';
  adapter.observationReady = false;
  adapter.pos.x = 1000;
  const next = perception.snapshot();
  assert.notEqual(next, first);
  assert.equal(next.observation?.ready, false);
  assert.equal(next.vision, null);
  assert.equal(memory.visitedChunkCount, visits);
});

test('lava escape issues movement without a hostile and reports failure while still in the hazard', async () => {
  const { adapter, arbiter } = setup();
  adapter.inLava = true;
  adapter.speed = 1000;
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'flee', args: { distance: 8 } }, 'reflex');
  const outcome = await done;
  assert.ok(adapter.actions.some((a) => a.startsWith('moveTo:')));
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'STUCK');
});

test('sleep refuses unsafe dimensions before interacting with a bed', async () => {
  const { adapter, arbiter } = setup();
  adapter.dim = 'the_nether';
  adapter.isDay = false;
  adapter.inv.set('red_bed', 1);
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'sleep' }, 'llm');
  assert.equal((await done).result.status, 'failed');
  assert.deepEqual(adapter.actions, []);
  assert.equal(adapter.isDay, false);
});
