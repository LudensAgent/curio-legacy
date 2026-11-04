import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { surface } from '../src/skills/movement.ts';
import { FakeAdapter } from './fake-adapter.ts';

function bank(material: string) {
  const adapter = new FakeAdapter();
  adapter.groundY = -64; // Open water test scene: no unrelated grass shore.
  adapter.inWater = true;
  adapter.pitch = -0.45;
  for (let x = 4; x <= 6; x++) for (let z = -2; z <= 2; z++) {
    adapter.blocks.push({ name: material, pos: { x, y: 63, z } });
  }
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 16 });
  return { adapter, vision };
}

for (const material of ['snow_block', 'ice', 'packed_ice', 'blue_ice']) {
  test(`a visible ${material} bank is remembered and supplies a genuine dry landing`, () => {
    const { adapter, vision } = bank(material);
    vision.scan();
    assert.ok((vision.composition.snow ?? 0) > 0, 'the bank must be visibly rendered in the snow/ice category');
    assert.ok([...vision.visibleNow.values()].some((block) => block.name === material), 'rendered solid ice/snow must also survive semantic perception');
    assert.ok(vision.knownBlocks([material], 16).length > 0, 'surface and gathering must retain the seen bank');
    const land = vision.nearestLand(adapter.pos);
    assert.ok(land, 'dry snowy or icy shores must be usable when searching for land');
    assert.equal(adapter.blockAt(land.pos), material);
    assert.equal(land.pos.y, 63);

    adapter.yaw = Math.PI / 2;
    vision.scan();
    assert.ok(![...vision.visibleNow.values()].some((block) => block.name === material));
    assert.ok(vision.knownBlocks([material], 16).length > 0, 'looking away must not erase a recently observed bank');
    assert.ok(vision.nearestLand(adapter.pos), 'a recently observed dry bank remains valid landing evidence');
  });
}

test('powder snow is visible snow scenery but cannot be promoted to safe solid shoreline', () => {
  const { adapter, vision } = bank('powder_snow');
  vision.scan();
  assert.ok((vision.composition.snow ?? 0) > 0);
  assert.equal(vision.nearestLand(adapter.pos), null);
});

test('an observed icy bed under water cannot count as a dry landing', () => {
  const { adapter, vision } = bank('ice');
  for (let x = 4; x <= 6; x++) for (let z = -2; z <= 2; z++) {
    adapter.blocks.push({ name: 'water', pos: { x, y: 64, z } });
  }
  vision.scan();
  assert.ok(vision.knownBlocks(['ice'], 16).length > 0, 'the shallow submerged ice remains a real visible surface');
  assert.equal(vision.nearestLand(adapter.pos), null, 'water over the ice makes the candidate unsafe for landing');
});

test('an icy bank with obstructed headroom cannot count as a dry landing', () => {
  const { adapter, vision } = bank('packed_ice');
  for (let x = 4; x <= 6; x++) for (let z = -2; z <= 2; z++) {
    adapter.blocks.push({ name: 'glass', pos: { x, y: 65, z } });
  }
  vision.scan();
  assert.ok(vision.knownBlocks(['packed_ice'], 16).length > 0, 'transparent obstruction permits seeing the actual bank');
  assert.equal(vision.nearestLand(adapter.pos), null, 'seeing through glass does not create standing headroom');
});

test('an opaque wall keeps an unseen icy shore out of landing evidence', () => {
  const { adapter, vision } = bank('blue_ice');
  for (let y = 61; y <= 69; y++) for (let z = -5; z <= 5; z++) {
    adapter.blocks.push({ name: 'bricks', pos: { x: 2, y, z } });
  }
  vision.scan();
  assert.equal(vision.knownBlocks(['blue_ice'], 16).length, 0);
  assert.equal(vision.nearestLand(adapter.pos), null, 'unseen shore behind a wall cannot be used as an escape destination');
});

test('surface only performs vertical ascent and does not pick a shore', async () => {
  const { adapter, vision } = bank('blue_ice');
  const memory = new WorldMemory(null), bus = new EventBus();
  adapter.oxygen = 10;
  vision.scan();
  assert.ok(vision.nearestLand(adapter.pos), '感知仍提供岸线候选，但 surface 不应使用它');
  try {
    const result = await surface.run({ adapter, senses: vision, memory, bus, signal: new AbortController().signal,
      deadline: Date.now() + 32000, taskId: 'icy-shore-surface', progress() {} }, {});
    assert.equal(result.status, 'failed', result.summary);
    assert.deepEqual(adapter.actions, ['swim:up'], '只向上浮，不向岸游');
  } finally { memory.close(); }
});
