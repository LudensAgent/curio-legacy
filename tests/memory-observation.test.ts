import assert from 'node:assert/strict';
import { test } from 'node:test';
import minecraftData from 'minecraft-data';
import type { GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { isResourceBlock } from '../src/memory/ore-spots.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { DEFAULT_VISION, interactiveName, Vision } from '../src/perception/vision.ts';
import { rememberPlace } from '../src/skills/observation.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('visible disappearance clears container impressions while an unseen change preserves them', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
  t.after(() => memory.close());
  const pos = { x: 20, y: 64, z: 0 };
  adapter.blocks.push({ name: 'chest', pos });
  const perception = new Perception(adapter, memory, new EventBus(), vision);
  perception.update();
  memory.noteChestUse(adapter.dim, pos, { put: [{ name: 'coal', count: 64 }] });
  adapter.yaw = Math.PI / 2;
  adapter.blocks = [];
  t.mock.timers.tick(2100);
  perception.update();
  assert.equal(memory.chests().length, 1);
  adapter.yaw = -Math.PI / 2;
  t.mock.timers.tick(2100);
  perception.update();
  assert.equal(memory.chests().length, 0);
  assert.ok(!memory.landmarks().some((l) => l.label === '箱子'));
  assert.equal(memory.goneNear(adapter.dim, pos)[0]?.now, 'air');
});
import { makeCtx } from './survival-helpers.ts';

test('every resource recognized by the current game registry enters visual and persistent memory', () => {
  const pos = { x: 3, y: 64, z: 0 };
  minecraftData('1.20.1').blocksArray.filter((block) => isResourceBlock(block.name)).forEach(({ name }) => {
    const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
    adapter.blocks.push({ name, pos });
    if (name === 'lava') adapter.blockProperties.set('3,64,0', { level: 0 });
    new Perception(adapter, memory, new EventBus(), vision).update();
    assert.equal(vision.seenAt(pos), name, name);
    assert.equal(vision.knownBlocks([name], 8).length, 1, name);
    assert.ok(memory.landmarks().some((record) => record.kind === 'resource' && record.label === name), name);
    memory.close();
  });
});

test('functional block variants are visible locations without requiring a dedicated gameplay skill', () => {
  ['oak_door', 'iron_trapdoor', 'oak_fence_gate', 'stone_button', 'lever', 'oak_sign', 'oak_wall_hanging_sign', 'blue_shulker_box'].forEach((name) => {
    const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
    adapter.blocks.push({ name, pos: { x: 3, y: 64, z: 0 } });
    new Perception(adapter, memory, new EventBus(), vision).update();
    assert.equal(vision.knownBlocks([name], 8).length, 1, name);
    assert.ok(memory.landmarks().some((record) => record.kind === 'discovery' && record.label === interactiveName(name)), name);
    memory.close();
  });
});

test('a lava source changes resource status only after its new flowing state is actually visible', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
  t.after(() => memory.close());
  const pos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'lava', pos });
  adapter.blockProperties.set('3,64,0', { level: 0 });
  const perception = new Perception(adapter, memory, new EventBus(), vision);
  perception.update();
  assert.equal(memory.landmarks().filter((record) => record.kind === 'resource' && record.label === 'lava').length, 1);

  adapter.yaw = Math.PI / 2;
  adapter.blockProperties.set('3,64,0', { level: 5 });
  t.mock.timers.tick(2100);
  perception.update();
  assert.equal(memory.landmarks().filter((record) => record.kind === 'resource' && record.label === 'lava').length, 1, 'unseen state changes do not update memory');

  adapter.yaw = -Math.PI / 2;
  t.mock.timers.tick(2100);
  perception.update();
  assert.equal(memory.landmarks().filter((record) => record.kind === 'resource' && record.label === 'lava').length, 0);
  assert.equal(memory.landmarks().filter((record) => record.kind === 'danger' && record.label === 'lava').length, 1);
});

test('lava without an observed level is a hazard but is not asserted to be a source', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  adapter.blocks.push({ name: 'lava', pos: { x: 3, y: 64, z: 0 } });
  new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  assert.ok(memory.landmarks().some((record) => record.kind === 'danger' && record.label === 'lava'));
  assert.ok(!memory.landmarks().some((record) => record.kind === 'resource' && record.label === 'lava'));
});

test('distant groups of the same animal remain separate observed locations', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
  t.after(() => memory.close());
  adapter.entities = [6, 50].map((x, id) => ({ id: id + 1, name: 'wolf', kind: 'passive' as const, pos: { x, y: 64, z: 0 }, dist: x }));
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.equal(vision.seen.length, 2);
  assert.deepEqual(memory.landmarks().filter((record) => record.kind === 'herd').map((record) => record.pos.x).sort((a, b) => a - b), [6, 50]);
});

test('brief sightings are recorded and not seeing a nearby animal later does not erase the sighting', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), vision = new Vision(adapter);
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, new EventBus(), vision);
  adapter.entities = [{ id: 1, name: 'cow', kind: 'passive', pos: { x: 5, y: 64, z: 0 }, dist: 5 }];
  perception.update();
  adapter.entities = [{ id: 2, name: 'wandering_trader', kind: 'passive', pos: { x: 6, y: 64, z: 0 }, dist: 6 }];
  t.mock.timers.tick(1000);
  perception.update();
  assert.ok(memory.landmarks().some((record) => record.kind === 'herd' && record.label === 'wandering_trader'), 'even one short sighting leaves a location');
  adapter.entities = [];
  adapter.yaw = Math.PI / 2;
  t.mock.timers.tick(20_000);
  perception.update();
  assert.deepEqual(memory.landmarks().filter((record) => record.kind === 'herd').map((record) => record.label).sort(), ['cow', 'wandering_trader']);
});

test('known ores and containers survive unseen changes until their old cell is actually visible again', () => {
  ['iron_ore', 'chest'].forEach((name) => {
    ['behind', 'occluded', 'dark'].forEach((hidden) => {
      const adapter = new FakeAdapter(), vision = new Vision(adapter), pos = { x: 8, y: 64, z: 1 };
      adapter.blocks.push({ name, pos });
      vision.scan();
      assert.equal(vision.knownBlocks([name], 16).length, 1, `${name}: initially seen`);
      adapter.blocks = [];
      if (hidden === 'behind') adapter.yaw = Math.PI / 2;
      else if (hidden === 'dark') adapter.light = 0;
      else adapter.blocks = Array.from({ length: 49 }, (_, index) => ({
        name: 'stone', pos: { x: 4, y: 63 + Math.floor(index / 7), z: index % 7 - 3 },
      }));
      vision.scan();
      assert.equal(vision.observeBlocks([pos]).length, 0, `${name}: ${hidden} cell is not observed`);
      assert.equal(vision.knownBlocks([name], 16).length, 1, `${name}: ${hidden} world change must not be known`);
      adapter.yaw = -Math.PI / 2;
      adapter.light = 15;
      adapter.blocks = [];
      assert.equal(vision.observeBlocks([pos])[0]?.name, 'air', `${name}: old position can now be inspected`);
      assert.equal(vision.knownBlocks([name], 16).length, 0, `${name}: actual empty-cell observation invalidates memory`);
    });
  });
});

test('known-block revalidation keeps each fresh sight-line request bounded to 32 cells', () => {
  const adapter = new FakeAdapter(), vision = new Vision(adapter);
  vision.scan();
  const requestSizes: number[] = [], observe = vision.observeBlocks.bind(vision);
  vision.observeBlocks = (positions) => { requestSizes.push(positions.length); return observe(positions); };
  assert.ok(vision.knownBlocks(['grass_block'], 64).length > 32);
  assert.ok(requestSizes.length > 1);
  assert.ok(requestSizes.every((size) => size <= 32));
});

test('transparent functional blocks still need light before becoming a visual discovery', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), pos = { x: 20, y: 64, z: 0 };
  t.after(() => memory.close());
  assert.equal(minecraftData('1.20.1').blocksByName.oak_sign.boundingBox, 'empty');
  adapter.blocks.push({ name: 'oak_sign', pos });
  adapter.light = 0;
  const optics = adapter.blockOptics.bind(adapter);
  adapter.blockOptics = (x, y, z) => {
    const block = optics(x, y, z);
    return block?.name === 'oak_sign' ? { ...block, kind: 'clear' } : block;
  };
  const vision = new Vision(adapter);
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.equal(vision.observeBlocks([pos]).length, 0);
  assert.ok(![...vision.visibleNow.values()].some((block) => block.name === 'oak_sign'));
  assert.ok(!memory.landmarks().some((record) => /告示牌/.test(record.label)));
});

test('missing lighting data cannot become daylight for loaded ore or entities', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), pos = { x: 20, y: 64, z: 0 };
  t.after(() => memory.close());
  const observedAdapter: GameAdapter = adapter;
  observedAdapter.lightAt = () => null;
  adapter.blocks.push({ name: 'iron_ore', pos });
  adapter.entities.push({ id: 1, name: 'cow', kind: 'passive', pos: { x: 20, y: 64, z: 2 }, dist: 20 });
  const vision = new Vision(adapter);
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.equal(vision.observeBlocks([pos]).length, 0);
  assert.ok(![...vision.visibleNow.values()].some((block) => block.name === 'iron_ore'));
  assert.equal(vision.seen.length, 0);
  assert.ok(!memory.landmarks().some((record) => record.kind === 'resource' || record.kind === 'herd'));
});

test('End ambient visibility agrees between scan and explicit observation', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), pos = { x: 20, y: 64, z: 0 };
  t.after(() => memory.close());
  adapter.dim = 'the_end';
  adapter.light = 0;
  adapter.blocks.push({ name: 'obsidian', pos });
  const vision = new Vision(adapter);
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.ok([...vision.visibleNow.values()].some((block) => block.name === 'obsidian'));
  assert.equal(vision.observeBlocks([pos])[0]?.name, 'obsidian');
});

test('visible disappearance outside interaction distance clears the persistent ore claim', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), pos = { x: 20, y: 64, z: 0 };
  t.after(() => memory.close());
  adapter.blocks.push({ name: 'iron_ore', pos });
  const vision = new Vision(adapter), perception = new Perception(adapter, memory, new EventBus(), vision);
  perception.update();
  assert.ok(memory.landmarks().some((record) => record.kind === 'resource'));
  adapter.blocks = [];
  t.mock.timers.tick(2100);
  perception.update();
  assert.equal(vision.observeBlocks([pos])[0]?.name, 'air');
  assert.ok(!memory.landmarks().some((record) => record.kind === 'resource'));
  assert.ok(memory.goneNear(adapter.dim, pos, 1).some((record) => record.label === 'iron_ore' && record.now === 'air'));
});

test('loaded objects beyond the optical range do not enter discovery or entity memory', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 8, y: 64, z: 0 } }, { name: 'iron_ore', pos: { x: 20, y: 64, z: 4 } });
  adapter.entities.push({ id: 1, name: 'cow', kind: 'passive', pos: { x: 20, y: 64, z: -4 }, dist: 20 });
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 12 });
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.equal(vision.effectiveRange(), 12);
  assert.ok(memory.landmarks().some((record) => record.kind === 'resource' && record.label === 'diamond_ore'));
  assert.ok(!memory.landmarks().some((record) => record.kind === 'resource' && record.label === 'iron_ore' || record.kind === 'herd'));
  assert.equal(vision.observeBlocks([{ x: 20, y: 64, z: 4 }]).length, 0);
  assert.equal(vision.seen.length, 0);
});

test('ordinary vision is capped at 64 blocks and also respects a nearer server or configured range', () => {
  [
    { configured: 0, server: null, expected: 64 },
    { configured: 0, server: 512, expected: 64 },
    { configured: 256, server: 512, expected: 64 },
    { configured: 0, server: 32, expected: 32 },
    { configured: 48, server: 24, expected: 24 },
    { configured: 12, server: 48, expected: 12 },
  ].forEach(({ configured, server, expected }) => {
    const adapter: GameAdapter = new FakeAdapter();
    adapter.renderDistance = () => server;
    assert.equal(new Vision(adapter, { ...DEFAULT_VISION, range: configured }).effectiveRange(), expected);
  });
});

test('loaded ores and neutral entities beyond 64 blocks cannot enter memory even with an oversized range', async (t) => {
  for (const configured of [0, 256]) {
    const adapter = new FakeAdapter(), memory = new WorldMemory(null), pos = { x: 80, y: 67, z: 0 };
    t.after(() => memory.close());
    adapter.pitch = 0;
    const observedAdapter: GameAdapter = adapter;
    observedAdapter.renderDistance = () => 512;
    adapter.blocks.push({ name: 'iron_ore', pos });
    adapter.entities.push({ id: 1, name: 'wolf', kind: 'passive', pos: { x: 80, y: 64, z: 2 }, dist: 80 });
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: configured });
    new Perception(adapter, memory, new EventBus(), vision).update();
    assert.equal(vision.effectiveRange(), 64);
    assert.ok(![...vision.visibleNow.values()].some((block) => block.name === 'iron_ore'));
    assert.equal(vision.observeBlocks([pos]).length, 0);
    assert.equal(vision.seen.length, 0);
    assert.equal(vision.sightings.size, 0);
    assert.ok(!memory.hasSeen('blocks', 'iron_ore'));
    assert.ok(!memory.hasSeen('entities', 'wolf'));
    assert.ok(!memory.landmarks().some((record) => record.kind === 'resource' || record.kind === 'herd'));
    const ctx = makeCtx(adapter, { memory, senses: { refresh: vision.refresh.bind(vision),
      knownBlocks: vision.knownBlocks.bind(vision), observeBlocks: vision.observeBlocks.bind(vision),
      perceivedEntities: vision.perceivedEntities.bind(vision) } });
    assert.equal((await rememberPlace.run(ctx, { target: pos, label: '远矿' })).failureCode, 'NOT_FOUND');
    assert.equal((await rememberPlace.run(ctx, { entityId: 1, label: '远狼' })).failureCode, 'NOT_FOUND');
  }
});

test('remember_place cannot promote a loaded object behind a wall or a heard entity into an observation', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const pos = { x: 6, y: 64, z: 0 };
  adapter.blocks.push({ name: 'diamond_ore', pos }, ...Array.from({ length: 49 }, (_, index) => ({
    name: 'stone', pos: { x: 3, y: 63 + Math.floor(index / 7), z: index % 7 - 3 },
  })));
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos, dist: 6 });
  const vision = new Vision(adapter);
  new Perception(adapter, memory, new EventBus(), vision).update();
  assert.equal(adapter.blockAt(pos), 'diamond_ore', 'the adapter has loaded data at the hidden cell');
  assert.equal(vision.perceivedEntities(48)[0]?.perception, 'heard');
  const ctx = makeCtx(adapter, { memory, senses: { refresh: vision.refresh.bind(vision),
    knownBlocks: vision.knownBlocks.bind(vision), observeBlocks: vision.observeBlocks.bind(vision),
    perceivedEntities: vision.perceivedEntities.bind(vision) } });
  assert.equal((await rememberPlace.run(ctx, { target: pos, label: '暗矿' })).failureCode, 'NOT_FOUND');
  assert.equal((await rememberPlace.run(ctx, { entityId: 7, label: '声音' })).failureCode, 'NOT_FOUND');
  assert.ok(!memory.landmarks().some((record) => record.kind === 'resource' || record.kind === 'herd' || record.kind === 'waypoint'));
});
