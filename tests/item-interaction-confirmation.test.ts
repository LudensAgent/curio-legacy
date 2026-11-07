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
    async lookAt() {}, waitForTicks: async () => {},
    supportFeature: () => false, _genericPlace: async () => {}, swingArm: () => {},
    _client: { write() {} },
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

test('placement failure names the actual blocked face instead of only saying line of sight failed', async () => {
  // 近处有可贴面，但视线先碰到另一格：失败回执要说出挡住的方块和坐标。
  {
    const w = fixture(), target = new Vec3(2, 64, 0);
    w.put('stone', new Vec3(1, 64, 0));
    w.bot.world = { raycast: () => ({ position: new Vec3(1, 64, 0), face: 5 }) };
    const result = await w.adapter.placeBlockAt(target, ['cobblestone'], new AbortController().signal);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /被 stone \(1,64,0\) 挡住/);
  }
  // 唯一可贴面太远：要报出实际距离，便于心智决定靠近或换面。
  {
    const w = fixture(), target = new Vec3(20, 64, 0);
    w.put('stone', new Vec3(20, 63, 0));
    const result = await w.adapter.placeBlockAt(target, ['cobblestone'], new AbortController().signal);
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /距眼睛 [\d.]+ 格（超过 4\.4）/);
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

test('boat and raft placement forces the look at the water surface then sends use_item and confirms the boat', async () => {
  for (const item of ['oak_boat', 'bamboo_raft']) {
    const f = fixture(item), water = new Vec3(3, 62, 0);
    f.put('water', water, { level: 0 });
    const looks: any[] = [];
    f.bot.lookAt = async (point: any, force: any) => { looks.push({ point, force }); };
    f.bot._client.write = async (name: string, params: any) => {
      assert.equal(name, 'use_item', '放船要发 use_item（右键用物品）而不是 block_place');
      assert.deepEqual(params, { hand: 0 });
      f.bot.entities[88] = { id: 88, name: 'boat', position: water.offset(0.5, 0.9, 0.5) };
    };
    const pending = f.adapter.useItemOn(item, { kind: 'block', pos: water }, new AbortController().signal);
    await flush();
    const result = await pending;
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.spawned, 'boat');
    // 液面在 y+8/9；瞄 0.85 与放桶路径一致，瞄 y+1 在斜视时会从水面上方掠过。
    assert.ok(looks.some((l) => l.force === true && l.point.distanceTo(water.offset(0.5, 0.85, 0.5)) < 0.01), '强制看向水面（略低于 8/9 液面）');
    assert.equal(result.effectEvidence?.changed, true);
  }
});

test('boat placement reports ENTITY_NOT_SPAWNED without treating an existing boat as new', async () => {
  const f = fixture('oak_boat'), water = new Vec3(3, 62, 0);
  f.put('water', water);
  f.bot.entities[77] = { id: 77, name: 'boat', position: water.offset(0.5, 0.9, 0.5) };
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: water }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /ENTITY_NOT_SPAWNED/);
  assert.equal(result.effectEvidence?.changed, false);
});

test('boat placement succeeds when the item is consumed even if the entity is not yet tracked', async () => {
  const f = fixture('oak_boat'), water = new Vec3(3, 62, 0);
  f.put('water', water);
  f.bot._client.write = async () => { f.consume(); };
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: water }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.spawned, 'oak_boat', '没确认实体但背包已扣船，仍按放置成功并报物品名');
  assert.equal(result.effectEvidence?.changed, true);
});

test('cancelled boat placement aborts without reporting a spawned boat', async () => {
  const f = fixture('oak_boat'), water = new Vec3(3, 62, 0), controller = new AbortController();
  f.put('water', water);
  let resume!: () => void;
  f.bot._client.write = () => new Promise<void>((resolve) => { resume = resolve; });
  const pending = f.adapter.useItemOn('oak_boat', { kind: 'block', pos: water }, controller.signal);
  await flush(); controller.abort('replaced'); f.adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  resume(); await flush();
});

test('tree sapling use_item confirms placement on valid soil and rejects non-soil before placing', async (t) => {
  const advance = clock(t);
  // 草方块顶面：真实 placeItemAgainst 选顶面，确认目标格出现树苗且背包减少。
  const ok = fixture('oak_sapling');
  const pending = ok.adapter.useItemOn('oak_sapling', { kind: 'block', pos: ok.ground }, new AbortController().signal);
  await advance();
  const placed = await pending;
  assert.equal(placed.ok, true, placed.reason);
  assert.deepEqual(placed.placed, { x: 2, y: 64, z: 0 });
  assert.equal(placed.effectEvidence?.changed, true);
  assert.equal(ok.count(), 3);
  assert.equal(ok.placements(), 1);

  // 非土壤/仅红树苗可用的黏土：在发送放置前就报 BAD_SUPPORT，普通树苗不会误放。
  for (const [item, soil] of [['oak_sapling', 'stone'], ['oak_sapling', 'clay'], ['mangrove_propagule', 'stone']] as const) {
    const bad = fixture(item);
    bad.put(soil, bad.ground);
    const r = await bad.adapter.useItemOn(item, { kind: 'block', pos: bad.ground }, new AbortController().signal);
    assert.equal(r.ok, false, `${item}/${soil}`);
    assert.match(r.reason ?? '', /^BAD_SUPPORT/, `${item}/${soil}: ${r.reason}`);
    assert.match(r.reason ?? '', new RegExp(soil));
    assert.equal(bad.placements(), 0, `${item}/${soil} 不应发送放置`);
  }

  // 红树苗可以种在黏土上。
  const mangrove = fixture('mangrove_propagule');
  mangrove.put('clay', mangrove.ground);
  const mangrovePending = mangrove.adapter.useItemOn('mangrove_propagule', { kind: 'block', pos: mangrove.ground }, new AbortController().signal);
  await advance();
  const mangroveResult = await mangrovePending;
  assert.equal(mangroveResult.ok, true, mangroveResult.reason);
  assert.deepEqual(mangroveResult.placed, { x: 2, y: 64, z: 0 });
  assert.equal(mangrove.count(), 3);
});
