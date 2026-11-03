import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep, viewOf } from '../src/mind/activity.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('optional step not arrived → a following relative dig_at reports the dependency gap', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '移动到旁边再挖', why: '', kind: 'other', repeat: 1,
    steps: [
      { skill: 'step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'dig_at', args: { at: [0, 0, 1], facing: 'E' } },
    ] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  assert.equal(step.skill, 'step');
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到 [1,0,0]：目标格未看清'), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match((verdict as { why: string }).why, /没到新站位/);
});

test('optional step not arrived → an absolute dig (xyz) still continues (independent)', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '走过去挖指定方块', why: '', kind: 'other', repeat: 1,
    steps: [
      { skill: 'step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'dig_at', args: { xyz: { x: 10, y: 64, z: 10 } } },
    ] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到 [1,0,0]'), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '绝对坐标不依赖新站位，独立执行');
});

test('a step that cannot see support in the dark reports the gap without spending a torch', () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('torch', 3);
  adapter.light = 0; // 暗处
  const activity = createActivity({ what: '迈一步', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'step', args: { at: [1, 0, 0], facing: 'E' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const percept = { self: { around: '脚下未知' }, light: { level: 'dark' } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到 [1,0,0]：目标格未看清，无法确认支撑', { movementNotAttempted: true, obscured: true }), 100, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((x) => x.startsWith('light:')), '不自动插火把');
  assert.ok(!activity.adaptations.some((x) => x.startsWith('retry:')), '不原样重试');
});

test('viewOf ignores head turn (vision/view and nearby resources), keeping only contact facts', () => {
  const a = viewOf({ self: { around: 'contact-A' }, vision: { view: 'look-east' }, nearby: { resources: [] } } as never);
  const b = viewOf({ self: { around: 'contact-A' }, vision: { view: 'look-west' }, nearby: { resources: [{ seen: 'now', name: 'oak_log' }] } } as never);
  assert.equal(a, b);
});

test('a head turn alone (view change) does not re-try the same gap', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '往东走', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'goto', args: { target: 'E 10' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0, y: 64, z: 0 }, view: '{"around":"contact"}' };
  const percept = { self: { around: 'contact' }, vision: { view: 'turned-around' }, nearby: { resources: [] } };
  const verdict = afterStep(activity, step, fail('STUCK', '卡住了'), 100, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((x) => x.startsWith('retry:')), '转头不触发原样重试');
});
