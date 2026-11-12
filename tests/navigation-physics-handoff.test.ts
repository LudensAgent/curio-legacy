import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/** 控制键时间线：dispatch 是派发序号，settle 类事件归属最近一次派发；tick 是物理帧序号。 */
type ControlEvent = {
  dispatch: number;
  kind: 'move-to' | 'look' | 'clear' | 'forward-on' | 'forward-off' | 'settle' | 'settle-forward-off';
  tick: number;
};

/** 真实 prismarine 物理逐 tick 推进；blockName(x,y,z) 给出世界方块名。 */
function setup(
  groundTop: (x: number, z: number) => number,
  from: Vec3Like,
  bounds: { x0: number; x1: number; z0: number; z1: number },
  opts: { blockName?: (x: number, y: number, z: number) => string } = {},
) {
  const blockName = opts.blockName ?? ((x: number, y: number, z: number) => (y <= groundTop(x, z) ? 'stone' : 'air'));
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const block = Block.fromStateId(data.blocksByName[blockName(p.x, p.y, p.z)].defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const frames: { speed: number; back: boolean }[] = [];
  let physicsTicks = 0;
  let inPhysicsTick = false;
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const controlEvents = {
    clears: 0, looks: 0, forwardOn: 0, forwardOff: 0, settleCalls: 0, settleForwardOff: 0, checkpoints: 0,
    clearsByDispatch: [] as number[], looksByDispatch: [] as number[], forwardOnByDispatch: [] as number[], forwardOffByDispatch: [] as number[],
    forwardHeldAtDispatch: [] as boolean[], settleCallsByDispatch: [] as number[],
    timeline: [] as ControlEvent[], tickGapsOver100: 0, maxTickGap: 0, tickCellQueries: 0, tickSectionQueries: 0, currentDispatch: -1, lastDispatch: -1,
  };
  const entity = {
    position: new Vec3(from.x, from.y, from.z), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, pitch: 0,
    onGround: true, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, effects: {}, attributes: {}, eyeHeight: 1.62,
  };
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.1', entity, controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [] }, vehicle: null, game: { dimension: 'overworld' },
    blockAt: (pos: Vec3) => world.getBlock(pos),
    setControlState(name: string, value: boolean) {
      const dispatch = controlEvents.currentDispatch;
      const owner = dispatch >= 0 ? dispatch : controlEvents.lastDispatch;
      if (name === 'forward') {
        if (value && !controls.forward) {
          controlEvents.forwardOn++;
          controlEvents.timeline.push({ dispatch: owner, kind: 'forward-on', tick: physicsTicks });
          if (dispatch >= 0) controlEvents.forwardOnByDispatch[dispatch] = (controlEvents.forwardOnByDispatch[dispatch] ?? 0) + 1;
        }
        if (!value && controls.forward) {
          controlEvents.forwardOff++;
          controlEvents.timeline.push({
            dispatch: owner,
            kind: dispatch >= 0 ? 'forward-off' : 'settle-forward-off',
            tick: physicsTicks,
          });
          if (dispatch >= 0) controlEvents.forwardOffByDispatch[dispatch] = (controlEvents.forwardOffByDispatch[dispatch] ?? 0) + 1;
          else controlEvents.settleForwardOff++;
        }
      }
      controls[name] = value;
    },
    clearControlStates() {
      const dispatch = controlEvents.currentDispatch;
      controlEvents.clears++;
      controlEvents.timeline.push({ dispatch: dispatch >= 0 ? dispatch : controlEvents.lastDispatch, kind: 'clear', tick: physicsTicks });
      if (dispatch >= 0) controlEvents.clearsByDispatch[dispatch] = (controlEvents.clearsByDispatch[dispatch] ?? 0) + 1;
      Object.keys(controls).forEach((key) => { controls[key] = false; });
    },
    async look(yaw: number, pitch: number) {
      const dispatch = controlEvents.currentDispatch;
      controlEvents.looks++;
      controlEvents.timeline.push({ dispatch: dispatch >= 0 ? dispatch : controlEvents.lastDispatch, kind: 'look', tick: physicsTicks });
      if (dispatch >= 0) controlEvents.looksByDispatch[dispatch] = (controlEvents.looksByDispatch[dispatch] ?? 0) + 1;
      entity.yaw = yaw;
      entity.pitch = pitch;
    },
  });
  const driver = new MineflayerAdapter(config, new EventBus());
  driver.bot = bot as unknown as NonNullable<MineflayerAdapter['bot']>;
  driver.mcData = data;
  Reflect.set(driver, 'connectedFlag', true);
  const physics = Physics(data, world);
  for (let tick = 0; tick < 2; tick++) physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
  let lastTickAt: number | undefined;
  const timer = setInterval(() => {
    const now = performance.now();
    if (lastTickAt !== undefined) {
      const gap = now - lastTickAt;
      controlEvents.maxTickGap = Math.max(controlEvents.maxTickGap, gap);
      if (gap > 100) controlEvents.tickGapsOver100++;
    }
    lastTickAt = now;
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
    physicsTicks++;
    inPhysicsTick = true;
    bot.emit('physicsTick');
    inPhysicsTick = false;
    frames.push({ speed: Math.hypot(entity.velocity.x, entity.velocity.z), back: controls.back === true });
  }, 50);
  timer.unref();
  const dispatches: { continuous: boolean; frameStart: number; target: Vec3Like }[] = [];
  class PhysicsAdapter extends FakeAdapter {
    async settleMovement(opts: Pick<MoveOpts, 'signal' | 'timeoutMs'>) {
      controlEvents.settleCalls++;
      controlEvents.timeline.push({ dispatch: controlEvents.lastDispatch, kind: 'settle', tick: physicsTicks });
      if (controlEvents.lastDispatch >= 0) {
        controlEvents.settleCallsByDispatch[controlEvents.lastDispatch] = (controlEvents.settleCallsByDispatch[controlEvents.lastDispatch] ?? 0) + 1;
      }
      await driver.settleMovement(opts);
    }
    override state() { return { ...super.state(), pos: { ...entity.position }, onGround: entity.onGround }; }
    override blockAt(pos: Vec3Like) { return world.getBlock(new Vec3(pos.x, pos.y, pos.z)).name as string; }
    override blockStateAt(pos: Vec3Like) { return { name: world.getBlock(new Vec3(pos.x, pos.y, pos.z)).name as string, properties: {} }; }
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      assert.equal(target.kind, 'feet');
      const dispatch = dispatches.length;
      controlEvents.clearsByDispatch[dispatch] = 0;
      controlEvents.looksByDispatch[dispatch] = 0;
      controlEvents.forwardOnByDispatch[dispatch] = 0;
      controlEvents.forwardOffByDispatch[dispatch] = 0;
      controlEvents.forwardHeldAtDispatch[dispatch] = controls.forward === true;
      controlEvents.settleCallsByDispatch[dispatch] = 0;
      controlEvents.currentDispatch = dispatch;
      controlEvents.timeline.push({ dispatch, kind: 'move-to', tick: physicsTicks });
      dispatches.push({ continuous: opts.settleAtTarget === false, frameStart: frames.length, target: { x: target.x, y: target.y, z: target.z } });
      const onCheckpoint = opts.onCheckpoint;
      if (onCheckpoint !== undefined) {
        opts.onCheckpoint = (measured: Vec3Like) => {
          const held = onCheckpoint(measured);
          if (held) controlEvents.checkpoints++;
          return held;
        };
      }
      try {
        await driver.moveTo(target, opts);
      } finally {
        controlEvents.currentDispatch = -1;
        controlEvents.lastDispatch = dispatch;
      }
      this.pos = { ...entity.position };
    }
  }
  const adapter = new PhysicsAdapter();
  adapter.pos = { ...from };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 600_000 });
  const cellAt = map.cellAt.bind(map);
  map.cellAt = (dim, x, y, z) => {
    if (inPhysicsTick) controlEvents.tickCellQueries++;
    return cellAt(dim, x, y, z);
  };
  const sectionAt = map.sectionAt.bind(map);
  map.sectionAt = (dim, x, y, z) => {
    if (inPhysicsTick) controlEvents.tickSectionQueries++;
    return sectionAt(dim, x, y, z);
  };
  const sectionRef = map.sectionRef.bind(map);
  map.sectionRef = (dim, x, y, z) => {
    if (inPhysicsTick) controlEvents.tickSectionQueries++;
    return sectionRef(dim, x, y, z);
  };
  let sequence = 0;
  for (let x = bounds.x0; x <= bounds.x1; x++) for (let z = bounds.z0; z <= bounds.z1; z++) for (let y = 58; y <= 68; y++) {
    const pos = { x, y, z };
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: `minecraft:${adapter.blockStateAt(pos).name}`, properties: {} }, pos });
  }
  const ctx = { ...makeCtx(adapter, { deadlineMs: 120_000 }), spatial: {
    worldId: adapter.worldId, session: { voxel: map }, closing: false,
  } as unknown as SharedSpatialSession };
  return { ctx, timer, entity, frames, dispatches, controlEvents };
}

/** 从第一步派发到末步派发之间：停住的帧数、按后退键的帧数。 */
function middle(frames: { speed: number; back: boolean }[], dispatches: { frameStart: number }[]) {
  const span = frames.slice(dispatches[0]!.frameStart + 2, dispatches.at(-1)!.frameStart);
  return { span, stopped: span.filter((frame) => frame.speed < 0.003).length, back: span.filter((frame) => frame.back).length };
}

/** 基线只在平稳段统计：按 transition 计数的清键/停车，以及每 100 次 transition 的次数。 */
function measureRun(
  label: string,
  frames: { speed: number; back: boolean }[],
  dispatches: { frameStart: number }[],
  controlEvents: ReturnType<typeof setup>['controlEvents'],
  result: { data?: Record<string, unknown> },
) {
  const { span, stopped, back } = middle(frames, dispatches);
  const avgSpeed = span.length === 0 ? 0 : span.reduce((sum, frame) => sum + frame.speed, 0) / span.length;
  const transitions = Math.max(1, dispatches.length);
  const counters = result.data?.counters as { searches?: number } | undefined;
  const searches = counters?.searches ?? null;
  const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
  const per100 = (value: number, total: number) => round(value / Math.max(1, total) * 100, 1);
  return {
    label,
    transitions: dispatches.length,
    clears: controlEvents.clears,
    clearsPer100Transitions: per100(controlEvents.clears, transitions),
    clearsByDispatch: controlEvents.clearsByDispatch,
    looks: controlEvents.looks,
    looksByDispatch: controlEvents.looksByDispatch,
    forwardOn: controlEvents.forwardOn,
    forwardOnByDispatch: controlEvents.forwardOnByDispatch,
    forwardOff: controlEvents.forwardOff,
    forwardOffByDispatch: controlEvents.forwardOffByDispatch,
    forwardHeldAtDispatch: controlEvents.forwardHeldAtDispatch,
    settleCalls: controlEvents.settleCalls,
    settleForwardOff: controlEvents.settleForwardOff,
    checkpoints: controlEvents.checkpoints,
    settleCallsByDispatch: controlEvents.settleCallsByDispatch,
    stableTicks: span.length,
    stopped,
    stopsPer100Ticks: per100(stopped, span.length),
    back,
    avgSpeed: round(avgSpeed, 4),
    tickGapsOver100: controlEvents.tickGapsOver100,
    maxTickGap: round(controlEvents.maxTickGap, 1),
    tickCellQueries: controlEvents.tickCellQueries,
    tickSectionQueries: controlEvents.tickSectionQueries,
    searches,
    searchesPer100Transitions: searches === null ? null : per100(searches, transitions),
  };
}

/** 记录一次场景的测量结果；所有基线场景用同一种诊断格式，便于横向对照。 */
function logRun(
  t: { diagnostic(message: string): void },
  label: string,
  frames: { speed: number; back: boolean }[],
  dispatches: { frameStart: number }[],
  controlEvents: Parameters<typeof measureRun>[3],
  result: { data?: Record<string, unknown> },
) {
  t.diagnostic(JSON.stringify(measureRun(label, frames, dispatches, controlEvents, result)));
}

/**
 * 连续控制后的固定断言：直行段不再每个 transition 都清键。
 * 转弯/台阶/下落仍可清键（方向或支撑变化），但每次清键都应重新按一次前进。
 */
function assertStraightRunKeepsControls(
  dispatches: { frameStart: number }[],
  controlEvents: {
    clears: number; looks: number; forwardOn: number; clearsByDispatch: number[]; looksByDispatch: number[];
    forwardOnByDispatch: number[]; forwardHeldAtDispatch: boolean[];
  },
) {
  assert.ok(controlEvents.clears < dispatches.length, '直行段不再每个 transition 都清一次控制键');
  assert.ok(controlEvents.forwardOn >= controlEvents.clears, '每次清键后重新按一次前进');
  assert.equal(controlEvents.looks, controlEvents.clears, '每次重新起步（清键）都重新转向；接续的 transition 不再 look');
  assert.deepEqual(controlEvents.looksByDispatch, controlEvents.clearsByDispatch, 'look 与 clear 按 transition 一一对应');
  assert.ok(controlEvents.clearsByDispatch.every((count) => count <= 1), '同一 transition 不重复清键');
  assert.ok(dispatches.every((_, index) => controlEvents.forwardHeldAtDispatch[index] === true || (controlEvents.forwardOnByDispatch[index] ?? 0) >= 1),
    '每个 transition 开始时前进键已按住，或本段重新按下');
  assert.ok(dispatches.every((_, index) => controlEvents.forwardHeldAtDispatch[index] !== true
    || (controlEvents.clearsByDispatch[index] === 0 && controlEvents.looksByDispatch[index] === 0)),
  '接续的 transition 不清键、不重新转向');
}

/** 连续路线除末步外都应带 settleAtTarget:false，由下一段接续。 */
function assertContinuousHandoff(dispatches: { continuous: boolean }[]) {
  assert.ok(dispatches.slice(0, -1).every((dispatch) => dispatch.continuous), '除末步外都按连续交接派发');
}

/** 每个 transition 都应在时间线上留下派发。清键只发生在起步、转弯或支撑变化处。 */
function assertTimelineCoversDispatches(timeline: ControlEvent[], dispatches: { frameStart: number }[]) {
  assert.ok(dispatches.every((_, index) => timeline.some((event) => event.dispatch === index && event.kind === 'move-to')),
    '每个 transition 都能在时间线上找到派发');
}

test('真实物理：先斜向再直行的路线一路不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches } = setup(() => 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -3, z1: 8 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 8, y: 64, z: 3 }, allowed: ['walk'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(dispatches.length, 8, '3 步斜向 + 5 步直行');
  assertContinuousHandoff(dispatches);
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '中间没有停车帧');
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [8, 64, 3]);
  t.diagnostic(`diagonal+straight: ${frames.length - dispatches[0]!.frameStart} frames`);
});

test('真实物理：一格落差的下坡路线不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches, controlEvents } = setup((x) => x >= 4 ? 62 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -2, z1: 2 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 9, y: 63, z: 0 }, allowed: ['walk', 'drop'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'drop1', frames, dispatches, controlEvents, result);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  assertTimelineCoversDispatches(controlEvents.timeline, dispatches);
  assertContinuousHandoff(dispatches);
  const dropIndex = dispatches.findIndex((dispatch) => dispatch.target.y === 63);
  assert.ok(dropIndex >= 1, '找到一格落差的 transition');
  assert.equal(controlEvents.forwardHeldAtDispatch[dropIndex], true, '落差 transition 接续前进键');
  assert.equal(controlEvents.clearsByDispatch[dropIndex], 0, '落差 transition 不再清键');
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '中间没有停车帧');
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [9, 63, 0]);
});

test('真实物理：连续上台阶从格列远端起步也能跳上去，不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches, controlEvents } = setup((x) => x >= 5 ? 65 : x >= 3 ? 64 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -2, z1: 2 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 9, y: 66, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'step2', frames, dispatches, controlEvents, result);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  assertTimelineCoversDispatches(controlEvents.timeline, dispatches);
  assertContinuousHandoff(dispatches);
  const { stopped, back } = middle(frames, dispatches);
  assert.ok(stopped <= 2, `贴墙起跳时每级台阶最多 1 帧速度归零，实际 ${stopped} 帧`);
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [9, 66, 0]);
});

test('真实物理：上一级台阶后接平地，起跳不越过台阶上的落点，一路不停车', { timeout: 30_000 }, async (t) => {
  const { ctx, timer, entity, frames, dispatches } = setup((x) => x >= 3 ? 64 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -2, z1: 2 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 8, y: 65, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.replanCount, undefined, `没有因越过落点而重新规划：${result.summary}`);
  assertContinuousHandoff(dispatches);
  const { back } = middle(frames, dispatches);
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [8, 65, 0]);
});

test('真实物理：上台阶后紧接转弯，起跳惯性不越过转弯点', { timeout: 30_000 }, async (t) => {
  // x≥3 一侧高一格；z 方向只开一条 x=3 的通道，上台阶后必须转向 +z。
  const { ctx, timer, entity, frames, dispatches } = setup((x, z) => x >= 4 && z < 1 ? 70 : x >= 3 ? 64 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 8, z0: -2, z1: 8 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 3, y: 65, z: 6 }, allowed: ['walk', 'step'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.replanCount, undefined, `没有因越过落点而重新规划：${result.summary}`);
  const { back } = middle(frames, dispatches);
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [3, 65, 6]);
});

test('连续控制：平地直路只在起步清一次控制键', async (t) => {
  const { ctx, timer, frames, dispatches, controlEvents } = setup(() => 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -3, z1: 3 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 8, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'flat8', frames, dispatches, controlEvents, result);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  assert.equal(controlEvents.clears, 1, '8 个 transition 只在起步清一次');
  assert.equal(controlEvents.forwardOn, 1, '前进键只按一次，后续直接接续');
  assert.deepEqual(controlEvents.clearsByDispatch, [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(controlEvents.forwardOff, 1, '只有本段最终交接/停稳时松一次前进键');
  assert.equal(controlEvents.forwardOffByDispatch.at(-1), 1, '松开前进键归属末次派发');
  assert.equal(controlEvents.checkpoints, 7, '8 个 transition 中有 7 次真实交接');
  assert.equal(controlEvents.tickCellQueries, 0, 'physicsTick 内不做 cell 体素查询（下一步复验在 tick 外预计算）');
  assert.equal(controlEvents.tickSectionQueries, 0, 'physicsTick 内不做 section 体素查询');
  const events = controlEvents.timeline;
  assert.deepEqual(events.slice(0, 4).map(({ dispatch, kind }) => ({ dispatch, kind })),
    [{ dispatch: 0, kind: 'move-to' }, { dispatch: 0, kind: 'look' }, { dispatch: 0, kind: 'clear' }, { dispatch: 0, kind: 'forward-on' }],
    '时间线按派发顺序记录派发、转向、清键与重新按键');
  assertTimelineCoversDispatches(events, dispatches);
  const tickOf = (kind: string) => events.filter((event) => event.kind === kind).map((event) => event.tick);
  assert.deepEqual(tickOf('clear'), tickOf('forward-on'), '清键与重新按键落在同一物理帧，中间没有跨帧空档');
});

test('连续控制：平地 64 格直路只在分段起步清键', { timeout: 120_000 }, async (t) => {
  const { ctx, timer, frames, dispatches, controlEvents } = setup(() => 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 70, z0: -3, z1: 3 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 64, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 160, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'flat64', frames, dispatches, controlEvents, result);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  assert.equal(controlEvents.clears, 2, '64 格直路只在两段起步各清一次');
  assert.deepEqual(controlEvents.clearsByDispatch.flatMap((count, index) => count === 0 ? [] : [index]), [0, 32], '两次清键分别落在两段起步，不在直行中间');
  assert.equal(controlEvents.forwardOn, 2);
  assert.ok(controlEvents.checkpoints >= dispatches.length - 3, '直路的大部分 transition 都经过真实 checkpoint 交接');
  assert.equal(controlEvents.tickCellQueries, 0, '64 个 transition 的 checkpoint 都不在 physicsTick 内查 cell');
  assert.equal(controlEvents.tickSectionQueries, 0, '64 个 transition 的 checkpoint 都不在 physicsTick 内查 section');
  assertTimelineCoversDispatches(controlEvents.timeline, dispatches);
  assertContinuousHandoff(dispatches);
});

test('连续控制：三次转弯的窄走廊不重规划、不停车', { timeout: 120_000 }, async (t) => {
  const corridor = (x: number, z: number) =>
    (x >= 0 && x <= 6 && z >= 0 && z <= 2)
    || (x >= 5 && x <= 7 && z >= -6 && z <= 2)
    || (x >= 5 && x <= 12 && z >= -8 && z <= -6)
    || (x >= 11 && x <= 13 && z >= -14 && z <= -6);
  const { ctx, timer, frames, dispatches, controlEvents } = setup(() => 63, { x: 1.5, y: 64, z: 1.5 }, { x0: -3, x1: 15, z0: -16, z1: 4 },
    { blockName: (x, y, z) => y <= 63 || !corridor(x, z) ? 'stone' : 'air' });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 12, y: 64, z: -13 }, allowed: ['walk'], historical: false, maxSteps: 96, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'corridor3turns', frames, dispatches, controlEvents, result);
  assert.equal(result.data?.replanCount, undefined, `转弯前先松键减速，不因冲过转弯点重规划：${result.summary}`);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  assert.ok(controlEvents.clearsByDispatch.filter((count) => count > 0).length >= 4, '起步与每个转弯点都重新清键/转向');
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '转弯不产生停车帧');
  assert.equal(back, 0, '转弯不做后退修正');
  assertTimelineCoversDispatches(controlEvents.timeline, dispatches);
});

test('连续控制：下界地形代理（落差 + 台阶 + 窄口转弯）', { timeout: 60_000 }, async (t) => {
  // 真实下界的通行条件需要另外用 Java 服务器验收；这里只用同高度/同转弯形状的合成地形测控制键节奏。
  const floor = (x: number) => x >= 4 && x < 8 ? 62 : 63;
  // 东向走廊 3 格宽；南向转弯只留 x=9 一格宽，模拟下界窄口。
  const corridor = (x: number, z: number) => (x >= -1 && x <= 10 && z >= -1 && z <= 1) || (x === 9 && z >= -1 && z <= 5);
  const { ctx, timer, frames, dispatches, controlEvents } = setup(floor, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -3, z1: 7 },
    { blockName: (x, y, z) => y <= floor(x) || !corridor(x, z) ? 'netherrack' : 'air' });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 9, y: 64, z: 4 }, allowed: ['walk', 'step', 'drop'], historical: false, maxSteps: 32, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  logRun(t, 'nether-proxy', frames, dispatches, controlEvents, result);
  assert.equal(result.data?.replanCount, undefined, `落差/台阶/窄口转弯不重规划：${result.summary}`);
  assertStraightRunKeepsControls(dispatches, controlEvents);
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '落差/台阶/窄口转弯不停车');
  assert.equal(back, 0);
  assertTimelineCoversDispatches(controlEvents.timeline, dispatches);
});
