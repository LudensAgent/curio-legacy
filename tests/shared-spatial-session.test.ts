/**
 * shared-session 服务的独立验收：直接驱动 src/spatial/shared-session.ts，使用安装的
 * curio-minecraft-3d-memory 0.7.5、真实 Worker 与唯一 mkdtemp 数据库。每条路径都在
 * 清理前关闭；unclean close（close 失败）时保留 fixture 供检查。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChangeReport } from 'curio-minecraft-3d-memory';
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

test('sequential attachment owners share one voxel; an old token cannot detach the replacement', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });

    const aReports: ChangeReport[] = [];
    const tokenA = svc.attach({ receiver: (r) => aReports.push(r), cancel: () => {} });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);
    assert.equal(aReports.length, 1);

    const bReports: ChangeReport[] = [];
    svc.attach({ receiver: (r) => bReports.push(r), cancel: () => {} });
    svc.detach(tokenA); // 旧 token 不应解除新附着
    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2 })]);
    assert.equal(bReports.length, 1);
    assert.equal(aReports.length, 1); // 旧 owner 不再收到

    // 两个 owner 看到的是同一个 voxel。
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 1).observed, true);

    result = await svc.shutdown();
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  cleanup(dir, result);
});

test('before beginSession and old-session late evidence are ignored', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
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
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  cleanup(dir, result);
});

test('a same-world new session cancels the active delegation (even empty), invalidates old evidence, and only a newly seen cell is fresh', async () => {
  const { svc, dir } = await openShared();
  let result: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    let cancelCount = 0;
    svc.attach({ receiver: () => {}, cancel: () => { cancelCount++; } });

    // map 为空（无观测）：切到新 session 仍取消委托。
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's2' });
    assert.equal(cancelCount, 1);

    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1, sessionId: 's2' })]);
    svc.attach({ receiver: () => {}, cancel: () => { cancelCount++; } });
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's3' });
    assert.equal(cancelCount, 2);
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'STALE');

    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2, sessionId: 's3' })]);
    assert.equal(freshness(svc, 'overworld', 1, 0, 1), 'FRESH');
    assert.equal(freshness(svc, 'overworld', 0, 0, 0), 'STALE');

    result = await svc.shutdown();
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
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

    // 恢复后的新证据被接受。
    t = 300;
    svc.observe([block({ pos: { x: 2, y: 0, z: 2 }, observedAt: 300, observationId: 4, sessionId: 's1' })]);
    assert.equal(freshness(svc, 'overworld', 2, 0, 2), 'FRESH');

    result = await svc.shutdown();
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  cleanup(dir, result);
});

test('a committed fact with properties and original timestamps checkpoints, closes, and reopens STALE', async () => {
  const { svc, dir, dbPath } = await openShared();
  let result: ShutdownResult | null = null;
  let reopenResult: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    const observedAt = 1_700_000_000_000;
    svc.observe([block({
      name: 'minecraft:oak_door',
      properties: { open: true, half: 'lower', facing: 'north' },
      pos: { x: 3, y: 4, z: 5 },
      observedAt,
      observationId: 7,
      sessionId: 's1',
    })]);

    const cell = svc.session.voxel.cellAt('overworld', 3, 4, 5);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.observation.state.properties.open, 'true');
      assert.equal(cell.evidence.observation.observedAt, observedAt);
      assert.equal(cell.evidence.observation.sequence, 7);
      assert.equal(cell.evidence.freshness, 'FRESH');
    }

    const cp = await svc.checkpoint();
    assert.equal(typeof cp.checkpointId, 'string');
    assert.equal(cp.voxelRevision >= 1, true);
    const state = svc.getPersistenceState();
    assert.equal(state.dirty, false);
    assert.equal(state.lastConfirmedCheckpointId, cp.checkpointId);

    result = await svc.shutdown();
    assert.equal(result.error, null);
    if (result.checkpoint === null) assert.fail('shutdown did not capture a final checkpoint');
    const finalCheckpoint = result.checkpoint;

    // 用实际返回的最终 checkpoint 与关停后的真实确认状态核对，而不是断言它等于先前那次 id。
    const finalState = svc.getPersistenceState();
    assert.equal(finalState.lifecycle, 'closed');
    assert.equal(finalState.lastConfirmedCheckpointId, finalCheckpoint.checkpointId);
    assert.equal(finalState.dirty, false);
    assert.equal(finalCheckpoint.voxelRevision, finalState.voxelRevision);
    assert.equal(finalCheckpoint.voxelRevision, finalState.confirmedVoxelRevision);
    assert.equal(finalCheckpoint.fragmentRevision, finalState.fragmentRevision);
    assert.equal(finalCheckpoint.fragmentRevision, finalState.confirmedFragmentRevision);
    assert.equal(finalCheckpoint.topologyRevision, finalState.topologyRevision);
    assert.equal(finalCheckpoint.topologyRevision, finalState.confirmedTopologyRevision);

    if (result.close === null) assert.fail('shutdown did not return a close result');
    assert.equal(result.close.completed, true);
    assert.equal(result.close.error, null);
    assert.equal(result.close.unconfirmedRequest, false);
    assert.equal(result.close.lastConfirmedCheckpointId, finalCheckpoint.checkpointId);
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }

  // 重新打开同一 DB：保存的事实以原始时间读回，但标记为 STALE（从不冒充当前观测）。
  const reopened = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath });
  try {
    const cell = reopened.session.voxel.cellAt('overworld', 3, 4, 5);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.freshness, 'STALE');
      assert.equal(cell.evidence.observation.observedAt, 1_700_000_000_000);
    }
    reopenResult = await reopened.shutdown();
  } finally {
    if (reopenResult === null) {
      try {
        await reopened.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  cleanup(dir, result);
});

test('a capacity error keeps its primary kind/message and leaves the in-memory fact intact', async () => {
  const { svc, dir } = await openShared({ snapshotLimits: { maxObservedCells: 1 } });
  let result: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);
    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2 })]);

    // 保存失败不得抹除内存事实。
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 1).observed, true);

    result = await svc.shutdown();
    assert.notEqual(result.error, null);
    assert.equal(result.error!.kind, 'capacity');
    assert.equal(typeof result.error!.message, 'string');
    assert.equal(result.checkpoint, null);

    // 内存事实在失败保存后仍在。
    assert.equal(svc.session.voxel.cellAt('overworld', 1, 0, 1).observed, true);
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  cleanup(dir, result);
});

test('an injected close failure after the real worker close stays secondary to an existing save error', async () => {
  const { svc, dir } = await openShared({ snapshotLimits: { maxObservedCells: 1 } });
  let result: ShutdownResult | null = null;
  try {
    svc.beginSession({ worldId: WORLD, dim: 'overworld', sessionId: 's1' });
    svc.observe([block({ pos: { x: 0, y: 0, z: 0 }, observedAt: 1, observationId: 1 })]);
    svc.observe([block({ pos: { x: 1, y: 0, z: 1 }, observedAt: 2, observationId: 2 })]);

    // 注入：真实 worker close 完成后才抛错，模拟 close 边界的注入失败。
    const injected = new Error('injected close failure');
    const realClose = svc.session.close.bind(svc.session);
    svc.session.close = async () => {
      await realClose();
      throw injected;
    };

    result = await svc.shutdown();
    assert.notEqual(result.error, null);
    assert.equal(result.error!.kind, 'capacity'); // 主保存错误保留
    assert.equal(result.checkpoint, null);
    assert.equal(result.close, null);
    assert.equal(result.closeError, injected); // 次关闭错误独立保留，标记为注入
  } finally {
    if (result === null) {
      try {
        await svc.shutdown();
      } catch {
        /* 已尽力关闭 */
      }
    }
  }
  // unclean close：保留 fixture 供检查（不删除临时目录）。
  cleanup(dir, result);
});
