import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const runner = (a: FakeAdapter) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  return async (skill: string, args: unknown) => {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    const started = arbiter.start({ skill, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return (await done).result;
  };
};

const pen = () => {
  const a = new FakeAdapter();
  a.inv.set('wheat', 4);
  a.entities.push({ id: 41, name: 'pig', kind: 'passive', pos: { x: 2, y: 64, z: 0 }, dist: 2 } as any);
  a.entities.push({ id: 42, name: 'pig', kind: 'passive', pos: { x: 3, y: 64, z: 1 }, dist: 3.2 } as any);
  return a;
};

test('喂动物：两次喂到两只不同的猪，并报告看得见的反应', async () => {
  const a = pen(), run = runner(a);
  let r = await run('interact', { entity: 'pig', with: 'wheat' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /爱心/);
  assert.equal(r.data?.entityId, 41);
  r = await run('interact', { entity: 'pig', with: 'wheat' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.entityId, 42, '第二次换一只没喂过的');
  assert.equal(a.inv.get('wheat'), 2);
});

test('喂了没反应就是没成，不能当作喂上了', async () => {
  const a = pen(), run = runner(a);
  a.refuseFeed.add(41); a.refuseFeed.add(42);
  const r = await run('interact', { entity: 'pig', with: 'wheat' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
});

test('use_item 的 on 写成生物名时按 interact 去喂', async () => {
  const a = pen(), run = runner(a);
  const r = await run('use_item', { item: 'wheat', on: 'pig' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.actions.includes('interact:pig:wheat'));
});
