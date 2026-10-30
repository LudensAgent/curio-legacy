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
