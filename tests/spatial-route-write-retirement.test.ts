/**
 * v0.11.0 第二批 B 路退役守卫：宿主旧路线写入链已删除。
 *
 * 静态：`src` 生产代码不再出现路线/片段/拓扑写入入口（fragment/traversal/corridor
 * 与旧 `MemoryIngest` 投影），防止兼容写入器重新长回来。
 * 运行时：共享会话仍保留的体素写入（markTraversed/markModified/markStale）确实
 * 写入并在 checkpoint + 重开后读回——退役没有误伤保留行为。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** 已退役的宿主路线写入入口；任何一条重新出现都说明兼容写链复活。 */
const RETIRED_WRITE_ENTRIES = [
  'recordWalkCorridor',
  'saveFragment(',
  'addTraversal(',
  'planWalkTopology',
  'makeRoomForFragment',
  'get ingest',
  'ingestPort',
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && extname(entry.name) === '.ts' ? [path] : [];
  });
}

test('生产源码不再包含旧路线写入链', () => {
  const files = sourceFiles(SRC_ROOT);
  assert.ok(files.length > 0, '静态扫描必须真的读到 src 源码');

  const hits = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return RETIRED_WRITE_ENTRIES
      .filter((needle) => source.includes(needle))
      .map((needle) => `${file}: ${needle}`);
  });
  assert.deepEqual(hits, [], '已退役的路线写入入口不得回到 src');
});

const WORLD = 'world-route-write-retirement';
const DIM = 'overworld';

test('保留的体素写入仍落盘并在重开后读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-route-write-retirement-'));
  const databasePath = join(dir, 'memory.db');
  let first: SharedSpatialSession | null = null;
  let second: SharedSpatialSession | null = null;
  try {
    first = await SharedSpatialSession.open({ worldId: WORLD, databasePath });
    first.beginSession({ worldId: WORLD, dim: DIM, sessionId: 's1' });
    // 一条真实观测证据放在另一个 Section，供 markStale 有可失效的证据；
    // traversed/modified 独立格不与它共享 Section，断言互不干扰。
    first.observe([{
      name: 'minecraft:stone', properties: {}, worldId: WORLD, sessionId: 's1', dimension: DIM,
      source: 'vision', stateComplete: true,
      pos: { x: 40, y: 64, z: 40 }, observedAt: 1000, observationId: 1,
    }]);
    assert.equal(first.markTraversed(DIM, { x: 1, y: 64, z: 1 }).status, 'written');
    assert.equal(first.markModified(DIM, { x: 2, y: 64, z: 2 }, 'action-1').status, 'written');
    assert.equal(first.markStale(DIM, 'observation_gap').status, 'written');
    await first.checkpoint();

    const closed = await first.shutdown();
    first = null;
    assert.equal(closed.error, null);
    assert.equal(closed.close?.completed, true);

    second = await SharedSpatialSession.open({ worldId: WORLD, databasePath });
    assert.equal(second.session.voxel.historyAt(DIM, 1, 64, 1).traversed, true);
    assert.equal(second.session.voxel.historyAt(DIM, 2, 64, 2).modified, true);
    const observed = second.session.voxel.cellAt(DIM, 40, 64, 40);
    assert.equal(observed.observed, true);
    // markStale 是维度级事实：重开后仍如实标记，不假装证据新鲜。
    assert.equal(observed.observed && observed.evidence.freshness, 'STALE');
  } finally {
    if (first !== null) await first.shutdown();
    if (second !== null) await second.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
