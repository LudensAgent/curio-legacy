import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { spatialExtrema } from '../src/skills/spatial-extrema.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const DIM = 'overworld';

function ctxOf(spatial: SharedSpatialSession) {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.dim = DIM;
  return { ...makeCtx(w, { deadlineMs: 30000 }), spatial };
}

test('spatial_extrema：explored 按区块访问记录给八方位最远与边缘区块', async () => {
  const visits = [-1, 0, 1, 2, 3].map((cx) => ({ cx, cz: 0, count: 1 }));
  const spatial = { closing: false, session: { lifecycle: 'open', ledger: { chunkVisits: () => visits } }, query: () => { throw new Error('不读片段'); } } as unknown as SharedSpatialSession;
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'explored' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.visitedChunks, 5);
  const sectors = r.data?.sectors as Record<string, { farthest: { distance: number }; edgeChunks: number }>;
  assert.equal(sectors.E!.farthest.distance, Math.round(3 * 16 + 8 - 0.5));
  assert.equal(Object.values(sectors).reduce((n, sector) => n + sector.edgeChunks, 0), 5, '一排区块每块都有没去过的邻区块');
  assert.deepEqual(r.data?.bounds, { minX: -16, maxX: 63, minZ: 0, maxZ: 15 });
});

test('spatial_extrema：farthest/gaps 已退役；explored/deepest 可用；参数边界仍校验', () => {
  const w = new FakeAdapter();
  for (const metric of ['farthest', 'gaps'] as const) {
    const parsed = spatialExtrema.validate({ metric }, w);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /已退役/);
  }
  assert.ok(spatialExtrema.validate({ metric: 'deepest', radius: 64 }, w).ok);
  assert.equal(spatialExtrema.validate({ metric: 'deepest', radius: 0 }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'nope' }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'explored', kinds: ['dug'] }, w).ok, false, '片段 kinds 不再接受');
  assert.equal(spatialExtrema.validate({ metric: 'explored', origin: { x: 0, y: 0 } }, w).ok, false);
  assert.ok(spatialExtrema.validate({ metric: 'explored', origin: { x: 0, y: 64, z: 0 } }, w).ok);
});

test('spatial_extrema：跨维度 explored 没给 origin 时拒绝，不读片段', async () => {
  let queried = false;
  const spatial = { closing: false, session: { lifecycle: 'open', ledger: { chunkVisits: () => [] } }, query: () => { queried = true; return { status: 'ok' }; } } as unknown as SharedSpatialSession;
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'explored', dim: 'the_nether' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.equal(queried, false, 'explored 不读片段/查询端口');
});

test('spatial_extrema：deepest 返回半径内身体实际站过的最低脚格（以前走过的矿道最深处）', async () => {
  const voxel = new VoxelMap('fake-world', { validityWindowMs: 1e12 });
  voxel.beginSession('s');
  // 一条往下挖的阶梯矿道：站过 y=64..20；另有一处更深的到访记录在半径外。
  for (let i = 0; i <= 44; i++) voxel.markTraversed(DIM, { x: 10 + i, y: 64 - i, z: 3 });
  voxel.markTraversed(DIM, { x: 500, y: 5, z: 0 });
  voxel.markTraversed('the_nether', { x: 0, y: 1, z: 0 });
  const spatial = { closing: false, session: { lifecycle: 'open', voxel, voxelLoading: 'eager' } } as unknown as SharedSpatialSession;
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest', radius: 128 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.deepest, { x: 54, y: 20, z: 3 });
  assert.match(r.summary, /最低脚格是 \(54,20,3\)/);
  const none = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest', radius: 5 });
  assert.equal(none.data?.deepest, null);
  assert.match(none.summary, /没有身体站过的记录/);
});

test('spatial_extrema：reach 按八方位给身体站过的最远脚格', async () => {
  const voxel = new VoxelMap('fake-world', { validityWindowMs: 1e12 });
  voxel.beginSession('s');
  for (let i = 1; i <= 200; i++) voxel.markTraversed(DIM, { x: i, y: 64, z: 0 });   // 往东的旧巷，到 x=200
  for (let i = 1; i <= 40; i++) voxel.markTraversed(DIM, { x: 0, y: 64, z: -i });   // 往北 40 格
  voxel.markTraversed('the_nether', { x: 300, y: 64, z: 0 });
  const spatial = { closing: false, session: { lifecycle: 'open', voxel, voxelLoading: 'eager' } } as unknown as SharedSpatialSession;
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'reach' });
  assert.equal(r.status, 'succeeded', r.summary);
  const sectors = r.data?.sectors as Record<string, { pos: { x: number; y: number; z: number }; distance: number }>;
  assert.deepEqual(sectors.E!.pos, { x: 200, y: 64, z: 0 });
  assert.equal(sectors.N!.distance, 40);
  assert.equal(sectors.W, undefined);
  assert.match(r.summary, /E 200 格 \(200,64,0\)/);
});

test('spatial_extrema：manual 模式下按会话的 worker 分页列存盘目录，不调用 VoxelMap 自己的 directoryPage', async () => {
  const voxel = new VoxelMap('fake-world', { validityWindowMs: 1e12 });
  voxel.beginSession('s');
  for (let i = 1; i <= 50; i++) voxel.markTraversed(DIM, { x: i, y: 64, z: 0 });
  (voxel as unknown as { directoryPage: () => never }).directoryPage = () => { throw new Error('directory metadata is not resident; use the session worker-backed directoryPage'); };
  let pages = 0;
  const session = { lifecycle: 'open', voxel, voxelLoading: 'manual',
    sectionResidency: () => ({ residency: 'no_record' }),
    directoryPage: async () => { pages++; return { items: [], nextAfter: undefined }; } };
  const spatial = { closing: false, session } as unknown as SharedSpatialSession;
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'reach' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(pages, 1);
  assert.equal((r.data?.sectors as Record<string, { distance: number }>).E!.distance, 50);
});
