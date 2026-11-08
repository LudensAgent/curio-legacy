import { isDeepStrictEqual } from 'node:util';
import type {
  FragmentChanges,
  FragmentStore,
  JsonValue,
  PathFragment,
  SpatialNode,
  TopologyStore,
} from 'curio-minecraft-3d-memory';
import type { ChunkVisitRecord, LedgerSnapshot, LedgerStore, PlacedBlockRecord } from 'curio-minecraft-3d-memory/storage/sqlite';
import { chunkVisitKey, placedBlockKey } from 'curio-minecraft-3d-memory/storage/sqlite';
import { dist3 } from '../util.ts';
import type {
  ChestRecord,
  FarmRecord,
  FurnaceRecord,
  GoneSpot,
  Hazard,
  Landmark,
  PassageRecord,
} from './store.ts';

/** The three in-memory library stores a spatial session exposes. */
export interface SpatialSessionLike {
  readonly history: FragmentStore;
  readonly topology: TopologyStore;
  readonly ledger: LedgerStore;
}

export interface PlacedSnapshotEntry {
  pos: { x: number; y: number; z: number };
  name: string;
  at: number;
}

export interface SemanticSnapshot {
  worldId: string;
  passages: PassageRecord[];
  passageArchive: PassageRecord[];
  landmarks: Landmark[];
  chests: Record<string, ChestRecord>;
  chestOps: number;
  furnaces: Record<string, FurnaceRecord>;
  gone: GoneSpot[];
  farms: FarmRecord[];
  hazards: Hazard[];
  placed: PlacedSnapshotEntry[];
  visitedChunks: Record<string, number>;
}

type CurioType = 'passage' | 'landmark' | 'chest' | 'furnace' | 'farm' | 'hazard' | 'gone' | 'meta';
const MANAGED_TYPES = new Set<CurioType>(['passage', 'landmark', 'chest', 'furnace', 'farm', 'hazard', 'gone', 'meta']);

interface CurioMetadata {
  curio?: {
    v?: number;
    type?: CurioType;
    [key: string]: unknown;
  };
}

const metaOf = (value: unknown): CurioMetadata['curio'] | undefined =>
  (value && typeof value === 'object' ? (value as CurioMetadata).curio : undefined);

const clone = <T>(value: T): T => structuredClone(value);
/** Strip undefined object fields so a host record is valid JSON metadata. */
const jsonRecord = (value: object): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const posKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const chestKey = (worldId: string, dim: string, pos: { x: number; y: number; z: number }) =>
  `${worldId}:${dim}:${pos.x},${pos.y},${pos.z}`;
const nodePoint = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y, z: p.z });

function allFragments(history: FragmentStore): PathFragment[] {
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

function allNodes(topology: TopologyStore): SpatialNode[] {
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

/** link 方向标记的紧凑位图：第 i 位对应 links[i]。4096 条约 512 字节，base64 后约 684 字符，
 *  远低于库默认的 16 KiB metadata 上限。 */
const encodeFlags = (flags: boolean[]): string | undefined => {
  if (!flags.some(Boolean)) return undefined;
  const bytes = new Uint8Array(Math.ceil(flags.length / 8));
  flags.forEach((flag, i) => { if (flag) bytes[i >> 3]! |= 1 << (i & 7); });
  return Buffer.from(bytes).toString('base64');
};

const decodeFlags = (value: unknown): Uint8Array | undefined =>
  typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'base64')) : undefined;

const flagAt = (bytes: Uint8Array | undefined, i: number) =>
  !!bytes && (i >> 3) < bytes.length && (bytes[i >> 3]! & (1 << (i & 7))) !== 0;

export function fragmentRecord(fragment: PathFragment): PassageRecord {
  const meta = metaOf(fragment.metadata);
  // 任何 curio metadata 都可能带 linkMeta（方向位）；不局限于旧 passage 类型。
  const curio = meta;
  // 库的 fragment.links 只保留 a/b；方向证据在 metadata.curio.linkMeta 里。
  // 新格式是 { cut?: base64bits, reverse?: base64bits }；旧版本存的是 [{i,cut,reverse}]，继续兼容读取。
  const legacy = new Map<number, { cut?: boolean; reverse?: boolean }>();
  let cutBits: Uint8Array | undefined, reverseBits: Uint8Array | undefined;
  const rawMeta = curio?.linkMeta;
  if (Array.isArray(rawMeta)) {
    for (const item of rawMeta) {
      if (!item || typeof item !== 'object') continue;
      const { i, cut, reverse } = item as { i?: unknown; cut?: unknown; reverse?: unknown };
      if (typeof i !== 'number') continue;
      legacy.set(i, { ...(cut === true ? { cut: true } : {}), ...(reverse === true ? { reverse: true } : {}) });
    }
  } else if (rawMeta && typeof rawMeta === 'object') {
    cutBits = decodeFlags((rawMeta as { cut?: unknown }).cut);
    reverseBits = decodeFlags((rawMeta as { reverse?: unknown }).reverse);
  }
  const flagsOf = (i: number) => ({
    ...(legacy.get(i) ?? {}),
    ...(flagAt(cutBits, i) ? { cut: true } : {}),
    ...(flagAt(reverseBits, i) ? { reverse: true } : {}),
  });
  return {
    id: fragment.id,
    worldId: fragment.worldId,
    dim: fragment.dim,
    kind: fragment.kind === 'built' ? 'dug' : fragment.kind,
    entrances: fragment.entrances.map(nodePoint),
    path: fragment.polyline.map(nodePoint),
    ...(fragment.links ? { links: fragment.links.map((link, i) => ({ a: nodePoint(link.a), b: nodePoint(link.b), ...flagsOf(i) })) } : {}),
    deepestY: fragment.deepestY,
    dug: typeof curio?.dug === 'number' ? curio.dug : 0,
    ores: curio?.ores && typeof curio.ores === 'object' ? (curio.ores as Record<string, number>) : {},
    createdAt: fragment.createdAt,
    lastUsedAt: fragment.lastUsedAt,
    uses: fragment.uses,
    ...(typeof curio?.archivedAt === 'number' ? { archivedAt: curio.archivedAt } : {}),
  };
}

/** 库的 PathFragment.links（cloneFragment）只保留 a/b，额外字段保存时会被剥掉。
 *  方向判定依赖的 cut/reverse 因此按 link 下标编码成 metadata.curio.linkMeta 位图，重启后由 fragmentRecord 还原。
 *  run 只影响漏采样补桥，且每条 link 都有一个，逐条记录会撑爆 16 KiB metadata 上限，所以不持久化；
 *  缺失时建图退回更保守的 legacyStep（不新增错误连接，只会少补一点缺口）。 */
function passageMetadata(rec: PassageRecord) {
  const cutBits = encodeFlags(rec.links?.map((link) => !!link.cut) ?? []);
  const reverseBits = encodeFlags(rec.links?.map((link) => !!link.reverse) ?? []);
  const linkMeta = cutBits || reverseBits
    ? { ...(cutBits ? { cut: cutBits } : {}), ...(reverseBits ? { reverse: reverseBits } : {}) }
    : undefined;
  return {
    curio: {
      v: 1,
      type: 'passage',
      dug: rec.dug,
      ores: rec.ores,
      ...(rec.archivedAt !== undefined ? { archivedAt: rec.archivedAt } : {}),
      ...(linkMeta ? { linkMeta } : {}),
    },
  };
}

function fragmentFor(rec: PassageRecord, worldId: string, geometrySource: PathFragment['geometrySource']): PathFragment {
  return {
    id: rec.id,
    worldId: rec.worldId ?? worldId,
    dim: rec.dim,
    kind: rec.kind ?? 'walked',
    entrances: rec.entrances.map(nodePoint),
    polyline: rec.path.map(nodePoint),
    geometrySource,
    ...(rec.links ? { links: rec.links.map((link) => ({ a: nodePoint(link.a), b: nodePoint(link.b) })) } : {}),
    deepestY: rec.deepestY,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    uses: rec.uses,
    externalRef: rec.id,
    metadata: passageMetadata(rec),
  };
}

function fragmentChanges(rec: PassageRecord, geometrySource: PathFragment['geometrySource']): FragmentChanges {
  return {
    kind: rec.kind ?? 'walked',
    entrances: rec.entrances.map(nodePoint),
    polyline: rec.path.map(nodePoint),
    geometrySource,
    links: rec.links?.map((link) => ({ a: nodePoint(link.a), b: nodePoint(link.b) })),
    deepestY: rec.deepestY,
    lastUsedAt: rec.lastUsedAt,
    uses: rec.uses,
    externalRef: rec.id,
    metadata: passageMetadata(rec),
  };
}

/** Region used for farms and hazards. */
function regionOf(cells: { x: number; y: number; z: number }[], fallback?: { x: number; y: number; z: number }): { kind: 'region'; center: { x: number; y: number; z: number }; radius: number } | { kind: 'exact'; pos: { x: number; y: number; z: number } } {
  if (!cells.length) return { kind: 'exact', pos: fallback ? nodePoint(fallback) : { x: 0, y: 64, z: 0 } };
  const center = {
    x: Math.round(cells.reduce((sum, c) => sum + c.x, 0) / cells.length),
    y: Math.round(cells.reduce((sum, c) => sum + c.y, 0) / cells.length),
    z: Math.round(cells.reduce((sum, c) => sum + c.z, 0) / cells.length),
  };
  return { kind: 'region', center, radius: Math.max(1, ...cells.map((c) => dist3(c, center))) };
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

function landmarkNode(worldId: string, rec: Landmark): SpatialNode {
  const source = rec.kind === 'base' || rec.kind === 'discovery' || rec.kind === 'waypoint' || rec.kind === 'death' ? 'agent' : 'program';
  return nodeFor(worldId, 'landmark', rec.id, rec, {
    kind: 'place',
    source,
    tag: rec.kind,
    label: rec.label,
    dim: rec.dim,
    location: { kind: 'exact', pos: nodePoint(rec.pos) },
    observedAt: rec.observedAt ?? rec.ts,
    externalRef: rec.id,
  });
}

function chestNode(worldId: string, rec: ChestRecord): SpatialNode {
  return nodeFor(worldId, 'chest', `chest:${chestKey(worldId, rec.dim, rec.pos)}`, rec, {
    kind: 'place',
    source: 'program',
    tag: 'resource',
    label: `chest${rec.note ? `: ${rec.note}` : ''}`,
    dim: rec.dim,
    location: { kind: 'exact', pos: nodePoint(rec.pos) },
    observedAt: rec.contents?.observedAt || rec.ts,
    externalRef: chestKey(worldId, rec.dim, rec.pos),
  });
}

function furnaceNode(worldId: string, rec: FurnaceRecord): SpatialNode {
  return nodeFor(worldId, 'furnace', `furnace:${chestKey(worldId, rec.dim, rec.pos)}`, rec, {
    kind: 'place',
    source: 'program',
    tag: 'resource',
    label: `furnace${rec.burning ? ' (burning)' : ''}`,
    dim: rec.dim,
    location: { kind: 'exact', pos: nodePoint(rec.pos) },
    observedAt: rec.ts,
    externalRef: chestKey(worldId, rec.dim, rec.pos),
  });
}

function farmNode(worldId: string, rec: FarmRecord): SpatialNode {
  return nodeFor(worldId, 'farm', rec.id, rec, {
    kind: 'place',
    source: 'program',
    tag: 'resource',
    label: `farm: ${rec.crop}`,
    dim: rec.dim,
    location: regionOf(rec.cells),
    observedAt: rec.plantedAt,
    externalRef: rec.id,
  });
}

function hazardNode(worldId: string, rec: Hazard): SpatialNode {
  return nodeFor(worldId, 'hazard', rec.id, rec, {
    kind: 'place',
    source: 'program',
    tag: 'danger',
    label: `danger: ${rec.kind}${rec.note ? ` (${rec.note})` : ''}`,
    dim: rec.dim,
    location: { kind: 'region', center: nodePoint(rec.pos), radius: rec.radius },
    observedAt: rec.ts,
    externalRef: rec.id,
  });
}

function goneNode(worldId: string, rec: GoneSpot): SpatialNode {
  const id = `gone:${worldId}:${rec.dim}:${rec.pos.x},${rec.pos.y},${rec.pos.z}:${rec.label}`;
  return nodeFor(worldId, 'gone', id, rec, {
    kind: 'place',
    source: 'program',
    tag: 'discovery',
    label: `gone: ${rec.label}`,
    dim: rec.dim,
    location: { kind: 'exact', pos: nodePoint(rec.pos) },
    observedAt: rec.ts,
    externalRef: id,
  });
}

function recordFromNode<T>(node: SpatialNode): T | undefined {
  const curio = metaOf(node.metadata);
  const record = curio?.record;
  return record && typeof record === 'object' ? (clone(record) as T) : undefined;
}

/**
 * Spatial-store-backed semantic memory.
 *
 * The host keeps the old `WorldMemory` record shapes and policy code; this
 * adapter is the only persistence boundary. It loads the semantic records from
 * the library's fragments/nodes/ledger and writes them back as opaque metadata,
 * so the new store is the single authority at rest.
 */
export class SpatialMemoryBackend {
  private worldId: string;
  private lastSavedSignature = '';
  private readonly placedSource = new Map<string, 'legacy' | 'live'>();
  /** Passage IDs loaded from the store; they stay `legacy` when re-saved. New IDs are `traversal`. */
  private readonly legacyPassageIds = new Set<string>();

  constructor(private readonly session: SpatialSessionLike, worldId?: string) {
    this.worldId = worldId ?? session.history.worldId;
    if (this.worldId !== session.history.worldId) throw new Error(`spatial backend world mismatch: ${this.worldId} != ${session.history.worldId}`);
  }

  get world(): string { return this.worldId; }

  /** The underlying library stores, for host facades that share the same session. */
  get stores(): SpatialSessionLike { return this.session; }

  selectWorld(worldId: string): void {
    if (worldId !== this.worldId) {
      throw new Error(`spatial session is bound to world ${this.worldId}; cannot switch to ${worldId} without reopening`);
    }
  }

  load(): SemanticSnapshot {
    const passages: PassageRecord[] = [];
    const passageArchive: PassageRecord[] = [];
    for (const fragment of allFragments(this.session.history)) {
      const meta = metaOf(fragment.metadata);
      if (meta?.type !== 'passage') continue;
      this.legacyPassageIds.add(fragment.id);
      const record = fragmentRecord(fragment);
      if (record.archivedAt !== undefined) passageArchive.push(record);
      else passages.push(record);
    }

    const landmarks: Landmark[] = [];
    const chests: Record<string, ChestRecord> = {};
    const furnaces: Record<string, FurnaceRecord> = {};
    const farms: FarmRecord[] = [];
    const hazards: Hazard[] = [];
    const gone: GoneSpot[] = [];
    let chestOps = 0;
    for (const node of allNodes(this.session.topology)) {
      const meta = metaOf(node.metadata);
      const type = meta?.type;
      if (!type || !MANAGED_TYPES.has(type)) continue;
      if (type === 'meta') {
        const record = recordFromNode<{ chestOps?: number }>(node);
        chestOps = typeof record?.chestOps === 'number' ? record.chestOps : 0;
        continue;
      }
      if (type === 'landmark') {
        const record = recordFromNode<Landmark>(node);
        if (record) landmarks.push({ ...record, worldId: record.worldId ?? this.worldId, pos: nodePoint(record.pos) });
      } else if (type === 'chest') {
        const record = recordFromNode<ChestRecord>(node);
        if (record) chests[chestKey(this.worldId, record.dim, record.pos)] = record;
      } else if (type === 'furnace') {
        const record = recordFromNode<FurnaceRecord>(node);
        if (record) furnaces[chestKey(this.worldId, record.dim, record.pos)] = record;
      } else if (type === 'farm') {
        const record = recordFromNode<FarmRecord>(node);
        if (record) farms.push(record);
      } else if (type === 'hazard') {
        const record = recordFromNode<Hazard>(node);
        if (record) hazards.push(record);
      } else if (type === 'gone') {
        const record = recordFromNode<GoneSpot>(node);
        if (record) gone.push(record);
      }
    }

    const placedRaw = this.session.ledger.placedBlocks();
    const placed = placedRaw.map((record) => {
      this.placedSource.set(posKey(record.pos), record.source);
      return { pos: nodePoint(record.pos), name: record.name, at: record.lruAt };
    });
    const visitedChunks: Record<string, number> = {};
    for (const visit of this.session.ledger.chunkVisits()) {
      visitedChunks[`${this.worldId}:${visit.dim}:${visit.cx}:${visit.cz}`] = visit.count;
    }

    return { worldId: this.worldId, passages, passageArchive, landmarks, chests, chestOps, furnaces, gone, farms, hazards, placed, visitedChunks };
  }

  /** Upsert one passage immediately so new walk/query entries are visible without waiting for a flush. */
  savePassageNow(rec: PassageRecord): void {
    const source = this.legacyPassageIds.has(rec.id) ? 'legacy' : 'traversal';
    const existing = this.session.history.getFragment(rec.id);
    if (!existing) this.session.history.saveFragment(fragmentFor(rec, this.worldId, source));
    else this.session.history.updateFragment(rec.id, fragmentChanges(rec, source));
  }

  forgetPassageNow(id: string): void {
    if (this.session.history.getFragment(id)) this.session.history.forgetFragment(id);
  }

  /** Persist the complete semantic projection. Records absent from the snapshot are removed. */
  save(snapshot: SemanticSnapshot): void {
    if (snapshot.worldId !== this.worldId) throw new Error(`semantic snapshot world mismatch: ${snapshot.worldId} != ${this.worldId}`);
    const signature = JSON.stringify(snapshot);
    if (signature === this.lastSavedSignature) return;

    const live = new Map(snapshot.passages.map((rec) => [rec.id, rec]));
    const archive = new Map(snapshot.passageArchive.map((rec) => [rec.id, rec]));
    const desiredFragments = new Map([...live, ...archive]);
    for (const fragment of allFragments(this.session.history)) {
      const meta = metaOf(fragment.metadata);
      if (meta?.type === 'passage' && !desiredFragments.has(fragment.id)) this.session.history.forgetFragment(fragment.id);
    }
    for (const [id, rec] of desiredFragments) {
      const source = this.legacyPassageIds.has(id) ? 'legacy' : 'traversal';
      const desired = fragmentFor(rec, this.worldId, source);
      const existing = this.session.history.getFragment(id);
      if (!existing) this.session.history.saveFragment(desired);
      else if (!isDeepStrictEqual(existing, desired)) this.session.history.updateFragment(id, fragmentChanges(rec, source));
    }

    const desiredNodes = new Map<string, SpatialNode>();
    for (const rec of snapshot.landmarks) desiredNodes.set(rec.id, landmarkNode(this.worldId, rec));
    for (const rec of Object.values(snapshot.chests)) {
      const node = chestNode(this.worldId, rec);
      desiredNodes.set(node.id, node);
    }
    for (const rec of Object.values(snapshot.furnaces)) {
      const node = furnaceNode(this.worldId, rec);
      desiredNodes.set(node.id, node);
    }
    for (const rec of snapshot.farms) desiredNodes.set(rec.id, farmNode(this.worldId, rec));
    for (const rec of snapshot.hazards) desiredNodes.set(rec.id, hazardNode(this.worldId, rec));
    for (const rec of snapshot.gone) {
      const node = goneNode(this.worldId, rec);
      desiredNodes.set(node.id, node);
    }
    desiredNodes.set('curio:meta', nodeFor(this.worldId, 'meta', 'curio:meta', { chestOps: snapshot.chestOps }, {
      kind: 'place', source: 'program', label: 'curio meta', dim: 'overworld',
      location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } },
    }));

    for (const node of allNodes(this.session.topology)) {
      const meta = metaOf(node.metadata);
      if (meta?.type && MANAGED_TYPES.has(meta.type) && !desiredNodes.has(node.id)) this.session.topology.forgetNode(node.id);
    }
    for (const [id, desired] of desiredNodes) {
      const existing = this.session.topology.getNode(id);
      if (!existing) { this.session.topology.saveNode(desired); continue; }
      if (isDeepStrictEqual(existing, desired)) continue;
      if (existing.source !== desired.source) {
        this.session.topology.forgetNode(id);
        this.session.topology.saveNode(desired);
        continue;
      }
      this.session.topology.updateNode(id, {
        kind: desired.kind,
        tag: desired.tag,
        label: desired.label,
        location: desired.location,
        observedAt: desired.observedAt,
        externalRef: desired.externalRef,
        durable: true,
        metadata: desired.metadata,
      });
    }

    const current = this.session.ledger.snapshot();
    const currentPlaced = new Map<string, PlacedBlockRecord>(current.placed.map((record) => [posKey(record.pos), record] as const));
    const desiredPlaced: PlacedBlockRecord[] = snapshot.placed.map((entry) => {
      const prior = currentPlaced.get(posKey(entry.pos));
      const dim = prior?.dim ?? null;
      const source = prior?.source ?? this.placedSource.get(posKey(entry.pos)) ?? 'live';
      return {
        key: placedBlockKey(this.worldId, dim, entry.pos.x, entry.pos.y, entry.pos.z),
        worldId: this.worldId,
        dim,
        pos: nodePoint(entry.pos),
        name: entry.name,
        lruAt: entry.at,
        source,
      };
    });
    const currentVisits = new Map<string, ChunkVisitRecord>(current.visits.map((record) => [record.key, record] as const));
    const desiredVisits: ChunkVisitRecord[] = Object.entries(snapshot.visitedChunks).flatMap(([key, count]) => {
      const prefix = `${this.worldId}:`;
      if (!key.startsWith(prefix)) return [];
      const rest = key.slice(prefix.length);
      const parts = rest.split(':');
      if (parts.length !== 3) return [];
      const dim = parts[0]!;
      const cx = Number(parts[1]);
      const cz = Number(parts[2]);
      if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz) || !Number.isSafeInteger(count) || count < 0) return [];
      const visitKey = chunkVisitKey(this.worldId, dim, cx, cz);
      const prior = currentVisits.get(visitKey);
      return [{
        key: visitKey,
        worldId: this.worldId,
        dim,
        cx,
        cz,
        count,
        source: prior?.source ?? 'live' as const,
      }];
    });
    const placedSame = desiredPlaced.length === current.placed.length
      && desiredPlaced.every((record) => {
        const prior = currentPlaced.get(posKey(record.pos));
        return prior !== undefined && isDeepStrictEqual(prior, record);
      });
    const visitsSame = desiredVisits.length === current.visits.length
      && desiredVisits.every((record) => {
        const prior = currentVisits.get(record.key);
        return prior !== undefined && isDeepStrictEqual(prior, record);
      });
    if (!placedSame || !visitsSame) {
      const ledger: LedgerSnapshot = {
        worldId: this.worldId,
        placed: desiredPlaced,
        visits: desiredVisits,
        traversals: current.traversals,
      };
      this.session.ledger.restoreSnapshot(ledger);
    }
    this.lastSavedSignature = signature;
  }

  counts(): { fragments: number; nodes: number; placed: number; visits: number } {
    return {
      fragments: allFragments(this.session.history).length,
      nodes: allNodes(this.session.topology).length,
      placed: this.session.ledger.placedBlocks().length,
      visits: this.session.ledger.chunkVisits().length,
    };
  }
}
