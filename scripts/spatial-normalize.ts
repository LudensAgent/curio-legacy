/**
 * One-time normalization of an existing spatial database into the native
 * semantic layout used by the runtime.
 *
 * What it does (dry-run by default, on a temporary copy):
 * - moves chest contents and furnace state into the host container ledger;
 * - strips those exact contents from node metadata;
 * - converts legacy synthetic `gone` nodes into first-class node gone state;
 * - merges discovery container landmarks into their exact container anchor;
 * - imports missing travel endpoints/traversals from travel-memory.json;
 * - removes the old `curio:meta` chestOps node after moving its counter;
 * - writes the `curio:migration` marker used by the startup gate.
 *
 * The Agent must be stopped before `--execute`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openSpatialSession, portalTraversalIdentity } from 'curio-minecraft-3d-memory/storage/sqlite';
import { DEFAULT_SNAPSHOT_MAX_MB } from '../src/spatial/shared-session.ts';
import type { JsonObject, PathFragment, SpatialNode } from 'curio-minecraft-3d-memory';
import type { ChestRecord, FurnaceRecord } from '../src/memory/store.ts';
import { ContainerLedger, type ContainerEntry, type FurnaceEntry } from '../src/memory/container-ledger.ts';
import { isContainerLandmark } from '../src/memory/chest-memory.ts';

type Vec = { x: number; y: number; z: number };
/** 离线迁移工具自己的 legacy 路径 links 上限；运行时路线写入已退役，故不从 src 反向导入。 */
const OFFLINE_LEGACY_MAX_FRAGMENT_LINKS = 16_384;
const args = new Map<string, string>();
let execute = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--execute') { execute = true; continue; }
  const match = /^--([a-z-]+)=(.+)$/.exec(arg);
  if (match) args.set(match[1]!, match[2]!);
}
const database = args.get('database');
const worldId = args.get('world-id');
if (!database || !worldId) {
  process.stderr.write('usage: spatial-normalize --database=<path> --world-id=<id> [--container-ledger=<path>] [--travel-memory=<path>] [--report=<path>] [--backup=<path>] [--snapshot-max-mb=<n>] [--execute]\n');
  process.exit(1);
}
const containerPath = resolve(args.get('container-ledger') ?? join(dirname(dirname(resolve(database))), 'containers.json'));
const worldMemoryPath = resolve(args.get('world-memory') ?? join(dirname(dirname(resolve(database))), 'world-memory.json'));
const travelPath = args.get('travel-memory')
  ?? (existsSync(join(dirname(worldMemoryPath), 'travel-memory.json')) ? join(dirname(worldMemoryPath), 'travel-memory.json') : null);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const workingDatabase = execute ? resolve(database) : `${resolve(database)}.normalize-dry-${stamp}.sqlite`;
const workingContainerPath = execute ? containerPath : `${containerPath}.normalize-dry-${stamp}.json`;
const backupPath = args.get('backup') ?? `${resolve(database)}.pre-normalize-${stamp}.sqlite`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const vec = (value: unknown): Vec | null => isRecord(value)
  && num(value.x) !== null && num(value.y) !== null && num(value.z) !== null
  ? { x: num(value.x)!, y: num(value.y)!, z: num(value.z)! } : null;
const point = (node: SpatialNode): Vec => node.location.kind === 'exact'
  ? { ...node.location.pos }
  : { ...node.location.center };
const keyOf = (p: Vec) => `${p.x},${p.y},${p.z}`;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fileFact = (path: string | null) => path && existsSync(path)
  ? { path: resolve(path), size: statSync(path).size, sha256: hash(path) }
  : null;

function allNodes(session: { topology: { nodes(query: { after?: string; limit: number }): { items: SpatialNode[]; nextAfter?: string } } }): SpatialNode[] {
  const out: SpatialNode[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = session.topology.nodes({ after, limit: 100 });
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

function allFragments(session: { history: { fragments(query: { after?: string; limit: number }): { items: PathFragment[]; nextAfter?: string } } }): PathFragment[] {
  const out: PathFragment[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = session.history.fragments({ after, limit: 100 });
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

if (!execute) {
  // Dry-run on a private copy so no live row is touched.
  const { copyFileSync } = await import('node:fs');
  copyFileSync(resolve(database), workingDatabase);
  for (const suffix of ['-wal', '-shm']) {
    const source = `${resolve(database)}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${workingDatabase}${suffix}`);
  }
  if (existsSync(containerPath)) copyFileSync(containerPath, workingContainerPath);
} else {
  const { backupDatabase } = await import('./legacy-spatial-import.ts');
  backupDatabase(resolve(database), backupPath);
}

// 必须用运行时同样的上限打开：库默认（4096 links / 64MB 快照）比运行时小，运行时能读的长矿道 fragment
// 与大快照在这里读不进来（实机 live 库：6053 links、73MB 快照，打开即原生崩溃）。
const snapshotMaxMb = Number(args.get('snapshot-max-mb') ?? DEFAULT_SNAPSHOT_MAX_MB);
if (!Number.isFinite(snapshotMaxMb) || snapshotMaxMb <= 0) {
  process.stderr.write('--snapshot-max-mb 必须是正数\n');
  process.exit(1);
}
/** 删除 dry-run 的临时副本：副本本身、WAL/SHM，以及库升级 schema 时给副本自动留的 pre-vN 备份（不碰原库和它的备份）。 */
function removeDryRunCopies() {
  const dir = dirname(workingDatabase), base = workingDatabase.slice(dir.length + 1);
  for (const name of readdirSync(dir)) {
    if (name === base || name.startsWith(`${base}-`) || name.startsWith(`${base}.pre-v`)) rmSync(join(dir, name), { force: true });
  }
  rmSync(workingContainerPath, { force: true });
}

const session = await openSpatialSession({
  databasePath: workingDatabase, worldId, timeoutMs: 30_000,
  snapshotLimits: { maxBytes: Math.round(snapshotMaxMb * 1024 * 1024) }, fragmentOptions: { maxLinks: OFFLINE_LEGACY_MAX_FRAGMENT_LINKS },
});
const containers = new ContainerLedger(workingContainerPath, worldId);
const actions = {
  chestContents: 0,
  furnaceStates: 0,
  goneConverted: 0,
  containerMerged: 0,
  travelEndpoints: 0,
  travelTraversals: 0,
  removedMeta: 0,
};
const warnings: string[] = [];
const rejected: { category: string; id: string; reason: string }[] = [];
let chestOps = containers.chestOps;

try {
  const nodes = allNodes(session);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const containerAnchors = new Map<string, SpatialNode>();

  for (const node of nodes) {
    const meta = (node.metadata as { curio?: Record<string, unknown> } | undefined)?.curio;
    const type = str(meta?.type);
    const record = isRecord(meta?.record) ? meta.record : undefined;
    if ((type === 'landmark' || type === 'station') && str(node.label) && !str(meta?.view)) {
      const view = node.label!.startsWith('我的') ? 'station' : 'landmark';
      const updated = { ...meta, v: 2, view };
      session.topology.updateNode(node.id, { metadata: { curio: updated } as JsonObject });
      meta!.view = view;
      meta!.v = 2;
    }
    if (type === 'meta') {
      const value = num(record?.chestOps);
      if (value !== null) chestOps = Math.max(chestOps, value);
      session.topology.forgetNode(node.id);
      actions.removedMeta++;
      continue;
    }
    if (type === 'chest') {
      const pos = vec(record?.pos) ?? point(node);
      const dim = str(record?.dim) ?? node.dim;
      const contents = isRecord(record?.contents) ? record.contents : null;
      const entry: ContainerEntry = {
        worldId, dim, pos, block: str(record?.block) ?? 'chest',
        uses: num(record?.uses) ?? 0, ts: num(record?.ts) ?? node.observedAt ?? Date.now(),
        ...(num(record?.day) !== null ? { day: num(record?.day)! } : {}),
        ...(str(record?.note) ? { note: str(record?.note)! } : {}),
        contents: contents ? {
          items: Array.isArray(contents.items) ? contents.items.flatMap((item) => isRecord(item) && str(item.name) && num(item.count) !== null
            ? [{ name: str(item.name)!, count: num(item.count)! }] : []) : [],
          observedAt: num(contents.observedAt) ?? 0,
          ...(num(contents.day) !== null ? { day: num(contents.day)! } : {}),
          ...(contents.possiblyStale === true ? { possiblyStale: true } : {}),
          ...(num(contents.capacity) !== null ? { capacity: num(contents.capacity)! } : {}),
          ...(num(contents.freeSlots) !== null ? { freeSlots: num(contents.freeSlots)! } : {}),
        } : { items: [], observedAt: 0, possiblyStale: true },
        nodeId: node.id,
      };
      containers.importChest(entry);
      actions.chestContents++;
      const stripped = {
        ts: entry.ts, uses: entry.uses, block: entry.block,
        ...(entry.day !== undefined ? { day: entry.day } : {}), ...(entry.note ? { note: entry.note } : {}),
      };
      session.topology.updateNode(node.id, {
        metadata: {
          curio: { ...meta, v: 2, type: 'container', types: ['container'], block: entry.block, record: stripped },
        } as JsonObject,
      });
      containerAnchors.set(`${dim}:${keyOf(pos)}`, session.topology.getNode(node.id)!);
      continue;
    }
    if (type === 'furnace') {
      const pos = vec(record?.pos) ?? point(node);
      const dim = str(record?.dim) ?? node.dim;
      const why = str(record?.why);
      const entry: FurnaceEntry = {
        worldId, dim, pos, block: str(record?.block) ?? 'furnace',
        input: isRecord(record?.input) && str(record.input.name) && num(record.input.count) !== null ? { name: str(record.input.name)!, count: num(record.input.count)! } : null,
        output: isRecord(record?.output) && str(record.output.name) && num(record.output.count) !== null ? { name: str(record.output.name)!, count: num(record.output.count)! } : null,
        fuel: isRecord(record?.fuel) && str(record.fuel.name) && num(record.fuel.count) !== null ? { name: str(record.fuel.name)!, count: num(record.fuel.count)! } : null,
        burning: record?.burning === true,
        ...(why ? { why } : {}),
        ts: num(record?.ts) ?? node.observedAt ?? Date.now(),
        nodeId: node.id,
      };
      if (entry.input || entry.output) {
        containers.importFurnace(entry);
        actions.furnaceStates++;
      }
      const stripped = { ts: entry.ts, block: entry.block };
      session.topology.updateNode(node.id, {
        metadata: {
          curio: { ...meta, v: 2, type: 'furnace', types: ['furnace'], block: entry.block, record: stripped },
        } as JsonObject,
      });
      continue;
    }
    if (type === 'gone') {
      if (node.gone) continue;
      const label = str(record?.label);
      const pos = vec(record?.pos) ?? point(node);
      if (!label) { rejected.push({ category: 'gone', id: node.id, reason: 'missing label' }); continue; }
      const live = nodes.find((candidate) => candidate.id !== node.id && !candidate.gone && candidate.dim === node.dim
        && candidate.label === label && keyOf(point(candidate)) === keyOf(pos));
      const observedAt = Math.max(Date.now(), node.observedAt ?? 0);
      if (live) {
        session.topology.markGone(live.id, {
          sessionId: 'spatial-normalize', observedAt: Math.max(observedAt, live.observedAt ?? 0),
          source: 'program', reason: str(record?.now) ?? 'normalized gone record',
        });
        session.topology.forgetNode(node.id);
      } else {
        session.topology.markGone(node.id, {
          sessionId: 'spatial-normalize', observedAt,
          source: 'program', reason: str(record?.now) ?? 'normalized gone record',
        });
      }
      actions.goneConverted++;
      continue;
    }
    if ((type === 'landmark' || type === 'station') && str(node.label) && isContainerLandmark(node.label!)) {
      const pos = point(node);
      const dim = node.dim;
      const anchor = containerAnchors.get(`${dim}:${keyOf(pos)}`);
      if (anchor) {
        const anchorMeta = (anchor.metadata as { curio?: Record<string, unknown> } | undefined)?.curio ?? {};
        const anchorRecord = isRecord(anchorMeta.record) ? anchorMeta.record : {};
        session.topology.updateNode(anchor.id, {
          label: node.label,
          metadata: {
            curio: {
              ...anchorMeta, v: 2, type: 'container', types: ['container', node.label!.startsWith('我的') ? 'station' : 'landmark'],
              view: node.label!.startsWith('我的') ? 'station' : 'landmark', block: anchorMeta.block,
              record: { ...anchorRecord, kind: 'discovery', label: node.label, ts: node.observedAt ?? Date.now(), pos, dim, worldId },
            },
          } as JsonObject,
        });
        session.topology.forgetNode(node.id);
        actions.containerMerged++;
      } else {
        session.topology.updateNode(node.id, {
          metadata: {
            curio: {
              ...meta, v: 2, type: 'container', types: ['container'],
              view: node.label!.startsWith('我的') ? 'station' : 'landmark',
              record: { ...(record ?? {}), kind: 'discovery', label: node.label, ts: node.observedAt ?? Date.now(), pos, dim, worldId },
            },
          } as JsonObject,
        });
      }
    }
  }

  containers.setChestOps(chestOps);

  if (travelPath && existsSync(travelPath)) {
    const travel = JSON.parse(readFileSync(travelPath, 'utf8')) as Record<string, unknown>;
    type EndpointKind = 'nether_portal' | 'end_portal' | 'end_gateway';
    const endpoints = new Map<string, { id: string; worldId: string; dim: string; pos: Vec; kind: EndpointKind; portalObserved: boolean; observedAt: number }>();
    for (const raw of Array.isArray(travel.endpoints) ? travel.endpoints : []) {
      if (!isRecord(raw)) continue;
      const id = str(raw.id), dim = str(raw.dim), kind = str(raw.kind), pos = vec(raw.pos);
      if (!id || !dim || !kind || !pos) continue;
      const endpoint = {
        id, worldId: str(raw.worldId) ?? worldId, dim, pos, kind: kind as EndpointKind,
        portalObserved: raw.portalObserved === true, observedAt: num(raw.observedAt) ?? 0,
      };
      endpoints.set(id, endpoint);
      if (!byId.has(id)) {
        session.topology.saveNode({
          id, kind: 'place', source: 'program', tag: 'portal', label: kind,
          worldId, dim, location: { kind: 'exact', pos }, observedAt: endpoint.observedAt,
          externalRef: id, durable: true,
          metadata: { curio: { v: 1, type: 'endpoint', record: { ...raw, worldId: endpoint.worldId, pos } } } as JsonObject,
        });
        actions.travelEndpoints++;
      }
    }
    const existing = new Set(session.ledger.portalTraversals().map((traversal) => traversal.id));
    for (const [kind, list] of [['traversal', travel.traversals], ['gateway', travel.gateways]] as const) {
      for (const raw of Array.isArray(list) ? list : []) {
        if (!isRecord(raw)) continue;
        const fromId = str(raw.fromId), toId = str(raw.toId);
        const ts = num(raw.ts), fromObservation = num(raw.fromObservation), toObservation = num(raw.toObservation);
        if (!fromId || !toId || ts === null || fromObservation === null || toObservation === null) continue;
        const identity = portalTraversalIdentity({
          kind, fromId, toId, ts,
          fromSession: str(raw.fromSession) ?? '', toSession: str(raw.toSession) ?? '',
          fromObservation, toObservation,
        });
        if (existing.has(identity)) continue;
        session.ledger.recordPortalTraversal({
          kind, fromId, toId, ts,
          fromSession: str(raw.fromSession) ?? '', toSession: str(raw.toSession) ?? '',
          fromObservation, toObservation, worldId, direction: 'unclassified', source: 'legacy',
          fromEndpoint: endpoints.get(fromId) ?? null, toEndpoint: endpoints.get(toId) ?? null,
        });
        actions.travelTraversals++;
      }
    }
  }

  const nodesAfter = allNodes(session);
  const fragments = allFragments(session);
  const counts = {
    nodes: nodesAfter.length,
    fragments: fragments.length,
    placed: session.ledger.placedBlocks().length,
    visits: session.ledger.chunkVisits().length,
    traversals: session.ledger.portalTraversals().length,
    chests: containers.chests().length,
    furnaces: containers.furnaces().length,
    chestOps: containers.chestOps,
  };
  const completedAt = Date.now();
  const marker = {
    version: 1, completedAt,
    sources: {
      worldId,
      containerLedger: containerPath,
      travelMemory: fileFact(travelPath),
      counts,
    },
  };
  const markerNode = {
    id: 'curio:migration', kind: 'place' as const, source: 'program' as const, tag: 'discovery' as const,
    label: 'spatial migration', worldId, dim: 'overworld',
    location: { kind: 'exact' as const, pos: { x: 0, y: 0, z: 0 } }, observedAt: completedAt,
    externalRef: 'curio:migration',
    metadata: { curio: { v: 2, type: 'migration', record: marker } } as JsonObject,
  };
  if (session.topology.getNode(markerNode.id)) session.topology.updateNode(markerNode.id, {
    label: markerNode.label, location: markerNode.location, observedAt: markerNode.observedAt,
    externalRef: markerNode.externalRef, metadata: markerNode.metadata,
  });
  else session.topology.saveNode(markerNode);
  containers.flush();
  const checkpoint = await session.checkpoint();
  const state = session.getPersistenceState();
  const close = await session.close();
  const archived: string[] = [];
  if (execute) {
    const dataDir = dirname(worldMemoryPath);
    const archiveDir = join(dataDir, 'archive', `normalize-${stamp}`);
    mkdirSync(archiveDir, { recursive: true });
    const move = (file: string) => {
      if (!existsSync(file)) return;
      renameSync(file, join(archiveDir, file.split(/[\\/]/).pop()!));
      archived.push(file);
    };
    if (travelPath) move(resolve(travelPath));
    move(`${worldMemoryPath}.placed`);
    if (existsSync(join(dataDir, 'memory-patch.json'))) warnings.push('pending memory-patch.json archived; review archive/normalize-* if it contained unapplied changes');
    move(join(dataDir, 'memory-patch.json'));
    for (const file of readdirSync(dataDir).filter((name) => name.startsWith('memory-patch.applied-'))) move(join(dataDir, file));
    if (existsSync(worldMemoryPath)) {
      const world = JSON.parse(readFileSync(worldMemoryPath, 'utf8')) as Record<string, unknown>;
      for (const key of ['passages', 'passageArchive', 'landmarks', 'chests', 'chestOps', 'furnaces', 'gone', 'farms', 'hazards', 'visitedChunks']) delete world[key];
      const temporary = `${worldMemoryPath}.normalize-tmp`;
      writeFileSync(temporary, JSON.stringify(world, null, 1));
      renameSync(temporary, worldMemoryPath);
    }
  }
  const report = {
    dryRun: !execute,
    worldId,
    database: resolve(database),
    workingDatabase,
    backup: execute ? backupPath : null,
    containerLedger: containerPath,
    worldMemory: worldMemoryPath,
    archived,
    actions,
    warnings,
    rejected,
    counts,
    checkpoint,
    state,
    close,
  };
  const reportPath = args.get('report') ?? (execute ? join(dirname(resolve(database)), `normalize-report-${stamp}.json`) : null);
  if (reportPath) {
    mkdirSync(dirname(resolve(reportPath)), { recursive: true });
    writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!execute) removeDryRunCopies();
  process.exitCode = state.dirty || !close.completed ? 1 : 0;
} catch (error) {
  await session.close();
  if (!execute) removeDryRunCopies();
  throw error;
}
