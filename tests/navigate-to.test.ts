import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/index.ts';
import type { LandingOption } from '../src/skills/types.ts';
import type { MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

function flatMap() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 5; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', Array.from({ length: 7 }, (_, x) => ({ x: x - 1, y: 63, z: 0 })));
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed',
      contract: 'memory-host-contract/1',
      library: { execute: { walk: true } },
      host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

class DropWorld extends FakeAdapter {
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'xyz') { this.pos = { x: target.x, y: target.y, z: target.z }; return; }
    return super.moveTo(target, opts);
  }
}

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const base = makeCtx(adapter);
  const ctx = { ...base, spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

test('navigate_to 自己执行 3D walk 路线，Agent 不用手抄 move_step 坐标', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 3, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'current');
  assert.ok((r.data?.executed as number) >= 3);
  assert.equal(Math.floor(adapter.pos.x), 3);
  assert.equal(Math.floor(adapter.pos.z), 0);
});

test('navigate_to 当前证据无路时使用历史体素候选路线，但仍逐步现场核实', async (t) => {
  const map = flatMap();
  map.markStale(DIM, 'expired');
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'historical');
  assert.equal(Math.floor(adapter.pos.x), 2);
});

test('navigate_to 从 1×1 平台用显式 2 格下落到真实站立面', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 60; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }, { x: 1, y: 61, z: 0 }]);
  const adapter = new DropWorld();
  adapter.groundY = -100;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }, { name: 'stone', pos: { x: 1, y: 61, z: 0 } });
  const option: LandingOption = {
    target: { x: 1.5, y: 62, z: 0.5 }, support: { pos: { x: 1, y: 61, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 62, drop: 2, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  const fresh = () => ({ ...option, receipt: { ...option.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId } });
  ctx.senses.landingOptions = () => [fresh()];
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 1, y: 62, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(adapter.pos.y), 62);
  const transitions = r.data?.transitions as { kind: string; drop: number }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.drop]), [['drop', 2]]);
});

test('navigate_to 从 1×1 平台用 4 格下落也能执行', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 58; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }, { x: 1, y: 59, z: 0 }]);
  const adapter = new DropWorld();
  adapter.groundY = -100;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }, { name: 'stone', pos: { x: 1, y: 59, z: 0 } });
  const option: LandingOption = {
    target: { x: 1.5, y: 60, z: 0.5 }, support: { pos: { x: 1, y: 59, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 60, drop: 4, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 0, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  const fresh = () => ({ ...option, receipt: { ...option.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId } });
  ctx.senses.landingOptions = () => [fresh()];
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 1, y: 60, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(adapter.pos.y), 60);
  assert.equal((r.data?.transitions as { drop?: number }[] | undefined)?.[0]?.drop, 4);
});

test('navigate_to 没有 walk/step/drop 路线时停下报边界，不移动', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:air', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }]);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /找不到可执行|边界/);
  assert.deepEqual(adapter.actions, []);
});
