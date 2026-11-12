/**
 * WS-1/WS-2：同步观测写不下时交给后台 handoff；后台在容量拒绝时按批换出、必要时
 * 按需保存一次再重试，而不是等下一次 30s checkpoint。真实 SQLite、manual 驻留、独占临时库。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { SectionKey } from 'curio-minecraft-3d-memory';
import type { CloseResult } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'working-set-capacity-world';
const DIM = 'overworld';
const SESSION = 'live';

function keyAt(cx: number, cz = 0, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz, sy };
}

function observation(x: number, z: number, seq: number, session = SESSION, name = 'minecraft:stone'): BlockObservation {
  return {
    worldId: WORLD,
    sessionId: session,
    dimension: DIM,
    observationId: seq,
    observedAt: 1000 + seq,
    pos: { x, y: 64, z },
    name,
    properties: {},
    stateComplete: true,
    source: 'vision',
  };
}

function scatter(cx: number, rows: number, from: number, session = SESSION, name = 'minecraft:stone'): BlockObservation[] {
  return Array.from({ length: rows * 16 }, (_, index) => observation(cx * 16 + (index % 16), Math.floor(index / 16), from + index, session, name));
}

async function withShared(limits: { maxResidentBytes?: number }, body: (shared: SharedSpatialSession) => Promise<void>): Promise<ShutdownResult> {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-capacity-'));
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: join(dir, 'memory.db'),
      voxelLoading: 'manual',
      residencyLimits: limits,
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    await body(shared);
    const shutdown = await shared.shutdown();
    close = shutdown.close;
    return shutdown;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (shared !== null) {
      try { close ??= (await shared.shutdown()).close; } catch { /* 已在正常路径关闭 */ }
    }
    if (!failed && close?.completed === true && close.error === null) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

test('驻留观测命中字节上限时换出冷 section 并重试同一批，不丢证据', { timeout: 30_000 }, async () => {
  // 300KB 预算装得下 A 的 96 格（约 87KB）与 B 的一整批（约 219KB）；两者相加会撞上限。
  const shutdown = await withShared({ maxResidentBytes: 300_000 }, async (shared) => {
    // A：先驻留，再保存成已提交、非 dirty，成为唯一可换出的冷页。
    shared.observe(scatter(0, 6, 1));
    await shared.checkpoint();
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'resident');

    // B：先写一格成为 resident（走首观测路径），再一批写满到超过字节上限。
    shared.observe([observation(16, 0, 200)]);
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident');
    shared.observe(scatter(1, 16, 300).filter((b) => !(b.pos.x === 16 && b.pos.z === 0)));
    await shared.drainObservations({ deadline: Date.now() + 5000 });

    assert.equal(shared.observationGap(), null, '换出后重试应成功，不应留下容量缺口');
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'not_resident', '冷页 A 应被换出');
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident', '写入目标 B 仍在驻留');
    const cell = shared.session.voxel.cellAt(DIM, 31, 64, 8);
    assert.equal(cell.observed, true, '重试同一批后新格应真正写入');
    if (cell.observed) assert.equal(cell.evidence.observation.state.name, 'minecraft:stone');
  });
  assert.equal(shutdown.error, null);
});

test('没有可换出的冷页时如实留下容量缺口，并带上换出拒绝原因', { timeout: 30_000 }, async () => {
  const shutdown = await withShared({ maxResidentBytes: 300_000 }, async (shared) => {
    shared.observe(scatter(0, 6, 1));
    await shared.checkpoint();
    const held = await shared.prepare([keyAt(0)], { deadline: Date.now() + 5000 });
    assert.equal(held.status, 'ready');
    if (held.status !== 'ready') return;
    try {
      shared.observe([observation(16, 0, 200)]);
      shared.observe(scatter(1, 16, 300).filter((b) => !(b.pos.x === 16 && b.pos.z === 0)));
      await shared.drainObservations({ deadline: Date.now() + 5000 });
      const gap = shared.observationGap();
      assert.equal(gap?.kind, 'byte_capacity');
      assert.match(gap?.message ?? '', /free evicted 0 section\(s\); rejected 2 pinned/);
      assert.equal(shared.session.voxel.cellAt(DIM, 31, 64, 8).observed, false, '没换出空间时不能假装写入');
    } finally {
      shared.release(held.lease.token);
    }
  });
  assert.match(String((shutdown.error as Error | null)?.message ?? ''), /left \d+ pending observation\(s\) unapplied/, '未写入的证据必须作为关停事实保留');
});

test('换入命中容量时按需保存一次，dirty 换出后重试同一批换入成功', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-capacity-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    // 先用 eager 会话把 A（cx=0，96 格，约 87KB）提交到磁盘，并真实关闭。
    const seeder = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
    seeder.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    seeder.observe(scatter(0, 6, 1));
    await seeder.checkpoint();
    (await seeder.shutdown()).close;

    // 100KB 只装得下一个 87KB section：B 驻留且 dirty，A 已保存但未驻留。
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentBytes: 100_000 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe(scatter(1, 6, 100));
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident');
    assert.equal(shared.observationGap(), null);

    // A 的更新只能换入后写；换入会先撞上 dirty 的 B，按需保存后 B 可换出。
    shared.observe([observation(0, 0, 3000, SESSION, 'minecraft:dirt')]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0, '按需保存后应完成换入与应用');
    assert.equal(shared.observationGap(), null, '可恢复的容量失败不应记成缺口');
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'resident');
    const cell = shared.session.voxel.cellAt(DIM, 0, 64, 0);
    assert.equal(cell.observed, true);
    if (cell.observed) {
      assert.equal(cell.evidence.observation.observedAt, 4000);
      assert.equal(cell.evidence.observation.state.name, 'minecraft:dirt');
    }
    assert.notEqual(shared.lastPostSaveEviction(), null, '按需保存真实执行过（换出可能由随后的 prepare evictToFit 完成）');

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (shared !== null && close === null) {
      try { close = (await shared.shutdown()).close; } catch { /* 已在正常路径关闭 */ }
    }
    if (!failed && close?.completed === true && close.error === null) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

/** 在同一个 Section（cx）里铺 layered 层、每层 16×16 的格；用于制造 >1MiB 的驻留集。 */
function layered(cx: number, layers: number, from: number): BlockObservation[] {
  const out: BlockObservation[] = [];
  for (let layer = 0; layer < layers; layer++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        out.push({
          ...observation(cx * 16 + x, z, from + out.length, SESSION),
          pos: { x: cx * 16 + x, y: 64 + layer, z },
        });
      }
    }
  }
  return out;
}

test('容量恢复的换出目标是有界的：只淘汰足够的冷页，不清空全部驻留', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-capacity-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    // A（cx=0）与 C（cx=2）各 1400 格（约 1.2MB），先保存成可换出的冷页。
    const seeder = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
    seeder.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    seeder.observe([...layered(0, 6, 1).slice(0, 1400), ...layered(2, 6, 2000).slice(0, 1400)]);
    await seeder.checkpoint();
    (await seeder.shutdown()).close;

    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      // A+C ≈2.41MB；再加 B 的首观测 ≈1.2MB，B 的 300 格批次会顶破 3.7MB。
      residencyLimits: { maxResidentBytes: 3_700_000 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });

    // 把 A、C 换入并写入新观测；保存后两者都 clean，是 free 的候选。
    shared.observe(layered(0, 6, 5000).slice(0, 1400));
    shared.observe(layered(2, 6, 7000).slice(0, 1400));
    await shared.drainObservations({ deadline: Date.now() + 5000 });
    await shared.checkpoint();
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'resident');
    assert.equal(shared.session.sectionResidency(keyAt(2)).residency, 'resident');

    // B：首观测驻留，随后一批新格撞上限；恢复只需淘汰最旧的 A。
    shared.observe(layered(1, 6, 9000).slice(0, 1400));
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident');
    const batch = Array.from({ length: 300 }, (_, index) => ({
      ...observation(16 + (index % 16), 0, 11000 + index, SESSION),
      pos: { x: 16 + (index % 16), y: 70 + Math.floor(index / 256), z: Math.floor(index / 16) % 16 },
    }));
    shared.observe(batch);
    await shared.drainObservations({ deadline: Date.now() + 5000 });

    assert.equal(shared.observationGap(), null, '有界换出应让重试成功');
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'not_resident', '最旧的 A 被换出');
    assert.equal(shared.session.sectionResidency(keyAt(2)).residency, 'resident', 'C 不该被一起清空');
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'resident', '本批 B 仍在驻留');
    const last = batch[batch.length - 1]!;
    assert.equal(shared.session.voxel.cellAt(DIM, last.pos.x, last.pos.y, last.pos.z).observed, true);

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (shared !== null && close === null) {
      try { close = (await shared.shutdown()).close; } catch { /* 已在正常路径关闭 */ }
    }
    if (!failed && close?.completed === true && close.error === null) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test('计数上限拒绝时按本批新增 Section 数腾位（跨多个 no_record Section）', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-capacity-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  let close: CloseResult | null = null;
  let failed = false;
  try {
    // A、B 先保存；重新打开后把它们换入并保存成 clean，占住 2/3 个 Section 名额。
    const seeder = await SharedSpatialSession.open({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
    seeder.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    seeder.observe([observation(0, 0, 1), observation(16, 0, 2)]);
    await seeder.checkpoint();
    (await seeder.shutdown()).close;

    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentSections: 3 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe([observation(0, 0, 500), observation(16, 0, 501)]);
    await shared.drainObservations({ deadline: Date.now() + 5000 });
    await shared.checkpoint();
    assert.equal(shared.workingSetStats().residentSections, 2);

    // 一批 3 格分别落在 3 个 no_record Section：2 驻留 + 3 新 > 3。
    shared.observe([observation(48, 0, 900), observation(64, 0, 901), observation(80, 0, 902)]);
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0, '按本批 Section 数腾位后应完成首观测');
    assert.equal(shared.observationGap(), null);
    assert.equal(shared.workingSetStats().residentSections, 3, '三个新 Section 都在驻留');
    assert.equal(shared.session.sectionResidency(keyAt(0)).residency, 'not_resident', '旧 A 被换出');
    assert.equal(shared.session.sectionResidency(keyAt(1)).residency, 'not_resident', '旧 B 被换出');
    assert.equal(shared.session.sectionResidency(keyAt(3)).residency, 'resident');
    assert.equal(shared.session.sectionResidency(keyAt(4)).residency, 'resident');
    assert.equal(shared.session.sectionResidency(keyAt(5)).residency, 'resident');

    const shutdown = await shared.shutdown();
    close = shutdown.close;
    assert.equal(shutdown.error, null);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (shared !== null && close === null) {
      try { close = (await shared.shutdown()).close; } catch { /* 已在正常路径关闭 */ }
    }
    if (!failed && close?.completed === true && close.error === null) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});
