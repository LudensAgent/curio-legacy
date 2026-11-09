import assert from 'node:assert/strict';
import { test } from 'node:test';
// 运行时值导出：类、常量与只读 frontier 查询。
import { GROUNDED_ARRIVAL_DEFAULTS, frontierCandidates, RouteVerifier, SpatialMemoryStoreImpl, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
// 类型导出：只 import type，不当运行时对象。
import type { BodySample, ChangeReport, CollisionShapeProvider, FrontierCandidateQueryView, FrontierQueryData, GroundedArrival, MoveExecutor, NavProblem, NavResult, Observation, SpatialQueryPort, WalkSearchCounters, WalkSearchFrontier, WalkSearchSnapshot } from 'curio-minecraft-3d-memory';

test('空间库公开包入口可导入运行时值与类型', () => {
  assert.equal(typeof WalkRouteExecutor, 'function', 'WalkRouteExecutor 是运行时类');
  assert.equal(typeof VoxelMap, 'function', 'VoxelMap 是运行时类');
  assert.equal(typeof RouteVerifier, 'function', 'RouteVerifier 是运行时类');
  assert.equal(typeof frontierCandidates, 'function', 'frontierCandidates 是运行时函数');
  assert.equal(typeof GROUNDED_ARRIVAL_DEFAULTS.horizontalTolerance, 'number', '默认容差是运行时常量');
  assert.equal(GROUNDED_ARRIVAL_DEFAULTS.maxVerticalSpeed >= 0.0784, true, '竖直限速吸收静止着地重力速度');
});

const SMOKE_WORLD = 'smoke-world';
const SMOKE_DIM = 'overworld';

/** 调用方已跑过的只读搜索快照：库里唯一的 frontier 数据来源，smoke 不启动搜索。 */
function frontierSnapshot(): WalkSearchSnapshot {
  const seen = (x: number, y: number, z: number): Observation => ({
    pos: { x, y, z },
    state: { name: 'minecraft:stone', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    observedAt: 1000,
    source: 'vision',
    sessionId: 's1',
    sequence: 1,
    dim: SMOKE_DIM,
    worldId: SMOKE_WORLD,
  });
  const counters: WalkSearchCounters = {
    nodesReached: 1, nodesExpanded: 1, edgesEvaluated: 1, edgesOpen: 1, edgesBlocked: 0,
    edgesUnknown: 1, edgesStale: 0, edgesUnsupported: 0, edgesSkippedReached: 0,
    frontierCandidates: 1, frontiersReported: 1, frontierLimitReached: false,
    unavailableHistoricalCandidates: 0, unavailableHistoricalReported: 0, unavailableHistoricalLimitReached: false,
    diagnosticsReported: 0, diagnosticsTruncated: false, hasMoreWork: false,
  };
  const frontier: WalkSearchFrontier = {
    stance: { x: 1.5, y: 64, z: 0.5 },
    to: { x: 2.5, y: 64, z: 0.5 },
    gap: [{ x: 2.5, y: 64, z: 0.5 }],
    reachability: 'OPEN',
    basis: [seen(1, 64, 0), seen(1, 65, 0)],
    reason: 'adjacent never-observed boundary',
    computedAt: 1000,
    validUntil: 61_000,
  };
  return {
    state: 'FOUND',
    worldId: SMOKE_WORLD,
    dim: SMOKE_DIM,
    sessionId: 's1',
    mode: 'walk',
    body: { feet: { x: 0.5, y: 64, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    from: { x: 0.5, y: 64, z: 0.5 },
    target: { x: 4.5, y: 64, z: 0.5 },
    arrival: { kind: 'exact' },
    ruleVersion: 'smoke-rule/1',
    limits: { maxNodes: 2048, maxEdges: 8192, maxFrontiers: 64, maxDiagnostics: 64 },
    candidate: null,
    frontiers: [frontier],
    unavailableHistorical: [],
    diagnostics: [],
    counters,
    reason: 'smoke fixture',
    computedAt: 1000,
    validUntil: 61_000,
  };
}

test('frontier 查询 smoke：无 caller snapshot source 时能力位 false 且诚实 unsupported', () => {
  const store = new SpatialMemoryStoreImpl({ worldId: SMOKE_WORLD, query: { now: () => 1000 } });
  const caps = store.query({ kind: 'capabilities' });
  assert.equal(caps.status, 'ok');
  if (caps.data?.kind !== 'capabilities') throw new Error('capabilities 查询必须返回 capabilities data');
  assert.equal(caps.data.capabilities.query.frontiers, false, '宿主未注入快照源，能力位必须诚实为 false');

  const result = store.query({ kind: 'frontiers', dim: SMOKE_DIM, here: { x: 0.5, y: 64, z: 0.5 } });
  assert.equal(result.status, 'unsupported', '无 source 时不是“没有边界”，而是 unsupported');
  assert.equal(result.problem?.kind, 'unsupported');
  assert.equal(result.problem?.kind === 'unsupported' ? result.problem.query : null, 'frontiers');
  assert.equal(result.data, undefined, '不得用空 items 冒充无边界');
});

test('frontier 查询 smoke：有 caller snapshot source 时能力位 true 并按库语义投影候选/保留 unsupported', () => {
  const snapshot = frontierSnapshot();
  const store = new SpatialMemoryStoreImpl({
    worldId: SMOKE_WORLD,
    frontierSource: (dim) => (dim === SMOKE_DIM ? snapshot : null),
    query: { now: () => 2000 },
  });
  const caps = store.query({ kind: 'capabilities' });
  assert.equal(caps.status, 'ok');
  if (caps.data?.kind !== 'capabilities') throw new Error('capabilities 查询必须返回 capabilities data');
  assert.equal(caps.data.capabilities.query.frontiers, true, '注入快照源后能力位为 true');

  const result = store.query({ kind: 'frontiers', dim: SMOKE_DIM, here: { x: 0.5, y: 64, z: 0.5 } });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'frontiers') throw new Error('frontiers 查询必须返回 frontier data');
  const data = result.data;
  assert.equal(data.total, 1);
  assert.equal(data.items.length, 1);
  const item = data.items[0]!;
  assert.equal(item.id, `frontier:${SMOKE_DIM}:2.5,64,0.5`);
  assert.deepEqual(item.pos, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(item.stance, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(item.reachability, 'OPEN', '只证明接近 stance');
  assert.equal(item.boundaryReachability, 'unknown', '边界格未被进入');
  assert.deepEqual(item.direction, { axis: 'x', sign: 1 });
  assert.equal(item.ageMs, 1000, '查询时钟减快照时刻');
  assert.equal(data.staleCount, 0);
  assert.equal(data.truncated, false);

  const noSnapshot = new SpatialMemoryStoreImpl({
    worldId: SMOKE_WORLD,
    frontierSource: () => null,
    query: { now: () => 2000 },
  });
  const missing = noSnapshot.query({ kind: 'frontiers', dim: SMOKE_DIM, here: { x: 0.5, y: 64, z: 0.5 } });
  assert.equal(missing.status, 'unsupported', '有 source 但无快照时仍是诚实 unsupported');
  assert.equal(missing.problem?.kind, 'unsupported');
});

// 这些类型变量只在编译期使用，运行时无对应导出；仅用于类型检查。
const _arrival: GroundedArrival = GROUNDED_ARRIVAL_DEFAULTS;
const _types: { s?: BodySample; r?: ChangeReport; p?: CollisionShapeProvider; m?: MoveExecutor; n?: NavResult; pr?: NavProblem } = {};
const _frontierTypes: { d?: FrontierQueryData; c?: FrontierCandidateQueryView; q?: SpatialQueryPort } = {};
void _arrival; void _types; void _frontierTypes;
