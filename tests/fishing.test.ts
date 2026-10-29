import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { stubSenses } from './survival-helpers.ts';

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

function fishingWithReflex(t: TestContext) {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  pond(adapter);
  adapter.pos = { x: 2, y: 64, z: 0 };
  adapter.inv.set('fishing_rod', 1);
  const senses = stubSenses(adapter, { observeBlocks: (positions) => {
    const state = adapter.state();
    return positions.map((pos) => ({ ...adapter.blockStateAt(pos), pos, worldId: state.worldId,
      sessionId: state.sessionId, dimension: state.dim, observationId: state.observationId, observedAt: Date.now(), source: 'vision' as const }));
  } });
  const arbiter = new Arbiter(adapter, memory, bus, senses);
  const reflex = new Reflex(adapter, arbiter, bus, senses, { routineCare: false, instincts: 'skills' });
  t.after(() => { arbiter.cancel('test cleanup'); memory.close(); setBehaviorRegistry(null); });
  return { adapter, arbiter, reflex, advance: (seconds: number) => {
    Array.from({ length: seconds }).forEach(() => { now += 1000; reflex.tick(); });
  } };
}

[false, true].forEach((nested) => {
  test(`fish：${nested ? '技能嵌套' : '直接调用'}等待咬钩超过 20 秒不被判卡死`, async (t) => {
    const w = fishingWithReflex(t);
    let entered!: () => void, release!: () => void;
    const startedFishing = new Promise<void>((resolve) => { entered = resolve; });
    const bite = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    t.mock.method(w.adapter, 'fish', async (signal: AbortSignal, options: { timeoutMs: number }) => {
      assert.equal(options.timeoutMs, 45_000, 'the cast retains its bounded wait');
      entered();
      await bite;
      throwIfAborted(signal);
      w.adapter.inv.set('cod', 1);
      return { ok: true, caught: 'cod' };
    });
    const skill = { name: 'patient-fishing', description: '钓一条鱼', steps: [{ skill: 'fish', args: { count: 1 } }] };
    setBehaviorRegistry({ get: () => skill, list: () => [skill] });
    const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
    const started = w.arbiter.start(nested ? { skill: 'use_skill', args: { name: skill.name } } : { skill: 'fish', args: { count: 1 } }, 'llm');
    assert.ok(!('error' in started));
    assert.equal(await Promise.race([startedFishing.then(() => null), done]), null, 'the real fish action reaches the cast');
    const deadline = w.arbiter.info()!.deadline;
    w.reflex.tick();
    w.advance(30);
    assert.equal(w.reflex.stuckCount, 0);
    assert.equal(w.arbiter.info()?.stationaryWait, true);
    assert.equal(w.arbiter.info()?.deadline, deadline, 'waiting does not extend the task deadline');
    release();
    const outcome = await done;
    assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
    assert.equal(outcome.task.stationaryWait, false);
    assert.equal(w.adapter.inv.get('cod'), 1);
  });
});

test('fish：走向岸边不动仍会被位移卡死检测取消', async (t) => {
  const w = fishingWithReflex(t);
  w.adapter.pos = { x: -6, y: 64, z: 0 };
  let entered!: () => void, release!: () => void;
  const moving = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  t.mock.method(w.adapter, 'moveTo', async (_target: unknown, options: { signal: AbortSignal }) => {
    entered();
    await blocked;
    throwIfAborted(options.signal);
  });
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  assert.ok(!('error' in w.arbiter.start({ skill: 'fish', args: { count: 1 } }, 'llm')));
  assert.equal(await Promise.race([moving.then(() => null), done]), null, 'the real fish action first approaches the shore');
  w.reflex.tick();
  w.advance(21);
  assert.equal(w.reflex.stuckCount, 1);
  release();
  const outcome = await done;
  assert.equal(outcome.result.failureCode, 'STUCK');
  assert.equal(outcome.task.stationaryWait, false);
});
