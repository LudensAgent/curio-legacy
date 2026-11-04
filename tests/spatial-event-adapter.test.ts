/**
 * 事件适配层契约测试：原始委托/开始证据、类型化 NavResult 保留、宿主扩展的真实
 * SQLite 往返、容量/冲突拒绝、观测事件序号/作用域，以及模块无运行时副作用。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ArrivalSpec, EffectEvidence, NavResult, Observation, Vec3Like } from 'curio-minecraft-3d-memory';
import type { SpatialEvent } from 'curio-minecraft-3d-memory/storage/sqlite';
import {
  captureNavigationReceipt,
  enqueuePreparedFacts,
  prepareNavigationAction,
  prepareObservedCellEvent,
  prepareObservationGapEvent,
  readCurioActionExtension,
  type HostActionRecord,
  type NavigationActionEvidence,
  type NavigationActionPreparation,
  type NavigationCaptureInput,
  type NavigationCaptureResult,
  type NavigationReceipt,
  type ObservedCellChangeEvent,
  type ObservedCellEventInput,
  type ObservedCellEventPreparation,
  type ObservationGapEvent,
  type ObservationGapEventInput,
  type ObservationGapEventPreparation,
  type OriginalNavigationRequest,
  type OriginalStartEvidence,
  type ParsedNavigationDelegation,
} from '../src/spatial/event-adapter.ts';
import type { BlockObservation } from '../src/adapter/types.ts';

const WORLD = 'event-adapter-world';
const DIM = 'overworld';
const SESSION = 'session-a';
const T0 = 1_700_000_000_000;

function vec(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function start(overrides: Partial<OriginalStartEvidence> = {}): OriginalStartEvidence {
  return { worldId: WORLD, dim: DIM, sessionId: SESSION, pos: vec(1.25, 64, -2.5), observedAt: T0, ...overrides };
}

function delegation(overrides: Partial<ParsedNavigationDelegation> = {}): ParsedNavigationDelegation {
  return {
    requestedTarget: vec(10.5, 64, -3.25),
    target: vec(10.5, 64, -3.25),
    allowedModes: ['walk'],
    arrival: { kind: 'near', radius: 1.75 },
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
    ...overrides,
  };
}

function walkToInput(overrides: Partial<NavigationCaptureInput> = {}): NavigationCaptureInput {
  return {
    invocationId: 'inv-1',
    taskId: 't_1',
    planVersion: 7,
    source: 'llm',
    delegationId: 'del-1',
    ts: T0 + 5,
    request: { skill: 'walk_to', to: vec(10.5, 64, -3.25), arrival: { kind: 'near', radius: 1.75 } },
    delegation: delegation(),
    originalStart: start(),
    ...overrides,
  };
}

type FailureNav = Extract<NavResult, { outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED' }>;

function cancelledNav(): FailureNav {
  return {
    outcome: 'CANCELLED',
    message: 'cancelled after partial movement',
    confirmed: false,
    trace: [
      { pos: vec(2, 64, -2.5), ts: T0 + 100 },
      { pos: vec(3, 64, -2.5), ts: T0 + 200 },
    ],
    lastPosition: vec(3, 64, -2.5),
    lastObservation: {
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: T0 + 210, onGround: true, inWater: false,
    },
    memoryWrite: 'failed',
    consumption: { placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }], digMs: 12 },
    problem: { kind: 'cancelled', by: 'agent', reason: 'parent task cancelled' },
  };
}

function sampleObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    pos: vec(1, 2, 3),
    state: { name: 'minecraft:stone', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    observedAt: T0,
    source: 'vision',
    sessionId: SESSION,
    sequence: 1,
    dim: DIM,
    worldId: WORLD,
    ...overrides,
  };
}

function sampleBlockObservation(overrides: Partial<BlockObservation> = {}): BlockObservation {
  return {
    name: 'minecraft:oak_door',
    properties: { open: true, hinge: 'left', level: 3 },
    pos: vec(4, 65, -7),
    worldId: WORLD,
    sessionId: SESSION,
    dimension: DIM,
    observationId: 77,
    observedAt: T0 + 1000,
    source: 'vision',
    stateComplete: true,
    ...overrides,
  };
}

function actionEvidence(overrides: Partial<NavigationActionEvidence> = {}): NavigationActionEvidence {
  return {
    consumption: { kind: 'measured', placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }], digMs: 12 },
    subActions: [{ kind: 'move', at: vec(2, 64, -2.5), origin: 'execution_helper', outcome: 'cancelled' }],
    observedChanges: [sampleObservation()],
    ...overrides,
  };
}

function captured(result: NavigationCaptureResult): NavigationReceipt {
  if (result.status !== 'captured') throw new Error(`capture refused: ${JSON.stringify(result.gaps)}`);
  return result.receipt;
}

function refusedCapture(result: NavigationCaptureResult): NavigationCaptureResult & { status: 'refused' } {
  if (result.status !== 'refused') throw new Error('expected capture refusal');
  return result;
}

function prepared(result: NavigationActionPreparation): Extract<NavigationActionPreparation, { status: 'prepared' }> {
  if (result.status !== 'prepared') throw new Error(`unrecordable: ${JSON.stringify(result.gaps)}`);
  return result;
}

function unrecordable(result: NavigationActionPreparation): Extract<NavigationActionPreparation, { status: 'unrecordable' }> {
  if (result.status !== 'unrecordable') throw new Error('expected unrecordable preparation');
  return result;
}

function observedEvent(result: ObservedCellEventPreparation): ObservedCellChangeEvent {
  if (result.status !== 'prepared') throw new Error(`observed event refused: ${JSON.stringify(result.gaps)}`);
  return result.event;
}

function gapEvent(result: ObservationGapEventPreparation): ObservationGapEvent {
  if (result.status !== 'prepared') throw new Error(`gap event refused: ${JSON.stringify(result.gaps)}`);
  return result.event;
}

function asCapture(value: unknown): NavigationCaptureInput {
  return value as NavigationCaptureInput;
}

function asEvidence(value: unknown): NavigationActionEvidence {
  return value as NavigationActionEvidence;
}

function asObserved(value: unknown): ObservedCellEventInput {
  return value as ObservedCellEventInput;
}

function asGap(value: unknown): ObservationGapEventInput {
  return value as ObservationGapEventInput;
}

function hasGap(result: { gaps: readonly { code: string; blocking: boolean }[] }, code: string): boolean {
  return result.gaps.some((gap) => gap.code === code);
}

test('walk_to keeps the original target/near tolerance and uses the receipt start, not trace[0]', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  assert.deepEqual(receipt.request, {
    skill: 'walk_to', to: vec(10.5, 64, -3.25), arrival: { kind: 'near', radius: 1.75 },
  });
  assert.deepEqual(receipt.delegation.target, vec(10.5, 64, -3.25));
  assert.deepEqual(receipt.delegation.arrival, { kind: 'near', radius: 1.75 });

  const nav = cancelledNav();
  const result = prepared(prepareNavigationAction(receipt, nav, actionEvidence()));
  const { record, gaps, diagnostics } = result;
  assert.equal(gaps.length, 0);
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(record.delegation.requestedTarget, vec(10.5, 64, -3.25));
  assert.deepEqual(record.delegation.target, vec(10.5, 64, -3.25));
  assert.deepEqual(record.delegation.arrival, { kind: 'near', radius: 1.75 });
  assert.deepEqual(record.from, receipt.originalStart.pos);
  assert.notDeepEqual(record.from, nav.trace[0]!.pos);
  assert.deepEqual(record.trace, nav.trace);
  const retained = record.result;
  assert.ok(retained !== undefined);
  assert.equal(retained.outcome, 'CANCELLED');
  assert.equal(retained.memoryWrite, 'failed');
  assert.deepEqual(retained.trace, nav.trace);
  assert.deepEqual(retained.lastObservation, nav.lastObservation);
  assert.deepEqual(retained.consumption, nav.consumption);
  assert.deepEqual(retained.problem, nav.problem);
  assert.equal(record.confirmed, false);
  assert.equal('to' in record, false);
  assert.deepEqual(record.failureAt, nav.lastPosition);
  assert.equal(record.failureReason, nav.message);
  assert.equal(record.curio.version, 1);
  assert.equal(record.curio.invocationId, 'inv-1');
  assert.equal(record.curio.source, 'llm');
  assert.equal(record.curio.request.skill, 'walk_to');

  // Preparation never rewrites the producer's result marker.
  assert.equal(nav.memoryWrite, 'failed');
  assert.equal(nav.outcome, 'CANCELLED');
});

test('scope-change/timeout-style failures stay typed and are never rewritten', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput({ invocationId: 'inv-scope' })));
  const nav: FailureNav = {
    outcome: 'FAILED',
    message: 'scope changed during execution',
    confirmed: false,
    trace: [{ pos: vec(2, 64, -2.5), ts: T0 + 50 }],
    lastPosition: vec(2, 64, -2.5),
    lastObservation: {
      worldId: WORLD, dim: DIM, sessionId: 'other-session', observedAt: T0 + 60, onGround: true, inWater: false,
    },
    memoryWrite: 'pending',
    problem: { kind: 'scope_changed', detail: 'session changed' },
  };
  const result = prepared(prepareNavigationAction(receipt, nav, actionEvidence()));
  assert.deepEqual(result.record.result, nav);
  assert.equal(result.record.result!.memoryWrite, 'pending');
  assert.deepEqual(result.record.result!.problem, { kind: 'scope_changed', detail: 'session changed' });
  assert.deepEqual(result.record.failureAt, nav.lastPosition);
  assert.equal(result.record.failureReason, nav.message);
  assert.equal(result.record.confirmed, false);
  assert.equal(nav.memoryWrite, 'pending');
});

test('walk_route preserves the full ordered route; walk_known_route preserves the real fragmentId', () => {
  const points = [vec(0, 64, 0), vec(1, 64, 0), vec(2, 64, 0)];
  const route = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-route',
    request: { skill: 'walk_route', points, deadlineMs: T0 + 1000 },
    delegation: delegation({ requestedTarget: points[2]!, target: points[2]!, arrival: { kind: 'exact' } }),
  })));
  assert.deepEqual(route.request, { skill: 'walk_route', points, deadlineMs: T0 + 1000 });
  assert.deepEqual(route.delegation.target, points[2]);
  assert.deepEqual(route.delegation.arrival, { kind: 'exact' });

  const routeRecord = prepared(prepareNavigationAction(route, cancelledNav(), actionEvidence())).record;
  const routeRequest = routeRecord.curio.request;
  assert.ok(routeRequest.skill === 'walk_route');
  assert.deepEqual(routeRequest.points, points);
  assert.deepEqual(routeRecord.delegation.target, points[2]);

  const known = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-known',
    request: { skill: 'walk_known_route', fragmentId: 'frag-real-42' },
    delegation: delegation({ requestedTarget: 'frag-real-42', target: vec(8, 64, 8), arrival: { kind: 'exact' } }),
  })));
  const knownRequest = known.request;
  assert.ok(knownRequest.skill === 'walk_known_route');
  assert.equal(knownRequest.fragmentId, 'frag-real-42');
  assert.equal('pathId' in knownRequest, false);
  assert.equal(known.delegation.requestedTarget, 'frag-real-42');
  assert.deepEqual(known.delegation.target, vec(8, 64, 8));

  const refused = refusedCapture(captureNavigationReceipt(asCapture({
    ...walkToInput(),
    request: { skill: 'walk_known_route', pathId: 'legacy-path' },
  })));
  assert.match(refused.gaps[0]!.detail, /fragmentId/);
});

test('missing original scope/start/time/delegation and unknown evidence are refused, never defaulted', () => {
  const base = walkToInput();

  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, originalStart: undefined }))),
    'missing_original_start',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({
      ...base, originalStart: { ...base.originalStart, observedAt: undefined },
    }))),
    'missing_original_start_time',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({
      ...base, originalStart: { ...base.originalStart, sessionId: undefined },
    }))),
    'invalid_original_start',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, delegation: undefined }))),
    'missing_delegation',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, invocationId: base.taskId }))),
    'invalid_invocation_identity',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, source: 'planner' }))),
    'invalid_source',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, planVersion: 1.5 }))),
    'invalid_plan_version',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, ts: undefined }))),
    'invalid_ts',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, request: undefined }))),
    'missing_request',
  ));

  const receipt = captured(captureNavigationReceipt(base));
  const nav = cancelledNav();

  const noConsumption = unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
    subActions: [], observedChanges: [],
  })));
  assert.ok(hasGap(noConsumption, 'missing_consumption_evidence'));
  assert.equal(noConsumption.receipt, receipt);
  assert.equal(noConsumption.nav, nav);
  assert.equal(nav.memoryWrite, 'failed');

  assert.ok(hasGap(
    unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
      consumption: { kind: 'known_empty' }, observedChanges: [],
    }))),
    'missing_sub_actions',
  ));
  assert.ok(hasGap(
    unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
      consumption: { kind: 'known_empty' }, subActions: [],
    }))),
    'missing_observed_changes',
  ));
  assert.ok(hasGap(
    unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
      consumption: { kind: 'guessed' }, subActions: [], observedChanges: [],
    }))),
    'invalid_consumption_evidence',
  ));
  assert.ok(hasGap(
    unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
      consumption: { kind: 'known_empty' },
      subActions: [{
        kind: 'move',
        origin: 'execution_helper',
        outcome: 'ok',
        effects: [{ verified: true, changed: true, reasons: ['host summary'] }],
      }],
      observedChanges: [],
    }))),
    'missing_effect_provenance',
  ));
});

test('host EffectEvidence is diagnosed, never promoted; TaskSource and subAction origins stay factual', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const host = { verified: true, changed: true, reasons: ['block_changed'] };
  const result = prepared(prepareNavigationAction(receipt, cancelledNav(), actionEvidence({
    hostEffectEvidence: host,
    consumption: { kind: 'known_empty' },
    subActions: [{ kind: 'place', origin: 'scheduler', outcome: 'ok' }],
  })));
  assert.ok(result.gaps.some((gap) => gap.code === 'unmappable_host_effect_evidence' && gap.blocking === false));
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    kind: 'host_effect_evidence', verified: true, changed: true, reasons: ['block_changed'], omittedReasons: 0,
  });
  assert.equal(result.record.subActions[0]!.origin, 'scheduler');
  assert.equal(result.record.subActions[0]!.effects, undefined);
  assert.equal(result.record.curio.source, 'llm');
  assert.equal(JSON.stringify(result.record.subActions).includes('block_changed'), false);

  const effect: EffectEvidence = {
    kind: 'block_placed',
    at: vec(3, 64, -2.5),
    block: 'minecraft:stone',
    observedAt: T0 + 50,
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    actionId: 'inv-1',
    verified: true,
  };
  const withEffect = prepared(prepareNavigationAction(receipt, cancelledNav(), actionEvidence({
    consumption: { kind: 'known_empty' },
    subActions: [{ kind: 'place', origin: 'agent', outcome: 'ok', effects: [effect] }],
  })));
  assert.deepEqual(withEffect.record.subActions[0]!.effects, [effect]);
});

test('replayed invocation keeps the same record id/content; reused task ids with distinct invocation ids do not alias', () => {
  const make = (invocationId: string) => prepared(prepareNavigationAction(
    captured(captureNavigationReceipt(walkToInput({ invocationId }))),
    cancelledNav(),
    actionEvidence(),
  )).record;
  const a = make('inv-a');
  const b = make('inv-b');
  const replay = make('inv-a');
  assert.equal(a.id, 'inv-a');
  assert.equal(b.id, 'inv-b');
  assert.notEqual(a.id, b.id);
  assert.equal(a.curio.taskId, 't_1');
  assert.equal(b.curio.taskId, 't_1');
  assert.deepEqual(replay, a);
});

test('a late old result keeps its original scope and is not re-scoped to a current session', () => {
  const oldReceipt = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-old',
    originalStart: start({ sessionId: 'old-session' }),
  })));
  const nav = cancelledNav();
  nav.lastObservation = { ...nav.lastObservation!, sessionId: 'older-observation-session' };
  const oldRecord = prepared(prepareNavigationAction(oldReceipt, nav, actionEvidence())).record;
  assert.equal(oldRecord.sessionId, 'old-session');
  assert.equal(oldRecord.result!.lastObservation!.sessionId, 'older-observation-session');

  const newReceipt = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-new',
    originalStart: start({ sessionId: 'new-session' }),
  })));
  const newRecord = prepared(prepareNavigationAction(newReceipt, cancelledNav(), actionEvidence())).record;
  assert.equal(newRecord.sessionId, 'new-session');
  assert.notEqual(oldRecord.id, newRecord.id);
});

test('observed-cell events map dimension/properties, keep sequence separate, and never invent a previous state', () => {
  const current = sampleBlockObservation();
  const previous = sampleObservation({
    sessionId: 'older-session',
    observedAt: T0 - 500,
    sequence: 3,
    pos: { ...current.pos },
    dim: current.dimension,
  });
  const event = observedEvent(prepareObservedCellEvent({
    id: 'event-1', sequence: 900, current, previous, actionId: 'inv-1',
  }));
  assert.equal(event.kind, 'observed_cell_change');
  assert.equal(event.dim, 'overworld');
  assert.equal(event.current.dim, 'overworld');
  assert.deepEqual(event.current.state.properties, { open: 'true', hinge: 'left', level: '3' });
  assert.equal(event.current.sequence, 900);
  assert.equal(event.current.originObservationId, 77);
  assert.equal(event.current.stateComplete, true);
  assert.equal(event.observedAt, current.observedAt);
  assert.deepEqual(event.previous, previous);
  assert.equal(event.previous!.sessionId, 'older-session');
  assert.equal(event.previous!.observedAt, T0 - 500);
  assert.equal(event.actionId, 'inv-1');

  const incomplete = observedEvent(prepareObservedCellEvent({
    id: 'event-2', sequence: 901, current: { ...current, stateComplete: undefined },
  }));
  assert.equal(incomplete.current.stateComplete, false);

  const noPrevious = observedEvent(prepareObservedCellEvent({ id: 'event-3', sequence: 902, current }));
  assert.equal('previous' in noPrevious, false);
  assert.equal('actionId' in noPrevious, false);

  const mismatch = prepareObservedCellEvent({
    id: 'event-4', sequence: 903, current, previous: { ...previous, dim: 'the_nether' },
  });
  assert.equal(mismatch.status, 'refused');
  if (mismatch.status === 'refused') assert.ok(hasGap(mismatch, 'previous_scope_mismatch'));

  const missingScope = prepareObservedCellEvent(asObserved({
    id: 'event-5', sequence: 904, current: { ...current, dimension: '' },
  }));
  assert.equal(missingScope.status, 'refused');
  if (missingScope.status === 'refused') assert.ok(hasGap(missingScope, 'invalid_current_observation'));
});

test('observation gap events require explicit original scope/time/reason and never use current values', () => {
  const event = gapEvent(prepareObservationGapEvent({
    id: 'gap-1', worldId: WORLD, dim: DIM, sessionId: 's-gap', observedAt: T0, reason: 'unloaded', pos: vec(1, 2, 3),
  }));
  assert.deepEqual(event, {
    kind: 'observation_gap', id: 'gap-1', observedAt: T0, worldId: WORLD, dim: DIM,
    sessionId: 's-gap', reason: 'unloaded', pos: vec(1, 2, 3),
  });

  const noTime = prepareObservationGapEvent(asGap({
    id: 'gap-2', worldId: WORLD, dim: DIM, sessionId: 's-gap', reason: 'paused',
  }));
  assert.equal(noTime.status, 'refused');
  if (noTime.status === 'refused') assert.ok(hasGap(noTime, 'invalid_gap_time'));

  const noScope = prepareObservationGapEvent(asGap({
    id: 'gap-3', dim: DIM, sessionId: 's-gap', observedAt: T0, reason: 'paused',
  }));
  assert.equal(noScope.status, 'refused');
  if (noScope.status === 'refused') assert.ok(hasGap(noScope, 'invalid_gap_scope'));

  const badReason = prepareObservationGapEvent(asGap({
    id: 'gap-4', worldId: WORLD, dim: DIM, sessionId: 's-gap', observedAt: T0, reason: 'weather',
  }));
  assert.equal(badReason.status, 'refused');
  if (badReason.status === 'refused') assert.ok(hasGap(badReason, 'invalid_gap_reason'));
});

test('host extension read reports missing/unsupported/malformed metadata instead of casting', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const record = prepared(prepareNavigationAction(receipt, cancelledNav(), actionEvidence())).record;

  const okRead = readCurioActionExtension(record);
  assert.equal(okRead.status, 'ok');
  if (okRead.status === 'ok') assert.deepEqual(okRead.extension, record.curio);

  assert.equal(readCurioActionExtension({ ...record, curio: undefined }).status, 'missing');

  const unsupported = readCurioActionExtension({ ...record, curio: { ...record.curio, version: 2 } });
  assert.equal(unsupported.status, 'unsupported_version');
  if (unsupported.status === 'unsupported_version') assert.equal(unsupported.version, 2);

  const malformed = readCurioActionExtension({
    ...record,
    curio: {
      version: 1,
      invocationId: 'inv-x',
      taskId: 't',
      planVersion: 1,
      source: 'llm',
      request: { skill: 'walk_known_route', pathId: 'legacy-path' },
      originalStart: record.curio.originalStart,
    },
  });
  assert.equal(malformed.status, 'malformed');
  if (malformed.status === 'malformed') assert.ok(malformed.errors.some((error) => error.includes('fragmentId')));
});

test('capture and prepare snapshots isolate later mutations of caller inputs and receipts', () => {
  const points = [vec(0, 64, 0), vec(1, 64, 0), vec(2, 64, 0)];
  const input = walkToInput({
    request: { skill: 'walk_route', points },
    delegation: delegation({ requestedTarget: points[2]!, target: points[2]!, arrival: { kind: 'exact' } }),
  });
  const receipt = captured(captureNavigationReceipt(input));

  points[0]!.x = 99;
  input.delegation.target.x = 99;
  input.originalStart.pos.x = 99;
  const capturedRequest = receipt.request;
  assert.ok(capturedRequest.skill === 'walk_route');
  assert.deepEqual(capturedRequest.points[0], vec(0, 64, 0));
  assert.deepEqual(receipt.delegation.target, vec(2, 64, 0));
  assert.deepEqual(receipt.originalStart.pos, vec(1.25, 64, -2.5));

  const evidence = actionEvidence();
  const result = prepared(prepareNavigationAction(receipt, cancelledNav(), evidence));

  receipt.delegation.target.x = 555;
  receipt.originalStart.pos.x = 555;
  const mutableReceiptRequest = receipt.request;
  if (mutableReceiptRequest.skill === 'walk_route') mutableReceiptRequest.points[0]!.x = 555;
  evidence.subActions[0]!.kind = 'mutated';
  evidence.observedChanges[0]!.state.properties['x'] = 'mutated';

  const preparedRequest = result.record.curio.request;
  assert.ok(preparedRequest.skill === 'walk_route');
  assert.deepEqual(preparedRequest.points[0], vec(0, 64, 0));
  assert.deepEqual(result.record.delegation.target, vec(2, 64, 0));
  assert.deepEqual(result.record.from, vec(1.25, 64, -2.5));
  assert.equal(result.record.subActions[0]!.kind, 'move');
  assert.deepEqual(result.record.observedChanges[0]!.state.properties, {});
});

test('the adapter module has no runtime config/store/game/timer/file side effects', () => {
  const source = readFileSync(new URL('../src/spatial/event-adapter.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(^|\n)import\s+(?!type\b)/, 'the product module must use type-only imports');
  assert.doesNotMatch(source, /from ['"][^'"]*\/config(?:\.ts)?['"]/);
  assert.doesNotMatch(source, /from ['"][^'"]*\/arbiter(?:\.ts)?['"]/);
  assert.doesNotMatch(source, /from ['"][^'"]*\/memory\//);
  assert.doesNotMatch(source, /import\s+[^;]*ChangeReport/);
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /randomUUID\s*\(/);
  assert.doesNotMatch(source, /new\s+Worker\s*\(/);
  assert.doesNotMatch(source, /set(?:Interval|Timeout)\s*\(/);
  assert.doesNotMatch(source, /writeFile|Bun\.write/);
});

function sqliteWorldId(label: string): string {
  return `event-adapter-${label}-${process.pid}-${T0}`;
}

test('real sqlite: acceptance stays pending until checkpoint; query/close/reopen retain extension and partial NavResult', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-event-adapter-'));
  const dbPath = join(dir, 'memory.db');
  const worldId = sqliteWorldId('roundtrip');

  const startEvidence = start({ worldId });
  const receipt = captured(captureNavigationReceipt(walkToInput({ originalStart: startEvidence })));
  const nav = cancelledNav();
  const action = prepared(prepareNavigationAction(receipt, nav, actionEvidence())).record;
  const cellEvent = observedEvent(prepareObservedCellEvent({
    id: 'event-real-1',
    sequence: 12,
    current: sampleBlockObservation({ worldId }),
    previous: sampleObservation({
      worldId, sessionId: 'older-session', observedAt: T0 - 1000, sequence: 4, pos: vec(4, 65, -7),
    }),
  }));
  const gap = gapEvent(prepareObservationGapEvent({
    id: 'gap-real-1', worldId, dim: DIM, sessionId: SESSION, observedAt: T0 + 2000, reason: 'paused',
  }));

  let sessionClosed = false;
  let reopenedClosed = false;
  try {
    const session = await openSpatialSession({ worldId, databasePath: dbPath, timeoutMs: 5000 });
    let firstRevision = 0;
    try {
      const first = enqueuePreparedFacts({ journal: session.journal }, { actions: [action], events: [cellEvent, gap] });
      assert.equal(first.status, 'accepted_pending_checkpoint');
      if (first.status !== 'accepted_pending_checkpoint') throw new Error('expected acceptance');
      assert.equal(first.accepted, 3);
      assert.equal(first.duplicates, 0);
      assert.ok(first.revision > 0);
      firstRevision = first.revision;

      const pendingState = session.getPersistenceState();
      assert.equal(pendingState.pendingJournalRecords, 3);
      assert.ok(pendingState.pendingJournalBytes > 0);
      assert.equal(pendingState.committedJournalRecords, 0);
      assert.equal(pendingState.dirty, true);
      assert.equal(pendingState.journalRevision, first.revision);
      assert.equal(pendingState.confirmedJournalRevision, 0);

      const replay = enqueuePreparedFacts({ journal: session.journal }, { actions: [action], events: [cellEvent, gap] });
      assert.equal(replay.status, 'accepted_pending_checkpoint');
      if (replay.status !== 'accepted_pending_checkpoint') throw new Error('expected replay acceptance');
      assert.equal(replay.accepted, 0);
      assert.equal(replay.duplicates, 3);
      assert.equal(replay.revision, first.revision);
      assert.equal(session.getPersistenceState().pendingJournalRecords, 3);

      // Accepted journal clones must not observe later caller mutations.
      action.delegation.target.x = 999;
      action.trace[0]!.pos.x = 999;
      nav.lastPosition!.x = 999;
      cellEvent.current.state.properties.hinge = 'right';
      const pending = session.journal.readPending();
      assert.equal(pending.actions.length, 1);
      assert.deepEqual(pending.actions[0]!.delegation.target, vec(10.5, 64, -3.25));
      assert.deepEqual(pending.actions[0]!.trace[0]!.pos, vec(2, 64, -2.5));
      assert.deepEqual(pending.actions[0]!.result!.lastPosition, vec(3, 64, -2.5));
      const pendingCell = pending.events.find((event) => event.kind === 'observed_cell_change');
      assert.ok(pendingCell !== undefined && pendingCell.kind === 'observed_cell_change');
      assert.equal(pendingCell.current.state.properties.hinge, 'left');

      const checkpoint = await session.checkpoint();
      assert.equal(checkpoint.journalRevision, firstRevision);
      const savedState = session.getPersistenceState();
      assert.equal(savedState.pendingJournalRecords, 0);
      assert.equal(savedState.committedJournalRecords, 3);
      assert.equal(savedState.confirmedJournalRevision, firstRevision);
      assert.equal(savedState.dirty, false);

      const actionPage = await session.queryActions({ actionId: action.id });
      assert.equal(actionPage.records.length, 1);
      const storedAction = actionPage.records[0]!;
      const extension = readCurioActionExtension(storedAction);
      assert.equal(extension.status, 'ok');
      if (extension.status === 'ok') {
        assert.equal(extension.extension.invocationId, 'inv-1');
        assert.equal(extension.extension.source, 'llm');
        assert.deepEqual(extension.extension.request, receipt.request);
        assert.deepEqual(extension.extension.originalStart, startEvidence);
      }
      assert.deepEqual(storedAction.from, vec(1.25, 64, -2.5));
      const storedNav = storedAction.result;
      assert.ok(storedNav !== undefined);
      assert.equal(storedNav.outcome, 'CANCELLED');
      assert.equal(storedNav.memoryWrite, 'failed');
      assert.deepEqual(storedNav.trace, cancelledNav().trace);
      assert.deepEqual(storedNav.lastObservation, cancelledNav().lastObservation);
      assert.deepEqual(storedNav.consumption, cancelledNav().consumption);
      assert.deepEqual(storedNav.problem, cancelledNav().problem);

      const eventPage = await session.queryEvents({ eventId: cellEvent.id });
      assert.equal(eventPage.records.length, 1);
      const storedCell = eventPage.records[0]!;
      assert.equal(storedCell.kind, 'observed_cell_change');
      if (storedCell.kind === 'observed_cell_change') {
        assert.equal(storedCell.current.sequence, 12);
        assert.equal(storedCell.current.originObservationId, 77);
        assert.deepEqual(storedCell.current.state.properties, { open: 'true', hinge: 'left', level: '3' });
        assert.equal(storedCell.previous?.sessionId, 'older-session');
        assert.equal(storedCell.previous?.observedAt, T0 - 1000);
      }
      const gapPage = await session.queryEvents({ eventId: gap.id });
      assert.equal(gapPage.records.length, 1);
      assert.equal(gapPage.records[0]!.kind, 'observation_gap');
    } finally {
      const closed = await session.close();
      sessionClosed = closed.completed && closed.error === null;
      assert.equal(closed.completed, true, 'writable session must close');
      assert.equal(closed.error, null);
    }

    const reopened = await openSpatialSession({ worldId, databasePath: dbPath, timeoutMs: 5000 });
    try {
      const actionPage = await reopened.queryActions({ actionId: action.id });
      assert.equal(actionPage.records.length, 1);
      const storedAction = actionPage.records[0]!;
      const extension = readCurioActionExtension(storedAction);
      assert.equal(extension.status, 'ok');
      if (extension.status === 'ok') {
        assert.deepEqual(extension.extension.request, receipt.request);
        assert.deepEqual(extension.extension.originalStart, startEvidence);
      }
      const storedNav = storedAction.result;
      assert.ok(storedNav !== undefined);
      assert.equal(storedNav.outcome, 'CANCELLED');
      assert.equal(storedNav.memoryWrite, 'failed');
      assert.deepEqual(storedNav.trace, cancelledNav().trace);
      assert.deepEqual(storedNav.lastObservation, cancelledNav().lastObservation);
      assert.deepEqual(storedNav.consumption, cancelledNav().consumption);

      const eventPage = await reopened.queryEvents({ eventId: cellEvent.id });
      assert.equal(eventPage.records.length, 1);
      const storedCell = eventPage.records[0]!;
      assert.equal(storedCell.kind, 'observed_cell_change');
      if (storedCell.kind === 'observed_cell_change') {
        assert.equal(storedCell.current.sequence, 12);
        assert.equal(storedCell.current.originObservationId, 77);
        assert.equal(storedCell.previous?.sessionId, 'older-session');
      }
    } finally {
      const closed = await reopened.close();
      reopenedClosed = closed.completed && closed.error === null;
      assert.equal(closed.completed, true, 'reopened session must close');
      assert.equal(closed.error, null);
    }
  } finally {
    if (sessionClosed && reopenedClosed) rmSync(dir, { recursive: true, force: true });
    else console.error('preserved temp fixture:', dir, 'sessionClosed=', sessionClosed, 'reopenedClosed=', reopenedClosed);
  }
});

test('real sqlite: capacity/conflict rejection is atomic, keeps body results, and the worker still closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-event-adapter-errors-'));
  const dbPath = join(dir, 'memory.db');
  const worldId = sqliteWorldId('errors');
  let sessionClosed = false;
  try {
    const session = await openSpatialSession({
      worldId, databasePath: dbPath, timeoutMs: 5000, journalLimits: { maxPendingRecords: 1 },
    });
    try {
      const make = (invocationId: string, to: Vec3Like) => {
        const receipt = captured(captureNavigationReceipt(walkToInput({
          invocationId,
          originalStart: start({ worldId }),
          request: { skill: 'walk_to', to, arrival: { kind: 'exact' } },
          delegation: delegation({ requestedTarget: to, target: to, arrival: { kind: 'exact' } }),
        })));
        const nav = cancelledNav();
        return { record: prepared(prepareNavigationAction(receipt, nav, actionEvidence())).record, nav };
      };

      const a = make('inv-a', vec(10.5, 64, -3.25));
      const b = make('inv-b', vec(11, 64, -3.25));
      const capacity = enqueuePreparedFacts({ journal: session.journal }, { actions: [a.record, b.record] });
      assert.equal(capacity.status, 'rejected');
      if (capacity.status === 'rejected') {
        assert.equal(capacity.error.kind, 'capacity');
        assert.equal(capacity.records.actions.length, 2);
      }
      assert.equal(session.getPersistenceState().pendingJournalRecords, 0);
      assert.equal(a.nav.memoryWrite, 'failed');
      assert.equal(a.nav.outcome, 'CANCELLED');
      assert.equal(b.nav.memoryWrite, 'failed');

      const accepted = enqueuePreparedFacts({ journal: session.journal }, { actions: [a.record] });
      assert.equal(accepted.status, 'accepted_pending_checkpoint');
      assert.equal(session.getPersistenceState().pendingJournalRecords, 1);

      const conflictingReceipt = captured(captureNavigationReceipt(walkToInput({
        invocationId: 'inv-a',
        originalStart: start({ worldId }),
        request: { skill: 'walk_to', to: vec(12, 64, -3.25), arrival: { kind: 'exact' } },
        delegation: delegation({
          requestedTarget: vec(12, 64, -3.25), target: vec(12, 64, -3.25), arrival: { kind: 'exact' },
        }),
      })));
      const conflictingNav = cancelledNav();
      const conflicting = prepared(prepareNavigationAction(conflictingReceipt, conflictingNav, actionEvidence())).record;
      const conflict = enqueuePreparedFacts({ journal: session.journal }, { actions: [conflicting] });
      assert.equal(conflict.status, 'rejected');
      if (conflict.status === 'rejected') {
        assert.equal(conflict.error.kind, 'conflict');
        assert.equal(conflict.records.actions.length, 1);
      }
      assert.equal(session.getPersistenceState().pendingJournalRecords, 1);
      assert.deepEqual(session.journal.readPending().actions[0]!.delegation.target, vec(10.5, 64, -3.25));
      assert.equal(conflictingNav.memoryWrite, 'failed');
      assert.equal(conflictingNav.outcome, 'CANCELLED');

      // The library's own boundary validation rejects a mismatched observation event.
      const malformedEvent = observedEvent(prepareObservedCellEvent({
        id: 'event-bad', sequence: 5, current: sampleBlockObservation({ worldId }),
      }));
      malformedEvent.current = { ...malformedEvent.current, observedAt: malformedEvent.observedAt + 1 };
      const invalid = enqueuePreparedFacts({ journal: session.journal }, { events: [malformedEvent] });
      assert.equal(invalid.status, 'rejected');
      if (invalid.status === 'rejected') assert.equal(invalid.error.kind, 'invalid_argument');
      assert.equal(session.getPersistenceState().pendingJournalRecords, 1);
    } finally {
      const closed = await session.close();
      sessionClosed = closed.completed && closed.error === null;
      assert.equal(closed.completed, true, 'worker must close even after rejected journal records');
      assert.equal(closed.error, null);
    }
  } finally {
    if (sessionClosed) rmSync(dir, { recursive: true, force: true });
    else console.error('preserved temp fixture:', dir, 'sessionClosed=', sessionClosed);
  }
});

// Compile-time coverage that the exported request union mirrors the real producers.
const _arrival: ArrivalSpec = { kind: 'near', radius: 1 };
const _request: OriginalNavigationRequest = { skill: 'walk_known_route', fragmentId: 'frag' };
const _recordType: HostActionRecord | null = null;
const _eventType: SpatialEvent | null = null;
void _arrival; void _request; void _recordType; void _eventType;
