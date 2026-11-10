import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('spatial_extrema：deepest/farthest/gaps 已退役，只能 explored；参数边界仍校验', () => {
  const w = new FakeAdapter();
  for (const metric of ['deepest', 'farthest', 'gaps'] as const) {
    const parsed = spatialExtrema.validate({ metric }, w);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /已退役|只支持 explored/);
  }
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
