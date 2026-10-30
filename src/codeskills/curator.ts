import type { EventBus } from '../events.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import { isEmergency, type Behavior, type BehaviorEngine } from '../mind/behaviors.ts';
import type { LedgerView } from '../mind/ledger.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { extractJson } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentState } from '../adapter/types.ts';
import { ObservedGameClock } from './game-clock.ts';

/**
 * 整理技能：技能多了以后像人整理笔记一样定期理一理。
 * - 长期用不上的（写下很久了、一直没触发过或很久没用）：收起来，不再占提示词、不再参与竞争；
 * - 说的是同一件事、触发条件重叠、常常抢着接手的：后台请一次模型合并成一份、调整谁先上、收起多余的。
 * - 升级：看收获账本里每个技能的实际效果（用它时拿东西每个花多少、和不用它比、各版本比），
 *   能用但让事情变慢的交给改进器去改（improve），新版本不如旧版本的退回旧版（rollback），没用还拖后腿的收起。
 * 收起不是删除：完整契约、笔记和成败都保留，显式修订或选择历史先成为候选，验收后再启用。
 * 什么时候请模型：有新技能、有新冲突、或者账本里又攒了一批用过技能的经历（够判断效果了）。
 */
export interface CuratorOptions { checkMs: number; unusedDays: number; candidateUnusedDays: number; disabledDays: number; gapMs: number; minSkills: number; /** 同时留着的自己写的技能最多几份：多了就收起最没用的 */ maxActive: number }
export const DEFAULT_CURATOR: CuratorOptions = { checkMs: 60_000, unusedDays: 60, candidateUnusedDays: 15, disabledDays: 5, gapMs: 0, minSkills: 4, maxActive: 24 };
const DAY_TICKS = 24_000;
type Lifetime = { world: string; name: string; candidate: boolean; version: number; clock: number; age: number; idle: number; disabled: number;
  activity: string; restoredAt: number; disabledAt: number; retired: boolean };

/** 名字和说明里的词：名字按 - 拆，说明按相邻两个字（中文没有空格） */
function words(name: string, description = ''): { name: Set<string>; text: Set<string> } {
  const text = new Set<string>();
  const d = description.replace(/[\s，。、；：:（）()“”"',.!?！？]/g, '');
  for (let i = 0; i + 1 < d.length; i++) text.add(d.slice(i, i + 2));
  return { name: new Set(name.toLowerCase().split(/[-_]/).filter((w) => w.length > 1)), text };
}
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

function catches(a: unknown, b: unknown): boolean {
  const fa = (a as any)?.after_failure, fb = (b as any)?.after_failure;
  if (!fa || !fb) return false;
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
  const meet = (x: string[], y: string[]) => !x.length || !y.length || x.some((v) => y.includes(v));
  const sa = list(fa.skill), sb = list(fb.skill);
  return sa.length > 0 && sb.length > 0 && sa.some((v) => sb.includes(v)) && meet(list(fa.code), list(fb.code));
}

/** 看着像同一件事的技能：名字相近、说明相近，或者条件一模一样且说明也有点像。只是候选，合不合并由整理时判断 */
export function similarSkills(skills: { name: string; description?: string; when?: unknown }[]): [string, string, number][] {
  const w = skills.map((b) => ({ b, ...words(b.name, b.description), when: b.when ? JSON.stringify(b.when) : '' }));
  const out: [string, string, number][] = [];
  for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
    const nj = jaccard(w[i].name, w[j].name), dj = jaccard(w[i].text, w[j].text);
    const sameWhen = !!w[i].when && w[i].when === w[j].when;
    // 接的是同一种失败（同一个动作、同一种失败码）：两份“出了这个错怎么办”多半在抢同一件事
    const sameFailure = catches(w[i].b.when, w[j].b.when);
    const score = Math.max(nj, dj, sameWhen ? 0.3 + dj : 0, sameFailure ? 0.4 + dj : 0);
    if (nj >= 0.5 || dj >= 0.45 || (sameWhen && dj >= 0.2) || sameFailure) out.push([w[i].b.name, w[j].b.name, Math.round(score * 100) / 100]);
  }
  return out.sort((a, b) => b[2] - a[2]);
}

/** 模型回复只在这里归一化；执行阶段继续核对对应技能和版本。 */
function parseCuration(text: string) {
  const raw = extractJson(text);
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(raw)) throw new Error('整理结果需要 JSON 对象');
  const rows = (key: string) => Array.isArray(raw[key]) ? raw[key].filter(object) : [];
  return {
    ok: raw.ok === true,
    merge: rows('merge').slice(0, 4).map((entry) => {
      const skill = object(entry.skill) ? entry.skill : {};
      return { from: Array.isArray(entry.from) ? entry.from.map(String) : [], skill,
        note: typeof skill.body === 'string' && !skill.code && !skill.steps && !skill.when
          ? { name: String(skill.name ?? ''), description: String(skill.description ?? ''), body: skill.body } : undefined };
    }),
    priority: rows('priority').slice(0, 8).map((entry) => ({ name: String(entry.name ?? ''), priority: Number(entry.priority) })).filter((entry) => Number.isFinite(entry.priority)),
    retire: rows('retire').slice(0, 8).map((entry) => ({ name: String(entry.name ?? ''), target: entry.target === undefined ? undefined : String(entry.target),
      version: typeof entry.version === 'number' ? entry.version : undefined, why: String(entry.why ?? '整理时收起') })),
    restore: rows('restore').slice(0, 8).map((entry) => ({ name: String(entry.name ?? '') })),
    rollback: rows('rollback').slice(0, 4).map((entry) => ({ name: String(entry.name ?? ''), to: Math.floor(Number(entry.to)), why: String(entry.why ?? '').slice(0, 100) })),
    improve: rows('improve').slice(0, 3).map((entry) => ({ name: String(entry.name ?? ''), why: String(entry.why ?? '').slice(0, 200) })),
  };
}

export class SkillCurator {
  busy = false;
  lastRun = 0;
  private lastSignature = '';
  private conflictSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private observationTimer: NodeJS.Timeout | null = null;
  private lifetimes = new Map<string, Lifetime>();
  private savedAt = 0;
  observation: (() => { state: AgentState; paused: boolean }) | null = null;
  private breakObservation = (event: { type: string; data?: Record<string, unknown> }) => {
    if (['paused', 'resumed', 'disconnected', 'death', 'spawn'].includes(event.type)) this.gameClock.resetBaseline();
    if (event.type === 'skill_promoted') for (const [key, entry] of this.lifetimes) {
      if (entry.candidate && entry.name === event.data?.name) this.lifetimes.delete(key);
    }
    if (event.type === 'skill_disabled' || event.type === 'skill_retired') for (const entry of this.lifetimes.values()) {
      if (entry.candidate && entry.name === event.data?.name && this.engine.executionError(entry.name, true)) entry.retired = true;
    }
  };
  readonly opts: CuratorOptions;
  history: { at: number; result: string }[] = [];
  /** 收获账本：每个技能对收获效率的实际影响 */
  ledger: (LedgerView & { skillEpisodes(): number }) | null = null;
  private evidenceSeen = 0;
  /** 现在在哪个维度（main 接到身体状态） */
  dim: () => string = () => '';
  /** 攒够这么多段“用过技能的经历”就值得再看一遍效果 */
  evidenceStep = 15;

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private book: SkillBook | null,
    private bus: EventBus, opts: Partial<CuratorOptions> = {}, private gameClock = new ObservedGameClock(), private lifetimeFile: string | null = null) {
    this.opts = { ...DEFAULT_CURATOR, ...opts };
    if (lifetimeFile && fs.existsSync(lifetimeFile)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(lifetimeFile, 'utf8'));
        if (!Array.isArray(raw)) throw new Error('技能游戏时间记录不是数组');
        for (const value of raw as unknown[]) {
          if (!value || typeof value !== 'object') continue;
          const row = value as Record<string, unknown>;
          if (typeof row.world !== 'string' || typeof row.name !== 'string' || typeof row.candidate !== 'boolean' || typeof row.activity !== 'string'
            || typeof row.retired !== 'boolean' || !['version', 'clock', 'age', 'idle', 'disabled', 'restoredAt', 'disabledAt'].every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0)) continue;
          const entry = row as Lifetime;
          this.lifetimes.set(JSON.stringify([entry.world, entry.name, entry.candidate]), entry);
        }
      } catch (error) { this.bus.publish('skill_clock_unknown', 'P2', `无法重建旧技能的有效游戏时间，从新观察开始：${String(error)}`); }
    }
    this.bus.on('event', this.breakObservation);
  }

  start() {
    this.bus.off('event', this.breakObservation);
    this.bus.on('event', this.breakObservation);
    if (!this.timer) { this.timer = setInterval(() => void this.check(), this.opts.checkMs); this.timer.unref?.(); }
    if (!this.observationTimer) {
      this.observationTimer = setInterval(() => {
        const observation = this.observation?.();
        if (observation) this.observe(observation.state, observation.paused);
        if (Date.now() - this.savedAt >= 30_000) this.saveTime();
      }, 1000);
      this.observationTimer.unref?.();
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.timer = this.observationTimer = null;
    this.gameClock.resetBaseline();
    this.bus.off('event', this.breakObservation);
    this.saveTime();
  }

  observe(state: AgentState, paused: boolean, now = Date.now()) {
    this.gameClock.observe(state, paused, now);
    this.syncLifetimes(state.dim);
  }

  private syncLifetimes(dim = this.safe(() => this.dim(), '')) {
    const world = this.gameClock.worldId;
    if (!world) return;
    const clock = this.gameClock.ticks();
    for (const [key, entry] of this.lifetimes) {
      if (entry.candidate && !this.engine.get(entry.name, true)) this.lifetimes.delete(key);
    }
    for (const b of [...this.engine.list().filter((entry) => !entry.candidate), ...this.engine.list(true)].filter((entry) => entry.source === 'self')) {
      const candidate = !!b.candidate, version = b.version ?? 1, st = this.engine.statsOf(b.name);
      const key = JSON.stringify([world, b.name, candidate]);
      const prev = this.lifetimes.get(key);
      const per = st?.byVersion?.[String(version)];
      // 只有有实际成败证据的调用刷新闲置；跳过、取消和后台改写均不刷新。
      const activity = JSON.stringify([per?.ok ?? 0, per?.fail ?? 0]);
      const retired = candidate ? !!this.engine.executionError(b.name, true) : !!st?.retired;
      const disabledAt = !candidate && st?.disabled ? st.disabledAt ?? st.retiredAt ?? 1 : 0;
      const restoredAt = candidate ? 0 : st?.restoredAt ?? 0;
      const fresh = !prev || clock < prev.clock || prev.retired && !retired || restoredAt !== prev.restoredAt
        || candidate && prev.version !== version && (st?.candidateRetired?.version === prev.version || this.engine.get(b.name)?.version === prev.version);
      const delta = !fresh && (!b.when?.dim || b.when.dim.includes(dim)) ? Math.max(0, clock - prev.clock) : 0;
      const changed = prev?.version !== version;
      const used = prev && (!changed && prev.activity !== activity || changed && (per?.ok ?? 0) + (per?.fail ?? 0) > 0);
      this.lifetimes.set(key, { world, name: b.name, candidate, version, clock, activity, retired, restoredAt, disabledAt,
        age: fresh || changed ? 0 : prev.age + delta,
        idle: fresh || used || changed && !candidate ? 0 : prev.idle + delta,
        disabled: fresh || !disabledAt || prev.disabledAt !== disabledAt ? 0 : prev.disabled + delta });
    }
  }

  private lifetime(b: Behavior) { return this.lifetimes.get(JSON.stringify([this.gameClock.worldId, b.name, !!b.candidate])); }

  private saveTime() {
    this.syncLifetimes();
    this.gameClock.save();
    if (this.lifetimeFile) {
      fs.mkdirSync(path.dirname(this.lifetimeFile), { recursive: true });
      fs.writeFileSync(this.lifetimeFile, JSON.stringify([...this.lifetimes.values()]));
    }
    this.savedAt = Date.now();
  }

  /** 救命技能平时很少触发是正常的（岩浆、窒息、埋身这类不天天发生），
   * 不能因为“好久没用上”或“技能太多”就收起——候选和未验收的也一样：没出事前本就没法验收。
   * 真正坏掉的（用了 ≥4 次却很少成功）仍由 retireLowValue 第一段收起；重复的仍由整理模型合并/收起。 */
  private protectedEmergency(b: Behavior) {
    return isEmergency(b) && (b.candidate || this.engine.enabled(b));
  }

  private active() {
    return [...this.engine.list().filter((b) => !b.candidate), ...this.engine.list(true)]
      .filter((b) => b.source === 'self' && (!this.engine.statsOf(b.name)?.retired || b.candidate && !this.engine.executionError(b.name, true))
        && (!b.candidate || !this.engine.candidateRetirement(b.name)));
  }

  private notes() { return (this.book?.list() ?? []).filter((entry) => entry.source === 'self' && entry.behavior === undefined && !this.book?.candidate(entry.name)); }

  private signature() {
    return [...this.active().map((b) => `${b.name}@${b.candidate ? 'candidate' : 'stable'}:${b.version}:${this.written(b)}:${!!this.engine.statsOf(b.name)?.disabled}:${b.notes ?? ''}`),
      ...this.notes().map((entry) => `${entry.name}@note:${entry.updatedAt}:${this.engine.inactive(entry.name)}`)].sort().join('|');
  }

  private written(b: Pick<Behavior, 'name' | 'candidate'>) {
    return (b.candidate ? this.book?.candidate(b.name) : this.book?.get(b.name))?.updatedAt ?? Date.now();
  }

  private retire(b: Behavior, why: string) {
    return b.candidate ? this.engine.retireCandidate(b.name, b.version!, why) : this.engine.retire(b.name, why, { preserveCandidate: true });
  }

  /** 收起长期用不上的自己写的技能（不需要模型） */
  retireUnused(_now = Date.now()): string[] {
    const out: string[] = [];
    let dim = '';
    try { dim = this.dim(); } catch { /* 状态暂不可用 */ }
    this.syncLifetimes(dim);
    for (const b of this.active()) {
      if (this.protectedEmergency(b)) continue;
      // 只在别的维度生效的技能（比如下界专用的）：人不在那儿时用不上是正常的，不算“长期不用”
      if (b.when?.dim && dim && !b.when.dim.includes(dim)) continue;
      const life = this.lifetime(b);
      if (!life) continue; // 旧记录缺少在线游戏时间，不能从现实时间倒推。
      const disabled = !b.candidate && !!this.engine.statsOf(b.name)?.disabled;
      const ticks = disabled ? life.disabled : life.idle;
      const limit = disabled ? this.opts.disabledDays : b.candidate ? this.opts.candidateUnusedDays : this.opts.unusedDays;
      if (ticks >= limit * DAY_TICKS && this.retire(b, disabled
        ? `已停用并观察 ${Math.floor(ticks / DAY_TICKS)} 个有效游戏日，收起执行版本；完整历史和成功证据保留`
        : `在线观察 ${Math.floor(ticks / DAY_TICKS)} 个有效游戏日没用上`)) out.push(b.name);
    }
    return out;
  }

  /** 容量整理给新版本半个有效游戏日；明确高失败证据不必等时钟。 */
  private settled(b: Behavior, dim: string) {
    if (b.when?.dim && dim && !b.when.dim.includes(dim)) return false;
    return (this.lifetime(b)?.age ?? 0) >= DAY_TICKS / 2;
  }

  /**
   * 收起不值得留的（不需要模型）：
   * - 与执行端停用一致：当前版本至少 4 次有效执行、成功不到 25%，不让停用版卡在另一套门槛；
   * - 技能太多（超过 maxActive）时，最没用的那些：从没成功过的、用得最少的、最久没用的先收。
   * 容量整理给新版本观察期；明确失败证据不因刚写或当前处于别的维度而永久挂起。
   */
  retireLowValue(_now = Date.now()): string[] {
    const out: string[] = [];
    let dim = '';
    try { dim = this.dim(); } catch { /* 状态暂不可用 */ }
    this.syncLifetimes(dim);
    for (const b of this.active()) {
      const st = this.engine.currentStats(b.name, !!b.candidate);
      const tries = (st?.ok ?? 0) + (st?.fail ?? 0);
      if (tries >= 4 && st.ok / tries < 0.25 && this.retire(b, `当前版本用了 ${tries} 次只成了 ${st.ok} 次，收起执行版本；完整历史和成功证据保留`)) out.push(b.name);
    }
    // 当前确实成功过的可用应急版不占容量；仅有应急用途的候选照常整理。
    const active = this.active();
    const left = active.filter((b) => !this.protectedEmergency(b) && (!b.candidate || !active.some((other) => other.name === b.name && !other.candidate)));
    const over = left.length - this.opts.maxActive;
    if (over > 0) {
      const value = (b: Behavior) => { const st = this.engine.currentStats(b.name, !!b.candidate); return st.ok * 3 - st.fail; };
      const victims = left.filter((b) => this.settled(b, dim)).sort((a, b) => value(a) - value(b) || (this.lifetime(b)?.idle ?? 0) - (this.lifetime(a)?.idle ?? 0)).slice(0, over);
      for (const b of victims) {
        const st = this.engine.currentStats(b.name, !!b.candidate);
        if (this.retire(b, `技能太多（${left.length} 份），它最少派上用场（当前版本成 ${st.ok} 败 ${st.fail}）`)) out.push(b.name);
      }
    }
    return out;
  }

  /** 定时检查：先收起用不上的、没用的；技能够多、而且有新技能、冲突或看着重复的，才请模型合并 */
  async check(now = Date.now(), opts: { force?: boolean } = {}): Promise<string | null> {
    if (this.busy) return opts.force ? '正在整理技能，请等待本次完成' : null;
    const retired = [...this.retireUnused(now), ...this.retireLowValue(now)];
    this.saveTime();
    const skills = this.active();
    const notes = this.notes();
    const signature = this.signature();
    const retiredText = retired.length ? `已收起 ${retired.join('、')}；` : '';
    if (!this.planner.autonomous) return opts.force ? `${retiredText}没有自主模型，无法进行模型整理` : retired.length ? retiredText : null;
    if (!skills.length && !notes.length) return opts.force ? `${retiredText}没有可整理的自学技能或文字记录` : retired.length ? retiredText : null;
    // 冲突只看上次整理之后新增的
    const conflicted = skills.some((b) => Object.values(this.engine.statsOf(b.name)?.conflicts ?? {}).reduce((n, v) => n + v, 0) - (this.conflictSeen.get(b.name) ?? 0) >= 3);
    const evidence = this.safe(() => this.ledger?.skillEpisodes() ?? 0, 0);
    const newEvidence = evidence - this.evidenceSeen >= this.evidenceStep;
    // 只有效果证据的话，技能少也值得看（一两个技能也可能在拖后腿）
    const enough = new Set([...skills, ...notes].map((entry) => entry.name)).size >= this.opts.minSkills || ((newEvidence || conflicted) && skills.length > 0);
    if (!opts.force && (!enough || now - this.lastRun < this.opts.gapMs || (signature === this.lastSignature && !conflicted && !newEvidence))) {
      return retired.length ? `收起 ${retired.join('、')}` : null;
    }
    this.busy = true;
    this.lastRun = now;
    for (const b of skills) this.conflictSeen.set(b.name, Object.values(this.engine.statsOf(b.name)?.conflicts ?? {}).reduce((n, v) => n + v, 0));
    this.lastSignature = signature;
    this.evidenceSeen = evidence;
    this.bus.publish('skill_curate_start', 'P3', `在后台整理技能（${skills.length} 个执行版本、${notes.length} 份文字记录）`, { forced: !!opts.force });
    try {
      const r = retiredText + await this.curate();
      // 整理本身改写了技能：记下整理后的样子，免得下一轮把自己的改动当成“有新技能”
      this.lastSignature = this.signature();
      this.history = [...this.history, { at: Date.now(), result: r }].slice(-10);
      this.bus.publish('skill_curated', 'P3', `技能整理完成：${r}`, { forced: !!opts.force });
      return r;
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 160);
      const result = `${retiredText}整理出错：${why}`;
      this.history = [...this.history, { at: Date.now(), result }].slice(-10);
      this.bus.publish('skill_curate_failed', 'P2', `整理技能没成：${why}`);
      return null;
    } finally { this.busy = false; }
  }

  messages(): ChatMessage[] {
    const similar = new Map<string, string[]>();
    for (const [a, b] of similarSkills(this.active())) { if (a === b) continue; similar.set(a, [...(similar.get(a) ?? []), b]); similar.set(b, [...(similar.get(b) ?? []), a]); }
    const skills = this.active().map((b) => {
      const st = this.engine.statsOf(b.name);
      return { name: b.name, target: b.candidate ? 'candidate' : 'skill', version: b.version ?? 1, disabled: !!st?.disabled,
        description: b.description, body: b.body, notes: b.notes, mode: b.mode, priority: b.priority, ...(b.when ? { when: b.when } : {}), ...(isEmergency(b) ? { lifesaver: true } : {}),
        kind: b.code ? `代码 v${b.version ?? 1}（${b.code.length} 字符）` : `${b.steps.length} 步`,
        protectedEmergency: this.protectedEmergency(b), successfulEmergencyVersions: this.engine.successfulEmergencyVersions(b.name),
        observedGameDays: this.lifetime(b) ? { age: this.lifetime(b)!.age / DAY_TICKS, idle: this.lifetime(b)!.idle / DAY_TICKS, disabled: this.lifetime(b)!.disabled / DAY_TICKS } : null,
        uses: { ...this.engine.currentStats(b.name, !!b.candidate), ...(b.candidate ? {} : { fired: st?.fired ?? 0 }) },
        lifetime: st ? { ok: st.ok, fail: st.fail } : { ok: 0, fail: 0 },
        ...(st?.byVersion && Object.keys(st.byVersion).length > 1 ? { versions: st.byVersion } : {}),
        ...(this.effect(b.name) ? { harvest_effect: this.effect(b.name) } : {}),
        ...(st?.conflicts && Object.keys(st.conflicts).length ? { clashed_with: st.conflicts } : {}),
        ...(similar.get(b.name)?.length ? { similar_to: similar.get(b.name) } : {}),
        ...(st?.undid && Object.keys(st.undid).length ? { undid_work_of: st.undid } : {}),
        ...(st?.idleInterrupts ? { idle_interrupts: st.idleInterrupts } : {}),
        ...(st?.undoneBy && Object.keys(st.undoneBy).length ? { work_undone_by: st.undoneBy } : {}),
        ...(st?.loops?.length ? { see_sawed_with: st.loops.map((l) => `${l.with.startsWith('doing:') ? `手上的「${l.with.slice(6)}」` : `「${l.with}」`}（${l.times} 回）`) } : {}), ...(b.code ? { code: b.code.slice(0, 2500), ...(b.verify ? { verify: b.verify } : {}) } : { steps: b.steps }) };
    });
    const notes = this.notes().map((entry) => ({ name: entry.name, target: 'note', description: entry.description, body: entry.body, notes: entry.notes,
      retired: this.engine.statsOf(entry.name)?.retired ?? null, disabled: this.engine.inactive(entry.name) }));
    const system = `你在整理 Minecraft 机器人 Muses 自己写的技能及文字记录。像人整理笔记一样：
- skills 分开列正式版本（target:skill）和候选（target:candidate）；同名两者的证据不能混用。retire 必须带 target；执行版本再带 version。收起候选不会收起同名稳定版；收起正式版时，未收起的同名候选仍可显式试用。
- 已停用但未收起的技能也要评估；候选没有验收通过不等于已经会用。候选可保留试用、同名修订或依据证据收起，不强制心智做任何试验。
- notes 是纯文字记录，不参与执行成败和闲置淘汰。可按内容重复或已被事实推翻来 retire（target:note），不能因为没有执行次数就收起。确有用途时可用 restore 恢复文字记录；读取不代表做法验证成功。
- 合并纯文字记录也用 merge：from 只能写 notes 中的名字，skill 只写 name、description、body；先保留原记录，是否收起来源再明确决定。写入已收起的文字目标不会自动恢复，需要时另写 restore。已有行为技能的补充笔记保留在 notes 中，修订必须保留其仍适用的约束。
- 说的是同一件事、触发条件大面积重叠的：合并成一份更好的（merge：from 写被合并的名字，skill 写合并后的完整技能，可以沿用其中一个名字）。合并时保留各自真正管用的部分（看 uses 的成败）。
- 行为 merge 先保存候选，原技能保留；候选实际验收通过后再根据新证据决定是否 retire 来源技能。uses 是表中指定版本的证据，lifetime 是历史总计，不混用。
- 来回拉锯的（see_sawed_with：一个做完另一个又把它推回去，或者技能一再打断手上同一件事）：这最要紧——找出两边条件为什么会轮流成立，
  收窄条件让它们不再互相触发（比如躲怪的技能加上“怪还在附近”、回地表的技能加上“附近没有怪”），或者合并成一份统一处理；
- 动作上互相拆台的（undid_work_of：它挖掉了那个技能放的方块、或把那个技能挖开的地方又填上，数字是格数；work_undone_by 是反过来）：和拉锯一样要紧。
  看两边各自想达到什么，让它们不再在同一处反着做：收窄其中一个的条件、让一个先检查另一个的成果（比如“脚下是自己刚垫的块就不挖”）、或者合并成一份；
- 白白打断的（idle_interrupts：条件成立接手了，代码却什么都没做就返回、人也没动，打断了手上的活的次数）：when 比代码里真正动手的判断宽，把 when 收窄到和代码一致。
- 常常同时满足条件抢着接手的（clashed_with）：调整优先级（priority：更管用、更要紧的高），或者收窄某个的触发条件（用 merge 重写它）。
- 明显没用、被别的技能完全覆盖的：收起（retire）。
- lifesaver 只描述应急用途，不代表已经有效。protectedEmergency=true 的应急技能（稳定版和候选都算）免闲置和容量收起——救命的技能平时很少触发、没法预先验收，不能因为“好久没用上”就收；但真正坏掉的（本版用了 ≥4 次却很少成功）仍照常收起。未验证候选和已停用应急版不能借同名旧版成功永久保留。
- successfulEmergencyVersions 列出保留的成功应急版本；收起不会删除完整契约、笔记和证据，心智可用 skill {name,from_version:N} 显式生成新候选重新验收，不能把历史成功当作新候选成功。
- observedGameDays 只累计在线、未暂停的有效游戏刻（每天24000tick）；未知历史为null，不能按现实时间或离线期间的世界日期差推断闲置。普通${this.opts.unusedDays}日、候选${this.opts.candidateUnusedDays}日、停用${this.opts.disabledDays}日自动收起；纯改写不刷新候选闲置。
- similar_to 是名字或说明看着相近的：逐对看是不是在做同一件事。是的话合并成一份，或者收起用得少、成得少的那份（uses 少的、fail 多的）；只是名字像、其实管的是两回事的就留着。
- 技能越少越好记、越不容易互相抢：功能重复的、用了很少次还没成过的，宁可收起；真需要时还能再学。
- 看 harvest_effect（用它时拿东西每个花多少秒、和不用它比、各版本比）：
  · 代码技能能用但让事情变慢、或者明显还能更省的：交给后台改（improve，why 写清楚慢在哪）；
  · versions 里新版本的成败或 harvest_effect 明显不如旧版本：退回旧版本（rollback，to 写版本号数字）；
  · 不是代码的技能拖慢了事情：用 merge 重写它（from 写它自己）；既没用又拖后腿：收起。
  · 数据太少（一两次）不下结论。
- 没有要整理的就输出 {"ok":true}。不要为了整理而整理。
技能格式和写法与原来相同（when / steps 或 code / priority / cooldown_s / args）；合并出来的代码技能要带 verify（判定：做完以后看一眼世界确认真的做成了，只能用 api.state/blockAt/region/entities/drops/nearestLand，return true 算成、return "原因" 算没成），可以沿用原来的判定。
只输出一个 JSON 对象：{"merge":[{"from":["a","b"],"skill":{…}}],"priority":[{"name":"…","priority":1-90}],"retire":[{"name":"…","target":"candidate|skill|note","version":1,"why":"…"}],"restore":[{"name":"文字记录名","why":"恢复理由"}],"improve":[{"name":"…","why":"…"}],"rollback":[{"name":"…","to":1,"why":"…"}]}（用不到的键省略；文字记录不写 version）或 {"ok":true}`;
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ skills, notes }) }];
  }

  private safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }
  private effect(name: string): string { return this.safe(() => this.ledger?.skillEffect(name) ?? '', ''); }

  private async curate(): Promise<string> {
    const messages = this.messages();
    const versions = this.active(), notes = this.notes();
    const names = new Set([...versions, ...notes].map((entry) => entry.name));
    const noteNames = new Set(notes.map((entry) => entry.name));
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.planner.complete(messages, { label: 'skill:整理', tier: 'full', signal: AbortSignal.timeout(10 * 60_000), attempt, maxTokensScale: 2 });
      let raw: ReturnType<typeof parseCuration>;
      try { raw = parseCuration(c.text); } catch (e) {
        this.planner.noteInvalid('整理技能', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      if (raw.ok && !raw.merge.length && !raw.retire.length && !raw.restore.length && !raw.priority.length && !raw.improve.length && !raw.rollback.length) return '不用整理';
      const done: string[] = [], errors: string[] = [];
      for (const m of raw.merge) {
        const from = m.from.filter((name) => names.has(name));
        if (from.length && from.every((name) => noteNames.has(name)) && m.note) {
          const target = m.note.name;
          if (this.book?.get(target) && !noteNames.has(target)) { errors.push(`${target} 不是纯文字记录，不能用文字合并覆盖`); continue; }
          const saved = this.book?.write(target, m.note.description, m.note.body);
          if (saved?.ok) { done.push(`${from.join('+')} → 文字记录 ${saved.skill.name}（保留来源${this.engine.inactive(saved.skill.name) ? '；目标仍收起，需要明确 restore' : ''}）`); }
          else errors.push(`文字合并没存下：${saved && !saved.ok ? saved.error : '没有技能书'}`);
          continue;
        }
        const w = this.engine.write(m.skill, { by: 'curator' });
        if (!w.ok) { errors.push(`合并 ${from.join('+')} 没存下：${w.error}`); continue; }
        done.push(`${from.join('+')} → 候选 ${w.name}（保留原技能，验收后再决定收起）`);
        this.bus.publish('skill_merged', 'P2', `整理技能：${from.join('、')} 生成合并候选「${w.name}」；原技能保持原状态`, { from, into: w.name, candidate: true });
      }
      for (const p of raw.priority) {
        if (names.has(p.name) && this.engine.setPriority(p.name, p.priority)) done.push(`${p.name} 优先级 ${p.priority}`);
      }
      for (const r of raw.retire) {
        const { name, why } = r;
        if (r.target === 'note' && noteNames.has(name)) {
          if (this.book?.get(name)?.behavior !== undefined || this.book?.candidate(name)) { errors.push(`${name} 已有执行版本，不能按纯文字收起`); continue; }
          if (!this.engine.inactive(name) && this.engine.retire(name, why)) done.push(`收起文字记录 ${name}`);
          continue;
        }
        const matches = versions.filter((b) => b.name === name && (r.target === undefined || (b.candidate ? 'candidate' : 'skill') === r.target));
        if (matches.length !== 1 || matches[0].candidate && r.version !== matches[0].version) { errors.push(`${name} 收起目标不明确，需指定 target 和对应 version`); continue; }
        const eb = matches[0];
        if (r.version !== undefined && r.version !== eb.version || this.engine.get(name, !!eb.candidate)?.version !== eb.version) { errors.push(`${name} 版本已变化，未收起`); continue; }
        const st = this.engine.currentStats(name, !!eb.candidate), tries = st.ok + st.fail;
        if (tries > 0 && tries < 3 || tries === 0 && (this.lifetime(eb)?.age ?? 0) < DAY_TICKS / 2) { errors.push(`${name} 当前版本证据还少，先保留`); continue; }
        // 模型显式收起时只保护“实际成功过的稳定应急版”；未验证的应急候选仍可收起（借同名旧版成功不能永久保留）
        if (!eb.candidate && this.protectedEmergency(eb) && (this.engine.currentStats(name)?.ok ?? 0) > 0) { errors.push(`${name} 当前稳定应急版实际成功过，保留；改进先生成候选并验收，不因少用丢掉已验证能力`); continue; }
        if (this.retire(eb, why)) done.push(`收起 ${name}${eb.candidate ? ` 候选 v${eb.version}` : ''}`);
      }
      for (const r of raw.restore) {
        const name = r.name;
        if (noteNames.has(name) && this.engine.restoreNote(name)) done.push(`恢复文字记录 ${name}`);
      }
      for (const r of raw.rollback) {
        const { name, to, why } = r;
        const b = this.engine.get(name);
        if (!names.has(name) || !b || !(to >= 1) || to >= (b.version ?? 1)) continue;
        const old = this.book?.definitionVersion(name, to);
        if (!old) { errors.push(`${name} 没有 v${to} 的完整技能快照`); continue; }
        // 两个版本都要跑够几次才比：凭一两次的结果退回，只会让版本号越涨越多、没有一个版本攒够经验
        const runs = (v: number) => { const x = this.engine.statsOf(name)?.byVersion?.[String(v)]; return x ? x.ok + x.fail : 0; };
        if (runs(b.version ?? 1) < 4 || runs(to) < 3) { errors.push(`${name} v${b.version ?? 1} 跑了 ${runs(b.version ?? 1)} 次、v${to} 跑了 ${runs(to)} 次，数据太少不退回`); continue; }
        const w = this.engine.rollback(name, to, `整理时退回 v${to}：${why}`);
        if (!w.ok) { errors.push(`${name} 退回失败：${w.error}`); continue; }
        done.push(`${name} 退回 v${to}`);
        this.bus.publish('skill_rollback', 'P2', `整理技能：「${name}」v${b.version ?? 1} 不如 v${to}，恢复完整契约（现在是 v${w.version}）：${why}`, { name, from: b.version ?? 1, to, by: 'curator' });
      }
      for (const r of raw.improve) {
        const name = r.name;
        const current = this.engine.get(name, true) ?? this.engine.get(name);
        if (!names.has(name) || !current?.code || this.engine.candidateRetirement(name) || !this.engine.improve) continue;
        this.engine.improve(name, 'slow', r.why);
        done.push(`改进 ${name}`);
      }
      if (errors.length && !done.length && attempt === 0) { messages.push({ role: 'assistant', content: c.text.slice(0, 6000) }, { role: 'user', content: `${errors.join('；')}。改正后只输出 JSON。` }); continue; }
      return done.length ? done.join('；') : errors.join('；') || '没有可用的整理';
    }
    throw new Error('两次都没拿到能用的整理结果');
  }
}
