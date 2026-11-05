/**
 * WP7 生产者接缝测试：只写已确认的任务事实，缺失字段不被当前状态/lastPosition
 * 补齐；动作失败/取消/超时/迟到回调不产生错误归因；入队只报 pending，不称 saved；
 * 默认不注入生产者时完全没有 journal/异步副作用。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NavResult, Observation } from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { TaskCompletionFact, TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { sleep } from '../src/util.ts';
import {
  createTaskJournalProducer,
  prepareTaskJournalRecords,
  type TaskJournalGap,
  type TaskJournalPreparation,
} from '../src/spatial/journal-producer.ts';
import type {
  NavigationActionEvidence,
  PreparedJournalSink,
} from '../src/spatial/event-adapter.ts';
import { FakeAdapter } from './fake-adapter.ts';

const WORLD = 'journal-world';
const DIM = 'overworld';
const SESSION = 'journal-session';
const T0 = 1_700_000_000_000;
const DEADLINE = T0 + 30_000;

type FailureNav = Extract<NavResult, { outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED' }>;

function vec(x: number, y: number, z: number) {
  return { x, y, z };
}

function scope(at = T0, pos = vec(1.25, 64, -2.5)) {
  return { worldId: WORLD, dim: DIM, sessionId: SESSION, at, pos };
}

function lastObservation() {
  return { worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: T0 + 200, onGround: true, inWater: false };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    pos: vec(2, 64, -2.5),
    state: { name: 'grass_block', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    observedAt: T0 + 100,
    source: 'vision',
    sessionId: SESSION,
    originObservationId: 1,
    sequence: 1,
    dim: DIM,
    worldId: WORLD,
    ...overrides,
  };
}

function cancelledNav(overrides: Partial<FailureNav> = {}): FailureNav {
  return {
    outcome: 'CANCELLED',
    message: 'cancelled after partial movement',
    confirmed: false,
    trace: [
      { pos: vec(2, 64, -2.5), ts: T0 + 100 },
      { pos: vec(3, 64, -2.5), ts: T0 + 200 },
    ],
    lastPosition: vec(3, 64, -2.5),
    lastObservation: lastObservation(),
    problem: { kind: 'cancelled', by: 'agent', reason: 'parent task cancelled' },
    ...overrides,
  };
}

function arrivedNav(overrides: Partial<Extract<NavResult, { outcome: 'ARRIVED' }>> = {}): Extract<NavResult, { outcome: 'ARRIVED' }> {
  return {
    outcome: 'ARRIVED',
    message: 'arrived',
    confirmed: true,
    trace: [{ pos: vec(10.5, 64, -3.25), ts: T0 + 300 }],
    lastPosition: vec(10.5, 64, -3.25),
    lastObservation: { ...lastObservation(), observedAt: T0 + 300 },
    ...overrides,
  };
}

function evidence(overrides: Partial<NavigationActionEvidence> = {}): NavigationActionEvidence {
  return {
    consumption: { kind: 'known_empty' },
    subActions: [{ kind: 'move', origin: 'execution_helper', outcome: 'ok' }],
    observedChanges: [],
    ...overrides,
  };
}

function taskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 't_wp7_1',
    planVersion: 7,
    skill: 'walk_to',
    args: { to: vec(10.5, 64, -3.25), arrival: { kind: 'near', radius: 1.75 } },
    requestedArgs: { to: [10.5, 64, -3.25], arrival: { kind: 'near', radius: 1.75 } },
    source: 'llm' as const,
    startedAt: T0,
    deadline: DEADLINE,
    progress: 0,
    note: '',
    movement: true,
    ...overrides,
  };
}

function completion(overrides: Partial<TaskCompletionFact> = {}): TaskCompletionFact {
  const nav = cancelledNav();
  return {
    task: taskInfo(),
    result: { status: 'cancelled', summary: 'cancelled', data: { nav } },
    endedAt: T0 + 500,
    durationMs: 500,
    startScope: scope(),
    endScope: scope(T0 + 500, vec(3, 64, -2.5)),
    lateCompletion: false,
    ...overrides,
  };
}

function ready(prep: TaskJournalPreparation) {
  assert.equal(prep.status, 'ready', JSON.stringify(prep.gaps));
  if (prep.status !== 'ready') throw new Error('unreachable');
  return prep;
}

function refused(prep: TaskJournalPreparation) {
  assert.equal(prep.status, 'refused', JSON.stringify(prep));
  if (prep.status !== 'refused') throw new Error('unreachable');
  return prep.gaps;
}

function hasGap(gaps: readonly TaskJournalGap[], code: TaskJournalGap['code']) {
  return gaps.some((gap) => gap.code === code);
}

test('confirmed dispatch scope, time and result are preserved without later/current fill-in', () => {
  const nav = cancelledNav();
  const fact = completion({ endedAt: T0 + 9_999, durationMs: 9_999 });
  const prep = ready(prepareTaskJournalRecords(fact, evidence()));
  const record = prep.records.actions[0]!;

  assert.equal(record.id, 't_wp7_1@v7');
  assert.equal(record.ts, T0, 'ts is the measured dispatch time, not endedAt/current time');
  assert.deepEqual(record.from, vec(1.25, 64, -2.5));
  assert.equal(record.curio.originalStart.observedAt, T0, 'originalStart keeps the dispatch measurement time');
  assert.deepEqual(record.curio.originalStart.pos, vec(1.25, 64, -2.5));
  assert.deepEqual(record.curio.budget, {
    taskStartedAt: T0,
    taskDeadline: DEADLINE,
    effectiveDeadline: DEADLINE,
  });
  assert.equal(record.confirmed, false, 'confirmed is copied from NavResult, not invented');
  assert.deepEqual(record.delegation.target, vec(10.5, 64, -3.25));
  assert.deepEqual(record.delegation.arrival, { kind: 'near', radius: 1.75 });
  assert.deepEqual(record.trace, nav.trace);
  assert.deepEqual(record.result, nav);
  assert.equal(record.failureAt, undefined, 'lastPosition is not written as failureAt');
  assert.equal(record.to, undefined, 'non-ARRIVED does not project lastPosition to to');
  assert.deepEqual(record.result && 'lastPosition' in record.result ? record.result.lastPosition : null, vec(3, 64, -2.5));

  // The record owns an independent snapshot; mutating the caller's nav cannot change it.
  nav.trace[0]!.pos.x = 999;
  nav.message = 'mutated';
  assert.deepEqual(record.trace[0]!.pos, vec(2, 64, -2.5));
  assert.equal(record.result?.message, 'cancelled after partial movement');
});

test('missing start scope or ARRIVED observation scope is refused, never filled from current state/lastPosition', () => {
  const missingStart = refused(prepareTaskJournalRecords(
    completion({ startScope: null }),
    evidence(),
  ));
  assert.ok(hasGap(missingStart, 'missing_start_scope'));

  const arrived = arrivedNav({
    lastObservation: { ...lastObservation(), sessionId: 'other-session' },
  });
  const mismatched = refused(prepareTaskJournalRecords(
    completion({ result: { status: 'succeeded', summary: 'arrived', data: { nav: arrived } } }),
    evidence(),
  ));
  assert.ok(hasGap(mismatched, 'nav_scope_mismatch'));

  // A missing end scope is recorded as an explicit non-blocking gap, not synthesized.
  const noEnd = ready(prepareTaskJournalRecords(completion({ endScope: null }), evidence()));
  assert.ok(hasGap(noEnd.gaps, 'missing_end_scope'));
  assert.ok(noEnd.gaps.every((gap) => gap.code !== 'missing_end_scope' || !gap.blocking));
});

test('failure, cancellation and timeout keep the real result without inventing attribution', () => {
  const outcomes: FailureNav['outcome'][] = ['CANCELLED', 'TIMEOUT', 'FAILED', 'BLOCKED', 'NO_PATH'];
  for (const outcome of outcomes) {
    const nav = cancelledNav({ outcome } as Partial<FailureNav>) as FailureNav;
    const prep = ready(prepareTaskJournalRecords(
      completion({ result: { status: outcome === 'CANCELLED' ? 'cancelled' : 'failed', summary: outcome, data: { nav } } }),
      evidence(),
    ));
    const record = prep.records.actions[0]!;
    assert.equal(record.result?.outcome, outcome);
    assert.equal(record.to, undefined, `${outcome}: must not project lastPosition to to`);
    assert.equal(record.failureAt, undefined, `${outcome}: must not write failureAt from lastPosition`);
    assert.deepEqual(record.from, vec(1.25, 64, -2.5));
    assert.equal(record.failureReason, nav.message);
  }

  // PARTIAL may legitimately omit problem; it is still a real NavResult.
  const partial: NavResult = {
    outcome: 'PARTIAL',
    message: 'partial',
    confirmed: true,
    trace: [{ pos: vec(2, 64, -2.5), ts: T0 + 100 }],
    lastPosition: vec(2, 64, -2.5),
    lastObservation: lastObservation(),
  };
  const prep = ready(prepareTaskJournalRecords(
    completion({ result: { status: 'failed', summary: 'partial', data: { nav: partial } } }),
    evidence(),
  ));
  assert.equal(prep.records.actions[0]!.confirmed, true, 'confirmed is preserved verbatim');
  assert.equal(prep.records.actions[0]!.to, undefined);
});

test('late completion and completion scope changes are refused instead of attributed to another task', () => {
  const late = refused(prepareTaskJournalRecords(
    completion({ lateCompletion: true, endScope: null }),
    evidence(),
  ));
  assert.ok(hasGap(late, 'late_completion'));

  const changed = refused(prepareTaskJournalRecords(
    completion({ endScope: { ...scope(), sessionId: 'new-session' } }),
    evidence(),
  ));
  assert.ok(hasGap(changed, 'completion_scope_mismatch'));
});

test('walk_known_route requires an explicit resolved target; walk_route targets the last ordered point', () => {
  const knownNav = arrivedNav({ trace: [{ pos: vec(10.5, 64, -3.25), ts: T0 + 300 }] });
  const knownTask = taskInfo({
    skill: 'walk_known_route',
    args: { fragmentId: 'frag-1' },
    requestedArgs: { fragmentId: 'frag-1' },
  });
  const known = ready(prepareTaskJournalRecords(
    completion({
      task: knownTask,
      result: { status: 'succeeded', summary: 'arrived', data: { nav: knownNav, target: vec(10.5, 64, -3.25) } },
    }),
    evidence(),
  ));
  assert.equal(known.records.actions[0]!.delegation.requestedTarget, 'frag-1');
  assert.deepEqual(known.records.actions[0]!.delegation.target, vec(10.5, 64, -3.25));

  const missingTarget = refused(prepareTaskJournalRecords(
    completion({
      task: knownTask,
      result: { status: 'succeeded', summary: 'arrived', data: { nav: knownNav } },
    }),
    evidence(),
  ));
  assert.ok(hasGap(missingTarget, 'missing_resolved_target'));

  const routePoints = [vec(0, 64, 0), vec(1, 64, 0), vec(2, 64, 0)];
  const routeTask = taskInfo({
    skill: 'walk_route',
    args: { points: routePoints },
    requestedArgs: { points: routePoints },
  });
  const route = ready(prepareTaskJournalRecords(
    completion({
      task: routeTask,
      result: { status: 'succeeded', summary: 'arrived', data: { nav: arrivedNav({ lastPosition: vec(2, 64, 0) }) } },
    }),
    evidence(),
  ));
  assert.deepEqual(route.records.actions[0]!.delegation.requestedTarget, vec(2, 64, 0));
  assert.deepEqual(route.records.actions[0]!.delegation.target, vec(2, 64, 0));
  assert.deepEqual(route.records.actions[0]!.delegation.arrival, { kind: 'exact' });
});

test('missing action evidence and unknown consumption are refused, never written as empty arrays or zero', () => {
  const missingEvidence = refused(prepareTaskJournalRecords(completion()));
  assert.ok(hasGap(missingEvidence, 'missing_action_evidence'));

  const unknownConsumption = refused(prepareTaskJournalRecords(
    completion(),
    evidence({ consumption: undefined }),
  ));
  assert.ok(hasGap(unknownConsumption, 'missing_consumption_evidence'));

  const otherScope = refused(prepareTaskJournalRecords(
    completion(),
    evidence({ observedChanges: [observation({ worldId: 'other-world' })] }),
  ));
  assert.ok(hasGap(otherScope, 'evidence_scope_mismatch'));
});

test('measured consumption is derived only from a real NavResult.consumption', () => {
  const nav = cancelledNav({
    consumption: { placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }], durabilityLost: 2, digMs: 12 },
  });
  const prep = ready(prepareTaskJournalRecords(
    completion({ result: { status: 'cancelled', summary: 'cancelled', data: { nav } } }),
    evidence({ consumption: undefined }),
  ));
  assert.deepEqual(prep.records.actions[0]!.consumption, {
    placed: [{ pos: vec(3, 64, -2.5), name: 'minecraft:stone' }],
    durabilityLost: 2,
    digMs: 12,
  });
});

test('unsupported skills are skipped and never touch the sink', () => {
  const calls: unknown[] = [];
  const sink: PreparedJournalSink = {
    journal: { recordBatch: (batch) => { calls.push(batch); return { accepted: 1, duplicates: 0, revision: 1, pendingRecords: 1, pendingBytes: 1 }; } },
  };
  const producer = createTaskJournalProducer({ sink, evidenceFor: () => evidence() });
  const outcome = producer(completion({ task: taskInfo({ skill: 'explore', args: {} }) }));
  assert.equal(outcome.status, 'skipped');
  assert.equal(calls.length, 0);
  assert.ok(hasGap(outcome.gaps, 'unsupported_skill'));
});

test('over-limit caller input is refused structurally before writing', () => {
  const longRoute = Array.from({ length: 33 }, (_, index) => vec(index, 64, 0));
  const routeGaps = refused(prepareTaskJournalRecords(
    completion({
      task: taskInfo({ skill: 'walk_route', args: { points: longRoute }, requestedArgs: { points: longRoute } }),
      result: { status: 'succeeded', summary: 'arrived', data: { nav: arrivedNav() } },
    }),
    evidence(),
  ));
  const routeLimit = routeGaps.find((gap) => gap.code === 'limit_exceeded');
  assert.ok(routeLimit);
  assert.equal(routeLimit.limit, 32);
  assert.equal(routeLimit.actual, 33);

  const manyChanges = Array.from({ length: 33 }, (_, index) => observation({ sequence: index + 1 }));
  const changesGaps = refused(prepareTaskJournalRecords(
    completion(),
    evidence({ observedChanges: manyChanges }),
  ));
  assert.ok(hasGap(changesGaps, 'limit_exceeded'));

  const idGaps = refused(prepareTaskJournalRecords(
    completion({ task: taskInfo({ id: 'x'.repeat(513) }) }),
    evidence(),
  ));
  assert.ok(hasGap(idGaps, 'limit_exceeded'));
});

test('recordBatch acceptance reports pending, and rejection is bounded while retaining records', () => {
  const accepted = createTaskJournalProducer({
    sink: {
      journal: { recordBatch: () => ({ accepted: 1, duplicates: 0, revision: 3, pendingRecords: 2, pendingBytes: 64 }) },
    },
    evidenceFor: () => evidence(),
  });
  const acceptedOutcome = accepted(completion());
  assert.equal(acceptedOutcome.status, 'accepted_pending_checkpoint');
  assert.doesNotMatch(JSON.stringify(acceptedOutcome), /"saved"/);

  const rejection = Object.assign(new Error('journal capacity exceeded'), { kind: 'capacity', stack: 'secret stack' });
  const rejected = createTaskJournalProducer({
    sink: { journal: { recordBatch: () => { throw rejection; } } },
    evidenceFor: () => evidence(),
  });
  const rejectedOutcome = rejected(completion());
  assert.equal(rejectedOutcome.status, 'rejected');
  if (rejectedOutcome.status !== 'rejected') throw new Error('unreachable');
  assert.deepEqual(rejectedOutcome.error, {
    kind: 'capacity',
    name: 'Error',
    message: 'journal capacity exceeded',
  });
  assert.equal('stack' in rejectedOutcome.error, false, 'only bounded error facts are reported');
  assert.equal(rejectedOutcome.records.actions.length, 1, 'the original records remain available for explicit retry');
});

test('real sqlite: produced action is only pending-accepted until an explicit checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-journal-producer-'));
  const dbPath = join(dir, 'memory.db');
  let closedOk = false;
  try {
    const session = await openSpatialSession({ worldId: WORLD, databasePath: dbPath, timeoutMs: 5000 });
    try {
      const producer = createTaskJournalProducer({
        sink: { journal: session.journal },
        evidenceFor: () => evidence(),
      });
      const outcome = producer(completion());
      assert.equal(outcome.status, 'accepted_pending_checkpoint');
      if (outcome.status !== 'accepted_pending_checkpoint') throw new Error('expected acceptance');
      assert.ok(outcome.pendingRecords >= 1);
      assert.equal(session.getPersistenceState().committedJournalRecords, 0, 'acceptance is not persistence');

      const pending = session.journal.readPending();
      assert.equal(pending.actions.length, 1);
      assert.equal(pending.actions[0]!.id, 't_wp7_1@v7');
      assert.equal('failureAt' in pending.actions[0]!, false);

      const checkpoint = await session.checkpoint();
      assert.ok(checkpoint.journalRevision >= outcome.revision);
      assert.equal(session.getPersistenceState().committedJournalRecords, 1);
      const page = await session.queryActions({ actionId: 't_wp7_1@v7' });
      assert.equal(page.records.length, 1);
      assert.equal(page.records[0]!.result?.outcome, 'CANCELLED');
    } finally {
      const closed = await session.close();
      closedOk = closed.completed && closed.error === null;
      assert.equal(closedOk, true);
    }
  } finally {
    if (closedOk) rmSync(dir, { recursive: true, force: true });
    else console.error('preserved temp fixture:', dir);
  }
});

test('the producer module has no timer, clock, random-id or file side effects', () => {
  const source = readFileSync(new URL('../src/spatial/journal-producer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /set(?:Interval|Timeout)\s*\(/);
  assert.doesNotMatch(source, /new\s+Worker\s*\(/);
  assert.doesNotMatch(source, /randomUUID\s*\(/);
  assert.doesNotMatch(source, /writeFile|Bun\.write/);
  assert.doesNotMatch(source, /status:\s*'saved'/);
  assert.match(source, /accepted_pending_checkpoint/);

  const arbiterSource = readFileSync(new URL('../src/arbiter/arbiter.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(arbiterSource, /recordBatch/);
  assert.doesNotMatch(arbiterSource, /journal-producer|spatial\/event-adapter/);
});

function writeSkill(name: string, run: () => Promise<SkillResult>) {
  SKILLS[name] = {
    name,
    description: '',
    argsDoc: '{}',
    timeoutMs: 5000,
    movement: false,
    validate: () => ({ ok: true, args: {} }),
    run,
  };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await sleep(10);
  }
}

test('without an injected producer there is no journal call or producer event; injection receives measured facts', async () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  let journalCalls = 0;
  const spatial = {
    closing: false,
    setPaused: () => {},
    interrupt: () => {},
    session: { journal: { recordBatch: () => { journalCalls += 1; return { accepted: 1, duplicates: 0, revision: 1, pendingRecords: 1, pendingBytes: 1 }; } } },
  } as unknown as ConstructorParameters<typeof Arbiter>[4];
  const skillName = `test_wp7_default_off_${process.pid}`;
  writeSkill(skillName, async () => ({ status: 'succeeded', summary: 'ok' }));
  try {
    const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter), spatial);
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    arbiter.start({ skill: skillName }, 'llm');
    await done;
    assert.equal(journalCalls, 0, 'default-off path must not call recordBatch');
    assert.equal(bus.recent(20).some((event) => event.type === 'spatial_journal_producer_failed'), false);
    arbiter.dispose();
  } finally {
    delete SKILLS[skillName];
  }

  const facts: TaskCompletionFact[] = [];
  const adapter2 = new FakeAdapter();
  adapter2.pos = vec(4, 64, 5);
  const bus2 = new EventBus();
  const arbiter2 = new Arbiter(adapter2, new WorldMemory(null), bus2, new Vision(adapter2), undefined, (fact) => facts.push(fact));
  const skillName2 = `test_wp7_injected_${process.pid}`;
  writeSkill(skillName2, async () => ({ status: 'succeeded', summary: 'ok', data: { position: vec(4, 64, 5) } }));
  try {
    const done = new Promise<TaskOutcome>((resolve) => arbiter2.once('done', resolve));
    arbiter2.start({ skill: skillName2 }, 'llm');
    await done;
    assert.equal(facts.length, 1);
    const fact = facts[0]!;
    assert.equal(fact.task.skill, skillName2);
    assert.equal(fact.lateCompletion, false);
    assert.deepEqual(fact.startScope && {
      worldId: fact.startScope.worldId,
      dim: fact.startScope.dim,
      sessionId: fact.startScope.sessionId,
      pos: fact.startScope.pos,
    }, {
      worldId: 'fake-world',
      dim: 'overworld',
      sessionId: 'fake-session',
      pos: vec(4, 64, 5),
    });
    assert.ok(fact.endScope, 'still-owned completion keeps the measured end scope');
    assert.ok(fact.startScope!.at <= fact.endedAt);
    arbiter2.dispose();
  } finally {
    delete SKILLS[skillName2];
  }
});

test('a late completion reports null end scope and refuses production without a wrong-scope attribution', async () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const facts: TaskCompletionFact[] = [];
  const arbiter = new Arbiter(adapter, new WorldMemory(null), bus, new Vision(adapter), undefined, (fact) => facts.push(fact));
  const slowName = `test_wp7_slow_${process.pid}`;
  const quickName = `test_wp7_quick_${process.pid}`;
  writeSkill(slowName, async () => { await sleep(60); return { status: 'succeeded', summary: 'late success' }; });
  writeSkill(quickName, async () => ({ status: 'succeeded', summary: 'quick' }));
  try {
    const outcomes: TaskOutcome[] = [];
    arbiter.on('done', (outcome: TaskOutcome) => outcomes.push(outcome));
    const slow = arbiter.start({ skill: slowName }, 'llm');
    if (!('id' in slow)) throw new Error(`slow task was rejected: ${slow.error}`);
    await sleep(10);
    arbiter.start({ skill: quickName }, 'llm');
    await waitUntil(() => outcomes.length === 2, 'both tasks should settle');

    const slowFact = facts.find((fact) => fact.task.id === slow.id);
    assert.ok(slowFact, 'the slow task still reports its own fact');
    assert.equal(slowFact.lateCompletion, true);
    assert.equal(slowFact.endScope, null, 'late completion never borrows the new task state');
    assert.ok(slowFact.startScope, 'the measured dispatch scope is still the original one');

    // The producer is generic over skill names; use a navigation task shape with the
    // same measured late-completion fact to reach the attribution check.
    const lateNavigationFact: TaskCompletionFact = {
      ...slowFact,
      task: taskInfo({ id: slowFact.task.id, planVersion: slowFact.task.planVersion }),
    };
    const prep = prepareTaskJournalRecords(lateNavigationFact, evidence());
    assert.ok(hasGap(refused(prep), 'late_completion'));
    arbiter.dispose();
  } finally {
    delete SKILLS[slowName];
    delete SKILLS[quickName];
  }
});

test('a throwing producer cannot break task completion; failure is reported as a bounded event', async () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const arbiter = new Arbiter(adapter, new WorldMemory(null), bus, new Vision(adapter), undefined, () => {
    throw new Error('producer boom');
  });
  const name = `test_wp7_throw_${process.pid}`;
  writeSkill(name, async () => ({ status: 'succeeded', summary: 'ok' }));
  try {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    arbiter.start({ skill: name }, 'llm');
    const outcome = await done;
    assert.equal(outcome.result.status, 'succeeded');
    const failure = bus.recent(20).find((event) => event.type === 'spatial_journal_producer_failed');
    assert.ok(failure);
    assert.match(failure.msg, /producer boom/);
    assert.equal(failure.data?.taskId, outcome.task.id);
    arbiter.dispose();
  } finally {
    delete SKILLS[name];
  }
});
