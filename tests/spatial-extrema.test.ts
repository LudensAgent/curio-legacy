import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PathFragment } from 'curio-minecraft-3d-memory';
import { spatialExtrema } from '../src/skills/spatial-extrema.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'extrema-world', DIM = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

function fragment(id: string, points: { x: number; y: number; z: number }[], overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id, worldId: WORLD, dim: DIM, kind: 'dug', entrances: [],
    polyline: points, geometrySource: 'traversal',
    deepestY: Math.min(...points.map((p) => p.y)),
    createdAt: 1, lastUsedAt: 2, uses: 1,
    ...overrides,
  };
}

function fakeSpatial(pages: PathFragment[][]) {
  const calls: Record<string, unknown>[] = [];
  let page = 0;
  const spatial = {
    closing: false,
    session: { lifecycle: 'open' },
    query(request: Record<string, unknown>) {
      calls.push(request);
      const items = pages[page] ?? [];
      const nextAfter = page + 1 < pages.length ? `cursor-${page + 1}` : undefined;
      page += 1;
      return {
        status: 'ok', contract: 'memory-host-contract/1', worldId: WORLD, dim: DIM,
        computedAt: 1, readOnly: true, executable: false,
        data: { kind: 'fragments', items, total: items.length, ...(nextAfter === undefined ? {} : { nextAfter }) },
        ...(nextAfter === undefined ? {} : { nextAfter }),
      };
    },
  };
  return { spatial: spatial as unknown as SharedSpatialSession, calls };
}

function ctxOf(spatial: SharedSpatialSession) {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.dim = DIM;
  return { ...makeCtx(w, { deadlineMs: 30000 }), spatial };
}

test('spatial_extrema：deepest 取全局最低点，并区分 deepestY 与 polyline 最低点', async () => {
  const { spatial } = fakeSpatial([[
    fragment('a', [at(0, 40, 0), at(1, 42, 0)], { deepestY: 38 }),
    fragment('b', [at(5, 50, 0)], { deepestY: 49 }),
  ]]);
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest', maxFragments: 1000 });
  assert.equal(r.status, 'succeeded', r.summary);
  const best = r.data?.best as { point: { y: number }; pointY: number; deepestY: number; fragment: { id: string } };
  assert.equal(best.fragment.id, 'a');
  assert.equal(best.pointY, 40);
  assert.equal(best.deepestY, 38);
  assert.match(r.summary, /最深记录点/);
  assert.match(r.summary, /历史记录/);
});

test('spatial_extrema：farthest 按 origin/space 计算，默认原点为当前脚位', async () => {
  const { spatial } = fakeSpatial([[
    fragment('near', [at(2, 64, 0)]),
    fragment('far', [at(20, 64, 0)]),
  ]]);
  const horizontal = await spatialExtrema.run(ctxOf(spatial), { metric: 'farthest', space: 'horizontal' });
  assert.equal((horizontal.data?.best as { fragment: { id: string } }).fragment.id, 'far');
  assert.equal((horizontal.data?.best as { distance: number }).distance, Math.hypot(19.5, 0.5));

  const { spatial: spatial2 } = fakeSpatial([[fragment('vertical', [at(1, 100, 0)])]]);
  const euclidean = await spatialExtrema.run(ctxOf(spatial2), { metric: 'farthest', space: 'euclidean' });
  assert.equal((euclidean.data?.best as { distance: number }).distance, Math.hypot(0.5, 36, -0.5));
});

test('spatial_extrema：kind/archived 过滤、分页与 truncated', async () => {
  const { spatial, calls } = fakeSpatial([
    [fragment('a', [at(0, 30, 0)])],
    [fragment('b', [at(0, 20, 0)]), fragment('archived', [at(0, 10, 0)], { metadata: { curio: { archivedAt: 5 } } })],
  ]);
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest', kinds: ['dug'], maxFragments: 10 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.best as { fragment: { id: string } }).fragment.id, 'b', 'archived 默认过滤');
  assert.equal((r.data?.scanned as { pages: number }).pages, 2);
  assert.equal((r.data?.scanned as { archivedSkipped: number }).archivedSkipped, 1);
  assert.equal(calls[0].fragmentKind, 'dug');
  assert.equal(calls[1].after, 'cursor-1');

  const { spatial: limited } = fakeSpatial([[fragment('a', [at(0, 30, 0)]), fragment('b', [at(0, 20, 0)])]]);
  const capped = await spatialExtrema.run(ctxOf(limited), { metric: 'deepest', maxFragments: 1 });
  assert.equal((capped.data?.best as { fragment: { id: string } }).fragment.id, 'a');
  assert.equal(capped.data?.truncated, true);
});

test('spatial_extrema：空 polyline 不伪造点；无匹配时 best=null 仍是成功', async () => {
  const { spatial } = fakeSpatial([[
    { ...fragment('empty', []), polyline: [], deepestY: 5 },
  ]]);
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.best, null);
  assert.equal((r.data?.scanned as { withoutPolyline: number }).withoutPolyline, 1);
});

test('spatial_extrema：跨维度 farthest 没给 origin 时拒绝，参数边界校验', async () => {
  const { spatial } = fakeSpatial([[]]);
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'farthest', dim: 'the_nether' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  const w = new FakeAdapter();
  assert.equal(spatialExtrema.validate({ metric: 'deepest', maxFragments: 0 }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'deepest', kinds: ['nope'] }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'deepest', origin: { x: 0, y: 0 } }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'nope' }, w).ok, false);
});
