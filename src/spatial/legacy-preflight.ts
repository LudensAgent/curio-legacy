/**
 * Read-only projection of legacy spatial memory.
 *
 * This module never imports the runtime stores, never constructs them and never
 * rewrites the input. It answers a narrow audit question: what legacy records
 * exist, what original scope/time/provenance they actually carry, and which
 * records are only historical candidates or need human review before any
 * migration. It does not migrate, normalize or complete missing fields.
 */

const REPORT_VERSION = 1;
const DEFAULT_MAX_INSPECTED_RECORDS = 10_000;
const DEFAULT_MAX_ISSUE_DETAILS = 100;
const DEFAULT_MAX_NESTED_ITEMS_PER_RECORD = 64;

type MigrationStatus = 'candidate_historical' | 'needs_review';
type ShapeStatus = 'valid' | 'invalid';
type IdentityStatus = 'not_applicable' | 'unique' | 'duplicate' | 'unverified_truncated';

type PreflightOptions = {
  maxInspectedRecords?: number;
  maxIssueDetails?: number;
  maxNestedItemsPerRecord?: number;
};

type ProjectionBase = {
  locator: string;
  recordType: string;
  shapeStatus: ShapeStatus;
  migrationStatus: MigrationStatus;
  reviewReasons: string[];
  invalidReasons: string[];
  missingProvenance: string[];
  retainedFields: string[];
  unknownFields: string[];
  identityStatus: IdentityStatus;
  id: string | null;
};

type Issue = { code: string; locator: string; message: string };

type Context = {
  options: Required<PreflightOptions>;
  issues: Issue[];
  issueTotal: number;
  recordsRemaining: number;
  nestedTruncations: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isVec3 = (value: unknown): value is { x: number; y: number; z: number } =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);

const numberOrNull = (value: unknown) => isFiniteNumber(value) ? value : null;
const stringOrNull = (value: unknown) => typeof value === 'string' ? value : null;

const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

const addIssue = (ctx: Context, code: string, locator: string, message: string) => {
  ctx.issueTotal++;
  if (ctx.issues.length < ctx.options.maxIssueDetails) ctx.issues.push({ code, locator, message });
};

const boundedWindow = (value: unknown, max: number):
  | { present: false; total: null; inspected: 0; uninspected: null; truncated: false; items: unknown[] }
  | { present: true; total: number; inspected: number; uninspected: number; truncated: boolean; items: unknown[] } => {
  if (!Array.isArray(value)) {
    return { present: false, total: null, inspected: 0, uninspected: null, truncated: false, items: [] };
  }
  const total = value.length;
  const inspected = Math.min(total, max);
  return { present: true, total, inspected, uninspected: total - inspected, truncated: inspected < total, items: value.slice(0, inspected) };
};

function noteNestedTruncation(ctx: Context, locator: string, field: string, window: { inspected: number; total: number; truncated: boolean }) {
  if (!window.truncated) return false;
  ctx.nestedTruncations++;
  addIssue(ctx, 'nested_truncated', locator, `${field}: inspected ${window.inspected}/${window.total} nested items`);
  return true;
}

function baseProjection(raw: unknown, locator: string, recordType: string, identityStatus: IdentityStatus): ProjectionBase {
  return {
    locator,
    recordType,
    shapeStatus: 'valid',
    migrationStatus: 'needs_review',
    reviewReasons: [],
    invalidReasons: [],
    missingProvenance: [],
    retainedFields: isRecord(raw) ? Object.keys(raw) : [],
    unknownFields: [],
    identityStatus,
    id: null,
  };
}

function finishProjection(projection: ProjectionBase, ctx: Context, invalid: string[], blockers: string[], missingProvenance: string[]) {
  projection.invalidReasons = invalid;
  projection.missingProvenance = missingProvenance;
  projection.reviewReasons = invalid.length && !blockers.includes('invalid_shape') ? [...blockers, 'invalid_shape'] : blockers;
  if (invalid.length) {
    projection.shapeStatus = 'invalid';
    projection.migrationStatus = 'needs_review';
    addIssue(ctx, 'invalid_record', projection.locator, `invalid shape: ${invalid.join(', ')}`);
    return;
  }
  projection.shapeStatus = 'valid';
  projection.migrationStatus = blockers.length === 0 ? 'candidate_historical' : 'needs_review';
}

function markUnknownFields(projection: ProjectionBase, record: Record<string, unknown>, known: Set<string>, ctx: Context) {
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  projection.unknownFields = unknown;
  if (unknown.length) addIssue(ctx, 'unknown_field', projection.locator, `unknown fields retained: ${unknown.join(', ')}`);
}

function inspectVec3List(value: unknown, locator: string, field: string, ctx: Context) {
  const window = boundedWindow(value, ctx.options.maxNestedItemsPerRecord);
  if (!window.present) return { present: false, total: null, inspected: 0, uninspected: null, invalid: 0, truncated: false };
  const truncated = noteNestedTruncation(ctx, locator, field, window);
  return {
    present: true,
    total: window.total,
    inspected: window.inspected,
    uninspected: window.uninspected,
    invalid: window.items.filter((item) => !isVec3(item)).length,
    truncated,
  };
}

function inspectLinkList(value: unknown, locator: string, ctx: Context) {
  const window = boundedWindow(value, ctx.options.maxNestedItemsPerRecord);
  if (!window.present) {
    return { present: false, total: null, inspected: 0, uninspected: null, invalid: 0, truncated: false, certifiedTraversals: 0, traversalEvidence: 'unverified' };
  }
  const truncated = noteNestedTruncation(ctx, locator, 'links', window);
  return {
    present: true,
    total: window.total,
    inspected: window.inspected,
    uninspected: window.uninspected,
    invalid: window.items.filter((item) => !isRecord(item) || !isVec3(item.a) || !isVec3(item.b)).length,
    truncated,
    certifiedTraversals: 0,
    traversalEvidence: 'unverified',
  };
}

function inspectCountMap(value: unknown, locator: string, field: string, ctx: Context) {
  if (!isRecord(value)) return { present: false, entries: 0, inspected: 0, uninspected: 0, invalidValues: 0, truncated: false };
  const keys = Object.keys(value);
  const inspected = Math.min(keys.length, ctx.options.maxNestedItemsPerRecord);
  const truncated = noteNestedTruncation(ctx, locator, field, { inspected, total: keys.length, truncated: inspected < keys.length });
  return {
    present: true,
    entries: keys.length,
    inspected,
    uninspected: keys.length - inspected,
    invalidValues: keys.slice(0, inspected).filter((key) => !isFiniteNumber(value[key])).length,
    truncated,
  };
}

function inspectItemLines(value: unknown, locator: string, ctx: Context) {
  const window = boundedWindow(value, ctx.options.maxNestedItemsPerRecord);
  if (!window.present) return { present: false, total: null, inspected: 0, uninspected: null, invalid: 0, truncated: false };
  const truncated = noteNestedTruncation(ctx, locator, 'contents.items', window);
  return {
    present: true,
    total: window.total,
    inspected: window.inspected,
    uninspected: window.uninspected,
    invalid: window.items.filter((item) => !isRecord(item) || typeof item.name !== 'string' || !isFiniteNumber(item.count)).length,
    truncated,
  };
}

function collectionReport<T extends ProjectionBase>(
  status: 'omitted' | 'invalid' | 'empty' | 'inspected' | 'truncated',
  shape: 'array' | 'object' | null,
  total: number | null,
  records: T[],
  reason?: string,
) {
  const inspected = records.length;
  return {
    status,
    shape,
    total,
    inspected,
    uninspected: total === null ? null : total - inspected,
    invalid: records.filter((record) => record.shapeStatus === 'invalid').length,
    candidateHistorical: records.filter((record) => record.migrationStatus === 'candidate_historical').length,
    needsReview: records.filter((record) => record.migrationStatus === 'needs_review').length,
    truncated: status === 'truncated',
    ...(reason ? { reason } : {}),
    records,
  };
}

function inspectArrayCollection<T extends ProjectionBase>(
  raw: unknown,
  locator: string,
  ctx: Context,
  project: (item: unknown, index: number, complete: boolean) => T,
) {
  if (raw === undefined) return collectionReport('omitted', null, null, [] as T[]);
  if (!Array.isArray(raw)) {
    addIssue(ctx, 'invalid_collection', locator, 'expected an array');
    return collectionReport('invalid', null, null, [] as T[], 'expected_array');
  }
  const total = raw.length;
  const inspected = Math.min(total, ctx.recordsRemaining);
  ctx.recordsRemaining -= inspected;
  const complete = inspected === total;
  if (!complete) addIssue(ctx, 'collection_truncated', locator, `inspected ${inspected}/${total} records; remaining records are uninspected`);
  const records = raw.slice(0, inspected).map((item, index) => project(item, index, complete));
  const status = total === 0 ? 'empty' : complete ? 'inspected' : 'truncated';
  return collectionReport(status, 'array', total, records);
}

function inspectMapCollection<T extends ProjectionBase>(
  raw: unknown,
  locator: string,
  ctx: Context,
  project: (key: string, value: unknown, complete: boolean) => T,
) {
  if (raw === undefined) return collectionReport('omitted', null, null, [] as T[]);
  if (!isRecord(raw)) {
    addIssue(ctx, 'invalid_collection', locator, 'expected an object map');
    return collectionReport('invalid', null, null, [] as T[], 'expected_object');
  }
  const keys = Object.keys(raw);
  const total = keys.length;
  const inspected = Math.min(total, ctx.recordsRemaining);
  ctx.recordsRemaining -= inspected;
  const complete = inspected === total;
  if (!complete) addIssue(ctx, 'collection_truncated', locator, `inspected ${inspected}/${total} records; remaining records are uninspected`);
  const records = keys.slice(0, inspected).map((key) => project(key, raw[key], complete));
  const status = total === 0 ? 'empty' : complete ? 'inspected' : 'truncated';
  return collectionReport(status, 'object', total, records);
}

function refreshCollectionCounts(collection: { invalid: number; candidateHistorical: number; needsReview: number; records: ProjectionBase[] }) {
  collection.invalid = collection.records.filter((record) => record.shapeStatus === 'invalid').length;
  collection.candidateHistorical = collection.records.filter((record) => record.migrationStatus === 'candidate_historical').length;
  collection.needsReview = collection.records.filter((record) => record.migrationStatus === 'needs_review').length;
}

function applyDuplicateIds(records: ProjectionBase[], ctx: Context) {
  const groups = new Map<string, ProjectionBase[]>();
  for (const record of records) {
    if (!record.id) continue;
    const group = groups.get(record.id) ?? [];
    group.push(record);
    groups.set(record.id, group);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const locators = group.map((record) => record.locator);
    addIssue(ctx, 'duplicate_id', locators[0], `duplicate original id "${id}" at ${locators.join(', ')}`);
    for (const record of group) {
      record.identityStatus = 'duplicate';
      record.migrationStatus = 'needs_review';
      if (!record.reviewReasons.includes('duplicate_original_id')) record.reviewReasons.push('duplicate_original_id');
    }
  }
}

const PASSAGE_FIELDS = new Set(['id', 'worldId', 'dim', 'kind', 'entrances', 'path', 'links', 'deepestY', 'dug', 'ores', 'createdAt', 'lastUsedAt', 'uses']);
const PASSAGE_KINDS = new Set(['dug', 'walked', 'bridge']);

function projectPassage(raw: unknown, index: number, ctx: Context, complete: boolean, versionOk: boolean) {
  const record = isRecord(raw) ? raw : {};
  const projection = baseProjection(raw, `/worldMemory/passages/${index}`, 'passage', complete ? 'unique' : 'unverified_truncated');
  const invalid: string[] = [];
  const blockers: string[] = [];
  const missing: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');

  const id = isNonEmptyString(record.id) ? record.id : null;
  if (!id) invalid.push('id_not_nonempty_string');
  const worldId = isNonEmptyString(record.worldId) ? record.worldId : null;
  if (record.worldId !== undefined && worldId === null) invalid.push('worldId_not_nonempty_string');
  if (worldId === null) { blockers.push('missing_record_world_scope'); missing.push('worldId'); }
  const dim = isNonEmptyString(record.dim) ? record.dim : null;
  if (!dim) invalid.push('dim_not_nonempty_string');

  const kind = stringOrNull(record.kind);
  if (record.kind !== undefined && kind === null) invalid.push('kind_not_string');
  const unknownKind = kind !== null && !PASSAGE_KINDS.has(kind);
  if (unknownKind) blockers.push('unrecognized_kind');

  const entrances = inspectVec3List(record.entrances, projection.locator, 'entrances', ctx);
  if (!entrances.present) invalid.push('entrances_not_array');
  else if (entrances.invalid > 0) invalid.push('entrances_contain_invalid_vec3');
  const path = inspectVec3List(record.path, projection.locator, 'path', ctx);
  if (!path.present) invalid.push('path_not_array');
  else if (path.invalid > 0) invalid.push('path_contains_invalid_vec3');
  const links = inspectLinkList(record.links, projection.locator, ctx);
  if (record.links !== undefined && !links.present) invalid.push('links_not_array');
  else if (links.present && links.invalid > 0) invalid.push('links_contain_invalid_pairs');
  const ores = inspectCountMap(record.ores, projection.locator, 'ores', ctx);
  if (!ores.present) invalid.push('ores_not_object');
  else if (ores.invalidValues > 0) invalid.push('ores_contain_non_numeric_counts');

  const deepestY = numberOrNull(record.deepestY);
  const dug = numberOrNull(record.dug);
  const createdAt = numberOrNull(record.createdAt);
  const lastUsedAt = numberOrNull(record.lastUsedAt);
  const uses = numberOrNull(record.uses);
  if (deepestY === null) invalid.push('deepestY_not_finite_number');
  if (dug === null) invalid.push('dug_not_finite_number');
  if (createdAt === null) { invalid.push('createdAt_not_finite_number'); missing.push('createdAt'); }
  else if (createdAt <= 0) blockers.push('createdAt_not_positive');
  if (lastUsedAt === null) { invalid.push('lastUsedAt_not_finite_number'); missing.push('lastUsedAt'); }
  else if (lastUsedAt <= 0) blockers.push('lastUsedAt_not_positive');
  if (uses === null) invalid.push('uses_not_finite_number');

  if (!complete) blockers.push('collection_truncated');
  if (!versionOk) blockers.push('unrecognized_root_version');
  if (entrances.truncated || path.truncated || links.truncated || ores.truncated) blockers.push('nested_inspection_truncated');
  markUnknownFields(projection, record, PASSAGE_FIELDS, ctx);

  const result = {
    ...projection,
    id,
    worldId,
    dim,
    kind,
    createdAt,
    lastUsedAt,
    uses,
    deepestY,
    dug,
    geometry: {
      entrances,
      path,
      links,
      connectivity: 'path_order_or_entrance_references_do_not_prove_direct_connectivity',
      traversalEvidence: 'links_are_not_certified_traversals',
    },
    ores,
    provenance: {
      source: 'world-memory.passages',
      worldScope: worldId ? 'record_worldId' : 'missing',
      dimScope: dim ? 'record_dim' : 'missing',
      time: createdAt !== null && lastUsedAt !== null ? 'record_createdAt_lastUsedAt' : 'missing',
      session: 'not_recorded',
      observationTime: 'not_recorded',
      movement: 'historical_geometry_only',
    },
  };
  finishProjection(result, ctx, invalid, blockers, missing);
  return result;
}

const LANDMARK_FIELDS = new Set(['id', 'kind', 'label', 'dim', 'pos', 'ts', 'worldId', 'primary', 'count', 'detail', 'radius', 'precise', 'observedAt']);
const LANDMARK_KINDS = new Set(['base', 'resource', 'danger', 'discovery', 'death', 'waypoint', 'herd']);

function projectLandmark(raw: unknown, index: number, ctx: Context, complete: boolean, versionOk: boolean, legacyVersion: number | null) {
  const record = isRecord(raw) ? raw : {};
  const projection = baseProjection(raw, `/worldMemory/landmarks/${index}`, 'landmark', complete ? 'unique' : 'unverified_truncated');
  const invalid: string[] = [];
  const blockers: string[] = [];
  const missing: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');

  const id = isNonEmptyString(record.id) ? record.id : null;
  if (!id) invalid.push('id_not_nonempty_string');
  const worldId = isNonEmptyString(record.worldId) ? record.worldId : null;
  if (record.worldId !== undefined && worldId === null) invalid.push('worldId_not_nonempty_string');
  if (worldId === null) { blockers.push('missing_record_world_scope'); missing.push('worldId'); }
  const dim = isNonEmptyString(record.dim) ? record.dim : null;
  if (!dim) invalid.push('dim_not_nonempty_string');
  const kind = stringOrNull(record.kind);
  if (!kind) invalid.push('kind_not_nonempty_string');
  const unknownKind = kind !== null && !LANDMARK_KINDS.has(kind);
  if (unknownKind) blockers.push('unrecognized_kind');
  if (typeof record.label !== 'string') invalid.push('label_not_string');
  if (!isVec3(record.pos)) invalid.push('pos_not_finite_vec3');
  const ts = numberOrNull(record.ts);
  if (ts === null) { invalid.push('ts_not_finite_number'); missing.push('ts'); }
  else if (ts <= 0) blockers.push('ts_not_positive');
  const observedAt = numberOrNull(record.observedAt);
  if (record.observedAt !== undefined && observedAt === null) invalid.push('observedAt_not_finite_number');
  if (record.observedAt === undefined) missing.push('observedAt');
  if (record.primary !== undefined && typeof record.primary !== 'boolean') invalid.push('primary_not_boolean');
  if (record.count !== undefined && !isFiniteNumber(record.count)) invalid.push('count_not_finite_number');
  if (record.detail !== undefined && typeof record.detail !== 'string') invalid.push('detail_not_string');
  if (record.radius !== undefined && !isFiniteNumber(record.radius)) invalid.push('radius_not_finite_number');
  if (record.precise !== undefined && typeof record.precise !== 'boolean') invalid.push('precise_not_boolean');

  const legacyRisk = legacyVersion !== null && legacyVersion < 2;
  if (legacyRisk) blockers.push('legacy_landmark_provenance_may_include_findblocks_data');
  if (!complete) blockers.push('collection_truncated');
  if (!versionOk) blockers.push('unrecognized_root_version');
  markUnknownFields(projection, record, LANDMARK_FIELDS, ctx);

  const result = {
    ...projection,
    id,
    worldId,
    dim,
    kind,
    ts,
    observedAt,
    primary: typeof record.primary === 'boolean' ? record.primary : null,
    base: kind === 'base',
    provenance: {
      source: 'world-memory.landmarks',
      worldScope: worldId ? 'record_worldId' : 'missing',
      dimScope: dim ? 'record_dim' : 'missing',
      time: ts !== null ? 'record_ts_creation_or_update' : 'missing',
      observedAt: observedAt !== null ? 'record_observedAt' : 'not_recorded',
      session: 'not_recorded',
      legacyFilteringRepeated: false,
    },
  };
  finishProjection(result, ctx, invalid, blockers, missing);
  return result;
}

const CHEST_FIELDS = new Set(['worldId', 'dim', 'pos', 'block', 'uses', 'ts', 'day', 'note', 'contents', 'items', 'traces']);
const CHEST_CONTENTS_FIELDS = new Set(['items', 'observedAt', 'day', 'possiblyStale', 'capacity', 'freeSlots']);

function projectChest(key: string, raw: unknown, ctx: Context, complete: boolean, versionOk: boolean) {
  const record = isRecord(raw) ? raw : {};
  const locator = `/worldMemory/chests/${pointer(key)}`;
  const projection = baseProjection(raw, locator, 'chest', 'unique');
  const invalid: string[] = [];
  const blockers: string[] = [];
  const missing: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');

  const worldId = isNonEmptyString(record.worldId) ? record.worldId : null;
  if (record.worldId !== undefined && worldId === null) invalid.push('worldId_not_nonempty_string');
  if (worldId === null) { blockers.push('missing_record_world_scope'); missing.push('worldId'); }
  const dim = isNonEmptyString(record.dim) ? record.dim : null;
  if (!dim) invalid.push('dim_not_nonempty_string');
  if (!isVec3(record.pos)) invalid.push('pos_not_finite_vec3');
  const block = isNonEmptyString(record.block) ? record.block : null;
  if (!block) invalid.push('block_not_nonempty_string');
  const uses = numberOrNull(record.uses);
  if (uses === null) invalid.push('uses_not_finite_number');
  const ts = numberOrNull(record.ts);
  if (ts === null) { invalid.push('ts_not_finite_number'); missing.push('ts'); }
  else if (ts <= 0) blockers.push('ts_not_positive');
  const day = numberOrNull(record.day);
  if (record.day !== undefined && day === null) invalid.push('day_not_finite_number');

  const contentsRaw = record.contents;
  const knownLegacyFields = Array.isArray(record.items) || Array.isArray(record.traces) || record.items !== undefined || record.traces !== undefined;
  let contentsPresent = false;
  let ledgerStatus: 'missing' | 'legacy_imprecise' | 'invalid' | 'unknown' | 'stale_unconfirmed' | 'recorded_empty_at_original_time' | 'recorded_nonempty_at_original_time' = 'missing';
  let contentsUnknownFields: string[] = [];
  let itemLines = { present: false, total: null as number | null, inspected: 0, uninspected: null as number | null, invalid: 0, truncated: false };
  let contentsObservedAt: number | null = null;
  let contentsDay: number | null = null;
  let possiblyStale: boolean | null = null;
  let capacity: number | null = null;
  let freeSlots: number | null = null;

  if (contentsRaw !== undefined) {
    contentsPresent = true;
    if (!isRecord(contentsRaw)) {
      invalid.push('contents_not_object');
      ledgerStatus = 'invalid';
    } else {
      itemLines = inspectItemLines(contentsRaw.items, locator, ctx);
      if (!itemLines.present) invalid.push('contents_items_not_array');
      else if (itemLines.invalid > 0) invalid.push('contents_items_contain_invalid_lines');
      contentsObservedAt = numberOrNull(contentsRaw.observedAt);
      if (contentsObservedAt === null) { invalid.push('contents_observedAt_not_finite_number'); missing.push('contents.observedAt'); }
      if (contentsRaw.day !== undefined) {
        contentsDay = numberOrNull(contentsRaw.day);
        if (contentsDay === null) invalid.push('contents_day_not_finite_number');
      }
      if (contentsRaw.possiblyStale !== undefined && typeof contentsRaw.possiblyStale !== 'boolean') invalid.push('contents_possiblyStale_not_boolean');
      possiblyStale = typeof contentsRaw.possiblyStale === 'boolean' ? contentsRaw.possiblyStale : null;
      if (contentsRaw.capacity !== undefined) {
        capacity = numberOrNull(contentsRaw.capacity);
        if (capacity === null) invalid.push('contents_capacity_not_finite_number');
      }
      if (contentsRaw.freeSlots !== undefined) {
        freeSlots = numberOrNull(contentsRaw.freeSlots);
        if (freeSlots === null) invalid.push('contents_freeSlots_not_finite_number');
      }
      contentsUnknownFields = Object.keys(contentsRaw).filter((field) => !CHEST_CONTENTS_FIELDS.has(field));
      if (contentsUnknownFields.length) addIssue(ctx, 'unknown_field', locator, `unknown contents fields retained: ${contentsUnknownFields.join(', ')}`);
      if (!itemLines.present) ledgerStatus = 'invalid';
      else if (contentsObservedAt === null || contentsObservedAt <= 0) ledgerStatus = 'unknown';
      else if (possiblyStale === true) ledgerStatus = 'stale_unconfirmed';
      else if (itemLines.total === 0) ledgerStatus = 'recorded_empty_at_original_time';
      else ledgerStatus = 'recorded_nonempty_at_original_time';
    }
  } else if (knownLegacyFields) {
    ledgerStatus = 'legacy_imprecise';
    blockers.push('legacy_imprecise_items_cannot_produce_precise_counts');
  } else {
    ledgerStatus = 'missing';
    blockers.push('precise_ledger_missing');
  }

  if (contentsPresent && contentsObservedAt !== null && contentsObservedAt > 0) {
    if (ledgerStatus === 'invalid' || ledgerStatus === 'missing') blockers.push('precise_ledger_unavailable');
  } else if (contentsPresent) {
    blockers.push('precise_ledger_without_positive_observation_time');
  }
  if (itemLines.invalid > 0) blockers.push('invalid_item_lines');
  if (!complete) blockers.push('collection_truncated');
  if (!versionOk) blockers.push('unrecognized_root_version');
  if (itemLines.truncated) blockers.push('nested_inspection_truncated');
  markUnknownFields(projection, record, CHEST_FIELDS, ctx);

  const result = {
    ...projection,
    originalKey: key,
    worldId,
    dim,
    block,
    uses,
    ts,
    day,
    ledgerStatus,
    contents: {
      present: contentsPresent,
      itemLines,
      observedAt: contentsObservedAt,
      day: contentsDay,
      possiblyStale,
      capacity,
      freeSlots,
      unknownFields: contentsUnknownFields,
    },
    notes: [
      'empty_ledger_is_unknown_only_when_observation_time_is_not_positive',
      'recorded_empty_at_original_time_is_not_a_statement_about_the_present',
      'freeSlots_counts_empty_slots_not_full_stacks',
      'no_global_item_total_is_computed_across_containers',
    ],
    provenance: {
      source: 'world-memory.chests',
      worldScope: worldId ? 'record_worldId' : 'missing',
      dimScope: dim ? 'record_dim' : 'missing',
      time: contentsObservedAt !== null && contentsObservedAt > 0 ? 'record_contents_observedAt' : 'missing',
      lastUseTime: ts !== null ? 'record_ts_last_use' : 'missing',
      session: 'not_recorded',
      ledger: ledgerStatus,
    },
  };
  finishProjection(result, ctx, invalid, blockers, missing);
  return result;
}

const PLACED_FIELDS = new Set(['name', 'at']);

function projectPlaced(key: string, raw: unknown, ctx: Context, complete: boolean) {
  const record = isRecord(raw) ? raw : {};
  const locator = `/placed/byPos/${pointer(key)}`;
  const projection = baseProjection(raw, locator, 'placed', 'unique');
  const invalid: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');
  const name = stringOrNull(record.name);
  if (name === null) invalid.push('name_not_string');
  const at = numberOrNull(record.at);
  if (at === null) invalid.push('at_not_finite_number');
  markUnknownFields(projection, record, PLACED_FIELDS, ctx);
  const result = {
    ...projection,
    originalKey: key,
    name,
    at,
    provenance: {
      source: 'world-memory.placed',
      worldScope: 'absent',
      dimScope: 'absent',
      session: 'absent',
      time: 'absent',
      atSemantics: 'lru_serial_not_a_timestamp',
      coordinateKey: 'original_key_preserved',
    },
  };
  finishProjection(
    result,
    ctx,
    invalid,
    [...(complete ? [] : ['collection_truncated']), 'missing_record_scope', 'lru_serial_is_not_observation_time'],
    ['worldId', 'dim', 'session', 'observedAt'],
  );
  return result;
}

function projectVisit(key: string, raw: unknown, ctx: Context, complete: boolean) {
  const locator = `/worldMemory/visitedChunks/${pointer(key)}`;
  const projection = baseProjection({ key, value: raw }, locator, 'visit', 'unique');
  const invalid: string[] = [];
  const count = numberOrNull(raw);
  if (count === null) invalid.push('value_not_finite_count');
  if (key.length === 0) invalid.push('empty_original_key');
  const parts = key.split(':');
  const lastTwo = parts.slice(-2);
  const coordinateSuffix = parts.length >= 2 && lastTwo.every((part) => /^-?\d+$/.test(part))
    ? { cx: Number(lastTwo[0]), cz: Number(lastTwo[1]), decomposedWorldOrDim: false }
    : null;
  const result = {
    ...projection,
    originalKey: key,
    value: count,
    coordinateSuffix,
    provenance: {
      source: 'world-memory.visitedChunks',
      worldScope: 'opaque_key_only_not_decomposed',
      dimScope: 'opaque_key_only_not_decomposed',
      session: 'absent',
      time: 'absent',
      valueSemantics: 'entry_count_not_observedAt_or_visit_events',
    },
  };
  finishProjection(
    result,
    ctx,
    invalid,
    [...(complete ? [] : ['collection_truncated']), 'aggregate_visit_count_is_not_a_visit_timeline'],
    ['worldId', 'dim', 'session', 'observedAt', 'visitEvents'],
  );
  return result;
}

const TRAVEL_ENDPOINT_FIELDS = new Set(['id', 'worldId', 'dim', 'pos', 'kind', 'portalObserved', 'observedAt']);
const TRAVEL_CROSSING_FIELDS = new Set(['fromId', 'toId', 'ts', 'fromSession', 'toSession', 'fromObservation', 'toObservation']);
const PORTAL_KINDS = new Set(['nether_portal', 'end_portal', 'end_gateway']);

function projectEndpoint(raw: unknown, index: number, ctx: Context, complete: boolean, versionOk: boolean) {
  const record = isRecord(raw) ? raw : {};
  const projection = baseProjection(raw, `/travel/endpoints/${index}`, 'travel_endpoint', complete ? 'unique' : 'unverified_truncated');
  const invalid: string[] = [];
  const blockers: string[] = [];
  const missing: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');
  const id = isNonEmptyString(record.id) ? record.id : null;
  if (!id) invalid.push('id_not_nonempty_string');
  const worldId = isNonEmptyString(record.worldId) ? record.worldId : null;
  if (!worldId) invalid.push('worldId_not_nonempty_string');
  const dim = isNonEmptyString(record.dim) ? record.dim : null;
  if (!dim) invalid.push('dim_not_nonempty_string');
  if (!isVec3(record.pos)) invalid.push('pos_not_finite_vec3');
  const kind = stringOrNull(record.kind);
  if (!kind || !PORTAL_KINDS.has(kind)) invalid.push('kind_not_recognized');
  const portalObserved = typeof record.portalObserved === 'boolean' ? record.portalObserved : null;
  if (portalObserved === null) invalid.push('portalObserved_not_boolean');
  const observedAt = numberOrNull(record.observedAt);
  if (observedAt === null) { invalid.push('observedAt_not_finite_number'); missing.push('observedAt'); }
  else if (observedAt <= 0) blockers.push('observedAt_not_positive');
  if (!complete) blockers.push('collection_truncated');
  if (!versionOk) blockers.push('unrecognized_root_version');
  markUnknownFields(projection, record, TRAVEL_ENDPOINT_FIELDS, ctx);
  const result = {
    ...projection,
    id,
    worldId,
    dim,
    kind,
    portalObserved,
    observedAt,
    provenance: {
      source: 'travel-memory.endpoints',
      worldScope: worldId ? 'record_worldId' : 'missing',
      dimScope: dim ? 'record_dim' : 'missing',
      time: observedAt !== null ? 'record_observedAt' : 'missing',
      session: 'not_recorded',
      portalObserved: portalObserved === null ? 'missing' : 'record_boolean',
    },
  };
  finishProjection(result, ctx, invalid, blockers, missing);
  return result;
}

type EndpointRecord = ReturnType<typeof projectEndpoint>;

function referenceStatus(id: string | null, index: Map<string, EndpointRecord[]>, endpointsStatus: string, endpointsComplete: boolean) {
  if (id === null) return { id, status: 'missing_reference_id' as const, matchedLocators: [] as string[], resolvedEndpoints: [] as EndpointRecord[] };
  const matches = index.get(id) ?? [];
  const matchedLocators = matches.map((match) => match.locator);
  if (matches.length > 1) return { id, status: 'ambiguous' as const, matchedLocators, resolvedEndpoints: matches };
  if (matches.length === 1) {
    if (matches[0].shapeStatus === 'invalid') return { id, status: 'unresolved_invalid_endpoint' as const, matchedLocators, resolvedEndpoints: matches };
    if (endpointsComplete) return { id, status: 'resolved' as const, matchedLocators, resolvedEndpoints: matches };
    return { id, status: 'unverified_truncated' as const, matchedLocators, resolvedEndpoints: matches };
  }
  if (endpointsStatus === 'omitted' || endpointsStatus === 'invalid' || endpointsStatus === 'empty' || endpointsStatus === 'inspected') {
    return { id, status: 'unresolved' as const, matchedLocators, resolvedEndpoints: [] as EndpointRecord[] };
  }
  return { id, status: 'unverified_truncated' as const, matchedLocators, resolvedEndpoints: [] as EndpointRecord[] };
}

function projectCrossing(
  raw: unknown,
  index: number,
  ctx: Context,
  complete: boolean,
  versionOk: boolean,
  recordType: 'travel_traversal' | 'travel_gateway',
  endpointIndex: Map<string, EndpointRecord[]>,
  endpointsStatus: string,
  endpointsComplete: boolean,
) {
  const record = isRecord(raw) ? raw : {};
  const locator = `/travel/${recordType === 'travel_traversal' ? 'traversals' : 'gateways'}/${index}`;
  const projection = baseProjection(raw, locator, recordType, 'not_applicable');
  const invalid: string[] = [];
  const blockers: string[] = [];
  if (!isRecord(raw)) invalid.push('record_not_object');
  const fromId = isNonEmptyString(record.fromId) ? record.fromId : null;
  const toId = isNonEmptyString(record.toId) ? record.toId : null;
  if (!fromId) invalid.push('fromId_not_nonempty_string');
  if (!toId) invalid.push('toId_not_nonempty_string');
  const ts = numberOrNull(record.ts);
  if (ts === null) invalid.push('ts_not_finite_number');
  else if (ts <= 0) blockers.push('ts_not_positive');
  const fromSession = isNonEmptyString(record.fromSession) ? record.fromSession : null;
  const toSession = isNonEmptyString(record.toSession) ? record.toSession : null;
  if (!fromSession) invalid.push('fromSession_not_nonempty_string');
  if (!toSession) invalid.push('toSession_not_nonempty_string');
  const fromObservation = numberOrNull(record.fromObservation);
  const toObservation = numberOrNull(record.toObservation);
  if (fromObservation === null) invalid.push('fromObservation_not_finite_number');
  if (toObservation === null) invalid.push('toObservation_not_finite_number');

  const fromReference = referenceStatus(fromId, endpointIndex, endpointsStatus, endpointsComplete);
  const toReference = referenceStatus(toId, endpointIndex, endpointsStatus, endpointsComplete);
  for (const reference of [fromReference, toReference]) {
    if (reference.status === 'unresolved' || reference.status === 'unresolved_invalid_endpoint') {
      addIssue(ctx, 'dangling_portal_reference', locator, `endpoint "${reference.id}" is unresolved (${reference.status})`);
      blockers.push(`endpoint_reference_${reference.status}`);
    } else if (reference.status === 'ambiguous') {
      addIssue(ctx, 'ambiguous_portal_reference', locator, `endpoint "${reference.id}" matches ${reference.matchedLocators.length} records`);
      blockers.push('ambiguous_portal_reference');
    } else if (reference.status === 'unverified_truncated') {
      addIssue(ctx, 'unverified_portal_reference', locator, `endpoint "${reference.id}" could not be verified because endpoint inspection was truncated`);
      blockers.push('unverified_portal_reference');
    }
  }
  if (fromId !== null && fromId === toId) blockers.push('same_endpoint_reference');
  if (recordType === 'travel_gateway') {
    const resolved = [...fromReference.resolvedEndpoints, ...toReference.resolvedEndpoints];
    if (fromReference.status === 'resolved' && toReference.status === 'resolved' && resolved.some((endpoint) => endpoint.kind !== 'end_gateway')) {
      blockers.push('gateway_endpoint_kind_mismatch');
    }
  } else if (fromReference.status === 'resolved' && toReference.status === 'resolved') {
    const fromEndpoint = fromReference.resolvedEndpoints[0];
    const toEndpoint = toReference.resolvedEndpoints[0];
    if (fromEndpoint.worldId === toEndpoint.worldId && fromEndpoint.dim === toEndpoint.dim) blockers.push('endpoint_dimensions_not_distinct');
  }
  if (!complete) blockers.push('collection_truncated');
  if (!versionOk) blockers.push('unrecognized_root_version');
  markUnknownFields(projection, record, TRAVEL_CROSSING_FIELDS, ctx);
  const result = {
    ...projection,
    id: null,
    fromId,
    toId,
    ts,
    fromSession,
    toSession,
    fromObservation,
    toObservation,
    references: { from: fromReference, to: toReference },
    provenance: {
      source: `travel-memory.${recordType === 'travel_traversal' ? 'traversals' : 'gateways'}`,
      ownWorldScope: 'not_recorded',
      ownDimScope: 'not_recorded',
      scopeVia: 'fromId_and_toId_endpoint_references',
      time: ts !== null ? 'record_ts' : 'missing',
      session: fromSession !== null && toSession !== null ? 'record_fromSession_toSession' : 'missing',
      observationIds: 'sequence_not_timestamp',
      crossing: 'historical_record_only',
      returnLink: 'not_inferred',
    },
  };
  finishProjection(result, ctx, invalid, blockers, []);
  return result;
}

function versionReport(raw: unknown, source: 'worldMemory' | 'travel') {
  if (raw === undefined) {
    return source === 'worldMemory'
      ? { present: false, raw: null, rawType: 'absent', status: 'missing_treated_as_legacy_1', effectiveLegacyVersion: 1 }
      : { present: false, raw: null, rawType: 'absent', status: 'missing_unknown', effectiveLegacyVersion: null };
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (source === 'worldMemory' && raw >= 1 && raw <= 4) return { present: true, raw, rawType: 'number', status: 'known', effectiveLegacyVersion: raw };
    if (source === 'travel' && raw === 1) return { present: true, raw, rawType: 'number', status: 'known', effectiveLegacyVersion: 1 };
  }
  return {
    present: true,
    raw: typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw === null ? raw : null,
    rawType: Array.isArray(raw) ? 'array' : typeof raw,
    status: 'unknown',
    effectiveLegacyVersion: null,
  };
}

const WORLD_MEMORY_ROOT_FIELDS = new Set([
  'version', 'lastDeath', 'deaths', 'objective', 'digs', 'chests', 'chestOps', 'furnaces', 'gone', 'passages',
  'farms', 'lessons', 'hazards', 'visitedChunks', 'seen', 'landmarks', 'skillStats', 'goals', 'notes', 'worldId',
  'preferences', 'intents', 'decisions', 'projects', 'evidence', 'runtimePauseReasons',
]);
const PLACED_ROOT_FIELDS = new Set(['byPos']);
const TRAVEL_ROOT_FIELDS = new Set(['version', 'endpoints', 'traversals', 'gateways']);

function inspectWorldMemory(raw: unknown, ctx: Context) {
  if (!isRecord(raw)) {
    addIssue(ctx, 'invalid_root', '/worldMemory', 'world memory root is not an object');
    return {
      status: 'invalid',
      root: { status: 'invalid', reason: 'root_not_object', version: null, worldId: null, retainedFields: [] as string[], unknownFields: [] as string[] },
      collections: null,
    };
  }
  const version = versionReport(raw.version, 'worldMemory');
  const versionOk = version.status === 'known' || version.status === 'missing_treated_as_legacy_1';
  if (version.status === 'unknown') addIssue(ctx, 'unrecognized_root_version', '/worldMemory/version', 'root version is not a recognized world-memory version');
  const legacyVersion = version.effectiveLegacyVersion;
  const worldId = {
    present: raw.worldId !== undefined,
    value: typeof raw.worldId === 'string' ? raw.worldId : null,
    rawType: raw.worldId === undefined ? 'absent' : typeof raw.worldId,
    role: 'metadata_only_not_inferred_into_records',
  };

  const passages = inspectArrayCollection(raw.passages, '/worldMemory/passages', ctx, (item, index, complete) => projectPassage(item, index, ctx, complete, versionOk));
  applyDuplicateIds(passages.records, ctx);
  refreshCollectionCounts(passages);
  const landmarks = inspectArrayCollection(raw.landmarks, '/worldMemory/landmarks', ctx, (item, index, complete) => projectLandmark(item, index, ctx, complete, versionOk, legacyVersion));
  applyDuplicateIds(landmarks.records, ctx);
  refreshCollectionCounts(landmarks);
  const chests = inspectMapCollection(raw.chests, '/worldMemory/chests', ctx, (key, value, complete) => projectChest(key, value, ctx, complete, versionOk));
  const visitedChunks = inspectMapCollection(raw.visitedChunks, '/worldMemory/visitedChunks', ctx, (key, value, complete) => projectVisit(key, value, ctx, complete));

  const landmarksComplete = landmarks.status === 'inspected' || landmarks.status === 'empty';
  const bases = landmarks.records.filter((record) => record.kind === 'base');
  const basesReport = {
    subsetOf: 'landmarks',
    countedSeparately: false,
    status: landmarks.status,
    inspected: bases.length,
    total: landmarksComplete ? bases.length : null,
    invalid: bases.filter((record) => record.shapeStatus === 'invalid').length,
    candidateHistorical: bases.filter((record) => record.migrationStatus === 'candidate_historical').length,
    needsReview: bases.filter((record) => record.migrationStatus === 'needs_review').length,
  };

  const chestsAvailable = chests.status !== 'omitted' && chests.status !== 'invalid';
  const itemLines = {
    unit: 'item_lines',
    countedAsContainers: false,
    status: chests.status,
    total: !chestsAvailable || chests.truncated || chests.records.some((record) => !record.contents.itemLines.present || record.contents.itemLines.truncated)
      ? null
      : chests.records.reduce((sum, record) => sum + (record.contents.itemLines.total ?? 0), 0),
    inspected: chests.records.reduce((sum, record) => sum + record.contents.itemLines.inspected, 0),
    uninspected: !chestsAvailable || chests.truncated
      ? null
      : chests.records.reduce((sum, record) => sum + (record.contents.itemLines.uninspected ?? 0), 0),
    invalid: chests.records.reduce((sum, record) => sum + record.contents.itemLines.invalid, 0),
    truncated: chests.status === 'truncated' || chests.records.some((record) => record.contents.itemLines.truncated),
  };

  const handledRootFields = new Set(['version', 'worldId', 'passages', 'landmarks', 'chests', 'visitedChunks']);
  const rootFields = Object.keys(raw);
  const retainedRootFields = rootFields.filter((field) => !handledRootFields.has(field));
  const unknownRootFields = rootFields.filter((field) => !WORLD_MEMORY_ROOT_FIELDS.has(field));
  if (unknownRootFields.length) addIssue(ctx, 'unknown_root_fields', '/worldMemory', `unknown root fields retained: ${unknownRootFields.join(', ')}`);

  return {
    status: 'inspected',
    root: { status: 'inspected', version, worldId, retainedFields: retainedRootFields, unknownFields: unknownRootFields },
    collections: { passages, landmarks, bases: basesReport, chests: { ...chests, itemLines }, visitedChunks },
  };
}

function inspectPlaced(raw: unknown, ctx: Context) {
  if (!isRecord(raw)) {
    addIssue(ctx, 'invalid_root', '/placed', 'placed sidecar root is not an object');
    return {
      status: 'invalid',
      root: { status: 'invalid', reason: 'root_not_object', version: null, retainedFields: [] as string[], unknownFields: [] as string[] },
      collections: null,
    };
  }
  const byPos = inspectMapCollection(raw.byPos, '/placed/byPos', ctx, (key, value, complete) => projectPlaced(key, value, ctx, complete));
  const rootFields = Object.keys(raw);
  const unknownRootFields = rootFields.filter((field) => !PLACED_ROOT_FIELDS.has(field));
  if (unknownRootFields.length) addIssue(ctx, 'unknown_root_fields', '/placed', `unknown root fields retained: ${unknownRootFields.join(', ')}`);
  return {
    status: 'inspected',
    root: {
      status: 'inspected',
      version: { present: false, raw: null, rawType: 'not_applicable', status: 'not_applicable', effectiveLegacyVersion: null },
      retainedFields: rootFields.filter((field) => field !== 'byPos'),
      unknownFields: unknownRootFields,
    },
    collections: { byPos },
  };
}

function inspectTravel(raw: unknown, ctx: Context) {
  if (!isRecord(raw)) {
    addIssue(ctx, 'invalid_root', '/travel', 'travel memory root is not an object');
    return {
      status: 'invalid',
      root: { status: 'invalid', reason: 'root_not_object', version: null, retainedFields: [] as string[], unknownFields: [] as string[] },
      collections: null,
    };
  }
  const version = versionReport(raw.version, 'travel');
  const versionOk = version.status === 'known';
  if (!versionOk) addIssue(ctx, 'unrecognized_root_version', '/travel/version', 'travel version is not the recognized version 1');
  const endpoints = inspectArrayCollection(raw.endpoints, '/travel/endpoints', ctx, (item, index, complete) => projectEndpoint(item, index, ctx, complete, versionOk));
  applyDuplicateIds(endpoints.records, ctx);
  refreshCollectionCounts(endpoints);
  const endpointIndex = new Map<string, EndpointRecord[]>();
  for (const endpoint of endpoints.records) {
    if (!endpoint.id) continue;
    const group = endpointIndex.get(endpoint.id) ?? [];
    group.push(endpoint);
    endpointIndex.set(endpoint.id, group);
  }
  const endpointsComplete = endpoints.status === 'inspected' || endpoints.status === 'empty';
  const traversals = inspectArrayCollection(raw.traversals, '/travel/traversals', ctx, (item, index, complete) =>
    projectCrossing(item, index, ctx, complete, versionOk, 'travel_traversal', endpointIndex, endpoints.status, endpointsComplete));
  const gateways = inspectArrayCollection(raw.gateways, '/travel/gateways', ctx, (item, index, complete) =>
    projectCrossing(item, index, ctx, complete, versionOk, 'travel_gateway', endpointIndex, endpoints.status, endpointsComplete));
  const rootFields = Object.keys(raw);
  const unknownRootFields = rootFields.filter((field) => !TRAVEL_ROOT_FIELDS.has(field));
  if (unknownRootFields.length) addIssue(ctx, 'unknown_root_fields', '/travel', `unknown root fields retained: ${unknownRootFields.join(', ')}`);
  return {
    status: 'inspected',
    root: {
      status: 'inspected',
      version,
      retainedFields: rootFields.filter((field) => !['version', 'endpoints', 'traversals', 'gateways'].includes(field)),
      unknownFields: unknownRootFields,
    },
    collections: { endpoints, traversals, gateways },
  };
}

function countView(collection: { total: number | null; inspected: number; uninspected: number | null; invalid: number; candidateHistorical: number; needsReview: number; truncated: boolean } | null) {
  return collection === null ? null : {
    total: collection.total,
    inspected: collection.inspected,
    uninspected: collection.uninspected,
    invalid: collection.invalid,
    candidateHistorical: collection.candidateHistorical,
    needsReview: collection.needsReview,
    truncated: collection.truncated,
  };
}

function normalizeOptions(options: PreflightOptions) {
  const maxInspectedRecords = options.maxInspectedRecords ?? DEFAULT_MAX_INSPECTED_RECORDS;
  const maxIssueDetails = options.maxIssueDetails ?? DEFAULT_MAX_ISSUE_DETAILS;
  const maxNestedItemsPerRecord = options.maxNestedItemsPerRecord ?? DEFAULT_MAX_NESTED_ITEMS_PER_RECORD;
  if (!Number.isSafeInteger(maxInspectedRecords) || maxInspectedRecords <= 0) throw new RangeError('maxInspectedRecords must be a positive safe integer');
  if (!Number.isSafeInteger(maxIssueDetails) || maxIssueDetails < 0) throw new RangeError('maxIssueDetails must be a non-negative safe integer');
  if (!Number.isSafeInteger(maxNestedItemsPerRecord) || maxNestedItemsPerRecord < 0) throw new RangeError('maxNestedItemsPerRecord must be a non-negative safe integer');
  return { maxInspectedRecords, maxIssueDetails, maxNestedItemsPerRecord };
}

/**
 * Inspect legacy spatial memory without touching it.
 *
 * Each provided source is validated once at this boundary. The returned report
 * is bounded by record, nested-item and detailed-issue budgets. Omitted sources
 * are reported explicitly; absence is not discovered from configuration,
 * environment variables, sibling files or a live directory.
 */
export function inspectLegacySpatialMemory(
  input: { worldMemory?: unknown; placed?: unknown; travel?: unknown },
  options: PreflightOptions = {},
) {
  const normalized = normalizeOptions(options);
  const ctx: Context = {
    options: normalized,
    issues: [],
    issueTotal: 0,
    recordsRemaining: normalized.maxInspectedRecords,
    nestedTruncations: 0,
  };

  const worldMemory = input.worldMemory === undefined ? { status: 'omitted', root: null, collections: null } : inspectWorldMemory(input.worldMemory, ctx);
  const placed = input.placed === undefined ? { status: 'omitted', root: null, collections: null } : inspectPlaced(input.placed, ctx);
  const travel = input.travel === undefined ? { status: 'omitted', root: null, collections: null } : inspectTravel(input.travel, ctx);

  const sources = { worldMemory, placed, travel };
  const namedCollections = [
    ['worldMemory.passages', worldMemory.collections?.passages ?? null],
    ['worldMemory.landmarks', worldMemory.collections?.landmarks ?? null],
    ['worldMemory.chests', worldMemory.collections?.chests ?? null],
    ['worldMemory.visitedChunks', worldMemory.collections?.visitedChunks ?? null],
    ['placed.byPos', placed.collections?.byPos ?? null],
    ['travel.endpoints', travel.collections?.endpoints ?? null],
    ['travel.traversals', travel.collections?.traversals ?? null],
    ['travel.gateways', travel.collections?.gateways ?? null],
  ] as const;
  const truncatedCollections = namedCollections.filter(([, collection]) => collection?.truncated).map(([name]) => name);
  const invalidCollections = namedCollections.filter(([, collection]) => collection?.status === 'invalid').map(([name]) => name);
  const uninspectedRecords = namedCollections.reduce((sum, [, collection]) => sum + (collection?.uninspected ?? 0), 0);
  const omittedSources = Object.entries(sources).filter(([, source]) => source.status === 'omitted').map(([name]) => name);
  const suppliedSources = Object.entries(sources).filter(([, source]) => source.status !== 'omitted').map(([name]) => name);
  const invalidSources = Object.entries(sources).filter(([, source]) => source.status === 'invalid').map(([name]) => name);
  const unknownVersions = Object.entries(sources).flatMap(([name, source]) => {
    const version = source.root?.version;
    return version && version.status === 'unknown' ? [{ source: name, status: version.status, raw: version.raw }] : [];
  });
  const recordBudgetExhausted = ctx.recordsRemaining === 0 && truncatedCollections.length > 0;
  const completeCoverage = invalidSources.length === 0
    && invalidCollections.length === 0
    && truncatedCollections.length === 0
    && ctx.nestedTruncations === 0;

  const issueSummary = {
    total: ctx.issueTotal,
    detailed: ctx.issues.length,
    omitted: ctx.issueTotal - ctx.issues.length,
    maxDetailed: normalized.maxIssueDetails,
  };

  const summaryCounts = {
    passages: countView(worldMemory.collections?.passages ?? null),
    landmarks: countView(worldMemory.collections?.landmarks ?? null),
    bases: worldMemory.collections?.bases ?? null,
    chests: countView(worldMemory.collections?.chests ?? null),
    chestItemLines: worldMemory.collections?.chests?.itemLines ?? null,
    placed: countView(placed.collections?.byPos ?? null),
    visits: countView(worldMemory.collections?.visitedChunks ?? null),
    travelEndpoints: countView(travel.collections?.endpoints ?? null),
    travelTraversals: countView(travel.collections?.traversals ?? null),
    travelGateways: countView(travel.collections?.gateways ?? null),
  };

  return {
    reportVersion: REPORT_VERSION,
    reportKind: 'legacy-spatial-memory-preflight',
    readOnly: true,
    migration: {
      performed: false,
      status: 'analysis_only',
      note: 'candidate_historical is not import readiness and makes no claim about the present world',
    },
    options: normalized,
    coverage: {
      suppliedSources,
      omittedSources,
      invalidSources,
      completeCoverage,
      recordBudget: {
        max: normalized.maxInspectedRecords,
        used: normalized.maxInspectedRecords - ctx.recordsRemaining,
        remaining: ctx.recordsRemaining,
        exhausted: recordBudgetExhausted,
      },
      recordsInspected: namedCollections.reduce((sum, [, collection]) => sum + (collection?.inspected ?? 0), 0),
      uninspectedRecords,
      truncatedCollections,
      invalidCollections,
      nestedTruncations: ctx.nestedTruncations,
      unknownVersions,
    },
    sources,
    summary: { counts: summaryCounts, issues: issueSummary },
    issues: ctx.issues,
    limitations: [
      'read-only projection; source bytes are not rewritten',
      'JSON-pointer locators are addresses, not invented stable IDs',
      'unknown fields are reported for retention, not migrated or normalized',
      'root.worldId is metadata only; per-record world, dimension, session and time are never inferred',
      'a stored crossing is historical and does not prove a destination or a return link now',
    ],
  };
}
