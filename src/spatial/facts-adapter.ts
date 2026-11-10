/**
 * Host-side adaptation between Curio's `metadata.curio` semantic nodes and the
 * v0.11 semantic fact layer.
 *
 * The library fact model is deliberately narrow: places, exact-cell resource
 * anchors and container shell anchors, each carrying identity, scope,
 * observation time, provenance and gone/revoked state. It never carries
 * inventories. This module is the host boundary that:
 *
 * - narrows the library `FactStore` to the ten-method `HostFactsPort` the
 *   semantic/travel stores depend on;
 * - classifies real host nodes by `metadata.curio.type` first and only falls
 *   back to `tag`/`kind` for nodes that never had curio metadata;
 * - rehearses/applies the migration of real host semantic nodes (never a
 *   tag-only generic shape) and reports gaps instead of dropping them.
 *
 * `createInMemoryHostFactsPort` is the test/non-persistent implementation and
 * returns the library `InMemoryFactStore` directly.
 */
import { InMemoryFactStore } from 'curio-minecraft-3d-memory';
import type {
  ContainerAnchorFact,
  FactGoneEvidence,
  FactLocation,
  FactPage,
  FactProvenance,
  FactQuery,
  FactStore,
  FactWriteOutcome,
  FactWriteResult,
  PlaceFact,
  PlaceKind,
  ResourceAnchorFact,
  ResourceFactQuery,
  ResourceSourceUpdate,
  SemanticFact,
} from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';

/* ------------------------------------------------------------------ facts */

export type {
  ContainerAnchorFact,
  FactGoneEvidence,
  FactLocation,
  FactPage,
  FactProvenance,
  FactQuery,
  FactStore,
  FactWriteOutcome,
  FactWriteResult,
  PlaceFact,
  PlaceKind,
  ResourceAnchorFact,
  ResourceFactQuery,
  ResourceSourceUpdate,
  SemanticFact,
};

/**
 * The narrow host port from the frozen first-batch interface (§2), projected
 * from the library `FactStore`. The semantic and travel stores depend on this
 * shape only.
 */
export type HostFactsPort = Pick<
  FactStore,
  | 'upsertPlace'
  | 'upsertResource'
  | 'upsertContainer'
  | 'markPlaceGone'
  | 'revokeResource'
  | 'markContainerGone'
  | 'updateResourceSource'
  | 'places'
  | 'resources'
  | 'containers'
>;

export const semanticFactKind = (fact: SemanticFact): 'place' | 'resource' | 'container' =>
  'sourceCell' in fact ? 'resource' : 'externalRef' in fact ? 'container' : 'place';

export const isPlaceFact = (fact: SemanticFact): fact is PlaceFact => semanticFactKind(fact) === 'place';
export const isResourceFact = (fact: SemanticFact): fact is ResourceAnchorFact => semanticFactKind(fact) === 'resource';
export const isContainerFact = (fact: SemanticFact): fact is ContainerAnchorFact => semanticFactKind(fact) === 'container';

export const isFactGone = (fact: SemanticFact): boolean =>
  isPlaceFact(fact) ? fact.gone : isResourceFact(fact) ? fact.revoked : fact.gone;

/* ------------------------------------------------------- host node shapes */

/** Curio's opaque node metadata; only the fields this adapter reads are typed. */
export interface HostCurioMeta {
  v?: number;
  type?: string;
  /** Additional roles for a shared anchor (e.g. station + furnace). */
  types?: readonly string[];
  view?: string;
  record?: unknown;
  primary?: boolean;
  block?: string;
  geometrySource?: string;
}

export type HostSemanticLocation =
  | { kind: 'exact'; pos: Vec3Like }
  | { kind: 'region'; center: Vec3Like; radius: number }
  | { kind: 'area'; center: Vec3Like; radius: number };

/**
 * A real host semantic node record. Extra fields are tolerated; the converter
 * validates the fields it needs and reports a gap instead of inventing values.
 */
export interface HostSemanticNode {
  id?: string;
  kind?: string;
  tag?: string;
  label?: string;
  worldId?: string;
  dim?: string;
  location?: HostSemanticLocation;
  observedAt?: number;
  /** Topology node source (`agent`, `program`, ...). */
  source?: string;
  sessionId?: string;
  observationIds?: readonly string[];
  externalRef?: string;
  ledgerRef?: string;
  resourceType?: string;
  legacyId?: string;
  durable?: boolean;
  gone?: boolean;
  goneAt?: number;
  goneEvidence?: { reason?: string; observedAt?: number };
  /** Library topology metadata (`JsonObject`); `metadata.curio` is validated at this boundary. */
  metadata?: unknown;
  /** Optional legacy flat position used by older host records. */
  pos?: Vec3Like;
}

/* ------------------------------------------------------------- conversion */

export type HostSemanticRole =
  | 'container'
  | 'farm'
  | 'resource'
  | 'base'
  | 'death'
  | 'portal'
  | 'station'
  | 'hazard'
  | 'gone'
  | 'discovery'
  | 'waypoint'
  | 'herd'
  | 'danger'
  | 'place';

export type HostFactGapReason =
  /** Route-only topology node (entrance/branch/turn/vertical_junction). */
  | 'route_geometry'
  /** Compatibility-only record with no semantic fact meaning. */
  | 'not_semantic'
  | 'missing_id'
  | 'missing_world'
  | 'missing_dim'
  | 'missing_label'
  | 'missing_location'
  | 'missing_observation'
  | 'inexact_location'
  | 'unclassifiable';

export interface HostFactGap {
  id?: string;
  role?: string;
  reason: HostFactGapReason;
  /** Human-readable detail; never used as world fact. */
  detail?: string;
}

export type HostFactConversion =
  | {
    kind: 'fact';
    fact: SemanticFact;
    role: HostSemanticRole;
    /** Whether `metadata.curio.type` or the legacy tag/kind decided the role. */
    classifiedBy: 'curio' | 'tag';
    legacyId?: string;
  }
  | { kind: 'gap'; gap: HostFactGap };

export interface HostFactConversionOptions {
  /** Snapshot scope used only when the node itself has no world id. */
  worldId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const point = (value: Vec3Like): Vec3Like => ({ x: value.x, y: value.y, z: value.z });

/** Stable ledger key used by the host `ContainerLedger` (chests and furnaces). */
export const containerLedgerKey = (worldId: string, dim: string, pos: Vec3Like): string =>
  `${worldId}:${dim}:${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;

/** Probe provenance source for an endpoint that was actually seen, not only reached. */
export const PORTAL_OBSERVED_SOURCE = 'portal_observed';
/** Probe provenance source for an endpoint recorded only by arriving at it. */
export const PORTAL_ARRIVAL_SOURCE = 'portal_arrival';

const GONE_REASON_PREFIX = 'curio:gone:';

/** Encode the observed disappearance reason into disappearance evidence. */
export function goneSourceProvenance(reason: string | undefined, base: FactProvenance): FactProvenance {
  return {
    ...base,
    ...(reason ? { source: `${GONE_REASON_PREFIX}${encodeURIComponent(reason)}` } : {}),
  };
}

/** Read back a disappearance reason encoded by `goneSourceProvenance`. */
export function goneReasonOf(source: FactProvenance | undefined): string | undefined {
  if (!source?.source.startsWith(GONE_REASON_PREFIX)) return undefined;
  const raw = source.source.slice(GONE_REASON_PREFIX.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

const curioOf = (node: HostSemanticNode): HostCurioMeta | undefined => {
  if (!isRecord(node.metadata)) return undefined;
  return isRecord(node.metadata.curio) ? node.metadata.curio as HostCurioMeta : undefined;
};

const recordOf = (curio: HostCurioMeta | undefined): Record<string, unknown> | undefined =>
  isRecord(curio?.record) ? curio.record : undefined;

const curioTypes = (curio: HostCurioMeta | undefined): string[] => {
  if (!curio) return [];
  const types = [curio.type, ...(Array.isArray(curio.types) ? curio.types : [])]
    .filter((type): type is string => typeof type === 'string' && type.length > 0);
  return [...new Set(types)];
};

const CURIO_ROLE: Record<string, HostSemanticRole> = {
  container: 'container',
  chest: 'container',
  furnace: 'container',
  farm: 'farm',
  resource: 'resource',
  base: 'base',
  death: 'death',
  portal: 'portal',
  endpoint: 'portal',
  station: 'station',
  hazard: 'hazard',
  gone: 'gone',
  discovery: 'discovery',
  waypoint: 'waypoint',
  herd: 'herd',
  danger: 'danger',
  place: 'place',
};

/** Role priority for multi-role nodes; container/farm roles must win over tags. */
const ROLE_PRIORITY: HostSemanticRole[] = [
  'container', 'farm', 'resource', 'base', 'death', 'portal', 'station', 'hazard', 'gone',
  'discovery', 'waypoint', 'herd', 'danger', 'place',
];

const roleFromRecordKind = (value: unknown): HostSemanticRole | undefined => {
  if (typeof value !== 'string') return undefined;
  if (value === 'base') return 'base';
  if (value === 'death') return 'death';
  if (value === 'danger') return 'danger';
  if (value === 'discovery') return 'discovery';
  if (value === 'waypoint') return 'waypoint';
  if (value === 'herd') return 'herd';
  if (value === 'station') return 'station';
  if (value === 'hazard') return 'hazard';
  if (value === 'resource') return 'resource';
  if (value === 'container') return 'container';
  if (value === 'farm') return 'farm';
  return undefined;
};

const roleFromTag = (node: HostSemanticNode): HostSemanticRole | undefined => {
  if (typeof node.tag === 'string' && node.tag.length > 0) {
    const role = CURIO_ROLE[node.tag] ?? roleFromRecordKind(node.tag);
    if (role) return role;
  }
  if (node.kind === 'place') return 'place';
  return undefined;
};

const ROUTE_KINDS = new Set(['entrance', 'branch', 'turn', 'vertical_junction']);

interface Classification {
  role: HostSemanticRole;
  classifiedBy: 'curio' | 'tag';
}

const classify = (node: HostSemanticNode, curio: HostCurioMeta | undefined): Classification | HostFactGap => {
  const types = curioTypes(curio);
  if (types.length > 0) {
    // Curio metadata is authoritative: never let `tag:"resource"` re-role a farm.
    const found = ROLE_PRIORITY.find((role) => types.some((type) => CURIO_ROLE[type] === role));
    if (found) {
      // `landmark` is generic: the concrete kind comes from its business record/tag.
      if (found === 'place' && types.includes('landmark')) {
        const record = recordOf(curio);
        const role = roleFromRecordKind(record?.kind)
          ?? roleFromTag(node)
          ?? 'place';
        return { role, classifiedBy: 'curio' };
      }
      return { role: found, classifiedBy: 'curio' };
    }
    // `landmark` has no role of its own; its record.kind/tag carries the subtype.
    if (types.includes('landmark')) {
      const role = roleFromRecordKind(recordOf(curio)?.kind) ?? roleFromTag(node) ?? 'place';
      return { role, classifiedBy: 'curio' };
    }
    // A recognized curio type that carries no semantic fact meaning.
    if (types.some((type) => type === 'migration' || type === 'passage')) {
      return { reason: 'not_semantic', id: node.id };
    }
    return { reason: 'unclassifiable', id: node.id };
  }

  // Nodes that never carried curio metadata: use tag/kind, and report the lower
  // confidence in `classifiedBy`.
  const role = roleFromTag(node);
  if (role) return { role, classifiedBy: 'tag' };
  if (node.kind !== undefined && ROUTE_KINDS.has(node.kind)) {
    return { reason: 'route_geometry', id: node.id };
  }
  return { reason: 'unclassifiable', id: node.id };
};

const locationOf = (node: HostSemanticNode, record: Record<string, unknown> | undefined): FactLocation | HostFactGap => {
  if (node.location) {
    const { location } = node;
    if (location.kind === 'exact') return { kind: 'exact', pos: point(location.pos) };
    if (location.kind === 'region' || location.kind === 'area') {
      return { kind: 'area', center: point(location.center), radius: location.radius };
    }
  }
  if (node.pos) return { kind: 'exact', pos: point(node.pos) };
  if (Array.isArray(record?.cells)) {
    const cells = record.cells.filter((cell): cell is Vec3Like =>
      isRecord(cell) && finite(cell.x) && finite(cell.y) && finite(cell.z))
      .map(point);
    if (cells.length === 1) return { kind: 'exact', pos: cells[0]! };
    if (cells.length > 1) {
      const center = {
        x: Math.round(cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length),
        y: Math.round(cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length),
        z: Math.round(cells.reduce((sum, cell) => sum + cell.z, 0) / cells.length),
      };
      const radius = Math.max(1, ...cells.map((cell) => Math.hypot(cell.x - center.x, cell.y - center.y, cell.z - center.z)));
      return { kind: 'area', center, radius };
    }
  }
  return { reason: 'missing_location', id: node.id };
};

const exactCellOf = (node: HostSemanticNode, record: Record<string, unknown> | undefined): Vec3Like | HostFactGap => {
  const location = locationOf(node, record);
  if ('reason' in location) return location;
  return location.kind === 'exact' ? location.pos : { reason: 'inexact_location', id: node.id };
};

const observedGoneReason = (node: HostSemanticNode, record: Record<string, unknown> | undefined): string | undefined =>
  nonEmpty(record?.now) ?? nonEmpty(node.goneEvidence?.reason);

const provenanceOf = (node: HostSemanticNode, fallback = 'legacy_node'): FactProvenance => ({
  source: nonEmpty(node.source) ?? fallback,
  ...(nonEmpty(node.sessionId) === undefined ? {} : { sessionId: node.sessionId }),
  ...(node.observationIds === undefined ? {} : { observationIds: [...node.observationIds] }),
});

const missingIdentity = (node: HostSemanticNode, worldId: string | undefined): HostFactGap | undefined => {
  if (nonEmpty(node.id) === undefined) return { reason: 'missing_id' };
  if ((nonEmpty(node.worldId) ?? worldId) === undefined) return { reason: 'missing_world', id: node.id };
  if (nonEmpty(node.dim) === undefined) return { reason: 'missing_dim', id: node.id };
  if (!finite(node.observedAt)) return { reason: 'missing_observation', id: node.id };
  return undefined;
};

const placeKindOf = (role: HostSemanticRole): PlaceKind => {
  switch (role) {
    case 'base': return 'base';
    case 'death': return 'death';
    case 'portal': return 'portal';
    case 'farm': return 'station';
    case 'station': return 'station';
    case 'hazard': return 'hazard';
    default: return 'place';
  }
};

const farmLabel = (node: HostSemanticNode, record: Record<string, unknown> | undefined): string | undefined => {
  const crop = nonEmpty(record?.crop);
  if (crop) return `farm: ${crop}`;
  const label = nonEmpty(node.label);
  if (!label) return undefined;
  return label.startsWith('farm: ') ? label : `farm: ${label.replace(/^farm:\s*/, '')}`;
};

/**
 * Convert one real host semantic node into a semantic fact, classifying by
 * `metadata.curio.type` before any tag/kind fallback.
 */
export function convertHostSemanticNode(
  node: HostSemanticNode,
  options: HostFactConversionOptions = {},
): HostFactConversion {
  const curio = curioOf(node);
  const record = recordOf(curio);
  const classification = classify(node, curio);
  if ('reason' in classification) {
    return { kind: 'gap', gap: { ...classification, role: curio?.type } };
  }
  const { role, classifiedBy } = classification;
  const id = nonEmpty(node.id);
  const worldId = nonEmpty(node.worldId) ?? options.worldId;
  const dim = nonEmpty(node.dim);
  const observedAt = node.observedAt;

  const identityGap = missingIdentity(node, options.worldId);
  if (identityGap !== undefined || id === undefined || worldId === undefined || dim === undefined || !finite(observedAt)) {
    return { kind: 'gap', gap: identityGap ?? { reason: 'unclassifiable', id: node.id, role } };
  }

  const source = provenanceOf(node);
  const legacyId = nonEmpty(node.legacyId) ?? id;
  const gone = node.gone === true;
  const goneAt = finite(node.goneAt) ? node.goneAt : undefined;

  if (role === 'container') {
    const pos = exactCellOf(node, record);
    if ('reason' in pos) return { kind: 'gap', gap: { ...pos, role } };
    const ledgerKey = containerLedgerKey(worldId, dim, pos);
    const externalRef = nonEmpty(node.externalRef) ?? nonEmpty(record?.externalRef) ?? ledgerKey;
    const ledgerRef = nonEmpty(node.ledgerRef) ?? nonEmpty(record?.ledgerRef) ?? externalRef;
    const goneEvidence = gone ? goneSourceProvenance(observedGoneReason(node, record), source) : undefined;
    return {
      kind: 'fact',
      role,
      classifiedBy,
      legacyId,
      fact: {
        id,
        worldId,
        dim,
        pos,
        externalRef,
        observedAt,
        source,
        gone,
        ...(gone && goneAt !== undefined ? { goneAt } : {}),
        ...(goneEvidence === undefined ? {} : { goneSource: goneEvidence }),
        // The host ledger is keyed by world+dim+cell for both chests and furnaces.
        ledgerRef,
        legacyId,
      },
    };
  }

  if (role === 'resource') {
    const cell = exactCellOf(node, record);
    if ('reason' in cell) return { kind: 'gap', gap: { ...cell, role } };
    const label = nonEmpty(node.label) ?? nonEmpty(record?.label);
    if (label === undefined) return { kind: 'gap', gap: { reason: 'missing_label', id, role } };
    const resourceType = nonEmpty(node.resourceType) ?? nonEmpty(record?.resourceType);
    const revokedSource = gone ? goneSourceProvenance(observedGoneReason(node, record), source) : undefined;
    return {
      kind: 'fact',
      role,
      classifiedBy,
      legacyId,
      fact: {
        id,
        worldId,
        dim,
        label,
        ...(resourceType === undefined ? {} : { resourceType }),
        sourceCell: cell,
        observedAt,
        source,
        revoked: gone,
        ...(gone && goneAt !== undefined ? { revokedAt: goneAt } : {}),
        ...(revokedSource === undefined ? {} : { revokedSource }),
        legacyId,
      },
    };
  }

  // Everything else is a place-like anchor.
  const location = locationOf(node, record);
  if ('reason' in location) return { kind: 'gap', gap: { ...location, role } };
  if (location.kind !== 'exact' && role !== 'farm' && role !== 'station' && role !== 'hazard' && role !== 'gone' && role !== 'place') {
    // Base/death/portal are exact interaction targets; do not silently use an
    // area center for them.
    return { kind: 'gap', gap: { reason: 'inexact_location', id, role } };
  }
  const label = role === 'farm'
    ? farmLabel(node, record)
    : nonEmpty(node.label) ?? nonEmpty(record?.label);
  if (label === undefined) return { kind: 'gap', gap: { reason: 'missing_label', id, role } };

  let placeSource = source;
  if (role === 'portal') {
    const observed = record?.portalObserved;
    placeSource = {
      ...source,
      source: typeof observed === 'boolean'
        ? (observed ? PORTAL_OBSERVED_SOURCE : PORTAL_ARRIVAL_SOURCE)
        : source.source,
    };
  }
  const goneEvidence = gone ? goneSourceProvenance(observedGoneReason(node, record), source) : undefined;

  return {
    kind: 'fact',
    role,
    classifiedBy,
    legacyId,
    fact: {
      id,
      kind: placeKindOf(role),
      label,
      worldId,
      dim,
      location,
      observedAt,
      source: placeSource,
      gone,
      ...(gone && goneAt !== undefined ? { goneAt } : {}),
      ...(goneEvidence === undefined ? {} : { goneSource: goneEvidence }),
      legacyId,
    },
  };
}

/* --------------------------------------------------------------- migration */

export interface HostSemanticMigrationOptions {
  worldId: string;
  /**
   * Facts already present in the destination. Passing the previous plan's
   * facts makes a re-run report duplicates instead of new migrations.
   */
  existing?: readonly SemanticFact[];
}

export interface HostFactsMigrationReport {
  /** Unique facts that still need a destination write. */
  migrated: number;
  /** Route-only nodes deliberately not migrated. */
  skippedRoute: number;
  /** Canonical duplicates (within the snapshot or against `existing`). */
  duplicates: number;
  /** Same identity/key with incompatible content or durable ids. */
  conflicts: number;
  /** Unique migrated facts that carry gone/revoked state. */
  gone: number;
  /** Semantic-looking nodes that could not be attributed without inventing data. */
  unknown: number;
  migratedIds: string[];
  skippedRouteIds: string[];
  duplicateIds: string[];
  conflictIds: string[];
  goneIds: string[];
  unknownIds: string[];
}

export interface HostSemanticMigrationPlan {
  /** Full desired semantic fact set; applying it is idempotent. */
  facts: readonly SemanticFact[];
  /** Every node that was not converted, with a structured reason. */
  gaps: readonly HostFactGap[];
  report: HostFactsMigrationReport;
}

export interface HostSemanticMigrationApplyReport {
  inserted: number;
  updated: number;
  duplicate: number;
  conflict: number;
}

const factCanonicalKey = (fact: SemanticFact): string => {
  if (isPlaceFact(fact)) return JSON.stringify(['place', fact.worldId, fact.dim, fact.id]);
  if (isResourceFact(fact)) {
    const { x, y, z } = fact.sourceCell;
    return JSON.stringify(['resource', fact.worldId, fact.dim, x, y, z, fact.label]);
  }
  return JSON.stringify(['container', fact.worldId, fact.dim, fact.externalRef]);
};

const pointsEqual = (a: Vec3Like, b: Vec3Like): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const locationsEqual = (a: FactLocation, b: FactLocation): boolean =>
  a.kind === 'exact' && b.kind === 'exact' ? pointsEqual(a.pos, b.pos)
    : a.kind === 'area' && b.kind === 'area' ? a.radius === b.radius && pointsEqual(a.center, b.center)
      : false;

const sameFact = (a: SemanticFact, b: SemanticFact): boolean => {
  if (isPlaceFact(a) && isPlaceFact(b)) {
    return a.id === b.id && a.worldId === b.worldId && a.dim === b.dim && a.kind === b.kind
      && a.label === b.label && locationsEqual(a.location, b.location) && a.gone === b.gone && a.goneAt === b.goneAt;
  }
  if (isResourceFact(a) && isResourceFact(b)) {
    return a.id === b.id && a.worldId === b.worldId && a.dim === b.dim && a.label === b.label
      && a.resourceType === b.resourceType && pointsEqual(a.sourceCell, b.sourceCell)
      && a.revoked === b.revoked && a.revokedAt === b.revokedAt;
  }
  if (isContainerFact(a) && isContainerFact(b)) {
    return a.id === b.id && a.worldId === b.worldId && a.dim === b.dim && pointsEqual(a.pos, b.pos)
      && a.externalRef === b.externalRef && a.ledgerRef === b.ledgerRef
      && a.gone === b.gone && a.goneAt === b.goneAt;
  }
  return false;
};

const lastObserved = (fact: SemanticFact): number => isPlaceFact(fact)
  ? Math.max(fact.observedAt, fact.goneAt ?? fact.observedAt)
  : isResourceFact(fact)
    ? Math.max(fact.observedAt, fact.revokedAt ?? fact.observedAt)
    : Math.max(fact.observedAt, fact.goneAt ?? fact.observedAt);

interface Bucket {
  byKey: Map<string, SemanticFact>;
  ids: Map<string, string>;
}

const emptyBuckets = (): Bucket[] => [
  { byKey: new Map(), ids: new Map() },
  { byKey: new Map(), ids: new Map() },
  { byKey: new Map(), ids: new Map() },
];

const bucketOf = (buckets: Bucket[], fact: SemanticFact): Bucket =>
  buckets[semanticFactKind(fact) === 'place' ? 0 : semanticFactKind(fact) === 'resource' ? 1 : 2]!;

const addPlanned = (
  fact: SemanticFact,
  buckets: Bucket[],
  duplicates: string[],
  conflicts: string[],
): void => {
  const bucket = bucketOf(buckets, fact);
  const key = factCanonicalKey(fact);
  const existing = bucket.byKey.get(key);
  if (existing === undefined) {
    const otherKey = bucket.ids.get(fact.id);
    if (otherKey !== undefined && otherKey !== key) {
      conflicts.push(fact.id);
      return;
    }
    bucket.byKey.set(key, fact);
    bucket.ids.set(fact.id, key);
    return;
  }
  if (existing.id !== fact.id) {
    conflicts.push(fact.id);
    return;
  }
  const incoming = lastObserved(fact);
  const stored = lastObserved(existing);
  if (incoming > stored) {
    bucket.byKey.set(key, fact);
    duplicates.push(fact.id);
    return;
  }
  if (incoming === stored && !sameFact(existing, fact)) {
    conflicts.push(fact.id);
    return;
  }
  duplicates.push(fact.id);
};

const indexExisting = (facts: readonly SemanticFact[]): Bucket[] => {
  const buckets = emptyBuckets();
  for (const fact of facts) {
    const bucket = bucketOf(buckets, fact);
    bucket.byKey.set(factCanonicalKey(fact), fact);
    bucket.ids.set(fact.id, factCanonicalKey(fact));
  }
  return buckets;
};

const compareWithExisting = (fact: SemanticFact, existing: Bucket[]): 'migrated' | 'duplicate' | 'conflict' => {
  const bucket = bucketOf(existing, fact);
  const key = factCanonicalKey(fact);
  const stored = bucket.byKey.get(key);
  if (stored === undefined) {
    const other = bucket.ids.get(fact.id);
    return other === undefined ? 'migrated' : 'conflict';
  }
  if (stored.id !== fact.id) return 'conflict';
  if (lastObserved(fact) > lastObserved(stored)) return 'migrated';
  return sameFact(stored, fact) || lastObserved(fact) < lastObserved(stored) ? 'duplicate' : 'conflict';
};

/**
 * Rehearse migrating real host semantic nodes. Pure: the input is not mutated
 * and no destination is touched. Route-only nodes are reported separately from
 * semantic nodes that could not be converted without inventing data.
 */
export function planHostSemanticMigration(
  nodes: readonly HostSemanticNode[],
  options: HostSemanticMigrationOptions,
): HostSemanticMigrationPlan {
  const buckets = emptyBuckets();
  const gaps: HostFactGap[] = [];
  const skippedRouteIds: string[] = [];
  const unknownIds: string[] = [];
  const duplicates: string[] = [];
  const conflicts: string[] = [];

  for (const node of nodes) {
    const conversion = convertHostSemanticNode(node, { worldId: options.worldId });
    if (conversion.kind === 'gap') {
      gaps.push(conversion.gap);
      if (conversion.gap.reason === 'route_geometry') {
        skippedRouteIds.push(conversion.gap.id ?? '<unknown>');
      } else {
        unknownIds.push(conversion.gap.id ?? '<unknown>');
      }
      continue;
    }
    addPlanned(conversion.fact, buckets, duplicates, conflicts);
  }

  const facts = buckets.flatMap((bucket) => [...bucket.byKey.values()]);
  const existing = indexExisting(options.existing ?? []);
  const migratedIds: string[] = [];
  const duplicateIds = [...duplicates];
  const conflictIds = [...conflicts];
  for (const fact of facts) {
    const outcome = compareWithExisting(fact, existing);
    if (outcome === 'migrated') migratedIds.push(fact.id);
    else if (outcome === 'duplicate') duplicateIds.push(fact.id);
    else conflictIds.push(fact.id);
  }
  const goneIds = facts.filter(isFactGone).map((fact) => fact.id);

  return {
    facts,
    gaps,
    report: {
      migrated: migratedIds.length,
      skippedRoute: skippedRouteIds.length,
      duplicates: duplicateIds.length,
      conflicts: conflictIds.length,
      gone: goneIds.length,
      unknown: unknownIds.length,
      migratedIds,
      skippedRouteIds,
      duplicateIds,
      conflictIds,
      goneIds,
      unknownIds,
    },
  };
}

const upsertFact = (port: HostFactsPort, fact: SemanticFact): FactWriteOutcome => {
  if (isPlaceFact(fact)) return port.upsertPlace(fact).outcome;
  if (isResourceFact(fact)) return port.upsertResource(fact).outcome;
  return port.upsertContainer(fact).outcome;
};

/**
 * Apply a dry-run plan to a host facts port. Re-applying the same plan reports
 * duplicates instead of creating new records.
 */
export function applyHostSemanticMigration(
  port: HostFactsPort,
  plan: HostSemanticMigrationPlan,
): HostSemanticMigrationApplyReport {
  const report: HostSemanticMigrationApplyReport = { inserted: 0, updated: 0, duplicate: 0, conflict: 0 };
  for (const fact of plan.facts) report[upsertFact(port, fact)] += 1;
  return report;
}

/* ------------------------------------------------- in-memory host fact port */

/**
 * In-memory host facts port for tests and the non-persistent WorldMemory
 * fallback. The library `InMemoryFactStore` already implements the full
 * ten-method contract, including native container-gone state.
 */
export function createInMemoryHostFactsPort(): HostFactsPort {
  return new InMemoryFactStore();
}
