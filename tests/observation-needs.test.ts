import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Plan } from '../src/planner/plan.ts';
import type { Step } from '../src/arbiter/arbiter.ts';
import type { Planner } from '../src/planner/planner.ts';
import type { PlanContext } from '../src/planner/prompt.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };

for (const hazard of ['inWater', 'inLava'] as const) {
  test(`unfamiliar surroundings do not trigger a stationary background sweep while ${hazard}`, async (t) => {
    const w = fixture(t);
    w.adapter[hazard] = true;
    await w.tick(); await w.advance(5000);
    assert.equal(w.sweeps().length, 0);
    assert.equal(w.requests.length, 1);
  });
}
const plan = (steps: Step[]): Plan => ({ id: 'observation-test-plan', source: 'llm', thought: '', goal: '继续当前工作',
  goalType: 'investigate', steps, index: 0, abortIf: {}, retries: 0, createdAt: Date.now() });

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const requests: { ctx: PlanContext; signal: AbortSignal; resolve: (plan: Plan) => void }[] = [];
  const planner = { autonomous: true, propose: (ctx: PlanContext, signal: AbortSignal) =>
    new Promise<Plan>((resolve) => requests.push({ ctx, signal, resolve })) } as unknown as Planner;
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner });
  executive.start(1_000_000);
  t.after(() => { executive.stop(); arbiter.cancel('test end'); memory.close(); });
  const tick = async () => { executive.tick(); await flush(); };
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms;) {
      const step = Math.min(250, ms - elapsed);
      t.mock.timers.tick(step); await flush(); await tick(); elapsed += step;
    }
  };
  const sweeps = () => bus.recent().filter((event) => event.type === 'task_start' && event.data?.source === 'filler');
  return { adapter, arbiter, executive, memory, perception, vision, bus, requests, tick, advance, sweeps };
}

test('unfamiliar empty surroundings get one useful sweep with no periodic retry while thinking', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(4000);
  assert.equal(w.arbiter.info(), null);
  await w.advance(120_000);
  assert.equal(w.sweeps().length, 1, 'elapsed time alone does not justify observing the same place again');
  assert.equal(w.requests.length, 1);
  assert.equal(w.executive.inFlight, true);
});

test('eight blocks of displacement refreshes the view, while motion below the boundary stays quiet', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(4000);
  w.adapter.pos = { x: 7.999, y: 64, z: 0 }; await w.tick();
  assert.equal(w.sweeps().length, 1);
  w.adapter.pos.x = 8; await w.tick();
  assert.equal(w.sweeps().length, 2);
});

for (const scope of ['worldId', 'sessionId', 'dim'] as const) {
  test(`a changed ${scope} permits one useful view of unfamiliar surroundings`, async (t) => {
    const w = fixture(t);
    await w.tick(); await w.advance(4000);
    w.adapter[scope] = `new-${scope}`; await w.tick();
    assert.equal(w.sweeps().length, 2);
    assert.equal(w.arbiter.info()?.skill, 'look_around');
  });
}

test('pause, resume and a late cancelled sweep do not invent another need at the same place', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(1000);
  w.executive.pause(); await flush();
  await w.advance(35_000);
  assert.equal(w.sweeps().length, 1);
  assert.equal(w.arbiter.info(), null);
  assert.equal(w.requests[0].signal.aborted, true);
  w.executive.resume(); await w.tick();
  assert.equal(w.requests.length, 2);
  assert.equal(w.sweeps().length, 1, 'resuming a model request does not make familiar surroundings unknown');
});

test('known visible resources provide enough context without a background sweep', async (t) => {
  const w = fixture(t);
  w.adapter.blocks.push({ name: 'oak_log', pos: { x: 4, y: 64, z: 0 } });
  await w.tick();
  assert.ok(w.requests[0].ctx.percept.nearby.resources.some((resource) => resource.block === 'oak_log' && resource.seen === 'now'));
  await w.advance(40_000);
  assert.equal(w.sweeps().length, 0);
});

test('a resource remembered outside the current view also provides enough context', async (t) => {
  const w = fixture(t);
  w.adapter.blocks.push({ name: 'oak_log', pos: { x: 4, y: 64, z: 0 } });
  w.perception.update();
  w.adapter.yaw = Math.PI / 2;
  w.vision.scan();
  await w.tick();
  assert.ok(w.requests[0].ctx.percept.nearby.resources.some((resource) => resource.block === 'oak_log' && resource.seen === 'memory'));
  assert.equal(w.sweeps().length, 0);
});

test('a visible entity provides context without a background sweep', async (t) => {
  const w = fixture(t);
  w.adapter.entities.push({ id: 1, name: 'cow', kind: 'passive', pos: { x: 4, y: 64, z: 0 }, dist: 4, height: 1.4 });
  await w.tick();
  assert.ok(w.requests[0].ctx.percept.nearby.passive.some((entity) => entity.startsWith('cow')));
  assert.equal(w.sweeps().length, 0);
});

test('an ongoing intent remains quiet during the next choice without an information gap', async (t) => {
  const w = fixture(t);
  w.memory.addIntent({ text: '继续整理这里', whyNow: '已有明确工作', context: [], tradeoffs: [], source: 'model', status: 'active' });
  await w.tick(); await w.advance(40_000);
  assert.equal(w.sweeps().length, 0);
});

test('a real missing-resource attempt justifies one sweep despite an ongoing intent and unrelated resources', async (t) => {
  const w = fixture(t);
  w.memory.addIntent({ text: '找一块木头', whyNow: '缺少木样', context: [], tradeoffs: [], source: 'model', status: 'active' });
  w.adapter.blocks.push({ name: 'coal_ore', pos: { x: 4, y: 64, z: 0 } });
  await w.tick();
  assert.equal(w.sweeps().length, 0);
  w.requests[0].resolve(plan([{ skill: 'gather', args: { block: 'log', count: 1 } }]));
  await flush(); await w.tick(); await w.tick();
  assert.equal(w.executive.snapshot().lastFailure?.code, 'NOT_FOUND');
  assert.equal(w.requests.at(-1)?.ctx.lastFailure?.skill, 'gather');
  assert.equal(w.sweeps().length, 1);
  await w.advance(40_000);
  assert.equal(w.sweeps().length, 1, 'the same information gap cannot trigger repeated circles at one location');
});

test('the model may explicitly request a useful look even when background observation is unnecessary', async (t) => {
  const w = fixture(t);
  w.memory.addIntent({ text: '比较树冠形状', whyNow: '想看另一面', context: [], tradeoffs: [], source: 'model', status: 'active' });
  await w.tick();
  assert.equal(w.sweeps().length, 0);
  w.requests[0].resolve(plan([{ skill: 'look_around', args: { seconds: 2 } }]));
  await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.source, 'llm');
  assert.equal(w.arbiter.info()?.skill, 'look_around');
  await w.advance(2000);
  assert.equal(w.bus.recent().filter((event) => event.type === 'task_end' && event.data?.skill === 'look_around' && event.data?.status === 'succeeded').length, 1);
  assert.equal(w.sweeps().length, 0);
});
