/**
 * WS-3/WS-6：内存 handoff 队列超出预算时不再丢弃，而是同格合并后把溢出落到
 * 库旁 spool；drain 时按到达顺序回放。真实 SQLite、manual 驻留、独占临时库。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SectionKey } from 'curio-minecraft-3d-memory';
import type { CloseResult } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { BlockObservation } from '../src/adapter/types.ts';
import { MAX_PENDING_OBSERVATIONS, SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { SharedSpatialDiagnostic } from '../src/spatial/shared-session.ts';

const WORLD = 'handoff-spill-world';
const DIM = 'overworld';
const SESSION = 'live';

function keyAt(cx: number, cz = 0, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz, sy };
}

function observation(x: number, y: number, z: number, seq: number, name = 'minecraft:stone'): BlockObservation {
  return {
    worldId: WORLD,
    sessionId: SESSION,
    dimension: DIM,
    observationId: seq,
    observedAt: 1000 + seq,
    pos: { x, y, z },
    name,
    properties: {},
    stateComplete: true,
    source: 'vision',
  };
}

/** 同一个 Section（cx=1）内互不相同的格。 */
function cellsInSection(count: number, seqStart: number, name = 'minecraft:stone'): BlockObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const x = 16 + (index % 16);
    const z = Math.floor(index / 16) % 10;
    const y = 64 + Math.floor(index / 160);
    return observation(x, y, z, seqStart + index, name);
  });
}

async function seedOne(dbPath: string): Promise<void> {
  const seeder = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
  try {
    seeder.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    seeder.observe([observation(16, 64, 0, 1)]);
    await seeder.checkpoint();
  } finally {
    await seeder.shutdown();
  }
}

async function withManual(dbPath: string, dir: string, body: (shared: SharedSpatialSession) => Promise<void>): Promise<void> {
  const shared = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: dbPath,
    voxelLoading: 'manual',
    timeoutMs: 5000,
  });
  let close: CloseResult | null = null;
  let failed = false;
  try {
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    await body(shared);
    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (close === null) {
      try { close = (await shared.shutdown()).close; } catch { /* 已在正常路径关闭 */ }
    }
    if (!failed && close?.completed === true && close.error === null) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

test('队列溢出落到 spool，drain 按到达顺序回放且不丢证据', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spill-'));
  const dbPath = join(dir, 'memory.db');
  try {
    await seedOne(dbPath);
    await withManual(dbPath, dir, async (shared) => {
      assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'not_resident');
      const batch = cellsInSection(300, 10);
      shared.observe(batch);
      const pending = shared.pendingObservations();
      assert.equal(pending.observations, MAX_PENDING_OBSERVATIONS, '内存队列只接收预算内的条数');
      assert.equal(pending.spooled, 300 - MAX_PENDING_OBSERVATIONS, '溢出部分应落到 spool');
      assert.ok(pending.spooledBytes > 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      assert.ok(existsSync(`${dbPath}.handoff.jsonl`), 'spool 缓冲应异步落盘，不在物理帧里写盘');
      assert.match(shared.backlogNote()?.text ?? '', /44 条在磁盘等待回放/);

      await shared.drainObservations({ deadline: Date.now() + 5000 });
      const after = shared.pendingObservations();
      assert.equal(after.observations, 0, 'drain 应清空内存队列');
      assert.equal(after.spooled, 0, 'drain 应回放完 spool');
      assert.equal(shared.observationGap(), null, '溢出不应再记成丢失缺口');
      assert.equal(shared.backlogNote(), null, '回放完成后不再报告积压');
      assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident');
      // 批次两端（内存队列里的与 spool 里的）都必须真正写入。
      assert.equal(shared.session.voxel.cellAt(DIM, 16, 64, 0).observed, true);
      const last = batch[batch.length - 1]!;
      assert.equal(shared.session.voxel.cellAt(DIM, last.pos.x, last.pos.y, last.pos.z).observed, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('同一格的新观测原地替换旧 handoff，不重复占预算', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spill-'));
  const dbPath = join(dir, 'memory.db');
  try {
    await seedOne(dbPath);
    await withManual(dbPath, dir, async (shared) => {
      const batch = cellsInSection(MAX_PENDING_OBSERVATIONS, 10);
      shared.observe(batch);
      assert.equal(shared.pendingObservations().observations, MAX_PENDING_OBSERVATIONS);

      const updates = batch.slice(0, 10).map((cell, index) =>
        observation(cell.pos.x, cell.pos.y, cell.pos.z, 5000 + index, 'minecraft:dirt'));
      shared.observe(updates);
      const pending = shared.pendingObservations();
      assert.equal(pending.observations, MAX_PENDING_OBSERVATIONS, '同格更新不扩大队列');
      assert.equal(pending.spooled, 0, '同格更新不应溢出到 spool');

      await shared.drainObservations({ deadline: Date.now() + 5000 });
      const cell = shared.session.voxel.cellAt(DIM, batch[0]!.pos.x, batch[0]!.pos.y, batch[0]!.pos.z);
      assert.equal(cell.observed, true);
      if (cell.observed) {
        assert.equal(cell.evidence.observation.observedAt, 1000 + 5000);
        assert.equal(cell.evidence.observation.state.name, 'minecraft:dirt');
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('启动时清理上一进程遗留的 spool，并如实计一次丢弃', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spill-'));
  const dbPath = join(dir, 'memory.db');
  try {
    await seedOne(dbPath);
    const spoolPath = `${dbPath}.handoff.jsonl`;
    writeFileSync(spoolPath, `${JSON.stringify(observation(16, 64, 0, 1))}\n${JSON.stringify(observation(17, 64, 0, 2))}\n`);
    const shared = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, voxelLoading: 'manual', timeoutMs: 5000 });
    try {
      const discarded = shared.discardedObservations();
      assert.equal(discarded?.reason, 'interrupt');
      assert.equal(discarded?.count, 2);
      assert.equal(existsSync(spoolPath), false, '遗留 spool 应在启动时清掉');
    } finally {
      await shared.shutdown();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('spool 读取期间同作用域重复 beginSession 不会吞掉已读行', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spill-'));
  const dbPath = join(dir, 'memory.db');
  try {
    await seedOne(dbPath);
    await withManual(dbPath, dir, async (shared) => {
      const batch = cellsInSection(300, 10);
      shared.observe(batch);
      assert.equal(shared.pendingObservations().observations, MAX_PENDING_OBSERVATIONS);
      assert.equal(shared.pendingObservations().spooled, 300 - MAX_PENDING_OBSERVATIONS);

      // 让 spool 的读取在两个 await 之间停住，期间用新对象重复 beginSession（同 session/dim）。
      const spool = Reflect.get(shared, 'spool') as { readChunk: (...args: never[]) => Promise<string[]> };
      const realRead = spool.readChunk.bind(spool);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const atRead = new Promise<void>((resolve) => { started = resolve; });
      Reflect.set(spool, 'readChunk', async (...args: never[]) => {
        started();
        await gate;
        return realRead(...args);
      });

      const drain = shared.drainObservations({ deadline: Date.now() + 5000 });
      await atRead;
      shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
      release();
      await drain;

      const after = shared.pendingObservations();
      assert.equal(after.observations, 0, '读取期间的重复 beginSession 不应吞行');
      assert.equal(after.spooled, 0);
      const last = batch[batch.length - 1]!;
      assert.equal(shared.session.voxel.cellAt(DIM, last.pos.x, last.pos.y, last.pos.z).observed, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('关停诊断的 count 覆盖内存与 spool，不把溢出标成加载失败', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-spill-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  try {
    await seedOne(dbPath);
    const events: SharedSpatialDiagnostic[] = [];
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      timeoutMs: 5000,
      onWorkingSetDiagnostic: (diagnostic) => events.push(diagnostic),
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    // 只在本测试里让后台应用不工作，模拟关停时仍有内存/spool 证据的真实情形。
    Reflect.set(shared, 'fillPendingFromSpool', async () => 0);
    Reflect.set(shared, 'applyReadyPending', async () => false);
    shared.observe(cellsInSection(300, 10));
    const pending = shared.pendingObservations();
    assert.equal(pending.observations, MAX_PENDING_OBSERVATIONS);
    assert.equal(pending.spooled, 300 - MAX_PENDING_OBSERVATIONS);

    const shutdown = await shared.shutdown();
    assert.match(String((shutdown.error as Error | null)?.message ?? ''), /left 300 pending observation\(s\) unapplied/);
    const last = events.filter((event) => event.kind === 'not_ready').at(-1);
    assert.equal(last?.kind, 'not_ready');
    assert.equal(last?.count, 300, 'count 必须等于消息里的未写入总数（内存 256 + spool 44）');
  } finally {
    if (shared !== null) {
      try { await shared.shutdown(); } catch { /* 已在正常路径关闭 */ }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
