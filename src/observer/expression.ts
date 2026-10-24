import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent } from '../events.ts';

export interface ExpressionContext {
  state: Pick<AgentState, 'connected' | 'alive' | 'observationReady' | 'worldId' | 'sessionId' | 'dim'>;
  allowed?: boolean;
  plan?: { id: string; goal: string; binding?: { intentId?: string } } | null;
  task?: { id: string; planId?: string; source: string } | null;
  intent?: { id: string; text: string } | null;
}
interface Candidate {
  planId: string; taskId?: string; intentId?: string; goal: string; thought: string; signature: string;
  expiresAt: number; sent: boolean;
}
export interface ExpressionSnapshot {
  goal: string; thought: string; planId: string | null; taskId: string | null; intentId: string | null;
  scope: { worldId: string; sessionId: string; dimension: string };
}
const normalized = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function similar(a: string, b: string) {
  a = normalized(a); b = normalized(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const grams = (text: string) => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const left = grams(a), right = grams(b);
  return 2 * [...left].filter((part) => right.has(part)).length / Math.max(1, left.size + right.size) >= 0.72;
}

/** Public expression follows committed actions; it never generates speech or controls play. */
export class ExpressionProjection {
  private pending: Candidate | null = null;
  private active: Candidate | null = null;
  private scope = '';
  private revision = 0;
  private previous: { intentId?: string; thought: string; signature: string; revision: number; at: number } | null = null;

  private sync(ctx: ExpressionContext) {
    const state = ctx.state, scope = JSON.stringify([state.worldId, state.sessionId, state.dim]);
    if (scope !== this.scope) { this.clear(); this.previous = null; this.revision = 0; this.scope = scope; }
    if (!state.connected || !state.alive || !state.observationReady || ctx.allowed === false) this.clear();
    if (this.pending && (this.pending.planId !== ctx.plan?.id || this.pending.intentId !== ctx.intent?.id)) this.pending = null;
    if (this.active && (this.active.planId !== ctx.plan?.id || this.active.taskId !== ctx.task?.id
      || this.active.intentId !== ctx.intent?.id || ctx.task?.planId !== this.active.planId || ctx.task.source !== 'llm' || Date.now() >= this.active.expiresAt)) this.active = null;
  }

  clear() { this.pending = null; this.active = null; }

  observe(event: AgentEvent, ctx: ExpressionContext) {
    this.sync(ctx);
    const data = event.data ?? {};
    if (['paused', 'disconnected', 'death', 'shutdown', 'plan_fallback'].includes(event.type)) { this.clear(); return; }
    if (!ctx.state.connected || !ctx.state.alive || !ctx.state.observationReady || ctx.allowed === false) return;
    if (['discovery', 'item_new'].includes(event.type)
      || event.type === 'intent_decision' && ['begin', 'revise', 'change_method'].includes(String((data.decision as any)?.kind))
      || event.type === 'attempt_end' && ((data.effectEvidence as any)?.verified && (data.effectEvidence as any)?.changed
        || ['matched', 'not_observed'].includes(String((data.prediction as any)?.outcome)))) this.revision++;
    if (event.type === 'plan') {
      this.clear();
      if (data.source !== 'llm' || typeof data.planId !== 'string' || ctx.plan?.id !== data.planId || typeof data.thought !== 'string') return;
      const thought = data.thought.replace(/§./g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 175);
      if (!thought) return;
      const signature = JSON.stringify(data.steps ?? [], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
      this.pending = { planId: data.planId, intentId: ctx.intent?.id, goal: ctx.intent?.text ?? ctx.plan.goal,
        thought, signature, expiresAt: Date.now() + 10_000, sent: false };
    } else if (event.type === 'task_start') {
      if (data.source !== 'llm') { this.clear(); return; }
      const candidate = this.pending, task = ctx.task;
      if (!candidate || !task || task.id !== data.taskId || task.planId !== candidate.planId) return;
      this.pending = null;
      const previous = this.previous;
      if (previous && Date.now() - previous.at < 30_000 && previous.intentId === candidate.intentId && previous.revision === this.revision
        && (previous.signature === candidate.signature || similar(previous.thought, candidate.thought))) return;
      this.active = { ...candidate, taskId: task.id };
      this.previous = { intentId: candidate.intentId, thought: candidate.thought, signature: candidate.signature, revision: this.revision, at: Date.now() };
    } else if (event.type === 'task_end' && (data.taskId === this.active?.taskId || data.taskId === ctx.task?.id)
      || event.type === 'attempt_end' && data.planId === this.active?.planId) this.active = null;
  }

  snapshot(ctx: ExpressionContext): ExpressionSnapshot {
    this.sync(ctx);
    const ready = ctx.state.connected && ctx.state.alive && ctx.state.observationReady && ctx.allowed !== false;
    return { goal: ready ? ctx.intent?.text ?? this.active?.goal ?? '' : '', thought: this.active?.thought ?? '',
      planId: this.active?.planId ?? null, taskId: this.active?.taskId ?? null, intentId: ready ? ctx.intent?.id ?? this.active?.intentId ?? null : null,
      scope: { worldId: ctx.state.worldId, sessionId: ctx.state.sessionId, dimension: ctx.state.dim } };
  }

  pendingSpeech(ctx: ExpressionContext) {
    this.sync(ctx);
    return this.active && !this.active.sent ? { planId: this.active.planId, taskId: this.active.taskId!, thought: this.active.thought } : null;
  }
  markSent(taskId: string) { if (this.active?.taskId === taskId) this.active.sent = true; }
}
