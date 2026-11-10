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
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { lookAround } from '../src/skills/movement.ts';
import { feetGoal } from '../src/skills/movement/goal.ts';
import { runNavigationSegment } from '../src/skills/movement/segment.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');
const surfaces = [
  { name: 'stone', props: {}, top: 1 },
  { name: 'dirt_path', props: {}, top: 0.9375 },
  { name: 'farmland', props: { moisture: 0 }, top: 0.9375 },
  { name: 'oak_slab', props: { type: 'bottom', waterlogged: false }, top: 0.5 },
  { name: 'snow', props: { layers: 8 }, top: 0.875 },
  { name: 'oak_stairs', props: { half: 'bottom', facing: 'east', shape: 'straight', waterlogged: false }, top: 1 },
];

const lowStairs = {
  N: { from: { x: -20.19, y: 63.5, z: -2.44 }, bearing: { x: 0, z: -1 }, facing: 'west' },
  E: { from: { x: -20.37, y: 63.5, z: -2.19 }, bearing: { x: 1, z: 0 }, facing: 'north' },
  S: { from: { x: -20.81, y: 63.5, z: -2.44 }, bearing: { x: 0, z: 1 }, facing: 'east' },
  W: { from: { x: -20.37, y: 63.5, z: -2.81 }, bearing: { x: -1, z: 0 }, facing: 'south' },
};

function setup(direction?: keyof typeof lowStairs) {
  const low = direction === undefined ? undefined : lowStairs[direction];
  const from = low?.from ?? { x: -20.37, y: 64, z: -2.44 };
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const surface = surfaces[Math.max(0, p.x + 21) % surfaces.length]!;
      const stairColumn = low !== undefined && (low.bearing.x === 0 ? p.x === Math.floor(from.x) : p.z === Math.floor(from.z));
      const block = p.y === 63 ? low === undefined ? Block.fromProperties(surface.name, surface.props, 0)
        : stairColumn ? Block.fromProperties('oak_stairs', { half: 'bottom', facing: low.facing, shape: 'straight', waterlogged: false }, 0)
          : Block.fromStateId(data.blocksByName.air.defaultState, 0)
        : Block.fromStateId(data.blocksByName[p.y < 63 ? 'stone' : 'air'].defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(from.x, from.y, from.z), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, pitch: 0,
    onGround: true, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, effects: {}, attributes: {}, eyeHeight: 1.62,
  };
  const looks: number[] = [];
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.1', entity, controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [] }, vehicle: null, game: { dimension: 'overworld' },
    blockAt: (pos: Vec3) => world.getBlock(pos),
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { Object.keys(controls).forEach((key) => { controls[key] = false; }); },
    async look(yaw: number, pitch: number) { looks.push(yaw); entity.yaw = yaw; entity.pitch = pitch; },
  });
  const driver = new MineflayerAdapter(config, new EventBus());
  driver.bot = bot as unknown as NonNullable<MineflayerAdapter['bot']>;
  driver.mcData = data;
  Reflect.set(driver, 'connectedFlag', true);
  const physics = Physics(data, world);
  // Establish actual gravity/support contact before navigation can read onGround.
  for (let tick = 0; tick < 2; tick++) physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
  const timer = setInterval(() => physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot), 50);
  timer.unref();
  const stops: Vec3Like[] = [];
  class SurfaceAdapter extends FakeAdapter {
    async settleMovement(opts: Pick<MoveOpts, 'signal' | 'timeoutMs'>) { await driver.settleMovement(opts); }
    override state() { return { ...super.state(), pos: { ...entity.position }, onGround: entity.onGround }; }
    override blockAt(pos: Vec3Like) { return world.getBlock(new Vec3(pos.x, pos.y, pos.z)).name as string; }
    override blockStateAt(pos: Vec3Like) {
      const block = world.getBlock(new Vec3(pos.x, pos.y, pos.z));
      return { name: block.name as string, properties: Object.fromEntries(
        Object.entries(block.getProperties()).map(([name, value]) => [name, String(value)])) };
    }
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      assert.equal(target.kind, 'feet', 'route execution must preserve continuous endpoints');
      await driver.moveTo(target, opts);
      this.pos = { ...entity.position };
      stops.push({ ...this.pos });
    }
  }
  const adapter = new SurfaceAdapter();
  adapter.pos = { ...from };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 600_000 });
  let sequence = 0;
  const bounds = low === undefined ? { x0: -23, x1: 2, z0: -5, z1: 0 } : {
    x0: Math.floor(from.x) + Math.min(0, low.bearing.x * 8) - 2,
    x1: Math.floor(from.x) + Math.max(0, low.bearing.x * 8) + 2,
    z0: Math.floor(from.z) + Math.min(0, low.bearing.z * 8) - 2,
    z1: Math.floor(from.z) + Math.max(0, low.bearing.z * 8) + 2,
  };
  for (let x = bounds.x0; x <= bounds.x1; x++) for (let z = bounds.z0; z <= bounds.z1; z++) for (let y = 60; y <= 68; y++) {
    const pos = { x, y, z }, block = adapter.blockStateAt(pos);
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: `minecraft:${block.name}`, properties: block.properties }, pos });
  }
  const ctx = { ...makeCtx(adapter, { deadlineMs: 120_000 }), spatial: {
    worldId: adapter.worldId, session: { voxel: map }, closing: false,
  } as unknown as SharedSpatialSession };
  return { adapter, ctx, timer, controls, stops, looks, from, map, entity };
}

test('连续路线下一步证据失效后，回执采样实际制动终点而非交接旧位置', async (t) => {
  const { adapter, ctx, timer, controls, stops, from, map, entity } = setup('E');
  t.after(() => { clearInterval(timer); ctx.memory.close(); });
  const original = adapter.moveTo.bind(adapter);
  t.mock.method(adapter, 'moveTo', async (target, opts) => {
    assert.equal(opts.settleAtTarget, false);
    await original(target, opts);
    map.markStale(adapter.dim, 'observation_gap');
  });
  const result = await runNavigationSegment(ctx, {
    goal: feetGoal({ ...from, x: from.x + 6 }), allowed: ['walk', 'step'], historical: false,
    maxTransitions: 8, allowUnknownCorridor: false, deadline: ctx.deadline, searchBudget: 1,
  });
  assert.equal(result.outcome, 'unknown_boundary', result.detail);
  assert.equal(result.confirmed.length, 1);
  assert.equal(stops.length, 1, '不能向失效后的下一段继续发控制');
  assert.ok(result.measuredEnd.x > stops[0]!.x + 0.05, '失败回执须包含松键后的真实惯性位移');
  assert.deepEqual(result.measuredEnd, { ...entity.position });
  assert.deepEqual(result.partialDisplacement?.to, result.measuredEnd);
  assert.ok(Math.hypot(entity.velocity.x, entity.velocity.z) < 0.003);
  assert.ok(Object.values(controls).every(held => !held));
});

for (const direction of ['N', 'E', 'S', 'W'] as const) {
  test(`travel_to walks ${direction} along actual stair lower faces at y=63.5 without climbing the high half`, async (t) => {
    const { adapter, ctx, timer, controls, stops, looks, from } = setup(direction);
    t.after(() => { clearInterval(timer); ctx.memory.close(); });
    const { bearing } = lowStairs[direction];
    const result = await travelTo.run(ctx, {
      to: { x: from.x + bearing.x * 6, y: 63.5, z: from.z + bearing.z * 6 },
      range: 1, timeoutMs: 120_000,
    });

    assert.equal(result.status, 'succeeded', result.summary);
    assert.ok(stops.length >= 4, `must traverse several lower faces, got ${stops.length} edges`);
    assert.ok(stops.every((point) => Math.abs(point.y - 63.5) < 0.01), `must land on the low face: ${JSON.stringify(stops)}`);
    assert.ok(stops.every((point, index) => {
      const previous = stops[index - 1] ?? from;
      return (point.x - previous.x) * bearing.x + (point.z - previous.z) * bearing.z > 0;
    }), 'the same narrow lower face must remain traversable along the selected direction');
    assert.ok(stops.every((point) => Math.abs((point.x - from.x) * bearing.z - (point.z - from.z) * bearing.x) <= 0.01),
      'the body must stay clear of the high stair half rather than moving to another surface');
    const heading = Math.atan2(-bearing.x, -bearing.z);
    assert.ok(looks.every((yaw) => Math.abs(Math.atan2(Math.sin(yaw - heading), Math.cos(yaw - heading))) < 0.01));
    assert.equal(adapter.state().onGround, true);
    assert.ok(Object.values(controls).every((held) => !held));
  });
}

for (const skill of ['travel_to', 'explore_toward'] as const) {
  test(`${skill} crosses actual path, farmland, slab, snow and stair shapes with fractional feet`, async (t) => {
    const { adapter, ctx, timer, controls, stops, looks, from } = setup();
    t.after(() => { clearInterval(timer); ctx.memory.close(); });
    // Observation is tested separately; here both entry points use real body physics for every edge.
    t.mock.method(lookAround, 'run', async () => ({ status: 'succeeded', summary: 'observed' }));
    const result = skill === 'explore_toward'
      ? await exploreToward.run(ctx, { direction: 'E', distance: 16, origin: from, segment: 16,
        maxLateralDrift: 4, timeoutMs: 120_000 })
      : await travelTo.run(ctx, { to: { x: -2, y: 64, z: -3 }, range: 1, timeoutMs: 120_000 });

    assert.equal(result.status, 'succeeded', result.summary);
    assert.ok(stops.length >= 16, `must execute a continuous route, got ${stops.length} edges`);
    for (const top of [0.9375, 0.5, 0.875]) {
      assert.ok(stops.some((point) => Math.abs(point.y - 63 - top) < 0.01), `must physically stand at y=${63 + top}`);
    }
    assert.ok(stops.every((point, index) => point.x > (stops[index - 1]?.x ?? from.x)), 'the open route should keep advancing east');
    assert.ok(stops.every((point) => Math.abs(point.z - from.z) <= 0.12));
    assert.ok(looks.every((yaw) => Math.abs(Math.atan2(Math.sin(yaw + Math.PI / 2), Math.cos(yaw + Math.PI / 2))) < Math.PI / 2),
      'small braking corrections must not turn the body backwards');
    assert.equal(adapter.state().onGround, true);
    assert.ok(Object.values(controls).every((held) => !held), 'all controls are released on completion');
  });
}
