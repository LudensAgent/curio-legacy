import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import type { Arbiter, Step, TaskInfo } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept, Perception } from '../src/perception/perception.ts';
import type { Plan } from '../src/planner/plan.ts';
import type { Planner } from '../src/planner/planner.ts';
import type { PlanContext } from '../src/planner/prompt.ts';

// Dispatch, promise and evidence lifecycle only. No timers, primitive run functions or game adapter actions execute.
test('approved recovery reaches its result boundary before a queued reply; fresh focus evidence drives the next choice', async (t) => {
  const now = 1_700_000_000_000; t.mock.method(Date, 'now', () => now);
  const state: AgentState = { connected: true, alive: true, observationReady: true, worldId: 'handoff', sessionId: 's', observationId: 1,
    username: 'test', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20, timeOfDay: 1000, isDay: true,
    biome: 'plains', onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null };
  const adapter = { state: () => ({ ...structuredClone(state), observationId: ++state.observationId }), isKnownItem: () => true } as unknown as GameAdapter;
  const percept = { self: { pos: [0, 64, 0], dim: state.dim }, nearby: { resources: [], passive: [], hostile: [], players: [] },
    vision: null, exploration: { visitedChunks: 1 }, learn_candidates: [] } as unknown as Percept;
  const perception = { update: () => percept, snapshot: () => percept, observeBlocks: () => [] } as unknown as Perception;
  const memory = new WorldMemory(null), bus = new EventBus(); memory.setWorld(state.worldId);
  memory.addIntent({ text: '检查自己当前的设想', whyNow: '已有一个需要验证的问题', context: [], tradeoffs: [], source: 'model', status: 'active' });
  let current: TaskInfo | null = null, cancelled = 0, serial = 0;
  const dispatched: string[] = [], pending: { ctx: PlanContext; resolve: (p: Plan) => void }[] = [];
  const arbiter = { info: () => current, cancel: () => { cancelled++; current = null; },
    start: (step: Step, source: TaskInfo['source'], meta: { planId?: string } = {}) => {
      dispatched.push(step.skill);
      return current = { ...step, args: step.args ?? {}, source, planId: meta.planId, id: `task-${serial++}`, planVersion: 1,
        startedAt: now, deadline: now + 10000, movement: false, progress: 0, note: '' };
    } } as unknown as Arbiter;
  const planner = { autonomous: true, propose: (ctx: PlanContext) => new Promise<Plan>((resolve) => pending.push({ ctx, resolve })) } as unknown as Planner;
  const executive: any = new Executive({ adapter, arbiter, planner, perception, memory, bus });
  executive.timer = {}; // Enable only the handoff guard; do not start a scheduler interval.
  executive.keepThinkingActive = () => {}; // Filler activity is outside this dispatch test.
  executive.lastFullAt = executive.lastReflectionAt = now;
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const plan = (id: string, skill: string): Plan => ({ id, source: 'llm', thought: '', goal: '核对同一个问题', goalType: 'investigate',
    steps: [{ skill }], index: 0, createdAt: now, retries: 0, abortIf: {}, binding: executive.projects.currentBinding(), generation: executive.generation });
  t.after(() => { executive.timer = null; executive.invalidate('test complete'); memory.close(); });
  const first = { ...plan('first', 'dig'), lesson: '这只是我在执行前提出的推测', onFail: [{ skill: 'look_around' }],
    focus: { approach: '先核对当前可见事实', question: '这次结果会符合预期吗？' }, expect: { type: 'self_state', field: 'held', equals: 'stone' } } as Plan;
  executive.activate(first);
  assert.equal(memory.lessonsFor().length, 0, 'an unexecuted plan cannot save its own lesson');
  executive.startNext(); const failedTask = current!; current = null;
  executive.onDone({ task: failedTask, result: { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: '原操作失败' }, durationMs: 10 });
  await flush();
  assert.deepEqual(dispatched, ['dig', 'look_around']);
  assert.equal(pending.length, 0, 'an explicit observation fallback waits for its result before requesting another choice');
  const observation = current!;
  executive.request('failure'); // A reply already requested by an older caller must still respect ownership.
  const stale = plan('stale-reply', 'wait'); pending[0].resolve(stale); await flush();
  assert.equal(cancelled, 0); assert.equal(current, observation); assert.equal(executive.plan, first);
  assert.equal(executive.queued, stale, 'reply arrival alone cannot cancel the approved observation');
  current = null;
  executive.onDone({ task: observation, result: { status: 'succeeded', summary: '实际观察仍未满足预期' }, durationMs: 100 });
  await flush();
  assert.equal(executive.queued, null, 'the reply based on the pre-observation snapshot must be discarded');
  assert.equal(pending.length, 2, 'the fresh choice is requested without waiting for a scheduler tick');
  assert.equal((pending[1].ctx.results as any[]).at(-1).summary, '实际观察仍未满足预期');
  assert.match((pending[1].ctx.workingFocus as any).recentAttempts.at(-1).execution.summary, /原操作失败.*补救.*实际观察/);
  assert.equal((pending[1].ctx.workingFocus as any).pendingMismatch !== null, true);
  assert.equal(pending[1].ctx.tier, 'full');
  assert.equal(executive.wouldBeFull(), false, 'the same prediction mismatch cannot trigger full repeatedly');
  assert.equal(memory.lessonsFor()[0].source, 'model', 'a completed attempt retains a claim only as model inference');
  const previousPrediction = plan('prepared-before-mismatch', 'wait');
  executive.preparedAgainstFocus.set(previousPrediction, null);
  assert.equal(executive.activate(previousPrediction), false, 'even an unconditional continuation must reconsider a newly contradicted prediction');
  executive.invalidate('check interrupted lifecycle');
  const unstarted = { ...plan('unstarted', 'wait'), lesson: '还没执行的另一个推测' };
  executive.activate(unstarted); executive.discardPlan('安全中断');
  assert.equal(memory.lessonsFor().length, 1, 'interrupted, unexecuted claims are not saved');
  assert.deepEqual(dispatched, ['dig', 'look_around'], 'the scheduler never invents a boat, gathering action or replacement goal');
  executive.timer = null;
  current = { ...observation, skill: 'glance', source: 'filler', planId: undefined };
  executive.request('manual_replan');
  pending[2].resolve(plan('fresh-after-background-observation', 'wait')); await flush();
  assert.deepEqual(executive.queued.basis.pending, [], 'background filler is not an unresolved approved action');
  assert.equal(executive.activate(executive.queued), true, 'a background glance cannot permanently reject a fresh validated choice');
});
