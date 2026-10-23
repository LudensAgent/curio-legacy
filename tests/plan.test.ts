import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson, validatePlan } from '../src/planner/plan.ts';
import { FakeAdapter } from './fake-adapter.ts';

const adapter = new FakeAdapter();

test('能从 ```json 包裹或带前后缀的输出中提取 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，计划如下：{"a":{"b":2}} 祝好'), { a: { b: 2 } });
  assert.throws(() => extractJson('没有 JSON'));
});

test('合法计划通过校验，参数被规范化/截断到允许范围', () => {
  const v = validatePlan(
    { thought: 't', goal: '砍树', goal_type: 'gather', steps: [{ skill: 'gather', args: { block: 'log', count: 999 } }], abort_if: { hp_below: 6 } },
    adapter,
    'llm',
  );
  assert.ok(v.ok);
  if (v.ok) {
    assert.deepEqual(v.plan.steps[0], { skill: 'gather', args: { block: 'log', count: 32 } });
    assert.equal(v.plan.abortIf.hpBelow, 6);
  }
});

test('不存在的技能、隐藏技能、错误参数、过多步骤都会被拒绝', () => {
  const bad = [
    { goal: 'x', steps: [{ skill: 'fly' }] },
    { goal: 'x', steps: [{ skill: 'unstuck' }] },
    { goal: 'x', steps: [{ skill: 'explore', args: { direction: 'UP' } }] },
    { goal: 'x', steps: [] },
    { goal: 'x', steps: Array(6).fill({ skill: 'wander' }) },
    { steps: [{ skill: 'wander' }] },
    'not an object',
  ];
  for (const b of bad) assert.equal(validatePlan(b, adapter, 'llm').ok, false, JSON.stringify(b));
});
