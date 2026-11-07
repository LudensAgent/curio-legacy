/**
 * B2/B3/B4/B5 证据闭环验收（契约 §4.3/§4.5/§8.1；Curio 计划 v2 B2–B5）：
 *
 * - 只有库终态确认的段才写 `saveFragment(kind:'walked')` + `addTraversal`，`from`
 *   取库实际发出的 `ExecutableMove.from`，`to`/时间取终态 trace；
 * - 无确认段不写；记忆写入只追加历史证据，不改变已确认的身体结果；
 * - `markTraversed`/`markModified` 只接受当前可信维度、真实观测/动作确认；
 * - 写入成功只是 `pending`（内存接受），`saved` 只可能来自库的 checkpoint 报告；
 * - 订阅者抛错时写入已经提交，报告失败按 `committed:true` 保留。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MemoryHostCapabilities, PathFragment } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import { clearRouteRecords, planRoute, walkPath } from '../src/skills/movement/index.ts';
import type { HostCapabilityReport } from '../src/spatial/capabilities.ts';
import type { SharedSpatialSession, WalkCorridorSegment } from '../src/spatial/shared-session.ts';
import { SharedSpatialSession as SharedSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'evidence-world';
const DIM = 'overworld';
const SESSION = 'evidence-session';

/** 真实共享会话 + 一条平坦干燥走廊（支撑 y=63，脚位 y=64）。 */
async function openEvidenceSession(): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'walk-evidence-'));
  const svc = await SharedSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  const observedAt = Date.now();
  let sequence = 0;
  const cells: BlockObservation[] = [];
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    cells.push({
      name: y === 63 ? 'minecraft:stone' : 'minecraft:air',
      properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM,
      source: 'vision', stateComplete: true, observedAt, observationId: ++sequence,
      pos: { x, y, z },
    });
  }
  svc.observe(cells);
  return { svc, dir };
}

async function closeEvidenceSession(svc: SharedSpatialSession, dir: string): Promise<void> {
  const shutdown = await svc.shutdown();
  assert.equal(shutdown.close?.completed, true);
  rmSync(dir, { recursive: true, force: true });
}

/** 按住 forward 时沿当前朝向每帧小步移动的测试身体（与 walk_path 契约测试一致）。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const k of Object.keys(this.control)) this.control[k] = false; },
      look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
      entity: this.walkEntity,
    };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({ position: { ...this.walkEntity.position }, velocity: { ...this.walkEntity.velocity }, onGround: true, isInWater: false });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

function walkingAdapter(): WalkingAdapter {
  const w = new WalkingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

const walk = (to: { x: number; y: number; z: number }) => ({
  to, mode: 'walk' as const, source: 'search' as const, arrival: { kind: 'exact' as const },
});

/** 只记录调用、不写库的共享会话替身：用于验证“无确认段不写”与调用形状。 */
function recordingSpatial(svc: SharedSpatialSession) {
  const calls: { fragmentId: string; segments: unknown[] }[] = [];
  const spatial = Object.create(svc) as SharedSpatialSession;
  spatial.recordWalkCorridor = (input) => {
    calls.push({ fragmentId: input.fragment.id, segments: [...input.segments] });
    return { status: 'written', fragmentId: input.fragment.id, traversalIds: [], stancesMarked: 0, deliveryError: null };
  };
  return { spatial, calls };
}

test('已确认段写 traversal 历史证据：from 取库实际请求，to 取终态 trace，memoryWrite=pending', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.memoryWrite, 'pending', '内存接受只能是 pending，不能冒充 saved');

  const memory = result.data?.memory as {
    status: string; fragmentId: string; traversalIds: string[]; stancesMarked: number;
  };
  assert.equal(memory.status, 'written');
  assert.equal(memory.traversalIds.length, 2, '确认了几段就写几条 traversal');

  const traversals = svc.query({ kind: 'traversals', fragmentId: memory.fragmentId });
  assert.equal(traversals.status, 'ok');
  assert.equal(traversals.total, 2);
  const items = traversals.data?.kind === 'traversals' ? traversals.data.items : [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  assert.equal(items[0]!.from.x, 0.5, '首段 from 是实测起点');
  assert.equal(near(items[1]!.from.x, 1.4), true, '后续段的 from 是实测位置，不是计划点 1.5');
  assert.equal(items.every((item) => item.from.z === 0.5 && item.from.y === 64), true);
  assert.deepEqual(items[0]!.to, items[1]!.from, '前一段的实测终点就是后一段的实测起点');
  assert.equal(Math.abs(items[1]!.to.x - 2.5) <= 0.2, true, 'to 是终态 trace 的实测位置，不是计划点');
  assert.equal(items.every((item) => item.to.z === 0.5 && item.to.y === 64), true);
  assert.equal(items.every((item) => item.source === 'confirmed_walk_path'), true);

  const fragment = svc.session.history.getFragment(memory.fragmentId);
  assert.ok(fragment !== null, 'fragment 必须已保存');
  assert.equal(fragment.kind, 'walked');
  assert.equal(fragment.geometrySource, 'traversal');
  // 几何必须是实测经过，而不是计划点：首点是首段实际出发位置，其余是终态 trace。
  assert.equal(fragment.polyline.length, 3, '确认段数 + 1 个实测点');
  assert.deepEqual(fragment.polyline[0], items[0]!.from, '首点是首段实际出发位置');
  assert.deepEqual(fragment.polyline.slice(1), items.map((item) => item.to), '其余是确认段的实测终点');
  assert.equal(Math.abs(fragment.polyline[1]!.x - 1.5) > 0.01, true, '中间点不是计划点');
  assert.equal(fragment.deepestY, Math.min(...fragment.polyline.map((p) => p.y)));

  // B3：每个确认段的实测终点都标为 traversed；未到达的位置不得标记。
  assert.equal(svc.session.voxel.historyAt(DIM, 1, 64, 0).traversed, true);
  assert.equal(svc.session.voxel.historyAt(DIM, 2, 64, 0).traversed, true);
  assert.equal(svc.session.voxel.historyAt(DIM, 3, 64, 0).traversed, false);
});

test('无确认段不写记忆：起点漂移 INVALIDATED 时没有 fragment/traversal/stance', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.pos = { ...w.pos, x: w.pos.x + 0.2 };

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal(result.data?.confirmedSegments, 0);
  assert.equal(result.data?.memoryWrite, null, '没有确认段就没有记忆写入事实');
  assert.deepEqual(result.data?.memory, { status: 'not_recorded', reason: 'no_confirmed_segment', traversalIds: [] });
  assert.equal(svc.query({ kind: 'fragments' }).total, 0, '无确认段不得保存历史几何');
  assert.equal(svc.session.voxel.historyAt(DIM, 0, 64, 0).traversed, false);
});

test('walk_path 只把确认段交给写入入口；库拒绝执行时不调用', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const { spatial, calls } = recordingSpatial(svc);
  const ctx = { ...makeCtx(w), spatial };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(calls.length, 1, '一次执行只提交一条通道证据');
  assert.equal(calls[0]!.segments.length, 2);

  // 第二次 routeId 已被消费：入口拒绝时不产生新的记忆写入。
  const second = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(second.data?.outcome, 'INVALIDATED');
  assert.equal(calls.length, 1, '拒绝执行不等于已走过的证据；不得补写');
});

test('markTraversed/markModified 只接受当前可信维度与真实确认，写后同步转发报告', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const reports: unknown[] = [];
    svc.attach({ receiver: (report) => { reports.push(report); }, cancel: () => {} });

    const traversed = svc.markTraversed(DIM, { x: 1, y: 64, z: 0 });
    assert.equal(traversed.status, 'written');
    if (traversed.status !== 'written') return;
    assert.equal(traversed.deliveryError, null);
    assert.equal(traversed.report.sections.length, 1);
    assert.equal(reports.length, 1, '写入后的报告必须在下一控制步前转发给活跃执行器');

    const modified = svc.markModified(DIM, { x: 2, y: 63, z: 0 }, 'act-1');
    assert.equal(modified.status, 'written');
    assert.equal(svc.session.voxel.historyAt(DIM, 2, 63, 0).modified, true, 'markModified 需要 actionId');
    assert.equal(svc.session.voxel.historyAt(DIM, 2, 63, 0).traversed, false, '确认动作不等于站位');
    assert.equal(svc.session.voxel.historyAt(DIM, 1, 64, 0).traversed, true);

    const foreign = svc.markTraversed('nether', { x: 1, y: 64, z: 0 });
    assert.equal(foreign.status, 'rejected');
    if (foreign.status !== 'rejected') return;
    assert.equal(foreign.reason.kind, 'scope_mismatch');
    assert.equal(svc.session.voxel.historyAt('nether', 1, 64, 0).traversed, false, '其他维度不得写入');

    svc.setPaused(true);
    const paused = svc.markTraversed(DIM, { x: 3, y: 64, z: 0 });
    assert.equal(paused.status, 'rejected');
    if (paused.status !== 'rejected') return;
    assert.equal(paused.reason.kind, 'not_ready');
    assert.equal(svc.session.voxel.historyAt(DIM, 3, 64, 0).traversed, false);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('记忆写入失败不改写身体结果：仍报 ARRIVED，单独报告 failed 阶段', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const spatial = Object.create(svc) as SharedSpatialSession;
  spatial.recordWalkCorridor = (input) => ({
    status: 'failed', stage: 'add_traversal', message: 'capacity exceeded',
    fragmentId: input.fragment.id, traversalIds: ['prefix-1'],
  });
  const ctx = { ...makeCtx(w), spatial };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.data?.outcome, 'ARRIVED', '保存失败不得把已发生的身体效果改成未发生');
  assert.equal(result.data?.confirmed, true);
  assert.equal(result.data?.memoryWrite, 'failed', 'saved/pending 都不能冒充：写入失败单独报告');
  assert.deepEqual(result.data?.memory, {
    status: 'failed', stage: 'add_traversal', message: 'capacity exceeded',
    fragmentId: (result.data?.memory as { fragmentId: string }).fragmentId,
    traversalIds: ['prefix-1'],
  }, '失败阶段与已写入前缀如实保留');
  const position = result.data?.position as { x: number; y: number; z: number } | null;
  assert.ok(position !== null && [position.x, position.y, position.z].every(Number.isFinite), '身体结果保留实测位置');
  assert.ok(Math.abs(position.x - 2.5) <= 0.3, `已确认到达的实测位置仍在目标附近：x=${position.x}`);
});

test('订阅者抛错不会回滚写入：结果保留 committed:true 的转发失败', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    svc.attach({ receiver: () => { throw new Error('verifier exploded'); }, cancel: () => {} });
    const result = svc.markTraversed(DIM, { x: 4, y: 64, z: 0 });
    assert.equal(result.status, 'written', '写入已经提交，不能因为回调失败改写成拒绝');
    if (result.status !== 'written') return;
    assert.equal(result.deliveryError?.committed, true);
    assert.equal((result.deliveryError?.error as Error).message, 'verifier exploded');
    assert.equal(svc.session.voxel.historyAt(DIM, 4, 64, 0).traversed, true, '证据已写入，失败只属于报告转发');
    assert.equal(svc.lastReceiverFailure()?.applied, 1);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

/** 受控能力报告：独立副本，不污染共享会话启动时记录的真实报告。 */
function forcedReport(library: MemoryHostCapabilities, overrides: Partial<{ [K in keyof MemoryHostCapabilities['memory']]: boolean }>): HostCapabilityReport {
  return {
    owner: 'host_composed', contract: library.contract,
    library: { ...library, memory: { ...library.memory, ...overrides } },
    host: { checkpoint: true, flush: true, close: true },
  };
}

/** 两段实测通道：第一段 0.5→1.4，第二段 1.4→2.4；第二段不确认，用于 PARTIAL 用例。 */
const SEGMENTS: WalkCorridorSegment[] = [
  {
    id: 'seg-1', fragmentId: 'frag-partial', from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.4, y: 64, z: 0.5 },
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: 1000, source: 'confirmed_walk_path',
    executionId: 'exec_test', mode: 'walk',
  },
];
const FRAGMENT: PathFragment = {
  id: 'frag-partial', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [],
  polyline: [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.4, y: 64, z: 0.5 }],
  geometrySource: 'traversal', deepestY: 64, createdAt: 1000, lastUsedAt: 1000, uses: 1,
};

test('PARTIAL 只写确认段，几何用实测位置而非计划坐标', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const outcome = svc.recordWalkCorridor({ fragment: FRAGMENT, segments: SEGMENTS });
    assert.equal(outcome.status, 'written');
    const fragment = svc.session.history.getFragment('frag-partial');
    assert.ok(fragment !== null);
    assert.deepEqual(fragment.polyline, [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.4, y: 64, z: 0.5 }], '实测几何，不是计划点 1.5');
    const traversals = svc.query({ kind: 'traversals', fragmentId: 'frag-partial' });
    assert.equal(traversals.total, 1, '确认一段只写一条 traversal');
    assert.equal(svc.session.voxel.historyAt(DIM, 1, 64, 0).traversed, true);
    assert.equal(svc.session.voxel.historyAt(DIM, 2, 64, 0).traversed, false, '未确认段不得补标记');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('旧会话证据被拒绝：saveFragment/addTraversal/recordWalkCorridor 不写库', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: `${SESSION}-new` });
    // fragment 没有 session 字段（契约 §4.4）；会话归属由 traversal/段校验。
    assert.equal(svc.saveFragment(FRAGMENT).status, 'written');
    const oldTraversal = svc.addTraversal({ ...SEGMENTS[0]!, fragmentId: 'frag-partial' });
    assert.equal(oldTraversal.status, 'rejected', '旧会话 traversal 不得入库');
    if (oldTraversal.status === 'rejected') assert.equal(oldTraversal.reason.kind, 'session_mismatch');

    const outcome = svc.recordWalkCorridor({ fragment: FRAGMENT, segments: SEGMENTS });
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.equal(outcome.stage, 'session_mismatch');
    assert.equal(svc.query({ kind: 'traversals' }).total, 0);
    assert.equal(svc.session.voxel.historyAt(DIM, 1, 64, 0).traversed, false);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('能力 false：ingest 的 recordNode/upsertEdge 等抛错且不调用库', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const recorded = svc.capabilities();
    const overrides: Partial<Record<keyof typeof recorded.library.memory, boolean>> = {
      recordNode: false, upsertEdge: false, savePortalEdge: false,
    };
    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport =
      forcedReport(recorded.library, overrides);
    const rejected = () => {
      const last = svc.lastCapabilityRejection();
      assert.equal(last?.kind, 'capability_unavailable');
      return last?.kind === 'capability_unavailable' ? last.method : null;
    };
    assert.throws(() => svc.ingest.recordNode('base', { x: 0, y: 64, z: 0 }, undefined, { dim: DIM }), /memory\.recordNode=false/);
    assert.equal(rejected(), 'recordNode');
    assert.throws(() => svc.ingest.upsertEdge({ id: 'e1', from: 'n1', to: 'n2', type: 'HORIZONTAL', basis: 'candidate' }), /memory\.upsertEdge=false/);
    assert.equal(rejected(), 'upsertEdge');
    assert.throws(() => svc.ingest.savePortalEdge({ id: 'p1', from: 'n1', to: 'n2' }, []), /memory\.savePortalEdge=false/);
    assert.equal(rejected(), 'savePortalEdge');
    // 契约 §2.3 没有 addPortalTraversal 键；该写按 savePortalEdge 能力门禁。
    assert.throws(() => svc.ingest.addPortalTraversal('p1', {
      id: 't1', edgeId: 'p1', direction: 'forward', sessionId: SESSION, observedAt: 1, observationIds: [], source: 'test',
    }), /memory\.savePortalEdge=false/);
    assert.equal(rejected(), 'savePortalEdge');
    // observeBatch 投影与类上同一语义：不抛错、空报告 + 可读拒绝。
    const empty = svc.ingest.observeBatch({ observations: [], unobserved: [] });
    assert.deepEqual(empty.sections, []);
    assert.equal(svc.query({ kind: 'nodes' }).total, 0, '能力 false 时 recordNode 未被调用');
    assert.equal(svc.query({ kind: 'edges' }).total, 0, '能力 false 时 upsertEdge 未被调用');
    assert.equal(svc.query({ kind: 'portals' }).total, 0, '能力 false 时传送边/穿越未被调用');
    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = recorded;
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('observeBatch 订阅者异常：写入已提交，调用者看到 committed:true', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    let notified = 0;
    svc.attach({ receiver: () => { throw new Error('executor down'); }, cancel: () => {} });
    // 第二个订阅者通过会话自身的 receiver 之外的 attach 无法并存（唯一 owner），
    // 因此这里验证：write 已提交 + 调用者得到 committed 事实，不重试写入。
    const report = svc.observeBatch({
      observations: [{
        worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + 5, sequence: 100_000,
        source: 'vision', evidence: 'seen', stateComplete: true,
        state: { name: 'minecraft:stone', properties: {} }, pos: { x: 0, y: 62, z: 0 },
      }],
      unobserved: [],
    });
    notified += report.sections.length;
    assert.ok(report.sections.length > 0, '报告返回给调用者');
    assert.equal(svc.session.voxel.cellAt(DIM, 0, 62, 0).observed, true, '写入已经提交，不回滚');
    const delivery = svc.lastDeliveryFailure();
    assert.equal(delivery?.committed, true);
    assert.equal((delivery?.error as Error).message, 'executor down');
    assert.equal(svc.lastReceiverFailure()?.applied, report.sections.length);
    assert.ok(notified > 0);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});
