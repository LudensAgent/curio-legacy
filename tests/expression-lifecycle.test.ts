import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExpressionProjection, type ExpressionContext } from '../src/observer/expression.ts';

// Pure event/time projection: no adapter, chat transport, game or Agent process.
test('expression follows plan/task ownership and suppresses repetitive micro-plans while preserving discoveries, progress and changed methods', (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const expression = new ExpressionProjection();
  const ctx: ExpressionContext = { state: { connected: true, alive: true, observationReady: true, worldId: 'world', sessionId: 'session', dim: 'overworld' },
    intent: { id: 'intent', text: '弄清这些材料有什么不同' }, plan: null, task: null };
  const emit = (type: string, data: Record<string, unknown> = {}) => expression.observe({ ts: now, type, data, msg: '', severity: 'P2' }, ctx);
  const start = (id: string, thought: string) => {
    ctx.plan = { id, goal: '另一个微计划标题', binding: { intentId: ctx.intent!.id } };
    emit('plan', { planId: id, source: 'llm', thought, steps: [{ skill: 'inspect_block', args: { target: 'stone' } }] });
    assert.equal(expression.snapshot(ctx).thought, '', 'a proposed plan is not an actual action');
    ctx.task = { id: `task-${id}`, planId: id, source: 'llm' };
    emit('task_start', { taskId: ctx.task.id, source: 'llm' });
  };
  start('one', '这块石头的纹理有点特别。');
  assert.equal(expression.snapshot(ctx).planId, 'one');
  assert.equal(expression.snapshot(ctx).goal, ctx.intent!.text, 'a micro-plan does not replace the current interest title');
  start('two', '我再仔细看看这块石头的纹理。');
  assert.equal(expression.snapshot(ctx).thought, '', 'rewording the same action without new evidence stays quiet');
  emit('discovery', { category: 'block', name: 'granite' });
  start('three', '这次看到了另一种纹理。');
  assert.equal(expression.snapshot(ctx).thought, '这次看到了另一种纹理。');
  emit('task_end', { taskId: 'task-one', status: 'cancelled' });
  assert.equal(expression.snapshot(ctx).planId, 'three', 'a late old cancellation cannot clear the new action');
  emit('attempt_end', { planId: 'two', effectEvidence: { verified: true, changed: true } });
  start('four', '这些纹理确实不同。');
  assert.equal(expression.snapshot(ctx).thought, '这些纹理确实不同。');
  emit('intent_decision', { decision: { kind: 'change_method' } });
  start('five', '换个角度也许看得更清楚。');
  assert.equal(expression.snapshot(ctx).thought, '换个角度也许看得更清楚。');
  emit('attempt_end', { planId: 'five', prediction: { outcome: 'not_observed' } });
  start('reconsider', '刚才没有出现预想的变化，我得重新想想。');
  assert.equal(expression.snapshot(ctx).planId, 'reconsider', 'a contradicted prediction is a new thought even without physical progress');
  ctx.task = { id: 'reflex', source: 'reflex' };
  emit('task_start', { taskId: 'reflex', source: 'reflex' });
  assert.equal(expression.pendingSpeech(ctx), null, 'survival control clears the old attempted-action speech');
  now += 2000;
  emit('intent_decision', { decision: { kind: 'change_method' } });
  start('six', '我先确认另一种做法。');
  now += 10_001;
  assert.equal(expression.pendingSpeech(ctx), null, 'even a still-active task cannot keep old speech pending indefinitely');
  assert.equal(expression.snapshot(ctx).thought, '');
});
