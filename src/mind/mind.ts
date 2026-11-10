import { isDeepStrictEqual } from 'node:util';
import { shortId } from '../util.ts';
import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step, TaskOutcome } from '../arbiter/arbiter.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { AudienceContext } from '../live/audience.ts';
import { compileBuilding, normalizeSpec } from '../building/spec.ts';
import { KNOW_HOW_LESSON_KEY_PREFIX, type Hazard, type WorldMemory } from '../memory/store.ts';
import { materialPlan } from '../methods/shortfall.ts';
import { durationText, realSecondsToTicks, type Perception, type Percept } from '../perception/perception.ts';
import type { MySkillInfo } from '../planner/prompt.ts';
import { evaluateCondition, observationReady } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import { worldPoint } from '../skills/recovery.ts';
import { causeName } from '../brain/habits.ts';
import { consumptionSummary, toolTierFact } from '../brain/supply.ts';
import { pickFuel } from '../skills/economy.ts';
import { pickVariant } from '../skills/work.ts';
import { afterStep, argsLabel, beginStep, clipFeedback, invalidateNavigation, markContinuation, noteNavigationDispatch, rebindStanceTarget, retargetNavigation, stanceReached, softMiss, createActivity, describeActivity, doneWhenMet, diffInventory, inventoryOf, localStepFailure, nextStep, planCoverageGap, recordOf, remainingSteps, signatureOf, targetKeyOf, viewOf } from './activity.ts';
import { relativeCellAction } from '../skills/stance.ts';
import { instinctNote, type BehaviorEngine } from './behaviors.ts';
import { recallLocal } from './recall.ts';
import { Attention, EXPERIENCE_MS, RECONSIDER, URGENT } from './attention.ts';
import { headInWall } from './predicate.ts';
import { homeOf, myBuilds } from './home.ts';
import { settleBuild } from '../skills/build.ts';
import { myBed } from '../skills/stations.ts';
import { StrategyLog } from './strategy.ts';
import type { ParsedGameMessage } from '../memory/game-messages.ts';
import { NEAR_END_REASON, type MindContext } from './prompt.ts';
import { cleanLesson, cleanPlanStep, moodWords, PLAN_REVISION_MIN, SelfModel } from './self.ts';
import type { LedgerView } from './ledger.ts';
import { LOW_AIR_OXYGEN, type Thinker } from './thinker.ts';
import type { Activity, ActivityDraft, ActivityEnd, ActivityOutcome, ActivityRecord, MindDecision, Noticing } from './types.ts';

export interface MindDeps {
  adapter: GameAdapter; arbiter: Arbiter; perception: Perception; memory: WorldMemory; bus: EventBus;
  thinker: Thinker; self: SelfModel; persona: string;
  mySkills?: () => MySkillInfo[];
  researchContext?: () => unknown;
  /** 主线进度事实（已达成里程碑 + 下一个未达成的目标）：来自 scorecard，只作方向参考，不是硬目标 */
  progress?: () => { reached: number; total: number; done: string[]; next: string | null; branches: { group: string; done: number; total: number; next: string[] }[] };
  audience?: { context(tier?: 'light' | 'full'): AudienceContext | null; buildConsensus?(windowMs?: number): { viewers: number; messages: number; samples: string[] }; clearBuildConsensus?(): void };
  onGoalEnd?: (status: string) => void;
  /** 主目标很久没进展：交给后台想“要做到它还缺什么能力” */
  onGoalStuck?: (goal: string, lines: string[]) => void;
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
/** 无进展闸门用的动作签名：保留具体目标（不同箱子/门算不同做法），专门抓“同一地点/同一路线”的循环。 */
const gateSignatureOf = (steps: Activity['steps']) => steps.map((step) => targetKeyOf(step)).join('>');
const exactSig = (step: { skill: string; args?: unknown }) => {
  const a = step.args && typeof step.args === 'object' ? { ...(step.args as Record<string, unknown>) } : {};
  delete a.facing;
  return `${step.skill} ${JSON.stringify(a)}`;
};
/** 失败原因去掉数字（“还差 53 处”和“还差 50 处”算同一种失败） */
const reasonKey = (summary: string) => summary.replace(/-?\d+(\.\d+)?/g, '#').slice(0, 60);

/** 本来就是在应对怪的动作：挨打时不用叫停 */
const COMBAT = new Set(['defend', 'flee', 'hunt', 'ranged_defend', 'shelter', 'eat', 'use_skill']);
/** 正在做/接着要做这类动作时，工具分级事实才和眼下有关（pillar_one 只垫不挖，不算） */
const DIGGING_SKILLS = new Set(['gather', 'mine_cell', 'excavate_run', 'search_structure', 'build_portal', 'shelter', 'unstuck', 'swim_path', 'build']);

/** 人在水里时靠这些动作出水/换气：停下就是下沉，不能像砌墙那样被挨打叫停 */
const WATER_ESCAPE = new Set(['swim_path', 'boat_path', 'press_keys', 'move']);

export const DEFAULT_TIMING = {
  /** 一段活做了这么久还没抬头想过，就看一眼 */
  checkInMs: 100_000,
  /** 连续只“瞥一眼”这么久，下次就认真想一想全局 */
  deliberateEveryMs: 6 * 60_000,
  /** 完成这么多段活后，可以提前触发一次大图（不必等满 deliberateEveryMs） */
  finishedForReview: 8,
  /** 即使活做得快，两次大图之间也至少隔这么久，防止琐碎活导致频繁认真想 */
  deliberateMinGapMs: 2 * 60_000,
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

/**
 * 心智（取代旧的 Executive）：感知 → 注意 → 思考 → 一段一段地干活 → 回看与学习。
 *
 * - 身体按“活动”的 routine 连续地做，失败时先自己应变（换地方找、再试一次），真卡住了才叫脑子；
 * - 脑子在做事的同时想：快干完时想下一段（并提前写好 next，干完立刻接上），注意到要紧的事时抬头看一眼；
 * - 每段活结束都留下记录（得到了什么、和预想比如何），模型据此写窍门、修正窍门的可信度、给实验下结论；
 * - 情绪（精力/无聊/烦躁/满足/好奇）由真实经历推动，影响它想做什么；议程和日记让它跨越几个小时、重启之后仍接着原来的心思玩。
 */
/**
 * 交给恢复技能的“刚失败的那一步”：除了动作、参数、失败码和一句话，还带上动作自己算出来的目标坐标
 * （比如 goto "NW 20" 实际要去的那一格）和失败时人在哪——以前只有一句话，恢复技能和它的核对都“没有目标坐标”
 */
export function failureFor(step: { skill: string; args?: unknown }, result: { failureCode?: string | null; summary: string; data?: unknown }, pos: { x: number; y: number; z: number }) {
  const d = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
  const blockTarget = d.blockTarget && typeof d.blockTarget === 'object' ? d.blockTarget as Record<string, unknown> : {};
  const target = worldPoint(d.resolvedTarget) ?? worldPoint(d.targetCell) ?? worldPoint(d.target) ?? worldPoint(blockTarget.pos) ?? ((step.skill === 'mine_cell' || step.skill === 'excavate_run') ? worldPoint(d.pos) : undefined);
  return {
    skill: step.skill, args: step.args ?? {}, code: result.failureCode ?? null, summary: clipFeedback(result.summary),
    ...(target ? { target, coordinateFrame: 'world' } : {}),
    ...(Number.isSafeInteger(d.targetId ?? d.entityId) ? { entityId: Number(d.targetId ?? d.entityId) } : {}),
    position: worldPoint(d.position) ?? { ...pos },
    ...(d.waterAhead !== undefined ? { waterAhead: !!d.waterAhead } : {}),
  };
}

const LOCAL_PATH = new Set(['move_step', 'plan_route', 'navigate_to', 'advance', 'travel_to', 'explore_toward', 'go_near']);

export class Mind {
  activity: Activity | null = null;
  suspended: Activity[] = [];
  /** 预排的下一段活；scope/epoch 记录它是按哪个世界、维度、会话和决定批次想的。 */
  queuedNext: { draft: ActivityDraft; monologue: string; at: number; scope?: { worldId: string; dim: string; sessionId: string }; epoch?: number } | null = null;
  paused = false;
  staleDropped = 0;
  readonly attention = new Attention();
  lastDecision: MindDecision | null = null;
  private timing: typeof DEFAULT_TIMING;
  private generation = 0;
  /** 作用域决定批次：换世界/维度/会话时递增，旧批次回来的决定和预排 next 一并失效。 */
  private decisionEpoch = 0;
  private thinking: { controller: AbortController; reason: string; tier: 'glance' | 'deliberate'; startedAt: number; generation: number; epoch: number; activityId: string | null; noticed: Noticing[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listening = false;
  private suspendedBy = new Set<string>();
  private lastSession = '';
  /** 这次进程里是否已经观测到「活着」（spawn 且生命值 >0）：区分「首次启动还没刷出生命值」和「真死了」 */
  private seenAlive = false;
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
  /** 近期动作失败的实际反馈，只在同一会话、附近再次决策时提供。 */
  private recentActionFailures: { step: Step; code: string | null; summary: string; pos: AgentState['pos']; worldId: string; sessionId: string; dim: string; at: number; scope?: 'step'; implication?: string }[] = [];
  /** 近期动作成功但附带、要心智掂量的事实（如挖到人造建材），同样只在同一会话、附近决策时提供。 */
  private recentActionCaveats: { step: Step; caveat: string; pos: AgentState['pos']; worldId: string; sessionId: string; dim: string; at: number }[] = [];
  /** 同一个动作、同样的参数、同样的失败：记录次数，供心智参考。 */
  private sameFails = new Map<string, { n: number; last: number; code: string; why: string; summary: string }>();
  private lastStuckAttempt: { step: { skill: string; args?: unknown }; code: string; summary: string; pos: AgentState['pos']; worldId: string; sessionId: string; dim: string; at: number } | null = null;
  private lastLocalRecoveryNoticeAt = 0;
  static readonly SAME_FAIL_LIMIT = 3;
  static readonly SAME_FAIL_MS = 10 * 60_000;
  private learnedActivities = new Set<string>();
  private speechEventAt = 0;
  private fillerAt = 0;
  /** 自动续跑沿用的原动作期限：到点取消本次执行，不许换一个新 taskId 重新获得完整超时。 */
  private stepExpiry: { taskId: string; timer: NodeJS.Timeout } | null = null;
  private gameMessages: { at: number; text: string }[] = [];
  private deathAt = 0;
  private deathTold = false;
  private readonly startedAt = Date.now();
  /** 在线观察的计时基点只留在内存，累计值由 SelfModel 持久化。 */
  private onlineSince: number | null = null;
  private lastGameSample: { ticks: number; worldId: string; sessionId: string } | null = null;
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
  private reflexWaiting: { taskId: string; activity: Activity; baseline: AgentState } | null = null;
  private reflexDuringThought: { controller: AbortController; summary: string } | null = null;
  private lastSay = { at: 0, text: '' };
  private lastDiaryAt = 0;
  private finishedSinceReflect = 0;
  private activityThoughtAt = 0;
  private pendingReason: { reason: string; tier: 'glance' | 'deliberate' } | null = null;
  /** 正在等的“阶段回顾”：情绪（腻了、烦了）或回想提醒它停下来看看这一阶段在做什么 */
  private review: { at: number; why: string } | null = null;
  private lastReviewAt = 0;
  /** 这一念是阶段回顾：只有这时（或主目标停滞）才允许换主目标 */
  private inReview = false;
  /** 回想时觉得主目标可以放下了：留到下一次阶段回顾时告诉它 */
  private keptHint: string | null = null;
  /**
   * 主目标级无进展闸门：连续若干段活没有物品、清单或新区块进展时，强制换一个
   * 能带来新信息的做法。它只阻止重复已试过的动作签名，不替 Agent 选去哪/做什么。
   */
  private progressGate: { at: number; agendaId: string | null; signatures: string[]; activities: { what: string; outcome: string; summary: string }[] } | null = null;
  private progressGateRejects = 0;
  private lastProgressGateAt = 0;
  private noProgressRuns: { at: number; signature: string; sourceKey?: string; what: string; outcome: string; summary: string }[] = [];
  /** 最近一次局部动作/落点失败：它只否定这一步，不能单独证明整个来源或维度没有资源。 */
  private lastLocalFailure: { at: number; skill: string; code: string | null; summary: string; worldId: string; sessionId: string; dim: string; pos: { x: number; y: number; z: number }; chunks?: number } | null = null;
  /** 最近一次被证据放行的换维：只记来源/目标/理由；目标未知时等实际换维后再补上。 */
  private lastSourceSwitch: { at: number; from: string; to: string | null; reason: string; worldId: string; sessionId: string } | null = null;
  /** 最近一次实测新区块进展：只记区域标识与新区块数，不复制格点/几何。 */
  private lastRegionExpansion: { at: number; region: string; chunks: number; dim: string; worldId: string; sessionId: string } | null = null;
  /** 拒绝计数只针对同一次局部失败：拒绝一次后，同一次失败的第二次尝试直接放行。 */
  private sourceSwitchRejects = 0;
  /** 计数所属的失败时间；换了新的局部失败，重新给一次“先重想”的机会。 */
  private sourceSwitchRejectAt = 0;
  static readonly PROGRESS_GATE_ACTIVITIES = 8;
  static readonly PROGRESS_GATE_COOLDOWN_MS = 10 * 60_000;
  static readonly PROGRESS_GATE_REJECT_LIMIT = 2;
  static readonly LOCAL_FAILURE_TTL_MS = 10 * 60_000;
  /** 搜索状态（无进展、局部失败、换维/换区证据）跨轮次保留的上限；过期恢复不再冒充当前状态。 */
  static readonly SEARCH_STATE_TTL_MS = 30 * 60_000;
  /** 两次因为情绪的阶段回顾至少隔多久（每次在这个范围里随机）：情绪只是提醒，不能一烦就换目标 */
  static REVIEW_GAP_MIN: [number, number] = [45, 90];
  private reviewGapMs = 45 * 60_000;
  /** 情绪到多少才提醒回顾 */
  static BORED_REVIEW = 0.75;
  static FED_UP_REVIEW = 0.65;
  /** 游戏里现在是第几天（感知时更新） */
  private gameDay = NaN;
  /** 每段活最多提前规划一次，避免动作还在运行时反复追问。 */
  private nearEndAskedFor: string | null = null;
  private waitingSince: number | null = null;
  /** 干等时无聊到多少就想想“这段时间能做点什么” */
  static BORED_AT = 0.6;
  static NEAR_END_AFTER_MS = 15_000;
  static NEAR_END_REASON = NEAR_END_REASON;
  /** 要命的处境（窒息、被贴身围攻、水下没气）：用“瞥一眼”那档快速拿主意，几秒都等不起 */
  static DANGER_REASON = '有危险，马上拿主意';
  private lastHurtEventAt = 0;
  /** 危险还在的这段时间里，等想法时不让身体去张望、捡东西 */
  private dangerUntil = 0;
  /** 刚从绕路回到这段活：先想一想再动手（放下它的这段时间里情况可能变了，比如等的东西到了、要的已经够了） */
  private resumeCheck: string | null = null;
  private lastDim: string | null = null;
  /** 后台预取的长期记忆缓存：deliberate 触发预取、下一次 deliberate 用（间隔 2-6min，新鲜期要覆盖） */
  private hindsightMemories: { at: number; items: { text: string; kind: 'experience' | 'inference' }[] } | null = null;
  private hindsightPrefetching = false;
  static readonly HINDSIGHT_FRESH_MS = 10 * 60_000;

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
  /** 这一趟下地：从哪一刻起头顶没了天空、当时背包有什么。回到地面就清掉（给“下矿的账”算这趟花了多久、挖到了什么） */
  private trip: { since: number; inventory: Record<string, number> } | null = null;
  private skillOpenedAt = new Map<string, number>();
  /** 上次展示的工具分级事实签名与时间：同状态不每念重复，状态变了或过了 10 分钟才再说 */
  private toolFactKey: string | null = null;
  private toolFactAt = 0;
  static readonly TOOL_FACT_REPEAT_MS = 10 * 60_000;
  /** 两次投放之间的最小间隔：状态签名来回跳（例如主手在镐/斧之间换）时不至于每念重发 */
  static readonly TOOL_FACT_MIN_GAP_MS = 30_000;

  constructor(private d: MindDeps) {
    this.timing = { ...DEFAULT_TIMING, ...(d.timing ?? {}) };
    const state = d.adapter.state();
    d.memory.setWorld(state.worldId);
    d.thinker.skillStats = (name) => d.behaviors?.statsOf(name);
    d.thinker.successfulEmergencyVersions = (name) => d.behaviors?.successfulEmergencyVersions(name) ?? [];
    // 任务事实跨重连保留，但过期的、别世界/会话的不能直接拿来判当前做法。
    const facts = d.self.taskFacts();
    const now = Date.now();
    const recent = <T extends { at: number; worldId: string; sessionId: string }>(fact: T | null | undefined) =>
      fact && now - fact.at < Mind.SEARCH_STATE_TTL_MS && fact.worldId === state.worldId && fact.sessionId === state.sessionId ? fact : null;
    this.noProgressRuns = (facts.noProgressRuns ?? []).filter((run) => now - run.at < 30 * 60_000).slice(-16);
    const failure = facts.lastLocalFailure;
    this.lastLocalFailure = failure && now - failure.at < Mind.LOCAL_FAILURE_TTL_MS
      && failure.worldId === state.worldId && failure.sessionId === state.sessionId ? failure : null;
    this.lastSourceSwitch = recent(facts.lastSourceSwitch);
    this.lastRegionExpansion = recent(facts.lastRegionExpansion);
  }

  private persistTaskFacts() {
    this.d.self.setTaskFacts({
      noProgressRuns: this.noProgressRuns.slice(-16),
      lastLocalFailure: this.lastLocalFailure,
      lastSourceSwitch: this.lastSourceSwitch,
      lastRegionExpansion: this.lastRegionExpansion,
    });
  }

  get inFlight() { return !!this.thinking; }
  get autonomous() { return this.d.thinker.autonomous; }

  private setObservedOnline(online: boolean, now = Date.now()) {
    this.d.self.setOnline(online, now);
    if (online && this.onlineSince === null) {
      this.onlineSince = now;
    }
    else if (!online && this.onlineSince !== null) {
      this.onlineSince = null;
      this.lastGameSample = null;
      this.recentEnds = [];
      this.attention.resetLoop();
    }
  }

  private observePlanGameTime(p: Percept) {
    const plan = this.d.self.plan();
    const current = this.d.self.observedProgress() ?? { planId: null, planGameTicks: 0, planObservedSince: null };
    const changed = current.planId !== (plan?.agendaId ?? null);
    const next = { ...current, planId: plan?.agendaId ?? null, planGameTicks: changed ? 0 : current.planGameTicks,
      planObservedSince: changed ? Date.now() : current.planObservedSince };
    if (changed) {
      this.lastGameSample = null;
    }
    if (!plan || !Number.isFinite(p.time.day) || !Number.isFinite(p.time.timeOfDay)) {
      if (changed) this.d.self.setObservedProgress(next);
      return;
    }
    const state = this.d.adapter.state();
    const sample = { ticks: p.time.day! * 24000 + ((p.time.timeOfDay % 24000) + 24000) % 24000, worldId: state.worldId, sessionId: state.sessionId };
    if (this.onlineSince !== null && this.lastGameSample?.worldId === sample.worldId && this.lastGameSample.sessionId === sample.sessionId)
      next.planGameTicks += Math.max(0, sample.ticks - this.lastGameSample.ticks);
    this.lastGameSample = this.onlineSince === null ? null : sample;
    if (changed || next.planGameTicks !== current.planGameTicks) this.d.self.setObservedProgress(next);
  }

  // ---------------------------------------------------------------- 生命周期
  private doneListener = (o: TaskOutcome) => this.onDone(o);
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
      this.d.bus.on('event', this.eventListener);
      this.listening = true;
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    this.setObservedOnline(false);
    this.clearStepExpiry();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelThinking('shutdown');
    this.reflecting?.abort('shutdown');
    this.reflecting = null;
    if (this.listening) {
      this.d.arbiter.off('done', this.doneListener);
      this.d.bus.off('event', this.eventListener);
      this.listening = false;
    }
    this.d.self.flush();
  }

  // ---------------------------------------------------------------- 主循环
  tick() {
    const state = this.d.adapter.state();
    this.setObservedOnline(observationReady(state) && !this.paused);
    const task = this.d.arbiter.info();
    const travelling = !!task && ['travel_portal', 'recall_portal'].includes(task.skill);
    if (travelling && !observationReady(state)) return; // 传送技能自己等落地
    if (!observationReady(state)) {
      // 首次启动还没刷出生命值（alive 仍是 false）不算死亡：不打扰，等 spawn 后直接接着上次的议程。
      // 连着的时候观测暂时不可用（换维度、区块没加载完）不是断线：连接还在，等世界就绪后按实际变化继续判断。
      if (this.seenAlive && !state.connected) this.suspend('disconnected');
      else if (this.seenAlive && !state.alive) this.suspend('death');
      return;
    }
    this.seenAlive = true;
    this.d.memory.setWorld(state.worldId);
    const sessionChanged = !!this.lastSession && this.lastSession !== state.sessionId;
    // 换作用域后，在途思考和预排 next 都绑定旧世界的观察/坐标，先作废；重新评估后才启动。
    // 主动 travel_portal 与非预期传送都适用：跨维度的下一步应在到达后按新位置重新确认。
    if (sessionChanged) {
      this.decisionEpoch++;
      if (this.queuedNext) {
        this.d.bus.publish('decision_stale', 'P3', `换了地方，提前排好的「${this.queuedNext.draft.what}」先作废，等按新位置重新确认`, { was: this.queuedNext.draft.what, scope: this.queuedNext.scope });
        this.queuedNext = null;
      }
    }
    if (sessionChanged && !travelling) {
      // 换了世界/维度：手上的活里的坐标都不再适用；穿门前本来在做什么先记下，落地后接着做或改主意，别一脸懵又穿回去
      const was = this.activity?.what?.slice(0, 60);
      this.dropActivity('interrupted', '换了世界/维度，重新看看周围');
      this.suspended = [];
      this.recentEnds = [];
      this.failuresByTarget.clear();
      this.attention.reset();
      this.cancelThinking('session_changed');
      this.requestThink(was ? `换了个地方（穿门前本来在做「${was}」），重新看看周围接着办` : '换了个地方，重新看看周围', 'deliberate');
    }
    if (this.lastDim !== state.dim) {
      // 维度变化：当前导航仍是旧维度的目标与 route handle，先作废 handle 并按实测位置重规划。
      if (this.activity?.navigation && this.activity.navigation.dim !== state.dim) {
        invalidateNavigation(this.activity, `换了维度（${this.activity.navigation.dim} → ${state.dim}）`, state);
      }
      // 带证据放行的换维真正发生后，补上实际目标维度与当前会话；仍只记来源/目标，不复制空间历史。
      if (this.lastSourceSwitch && this.lastSourceSwitch.from === this.lastDim
        && Date.now() - this.lastSourceSwitch.at < Mind.SEARCH_STATE_TTL_MS) {
        this.lastSourceSwitch = { ...this.lastSourceSwitch, to: state.dim, sessionId: state.sessionId };
        this.persistTaskFacts();
      }
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

  /**
   * 眼下要命的处境：只说身体此刻感觉得到的事实和能做的选择，不替它做决定。
   * - 头那一格是实心方块、刚掉过血：窒息
   * - 近战怪贴身（3 格内）、刚挨过打：被围攻（已经在战斗动作里时，血不多才再报）
   * - 在水下、氧气快没了：溺水
   */
  private sensedDanger(p: Percept): { key: string; what: string }[] {
    const s = this.d.adapter.state(), hp = Math.round(s.hp * 10) / 10;
    const hurtRecently = Date.now() - this.lastHurtEventAt <= 3000;
    const out: { key: string; what: string }[] = [];
    const head = this.safe(() => this.d.adapter.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1.62), z: Math.floor(s.pos.z) }), null);
    if (hurtRecently && headInWall(head)) {
      out.push({ key: 'danger:suffocate', what: `头被 ${head} 埋住了，正在窒息掉血（血 ${hp}）` });
    }
    if (s.inWater && s.oxygen <= 5) out.push({ key: 'danger:drown', what: `在水下快没气了（氧气 ${s.oxygen}/20，血 ${hp}）` });
    // 已经在打/逃/躲的时候不必每 4 秒再打断一次；其余时候被贴身打本身就是该马上知道的事实
    const cur = this.d.arbiter.info();
    const handling = !!cur && ['defend', 'guard', 'flee', 'ranged_defend', 'hunt', 'shelter'].includes(cur.skill);
    const close = p.nearby.hostile.filter((h) => h.dist <= 3 && h.name !== 'creeper');
    if (close.length && hurtRecently && (!handling || hp <= 12)) {
      out.push({ key: 'danger:melee', what: `被 ${close.map((h) => `${h.name} ${h.dist}格`).join('、')} 贴身打（血 ${hp}）` });
    }
    return out;
  }

  private perceive() {
    this.lastPerceptAt = Date.now();
    let p: Percept;
    try { p = this.d.perception.update(); } catch { return; }
    const loop = this.attention.fromLoop(this.recentEnds, this.d.adapter.state().pos);
    const dangers = this.safe(() => this.sensedDanger(p), []).map((d) => this.attention.notice(d.key, d.what, 0.9, 4000)).filter((n): n is NonNullable<typeof n> => !!n);
    if (dangers.length) this.dangerUntil = Date.now() + 6000;
    for (const n of [...dangers, ...this.attention.fromPercept(p, Date.now(), this.d.self.habits().pickup), ...(loop ? [loop] : [])]) {
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
      const n = this.attention.notice('bored_waiting', `已经干等了${waited}（现实时间），好无聊：这段时间能做点什么？`, 0.62, 4 * 60_000);
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
    this.observePlanGameTime(p);
    this.gameDay = p.time.day ?? NaN;
    this.d.self.notePlanDay(this.gameDay);
    this.safe(() => this.stageReviewCheck(), undefined);
    if (this.activity?.kind === 'rest') this.maybeReflect('歇下来了');
    else if (Date.now() - Math.max(this.d.self.reflectedAt, this.startedAt) > 60 * 60_000) this.maybeReflect('玩了好一阵了');
  }

  private decideWhetherToThink(current: ReturnType<Arbiter['info']>) {
    if (Date.now() < this.backoffUntil) return;
    const urgentNow = this.attention.highest() >= URGENT;
    const danger = this.attention.peek().some((n) => n.key.startsWith('danger:'));
    // 水位低氧时认真想也会被 think() 降成瞥一眼；这里照样算出来，免得“瞥一眼升级成认真想”的分支
    // 每一拍都把刚发出的瞥一眼撤掉再重发，没等回答就自己转个不停。
    const s = this.d.adapter.state();
    const lowAir = s.inWater && s.oxygen < LOW_AIR_OXYGEN;
    if (this.thinking) {
      // 要命的时候不等慢慢想完：撤掉正在想的，马上快想一次
      if (danger && this.thinking.reason !== Mind.DANGER_REASON) { this.cancelThinking('danger'); this.staleDropped++; }
      // 正在“瞥一眼”时出了要紧的事：改成认真想（水位低氧时升级不了，继续等这一次瞥一眼）
      else if (urgentNow && !danger && !lowAir && this.thinking.tier === 'glance') { this.cancelThinking('urgent'); this.staleDropped++; }
      else return;
    }
    if (danger) return this.think(Mind.DANGER_REASON, 'glance');
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
    // 刚开始的一步先执行一会儿；普通掉落物暂存到下一次思考，不影响其他注意事项。
    const youngStep = current?.planId === this.activity.id && Date.now() - current.startedAt < Mind.NEAR_END_AFTER_MS;
    const reconsider = this.attention.peek().some((n) => n.salience >= RECONSIDER && (!youngStep || !n.key.startsWith('drops:')));
    if (!resting && gapOk && reconsider) return this.think('注意到了一些事', 'glance');
    // 最后一步仍在执行、结果未知：可以提前想下一段，不把它当成已经完成。
    if (!this.queuedNext && this.nearEndAskedFor !== this.activity.id && current?.planId === this.activity.id
      && remainingSteps(this.activity) === 0 && Date.now() - current.startedAt >= Mind.NEAR_END_AFTER_MS) {
      this.nearEndAskedFor = this.activity.id;
      return this.think(Mind.NEAR_END_REASON, 'glance');
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
    const stall = this.d.self.planStallInfo();
    if (stall.minutes < 30 || acts.length < 8) return;
    this.d.onGoalStuck(plan.goal, [
      `目标：${plan.goal}（距制定 ${Math.round((Date.now() - plan.setAt) / 60_000)} 现实分钟，包含离线；已观察到${stall.historyUnknown ? '至少 ' : ' '}${Math.round(stall.minutes)} 在线分钟没勾掉一项${stall.historyUnknown ? '，更早的在线时长未知' : ''}）`,
      `清单：${plan.steps.map((st, i) => `${i}.[${st.done ? 'x' : ' '}] ${st.text}`).join(' ')}`,
      ...acts.slice(-20).map((r) => `${r.what} → ${r.outcome}：${r.summary.slice(0, 180)}`),
    ]);
  }

  /**
   * 情绪和目标联动：腻了、烦了（或回想觉得主目标可以放下），而且事情不是正顺利——
   * 主目标很久没勾掉一项，就停下来认真回顾一次阶段目标。
   * 回顾只是给它看事实、让它自己决定换不换；平时一时的想法换不掉主目标（见 SelfModel.goalSwitchRefusal）。
   */
  private stageReviewCheck(now = Date.now()) {
    if (this.review) { if (now - this.review.at > 10 * 60_000) this.review = null; return; }
    if (now < this.dangerUntil || this.order) return;
    const s = this.d.adapter.state();
    if (s.hp < 8) return; // 保命要紧，先别想阶段的事
    const plan = this.d.self.plan();
    const days = (this.d.self.observedProgress()?.planGameTicks ?? 0) / 24000;
    // 1) 主目标过了好几个游戏天（3–5 天里随机）还没做成：回顾一次，别一直钻牛角尖
    const overdue = !!plan && plan.reviewDays !== undefined && days >= plan.reviewDays;
    // 2) 情绪提醒：腻透了或烦透了，而且确实没进展（主目标停滞）；
    //    目标至少做了一天、离上次回顾够久，才提醒——情绪会起伏，不能一烦就换
    const m = this.d.self.mood;
    const bored = m.boredom >= Mind.BORED_REVIEW, fed = m.frustration >= Mind.FED_UP_REVIEW;
    const stall = this.d.self.planStallInfo(now);
    const stalledMin = stall.minutes;
    const stale = !plan || stalledMin >= SelfModel.STALL_MIN;
    const moody = (bored || fed || !!this.keptHint) && stale && (!plan || days >= 1) && now - this.lastReviewAt >= this.reviewGapMs;
    // 3) 卡住：最近几段活反复卡住/没做成——不是单纯没进展，是这条路真做不成；早一点给回顾的机会换思路或换目标
    const since = plan?.progressAt ?? plan?.setAt ?? 0;
    const recent = this.d.self.history(40).filter((r) => r.at > since);
    const stuckRuns = recent.filter((r) => r.outcome === 'stuck' || r.outcome === 'unmet').length;
    const stuck = !!plan && recent.length >= 6 && stuckRuns >= 3 && now - this.lastReviewAt >= this.reviewGapMs;
    if (!overdue && !moody && !stuck) return;
    const why = [overdue ? `已观察到主目标经过 ${Math.floor(days)} 个游戏天，仍未做成（更早未观察时间未知）` : '', bored ? '好无聊' : '', fed ? '很烦躁' : '',
      plan && stalledMin >= SelfModel.STALL_MIN ? `已观察到${stall.historyUnknown ? '至少 ' : ' '}${Math.round(stalledMin)} 在线分钟没勾掉一项${stall.historyUnknown ? '，更早的在线时长未知' : ''}` : '',
      stuck ? `最近 ${recent.length} 段活里卡住/没做成 ${stuckRuns} 段` : '',
      this.keptHint ? '回想时觉得主目标可以放下了' : ''].filter(Boolean).join('、');
    this.review = { at: now, why };
    this.d.bus.publish('stage_review', 'P2', `停下来回顾阶段目标：${why}`, { boredom: m.boredom, frustration: m.frustration, days, stalledMin: Math.round(stalledMin) });
    this.requestThink(`${why}：停下来想想这一阶段到底在做什么，要不要换个阶段目标`, 'deliberate');
  }

  /** 阶段回顾时给模型看的事实：这一阶段做了多久、前几个阶段目标、游戏进度、搁着的想法 */
  private stageReviewFacts(now = Date.now()): Record<string, unknown> {
    const plan = this.d.self.plan();
    const min = (ms: number) => Math.round(ms / 60_000);
    const outcome = { done: '做完', dropped: '放下', switched: '换掉' } as const;
    return {
      why: this.review?.why ?? '',
      feeling: moodWords(this.d.self.mood),
      ...(plan ? { current: `「${plan.goal}」制定至今世界日期相差 ${Math.floor(this.d.self.planDays(this.gameDay))} 个游戏天，包含未观察时段；已观察到至少 ${Math.floor((this.d.self.observedProgress()?.planGameTicks ?? 0) / 24000)} 个游戏天；已观察到${this.d.self.planStallInfo(now).historyUnknown ? '至少 ' : ' '}${Math.round(this.d.self.planStalledMin(now))} 在线分钟没勾掉一项，清单 ${plan.steps.filter((st) => st.done).length}/${plan.steps.length}` } : { current: '没有主目标' }),
      recent_stages: this.d.self.stages(6).map((r) => `「${r.goal.slice(0, 40)}」${min(r.endAt - r.setAt)} 现实分钟 → ${outcome[r.outcome]}（${r.stepsDone}/${r.steps}）`),
      ideas_waiting: this.d.self.agenda().filter((a) => a.status !== 'active').slice(-6).map((a) => `${a.id} ${a.kind === 'goal' ? '目标' : a.kind === 'idea' ? '点子' : '疑问'}：${a.text.slice(0, 40)}`),
      ...(this.keptHint ? { reflection: this.keptHint } : {}),
      how: '情绪在提醒你停下来看看：recent_stages 是不是一直在同一类事上打转，手上的东西够不够去做。'
        + '值得接着做就 continue；想换就写 plan {"focus":"议程 id 或一句话的新目标","steps":[3–6 项],"switch_reason":"为什么"}。'
        + '新的主目标是这一阶段要拿到的成果，不是过夜、清包、补工具这类眼前事；平时一时的想法换不掉主目标，这种回顾时才能换。',
    };
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

  /** 需要看看全局了吗：好久没认真想过、做完了好几段活、情绪到了临界、刚卡住 */
  private needsBigPicture(): boolean {
    const m = this.d.self.mood;
    const since = Date.now() - this.lastDeliberateAt;
    return since > this.timing.deliberateEveryMs
      || (this.finishedSinceReflect >= this.timing.finishedForReview && since > this.timing.deliberateMinGapMs)
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
      // 预排的 next 绑定排它时的世界/维度/会话和决定批次；换了地方或批次作废就不能直接接着做。
      const current = this.d.adapter.state();
      const stale = (q.epoch !== undefined && q.epoch !== this.decisionEpoch)
        || (q.scope !== undefined && (q.scope.worldId !== current.worldId || q.scope.dim !== current.dim || q.scope.sessionId !== current.sessionId));
      if (stale) {
        this.d.bus.publish('decision_stale', 'P2', `提前想好的「${q.draft.what}」是在旧作用域排的（${q.scope?.dim ?? '?'}/${q.scope?.sessionId ?? '?'}），现在（${current.dim}/${current.sessionId}）不能直接接着做`, { was: q.draft.what, scope: q.scope ?? null });
        this.requestThink(`提前想好的「${q.draft.what}」是在换地方之前排的，坐标和前提可能已变；先按当前位置重新确认再决定`, 'deliberate');
        return;
      }
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
    // 局部恢复只作为事实提醒，不拦截 Agent 已明确选择的新一步；否则“先往东挪一格”
    // 这类合法尝试会被同一位置的历史失败误伤，反而把行动锁死。
    const localFails = this.localPathFailures(this.d.adapter.state());
    if (localFails.length >= 3 && LOCAL_PATH.has(step.skill) && Date.now() - this.lastLocalRecoveryNoticeAt > 30_000) {
      this.lastLocalRecoveryNoticeAt = Date.now();
      const last = localFails[localFails.length - 1]!;
      this.d.bus.publish('notice', 'P2', `同一位置附近已经 ${localFails.length} 次移动/规划失败（最近：${last.summary}）；仍按你这次的选择执行，若失败再考虑观察/施工/换目标/下行`, { skill: step.skill, count: localFails.length });
    }
    // 上一步移动未确认到达：本步校验后若为相对挖掘/放置，报告依赖缺口，不执行本步。
    const gap = this.activity.stanceGap;
    if (gap) {
      const v = this.d.arbiter.validate(step);
      if (!v.ok) {
        // 校验失败/被拒绝的步骤不会执行，不能消费尚未处理的站位缺口，留给后续步骤。
      } else if (relativeCellAction(step.skill, v.args)) {
        // 放置的站位副作用改变了相对坐标原点。若相对目标按“上一动作开始前的锚点”解释，
        // 正好落在本次确认的支撑脚位上，就显式重绑定到该绝对落点；否则交回需要重绑定的缺口。
        const rebound = step.skill === 'move_step' ? this.rebindStanceStep(step, v.args, gap) : null;
        if (rebound?.kind === 'reached') {
          // 边缘放置已经把身体带到本次支撑的脚位：这一步相对移动的世界目标已经达成，不再移动。
          delete this.activity.stanceGap;
          const body = this.d.adapter.state();
          this.d.bus.publish('body_adapt', 'P2', `「${gap.skill}」的站位副作用已经把身体带到本次支撑的脚位 (${rebound.target.x},${rebound.target.y},${rebound.target.z})；接着的相对移动目标已达成，不再移动`, { planId: this.activity.id, skill: step.skill, target: rebound.target });
          this.activity.results.push({ skill: step.skill, args: step.args, status: 'succeeded', summary: '站位副作用已达成该相对移动的目标，不再移动', at: Date.now(), durationMs: 0, pos: { ...body.pos } });
          this.activity.consecutiveFailures = 0;
          return;
        }
        if (rebound) {
          delete this.activity.stanceGap;
          this.d.bus.publish('body_adapt', 'P2', `「${gap.skill}」改变了站位；下一步仍按原锚点去本次支撑的脚位 (${rebound.target.x},${rebound.target.y},${rebound.target.z})`, { planId: this.activity.id, skill: step.skill, from: rebound.from, target: rebound.target });
        } else {
          const intended = gap.intendedStandTarget;
          const hint = intended
            ? `；本次支撑形成的脚位是 (${intended.x},${intended.y},${intended.z})，下一步用 {"xyz":[${intended.x},${intended.y},${intended.z}]} 明确指向它`
            : '；先确认实际站位或改用绝对坐标';
          this.finishActivity('stuck', `「${gap.skill}」改变了站位，身体现在在 (${gap.pos.x.toFixed(2)},${gap.pos.y.toFixed(2)},${gap.pos.z.toFixed(2)})；接着的「${step.skill}」是相对坐标，按新位置会打到别的格${hint}。已确认的放置/支撑效果保留`);
          return;
        }
      } else {
        delete this.activity.stanceGap;
      }
    }
    // 提醒曾经失败，仍执行 Agent 明确选择的动作。
    const same = this.sameFails.get(exactSig(step));
    if (same && same.n >= Mind.SAME_FAIL_LIMIT && Date.now() - same.last < Mind.SAME_FAIL_MS) {
      this.d.bus.publish('notice', 'P2', `「${step.skill}」相同参数（不含朝向）的动作此前出现 ${same.n} 次同类失败（${same.summary}），仍按选择执行`, { skill: step.skill });
    }
    const state = this.d.adapter.state();
    this.activity.stepStart = { pos: { ...state.pos }, view: viewOf(this.safe(() => this.d.perception.snapshot(), undefined)) };
    const skill = SKILLS[step.skill];
    // 逻辑动作的模板（带稳定 id）：期限与材料账本按它记录；动作回执里的规范化参数不能当模板。
    const template = this.activity.steps[Math.max(0, this.activity.index - 1)] ?? step;
    const budget = skill ? beginStep(this.activity, template, state) : undefined;
    if (budget && budget.remainingMs <= 0) {
      this.finishActivity('stuck', `「${step.skill}」的自动重试沿用原动作期限，现在已经到期；没有用新的超时重来，下一步由你决定`);
      return;
    }
    // 下一段开始前复核实测位置；父期限只做快照展示，实际门禁仍是 beginStep/stepExpiry 账本。
    noteNavigationDispatch(this.activity, template, state, budget ? { deadlineMs: budget.deadlineMs } : {});
    // 自动续跑的绝对期限只走调度预算 meta.deadlineMs，不改写技能参数：
    // 参数注入会被 use_skill 等严格校验器当成未知字段拒绝，也不该混进动作记录。
    const dispatch = step;
    // 额外的 deadlineMs 只在自动续跑时出现；新的显式委托不传，Arbiter 仍按技能自身 timeout 起算。
    const schedule: Parameters<Arbiter['start']>[2] & { deadlineMs?: number } = {
      planId: this.activity.id,
      ...(step.id ? { stepId: step.id } : {}),
      ...(step.origin ? { origin: step.origin } : {}),
      ...(step.authorizedBy ? { authorizedBy: step.authorizedBy } : {}),
      ...(budget?.continuation ? { deadlineMs: budget.deadlineMs } : {}),
    };
    const r = this.d.arbiter.start(dispatch, this.activity.source === 'rule' ? 'rule' : 'llm', schedule);
    if ('error' in r) this.handleStepResult(step, { status: 'failed', failureCode: 'BAD_ARGS', summary: r.error }, 0);
    else if (budget?.continuation) this.watchStepDeadline(r.id, step.skill, budget.deadlineMs);
  }

  /**
   * 放置的站位副作用换了相对坐标原点后，用上一动作开始前的锚点重解释下一步相对动作。
   * 只有按旧锚点算出的世界目标正好是本次确认的支撑脚位时才重绑定；不替 Agent 猜别的落点。
   * 重绑定后的绝对目标仍走一遍执行前预检，不绕过距离/净空检查。
   */
  private rebindStanceStep(step: Step, args: unknown, gap: NonNullable<Activity['stanceGap']>) {
    const a = this.activity;
    if (!a) return null;
    const rebound = rebindStanceTarget(args, gap);
    if (!rebound) return null;
    const target = { x: rebound.xyz[0], y: rebound.xyz[1], z: rebound.xyz[2] };
    // 放置的副作用可能已经把身体带到目标脚位；这时这一步已经没有要走的距离。
    if (stanceReached(this.d.adapter.state().pos, target)) return { kind: 'reached' as const, target };
    const reboundArgs = { xyz: rebound.xyz, facing: rebound.facing };
    if (!this.d.arbiter.validate({ skill: step.skill, args: reboundArgs }).ok) return null;
    const own = a.steps[Math.max(0, a.index - 1)];
    const originalArgs = own?.args;
    step.args = reboundArgs;
    if (own && own.skill === step.skill && own.args !== reboundArgs) {
      own.args = reboundArgs;
      own.origin = 'execution_helper';
      own.authorizedBy = { skill: step.skill, ...(own.id ? { stepId: own.id } : {}), args: originalArgs };
    }
    return { kind: 'rebound' as const, from: rebound.from, target };
  }

  /** 自动续跑到原动作期限就取消本次执行；不延长，也不让新 taskId 重新计时。 */
  private watchStepDeadline(taskId: string, skill: string, deadlineMs: number) {
    this.clearStepExpiry();
    this.stepExpiry = {
      taskId,
      timer: setTimeout(() => {
        this.stepExpiry = null;
        if (this.d.arbiter.info()?.id !== taskId) return;
        this.d.bus.publish('body_adapt', 'P1', `「${skill}」自动续跑沿用的原动作期限已到，取消本次执行`, { planId: this.activity?.id ?? null, skill });
        this.d.arbiter.cancel(`「${skill}」自动续跑沿用原动作期限，已到期限`, 'TIMEOUT');
      }, Math.max(0, deadlineMs - Date.now())),
    };
  }

  private clearStepExpiry() {
    if (!this.stepExpiry) return;
    clearTimeout(this.stepExpiry.timer);
    this.stepExpiry = null;
  }

  /** 只检查眼下确实会用的物品；采集等前置动作的产出仍交给实际执行确认。 */
  private queuedProblem(q: NonNullable<Mind['queuedNext']>): string | null {
    if (Date.now() - q.at > 90_000) return '已等待超过 90 现实秒，身体和物品可能变了';
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

  /** 没有活可干时（正在想事情）：原地维持当前视野、偶尔轻扫，不乱跑也不消耗东西 */
  private idle() {
    if (this.d.arbiter.info() || !this.thinking) return;
    // 危险还在：别去张望、捡东西（站着等想法，比走到怪堆里强）
    if (Date.now() < this.dangerUntil) return;
    // 张望被打断（踩空、受伤）后别每一拍都重新开始，隔几秒再说
    if (Date.now() - this.fillerAt < 3000) return;
    this.fillerAt = Date.now();
    const state = this.d.adapter.state();
    if (state.inWater || state.inLava || state.onGround === false) return;
    // 掉落物交给轻量思考决定；等回复时只维持视野、偶尔轻扫，不做整圈主动搜索。
    // 主动搜索（look_around / explore）由 Agent 自己决定，反射层只保持身体有感知。
    if (SKILLS.glance) this.d.arbiter.start({ skill: 'glance', args: { seconds: 120 } }, 'filler');
  }

  private beginActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], how: string, hypothesis?: string) {
    const state = this.d.adapter.state();
    const a = createActivity(draft, monologue, source, state);
    const appliedKnowHow = a.applying ? this.d.self.data.knowHow.find((k) => k.id === a.applying) : undefined;
    if (a.applying && !appliedKnowHow) {
      // 保留 Agent 明确写下的 id，但不设开工快照：记录时不能给任何窍门计数，也不能回退签名。
      this.d.bus.publish('decision_normalized', 'P3', `applying "${a.applying}" 不是现有窍门 id（可能已删除/合并/改写）；保留为未解析关联，不关联任何窍门证据`);
    } else if (appliedKnowHow) a.applyingText = cleanLesson(appliedKnowHow.text);
    a.startChunks = this.d.memory.visitedChunkCount;
    // 收工条件开工前就已经成立（比如 held=stone_axe）：它不能验收这段活的目标。
    // 保留原条件、把这段标成“有界尝试”，而不是静默换成“步骤做完就收工”让 done 冒充目标完成。
    if (a.doneWhen && doneWhenMet(a, state, this.safe(() => this.d.perception.snapshot(), undefined))) {
      a.attemptOnly = { reason: '收工条件开工前就已成立，不能用来验收目标', originalDoneWhen: a.doneWhen };
      a.adaptations.push('收工条件开工前就已成立：这段按有界尝试记录，步骤做完只代表操作结束，不当作目标完成');
      this.d.bus.publish('decision_normalized', 'P3', `「${a.what}」的收工条件开工前就已成立：这段按有界尝试记录，不当作目标完成`, { doneWhen: a.doneWhen, attemptOnly: true });
      delete a.doneWhen;
    }
    // 标题说“走远/换地方/找远处资源”，步骤却没有任何会移动身体的动作：提示计划覆盖缺口，但不替它改步骤。
    const coverageGap = planCoverageGap(a);
    if (coverageGap) {
      a.planCoverageGap = coverageGap;
      this.d.bus.publish('plan_coverage_gap', 'P2', `「${a.what}」${coverageGap}`, { planId: a.id });
    }
    if (hypothesis) { a.hypothesis = hypothesis; this.d.self.startExperiment(hypothesis, a.id); }
    const agenda = draft.agendaId ? this.d.self.data.agenda.find((x) => x.id === draft.agendaId) : this.d.self.activeAgenda();
    if (agenda) a.agendaId = agenda.id;
    this.activity = a;
    this.activityThoughtAt = Date.now();
    if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('开始干活');
    this.d.bus.publish('plan', 'P2', `[${source === 'rule' ? 'rule' : 'llm'}] ${a.what} —— ${monologue}`, { thought: monologue, source: source === 'rule' ? 'rule' : 'llm', steps: a.steps, planId: a.id, kind: a.kind, how, repeat: a.repeat, ...(a.facing ? { facing: a.facing } : {}), ...(hypothesis ? { hypothesis } : {}) });
    this.d.bus.publish('goal', 'P2', `开始一段活：${a.what}`, { planId: a.id, source });
    this.d.bus.publish('activity_start', 'P2', `${how === 'next' ? '接着' : how === 'habit' ? '凭习惯' : '开始'}：${a.what}${a.why ? `（${a.why}）` : ''}`, { activity: describeActivity(a, state, this.safe(() => this.d.perception.snapshot(), undefined)) });
  }

  private finishActivity(outcome: ActivityOutcome, summary: string, unmet?: { reason: string; known: boolean }) {
    const a = this.activity;
    if (!a) return;
    if (outcome !== 'stuck') this.lastStuckAttempt = null;
    this.activity = null;
    // 父活动被中断时，预排的 next 同样基于旧前提：先作废，等重新评估后再启动。
    if (outcome === 'interrupted' && this.queuedNext) {
      this.queuedNext = null;
      this.d.bus.publish('decision_stale', 'P3', '当前活动被中断，提前排好的下一段先作废，等重新评估');
    }
    // A thought started before this result cannot account for the failure. Retry with
    // the actual result before starting another activity; preserve urgent and operator thoughts.
    const thought = this.thinking;
    if ((outcome === 'stuck' || outcome === 'unmet') && thought?.activityId === a.id
      && thought.reason !== Mind.DANGER_REASON && !thought.noticed.some((n) => n.level === 'urgent') && !this.order && !this.userSuggestion) {
      this.cancelThinking('activity_result');
      for (const n of thought.noticed) {
        if (!this.attention.peek().some((pending) => pending.key === n.key)) this.attention.notice(n.key, n.what, n.salience, 0);
      }
    }
    // 收工条件只表示触发了停止，不能由此断言操作者的整条指令已经完成。
    if (this.order?.activityId === a.id) {
      if (outcome === 'done' && !a.doneWhen && !a.attemptOnly) {
        this.d.bus.publish('operator_order_end', 'P2', `照操作者的指令做完了：${this.order.text}`, { status: 'done', via: 'activity' });
        this.order = null;
      } else delete this.order.activityId;
    }
    const state = this.d.adapter.state();
    // 换维/死亡/断线/会话中断结束这段活时，保留原目的地与已完成段，只作废旧 route handle；
    // 下一段必须按实测位置重新规划，不静默复用。
    if (a.navigation && outcome === 'interrupted') invalidateNavigation(a, summary, state);
    if (a.dropped?.length) summary = `${summary}；计划里这些步骤未通过校验，没有执行：${a.dropped.join('、')}`;
    const newChunks = typeof a.startChunks === 'number' ? this.d.memory.visitedChunkCount - a.startChunks : null;
    const record = recordOf(a, outcome, summary, state, { newChunks });
    // 完成事实分层：操作结束、资源定位、资源取得、上层目标各说各的，不把 done 当成资源目标完成。
    const completionNotes = [
      ...(record.completion === 'attempt' ? [`有界尝试：${a.attemptOnly?.reason ?? '收工条件不能验收目标'}（操作结束不代表目标完成）`] : []),
      ...(record.resource?.goalIncomplete ? [`资源目标未完成（定位${record.resource.located ? '是' : '否'}、取得${record.resource.acquired ? '是' : '否'}）`] : []),
      ...(a.planCoverageGap ? [`计划覆盖缺口：${a.planCoverageGap}`] : []),
      ...(record.exploration?.localOnly ? [`本次实测离起点最远 ${record.exploration.maxHorizontal.toFixed(1)} 格、访问 ${record.exploration.visitedCells} 个脚格、新区块 +${newChunks ?? 0}；只在原地/附近观察，不能说明远处区域已搜索`] : []),
    ];
    if (completionNotes.length) {
      summary = `${summary}；${completionNotes.join('；')}`;
      record.summary = summary.slice(0, 500);
    }
    const planBefore = this.d.self.plan()?.progressAt;
    const chunksBefore = a.startChunks ?? this.d.memory.visitedChunkCount;
    const failed = [...a.results].reverse().find((r) => r.status === 'failed' && !(SKILLS[r.skill]?.readOnly && r.failureCode === 'NOT_FOUND'));
    if (outcome === 'done') { this.recentEnds = []; this.attention.resetLoop(); }
    this.recentEnds = [...this.recentEnds.filter((r) => Date.now() - r.at <= EXPERIENCE_MS),
      { pos: { ...state.pos }, outcome, skill: failed?.skill, failureCode: failed?.failureCode, what: `${a.what}（${signatureOf(a.steps)}）`, summary, at: record.at }].slice(-256);
    this.d.self.record(record);
    // 物品、清单或新区块都没动：记一笔无进展。整条链只在这里观察，不替 Agent 判断原因。
    const planAfter = this.d.self.plan()?.progressAt;
    this.noteProgressOutcome(a, record, Object.keys(record.gained).length > 0
      || this.d.memory.visitedChunkCount > chunksBefore || planAfter !== planBefore);
    this.lastRecord = record;
    this.finishedSinceReflect++;
    this.d.self.creditAgenda(a.agendaId);
    this.d.self.feel({ type: 'activity_end', outcome, sameKindStreak: this.d.self.sameKindStreak(a.kind), gainedKinds: Object.keys(record.gained).length });
    if (a.kind === 'rest') this.d.self.feel({ type: 'rest', seconds: record.durationSec });
    const exp = this.d.self.experimentFor(a.id);
    if (exp?.status === 'running') this.d.self.concludeExperiment(exp.id, 'unclear', `${outcome}：${summary}；得到 ${JSON.stringify(record.gained)}`);
    if (outcome === 'stuck') this.lastStuck = { what: a.what, why: clipFeedback(summary, 240), pos: { ...state.pos }, at: Date.now(), ...(failed ? { skill: failed.skill, code: failed.failureCode } : {}) };
    else if (outcome === 'done' && record.completion !== 'condition' && this.lastStuck && Date.now() - this.lastStuck.at < 8 * 60_000
      && Math.hypot(state.pos.x - this.lastStuck.pos.x, state.pos.y - this.lastStuck.pos.y, state.pos.z - this.lastStuck.pos.z) <= 24 && a.what !== this.lastStuck.what) {
      this.learnFrom = { stuck: this.lastStuck, solved: { what: a.what, routine: a.steps.slice(0, 6).map((st) => `${st.skill} ${argsLabel(st)}`) } };
      this.lastStuck = null;
    }
    const gains = Object.entries(record.gained).map(([k, v]) => `${k}×${v}`).join('、');
    const effects = a.effects;
    const effectReasons = [
      ...(effects?.placements.length ? [`已确认放置/支撑 ${effects.placements.join('、')}`] : []),
      ...(effects?.removed ? [`已确认挖掉 ${effects.removed} 格`] : []),
      ...(effects?.moved ? ['身体已实际移动'] : []),
      ...(gains ? [`背包实增 ${gains}`] : []),
    ];
    const changed = !!gains || !!effects?.placements.length || !!effects?.removed || !!effects?.moved;
    this.d.self.think(`${a.what} → ${outcome === 'done' ? '收工' : outcome === 'stuck' ? '卡住了' : '停下了'}${gains ? `，得到 ${gains}` : ''}：${summary.slice(0, 180)}`, 'outcome');
    const status = outcome === 'done'
      ? (record.completion === 'attempt' ? 'attempted' : 'succeeded')
      : outcome === 'unmet' ? 'condition_unmet' : outcome === 'stuck' ? 'failed' : 'interrupted';
    const goalType = ['tidy', 'social', 'other', 'experiment'].includes(a.kind) ? 'investigate' : a.kind;
    this.d.memory.recordGoal({ goal: a.what, goalType, source: a.source === 'rule' ? 'rule' : 'llm', status: record.completion === 'condition' ? 'condition_met' : status, summary, durationSec: record.durationSec,
      steps: signatureOf(a.steps).split('>'), plan: a.steps, worldId: state.worldId, dimension: state.dim });
    this.d.bus.publish('attempt_end', outcome === 'stuck' ? 'P1' : 'P3', `一段活「${a.what}」→ ${record.completion === 'attempt' ? 'attempt' : outcome}：${summary}${gains ? `（得到 ${gains}）` : ''}`,
      { planId: a.id, status, outcome, ...(record.completion ? { completion: record.completion } : {}), operationCompleted: record.operationCompleted,
        ...(record.resource ? { resource: record.resource } : {}), ...(record.exploration ? { exploration: record.exploration } : {}),
        ...(a.planCoverageGap ? { planCoverageGap: a.planCoverageGap } : {}), ...(a.attemptOnly ? { attemptOnly: a.attemptOnly.reason } : {}),
        gained: record.gained, durationSec: record.durationSec, what: a.what, kind: a.kind, signature: record.signature,
        how: a.steps.slice(0, 6).map((st) => `${st.skill} ${argsLabel(st)}`).join(' > ').slice(0, 300), effectEvidence: { verified: true, changed, reasons: effectReasons } });
    try { this.d.onGoalEnd?.(record.completion === 'condition' ? 'condition_met' : status); } catch { /* 习惯化失败不影响游玩 */ }
    if (outcome === 'done' && record.completion !== 'condition' && (gains || record.durationSec > 90) && Date.now() - this.lastDiaryAt > this.timing.diaryGapMs) this.diary(`${a.what}${gains ? `，得到 ${gains}` : ''}`);
    // 绕路的事做完了：回到被打断的那段活
    if (outcome === 'done' || outcome === 'unmet' || outcome === 'stuck') {
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
          : `绕路去做的「${a.what}」已收工：${summary}。${away} 现实秒前放下的「${resume.what}」（${resume.why || '没写原因'}）还要接着做吗？这段时间里它的前提可能已经变了`, 'deliberate');
        return;
      }
    }
    if (outcome === 'unmet') {
      // 无进展闸门已经安排了更强的重想；不再用普通收工反馈覆盖它。
      if (!this.progressGate) this.requestThink(unmet?.reason ?? `「${a.what}」收工条件未满足：${summary}`,
        unmet?.known && !this.needsBigPicture() && this.attention.highest() < URGENT ? 'glance' : 'deliberate');
    }
    if (outcome === 'stuck') {
      this.queuedNext = null; // 提前想好的下一步多半基于“这段会成功”的假设
      const previous = this.lastStuckAttempt;
      // 只降低重复失败的思考档位，不省略实际执行和结果。等待答复时的自动张望
      // 会改变视线；它不改变已校验的动作参数，也不应让同一失败再次强制认真想。
      const repeated = !!failed && !!failed.failureCode && !!previous && Date.now() - previous.at < Mind.SAME_FAIL_MS
        && previous.worldId === state.worldId && previous.sessionId === state.sessionId && previous.dim === state.dim
        && Math.hypot(state.pos.x - previous.pos.x, state.pos.y - previous.pos.y, state.pos.z - previous.pos.z) < 0.1
        && previous.code === failed.failureCode && previous.summary === failed.summary
        && isDeepStrictEqual(previous.step, { skill: failed.skill, args: failed.args });
      this.lastStuckAttempt = failed?.failureCode ? { step: { skill: failed.skill, args: failed.args }, code: failed.failureCode,
        summary: failed.summary, pos: { ...state.pos }, worldId: state.worldId, sessionId: state.sessionId, dim: state.dim, at: Date.now() } : null;
      const urgent = this.attention.highest() >= URGENT || state.hp <= 12 || state.inWater || state.inLava;
      if (!this.progressGate) this.requestThink(`「${a.what}」卡住了：${summary}${repeated ? `；刚才相同动作也失败：${previous!.summary}` : ''}${a.ifStuck ? `；之前想过卡住时：${a.ifStuck}` : ''}`, repeated && !urgent ? 'glance' : 'deliberate');
    }
  }

  /**
   * 一段活结束时记无进展。只有物品、清单和新区块都没动才累计；达到阈值后要求
   * 认真想一次，并把"继续同一条路不会产生新信息"作为必须回应的事实。
   */
  private noteProgressOutcome(a: Activity, record: ActivityRecord, progressed: boolean) {
    const plan = this.d.self.plan();
    const now = Date.now();
    const state = this.safe(() => this.d.adapter.state(), null);
    // 实测新区块是区域覆盖扩大的唯一依据；Curio 只记区域标识与数量，格点仍由共享空间库承担。
    const newChunks = typeof a.startChunks === 'number' ? this.d.memory.visitedChunkCount - a.startChunks : 0;
    if (newChunks > 0 && state) {
      this.lastRegionExpansion = { at: now, region: `${Math.floor(state.pos.x / 16)},${Math.floor(state.pos.z / 16)}`,
        chunks: this.d.memory.visitedChunkCount, dim: state.dim, worldId: state.worldId, sessionId: state.sessionId };
    }
    if (!plan || a.agendaId !== plan.agendaId || progressed) {
      this.noProgressRuns = [];
      this.progressGate = null;
      this.progressGateRejects = 0;
      if (progressed) { this.lastLocalFailure = null; this.sourceSwitchRejects = 0; }
      this.persistTaskFacts();
      return;
    }
    if (record.outcome === 'interrupted') { this.persistTaskFacts(); return; }
    // 同一做法 + 同一区域 + 同一证据版本才算“重复同一路线”；换了区域或有了新区块/物品，版本会不同。
    const start = a.startPos ?? { x: 0, y: 0, z: 0 };
    const area = `${Math.floor(start.x / 16)},${Math.floor(start.z / 16)}`;
    const scope = state ? `${state.worldId}|${state.sessionId}|${state.dim}` : '';
    const evidence = `${scope}|${this.d.memory.visitedChunkCount}|${plan.progressAt ?? 0}|${a.agendaId ?? ''}`;
    const sourceKey = `${gateSignatureOf(a.steps)}|${area}|${evidence}`;
    this.noProgressRuns = [...this.noProgressRuns.filter((run) => now - run.at < 30 * 60_000),
      { at: now, signature: gateSignatureOf(a.steps), sourceKey, what: a.what, outcome: record.outcome, summary: record.summary }].slice(-16);
    this.persistTaskFacts();
    if (this.noProgressRuns.length < Mind.PROGRESS_GATE_ACTIVITIES) return;
    if (this.progressGate || this.review || now < this.dangerUntil || this.order || this.userSuggestion) return;
    if (now - this.lastProgressGateAt < Mind.PROGRESS_GATE_COOLDOWN_MS) return;
    const activities = this.noProgressRuns.slice(-Mind.PROGRESS_GATE_ACTIVITIES)
      .map(({ what, outcome, summary }) => ({ what, outcome, summary: summary.slice(0, 120) }));
    this.progressGate = {
      at: now, agendaId: plan.agendaId,
      // 有 sourceKey 的按“做法+区域+证据版本”判重；旧记录才退回裸签名。
      signatures: [...new Set(this.noProgressRuns.flatMap((run) => run.sourceKey ? [run.sourceKey] : [run.signature]))],
      activities,
    };
    this.lastProgressGateAt = now;
    const repeated = [...new Set(activities.map((entry) => entry.what))].slice(0, 4).join('；');
    this.d.bus.publish('progress_gate', 'P2', `最近 ${activities.length} 段活没有物品/清单/新区块进展：${repeated}。需要换一个能带来新信息的做法`, {
      agendaId: plan.agendaId, activities: activities.map((entry) => entry.what), signatures: this.progressGate.signatures,
    });
    this.requestThink(`最近 ${activities.length} 段活没有物品/清单/新区块进展（反复：${repeated}）；继续同一条路不会产生新信息。先看已知地点、已见物资和可用的长距离搜索方式，再决定换地点、换方法或调整主目标`, 'deliberate');
  }

  /** 无进展闸门交给模型的事实：试过什么、哪些动作签名重复、可用的搜索方式。 */
  private progressGateFacts() {
    const gate = this.progressGate;
    if (!gate) return null;
    return {
      goal: this.d.self.plan()?.goal ?? null,
      no_progress_activities: gate.activities.length,
      recent: gate.activities.map((entry) => `${entry.what} → ${entry.outcome}：${entry.summary}`),
      repeated_signatures: gate.signatures.map((signature) => signature.length > 160 ? `${signature.slice(0, 159)}…` : signature),
      available_search: 'look_around 只覆盖当前视野；gather 只查已看见/记得的方块；expedition 可带 find 沿 100–600 格路线扫两侧约 32 格。已知地点见【记得的地方】。',
      rule: '同一条路线不会产生新信息：继续原目标必须换成不同签名的一步（换地点/换方法）；也可以写 plan 换清单或主目标并说明理由。上面列出的签名会被拒绝一次。',
    };
  }

  /** 记下这次换维的依据；目的地未知时留 null，等 tick 观察到实际维度再补上。 */
  private noteSourceSwitch(activity: { steps: { skill: string }[] }, failure: { dim: string; worldId: string; sessionId: string }, reason: string) {
    const to = activity.steps.some((step) => step.skill === 'recall_portal') ? 'overworld'
      : activity.steps.some((step) => step.skill === 'use_end_gateway') ? 'the_end' : null;
    this.lastSourceSwitch = { at: Date.now(), from: failure.dim, to, reason, worldId: failure.worldId, sessionId: failure.sessionId };
  }

  /**
   * 局部失败不能直接升级成“这个维度/来源没有资源”。换维度或换来源时，
   * 要求活动里带新的具体证据（开箱/远征搜索/采集）或 plan.switch_reason；
   * 拒绝一次，第二次放行并标为未验证，避免把紧急返程困死。
   */
  private enforceSourceSwitchEvidence(decision: MindDecision, info: { urgent?: boolean }): boolean {
    const failure = this.lastLocalFailure;
    if (!failure || info.urgent || this.order || this.userSuggestion) return true;
    const now = Date.now();
    const state = this.safe(() => this.d.adapter.state(), null);
    // 过期、换了世界/会话的局部失败不再是当前决策的依据；同一次失败才保留“拒绝一次→第二次放行”的计数。
    if (now - failure.at > Mind.LOCAL_FAILURE_TTL_MS
      || (!!state && (state.worldId !== failure.worldId || state.sessionId !== failure.sessionId))) {
      this.lastLocalFailure = null;
      this.sourceSwitchRejects = 0;
      this.sourceSwitchRejectAt = 0;
      this.persistTaskFacts();
      return true;
    }
    const activity = decision.activity ?? decision.next;
    if (!activity) return true;
    const switchesDimension = activity.steps.some((step) => ['travel_portal', 'recall_portal', 'use_end_gateway'].includes(step.skill));
    if (!switchesDimension) return true;
    // 计数跟着这次失败走：中间做别的事不算“新的尝试”，换了失败记录才重新拒绝一次。
    if (this.sourceSwitchRejectAt !== failure.at) { this.sourceSwitchRejects = 0; this.sourceSwitchRejectAt = failure.at; }
    const newEvidenceStep = activity.steps.some((step) => {
      if (['take_items', 'store_items', 'use_gui', 'gather', 'forage', 'hunt', 'fish'].includes(step.skill)) return true;
      return step.skill === 'expedition' && !!(step.args as Record<string, unknown> | undefined)?.find;
    });
    const newChunks = !!state && state.worldId === failure.worldId && this.d.memory.visitedChunkCount > (failure.chunks ?? this.d.memory.visitedChunkCount);
    const newPlan = !!(decision.plan?.switchReason || decision.switchReason);
    if (newEvidenceStep || newChunks || newPlan) {
      this.noteSourceSwitch(activity, failure, newEvidenceStep ? 'activity-evidence' : newChunks ? 'new-chunks' : 'plan-reason');
      this.lastLocalFailure = null;
      this.sourceSwitchRejects = 0;
      this.sourceSwitchRejectAt = 0;
      this.persistTaskFacts();
      return true;
    }
    if (this.sourceSwitchRejects >= 1) {
      this.noteSourceSwitch(activity, failure, 'unverified-second-attempt');
      const note = '同一次局部失败下再次在没有新证据时换维度/来源：按未验证放行；这次换来源之后的结果不能当作来源耗尽的证据';
      this.d.bus.publish('source_switch_unverified', 'P2', note, { failure });
      decision.notes.push(note);
      this.lastLocalFailure = null;
      this.sourceSwitchRejects = 0;
      this.sourceSwitchRejectAt = 0;
      this.persistTaskFacts();
      return true;
    }
    this.sourceSwitchRejects += 1;
    this.sourceSwitchRejectAt = failure.at;
    const note = `最近一次失败（${failure.skill} ${failure.code ?? ''}：${failure.summary}）只说明那一步/那个落点不成立，不能推出这个维度或来源没有资源。要换维度/来源，先在 activity 里加入新的具体证据动作（打开指定容器 take_items/store_items、expedition {find} 沿路搜索、采集/打猎等），或在 plan 里写 switch_reason 说明新证据；这次换来源被拒绝一次`;
    decision.notes.push(note);
    this.d.bus.publish('source_switch_rejected', 'P2', note, { failure });
    this.requestThink(note, 'deliberate');
    decision.activity = undefined;
    decision.next = undefined;
    decision.kind = 'continue';
    return false;
  }

  /**
   * 闸门真正加在动作入口：无进展列表里已经出现过的动作签名，拒绝一次并要求重想。
   * 连续两次仍选同一条路时解除闸门，避免把模型困死；选择不同地点/方法则放行并清除。
   */
  private enforceProgressGate(decision: MindDecision, info: { urgent?: boolean }): boolean {
    const gate = this.progressGate;
    if (!gate || info.urgent || this.order) return true;
    if (Date.now() - gate.at > 15 * 60_000) { this.progressGate = null; this.progressGateRejects = 0; return true; }
    const signature = decision.activity ? gateSignatureOf(decision.activity.steps)
      : decision.next ? gateSignatureOf(decision.next.steps) : null;
    // 决策时的区域/证据版本：同一做法换了区域或有了新区块/物品，就不再算同一路线。
    const state = this.safe(() => this.d.adapter.state(), null);
    const fullKey = signature && state
      ? `${signature}|${Math.floor(state.pos.x / 16)},${Math.floor(state.pos.z / 16)}|${state.worldId}|${state.sessionId}|${state.dim}|${this.d.memory.visitedChunkCount}|${this.d.self.plan()?.progressAt ?? 0}|${this.d.self.plan()?.agendaId ?? ''}`
      : null;
    const repeats = !!signature && (fullKey
      ? gate.signatures.includes(fullKey)
      : gate.signatures.some((key) => key === signature || key.startsWith(`${signature}|`)));
    const idleContinue = decision.kind === 'continue' && !signature && !this.activity;
    if (!repeats && !idleContinue) {
      this.progressGate = null;
      this.progressGateRejects = 0;
      this.d.bus.publish('progress_gate_cleared', 'P3', `换了一个没在无进展列表里的做法：${decision.activity?.what ?? decision.next?.what ?? '新计划'}`);
      return true;
    }
    this.progressGateRejects += 1;
    const note = `最近无进展的动作签名包含「${(signature ?? decision.kind).slice(0, 100)}」，这一步会被拒绝：请换成不同地点/不同方法，或写 plan 说明换清单/主目标`;
    decision.notes.push(note);
    this.d.bus.publish('progress_gate_repeat', 'P2', note, { signature });
    if (this.progressGateRejects <= Mind.PROGRESS_GATE_REJECT_LIMIT) {
      this.requestThink(`${note}。近期无进展的是：${gate.activities.map((entry) => entry.what).slice(-4).join('；')}；可用搜索：look_around 当前视野、gather 已见/记得、expedition {find} 长距离沿路扫`, 'deliberate');
    } else {
      this.d.bus.publish('progress_gate_unresolved', 'P2', '连续两次仍选择无进展的同一做法；闸门解除，但这段循环已记录', { signature });
      this.progressGate = null;
      this.progressGateRejects = 0;
    }
    decision.activity = undefined;
    decision.next = undefined;
    decision.kind = 'continue';
    return false;
  }

  private dropActivity(outcome: ActivityOutcome, why: string) {
    if (!this.activity) return;
    if (this.d.arbiter.info()?.planId === this.activity.id) this.d.arbiter.cancel(why);
    this.finishActivity(outcome, why);
  }

  // ---------------------------------------------------------------- 动作结果
  private onDone(o: TaskOutcome) {
    if (this.stepExpiry?.taskId === o.task.id) this.clearStepExpiry();
    if (o.task.source === 'filler') return;
    const observationMiss = softMiss(this.activity?.id === o.task.planId ? this.activity : null, { skill: o.task.skill, args: o.task.args }, o.result);
    if (o.result.status !== 'cancelled' && !observationMiss) {
      if (o.task.source !== 'reflex') {
        this.d.self.practice(o.task.skill, o.result.status === 'succeeded', o.durationMs);
        this.d.self.feel({ type: 'step', ok: o.result.status === 'succeeded' });
      }
      if (o.task.skill === 'sleep' && o.result.status === 'succeeded') { this.d.self.feel({ type: 'sleep' }); this.maybeReflect('睡了一觉'); }
    }
    if (o.task.source === 'reflex') {
      if (this.thinking) this.reflexDuringThought = { controller: this.thinking.controller, summary: o.result.summary };
      if (this.reflexWaiting?.taskId === o.task.id) {
        const waiting = this.reflexWaiting;
        this.reflexWaiting = null;
        if (this.activity === waiting.activity) this.reviewReflexChange(waiting.baseline, o.result.summary);
      }
      return;
    }
    const a = this.activity;
    if (!a || o.task.planId !== a.id) return;
    if (o.result.status === 'cancelled') {
      // 被反射打断：等身体安全了把这一步再做一遍
      if (o.preemptedBy === 'reflex') {
        // 嵌套技能（use_skill 等）内的部分爬升没有可靠续跑状态：把部分完成事实交回 Agent，不整段重播。
        const climbed = o.result.data?.climbed;
        if (o.task.skill !== 'pillar_one' && typeof climbed === 'number' && climbed > 0) {
          const spent = o.result.data?.spent;
          this.finishActivity('stuck', `${o.task.skill} 被反射打断，之前已完成部分爬升（净 ${climbed} 格${typeof spent === 'number' ? `，累计爬升 ${spent} 格` : ''}）；没有可靠的续跑状态，是否继续由你决定`);
          return;
        }
        a.index = Math.max(0, a.index - 1);
        markContinuation(a, a.steps[a.index]); // 反射打断后的回放仍属同一次委托
        a.interruptions = (a.interruptions ?? 0) + 1;
        a.lastInterruption = { at: Date.now(), kind: 'body_reflex', reason: '身体的躲闪反应打断了这一步，安全后会从这一步重做', skill: o.task.skill };
        // 一直被身体躲闪打断：这段活眼下做不成，先想想怎么对付周围的危险
        if (a.interruptions >= 3) this.finishActivity('stuck', `这段活被身体的躲闪反应打断了 ${a.interruptions} 次，周围有危险：先处理掉威胁（打、跑远、躲起来）再做`);
      }
      return;
    }
    this.handleStepResult({ skill: o.task.skill, args: o.task.args }, o.result, o.durationMs, o.task.id);
  }

  private handleStepResult(step: Step, result: { status: 'succeeded' | 'failed' | 'cancelled'; failureCode?: any; summary: string; data?: Record<string, unknown>; caveat?: string }, durationMs: number, taskId?: string) {
    const a = this.activity;
    if (!a) return;
    if (this.recoverySkipped(a, step, result)) return;
    const observationMiss = softMiss(a, step, result);
    if (result.status === 'failed' && !observationMiss) {
      this.lastFailure = { skill: step.skill, code: result.failureCode, summary: result.summary };
      const failedState = this.d.adapter.state();
      this.recentActionFailures.push({ step: structuredClone(step), code: result.failureCode ?? null, summary: clipFeedback(result.summary),
        pos: { ...failedState.pos }, worldId: failedState.worldId, sessionId: failedState.sessionId, dim: failedState.dim, at: Date.now(),
        scope: 'step', implication: '这次失败只否定这个动作/落点，不否定其他方向、其他来源或整个维度' });
      this.recentActionFailures = this.recentActionFailures.filter((f) => Date.now() - f.at < Mind.SAME_FAIL_MS).slice(-30);
      // 局部移动/放置失败只记作“这一步不成立”；之后要换维度/来源时，必须带新的具体证据。
      // move_step/place 等元语的 failureCode 常是 BAD_ARGS，具体是哪类局部失败在 data.problem.kind。
      const localFailure = localStepFailure(step, result, failedState, this.d.memory.visitedChunkCount);
      if (localFailure) {
        this.lastLocalFailure = localFailure;
        this.persistTaskFacts();
      }
      this.pruneFailures();
      const key = targetKeyOf(step);
      const entry = this.failuresByTarget.get(key) ?? { n: 0, last: 0, at: [] };
      entry.at.push(Date.now()); entry.n = entry.at.length; entry.last = Date.now();
      this.failuresByTarget.set(key, entry);
      const sig = exactSig(step), why = reasonKey(result.summary), prev = this.sameFails.get(sig);
      const same = prev && prev.code === String(result.failureCode ?? '') && prev.why === why && Date.now() - prev.last < Mind.SAME_FAIL_MS;
      this.sameFails.set(sig, { n: same ? prev!.n + 1 : 1, last: Date.now(), code: String(result.failureCode ?? ''), why, summary: clipFeedback(result.summary, 200) });
    } else if (result.status === 'succeeded') {
      this.sameFails.delete(exactSig(step));
      // 成功走出一步就是新的局部局面；过去的移动/规划失败不再作为“禁止再走”的依据。
      if (LOCAL_PATH.has(step.skill)) this.recentActionFailures = this.recentActionFailures.filter((f) => !LOCAL_PATH.has(f.step.skill));
      if (result.caveat) {
        const st = this.d.adapter.state();
        this.recentActionCaveats.push({ step: structuredClone(step), caveat: result.caveat, pos: { ...st.pos }, worldId: st.worldId, sessionId: st.sessionId, dim: st.dim, at: Date.now() });
        this.recentActionCaveats = this.recentActionCaveats.filter((c) => Date.now() - c.at < Mind.SAME_FAIL_MS).slice(-30);
      }
    }
    if (a.awaitingRecovery && step.skill !== 'use_skill') {
      const name = a.awaitingRecovery;
      delete a.awaitingRecovery;
      this.safe(() => this.d.behaviors?.creditRecovery(name, result.status === 'succeeded', { skill: step.skill, code: result.failureCode ?? null }), undefined);
    }
    const percept = this.safe(() => this.d.perception.update(), undefined);
    const state = this.d.adapter.state();
    const verdict = afterStep(a, step, result, durationMs, state, percept);
    // 身体自己应变不了：先试学会的恢复办法（模型以前从类似的卡住里总结出来的），试过还不行才叫脑子
    if (verdict.kind === 'stuck' && !verdict.exhausted && result.status === 'failed' && step.skill !== 'use_skill' && this.d.behaviors) {
      const tried = new Set(a.adaptations.filter((x) => x.startsWith('skill:')).map((x) => x.slice(6)));
      const skipped = a.adaptations.filter((x) => x.startsWith('skip:')).length;
      const b = tried.size - skipped < 2 ? this.safe(() => this.d.behaviors!.recoveryFor({ skill: step.skill, code: result.failureCode }, tried), null) : null;
      if (b) {
        a.adaptations.push(`skill:${b.name}`);
        a.awaitingRecovery = b.name;
        const own = a.steps[Math.max(0, a.index - 1)];
        a.steps.splice(Math.max(0, a.index - 1), 0, {
          skill: 'use_skill', args: { name: b.name, failure: failureFor(step, result, this.d.adapter.state().pos) }, optional: true, id: shortId('st_'),
          origin: 'execution_helper', authorizedBy: { skill: step.skill, ...(own?.id ? { stepId: own.id } : {}), args: step.args },
        });
        a.index = Math.max(0, a.index - 1);
        // 恢复技能之后会回放原来的动作：仍是同一次委托，沿用原期限与材料额度。
        markContinuation(a, own);
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
    // 步骤做完但收工条件未达到时，保留既有的重新思考流程；满足条件则遵守 Agent 的后续选择。
    const nextToReview = verdict.kind === 'done' && !verdict.met ? this.queuedNext : null;
    if (nextToReview) this.queuedNext = null;
    // 收工条件只看一次同一个快照：既给出交回心智的 known 标记，也用来判断调用方是否否决了刚完成的这次技能成功。
    const unmetCondition = a.doneWhen;
    const callerEvidence = verdict.kind === 'done' && !verdict.met && unmetCondition
      ? evaluateCondition(unmetCondition, state, state.worldId, [], percept) : null;
    const unmet = callerEvidence ? {
      reason: nextToReview ? `「${a.what}」${verdict.why}；提前想好的「${nextToReview.draft.what}」先不接着做，请根据实际结果决定是否继续。` : `「${a.what}」收工条件未满足：${verdict.why}`,
      known: callerEvidence.status === 'unsatisfied',
    } : undefined;
    // 技能自述做完、自己的 verify 也通过了，但调用方明确的收工条件未满足（比如只浮在水面、没有站上干地）：
    // 撤销这次“成功”记账——执行完毕不等于调用方要的结果。只在明确 unsatisfied 时降级；
    // stuck、可选步骤、多步活动的后续失败都不改这份技能的账。
    // 恢复步骤（args.failure）的成败由 creditRecovery 按“重做的那一步有没有成”结算，不由调用方收工条件改判。
    if (callerEvidence?.status === 'unsatisfied' && unmetCondition && taskId && step.skill === 'use_skill'
      && !(step.args as { failure?: unknown } | undefined)?.failure
      && result.status === 'succeeded' && result.data?.verified === true && this.d.behaviors) {
      const name = String((step.args as { name?: unknown } | undefined)?.name ?? '');
      const behaviors = this.d.behaviors;
      if (name) this.safe(() => behaviors.callerUnmet(name, taskId, `调用方收工条件未满足：实际 ${JSON.stringify(callerEvidence.actual)}；条件 ${JSON.stringify(unmetCondition)}${callerEvidence.reason ? `；原因：${callerEvidence.reason}` : ''}`), undefined);
    }
    this.finishActivity(verdict.kind === 'done' ? verdict.met ? 'done' : 'unmet' : 'stuck', verdict.why, unmet);
  }

  /**
   * 恢复技能明确跳过或未观察到动作效果时，不盲目重做原来失败的动作。
   * 换下一个对得上的恢复技能；没有就把原来的失败交还给心智。返回 true 表示已经处理完。
   */
  private recoverySkipped(a: Activity, step: Step, result: { status: string; summary: string; data?: unknown }): boolean {
    const failure = (step.args as any)?.failure as { skill: string; args?: unknown; code?: string | null; summary?: string } | undefined;
    const data = result.data as { noop?: boolean; result?: { skipped?: unknown } } | undefined;
    const skipped = !!data?.result?.skipped;
    if (step.skill !== 'use_skill' || !failure || result.status !== 'succeeded' || (!skipped && data?.noop !== true) || !this.d.behaviors) return false;
    const name = String((step.args as any)?.name ?? '');
    const why = skipped ? `「${name}」说这次跟它无关` : `「${name}」没有观察到实际动作效果`;
    if (a.awaitingRecovery === name) delete a.awaitingRecovery;
    a.adaptations.push(`skip:${name}`);
    this.safe(() => this.d.behaviors!.recoverySkipped(name, { skill: failure.skill, code: failure.code ?? null }), undefined);
    const retry = a.steps[a.index];
    const tried = new Set(a.adaptations.filter((x) => x.startsWith('skill:')).map((x) => x.slice(6)));
    const skippedCount = a.adaptations.filter((x) => x.startsWith('skip:')).length;
    const next = tried.size - skippedCount < 2 ? this.safe(() => this.d.behaviors!.recoveryFor({ skill: failure.skill, code: failure.code ?? undefined }, tried), null) : null;
    if (next) {
      a.adaptations.push(`skill:${next.name}`);
      a.awaitingRecovery = next.name;
      if (retry && retry.skill === failure.skill) markContinuation(a, retry);
      a.steps.splice(a.index, 0, {
        skill: 'use_skill', args: { name: next.name, failure }, optional: true, id: shortId('st_'),
        origin: 'execution_helper', authorizedBy: { skill: failure.skill, args: failure.args },
      });
      this.d.bus.publish('body_adapt', 'P3', `${why}，换学会的做法：${next.name}（${next.description}）`, { planId: a.id, skill: next.name });
      return true;
    }
    // 没有别的办法：别白白重做那一步，直接把它原来的失败交给心智
    if (retry && retry.skill === failure.skill) a.steps.splice(a.index, 1);
    this.d.bus.publish('body_adapt', 'P3', `${why}，没有别的学会的做法，交给心智`, { planId: a.id, skill: name });
    this.finishActivity('stuck', `${failure.skill} 没成：${clipFeedback(String(failure.summary ?? ''), 200)}；${why}：${clipFeedback(result.summary, 200)}`);
    return true;
  }

  /** 同一站位附近、近期确定性移动/规划失败；用来阻止把整段活重复成同一种 path 动作。 */
  private localPathFailures(state: AgentState) {
    const now = Date.now();
    return this.recentActionFailures.filter((f) =>
      f.worldId === state.worldId && f.sessionId === state.sessionId && f.dim === state.dim
      && now - f.at < 2 * 60_000
      && Math.hypot(f.pos.x - state.pos.x, f.pos.y - state.pos.y, f.pos.z - state.pos.z) <= 2
      && LOCAL_PATH.has(f.step.skill)
      && ['BAD_ARGS', 'PATH_NOT_FOUND', 'EFFECT_NOT_CONFIRMED', 'NOT_FOUND'].includes(String(f.code)));
  }

  private pruneFailures() {
    const cutoff = Date.now() - EXPERIENCE_MS;
    for (const [key, entry] of this.failuresByTarget) {
      entry.at = entry.at.filter((at) => at >= cutoff);
      entry.n = entry.at.length;
      if (!entry.n) this.failuresByTarget.delete(key);
    }
  }

  /** 决策时观察到的状态经反射改变后，由心智决定是否继续原计划。 */
  private reviewReflexChange(before: AgentState, summary: string) {
    const a = this.activity;
    if (!a) return;
    const now = this.d.adapter.state();
    const moved = Math.hypot(now.pos.x - before.pos.x, now.pos.y - before.pos.y, now.pos.z - before.pos.z) >= 0.5;
    const changed = moved || now.worldId !== before.worldId || now.sessionId !== before.sessionId || now.dim !== before.dim
      || now.inWater !== before.inWater || now.inLava !== before.inLava || now.onGround !== before.onGround
      || now.hp !== before.hp || now.alive !== before.alive || Math.abs(now.oxygen - before.oxygen) >= 4;
    if (!changed) return;
    this.resumeCheck = a.id;
    this.requestThink(`身体反射的结果：${summary}；期间身体状态已变化，先确认「${a.what}」还要接着做吗`, 'deliberate');
  }

  private onEvent(ev: AgentEvent) {
    if (ev.type === 'notice') return;
    if (ev.type === 'death' || ev.type === 'task_end') this.safe(() => this.strategy.onEvent(ev, {
      phase: this.safe(() => this.d.perception.snapshot().time.phase, ''), bedDist: this.bedDist(), doing: this.activity?.what ?? this.lastRecord?.what ?? '' }), undefined);
    const n = this.attention.fromEvent(ev);
    if (n && n.level !== 'note') this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    if (ev.type === 'milestone') this.d.self.feel({ type: 'milestone' });
    if (ev.type === 'hurt') { this.lastHurtEventAt = Date.now(); this.d.self.feel({ type: 'hurt', amount: 2 }); this.hurtWhileBusy(typeof (ev.data as { around?: unknown } | undefined)?.around === 'string' ? (ev.data as { around: string }).around : ''); }
    if (ev.type === 'item_new' || ev.type === 'discovery') {
      this.speechEventAt = Date.now();
      this.d.self.feel({ type: 'novelty', strength: ev.type === 'item_new' ? 0.6 : 0.4 });
      if (ev.type === 'item_new' && Date.now() - this.lastDiaryAt > this.timing.diaryGapMs / 2) this.diary(ev.msg.slice(0, 80));
    }
  }

  /**
   * 正在做跟打架无关的事（盖房、挖、走、原地等）时挨了打，而且身边有怪：
   * 给身体的技能一点时间接手；没有技能接手，就停下手上的事、马上认真想。怎么应对由它自己定，这里只保证它不会边挨打边继续砌墙。
   * 人在水里做水面动作时例外：停下来就是下沉，保留它自己选的出水/换气，只把事实交回去，并用快速档思考。
   */
  private hurtAt = 0;
  private hurtWhileBusy(cause = '') {
    const now = Date.now();
    if (now - this.hurtAt < 8000) return;
    this.hurtAt = now;
    setTimeout(() => {
      const cur = this.d.arbiter.info();
      if (!cur || (cur.source !== 'llm' && cur.source !== 'rule')) return;
      const state = this.d.adapter.state();
      // use_skill 里包着的水面技能（比如自己写的爬岸技能）也要按它实际在做的事判断。
      const acting = cur.skill === 'use_skill' ? String((cur.args as { name?: unknown } | undefined)?.name ?? '') : cur.skill;
      const waterEscape = state.inWater && WATER_ESCAPE.has(acting);
      if (!waterEscape && COMBAT.has(cur.skill)) return;
      const hostiles = this.safe(() => this.d.perception.snapshot().nearby.hostile.filter((h) => h.dist <= 8), []);
      const hp = Math.round(state.hp * 10) / 10;
      if (!hostiles.length) {
        // 没有怪，但身体在掉血（着火、岩浆、摔、窒息、溺水……）：原来直接返回，手上的移动会一路烧到见底
        // （下界实测 16.5 → 2 血，explore_toward 一直在走）。不替它脱险，只停下并把伤害事实交回心智；
        // 走 glance——认真想要十几秒，着火时等不起。
        if (!cause && !state.inLava) return;
        const why = cause || '身体在岩浆里';
        if (waterEscape) {
          this.requestThink(`正在 ${cur.skill} 时持续掉血（血 ${hp}，当时：${why}），人在水里，先把出水/换气动作做完`, 'glance');
          return;
        }
        if (this.activity && cur.planId === this.activity.id) {
          this.activity.index = Math.max(0, this.activity.index - 1);
          this.activity.lastInterruption = { at: Date.now(), kind: 'hurt', reason: `掉血了（血 ${hp}，${why}），手上的事先停了`, skill: cur.skill, pos: { ...state.pos } };
        }
        this.d.arbiter.cancel('掉血了');
        if (this.activity) this.resumeCheck = this.activity.id;
        this.requestThink(`正在 ${cur.skill} 时掉血了（血 ${hp}，当时：${why}）；手上的事先停了，怎么脱离由你定`, 'glance');
        const n = this.attention.notice('hurt_busy_env', `正在 ${cur.skill} 时掉血（血 ${hp}，${why}），手上的事先停了`, 0.9, 0);
        if (n) this.d.bus.publish('notice', 'P1', `注意到：${n.what}`, { salience: n.salience, level: n.level });
        return;
      }
      const hostileText = hostiles.slice(0, 3).map((h) => `${h.name} ${Math.round(h.dist)}格`).join('、');
      // 人在水里时停下来就是下沉：保留 Agent 自己选的出水/换气动作，只把挨打事实和怪的位置交给它。
      // 思考走 glance——缺氧时再排一次十几秒的 deliberate，命已经没了。
      if (waterEscape) {
        this.requestThink(`正在 ${cur.skill} 时挨打了（血 ${hp}），人在水里，先把出水/换气动作做完`, 'glance');
        const n = this.attention.notice('hurt_busy_water', `正在 ${cur.skill} 时挨打了（血 ${hp}，${hostileText}），人在水里，动作没停`, 0.9, 0);
        if (n) this.d.bus.publish('notice', 'P1', `注意到：${n.what}`, { salience: n.salience, level: n.level });
        return;
      }
      // 停下的那一步算没做（想完要是接着做，从这一步重新来）
      if (this.activity && cur.planId === this.activity.id) {
        this.activity.index = Math.max(0, this.activity.index - 1);
        this.activity.lastInterruption = { at: Date.now(), kind: 'hurt', reason: `挨打了（血 ${hp}，${hostileText}），手上的事先停了`, skill: cur.skill, pos: { ...state.pos } };
      }
      this.d.arbiter.cancel('挨打了');
      // 想好之前别又把刚停下的那一步接着做
      if (this.activity) this.resumeCheck = this.activity.id;
      this.requestThink(`正在 ${cur.skill} 时挨打了（血 ${hp}）`, 'deliberate');
      const n = this.attention.notice('hurt_busy', `正在 ${cur.skill} 时挨打了（血 ${hp}，${hostileText}），手上的事先停了`, 0.9, 0);
      if (n) this.d.bus.publish('notice', 'P1', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    }, 700).unref?.();
  }

  // ---------------------------------------------------------------- 思考
  /** 取最近一次后台预取的长期记忆（过期就不给，避免拿旧事当现场） */
  private freshHindsightMemories() {
    const c = this.hindsightMemories;
    return c && Date.now() - c.at < Mind.HINDSIGHT_FRESH_MS ? c.items : null;
  }

  /** 后台预取长期记忆：deliberate 触发、不阻塞思考，结果留给下一次 deliberate；失败静默回落本地回想 */
  private async prefetchHindsight(query: string, percept: Percept, generation: number) {
    const recall = this.d.thinker.recall;
    if (!recall || this.hindsightPrefetching) return;
    this.hindsightPrefetching = true;
    try {
      const res = await recall.recall({
        percept: { self: { dim: percept.self.dim, pos: percept.self.pos }, objective: null, nearby: percept.nearby },
        lastFailure: null,
        userSuggestion: null,
      }, query);
      if (generation !== this.generation || this.paused) return;
      if (res.source === 'hindsight' && res.memories.length) {
        this.hindsightMemories = { at: Date.now(), items: res.memories.map((m) => ({
          text: m.text.slice(0, 400), kind: m.kind === 'experience' ? 'experience' as const : 'inference' as const })) };
      }
    } catch {
      // 拉不到长期记忆就继续用本地回想，不影响这一念
    } finally {
      this.hindsightPrefetching = false;
    }
  }

  private think(reason: string, tier: 'glance' | 'deliberate') {
    if (this.thinking || this.paused) return;
    const state = this.d.adapter.state();
    if (!observationReady(state)) return;
    // 身体在水里、氧气不足时，所有前景思考都只走“瞥一眼”：完整认真想的延迟按秒计（实机中位约 9 秒、
    // 长尾几十秒），而水下氧气从 10 掉到 0 往往也在这几秒内，等回答回来可能已经溺死。瞥一眼只是更快地
    // 看见现状和可选做法，想什么、做什么仍由心智决定；这里不选动作、不触发救援，只把调度延迟压下来。
    // 放在 think() 统一处理，pendingReason、urgentNow、没活在身、上一段刚结束、最后一步提前想这些路径都覆盖到。
    if (tier === 'deliberate' && state.inWater && state.oxygen < LOW_AIR_OXYGEN) tier = 'glance';
    let percept: Percept;
    try { percept = this.d.perception.update(); } catch { return; }
    this.trackTrip(percept, state);
    const generation = this.generation;
    // 这一念看到的世界：回来时若已换作用域，决定不能覆盖新世界的活动。
    const decisionEpoch = this.decisionEpoch;
    const controller = new AbortController();
    const activityId = this.activity?.id ?? null;
    const thoughtRunning = this.d.arbiter.info();
    const knownResults = new Set(this.activity?.results ?? []);
    const noticed = this.attention.drain();
    this.thinking = { controller, reason, tier, startedAt: Date.now(), generation, epoch: decisionEpoch, activityId, noticed };
    const urgent = noticed.some((n) => n.level === 'urgent');
    const reflect = tier === 'deliberate' && this.finishedSinceReflect >= 4;
    this.pruneFailures();
    // 按关键词想起相关的经历、教训和技能（像人看到眼前的事想起以前），拿得准的技能直接翻开
    const plan = this.d.self.plan();
    const query = [plan?.goal, ...(plan?.steps.filter((st) => !st.done).slice(0, 2).map((st) => st.text) ?? []), this.activity?.what, this.activity?.why,
      this.lastRecord?.what, this.lastRecord?.outcome === 'stuck' ? this.lastRecord.summary : '', this.lastFailure?.summary, ...noticed.map((n) => n.what), reason].filter(Boolean).join(' ');
    const book = this.d.thinker.skillBook;
    const ledger = this.d.ledger;
    const recalled = this.safe(() => recallLocal(query, { self: this.d.self, memory: this.d.memory, book, ledger }, { n: tier === 'glance' ? 3 : 6, exclude: ['know_how'], excludeRefs: this.d.self.history(5).map((r) => r.id) }), []);
    const hindsightMemories = tier === 'deliberate' ? this.freshHindsightMemories() : null;
    if (tier === 'deliberate') void this.prefetchHindsight(query, percept, generation);
    let openedSkill: MindContext['openedSkill'];
    const top = recalled.find((r) => r.kind === 'skill' && r.score >= 4 && r.ref);
    if (tier === 'deliberate' && top && book?.get(top.ref!) && Date.now() - (this.skillOpenedAt.get(top.ref!) ?? 0) > 5 * 60_000) {
      const k = book.get(top.ref!)!;
      this.skillOpenedAt.set(k.name, Date.now());
      openedSkill = { name: k.name, body: [k.notes ? `学习笔记：\n${k.notes}` : '', k.body].filter(Boolean).join('\n\n').slice(0, 1500) };
      this.d.bus.publish('skill_read', 'P3', `想起了技能：${k.name}`, { name: k.name, source: k.source, auto: true });
    }
    const learnFrom = this.learnFrom;
    // 有等着的阶段回顾、而且不是危急关头：这一念认真想想阶段目标
    const reviewing = !!this.review && tier === 'deliberate' && !urgent;
    const nearbyFailures = this.recentActionFailures.filter((f) => Date.now() - f.at < Mind.SAME_FAIL_MS
      && f.worldId === state.worldId && f.sessionId === state.sessionId && f.dim === state.dim
      && Math.hypot(f.pos.x - state.pos.x, f.pos.y - state.pos.y, f.pos.z - state.pos.z) <= 8).slice(-6);
    const nearbyFailKeys = new Set(nearbyFailures.map((f) => targetKeyOf(f.step)));
    const nearbyCaveats = this.recentActionCaveats.filter((c) => Date.now() - c.at < Mind.SAME_FAIL_MS
      && c.worldId === state.worldId && c.sessionId === state.sessionId && c.dim === state.dim
      && Math.hypot(c.pos.x - state.pos.x, c.pos.y - state.pos.y, c.pos.z - state.pos.z) <= 8).slice(-6);
    // 手上正在做/接着要做的那一步（activity.index 指向下一待执行步，前一步是正在跑的），以及已经想好的下一段
    const plannedDig = [
      ...(this.activity ? this.activity.steps.slice(Math.max(0, this.activity.index - 1), this.activity.index + 1) : []),
      ...(this.queuedNext?.draft.steps ?? []),
    ].some((st) => DIGGING_SKILLS.has(st.skill));
    // 寻路/自写技能也会挖：最近 5 秒真有挖掘事件时也算“在挖”，别让铁镐在无名路径上悄悄掉耐久
    const recentDig = this.safe(() => (this.d.adapter.recentDug?.(Date.now() - 5_000)?.length ?? 0) > 0, false);
    const tierFact = this.safe(() => toolTierFact({
      inventory: state.inventory, stock: percept.storage?.stock, held: state.held, digging: plannedDig || recentDig,
    }), null);
    // 同一状态签名不每念重复；状态变了、换了世界/会话/维度，或过了 10 分钟才再说；两次投放至少隔 30 秒
    const factNow = Date.now();
    const scoped = tierFact ? `${state.worldId}:${state.sessionId}:${state.dim}:${tierFact.key}` : null;
    const changed = scoped !== this.toolFactKey || factNow - this.toolFactAt > Mind.TOOL_FACT_REPEAT_MS;
    const toolFact = scoped && changed && factNow - this.toolFactAt >= Mind.TOOL_FACT_MIN_GAP_MS ? tierFact : null;
    if (toolFact) {
      this.toolFactKey = scoped; this.toolFactAt = factNow;
      // 只在真正投放时打一次点；buildMindMessages 可能因升层/重试被调用多次，不能放在提示词构建里重复发
      this.d.bus.publish('notice', 'P3', toolFact.text, { level: 'note', salience: 0.3, kind: 'tool_tradeoff' });
    }
    const ctx: MindContext = {
      tier, reason: reflect ? `${reason}；做完了好几段活，顺便回头看看哪些办法好用、哪些该改` : reason,
      percept, state, self: this.d.self, memory: this.d.memory, blockAt: (p) => this.d.adapter.blockAt(p), activity: this.activity,
      ...(thoughtRunning ? { runningStep: { skill: thoughtRunning.skill, args: thoughtRunning.args, source: thoughtRunning.source, startedAt: thoughtRunning.startedAt } } : {}),
      suspended: this.suspended,
      log: (msg, data) => this.d.bus.publish('notice', 'P3', msg, { level: 'note', salience: 0.3, ...(data ?? {}) }),
      next: this.queuedNext?.draft ?? null,
      lastRecord: this.lastRecord, noticed, changes: this.changesSinceLastThought(), userSuggestion: this.userSuggestion,
      operatorOrder: this.order ? { text: this.order.text, ageSec: Math.round((Date.now() - this.order.at) / 1000), status: this.order.status, kind: this.order.kind } : null,
      audience: this.d.audience?.context(tier === 'glance' ? 'light' : 'full') ?? null, notes: this.notes,
      mySkills: tier === 'deliberate' ? this.safe(() => this.d.mySkills?.() ?? [], []) : [],
      researchContext: tier === 'deliberate' && reflect ? this.safe(() => this.d.researchContext?.(), undefined) : undefined,
      persona: this.d.persona,
      progress: this.d.progress?.() ?? null,
      gameMessages: this.recentGameMessages(),
      // 收起、停用的技能不进目录（翻技能书、回想时还看得到）：目录越长越难挑，还拖累缓存
      skills: this.safe(() => this.d.thinker.skillBook?.index((n) => !!this.d.behaviors?.hidden(n),
        this.d.behaviors ? (name, trial) => this.d.behaviors!.executionError(name, trial) : undefined,
        this.d.behaviors ? (name) => this.d.behaviors!.autoNote(name) : undefined) ?? [], []),
      recalled, ...(hindsightMemories ? { hindsightMemories } : {}), ...(openedSkill ? { openedSkill } : {}), ...(learnFrom ? { learnFrom } : {}), plan,
      hunting: this.safe(() => this.d.ledger?.huntTally() ?? null, null),
      materials: ledger ? this.safe(() => ({ wood: ledger.materialTally('wood'), ore: ledger.materialTally('ore') }), null) : null,
      ...(this.trip ? { trip: { minutes: (Date.now() - this.trip.since) / 60_000, gained: diffInventory(this.trip.inventory, inventoryOf(state)).gained, nearEnd: reason === Mind.NEAR_END_REASON } } : {}),
      ...(reviewing ? { stageReview: this.safe(() => this.stageReviewFacts(), { why: this.review?.why ?? '' }) } : {}),
      ...(this.progressGate && tier === 'deliberate' ? { progressGate: this.safe(() => this.progressGateFacts(), null) } : {}),
      ...(this.d.behaviors && tier === 'deliberate' ? { learnedSkills: this.safe(() => this.d.behaviors!.overview().filter((l) => !/已收起|已停用/.test(l)), []), instincts: this.safe(() => instinctNote(), '') } : {}),
      ...(this.d.thinker.designing ? { designing: { brief: this.d.thinker.designing.brief, minutes: Math.round((Date.now() - this.d.thinker.designing.startedAt) / 60_000) } } : {}),
      toolFact: toolFact?.text ?? null,
      repeatedFailures: [...this.failuresByTarget].filter(([key, f]) => f.n >= 2 && !nearbyFailKeys.has(key))
        .sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([key, f]) => `${key.replace(':', ' ')} ×${f.n}（10 现实分钟内）`),
      recentActionFailures: nearbyFailures.map((f) => {
        const repeats = this.failuresByTarget.get(targetKeyOf(f.step))?.n ?? 0;
        return { skill: f.step.skill, args: f.step.args ?? {}, failure_code: f.code, summary: f.summary,
          position: f.pos, observed_at: new Date(f.at).toISOString(), ...(repeats >= 2 ? { repeats } : {}),
          ...(f.scope ? { scope: f.scope } : {}), ...(f.implication ? { implication: f.implication } : {}) };
      }),
      recentActionCaveats: nearbyCaveats.map((c) => ({ skill: c.step.skill, args: c.step.args ?? {}, caveat: c.caveat, position: c.pos, observed_at: new Date(c.at).toISOString() })),
    };
    const suggestion = this.userSuggestion;
    const order = this.order, orderWasNew = order?.status === 'new';
    this.d.bus.publish('llm_request', 'P3', `${tier === 'glance' ? '抬头看一眼' : '认真想想'}：${reason}`, { tier, reason });
    this.idle();
    // 这一念被取消/丢弃/失败时，工具事实并没有真正送达：撤回去重状态，下一次还能再提
    const dropToolFact = () => { if (toolFact) { this.toolFactKey = null; this.toolFactAt = 0; } };
    this.d.thinker.think(ctx, controller.signal).then((decision) => {
      if (this.thinking?.controller !== controller) { this.staleDropped++; dropToolFact(); return; }
      this.thinking = null;
      if (generation !== this.generation || decisionEpoch !== this.decisionEpoch || this.paused) { this.staleDropped++; dropToolFact(); return; }
      // 绕路完成后可能已经恢复了另一段活；绕路时提前想的决定不能改写那段活或它的下一段。
      if (reason === Mind.NEAR_END_REASON && activityId && this.activity && this.activity.id !== activityId) {
        this.staleDropped++;
        dropToolFact();
        for (const n of noticed) {
          if (!this.attention.peek().some((pending) => pending.key === n.key)) this.attention.notice(n.key, n.what, n.salience, 0);
        }
        return;
      }
      // 刚收到的指令：照做时不受“专注”的限制（瞥一眼不能换、刚开工先不改）
      // 刚收到的指令（或决定采纳的建议）：照做时不受专注的限制
      const followsOperator = orderWasNew && (order?.kind === 'order' ? decision.operator?.status !== 'cannot' : decision.operator?.status === 'adopted');
      // An adjustment can repeat the step that was still running when the
      // model saw it, even though it completed before its answer arrived.
      // Return the actual result for a fresh decision; do not silently remove
      // a step that the agent may deliberately choose to repeat.
      const completedDuringThought = activityId && this.activity?.id === activityId && thoughtRunning?.planId === activityId
        ? this.activity.results.find((result) => !knownResults.has(result) && result.status === 'succeeded'
          && result.skill === thoughtRunning.skill && isDeepStrictEqual(result.args ?? {}, thoughtRunning.args ?? {})) : undefined;
      const first = decision.activity?.steps[0];
      if (!followsOperator && decision.kind === 'adjust' && completedDuringThought && first && thoughtRunning && first.skill === thoughtRunning.skill
        && isDeepStrictEqual(first.args ?? {}, thoughtRunning.args ?? {})) {
        this.staleDropped++;
        dropToolFact();
        this.resumeCheck = activityId;
        this.requestThink(`思考期间 ${completedDuringThought.skill} 已经成功：${completedDuringThought.summary}；刚才的调整以同一动作开头，请根据实际结果决定是否还要重复`, 'deliberate');
        for (const notice of noticed) if (!this.attention.peek().some((pending) => pending.key === notice.key)) this.attention.notice(notice.key, notice.what, notice.salience, 0);
        this.d.bus.publish('decision_stale', 'P3', `思考期间动作已成功，调整需要重新决定：${completedDuringThought.summary}`, { skill: completedDuringThought.skill, summary: completedDuringThought.summary, planId: activityId });
        this.kick();
        return;
      }
      this.errors = 0; this.backoffUntil = 0;
      this.lastThoughtAt = Date.now();
      if (decision.tier === 'deliberate') { this.lastDeliberateAt = Date.now(); this.finishedSinceReflect = 0; }
      if (suggestion && suggestion === this.userSuggestion) this.userSuggestion = null;
      this.lastSnapshot = this.snapshotNow();
      if (learnFrom && this.learnFrom === learnFrom) this.learnFrom = null; // 提醒过一次就够了
      if (order && order === this.order) this.answerOrder(order, orderWasNew, decision);
      const goalBefore = this.d.self.plan()?.agendaId ?? null;
      this.inReview = reviewing;
      try {
        this.apply(decision, activityId, ctx.lastRecord, { urgent: urgent || followsOperator, nearEnd: reason === Mind.NEAR_END_REASON });
      } finally { this.inReview = false; }
      const runningReflex = this.d.arbiter.info();
      if (runningReflex?.source === 'reflex' && this.activity) {
        this.reflexWaiting = { taskId: runningReflex.id, activity: this.activity, baseline: state };
      } else if (this.reflexDuringThought?.controller === controller) {
        this.reviewReflexChange(state, this.reflexDuringThought.summary);
      }
      if (this.reflexDuringThought?.controller === controller) this.reflexDuringThought = null;
      if (reviewing) this.closeReview(goalBefore);
      if (followsOperator && this.order === order && order && this.activity && !order.activityId) order.activityId = this.activity.id;
      this.kick();
    }).catch((e: any) => {
      if (this.thinking?.controller !== controller) return;
      this.thinking = null;
      if (controller.signal.aborted || generation !== this.generation) return;
      dropToolFact();
      this.errors++;
      this.backoffUntil = Date.now() + Math.min(this.timing.maxBackoffMs, 3000 * 2 ** (this.errors - 1));
      for (const n of noticed) this.attention.notice(`${n.key}:again`, n.what, n.salience * 0.8, 0); // 没想成，注意到的事别丢
      this.d.bus.publish('llm_error', 'P1', `脑子卡了一下：${String(e?.message ?? e).slice(0, 200)}；先凭习惯继续`);
      if (this.d.arbiter.info()?.source === 'filler') this.d.arbiter.cancel('思考失败');
      // 脑子转不动的时候：手上没活就先停下看看四周（不替它定玩法），等下一次想清楚
      if (!this.activity && !this.queuedNext) {
        const habit = this.d.thinker.idleDecision();
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
      supply: consumptionSummary(this.d.self.history(20).map((r) => r.lost)),
    }), [] as string[]);
    this.d.thinker.reflect(this.d.self, this.d.persona, controller.signal, strategy).then((c) => {
      if (this.reflecting !== controller) return;
      this.reflecting = null;
      if (!c) return;
      const { before, after, keptGoals } = this.d.self.consolidate(c);
      // 回想想放下正在推进的主目标：不替它放，告诉它，下一次认真想时自己决定
      for (const g of keptGoals) this.keptHint = `回想时觉得主目标「${g.text.slice(0, 40)}」可以放下了`;
      for (const g of keptGoals) this.d.bus.publish('goal_kept', 'P3', `回想时觉得主目标「${g.text.slice(0, 40)}」可以放下了，但它还在推进中，先留着：真要放下就在认真想时写 agenda_drop，或者换一个主目标`, { agendaId: g.id });
      for (const k of this.d.self.data.knowHow) if (c.add.includes(k.text) || c.merge.some((m) => m.text === k.text) || c.rewrite.some((r) => r.id === k.id)) {
        this.d.memory.addLesson(k.text, { source: 'model', key: `${KNOW_HOW_LESSON_KEY_PREFIX}${k.id}` });
      }
      if (c.skill?.raw && this.d.behaviors && (Array.isArray(c.skill.raw.steps) || typeof c.skill.raw.code === 'string' || typeof c.skill.raw.improve === 'string' || c.skill.raw.when !== undefined)) {
        const w = this.safe(() => this.d.behaviors!.write(c.skill!.raw, { by: 'mind' }), { ok: false as const, error: '写技能时出错' });
        if (w.ok) this.d.bus.publish('skill_written', 'P2', `回想时写下候选技能 ${w.name}；用 use_skill {name:"${w.name}",trial:true} 试用`, { name: w.name, mode: w.mode, candidate: true, live: false });
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
    // Only an explicit continue can supply its missing next draft this way.
    // new/adjust/switch retain the Agent's request to change the current work.
    if (info.nearEnd && !info.urgent && decision.activity && !decision.next && decision.kind === 'continue'
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
      // 活动结果是观察到的事实，但不能自动证明模型据此写出的任意结论。
      const k = this.d.self.learn(text, { kind: last?.kind, source: last?.hypothesis ? 'experiment' : 'reflection',
        tags: last ? Object.keys(last.gained) : [], revise });
      if (k) {
        this.lastLessonAt = Date.now();
        this.learnedActivities.add(activityId);
        if (this.learnedActivities.size > 256) this.learnedActivities.delete(this.learnedActivities.values().next().value!);
        this.d.memory.addLesson(k.text, { source: 'model', key: `${KNOW_HOW_LESSON_KEY_PREFIX}${k.id}`, replaces: previousTexts.get(k.id) });
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
        const refused = item?.kind === 'goal' ? this.goalSwitchRefusal(decision, decision.agenda.focus) : null;
        if (item && item.kind !== 'goal') decision.notes.push(`「${item.text}」是${item.kind === 'idea' ? '点子' : '疑问'}，不能当主目标：真想做就加成 goal`);
        else if (refused) { decision.notes.push(refused); this.d.bus.publish('goal_switch_refused', 'P3', refused, { to: decision.agenda.focus }); }
        else this.d.self.setAgendaStatus(decision.agenda.focus, 'active');
      }
    }
    // 先看“局部失败 → 换维度/来源”是否有新证据，再看无进展闸门。
    if (!this.enforceSourceSwitchEvidence(decision, info)) return;
    // 无进展闸门在动作入口生效：签名和最近无进展的做法相同就拒绝一次，要求换地点/方法或改计划。
    if (!this.enforceProgressGate(decision, info)) return;
    if (decision.next) {
      const current = this.d.adapter.state();
      this.queuedNext = {
        draft: decision.next, monologue: '', at: Date.now(),
        scope: { worldId: current.worldId, dim: current.dim, sessionId: current.sessionId }, epoch: this.decisionEpoch,
      };
    }

    const sameActivity = !!this.activity && this.activity.id === thoughtAboutActivity;
    if (decision.kind === 'continue') { this.activityThoughtAt = Date.now(); return; }
    const draft = decision.activity;
    if (!draft) return;
    if (decision.kind === 'adjust' && this.activity) {
      if (!sameActivity) { this.staleDropped++; return; } // 对旧活的调整，活已经换了
      const a = this.activity;
      const running = this.d.arbiter.info();
      const currentIndex = a.index - 1;
      const runningId = a.steps[currentIndex]?.id;
      // 1. 先校验整个草案的实例引用：存在、唯一、动作与参数一致。失败保留现状并反馈原因，不把错误引用解释为新动作授权。
      const referenced = new Set<string>();
      for (let i = 0; i < draft.steps.length; i++) {
        const s = draft.steps[i];
        if (typeof s.id !== 'string' || !s.id) continue;
        if (referenced.has(s.id)) { decision.notes.push(`steps[${i}] 重复引用实例 #${s.id}，调整未生效`); this.d.bus.publish('activity_adjust', 'P2', `调整被拒绝：重复引用 #${s.id}`, { planId: a.id }); return; }
        referenced.add(s.id);
        const old = a.steps.find((o) => o.id === s.id);
        if (!old) { decision.notes.push(`steps[${i}] 引用了不存在的实例 #${s.id}，调整未生效`); this.d.bus.publish('activity_adjust', 'P2', `调整被拒绝：未知实例 #${s.id}`, { planId: a.id }); return; }
        if (old.skill !== s.skill || !isDeepStrictEqual(old.args, s.args)) { decision.notes.push(`steps[${i}] 引用了实例 #${s.id} 但参数已变：要改目标就新建动作（去掉 id），调整未生效`); this.d.bus.publish('activity_adjust', 'P2', `调整被拒绝：实例 #${s.id} 参数不符`, { planId: a.id }); return; }
      }
      // 2. 决定是否保留在途任务：所有步骤统一按已验证的实例 ID 判断（省略 ID 视为新建），不用参数匹配回退。
      const sameRunning = (draftStep: { id?: string } | undefined, old: { id?: string }) => !!draftStep && !!draftStep.id && draftStep.id === old.id;
      const runningOld = a.steps[currentIndex];
      const firstIsRunning = running?.planId === a.id && sameRunning(draft.steps[0], runningOld);
      const keepsPrefix = running?.planId === a.id && currentIndex > 0 && sameRunning(draft.steps[currentIndex], runningOld)
        && a.steps.slice(0, currentIndex).every((step, i) => sameRunning(draft.steps[i], step));
      const runningIndex = keepsPrefix ? currentIndex : firstIsRunning ? 0 : -1;
      // 全部校验通过后再取消旧任务：拒绝非法调整不得取消原动作，避免原动作被取消后活动仍被记为 done。
      if (running?.planId === a.id && runningIndex < 0) {
        this.d.arbiter.cancel('改了做法');
        a.lastInterruption = { at: Date.now(), kind: 'adjusted', reason: '你的调整取消了正在执行的那个动作，它没有完成；接下来按新 routine 继续', skill: running.skill, pos: { ...this.d.adapter.state().pos } };
      }
      // 3. 分配 ID：引用保留原 ID，新建分配新 ID。
      const steps = draft.steps.map((s) => ({ ...s, id: typeof s.id === 'string' && s.id ? s.id : shortId('st_') }));
      Object.assign(a, { what: draft.what, why: draft.why || a.why, kind: draft.kind, steps, repeat: draft.repeat, iteration: 0, index: runningIndex + 1, adaptations: [], consecutiveFailures: 0,
        monologue: decision.monologue || a.monologue });
      if (draft.facing) a.facing = draft.facing; else delete a.facing;
      if (draft.doneWhen) a.doneWhen = draft.doneWhen; else delete a.doneWhen;
      // 显式的 adjust 才能改写导航目的地；路线回执里的 waypoint 永远不替换原目的地。
      retargetNavigation(a, a.steps);
      if (draft.expect) a.expect = draft.expect;
      if (draft.ifStuck) a.ifStuck = draft.ifStuck;
      const appliedKnowHow = draft.applying ? this.d.self.data.knowHow.find((k) => k.id === draft.applying) : undefined;
      if (appliedKnowHow) {
        a.applying = appliedKnowHow.id;
        a.applyingText = cleanLesson(appliedKnowHow.text);
      } else if (draft.applying) {
        // 调整时 Agent 仍明确声明了关联，但 id 已不可解析：保留原 id、快照未知，不记任何证据。
        a.applying = draft.applying;
        delete a.applyingText;
        this.d.bus.publish('decision_normalized', 'P3', `applying "${draft.applying}" 不是现有窍门 id（可能已删除/合并/改写）；保留为未解析关联，不关联任何窍门证据`);
      } else {
        delete a.applying;
        delete a.applyingText;
      }
      this.activityThoughtAt = Date.now();
      this.d.bus.publish('activity_adjust', 'P2', `改一改做法：${a.what}`, { activity: describeActivity(a, this.d.adapter.state(), this.safe(() => this.d.perception.snapshot(), undefined)) });
      this.d.bus.publish('plan', 'P2', `[${decision.source}] ${a.what} —— ${decision.monologue}`, { thought: decision.monologue, source: decision.source, steps: a.steps, planId: a.id, ...(a.facing ? { facing: a.facing } : {}) });
      return;
    }
    if (decision.kind === 'detour' && this.activity) {
      const a = this.activity;
      const running = this.d.arbiter.info();
      if (running?.planId === a.id) {
        this.d.arbiter.cancel('先去处理别的事');
        a.index = Math.max(0, a.index - 1);
        a.lastInterruption = { at: Date.now(), kind: 'detour', reason: '先去做别的事时取消了正在执行的那个动作，它没有完成；回来会从该步重做', skill: running.skill, pos: { ...this.d.adapter.state().pos } };
      }
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
    const executable = Array.isArray(raw.steps) || typeof raw.code === 'string' || typeof raw.improve === 'string' || raw.when !== undefined || raw.disable === true || raw.disabled === true || raw.restore === true || raw.from_version !== undefined;
    if (executable) {
      if (!this.d.behaviors) { decision.notes.push('这里没有行为引擎，带步骤的技能存不下'); return; }
      const w = this.safe(() => this.d.behaviors!.write(raw, { by: 'mind' }), { ok: false as const, error: '写技能时出错' });
      if (!w.ok) { decision.notes.push(`skill 没存下：${w.error}`); this.d.bus.publish('skill_rejected', 'P3', `没有保存技能：${w.error}`); return; }
      if (w.disabled) { this.d.self.think(`停用了自己的技能 ${w.name}`, 'learned'); return; }
      if (w.restored) { this.d.self.think(`恢复文字技能 ${w.name}；需要时阅读`, 'learned'); return; }
      if (w.improving) { this.d.self.think(`请后台改进代码技能 ${w.name}（改好会告诉我）`, 'learned'); return; }
      const how = `候选尚未启用；由我决定何时用 use_skill {name:"${w.name}",trial:true} 试用，实际验收后才按原定模式启用`;
      this.d.self.think(`写下${w.created ? '新' : '修订'}候选技能 ${w.name}：${how}`, 'learned');
      this.d.bus.publish('skill_written', 'P2', `写下候选技能 ${w.name}（${how}）`, { name: w.name, mode: w.mode, candidate: true, live: false });
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

  /** 阶段回顾想完了：记下结果（换了，还是接着做），隔一阵才会再回顾 */
  /** 下地那一刻记一笔；看见天空就算这趟结束 */
  private trackTrip(p: Percept, state: AgentState) {
    const below = p.self.where?.kind === 'underground' || p.self.where?.kind === 'pit' && (p.self.depth_below_surface ?? 0) >= 4
      || p.self.sky_visible === false && (p.self.depth_below_surface ?? 0) >= 6;
    if (below) { if (!this.trip) this.trip = { since: Date.now(), inventory: inventoryOf(state) }; }
    else if (p.self.sky_visible === true || p.self.where?.kind === 'surface') this.trip = null;
  }

  private closeReview(goalBefore: string | null) {
    const after = this.d.self.plan();
    const switched = !!after && after.agendaId !== goalBefore;
    this.d.bus.publish('stage_review_done', 'P2', switched ? `回顾后换了阶段目标：${after!.goal}` : `回顾后接着做：${after?.goal ?? '（还没有主目标）'}`, { switched, why: this.review?.why });
    // 接着做：给它再宽限一两天才因为“太久没做成”回顾；下次情绪提醒也隔一段随机的时间
    if (!switched) this.d.self.postponeReview(this.gameDay, (this.d.self.observedProgress()?.planGameTicks ?? 0) / 24000);
    this.review = null;
    this.lastReviewAt = Date.now();
    const [lo, hi] = Mind.REVIEW_GAP_MIN;
    this.reviewGapMs = (lo + this.d.self.rand() * (hi - lo)) * 60_000;
    this.keptHint = null;
  }

  private goalSwitchRefusal(decision: MindDecision, target: string): string | null {
    return this.d.self.goalSwitchRefusal(target, {
      review: this.inReview,
      deliberate: decision.tier === 'deliberate',
      reason: decision.plan?.switchReason ?? decision.switchReason,
      operator: decision.operator?.status === 'doing' || decision.operator?.status === 'adopted',
      releasing: [...(decision.agenda?.drop ?? []), ...(decision.agenda?.done ?? [])],
    });
  }

  /** 主目标的清单：定下/改写、勾掉做完的项；全勾掉就算主目标完成 */
  private applyPlan(decision: MindDecision) {
    const p = decision.plan;
    if (!p) return;
    const cur = this.d.self.plan();
    let autonomousRevision = false;
    if (p.steps?.length) {
      const focus = p.focus ?? cur?.agendaId ?? this.d.self.activeAgenda()?.id ?? p.goal;
      // 想把主目标换成另一件事：先看当前的阶段目标是不是还在推进（眼前的事不该顶替它）
      const refused = focus ? this.goalSwitchRefusal(decision, focus) : null;
      if (refused) {
        decision.notes.push(refused);
        this.d.bus.publish('goal_switch_refused', 'P3', refused, { to: focus });
        return;
      }
      // 改写同一个主目标的清单：清单是这一阶段要拿到的东西，不跟着眼前的事改。
      // 以前天黑、镐坏、被困一来，没做完的项就被“拿到石镐走出矿道”“爬到上层空档”这类眼前事顶掉，
      // 改来改去一个钟头，最后剩下的几项凑齐就算完成了，原来要的东西（固定矿道）根本没做
      const same = !!cur && (focus === cur.agendaId || focus === cur.goal);
      if (same && cur) {
        const next = p.steps.map((t) => cleanPlanStep(t)).filter(Boolean);
        if (next.join('|') === cur.steps.map((st) => st.text).join('|')) return this.applyPlanDone(decision); // 原样重写：什么都不用做
        const dropped = cur.steps.filter((st) => !st.done && !next.includes(st.text)).map((st) => st.text);
        if (dropped.length) {
          // 主目标不变；清单是执行计划。停滞后由 agent 按实际结果自主增删，不再强制 switch_reason；
          // 未停滞时仍要求认真想过并写理由，避免刚定下的清单被眼前的临时事顶掉。
          const stalledMin = this.d.self.planStalledMin();
          const withReason = decision.tier === 'deliberate' && !!p.switchReason;
          // 停滞时间是保护门；不按 tier 再拦：瞥一眼也可以按实际结果改，改清单提示只在认真想时出现。
          // 改写清单不算推进，停滞计时不会因改写清零：只看停滞的话，过了阈值之后每一念都能随手删项，
          // 清单就跟着眼前一念来回改（2026-11-10 半小时 28 次，回主世界补给这项被反复删了又加）。
          // 不写理由的自主删项还要求离上次改写也过了同样久，让新清单先按它试一段；写 switch_reason 随时可改。
          const lastRevised = cur.revisedAt?.at(-1);
          const sinceRevisionMin = lastRevised === undefined ? Infinity : (Date.now() - lastRevised) / 60_000;
          const canRevise = stalledMin >= PLAN_REVISION_MIN && sinceRevisionMin >= PLAN_REVISION_MIN;
          if (!withReason && !canRevise) {
            const why = decision.tier === 'glance' ? '瞥一眼时不改清单'
              : stalledMin >= PLAN_REVISION_MIN
                ? `上次改清单在 ${Math.round(sinceRevisionMin)} 分钟前（现实时间），新清单还没试满 ${PLAN_REVISION_MIN} 分钟；真要删改就在 plan 里写 "switch_reason" 说为什么`
                : `要删改没做完的项得在 plan 里写 "switch_reason" 说为什么（比如这一项做不成、换了更好的做法）；清单观察停滞 ${PLAN_REVISION_MIN} 分钟后可以直接按实际结果改`;
            decision.notes.push(`清单没改：「${dropped.slice(0, 3).join('」「')}」还没做完，${why}。眼前的事（脱困、回地面、补工具、过夜）写成 activity 或 detour，做完会回到清单；新冒出来的必要步骤可以加在后面，不用删旧的`);
            this.d.bus.publish('plan_rewrite_refused', 'P3', `主目标「${cur.goal}」的清单没改：没做完的「${dropped.slice(0, 3).join('」「')}」不随眼前的事删掉`, { dropped, tier: decision.tier });
            return this.applyPlanDone(decision);
          }
          if (!withReason) {
            autonomousRevision = true;
            decision.notes.push(`清单按已观察 ${Math.round(stalledMin)} 分钟无进展自主调整：删掉了「${dropped.slice(0, 3).join('」「')}」；主目标「${cur.goal.slice(0, 30)}」不变`);
          }
        }
      }
      // 模型自己写了 focus（不是沿用手上的活或议程）：它挑中的点子可以升成目标
      const set = focus ? this.d.self.setPlan(focus, p.steps, p.conditions ?? [], { promote: !!p.focus && p.focus === focus }) : null;
      if (set && same && p.switchReason) this.d.self.think(`改了「${set.goal}」的清单：${p.switchReason}`, 'monologue');
      if (set) {
        // 认真写了新计划（换清单或换主目标）就是对无进展循环的回应：闸门放行。
        this.progressGate = null;
        this.progressGateRejects = 0;
        this.d.bus.publish('plan_set', 'P2', `主目标「${set.goal}」：${set.steps.map((st) => `${st.done ? '☑' : '☐'}${st.text}`).join(' ')}`, { agendaId: set.agendaId });
      }
      else {
        const item = focus?.startsWith('a_') ? this.d.self.agenda().find((a) => a.id === focus) : undefined;
        decision.notes.push(item && item.kind !== 'goal'
          ? `plan 没定下来：${focus}「${item.text.slice(0, 30)}」是${item.kind === 'idea' ? '点子' : '疑问'}，要当主目标就在 plan 里写 focus 和 steps（清单至少一项），或者把 focus 直接写成一句话的目标（会新建一个目标）`
          : focus?.startsWith('a_') && !item ? `plan 没定下来：议程里没有 ${focus}；focus 写议程里某个目标的 id，或者直接写一句话的目标（会新建一个目标），还要有 steps`
          : 'plan 没定下来：focus 写议程里某个目标的 id，或者直接写一句话的目标（会新建一个目标）；还要有 steps（清单至少一项）');
      }
    }
    this.applyPlanDone(decision, { skipGoalCompletion: autonomousRevision });
  }

  /** 勾掉清单里做完的项；全勾掉就算主目标完成。自主删项的那一念不能顺手把主目标标完成。 */
  private applyPlanDone(decision: MindDecision, opts: { skipGoalCompletion?: boolean } = {}) {
    const p = decision.plan;
    if (!p) return;
    if (p.done?.length) {
      const s = this.d.adapter.state(), percept = this.safe(() => this.d.perception.snapshot(), undefined);
      const refused: string[] = [];
      const checked = this.d.self.checkPlan(p.done, (c) => evaluateCondition(c, s, s.worldId, [], percept).status === 'satisfied', refused);
      if (checked.length) {
        // 勾掉清单项是真实进展：无进展闸门放行。
        this.progressGate = null;
        this.progressGateRejects = 0;
        this.d.bus.publish('plan_check', 'P3', `勾掉：${checked.join('、')}`);
      }
      if (refused.length) decision.notes.push(`没勾掉「${refused.join('、')}」：它的 done_when 条件实际还没达到`);
      const now = this.d.self.plan();
      if (!opts.skipGoalCompletion && now && now.steps.length && now.steps.every((st) => st.done)) {
        this.d.self.setAgendaStatus(now.agendaId, 'done');
        this.d.self.think(`「${now.goal}」的清单都做完了`, 'outcome');
        this.d.bus.publish('plan_done', 'P2', `主目标完成：${now.goal}`);
      }
    }
  }

  /** Focus reminders preserve the Agent's explicit choice and scheduling. */
  private guardFocus(decision: MindDecision, thoughtAboutActivity: string | null, urgent: boolean) {
    const a = this.activity;
    if (!a || urgent || !decision.activity) return;
    if (decision.kind === 'switch' && decision.tier === 'glance') {
      decision.notes.push(`这次 switch 会放下「${a.what}」，不会自动回来；保留你的明确决定`);
      return;
    }
    const running = this.d.arbiter.info();
    const stepRunning = !!running && running.source !== 'filler' && running.source !== 'reflex' && running.planId === a.id;
    const young = Date.now() - this.activityThoughtAt < 25_000;
    if (decision.kind === 'adjust' && decision.tier === 'glance' && a.id === thoughtAboutActivity && a.failures === 0
      && (young || stepRunning || decision.saidContinue)) {
      decision.notes.push(`「${a.what}」${stepRunning ? '手上这一步正在做' : '刚开工'}、尚未失败；这次按你明确选择的 adjust 改做法`);
    }
  }

  private say(text: string, decision: MindDecision) {
    const t = text.replace(/[\r\n]+/g, ' ').trim();
    if (!t || t.startsWith('/') || t === this.lastSay.text || Date.now() - this.lastSay.at < this.timing.sayGapMs) return;
    const state = this.d.adapter.state();
    const changedMind = ['switch', 'detour', 'experiment'].includes(decision.kind);
    const discovered = this.speechEventAt > this.lastSay.at && Date.now() - this.speechEventAt <= 60_000;
    const completed = this.lastRecord?.outcome === 'done' && this.lastRecord.completion !== 'condition' && this.lastRecord.at > this.lastSay.at;
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
    if (now.sessionId !== prev.sessionId || now.dim !== prev.dim) return [`${secs} 现实秒里换了世界/维度`];
    const out: string[] = [`距上次想事情 ${secs} 现实秒`];
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
  /** 操作者用「紧急救援」把它从卡住的地方传送走了：手上那段活作废（是在原地的打算），按新位置马上重新想 */
  rescued(what: string) {
    this.dropActivity('interrupted', '被操作者紧急传送到了别处');
    this.suspended = [];
    const n = this.attention.notice('rescued', what, 0.95, 0);
    if (n) this.d.bus.publish('notice', 'P2', `注意到：${n.what}`, { salience: n.salience, level: n.level });
    this.backoffUntil = 0;
    this.cancelThinking('rescued');
    this.requestThink(what, 'deliberate');
  }
  replan() {
    this.backoffUntil = 0;
    this.cancelThinking('manual_replan');
    this.requestThink('操作者让我重新想想', 'deliberate');
  }
  pause() {
    this.paused = true;
    this.setObservedOnline(false);
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
    this.setObservedOnline(false);
    // 游戏的死亡播报是原话（“Curio was blown up by Creeper”），比推测的死因可靠
    const cause = info.message ? `游戏播报：${info.message}` : info.cause ? causeName(info.cause) : '不明原因';
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
  onDisconnected() { this.setObservedOnline(false); this.suspend('disconnected'); this.d.arbiter.cancel('断线'); }

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
        mood: self.mood, feeling: moodWords(self.mood), traits: self.data.traits, likes: self.tastes(), habits: self.habits(),
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
