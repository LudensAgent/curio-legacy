import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { placeAt } from '../src/skills/primitives.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('confirmed pillar clearance and jump failures return control without an automatic repeat', () => {
  const adapter = new FakeAdapter();
  for (const reason of ['NOT_PLACED:跳不起来', 'NOT_PLACED:头顶跳跃空间受阻', 'NOT_PLACED:头顶跳跃空间未加载']) {
    const activity = createActivity({ what: '垫高', why: '', kind: 'other', repeat: 1,
      steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }] }, '', 'llm', adapter.state());
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', `原地垫高没成：${reason}`, { pillarFailure: reason }), 100, adapter.state());
    assert.equal(verdict.kind, 'stuck', reason);
    assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')));
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

test('routine torch placement waits until goto ends, but still works while idle', () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('torch', 4);
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 66, z: 0 } });
  adapter.light = 0;
  const requests: unknown[] = [];
  let current: { skill: string; progress: number; movement: boolean } | null = { skill: 'goto', progress: 0.2, movement: false };
  const arbiter = { paused: false, info: () => current, start: (...args: unknown[]) => requests.push(args) };
  const senses = { perceivedEntities: () => [] };
  const reflex = new Reflex(adapter, arbiter as never, new EventBus(), senses as never, { instincts: 'skills' });
  reflex.tick();
  assert.equal(requests.length, 0);
  current = null;
  reflex.tick();
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as unknown[])[0], { skill: 'place_torch', args: { count: 1, auto: true } });
});
