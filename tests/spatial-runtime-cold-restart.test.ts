/**
 * B4 宿主运行时冷存链路探针（非实机验收）。
 *
 * 真实 SQLite + 真实 manual `SharedSpatialSession`：多 Section 持续观察、分批保存、
 * 保存后按容量目标换出、重新观察已换出页面、真实关停后重开并读回原始观测时间。
 * 规模远小于库既有 4M/530MiB 证据；这里验证宿主接线，不重复生成大数据。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'runtime-cold-world';
const DIM = 'overworld';
const SESSION = 'runtime-cold-session';
const OBSERVED_AT = 1_700_000_000_000;

function sectionKey(cx: number) {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy: 0 };
}

function cellObservation(cx: number, lx: number, ly: number, lz: number, id: number): BlockObservation {
  return {
    worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: id,
    observedAt: OBSERVED_AT + id, pos: { x: cx * 16 + lx, y: ly, z: lz },
    name: ly === 0 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, source: 'vision',
  };
}

function sectionCells(cx: number, idBase: number): BlockObservation[] {
  const out: BlockObservation[] = [];
  for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    out.push(cellObservation(cx, lx, ly, lz, idBase + out.length));
  }
  return out;
}

test('runtime observe → bounded save → eviction → reload → restart keeps original times', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-cold-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  try {
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentSections: 4 },
      voxelBatchMaxBytes: 64 * 1024,
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    for (let cx = 0; cx < 4; cx++) {
      shared.observe(sectionCells(cx, cx * 4096 + 1));
    }
    const drained = await shared.drainObservations({ deadline: Date.now() + 20_000 });
    assert.equal(drained.pending.observations, 0);
    for (let cx = 0; cx < 4; cx++) assert.equal(shared.session.sectionResidency(sectionKey(cx)).residency, 'resident');

    // 小批次保存直到 clean；每次 checkpoint 只捕获一个有界 dirty 批次。
    let batches = 0;
    while (shared.getPersistenceState().dirty) {
      await shared.checkpoint();
      batches += 1;
      assert.ok(batches < 32, '有限批次内必须前进到 clean');
    }
    assert.ok(batches > 1, `小批次应产生多次 checkpoint；实际 ${batches}`);
    assert.ok(shared.workingSetStats().residentSections <= 3, '保存后只淘汰到容量目标');
    const savedStats = shared.workingSetStats();
    console.log(`RUNTIME_COLD ${JSON.stringify({
      batches,
      residentSections: savedStats.residentSections,
      residentBytes: savedStats.residentBytes,
      counters: savedStats.counters,
      eviction: shared.lastPostSaveEviction(),
    })}`);

    const evicted = [0, 1, 2, 3].find((cx) => shared!.session.sectionResidency(sectionKey(cx)).residency === 'not_resident');
    assert.ok(evicted !== undefined, '应有一个已提交冷页被换出');
    const evictedCell = { cx: evicted, lx: 3, ly: 0, lz: 7 };

    // 重新观察已换出的页面：真实 handoff 加载后应用，旧邻居时间不变。
    const newObservedAt = OBSERVED_AT + 999_999;
    shared.observe([{
      ...cellObservation(evictedCell.cx, evictedCell.lx, evictedCell.ly, evictedCell.lz, 999_999),
      observedAt: newObservedAt,
      name: 'minecraft:dirt',
    }]);
    const reloaded = await shared.drainObservations({ deadline: Date.now() + 20_000 });
    assert.equal(reloaded.pending.observations, 0);
    assert.equal(shared.session.sectionResidency(sectionKey(evicted)).residency, 'resident');
    const changed = shared.session.voxel.cellAt(DIM, evictedCell.cx * 16 + evictedCell.lx, evictedCell.ly, evictedCell.lz);
    assert.equal(changed.observed, true);
    if (changed.observed) {
      assert.equal(changed.evidence.observation.observedAt, newObservedAt);
      assert.equal(changed.evidence.observation.state.name, 'minecraft:dirt');
    }
    const neighbour = shared.session.voxel.cellAt(DIM, evictedCell.cx * 16 + evictedCell.lx + 1, evictedCell.ly, evictedCell.lz);
    assert.equal(neighbour.observed, true);
    if (neighbour.observed) assert.equal(
      neighbour.evidence.observation.observedAt,
      OBSERVED_AT + evicted * 4096 + 1 + (evictedCell.ly * 256 + evictedCell.lz * 16 + evictedCell.lx + 1),
      '重新观察一格不得刷新邻格原始时间',
    );

    const shutdown = await shared.shutdown();
    shared = null;
    assert.equal(shutdown.error, null);
    assert.equal(shutdown.close?.completed, true);

    // 真实重启：manual 不预载；按需 prepare 后读回原始状态与时间，freshness 保持 STALE。
    const reopened = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      residencyLimits: { maxResidentSections: 4 },
      timeoutMs: 5000,
    });
    try {
      const prepared = await reopened.prepare([sectionKey(0), sectionKey(3)], { deadline: Date.now() + 10_000 });
      assert.equal(prepared.status, 'ready');
      if (prepared.status === 'ready') {
        for (const cx of [0, 3]) {
          const cell = reopened.session.voxel.cellAt(DIM, cx * 16 + 2, 1, 5);
          assert.equal(cell.observed, true, `Section ${cx} 应可读回`);
          if (cell.observed) {
            assert.equal(cell.evidence.freshness, 'STALE', '重启后的旧证据不能伪装成 FRESH');
            assert.equal(cell.evidence.observation.state.name, 'minecraft:air');
            assert.ok(cell.evidence.observation.observedAt >= OBSERVED_AT, '原始观测时间必须保留');
          }
        }
        const earliest = reopened.session.voxel.cellAt(DIM, 0, 0, 0);
        assert.equal(earliest.observed, true);
        if (earliest.observed) {
          assert.equal(earliest.evidence.observation.state.name, 'minecraft:stone');
          assert.equal(earliest.evidence.observation.observedAt, OBSERVED_AT + 1);
        }
      } else {
        assert.fail('重启后已保存 Section 应能按需加载');
      }
    } finally {
      await reopened.shutdown();
    }
  } finally {
    if (shared !== null) await shared.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
