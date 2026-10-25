import type { Step } from '../arbiter/arbiter.ts';
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
export type ActivityStep = Step & { optional?: boolean };

export interface StepResult { skill: string; args?: unknown; status: string; failureCode?: string; summary: string; at: number; durationMs: number; pos?: { x: number; y: number; z: number }; view?: string }

/** 只保留最近十分钟的结束经历，用来认出在同一带反复失败。 */
export interface ActivityEnd {
  pos: { x: number; y: number; z: number };
  outcome: ActivityOutcome;
  failureCode?: string;
  what: string;
  at: number;
}

export interface StuckHere { minutes: number; tried: string[]; failureCode: string; lastAt: number }

/** 一段活：模型给出 routine，身体负责连续执行、重复和小范围的应变 */
export interface Activity {
  id: string;
  what: string;
  why: string;
  kind: ActivityKind;
  steps: ActivityStep[];
  /** routine 最多做几轮（done_when 先满足就提前收工） */
  repeat: number;
  iteration: number;
  /** 下一个要做的步骤序号 */
  index: number;
  doneWhen?: Condition;
  /** 自己的预想（自由文字），收工后和实际结果放在一起回看 */
  expect?: string;
  /** 卡住时的备选思路（交给下一次思考，不自动执行） */
  ifStuck?: string;
  hypothesis?: string;
  agendaId?: string;
  source: 'llm' | 'rule' | 'habit';
  monologue: string;
  startedAt: number;
  failures: number;
  consecutiveFailures: number;
  /** 本段活里身体自己做过的应变（换个地方找、重试），每种只做一次 */
  adaptations: string[];
  dropped?: string[];
  /** 被身体反射打断了几次 */
  interruptions?: number;
  /** 刚试过的恢复技能：等重做的那一步出结果再给它记成败 */
  awaitingRecovery?: string;
  results: StepResult[];
  startInventory: Record<string, number>;
  /** 上一步开工时的身体/视野；只有环境确实变化才原样重试。 */
  stepStart?: { pos: { x: number; y: number; z: number }; view?: string };
}

export type ActivityOutcome = 'done' | 'stuck' | 'abandoned' | 'interrupted' | 'replaced';

export interface ActivityRecord {
  id: string; what: string; kind: ActivityKind; outcome: ActivityOutcome; summary: string; durationSec: number;
  gained: Record<string, number>; lost: Record<string, number>; expect?: string; hypothesis?: string; at: number;
  signature: string; failures: number;
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
  createdAt: number;
  updatedAt: number;
  source: 'reflection' | 'experiment' | 'observed';
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
  /** 琢磨出的一整套做法，写成自己的技能（raw 是原始对象：带 when/steps 时交给行为引擎，写下就生效） */
  skill?: { name: string; description: string; body: string; raw?: Record<string, unknown> };
  diary?: string;
  monologue?: string;
}

export interface DiaryEntry { at: number; text: string; dim: string; pos: [number, number, number] }

/** 模型输出、校验过的一次决定 */
/** 模型给身体定下的顺手习惯：不定就不做（身体不会自作主张插火把、吃东西、捡东西） */
export interface Habits {
  /** 走路挖矿时，暗处（亮度 ≤7）每隔几格插一支火把；0 = 不插 */
  torch_every?: number;
  /** 饥饿降到多少就顺手吃（只吃正经食物）；0 = 不顺手吃 */
  eat_below?: number;
  /** 想事情的空档捡脚边的掉落物 */
  pickup?: boolean;
}

export interface MindDecision {
  kind: DecisionKind;
  monologue: string;
  say?: string;
  activity?: ActivityDraft;
  next?: ActivityDraft;
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
  plan?: { focus?: string; goal?: string; steps?: string[]; done?: (number | string)[] };
  /** 整个换掉手上的事的理由（有主目标时 switch 必须写） */
  switchReason?: string;
  /** 校验时自动纠正/丢弃的部分（下次思考时告诉模型） */
  notes: string[];
  source: 'llm' | 'rule';
  tier: 'glance' | 'deliberate';
  requestedAt: number;
}

export interface ActivityDraft {
  what: string; why: string; kind: ActivityKind; steps: ActivityStep[]; repeat: number;
  doneWhen?: Condition; expect?: string; ifStuck?: string; agendaId?: string;
  /** 写了但没法执行、被丢掉的步骤（让心智知道它们根本没做） */
  dropped?: string[];
}
