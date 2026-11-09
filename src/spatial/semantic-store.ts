import type {
  FragmentChanges,
  FragmentStore,
  JsonObject,
  JsonValue,
  LandmarkTag,
  PathFragment,
  SpatialNode,
  TopologyStore,
} from 'curio-minecraft-3d-memory';
import type {
  ChunkVisitRecord,
  LedgerStore,
  PlacedBlockRecord,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import type { ContainerLedger } from '../memory/container-ledger.ts';
import { applyContents, chestLocation, isContainerLandmark, recall, totalStock, type ChestContents, type ChestRecall, type ChestRecord, type ChestUse, type Clock } from '../memory/chest-memory.ts';
import type { FarmRecord, FurnaceRecord, GoneSpot, Hazard, HazardKind, Landmark, LandmarkKind, PassageRecord } from '../memory/store.ts';

/** The three in-memory library stores a spatial session exposes. */
export interface SpatialLibraryStores {
  readonly history: FragmentStore;
  readonly topology: TopologyStore;
  readonly ledger: LedgerStore;
}

/** Old WorldMemory policy constants, now applied over library nodes. */
export const LANDMARK_CAP = 200;
export const DISCOVERY_LABEL_CAP = 8;
export const EXCAVATION_WAYPOINT_CAP = 8;
export const PASSAGE_LIVE_CAP = 24;
export const PASSAGE_ARCHIVE_CAP = 512;
export const PASSAGE_BRIDGE_ARCHIVE_CAP = 64;
export const BASE_CAP = 64;
export const HERD_CAP = 40;
export const HAZARD_CAP = 40;
export const GONE_CAP = 120;

type Vec = { x: number; y: number; z: number };
type CurioType = 'landmark' | 'station' | 'container' | 'chest' | 'furnace' | 'farm' | 'hazard' | 'gone' | 'migration' | 'passage';

interface CurioMeta {
  v: 2;
  type: CurioType;
  /** Additional roles for a shared anchor (e.g. station + furnace). */
  types?: CurioType[];
  /** Whether this node is exposed through the legacy landmark view. */
  view?: 'landmark' | 'station';
  record?: JsonValue;
  primary?: boolean;
  block?: string;
  /** Passage metadata (fragment metadata only). */
  geometrySource?: 'traversal' | 'observed_structure' | 'legacy';
  dug?: number;
  ores?: Record<string, number>;
  archivedAt?: number;
  linkMeta?: unknown;
}

interface CurioMetadata {
  curio?: CurioMeta;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const metaOf = (node: SpatialNode): CurioMeta | undefined =>
  (isRecord(node.metadata) ? (node.metadata as CurioMetadata).curio : undefined);
const clone = <T>(value: T): T => structuredClone(value);
const jsonRecord = (value: object): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const point = (p: Vec3Like): Vec => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
const keyOf = (p: Vec3Like) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
const chestKey = (worldId: string, dim: string, pos: Vec3Like) =>
  `${worldId}:${dim}:${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
const metadata = (meta: CurioMeta): JsonObject => ({ curio: meta }) as unknown as JsonObject;

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

/** 重复看见已记地标时，至少隔这么久才刷新一次它的观察时间。 */
const LANDMARK_REFRESH_MS = 60_000;

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
  const curio = (isRecord(fragment.metadata) ? (fragment.metadata as CurioMetadata).curio : undefined);
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
    entrances: fragment.entrances.map(point),
    path: fragment.polyline.map(point),
    ...(fragment.links ? { links: fragment.links.map((link, i) => ({ a: point(link.a), b: point(link.b), ...flagsOf(i) })) } : {}),
    deepestY: fragment.deepestY,
    dug: typeof curio?.dug === 'number' ? curio.dug : 0,
    ores: curio?.ores && typeof curio.ores === 'object' ? (curio.ores as Record<string, number>) : {},
    createdAt: fragment.createdAt,
    lastUsedAt: fragment.lastUsedAt,
    uses: fragment.uses,
    ...(typeof curio?.archivedAt === 'number' ? { archivedAt: curio.archivedAt } : {}),
    ...(fragment.geometrySource ? { geometrySource: fragment.geometrySource } : {}),
  };
}

function passageMetadata(rec: PassageRecord): JsonObject {
  const cutBits = encodeFlags(rec.links?.map((link) => !!link.cut) ?? []);
  const reverseBits = encodeFlags(rec.links?.map((link) => !!link.reverse) ?? []);
  const linkMeta = cutBits || reverseBits
    ? { ...(cutBits ? { cut: cutBits } : {}), ...(reverseBits ? { reverse: reverseBits } : {}) }
    : undefined;
  return {
    curio: {
      v: 2,
      type: 'passage',
      geometrySource: rec.geometrySource ?? 'traversal',
      dug: rec.dug,
      ores: rec.ores,
      ...(rec.archivedAt !== undefined ? { archivedAt: rec.archivedAt } : {}),
      ...(linkMeta ? { linkMeta } : {}),
    },
  } as unknown as JsonObject;
}

function fragmentFor(rec: PassageRecord, worldId: string): PathFragment {
  return {
    id: rec.id,
    worldId: rec.worldId ?? worldId,
    dim: rec.dim,
    kind: rec.kind ?? 'walked',
    entrances: rec.entrances.map(point),
    polyline: rec.path.map(point),
    geometrySource: rec.geometrySource ?? 'traversal',
    ...(rec.links ? { links: rec.links.map((link) => ({ a: point(link.a), b: point(link.b) })) } : {}),
    deepestY: rec.deepestY,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    uses: rec.uses,
    externalRef: rec.id,
    metadata: passageMetadata(rec),
  };
}

function fragmentChanges(rec: PassageRecord): FragmentChanges {
  return {
    kind: rec.kind ?? 'walked',
    entrances: rec.entrances.map(point),
    polyline: rec.path.map(point),
    geometrySource: rec.geometrySource ?? 'traversal',
    links: rec.links?.map((link) => ({ a: point(link.a), b: point(link.b) })),
    deepestY: rec.deepestY,
    lastUsedAt: rec.lastUsedAt,
    uses: rec.uses,
    externalRef: rec.id,
    metadata: passageMetadata(rec),
  };
}

function regionOf(cells: Vec3Like[]): SpatialNode['location'] {
  if (!cells.length) return { kind: 'exact', pos: { x: 0, y: 64, z: 0 } };
  const center = {
    x: Math.round(cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length),
    y: Math.round(cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length),
    z: Math.round(cells.reduce((sum, cell) => sum + cell.z, 0) / cells.length),
  };
  return { kind: 'region', center, radius: Math.max(1, ...cells.map((cell) => dist3(cell, center))) };
}

function effectiveHazard(z: Hazard, now = Date.now()): Hazard | null {
  const fadeStart = 40 * 60_000 * Math.min(3, Math.max(1, z.count));
  const over = now - z.ts - fadeStart;
  if (over <= 0) return z;
  const radius = z.radius - 2 * Math.ceil(over / (20 * 60_000));
  return radius < 3 ? null : { ...z, radius };
}

/**
 * Native host view over the spatial library's topology, history and ledger.
 *
 * The library does not type stations/furnaces/farms/hazards/containers; their
 * host meaning lives in opaque `metadata.curio`. All reads page the library's
 * nodes/fragments and apply the old WorldMemory proximity/dedupe/cap policy here.
 * No second in-memory spatial store exists.
 */
export class SpatialSemanticStore {
  readonly worldId: string;
  private readonly sessionId: string;

  constructor(
    private readonly session: SpatialLibraryStores,
    private readonly containerLedgerStore: ContainerLedger,
    options: { sessionId?: string; worldId?: string } = {},
  ) {
    this.worldId = options.worldId ?? session.history.worldId;
    if (session.topology.worldId !== this.worldId) {
      throw new Error(`spatial semantic world mismatch: ${session.topology.worldId} != ${this.worldId}`);
    }
    this.sessionId = options.sessionId ?? 'semantic-store';
  }

  get stores(): SpatialLibraryStores { return this.session; }
  get containers(): ContainerLedger { return this.containerLedgerStore; }
  get world(): string { return this.worldId; }

  /** 按 topology 修订号缓存的全量节点（只读快照）：同一修订号内反复查地标不再每次分页克隆全部节点、重建列表索引。 */
  private nodeCache: { revision: number; nodes: SpatialNode[] } | null = null;
  private allNodes(): SpatialNode[] {
    const revision = this.session.topology.revision;
    if (this.nodeCache?.revision !== revision) this.nodeCache = { revision, nodes: allNodes(this.session.topology) };
    return [...this.nodeCache.nodes];
  }
  private allFragments(): PathFragment[] { return allFragments(this.session.history); }

  private viewOf(node: SpatialNode): 'landmark' | 'station' | undefined {
    const meta = metaOf(node);
    if (!meta || node.gone) return undefined;
    if (meta.view === 'landmark' || meta.view === 'station') return meta.view;
    return undefined;
  }

  private hasType(node: SpatialNode, type: CurioType): boolean {
    const meta = metaOf(node);
    if (type === 'container' && meta?.type === 'chest') return true;
    return meta?.type === type || !!meta?.types?.includes(type);
  }

  private landmarkView(node: SpatialNode): Landmark | undefined {
    const meta = metaOf(node);
    if (!meta || node.gone) return undefined;
    const rec = isRecord(meta.record) ? meta.record : {};
    const kind = (typeof rec.kind === 'string' ? rec.kind : node.tag ?? 'discovery') as LandmarkKind;
    const pos = node.location.kind === 'exact' ? { ...node.location.pos } : { ...node.location.center };
    const ts = typeof rec.ts === 'number' ? rec.ts : node.observedAt ?? 0;
    const container = this.hasType(node, 'container');
    const entry = container ? this.containerLedgerStore.chestAt(node.dim, pos) : undefined;
    return {
      id: node.id,
      kind,
      label: node.label ?? (typeof rec.label === 'string' ? rec.label : ''),
      dim: node.dim,
      pos,
      ts,
      ...(typeof rec.primary === 'boolean' || meta.primary !== undefined ? { primary: rec.primary === true || meta.primary === true } : {}),
      worldId: node.worldId,
      ...(typeof rec.count === 'number' ? { count: rec.count } : {}),
      ...(typeof rec.detail === 'string' ? { detail: rec.detail } : {}),
      ...(container ? {
        radius: 0,
        precise: true,
        observedAt: entry?.contents?.observedAt || entry?.ts || ts,
      } : {}),
    };
  }

  private typedRecord<T>(node: SpatialNode): T | undefined {
    const rec = metaOf(node)?.record;
    return isRecord(rec) ? clone(rec as T) : undefined;
  }

  private saveNode(node: SpatialNode) {
    const existing = this.session.topology.getNode(node.id);
    if (!existing) { this.session.topology.saveNode(node); return; }
    if (existing.source !== node.source) {
      this.session.topology.forgetNode(node.id);
      this.session.topology.saveNode(node);
      return;
    }
    this.session.topology.updateNode(node.id, {
      kind: node.kind,
      tag: node.tag,
      label: node.label,
      location: node.location,
      observedAt: node.observedAt,
      externalRef: node.externalRef,
      durable: node.durable,
      metadata: node.metadata,
    });
  }

  private updateNode(id: string, changes: Parameters<TopologyStore['updateNode']>[1]) {
    return this.session.topology.updateNode(id, changes);
  }

  private mergeMeta(node: SpatialNode, patch: Partial<CurioMeta>): CurioMeta {
    const current = metaOf(node) ?? { v: 2, type: 'landmark' as const };
    return { ...current, ...patch };
  }

  /** All legacy landmark views, including stations but excluding typed records. */
  landmarks(): Landmark[] {
    return this.allNodes()
      .filter((node) => this.viewOf(node) !== undefined)
      .flatMap((node) => {
        const view = this.landmarkView(node);
        return view ? [view] : [];
      });
  }

  addLandmark(kind: LandmarkKind, label: string, dim: string, pos: Vec3Like, dedupeRadius = 24): Landmark | null {
    const radius = kind === 'discovery' && isContainerLandmark(label) ? 0.1 : dedupeRadius;
    const at = point(pos);
    const nodes = this.allNodes();
    const near = nodes.find((node) => !node.gone && node.dim === dim && node.tag === kind && node.label === label
      && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) < radius);
    if (near) {
      // 每帧都会重复看见同一处资源/危险：最近刚确认过就不再写（每次写都会让整张拓扑的列表索引重建）。
      if (Date.now() - (near.observedAt ?? 0) < LANDMARK_REFRESH_MS) return null;
      const meta = metaOf(near);
      if (meta && isRecord(meta.record)) {
        this.updateNode(near.id, { observedAt: Date.now(), metadata: metadata(this.mergeMeta(near, { record: { ...meta.record, ts: Date.now(), kind, label, dim, pos: at } })) });
      } else {
        this.updateNode(near.id, { observedAt: Date.now() });
      }
      return null;
    }

    if (kind === 'discovery') {
      if (!label.startsWith('我的')) {
        const own = nodes.find((node) => !node.gone && node.dim === dim && node.label === `我的${label}`
          && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) <= radius);
        if (own) {
          if (Date.now() - (own.observedAt ?? 0) >= LANDMARK_REFRESH_MS) this.updateNode(own.id, { observedAt: Date.now() });
          return null;
        }
      } else {
        const plain = label.slice(2);
        for (const node of nodes) {
          if (node.gone || node.dim !== dim || node.label !== plain) continue;
          if (node.tag !== 'discovery' && !this.hasType(node, 'container') && !this.hasType(node, 'furnace')) continue;
          if (dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) > (isContainerLandmark(plain) ? 0.1 : 2)) continue;
          this.dropLandmarkView(node);
        }
      }
    }

    // Merge with an existing typed anchor at the same cell (container/furnace/station).
    if (kind === 'discovery') {
      const typed = nodes.find((node) => !node.gone && node.dim === dim
        && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) <= (isContainerLandmark(label) ? 0.1 : 2)
        && (this.hasType(node, 'container') || this.hasType(node, 'furnace')));
      if (typed) {
        const meta = this.mergeMeta(typed, {
          view: label.startsWith('我的') ? 'station' : 'landmark',
          types: [...new Set([...(metaOf(typed)?.types ?? []), metaOf(typed)?.type ?? 'landmark', 'station' as const])],
          record: jsonRecord({ kind, label, dim, pos: at, ts: Date.now(), worldId: this.worldId }),
        });
        this.updateNode(typed.id, {
          label,
          observedAt: Date.now(),
          metadata: metadata(meta),
        });
        const merged = this.session.topology.getNode(typed.id);
        return merged ? this.landmarkView(merged) ?? null : null;
      }
    }

    const id = shortId(`${kind.slice(0, 3)}_`);
    const source = kind === 'base' || kind === 'discovery' || kind === 'waypoint' || kind === 'death' ? 'agent' as const : 'program' as const;
    const type: CurioType = isContainerLandmark(label) ? 'container' : 'landmark';
    const node: SpatialNode = {
      id,
      kind: 'place',
      source,
      tag: kind as LandmarkTag,
      label,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: at },
      observedAt: Date.now(),
      externalRef: id,
      durable: source === 'agent',
      metadata: metadata({
        v: 2,
        type,
        view: label.startsWith('我的') ? 'station' : 'landmark',
        record: jsonRecord({ kind, label, dim, pos: at, ts: Date.now(), worldId: this.worldId }),
      }),
    };
    this.saveNode(node);
    this.enforceLandmarkCaps();
    const saved = this.session.topology.getNode(id);
    return saved ? this.landmarkView(saved) ?? null : null;
  }

  private dropLandmarkView(node: SpatialNode) {
    const meta = metaOf(node);
    if (!meta) return;
    if (this.hasType(node, 'container') || this.hasType(node, 'furnace')) {
      const next = { ...meta };
      delete next.view;
      this.updateNode(node.id, { metadata: metadata(next) });
    } else {
      this.session.topology.forgetNode(node.id);
    }
  }

  private enforceLandmarkCaps() {
    const nodes = this.allNodes().filter((node) => this.viewOf(node) !== undefined);
    const byTs = (a: SpatialNode, b: SpatialNode) => (metaOf(a)?.record as { ts?: number } | undefined)?.ts ?? a.observedAt ?? 0
      - ((metaOf(b)?.record as { ts?: number } | undefined)?.ts ?? b.observedAt ?? 0);
    const forgetOldest = (list: SpatialNode[]) => {
      const oldest = [...list].sort(byTs)[0];
      if (oldest) this.session.topology.forgetNode(oldest.id);
    };
    for (const [label, group] of Object.entries(nodes.filter((n) => n.tag === 'discovery').reduce<Record<string, SpatialNode[]>>((groups, node) => {
      (groups[node.label ?? ''] ??= []).push(node);
      return groups;
    }, {}))) {
      if (label && group.length > DISCOVERY_LABEL_CAP) forgetOldest(group.slice().sort(byTs).slice(0, group.length - DISCOVERY_LABEL_CAP));
    }
    const herds = nodes.filter((node) => node.tag === 'herd');
    if (herds.length > HERD_CAP) forgetOldest(herds.slice().sort(byTs).slice(0, herds.length - HERD_CAP));
    if (nodes.length <= LANDMARK_CAP) return;
    const tiers: ((node: SpatialNode) => boolean)[] = [
      (node) => ['herd', 'danger', 'death'].includes(node.tag ?? ''),
      (node) => node.tag === 'resource',
      (node) => node.tag === 'waypoint',
      (node) => node.tag === 'discovery' && !(node.label ?? '').startsWith('我的') && !isContainerLandmark(node.label ?? ''),
    ];
    for (const tier of tiers) {
      const candidate = nodes.filter(tier).sort(byTs)[0];
      if (candidate) { this.session.topology.forgetNode(candidate.id); return; }
    }
  }

  markGone(label: string, dim: string, pos: Vec3Like, now: string) {
    const at = point(pos);
    const live = this.allNodes().find((node) => !node.gone && node.dim === dim && node.label === label
      && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) <= 1);
    const observedAt = Date.now();
    if (live) {
      const evidence = { sessionId: this.sessionId, observedAt: Math.max(observedAt, live.observedAt ?? 0), source: 'program' as const, reason: now };
      const meta = metaOf(live);
      if (meta && isRecord(meta.record)) {
        this.updateNode(live.id, { metadata: metadata({ ...meta, record: { ...meta.record, now, ts: observedAt } }) });
      }
      this.session.topology.markGone(live.id, evidence);
      return;
    }
    const id = `gone:${this.worldId}:${dim}:${keyOf(at)}:${label}`;
    const existing = this.session.topology.getNode(id);
    const record = { worldId: this.worldId, dim, label, pos: at, now, ts: observedAt };
    if (existing) {
      this.updateNode(id, { observedAt, metadata: metadata({ v: 2, type: 'gone', record: jsonRecord(record) }) });
      if (!existing.gone) this.session.topology.markGone(id, { sessionId: this.sessionId, observedAt: Math.max(observedAt, existing.observedAt ?? 0), source: 'program', reason: now });
      return;
    }
    this.session.topology.saveNode({
      id,
      kind: 'place',
      source: 'program',
      tag: 'discovery',
      label: `gone: ${label}`,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: at },
      observedAt,
      externalRef: id,
      metadata: metadata({ v: 2, type: 'gone', record: jsonRecord(record) }),
    });
    this.session.topology.markGone(id, { sessionId: this.sessionId, observedAt, source: 'program', reason: now });
    const gone = this.allNodes().filter((node) => this.hasType(node, 'gone') && node.gone);
    if (gone.length > GONE_CAP) {
      const oldest = gone.sort((a, b) => (a.goneAt ?? 0) - (b.goneAt ?? 0))[0];
      if (oldest) this.session.topology.forgetNode(oldest.id);
    }
  }

  goneNear(dim: string, pos: Vec3Like, radius = 3): GoneSpot[] {
    const live = this.allNodes().filter((node) => !node.gone && node.dim === dim);
    return this.session.topology.goneNear(dim, point(pos), radius).flatMap((node) => {
      const record = this.typedRecord<GoneSpot>(node) ?? {
        worldId: node.worldId, dim: node.dim, label: (node.label ?? '').replace(/^gone: /, ''),
        pos: node.location.kind === 'exact' ? node.location.pos : node.location.center,
        now: node.goneEvidence?.reason ?? 'gone', ts: node.goneAt ?? node.observedAt ?? 0,
      };
      const label = record.label;
      if (live.some((other) => other.label === label && dist3(other.location.kind === 'exact' ? other.location.pos : other.location.center, record.pos) <= 1)) return [];
      return [{ ...record, worldId: this.worldId, pos: point(record.pos) }];
    });
  }

  removeLandmark(id: string): boolean {
    const node = this.session.topology.getNode(id);
    if (!node || node.tag === 'base') return false;
    if (this.hasType(node, 'container') || this.hasType(node, 'furnace')) {
      this.dropLandmarkView(node);
    } else {
      this.session.topology.forgetNode(id);
    }
    return true;
  }

  forgetLandmark(id: string): Landmark | null {
    const node = this.session.topology.getNode(id);
    if (!node) return null;
    const view = this.landmarkView(node);
    const pos = node.location.kind === 'exact' ? node.location.pos : node.location.center;
    if (node.tag === 'base' && metaOf(node)?.record && (metaOf(node)!.record as { primary?: boolean }).primary) {
      const next = this.bases(node.dim).filter((base) => base.id !== id).sort((a, b) => b.ts - a.ts)[0];
      if (next) this.selectBase(next.id);
    }
    if (this.hasType(node, 'container')) this.containerLedgerStore.forgetChest(node.dim, pos);
    if (this.hasType(node, 'furnace')) this.containerLedgerStore.forgetFurnace(node.dim, pos);
    this.session.topology.forgetNode(id);
    return view ?? null;
  }

  noteHerd(label: string, dim: string, pos: Vec3Like, count: number, detail?: string): Landmark {
    const at = point(pos);
    const near = this.allNodes().find((node) => !node.gone && node.dim === dim && node.tag === 'herd' && node.label === label
      && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) < 32);
    const record = { kind: 'herd', label, dim, pos: at, ts: Date.now(), worldId: this.worldId, count, ...(detail ? { detail } : {}) };
    if (near) {
      this.updateNode(near.id, {
        location: { kind: 'exact', pos: at }, observedAt: Date.now(),
        metadata: metadata({ ...this.mergeMeta(near, { record: jsonRecord(record) }) }),
      });
      return this.landmarkView(this.session.topology.getNode(near.id)!)!;
    }
    const herds = this.allNodes().filter((node) => !node.gone && node.tag === 'herd').sort((a, b) => (a.observedAt ?? 0) - (b.observedAt ?? 0));
    if (herds.length >= HERD_CAP) this.session.topology.forgetNode(herds[0]!.id);
    const id = shortId('herd_');
    this.session.topology.saveNode({
      id, kind: 'place', source: 'program', tag: 'herd', label, worldId: this.worldId, dim,
      location: { kind: 'exact', pos: at }, observedAt: Date.now(), externalRef: id,
      metadata: metadata({ v: 2, type: 'landmark', view: 'landmark', record: jsonRecord(record) }),
    });
    return this.landmarkView(this.session.topology.getNode(id)!)!;
  }

  resourceLandmarksNear(names: string[], dim: string, pos: Vec3Like, radius: number): Landmark[] {
    return this.landmarks().filter((landmark) => landmark.kind === 'resource' && landmark.dim === dim
      && names.includes(landmark.label) && dist3(landmark.pos, pos) <= radius);
  }

  setBase(dim: string, pos: Vec3Like, label?: string, opts: { select?: boolean } = {}): Landmark {
    if (typeof dim !== 'string' || !dim || !pos || [pos.x, pos.y, pos.z].some((n) => !Number.isFinite(n))) throw new Error('基地需要实际维度与有限坐标');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('基地名称需要 1–100 字符');
    const basePos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const bases = this.bases(dim);
    const hadPrimary = bases.some((base) => base.primary);
    const near = bases.filter((base) => dist3(base.pos, pos) <= 4).sort((a, b) => dist3(a.pos, pos) - dist3(b.pos, pos))[0];
    if (!near && bases.length >= BASE_CAP) throw new Error('当前世界已保存 64 个基地，需要先人工回顾，不能静默丢弃旧基地');
    if (!near && this.landmarks().length >= LANDMARK_CAP) {
      const disposable = this.landmarks().filter((landmark) => ['herd', 'resource', 'danger', 'death'].includes(landmark.kind)).sort((a, b) => a.ts - b.ts)[0];
      if (!disposable) throw new Error('地标档案已满；保留所有重要地点，无法新增基地');
      this.session.topology.forgetNode(disposable.id);
    }
    if (near) {
      const node = this.session.topology.getNode(near.id)!;
      const meta = metaOf(node);
      const record = isRecord(meta?.record) ? meta.record : {};
      const next = { ...record, kind: 'base', label: label?.trim() ?? near.label, dim, pos: basePos, ts: Date.now(), worldId: this.worldId };
      this.updateNode(near.id, { label: label?.trim() ?? near.label, location: { kind: 'exact', pos: basePos }, observedAt: Date.now(), metadata: metadata({ ...this.mergeMeta(node, { record: jsonRecord(next) }) }) });
      const select = opts.select ?? !hadPrimary;
      return select ? this.selectBase(near.id) : this.landmarkView(this.session.topology.getNode(near.id)!)!;
    }
    const id = shortId('base_');
    const finalLabel = label?.trim() ?? `基地 ${bases.length + 1}`;
    this.session.topology.saveNode({
      id, kind: 'place', source: 'agent', tag: 'base', label: finalLabel, worldId: this.worldId, dim,
      location: { kind: 'exact', pos: basePos }, observedAt: Date.now(), externalRef: id, durable: true,
      metadata: metadata({ v: 2, type: 'landmark', view: 'landmark', record: jsonRecord({ kind: 'base', label: finalLabel, dim, pos: basePos, ts: Date.now(), worldId: this.worldId }) }),
    });
    const select = opts.select ?? !hadPrimary;
    return select ? this.selectBase(id) : this.landmarkView(this.session.topology.getNode(id)!)!;
  }

  private baseNodes(dim?: string): SpatialNode[] {
    return this.allNodes().filter((node) => !node.gone && node.tag === 'base' && (!dim || node.dim === dim));
  }

  base(dim?: string): Landmark | undefined {
    const bases = this.bases(dim);
    return bases.find((base) => base.primary) ?? bases[0];
  }

  bases(dim?: string): Landmark[] {
    return this.baseNodes(dim).flatMap((node) => {
      const view = this.landmarkView(node);
      return view ? [view] : [];
    });
  }

  selectBase(id: string): Landmark {
    const selected = this.session.topology.getNode(id);
    if (!selected || selected.tag !== 'base') throw new Error('只能选择当前世界中实际记得的基地');
    for (const node of this.baseNodes(selected.dim)) {
      const meta = metaOf(node);
      const rec = isRecord(meta?.record) ? meta.record : {};
      this.updateNode(node.id, {
        observedAt: node.id === id ? Date.now() : node.observedAt,
        metadata: metadata({ ...this.mergeMeta(node, { primary: node.id === id, record: jsonRecord({ ...rec, primary: node.id === id }) }) }),
      });
    }
    return this.landmarkView(this.session.topology.getNode(id)!)!;
  }

  findLandmark(q: string, dim?: string): Landmark | undefined {
    const s = q.trim().toLowerCase();
    if (s === 'base' || s === '基地') return this.base(dim);
    const candidates = this.landmarks().filter((landmark) => !dim || landmark.dim === dim);
    const found = candidates.find((landmark) => landmark.id.toLowerCase() === s)
      ?? candidates.find((landmark) => landmark.label.toLowerCase() === s)
      ?? candidates.find((landmark) => landmark.label.toLowerCase().includes(s));
    if (!found || !isContainerLandmark(found.label)) return found;
    const location = chestLocation(found);
    return { ...found, pos: location.pos, radius: location.radius, precise: location.precise, observedAt: location.observedAt };
  }

  // ---------------------------------------------------------------- containers

  private containerNodes(): SpatialNode[] {
    return this.allNodes().filter((node) => !node.gone && this.hasType(node, 'container'));
  }

  private containerNodeAt(dim: string, pos: Vec3Like): SpatialNode | undefined {
    const at = point(pos);
    return this.containerNodes().find((node) => node.dim === dim
      && dist3(node.location.kind === 'exact' ? node.location.pos : node.location.center, at) <= 0.1);
  }

  private ensureContainerNode(dim: string, pos: Vec3Like, block = 'chest', note?: string): SpatialNode {
    const existing = this.containerNodeAt(dim, pos);
    if (existing) {
      const meta = this.mergeMeta(existing, {
        type: 'container',
        types: [...new Set([...(metaOf(existing)?.types ?? []), metaOf(existing)?.type ?? 'landmark', 'container' as const])],
        block,
      });
      if (metaOf(existing)?.type !== 'container') this.updateNode(existing.id, { metadata: metadata(meta) });
      return this.session.topology.getNode(existing.id)!;
    }
    const at = point(pos);
    const id = `chest:${chestKey(this.worldId, dim, at)}`;
    const now = Date.now();
    const node: SpatialNode = {
      id, kind: 'place', source: 'program', tag: 'resource', label: `chest${note ? `: ${note}` : ''}`,
      worldId: this.worldId, dim, location: { kind: 'exact', pos: at }, observedAt: now, externalRef: chestKey(this.worldId, dim, at),
      metadata: metadata({ v: 2, type: 'container', block, record: jsonRecord({ ts: now, uses: 0, block, ...(note ? { note } : {}) }) }),
    };
    this.session.topology.saveNode(node);
    return node;
  }

  private saveContainerMetadata(node: SpatialNode, entry: ChestRecord) {
    const meta = metaOf(node) ?? { v: 2, type: 'container' as const };
    const record = {
      ts: entry.ts,
      uses: entry.uses,
      block: entry.block,
      ...(entry.day !== undefined ? { day: entry.day } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    };
    this.updateNode(node.id, {
      observedAt: entry.contents?.observedAt || entry.ts,
      metadata: metadata({ ...meta, block: entry.block, record: jsonRecord(record) }),
    });
  }

  noteChestUse(dim: string, pos: Vec3Like, use: ChestUse): ChestRecord {
    const node = this.ensureContainerNode(dim, pos, use.block ?? 'chest', use.note);
    const entry = this.containerLedgerStore.noteChestUse(dim, pos, use, node.id);
    this.saveContainerMetadata(node, entry);
    return entry;
  }

  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[], day?: number) {
    return this.noteChestUse(dim, pos, { put: items, seen: items, day });
  }

  forgetChest(dim: string, pos: Vec3Like) {
    this.containerLedgerStore.forgetChest(dim, pos);
    const node = this.containerNodeAt(dim, pos);
    if (!node) return;
    const meta = metaOf(node);
    if (!meta) { this.session.topology.forgetNode(node.id); return; }
    if (meta.view) {
      const types = meta.types?.filter((type) => type !== 'container');
      const next: CurioMeta = { ...meta, types, type: types?.[0] ?? 'landmark' };
      this.updateNode(node.id, { metadata: metadata(next) });
    } else {
      this.session.topology.forgetNode(node.id);
    }
  }

  chests(dim?: string): ChestRecord[] {
    const entries = new Map<string, ChestRecord>(this.containerLedgerStore.chests(dim).map((entry) => [chestKey(this.worldId, entry.dim, entry.pos), entry] as const));
    for (const node of this.containerNodes()) {
      if (dim && node.dim !== dim) continue;
      const pos = node.location.kind === 'exact' ? node.location.pos : node.location.center;
      const key = chestKey(this.worldId, node.dim, pos);
      if (!entries.has(key)) {
        entries.set(key, {
          worldId: this.worldId, dim: node.dim, pos: point(pos), block: metaOf(node)?.block ?? 'chest', uses: 0,
          ts: node.observedAt ?? 0, contents: { items: [], observedAt: 0, possiblyStale: true }, nodeId: node.id,
        } as ChestRecord);
      }
    }
    return [...entries.values()].map(clone);
  }

  chestAt(dim: string, pos: Vec3Like): ChestRecord | undefined {
    return this.containerLedgerStore.chestAt(dim, pos);
  }

  chestClock(day?: number): Clock { return this.containerLedgerStore.chestClock(day); }

  recallChests(accept: string | ((name: string) => boolean), opts: { dim?: string; day?: number; from?: Vec3Like } = {}): ChestRecall[] {
    const fn = typeof accept === 'string' ? (name: string) => name === accept : accept;
    return recall(this.chests(opts.dim), fn, this.chestClock(opts.day), opts.from);
  }

  // ---------------------------------------------------------------- furnaces

  private furnaceNodes(): SpatialNode[] {
    return this.allNodes().filter((node) => !node.gone && this.hasType(node, 'furnace'));
  }

  setFurnace(rec: Omit<FurnaceRecord, 'worldId' | 'ts'> & { ts?: number }) {
    const at = point(rec.pos);
    const node = this.furnaceNodes().find((candidate) => candidate.dim === rec.dim
      && dist3(candidate.location.kind === 'exact' ? candidate.location.pos : candidate.location.center, at) <= 2);
    const entry = this.containerLedgerStore.setFurnace(rec, node?.id);
    if (!entry) {
      this.containerLedgerStore.forgetFurnace(rec.dim, rec.pos);
      if (!node) return;
      const meta = metaOf(node);
      if (!meta?.view) { this.session.topology.forgetNode(node.id); return; }
      this.updateNode(node.id, { metadata: metadata({ ...meta, types: meta.types?.filter((type) => type !== 'furnace'), type: meta.types?.find((type) => type !== 'furnace') ?? 'landmark' }) });
      return;
    }
    if (node) {
      const meta = this.mergeMeta(node, {
        type: 'furnace',
        types: [...new Set([...(metaOf(node)?.types ?? []), metaOf(node)?.type ?? 'landmark', 'furnace' as const])],
        block: rec.block,
        record: jsonRecord({ ts: entry.ts, block: rec.block, ...(node.label ? {} : {}) }),
      });
      this.updateNode(node.id, { observedAt: rec.ts ?? Date.now(), metadata: metadata(meta) });
      return;
    }
    const id = `furnace:${chestKey(this.worldId, rec.dim, at)}`;
    this.session.topology.saveNode({
      id, kind: 'place', source: 'program', tag: 'resource', label: `furnace${rec.burning ? ' (burning)' : ''}`,
      worldId: this.worldId, dim: rec.dim, location: { kind: 'exact', pos: at }, observedAt: rec.ts ?? Date.now(),
      externalRef: chestKey(this.worldId, rec.dim, at),
      metadata: metadata({ v: 2, type: 'furnace', block: rec.block, record: jsonRecord({ ts: entry.ts, block: rec.block }) }),
    });
  }

  forgetFurnace(dim: string, pos: Vec3Like) {
    this.containerLedgerStore.forgetFurnace(dim, pos);
    const node = this.furnaceNodes().find((candidate) => candidate.dim === dim
      && dist3(candidate.location.kind === 'exact' ? candidate.location.pos : candidate.location.center, pos) <= 2);
    if (!node) return;
    const meta = metaOf(node);
    if (!meta?.view) { this.session.topology.forgetNode(node.id); return; }
    this.updateNode(node.id, { metadata: metadata({ ...meta, types: meta.types?.filter((type) => type !== 'furnace'), type: meta.types?.find((type) => type !== 'furnace') ?? 'landmark' }) });
  }

  furnaces(dim?: string): FurnaceRecord[] {
    return this.containerLedgerStore.furnaces(dim).map((entry) => ({
      worldId: this.worldId, dim: entry.dim, pos: point(entry.pos), block: entry.block,
      input: entry.input, output: entry.output, fuel: entry.fuel, burning: entry.burning,
      ...(entry.why ? { why: entry.why } : {}), ts: entry.ts,
    }));
  }

  // ---------------------------------------------------------------- farms

  addFarm(f: FarmRecord) {
    const at = point(f.cells[0] ?? { x: 0, y: 64, z: 0 });
    const node: SpatialNode = {
      id: f.id, kind: 'place', source: 'program', tag: 'resource', label: `farm: ${f.crop}`,
      worldId: this.worldId, dim: f.dim, location: regionOf(f.cells), observedAt: f.plantedAt, externalRef: f.id,
      metadata: metadata({ v: 2, type: 'farm', record: jsonRecord({ ...f, worldId: this.worldId, pos: at }) }),
    };
    this.saveNode(node);
  }

  farms(): FarmRecord[] {
    return this.allNodes().filter((node) => !node.gone && this.hasType(node, 'farm')).flatMap((node) => {
      const record = this.typedRecord<FarmRecord>(node);
      return record ? [{ ...record, worldId: this.worldId }] : [];
    });
  }

  updateFarm(id: string, patch: Partial<FarmRecord>) {
    const node = this.session.topology.getNode(id);
    if (!node) return;
    const record = { ...(this.typedRecord<FarmRecord>(node) ?? {}), ...patch } as FarmRecord;
    const meta = this.mergeMeta(node, { record: jsonRecord(record) });
    this.updateNode(id, {
      ...(record.cells ? { location: regionOf(record.cells) } : {}),
      observedAt: record.plantedAt ?? node.observedAt,
      metadata: metadata(meta),
    });
  }

  // ---------------------------------------------------------------- hazards

  private hazardRecords(): { node: SpatialNode; record: Hazard }[] {
    return this.allNodes().filter((node) => !node.gone && this.hasType(node, 'hazard')).flatMap((node) => {
      const record = this.typedRecord<Hazard>(node);
      return record ? [{ node, record: { ...record, worldId: this.worldId } }] : [];
    });
  }

  addHazard(h: { dim: string; pos: Vec3Like; kind: HazardKind; during?: string; note?: string }): Hazard {
    const pos = point(h.pos);
    const now = Date.now();
    const records = this.hazardRecords();
    for (const { node, record } of records) {
      if (!effectiveHazard(record, now - 40 * 60_000)) this.session.topology.forgetNode(node.id);
    }
    const live = this.hazardRecords();
    const old = live.find(({ record }) => record.dim === h.dim && record.kind === h.kind
      && effectiveHazard(record, now) && dist3(record.pos, pos) <= Math.max(6, record.radius));
    if (old) {
      const next: Hazard = {
        ...old.record, count: old.record.count + 1, ts: now,
        radius: Math.min(12, 4 + (old.record.count + 1) * 2),
        ...(h.during ? { during: h.during.slice(0, 120) } : {}),
        ...(h.note ? { note: h.note.slice(0, 200) } : {}),
      };
      this.updateNode(old.node.id, {
        location: { kind: 'region', center: pos, radius: next.radius },
        observedAt: now, metadata: metadata({ ...this.mergeMeta(old.node, { record: jsonRecord(next) }) }),
      });
      return clone(next);
    }
    const id = shortId('hz_');
    const hazard: Hazard = {
      id, worldId: this.worldId, dim: h.dim, pos, radius: 6, kind: h.kind, count: 1,
      ...(h.during ? { during: h.during.slice(0, 120) } : {}), ...(h.note ? { note: h.note.slice(0, 200) } : {}), firstTs: now, ts: now,
    };
    this.session.topology.saveNode({
      id, kind: 'place', source: 'program', tag: 'danger',
      label: `danger: ${h.kind}${h.note ? ` (${h.note})` : ''}`,
      worldId: this.worldId, dim: h.dim, location: { kind: 'region', center: pos, radius: 6 },
      observedAt: now, externalRef: id,
      metadata: metadata({ v: 2, type: 'hazard', record: jsonRecord(hazard) }),
    });
    const hazards = this.hazardRecords();
    if (hazards.length > HAZARD_CAP) {
      const oldest = hazards.sort((a, b) => a.record.ts - b.record.ts)[0];
      if (oldest) this.session.topology.forgetNode(oldest.node.id);
    }
    return clone(hazard);
  }

  hazards(dim?: string): Hazard[] {
    const now = Date.now();
    return this.hazardRecords()
      .filter(({ record }) => !dim || record.dim === dim)
      .flatMap(({ record }) => {
        const effective = effectiveHazard(record, now);
        return effective ? [clone(effective)] : [];
      })
      .sort((a, b) => a.ts - b.ts);
  }

  hazardAt(pos: Vec3Like, dim: string, kinds?: HazardKind[]): Hazard | null {
    let best: Hazard | null = null;
    const now = Date.now();
    for (const { record } of this.hazardRecords()) {
      if (record.dim !== dim || (kinds && !kinds.includes(record.kind))) continue;
      const effective = effectiveHazard(record, now);
      if (!effective || dist3(effective.pos, pos) > effective.radius) continue;
      if (!best || effective.count > best.count) best = effective;
    }
    return best ? clone(best) : null;
  }

  // ---------------------------------------------------------------- passages

  private passageFragments(archived: boolean, dim?: string): PathFragment[] {
    return this.allFragments().filter((fragment) => {
      const curio = isRecord(fragment.metadata) ? (fragment.metadata as CurioMetadata).curio : undefined;
      if (curio?.type !== 'passage') return false;
      if (dim && fragment.dim !== dim) return false;
      return (typeof curio.archivedAt === 'number') === archived;
    });
  }

  passages(dim?: string): PassageRecord[] {
    return this.passageFragments(false, dim).map(fragmentRecord);
  }

  archivedPassages(dim?: string): PassageRecord[] {
    return this.passageFragments(true, dim).map(fragmentRecord);
  }

  allPassages(dim?: string): PassageRecord[] {
    const live = this.passages(dim);
    const ids = new Set(live.map((record) => record.id));
    return [...live, ...this.archivedPassages(dim).filter((record) => !ids.has(record.id))];
  }

  private writePassage(rec: PassageRecord) {
    const fragment = fragmentFor(rec, this.worldId);
    const existing = this.session.history.getFragment(rec.id);
    if (!existing) { this.session.history.saveFragment(fragment); return; }
    if (existing.createdAt !== fragment.createdAt) {
      this.session.history.forgetFragment(rec.id);
      this.session.history.saveFragment(fragment);
      return;
    }
    this.session.history.updateFragment(rec.id, fragmentChanges(rec));
  }

  archivePassage(rec: PassageRecord) {
    const archived = { ...rec, worldId: rec.worldId ?? this.worldId, archivedAt: Date.now() };
    this.writePassage(archived);
    this.trimPassageArchive();
  }

  savePassage(rec: PassageRecord) {
    const copy = { ...rec, worldId: rec.worldId ?? this.worldId };
    delete copy.archivedAt;
    this.writePassage(copy);
    const live = this.passages();
    if (live.length > PASSAGE_LIVE_CAP) {
      const rank = (record: PassageRecord) => {
        const kind = record.kind ?? 'dug';
        const protectedDug = kind === 'dug' && (record.path.length >= 24 || record.deepestY <= -16) ? 1 : 0;
        return [protectedDug, kind === 'bridge' ? 0 : kind === 'walked' ? 1 : 2, record.path.length, record.lastUsedAt] as const;
      };
      const victim = live.filter((record) => record.id !== copy.id).sort((a, b) => {
        const ka = rank(a), kb = rank(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
        return 0;
      })[0];
      if (victim) this.archivePassage(victim);
    }
  }

  forgetPassage(id: string) {
    if (this.session.history.getFragment(id)) this.session.history.forgetFragment(id);
  }

  private trimPassageArchive() {
    const archived = this.archivedPassages();
    const bridges = archived.filter((record) => record.kind === 'bridge').sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    if (bridges.length > PASSAGE_BRIDGE_ARCHIVE_CAP) {
      for (const record of bridges.slice(PASSAGE_BRIDGE_ARCHIVE_CAP)) this.forgetPassage(record.id);
    }
    const left = this.archivedPassages();
    if (left.length > PASSAGE_ARCHIVE_CAP) {
      for (const record of left.sort((a, b) => a.lastUsedAt - b.lastUsedAt).slice(0, left.length - PASSAGE_ARCHIVE_CAP)) this.forgetPassage(record.id);
    }
  }

  // ---------------------------------------------------------------- ledger-backed facts

  putPlaced(pos: Vec3Like, name: string, dim?: string) {
    const at = point(pos);
    if (dim) this.session.ledger.putPlaced(dim, at, name);
    else {
      const next = Math.max(0, ...this.session.ledger.placedBlocks().map((record) => record.lruAt)) + 1;
      this.session.ledger.importUnattributedPlaced({ pos: at, name, lruAt: next, source: 'live' });
    }
    const cap = (() => {
      const raw = process.env.PLACED_BLOCKS_CAP;
      const n = raw ? Number(raw) : 4096;
      return Number.isInteger(n) && n > 0 ? n : 4096;
    })();
    const count = this.session.ledger.measure().placed;
    if (count > cap) {
      const placed = this.session.ledger.placedBlocks();
      for (const record of placed.slice(0, count - cap)) this.session.ledger.removePlaced(record.dim, record.pos);
    }
  }

  removePlaced(pos: Vec3Like, dim?: string) {
    const at = point(pos);
    if (dim) { this.session.ledger.removePlaced(dim, at); return; }
    const record = this.session.ledger.queryPlacedNearUnscoped(at, 0.1).find((item) => keyOf(item.record.pos) === keyOf(at));
    if (record) this.session.ledger.removePlaced(record.record.dim, at);
  }

  getPlaced(pos: Vec3Like, dim?: string): string | null {
    const at = point(pos);
    if (dim) return this.session.ledger.getPlaced(dim, at)?.name ?? null;
    const record = this.session.ledger.queryPlacedNearUnscoped(at, 0.1).find((item) => keyOf(item.record.pos) === keyOf(at));
    return record?.record.name ?? null;
  }

  queryPlacedNear(pos: Vec3Like, radius: number, dim?: string): { pos: Vec3Like; name: string; dist: number }[] {
    const records = dim
      ? this.session.ledger.queryPlacedNear(dim, point(pos), radius)
      : this.session.ledger.queryPlacedNearUnscoped(point(pos), radius);
    return records.map(({ record, dist }) => ({ pos: point(record.pos), name: record.name, dist }));
  }

  placedBlocks(): { pos: Vec3Like; name: string }[] {
    return this.session.ledger.placedBlocks().map((record) => ({ pos: point(record.pos), name: record.name }));
  }

  visit(dim: string, pos: Vec3Like): boolean {
    return this.session.ledger.visit(dim, point(pos)).first;
  }

  chunkVisits(dim: string, x: number, z: number): number {
    return this.session.ledger.chunkVisitCount(dim, Math.floor(x / 16), Math.floor(z / 16));
  }

  get visitedChunkCount(): number {
    return this.session.ledger.chunkVisits().length;
  }

  novelty(dim: string, x: number, z: number): number {
    return this.session.ledger.novelty(dim, Math.floor(x / 16), Math.floor(z / 16));
  }

  migrationMarker(): { version: number; completedAt: number; sources?: JsonValue } | null {
    const node = this.session.topology.getNode('curio:migration');
    if (!node) return null;
    const record = metaOf(node)?.record;
    if (!isRecord(record)) return null;
    return {
      version: typeof record.version === 'number' ? record.version : 0,
      completedAt: typeof record.completedAt === 'number' ? record.completedAt : 0,
      ...(record.sources !== undefined ? { sources: record.sources as JsonValue } : {}),
    };
  }

  writeMigrationMarker(sources: JsonValue = {}, completedAt = Date.now()) {
    const node: SpatialNode = {
      id: 'curio:migration', kind: 'place', source: 'program', tag: 'discovery',
      label: 'spatial migration', worldId: this.worldId, dim: 'overworld',
      location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } }, observedAt: completedAt,
      externalRef: 'curio:migration',
      metadata: metadata({ v: 2, type: 'migration', record: { version: 1, completedAt, sources } as JsonValue }),
    };
    this.saveNode(node);
  }

  hasManagedRecords(): boolean {
    return this.allNodes().some((node) => !!metaOf(node)) || this.allFragments().length > 0
      || this.session.ledger.placedBlocks().length > 0 || this.session.ledger.chunkVisits().length > 0
      || this.session.ledger.portalTraversals().length > 0;
  }

  counts() {
    const nodes = this.allNodes();
    const fragments = this.allFragments();
    return {
      nodes: nodes.length,
      landmarks: nodes.filter((node) => this.viewOf(node) !== undefined).length,
      containers: this.containerNodes().length,
      furnaces: this.furnaceNodes().length,
      farms: nodes.filter((node) => this.hasType(node, 'farm')).length,
      hazards: nodes.filter((node) => this.hasType(node, 'hazard')).length,
      gone: nodes.filter((node) => node.gone).length,
      fragments: fragments.filter((fragment) => isRecord(fragment.metadata) && (fragment.metadata as CurioMetadata).curio?.type === 'passage').length,
      placed: this.session.ledger.placedBlocks().length,
      visits: this.session.ledger.chunkVisits().length,
      containersLedger: this.containerLedgerStore.chests().length + this.containerLedgerStore.furnaces().length,
    };
  }
}
