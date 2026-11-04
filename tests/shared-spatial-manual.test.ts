/**
 * M2a1：SharedSpatialSession manual 体素接缝的最小真实 SQLite 验收。
 *
 * 每个用例使用安装的 curio-minecraft-3d-memory 0.7.7、真实 SQLite Worker 和
 * 独有 mkdtemp 数据库。所有打开的会话都在 try/finally 中真实关闭；只有
 * CloseResult 确认完成、无错误且无未确认请求时才删除临时目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult, SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Observation, SectionKey } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';

const WORLD = 'shared-manual-world';
const DIM = 'overworld';
const SESSION = 'live';

function keyAt(cx = 0, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
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
function pauseBeforeMeasureQuery(session: SpatialSession): { started: Promise<void>; release: () => void } {
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

test('shutdown closes the real session after an injected apply error and pending mismatch', { timeout: 20_000 }, async () => {
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
      residencyLimits: { maxResidentBytes: 10 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    shared.observe([blockObservation(0, 64, 0, 3000, 77, SESSION)]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.cancelled, false);
    assert.ok(drained.pending.observations > 0);

    const applyError = new Error('injected apply failure');
    const internal = shared as unknown as { applyReadyPending: () => void };
    internal.applyReadyPending = () => { throw applyError; };

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, applyError);
    assert.equal(shutdown.cancelError, null);
    assert.equal(shutdown.closeError, null);
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
