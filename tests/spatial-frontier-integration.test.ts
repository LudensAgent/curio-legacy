/**
 * P25-E frontier 宿主接入验收：按 D-V4-026 保守默认锁定「未接线」的诚实边界。
 *
 * 库 0.10.1-workflow.8 的 `SpatialQueryPort` 已接受 additive `frontiers` kind，
 * 但宿主没有注入 `frontierSource`（`SharedSpatialSession` 构造
 * `SpatialMemoryStoreImpl` 时未传），也没有 `WalkSearchSnapshot` 生产者
 * （`plan_route` 的 `WalkRouteSearch` 是调用内局部变量，不登记到共享会话）。
 *
 * 因此本文件证明的是宿主当前真实状态，而不是伪造的可用性：
 * - 库与宿主能力位 `query.frontiers` 都是 false；
 * - `{kind:"frontiers"}` 由库返回结构化 `unsupported`（精确缺失能力），
 *   宿主不补空列表、不伪造候选/证据年龄/STALE 计数；
 * - 查询仍只读、只委托一次，不加载 Section、不启动搜索、不改证据/历史/拓扑；
 * - 工具说明保持 15 个宿主支持的 kind，不声称 16 kind。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SpatialQueryRequest, SpatialQueryResult } from 'curio-minecraft-3d-memory';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';

const WORLD = 'world-spatial-frontier';
const DIM = 'overworld';
const SESSION = 's1';
const CLOCK = 1_000_000;
const OBSERVED_AT = 900_000;
const HERE = { x: 0.5, y: 64, z: 0.5 };

const frontierRequest = (over: Record<string, unknown> = {}) => ({ kind: 'frontiers', dim: DIM, here: { ...HERE }, ...over });

function block(pos: { x: number; y: number; z: number }, name: string, observationId: number): BlockObservation {
  return {
    name,
    properties: {},
    worldId: WORLD,
    sessionId: SESSION,
    dimension: DIM,
    source: 'vision',
    stateComplete: true,
    observedAt: OBSERVED_AT,
    observationId,
    pos,
  };
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function envelopeOf(result: SkillResult): SpatialQueryResult {
  assert.ok(result.data !== undefined, 'result must carry the contract envelope');
  return result.data as unknown as SpatialQueryResult;
}

function ctxFor(spatial: unknown): SkillCtx {
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
    signal: new AbortController().signal,
    deadline: Date.now() + 3000,
    taskId: 'spatial-frontier-test',
    progress(): never {
      throw new Error('spatial_query must not report progress');
    },
  } as unknown as SkillCtx;
}

function validate(raw: unknown) {
  return spatialQuery.validate(raw, {} as GameAdapter);
}

async function openSession(dir: string, voxelLoading?: 'manual'): Promise<SharedSpatialSession> {
  return SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    timeoutMs: 5000,
    now: () => CLOCK,
    ...(voxelLoading === undefined ? {} : { voxelLoading }),
  });
}

function assertCleanClose(result: ShutdownResult): void {
  assert.ok(result.close !== null, 'shutdown must return a real close result');
  assert.equal(result.close.completed, true);
  assert.equal(result.close.error, null);
  assert.equal(result.close.unconfirmedRequest, false);
  assert.equal(result.close.dirty, false);
}

test('P25-E：frontier 能力位库/宿主都诚实为 false，宿主说明不声称 16 kind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-frontier-caps-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const result = await spatialQuery.run(ctxFor(svc), { kind: 'capabilities' });
    assert.equal(result.status, 'succeeded');
    const envelope = envelopeOf(result);
    assert.equal(envelope.status, 'ok');

    // 库：未注入 caller snapshot source，能力位是 false（D-V4-026），不是“未知”。
    const libraryQuery = rec(rec(rec(envelope.data).capabilities).query);
    assert.equal(libraryQuery.frontiers, false, '宿主未注入快照源，库能力位必须为 false');

    // 宿主：同一组键，值同为 false，不冒充库能力或宿主已接线。
    const host = rec(rec(envelope).hostComposed);
    assert.equal(host.owner, 'host_composed');
    const hostQuery = rec(host.query);
    assert.equal(hostQuery.frontiers, false, '宿主 frontier 未接线，能力位必须为 false');
    assert.deepEqual(Object.keys(hostQuery).sort(), Object.keys(libraryQuery).sort(), '宿主/库 query 能力键集必须对齐');

    // 工具说明描述的是宿主真实支持的 15 个 kind；接线前不得声称 16 kind。
    assert.match(spatialQuery.description, /15 种 kind/);
    assert.doesNotMatch(spatialQuery.description, /16\s*种/);
    assert.doesNotMatch(spatialQuery.argsDoc, /"kind":"frontiers"/, '未接线前不把 frontiers 写进宿主参数说明');
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P25-E：未接线宿主对 {kind:"frontiers"} 返回结构化 unsupported，不伪造候选/年龄/STALE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-frontier-unsupported-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const request = frontierRequest();

    const result = await spatialQuery.run(ctxFor(svc), request);
    // 结构化 unsupported 是成功的查询回复，不是宿主参数错误。
    assert.equal(result.status, 'succeeded', result.summary);
    const envelope = envelopeOf(result);
    assert.equal(envelope.status, 'unsupported');
    if (envelope.status !== 'unsupported' || envelope.problem === undefined) {
      assert.fail(`expected structured unsupported, got ${envelope.status}`);
    }
    assert.equal(envelope.problem.kind, 'unsupported');
    assert.equal(envelope.problem.query, 'frontiers');
    const detail = envelope.problem.detail;
    assert.match(detail, /caller-supplied WalkSearchSnapshot/);
    assert.match(detail, /no snapshot source/);
    assert.match(result.summary, /frontiers 不支持/);
    assert.match(result.summary, /no snapshot source/);

    // 不返回任何候选投影：没有 data/items/total，也没有证据年龄或 STALE 计数。
    assert.equal(envelope.data, undefined, '不得用空列表冒充“没有边界”');
    assert.equal(envelope.total, undefined);
    const serialized = JSON.stringify(envelope);
    for (const fabricated of ['"items"', '"ageMs"', '"staleCount"', '"frontier:', '"walk_search_snapshot"']) {
      assert.equal(serialized.includes(fabricated), false, `unsupported 信封不得包含 ${fabricated}`);
    }

    // 技能是薄转发：宿主没有把 unsupported 改写成别的信封。
    assert.deepEqual(envelope, svc.query(request as unknown as SpatialQueryRequest));
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P25-E：frontier 查询只读且只委托一次，不启动搜索/不加载 Section/不改证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-frontier-readonly-'));
  const svc = await openSession(dir, 'manual');
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    svc.observe([block({ x: 0, y: 64, z: 0 }, 'minecraft:stone', 1)]);
    const voxel = svc.session.voxel;
    const history = svc.session.history;
    const topology = svc.session.topology;
    const before = {
      voxelRevision: voxel.saveRevision,
      historyRevision: history.revision,
      topologyRevision: topology.revision,
      cell: structuredClone(voxel.cellAt(DIM, 0, 64, 0)),
      historySnapshot: structuredClone(history.checkpointSnapshot()),
      topologySnapshot: structuredClone(topology.checkpointSnapshot()),
      pinned: svc.workingSetStats().pinnedLeases,
    };

    let prepares = 0;
    const realPrepare = svc.prepare.bind(svc);
    svc.prepare = async (keys, options) => { prepares += 1; return realPrepare(keys, options); };

    const delegated: unknown[] = [];
    const realQuery = svc.query.bind(svc);
    svc.query = ((request: SpatialQueryRequest) => {
      delegated.push(request);
      return realQuery(request);
    }) as typeof svc.query;

    const request = frontierRequest({ limit: 5 });
    const first = await spatialQuery.run(ctxFor(svc), request);
    const second = await spatialQuery.run(ctxFor(svc), request);
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    assert.deepEqual(envelopeOf(first), envelopeOf(second), '同一请求重复查询深相等');

    // 只把请求原样交给共享会话：没有宿主侧扫描器、第二张地图或预搜索。
    assert.equal(delegated.length, 2);
    assert.deepEqual(delegated, [request, request]);
    assert.equal(prepares, 0, '查询不得隐式 prepare/加载 Section');
    assert.equal(svc.workingSetStats().pinnedLeases, before.pinned);

    assert.equal(voxel.saveRevision, before.voxelRevision);
    assert.equal(history.revision, before.historyRevision);
    assert.equal(topology.revision, before.topologyRevision);
    assert.deepEqual(voxel.cellAt(DIM, 0, 64, 0), before.cell);
    assert.deepEqual(history.checkpointSnapshot(), before.historySnapshot);
    assert.deepEqual(topology.checkpointSnapshot(), before.topologySnapshot);
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P25-E：frontier schema 仍归库 validator；缺 dim/here 或未知字段是 invalid_request(BAD_ARGS)', async () => {
  // skill 边界仍只做对象检查，frontiers 的 schema 由库拥有。
  assert.equal(validate(frontierRequest()).ok, true);

  const dir = mkdtempSync(join(tmpdir(), 'spatial-frontier-invalid-'));
  const svc = await openSession(dir);
  let shutdown: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const rejected: Record<string, unknown>[] = [
      { kind: 'frontiers' },
      { kind: 'frontiers', dim: DIM },
      { kind: 'frontiers', dim: DIM, here: { ...HERE }, after: 'x' },
      { kind: 'frontiers', dim: DIM, here: { ...HERE }, limit: 1001 },
    ];
    for (const request of rejected) {
      const result = await spatialQuery.run(ctxFor(svc), request);
      assert.equal(result.status, 'failed', `应拒绝：${JSON.stringify(request)}`);
      assert.equal(result.failureCode, 'BAD_ARGS');
      const envelope = envelopeOf(result);
      assert.equal(envelope.status, 'invalid_request');
      if (envelope.status !== 'invalid_request' || envelope.problem === undefined) {
        assert.fail(`expected invalid_request, got ${envelope.status}`);
      }
      assert.equal(envelope.problem.kind, 'invalid_request');
      assert.equal(envelope.data, undefined, '非法请求不返回任何查询 data');
    }
  } finally {
    shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true });
  }
});
