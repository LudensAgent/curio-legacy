import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter, type Step } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok } from '../src/skills/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const reply = (steps: Step[], extra: object = {}): Completion => ({ latencyMs: 1000, text: JSON.stringify({
  goal: '收集既定数量的木料', steps,
  decision: { kind: 'begin', reason: '准备当前木料', intent: { text: '收集木料', whyNow: '附近有原木' } }, ...extra,
}) });

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const previousTorch = SKILLS.place_torch;
  // The continuity protocol only needs a short cancellable illumination action.
  // Keep this test independent of the optional auto-light feature's skill module.
  SKILLS.place_torch = { name: 'place_torch', description: 'test illumination', argsDoc: '{}', timeoutMs: 30000, movement: false,
    validate: () => ({ ok: true, args: { count: 1 } }), run: async (ctx) => {
      const s = ctx.adapter.state();
      const result = await ctx.adapter.placeBlockAt({ x: Math.floor(s.pos.x) + 1, y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) }, ['torch'], ctx.signal);
      return result.ok ? ok('照明完成') : fail('ERROR', result.reason ?? '照明失败');
    } };
  adapter.inv.set('torch', 8);
  adapter.blocks = Array.from({ length: 12 }, (_, n) => ({ name: 'oak_log', pos: { x: n + 2, y: 64, z: 0 } }));
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  t.mock.method(vision, 'knownBlocks', (names: string[]) => adapter.blocks.filter((b) => names.includes(b.name))
    .map((b) => ({ ...b, dist: Math.hypot(b.pos.x - adapter.pos.x, b.pos.y - adapter.pos.y, b.pos.z - adapter.pos.z) })));
  t.mock.method(adapter, 'moveTo', async (target, opts) => {
    throwIfAborted(opts.signal);
    if ('pos' in target) adapter.pos = { ...target.pos };
  });
  const pending: { resolve: (value: Completion) => void; signal?: AbortSignal }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'gentle-reflex-test', complete: (_messages, signal) =>
    new Promise((resolve) => pending.push({ resolve, signal })),
  }, adapter, memory, bus, null);
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner });
  executive.start(1_000_000);
  t.after(() => {
    executive.stop(); arbiter.cancel('test end'); memory.close();
    if (previousTorch) SKILLS.place_torch = previousTorch; else delete SKILLS.place_torch;
  });
  const tick = async () => { executive.tick(); await flush(); };
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) {
      const step = Math.min(25, left);
      t.mock.timers.tick(step); await flush(); left -= step;
    }
  };
  const begin = async (steps: Step[]) => {
    await tick(); pending[0].resolve(reply(steps)); await flush(); await tick();
    return arbiter.info()!;
  };
  const torch = () => {
    const task = arbiter.start({ skill: 'place_torch', args: { count: 1 } }, 'reflex', { gentle: true });
    assert.ok(!('error' in task)); return task;
  };
  return { adapter, memory, bus, arbiter, executive, pending, tick, advance, begin, torch };
}

test('gentle torch resumes only remaining gather work and ignores a late cancellation outcome', async (t) => {
  const w = fixture(t), cancelledPickup = gate();
  let pickups = 0;
  t.mock.method(w.adapter, 'collectNearbyDrops', async () => { if (++pickups === 2) await cancelledPickup.promise; return 0; });
  const original = await w.begin([{ skill: 'gather', args: { block: 'log', count: 5 } }]);
  await w.advance(225);
  assert.equal(w.adapter.inv.get('oak_log'), 2);
  assert.equal(w.arbiter.info()?.progress, 2 / 5);
  await w.tick();
  assert.equal(w.pending.length, 2, 'a speculative choice should be in flight');
  const planId = w.executive.plan?.id, intentId = w.memory.currentIntent()?.id;
  w.torch();
  assert.equal(w.pending[1].signal?.aborted, true, 'torch invalidates speculation synchronously');
  assert.equal(w.executive.plan?.id, planId);
  assert.equal(w.executive.plan?.retries, 0);
  w.pending[1].resolve(reply([{ skill: 'craft', args: { item: 'stick', count: 4 } }], { memory_note: '过时的预取笔记' }));
  await flush(); await w.advance(75); await w.tick();
  const resumed = w.arbiter.info()!;
  assert.equal(resumed.skill, 'gather');
  assert.notEqual(resumed.id, original.id);
  assert.deepEqual(resumed.args, { block: 'log', count: 3 });
  assert.equal(w.memory.recentNotes().length, 0);
  assert.equal(w.executive.queued, null);
  cancelledPickup.release(); await flush();
  assert.equal(w.arbiter.info()?.id, resumed.id, 'late cancelled outcome cannot interrupt the resumed step');
  assert.equal(w.executive.plan?.id, planId);
  await w.advance(350);
  assert.equal(w.adapter.inv.get('oak_log'), 5, 'already-dug units must not be gathered a second time');
  assert.equal(w.bus.recent().filter((e) => e.type === 'attempt_end').length, 1);
  assert.equal(w.bus.recent().find((e) => e.type === 'attempt_end')?.data?.status, 'succeeded');
  assert.equal(w.memory.currentIntent()?.id, intentId);
});

test('gentle torch discards an already queued decision before resuming an absolute goto', async (t) => {
  const w = fixture(t), walking = gate();
  let walks = 0;
  t.mock.method(w.adapter, 'moveTo', async (_target, opts) => {
    if (++walks === 1) await walking.promise;
    throwIfAborted(opts.signal);
  });
  const original = await w.begin([{ skill: 'goto', args: { target: '30,64,0' } }]);
  await w.tick();
  w.pending[1].resolve(reply([{ skill: 'craft', args: { item: 'stick', count: 4 } }], { memory_note: '尚未激活的笔记' }));
  await flush();
  assert.ok(w.executive.queued);
  w.torch();
  assert.equal(w.executive.queued, null);
  await w.advance(75); await w.tick(); await flush();
  assert.equal(walks, 2);
  assert.equal(w.memory.recentNotes().length, 0);
  walking.release(); await flush();
  assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.skill === 'goto').length, 2);
  assert.ok(w.bus.recent().some((e) => e.type === 'task_end' && e.data?.taskId === original.id && e.data?.status === 'cancelled'));
});

test('a fully dug gather interrupted during pickup advances without redoing one extra unit', async (t) => {
  const w = fixture(t), pickup = gate();
  let pickups = 0;
  t.mock.method(w.adapter, 'collectNearbyDrops', async () => { if (++pickups === 2) await pickup.promise; return 0; });
  await w.begin([{ skill: 'gather', args: { block: 'log', count: 2 } }, { skill: 'craft', args: { item: 'stick', count: 4 } }]);
  await w.advance(225);
  assert.equal(w.arbiter.info()?.progress, 1);
  w.torch(); await w.advance(75); await w.tick(); await w.advance(75);
  assert.equal(w.adapter.inv.get('oak_log'), 2);
  assert.equal(w.adapter.inv.get('stick'), 4, 'the next approved step proceeds once');
  assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.skill === 'gather').length, 1);
  pickup.release(); await flush();
});

test('safety escalation revokes the saved gather checkpoint', async (t) => {
  const w = fixture(t), pickup = gate(), torchPlacement = gate(), shelter = gate();
  t.mock.method(w.adapter, 'collectNearbyDrops', async () => { await pickup.promise; return 0; });
  t.mock.method(w.adapter, 'placeBlockAt', async (_pos, _names, signal) => { await torchPlacement.promise; throwIfAborted(signal); return { ok: true }; });
  await w.begin([{ skill: 'gather', args: { block: 'log', count: 5 } }]); await w.advance(125);
  w.torch();
  const move = t.mock.method(w.adapter, 'moveTo', async (_target, opts) => { await shelter.promise; throwIfAborted(opts.signal); });
  w.arbiter.start({ skill: 'goto', args: { target: '20,64,0' } }, 'reflex');
  assert.equal(w.executive.plan, null);
  await w.tick();
  assert.equal(w.arbiter.info()?.source, 'reflex');
  torchPlacement.release(); pickup.release(); await flush();
  shelter.release(); await flush(); await w.tick();
  assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.source === 'llm' && e.data?.skill === 'gather').length, 1);
  assert.ok(move.mock.callCount() > 0);
});

for (const change of ['pause', 'disconnected', 'session', 'binding'] as const) {
  test(`${change} invalidation prevents a gentle checkpoint from resuming`, async (t) => {
    const w = fixture(t), pickup = gate();
    t.mock.method(w.adapter, 'collectNearbyDrops', async () => { await pickup.promise; return 0; });
    await w.begin([{ skill: 'gather', args: { block: 'log', count: 5 } }]); await w.advance(125);
    w.torch();
    if (change === 'pause') w.executive.pause();
    else if (change === 'disconnected') w.adapter.connected = false;
    else if (change === 'session') w.adapter.sessionId = 'new-session';
    else {
      w.memory.updateIntent(w.memory.currentIntent()!.id, { status: 'deferred' });
      w.memory.addIntent({ text: '新的兴趣', whyNow: '变化', context: [], tradeoffs: [], source: 'model', status: 'active' });
    }
    await w.advance(75); await w.tick();
    assert.equal(w.executive.plan, null);
    assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.source === 'llm' && e.data?.skill === 'gather').length, 1);
    pickup.release(); await flush();
  });
}

test('failed gentle torch never replays the interrupted gather', async (t) => {
  const w = fixture(t), pickup = gate();
  t.mock.method(w.adapter, 'collectNearbyDrops', async () => { await pickup.promise; return 0; });
  t.mock.method(w.adapter, 'placeBlockAt', async () => ({ ok: false, reason: 'NO_REFERENCE' }));
  await w.begin([{ skill: 'gather', args: { block: 'log', count: 5 } }]); await w.advance(125);
  w.torch(); await flush(); await w.tick();
  assert.equal(w.executive.plan, null);
  assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.skill === 'gather').length, 1);
  pickup.release(); await flush();
});

test('gentle torch does not replay craft mutations whose cancellation outcome arrives late', async (t) => {
  const w = fixture(t), crafting = gate();
  let crafts = 0;
  t.mock.method(w.adapter, 'craft', async (_item, _count, signal) => {
    crafts++; await crafting.promise; throwIfAborted(signal); return { ok: true, crafted: 4 };
  });
  await w.begin([{ skill: 'craft', args: { item: 'stick', count: 4 } }]);
  w.torch();
  assert.equal(w.executive.plan, null, 'unsafe replay is rejected before the old promise settles');
  await w.advance(75); await w.tick();
  crafting.release(); await flush();
  assert.equal(crafts, 1);
  assert.equal(w.bus.recent().find((e) => e.type === 'attempt_end')?.data?.status, 'interrupted');
});

test('gentle torch does not restart relative exploration from a new origin', async (t) => {
  const w = fixture(t), walking = gate();
  let walks = 0;
  t.mock.method(w.adapter, 'moveTo', async (_target, opts) => {
    walks++; await walking.promise; throwIfAborted(opts.signal);
  });
  await w.begin([{ skill: 'explore', args: { direction: 'E', distance: 24 } }]);
  w.adapter.pos.x = 12;
  w.torch();
  assert.equal(w.executive.plan, null);
  await w.advance(75); await w.tick();
  walking.release(); await flush();
  assert.equal(walks, 1, 'relative target must not be extended by replaying the skill');
});
