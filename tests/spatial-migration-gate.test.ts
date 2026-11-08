import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContainerLedger } from '../src/memory/container-ledger.ts';
import { createInMemoryLibraryStores } from '../src/spatial/in-memory.ts';
import { checkMigrationGate } from '../src/spatial/migration-state.ts';
import { SpatialSemanticStore } from '../src/spatial/semantic-store.ts';

const W = 'world-1';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-gate-'));
  const worldMemoryPath = path.join(dir, 'world-memory.json');
  const databasePath = path.join(dir, 'spatial.sqlite');
  const stores = createInMemoryLibraryStores(W);
  const semantic = new SpatialSemanticStore(stores, new ContainerLedger(null, W), { worldId: W });
  return { dir, worldMemoryPath, databasePath, stores, semantic };
}

test('fresh world passes the gate', (t) => {
  const { dir, worldMemoryPath, databasePath, stores } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = checkMigrationGate({ ...stores, worldMemoryPath, dataDir: dir, databasePath, worldId: W });
  assert.equal(result.ok, true);
});

test('unmarked semantic records require normalization', (t) => {
  const { dir, worldMemoryPath, databasePath, stores, semantic } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  stores.topology.saveNode({
    id: 'n1', kind: 'place', source: 'program', tag: 'base', label: '家', worldId: W,
    dim: 'overworld', location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
    metadata: { curio: { v: 1, type: 'landmark', record: { kind: 'base', label: '家' } } },
  });
  const blocked = checkMigrationGate({ ...stores, worldMemoryPath, dataDir: dir, databasePath, worldId: W });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'unmarked_store');
  semantic.writeMigrationMarker();
  const passed = checkMigrationGate({ ...stores, worldMemoryPath, dataDir: dir, databasePath, worldId: W });
  assert.equal(passed.ok, true);
});

test('legacy spatial JSON or travel files require migration even with a marker', (t) => {
  const { dir, worldMemoryPath, databasePath, stores, semantic } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  semantic.writeMigrationMarker();
  fs.writeFileSync(worldMemoryPath, JSON.stringify({ worldId: W, landmarks: [{ id: 'old' }] }));
  const legacy = checkMigrationGate({ ...stores, worldMemoryPath, dataDir: dir, databasePath, worldId: W });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.reason, 'legacy_files');
  assert.deepEqual(legacy.details.legacyKeys, ['landmarks']);

  fs.writeFileSync(worldMemoryPath, JSON.stringify({ worldId: W, landmarks: [] }));
  fs.writeFileSync(path.join(dir, 'travel-memory.json'), JSON.stringify({ endpoints: [], traversals: [], gateways: [] }));
  const travel = checkMigrationGate({ ...stores, worldMemoryPath, dataDir: dir, databasePath, worldId: W });
  assert.equal(travel.ok, false);
  assert.equal(travel.reason, 'legacy_files');
  assert.equal(travel.details.travelFile, true);
});
