import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { fail, ok, runSkill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('jump failures return control; a head-blocked pillar reports the fact (no implicit clearing)', () => {
  const adapter = new FakeAdapter();
  // 跳不起来 / 头顶未加载（此处没有视觉信号）：无法就地应变，交回
  for (const reason of ['NOT_PLACED:跳不起来', 'NOT_PLACED:头顶跳跃空间未加载']) {
    const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
      steps: [{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', `原地垫高没成：${reason}`, { pillarFailure: reason }), 100, adapter.state());
    assert.equal(verdict.kind, 'stuck', reason);
    assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')));
  }
  // 头顶被挡：place_cell 不隐式清顶，交回事实由 Agent 决定挖哪一格
  {
    const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
      steps: [{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：NOT_PLACED:头顶跳跃空间受阻', { pillarFailure: 'NOT_PLACED:头顶跳跃空间受阻' }), 100, adapter.state());
    assert.equal(verdict.kind, 'stuck');
    assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:')));
    assert.equal(activity.steps[0].skill, 'place_cell');
  }
  const activity = createActivity({ what: '放置', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'place_cell', args: { at: [1, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '效果未知'), 100, adapter.state()).kind, 'continue');
});

test('a walk_path blocked by pillar clearance reports the fact and lets the mind decide', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '往东走', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'walk_path', args: { routeId: 'rt_e120' } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '前往 E 120 失败：No path: 原地搭柱头顶跳跃空间受阻', { pillarClearance: true }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:')));
  assert.equal(activity.steps[0].skill, 'walk_path');
});

test('excavate_run preflight rejection is not auto-retried for another identical gap', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '开挖', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 3 } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 0.5, y: 64, z: 0.5 }, view: '先前视野' };
  const verdict = afterStep(activity, step, fail('ERROR', '有界开挖停止：下一落点下面是空的（air）：前面脚下是个坑/洞穴', { completedSteps: 0, excavatedBlocks: 0 }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '确定性预检失败不会原样重试');
});

test('other pillar_one failures retain the existing retry decision', () => {
  const adapter = new FakeAdapter();
  const activity = createActivity({ what: '爬升', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'pillar_one', args: { item: 'cobblestone' } }] }, '', 'llm', adapter.state());
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
  let current: { skill: string; progress: number; movement: boolean } | null = { skill: 'walk_path', progress: 0.2, movement: false };
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
  for (const skill of ['walk_path', 'gather', 'look_around']) {
    current = { skill, progress: 0.2, movement: false };
    reflex.tick();
    assert.equal(requests.length, 0, `${skill} must not be interrupted`);
  }
  current = null;
  reflex.tick();
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as unknown[])[0], { skill: 'place_torch', args: { count: 1, auto: true } });
});
