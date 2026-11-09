import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookAround } from '../src/skills/movement.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('同一处反复找不到：回执如实说这附近找了几次、原地再转是同一片视野；换个地方重新计数', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 1000.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const first = await lookAround.run(ctx, { seconds: 2, for: 'birch_log' });
  assert.equal(first.failureCode, 'NOT_FOUND');
  assert.equal(first.data?.searchedHere, 1);
  assert.doesNotMatch(first.summary, /第 \d+ 次找/, '第一次不加提示');

  const second = await lookAround.run(ctx, { seconds: 2, for: 'birch_log' });
  assert.equal(second.data?.searchedHere, 2);
  assert.match(second.summary, /这附近已经第 2 次找 birch_log 都没看见/);
  assert.match(second.summary, /explore_toward/);

  // gather 内部转头找的那次也记在同一处
  const gather = SKILLS.gather.validate({ block: 'birch_log', count: 1 }, adapter);
  assert.ok(gather.ok);
  const g = await SKILLS.gather.run(ctx, gather.args);
  assert.equal(g.failureCode, 'NOT_FOUND');
  assert.equal(g.data?.searchedHere, 3);
  assert.match(g.summary, /第 3 次找 birch_log/);

  adapter.pos = { x: 1020.5, y: 64, z: 0.5 };
  const moved = await lookAround.run(ctx, { seconds: 2, for: 'birch_log' });
  assert.equal(moved.data?.searchedHere, 1, '走开 20 格是新地方，重新计数');
});
