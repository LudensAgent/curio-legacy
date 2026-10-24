import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Executive } from '../src/brain/executive.ts';
import type { Plan } from '../src/planner/plan.ts';

const plan = (steps: Plan['steps']): Plan => ({ id: 'plan', source: 'llm', thought: '', goal: '继续当前兴趣', goalType: 'explore',
  steps, index: 1, generation: 0, createdAt: Date.now(), retries: 0, abortIf: {} });

// Exercise the executive protocol only: no actual skills, model calls or game simulation.
function fixture(p: Plan) {
  const starts: string[] = [], finishes: { status: string; steps: Plan['steps'] }[] = [], events: string[] = [];
  const executive = Object.assign(Object.create(Executive.prototype), {
    plan: p, queued: null, inFlight: false, backoffUntil: 0, paused: false, generation: 0, staleDropped: 0,
    durations: new Map(), planEffects: [], gentlyPreemptedTasks: new Set(),
    d: { planner: { autonomous: true }, bus: { publish: (type: string) => events.push(type) },
      arbiter: { info: () => null, start: (step: { skill: string }) => { starts.push(step.skill); return { id: 'next' }; } },
      memory: { activeProject: () => undefined } },
    planCurrent: () => true, sameBinding: () => true, recordResult() {}, keepThinkingActive() {}, nearlyDone: () => true,
    invalidate() { this.generation++; this.queued = null; this.inFlight = false; },
    finishPlan(this: any, status: string) { finishes.push({ status, steps: this.plan.steps }); this.plan = null; },
  });
  const done = (skill: string) => executive.onDone({ task: { id: 'task', planId: p.id, source: 'llm', skill, args: {} },
    result: { status: 'succeeded', summary: '实际结果已返回' }, durationMs: 100 });
  return { executive, starts, finishes, events, done };
}

test('unknown hunt output returns the remaining choice to the model while a deterministic craft chain continues', () => {
  const w = fixture(plan([{ skill: 'hunt', args: { count: 2 } }, { skill: 'smelt', args: { item: 'beef', count: 2 } }]));
  w.done('hunt');
  assert.equal(w.executive.plan, null);
  assert.deepEqual(w.finishes[0].steps.map((step) => step.skill), ['hunt'], 'unexecuted assumed processing is not recorded as a successful routine');
  assert.deepEqual(w.starts, []);
  assert.ok(w.events.includes('decision_boundary'));
  const known = fixture(plan([{ skill: 'craft', args: { item: 'stick', count: 4 } }, { skill: 'craft', args: { item: 'torch', count: 4 } }]));
  known.done('craft'); known.executive.startNext();
  assert.deepEqual(known.starts, ['craft']);
  assert.deepEqual(known.finishes, []);
});

test('prefetch waits for uncertain current or pending outcomes without delaying deterministic craft', () => {
  for (const skill of ['hunt', 'explore', 'experiment_method', 'trial:idea:v1']) {
    const w = fixture(plan([{ skill }]));
    assert.equal(w.executive.requestReason({ skill, planId: 'plan', progress: 0.99 }), null, skill);
  }
  const pending = fixture(plan([{ skill: 'craft' }, { skill: 'pickup_items' }]));
  assert.equal(pending.executive.requestReason({ skill: 'craft', planId: 'plan', progress: 0.99 }), null, 'a quick pending pickup still has unknown output');
  const known = fixture(plan([{ skill: 'craft' }]));
  assert.equal(known.executive.requestReason({ skill: 'craft', planId: 'plan', progress: 0.99 }), 'prefetch');
});

test('an old speculative choice that crossed an outcome boundary is rejected before activation side effects', () => {
  const w = fixture(plan([{ skill: 'craft' }]));
  const candidate = { ...plan([{ skill: 'smelt', args: { item: 'beef', count: 2 } }]),
    basis: { at: Date.now(), reason: 'prefetch', pending: [{ skill: 'hunt', args: { count: 2 } }] }, decision: { kind: 'continue' } };
  assert.equal(w.executive.activate(candidate), false);
  assert.equal(w.executive.staleDropped, 1);
  assert.deepEqual(w.starts, []);
  assert.ok(w.events.includes('plan_stale'));
});
