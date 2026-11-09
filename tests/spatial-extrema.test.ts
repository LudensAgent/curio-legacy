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
  assert.match(r.summary, /最深记录脚点/);
  assert.match(r.summary, /更低观测 y=38/);
  assert.match(r.summary, /历史记录/);
  assert.equal(r.data?.origin, null);
  assert.equal(r.data?.space, 'horizontal');
  assert.deepEqual(Object.keys(spatial).sort(), ['closing', 'query', 'session'], '只读：没有写入入口');
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
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest', kinds: ['dug'], maxFragments: 10, includeArchived: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.best as { fragment: { id: string } }).fragment.id, 'b', 'includeArchived:false 时不计归档片段');
  assert.equal((r.data?.scanned as { pages: number }).pages, 2);
  assert.equal((r.data?.scanned as { archivedSkipped: number }).archivedSkipped, 1);
  // 归档只是旧运行时工作集淘汰，不是失效：默认计入并标注
  const { spatial: all } = fakeSpatial([[fragment('b', [at(0, 20, 0)]), fragment('archived', [at(0, 10, 0)], { metadata: { curio: { archivedAt: 5 } } })]]);
  const parsed = spatialExtrema.validate({ metric: 'deepest' }, new FakeAdapter());
  assert.ok(parsed.ok && parsed.args.includeArchived === true, '默认计入归档片段');
  const d = await spatialExtrema.run(ctxOf(all), parsed.args);
  assert.equal((d.data?.best as { fragment: { id: string; archived?: boolean } }).fragment.id, 'archived');
  assert.equal((d.data?.best as { fragment: { archived?: boolean } }).fragment.archived, true);
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
  assert.equal(spatialExtrema.validate({ metric: 'deepest', kinds: [] }, w).ok, false, '空 kinds 不能退化成扫全部');
  assert.equal(spatialExtrema.validate({ metric: 'deepest', origin: { x: 0, y: 0 } }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'deepest', space: 'diagonal' }, w).ok, false);
  assert.equal(spatialExtrema.validate({ metric: 'nope' }, w).ok, false);
});

test('spatial_extrema：deepest 计入旧 links 里的每一格，maxDistance 只看离原点范围内的点', async () => {
  const links = [{ a: at(0, 60, 0), b: at(1, 59, 0) }, { a: at(1, 59, 0), b: at(2, 12, 0) }, { a: at(200, 12, 0), b: at(200, -50, 0) }];
  const { spatial } = fakeSpatial([[fragment('old', [at(0, 60, 0)], { links, deepestY: -50, geometrySource: 'legacy' })]]);
  const all = await spatialExtrema.run(ctxOf(spatial), { metric: 'deepest' });
  assert.equal((all.data?.best as { point: { y: number } }).point.y, -50, 'polyline 只是抽样，links 的格也算');
  const { spatial: s2 } = fakeSpatial([[fragment('old', [at(0, 60, 0)], { links, deepestY: -50, geometrySource: 'legacy' })]]);
  const near = await spatialExtrema.run(ctxOf(s2), { metric: 'deepest', maxDistance: 32 });
  assert.equal((near.data?.best as { point: { y: number } }).point.y, 12);
  assert.match(near.summary, /离原点 32 格内/);
});

test('spatial_extrema：gaps 列出记录路径断开处的最近格对与两侧片段', async () => {
  const line = (id: string, x0: number, n: number) => fragment(id, [at(x0, 64, 0)], {
    links: Array.from({ length: n - 1 }, (_, i) => ({ a: at(x0 + i, 64, 0), b: at(x0 + i + 1, 64, 0) })), geometrySource: 'legacy',
  });
  const { spatial } = fakeSpatial([[line('west', 0, 10), line('east', 14, 5), line('faraway', 100, 5)]]);
  const r = await spatialExtrema.run(ctxOf(spatial), { metric: 'gaps', maxGap: 8, limit: 10 });
  assert.equal(r.status, 'succeeded', r.summary);
  const gaps = r.data?.gaps as { a: { x: number }; b: { x: number }; distance: number; delta: { dx: number }; sideA: { fragments: string[] }; sideB: { fragments: string[] }; fromOrigin: number }[];
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.distance, 5);
  assert.deepEqual([...gaps[0]!.sideA.fragments, ...gaps[0]!.sideB.fragments].sort(), ['east', 'west']);
  assert.equal(r.data?.components, 3);
  assert.match(r.summary, /中间实际是什么要看当前方块/);
  const { spatial: s2 } = fakeSpatial([[line('west', 0, 10), line('east', 14, 5)]]);
  const far = await spatialExtrema.run(ctxOf(s2), { metric: 'gaps', maxGap: 8, limit: 10, maxDistance: 2 });
  assert.equal((far.data?.gaps as unknown[]).length, 0, '离原点太远的缺口不列');
});

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
