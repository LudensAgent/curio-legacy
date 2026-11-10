/**
 * v0.11.0 第二批 P2 回归：显式 eager 兼容读取旧长片段。
 *
 * 旧库中已有超过库默认 4096 条的合法 fragment links。eager 是兼容诊断入口，
 * 必须能读回旧数据；生产默认 historyLoading:'none' 不加载旧域。关闭重开不得
 * 改写旧行。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';

const WORLD = 'world-legacy-eager-links';
const DIM = 'overworld';
/** 超过库默认 4096；旧线上片段曾出现 4107 条。 */
const LINK_COUNT = 4107;

const links = Array.from({ length: LINK_COUNT }, (_, index) => ({
  a: { x: index, y: 64, z: 0 },
  b: { x: index + 1, y: 64, z: 0 },
}));

function legacyFragment() {
  return {
    id: 'legacy-long-corridor',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked' as const,
    geometrySource: 'traversal' as const,
    polyline: [{ x: 0, y: 64, z: 0 }, { x: LINK_COUNT, y: 64, z: 0 }],
    entrances: [{ x: 0, y: 64, z: 0 }],
    links,
    deepestY: 64,
    createdAt: 1000,
    lastUsedAt: 2000,
    uses: 3,
    externalRef: 'legacy-corridor',
  };
}

async function seedLegacyDatabase(databasePath: string): Promise<void> {
  // 旧写入/迁移工具使用自己的 legacy 容量；这里只准备一份已提交的旧库。
  const writer = await openSpatialSession({
    worldId: WORLD,
    databasePath,
    timeoutMs: 5000,
    fragmentOptions: { maxLinks: 16_384 },
  });
  writer.history.saveFragment(legacyFragment());
  const checkpoint = await writer.checkpoint();
  assert.equal(checkpoint.fragmentRevision > 0, true);
  const closed = await writer.close();
  assert.equal(closed.completed, true);
  assert.equal(closed.error, null);
}

function assertCleanClose(result: ShutdownResult): void {
  assert.equal(result.close?.completed, true);
  assert.equal(result.close?.error, null);
  assert.equal(result.close?.dirty, false);
}

test('eager reads legacy fragments above the library default link cap; none does not load; rows survive reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-legacy-eager-links-'));
  const databasePath = join(dir, 'memory.db');
  try {
    await seedLegacyDatabase(databasePath);

    const eager = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath,
      historyLoading: 'eager',
      timeoutMs: 5000,
    });
    const restored = eager.session.history.getFragment('legacy-long-corridor');
    assert.ok(restored !== null, 'eager 必须恢复旧片段');
    assert.equal(restored.links?.length, LINK_COUNT);
    assert.deepEqual(restored, legacyFragment());
    assert.equal(eager.session.legacyStoreSummary.fragments, 1);
    assertCleanClose(await eager.shutdown());

    const none = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath,
      historyLoading: 'none',
      timeoutMs: 5000,
    });
    assert.equal(none.session.history.fragments({ limit: 1 }).total, 0, 'none 不把旧域加载进内存');
    assert.equal(none.session.legacyStoreSummary.fragments, 1, '旧行仍在库中，只是未加载');
    assertCleanClose(await none.shutdown());

    const reopened = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath,
      historyLoading: 'eager',
      timeoutMs: 5000,
    });
    assert.deepEqual(reopened.session.history.getFragment('legacy-long-corridor'), legacyFragment(), '关闭重开不改写旧行');
    assertCleanClose(await reopened.shutdown());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
