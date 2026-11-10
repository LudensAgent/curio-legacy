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

function setup() {
  const from = { x: -20.37, y: 64, z: -2.44 };
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const surface = surfaces[Math.max(0, p.x + 21) % surfaces.length]!;
      const block = p.y === 63 ? Block.fromProperties(surface.name, surface.props, 0)
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
  const timer = setInterval(() => physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot), 50);
  timer.unref();
  const stops: Vec3Like[] = [];
  class SurfaceAdapter extends FakeAdapter {
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
  for (let x = -23; x <= 2; x++) for (let z = -5; z <= 0; z++) for (let y = 60; y <= 68; y++) {
    const pos = { x, y, z }, block = adapter.blockStateAt(pos);
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: `minecraft:${block.name}`, properties: block.properties }, pos });
  }
  const ctx = { ...makeCtx(adapter, { deadlineMs: 120_000 }), spatial: {
    worldId: adapter.worldId, session: { voxel: map }, closing: false,
  } as unknown as SharedSpatialSession };
  return { adapter, ctx, timer, controls, stops, looks, from };
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
