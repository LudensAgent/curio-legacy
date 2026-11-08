import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep, rebindStanceTarget } from '../src/mind/activity.ts';
import { placeSupport } from '../src/skills/movement/index.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const supportResult = (data: Record<string, unknown>): SkillResult => ({
  status: 'succeeded', summary: '形成了支撑', data: { effect: { confirmed: true, kind: 'support_formed' }, ...data },
});

test('place_support 成功回执区分支撑目标与意图脚位，并给出衔接状态', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.groundY = 62; // 脚下一格是空的，补在脚正下方后身体正好站上支撑
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [0, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.supportTarget, { x: 0, y: 63, z: 0 });
  assert.equal(r.data?.supportConfirmed, true);
  assert.equal(r.data?.stanceChanged, false);
  assert.deepEqual(r.data?.intendedStandTarget, { x: 0, y: 64, z: 0 });
  assert.equal(r.data?.continuation, 'ready');
  assert.deepEqual(r.data?.positionBefore, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(r.data?.positionAfter, { x: 0.5, y: 64, z: 0.5 });
});

test('afterStep 把放置的意图脚位和原锚点一起记进 stanceGap，并汇总真实效果', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '补支撑再站上去', why: '', kind: 'other', repeat: 1,
    steps: [
      { skill: 'place_support', args: { at: [-1, -1, 0], facing: 'W', item: 'cobblestone' } },
      { skill: 'move_step', args: { at: [1, 0, 0], facing: 'W' } },
    ] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: -492.36, y: 79, z: -256.5 } };
  adapter.pos = { x: -493.06, y: 79, z: -256.5 };
  const verdict = afterStep(activity, step, supportResult({
    targetCell: { x: -494, y: 78, z: -257 },
    intendedStandTarget: { x: -494, y: 79, z: -257 },
    movement: { changed: true, start: { x: -492.36, y: 79, z: -256.5 }, end: { x: -493.06, y: 79, z: -256.5 } },
  }), 157, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.deepEqual(activity.stanceGap?.before, { x: -492.36, y: 79, z: -256.5 });
  assert.deepEqual(activity.stanceGap?.intendedStandTarget, { x: -494, y: 79, z: -257 });
  assert.deepEqual(activity.effects?.placements, ['place_support支撑@-494,78,-257']);
  assert.equal(activity.effects?.moved, true, '已确认的位移不能因为背包没变就报成无变化');
});

test('rebindStanceTarget 只把落在本次支撑脚位上的相对移动改成绝对目标', () => {
  const gap = {
    skill: 'place_support',
    pos: { x: -493.06, y: 79, z: -256.5 },
    before: { x: -492.36, y: 79, z: -256.5 },
    intendedStandTarget: { x: -494, y: 79, z: -257 },
  };
  // 朝向 W 时 [1,0,0] 按原锚点（脚格 -493）指向 -494，正好是本次支撑的脚位。
  const matched = rebindStanceTarget({ at: [1, 0, 0], facing: 'W' }, gap);
  assert.deepEqual(matched?.xyz, [-494, 79, -257]);
  assert.deepEqual(matched?.from, { x: -494, y: 79, z: -257 });
  // 若按新站位解释同一个相对动作会多走一列：这里用朝向 E 表示不匹配，必须交回重绑定。
  assert.equal(rebindStanceTarget({ at: [1, 0, 0], facing: 'E' }, gap), null);
  assert.equal(rebindStanceTarget({ at: [1, 0, 0] }, gap), null, '缺少参考朝向时不猜');
  assert.equal(rebindStanceTarget({ at: [1, 0, 0], facing: 'W' }, { ...gap, intendedStandTarget: undefined }), null);
});
