/**
 * Host-side adaptation between Curio's `metadata.curio` semantic nodes and the
 * v0.11 semantic fact layer.
 *
 * The library fact model is deliberately narrow: places, exact-cell resource
 * anchors and container shell anchors, each carrying identity, scope,
 * observation time, provenance and gone/revoked state. It never carries
 * inventories. This module is the host boundary that:
 *
 * - defines the narrow `HostFactsPort` the semantic/travel stores depend on
 *   (structural copy of the frozen interface so a lagging package artifact does
 *   not leak into host code);
 * - classifies real host nodes by `metadata.curio.type` first and only falls
 *   back to `tag`/`kind` for nodes that never had curio metadata;
 * - rehearses/applies the migration of real host semantic nodes (never a
 *   tag-only generic shape) and reports gaps instead of dropping them.
 *
 * `createInMemoryHostFactsPort` is the test/non-persistent implementation. It
 * wraps the library `InMemoryFactStore`; the only host-managed state is
 * container-gone, which the frozen library artifact does not type yet.
 */
import { InMemoryFactStore } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';

/* ------------------------------------------------------------------ facts */

/** How a fact was observed. Opaque to the library. */
export interface FactProvenance {
  /** Caller-supplied provenance label. */
  source: string;
  /** Session the observation actually happened in, when known. */
  sessionId?: string;
  /** Host observation ids that support this record, when available. */
  observationIds?: readonly string[];
}

export type PlaceKind = 'place' | 'base' | 'death' | 'portal' | 'station' | 'hazard';

export type FactLocation =
  | { kind: 'exact'; pos: Vec3Like }
  | { kind: 'area'; center: Vec3Like; radius: number };

export interface PlaceFact {
  id: string;
  kind: PlaceKind;
  label: string;
  worldId: string;
  dim: string;
  location: FactLocation;
  /** Real observation time in milliseconds; never a save batch or receipt time. */
  observedAt: number;
  source: FactProvenance;
  /** The place was observed no longer present; the record is retained. */
  gone: boolean;
  /** Real disappearance observation time; absent when legacy data lacked one. */
  goneAt?: number;
  /** Provenance of the disappearance observation, separate from `source`. */
  goneSource?: FactProvenance;
  /** Compatibility-source id, preserved verbatim during a migration. */
  legacyId?: string;
}

export interface ResourceAnchorFact {
  id: string;
  worldId: string;
  dim: string;
  /** Resource identity within the source cell (e.g. `iron_ore`). */
  label: string;
  /** Optional host resource classification; never inferred from the label. */
  resourceType?: string;
  /** Exact cell the resource was observed in. Area locations are not resources. */
  sourceCell: Vec3Like;
  observedAt: number;
  source: FactProvenance;
  /** The resource was observed removed or replaced; the record is retained. */
  revoked: boolean;
  revokedAt?: number;
  revokedSource?: FactProvenance;
  legacyId?: string;
}

export interface ContainerAnchorFact {
  id: string;
  worldId: string;
  dim: string;
  /** Exact block cell. Region centers are never promoted to container targets. */
  pos: Vec3Like;
  /**
   * Stable host identity (e.g. a chest key). The same `worldId` + `dim` +
   * `externalRef` is one anchor even when re-observed.
   */
  externalRef: string;
  /** Real observation time of the shell in milliseconds. */
  observedAt: number;
  source: FactProvenance;
  /** The container shell was observed no longer present; the record is retained. */
  gone: boolean;
  /** Real disappearance observation time; absent when legacy data lacked one. */
  goneAt?: number;
  /** Provenance of the disappearance observation, separate from `source`. */
  goneSource?: FactProvenance;
  /** Opaque reference into the host precise container ledger. */
  ledgerRef?: string;
  /** Compatibility-source id, preserved verbatim during a migration. */
  legacyId?: string;
}

export type SemanticFact = PlaceFact | ResourceAnchorFact | ContainerAnchorFact;

export interface FactQuery {
  worldId?: string;
  dim?: string;
  /** Include gone/revoked records. Defaults to false. */
  includeGone?: boolean;
  /** Exclusive cursor: only ids sorting after this id are returned. */
  after?: string;
  /** Page size; bounded by the store's `maxQueryLimit`. */
  limit?: number;
}

export interface ResourceFactQuery extends FactQuery {
  sourceCell?: Vec3Like;
}

export interface FactPage<T> {
  items: T[];
  total: number;
  nextAfter?: string;
}

export type FactWriteOutcome = 'inserted' | 'updated' | 'duplicate' | 'conflict';

export interface FactWriteResult<T> {
  outcome: FactWriteOutcome;
  record: T;
}

/** Evidence for a gone/revoked transition. It is not a deletion. */
export interface FactGoneEvidence {
  observedAt: number;
  source: FactProvenance;
}

/** Re-anchor an existing resource id at a new exact source cell. */
export interface ResourceSourceUpdate {
  sourceCell: Vec3Like;
  label?: string;
  observedAt: number;
  source: FactProvenance;
}

/**
 * The narrow host port from the frozen first-batch interface (§2). The semantic
 * and travel stores depend on this shape only; the integrator maps it onto the
 * final library `FactStore`/persistent artifact.
 */
export interface HostFactsPort {
  upsertPlace(place: PlaceFact): FactWriteResult<PlaceFact>;
  upsertResource(resource: ResourceAnchorFact): FactWriteResult<ResourceAnchorFact>;
  upsertContainer(container: ContainerAnchorFact): FactWriteResult<ContainerAnchorFact>;
  markPlaceGone(id: string, evidence: FactGoneEvidence): FactWriteResult<PlaceFact>;
  revokeResource(id: string, evidence: FactGoneEvidence): FactWriteResult<ResourceAnchorFact>;
  markContainerGone(id: string, evidence: FactGoneEvidence): FactWriteResult<ContainerAnchorFact>;
  updateResourceSource(id: string, update: ResourceSourceUpdate): FactWriteResult<ResourceAnchorFact>;
  places(query?: FactQuery): FactPage<PlaceFact>;
  resources(query?: ResourceFactQuery): FactPage<ResourceAnchorFact>;
  containers(query?: FactQuery): FactPage<ContainerAnchorFact>;
}

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

/** Container disappearance state the frozen library artifact does not type yet. */
interface ContainerGoneState {
  goneAt?: number;
  goneSource?: FactProvenance;
}

const cloneProvenance = (source: FactProvenance): FactProvenance => ({
  source: source.source,
  ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
  ...(source.observationIds === undefined ? {} : { observationIds: [...source.observationIds] }),
});

const cloneFactLocation = (location: FactLocation): FactLocation => location.kind === 'exact'
  ? { kind: 'exact', pos: { ...location.pos } }
  : { kind: 'area', center: { ...location.center }, radius: location.radius };

const cloneFact = <T extends SemanticFact>(fact: T): T => {
  if (isPlaceFact(fact)) {
    return {
      ...fact,
      location: cloneFactLocation(fact.location),
      source: cloneProvenance(fact.source),
      ...(fact.goneSource === undefined ? {} : { goneSource: cloneProvenance(fact.goneSource) }),
    } as T;
  }
  if (isResourceFact(fact)) {
    return {
      ...fact,
      sourceCell: { ...fact.sourceCell },
      source: cloneProvenance(fact.source),
      ...(fact.revokedSource === undefined ? {} : { revokedSource: cloneProvenance(fact.revokedSource) }),
    } as T;
  }
  return {
    ...fact,
    pos: { ...fact.pos },
    source: cloneProvenance(fact.source),
    ...(fact.goneSource === undefined ? {} : { goneSource: cloneProvenance(fact.goneSource) }),
  } as T;
};

const pageAll = <T>(page: (after: string | undefined) => FactPage<T>): T[] => {
  const out: T[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const next = page(after);
    out.push(...next.items);
    if (next.nextAfter === undefined) break;
    after = next.nextAfter;
  }
  return out;
};

/**
 * In-memory host facts port for tests and the non-persistent WorldMemory
 * fallback. Place/resource semantics delegate to the library `InMemoryFactStore`;
 * container-gone is tracked here because the frozen artifact predates that
 * field. This is a test seam, not a second spatial authority.
 */
export function createInMemoryHostFactsPort(): HostFactsPort {
  const store = new InMemoryFactStore();
  const containerGone = new Map<string, ContainerGoneState>();

  const overlay = (record: ContainerAnchorFact): ContainerAnchorFact => {
    const gone = containerGone.get(record.id);
    return gone ? cloneFact({ ...record, gone: true, ...gone }) : cloneFact({ ...record, gone: record.gone === true });
  };

  const allContainers = (query: FactQuery): ContainerAnchorFact[] => {
    // `includeGone: true` is required both by artifacts that filter gone
    // containers natively and by this wrapper's overlay.
    const records = pageAll((after) => store.containers({ worldId: query.worldId, dim: query.dim, includeGone: true, after, limit: 1000 }))
      .map((record) => overlay(record as ContainerAnchorFact));
    return records.filter((record) => query.includeGone === true || !record.gone);
  };

  return {
    upsertPlace: (place) => store.upsertPlace(place),
    upsertResource: (resource) => store.upsertResource(resource),
    upsertContainer: (container) => {
      // The linked artifact's type has no gone field, but it snapshots records
      // by spread, so the anchor survives; container-gone remains host state.
      const result = store.upsertContainer(container);
      if (container.gone) {
        containerGone.set(container.id, {
          ...(container.goneAt === undefined ? {} : { goneAt: container.goneAt }),
          ...(container.goneSource === undefined ? {} : { goneSource: cloneProvenance(container.goneSource) }),
        });
      } else {
        const current = containerGone.get(container.id);
        if (current !== undefined && container.observedAt >= (current.goneAt ?? -Infinity)) containerGone.delete(container.id);
      }
      return { outcome: result.outcome, record: overlay(result.record as ContainerAnchorFact) };
    },
    markPlaceGone: (id, evidence) => store.markPlaceGone(id, evidence),
    revokeResource: (id, evidence) => store.revokeResource(id, evidence),
    markContainerGone: (id, evidence): FactWriteResult<ContainerAnchorFact> => {
      const existing = allContainers({ includeGone: true }).find((record) => record.id === id);
      if (existing === undefined) throw new Error(`unknown container id: ${id}`);
      if (existing.gone) return { outcome: 'duplicate', record: overlay(existing) };
      if (evidence.observedAt < existing.observedAt) return { outcome: 'conflict', record: overlay(existing) };
      containerGone.set(id, {
        goneAt: evidence.observedAt,
        goneSource: cloneProvenance(evidence.source),
      });
      return { outcome: 'updated', record: overlay(existing) };
    },
    updateResourceSource: (id, update) => store.updateResourceSource(id, update),
    places: (query = {}) => store.places(query),
    resources: (query = {}) => store.resources(query),
    containers: (query = {}) => {
      const records = allContainers(query);
      const sorted = records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const after = query.after;
      const start = after === undefined ? 0 : sorted.findIndex((record) => record.id > after);
      const from = start < 0 ? sorted.length : start;
      const limit = query.limit === undefined ? 100 : Math.min(Math.max(1, query.limit), 1000);
      const items = sorted.slice(from, from + limit);
      const more = from + items.length < sorted.length;
      return {
        items,
        total: sorted.length,
        ...(more && items.length > 0 ? { nextAfter: items[items.length - 1]!.id } : {}),
      };
    },
  };
}
