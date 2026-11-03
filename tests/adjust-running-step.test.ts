import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
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
  // 草案里动作+参数相同的步骤按旧实例 ID 引用（模拟模型按 ID 续跑同一实例；重复参数按先后占用区分实例）。
  const claimed = new Set<string>();
  const withIds = steps.map((s) => {
    const old = activity.steps.find((o) => o.id !== undefined && !claimed.has(o.id) && o.skill === s.skill && isDeepStrictEqual(o.args ?? {}, s.args ?? {}));
    if (old) { claimed.add(old.id!); return { ...s, id: old.id }; }
    return s;
  });
  const cancelled: string[] = [];
  const context = {
    activity, staleDropped: 0,
    applySkill() {}, applyPlan() {}, guardFocus() {}, safe: () => undefined,
    d: { arbiter: { info: () => running, cancel: (reason: string) => cancelled.push(reason) },
      adapter, perception: { snapshot: () => undefined }, bus: { publish() {} } },
  };
  const decision = { kind: 'adjust', tier: 'glance', source: 'llm', monologue: '', notes: [],
    activity: { what: '调整后的活', why: '', kind: 'other', steps: withIds, repeat } };
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

/** climb 账本 + 取消顺序的调整探针：climb_up 已爬 1 格（spent=1），提交草案看是否取消/保留。 */
function climbAdjust(draftSteps: { skill: string; args?: unknown; id?: string }[], climbSpent = 1) {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬5格', why: '', kind: 'other', steps: [{ skill: 'climb_up', args: { height: 5, untilSky: false } }], repeat: 1 }, '', 'llm', adapter.state());
  const stepId = activity.steps[0].id!;
  activity.climb = { [stepId]: { height: 5, spent: climbSpent, startY: 64 } };
  nextStep(activity);
  const running = { skill: 'climb_up', args: { height: 5, untilSky: false }, planId: activity.id };
  const cancelled: string[] = [];
  const context = {
    activity, staleDropped: 0,
    applySkill() {}, applyPlan() {}, guardFocus() {}, safe: () => undefined,
    d: { arbiter: { info: () => running, cancel: (reason: string) => cancelled.push(reason) },
      adapter, perception: { snapshot: () => undefined }, bus: { publish() {} } },
  };
  const decision = { kind: 'adjust', tier: 'glance', source: 'llm', monologue: '', notes: [],
    activity: { what: '调整', why: '', kind: 'other', steps: draftSteps, repeat: 1 } };
  (Mind.prototype as any).apply.call(context, decision, activity.id);
  return { activity, cancelled, decision, stepId };
}

test('非法恢复调整被拒后不取消原任务、账本保持，原爬升可继续完成', () => {
  const { activity, cancelled, decision, stepId } = climbAdjust([{ skill: 'use_skill', args: { name: 'recover', failure: { skill: 'climb_up', args: { height: 5 }, climbId: 'missing', climb: { height: 5, spent: 0, startY: 64 } } } }]);
  assert.deepEqual(cancelled, [], '拒绝不取消原任务');
  assert.equal(activity.climb[stepId].spent, 1, '账本保持 spent=1');
  assert.match(decision.notes.join(''), /父账本/, '给出明确拒绝原因');
});

test('合法重排仍取消旧任务并启动新计划', () => {
  const { activity, cancelled } = climbAdjust([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  assert.deepEqual(cancelled, ['改了做法']);
  assert.equal(activity.index, 0);
});
