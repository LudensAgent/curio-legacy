import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Perception } from '../perception/perception.ts';
import type { Plan } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import type { PlanContext } from '../planner/prompt.ts';

export interface ExecutiveDeps {
  adapter: GameAdapter;
  arbiter: Arbiter;
  planner: Planner;
  perception: Perception;
  memory: WorldMemory;
  bus: EventBus;
  /** LLM 在计划里提议学习新技能时调用 */
  onLearnSkill?: (raw: unknown) => void;
}

const PREFETCH_PROGRESS = 0.6;
const PREFETCH_ELAPSED = 0.5;

/**
 * 执行中枢：把“思考”和“行动”并行起来。
 * - 当前计划的最后一步进行到 60%（或用掉一半时限）时就后台请求下一个计划（预规划）
 * - 没有计划时立刻执行低价值的填充行为（走动/环顾），并且新计划一到就打断填充
 * - LLM 出错/超时/超预算时退回规则目标，Agent 不会停下来等模型
 */
export class Executive {
  plan: Plan | null = null;
  queued: Plan | null = null;
  paused = false;
  inFlight = false;
  private inFlightReason = '';
  private userSuggestion: string | null = null;
  private replaceOnArrival = false;
  private lastFailure: PlanContext['lastFailure'] = null;
  private fillerToggle = 0;
  private llmErrors = 0;
  private backoffUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastFinished: { goal: string; status: string; at: number } | null = null;
  staleDropped = 0;
  private lastSayAt = 0;
  private activatedAt: number | null = null;

  constructor(private d: ExecutiveDeps) {}

  start(intervalMs = 250) {
    this.d.arbiter.on('done', (o: TaskOutcome) => this.onDone(o));
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------ 主循环
  tick() {
    const s = this.d.adapter.state();
    if (!s.connected || !s.alive || this.paused) return;
    const cur = this.d.arbiter.info();
    if (cur?.source === 'reflex') return; // 反射层接管期间不调度
    this.checkAbort(s.hp, s.isDay);
    const reason = this.requestReason(cur);
    if (reason) this.request(reason);
    if (!this.d.arbiter.info()) this.startNext();
  }

  private requestReason(cur: TaskInfo | null): string | null {
    if (this.inFlight || this.queued) return null;
    if (Date.now() < this.backoffUntil) return null;
    if (!this.plan) return 'no_goal';
    if (this.plan.index < this.plan.steps.length) return null;
    if (cur && cur.planId === this.plan.id) {
      const frac = (Date.now() - cur.startedAt) / Math.max(1, cur.deadline - cur.startedAt);
      if (cur.progress >= PREFETCH_PROGRESS || frac >= PREFETCH_ELAPSED) return 'prefetch';
    }
    return null;
  }

  private request(reason: string, replace = false) {
    this.inFlight = true;
    this.inFlightReason = reason;
    if (replace) this.replaceOnArrival = true;
    const suggestion = this.userSuggestion;
    const ctx: PlanContext = {
      reason,
      percept: this.d.perception.update(),
      current: this.d.arbiter.info(),
      lastFailure: this.lastFailure,
      userSuggestion: suggestion,
    };
    this.d.bus.publish('llm_request', 'P3', `请求新计划（${reason}）`);
    this.d.planner
      .propose(ctx)
      .then((p) => {
        this.llmErrors = 0;
        if (this.userSuggestion && this.userSuggestion !== suggestion) return; // 期间有新建议，丢弃本次结果
        if (suggestion && this.userSuggestion === suggestion) this.userSuggestion = null;
        this.onPlan(p, suggestion !== null || this.replaceOnArrival);
      })
      .catch((e: any) => {
        this.llmErrors++;
        this.backoffUntil = Date.now() + Math.min(60000, 3000 * 2 ** (this.llmErrors - 1));
        this.d.bus.publish('llm_error', 'P1', `LLM 失败（${e?.message ?? e}），改用规则目标；${Math.round((this.backoffUntil - Date.now()) / 1000)} 秒内不再请求`);
        this.onPlan(this.d.planner.rulePlan(ctx), this.replaceOnArrival);
      })
      .finally(() => {
        this.inFlight = false;
        this.inFlightReason = '';
      });
  }

  private onPlan(p: Plan, replace: boolean) {
    this.replaceOnArrival = false;
    this.d.bus.publish('plan', 'P2', `[${p.source}] ${p.goal} —— ${p.thought}`, { steps: p.steps, planId: p.id });
    if (p.memoryNote) this.d.memory.addNote('inference', p.memoryNote);
    if (p.objective) {
      const before = this.d.memory.objective()?.text;
      this.d.memory.setObjective(p.objective);
      if (before !== p.objective) this.d.bus.publish('objective', 'P2', `长期目标：${p.objective}`);
    }
    if (p.learnSkill && this.d.onLearnSkill) this.d.onLearnSkill(p.learnSkill);
    this.queued = p;
    const cur = this.d.arbiter.info();
    if (replace && this.plan) {
      if (cur?.planId === this.plan.id) this.d.arbiter.cancel('被新计划替换');
      this.finishPlan('replaced', '被新计划替换');
    }
    if (cur?.source === 'filler') this.d.arbiter.cancel('新计划到达，结束填充行为');
  }

  private startNext() {
    if (this.plan && this.plan.index >= this.plan.steps.length) this.finishPlan('succeeded', '全部步骤完成');
    if (!this.plan && this.queued && this.isStale(this.queued)) {
      this.staleDropped++;
      this.d.bus.publish('stale_plan', 'P1', `丢弃过期的预规划「${this.queued.goal}」（与刚完成的目标重复），重新规划`);
      this.queued = null;
      if (!this.inFlight) this.request('stale_prefetch');
    }
    if (!this.plan && this.queued) {
      this.plan = this.queued;
      this.queued = null;
      this.activatedAt = Date.now();
      this.d.bus.publish('goal', 'P2', `新目标：${this.plan.goal}`, { planId: this.plan.id, source: this.plan.source });
      // 聊天限流：不要每个计划都说话，显得像复读机
      if (this.plan.say && Date.now() - this.lastSayAt > 60_000) {
        this.d.adapter.chat(this.plan.say);
        this.lastSayAt = Date.now();
      }
    }
    if (!this.plan && !this.inFlight && Date.now() < this.backoffUntil) {
      // LLM 冷却期：直接用规则目标，避免长时间填充
      this.plan = this.d.planner.rulePlan(this.ctx('llm_backoff'));
      this.activatedAt = Date.now();
      this.d.bus.publish('goal', 'P2', `新目标（规则）：${this.plan.goal}`, { planId: this.plan.id, source: 'rule' });
    }
    if (this.plan) {
      const step = this.plan.steps[this.plan.index++];
      const r = this.d.arbiter.start(step, this.plan.source, { planId: this.plan.id });
      if ('error' in r) {
        this.lastFailure = { skill: step.skill, code: 'BAD_ARGS', summary: r.error };
        this.finishPlan('failed', r.error);
      }
      return;
    }
    // 没有任何计划：填充行为，保证画面里的角色一直在动
    const filler = this.fillerToggle++ % 2 === 0 ? { skill: 'look_around', args: { seconds: 4 } } : { skill: 'wander', args: { radius: 6 } };
    this.d.arbiter.start(filler, 'filler');
  }

  private ctx(reason: string): PlanContext {
    return { reason, percept: this.d.perception.update(), current: this.d.arbiter.info(), lastFailure: this.lastFailure, userSuggestion: this.userSuggestion };
  }

  /** 预规划是在上一个目标完成前做的；若它与刚成功完成的目标相同，说明是基于过期状态做出的重复计划。 */
  private isStale(q: Plan): boolean {
    const f = this.lastFinished;
    return !!f && q.reason === 'prefetch' && q.goalType !== 'explore' && f.status === 'succeeded' && f.goal === q.goal && (q.requestedAt ?? 0) < f.at;
  }

  private finishPlan(status: string, summary: string) {
    const p = this.plan;
    if (!p) return;
    this.plan = null;
    this.lastFinished = { goal: p.goal, status, at: Date.now() };
    const durationSec = Math.round((Date.now() - (this.activatedAt ?? p.createdAt)) / 1000);
    this.d.memory.recordGoal({ goal: p.goal, goalType: p.goalType, source: p.source, status, summary, durationSec });
    this.d.bus.publish('goal_end', status === 'succeeded' ? 'P2' : 'P1', `目标「${p.goal}」→ ${status}：${summary}`, { planId: p.id, status });
  }

  private onDone(o: TaskOutcome) {
    if (o.task.source === 'filler' || o.task.source === 'reflex') return;
    const p = this.plan;
    if (!p || o.task.planId !== p.id) return;
    const r = o.result;
    if (r.status === 'succeeded') {
      if (p.index >= p.steps.length) this.finishPlan('succeeded', r.summary);
      return;
    }
    if (r.status === 'cancelled') {
      if (o.preemptedBy === 'reflex' && p.retries < 2) {
        p.index = Math.max(0, p.index - 1); // 反射层处理完后重试被打断的步骤
        p.retries++;
        this.d.bus.publish('resume_step', 'P3', `反射层结束后将重试：${o.task.skill}`);
        return;
      }
      this.finishPlan('cancelled', r.summary);
      return;
    }
    this.lastFailure = { skill: o.task.skill, code: r.failureCode, summary: r.summary };
    this.queued = null; // 预规划的计划可能基于失败前的假设，丢弃
    this.finishPlan('failed', r.summary);
  }

  private checkAbort(hp: number, isDay: boolean) {
    const p = this.plan;
    if (!p) return;
    let why = '';
    if (p.abortIf.hpBelow !== undefined && hp < p.abortIf.hpBelow) why = `生命 ${hp} 低于 ${p.abortIf.hpBelow}`;
    else if (p.abortIf.night && !isDay) why = '入夜';
    if (!why) return;
    if (this.d.arbiter.info()?.planId === p.id) this.d.arbiter.cancel(`abort_if: ${why}`);
    this.lastFailure = { skill: 'plan', code: 'ABORTED', summary: why };
    this.finishPlan('aborted', why);
  }

  // ------------------------------------------------------------ 外部控制
  suggest(text: string) {
    this.userSuggestion = text.slice(0, 200);
    this.queued = null;
    this.d.bus.publish('user_suggestion', 'P2', `收到建议：${this.userSuggestion}`);
    if (!this.inFlight) this.request('user_suggestion', true);
    else this.replaceOnArrival = true;
  }

  replan() {
    this.queued = null;
    if (!this.inFlight) this.request('manual_replan', true);
  }

  pause() {
    this.paused = true;
    this.d.arbiter.cancel('已暂停');
    this.d.bus.publish('paused', 'P1', 'Agent 已暂停（释放所有控制）');
  }

  resume() {
    this.paused = false;
    this.d.bus.publish('resumed', 'P1', 'Agent 恢复运行');
  }

  onDeath() {
    this.d.arbiter.cancel('死亡');
    this.lastFailure = { skill: 'survival', code: 'DIED', summary: '角色死亡' };
    this.queued = null;
    this.finishPlan('failed', '角色死亡');
  }

  snapshot() {
    const pl = (p: Plan | null) =>
      p && { id: p.id, source: p.source, goal: p.goal, goalType: p.goalType, thought: p.thought, steps: p.steps, index: p.index, say: p.say };
    return {
      plan: pl(this.plan),
      queued: pl(this.queued),
      paused: this.paused,
      llmInFlight: this.inFlight,
      llmReason: this.inFlightReason,
      userSuggestion: this.userSuggestion,
      lastFailure: this.lastFailure,
      backoffMs: Math.max(0, this.backoffUntil - Date.now()),
      staleDropped: this.staleDropped,
    };
  }
}
