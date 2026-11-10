/**
 * spatial_query 契约验收：真实 SharedSpatialSession + 临时 SQLite，薄适配
 * SpatialQueryPort（15 kind、只读、host_ledger、分页与驻留语义）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockToSection } from 'curio-minecraft-3d-memory';
import type { SpatialQueryRequest } from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';

const WORLD = 'world-spatial-query';
const DIM = 'overworld';
const S1 = 's1';
/** 固定信封时钟，使连续两次查询可深相等；观测时间更早。 */
const CLOCK = 1_000_000;
const OBSERVED_AT = 900_000;

function block(
  pos: { x: number; y: number; z: number },
  name: string,
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
    observedAt: OBSERVED_AT,
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
  return value as unknown[];
}

/** SkillResult.data 就是契约 SpatialQueryResult；库分页/投影在其 data 下。 */
function envelopeOf(result: SkillResult): Record<string, unknown> {
  assert.ok(result.data !== undefined, 'result must carry the contract envelope');
  return result.data;
}

function innerOf(result: SkillResult): Record<string, unknown> {
  return rec(envelopeOf(result).data);
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

async function openSession(dir: string): Promise<SharedSpatialSession> {
  return SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    timeoutMs: 5000,
    now: () => CLOCK,
  });
}

function assertCleanClose(result: ShutdownResult): void {
  assert.ok(result.close !== null, 'shutdown must return a real close result');
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

const point = (x: number, y = 0, z = 0) => ({ x, y, z });

test('spatial_query：validate 只做对象边界，支持的 kind 由库校验；退役 kind 结构化 unsupported', async () => {
  assert.equal(spatialQuery.name, 'spatial_query');
  assert.equal(spatialQuery.readOnly, true);
  assert.equal(spatialQuery.movement, false);
  assert.equal(spatialQuery.timeoutMs, 3000);

  // skill 边界只拒绝非对象；kind/字段/上限由库 validator 拥有。
  for (const raw of [null, [], 1, 'x', true]) assert.equal(validate(raw).ok, false);
  for (const raw of [{}, { kind: 'nope' }, { kind: 'fragment' }, { kind: 'fragments', extra: 1 }]) {
    assert.equal(validate(raw).ok, true, `schema 归库 validator：${JSON.stringify(raw)}`);
  }

  // 外层前提缺失时显式失败，且不触碰 adapter/senses。
  const cells = { kind: 'cells', dim: DIM, positions: [point(0)] };
  const unavailable = await spatialQuery.run(ctxFor(undefined), cells);
  assert.equal(unavailable.status, 'failed');
  assert.equal(rec(unavailable.data).reason, 'spatial_session_unavailable');

  const closing = await spatialQuery.run(
    ctxFor({ worldId: WORLD, closing: true, paused: false, observationAdmitted: false, session: { lifecycle: 'open' } }),
    cells,
  );
  assert.equal(closing.status, 'failed');
  assert.equal(rec(closing.data).reason, 'spatial_session_closing');

  const notOpen = await spatialQuery.run(
    ctxFor({ worldId: WORLD, closing: false, paused: false, observationAdmitted: false, session: { lifecycle: 'closed' } }),
    cells,
  );
  assert.equal(notOpen.status, 'failed');
  assert.equal(rec(notOpen.data).reason, 'spatial_session_not_open');

  const aborted = await spatialQuery.run(ctxFor({}, AbortSignal.abort()), cells);
  assert.equal(aborted.status, 'cancelled');

  const expired = await spatialQuery.run(ctxFor({}, new AbortController().signal, Date.now() - 1), cells);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.failureCode, 'TIMEOUT');
  assert.equal(rec(expired.data).reason, 'deadline_exceeded');

  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-kinds-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    const requests: Record<string, unknown>[] = [
      { kind: 'cells', dim: DIM, positions: [point(0)] },
      { kind: 'nodes', dim: DIM, tag: 'base', label: 'home', source: 'agent', after: 'n1', limit: 2 },
      { kind: 'nodes', dim: DIM, tag: 'portal', after: 'p1', limit: 2 },
      { kind: 'resourceAnchors', dim: DIM, tag: 'resource', label: 'iron', after: 'n1', limit: 2 },
      { kind: 'containerAnchors', dim: DIM, after: 'n1', limit: 2 },
      { kind: 'containerContents', dim: DIM },
      { kind: 'snapshot' },
      { kind: 'capabilities' },
    ];
    for (const request of requests) {
      const result = await spatialQuery.run(ctxFor(svc), request);
      assert.equal(result.status, 'succeeded', `${String(request.kind)}：${result.summary}`);
      assert.notEqual(envelopeOf(result).status, 'invalid_request', `${String(request.kind)} 不应被库拒绝`);
    }

    // 路线/片段/拓扑 kind 在宿主入口直接返回结构化 unsupported，不调用库、不返回空列表。
    const retired: Record<string, unknown>[] = [
      { kind: 'fragments', dim: DIM, fragmentKind: 'walked', limit: 1000 },
      { kind: 'traversals', dim: DIM, fragmentId: 'f1', limit: 2 },
      { kind: 'edges', dim: DIM, from: 'a', to: 'b', limit: 2 },
      { kind: 'historyRoute', dim: DIM, from: point(0), to: point(5), near: 5 },
      { kind: 'components', dim: DIM },
      { kind: 'segments', fragmentId: 'f1' },
      { kind: 'anchor', dim: DIM, here: point(0), order: 'surface', near: 3 },
      { kind: 'portals', after: 'p1', limit: 2 },
    ];
    for (const request of retired) {
      const result = await spatialQuery.run(ctxFor(svc), request);
      assert.equal(result.status, 'succeeded', `${String(request.kind)}：${result.summary}`);
      assert.equal(rec(envelopeOf(result)).status, 'unsupported');
      assert.equal(rec(envelopeOf(result)).reason, 'route_retired');
    }

    // 库仍是支持 kind 的 schema 边界：非法/旧 kind、未知字段、越界值都结构化拒绝。
    const rejected: Record<string, unknown>[] = [
      { kind: 'nope' },
      { kind: 'fragment', dim: DIM, fragmentId: 'f1' },
      { kind: 'route', dim: DIM, fromNodeId: 'a', toNodeId: 'b' },
      { kind: 'cells', dim: DIM, positions: [{ x: 1.5, y: 0, z: 0 }] },
      { kind: 'containerContents', nodeId: 'chest-1' },
    ];
    for (const request of rejected) {
      const result = await spatialQuery.run(ctxFor(svc), request);
      assert.equal(result.status, 'failed', `应拒绝：${JSON.stringify(request)}`);
      assert.equal(result.failureCode, 'BAD_ARGS');
      assert.equal(envelopeOf(result).status, 'invalid_request');
      assert.equal(rec(envelopeOf(result).problem).kind, 'invalid_request');
    }
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial_query：cells 区分已观察 / resident-unobserved / no_record，且查询只读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-cells-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    svc.observe([
      block(point(0), 'minecraft:stone', 1),
      block(point(1), 'minecraft:air', 2),
    ]);

    const query: SpatialQueryRequest = { kind: 'cells', dim: DIM, positions: [point(0), point(2), point(10_000)] };
    const voxel = svc.session.voxel;
    const revisionBefore = voxel.saveRevision;
    const observedBefore = voxel.cellAt(DIM, 0, 0, 0);

    const result = await spatialQuery.run(ctxFor(svc), query);
    assert.equal(result.status, 'succeeded');
    const envelope = envelopeOf(result);
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.contract, 'memory-host-contract/1');
    assert.equal(envelope.worldId, WORLD);
    assert.equal(envelope.dim, DIM);
    assert.equal(envelope.sessionId, S1);
    assert.equal(envelope.computedAt, CLOCK);
    assert.equal(envelope.readOnly, true);
    assert.equal(envelope.executable, false);
    assert.equal(envelope.problem, undefined);

    const data = innerOf(result);
    assert.equal(data.kind, 'cells');
    assert.deepEqual(data.gaps, []);
    const cells = list(data.cells).map(rec);

    const observed = cells[0]!;
    assert.equal(observed.observed, true);
    assert.deepEqual(observed.pos, point(0));
    assert.equal(rec(observed.state).name, 'minecraft:stone');
    assert.equal(observed.freshness, 'FRESH');
    assert.equal(typeof observed.validUntil, 'number');
    assert.equal(observed.gap, undefined);

    // 同 Section 已驻留但这一格从未观察：不是 no_record，也不是空气。
    const resident = cells[1]!;
    assert.equal(resident.observed, false);
    assert.equal(resident.residency, 'resident');
    assert.equal(resident.unobservedReason, 'resident');
    assert.equal(resident.state, undefined);
    assert.equal(resident.gap, undefined);

    // 从未记录过的 Section：no_record 仍不等于“已知空气”。
    const noRecord = cells[2]!;
    assert.equal(noRecord.observed, false);
    assert.equal(noRecord.residency, 'no_record');
    assert.equal(noRecord.unobservedReason, 'no_record');
    assert.equal(noRecord.state, undefined);
    assert.equal(noRecord.gap, undefined);

    // 连续两次相同查询深相等（固定信封时钟）。
    const again = await spatialQuery.run(ctxFor(svc), query);
    assert.deepEqual(envelopeOf(again), envelope);

    // 查询前后证据与 revision 完全不变。
    assert.equal(voxel.saveRevision, revisionBefore);
    assert.deepEqual(voxel.cellAt(DIM, 0, 0, 0), observedBefore);
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial_query：未驻留 Section 返回 unloaded gap，不隐式加载或 pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-unloaded-'));
  const dbPath = join(dir, 'memory.db');
  let writer: Awaited<ReturnType<typeof openSpatialSession>> | null = null;
  let writerClose: CloseResult | null = null;
  let reader: SharedSpatialSession | null = null;
  let readerShutdown: ShutdownResult | null = null;
  try {
    writer = await openSpatialSession({ worldId: WORLD, databasePath: dbPath, voxelLoading: 'manual', timeoutMs: 5000 });
    writer.voxel.beginSession('manual-session');
    writer.voxel.observeBatch({
      observations: [{
        worldId: WORLD, dim: DIM, sessionId: 'manual-session', sequence: 1, observedAt: OBSERVED_AT,
        source: 'vision', evidence: 'seen', stateComplete: true,
        state: { name: 'minecraft:stone', properties: {} }, pos: point(40),
      }],
      unobserved: [],
    });
    await writer.checkpoint();
    writerClose = await writer.close();
    assertCleanManualClose(writerClose);
    writer = null;

    reader = await SharedSpatialSession.open({
      worldId: WORLD, databasePath: dbPath, voxelLoading: 'manual', timeoutMs: 5000, now: () => CLOCK,
    });
    const section = blockToSection(40, 0, 0);
    assert.equal(
      reader.session.voxel.sectionResidency({ worldId: WORLD, dim: DIM, cx: section.cx, cz: section.cz, sy: section.sy }).residency,
      'not_resident',
    );
    const revisionBefore = reader.session.voxel.saveRevision;
    let prepares = 0;
    const realPrepare = reader.prepare.bind(reader);
    reader.prepare = async (keys, opts) => { prepares += 1; return realPrepare(keys, opts); };

    const result = await spatialQuery.run(ctxFor(reader), { kind: 'cells', dim: DIM, positions: [point(40)] });
    assert.equal(result.status, 'succeeded');
    const envelope = envelopeOf(result);
    assert.equal(envelope.status, 'partial');
    const data = innerOf(result);
    const cell = rec(list(data.cells)[0]);
    assert.equal(cell.observed, false);
    assert.equal(cell.residency, 'not_resident');
    assert.deepEqual(rec(cell.gap), { pos: point(40), reason: 'unloaded' });
    assert.deepEqual(list(data.gaps), [{ pos: point(40), reason: 'unloaded' }]);
    assert.equal(cell.evidence, undefined);

    assert.equal(prepares, 0, '查询不得隐式 prepare/加载 Section');
    assert.equal(reader.workingSetStats().pinnedLeases, 0);
    assert.equal(reader.session.voxel.saveRevision, revisionBefore);
  } finally {
    if (reader !== null) {
      readerShutdown = await reader.shutdown();
      assertCleanClose(readerShutdown);
    }
    if (writer !== null) {
      writerClose = await writer.close();
      assertCleanManualClose(writerClose);
    }
    const clean = readerShutdown?.close?.completed === true && writerClose?.completed !== false;
    if (clean) rmSync(dir, { recursive: true, force: true });
  }
});


test('spatial_query：容器边界 host_ledger / unsupported 与能力报告', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-containers-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    svc.session.facts.upsertContainer({
      id: 'n-chest', worldId: WORLD, dim: DIM, pos: point(3, 64),
      externalRef: 'chest-1', observedAt: OBSERVED_AT, source: { source: 'vision' },
      gone: false, ledgerRef: `${WORLD}:${DIM}:3,64,0`,
    });

    const contents = await spatialQuery.run(ctxFor(svc), { kind: 'containerContents', dim: DIM });
    assert.equal(contents.status, 'succeeded');
    const contentsEnvelope = envelopeOf(contents);
    assert.equal(contentsEnvelope.status, 'unsupported');
    assert.equal(rec(contentsEnvelope.problem).kind, 'host_ledger');
    assert.match(String(rec(contentsEnvelope.problem).detail), /host precise inventory ledger/);
    assert.equal(contentsEnvelope.data, undefined, '不得用 data/items:[] 冒充空箱');
    assert.equal(contentsEnvelope.total, undefined);

    const anchors = await spatialQuery.run(ctxFor(svc), { kind: 'containerAnchors', dim: DIM });
    assert.equal(anchors.status, 'succeeded');
    const anchorsEnvelope = envelopeOf(anchors);
    assert.equal(anchorsEnvelope.status, 'ok');
    const anchorPage = rec(anchorsEnvelope.data) as { total: number; items: Record<string, unknown>[] };
    assert.equal(anchorPage.total, 1);
    assert.equal(rec(anchorPage.items[0]).id, 'n-chest');

    const capabilities = await spatialQuery.run(ctxFor(svc), { kind: 'capabilities' });
    assert.equal(capabilities.status, 'succeeded');
    const capEnvelope = envelopeOf(capabilities);
    assert.equal(capEnvelope.status, 'ok');
    const libraryData = innerOf(capabilities);
    const report = rec(libraryData.capabilities);
    assert.equal(report.contract, 'memory-host-contract/1');
    const queryCaps = rec(report.query);
    assert.equal(queryCaps.cells, true);
    assert.equal(queryCaps.nodes, true);
    assert.equal(queryCaps.resourceAnchors, true);
    assert.equal(queryCaps.containerAnchors, true);
    assert.equal(queryCaps.containerContents, false);
    // 生产组合只有 voxel + facts；旧路线/拓扑读面报告为 false，而不是可执行。
    assert.equal(queryCaps.fragments, false);
    assert.equal(queryCaps.traversals, false);
    assert.equal(queryCaps.edges, false);
    assert.equal(queryCaps.historyRoute, false);
    assert.equal(queryCaps.anchors, false);
    assert.equal(queryCaps.components, false);
    assert.equal(queryCaps.segments, false);
    assert.equal(queryCaps.portals, false);
    const memoryCaps = rec(report.memory);
    assert.equal(memoryCaps.observeBatch, true);
    assert.equal(memoryCaps.markStale, true);
    assert.equal(memoryCaps.saveFragment, false);
    assert.equal(memoryCaps.addTraversal, false);
    assert.equal(memoryCaps.recordNode, false);
    assert.equal(memoryCaps.upsertEdge, false);
    assert.equal(memoryCaps.savePortalEdge, false);
    assert.equal(Object.values(rec(report.plan)).some(Boolean), false, '旧路线规划不再报告为生产可执行');

    // 双报告：库信封与 capabilities 形状原样；宿主组合能力单独标注 owner。
    assert.equal('owner' in report, false, '库能力报告不得混入宿主 owner');
    const host = rec(capEnvelope.hostComposed);
    assert.equal(host.owner, 'host_composed');
    assert.equal(host.contract, 'memory-host-contract/1');
    assert.equal(rec(host.memory).checkpoint, true);
    assert.equal(rec(host.memory).markTraversed, true);
    assert.equal(rec(host.memory).markModified, true);
    assert.equal(Object.hasOwn(rec(host.memory), 'saveFragment'), false, '路线片段写入键已从宿主组合能力删除');
    assert.equal(Object.hasOwn(rec(host.memory), 'addTraversal'), false);
    assert.equal(Object.hasOwn(rec(host.memory), 'recordNode'), false);
    assert.equal(Object.hasOwn(rec(host.memory), 'upsertEdge'), false);
    assert.equal(Object.hasOwn(rec(host.memory), 'savePortalEdge'), false);
    assert.equal(rec(host.query).containerContents, false);
    assert.equal(rec(host.query).fragments, false);
    assert.equal(rec(host.query).historyRoute, false);
    assert.equal(rec(host.query).edges, false);
    assert.equal(rec(host.plan).walkAuto, false, '不再有旧路优先或同高 search 规划');
    assert.equal(rec(host.plan).walkSearch, false);
    assert.equal(rec(host.plan).swim, false);
    assert.equal(rec(host.execute).walk, true);
    assert.equal(rec(host.persistence).sqlite, true);
    assert.equal(rec(host.persistence).manualResidency, true);

    // 与库报告逐键对齐（D-013 取交集的前提），但值各自独立。memory 域例外：
    // 宿主只声明仍接线的键，库报告保留的已退役路线写键不出现在宿主组合报告里。
    for (const key of ['query', 'plan', 'execute', 'persistence'] as const) {
      assert.deepEqual(Object.keys(rec(host[key])).sort(), Object.keys(rec(report[key])).sort(), `${key} 能力键必须与库报告一致`);
    }
    const hostMemoryKeys = Object.keys(rec(host.memory)).sort();
    const libraryMemoryKeys = new Set(Object.keys(rec(report.memory)));
    assert.ok(hostMemoryKeys.every((key) => libraryMemoryKeys.has(key)), '宿主 memory 键必须是库报告的键（交集，不新增）');
    assert.deepEqual(hostMemoryKeys, [
      'beginSession', 'checkpoint', 'close', 'flush', 'markModified', 'markStale', 'markTraversed', 'observeBatch',
    ]);

    // 直接查询同一 kind 得到完全相同的库数据；宿主说明只由 skill 层附加。
    const direct = svc.query({ kind: 'capabilities' });
    assert.equal(direct.status, 'ok');
    assert.deepEqual(direct.data, libraryData);
    assert.equal(rec(direct.data).kind, 'capabilities');

    const snapshot = await spatialQuery.run(ctxFor(svc), { kind: 'snapshot' });
    const snapshotData = rec(innerOf(snapshot).snapshot);
    assert.equal(snapshotData.worldId, WORLD);
    assert.equal(rec(snapshotData.facts).containers, 1);
    assert.equal(rec(snapshotData.facts).places, 0);
    assert.equal(snapshotData.fragments, undefined, '生产组合不伪造空的旧片段域');
    assert.equal(snapshotData.topology, undefined, '生产组合不伪造空的旧拓扑域');
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial_query：nodes/resourceAnchors 读 facts；传送门用 nodes tag:portal；路线/锚点 kind 已退役', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-facts-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    svc.session.facts.upsertPlace({
      id: 'n-a', kind: 'base', label: 'home', worldId: WORLD, dim: DIM,
      location: { kind: 'exact', pos: point(0, 64) }, observedAt: 1000,
      source: { source: 'agent' }, gone: false,
    });
    svc.session.facts.upsertResource({
      id: 'n-b', worldId: WORLD, dim: DIM, label: 'iron', sourceCell: point(5, 64),
      observedAt: 2000, source: { source: 'program' }, revoked: false,
    });
    svc.session.facts.upsertPlace({
      id: 'p-main', kind: 'portal', label: 'nether_portal', worldId: WORLD, dim: DIM,
      location: { kind: 'exact', pos: point(7, 64) }, observedAt: 3000,
      source: { source: 'vision' }, gone: false,
    });

    const nodes = await spatialQuery.run(ctxFor(svc), { kind: 'nodes', dim: DIM, tag: 'base' });
    const nodeItems = list(innerOf(nodes).items).map(rec);
    assert.deepEqual(nodeItems.map((node) => node.id), ['n-a']);
    assert.equal(nodeItems[0]!.source, 'agent');
    assert.equal(nodeItems[0]!.label, 'home');
    assert.equal(nodeItems[0]!.observedAt, 1000, '事实保留原始观察时间');

    const resource = await spatialQuery.run(ctxFor(svc), { kind: 'resourceAnchors', dim: DIM, tag: 'resource' });
    assert.deepEqual(list(innerOf(resource).items).map((node) => rec(node).id), ['n-b']);

    // 传送门端点作为语义事实读取，不推断连接；旧 portals 路线查询已退役。
    const portals = await spatialQuery.run(ctxFor(svc), { kind: 'nodes', dim: DIM, tag: 'portal' });
    assert.deepEqual(list(innerOf(portals).items).map((node) => rec(node).id), ['p-main']);

    // 作用域按 store 绑定的 worldId + 请求 dim 过滤；M2 不产生 scope_mismatch（无世界寻址）。
    const otherDim = await spatialQuery.run(ctxFor(svc), { kind: 'nodes', dim: 'nether' });
    assert.equal(envelopeOf(otherDim).status, 'ok');
    assert.equal(envelopeOf(otherDim).worldId, WORLD);
    assert.equal(envelopeOf(otherDim).dim, 'nether');
    assert.deepEqual(list(innerOf(otherDim).items), []);

    // 旧拓扑/片段/锚点读面不再把库数据透传给 Agent：统一结构化 unsupported。
    const retired = [
      spatialQuery.run(ctxFor(svc), { kind: 'edges', dim: DIM }),
      spatialQuery.run(ctxFor(svc), { kind: 'historyRoute', dim: DIM, from: point(0, 64), to: point(5, 64) }),
      spatialQuery.run(ctxFor(svc), { kind: 'segments', fragmentId: 'f-main' }),
      spatialQuery.run(ctxFor(svc), { kind: 'fragments', dim: DIM }),
      spatialQuery.run(ctxFor(svc), { kind: 'anchor', dim: DIM, here: point(0, 64), order: 'surface' }),
      spatialQuery.run(ctxFor(svc), { kind: 'portals' }),
    ];
    for (const pending of retired) {
      const result = await pending;
      assert.equal(result.status, 'succeeded', result.summary);
      assert.equal(rec(envelopeOf(result)).status, 'unsupported');
      assert.equal(rec(envelopeOf(result)).reason, 'route_retired');
      assert.equal(envelopeOf(result).items, undefined, '不返回空列表冒充无记录');
    }
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial_query：库 validator 仍失败关闭非法端口请求；宿主响应超限不截断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-boundary-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: S1 });
    const unknownField = svc.query({ kind: 'fragments', nodeId: 'x' } as unknown as SpatialQueryRequest);
    assert.equal(unknownField.status, 'invalid_request');
    assert.match(JSON.stringify(unknownField.problem), /unknown field/);

    const overLimit = svc.query({ kind: 'fragments', limit: 1001 } as SpatialQueryRequest);
    assert.equal(overLimit.status, 'invalid_request');

    const badPoint = svc.query({ kind: 'cells', dim: DIM, positions: [{ x: 1.5, y: 0, z: 0 }] } as unknown as SpatialQueryRequest);
    assert.equal(badPoint.status, 'invalid_request');

    // 宿主响应体积保护：超过 64 KiB 时结构化失败，不返回截断证据。
    svc.observe([block(point(6), 'minecraft:stone', 3, { properties: { blob: 'x'.repeat(70_000) } })]);
    const oversized = await spatialQuery.run(ctxFor(svc), { kind: 'cells', dim: DIM, positions: [point(6)] });
    assert.equal(oversized.status, 'failed');
    assert.equal(oversized.failureCode, 'ERROR');
    assert.equal(rec(oversized.data).result, 'result_too_large');
    assert.equal(rec(oversized.data).truncated, false);
    assert.ok((rec(oversized.data).serializedBytes as number) > (rec(oversized.data).limitBytes as number));
    assert.match(oversized.summary, /未返回任何截断证据/);
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});
