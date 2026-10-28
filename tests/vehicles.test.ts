import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const lake = (a: FakeAdapter, toX = 40) => {
  for (let x = 4; x <= toX; x++) for (let z = -3; z <= 3; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
};
const setup = (a: FakeAdapter) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const run = async (skill: string, args: unknown) => {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return (await done).result;
  };
  return { arbiter, run };
};
const mount = async (a: FakeAdapter) => {
  a.pos = { x: 6.5, y: 64, z: 0.5 };
  a.entities.push({ id: 5, name: 'boat', kind: 'other', pos: { ...a.pos }, dist: 0, height: 0.6 });
  await a.interactEntity(5, null, new AbortController().signal);
};

test('ride requires an explicit mount and never prepares a boat or spends materials', async () => {
  const a = new FakeAdapter();
  lake(a);
  a.inv.set('oak_boat', 1); a.inv.set('oak_log', 8);
  const { run } = setup(a);
  const result = await run('ride', { direction: 'E' });
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.deepEqual(a.actions, []);
  assert.equal(a.inv.get('oak_boat'), 1);
  assert.equal(a.inv.get('oak_log'), 8);
  assert.equal(SKILLS.boat, undefined);
});

test('ride follows a bending water route and stays mounted at a water destination', async () => {
  const a = new FakeAdapter();
  for (let x = 4; x <= 22; x++) for (let z = -2; z <= 2; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  for (let x = 18; x <= 22; x++) for (let z = -30; z < -2; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  await mount(a);
  const { run } = setup(a);
  const result = await run('ride', { to: '20,-28' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.arrived, true);
  assert.equal(a.riding, 'boat');
  assert.ok(a.pos.z < -24, JSON.stringify(a.pos));
  assert.ok(a.ridePaths[0].length >= 2, JSON.stringify(a.ridePaths));
  assert.ok(!a.actions.some((action) => /^(craft|use|attack):/.test(action)));
});

test('ride docks at a low bank without dismounting; dismount is a separate directed action', async () => {
  const a = new FakeAdapter();
  lake(a);
  for (let x = 41; x <= 70; x++) for (let z = -3; z <= 0; z++) for (const y of [64, 65]) a.blocks.push({ name: 'dirt', pos: { x, y, z } });
  await mount(a);
  const { run } = setup(a);
  const result = await run('ride', { to: '60,-2' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.arrived, false, 'docking is not arrival at the land destination');
  assert.equal(result.data?.docked, true);
  assert.equal(a.riding, 'boat');
  assert.equal(a.dismountToward, null);
  const landing = result.data?.landing as { x: number; y: number; z: number };
  assert.ok(landing.z >= 1, JSON.stringify(landing));
  const off = await run('dismount', { toward: [landing.x + 0.5, landing.y, landing.z + 0.5] });
  assert.equal(off.status, 'succeeded', off.summary);
  assert.equal(a.riding, null);
  assert.deepEqual(a.dismountToward, { x: landing.x + 0.5, y: landing.y, z: landing.z + 0.5 });
});

test('ride cancellation hands the same boat to the next task without a delayed dismount', async () => {
  const a = new FakeAdapter();
  lake(a, 240); await mount(a);
  const { arbiter } = setup(a);
  const cancelled = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'ride', args: { to: '200,0' } }, 'llm');
  await sleep(30);
  arbiter.cancel('replan');
  assert.equal((await cancelled).result.status, 'cancelled');
  const completed = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'ride', args: { to: '20,0' } }, 'llm');
  const result = (await completed).result;
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(a.riding, 'boat');
  assert.equal(result.data?.arrived, true);
});

test('ride reports a timeout after progress as failure and preserves the mounted state', async () => {
  const a = new FakeAdapter();
  lake(a); await mount(a);
  a.ride = async () => ({ ok: false, reason: 'TIMEOUT', arrived: false, moved: 10 });
  const { run } = setup(a);
  const result = await run('ride', { to: '30,0' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(result.data?.moved, 10);
  assert.equal(result.data?.arrived, false);
  assert.equal(a.riding, 'boat');
});

test('registered skills retain brief descriptions', () => {
  for (const name of ['ride', 'fish', 'wait']) {
    assert.ok(SKILLS[name], name);
    assert.ok(SKILLS[name].description.length <= 90, name);
  }
  assert.doesNotMatch(skillCatalog(), /^- boat /m);
});

test('wait：原地等待且可被取消', async () => {
  const a = new FakeAdapter();
  const { run, arbiter } = setup(a);
  const t0 = Date.now();
  const result = await run('wait', { seconds: 2 });
  assert.equal(result.status, 'succeeded');
  assert.ok(Date.now() - t0 >= 1900);
  assert.ok(!a.actions.some((action) => action.startsWith('moveTo')));
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'wait', args: { seconds: 60 } }, 'llm');
  await sleep(50);
  arbiter.cancel('够了');
  assert.equal((await done).result.status, 'cancelled');
});
