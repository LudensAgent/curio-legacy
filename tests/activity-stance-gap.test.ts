import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep, viewOf } from '../src/mind/activity.ts';
import { SKILLS } from '../src/skills/index.ts';
import { relativeCellAction } from '../src/skills/stance.ts';
import { fail, runSkill, validateSkill } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('relativeCellAction：xyz 绝对目标优先，派生的 at 不算依赖站位', () => {
  assert.equal(relativeCellAction('dig_at', { at: [1, 0, 0] }), true, '水平相对');
  assert.equal(relativeCellAction('dig_at', { at: [0, -1, 0] }), true, '竖直相对');
  assert.equal(relativeCellAction('dig_at', { at: [0, 0, 0] }), true, '零偏移相对');
  assert.equal(relativeCellAction('place_at', { at: [0, 0, 0], item: 'cobblestone' }), true, '放置零偏移相对');
  assert.equal(relativeCellAction('dig_at', { xyz: { x: 10, y: 64, z: 10 } }), false, 'xyz 绝对');
  assert.equal(relativeCellAction('dig_at', { xyz: { x: 10, y: 64, z: 10 }, at: [1, 0, 0] }), false, 'xyz 优先于派生 at');
  assert.equal(relativeCellAction('dig_at', { abs: [10, 64, 10] }), false, 'abs 绝对');
  assert.equal(relativeCellAction('step', { at: [1, 0, 0] }), false, 'step 是移动不是依赖动作');
  assert.equal(relativeCellAction('goto', { target: 'E 10' }), false, 'goto 不是相对格动作');
});

test('真实校验链：xyz 绝对目标经 validateSkill 后仍带 xyz，不被派生 at 误拦', () => {
  const adapter = new FakeAdapter();
  const abs = validateSkill(SKILLS.dig_at!, { xyz: [1, 64, 1], facing: 'E' }, adapter);
  assert.ok(abs.ok);
  const absArgs = (abs as { args: Record<string, unknown> }).args;
  assert.ok(absArgs.xyz !== undefined, '绝对目标保留 xyz');
  assert.equal(relativeCellAction('dig_at', absArgs), false);
  const rel = validateSkill(SKILLS.dig_at!, { at: [0, -1, 0], facing: 'E' }, adapter);
  assert.ok(rel.ok);
  const relArgs = (rel as { args: Record<string, unknown> }).args;
  assert.equal(relArgs.xyz, undefined, '相对目标没有 xyz');
  assert.equal(relativeCellAction('dig_at', relArgs), true);
});

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
  assert.match((verdict as { why: string }).why, /身体现在在/);
});

test('vertical and zero-offset relative dig also depend on the missed stance', () => {
  for (const at of [[0, -1, 0], [0, 0, 0]] as const) {
    const adapter = new FakeAdapter();
    const activity = createActivity({ what: '移动后挖', why: '', kind: 'other', repeat: 1,
      steps: [
        { skill: 'step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
        { skill: 'dig_at', args: { at: [...at], facing: 'E' } },
      ] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
    const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到'), 100, adapter.state());
    assert.equal(verdict.kind, 'stuck', `at=${at.join(',')}`);
  }
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

test('use_skill 声明式步骤：optional 移动未到达后不再执行相对挖掘', async (t) => {
  const adapter = new FakeAdapter();
  t.mock.method(adapter, 'moveTo', async () => { throw new Error('No path'); });
  setBehaviorRegistry({
    get: (name: string) => name === 'walk-then-dig' ? { name, description: '', steps: [
      { skill: 'step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'dig_at', args: { at: [0, 0, 1], facing: 'E' } },
    ] } : undefined,
    list: () => [{ name: 'walk-then-dig' }],
  } as never);
  t.after(() => setBehaviorRegistry(null));
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const result = await runSkill(ctx, useSkill, { name: 'walk-then-dig' });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /没到新站位/);
  assert.match(result.summary, /相对坐标/);
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
