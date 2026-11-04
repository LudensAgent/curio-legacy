import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { RESOURCE_MEMORY_TTL_MS, Vision } from '../src/perception/vision.ts';
import { surface } from '../src/skills/movement.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Vec3 = require('vec3').Vec3;

function pond(t: TestContext) {
  const { Physics, PlayerState } = require('prismarine-physics');
  const Block = require('prismarine-block')(data);
  let now = 100000, ticks = 0;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const world = { getBlock(position: any) {
    const p = position.floored();
    const name = p.y <= 59 || p.x >= 6 && p.y <= 63 ? 'stone' : p.x < 6 && p.y <= 63 ? 'water' : 'air';
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
    block.position = p; return block;
  } };
  const physics = Physics(data, world);
  const bot: any = {
    version: '1.20.1', game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 60, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: true,
      isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, oxygenLevel: 10,
    inventory: { slots: [] }, pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    blockAt: (p: any) => world.getBlock(p),
    async look(yaw: number, pitch: number) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    async waitForTicks(count: number) {
      for (let i = 0; i < count; i++) {
        physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
        const head = world.getBlock(bot.entity.position.offset(0, 1.62, 0));
        bot.oxygenLevel = head.name === 'water' ? Math.max(0, bot.oxygenLevel - 0.05) : Math.min(20, bot.oxygenLevel + 0.5);
        now += 50; ticks++;
      }
    },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  return { adapter, bot, controls, ticks: () => ticks };
}

test('installed Minecraft physics swims out of a deep pond and remains on dry footing after controls release', async (t) => {
  const { adapter, bot, controls } = pond(t);
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 15000 });
  assert.equal(result.ok, true, `${result.reason}; pos=${bot.entity.position}`);
  assert.equal(result.landed, true);
  assert.ok(result.oxygen >= 18);
  assert.equal(controls.jump, false); assert.equal(controls.forward, false);
  await bot.waitForTicks(60);
  assert.equal(bot.entity.isInWater, false);
  assert.equal(bot.entity.onGround, true);
  assert.ok(bot.entity.position.x >= 6);
});

test('recovered oxygen and a brief airborne breach cannot claim a safe landing without a shore', async (t) => {
  const { adapter, bot, controls } = pond(t);
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 6000 });
  assert.equal(result.ok, false);
  assert.equal(result.landed, false);
  assert.equal(result.reason, 'WATER_ESCAPE_TIMEOUT');
  assert.ok(bot.oxygenLevel >= 18, 'breathing recovery alone is deliberately insufficient');
  assert.equal(controls.jump, false); assert.equal(controls.forward, false);
  await bot.waitForTicks(40);
  assert.equal(bot.entity.isInWater, true, 'this reproduces the old surface-then-sink loop');
});

test('swimming retains buoyancy while ordinary observation discovers a shore after ascent', async (t) => {
  const { adapter, bot, controls } = pond(t);
  let observations = 0, highObservation = false;
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 15000, observeShore: () => {
    observations++;
    assert.equal(controls.jump, true, 'looking for a bank must never release ascent controls');
    if (bot.entity.position.y < 63) return null;
    highObservation = true;
    return { x: 6.5, y: 64, z: 2.5 };
  } });
  assert.ok(observations > 2); assert.equal(highObservation, true);
  assert.equal(result.ok, true); assert.equal(result.landed, true);
  await bot.waitForTicks(60);
  assert.equal(bot.entity.isInWater, false); assert.equal(bot.entity.onGround, true);
});

test('cancelled swimming releases controls and a late physics wait cannot restart them', async (t) => {
  const { adapter, bot, controls } = pond(t);
  let release!: () => void;
  bot.waitForTicks = () => new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const pending = adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, controller.signal);
  await setImmediate();
  controller.abort('paused'); adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  release(); await Promise.resolve();
  assert.equal(controls.jump, false); assert.equal(controls.forward, false);
});

test('known water surfaces and plants are never classified as dry shoreline', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks = [{ name: 'water', pos: { x: 2, y: 64, z: 0 } }, { name: 'short_grass', pos: { x: 3, y: 64, z: 0 } },
    { name: 'stone', pos: { x: 5, y: 64, z: 0 } }];
  const vision = new Vision(adapter);
  vision.scan();
  const known = (vision as any).known;
  known.clear();
  for (const block of adapter.blocks) known.set(`${block.pos.x},${block.pos.y},${block.pos.z}`, { ...block, lastSeen: Date.now() });
  assert.deepEqual(vision.nearestLand(adapter.pos)?.pos, { x: 5, y: 64, z: 0 });
  assert.equal(vision.nearestLand(adapter.pos, [{ x: 5, y: 64, z: 0 }]), null);
  known.get('5,64,0').lastSeen = Date.now() - RESOURCE_MEMORY_TTL_MS - 1;
  assert.equal(vision.nearestLand(adapter.pos), null, 'an expired historical bank is not fresh escape evidence');
});

test('surface keeps ownership after oxygen14 and only reports success after actual dry landing', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  let now = 100000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  adapter.inWater = true; adapter.oxygen = 10;
  adapter.swimTo = async () => {
    calls++; now += 1000;
    adapter.inWater = calls === 2;
    adapter.oxygen = calls === 1 ? 14 : 20;
    return { ok: calls !== 2, landed: calls !== 2, oxygen: adapter.oxygen };
  };
  try {
    const result = await surface.run({ adapter, memory, bus, signal: new AbortController().signal, deadline: now + 32000, taskId: 'surface-reproduction', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [], nearestLand: () => ({ dir: 'E', dist: 5, pos: { x: 5, y: 63, z: 0 } }) } }, {});
    assert.equal(calls, 3); assert.equal(result.status, 'succeeded');
    assert.equal(result.data?.landed, true); assert.match(result.summary, /上岸并站稳/);
  } finally { memory.close(); }
});

test('swimTo to a distant target does not report landed without arriving', async (t) => {
  const { adapter, bot } = pond(t);
  // 角色已在东岸干地上，目标在对岸 6 格外：不应因「已站稳」就报 landed。
  bot.entity.position = new Vec3(6.5, 64, 2.5);
  bot.entity.onGround = true; bot.entity.isInWater = false;
  const result = await adapter.swimTo({ x: 0.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.landed, false, '未抵达远处目标不能报 landed');
});

test('climbing out onto the bank does not keep bunny-hopping on dry land', async (t) => {
  const { adapter, bot } = pond(t);
  const tick = bot.waitForTicks.bind(bot);
  let hops = 0, wasGround = false;
  bot.waitForTicks = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await tick(1);
      const e = bot.entity;
      if (wasGround && !e.onGround && !e.isInWater && e.position.x >= 6) hops++;
      wasGround = e.onGround;
    }
  };
  const result = await adapter.swimTo({ x: 7.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 15000 });
  assert.equal(result.landed, true, `${result.reason}; pos=${bot.entity.position}`);
  assert.equal(hops, 0, `jumped ${hops} times on dry land before settling`);
});

test('surface escape:"shore" never digs the ceiling or hunts air pockets', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  adapter.inWater = true; adapter.oxygen = 10;
  // FakeAdapter 里 y<63 是 stone：站在 y=60 时头顶 y=61 是石头，形成封顶（reachable）
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  let digs = 0;
  adapter.dig = async () => { digs++; return { ok: true }; };
  // 每次游泳/寻路都大步推进时间，让循环尽快耗尽 deadline，避免测试空转
  adapter.swimTo = async () => { now += 40000; return { ok: false, landed: false, oxygen: 10 }; };
  adapter.moveTo = async () => { now += 40000; };
  try {
    const result = await surface.run({ adapter, memory, bus, signal: new AbortController().signal, deadline: now + 32000, taskId: 'surface-shore', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [], nearestLand: () => ({ dir: 'E', dist: 5, pos: { x: 5, y: 63, z: 0 } }) } }, { escape: 'shore' });
    assert.equal(digs, 0, 'escape:"shore" 不得暗中挖开头顶方块');
    assert.equal(result.status, 'failed', result.summary); // 头顶封住且不许挖，未上岸应如实报告
  } finally { memory.close(); }
});

test('stuck in water: correction does not choose a bank or start swimming', async (t) => {
  const { adapter, bot } = pond(t);
  bot.entity.position = new Vec3(5.4, 62.4, 2.5);
  await bot.waitForTicks(4);
  const before = bot.entity.position.clone();
  let swims = 0;
  adapter.swimTo = async () => { swims++; return { ok: false, landed: false, oxygen: 20 }; };
  for (const allowSwimming of [false, true]) {
    const action = await (adapter as any).nudge(new Set(), { signal: new AbortController().signal, timeoutMs: 10000, allowSwimming });
    assert.equal(action, null);
  }
  assert.equal(swims, 0);
  assert.deepEqual(bot.entity.position, before);
  assert.equal(bot.entity.isInWater, true);
});
