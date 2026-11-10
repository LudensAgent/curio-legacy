/** Offline topology-to-facts cutover. Stop the host before --execute; dry-run is read-only. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SemanticFact } from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { applyHostSemanticMigration, planHostSemanticMigration, type HostSemanticNode } from '../src/spatial/facts-adapter.ts';
import { backupDatabase } from './legacy-spatial-import.ts';

export async function cutoverFacts(options: { databasePath: string; worldId: string; execute?: boolean; backupPath?: string }) {
  const databasePath = resolve(options.databasePath);
  if (!existsSync(databasePath)) throw new Error('database does not exist: ' + databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let nodes: HostSemanticNode[];
  let existing: SemanticFact[];
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const rows = (table: string) => tables.has(table)
      ? (db.prepare('SELECT payload FROM ' + table + ' WHERE world_id = ?').all(options.worldId) as { payload: string }[]).map(row => JSON.parse(row.payload)) : [];
    nodes = rows('spatial_nodes').filter((node: HostSemanticNode) => node.id !== 'curio:migration');
    existing = ['fact_places', 'fact_resources', 'fact_containers'].flatMap(rows);
  } finally { db.close(); }
  const plan = planHostSemanticMigration(nodes, { worldId: options.worldId, existing });
  if (!options.execute) return { executed: false, report: plan.report, gaps: plan.gaps };
  if (plan.report.conflicts || plan.report.unknown) throw new Error('migration has unresolved facts: ' + JSON.stringify({ report: plan.report, gaps: plan.gaps }));
  const backup = backupDatabase(databasePath, options.backupPath ?? databasePath + '.pre-facts-' + Date.now() + '.sqlite');
  const session = await openSpatialSession({ databasePath, worldId: options.worldId, voxelLoading: 'manual', historyLoading: 'none' });
  try {
    const applied = applyHostSemanticMigration(session.facts, plan);
    if (applied.conflict) throw new Error('facts changed during offline migration');
    const checkpoint = await session.checkpoint({ completeLegacyFactsMigration: true });
    return { executed: true, report: plan.report, applied, backup, checkpointId: checkpoint.checkpointId };
  } finally { await session.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
    const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)];
  }));
  const databasePath = args.get('database'), worldId = args.get('world-id');
  if (!databasePath || !worldId) throw new Error('usage: spatial-facts-cutover --database=<path> --world-id=<id> [--execute] [--backup=<path>]');
  const result = await cutoverFacts({ databasePath, worldId, execute: process.argv.includes('--execute'), backupPath: args.get('backup') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
