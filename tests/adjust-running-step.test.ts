import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivity, nextStep, afterStep } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const step = (n: number) => ({ skill: 'mind_step', args: { n } });

function adjust(steps: ReturnType<typeof step>[], original = [step(1), step(2), step(3)], repeat = 1) {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '原来的活', why: '', kind: 'other', steps: original, repeat: 1 }, '', 'llm', adapter.state());
  nextStep(activity);
  nextStep(activity);
  const running = { skill: 'mind_step', args: { n: 2 }, planId: activity.id };
  const cancelled: string[] = [];
  const context = {
    activity, staleDropped: 0,
    applySkill() {}, applyPlan() {}, guardFocus() {}, safe: () => undefined,
    d: { arbiter: { info: () => running, cancel: (reason: string) => cancelled.push(reason) },
      adapter, perception: { snapshot: () => undefined }, bus: { publish() {} } },
  };
  const decision = { kind: 'adjust', tier: 'glance', source: 'llm', monologue: '', notes: [],
    activity: { what: '调整后的活', why: '', kind: 'other', steps, repeat } };
  (Mind.prototype as any).apply.call(context, decision, activity.id);
  return { activity, adapter, cancelled };
}

test('调整剩余步骤时保留正在执行的同一步，完成后执行新的下一步', () => {
  const { activity, adapter, cancelled } = adjust([step(2), step(4)]);
  assert.deepEqual(cancelled, []);
  assert.equal(activity.index, 1);
  assert.equal(afterStep(activity, step(2), ok('完成'), 100, adapter.state()).kind, 'continue');
  assert.deepEqual(nextStep(activity), step(4));
});

test('调整保留已完成前缀时，不重做前缀和当前步骤', () => {
  const { activity, cancelled } = adjust([step(1), step(2), step(4)]);
  assert.deepEqual(cancelled, []);
  assert.equal(activity.index, 2);
  assert.deepEqual(nextStep(activity), step(4));
});

test('重复步骤优先保留已完成前缀，后续轮次仍按新计划执行', () => {
  const { activity, cancelled } = adjust([step(2), step(2), step(4)], [step(2), step(2), step(3)], 2);
  assert.deepEqual(cancelled, []);
  assert.equal(activity.index, 2);
  assert.deepEqual(nextStep(activity), step(4));
  assert.deepEqual(nextStep(activity), step(2));
  assert.equal(activity.iteration, 1);
});

test('当前步骤参数变了，或新步骤排在当前动作之前，立即取消并从新计划开始', () => {
  for (const steps of [[step(5), step(4)], [step(9), step(2), step(4)]]) {
    const { activity, cancelled } = adjust(steps);
    assert.deepEqual(cancelled, ['改了做法']);
    assert.equal(activity.index, 0);
    assert.deepEqual(nextStep(activity), steps[0]);
  }
});
