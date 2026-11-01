import fs from 'node:fs';
import path from 'node:path';
import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import { normalizeSkillName, type SkillBook } from '../knowledge/skillbook.ts';
import { instinctNote, type BehaviorEngine } from '../mind/behaviors.ts';
import type { LedgerSignal, LedgerView } from '../mind/ledger.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { extractJson } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { API_DOC } from './bridge.ts';

/**
 * 造技能：从经历里总结出新技能（或者重写管这件事却没做好的旧技能），后台单独请模型写，写下就生效。
 *
 * 什么时候值得学，不写死成“卡住几次”这种规则，而是四个来源：
 * - noted：心智自己说“刚才这事值得学”（它当时最清楚哪里出乎意料），后台拿那段经过去写；
 * - review：定期回顾（天亮、歇下来回想时），从这段时间做过的事里找反复出现、费时、常失败的问题；
 * - pain：吃亏的程度——掉血、死亡、丢东西、卡住、失败累加成“痛”，随时间消退；
 *   明显高于它自己平时的水平（跟着它的平均和波动走）才算一次值得学的事；
 * - death：死了一定回头看。
 * - recurring：同一个动作因为同一种失败码反复失败（半小时内三次以上），而且还没被技能管住。
 *   吃亏程度是按“比平时痛”算的：一直在出的老毛病会被当成“平时”，永远不显得痛，所以单独看“同一种错一再出现”。
 * - repeated：心智一步步指挥身体，把同一串动作重复了好几遍（比如“挖前上方、挖前上上方、迈上去”连做四回）：
 *   这串动作值得练成一个技能，以后一句 use_skill 做完，或者写成循环到条件达成的代码。
 * - efficiency：收获账本发现拿某样东西这次比它自己平时明显费劲或明显省事（相对自己的历史离群，不是固定阈值）：
 *   费劲了就对比最省的那几次哪里不一样；省事了就把这次的做法记下来，下次照做。不针对哪种东西。
 *
 * 回顾时整本收获账（花时间最多的东西、在变省还是变费、白忙的比例）也一起给模型，问“有没有更省的做法”。
 *
 * 不限次数（模型便宜）；只是同一时间只写一份，其余排队，挨得很近的同类事合并成一件。
 */
export type ForgeKind = 'death' | 'pain' | 'noted' | 'review' | 'efficiency' | 'recurring' | 'repeated' | 'goal' | 'undone';
const KIND_LABEL: Record<ForgeKind, string> = { death: '死亡', pain: '一段吃了大亏的经历', noted: '自己觉得值得学的事', review: '这段时间的回顾', efficiency: '一次收获效率明显变化', recurring: '反复出现的同一种失败', repeated: '一再重复的同一串动作', goal: '一个迟迟推进不了的目标', undone: '做完的事又被自己打破' };
const ORDER: ForgeKind[] = ['death', 'noted', 'goal', 'recurring', 'undone', 'repeated', 'pain', 'efficiency', 'review'];
/** 重复的动作串：最短几步、重复几遍算“一套做法”，在多长时间里看，学过之后多久再看同一串 */
export const REPEATED = { minLen: 2, maxLen: 6, times: 3, windowMs: 10 * 60_000, againMs: 20 * 60_000 };
/** 一次失败说明缺了什么：没吃的、找不到吃的、合成或盖房缺的材料 */
export function shortageOf(skill: string, code: string, msg: string): { what: string; how: string }[] {
  if (code === 'NO_FOOD' || ((skill === 'forage' || skill === 'hunt') && code === 'NOT_FOUND')) return [{ what: '食物', how: `${skill} ${code}` }];
  if (code !== 'MISSING_MATERIALS') return [];
  const names = new Set<string>();
  for (const m of msg.matchAll(/([a-z_]+) 还差/g)) names.add(m[1]);
  const lack = msg.match(/缺少 ([^（。；]+)/);
  if (lack) for (const m of lack[1].matchAll(/([a-z_]+)×/g)) names.add(m[1]);
  return [...names].slice(0, 4).map((what) => ({ what, how: `${skill} 缺料` }));
}

/** 只是看一看、等一等的动作不算一套做法 */
const IDLE = new Set(['glance', 'look_around', 'wait', 'inspect_block', 'use_skill']);

/** 最近的动作是不是同一串连着做了 times 遍以上（中间夹着看一看、等一等不算打断），优先遍数多、再优先长的 */
export function findRepeat(tokens: string[], opts = REPEATED): { pattern: string[]; times: number } | null {
  const seq = tokens.filter((t) => !IDLE.has(t.split(' ')[0]));
  let best: { pattern: string[]; times: number } | null = null;
  for (let n = opts.minLen; n <= opts.maxLen; n++) {
    if (seq.length < n * opts.times) break;
    const pattern = seq.slice(-n);
    if (new Set(pattern).size < 2) continue;
    let times = 0;
    for (let end = seq.length; end - n >= 0 && seq.slice(end - n, end).every((t, k) => t === pattern[k]); end -= n) times++;
    if (times >= opts.times && (!best || times > best.times || (times === best.times && n > best.pattern.length))) best = { pattern, times };
  }
  return best;
}
/** 同一种失败：多少次算“老毛病”、在多长时间里数、学过一次之后多久再看 */
export const RECURRING = { times: 3, windowMs: 30 * 60_000, againMs: 10 * 60_000, maxAgainMs: 2 * 3600_000 };

/** 技能的触发条件里有没有“某动作因某失败码失败后”这一条（all 里嵌套的也算） */
export function coversFailure(when: unknown, skill: string, code: string): boolean {
  if (!when || typeof when !== 'object') return false;
  const w = when as { after_failure?: { skill?: string[]; code?: string[] }; all?: unknown[] };
  const af = w.after_failure;
  if (af && (af.skill ?? []).includes(skill) && (!af.code?.length || af.code.includes(code))) return true;
  return Array.isArray(w.all) && w.all.some((x) => coversFailure(x, skill, code));
}
/** 失败原因去掉坐标和数字，好把“同一种原因”归到一起 */
export const reasonOf = (summary: string) => summary.split(/[；;]/).map((seg, i) => (i === 0 ? seg.split(/[：:]/).pop() ?? seg : seg))
  .map((r) => r.replace(/\[[^\]]*\]/g, '[…]').replace(/\([^)]*\d[^)]*\)/g, '').replace(/-?\d+(\.\d+)?/g, '#').trim()).filter(Boolean).map((r) => r.slice(0, 60));

interface Incident {
  kind: ForgeKind; at: number; headline: string; lines: string[]; context: Record<string, unknown>; note?: string; signal?: LedgerSignal;
  /** 这是哪一件事（结构化的：同一个动作同一种失败、同一串动作、同一样东西……），用来认“这事归谁管” */
  key?: string;
  /** 进队列的时刻（攒批用） */
  queuedAt?: number;
}

/** 一串动作不管从哪一步数起都是同一串（挖→垫→挖→垫 和 垫→挖→垫→挖）：取字典序最小的那个转法 */
export function cycleKey(names: string[]): string {
  let best = names.join(' > ');
  for (let i = 1; i < names.length; i++) { const r = [...names.slice(i), ...names.slice(0, i)].join(' > '); if (r < best) best = r; }
  return best;
}

/** 模型判定过“这件事归某份技能管”：记下技能和当时的版本 */
interface Owner { skill: string; version: string; at: number; kind: ForgeKind; headline: string }

const KEEP = new Set(['task_start', 'task_end', 'hurt', 'notice', 'reflex', 'reflex_gaveup', 'instinct', 'thought', 'attempt_end', 'activity_start', 'activity_adjust',
  'death', 'death_items', 'game_message', 'body_adapt', 'stuck', 'skill_written', 'skill_forged', 'skill_disabled', 'new_environment', 'activity_suspend']);

/** 吃亏的程度：自适应的阈值（看它平时痛到什么程度） */
export class PainMeter {
  pain = 0;
  private mean = 0;
  private varc = 0;
  private n = 0;
  private at = Date.now();
  sources = new Map<string, number>();
  constructor(private halfLifeMs = 3 * 60_000) {}
  private decay(now: number) {
    const k = Math.pow(0.5, Math.max(0, now - this.at) / this.halfLifeMs);
    this.pain *= k;
    for (const [s, v] of this.sources) { const nv = v * k; if (nv < 0.05) this.sources.delete(s); else this.sources.set(s, nv); }
    this.at = now;
  }
  add(amount: number, source: string, now = Date.now()) {
    if (!(amount > 0)) return;
    this.decay(now);
    this.pain += amount;
    this.sources.set(source, (this.sources.get(source) ?? 0) + amount);
  }
  /**
   * 定时取样：更新“平时”的均值和波动，判断这会儿是不是明显比平时痛。
   * 热身（样本还少）时只认很突出的峰值：至少是均值的好几倍。
   */
  sample(now = Date.now()): boolean {
    this.decay(now);
    const x = this.pain;
    const sd = Math.sqrt(this.varc);
    const spike = this.n >= 10 ? x > this.mean + 3 * Math.max(sd, this.mean * 0.5, 0.5) : x > 4 * Math.max(this.mean, 1) && this.n >= 3;
    // 均值和方差用指数滑动平均：跟着最近的水平走（前期常死，标准就松；后来稳了，偶尔一次大亏也会被注意到）
    const a = this.n < 20 ? 1 / (this.n + 1) : 0.05;
    const d = x - this.mean;
    this.mean += a * d;
    this.varc = (1 - a) * (this.varc + a * d * d);
    this.n++;
    return spike;
  }
  /** 学过了：这一段的痛清零，别反复因为同一件事触发 */
  reset() { this.pain = 0; this.sources.clear(); }
  describe(): string { return [...this.sources].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, v]) => `${s}（${v.toFixed(1)}）`).join('、'); }
  baseline() { return { mean: Math.round(this.mean * 10) / 10, sd: Math.round(Math.sqrt(this.varc) * 10) / 10, now: Math.round(this.pain * 10) / 10 }; }
}

export class SkillSmith {
  busy: { kind: ForgeKind; startedAt: number } | null = null;
  readonly pain = new PainMeter();
  private recent: AgentEvent[] = [];
  private queue: Incident[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastHp: number | null = null;
  private wasDay: boolean | null = null;
  private lastReview = Date.now();
  private listener = (ev: AgentEvent) => this.onEvent(ev);
  history: { at: number; kind: ForgeKind; result: string }[] = [];
  /** 收获账本（投入产出、东西出现在哪）：回顾和效率信号时给模型看 */
  ledger: LedgerView | null = null;
  private lastEfficiency = new Map<string, number>();
  private recurring = new Map<string, { at: number[]; examples: string[]; reasons: Map<string, number>; learnedAt: number; learned?: number }>();
  private actions: { at: number; token: string }[] = [];
  /** 一再缺的东西（没吃的、合成缺料、找不到）：回顾时问能不能变成稳定来源 */
  private shortages: { at: number; what: string; how: string }[] = [];
  private repeatedAt = new Map<string, number>();
  /** 最近一小时请模型写技能的时刻；同一件事（同类、去掉数字后同一句话）上次请模型的时刻 */
  private forgedAt: number[] = [];
  private handledAt = new Map<string, number>();
  private retryTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  /** 哪件事归哪份技能管（模型说的）：同一件事再来，直接交给它，不再请模型 */
  private owners = new Map<string, Owner>();
  /** 归属多久后重新请模型看一眼 */
  static readonly OWNER_TTL_MS = 4 * 3600_000;
  /** 一批最多几件 */
  static readonly BATCH_MAX = 4;

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private book: SkillBook | null,
    private bus: EventBus, private state: () => AgentState, private journal: () => string[] = () => [],
    /** 每小时最多请模型写几次（死亡不算在内）；同一件事多久内不再请第二次 */
    private limits: { maxPerHour: number; repeatMs: number; batchMs?: number; ownersFile?: string | null } = { maxPerHour: 24, repeatMs: 20 * 60_000 }) {
    const f = limits.ownersFile;
    if (f && fs.existsSync(f)) {
      try { for (const [k, o] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, Owner>)) if (o?.skill) this.owners.set(k, o); } catch { /* 坏了就从头记 */ }
    }
  }

  private saveOwners() {
    const f = this.limits.ownersFile;
    if (!f) return;
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.fromEntries(this.owners), null, 1)); } catch { /* 写不进去不影响 */ }
  }

  /**
   * 这件事现在归谁管：模型说过归某份技能、那份技能还在用、还是当时那一版、没在接连失败、最近一次没失败、没过太久。
   * 不满足就作废（下次重新请模型看）
   */
  ownerOf(key: string | undefined, now = Date.now()): Owner | null {
    if (!key) return null;
    const o = this.owners.get(key);
    if (!o) return null;
    const b = this.engine.get(o.skill);
    const st = this.engine.statsOf(o.skill);
    const cur = this.engine.currentStats(o.skill);
    const last = st?.recent?.at(-1);
    const stale = now - o.at > SkillSmith.OWNER_TTL_MS || !b || this.engine.inactive(o.skill) || this.engine.versionOf(b) !== o.version
      || (cur.fail >= 3 && cur.fail > cur.ok) || (!!last && !last.ok && now - last.at < 10 * 60_000);
    if (!stale) return o;
    this.owners.delete(key);
    this.saveOwners();
    return null;
  }

  private setOwner(incident: Incident, skill: string) {
    const b = incident.key ? this.engine.get(skill) : undefined;
    if (!b || !incident.key || this.engine.inactive(skill)) return;
    this.owners.set(incident.key, { skill, version: this.engine.versionOf(b), at: Date.now(), kind: incident.kind, headline: incident.headline.slice(0, 120) });
    if (this.owners.size > 300) this.owners.delete(this.owners.keys().next().value!);
    this.saveOwners();
  }

  start(tickMs = 5000) {
    this.bus.on('event', this.listener);
    let ticks = 0;
    this.timer = setInterval(() => { this.tick(); if (++ticks % 6 === 0) this.checkPain(); }, tickMs);
    this.timer.unref?.();
  }
  stop() { this.bus.off('event', this.listener); if (this.timer) clearInterval(this.timer); this.timer = null; if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; if (this.batchTimer) clearTimeout(this.batchTimer); this.batchTimer = null; }

  /** 每几秒：掉了多少血算进痛；夜里熬到天亮回顾一次 */
  tick() {
    let s: AgentState | null = null;
    try { s = this.state(); } catch { return; }
    if (!s.connected || !s.alive) { this.lastHp = null; return; }
    if (this.lastHp !== null && s.hp < this.lastHp) this.pain.add(this.lastHp - s.hp, '掉血');
    this.lastHp = s.hp;
    if (this.wasDay === false && s.isDay) this.review('天亮了');
    this.wasDay = s.isDay;
  }

  checkPain(now = Date.now()) {
    if (this.pain.sample(now)) {
      const what = this.pain.describe();
      this.pain.reset();
      this.report('pain', now, `这段时间明显比平时吃亏：${what}`, 4 * 60_000);
    }
  }

  private onEvent(ev: AgentEvent) {
    if (KEEP.has(ev.type) && !/\[filler\]/.test(ev.msg)) {
      this.recent.push(ev);
      if (this.recent.length > 800) this.recent.splice(0, this.recent.length - 800);
    }
    const d = (ev.data ?? {}) as Record<string, any>;
    if (ev.type === 'death') {
      this.pain.add(20, '死亡');
      // 等游戏的死亡播报和掉落清单到了再写
      setTimeout(() => { this.pain.reset(); this.report('death', ev.ts, ev.msg, 90_000); }, 3000).unref?.();
    } else if (ev.type === 'death_items') {
      this.pain.add(Math.min(10, (ev.msg.match(/×/g)?.length ?? 1)), '丢了东西');
    } else if (ev.type === 'attempt_end' && d.outcome === 'stuck') {
      this.pain.add(3, `卡住：${ev.msg.replace(/^一段活「([^」]{0,20}).*$/, '$1')}`);
    } else if (ev.type === 'task_end' && d.status === 'failed' && d.source !== 'filler') {
      this.pain.add(1, `${d.skill ?? '动作'} 失败`);
      if (d.skill && d.failureCode) this.failedAgain(String(d.skill), String(d.failureCode), ev.msg, ev.ts);
      for (const s of shortageOf(String(d.skill ?? ''), String(d.failureCode ?? ''), ev.msg)) this.shortages.push({ at: ev.ts, ...s });
      this.shortages = this.shortages.filter((x) => ev.ts - x.at < 2 * 3600_000).slice(-400);
    } else if (ev.type === 'task_start' && d.source === 'llm' && d.skill) {
      this.didAction(String(d.skill), d.args, ev.ts);
    } else if (ev.type === 'effect_broken') {
      this.undoneAgain(String(d.by ?? ''), String(d.item ?? ''), ev.msg, ev.ts);
    } else if (ev.type === 'reflect_start') {
      this.review('歇下来回想');
    }
  }

  /**
   * 收获账本报告：拿某样东西这次明显比平时费劲/省事。同一样东西同一个方向十分钟内只看一次（连着几段都偏，说的是同一件事）。
   */
  efficiency(sig: LedgerSignal, now = Date.now()) {
    const key = `${sig.item}:${sig.direction}`;
    if (now - (this.lastEfficiency.get(key) ?? 0) < 10 * 60_000) return;
    this.lastEfficiency.set(key, now);
    const ep = sig.episode;
    const headline = `拿 ${sig.item} ${sig.direction === 'slow' ? `比平时费劲 ${sig.ratio} 倍` : `只花了平时的 ${Math.round(sig.ratio * 100)}%`}：这次「${ep.what}」每个 ${Math.round(sig.thisSec)} 秒，平时 ${Math.round(sig.usualSec)} 秒`;
    this.report('efficiency', ep.at, headline, Math.max(60_000, ep.sec * 1000 + 10_000), undefined, undefined, sig, `efficiency:${key}`);
  }

  /**
   * 同一个动作、同一种失败码又来了：半小时内攒到几次（而且上次为它学过之后又过了一阵）就当成一件值得学的事，
   * 把这些失败的原文和归好类的原因一起交给模型——它能看出是“踩不住”还是“碰头”，该垫脚还是该挖。
   */
  failedAgain(skill: string, code: string, msg: string, at = Date.now()) {
    if (skill === 'use_skill' || /^(CANCELLED|ABORTED|BAD_ARGS)$/.test(code)) return; // 技能自己的失败由改进器管；写错参数不是身体的问题
    // build 报“尚未验收”是房子的验收结果（缺几块、要不要收工），不是身体的毛病：不为它造身体技能
    if (skill === 'build' && /尚未验收/.test(msg)) return;
    const key = `${skill}:${code}`;
    const r = this.recurring.get(key) ?? { at: [], examples: [], reasons: new Map<string, number>(), learnedAt: 0 };
    this.recurring.set(key, r);
    r.at = [...r.at.filter((t) => at - t < RECURRING.windowMs), at];
    const text = msg.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
    r.examples = [...r.examples, text].slice(-10);
    for (const why of reasonOf(text)) r.reasons.set(why, (r.reasons.get(why) ?? 0) + 1);
    // 同一个老毛病学过几次还在犯：间隔一次比一次长（10 分钟、20、40……最多 2 小时），别一遍遍重写同一份技能
    const again = Math.min(RECURRING.maxAgainMs, RECURRING.againMs * 2 ** (r.learned ?? 0));
    if (r.at.length < RECURRING.times || at - r.learnedAt < again) return;
    // 已经有刚写好、还没用够几次的技能管这种失败：等它攒够成败再说（经过已经记进它的成败）
    if (this.engine.list().some((b) => coversFailure(b.when, skill, code) && this.engine.rewriteGate(b.name))) return;
    const reasons = [...r.reasons].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([w, n]) => `${w}（${n} 次）`);
    const lines = [...r.examples.map((e) => `失败：${e}`), `归类的原因：${reasons.join('；')}`,
      ...this.recent.filter((e) => e.ts >= at - 5 * 60_000).slice(-30).map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 150)}`)];
    const n = r.at.length;
    r.learnedAt = at;
    r.learned = (r.learned ?? 0) + 1;
    r.at = [];
    r.examples = [];
    r.reasons.clear();
    this.report('recurring', at, `${skill} 半小时内第 ${n} 次因为 ${code} 失败；常见原因：${reasons.slice(0, 3).join('；')}`, 0, undefined, lines, undefined, `recurring:${key}`);
  }

  /** 一再缺的东西，按次数排：“食物：缺了 29 次（eat NO_FOOD 9、forage NOT_FOUND 20）” */
  chronicShortages(n = 5): string[] {
    const by = new Map<string, Map<string, number>>();
    for (const x of this.shortages) { const m = by.get(x.what) ?? new Map<string, number>(); m.set(x.how, (m.get(x.how) ?? 0) + 1); by.set(x.what, m); }
    return [...by].map(([what, m]) => ({ what, total: [...m.values()].reduce((a, b) => a + b, 0), m })).filter((x) => x.total >= 3)
      .sort((a, b) => b.total - a.total).slice(0, n).map((x) => `${x.what}：缺了 ${x.total} 次（${[...x.m].map(([h, c]) => `${h} ${c}`).join('、')}）`);
  }

  /** 心智指挥身体做了一个动作：记下来，看是不是在一遍遍重复同一串 */
  didAction(skill: string, args: unknown, at = Date.now()) {
    const a = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
    delete a.facing; // 朝向变了做的还是同一件事（相对坐标本来就跟着朝向走）
    const token = `${skill} ${JSON.stringify(a)}`.slice(0, 160);
    this.actions = [...this.actions.filter((x) => at - x.at < REPEATED.windowMs), { at, token }].slice(-80);
    const hit = findRepeat(this.actions.map((x) => x.token));
    if (!hit) return;
    const key = hit.pattern.join(' > ');
    if (at - (this.repeatedAt.get(key) ?? 0) < REPEATED.againMs) return;
    this.repeatedAt.set(key, at);
    this.actions = [];
    const lines = [`重复的一串：${hit.pattern.map((t, i) => `${i + 1}. ${t}`).join('  ')}（最近 ${Math.round(REPEATED.windowMs / 60000)} 分钟里 ${hit.times} 遍）`,
      ...this.recent.filter((e) => e.ts >= at - 6 * 60_000).slice(-60).map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 150)}`)];
    this.report('repeated', at, `心智一步步指挥身体，把「${hit.pattern.map((t) => t.split(' ')[0]).join(' → ')}」这一串重复了 ${hit.times} 遍`, 0, undefined, lines, undefined,
      `repeated:${cycleKey(hit.pattern.map((t) => t.split(' ')[0]))}`);
  }

  /**
   * 目标卡住了（主目标清单很久没勾掉一项）：不问“刚才那次失败怎么补救”，而问“要做到这件事，身体还缺什么能力”。
   * 同一个目标 45 分钟内只问一次。
   */
  goalStuck(goal: string, lines: string[], now = Date.now()) {
    if (now - (this.goalAt.get(goal) ?? 0) < 45 * 60_000) return;
    this.goalAt.set(goal, now);
    this.report('goal', now, `主目标「${goal.slice(0, 60)}」很久没有进展`, 0, undefined, lines);
  }
  private goalAt = new Map<string, number>();

  /** 心智说“刚才这事值得学” */
  /** 同一种“做完又被打破”（同一个动作、同一样东西）半小时内第 2 次：值得想想怎么让效果留住 */
  private undone: { key: string; at: number; msg: string }[] = [];
  private undoneAgain(by: string, item: string, msg: string, at: number) {
    const key = `${by}:${item}`;
    this.undone = [...this.undone.filter((u) => at - u.at < 30 * 60_000), { key, at, msg }];
    const same = this.undone.filter((u) => u.key === key);
    if (same.length !== 2) return;
    this.report('undone', at, `${by} 的效果半小时里第 ${same.length} 次被自己打破：${msg}`, 3 * 60_000, undefined,
      [...same.map((u) => `[${Math.round((u.at - at) / 1000)}s] effect_broken ${u.msg}`), ...this.recent.filter((e) => e.ts >= at - 3 * 60_000 && e.ts <= at).slice(-60).map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 170)}`)],
      undefined, `undone:${key}`);
  }

  noted(note: string, now = Date.now()) { this.report('noted', now, note.slice(0, 200), 3 * 60_000, note.slice(0, 300)); }

  /** 回顾这段时间（太频繁就跳过：至少隔一会儿，免得回顾的内容几乎一样） */
  review(why: string, now = Date.now()) {
    const lines = this.journal();
    if (!lines.length || now - this.lastReview < 5 * 60_000) return;
    this.lastReview = now;
    this.report('review', now, `${why}，回顾这段时间做过的事`, 0, undefined, lines);
  }

  report(kind: ForgeKind, at: number, headline: string, windowMs: number, note?: string, journal?: string[], signal?: LedgerSignal, key?: string) {
    const lines = journal ?? this.recent.filter((e) => e.ts >= at - windowMs && e.ts <= at + 5000).slice(-90)
      .map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 170)}`);
    let st: AgentState | null = null;
    try { st = this.state(); } catch { /* 状态暂不可用 */ }
    // 这件事模型说过归某份技能管：直接交给它，不再请模型
    const owner = this.ownerOf(key);
    if (owner) { this.handOver(kind, headline, owner); return; }
    const incident: Incident = { kind, at, headline: headline.slice(0, 300), lines, ...(note ? { note } : {}), ...(signal ? { signal } : {}), ...(key ? { key } : {}), queuedAt: Date.now(),
      context: st ? { hp: Math.round(st.hp * 10) / 10, food: st.food, isDay: st.isDay, dim: st.dim, inventory: st.inventory.slice(0, 20).map((i) => `${i.name}×${i.count}`),
        // 穿着的和副手的（盾、护甲）不在背包里：不写出来，写技能时就不知道有盾可用
        ...(st.equipment?.length ? { wearing: st.equipment.map((e) => `${e.slot}:${e.name}`) } : {}) } : {} };
    // 挨得很近的同类事并成一件（比如死亡和它引起的吃亏峰值）
    const near = this.queue.find((q) => Math.abs(q.at - at) < 60_000 && (q.kind === kind || (q.kind === 'death' && kind === 'pain')));
    // 还在排队的同一件事又来了：留新的经过
    const same = key ? this.queue.find((q) => q.key === key) : undefined;
    if (same) { same.at = at; same.headline = incident.headline; same.lines = lines; if (note) same.note = [same.note, note].filter(Boolean).join('；'); }
    else if (near) { if (note) near.note = [near.note, note].filter(Boolean).join('；'); }
    else this.queue.push(incident);
    if (this.queue.length > 12) this.queue.splice(0, this.queue.length - 12);
    this.next();
  }

  /** 同一件事：同类，去掉数字（坐标、次数、秒数）后同一句话 */
  static signature(i: Pick<Incident, 'kind' | 'headline'>): string {
    return `${i.kind}:${i.headline.replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 80)}`;
  }

  /** 交给管这件事的技能：记一笔；一再手动重复的动作串，提醒心智有现成技能 */
  private handOver(kind: ForgeKind, headline: string, owner: Owner) {
    const ago = Math.round((Date.now() - owner.at) / 60_000);
    this.bus.publish('skill_forge_owned', 'P3', `「${headline.slice(0, 60)}」归技能「${owner.skill}」管（${ago} 分钟前看过），这次不再请模型`, { kind, skill: owner.skill });
    if (kind === 'repeated') {
      const args = this.engine.get(owner.skill)?.needs;
      this.bus.publish('skill_hint', 'P3', `刚才一步步重复做的这串动作，有现成技能「${owner.skill}」管：use_skill {"name":"${owner.skill}"${args ? `,"args":{${Object.keys(args).map((k) => `"${k}":…`).join(',')}}` : ''}} 一句话做完`, { skill: owner.skill });
    }
  }

  private next() {
    if (this.busy || !this.planner.autonomous || !this.queue.length) return;
    const now = Date.now();
    this.forgedAt = this.forgedAt.filter((t) => now - t < 3_600_000);
    // 死亡和心智点名的先写，回顾最后
    this.queue.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    // 攒批：除了死亡，等第一件进队几分钟，或者攒够几件，一次请模型看完
    const batchMs = this.limits.batchMs ?? 0;
    if (batchMs > 0 && this.queue[0].kind !== 'death' && this.queue.length < SkillSmith.BATCH_MAX) {
      const wait = Math.min(...this.queue.map((q) => q.queuedAt ?? now)) + batchMs - now;
      if (wait > 0) {
        if (!this.batchTimer) { this.batchTimer = setTimeout(() => { this.batchTimer = null; this.next(); }, wait); this.batchTimer.unref?.(); }
        return;
      }
    }
    const batch: Incident[] = [];
    while (this.queue.length && batch.length < SkillSmith.BATCH_MAX) {
      const c = this.queue[0];
      if (batch.length && c.kind === 'death') break;
      // 一小时的额度用完了：死亡照样看，其余的等额度空出来（排队的事太多时旧的会被挤掉）
      if (!batch.length && c.kind !== 'death' && this.forgedAt.length >= this.limits.maxPerHour) {
        if (!this.retryTimer) {
          const wait = Math.max(5_000, this.forgedAt[0] + 3_600_000 - now);
          this.bus.publish('skill_forge_capped', 'P3', `这一小时已经请模型写了 ${this.forgedAt.length} 次技能，先攒着，${Math.ceil(wait / 60_000)} 分钟后再看`, { queued: this.queue.length });
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.next(); }, wait);
          this.retryTimer.unref?.();
        }
        return;
      }
      this.queue.shift();
      const sig = SkillSmith.signature(c);
      // 同一件事刚看过（不管当时写没写成）：不再花一次模型调用
      if (c.kind !== 'death' && now - (this.handledAt.get(sig) ?? -Infinity) < this.limits.repeatMs) {
        this.bus.publish('skill_forge_skipped', 'P3', `「${c.headline.slice(0, 60)}」${Math.round(this.limits.repeatMs / 60_000)} 分钟内已经看过一回，这次不再请模型`, { kind: c.kind });
        continue;
      }
      // 排队时上一批刚判定它归某份技能管
      const owner = this.ownerOf(c.key, now);
      if (owner) { this.handOver(c.kind, c.headline, owner); continue; }
      this.handledAt.set(sig, now);
      if (this.handledAt.size > 200) this.handledAt.delete(this.handledAt.keys().next().value!);
      batch.push(c);
      if (c.kind === 'death') break;
    }
    if (!batch.length) return;
    this.forgedAt.push(now);
    const first = batch[0];
    this.busy = { kind: first.kind, startedAt: Date.now() };
    const what = [...new Set(batch.map((i) => KIND_LABEL[i.kind]))].join('、');
    this.bus.publish('skill_forge_start', 'P2', `在后台从${what}里总结技能${batch.length > 1 ? `（一批 ${batch.length} 件）` : ''}`, { kind: first.kind, count: batch.length });
    void this.forge(batch)
      .then((r) => { this.history = [...this.history, { at: Date.now(), kind: first.kind, result: r }].slice(-20); })
      .catch((e) => {
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        this.history = [...this.history, { at: Date.now(), kind: first.kind, result: `出错：${why}` }].slice(-20);
        this.bus.publish('skill_forge_failed', 'P2', `总结技能没成：${why}`);
      })
      .finally(() => { this.busy = null; this.next(); });
  }

  /** 每种事该怎么看（给模型的任务说明） */
  private taskFor(incident: Incident): string {
    const review = incident.kind === 'review';
    const sig = incident.signal;
    const task = review
      ? `下面是它最近一段时间做过的事，和它的收获账本（每样东西拿一个花多少时间、在变省还是变费劲、东西多出现在什么高度和群系、白忙的比例）。
chronic_shortages 是这两个小时里一再缺的东西：想想能不能把它变成稳定来源（种、养、建一个能持续产出的东西、固定去哪儿补），能写成技能就写，写不了就在 none 的 why 里说清该做什么。
找两类问题：一是反复出现、费时间、常失败的；二是“能做成但费劲”的——花时间最多、在变费劲、或者比它自己最省的那几次慢很多的事，想想有没有更省的做法（换个地方、换个顺序、换个找法、一次多做些）。
判断哪些可以靠一个技能解决（身体以后自己处理，或者让心智用 use_skill 调用的一套做法），写出来（最多 2 份）。`
      : incident.kind === 'goal'
        ? `它的一个主目标迟迟推进不了（下面是目标、清单和这段时间做过的事）。不要只想“刚才那次失败怎么补救”，而是问：要做到这件事，身体还缺什么能力？
缺的如果是一套做法（比如“把一面墙从下往上砌完”“开一条巷道找到铁矿并带回来”“出远门前把床收进背包”），写成调用类技能（不写 when，变化的部分写成 args），优先用 reliable_skills 组合；
缺的如果不是做法，而是该放下或换掉这个目标、该先去弄某样东西，输出 {"none":true,"why":"…"} 并在 why 里说清楚（心智回想时会看到）。`
      : incident.kind === 'undone'
        ? `它做完的一件事过一会儿又被自己打破了（下面是这件事、之后做过的动作和前后经过）：比如把不要的东西扔掉，接着挖东西时顺手捡回来，或者走到掉落物上被自动捡起。
想清楚为什么会被打破、真人玩家会怎么避免（扔到哪、扔完往哪走、先做什么后做什么），能写成技能就写：多半是调用类（不写 when，心智用 use_skill 一句话做完，比如“清背包”），
也可以是恢复类或自动类。纯属偶然、或者应该由思考决定的取舍，输出 {"none":true,"why":"…"}。`
      : incident.kind === 'repeated'
        ? `它的心智一步步指挥身体，把同一串动作重复了好几遍（下面是这串动作和前后经过）。看清楚这串动作在完成什么（比如一级级挖出台阶往上走、一格格垫脚过沟、来回搬东西），
把它练成一个技能：多半写成调用类（不写 when，心智以后用 use_skill 一句话做完，变化的部分写成 args），需要“一直做到某个条件达成”就写代码技能循环；
如果这串动作总是在应对同一种情况（某个动作失败后、某种处境），也可以写成恢复类或自动类。existing_skills 里已经有做这件事的，就用同名改进它，别重复造。
纯属这一次的偶然（比如正好要连砍几棵树）就输出 {"none":true,"why":"…"}。`
      : incident.kind === 'recurring'
        ? `同一个动作一再因为同一种原因失败（下面是这些失败的原文、归好类的原因，和最后一次前后的经过）。
别只看最后一次的位置：找出根本原因（比如目标格脚下踩不住、头顶碰头、路被挡、缺材料），想清楚每种原因真人会怎么处理（垫一块落脚、先挖开头顶、搭一级台阶、绕一下……）。
写一个恢复类技能：when 写 after_failure 这个动作和失败码（需要区分原因就加 cell 条件，或者写成代码技能按原因分别处理），失败时先把原因处理掉，身体再重做那一步。existing_skills 里已经有管这件事、却老不成或被停用的，用同一个名字重写。`
      : sig?.direction === 'slow'
        ? `收获账本发现：它刚才拿 ${sig.item} 比自己平时明显费劲。下面有这次的经过，和账本里拿这样东西最省的几次是怎么做的、它通常出现在哪。
对比这次和省的那几次哪里不一样（地方、顺序、找法、走了多少冤枉路、失败了几次），如果有一个技能能让它以后稳定地按省的方式做，写出来；已有技能管这件事却让它变慢了，就用同名改写。`
        : sig?.direction === 'fast'
          ? `收获账本发现：它刚才拿 ${sig.item} 比自己平时省事得多。下面有这次的经过。找出这次做对了什么（地方、顺序、找法），把这种做法写成技能（多半是让心智用 use_skill 调用的一套做法或代码），让以后能照着做。纯属运气（东西刚好就在旁边）就不写。`
          : `下面是它刚刚经历的一段事（${KIND_LABEL[incident.kind]}）。判断：如果身体当时有一个技能，能不能避免这件事或者处理得更好？能，就写出这个技能。`;
    return task;
  }

  /** 写技能的共同要求（单件、成批都一样） */
  private rules(): string {
    const guide = this.book?.get('writing-skills')?.body ?? '';
    return `你提出的是待验证的技能候选；保存、代码能运行和游戏目标达成是三件不同的事，实际观测才是使用与修订的依据。
要求：
- 针对一类情况，不是只对这一次；触发条件只写身体感觉得到的事（血量、看见或听见的怪、身边的方块、刚失败的动作、是否挨打、是否在坑里）。代码按位置/ID 行动时，hostile 写 seen:true 只看看得见的怪。
- 先在 body 写清调用目标、输入含义与坐标基准、允许的动作与资源消耗、何时停止、以及看什么观测确认结果。目标、手段和资源取舍来自它自己的委托或经历；缺准备条件就报告缺口，不擅自换目标或另做一套流程。
- 能用现有可靠技能就组合它们；固定的几步优先 steps。需要参数化试验时，心智已有 experiment_method（有界参数程序、观测后置条件和试验证据），不能把 program 当成此处尚不支持的 skill 字段；适合这种试验就输出 none，在 why 说明可检验的设想，交给心智选择。确实需要计算（找路、挑方向、挑落脚点）或循环时保留 code，也可以不写 when，做成由心智 use_skill 调用的做法。
- steps 和 code 候选都必须同时写 verify：做完以后看一眼世界、确认真的做成了（脱船就看还在不在船上，出坑就看头顶见不见天，清背包就看那几样少了没有）；判定没通过算这次没做成，会记进成败、交给后台改进。判定至少要调用一次 api.* 观察世界，不能写成恒真（return true）或只信代码返回 ok。
- verify 核对调用方指定的原目标和实际前后观测，不能只信代码返回 ok、自己算出的目标或仅仅发生了移动；未做事的 skipped 不等于目标已完成，无法观察时说明不能确认。循环必须有明确退出条件和次数/时间边界。
- 调用类技能（不写 when）有要调用方给的参数时，写 "args":{"参数名":"意思"} 声明；代码里读 args.参数名，verify 里拿 args.args.参数名 核对目标（别拿代码自己算出来、放进返回值的目标比）。
- existing_skills 里已经有管这件事的技能、只是没做好：用同一个名字重写它，别重复造。
- reliable_skills 是已经验证可靠的技能（积木）：代码里用 api.useSkill 调用它们，能组合现成的就别从底层动作重写一遍；新技能可以比它们高一层（比如“开一条巷道找铁并带回来”调用挖巷道的那份）。
- existing_skills 里标“已收起”的是墓碑（只列了和这次沾边的）：写着当时为什么收起。做不好、被合并而收起的，同一种事没有新证据就输出 none，别把它换个样子再写一遍；标着“不是做不好”的，这次确实需要就用同一个名字重写。
- young_skills 里的技能当前版本还没用够几次，看不出好坏：不要改写它们，也不要换个名字另写一份做同一件事；这次的事归它们管就输出 none（经过已经记进它们的成败）。
- 因为 existing_skills / young_skills / reliable_skills 里已经有一份技能管着这件事才不写的：none 里写 "covered_by":"那份技能的名字"。以后同一件事直接交给它，不再请你看，直到它失败、被改或被收起。
- 不是技能能解决的（纯属运气、应该由思考决定的取舍、缺的是材料不是做法）：输出 {"none":true,"why":"…"}。
- 先分清失败是“做法不对”还是“身体做不到”：动作接口本身没有这种能力（比如步行寻路不会游泳、某种操作根本没有动作可用、返回的信息里看不到决定成败的那件事），
  在上面写技能打补丁也绕不过去，只会写一份收一份。这种输出 {"none":true,"why":"…","limitation":"一句话：身体缺什么能力 / 看不到什么"}，会报给开发者补上，不要写补丁技能。

${instinctNote()}

写技能的说明：
${guide}

代码技能能用的 api：
${API_DOC}`;
  }

  /** 一件事给模型看的材料 */
  private incidentFacts(incident: Incident, maxLines = 90): Record<string, unknown> {
    const review = incident.kind === 'review';
    const sig = incident.signal;
    return {
      what_happened: `${KIND_LABEL[incident.kind]}：${incident.headline}`,
      ...(incident.note ? { its_own_note: incident.note } : {}),
      [review ? 'recent_activities' : 'episode']: incident.lines.slice(-maxLines),
      ...(incident.kind === 'pain' ? { usual_pain: this.pain.baseline() } : {}),
      ...(this.ledger && review ? { harvest_ledger: this.safeLedger(() => this.ledger!.digest(12)) } : {}),
      ...(review && this.chronicShortages().length ? { chronic_shortages: this.chronicShortages() } : {}),
      ...(this.ledger && sig ? { this_time: { ...sig.episode }, ledger_for_item: this.safeLedger(() => [this.ledger!.describe(sig.item)]) } : {}),
    };
  }

  /** 现有技能三张表：给模型判断“这事是不是已经有人管” */
  private skillTables(incidents: Incident[]) {
    const about = incidents.flatMap((i) => [i.headline, i.note ?? '', ...i.lines]).join('\n');
    const focus = incidents.map((i) => `${i.headline}\n${i.note ?? ''}`).join('\n');
    return {
      existing_skills: this.engine.forgeOverview(about, focus),
      reliable_skills: this.engine.reliableList(),
      young_skills: this.engine.list().filter((b) => this.engine.rewriteGate(b.name)).map((b) => { const c = this.engine.currentStats(b.name); return `${b.name}（这一版成 ${c.ok} 败 ${c.fail}）`; }),
    };
  }

  messages(incident: Incident): ChatMessage[] {
    const review = incident.kind === 'review';
    const system = `你是 Minecraft 机器人 Muses 的“身体技能工程师”。${this.taskFor(incident)}
${this.rules()}

只输出一个 JSON 对象：{"skill":{…}}${review ? ' 或 {"skills":[{…},{…}]}' : ''} 或 {"none":true,"why":"…","covered_by":"管这件事的技能名（不是因为已有技能管着才不写就省略）","limitation":"身体做不到时才写"}。`;
    const { what_happened, its_own_note, ...rest } = this.incidentFacts(incident) as Record<string, unknown>;
    const user = { what_happened, ...(its_own_note ? { its_own_note } : {}), ...rest, now: incident.context, ...this.skillTables([incident]) };
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }];
  }

  /** 几件事攒成一批：一次请求看完，最多写 2 份技能 */
  batchMessages(incidents: Incident[]): ChatMessage[] {
    const system = `你是 Minecraft 机器人 Muses 的“身体技能工程师”。下面是这几分钟里攒下的 ${incidents.length} 件事（events），每件带着编号（event）和该怎么看（how_to_look）。
逐件判断：值得写技能就写，不值得就说为什么；几件说的是同一回事可以合写一份。整批最多写 2 份技能。
${this.rules()}

只输出一个 JSON 对象：{"results":[{"event":1,"skill":{…}},{"event":2,"none":true,"why":"…","covered_by":"管这件事的技能名（不是因为已有技能管着才不写就省略）","limitation":"身体做不到时才写"}]}，每件事都要有一条。`;
    const user = {
      events: incidents.map((i, k) => ({ event: k + 1, how_to_look: this.taskFor(i), ...this.incidentFacts(i, 40) })),
      now: incidents.at(-1)!.context,
      ...this.skillTables(incidents),
    };
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }];
  }

  private safeLedger(fn: () => string[]): string[] { try { return fn().filter(Boolean); } catch { return []; } }

  private async forge(batch: Incident[]): Promise<string> {
    const expectedTokens = new Map((this.book?.list() ?? this.engine.list()).map((b) => [b.name, this.engine.editToken(b.name)] as const));
    const single = batch.length === 1;
    const messages = single ? this.messages(batch[0]) : this.batchMessages(batch);
    const label = single ? KIND_LABEL[batch[0].kind] : `一批 ${batch.length} 件`;
    const signal = AbortSignal.timeout(10 * 60_000);
    const settled = new Set<number>();
    const out: string[] = [];
    let written = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.planner.complete(messages, { label: `skill:总结（${label}）`, tier: 'full', signal, attempt, maxTokensScale: 2 });
      const incomplete = c.finishReason === 'length' ? '输出被长度上限截断' : !c.text.trim() ? '模型没有返回正文' : null;
      if (incomplete) {
        this.planner.noteInvalid('总结技能', incomplete);
        messages.push({ role: 'user', content: `刚才${incomplete}，没有保存技能或执行动作。缩小为当前证据支持的一份候选或 none，重新输出完整 JSON；不要续写残片。` });
        continue;
      }
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; } catch (e) {
        this.planner.noteInvalid('总结技能', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      // 成批的回 results；单件（或者模型没照格式）的整个就是第 1 件的结论
      const results: Record<string, any>[] = Array.isArray(raw.results) ? raw.results : [{ ...raw, event: 1 }];
      const errors: string[] = [];
      for (const r of results) {
        const idx = Number(r?.event) - 1;
        const inc = batch[idx];
        if (!inc || settled.has(idx)) continue;
        const tag = single ? '' : `第 ${idx + 1} 件`;
        if (r.none) {
          settled.add(idx);
          const why = String(r.why ?? '').slice(0, 160);
          const by = typeof r.covered_by === 'string' && this.engine.get(r.covered_by) && !this.engine.inactive(r.covered_by) ? r.covered_by : null;
          if (by) this.setOwner(inc, by);
          const limitation = typeof r.limitation === 'string' && r.limitation.trim() ? r.limitation.trim().slice(0, 200) : null;
          if (limitation) this.bus.publish('body_limit', 'P2', `身体做不到的事（报给开发者）：${limitation}`, { kind: inc.kind, limitation, headline: inc.headline.slice(0, 200) });
          this.bus.publish('skill_forge_none', 'P3', `看了${KIND_LABEL[inc.kind]}，没有写技能：${why}${by ? `（归「${by}」管，同一件事以后直接交给它）` : ''}`, { kind: inc.kind, ...(by ? { coveredBy: by } : {}) });
          out.push(`${tag}不写：${why}`);
          continue;
        }
        const drafts = (Array.isArray(r.skills) ? r.skills : [r.skill ?? r]).filter((d: unknown) => d && typeof d === 'object');
        const gated: string[] = [], bad: string[] = [];
        let ok = 0;
        for (const draft of drafts) {
          if (written >= 2) break;
          const { event: _e, ...clean } = draft as Record<string, unknown>;
          const name = typeof clean.name === 'string' ? normalizeSkillName(clean.name) : '';
          const w = this.engine.write(clean, { by: 'forge', expectedToken: expectedTokens.get(name) });
          if (!w.ok) { if ('gated' in w && w.gated) gated.push(w.error); else bad.push(w.error); continue; }
          written++; ok++;
          if (!w.candidate) this.setOwner(inc, w.name);
          const desc = (this.engine.get(w.name, true) ?? this.engine.get(w.name))?.description ?? '';
          out.push(`${tag}${w.candidate ? '待验证候选' : w.created ? '新技能' : '改写'} ${w.name}`);
          this.bus.publish('skill_forged', 'P2', `从${KIND_LABEL[inc.kind]}里${w.candidate ? '写下待验证候选' : w.created ? '总结出新技能' : '改写了技能'}「${w.name}」：${desc}`, { name: w.name, kind: inc.kind, mode: w.mode, created: w.created, candidate: !!w.candidate });
        }
        if (ok || written >= 2) { settled.add(idx); continue; }
        if (gated.length && !bad.length) {
          settled.add(idx);
          this.bus.publish('skill_forge_none', 'P3', `看了${KIND_LABEL[inc.kind]}，想改的技能证据还不够，先不改：${gated[0].slice(0, 120)}`, { kind: inc.kind, gated: true });
          out.push(`${tag}不改：${gated.join('；').slice(0, 200)}`);
          continue;
        }
        errors.push(`${tag}${bad.join('；') || '没有可存的技能'}`);
      }
      if (!errors.length || settled.size === batch.length) break;
      messages.push({ role: 'assistant', content: c.text.slice(0, 6000) },
        { role: 'user', content: `技能存不下：${errors.join('；')}。只改正这几份，${single ? '只输出 JSON' : '照同样的 results 格式只输出这几件'}。` });
      if (attempt === 2 && !out.length) throw new Error('三次都没写出能存下的技能');
    }
    if (!out.length) throw new Error('三次都没写出能存下的技能');
    return out.join('；');
  }
}
