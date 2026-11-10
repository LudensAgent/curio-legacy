/**
 * v0.11 restart/门禁专项：旧 Fragment/Topology 行只作为归档元数据存在，
 * 不被加载、写入或删除；新 facts 与账本正常读回。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'legacy-startup-world';
const DIM = 'overworld';
const OBSERVED_AT = 111;

function seedRawRows(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare('INSERT INTO path_fragments(world_id, seq, id, payload) VALUES (?, ?, ?, ?)').run(
      WORLD, 1, 'legacy-fragment', JSON.stringify({
        id: 'legacy-fragment', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [],
        polyline: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }],
        geometrySource: 'traversal', deepestY: 64, createdAt: 1, lastUsedAt: 1, uses: 1,
      }),
    );
    db.prepare('INSERT INTO spatial_nodes(world_id, seq, id, payload) VALUES (?, ?, ?, ?)').run(
      WORLD, 1, 'legacy-home', JSON.stringify({
        id: 'legacy-home', worldId: WORLD, dim: DIM, kind: 'place', source: 'program',
        tag: 'base', label: 'home', observedAt: OBSERVED_AT,
        location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
        metadata: { curio: { v: 1, type: 'landmark', record: { kind: 'base', label: 'home', observedAt: OBSERVED_AT } } },
      }),
    );
  } finally { db.close(); }
}

function rawRowSnapshot(databasePath: string): { fragments: number; nodes: number; observedAt: number | null; lastUsedAt: number | null } {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const fragments = Number((db.prepare('SELECT count(*) n FROM path_fragments').get() as { n: number }).n);
    const nodes = Number((db.prepare('SELECT count(*) n FROM spatial_nodes').get() as { n: number }).n);
    const row = db.prepare("SELECT payload FROM spatial_nodes WHERE id='legacy-home'").get() as { payload: string } | undefined;
    const fragment = db.prepare("SELECT payload FROM path_fragments WHERE id='legacy-fragment'").get() as { payload: string } | undefined;
    return {
      fragments, nodes,
      observedAt: row === undefined ? null : Number((JSON.parse(row.payload) as { observedAt?: number }).observedAt ?? NaN),
      lastUsedAt: fragment === undefined ? null : Number((JSON.parse(fragment.payload) as { lastUsedAt?: number }).lastUsedAt ?? NaN),
    };
  } finally { db.close(); }
}

test('retired rows stay archived while facts and ledger survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-legacy-startup-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    // 先让库创建 schema，再按旧系统留下的原始 SQLite 行形态写入归档数据。
    const seed = await openSpatialSession({ databasePath, worldId: WORLD });
    try { seed.ledger.visit(DIM, { x: 0, y: 64, z: 0 }); await seed.checkpoint(); } finally { await seed.close(); }
    seedRawRows(databasePath);
    const before = rawRowSnapshot(databasePath);

    const first = await SharedSpatialSession.open({ worldId: WORLD, databasePath });
    try {
      const summary = first.session.legacyStoreSummary;
      assert.equal(summary.fragments, 1);
      assert.equal(summary.nodes, 1);
      assert.equal(summary.migrationMarker, false);
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

    const second = await SharedSpatialSession.open({ worldId: WORLD, databasePath });
    try {
      assert.deepEqual(
        { fragments: second.session.legacyStoreSummary.fragments, nodes: second.session.legacyStoreSummary.nodes },
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

    assert.deepEqual(rawRowSnapshot(databasePath), before, '旧行与原始 observedAt/lastUsedAt 完全不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
