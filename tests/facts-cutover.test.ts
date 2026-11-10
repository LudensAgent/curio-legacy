import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { cutoverFacts } from '../scripts/spatial-facts-cutover.ts';
import { checkMigrationGate } from '../src/spatial/migration-state.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

test('offline facts cutover preserves farm fields and commits an explicit migration receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-cutover-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    const old = await openSpatialSession({ databasePath, worldId: 'w' });
    old.topology.saveNode({ id: 'farm', worldId: 'w', dim: 'overworld', kind: 'place', source: 'program', tag: 'resource', label: 'farm: wheat', observedAt: 100,
      location: { kind: 'region', center: { x: 1, y: 64, z: 0 }, radius: 2 },
      metadata: { curio: { type: 'farm', record: { id: 'farm', dim: 'overworld', pos: { x: 1, y: 64, z: 0 }, crop: 'wheat', plantedAt: 80, cells: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], harvests: 3 } } } });
    await old.checkpoint(); await old.close();
    const dry = await cutoverFacts({ databasePath, worldId: 'w' });
    assert.equal(dry.executed, false); assert.equal(dry.report.migrated, 1);
    const result = await cutoverFacts({ databasePath, worldId: 'w', execute: true, backupPath: join(dir, 'backup.sqlite') });
    assert.equal(result.executed, true); assert.equal(existsSync(join(dir, 'backup.sqlite')), true);
    const current = await openSpatialSession({ databasePath, worldId: 'w', historyLoading: 'none' });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      const farm = current.facts.places().items[0];
      assert.equal(farm.observedAt, 100); assert.equal(farm.hostData?.farm && (farm.hostData.farm as { harvests: number }).harvests, 3);
    } finally { await current.close(); }
    const repeat = await cutoverFacts({ databasePath, worldId: 'w' });
    assert.equal(repeat.report.migrated, 0); assert.equal(repeat.report.conflicts, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startup refuses old semantic data without migration receipt and queries only new facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-gate-'));
  const databasePath = join(dir, 'spatial.sqlite');
  const shared = await SharedSpatialSession.open({ databasePath, worldId: 'w' });
  try {
    shared.session.topology.saveNode({ id: 'old', worldId: 'w', dim: 'overworld', kind: 'place', source: 'program', tag: 'resource', label: 'old ore', observedAt: 100, location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } }, metadata: { curio: { type: 'landmark' } } });
    // 该节点是在 open 之后写入的，这里用与库启动摘要同口径的显式计数模拟重开后的库。
    const input = {
      legacyStore: { fragments: 0, traversals: 0, nodes: 1, edges: 0, migrationMarker: false },
      ledger: shared.session.ledger,
      dataDir: dir, databasePath, worldId: 'w', worldMemoryPath: join(dir, 'world-memory.json'), legacyFactsMigrationVersion: 0,
    };
    assert.equal(checkMigrationGate(input).reason, 'facts_migration_required');
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    shared.session.facts.upsertResource({ id: 'new', worldId: 'w', dim: 'overworld', label: 'iron_ore', sourceCell: { x: 1, y: 64, z: 0 }, observedAt: 200, source: { source: 'vision' }, revoked: false });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 1);
    shared.session.facts.revokeResource('new', { observedAt: 300, source: { source: 'vision' } });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    assert.equal(checkMigrationGate({ ...input, legacyFactsMigrationVersion: 1 }).ok, true);
  } finally { await shared.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
