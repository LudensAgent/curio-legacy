import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import type { BehaviorEngine } from '../mind/behaviors.ts';
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
 * - efficiency：收获账本发现拿某样东西这次比它自己平时明显费劲或明显省事（相对自己的历史离群，不是固定阈值）：
 *   费劲了就对比最省的那几次哪里不一样；省事了就把这次的做法记下来，下次照做。不针对哪种东西。
 *
 * 回顾时整本收获账（花时间最多的东西、在变省还是变费、白忙的比例）也一起给模型，问“有没有更省的做法”。
 *
 * 不限次数（模型便宜）；只是同一时间只写一份，其余排队，挨得很近的同类事合并成一件。
 */
export type ForgeKind = 'death' | 'pain' | 'noted' | 'review' | 'efficiency';
const KIND_LABEL: Record<ForgeKind, string> = { death: '死亡', pain: '一段吃了大亏的经历', noted: '自己觉得值得学的事', review: '这段时间的回顾', efficiency: '一次收获效率明显变化' };
const ORDER: ForgeKind[] = ['death', 'noted', 'pain', 'efficiency', 'review'];

interface Incident { kind: ForgeKind; at: number; headline: string; lines: string[]; context: Record<string, unknown>; note?: string; signal?: LedgerSignal }

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

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private book: SkillBook | null,
    private bus: EventBus, private state: () => AgentState, private journal: () => string[] = () => []) {}

  start(tickMs = 5000) {
    this.bus.on('event', this.listener);
    let ticks = 0;
    this.timer = setInterval(() => { this.tick(); if (++ticks % 6 === 0) this.checkPain(); }, tickMs);
    this.timer.unref?.();
  }
  stop() { this.bus.off('event', this.listener); if (this.timer) clearInterval(this.timer); this.timer = null; }

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
    this.report('efficiency', ep.at, headline, Math.max(60_000, ep.sec * 1000 + 10_000), undefined, undefined, sig);
  }

  /** 心智说“刚才这事值得学” */
  noted(note: string, now = Date.now()) { this.report('noted', now, note.slice(0, 200), 3 * 60_000, note.slice(0, 300)); }

  /** 回顾这段时间（太频繁就跳过：至少隔一会儿，免得回顾的内容几乎一样） */
  review(why: string, now = Date.now()) {
    const lines = this.journal();
    if (!lines.length || now - this.lastReview < 5 * 60_000) return;
    this.lastReview = now;
    this.report('review', now, `${why}，回顾这段时间做过的事`, 0, undefined, lines);
  }

  report(kind: ForgeKind, at: number, headline: string, windowMs: number, note?: string, journal?: string[], signal?: LedgerSignal) {
    const lines = journal ?? this.recent.filter((e) => e.ts >= at - windowMs && e.ts <= at + 5000).slice(-90)
      .map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 170)}`);
    let st: AgentState | null = null;
    try { st = this.state(); } catch { /* 状态暂不可用 */ }
    const incident: Incident = { kind, at, headline: headline.slice(0, 300), lines, ...(note ? { note } : {}), ...(signal ? { signal } : {}),
      context: st ? { hp: Math.round(st.hp * 10) / 10, food: st.food, isDay: st.isDay, dim: st.dim, inventory: st.inventory.slice(0, 20).map((i) => `${i.name}×${i.count}`) } : {} };
    // 挨得很近的同类事并成一件（比如死亡和它引起的吃亏峰值）
    const near = this.queue.find((q) => Math.abs(q.at - at) < 60_000 && (q.kind === kind || (q.kind === 'death' && kind === 'pain')));
    if (near) { if (note) near.note = [near.note, note].filter(Boolean).join('；'); }
    else this.queue.push(incident);
    if (this.queue.length > 12) this.queue.splice(0, this.queue.length - 12);
    this.next();
  }

  private next() {
    if (this.busy || !this.planner.autonomous || !this.queue.length) return;
    // 死亡和心智点名的先写，回顾最后
    this.queue.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    const incident = this.queue.shift()!;
    this.busy = { kind: incident.kind, startedAt: Date.now() };
    this.bus.publish('skill_forge_start', 'P2', `在后台从${KIND_LABEL[incident.kind]}里总结技能`, { kind: incident.kind });
    void this.forge(incident)
      .then((r) => { this.history = [...this.history, { at: Date.now(), kind: incident.kind, result: r }].slice(-20); })
      .catch((e) => {
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        this.history = [...this.history, { at: Date.now(), kind: incident.kind, result: `出错：${why}` }].slice(-20);
        this.bus.publish('skill_forge_failed', 'P2', `总结技能没成：${why}`);
      })
      .finally(() => { this.busy = null; this.next(); });
  }

  messages(incident: Incident): ChatMessage[] {
    const guide = this.book?.get('writing-skills')?.body ?? '';
    const review = incident.kind === 'review';
    const sig = incident.signal;
    const task = review
      ? `下面是它最近一段时间做过的事，和它的收获账本（每样东西拿一个花多少时间、在变省还是变费劲、东西多出现在什么高度和群系、白忙的比例）。
找两类问题：一是反复出现、费时间、常失败的；二是“能做成但费劲”的——花时间最多、在变费劲、或者比它自己最省的那几次慢很多的事，想想有没有更省的做法（换个地方、换个顺序、换个找法、一次多做些）。
判断哪些可以靠一个技能解决（身体以后自己处理，或者让心智用 use_skill 调用的一套做法），写出来（最多 2 份）。`
      : sig?.direction === 'slow'
        ? `收获账本发现：它刚才拿 ${sig.item} 比自己平时明显费劲。下面有这次的经过，和账本里拿这样东西最省的几次是怎么做的、它通常出现在哪。
对比这次和省的那几次哪里不一样（地方、顺序、找法、走了多少冤枉路、失败了几次），如果有一个技能能让它以后稳定地按省的方式做，写出来；已有技能管这件事却让它变慢了，就用同名改写。`
        : sig?.direction === 'fast'
          ? `收获账本发现：它刚才拿 ${sig.item} 比自己平时省事得多。下面有这次的经过。找出这次做对了什么（地方、顺序、找法），把这种做法写成技能（多半是让心智用 use_skill 调用的一套做法或代码），让以后能照着做。纯属运气（东西刚好就在旁边）就不写。`
          : `下面是它刚刚经历的一段事（${KIND_LABEL[incident.kind]}）。判断：如果身体当时有一个技能，能不能避免这件事或者处理得更好？能，就写出这个技能。`;
    const system = `你是 Minecraft 机器人 Curio 的“身体技能工程师”。${task}
写下的技能立刻生效，下次遇到同类情况身体会自己做。
要求：
- 针对一类情况，不是只对这一次；触发条件只写身体感觉得到的事（血量、看见的怪、身边的方块、刚失败的动作、是否挨打、是否在坑里）。
- 需要计算（找路、挑方向、挑落脚点、判断要不要打）就写代码技能（code）；简单固定的几步可以写 steps；也可以不写 when，做成让心智在 routine 里 use_skill 调用的连招。
- existing_skills 里已经有管这件事的技能、只是没做好：用同一个名字重写它，别重复造。
- 不是技能能解决的（纯属运气、应该由思考决定的取舍、缺的是材料不是做法）：输出 {"none":true,"why":"…"}。

写技能的说明：
${guide}

代码技能能用的 api：
${API_DOC}

只输出一个 JSON 对象：{"skill":{…}}${review ? ' 或 {"skills":[{…},{…}]}' : ''} 或 {"none":true,"why":"…"}。`;
    const user = {
      what_happened: `${KIND_LABEL[incident.kind]}：${incident.headline}`,
      ...(incident.note ? { its_own_note: incident.note } : {}),
      [review ? 'recent_activities' : 'episode']: incident.lines,
      now: incident.context,
      existing_skills: this.engine.overview(),
      ...(incident.kind === 'pain' ? { usual_pain: this.pain.baseline() } : {}),
      ...(this.ledger && review ? { harvest_ledger: this.safeLedger(() => this.ledger!.digest(12)) } : {}),
      ...(this.ledger && sig ? { this_time: { ...sig.episode }, ledger_for_item: this.safeLedger(() => [this.ledger!.describe(sig.item)]) } : {}),
    };
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }];
  }

  private safeLedger(fn: () => string[]): string[] { try { return fn().filter(Boolean); } catch { return []; } }

  private async forge(incident: Incident): Promise<string> {
    const messages = this.messages(incident);
    const signal = AbortSignal.timeout(10 * 60_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.planner.complete(messages, { label: `skill:总结（${KIND_LABEL[incident.kind]}）`, tier: 'full', signal, attempt, maxTokensScale: 2 });
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; } catch (e) {
        this.planner.noteInvalid('总结技能', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      if (raw.none) {
        const why = String(raw.why ?? '').slice(0, 160);
        this.bus.publish('skill_forge_none', 'P3', `看了${KIND_LABEL[incident.kind]}，没有写技能：${why}`, { kind: incident.kind });
        return `不写：${why}`;
      }
      const drafts = (Array.isArray(raw.skills) ? raw.skills : [raw.skill ?? raw]).slice(0, 2);
      const done: string[] = [], errors: string[] = [];
      for (const draft of drafts) {
        const w = this.engine.write(draft);
        if (!w.ok) { errors.push(w.error); continue; }
        const desc = this.engine.get(w.name)?.description ?? '';
        done.push(`${w.created ? '新技能' : '改写'} ${w.name}`);
        this.bus.publish('skill_forged', 'P2', `从${KIND_LABEL[incident.kind]}里${w.created ? '总结出新技能' : '改写了技能'}「${w.name}」：${desc}`, { name: w.name, kind: incident.kind, mode: w.mode, created: w.created });
      }
      if (done.length) return done.join('、');
      messages.push({ role: 'assistant', content: c.text.slice(0, 6000) }, { role: 'user', content: `技能存不下：${errors.join('；')}。改正后只输出 JSON。` });
    }
    throw new Error('三次都没写出能存下的技能');
  }
}
