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
 * The library reports this world's old-domain row counts and marker at open as
 * read-only metadata; the session never loads or writes the retired
 * Fragment/Topology domains. A fresh world is allowed; any existing old
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
  const factsCommand = 'node --import tsx scripts/spatial-facts-cutover.ts --database=' + JSON.stringify(input.databasePath) + ' --world-id=' + JSON.stringify(input.worldId) + ' --execute';
  if (patchFile) return { ok: false, reason: 'pending_patch', details, command: factsCommand };
  if (legacyKeys.length || travelFile || placedFile) {
    // 旧 JSON 空间导入器已退役：这里不再指向不存在的 spatial-cutover。
    // 支持的一次性迁移只针对 SQLite 中已归档的旧节点行（facts cutover）；
    // 旧 JSON 中的空间字段必须由操作者归档/移出活动数据目录后再启动。
    return {
      ok: false,
      reason: 'legacy_files',
      details,
      command: 'legacy spatial JSON import is retired; archive world-memory.json spatial keys, travel-memory.json, *.placed and memory-patch.json after review, then restart. '
        + 'Archived SQLite legacy rows migrate through: ' + factsCommand,
    };
  }
  const hasExistingData = fragments + traversals + nodes + edges > 0 || migrationMarker || ledgerRecords > 0;
  if (hasExistingData && !factsMigrationReceipt) {
    return {
      ok: false,
      reason: 'facts_migration_required',
      details,
      command: factsCommand,
    };
  }
  return { ok: true, details };
}
