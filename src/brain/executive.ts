import type { AudienceContext } from '../live/audience.ts';
import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step, TaskInfo, TaskOutcome, TaskPreemption } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Perception } from '../perception/perception.ts';
import type { Plan } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import type { PlanContext } from '../planner/prompt.ts';
import { ProjectCoordinator } from '../projects/coordinator.ts';
import { observationReady } from '../projects/conditions.ts';
import type { Binding, PauseReason, Project } from '../projects/types.ts';
import { SKILLS } from '../skills/index.ts';
import { buildingArchiveFor } from '../skills/build.ts';
import { DecisionFeedback } from './decision-feedback.ts';

export interface ExecutiveDeps {
  adapter: GameAdapter; arbiter: Arbiter; planner: Planner; perception: Perception; memory: WorldMemory; bus: EventBus;
  onLearnSkill?: (raw: unknown) => void;
  onGoalEnd?: (status: string) => void;
  /** 直播间观众弹幕（外部、不可信，只作参考） */
  audience?: { context(tier?: 'light' | 'full'): AudienceContext | null };
}

/** 几秒内就能完成、不改变位置的收尾动作 */
/** 边做边想的决定最多排队这么久，再久就按当前情况重想 */
const PREFETCH_FRESH_MS = 25_000;
const QUICK_SKILLS = new Set(['craft', 'eat', 'place_torch', 'pickup_items', 'equip']);

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
  private lastLook: { at: number; state: AgentState } | null = null;
  private activatedAt: number | null = null;
  private suspended = new Set<PauseReason>();
  private lastSession = '';
  private settleUntil = 0;
  private listening = false;
  private attemptStarted = false;
  private crossing = false;
  private results: { skill: string; args: unknown; status: string; summary: string; data?: Record<string, unknown>;
    failureCode?: string; ts: number; worldId: string; dimension: string; sessionId: string; position: AgentState['pos'] }[] = [];
  private decisionFeedback = new DecisionFeedback();
  private completedProjects = new Set<string>();
  private gentleResume: { planId: string; reflexTaskId: string; generation: number; succeeded: boolean } | null = null;
  private gentlyPreemptedTasks = new Set<string>();

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
  private preemptListener = (o: TaskPreemption) => this.onPreempt(o);
  start(intervalMs = 250) {
    if (!this.listening) {
      this.d.arbiter.on('done', this.doneListener);
      this.d.arbiter.on('preempt', this.preemptListener);
      this.listening = true;
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.invalidate('shutdown');
    this.d.arbiter.off('done', this.doneListener);
    this.d.arbiter.off('preempt', this.preemptListener);
    this.listening = false;
  }

  private invalidate(reason: string) {
    this.generation++;
    this.gentleResume = null;
    this.controller?.abort(reason);
    this.controller = null;
    this.inFlight = false;
    this.inFlightReason = '';
    this.queued = null;
    if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel(reason);
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
      if (this.gentleResume && current.id !== this.gentleResume.reflexTaskId) {
        this.gentleResume = null;
        this.discardPlan('生存反射接连发生，重新决定剩余工作');
      }
      this.suspend('reflex');
      return;
    }
    if (this.suspended.has('reflex')) {
      const saved = this.gentleResume;
      this.unsuspend('reflex');
      const resume = saved?.succeeded && saved.generation === this.generation && this.plan?.id === saved.planId && this.planCurrent(this.plan);
      this.gentleResume = null;
      if (this.d.planner.autonomous && !resume) this.discardPlan('反射结束，重新观察并决定剩余工作');
      else if (resume) this.d.bus.publish('resume_step', 'P2', `反射处理完毕，继续原计划：${this.plan?.steps[this.plan.index]?.skill ?? ''}`);
    }
    const before = this.projects.currentBinding();
    const project = this.projects.reconcile(state);
    this.reportProjectCompletion(project);
    const binding = this.projects.currentBinding();
    if (JSON.stringify(before) !== JSON.stringify(binding)) {
      this.invalidate('milestone_changed');
      if (project?.status === 'active' && before.intentId === binding.intentId && before.projectId === binding.projectId
        && before.revision === binding.revision && this.plan) {
        // A checkpoint advancing does not revoke already approved work. Only
        // speculative choices based on the old checkpoint need to be dropped.
        this.plan.binding = binding;
        this.plan.generation = this.generation;
        this.d.bus.publish('milestone', 'P2', `项目「${project.title}」检查点已推进，继续当前步骤`, { binding });
      } else if (project?.status === 'completed' && this.plan?.binding?.projectId === project.id) {
        if (this.d.arbiter.info()?.planId === this.plan.id) this.d.arbiter.cancel('项目已按实际状态验收完成');
        this.finishPlan('succeeded', '项目已按实际状态验收完成', false);
      } else this.discardPlan('验收检查点已变化，重新决定下一步');
    }
    this.checkAbort(state.hp, state.isDay);
    const reason = this.requestReason(this.d.arbiter.info());
    if (reason) this.request(reason);
    if (!this.d.arbiter.info()) this.startNext();
  }

  private requestReason(cur: TaskInfo | null): string | null {
    if (this.inFlight || Date.now() < this.backoffUntil) return null;
    if (this.queued) {
      // 边做边想的决定在一个长动作开始时就想好了，等动作做完时背包、位置、看见的东西都变了。
      // 排队太久就按现在的情况重新想一遍（替换掉旧的），让接上去的决定基于新鲜的事实。
      const q = this.queued;
      const stale = this.d.planner.autonomous && q.basis?.reason === 'prefetch' && Date.now() - q.basis.at > PREFETCH_FRESH_MS
        && !!cur && cur.planId === this.plan?.id;
      if (!stale) return null;
      this.queued = null;
      this.staleDropped++;
      this.d.bus.publish('plan_stale', 'P3', `想好的下一步已经等了 ${Math.round((Date.now() - q.basis!.at) / 1000)} 秒，情况变了，按现在的情况重新想`);
      return 'prefetch';
    }
    if (!this.plan) return this.d.memory.activeProject()?.status === 'blocked' ? 'project_blocked' : 'no_goal';
    // 最后只剩一个很快的收尾步骤（合成、吃东西、插火把）时，在倒数第二步就开始想下一步：
    // 模型平均要想 6–10 秒，而收尾步骤往往只有几秒
    const quickTail = this.plan.index === this.plan.steps.length - 1 && QUICK_SKILLS.has(this.plan.steps[this.plan.index].skill);
    if (this.plan.index < this.plan.steps.length && !quickTail) return null;
    if (cur?.planId !== this.plan.id) return null;
    // Observation and read-only query results are the evidence for the next
    // choice. Prefetching before they finish repeats the previous assumptions.
    if (this.d.planner.autonomous && (cur.skill === 'look_around' || SKILLS[cur.skill]?.readOnly)) return null;
    // Start the next autonomous choice while its last approved step is still
    // running. Skill deadlines are safety limits, not duration estimates, and
    // waiting for half a deadline often leaves the entire model call idle.
    if (this.d.planner.autonomous) return 'prefetch';
    const frac = (Date.now() - cur.startedAt) / Math.max(1, cur.deadline - cur.startedAt);
    return cur.progress >= 0.6 || frac >= 0.5 ? 'prefetch' : null;
  }

  private ctx(reason: string): PlanContext {
    const worldState = this.d.adapter.state();
    const percept = this.d.perception.update();
    return { reason, percept, current: this.d.arbiter.info(), lastFailure: this.lastFailure,
      pendingSteps: this.plan ? this.plan.steps.slice(this.plan.index) : [],
      ...this.workingMemory(),
      userSuggestion: this.userSuggestion, audience: this.d.audience?.context('full') ?? null, binding: this.projects.currentBinding(), continuity: {
        ...this.projects.context(), wishes: this.d.memory.intents().filter((i) => i.status === 'deferred' || i.status === 'open').slice(-8),
        deferredProjects: this.d.memory.projects().filter((p) => p.status === 'deferred').slice(-6)
          .map((p) => ({ id: p.id, intentId: p.intentId, worldId: p.worldId, title: p.title, revision: p.revision,
            currentMilestone: p.currentMilestone, checkpoint: p.checkpoint, lastEvidenceId: p.lastEvidenceId })),
        works: buildingArchiveFor(this.d.memory).list().filter((p) => p.worldId === worldState.worldId && p.dimension === worldState.dim).slice(-5)
          .map((p) => ({ id: p.id, name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, status: p.status,
            defects: p.inspections.at(-1)?.defects.slice(0, 4), feedback: p.feedback.slice(-3) })),
      }, results: this.results, decisionFeedback: this.decisionFeedback.context(worldState, percept), worldState };
  }

  private request(reason: string, replace = false) {
    if (this.paused || !observationReady(this.d.adapter.state())) return;
    this.inFlight = true;
    this.inFlightReason = reason;
    const generation = this.generation;
    const sequence = ++this.requestSequence;
    const controller = this.controller = new AbortController();
    const ctx = this.ctx(reason);
    const requestedAt = Date.now();
    const fresh = () => generation === this.generation && sequence === this.requestSequence && !controller.signal.aborted
      && !this.paused && observationReady(this.d.adapter.state()) && this.sameBinding(ctx.binding ?? {});
    ctx.tier = this.chooseTier(ctx);
    this.d.bus.publish('llm_request', 'P3', `请求决策（${reason}${ctx.tier === 'light' ? '·小决策' : ''}）`, { tier: ctx.tier });
    this.d.planner.propose(ctx, controller.signal).then((p) => {
      if (!fresh()) { this.staleDropped++; return; }
      this.llmErrors = 0;
      this.unsuspend('model_unavailable');
      this.backoffUntil = 0;
      if (ctx.userSuggestion === this.userSuggestion) this.userSuggestion = null;
      p.binding = ctx.binding;
      p.generation = generation;
      p.basis = { at: requestedAt, reason, pending: [...(ctx.current ? [{ skill: ctx.current.skill, args: ctx.current.args }] : []), ...(ctx.pendingSteps ?? [])] };
      this.queued = p;
      // Prefetch choices and all their side effects wait until activation with a second freshness check.
      if (replace) this.discardPlan('收到新决策，替换旧尝试');
      else if (this.plan?.recovering) {
        // 补救动作只是等待期间的过渡：新决定到了就换上
        const old = this.plan;
        if (this.d.arbiter.info()?.planId === old.id) this.d.arbiter.cancel('新决策已到达，结束补救动作');
        this.finishPlan('failed', `${old.recovering!.summary}（补救动作已被新决策取代）`);
      }
      if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('决策已到达');
    }).catch((e: any) => {
      if (!fresh()) return;
      this.llmErrors++;
      this.backoffUntil = Date.now() + Math.min(60_000, 3000 * 2 ** (this.llmErrors - 1));
      const error = String(e?.message ?? e);
      if (this.d.planner.autonomous) {
        this.projects.pause('model_unavailable');
        this.suspended.add('model_unavailable');
        if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('决策不可用，等待重试');
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

  // ---- 短期工作记忆：让一次次小决策连成一条思路
  private thread: { ts: number; goal: string; thought: string; then?: string; status?: string; summary?: string }[] = [];
  private notes: { ts: number; text: string; at?: string }[] = [];
  private failures: { ts: number; key: string; summary: string; pos?: { x: number; y: number; z: number } }[] = [];
  private workingMemory() {
    const now = Date.now();
    this.notes = this.notes.filter((n) => now - n.ts < 15 * 60_000).slice(-6);
    this.failures = this.failures.filter((f) => now - f.ts < 10 * 60_000);
    const counts = new Map<string, { n: number; last: string }>();
    for (const f of this.failures) counts.set(f.key, { n: (counts.get(f.key)?.n ?? 0) + 1, last: f.summary });
    return {
      // 不带“几秒前”：它每次都变，会让后面整段提示词都无法命中缓存；顺序本身就是时间线
      thread: this.thread.slice(-5).map((t) => ({ goal: t.goal, thought: t.thought.slice(0, 90),
        ...(t.then ? { then: t.then } : {}), outcome: t.status ? `${t.status}：${(t.summary ?? '').slice(0, 90)}` : '进行中' })),
      notes: this.notes.map((n) => n.at ? `${n.text}（写于 ${n.at}）` : n.text),
      repeated: [...[...counts].filter(([, v]) => v.n >= 2).map(([k, v]) => ({ action: k, failures_10min: v.n, last: v.last.slice(0, 80) })), ...this.samePlace()],
    };
  }

  /** 不同的事在同一个地方接连失败：多半是这个地方本身有问题（被困、够不着），而不是做法不对 */
  private samePlace() {
    const here = this.d.adapter.state().pos;
    const near = this.failures.filter((f) => f.pos && Math.hypot(f.pos.x - here.x, f.pos.y - here.y, f.pos.z - here.z) <= 4);
    if (near.length < 3 || new Set(near.map((f) => f.key)).size < 2) return [];
    return [{ action: `在这附近（${Math.round(here.x)},${Math.round(here.y)},${Math.round(here.z)}）做的各种事`, failures_10min: near.length,
      last: `${[...new Set(near.map((f) => f.key))].slice(-4).join('、')} 都在这里失败了：问题多半出在这个地方，先离开这里（看 self.around）` }];
  }

  private lightStreak = 0;
  private lastFullAt = 0;
  /**
   * 小决策是常态：只要手头有一件正在做的事（有进行中的意图），无论是边做边想下一步、某一步失败了换个做法，
   * 还是被打断后接着来，都只发精简的小请求，并尽量和正在进行的动作重叠。
   * 完整决策只用于大转折：开始全新的事、玩家建议、项目受阻、死亡之后，以及每隔一段时间抬头看一眼全局
   * （连续 6 次小决策或超过 3 分钟）。小决策里模型觉得需要改方向时也会自己升级。
   */
  private chooseTier(ctx: PlanContext): 'light' | 'full' {
    const big = !this.d.memory.currentIntent() || !!this.userSuggestion
      || ['user_suggestion', 'manual_replan', 'project_blocked'].includes(ctx.reason)
      || this.lastFailure?.code === 'DIED';
    const due = this.lightStreak >= 6 || Date.now() - this.lastFullAt > 180_000;
    if (!big && !due) { this.lightStreak++; return 'light'; }
    this.lightStreak = 0;
    this.lastFullAt = Date.now();
    return 'full';
  }

  private planCurrent(p: Plan) {
    return p.generation === this.generation && this.projects.isBindingCurrent(p.binding ?? {}) && !this.paused;
  }

  private sameBinding(binding: Binding) {
    return JSON.stringify(binding) === JSON.stringify(this.projects.currentBinding());
  }

  private activate(p: Plan): boolean {
    if (p.generation !== this.generation || !this.sameBinding(p.binding ?? {}) || this.paused) { this.staleDropped++; return false; }
    if (!this.dropDoneSteps(p)) { this.staleDropped++; return false; }
    if (p.decision) {
      try {
        this.projects.decide(p.decision, this.d.adapter.state());
        p.binding = this.projects.currentBinding();
        this.d.bus.publish('intent_decision', 'P2', `${p.decision.kind}：${p.decision.reason}`, { decision: p.decision, binding: p.binding });
      } catch (e: any) {
        // 意图记账失败只影响记账，不影响已经通过校验的行动：照常执行计划，并把原因告诉下一次决策
        const summary = `意图/项目记录未被接受（${String(e?.message ?? e)}），本轮计划照常执行`;
        this.lastFailure = { skill: 'decision', code: 'INVALID_DECISION', summary };
        this.d.bus.publish('decision_rejected', 'P1', summary);
        p.decision = undefined;
        p.binding = this.projects.currentBinding();
      }
    }
    this.refineSteps(p);
    // No side effects are accepted before both request and queued-plan ownership checks.
    if (p.memoryNote) this.d.memory.addNote('inference', p.memoryNote, this.d.adapter.state().dim);
    if (p.missingAbility) this.d.bus.publish('capability_gap', 'P2', `想做但还做不到：${p.missingAbility}`, { planId: p.id });
    this.thread.push({ ts: Date.now(), goal: p.goal, thought: p.thought, ...(p.then ? { then: p.then } : {}) });
    if (this.thread.length > 8) this.thread.shift();
    if (p.note && !this.notes.some((n) => n.text === p.note)) {
      const at = this.d.adapter.state().pos;
      this.notes.push({ ts: Date.now(), text: p.note, at: `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}` });
      this.d.bus.publish('note', 'P3', `记下：${p.note}`);
    }
    if (p.lesson) this.d.memory.addLesson(p.lesson);
    if (p.objective && !this.d.planner.autonomous) this.d.memory.setObjective(p.objective);
    if (p.learnSkill) this.d.onLearnSkill?.(p.learnSkill);
    this.plan = p;
    this.attemptStarted = false;
    this.activatedAt = Date.now();
    this.decisionFeedback.begin(p, this.d.adapter.state(), this.d.perception.update());
    this.d.bus.publish('plan', 'P2', `[${p.source}] ${p.goal} —— ${p.thought}`, { thought: p.thought, source: p.source, steps: p.steps, planId: p.id, binding: p.binding });
    this.d.bus.publish('goal', 'P2', `当前尝试：${p.goal}`, { planId: p.id, source: p.source });
    if (p.steps.length === 0) {
      this.finishPlan('deferred', p.decision?.reason ?? '主观结束本次兴趣', false);
      this.backoffUntil = Date.now() + 30_000;
    }
    return true;
  }

  /**
   * 像人一样执行计划：
   * - 走路找东西时边走边看：explore 之后若要采集/狩猎某样东西，探索途中一看见就停下（until）
   * - 不做没有新信息的环顾：explore 自带沿途张望；刚在附近环顾过时，不带目标的 look_around 直接跳过
   */
  /**
   * 边做边想时，决定是在手头步骤做完之前想的。模型有时会把“正在做/排队中”的步骤又安排一遍
   * （比如刚挖完 8 块石头、做好石剑，又决定“挖 8 块石头、做石剑”）。这些已经做完的开头步骤直接跳过；
   * 全都做完了就丢掉这份过时的决定，按现在的情况重新想。
   */
  private dropDoneSteps(p: Plan): boolean {
    const basis = p.basis;
    if (!basis?.pending.length) return true;
    const key = (st: { skill: string; args?: unknown }) => {
      const a = (st.args ?? {}) as Record<string, unknown>;
      return `${st.skill}:${String(a.item ?? a.block ?? a.animal ?? a.target ?? '')}`;
    };
    const planned = new Set(basis.pending.map(key));
    const done = new Set(this.results.filter((r: any) => r.ts >= basis.at && r.status === 'succeeded').map((r: any) => key(r)));
    let n = 0;
    while (n < p.steps.length && planned.has(key(p.steps[n])) && done.has(key(p.steps[n]))) n++;
    if (!n) return true;
    if (n >= p.steps.length) {
      this.d.bus.publish('plan_stale', 'P2', `这份决定是在手头步骤做完前想的，里面的事已经都做完了，按现在的情况重新想`);
      return false;
    }
    p.steps = p.steps.slice(n);
    this.d.bus.publish('plan_refined', 'P3', `跳过 ${n} 个刚刚已经做完的步骤（这份决定是在它们完成前想的）`);
    return true;
  }

  private refineSteps(p: Plan) {
    for (let i = 0; i < p.steps.length; i++) {
      const st = p.steps[i];
      if (st.skill !== 'explore') continue;
      const args = st.args as Record<string, unknown>;
      if (args.until) continue;
      const next = p.steps.slice(i + 1).find((x) => x.skill === 'gather' || x.skill === 'hunt');
      const target = next ? String((next.args as any)?.block ?? (next.args as any)?.animal ?? (next.skill === 'hunt' ? 'animal' : '')) : '';
      if (target) st.args = { ...args, until: target };
    }
    const here = this.d.adapter.state();
    const recent = this.lastLook && this.lastLook.state.worldId === here.worldId && this.lastLook.state.dim === here.dim
      && Date.now() - this.lastLook.at < 90_000
      && Math.hypot(here.pos.x - this.lastLook.state.pos.x, here.pos.z - this.lastLook.state.pos.z) < 10;
    const kept = p.steps.filter((st, i) => {
      if (st.skill !== 'look_around') return true;
      const a = st.args as Record<string, unknown>;
      if (a.for || a.direction) return true; // 有目的的寻找总是保留
      const afterExplore = p.steps[i - 1]?.skill === 'explore';
      return !(afterExplore || recent);
    });
    if (kept.length === p.steps.length) return;
    const dropped = p.steps.length - kept.length;
    if (kept.length === 0) {
      // 整个计划只是重复环顾：保留一步“快速张望”，并告诉下一次决策视野信息已经在 state 里了
      const secs = this.lastLook ? Math.round((Date.now() - this.lastLook.at) / 1000) : 0;
      this.lastFailure = { skill: 'look_around', code: 'REDUNDANT', summary: `${secs} 秒前刚在这附近环顾过一圈，结果已在 state.vision 里；需要找特定东西时用 look_around {"for": 目标}，否则直接根据现有观察行动` };
      p.steps = [{ skill: 'look_around', args: { seconds: 2 } }];
    } else p.steps = kept;
    this.d.bus.publish('plan_refined', 'P3', `跳过 ${dropped} 个多余的环顾（explore 沿途已张望或刚环顾过）`);
  }

  private lastReflexNote(): string {
    const ev = this.d.bus.recent(20).reverse().find((e) => e.type === 'reflex');
    return ev ? ev.msg : '';
  }

  private startNext() {
    if (this.plan && !this.planCurrent(this.plan)) this.discardPlan('计划关联已失效');
    if (this.plan && this.plan.index >= this.plan.steps.length) {
      if (this.plan.recovering) this.finishPlan('failed', `${this.plan.recovering.summary}（补救动作已做完）`);
      else this.finishPlan('succeeded', '技能步骤已结束；物理目标另行验收');
    }
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
    } else this.keepThinkingActive();
  }

  private keepThinkingActive() {
    if (!this.timer || !this.inFlight || this.paused || this.suspended.size || this.plan || this.queued || this.d.arbiter.info()
      || !observationReady(this.d.adapter.state())) return;
    const state = this.d.adapter.state(), last = this.lastLook;
    if (state.inWater || state.inLava) return;
    const percept = this.d.perception.snapshot();
    const latest = this.results.at(-1);
    const missingTarget = this.lastFailure?.code === 'NOT_FOUND' && latest?.status === 'failed'
      && latest.skill === this.lastFailure.skill && ['gather', 'hunt'].includes(latest.skill);
    const surroundingsKnown = percept.nearby.resources.length > 0 || percept.nearby.passive.length > 0
      || percept.nearby.hostile.length > 0 || percept.nearby.players.length > 0;
    const sameScope = !!last && last.state.worldId === state.worldId && last.state.sessionId === state.sessionId && last.state.dim === state.dim;
    if (missingTarget) {
      // 找不到要的东西：换了位置后再看一圈是合理的
      if (sameScope && Math.hypot(state.pos.x - last!.state.pos.x, state.pos.y - last!.state.pos.y, state.pos.z - last!.state.pos.z) < 8) return;
    } else {
      // 只在刚进入一个世界/维度/会话、对周围一无所知时环顾一次。
      // 走了一段路不是环顾的理由：explore 沿途会张望，视觉也一直在更新。
      if (sameScope) return;
      if (this.d.memory.currentIntent() || surroundingsKnown) return;
    }
    // Survey unfamiliar surroundings or a failed resource search once. Time
    // passing and a pending model response do not create an information gap.
    this.lastLook = { at: Date.now(), state };
    this.d.arbiter.start({ skill: 'look_around', args: { seconds: 4 } }, 'filler');
  }

  private finishPlan(status: string, summary: string, attempt = true) {
    const p = this.plan;
    if (!p) return;
    this.plan = null;
    const state = this.d.adapter.state();
    if (attempt && this.attemptStarted && p.binding?.projectId && this.projects.isBindingCurrent(p.binding)) {
      const reconciled = this.projects.recordAttempt({ executed: true, cancelled: ['cancelled', 'replaced', 'aborted'].includes(status), reason: summary }, state);
      if (reconciled?.status === 'completed') this.invalidate('project_completed');
      this.reportProjectCompletion(reconciled);
      if (reconciled?.status === 'blocked') {
        this.invalidate('project_blocked');
        this.d.bus.publish('project_blocked', 'P1', '连续三次实际尝试没有进展，保留意图并请求新的选择');
      }
    }
    const durationSec = Math.round((Date.now() - (this.activatedAt ?? p.createdAt)) / 1000);
    const entry = [...this.thread].reverse().find((t) => t.goal === p.goal && !t.status);
    if (entry) { entry.status = status; entry.summary = summary; }
    this.decisionFeedback.end(p, status, summary, state, this.d.perception.update());
    const steps = p.steps.map((st) => { const a = (st.args ?? {}) as Record<string, unknown>; const key = a.block ?? a.item ?? a.blueprint ?? a.crop ?? a.target ?? a.animal ?? a.direction ?? ''; return key ? `${st.skill}:${key}` : st.skill; });
    this.d.memory.recordGoal({ goal: p.goal, goalType: p.goalType, source: p.source, status, summary, durationSec, steps, plan: p.steps, worldId: state.worldId, dimension: state.dim });
    this.d.onGoalEnd?.(status);
    const type = this.d.planner.autonomous ? 'attempt_end' : 'goal_end';
    this.d.bus.publish(type, status === 'failed' ? 'P1' : 'P3', `尝试「${p.goal}」→ ${status}：${summary}`, { planId: p.id, status, binding: p.binding });
  }

  private reportProjectCompletion(project: Project | undefined) {
    if (project?.status !== 'completed' || this.completedProjects.has(project.id)) return;
    this.completedProjects.add(project.id);
    this.d.bus.publish('goal_end', 'P2', `项目「${project.title}」已按实际状态验收完成`, {
      scope: 'project', projectId: project.id, intentId: project.intentId, status: 'succeeded', evidenceId: project.lastEvidenceId,
    });
  }

  private discardPlan(reason: string) {
    const id = this.plan?.id;
    if (id && this.d.arbiter.info()?.planId === id) this.d.arbiter.cancel(reason);
    if (this.plan) this.finishPlan('interrupted', reason, false);
  }

  private onPreempt(o: TaskPreemption) {
    if (this.gentleResume?.reflexTaskId === o.task.id) {
      this.invalidate('gentle_reflex_replaced');
      this.discardPlan('反射动作被另一个生存反射抢占，重新决定剩余工作');
    }
    const p = this.plan;
    if (!this.d.planner.autonomous || o.replacement.source !== 'reflex') return;
    if (o.task.source === 'reflex') return; // 反射接反射：上面的检查点逻辑已处理
    const gentleTorch = !!o.gentle && o.replacement.skill === 'place_torch';
    // 原地进行、很快结束的反射（吃东西）不是危险信号：照常接着做，也不计入“反复被打断”
    const benign = o.replacement.skill === 'eat';
    const interrupted = (why: string, code = 'INTERRUPTED_BY_REFLEX') => {
      const note = this.lastReflexNote();
      this.lastFailure = { skill: o.task.skill, code, summary: `${why}：执行 ${o.task.skill} ${JSON.stringify(o.task.args ?? {})} 时触发「${o.replacement.skill}」${note ? `（${note}）` : ''}` };
      this.suspend('reflex');
      this.discardPlan('被生存反射打断，重新决定剩余尝试');
    };
    if (!p || o.task.planId !== p.id || !this.planCurrent(p)) { interrupted('被生存反射打断'); return; }
    // 生存反射（打怪、上浮、逃跑）结束后，有稳定目标的步骤接着做；同一步被同一种反射打断两次就说明这条路/这个做法有危险
    const key = `${p.index - 1}:${o.task.skill}:${o.replacement.skill}`;
    const times = benign ? 0 : (p.interruptions ??= {})[key] = (p.interruptions[key] ?? 0) + 1;
    const resumable = gentleTorch ? ['gather', 'goto'] : benign ? ['gather', 'goto', 'hunt', 'pickup_items', 'explore', 'collect_seeds', 'look_around']
      : ['gather', 'goto', 'hunt', 'pickup_items'];
    if (!resumable.includes(o.task.skill)) { interrupted('被生存反射打断'); return; }
    if (!gentleTorch && !benign && (times >= 2 || (p.resumes ?? 0) >= 3)) {
      interrupted(`同一步骤已 ${times} 次被生存反射打断，这条路线或做法可能有危险，换个方法或方向`, 'REFLEX_REPEATED');
      return;
    }
    // Only replay work with a stable target or an explicit remaining quantity.
    // Relative exploration and craft/build mutations require a fresh decision.
    const index = p.index - 1;
    if (index < 0 || p.steps[index]?.skill !== o.task.skill) {
      this.suspend('reflex');
      this.discardPlan('被抢占的步骤已不属于当前计划');
      return;
    }
    if (o.task.skill === 'gather') {
      const args = o.task.args as { block: string; count: number };
      if (!Number.isInteger(args.count) || args.count <= 0) {
        this.suspend('reflex');
        this.discardPlan('采集数量无法安全恢复，重新决定剩余工作');
        return;
      }
      const remaining = args.count - Math.round(Math.max(0, Math.min(1, o.task.progress)) * args.count);
      if (remaining > 0) {
        p.steps[index] = { skill: 'gather', args: { ...args, count: remaining } };
        p.index = index;
      }
    } else p.index = index;
    // Capture this synchronously: the cancelled task may report its outcome
    // after the torch has finished and the remaining work has already resumed.
    this.gentlyPreemptedTasks.add(o.task.id);
    this.suspend('reflex');
    p.generation = this.generation;
    if (!gentleTorch && !benign) p.resumes = (p.resumes ?? 0) + 1;
    this.gentleResume = { planId: p.id, reflexTaskId: o.replacement.id, generation: this.generation, succeeded: false };
  }

  private onDone(o: TaskOutcome) {
    // 技能自己已经转头找过（look_around、gather 找不到时的四下张望、explore 沿途张望）：同一地点不再安排背景环顾
    if ((o.task.skill === 'look_around' && o.result.status === 'succeeded') || o.result.data?.searched === true
      || (o.task.skill === 'explore' && o.result.status === 'succeeded')) {
      this.lastLook = { at: Date.now(), state: this.d.adapter.state() };
    }
    if (o.task.source === 'filler') {
      return;
    }
    if (o.task.source === 'reflex') {
      this.recordResult(o);
      if (this.gentleResume?.reflexTaskId === o.task.id) {
        this.gentleResume.succeeded = o.result.status === 'succeeded';
        if (!this.gentleResume.succeeded) {
          this.gentleResume = null;
          this.lastFailure = { skill: o.task.skill, code: o.result.failureCode ?? 'REFLEX_FAILED', summary: `生存反射「${o.task.skill}」没有成功：${o.result.summary}；原计划已中止` };
          this.discardPlan('反射没有成功，重新决定剩余工作');
        }
      }
      return;
    }
    if (this.gentlyPreemptedTasks.delete(o.task.id)) return;
    const p = this.plan;
    if (!p || o.task.planId !== p.id || !this.planCurrent(p)) return;
    this.recordResult(o);
    if (o.result.status === 'succeeded') {
      if (p.index >= p.steps.length) {
        if (p.recovering) this.finishPlan('failed', `${p.recovering.summary}（补救：${o.result.summary}）`);
        else this.finishPlan('succeeded', o.result.summary);
      }
      this.keepThinkingActive();
      return;
    }
    if (o.result.status === 'cancelled' && o.preemptedBy === 'reflex') {
      if (!this.d.planner.autonomous && (o.gentle || p.retries < 2)) {
        p.index = Math.max(0, p.index - 1); if (!o.gentle) p.retries++;
        this.d.bus.publish('resume_step', 'P3', `反射结束后重新检查步骤：${o.task.skill}`);
      } else this.discardPlan('被生存反射打断，重新决定剩余尝试');
      this.suspend('reflex');
      return;
    }
    if (o.result.status === 'failed') this.lastFailure = { skill: o.task.skill, code: o.result.failureCode, summary: o.result.summary };
    this.invalidate('task_failed');
    if (o.result.status === 'failed' && this.d.planner.autonomous && !p.recovering && this.bridge(p, o)) return;
    this.finishPlan(o.result.status, o.result.summary);
  }

  /**
   * 失败后不干站着等新决定：先做模型预留的 on_fail，或从失败本身推出的显而易见的补救
   * （没看见目标 → 换个方向边走边找；材料不够 → 去弄差的那份），同时立刻请求新决策。
   * 新决策一到就替换补救动作；补救做完也照样记为这次尝试失败。
   */
  private bridge(p: Plan, o: TaskOutcome): boolean {
    const steps = p.onFail?.length ? p.onFail : this.repairSteps(o);
    if (!steps?.length) return false;
    p.recovering = { summary: o.result.summary };
    const entry = [...this.thread].reverse().find((t) => t.goal === p.goal && !t.status);
    if (entry) { entry.status = 'failed（补救中）'; entry.summary = o.result.summary; }
    p.steps = [...p.steps.slice(0, p.index), ...steps];
    p.generation = this.generation;
    this.d.bus.publish('plan_fallback', 'P2', `「${o.task.skill}」没成功，先${p.onFail?.length ? '按预案' : '顺手'}做：${steps.map((s) => `${s.skill} ${JSON.stringify(s.args ?? {})}`).join(' → ')}，同时重新考虑`);
    if (!this.paused) this.request('failure');
    return true;
  }

  private repairSteps(o: TaskOutcome): Step[] | null {
    const a = (o.task.args ?? {}) as Record<string, unknown>;
    const data = (o.result.data ?? {}) as Record<string, unknown>;
    const candidates: Step[] = [];
    if (o.result.failureCode === 'NOT_FOUND' && ['gather', 'hunt'].includes(o.task.skill)) {
      const target = String(a.block ?? a.animal ?? '');
      if (target) candidates.push({ skill: 'explore', args: { direction: 'auto', distance: 40, until: target } });
    } else if (o.result.failureCode === 'MISSING_MATERIALS' && typeof data.shortfall === 'string') {
      const logs = /木料还差约 (\d+) 块原木/.exec(data.shortfall), cobble = /圆石还差 (\d+) 块/.exec(data.shortfall);
      if (logs) candidates.push({ skill: 'gather', args: { block: 'log', count: Number(logs[1]) + 1 } });
      if (cobble) candidates.push({ skill: 'gather', args: { block: 'stone', count: Number(cobble[1]) + 1 } });
    }
    const out: Step[] = [];
    for (const c of candidates) {
      const v = SKILLS[c.skill]?.validate(c.args, this.d.adapter);
      if (v?.ok) out.push({ skill: c.skill, args: v.args });
    }
    return out.length ? out : null;
  }

  private recordResult(o: TaskOutcome) {
    const state = this.d.adapter.state();
    this.results.push({ skill: o.task.skill, args: o.task.args, status: o.result.status, summary: o.result.summary,
      data: o.result.data, failureCode: o.result.failureCode, ts: Date.now(), worldId: state.worldId,
      dimension: state.dim, sessionId: state.sessionId, position: { ...state.pos } });
    if (this.results.length > 12) this.results.shift();
    if (o.result.status === 'failed') {
      this.lastFailure = { skill: o.task.skill, code: o.result.failureCode, summary: o.result.summary };
      const a = (o.task.args ?? {}) as Record<string, unknown>;
      const target = a.block ?? a.item ?? a.animal ?? a.for ?? a.target ?? a.entity ?? '';
      this.failures.push({ ts: Date.now(), key: `${o.task.skill}${target ? ` ${String(target)}` : ''}`, summary: o.result.summary, pos: { ...state.pos } });
    } else if (o.result.status === 'succeeded' && this.lastFailure?.skill === o.task.skill) this.lastFailure = null;
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
