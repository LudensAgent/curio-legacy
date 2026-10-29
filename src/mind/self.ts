import fs from 'node:fs';
import path from 'node:path';
import { shortId } from '../util.ts';
import type { ActivityKind, ActivityRecord, AgendaItem, DiaryEntry, Experiment, Habits, KnowHow, Mood, Thought } from './types.ts';

interface SelfData {
  version: 1;
  traits: string[];
  mood: Mood;
  moodAt: number;
  agenda: AgendaItem[];
  knowHow: KnowHow[];
  experiments: Experiment[];
  diary: DiaryEntry[];
  history: ActivityRecord[];
  stream: Thought[];
  /** 每个技能的手感：做成/失败次数与平均耗时 */
  feel: Record<string, { ok: number; fail: number; ms: number }>;
  /** 去过的维度（第一次到的时刻）：第一次到一个地方就是“新环境” */
  visited?: Record<string, number>;
  /** 还没来得及整理的零碎想法：休息/睡前回想时再决定留不留 */
  insights?: { at: number; text: string; outcome?: string }[];
  /** 自己发现的喜好（风景、方块、玩法）：会影响想做什么 */
  likes?: { at: number; text: string }[];
  /** 上次回想的时间与当时的窍门数 */
  reflectedAt?: number;
  knowHowAtReflect?: number;
  habits?: Habits;
  /** 主目标和它的待办清单（像 agent 的 todo 列表）：每段活都应该推进其中没勾掉的一项 */
  plan?: FocusPlan;
  /** 最近几个主目标（阶段目标）的起止和结局：回顾阶段目标时看自己是不是一直在原地打转 */
  stages?: StageRecord[];
  observedProgress?: ObservedProgress;
}

export interface StageRecord { goal: string; setAt: number; endAt: number; outcome: 'done' | 'dropped' | 'switched'; stepsDone: number; steps: number }
export interface ObservedProgress {
  planId: string | null;
  planGameTicks: number;
  planObservedSince: number | null;
}

export interface FocusPlan { agendaId: string; goal: string; steps: { text: string; done: boolean; doneWhen?: import('../projects/types.ts').Condition; auto?: boolean }[]; setAt: number; updatedAt: number;
  /** 上一次真正推进（定下清单或勾掉一项）的时间 */
  progressAt?: number;
  /** 已观察的在线停滞时长；历史数据不足时只表示下限。 */
  stalledOnlineMs?: number;
  stalledObservedSince?: number;
  stalledHistoryUnknown?: boolean;
  /** 定下时是游戏里的第几天 */
  setDay?: number;
  /** 过了这么多游戏天还没做成，就停下来回顾要不要换（定下时在 3–5 天里随机，回顾后接着做会往后推） */
  reviewDays?: number }

/** 清单项的文字：去掉模型从【专注】里抄回来的“0. [ ] ”这类格式 */
export const cleanPlanStep = (t: string) => { let s = String(t).trim(), prev = ''; while (s !== prev) { prev = s; s = s.replace(/^(?:\d+[.、)]\s*|\[[ xX✓]?\]\s*|[☐☑●○▶-]\s*)/, '').trim(); } return s.slice(0, 60); };

export const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export const DEFAULT_MOOD: Mood = { energy: 0.9, boredom: 0.2, frustration: 0, satisfaction: 0.4, curiosity: 0.6 };

/**
 * 情绪随时间自然回归：烦躁和满足淡去、精力在不干活时恢复、好奇慢慢回到中等。
 * 无聊跟着主目标走：干活时目标一直有进展就几乎不腻；很久没勾掉一项（stalled）还在干，才越干越腻。
 */
export function relaxMood(m: Mood, seconds: number, working: boolean | 'waiting', opts: { stalled?: boolean } = {}): Mood {
  const k = Math.min(1, seconds / 600);
  // 干等（躲在坑里熬夜、原地等天亮）最容易无聊：人蹲两三分钟就坐不住了，会想“这段时间能干点什么”
  const waiting = working === 'waiting';
  return {
    energy: clamp01(working === true ? m.energy - seconds / 5400 : m.energy + seconds / 900),
    boredom: clamp01(m.boredom + (waiting ? seconds / 360 : working ? seconds / (opts.stalled ? 3600 : 10800) : -seconds / 1200)),
    frustration: clamp01(m.frustration * (1 - k * 0.8)),
    // 成就感淡得比以前快（约十来分钟淡一半）：持续的满足要靠持续的进展撑着
    satisfaction: clamp01(m.satisfaction + (0.35 - m.satisfaction) * k * 1.5),
    curiosity: clamp01(m.curiosity + (0.5 - m.curiosity) * k * 0.3),
  };
}

export type MoodEvent =
  | { type: 'step'; ok: boolean }
  | { type: 'activity_end'; outcome: ActivityRecord['outcome']; sameKindStreak: number; gainedKinds: number }
  | { type: 'novelty'; strength: number }
  | { type: 'hurt'; amount: number }
  | { type: 'death' }
  | { type: 'rest'; seconds: number }
  | { type: 'sleep' }
  /** 主目标的清单勾掉了一项 */
  | { type: 'progress' }
  /** 主目标整个做完了 */
  | { type: 'goal_done' }
  /** 换上了一个新的主目标 */
  | { type: 'goal_set' }
  /** 游戏进度上第一次做到一件事（里程碑） */
  | { type: 'milestone' };

/**
 * 事件对情绪的影响：都是可解释的小幅变化，模型看到的是“为什么会这样觉得”。
 * 成就感来自真正的进展（勾掉主目标的一项、做完主目标、游戏里第一次做到某事），
 * 不来自挖一格、吃一口这种每分钟几十次的小动作——以前每个成功的动作都加一点，满足一直是满的，等于没有信号。
 */
export function feel(m: Mood, e: MoodEvent): Mood {
  const n = { ...m };
  if (e.type === 'step') {
    if (e.ok) { n.frustration -= 0.03; } else { n.frustration += 0.09; n.satisfaction -= 0.01; }
  } else if (e.type === 'activity_end') {
    if (e.outcome === 'done') { n.satisfaction += 0.02 + Math.min(0.06, e.gainedKinds * 0.02); n.frustration -= 0.1; }
    if (e.outcome === 'stuck') { n.frustration += 0.12; n.satisfaction -= 0.04; }
    n.boredom += e.sameKindStreak >= 3 ? 0.12 : e.sameKindStreak <= 1 ? -0.08 : 0.03;
  } else if (e.type === 'novelty') {
    n.curiosity += 0.15 * e.strength; n.boredom -= 0.2 * e.strength; n.satisfaction += 0.03 * e.strength;
  } else if (e.type === 'hurt') {
    n.frustration += Math.min(0.2, e.amount * 0.03); n.energy -= Math.min(0.1, e.amount * 0.01);
  } else if (e.type === 'death') {
    n.frustration += 0.35; n.satisfaction -= 0.25; n.energy -= 0.1;
  } else if (e.type === 'rest') {
    n.energy += e.seconds / 600; n.boredom += e.seconds / 900;
  } else if (e.type === 'sleep') {
    n.energy = 1; n.frustration *= 0.4;
  } else if (e.type === 'progress') {
    n.satisfaction += 0.15; n.frustration -= 0.15; n.boredom -= 0.12;
  } else if (e.type === 'goal_done') {
    n.satisfaction += 0.25; n.frustration -= 0.2; n.boredom -= 0.15;
  } else if (e.type === 'goal_set') {
    n.boredom -= 0.2; n.curiosity += 0.05;
  } else if (e.type === 'milestone') {
    n.satisfaction += 0.3; n.boredom -= 0.3; n.curiosity += 0.1;
  }
  return { energy: clamp01(n.energy), boredom: clamp01(n.boredom), frustration: clamp01(n.frustration), satisfaction: clamp01(n.satisfaction), curiosity: clamp01(n.curiosity) };
}

/** 把数值情绪说成人话（给模型和观众看） */
export function moodWords(m: Mood): string[] {
  const out: string[] = [];
  if (m.energy < 0.25) out.push('很累了，想歇歇'); else if (m.energy < 0.5) out.push('有点累');
  if (m.frustration > 0.6) out.push('很烦躁，这么做行不通'); else if (m.frustration > 0.35) out.push('有点不顺心');
  if (m.boredom > 0.65) out.push('好无聊，想找点新鲜事'); else if (m.boredom > 0.45) out.push('有点腻了');
  if (m.curiosity > 0.7) out.push('特别好奇'); else if (m.curiosity < 0.25) out.push('对周围没什么好奇心');
  if (m.satisfaction > 0.65) out.push('挺有成就感'); else if (m.satisfaction < 0.15) out.push('有点失落');
  return out.length ? out : ['状态平稳'];
}

/** 中文/英文混合的关键词：二字片段 + 英文单词（物品注册名） */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    out.add(w);
    for (const part of w.split('_')) if (part.length >= 3) out.add(part);
  }
  const han = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < han.length; i++) out.add(han.slice(i, i + 2));
  return out;
}

const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const k of a) if (b.has(k)) n++; return n; };

/** 成败统计是独立元数据，不能被模型抄回窍门正文。 */
export function cleanLesson(text: string): string {
  return text.trim().replace(/(?:\s*[（(]\s*(?:成|成功)\s*\d+\s*[/／]\s*(?:败|失败)\s*\d+\s*(?:[，,]\s*累计\s*\d+\s*次\s*)?[）)])+\s*$/u, '').trim().slice(0, 160);
}

/** 议程记愿望和疑问；可反复套用的操作规则属于窍门。 */
export function isAgendaRule(text: string): boolean {
  const t = cleanLesson(text);
  if (/^(?:想|打算|准备|计划|希望|我想|我要|能否|是否|为什么|怎么|如何|弄清|了解)|[？?]$/.test(t)) return false;
  return /^(?:别|不要|不能|避免|必须|记得|应该|应当)/.test(t)
    || /(?:时|以后|之后|之前|遇到|卡住|失败|受阻|受困|被困).{0,24}(?:先|应当|应该|要|别)/.test(t)
    || /要.{1,40}才/.test(t)
    || /^[^，。！？?]{1,24}(?:需要|必须|应该|应当|要先|得先|要找|要有|要用|要靠|要等)/.test(t)
    || /^(?:when\b.+\b(?:first|should)|don['’]t\b|never\b)/i.test(t);
}

/** 明确的条件前缀比整句相似度更能认出结论相反的同一情境。 */
function lessonContext(text: string): string | undefined {
  const context = text.match(/^(.{2,40}?)(?:的时候|时|之前|之后|以后)[，,:：\s]?/)?.[1];
  return context?.replace(/\s+/g, '').toLowerCase();
}

/** 持久化的“我”：性格、情绪、议程、窍门、实验、日记、最近的念头。重启后接着上次的心思玩。 */
export class SelfModel {
  data: SelfData;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private onlineAt: number | null = null;

  constructor(private file: string | null, traits: string[] = []) {
    this.data = { version: 1, traits, mood: { ...DEFAULT_MOOD }, moodAt: Date.now(), agenda: [], knowHow: [], experiments: [], diary: [], history: [], stream: [], feel: {} };
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved?.version === 1) this.data = { ...this.data, ...saved, traits: traits.length ? traits : saved.traits ?? [] };
      } catch { /* 文件坏了就当第一次玩：不影响游玩 */ }
    }
    if (file) { this.timer = setInterval(() => this.flush(), 5000); this.timer.unref?.(); }
  }

  private touch() { this.dirty = true; }
  observedProgress(): ObservedProgress | null { return this.data.observedProgress ?? null; }
  setObservedProgress(value: ObservedProgress) { this.data.observedProgress = { ...value }; this.touch(); }
  flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { this.dirty = true; }
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.flush(); }

  // ---------------------------------------------------------------- 情绪
  get mood(): Mood { return this.data.mood; }
  /** 只累计有游戏观察、且未暂停的时间；旧存档无法重建的历史不作猜测。 */
  setOnline(online: boolean, now = Date.now()) {
    const plan = this.data.plan;
    if (this.onlineAt !== null && plan?.stalledObservedSince !== undefined) {
      const since = Math.max(this.onlineAt, plan.progressAt ?? plan.setAt);
      plan.stalledOnlineMs = (plan.stalledOnlineMs ?? 0) + Math.max(0, now - since);
      this.touch();
    }
    if (online && this.onlineAt === null) {
      // 持久化情绪保留，离线时间不作为现在工作状态回填。
      this.data.moodAt = now;
      if (plan && plan.stalledObservedSince === undefined) {
        plan.stalledOnlineMs = 0;
        plan.stalledObservedSince = now;
        plan.stalledHistoryUnknown = true;
      }
      this.touch();
    }
    this.onlineAt = online ? now : null;
  }
  tickMood(working: boolean | 'waiting', now = Date.now()) {
    if (this.onlineAt === null) return;
    const seconds = Math.max(0, (now - this.data.moodAt) / 1000);
    if (seconds < 1) return;
    this.data.mood = relaxMood(this.data.mood, Math.min(seconds, 600), working, { stalled: this.planStalledMin(now) >= SelfModel.STALL_MIN });
    this.data.moodAt = now;
    this.touch();
  }
  feel(e: MoodEvent) { this.data.mood = feel(this.data.mood, e); this.touch(); }
  /** 已观察到的在线停滞分钟；旧存档未知历史不按墙钟推测。 */
  planStalledMin(now = Date.now()): number {
    const p = this.data.plan;
    if (!p || p.stalledObservedSince === undefined) return 0;
    const pending = this.onlineAt === null ? 0 : Math.max(0, now - Math.max(this.onlineAt, p.progressAt ?? p.setAt));
    return ((p.stalledOnlineMs ?? 0) + pending) / 60_000;
  }
  planStallInfo(now = Date.now()) {
    const p = this.data.plan;
    return { minutes: this.planStalledMin(now), observedSince: p?.stalledObservedSince ?? null, historyUnknown: p?.stalledHistoryUnknown ?? true };
  }
  private resetPlanStall(plan: FocusPlan, now: number) {
    plan.stalledOnlineMs = 0;
    if (this.onlineAt !== null) { plan.stalledObservedSince = now; plan.stalledHistoryUnknown = false; }
    else { delete plan.stalledObservedSince; plan.stalledHistoryUnknown = true; }
  }
  /** 主目标多久（真实分钟，约两个游戏天）没勾掉一项就算“停滞”：越干越腻，认真想写了理由也能换 */
  static STALL_MIN = 40;
  /** 一个主目标过了几个游戏天还没做成就回顾一次（每个目标在这个范围里随机，免得一到点就换） */
  static REVIEW_DAYS: [number, number] = [3, 5];
  /** 随机数（测试里可以换掉） */
  rand: () => number = Math.random;
  /** 记下主目标是在游戏第几天定的（心智每次感知时调用） */
  notePlanDay(day: number) {
    const p = this.data.plan;
    if (!p || !Number.isFinite(day)) return;
    if (p.setDay === undefined) { p.setDay = day; this.touch(); }
    // 旧存档里的主目标还没有回顾期限：补一个
    if (p.reviewDays === undefined) { p.reviewDays = SelfModel.REVIEW_DAYS[0] + this.rand() * (SelfModel.REVIEW_DAYS[1] - SelfModel.REVIEW_DAYS[0]); this.touch(); }
  }
  /** 主目标定下以来过了几个游戏天 */
  planDays(day: number): number {
    const p = this.data.plan;
    return p?.setDay !== undefined && Number.isFinite(day) ? Math.max(0, day - p.setDay) : 0;
  }
  /** 回顾后决定接着做：再给它 1–2 个游戏天，到时再回顾 */
  postponeReview(day: number, observedDays?: number): number | null {
    const p = this.data.plan;
    if (!p) return null;
    p.reviewDays = Math.max(p.reviewDays ?? SelfModel.REVIEW_DAYS[0], observedDays ?? this.planDays(day)) + 1 + this.rand();
    this.touch();
    return p.reviewDays;
  }
  /** 最近几个阶段目标的经过 */
  stages(n = 8): StageRecord[] { return (this.data.stages ?? []).slice(-n); }
  private endStage(outcome: StageRecord['outcome'], now = Date.now()) {
    const p = this.data.plan;
    if (!p) return;
    const rec: StageRecord = { goal: p.goal, setAt: p.setAt, endAt: now, outcome, stepsDone: p.steps.filter((st) => st.done).length, steps: p.steps.length };
    this.data.stages = [...(this.data.stages ?? []), rec].slice(-12);
  }

  // ---------------------------------------------------------------- 念头流
  think(text: string, kind: Thought['kind'] = 'monologue') {
    const t = text.trim().slice(0, 200);
    if (!t) return;
    const last = this.data.stream.at(-1);
    if (last && last.text === t) return;
    this.data.stream.push({ at: Date.now(), text: t, kind });
    if (this.data.stream.length > 40) this.data.stream = this.data.stream.slice(-40);
    this.touch();
  }
  recentThoughts(n = 8): Thought[] { return this.data.stream.slice(-n); }

  // ---------------------------------------------------------------- 议程
  agenda(): AgendaItem[] { return this.data.agenda.filter((a) => a.status === 'open' || a.status === 'active'); }
  addAgenda(text: string, kind: AgendaItem['kind'], horizon: AgendaItem['horizon'], onRule?: (text: string) => void): AgendaItem | null {
    const t = text.trim().slice(0, 100);
    if (!t) return null;
    if (isAgendaRule(t)) {
      if (onRule) onRule(cleanLesson(t));
      else this.learn(t, { source: 'reflection' });
      return null;
    }
    const k = keywords(t);
    const dup = this.agenda().find((a) => a.text === t || (overlap(keywords(a.text), k) >= Math.max(3, Math.min(k.size, keywords(a.text).size) * 0.8)));
    if (dup) { dup.updatedAt = Date.now(); this.touch(); return dup; }
    const item: AgendaItem = { id: shortId('a_'), text: t, kind, horizon, status: 'open', createdAt: Date.now(), updatedAt: Date.now(), attempts: 0 };
    this.data.agenda.push(item);
    // 议程太长时，最旧的“以后再说”的点子先被忘掉（人也记不住太多待办）
    const open = this.agenda();
    if (open.length > 12) {
      const victim = open.filter((a) => a.status !== 'active').sort((a, b) => Number(a.horizon === 'today') - Number(b.horizon === 'today') || a.updatedAt - b.updatedAt)[0];
      if (victim) victim.status = 'dropped';
    }
    this.data.agenda = this.data.agenda.filter((a) => a.status === 'open' || a.status === 'active' || Date.now() - a.updatedAt < 6 * 3600_000).slice(-40);
    this.touch();
    return item;
  }
  setAgendaStatus(id: string, status: AgendaItem['status']) {
    const item = this.data.agenda.find((a) => a.id === id);
    if (!item) return false;
    if (status === 'active') for (const a of this.data.agenda) if (a.status === 'active' && a.id !== id) a.status = 'open';
    item.status = status; item.updatedAt = Date.now();
    // 主目标做完或放下了：它的清单也就收起来
    if ((status === 'done' || status === 'dropped') && this.data.plan?.agendaId === id) {
      this.endStage(status);
      if (status === 'done') this.feel({ type: 'goal_done' });
      delete this.data.plan;
    }
    if (status === 'active' && this.data.plan && this.data.plan.agendaId !== id) { this.endStage('switched'); delete this.data.plan; }
    this.touch();
    return true;
  }

  // ---------------------------------------------------------------- 主目标的清单
  plan(): FocusPlan | null {
    const p = this.data.plan;
    if (!p) return null;
    const item = this.data.agenda.find((a) => a.id === p.agendaId);
    if (!item || (item.status !== 'active' && item.status !== 'open')) { delete this.data.plan; this.touch(); return null; }
    return p;
  }
  /**
   * 定下（或改写）主目标的清单。focus 是议程 ID 或一句话（一句话就新建一个今天的目标）。
   * 旧清单里同名、已经勾掉的项保持勾掉。
   */
  setPlan(focus: string, steps: string[], conditions: (import('../projects/types.ts').Condition | null)[] = [], opts: { promote?: boolean } = {}): FocusPlan | null {
    const id = focus.startsWith('a_') ? focus : this.addAgenda(focus, 'goal', 'today')?.id;
    const item = id ? this.data.agenda.find((a) => a.id === id) : undefined;
    // 主目标只能是“想做的事”：随手记下的点子、疑问不会自己变成要一直推进的目标；
    // 但认真想时明确把某个点子定成主目标、还写了清单，那就是决定要做了——升成目标
    if (item && item.kind === 'idea' && opts.promote && steps.some((t) => cleanPlanStep(t))) { item.kind = 'goal'; item.updatedAt = Date.now(); }
    if (!item || item.kind !== 'goal') return null;
    if (item.status !== 'active') this.setAgendaStatus(item.id, 'active');
    const old = this.data.plan?.agendaId === item.id ? this.data.plan : undefined;
    if (!old) this.feel({ type: 'goal_set' });
    const doneBefore = new Set(old?.steps.filter((st) => st.done).map((st) => st.text) ?? []);
    const cleaned = steps.map((t, i) => ({ text: cleanPlanStep(t), cond: conditions[i] ?? null })).filter((x) => x.text).slice(0, 8);
    this.data.plan = { agendaId: item.id, goal: item.text, steps: cleaned.map(({ text, cond }) => ({ text, done: doneBefore.has(text), ...(cond ? { doneWhen: cond } : {}) })), setAt: old?.setAt ?? Date.now(), updatedAt: Date.now(),
      // 只有勾掉一项才算推进；改写清单（哪怕改得面目全非）不算，不然改一次就把“多久没推进”清零了
      progressAt: old ? old.progressAt ?? old.setAt : Date.now(),
      ...(old?.stalledObservedSince !== undefined ? { stalledOnlineMs: old.stalledOnlineMs, stalledObservedSince: old.stalledObservedSince, stalledHistoryUnknown: old.stalledHistoryUnknown } : {}),
      ...(old?.setDay !== undefined ? { setDay: old.setDay } : {}),
      reviewDays: old?.reviewDays ?? SelfModel.REVIEW_DAYS[0] + this.rand() * (SelfModel.REVIEW_DAYS[1] - SelfModel.REVIEW_DAYS[0]) };
    if (!old) this.resetPlanStall(this.data.plan, this.data.plan.progressAt!);
    this.touch();
    return this.data.plan;
  }
  /**
   * 主目标是这一阶段要拿到的成果，不随眼前的事换：
   * 已有主目标还在推进（清单没做完）时，换成别的目标要认真想过、写出理由，或者是操作者下的令；
   * 同一个决定里先放下/做完了当前目标的不拦。返回拒绝的说明，可以换就返回 null。
   */
  goalSwitchRefusal(target: string, opts: { deliberate: boolean; reason?: string; operator?: boolean; releasing?: string[]; review?: boolean }): string | null {
    const plan = this.plan();
    const cur = plan ? this.data.agenda.find((a) => a.id === plan.agendaId) : this.activeAgenda();
    if (!cur || cur.status !== 'active' || cur.kind !== 'goal') return null;
    const t = target.trim();
    if (!t || t === cur.id || t === cur.text) return null;
    if (plan && plan.steps.length && plan.steps.every((st) => st.done)) return null;
    if (opts.releasing?.includes(cur.id) || opts.operator) return null;
    // 一时冒出来的想法不能顶掉主目标：只有停下来回顾阶段目标时（腻了、烦了、或回想觉得该放下），
    // 或者主目标已经很久没推进（没有清单也算），认真想过、写了理由才换
    const stalled = !plan || this.planStalledMin() >= SelfModel.STALL_MIN;
    if (opts.deliberate && opts.reason?.trim() && (opts.review || stalled)) return null;
    const to = (this.data.agenda.find((a) => a.id === t)?.text ?? t).slice(0, 30);
    const head = `主目标「${cur.text.slice(0, 40)}」尚未完成，没换成「${to}」：`;
    if (opts.deliberate && opts.reason?.trim()) return head + `已观察到 ${Math.round(this.planStalledMin())} 分钟在线无清单进展${this.planStallInfo().historyUnknown ? '（更早的在线时长未知）' : ''}，一时的想法不换主目标。`
      + '想做的事先记进 agenda（以后再做），眼前要先做的事写成 activity 或 detour；等停下来回顾阶段目标时（腻了、烦了、或者主目标很久没进展）再决定换不换';
    return head + '眼前要先做的事（过夜、脱困、回地面、吃饭、清包、补工具）直接写成 activity 或 detour，做完会回到主目标；'
      + (opts.deliberate ? '真决定换一个阶段目标，在 plan 里写 "switch_reason" 说为什么' : '真要换主目标得认真想一想，并写 switch_reason');
  }
  /** 清单里带 done_when、还没勾掉的项：身体看得见的事实达成了就自动勾（不用等模型记得写 done） */
  autoCheckPlan(met: (c: import('../projects/types.ts').Condition) => boolean): string[] {
    const p = this.plan();
    if (!p) return [];
    const out: string[] = [];
    for (const st of p.steps) if (!st.done && st.doneWhen && met(st.doneWhen)) { st.done = true; st.auto = true; out.push(st.text); }
    if (out.length) { p.updatedAt = Date.now(); p.progressAt = Date.now(); this.resetPlanStall(p, p.progressAt); this.feel({ type: 'progress' }); this.touch(); }
    return out;
  }
  /** 勾掉清单里的项：序号或文字 */
  checkPlan(done: (number | string)[], met?: (c: import('../projects/types.ts').Condition) => boolean, refused?: string[]): string[] {
    const p = this.plan();
    if (!p) return [];
    const out: string[] = [];
    for (const d of done) {
      const st = typeof d === 'number' ? p.steps[d] : p.steps.find((x) => x.text === d || x.text.includes(String(d)));
      // 写了 done_when 的项以事实为准：条件没达到，说“做完了”也不勾
      if (st && !st.done && st.doneWhen && met && !met(st.doneWhen)) { refused?.push(st.text); continue; }
      if (st && !st.done) { st.done = true; out.push(st.text); }
    }
    if (out.length) { p.updatedAt = Date.now(); p.progressAt = Date.now(); this.resetPlanStall(p, p.progressAt); this.feel({ type: 'progress' }); this.touch(); }
    return out;
  }
  activeAgenda(): AgendaItem | undefined { return this.data.agenda.find((a) => a.status === 'active'); }
  creditAgenda(id: string | undefined) {
    const item = id ? this.data.agenda.find((a) => a.id === id) : undefined;
    if (item) { item.attempts++; item.updatedAt = Date.now(); this.touch(); }
  }

  // ---------------------------------------------------------------- 经历与窍门
  record(r: ActivityRecord) {
    this.data.history.push(r);
    if (this.data.history.length > 60) this.data.history = this.data.history.slice(-60);
    // 同一套做法后来的成败会修正“窍门”的可信度：这就是从实践里学
    for (const k of this.data.knowHow) if (k.signature && k.signature === r.signature) {
      if (r.outcome === 'done' && r.completion !== 'condition') k.wins++; else if (r.outcome === 'stuck') k.losses++;
      k.updatedAt = Date.now();
    }
    this.touch();
  }
  /** 第一次到这个维度吗（顺手记下）：没有记录又已经在玩了的老存档，主世界不算新环境 */
  firstVisit(dim: string, now = Date.now()): boolean {
    this.data.visited ??= {};
    if (this.data.visited[dim]) return false;
    const fresh = Object.keys(this.data.visited).length > 0 || this.data.history.length === 0 || dim !== 'overworld';
    this.data.visited[dim] = now;
    this.touch();
    return fresh && dim !== 'overworld';
  }

  history(n = 6): ActivityRecord[] { return this.data.history.slice(-n); }
  sameKindStreak(kind: ActivityKind): number {
    let n = 0;
    for (const r of [...this.data.history].reverse()) { if (r.kind !== kind) break; n++; }
    return n;
  }
  learn(text: string, opts: { kind?: ActivityKind; tags?: string[]; signature?: string; source: KnowHow['source']; outcome?: ActivityRecord['outcome']; revise?: string }): KnowHow | null {
    const t = cleanLesson(text);
    if (t.length < 4) return null;
    const k = keywords(t);
    const context = lessonContext(t);
    const revised = opts.revise ? this.data.knowHow.find((h) => h.id === opts.revise) : undefined;
    const same = revised ?? this.data.knowHow.find((h) => {
      const oldText = cleanLesson(h.text), oldKeys = keywords(oldText);
      const common = overlap(oldKeys, k);
      return oldText === t || common >= Math.max(4, Math.max(k.size, oldKeys.size) * 0.7)
        || !!context && context === lessonContext(oldText) && (!h.kind || !opts.kind || h.kind === opts.kind)
        || !!opts.signature && h.signature === opts.signature && common >= 3 && common >= Math.min(k.size, oldKeys.size) * 0.4;
    });
    if (same) {
      const changed = cleanLesson(same.text) !== t;
      same.text = t;
      // 新的说法不能继承旧结论的成功证据，尤其是失败后猜出的替代办法。
      if (changed) { same.wins = 0; same.losses = 0; same.unverified = opts.outcome !== 'done'; same.signature = undefined; }
      same.updatedAt = Date.now();
      if (opts.outcome === 'done') { same.wins++; same.unverified = false; }
      else if (opts.outcome === 'stuck') { same.losses++; if (!same.wins) same.unverified = true; }
      same.kind = opts.kind ?? same.kind;
      same.source = opts.source;
      same.tags = [...new Set([...same.tags, ...(opts.tags ?? []), ...[...k].filter((w) => /^[a-z]/.test(w))])].slice(0, 12);
      if (opts.signature && (changed || !same.signature)) same.signature = opts.signature;
      this.touch();
      return same;
    }
    const h: KnowHow = { id: shortId('k_'), text: t, kind: opts.kind, tags: [...new Set([...(opts.tags ?? []), ...[...k].filter((w) => /^[a-z]/.test(w))])].slice(0, 12),
      signature: opts.signature, wins: opts.outcome === 'done' ? 1 : 0, losses: opts.outcome === 'stuck' ? 1 : 0,
      unverified: opts.outcome !== 'done',
      createdAt: Date.now(), updatedAt: Date.now(), source: opts.source };
    this.data.knowHow.push(h);
    // 太多时先忘掉被证明不靠谱、又很久没用的
    if (this.data.knowHow.length > 80) {
      this.data.knowHow.sort((a, b) => (b.wins - b.losses * 1.5 + b.updatedAt / 3.6e9) - (a.wins - a.losses * 1.5 + a.updatedAt / 3.6e9));
      this.data.knowHow = this.data.knowHow.slice(0, 80);
    }
    this.touch();
    return h;
  }
  /** 挑出和眼下有关的窍门：关键词重叠 + 同类活动 + 可信度 */
  relevantKnowHow(context: string, kind?: ActivityKind, n = 5): KnowHow[] {
    const k = keywords(context);
    return this.data.knowHow.map((h) => {
      const rel = overlap(keywords(h.text), k) + h.tags.filter((t) => k.has(t)).length * 2 + (kind && h.kind === kind ? 2 : 0);
      const trust = (h.wins + 1) / (h.wins + h.losses + 2);
      return { h, score: (rel * (0.5 + trust) + (Date.now() - h.updatedAt < 20 * 60_000 ? 0.5 : 0)) * (h.unverified ? 0.5 : 1) };
    }).filter((e) => e.score > 0.6).sort((a, b) => b.score - a.score).slice(0, n).map((e) => e.h);
  }

  // ---------------------------------------------------------------- 实验
  startExperiment(hypothesis: string, activityId: string): Experiment {
    const e: Experiment = { id: shortId('x_'), hypothesis: hypothesis.slice(0, 160), activityId, status: 'running', at: Date.now() };
    this.data.experiments.push(e);
    if (this.data.experiments.length > 30) this.data.experiments = this.data.experiments.slice(-30);
    this.touch();
    return e;
  }
  experimentFor(activityId: string) { return this.data.experiments.find((e) => e.activityId === activityId); }
  concludeExperiment(id: string, status: Experiment['status'], evidence: string) {
    const e = this.data.experiments.find((x) => x.id === id);
    if (!e) return;
    e.status = status; e.evidence = evidence.slice(0, 200); this.touch();
  }
  experiments(n = 4) { return this.data.experiments.slice(-n); }

  // ---------------------------------------------------------------- 日记
  writeDiary(text: string, dim: string, pos: [number, number, number]) {
    const t = text.trim().slice(0, 160);
    if (!t || this.data.diary.at(-1)?.text === t) return;
    this.data.diary.push({ at: Date.now(), text: t, dim, pos });
    if (this.data.diary.length > 50) this.data.diary = this.data.diary.slice(-50);
    this.touch();
  }
  diary(n = 5) { return this.data.diary.slice(-n); }

  // ---------------------------------------------------------------- 喜好
  like(text: string) {
    const t = text.trim().slice(0, 60);
    if (t.length < 2) return false;
    const list = (this.data.likes ??= []);
    const k = keywords(t);
    const same = list.find((l) => l.text === t || overlap(keywords(l.text), k) >= Math.max(2, k.size * 0.7));
    if (same) { same.at = Date.now(); this.touch(); return false; }
    list.push({ at: Date.now(), text: t });
    if (list.length > 20) this.data.likes = list.slice(-20);
    this.touch();
    return true;
  }
  tastes(n = 8): string[] { return (this.data.likes ?? []).slice(-n).map((l) => l.text); }

  // ---------------------------------------------------------------- 身体习惯（模型自己定的）
  habits(): Habits { return { ...(this.data.habits ?? {}) }; }
  /** 合并新的习惯；0/false 表示关掉。返回改动的说明（没变就是空） */
  setHabits(h: Habits): string[] {
    const cur = (this.data.habits ??= {});
    const changed: string[] = [];
    for (const k of ['torch_every', 'eat_below', 'pickup'] as const) {
      if (h[k] === undefined || cur[k] === h[k]) continue;
      if (!h[k]) delete cur[k]; else (cur as any)[k] = h[k];
      changed.push(`${k}=${String(h[k])}`);
    }
    if (changed.length) this.touch();
    return changed;
  }

  // ---------------------------------------------------------------- 回想
  /** 记一条零碎想法，等休息时再整理（人不会每做一件事就立一条规矩） */
  jot(text: string, outcome?: string) {
    const t = cleanLesson(text);
    if (t.length < 4) return;
    const list = (this.data.insights ??= []);
    if (list.some((i) => i.text === t)) return;
    list.push({ at: Date.now(), text: t, ...(outcome ? { outcome } : {}) });
    if (list.length > 20) this.data.insights = list.slice(-20);
    this.touch();
  }
  insights() { return this.data.insights ?? []; }
  /** 自上次回想以来攒了多少要整理的东西 */
  reflectionBacklog(): number {
    return (this.data.insights?.length ?? 0) + Math.max(0, this.data.knowHow.length - (this.data.knowHowAtReflect ?? 0));
  }
  get reflectedAt() { return this.data.reflectedAt ?? 0; }

  /** 应用回想的结果：合并重复、改写含糊的、丢掉被事实推翻的；零碎想法清空 */
  consolidate(c: import('./types.ts').Consolidation): { before: number; after: number; keptGoals: { id: string; text: string }[] } {
    const before = this.data.knowHow.length;
    const byId = new Map(this.data.knowHow.map((k) => [k.id, k]));
    for (const m of c.merge) {
      const parts = m.ids.map((id) => byId.get(id)).filter((k): k is KnowHow => !!k);
      if (parts.length < 2) continue;
      const [keep, ...rest] = parts;
      // 回想可能添加了新的结论：旧做法的成败不能证明改写后的整句话。
      const unchanged = parts.every((k) => cleanLesson(k.text) === cleanLesson(m.text) && k.signature === keep.signature);
      keep.text = m.text;
      keep.wins = unchanged ? parts.reduce((n, k) => n + k.wins, 0) : 0;
      keep.losses = unchanged ? parts.reduce((n, k) => n + k.losses, 0) : 0;
      keep.unverified = unchanged ? parts.every((k) => k.unverified === true) && keep.wins === 0 : true;
      if (!unchanged) keep.signature = undefined;
      keep.tags = [...new Set(parts.flatMap((k) => k.tags))].slice(0, 12);
      keep.updatedAt = Date.now();
      const drop = new Set(rest.map((k) => k.id));
      this.data.knowHow = this.data.knowHow.filter((k) => !drop.has(k.id));
    }
    for (const r of c.rewrite) { const k = byId.get(r.id); if (k) {
      if (cleanLesson(k.text) !== cleanLesson(r.text)) { k.wins = 0; k.losses = 0; k.unverified = true; k.signature = undefined; }
      k.text = r.text; k.updatedAt = Date.now();
    } }
    if (c.drop.length) { const drop = new Set(c.drop); this.data.knowHow = this.data.knowHow.filter((k) => !drop.has(k.id)); }
    for (const t of c.add) this.learn(t, { source: 'reflection' });
    // 回想是整理零碎点子的，不能顺手把正在推进的主目标也收掉（10-26 晚回想合并“矿口前哨”几条点子时，把正在凑头盔的
    // “攒够铁做一整套铁盔甲”一起丢了，之后就一直没有主目标）。正在推进的目标留着，交给下一次认真想自己决定放不放
    const keptGoals: { id: string; text: string }[] = [];
    for (const id of c.agendaDrop) {
      const item = this.data.agenda.find((a) => a.id === id);
      if (item && item.kind === 'goal' && (item.status === 'active' || this.data.plan?.agendaId === id)) { keptGoals.push({ id, text: item.text }); continue; }
      this.setAgendaStatus(id, 'dropped');
    }
    for (const a of c.agendaAdd ?? []) this.addAgenda(a.text, a.kind, a.horizon);
    this.data.insights = [];
    this.data.reflectedAt = Date.now();
    this.data.knowHowAtReflect = this.data.knowHow.length;
    this.touch();
    return { before, after: this.data.knowHow.length, keptGoals };
  }

  // ---------------------------------------------------------------- 手感
  practice(skill: string, ok: boolean, ms: number) {
    const f = this.data.feel[skill] ??= { ok: 0, fail: 0, ms: 0 };
    if (ok) { f.ms = f.ok ? Math.round(f.ms * 0.7 + ms * 0.3) : ms; f.ok++; } else f.fail++;
    this.touch();
  }
  /** “我擅长 / 我总搞砸” */
  selfImage(): { goodAt: string[]; struggleWith: string[] } {
    const e = Object.entries(this.data.feel).filter(([, f]) => f.ok + f.fail >= 3);
    return {
      goodAt: e.filter(([, f]) => f.ok / (f.ok + f.fail) >= 0.8).sort((a, b) => b[1].ok - a[1].ok).slice(0, 5).map(([s, f]) => `${s}(${f.ok}/${f.ok + f.fail})`),
      struggleWith: e.filter(([, f]) => f.fail / (f.ok + f.fail) >= 0.4).sort((a, b) => b[1].fail - a[1].fail).slice(0, 4).map(([s, f]) => `${s}(失败${f.fail}/${f.ok + f.fail})`),
    };
  }
}
