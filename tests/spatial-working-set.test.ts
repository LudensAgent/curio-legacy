/**
 * M1：宿主侧 WorkingSetCoordinator 的独立验收。
 *
 * 使用安装的 curio-minecraft-3d-memory 0.7.7、真实 SQLite Worker 和每个用例独有的
 * mkdtemp 数据库。每个已打开的 session 都在 try/finally 中先释放 lease 再真实
 * close；只有 CloseResult 确认完成、无错误且无未确认请求时才删除临时目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkingSetManager, openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult, SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Observation, ResidencyLimits, SectionKey } from 'curio-minecraft-3d-memory';
import { WorkingSetCoordinator } from '../src/spatial/working-set.ts';
import type { WorkingSetPrepareOutcome } from '../src/spatial/working-set.ts';

const WORLD = 'manual-residency-world';
const DIM = 'overworld';

function keyAt(cx: number, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

function observation(
  x: number,
  y: number,
  z: number,
  observedAt: number,
  sequence: number,
  sessionId = 'seed',
  stateName = 'minecraft:stone',
): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId,
    observedAt,
    sequence,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: { name: stateName, properties: {} },
    pos: { x, y, z },
  };
}

function makeTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'manual-residency-'));
  return { dir, dbPath: join(dir, 'memory.db') };
}

function openManual(dbPath: string, residencyLimits?: ResidencyLimits): Promise<SpatialSession> {
  return openSpatialSession({
    databasePath: dbPath,
    worldId: WORLD,
    voxelLoading: 'manual',
    ...(residencyLimits === undefined ? {} : { residencyLimits }),
  });
}

function assertClose(result: CloseResult | null, dirty: boolean): void {
  if (result === null) assert.fail('session.close() did not return a CloseResult');
  assert.equal(result.completed, true);
  assert.equal(result.error, null);
  assert.equal(result.unconfirmedRequest, false);
  assert.equal(result.dirty, dirty);
}

function cleanup(dir: string, close: CloseResult | null): void {
  if (close === null || close.completed === false || close.error !== null || close.unconfirmedRequest) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** 用 eager session 写入并提交种子，然后真实关闭。 */
async function seed(dbPath: string, observations: readonly Observation[]): Promise<void> {
  const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  let close: CloseResult | null = null;
  try {
    session.voxel.beginSession('seed');
    for (const observation of observations) session.voxel.observe(observation);
    await session.checkpoint();
  } finally {
    close = await session.close();
  }
  assertClose(close, false);
}

/** 控制边界：manager 已经调用 measureSections 后停住，真实 worker 在 release 后执行。 */
function gateMeasure(session: SpatialSession): { started: Promise<void>; release: () => void } {
  const realMeasure = session.measureSections.bind(session);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  session.measureSections = async (keys) => {
    markStarted();
    await gate;
    return realMeasure(keys);
  };
  return { started, release: () => release() };
}

test('prepare loads a committed negative-coordinate section without refreshing old evidence', async () => {
  const { dir, dbPath } = makeTempDb();
  const key: SectionKey = { worldId: WORLD, dim: DIM, cx: -1, cz: -2, sy: -3 };
  const observedAt = 123_456_789;
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  const tokens: string[] = [];
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(-5, -40, -20, observedAt, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    assert.equal(session.sectionResidency(key).residency, 'not_resident');
    const before = coordinator.stats();
    assert.equal(before.residentSections, 0);
    assert.equal(before.pinnedLeases, 0);

    const outcome = await coordinator.prepare([key]);
    assert.equal(outcome.status, 'ready');
    if (outcome.status !== 'ready') assert.fail('prepare did not become ready');
    tokens.push(outcome.lease.token);
    assert.notEqual(outcome.lease.token, '');
    assert.equal(outcome.result.status, 'ready');
    assert.deepEqual(outcome.result.prepared, [key]);
    assert.deepEqual(outcome.result.loaded, [key]);
    assert.deepEqual(outcome.result.alreadyResident, []);
    assert.deepEqual(outcome.result.noRecord, []);
    assert.equal(outcome.result.capacity, null);

    const cell = session.voxel.cellAt(DIM, -5, -40, -20);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.observation.observedAt, observedAt);
      assert.deepEqual(cell.evidence.observation.pos, { x: -5, y: -40, z: -20 });
      assert.equal(cell.evidence.observation.state.name, 'minecraft:stone');
    }
    assert.equal(session.sectionResidency(key).residency, 'resident');

    const pinned = coordinator.stats();
    assert.equal(pinned.residentSections, 1);
    assert.equal(pinned.pinnedLeases, 1);
    assert.equal(pinned.pinnedSections, 1);

    // 真实 checkpoint 在加载结算后可用；加载与保存都不改写原始观测时间。
    const checkpoint = await session.checkpoint();
    assert.notEqual(checkpoint.checkpointId, '');
    const after = session.voxel.cellAt(DIM, -5, -40, -20);
    assert.equal(after.observed, true);
    if (after.observed) assert.equal(after.evidence.observation.observedAt, observedAt);

    coordinator.release(outcome.lease.token);
    tokens.length = 0;
    const released = coordinator.stats();
    assert.equal(released.pinnedLeases, 0);
    assert.equal(released.pinnedSections, 0);
    assert.equal(released.residentSections, 1);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    for (const token of tokens) coordinator?.release(token);
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('no_record is incomplete, not ready, and does not block a later first observation', async () => {
  const { dir, dbPath } = makeTempDb();
  const seedKey = keyAt(0);
  const unknownKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 5, cz: 5, sy: 5 };
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  let expectedDirty = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const outcome = await coordinator.prepare([seedKey, unknownKey]);
    assert.equal(outcome.status, 'incomplete');
    if (outcome.status !== 'incomplete') assert.fail('no_record request was not incomplete');
    assert.equal(outcome.result.status, 'incomplete');
    assert.deepEqual(outcome.result.noRecord, [unknownKey]);
    assert.deepEqual(outcome.result.prepared, []);
    assert.equal(outcome.result.lease.token, '');
    assert.equal(outcome.result.capacity, null);
    assert.equal(outcome.lease, null);
    assert.equal(session.sectionResidency(unknownKey).residency, 'no_record');
    assert.equal(coordinator.stats().pinnedLeases, 0);

    // 没有记录不是阻塞：后续真实首次观测可独立创建该 section。
    session.voxel.beginSession('live');
    session.voxel.observe(observation(81, 81, 81, 2000, 1, 'live', 'minecraft:dirt'));
    const cell = session.voxel.cellAt(DIM, 81, 81, 81);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.observation.state.name, 'minecraft:dirt');
      assert.equal(cell.evidence.observation.observedAt, 2000);
    }
    assert.equal(session.sectionResidency(unknownKey).residency, 'resident');

    // 故意不 checkpoint：close 完成不等于已保存。
    expectedDirty = true;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, expectedDirty);
    }
    cleanup(dir, close);
  }
});

test('a finite count capacity rejection keeps the library result and leaves no lease', async () => {
  const { dir, dbPath } = makeTempDb();
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1), observation(16, 64, 0, 100, 2)]);
    session = await openManual(dbPath, { maxResidentSections: 1 });
    coordinator = new WorkingSetCoordinator(session);

    const outcome = await coordinator.prepare([keyAt(0), keyAt(1)]);
    assert.equal(outcome.status, 'failed');
    if (outcome.status !== 'failed') assert.fail('count overflow did not fail');
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.capacity?.kind, 'count_capacity');
    assert.equal(typeof outcome.result.capacity?.message, 'string');
    assert.deepEqual(outcome.result.prepared, []);
    assert.deepEqual(outcome.result.loaded, []);
    assert.equal(outcome.result.lease.token, '');
    assert.equal(outcome.lease, null);
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(session.voxel.pinState().pinnedSections, 0);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('a finite byte capacity rejection keeps the library result and marks the load failed', async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath, { maxResidentBytes: 10 });
    coordinator = new WorkingSetCoordinator(session);

    const outcome = await coordinator.prepare([key]);
    assert.equal(outcome.status, 'failed');
    if (outcome.status !== 'failed') assert.fail('byte overflow did not fail');
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.capacity?.kind, 'byte_capacity');
    assert.deepEqual(outcome.result.loaded, []);
    assert.equal(outcome.result.lease.token, '');
    assert.equal(outcome.lease, null);
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(session.sectionResidency(key).residency, 'load_failed');
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('free keeps pinned and dirty resident sections and reports library reasons', async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  const tokens: string[] = [];
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath, { maxResidentSections: 1 });
    coordinator = new WorkingSetCoordinator(session);
    const outcome = await coordinator.prepare([key]);
    assert.equal(outcome.status, 'ready');
    if (outcome.status !== 'ready') assert.fail('prepare did not become ready');
    tokens.push(outcome.lease.token);

    const freeManager = new WorkingSetManager(session);
    const pinned = freeManager.free();
    assert.deepEqual(pinned.evicted, []);
    assert.ok(pinned.evictionRejected.some((entry) => entry.reason === 'pinned' && entry.key.cx === key.cx));

    coordinator.release(outcome.lease.token);
    tokens.length = 0;
    session.voxel.beginSession('live');
    session.voxel.observe(observation(0, 64, 0, 2000, 1, 'live', 'minecraft:dirt'));

    const dirty = freeManager.free();
    assert.deepEqual(dirty.evicted, []);
    assert.ok(dirty.evictionRejected.some((entry) => entry.reason === 'dirty' && entry.key.cx === key.cx));
    assert.equal(session.sectionResidency(key).residency, 'resident');

    await session.checkpoint();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    for (const token of tokens) coordinator?.release(token);
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('stale and repeated releases never drop a newer lease', async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  const tokens: string[] = [];
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const first = await coordinator.prepare([key]);
    assert.equal(first.status, 'ready');
    if (first.status !== 'ready') assert.fail('first prepare did not become ready');
    tokens.push(first.lease.token);

    const second = await coordinator.prepare([key]);
    assert.equal(second.status, 'ready');
    if (second.status !== 'ready') assert.fail('second prepare did not become ready');
    tokens.push(second.lease.token);
    assert.deepEqual(second.result.alreadyResident, [key]);
    assert.deepEqual(second.result.loaded, []);

    const both = coordinator.stats();
    assert.equal(both.pinnedLeases, 2);
    assert.equal(both.pinnedSections, 1);

    coordinator.release(first.lease.token);
    coordinator.release(first.lease.token);
    coordinator.release('not-a-lease');
    const remaining = coordinator.stats();
    assert.equal(remaining.pinnedLeases, 1);
    assert.equal(remaining.pinnedSections, 1);

    const freeManager = new WorkingSetManager(session);
    const pinned = freeManager.free();
    assert.deepEqual(pinned.evicted, []);
    assert.ok(pinned.evictionRejected.some((entry) => entry.reason === 'pinned'));

    coordinator.release(second.lease.token);
    tokens.length = 0;
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(session.voxel.pinState().pinnedSections, 0);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    for (const token of tokens) coordinator?.release(token);
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('a real checkpoint rejects busy while the manager load gate is held', async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(1);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  const tokens: string[] = [];
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1), observation(16, 64, 0, 100, 2)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const gate = gateMeasure(session);
    const pending = coordinator.prepare([key]);
    await gate.started;
    await assert.rejects(
      session.checkpoint(),
      (error: unknown) => error instanceof PersistenceError && error.kind === 'busy',
    );

    gate.release();
    const outcome = await pending;
    assert.equal(outcome.status, 'ready');
    if (outcome.status !== 'ready') assert.fail('gated prepare did not become ready');
    tokens.push(outcome.lease.token);

    const checkpoint = await session.checkpoint();
    assert.notEqual(checkpoint.checkpointId, '');
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    for (const token of tokens) coordinator?.release(token);
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('abort settles promptly while the real load stays tracked and its late lease is released', { timeout: 15_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const gate = gateMeasure(session);
    const controller = new AbortController();
    const pending = coordinator.prepare([key], { signal: controller.signal });
    await gate.started;
    assert.equal(session.busy, true);

    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.status, 'cancelled');
    if (outcome.status !== 'cancelled') assert.fail('aborted prepare was not cancelled');
    assert.equal(outcome.reason, 'aborted');
    assert.equal(outcome.result, null);
    assert.equal(outcome.lease, null);
    assert.equal(session.busy, true); // 真实 worker/gate 仍在跟踪

    const settled = coordinator.beginClose();
    gate.release();
    await settled;

    assert.equal(session.busy, false);
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(coordinator.stats().pinnedSections, 0);
    assert.equal(session.voxel.pinState().pinnedSections, 0);
    assert.equal(session.sectionResidency(key).residency, 'resident');
    const checkpoint = await session.checkpoint();
    assert.notEqual(checkpoint.checkpointId, '');
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('an absolute deadline settles promptly without abandoning the real load', { timeout: 15_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const gate = gateMeasure(session);
    const pending = coordinator.prepare([key], { deadline: Date.now() + 150 });
    await gate.started;

    const outcome = await pending;
    assert.equal(outcome.status, 'cancelled');
    if (outcome.status !== 'cancelled') assert.fail('deadline prepare was not cancelled');
    assert.equal(outcome.reason, 'deadline');
    assert.equal(outcome.lease, null);
    assert.equal(session.busy, true);

    const settled = coordinator.beginClose();
    gate.release();
    await settled;

    assert.equal(session.busy, false);
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(session.voxel.pinState().pinnedSections, 0);
    const checkpoint = await session.checkpoint();
    assert.notEqual(checkpoint.checkpointId, '');
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});

test('closing cancels pending callers, rejects new work, and settles before a real save/close', { timeout: 15_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  const key = keyAt(0);
  let session: SpatialSession | null = null;
  let coordinator: WorkingSetCoordinator | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seed(dbPath, [observation(0, 64, 0, 100, 1)]);
    session = await openManual(dbPath);
    coordinator = new WorkingSetCoordinator(session);

    const gate = gateMeasure(session);
    const pending: Promise<WorkingSetPrepareOutcome> = coordinator.prepare([key]);
    await gate.started;
    assert.equal(session.busy, true);

    const settled = coordinator.beginClose();
    const outcome = await pending;
    assert.equal(outcome.status, 'cancelled');
    if (outcome.status !== 'cancelled') assert.fail('closing prepare was not cancelled');
    assert.equal(outcome.reason, 'closing');
    assert.equal(outcome.lease, null);

    await assert.rejects(
      coordinator.prepare([key]),
      (error: unknown) => error instanceof PersistenceError && error.kind === 'closing',
    );

    gate.release();
    await settled;

    assert.equal(session.busy, false);
    assert.equal(coordinator.stats().pinnedLeases, 0);
    assert.equal(session.voxel.pinState().pinnedSections, 0);

    // 结算发生在真正 checkpoint/close 之前；两者仍由会话拥有。
    const checkpoint = await session.checkpoint();
    assert.notEqual(checkpoint.checkpointId, '');
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (session !== null) {
      close = await session.close();
      if (!failed) assertClose(close, false);
    }
    cleanup(dir, close);
  }
});
