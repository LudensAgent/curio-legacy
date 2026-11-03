import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { placeAt } from '../src/skills/primitives.ts';
import { climbUp } from '../src/skills/body.ts';
import { fail, ok, runSkill } from '../src/skills/types.ts';
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
  const key = JSON.stringify(step.args ?? {});
  activity.climb![key].spent = 16; // climbUp.run 已把 16 格实时入账
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 16 格后停下：仍未满足停止条件', { goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.equal(verdict.exhausted, true, '额度耗尽须标记，调度器据此终止自动推进');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '不会原样重试再爬一次完整高度');
});

test('climb_up partial progress is tracked in the shared budget without mutating the template', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 } };
  const key = JSON.stringify(step.args ?? {});
  activity.climb![key].spent = 1; // climbUp.run 已把 1 格实时入账
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 1 格后停下', { goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '剩余额度下继续，而不是重试完整高度');
  assert.equal((activity.steps[0].args as { height: number }).height, 3, '模板参数保持不变');
  assert.equal(activity.climb[key].spent, 1, '已确认进展入账');
});

test('climb_up repeat:2 starts each round from the original budget', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 2,
    steps: [{ skill: 'climb_up', args: { height: 3, untilSky: false } }] }, '', 'llm', adapter.state());
  const step1 = nextStep(activity)!;
  const key = JSON.stringify(step1.args ?? {});
  assert.equal(activity.climb[key].height, 3, '第一轮建立原始高度账本');
  assert.equal(activity.climb[key].spent, 0);
  // 第一轮成功：删除账本
  assert.equal(afterStep(activity, step1, { status: 'succeeded', summary: '往上爬了 3 格', data: { goalReached: true } }, 100, adapter.state()).kind, 'continue');
  assert.equal(activity.climb[key], undefined, '成功后删除账本');
  // 第二轮：reset 账本，从原始高度重新开始
  const step2 = nextStep(activity)!;
  assert.equal(step2.skill, 'climb_up');
  assert.equal((step2.args as { height: number }).height, 3, '第二轮从原始参数开始');
  assert.equal(activity.climb[JSON.stringify(step2.args ?? {})].height, 3);
  assert.equal(activity.climb[JSON.stringify(step2.args ?? {})].spent, 0, '第二轮额度清零');
});

test('nested climb_up inherits the recovery budget via ctx.climb', async () => {
  const budget = { height: 3, spent: 1 };
  let got: unknown = undefined;
  const skill = { name: 'climb_up', description: '', argsDoc: '', timeoutMs: 1000, movement: true,
    validate: () => ({ ok: true, args: {} }), run: async (ctx: { climb?: unknown }) => { got = ctx.climb; return ok('x'); } };
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter);
  ctx.recovery = { skill: 'climb_up', args: { height: 3 }, climb: budget };
  await runSkill(ctx, skill as never, {} as never);
  assert.equal(got, budget, '恢复内部嵌套动作拿到同一份额度账本');
});

test('climb_up cancellation preserves only the confirmed height', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('dirt', 8);
  const budget = { height: 3, spent: 0 };
  const controller = new AbortController();
  let climbs = 0;
  adapter.moveTo = async () => {
    climbs++;
    if (climbs === 1) adapter.pos = { ...adapter.pos, y: 65 }; // 第一格确认
    else { adapter.pos = { ...adapter.pos, y: 65.2 }; controller.abort('reflex'); } // 第二格跳到半空未落稳
  };
  const ctx = { adapter, signal: controller.signal, deadline: Date.now() + 10000, senses: { refresh() {} }, make: false, climb: budget };
  await assert.rejects(climbUp.run(ctx as never, { height: 3, untilSky: false }), (e: { partialClimbed?: number }) => {
    assert.equal(budget.spent, 1, '账本只入账确认的爬升');
    assert.equal(e.partialClimbed, 1, '取消只保留确认的 1 格，不把半空的瞬时高度当进展');
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
