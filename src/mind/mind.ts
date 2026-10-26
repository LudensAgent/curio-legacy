import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step, TaskOutcome, TaskPreemption } from '../arbiter/arbiter.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { AudienceContext } from '../live/audience.ts';
import { compileBuilding, normalizeSpec } from '../building/spec.ts';
import type { Hazard, WorldMemory } from '../memory/store.ts';
import { materialPlan } from '../methods/shortfall.ts';
import { DAWN_TICK, durationText, realSecondsToTicks, ticksUntil, type Perception, type Percept } from '../perception/perception.ts';
import type { MySkillInfo } from '../planner/prompt.ts';
import { evaluateCondition, observationReady } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import { causeName } from '../brain/habits.ts';
import { pickFuel } from '../skills/economy.ts';
import { pickVariant } from '../skills/work.ts';
import { afterStep, argsLabel, softMiss, createActivity, describeActivity, doneWhenMet, diffInventory, inventoryOf, nextStep, recordOf, remainingSteps, signatureOf, targetKeyOf, viewOf } from './activity.ts';
import type { BehaviorEngine } from './behaviors.ts';
import { recallLocal } from './recall.ts';
import { Attention, EXPERIENCE_MS, RECONSIDER, stuckHere, URGENT } from './attention.ts';
import { homeOf, myBuilds } from './home.ts';
import { settleBuild } from '../skills/build.ts';
import { myBed } from '../skills/stations.ts';
import { StrategyLog } from './strategy.ts';
import type { ParsedGameMessage } from '../memory/game-messages.ts';
import type { MindContext } from './prompt.ts';
import { moodWords, type SelfModel } from './self.ts';
import type { LedgerView } from './ledger.ts';
import type { Thinker } from './thinker.ts';
import type { Activity, ActivityDraft, ActivityEnd, ActivityOutcome, ActivityRecord, MindDecision } from './types.ts';

export interface MindDeps {
  adapter: GameAdapter; arbiter: Arbiter; perception: Perception; memory: WorldMemory; bus: EventBus;
  thinker: Thinker; self: SelfModel; persona: string;
  mySkills?: () => MySkillInfo[];
  researchContext?: () => unknown;
  audience?: { context(tier?: 'light' | 'full'): AudienceContext | null; buildConsensus?(windowMs?: number): { viewers: number; messages: number; samples: string[] }; clearBuildConsensus?(): void };
  onGoalEnd?: (status: string) => void;
  /** 主目标很久没进展：交给后台想“要做到它还缺什么能力” */
  onGoalStuck?: (goal: string, lines: string[]) => void;
  /** 游戏进度（里程碑）：做到了哪些、接下来还有哪些没做到 */
  progress?: () => { reached: string[]; next: string[] } | null;
  /** 想说话时（不以 / 开头） */
  say?: (text: string) => void;
  /** 后天学会的做法（行为技能）：失败时先试的恢复办法、模型写下就生效的新技能 */
  behaviors?: BehaviorEngine;
  /** 收获账本：做过的事的投入产出、东西出现在哪（想事时按关键词想起来） */
  ledger?: LedgerView | null;
  /** 心智觉得刚才的事值得练成技能：交给后台去写 */
  onWorthLearning?: (note: string) => void;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

/** 一步的“原样”：动作 + 参数（朝向不算） */
const exactSig = (step: { skill: string; args?: unknown }) => {
  const a = step.args && typeof step.args === 'object' ? { ...(step.args as Record<string, unknown>) } : {};
  delete a.facing;
  return `${step.skill} ${JSON.stringify(a)}`;
};
/** 失败原因去掉数字（“还差 53 处”和“还差 50 处”算同一种失败） */
const reasonKey = (summary: string) => summary.replace(/-?\d+(\.\d+)?/g, '#').slice(0, 60);

/** 本来就是在应对怪的动作：挨打时不用叫停 */
const COMBAT = new Set(['defend', 'flee', 'hunt', 'ranged_defend', 'shelter', 'eat', 'use_skill']);

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
  /** 两次“抬头看一眼”之间至少隔这么久（要紧的事、手上没活不受限） */
  glanceGapMs: 12_000,
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
  /** 同一个动作、同样的参数、同样的失败：连着来了几次就不让原样再试（得换做法） */
  private sameFails = new Map<string, { n: number; last: number; code: string; why: string; summary: string }>();
  static readonly SAME_FAIL_LIMIT = 3;
  static readonly SAME_FAIL_MS = 10 * 60_000;
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
  /**
   * 操作者的指令：不是一次性的“建议”，而是一直挂着，直到心智回应做完/做不到、来了新指令，或者放了很久。
   * 每次思考都放在最前面；刚收到时这一念必须照做（不受专注的限制），没回应就再想一次。
   */
  order: { text: string; at: number; status: 'new' | 'doing'; nudged: number; kind: 'order' | 'suggestion'; activityId?: string } | null = null;
  /** 指令最多挂这么久（模型忘了说做完也不会一直纠结） */
  static readonly ORDER_TTL_MS = 10 * 60_000;
  private lastFailure: { skill: string; code?: string; summary: string } | null = null;
  private lastSay = { at: 0, text: '' };
  private lastDiaryAt = 0;
  private finishedSinceReflect = 0;
  private activityThoughtAt = 0;
  private pendingReason: { reason: string; tier: 'glance' | 'deliberate' } | null = null;
  /** “这段活快干完了，想想接下来”每段活只问一次（模型没写 next 也不会一直追问） */
  private nearEndAskedFor: string | null = null;
  private waitingSince: number | null = null;
  /** 干等时无聊到多少就想想“这段时间能做点什么” */
  static BORED_AT = 0.6;
  /** 最后一步做了这么久才开始想“接下来做什么” */
  static NEAR_END_AFTER_MS = 4000;
  static NEAR_END_REASON = '手上这段活快干完了，想想接下来';
  /** 刚从绕路回到这段活：先想一想再动手（放下它的这段时间里情况可能变了，比如等的东西到了、要的已经够了） */
  private resumeCheck: string | null = null;
  private lastDim: string | null = null;

  /**
   * 第一次到一个新维度：这是个新环境。不告诉它这里有什么危险（那是它自己要看、要学的），
   * 只提醒熟悉的那一套不一定适用、以前学的技能都还没在这里验证过——先站稳看清楚，吃了亏就学。
   */
  private arriveSomewhereNew(dim: string) {
    const skills = this.safe(() => this.d.behaviors?.list().filter((b) => this.d.behaviors!.enabled(b)).map((b) => b.name) ?? [], [] as string[]);
    const text = `第一次来到 ${dim}：这是个全新的环境，在别处管用的那一套（怎么走、怎么躲、哪里安全、东西在哪）不一定还成立`;
    this.d.self.think(text, 'notice');
    this.d.bus.publish('new_environment', 'P1', text, { dim, untested: skills });
    this.requestThink(`${text}。先别急着走远：看清楚这里和以前的地方有什么不同、哪些东西危险、怎么回去${skills.length ? `；你的技能（${skills.slice(0, 8).join('、')}）都是在别处学的，这里还没验证过，可以用 dim 条件写只在这里生效的技能` : ''}；吃了亏、发现了这里的门道，就写 worth_learning`, 'deliberate');
  }
  /** 上一次卡住的事，和随后在同一带做成的事：提醒模型把管用的做法写成技能 */
  private lastStuck: { what: string; why: string; pos: AgentState['pos']; at: number; skill?: string; code?: string } | null = null;
  private learnFrom: { stuck: NonNullable<Mind['lastStuck']>; solved: { what: string; routine: string[] } } | null = null;
  private skillOpenedAt = new Map<string, number>();

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
  /** 日子是怎么过的（夜里在哪、怎么死的）：回想时做策略回顾用 */
  readonly strategy = new StrategyLog();
  private bedDist(): number | null {
    const s = this.d.adapter.state();
    return this.safe(() => myBed(this.d.memory, s)?.dist ?? null, null);
  }

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
    if (this.lastDim !== state.dim) {
      this.lastDim = state.dim;
      if (this.d.self.firstVisit(state.dim)) this.arriveSomewhereNew(state.dim);
    }
    this.lastSession = state.sessionId;
    if (Date.now() < this.settleUntil) return;
    if (this.suspendedBy.has('death') || this.suspendedBy.has('disconnected')) {
      const wasDead = this.suspendedBy.has('death');
      this.suspendedBy.delete('death'); this.suspendedBy.delete('disconnected');
      // 刚复活：先看看复活点周围有没有怪（不少回是一复活就被同一群怪接着打死）
      const near = wasDead ? this.safe(() => this.d.perception.snapshot().nearby.hostile.filter((h) => h.dist <= 16).map((h) => `${h.name} ${Math.round(h.dist)}格`), [] as string[]) : [];
      this.requestThink(wasDead ? `刚复活${near.length ? `；复活点附近就有 ${near.join('、')}，先想好怎么不被它们接着打死，再做别的` : ''}` : '重新连上了', 'deliberate');
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
    const loop = this.progressing() ? null : this.attention.fromLoop(this.recentEnds, this.d.adapter.state().pos);
    for (const n of [...this.attention.fromPercept(p), ...(loop ? [loop] : [])]) {
      this.d.bus.publish('notice', n.level === 'note' ? 'P3' : 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
      if (/^(res|disc|item):/.test(n.key)) { this.d.self.feel({ type: 'novelty', strength: n.salience }); this.speechEventAt = Date.now(); }
    }
    // 干等（躲着熬夜、原地等）：无聊涨得快；无聊到一定程度就是一件“注意到的事”，会让它想想这段时间能做点什么
    const cur = this.d.arbiter.info();
    const waiting = !!cur && ['shelter', 'wait'].includes(cur.skill) && cur.source !== 'filler';
    if (waiting) this.waitingSince ??= Date.now(); else this.waitingSince = null;
    this.d.self.tickMood(waiting ? 'waiting' : !!this.activity && this.activity.kind !== 'rest');
    if (waiting && this.d.self.mood.boredom >= Mind.BORED_AT && this.waitingSince) {
      const waited = durationText(realSecondsToTicks((Date.now() - this.waitingSince) / 1000));
      const tod = ((p.time.timeOfDay % 24000) + 24000) % 24000;
      const dark = tod >= 12000 && tod < DAWN_TICK;
      const n = this.attention.notice('bored_waiting', `已经干等了${waited}（游戏时间），好无聊${dark ? `（离天亮还有${durationText(ticksUntil(tod, DAWN_TICK))}）` : '（现在还是白天）'}：这段时间能做点什么？`, 0.62, 4 * 60_000);
      if (n) this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    }
    // 天快黑时惦记家：离家远就想着往回走（像真人一样，不是硬规则：只是一件“注意到”的事）
    if (p.time.phase === 'dusk' || p.time.phase === 'night') {
      const s = this.d.adapter.state();
      const home = this.safe(() => homeOf(this.d.memory, s), null);
      if (home && home.dist > 40) {
        const n = this.attention.notice('far_from_home', `天${p.time.phase === 'dusk' ? '快' : '已经'}黑了，家（${home.label}）还在${home.dir}边 ${home.dist} 格`, 0.55, 15 * 60_000);
        if (n) this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
      }
    }
    this.safe(() => this.audienceOnBuilding(), undefined);
    this.safe(() => this.autoCheckPlan(p), undefined);
    this.safe(() => this.strategy.onTick(p.time.phase, this.bedDist(), this.activity?.what), undefined);
    this.safe(() => this.goalStuckCheck(), undefined);
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
    if (this.order && Date.now() - this.order.at > Mind.ORDER_TTL_MS) {
      this.d.bus.publish('operator_order_end', 'P2', `操作者的指令放了十分钟还没说做完，先撤下：${this.order.text}`, { status: 'expired' });
      this.order = null;
    }
    if (this.order?.status === 'new') return this.think(this.order.kind === 'order' ? '操作者下了指令' : '操作者提了个建议', 'deliberate');
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
    // 抬头看一眼也要有间隔：注意力被每一件小事拽走，手上的活就总是做不完
    const gapOk = Date.now() - this.lastThoughtAt >= this.timing.glanceGapMs;
    // 躲着、等着的时候一般的事不值得爬起来想；但“干等得好无聊”本身就是要想一想的事（无聊让人找新鲜事做）
    const bored = this.attention.peek().some((n) => n.key === 'bored_waiting');
    if (bored && gapOk) return this.think('干等着好无聊，想想这段时间能做点什么', 'deliberate');
    if (!resting && gapOk && this.attention.highest() >= RECONSIDER) return this.think('注意到了一些事', 'glance');
    // 边做边想：最后一步做了一会儿（模型想一次要好几秒）才琢磨下一段活；每段活只问一次。
    // 以前“最后一轮一开始”就问：repeat=1 的活第一步一开工就问，模型常顺手把刚开工的活换掉，注意力几秒一换
    if (!this.queuedNext && this.nearEndAskedFor !== this.activity.id && current?.planId === this.activity.id && remainingSteps(this.activity) === 0
      && Date.now() - current.startedAt >= Mind.NEAR_END_AFTER_MS) {
      this.nearEndAskedFor = this.activity.id;
      return this.think(Mind.NEAR_END_REASON, this.needsBigPicture() ? 'deliberate' : 'glance');
    }
    if (Date.now() - Math.max(this.activityThoughtAt, this.lastThoughtAt) > this.timing.checkInMs) return this.think('做了一会儿了，抬头看看', 'glance');
  }

  /**
   * 造房子阶段听观众的：好几位观众（或一再有人）劝“房子够了、别修了”，就把手边那座没盖完的房子认定为能住。
   * 只在确实在盖/补这座房子时才算（离工地近、最近在上面干过活、手上的事和盖房有关），别的时候这些弹幕只是普通弹幕。
   */
  private audienceOnBuilding() {
    const a = this.d.audience;
    if (!a?.buildConsensus) return;
    const c = a.buildConsensus(Mind.AUDIENCE_ACCEPT.windowMs);
    if (c.viewers < Mind.AUDIENCE_ACCEPT.viewers && !(c.messages >= Mind.AUDIENCE_ACCEPT.messages && c.viewers >= 2)) return;
    const s = this.d.adapter.state();
    const site = myBuilds(this.d.memory, s, 20).find((b) => b.status !== 'complete' && b.dist <= 32 && b.attempts >= 1 && Date.now() - b.lastWorkedAt <= 15 * 60_000);
    if (!site) return;
    const doing = [this.activity?.what, this.activity?.why, this.d.self.plan()?.goal, ...(this.d.self.plan()?.steps.filter((x) => !x.done).map((x) => x.text) ?? [])].filter(Boolean).join(' ');
    const building = this.activity?.kind === 'build' || this.activity?.steps.some((st) => st.skill === 'build') || /屋|房|家|缺口|补|盖|建|build/.test(doing);
    if (!building) return;
    const r = settleBuild(this.d.memory, site.id, 'accept', 'audience', `观众一再劝够了（${c.viewers} 位、${c.messages} 条）：${c.samples.join(' / ')}`.slice(0, 300));
    a.clearBuildConsensus?.();
    if (!r.ok) return;
    this.d.bus.publish('build_accepted', 'P2', `${r.text}（听了观众的：${c.samples[0] ?? ''}）`, { projectId: site.id, by: 'audience', viewers: c.viewers, messages: c.messages });
    this.d.self.think(`观众一再说「${c.samples[0] ?? '够了'}」，${r.text}`, 'outcome');
    const n = this.attention.notice(`audience_accept:${site.id}`, `观众们一再劝房子够了：${r.text}——可以去做别的事了`, 0.6, 0);
    if (n) this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
  }

  /** 主目标清单 30 分钟以上、8 段活以上没勾掉一项：目标卡住了 */
  private goalStuckCheck() {
    const plan = this.d.self.plan();
    if (!plan || !this.d.onGoalStuck) return;
    const since = plan.progressAt ?? plan.setAt;
    const acts = this.d.self.history(60).filter((r) => r.at > since);
    if (Date.now() - since < 30 * 60_000 || acts.length < 8) return;
    this.d.onGoalStuck(plan.goal, [
      `目标：${plan.goal}（定下 ${Math.round((Date.now() - plan.setAt) / 60_000)} 分钟，${Math.round((Date.now() - since) / 60_000)} 分钟没勾掉一项）`,
      `清单：${plan.steps.map((st, i) => `${i}.[${st.done ? 'x' : ' '}] ${st.text}`).join(' ')}`,
      ...acts.slice(-20).map((r) => `${r.what} → ${r.outcome}${r.outcome !== 'done' ? `：${r.summary.slice(0, 80)}` : ''}`),
    ]);
  }

  /** 清单项写了 done_when 的：事实达成就自动勾掉；全勾掉主目标就完成 */
  private autoCheckPlan(p: Percept) {
    const s = this.d.adapter.state();
    const checked = this.d.self.autoCheckPlan((c) => evaluateCondition(c, s, s.worldId, [], p).status === 'satisfied');
    if (!checked.length) return;
    this.d.bus.publish('plan_check', 'P3', `条件达成，自动勾掉：${checked.join('、')}`, { auto: true });
    this.d.self.think(`清单「${checked.join('、')}」已经做到了`, 'outcome');
    const now = this.d.self.plan();
    if (now && now.steps.length && now.steps.every((st) => st.done)) {
      this.d.self.setAgendaStatus(now.agendaId, 'done');
      this.d.self.think(`「${now.goal}」的清单都做完了`, 'outcome');
      this.d.bus.publish('plan_done', 'P2', `主目标完成：${now.goal}`);
    }
  }

  /** 观众劝“够了”多少才算共识：5 分钟内 3 位观众，或至少 2 位观众说了 3 条以上 */
  static AUDIENCE_ACCEPT = { windowMs: 5 * 60_000, viewers: 3, messages: 3 };

  /** 事情在往前走：主目标清单最近勾掉过一项，或者刚做成了一段活。这时不算“卡在这一带” */
  private progressing(): boolean {
    const plan = this.d.self.plan();
    if (plan && plan.steps.some((st) => st.done) && Date.now() - plan.updatedAt < 5 * 60_000) return true;
    return this.lastRecord?.outcome === 'done' && Date.now() - this.lastRecord.at < 2 * 60_000;
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
    if (this.resumeCheck === this.activity.id) {
      if (this.thinking || this.pendingReason) return; // 等这一念想完
      this.resumeCheck = null;
    } else this.resumeCheck = null;
    const step = nextStep(this.activity);
    if (!step) return this.finishActivity('done', '这段活的步骤都做完了');
    // 原样失败过好几次的那一步：不再原样重试（换参数、换位置、先解决失败的原因、或者换一种动作）
    const same = this.sameFails.get(exactSig(step));
    if (same && same.n >= Mind.SAME_FAIL_LIMIT && Date.now() - same.last < Mind.SAME_FAIL_MS) {
      this.d.bus.publish('decision_normalized', 'P2', `「${step.skill} ${argsLabel(step)}」已经原样失败 ${same.n} 次，不再原样重试`, { skill: step.skill });
      return this.finishActivity('stuck', `「${step.skill} ${argsLabel(step)}」已经原样失败 ${same.n} 次（${same.summary}），再原样试也一样：换做法——先解决失败的原因、换参数或位置、或者换一种动作`);
    }
    const state = this.d.adapter.state();
    this.activity.stepStart = { pos: { ...state.pos }, view: viewOf(this.safe(() => this.d.perception.snapshot(), undefined)) };
    const r = this.d.arbiter.start(step, this.activity.source === 'rule' ? 'rule' : 'llm', { planId: this.activity.id });
    if ('error' in r) this.handleStepResult(step, { status: 'failed', failureCode: 'BAD_ARGS', summary: r.error }, 0);
    else if (remainingSteps(this.activity) === 0 && !this.queuedNext && !this.thinking && QUICK.has(step.skill) && this.nearEndAskedFor !== this.activity.id) {
      this.nearEndAskedFor = this.activity.id;
      this.think(Mind.NEAR_END_REASON, this.needsBigPicture() ? 'deliberate' : 'glance');
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
    // 为操作者的指令开的那段活做完了：指令就算完成（不必等它记得说 done，免得一直挂着纠结）
    if (this.order?.activityId === a.id) {
      if (outcome === 'done') {
        this.d.bus.publish('operator_order_end', 'P2', `照操作者的指令做完了：${this.order.text}`, { status: 'done', via: 'activity' });
        this.order = null;
      } else delete this.order.activityId;
    }
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
    if (outcome === 'stuck') this.lastStuck = { what: a.what, why: summary.slice(0, 100), pos: { ...state.pos }, at: Date.now(), ...(failed ? { skill: failed.skill, code: failed.failureCode } : {}) };
    else if (outcome === 'done' && this.lastStuck && Date.now() - this.lastStuck.at < 8 * 60_000
      && Math.hypot(state.pos.x - this.lastStuck.pos.x, state.pos.y - this.lastStuck.pos.y, state.pos.z - this.lastStuck.pos.z) <= 24 && a.what !== this.lastStuck.what) {
      this.learnFrom = { stuck: this.lastStuck, solved: { what: a.what, routine: a.steps.slice(0, 6).map((st) => `${st.skill} ${argsLabel(st)}`) } };
      this.lastStuck = null;
    }
    const gains = Object.entries(record.gained).map(([k, v]) => `${k}×${v}`).join('、');
    this.d.self.think(`${a.what} → ${outcome === 'done' ? '做完了' : outcome === 'stuck' ? '卡住了' : '停下了'}${gains ? `，得到 ${gains}` : ''}${outcome !== 'done' ? `：${summary.slice(0, 60)}` : ''}`, 'outcome');
    const status = outcome === 'done' ? 'succeeded' : outcome === 'stuck' ? 'failed' : 'interrupted';
    const goalType = ['tidy', 'social', 'other', 'experiment'].includes(a.kind) ? 'investigate' : a.kind;
    this.d.memory.recordGoal({ goal: a.what, goalType, source: a.source === 'rule' ? 'rule' : 'llm', status, summary, durationSec: record.durationSec,
      steps: signatureOf(a.steps).split('>'), plan: a.steps, worldId: state.worldId, dimension: state.dim });
    this.d.bus.publish('attempt_end', outcome === 'stuck' ? 'P1' : 'P3', `一段活「${a.what}」→ ${outcome}：${summary}${gains ? `（得到 ${gains}）` : ''}`,
      { planId: a.id, status, outcome, gained: record.gained, durationSec: record.durationSec, what: a.what, kind: a.kind, signature: record.signature,
        how: a.steps.slice(0, 6).map((st) => `${st.skill} ${argsLabel(st)}`).join(' > ').slice(0, 300), effectEvidence: { verified: true, changed: !!gains, reasons: gains ? [`背包实增 ${gains}`] : [] } });
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
        // 真人做完岔出去的事，会先想一下“刚才在干嘛、还要接着干吗”，而不是闷头接着做：
        // 放下它的这段时间里，等的东西可能到了、要攒的可能已经够了、天可能黑了
        const away = Math.max(1, Math.round((Date.now() - (resume.suspendedAt ?? Date.now())) / 1000));
        delete resume.suspendedAt;
        this.resumeCheck = resume.id;
        this.requestThink(outcome === 'stuck'
          ? `绕路去做的「${a.what}」卡住了：${summary}。原来放下的「${resume.what}」还要接着做吗？`
          : `绕路去做的「${a.what}」做完了。${away} 秒前放下的「${resume.what}」（${resume.why || '没写原因'}）还要接着做吗？这段时间里它的前提可能已经变了`, 'deliberate');
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

  private handleStepResult(step: Step, result: { status: 'succeeded' | 'failed' | 'cancelled'; failureCode?: any; summary: string; data?: Record<string, unknown> }, durationMs: number) {
    const a = this.activity;
    if (!a) return;
    if (this.recoverySkipped(a, step, result)) return;
    const observationMiss = softMiss(a, step, result);
    if (result.status === 'failed' && !observationMiss) {
      this.lastFailure = { skill: step.skill, code: result.failureCode, summary: result.summary };
      this.pruneFailures();
      const key = targetKeyOf(step);
      const entry = this.failuresByTarget.get(key) ?? { n: 0, last: 0, at: [] };
      entry.at.push(Date.now()); entry.n = entry.at.length; entry.last = Date.now();
      this.failuresByTarget.set(key, entry);
      const sig = exactSig(step), why = reasonKey(result.summary), prev = this.sameFails.get(sig);
      const same = prev && prev.code === String(result.failureCode ?? '') && prev.why === why && Date.now() - prev.last < Mind.SAME_FAIL_MS;
      this.sameFails.set(sig, { n: same ? prev!.n + 1 : 1, last: Date.now(), code: String(result.failureCode ?? ''), why, summary: result.summary.slice(0, 120) });
    } else if (result.status === 'succeeded') this.sameFails.delete(exactSig(step));
    if (a.awaitingRecovery && step.skill !== 'use_skill') {
      const name = a.awaitingRecovery;
      delete a.awaitingRecovery;
      this.safe(() => this.d.behaviors?.creditRecovery(name, result.status === 'succeeded', { skill: step.skill, code: result.failureCode ?? null }), undefined);
    }
    const percept = this.safe(() => this.d.perception.update(), undefined);
    const verdict = afterStep(a, step, result, durationMs, this.d.adapter.state(), percept);
    // 身体自己应变不了：先试学会的恢复办法（模型以前从类似的卡住里总结出来的），试过还不行才叫脑子
    if (verdict.kind === 'stuck' && result.status === 'failed' && step.skill !== 'use_skill' && this.d.behaviors) {
      const tried = new Set(a.adaptations.filter((x) => x.startsWith('skill:')).map((x) => x.slice(6)));
      const skipped = a.adaptations.filter((x) => x.startsWith('skip:')).length;
      const b = tried.size - skipped < 2 ? this.safe(() => this.d.behaviors!.recoveryFor({ skill: step.skill, code: result.failureCode }, tried), null) : null;
      if (b) {
        a.adaptations.push(`skill:${b.name}`);
        a.awaitingRecovery = b.name;
        a.steps.splice(Math.max(0, a.index - 1), 0, { skill: 'use_skill', args: { name: b.name, failure: { skill: step.skill, args: step.args ?? {}, code: result.failureCode ?? null, summary: result.summary.slice(0, 160) } }, optional: true });
        a.index = Math.max(0, a.index - 1);
        a.consecutiveFailures = 0;
        this.d.self.think(`${step.skill} 没成，照学会的「${b.name}」试试`, 'outcome');
        this.d.bus.publish('body_adapt', 'P3', `身体先试学会的做法：${b.name}（${b.description}）`, { planId: a.id, skill: b.name });
        return;
      }
    }
    if (verdict.kind === 'continue') {
      if (verdict.adapted) {
        this.d.self.think(verdict.adapted, 'outcome');
        this.d.bus.publish('body_adapt', 'P3', `身体自己应变：${verdict.adapted}`, { planId: a.id });
      }
      return;
    }
    // 步骤做完了，收工条件却没达到（挖了一段巷子没见着铁）：提前想好的下一段多半建立在“这段达成了”上（拿铁去烧），不能照接
    const unmet = verdict.kind === 'done' && !verdict.met ? this.queuedNext : null;
    if (unmet) this.queuedNext = null;
    this.finishActivity(verdict.kind === 'done' ? 'done' : 'stuck', verdict.why);
    if (unmet) this.requestThink(`「${a.what}」${verdict.why}，提前想好的「${unmet.draft.what}」先不接着做：它要的东西还没到手。接下来怎么办？`, 'deliberate');
  }

  /**
   * 刚插进去的恢复技能说“这次跟我无关”（skipped）：那一步什么都没变，原样重做只会再失败一次、还把账算到这个技能头上。
   * 换下一个对得上的恢复技能；没有就把原来的失败交还给心智。返回 true 表示已经处理完。
   */
  private recoverySkipped(a: Activity, step: Step, result: { status: string; summary: string; data?: unknown }): boolean {
    const failure = (step.args as any)?.failure as { skill: string; args?: unknown; code?: string | null; summary?: string } | undefined;
    if (step.skill !== 'use_skill' || !failure || result.status !== 'succeeded' || !(result.data as any)?.result?.skipped || !this.d.behaviors) return false;
    const name = String((step.args as any)?.name ?? '');
    if (a.awaitingRecovery === name) delete a.awaitingRecovery;
    a.adaptations.push(`skip:${name}`);
    this.safe(() => this.d.behaviors!.recoverySkipped(name, { skill: failure.skill, code: failure.code ?? null }), undefined);
    const retry = a.steps[a.index];
    const tried = new Set(a.adaptations.filter((x) => x.startsWith('skill:')).map((x) => x.slice(6)));
    const skipped = a.adaptations.filter((x) => x.startsWith('skip:')).length;
    const next = tried.size - skipped < 2 ? this.safe(() => this.d.behaviors!.recoveryFor({ skill: failure.skill, code: failure.code ?? undefined }, tried), null) : null;
    if (next) {
      a.adaptations.push(`skill:${next.name}`);
      a.awaitingRecovery = next.name;
      a.steps.splice(a.index, 0, { skill: 'use_skill', args: { name: next.name, failure }, optional: true });
      this.d.bus.publish('body_adapt', 'P3', `「${name}」说这次跟它无关，换学会的做法：${next.name}（${next.description}）`, { planId: a.id, skill: next.name });
      return true;
    }
    // 没有别的办法：别白白重做那一步，直接把它原来的失败交给心智
    if (retry && retry.skill === failure.skill) a.steps.splice(a.index, 1);
    this.d.bus.publish('body_adapt', 'P3', `「${name}」说这次跟它无关，没有别的学会的做法，交给心智`, { planId: a.id, skill: name });
    this.finishActivity('stuck', `${failure.skill} 没成：${String(failure.summary ?? '').slice(0, 140)}`);
    return true;
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
    if (ev.type === 'death' || ev.type === 'task_end') this.safe(() => this.strategy.onEvent(ev, {
      phase: this.safe(() => this.d.perception.snapshot().time.phase, ''), bedDist: this.bedDist(), doing: this.activity?.what ?? this.lastRecord?.what ?? '' }), undefined);
    const n = this.attention.fromEvent(ev);
    if (n && n.level !== 'note') this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    if (ev.type === 'hurt') { this.d.self.feel({ type: 'hurt', amount: 2 }); this.hurtWhileBusy(); }
    if (ev.type === 'item_new' || ev.type === 'discovery') {
      this.speechEventAt = Date.now();
      this.d.self.feel({ type: 'novelty', strength: ev.type === 'item_new' ? 0.6 : 0.4 });
      if (ev.type === 'item_new' && Date.now() - this.lastDiaryAt > this.timing.diaryGapMs / 2) this.diary(ev.msg.slice(0, 80));
    }
  }

  /**
   * 正在做跟打架无关的事（盖房、挖、走、原地等）时挨了打，而且身边有怪：
   * 给身体的技能一点时间接手；没有技能接手，就停下手上的事、马上认真想。怎么应对由它自己定，这里只保证它不会边挨打边继续砌墙。
   */
  private hurtAt = 0;
  private hurtWhileBusy() {
    const now = Date.now();
    if (now - this.hurtAt < 8000) return;
    this.hurtAt = now;
    setTimeout(() => {
      const cur = this.d.arbiter.info();
      if (!cur || (cur.source !== 'llm' && cur.source !== 'rule') || COMBAT.has(cur.skill)) return;
      const hostiles = this.safe(() => this.d.perception.snapshot().nearby.hostile.filter((h) => h.dist <= 8), []);
      if (!hostiles.length) return;
      const hp = Math.round(this.d.adapter.state().hp * 10) / 10;
      // 停下的那一步算没做（想完要是接着做，从这一步重新来）
      if (this.activity && cur.planId === this.activity.id) this.activity.index = Math.max(0, this.activity.index - 1);
      this.d.arbiter.cancel('挨打了');
      // 想好之前别又把刚停下的那一步接着做
      if (this.activity) this.resumeCheck = this.activity.id;
      this.requestThink(`正在 ${cur.skill} 时挨打了（血 ${hp}）`, 'deliberate');
      const n = this.attention.notice('hurt_busy', `正在 ${cur.skill} 时挨打了（血 ${hp}，${hostiles.slice(0, 3).map((h) => `${h.name} ${Math.round(h.dist)}格`).join('、')}），手上的事先停了`, 0.9, 0);
      if (n) this.d.bus.publish('notice', 'P1', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    }, 700).unref?.();
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
    const urgent = noticed.some((n) => n.level === 'urgent');
    const reflect = tier === 'deliberate' && this.finishedSinceReflect >= 4;
    this.pruneFailures();
    // 按关键词想起相关的经历、教训和技能（像人看到眼前的事想起以前），拿得准的技能直接翻开
    const plan = this.d.self.plan();
    const query = [plan?.goal, ...(plan?.steps.filter((st) => !st.done).slice(0, 2).map((st) => st.text) ?? []), this.activity?.what, this.activity?.why,
      this.lastRecord?.what, this.lastRecord?.outcome === 'stuck' ? this.lastRecord.summary : '', this.lastFailure?.summary, ...noticed.map((n) => n.what), reason].filter(Boolean).join(' ');
    const book = this.d.thinker.skillBook;
    const recalled = this.safe(() => recallLocal(query, { self: this.d.self, memory: this.d.memory, book, ledger: this.d.ledger }, { n: tier === 'glance' ? 3 : 6, exclude: ['know_how'], excludeRefs: this.d.self.history(5).map((r) => r.id) }), []);
    let openedSkill: MindContext['openedSkill'];
    const top = recalled.find((r) => r.kind === 'skill' && r.score >= 4 && r.ref);
    if (tier === 'deliberate' && top && book?.get(top.ref!) && Date.now() - (this.skillOpenedAt.get(top.ref!) ?? 0) > 5 * 60_000) {
      const k = book.get(top.ref!)!;
      this.skillOpenedAt.set(k.name, Date.now());
      openedSkill = { name: k.name, body: k.body.slice(0, 1500) };
      this.d.bus.publish('skill_read', 'P3', `想起了技能：${k.name}`, { name: k.name, source: k.source, auto: true });
    }
    const learnFrom = this.learnFrom;
    const ctx: MindContext = {
      tier, reason: reflect ? `${reason}；做完了好几段活，顺便回头看看哪些办法好用、哪些该改` : reason,
      percept, state, self: this.d.self, memory: this.d.memory, activity: this.activity, suspended: this.suspended,
      lastRecord: this.lastRecord, noticed, changes: this.changesSinceLastThought(), userSuggestion: this.userSuggestion,
      operatorOrder: this.order ? { text: this.order.text, ageSec: Math.round((Date.now() - this.order.at) / 1000), status: this.order.status, kind: this.order.kind } : null,
      audience: this.d.audience?.context(tier === 'glance' ? 'light' : 'full') ?? null, notes: this.notes,
      mySkills: tier === 'deliberate' ? this.safe(() => this.d.mySkills?.() ?? [], []) : [],
      researchContext: tier === 'deliberate' && reflect ? this.safe(() => this.d.researchContext?.(), undefined) : undefined,
      persona: this.d.persona,
      gameMessages: this.recentGameMessages(),
      // 收起、停用的技能不进目录（翻技能书、回想时还看得到）：目录越长越难挑，还拖累缓存
      skills: this.safe(() => this.d.thinker.skillBook?.index((n) => !!this.d.behaviors?.inactive(n)) ?? [], []),
      stuckHere: this.progressing() ? null : stuckHere(this.recentEnds, state.pos),
      recalled, ...(openedSkill ? { openedSkill } : {}), ...(learnFrom ? { learnFrom } : {}), plan,
      ...(this.d.behaviors && tier === 'deliberate' ? { learnedSkills: this.safe(() => this.d.behaviors!.overview().filter((l) => !/已收起|已停用/.test(l)), []) } : {}),
      ...(this.d.thinker.designing ? { designing: { brief: this.d.thinker.designing.brief, minutes: Math.round((Date.now() - this.d.thinker.designing.startedAt) / 60_000) } } : {}),
      repeatedFailures: [...this.failuresByTarget].filter(([, f]) => f.n >= 2)
        .sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([key, f]) => `${key.replace(':', ' ')} ×${f.n}（10 分钟内）`),
    };
    const suggestion = this.userSuggestion;
    const order = this.order, orderWasNew = order?.status === 'new';
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
      if (learnFrom && this.learnFrom === learnFrom) this.learnFrom = null; // 提醒过一次就够了
      if (order && order === this.order) this.answerOrder(order, orderWasNew, decision);
      // 刚收到的指令：照做时不受“专注”的限制（瞥一眼不能换、刚开工先不改）
      // 刚收到的指令（或决定采纳的建议）：照做时不受专注的限制
      const followsOperator = orderWasNew && (order?.kind === 'order' ? decision.operator?.status !== 'cannot' : decision.operator?.status === 'adopted');
      this.apply(decision, activityId, ctx.lastRecord, { urgent: urgent || followsOperator, nearEnd: reason === Mind.NEAR_END_REASON });
      if (followsOperator && this.order === order && order && this.activity && !order.activityId) order.activityId = this.activity.id;
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
    // 零碎经验攒够了才回想；攒得少，隔久一点也回想一次——那时主要是退一步看看日子怎么过的（策略回顾）
    const since = Date.now() - this.d.self.reflectedAt;
    if (since < 20 * 60_000 || this.d.self.reflectionBacklog() < 5 && since < 45 * 60_000) return;
    const controller = new AbortController();
    this.reflecting = controller;
    this.d.bus.publish('reflect_start', 'P3', `回想一下这段时间（${why}）`);
    const strategy = this.safe(() => this.strategy.facts({
      agenda: this.d.self.data.agenda, builds: myBuilds(this.d.memory, this.d.adapter.state(), 8),
      progress: this.safe(() => this.d.progress?.() ?? null, null),
    }), [] as string[]);
    this.d.thinker.reflect(this.d.self, this.d.persona, controller.signal, strategy).then((c) => {
      if (this.reflecting !== controller) return;
      this.reflecting = null;
      if (!c) return;
      const { before, after, keptGoals } = this.d.self.consolidate(c);
      // 回想想放下正在推进的主目标：不替它放，告诉它，下一次认真想时自己决定
      for (const g of keptGoals) this.d.bus.publish('goal_kept', 'P3', `回想时觉得主目标「${g.text.slice(0, 40)}」可以放下了，但它还在推进中，先留着：真要放下就在认真想时写 agenda_drop，或者换一个主目标`, { agendaId: g.id });
      for (const k of this.d.self.data.knowHow) if (c.add.includes(k.text) || c.merge.some((m) => m.text === k.text) || c.rewrite.some((r) => r.id === k.id)) {
        this.d.memory.addLesson(k.text, { source: 'model', key: `know_how:${k.id}` });
      }
      if (c.skill?.raw && this.d.behaviors && (Array.isArray(c.skill.raw.steps) || c.skill.raw.when !== undefined)) {
        const w = this.safe(() => this.d.behaviors!.write(c.skill!.raw, { by: 'mind' }), { ok: false as const, error: '写技能时出错' });
        if (w.ok) this.d.bus.publish('skill_written', 'P2', `回想时写下技能 ${w.name}`, { name: w.name, mode: w.mode, live: true });
        else this.d.bus.publish('skill_rejected', 'P3', `没有保存技能：${w.error}`);
      } else if (c.skill) {
        const w = this.safe(() => this.d.thinker.skillBook?.write(c.skill!.name, c.skill!.description, c.skill!.body) ?? null, null);
        if (w?.ok) {
          this.d.self.think(`把「${w.skill.description}」的做法写成了自己的技能 ${w.skill.name}`, 'learned');
          this.d.bus.publish('skill_written', 'P2', `${w.created ? '写了一份新技能' : '修订了技能'}：${w.skill.name}——${w.skill.description}`, { name: w.skill.name });
        } else if (w && !w.ok) this.d.bus.publish('skill_rejected', 'P3', `没有保存技能：${w.error}`);
      }
      for (const a of c.agendaAdd ?? []) {
        this.d.self.think(`回头看了看这几天，想换个玩法：${a.text}`, 'learned');
        this.d.bus.publish('agenda', 'P2', `回想时想到新玩法：${a.text}`, { kind: a.kind, source: 'strategy' });
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
  private apply(decision: MindDecision, thoughtAboutActivity: string | null, reflectedRecord: ActivityRecord | null = this.lastRecord, info: { urgent?: boolean; nearEnd?: boolean } = {}) {
    this.lastDecision = decision;
    this.notes = decision.notes;
    this.applySkill(decision);
    if (decision.worthLearning) {
      this.safe(() => this.d.onWorthLearning?.(decision.worthLearning!), undefined);
      this.d.bus.publish('worth_learning', 'P3', `觉得值得学：${decision.worthLearning}`);
    }
    this.applyPlan(decision);
    this.guardFocus(decision, thoughtAboutActivity, !!info.urgent);
    // 问的是“这段快干完了，接下来做什么”：写成 activity 的回答当作下一段（排在手上这段之后），不打断快做完的活
    if (info.nearEnd && !info.urgent && decision.activity && !decision.next && ['new', 'adjust', 'continue'].includes(decision.kind)
      && this.activity && this.activity.id === thoughtAboutActivity && this.activity.consecutiveFailures === 0) {
      decision.next = decision.activity;
      delete decision.activity;
      decision.kind = 'continue';
      decision.notes.push(`问的是接下来做什么：「${decision.next.what}」排在「${this.activity.what}」做完之后`);
    }
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
      if (decision.agenda.focus) {
        const item = this.d.self.data.agenda.find((a) => a.id === decision.agenda!.focus);
        if (item && item.kind !== 'goal') decision.notes.push(`「${item.text}」是${item.kind === 'idea' ? '点子' : '疑问'}，不能当主目标：真想做就加成 goal`);
        else this.d.self.setAgendaStatus(decision.agenda.focus, 'active');
      }
    }
    if (decision.next) this.queuedNext = { draft: decision.next, monologue: '', at: Date.now() };

    const sameActivity = !!this.activity && this.activity.id === thoughtAboutActivity;
    if (decision.kind === 'continue') { this.activityThoughtAt = Date.now(); return; }
    const draft = decision.activity;
    if (!draft) return;
    if (decision.kind === 'adjust' && this.activity) {
      if (!sameActivity) { this.staleDropped++; return; } // 对旧活的调整，活已经换了
      const a = this.activity;
      // 做法真的变了（不只是改个数量）：正在做的那一步也停下，马上按新做法来。
      // 以前只改了 routine、等手上这一步自己做完：掉进水里想“游上岸”，手上的 gather 却在水下又挖了两分钟，淹死了
      const changedMethod = signatureOf(a.steps) !== signatureOf(draft.steps);
      if (changedMethod && this.d.arbiter.info()?.planId === a.id) this.d.arbiter.cancel('改了做法');
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
      a.suspendedAt = Date.now();
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

  /** 模型写下的技能：带动作步骤的交给行为引擎（立刻生效），只有做法说明的写进技能书 */
  private applySkill(decision: MindDecision) {
    const raw = decision.skill as Record<string, any> | undefined;
    if (!raw) return;
    const executable = Array.isArray(raw.steps) || raw.when !== undefined || raw.disable === true || raw.disabled === true;
    if (executable) {
      if (!this.d.behaviors) { decision.notes.push('这里没有行为引擎，带步骤的技能存不下'); return; }
      const w = this.safe(() => this.d.behaviors!.write(raw, { by: 'mind' }), { ok: false as const, error: '写技能时出错' });
      if (!w.ok) { decision.notes.push(`skill 没存下：${w.error}`); this.d.bus.publish('skill_rejected', 'P3', `没有保存技能：${w.error}`); return; }
      if (w.disabled) { this.d.self.think(`停用了自己的技能 ${w.name}`, 'learned'); return; }
      if (w.improving) { this.d.self.think(`请后台改进代码技能 ${w.name}（改好会告诉我）`, 'learned'); return; }
      const how = w.mode === 'auto' ? '条件成立时身体会自动做' : w.mode === 'recover' ? '动作失败时身体会先试它' : '可以在 routine 里 use_skill 调用';
      this.d.self.think(`${w.created ? '学会了' : '改进了'}技能 ${w.name}：${how}`, 'learned');
      this.d.bus.publish('skill_written', 'P2', `${w.created ? '写下新技能' : '修订技能'} ${w.name}（${how}）`, { name: w.name, mode: w.mode, live: true });
      return;
    }
    const book = this.d.thinker.skillBook;
    const w = book && typeof raw.name === 'string' && typeof raw.description === 'string' && typeof raw.body === 'string'
      ? this.safe(() => book.write(raw.name, raw.description, raw.body), null) : null;
    if (w?.ok) {
      this.d.self.think(`把「${w.skill.description}」写成了技能 ${w.skill.name}`, 'learned');
      this.d.bus.publish('skill_written', 'P2', `${w.created ? '写下新技能' : '修订技能'} ${w.skill.name}——${w.skill.description}`, { name: w.skill.name, mode: 'knowledge' });
    } else decision.notes.push(`skill 没存下：${w && !w.ok ? w.error : '需要 name、description，以及 steps（可执行）或 body（做法说明）'}`);
  }

  /** 主目标的清单：定下/改写、勾掉做完的项；全勾掉就算主目标完成 */
  private applyPlan(decision: MindDecision) {
    const p = decision.plan;
    if (!p) return;
    const cur = this.d.self.plan();
    if (p.steps?.length) {
      const focus = p.focus ?? cur?.agendaId ?? this.d.self.activeAgenda()?.id ?? p.goal;
      // 模型自己写了 focus（不是沿用手上的活或议程）：它挑中的点子可以升成目标
      const set = focus ? this.d.self.setPlan(focus, p.steps, p.conditions ?? [], { promote: !!p.focus && p.focus === focus }) : null;
      if (set) this.d.bus.publish('plan_set', 'P2', `主目标「${set.goal}」：${set.steps.map((st) => `${st.done ? '☑' : '☐'}${st.text}`).join(' ')}`, { agendaId: set.agendaId });
      else {
        const item = focus?.startsWith('a_') ? this.d.self.agenda().find((a) => a.id === focus) : undefined;
        decision.notes.push(item && item.kind !== 'goal'
          ? `plan 没定下来：${focus}「${item.text.slice(0, 30)}」是${item.kind === 'idea' ? '点子' : '疑问'}，要当主目标就在 plan 里写 focus 和 steps（清单至少一项），或者把 focus 直接写成一句话的目标（会新建一个目标）`
          : focus?.startsWith('a_') && !item ? `plan 没定下来：议程里没有 ${focus}；focus 写议程里某个目标的 id，或者直接写一句话的目标（会新建一个目标），还要有 steps`
          : 'plan 没定下来：focus 写议程里某个目标的 id，或者直接写一句话的目标（会新建一个目标）；还要有 steps（清单至少一项）');
      }
    }
    if (p.done?.length) {
      const s = this.d.adapter.state(), percept = this.safe(() => this.d.perception.snapshot(), undefined);
      const refused: string[] = [];
      const checked = this.d.self.checkPlan(p.done, (c) => evaluateCondition(c, s, s.worldId, [], percept).status === 'satisfied', refused);
      if (checked.length) this.d.bus.publish('plan_check', 'P3', `勾掉：${checked.join('、')}`);
      if (refused.length) decision.notes.push(`没勾掉「${refused.join('、')}」：它的 done_when 条件实际还没达到`);
      const now = this.d.self.plan();
      if (now && now.steps.length && now.steps.every((st) => st.done)) {
        this.d.self.setAgendaStatus(now.agendaId, 'done');
        this.d.self.think(`「${now.goal}」的清单都做完了`, 'outcome');
        this.d.bus.publish('plan_done', 'P2', `主目标完成：${now.goal}`);
      }
    }
  }

  /**
   * 专注：真人不会因为天黑、缺几块木头就忘了自己在盖房子。
   * - 瞥一眼时不能整个换掉手上的事（switch → detour，做完自动回来）；有主目标时认真想也要写 switch_reason 才能换。
   * - 刚开工、还顺利的活，瞥一眼时不马上改做法：改动排在这段做完之后。
   * 要紧的事（危险、快饿死）不受限制。
   */
  private guardFocus(decision: MindDecision, thoughtAboutActivity: string | null, urgent: boolean) {
    const a = this.activity;
    if (!a || urgent || !decision.activity) return;
    // 瞥一眼时不整个换掉手上的事（认真想过就可以换：主目标值不值得，它自己判断）
    if (decision.kind === 'switch' && decision.tier === 'glance') {
      decision.kind = 'detour';
      decision.notes.push(`瞥一眼时不整个换掉手上的事：这次按 detour 处理，做完「${decision.activity.what}」会回到「${a.what}」；真要换就认真想一想`);
      return;
    }
    if (decision.kind === 'adjust' && decision.tier === 'glance' && a.id === thoughtAboutActivity && a.failures === 0
      && Date.now() - this.activityThoughtAt < 25_000 && !this.queuedNext) {
      this.queuedNext = { draft: decision.activity, monologue: decision.monologue, at: Date.now() };
      decision.kind = 'continue';
      decision.notes.push(`「${a.what}」刚开工、还顺利，先不改：你想的「${decision.activity.what}」排在它做完之后`);
    }
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

  /**
   * 操作者在控制台说的话：以“!”“！”“命令”“指令”“必须”“强制”开头的是指令（一直挂着直到做完/做不到）；
   * 其余是建议（想一次，采纳或不采纳都行，之后就放下）。
   */
  suggest(text: string) {
    const raw = text.trim();
    const m = raw.match(/^(?:[!！]+|(?:命令|指令|必须|强制)[:：，,\s]*)/);
    const kind: 'order' | 'suggestion' = m || /强制|命令/.test(raw.slice(0, 12)) ? 'order' : 'suggestion';
    const t = (m ? raw.slice(m[0].length) : raw).trim().slice(0, 200) || raw.slice(0, 200);
    if (this.order) this.d.bus.publish('operator_order_end', 'P3', `新的话替换了旧的：${this.order.text}`, { status: 'replaced' });
    this.order = { text: t, at: Date.now(), status: 'new', nudged: 0, kind };
    this.userSuggestion = null;
    this.backoffUntil = 0;
    if (this.thinking) { this.cancelThinking('new_suggestion'); this.staleDropped++; }
    this.d.bus.publish('user_suggestion', 'P2', `收到操作者的${kind === 'order' ? '指令' : '建议'}：${t}`, { kind });
  }

  /**
   * 心智对指令的回应：done/cannot 就撤下；doing 或者确实换了手上的事就算在照做；
   * 刚收到却只是 continue、也没回应：记一句纠正，再想一次（最多追两次，免得卡住）。
   */
  private answerOrder(order: NonNullable<Mind['order']>, wasNew: boolean, decision: MindDecision) {
    const r = decision.operator;
    // 建议：想过一次就放下（采纳了就变成手上的活，没采纳就算了），不追问、不一直挂着
    if (order.kind === 'suggestion') {
      this.order = null;
      const adopted = r?.status === 'adopted' || r?.status === 'doing' || (!!decision.activity && decision.kind !== 'continue' && r?.status !== 'declined');
      this.d.bus.publish('operator_order_end', 'P3', `操作者的建议${adopted ? '采纳了' : '没采纳'}：${order.text}${r?.note ? `（${r.note}）` : ''}`, { status: adopted ? 'adopted' : 'declined', note: r?.note ?? null });
      return;
    }
    if (r?.status === 'done' || r?.status === 'cannot') {
      this.order = null;
      this.d.bus.publish('operator_order_end', 'P2', `${r.status === 'done' ? '照操作者的指令做完了' : '操作者的指令做不到'}：${order.text}${r.note ? `（${r.note}）` : ''}`, { status: r.status, note: r.note ?? null });
      return;
    }
    const acted = r?.status === 'doing' || (!!decision.activity && decision.kind !== 'continue');
    if (acted) { order.status = 'doing'; return; }
    if (!wasNew) return;
    if (order.nudged >= 2) { order.status = 'doing'; return; }
    order.nudged++;
    decision.notes.push(`操作者的指令「${order.text.slice(0, 60)}」没有照做也没有回应：这一念就把它变成手上的活，并写 operator`);
    this.d.bus.publish('decision_normalized', 'P2', `没回应操作者的指令，再想一次：${order.text.slice(0, 60)}`);
    this.requestThink('操作者的指令还没照做', 'deliberate');
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
      userSuggestion: this.userSuggestion, operatorOrder: this.order, lastFailure: this.lastFailure,
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
        plan: self.plan(),
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
