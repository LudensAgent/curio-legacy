import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/** 一段相邻地面步的物理世界：原点列 + 目标列各一块，其余按 y≤63 实心、以上空气。
 *  continuous=true 时目标薄层沿移动方向向后方连续延伸（模拟真实田埂/半砖平台，而非单列）。 */
function stepWorld(origin: { name: string; props: Record<string, string | number | boolean> }, target: { name: string; props: Record<string, string | number | boolean> }, continuous = false) {
  const originState = Block.fromProperties(origin.name, origin.props, 0).stateId;
  const targetState = Block.fromProperties(target.name, target.props, 0).stateId;
  return {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      let stateId = p.y <= 63 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      if (p.x === 0 && p.z === 0 && p.y === 63) stateId = originState;
      if (p.x === 0 && p.z === -1 && p.y === 63) stateId = targetState;
      if (continuous && p.x === 0 && p.z < -1 && p.y === 63) stateId = targetState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
}

/** 纯物理探针：按住前进，返回身体进入目标列（z=-1）期间的最低脚高——证明薄层会被真实踩下。 */
function minFootInTarget(world: ReturnType<typeof stepWorld>, startFootY: number) {
  const control = { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: new Vec3(0.5, startFootY, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {} };
  const bot = { version: '1.20.1', entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] } };
  const physics = Physics(data, world);
  let minY = Infinity;
  for (let i = 0; i < 120; i++) {
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    if (Math.floor(bot.entity.position.z) === -1) minY = Math.min(minY, bot.entity.position.y);
  }
  return minY;
}

/** 目标列低一格：原点列 y=63 实心（脚高 64），目标列 y=63 空气、y=62 实心（落点脚高 63）。 */
function dropWorld() {
  return {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const solid = (p.x === 0 && p.z === 0 && p.y === 63) || (p.x === 0 && p.z === -1 && p.y === 62);
      const stateId = solid ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
}

/** 带真实物理的 bot：setControlState 驱动控制，50ms 一 tick 推物理。 */
function physicsBot(world: ReturnType<typeof stepWorld>, startFootY: number) {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: new Vec3(0.5, startFootY, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {} };
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [] }, vehicle: null, game: { dimension: 'overworld' },
    blockAt: (pos: { floored(): { x: number; y: number; z: number } }) => world.getBlock(pos),
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    async look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  });
  const physics = Physics(data, world);
  const trajectory: Vec3[] = [];
  const timer = setInterval(() => {
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    trajectory.push(bot.entity.position.clone());
  }, 50);
  timer.unref?.();
  return { bot, timer, trajectory };
}

function adapter(bot: any) {
  const a = new MineflayerAdapter(config, new EventBus());
  a.bot = bot; a.mcData = data; Reflect.set(a, 'connectedFlag', true);
  return a;
}

/** 有 setControlState 但身体不动的 bot：用来测终段在无法推进时耗尽期限。 */
function noPhysicsBot() {
  const control: Record<string, boolean> = {};
  const forwardSets: boolean[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.20.1',
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [] }, vehicle: null, game: { dimension: 'overworld' },
    // 把同一个控制状态对象暴露在 bot 上：测试读取的就是 setControlState/clearControlStates 实际改的键。
    control,
    blockAt: () => null,
    setControlState(name: string, value: boolean) { control[name] = value; if (name === 'forward') forwardSets.push(value); },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look() {},
  });
  return { bot, forwardSets };
}

test('物理：从整块前进一步踩到耕地（脚高 63.9375），不是停在整数节点', () => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const minY = minFootInTarget(world, 64);
  assert.ok(Math.abs(minY - 63.9375) <= 0.02, `最低脚高 ${minY}`);
});

test('物理：从整块下一步踩到底半砖（脚高 63.5）', () => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const minY = minFootInTarget(world, 64);
  // 采样时刻身体仍在向下沉降，允许 0.1 容差；关键是踩到半砖顶面（≈63.5），而不是停在 64 或穿透到 63。
  assert.ok(minY >= 63.5 && minY < 63.6, `最低脚高 ${minY}`);
});

test('moveTo 在寻路按节点提前结算后，闭环前推真正落到目标薄层，且一到即停', async (t) => {
  // 连续耕地：身体离开原支撑后会稳定停在耕地上，不因惯性滑出目标列。
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} }, true);
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  // 寻路按整数节点立刻结算（节点 64→64 未变），身体仍由原支撑托住。
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(bot.entity.position.z > -1, `越过目标格 z=${bot.entity.position.z}`);
  assert.equal(bot.control.forward, false, '到达后应已松开前进键');
});

test('moveTo 从底半砖上一步到整块（脚高 64）也能闭环完成', async (t) => {
  const world = stepWorld({ name: 'oak_slab', props: { type: 'bottom', waterlogged: false } }, { name: 'stone', props: {} });
  const { bot, timer } = physicsBot(world, 63.5);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 64, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  assert.ok(Math.abs(bot.entity.position.y - 64) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

test('身体已贴近目标但仍由原支撑托住时，仍会前推并落到目标', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} }, true);
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  // 寻路停在距目标中心 0.3 格（<0.35）但仍由原支撑托住：这正是「提前制动」复现的旧支撑边缘卡住位置。
  bot.entity.position = new Vec3(0.5, 64, -0.2);
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

test('单列半砖：身体停在目标边缘仍能受控减速落到半砖上', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  // 寻路停在目标列边缘（脚仍由原整块托住），速度为零——正是 P1「等脚高下降才松键」偏晚的起始状态。
  bot.entity.position = new Vec3(0.5, 64, -0.2);
  bot.entity.velocity = new Vec3(0, 0, 0);
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  assert.ok(Math.abs(bot.entity.position.y - 63.5) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

test('单列半砖：从整块格中心出发也能受控减速落到半砖', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const { bot, timer } = physicsBot(world, 64); // 从格中心 (0.5, 64, 0.5) 出发
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  assert.ok(Math.abs(bot.entity.position.y - 63.5) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

for (const x of [0.4, 0.5, 0.55]) {
  test(`单列干半砖（waterlogged:false）：从 x=${x} 出发也落稳到脚高 63.5`, async (t) => {
    const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
    const { bot, timer } = physicsBot(world, 64);
    t.after(() => clearInterval(timer));
    bot.entity.position = new Vec3(x, 64, 0.5);
    const a = adapter(bot);
    await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
    assert.ok(Math.abs(bot.entity.position.y - 63.5) <= 0.01, `脚高 ${bot.entity.position.y}`);
    assert.equal(Math.floor(bot.entity.position.z), -1);
  });
}

test('含水半砖是独立用例：脚高同为 63.5 但身体进水（inWater），不能混入干半砖', () => {
  const dry = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const wet = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: true } });
  const inWaterOnTarget = (world: ReturnType<typeof stepWorld>) => {
    const control = { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
    const entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} };
    const bot = { version: '1.20.1', entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] } };
    const physics = Physics(data, world);
    let inWater = false;
    for (let i = 0; i < 120; i++) {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      if (Math.floor(bot.entity.position.z) === -1 && bot.entity.isInWater) inWater = true;
    }
    return inWater;
  };
  assert.equal(inWaterOnTarget(dry), false, '干半砖不应进水');
  assert.equal(inWaterOnTarget(wet), true, '含水半砖应进水');
});

test('身体离目标太远时不盲目前推', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  const forwardSets: boolean[] = [];
  const orig = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forwardSets.push(value); orig(name, value); };
  // 相邻一步的本地身体控制在起点超出单步范围时直接拒绝，不盲目前推。
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 4, y: 64, z: 0 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 1000 }), /NOT_CONFIRMED|尚未到达/);
  assert.equal(forwardSets.some((v) => v === true), false, '不该为远离目标启动前推');
});

test('显式相邻一步由本地身体控制完成', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 2000, adjacentStep: true });
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) < 0.02);
});

for (const startX of [0.85, 0.05]) test(`普通支撑偏心 x=${startX} 时直接迈进相邻列，实测不先归位或倒退`, async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'stone', props: {} });
  const { bot, timer, trajectory } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  bot.entity.position = new Vec3(startX, 64, 0.5);
  bot.blockAt = (pos: any) => world.getBlock(pos);
  const a = adapter(bot);
  const steadied: { x: number; z: number }[] = [];
  const steady = (a as any).steady.bind(a);
  (a as any).steady = async (cell: { x: number; z: number }, signal: AbortSignal, check: () => void) => {
    steadied.push({ ...cell });
    await steady(cell, signal, check);
  };
  await a.moveTo(
    { kind: 'xyz', x: 1, y: 64, z: 0 },
    { signal: new AbortController().signal, timeoutMs: 4000, adjacentStep: true },
  );
  assert.deepEqual(steadied, [], `实际最远退到 x=${Math.min(...trajectory.map(p => p.x))}`);
  assert.ok(trajectory.every(p => p.x >= startX - 0.001));
  assert.equal(Math.floor(bot.entity.position.x), 1);
  assert.equal(Math.floor(bot.entity.position.z), 0);
  assert.equal(bot.entity.position.y, 64);
});

test('只有身体中心悬空、脚边仍在承重面时才潜行回到实际支撑列', async (t) => {
  const { bot, timer } = physicsBot(dropWorld(), 64);
  t.after(() => clearInterval(timer));
  bot.entity.position = new Vec3(1.1, 64, 0.5);
  const a = adapter(bot);
  const steady = t.mock.method(a as unknown as { steady: (cell: { x: number; z: number }, signal: AbortSignal, check: () => void) => Promise<void> }, 'steady');
  await a.moveTo({ kind: 'xyz', x: 0, y: 64, z: 0 }, { signal: new AbortController().signal, timeoutMs: 4000, adjacentStep: true });
  assert.equal(steady.mock.callCount(), 1);
  assert.deepEqual(steady.mock.calls[0]!.arguments[0], { x: 0, z: 0 });
  assert.equal(Math.floor(bot.entity.position.x), 0);
  assert.equal(bot.entity.onGround, true);
});

test('真实支撑列与目标隔着一格时，拒绝该单步且不先向后归位', async (t) => {
  const { bot, timer } = physicsBot(dropWorld(), 64);
  t.after(() => clearInterval(timer));
  bot.entity.position = new Vec3(1.1, 64, 0.5);
  const keys = t.mock.method(bot, 'setControlState');
  await assert.rejects(adapter(bot).moveTo({ kind: 'xyz', x: 2, y: 64, z: 0 }, { signal: new AbortController().signal, timeoutMs: 4000, adjacentStep: true }), /NOT_CONFIRMED/);
  assert.equal(keys.mock.callCount(), 0);
  assert.equal(bot.entity.position.x, 1.1);
});

test('相邻一步向上整块高度差会起跳，而不只是平走', async (t) => {
  const world = {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const solid = p.y <= 63 || (p.x === 0 && p.y === 64 && p.z === -1);
      const block = Block.fromStateId(solid ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  bot.blockAt = (pos: any) => world.getBlock(pos);
  const a = adapter(bot);
  await a.moveTo(
    { kind: 'xyz', x: 0, y: 65, z: -1 },
    { signal: new AbortController().signal, timeoutMs: 4000, adjacentStep: true },
  );
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(Math.abs(bot.entity.position.y - 65) <= 0.02, `脚高 ${bot.entity.position.y}`);
});

test('末段前推的期限已过时不发前进键', async () => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  clearInterval(timer);
  const a = adapter(bot);
  const forwardSets: boolean[] = [];
  const orig = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forwardSets.push(value); orig(name, value); };
  const check = (a as any).actionCheckpoint(new AbortController().signal);
  const done = await (a as any).finishAdjacentStep({ x: 0, y: 63.9375, z: -1 }, Date.now() - 1, check);
  assert.equal(done, 'timeout');
  assert.equal(forwardSets.length, 0, '期限已过不该发任何前进键');
});

test('连续脚位控制：非格心起点走到非格心 endpoint，不先归位格心也不横向漂移', async (t) => {
  const world = {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const block = Block.fromStateId(p.y <= 63 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const { bot, timer, trajectory } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  bot.entity.position = new Vec3(0.2, 64, 0.2);
  const a = adapter(bot);
  await a.moveTo(
    { kind: 'feet', x: 0.2, y: 64, z: -0.8 },
    { signal: new AbortController().signal, timeoutMs: 4000 },
  );
  assert.equal(bot.entity.onGround, true, '完成时实测触地');
  assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.003, `完成时水平速度 ${bot.entity.velocity}`);
  assert.ok(Math.abs(bot.entity.position.x - 0.2) <= 0.12, `横向 x=${bot.entity.position.x}`);
  assert.ok(Math.abs(bot.entity.position.z + 0.8) <= 0.12, `纵向 z=${bot.entity.position.z}`);
  assert.ok(Math.abs(bot.entity.position.y - 64) <= 0.05, `脚高 ${bot.entity.position.y}`);
  assert.equal(bot.control.forward, false, '到达后应已松开前进键');
  // 整条物理轨迹的横向不应漂移；不是只看最终误差。
  assert.ok(trajectory.length > 0);
  assert.ok(trajectory.every((point) => Math.abs(point.x - 0.2) <= 0.05), `轨迹横向漂移：${trajectory.map((point) => point.x.toFixed(3)).join(',')}`);
  // 到达后继续物理推进：真实 grounded/stable，不滑出容差。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bot.entity.onGround, true);
  assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.003);
  assert.ok(Math.abs(bot.entity.position.z + 0.8) <= 0.12, `稳定后 z=${bot.entity.position.z}`);
});

test('单列半砖后方恢复整块：越段即停，不无限前推', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  // 寻路在节点边界提前结算后，身体已在原支撑边缘、带前进速度冲向薄层（复现越过单列半砖不停）。
  bot.entity.position = new Vec3(0.5, 64, 0.0);
  bot.entity.velocity = new Vec3(0, 0, -0.3);
  const a = adapter(bot);
  try { await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 1500 }); } catch { /* 越段或超时均属预期，关键是不得无限前推 */ }
  assert.ok(Math.abs(bot.entity.position.z) < 3, `越段后不该继续前推，z=${bot.entity.position.z}`);
  assert.equal(bot.control.forward, false, '越段后应松开前进键');
});

test('终段推进无法完成时报告 TIMEOUT 而非无路径', async () => {
  const { bot } = noPhysicsBot();
  const a = adapter(bot);
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 250 }), /TIMEOUT/);
});

test('到达后继续推进物理，身体仍稳定停在目标列', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} }, true);
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, adjacentStep: true, timeoutMs: 4000 });
  // moveTo 返回后再推进若干物理 tick：身体已稳定停住，不因惯性滑出目标列。
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(Math.floor(bot.entity.position.z), -1, `停稳后仍在目标列 z=${bot.entity.position.z}`);
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.02, `停稳后脚高 ${bot.entity.position.y}`);
});

test('连续脚位修正阶段：剩余期限不足标称点按时，只按住剩余时间且到期后不再发控制', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const { bot } = noPhysicsBot();
  bot.entity.position = new Vec3(0.5, 64, 0.2);
  // 初段只读一次速度：首次 0.3 让制动估计立即结束初段推进，随后稳态读取为 0，从而进入低速修正。
  let velocityReads = 0;
  Object.defineProperty(bot.entity, 'velocity', {
    configurable: true,
    get: () => (++velocityReads === 1 ? new Vec3(0.3, 0, 0) : new Vec3(0, 0, 0)),
  });
  const a = adapter(bot);
  const forwardEvents: { value: boolean; at: number }[] = [];
  const setControlState = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => {
    const before = bot.control[name];
    setControlState(name, value);
    // 只记实际状态变化；重复松键是清理路径的正常行为，不算一次新的控制脉冲。
    if (name === 'forward' && before !== value) forwardEvents.push({ value, at: Date.now() });
  };
  const start = Date.now();
  const deadline = start + 180;
  const check = (a as any).actionCheckpoint(new AbortController().signal);
  const running = (a as any).driveToFeet({ x: 0.5, y: 64, z: -0.35 }, deadline, check, 'feet');
  // 同步阶段先发出初段前进（随即使被制动估计松开），随后进入第一次低速修正点按。
  assert.deepEqual(forwardEvents.map((event) => event.value), [true, false, true], '必须先到修正阶段');

  t.mock.timers.tick(120);
  await setImmediate();
  t.mock.timers.tick(40);
  await setImmediate();
  t.mock.timers.tick(20);
  await setImmediate();
  t.mock.timers.tick(1);
  await setImmediate();

  assert.equal(await running, 'timeout');
  assert.deepEqual(forwardEvents.map((event) => event.value), [true, false, true, false, true, false]);
  assert.deepEqual(forwardEvents.map((event) => event.at - start), [0, 0, 0, 120, 160, 180]);
  assert.ok(forwardEvents.filter((event) => event.value).every((event) => event.at < deadline), '到期后不再发出前进键');
  assert.equal(forwardEvents[5]!.at - forwardEvents[4]!.at, 20, '第二次修正只按住剩余的 20ms，而不是标称 120ms');
  assert.equal(bot.control.forward, false, '修正结束后已释放前进键');
});

test('旧 epoch 的连续脚位清理不会释放新任务的前进键', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const { bot } = noPhysicsBot();
  bot.entity.position = new Vec3(0.5, 64, 0.2);
  let velocityReads = 0;
  Object.defineProperty(bot.entity, 'velocity', {
    configurable: true,
    get: () => (++velocityReads === 1 ? new Vec3(0.3, 0, 0) : new Vec3(0, 0, 0)),
  });
  const a = adapter(bot);
  const check = (a as any).actionCheckpoint(new AbortController().signal);
  const running = (a as any).driveToFeet({ x: 0.5, y: 64, z: -0.3 }, Date.now() + 500, check, 'feet');
  assert.equal(bot.control.forward, true, '旧任务正在按住修正脉冲');

  a.stopAll();
  bot.setControlState('forward', true);

  // 先挂上拒绝处理器，再推进 mock 时间；否则旧任务被终止时的拒绝会被当成未处理。
  const aborted = assert.rejects(running, { name: 'AbortedError' });
  t.mock.timers.tick(120);
  await setImmediate();
  await aborted;
  assert.equal(bot.control.forward, true, '旧任务的 finally 不得松开新 epoch 的按键');
});

test('连续脚位走廊：maxLateral=0 且起点偏离轴线时不发控制直接停止', async () => {
  const { bot, forwardSets } = noPhysicsBot();
  bot.entity.position = new Vec3(0.55, 64, 0.5);
  const a = adapter(bot);
  const check = (a as any).actionCheckpoint(new AbortController().signal);
  const error = await (a as any).driveToFeet(
    { x: 0.55, y: 64, z: -0.5 }, Date.now() + 1000, check, 'feet',
    { origin: { x: 0.5, y: 64, z: 0.5 }, bearing: { x: 0, z: -1 }, maxLateral: 0 },
  ).then(() => null, (e: Error) => e);
  assert.ok(error, '横向 0.05 格（小于 0.12 到达容差）仍应被 maxLateral=0 拒绝');
  assert.match(error.message, /CORRIDOR_VIOLATION/);
  assert.match(error.message, /超出授权 0 格/, '横向授权必须是 maxLateral=0，而不是到达容差');
  assert.equal(forwardSets.length, 0, '越界时不应发出任何前进键');
  assert.deepEqual({ x: bot.entity.position.x, z: bot.entity.position.z }, { x: 0.55, z: 0.5 }, '保留实测位置，不挪回走廊');

  // 同一几何不提供 corridor 时仍走原来的身体控制，不因横向偏离被走廊逻辑拒绝。
  const free = noPhysicsBot();
  free.bot.entity.position = new Vec3(0.55, 64, 0.5);
  const freeAdapter = adapter(free.bot);
  const noCorridor = await (freeAdapter as any).driveToFeet(
    { x: 0.55, y: 64, z: -0.5 }, Date.now() + 10,
    (freeAdapter as any).actionCheckpoint(new AbortController().signal), 'feet',
  );
  assert.equal(noCorridor, 'timeout');
  assert.ok(free.forwardSets.some((value) => value === true), '未提供 corridor 时仍按原逻辑发出控制');
});

test('连续脚位走廊：实测横向移动越过 maxLateral 时立即停止并保留实测位置', async (t) => {
  const world = {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const block = Block.fromStateId(p.y <= 63 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  // 起点在走廊轴线上，目标偏东；前进会把身体真实带离北向轴线，而不是只在终点改坐标。
  const error = await a.moveTo(
    { kind: 'feet', x: 0.9, y: 64, z: -0.5 },
    {
      signal: new AbortController().signal, timeoutMs: 4000,
      corridor: { origin: { x: 0.5, y: 64, z: 0.5 }, bearing: { x: 0, z: -1 }, maxLateral: 0 },
    },
  ).then(() => null, (e: Error) => e);
  assert.ok(error, '横向越界应停止，而不是声称到达');
  assert.match(error.message, /CORRIDOR_VIOLATION/);
  assert.match(error.message, /超出授权 0 格/);
  assert.equal(bot.control.forward, false, '停止后已释放前进键');
  const measured = /实际位于 \((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(error.message);
  assert.ok(measured, '回执保留越界时的实测位置');
  const measuredX = Number(measured[1]);
  assert.ok(measuredX > 0.5 + 0.02, `实测横向应已越界：x=${measuredX}`);
  assert.ok(bot.entity.position.x >= measuredX - 0.05, `不得把身体挪回走廊：x=${bot.entity.position.x}`);
  assert.ok(Math.hypot(bot.entity.position.x - 0.9, bot.entity.position.z + 0.5) > 0.12, '越界后没有声称到达目标');
});
