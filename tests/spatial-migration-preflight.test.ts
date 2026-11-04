import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectLegacySpatialMemory } from '../src/spatial/legacy-preflight.ts';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) assert.fail(message);
  return value;
}

const passage = (overrides: Record<string, unknown> = {}) => ({
  id: 'psg_1',
  worldId: 'world-a',
  dim: 'overworld',
  kind: 'dug',
  entrances: [{ x: 1, y: 64, z: 1 }],
  path: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }, { x: 3, y: 64, z: 1 }],
  links: [{ a: { x: 1, y: 64, z: 1 }, b: { x: 2, y: 64, z: 1 } }],
  deepestY: 40,
  dug: 12,
  ores: { iron_ore: 2 },
  createdAt: 1000,
  lastUsedAt: 2000,
  uses: 3,
  ...overrides,
});

const endpoint = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  worldId: 'world-a',
  dim: 'overworld',
  pos: { x: 10, y: 64, z: 10 },
  kind: 'nether_portal',
  portalObserved: true,
  observedAt: 9000,
  ...overrides,
});

const crossing = (overrides: Record<string, unknown> = {}) => ({
  fromId: 'p1',
  toId: 'p2',
  ts: 9200,
  fromSession: 'session-a',
  toSession: 'session-b',
  fromObservation: 11,
  toObservation: 12,
  ...overrides,
});

const chest = (overrides: Record<string, unknown> = {}) => ({
  worldId: 'world-a',
  dim: 'overworld',
  pos: { x: 1, y: 64, z: 1 },
  block: 'chest',
  uses: 2,
  ts: 5000,
  day: 3,
  note: 'ores',
  contents: { items: [{ name: 'iron_ore', count: 4 }], observedAt: 6000 },
  ...overrides,
});

function validLegacyFixture() {
  return {
    worldMemory: {
      version: 4,
      worldId: 'root-world',
      passages: [passage({ customField: { keep: true } })],
      landmarks: [
        {
          id: 'base_1', kind: 'base', label: 'home', dim: 'overworld', pos: { x: 0, y: 64, z: 0 },
          ts: 3000, worldId: 'world-a', primary: true, observedAt: 3100,
        },
        {
          id: 'res_1', kind: 'resource', label: 'iron', dim: 'overworld', pos: { x: 5, y: 40, z: 5 },
          ts: 4000,
        },
      ],
      chests: {
        'world-a:overworld:1,64,1': chest(),
        'world-a:overworld:2,64,1': chest({
          pos: { x: 2, y: 64, z: 1 },
          contents: { items: [], observedAt: 6100, possiblyStale: false, capacity: 27, freeSlots: 27 },
        }),
        'world-a:overworld:3,64,1': chest({
          pos: { x: 3, y: 64, z: 1 },
          contents: { items: [], observedAt: 0, possiblyStale: true },
        }),
        'world-a:overworld:4,64,1': chest({
          pos: { x: 4, y: 64, z: 1 },
          contents: { items: [{ name: 'dirt', count: 4 }], observedAt: 6200, possiblyStale: true },
        }),
        'legacy:overworld:5,64,1': {
          dim: 'overworld', pos: { x: 5, y: 64, z: 1 }, block: 'chest', uses: 1, ts: 7000,
          items: [{ name: 'coal', count: 1 }],
        },
      },
      visitedChunks: { 'my:world:overworld:1:-2': 7, '3:4': 1 },
      farms: [{ id: 'farm_1' }],
    },
    placed: { byPos: { '1,64,1': { name: 'stone', at: 42 } } },
    travel: {
      version: 1,
      endpoints: [
        endpoint(),
        endpoint({ id: 'p2', dim: 'the_nether', pos: { x: 2, y: 64, z: 2 }, portalObserved: false, observedAt: 9100 }),
        endpoint({ id: 'g1', dim: 'the_end', pos: { x: 20, y: 64, z: 20 }, kind: 'end_gateway', observedAt: 9300 }),
        endpoint({ id: 'g2', dim: 'the_end', pos: { x: 200, y: 64, z: 200 }, kind: 'end_gateway', observedAt: 9400 }),
      ],
      traversals: [crossing()],
      gateways: [crossing({ fromId: 'g1', toId: 'g2', ts: 9500 })],
    },
  };
}

test('known shapes preserve original IDs, keys, times and scope without root inference', () => {
  const fixture = validLegacyFixture();
  const report = inspectLegacySpatialMemory(fixture);
  assert.equal(report.reportVersion, 1);
  assert.equal(report.reportKind, 'legacy-spatial-memory-preflight');
  assert.equal(report.readOnly, true);
  assert.equal(report.migration.performed, false);
  assert.deepEqual(report.options, { maxInspectedRecords: 10_000, maxIssueDetails: 100, maxNestedItemsPerRecord: 64 });

  const world = report.sources.worldMemory;
  assert.equal(world.status, 'inspected');
  const worldRoot = must(world.root, 'world root');
  const worldVersion = must(worldRoot.version, 'world version');
  const worldIdMeta = must(worldRoot.worldId, 'worldId metadata');
  const worldCollections = must(world.collections, 'world collections');
  assert.equal(worldVersion.status, 'known');
  assert.equal(worldVersion.raw, 4);
  assert.equal(worldIdMeta.value, 'root-world');
  assert.equal(worldIdMeta.role, 'metadata_only_not_inferred_into_records');
  assert.ok(worldRoot.retainedFields.includes('farms'));

  const passages = worldCollections.passages;
  assert.equal(passages.status, 'inspected');
  assert.equal(passages.total, 1);
  assert.equal(passages.inspected, 1);
  assert.equal(passages.uninspected, 0);
  assert.equal(passages.invalid, 0);
  const projectedPassage = passages.records[0];
  assert.equal(projectedPassage.id, 'psg_1');
  assert.equal(projectedPassage.worldId, 'world-a');
  assert.equal(projectedPassage.dim, 'overworld');
  assert.equal(projectedPassage.createdAt, 1000);
  assert.equal(projectedPassage.lastUsedAt, 2000);
  assert.equal(projectedPassage.uses, 3);
  assert.equal(projectedPassage.migrationStatus, 'candidate_historical');
  assert.deepEqual(projectedPassage.unknownFields, ['customField']);
  assert.ok(projectedPassage.retainedFields.includes('customField'));
  assert.equal(projectedPassage.geometry.entrances.total, 1);
  assert.equal(projectedPassage.geometry.path.total, 3);
  assert.equal(projectedPassage.geometry.links.total, 1);
  assert.equal(projectedPassage.geometry.links.certifiedTraversals, 0);
  assert.equal(projectedPassage.geometry.links.traversalEvidence, 'unverified');
  assert.equal(projectedPassage.geometry.traversalEvidence, 'links_are_not_certified_traversals');
  assert.equal(projectedPassage.provenance.session, 'not_recorded');

  const landmarks = worldCollections.landmarks;
  assert.equal(landmarks.total, 2);
  assert.equal(landmarks.inspected, 2);
  assert.equal(worldCollections.bases.subsetOf, 'landmarks');
  assert.equal(worldCollections.bases.countedSeparately, false);
  assert.equal(worldCollections.bases.inspected, 1);
  assert.equal(worldCollections.bases.total, 1);
  assert.equal(report.summary.counts.landmarks?.total, 2);
  assert.equal(report.summary.counts.bases?.total, 1);
  const base = landmarks.records.find((record) => record.id === 'base_1');
  const resource = landmarks.records.find((record) => record.id === 'res_1');
  assert.ok(base && resource);
  assert.equal(base.ts, 3000);
  assert.equal(base.observedAt, 3100);
  assert.equal(base.migrationStatus, 'candidate_historical');
  assert.equal(resource.worldId, null);
  assert.equal(resource.worldId === 'root-world', false);
  assert.ok(resource.reviewReasons.includes('missing_record_world_scope'));
  assert.equal(resource.migrationStatus, 'needs_review');

  const chests = worldCollections.chests;
  assert.equal(chests.total, 5);
  assert.equal(chests.inspected, 5);
  const precise = chests.records.find((record) => record.originalKey === 'world-a:overworld:1,64,1');
  const recordedEmpty = chests.records.find((record) => record.originalKey === 'world-a:overworld:2,64,1');
  const unknown = chests.records.find((record) => record.originalKey === 'world-a:overworld:3,64,1');
  const stale = chests.records.find((record) => record.originalKey === 'world-a:overworld:4,64,1');
  const legacy = chests.records.find((record) => record.originalKey === 'legacy:overworld:5,64,1');
  assert.ok(precise && recordedEmpty && unknown && stale && legacy);
  assert.equal(precise.ledgerStatus, 'recorded_nonempty_at_original_time');
  assert.equal(precise.contents.observedAt, 6000);
  assert.equal(precise.contents.itemLines.total, 1);
  assert.equal(recordedEmpty.ledgerStatus, 'recorded_empty_at_original_time');
  assert.equal(recordedEmpty.contents.freeSlots, 27);
  assert.equal(unknown.ledgerStatus, 'unknown');
  assert.equal(unknown.contents.observedAt, 0);
  assert.equal(stale.ledgerStatus, 'stale_unconfirmed');
  assert.equal(stale.contents.possiblyStale, true);
  assert.equal(legacy.ledgerStatus, 'legacy_imprecise');
  assert.equal(legacy.worldId, null);
  assert.equal(legacy.contents.itemLines.present, false);
  assert.equal(chests.itemLines.total, null);
  assert.equal(chests.itemLines.inspected, 2);
  assert.equal(JSON.stringify(chests).includes('iron_ore'), false);

  const visits = worldCollections.visitedChunks;
  assert.equal(visits.total, 2);
  const scopedVisit = visits.records.find((record) => record.originalKey === 'my:world:overworld:1:-2');
  const unscopedVisit = visits.records.find((record) => record.originalKey === '3:4');
  assert.ok(scopedVisit && unscopedVisit);
  assert.equal(scopedVisit.value, 7);
  assert.deepEqual(scopedVisit.coordinateSuffix, { cx: 1, cz: -2, decomposedWorldOrDim: false });
  assert.deepEqual(unscopedVisit.coordinateSuffix, { cx: 3, cz: 4, decomposedWorldOrDim: false });
  assert.equal(scopedVisit.provenance.valueSemantics, 'entry_count_not_observedAt_or_visit_events');
  assert.equal(scopedVisit.migrationStatus, 'needs_review');

  const placedCollections = must(report.sources.placed.collections, 'placed collections');
  const placed = placedCollections.byPos;
  assert.equal(placed.total, 1);
  const placedRecord = placed.records[0];
  assert.equal(placedRecord.originalKey, '1,64,1');
  assert.equal(placedRecord.at, 42);
  assert.equal(placedRecord.provenance.atSemantics, 'lru_serial_not_a_timestamp');
  assert.equal('observedAt' in placedRecord, false);
  assert.ok(placedRecord.missingProvenance.includes('observedAt'));
  assert.equal(placedRecord.migrationStatus, 'needs_review');

  const travel = report.sources.travel;
  assert.equal(travel.status, 'inspected');
  const travelRoot = must(travel.root, 'travel root');
  const travelVersion = must(travelRoot.version, 'travel version');
  const travelCollections = must(travel.collections, 'travel collections');
  assert.equal(travelVersion.status, 'known');
  assert.equal(travelCollections.endpoints.total, 4);
  assert.equal(travelCollections.endpoints.invalid, 0);
  assert.equal(travelCollections.traversals.total, 1);
  assert.equal(travelCollections.traversals.records[0].migrationStatus, 'candidate_historical');
  assert.equal(travelCollections.gateways.records[0].migrationStatus, 'candidate_historical');
  const traversal = travelCollections.traversals.records[0];
  assert.equal(traversal.fromObservation, 11);
  assert.equal(traversal.toObservation, 12);
  assert.equal(traversal.references.from.status, 'resolved');
  assert.equal(traversal.provenance.ownWorldScope, 'not_recorded');
  assert.equal(traversal.provenance.returnLink, 'not_inferred');
  assert.equal(traversal.provenance.observationIds, 'sequence_not_timestamp');
  assert.equal('worldId' in traversal, false);
  assert.equal(travelCollections.traversals.records.length, 1);
  assert.equal(travelCollections.gateways.records.length, 1);

  assert.equal(report.coverage.completeCoverage, true);
  assert.deepEqual(report.coverage.omittedSources, []);
  assert.equal(report.coverage.recordBudget.used, 17);
});

test('omitted, empty, invalid collection and invalid roots are distinct', () => {
  const omitted = inspectLegacySpatialMemory({});
  assert.equal(omitted.sources.worldMemory.status, 'omitted');
  assert.equal(omitted.sources.placed.status, 'omitted');
  assert.equal(omitted.sources.travel.status, 'omitted');
  assert.deepEqual(omitted.coverage.omittedSources, ['worldMemory', 'placed', 'travel']);
  assert.equal(omitted.summary.counts.passages, null);
  assert.equal(omitted.summary.counts.bases, null);
  assert.equal(omitted.summary.counts.chestItemLines, null);

  const empty = inspectLegacySpatialMemory({ worldMemory: { version: 4, worldId: 'w', passages: [] } });
  const emptyCollections = must(empty.sources.worldMemory.collections, 'empty collections');
  assert.equal(emptyCollections.passages.status, 'empty');
  assert.equal(emptyCollections.passages.total, 0);
  assert.equal(emptyCollections.landmarks.status, 'omitted');
  assert.equal(emptyCollections.chests.status, 'omitted');
  assert.equal(emptyCollections.visitedChunks.status, 'omitted');
  assert.equal(empty.summary.counts.bases?.status, 'omitted');
  assert.equal(empty.summary.counts.bases?.total, null);
  assert.equal(empty.summary.counts.chestItemLines?.status, 'omitted');
  assert.equal(empty.summary.counts.chestItemLines?.total, null);
  assert.equal(empty.summary.counts.chestItemLines?.uninspected, null);

  const invalidCollection = inspectLegacySpatialMemory({ worldMemory: { version: 4, worldId: 'w', passages: {} } });
  const invalidCollections = must(invalidCollection.sources.worldMemory.collections, 'invalid collection root');
  assert.equal(invalidCollections.passages.status, 'invalid');
  assert.equal(invalidCollections.passages.reason, 'expected_array');
  assert.equal(invalidCollection.coverage.completeCoverage, false);

  const invalidRoot = inspectLegacySpatialMemory({ worldMemory: null });
  assert.equal(invalidRoot.sources.worldMemory.status, 'invalid');
  const invalidRootMetadata = must(invalidRoot.sources.worldMemory.root, 'invalid root');
  assert.equal(invalidRootMetadata.status, 'invalid');
  assert.equal(invalidRoot.sources.worldMemory.collections, null);
  assert.deepEqual(invalidRoot.coverage.invalidSources, ['worldMemory']);

  const invalidPlaced = inspectLegacySpatialMemory({ placed: { byPos: [] } });
  const invalidPlacedCollections = must(invalidPlaced.sources.placed.collections, 'invalid placed collections');
  assert.equal(invalidPlacedCollections.byPos.status, 'invalid');
  assert.equal(invalidPlacedCollections.byPos.reason, 'expected_object');

  const invalidTravel = inspectLegacySpatialMemory({ travel: { version: 1, endpoints: {} } });
  const invalidTravelCollections = must(invalidTravel.sources.travel.collections, 'invalid travel collections');
  assert.equal(invalidTravelCollections.endpoints.status, 'invalid');
  assert.equal(invalidTravel.coverage.completeCoverage, false);

  const emptyTravel = inspectLegacySpatialMemory({ travel: { version: 1, endpoints: [], traversals: [], gateways: [] } });
  const emptyTravelCollections = must(emptyTravel.sources.travel.collections, 'empty travel collections');
  assert.equal(emptyTravelCollections.endpoints.status, 'empty');
  assert.equal(emptyTravelCollections.traversals.status, 'empty');
  assert.equal(emptyTravelCollections.gateways.status, 'empty');
});

test('duplicate IDs and dangling or ambiguous references are never resolved by first match', () => {
  const report = inspectLegacySpatialMemory({
    travel: {
      version: 1,
      endpoints: [
        endpoint({ id: 'dup' }),
        endpoint({ id: 'dup', dim: 'the_nether' }),
        endpoint({ id: 'unique', dim: 'the_nether' }),
      ],
      traversals: [
        crossing({ fromId: 'missing', toId: 'unique' }),
        crossing({ fromId: 'dup', toId: 'unique', ts: 9300 }),
      ],
      gateways: [crossing({ fromId: 'absent_gateway', toId: 'unique', ts: 9400 })],
    },
  });
  const travelCollections = must(report.sources.travel.collections, 'travel collections');
  const endpoints = travelCollections.endpoints;
  const duplicates = endpoints.records.filter((record) => record.id === 'dup');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((record) => record.identityStatus === 'duplicate'));
  assert.ok(duplicates.every((record) => record.migrationStatus === 'needs_review'));
  assert.equal(endpoints.candidateHistorical, 1);

  const traversals = travelCollections.traversals;
  assert.equal(traversals.records.length, 2);
  const unresolved = traversals.records[0];
  const ambiguous = traversals.records[1];
  assert.equal(unresolved.references.from.status, 'unresolved');
  assert.equal(unresolved.migrationStatus, 'needs_review');
  assert.equal(ambiguous.references.from.status, 'ambiguous');
  assert.equal(ambiguous.references.from.matchedLocators.length, 2);
  assert.equal(ambiguous.migrationStatus, 'needs_review');
  assert.equal(traversals.candidateHistorical, 0);

  const gateway = travelCollections.gateways.records[0];
  assert.equal(gateway.references.from.status, 'unresolved');
  assert.equal(gateway.migrationStatus, 'needs_review');

  const issueCodes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(issueCodes.has('duplicate_id'));
  assert.ok(issueCodes.has('dangling_portal_reference'));
  assert.ok(issueCodes.has('ambiguous_portal_reference'));
});

test('legacy versions, unknown fields and base landmarks are reported without rewriting or filtering', () => {
  const legacy = inspectLegacySpatialMemory({
    worldMemory: {
      version: 1,
      worldId: 'w',
      passages: [passage()],
      landmarks: [{ id: 'base_v1', kind: 'base', label: 'home', dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, ts: 123, worldId: 'w' }],
      futureRootField: { retained: true },
    },
  });
  const legacyRoot = must(legacy.sources.worldMemory.root, 'legacy root');
  const legacyVersion = must(legacyRoot.version, 'legacy version');
  const legacyCollections = must(legacy.sources.worldMemory.collections, 'legacy collections');
  assert.equal(legacyVersion.status, 'known');
  assert.equal(legacyVersion.raw, 1);
  assert.deepEqual(legacyRoot.unknownFields, ['futureRootField']);
  assert.ok(legacyRoot.retainedFields.includes('futureRootField'));
  const legacyBase = legacyCollections.landmarks.records[0];
  assert.equal(legacyBase.id, 'base_v1');
  assert.equal(legacyBase.migrationStatus, 'needs_review');
  assert.ok(legacyBase.reviewReasons.includes('legacy_landmark_provenance_may_include_findblocks_data'));
  assert.equal(legacyBase.observedAt, null);
  assert.equal(legacyBase.ts, 123);
  assert.equal(legacyCollections.landmarks.total, 1);
  assert.ok(legacy.issues.some((issue) => issue.code === 'unknown_root_fields'));

  const unknownVersion = inspectLegacySpatialMemory({
    worldMemory: { version: 99, worldId: 'w', passages: [passage()], futureRootField: 1 },
    travel: { version: 2, endpoints: [endpoint()] },
  });
  const unknownWorldRoot = must(unknownVersion.sources.worldMemory.root, 'unknown world root');
  const unknownWorldVersion = must(unknownWorldRoot.version, 'unknown world version');
  const unknownWorldCollections = must(unknownVersion.sources.worldMemory.collections, 'unknown world collections');
  assert.equal(unknownWorldVersion.status, 'unknown');
  assert.equal(unknownWorldVersion.raw, 99);
  const passageRecord = unknownWorldCollections.passages.records[0];
  assert.equal(passageRecord.migrationStatus, 'needs_review');
  assert.ok(passageRecord.reviewReasons.includes('unrecognized_root_version'));
  const unknownTravelRoot = must(unknownVersion.sources.travel.root, 'unknown travel root');
  const unknownTravelVersion = must(unknownTravelRoot.version, 'unknown travel version');
  const unknownTravelCollections = must(unknownVersion.sources.travel.collections, 'unknown travel collections');
  assert.equal(unknownTravelVersion.status, 'unknown');
  assert.equal(unknownTravelCollections.endpoints.records[0].migrationStatus, 'needs_review');
  assert.deepEqual(unknownVersion.coverage.unknownVersions, [
    { source: 'worldMemory', status: 'unknown', raw: 99 },
    { source: 'travel', status: 'unknown', raw: 2 },
  ]);
});

test('record, nested-item and detailed-issue budgets bound work and report truncation truthfully', () => {
  const passages = Array.from({ length: 5 }, (_, index) => passage({
    id: `psg_${index}`,
    path: Array.from({ length: 5 }, (__, point) => ({ x: point, y: 40, z: index })),
  }));
  const report = inspectLegacySpatialMemory(
    { worldMemory: { version: 4, worldId: 'w', passages, landmarks: [{ id: 'base_1', kind: 'base', label: 'home', dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, ts: 1, worldId: 'w' }] } },
    { maxInspectedRecords: 2, maxNestedItemsPerRecord: 2, maxIssueDetails: 1 },
  );
  const budgetCollections = must(report.sources.worldMemory.collections, 'budget collections');
  const passageCollection = budgetCollections.passages;
  assert.equal(passageCollection.status, 'truncated');
  assert.equal(passageCollection.total, 5);
  assert.equal(passageCollection.inspected, 2);
  assert.equal(passageCollection.uninspected, 3);
  assert.equal(passageCollection.records.length, 2);
  assert.equal(passageCollection.candidateHistorical, 0);
  assert.equal(passageCollection.records[0].migrationStatus, 'needs_review');
  assert.ok(passageCollection.records[0].reviewReasons.includes('collection_truncated'));
  assert.ok(passageCollection.records[0].reviewReasons.includes('nested_inspection_truncated'));
  assert.equal(passageCollection.records[0].geometry.path.total, 5);
  assert.equal(passageCollection.records[0].geometry.path.inspected, 2);
  assert.equal(passageCollection.records[0].geometry.path.uninspected, 3);
  assert.equal(passageCollection.records[0].geometry.path.truncated, true);

  const landmarkCollection = budgetCollections.landmarks;
  assert.equal(landmarkCollection.status, 'truncated');
  assert.equal(landmarkCollection.total, 1);
  assert.equal(landmarkCollection.inspected, 0);
  assert.equal(landmarkCollection.uninspected, 1);
  assert.equal(landmarkCollection.records.length, 0);

  assert.equal(report.coverage.recordBudget.max, 2);
  assert.equal(report.coverage.recordBudget.used, 2);
  assert.equal(report.coverage.recordBudget.remaining, 0);
  assert.equal(report.coverage.recordBudget.exhausted, true);
  assert.equal(report.coverage.uninspectedRecords, 4);
  assert.equal(report.coverage.completeCoverage, false);
  assert.deepEqual(report.coverage.truncatedCollections, ['worldMemory.passages', 'worldMemory.landmarks']);
  assert.equal(report.issues.length, 1);
  assert.ok(report.summary.issues.total > report.summary.issues.detailed);
  assert.ok(report.summary.issues.omitted > 0);
});

test('malformed nested geometry and item lines invalidate the record without normalizing it', () => {
  const report = inspectLegacySpatialMemory({
    worldMemory: {
      version: 4,
      worldId: 'w',
      passages: [passage({ path: [{ x: 1, y: 2, z: 3 }, { x: 'bad' }] })],
      chests: {
        'w:overworld:1,64,1': chest({
          worldId: 'w',
          contents: { items: [{ name: 'iron_ore', count: 'many' }], observedAt: 6000 },
        }),
      },
    },
  });
  const collections = must(report.sources.worldMemory.collections, 'malformed collections');
  const passageRecord = collections.passages.records[0];
  assert.equal(passageRecord.shapeStatus, 'invalid');
  assert.equal(passageRecord.migrationStatus, 'needs_review');
  assert.ok(passageRecord.invalidReasons.includes('path_contains_invalid_vec3'));
  assert.equal(passageRecord.geometry.path.invalid, 1);
  assert.equal(collections.passages.invalid, 1);

  const chestRecord = collections.chests.records[0];
  assert.equal(chestRecord.shapeStatus, 'invalid');
  assert.equal(chestRecord.migrationStatus, 'needs_review');
  assert.equal(chestRecord.contents.itemLines.invalid, 1);
  assert.equal(collections.chests.invalid, 1);
});

test('explicit options are validated once at the input boundary', () => {
  assert.throws(() => inspectLegacySpatialMemory({}, { maxInspectedRecords: 0 }), RangeError);
  assert.throws(() => inspectLegacySpatialMemory({}, { maxInspectedRecords: 1.5 }), RangeError);
  assert.throws(() => inspectLegacySpatialMemory({}, { maxIssueDetails: -1 }), RangeError);
  assert.throws(() => inspectLegacySpatialMemory({}, { maxNestedItemsPerRecord: -1 }), RangeError);
  const zeroDetails = inspectLegacySpatialMemory({ worldMemory: { version: 4, worldId: 'w', passages: {} } }, { maxIssueDetails: 0 });
  assert.equal(zeroDetails.issues.length, 0);
  assert.ok(zeroDetails.summary.issues.total > 0);
  assert.equal(zeroDetails.summary.issues.omitted, zeroDetails.summary.issues.total);
});

test('a huge nested geometry array cannot defeat the record budget', () => {
  const hugePath = Array.from({ length: 5000 }, (_, index) => ({ x: index, y: 20, z: 0 }));
  const report = inspectLegacySpatialMemory(
    { worldMemory: { version: 4, worldId: 'w', passages: [passage({ path: hugePath, entrances: [] })] } },
    { maxInspectedRecords: 1, maxNestedItemsPerRecord: 3 },
  );
  const hugeCollections = must(report.sources.worldMemory.collections, 'huge collections');
  const collection = hugeCollections.passages;
  assert.equal(collection.records.length, 1);
  assert.equal(collection.records[0].geometry.path.total, 5000);
  assert.equal(collection.records[0].geometry.path.inspected, 3);
  assert.equal(collection.records[0].geometry.path.uninspected, 4997);
  assert.equal(collection.records[0].geometry.path.truncated, true);
  assert.equal(collection.records[0].migrationStatus, 'needs_review');
  assert.equal(report.coverage.recordBudget.used, 1);
});

test('deep-frozen input stays byte-for-byte unchanged and is never pulled from sibling sources', () => {
  const fixture = deepFreeze(validLegacyFixture());
  const before = JSON.stringify(fixture);
  const worldOnly = inspectLegacySpatialMemory({ worldMemory: fixture.worldMemory });
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(worldOnly.sources.placed.status, 'omitted');
  assert.equal(worldOnly.sources.travel.status, 'omitted');
  const worldOnlyCollections = must(worldOnly.sources.worldMemory.collections, 'world collections');
  assert.equal(worldOnlyCollections.passages.records[0].worldId, 'world-a');
});

const cliScript = fileURLToPath(new URL('../scripts/spatial-migration-preflight.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');

function cliEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(DATA_DIR|MEMORY_PROVIDER|HINDSIGHT|OPENAI|DEEPSEEK|LLM|CURIO)/.test(key) || /API_KEY|BASE_URL/.test(key)) delete env[key];
  }
  return env;
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', tsx, cliScript, ...args], { cwd, env: cliEnvironment(), encoding: 'utf8' });
}

function tempDirectory(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spatial-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('CLI reads only named sources, hashes exact bytes and leaves the directory unchanged', (t) => {
  const directory = tempDirectory(t);
  const fixture = validLegacyFixture();
  const worldPath = path.join(directory, 'world-memory.json');
  const travelPath = path.join(directory, 'travel-memory.json');
  const placedPath = path.join(directory, 'world-memory.json.placed');
  fs.writeFileSync(worldPath, JSON.stringify(fixture.worldMemory));
  fs.writeFileSync(travelPath, JSON.stringify(fixture.travel));
  fs.writeFileSync(placedPath, JSON.stringify(fixture.placed));

  const worldBytes = fs.statSync(worldPath).size;
  const travelBytes = fs.statSync(travelPath).size;
  const worldHash = sha256(worldPath);
  const travelHash = sha256(travelPath);
  const beforeListing = fs.readdirSync(directory).sort();

  const result = runCli(['--world-memory', worldPath, '--travel', travelPath], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.reportKind, 'legacy-spatial-memory-preflight');
  assert.equal(report.sources.worldMemory.status, 'inspected');
  assert.equal(report.sources.travel.status, 'inspected');
  assert.equal(report.sources.placed.status, 'omitted');
  assert.equal(report.files.worldMemory.path, path.resolve(worldPath));
  assert.equal(report.files.worldMemory.bytes, worldBytes);
  assert.equal(report.files.worldMemory.sha256, worldHash);
  assert.equal(report.files.travel.path, path.resolve(travelPath));
  assert.equal(report.files.travel.bytes, travelBytes);
  assert.equal(report.files.travel.sha256, travelHash);
  assert.equal(report.files.placed, undefined);

  assert.deepEqual(fs.readdirSync(directory).sort(), beforeListing);
  assert.equal(sha256(worldPath), worldHash);
  assert.equal(sha256(travelPath), travelHash);
});

test('CLI reports invalid JSON, oversized input, missing files and bad arguments without writing', (t) => {
  const directory = tempDirectory(t);
  const badJson = path.join(directory, 'bad.json');
  fs.writeFileSync(badJson, '{not json');
  const beforeListing = fs.readdirSync(directory).sort();

  const invalid = runCli(['--world-memory', badJson], directory);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_JSON');

  const oversized = runCli(['--world-memory', badJson, '--max-bytes', '5'], directory);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, '');
  assert.equal(JSON.parse(oversized.stderr).error.code, 'BYTE_LIMIT');

  const missing = runCli(['--world-memory', path.join(directory, 'missing.json')], directory);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'IO_ERROR');

  const noSource = runCli([], directory);
  assert.equal(noSource.status, 1);
  assert.equal(JSON.parse(noSource.stderr).error.code, 'ARGUMENTS');

  const unsupported = runCli(['--out', path.join(directory, 'report.json')], directory);
  assert.equal(unsupported.status, 1);
  assert.equal(JSON.parse(unsupported.stderr).error.code, 'ARGUMENTS');

  assert.deepEqual(fs.readdirSync(directory).sort(), beforeListing);
});

test('CLI works with a single source and does not discover sibling defaults', (t) => {
  const directory = tempDirectory(t);
  fs.writeFileSync(path.join(directory, 'world-memory.json'), JSON.stringify(validLegacyFixture().worldMemory));
  const travelPath = path.join(directory, 'travel-memory.json');
  fs.writeFileSync(travelPath, JSON.stringify(validLegacyFixture().travel));

  const result = runCli(['--travel', travelPath], directory);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sources.travel.status, 'inspected');
  assert.equal(report.sources.worldMemory.status, 'omitted');
  assert.equal(report.files.worldMemory, undefined);
  assert.equal(fs.readdirSync(directory).includes('spatial-memory.db'), false);
});
