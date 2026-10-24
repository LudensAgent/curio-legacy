import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Executive } from '../src/brain/executive.ts';

// Exercise scheduling only: no Executive timers, skills, model calls or game execution.
function scheduler(t: TestContext) {
  const now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const state = { worldId: 'w', dim: 'overworld', sessionId: 's' };
  const feedback: any = { repeatedStepPattern: null, recentAttempts: [] };
  const executive: any = Object.assign(Object.create(Executive.prototype), {
    d: { adapter: { state: () => state }, memory: { currentIntent: () => ({ id: 'intent' }) }, planner: { autonomous: true } },
    decisionFeedback: { context: () => feedback }, lastFailure: null, userSuggestion: null,
    lightStreak: 0, lastFullAt: now, lastReflectionAt: now, reflectPending: null,
    inFlight: false, backoffUntil: 0, queued: null, plan: null,
  });
  const choose = () => executive.chooseTier({ reason: 'no_goal', worldState: state, decisionFeedback: feedback, lastFailure: executive.lastFailure });
  const repeat = (count: number, changed = false) => {
    feedback.repeatedStepPattern = { steps: [{ skill: 'use_item', args: { item: 'stone' } }], consecutiveUnchangedAttempts: count };
    feedback.recentAttempts = [{ effectEvidence: { verified: changed, changed, reasons: [] } }];
  };
  return { executive, state, choose, repeat };
}

test('new mechanism or path failures deliberate once while ordinary recoverable failures remain light', (t) => {
  const w = scheduler(t);
  assert.equal(w.choose(), 'light');
  for (const code of ['MISSING_MATERIALS', 'NOT_FOUND']) {
    w.executive.lastFailure = { skill: 'gather', code, summary: 'known recovery' };
    assert.equal(w.choose(), 'light');
  }
  w.executive.lastFailure = { skill: 'goto', code: 'PATH_NOT_FOUND', summary: 'no route' };
  assert.equal(w.executive.wouldBeFull(), true);
  assert.equal(w.executive.wouldBeFull(), true, 'duration estimation does not consume the evidence');
  assert.equal(w.choose(), 'full');
  assert.equal(w.executive.wouldBeFull(), false);
  assert.equal(w.choose(), 'light', 'the same failure object does not force every request to deliberate');
  w.executive.lastFailure = { skill: 'use_item', code: 'NO_EFFECT', summary: 'unexpected outcome' };
  assert.equal(w.choose(), 'full');
  w.executive.lastFailure = { skill: 'experiment_method', code: 'ERROR', summary: 'hypothesis failed' };
  assert.equal(w.choose(), 'full');
});

test('unchanged attempts deliberate by fresh evidence segment and experiments wait for their outcome', (t) => {
  const w = scheduler(t);
  w.repeat(1); assert.equal(w.choose(), 'light');
  w.repeat(2); assert.equal(w.executive.wouldBeFull(), true); assert.equal(w.choose(), 'full');
  assert.equal(w.choose(), 'light', 'the same two unchanged attempts are not new evidence');
  w.repeat(3); assert.equal(w.choose(), 'light');
  w.repeat(4); assert.equal(w.choose(), 'full', 'two further unchanged attempts justify reconsidering the method');
  w.repeat(0, true); assert.equal(w.choose(), 'light');
  w.repeat(2); assert.equal(w.choose(), 'full', 'actual progress resets the old repeat segment');
  w.state.sessionId = 'respawn'; assert.equal(w.choose(), 'full', 'scope changes reset deliberation bookkeeping');
  w.executive.plan = { id: 'plan', index: 1, steps: [{ skill: 'experiment_method' }] };
  const current = { planId: 'plan', skill: 'experiment_method', progress: 0.99 };
  assert.equal(w.executive.requestReason(current), null, 'experimental progress is not its verified outcome');
  assert.equal(w.executive.requestReason({ ...current, skill: 'trial:new_method:v1' }), null);
  assert.equal(w.executive.requestReason({ ...current, skill: 'craft' }), 'prefetch', 'ordinary quick continuations retain prefetch');
});
