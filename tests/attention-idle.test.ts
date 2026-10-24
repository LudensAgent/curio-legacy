import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Executive } from '../src/brain/executive.ts';

// Only exercise attention scheduling: no skills, pathfinding, game world or model run.
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const state = { worldId: 'world', sessionId: 'session', dim: 'overworld', connected: true, alive: true,
    observationReady: true, observationId: 1, pos: { x: 0, y: 64, z: 0 }, inWater: false, inLava: false, onGround: true };
  const starts: { skill: string; args: unknown }[] = [];
  let running: { source: string; skill: string } | null = null;
  let hasIntent = true;
  const executive = Object.assign(Object.create(Executive.prototype), {
    timer: true, inFlight: true, paused: false, suspended: new Set(), plan: null, queued: null,
    lastLook: null, lastFailure: null, results: [], durations: new Map(), gentlyPreemptedTasks: new Set(),
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
    current: () => running,
    schedule: () => executive.keepThinkingActive(),
    finish(skill: string) {
      running = null;
      executive.onDone({ task: { skill, source: skill === 'goto' ? 'llm' : 'filler' },
        result: { status: 'succeeded', summary: 'done' }, durationMs: 0 });
    },
    unknown: () => { hasIntent = false; },
  };
}

test('thinking keeps continuous quiet observation without repeated starts or idle gaps', (t) => {
  const w = fixture(t);
  w.finish('goto'); w.schedule();
  assert.deepEqual(w.starts, [{ skill: 'glance', args: { seconds: 120 } }]);
  let active = 0;
  for (let sample = 0; sample < 30; sample++) {
    t.mock.timers.tick(1000); w.schedule();
    if (w.current()) active++;
  }
  assert.ok(active / 30 >= .95, 'controlled scheduling must cover at least 95% of a pending decision');
  assert.equal(w.starts.length, 1, 'a long request must not repeatedly restart the camera task');
  w.finish('glance'); w.schedule();
  assert.equal(w.starts.length, 2, 'natural completion hands straight to another quiet observation');
});

test('recent observation preserves gaze; completed decisions and hazardous movement yield control', (t) => {
  const w = fixture(t);
  w.finish('look_around');
  assert.equal(w.starts.length, 1);
  w.state.pos.x = 16; w.schedule();
  assert.equal(w.starts.length, 1, 'displacement alone does not restart a full sweep');
  w.executive.inFlight = false; w.schedule();
  assert.equal(w.current(), null, 'a finished decision immediately ends background observation');
  w.executive.inFlight = true; w.state.inWater = true; w.schedule();
  w.state.inWater = false; w.state.onGround = false; w.schedule();
  assert.equal(w.starts.length, 1, 'do not start stationary observation in water or while falling');
});

test('unknown surroundings still get one initial full observation', (t) => {
  const w = fixture(t); w.unknown(); w.schedule();
  assert.deepEqual(w.starts, [{ skill: 'look_around', args: { seconds: 4 } }]);
  w.finish('look_around'); w.schedule();
  t.mock.timers.tick(6000); w.schedule();
  assert.equal(w.starts.length, 2, 'time alone does not restart the full observation');
  assert.equal(w.starts[1].skill, 'glance');
});
