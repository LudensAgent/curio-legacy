import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const pond = (a: FakeAdapter) => {
  for (let x = 4; x <= 14; x++) for (let z = -4; z <= 4; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
};
const runner = (a: FakeAdapter) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  return async (skill: string, args: unknown) => {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    const started = arbiter.start({ skill, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return (await done).result;
  };
};

test('fish：有钓鱼竿 → 走到岸边往水里甩竿，报告钓到的鱼', async () => {
  const a = new FakeAdapter();
  pond(a);
  a.pos = { x: -6, y: 64, z: 0 };
  a.inv.set('fishing_rod', 1);
  a.fishCatches = ['cod', null, 'salmon'];
  const run = runner(a);
  const r = await run('fish', { count: 3 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.caught, ['cod', 'salmon', 'cod']);
  assert.equal(r.data?.casts, 4);
  assert.ok(a.actions.filter((x) => x.startsWith('fish:')).every((x) => x === 'fish:water'), a.actions.join(' '));
  assert.equal(a.inv.get('salmon'), 1);
  assert.match(r.summary, /smelt/);
  assert.notEqual(a.blockAt({ x: Math.floor(a.pos.x), y: 63, z: Math.floor(a.pos.z) }), 'water', `站在岸上，pos=${JSON.stringify(a.pos)}`);
});

test('fish：默认不造竿，显式 make:true 才准备；材料不够给出缺口', async () => {
  const a = new FakeAdapter();
  pond(a);
  const run = runner(a);
  let r = await run('fish', { count: 1, make: true });
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.match(r.summary, /3 根木棍 \+ 2 根线/);
  assert.match(r.summary, /蜘蛛/);
  a.inv.set('stick', 3);
  a.inv.set('string', 2);
  r = await run('fish', { count: 1 });
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.match(r.summary, /make:true/);
  assert.ok(!a.actions.includes('craft:fishing_rod'));
  r = await run('fish', { count: 1, make: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.actions.includes('craft:fishing_rod'));
  assert.equal(r.data?.craftedRod, true);
});

test('fish：看不见水 → NOT_FOUND', async () => {
  const a = new FakeAdapter();
  a.inv.set('fishing_rod', 1);
  const r = await runner(a)('fish', {});
  assert.equal(r.failureCode, 'NOT_FOUND', r.summary);
});
