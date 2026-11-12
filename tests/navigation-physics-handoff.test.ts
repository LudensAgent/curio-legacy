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

/** 真实 prismarine 物理逐 tick 推进；地面高度由 groundTop(x,z) 给出（该列最高实心方块的 y）。 */
function setup(groundTop: (x: number, z: number) => number, from: Vec3Like, bounds: { x0: number; x1: number; z0: number; z1: number }) {
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const block = Block.fromStateId(data.blocksByName[p.y <= groundTop(p.x, p.z) ? 'stone' : 'air'].defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const controlEvents = { clears: 0, forwardOn: 0, forwardOff: 0 };
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
      if (name === 'forward') {
        if (value && !controls.forward) controlEvents.forwardOn++;
        if (!value && controls.forward) controlEvents.forwardOff++;
      }
      controls[name] = value;
    },
    clearControlStates() {
      controlEvents.clears++;
      Object.keys(controls).forEach((key) => { controls[key] = false; });
    },
    async look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  });
  const driver = new MineflayerAdapter(config, new EventBus());
  driver.bot = bot as unknown as NonNullable<MineflayerAdapter['bot']>;
  driver.mcData = data;
  Reflect.set(driver, 'connectedFlag', true);
  const physics = Physics(data, world);
  for (let tick = 0; tick < 2; tick++) physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
  const frames: { speed: number; back: boolean }[] = [];
  const timer = setInterval(() => {
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
    bot.emit('physicsTick');
    frames.push({ speed: Math.hypot(entity.velocity.x, entity.velocity.z), back: controls.back === true });
  }, 50);
  timer.unref();
  const dispatches: { continuous: boolean; frameStart: number }[] = [];
  class PhysicsAdapter extends FakeAdapter {
    async settleMovement(opts: Pick<MoveOpts, 'signal' | 'timeoutMs'>) { await driver.settleMovement(opts); }
    override state() { return { ...super.state(), pos: { ...entity.position }, onGround: entity.onGround }; }
    override blockAt(pos: Vec3Like) { return world.getBlock(new Vec3(pos.x, pos.y, pos.z)).name as string; }
    override blockStateAt(pos: Vec3Like) { return { name: world.getBlock(new Vec3(pos.x, pos.y, pos.z)).name as string, properties: {} }; }
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      assert.equal(target.kind, 'feet');
      dispatches.push({ continuous: opts.settleAtTarget === false, frameStart: frames.length });
      await driver.moveTo(target, opts);
      this.pos = { ...entity.position };
    }
  }
  const adapter = new PhysicsAdapter();
  adapter.pos = { ...from };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 600_000 });
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
  return { stopped: span.filter((frame) => frame.speed < 0.003).length, back: span.filter((frame) => frame.back).length };
}

test('真实物理：先斜向再直行的路线一路不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches } = setup(() => 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -3, z1: 8 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 8, y: 64, z: 3 }, allowed: ['walk'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(dispatches.length, 8, '3 步斜向 + 5 步直行');
  assert.ok(dispatches.slice(0, -1).every((dispatch) => dispatch.continuous));
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '中间没有停车帧');
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [8, 64, 3]);
  t.diagnostic(`diagonal+straight: ${frames.length - dispatches[0]!.frameStart} frames`);
});

test('真实物理：一格落差的下坡路线不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches } = setup((x) => x >= 4 ? 62 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -2, z1: 2 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 9, y: 63, z: 0 }, allowed: ['walk', 'drop'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(dispatches.slice(0, -1).every((dispatch) => dispatch.continuous));
  const { stopped, back } = middle(frames, dispatches);
  assert.equal(stopped, 0, '中间没有停车帧');
  assert.equal(back, 0, '中间没有后退修正');
  assert.deepEqual([Math.floor(entity.position.x), entity.position.y, Math.floor(entity.position.z)], [9, 63, 0]);
});

test('真实物理：连续上台阶从格列远端起步也能跳上去，不停车、不后退', async (t) => {
  const { ctx, timer, entity, frames, dispatches } = setup((x) => x >= 5 ? 65 : x >= 3 ? 64 : 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -2, z1: 2 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 9, y: 66, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(dispatches.slice(0, -1).every((dispatch) => dispatch.continuous));
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
  assert.ok(dispatches.slice(0, -1).every((dispatch) => dispatch.continuous));
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

test('基线：平地连续路线的每次 transition 都会清一次控制键', async (t) => {
  const { ctx, timer, dispatches, controlEvents } = setup(() => 63, { x: 0.5, y: 64, z: 0.5 }, { x0: -3, x1: 12, z0: -3, z1: 3 });
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const result = await navigateTo.run(ctx, { to: { x: 8, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(result.status, 'succeeded', result.summary);
  t.diagnostic(`dispatches=${dispatches.length} clears=${controlEvents.clears} forwardOn=${controlEvents.forwardOn} forwardOff=${controlEvents.forwardOff}`);
  assert.ok(controlEvents.clears >= dispatches.length, '当前基线：每格 moveTo 都会 clearControlStates');
});
