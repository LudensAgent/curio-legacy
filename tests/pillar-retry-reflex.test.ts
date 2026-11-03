import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { placeAt } from '../src/skills/primitives.ts';
import { climbUp } from '../src/skills/body.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('jump failures return control; a head-blocked pillar clears the head before retrying', () => {
  const adapter = new FakeAdapter();
  // 跳不起来 / 头顶未加载（此处没有视觉信号）：无法就地应变，交回
  for (const reason of ['NOT_PLACED:跳不起来', 'NOT_PLACED:头顶跳跃空间未加载']) {
    const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
      steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', `原地垫高没成：${reason}`, { pillarFailure: reason }), 100, adapter.state());
    assert.equal(verdict.kind, 'stuck', reason);
    assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')));
  }
  // 头顶被挡：先挖开头顶再垫（身体就地应变，不是盲目重试）
  {
    const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
      steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：NOT_PLACED:头顶跳跃空间受阻', { pillarFailure: 'NOT_PLACED:头顶跳跃空间受阻' }), 100, adapter.state());
    assert.equal(verdict.kind, 'continue');
    assert.ok(activity.adaptations.some((item) => item.startsWith('clearance:')));
    assert.equal(activity.steps[0].skill, 'dig_at');
  }
  const activity = createActivity({ what: '放置', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'place_at', args: { at: [1, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '效果未知'), 100, adapter.state()).kind, 'continue');
});

test('the actual place_at failure carries the jump reason to the scheduler', async (t) => {
  const adapter = new FakeAdapter();
  adapter.inv.set('cobblestone', 4);
  t.mock.method(adapter, 'pillarUp', async () => ({ ok: false, reason: 'NOT_PLACED:跳不起来' }));
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const result = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'cobblestone' });
  assert.equal(result.data?.pillarFailure, 'NOT_PLACED:跳不起来');
  assert.equal(afterStep(activity, step, result, 100, adapter.state()).kind, 'stuck');
});

test('place_at includes the checked head sweep in its failure feedback', async (t) => {
  const adapter = new FakeAdapter();
  adapter.inv.set('cobblestone', 4);
  t.mock.method(adapter, 'pillarUp', async () => ({ ok: false, reason: 'NOT_PLACED:头顶跳跃空间受阻',
    clearanceDetail: '头顶跳跃空间受阻；跳跃时身体扫过的方块范围 x=0..1, y=65..66, z=0..0，具体障碍位置和方块名称未确认' }));
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const result = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'cobblestone' });
  assert.match(result.summary, /x=0\.\.1, y=65\.\.66, z=0\.\.0/);
  assert.equal(result.data?.pillarFailure, 'NOT_PLACED:头顶跳跃空间受阻');
});

test('climb_up clears the head and retries a confirmed pillar obstruction', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('dirt', 4);
  let calls = 0;
  t.mock.method(adapter, 'moveTo', async () => {
    if (++calls === 1) { adapter.pos = { ...adapter.pos, y: 65 }; return; }
    const error = new Error('No path: jump clearance');
    error.name = 'PillarClearanceError';
    throw error;
  });
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { ...adapter.state().pos } };
  const result = await climbUp.run(ctx, { height: 3, untilSky: false });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.climbed, 1);
  assert.equal(result.data?.failureCause, 'PILLAR_CLEARANCE');
  assert.equal((result.data?.effectEvidence as { changed: boolean }).changed, true);
  const verdict = afterStep(activity, step, result, 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.ok(activity.adaptations.some((item) => item.startsWith('clearance:')));
  assert.equal(activity.steps[0].skill, 'dig_at');
});

test('a goto blocked by pillar clearance reports the fact and lets the mind decide', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '往东走', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'goto', args: { target: 'E 120', dig: true } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '前往 E 120 失败：No path: 原地搭柱头顶跳跃空间受阻', { pillarClearance: true }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:')));
  assert.equal(activity.steps[0].skill, 'goto');
});

test('climb_up exhausts its budget and terminates instead of re-climbing the full height', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'climb_up', args: { height: 16, untilSky: true } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 16 格后停下：仍未满足停止条件', { climbed: 16, goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.equal(verdict.exhausted, true, '额度耗尽须标记，调度器据此终止自动推进');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '不会原样重试再爬一次完整高度');
});

test('climb_up partial progress reduces the dispatched height without mutating the template', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 1 格后停下', { climbed: 1, goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '剩余额度下继续爬，而不是重试完整高度');
  assert.equal((activity.steps[0].args as { height: number }).height, 3, '模板参数保持不变');
  const next = nextStep(activity)!;
  assert.equal(next.skill, 'climb_up');
  assert.equal((next.args as { height: number }).height, 2, '派发时按剩余额度扣减');
});

test('climb_up repeat:2 starts each round from the original height', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 2,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  // 第一轮：爬 1 格失败 → 重试派发 height 2 → 成功
  let step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  assert.equal(afterStep(activity, step, fail('STUCK', '往上爬了 1 格后停下', { climbed: 1, goalReached: false }), 100, adapter.state()).kind, 'continue');
  const retry = nextStep(activity)!;
  assert.equal((retry.args as { height: number }).height, 2);
  assert.equal(afterStep(activity, retry, { status: 'succeeded', summary: '往上爬了 2 格', data: { climbed: 2 } }, 100, adapter.state()).kind, 'continue');
  // 第一轮做完，进入第二轮：reset 累计额度，重新派发原始 height 3
  const round2 = nextStep(activity)!;
  assert.equal(round2.skill, 'climb_up');
  assert.equal((round2.args as { height: number }).height, 3, '第二轮从原始参数开始');
  assert.equal((activity.steps[0].args as { height: number }).height, 3, '模板从未被改写');
});

test('recovery-internal climb is deducted from the parent climb quota', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 66, z: 0.5 }; // 恢复后身体在 y=66
  const key = JSON.stringify({ height: 3, untilSky: false });
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'use_skill', args: { name: 're-climb', failure: { skill: 'climb_up', args: { height: 2 }, position: { x: 0, y: 65, z: 0 } } } },
      { skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  activity.climbSpent = { [key]: 1 }; // 顶层已爬 1 格失败
  const step = nextStep(activity)!;
  assert.equal(step.skill, 'use_skill');
  afterStep(activity, step, { status: 'succeeded', summary: '做完了', data: { done: ['climb_up → 成'] } }, 100, adapter.state());
  assert.equal(activity.climbSpent[key], 2, '恢复内部爬升入账（顶层 1 + 恢复 1）');
});

test('climb_up cancellation preserves the partial height already climbed', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('dirt', 8);
  const controller = new AbortController();
  let climbs = 0;
  adapter.moveTo = async () => {
    climbs++;
    adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 };
    if (climbs === 1) controller.abort('reflex');
  };
  const ctx = { adapter, signal: controller.signal, deadline: Date.now() + 10000, senses: { refresh() {} }, make: false };
  await assert.rejects(climbUp.run(ctx as never, { height: 3, untilSky: false }), (e: { partialClimbed?: number }) => {
    assert.equal(e.partialClimbed, 1, '取消结果保留已爬升的部分高度');
    return true;
  });
});

test('excavate_path preflight rejection is not auto-retried for another identical gap', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '开挖', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 }, view: '先前视野' };
  const verdict = afterStep(activity, step, fail('ERROR', '有界开挖停止：下一落点下面是空的（air）：前面脚下是个坑/洞穴', { completedSteps: 0, excavatedBlocks: 0 }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '确定性预检失败不会原样重试');
});

test('other climb_up failures retain the existing retry decision', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(activity, step, fail('STUCK', '其他阻碍'), 100, adapter.state()).kind, 'continue');
});

test('torch habit is opt-in and only runs while idle', () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('torch', 4);
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 66, z: 0 } });
  adapter.light = 0;
  const requests: unknown[] = [];
  let current: { skill: string; progress: number; movement: boolean } | null = { skill: 'goto', progress: 0.2, movement: false };
  const arbiter = { paused: false, info: () => current, start: (...args: unknown[]) => requests.push(args) };
  const senses = { perceivedEntities: () => [] };
  let torchEvery = 0;
  const reflex = new Reflex(adapter, arbiter as never, new EventBus(), senses as never,
    { instincts: 'skills', routineCare: true, habits: () => ({ torch_every: torchEvery }) });
  assert.ok(!reflex.activeInstincts().includes('torch'));
  reflex.tick();
  assert.equal(requests.length, 0);
  current = null;
  reflex.tick();
  assert.equal(requests.length, 0, 'routine care alone must not consume a torch');
  torchEvery = 8;
  assert.ok(reflex.activeInstincts().includes('torch'));
  for (const skill of ['goto', 'gather', 'explore']) {
    current = { skill, progress: 0.2, movement: false };
    reflex.tick();
    assert.equal(requests.length, 0, `${skill} must not be interrupted`);
  }
  current = null;
  reflex.tick();
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as unknown[])[0], { skill: 'place_torch', args: { count: 1, auto: true } });
});
