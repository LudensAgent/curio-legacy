/**
 * 事件适配层契约测试：完整有界 NavResult 快照、原始预算来源、confirmed/lastPosition
 * 语义、消费冲突、未知边界读取、观测事件序号/作用域，以及真实临时 SQLite 往返。
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
  CURIO_ACTION_EXTENSION_VERSION,
  EVENT_ADAPTER_LIMITS,
  type ConsumptionEvidence,
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
  type OriginalExecutionBudget,
  type OriginalNavigationRequest,
  type OriginalStartEvidence,
  type ParsedNavigationDelegation,
} from '../src/spatial/event-adapter.ts';
import type { BlockObservation } from '../src/adapter/types.ts';

const WORLD = 'event-adapter-world';
const DIM = 'overworld';
const SESSION = 'session-a';
const T0 = 1_700_000_000_000;
const TASK_DEADLINE = T0 + 30_000;

type FailureNav = Extract<NavResult, { outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED' }>;
type PartialNav = Extract<NavResult, { outcome: 'PARTIAL' }>;
type ArrivedNav = Extract<NavResult, { outcome: 'ARRIVED' }>;

function vec(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function budget(overrides: Partial<OriginalExecutionBudget> = {}): OriginalExecutionBudget {
  return { taskStartedAt: T0, taskDeadline: TASK_DEADLINE, effectiveDeadline: TASK_DEADLINE, ...overrides };
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
    budget: budget(),
    ...overrides,
  };
}

function walkToExactInput(overrides: Partial<NavigationCaptureInput> = {}): NavigationCaptureInput {
  const to = vec(10.5, 64, -3.25);
  return walkToInput({
    request: { skill: 'walk_to', to, arrival: { kind: 'exact' } },
    delegation: delegation({ requestedTarget: to, target: to, arrival: { kind: 'exact' } }),
    ...overrides,
  });
}

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

function partialNav(): PartialNav {
  return {
    outcome: 'PARTIAL',
    message: 'partial movement confirmed',
    confirmed: true,
    trace: [{ pos: vec(2, 64, -2.5), ts: T0 + 100 }],
    lastPosition: vec(2, 64, -2.5),
    lastObservation: {
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: T0 + 110, onGround: true, inWater: false,
    },
    memoryWrite: 'pending',
    problem: { kind: 'route_invalidated', detail: 'partial but confirmed movement' },
  };
}

function arrivedNav(sessionId = SESSION): ArrivedNav {
  return {
    outcome: 'ARRIVED',
    message: 'arrived',
    confirmed: true,
    trace: [{ pos: vec(2, 64, -2.5), ts: T0 + 100 }],
    lastPosition: vec(2, 64, -2.5),
    lastObservation: {
      worldId: WORLD, dim: DIM, sessionId, observedAt: T0 + 110, onGround: true, inWater: false,
    },
    memoryWrite: 'pending',
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

function evidenceFor(nav: NavResult, worldId = WORLD): NavigationActionEvidence {
  const navConsumption = nav.consumption;
  const consumption: ConsumptionEvidence = navConsumption === undefined
    ? { kind: 'known_empty' }
    : {
      kind: 'measured',
      placed: navConsumption.placed.map((item) => ({ pos: { ...item.pos }, name: item.name })),
      ...(navConsumption.durabilityLost !== undefined ? { durabilityLost: navConsumption.durabilityLost } : {}),
      ...(navConsumption.digMs !== undefined ? { digMs: navConsumption.digMs } : {}),
    };
  return {
    consumption,
    subActions: [{ kind: 'move', at: vec(2, 64, -2.5), origin: 'execution_helper', outcome: 'cancelled' }],
    observedChanges: [sampleObservation({ worldId })],
  };
}

function captured(result: NavigationCaptureResult): NavigationReceipt {
  if (result.status !== 'captured') throw new Error(`capture refused: ${JSON.stringify(result.gaps)}`);
  return result.receipt;
}

function refusedCapture(result: NavigationCaptureResult): Extract<NavigationCaptureResult, { status: 'refused' }> {
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

function asFailureNav(value: unknown): FailureNav {
  return value as FailureNav;
}

function hasGap(result: { gaps: readonly { code: string; blocking: boolean }[] }, code: string): boolean {
  return result.gaps.some((gap) => gap.code === code);
}

function hasNonblockingGap(result: { gaps: readonly { code: string; blocking: boolean }[] }, code: string): boolean {
  return result.gaps.some((gap) => gap.code === code && gap.blocking === false);
}

function throwingArray(length: number, throwIndex: number): unknown[] {
  const array: unknown[] = new Array(length);
  Object.defineProperty(array, throwIndex, {
    get() { throw new Error('over-limit array was traversed'); },
    enumerable: true,
    configurable: true,
  });
  return array;
}

test('prepared NavResult is a complete bounded snapshot; producer mutation cannot make the record contradictory', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const nav = cancelledNav();
  const original = structuredClone(nav);
  const result = prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav)));

  assert.equal(result.snapshot, 'independent_bounded_copy');
  assert.equal(result.nav, nav);
  assert.notEqual(result.record.result, nav);
  assert.deepEqual(result.record.result, original);
  assert.deepEqual(result.record.trace, original.trace);
  assert.equal(result.record.confirmed, original.confirmed);
  assert.equal(result.record.result!.confirmed, original.confirmed);
  assert.equal('to' in result.record, false);
  assert.equal('failureAt' in result.record, false);
  assert.deepEqual(nav, original, 'preparation must not rewrite the producer result');

  // 在 prepare 与入队之间改动 producer 的典型嵌套字段。
  nav.trace[0]!.pos.x = 999;
  nav.trace.push({ pos: vec(9, 64, 9), ts: T0 + 999 });
  nav.lastPosition!.x = 777;
  nav.lastObservation!.sessionId = 'mutated-session';
  nav.consumption!.placed[0]!.name = 'mutated:block';
  nav.memoryWrite = 'saved';
  if (nav.problem.kind === 'cancelled') nav.problem.reason = 'mutated reason';

  assert.deepEqual(result.record.result, original, 'record.result must stay independent of the producer nav');
  assert.equal(result.record.result!.memoryWrite, 'failed');
  assert.deepEqual(result.record.trace, original.trace);
  assert.equal(result.record.confirmed, original.confirmed);
  assert.deepEqual(result.record.result!.lastPosition, original.lastPosition);
  assert.equal(result.record.result!.lastObservation!.sessionId, SESSION);
  assert.deepEqual(result.record.result!.consumption, original.consumption);
  assert.equal((result.record.result!.problem as { reason?: string }).reason, 'parent task cancelled');
});

test('confirmed preserves nav.confirmed for PARTIAL and CANCELLED true results', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));

  const partial = partialNav();
  const partialResult = prepared(prepareNavigationAction(receipt, partial, evidenceFor(partial)));
  assert.equal(partialResult.record.confirmed, true);
  assert.equal(partialResult.record.result!.confirmed, true);

  const cancelled = cancelledNav();
  cancelled.confirmed = true;
  const cancelledResult = prepared(prepareNavigationAction(receipt, cancelled, evidenceFor(cancelled)));
  assert.equal(cancelledResult.record.confirmed, true);
  assert.equal(cancelledResult.record.result!.confirmed, true);
});

test('top-level to is projected only for ARRIVED with a matching LastObservation scope', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));

  const arrived = arrivedNav(SESSION);
  const arrivedResult = prepared(prepareNavigationAction(receipt, arrived, evidenceFor(arrived)));
  assert.deepEqual(arrivedResult.record.to, arrived.lastPosition);
  assert.equal(hasGap(arrivedResult, 'terminal_scope_mismatch'), false);

  const foreign = arrivedNav('other-session');
  const foreignResult = prepared(prepareNavigationAction(receipt, foreign, evidenceFor(foreign)));
  assert.equal('to' in foreignResult.record, false);
  assert.ok(hasNonblockingGap(foreignResult, 'terminal_scope_mismatch'));
  assert.deepEqual(foreignResult.record.result!.lastPosition, foreign.lastPosition);

  const cancelled = cancelledNav();
  const cancelledResult = prepared(prepareNavigationAction(receipt, cancelled, evidenceFor(cancelled)));
  assert.equal('to' in cancelledResult.record, false);
  assert.equal('failureAt' in cancelledResult.record, false);
  assert.deepEqual(cancelledResult.record.result!.lastPosition, cancelled.lastPosition);
});

test('walk_route preserves ordered points; walk_known_route keeps fragmentId; budget is retained', () => {
  const points = [vec(0, 64, 0), vec(1, 64, 0), vec(2, 64, 0)];
  const route = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-route',
    request: { skill: 'walk_route', points },
    delegation: delegation({ requestedTarget: points[2]!, target: points[2]!, arrival: { kind: 'exact' } }),
  })));
  assert.deepEqual(route.request, { skill: 'walk_route', points });
  assert.equal('deadlineMs' in route.request, false);
  assert.deepEqual(route.budget, budget());
  const routeNav = cancelledNav();
  const routeRecord = prepared(prepareNavigationAction(route, routeNav, evidenceFor(routeNav))).record;
  const routeRequest = routeRecord.curio.request;
  assert.ok(routeRequest.skill === 'walk_route');
  assert.deepEqual(routeRequest.points, points);
  assert.deepEqual(routeRecord.delegation.target, points[2]);
  assert.deepEqual(routeRecord.curio.budget, budget());

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
  const knownNav = cancelledNav();
  const knownRecord = prepared(prepareNavigationAction(known, knownNav, evidenceFor(knownNav))).record;
  assert.deepEqual(knownRecord.curio.request, known.request);
  assert.deepEqual(knownRecord.curio.budget, budget());

  const refused = refusedCapture(captureNavigationReceipt(asCapture({
    ...walkToInput(),
    request: { skill: 'walk_known_route', pathId: 'legacy-path' },
  })));
  assert.match(refused.gaps[0]!.detail, /fragmentId/);
});

test('budget keeps original TaskInfo time/deadline and resolved effective deadline without defaults', () => {
  const base = walkToExactInput();
  const receipt = captured(captureNavigationReceipt(asCapture({
    ...base,
    originalStart: start({ observedAt: T0 - 500 }),
    budget: budget(),
  })));
  assert.equal(receipt.request.skill, 'walk_to');
  assert.equal('deadlineMs' in receipt.request, false, 'omitted request deadline stays omitted');
  assert.equal(receipt.originalStart.observedAt, T0 - 500, 'body sample time is not replaced by TaskInfo.startedAt');
  assert.deepEqual(receipt.budget, budget());

  const earlierRequest = captured(captureNavigationReceipt(asCapture({
    ...base,
    request: { skill: 'walk_to', to: vec(10.5, 64, -3.25), arrival: { kind: 'exact' }, deadlineMs: T0 + 5000 },
    budget: budget({ effectiveDeadline: T0 + 5000 }),
  })));
  assert.equal(earlierRequest.request.skill, 'walk_to');
  if (earlierRequest.request.skill === 'walk_to') assert.equal(earlierRequest.request.deadlineMs, T0 + 5000);
  assert.equal(earlierRequest.budget.effectiveDeadline, T0 + 5000);

  const cappedRequest = captured(captureNavigationReceipt(asCapture({
    ...base,
    request: { skill: 'walk_to', to: vec(10.5, 64, -3.25), arrival: { kind: 'exact' }, deadlineMs: TASK_DEADLINE + 10_000 },
    budget: budget({ effectiveDeadline: TASK_DEADLINE }),
  })));
  assert.equal(cappedRequest.budget.effectiveDeadline, TASK_DEADLINE);

  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, budget: undefined }))),
    'missing_budget',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({ ...base, budget: budget({ effectiveDeadline: T0 + 1000 }) }))),
    'deadline_relationship_mismatch',
  ));
  assert.ok(hasGap(
    refusedCapture(captureNavigationReceipt(asCapture({
      ...base, budget: { taskStartedAt: T0, taskDeadline: Number.NaN, effectiveDeadline: T0 },
    }))),
    'invalid_budget',
  ));

  const nav = cancelledNav();
  const record = prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav))).record;
  assert.deepEqual(record.curio.budget, budget());
});

test('over-limit arrays/strings are refused before traversal and retain caller-owned originals', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));

  const traceNav = asFailureNav({ ...cancelledNav(), trace: throwingArray(EVENT_ADAPTER_LIMITS.maxTracePoints + 1, 0) });
  const traceEvidence = evidenceFor(traceNav);
  const traceResult = unrecordable(prepareNavigationAction(receipt, traceNav, traceEvidence));
  assert.ok(hasGap(traceResult, 'limit_exceeded'));
  assert.equal(traceResult.snapshot, 'not_created');
  assert.equal(traceResult.nav, traceNav);
  assert.equal(traceResult.evidence, traceEvidence);

  const placedNav = asFailureNav({
    ...cancelledNav(),
    consumption: { placed: throwingArray(EVENT_ADAPTER_LIMITS.maxPlacedBlocks + 1, 0) },
  });
  // Build evidence from a normal nav: building it from placedNav would traverse the
  // deliberately over-limit array before preparation gets its own pre-check.
  const placedEvidence = evidenceFor(cancelledNav());
  const placedResult = unrecordable(prepareNavigationAction(receipt, placedNav, placedEvidence));
  assert.ok(hasGap(placedResult, 'limit_exceeded'));
  assert.equal(placedResult.snapshot, 'not_created');
  assert.equal(placedResult.nav, placedNav);

  const stringNav = asFailureNav({ ...cancelledNav(), message: 'x'.repeat(EVENT_ADAPTER_LIMITS.maxStringChars + 1) });
  const stringEvidence = evidenceFor(stringNav);
  const stringResult = unrecordable(prepareNavigationAction(receipt, stringNav, stringEvidence));
  assert.ok(hasGap(stringResult, 'limit_exceeded'));
  assert.equal(stringResult.nav, stringNav);

  const factsNav = asFailureNav({
    ...cancelledNav(),
    problem: {
      kind: 'hazard',
      facts: throwingArray(EVENT_ADAPTER_LIMITS.maxArrayLength + 1, 0),
      constraint: 'test constraint',
    },
  });
  const factsEvidence = evidenceFor(factsNav);
  const factsResult = unrecordable(prepareNavigationAction(receipt, factsNav, factsEvidence));
  assert.ok(hasGap(factsResult, 'limit_exceeded'));
  assert.equal(factsResult.nav, factsNav);

  const oversizedSubActions = throwingArray(EVENT_ADAPTER_LIMITS.maxSubActions + 1, 0);
  const subActionEvidence = asEvidence({ ...evidenceFor(cancelledNav()), subActions: oversizedSubActions });
  const subActionResult = unrecordable(prepareNavigationAction(receipt, cancelledNav(), subActionEvidence));
  assert.ok(hasGap(subActionResult, 'limit_exceeded'));

  const oversizedObserved = throwingArray(EVENT_ADAPTER_LIMITS.maxObservedChanges + 1, 0);
  const observedEvidence = asEvidence({ ...evidenceFor(cancelledNav()), observedChanges: oversizedObserved });
  const observedResult = unrecordable(prepareNavigationAction(receipt, cancelledNav(), observedEvidence));
  assert.ok(hasGap(observedResult, 'limit_exceeded'));
});

test('host EffectEvidence reasons are bounded without scanning beyond the limit', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const total = EVENT_ADAPTER_LIMITS.maxHostEffectReasons + 2;
  const reasons = Array.from({ length: total }, (_, index) => `reason-${index}`);
  Object.defineProperty(reasons, EVENT_ADAPTER_LIMITS.maxHostEffectReasons, {
    get() { throw new Error('host reasons were scanned beyond the bound'); },
    enumerable: true,
    configurable: true,
  });
  const nav = cancelledNav();
  const result = prepared(prepareNavigationAction(receipt, nav, {
    ...evidenceFor(nav),
    hostEffectEvidence: { verified: true, changed: true, reasons },
  }));
  assert.ok(hasNonblockingGap(result, 'unmappable_host_effect_evidence'));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.reasons.length, EVENT_ADAPTER_LIMITS.maxHostEffectReasons);
  assert.equal(result.diagnostics[0]!.omittedReasons, 2);
  assert.equal(JSON.stringify(result.record.subActions).includes('reason-'), false);
});

test('host EffectEvidence is diagnosed, never promoted; source and subAction origins stay factual', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const nav = cancelledNav();
  const result = prepared(prepareNavigationAction(receipt, nav, {
    ...evidenceFor(nav),
    hostEffectEvidence: { verified: true, changed: true, reasons: ['block_changed'] },
    subActions: [{ kind: 'place', origin: 'scheduler', outcome: 'ok' }],
  }));
  assert.ok(hasNonblockingGap(result, 'unmappable_host_effect_evidence'));
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
  const withEffect = prepared(prepareNavigationAction(receipt, nav, {
    ...evidenceFor(nav),
    subActions: [{ kind: 'place', origin: 'agent', outcome: 'ok', effects: [effect] }],
  }));
  assert.deepEqual(withEffect.record.subActions[0]!.effects, [effect]);
});

test('unknown or missing consumption is refused; a provided actual result is never overridden', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const nav = cancelledNav();
  const original = structuredClone(nav);

  const unknown = unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
    ...evidenceFor(nav), consumption: { kind: 'unknown' },
  })));
  assert.ok(hasGap(unknown, 'unknown_consumption_evidence'));
  assert.equal(unknown.nav, nav);
  assert.deepEqual(nav, original);

  const missing = unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
    ...evidenceFor(nav), consumption: undefined,
  })));
  assert.ok(hasGap(missing, 'missing_consumption_evidence'));
  assert.equal(missing.nav, nav);
  assert.deepEqual(nav, original);

  const missingWholeEvidence = unrecordable(prepareNavigationAction(receipt, nav, undefined as unknown as NavigationActionEvidence));
  assert.ok(hasGap(missingWholeEvidence, 'missing_consumption_evidence'));
  assert.equal('evidence' in missingWholeEvidence, false);
});

test('contradictory consumption summaries are refused; matching evidence is retained', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const nav = cancelledNav();
  const original = structuredClone(nav);

  const conflict = (consumption: ConsumptionEvidence) => unrecordable(prepareNavigationAction(receipt, nav, asEvidence({
    ...evidenceFor(nav), consumption,
  })));

  assert.ok(hasGap(conflict({ kind: 'known_empty' }), 'consumption_conflict'));
  assert.ok(hasGap(conflict({
    kind: 'measured',
    placed: [{ pos: vec(4, 64, -2.5), name: 'minecraft:stone' }],
    digMs: 12,
  }), 'consumption_conflict'));
  assert.ok(hasGap(conflict({
    kind: 'measured',
    placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:dirt' }],
    digMs: 12,
  }), 'consumption_conflict'));
  assert.ok(hasGap(conflict({
    kind: 'measured',
    placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }],
    digMs: 5,
  }), 'consumption_conflict'));
  assert.ok(hasGap(conflict({
    kind: 'measured',
    placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }],
  }), 'consumption_conflict'), 'known digMs cannot be silently omitted or zero-filled');
  assert.deepEqual(nav, original, 'failed preparation must not change the original body result');

  const matching = prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav)));
  assert.deepEqual(matching.record.consumption, { placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }], digMs: 12 });
  assert.deepEqual(matching.record.result!.consumption, nav.consumption);

  const noConsumptionNav = partialNav();
  const knownEmpty = prepared(prepareNavigationAction(receipt, noConsumptionNav, {
    ...evidenceFor(noConsumptionNav), consumption: { kind: 'known_empty' },
  }));
  assert.deepEqual(knownEmpty.record.consumption, { placed: [] });
  assert.equal(knownEmpty.record.result!.consumption, undefined);

  const unknownWithoutActual = unrecordable(prepareNavigationAction(receipt, noConsumptionNav, asEvidence({
    ...evidenceFor(noConsumptionNav), consumption: { kind: 'unknown' },
  })));
  assert.ok(hasGap(unknownWithoutActual, 'unknown_consumption_evidence'));
});

test('replayed invocation keeps the same record id/content; reused task ids with distinct invocation ids do not alias', () => {
  const make = (invocationId: string) => {
    const nav = cancelledNav();
    return prepared(prepareNavigationAction(
      captured(captureNavigationReceipt(walkToInput({ invocationId }))),
      nav,
      evidenceFor(nav),
    )).record;
  };
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
  const oldRecord = prepared(prepareNavigationAction(oldReceipt, nav, evidenceFor(nav))).record;
  assert.equal(oldRecord.sessionId, 'old-session');
  assert.equal(oldRecord.result!.lastObservation!.sessionId, 'older-observation-session');

  const newReceipt = captured(captureNavigationReceipt(walkToInput({
    invocationId: 'inv-new',
    originalStart: start({ sessionId: 'new-session' }),
  })));
  const newNav = cancelledNav();
  const newRecord = prepared(prepareNavigationAction(newReceipt, newNav, evidenceFor(newNav))).record;
  assert.equal(newRecord.sessionId, 'new-session');
  assert.notEqual(oldRecord.id, newRecord.id);
});

test('observed-cell events map properties/sequence and carry no vision actionId', () => {
  const current = sampleBlockObservation();
  const previous = sampleObservation({
    sessionId: 'older-session',
    observedAt: T0 - 500,
    sequence: 3,
    pos: { ...current.pos },
    dim: current.dimension,
  });
  const event = observedEvent(prepareObservedCellEvent(asObserved({
    id: 'event-1', sequence: 900, current, previous, actionId: 'must-not-be-copied',
  })));
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
  assert.equal('actionId' in event, false, 'ordinary vision never carries action attribution');

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

  const { properties: _omitted, ...withoutProperties } = current;
  const missingProperties = prepareObservedCellEvent(asObserved({
    id: 'event-5', sequence: 904, current: withoutProperties,
  }));
  assert.equal(missingProperties.status, 'refused');
  if (missingProperties.status === 'refused') assert.ok(hasGap(missingProperties, 'invalid_current_observation'));
});

test('oversized block properties are refused before value access', () => {
  const properties: Record<string, string | number | boolean> = {};
  for (let index = 0; index < EVENT_ADAPTER_LIMITS.maxBlockProperties; index += 1) {
    properties[`p${index}`] = 'v';
  }
  Object.defineProperty(properties, `p${EVENT_ADAPTER_LIMITS.maxBlockProperties}`, {
    get() { throw new Error('over-limit block properties were traversed'); },
    enumerable: true,
    configurable: true,
  });
  const refused = prepareObservedCellEvent({
    id: 'event-props', sequence: 1, current: sampleBlockObservation({ properties }),
  });
  assert.equal(refused.status, 'refused');
  if (refused.status === 'refused') assert.ok(hasGap(refused, 'limit_exceeded'));

  const longValue = prepareObservedCellEvent({
    id: 'event-value', sequence: 2,
    current: sampleBlockObservation({ properties: { p: 'x'.repeat(EVENT_ADAPTER_LIMITS.maxStringChars + 1) } }),
  });
  assert.equal(longValue.status, 'refused');
  if (longValue.status === 'refused') assert.ok(hasGap(longValue, 'limit_exceeded'));
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

test('host extension read reports missing/unsupported/malformed metadata and validates budget', () => {
  const receipt = captured(captureNavigationReceipt(walkToInput()));
  const nav = cancelledNav();
  const record = prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav))).record;

  const okRead = readCurioActionExtension(record);
  assert.equal(okRead.status, 'ok');
  if (okRead.status === 'ok') {
    assert.deepEqual(okRead.extension, record.curio);
    assert.equal(okRead.extension.version, CURIO_ACTION_EXTENSION_VERSION);
    assert.deepEqual(okRead.extension.budget, budget());
  }

  assert.equal(readCurioActionExtension({ ...record, curio: undefined }).status, 'missing');

  const unsupported = readCurioActionExtension({ ...record, curio: { ...record.curio, version: 2 } });
  assert.equal(unsupported.status, 'unsupported_version');
  if (unsupported.status === 'unsupported_version') assert.equal(unsupported.version, 2);

  const malformedRequest = readCurioActionExtension({
    ...record,
    curio: {
      ...record.curio,
      request: { skill: 'walk_known_route', pathId: 'legacy-path' },
    },
  });
  assert.equal(malformedRequest.status, 'malformed');
  if (malformedRequest.status === 'malformed') assert.ok(malformedRequest.errors.some((error) => error.includes('fragmentId')));

  const malformedBudget = readCurioActionExtension({
    ...record,
    curio: { ...record.curio, budget: { ...record.curio.budget, effectiveDeadline: T0 + 1 } },
  });
  assert.equal(malformedBudget.status, 'malformed');
  if (malformedBudget.status === 'malformed') assert.ok(malformedBudget.errors.some((error) => error.includes('curio.budget')));
});

test('capture and prepare snapshots isolate caller inputs, receipts and evidence', () => {
  const points = [vec(0, 64, 0), vec(1, 64, 0), vec(2, 64, 0)];
  const input = walkToInput({
    request: { skill: 'walk_route', points },
    delegation: delegation({ requestedTarget: points[2]!, target: points[2]!, arrival: { kind: 'exact' } }),
  });
  const receipt = captured(captureNavigationReceipt(input));

  points[0]!.x = 99;
  input.delegation.target.x = 99;
  input.originalStart.pos.x = 99;
  input.budget.effectiveDeadline = T0 + 1;
  const capturedRequest = receipt.request;
  assert.ok(capturedRequest.skill === 'walk_route');
  assert.deepEqual(capturedRequest.points[0], vec(0, 64, 0));
  assert.deepEqual(receipt.delegation.target, vec(2, 64, 0));
  assert.deepEqual(receipt.originalStart.pos, vec(1.25, 64, -2.5));
  assert.deepEqual(receipt.budget, budget());

  const nav = cancelledNav();
  const evidence = evidenceFor(nav);
  const result = prepared(prepareNavigationAction(receipt, nav, evidence));

  receipt.delegation.target.x = 555;
  receipt.originalStart.pos.x = 555;
  receipt.budget.effectiveDeadline = T0 + 555;
  const mutableReceiptRequest = receipt.request;
  if (mutableReceiptRequest.skill === 'walk_route') mutableReceiptRequest.points[0]!.x = 555;
  evidence.subActions[0]!.kind = 'mutated';
  evidence.observedChanges[0]!.state.properties['x'] = 'mutated';

  const preparedRequest = result.record.curio.request;
  assert.ok(preparedRequest.skill === 'walk_route');
  assert.deepEqual(preparedRequest.points[0], vec(0, 64, 0));
  assert.deepEqual(result.record.delegation.target, vec(2, 64, 0));
  assert.deepEqual(result.record.from, vec(1.25, 64, -2.5));
  assert.deepEqual(result.record.curio.budget, budget());
  assert.equal(result.record.subActions[0]!.kind, 'move');
  assert.deepEqual(result.record.observedChanges[0]!.state.properties, {});
});

test('the adapter module has only type-only imports and no runtime game/store/timer/file side effects', () => {
  const source = readFileSync(new URL('../src/spatial/event-adapter.ts', import.meta.url), 'utf8');
  const importLines = source.split(/\r?\n/).filter((line) => line.startsWith('import '));
  assert.ok(importLines.length >= 3);
  assert.ok(importLines.every((line) => line.startsWith('import type ')), 'all imports must be type-only');
  assert.ok(importLines.some((line) => line.includes("'../arbiter/arbiter.ts'")), 'TaskSource is reused via a type-only Arbiter import');
  assert.doesNotMatch(source, /(^|\n)import\s+(?!type\b)/);
  assert.doesNotMatch(source, /from ['"][^'"]*\/config/);
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

test('real sqlite: pending→checkpoint→query/close/reopen retains extension, budget and partial snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-event-adapter-'));
  const dbPath = join(dir, 'memory.db');
  const worldId = sqliteWorldId('roundtrip');

  const startEvidence = start({ worldId, observedAt: T0 - 250 });
  const receipt = captured(captureNavigationReceipt(asCapture({
    ...walkToExactInput(),
    originalStart: startEvidence,
    budget: budget(),
  })));
  const nav = cancelledNav();
  const originalNav = structuredClone(nav);
  const action = prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav, worldId))).record;
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
        assert.equal('deadlineMs' in extension.extension.request, false);
        assert.deepEqual(extension.extension.originalStart, startEvidence);
        assert.deepEqual(extension.extension.budget, budget());
      }
      assert.deepEqual(storedAction.from, vec(1.25, 64, -2.5));
      assert.deepEqual(storedAction.result, originalNav);
      assert.equal(storedAction.result!.confirmed, false);
      assert.equal('failureAt' in storedAction, false);
      assert.equal('to' in storedAction, false);

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
        assert.deepEqual(extension.extension.budget, budget());
      }
      assert.deepEqual(storedAction.result, originalNav);
      assert.equal(storedAction.result!.memoryWrite, 'failed');
      assert.deepEqual(storedAction.result!.trace, originalNav.trace);
      assert.deepEqual(storedAction.result!.lastObservation, originalNav.lastObservation);
      assert.deepEqual(storedAction.result!.consumption, originalNav.consumption);

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

test('real sqlite: capacity/conflict/malformed rejection is atomic and the worker still closes', async () => {
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
        const receipt = captured(captureNavigationReceipt(asCapture({
          ...walkToExactInput(),
          invocationId,
          originalStart: start({ worldId }),
          request: { skill: 'walk_to', to, arrival: { kind: 'exact' } },
          delegation: delegation({ requestedTarget: to, target: to, arrival: { kind: 'exact' } }),
        })));
        const nav = cancelledNav();
        return { record: prepared(prepareNavigationAction(receipt, nav, evidenceFor(nav, worldId))).record, nav };
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

      const conflictingReceipt = captured(captureNavigationReceipt(asCapture({
        ...walkToExactInput(),
        invocationId: 'inv-a',
        originalStart: start({ worldId }),
        request: { skill: 'walk_to', to: vec(12, 64, -3.25), arrival: { kind: 'exact' } },
        delegation: delegation({
          requestedTarget: vec(12, 64, -3.25), target: vec(12, 64, -3.25), arrival: { kind: 'exact' },
        }),
      })));
      const conflictingNav = cancelledNav();
      const conflicting = prepared(prepareNavigationAction(conflictingReceipt, conflictingNav, evidenceFor(conflictingNav, worldId))).record;
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

// Compile-time coverage that the exported request/budget unions mirror the real producers.
const _arrival: ArrivalSpec = { kind: 'near', radius: 1 };
const _request: OriginalNavigationRequest = { skill: 'walk_known_route', fragmentId: 'frag' };
const _budget: OriginalExecutionBudget = budget();
const _recordType: HostActionRecord | null = null;
const _eventType: SpatialEvent | null = null;
void _arrival; void _request; void _budget; void _recordType; void _eventType;
