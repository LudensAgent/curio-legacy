import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Perception } from '../perception/perception.ts';
import type { Plan } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import type { PlanContext } from '../planner/prompt.ts';
import { ProjectCoordinator } from '../projects/coordinator.ts';
import { observationReady } from '../projects/conditions.ts';
import type { Binding, PauseReason } from '../projects/types.ts';
import { SKILLS } from '../skills/index.ts';
import { buildingArchiveFor } from '../skills/build.ts';

export interface ExecutiveDeps {
  adapter: GameAdapter; arbiter: Arbiter; planner: Planner; perception: Perception; memory: WorldMemory; bus: EventBus;
  onLearnSkill?: (raw: unknown) => void;
  onGoalEnd?: (status: string) => void;
}

/** Coordinates model choices and measured progress; it never assigns a gameplay theme. */
export class Executive {
  plan: Plan | null = null;
  queued: Plan | null = null;
  paused = false;
  inFlight = false;
  readonly projects: ProjectCoordinator;
  staleDropped = 0;
  private generation = 0;
  private requestSequence = 0;
  private controller: AbortController | null = null;
  private inFlightReason = '';
  private userSuggestion: string | null = null;
  private lastFailure: PlanContext['lastFailure'] = null;
  private llmErrors = 0;
  private backoffUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private fillerToggle = 0;
  private lastSayAt = 0;
  private activatedAt: number | null = null;
  private suspended = new Set<PauseReason>();
  private lastSession = '';
  private settleUntil = 0;
  private listening = false;
  private attemptStarted = false;
  private crossing = false;
  private results: { skill: string; status: string; summary: string; data?: Record<string, unknown> }[] = [];

  constructor(private d: ExecutiveDeps) {
    this.d.memory.setWorld(d.adapter.state().worldId);
    this.projects = new ProjectCoordinator(d.memory, d.adapter);
    const pauseReasons = new Set([...d.memory.pauseReasons(), ...(d.memory.activeProject()?.pauseReasons ?? [])]);
    if (pauseReasons.has('user')) {
      this.paused = true;
      this.suspended.add('user');
      d.arbiter.setPaused(true);
    }
    for (const reason of pauseReasons) this.suspended.add(reason);
  }

  private doneListener = (o: TaskOutcome) => this.onDone(o);
  start(intervalMs = 250) {
    if (!this.listening) { this.d.arbiter.on('done', this.doneListener); this.listening = true; }
    if (!this.timer) this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.invalidate('shutdown');
    this.d.arbiter.off('done', this.doneListener);
    this.listening = false;
  }

  private invalidate(reason: string) {
    this.generation++;
    this.controller?.abort(reason);
    this.controller = null;
    this.inFlight = false;
    this.inFlightReason = '';
    this.queued = null;
  }

  private suspend(reason: PauseReason) {
    if (this.suspended.has(reason)) return;
    this.suspended.add(reason);
    this.projects.pause(reason);
    this.invalidate(reason);
  }
  private unsuspend(reason: PauseReason) {
    if (!this.suspended.delete(reason)) return;
    this.projects.resume(reason);
  }

  tick() {
    const state = this.d.adapter.state();
    const task = this.d.arbiter.info();
    const travelling = !!task && ['travel_portal', 'recall_portal'].includes(task.skill);
    if (travelling && state.connected && state.alive && !observationReady(state)) {
      if (!this.crossing) { this.crossing = true; this.invalidate('portal_transition'); }
      return; // the portal primitive owns waiting for its measured destination
    }
    if (!state.connected || !state.alive || !observationReady(state)) {
      const reason = !state.alive ? 'death' : 'disconnected';
      this.suspend(reason);
      this.discardPlan(reason);
      return;
    }
    this.d.memory.setWorld(state.worldId);
    if (this.lastSession && this.lastSession !== state.sessionId) {
      this.invalidate('session_changed');
      if (!travelling) this.discardPlan('世界/维度会话变化，重新观察');
    }
    this.crossing = false;
    this.lastSession = state.sessionId;
    if (Date.now() < this.settleUntil) return;
    this.unsuspend('disconnected');
    this.unsuspend('death');
    this.unsuspend('dead');
    this.unsuspend('restart');
    if (this.paused) return;
    const current = this.d.arbiter.info();
    if (current?.source === 'reflex') {
      this.suspend('reflex');
      return;
    }
    if (this.suspended.has('reflex')) {
      this.unsuspend('reflex');
      if (this.d.planner.autonomous) this.discardPlan('反射结束，重新观察并决定剩余工作');
    }
    const before = this.projects.currentBinding();
    this.projects.reconcile(state);
    if (JSON.stringify(before) !== JSON.stringify(this.projects.currentBinding())) {
      this.invalidate('milestone_changed');
      this.discardPlan('验收检查点已变化，重新决定下一步');
    }
    this.checkAbort(state.hp, state.isDay);
    const reason = this.requestReason(this.d.arbiter.info());
    if (reason) this.request(reason);
    if (!this.d.arbiter.info()) this.startNext();
  }

  private requestReason(cur: TaskInfo | null): string | null {
    if (this.inFlight || this.queued || Date.now() < this.backoffUntil) return null;
    if (!this.plan) return this.d.memory.activeProject()?.status === 'blocked' ? 'project_blocked' : 'no_goal';
    if (this.plan.index < this.plan.steps.length) return null;
    if (cur?.planId !== this.plan.id) return null;
    if (this.d.planner.autonomous && !this.plan.binding?.milestoneId) return null;
    const frac = (Date.now() - cur.startedAt) / Math.max(1, cur.deadline - cur.startedAt);
    return cur.progress >= 0.6 || frac >= 0.5 ? 'prefetch' : null;
  }

  private ctx(reason: string): PlanContext {
    const worldState = this.d.adapter.state();
    return { reason, percept: this.d.perception.update(), current: this.d.arbiter.info(), lastFailure: this.lastFailure,
      userSuggestion: this.userSuggestion, binding: this.projects.currentBinding(), continuity: {
        ...this.projects.context(), wishes: this.d.memory.intents().filter((i) => i.status === 'deferred' || i.status === 'open').slice(-8),
        deferredProjects: this.d.memory.projects().filter((p) => p.status === 'deferred').slice(-6)
          .map((p) => ({ id: p.id, intentId: p.intentId, worldId: p.worldId, title: p.title, revision: p.revision,
            currentMilestone: p.currentMilestone, checkpoint: p.checkpoint, lastEvidenceId: p.lastEvidenceId })),
        works: buildingArchiveFor(this.d.memory).list().filter((p) => p.worldId === worldState.worldId && p.dimension === worldState.dim).slice(-5)
          .map((p) => ({ id: p.id, name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, status: p.status,
            defects: p.inspections.at(-1)?.defects.slice(0, 4), feedback: p.feedback.slice(-3) })),
      }, results: this.results, worldState };
  }

  private request(reason: string, replace = false) {
    if (this.paused || !observationReady(this.d.adapter.state())) return;
    this.inFlight = true;
    this.inFlightReason = reason;
    const generation = this.generation;
    const sequence = ++this.requestSequence;
    const controller = this.controller = new AbortController();
    const ctx = this.ctx(reason);
    const fresh = () => generation === this.generation && sequence === this.requestSequence && !controller.signal.aborted
      && !this.paused && observationReady(this.d.adapter.state()) && this.sameBinding(ctx.binding ?? {});
    this.d.bus.publish('llm_request', 'P3', `请求决策（${reason}）`);
    this.d.planner.propose(ctx, controller.signal).then((p) => {
      if (!fresh()) { this.staleDropped++; return; }
      this.llmErrors = 0;
      this.unsuspend('model_unavailable');
      this.backoffUntil = 0;
      if (ctx.userSuggestion === this.userSuggestion) this.userSuggestion = null;
      p.binding = ctx.binding;
      p.generation = generation;
      this.queued = p;
      // Prefetch choices and all their side effects wait until activation with a second freshness check.
      if (replace) this.discardPlan('收到新决策，替换旧尝试');
      if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('决策已到达');
    }).catch((e: any) => {
      if (!fresh()) return;
      this.llmErrors++;
      this.backoffUntil = Date.now() + Math.min(60_000, 3000 * 2 ** (this.llmErrors - 1));
      const error = String(e?.message ?? e);
      if (this.d.planner.autonomous) {
        this.projects.pause('model_unavailable');
        this.suspended.add('model_unavailable');
        this.d.bus.publish('llm_error', 'P1', `决策暂不可用：${error}；保留意图与证据，等待重试`);
      } else {
        this.d.bus.publish('llm_error', 'P1', `兼容模式规划失败：${error}，使用规则目标`);
        const p = this.d.planner.rulePlan(ctx);
        p.generation = generation; p.binding = ctx.binding;
        this.queued = p;
        if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('兼容模式规则计划已到达');
      }
    }).finally(() => {
      if (sequence !== this.requestSequence || generation !== this.generation) return;
      this.controller = null; this.inFlight = false; this.inFlightReason = '';
    });
  }

  private planCurrent(p: Plan) {
    return p.generation === this.generation && this.projects.isBindingCurrent(p.binding ?? {}) && !this.paused;
  }

  private sameBinding(binding: Binding) {
    return JSON.stringify(binding) === JSON.stringify(this.projects.currentBinding());
  }

  private activate(p: Plan): boolean {
    if (p.generation !== this.generation || !this.sameBinding(p.binding ?? {}) || this.paused) { this.staleDropped++; return false; }
    if (p.decision) {
      try {
        this.projects.decide(p.decision, this.d.adapter.state());
      } catch (e: any) {
        this.lastFailure = { skill: 'decision', code: 'INVALID_DECISION', summary: String(e?.message ?? e) };
        this.d.bus.publish('decision_rejected', 'P1', this.lastFailure.summary);
        return false;
      }
      p.binding = this.projects.currentBinding();
      this.d.bus.publish('intent_decision', 'P2', `${p.decision.kind}：${p.decision.reason}`, { decision: p.decision, binding: p.binding });
    }
    // No side effects are accepted before both request and queued-plan ownership checks.
    if (p.memoryNote) this.d.memory.addNote('inference', p.memoryNote, this.d.adapter.state().dim);
    if (p.lesson) this.d.memory.addLesson(p.lesson);
    if (p.objective && !this.d.planner.autonomous) this.d.memory.setObjective(p.objective);
    if (p.learnSkill) this.d.onLearnSkill?.(p.learnSkill);
    this.plan = p;
    this.attemptStarted = false;
    this.activatedAt = Date.now();
    this.d.bus.publish('plan', 'P2', `[${p.source}] ${p.goal} —— ${p.thought}`, { steps: p.steps, planId: p.id, binding: p.binding });
    this.d.bus.publish('goal', 'P2', `当前尝试：${p.goal}`, { planId: p.id, source: p.source });
    if (p.say && Date.now() - this.lastSayAt > 60_000) { this.d.adapter.chat(p.say); this.lastSayAt = Date.now(); }
    if (p.steps.length === 0) {
      this.finishPlan('deferred', p.decision?.reason ?? '主观结束本次兴趣', false);
      this.backoffUntil = Date.now() + 30_000;
    }
    return true;
  }

  private startNext() {
    if (this.plan && !this.planCurrent(this.plan)) this.discardPlan('计划关联已失效');
    if (this.plan && this.plan.index >= this.plan.steps.length) this.finishPlan('succeeded', '技能步骤已结束；物理目标另行验收');
    if (!this.plan && this.queued) {
      const queued = this.queued;
      this.queued = null;
      this.activate(queued);
    }
    if (!this.plan && !this.inFlight && Date.now() < this.backoffUntil && !this.d.planner.autonomous) {
      const fallback = this.d.planner.rulePlan(this.ctx('llm_backoff'));
      fallback.generation = this.generation; fallback.binding = this.projects.currentBinding();
      this.activate(fallback);
    }
    if (this.plan) {
      const step = this.plan.steps[this.plan.index++];
      const r = this.d.arbiter.start(step, this.plan.source, { planId: this.plan.id });
      if ('error' in r) {
        this.lastFailure = { skill: step.skill, code: 'BAD_ARGS', summary: r.error };
        this.finishPlan('failed', r.error);
      } else if (!SKILLS[step.skill]?.readOnly) this.attemptStarted = true;
    } else if (!this.d.planner.autonomous) {
      const filler = this.fillerToggle++ % 2 === 0 ? { skill: 'look_around', args: { seconds: 4 } } : { skill: 'wander', args: { radius: 6 } };
      this.d.arbiter.start(filler, 'filler');
    }
  }

  private finishPlan(status: string, summary: string, attempt = true) {
    const p = this.plan;
    if (!p) return;
    this.plan = null;
    const state = this.d.adapter.state();
    if (attempt && this.attemptStarted && p.binding?.projectId && this.projects.isBindingCurrent(p.binding)) {
      const reconciled = this.projects.recordAttempt({ executed: true, cancelled: ['cancelled', 'replaced', 'aborted'].includes(status), reason: summary }, state);
      if (reconciled?.status === 'blocked') {
        this.invalidate('project_blocked');
        this.d.bus.publish('project_blocked', 'P1', '连续三次实际尝试没有进展，保留意图并请求新的选择');
      }
    }
    const durationSec = Math.round((Date.now() - (this.activatedAt ?? p.createdAt)) / 1000);
    const steps = p.steps.map((st) => { const a = (st.args ?? {}) as Record<string, unknown>; const key = a.block ?? a.item ?? a.blueprint ?? a.crop ?? a.target ?? a.animal ?? a.direction ?? ''; return key ? `${st.skill}:${key}` : st.skill; });
    this.d.memory.recordGoal({ goal: p.goal, goalType: p.goalType, source: p.source, status, summary, durationSec, steps, plan: p.steps, worldId: state.worldId, dimension: state.dim });
    this.d.onGoalEnd?.(status);
    this.d.bus.publish('goal_end', status === 'succeeded' ? 'P2' : 'P1', `尝试「${p.goal}」→ ${status}：${summary}`, { planId: p.id, status });
  }

  private discardPlan(reason: string) {
    const id = this.plan?.id;
    if (id && this.d.arbiter.info()?.planId === id) this.d.arbiter.cancel(reason);
    if (this.plan) this.finishPlan('interrupted', reason, false);
  }

  private onDone(o: TaskOutcome) {
    if (o.task.source === 'filler' || o.task.source === 'reflex') return;
    const p = this.plan;
    if (!p || o.task.planId !== p.id || !this.planCurrent(p)) return;
    this.results.push({ skill: o.task.skill, status: o.result.status, summary: o.result.summary, data: o.result.data });
    if (this.results.length > 3) this.results.shift();
    if (o.result.status === 'succeeded') {
      if (p.index >= p.steps.length) this.finishPlan('succeeded', o.result.summary);
      return;
    }
    if (o.result.status === 'cancelled' && o.preemptedBy === 'reflex') {
      if (!this.d.planner.autonomous && p.retries < 2) {
        p.index = Math.max(0, p.index - 1); p.retries++;
        this.d.bus.publish('resume_step', 'P3', `反射结束后重新检查步骤：${o.task.skill}`);
      } else this.discardPlan('被生存反射打断，重新决定剩余尝试');
      this.suspend('reflex');
      return;
    }
    if (o.result.status === 'failed') this.lastFailure = { skill: o.task.skill, code: o.result.failureCode, summary: o.result.summary };
    this.invalidate('task_failed');
    this.finishPlan(o.result.status, o.result.summary);
  }

  private checkAbort(hp: number, isDay: boolean) {
    const p = this.plan;
    if (!p) return;
    const why = p.abortIf.hpBelow !== undefined && hp < p.abortIf.hpBelow ? `生命 ${hp} 低于 ${p.abortIf.hpBelow}` : p.abortIf.night && !isDay ? '入夜' : '';
    if (!why) return;
    this.invalidate('abort_if');
    this.discardPlan(why);
    this.lastFailure = { skill: 'plan', code: 'ABORTED', summary: why };
  }

  suggest(text: string) {
    this.userSuggestion = text.slice(0, 200);
    this.invalidate('new_suggestion');
    this.backoffUntil = 0;
    this.d.bus.publish('user_suggestion', 'P2', `收到建议：${this.userSuggestion}`);
    if (!this.paused) this.request('user_suggestion', true);
  }
  replan() {
    this.invalidate('manual_replan');
    this.discardPlan('手动重规划');
    this.backoffUntil = 0;
    if (!this.paused) this.request('manual_replan');
  }
  pause() {
    this.paused = true;
    this.suspend('user');
    this.d.arbiter.setPaused(true);
    this.discardPlan('用户暂停，保留意图与检查点');
    this.d.bus.publish('paused', 'P1', 'Agent 已暂停（包括生存反射与迟到决策）');
  }
  resume() {
    this.paused = false;
    this.unsuspend('user');
    this.d.arbiter.setPaused(false);
    this.backoffUntil = 0;
    this.d.bus.publish('resumed', 'P1', 'Agent 恢复，等待有效观测后重新决策');
  }
  onDeath() {
    this.suspend('death');
    this.discardPlan('死亡，保留意图待复活后对账');
    this.d.arbiter.cancel('死亡');
    this.lastFailure = { skill: 'survival', code: 'DIED', summary: '角色死亡，等待复活背包稳定后决定是否继续' };
    this.settleUntil = Date.now() + 1500;
  }
  onSpawn() { if (this.suspended.has('death')) this.settleUntil = Date.now() + 1500; }
  onDisconnected() {
    this.suspend('disconnected');
    this.discardPlan('断线，检查点保留');
    this.d.arbiter.cancel('断线');
  }

  snapshot() {
    const pl = (p: Plan | null) => p && { id: p.id, source: p.source, goal: p.goal, goalType: p.goalType, thought: p.thought, steps: p.steps, index: p.index, say: p.say, binding: p.binding };
    return { plan: pl(this.plan), queued: pl(this.queued), paused: this.paused, pauseReasons: [...this.suspended],
      llmInFlight: this.inFlight, llmReason: this.inFlightReason, userSuggestion: this.userSuggestion, lastFailure: this.lastFailure,
      backoffMs: Math.max(0, this.backoffUntil - Date.now()), staleDropped: this.staleDropped, generation: this.generation,
      autonomy: this.projects.context(), mode: this.d.planner.autonomous ? 'autonomous' : 'compatibility' };
  }
}
