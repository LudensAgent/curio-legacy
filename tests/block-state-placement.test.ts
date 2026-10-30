import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { sleep } from '../src/util.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Vec3 = require('vec3').Vec3;
const injectGeneric = require('mineflayer/lib/plugins/generic_place.js');
const injectPlacement = require('mineflayer/lib/plugins/place_block.js');

/** Runs the installed Mineflayer placement and packet code against a tiny
 * acknowledged server model, rather than treating FakeAdapter as placement QA. */
function setup(name: string, options: { neighborShape?: string; omitBedHead?: boolean; equipWait?: Promise<void> } = {}) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const bot: any = new EventEmitter();
  const cells = new Map<string, any>();
  const packets: any[] = [];
  const turns: number[] = [];
  const sentTicks: number[] = [];
  let serverYaw = 0;
  const target = new Vec3(4, 65, 0);
  const make = (name: string, position: any, properties: Record<string, unknown> = {}) => ({ name, type: data.blocksByName[name]?.id ?? 0, position, boundingBox: ['air', 'cave_air'].includes(name) ? 'empty' : 'block', getProperties: () => properties });
  const put = (name: string, position: any, properties: Record<string, unknown> = {}) => { cells.set(position.toString(), make(name, position, properties)); };
  bot.registry = data;
  bot.entity = { position: new Vec3(1, 65, 0), yaw: 0 };
  bot.game = { dimension: 'overworld' };
  bot.inventory = { items: () => [{ name, type: data.itemsByName[name].id, count: 5 }] };
  bot.blockAt = (position: any) => cells.get(position.toString()) ?? make('air', position);
  bot.supportFeature = (feature: string) => feature === 'blockPlaceHasInsideBlock';
  bot.equip = async (item: any) => { if (options.equipWait) await options.equipWait; bot.heldItem = item; };
  bot.look = async (yaw: number) => { turns.push(yaw); bot.entity.yaw = yaw; };
  // Match the installed physics plugin: force-look changes local yaw now, but
  // the server learns it only on the subsequent physics update.
  bot.waitForTicks = async (count: number) => { sentTicks.push(count); serverYaw = bot.entity.yaw; };
  bot.lookAt = async () => { throw new Error('stateful placement must preserve the chosen orientation'); };
  bot.swingArm = () => {};
  const facing = () => Math.abs(serverYaw + Math.PI / 2) < 0.1 ? 'east' : Math.abs(serverYaw - Math.PI / 2) < 0.1 ? 'west' : Math.abs(serverYaw) < 0.1 ? 'north' : 'south';
  bot._client = { write(packetName: string, packet: any) {
    packets.push({ name: packetName, ...packet });
    if (packetName !== 'block_place') return;
    const face = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)][packet.direction];
    const position = packet.location.plus(face);
    const old = bot.blockAt(position);
    const material = bot.heldItem.name;
    const half = packet.direction === 0 || packet.direction > 1 && packet.cursorY > 0.5 ? 'top' : 'bottom';
    const left = facing() === 'north' ? packet.cursorX < 0.5 : facing() === 'east' ? packet.cursorZ < 0.5 : facing() === 'south' ? packet.cursorX > 0.5 : packet.cursorZ > 0.5;
    const properties: Record<string, unknown> = material.endsWith('_stairs') ? { facing: facing(), half, shape: options.neighborShape ?? 'straight', waterlogged: false } : material.endsWith('_slab') ? { type: half, waterlogged: false } : material.endsWith('_bed') ? { facing: facing(), part: 'foot', occupied: false } : material.endsWith('_fence_gate') ? { facing: facing(), open: false, powered: false, in_wall: false } : { facing: facing(), half: 'lower', hinge: left ? 'left' : 'right', open: false, powered: false };
    setTimeout(() => {
      put(material, position, properties);
      if (material.endsWith('_bed') && !options.omitBedHead) {
        const offsets: Record<string, any> = { north: new Vec3(0, 0, -1), east: new Vec3(1, 0, 0), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0) };
        put(material, position.plus(offsets[facing()]), { ...properties, part: 'head' });
      }
      if (material.endsWith('_door')) put(material, position.offset(0, 1, 0), { ...properties, half: 'upper' });
      const reference = bot.blockAt(packet.location);
      bot.emit(`blockUpdate:${packet.location}`, reference, reference);
      bot.emit(`blockUpdate:${position}`, old, bot.blockAt(position));
    }, 0);
  } };
  injectGeneric(bot);
  injectPlacement(bot);
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  return { adapter, bot, target, put, packets, turns, sentTicks };
}

test('installed Mineflayer placement receives forced stair facing and correct underside click for a top half', async () => {
  const { adapter, target, put, packets, turns, sentTicks } = setup('oak_stairs');
  put('stone', target.offset(0, 1, 0));
  const result = await adapter.placeBlockStateAt(target, 'oak_stairs', { facing: 'east', half: 'top', shape: 'straight', waterlogged: false }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(turns[0], -Math.PI / 2);
  assert.deepEqual(sentTicks, [1]);
  assert.equal(packets[0].direction, 0);
  assert.equal(packets[0].cursorY, 0);
  assert.equal(adapter.blockStateAt(target)?.properties.half, 'top');
});

test('side-supported top slabs use the upper cursor half and bottom slabs use a top support face', async () => {
  const upper = setup('stone_slab');
  upper.put('stone', upper.target.offset(1, 0, 0));
  const top = await upper.adapter.placeBlockStateAt(upper.target, 'stone_slab', { type: 'top', waterlogged: false }, new AbortController().signal);
  assert.equal(top.ok, true, top.reason);
  assert.equal(upper.packets[0].direction, 4);
  assert.equal(upper.packets[0].cursorY, 0.75);
  const lower = setup('stone_slab');
  lower.put('stone', lower.target.offset(0, -1, 0));
  const bottom = await lower.adapter.placeBlockStateAt(lower.target, 'stone_slab', { type: 'bottom' }, new AbortController().signal);
  assert.equal(bottom.ok, true, bottom.reason);
  assert.equal(lower.packets[0].direction, 1);
  assert.equal(lower.packets[0].cursorY, 1);
});

test('neighbor-derived stair shapes fail exact verification and double slabs are never silently manufactured', async () => {
  const curved = setup('oak_stairs', { neighborShape: 'inner_left' });
  curved.put('stone', curved.target.offset(0, -1, 0));
  const mismatch = await curved.adapter.placeBlockStateAt(curved.target, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' }, new AbortController().signal);
  assert.equal(mismatch.reason, 'BLOCK_STATE_MISMATCH');
  const unsupported = setup('oak_stairs');
  unsupported.put('stone', unsupported.target.offset(0, -1, 0));
  assert.equal((await unsupported.adapter.placeBlockStateAt(unsupported.target, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'outer_right' }, new AbortController().signal)).reason, 'UNSUPPORTED_BLOCK_STATE');
  assert.deepEqual(unsupported.packets, []);
  const double = setup('stone_slab');
  double.put('stone', double.target.offset(0, -1, 0));
  assert.equal((await double.adapter.placeBlockStateAt(double.target, 'stone_slab', { type: 'double' }, new AbortController().signal)).reason, 'UNSUPPORTED_BLOCK_STATE');
  assert.deepEqual(double.packets, []);
});

test('bed placement verifies both actual foot and facing-offset head from one installed placement call', async () => {
  const { adapter, target, put, packets } = setup('red_bed');
  put('stone', target.offset(0, -1, 0)); put('stone', target.offset(0, -1, -1));
  const result = await adapter.placeBlockStateAt(target, 'red_bed', { facing: 'north', part: 'foot', occupied: false }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(packets.length, 1);
  assert.equal(adapter.blockStateAt(target.offset(0, 0, -1))?.properties.part, 'head');
  assert.equal(adapter.blockStateAt(target.offset(0, 0, -1))?.properties.facing, 'north');
});

test('bed placement rejects an obstructed footprint and cannot accept a missing head update', async () => {
  const blocked = setup('red_bed');
  blocked.put('stone', blocked.target.offset(0, -1, 0)); blocked.put('stone', blocked.target.offset(0, -1, -1)); blocked.put('chest', blocked.target.offset(0, 0, -1));
  assert.equal((await blocked.adapter.placeBlockStateAt(blocked.target, 'red_bed', { facing: 'north', part: 'foot' }, new AbortController().signal)).reason, 'BLOCKED');
  assert.deepEqual(blocked.packets, []);
  const incomplete = setup('red_bed', { omitBedHead: true });
  incomplete.put('stone', incomplete.target.offset(0, -1, 0)); incomplete.put('stone', incomplete.target.offset(0, -1, -1));
  assert.equal((await incomplete.adapter.placeBlockStateAt(incomplete.target, 'red_bed', { facing: 'north', part: 'foot' }, new AbortController().signal)).reason, 'BLOCK_STATE_MISMATCH');
});

test('door packets choose the requested hinge quarter at all four forced orientations', async () => {
  const expected: Record<string, [number, number]> = { north: [0.25, 0.5], east: [0.5, 0.25], south: [0.75, 0.5], west: [0.5, 0.75] };
  for (const [facing, [x, z]] of Object.entries(expected)) for (const hinge of ['left', 'right']) {
    const { adapter, target, put, packets } = setup('oak_door');
    put('stone', target.offset(0, -1, 0));
    const result = await adapter.placeBlockStateAt(target, 'oak_door', { facing, half: 'lower', hinge, open: false }, new AbortController().signal);
    assert.equal(result.ok, true, `${facing}/${hinge}: ${result.reason}`);
    assert.equal(packets[0].cursorX, hinge === 'left' ? x : 1 - x);
    assert.equal(packets[0].cursorZ, hinge === 'left' ? z : 1 - z);
    assert.equal(adapter.blockStateAt(target)?.properties.hinge, hinge);
    assert.equal(adapter.blockStateAt(target.offset(0, 1, 0))?.properties.hinge, hinge);
  }
});

test('fence gate placement forces the requested facing and stays closed', async () => {
  const { adapter, target, put, packets, turns } = setup('oak_fence_gate');
  put('stone', target.offset(0, -1, 0));
  const result = await adapter.placeBlockStateAt(target, 'oak_fence_gate', { facing: 'east' }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(turns[0], -Math.PI / 2);
  assert.equal(packets[0].direction, 1, '贴着脚下的顶面放');
  assert.equal(adapter.blockStateAt(target)?.properties.facing, 'east');
  assert.equal(adapter.blockStateAt(target)?.properties.open, false);
  assert.equal(adapter.blockStateAt(target)?.properties.half, undefined, '栅栏门没有上下半格');
});

test('enclosed door hinges relocate to an actually supported frontal landing and recheck the exact quarter', async () => {
  const { adapter, bot, target, put, packets } = setup('oak_door');
  const support = target.offset(0, -1, 0);
  put('stone', support); put('stone', target.offset(0, -1, -2));
  bot.world = { raycast: (from: any) => ({ position: from.z < -1 ? support : target.offset(-1, 1, 0) }) };
  let approaches = 0;
  adapter.moveTo = async (goal: any, options) => {
    assert.equal(goal.kind, 'near');
    assert.equal(options.constructionSafe, true);
    assert.equal(goal.pos.y, target.y);
    bot.entity.position = new Vec3(goal.pos.x, goal.pos.y, goal.pos.z);
    approaches++;
  };
  const result = await adapter.placeBlockStateAt(target, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: false }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(approaches, 1);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].cursorX, 0.25);
});

test('cancellation after a door landing movement cannot equip or place afterward', async () => {
  const { adapter, bot, target, put, packets, turns } = setup('oak_door');
  const controller = new AbortController();
  put('stone', target.offset(0, -1, 0)); put('stone', target.offset(0, -1, -2));
  bot.world = { raycast: () => null };
  adapter.moveTo = async () => { controller.abort('paused'); };
  await assert.rejects(adapter.placeBlockStateAt(target, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left' }, controller.signal), { name: 'AbortedError' });
  assert.deepEqual(packets, []);
  assert.deepEqual(turns, []);
  assert.equal(bot.heldItem, undefined);
});

test('cancelled stateful equip cannot emit a later placement packet', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const { adapter, target, put, packets } = setup('oak_stairs', { equipWait: wait });
  put('stone', target.offset(0, -1, 0));
  const controller = new AbortController();
  const pending = adapter.placeBlockStateAt(target, 'oak_stairs', { facing: 'south', half: 'bottom' }, controller.signal);
  controller.abort('paused');
  adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  release(); await sleep(0);
  assert.deepEqual(packets, []);
});
