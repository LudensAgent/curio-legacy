import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { Senses } from '../src/skills/types.ts';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.1');
const { Vec3 } = require('vec3');
const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const bus = new EventBus(), adapter = new MineflayerAdapter(config, bus), memory = new WorldMemory(null);
  const stones = new Map([1, 2].map((x) => [x, { name: 'stone', position: new Vec3(x, 64, 0) }]));
  const inventory = new Map<string, number>();
  const latePaths: (() => void)[] = [], packets: string[] = [];
  let stops = 0, dug = 0;
  const bot: any = {
    username: 'CollectionTest', health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0), onGround: true, effects: {} },
    world: { raycast: () => { const s = [...stones.values()][0]; return s ? { position: { x: s.position.x, y: s.position.y, z: s.position.z, face: 'top' } } : null; } },
    entities: { 42: { id: 42, name: 'item', position: new Vec3(2, 64, 0) } },
    inventory: { items: () => [...inventory].map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 },
    _client: { write: (name: string) => packets.push(name) },
    blockAt: (pos: any) => pos.y === 64 && pos.z === 0 && stones.has(pos.x) ? stones.get(pos.x) : { name: 'air', position: pos },
    canDigBlock: () => true,
    async dig(block: any) { dug++; stones.delete(block.position.x); inventory.set('cobblestone', dug); },
    clearControlStates() {}, deactivateItem() {}, look: async () => {}, lookAt: async () => {},
    pathfinder: {
      async goto(goal: any) {
        if (goal.constructor.name === 'GoalLookAtBlock') return;
        await new Promise<void>((resolve) => latePaths.push(resolve));
        bot._client.write('late_pickup_position');
      },
      stop() { stops++; }, setGoal() {},
    },
  };
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).spawned = true;
  const senses: Senses = {
    perceivedEntities: () => [], refresh() {}, markSweep() {},
    knownBlocks: (names) => names.includes('stone') ? [...stones.values()].map((block) => ({ name: block.name, pos: block.position, dist: block.position.distanceTo(bot.entity.position) })) : [],
    observeBlocks: (positions) => positions.map((pos: any) => {
      const s = [...stones.values()].find((b) => Math.floor(b.position.x) === pos.x && Math.floor(b.position.y) === pos.y && Math.floor(b.position.z) === pos.z);
      return s ? { name: 'stone', pos: s.position } : { name: 'air', pos };
    }) as unknown as BlockObservation[],
  };
  const arbiter = new Arbiter(adapter, memory, bus, senses);
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) { const step = Math.min(100, left); t.mock.timers.tick(step); await flush(); left -= step; }
  };
  t.after(() => { arbiter.cancel('test end'); adapter.stopAll(); memory.close(); });
  return { adapter, arbiter, bot, bus, latePaths, packets, advance, dug: () => dug, stops: () => stops };
}

test('a timed-out pickup path stays best-effort and the real gather task continues to its next block', async (t) => {
  const w = fixture(t);
  let outcome: TaskOutcome | undefined;
  w.arbiter.once('done', (value: TaskOutcome) => { outcome = value; });
  assert.ok(!('error' in w.arbiter.start({ skill: 'gather', args: { block: 'stone', count: 2 } }, 'llm')));
  await flush(); await w.advance(7000);
  assert.ok(outcome, 'both bounded pickup attempts should finish without waiting for their late paths');
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(w.dug(), 2, 'a local pickup timeout must not cancel the remaining approved gathering');
  assert.equal(w.latePaths.length, 2);
  assert.ok(w.stops() >= 2, 'timed-out movement still releases its controls');
  for (const release of w.latePaths) release();
  await flush();
  assert.deepEqual(w.packets, [], 'late path continuations keep their invalidated action checkpoints');
  assert.equal(w.bus.recent().some((event) => event.type === 'task_end' && event.data?.status === 'cancelled'), false);
});

test('a task abort stops an in-flight pickup immediately and never renews its action ownership', async (t) => {
  const w = fixture(t), controller = new AbortController();
  const pending = w.adapter.collectNearbyDrops(controller.signal, 6, 3000);
  const rejected = assert.rejects(pending, { name: 'AbortedError' });
  await flush();
  assert.equal(w.latePaths.length, 1);
  controller.abort('user pause'); w.adapter.stopAll();
  await rejected;
  await w.advance(4000);
  assert.equal(w.latePaths.length, 1, 'no replacement pickup starts after task cancellation');
  w.latePaths[0](); await flush();
  assert.deepEqual(w.packets, []);
});

test('collection observes a delayed initial item_spawn before moving to pick it up', async (t) => {
  const w = fixture(t), controller = new AbortController();
  w.bot.entities = {};
  let moves = 0;
  w.bot.pathfinder.goto = async () => { moves++; w.bot.entity.position = new Vec3(2, 64, 0); delete w.bot.entities[42]; };
  setTimeout(() => { w.bot.entities[42] = { id: 42, name: 'item', position: new Vec3(2, 64, 0) }; }, 150);
  let picked: number | undefined;
  const pending = w.adapter.collectNearbyDrops(controller.signal, 6, 3000).then((count) => { picked = count; });
  await flush(); await w.advance(100);
  assert.equal(picked, undefined, 'the first empty scan should allow a bounded observation grace');
  await w.advance(400); await pending;
  assert.equal(picked, 1);
  assert.equal(moves, 1, 'the newly observed drop should use the real adapter move primitive');
});

for (const budget of [120, 3000]) {
  test(`empty collection ends at its initial grace bound within a ${budget}ms budget`, async (t) => {
    const w = fixture(t), controller = new AbortController();
    w.bot.entities = {};
    const start = Date.now(), bound = Math.min(300, budget);
    let endedAt: number | undefined;
    const pending = w.adapter.collectNearbyDrops(controller.signal, 6, budget).then((count) => { endedAt = Date.now(); return count; });
    await flush(); await w.advance(bound - 1);
    assert.equal(endedAt, undefined);
    await w.advance(1);
    assert.equal(await pending, 0);
    assert.equal(endedAt, start + bound);
    assert.equal(w.latePaths.length, 0, 'an empty grace period does not start pathfinding');
  });
}

test('a delayed drop does not extend pathfinding beyond the collection deadline', async (t) => {
  const w = fixture(t), controller = new AbortController();
  w.bot.entities = {};
  setTimeout(() => { w.bot.entities[42] = { id: 42, name: 'item', position: new Vec3(2, 64, 0) }; }, 150);
  const start = Date.now();
  let endedAt: number | undefined;
  const pending = w.adapter.collectNearbyDrops(controller.signal, 6, 400).then((count) => { endedAt = Date.now(); return count; });
  await flush(); await w.advance(400);
  assert.equal(await pending, 0);
  assert.equal(endedAt, start + 400, 'initial grace and movement share one local time budget');
  assert.equal(w.latePaths.length, 1);
});

test('task cancellation interrupts the initial observation grace immediately', async (t) => {
  const w = fixture(t), controller = new AbortController();
  w.bot.entities = {};
  const pending = w.adapter.collectNearbyDrops(controller.signal, 6, 3000);
  const rejected = assert.rejects(pending, { name: 'AbortedError' });
  await flush(); await w.advance(100);
  controller.abort('pause during grace');
  await rejected;
  assert.equal(w.latePaths.length, 0);
});

for (const change of ['session', 'dimension', 'external_stop'] as const) {
  test(`pickup timeout cannot renew ownership after a ${change} change`, async (t) => {
    const w = fixture(t), controller = new AbortController();
    const pending = w.adapter.collectNearbyDrops(controller.signal, 6, 1000);
    const rejected = assert.rejects(pending, { name: 'AbortedError' });
    await flush();
    if (change === 'session') (w.adapter as any).sessionId = 'replacement-session';
    else if (change === 'dimension') w.bot.game.dimension = 'the_nether';
    else w.adapter.stopAll();
    await w.advance(1300); await rejected;
    assert.equal(controller.signal.aborted, false, 'session/ownership checks work independently of executive cancellation');
    assert.equal(w.latePaths.length, 1);
    w.latePaths[0](); await flush();
    assert.deepEqual(w.packets, []);
  });
}
