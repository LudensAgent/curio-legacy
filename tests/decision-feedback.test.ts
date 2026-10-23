import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { DecisionFeedback } from '../src/brain/decision-feedback.ts';
import type { Percept } from '../src/perception/perception.ts';
import type { Plan } from '../src/planner/plan.ts';

const state = (over: Partial<AgentState> = {}): AgentState => ({
  connected: true, alive: true, observationReady: true, worldId: 'world-a', sessionId: 'session-a', observationId: 1,
  username: 'Curio', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20,
  timeOfDay: 1000, isDay: true, biome: 'plains', onGround: true, inWater: false, inLava: false,
  inventory: [], emptySlots: 36, held: null, ...over,
});
const percept = (over: Partial<Percept> = {}): Percept => ({
  ts: Date.now(), connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [], emptySlots: 36, nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 64, view: 'grass 60%', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: 0 },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, storage: null,
  ...{ light: null, farms: [], learn_candidates: [], reflection_due: false },
  efficiency: [], exploration: { visitedChunks: 1, noveltyByDir: {}, base: null }, ...over,
});
const plan = (id = 'p1', steps: Plan['steps'] = [{ skill: 'look_around', args: { seconds: 4 } }]): Plan => ({
  id, source: 'llm', thought: '观察自己感兴趣的环境', goal: '比较附近的环境', goalType: 'investigate', steps,
  index: 0, abortIf: {}, createdAt: Date.now(), retries: 0,
});
const finish = (feedback: DecisionFeedback, p: Plan, s = state(), v = percept(), status = 'succeeded', summary = '本轮观察结束') => {
  p.index = p.steps.length; feedback.end(p, status, summary, s, v);
};

test('repeated empty observations expose a factual pattern without assigning an intention or fallback goal', () => {
  const feedback = new DecisionFeedback();
  for (let i = 0; i < 3; i++) {
    const p = plan(`p${i}`);
    feedback.begin(p, state(), percept()); finish(feedback, p, state(), percept(), 'succeeded', '没有看到树');
  }
  const context = feedback.context(state());
  assert.equal(context.repeatedStepPattern?.consecutiveAttempts, 3);
  assert.deepEqual(context.repeatedStepPattern?.steps, [{ skill: 'look_around', args: { seconds: 4 } }]);
  assert.equal(context.recentAttempts.length, 3);
  const last = context.recentAttempts.at(-1)!;
  assert.equal(last.status, 'succeeded');
  assert.deepEqual(last.changes.inventoryDelta, []);
  assert.equal(last.changes.movement?.distance, 0);
  assert.deepEqual(last.changes.resourceTypeChanges?.known, { added: [], removed: [] });
  for (const field of ['nextGoal', 'recommendation', 'failedIntention', 'noProgress']) assert.equal(field in context || field in last, false);
});

test('travel and resource discovery remain visible when inventory does not change', () => {
  const feedback = new DecisionFeedback(), p = plan('travel', [{ skill: 'explore', args: { direction: 'E', distance: 64 } }]);
  feedback.begin(p, state(), percept());
  const arrival = state({ pos: { x: 64, y: 64, z: 0 }, biome: 'forest' }), view = percept();
  view.nearby.resources.push({ block: 'oak_log', count: 3, nearest: 12, seen: 'now' });
  view.vision!.view = 'wood 40%'; view.exploration.visitedChunks = 5;
  finish(feedback, p, arrival, view);
  const attempt = feedback.context(arrival).recentAttempts[0];
  assert.deepEqual(attempt.changes.inventoryDelta, []);
  assert.equal(attempt.changes.movement?.distance, 64);
  assert.deepEqual(attempt.changes.resourceTypeChanges?.known.added, ['oak_log']);
  assert.deepEqual(attempt.changes.resourceTypeChanges?.visible.added, ['oak_log']);
  assert.deepEqual(attempt.changes.biome, { before: 'plains', after: 'forest' });
  assert.deepEqual(attempt.changes.view, { before: 'grass 60%', after: 'wood 40%' });
  assert.equal(attempt.after.visitedChunks - attempt.before.visitedChunks, 4);
  const observe = plan('observe'); feedback.begin(observe, arrival, view);
  const observed = structuredClone(view);
  observed.nearby.resources.push({ block: 'coal_ore', count: 1, nearest: 9, seen: 'now' });
  finish(feedback, observe, arrival, observed);
  assert.equal(feedback.context(arrival).repeatedStepPattern?.consecutiveAttempts, 1);
  assert.deepEqual(feedback.context(arrival).recentAttempts[1].changes.resourceTypeChanges?.known.added, ['coal_ore']);
});

test('inventory deltas aggregate item stacks and retain both consumed and acquired amounts', () => {
  const feedback = new DecisionFeedback(), p = plan('craft', [{ skill: 'craft', args: { item: 'torch', count: 4 } }]);
  const before = state({ inventory: [{ name: 'coal', count: 2 }, { name: 'stick', count: 2 }, { name: 'coal', count: 1 }] });
  feedback.begin(p, before, percept());
  before.inventory[0].count = 999; // Captured baselines must not alias live game state.
  const after = state({ inventory: [{ name: 'coal', count: 2 }, { name: 'stick', count: 1 }, { name: 'torch', count: 4 }] });
  finish(feedback, p, after);
  assert.deepEqual(feedback.context(after).recentAttempts[0].changes.inventoryDelta, [
    { item: 'coal', before: 3, after: 2, delta: -1 }, { item: 'stick', before: 2, after: 1, delta: -1 }, { item: 'torch', before: 0, after: 4, delta: 4 },
  ]);
});

test('only started steps enter the pattern and observation changes are not inferred from unstarted work', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const feedback = new DecisionFeedback(), p = plan('partial', [{ skill: 'look_around' }, { skill: 'gather', args: { block: 'log', count: 4 } }]);
  feedback.begin(p, state(), percept()); t.mock.timers.tick(3500); p.index = 1;
  feedback.end(p, 'interrupted', '受到生存反射打断', state({ inWater: true, oxygen: 8 }), percept());
  const attempt = feedback.context(state()).recentAttempts[0];
  assert.deepEqual(attempt.stepsStarted, [{ skill: 'look_around', args: {} }]);
  assert.equal(attempt.startedAt, 10000); assert.equal(attempt.endedAt, 13500); assert.equal(attempt.durationMs, 3500);
  assert.deepEqual(attempt.changes.water, { before: false, after: true });
  assert.equal(attempt.after.vitals.oxygen, 8);
});

test('scope transitions reset the episode and never compare unrelated coordinates or resource sets', () => {
  const feedback = new DecisionFeedback(), first = plan('first');
  feedback.begin(first, state(), percept()); finish(feedback, first);
  const crossing = plan('crossing', [{ skill: 'travel_portal' }]); feedback.begin(crossing, state(), percept());
  const nether = state({ dim: 'the_nether', sessionId: 'nether-session', pos: { x: 8, y: 65, z: 0 } });
  finish(feedback, crossing, nether);
  const context = feedback.context(nether);
  assert.equal(context.recentAttempts.length, 1);
  assert.equal(context.recentAttempts[0].changes.scopeChanged, true);
  assert.equal(context.recentAttempts[0].changes.movement, null);
  assert.equal(context.recentAttempts[0].changes.resourceTypeChanges, null);
  assert.equal(context.scopeChange?.from.dim, 'overworld'); assert.equal(context.scopeChange?.to.dim, 'the_nether');
  assert.equal(context.repeatedStepPattern, null);
  const differentWorld = state({ worldId: 'world-b' });
  assert.deepEqual(feedback.context(differentWorld).recentAttempts, []);
  assert.deepEqual(feedback.context(state()).recentAttempts, [], 'returning does not revive an old loop streak');
});

test('session changes invalidate movement and reset a prior repeat streak', () => {
  const feedback = new DecisionFeedback(), p = plan(); feedback.begin(p, state(), percept());
  const respawned = state({ sessionId: 'respawn', pos: { x: 200, y: 64, z: 0 } });
  finish(feedback, p, respawned);
  const context = feedback.context(respawned);
  assert.equal(context.recentAttempts[0].changes.movement, null);
  assert.equal(context.repeatedStepPattern, null);
  assert.equal(context.scopeChange?.to.sessionId, 'respawn');
});

test('context stays bounded, copied, and current survival facts do not depend on finishing an attempt', () => {
  const feedback = new DecisionFeedback();
  for (let i = 0; i < 10; i++) { const p = plan(`p${i}`); feedback.begin(p, state(), percept()); finish(feedback, p); }
  const context = feedback.context(state({ hp: 8, food: 10, oxygen: 4, inWater: true, inLava: false, onGround: false }));
  assert.equal(context.recentAttempts.length, 6);
  assert.equal(context.repeatedStepPattern?.consecutiveAttempts, 6);
  assert.equal(context.currentState.oxygen, 4); assert.equal(context.currentState.inWater, true); assert.equal(context.currentState.onGround, false);
  context.recentAttempts[0].before.inventory.fabricated = 99;
  assert.equal(feedback.context(state()).recentAttempts[0].before.inventory.fabricated, undefined);
  const huge = plan('large', [{ skill: 'custom_action', args: { specification: 'x'.repeat(10000) } }]);
  feedback.begin(huge, state(), percept()); finish(feedback, huge, state(), percept(), 'failed', 'z'.repeat(10000));
  const latest = feedback.context(state()).recentAttempts.at(-1)!;
  assert.equal(latest.summary.length, 500);
  assert.equal(latest.stepsStarted[0].args.truncated, true);
  assert.ok(JSON.stringify(latest.stepsStarted).length < 500);
});

test('fresh optional perception exposes visible and remembered resources with an observation timestamp', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const feedback = new DecisionFeedback(), v = percept();
  v.nearby.resources = [{ block: 'oak_log', count: 4, nearest: 8, seen: 'now' }, { block: 'coal_ore', count: 2, nearest: 20, seen: 'memory' }];
  const context = feedback.context(state(), v);
  assert.deepEqual(context.currentState.resources, { observedAt: 10000, visibleTypes: ['oak_log'], rememberedTypes: ['coal_ore'] });
  assert.equal(feedback.context(state({ sessionId: 'new-session' })).currentState.resources, null);
});

test('an unmatched end cannot invent an empty before-state or no-progress attempt', () => {
  const feedback = new DecisionFeedback();
  feedback.end(plan(), 'failed', '没有开始快照', state(), percept());
  assert.deepEqual(feedback.context(state()).recentAttempts, []);
});
