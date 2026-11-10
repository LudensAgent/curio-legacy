/** Offline topology-to-facts cutover. Stop the host before --execute; dry-run is read-only. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SemanticFact } from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { DEFAULT_SNAPSHOT_MAX_MB } from '../src/spatial/shared-session.ts';
import {
  applyHostSemanticMigration,
  planHostSemanticMigration,
  type HostFactGap,
  type HostSemanticNode,
} from '../src/spatial/facts-adapter.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import { backupDatabase } from './backup-database.ts';

type ArchiveEntry = { id: string; reason: string };

/** Historical route rows are only read here as payload evidence. */
type LegacySpatialEdge = {
  from?: string;
  to?: string;
  source?: string;
  basis?: string;
  refs?: readonly unknown[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

const pointOf = (value: unknown): Vec3Like | undefined =>
  isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number'
    && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
    ? { x: value.x, y: value.y, z: value.z }
    : undefined;

/** Route endpoints must carry an exact location; the flat `pos` fallback is not route evidence. */
const exactPointOf = (node: HostSemanticNode): Vec3Like | undefined =>
  node.location?.kind === 'exact' ? pointOf(node.location.pos) : undefined;

const pointsEqual = (a: Vec3Like, b: Vec3Like): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** Any nonempty metadata is kept as semantic/unknown rather than inferred as route-only. */
const hasNonEmptyMetadata = (metadata: unknown): boolean => {
  if (metadata === undefined || metadata === null) return false;
  if (typeof metadata === 'string') return metadata.length > 0;
  if (typeof metadata === 'object') {
    return Array.isArray(metadata) ? metadata.length > 0 : Object.keys(metadata).length > 0;
  }
  return true;
};

/**
 * A place endpoint is route geometry only when a confirmed walk edge proves it:
 * the edge resolves to two legacy nodes, is a traversed `confirmed_walk_path`,
 * and carries a `confirmed_traversal` snapshot whose world, dimension and exact
 * endpoint coordinates match. Labels, tags and metadata veto the inference.
 */
const routeGeometrySkips = (
  nodes: readonly HostSemanticNode[],
  edges: readonly LegacySpatialEdge[],
  worldId: string,
): Map<string, HostFactGap> => {
  const nodeById = new Map(nodes.flatMap(node =>
    nonEmpty(node.id) ? [[node.id, node] as const] : []));
  const skipped = new Map<string, HostFactGap>();
  for (const edge of edges) {
    if (edge.source !== 'confirmed_walk_path' || edge.basis !== 'traversed') continue;
    const from = nonEmpty(edge.from) ? nodeById.get(edge.from) : undefined;
    const to = nonEmpty(edge.to) ? nodeById.get(edge.to) : undefined;
    if (from === undefined || to === undefined || from === to) continue;
    if (from.worldId !== worldId || to.worldId !== worldId) continue;
    if (!nonEmpty(from.dim) || from.dim !== to.dim) continue;
    const fromPoint = exactPointOf(from);
    const toPoint = exactPointOf(to);
    if (fromPoint === undefined || toPoint === undefined) continue;
    const proven = (Array.isArray(edge.refs) ? edge.refs : [])
      .flatMap(ref => isRecord(ref) && isRecord(ref.snapshot) ? [ref.snapshot] : [])
      .some(candidate => {
        if (candidate.source !== 'confirmed_traversal') return false;
        if (candidate.worldId !== worldId || candidate.dim !== from.dim) return false;
        const snapshotFrom = pointOf(candidate.from);
        const snapshotTo = pointOf(candidate.to);
        return snapshotFrom !== undefined && snapshotTo !== undefined
          && pointsEqual(snapshotFrom, fromPoint) && pointsEqual(snapshotTo, toPoint);
      });
    if (!proven) continue;
    for (const node of [from, to]) {
      const id = nonEmpty(node.id);
      if (id === undefined || skipped.has(id)) continue;
      if (node.kind !== 'place' || node.source !== 'agent') continue;
      if (nonEmpty(node.label) || nonEmpty(node.tag) || hasNonEmptyMetadata(node.metadata)) continue;
      if (exactPointOf(node) === undefined) continue;
      skipped.set(id, { id, reason: 'route_geometry', detail: 'proven confirmed traversal endpoint' });
    }
  }
  return skipped;
};

/** Boundary validation runs before the plan, execution and any backup write. */
const validateArchiveEntries = (entries: readonly ArchiveEntry[] | undefined): ArchiveEntry[] => {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error('archive must be an array of {id, reason} objects');
  const ids = new Set<string>();
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error('archive entries must be {id, reason} objects');
    const id = typeof entry.id === 'string' ? entry.id : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    if (id.trim().length === 0) throw new Error('archive entry id must be nonempty');
    if (reason.trim().length === 0) throw new Error('archive entry reason must be nonempty');
    if (ids.has(id)) throw new Error('archive contains duplicate id: ' + id);
    ids.add(id);
    return { id, reason };
  });
};

const readArchiveFile = (path: string): ArchiveEntry[] => {
  const resolved = resolve(path);
  const text = readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(text) as ArchiveEntry[];
  } catch {
    throw new Error('archive file must contain valid JSON: ' + resolved);
  }
};

export async function cutoverFacts(options: {
  databasePath: string;
  worldId: string;
  execute?: boolean;
  backupPath?: string;
  archiveNodes?: readonly { id: string; reason: string }[];
}) {
  const databasePath = resolve(options.databasePath);
  if (!existsSync(databasePath)) throw new Error('database does not exist: ' + databasePath);
  const archiveNodes = validateArchiveEntries(options.archiveNodes);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let nodes: HostSemanticNode[];
  let edges: LegacySpatialEdge[];
  let existing: SemanticFact[];
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const payloads = (table: string, strict: boolean): unknown[] => tables.has(table)
      ? (db.prepare('SELECT id, payload FROM ' + table + ' WHERE world_id = ?').all(options.worldId) as { id: string; payload: string }[])
        .flatMap((row) => {
          let payload: unknown;
          try { payload = JSON.parse(row.payload); }
          catch {
            if (!strict) return [];
            throw new Error(`malformed JSON payload in ${table} row ${row.id}; refusing before plan/backup`);
          }
          if (strict && !isRecord(payload)) {
            throw new Error(`malformed non-object payload in ${table} row ${row.id}; refusing before plan/backup`);
          }
          return [payload];
        })
      : [];
    nodes = payloads('spatial_nodes', true)
      .flatMap(value => isRecord(value) ? [value as HostSemanticNode] : [])
      .filter((node: HostSemanticNode) => node.id !== 'curio:migration');
    // Edges are evidence only: malformed payloads simply prove nothing.
    edges = payloads('spatial_edges', false).flatMap(value => isRecord(value) ? [value as LegacySpatialEdge] : []);
    existing = ['fact_places', 'fact_resources', 'fact_containers']
      .flatMap(table => payloads(table, true))
      .flatMap(value => isRecord(value) ? [value as SemanticFact] : []);
  } finally { db.close(); }

  const sourceById = new Map(nodes.flatMap(node => nonEmpty(node.id) ? [[node.id, node] as const] : []));
  const missing = archiveNodes.find(entry => !sourceById.has(entry.id));
  if (missing !== undefined) throw new Error('archive id is not a source legacy node: ' + missing.id);
  const archivedIds = new Set(archiveNodes.map(entry => entry.id));
  const archived = archiveNodes.flatMap(entry => {
    const node = sourceById.get(entry.id);
    return node === undefined ? [] : [{ id: entry.id, reason: entry.reason, node }];
  });

  const routeSkips = routeGeometrySkips(nodes, edges, options.worldId);
  const routeGaps = [...routeSkips.values()].filter(gap => gap.id !== undefined && !archivedIds.has(gap.id));
  const routeIds = routeGaps.flatMap(gap => gap.id === undefined ? [] : [gap.id]);
  const retainedNodes = nodes.filter(node => {
    const id = nonEmpty(node.id);
    return id === undefined || (!archivedIds.has(id) && !routeSkips.has(id));
  });
  const plan = planHostSemanticMigration(retainedNodes, { worldId: options.worldId, existing });
  // The adapter reports its own route gaps; append the edge-proven endpoint skips.
  const gaps = [...plan.gaps, ...routeGaps];
  const report = {
    ...plan.report,
    skippedRoute: plan.report.skippedRoute + routeGaps.length,
    skippedRouteIds: [...plan.report.skippedRouteIds, ...routeIds],
  };
  if (!options.execute) return { executed: false, report, gaps, archived };
  if (report.conflicts || report.unknown) throw new Error('migration has unresolved facts: ' + JSON.stringify({ report, gaps }));
  const backup = backupDatabase(databasePath, options.backupPath ?? databasePath + '.pre-facts-' + Date.now() + '.sqlite');
  const session = await openSpatialSession({ databasePath, worldId: options.worldId, voxelLoading: 'manual', snapshotLimits: { maxBytes: DEFAULT_SNAPSHOT_MAX_MB * 1024 * 1024 } });
  try {
    const applied = applyHostSemanticMigration(session.facts, { facts: plan.facts, gaps, report });
    if (applied.conflict) throw new Error('facts changed during offline migration');
    const checkpoint = await session.checkpoint({ completeLegacyFactsMigration: true });
    return { executed: true, report, gaps, archived, applied, backup, checkpointId: checkpoint.checkpointId };
  } finally { await session.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
    const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)];
  }));
  const databasePath = args.get('database'), worldId = args.get('world-id'), archivePath = args.get('archive');
  if (!databasePath || !worldId) throw new Error('usage: spatial-facts-cutover --database=<path> --world-id=<id> [--execute] [--backup=<path>] [--archive=<path>]');
  const result = await cutoverFacts({
    databasePath,
    worldId,
    execute: process.argv.includes('--execute'),
    backupPath: args.get('backup'),
    archiveNodes: archivePath === undefined ? undefined : readArchiveFile(archivePath),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
