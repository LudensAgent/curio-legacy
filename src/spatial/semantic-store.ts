import type {
  JsonObject,
  JsonValue,
} from 'curio-minecraft-3d-memory';
import type {
  LedgerStore,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import type { ContainerLedger } from '../memory/container-ledger.ts';
import { chestLocation, isContainerLandmark, recall, type ChestRecall, type ChestRecord, type ChestUse, type Clock } from '../memory/chest-memory.ts';
import type { FarmRecord, FurnaceRecord, GoneSpot, Hazard, HazardKind, Landmark, LandmarkKind } from '../memory/store.ts';
import {
  containerLedgerKey,
  goneReasonOf,
  goneSourceProvenance,
  isPlaceFact,
  isResourceFact,
  type ContainerAnchorFact,
  type FactGoneEvidence,
  type FactLocation,
  type HostFactsPort,
  type PlaceFact,
  type ResourceAnchorFact,
} from './facts-adapter.ts';

/**
 * The library domains the semantic layer actually consumes. World identity is
 * passed explicitly by the owning session scope; legacy Fragment/Topology
 * stores are not part of this interface.
 */
export interface SpatialLibraryStores {
  /** Semantic facts (places, exact resources, container anchors). */
  readonly facts: HostFactsPort;
  /** Preserved placement/visit/portal-crossing ledger. */
  readonly ledger: LedgerStore;
}

/** Old WorldMemory policy constants, now applied over fact views. */
export const LANDMARK_CAP = 200;
export const DISCOVERY_LABEL_CAP = 8;
export const EXCAVATION_WAYPOINT_CAP = 8;
export const BASE_CAP = 64;
export const HERD_CAP = 40;
export const HAZARD_CAP = 40;
export const GONE_CAP = 120;

type Vec = { x: number; y: number; z: number };

const clone = <T>(value: T): T => structuredClone(value);
const jsonRecord = (value: object): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const point = (p: Vec3Like): Vec => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
const keyOf = (p: Vec3Like) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
const sourcePoint = (fact: PlaceFact): Vec3Like =>
  fact.location.kind === 'exact' ? fact.location.pos : fact.location.center;

/** 语义事实全量重扫间隔：只用来发现其他写入方新增的事实。 */
const SEMANTIC_RESCAN_MS = 30_000;
/** 重复看见已记地标时，至少隔这么久才刷新一次它的观察时间。 */
const LANDMARK_REFRESH_MS = 60_000;

/** 内部淘汰（容量、过期、被“我的 X”替换）不是世界消失，不进入 goneNear。 */
const CONTROL_GONE_REASONS = new Set(['capacity', 'faded', 'replaced', 'forgotten']);
const HAZARD_KINDS: ReadonlySet<string> = new Set<HazardKind>(['drowning', 'lava', 'fall', 'mob', 'explosion', 'starvation', 'suffocation', 'unknown']);

function areaOf(cells: Vec3Like[]): FactLocation {
  if (!cells.length) return { kind: 'exact', pos: { x: 0, y: 64, z: 0 } };
  if (cells.length === 1) return { kind: 'exact', pos: point(cells[0]!) };
  const center = {
    x: Math.round(cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length),
    y: Math.round(cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length),
    z: Math.round(cells.reduce((sum, cell) => sum + cell.z, 0) / cells.length),
  };
  return { kind: 'area', center, radius: Math.max(1, ...cells.map((cell) => dist3(cell, center))) };
}

function effectiveHazard(z: Hazard, now = Date.now()): Hazard | null {
  const fadeStart = 40 * 60_000 * Math.min(3, Math.max(1, z.count));
  const over = now - z.ts - fadeStart;
  if (over <= 0) return z;
  const radius = z.radius - 2 * Math.ceil(over / (20 * 60_000));
  return radius < 3 ? null : { ...z, radius };
}

/** Host-owned business fields persisted with each fact, without container contents. */
interface HostPlaceRecord {
  /** Exact host landmark kind (facts only have coarse place kinds). */
  kind?: LandmarkKind;
  /** Persisted host policy; selecting a base does not re-date its observation. */
  primary?: boolean;
  /** herd */
  count?: number;
  detail?: string;
  /** hazard */
  hazard?: { kind: HazardKind; count: number; firstTs: number; during?: string; note?: string };
  /** farm */
  farm?: { cells: Vec3Like[]; harvests: number; plantedAt: number };
}
interface HostContainerRecord {
  subtype?: 'chest' | 'furnace';
  block?: string;
  /** View label for a container that disappeared from the legacy landmark view. */
  label?: string;
}

/** Place role derived from the coarse fact kind plus host id/annotation hints. */
type PlaceRole = LandmarkKind | 'farm' | 'portal' | 'hazard' | 'station' | 'gone' | 'place';

/**
 * Native host view over the semantic facts, route history and ledger.
 *
 * The library fact layer owns place/resource/container identity, scope, time
 * and gone state. The host precise container ledger owns contents. Legacy
 * route and passage surfaces are retired and are not part of the facts domain.
 */
export class SpatialSemanticStore {
  readonly worldId: string;
  private readonly sessionId: string;

  constructor(
    private readonly session: SpatialLibraryStores,
    private readonly containerLedgerStore: ContainerLedger,
    options: { sessionId?: string; worldId: string },
  ) {
    if (typeof options.worldId !== 'string' || options.worldId.length === 0) {
      throw new Error('spatial semantic worldId must come from the explicit session scope');
    }
    this.worldId = options.worldId;
    this.sessionId = options.sessionId ?? 'semantic-store';
  }

  get stores(): SpatialLibraryStores { return this.session; }
  get facts(): HostFactsPort { return this.session.facts; }
  get containers(): ContainerLedger { return this.containerLedgerStore; }
  get world(): string { return this.worldId; }

  // ---------------------------------------------------------------- fact cache

  private cache: {
    at: number;
    places: PlaceFact[];
    resources: ResourceAnchorFact[];
    containers: ContainerAnchorFact[];
    placesById: Map<string, PlaceFact>;
    containersById: Map<string, ContainerAnchorFact>;
  } | null = null;

  private invalidate(): void {
    this.cache = null;
  }

  private page<T>(query: (after: string | undefined) => { items: T[]; nextAfter?: string }): T[] {
    const out: T[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = query(after);
      out.push(...page.items);
      if (page.nextAfter === undefined) break;
      after = page.nextAfter;
    }
    return out;
  }

  private snapshot(): NonNullable<SpatialSemanticStore['cache']> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at <= SEMANTIC_RESCAN_MS) return this.cache;
    const places = this.page((after) => this.session.facts.places({ worldId: this.worldId, includeGone: true, after, limit: 100 }));
    const resources = this.page((after) => this.session.facts.resources({ worldId: this.worldId, includeGone: true, after, limit: 100 }));
    const containers = this.page((after) => this.session.facts.containers({ worldId: this.worldId, includeGone: true, after, limit: 100 }));
    this.cache = { at: now, places, resources, containers,
      placesById: new Map(places.map((fact) => [fact.id, fact])),
      containersById: new Map(containers.map((fact) => [fact.id, fact])),
    };
    return this.cache;
  }

  // ------------------------------------------------------------- business state

  private placeRecord(id: string): HostPlaceRecord | undefined {
    return this.snapshot().placesById.get(id)?.hostData as HostPlaceRecord | undefined;
  }

  private containerRecord(id: string): HostContainerRecord | undefined {
    return this.snapshot().containersById.get(id)?.hostData as HostContainerRecord | undefined;
  }

  private notePlaceRecord(id: string, patch: Partial<HostPlaceRecord>): void {
    const fact = this.snapshot().places.find((candidate) => candidate.id === id);
    if (fact === undefined) return;
    this.session.facts.updateHostData('place', id, jsonRecord({ ...fact.hostData, ...patch }) as JsonObject);
    this.invalidate();
  }

  private noteContainerRecord(id: string, patch: Partial<HostContainerRecord>): void {
    const fact = this.snapshot().containers.find((candidate) => candidate.id === id);
    if (fact === undefined) return;
    this.session.facts.updateHostData('container', id, jsonRecord({ ...fact.hostData, ...patch }) as JsonObject);
    this.invalidate();
  }

  // --------------------------------------------------------------- write paths

  private upsertPlace(fact: PlaceFact): PlaceFact {
    const hostData = fact.hostData ?? this.snapshot().places.find((existing) => existing.id === fact.id)?.hostData;
    const result = this.session.facts.upsertPlace(hostData === undefined ? fact : { ...fact, hostData });
    this.invalidate();
    return result.record;
  }

  private upsertResource(fact: ResourceAnchorFact): ResourceAnchorFact {
    const hostData = fact.hostData ?? this.snapshot().resources.find((existing) => existing.id === fact.id)?.hostData;
    const result = this.session.facts.upsertResource(hostData === undefined ? fact : { ...fact, hostData });
    this.invalidate();
    this.applyResourceFact(result.record);
    return result.record;
  }

  private upsertContainer(fact: ContainerAnchorFact): ContainerAnchorFact {
    const hostData = fact.hostData ?? this.snapshot().containers.find((existing) => existing.id === fact.id)?.hostData;
    const result = this.session.facts.upsertContainer(hostData === undefined ? fact : { ...fact, hostData });
    this.invalidate();
    return result.record;
  }

  /**
   * Observation times order updates. Two real observations can land in the
   * same millisecond; a changed record then needs a strictly newer time or the
   * fact store correctly reports a same-time conflict instead of overwriting.
   */
  private observedNow(previous?: number): number {
    const now = Date.now();
    return previous === undefined ? now : Math.max(now, previous + 1);
  }

  private placeGoneEvidence(reason: string | undefined, fact?: { observedAt: number }): FactGoneEvidence {
    return {
      observedAt: Math.max(Date.now(), fact?.observedAt ?? 0),
      source: goneSourceProvenance(reason, { source: 'program', sessionId: this.sessionId }),
    };
  }

  private markPlaceFactGone(fact: PlaceFact, reason?: string): void {
    const evidence = this.placeGoneEvidence(reason, fact);
    this.session.facts.markPlaceGone(fact.id, evidence);
    this.invalidate();
  }

  private revokeResourceFact(fact: ResourceAnchorFact, reason?: string): void {
    const evidence = this.placeGoneEvidence(reason, fact);
    this.session.facts.revokeResource(fact.id, evidence);
    this.invalidate();
    this.applyResourceFact({ ...fact, revoked: true, revokedAt: evidence.observedAt, revokedSource: evidence.source });
  }

  private markContainerFactGone(fact: ContainerAnchorFact, reason?: string): void {
    const evidence = this.placeGoneEvidence(reason, fact);
    this.session.facts.markContainerGone(fact.id, evidence);
    this.invalidate();
  }

  // --------------------------------------------------------------- role views

  private placeRoleOf(fact: PlaceFact): PlaceRole {
    const annotated = this.placeRecord(fact.id)?.kind;
    if (annotated !== undefined) return annotated;
    if (fact.kind === 'base') return 'base';
    if (fact.kind === 'death') return 'death';
    if (fact.kind === 'hazard') return 'hazard';
    if (fact.kind === 'portal') return 'portal';
    if (fact.kind === 'station') return fact.label.startsWith('farm: ') ? 'farm' : 'station';
    if (fact.id.startsWith('her_')) return 'herd';
    if (fact.id.startsWith('way_')) return 'waypoint';
    if (fact.id.startsWith('dan_')) return 'danger';
    if (fact.id.startsWith('bas_')) return 'base';
    if (fact.id.startsWith('dea_')) return 'death';
    if (fact.id.startsWith('gone:')) return 'gone';
    return 'discovery';
  }

  private landmarkKindOf(fact: PlaceFact): LandmarkKind | undefined {
    const role = this.placeRoleOf(fact);
    // Legacy station-view nodes were landmarks; farms are excluded by role.
    if (role === 'station') return 'discovery';
    return role === 'base' || role === 'death' || role === 'danger' || role === 'discovery'
      || role === 'waypoint' || role === 'herd'
      ? role
      : undefined;
  }

  private landmarkView(fact: PlaceFact): Landmark | undefined {
    if (fact.gone) return undefined;
    const kind = this.landmarkKindOf(fact);
    if (kind === undefined) return undefined;
    const record = this.placeRecord(fact.id);
    const pos = sourcePoint(fact);
    const container = isContainerLandmark(fact.label);
    const entry = container ? this.containerLedgerStore.chestAt(fact.dim, pos) : undefined;
    return {
      id: fact.id,
      kind,
      label: fact.label,
      dim: fact.dim,
      pos: { ...pos },
      ts: fact.observedAt,
      ...(kind === 'base' && record?.primary === true ? { primary: true } : {}),
      ...(kind === 'herd' && record?.count !== undefined ? { count: record.count } : {}),
      ...(kind === 'herd' && record?.detail !== undefined ? { detail: record.detail } : {}),
      worldId: fact.worldId,
      ...(container ? {
        radius: 0,
        precise: true,
        observedAt: entry?.contents?.observedAt || entry?.ts || fact.observedAt,
      } : {}),
    };
  }

  private resourceView(fact: ResourceAnchorFact): Landmark | undefined {
    if (fact.revoked) return undefined;
    return {
      id: fact.id,
      kind: 'resource',
      label: fact.label,
      dim: fact.dim,
      pos: { ...fact.sourceCell },
      ts: fact.observedAt,
      worldId: fact.worldId,
    };
  }

  private livePlaces(): PlaceFact[] {
    return this.snapshot().places.filter((fact) => !fact.gone);
  }
  private liveResources(): ResourceAnchorFact[] {
    return this.snapshot().resources.filter((fact) => !fact.revoked);
  }
  private allResources(): ResourceAnchorFact[] {
    return this.snapshot().resources;
  }
  private liveContainers(): ContainerAnchorFact[] {
    return this.snapshot().containers.filter((fact) => !fact.gone);
  }

  // ---------------------------------------------------------------- resource index

  /**
   * Resource anchors projected by 16³ Section bucket for bounded near queries.
   * The authority is the fact port; own writes update one id at a time and only
   * an external rescan (or a cold start) rebuilds every bucket.
   */
  private resourceIndex: {
    at: number;
    buckets: Map<string, string[]>;
    facts: Map<string, ResourceAnchorFact>;
  } | null = null;
  private resourceIndexRebuilds = 0;

  private resourceBucketKey(dim: string, cell: Vec3Like): string {
    return `${dim}|${Math.floor(cell.x / 16)}|${Math.floor(cell.y / 16)}|${Math.floor(cell.z / 16)}`;
  }

  private addResourceBucket(buckets: Map<string, string[]>, fact: ResourceAnchorFact): void {
    const key = this.resourceBucketKey(fact.dim, fact.sourceCell);
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [fact.id]);
    else list.push(fact.id);
  }

  private rebuildResourceIndex(): void {
    const buckets = new Map<string, string[]>();
    const facts = new Map<string, ResourceAnchorFact>();
    for (const fact of this.allResources()) {
      if (fact.revoked) continue;
      this.addResourceBucket(buckets, fact);
      facts.set(fact.id, fact);
    }
    this.resourceIndex = { at: Date.now(), buckets, facts };
    this.resourceIndexRebuilds += 1;
  }

  private getResourceIndex(): NonNullable<SpatialSemanticStore['resourceIndex']> {
    if (this.resourceIndex === null || Date.now() - this.resourceIndex.at > SEMANTIC_RESCAN_MS) this.rebuildResourceIndex();
    return this.resourceIndex!;
  }

  private applyResourceFact(fact: ResourceAnchorFact): void {
    const index = this.resourceIndex;
    if (index === null) return;
    const previous = index.facts.get(fact.id);
    if (previous !== undefined) {
      const key = this.resourceBucketKey(previous.dim, previous.sourceCell);
      const list = index.buckets.get(key);
      if (list !== undefined) {
        const at = list.indexOf(fact.id);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) index.buckets.delete(key);
      }
      index.facts.delete(fact.id);
    }
    if (!fact.revoked) {
      this.addResourceBucket(index.buckets, fact);
      index.facts.set(fact.id, fact);
    }
  }

  resourceIndexStatus(): {
    complete: false;
    reason: string;
    resourceAnchors: number;
    rebuilds: number;
  } {
    return {
      complete: false,
      reason: 'derived from recorded resource anchors; this is not a complete world resource scan',
      resourceAnchors: this.getResourceIndex().facts.size,
      rebuilds: this.resourceIndexRebuilds,
    };
  }

  // ---------------------------------------------------------------- landmarks

  /** All legacy landmark views, including stations but excluding typed records. */
  landmarks(): Landmark[] {
    const snapshot = this.snapshot();
    return [
      ...snapshot.places.flatMap((fact) => {
        const view = this.landmarkView(fact);
        return view ? [view] : [];
      }),
      ...snapshot.resources.flatMap((fact) => {
        const view = this.resourceView(fact);
        return view ? [view] : [];
      }),
    ];
  }

  private findNearLivePlace(kind: LandmarkKind, label: string, dim: string, at: Vec3Like, radius: number): PlaceFact | undefined {
    return this.livePlaces().find((fact) => this.landmarkKindOf(fact) === kind && fact.label === label
      && fact.dim === dim && dist3(sourcePoint(fact), at) < radius);
  }

  private findNearLiveResource(label: string, dim: string, at: Vec3Like, radius: number): ResourceAnchorFact | undefined {
    return this.liveResources().find((fact) => fact.label === label
      && fact.dim === dim && dist3(fact.sourceCell, at) < radius);
  }

  private touchFact(fact: PlaceFact | ResourceAnchorFact): void {
    const observedAt = this.observedNow(fact.observedAt);
    if (isPlaceFact(fact)) this.upsertPlace({ ...fact, observedAt });
    else this.upsertResource({ ...fact, observedAt });
  }

  addLandmark(kind: LandmarkKind, label: string, dim: string, pos: Vec3Like, dedupeRadius = 24): Landmark | null {
    const radius = kind === 'discovery' && isContainerLandmark(label) ? 0.1 : dedupeRadius;
    const at = point(pos);
    const nearPlace = kind === 'resource' ? undefined : this.findNearLivePlace(kind, label, dim, at, radius);
    const nearResource = kind === 'resource' ? this.findNearLiveResource(label, dim, at, radius) : undefined;
    const near = nearPlace ?? nearResource;
    if (near) {
      // 每帧都会重复看见同一处资源/危险：最近刚确认过就不再写。
      if (Date.now() - near.observedAt < LANDMARK_REFRESH_MS) return null;
      this.touchFact(near);
      return null;
    }

    if (kind === 'discovery') {
      if (!label.startsWith('我的')) {
        const own = this.findNearLivePlace('discovery', `我的${label}`, dim, at, radius);
        if (own) {
          if (Date.now() - own.observedAt >= LANDMARK_REFRESH_MS) this.touchFact(own);
          return null;
        }
      } else {
        const plain = label.slice(2);
        const nearPlain = isContainerLandmark(plain) ? 0.1 : 2;
        for (const fact of this.livePlaces()) {
          const isView = this.landmarkKindOf(fact) === 'discovery' || isContainerLandmark(fact.label);
          if (!isView || fact.label !== plain || fact.dim !== dim) continue;
          if (dist3(sourcePoint(fact), at) > nearPlain) continue;
          this.markPlaceFactGone(fact, 'replaced');
        }
        for (const fact of this.liveResources()) {
          if (fact.label !== plain || fact.dim !== dim || dist3(fact.sourceCell, at) > 2) continue;
          this.revokeResourceFact(fact, 'replaced');
        }
      }
    }

    const id = shortId(`${kind.slice(0, 3)}_`);
    const source = kind === 'base' || kind === 'discovery' || kind === 'waypoint' || kind === 'death' ? 'agent' as const : 'program' as const;
    if (kind === 'resource') {
      const fact: ResourceAnchorFact = {
        id,
        worldId: this.worldId,
        dim,
        label,
        sourceCell: at,
        observedAt: Date.now(),
        source: { source, sessionId: this.sessionId },
        revoked: false,
      };
      this.upsertResource(fact);
      this.enforceLandmarkCaps();
      return this.resourceView(fact) ?? null;
    }

    const fact: PlaceFact = {
      id,
      kind: kind === 'base' ? 'base' : kind === 'death' ? 'death' : 'place',
      label,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: at },
      observedAt: Date.now(),
      source: { source, sessionId: this.sessionId },
      gone: false,
    };
    this.upsertPlace(fact);
    this.notePlaceRecord(id, { kind });
    this.enforceLandmarkCaps();
    return this.landmarkView(fact) ?? null;
  }

  private retireLandmark(id: string, reason: 'capacity' | 'replaced'): void {
    const snapshot = this.snapshot();
    const place = snapshot.places.find((fact) => fact.id === id && !fact.gone);
    if (place !== undefined) { this.markPlaceFactGone(place, reason); return; }
    const resource = snapshot.resources.find((fact) => fact.id === id && !fact.revoked);
    if (resource !== undefined) this.revokeResourceFact(resource, reason);
  }

  private enforceLandmarkCaps() {
    const views = this.landmarks();
    const byTs = (a: Landmark, b: Landmark) => a.ts - b.ts;
    const forgetOldest = (list: Landmark[]) => {
      const oldest = [...list].sort(byTs)[0];
      if (oldest) this.retireLandmark(oldest.id, 'capacity');
    };
    for (const [label, group] of Object.entries(views.filter((view) => view.kind === 'discovery').reduce<Record<string, Landmark[]>>((groups, view) => {
      (groups[view.label] ??= []).push(view);
      return groups;
    }, {}))) {
      if (label && group.length > DISCOVERY_LABEL_CAP) forgetOldest(group.slice().sort(byTs).slice(0, group.length - DISCOVERY_LABEL_CAP));
    }
    const herds = views.filter((view) => view.kind === 'herd');
    if (herds.length > HERD_CAP) forgetOldest(herds.slice().sort(byTs).slice(0, herds.length - HERD_CAP));
    if (views.length <= LANDMARK_CAP) return;
    const tiers: ((view: Landmark) => boolean)[] = [
      (view) => ['herd', 'danger', 'death'].includes(view.kind),
      (view) => view.kind === 'resource',
      (view) => view.kind === 'waypoint',
      (view) => view.kind === 'discovery' && !view.label.startsWith('我的') && !isContainerLandmark(view.label),
    ];
    for (const tier of tiers) {
      const candidate = views.filter(tier).sort(byTs)[0];
      if (candidate) { this.retireLandmark(candidate.id, 'capacity'); return; }
    }
  }

  markGone(label: string, dim: string, pos: Vec3Like, now: string) {
    const at = point(pos);
    const livePlace = this.livePlaces().find((fact) => fact.label === label
      && fact.dim === dim && dist3(sourcePoint(fact), at) <= 1);
    if (livePlace) {
      this.markPlaceFactGone(livePlace, now);
      // A landmark view can sit on a container anchor; the shell disappeared too.
      const container = this.liveContainers().find((fact) => fact.dim === dim && dist3(fact.pos, at) <= 0.1);
      if (container) this.markContainerFactGone(container, now);
      return;
    }
    const liveContainer = this.liveContainers().find((fact) => this.containerRecord(fact.id)?.label === label
      && fact.dim === dim && dist3(fact.pos, at) <= 1);
    if (liveContainer) { this.markContainerFactGone(liveContainer, now); return; }
    const liveResource = this.liveResources().find((fact) => fact.label === label
      && fact.dim === dim && dist3(fact.sourceCell, at) <= 1);
    if (liveResource) { this.revokeResourceFact(liveResource, now); return; }

    const id = `gone:${this.worldId}:${dim}:${keyOf(at)}:${label}`;
    const existing = this.snapshot().places.find((fact) => fact.id === id);
    const fact: PlaceFact = {
      id,
      kind: 'place',
      label: `gone: ${label}`,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: at },
      observedAt: this.observedNow(existing?.observedAt),
      source: { source: 'program', sessionId: this.sessionId },
      gone: true,
      goneAt: this.observedNow(existing?.goneAt),
      goneSource: goneSourceProvenance(now, { source: 'program', sessionId: this.sessionId }),
    };
    this.upsertPlace(fact);
    // Facts are retained state by contract; GONE_CAP cannot physically delete
    // history. The cap is intentionally not enforced here (reported as a
    // first-batch limitation).
  }

  goneNear(dim: string, pos: Vec3Like, radius = 3): GoneSpot[] {
    const at = point(pos);
    const livePlaces = this.livePlaces().filter((fact) => fact.dim === dim && this.landmarkKindOf(fact) !== undefined);
    const liveResources = this.liveResources().filter((fact) => fact.dim === dim);
    const live = [
      ...livePlaces.map((fact) => ({ label: fact.label, pos: sourcePoint(fact) })),
      ...liveResources.map((fact) => ({ label: fact.label, pos: fact.sourceCell })),
    ];
    const out: GoneSpot[] = [];
    const push = (label: string, gonePos: Vec3Like, reason: string | undefined, ts: number) => {
      if (reason !== undefined && CONTROL_GONE_REASONS.has(reason)) return;
      if (live.some((other) => other.label === label && dist3(other.pos, gonePos) <= 1)) return;
      out.push({ worldId: this.worldId, dim, label, pos: point(gonePos), now: reason ?? 'gone', ts });
    };
    for (const fact of this.snapshot().places) {
      if (!fact.gone || fact.dim !== dim) continue;
      const gonePos = sourcePoint(fact);
      if (dist3(gonePos, at) > radius) continue;
      push(fact.label.startsWith('gone: ') ? fact.label.slice('gone: '.length) : fact.label,
        gonePos, goneReasonOf(fact.goneSource), fact.goneAt ?? fact.observedAt);
    }
    for (const fact of this.snapshot().resources) {
      if (!fact.revoked || fact.dim !== dim || dist3(fact.sourceCell, at) > radius) continue;
      push(fact.label, fact.sourceCell, goneReasonOf(fact.revokedSource), fact.revokedAt ?? fact.observedAt);
    }
    for (const fact of this.snapshot().containers) {
      if (!fact.gone || fact.dim !== dim || dist3(fact.pos, at) > radius) continue;
      const record = this.containerRecord(fact.id);
      push(record?.label ?? (this.containerRole(fact) === 'furnace' ? 'furnace' : 'chest'),
        fact.pos, goneReasonOf(fact.goneSource), fact.goneAt ?? fact.observedAt);
    }
    return out;
  }

  removeLandmark(id: string): boolean {
    const snapshot = this.snapshot();
    const place = snapshot.places.find((fact) => fact.id === id);
    if (place !== undefined) {
      if (this.placeRoleOf(place) === 'base' || place.gone) return false;
      this.markPlaceFactGone(place, 'replaced');
      return true;
    }
    const resource = snapshot.resources.find((fact) => fact.id === id);
    if (resource !== undefined) {
      if (resource.revoked) return false;
      this.revokeResourceFact(resource, 'replaced');
      return true;
    }
    return false;
  }

  forgetLandmark(id: string): Landmark | null {
    const snapshot = this.snapshot();
    const place = snapshot.places.find((fact) => fact.id === id);
    const resource = place === undefined ? snapshot.resources.find((fact) => fact.id === id) : undefined;
    const fact = place ?? resource;
    if (fact === undefined) return null;
    const view = place !== undefined ? this.landmarkView(place) : this.resourceView(resource!);
    const pos = place !== undefined ? sourcePoint(place) : resource!.sourceCell;
    if (place !== undefined && this.placeRoleOf(place) === 'base' && this.placeRecord(place.id)?.primary === true) {
      const next = this.bases(place.dim).filter((base) => base.id !== id).sort((a, b) => b.ts - a.ts)[0];
      if (next) this.selectBase(next.id);
    }
    const container = this.liveContainers().find((anchor) => anchor.dim === fact.dim && dist3(anchor.pos, pos) <= 0.1);
    if (container !== undefined) {
      if (this.containerRole(container) === 'furnace') this.containerLedgerStore.forgetFurnace(fact.dim, pos);
      else this.containerLedgerStore.forgetChest(fact.dim, pos);
      this.markContainerFactGone(container, 'replaced');
    }
    if (place !== undefined) this.markPlaceFactGone(place, 'forgotten');
    else this.revokeResourceFact(resource!, 'forgotten');
    return view ?? null;
  }

  noteHerd(label: string, dim: string, pos: Vec3Like, count: number, detail?: string): Landmark {
    const at = point(pos);
    const near = this.livePlaces().find((fact) => this.placeRoleOf(fact) === 'herd' && fact.dim === dim && fact.label === label
      && dist3(sourcePoint(fact), at) < 32);
    if (near) {
      const record: HostPlaceRecord = {
        kind: 'herd',
        count,
        ...(detail ? { detail } : {}),
      };
      const updated: PlaceFact = { ...near, location: { kind: 'exact', pos: at }, observedAt: this.observedNow(near.observedAt) };
      this.upsertPlace(updated);
      this.notePlaceRecord(near.id, record);
      return this.landmarkView(updated)!;
    }
    const herds = this.landmarks().filter((view) => view.kind === 'herd').sort((a, b) => a.ts - b.ts);
    if (herds.length >= HERD_CAP) this.retireLandmark(herds[0]!.id, 'capacity');
    const id = shortId('her_');
    const fact: PlaceFact = {
      id,
      kind: 'place',
      label,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: at },
      observedAt: Date.now(),
      source: { source: 'program', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertPlace(fact);
    this.notePlaceRecord(id, { kind: 'herd', count, ...(detail ? { detail } : {}) });
    return this.landmarkView(fact)!;
  }

  resourceLandmarksNear(names: string[], dim: string, pos: Vec3Like, radius: number): Landmark[] {
    return this.resourceLandmarksAround(dim, pos, radius, new Set(names));
  }

  /** All resource anchors within `radius`, using the Section coordinate index. */
  resourceLandmarksAround(dim: string, pos: Vec3Like, radius: number, names?: ReadonlySet<string>): Landmark[] {
    if (!Number.isFinite(radius) || radius < 0) throw new Error('resource radius must be a finite non-negative number');
    const index = this.getResourceIndex();
    const x0 = Math.floor((pos.x - radius) / 16), x1 = Math.floor((pos.x + radius) / 16);
    const y0 = Math.floor((pos.y - radius) / 16), y1 = Math.floor((pos.y + radius) / 16);
    const z0 = Math.floor((pos.z - radius) / 16), z1 = Math.floor((pos.z + radius) / 16);
    const found: { fact: ResourceAnchorFact; distance: number }[] = [];
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
      for (const id of index.buckets.get(`${dim}|${cx}|${cy}|${cz}`) ?? []) {
        const fact = index.facts.get(id);
        if (fact === undefined || fact.revoked) continue;
        if (names !== undefined && !names.has(fact.label)) continue;
        const distance = dist3(fact.sourceCell, pos);
        if (distance <= radius) found.push({ fact, distance });
      }
    }
    found.sort((a, b) => a.distance - b.distance || a.fact.id.localeCompare(b.fact.id));
    return found.flatMap(({ fact }) => {
      const view = this.resourceView(fact);
      return view === undefined ? [] : [view];
    });
  }

  // -------------------------------------------------------------------- bases

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
      this.retireLandmark(disposable.id, 'capacity');
    }
    if (near) {
      const fact = this.snapshot().places.find((candidate) => candidate.id === near.id && !candidate.gone);
      if (fact === undefined) throw new Error('基地事实已不可用');
      const finalLabel = label?.trim() ?? near.label;
      const updated: PlaceFact = { ...fact, label: finalLabel, location: { kind: 'exact', pos: basePos }, observedAt: this.observedNow(fact.observedAt) };
      this.upsertPlace(updated);
      this.notePlaceRecord(near.id, { kind: 'base' });
      const select = opts.select ?? !hadPrimary;
      return select ? this.selectBase(near.id) : this.landmarkView(updated)!;
    }
    const id = shortId('base_');
    const finalLabel = label?.trim() ?? `基地 ${bases.length + 1}`;
    const fact: PlaceFact = {
      id,
      kind: 'base',
      label: finalLabel,
      worldId: this.worldId,
      dim,
      location: { kind: 'exact', pos: basePos },
      // Keep base observation order monotonic so the post-restart primary
      // fallback (most recently observed base) is deterministic.
      observedAt: this.observedNow(Math.max(0, ...bases.map((base) => base.ts))),
      source: { source: 'agent', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertPlace(fact);
    this.notePlaceRecord(id, { kind: 'base' });
    const select = opts.select ?? !hadPrimary;
    return select ? this.selectBase(id) : this.landmarkView(fact)!;
  }

  private baseFacts(dim?: string): PlaceFact[] {
    return this.livePlaces().filter((fact) => this.placeRoleOf(fact) === 'base' && (!dim || fact.dim === dim));
  }

  base(dim?: string): Landmark | undefined {
    const bases = this.bases(dim);
    // Selection is persisted independently of evidence time. Old records without
    // a selection retain the most recently observed base as their fallback.
    return bases.find((base) => base.primary) ?? [...bases].sort((a, b) => b.ts - a.ts)[0];
  }

  bases(dim?: string): Landmark[] {
    return this.baseFacts(dim).flatMap((fact) => {
      const view = this.landmarkView(fact);
      return view ? [view] : [];
    });
  }

  selectBase(id: string): Landmark {
    const selected = this.snapshot().places.find((fact) => fact.id === id && !fact.gone);
    if (selected === undefined || this.placeRoleOf(selected) !== 'base') throw new Error('只能选择当前世界中实际记得的基地');
    for (const fact of this.baseFacts(selected.dim)) {
      this.notePlaceRecord(fact.id, { primary: fact.id === id });
    }
    const view = this.landmarkView(selected);
    if (view === undefined) throw new Error('基地事实已不可用');
    return view;
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

  // --------------------------------------------------------------- containers

  private containerRole(fact: ContainerAnchorFact): 'chest' | 'furnace' {
    const record = this.containerRecord(fact.id);
    if (record?.subtype !== undefined) return record.subtype;
    const block = record?.block;
    if (block === 'furnace' || block === 'blast_furnace' || block === 'smoker' || block?.endsWith('_furnace')) return 'furnace';
    return record?.label?.startsWith('furnace') === true || fact.id.startsWith('furnace:') ? 'furnace' : 'chest';
  }

  private containerFacts(dim?: string): ContainerAnchorFact[] {
    return this.liveContainers().filter((fact) => this.containerRole(fact) === 'chest' && (!dim || fact.dim === dim));
  }

  private furnaceFacts(dim?: string): ContainerAnchorFact[] {
    return this.liveContainers().filter((fact) => this.containerRole(fact) === 'furnace' && (!dim || fact.dim === dim));
  }

  private containerFactAt(dim: string, pos: Vec3Like, kinds: ('chest' | 'furnace')[] = ['chest', 'furnace']): ContainerAnchorFact | undefined {
    const at = point(pos);
    return this.liveContainers().find((fact) => fact.dim === dim && kinds.includes(this.containerRole(fact))
      && dist3(fact.pos, at) <= 0.1);
  }

  private ensureContainerFact(dim: string, pos: Vec3Like, block = 'chest', note?: string): ContainerAnchorFact {
    const existing = this.containerFactAt(dim, pos);
    if (existing) {
      this.noteContainerRecord(existing.id, {
        subtype: 'chest', block,
        ...(note ? { label: `chest: ${note}` } : {}),
      });
      return existing;
    }
    const at = point(pos);
    const ledgerKey = containerLedgerKey(this.worldId, dim, at);
    const fact: ContainerAnchorFact = {
      id: `chest:${ledgerKey}`,
      worldId: this.worldId,
      dim,
      pos: at,
      externalRef: ledgerKey,
      ledgerRef: ledgerKey,
      observedAt: Date.now(),
      source: { source: 'program', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertContainer(fact);
    this.noteContainerRecord(fact.id, { subtype: 'chest', block, ...(note ? { label: `chest: ${note}` } : {}) });
    return fact;
  }

  private refreshContainerObservation(fact: ContainerAnchorFact, observedAt: number): void {
    if (!Number.isFinite(observedAt) || observedAt <= fact.observedAt) return;
    const current = this.snapshot().containers.find((candidate) => candidate.id === fact.id) ?? fact;
    this.upsertContainer({ ...current, observedAt });
  }

  noteChestUse(dim: string, pos: Vec3Like, use: ChestUse): ChestRecord {
    const node = this.ensureContainerFact(dim, pos, use.block ?? 'chest', use.note);
    const entry = this.containerLedgerStore.noteChestUse(dim, pos, use, node.id);
    this.refreshContainerObservation(node, entry.contents?.observedAt || entry.ts);
    return entry;
  }

  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[], day?: number) {
    return this.noteChestUse(dim, pos, { put: items, seen: items, day });
  }

  forgetChest(dim: string, pos: Vec3Like) {
    this.containerLedgerStore.forgetChest(dim, pos);
    const node = this.containerFactAt(dim, pos, ['chest']);
    if (node) this.markContainerFactGone(node, 'replaced');
  }

  /** Current-validity flag for known contents; quantities/time/position stay exact. */
  markContainerContentsPossiblyStale(): number {
    return this.containerLedgerStore.markContentsPossiblyStale();
  }

  chests(dim?: string): ChestRecord[] {
    const entries = new Map<string, ChestRecord>(this.containerLedgerStore.chests(dim).map((entry) => [containerLedgerKey(this.worldId, entry.dim, entry.pos), entry] as const));
    for (const fact of this.containerFacts()) {
      if (dim && fact.dim !== dim) continue;
      const key = containerLedgerKey(this.worldId, fact.dim, fact.pos);
      if (!entries.has(key)) {
        entries.set(key, {
          worldId: this.worldId, dim: fact.dim, pos: point(fact.pos),
          block: this.containerRecord(fact.id)?.block ?? 'chest', uses: 0,
          ts: fact.observedAt, contents: { items: [], observedAt: 0, possiblyStale: true }, nodeId: fact.id,
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

  // ------------------------------------------------------------------ furnaces

  setFurnace(rec: Omit<FurnaceRecord, 'worldId' | 'ts'> & { ts?: number }) {
    const at = point(rec.pos);
    const node = this.furnaceFacts().find((candidate) => candidate.dim === rec.dim && dist3(candidate.pos, at) <= 2);
    const entry = this.containerLedgerStore.setFurnace(rec, node?.id);
    if (!entry) {
      this.containerLedgerStore.forgetFurnace(rec.dim, rec.pos);
      if (node) this.markContainerFactGone(node, 'replaced');
      return;
    }
    const observedAt = rec.ts ?? Date.now();
    if (node) {
      this.noteContainerRecord(node.id, { subtype: 'furnace', block: rec.block, label: `furnace${rec.burning ? ' (burning)' : ''}` });
      this.refreshContainerObservation(node, observedAt);
      return;
    }
    const ledgerKey = containerLedgerKey(this.worldId, rec.dim, at);
    const fact: ContainerAnchorFact = {
      id: `furnace:${ledgerKey}`,
      worldId: this.worldId,
      dim: rec.dim,
      pos: at,
      externalRef: ledgerKey,
      ledgerRef: ledgerKey,
      observedAt,
      source: { source: 'program', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertContainer(fact);
    this.noteContainerRecord(fact.id, { subtype: 'furnace', block: rec.block, label: `furnace${rec.burning ? ' (burning)' : ''}` });
  }

  forgetFurnace(dim: string, pos: Vec3Like) {
    this.containerLedgerStore.forgetFurnace(dim, pos);
    const node = this.containerFactAt(dim, pos, ['furnace']);
    if (node) this.markContainerFactGone(node, 'replaced');
  }

  furnaces(dim?: string): FurnaceRecord[] {
    return this.containerLedgerStore.furnaces(dim).map((entry) => ({
      worldId: this.worldId, dim: entry.dim, pos: point(entry.pos), block: entry.block,
      input: entry.input, output: entry.output, fuel: entry.fuel, burning: entry.burning,
      ...(entry.why ? { why: entry.why } : {}), ts: entry.ts,
    }));
  }

  // -------------------------------------------------------------------- farms

  addFarm(f: FarmRecord) {
    const fact: PlaceFact = {
      id: f.id,
      kind: 'station',
      label: `farm: ${f.crop}`,
      worldId: this.worldId,
      dim: f.dim,
      location: areaOf(f.cells),
      observedAt: f.plantedAt,
      source: { source: 'program', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertPlace(fact);
    // Farm details remain host-owned and are saved with the station anchor.
    this.notePlaceRecord(f.id, { farm: { cells: f.cells.map(point), harvests: f.harvests, plantedAt: f.plantedAt } });
  }

  private farmRecordOf(fact: PlaceFact): FarmRecord {
    const annotated = this.placeRecord(fact.id)?.farm;
    const center = sourcePoint(fact);
    return {
      id: fact.id,
      worldId: this.worldId,
      dim: fact.dim,
      crop: fact.label.replace(/^farm:\s*/, '') || 'farm',
      cells: annotated ? annotated.cells.map(point) : [{ ...center }],
      plantedAt: annotated?.plantedAt ?? fact.observedAt,
      harvests: annotated?.harvests ?? 0,
      ...(annotated === undefined && fact.location.kind === 'area' ? { area: { center: { ...fact.location.center }, radius: fact.location.radius } } : {}),
    };
  }

  farms(): FarmRecord[] {
    return this.livePlaces()
      .filter((fact) => this.placeRoleOf(fact) === 'farm')
      .map((fact) => this.farmRecordOf(fact));
  }

  updateFarm(id: string, patch: Partial<FarmRecord>) {
    const fact = this.snapshot().places.find((candidate) => candidate.id === id && !candidate.gone);
    if (fact === undefined) return;
    const current = this.farmRecordOf(fact);
    const next: FarmRecord = { ...current, ...patch, id };
    const updated: PlaceFact = {
      ...fact,
      label: `farm: ${next.crop}`,
      location: areaOf(next.cells),
      observedAt: next.crop !== current.crop || JSON.stringify(next.cells) !== JSON.stringify(current.cells)
        ? this.observedNow(fact.observedAt) : fact.observedAt,
    };
    this.upsertPlace(updated);
    this.notePlaceRecord(id, { farm: { cells: next.cells.map(point), harvests: next.harvests, plantedAt: next.plantedAt } });
  }

  // ------------------------------------------------------------------ hazards

  private hazardRecordOf(fact: PlaceFact): Hazard {
    const annotated = this.placeRecord(fact.id)?.hazard;
    const parsed = /^danger:\s*([^\s(]+)(?:\s*\(([^)]*)\))?$/.exec(fact.label);
    const parsedKind = parsed?.[1];
    const kind: HazardKind = annotated?.kind
      ?? (parsedKind !== undefined && HAZARD_KINDS.has(parsedKind) ? parsedKind as HazardKind : 'unknown');
    const note = annotated?.note ?? parsed?.[2];
    const center = sourcePoint(fact);
    return {
      id: fact.id,
      worldId: this.worldId,
      dim: fact.dim,
      pos: { ...center },
      radius: fact.location.kind === 'area' ? fact.location.radius : 6,
      kind,
      count: annotated?.count ?? 1,
      ...(annotated?.during !== undefined ? { during: annotated.during } : {}),
      ...(note !== undefined && note !== '' ? { note } : {}),
      firstTs: annotated?.firstTs ?? fact.observedAt,
      ts: fact.observedAt,
    };
  }

  addHazard(h: { dim: string; pos: Vec3Like; kind: HazardKind; during?: string; note?: string }): Hazard {
    const pos = point(h.pos);
    const now = Date.now();
    for (const fact of this.livePlaces().filter((candidate) => this.placeRoleOf(candidate) === 'hazard')) {
      const record = this.hazardRecordOf(fact);
      if (effectiveHazard(record, now - 40 * 60_000) === null) this.markPlaceFactGone(fact, 'faded');
    }
    const live = this.livePlaces()
      .filter((fact) => this.placeRoleOf(fact) === 'hazard')
      .map((fact) => ({ fact, record: this.hazardRecordOf(fact) }));
    const old = live.find(({ record }) => record.dim === h.dim && record.kind === h.kind
      && effectiveHazard(record, now) && dist3(record.pos, pos) <= Math.max(6, record.radius));
    if (old) {
      const next: Hazard = {
        ...old.record, count: old.record.count + 1, ts: now,
        radius: Math.min(12, 4 + (old.record.count + 1) * 2),
        ...(h.during ? { during: h.during.slice(0, 120) } : {}),
        ...(h.note ? { note: h.note.slice(0, 200) } : {}),
      };
      const updated: PlaceFact = {
        ...old.fact,
        label: `danger: ${h.kind}${next.note ? ` (${next.note})` : ''}`,
        location: { kind: 'area', center: pos, radius: next.radius },
        observedAt: this.observedNow(old.fact.observedAt),
      };
      this.upsertPlace(updated);
      this.notePlaceRecord(old.fact.id, { hazard: { kind: h.kind, count: next.count, firstTs: next.firstTs, ...(next.during ? { during: next.during } : {}), ...(next.note ? { note: next.note } : {}) } });
      return clone({ ...next, ts: updated.observedAt });
    }
    const id = shortId('hz_');
    const hazard: Hazard = {
      id, worldId: this.worldId, dim: h.dim, pos, radius: 6, kind: h.kind, count: 1,
      ...(h.during ? { during: h.during.slice(0, 120) } : {}), ...(h.note ? { note: h.note.slice(0, 200) } : {}), firstTs: now, ts: now,
    };
    const fact: PlaceFact = {
      id,
      kind: 'hazard',
      label: `danger: ${h.kind}${h.note ? ` (${h.note})` : ''}`,
      worldId: this.worldId,
      dim: h.dim,
      location: { kind: 'area', center: pos, radius: 6 },
      observedAt: now,
      source: { source: 'program', sessionId: this.sessionId },
      gone: false,
    };
    this.upsertPlace(fact);
    this.notePlaceRecord(id, { hazard: { kind: hazard.kind, count: 1, firstTs: now, ...(h.during ? { during: hazard.during! } : {}), ...(h.note ? { note: hazard.note! } : {}) } });
    const hazards = this.livePlaces().filter((candidate) => this.placeRoleOf(candidate) === 'hazard');
    if (hazards.length > HAZARD_CAP) {
      const oldest = hazards.map((candidate) => this.hazardRecordOf(candidate)).sort((a, b) => a.ts - b.ts)[0];
      if (oldest) this.retireLandmark(oldest.id, 'capacity');
    }
    return clone(hazard);
  }

  hazards(dim?: string): Hazard[] {
    const now = Date.now();
    return this.livePlaces()
      .filter((fact) => this.placeRoleOf(fact) === 'hazard')
      .map((fact) => this.hazardRecordOf(fact))
      .filter((record) => !dim || record.dim === dim)
      .flatMap((record) => {
        const effective = effectiveHazard(record, now);
        return effective ? [clone(effective)] : [];
      })
      .sort((a, b) => a.ts - b.ts);
  }

  hazardAt(pos: Vec3Like, dim: string, kinds?: HazardKind[]): Hazard | null {
    let best: Hazard | null = null;
    const now = Date.now();
    for (const record of this.livePlaces().filter((fact) => this.placeRoleOf(fact) === 'hazard').map((fact) => this.hazardRecordOf(fact))) {
      if (record.dim !== dim || (kinds && !kinds.includes(record.kind))) continue;
      const effective = effectiveHazard(record, now);
      if (!effective || dist3(effective.pos, pos) > effective.radius) continue;
      if (!best || effective.count > best.count) best = effective;
    }
    return best ? clone(best) : null;
  }

  // ---------------------------------------------------- ledger-backed records

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

  visitedExtent(dim: string) {
    const visits = this.session.ledger.chunkVisits(dim);
    const bounds = visits.length === 0 ? null : {
      minX: Math.min(...visits.map((v) => v.cx)) * 16, maxX: Math.max(...visits.map((v) => v.cx)) * 16 + 15,
      minZ: Math.min(...visits.map((v) => v.cz)) * 16, maxZ: Math.max(...visits.map((v) => v.cz)) * 16 + 15,
    };
    return { chunks: visits.length, bounds };
  }

  novelty(dim: string, x: number, z: number): number {
    return this.session.ledger.novelty(dim, Math.floor(x / 16), Math.floor(z / 16));
  }

  hasManagedRecords(): boolean {
    const snapshot = this.snapshot();
    return snapshot.places.length > 0 || snapshot.resources.length > 0 || snapshot.containers.length > 0
      || this.session.ledger.placedBlocks().length > 0 || this.session.ledger.chunkVisits().length > 0
      || this.session.ledger.portalTraversals().length > 0;
  }

  counts() {
    const snapshot = this.snapshot();
    const places = snapshot.places;
    const views = this.landmarks();
    return {
      nodes: places.length + snapshot.resources.length + snapshot.containers.length,
      landmarks: views.length,
      containers: this.containerFacts().length,
      furnaces: this.furnaceFacts().length,
      farms: places.filter((fact) => !fact.gone && this.placeRoleOf(fact) === 'farm').length,
      hazards: places.filter((fact) => !fact.gone && this.placeRoleOf(fact) === 'hazard').length,
      gone: places.filter((fact) => fact.gone && !CONTROL_GONE_REASONS.has(goneReasonOf(fact.goneSource) ?? '')).length
        + snapshot.resources.filter((fact) => fact.revoked && !CONTROL_GONE_REASONS.has(goneReasonOf(fact.revokedSource) ?? '')).length
        + snapshot.containers.filter((fact) => fact.gone && !CONTROL_GONE_REASONS.has(goneReasonOf(fact.goneSource) ?? '')).length,
      placed: this.session.ledger.placedBlocks().length,
      visits: this.session.ledger.chunkVisits().length,
      containersLedger: this.containerLedgerStore.chests().length + this.containerLedgerStore.furnaces().length,
    };
  }
}
