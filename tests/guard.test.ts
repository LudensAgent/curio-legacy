import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { queryMechanics } from '../src/methods/mechanics.ts';
import { FakeAdapter } from './fake-adapter.ts';

const run = async (a: FakeAdapter, skill: string, args: unknown) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  const started = arbiter.start({ skill, args }, 'llm');
  assert.ok(!('error' in started), 'error' in started ? started.error : '');
  return (await done).result;
};

test('guard：副手有盾就举起来挡几秒，结束放下；没有盾说清楚', async () => {
  const a = new FakeAdapter();
  a.equipped.set('off-hand', 'shield');
  const r = await run(a, 'guard', { seconds: 1 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /举盾 1 秒/);
  assert.equal(a.shieldUp, false, '挡完要放下');

  const b = new FakeAdapter();
  const r2 = await run(b, 'guard', { seconds: 1 });
  assert.equal(r2.failureCode, 'MISSING_MATERIALS', r2.summary);
});

test('机制查询能用“举盾/格挡”找到 guard', () => {
  const out = JSON.stringify(queryMechanics('格挡'));
  assert.match(out, /guard/);
});
