import fs from 'node:fs';
import path from 'node:path';
import type { LegacyStoreSummary } from 'curio-minecraft-3d-memory';
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
  /**
   * New facts-model migration receipt (`curio_semantic_migration_v1:<worldId>`).
   * Saving facts alone does not establish it; the old `curio:migration` topology
   * marker is reported separately in `legacyStore.migrationMarker` and never
   * stands in for this receipt.
   */
  legacyFactsMigrationVersion?: number;
  /** Old history/topology row counts and the old cutover marker read at open. */
  legacyStore: LegacyStoreSummary;
  /** Preserved world-scoped placement/visit/portal-crossing ledger. */
  ledger: LedgerStore;
  worldMemoryPath: string;
  dataDir: string;
  databasePath: string;
  worldId: string;
}

export interface MigrationGateResult {
  ok: boolean;
  reason?: 'legacy_files' | 'pending_patch' | 'facts_migration_required';
  details: {
    legacyKeys: string[];
    travelFile: boolean;
    placedFile: boolean;
    patchFile: boolean;
    /** Old `curio:migration` topology marker; not a facts migration receipt. */
    legacyMarker: boolean;
    /** New facts migration receipt; the only marker that can clear old rows. */
    factsMigrationReceipt: boolean;
    fragments: number;
    traversals: number;
    nodes: number;
    edges: number;
    ledgerRecords: number;
  };
  command?: string;
}

/**
 * Read-only startup gate: refuse to start on top of un-migrated spatial data.
 *
 * The gate no longer walks `history.fragments()` / `topology.nodes()`: the
 * library reports this world's old-domain row counts and marker at open, even
 * under `historyLoading:'none'`. A fresh world is allowed; any existing old
 * route/topology data (or a preserved ledger) requires the new facts migration
 * receipt. Old rows stay archived; once the receipt exists they are neither
 * loaded nor written.
 */
export function checkMigrationGate(input: MigrationGateInput): MigrationGateResult {
  const legacy = fs.existsSync(input.worldMemoryPath)
    ? JSON.parse(fs.readFileSync(input.worldMemoryPath, 'utf8')) as Record<string, unknown>
    : {};
  const legacyKeys = LEGACY_SPATIAL_KEYS.filter((key) => nonEmpty(legacy[key]));
  const travelFile = fs.existsSync(path.join(input.dataDir, 'travel-memory.json'));
  const placedFile = fs.existsSync(`${input.worldMemoryPath}.placed`);
  const patchFile = fs.existsSync(path.join(input.dataDir, 'memory-patch.json'));
  const { fragments, traversals, nodes, edges, migrationMarker } = input.legacyStore;
  const ledgerRecords = input.ledger.placedBlocks().length
    + input.ledger.chunkVisits().length
    + input.ledger.portalTraversals().length;
  const factsMigrationReceipt = (input.legacyFactsMigrationVersion ?? 0) >= 1;
  const details = {
    legacyKeys, travelFile, placedFile, patchFile,
    legacyMarker: migrationMarker, factsMigrationReceipt,
    fragments, traversals, nodes, edges, ledgerRecords,
  };
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
  const hasExistingData = fragments + traversals + nodes + edges > 0 || migrationMarker || ledgerRecords > 0;
  if (hasExistingData && !factsMigrationReceipt) {
    return {
      ok: false,
      reason: 'facts_migration_required',
      details,
      command: 'node --import tsx scripts/spatial-facts-cutover.ts --database=' + JSON.stringify(input.databasePath) + ' --world-id=' + JSON.stringify(input.worldId) + ' --execute',
    };
  }
  return { ok: true, details };
}
