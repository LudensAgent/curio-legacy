import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { cutoverFacts } from '../scripts/spatial-facts-cutover.ts';
import { checkMigrationGate } from '../src/spatial/migration-state.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

async function seedLegacyNode(databasePath: string, node: Record<string, unknown>): Promise<void> {
  const bootstrap = await openSpatialSession({ databasePath, worldId: String(node.worldId ?? 'w') });
  try { await bootstrap.checkpoint(); } finally { await bootstrap.close(); }
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare('INSERT INTO spatial_nodes(world_id, seq, id, payload) VALUES (?, ?, ?, ?)')
      .run(String(node.worldId ?? 'w'), 1, String(node.id), JSON.stringify(node));
  } finally { db.close(); }
}

function rawNodeCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Number((db.prepare('SELECT count(*) n FROM spatial_nodes').get() as { n: number }).n); } finally { db.close(); }
}

test('offline facts cutover preserves farm fields and commits an explicit migration receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-cutover-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyNode(databasePath, { id: 'farm', worldId: 'w', dim: 'overworld', kind: 'place', source: 'program', tag: 'resource', label: 'farm: wheat', observedAt: 100,
      location: { kind: 'region', center: { x: 1, y: 64, z: 0 }, radius: 2 },
      metadata: { curio: { type: 'farm', record: { id: 'farm', dim: 'overworld', pos: { x: 1, y: 64, z: 0 }, crop: 'wheat', plantedAt: 80, cells: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], harvests: 3 } } } });
    const dry = await cutoverFacts({ databasePath, worldId: 'w' });
    assert.equal(dry.executed, false); assert.equal(dry.report.migrated, 1);
    const result = await cutoverFacts({ databasePath, worldId: 'w', execute: true, backupPath: join(dir, 'backup.sqlite') });
    assert.equal(result.executed, true); assert.equal(existsSync(join(dir, 'backup.sqlite')), true);
    const current = await openSpatialSession({ databasePath, worldId: 'w' });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      const farm = current.facts.places().items[0];
      assert.equal(farm.observedAt, 100); assert.equal(farm.hostData?.farm && (farm.hostData.farm as { harvests: number }).harvests, 3);
    } finally { await current.close(); }
    assert.equal(rawNodeCount(databasePath), 1, '旧 spatial_nodes 行保持原样，不被删除');
    const repeat = await cutoverFacts({ databasePath, worldId: 'w' });
    assert.equal(repeat.report.migrated, 0); assert.equal(repeat.report.conflicts, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startup refuses old semantic data without migration receipt and queries only new facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-gate-'));
  const databasePath = join(dir, 'spatial.sqlite');
  await seedLegacyNode(databasePath, { id: 'old', worldId: 'w', dim: 'overworld', kind: 'place', source: 'program', tag: 'resource', label: 'old ore', observedAt: 100, location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } }, metadata: { curio: { type: 'landmark' } } });
  const shared = await SharedSpatialSession.open({ databasePath, worldId: 'w' });
  try {
    const input = {
      legacyStore: shared.session.legacyStoreSummary,
      ledger: shared.session.ledger,
      dataDir: dir, databasePath, worldId: 'w', worldMemoryPath: join(dir, 'world-memory.json'), legacyFactsMigrationVersion: 0,
    };
    assert.equal(input.legacyStore.nodes, 1);
    assert.equal(checkMigrationGate(input).reason, 'facts_migration_required');
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    shared.session.facts.upsertResource({ id: 'new', worldId: 'w', dim: 'overworld', label: 'iron_ore', sourceCell: { x: 1, y: 64, z: 0 }, observedAt: 200, source: { source: 'vision' }, revoked: false });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 1);
    shared.session.facts.revokeResource('new', { observedAt: 300, source: { source: 'vision' } });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    assert.equal(checkMigrationGate({ ...input, legacyFactsMigrationVersion: 1 }).ok, true);
    assert.equal(rawNodeCount(databasePath), 1, '新事实查询不删除旧行');
  } finally { await shared.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
