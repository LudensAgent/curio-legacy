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
  steps: Step[];
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

export interface DiaryEntry { at: number; text: string; dim: string; pos: [number, number, number] }

/** 模型输出、校验过的一次决定 */
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
  /** 校验时自动纠正/丢弃的部分（下次思考时告诉模型） */
  notes: string[];
  source: 'llm' | 'rule';
  tier: 'glance' | 'deliberate';
  requestedAt: number;
}

export interface ActivityDraft {
  what: string; why: string; kind: ActivityKind; steps: Step[]; repeat: number;
  doneWhen?: Condition; expect?: string; ifStuck?: string; agendaId?: string;
}
