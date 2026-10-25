import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url), Vec3 = require('vec3').Vec3;
const flush = async () => { await setImmediate(); };

// Packet-operation stubs and acknowledged state only; no physics/game loop.
function fixture(item = 'cobblestone') {
  const registry = require('minecraft-data')('1.20.1'), cells = new Map<string, any>();
  let count = 4, placements = 0, activations = 0;
  const put = (name: string, position: any, properties: Record<string, unknown> = {}) => cells.set(position.toString(), { name, position, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => properties });
  const ground = new Vec3(2, 63, 0), dest = ground.offset(0, 1, 0);
  put('grass_block', ground);
  const bot: any = {
    game: { dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {},
    inventory: { items: () => count ? [{ name: item, type: registry.itemsByName[item].id, count }] : [], emptySlotCount: () => 20 },
    blockAt: (p: any) => cells.get(p.floored().toString()) ?? { name: 'air', position: p.floored(), boundingBox: 'empty', getProperties: () => ({}) },
    async equip(held: any) { bot.heldItem = held; },
    async placeBlock(reference: any, face: any) { placements++; assert.deepEqual(face, new Vec3(0, 1, 0)); put(item, reference.position.plus(face)); count--; },
    async activateBlock() { activations++; },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; (adapter as any).connectedFlag = true;
  adapter.moveTo = async () => {};
  return { adapter, bot, ground, dest, put, count: () => count, consume: () => { count--; }, placements: () => placements, activations: () => activations };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  return async () => { await flush(); t.mock.timers.tick(1300); await flush(); };
}

test('use_item places one block on a real face and confirms world, paired blocks and inventory instead of a right-click acknowledgement', async (t) => {
  const advance = clock(t);
  for (const mode of ['placed', 'door', 'nothing', 'consumed_only', 'missing_upper']) {
    const w = fixture(mode === 'door' || mode === 'missing_upper' ? 'birch_door' : 'cobblestone');
    if (mode !== 'placed') w.bot.placeBlock = async (_reference: any, face: any) => {
      assert.deepEqual(face, new Vec3(0, 1, 0));
      if (mode !== 'nothing') w.consume();
      if (mode === 'door' || mode === 'missing_upper') w.put('birch_door', w.dest, { half: 'lower' });
      if (mode === 'door') w.put('birch_door', w.dest.offset(0, 1, 0), { half: 'upper' });
    };
    const pending = w.adapter.useItemOn(mode === 'door' || mode === 'missing_upper' ? 'birch_door' : 'cobblestone', { kind: 'block', pos: w.ground }, new AbortController().signal);
    await advance();
    const result = await pending;
    assert.equal(result.ok, mode === 'placed' || mode === 'door', `${mode}: ${result.reason}`);
    assert.equal(w.activations(), 0, 'block placement must use placeBlock rather than the unacknowledged activateBlock API');
    assert.equal(result.effectEvidence?.verified, true);
    if (result.ok) { assert.deepEqual(result.placed, { x: 2, y: 64, z: 0 }); assert.equal(result.effectEvidence?.changed, true); }
    if (mode === 'nothing') assert.equal(result.effectEvidence?.changed, false);
  }
});

test('empty-hand door use requires an observed open-state change and refuses a packet with no effect', async (t) => {
  const advance = clock(t);
  for (const changes of [true, false]) {
    const w = fixture(), pos = w.dest;
    w.put('birch_door', pos, { open: false, half: 'lower' });
    w.bot.activateBlock = async () => { if (changes) w.put('birch_door', pos, { open: true, half: 'lower' }); };
    const pending = w.adapter.useBlockAt(pos, '', new AbortController().signal);
    await advance(); const result = await pending;
    assert.equal(result.ok, changes);
    assert.equal(result.effectEvidence?.changed, changes);
    if (!changes) assert.match(result.reason ?? '', /DOOR_STATE_UNCHANGED/);
  }
});

test('cancelled placement cannot send a late packet or report a confirmed block', async () => {
  const w = fixture(), controller = new AbortController();
  let resume!: () => void, packets = 0;
  w.bot._client = { write() { packets++; } };
  w.bot.placeBlock = async () => { await new Promise<void>((resolve) => { resume = resolve; }); w.bot._client.write('block_place', {}); };
  const pending = w.adapter.useItemOn('cobblestone', { kind: 'block', pos: w.ground }, controller.signal);
  await flush(); w.adapter.stopAll(); controller.abort('replaced');
  await assert.rejects(pending, { name: 'AbortedError' });
  resume(); await flush();
  assert.equal(packets, 0);
});

test('放船：先转头、等转头发到服务器，再发放置包；mineflayer 因为别的实体先出现而误报失败时，自己认出新出现的船', async () => {
  const f = fixture('oak_boat');
  const water = new Vec3(3, 62, 0);
  f.put('water', water);
  const order: string[] = [];
  f.bot.lookAt = async (_p: any, force: boolean) => { order.push(`look:${force}`); };
  f.bot.waitForTicks = async (n: number) => { order.push(`ticks:${n}`); };
  f.bot.placeEntity = async () => {
    order.push('place');
    f.bot.entities[77] = { id: 77, name: 'boat', position: water.offset(0.5, 1, 0.5) };
    throw new Error('Failed to place entity');
  };
  const r = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: { x: 3, y: 62, z: 0 } }, new AbortController().signal);
  assert.deepEqual(order, ['look:true', 'ticks:2', 'place']);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.spawned, 'boat');
});
