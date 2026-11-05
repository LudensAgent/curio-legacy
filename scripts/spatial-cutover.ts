/**
 * Full legacy → spatial-memory cutover.
 *
 * Unlike `legacy-spatial-import.ts` (history/topology only, prefixed IDs), this
 * tool preserves the legacy IDs, carries every semantic record as opaque node
 * metadata, and imports the placed/chunk-visit/portal ledgers. It reconciles
 * rows written by the earlier prefixed importer and is safe to re-run.
 *
 * Dry-run is the default. `--execute` writes one checkpoint after backing up the
 * database. The caller must stop the Agent first.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue, PathFragment, SpatialNode } from 'curio-minecraft-3d-memory';
import type {
  ChunkVisitRecord,
  LedgerSnapshot,
  PlacedBlockRecord,
  PortalEndpointEvidence,
  PortalTraversalRecord,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import {
  openSpatialSession,
  placedBlockKey,
  portalTraversalIdentity,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import { backupDatabase } from './legacy-spatial-import.ts';

type Vec = { x: number; y: number; z: number };
type CurioType = 'landmark' | 'chest' | 'furnace' | 'farm' | 'hazard' | 'gone' | 'endpoint' | 'mapMarker' | 'meta';

const MANAGED_TYPES = new Set(['passage', 'landmark', 'chest', 'furnace', 'farm', 'hazard', 'gone', 'endpoint', 'mapMarker', 'meta']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const vec = (v: unknown): Vec | null => {
  if (!isRecord(v)) return null;
  const x = num(v.x), y = num(v.y), z = num(v.z);
  return x === null || y === null || z === null ? null : { x, y, z };
};
const jsonRecord = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const clone = <T>(v: T): T => structuredClone(v);
const keyOf = (p: Vec) => `${p.x},${p.y},${p.z}`;

function readJson(path: string | null): unknown {
  if (!path) return undefined;
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

function fileFact(path: string | null) {
  if (!path) return null;
  const abs = resolve(path);
  const info = statSync(abs);
  return { path: abs, size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(abs) };
}

interface Desired {
  worldId: string;
  fragments: Map<string, PathFragment>;
  nodes: Map<string, SpatialNode>;
  placed: PlacedBlockRecord[];
  visits: ChunkVisitRecord[];
  traversals: PortalTraversalRecord[];
  warnings: string[];
  rejected: { category: string; id: string | null; reason: string }[];
}

function nodeFor(worldId: string, type: CurioType, id: string, record: object, node: Omit<SpatialNode, 'id' | 'worldId' | 'metadata'>): SpatialNode {
  return {
    ...node,
    id,
    worldId,
    durable: true,
    metadata: { curio: { v: 1, type, record: jsonRecord(record) } },
  };
}

function regionOf(cells: Vec[]): SpatialNode['location'] {
  if (!cells.length) return { kind: 'exact', pos: { x: 0, y: 64, z: 0 } };
  const center = {
    x: Math.round(cells.reduce((s, c) => s + c.x, 0) / cells.length),
    y: Math.round(cells.reduce((s, c) => s + c.y, 0) / cells.length),
    z: Math.round(cells.reduce((s, c) => s + c.z, 0) / cells.length),
  };
  const radius = Math.max(1, ...cells.map((c) => Math.hypot(c.x - center.x, c.y - center.y, c.z - center.z)));
  return { kind: 'region', center, radius };
}

function buildDesired(input: {
  worldMemory: Record<string, unknown>;
  travelMemory?: unknown;
  placed?: unknown;
  mapExport?: unknown;
  worldId: string;
}): Desired {
  const { worldMemory, worldId } = input;
  const warnings: string[] = [];
  const rejected: Desired['rejected'] = [];
  const fragments = new Map<string, PathFragment>();
  const nodes = new Map<string, SpatialNode>();

  const addFragment = (raw: unknown, archivedAt?: number) => {
    if (!isRecord(raw)) { rejected.push({ category: 'passage', id: null, reason: 'not_an_object' }); return; }
    const id = str(raw.id), dim = str(raw.dim);
    const path = Array.isArray(raw.path) ? raw.path.map(vec) : null;
    if (!id || !dim || !path || path.some((p) => p === null) || path.length === 0) {
      rejected.push({ category: 'passage', id, reason: 'missing id/dim/path' });
      return;
    }
    const kind = raw.kind === 'bridge' || raw.kind === 'walked' || raw.kind === 'dug' ? raw.kind : 'dug';
    const entrances = Array.isArray(raw.entrances) ? raw.entrances.map(vec).filter((p): p is Vec => p !== null) : [];
    const links = Array.isArray(raw.links)
      ? raw.links.flatMap((pair) => {
          if (!isRecord(pair)) return [];
          const a = vec(pair.a), b = vec(pair.b);
          return a && b ? [{ a, b }] : [];
        })
      : undefined;
    const deepestY = num(raw.deepestY) ?? Math.min(...path.filter((p): p is Vec => p !== null).map((p) => p.y));
    fragments.set(id, {
      id,
      worldId,
      dim,
      kind,
      entrances,
      polyline: path.filter((p): p is Vec => p !== null),
      geometrySource: 'legacy',
      ...(links && links.length ? { links } : {}),
      deepestY,
      createdAt: num(raw.createdAt) ?? 1,
      lastUsedAt: num(raw.lastUsedAt) ?? num(raw.createdAt) ?? 1,
      uses: num(raw.uses) ?? 1,
      externalRef: id,
      metadata: {
        curio: {
          v: 1,
          type: 'passage',
          dug: num(raw.dug) ?? 0,
          ores: isRecord(raw.ores) ? jsonRecord(raw.ores) : {},
          ...(archivedAt !== undefined ? { archivedAt } : {}),
        },
      },
    });
  };

  for (const raw of Array.isArray(worldMemory.passages) ? worldMemory.passages : []) addFragment(raw);
  for (const raw of Array.isArray(worldMemory.passageArchive) ? worldMemory.passageArchive : []) addFragment(raw, num((raw as Record<string, unknown>)?.archivedAt) ?? Date.now());

  const mapExport = isRecord(input.mapExport) ? input.mapExport : null;
  if (mapExport) {
    for (const raw of Array.isArray(mapExport.passages) ? mapExport.passages : []) {
      if (isRecord(raw) && typeof raw.id === 'string' && fragments.has(raw.id)) continue;
      const archived = isRecord(raw) && raw.archiveStatus === 'historical';
      addFragment(raw, archived ? num((raw as Record<string, unknown>).snapshotAt) ?? Date.now() : undefined);
    }
  }

  const addNode = (id: string, type: CurioType, node: Omit<SpatialNode, 'id' | 'worldId' | 'metadata'>, record: object) => {
    if (nodes.has(id)) {
      rejected.push({ category: type, id, reason: 'duplicate_node_id' });
      return;
    }
    nodes.set(id, nodeFor(worldId, type, id, record, node));
  };

  for (const raw of Array.isArray(worldMemory.landmarks) ? worldMemory.landmarks : []) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id), dim = str(raw.dim), pos = vec(raw.pos), label = typeof raw.label === 'string' ? raw.label : '';
    if (!id || !dim || !pos) { rejected.push({ category: 'landmark', id, reason: 'missing id/dim/pos' }); continue; }
    const kind = str(raw.kind) ?? 'discovery';
    const source = ['base', 'discovery', 'waypoint', 'death'].includes(kind) ? 'agent' as const : 'program' as const;
    addNode(id, 'landmark', {
      kind: 'place', source, tag: kind as never, label, dim,
      location: { kind: 'exact', pos },
      observedAt: num(raw.observedAt) ?? num(raw.ts) ?? undefined,
      externalRef: id,
    }, { ...raw, worldId: str(raw.worldId) ?? worldId, pos });
  }

  const addObjectNodes = (category: 'chest' | 'furnace', value: unknown, prefix: string) => {
    if (!isRecord(value)) return;
    for (const [key, raw] of Object.entries(value)) {
      if (!isRecord(raw)) continue;
      const pos = vec(raw.pos), dim = str(raw.dim);
      if (!pos || !dim) { rejected.push({ category, id: key, reason: 'missing dim/pos' }); continue; }
      const id = `${prefix}:${key}`;
      addNode(id, category, {
        kind: 'place', source: 'program', tag: 'resource',
        label: category === 'chest' ? `chest${typeof raw.note === 'string' && raw.note ? `: ${raw.note}` : ''}` : `furnace${raw.burning === true ? ' (burning)' : ''}`,
        dim, location: { kind: 'exact', pos },
        observedAt: category === 'chest'
          ? num((raw.contents as Record<string, unknown> | undefined)?.observedAt) ?? num(raw.ts) ?? undefined
          : num(raw.ts) ?? undefined,
        externalRef: key,
      }, { ...raw, worldId: str(raw.worldId) ?? worldId, dim, pos });
    }
  };
  addObjectNodes('chest', worldMemory.chests, 'chest');
  addObjectNodes('furnace', worldMemory.furnaces, 'furnace');

  for (const raw of Array.isArray(worldMemory.farms) ? worldMemory.farms : []) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id), dim = str(raw.dim);
    const cells = Array.isArray(raw.cells) ? raw.cells.map(vec).filter((p): p is Vec => p !== null) : [];
    if (!id || !dim) { rejected.push({ category: 'farm', id, reason: 'missing id/dim' }); continue; }
    addNode(id, 'farm', {
      kind: 'place', source: 'program', tag: 'resource', label: `farm: ${str(raw.crop) ?? 'unknown'}`,
      dim, location: regionOf(cells), observedAt: num(raw.plantedAt) ?? undefined, externalRef: id,
    }, { ...raw, worldId: str(raw.worldId) ?? worldId, cells });
  }

  for (const raw of Array.isArray(worldMemory.hazards) ? worldMemory.hazards : []) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id), dim = str(raw.dim), pos = vec(raw.pos), radius = num(raw.radius);
    if (!id || !dim || !pos || radius === null) { rejected.push({ category: 'hazard', id, reason: 'missing id/dim/pos/radius' }); continue; }
    addNode(id, 'hazard', {
      kind: 'place', source: 'program', tag: 'danger',
      label: `danger: ${str(raw.kind) ?? 'unknown'}${typeof raw.note === 'string' && raw.note ? ` (${raw.note})` : ''}`,
      dim, location: { kind: 'region', center: pos, radius }, observedAt: num(raw.ts) ?? undefined, externalRef: id,
    }, { ...raw, worldId: str(raw.worldId) ?? worldId });
  }

  for (const raw of Array.isArray(worldMemory.gone) ? worldMemory.gone : []) {
    if (!isRecord(raw)) continue;
    const dim = str(raw.dim), pos = vec(raw.pos), label = str(raw.label);
    if (!dim || !pos || !label) continue;
    const id = `gone:${worldId}:${dim}:${pos.x},${pos.y},${pos.z}:${label}`;
    addNode(id, 'gone', {
      kind: 'place', source: 'program', tag: 'discovery', label: `gone: ${label}`, dim,
      location: { kind: 'exact', pos }, observedAt: num(raw.ts) ?? undefined, externalRef: id,
    }, { ...raw, worldId: str(raw.worldId) ?? worldId });
  }

  const travel = isRecord(input.travelMemory) ? input.travelMemory : null;
  const endpoints = new Map<string, PortalEndpointEvidence>();
  if (travel) {
    for (const raw of Array.isArray(travel.endpoints) ? travel.endpoints : []) {
      if (!isRecord(raw)) continue;
      const id = str(raw.id), dim = str(raw.dim), pos = vec(raw.pos), kind = str(raw.kind);
      if (!id || !dim || !pos || !kind) continue;
      const endpoint: PortalEndpointEvidence = {
        id, worldId: str(raw.worldId) ?? worldId, dim, pos, kind: kind as PortalEndpointEvidence['kind'],
        portalObserved: raw.portalObserved === true, observedAt: num(raw.observedAt) ?? 0,
      };
      endpoints.set(id, endpoint);
      addNode(id, 'endpoint', {
        kind: 'place', source: 'program', tag: 'portal', label: kind, dim,
        location: { kind: 'exact', pos }, observedAt: endpoint.observedAt, externalRef: id,
      }, { ...raw, worldId: endpoint.worldId, pos });
    }
  }

  if (mapExport) {
    for (const raw of Array.isArray(mapExport.markers) ? mapExport.markers : []) {
      if (!isRecord(raw) || raw.archiveStatus !== 'historical' || raw.type === 'reference') continue;
      const id = str(raw.id), pos = vec(raw.pos), dim = str(raw.dim);
      if (!id || !pos || !dim) continue;
      const tag = str(raw.type) === 'resource' ? 'resource' : str(raw.type) === 'danger' ? 'danger' : str(raw.type) === 'death' ? 'death' : 'discovery';
      addNode(`legacy:map-marker:${id}`, 'mapMarker', {
        kind: 'place', source: 'program', tag: tag as never, label: str(raw.label) ?? String(raw.type ?? 'marker'),
        dim, location: { kind: 'exact', pos }, observedAt: num(raw.ts) ?? undefined, externalRef: id,
      }, raw);
    }
  }

  addNode('curio:meta', 'meta', {
    kind: 'place', source: 'program', label: 'curio meta', dim: 'overworld',
    location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } },
  }, { chestOps: num(worldMemory.chestOps) ?? 0 });

  const placed: PlacedBlockRecord[] = [];
  const placedRoot = isRecord(input.placed) ? input.placed : null;
  const byPos = placedRoot && isRecord(placedRoot.byPos) ? placedRoot.byPos : null;
  if (byPos) {
    for (const [key, raw] of Object.entries(byPos)) {
      if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.at !== 'number') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) continue;
      placed.push({
        key: placedBlockKey(worldId, null, x, y, z),
        worldId, dim: null, pos: { x, y, z }, name: raw.name, lruAt: raw.at, source: 'legacy',
      });
    }
  }

  const visits: ChunkVisitRecord[] = [];
  if (isRecord(worldMemory.visitedChunks)) {
    for (const [key, count] of Object.entries(worldMemory.visitedChunks)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue;
      const prefix = `${worldId}:`;
      const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const parts = rest.split(':');
      if (parts.length !== 3) continue;
      const cx = Number(parts[1]), cz = Number(parts[2]);
      if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) continue;
      visits.push({
        key: `${worldId}:${parts[0]}:${cx}:${cz}`, worldId, dim: parts[0]!, cx, cz, count, source: 'legacy',
      });
    }
  }

  const traversals: PortalTraversalRecord[] = [];
  if (travel) {
    for (const [kind, list] of [['traversal', travel.traversals], ['gateway', travel.gateways]] as const) {
      for (const raw of Array.isArray(list) ? list : []) {
        if (!isRecord(raw)) continue;
        const fromId = str(raw.fromId), toId = str(raw.toId);
        const ts = num(raw.ts), fromObservation = num(raw.fromObservation), toObservation = num(raw.toObservation);
        if (!fromId || !toId || ts === null || fromObservation === null || toObservation === null) continue;
        const fromEndpoint = endpoints.get(fromId) ?? null;
        const toEndpoint = endpoints.get(toId) ?? null;
        const inputId = {
          kind, fromId, toId, ts,
          fromSession: str(raw.fromSession) ?? '',
          toSession: str(raw.toSession) ?? '',
          fromObservation, toObservation,
        };
        traversals.push({
          id: portalTraversalIdentity(inputId),
          worldId: fromEndpoint?.worldId ?? toEndpoint?.worldId ?? worldId,
          kind, direction: 'unclassified',
          fromId, toId, ts,
          fromSession: inputId.fromSession, toSession: inputId.toSession,
          fromObservation, toObservation,
          fromEndpoint, toEndpoint, source: 'legacy',
        });
      }
    }
  }

  return { worldId, fragments, nodes, placed, visits, traversals, warnings, rejected };
}

interface Current {
  fragments: Map<string, PathFragment>;
  nodes: Map<string, SpatialNode>;
  placed: number;
  visits: number;
  traversals: number;
}

function readCurrent(dbPath: string, worldId: string): Current {
  const out: Current = { fragments: new Map(), nodes: new Map(), placed: 0, visits: 0, traversals: 0 };
  if (!existsSync(dbPath)) return out;
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const has = (table: string) => !!db.prepare("select name from sqlite_master where type='table' and name=?").get(table);
    if (has('path_fragments')) {
      for (const row of db.prepare('select id,payload from path_fragments where world_id=?').all(worldId) as { id: string; payload: string }[]) {
        try { out.fragments.set(row.id, JSON.parse(row.payload) as PathFragment); } catch { /* corrupt row */ }
      }
    }
    if (has('spatial_nodes')) {
      for (const row of db.prepare('select id,payload from spatial_nodes where world_id=?').all(worldId) as { id: string; payload: string }[]) {
        try { out.nodes.set(row.id, JSON.parse(row.payload) as SpatialNode); } catch { /* corrupt row */ }
      }
    }
    const count = (table: string) => {
      if (!has(table)) return 0;
      return (db.prepare(`select count(*) as n from ${table} where world_id=?`).get(worldId) as { n: number }).n;
    };
    out.placed = count('placed_blocks');
    out.visits = count('chunk_visits');
    out.traversals = count('portal_traversals');
  } finally {
    db.close();
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function allFragments(history: { fragments(query: { after?: string; limit: number }): { items: PathFragment[]; nextAfter?: string } }): PathFragment[] {
  const out: PathFragment[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = history.fragments({ after, limit: 100 });
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

function allNodes(topology: { nodes(query: { after?: string; limit: number }): { items: SpatialNode[]; nextAfter?: string } }): SpatialNode[] {
  const out: SpatialNode[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = topology.nodes({ after, limit: 100 });
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

function oldLegacyId(id: string): boolean {
  return /^legacy:(passage|landmark|hazard|chest|farm|travel-endpoint):/.test(id);
}

async function apply(desired: Desired, dbPath: string, backupPath: string) {
  const backup = backupDatabase(dbPath, backupPath);
  const session = await openSpatialSession({ databasePath: resolve(dbPath), worldId: desired.worldId, timeoutMs: 30_000 });
  const actions = { insertFragments: 0, updateFragments: 0, deleteFragments: 0, insertNodes: 0, updateNodes: 0, deleteNodes: 0 };
  try {
    for (const fragment of allFragments(session.history)) {
      const meta = (fragment.metadata as { curio?: { type?: string } } | undefined)?.curio;
      if (oldLegacyId(fragment.id) || (meta?.type === 'passage' && !desired.fragments.has(fragment.id))) {
        session.history.forgetFragment(fragment.id);
        actions.deleteFragments++;
      }
    }
    for (const [id, fragment] of desired.fragments) {
      const existing = session.history.getFragment(id);
      if (!existing) { session.history.saveFragment(fragment); actions.insertFragments++; continue; }
      if (same(existing, fragment)) continue;
      if (existing.createdAt !== fragment.createdAt) {
        session.history.forgetFragment(id);
        session.history.saveFragment(fragment);
        actions.updateFragments++;
        continue;
      }
      const updated = session.history.updateFragment(id, {
        kind: fragment.kind, entrances: fragment.entrances, polyline: fragment.polyline,
        geometrySource: fragment.geometrySource, links: fragment.links, deepestY: fragment.deepestY,
        lastUsedAt: fragment.lastUsedAt, uses: fragment.uses, externalRef: fragment.externalRef,
        metadata: fragment.metadata,
      });
      if (updated.status === 'updated') actions.updateFragments++;
    }

    for (const node of allNodes(session.topology)) {
      const meta = (node.metadata as { curio?: { type?: string } } | undefined)?.curio;
      if (oldLegacyId(node.id) || (meta?.type && MANAGED_TYPES.has(meta.type) && !desired.nodes.has(node.id))) {
        session.topology.forgetNode(node.id);
        actions.deleteNodes++;
      }
    }
    for (const [id, node] of desired.nodes) {
      const existing = session.topology.getNode(id);
      if (!existing) { session.topology.saveNode(node); actions.insertNodes++; continue; }
      if (same(existing, node)) continue;
      if (existing.source !== node.source) {
        session.topology.forgetNode(id);
        session.topology.saveNode(node);
        actions.updateNodes++;
        continue;
      }
      const updated = session.topology.updateNode(id, {
        kind: node.kind, tag: node.tag, label: node.label, location: node.location,
        observedAt: node.observedAt, externalRef: node.externalRef, durable: node.durable, metadata: node.metadata,
      });
      if (updated.status === 'updated') actions.updateNodes++;
    }

    const current = session.ledger.snapshot();
    const placedByKey = new Map(current.placed.map((r) => [r.key, r]));
    for (const record of desired.placed) placedByKey.set(record.key, record);
    const visitsByKey = new Map(current.visits.map((r) => [r.key, r]));
    for (const record of desired.visits) visitsByKey.set(record.key, record);
    const traversalsById = new Map(current.traversals.map((r) => [r.id, r]));
    for (const record of desired.traversals) traversalsById.set(record.id, record);
    const ledger: LedgerSnapshot = {
      worldId: desired.worldId,
      placed: [...placedByKey.values()],
      visits: [...visitsByKey.values()],
      traversals: [...traversalsById.values()],
    };
    session.ledger.restoreSnapshot(ledger);
    const checkpoint = await session.checkpoint();
    const state = session.getPersistenceState();
    const close = await session.close();
    return { ok: !state.dirty && close.completed && close.error === null, backup, actions, checkpoint, state, close, ledger: { placed: ledger.placed.length, visits: ledger.visits.length, traversals: ledger.traversals.length } };
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function main(): Promise<number> {
  const args = new Map<string, string>();
  let execute = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') { execute = true; continue; }
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m) { process.stderr.write(`unknown argument: ${arg}\n`); return 1; }
    args.set(m[1]!, m[2]!);
  }
  const worldMemoryPath = args.get('world-memory');
  const databasePath = args.get('database');
  if (!worldMemoryPath || !databasePath) {
    process.stderr.write('usage: spatial-cutover --world-memory=<path> --database=<path> [--world-id=] [--travel-memory=] [--placed=] [--map-export=] [--report=] [--backup=] [--execute]\n');
    return 1;
  }
  const worldMemory = readJson(worldMemoryPath);
  if (!isRecord(worldMemory)) { process.stderr.write('world-memory root must be an object\n'); return 1; }
  const travelMemory = readJson(args.get('travel-memory') ?? null);
  const placed = readJson(args.get('placed') ?? null);
  const mapExport = readJson(args.get('map-export') ?? null);
  const worldId = args.get('world-id') ?? str(worldMemory.worldId);
  if (!worldId) { process.stderr.write('worldId missing\n'); return 1; }
  if (str(worldMemory.worldId) && str(worldMemory.worldId) !== worldId) { process.stderr.write('source worldId mismatch\n'); return 1; }

  const desired = buildDesired({ worldMemory, travelMemory, placed, mapExport, worldId });
  const current = readCurrent(databasePath, worldId);
  const currentCounts = {
    fragments: current.fragments.size,
    nodes: current.nodes.size,
    placed: current.placed,
    visits: current.visits,
    traversals: current.traversals,
  };
  const staleFragments = [...current.fragments.keys()].filter((id) => oldLegacyId(id) || !desired.fragments.has(id));
  const staleNodes = [...current.nodes.keys()].filter((id) => oldLegacyId(id) || !desired.nodes.has(id));
  const report = {
    dryRun: !execute,
    worldId,
    sources: { worldMemory: fileFact(worldMemoryPath), travelMemory: fileFact(args.get('travel-memory') ?? null), placed: fileFact(args.get('placed') ?? null), mapExport: fileFact(args.get('map-export') ?? null) },
    desired: {
      fragments: desired.fragments.size, nodes: desired.nodes.size,
      placed: desired.placed.length, visits: desired.visits.length, traversals: desired.traversals.length,
    },
    current: currentCounts,
    stale: { fragments: staleFragments, nodes: staleNodes },
    warnings: desired.warnings, rejected: desired.rejected,
  };
  if (!execute) {
    const reportPath = args.get('report');
    if (reportPath) {
      mkdirSync(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = args.get('backup') ?? `${resolve(databasePath)}.pre-cutover-${stamp}.sqlite`;
  const applied = await apply(desired, databasePath, backupPath);
  const afterState = readCurrent(databasePath, worldId);
  const after = {
    fragments: afterState.fragments.size,
    nodes: afterState.nodes.size,
    placed: afterState.placed,
    visits: afterState.visits,
    traversals: afterState.traversals,
  };
  const finalReport = { ...report, dryRun: false, applied, after, ok: applied.ok };
  const reportPath = args.get('report') ?? join(dirname(resolve(databasePath)), `cutover-report-${stamp}.json`);
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), `${JSON.stringify(finalReport, null, 2)}\n`);
  process.stdout.write(`backup: ${applied.backup.path} (${applied.backup.sha256})\n`);
  process.stdout.write(`fragments ${applied.actions.insertFragments} inserted / ${applied.actions.updateFragments} updated / ${applied.actions.deleteFragments} deleted\n`);
  process.stdout.write(`nodes ${applied.actions.insertNodes} inserted / ${applied.actions.updateNodes} updated / ${applied.actions.deleteNodes} deleted\n`);
  process.stdout.write(`ledger placed=${applied.ledger.placed} visits=${applied.ledger.visits} traversals=${applied.ledger.traversals}\n`);
  process.stdout.write(`report: ${reportPath}\n`);
  process.stdout.write(applied.ok ? 'cutover OK\n' : 'cutover FAILED\n');
  return applied.ok ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
