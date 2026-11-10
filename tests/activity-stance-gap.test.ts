import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep, viewOf } from '../src/mind/activity.ts';
import { SKILLS } from '../src/skills/index.ts';
import { relativeCellAction } from '../src/skills/stance.ts';
import { fail, runSkill, validateSkill } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

/** 经真实校验链得到规范化参数，再判断是否依赖站位。 */
function normalized(skill: keyof typeof SKILLS, raw: unknown) {
  const v = validateSkill(SKILLS[skill]!, raw, new FakeAdapter());
  assert.ok(v.ok, `validateSkill 应通过：${JSON.stringify(raw)}`);
  return relativeCellAction(skill as string, (v as { args: Record<string, unknown> }).args);
}

test('relativeCellAction 用规范化参数判断：无效绝对字段不能绕过', () => {
  assert.equal(normalized('mine_cell', { at: [1, 0, 0], facing: 'E' }), true, '水平相对');
  assert.equal(normalized('mine_cell', { at: [0, -1, 0], facing: 'E' }), true, '竖直相对');
  assert.equal(normalized('mine_cell', { at: [0, 0, 0], facing: 'E' }), true, '零偏移相对');
  assert.equal(normalized('place_cell', { at: [0, 0, 0], item: 'cobblestone', facing: 'E' }), true, '放置零偏移相对');
  assert.equal(normalized('mine_cell', { xyz: [1, 64, 1], facing: 'E' }), false, '合法 xyz 绝对');
  assert.equal(normalized('mine_cell', { xyz: [1, 64, 1], at: [1, 0, 0], facing: 'E' }), false, '合法 xyz 优先于派生 at');
  assert.equal(normalized('mine_cell', { xyz: null, at: [0, 0, 1], facing: 'E' }), true, 'xyz:null 被校验丢弃，按相对执行，不能绕过');
  assert.equal(validateSkill(SKILLS.mine_cell!, { xyz: 'invalid', at: [0, 0, 1], facing: 'E' }, new FakeAdapter()).ok, false, 'xyz:"invalid" 必须被拒绝');
});

test('afterStep 记录站位缺口事实，不在此用原始参数判断', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '移动到旁边再挖', why: '', kind: 'other', repeat: 1,
    steps: [
      { skill: 'move_step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'mine_cell', args: { at: [0, 0, 1], facing: 'E' } },
    ] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  assert.equal(step.skill, 'move_step');
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到 [1,0,0]：目标格未看清'), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', 'afterStep 不终止，只记下事实交给下一步校验');
  assert.deepEqual(activity.stanceGap?.skill, 'move_step');
  assert.ok(activity.stanceGap?.pos);
});

test('use_skill 声明式步骤：optional 移动未到达后不再执行相对挖掘', async (t) => {
  const adapter = new FakeAdapter();
  t.mock.method(adapter, 'moveTo', async () => { throw new Error('No path'); });
  setBehaviorRegistry({
    get: (name: string) => name === 'walk-then-dig' ? { name, description: '', steps: [
      { skill: 'move_step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'mine_cell', args: { at: [0, 0, 1], facing: 'E' } },
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
  assert.equal(adapter.actions.filter((a) => a.startsWith('dig')).length, 0, '不应发生挖掘副作用');
});

test('use_skill：xyz:null 无效绝对字段不能绕过依赖检查', async (t) => {
  const adapter = new FakeAdapter();
  t.mock.method(adapter, 'moveTo', async () => { throw new Error('No path'); });
  setBehaviorRegistry({
    get: (name: string) => name === 'walk-then-dig-null' ? { name, description: '', steps: [
      { skill: 'move_step', args: { at: [1, 0, 0], facing: 'E' }, optional: true },
      { skill: 'mine_cell', args: { xyz: null, at: [0, 0, 1], facing: 'E' } },
    ] } : undefined,
    list: () => [{ name: 'walk-then-dig-null' }],
  } as never);
  t.after(() => setBehaviorRegistry(null));
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const result = await runSkill(ctx, useSkill, { name: 'walk-then-dig-null' });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /没到新站位/);
  assert.equal(adapter.actions.filter((a) => a.startsWith('dig')).length, 0, 'xyz:null 不应绕过并发生挖掘');
});

test('a step that cannot see support in the dark reports the gap without spending a torch', () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('torch', 3);
  adapter.light = 0; // 暗处
  const activity = createActivity({ what: '迈一步', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'move_step', args: { at: [1, 0, 0], facing: 'E' } }] }, '', 'llm', adapter.state());
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
    steps: [{ skill: 'navigate_to', args: { to: { x: 1, y: 64, z: 0 } } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0, y: 64, z: 0 }, view: '{"around":"contact"}' };
  const percept = { self: { around: 'contact' }, vision: { view: 'turned-around' }, nearby: { resources: [] } };
  const verdict = afterStep(activity, step, fail('STUCK', '卡住了'), 100, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((x) => x.startsWith('retry:')), '转头不触发原样重试');
});
