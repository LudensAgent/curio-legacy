/**
 * v0.11.0 第二批 restart/门禁专项：主会话默认 historyLoading:'none' 时，
 * 旧 Fragment/Topology 行不被加载、不被写入、不被删除；新 facts 与账本正常读回。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'legacy-startup-world';
const DIM = 'overworld';
const OBSERVED_AT = 111;

test('historyLoading none keeps legacy rows archived while facts and ledger survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-legacy-startup-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    // Seed a legacy database the way the old system left it: one fragment, one
    // semantic topology node, and preserved ledger rows.
    const seed = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      seed.history.saveFragment({
        id: 'legacy-fragment', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [],
        polyline: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }],
        geometrySource: 'traversal', deepestY: 64, createdAt: 1, lastUsedAt: 1, uses: 1,
      });
      seed.topology.saveNode({
        id: 'legacy-home', worldId: WORLD, dim: DIM, kind: 'place', source: 'program',
        tag: 'base', label: 'home', observedAt: OBSERVED_AT,
        location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
        metadata: { curio: { v: 1, type: 'landmark', record: { kind: 'base', label: 'home', observedAt: OBSERVED_AT } } },
      });
      seed.ledger.visit(DIM, { x: 0, y: 64, z: 0 });
      await seed.checkpoint();
    } finally {
      await seed.close();
    }

    const first = await SharedSpatialSession.open({ worldId: WORLD, databasePath, historyLoading: 'none' });
    try {
      const summary = first.session.legacyStoreSummary;
      assert.equal(summary.fragments, 1);
      assert.equal(summary.nodes, 1);
      assert.equal(summary.migrationMarker, false);
      // 主会话不把旧域解码进内存。
      assert.equal(first.session.history.fragments({ limit: 1 }).total, 0);
      assert.equal(first.session.topology.nodes({ limit: 1 }).total, 0);
      // 账本仍属于保留事实。
      assert.ok(first.session.ledger.chunkVisits().length > 0);

      first.session.facts.upsertPlace({
        id: 'new-fact', kind: 'base', label: 'new home', worldId: WORLD, dim: DIM,
        location: { kind: 'exact', pos: { x: 2, y: 64, z: 0 } },
        observedAt: 222, source: { source: 'vision' }, gone: false,
      });
      first.beginSession({ worldId: WORLD, dim: DIM, sessionId: 's1' });
      const marked = first.markTraversed(DIM, { x: 2, y: 64, z: 0 });
      assert.equal(marked.status, 'written');
      await first.checkpoint();
    } finally {
      await first.shutdown();
    }

    // 第二次启动：旧行计数完全不变（没有写入/删除），新 facts 与账本读回。
    const second = await SharedSpatialSession.open({ worldId: WORLD, databasePath, historyLoading: 'none' });
    try {
      assert.deepEqual(
        {
          fragments: second.session.legacyStoreSummary.fragments,
          nodes: second.session.legacyStoreSummary.nodes,
        },
        { fragments: 1, nodes: 1 },
      );
      assert.equal(second.session.facts.places({ limit: 1 }).total, 1);
      const fact = second.session.facts.places({ limit: 1 }).items[0];
      assert.equal(fact?.id, 'new-fact');
      assert.equal(fact?.observedAt, 222);
      assert.ok(second.session.ledger.chunkVisits().length > 0);
    } finally {
      await second.shutdown();
    }

    // 旧语义节点的原始观测时间在归档行里保持不变。
    const eager = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      const node = eager.topology.getNode('legacy-home');
      assert.equal(node?.observedAt, OBSERVED_AT);
      assert.equal(eager.history.getFragment('legacy-fragment')?.lastUsedAt, 1);
    } finally {
      await eager.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
