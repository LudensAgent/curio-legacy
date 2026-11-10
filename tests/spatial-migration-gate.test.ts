import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LegacyStoreSummary } from 'curio-minecraft-3d-memory';
import { createInMemoryLibraryStores } from '../src/spatial/in-memory.ts';
import { checkMigrationGate } from '../src/spatial/migration-state.ts';

const W = 'world-1';
const EMPTY: LegacyStoreSummary = { fragments: 0, traversals: 0, nodes: 0, edges: 0, migrationMarker: false };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-gate-'));
  const worldMemoryPath = path.join(dir, 'world-memory.json');
  const databasePath = path.join(dir, 'spatial.sqlite');
  const stores = createInMemoryLibraryStores(W);
  return { dir, worldMemoryPath, databasePath, stores };
}

test('fresh world passes the gate', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = checkMigrationGate({
    legacyStore: EMPTY, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(result.ok, true);
  assert.equal(result.details.fragments, 0);
  assert.equal(result.details.factsMigrationReceipt, false);
});

test('old rows without a facts receipt are refused; the old marker cannot stand in for it', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const withRows: LegacyStoreSummary = { ...EMPTY, nodes: 1 };
  const blocked = checkMigrationGate({
    legacyStore: withRows, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'facts_migration_required');
  assert.equal(blocked.details.legacyMarker, false);
  assert.match(blocked.command ?? '', /spatial-facts-cutover\.ts/);

  // 旧 cutover marker 只是旧体系的标记，不是新的 facts 迁移回执。
  const marked: LegacyStoreSummary = { ...withRows, migrationMarker: true };
  const stillBlocked = checkMigrationGate({
    legacyStore: marked, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.reason, 'facts_migration_required');
  assert.equal(stillBlocked.details.legacyMarker, true);
  assert.equal(stillBlocked.details.factsMigrationReceipt, false);

  const passed = checkMigrationGate({
    legacyFactsMigrationVersion: 1,
    legacyStore: marked, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.details.factsMigrationReceipt, true);
});

test('preserved ledger records also require the facts receipt', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  stores.ledger.visit('overworld', { x: 0, y: 64, z: 0 });
  const blocked = checkMigrationGate({
    legacyStore: EMPTY, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'facts_migration_required');
  assert.ok(blocked.details.ledgerRecords > 0);
  const passed = checkMigrationGate({
    legacyFactsMigrationVersion: 1,
    legacyStore: EMPTY, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(passed.ok, true);
});

test('legacy spatial JSON or travel files require migration even with a receipt', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(worldMemoryPath, JSON.stringify({ worldId: W, landmarks: [{ id: 'old' }] }));
  const legacy = checkMigrationGate({
    legacyFactsMigrationVersion: 1, legacyStore: { ...EMPTY, migrationMarker: true },
    ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.reason, 'legacy_files');
  assert.deepEqual(legacy.details.legacyKeys, ['landmarks']);

  fs.writeFileSync(worldMemoryPath, JSON.stringify({ worldId: W, landmarks: [] }));
  fs.writeFileSync(path.join(dir, 'travel-memory.json'), JSON.stringify({ endpoints: [], traversals: [], gateways: [] }));
  const travel = checkMigrationGate({
    legacyFactsMigrationVersion: 1, legacyStore: EMPTY,
    ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(travel.ok, false);
  assert.equal(travel.reason, 'legacy_files');
  assert.equal(travel.details.travelFile, true);
});

test('a pending memory patch is refused before any other classification', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'memory-patch.json'), JSON.stringify({ landmarks: [] }));
  const result = checkMigrationGate({
    legacyStore: EMPTY, ledger: stores.ledger, worldMemoryPath, dataDir: dir, databasePath, worldId: W,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pending_patch');
});
