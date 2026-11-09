/**
 * V4-QA-01 验收矩阵：地下路线（v4 §10.5 / §14.3）。
 *
 * 每个测试对应 `workflow/cards/V4-QA-01.md` §2「地下」的一个条目，独立报告
 * PASS / FAIL / NOT_RUN。复用真实 `SharedSpatialSession` + SQLite（fragment/
 * traversal/topology）、`TraversalRecorder`、库 `historyRoute`、`verifyLandRoute`/
 * `searchLandRoute`、`mine_cell`、`navigateTo`、`descendTo`，以及夹具
 * `FakeAdapter`/`makeCtx`。没有第二套地图/规划器/复验器/执行器。
 *
 * 离线/Fake：FakeAdapter 只按测试显式观测的方块移动，没有真实 Java 1.20.1 物理、
 * 挖掘时延或服务端纠正。real physics NOT_RUN（V4-QA-02）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Vec3Like } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { verifyLandRoute, type LandRouteVerification, type LandSearchTransition } from '../src/spatial/land-search.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';
import { clearRouteRecords, descendTo, mineCell, moveStep, navigateTo, planRoute } from '../src/skills/movement/index.ts';
import { runSkill, validateSkill, type LandingOption, type SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'acceptance-underground-world';
const DIM = 'overworld';
const SESSION_1 = 'acceptance-ug-1';
const SESSION_2 = 'acceptance-ug-2';
const FEET_Y = 64;
const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };
const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });

let observationId = 0;
let observedAtCursor = Date.now();
const nextObservedAt = () => (observedAtCursor = Math.max(observedAtCursor + 1, Date.now() + 1));

function observation(sessionId: string, pos: Vec3Like, name: string, observedAt: number): BlockObservation {
  return {
    worldId: WORLD, sessionId, dimension: DIM, observationId: ++observationId,
    observedAt, pos: { ...pos }, name, properties: {}, stateComplete: true, source: 'vision',
  };
}

/** 同高两格净空的实测通道：支撑 y=63 石头，脚/头 y=64/65 空气。 */
function corridorCells(x0: number, x1: number, z = 0): { pos: Vec3Like; name: string }[] {
  return Array.from({ length: x1 - x0 + 1 }, (_, index) => x0 + index).flatMap((x) => [
    { pos: at(x, 63, z), name: 'minecraft:stone' },
    { pos: at(x, FEET_Y, z), name: 'minecraft:air' },
    { pos: at(x, FEET_Y + 1, z), name: 'minecraft:air' },
  ]);
}

function observeCells(svc: SharedSpatialSession, sessionId: string, cells: { pos: Vec3Like; name: string }[], observedAt: number) {
  return svc.observe(cells.map((cell) => observation(sessionId, cell.pos, cell.name, observedAt)));
}

function fragmentPage(svc: SharedSpatialSession) {
  const result = svc.query({ kind: 'fragments', dim: DIM });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'fragments') assert.fail(`expected fragments page, got ${result.data?.kind}`);
  return result.data;
}

function traversalPage(svc: SharedSpatialSession) {
  const result = svc.query({ kind: 'traversals', dim: DIM });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'traversals') assert.fail(`expected traversals page, got ${result.data?.kind}`);
  return result.data;
}

function historyRoute(svc: SharedSpatialSession, from: Vec3Like, to: Vec3Like, near = 1) {
  const result = svc.query({ kind: 'historyRoute', dim: DIM, from, to, near });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'historyRoute') assert.fail(`expected historyRoute, got ${result.data?.kind}`);
  return result.data.inspection;
}

/** 实测走过的连续位置 → 共享历史；dug 只是来源标签，几何只含实际进入的位置。 */
function recordDugTraversal(svc: SharedSpatialSession, sessionId: string, endX: number, dugToX: number) {
  const recorder = new TraversalRecorder(svc, Date.now);
  const dug = Array.from({ length: dugToX + 1 }, (_, x) => ({ pos: at(x, FEET_Y, 0), name: 'stone', ts: Date.now() }));
  for (let x = 0; x <= endX; x++) recorder.observe({ worldId: WORLD, dim: DIM, sessionId, pos: at(0.5 + x, FEET_Y, 0.5), dug });
  recorder.flush();
}

const stanceOf = (point: Vec3Like): Vec3Like => ({ x: Math.floor(point.x) + 0.5, y: point.y, z: Math.floor(point.z) + 0.5 });

function geometryTransitions(points: readonly Vec3Like[]): LandSearchTransition[] {
  return points.slice(1).map((to, index) => {
    const from = points[index]!;
    const dy = to.y - from.y;
    const kind: LandSearchTransition['kind'] = dy <= -0.25 ? 'drop' : dy >= 0.25 ? 'step' : 'walk';
    return { kind, from: { ...from }, to: { ...to }, drop: kind === 'drop' ? -dy : 0 };
  });
}

function revalidated(svc: SharedSpatialSession, points: readonly Vec3Like[], sessionId: string): LandRouteVerification {
  const stances = points.map(stanceOf);
  return verifyLandRoute(svc.session.voxel, {
    worldId: WORLD, dim: DIM, sessionId,
    body: { feet: { ...stances[0]! }, ...BODY },
    rules: walkLandRules,
  }, geometryTransitions(stances), Date.now());
}

function adapterAt(x: number, sessionId: string) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: x + 0.5, y: FEET_Y, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = sessionId;
  adapter.dim = DIM;
  return adapter;
}

function ctxFor(adapter: FakeAdapter, spatial: SharedSpatialSession): SkillCtx {
  return { ...makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } }), spatial };
}

/** 落点接口：落点/净空来自本夹具显式几何（现实由 Vision/assess_landings 提供）。 */
function landingOption(adapter: FakeAdapter, target: Vec3Like, support: Vec3Like): LandingOption {
  return {
    target, support: { pos: support, name: 'stone' },
    surface: 'ground', surfaceY: target.y, drop: Math.abs(adapter.pos.y - target.y),
    horizontalDistance: 1, clearance: 'clear', corridor: 'clear', approach: 'adjacent',
    waterDepth: 'unknown', unknowns: [],
    receipt: {
      worldId: WORLD, sessionId: adapter.sessionId, dimension: DIM, observationId: 1_000_000,
      at: Date.now(), from: { ...adapter.pos }, onGround: true,
    },
  };
}

async function openSession(dbPath: string) {
  return SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
}


/**
 * 用生产 `mine_cell` 真挖两格高短廊、再用 `move_step` 真走到 enterTo；
 * TraversalRecorder 只在 move_step 成功后收到身体实测位置（Perception 的职责），
 * 不喂计划点或未进入的挖空。返回的 adapter.actions 保留真实 dig/moveTo 链。
 */
async function digAndWalkCorridor(svc: SharedSpatialSession, sessionId: string, tunnelTo: number, enterTo: number) {
  const recorder = new TraversalRecorder(svc, Date.now);
  const adapter = adapterAt(0, sessionId);
  for (let x = 1; x <= tunnelTo; x++) {
    adapter.blocks.push({ name: 'stone', pos: at(x, FEET_Y, 0) }, { name: 'stone', pos: at(x, FEET_Y + 1, 0) });
  }
  const ctx = ctxFor(adapter, svc);
  recorder.observe({ worldId: WORLD, dim: DIM, sessionId, pos: { ...adapter.pos } });
  const dugCells: { pos: Vec3Like; name: string; ts: number }[] = [];
  for (let x = 1; x <= tunnelTo; x++) {
    for (const y of [FEET_Y, FEET_Y + 1]) {
      const validated = validateSkill(mineCell, { xyz: [x, y, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
      assert.equal(validated.ok, true, JSON.stringify(validated));
      const dug = await runSkill(ctx, mineCell, validated.args);
      assert.equal(dug.status, 'succeeded', dug.summary);
      dugCells.push({ pos: at(x, y, 0), name: 'stone', ts: Date.now() });
    }
    if (x <= enterTo) {
      const moved = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
      assert.equal(moved.status, 'succeeded', moved.summary);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId, pos: { ...adapter.pos }, dug: dugCells });
    }
  }
  recorder.flush();
  observeCells(svc, sessionId, corridorCells(0, tunnelTo), nextObservedAt());
  return { adapter, recorder };
}

test('UG-1a 挖短廊 → 进入 → 只记录实际 traversal；未进入的挖空不入几何' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug1a-'));
  const db = join(dir, 'memory.db');
  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  // 真挖到 x=4，真走到 x=3；x=4 已挖空但身体没有进入。
  const { adapter } = await digAndWalkCorridor(svc, SESSION_1, 4, 3);
  assert.ok(adapter.actions.some((action: string) => action.startsWith('dig:')), '短廊来自生产 mine_cell');
  assert.ok(adapter.actions.some((action: string) => action.startsWith('moveTo:')), '进入来自生产 move_step');
  assert.equal(Math.floor(adapter.pos.x), 3, '身体实际只走到 x=3');

  const fragments = fragmentPage(svc);
  assert.equal(fragments.total, 1);
  const fragment = fragments.items[0]!;
  assert.equal(fragment.kind, 'dug', '挖空只作来源标签');
  assert.equal(fragment.geometrySource, 'traversal', '几何来自实测经过位置');
  assert.deepEqual(fragment.polyline.map((point) => point.x), [0.5, 1.5, 2.5, 3.5], '只含实际身体位置，不含 x=4');
  const traversals = traversalPage(svc);
  assert.equal(traversals.total, 3, '只有 3 条实测移动段');
  assert.equal(traversals.items.every((entry) => entry.source === 'confirmed_traversal'), true);
  const unreached = historyRoute(svc, at(0, FEET_Y, 0), at(4, FEET_Y, 0), 0);
  assert.equal(unreached.status, 'ENDPOINT_NOT_RECORDED', '未进入的挖空不是历史端点');
  assert.deepEqual(unreached.points, []);
  t.diagnostic(`UG-1a confirmedTraversals=${traversals.total} traversalCoverage=3/3 dugPolylineEnd=3.5 unenteredEndpoint=NOT_RECORDED; real Java dig latency/body enter NOT_RUN (UG-1c)`);
});

test('UG-1b 重启后查询历史；当前证据复验后才复用' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug1b-'));
  const db = join(dir, 'memory.db');
  const first = await openSession(db);
  first.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  const { adapter: walked } = await digAndWalkCorridor(first, SESSION_1, 3, 2);
  assert.equal(Math.floor(walked.pos.x), 2, '真实动作链只进入 x=2');
  const closed = await first.shutdown();
  assert.equal(closed.close?.completed, true);

  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_2 });
  const history = historyRoute(svc, at(0, FEET_Y, 0), at(2, FEET_Y, 0));
  assert.equal(history.status, 'FOUND', '重启后历史 dug 路线仍可查询');
  assert.equal(history.historicalGeometry, true);
  assert.equal(history.executable, false);
  assert.equal(history.currentPassability, 'UNKNOWN');
  const restored = svc.session.voxel.cellAt(DIM, 1, FEET_Y, 0);
  assert.equal(restored.observed, true);
  if (!restored.observed) assert.fail('restored corridor cell must be observed');
  assert.equal(restored.evidence.freshness, 'STALE', '旧会话证据重开后是 STALE');

  const adapter = adapterAt(0, SESSION_2);
  const ctx = ctxFor(adapter, svc);
  clearRouteRecords();
  const memory = await planRoute.run(ctx, { to: at(2, FEET_Y, 0), mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
  assert.equal(memory.status, 'succeeded', memory.summary);
  assert.equal(memory.data?.executable, false, '历史候选不是执行授权');
  assert.deepEqual(adapter.actions, [], '历史查询不移动');
  const stale = revalidated(svc, history.points, SESSION_2);
  assert.equal(stale.verdict, 'STALE', '旧证据复验不通过');
  assert.equal(stale.openPrefix, 0);

  observeCells(svc, SESSION_2, corridorCells(0, 2), nextObservedAt());
  const fresh = revalidated(svc, history.points, SESSION_2);
  assert.equal(fresh.verdict, 'OPEN', '重新观察后当前证据复验通过');
  assert.equal(fresh.openPrefix, history.points.length - 1);
  clearRouteRecords();
  const reused = await navigateTo.run(ctx, { to: at(2, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(reused.status, 'succeeded', reused.summary);
  assert.equal(Math.floor(adapter.pos.x), 2);
  assert.equal(adapter.actions.every((action: string) => action.startsWith('moveTo:')), true, '复用历史路线只走 move_step');
  t.diagnostic(`UG-1b reopenHistory=FOUND stalePrefix=0 freshPrefix=${fresh.openPrefix} historyReuse=1/1`);
});

test('UG-1c 真实 Java 1.20.1 挖掘时延、身体进入与服务端纠正', { skip: 'V4-QA-02 blocked-human：FakeAdapter 的 mine_cell/move_step 无真实挖掘时延、物理碰撞与服务端纠正；离线只证明动作链与实测位置写入' }, () => {});

test('UG-2a 人工放阻挡：路线拒绝/停止在实测前缀，不自动挖' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug2a-'));
  const db = join(dir, 'memory.db');
  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  observeCells(svc, SESSION_1, corridorCells(0, 7), nextObservedAt());
  recordDugTraversal(svc, SESSION_1, 5, 7);
  const staleWrite = svc.markStale(DIM, 'observation_gap');
  if (staleWrite.status !== 'written') assert.fail(`markStale rejected: ${JSON.stringify(staleWrite.reason)}`);

  const adapter = adapterAt(0, SESSION_1);
  adapter.blocks.push({ name: 'stone', pos: at(3, FEET_Y + 1, 0) });
  const ctx = ctxFor(adapter, svc);
  const partial = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(partial.status, 'failed', partial.summary);
  assert.equal(partial.data?.executed, 2, '只执行 blocker 前的前缀');
  assert.equal(Math.floor(adapter.pos.x), 2, '身体停在实测前缀');
  const blocker = partial.data?.blocker as { index: number; status: string; problem: string; cell?: Vec3Like } | null;
  assert.equal(blocker?.status, 'BLOCKED');
  assert.equal(blocker?.problem, 'HEAD_BLOCKED');
  assert.deepEqual(blocker?.cell, at(3, FEET_Y, 0));
  assert.deepEqual(partial.data?.lastMeasuredPosition, { ...adapter.pos }, '保留最后实测位置');
  assert.equal((partial.data?.remaining as unknown[]).length, 3, 'blocker 段及之后留在剩余');
  assert.equal(adapter.actions.some((action) => action.startsWith('dig:')), false, '不自动挖 blocker');

  observeCells(svc, SESSION_1, corridorCells(0, 6), nextObservedAt());
  observeCells(svc, SESSION_1, [{ pos: at(3, FEET_Y + 1, 0), name: 'minecraft:stone' }], nextObservedAt());
  const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
  const verification = revalidated(svc, history.points, SESSION_1);
  assert.equal(verification.verdict, 'BLOCKED', '当前证据复验在 blocker 停止');
  assert.equal(verification.openPrefix, 2);
  clearRouteRecords();
  const planned = await planRoute.run(ctx, { to: at(5, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'failed', planned.summary);
  assert.deepEqual(planned.data?.steps, [], '被 blocker 截断时不给可执行 steps');
  const actionsBefore = adapter.actions.length;
  const blocked = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(blocked.status, 'failed');
  assert.equal(adapter.actions.length, actionsBefore, '复验拒绝后不再启动越界段');
  assert.equal(adapter.actions.some((action) => action.startsWith('dig:')), false, '不自动清障');
  t.diagnostic(`UG-2a blocker=HEAD_BLOCKED confirmedPrefix=${partial.data?.executed} historyInvalidationDetected=1/1 autoDig=false`);
});

test('UG-2b 显式清障后重新观察、重规划并走到端点' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug2b-'));
  const db = join(dir, 'memory.db');
  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  observeCells(svc, SESSION_1, corridorCells(0, 7), nextObservedAt());
  recordDugTraversal(svc, SESSION_1, 5, 7);
  observeCells(svc, SESSION_1, [
    { pos: at(3, FEET_Y, 0), name: 'minecraft:stone' },
    { pos: at(3, FEET_Y + 1, 0), name: 'minecraft:stone' },
  ], nextObservedAt());

  const adapter = adapterAt(0, SESSION_1);
  adapter.blocks.push({ name: 'stone', pos: at(3, FEET_Y, 0) }, { name: 'stone', pos: at(3, FEET_Y + 1, 0) });
  const ctx = ctxFor(adapter, svc);
  const approach = await navigateTo.run(ctx, { to: at(2, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 4, allowUnknownCorridor: false });
  assert.equal(approach.status, 'succeeded', approach.summary);
  assert.equal(Math.floor(adapter.pos.x), 2);

  const first = validateSkill(mineCell, { xyz: [3, FEET_Y, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
  assert.equal(first.ok, true, JSON.stringify(first));
  const footMined = await runSkill(ctx, mineCell, first.args);
  assert.equal(footMined.status, 'succeeded', footMined.summary);
  observeCells(svc, SESSION_1, [{ pos: at(3, FEET_Y, 0), name: 'minecraft:air' }], nextObservedAt());
  const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
  const stillBlocked = revalidated(svc, history.points, SESSION_1);
  assert.equal(stillBlocked.verdict, 'BLOCKED', '只挖脚部仍阻断');
  assert.equal(stillBlocked.openPrefix, 2);
  const blockedBefore = adapter.actions.length;
  const blockedRun = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(blockedRun.status, 'failed');
  assert.equal(adapter.actions.length, blockedBefore, '部分开挖后仍不越界');

  const second = validateSkill(mineCell, { xyz: [3, FEET_Y + 1, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
  assert.equal(second.ok, true, JSON.stringify(second));
  const headMined = await runSkill(ctx, mineCell, second.args);
  assert.equal(headMined.status, 'succeeded', headMined.summary);
  observeCells(svc, SESSION_1, [{ pos: at(3, FEET_Y + 1, 0), name: 'minecraft:air' }], nextObservedAt());
  assert.ok(adapter.actions.includes('dig:stone'), '清障来自显式 mine_cell');
  const cleared = revalidated(svc, history.points, SESSION_1);
  assert.equal(cleared.verdict, 'OPEN', '两格清空后复验通过');
  assert.equal(cleared.openPrefix, history.points.length - 1);

  clearRouteRecords();
  const replanned = await planRoute.run(ctx, { to: at(5, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(replanned.status, 'succeeded', replanned.summary);
  assert.equal(replanned.data?.evidenceMode, 'current');
  adapter.actions = [];
  const resumed = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(resumed.status, 'succeeded', resumed.summary);
  assert.equal(Math.floor(adapter.pos.x), 5, '清障后走到选定端点');
  assert.equal(adapter.actions.some((action) => action.startsWith('dig:')), false, '重规划后的执行不自动挖');
  t.diagnostic(`UG-2b partialMineStillBlocked=true clearedVerdict=OPEN replanned=current reachedX=${Math.floor(adapter.pos.x)}`);
});

test('UG-3a 无支撑/一格高/落沙：三种可区分的拒绝原因' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug3a-'));
  const db = join(dir, 'memory.db');
  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  const observedAt = nextObservedAt();
  // z=0：x=1..3 挖空但 y=63 也是空气（无地板）。
  observeCells(svc, SESSION_1, [
    { pos: at(0, 63, 0), name: 'minecraft:stone' },
    { pos: at(0, FEET_Y, 0), name: 'minecraft:air' },
    { pos: at(0, FEET_Y + 1, 0), name: 'minecraft:air' },
    ...[1, 2, 3].flatMap((x) => [
      { pos: at(x, 63, 0), name: 'minecraft:air' },
      { pos: at(x, FEET_Y, 0), name: 'minecraft:air' },
      { pos: at(x, FEET_Y + 1, 0), name: 'minecraft:air' },
    ]),
  ], observedAt);
  // z=10：x=1..4 只有一格高（y=65 是石头天花板）。
  observeCells(svc, SESSION_1, [
    { pos: at(0, 63, 10), name: 'minecraft:stone' },
    { pos: at(0, FEET_Y, 10), name: 'minecraft:air' },
    { pos: at(0, FEET_Y + 1, 10), name: 'minecraft:air' },
    ...[1, 2, 3, 4].flatMap((x) => [
      { pos: at(x, 63, 10), name: 'minecraft:stone' },
      { pos: at(x, FEET_Y, 10), name: 'minecraft:air' },
      { pos: at(x, FEET_Y + 1, 10), name: 'minecraft:stone' },
    ]),
  ], observedAt + 1);
  // z=20：正常净空通道，但 x=2 是落沙。
  observeCells(svc, SESSION_1, [0, 1, 2, 3, 4, 5].flatMap((x) => [
    { pos: at(x, 63, 20), name: 'minecraft:stone' },
    { pos: at(x, FEET_Y, 20), name: 'minecraft:air' },
    { pos: at(x, FEET_Y + 1, 20), name: 'minecraft:air' },
  ]), observedAt + 2);
  observeCells(svc, SESSION_1, [{ pos: at(2, FEET_Y, 20), name: 'minecraft:sand' }], observedAt + 3);

  const checks = [
    { name: '无地板', pos: { x: 0.5, y: FEET_Y, z: 0.5 }, target: at(3, FEET_Y, 0), expect: 'UNKNOWN', reason: /no observed standable surface/, x: 0.5 },
    { name: '一格高', pos: { x: 0.5, y: FEET_Y, z: 10.5 }, target: at(4, FEET_Y, 10), expect: 'BLOCKED', reason: /collision with minecraft:stone at \(1, 65, 10\)/, x: 0.5 },
    { name: '落沙', pos: { x: 0.5, y: FEET_Y, z: 20.5 }, target: at(3, FEET_Y, 20), expect: 'BLOCKED', reason: /collision with minecraft:sand at \(2, 64, 20\)/, x: 1.5 },
  ] as const;
  const reasons: string[] = [];
  for (const check of checks) {
    const adapter = adapterAt(0, SESSION_1);
    adapter.pos = { ...check.pos };
    const ctx = ctxFor(adapter, svc);
    clearRouteRecords();
    const planned = await planRoute.run(ctx, { to: check.target, mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(planned.status, 'failed', `${check.name} 不应规划成功：${planned.summary}`);
    assert.deepEqual(planned.data?.steps, [], `${check.name} 不给可执行 steps`);
    assert.deepEqual(adapter.actions, [], `${check.name} 规划不移动身体`);
    const boundaries = (planned.data?.boundaries ?? []) as { status?: string; from?: Vec3Like; to?: Vec3Like; reason?: string }[];
    const east = boundaries.find((boundary) => boundary.from?.x === check.x && boundary.to?.x === check.x + 1);
    assert.ok(east, `${check.name} 必须报告向东的边界事实`);
    assert.equal(east.status, check.expect, `${check.name} 的边界状态`);
    assert.match(String(east.reason), check.reason, `${check.name} 的拒绝原因`);
    reasons.push(`${check.name}:${east.status}:${east.reason}`);
    const refused = await navigateTo.run(ctx, { to: check.target, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(refused.status, 'failed', `${check.name} 导航应拒绝`);
    assert.ok(Math.floor(adapter.pos.x) < check.target.x, `${check.name} 不进入危险/无支撑列（实际 x=${adapter.pos.x}）`);
    assert.equal(adapter.actions.some((action: string) => action.startsWith('dig:') || action.startsWith('place:')), false, `${check.name} 不自动施工`);
  }
  assert.equal(new Set(reasons.map((entry) => entry.split(':')[1])).size >= 2, true, '拒绝原因不能一律同一分类');
  assert.equal(new Set(reasons).size, reasons.length, '三类原因互不相同');
  t.diagnostic(`UG-3a reasons=${JSON.stringify(reasons)}; falling-block physics NOT_RUN (V4-QA-02)`);
});

test('UG-3b 流体：1D land-search 边界仍标 OPEN（缺口），不能离线证明“不报可走”' , { skip: '离线缺口：plan_route source:spatial 的 land-search 边界把水格标成 OPEN；verifyLandRoute 与执行会阻断 hazard，但“搜索不报可走”无法在不改 src 的情况下离线证明。缺口已记入报告。' }, () => {});

test('UG-3c 流体：导航不进入水格，verifyLandRoute 以 hazard 阻断' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-ug3c-'));
  const db = join(dir, 'memory.db');
  const svc = await openSession(db);
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
  observeCells(svc, SESSION_1, [0, 1, 2, 3, 4, 5].flatMap((x) => [
    { pos: at(x, 63, 30), name: 'minecraft:stone' },
    { pos: at(x, FEET_Y, 30), name: 'minecraft:air' },
    { pos: at(x, FEET_Y + 1, 30), name: 'minecraft:air' },
  ]), nextObservedAt());
  observeCells(svc, SESSION_1, [
    { pos: at(2, FEET_Y, 30), name: 'minecraft:water' },
    { pos: at(2, FEET_Y + 1, 30), name: 'minecraft:water' },
  ], nextObservedAt());
  const verification = verifyLandRoute(svc.session.voxel, {
    worldId: WORLD, dim: DIM, sessionId: SESSION_1,
    body: { feet: { x: 1.5, y: FEET_Y, z: 30.5 }, ...BODY },
    rules: walkLandRules,
  }, [{ kind: 'walk', from: { x: 1.5, y: FEET_Y, z: 30.5 }, to: { x: 2.5, y: FEET_Y, z: 30.5 }, drop: 0 }], Date.now());
  assert.equal(verification.transitions[0]!.status, 'BLOCKED', '复验器必须把水格判为不可走');
  assert.match(String(verification.transitions[0]!.reason), /hazard/, '流体以 hazard 事实阻断');

  const adapter = adapterAt(0, SESSION_1);
  adapter.pos = { x: 0.5, y: FEET_Y, z: 30.5 };
  const ctx = ctxFor(adapter, svc);
  clearRouteRecords();
  const refused = await navigateTo.run(ctx, { to: at(4, FEET_Y, 30), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
  assert.equal(refused.status, 'failed');
  assert.ok(adapter.pos.x < 2.5, `身体不得进入水格（实际 x=${adapter.pos.x}）`);
  assert.equal(adapter.actions.some((action: string) => action.startsWith('dig:') || action.startsWith('place:')), false, '不自动施工');
  t.diagnostic(`UG-3c verifier=hazard navigationStopX=${adapter.pos.x.toFixed(2)} reachedWater=false; real fluid physics NOT_RUN`);
});

test('UG-4 descend_to 不以目标坐标伪造到达，保留实际落点' , async (t) => {
  // 模拟“身体连续下落后落在相邻列”的实测结果（不是把 pos 直接设成目标来自证）。
  // 真实 Java 下落物理与服务端纠正仍 NOT_RUN（UG-4b）。
  class WrongColumnWorld extends FakeAdapter {
    override async moveTo() {
      this.actions.push('moveTo:xyz');
      const start = { ...this.pos };
      const landing = { x: 2.1, y: 64, z: 0.5 };
      for (let step = 1; step <= 5; step++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        this.pos = {
          x: start.x + (landing.x - start.x) * step / 5,
          y: start.y + (landing.y - start.y) * step / 5,
          z: landing.z,
        };
      }
      this.onGround = true;
    }
  }
  const adapter = new WrongColumnWorld();
  adapter.pos = { x: 0.5, y: 70, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION_1;
  adapter.dim = DIM;
  adapter.onGround = true;
  const target = { x: 1.5, y: 64, z: 0.5 };
  const support = { x: 1, y: 63, z: 0 };
  adapter.blocks.push({ name: 'stone', pos: { ...support } });
  const option = landingOption(adapter, target, support);
  const base = makeCtx(adapter);
  const ctx: SkillCtx = { ...base, senses: { ...base.senses, refresh() {}, landingOptions: () => [option] } };
  t.after(() => ctx.memory.close());

  const result = await descendTo.run(ctx, { target });
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual((result.data as { position?: Vec3Like } | undefined)?.position, { x: 2.1, y: 64, z: 0.5 }, '回执保留实际落点');
  assert.deepEqual({ ...adapter.pos }, { x: 2.1, y: 64, z: 0.5 }, '身体实际落在相邻列');
  assert.notDeepEqual(adapter.pos, target, '实际落点与所选落点不同');
  const arrival = (result.data as { arrival?: { satisfied?: boolean } } | undefined)?.arrival;
  assert.equal(arrival?.satisfied, false, '不按目标坐标伪造 ARRIVED');
  assert.equal(adapter.actions.filter((action: string) => action.startsWith('moveTo:')).length, 1, '只发一次有界移动');
  t.diagnostic('UG-4 wrongColumnPreserved=2.1,64,0.5 selectedTarget=1.5,64,0.5 arrivalSatisfied=false; real fall physics NOT_RUN (UG-4b)');
});

test('UG-4b 真实 Java 1.20.1 下落物理与服务端位置纠正', { skip: 'V4-QA-02 blocked-human：离线只模拟适配器报告的落点；真实重力/碰撞/服务端纠正需要实机' }, () => {});

