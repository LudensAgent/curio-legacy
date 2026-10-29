import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BlockObservation, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { chestLocation, chestRecollectionLocation, describeChest, describeRecall } from '../src/memory/chest-memory.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { myFacilities } from '../src/mind/facilities.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { storeItems, takeItems } from '../src/skills/economy.ts';
import { digAt, placeAt } from '../src/skills/primitives.ts';
import { rememberStation } from '../src/skills/stations.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const box = { x: 3, y: 64, z: 0 };

function fixture() {
  const world = new TestWorld(), memory = new WorldMemory(null);
  memory.setWorld(world.worldId);
  world.setBlock(box, 'chest');
  const ctx = makeCtx(world, { memory, senses: { observeBlocks: (positions) => positions.map((pos): BlockObservation => ({
    name: world.blockAt(pos), properties: {}, pos, worldId: world.worldId, dimension: world.dim,
    sessionId: world.sessionId, observationId: 1, observedAt: Date.now(), source: 'vision',
  })) } });
  return { world, memory, ctx };
}

test('long-term resource landmarks remain addressable after the short visual cache expires', (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld('w');
  const landmark = memory.addLandmark('resource', 'iron_ore', 'overworld', box)!;
  landmark.ts = Date.now() - 16 * 60_000;
  assert.equal(memory.findLandmark(landmark.id, 'overworld')?.id, landmark.id);
  assert.equal(memory.findLandmark('iron_ore', 'overworld')?.id, landmark.id);
  assert.equal(memory.resourceLandmarksNear(['iron_ore'], 'overworld', box, 10).length, 1);
  assert.equal(memory.findLandmark(landmark.id, 'the_nether'), undefined);
});

test('chest location stays precise within a session then becomes an honest area; old item traces are forgotten', (t) => {
  const memory = new WorldMemory(null), now = Date.now(), pos = { x: 123, y: 67, z: -234 };
  t.after(() => memory.close());
  memory.setWorld('w');
  // 一个直播会话内（< 24 现实小时）：位置精确
  const record = memory.noteChestUse('overworld', pos, { put: [{ name: 'diamond', count: 64 }], now: now - 25 * 3600_000 });
  assert.equal(chestLocation(record, { now: record.ts + 1000 }).precise, true);
  // 超过 24 现实小时：位置淡化成诚实区域
  const area = chestLocation(record, { now });
  assert.equal(area.precise, false);
  assert.equal(area.radius, 24);
  assert.ok(Math.hypot(pos.x - area.pos.x, pos.y - area.pos.y, pos.z - area.pos.z) <= area.radius);
  assert.doesNotMatch(describeChest(record, { now, op: 1 }), /123,67,-234/);
  assert.match(describeChest(record, { now, op: 1 }), /范围中心，不是箱子坐标/);
  // 物品印象按游戏日淡忘（比位置快）：25 小时前的 diamond 已经想不起、也不会重获精确关联
  assert.equal(memory.recallChests('diamond').length, 0);
  assert.equal(chestRecollectionLocation(record, memory.chestClock()).precise, false);
  assert.doesNotMatch(describeChest(record, memory.chestClock()), /123,67,-234/);
  const facilities = myFacilities(memory, { worldId: 'w', dim: 'overworld', pos }, ['chest']);
  assert.equal(facilities[0].precise, false);
  assert.notDeepEqual(facilities[0].pos, pos);
});

test('v3 memory reads without rewriting history or claiming an old chest was just seen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memory-container-'));
  const file = path.join(directory, 'world-memory.json'), ts = Date.now() - 25 * 3600_000;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ version: 3, worldId: 'w', chests: { 'w:overworld:3,64,0': {
    worldId: 'w', dim: 'overworld', pos: box, ts, uses: 1, traces: [{ item: 'coal', kind: 'put', qty: 'some', ts, op: 1, times: 1 }],
  } } }));
  const original = fs.readFileSync(file, 'utf8');
  const memory = new WorldMemory(file);
  assert.equal(memory.chests()[0].ts, ts);
  assert.equal(memory.chests()[0].traces[0].ts, ts);
  assert.equal(chestLocation(memory.chests()[0]).precise, false);
  memory.close();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('unopened historical containers are candidates and facilities without automatically opening them', async (t) => {
  const { world, memory, ctx } = fixture(), pos = { x: 123, y: 67, z: 234 };
  t.after(() => memory.close());
  const landmark = memory.addLandmark('discovery', '我的箱子', world.dim, pos, 1)!;
  landmark.ts = Date.now() - 25 * 3600_000;
  ctx.senses.knownBlocks = () => [];
  ctx.senses.observeBlocks = () => [];
  let opened = 0;
  world.useChest = async () => { opened++; return { ok: false, reason: 'should not open', contents: [], moved: 0 }; };
  const result = await takeItems.run(ctx, { item: 'coal', count: 1 });
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.equal(opened, 0);
  const candidates = result.data?.candidates as { location: { precise: boolean }; contents: string; target?: unknown }[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].location.precise, false);
  assert.equal(candidates[0].target, undefined);
  assert.match(candidates[0].contents, /内容未知/);
  assert.doesNotMatch(JSON.stringify(result.data), /"x":123/);
  const facilities = myFacilities(memory, world.state(), ['chest']);
  assert.equal(facilities.length, 1);
  assert.equal(facilities[0].precise, false);
  assert.match(facilities[0].text, /内容未知/);
  const recalledLandmark = memory.findLandmark(landmark.id, world.dim)!;
  assert.equal(recalledLandmark.precise, false);
  assert.equal(recalledLandmark.radius, 24);
  assert.notDeepEqual(recalledLandmark.pos, pos);
  assert.deepEqual(memory.landmarks().find((l) => l.id === landmark.id)?.pos, pos, 'raw observation stays unchanged for identity and later confirmation');
  const selected = await takeItems.run(ctx, { item: 'coal', count: 1, target: landmark.id });
  assert.equal(selected.failureCode, 'NOT_FOUND');
  assert.equal(opened, 0, 'an old landmark ID cannot smuggle its private exact position into execution');
});

test('explicit container selection neither breaks a blocked lid nor substitutes another box', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  world.setBlock({ ...box, y: box.y + 1 }, 'stone');
  world.setBlock({ ...box, x: 5 }, 'chest');
  world.chests.set('5,64,0', new Map([['coal', 12]]));
  const opened: Vec3Like[] = [], useChest = world.useChest.bind(world);
  world.useChest = async (...args) => { opened.push(args[0]); return useChest(...args); };
  const result = await takeItems.run(ctx, { item: 'coal', count: 2, target: box });
  assert.equal(result.status, 'failed');
  assert.deepEqual(opened, [box]);
  assert.equal(world.blockAt({ ...box, y: box.y + 1 }), 'stone');
  assert.ok(!world.actions.some((action) => /dig|craft|place/.test(action)));
  const unselected = await storeItems.run(ctx, { items: [{ name: 'coal' }] });
  assert.equal(unselected.failureCode, 'BAD_ARGS');
  assert.deepEqual(opened, [box]);
});

test('fresh observations invalidate only the vanished box during explicit selection or candidate listing', async (t) => {
  await Promise.all([true, false].map(async (explicit) => {
    const { world, memory, ctx } = fixture(), adjacent = { ...box, x: box.x + 1 };
    t.after(() => memory.close());
    const landmark = memory.addLandmark('discovery', '我的箱子', world.dim, box, 1)!;
    memory.addLandmark('discovery', '我的箱子', world.dim, adjacent, 1);
    memory.noteChestUse(world.dim, box, { put: [{ name: 'coal', count: 2 }] });
    memory.noteChestUse(world.dim, adjacent, { put: [{ name: 'coal', count: 3 }] });
    world.setBlock(adjacent, 'chest');
    world.setBlock(box, 'stone');
    const result = await takeItems.run(ctx, { item: 'coal', count: 1, ...(explicit ? { target: landmark.id } : {}) });
    assert.equal(result.failureCode, explicit ? 'TARGET_GONE' : 'BAD_ARGS');
    assert.equal(memory.chestAt(world.dim, box), undefined);
    assert.ok(!memory.landmarks().some((l) => l.id === landmark.id));
    assert.ok(memory.chestAt(world.dim, adjacent));
    assert.ok(memory.landmarks().some((l) => l.pos.x === adjacent.x && l.pos.y === adjacent.y && l.pos.z === adjacent.z));
  }));
});

test('seeing a natural chest next to an owned chest preserves both physical locations', (t) => {
  const { world, memory, ctx } = fixture(), adjacent = { ...box, z: box.z + 1 };
  t.after(() => memory.close());
  world.setBlock(adjacent, 'chest');
  rememberStation(ctx, 'chest', box);
  new Perception(world, memory, new EventBus(), new Vision(world)).update();
  const containers = memory.landmarks().filter((l) => l.label === '箱子' || l.label === '我的箱子');
  assert.equal(containers.length, 2);
  assert.ok(containers.some((l) => l.label === '我的箱子' && l.pos.z === box.z));
  assert.ok(containers.some((l) => l.label === '箱子' && l.pos.z === adjacent.z));
  rememberStation(ctx, 'chest', adjacent);
  assert.equal(memory.landmarks().filter((l) => l.label === '我的箱子').length, 2);
  assert.equal(memory.landmarks().filter((l) => l.label === '箱子').length, 0, 'only the same-cell plain twin is replaced');
});

test('placing two adjacent containers keeps both, and digging one invalidates only its own location', async (t) => {
  const { world, memory, ctx } = fixture(), first = { x: 1, y: 64, z: 0 }, adjacent = { x: 1, y: 64, z: 1 };
  t.after(() => memory.close());
  world.inv.set('chest', 2);
  assert.equal((await placeAt.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'chest' })).status, 'succeeded');
  assert.equal((await placeAt.run(ctx, { at: [1, 0, 1], facing: 'E', item: 'chest' })).status, 'succeeded');
  assert.equal(memory.landmarks().filter((l) => l.label === '我的箱子').length, 2);
  [first, adjacent].forEach((pos) => memory.noteChestUse(world.dim, pos, { put: [{ name: 'coal', count: 1 }] }));
  world.dig = async (pos) => { world.setBlock(pos, 'air'); world.inv.set('chest', 1); return { ok: true }; };
  assert.equal((await digAt.run(ctx, { at: [1, 0, 0], facing: 'E', own: true })).status, 'succeeded');
  assert.equal(memory.chestAt(world.dim, first), undefined);
  assert.ok(memory.chestAt(world.dim, adjacent));
  assert.deepEqual(memory.landmarks().filter((l) => l.label === '我的箱子').map((l) => l.pos), [adjacent]);
});

test('placing a solid block directly above a chest is refused to keep the lid usable', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  world.inv.set('cobblestone', 4);
  world.setBlock({ x: 1, y: 64, z: 0 }, 'chest');
  const result = await placeAt.run(ctx, { at: [1, 1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.equal(world.blockAt({ x: 1, y: 65, z: 0 }), 'air', '正上方没有被盖上');
  // 火把这类贴墙挂件不挡箱盖，照常放
  world.inv.set('torch', 1);
  const torch = await placeAt.run(ctx, { at: [1, 1, 0], facing: 'E', item: 'torch' });
  assert.equal(torch.status, 'succeeded');
});

test('loading own/plain container twins removes only the duplicate at the identical cell', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-container-twins-')), file = path.join(directory, 'world-memory.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adjacent = { ...box, z: box.z + 1 };
  fs.writeFileSync(file, JSON.stringify({ version: 3, worldId: 'w', landmarks: [
    { id: 'own', kind: 'discovery', label: '我的箱子', worldId: 'w', dim: 'overworld', pos: box, ts: 100 },
    { id: 'same', kind: 'discovery', label: '箱子', worldId: 'w', dim: 'overworld', pos: box, ts: 100 },
    { id: 'next', kind: 'discovery', label: '箱子', worldId: 'w', dim: 'overworld', pos: adjacent, ts: 100 },
  ] }));
  const memory = new WorldMemory(file);
  assert.deepEqual(memory.landmarks().map((l) => l.id).sort(), ['next', 'own']);
  assert.ok(memory.landmarks().every((l) => l.ts === 100));
  memory.close();
});

test('partial storage records only the actual transfer even when the request fails', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  world.inv.set('coal', 10);
  world.inv.set('diamond', 3);
  ctx.adapter.useChest = async () => {
    world.inv.set('coal', 8);
    return { ok: false, reason: 'PARTIAL', contents: [{ name: 'coal', count: 2 }], moved: 2 };
  };
  const result = await storeItems.run(ctx, { target: box, items: [{ name: 'coal', count: 10 }, { name: 'diamond', count: 3 }] });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.data?.put, [{ name: 'coal', count: 2 }]);
  assert.ok(memory.chests()[0].traces.some((trace) => trace.item === 'coal' && trace.kind === 'put' && trace.qty === 'few'));
  assert.ok(!memory.chests()[0].traces.some((trace) => trace.item === 'diamond'));
});

test('a confirmed partial transfer remains remembered when execution is cancelled', async (t) => {
  const { world, memory, ctx } = fixture();
  t.after(() => memory.close());
  world.inv.set('coal', 10);
  ctx.adapter.useChest = async (_pos, _put, _took, _signal, options) => {
    options?.onContainer?.({ block: 'chest', before: [], after: [{ name: 'coal', count: 2 }], put: [{ name: 'coal', count: 2 }], took: [] });
    const error = new Error('cancelled'); error.name = 'AbortedError'; throw error;
  };
  await assert.rejects(storeItems.run(ctx, { target: box, items: [{ name: 'coal', count: 10 }] }), /cancelled/);
  assert.ok(memory.chests()[0].traces.some((trace) => trace.item === 'coal' && trace.kind === 'put' && trace.qty === 'few'));
});
