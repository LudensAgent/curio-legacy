import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Metrics } from '../src/observer/metrics.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import type { PlanContext } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };
const begin = { kind: 'begin', reason: '想比较眼前河岸的形状', intent: { text: '观察河岸形状', whyNow: '发现新的河岸' } };
const continuation = { kind: 'continue', reason: '继续比较同一处河岸' };
const reply = (decision: object, extra: object = {}): Completion => ({ latencyMs: 8400, text: JSON.stringify({
  goal: '观察河岸', decision, steps: [{ skill: 'look_around', args: { seconds: 2 } }], ...extra,
}) });

function fixture(t: TestContext) {
  // Keep real promise scheduling, skill code and look calls; only advance elapsed time.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (value: Completion) => void; reject: (error: Error) => void; signal?: AbortSignal; ctx: PlanContext; at: number }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'autonomous-continuity-model', complete: (_messages, signal, hint) =>
    new Promise((resolve, reject) => pending.push({ resolve, reject, signal, ctx: hint as PlanContext, at: Date.now() })),
  }, adapter, memory, bus, null);
  const look = t.mock.method(adapter, 'look');
  let learned = 0, actions = 0;
  const finishes: (() => void)[] = [];
  const previousSkill = SKILLS.continuity_action;
  SKILLS.continuity_action = { name: 'continuity_action', description: '保持当前模型选择的动作', argsDoc: '{}', timeoutMs: 60000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async (ctx) => {
      actions++; ctx.progress(0.98, '模型已经选择的动作快做完了');
      await new Promise<void>((resolve) => finishes.push(resolve));
      return ok('当前动作结束');
    } };
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner, onLearnSkill: () => learned++ });
  const reflex = new Reflex(adapter, arbiter, bus, vision);
  const metrics = new Metrics(adapter, arbiter, executive, planner, reflex, bus);
  executive.start(1_000_000);
  t.after(() => {
    executive.stop(); arbiter.cancel('test end'); memory.close();
    if (previousSkill) SKILLS.continuity_action = previousSkill;
    else delete SKILLS.continuity_action;
  });
  const tick = async () => { executive.tick(); await flush(); };
  let nextSampleAt = Date.now() + 1000;
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) {
      const step = Math.min(250, left);
      t.mock.timers.tick(step); await flush(); await tick();
      if (Date.now() >= nextSampleAt) { metrics.sample(); nextSampleAt += 1000; }
      left -= step;
    }
  };
  return { adapter, memory, bus, arbiter, planner, executive, metrics, pending, look, finishes, tick, advance,
    actions: () => actions, learned: () => learned };
}

test('slow autonomous choices get one useful sweep rather than repeated circles while waiting', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.planner.autonomous, true);
  assert.equal(w.pending.length, 1);
  assert.equal(w.arbiter.info()?.source, 'filler');
  assert.equal(w.arbiter.info()?.skill, 'look_around');
  await w.advance(8400);
  assert.equal(w.look.mock.callCount(), 8, 'one full sweep is enough at the same position');
  w.pending[0].resolve(reply(begin)); await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.source, 'llm', 'the returned model plan must replace background observation');
  const intentId = w.memory.currentIntent()?.id;
  await w.advance(1500);
  assert.equal(w.pending.length, 1, 'the next choice must wait for the observation result');
  await w.advance(1000);
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].ctx.reason, 'no_goal');
  assert.ok((w.pending[1].ctx.results as { skill: string; status: string }[]).some((r) => r.skill === 'look_around' && r.status === 'succeeded'));
  assert.equal(w.pending[1].ctx.binding?.milestoneId, undefined);
  await w.advance(22400 - (Date.now() - w.pending[1].at));

  const metrics = w.metrics.snapshot();
  t.diagnostic(`思考期间行动 ${(100 * (metrics.llmContinuity ?? 0)).toFixed(1)}%，无任务 ${metrics.idle10m}s，思考采样 ${metrics.llmThinkingSec}s`);
  assert.ok(metrics.llmThinkingSec >= 25, 'both slow requests must contribute to the measured interval');
  assert.ok(metrics.idle10m > 0, 'quiet waiting must remain visible in the metrics');
  assert.ok((metrics.llmContinuity ?? 1) < 1, 'do not keep spinning just to count waiting as activity');
  const fillers = w.bus.recent().filter((event) => event.type === 'task_start' && event.data?.source === 'filler');
  assert.equal(fillers.length, 1, 'a recent completed model sweep must also suppress redundant background sweeps');
  assert.equal(w.look.mock.callCount(), 16, 'only the initial sweep and the model-approved sweep should turn the actor');
  assert.ok(fillers.every((event) => event.data?.skill === 'look_around'));
  assert.deepEqual(w.adapter.pos, { x: 0, y: 64, z: 0 });
  assert.deepEqual(w.adapter.actions, [], 'waiting must not invent movement or resource consumption');
  assert.equal(w.memory.currentIntent()?.id, intentId);
  assert.equal(w.memory.decisions().length, 1, 'thinking and fillers must not create their own intent choices');
  w.pending[1].resolve(reply(continuation)); await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.source, 'llm');
});

test('elapsed time alone never restarts a completed background sweep', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(29_000);
  assert.equal(w.look.mock.callCount(), 8);
  assert.equal(w.arbiter.info(), null);
  assert.equal(w.pending.length, 1);
  await w.advance(6000);
  assert.equal(w.bus.recent().filter((event) => event.type === 'task_start' && event.data?.source === 'filler').length, 1);
  assert.equal(w.look.mock.callCount(), 8);
});

test('moving to a different position while thinking does not restart background sweeps', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(5000);
  w.adapter.pos.x += 2; await w.tick();
  assert.equal(w.arbiter.info(), null, 'small position jitter does not justify another circle');
  w.adapter.pos.x += 30; await w.tick();
  assert.equal(w.arbiter.info(), null, 'distance alone is not an information gap');
});

test('an autonomous open intent prefetches without a project and activates its reply only after the current action', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply(begin, { steps: [{ skill: 'continuity_action' }] })); await flush(); await w.tick();
  const current = w.arbiter.info()!;
  assert.equal(w.memory.activeProject(), undefined);
  await w.tick();
  assert.equal(w.pending.length, 2, 'open interests need prefetch just as measured projects do');
  assert.equal(w.pending[1].ctx.reason, 'prefetch');
  w.pending[1].resolve(reply(continuation, { memory_note: '后续计划激活后再保存' })); await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.id, current.id);
  assert.equal(w.memory.recentNotes().length, 0, 'prefetched side effects wait for activation');
  w.finishes[0](); await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.source, 'llm');
  assert.equal(w.arbiter.info()?.skill, 'look_around');
  assert.equal(w.memory.recentNotes().length, 1);
  assert.equal(w.actions(), 1);
});

test('a read-only query finishes before its result is used to choose the next plan', async (t) => {
  const w = fixture(t);
  SKILLS.continuity_action.readOnly = true;
  await w.tick();
  w.pending[0].resolve(reply(begin, { steps: [{ skill: 'continuity_action' }] })); await flush(); await w.tick();
  await w.tick();
  assert.equal(w.pending.length, 1);
  w.finishes[0](); await flush(); await w.tick();
  assert.equal(w.pending.length, 2);
  assert.ok((w.pending[1].ctx.results as { skill: string }[]).some((r) => r.skill === 'continuity_action'));
});

test('failed safety reflex outcomes reach the next choice with real water state and clear after recovery', async (t) => {
  const w = fixture(t), previous = SKILLS.test_water_reflex;
  let recovered = false;
  SKILLS.test_water_reflex = { name: 'test_water_reflex', description: 'test water outcome', argsDoc: '{}', timeoutMs: 1000,
    movement: false, validate: () => ({ ok: true, args: {} }), run: async () => recovered
      ? ok('已确认上岸', { landed: true }) : fail('STUCK', '氧气已恢复，仍未上岸', { landed: false }) };
  t.after(() => { if (previous) SKILLS.test_water_reflex = previous; else delete SKILLS.test_water_reflex; });
  w.adapter.inWater = true;
  await w.tick();
  assert.equal(w.arbiter.info(), null, 'water is not a place to fill model waiting with stationary sweeps');
  w.arbiter.start({ skill: 'test_water_reflex' }, 'reflex');
  await w.tick(); await flush(); await w.tick();
  const latest = w.pending.at(-1)!.ctx;
  assert.equal(latest.lastFailure?.code, 'STUCK');
  assert.equal(latest.lastFailure?.skill, 'test_water_reflex');
  assert.equal((latest.results as { data?: { landed?: boolean } }[]).at(-1)?.data?.landed, false);
  assert.equal((latest.decisionFeedback as { currentState: { inWater: boolean } }).currentState.inWater, true);
  recovered = true;
  w.adapter.inWater = false;
  w.arbiter.start({ skill: 'test_water_reflex' }, 'reflex');
  await flush(); w.executive.replan(); await flush();
  assert.equal(w.pending.at(-1)!.ctx.lastFailure, null, 'a later confirmed success clears the earlier failure of that skill');
});

test('voluntary deferral cancels observation and keeps the chosen waiting period idle', async (t) => {
  const w = fixture(t);
  w.memory.addIntent({ text: '欣赏河岸', whyNow: '喜欢这里', context: [], tradeoffs: [], source: 'model', status: 'active' });
  await w.tick(); await w.advance(1000);
  assert.equal(w.look.mock.callCount(), 0, 'an existing interest does not require automatic sightseeing');
  w.pending[0].resolve(reply({ kind: 'defer', reason: '先休息一会，观察留到之后' }, { steps: [] }));
  await flush(); await w.tick();
  const lookCount = w.look.mock.callCount();
  assert.equal(w.arbiter.info(), null);
  await w.advance(5000);
  assert.equal(w.look.mock.callCount(), lookCount);
  assert.equal(w.pending.length, 1);
  assert.equal(w.memory.intents()[0].status, 'deferred');
  assert.equal(w.memory.decisions()[0].kind, 'defer');
});

test('model failure cancels observation and preserves idle backoff without a substitute goal', async (t) => {
  const w = fixture(t);
  const intent = w.memory.addIntent({ text: '欣赏河岸', whyNow: '喜欢这里', context: [], tradeoffs: [], source: 'model', status: 'active' });
  await w.tick(); await w.advance(1000);
  assert.equal(w.arbiter.info(), null, 'waiting with a current interest is not a reason to sweep');
  w.pending[0].reject(new Error('temporary unavailable')); await flush(); await w.tick();
  const lookCount = w.look.mock.callCount();
  assert.equal(w.arbiter.info(), null);
  await w.advance(2000);
  assert.equal(w.look.mock.callCount(), lookCount);
  assert.equal(w.pending.length, 1);
  assert.equal(w.memory.currentIntent()?.id, intent.id);
  assert.equal(w.memory.recentGoals().length, 0);
  assert.ok(w.executive.snapshot().backoffMs > 0);
  assert.equal(w.bus.recent().some((event) => event.type === 'task_start' && event.data?.source === 'rule'), false);
});

test('pause rejects a late observed-plan reply before actions or durable side effects', async (t) => {
  const w = fixture(t);
  await w.tick(); await w.advance(1000);
  w.executive.pause();
  const lookCount = w.look.mock.callCount();
  w.pending[0].resolve(reply(begin, { memory_note: '迟到笔记', lesson: '迟到教训', learn_skill: { name: 'late' }, steps: [{ skill: 'continuity_action' }] }));
  await flush(); await w.advance(2000);
  assert.equal(w.pending[0].signal?.aborted, true);
  assert.equal(w.arbiter.info(), null);
  assert.equal(w.look.mock.callCount(), lookCount);
  assert.equal(w.memory.intents().length, 0);
  assert.equal(w.memory.recentNotes().length, 0);
  assert.equal(w.memory.lessons().length, 0);
  assert.equal(w.learned(), 0);
  assert.equal(w.actions(), 0);
});

test('a safety reflex owns the actor and invalidates a pending observation-time choice', async (t) => {
  const w = fixture(t);
  await w.tick();
  const reflex = w.arbiter.start({ skill: 'continuity_action' }, 'reflex');
  assert.ok(!('error' in reflex));
  await w.tick();
  w.pending[0].resolve(reply(begin, { memory_note: '反射前的迟到笔记' })); await flush(); await w.tick();
  assert.equal(w.pending[0].signal?.aborted, true);
  assert.equal(w.arbiter.info()?.id, reflex.id);
  assert.equal(w.arbiter.info()?.source, 'reflex');
  assert.equal(w.memory.intents().length, 0);
  assert.equal(w.memory.recentNotes().length, 0);
  w.finishes[0](); await flush(); await w.tick();
  assert.equal(w.pending.length, 2, 'a fresh choice follows the completed safety reflex');
});

test('session changes discard a late choice while a fresh request observes the new session', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.adapter.sessionId = 'reconnected-session';
  await w.tick();
  assert.equal(w.pending.length, 2);
  w.pending[0].resolve(reply(begin, { memory_note: '旧会话的迟到笔记', steps: [{ skill: 'continuity_action' }] }));
  await flush(); await w.tick();
  assert.equal(w.pending[0].signal?.aborted, true);
  assert.equal(w.pending[1].ctx.worldState?.sessionId, 'reconnected-session');
  assert.equal(w.memory.intents().length, 0);
  assert.equal(w.memory.recentNotes().length, 0);
  assert.equal(w.actions(), 0);
  assert.equal(w.executive.inFlight, true);
});

test('short autonomous attempts do not announce the end of their ongoing interest', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply(begin)); await flush(); await w.tick();
  const intentId = w.memory.currentIntent()?.id;
  await w.advance(2250);
  const attempts = w.bus.recent().filter((event) => event.type === 'attempt_end');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].data?.status, 'succeeded');
  assert.equal(attempts[0].severity, 'P3');
  assert.equal(w.bus.recent().filter((event) => event.type === 'goal_end').length, 0);
  assert.equal(w.memory.currentIntent()?.id, intentId);
  assert.equal(w.memory.recentGoals().length, 1, 'attempt evidence remains available to future choices');
  assert.equal(w.metrics.snapshot().attempts.succeeded, 1);
  assert.equal(w.metrics.snapshot().goals.succeeded, 0);
});

test('advancing a milestone preserves approved work while invalidating old speculative choices', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ ...begin, project: { title: '先取木样再取石样',
    successCondition: { type: 'inventory_min', item: 'cobblestone', count: 4 },
    milestones: [{ title: '取木样', condition: { type: 'inventory_min', item: 'oak_log', count: 1 } }],
  } }, { steps: [{ skill: 'continuity_action' }] }));
  await flush(); await w.tick(); await w.tick();
  const taskId = w.arbiter.info()?.id;
  assert.equal(w.pending.length, 2);
  w.adapter.inv.set('oak_log', 1);
  await w.tick();
  assert.equal(w.pending[1].signal?.aborted, true);
  assert.equal(w.arbiter.info()?.id, taskId, 'factually completing a checkpoint must not cancel its in-progress skill');
  assert.equal(w.executive.plan?.binding?.milestoneId, undefined);
  assert.equal(w.memory.activeProject()?.currentMilestone, 1);
  w.pending[1].resolve(reply(continuation, { memory_note: '旧检查点的过期选择' })); await flush();
  assert.equal(w.memory.recentNotes().length, 0);
  w.finishes[0](); await flush();
  assert.equal(w.bus.recent().filter((event) => event.type === 'attempt_end').length, 1);
  assert.equal(w.bus.recent().find((event) => event.type === 'attempt_end')?.data?.status, 'succeeded');
  assert.equal(w.bus.recent().filter((event) => event.type === 'goal_end').length, 0);
  assert.equal(w.memory.activeProject()?.noProgressAttempts, 0);
});

for (const completion of ['observation', 'attempt'] as const) {
  test(`a project emits one factual goal_end when completed through ${completion}`, async (t) => {
    const w = fixture(t);
    await w.tick();
    w.pending[0].resolve(reply({ ...begin, project: { title: '取到四块石样',
      successCondition: { type: 'inventory_min', item: 'cobblestone', count: 4 },
    } }, { steps: [{ skill: 'continuity_action' }] }));
    await flush(); await w.tick(); await w.tick();
    w.adapter.inv.set('cobblestone', 4);
    if (completion === 'attempt') { w.finishes[0](); await flush(); }
    await w.tick(); await w.tick();
    const goals = w.bus.recent().filter((event) => event.type === 'goal_end');
    assert.equal(goals.length, 1);
    assert.equal(goals[0].data?.scope, 'project');
    assert.equal(goals[0].data?.status, 'succeeded');
    assert.ok(goals[0].data?.evidenceId);
    assert.equal(w.memory.projects()[0].status, 'completed');
    assert.equal(w.metrics.snapshot().goals.succeeded, 1);
    assert.equal(w.metrics.snapshot().attempts.succeeded, 1);
    assert.equal(w.executive.plan, null);
    assert.equal(w.pending[1].signal?.aborted, true, 'completion cancels the obsolete prefetch immediately');
    if (completion === 'observation') { w.finishes[0](); await flush(); }
  });
}
