import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step, TaskOutcome, TaskPreemption } from '../arbiter/arbiter.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { AudienceContext } from '../live/audience.ts';
import { compileBuilding, normalizeSpec } from '../building/spec.ts';
import type { Hazard, WorldMemory } from '../memory/store.ts';
import { materialPlan } from '../methods/shortfall.ts';
import type { Perception, Percept } from '../perception/perception.ts';
import type { MySkillInfo } from '../planner/prompt.ts';
import { observationReady } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import { causeName } from '../brain/habits.ts';
import { pickFuel } from '../skills/economy.ts';
import { pickVariant } from '../skills/work.ts';
import { afterStep, softMiss, createActivity, describeActivity, doneWhenMet, diffInventory, inventoryOf, nextStep, recordOf, remainingSteps, signatureOf, targetKeyOf, viewOf } from './activity.ts';
import { Attention, EXPERIENCE_MS, RECONSIDER, stuckHere, URGENT } from './attention.ts';
import { homeOf } from './home.ts';
import type { ParsedGameMessage } from '../memory/game-messages.ts';
import type { MindContext } from './prompt.ts';
import { moodWords, type SelfModel } from './self.ts';
import type { Thinker } from './thinker.ts';
import type { Activity, ActivityDraft, ActivityEnd, ActivityOutcome, ActivityRecord, MindDecision } from './types.ts';

export interface MindDeps {
  adapter: GameAdapter; arbiter: Arbiter; perception: Perception; memory: WorldMemory; bus: EventBus;
  thinker: Thinker; self: SelfModel; persona: string;
  mySkills?: () => MySkillInfo[];
  researchContext?: () => unknown;
  audience?: { context(tier?: 'light' | 'full'): AudienceContext | null };
  onGoalEnd?: (status: string) => void;
  /** 想说话时（不以 / 开头） */
  say?: (text: string) => void;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = {
  /** 一段活做了这么久还没抬头想过，就看一眼 */
  checkInMs: 100_000,
  /** 连续只“瞥一眼”这么久，下次就认真想一想全局 */
  deliberateEveryMs: 6 * 60_000,
  /** 两句话之间至少隔这么久 */
  sayGapMs: 45_000,
  /** 模型出错后的退避上限 */
  maxBackoffMs: 60_000,
  /** 程序记日记的最小间隔 */
  diaryGapMs: 4 * 60_000,
};

interface Snapshot { at: number; sessionId: string; dim: string; pos: AgentState['pos']; hp: number; food: number; inv: Record<string, number>; inWater: boolean; hostiles: string[]; phase: string }

/** 很快、原地完成的动作：在它开始时就可以想下一段活 */
const QUICK = new Set(['craft', 'eat', 'place_torch', 'pickup_items', 'equip', 'smelt', 'store_items', 'take_items', 'inspect_block', 'interact_block', 'use_item']);

/**
 * 心智（取代旧的 Executive）：感知 → 注意 → 思考 → 一段一段地干活 → 回看与学习。
 *
 * - 身体按“活动”的 routine 连续地做，失败时先自己应变（换地方找、再试一次），真卡住了才叫脑子；
 * - 脑子在做事的同时想：快干完时想下一段（并提前写好 next，干完立刻接上），注意到要紧的事时抬头看一眼；
 * - 每段活结束都留下记录（得到了什么、和预想比如何），模型据此写窍门、修正窍门的可信度、给实验下结论；
 * - 情绪（精力/无聊/烦躁/满足/好奇）由真实经历推动，影响它想做什么；议程和日记让它跨越几个小时、重启之后仍接着原来的心思玩。
 */
export class Mind {
  activity: Activity | null = null;
  suspended: Activity[] = [];
  queuedNext: { draft: ActivityDraft; monologue: string; at: number } | null = null;
  paused = false;
  staleDropped = 0;
  readonly attention = new Attention();
  lastDecision: MindDecision | null = null;
  private timing: typeof DEFAULT_TIMING;
  private generation = 0;
  private thinking: { controller: AbortController; reason: string; tier: 'glance' | 'deliberate'; startedAt: number; generation: number; activityId: string | null } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listening = false;
  private suspendedBy = new Set<string>();
  private lastSession = '';
  private settleUntil = 0;
  private backoffUntil = 0;
  private errors = 0;
  private lastThoughtAt = 0;
  private lastDeliberateAt = 0;
  private lastSnapshot: Snapshot | null = null;
  private lastPerceptAt = 0;
  private lastRecord: ActivityRecord | null = null;
  private recentEnds: ActivityEnd[] = [];
  private failuresByTarget = new Map<string, { n: number; last: number; at: number[] }>();
  private learnedActivities = new Set<string>();
  private speechEventAt = 0;
  private fillerAt = 0;
  private gameMessages: { at: number; text: string }[] = [];
  private deathAt = 0;
  private deathTold = false;
  private readonly startedAt = Date.now();
  private lastLessonAt = 0;
  private reflecting: AbortController | null = null;
  private notes: string[] = [];
  private userSuggestion: string | null = null;
  private lastFailure: { skill: string; code?: string; summary: string } | null = null;
  private lastSay = { at: 0, text: '' };
  private lastDiaryAt = 0;
  private finishedSinceReflect = 0;
  private activityThoughtAt = 0;
  private pendingReason: { reason: string; tier: 'glance' | 'deliberate' } | null = null;

  constructor(private d: MindDeps) {
    this.timing = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
    d.memory.setWorld(d.adapter.state().worldId);
  }

  get inFlight() { return !!this.thinking; }
  get autonomous() { return this.d.thinker.autonomous; }

  // ---------------------------------------------------------------- 生命周期
  private doneListener = (o: TaskOutcome) => this.onDone(o);
  private preemptListener = (o: TaskPreemption) => this.onPreempt(o);
  private eventListener = (ev: AgentEvent) => this.onEvent(ev);

  start(intervalMs = 250) {
    if (!this.listening) {
      this.d.arbiter.on('done', this.doneListener);
      this.d.arbiter.on('preempt', this.preemptListener);
      this.d.bus.on('event', this.eventListener);
      this.listening = true;
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelThinking('shutdown');
    this.reflecting?.abort('shutdown');
    this.reflecting = null;
    if (this.listening) {
      this.d.arbiter.off('done', this.doneListener);
      this.d.arbiter.off('preempt', this.preemptListener);
      this.d.bus.off('event', this.eventListener);
      this.listening = false;
    }
    this.d.self.flush();
  }

  // ---------------------------------------------------------------- 主循环
  tick() {
    const state = this.d.adapter.state();
    const task = this.d.arbiter.info();
    const travelling = !!task && ['travel_portal', 'recall_portal'].includes(task.skill);
    if (travelling && !observationReady(state)) return; // 传送技能自己等落地
    if (!observationReady(state)) { this.suspend(state.alive ? 'disconnected' : 'death'); return; }
    this.d.memory.setWorld(state.worldId);
    if (this.lastSession && this.lastSession !== state.sessionId && !travelling) {
      // 换了世界/维度：手上的活里的坐标都不再适用；心思（议程、念头）还在
      this.dropActivity('interrupted', '换了世界/维度，重新看看周围');
      this.suspended = [];
      this.recentEnds = [];
      this.failuresByTarget.clear();
      this.attention.reset();
      this.cancelThinking('session_changed');
      this.requestThink('换了个地方，重新看看周围', 'deliberate');
    }
    this.lastSession = state.sessionId;
    if (Date.now() < this.settleUntil) return;
    if (this.suspendedBy.has('death') || this.suspendedBy.has('disconnected')) {
      const wasDead = this.suspendedBy.has('death');
      this.suspendedBy.delete('death'); this.suspendedBy.delete('disconnected');
      this.requestThink(wasDead ? '刚复活' : '重新连上了', 'deliberate');
    }
    if (this.paused) return;
    if (this.d.arbiter.info()?.source === 'reflex') return; // 身体在自保；已在途的思考不受影响
    if (Date.now() - this.lastPerceptAt >= 1000) this.perceive();
    this.decideWhetherToThink(this.d.arbiter.info());
    const running = this.d.arbiter.info();
    if (!running || (running.source === 'filler' && (this.activity || this.queuedNext))) this.act();
  }

  private perceive() {
    this.lastPerceptAt = Date.now();
    let p: Percept;
    try { p = this.d.perception.update(); } catch { return; }
    const loop = this.attention.fromLoop(this.recentEnds, this.d.adapter.state().pos);
    for (const n of [...this.attention.fromPercept(p), ...(loop ? [loop] : [])]) {
      this.d.bus.publish('notice', n.level === 'note' ? 'P3' : 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
      if (/^(res|disc|item):/.test(n.key)) { this.d.self.feel({ type: 'novelty', strength: n.salience }); this.speechEventAt = Date.now(); }
    }
    this.d.self.tickMood(!!this.activity && this.activity.kind !== 'rest');
    // 天快黑时惦记家：离家远就想着往回走（像真人一样，不是硬规则：只是一件“注意到”的事）
    if (p.time.phase === 'dusk' || p.time.phase === 'night') {
      const s = this.d.adapter.state();
      const home = this.safe(() => homeOf(this.d.memory, s), null);
      if (home && home.dist > 40) {
        const n = this.attention.notice('far_from_home', `天${p.time.phase === 'dusk' ? '快' : '已经'}黑了，家（${home.label}）还在${home.dir}边 ${home.dist} 格`, 0.55, 15 * 60_000);
        if (n) this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
      }
    }
    if (this.activity?.kind === 'rest') this.maybeReflect('歇下来了');
    else if (Date.now() - Math.max(this.d.self.reflectedAt, this.startedAt) > 60 * 60_000) this.maybeReflect('玩了好一阵了');
  }

  private decideWhetherToThink(current: ReturnType<Arbiter['info']>) {
    if (Date.now() < this.backoffUntil) return;
    const urgentNow = this.attention.highest() >= URGENT;
    if (this.thinking) {
      // 正在“瞥一眼”时出了要紧的事：改成认真想
      if (urgentNow && this.thinking.tier === 'glance') { this.cancelThinking('urgent'); this.staleDropped++; }
      else return;
    }
    if (this.userSuggestion) return this.think('操作者给了建议', 'deliberate');
    if (this.pendingReason) { const r = this.pendingReason; this.pendingReason = null; return this.think(r.reason, r.tier); }
    if (urgentNow) return this.think('注意到要紧的事', 'deliberate');
    if (!this.activity) {
      if (this.queuedNext) return; // act() 会先接上提前想好的下一段活
      return this.think(this.lastRecord ? '上一段活结束了，接下来做什么' : '想想现在做什么',
        this.lastRecord?.outcome === 'done' && !this.needsBigPicture() ? 'glance' : 'deliberate');
    }
    // 躲在坑里过夜、睡觉、歇着的时候，一般的事不值得爬起来重新想（只有要紧的事才会）
    const resting = !!current && ['shelter', 'sleep', 'wait'].includes(current.skill) && current.planId === this.activity.id;
    if (!resting && this.attention.highest() >= RECONSIDER) return this.think('注意到了一些事', 'glance');
    // 边做边想：最后一轮一开始就琢磨下一段活（模型想一次要好几秒，等干完再想就会站着发呆）
    if (!this.queuedNext && current?.planId === this.activity.id && remainingSteps(this.activity) < Math.max(1, this.activity.steps.length)) {
      return this.think('手上这段活快干完了，想想接下来', this.needsBigPicture() ? 'deliberate' : 'glance');
    }
    if (Date.now() - Math.max(this.activityThoughtAt, this.lastThoughtAt) > this.timing.checkInMs) return this.think('做了一会儿了，抬头看看', 'glance');
  }

  /** 需要看看全局了吗：好久没认真想过、做完了好几段活、情绪到了临界、刚卡住 */
  private needsBigPicture(): boolean {
    const m = this.d.self.mood;
    return Date.now() - this.lastDeliberateAt > this.timing.deliberateEveryMs || this.finishedSinceReflect >= 4
      || m.boredom > 0.65 || m.frustration > 0.55 || m.energy < 0.25 || this.lastRecord?.outcome === 'stuck';
  }

  private requestThink(reason: string, tier: 'glance' | 'deliberate') {
    if (!this.pendingReason || tier === 'deliberate') this.pendingReason = { reason, tier };
  }

  // ---------------------------------------------------------------- 动手
  private act() {
    const running = this.d.arbiter.info();
    if (running && running.source !== 'filler') return;
    if (!this.activity && this.queuedNext) {
      const q = this.queuedNext;
      this.queuedNext = null;
      const problem = this.safe(() => this.queuedProblem(q), '当前无法确认所需物品，重新检查计划');
      if (problem) {
        this.requestThink(`提前想好的「${q.draft.what}」需要重新想：${problem}`, 'deliberate');
        return;
      }
      this.beginActivity(q.draft, q.monologue || `接着做：${q.draft.what}`, 'llm', 'next');
    }
    if (!this.activity) return this.idle();
    const step = nextStep(this.activity);
    if (!step) return this.finishActivity('done', '这段活的步骤都做完了');
    const state = this.d.adapter.state();
    this.activity.stepStart = { pos: { ...state.pos }, view: viewOf(this.safe(() => this.d.perception.snapshot(), undefined)) };
    const r = this.d.arbiter.start(step, this.activity.source === 'rule' ? 'rule' : 'llm', { planId: this.activity.id });
    if ('error' in r) this.handleStepResult(step, { status: 'failed', failureCode: 'BAD_ARGS', summary: r.error }, 0);
    else if (remainingSteps(this.activity) === 0 && !this.queuedNext && !this.thinking && QUICK.has(step.skill)) {
      this.think('手上这段活快干完了，想想接下来', this.needsBigPicture() ? 'deliberate' : 'glance');
    }
  }

  /** 只检查眼下确实会用的物品；采集等前置动作的产出仍交给实际执行确认。 */
  private queuedProblem(q: NonNullable<Mind['queuedNext']>): string | null {
    if (Date.now() - q.at > 90_000) return '已等待超过 90 秒，身体和物品可能变了';
    const state = this.d.adapter.state();
    for (const step of q.draft.steps) {
      const args = (step.args ?? {}) as Record<string, any>;
      if (step.skill === 'eat') return this.d.adapter.hasFood() ? null : '背包里已经没有当前能吃的食物';
      if (step.skill === 'craft') {
        const item = pickVariant(args.item, state.inventory);
        const plan = materialPlan(item, args.count ?? 1, state.inventory.filter((i) => i.name !== item));
        return plan.enough ? null : `合成 ${item} 的材料已不齐`;
      } else if (step.skill === 'smelt') {
        if (!state.inventory.some((i) => i.name === args.item && i.count > 0)) return `待烧的 ${args.item} 已不在背包里`;
        const fuel = pickFuel(state.inventory, args.item);
        if (!fuel) return '冶炼燃料已不在背包里';
        return null;
      } else if (step.skill === 'build' && args.mode !== 'inspect') {
        const materials = args.spec ? [...new Set(compileBuilding(normalizeSpec(structuredClone(args.spec))).cells.filter((c) => !c.placedBy && c.name !== 'air').map((c) => c.name))] : [];
        if (materials.length && !materials.some((name) => state.inventory.some((i) => i.name === name && i.count > 0))) return '这座建筑需要的建材已不在背包里';
        return null;
      } else if (!SKILLS[step.skill]?.readOnly) {
        // 后续材料可能由这一步采集、取出或消耗，不能当成当前就缺失。
        break;
      }
    }
    return null;
  }

  /** 没有活可干时（正在想事情）：原地看看四周，不乱跑也不消耗东西 */
  private idle() {
    if (this.d.arbiter.info() || !this.thinking) return;
    // 张望被打断（踩空、受伤）后别每一拍都重新开始，隔几秒再说
    if (Date.now() - this.fillerAt < 3000) return;
    this.fillerAt = Date.now();
    const state = this.d.adapter.state();
    if (state.inWater || state.inLava || state.onGround === false) return;
    let knows = false;
    try { const p = this.d.perception.snapshot(); knows = p.nearby.resources.length > 0 || p.nearby.passive.length > 0; } catch { /* 感知暂不可用 */ }
    // 边想边顺手捡起脚边看得见的掉落物（像人一样不闲着），否则原地张望
    let drops = 0;
    try { drops = ((this.d.perception.snapshot().vision as any)?.visible_drops ?? []).filter((d: any) => (d.dist ?? 99) <= 6).length; } catch { /* 感知暂不可用 */ }
    if (drops && SKILLS.pickup_items && this.d.self.habits().pickup) { this.d.arbiter.start({ skill: 'pickup_items', args: { radius: 6 } }, 'filler'); return; }
    if (!knows) this.d.arbiter.start({ skill: 'look_around', args: { seconds: 4 } }, 'filler');
    else if (SKILLS.glance) this.d.arbiter.start({ skill: 'glance', args: { seconds: 120 } }, 'filler');
  }

  private beginActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], how: string, hypothesis?: string) {
    const state = this.d.adapter.state();
    const a = createActivity(draft, monologue, source, state);
    // 收工条件开工前就已经成立（比如 onGround=true）：它判断不了这段活做没做完，改成“步骤做完就收工”
    if (a.doneWhen && doneWhenMet(a, state, this.safe(() => this.d.perception.snapshot(), undefined))) {
      a.adaptations.push('收工条件开工前就已成立，不能用来判断做完没有，改成步骤做完就收工');
      this.d.bus.publish('decision_normalized', 'P3', `「${a.what}」的收工条件开工前就已成立，改成步骤做完就收工`, { doneWhen: a.doneWhen });
      delete a.doneWhen;
    }
    if (hypothesis) { a.hypothesis = hypothesis; this.d.self.startExperiment(hypothesis, a.id); }
    const agenda = draft.agendaId ? this.d.self.data.agenda.find((x) => x.id === draft.agendaId) : this.d.self.activeAgenda();
    if (agenda) a.agendaId = agenda.id;
    this.activity = a;
    this.activityThoughtAt = Date.now();
    if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('开始干活');
    this.d.bus.publish('plan', 'P2', `[${source === 'rule' ? 'rule' : 'llm'}] ${a.what} —— ${monologue}`, { thought: monologue, source: source === 'rule' ? 'rule' : 'llm', steps: a.steps, planId: a.id, kind: a.kind, how, repeat: a.repeat, ...(hypothesis ? { hypothesis } : {}) });
    this.d.bus.publish('goal', 'P2', `开始一段活：${a.what}`, { planId: a.id, source });
    this.d.bus.publish('activity_start', 'P2', `${how === 'next' ? '接着' : how === 'habit' ? '凭习惯' : '开始'}：${a.what}${a.why ? `（${a.why}）` : ''}`, { activity: describeActivity(a, state, this.safe(() => this.d.perception.snapshot(), undefined)) });
  }

  private finishActivity(outcome: ActivityOutcome, summary: string) {
    const a = this.activity;
    if (!a) return;
    this.activity = null;
    const state = this.d.adapter.state();
    if (a.dropped?.length) summary = `${summary}；计划里这些没做（写错被丢掉了）：${a.dropped.join('、')}`;
    const record = recordOf(a, outcome, summary, state);
    const failed = [...a.results].reverse().find((r) => r.status === 'failed' && !(SKILLS[r.skill]?.readOnly && r.failureCode === 'NOT_FOUND'));
    this.recentEnds = [...this.recentEnds.filter((r) => Date.now() - r.at <= EXPERIENCE_MS),
      { pos: { ...state.pos }, outcome, failureCode: failed?.failureCode, what: `${a.what}（${signatureOf(a.steps)}）`, at: record.at }].slice(-256);
    this.d.self.record(record);
    this.lastRecord = record;
    this.finishedSinceReflect++;
    this.d.self.creditAgenda(a.agendaId);
    this.d.self.feel({ type: 'activity_end', outcome, sameKindStreak: this.d.self.sameKindStreak(a.kind), gainedKinds: Object.keys(record.gained).length });
    if (a.kind === 'rest') this.d.self.feel({ type: 'rest', seconds: record.durationSec });
    const exp = this.d.self.experimentFor(a.id);
    if (exp?.status === 'running') this.d.self.concludeExperiment(exp.id, 'unclear', `${outcome}：${summary}；得到 ${JSON.stringify(record.gained)}`);
    const gains = Object.entries(record.gained).map(([k, v]) => `${k}×${v}`).join('、');
    this.d.self.think(`${a.what} → ${outcome === 'done' ? '做完了' : outcome === 'stuck' ? '卡住了' : '停下了'}${gains ? `，得到 ${gains}` : ''}${outcome !== 'done' ? `：${summary.slice(0, 60)}` : ''}`, 'outcome');
    const status = outcome === 'done' ? 'succeeded' : outcome === 'stuck' ? 'failed' : 'interrupted';
    const goalType = ['tidy', 'social', 'other', 'experiment'].includes(a.kind) ? 'investigate' : a.kind;
    this.d.memory.recordGoal({ goal: a.what, goalType, source: a.source === 'rule' ? 'rule' : 'llm', status, summary, durationSec: record.durationSec,
      steps: signatureOf(a.steps).split('>'), plan: a.steps, worldId: state.worldId, dimension: state.dim });
    this.d.bus.publish('attempt_end', outcome === 'stuck' ? 'P1' : 'P3', `一段活「${a.what}」→ ${outcome}：${summary}${gains ? `（得到 ${gains}）` : ''}`,
      { planId: a.id, status, outcome, gained: record.gained, durationSec: record.durationSec, effectEvidence: { verified: true, changed: !!gains, reasons: gains ? [`背包实增 ${gains}`] : [] } });
    try { this.d.onGoalEnd?.(status); } catch { /* 习惯化失败不影响游玩 */ }
    if (outcome === 'done' && (gains || record.durationSec > 90) && Date.now() - this.lastDiaryAt > this.timing.diaryGapMs) this.diary(`${a.what}${gains ? `，得到 ${gains}` : ''}`);
    // 绕路的事做完了：回到被打断的那段活
    if (outcome === 'done' || outcome === 'stuck') {
      const resume = this.suspended.pop();
      if (resume) {
        this.activity = resume;
        this.activityThoughtAt = Date.now();
        this.d.bus.publish('activity_start', 'P2', `回到：${resume.what}`, { activity: describeActivity(resume, state, this.safe(() => this.d.perception.snapshot(), undefined)) });
        this.d.bus.publish('plan', 'P2', `[${resume.source === 'rule' ? 'rule' : 'llm'}] ${resume.what} —— 回到刚才的事`, { thought: `回到刚才的事：${resume.what}`, source: resume.source === 'rule' ? 'rule' : 'llm', steps: resume.steps, planId: resume.id });
        if (outcome === 'stuck') this.requestThink(`绕路去做的「${a.what}」卡住了：${summary}`, 'deliberate');
        return;
      }
    }
    if (outcome === 'stuck') {
      this.queuedNext = null; // 提前想好的下一步多半基于“这段会成功”的假设
      this.requestThink(`「${a.what}」卡住了：${summary}${a.ifStuck ? `；之前想过卡住时：${a.ifStuck}` : ''}`, 'deliberate');
    }
  }

  private dropActivity(outcome: ActivityOutcome, why: string) {
    if (!this.activity) return;
    if (this.d.arbiter.info()?.planId === this.activity.id) this.d.arbiter.cancel(why);
    this.finishActivity(outcome, why);
  }

  // ---------------------------------------------------------------- 动作结果
  private onDone(o: TaskOutcome) {
    if (o.task.source === 'filler') return;
    const observationMiss = softMiss(this.activity?.id === o.task.planId ? this.activity : null, { skill: o.task.skill, args: o.task.args }, o.result);
    if (o.result.status !== 'cancelled' && !observationMiss) {
      if (o.task.source !== 'reflex') {
        this.d.self.practice(o.task.skill, o.result.status === 'succeeded', o.durationMs);
        this.d.self.feel({ type: 'step', ok: o.result.status === 'succeeded' });
      }
      if (o.task.skill === 'sleep' && o.result.status === 'succeeded') { this.d.self.feel({ type: 'sleep' }); this.maybeReflect('睡了一觉'); }
    }
    if (o.task.source === 'reflex') return;
    const a = this.activity;
    if (!a || o.task.planId !== a.id) return;
    if (o.result.status === 'cancelled') {
      // 被反射打断：等身体安全了把这一步再做一遍
      if (o.preemptedBy === 'reflex') {
        a.index = Math.max(0, a.index - 1);
        a.interruptions = (a.interruptions ?? 0) + 1;
        // 一直被身体躲闪打断：这段活眼下做不成，先想想怎么对付周围的危险
        if (a.interruptions >= 3) this.finishActivity('stuck', `这段活被身体的躲闪反应打断了 ${a.interruptions} 次，周围有危险：先处理掉威胁（打、跑远、躲起来）再做`);
      }
      return;
    }
    this.handleStepResult({ skill: o.task.skill, args: o.task.args }, o.result, o.durationMs);
  }

  private handleStepResult(step: Step, result: { status: 'succeeded' | 'failed' | 'cancelled'; failureCode?: any; summary: string }, durationMs: number) {
    const a = this.activity;
    if (!a) return;
    const observationMiss = softMiss(a, step, result);
    if (result.status === 'failed' && !observationMiss) {
      this.lastFailure = { skill: step.skill, code: result.failureCode, summary: result.summary };
      this.pruneFailures();
      const key = targetKeyOf(step);
      const entry = this.failuresByTarget.get(key) ?? { n: 0, last: 0, at: [] };
      entry.at.push(Date.now()); entry.n = entry.at.length; entry.last = Date.now();
      this.failuresByTarget.set(key, entry);
    }
    const percept = this.safe(() => this.d.perception.update(), undefined);
    const verdict = afterStep(a, step, result, durationMs, this.d.adapter.state(), percept);
    if (verdict.kind === 'continue') {
      if (verdict.adapted) {
        this.d.self.think(verdict.adapted, 'outcome');
        this.d.bus.publish('body_adapt', 'P3', `身体自己应变：${verdict.adapted}`, { planId: a.id });
      }
      return;
    }
    this.finishActivity(verdict.kind === 'done' ? 'done' : 'stuck', verdict.why);
  }

  private pruneFailures() {
    const cutoff = Date.now() - EXPERIENCE_MS;
    for (const [key, entry] of this.failuresByTarget) {
      entry.at = entry.at.filter((at) => at >= cutoff);
      entry.n = entry.at.length;
      if (!entry.n) this.failuresByTarget.delete(key);
    }
  }

  private onPreempt(o: TaskPreemption) {
    if (o.replacement.source !== 'reflex' || !this.activity || o.task.planId !== this.activity.id) return;
    // 是这一步把自己带进了水里：上岸后别原样再走一遍
    if (o.replacement.skill === 'surface') this.attention.notice('into_water', `做「${o.task.skill}」时掉进水里差点淹死，这条路线或目标在水里`, 0.7, 30_000);
  }

  private onEvent(ev: AgentEvent) {
    if (ev.type === 'notice') return;
    const n = this.attention.fromEvent(ev);
    if (n && n.level !== 'note') this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    if (ev.type === 'hurt') this.d.self.feel({ type: 'hurt', amount: 2 });
    if (ev.type === 'item_new' || ev.type === 'discovery') {
      this.speechEventAt = Date.now();
      this.d.self.feel({ type: 'novelty', strength: ev.type === 'item_new' ? 0.6 : 0.4 });
      if (ev.type === 'item_new' && Date.now() - this.lastDiaryAt > this.timing.diaryGapMs / 2) this.diary(ev.msg.slice(0, 80));
    }
  }

  // ---------------------------------------------------------------- 思考
  private think(reason: string, tier: 'glance' | 'deliberate') {
    if (this.thinking || this.paused) return;
    const state = this.d.adapter.state();
    if (!observationReady(state)) return;
    let percept: Percept;
    try { percept = this.d.perception.update(); } catch { return; }
    const generation = this.generation;
    const controller = new AbortController();
    const activityId = this.activity?.id ?? null;
    this.thinking = { controller, reason, tier, startedAt: Date.now(), generation, activityId };
    const noticed = this.attention.drain();
    const reflect = tier === 'deliberate' && this.finishedSinceReflect >= 4;
    this.pruneFailures();
    const ctx: MindContext = {
      tier, reason: reflect ? `${reason}；做完了好几段活，顺便回头看看哪些办法好用、哪些该改` : reason,
      percept, state, self: this.d.self, memory: this.d.memory, activity: this.activity, suspended: this.suspended,
      lastRecord: this.lastRecord, noticed, changes: this.changesSinceLastThought(), userSuggestion: this.userSuggestion,
      audience: this.d.audience?.context(tier === 'glance' ? 'light' : 'full') ?? null, notes: this.notes,
      mySkills: tier === 'deliberate' ? this.safe(() => this.d.mySkills?.() ?? [], []) : [],
      researchContext: tier === 'deliberate' && reflect ? this.safe(() => this.d.researchContext?.(), undefined) : undefined,
      persona: this.d.persona,
      gameMessages: this.recentGameMessages(),
      skills: this.safe(() => this.d.thinker.skillBook?.index() ?? [], []),
      stuckHere: stuckHere(this.recentEnds, state.pos),
      repeatedFailures: [...this.failuresByTarget].filter(([, f]) => f.n >= 2)
        .sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([key, f]) => `${key.replace(':', ' ')} ×${f.n}（10 分钟内）`),
    };
    const suggestion = this.userSuggestion;
    this.d.bus.publish('llm_request', 'P3', `${tier === 'glance' ? '抬头看一眼' : '认真想想'}：${reason}`, { tier, reason });
    this.idle();
    this.d.thinker.think(ctx, controller.signal).then((decision) => {
      if (this.thinking?.controller !== controller) { this.staleDropped++; return; }
      this.thinking = null;
      if (generation !== this.generation || this.paused) { this.staleDropped++; return; }
      this.errors = 0; this.backoffUntil = 0;
      this.lastThoughtAt = Date.now();
      if (decision.tier === 'deliberate') { this.lastDeliberateAt = Date.now(); this.finishedSinceReflect = 0; }
      if (suggestion && suggestion === this.userSuggestion) this.userSuggestion = null;
      this.lastSnapshot = this.snapshotNow();
      this.apply(decision, activityId, ctx.lastRecord);
      this.kick();
    }).catch((e: any) => {
      if (this.thinking?.controller !== controller) return;
      this.thinking = null;
      if (controller.signal.aborted || generation !== this.generation) return;
      this.errors++;
      this.backoffUntil = Date.now() + Math.min(this.timing.maxBackoffMs, 3000 * 2 ** (this.errors - 1));
      for (const n of noticed) this.attention.notice(`${n.key}:again`, n.what, n.salience * 0.8, 0); // 没想成，注意到的事别丢
      this.d.bus.publish('llm_error', 'P1', `脑子卡了一下：${String(e?.message ?? e).slice(0, 200)}；先凭习惯继续`);
      if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('思考失败');
      // 脑子转不动的时候凭习惯做事：手上没活就按规则找点事做，保证不发呆
      if (!this.activity && !this.queuedNext) {
        const habit = this.d.thinker.ruleDecision({ ...ctx, activity: null, tier: 'deliberate' });
        if (habit.activity) this.beginActivity(habit.activity, habit.monologue || '先凭习惯做点事', 'habit', 'habit');
      }
      this.kick();
    });
  }

  /** 决定刚落地：手上空着（或只是在原地张望）就马上动起来，不等下一拍 */
  private kick() {
    if (this.paused || !this.timer) return;
    const running = this.d.arbiter.info();
    if ((!running || running.source === 'filler') && (this.activity || this.queuedNext)) this.act();
  }

  /**
   * 回想（像人睡前或歇脚时回顾一天）：攒够了零碎经验就在后台整理一次，不打断手上的事。
   * 合并说同一件事的窍门、丢掉被事实推翻的、把被证实的零碎想法变成窍门，再写一句日记。
   */
  private maybeReflect(why: string) {
    if (this.reflecting || this.paused || !this.autonomous) return;
    if (Date.now() - this.d.self.reflectedAt < 20 * 60_000 || this.d.self.reflectionBacklog() < 5) return;
    const controller = new AbortController();
    this.reflecting = controller;
    this.d.bus.publish('reflect_start', 'P3', `回想一下这段时间（${why}）`);
    this.d.thinker.reflect(this.d.self, this.d.persona, controller.signal).then((c) => {
      if (this.reflecting !== controller) return;
      this.reflecting = null;
      if (!c) return;
      const { before, after } = this.d.self.consolidate(c);
      for (const k of this.d.self.data.knowHow) if (c.add.includes(k.text) || c.merge.some((m) => m.text === k.text) || c.rewrite.some((r) => r.id === k.id)) {
        this.d.memory.addLesson(k.text, { source: 'model', key: `know_how:${k.id}` });
      }
      if (c.skill) {
        const w = this.safe(() => this.d.thinker.skillBook?.write(c.skill!.name, c.skill!.description, c.skill!.body) ?? null, null);
        if (w?.ok) {
          this.d.self.think(`把「${w.skill.description}」的做法写成了自己的技能 ${w.skill.name}`, 'learned');
          this.d.bus.publish('skill_written', 'P2', `${w.created ? '写了一份新技能' : '修订了技能'}：${w.skill.name}——${w.skill.description}`, { name: w.skill.name });
        } else if (w && !w.ok) this.d.bus.publish('skill_rejected', 'P3', `没有保存技能：${w.error}`);
      }
      if (c.diary) this.diary(c.diary);
      if (c.monologue) this.d.self.think(c.monologue, 'learned');
      this.d.bus.publish('reflect', 'P2', `回想完了：窍门 ${before} → ${after} 条（合并 ${c.merge.length}、改写 ${c.rewrite.length}、丢掉 ${c.drop.length}、新增 ${c.add.length}）${c.diary ? `；${c.diary}` : ''}`,
        { merge: c.merge.length, rewrite: c.rewrite.length, drop: c.drop.length, add: c.add.length });
    }).catch((e: any) => {
      if (this.reflecting !== controller) return;
      this.reflecting = null;
      if (!controller.signal.aborted) this.d.bus.publish('reflect_error', 'P2', `回想没成：${String(e?.message ?? e).slice(0, 120)}`);
    });
  }

  private safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

  private cancelThinking(reason: string) {
    if (!this.thinking) return;
    this.thinking.controller.abort(reason);
    this.thinking = null;
    if (this.d.arbiter.info()?.source === 'filler' && !this.activity) this.d.arbiter.cancel(reason);
  }

  /** 把一次决定落到身体和心里 */
  private apply(decision: MindDecision, thoughtAboutActivity: string | null, reflectedRecord: ActivityRecord | null = this.lastRecord) {
    this.lastDecision = decision;
    this.notes = decision.notes;
    if (decision.notes.length) this.d.bus.publish('decision_normalized', 'P3', `决定里有些地方被纠正了：${decision.notes.join('；').slice(0, 200)}`);
    if (decision.monologue) {
      this.d.self.think(decision.monologue);
      this.d.bus.publish('thought', 'P2', decision.monologue, { kind: decision.kind, tier: decision.tier, feeling: moodWords(this.d.self.mood) });
    }
    if (decision.say) this.say(decision.say, decision);
    if (decision.diary) this.diary(decision.diary);
    if (decision.habits) {
      const changed = this.d.self.setHabits(decision.habits);
      if (changed.length) this.d.bus.publish('habits', 'P3', `给身体定了习惯：${changed.join('，')}`, { habits: this.d.self.habits() });
    }
    if (decision.liked && this.d.self.like(decision.liked)) {
      this.d.self.think(`我喜欢${decision.liked}`, 'feeling');
      this.d.bus.publish('liked', 'P3', `发现自己喜欢：${decision.liked}`);
    }
    const last = reflectedRecord;
    const learnedText = typeof decision.learned === 'string' ? decision.learned : decision.learned?.text;
    if (decision.verdict && last?.hypothesis) {
      const exp = this.d.self.experimentFor(last.id);
      if (exp) {
        this.d.self.concludeExperiment(exp.id, decision.verdict, `${last.summary}${learnedText ? `；${learnedText}` : ''}`);
        this.d.bus.publish('experiment', 'P2', `实验「${exp.hypothesis}」→ ${decision.verdict}`, { hypothesis: exp.hypothesis, verdict: decision.verdict });
      }
    }
    const learn = (text: string, revise?: string) => {
      // 人不会每做一件事就立一条规矩：出乎意料（卡住、实验）或修订旧经验才马上记下，其余先存着，休息时再回想
      const notable = !!revise || !!last?.hypothesis || last?.outcome === 'stuck' && Date.now() - this.lastLessonAt > 90_000;
      if (!notable && Date.now() - this.lastLessonAt < 3 * 60_000) { this.d.self.jot(text, last?.outcome); return; }
      const activityId = last?.id ?? thoughtAboutActivity ?? this.activity?.id ?? `${this.lastSession}:initial`;
      if (this.learnedActivities.has(activityId)) return;
      const previousTexts = new Map(this.d.self.data.knowHow.map((k) => [k.id, k.text]));
      const k = this.d.self.learn(text, { kind: last?.kind, signature: last?.signature, source: last?.hypothesis ? 'experiment' : 'reflection',
        outcome: last?.outcome, tags: last ? Object.keys(last.gained) : [], revise });
      if (k) {
        this.lastLessonAt = Date.now();
        this.learnedActivities.add(activityId);
        if (this.learnedActivities.size > 256) this.learnedActivities.delete(this.learnedActivities.values().next().value!);
        this.d.memory.addLesson(k.text, { source: 'model', key: `know_how:${k.id}`, replaces: previousTexts.get(k.id) });
        this.d.bus.publish('lesson', 'P2', `${k.unverified ? '暂时猜到（未验证）' : '学到'}：${k.text}`, { source: 'model', knowHowId: k.id });
      }
    };
    if (learnedText) learn(learnedText, typeof decision.learned === 'object' ? decision.learned.revise : undefined);
    if (decision.agenda) {
      for (const a of decision.agenda.add) {
        const item = this.d.self.addAgenda(a.text, a.kind, a.horizon, learn);
        if (item) this.d.bus.publish('agenda', 'P3', `${a.kind === 'idea' ? '冒出个点子' : a.kind === 'question' ? '想弄明白' : '想做'}：${a.text}`, { id: item.id });
      }
      for (const id of decision.agenda.done) this.d.self.setAgendaStatus(id, 'done');
      for (const id of decision.agenda.drop) this.d.self.setAgendaStatus(id, 'dropped');
      if (decision.agenda.focus) this.d.self.setAgendaStatus(decision.agenda.focus, 'active');
    }
    if (decision.next) this.queuedNext = { draft: decision.next, monologue: '', at: Date.now() };

    const sameActivity = !!this.activity && this.activity.id === thoughtAboutActivity;
    if (decision.kind === 'continue') { this.activityThoughtAt = Date.now(); return; }
    const draft = decision.activity;
    if (!draft) return;
    if (decision.kind === 'adjust' && this.activity) {
      if (!sameActivity) { this.staleDropped++; return; } // 对旧活的调整，活已经换了
      const a = this.activity;
      Object.assign(a, { what: draft.what, why: draft.why || a.why, kind: draft.kind, steps: draft.steps, repeat: draft.repeat, iteration: 0, index: 0, adaptations: [], consecutiveFailures: 0,
        monologue: decision.monologue || a.monologue });
      if (draft.doneWhen) a.doneWhen = draft.doneWhen; else delete a.doneWhen;
      if (draft.expect) a.expect = draft.expect;
      if (draft.ifStuck) a.ifStuck = draft.ifStuck;
      this.activityThoughtAt = Date.now();
      this.d.bus.publish('activity_adjust', 'P2', `改一改做法：${a.what}`, { activity: describeActivity(a, this.d.adapter.state(), this.safe(() => this.d.perception.snapshot(), undefined)) });
      this.d.bus.publish('plan', 'P2', `[${decision.source}] ${a.what} —— ${decision.monologue}`, { thought: decision.monologue, source: decision.source, steps: a.steps, planId: a.id });
      return;
    }
    if (decision.kind === 'detour' && this.activity) {
      const a = this.activity;
      if (this.d.arbiter.info()?.planId === a.id) { this.d.arbiter.cancel('先去处理别的事'); a.index = Math.max(0, a.index - 1); }
      this.suspended.push(a);
      if (this.suspended.length > 2) this.suspended.shift();
      this.activity = null;
      this.d.bus.publish('activity_suspend', 'P2', `先放下「${a.what}」，等会儿回来`);
      this.beginActivity(draft, decision.monologue, decision.source, 'detour');
      return;
    }
    if (this.activity) this.dropActivity(decision.kind === 'switch' ? 'abandoned' : 'replaced', decision.monologue.slice(0, 80) || `改做：${draft.what}`);
    if (decision.kind === 'switch') this.suspended = [];
    this.beginActivity(draft, decision.monologue, decision.source, decision.kind, decision.kind === 'experiment' ? decision.hypothesis : undefined);
  }

  private say(text: string, decision: MindDecision) {
    const t = text.replace(/[\r\n]+/g, ' ').trim();
    if (!t || t.startsWith('/') || t === this.lastSay.text || Date.now() - this.lastSay.at < this.timing.sayGapMs) return;
    const state = this.d.adapter.state();
    const changedMind = ['switch', 'detour', 'experiment'].includes(decision.kind);
    const discovered = this.speechEventAt > this.lastSay.at && Date.now() - this.speechEventAt <= 60_000;
    const completed = this.lastRecord?.outcome === 'done' && this.lastRecord.at > this.lastSay.at;
    const danger = state.inLava || state.hp <= 8 || state.inWater && state.oxygen < 8 || this.safe(() => this.d.perception.snapshot().nearby.hostile.some((h) => h.dist <= 12), false);
    if (!changedMind && !discovered && !completed && !danger) return;
    const grams = (s: string) => {
      const compact = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)));
    };
    const spoken = grams(t);
    const similar = (other: string) => {
      const words = grams(other);
      return spoken.size > 0 && 2 * [...spoken].filter((g) => words.has(g)).length / (spoken.size + words.size) >= 0.65;
    };
    if (similar(this.lastSay.text) || this.d.self.recentThoughts(6).some((thought) => thought.kind === 'monologue' && Date.now() - thought.at <= 90_000 && similar(thought.text))) return;
    this.lastSay = { at: Date.now(), text: t };
    this.d.bus.publish('say', 'P2', t);
    try { this.d.say?.(t.slice(0, 200)); } catch { /* 聊天发不出去不影响游玩 */ }
  }

  private diary(text: string) {
    const s = this.d.adapter.state();
    let phase = '';
    try { phase = this.d.perception.snapshot()?.time?.phase ?? ''; } catch { /* 感知暂不可用 */ }
    const when = phase === 'night' ? '夜里' : phase === 'dusk' ? '傍晚' : phase === 'dawn' ? '清晨' : '白天';
    this.d.self.writeDiary(`${when}，${text}`, s.dim, [Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z)]);
    this.lastDiaryAt = Date.now();
  }

  // ---------------------------------------------------------------- 变化
  private snapshotNow(): Snapshot {
    const s = this.d.adapter.state();
    let hostiles: string[] = [], phase = '';
    try { const p = this.d.perception.snapshot(); hostiles = p.nearby.hostile.filter((h) => h.dist <= 16).map((h) => h.name); phase = p.time.phase; } catch { /* 感知暂不可用 */ }
    return { at: Date.now(), sessionId: s.sessionId, dim: s.dim, pos: { ...s.pos }, hp: s.hp, food: s.food, inv: inventoryOf(s), inWater: s.inWater, hostiles, phase };
  }

  private changesSinceLastThought(): string[] {
    const prev = this.lastSnapshot, now = this.snapshotNow();
    if (!prev) return ['刚开始玩，或者刚回过神来'];
    const secs = Math.round((now.at - prev.at) / 1000);
    if (now.sessionId !== prev.sessionId || now.dim !== prev.dim) return [`${secs} 秒里换了世界/维度`];
    const out: string[] = [`距上次想事情 ${secs} 秒`];
    const moved = Math.hypot(now.pos.x - prev.pos.x, now.pos.y - prev.pos.y, now.pos.z - prev.pos.z);
    if (moved >= 3) out.push(`走了约 ${Math.round(moved)} 格`);
    const { gained, lost } = diffInventory(prev.inv, now.inv);
    const g = Object.entries(gained).slice(0, 6).map(([k, v]) => `${k}+${v}`), l = Object.entries(lost).slice(0, 6).map(([k, v]) => `${k}-${v}`);
    if (g.length) out.push(`背包多了 ${g.join(' ')}`);
    if (l.length) out.push(`背包少了 ${l.join(' ')}`);
    if (Math.abs(now.hp - prev.hp) >= 2) out.push(`生命 ${Math.round(prev.hp)} → ${Math.round(now.hp)}`);
    if (Math.abs(now.food - prev.food) >= 3) out.push(`饥饿 ${prev.food} → ${now.food}`);
    if (prev.inWater !== now.inWater) out.push(now.inWater ? '掉进了水里' : '离开了水');
    if (now.phase && prev.phase && now.phase !== prev.phase) out.push(`天色 ${prev.phase} → ${now.phase}`);
    const newHostile = now.hostiles.filter((h) => !prev.hostiles.includes(h));
    if (newHostile.length) out.push(`附近出现了 ${[...new Set(newHostile)].join('、')}`);
    return out;
  }

  // ---------------------------------------------------------------- 外部控制
  private suspend(reason: string) {
    if (this.suspendedBy.has(reason)) return;
    this.suspendedBy.add(reason);
    this.generation++;
    this.cancelThinking(reason);
    if (this.activity) this.finishActivity('interrupted', reason === 'death' ? '死了' : '断线了');
    this.suspended = [];
    this.queuedNext = null;
  }

  suggest(text: string) {
    this.userSuggestion = text.slice(0, 200);
    this.backoffUntil = 0;
    if (this.thinking) { this.cancelThinking('new_suggestion'); this.staleDropped++; }
    this.d.bus.publish('user_suggestion', 'P2', `收到建议：${this.userSuggestion}`);
  }
  replan() {
    this.backoffUntil = 0;
    this.cancelThinking('manual_replan');
    this.requestThink('操作者让我重新想想', 'deliberate');
  }
  pause() {
    this.paused = true;
    this.generation++;
    this.cancelThinking('paused');
    const running = this.d.arbiter.info();
    // 暂停只是停手，心思保留：继续时从当前这一步重新开始
    if (this.activity && running?.planId === this.activity.id) this.activity.index = Math.max(0, this.activity.index - 1);
    this.d.arbiter.setPaused(true);
    this.d.bus.publish('paused', 'P1', 'Agent 已暂停（包括生存反射与迟到的决定）');
  }
  resume() {
    this.paused = false;
    this.d.arbiter.setPaused(false);
    this.backoffUntil = 0;
    this.d.bus.publish('resumed', 'P1', 'Agent 恢复，接着刚才的心思继续');
  }
  onDeath(info: { cause?: string; hazard?: Hazard | null; during?: string; message?: string } = {}) {
    // 游戏的死亡播报是原话（“Curio was blown up by Creeper”），比推测的死因可靠
    const cause = info.message ? `游戏播报：${info.message}` : info.cause ? causeName(info.cause as any) ?? info.cause : '不明原因';
    this.deathAt = Date.now();
    this.deathTold = !!info.message;
    this.suspend('death');
    this.d.arbiter.cancel('死亡');
    this.d.self.feel({ type: 'death' });
    this.d.self.think(`我死了（${cause}${info.during ? `，当时在做 ${info.during}` : ''}）`, 'feeling');
    this.diary(`死了一次，${cause}${info.during ? `，当时在${info.during}` : ''}`);
    this.lastFailure = { skill: 'survival', code: 'DIED', summary: `死亡：${cause}` };
    this.attention.notice('death', `刚刚死了（${cause}）${info.hazard ? `，(${info.hazard.pos.x},${info.hazard.pos.y},${info.hazard.pos.z}) 一带很危险` : ''}`, 0.9, 0);
    this.settleUntil = Date.now() + 1500;
  }
  /**
   * 游戏自己的系统消息：死亡播报、成就、别人进出服务器、公告。
   * 记进念头流（思考时能看到），重要的写进日记；死亡播报晚到时补到这次死亡上。
   */
  onGameMessage(m: ParsedGameMessage) {
    this.gameMessages.push({ at: Date.now(), text: m.text });
    if (this.gameMessages.length > 12) this.gameMessages.shift();
    if (m.kind === 'join' || m.kind === 'leave') return;
    this.d.self.think(`[游戏] ${m.text}`, 'notice');
    if (m.kind === 'death_self') {
      if (!this.deathTold && Date.now() - this.deathAt < 6000) {
        this.deathTold = true;
        this.diary(`游戏说我是这么死的：${m.text}`);
        this.attention.notice('death_told', `游戏播报：${m.text}${m.by ? `（是 ${m.by} 干的）` : ''}`, 0.85, 0);
      }
    } else if (m.kind === 'advancement_self') {
      this.d.self.feel({ type: 'novelty', strength: 0.8 });
      this.diary(`达成了成就：${m.text}`);
      this.attention.notice(`adv:${m.text}`, `游戏播报：${m.text}`, 0.5, 60_000);
    } else if (m.kind === 'death_other') {
      this.attention.notice(`other_death:${m.text}`, `游戏播报：${m.text}`, 0.4, 30_000);
    } else {
      this.attention.notice(`server:${m.text.slice(0, 40)}`, `服务器消息：${m.text}`, 0.35, 120_000);
    }
  }
  /** 最近的游戏消息（给思考看） */
  recentGameMessages(maxAgeMs = 10 * 60_000): string[] {
    return this.gameMessages.filter((g) => Date.now() - g.at <= maxAgeMs).slice(-6).map((g) => g.text);
  }

  onSpawn() { if (this.suspendedBy.has('death')) this.settleUntil = Date.now() + 1500; }
  onDisconnected() { this.suspend('disconnected'); this.d.arbiter.cancel('断线'); }

  /** 兼容旧接口：控制台、动作聊天和 !status 读的“当前计划” */
  get plan() {
    const a = this.activity;
    if (!a) return null;
    return { id: a.id, source: a.source === 'rule' ? 'rule' : 'llm', goal: a.what, goalType: a.kind, thought: a.monologue, steps: a.steps, index: a.index,
      binding: a.agendaId ? { intentId: a.agendaId } : {} };
  }

  /** 当前在意的事（给动作聊天/观察者模组的“目标”栏） */
  currentIntent(): { id: string; text: string } | null {
    const focus = this.d.self.activeAgenda();
    if (focus) return { id: focus.id, text: focus.text };
    return this.activity ? { id: this.activity.id, text: this.activity.what } : null;
  }

  snapshot() {
    const state = this.d.adapter.state();
    const self = this.d.self;
    const focus = self.activeAgenda();
    return {
      plan: this.plan,
      queued: this.queuedNext ? { goal: this.queuedNext.draft.what } : null,
      paused: this.paused, pauseReasons: [...this.suspendedBy],
      llmInFlight: !!this.thinking, llmReason: this.thinking ? `${this.thinking.tier === 'glance' ? '瞥一眼' : '认真想'}：${this.thinking.reason}` : '',
      userSuggestion: this.userSuggestion, lastFailure: this.lastFailure,
      backoffMs: Math.max(0, this.backoffUntil - Date.now()), staleDropped: this.staleDropped, generation: this.generation,
      autonomy: { intent: focus ? { id: focus.id, text: focus.text, whyNow: this.activity?.why ?? '' } : this.activity ? { text: this.activity.what, whyNow: this.activity.why } : null, project: null, evidence: [] },
      mode: this.autonomous ? 'mind' : 'mind-rules',
      mind: {
        mood: self.mood, feeling: moodWords(self.mood), traits: self.data.traits, likes: self.tastes(),
        activity: this.activity ? describeActivity(this.activity, state, this.safe(() => this.d.perception.snapshot(), undefined)) : null,
        suspended: this.suspended.map((a) => a.what),
        next: this.queuedNext?.draft.what ?? null,
        stream: self.recentThoughts(10),
        agenda: self.agenda(),
        knowHow: [...self.data.knowHow].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
        experiments: self.experiments(5),
        diary: self.diary(6),
        history: self.history(6),
        selfImage: self.selfImage(),
        lastDecision: this.lastDecision ? { kind: this.lastDecision.kind, tier: this.lastDecision.tier, monologue: this.lastDecision.monologue } : null,
      },
    };
  }
}
