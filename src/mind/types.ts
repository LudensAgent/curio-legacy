import type { Step } from '../arbiter/arbiter.ts';
import type { Facing } from '../perception/local.ts';
import type { Condition } from '../projects/types.ts';

/**
 * 心智层的基本概念（模仿真人玩家的思路，而不是“一次决策 = 一串技能调用”）：
 *
 *   议程 Agenda（今天/以后想做的事、冒出来的点子和疑问）
 *     └─ 活动 Activity（几分钟的一段活，例如“砍够 20 个原木”“往东边那座山走过去看看”）
 *          └─ 动作 Step（手脚：一次 gather/goto/craft…）
 *
 * 模型只在“这段活的粒度”上做决定，身体按 routine 连续地做下去；
 * 注意力（Attention）决定什么时候值得抬头重新想一想。
 */

export type ActivityKind = 'gather' | 'craft' | 'build' | 'explore' | 'survive' | 'rest' | 'experiment' | 'tidy' | 'social' | 'other';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['gather', 'craft', 'build', 'explore', 'survive', 'rest', 'experiment', 'tidy', 'social', 'other'];

export type DecisionKind = 'continue' | 'adjust' | 'new' | 'detour' | 'switch' | 'experiment' | 'rest';
export const DECISION_KINDS: readonly DecisionKind[] = ['continue', 'adjust', 'new', 'detour', 'switch', 'experiment', 'rest'];

/** routine 里的一步；optional = 顺手、碰运气的事（见到动物就打、有果子就摘），失败了这段活照常往下做 */
export type ActivityStep = Step & { optional?: boolean; /** 逻辑动作实例 ID，区分同参数的不同动作，跨重试/恢复/计划调整稳定 */ id?: string };

export interface StepResult {
  skill: string; args?: unknown; status: string; failureCode?: string; summary: string; at: number; durationMs: number;
  pos?: { x: number; y: number; z: number }; view?: string;
  /** 动作结束观察到的世界/维度；用于反思时保留失败作用域，不拿活动结束时的位置回填。 */
  worldId?: string; dim?: string;
  /** 只保留判定“定位/取得/移动/覆盖”用的回执字段，不把整份 local 图塞进活动历史。 */
  data?: Record<string, unknown>;
}

/** 只保留最近十分钟的结束经历，用来认出在同一带反复失败。 */
export interface ActivityEnd {
  pos: { x: number; y: number; z: number };
  outcome: ActivityOutcome;
  failureCode?: string;
  skill?: string;
  what: string;
  summary: string;
  at: number;
}

/** 导航目标的概念阶段；只是当前委托的状态模型，不是新的任务存储。 */
export type NavigationPhase = 'planning' | 'executing' | 'segment_completed' | 'observing' | 'replanning' | 'waiting_for_agent_decision' | 'arrived' | 'failed' | 'cancelled';

/**
 * 放在当前 Activity 里的导航目标：只保留现在这一段委托的目标、进度、失败、来源与策略。
 * 空间历史仍由 SharedSpatialSession/VoxelMap/TraversalStore 承担，这里不复制路点历史或体素。
 */
export interface NavigationProgress {
  /** 稳定的委托 ID（Activity.id）。Arbiter 的派发任务 ID 每次自动续跑都会变；预算按这份委托共享。 */
  delegationId: string;
  /** Agent 最初选择的目的地；不会被最近一段的 waypoint 替换。 */
  destination?: { x: number; y: number; z: number };
  /** Agent 为这段委托声明的到达条件（done_when 快照）；精确目标格由 destination 表示。 */
  arrivalCondition?: Condition;
  /** 目标所在世界/维度；从实测位置重新规划时更新为新作用域，保留原目的地。 */
  worldId: string;
  dim: string;
  /** 最近一次实测位置；下一段从这里复核，不复用旧相对目标。 */
  measured: { pos: { x: number; y: number; z: number }; at: number };
  /** 当前段的实测起点。 */
  segmentStart?: { x: number; y: number; z: number };
  /** 已确认完成的段数（跨执行累计，只留计数）。 */
  completedSegments: number;
  /** 当前计划的剩余目标；只保留这一条路线，不保留已走历史。 */
  remaining: { x: number; y: number; z: number }[];
  /** 父委托的期限快照，来自现有 beginStep/stepExpiry 账本；这里只读展示，不另设预算。 */
  parentDeadlineMs?: number;
  /** 最后确认经过的位置。 */
  lastConfirmed?: { pos: { x: number; y: number; z: number }; at: number };
  /** 最近一次失效/失败，只留最新一条。 */
  lastInvalidation?: { at: number; reason: string };
  lastFailure?: { at: number; code?: string; summary: string };
  /** 最近一段导航的做法/来源（技能 + route source），不是理由或历史。 */
  strategy?: string;
  phase: NavigationPhase;
  updatedAt: number;
}

/** 一段活：模型给出 routine，身体负责连续执行、重复和小范围的应变 */
export interface Activity {
  id: string;
  what: string;
  why: string;
  kind: ActivityKind;
  /** 相对坐标的前方参考系，独立于镜头朝向，不限定实际推进方向。 */
  facing?: Facing;
  steps: ActivityStep[];
  /** routine 最多做几轮（done_when 先满足就提前收工） */
  repeat: number;
  iteration: number;
  /** 下一个要做的步骤序号 */
  index: number;
  doneWhen?: Condition;
  /** 这一段是由已满足的收工条件结束的，不能推断自由文本目标也已完成。 */
  conditionTriggered?: boolean;
  /** 收工条件开工前就成立/不能验收目标：这段按“有界尝试”记录，不当作目标完成。 */
  attemptOnly?: { reason: string; originalDoneWhen?: Condition };
  /** 计划声称要走远/找资源，但步骤里没有会实际改变位置的动作。 */
  planCoverageGap?: string;
  /** 自己的预想（自由文字），收工后和实际结果放在一起回看 */
  expect?: string;
  /** 卡住时的备选思路（交给下一次思考，不自动执行） */
  ifStuck?: string;
  hypothesis?: string;
  agendaId?: string;
  source: 'llm' | 'rule' | 'habit';
  monologue: string;
  startedAt: number;
  /** 开工时的身体位置；结束时的实测位移和覆盖范围从这里算，不靠自然语言。 */
  startPos: { x: number; y: number; z: number };
  /** 开工时已访问区块数；结束时用它算新区块，避免把活动期间已有的探索算成这一趟的。 */
  startChunks?: number;
  failures: number;
  consecutiveFailures: number;
  /** 本段活里身体自己做过的应变（换个地方找、重试），每种只做一次 */
  adaptations: string[];
  /** 同一实际目标格的重复空挖；移动、挖掘或放置取得进展后重新计数。 */
  airDigs?: Record<string, { target: { x: number; y: number; z: number }; count: number }>;
  /** 同一步多轮在同一个下行目标前停下时，保留实际停因交回心智。 */
  partialStops?: Record<string, { pos: { x: number; y: number; z: number }; below: string | null; iteration: number; count: number }>;
  /** 各逻辑动作实例的额度账本（如 climb_up 的原高度、逻辑起点与已确认爬升），跨重试/恢复共享；每轮开始与计划调整时重置。 */
  climb?: Record<string, { height: number; spent: number; startY: number }>;
  dropped?: string[];
  /** 被身体反射打断了几次 */
  interruptions?: number;
  /** 最近一次还没完成这一步就被打断：身体反射或受伤；只记原因、动作与当时位置。 */
  lastInterruption?: { at: number; kind: 'body_reflex' | 'hurt' | 'adjusted' | 'detour'; reason: string; skill: string; pos?: { x: number; y: number; z: number } };
  /** 这段活在按哪条已学窍门做（k_…）：结果只作为那条窍门的应用证据，不自动证明结论正确。 */
  applying?: string;
  /** 开工时那条窍门的原文快照；同一 id 后来被改写时，旧活动不能替新结论记成功。 */
  applyingText?: string;
  /** 刚试过的恢复技能：等重做的那一步出结果再给它记成败 */
  awaitingRecovery?: string;
  results: StepResult[];
  startInventory: Record<string, number>;
  /** 被绕路的事放下的时刻（回来时要先想想还做不做） */
  suspendedAt?: number;
  /** 上一步开工时的身体/视野；只有环境确实变化才原样重试。 */
  stepStart?: { pos: { x: number; y: number; z: number }; view?: string };
  /**
   * 上一步放置/移动改变了脚格：下一步若为相对动作，先按上一动作开始前的锚点重绑定；
   * 绑定不上才报告依赖缺口。intendedStandTarget 是 place_support 确认的支撑顶面上的脚位。
   */
  stanceGap?: {
    skill: string; pos: { x: number; y: number; z: number };
    /** 副作用发生前的身体位置（相对坐标的原锚点）。 */
    before?: { x: number; y: number; z: number };
    intendedStandTarget?: { x: number; y: number; z: number };
  };
  /** 这段活里已确认的物理效果；attempt_end 据此汇总，不把已放置/支撑 + 位移误报成“无变化”。 */
  effects?: { placements: string[]; removed: number; moved: boolean };
  /** 当前导航委托的目标/进度/失败/来源；只存在于这段 Activity 内，不新建导航任务库。 */
  navigation?: NavigationProgress;
}

/** 一次采集的结构化回执：数量来自实际物品差量，不是挖掉的方块数。 */
export interface CollectionReceipt {
  block: string;
  items: string[];
  initial: number;
  target: number;
  final: number;
  gained: number;
  /** 实际挖掉的方块数；掉落没进背包时与 gained 不相等。 */
  dug: number;
  targetMet: boolean;
  lost?: number;
}

/** 写进活动记录的历史回执快照：带上产生它的动作、参数与时间，不代表当前背包。 */
export type CollectionRecord = CollectionReceipt & { skill: string; args?: unknown; at: number };

export type ActivityOutcome = 'done' | 'unmet' | 'stuck' | 'abandoned' | 'interrupted' | 'replaced';

export interface ActivityRecord {
  id: string; what: string; kind: ActivityKind; outcome: ActivityOutcome; summary: string; durationSec: number;
  /** 当时采用的相对坐标参考系，供下一段核对。 */
  facing?: Facing;
  /** 收工条件只是中止这段活动的触发依据，不自动验证活动描述中的全部目标。 */
  completion?: 'condition' | 'steps' | 'unmet' | 'attempt';
  /** 操作本身结束 ≠ 资源目标完成；这两件事分开记。旧记录没有该字段时不要猜。 */
  operationCompleted?: boolean;
  /** 资源型活动的定位/取得/上层目标状态；从执行回执和背包变化算，不靠模型口述。 */
  resource?: { intent: boolean; located: boolean; acquired: boolean; goalIncomplete: boolean };
  /** 最近一次采集回执的历史快照（不代表当前背包）；供活动结束后的最近记录与回想使用。 */
  collection?: CollectionRecord;
  /** 实测探索覆盖：位置来自每步回执，不来自活动标题。 */
  exploration?: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; maxHorizontal: number; visitedCells: number; newChunks: number | null; searchIntent: boolean; localOnly: boolean };
  gained: Record<string, number>; lost: Record<string, number>; expect?: string; hypothesis?: string; at: number;
  signature: string; failures: number;
  /** 这段活显式关联的窍门（k_…）；用于把后续实际应用交给对应经验的证据账。 */
  applying?: string;
  /** 开工时那条窍门的原文快照：同一 id 后来被改写时，旧活动不能替新结论记成功。 */
  applyingText?: string;
  /** 最近一次失败步骤的真实动作、授权参数、时间、作用域、位置与回执；总结压缩后仍保留失败条件。 */
  failure?: { skill: string; args?: unknown; code: string | null; summary: string; at: number; worldId?: string; dim?: string; pos?: { x: number; y: number; z: number } };
}

export interface AgendaItem {
  id: string;
  text: string;
  kind: 'goal' | 'idea' | 'question';
  horizon: 'today' | 'someday';
  status: 'open' | 'active' | 'done' | 'dropped';
  createdAt: number;
  updatedAt: number;
  /** 为它做过几段活 */
  attempts: number;
  note?: string;
}

/** 自己总结出来的“窍门”：带成败次数，后面的实际结果会不断修正它的可信度 */
export interface KnowHow {
  id: string;
  text: string;
  /** 适用的活动类型与相关物品（用来挑出和眼下有关的经验） */
  kind?: ActivityKind;
  tags: string[];
  signature?: string;
  wins: number;
  losses: number;
  unverified?: boolean;
  /** 后续活动显式声明 applying:<id> 时留下的应用证据；只供复核，不由程序自动宣告结论正确。 */
  applications?: { at: number; activityId: string; outcome: ActivityOutcome; completion?: ActivityRecord['completion']; summary: string; failure?: ActivityRecord['failure'] }[];
  createdAt: number;
  updatedAt: number;
  source: 'reflection' | 'experiment' | 'observed';
  /**
   * 改写/合并之前的说法累计下来的成败：新说法的成败从零重新计，但旧说法的记录不丢，
   * 否则一条一直失败的窍门换个措辞就把失败史洗掉了。只是历史事实，留不留由 Agent 决定。
   */
  prior?: { wins: number; losses: number; revisions: number; lastText: string };
}

export interface Experiment {
  id: string;
  hypothesis: string;
  activityId: string;
  status: 'running' | 'supported' | 'refuted' | 'unclear';
  evidence?: string;
  at: number;
}

export interface Mood {
  /** 精力：长时间干活下降，休息/睡觉恢复 */
  energy: number;
  /** 无聊：同一类事做太多上升，新鲜事下降 */
  boredom: number;
  /** 烦躁：失败上升，成功和时间冲淡 */
  frustration: number;
  /** 满足：做成东西、拿到新东西上升，慢慢回落 */
  satisfaction: number;
  /** 好奇：看见没见过的东西上升，去看过/试过后下降 */
  curiosity: number;
}

export interface Thought { at: number; text: string; kind: 'monologue' | 'notice' | 'outcome' | 'learned' | 'feeling' }

export interface Noticing { at: number; key: string; what: string; salience: number; level: 'note' | 'reconsider' | 'urgent' }

/** 休息/睡前回想时对窍门的整理（模型输出、校验后） */
export interface Consolidation {
  rewrite: { id: string; text: string }[];
  merge: { ids: string[]; text: string }[];
  drop: string[];
  add: string[];
  agendaDrop: string[];
  /** 策略回顾想出的新玩法：放进议程的点子或目标 */
  agendaAdd?: { text: string; kind: 'goal' | 'idea'; horizon: 'today' | 'someday' }[];
  /** 琢磨出的一整套做法，写成自己的技能（raw 是原始对象：带 when/steps 时交给行为引擎，写下就生效） */
  skill?: { name: string; description: string; body: string; raw?: Record<string, unknown> };
  diary?: string;
  monologue?: string;
}

export interface DiaryEntry { at: number; text: string; dim: string; pos: [number, number, number] }

/** 模型输出、校验过的一次决定 */
/** 模型设定的身体习惯和注意偏好；拾取仍需当次明确选择动作。 */
export interface Habits {
  /** 走路挖矿时，暗处（亮度 ≤7）每隔几格插一支火把；0 = 不插 */
  torch_every?: number;
  /** 饥饿降到多少就顺手吃（只吃正经食物）；0 = 不顺手吃 */
  eat_below?: number;
  /** 看见新掉落物时用轻量思考决定是否捡；关闭时只随下次思考提供事实，不自动拾取。 */
  pickup?: boolean;
}

export interface MindDecision {
  kind: DecisionKind;
  monologue: string;
  say?: string;
  activity?: ActivityDraft;
  /** 预排的下一段；requires 是它开始前的前置条件，不是当前活动的收工条件。 */
  next?: NextDraft;
  agenda?: { add: { text: string; kind: AgendaItem['kind']; horizon: AgendaItem['horizon'] }[]; done: string[]; drop: string[]; focus?: string };
  learned?: string | { revise: string; text: string };
  hypothesis?: string;
  /** 上一段实验的结论（模型看完实际结果后的判断） */
  verdict?: 'supported' | 'refuted' | 'unclear';
  /** 想写进日记的一句话（今天发生了什么值得记住的事） */
  diary?: string;
  /** 刚发现自己喜欢的东西 */
  liked?: string;
  /** 给身体定的习惯（长期有效，直到改掉） */
  habits?: Habits;
  /** 写下的技能（原始对象，交给行为引擎/技能书校验）：带 steps 的写下就生效 */
  skill?: Record<string, unknown>;
  /** 主目标的清单：定下/改写（focus + steps），或勾掉做完的项（done） */
  plan?: { focus?: string; goal?: string; steps?: string[]; done?: (number | string)[]; conditions?: (import('../projects/types.ts').Condition | null)[]; switchReason?: string };
  /** 整个换掉手上的事的理由（有主目标时 switch 必须写） */
  switchReason?: string;
  /** 刚才的事值得练成技能：哪里出了问题、想学会什么（后台据此写技能） */
  worthLearning?: string;
  /** 模型嘴上说的是 continue（只是顺手写了一段活，被当成 adjust）：手上的活还在顺利做时不该被它打断 */
  saidContinue?: boolean;
  /** 对操作者指令的回应：照做中 / 做完了 / 做不到（附原因） */
  operator?: { status: 'doing' | 'done' | 'cannot' | 'adopted' | 'declined'; note?: string };
  /** 校验时自动纠正/丢弃的部分（下次思考时告诉模型） */
  notes: string[];
  source: 'llm' | 'rule';
  tier: 'glance' | 'deliberate';
  requestedAt: number;
}

export interface ActivityDraft {
  what: string; why: string; kind: ActivityKind; steps: ActivityStep[]; repeat: number;
  /** 相对坐标的前方参考系，独立于镜头朝向。 */
  facing?: Facing;
  /** 这段活在按哪条已学窍门做（k_…）；只作为应用证据，不自动验证结论。 */
  applying?: string;
  doneWhen?: Condition; expect?: string; ifStuck?: string; agendaId?: string;
  /** 写了但没法执行、被丢掉的步骤（让心智知道它们根本没做） */
  dropped?: string[];
}

/** 预排的下一段：requires 只决定它能否开始，不是当前活动的收工条件。 */
export type NextDraft = ActivityDraft & { requires?: Condition };
