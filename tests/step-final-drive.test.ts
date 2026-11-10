import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
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
    pathfinder: { goto: async () => {}, setGoal() {}, stop() {}, setMovements() {}, isMoving: () => false, isBuilding: () => false },
  });
  const physics = Physics(data, world);
  const timer = setInterval(() => { physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot); }, 50);
  timer.unref?.();
  return { bot, timer };
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
    blockAt: () => null,
    setControlState(name: string, value: boolean) { control[name] = value; if (name === 'forward') forwardSets.push(value); },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look() {},
    pathfinder: { goto: async () => {}, setGoal() {}, stop() {}, setMovements() {}, isMoving: () => false, isBuilding: () => false },
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
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(bot.entity.position.z > -1, `越过目标格 z=${bot.entity.position.z}`);
  assert.equal(bot.control.forward, false, '到达后应已松开前进键');
});

test('寻路在目标格内按脚格提前结算、身体仍悬空时，先等落地再验收', async (t) => {
  const world = dropWorld();
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  bot.pathfinder.goto = async () => {
    // GoalBlock 已按 floor(脚格) 判到：水平进了目标列，脚还在落点上方 0.92。
    bot.entity.position = new Vec3(0.5, 63.92, -0.8);
    bot.entity.velocity = new Vec3(0, -0.1, 0);
    bot.entity.onGround = false;
  };
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
  assert.ok(Math.abs(bot.entity.position.y - 63) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

test('目标格内悬空但始终不落地时报告 TIMEOUT，而不是无路径', async () => {
  const { bot, forwardSets } = noPhysicsBot();
  bot.pathfinder.goto = async () => {
    bot.entity.position = new Vec3(0.5, 63.92, -0.5);
    bot.entity.onGround = false;
  };
  const a = adapter(bot);
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 0, y: 63, z: -1 }, { signal: new AbortController().signal, timeoutMs: 250 }), /TIMEOUT/);
  assert.equal(forwardSets.length, 0, '未触地时不该发前进键');
});

test('moveTo 从底半砖上一步到整块（脚高 64）也能闭环完成', async (t) => {
  const world = stepWorld({ name: 'oak_slab', props: { type: 'bottom', waterlogged: false } }, { name: 'stone', props: {} });
  const { bot, timer } = physicsBot(world, 63.5);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 64, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
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
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
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
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
  assert.ok(Math.abs(bot.entity.position.y - 63.5) <= 0.01, `脚高 ${bot.entity.position.y}`);
  assert.equal(Math.floor(bot.entity.position.z), -1);
});

test('单列半砖：从整块格中心出发也能受控减速落到半砖', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const { bot, timer } = physicsBot(world, 64); // 从格中心 (0.5, 64, 0.5) 出发
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
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
    await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
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
  // 寻路空返回（path.length === 0 的 noPath），身体离目标 4 格，不在相邻单步范围内。
  bot.pathfinder.goto = async () => {};
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 4, y: 64, z: 0 }, { signal: new AbortController().signal, timeoutMs: 1000 }), /尚未到达目标/);
  assert.equal(forwardSets.some((v) => v === true), false, '不该为远离目标启动前推');
});

test('显式相邻一步绕过 pathfinder：NoPath 时仍由身体控制完成', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  let calls = 0;
  bot.pathfinder.goto = async () => { calls++; throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }); };
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 2000, adjacentStep: true });
  assert.equal(calls, 0, '相邻一步不应调用整段 pathfinder');
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) < 0.02);
});

test('相邻一步前，身体偏心时先潜行归位到格心，再迈步', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  bot.entity.position = new Vec3(0.8, 64, 0.5);
  bot.blockAt = (pos: any) => world.getBlock(pos);
  const a = adapter(bot);
  const steadied: { x: number; z: number }[] = [];
  const steady = (a as any).steady.bind(a);
  (a as any).steady = async (cell: { x: number; z: number }, signal: AbortSignal, check: () => void) => {
    steadied.push({ ...cell });
    await steady(cell, signal, check);
  };
  await a.moveTo(
    { kind: 'xyz', x: 0, y: 63.9375, z: -1 },
    { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false, adjacentStep: true },
  );
  assert.deepEqual(steadied, [{ x: 0, z: 0 }], '偏心 x=0.8 先归位到当前格心');
  assert.equal(Math.floor(bot.entity.position.x), 0);
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.02);
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
    { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false, adjacentStep: true },
  );
  assert.equal(Math.floor(bot.entity.position.z), -1);
  assert.ok(Math.abs(bot.entity.position.y - 65) <= 0.02, `脚高 ${bot.entity.position.y}`);
});

test('寻路直接报 NoPath 时不启动前推', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  const forwardSets: boolean[] = [];
  const orig = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forwardSets.push(value); orig(name, value); };
  bot.pathfinder.goto = async () => { throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }); };
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 1000 }), /No path/);
  assert.equal(forwardSets.some((v) => v === true), false, 'NoPath 后不该前推');
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

test('纯移动不改变地形：普通 moveTo 不允许寻路挖掘（含树叶）、架桥或搭柱', async () => {
  const { Movements } = require('mineflayer-pathfinder');
  let selected: any;
  const bot: any = { registry: data, game: { dimension: 'overworld' }, entity: { position: new Vec3(2.5, 64, 0.5) }, inventory: { items: () => [] },
    blockAt: () => null,
    pathfinder: { setMovements: (m: unknown) => { selected = m; }, goto: async () => {} } };
  const a = adapter(bot);
  (a as any).normalMovements = new Movements(bot);
  (a as any).normalMovements.allow1by1towers = true;
  await a.moveTo({ kind: 'xyz', x: 2, y: 64, z: 0 }, { signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal(selected.canDig, false, '纯移动不得允许寻路挖块（含树叶）');
  assert.equal(selected.scafoldingBlocks.length, 0, '纯移动不得允许架桥');
  assert.equal(selected.allow1by1towers, false, '纯移动不得允许搭柱');
});

test('相邻目标的空 noPath（goto 正常返回）不触发前推', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  const forwardSets: boolean[] = [];
  const orig = bot.setControlState.bind(bot);
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forwardSets.push(value); orig(name, value); };
  // 已安装 Pathfinder 的 goto 在 path:[]、status:noPath 时会正常返回（不抛错），这里复现。
  const pathfinderGoto = require('mineflayer-pathfinder/lib/goto');
  bot.pathfinder.goto = (goal: any) => pathfinderGoto(bot, goal);
  bot.pathfinder.setGoal = () => { bot.emit('path_update', { status: 'noPath', path: [] }); };
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 1000 }), /尚未到达目标/);
  assert.equal(forwardSets.some((v) => v === true), false, '空 noPath 不该前推');
});

test('单列半砖后方恢复整块：越段即停，不无限前推', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } });
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  // 寻路在节点边界提前结算后，身体已在原支撑边缘、带前进速度冲向薄层（复现越过单列半砖不停）。
  bot.entity.position = new Vec3(0.5, 64, 0.0);
  bot.entity.velocity = new Vec3(0, 0, -0.3);
  const a = adapter(bot);
  try { await a.moveTo({ kind: 'xyz', x: 0, y: 63.5, z: -1 }, { signal: new AbortController().signal, timeoutMs: 1500, allowTerrainChanges: false }); } catch { /* 越段或超时均属预期，关键是不得无限前推 */ }
  assert.ok(Math.abs(bot.entity.position.z) < 3, `越段后不该继续前推，z=${bot.entity.position.z}`);
  assert.equal(bot.control.forward, false, '越段后应松开前进键');
});

test('终段推进无法完成时报告 TIMEOUT 而非无路径', async () => {
  const { bot } = noPhysicsBot();
  const a = adapter(bot);
  await assert.rejects(a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 250 }), /TIMEOUT/);
});

test('到达后继续推进物理，身体仍稳定停在目标列', async (t) => {
  const world = stepWorld({ name: 'stone', props: {} }, { name: 'farmland', props: {} }, true);
  const { bot, timer } = physicsBot(world, 64);
  t.after(() => clearInterval(timer));
  const a = adapter(bot);
  await a.moveTo({ kind: 'xyz', x: 0, y: 63.9375, z: -1 }, { signal: new AbortController().signal, timeoutMs: 4000, allowTerrainChanges: false });
  // moveTo 返回后再推进若干物理 tick：身体已稳定停住，不因惯性滑出目标列。
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(Math.floor(bot.entity.position.z), -1, `停稳后仍在目标列 z=${bot.entity.position.z}`);
  assert.ok(Math.abs(bot.entity.position.y - 63.9375) <= 0.02, `停稳后脚高 ${bot.entity.position.y}`);
});
