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
    capabilities: () => ({
      owner: 'host_composed',
      contract: 'memory-host-contract/2',
      library: {},
      host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
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
  assert.ok(r.summary.includes('target 写 {"x":2,"y":64,"z":0}'), r.summary);
  assert.equal(Math.floor(adapter.pos.x), 1);
  assert.equal(Math.floor(adapter.pos.z), 0);
  assert.ok(!adapter.actions.some((a) => a.startsWith('useBlock')), 'go_near 不替 Agent 开箱/拿东西');
});

test('go_near 不把床的另一半当旁边的站立格', async (t) => {
  const map = flatAroundTarget();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'white_bed', pos: { x: 2, y: 64, z: 0 } }, { name: 'white_bed', pos: { x: 3, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.notDeepEqual(r.data?.chosen, { x: 3, y: 64, z: 0 });
  assert.notEqual(adapter.blockAt(r.data?.chosen as { x: number; y: number; z: number }), 'white_bed');
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
  // 身体当前列没有已观测支撑：不能把“零长度路线”当成可达站位。
  assert.equal((r.data?.candidates as { to: { x: number; z: number } }[]).some((c) => c.to.x === 0 && c.to.z === 0), false);
  assert.deepEqual(adapter.actions, []);
});

test('go_near 相邻格都不可站时退到第二环的可达站立格', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const floor = [{ x: -2, y: 63, z: 0 }, { x: -1, y: 63, z: 0 }, { x: 0, y: 63, z: 0 }];
  const chest = { x: 2, y: 64, z: 0 };
  // 每个格只观测一次，避免同毫秒重复观测被判成冲突。
  const xs = Array.from({ length: 9 }, (_, i) => i - 3);
  const zs = Array.from({ length: 7 }, (_, i) => i - 3);
  const air = xs.flatMap((x) => zs.flatMap((z) =>
    [63, 64, 65, 66].map((y) => ({ x, y, z })).filter((p) =>
      !floor.some((f) => f.x === p.x && f.y === p.y && f.z === p.z) && !(p.x === chest.x && p.y === chest.y && p.z === chest.z))));
  fill(map, 'minecraft:air', air);
  // 目标四周的第一环列都只有空气；只有起点通往第二环候选的一条走道有支撑。
  fill(map, 'minecraft:grass_block', floor);
  fill(map, 'minecraft:chest', [chest]);
  const { adapter, ctx } = setup(map);
  adapter.pos = { x: -1.5, y: 64, z: 0.5 };
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  // 相邻四列都走不过去，只有 Chebyshev 距离 2 的 (0,0) 可站。
  assert.deepEqual(r.data?.chosen, { x: 0, y: 64, z: 0 });
  assert.equal(r.data?.chosenRing, 2);
  assert.deepEqual(r.data?.ringsTried, [1, 2]);
  assert.equal(Math.floor(adapter.pos.x), 0);
  assert.equal(Math.floor(adapter.pos.z), 0);
  assert.ok(Math.abs(adapter.pos.y - 64) < 0.01);
});

test('go_near 按该列真实脚高接近：目标是门的上半格时，候选 y 解析到地面，到了就算到', async (t) => {
  const map = flatAroundTarget();
  const { adapter, ctx } = setup(map);
  // 竖直 3 格高的门；Agent 给的是最上面一格。
  adapter.blocks = adapter.blocks.filter((b) => b.name !== 'chest');
  for (const y of [64, 65, 66]) adapter.blocks.push({ name: 'nether_portal', pos: { x: 2, y, z: 0 } });
  fill(map, 'minecraft:air', [{ x: 1, y: 67, z: 0 }, { x: 3, y: 67, z: 0 }]);
  t.after(() => ctx.memory.close());
  const r = await goNear.run(ctx, {
    target: { x: 2, y: 66, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.chosen as { y: number }).y, 64, '交给导航的是解析后的脚高');
  assert.ok(Math.abs(adapter.pos.y - 64) < 0.01);
});
