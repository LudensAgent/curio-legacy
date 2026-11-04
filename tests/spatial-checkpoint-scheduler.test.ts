/**
 * 常规 checkpoint 调度的行为验收：用可控的 setInterval 与显式 promise 驱动
 * startSpatialCheckpointScheduler，证明周期触发、跳过、单次在途、dirty 保留、
 * 失败可见/下周期重试、stop 幂等且不重启、最终关停仍由宿主负责；并用真实
 * SQLite 证明常规周期保存本身即可落盘，不依赖宿主最终 checkpoint。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialCheckpointResult, SpatialPersistenceState } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import {
  DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
  startSpatialCheckpointScheduler,
  type SpatialCheckpointReport,
  type SpatialCheckpointSource,
} from '../src/spatial/checkpoint-scheduler.ts';

type TestSource = SpatialCheckpointSource & {
  shutdown(): Promise<void>;
  close(): Promise<void>;
};

const WORLD = 'world-a';

function persistenceState(overrides: Partial<SpatialPersistenceState> = {}): SpatialPersistenceState {
  return {
    lifecycle: 'open',
    voxelRevision: 0,
    fragmentRevision: 0,
    topologyRevision: 0,
    confirmedVoxelRevision: 0,
    confirmedFragmentRevision: 0,
    confirmedTopologyRevision: 0,
    dirty: false,
    baselineCheckpointId: null,
    voxelBaselineCheckpointId: null,
    lastConfirmedCheckpointId: null,
    inFlightCheckpointId: null,
    unconfirmedCheckpointId: null,
    lastError: null,
    ...overrides,
  };
}

function checkpoint(id: string, revisions = { voxel: 5, fragment: 4, topology: 3 }): SpatialCheckpointResult {
  return {
    checkpointId: id,
    worldId: WORLD,
    voxelRevision: revisions.voxel,
    fragmentRevision: revisions.fragment,
    topologyRevision: revisions.topology,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 可控的公开会话表面：状态、单 I/O 门、checkpoint 处理器都在测试里读写。 */
function makeSpatial() {
  const session = { busy: false };
  const service = { closing: false };
  let state = persistenceState();
  let calls = 0;
  let shutdowns = 0;
  let closes = 0;
  let handler: () => Promise<SpatialCheckpointResult> = async () => {
    throw new Error('test checkpoint handler not configured');
  };
  const spatial: TestSource = {
    get closing() { return service.closing; },
    session,
    checkpoint: () => { calls += 1; return handler(); },
    getPersistenceState: () => state,
    shutdown: async () => { shutdowns += 1; },
    close: async () => { closes += 1; },
  };
  return {
    spatial,
    session,
    service,
    get calls() { return calls; },
    get shutdowns() { return shutdowns; },
    get closes() { return closes; },
    get state() { return state; },
    setState(next: Partial<SpatialPersistenceState>) { state = { ...state, ...next }; },
    onCheckpoint(next: () => Promise<SpatialCheckpointResult>) { handler = next; },
  };
}

function begin(t: TestContext, spatial: SpatialCheckpointSource, intervalMs?: number) {
  const reports: SpatialCheckpointReport[] = [];
  const stop = intervalMs === undefined
    ? startSpatialCheckpointScheduler(spatial, (report) => reports.push(report))
    : startSpatialCheckpointScheduler(spatial, (report) => reports.push(report), intervalMs);
  t.after(stop);
  return { reports, stop };
}

test('默认每 30 秒触发一次 checkpoint；保存后 clean 则跳过', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true, voxelRevision: 5, fragmentRevision: 4, topologyRevision: 3 });
  const saved = checkpoint('cp-1');
  fx.onCheckpoint(async () => {
    fx.setState({
      dirty: false, confirmedVoxelRevision: 5, confirmedFragmentRevision: 4, confirmedTopologyRevision: 3,
      lastConfirmedCheckpointId: 'cp-1',
    });
    return saved;
  });
  const { reports } = begin(t, fx.spatial);

  t.mock.timers.tick(DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS - 1);
  await flush();
  assert.equal(fx.calls, 0, '未到周期不应保存');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(fx.calls, 1);
  assert.equal(reports.length, 1);
  const report = reports[0];
  assert.ok(report && report.status === 'saved');
  assert.deepEqual(report.checkpoint, saved);
  assert.equal(report.remainingDirty, false);
  assert.equal(report.state.lastConfirmedCheckpointId, 'cp-1');

  t.mock.timers.tick(DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS);
  await flush();
  assert.equal(fx.calls, 1, 'clean 状态不应产生新保存');
  assert.equal(reports.length, 1, 'clean 跳过不产生汇报');
});

test('clean 状态每个周期都跳过', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  const { reports } = begin(t, fx.spatial, 1000);
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(fx.calls, 0);
  assert.equal(reports.length, 0);
});

test('上一次保存未落定时不再发起或排队新保存', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true, voxelRevision: 5, fragmentRevision: 4, topologyRevision: 3 });
  const pending = deferred<SpatialCheckpointResult>();
  fx.onCheckpoint(() => pending.promise);
  const { reports } = begin(t, fx.spatial, 1000);

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1);

  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1, '在途期间不应并发或排队');
  assert.equal(reports.length, 0);

  fx.setState({
    dirty: false, confirmedVoxelRevision: 5, confirmedFragmentRevision: 4, confirmedTopologyRevision: 3,
    lastConfirmedCheckpointId: 'cp-1',
  });
  pending.resolve(checkpoint('cp-1'));
  await flush();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'saved');
});

test('保存期间的新观测保留为 dirty：汇报已保存批次和真实剩余状态', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true, voxelRevision: 10, fragmentRevision: 20, topologyRevision: 30 });
  const pending = deferred<SpatialCheckpointResult>();
  fx.onCheckpoint(() => pending.promise);
  const { reports } = begin(t, fx.spatial, 1000);

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1);

  // 保存期间又写入新观测：当前版本前进，但确认版本只到本次批次。
  fx.setState({
    voxelRevision: 11, fragmentRevision: 21, topologyRevision: 31, dirty: true,
    confirmedVoxelRevision: 10, confirmedFragmentRevision: 20, confirmedTopologyRevision: 30,
    lastConfirmedCheckpointId: 'cp-2',
  });
  pending.resolve(checkpoint('cp-2', { voxel: 10, fragment: 20, topology: 30 }));
  await flush();

  const report = reports[0];
  assert.ok(report && report.status === 'saved');
  assert.deepEqual(report.checkpoint, checkpoint('cp-2', { voxel: 10, fragment: 20, topology: 30 }));
  assert.equal(report.remainingDirty, true, '已保存批次不等于最新地图已 clean');
  assert.equal(report.state.voxelRevision, 11);
  assert.equal(report.state.confirmedVoxelRevision, 10);
  assert.equal(report.state.dirty, true);

  // 调度器没有替库清 dirty：下个周期会继续保存。
  fx.onCheckpoint(async () => checkpoint('cp-3', { voxel: 11, fragment: 21, topology: 31 }));
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 2);
});

test('失败经 reporter 给出结构化事实，状态不变，下个周期才重试', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true, voxelRevision: 7, fragmentRevision: 8, topologyRevision: 9 });
  fx.onCheckpoint(async () => {
    if (fx.calls === 1) throw new PersistenceError('sql', 'disk full');
    const saved = checkpoint('cp-4', { voxel: 7, fragment: 8, topology: 9 });
    fx.setState({
      dirty: false, confirmedVoxelRevision: 7, confirmedFragmentRevision: 8, confirmedTopologyRevision: 9,
      lastConfirmedCheckpointId: 'cp-4',
    });
    return saved;
  });
  const { reports } = begin(t, fx.spatial, 1000);

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1);
  const failed = reports[0];
  assert.ok(failed && failed.status === 'failed');
  assert.deepEqual(failed.error, { kind: 'sql', name: 'PersistenceError', message: 'disk full' });
  assert.equal(failed.remainingDirty, true);
  assert.equal(failed.state.dirty, true);
  assert.equal(failed.state.voxelRevision, 7, '失败不得改写当前版本');
  assert.equal(failed.state.lastConfirmedCheckpointId, null, '失败不得自行确认');

  await flush();
  assert.equal(fx.calls, 1, '失败后不紧循环重试');

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 2);
  assert.equal(reports.length, 2);
  const retried = reports[1];
  assert.ok(retried && retried.status === 'saved');
  assert.equal(retried.remainingDirty, false);
});

test('已知 busy、在途或非 open 状态一律跳过', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true });
  fx.onCheckpoint(async () => {
    const saved = checkpoint('cp-5');
    fx.setState({ dirty: false, lastConfirmedCheckpointId: 'cp-5' });
    return saved;
  });
  const { reports } = begin(t, fx.spatial, 1000);

  fx.session.busy = true;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 0, '单 I/O 门忙时不保存');

  fx.session.busy = false;
  fx.service.closing = true;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 0, '服务已开始关停时跳过（底层 lifecycle 尚未变更）');

  fx.service.closing = false;
  fx.setState({ inFlightCheckpointId: 'other-cp' });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 0, '已知在途 checkpoint 时跳过');

  fx.setState({ inFlightCheckpointId: null, lifecycle: 'closing' });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 0, 'closing 时跳过');

  fx.setState({ lifecycle: 'closed' });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 0, 'closed 时跳过');

  fx.setState({ lifecycle: 'open' });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1, '恢复 open 后周期继续生效');
  assert.equal(reports.length, 1);
});

test('stop 同步停止未来触发、幂等，不取消在途保存也不重启', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true });
  const pending = deferred<SpatialCheckpointResult>();
  fx.onCheckpoint(() => pending.promise);
  const { reports, stop } = begin(t, fx.spatial, 1000);

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(fx.calls, 1);

  stop();
  stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fx.calls, 1, 'stop 后不再触发');

  // 已接受的保存在 stop 后完成：照实汇报，但不能重启调度。
  fx.setState({ dirty: false, lastConfirmedCheckpointId: 'cp-6' });
  pending.resolve(checkpoint('cp-6'));
  await flush();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'saved');

  t.mock.timers.tick(5000);
  await flush();
  assert.equal(fx.calls, 1, '完成回调不得重启调度');
});

test('stop 不关闭会话，最终 shutdown/close 仍由宿主负责', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fx = makeSpatial();
  fx.setState({ dirty: true });
  fx.onCheckpoint(async () => {
    const saved = checkpoint('cp-7');
    fx.setState({ dirty: false, lastConfirmedCheckpointId: 'cp-7' });
    return saved;
  });
  const { stop } = begin(t, fx.spatial, 1000);

  t.mock.timers.tick(1000);
  await flush();
  stop();
  await flush();
  assert.equal(fx.shutdowns, 0, '调度器不执行最终 shutdown');
  assert.equal(fx.closes, 0, '调度器不直接 close 会话');

  await fx.spatial.shutdown();
  assert.equal(fx.shutdowns, 1, '最终关停由宿主显式调用');
});

test('公开的 interval 参数只接受 1..2147483647 的整数毫秒', () => {
  const fx = makeSpatial();
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, 0), RangeError);
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, -1), RangeError);
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, 0.5), RangeError);
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, Number.NaN), RangeError);
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => startSpatialCheckpointScheduler(fx.spatial, () => {}, 2_147_483_648), RangeError);
  // 普通值与 Node 允许的最大整数毫秒仍可正常启动/停止。
  const stopMax = startSpatialCheckpointScheduler(fx.spatial, () => {}, 2_147_483_647);
  stopMax();
});

test('真实 SQLite：常规周期保存独立于宿主最终关停，重开恢复原始观测', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-scheduler-'));
  const dbPath = join(dir, 'memory.db');
  const worldId = `periodic-checkpoint-${process.pid}-${Date.now()}`;
  const dim = 'overworld';
  const sessionId = 'periodic-session';
  const observedAt = 1_700_000_123_456;
  const pos = { x: 31, y: 62, z: -17 };
  let sessionClosed = false;
  let reopenedClosed = false;
  try {
    const spatial = await SharedSpatialSession.open({ worldId, databasePath: dbPath, now: () => observedAt, timeoutMs: 5000 });
    try {
      spatial.beginSession({ worldId, dim, sessionId });
      const observed = spatial.observe([{
        name: 'minecraft:emerald_block',
        properties: {},
        pos,
        worldId,
        sessionId,
        dimension: dim,
        observationId: 1,
        observedAt,
        source: 'vision',
        stateComplete: true,
      }]);
      assert.ok(observed.sections.length > 0, '真实观测应写入内存地图');
      assert.equal(spatial.getPersistenceState().dirty, true);

      const firstSave = deferred<Extract<SpatialCheckpointReport, { status: 'saved' }>>();
      const timer = setTimeout(() => firstSave.reject(new Error('周期保存未在 5000ms 内完成')), 5000);
      const stop = startSpatialCheckpointScheduler(spatial, (report) => {
        if (report.status === 'failed') {
          firstSave.reject(new Error(`周期保存失败：${JSON.stringify(report.error)}`));
          return;
        }
        firstSave.resolve(report);
      }, 10);
      let saved: Extract<SpatialCheckpointReport, { status: 'saved' }> | undefined;
      try {
        saved = await firstSave.promise;
      } finally {
        clearTimeout(timer);
        stop();
      }
      assert.ok(saved !== undefined, '必须收到真实 saved 汇报');
      assert.equal(saved.checkpoint.worldId, worldId);
      assert.equal(saved.remainingDirty, false);
      assert.equal(saved.state.dirty, false);

      // 直接关底层会话：不调用宿主 shutdown 的最终 checkpoint，只留下周期保存。
      const closed = await spatial.session.close();
      sessionClosed = closed.completed && closed.error === null && !closed.unconfirmedRequest;
      assert.equal(closed.completed, true, '底层会话真实 close 必须完成');
      assert.equal(closed.error, null);
      assert.equal(closed.unconfirmedRequest, false);
      assert.equal(closed.dirty, false, '周期保存后不应残留未保存版本');
    } finally {
      if (!sessionClosed) {
        try { await spatial.session.close(); } catch (error) { console.error('底层会话关闭失败:', error); }
      }
    }

    const reopened = await openSpatialSession({ worldId, databasePath: dbPath, timeoutMs: 5000 });
    try {
      const cell = reopened.voxel.cellAt(dim, pos.x, pos.y, pos.z);
      assert.equal(cell.observed, true, '周期保存应已落盘唯一观测');
      if (cell.observed) {
        assert.equal(cell.evidence.observation.state.name, 'minecraft:emerald_block');
        assert.equal(cell.evidence.observation.observedAt, observedAt);
        assert.equal(cell.evidence.observation.sessionId, sessionId);
        assert.equal(cell.evidence.freshness, 'STALE');
      }
    } finally {
      const closed = await reopened.close();
      reopenedClosed = closed.completed && closed.error === null && !closed.unconfirmedRequest;
      assert.equal(closed.completed, true, '重开后的真实 close 必须完成');
      assert.equal(closed.error, null);
    }
  } finally {
    if (sessionClosed && reopenedClosed) rmSync(dir, { recursive: true, force: true });
    else console.error('保留未确认关闭的 fixture:', dir, 'sessionClosed=', sessionClosed, 'reopenedClosed=', reopenedClosed);
  }
});
