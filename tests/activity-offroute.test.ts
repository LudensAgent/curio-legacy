import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const offRoute = {
  offRoute: true,
  initialPosition: { x: 0, y: 40, z: 0 },
  position: { x: 4, y: 44, z: 0 },
  blockedWaypoint: { x: 4, y: 40, z: 0 },
};
const drifted = '从 (0.0,40.0,0.0) 到记录点 (4,40,0) 没走到；寻路把我带到 (4.0,44.0,0.0)（偏离记录路线）';

test('follow_passage 报 offRoute 时，位移不算进展、不自动重试', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '沿旧矿道回入口', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'follow_passage', args: { to: 'entrance' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  // 身体被寻路抬高 4 格：旧规则会因位移 ≥0.5 允许自动重试。
  activity.stepStart = { pos: { x: 0, y: 40, z: 0 } };
  adapter.pos = { x: 4, y: 44, z: 0 };

  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', drifted, { ...offRoute }), 1000, adapter.state());

  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /offRoute|偏离记录路线/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不消耗自动重试额度');
});

test('use_skill 声明式步骤嵌套的 offRoute 也不走通用重试', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '按技能回矿道', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'use_skill', args: { name: 'back-to-mine' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0, y: 40, z: 0 } };
  adapter.pos = { x: 4, y: 44, z: 0 };

  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', `技能「back-to-mine」第 1 步 follow_passage 没成：${drifted}`, { ...offRoute }), 1000, adapter.state());

  assert.equal(verdict.kind, 'stuck');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
});

test('沿记录段部分推进但没到路点不算 offRoute，activity 仍可按原委托重试一次', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '沿旧矿道回入口', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'follow_passage', args: { to: 'entrance' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 40, z: 0.5 } };
  adapter.pos = { x: 3, y: 40, z: 0 };

  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '从 (2.5,40.0,0.0) 到记录点 (4,40,0) 只推进到 (3.0,40.0,0.0)（仍在记录段上，离记录点 1.0 格）', {
    position: { x: 3, y: 40, z: 0 },
    segmentStart: { x: 2.5, y: 40, z: 0 },
    blockedWaypoint: { x: 4, y: 40, z: 0 },
    partialProgress: 2,
  }), 1000, adapter.state());

  assert.equal(verdict.kind, 'continue', '沿记录段的部分推进不是偏离，不应判 stuck');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 1);
});

test('代码技能 lastNavigationFailure 里的 offRoute 同样阻止自动重试', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '跑代码技能回矿道', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'use_skill', args: { name: 'code-back' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0, y: 40, z: 0 } };
  adapter.pos = { x: 4, y: 44, z: 0 };

  const verdict = afterStep(activity, step, fail('ERROR', `代码技能「code-back」没成：${drifted}`, {
    lastNavigationFailure: {
      childSkill: 'follow_passage', via: 'act',
      result: { ok: false, code: 'PATH_NOT_FOUND', summary: drifted, data: { ...offRoute } },
    },
    displacement: { horizontal: 4, dy: 4 },
  }), 1000, adapter.state());

  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /offRoute|偏离记录路线/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
});
