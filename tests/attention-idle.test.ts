import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Executive } from '../src/brain/executive.ts';

// Only exercise attention scheduling: no skills, pathfinding, game world or model run.
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const state = { worldId: 'world', sessionId: 'session', dim: 'overworld', connected: true, alive: true,
    observationReady: true, observationId: 1, pos: { x: 0, y: 64, z: 0 }, inWater: false, inLava: false };
  const starts: { skill: string; args: unknown }[] = [];
  let running: { source: string; skill: string } | null = null;
  let hasIntent = true;
  const executive = Object.assign(Object.create(Executive.prototype), {
    timer: true, inFlight: true, paused: false, suspended: new Set(), plan: null, queued: null,
    lastLook: null, idleAttention: null, lastFailure: null, results: [], durations: new Map(), gentlyPreemptedTasks: new Set(),
    d: {
      adapter: { state: () => ({ ...state, pos: { ...state.pos } }) },
      arbiter: {
        info: () => running,
        start: (step: { skill: string; args: unknown }, source: string) => { starts.push(step); running = { skill: step.skill, source }; },
        cancel: () => { running = null; },
      },
      memory: { currentIntent: () => hasIntent ? { id: 'interest' } : null },
      perception: { snapshot: () => ({ nearby: { resources: [], hostile: [], passive: [], players: [] } }) },
    },
  });
  return {
    state, starts, executive,
    schedule: () => executive.keepThinkingActive(),
    finish(skill: string) {
      running = null;
      executive.onDone({ task: { skill, source: skill === 'glance' ? 'filler' : 'llm' },
        result: { status: 'succeeded', summary: 'done' }, durationMs: 0 });
    },
    unknown: () => { hasIntent = false; },
  };
}

test('arrival keeps attention across short requests and only occasionally starts a brief glance', (t) => {
  const w = fixture(t);
  w.finish('goto'); w.schedule();
  t.mock.timers.tick(6000);
  w.executive.inFlight = false; w.schedule();
  w.executive.inFlight = true; w.schedule();
  t.mock.timers.tick(5999); w.schedule();
  assert.deepEqual(w.starts, [], 'a new model request does not reset attention or force a camera turn');
  t.mock.timers.tick(1); w.schedule();
  assert.deepEqual(w.starts, [{ skill: 'glance', args: { seconds: 2 } }]);
  w.finish('glance'); w.schedule();
  assert.equal(w.starts.length, 1, 'a completed glance is followed by another quiet interval');
});

test('recent observation, displacement and a new session each renew the quiet interval', (t) => {
  const w = fixture(t);
  w.finish('look_around');
  t.mock.timers.tick(10_000); w.schedule();
  assert.equal(w.starts.length, 0);
  w.state.pos.x = 16; w.schedule();
  t.mock.timers.tick(10_000); w.schedule();
  assert.equal(w.starts.length, 0, 'new surroundings get time to hold the current view');
  w.state.sessionId = 'new-session'; w.schedule();
  t.mock.timers.tick(10_000); w.schedule();
  assert.equal(w.starts.length, 0, 'attention from the previous session does not trigger a turn');
});

test('unknown surroundings still get one initial full observation', (t) => {
  const w = fixture(t); w.unknown(); w.schedule();
  assert.deepEqual(w.starts, [{ skill: 'look_around', args: { seconds: 4 } }]);
  w.finish('look_around'); w.schedule();
  t.mock.timers.tick(6000); w.schedule();
  assert.equal(w.starts.length, 1, 'time alone does not restart the full observation');
});
