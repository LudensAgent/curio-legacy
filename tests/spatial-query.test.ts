/**
 * spatial_query 的独立验收：使用安装的 curio-minecraft-3d-memory 0.7.6、真实
 * SharedSpatialSession 与独立 mkdtemp 数据库。所有 open 之后立即用 try/finally
 * 保护；只有确认真实 close 干净后才删除本测试自己的临时目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockToSection } from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult, SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { GameAdapter } from '../src/adapter/types.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';

const WORLD = 'world-spatial-query';
const DIM = 'overworld';
const S1 = 's1';

function block(
  pos: { x: number; y: number; z: number },
  name: string,
  observedAt: number,
  observationId: number,
  over: Partial<BlockObservation> = {},
): BlockObservation {
  return {
    name,
    properties: {},
    worldId: WORLD,
    sessionId: S1,
    dimension: DIM,
    source: 'vision',
    stateComplete: true,
    observedAt,
    observationId,
    pos,
    ...over,
  };
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

function dataOf(result: SkillResult): Record<string, unknown> {
  assert.ok(result.data !== undefined, 'result must carry structured data');
  return rec(result.data.spatialQuery);
}

function ctxFor(spatial: unknown, signal: AbortSignal = new AbortController().signal, deadline = Date.now() + 3000): SkillCtx {
  return {
    get adapter(): never {
      throw new Error('spatial_query must not touch ctx.adapter');
    },
    get senses(): never {
      throw new Error('spatial_query must not touch ctx.senses');
    },
    get memory(): never {
      throw new Error('spatial_query must not touch ctx.memory');
    },
    get bus(): never {
      throw new Error('spatial_query must not touch ctx.bus');
    },
    spatial: spatial as SharedSpatialSession,
    signal,
    deadline,
    taskId: 'spatial-query-test',
    progress(): never {
      throw new Error('spatial_query must not report progress');
    },
  } as unknown as SkillCtx;
}

function validate(raw: unknown) {
  return spatialQuery.validate(raw, {} as GameAdapter);
}

function cleanup(dir: string, result: ShutdownResult | null): void {
  if (result === null || result.close === null || result.close.completed === false || result.close.error !== null) return;
  rmSync(dir, { recursive: true, force: true });
}

function assertCleanClose(result: ShutdownResult): void {
  if (result.close === null) assert.fail('shutdown did not return a close result');
  assert.equal(result.close.completed, true);
  assert.equal(result.close.error, null);
  assert.equal(result.close.unconfirmedRequest, false);
  assert.equal(result.close.dirty, false);
}

function assertCleanManualClose(result: CloseResult): void {
  assert.equal(result.completed, true);
  assert.equal(result.error, null);
  assert.equal(result.unconfirmedRequest, false);
  assert.equal(result.dirty, false);
}

/** 40 点 polyline，用于 offset/limit 分页。 */
function polyline(n: number, offset = 0): { x: number; y: number; z: number }[] {
  return Array.from({ length: n }, (_, i) => ({ x: i + offset, y: 64, z: 0 }));
}

test('spatial_query：只读已记录事实、分页、路线证据与输出预算', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-'));
  const dbPath = join(dir, 'memory.db');
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
  let shutdown: ShutdownResult | null = null;
  try {
    const now = Date.now();
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    svc.observe([
      block({ x: 0, y: 0, z: 0 }, 'minecraft:air', now, 1),
      block({ x: 1, y: 0, z: 0 }, 'minecraft:stone', now, 2, { properties: { variant: 'stone' } }),
      block({ x: 5, y: 0, z: 0 }, 'minecraft:air', now - 120_000, 3),
    ]);

    const history = svc.session.history;
    const topology = svc.session.topology;

    history.saveFragment({
      id: 'f-main', worldId: WORLD, dim: DIM, kind: 'walked', geometrySource: 'traversal',
      polyline: polyline(40), entrances: [{ x: 0, y: 64, z: 0 }, { x: 39, y: 64, z: 0 }],
      links: [{ a: { x: 0, y: 64, z: 0 }, b: { x: 1, y: 64, z: 0 } }, { a: { x: 1, y: 64, z: 0 }, b: { x: 2, y: 64, z: 0 } }],
      deepestY: -12, createdAt: 1000, lastUsedAt: 2000, uses: 7,
    });
    history.saveFragment({
      id: 'f-legacy', worldId: WORLD, dim: DIM, kind: 'built', geometrySource: 'legacy',
      polyline: polyline(3), entrances: [], deepestY: 64, createdAt: 1100, lastUsedAt: 1200, uses: 0,
    });
    history.saveFragment({
      id: 'f-route-missing', worldId: WORLD, dim: DIM, kind: 'walked', geometrySource: 'traversal',
      polyline: polyline(2), entrances: [], deepestY: 64, createdAt: 1300, lastUsedAt: 1400, uses: 1,
    });
    for (const [i, title] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      history.saveFragment({
        id: `page-${title}`, worldId: WORLD, dim: 'page-dim', kind: 'walked', geometrySource: 'traversal',
        polyline: [{ x: i, y: 64, z: 0 }, { x: i + 1, y: 64, z: 0 }],
        entrances: [{ x: i, y: 64, z: 0 }],
        ...(i === 0 ? { links: [{ a: { x: 0, y: 64, z: 0 }, b: { x: 1, y: 64, z: 0 } }] } : {}),
        deepestY: 64, createdAt: 2000 + i, lastUsedAt: 3000 + i, uses: i,
      });
    }

    history.addTraversal({
      id: 't-real', fragmentId: 'f-main', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 },
      worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 12_345, source: 'confirmed_walk',
      executionId: 'exec-1', actionId: 'act-1', mode: 'walk',
    });
    history.addTraversal({
      id: 't-legacy', fragmentId: 'f-main', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 },
      worldId: WORLD, dim: DIM, sessionId: null, observedAt: null, source: 'legacy_import',
    });
    history.addTraversal({
      id: 't-ok', fragmentId: 'f-main', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 0, z: 0 },
      worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 22_222, source: 'confirmed_walk', mode: 'walk',
    });
    history.addTraversal({
      id: 't-missing', fragmentId: 'f-route-missing', from: { x: 10, y: 0, z: 0 }, to: { x: 15, y: 0, z: 0 },
      worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 33_333, source: 'confirmed_walk', mode: 'walk',
    });

    topology.saveNode({ id: 'n-a', kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } } });
    topology.saveNode({ id: 'n-b', kind: 'place', source: 'program', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 5, y: 0, z: 0 } } });
    topology.saveNode({ id: 'n-c', kind: 'entrance', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 10, y: 0, z: 0 } } });
    topology.saveNode({ id: 'n-d', kind: 'entrance', source: 'program', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 15, y: 0, z: 0 } } });
    topology.saveNode({ id: 'n-other', kind: 'place', source: 'agent', worldId: WORLD, dim: 'other-dim', location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } } });
    topology.saveEdge({ id: 'e-ok', from: 'n-a', to: 'n-b', type: 'HORIZONTAL', basis: 'traversed', fragmentId: 'f-main', evidenceIds: ['t-ok'] });
    topology.saveEdge({ id: 'e-missing', from: 'n-c', to: 'n-d', type: 'HORIZONTAL', basis: 'traversed', fragmentId: 'f-route-missing', evidenceIds: ['t-missing'] });
    // 移除片段会一并移除其 traversal；边缘保留为缺失证据的悬空绑定，用于 INSUFFICIENT_EVIDENCE。
    history.forgetFragment('f-route-missing');

    await t.test('输入边界：越界拒绝、零预算保留、ID/dim 上限', async () => {
      assert.equal(spatialQuery.name, 'spatial_query');
      assert.equal(spatialQuery.readOnly, true);
      assert.equal(spatialQuery.movement, false);
      assert.equal(spatialQuery.timeoutMs, 3000);

      const bad: unknown[] = [
        null,
        [],
        { kind: 'nope', dim: DIM },
        { kind: 'cells', dim: '', positions: [{ x: 0, y: 0, z: 0 }] },
        { kind: 'cells', dim: 'unknown', positions: [{ x: 0, y: 0, z: 0 }] },
        { kind: 'cells', dim: 'd'.repeat(129), positions: [{ x: 0, y: 0, z: 0 }] },
        { kind: 'cells', dim: DIM, positions: [] },
        { kind: 'cells', dim: DIM, positions: Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 })) },
        { kind: 'cells', dim: DIM, positions: [{ x: 1.5, y: 0, z: 0 }] },
        { kind: 'cells', dim: DIM, positions: [{ x: Number.MAX_SAFE_INTEGER + 1, y: 0, z: 0 }] },
        { kind: 'fragment', dim: DIM, fragmentId: '' },
        { kind: 'fragment', dim: DIM, fragmentId: 'x'.repeat(257) },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', field: 'bad' },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', field: null },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', offset: null },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', limit: null },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', offset: -1 },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', limit: 0 },
        { kind: 'fragment', dim: DIM, fragmentId: 'f', limit: 33 },
        { kind: 'traversals', dim: DIM, ids: [] },
        { kind: 'traversals', dim: DIM, ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
        { kind: 'traversals', dim: DIM, ids: [''] },
        { kind: 'nodes', dim: DIM, ids: ['x'.repeat(257)] },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', mode: 'fly' },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxNodes: -1 },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxNodes: 65 },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxEdges: 513 },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxHistoryReads: 257 },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxDiagnostics: 17 },
        { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxEdges: 1.5 },
        { kind: 'fragments', dim: DIM, limit: 0 },
        { kind: 'fragments', dim: DIM, limit: 9 },
        { kind: 'fragments', dim: DIM, limit: null },
        { kind: 'fragments', dim: DIM, after: '' },
        { kind: 'fragments', dim: DIM, after: 'x'.repeat(257) },
      ];
      for (const raw of bad) assert.equal(validate(raw).ok, false, `应拒绝：${JSON.stringify(raw)}`);

      const zero = validate({ kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b', maxNodes: 0, maxEdges: 0, maxHistoryReads: 0, maxDiagnostics: 0 });
      assert.equal(zero.ok, true);
      if (zero.ok && zero.args.kind === 'route') {
        assert.equal(zero.args.maxNodes, 0);
        assert.equal(zero.args.maxEdges, 0);
        assert.equal(zero.args.maxHistoryReads, 0);
        assert.equal(zero.args.maxDiagnostics, 0);
      }
      const negativeCoords = validate({ kind: 'cells', dim: DIM, positions: [{ x: -17, y: -64, z: -1 }] });
      assert.equal(negativeCoords.ok, true, '负坐标是合法安全整数');

      const untrimmed = validate({ kind: 'fragment', dim: DIM, fragmentId: ' spaced-id ' });
      assert.equal(untrimmed.ok, true);
      if (untrimmed.ok && untrimmed.args.kind === 'fragment') {
        assert.equal(untrimmed.args.fragmentId, ' spaced-id ', 'ID 身份保持原样，不 trim');
      }

      // 外层前提缺失时显式失败，且不触碰 adapter/senses。
      await Promise.all([
        spatialQuery.run(ctxFor(undefined), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] }).then((r) => {
          assert.equal(r.status, 'failed');
          assert.equal(rec(r.data).reason, 'spatial_session_unavailable');
        }),
        spatialQuery.run(ctxFor({ worldId: WORLD, closing: true, paused: false, observationAdmitted: false, session: svc.session }), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] }).then((r) => {
          assert.equal(r.status, 'failed');
          assert.equal(rec(r.data).reason, 'spatial_session_closing');
        }),
        spatialQuery.run(ctxFor(svc, AbortSignal.abort()), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] }).then((r) => {
          assert.equal(r.status, 'cancelled');
        }),
        spatialQuery.run(ctxFor(svc, new AbortController().signal, Date.now() - 1), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] }).then((r) => {
          assert.equal(r.status, 'failed');
          assert.equal(r.failureCode, 'TIMEOUT');
          assert.equal(rec(r.data).reason, 'deadline_exceeded');
        }),
      ]);
    });

    await t.test('cells：空气是真实观察，未观察不是从未观察；过期按 assessedAt 派生', async () => {
      const result = await spatialQuery.run(ctxFor(svc), {
        kind: 'cells', dim: DIM,
        positions: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 10_000, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
      });
      assert.equal(result.status, 'succeeded');
      const q = dataOf(result);
      assert.deepEqual(rec(q.scope), { worldId: WORLD, dim: DIM });
      assert.equal(q.requested, 4);
      assert.equal(q.returned, 4);
      assert.equal(typeof q.assessedAt, 'number');
      const results = list(q.results).map(rec);

      const air = results[0]!;
      assert.deepEqual(air.pos, { x: 0, y: 0, z: 0 });
      assert.equal(air.availability, 'observed');
      assert.equal(air.effectiveFreshness, 'FRESH');
      const airEvidence = rec(air.evidence);
      const airObservation = rec(airEvidence.observation);
      assert.equal(airObservation.state && rec(airObservation.state).name, 'minecraft:air');
      assert.equal(airObservation.stateComplete, true);
      assert.equal(airObservation.worldId, WORLD);
      assert.equal(airObservation.dim, DIM);
      assert.equal(airObservation.sessionId, S1);
      assert.equal(airObservation.source, 'vision');
      assert.equal(airObservation.observedAt, now);
      assert.deepEqual(rec(air.section), { cx: 0, cz: 0, sy: 0 });
      assert.equal(rec(air.residency).residency, 'resident');

      const stone = results[1]!;
      assert.equal(stone.availability, 'observed');
      const stoneState = rec(rec(rec(stone.evidence).observation).state);
      assert.equal(stoneState.name, 'minecraft:stone');
      assert.equal(rec(stoneState.properties).variant, 'stone');

      const unknown = results[2]!;
      assert.equal(unknown.availability, 'unknown');
      assert.equal(unknown.evidence, undefined);
      assert.equal(rec(unknown.residency).residency, 'no_record');

      const expired = results[3]!;
      assert.equal(expired.availability, 'observed');
      assert.equal(expired.effectiveFreshness, 'EXPIRED');
      const expiredEvidence = rec(expired.evidence);
      assert.equal(expiredEvidence.freshness, 'FRESH');
      assert.ok((expiredEvidence.validUntil as number) < (q.assessedAt as number));
      assert.equal(rec(expiredEvidence.observation).observedAt, now - 120_000);

      // 查询不刷新原证据：再次读取必须完全相同。
      const before = svc.session.voxel.cellAt(DIM, 5, 0, 0);
      await spatialQuery.run(ctxFor(svc), { kind: 'cells', dim: DIM, positions: [{ x: 5, y: 0, z: 0 }] });
      assert.deepEqual(svc.session.voxel.cellAt(DIM, 5, 0, 0), before);
    });

    await t.test('cells：validUntil 相等仍 FRESH，超过 1ms 才 EXPIRED', async () => {
      const cellBefore = svc.session.voxel.cellAt(DIM, 1, 0, 0);
      if (!cellBefore.observed) assert.fail('测试前提：x=1 应有已观察证据');
      const validUntil = cellBefore.evidence.validUntil;
      const revisionBefore = svc.session.voxel.saveRevision;
      const realNow = Date.now;
      try {
        Date.now = () => validUntil;
        const atBoundary = dataOf(await spatialQuery.run(
          ctxFor(svc, new AbortController().signal, validUntil + 3000),
          { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 0, z: 0 }] },
        ));
        assert.equal(rec(list(atBoundary.results)[0]).effectiveFreshness, 'FRESH');

        Date.now = () => validUntil + 1;
        const afterBoundary = dataOf(await spatialQuery.run(
          ctxFor(svc, new AbortController().signal, validUntil + 3001),
          { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 0, z: 0 }] },
        ));
        assert.equal(rec(list(afterBoundary.results)[0]).effectiveFreshness, 'EXPIRED');
      } finally {
        Date.now = realNow;
      }
      assert.deepEqual(svc.session.voxel.cellAt(DIM, 1, 0, 0), cellBefore);
      assert.equal(svc.session.voxel.saveRevision, revisionBefore);
    });

    await t.test('fragment：scope 先查、单记录分页、links 缺失如实标记', async () => {
      const first = await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'f-main', field: 'polyline', offset: 5, limit: 4,
      });
      assert.equal(first.status, 'succeeded');
      const fq = dataOf(first);
      assert.equal(fq.found, true);
      const fragment = rec(fq.fragment);
      assert.equal(fragment.id, 'f-main');
      assert.equal(fragment.createdAt, 1000);
      assert.equal(fragment.lastUsedAt, 2000);
      assert.equal(fragment.uses, 7);
      assert.equal(fragment.deepestY, -12);
      assert.equal(fragment.geometrySource, 'traversal');
      assert.equal(fragment.observedAt, undefined, '不得把 lastUsedAt 改名成 observedAt');
      assert.deepEqual(rec(fragment.observation), { known: false, sessionId: null, observedAt: null });
      assert.equal(fragment.currentPassability, 'unknown');
      const poly = rec(fragment.polyline);
      assert.equal(poly.recorded, true);
      assert.equal(poly.total, 40);
      assert.equal(poly.offset, 5);
      assert.equal(poly.returned, 4);
      assert.equal(poly.nextOffset, 9);
      assert.deepEqual(list(poly.items), polyline(40).slice(5, 9));

      const tail = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'f-main', field: 'polyline', offset: 38, limit: 16,
      }));
      const tailPoly = rec(rec(tail.fragment).polyline);
      assert.equal(tailPoly.returned, 2);
      assert.equal('nextOffset' in tailPoly, false, '末页无 nextOffset');

      const beyond = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'f-main', field: 'polyline', offset: 100, limit: 16,
      }));
      const beyondPoly = rec(rec(beyond.fragment).polyline);
      assert.deepEqual(list(beyondPoly.items), []);
      assert.equal(beyondPoly.returned, 0);
      assert.equal('nextOffset' in beyondPoly, false);

      const noLinks = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'f-legacy', field: 'links',
      }));
      const links = rec(rec(noLinks.fragment).links);
      assert.equal(links.recorded, false);
      assert.equal(links.total, 0);
      assert.deepEqual(list(links.items), []);
      assert.match(String(links.note), /不证明没有连接/);

      const withLinks = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'f-main', field: 'links', offset: 0, limit: 1,
      }));
      const linkPage = rec(rec(withLinks.fragment).links);
      assert.equal(linkPage.recorded, true);
      assert.equal(linkPage.total, 2);
      assert.equal(linkPage.nextOffset, 1);

      const missing = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: DIM, fragmentId: 'absent-id',
      }));
      assert.equal(missing.found, false);
      assert.equal(missing.reason, 'not_found');

      const wrongDim = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'fragment', dim: 'nether', fragmentId: 'f-main',
      }));
      assert.equal(wrongDim.found, false);
      assert.equal(wrongDim.reason, 'scope_mismatch');
      assert.deepEqual(rec(wrongDim.actualScope), { worldId: WORLD, dim: DIM });
    });

    await t.test('fragments：首/中/末页、after 游标、错 dim 过滤、仅元数据与点数', async () => {
      const historyBefore = history.checkpointSnapshot();

      const first = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'page-dim', limit: 2 }));
      const firstPage = rec(first.page);
      assert.equal(firstPage.total, 5);
      assert.equal(firstPage.returned, 2);
      assert.equal(firstPage.after, null);
      assert.equal(firstPage.nextAfter, 'page-b');
      assert.equal(firstPage.scan, 'full_index_filter_sort');
      assert.match(String(firstPage.scanNote), /不是每页扫描量或 O\(page\)/);
      const firstItems = list(first.fragments).map(rec);
      assert.deepEqual(firstItems.map((f) => f.id), ['page-a', 'page-b']);
      assert.equal(firstItems[0]!.createdAt, 2000);
      assert.equal(firstItems[0]!.lastUsedAt, 3000);
      assert.equal(firstItems[0]!.observedAt, undefined);
      assert.equal(Array.isArray(firstItems[0]!.polyline), false, '不得返回完整几何数组');
      assert.deepEqual(rec(firstItems[0]!.polyline), { points: 2, first: { x: 0, y: 64, z: 0 }, last: { x: 1, y: 64, z: 0 } });
      assert.deepEqual(rec(rec(firstItems[0]!.entrances)), { points: 1, first: { x: 0, y: 64, z: 0 }, last: { x: 0, y: 64, z: 0 } });
      assert.equal(rec(firstItems[0]!.links).recorded, true);
      assert.equal(rec(firstItems[1]!.links).recorded, false);
      assert.deepEqual(rec(firstItems[0]!.observation), { known: false, sessionId: null, observedAt: null });

      const middle = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'page-dim', after: 'page-b', limit: 2 }));
      const middlePage = rec(middle.page);
      assert.deepEqual(list(middle.fragments).map((f) => rec(f).id), ['page-c', 'page-d']);
      assert.equal(middlePage.nextAfter, 'page-d');

      const last = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'page-dim', after: 'page-d', limit: 2 }));
      const lastPage = rec(last.page);
      assert.deepEqual(list(last.fragments).map((f) => rec(f).id), ['page-e']);
      assert.equal('nextAfter' in lastPage, false);

      const exhausted = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'page-dim', after: 'page-e', limit: 2 }));
      assert.deepEqual(list(exhausted.fragments), []);
      assert.equal(rec(exhausted.page).total, 5);
      assert.equal('nextAfter' in rec(exhausted.page), false);

      const wrongDim = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'not-a-dim', limit: 4 }));
      assert.equal(rec(wrongDim.page).total, 0);
      assert.deepEqual(list(wrongDim.fragments), []);

      assert.deepEqual(history.checkpointSnapshot(), historyBefore, '片段分页查询不得改写历史或时间');
    });

    await t.test('traversals/nodes：逐个 ID、原顺序、缺失与作用域不符、来源不混同', async () => {
      const trav = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'traversals', dim: DIM, ids: ['t-real', 't-absent', 't-legacy'],
      }));
      assert.equal(trav.requested, 3);
      assert.equal(trav.returned, 3);
      const ts = list(trav.items).map(rec);
      assert.deepEqual(ts.map((x) => [x.id, x.status]), [['t-real', 'found'], ['t-absent', 'not_found'], ['t-legacy', 'found']]);
      const real = rec(ts[0]!.record);
      assert.deepEqual(real.from, { x: 0, y: 0, z: 0 });
      assert.deepEqual(real.to, { x: 1, y: 0, z: 0 });
      assert.equal(real.sessionId, S1);
      assert.equal(real.observedAt, 12_345);
      assert.equal(real.source, 'confirmed_walk');
      assert.equal(real.executionId, 'exec-1');
      assert.equal(real.actionId, 'act-1');
      assert.equal(real.mode, 'walk');
      const legacy = rec(ts[2]!.record);
      assert.equal(legacy.sessionId, null, '未知 session 不得补造');
      assert.equal(legacy.observedAt, null, '未知时间不得补造');
      assert.equal(legacy.source, 'legacy_import');
      assert.equal(history.traversals({ fragmentId: 'f-legacy' }).total, 0, 'legacy 几何不得自动生成 traversal');

      const travWrongDim = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'traversals', dim: 'nether', ids: ['t-real'],
      }));
      const mismatch = rec(list(travWrongDim.items)[0]);
      assert.equal(mismatch.status, 'scope_mismatch');
      assert.deepEqual(rec(mismatch.actualScope), { worldId: WORLD, dim: DIM });

      const nodes = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'nodes', dim: DIM, ids: ['n-a', 'n-b', 'n-absent', 'n-other'],
      }));
      assert.equal(nodes.requested, 4);
      assert.equal(nodes.returned, 4);
      const ns = list(nodes.items).map(rec);
      assert.deepEqual(ns.map((x) => [x.id, x.status]), [['n-a', 'found'], ['n-b', 'found'], ['n-absent', 'not_found'], ['n-other', 'scope_mismatch']]);
      assert.equal(rec(ns[0]!.node).source, 'agent');
      assert.equal(rec(ns[1]!.node).source, 'program');
      assert.deepEqual(rec(ns[0]!.observation), { known: false, sessionId: null, observedAt: null });
      assert.deepEqual(rec(ns[3]!.actualScope), { worldId: WORLD, dim: 'other-dim' });
    });

    await t.test('route：真实历史 FOUND、证据缺失、零预算耗尽与作用域检查', async () => {
      const foundResult = await spatialQuery.run(ctxFor(svc), { kind: 'route', dim: DIM, fromNodeId: 'n-a', toNodeId: 'n-b' });
      const found = dataOf(foundResult);
      assert.equal(found.metadataReads, 2);
      assert.deepEqual(rec(found.requested).budgets, {
        maxNodes: 32, maxEdges: 128, maxHistoryReads: 64, maxDiagnostics: 8,
      });
      const route = rec(found.route);
      assert.equal(route.status, 'FOUND');
      assert.deepEqual(list(route.nodeIds), ['n-a', 'n-b']);
      assert.deepEqual(list(route.edgeIds), ['e-ok']);
      const segment = rec(list(route.segments)[0]);
      assert.equal(segment.evidenceId, 't-ok');
      const evidence = rec(segment.evidence);
      assert.equal(evidence.worldId, WORLD);
      assert.equal(evidence.dim, DIM);
      assert.equal(evidence.sessionId, S1);
      assert.equal(evidence.observedAt, 22_222);
      assert.equal(evidence.source, 'confirmed_walk');
      const interpretation = rec(found.interpretation);
      assert.equal(interpretation.currentPassability, 'not_assessed');
      assert.equal(interpretation.executablePointList, false);
      assert.match(foundResult.summary, /不代表当前通行/);

      const missing = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'route', dim: DIM, fromNodeId: 'n-c', toNodeId: 'n-d' }));
      const missingRoute = rec(missing.route);
      assert.equal(missingRoute.status, 'INSUFFICIENT_EVIDENCE');
      assert.ok(list(missingRoute.gaps).includes('missing'));
      assert.equal(rec(missing.interpretation).currentPassability, 'not_assessed');

      const zero = dataOf(await spatialQuery.run(ctxFor(svc), {
        kind: 'route', dim: DIM, fromNodeId: 'n-a', toNodeId: 'n-b', maxEdges: 0,
      }));
      assert.deepEqual(rec(zero.requested).budgets, {
        maxNodes: 32, maxEdges: 0, maxHistoryReads: 64, maxDiagnostics: 8,
      });
      const zeroRoute = rec(zero.route);
      assert.equal(zeroRoute.status, 'BUDGET_EXHAUSTED');
      assert.equal(zeroRoute.exhausted, 'maxEdges');
      assert.equal(rec(zeroRoute.stats).edgesChecked, 0, '零预算必须按原值传递，不能回退默认');

      const wrongScope = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'route', dim: DIM, fromNodeId: 'n-other', toNodeId: 'n-b' }));
      assert.equal(wrongScope.result, 'scope_mismatch');
      assert.equal(wrongScope.metadataReads, 1, '起点作用域不符时不再读终点');
      assert.deepEqual(rec(rec(wrongScope.start).actualScope), { worldId: WORLD, dim: 'other-dim' });

      const absent = dataOf(await spatialQuery.run(ctxFor(svc), { kind: 'route', dim: DIM, fromNodeId: 'n-absent', toNodeId: 'n-b' }));
      assert.equal(absent.result, 'not_found');
      assert.equal(absent.metadataReads, 1);

      // 真实 validate→run 默认预算回归：33 个节点的有证据链默认耗尽，显式较高预算可找到。
      const chainLen = 33;
      const chainPos = (i: number) => ({ x: 100 + i * 2, y: 0, z: 0 });
      history.saveFragment({
        id: 'f-chain', worldId: WORLD, dim: DIM, kind: 'walked', geometrySource: 'traversal',
        polyline: Array.from({ length: chainLen }, (_, i) => chainPos(i)), entrances: [],
        deepestY: 0, createdAt: 5000, lastUsedAt: 6000, uses: chainLen,
      });
      for (let i = 0; i < chainLen; i += 1) {
        topology.saveNode({ id: `nc-${i}`, kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: chainPos(i) } });
      }
      for (let i = 0; i < chainLen - 1; i += 1) {
        history.addTraversal({
          id: `tc-${i}`, fragmentId: 'f-chain', from: chainPos(i), to: chainPos(i + 1),
          worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 50_000 + i,
          source: 'confirmed_walk_corridor', executionId: 'exec-chain', actionId: 'act-chain', mode: 'walk',
        });
        topology.saveEdge({
          id: `ec-${i}`, from: `nc-${i}`, to: `nc-${i + 1}`, type: 'HORIZONTAL', basis: 'traversed',
          fragmentId: 'f-chain', evidenceIds: [`tc-${i}`],
        });
      }

      const defaultValidated = validate({ kind: 'route', dim: DIM, fromNodeId: 'nc-0', toNodeId: `nc-${chainLen - 1}` });
      assert.equal(defaultValidated.ok, true);
      if (!defaultValidated.ok) return;
      const chainExhausted = dataOf(await spatialQuery.run(ctxFor(svc), defaultValidated.args));
      assert.deepEqual(rec(chainExhausted.requested).budgets, {
        maxNodes: 32, maxEdges: 128, maxHistoryReads: 64, maxDiagnostics: 8,
      });
      const exhaustedRoute = rec(chainExhausted.route);
      assert.equal(exhaustedRoute.status, 'BUDGET_EXHAUSTED');
      assert.equal(exhaustedRoute.exhausted, 'maxNodes');
      assert.ok((rec(exhaustedRoute.stats).nodesRead as number) <= 32, '默认节点预算必须是 32');

      const authorizedValidated = validate({
        kind: 'route', dim: DIM, fromNodeId: 'nc-0', toNodeId: `nc-${chainLen - 1}`, maxNodes: 64,
      });
      assert.equal(authorizedValidated.ok, true);
      if (!authorizedValidated.ok) return;
      const chainFound = dataOf(await spatialQuery.run(ctxFor(svc), authorizedValidated.args));
      assert.deepEqual(rec(chainFound.requested).budgets, {
        maxNodes: 64, maxEdges: 128, maxHistoryReads: 64, maxDiagnostics: 8,
      });
      const foundChainRoute = rec(chainFound.route);
      assert.equal(foundChainRoute.status, 'FOUND');
      assert.equal(list(foundChainRoute.nodeIds).length, chainLen);
      assert.equal(list(foundChainRoute.segments).length, chainLen - 1);
      const chainEvidence = rec(rec(list(foundChainRoute.segments)[0]).evidence);
      assert.equal(chainEvidence.source, 'confirmed_walk_corridor', '原 source 原样输出');
      assert.deepEqual(chainEvidence.from, chainPos(0));
      assert.deepEqual(chainEvidence.to, chainPos(1));
      assert.equal(chainEvidence.sessionId, S1);
      assert.equal(chainEvidence.observedAt, 50_000);
      assert.equal(chainEvidence.executionId, 'exec-chain');
      assert.equal(chainEvidence.actionId, 'act-chain');
    });

    await t.test('输出预算：超过 64 KiB 时返回结构化 result_too_large，不截断证据', async () => {
      svc.observe([block({ x: 6, y: 0, z: 0 }, 'minecraft:stone', now, 99, { properties: { blob: 'x'.repeat(70_000) } })]);
      const result = await spatialQuery.run(ctxFor(svc), { kind: 'cells', dim: DIM, positions: [{ x: 6, y: 0, z: 0 }] });
      assert.equal(result.status, 'failed');
      assert.equal(result.failureCode, 'ERROR');
      const q = dataOf(result);
      assert.equal(q.result, 'result_too_large');
      assert.ok((q.serializedBytes as number) > (q.limitBytes as number));
      assert.equal(q.truncated, false);
      assert.equal(q.results, undefined);
      assert.match(result.summary, /未返回任何截断证据/);
    });

    await t.test('只读：查询前后 saveRevision/history/topology 与事实完全一致', async () => {
      const voxel = svc.session.voxel;
      const voxelRevision = voxel.saveRevision;
      const historyRevision = history.revision;
      const topologyRevision = topology.revision;
      const cellBefore = voxel.cellAt(DIM, 0, 0, 0);
      const historyBefore = history.checkpointSnapshot();
      const topologyBefore = topology.checkpointSnapshot();

      await spatialQuery.run(ctxFor(svc), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] });
      await spatialQuery.run(ctxFor(svc), { kind: 'fragment', dim: DIM, fragmentId: 'f-main', field: 'entrances' });
      await spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: 'page-dim', limit: 2 });
      await spatialQuery.run(ctxFor(svc), { kind: 'traversals', dim: DIM, ids: ['t-real'] });
      await spatialQuery.run(ctxFor(svc), { kind: 'nodes', dim: DIM, ids: ['n-a', 'n-b'] });
      await spatialQuery.run(ctxFor(svc), { kind: 'route', dim: DIM, fromNodeId: 'n-a', toNodeId: 'n-b' });

      assert.equal(voxel.saveRevision, voxelRevision);
      assert.equal(history.revision, historyRevision);
      assert.equal(topology.revision, topologyRevision);
      assert.deepEqual(voxel.cellAt(DIM, 0, 0, 0), cellBefore);
      assert.deepEqual(history.checkpointSnapshot(), historyBefore);
      assert.deepEqual(topology.checkpointSnapshot(), topologyBefore);
    });

    await t.test('中断后仍可查询：有效 STALE 派生，原观测数据不变', async () => {
      svc.interrupt();
      assert.equal(svc.observationAdmitted, false);
      const beforeInterrupt = svc.session.voxel.cellAt(DIM, 0, 0, 0);
      const result = await spatialQuery.run(ctxFor(svc), { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] });
      assert.equal(result.status, 'succeeded');
      const cell = rec(list(dataOf(result).results)[0]);
      assert.equal(cell.availability, 'observed');
      assert.equal(cell.effectiveFreshness, 'STALE');
      assert.equal(cell.staleReason, 'observation_gap');
      const evidence = rec(cell.evidence);
      assert.equal(evidence.freshness, 'STALE');
      const observation = rec(evidence.observation);
      assert.equal(observation.observedAt, now);
      assert.equal(observation.sessionId, S1);
      assert.equal(observation.source, 'vision');
      assert.equal(observation.state && rec(observation.state).name, 'minecraft:air');
      // 查询本身没有再次改写证据：查询前后的同一快照一致。
      assert.deepEqual(svc.session.voxel.cellAt(DIM, 0, 0, 0), beforeInterrupt);
    });
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    assert.equal(shutdown.error, null);
    assert.equal(shutdown.cancelError, null);
    cleanup(dir, shutdown);
  }
});

test('spatial_query：重启后按 fragmentId 分页读取真实 traversal 证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-reopen-'));
  const dbPath = join(dir, 'memory.db');
  let writer: SharedSpatialSession | null = null;
  let reader: SharedSpatialSession | null = null;
  let writerShutdown: ShutdownResult | null = null;
  let readerShutdown: ShutdownResult | null = null;
  try {
    writer = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
    try {
      const history = writer.session.history;
      history.saveFragment({
        id: 'f-target', worldId: WORLD, dim: DIM, kind: 'walked', geometrySource: 'traversal',
        polyline: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }],
        entrances: [], deepestY: 0, createdAt: 7000, lastUsedAt: 8000, uses: 3,
      });
      history.saveFragment({
        id: 'f-other', worldId: WORLD, dim: DIM, kind: 'walked', geometrySource: 'legacy',
        polyline: [{ x: 20, y: 0, z: 0 }, { x: 21, y: 0, z: 0 }],
        entrances: [], deepestY: 0, createdAt: 7100, lastUsedAt: 8100, uses: 1,
      });
      // 同片段 3 条：确认走廊、未知来源/会话/时间、另一条有执行归属的实测。
      history.addTraversal({
        id: 't-1', fragmentId: 'f-target', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 },
        worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 1_111_111,
        source: 'confirmed_walk_corridor', executionId: 'exec-old', actionId: 'act-old', mode: 'walk',
      });
      history.addTraversal({
        id: 't-2', fragmentId: 'f-target', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 },
        worldId: WORLD, dim: DIM, sessionId: null, observedAt: null, source: 'legacy_import',
      });
      history.addTraversal({
        id: 't-3', fragmentId: 'f-target', from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 },
        worldId: WORLD, dim: DIM, sessionId: 'session-old', observedAt: 2_222_222,
        source: 'confirmed_walk', executionId: 'exec-2', actionId: 'act-2', mode: 'jump',
      });
      // 另一片段的证据必须隔离。
      history.addTraversal({
        id: 't-other', fragmentId: 'f-other', from: { x: 20, y: 0, z: 0 }, to: { x: 21, y: 0, z: 0 },
        worldId: WORLD, dim: DIM, sessionId: S1, observedAt: 3_333_333,
        source: 'confirmed_walk', executionId: 'exec-other', actionId: 'act-other', mode: 'walk',
      });

      const checkpoint = await writer.checkpoint();
      assert.equal(checkpoint.worldId, WORLD);
    } finally {
      writerShutdown = await writer.shutdown();
      assertCleanClose(writerShutdown);
      writer = null;
    }

    reader = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
    try {
      const history = reader.session.history;
      assert.equal(history.traversals({ fragmentId: 'f-target' }).total, 3, '重启后真实保存的 3 条证据应恢复');
      assert.equal(history.traversals({ fragmentId: 'f-other' }).total, 1, '另一片段证据应独立恢复');

      const revisionBefore = history.revision;
      const t1Before = history.getTraversal('t-1');
      const snapshotBefore = history.checkpointSnapshot();

      // 不依赖旧 action/traversalIds：用真实 fragments 查询发现目标片段 ID。
      const fragmentsValidated = validate({ kind: 'fragments', dim: DIM, limit: 8 });
      assert.equal(fragmentsValidated.ok, true);
      if (!fragmentsValidated.ok) return;
      const fragmentsQuery = dataOf(await spatialQuery.run(ctxFor(reader), fragmentsValidated.args));
      const discovered = list(fragmentsQuery.fragments).map(rec).find((fragment) => fragment.id === 'f-target');
      assert.ok(discovered !== undefined, 'fragments 查询应能发现目标片段');
      const targetId = String(discovered.id);

      const defaultValidated = validate({ kind: 'traversals', dim: DIM, fragmentId: targetId });
      assert.equal(defaultValidated.ok, true);
      if (!defaultValidated.ok) return;
      const defaultResult = await spatialQuery.run(ctxFor(reader), defaultValidated.args);
      assert.equal(defaultResult.status, 'succeeded');
      const defaultQuery = dataOf(defaultResult);
      assert.equal(defaultQuery.found, true);
      assert.equal(defaultQuery.mode, 'fragment');
      assert.equal(defaultQuery.fragmentId, targetId);
      assert.deepEqual(rec(defaultQuery.requested), { selector: 'fragmentId', fragmentId: targetId, after: null, limit: 4 });
      const defaultPage = rec(defaultQuery.page);
      assert.equal(defaultPage.total, 3);
      assert.equal(defaultPage.returned, 3);
      assert.equal(defaultPage.after, null);
      assert.equal(defaultPage.limit, 4);
      assert.equal('nextAfter' in defaultPage, false);
      assert.equal(defaultPage.scan, 'full_traversal_index_filter_sort');
      assert.match(String(defaultPage.scanNote), /maxTraversals=10000/);
      assert.match(String(defaultPage.scanNote), /limit 只限制返回条数/);

      const defaultItems = list(defaultQuery.items).map(rec);
      assert.deepEqual(defaultItems.map((item) => item.id), ['t-1', 't-2', 't-3']);
      assert.deepEqual(defaultItems.map((item) => item.status), ['found', 'found', 'found']);
      assert.deepEqual(rec(defaultItems[0]!.record), {
        id: 't-1', fragmentId: targetId,
        from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 },
        worldId: WORLD, dim: DIM,
        sessionId: S1, observedAt: 1_111_111, source: 'confirmed_walk_corridor',
        executionId: 'exec-old', actionId: 'act-old', mode: 'walk',
      });
      assert.deepEqual(rec(defaultItems[1]!.record), {
        id: 't-2', fragmentId: targetId,
        from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 },
        worldId: WORLD, dim: DIM,
        sessionId: null, observedAt: null, source: 'legacy_import',
        executionId: undefined, actionId: undefined, mode: undefined,
      }, '未知 session/时间不得补造，可选归属字段保持未知（不赋值）');
      assert.deepEqual(rec(defaultItems[2]!.record), {
        id: 't-3', fragmentId: targetId,
        from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 },
        worldId: WORLD, dim: DIM,
        sessionId: 'session-old', observedAt: 2_222_222, source: 'confirmed_walk',
        executionId: 'exec-2', actionId: 'act-2', mode: 'jump',
      });
      assert.equal(defaultItems.some((item) => item.id === 't-other'), false, '另一片段不得混入');

      const pageOneValidated = validate({ kind: 'traversals', dim: DIM, fragmentId: targetId, limit: 2 });
      assert.equal(pageOneValidated.ok, true);
      if (!pageOneValidated.ok) return;
      const pageOne = dataOf(await spatialQuery.run(ctxFor(reader), pageOneValidated.args));
      assert.deepEqual(list(pageOne.items).map((item) => rec(item).id), ['t-1', 't-2']);
      assert.equal(rec(pageOne.page).total, 3);
      assert.equal(rec(pageOne.page).returned, 2);
      assert.equal(rec(pageOne.page).nextAfter, 't-2');

      const pageTwoValidated = validate({ kind: 'traversals', dim: DIM, fragmentId: targetId, after: 't-2', limit: 2 });
      assert.equal(pageTwoValidated.ok, true);
      if (!pageTwoValidated.ok) return;
      const pageTwo = dataOf(await spatialQuery.run(ctxFor(reader), pageTwoValidated.args));
      assert.deepEqual(list(pageTwo.items).map((item) => rec(item).id), ['t-3']);
      assert.equal(rec(pageTwo.page).total, 3);
      assert.equal(rec(pageTwo.page).returned, 1);
      assert.equal('nextAfter' in rec(pageTwo.page), false, '末页无 nextAfter');
      assert.deepEqual(rec(pageTwo.requested), { selector: 'fragmentId', fragmentId: targetId, after: 't-2', limit: 2 });

      const exhaustedValidated = validate({ kind: 'traversals', dim: DIM, fragmentId: targetId, after: 't-3', limit: 2 });
      assert.equal(exhaustedValidated.ok, true);
      if (!exhaustedValidated.ok) return;
      const exhausted = dataOf(await spatialQuery.run(ctxFor(reader), exhaustedValidated.args));
      assert.deepEqual(list(exhausted.items), []);
      assert.equal(rec(exhausted.page).total, 3);
      assert.equal(rec(exhausted.page).returned, 0);
      assert.equal('nextAfter' in rec(exhausted.page), false);

      // 缺片段 / 错维度返回结构化事实，不枚举其它维度。
      const missingValidated = validate({ kind: 'traversals', dim: DIM, fragmentId: 'f-absent' });
      assert.equal(missingValidated.ok, true);
      if (!missingValidated.ok) return;
      const missing = dataOf(await spatialQuery.run(ctxFor(reader), missingValidated.args));
      assert.equal(missing.found, false);
      assert.equal(missing.reason, 'not_found');
      assert.equal(missing.items, undefined);
      assert.equal(missing.page, undefined);

      const wrongDimValidated = validate({ kind: 'traversals', dim: 'nether', fragmentId: targetId });
      assert.equal(wrongDimValidated.ok, true);
      if (!wrongDimValidated.ok) return;
      const wrongDim = dataOf(await spatialQuery.run(ctxFor(reader), wrongDimValidated.args));
      assert.equal(wrongDim.found, false);
      assert.equal(wrongDim.reason, 'scope_mismatch');
      assert.deepEqual(rec(wrongDim.actualScope), { worldId: WORLD, dim: DIM });
      assert.equal(wrongDim.items, undefined);
      assert.equal(wrongDim.page, undefined);

      const bad: unknown[] = [
        { kind: 'traversals', dim: DIM },
        { kind: 'traversals', dim: DIM, ids: ['t-1'], fragmentId: targetId },
        { kind: 'traversals', dim: DIM, fragmentId: null },
        { kind: 'traversals', dim: DIM, fragmentId: '' },
        { kind: 'traversals', dim: DIM, fragmentId: 'x'.repeat(257) },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, after: null },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, after: '' },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, limit: null },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, limit: 0 },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, limit: 9 },
        { kind: 'traversals', dim: DIM, fragmentId: targetId, limit: 1.5 },
        { kind: 'traversals', dim: DIM, ids: ['t-1'], after: 't-0' },
        { kind: 'traversals', dim: DIM, ids: ['t-1'], limit: 2 },
      ];
      for (const raw of bad) assert.equal(validate(raw).ok, false, `应拒绝：${JSON.stringify(raw)}`);

      // 只读：revision、原记录与完整快照在查询前后一致。
      assert.equal(history.revision, revisionBefore);
      assert.deepEqual(history.getTraversal('t-1'), t1Before);
      assert.deepEqual(history.checkpointSnapshot(), snapshotBefore);
    } finally {
      readerShutdown = await reader.shutdown();
      assertCleanClose(readerShutdown);
      reader = null;
    }
  } finally {
    if (writer !== null) {
      writerShutdown = await writer.shutdown();
      assertCleanClose(writerShutdown);
      writer = null;
    }
    if (reader !== null) {
      readerShutdown = await reader.shutdown();
      assertCleanClose(readerShutdown);
      reader = null;
    }
    const lastClose = readerShutdown ?? writerShutdown;
    if (lastClose !== null) cleanup(dir, lastClose);
  }
});

test('spatial_query：manual SpatialSession 的未驻留投影只报历史不可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-manual-'));
  const dbPath = join(dir, 'memory.db');
  let writer: SpatialSession | null = null;
  let reader: SpatialSession | null = null;
  let writerClose: CloseResult | null = null;
  let readerClose: CloseResult | null = null;
  try {
    writer = await openSpatialSession({ worldId: WORLD, databasePath: dbPath, voxelLoading: 'manual', timeoutMs: 5000 });
    try {
      writer.voxel.beginSession('manual-session');
      writer.voxel.observeBatch({
        observations: [{
          worldId: WORLD, dim: DIM, sessionId: 'manual-session', sequence: 1, observedAt: Date.now(),
          source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: 'minecraft:stone', properties: {} }, pos: { x: 40, y: 0, z: 0 },
        }],
        unobserved: [],
      });
      await writer.checkpoint();
    } finally {
      writerClose = await writer.close();
      assertCleanManualClose(writerClose);
      writer = null;
    }

    reader = await openSpatialSession({ worldId: WORLD, databasePath: dbPath, voxelLoading: 'manual', timeoutMs: 5000 });
    try {
      const section = blockToSection(40, 0, 0);
      const residency = reader.sectionResidency({ worldId: WORLD, dim: DIM, cx: section.cx, cz: section.cz, sy: section.sy });
      assert.equal(residency.residency, 'not_resident');
      assert.ok(residency.committed !== undefined, 'manual 目录应保留已提交记录');

      // 仅作 boundary fixture 的投影包装：真实 session 仍是公开 manual SpatialSession。
      const wrapper = {
        worldId: WORLD,
        closing: false,
        paused: false,
        observationAdmitted: false,
        session: reader,
      } as unknown as SharedSpatialSession;
      const result = await spatialQuery.run(ctxFor(wrapper), { kind: 'cells', dim: DIM, positions: [{ x: 40, y: 0, z: 0 }] });
      assert.equal(result.status, 'succeeded');
      const cell = rec(list(dataOf(result).results)[0]);
      assert.equal(cell.availability, 'unavailable_history');
      assert.equal(cell.evidence, undefined);
      assert.equal(rec(cell.residency).residency, 'not_resident');
      assert.deepEqual(rec(cell.residency).committed, residency.committed);
    } finally {
      readerClose = await reader.close();
      assertCleanManualClose(readerClose);
      reader = null;
    }
  } finally {
    if (writer !== null) {
      writerClose = await writer.close();
      assertCleanManualClose(writerClose);
    }
    if (reader !== null) {
      readerClose = await reader.close();
      assertCleanManualClose(readerClose);
    }
    const clean = (writerClose?.completed === true && writerClose.error === null)
      && (readerClose?.completed === true && readerClose.error === null);
    if (clean) rmSync(dir, { recursive: true, force: true });
  }
});
