import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import { WorkingFocus } from '../src/brain/working-focus.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { validatePlan, type Plan } from '../src/planner/plan.ts';

const state = (): AgentState => ({ connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1,
  username: 'test', pos: { x: .5, y: 64, z: .5 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20, timeOfDay: 1000, isDay: true,
  biome: null, onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null });
const plan = (id = 'p'): Plan => ({ id, source: 'llm', goal: '验证眼前的操作', goalType: 'investigate', thought: '', createdAt: 0,
  retries: 0, index: 1, abortIf: {}, binding: { intentId: 'i' }, steps: [{ skill: 'wait', args: { seconds: 2 } }],
  focus: { approach: '比较一次操作前后的变化', question: '是否会得到目标物品？' },
  expect: { type: 'inventory_min', item: 'bread', count: 1 } });

test('ordinary plans validate optional subjective focus and supported predictions without changing legacy input', (t) => {
  const memory = new WorldMemory(null); memory.setWorld('w'); t.after(() => memory.close());
  const adapter = { state, isKnownItem: (name: string) => name === 'bread' } as unknown as GameAdapter;
  const raw = { goal: '试一次', steps: [{ skill: 'wait', args: { seconds: 2 } }], focus: { approach: '观察变化', question: null },
    expect: { type: 'inventory_min', item: 'bread', count: 1 } };
  const valid = validatePlan(raw, adapter, 'llm', memory);
  assert.ok(valid.ok); if (valid.ok) { assert.deepEqual(valid.plan.focus, raw.focus); assert.deepEqual(valid.plan.expect, raw.expect); }
  assert.equal(validatePlan({ ...raw, expect: { type: 'game_won' } }, adapter, 'llm', memory).ok, false);
  assert.equal(validatePlan({ ...raw, focus: { question: 42 } }, adapter, 'llm', memory).ok, false);
  assert.equal(validatePlan({ goal: '旧计划', steps: raw.steps }, adapter, 'llm').ok, true);
});

test('prediction outcomes use before/after observations and stable mismatch IDs rather than skill success', () => {
  const focus = new WorkingFocus(), p = plan(), s = state();
  focus.begin(p, s);
  const missed = focus.end(p, 'succeeded', { ...s, observationId: 2 }, undefined, '步骤返回成功')!;
  assert.equal(missed.prediction?.outcome, 'not_observed');
  assert.equal(missed.prediction?.after.status, 'unsatisfied');
  const event = focus.context(s, 'i').pendingMismatch?.eventId;
  assert.ok(event); assert.equal(focus.context(s, 'i').pendingMismatch?.eventId, event, 'sampling does not invent another surprise');
  const p2 = plan('p2'); p2.focus = { question: null };
  focus.begin(p2, { ...s, observationId: 2 });
  const met = focus.end(p2, 'failed', { ...s, observationId: 3, inventory: [{ name: 'bread', count: 1 }] })!;
  assert.equal(met.prediction?.outcome, 'matched', 'a reported execution failure does not erase a measured effect');
  assert.equal(focus.context(s, 'i').subjectives.approach, p.focus?.approach);
  assert.equal(focus.context(s, 'i').subjectives.question, null);
  assert.equal(focus.context(s, 'i').pendingMismatch, null);
  assert.deepEqual(focus.context(s, 'other-intent').recentAttempts, [], 'old intent reasoning is not applied to the next interest');
});

test('unknown, already true and interrupted predictions never become new learning or counterexamples', () => {
  const focus = new WorkingFocus(), s = state(), p = plan();
  p.expect = { type: 'block_state', dimension: 'overworld', pos: { x: 2, y: 64, z: 0 }, name: 'air' };
  focus.begin(p, s, { observeBlocks: () => [] });
  const observed = { name: 'air', properties: {}, pos: { x: 2, y: 64, z: 0 }, worldId: 'w', sessionId: 's', dimension: 'overworld', observationId: 2, observedAt: Date.now(), source: 'vision' as const };
  const unknown = focus.end(p, 'succeeded', { ...s, observationId: 2 }, { observeBlocks: () => [observed] })!;
  assert.equal(unknown.prediction?.outcome, 'unknown', 'an unknown baseline cannot prove the action changed anything');
  assert.equal(focus.context(s, 'i').pendingMismatch, null);
  const old = plan('old'), held = { ...s, inventory: [{ name: 'bread', count: 1 }] };
  focus.begin(old, held); assert.equal(focus.end(old, 'succeeded', { ...held, observationId: 3 })?.prediction?.outcome, 'already_satisfied');
  const interrupted = plan('stop'); focus.begin(interrupted, s);
  assert.equal(focus.end(interrupted, 'interrupted', { ...s, observationId: 4 })?.prediction?.outcome, 'interrupted');
  const ordinary = plan('ordinary'); delete ordinary.expect; delete ordinary.focus;
  ordinary.steps.push({ skill: 'dig', args: { target: 'stone' } }); ordinary.index = 1;
  focus.begin(ordinary, s); const result = focus.end(ordinary, 'failed', { ...s, observationId: 5 });
  assert.equal(result?.prediction, undefined); assert.equal(result?.attemptedSteps.length, 1);
  const large = plan('large'); large.goal = '长'.repeat(60);
  large.focus = { approach: '主'.repeat(240), question: '问'.repeat(240) }; large.then = '后'.repeat(140);
  large.expect = { type: 'all_of', conditions: Array.from({ length: 16 }, () => ({ type: 'inventory_min' as const, item: 'bread', count: 1 })) };
  large.steps = Array.from({ length: 6 }, () => ({ skill: 'wait', args: { note: '细节'.repeat(1000) } })); large.index = 6;
  focus.begin(large, s); focus.end(large, 'succeeded', { ...s, observationId: 6 }, undefined, '结果'.repeat(140));
  focus.begin({ ...large, id: 'next' }, s);
  assert.ok(Buffer.byteLength(JSON.stringify(focus.context(s, 'i')), 'utf8') <= 5000);
  assert.deepEqual(focus.context({ ...s, sessionId: 'new' }, 'i').recentAttempts, []);
});
