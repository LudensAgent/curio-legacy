import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { glance } from '../src/skills/wait.ts';
import type { SkillCtx } from '../src/skills/types.ts';

// Clock, observations and look calls only; no game or movement simulation.
function fixture(durationMs: number) {
  const state = { connected: true, alive: true, observationReady: true, worldId: 'world', sessionId: 'session', dim: 'overworld',
    hp: 20, onGround: true, inWater: false, inLava: false } as AgentState;
  const controller = new AbortController(), looks: { yaw: number; pitch: number; signal?: AbortSignal }[] = [];
  let refreshes = 0, visible = true;
  const adapter = { state: () => ({ ...state }), eye: () => ({ yaw: 1.1, pitch: 0.37 }),
    async look(yaw: number, pitch: number, signal?: AbortSignal) { looks.push({ yaw, pitch, signal }); } };
  const ctx = { adapter, signal: controller.signal, deadline: Date.now() + durationMs,
    senses: { refresh() { refreshes++; }, perceivedEntities: () => visible ? [{ perception: 'seen' }] : [] }, progress() {},
  } as unknown as SkillCtx;
  return { ctx, adapter, controller, looks, state, refreshes: () => refreshes, visible: (value: boolean) => { visible = value; } };
}

test('glance maintains long attention at the current pitch, refreshes visibility and respects its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = fixture(31_000), validated = glance.validate({ seconds: 120 }, w.ctx.adapter);
  assert.ok(validated.ok); assert.equal(validated.args.seconds, 120);
  const pending = glance.run(w.ctx, validated.args);
  const advance = async (count: number) => { for (let i = 0; i < count; i++) { t.mock.timers.tick(500); await setImmediate(); } };
  await advance(20);
  assert.equal(w.looks.length, 0, 'a nearby visible subject keeps the current attention');
  w.visible(false);
  await advance(42);
  const result = await pending;
  assert.equal(result.status, 'succeeded'); assert.equal(result.data?.seconds, 31);
  assert.ok(w.refreshes() >= 60, 'current visibility must keep refreshing beyond the old twenty-second limit');
  assert.ok(w.looks.length > 0 && w.looks.length <= 3, 'empty surroundings only occasion a small glance');
  for (const look of w.looks) {
    assert.ok(Math.abs(look.yaw - 1.1) <= 0.160001);
    assert.equal(look.pitch, 0.37, 'preserve the direction being examined');
  }
});

test('glance yields immediately on cancellation and ends safely on changed scope or danger', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = fixture(120_000); w.visible(false);
  let finishLook!: () => void;
  w.adapter.look = (yaw: number, pitch: number, signal?: AbortSignal) => {
    w.looks.push({ yaw, pitch, signal }); return new Promise<void>((resolve) => { finishLook = resolve; });
  };
  const pending = glance.run(w.ctx, { seconds: 120 });
  for (let i = 0; i < 16; i++) { t.mock.timers.tick(500); await setImmediate(); }
  assert.equal(w.looks.length, 1);
  w.controller.abort('new decision');
  await assert.rejects(pending, { name: 'AbortedError' });
  assert.equal(w.looks[0].signal?.aborted, true, 'a pending turn must surrender its own input too');
  const refreshes = w.refreshes(); finishLook();
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(w.refreshes(), refreshes); assert.equal(w.looks.length, 1, 'late completion cannot restore an old view');

  for (const [change, reason] of [
    [{ sessionId: 'new-session' }, 'session_changed'], [{ hp: 19 }, 'hurt'],
    [{ inWater: true }, 'water'], [{ inLava: true }, 'lava'], [{ onGround: false }, 'airborne'],
  ] as const) {
    const unsafe = fixture(120_000), observing = glance.run(unsafe.ctx, { seconds: 120 });
    Object.assign(unsafe.state, change);
    t.mock.timers.tick(500); await setImmediate();
    assert.equal((await observing).data?.interrupted, reason);
    assert.equal(unsafe.looks.length, 0);
  }
});
