import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.1');
const BlockClass = require('prismarine-block')('1.20.1') as typeof Block;
const WorldSync = require('prismarine-world/src/worldsync.js');

// Real adapter, 1.20.1 block shapes and prismarine-world ray traversal; only server acknowledgements are simulated.
function fixture(item = 'water_bucket') {
  const cells = new Map<string, Block>(), inventory = new Map([[item, 1]]);
  let uses = 0, onUse = () => {};
  const put = (name: string, pos: Vec3, level = 0, properties?: Record<string, string | number>) => {
    const data = registry.blocksByName[name];
    const block = properties ? BlockClass.fromProperties(name, properties, 0) : BlockClass.fromStateId(data.minStateId + (['water', 'lava'].includes(name) ? level : data.defaultState - data.minStateId), 0);
    block.position = pos.floored();
    cells.set(block.position.toString(), block);
    return block;
  };
  const blockAt = (pos: Vec3) => cells.get(pos.floored().toString()) ?? Object.assign(BlockClass.fromStateId(registry.blocksByName.air.defaultState, 0), { position: pos.floored() });
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    inventory: { items: () => [...inventory].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    heldItem: null as { name: string } | null,
    blockAt,
    world: { getBlock: blockAt, raycast: WorldSync.prototype.raycast },
    async equip(held: { name: string }) { bot.heldItem = held; },
    async lookAt(point: Vec3, _force: boolean) {
      const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0));
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
      bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    },
    async waitForTicks() {},
    setControlState() {}, deactivateItem() {},
    activateItem() { bot._client.write('use_item'); },
    _client: { write(packet: string) { assert.equal(packet, 'use_item'); uses++; onUse(); } },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = registry;
  Reflect.set(adapter, 'connectedFlag', true);
  const target = new Vec3(2, 64, 0);
  put('stone', target.offset(0, -1, 0));
  return { adapter, bot, target, inventory, put, uses: () => uses, onUse: (action: () => void) => { onUse = action; } };
}
const signal = () => new AbortController().signal;

test('a top-face request below the support top is rejected before any bucket use', async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(0.5, 63, 0.5);
  const target = new Vec3(2, 65, 0);
  f.put('stone', target.offset(0, -1, 0));
  const result = await f.adapter.useBucketAt(target, 'water_bucket', signal());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /^NO_PLACEMENT_FACE/);
  assert.equal(f.uses(), 0);
  assert.equal(f.inventory.get('water_bucket'), 1);
});

test('precise bucket placement refuses to use when raycasting is unavailable', async () => {
  const f = fixture();
  f.bot.world.raycast = undefined;
  const result = await f.adapter.useBucketAt(f.target, 'water_bucket', signal());
  assert.equal(result.ok, false);
  assert.equal(f.uses(), 0);
});

for (const order of ['inventory-first', 'block-first'] as const) {
  test(`placement waits for both independent acknowledgements: ${order}`, async () => {
    const f = fixture();
    f.onUse(() => {
      const inventory = () => { f.inventory.set('water_bucket', 0); f.inventory.set('bucket', 1); };
      const block = () => { f.put('water', f.target); };
      (order === 'inventory-first' ? inventory : block)();
      setTimeout(order === 'inventory-first' ? block : inventory, 350);
    });
    const result = await f.adapter.useBucketAt(f.target, 'water_bucket', signal());
    assert.equal(result.ok, true, result.reason);
    assert.equal(f.uses(), 1);
    assert.deepEqual(result.placed, { x: 2, y: 64, z: 0 });
    assert.equal(f.adapter.recentPlaced(0).at(-1)?.name, 'water');
  });
}

test('target water alone never causes another use while a late inventory message is pending', async () => {
  const f = fixture();
  f.put('stone', f.target.offset(1, 0, 0));
  f.onUse(() => { f.put('water', f.target); });
  const result = await f.adapter.useBucketAt(f.target, 'water_bucket', signal());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /^PLACEMENT_NOT_CONFIRMED/);
  assert.equal(f.uses(), 1);
});

for (const mode of ['missing-empty-bucket', 'flowing-target'] as const) {
  test(`placement does not certify incomplete evidence: ${mode}`, async () => {
    const f = fixture();
    f.onUse(() => {
      f.inventory.set('water_bucket', 0);
      if (mode !== 'missing-empty-bucket') f.inventory.set('bucket', 1);
      f.put('water', f.target, mode === 'flowing-target' ? 3 : 0);
    });
    const result = await f.adapter.useBucketAt(f.target, 'water_bucket', signal());
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /^PLACEMENT_NOT_CONFIRMED/);
    assert.equal(f.uses(), 1);
  });
}

test('cancellation during confirmation rejects without another bucket use', async () => {
  const f = fixture(), controller = new AbortController();
  let used!: () => void;
  const activated = new Promise<void>((resolve) => { used = resolve; });
  f.onUse(() => { f.inventory.set('water_bucket', 0); f.inventory.set('bucket', 1); used(); });
  const pending = f.adapter.useBucketAt(f.target, 'water_bucket', controller.signal);
  await activated;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortedError' });
  assert.equal(f.uses(), 1);
  assert.equal(f.adapter.recentPlaced(0).length, 0);
});

test('bucket operation exceptions preserve their actual cause', async () => {
  const f = fixture();
  f.bot.lookAt = async () => { throw new Error('LOOK_DISCONNECTED'); };
  await assert.rejects(f.adapter.useBucketAt(f.target, 'water_bucket', signal()), /LOOK_DISCONNECTED/);
  assert.equal(f.uses(), 0);
});

for (const mode of ['unrelated-pickup', 'missing-container', 'converted', 'fishing-rod'] as const) {
  test(`raw self use separates completed input from its effect: ${mode}`, async () => {
    const item = mode === 'fishing-rod' ? 'fishing_rod' : 'water_bucket';
    const f = fixture(item);
    f.onUse(() => {
      if (mode === 'unrelated-pickup') f.inventory.set('dirt', 1);
      if (mode === 'missing-container' || mode === 'converted') f.inventory.set(item, 0);
      if (mode === 'converted') f.inventory.set('bucket', 1);
    });
    const result = await f.adapter.useItemOn(item, { kind: 'self' }, signal());
    assert.equal(result.ok, true);
    assert.equal(f.uses(), 1);
    assert.equal(result.effectEvidence?.verified, mode === 'converted');
    assert.equal(result.effectEvidence?.changed, mode === 'converted');
    assert.ok(!result.effectEvidence?.reasons.some((reason) => reason.includes('dirt')));
  });
}

for (const obstruction of ['stone', 'water', 'lava'] as const) {
  test(`precise collection never acts on a source behind ${obstruction}`, async () => {
    const f = fixture('bucket');
    f.bot.entity.position = new Vec3(0.5, 63, 0.5);
    const source = new Vec3(3, 64, 0);
    f.put('water', source);
    f.put(obstruction, new Vec3(1, 64, 0));
    const result = await f.adapter.useItemOn('bucket', { kind: 'block', pos: source }, signal());
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /^TARGET_NOT_CONFIRMED/);
    assert.equal(f.uses(), 0);
  });
}

test('collection ignores flowing water in the ray and accepts a regenerated source', async () => {
  const f = fixture('bucket');
  f.bot.entity.position = new Vec3(0.5, 63, 0.5);
  const source = new Vec3(3, 64, 0);
  f.put('water', source);
  f.put('water', new Vec3(1, 64, 0), 3);
  f.onUse(() => {
    f.inventory.set('bucket', 0);
    setTimeout(() => f.inventory.set('water_bucket', 1), 350);
  });
  const result = await f.adapter.useItemOn('bucket', { kind: 'block', pos: source }, signal());
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.bot.blockAt(source).name, 'water', 'source persistence is independent of bucket conversion');
  assert.equal(f.uses(), 1);
});

for (const action of ['place', 'collect'] as const) {
  test(`drift while synchronizing the look aborts ${action} before using the bucket`, async () => {
    const f = fixture(action === 'place' ? 'water_bucket' : 'bucket');
    if (action === 'collect') {
      f.bot.entity.position = new Vec3(0.5, 63, 0.5);
      f.put('water', f.target);
    }
    f.bot.waitForTicks = async () => { f.bot.entity.position = f.bot.entity.position.offset(0, 0, 1); };
    const result = action === 'place'
      ? await f.adapter.useBucketAt(f.target, 'water_bucket', signal())
      : await f.adapter.useItemOn('bucket', { kind: 'block', pos: f.target }, signal());
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /使用前实际视线/);
    assert.equal(f.uses(), 0);
  });
}

for (const alternative of [false, true]) {
  test(`precise pouring skips a dry waterloggable support; alternative face: ${alternative}`, async () => {
    const f = fixture();
    const support = f.put('oak_slab', f.target.offset(0, -1, 0), 0, { type: 'top', waterlogged: 'false' });
    assert.equal(support.getProperties().waterlogged, false);
    assert.equal(support.getProperties().type, 'top');
    if (alternative) f.put('stone', f.target.offset(1, 0, 0));
    f.onUse(() => {
      const eye = f.bot.entity.position.offset(0, f.bot.entity.eyeHeight, 0);
      const { yaw, pitch } = f.bot.entity;
      const hit = f.bot.world.raycast(eye, new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)), 4.4);
      assert.equal(hit.name, 'stone', 'the packet must target the compatible face, never waterlog the support');
      f.inventory.set('water_bucket', 0);
      f.inventory.set('bucket', 1);
      f.put('water', f.target);
    });
    const result = await f.adapter.useBucketAt(f.target, 'water_bucket', signal());
    assert.equal(result.ok, alternative, result.reason);
    assert.equal(f.uses(), alternative ? 1 : 0);
    assert.equal(support.getProperties().waterlogged, false);
    if (!alternative) assert.match(result.reason ?? '', /^NO_PLACEMENT_FACE/);
  });
}

for (const name of ['oak_slab', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {
  test(`precise collection cannot shoot through the source water inside ${name}`, async () => {
    const f = fixture('bucket');
    f.bot.entity.position = new Vec3(0.5, 63, 0.5);
    const source = new Vec3(3, 64, 0);
    f.put('water', source);
    f.put(name, new Vec3(1, 64, 0), 0, name === 'oak_slab' ? { type: 'bottom', waterlogged: 'true' } : undefined);
    const result = await f.adapter.useItemOn('bucket', { kind: 'block', pos: source }, signal());
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /^TARGET_NOT_CONFIRMED/);
    assert.equal(f.uses(), 0);
    assert.equal(f.inventory.get('bucket'), 1);
  });
}

test('precise collection can see a source through the upper gap of a dry bottom slab', async () => {
  const f = fixture('bucket');
  f.bot.entity.position = new Vec3(0.5, 63, 0.5);
  const source = new Vec3(3, 64, 0);
  f.put('water', source);
  f.put('oak_slab', new Vec3(1, 64, 0), 0, { type: 'bottom', waterlogged: 'false' });
  f.onUse(() => { f.inventory.set('bucket', 0); f.inventory.set('water_bucket', 1); });
  const result = await f.adapter.useItemOn('bucket', { kind: 'block', pos: source }, signal());
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.uses(), 1);
});
