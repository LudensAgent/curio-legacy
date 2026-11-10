/**
 * M2a1：SharedSpatialSession manual 体素接缝的真实 SQLite 验收。
 *
 * 每个用例使用安装的 curio-minecraft-3d-memory 0.8.0、真实 SQLite Worker 和
 * 独有 mkdtemp 数据库。所有打开的会话都在 try/finally 中真实关闭；只有
 * CloseResult 确认完成、无错误且无未确认请求时才删除临时目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult, SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ChangeReport, Observation, SectionKey } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import {
  MAX_PENDING_OBSERVATION_BYTES,
  SharedSpatialSession,
} from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';

const WORLD = 'shared-manual-world';
const DIM = 'overworld';
const SESSION = 'live';

function keyAt(cx = 0, cz = 0, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz, sy };
}

function blockObservation(
  x: number,
  y: number,
  z: number,
  observedAt: number,
  observationId: number,
  sessionId: string,
  name = 'minecraft:stone',
  properties: Record<string, string> = { axis: 'x' },
): BlockObservation {
  return {
    worldId: WORLD,
    sessionId,
    dimension: DIM,
    observationId,
    observedAt,
    pos: { x, y, z },
    name,
    properties,
    stateComplete: true,
    source: 'vision',
  };
}

function toObservation(block: BlockObservation): Observation {
  const properties = Object.fromEntries(
    Object.entries(block.properties ?? {}).map(([key, value]) => [key, String(value)]),
  );
  return {
    worldId: block.worldId,
    dim: block.dimension,
    sessionId: block.sessionId,
    observedAt: block.observedAt,
    sequence: block.observationId,
    source: 'vision',
    evidence: 'seen',
    stateComplete: block.stateComplete === true,
    state: { name: block.name, properties },
    pos: { ...block.pos },
  };
}

function makeTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shared-manual-'));
  return { dir, dbPath: join(dir, 'memory.db') };
}

function assertClose(result: CloseResult | null): void {
  if (result === null) assert.fail('session.close() did not return a CloseResult');
  assert.equal(result.completed, true);
  assert.equal(result.error, null);
  assert.equal(result.unconfirmedRequest, false);
}

function cleanup(dir: string, close: CloseResult | null): void {
  if (close === null || close.completed === false || close.error !== null || close.unconfirmedRequest) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** 用 eager session 写入并提交种子，然后真实关闭。 */
async function seedSaved(dbPath: string, observations: readonly Observation[]): Promise<void> {
  const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  let close: CloseResult | null = null;
  try {
    session.voxel.beginSession('seed');
    for (const observation of observations) session.voxel.observe(observation);
    await session.checkpoint();
  } finally {
    close = await session.close();
  }
  assertClose(close);
}

/**
 * 控制边界：暂停在真实 worker query 之前，release 后仍调用真实 measureSections。
 * 仅用于让测试在 load 已开始、ready 尚未返回时观察 pending/lease。
 */
function pauseBeforeMeasureQuery(
  session: SpatialSession,
): { started: Promise<void>; release: () => void; calls: () => number } {
  const realMeasure = session.measureSections.bind(session);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let calls = 0;
  session.measureSections = async (keys) => {
    calls += 1;
    markStarted();
    await gate;
    return realMeasure(keys);
  };
  return { started, release: () => release(), calls: () => calls };
}

function payloadBytes(block: BlockObservation): number {
  return Buffer.byteLength(JSON.stringify(toObservation(block)), 'utf8');
}

function finiteWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 测试侧有限轮询；生产路径不轮询。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('condition was not met within the test timeout');
    await finiteWait(5);
  }
}

async function shutdownQuietly(shared: SharedSpatialSession | null): Promise<ShutdownResult | null> {
  if (shared === null) return null;
  try {
    return await shared.shutdown();
  } catch {
    return null;
  }
}

test('a saved manual update is applied with its original observation payload', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'not_resident');

    shared.observe([blockObservation(0, 64, 0, 2000, 42, SESSION, 'minecraft:dirt', { axis: 'y' })]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');

    const cell = shared.session.voxel.cellAt(DIM, 0, 64, 0);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.observation.observedAt, 2000);
      assert.equal(cell.evidence.observation.sessionId, SESSION);
      assert.deepEqual(cell.evidence.observation.state, {
        name: 'minecraft:dirt',
        properties: { axis: 'y' },
      });
      assert.deepEqual(cell.evidence.observation.pos, { x: 0, y: 64, z: 0 });
    }

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
    assert.equal(close?.dirty, false);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a confirmed checkpoint evicts saved manual sections; prepare reloads the original evidence', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentSections: 2 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe([
      blockObservation(0, 64, 0, 2000, 42, SESSION, 'minecraft:dirt', { axis: 'y' }),
      blockObservation(16, 64, 0, 2001, 43, SESSION, 'minecraft:stone', { axis: 'x' }),
    ]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');

    await shared.checkpoint();
    assert.equal(shared.workingSetStats().residentSections, 1,
      '保存后应只淘汰到容量目标（2 → 1），不是清空全部冷页');
    const evictedKey = [keyAt(0), keyAt(1)].find((key) => shared!.session.sectionResidency(key).residency === 'not_resident');
    assert.ok(evictedKey !== undefined, '应有一个冷页被淘汰');
    const eviction = shared.lastPostSaveEviction();
    assert.equal(eviction?.status, 'evicted');
    assert.equal(eviction?.evictedSections, 1, '换出事实必须报告实际淘汰的 section 数');

    const prepared = await shared.prepare([evictedKey], { deadline: Date.now() + 5000 });
    assert.equal(prepared.status, 'ready');
    if (prepared.status !== 'ready') assert.fail('saved section must load on demand');
    try {
      const cell = shared.session.voxel.cellAt(DIM, evictedKey.cx * 16, 64, 0);
      assert.equal(cell.observed, true);
      if (cell.observed) {
        assert.equal(cell.evidence.observation.observedAt, evictedKey.cx === 0 ? 2000 : 2001,
          '冷读不刷新原观测时间');
        assert.equal(cell.evidence.observation.sessionId, SESSION);
        assert.equal(cell.evidence.observation.state.name, evictedKey.cx === 0 ? 'minecraft:dirt' : 'minecraft:stone');
      }
    } finally {
      shared.release(prepared.lease.token);
    }

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('post-save eviction keeps recent hot pages up to the capacity target', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentSections: 4 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe([0, 16, 32, 48].map((x, i) => blockObservation(x, 64, 0, 1000 + i, i + 1, SESSION)));
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.workingSetStats().residentSections, 4, '四个首次观测的 Section 都应驻留');

    await shared.checkpoint();
    const eviction = shared.lastPostSaveEviction();
    assert.equal(eviction?.status, 'evicted');
    assert.equal(eviction?.evictedSections, 1, '只淘汰到 75% 容量目标（4 → 3），不清空全部热页');
    assert.equal(shared.workingSetStats().residentSections, 3);
    assert.equal([0, 1, 2, 3].filter((cx) => shared!.session.sectionResidency(keyAt(cx, 0)).residency === 'resident').length, 3);
    assert.equal([0, 1, 2, 3].filter((cx) => shared!.session.sectionResidency(keyAt(cx, 0)).residency === 'not_resident').length, 1);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('shutdown commits bounded dirty batches until clean and reloads all cells', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      voxelBatchMaxBytes: 1,
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe([
      blockObservation(0, 64, 0, 1000, 1, SESSION, 'minecraft:stone'),
      blockObservation(20, 64, 0, 1000, 2, SESSION, 'minecraft:dirt'),
      blockObservation(40, 64, 0, 1000, 3, SESSION, 'minecraft:air'),
    ]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.getPersistenceState().dirty, true);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
    assert.equal(close?.dirty, false, '最终关机必须把分片 dirty 批次全部提交');

    const reopened = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
    try {
      assert.equal(reopened.session.voxel.cellAt(DIM, 0, 64, 0).observed, true);
      assert.equal(reopened.session.voxel.cellAt(DIM, 20, 64, 0).observed, true);
      assert.equal(reopened.session.voxel.cellAt(DIM, 40, 64, 0).observed, true);
    } finally {
      const reopenedShutdown = await reopened.shutdown();
      assert.equal(reopenedShutdown.error, null);
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a refused queued byte growth retains the original evidence and shutdown reports it unsaved', { timeout: 30_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentBytes: 65_536 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    // 加载一个稀疏的已保存 Section 可以成功；同一批 256 个更新的驻留字节增长超限。
    const updates = Array.from({ length: 256 }, (_, i) => blockObservation(
      i % 16,
      64,
      Math.floor(i / 16),
      3000 + i,
      1000 + i,
      SESSION,
      `minecraft:stone_${'x'.repeat(512)}`,
      { marker: 'queued-growth' },
    ));
    shared.observe(updates);

    const drained = await shared.drainObservations({ deadline: Date.now() + 10_000 });
    assert.equal(drained.cancelled, false);
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');
    assert.equal(drained.pending.observations, updates.length);
    assert.equal(drained.gap?.kind, 'byte_capacity');

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.notEqual(shutdown.error, null);
    assert.match(String(shutdown.error), /pending observation/);
    assertClose(close);

    // 容量拒绝没有把排队更新写进已提交数据库；重开真实 SQLite 验证。
    const verify = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    let verifyClose: CloseResult | null = null;
    try {
      verify.beginSession({ worldId: WORLD, dim: DIM, sessionId: 'verify' });
      const prepared = await verify.prepare([keyAt()]);
      assert.equal(prepared.status, 'ready');
      if (prepared.status === 'ready') verify.release(prepared.lease.token);

      const refused = verify.session.voxel.cellAt(DIM, 1, 64, 1);
      assert.equal(refused.observed, false);
      const saved = verify.session.voxel.cellAt(DIM, 0, 64, 0);
      assert.equal(saved.observed, true);
      if (saved.observed) {
        assert.equal(saved.evidence.observation.observedAt, 100);
        assert.equal(saved.evidence.observation.state.name, 'minecraft:stone');
      }
    } finally {
      verifyClose = (await verify.shutdown()).close;
    }
    assertClose(verifyClose);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('byte budget is a strict arrival prefix; a smaller later observation is not admitted', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    const gate = pauseBeforeMeasureQuery(shared.session);
    const smallFirst = blockObservation(0, 64, 0, 2000, 2, SESSION);
    const oversized = blockObservation(1, 64, 0, 2001, 3, SESSION, `minecraft:${'x'.repeat(MAX_PENDING_OBSERVATION_BYTES)}`);
    const smallLater = blockObservation(2, 64, 0, 2002, 4, SESSION);
    assert.ok(payloadBytes(smallFirst) < MAX_PENDING_OBSERVATION_BYTES);
    assert.ok(payloadBytes(oversized) > MAX_PENDING_OBSERVATION_BYTES);
    assert.ok(payloadBytes(smallLater) < MAX_PENDING_OBSERVATION_BYTES);

    shared.observe([smallFirst, oversized, smallLater]);
    await gate.started;

    const pending = shared.pendingObservations();
    assert.equal(pending.observations, 1);
    assert.equal(pending.bytes, payloadBytes(smallFirst));
    assert.equal(pending.byteLimit, MAX_PENDING_OBSERVATION_BYTES);

    const gap = shared.observationGap();
    assert.equal(gap?.kind, 'queue_full');
    assert.equal(gap?.count, 2);
    assert.equal(gap?.observedAtMin, 2001);
    assert.equal(gap?.observedAtMax, 2002);
    assert.match(gap?.message ?? '', /accepted prefix 1/);
    assert.match(gap?.message ?? '', /rejected 2/);
    assert.ok(Buffer.byteLength(gap?.message ?? '', 'utf8') <= 512);

    shared.setPaused(true);
    assert.equal(shared.pendingObservations().observations, 0);
    shared.setPaused(false);
    gate.release();
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.cancelled, false);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a busy gate leaves pending evidence and a visible gap; explicit drain retries once', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    // 人工占住会话操作门：真实 load 不启动，runLoadAttempt 只记录一次 busy。
    shared.session.acquireWorkingSetOperation();
    const observation = blockObservation(0, 64, 0, 2100, 9, SESSION);
    shared.observe([observation]);
    await waitFor(() => shared!.pendingObservations().loading === false);

    assert.equal(shared.pendingObservations().observations, 1);
    assert.equal(shared.observationGap()?.kind, 'busy');
    assert.equal(shared.lastLoadFailure(), null);

    shared.session.releaseWorkingSetOperation();
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.cancelled, false);
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');
    const cell = shared.session.voxel.cellAt(DIM, 0, 64, 0);
    assert.equal(cell.observed, true);
    if (cell.observed) assert.equal(cell.evidence.observation.observedAt, 2100);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a throwing diagnostic callback is recorded with identity and never blocks writes', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    const diagnosticError = new Error('injected diagnostic failure');
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
      onWorkingSetDiagnostic: () => { throw diagnosticError; },
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    shared.session.acquireWorkingSetOperation();
    shared.observe([blockObservation(0, 64, 0, 2200, 11, SESSION)]);
    await waitFor(() => shared!.observationGap()?.kind === 'busy');
    assert.equal(shared.lastDiagnosticFailure(), diagnosticError);
    shared.session.releaseWorkingSetOperation();

    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.lastDiagnosticFailure(), diagnosticError);

    // 作用域换代后不再报告旧代诊断失败。
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: 'next-scope' });
    assert.equal(shared.lastDiagnosticFailure(), null);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('waitWithin timeout keeps its own identity and still attempts final checkpoint and close', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 300,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    const gate = pauseBeforeMeasureQuery(shared.session);
    shared.observe([blockObservation(0, 64, 0, 2300, 13, SESSION)]);
    await gate.started;

    const shutdownPromise = shared.shutdown();
    // 让 settle 超过 timeoutMs；关停仍必须继续走 checkpoint/close。
    await finiteWait(450);
    gate.release();
    const shutdown = await shutdownPromise;
    close = shutdown.close;

    assert.ok(shutdown.error instanceof PersistenceError);
    if (shutdown.error instanceof PersistenceError) {
      assert.equal(shutdown.error.kind, 'timeout');
      assert.match(shutdown.error.message, /working-set settlement did not complete/);
    }
    // 真实 close 仍然执行过；它的结果单独保留，不被改写成 settle 成功。
    assert.notEqual(shutdown.close, null);
    await finiteWait(50);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('an applied write followed by a receiver failure is distinguished from unapplied evidence', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    const receiverError = new Error('injected receiver failure after apply');
    shared.attach({
      receiver: () => { throw receiverError; },
      cancel: () => {},
      protectedSections: [keyAt()],
    });

    // no_record 首观测同步写入；receiver 抛错不能回滚或改写成“未应用”。
    shared.observe([blockObservation(0, 64, 0, 2400, 17, SESSION)]);

    const cell = shared.session.voxel.cellAt(DIM, 0, 64, 0);
    assert.equal(cell.observed, true);
    if (cell.observed) assert.equal(cell.evidence.observation.observedAt, 2400);
    assert.equal(shared.pendingObservations().observations, 0);
    assert.equal(shared.lastLoadFailure(), null);
    assert.equal(shared.lastReceiverFailure()?.error, receiverError);
    assert.equal(shared.lastReceiverFailure()?.applied, 1);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a throwing receiver still releases the actual ready lease', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const token = shared.attach({
      receiver: () => { throw new Error('injected receiver failure'); },
      cancel: () => {},
      protectedSections: [keyAt()],
    });

    const gate = pauseBeforeMeasureQuery(shared.session);
    shared.observe([blockObservation(0, 64, 0, 2000, 42, SESSION)]);
    const drainedPromise = shared.drainObservations({ deadline: Date.now() + 5000 });
    await gate.started;
    gate.release();
    await drainedPromise;

    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');
    assert.equal(shared.pendingObservations().observations, 0);
    assert.equal(shared.workingSetStats().pinnedLeases, 0);
    assert.equal(shared.workingSetStats().pinnedSections, 0);
    shared.detach(token);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('load failures clear after a real success and never leak across a scope change', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [
      toObservation(blockObservation(0, 64, 0, 100, 1, 'seed')),
      toObservation(blockObservation(16, 64, 0, 101, 2, 'seed')),
    ]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const realAcquire = shared.session.acquireWorkingSetOperation.bind(shared.session);

    // 让真实的 WorkingSetManager.prepare 在取得操作门前同步拒绝。
    const firstError = new Error('injected prepare rejection one');
    shared.session.acquireWorkingSetOperation = () => { throw firstError; };
    shared.observe([blockObservation(0, 64, 0, 2500, 21, SESSION)]);
    await waitFor(() => shared!.lastLoadFailure() === firstError);
    assert.equal(shared.observationGap()?.kind, 'load_failed');

    // 显式 drain 在 flush 后允许一次重试；成功后旧失败不再报告。
    shared.session.acquireWorkingSetOperation = realAcquire;
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    assert.equal(shared.lastLoadFailure(), null);
    assert.equal(shared.session.sectionResidency(keyAt()).residency, 'resident');

    const secondError = new Error('injected prepare rejection two');
    shared.session.acquireWorkingSetOperation = () => { throw secondError; };
    shared.observe([blockObservation(16, 64, 0, 2600, 22, SESSION)]);
    await waitFor(() => shared!.lastLoadFailure() === secondError);
    shared.session.acquireWorkingSetOperation = realAcquire;

    // 作用域换代：旧代的加载失败不可再被读到。
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: 'next-scope' });
    assert.equal(shared.lastLoadFailure(), null);
    assert.equal(shared.discardedObservations()?.reason, 'scope');

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});

test('a prepare cancelled by shutdown leaves a visible fact instead of silent loadBlocked', { timeout: 20_000 }, async () => {
  const { dir, dbPath } = makeTempDb();
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    await seedSaved(dbPath, [toObservation(blockObservation(0, 64, 0, 100, 1, 'seed'))]);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 2000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    const gate = pauseBeforeMeasureQuery(shared.session);
    shared.observe([blockObservation(0, 64, 0, 2700, 23, SESSION)]);
    await gate.started;

    const shutdownPromise = shared.shutdown();
    await waitFor(() => shared!.observationGap()?.kind === 'prepare_cancelled');
    gate.release();
    const shutdown = await shutdownPromise;
    close = shutdown.close;

    assert.equal(shared.observationGap()?.kind, 'prepare_cancelled');
    // 迟到的 ready 仍可应用，因此最终不一定有未处理证据；关闭必须是真实结果。
    assert.equal(shutdown.error, null);
    assertClose(close);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (!failed) {
      const result = await shutdownQuietly(shared);
      if (close === null) close = result?.close ?? null;
    } else {
      close = (await shutdownQuietly(shared))?.close ?? null;
    }
    cleanup(dir, close);
  }
});
