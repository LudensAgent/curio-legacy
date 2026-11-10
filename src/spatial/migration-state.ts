import fs from 'node:fs';
import path from 'node:path';
import type { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import type { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';

const LEGACY_SPATIAL_KEYS = [
  'passages', 'passageArchive', 'landmarks', 'chests', 'chestOps', 'furnaces', 'gone', 'farms', 'hazards', 'visitedChunks',
] as const;

const nonEmpty = (value: unknown) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'number' ? value > 0 : Boolean(value);
};

export interface MigrationGateInput {
  legacyFactsMigrationVersion?: number;
  hasFacts?: boolean;
  topology: TopologyStore;
  history: FragmentStore;
  ledger: LedgerStore;
  worldMemoryPath: string;
  dataDir: string;
  databasePath: string;
  worldId: string;
}

export interface MigrationGateResult {
  ok: boolean;
  reason?: 'legacy_files' | 'unmarked_store' | 'pending_patch' | 'facts_migration_required';
  details: {
    legacyKeys: string[];
    travelFile: boolean;
    placedFile: boolean;
    patchFile: boolean;
    marker: boolean;
    storeRecords: number;
  };
  command?: string;
}

/**
 * Read-only startup gate: refuse to start on top of un-migrated spatial data.
 * A fresh, empty world is allowed; anything else must carry a completed marker.
 */
export function checkMigrationGate(input: MigrationGateInput): MigrationGateResult {
  const legacy = fs.existsSync(input.worldMemoryPath)
    ? JSON.parse(fs.readFileSync(input.worldMemoryPath, 'utf8')) as Record<string, unknown>
    : {};
  const legacyKeys = LEGACY_SPATIAL_KEYS.filter((key) => nonEmpty(legacy[key]));
  const travelFile = fs.existsSync(path.join(input.dataDir, 'travel-memory.json'));
  const placedFile = fs.existsSync(`${input.worldMemoryPath}.placed`);
  const patchFile = fs.existsSync(path.join(input.dataDir, 'memory-patch.json'));
  const markerNode = input.topology.getNode('curio:migration');
  const marker = markerNode !== null;
  let storeRecords = 0;
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = input.topology.nodes({ after, limit: 100 });
    storeRecords += page.items.filter((node) => (node.metadata as { curio?: unknown } | undefined)?.curio).length;
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  let fragmentAfter: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = input.history.fragments({ after: fragmentAfter, limit: 100 });
    storeRecords += page.items.filter((fragment) => (fragment.metadata as { curio?: { type?: string } } | undefined)?.curio?.type === 'passage').length;
    if (page.nextAfter === undefined) break;
    fragmentAfter = page.nextAfter;
  }
  storeRecords += input.ledger.placedBlocks().length + input.ledger.chunkVisits().length + input.ledger.portalTraversals().length;
  const details = { legacyKeys, travelFile, placedFile, patchFile, marker, storeRecords };
  const command = [
    'node --import tsx scripts/spatial-cutover.ts',
    `--world-memory=${input.worldMemoryPath}`,
    `--database=${input.databasePath}`,
    `--world-id=${input.worldId}`,
    `--mode=${legacyKeys.length || travelFile || placedFile ? 'auto' : 'normalize'}`,
    '--execute',
  ].join(' ');
  if (patchFile) return { ok: false, reason: 'pending_patch', details, command };
  if (legacyKeys.length || travelFile || placedFile) return { ok: false, reason: 'legacy_files', details, command };
  if (input.legacyFactsMigrationVersion !== undefined && input.legacyFactsMigrationVersion < 1 && (marker || storeRecords > 0 || input.hasFacts)) {
    return { ok: false, reason: 'facts_migration_required', details,
      command: 'node --import tsx scripts/spatial-facts-cutover.ts --database=' + JSON.stringify(input.databasePath) + ' --world-id=' + JSON.stringify(input.worldId) + ' --execute' };
  }
  if (input.legacyFactsMigrationVersion === undefined && storeRecords > 0 && !marker) return { ok: false, reason: 'unmarked_store', details, command };
  return { ok: true, details };
}
