import type { AgentState } from '../adapter/types.ts';
import type { Plan } from '../planner/plan.ts';
import { evaluateCondition, observationReady, observeCondition } from '../projects/conditions.ts';
import type { Condition, ConditionResult } from '../projects/types.ts';
import type { Senses } from '../skills/types.ts';
import { shortId } from '../util.ts';

type Observer = Pick<Senses, 'observeBlocks'>;
type Scope = { worldId: string; sessionId: string; dimension: string; intentId?: string };
type PredictionOutcome = 'matched' | 'not_observed' | 'unknown' | 'already_satisfied' | 'interrupted';
type Subjectives = { source: 'model'; approach?: string; question?: string | null; then?: string };
export interface FocusAttempt {
  planId: string; at: number; goal: string;
  attemptedSteps: { skill: string; args?: unknown }[];
  execution: { status: string; summary?: string };
  observed: { before: unknown; after: unknown };
  prediction?: { expected: unknown; before: ConditionResult; after: ConditionResult; outcome: PredictionOutcome; reason: string; eventId?: string };
}
interface Active { planId: string; goal: string; expected?: Condition; before?: ConditionResult; state: AgentState; at: number }

const scopeOf = (s: AgentState, intentId?: string): Scope => ({ worldId: s.worldId, sessionId: s.sessionId, dimension: s.dim, ...(intentId ? { intentId } : {}) });
const equalScope = (a: Scope, b: Scope) => a.worldId === b.worldId && a.sessionId === b.sessionId && a.dimension === b.dimension && a.intentId === b.intentId;
const bounded = (value: unknown, maxBytes = 600): any => {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return structuredClone(value ?? null);
  let preview = json.slice(0, Math.floor(maxBytes / 4));
  while (Buffer.byteLength(preview, 'utf8') > maxBytes - 80) preview = preview.slice(0, -10);
  return { truncated: true, preview };
};
const measured = (s: AgentState) => ({ observationReady: observationReady(s), observationId: s.observationId,
  pos: { ...s.pos }, hp: s.hp, food: s.food, inWater: s.inWater, onGround: s.onGround, held: s.held, riding: s.riding });
const resultView = (r: ConditionResult): ConditionResult => ({ status: r.status, actual: bounded(r.actual, 500), ...(r.reason ? { reason: r.reason.slice(0, 180) } : {}) });
const inspect = (condition: Condition, state: AgentState, senses?: Observer): ConditionResult => {
  if (!observationReady(state)) return { status: 'unknown', actual: null, reason: '缺少当前有效观测' };
  try { return evaluateCondition(condition, state, state.worldId, observeCondition(condition, senses)); }
  catch { return { status: 'unknown', actual: null, reason: '本次观测不可用，不能据此判断预期' }; }
};
const shortText = (value: string | undefined, maxBytes: number) => {
  if (!value) return value;
  let text = value;
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1);
  return text;
};

/** A small current line of thought plus measured prediction checks, not a knowledge or goal selector. */
export class WorkingFocus {
  private scope: Scope | null = null;
  private subjectives: Subjectives = { source: 'model' };
  private active: Active | null = null;
  private attempts: FocusAttempt[] = [];
  private mismatch: { eventId: string; planId: string; at: number } | null = null;

  clear() {
    this.scope = null; this.subjectives = { source: 'model' }; this.active = null; this.attempts = []; this.mismatch = null;
  }

  private sync(state: AgentState, intentId?: string) {
    const next = scopeOf(state, intentId);
    if (this.scope && !equalScope(this.scope, next)) this.clear();
    this.scope = next;
  }

  begin(plan: Plan, state: AgentState, senses?: Observer) {
    this.sync(state, plan.binding?.intentId);
    if (plan.focus?.approach !== undefined) this.subjectives.approach = plan.focus.approach;
    if (plan.focus?.question !== undefined) this.subjectives.question = plan.focus.question;
    if (plan.then !== undefined) this.subjectives.then = plan.then;
    this.active = { planId: plan.id, goal: plan.goal.slice(0, 100), state: structuredClone(state), at: Date.now(),
      ...(plan.expect ? { expected: structuredClone(plan.expect), before: inspect(plan.expect, state, senses) } : {}) };
  }

  end(plan: Plan, status: string, state: AgentState, senses?: Observer, summary?: string): FocusAttempt | undefined {
    const active = this.active;
    if (!active || active.planId !== plan.id) return;
    const scope = scopeOf(state, plan.binding?.intentId);
    if (!this.scope || !equalScope(this.scope, scope)) { this.clear(); return; }
    this.active = null;
    const attempt: FocusAttempt = { planId: plan.id, at: Date.now(), goal: active.goal,
      attemptedSteps: plan.steps.slice(0, Math.max(0, plan.index)).map((s) => ({ skill: s.skill, ...(s.args === undefined ? {} : { args: bounded(s.args, 180) }) })),
      execution: { status, ...(summary ? { summary: summary.slice(0, 140) } : {}) },
      observed: { before: measured(active.state), after: measured(state) } };
    if (active.expected && active.before) {
      const before = active.before;
      const fresh = observationReady(state) && observationReady(active.state) && state.observationId > active.state.observationId;
      const after = fresh ? inspect(active.expected, state, senses)
        : { status: 'unknown' as const, actual: null, reason: '没有更新的同会话有效观测' };
      const interrupted = plan.index <= 0 || ['interrupted', 'cancelled', 'aborted', 'replaced', 'deferred'].includes(status);
      let outcome: PredictionOutcome, reason: string;
      if (interrupted) { outcome = 'interrupted'; reason = '尝试被中断，保留实际观察，不据此判断预期或机制'; }
      else if (before.status === 'unknown' || after.status === 'unknown') { outcome = 'unknown'; reason = '前后条件至少一侧未看清，不能支持或反驳预期'; }
      else if (after.status === 'satisfied') {
        outcome = before.status === 'satisfied' ? 'already_satisfied' : 'matched';
        reason = before.status === 'satisfied' ? '预期在尝试前已成立，不是本次新学会或产生的效果' : '实际观测符合本次预期，仅支持当前情境，不证明长期规律';
      } else { outcome = 'not_observed'; reason = '实际重观测未满足本次预期；执行状态单列，不据此断言机制不存在'; }
      const eventId = outcome === 'not_observed' ? shortId('prediction_') : undefined;
      attempt.prediction = { expected: bounded(active.expected, 700), before: resultView(before), after: resultView(after), outcome, reason, ...(eventId ? { eventId } : {}) };
      this.mismatch = eventId ? { eventId, planId: plan.id, at: attempt.at } : null;
    }
    this.attempts.push(attempt); this.attempts = this.attempts.slice(-3);
    return structuredClone(attempt);
  }

  context(state: AgentState, intentId?: string) {
    this.sync(state, intentId);
    const recentAttempts = structuredClone(this.attempts);
    const context = { source: 'working_focus' as const, scope: this.scope ? { ...this.scope } : null, subjectives: { ...this.subjectives },
      ...(this.active ? { current: { planId: this.active.planId, goal: this.active.goal, ...(this.active.expected ? { expect: bounded(this.active.expected, 700) } : {}) } } : {}),
      recentAttempts, pendingMismatch: this.mismatch ? { ...this.mismatch } : null,
      meaning: 'subjective_approach_and_measured_prediction_checks_not_learned_facts' };
    while (recentAttempts.length > 1 && Buffer.byteLength(JSON.stringify(context), 'utf8') > 5000) recentAttempts.shift();
    if (Buffer.byteLength(JSON.stringify(context), 'utf8') > 5000) {
      context.subjectives.approach = shortText(context.subjectives.approach, 240);
      context.subjectives.question = context.subjectives.question === null ? null : shortText(context.subjectives.question, 240);
      context.subjectives.then = shortText(context.subjectives.then, 140);
      if (context.current?.expect) context.current.expect = bounded(context.current.expect, 250);
      for (const a of recentAttempts) {
        a.goal = shortText(a.goal, 160)!;
        a.execution.summary = shortText(a.execution.summary, 200);
        a.attemptedSteps = a.attemptedSteps.map((s) => ({ skill: s.skill, args: bounded(s.args, 100) }));
        if (a.prediction) {
          a.prediction.expected = bounded(a.prediction.expected, 250);
          a.prediction.before.actual = bounded(a.prediction.before.actual, 200);
          a.prediction.after.actual = bounded(a.prediction.after.actual, 200);
        }
      }
      Object.assign(context, { context_truncated: true });
    }
    return context;
  }
}
