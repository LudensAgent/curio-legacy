import fs from 'node:fs';
import path from 'node:path';
import { shortId } from '../util.ts';
import type { ActivityKind, ActivityRecord, AgendaItem, DiaryEntry, Experiment, KnowHow, Mood, Thought } from './types.ts';

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
}

export const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export const DEFAULT_MOOD: Mood = { energy: 0.9, boredom: 0.2, frustration: 0, satisfaction: 0.4, curiosity: 0.6 };

/** 情绪随时间自然回归：烦躁和满足淡去、精力在不干活时恢复、好奇慢慢回到中等 */
export function relaxMood(m: Mood, seconds: number, working: boolean): Mood {
  const k = Math.min(1, seconds / 600);
  return {
    energy: clamp01(working ? m.energy - seconds / 5400 : m.energy + seconds / 900),
    boredom: clamp01(m.boredom + (working ? seconds / 2400 : -seconds / 1200)),
    frustration: clamp01(m.frustration * (1 - k * 0.8)),
    satisfaction: clamp01(m.satisfaction + (0.35 - m.satisfaction) * k * 0.5),
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
  | { type: 'sleep' };

/** 事件对情绪的影响：都是可解释的小幅变化，模型看到的是“为什么会这样觉得” */
export function feel(m: Mood, e: MoodEvent): Mood {
  const n = { ...m };
  if (e.type === 'step') {
    if (e.ok) { n.frustration -= 0.04; n.satisfaction += 0.01; } else { n.frustration += 0.12; n.satisfaction -= 0.02; }
  } else if (e.type === 'activity_end') {
    if (e.outcome === 'done') { n.satisfaction += 0.12 + Math.min(0.15, e.gainedKinds * 0.03); n.frustration -= 0.15; }
    if (e.outcome === 'stuck') { n.frustration += 0.18; n.satisfaction -= 0.05; }
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

/** 持久化的“我”：性格、情绪、议程、窍门、实验、日记、最近的念头。重启后接着上次的心思玩。 */
export class SelfModel {
  data: SelfData;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

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
  tickMood(working: boolean, now = Date.now()) {
    const seconds = Math.max(0, (now - this.data.moodAt) / 1000);
    if (seconds < 1) return;
    this.data.mood = relaxMood(this.data.mood, Math.min(seconds, 600), working);
    this.data.moodAt = now;
    this.touch();
  }
  feel(e: MoodEvent) { this.data.mood = feel(this.data.mood, e); this.touch(); }

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
  addAgenda(text: string, kind: AgendaItem['kind'], horizon: AgendaItem['horizon']): AgendaItem | null {
    const t = text.trim().slice(0, 100);
    if (!t) return null;
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
    item.status = status; item.updatedAt = Date.now(); this.touch();
    return true;
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
      if (r.outcome === 'done') k.wins++; else if (r.outcome === 'stuck') k.losses++;
      k.updatedAt = Date.now();
    }
    this.touch();
  }
  history(n = 6): ActivityRecord[] { return this.data.history.slice(-n); }
  sameKindStreak(kind: ActivityKind): number {
    let n = 0;
    for (const r of [...this.data.history].reverse()) { if (r.kind !== kind) break; n++; }
    return n;
  }
  learn(text: string, opts: { kind?: ActivityKind; tags?: string[]; signature?: string; source: KnowHow['source']; outcome?: ActivityRecord['outcome'] }): KnowHow | null {
    const t = text.trim().slice(0, 160);
    if (t.length < 4) return null;
    const k = keywords(t);
    const same = this.data.knowHow.find((h) => h.text === t || overlap(keywords(h.text), k) >= Math.max(4, k.size * 0.7));
    if (same) {
      // 同样的结论又得出一次：说明它在不同时候都成立
      same.updatedAt = Date.now();
      if (opts.outcome === 'done') same.wins++; else if (opts.outcome === 'stuck') same.losses++;
      if (!same.signature && opts.signature) same.signature = opts.signature;
      this.touch();
      return same;
    }
    const h: KnowHow = { id: shortId('k_'), text: t, kind: opts.kind, tags: [...new Set([...(opts.tags ?? []), ...[...k].filter((w) => /^[a-z]/.test(w))])].slice(0, 12),
      signature: opts.signature, wins: opts.outcome === 'done' ? 1 : 0, losses: opts.outcome === 'stuck' ? 1 : 0,
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
      return { h, score: rel * (0.5 + trust) + (Date.now() - h.updatedAt < 20 * 60_000 ? 0.5 : 0) };
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
