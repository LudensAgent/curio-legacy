import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { goNear } from '../src/skills/movement/index.ts';
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

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

function flatAroundTarget() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 4; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', Array.from({ length: 6 }, (_, x) => ({ x: x - 1, y: 63, z: 0 })));
  fill(map, 'minecraft:chest', [{ x: 2, y: 64, z: 0 }]);
  return map;
}

test('go_near 走到箱子旁的可达相邻站立格，不打开箱子', async (t) => {
  const map = flatAroundTarget();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.chosen, { x: 1, y: 64, z: 0 });
  assert.equal(r.data?.targetName, 'chest');
  assert.equal(Math.floor(adapter.pos.x), 1);
  assert.equal(Math.floor(adapter.pos.z), 0);
  assert.ok(!adapter.actions.some((a) => a.startsWith('useBlock')), 'go_near 不替 Agent 开箱/拿东西');
});

test('go_near 不把空气/站立格当交互方块', async (t) => {
  const map = flatAroundTarget();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 0, y: 64, z: 1 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.deepEqual(adapter.actions, []);
});

test('go_near 没有可达相邻站立格时停下报事实', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:chest', [{ x: 2, y: 64, z: 0 }]);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /没有找到可到达/);
  assert.ok(Array.isArray(r.data?.candidates));
  assert.deepEqual(adapter.actions, []);
});
