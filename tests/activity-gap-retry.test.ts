import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { climbUp } from '../src/skills/body.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const gather = { skill: 'gather', args: { block: 'stone', count: 3 } };

function activityOf(steps: { skill: string; args?: unknown }[], repeat = 1) {
  const adapter = new FakeAdapter();
  return { adapter, activity: createActivity({ what: '测试', why: '', kind: 'other', steps, repeat }, '', 'llm', adapter.state()) };
}

test('52ms→7ms：有界开挖的确定性预检失败，不因身体或视角变化再原样重试', () => {
  const { adapter, activity } = activityOf([{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 }, view: '{"around":"old"}' };
  // 身体实际位移 + 转头 + 附近出现新资源，都不是“下一落点支撑已改变”的证据。
  const percept = { self: { around: 'new' }, vision: { view: 'turned' }, nearby: { resources: [{ name: 'oak_log' }] } };
  const verdict = afterStep(activity, step, fail('ERROR', '有界开挖停止：下一落点下面是空的（air）：前面脚下是个坑/洞穴', { completedSteps: 0, excavatedBlocks: 0 }), 7, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '不做第二次相同缺口调用');
});

test('同一缺口只重试一次：视角或无关资源变化不能再要一次重试额度', () => {
  const { adapter, activity } = activityOf([gather]);
  let step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const gap = { targetCell: { x: 1, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', gap), 100, adapter.state()).kind, 'continue', '身体实际移动后允许第一次重试');
  step = nextStep(activity)!;
  const percept = { self: { around: 'changed' }, vision: { view: 'turned' }, nearby: { resources: [{ name: 'dirt' }] } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', gap), 7, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck', '同一证据版本不得再原样重试');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 1);
});

test('相关证据变化允许复验，但同一技能的自动重试仍有次数上限', () => {
  const { adapter, activity } = activityOf([gather]);
  let step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', { targetCell: { x: 1, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } }), 100, adapter.state()).kind, 'continue');
  step = nextStep(activity)!;
  const changed = { targetCell: { x: 2, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', changed), 7, adapter.state()).kind, 'continue', '目标格/支撑证据变了，允许复验');
  step = nextStep(activity)!;
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', changed), 7, adapter.state()).kind, 'stuck', '达到两次上限后停止');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 2);
});

test('place_at 脚下被挡时不自动 dig_at：交回事实且零耗材', () => {
  const { adapter, activity } = activityOf([{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  adapter.inv.set('cobblestone', 2);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { ...adapter.state().pos } };
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：脚下这格有 torch，方块放不进去', { pillarFailure: 'BLOCKED:torch' }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.deepEqual(activity.steps.map((item) => item.skill), ['place_at'], '没有插入挖脚下的步骤');
  assert.equal(adapter.inv.get('cobblestone'), 2, '没有消耗垫脚材料');
  assert.ok(!adapter.actions.some((item) => item.startsWith('dig')), '没有发生未授权挖掘');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:') || item.startsWith('retry:')));
});

test('climb_up 清障插步保留来源/授权链并说明消耗；同一障碍证据只清一次', () => {
  const { adapter, activity } = activityOf([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  const step = nextStep(activity)!;
  const result = fail('STUCK', '往上爬了 1 格后停下：头顶被挡', {
    climbed: 1, spent: 1, goalReached: false, failureCause: 'PILLAR_CLEARANCE', pillarClearance: { cells: [{ at: [0, 2, 0], facing: 'N' }] },
  });
  const verdict = afterStep(activity, step, result, 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.match((verdict as { adapted?: string }).adapted ?? '', /工具耐久/, '说明这次清障的消耗');
  const inserted = activity.steps[0];
  assert.equal(inserted.skill, 'dig_at');
  assert.equal(inserted.origin, 'execution_helper');
  assert.equal(inserted.authorizedBy?.skill, 'climb_up');
  assert.equal(inserted.authorizedBy?.stepId, step.id, '授权链指回原逻辑步骤');
  assert.equal(afterStep(activity, step, result, 100, adapter.state()).kind, 'stuck', '同一障碍证据不再插一次');
  assert.equal(activity.steps.filter((item) => item.skill === 'dig_at').length, 1);
});

test('清障只在障碍证据变化时再次插入，且最多两次', () => {
  const { adapter, activity } = activityOf([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  const step = nextStep(activity)!;
  const obstacle = (x: number) => fail('STUCK', '往上爬了 1 格后停下：头顶被挡', {
    climbed: 1, spent: 1, goalReached: false, failureCause: 'PILLAR_CLEARANCE', pillarClearance: { cells: [{ at: [x, 2, 0], facing: 'N' }] },
  });
  assert.equal(afterStep(activity, step, obstacle(0), 100, adapter.state()).kind, 'continue');
  nextStep(activity); // 执行第一次插入的清障
  assert.equal(afterStep(activity, step, obstacle(1), 100, adapter.state()).kind, 'continue', '障碍格变了，允许复验');
  nextStep(activity);
  assert.equal(afterStep(activity, step, obstacle(-1), 100, adapter.state()).kind, 'stuck', '两次之后即使证据再变也停止');
  assert.equal(activity.steps.filter((item) => item.skill === 'dig_at').length, 2);
});

test('18+18：climb 重试沿用剩余高度账本，不重新获得完整额度', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 73, z: 0.5 }; // 已确认爬了 9 格
  adapter.inv.set('dirt', 32);
  const activity = createActivity({ what: '爬 18 格', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'climb_up', args: { height: 18, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  const key = step.id!;
  activity.climb![key].spent = 9;
  activity.climb![key].startY = 64; // 第一次实际爬升时记录的逻辑起点
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 9 格后停下', { climbed: 9, spent: 9, goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.equal(activity.climb![key].spent, 9, '已完成高度跨重试保留');
  assert.equal((activity.steps[0].args as { height: number }).height, 18, '模板目标不变');
  let moves = 0;
  adapter.moveTo = async () => { moves++; adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 }; };
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10000, senses: { refresh() {} }, make: false, climb: activity.climb![key] };
  const result = await climbUp.run(ctx as never, { height: 18, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves, 9, '只补剩余 9 格，不是再从 0 爬 18 格');
  assert.equal(activity.climb![key].spent, 18);
});
