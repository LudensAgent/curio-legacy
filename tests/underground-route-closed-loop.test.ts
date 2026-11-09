/**
 * V4-UG-04 地下离线闭环验收（v4 §10.3/§10.5/§14.3）。
 *
 * 复用的生产组件（不新建第二套）：真实 `SharedSpatialSession` + SQLite（历史
 * fragment/traversal/topology）、`TraversalRecorder`（实测段写入）、库
 * `historyRoute` 查询与 `TopologyStore`、`searchLandRoute`/`verifyLandRoute`
 * （当前证据复验）、`planRoute`/`navigate_to`、`mine_cell`，以及测试夹具
 * `FakeAdapter`/`makeCtx`。没有第二张地图、第二个规划器/复验器/执行器/数据库。
 *
 * realRun: NOT_RUN。这里没有服务器、没有真实 Mineflayer 身体、没有 Java 1.20.1
 * 物理与服务端位置纠正；FakeAdapter 只按测试显式放置的方块移动。真实物理、
 * 服务端纠正、实机落点/挖掘时延都不能由本文件证明。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Vec3Like } from 'curio-minecraft-3d-memory';
import type { BlockObservation, MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { verifyLandRoute, type LandRouteVerification, type LandSearchTransition } from '../src/spatial/land-search.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';
import { clearRouteRecords, mineCell, navigateTo, planRoute } from '../src/skills/movement/index.ts';
import { executionWindow } from '../src/skills/movement/route.ts';
import { runSkill, validateSkill, type LandingOption, type SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'underground-route-world';
const DIM = 'overworld';
const SESSION_1 = 'ug-session-1';
const SESSION_2 = 'ug-session-2';
const FEET_Y = 64;
const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };

const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
let observationId = 0;
/** 严格递增且不早于真实当前时间的观测时间：markStale 以真实时钟设边界，旧时间戳会被拒绝。 */
let observedAtCursor = Date.now();
const nextObservedAt = () => {
  observedAtCursor = Math.max(observedAtCursor + 1, Date.now() + 1);
  return observedAtCursor;
};

function observation(sessionId: string, pos: Vec3Like, name: string, observedAt: number): BlockObservation {
  return {
    worldId: WORLD, sessionId, dimension: DIM, observationId: ++observationId,
    observedAt, pos: { ...pos }, name, properties: {}, stateComplete: true, source: 'vision',
  };
}

/** 同高两格净空的实测通道：支撑 y=63 石头，脚/头 y=64/65 空气。 */
function corridorCells(x0: number, x1: number, z = 0): { pos: Vec3Like; name: string }[] {
  return Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i).flatMap((x) => [
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

function nodePage(svc: SharedSpatialSession) {
  const result = svc.query({ kind: 'nodes', dim: DIM, limit: 100 });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'nodes') assert.fail(`expected nodes page, got ${result.data?.kind}`);
  return result.data;
}

function historyRoute(svc: SharedSpatialSession, from: Vec3Like, to: Vec3Like, near = 1) {
  const result = svc.query({ kind: 'historyRoute', dim: DIM, from, to, near });
  assert.equal(result.status, 'ok');
  if (result.data?.kind !== 'historyRoute') assert.fail(`expected historyRoute, got ${result.data?.kind}`);
  return result.data.inspection;
}

/** 把 TraversalRecorder 实测走过的连续位置写成共享历史；dug 只作来源标签。 */
function recordDugTraversal(svc: SharedSpatialSession, sessionId: string, endX: number, dugToX: number) {
  const recorder = new TraversalRecorder(svc, Date.now);
  const dug = Array.from({ length: dugToX + 1 }, (_, x) => ({ pos: at(x, FEET_Y, 0), name: 'stone', ts: Date.now() }));
  for (let x = 0; x <= endX; x++) {
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId, pos: at(0.5 + x, FEET_Y, 0.5), dug });
  }
  recorder.flush();
}

/** 拓扑是显式 cell 坐标（整数格角）；身体复验用同一格的格心站位。 */
const stanceOf = (point: Vec3Like): Vec3Like => ({ x: Math.floor(point.x) + 0.5, y: point.y, z: Math.floor(point.z) + 0.5 });

/** 实测几何 → 库的 LandSearchTransition；高度变化用同一 evaluator 的 step/drop。 */
function geometryTransitions(points: readonly Vec3Like[]): LandSearchTransition[] {
  return points.slice(1).map((to, index) => {
    const from = points[index]!;
    const dy = to.y - from.y;
    const kind: LandSearchTransition['kind'] = dy <= -0.25 ? 'drop' : dy >= 0.25 ? 'step' : 'walk';
    return { kind, from: { ...from }, to: { ...to }, drop: kind === 'drop' ? -dy : 0 };
  });
}

/** 用共享库的 `verifyLandRoute` 对历史几何做当前证据复验；不新建复验器。 */
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

/** descend_to 的 target 是格心（3.5），FakeAdapter 的 xyz 会把格心再加 0.5；只对分数目标按原值落位。 */
class ExactDropWorld extends FakeAdapter {
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'xyz' && (!Number.isInteger(target.x) || !Number.isInteger(target.z))) {
      this.pos = { x: target.x, y: target.y, z: target.z };
      return;
    }
    return super.moveTo(target, opts);
  }
}

async function openSession(dbPath: string) {
  return SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
}

async function withCleanSession<T>(dbPath: string, run: (svc: SharedSpatialSession) => Promise<T>): Promise<T> {
  const svc = await openSession(dbPath);
  let shutdown: ShutdownResult | null = null;
  try {
    return await run(svc);
  } finally {
    shutdown = await svc.shutdown();
    assert.equal(shutdown.close?.completed, true, `shared session did not close cleanly: ${JSON.stringify(shutdown.error)}`);
    assert.equal(shutdown.close?.error ?? null, null);
  }
}

function tempDb(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'underground-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(dir, 'memory.db');
}

test('a) 挖入后只有实际 traversed 段成为 traversal；dug 只是来源标签，未进入的挖空不入几何 [real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    observeCells(svc, SESSION_1, corridorCells(0, 10), nextObservedAt());
    // 实际只走到 x=5.5；x=6..10 已被挖空，但身体没有进入。
    recordDugTraversal(svc, SESSION_1, 5, 10);

    const fragments = fragmentPage(svc);
    assert.equal(fragments.total, 1);
    const fragment = fragments.items[0]!;
    assert.equal(fragment.kind, 'dug', '邻近挖空只作来源标签');
    assert.equal(fragment.geometrySource, 'traversal', '几何必须来自实测转身，不是挖空外推');
    assert.deepEqual(fragment.polyline.map((point) => point.x), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], 'polyline 只含实测身体位置');
    assert.ok(fragment.polyline.every((point) => point.x <= 5.5), '未进入的挖空不得进入 polyline');

    // 共享写入使用显式 `coordinate:'cell'`：traversal 端点存整数格；fragment polyline
    // 仍保留原始实测点（0.5、1.5、…），两者分别证明“历史记号”与“实测几何”。
    const traversals = traversalPage(svc);
    assert.equal(traversals.total, 5);
    assert.deepEqual(traversals.items.map((entry) => entry.from.x), [0, 1, 2, 3, 4]);
    assert.deepEqual(traversals.items.map((entry) => entry.to.x), [1, 2, 3, 4, 5]);
    assert.ok(traversals.items.every((entry) => entry.source === 'confirmed_traversal' && entry.mode === 'walk'));

    const nodes = nodePage(svc);
    assert.equal(nodes.total, 6, '拓扑节点只由确认段派生');
    assert.ok(nodes.items.every((node) => !node.id.includes(':10,64,0')), '未进入的挖空 x=10 不得有拓扑节点');

    const reached = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
    assert.equal(reached.status, 'FOUND');
    assert.equal(reached.historicalGeometry, true);
    assert.equal(reached.executable, false);
    assert.equal(reached.currentPassability, 'UNKNOWN');
    assert.ok(reached.points.every((point) => point.x <= 5.5));

    const unentered = historyRoute(svc, at(0, FEET_Y, 0), at(10, FEET_Y, 0));
    assert.equal(unentered.status, 'ENDPOINT_NOT_RECORDED', '挖空但未进入的端点不是历史路线端点');
    assert.deepEqual(unentered.points, []);
  });
});

test('b) 重开后历史 dug 路线仍可查询；当前证据复验通过后才按选定端点复用 [real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    observeCells(svc, SESSION_1, corridorCells(0, 7), nextObservedAt());
    recordDugTraversal(svc, SESSION_1, 5, 7);
  });

  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_2 });
    // 重开把旧会话证据恢复为 STALE（库的持久化语义），不是当前 OPEN。
    // 从未观测的格仍是 UNKNOWN；只有真正收到 markStale 才由 test c 显式标记。
    const history = historyRoute(svc, at(0, FEET_Y, 0), at(4, FEET_Y, 0));
    assert.equal(history.status, 'FOUND');
    assert.equal(history.historicalGeometry, true);
    assert.equal(history.executable, false);
    assert.equal(history.currentPassability, 'UNKNOWN');
    assert.equal(history.points.length, 5, '历史 0→4 是 5 个记录节点');

    const restoredCell = svc.session.voxel.cellAt(DIM, 2, FEET_Y, 0);
    assert.equal(restoredCell.observed, true);
    if (!restoredCell.observed) assert.fail('restored corridor cell must be observed');
    assert.equal(restoredCell.evidence.freshness, 'STALE', '旧会话证据重开后是 STALE');
    assert.equal(svc.session.voxel.cellAt(DIM, 2, FEET_Y, 1).observed, false, '从未观测的格不是 STALE，而是无证据');

    const adapter = adapterAt(0, SESSION_2);
    const ctx = ctxFor(adapter, svc);
    clearRouteRecords();
    const memory = await planRoute.run(ctx, { to: at(4, FEET_Y, 0), mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
    assert.equal(memory.status, 'succeeded', memory.summary);
    assert.equal(memory.data?.currentPassability, 'UNKNOWN');
    assert.equal(memory.data?.executable, false);
    assert.equal(Math.floor((memory.data?.selectedEndpoint as Vec3Like).x), 4, '复用只到选定端点');
    assert.deepEqual(adapter.actions, [], '历史查询/规划不移动');

    // 旧会话证据（STALE）不是当前 OPEN。
    const stale = revalidated(svc, history.points, SESSION_2);
    assert.equal(stale.verdict, 'STALE');
    assert.equal(stale.openPrefix, 0, 'STALE 不能提供任何已确认 OPEN 前缀');

    // 显式重新观察当前证据后，历史几何在同一复验器上通过。
    observeCells(svc, SESSION_2, corridorCells(0, 6), nextObservedAt());
    const fresh = revalidated(svc, history.points, SESSION_2);
    assert.equal(fresh.verdict, 'OPEN');
    assert.equal(fresh.openPrefix, history.points.length - 1);

    clearRouteRecords();
    const planned = await planRoute.run(ctx, { to: at(4, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(planned.status, 'succeeded', planned.summary);
    assert.equal(planned.data?.evidenceMode, 'current', '复验通过后使用当前证据');
    const steps = planned.data?.steps as { skill: string }[];
    assert.equal(steps.length, 4, '0.5→4.5 是同高 4 段');
    assert.ok(steps.every((step) => step.skill === 'move_step'), '只复用现有动作');

    adapter.actions = [];
    const reused = await navigateTo.run(ctx, { to: at(4, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(reused.status, 'succeeded', reused.summary);
    assert.equal(Math.floor(adapter.pos.x), 4, '到达选定端点，不越过');
    const transitions = reused.data?.transitions as { to: Vec3Like }[];
    assert.equal(Math.floor(transitions.at(-1)!.to.x), 4);
    assert.ok(!adapter.actions.some((action) => action.startsWith('dig:')), '复用路线不自动挖掘');
    assert.ok(adapter.actions.every((action) => action.startsWith('moveTo:')), '只执行移动动作');
  });
});

test('c) 已记录通道放入 blocker：复验停在 blocker 前、执行窗口不含越界段，身体也停在实测前缀 [real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    observeCells(svc, SESSION_1, corridorCells(0, 7), nextObservedAt());
    recordDugTraversal(svc, SESSION_1, 5, 7);
    // 显式 markStale（真正收到陈旧通知）：旧 clearance 不再被当作当前证据；
    // blocker 只在物理世界出现。没有该写入时，从未观测的格是 UNKNOWN 而不是 STALE。
    const staleWrite = svc.markStale(DIM, 'observation_gap');
    if (staleWrite.status !== 'written') assert.fail(`markStale rejected: ${JSON.stringify(staleWrite.reason)}`);
    assert.ok(staleWrite.report.sections.length > 0, 'markStale 必须给出受影响的 sections');

    const adapter = adapterAt(0, SESSION_1);
    // 头部格是实体方块：脚下无台阶可借，move_step 报 HEAD_BLOCKED 并停在 blocker 前。
    adapter.blocks.push({ name: 'stone', pos: at(3, FEET_Y + 1, 0) });
    const ctx = ctxFor(adapter, svc);
    const partial = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });

    assert.equal(partial.status, 'failed', partial.summary);
    assert.equal(partial.data?.evidenceMode, 'historical');
    assert.equal(partial.data?.executed, 2, '只执行 blocker 前的前缀');
    assert.equal(partial.data?.confirmedSegments, 2);
    assert.equal(Math.floor(adapter.pos.x), 2);
    const blocker = partial.data?.blocker as { index: number; status: string; problem: string; cell?: Vec3Like } | null;
    assert.equal(blocker?.index, 2);
    assert.equal(blocker?.status, 'BLOCKED');
    assert.equal(blocker?.problem, 'HEAD_BLOCKED');
    assert.deepEqual(blocker?.cell, at(3, FEET_Y, 0));
    assert.deepEqual(partial.data?.lastMeasuredPosition, { ...adapter.pos }, '保留最后实测位置');
    assert.equal((partial.data?.remaining as unknown[]).length, 3, 'blocker 段及其后都留在剩余段');
    assert.ok(!adapter.actions.some((action) => action.startsWith('dig:')), '不自动挖 blocker');

    // 用当前证据显式观察同一个 blocker：历史几何不变，但复验在 blocker 停止。
    observeCells(svc, SESSION_1, corridorCells(0, 6), nextObservedAt());
    observeCells(svc, SESSION_1, [
      { pos: at(3, FEET_Y + 1, 0), name: 'minecraft:stone' },
    ], nextObservedAt());
    const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
    assert.equal(history.status, 'FOUND', '历史几何仍可查询');
    assert.equal(history.currentPassability, 'UNKNOWN');

    // 从未观测的相邻列是无证据（UNKNOWN），不是 markStale 造成的 STALE。
    assert.equal(svc.session.voxel.cellAt(DIM, 2, FEET_Y, 1).observed, false);
    const unseen = verifyLandRoute(svc.session.voxel, {
      worldId: WORLD, dim: DIM, sessionId: SESSION_1,
      body: { feet: { x: 2.5, y: FEET_Y, z: 0.5 }, ...BODY },
      rules: walkLandRules,
    }, [{ kind: 'walk', from: { x: 2.5, y: FEET_Y, z: 0.5 }, to: { x: 2.5, y: FEET_Y, z: 1.5 }, drop: 0 }], Date.now());
    assert.equal(unseen.transitions[0]!.status, 'UNKNOWN', '未观测格产生 UNKNOWN，而不是 STALE');

    const verification = revalidated(svc, history.points, SESSION_1);
    assert.equal(verification.verdict, 'BLOCKED');
    assert.equal(verification.openPrefix, 2, '只有 blocker 前两段是当前 OPEN');
    assert.equal(verification.transitions[2]!.status, 'BLOCKED');
    const window = executionWindow(verification, 8, history.points.length - 1);
    assert.equal(window.blocker?.index, 2);
    assert.equal(window.limit, 2, '执行窗口在 blocker 处截断，不含越界段');

    clearRouteRecords();
    const planned = await planRoute.run(ctx, { to: at(5, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(planned.status, 'failed', planned.summary);
    assert.deepEqual(planned.data?.steps, [], '当前证据被 blocker 截断时不给可执行 steps');

    const actionsBefore = adapter.actions.length;
    const blocked = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(blocked.status, 'failed', blocked.summary);
    assert.equal(adapter.actions.length, actionsBefore, '复验拒绝后身体不再启动任何越界段');
    assert.ok(!adapter.actions.some((action) => action.startsWith('dig:')), '不自动清障');
  });
});

test('d) 部分开挖仍阻断；显式 mine_cell 清掉两格后重新观察、重规划并走到端点 [real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
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

    // 只挖掉脚部那一格：头部仍是石头，部分开挖必须在结果与记忆中如实可见。
    const first = validateSkill(mineCell, { xyz: [3, FEET_Y, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
    assert.equal(first.ok, true, JSON.stringify(first));
    const firstMined = await runSkill(ctx, mineCell, first.args);
    assert.equal(firstMined.status, 'succeeded', firstMined.summary);
    observeCells(svc, SESSION_1, [{ pos: at(3, FEET_Y, 0), name: 'minecraft:air' }], nextObservedAt());

    const footCell = svc.session.voxel.cellAt(DIM, 3, FEET_Y, 0);
    const headCell = svc.session.voxel.cellAt(DIM, 3, FEET_Y + 1, 0);
    assert.equal(footCell.observed, true);
    assert.equal(headCell.observed, true);
    if (!footCell.observed || !headCell.observed) assert.fail('both blocker cells must stay observable');
    assert.equal(footCell.evidence.observation.state.name, 'minecraft:air', '已挖的一格如实可见');
    assert.equal(headCell.evidence.observation.state.name, 'minecraft:stone', '未挖的一格仍如实是 blocker');

    const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
    const stillBlocked = revalidated(svc, history.points, SESSION_1);
    assert.equal(stillBlocked.verdict, 'BLOCKED');
    assert.equal(stillBlocked.openPrefix, 2);
    assert.deepEqual(stillBlocked.transitions[2]!.status, 'BLOCKED');
    const blockedBefore = adapter.actions.length;
    const blockedRun = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(blockedRun.status, 'failed', blockedRun.summary);
    assert.equal(adapter.actions.length, blockedBefore, '部分开挖后仍不得越界执行');

    // 显式挖掉头部那一格，再重新观察。
    const second = validateSkill(mineCell, { xyz: [3, FEET_Y + 1, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
    assert.equal(second.ok, true, JSON.stringify(second));
    const secondMined = await runSkill(ctx, mineCell, second.args);
    assert.equal(secondMined.status, 'succeeded', secondMined.summary);
    observeCells(svc, SESSION_1, [{ pos: at(3, FEET_Y + 1, 0), name: 'minecraft:air' }], nextObservedAt());
    assert.ok(adapter.actions.includes('dig:stone'), '清障来自显式 mine_cell');

    const cleared = revalidated(svc, history.points, SESSION_1);
    assert.equal(cleared.verdict, 'OPEN');
    assert.equal(cleared.openPrefix, history.points.length - 1);

    clearRouteRecords();
    const replanned = await planRoute.run(ctx, { to: at(5, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(replanned.status, 'succeeded', replanned.summary);
    assert.equal(replanned.data?.evidenceMode, 'current');

    adapter.actions = [];
    const resumed = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(resumed.status, 'succeeded', resumed.summary);
    assert.equal(Math.floor(adapter.pos.x), 5, '清障后走到选定端点');
    assert.ok(!adapter.actions.some((action) => action.startsWith('dig:')), '重规划后的执行不自动挖');
  });
});

test('e) 无地板支撑的挖空与一格高通道都不得被当成可走路线 [real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const observedAt = Date.now();
    // z=0：起点有地板，x=1..3 是挖空但无地板（y=63 也是空气）。
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
    // z=10：起点两格净空，x=1..4 只有一格高（y=65 是石头天花板）。
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

    const noFloor = adapterAt(0, SESSION_1);
    noFloor.pos = { x: 0.5, y: FEET_Y, z: 0.5 };
    const noFloorCtx = ctxFor(noFloor, svc);
    clearRouteRecords();
    const cavity = await planRoute.run(noFloorCtx, { to: at(3, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(cavity.status, 'failed', cavity.summary);
    assert.deepEqual(cavity.data?.steps, [], '无地板挖空不能生成可执行路线');
    const cavityBoundaries = cavity.data?.boundaries as { status: string; reason?: string }[];
    assert.ok(cavityBoundaries.some((boundary) => boundary.status === 'UNKNOWN' && /no observed standable surface/.test(boundary.reason ?? '')), '无地板列只报告未知边界');
    assert.deepEqual(noFloor.actions, [], '规划不移动');
    const cavityRun = await navigateTo.run(noFloorCtx, { to: at(3, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(cavityRun.status, 'failed', cavityRun.summary);
    assert.deepEqual(noFloor.actions, [], '无地板挖空不启动身体');

    const lowTunnel = adapterAt(0, SESSION_1);
    lowTunnel.pos = { x: 0.5, y: FEET_Y, z: 10.5 };
    const lowTunnelCtx = ctxFor(lowTunnel, svc);
    clearRouteRecords();
    const low = await planRoute.run(lowTunnelCtx, { to: at(4, FEET_Y, 10), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(low.status, 'failed', low.summary);
    assert.deepEqual(low.data?.steps, [], '一格高通道不能生成可执行路线');
    const lowBoundaries = low.data?.boundaries as { status: string; kind: string }[];
    assert.ok(lowBoundaries.some((boundary) => boundary.status === 'BLOCKED'), '一格高通道的边应被判阻塞');
    assert.deepEqual(lowTunnel.actions, [], '规划不移动');
    const lowRun = await navigateTo.run(lowTunnelCtx, { to: at(4, FEET_Y, 10), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(lowRun.status, 'failed', lowRun.summary);
    assert.deepEqual(lowTunnel.actions, [], '一格高通道不启动身体');
  });
});

test('f) 已记录通道开挖后引入落方块/流体：重新观测拒绝把旧 clearance 当作当前可走 [offline Fake; fluid/falling physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    observeCells(svc, SESSION_1, corridorCells(0, 6), nextObservedAt());
    recordDugTraversal(svc, SESSION_1, 5, 6);

    // 先显式标记旧证据陈旧，证明旧的 clearance 不能直接延续为当前可走。
    const staleWrite = svc.markStale(DIM, 'observation_gap');
    if (staleWrite.status !== 'written') assert.fail(`markStale rejected: ${JSON.stringify(staleWrite.reason)}`);
    assert.ok(staleWrite.report.sections.length > 0);
    const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0));
    assert.equal(history.status, 'FOUND');
    assert.equal(history.points.length, 6);
    assert.equal(revalidated(svc, history.points, SESSION_1).verdict, 'STALE', '旧 clearance 在重新观测前不是当前可走');

    // 开挖后重新观测：x=3 落入沙子，x=4 流入水；支撑仍在 y=63。
    observeCells(svc, SESSION_1, corridorCells(0, 6), nextObservedAt());
    observeCells(svc, SESSION_1, [
      { pos: at(3, FEET_Y, 0), name: 'minecraft:sand' },
      { pos: at(4, FEET_Y, 0), name: 'minecraft:water' },
      { pos: at(4, FEET_Y + 1, 0), name: 'minecraft:water' },
    ], nextObservedAt());
    const sand = svc.session.voxel.cellAt(DIM, 3, FEET_Y, 0);
    const water = svc.session.voxel.cellAt(DIM, 4, FEET_Y, 0);
    assert.equal(sand.observed, true);
    assert.equal(water.observed, true);
    if (!sand.observed || !water.observed) assert.fail('changed cells must be observed');
    assert.equal(sand.evidence.observation.state.name, 'minecraft:sand');
    assert.equal(water.evidence.observation.state.name, 'minecraft:water');

    const verification = revalidated(svc, history.points, SESSION_1);
    assert.equal(verification.verdict, 'BLOCKED');
    assert.equal(verification.openPrefix, 2, '落方块/流体之前的段才是当前 OPEN');
    assert.equal(verification.transitions[2]!.status, 'BLOCKED', '落方块格阻止同层步行');
    assert.equal(verification.transitions[3]!.status, 'BLOCKED', '落方块格阻止同层步行');
    assert.equal(verification.transitions[4]!.status, 'BLOCKED', '流体接触不被当作可走');
    assert.match(verification.transitions[4]!.reason ?? '', /hazard/, '流体以 hazard 事实阻断，不是旧 clearance');

    const adapter = adapterAt(0, SESSION_1);
    const ctx = ctxFor(adapter, svc);
    clearRouteRecords();
    const planned = await planRoute.run(ctx, { to: at(5, FEET_Y, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
    assert.equal(planned.status, 'failed', planned.summary);
    assert.deepEqual(planned.data?.steps, []);
    const blocked = await navigateTo.run(ctx, { to: at(5, FEET_Y, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(blocked.status, 'failed', blocked.summary);
    assert.deepEqual(adapter.actions, [], '重新观测后不执行穿沙/穿水段');
  });
});

test('g) 共享记忆重开：部分 traversal/部分开挖只保留已确认前缀，未确认段不写入 [offline Fake]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    observeCells(svc, SESSION_1, corridorCells(0, 6), nextObservedAt());
    // 只实际走到 x=3.5；x=4..6 已挖空但未进入。
    recordDugTraversal(svc, SESSION_1, 3, 6);
    // 部分开挖：x=4 只挖掉脚部，头部仍是石头。
    observeCells(svc, SESSION_1, [
      { pos: at(4, FEET_Y, 0), name: 'minecraft:stone' },
      { pos: at(4, FEET_Y + 1, 0), name: 'minecraft:stone' },
    ], nextObservedAt());
    const adapter = adapterAt(3, SESSION_1);
    adapter.blocks.push({ name: 'stone', pos: at(4, FEET_Y, 0) }, { name: 'stone', pos: at(4, FEET_Y + 1, 0) });
    const ctx = ctxFor(adapter, svc);
    const mined = validateSkill(mineCell, { xyz: [4, FEET_Y, 0], facing: 'E', allowUnknownAdjacent: true }, adapter);
    assert.equal(mined.ok, true, JSON.stringify(mined));
    const result = await runSkill(ctx, mineCell, mined.args);
    assert.equal(result.status, 'succeeded', result.summary);
    observeCells(svc, SESSION_1, [{ pos: at(4, FEET_Y, 0), name: 'minecraft:air' }], nextObservedAt());

    const beforeClose = fragmentPage(svc);
    assert.equal(beforeClose.total, 1);
    assert.equal(beforeClose.items[0]!.polyline.at(-1)!.x, 3.5, '未确认段不进入 fragment');
    assert.equal(traversalPage(svc).total, 3);
  });

  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_2 });
    const fragments = fragmentPage(svc);
    assert.equal(fragments.total, 1, 'fragment 跨 SQLite 重开仍只有已确认前缀');
    assert.equal(fragments.items[0]!.kind, 'dug');
    assert.equal(fragments.items[0]!.polyline.at(-1)!.x, 3.5);
    assert.ok(fragments.items[0]!.polyline.every((point) => point.x <= 3.5), '未确认的 x=4..6 不在 fragment');

    const traversals = traversalPage(svc);
    assert.equal(traversals.total, 3, '只有 3 条实测 traversal');
    assert.deepEqual(traversals.items.map((entry) => entry.to.x), [1, 2, 3]);
    assert.equal(nodePage(svc).total, 4, '拓扑只含已确认 4 个节点');

    assert.equal(historyRoute(svc, at(0, FEET_Y, 0), at(3, FEET_Y, 0)).status, 'FOUND');
    assert.equal(historyRoute(svc, at(0, FEET_Y, 0), at(5, FEET_Y, 0)).status, 'ENDPOINT_NOT_RECORDED', '未确认段不是历史端点');

    const foot = svc.session.voxel.cellAt(DIM, 4, FEET_Y, 0);
    const head = svc.session.voxel.cellAt(DIM, 4, FEET_Y + 1, 0);
    assert.equal(foot.observed, true);
    assert.equal(head.observed, true);
    if (!foot.observed || !head.observed) assert.fail('partially excavated cells must persist');
    assert.equal(foot.evidence.observation.state.name, 'minecraft:air', '已挖的脚部格跨重开仍是空气');
    assert.equal(head.evidence.observation.state.name, 'minecraft:stone', '未挖的头部格跨重开仍是石头');
    assert.equal(foot.evidence.freshness, 'STALE', '重开后证据仍是历史 STALE，不是当前可走');
  });
});

test('h) 两个独立 traversal 片段经共享 seam 节点连接后复用到更深落点（含 DROP），复验通过后执行下降 [offline Fake; real physics NOT_RUN]', async (t) => {
  const db = tempDb(t);
  await withCleanSession(db, async (svc) => {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    // 上层 x=0..2 脚高 64；x=3..5 落到脚高 62（支撑 y=61）。
    observeCells(svc, SESSION_1, [0, 1, 2].flatMap((x) => [
      { pos: at(x, 63, 0), name: 'minecraft:stone' },
      { pos: at(x, FEET_Y, 0), name: 'minecraft:air' },
      { pos: at(x, FEET_Y + 1, 0), name: 'minecraft:air' },
    ]), nextObservedAt());
    observeCells(svc, SESSION_1, [3, 4, 5].flatMap((x) => [
      { pos: at(x, 61, 0), name: 'minecraft:stone' },
      { pos: at(x, 62, 0), name: 'minecraft:air' },
      { pos: at(x, 63, 0), name: 'minecraft:air' },
      { pos: at(x, FEET_Y, 0), name: 'minecraft:air' },
      { pos: at(x, FEET_Y + 1, 0), name: 'minecraft:air' },
    ]), nextObservedAt());

    const path = [at(0.5, 64, 0.5), at(1.5, 64, 0.5), at(2.5, 64, 0.5), at(3.5, 62, 0.5), at(4.5, 62, 0.5), at(5.5, 62, 0.5)];
    const dug = [0, 1, 2, 3, 4, 5].map((x) => ({ pos: at(x, 62, 0), name: 'stone', ts: Date.now() }));
    // 两个独立 TraversalRecorder 写入：第一段 0.5→2.5，第二段从同一 seam 2.5
    // 继续到下层。它们各写一个 fragment，拓扑由同一 cell 节点连接；不是单条
    // 长轨迹被内部拆分。
    let clock = Date.now();
    const first = new TraversalRecorder(svc, () => ++clock);
    for (const point of path.slice(0, 3)) first.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: point, dug });
    first.flush();
    const second = new TraversalRecorder(svc, () => ++clock);
    for (const point of path.slice(2)) second.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: point, dug });
    second.flush();

    const fragments = fragmentPage(svc);
    assert.equal(fragments.total, 2, '该场景确实是两个独立 fragment，而不是单条轨迹');
    assert.deepEqual(fragments.items.map((fragment) => fragment.polyline.length).sort(), [3, 4]);
    assert.ok(fragments.items.some((fragment) => fragment.polyline[0]!.x === 0.5 && fragment.polyline.at(-1)!.x === 2.5));
    assert.ok(fragments.items.some((fragment) => fragment.polyline[0]!.x === 2.5 && fragment.polyline.at(-1)!.x === 5.5));
    assert.equal(traversalPage(svc).total, 5, '两个 fragment 合计 5 条确认段');

    const history = historyRoute(svc, at(0, FEET_Y, 0), at(5, 62, 0));
    assert.equal(history.status, 'FOUND', '两个 fragment 经 seam 节点连接后跨 DROP 仍可查询');
    assert.equal(history.points.length, 6);
    assert.equal(history.executable, false);
    assert.equal(history.currentPassability, 'UNKNOWN');

    const adapter = new ExactDropWorld();
    adapter.pos = { x: 0.5, y: FEET_Y, z: 0.5 };
    adapter.worldId = WORLD;
    adapter.sessionId = SESSION_1;
    adapter.dim = DIM;
    // 物理世界里只移除下层身体格；y=61 仍默认是石头支撑。
    for (const x of [3, 4, 5]) {
      adapter.removed.add(`${x},62,0`);
      adapter.removed.add(`${x},63,0`);
    }
    const ctx = ctxFor(adapter, svc);
    // 离线落点接口：落点与支撑来自本夹具显式几何（现实由 Vision/assess_landings 提供）。
    const landing: LandingOption = {
      target: { x: 3.5, y: 62, z: 0.5 },
      support: { pos: { x: 3, y: 61, z: 0 }, name: 'stone' },
      surface: 'ground', surfaceY: 62, drop: 2, horizontalDistance: 1,
      clearance: 'clear', corridor: 'clear', approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
      receipt: {
        worldId: WORLD, sessionId: SESSION_1, dimension: DIM, observationId: 0,
        at: Date.now(), from: { ...adapter.pos }, onGround: true,
      },
    };
    ctx.senses.landingOptions = () => [{
      ...landing,
      receipt: { ...landing.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId },
    }];
    clearRouteRecords();
    const memory = await planRoute.run(ctx, { to: at(5, 62, 0), mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
    assert.equal(memory.status, 'succeeded', memory.summary);
    const legs = memory.data?.legs as { transition: string }[];
    assert.ok(legs.some((leg) => leg.transition === 'drop'), 'DROP 边由历史几何如实带出');
    const endpoint = memory.data?.selectedEndpoint as Vec3Like;
    assert.equal(Math.floor(endpoint.x), 5);
    assert.equal(endpoint.y, 62);
    assert.equal(adapter.actions.length, 0, '历史查询不移动');

    const verified = revalidated(svc, history.points, SESSION_1);
    assert.equal(verified.verdict, 'OPEN', '当前证据复验通过后才执行');
    const drop = verified.transitions.find((entry) => entry.transition.kind === 'drop');
    assert.equal(drop?.status, 'OPEN');
    assert.equal(drop?.transition.drop, 2);

    clearRouteRecords();
    const executed = await navigateTo.run(ctx, { to: at(5, 62, 0), allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false });
    assert.equal(executed.status, 'succeeded', executed.summary);
    assert.equal(Math.floor(adapter.pos.x), 5, '到达更深端点');
    assert.equal(adapter.pos.y, 62, '落在实际下层脚高');
    const transitions = executed.data?.transitions as { kind: string; drop: number }[];
    assert.equal(transitions.find((entry) => entry.kind === 'drop')?.drop, 2);
    assert.ok(!adapter.actions.some((action) => action.startsWith('dig:')), '复用历史路线不自动挖');
  });
});
