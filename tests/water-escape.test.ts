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
import { swimTo } from '../src/skills/actions.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Vec3 = require('vec3').Vec3;

function pond(t: TestContext, opts: { waterTop?: number; bridgeAtY?: number; freeze?: boolean } = {}) {
  const { Physics, PlayerState } = require('prismarine-physics');
  const Block = require('prismarine-block')(data);
  const waterTop = opts.waterTop ?? 63;
  let now = 100000, ticks = 0;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const world = { getBlock(position: any) {
    const p = position.floored();
    const name = p.y <= 59 || p.x >= 6 && p.y <= 63 ? 'stone'
      : p.x < 6 && p.y <= waterTop ? 'water'
      : opts.bridgeAtY !== undefined && p.y === opts.bridgeAtY ? 'cobblestone'
      : 'air';
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
    block.position = p; return block;
  } };
  const physics = Physics(data, world);
  const bot: any = {
    version: '1.20.1', game: { dimension: 'overworld' }, username: 'SwimProbe', health: 20, food: 20,
    entity: { position: new Vec3(2.5, 60, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: true,
      isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, oxygenLevel: 10,
    inventory: { slots: [], items: () => [], emptySlotCount: () => 0 }, pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    blockAt: (p: any) => world.getBlock(p),
    async look(yaw: number, pitch: number) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    async waitForTicks(count: number) {
      for (let i = 0; i < count; i++) {
        if (!opts.freeze) physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
        const head = world.getBlock(bot.entity.position.offset(0, 1.62, 0));
        bot.oxygenLevel = head.name === 'water' ? Math.max(0, bot.oxygenLevel - 0.05) : Math.min(20, bot.oxygenLevel + 0.5);
        now += 50; ticks++;
      }
    },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  return { adapter, bot, controls, ticks: () => ticks, advanceNow: (ms: number) => { now += ms; } };
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

test('vertical ascent reports surfaced without claiming a landing when no shore exists', async (t) => {
  const { adapter, bot, controls } = pond(t);
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 6000 });
  assert.equal(result.ok, true);
  assert.equal(result.surfaced, true, '头稳定露出水面应报告 surfaced');
  assert.equal(result.landed, false, '浮出水面不等于上岸');
  assert.equal(controls.jump, false); assert.equal(controls.forward, false);
  await bot.waitForTicks(40);
  assert.equal(bot.entity.isInWater, true, 'surfaced 不等于离水站稳');
});

test('vertical ascent keeps breathing until oxygen recovers instead of dropping on first head-out', async (t) => {
  const { adapter, bot } = pond(t);
  bot.oxygenLevel = 2;
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 9000 });
  assert.equal(result.ok, true, `${result.reason}; pos=${bot.entity.position}; oxygen=${result.oxygen}`);
  assert.equal(result.surfaced, true);
  assert.ok(result.oxygen >= 12, `换气应持续到氧气可用，实际回来时氧气 ${result.oxygen}`);
  assert.equal(bot.entity.isInWater, true, '持续换气不等于上岸');
});

test('a bridge with an air gap above the head is not reported as a ceiling', async (t) => {
  // 头在 y=60 的水里，上方 y=62 是空气、y=63 才是桥面：能浮到空气里换气，不能按「封顶」早退。
  const { adapter, bot } = pond(t, { waterTop: 61, bridgeAtY: 63, freeze: true });
  bot.oxygenLevel = 0;
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 2600 });
  assert.equal(result.reason, 'WATER_ESCAPE_TIMEOUT', `有空气间隙的桥面不能当成封顶：${result.reason}`);
  assert.equal(result.blockedAbove, undefined);
});

test('a solid block directly over the head is reported as a ceiling', async (t) => {
  // 水面上方 y=62 直接是实心方块：头没有任何空气可去，应尽快交回封顶事实。
  const { adapter, bot } = pond(t, { waterTop: 61, bridgeAtY: 62, freeze: true });
  bot.oxygenLevel = 0;
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 5000 });
  assert.equal(result.reason, 'SWIM_NO_PROGRESS');
  assert.equal(result.blockedAbove?.y, 62);
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

/** 只把已知方块塞进视觉记忆：水格 y=62（水面顶 63）+ 岸方块 y=bankY。 */
function shoreMemory(adapter: FakeAdapter, bankY: number) {
  adapter.groundY = -64;
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  adapter.blocks = [
    { name: 'water', pos: { x: 2, y: 62, z: 0 } },
    { name: 'stone', pos: { x: 3, y: bankY, z: 0 } },
  ];
  const vision = new Vision(adapter);
  vision.scan();
  const known = (vision as any).known;
  known.clear();
  for (const block of adapter.blocks) known.set(`${block.pos.x},${block.pos.y},${block.pos.z}`, { ...block, lastSeen: Date.now() });
  return vision;
}

test('nearest land reports the observed water surface and the climb height to it', () => {
  const adapter = new FakeAdapter();
  const vision = shoreMemory(adapter, 64);
  const land = vision.nearestLand(adapter.pos);
  assert.deepEqual(land?.pos, { x: 3, y: 64, z: 0 });
  assert.equal(land?.waterTop, 63);
  assert.equal(land?.heightAboveWater, 2);
  assert.equal(land?.climbableFromWater, false);
  const near = vision.summary(adapter.pos).nearest_land;
  assert.ok(near);
  if (!near) return;
  assert.equal(near.water_surface_y, 63);
  assert.equal(near.height_above_water, 2);
  assert.equal(near.climbable_from_water, false);
  assert.equal(near.path_confirmed, false);
  assert.match(near.note, /最多高 1 格/);
  assert.match(near.note, /垫方块或挖台阶/);
});

test('nearest land marks a bank within one block of the water as climbable', () => {
  const adapter = new FakeAdapter();
  const vision = shoreMemory(adapter, 63);
  const land = vision.nearestLand(adapter.pos);
  assert.equal(land?.heightAboveWater, 1);
  assert.equal(land?.climbableFromWater, true);
});

test('nearest land does not guess climb height when the block above the water is unloaded', () => {
  const adapter = new FakeAdapter();
  const vision = shoreMemory(adapter, 64);
  const optics = adapter.blockOptics.bind(adapter);
  adapter.blockOptics = (x, y, z) => x === 2 && y === 63 && z === 0 ? null : optics(x, y, z);
  const land = vision.nearestLand(adapter.pos);
  assert.ok(land, 'the bank itself is still usable evidence');
  assert.equal(land?.waterTop, undefined, '未加载的水面上方不能当成水面');
  assert.equal(land?.climbableFromWater, undefined);
  const near = vision.summary(adapter.pos).nearest_land;
  assert.ok(near);
  if (!near) return;
  assert.equal('climbable_from_water' in near, false);
});

test('surface delegates exactly one bounded ascent and reports surfaced without landing', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  let now = 100000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  adapter.inWater = true; adapter.oxygen = 10;
  adapter.swimTo = async () => {
    calls++;
    return { ok: true, landed: false, surfaced: true, oxygen: 20 };
  };
  try {
    const result = await surface.run({ adapter, memory, bus, signal: new AbortController().signal, deadline: now + 32000, taskId: 'surface-reproduction', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [], nearestLand: () => ({ dir: 'E', dist: 5, pos: { x: 5, y: 63, z: 0 } }) } }, {});
    assert.equal(calls, 1, '只做一次上浮委托');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.data?.surfaced, true);
    assert.equal(result.data?.landed, false, '浮出水面不等于上岸');
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

test('swimTo enables forward to enter water from a dry shore', async (t) => {
  const { adapter, bot } = pond(t);
  let forwardEnables = 0;
  const orig = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward' && value) forwardEnables++; orig(name, value); };
  bot.entity.position = new Vec3(6.5, 64, 2.5);
  bot.entity.onGround = true; bot.entity.isInWater = false;
  await adapter.swimTo({ x: 0.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.ok(forwardEnables > 0, '干岸上也要启用前进，先走进水里再游到对岸');
});

test('swimTo does not report arrived at a target far above', async (t) => {
  const { adapter, bot } = pond(t);
  // 水平距离 0，但目标高 6 格：不能只凭水平距离原地报上岸。
  bot.entity.position = new Vec3(6.5, 64, 2.5);
  bot.entity.onGround = true; bot.entity.isInWater = false;
  const result = await adapter.swimTo({ x: 6.5, y: 70, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.landed, false, '高处目标不能原地报 landed');
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

test('surface never digs or moves toward a shore, even when the ceiling blocks ascent', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  adapter.inWater = true; adapter.oxygen = 10;
  // FakeAdapter 里 y<63 是 stone：站在 y=60 时头顶 y=61 是石头，形成封顶（reachable）
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  let digs = 0, moves = 0;
  adapter.dig = async () => { digs++; return { ok: true }; };
  adapter.swimTo = async () => { return { ok: false, landed: false, surfaced: false, oxygen: 10 }; };
  adapter.moveTo = async () => { moves++; };
  try {
    const result = await surface.run({ adapter, memory, bus, signal: new AbortController().signal, deadline: now + 32000, taskId: 'surface-shore', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [], nearestLand: () => ({ dir: 'E', dist: 5, pos: { x: 5, y: 63, z: 0 } }) } }, {});
    assert.equal(digs, 0, '封顶也不得挖开头顶方块');
    assert.equal(moves, 0, '不得寻路到岸');
    assert.equal(result.status, 'failed', result.summary); // 未浮出应如实报告
    assert.equal(result.data?.landed, false);
  } finally { memory.close(); }
});

test('stuck in water: correction does not choose a bank or start swimming', async (t) => {
  const { adapter, bot } = pond(t);
  bot.entity.position = new Vec3(5.4, 62.4, 2.5);
  await bot.waitForTicks(4);
  const before = bot.entity.position.clone();
  let swims = 0;
  adapter.swimTo = async () => { swims++; return { ok: false, landed: false, surfaced: false, oxygen: 20 }; };
  for (const allowSwimming of [false, true]) {
    const action = await (adapter as any).nudge(new Set(), { signal: new AbortController().signal, timeoutMs: 10000, allowSwimming });
    assert.equal(action, null);
  }
  assert.equal(swims, 0);
  assert.deepEqual(bot.entity.position, before);
  assert.equal(bot.entity.isInWater, true);
});

function fluidBot(t: TestContext, headName: string, bodyName: string, inLava: boolean, inWater: boolean) {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = {};
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: inWater, isInLava: inLava, isCollidedHorizontally: false },
    oxygenLevel: 10,
    pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
    blockAt: (p: { y: number }) => ({ name: p.y >= bot.entity.position.y + 1.0 ? headName : bodyName, getProperties: () => ({}) as Record<string, string | number | boolean> }),
    async look() {},
    async waitForTicks() { now += 100; },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; Reflect.set(adapter, 'connectedFlag', true);
  return adapter;
}

test('head in lava is never reported surfaced or dry landing', async (t) => {
  const adapter = fluidBot(t, 'lava', 'lava', true, false);
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.ok, false, '头在岩浆里不算浮出');
  assert.equal(result.surfaced, false, '头在岩浆里不能算 surfaced（不能呼吸）');
  assert.equal(result.landed, false, '岩浆不能算干地');
});

test('targeted swim timeout preserves an observed surfaced head as a partial fact', async (t) => {
  const adapter = fluidBot(t, 'air', 'water', false, true);
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.ok, false, '目标未到不报成功');
  assert.equal(result.landed, false);
  assert.equal(result.surfaced, true, '途中头稳定露出空气应保留为部分事实，不因未到目标而硬写成 false');
});

/** 头方块随时间变化的真实适配器夹具：headAt(now) 返回 null 表示未观察（未知）。 */
function timedFluidBot(t: TestContext, headAt: (now: number) => string | null, bodyName: string, opts: { onGround?: boolean; inWater?: boolean } = {}) {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = {};
  const bot = {
    game: { dimension: 'overworld' },
    entity: {
      position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62,
      onGround: opts.onGround ?? false, isInWater: opts.inWater ?? true, isInLava: false, isCollidedHorizontally: false,
    },
    oxygenLevel: 10,
    pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
    blockAt: (p: { y: number }) => {
      const head = headAt(now);
      const name = p.y >= bot.entity.position.y + 1.0 ? head : bodyName;
      if (name === null) return null;
      return { name, getProperties: () => ({}) as Record<string, string | number | boolean>, boundingBox: 'block' };
    },
    async look() {},
    async waitForTicks(count: number) { for (let i = 0; i < count; i++) now += 100; },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, controls };
}

test('targeted swim reports surfaced=false when the head was air then submerged before timeout', async (t) => {
  const { adapter } = timedFluidBot(t, (now) => (now < 100700 ? 'air' : 'water'), 'water');
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.equal(result.landed, false);
  assert.equal(result.surfaced, false, '露头又沉下后，结束时头已不在空气中，不能保留陈旧的 surfaced=true');
});

test('targeted swim reports surfaced=false when the head becomes unknown before timeout', async (t) => {
  const { adapter } = timedFluidBot(t, (now) => (now < 100700 ? 'air' : null), 'water');
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.surfaced, false, '未观察（null）的头不算能呼吸，surfaced 不得陈旧为 true');
});

test('surfaced is re-sampled after the final tick, not left stale', async (t) => {
  // 头在最后一个物理帧才沉下水，循环之后不再有下一次 headOut 检查
  const { adapter } = timedFluidBot(t, (now) => (now < 101450 ? 'air' : 'water'), 'water');
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(result.surfaced, false, '最后一个 tick 把头沉下水后，返回前要重采样，不能读陈旧样本');
});

test('solid head never counts as surfaced', async (t) => {
  const { adapter } = timedFluidBot(t, () => 'stone', 'water');
  const result = await adapter.swimTo(null, new AbortController().signal, { timeoutMs: 500 });
  assert.equal(result.surfaced, false);
  assert.equal(result.landed, false);
});

test('onGround true with no water still requires a breathable head before surfaced/landed', async (t) => {
  // 站在干地、头却是实心方块：onGround+不碰水不能跳过接触检查（headOut/dryFooting）。
  const { adapter } = timedFluidBot(t, () => 'stone', 'stone', { onGround: true, inWater: false });
  const result = await adapter.swimTo({ x: 2.5, y: 61, z: 2.5 }, new AbortController().signal, { timeoutMs: 500 });
  assert.equal(result.surfaced, false, '头是实心方块，站在干地也不能算露头');
  assert.equal(result.landed, false, 'onGround 且不碰水不等于干地站稳');
});

test('swimTo bounds a stalled look to the remaining budget', { timeout: 5000 }, async (t) => {
  const { adapter, bot } = timedFluidBot(t, () => 'air', 'water');
  bot.look = () => new Promise<void>(() => {}); // 永不 resolve 的转头
  await assert.rejects(adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 300 }), { name: 'TimeoutError' });
});

test('swimTo bounds a stalled physics tick to the remaining budget', { timeout: 5000 }, async (t) => {
  const { adapter, bot } = timedFluidBot(t, () => 'air', 'water');
  bot.waitForTicks = () => new Promise<void>(() => {}); // 永不 resolve 的物理帧
  await assert.rejects(adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 300 }), { name: 'TimeoutError' });
});

test('swimTo does not hang or write forward when budget exhausts during look before an unresolved tick', { timeout: 5000 }, async (t) => {
  // 转头刚好把预算耗尽（now 越过 end），随后未完成的 tick 不应再被触发、也不得写 forward。
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = {};
  let forwardWrites = 0, lookCalls = 0, tickCalls = 0;
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: true, isInLava: false, isCollidedHorizontally: false },
    oxygenLevel: 10,
    pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { if (name === 'forward' && value) forwardWrites++; controls[name] = value; },
    clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
    blockAt: (p: { y: number }) => ({ name: p.y >= bot.entity.position.y + 1.0 ? 'air' : 'water', getProperties: () => ({}) as Record<string, string | number | boolean>, boundingBox: 'block' }),
    async look() { lookCalls++; now += 300; }, // 转头刚好把 now 推到 300ms 的 end 上
    waitForTicks() { tickCalls++; return new Promise<void>(() => {}); }, // 真实永不 resolve：旧实现会因 remaining()=0 禁用超时定时器而永久挂起
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; Reflect.set(adapter, 'connectedFlag', true);
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'WATER_ESCAPE_TIMEOUT');
  assert.equal(lookCalls, 1, '只在仍有正预算时调用一次 look');
  assert.equal(tickCalls, 0, 'look 恰好落在截止时刻（remaining=0）后不得触发任何 tick');
  assert.equal(forwardWrites, 0, '预算耗尽后不得再写 forward');
});

test('swimTo treats a tiny final tick wait as budget exhaustion, not a thrown timeout', { timeout: 5000 }, async (t) => {
  // 只留 140ms 时 waitForTicks(2) 没有足够余量：只等一刻，且末预算里的超时按预算耗尽返回，
  // 不能等 raceAbort 先触发、把最后一点预算报成“timeout after Nms”。
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = {};
  let lookCalls = 0, tickCalls = 0;
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: true, isInLava: false, isCollidedHorizontally: false },
    oxygenLevel: 10,
    pathfinder: { setGoal() {} },
    setControlState() {}, clearControlStates() {},
    blockAt: (p: { y: number }) => ({ name: p.y >= bot.entity.position.y + 1.0 ? 'air' : 'water', getProperties: () => ({}) as Record<string, string | number | boolean>, boundingBox: 'block' }),
    async look() { lookCalls++; now += 160; },
    waitForTicks() { tickCalls++; return new Promise<void>(() => {}); },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; Reflect.set(adapter, 'connectedFlag', true);
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'WATER_ESCAPE_TIMEOUT');
  assert.equal(lookCalls, 1);
  assert.equal(tickCalls, 1, '只发起一次一刻等待，不硬等两个刻');
});

test('swimTo without waitForTicks falls back to a bounded sleep', { timeout: 5000 }, async () => {
  // 无 waitForTicks 时走 sleep 回退：用真实时钟（不 mock Date.now），否则 now 永不前进、循环永不结束。
  const controls: Record<string, boolean> = {};
  const bot = {
    game: { dimension: 'overworld' },
    entity: {
      position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62,
      onGround: false, isInWater: true, isInLava: false, isCollidedHorizontally: false,
    },
    oxygenLevel: 10,
    pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
    blockAt: (p: { y: number }) => ({ name: p.y >= bot.entity.position.y + 1.0 ? 'air' : 'water', getProperties: () => ({}) as Record<string, string | number | boolean>, boundingBox: 'block' }),
    async look() {},
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; Reflect.set(adapter, 'connectedFlag', true);
  const result = await adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'WATER_ESCAPE_TIMEOUT');
});

test('a replacement task position/oxygen/observedAt are not attributed to the old cancelled swim partial', async (t) => {
  const { adapter, bot, advanceNow } = pond(t);
  let release!: () => void;
  bot.waitForTicks = () => new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const pending = adapter.swimTo({ x: 6.5, y: 64, z: 2.5 }, controller.signal);
  await setImmediate(); // 进入首次 waitForTicks，已冻结旧位置/氧气/观测时刻
  const owned = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
  const ownedOxygen = bot.oxygenLevel;
  const ownedAt = Date.now();
  adapter.stopAll(); // 替换任务接管（epoch 变化，不 abort signal）
  bot.entity.position.set(100, 100, 100); // 替换任务把身体挪走
  bot.oxygenLevel = 3; // 替换任务也改了氧气
  advanceNow(5000); // 替换任务推进了时钟
  release(); // 迟到完成 → 旧动作 check() 抛 AbortedError
  await assert.rejects(pending, (e: Error & { partial?: { pos?: { x: number; y: number; z: number }; oxygen?: number; observedAt?: number } }) => {
    assert.equal(e.name, 'AbortedError');
    assert.deepEqual(e.partial?.pos, owned, '旧动作 partial 保留最后一次拥有时的冻结位置，不张冠李戴成替换任务的新位置');
    assert.equal(e.partial?.oxygen, ownedOxygen, '旧动作 partial 保留冻结氧气，不换成替换任务的氧气');
    assert.equal(e.partial?.observedAt, ownedAt, '旧动作 partial 保留冻结观测时刻，不换成取消/清理时刻');
    return true;
  });
});

for (const scenario of [
  { name: 'surface', run: (ctx: Parameters<typeof surface.run>[0]) => surface.run(ctx, {}) },
  { name: 'swim_to', run: (ctx: Parameters<typeof swimTo.run>[0]) => swimTo.run(ctx, { xyz: { x: 6.5, y: 64, z: 2.5 } }) },
]) test(`public ${scenario.name} maps an actual adapter WATER_ESCAPE_TIMEOUT return to TIMEOUT and keeps the observed facts`, { timeout: 5000 }, async (t) => {
  const { adapter } = pond(t);
  const memory = new WorldMemory(null);
  const ctx = {
    adapter, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 300, taskId: 'real-timeout', progress() {},
    senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] },
  };
  const originalSwim = adapter.swimTo;
  let actual: Awaited<ReturnType<typeof originalSwim>> | undefined;
  // 只包一层捕获真实返回值，仍由原实现跑物理循环并返回 WATER_ESCAPE_TIMEOUT。
  adapter.swimTo = async (target, signal, opts) => {
    actual = await originalSwim.call(adapter, target, signal, opts);
    return actual;
  };
  try {
    const result = await scenario.run(ctx);
    const body = adapter.state();
    assert.equal(actual?.ok, false);
    assert.equal(actual?.reason, 'WATER_ESCAPE_TIMEOUT', '真实适配器在预算内未完成时返回 WATER_ESCAPE_TIMEOUT');
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'TIMEOUT', '预算耗尽应归为 TIMEOUT，而不是 PATH_NOT_FOUND/STUCK');
    assert.equal(result.data?.reason, actual?.reason);
    assert.equal(result.data?.landed, actual?.landed);
    assert.equal(result.data?.surfaced, actual?.surfaced);
    if (scenario.name === 'surface') {
      assert.match(result.summary, /上浮时间到，尚未确认完成/, '时间到只说未确认完成');
      assert.doesNotMatch(result.summary, /没把头露出流体/, '不能断言头一定没露出，surfaced 以实际返回为准');
    }
    assert.deepEqual(result.data?.pos, body.pos, '保留返回时身体的真实位置');
    assert.equal(result.data?.oxygen, actual?.oxygen, '保留适配器返回的真实氧气');
    assert.equal(body.oxygen, actual?.oxygen);
  } finally {
    adapter.swimTo = originalSwim;
    memory.close();
  }
});
