/**
 * shared-session 服务的独立验收：直接驱动 src/spatial/shared-session.ts，使用安装的
 * curio-minecraft-3d-memory 0.7.5、真实 Worker 与唯一 mkdtemp 数据库。每条路径都在
 * 清理前关闭；unclean close（close 失败/结果未知）时保留 fixture 供检查。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChangeReport } from 'curio-minecraft-3d-memory';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SnapshotLimits } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import type { BlockObservation } from '../src/adapter/types.ts';

const WORLD = 'world-a';

/** 构造一条合法的 typed 视锥观测（properties 含 number 以验证归一化）。 */
function block(over: Partial<BlockObservation> & Pick<BlockObservation, 'pos' | 'observedAt' | 'observationId'>): BlockObservation {
  return {
    name: 'minecraft:stone',
    properties: { variant: 'stone', level: 3 },
    worldId: WORLD,
    sessionId: 's1',
    dimension: 'overworld',
    source: 'vision',
    stateComplete: true,
    ...over,
  };
}

/** 通过公开 observe 写入一条同高、干燥、带支撑的短走廊。 */
function corridor(sessionId: string, observedAt: number): BlockObservation[] {
  return [0, 1, 2].flatMap((x) => [
    block({ name: 'minecraft:stone', properties: {}, pos: { x, y: -1, z: 0 }, observedAt, observationId: x * 3 + 1, sessionId }),
    block({ name: 'minecraft:air', properties: {}, pos: { x, y: 0, z: 0 }, observedAt, observationId: x * 3 + 2, sessionId }),
    block({ name: 'minecraft:air', properties: {}, pos: { x, y: 1, z: 0 }, observedAt, observationId: x * 3 + 3, sessionId }),
  ]);
}

async function openShared(opts?: { now?: () => number; snapshotLimits?: SnapshotLimits }): Promise<{
  svc: SharedSpatialSession;
  dir: string;
  dbPath: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-spatial-'));
  const dbPath = join(dir, 'memory.db');
  const svc = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: dbPath,
    now: opts?.now,
    snapshotLimits: opts?.snapshotLimits,
  });
  return { svc, dir, dbPath };
}

function freshness(svc: SharedSpatialSession, dim: string, x: number, y: number, z: number): string | undefined {
  const cell = svc.session.voxel.cellAt(dim, x, y, z);
  return cell.observed ? cell.evidence.freshness : undefined;
}

/** close 干净时删除临时目录；unclean close（close 抛错/未完成/带错）时保留 fixture。 */
function cleanup(dir: string, result: ShutdownResult | null): void {
  if (result === null || result.close === null || result.close.completed === false || result.close.error !== null) return;
  rmSync(dir, { recursive: true, force: true });
}

test('observeLocalStance 把当前站位写成新鲜的本地重扫证据', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    const observedAt = Date.now();
    svc.observeLocalStance({
      dim: 'overworld', sessionId: 's1', sequence: 1, observedAt,
      cells: [
        { pos: { x: 0, y: -1, z: 0 }, name: 'minecraft:stone', properties: {}, stateComplete: true },
        { pos: { x: 0, y: 0, z: 0 }, name: 'minecraft:air', properties: {}, stateComplete: true },
        { pos: { x: 0, y: 1, z: 0 }, name: 'minecraft:air', properties: {}, stateComplete: true },
      ],
    });
    const support = svc.session.voxel.cellAt('overworld', 0, -1, 0);
    assert.equal(support.observed, true);
    assert.equal(support.evidence.freshness, 'FRESH');
    assert.equal(support.evidence.observation.source, 'local_rescan');
    assert.equal(support.evidence.observation.evidence, 'seen');
    assert.equal(support.evidence.observation.observedAt, observedAt);
    assert.equal(support.evidence.validUntil - observedAt, 300_000, '宿主默认 5 分钟，而不是库默认 60 秒');
  } finally {
    try { result = await svc.shutdown(); } catch { /* 保留 fixture 供检查 */ }
    cleanup(dir, result);
  }
});

/** 真实 close 的正向断言：completed/error/unconfirmedRequest 都来自实际返回值。 */
function assertCleanClose(result: ShutdownResult): void {
  if (result.close === null) assert.fail('shutdown did not return a close result');
  assert.equal(result.close.completed, true);
  assert.equal(result.close.error, null);
  assert.equal(result.close.unconfirmedRequest, false);
  assert.equal(result.close.dirty, false);
}

/**
 * 最终保存的完整正向断言：实际 checkpoint id 必须领先于先前保存，并与当前/已确认的
 * 各域版本、dirty=false、lastConfirmed 以及真实 CloseResult 一致。
 */
function assertFinalSave(svc: SharedSpatialSession, result: ShutdownResult, priorCheckpointId: string): void {
  assert.equal(result.error, null);
  assert.equal(result.cancelError, null);
  if (result.checkpoint === null) assert.fail('shutdown did not capture a final checkpoint');
  const checkpoint = result.checkpoint;
  assert.notEqual(checkpoint.checkpointId, priorCheckpointId);
  const state = svc.getPersistenceState();
  assert.equal(state.lifecycle, 'closed');
  assert.equal(state.dirty, false);
  assert.equal(state.lastConfirmedCheckpointId, checkpoint.checkpointId);
  assert.equal(checkpoint.voxelRevision, state.voxelRevision);
  assert.equal(checkpoint.voxelRevision, state.confirmedVoxelRevision);
  assert.equal(checkpoint.journalRevision, state.journalRevision);
  assert.equal(checkpoint.journalRevision, state.confirmedJournalRevision);
  assert.equal(checkpoint.ledgerRevision, state.ledgerRevision);
  assert.equal(checkpoint.ledgerRevision, state.confirmedLedgerRevision);
  assert.equal(checkpoint.factsRevision, state.factsRevision);
  assert.equal(checkpoint.factsRevision, state.confirmedFactsRevision);
  assertCleanClose(result);
  if (result.close === null) assert.fail('shutdown did not return a close result');
  assert.equal(result.close.lastConfirmedCheckpointId, checkpoint.checkpointId);
}

test('interrupt delivers the lifecycle report to the attached receiver', async () => {
  let t = 0;
  const now = () => t;
  const { svc, dir } = await openShared({ now });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe(corridor('s1', 0));
    const reports: ChangeReport[] = [];
    svc.attach({ receiver: (report) => { reports.push(report); }, cancel: () => {} });

    t = 100;
    svc.interrupt();
    assert.equal(reports.length, 1, '生命周期报告必须同步交给当前附着');
    assert.ok(Array.isArray(reports[0]!.sections));

    result = await svc.shutdown();
    assert.equal(result.error, null);
    assertCleanClose(result);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try { result = await svc.shutdown(); } catch (err) { if (!failed) throw err; }
    }
  }
  cleanup(dir, result);
});

test('attachment replacement, pause, and same-session dimension change cancel; interrupt gates evidence until ready', async () => {
  let t = 0;
  const now = () => t;
  const { svc, dir } = await openShared({ now });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });

    const cancels: string[] = [];
    const aReports: ChangeReport[] = [];
    const tokenA = svc.attach({ receiver: (r) => aReports.push(r), cancel: () => { cancels.push('a'); } });
    svc.attach({ receiver: () => {}, cancel: () => { cancels.push('b'); } });
    assert.deepEqual(cancels, ['a']); // 新 owner 先撤销旧 owner

    svc.detach(tokenA); // 旧 token 不得解除新附着

    // 空 map/无观测的暂停也必须取消活动委托，并拒绝新委托。
    t = 10;
    svc.setPaused(true);
    assert.deepEqual(cancels, ['a', 'b']);
    assert.throws(
      () => svc.attach({ receiver: () => {}, cancel: () => { cancels.push('paused'); } }),
      (err) => err instanceof PersistenceError && err.kind === 'invalid_argument',
    );
    t = 20;
    svc.setPaused(false);
    // 空 map 上的暂停/恢复也记录边界：暂停期间取得的迟到证据被拒绝。
    svc.observe([block({ pos: { x: 9, y: 0, z: 0 }, observedAt: 15, observationId: 90 })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 9, 0, 0).observed, false);

    const dReports: ChangeReport[] = [];
    svc.attach({ receiver: (r) => dReports.push(r), cancel: () => { cancels.push('d'); } });
    t = 30;
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 30, observationId: 1 })]);
    assert.equal(dReports.length, 1);
    assert.equal(aReports.length, 0);

    // 同 session 换维：取消活动委托并使旧维度失效。
    t = 40;
    svc.beginSession({ worldId: WORLD, dim: 'the_nether', sessionId: 's1' });
    assert.deepEqual(cancels, ['a', 'b', 'd']);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'STALE');

    // 未就绪维度是显式失败，不改变可信作用域。
    assert.throws(
      () => svc.beginSession({ worldId: WORLD, dim: 'unknown', sessionId: 's1' }),
      (err) => err instanceof PersistenceError && err.kind === 'invalid_argument',
    );

    // 其他维度/旧 session 的观测被忽略。
    t = 50;
    svc.observe([block({ pos: { x: 1, y: 0, z: 0 }, observedAt: 50, observationId: 2, dimension: 'overworld' })]);
    svc.observe([block({ pos: { x: 2, y: 0, z: 0 }, observedAt: 50, observationId: 3, sessionId: 's0' })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 0).observed, false);
    assert.equal(svc.session.voxel.cellAt('the_nether', 2, 0, 0).observed, false);

    // 邻格隔离：只重新观察 A，不刷新不可见的 B。
    t = 60;
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 60, observationId: 4, dimension: 'the_nether' })]);
    svc.observe([block({ pos: { x: 1, y: 0, z: 0 }, observedAt: 60, observationId: 5, dimension: 'the_nether' })]);
    assert.equal(freshness(svc, 'the_nether', 0, 0, 0), 'FRESH');
    assert.equal(freshness(svc, 'the_nether', 1, 0, 0), 'FRESH');

    svc.interrupt();
    assert.throws(
      () => svc.attach({ receiver: () => {}, cancel: () => {} }),
      (err) => err instanceof PersistenceError && err.kind === 'invalid_argument',
    );

    // interrupt 之后即使同一 session、更晚时间戳的观测也被挂起。
    t = 70;
    svc.observe([block({ pos: { x: 2, y: 0, z: 0 }, observedAt: 70, observationId: 6, dimension: 'the_nether' })]);
    assert.equal(svc.session.voxel.cellAt('the_nether', 2, 0, 0).observed, false);
    assert.equal(freshness(svc, 'the_nether', 0, 0, 0), 'STALE');

    // 只有可信 ready beginSession 才恢复准入；重看 A 不刷新邻格 B。
    t = 80;
    svc.beginSession({ worldId: WORLD, dim: 'the_nether', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 80, observationId: 7, dimension: 'the_nether' })]);
    assert.equal(freshness(svc, 'the_nether', 0, 0, 0), 'FRESH');
    assert.equal(freshness(svc, 'the_nether', 1, 0, 0), 'STALE');

    svc.observe([block({ pos: { x: 2, y: 0, z: 0 }, observedAt: 80, observationId: 8, dimension: 'the_nether' })]);
    assert.equal(freshness(svc, 'the_nether', 2, 0, 0), 'FRESH');

    result = await svc.shutdown();
    assert.equal(result.error, null);
    assert.equal(result.cancelError, null);
    assertCleanClose(result);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('before beginSession and old-session late evidence are ignored', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    // 尚未 beginSession：观测被挂起，不写入。
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1, sessionId: 's1' })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 0, 0, 0).observed, false);

    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 2, observationId: 2, sessionId: 's1' })]);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'FRESH');

    // 切换到新 session 后，旧 session 的迟到证据被忽略。
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's2' });
    svc.observe([block({ pos: { x: 5, y: 0, z: 5 }, observedAt: 3, observationId: 3, sessionId: 's1' })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 5, 0, 5).observed, false);

    result = await svc.shutdown();
    assert.equal(result.error, null);
    assertCleanClose(result);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('pause/resume with zero observations records interruption boundaries that reject delayed evidence', async () => {
  let t = 0;
  const now = () => t;
  const { svc, dir } = await openShared({ now });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 0, observationId: 1, sessionId: 's1' })]);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'FRESH');

    // 暂停：无观测，边界在 t=100；暂停期间写入被挂起。
    t = 100;
    svc.setPaused(true);
    assert.equal(svc.paused, true);
    const during = svc.observe([block({ pos: { x: 5, y: 0, z: 5 }, observedAt: 150, observationId: 2, sessionId: 's1' })]);
    assert.equal(during.sections.length, 0);
    assert.equal(svc.session.voxel.cellAt('overworld', 5, 0, 5).observed, false);

    // 恢复：边界在 t=200。
    t = 200;
    svc.setPaused(false);

    // 暂停期间取得的迟到证据（observedAt=150 <= 200）对未知格同样被拒绝。
    svc.observe([block({ pos: { x: 6, y: 0, z: 6 }, observedAt: 150, observationId: 3, sessionId: 's1' })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 6, 0, 6).observed, false);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'STALE');

    // 恢复后的新证据被接受，且原始时间戳不被改写。
    t = 300;
    svc.observe([block({ pos: { x: 2, y: 0, z: 2 }, observedAt: 300, observationId: 4, sessionId: 's1' })]);
    assert.equal(freshness(svc, 'overworld', 2, 0, 2), 'FRESH');
    const restored = svc.session.voxel.cellAt('overworld', 2, 0, 2);
    assert.equal(restored.observed && restored.evidence.observation.observedAt, 300);

    result = await svc.shutdown();
    assert.equal(result.error, null);
    assertCleanClose(result);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('final checkpoint persists a unique last fact and a clean close; reopen restores it STALE', async () => {
  const { svc, dir, dbPath } = await openShared();
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({
      name: 'minecraft:dirt', properties: { variant: 'initial' },
      pos: { x: 0, y: 0, z: 0 }, observedAt: 1_000, observationId: 1, sessionId: 's1',
    })]);
    const initial = await svc.checkpoint();
    assert.equal(svc.getPersistenceState().dirty, false);
    assert.equal(svc.getPersistenceState().lastConfirmedCheckpointId, initial.checkpointId);

    // 唯一的新格子/属性/时间/sequence 只应通过最终 checkpoint 落盘。
    const finalObservedAt = 1_700_000_000_123;
    svc.observe([block({
      name: 'minecraft:oak_door',
      properties: { open: true, half: 'upper', facing: 'east' },
      pos: { x: 7, y: 8, z: 9 },
      observedAt: finalObservedAt,
      observationId: 42,
      sessionId: 's1',
    })]);

    // shutdown 一被调用就同步关闭准入；最终保存/close 尚未完成时公开 checkpoint 已拒绝。
    const pendingShutdown = svc.shutdown();
    await assert.rejects(
      svc.checkpoint(),
      (err) => err instanceof PersistenceError && (err.kind === 'closing' || err.kind === 'closed'),
    );
    result = await pendingShutdown;
    assertFinalSave(svc, result, initial.checkpointId);
    assert.equal(result.cancelError, null);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  // 只有已知成功 close 之后才 reopen。
  assert.notEqual(result!.close, null);
  assert.equal(result!.close!.completed, true);

  const reopened = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
  let reopenResult: ShutdownResult | null = null;
  let reopenFailed = false;
  try {
    const cell = reopened.session.voxel.cellAt('overworld', 7, 8, 9);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.freshness, 'STALE');
      assert.equal(cell.evidence.observation.state.name, 'minecraft:oak_door');
      assert.equal(cell.evidence.observation.state.properties.open, 'true');
      assert.equal(cell.evidence.observation.state.properties.half, 'upper');
      assert.equal(cell.evidence.observation.state.properties.facing, 'east');
      assert.equal(cell.evidence.observation.observedAt, 1_700_000_000_123);
      assert.equal(cell.evidence.observation.sequence, 42);
      assert.equal(cell.evidence.observation.worldId, WORLD);
      assert.equal(cell.evidence.observation.dim, 'overworld');
      assert.equal(cell.evidence.observation.sessionId, 's1');
    }

    reopenResult = await reopened.shutdown();
    assert.equal(reopenResult.error, null);
    assert.notEqual(reopenResult.checkpoint, null);
    assert.equal(reopenResult.checkpoint!.checkpointId, reopened.getPersistenceState().lastConfirmedCheckpointId);
    assertCleanClose(reopenResult);
  } catch (err) {
    reopenFailed = true;
    throw err;
  } finally {
    if (reopenResult === null) {
      try {
        reopenResult = await reopened.shutdown();
      } catch (err) {
        if (!reopenFailed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('a test-only checkpoint wrapper returning the prior result fails final-save checks and loses the last fact', async () => {
  const { svc, dir, dbPath } = await openShared();
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({
      name: 'minecraft:dirt', properties: {},
      pos: { x: 0, y: 0, z: 0 }, observedAt: 1_000, observationId: 1, sessionId: 's1',
    })]);
    const initial = await svc.checkpoint();

    svc.observe([block({
      name: 'minecraft:oak_door',
      properties: { open: true, half: 'upper', facing: 'east' },
      pos: { x: 7, y: 8, z: 9 },
      observedAt: 1_700_000_000_123,
      observationId: 42,
      sessionId: 's1',
    })]);

    // 测试注入：包装实际 checkpoint 但不保存，只返回旧结果（产品无 skip-save 选项）。
    svc.session.checkpoint = async () => initial;

    result = await svc.shutdown();
    // 同一组最终保存断言必须失败：dirty 仍为 true、最终 id 没有领先。
    assert.throws(() => assertFinalSave(svc, result!, initial.checkpointId));
    assert.equal(result.cancelError, null);
    assert.equal(result.checkpoint?.checkpointId, initial.checkpointId);
    assert.ok(result.error instanceof PersistenceError);
    assert.equal(result.error.kind, 'data');

    // 失败的最终保存不得掩盖真实 close；close 结果按实际保留。
    assert.notEqual(result.close, null);
    assert.equal(result.close!.completed, true);
    assert.equal(result.close!.error, null);
    assert.equal(result.close!.unconfirmedRequest, false);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }

  const reopened = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
  let reopenResult: ShutdownResult | null = null;
  let reopenFailed = false;
  try {
    assert.equal(reopened.session.voxel.cellAt('overworld', 7, 8, 9).observed, false);
    assert.equal(reopened.session.voxel.cellAt('overworld', 0, 0, 0).observed, true);

    reopenResult = await reopened.shutdown();
    assert.equal(reopenResult.error, null);
    assert.notEqual(reopenResult.checkpoint, null);
    assertCleanClose(reopenResult);
  } catch (err) {
    reopenFailed = true;
    throw err;
  } finally {
    if (reopenResult === null) {
      try {
        reopenResult = await reopened.shutdown();
      } catch (err) {
        if (!reopenFailed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('a capacity error keeps its primary kind/message, the fact, and a real close result', async () => {
  const { svc, dir } = await openShared({ snapshotLimits: { maxObservedCells: 1 } });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);
    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2 })]);

    // 保存失败不得抹除内存事实。
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 1).observed, true);

    result = await svc.shutdown();
    assert.ok(result.error instanceof PersistenceError);
    assert.equal(result.error.kind, 'capacity');
    assert.equal(typeof result.error.message, 'string');
    assert.equal(result.checkpoint, null);
    assert.equal(result.cancelError, null);

    // 真实 close 结果必须按实际返回，而不是被保存错误跳过。
    assert.notEqual(result.close, null);
    assert.equal(result.close!.completed, true);
    assert.equal(result.close!.error, null);
    assert.equal(result.close!.unconfirmedRequest, false);

    // 内存事实在失败保存后仍在。
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 1).observed, true);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('an injected close failure after the real worker close stays secondary and is preserved verbatim', async () => {
  const { svc, dir } = await openShared({ snapshotLimits: { maxObservedCells: 1 } });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);
    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2 })]);

    // 注入：真实 worker close 完成后才抛错，模拟 close 边界注入，不是 Worker 故障。
    const injected = new Error('injected close failure');
    const realClose = svc.session.close.bind(svc.session);
    svc.session.close = async () => {
      const actual = await realClose();
      // 注入前先确认真实 close 成功，避免实际 close 失败伪装成预期注入。
      assert.equal(actual.completed, true);
      assert.equal(actual.error, null);
      assert.equal(actual.unconfirmedRequest, false);
      throw injected;
    };

    result = await svc.shutdown();
    assert.ok(result.error instanceof PersistenceError);
    assert.equal(result.error.kind, 'capacity'); // 主保存错误保留
    assert.equal(result.checkpoint, null);
    assert.equal(result.close, null); // 绝不伪造 CloseResult
    assert.equal(result.closeError, injected); // 次关闭错误按原始对象保留
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  // unclean close：保留 fixture 供检查（不删除临时目录）。
  cleanup(dir, result);
});

test('a non-PersistenceError save object keeps its identity; close result stays separate', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);

    // 注入：保存边界抛出非 PersistenceError，服务不得重贴成 worker_communication。
    const saveSentinel = { kind: 'injected_save_object', detail: 'not a PersistenceError' };
    svc.session.checkpoint = async () => {
      throw saveSentinel;
    };

    result = await svc.shutdown();
    assert.equal(result.error, saveSentinel); // 原始对象同一性
    assert.equal(result.checkpoint, null);
    assert.equal(result.cancelError, null);
    assert.notEqual(result.close, null);
    assert.equal(result.close!.completed, true);
    assert.equal(result.close!.error, null);
    assert.equal(result.close!.unconfirmedRequest, false);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});

test('a cancel callback fault is surfaced after gating and retained through shutdown, not a clean report', async () => {
  let t = 0;
  const now = () => t;
  const { svc, dir } = await openShared({ now });
  let result: ShutdownResult | null = null;
  let failed = false;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 0, observationId: 1 })]);

    const cancelSentinel = new Error('injected cancel fault');
    svc.attach({ receiver: () => {}, cancel: () => { throw cancelSentinel; } });

    // 生命周期调用者必须在执行 stale/gating 之后看到取消失败，而不是静默成功。
    assert.throws(() => svc.interrupt(), (err) => err === cancelSentinel);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'STALE');
    svc.observe([block({ pos: { x: 1, y: 0, z: 0 }, observedAt: 1, observationId: 2 })]);
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 0).observed, false); // interrupt 后仍挂起

    // 恢复准入并再挂一个取消会失败的活动委托；关停仍要完成持久化与真实 close。
    t = 10;
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.attach({ receiver: () => {}, cancel: () => { throw cancelSentinel; } });

    result = await svc.shutdown();
    assert.equal(result.cancelError, cancelSentinel); // 显式取消诊断，不是干净关停
    assert.equal(result.error, null);
    assert.notEqual(result.checkpoint, null);
    assert.notEqual(result.close, null);
    assert.equal(result.close!.completed, true);
    assert.equal(result.close!.error, null);
    assert.equal(result.close!.unconfirmedRequest, false);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (result === null) {
      try {
        result = await svc.shutdown();
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }
  cleanup(dir, result);
});
