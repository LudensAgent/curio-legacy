import { claimEdits } from './edits.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import { normalizeSkillName, type KnowSkill, type SkillBook, type SkillMode } from '../knowledge/skillbook.ts';
import { normalizeStep } from '../planner/plan.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import type { Senses } from '../skills/types.ts';
import { compileCheck, MAX_CODE, MAX_VERIFY, VERIFY_METHODS } from '../codeskills/sandbox.ts';
import { evalPredicate, isRecovery, isThreat, senseNow, situationOf, validatePredicate, type Predicate, type Sense } from './predicate.ts';

/**
 * 行为技能：模型从经历里总结出来、写下就生效的“做法”。
 *
 *   {"name":"pillar-up-from-skeletons","description":"血少又被骷髅射时先垫高三格躲箭",
 *    "when":{"hp_below":8,"hostile":{"name":"skeleton","within":16}},
 *    "steps":[{"skill":"place_at","args":{"at":[0,0,0],"item":"any"}},…],"priority":70,"overrides":["low-hp-flee"]}
 *
 * - auto（when 只有状态条件）：条件成立时身体自己做，像后天练出来的反射；可以用 overrides 换掉某个天生的本能。
 * - recover（when 含 after_failure）：手上某个动作失败时，身体先试这套做法再接着做，试过还不行才叫脑子。
 * - manual（不写 when）：只在 routine 里用 use_skill {"name":…} 调用。
 *
 * 每次用完都记成败；自己写的技能总是失败会被停用，并告诉心智去改。
 */
export interface BehaviorStep { skill: string; args?: unknown; if?: Predicate; optional?: boolean }
export interface Behavior {
  name: string; description: string; source: KnowSkill['source']; mode: SkillMode;
  when?: Predicate; steps: BehaviorStep[]; priority: number; cooldownMs: number; overrides: string[];
  /** 代码技能：模型写的 JavaScript（在沙箱里跑，只能用 api.*），可以被后台自动改进出新版本 */
  code?: string; version?: number;
  /** 判定：做完以后看一眼世界，确认真的做成了（只能读的 api；return true 算成，return "原因" 算没成） */
  verify?: string;
  /** use_skill 调用时必须给的参数：名字 → 说明（恢复时由失败的那一步提供，不检查） */
  needs?: Record<string, string>;
}
export interface RunRecord { at: number; ok: boolean; version?: number; summary: string; line?: number; trace?: string[]; logs?: string[]; args?: string }
export interface BehaviorStats {
  fired: number; ok: number; fail: number; lastAt: number; disabled?: boolean; lastError?: string;
  /** 最近一次写下（新写或改写）的时刻 */
  writtenAt?: number;
  /** 恢复时自己判断“跟这事无关”跳过的次数（不算成败） */
  skipped?: number;
  /** 代码技能：每个版本各自的成败，和最近几次运行的记录（给改进用） */
  byVersion?: Record<string, { ok: number; fail: number }>;
  recent?: RunRecord[];
  /** 被整理掉的原因（合并进别的技能、长期用不上）；同名重写就恢复 */
  retired?: string;
  /** 在各个维度里的成败：到了新环境，看得出哪些技能在这里还没验证过 */
  byDim?: Record<string, { ok: number; fail: number }>;
  /** 当前版本是什么时候换上的（写下、改进、退回都算） */
  versionAt?: number;
  /** 后台改进或退回换上代码的时刻：刚换上还没跑过的版本，后台不急着再改（以前退回生成的新版本号马上又被改） */
  swappedAt?: number;
  /** 收起 / 停用的时刻：墓碑——之后一段时间里后台不再同名重写它 */
  retiredAt?: number;
  disabledAt?: number;
  /** 不是代码的技能每改写一次加一（代码技能用自己的版本号）：成败按版本记，改写不清空历史 */
  rev?: number;
  /** 拉锯里输掉的一方：条件成立也不自动接手，只提醒心智；改写后恢复 */
  advisory?: { since: number; why: string };
  /** 和别的技能来回拉锯过（A 做完 B 又把它推回去）：给整理用 */
  loops?: { with: string; at: number; times: number }[];
  /** 条件成立接手、却什么都没做就返回（白白打断手上的活）的次数：when 多半比代码里的判断宽。给整理用 */
  idleInterrupts?: number;
  idleAt?: number;
  /** 和别的自动技能同时满足条件的次数（给整理用） */
  conflicts?: Record<string, number>;
  /** 动作上互相拆台：它挖掉了另一个技能放的方块、或在另一个技能挖开的地方又放上（技能名 → 格数）。给整理用 */
  undid?: Record<string, number>;
  /** 反过来：它做的被谁推翻过 */
  undoneBy?: Record<string, number>;
}
/** 代码技能某次失败后，看看要不要在后台改进（改进器自己限频） */
export type ImproveHook = (name: string, why: 'failures' | 'requested' | 'slow', note?: string) => void;

/** 天生的本能（代码里的身体反应）：lava/drowning 是底线不能换；其余可以被自己写的技能用 overrides 换掉 */
export const INSTINCTS: Record<string, { text: string; locked?: boolean }> = {
  lava: { text: '掉进岩浆立刻往外跑', locked: true },
  drowning: { text: '水里快没气了就上浮/找气', locked: true },
  creeper: { text: '苦力怕嘶嘶响或贴脸时躲开' },
  'losing-fight': { text: '打架时血掉到 6 以下就撤' },
  'low-hp-flee': { text: '血 ≤6 又有怪在 10 格内就逃' },
  'fight-back': { text: '怪贴到 4 格内：血多就还手，血少就跑' },
  'night-shelter': { text: '夜里血少就地挖坑封顶（默认关闭）' },
  eat: { text: '很饿时有什么吃什么' },
  torch: { text: '暗处顺手插火把（habits.torch_every 打开）' },
};

/** 代码技能必须带判定时的说明（写技能、改技能时都用这一句） */
export const VERIFY_REQUIRED = 'skill.verify：代码技能要同时写 verify——一段 JavaScript 函数体，做完以后看一眼世界确认真的做成了。参数 api 和 args：args.before 是开工前的 api.state()，args.result 是 code 的返回值，args.args 是调用参数（目标要拿它核对，别拿 args.result 里代码自己算的值）；只能用 api.state/blockAt/region/entities/nearestLand；做成了 return true，没做成 return "原因"（比如 const s = await api.state(); return s.inWater ? "还在水里" : true）';

const MAX_STEPS = 8;
type Validated = { name: string; description: string; body: string; behavior: Record<string, unknown>; disable?: boolean };

/** 校验模型写的技能：动作必须是会的、参数合法，条件必须是能感觉到的事 */
export function validateBehavior(raw: unknown, adapter: GameAdapter): Validated | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'skill 必须是对象 {"name","description","when"?,"steps"}' };
  const o = raw as Record<string, any>;
  const name = normalizeSkillName(String(o.name ?? ''));
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) return { error: 'skill.name 用小写英文和连字符，比如 "step-up-when-blocked"' };
  if (o.disable === true || o.disabled === true) return { name, description: '', body: '', behavior: {}, disable: true };
  const description = String(o.description ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (description.length < 4) return { error: 'skill.description 写一句：什么时候、做什么' };
  const code = typeof o.code === 'string' ? o.code.replace(/\r\n/g, '\n') : undefined;
  if (code !== undefined) {
    if (Array.isArray(o.steps) && o.steps.length) return { error: 'skill 里 steps 和 code 只写一种' };
    const bad = compileCheck(code);
    if (bad) return { error: `skill.code：${bad}` };
  } else {
    if (!Array.isArray(o.steps) || !o.steps.length) return { error: 'skill.steps 至少一步动作（或者写 code：一段 JavaScript）' };
    if (o.steps.length > MAX_STEPS) return { error: `skill.steps 最多 ${MAX_STEPS} 步` };
  }
  const steps: Record<string, unknown>[] = [];
  for (const [i, s0] of (code !== undefined ? [] : o.steps as unknown[]).entries()) {
    const { if: _if, optional: _optional, ...plain } = (s0 && typeof s0 === 'object' ? s0 : {}) as Record<string, unknown>;
    const s = normalizeStep(plain) as Record<string, any>;
    const skill = String(s?.skill ?? '');
    if (skill === 'use_skill') return { error: `steps[${i}]：技能里不能再调用技能，把动作直接写进来` };
    if (!SKILLS[skill] || LLM_HIDDEN.has(skill)) return { error: `steps[${i}]：没有 "${skill}" 这个动作` };
    const v = SKILLS[skill].validate(s.args ?? {}, adapter);
    if (!v.ok) return { error: `steps[${i}] ${skill} 参数错误：${v.error}` };
    const step: Record<string, unknown> = { skill, args: s.args ?? {} };
    const cond = (s0 as any)?.if;
    if (cond !== undefined) {
      const p = validatePredicate(cond);
      if ('error' in p) return { error: `steps[${i}].if：${p.error}` };
      step.if = p;
    }
    if ((s0 as any)?.optional === true) step.optional = true;
    steps.push(step);
  }
  const behavior: Record<string, unknown> = code !== undefined ? { code: code.slice(0, MAX_CODE) } : { steps };
  if (o.verify !== undefined && o.verify !== null && o.verify !== '') {
    const verify = String(o.verify).replace(/\r\n/g, '\n');
    const bad = compileCheck(verify, { allowed: VERIFY_METHODS, maxLen: MAX_VERIFY });
    if (bad) return { error: `skill.verify：${bad}（判定只能看：${VERIFY_METHODS.map((m) => `api.${m}`).join('、')}）` };
    behavior.verify = verify;
  }
  if (o.when !== undefined && o.when !== null) {
    const p = validatePredicate(o.when);
    if ('error' in p) return { error: `skill.when：${p.error}` };
    // 恢复类必须写清是哪个动作失败：什么失败都套用的“万能恢复”会在放方块、睡觉失败时也去乱挖
    const failureOf = (q: Predicate): Predicate['after_failure'] | undefined => q.after_failure ?? q.all?.map(failureOf).find(Boolean);
    const af = failureOf(p);
    if (af && !af.skill?.length) return { error: 'after_failure 要写清是哪个动作失败（"skill":["goto"]），不能什么失败都套用这一套' };
    // 只看状态、条件太宽（比如只写 night:true）会一直打断手上的活：自动技能至少要有一个具体的触发
    if (!isRecovery(p) && Object.keys(p).every((k) => ['night', 'dark', 'on_ground', 'doing', 'not_doing'].includes(k))) {
      return { error: 'skill.when 太宽了：自动做的技能要写清具体情况（血量、怪、身边的方块、失败的动作……）' };
    }
    behavior.when = p;
  }
  if (o.args !== undefined) {
    if (!o.args || typeof o.args !== 'object' || Array.isArray(o.args) || Object.keys(o.args).length > 6) return { error: 'skill.args 写调用时要给的参数：{"target":"要去的坐标 x,y,z"}' };
    behavior.args = Object.fromEntries(Object.entries(o.args).map(([k, v]) => [k.slice(0, 30), String(v).slice(0, 80)]));
  }
  const priority = Math.round(Number(o.priority ?? (behavior.when ? 50 : 30)));
  behavior.priority = Number.isFinite(priority) ? Math.max(1, Math.min(90, priority)) : 50;
  const cooldown = Number(o.cooldown_s ?? o.cooldown ?? 20);
  behavior.cooldown_s = Number.isFinite(cooldown) ? Math.max(3, Math.min(600, Math.round(cooldown))) : 20;
  if (o.overrides !== undefined) {
    const list = (Array.isArray(o.overrides) ? o.overrides : [o.overrides]).map((x: unknown) => String(x).trim());
    const bad = list.filter((x: string) => !INSTINCTS[x]);
    if (bad.length) return { error: `overrides 里的 ${bad.join('、')} 不是本能；能换的有：${Object.entries(INSTINCTS).filter(([, v]) => !v.locked).map(([k]) => k).join(' ')}` };
    const locked = list.filter((x: string) => INSTINCTS[x].locked);
    if (locked.length) return { error: `${locked.join('、')} 是保命的底线本能，不能换掉` };
    if (list.length && !behavior.when) return { error: 'overrides 需要 when：什么情况下用你的做法代替本能' };
    if (list.length) behavior.overrides = list;
  }
  const body = String(o.body ?? o.note ?? o.notes ?? '').trim().slice(0, 3000) || `${description}\n\n（从经历里总结出来的做法，写下就生效。）`;
  return { name, description, body, behavior };
}

/** 把技能书里一份带 behavior 的技能变成可执行的行为；格式不对就跳过 */
function toBehavior(k: KnowSkill, adapter: GameAdapter): Behavior | null {
  if (!k.behavior || typeof k.behavior !== 'object') return null;
  const v = validateBehavior({ name: k.name, description: k.description || k.name, ...(k.behavior as object) }, adapter);
  if ('error' in v || v.disable) return null;
  const b = v.behavior as Record<string, any>;
  const version = Number((k.behavior as any).version) || (b.code ? 1 : undefined);
  return { name: k.name, description: k.description, source: k.source, mode: b.when ? (isRecovery(b.when) ? 'recover' : 'auto') : 'manual',
    ...(b.when ? { when: b.when } : {}), steps: b.steps ?? [], priority: b.priority, cooldownMs: b.cooldown_s * 1000, overrides: b.overrides ?? [],
    ...(b.code ? { code: b.code, version } : {}), ...(b.verify ? { verify: b.verify } : {}), ...(b.args ? { needs: b.args } : {}) };
}

/** 恢复技能按“哪个动作、什么错误码”失败来归类 */
const recoverySig = (f: { skill: string; code?: string | null }) => `${f.skill}:${f.code ?? ''}`;

export class BehaviorEngine {
  private behaviors = new Map<string, Behavior>();
  private stats: Record<string, BehaviorStats> = {};
  /** 最近用过哪些技能（名字@版本、什么时候）：收获账本拿它算“用了这个技能拿东西是快了还是慢了” */
  private usage: { at: number; tag: string }[] = [];
  /** 最近身体自己接手（自动/恢复）的记录：认出来回拉锯 */
  private fires: { at: number; name: string; doing: string | null }[] = [];
  /** 拉锯时先让一边歇一会儿（不是停用：过了这段时间照常） */
  private holds = new Map<string, { until: number; why: string; closer?: number }>();
  private loopSaid = new Map<string, number>();
  /** 恢复技能 × 失败种类 → 最近一次没帮上（或跳过）的时刻 */
  private recentMiss = new Map<string, number>();
  static readonly RECOVERY_MISS_MS = 3 * 60_000;
  static readonly LOOP_WINDOW_MS = 5 * 60_000;
  static readonly HOLD_MS = 90_000;
  /** 拉锯输掉的一方只提醒、不接手的时长 */
  static readonly ADVISORY_MS = 5 * 60_000;
  private waitSaid = new Map<string, number>();

  /** 条件成立了但这次不接手：告诉心智一声（同一个技能两分钟说一次），由它决定要不要现在做 */
  private waiting(b: Behavior, cur: TaskInfo | null, now: number, why?: string) {
    if (now - (this.waitSaid.get(b.name) ?? 0) < 120_000) return;
    let s: Sense;
    try { s = this.sense(cur); } catch { return; }
    if (!evalPredicate(b.when!, s)) return;
    this.waitSaid.set(b.name, now);
    this.bus.publish('skill_waiting', 'P3', `技能「${b.name}」的条件成立了（${b.description.slice(0, 40)}），${why ? `但它${why}，先不自动做` : `手上在做 ${cur?.skill ?? '别的'}，不打断`}；要做就在 routine 里 use_skill`, { name: b.name, why: why ?? 'busy' });
  }
  private lastFired = new Map<string, number>();
  private invalid = new Map<string, string>();
  private doneListener = (o: TaskOutcome) => this.onDone(o);
  private lastHurtAt = 0;
  /** 自动技能做完后要看“结果”：十几秒后还活着、没再掉多少血才算管用 */
  private aftermath = new Map<string, { hp: number; at: number; summary?: string; data?: Record<string, any>; context: string; pos?: { x: number; y: number; z: number }; interrupted?: string; nearest?: number }>();
  static readonly AFTERMATH_MS = 12_000;
  /** 代码技能失败或心智要求改进时调用（main 接到后台改进器） */
  improve: ImproveHook | null = null;
  /** 死后掉在地上还没捡回的东西（main 接到世界记忆）：给 dropped_items 条件用 */
  drops: (() => Sense['deathDrop']) | null = null;

  constructor(private book: SkillBook | null, private adapter: GameAdapter, private arbiter: Pick<Arbiter, 'start' | 'info' | 'on' | 'off'> | null,
    private bus: EventBus, private senses: Pick<Senses, 'perceivedEntities'>, private statsFile: string | null = null) {
    if (statsFile && fs.existsSync(statsFile)) { try { this.stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')) ?? {}; } catch { this.stats = {}; } }
    book?.onChange(() => this.reload());
    bus.on('event', (ev: { type: string }) => {
      if (ev.type === 'hurt') this.lastHurtAt = Date.now();
      else if (ev.type === 'death') for (const name of [...this.aftermath.keys()]) this.judge(name, true);
    });
    arbiter?.on('done', this.doneListener);
    this.reload();
  }

  dispose() { this.arbiter?.off('done', this.doneListener); }

  reload() {
    this.behaviors.clear();
    this.invalid.clear();
    for (const k of this.book?.list() ?? []) {
      if (k.behavior === undefined) continue;
      const b = toBehavior(k, this.adapter);
      if (b) this.behaviors.set(b.name, b);
      else this.invalid.set(k.name, '格式不对，没有生效');
    }
  }

  list(): Behavior[] { return [...this.behaviors.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)); }
  get(name: string): Behavior | undefined { return this.behaviors.get(name); }
  statsOf(name: string): BehaviorStats | undefined { return this.stats[name]; }
  enabled(b: Behavior): boolean { return !this.stats[b.name]?.disabled; }

  private sense(cur: TaskInfo | null, failure?: Sense['failure']): Sense {
    const s = senseNow(this.adapter, this.senses, cur && cur.source !== 'filler' ? cur.skill : null, failure, this.lastHurtAt ? Date.now() - this.lastHurtAt : Infinity);
    try { s.deathDrop = this.drops?.() ?? null; } catch { s.deathDrop = null; }
    return s;
  }

  private running(cur: TaskInfo | null): Behavior | undefined {
    return cur?.skill === 'use_skill' ? this.behaviors.get(String((cur.args as any)?.name ?? '')) : undefined;
  }

  /** 自动技能：条件成立就由身体去做（返回 true 表示这一拍已经接手） */
  tick(cur: TaskInfo | null, now = Date.now()): boolean {
    if (!this.arbiter) return false;
    // 事后评判：至少等 12 秒，而且等它做完（找吃的、挖洞要好一会儿），最多等两分钟
    for (const [name, a] of this.aftermath) {
      const busy = this.running(cur)?.name === name;
      if (now - a.at >= BehaviorEngine.AFTERMATH_MS && (!busy || now - a.at >= 120_000)) this.judge(name, false);
    }
    const auto = this.list().filter((b) => b.mode === 'auto' && this.enabled(b));
    if (!auto.length) return false;
    const running = this.running(cur);
    // 天生的躲闪正在进行（逃跑、上浮）时，只有更要紧的技能才插手
    const floor = running ? running.priority : cur?.source === 'reflex' ? 60 : 0;
    let s: Sense | null = null;
    const matches: Behavior[] = [];
    for (const b of auto) {
      if (b.priority <= floor || running?.name === b.name) continue;
      const hold = this.holds.get(b.name);
      if (hold && hold.until > now) {
        // 白白接手后歇着的：怪比那时又近了 2 格以上、或者挨了打，情况变了，照常接手
        if (hold.closer === undefined) continue;
        s ??= this.sense(cur);
        const nearest = Math.min(Infinity, ...s.hostiles.map((h) => h.dist));
        if (!(nearest < hold.closer - 2 || s.hurtAgoMs < 3000)) continue;
      }
      // 不是眼下的危险：心智手上有事（包括操作者交代的）就不打断，等做完再接手
      const threat = isThreat(b.when);
      if (!threat && cur && (cur.source === 'llm' || cur.source === 'rule')) { this.waiting(b, cur, now); continue; }
      const adv = this.stats[b.name]?.advisory;
      if (adv && now - adv.since < BehaviorEngine.ADVISORY_MS) { this.waiting(b, cur, now, adv.why); continue; }
      if (now - (this.lastFired.get(b.name) ?? 0) < b.cooldownMs) continue;
      s ??= this.sense(cur);
      if (evalPredicate(b.when!, s)) matches.push(b);
    }
    if (matches.length > 1) {
      // 几个技能同时想接手：优先级之外也看实际管不管用（成功率高的先上），并记下谁和谁抢（给整理用）
      for (const b of matches) this.touch(b.name, (st) => { st.conflicts ??= {}; for (const o of matches) if (o.name !== b.name) st.conflicts[o.name] = (st.conflicts[o.name] ?? 0) + 1; });
      matches.sort((a, b) => this.choiceScore(b) - this.choiceScore(a));
    }
    for (const b of matches) {
      if (!s) break;
      // 触发时的情况交给技能（代码技能里是 args.trigger），也留着给事后评判和改进用
      const trigger = { hp: Math.round(s.state.hp * 10) / 10, food: s.state.food, doing: s.doing, hurtAgoMs: Number.isFinite(s.hurtAgoMs) ? s.hurtAgoMs : null, cover: s.cover,
        hostiles: s.hostiles.slice(0, 4).map((h) => ({ name: h.name, dist: Math.round(h.dist * 10) / 10, ...(h.fusing ? { fusing: true } : {}) })),
        offHand: s.state.equipment?.find((e) => e.slot === 'off-hand')?.name ?? null };
      const r = this.arbiter.start({ skill: 'use_skill', args: { name: b.name, args: { trigger } } }, 'reflex');
      if ('error' in r) { this.lastFired.set(b.name, now); continue; }
      this.aftermath.set(b.name, { hp: s.state.hp, at: now, pos: { ...s.state.pos }, nearest: Math.min(Infinity, ...s.hostiles.map((h) => h.dist)), ...(s.doing && cur && cur.source !== 'filler' ? { interrupted: s.doing } : {}), context: `触发时血 ${trigger.hp}${trigger.hostiles.length ? `，${trigger.hostiles.map((h) => `${h.name} ${h.dist}格`).join('、')}` : ''}，${trigger.cover === 'open' ? '在空地' : trigger.cover === 'pit' ? '在坑里' : '在封好的坑里'}${s.doing ? `，当时在做 ${s.doing}` : ''}${trigger.offHand ? `，副手拿着 ${trigger.offHand}` : ''}` });
      this.lastFired.set(b.name, now);
      this.touch(b.name, (st) => { st.fired++; st.lastAt = now; });
      this.bus.publish('instinct', 'P2', `技能「${b.name}」的条件成立，身体照着做：${b.description}`, { name: b.name, source: b.source });
      this.noteFire(b.name, s.doing, now);
      return true;
    }
    return false;
  }

  /**
   * 认出来回拉锯：身体自己接手的事一再把彼此（或把手上的活）推回去。
   * - 两个技能交替接手（A、B、A、B）：一个做完另一个就把它撤销——先让不那么管用的那个歇一会儿，打破循环；
   * - 同一个技能几分钟里一再打断同一件事：技能和手上的活在拉锯（比如躲进洞里、心智又要上地表、一出来又躲回去）。
   * 两种都告诉心智（换个做法，或等情况过去）和整理技能的（收窄条件、调优先级、合并）。打法和取舍不写死。
   */
  /** 这个技能刚做的，是不是在推翻另一个技能做的（挖了它放的块、填了它挖的洞）：两边都记下，整理时收窄条件或合并 */
  private noteUndo(name: string, taskId: string) {
    for (const u of claimEdits(taskId, name)) {
      this.touch(name, (st) => { st.undid ??= {}; st.undid[u.skill] = (st.undid[u.skill] ?? 0) + u.cells; st.conflicts ??= {}; st.conflicts[u.skill] = (st.conflicts[u.skill] ?? 0) + 2; });
      this.touch(u.skill, (st) => { st.undoneBy ??= {}; st.undoneBy[name] = (st.undoneBy[name] ?? 0) + u.cells; });
      this.bus.publish('skill_undo', 'P3', `「${name}」把「${u.skill}」刚弄好的 ${u.cells} 格又改回去了`, { name, other: u.skill, cells: u.cells });
    }
  }

  private noteFire(name: string, doing: string | null, now = Date.now()) {
    this.fires = [...this.fires.filter((f) => now - f.at < BehaviorEngine.LOOP_WINDOW_MS), { at: now, name, doing }].slice(-40);
    const last = this.fires.slice(-4).map((f) => f.name);
    let loop: { kind: 'pingpong' | 'tug'; a: string; b: string; times: number } | null = null;
    if (last.length === 4 && last[0] === last[2] && last[1] === last[3] && last[0] !== last[1]) {
      loop = { kind: 'pingpong', a: last[3], b: last[2], times: this.fires.filter((f) => f.name === last[2] || f.name === last[3]).length };
    } else {
      // 这个技能最近连着几次接手时，手上都是同一件事
      const same = this.fires.filter((f) => f.name === name);
      let run = 0;
      for (let i = same.length - 1; i >= 0 && same[i].doing === doing; i--) run++;
      if (run >= 3 && doing && doing !== 'use_skill') loop = { kind: 'tug', a: name, b: doing, times: run };
    }
    if (!loop) return;
    const key = [loop.a, loop.b].sort().join('|');
    if (now - (this.loopSaid.get(key) ?? 0) < BehaviorEngine.LOOP_WINDOW_MS) return;
    this.loopSaid.set(key, now);
    const record = (x: string, other: string) => this.touch(x, (st) => {
      st.loops = [...(st.loops ?? []).filter((l) => l.with !== other), { with: other, at: now, times: loop!.times }].slice(-6);
      st.conflicts ??= {}; st.conflicts[other] = (st.conflicts[other] ?? 0) + 3; // 让整理技能的尽快来看
    });
    if (loop.kind === 'pingpong') {
      const A = this.behaviors.get(loop.a), B = this.behaviors.get(loop.b);
      const loser = A && B ? (this.choiceScore(A) >= this.choiceScore(B) ? B : A) : (A ?? B);
      record(loop.a, loop.b); record(loop.b, loop.a);
      if (loser) {
        const why = `和「${loser.name === loop.a ? loop.b : loop.a}」来回拉锯`;
        this.holds.set(loser.name, { until: now + BehaviorEngine.HOLD_MS, why });
        // 只歇一会儿压不住：降成“只提醒、不接手”，直到它被改写（整理时拆开条件）或者过了 5 分钟
        this.touch(loser.name, (st) => { st.advisory = { since: now, why }; });
      }
      this.bus.publish('skill_loop', 'P1', `技能「${loop.a}」和「${loop.b}」在来回拉锯：一个做完另一个又把它推回去（几分钟里 ${loop.times} 回）${loser ? `；「${loser.name}」先改成只提醒、不自动接手，直到它被改写` : ''}`,
        { kind: loop.kind, a: loop.a, b: loop.b, times: loop.times, held: loser?.name ?? null });
    } else {
      record(loop.a, `doing:${loop.b}`);
      this.bus.publish('skill_loop', 'P1', `技能「${loop.a}」几分钟里第 ${loop.times} 次打断手上的「${loop.b}」：技能和手上的事在拉锯——要么换个做法完成这件事，要么等情况过去再做，要么改这个技能的条件`,
        { kind: loop.kind, a: loop.a, b: loop.b, times: loop.times, held: null });
    }
  }

  /** 拉锯时被叫停的技能（给控制台和测试看） */
  heldNow(now = Date.now()): string[] { return [...this.holds].filter(([, h]) => h.until > now).map(([n]) => n); }

  /** 同时满足条件时的选择分：优先级 + 实际成功率（没用过的按五五开） */
  choiceScore(b: Behavior): number {
    const st = this.stats[b.name];
    const rate = ((st?.ok ?? 0) + 1) / ((st?.ok ?? 0) + (st?.fail ?? 0) + 2);
    return b.priority + 40 * (rate - 0.5);
  }

  /** 整理：把技能收起来（停用并写明原因）；同名重写会恢复 */
  retire(name: string, why: string): boolean {
    if (!this.behaviors.has(name)) return false;
    this.touch(name, (st) => { st.disabled = true; st.retired = why.slice(0, 120); st.retiredAt = Date.now(); });
    this.bus.publish('skill_retired', 'P2', `整理技能：收起「${name}」（${why.slice(0, 80)}）`, { name, why });
    return true;
  }

  /** 整理：调整优先级（同时满足条件时谁先上） */
  setPriority(name: string, priority: number): boolean {
    const k = this.book?.get(name);
    if (!k || !this.book || !k.behavior || typeof k.behavior !== 'object') return false;
    const p = Math.max(1, Math.min(90, Math.round(priority)));
    const raw = { ...(k.behavior as Record<string, unknown>), priority: p, code_file: undefined, version: undefined };
    const w = this.book.write(name, k.description, k.body, raw);
    return w.ok;
  }

  /** 某个本能此刻是否被自己写的技能换掉了（技能正在做，或它的条件正成立） */
  suppresses(instinct: string, cur: TaskInfo | null): boolean {
    if (INSTINCTS[instinct]?.locked) return false;
    const running = this.running(cur);
    if (running?.overrides.includes(instinct)) return true;
    const candidates = this.list().filter((b) => b.mode === 'auto' && this.enabled(b) && b.overrides.includes(instinct));
    if (!candidates.length) return false;
    const s = this.sense(cur);
    return candidates.some((b) => evalPredicate(b.when!, s));
  }

  /** 恢复技能抽到的成功机会低于这个就不上（成 2 败 20 的技能大约一成多的时候还会被试一次） */
  static RECOVERY_MIN_CHANCE = 0.2;
  /** 可替换的随机数（测试用） */
  rand: () => number = Math.random;

  /** 恢复类技能：某个动作失败时，身体先试哪一套（同一段活里每套只试一次） */
  recoveryFor(failure: { skill: string; code?: string }, tried: Set<string> = new Set(), now = Date.now()): Behavior | null {
    const sig = recoverySig(failure);
    const rec = this.list().filter((b) => b.mode === 'recover' && this.enabled(b) && !tried.has(b.name) && now - (this.lastFired.get(b.name) ?? 0) >= Math.min(b.cooldownMs, 5000)
      // 同一种失败刚试过没用、或它自己说跟这事无关：几分钟内换了一段活也别再拿它试（以前每重新规划一次就从头再试一遍）
      && now - (this.recentMiss.get(`${b.name}|${sig}`) ?? -Infinity) >= BehaviorEngine.RECOVERY_MISS_MS);
    if (!rec.length) return null;
    const s = this.sense(this.arbiter?.info() ?? null, failure);
    // 几个都对得上时，和自动技能一样按“优先级 + 实际成功率”挑，不是排在前面的就先上
    const hit = rec.filter((b) => (this.holds.get(b.name)?.until ?? 0) <= now && evalPredicate(b.when!, s))
      .sort((a, b) => this.choiceScore(b) - this.choiceScore(a))[0];
    if (!hit) return null;
    // 按它以往的成败“掷一次骰子”（Beta 后验抽样）：常成功的几乎总会上，老失败的偶尔还给它机会、多数时候直接交还给心智。
    // 不设硬门槛，也不替它判死刑——成败一变，上场的机会跟着变
    const st = this.statsOf(hit.name);
    const p = betaSample((st?.ok ?? 0) + 1, (st?.fail ?? 0) + 1, this.rand);
    if ((st?.ok ?? 0) + (st?.fail ?? 0) >= 3 && p < BehaviorEngine.RECOVERY_MIN_CHANCE) { // 还没用够 3 次的照常试，先攒证据
      this.recentMiss.set(`${hit.name}|${sig}`, now);
      this.bus.publish('instinct_skipped', 'P3', `${failure.skill} 没成，「${hit.name}」以往成 ${st?.ok ?? 0} 败 ${st?.fail ?? 0}，这次多半也不管用，交给脑子想`, { name: hit.name, ok: st?.ok ?? 0, fail: st?.fail ?? 0 });
      return null;
    }
    this.noteFire(hit.name, failure.skill, now);
    this.lastFired.set(hit.name, now);
    this.touch(hit.name, (st) => { st.fired++; st.lastAt = now; });
    this.bus.publish('instinct', 'P2', `${failure.skill} 没成（${failure.code ?? '失败'}），身体先照技能「${hit.name}」试试：${hit.description}`, { name: hit.name, recover: true });
    return hit;
  }

  /**
   * 模型在思考里写下的技能：校验后写进技能书，立刻生效（技能书变更会触发 reload）。
   * {"name":…,"disable":true} 停用；同名再写一次就是修订并重新启用。
   */
  write(raw: unknown, opts: { by?: 'mind' | 'forge' | 'curator' } = {}): { ok: true; name: string; created: boolean; mode: SkillMode; disabled?: boolean; improving?: boolean } | { ok: false; error: string; gated?: boolean } {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    // {"name":…,"improve":"哪里不好"}：请后台改进这份代码技能（异步，改进器限频）
    if (typeof o.improve === 'string' && !o.code && !o.steps) {
      const name = normalizeSkillName(String(o.name ?? ''));
      const b = this.behaviors.get(name);
      if (!b?.code) return { ok: false, error: `${name || '这份技能'} 不是代码技能，改不了；可以同名重写` };
      this.improve?.(name, 'requested', o.improve.slice(0, 200));
      return { ok: true, name, created: false, mode: b.mode, improving: true };
    }
    const v = validateBehavior(raw, this.adapter);
    if ('error' in v) return { ok: false, error: v.error };
    if (v.disable) {
      if (!this.behaviors.has(v.name) && !this.book?.get(v.name)) return { ok: false, error: `没有叫 ${v.name} 的技能` };
      this.touch(v.name, (st) => { st.disabled = true; st.disabledAt = Date.now(); });
      this.bus.publish('skill_disabled', 'P2', `停用了技能 ${v.name}`, { name: v.name, by: 'mind' });
      return { ok: true, name: v.name, created: false, mode: this.behaviors.get(v.name)?.mode ?? 'manual', disabled: true };
    }
    if (!this.book) return { ok: false, error: '没有技能书，存不下技能' };
    // 模型新写、改写代码技能（心智、技能工程师、整理）必须带判定：代码跑完不抛错不等于做成了（“脱船”技能人还在船上，也报“做完了”）
    if (opts.by && v.behavior.code && !v.behavior.verify) return { ok: false, error: VERIFY_REQUIRED };
    // 后台总结（每死一次、每吃一次亏都会来一遍）不能推翻一个还没攒够证据的版本：
    // 否则同一个技能在几种打法之间来回改，没有一个版本用够几次，永远不知道哪个管用
    if (opts.by === 'forge') {
      const gate = this.rewriteGate(v.name) ?? this.tombstone(v.name);
      if (gate) return { ok: false, error: gate, gated: true };
    }
    const w = this.book.write(v.name, v.description, v.body, v.behavior);
    if (!w.ok) return w;
    if (!this.behaviors.has(w.skill.name)) this.reload();
    const b = this.behaviors.get(w.skill.name);
    if (!b) return { ok: false, error: '技能写下了，但格式不对没有生效' };
    // 修订就是重新给它一次机会：新版本从零记，旧版本的成败留着（好拿来比）
    this.touch(b.name, (st) => {
      st.disabled = false; delete st.lastError; delete st.retired; delete st.advisory; delete st.retiredAt; delete st.disabledAt; delete st.swappedAt; st.versionAt = Date.now(); st.writtenAt = Date.now();
      if (!b.code && !w.created) st.rev = (st.rev ?? 1) + 1;
    });
    return { ok: true, name: b.name, created: w.created, mode: b.mode };
  }

  /**
   * 换上一份代码技能的新版本（后台改进的结果，或者退回旧版本）：先校验能编译，再写进技能书，立刻生效。
   * 统计按版本分开记，用来判断新版本是不是真的更好。
   */
  /** 当前版本的成败 */
  versionOf(b: Behavior): string { return String(b.version ?? this.stats[b.name]?.rev ?? 1); }
  currentStats(name: string): { ok: number; fail: number } {
    const b = this.behaviors.get(name);
    const st = this.stats[name];
    return (b && st?.byVersion?.[this.versionOf(b)]) ?? { ok: 0, fail: 0 };
  }
  static readonly MIN_EVIDENCE = 3;
  /** 刚换上的版本保护多久 */
  static readonly FRESH_MS = 30 * 60_000;
  /** 还没用过的新写版本，至少隔这么久才让后台总结再改写 */
  static readonly REWRITE_GAP_MS = 10 * 60_000;
  /** 收起 / 停用之后多久内后台不同名重写（心智自己要写不受限） */
  static readonly TOMBSTONE_MS = 2 * 3600_000;

  /** 收起或停用不久的技能：后台再重写它多半又是同一套，先不写；返回原因（null = 可以写） */
  tombstone(name: string): string | null {
    const st = this.stats[name];
    if (!st) return null;
    const at = st.retired ? st.retiredAt : st.disabled ? st.disabledAt : undefined;
    if (!at || Date.now() - at >= BehaviorEngine.TOMBSTONE_MS) return null;
    return `「${name}」${Math.round((Date.now() - at) / 60_000)} 分钟前${st.retired ? `被收起（${st.retired.slice(0, 60)}）` : '被停用'}，当时成 ${st.ok} 败 ${st.fail}：先不同名重写；这次的事要是真和当时不同，在 why 里写清楚新证据，输出 none`;
  }

  /** 收起或停用了 */
  inactive(name: string): boolean { const st = this.stats[name]; return !!st && (!!st.retired || !!st.disabled); }

  /** 可靠的积木：启用中、当前版本用够了次数、成功明显多于失败（别的代码技能可以 api.useSkill 调用它） */
  reliable(name: string): string | null {
    const b = this.behaviors.get(name);
    if (!b) return `没有技能 ${name}`;
    if (this.inactive(name)) return `${name} 已收起或停用`;
    const cur = this.currentStats(name);
    if (cur.ok < BehaviorEngine.MIN_EVIDENCE || cur.ok < cur.fail * 2) return `${name} 当前版本还不够可靠（成 ${cur.ok} 败 ${cur.fail}）`;
    return null;
  }
  reliableList(): string[] {
    return this.list().filter((b) => !this.reliable(b.name)).map((b) => { const c = this.currentStats(b.name); return `${b.name}：${b.description.slice(0, 60)}（成 ${c.ok} 败 ${c.fail}${b.needs ? `，args.${Object.keys(b.needs).join('/')}` : ''}）`; });
  }
  /** 能不能改写这份技能：当前版本用得太少就先别动（停用了、或者代码本身报错的除外） */
  rewriteGate(name: string): string | null {
    const b = this.behaviors.get(name);
    const st = this.stats[name];
    if (!b || b.source !== 'self' || !st || st.disabled) return null;
    const cur = this.currentStats(name);
    const uses = cur.ok + cur.fail;
    const codeBroke = /代码技能.*没成|参数错误|SyntaxError|TypeError|ReferenceError/.test(st.recent?.at(-1)?.summary ?? st.lastError ?? '');
    // 刚换上（写下、改进、退回）的版本还没跑过：先让它跑几次（以前退回旧版本生成的新版本号马上又被改）
    if (uses === 0 && st.swappedAt && Date.now() - st.swappedAt < BehaviorEngine.FRESH_MS && !codeBroke)
      return `「${name}」当前版本 ${Math.round((Date.now() - st.swappedAt) / 60_000)} 分钟前才换上，还没用过：先让它跑几次，这次的经过已经记进它的成败`;
    // 一次都没触发过：说明条件没对上这次的事，改写它不会丢掉什么证据——但刚写下几分钟就再改，等于同一个想法来回换说法
    // （10-26：stairway-up-when-water-blocks-climb 三分钟里被改写四次，一次都没用上）
    if (uses === 0 && !codeBroke && st.writtenAt && Date.now() - st.writtenAt < BehaviorEngine.REWRITE_GAP_MS)
      return `「${name}」${Math.max(1, Math.round((Date.now() - st.writtenAt) / 60_000))} 分钟前才写下、还没用过：先别急着改写，等它用上几次或过一会儿再看`;
    if (uses === 0 || uses >= BehaviorEngine.MIN_EVIDENCE || codeBroke) return null;
    return `「${name}」当前版本只用了 ${uses} 次（成 ${cur.ok} 败 ${cur.fail}），证据还不够，先不改写它；这次的经过已经记进它的成败，等用够 ${BehaviorEngine.MIN_EVIDENCE} 次再看要不要改`;
  }

  replaceCode(name: string, code: string, note: string, verify?: string): { ok: true; version: number } | { ok: false; error: string } {
    const b = this.behaviors.get(name);
    const k = this.book?.get(name);
    if (!b?.code || !k || !this.book) return { ok: false, error: `${name} 不是代码技能` };
    const bad = compileCheck(code);
    if (bad) return { ok: false, error: bad };
    if (verify !== undefined) {
      const badVerify = compileCheck(verify, { allowed: VERIFY_METHODS, maxLen: MAX_VERIFY });
      if (badVerify) return { ok: false, error: `verify：${badVerify}` };
    }
    const raw = { ...(k.behavior as Record<string, unknown>), code, code_file: undefined, version: undefined, ...(verify !== undefined ? { verify } : {}) };
    const body = `${k.body.replace(/```behavior[\s\S]*?```/, '').trim()}`.replace(/\n*（最近一次改进：[^）]*）$/, '') + `\n\n（最近一次改进：${note.slice(0, 100)}）`;
    const w = this.book.write(name, k.description, body, raw);
    if (!w.ok) return w;
    const nb = this.behaviors.get(name);
    this.touch(name, (st) => { st.disabled = false; delete st.lastError; st.versionAt = Date.now(); st.swappedAt = Date.now(); });
    return { ok: true, version: nb?.version ?? 0 };
  }

  private touch(name: string, fn: (st: BehaviorStats) => void) {
    const st = this.stats[name] ??= { fired: 0, ok: 0, fail: 0, lastAt: 0 };
    fn(st);
    if (this.statsFile) {
      try { fs.mkdirSync(path.dirname(this.statsFile), { recursive: true }); fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 1)); } catch { /* 统计写不进去不影响游玩 */ }
    }
  }

  /**
   * 恢复类技能的成败不看它自己的步骤做没做完，而看“重做失败的那一步”成没成：
   * 挖了一格空气也算“做完”，但路还是不通，那就是没用。
   */
  creditRecovery(name: string, worked: boolean, failure?: { skill: string; code?: string | null }) {
    const b = this.behaviors.get(name);
    if (!b) return;
    if (!worked && failure) this.recentMiss.set(`${name}|${recoverySig(failure)}`, Date.now());
    this.record(b, worked, worked ? '重做那一步成了' : '用了它之后，那一步还是没成', {});
  }

  /**
   * 恢复技能自己判断“这次跟我无关”（返回 skipped）：不算成也不算败，不算一次接手（不进拉锯统计），
   * 几分钟内同一种失败不再找它。那一步不用白白重做一遍——交给下一个对得上的技能，或者交还给心智。
   */
  recoverySkipped(name: string, failure: { skill: string; code?: string | null }, now = Date.now()) {
    this.recentMiss.set(`${name}|${recoverySig(failure)}`, now);
    for (let i = this.fires.length - 1; i >= 0; i--) if (this.fires[i].name === name) { this.fires.splice(i, 1); break; }
    this.touch(name, (st) => { st.fired = Math.max(0, st.fired - 1); st.skipped = (st.skipped ?? 0) + 1; });
  }

  private onDone(o: TaskOutcome) {
    if (o.task.skill !== 'use_skill') return;
    const name = String((o.task.args as any)?.name ?? '');
    const b = this.behaviors.get(name);
    if (!b) return;
    this.noteUndo(name, o.task.id);
    if (o.result.status === 'cancelled') return;
    this.usage.push({ at: Date.now(), tag: `${name}@v${b.version ?? 1}` });
    if (this.usage.length > 600) this.usage.splice(0, this.usage.length - 600);
    const okRun = o.result.status === 'succeeded';
    // 恢复时用的：做完了先不算成功，等重做的那一步出结果（creditRecovery）；自己就出错了才直接算失败
    if ((o.task.args as any)?.failure && okRun) return;
    // 自动技能（后天的反射）：做没做完不算数，十几秒后看结果（judge）；代码本身出错才马上算失败
    const pending = this.aftermath.get(name);
    // 接手了却一下子就返回、人也没动：多半是 when 写得比代码里的判断宽（条件说“苦力怕 10 格内”，代码却觉得 7 格外不算威胁），
    // 白白打断了手上的活。先让它歇一会儿，记下来给整理技能的看（收窄条件是它自己的事）
    const here = this.adapter.state().pos;
    if (okRun && o.task.source === 'reflex' && pending?.interrupted && o.durationMs < 600 && pending.pos
      && Math.hypot(here.x - pending.pos.x, here.y - pending.pos.y, here.z - pending.pos.z) < 0.3) {
      const now = Date.now();
      this.touch(name, (st) => { st.idleInterrupts = (st.idleInterrupts ?? 0) + 1; st.idleAt = now; });
      this.holds.set(name, { until: now + BehaviorEngine.HOLD_MS, why: '条件成立接手后什么都没做就返回，打断了手上的事', closer: Number.isFinite(pending.nearest) ? pending.nearest : Infinity });
      this.bus.publish('instinct_idle', 'P3', `技能「${name}」接手后什么都没做就返回（打断了「${pending.interrupted}」），先歇 ${BehaviorEngine.HOLD_MS / 1000} 秒（怪更近或挨打时照常接手）；它的 when 可能比代码里的判断宽`, { name, interrupted: pending.interrupted, times: this.stats[name]?.idleInterrupts });
      this.aftermath.delete(name);
      return;
    }
    // 技能自己判断这次不用做（怪已经走了、没吃的）：不算一次使用
    if (okRun && (o.result.data as any)?.result?.skipped) { this.aftermath.delete(name); return; }
    if (pending && o.task.source === 'reflex') {
      pending.summary = o.result.summary; pending.data = (o.result.data ?? {}) as Record<string, any>;
      if (okRun || !['ERROR', 'BAD_ARGS'].includes(String(o.result.failureCode))) return;
      this.aftermath.delete(name);
    }
    this.record(b, okRun, o.result.summary, (o.result.data ?? {}) as Record<string, any>);
  }

  /** 自动技能的事后评判：死了、或者又掉了 6 点以上的血，就是没管用 */
  private judge(name: string, died: boolean) {
    const a = this.aftermath.get(name);
    this.aftermath.delete(name);
    const b = this.behaviors.get(name);
    if (!a || !b) return;
    const hp = this.adapter.state().hp;
    const lost = Math.max(0, a.hp - hp);
    // 管没管用：没死、没再掉一大截血，而且触发它的那个情况解除了（饿了的不饿了、贴脸的怪不在了）
    const situation = b.when ? situationOf(b.when) : null;
    let still = false;
    if (!died && situation) { try { still = evalPredicate(situation, this.sense(null)); } catch { still = false; } }
    const worked = !died && lost < 6 && !still;
    const verdict = died ? '做完不久就死了' : lost >= 6 ? `做完后又掉了 ${Math.round(lost)} 点血` : still ? `做完了，但触发它的情况还在（血 ${Math.round(hp)}）` : `触发它的情况解除了（血 ${Math.round(hp)}）`;
    this.record(b, worked, `${a.context}；${a.summary ? `它做了：${a.summary.slice(0, 100)}；` : ''}结果：${verdict}`, a.data ?? {});
  }

  private record(b: Behavior, okRun: boolean, summary: string, data: Record<string, any>) {
    const name = b.name;
    let rollback: { from: number; to: number } | null = null;
    let dim = 'unknown';
    try { dim = this.adapter.state().dim; } catch { /* 状态暂不可用 */ }
    this.touch(name, (st) => {
      if (okRun) st.ok++; else { st.fail++; st.lastError = summary.slice(0, 120); }
      const pd = (st.byDim ??= {})[dim] ??= { ok: 0, fail: 0 };
      if (okRun) pd.ok++; else pd.fail++;
      const v = this.versionOf(b);
      const per = (st.byVersion ??= {})[v] ??= { ok: 0, fail: 0 };
      if (okRun) per.ok++; else per.fail++;
      st.recent = [...(st.recent ?? []), { at: Date.now(), ok: okRun, version: Number(v), summary: summary.slice(0, 200),
          ...(typeof data.line === 'number' ? { line: data.line } : {}), ...(Array.isArray(data.trace) ? { trace: data.trace.slice(-12) } : {}),
          ...(Array.isArray(data.logs) ? { logs: data.logs.slice(-6) } : {}), ...(data.args ? { args: String(data.args).slice(0, 200) } : {}) }].slice(-6);
      if (b.code) {
        // 新版本跑了几次明显比上一版差：退回上一版（真人改坏了也会改回去）
        const prev = st.byVersion[String((b.version ?? 1) - 1)];
        const rate = (x: { ok: number; fail: number }) => x.ok / Math.max(1, x.ok + x.fail);
        // 两个版本都要跑够几次才比（以前凭“3 成 0 败”就当标杆，来回退了十几次）
        if (prev && prev.ok + prev.fail >= BehaviorEngine.MIN_EVIDENCE && per.ok + per.fail >= BehaviorEngine.MIN_EVIDENCE + 1 && rate(per) < rate(prev) - 0.25) rollback = { from: b.version ?? 1, to: (b.version ?? 1) - 1 };
      }
      // 自己写的技能，当前版本用了几次大多失败：先停用，让心智回头改（同名重写即可）
      if (b.source === 'self' && per.ok + per.fail >= 4 && per.ok / (per.ok + per.fail) < 0.25 && !st.disabled) {
        st.disabled = true;
        st.disabledAt = Date.now();
        this.bus.publish('skill_disabled', 'P1', `技能「${name}」这一版用了 ${per.ok + per.fail} 次只成了 ${per.ok} 次，先停用；最近一次：${st.lastError ?? ''}`, { name, by: 'stats' });
      }
    });
    if (rollback) {
      const { from, to } = rollback as { from: number; to: number };
      const old = this.book?.codeVersion(name, to);
      const r = old ? this.replaceCode(name, old, `v${from} 比 v${to} 差，退回 v${to} 的代码`) : null;
      if (r?.ok) this.bus.publish('skill_rollback', 'P2', `代码技能「${name}」的 v${from} 不如 v${to}，退回旧代码（现在是 v${r.version}）`, { name, from, to });
    } else if (b.code && !okRun) this.improve?.(name, 'failures');
  }

  /** 这段时间里用过的技能（名字@版本） */
  usedBetween(from: number, to: number): string[] { return [...new Set(this.usage.filter((u) => u.at >= from && u.at <= to).map((u) => u.tag))]; }

  /**
   * 给后台写技能的模型看的一览：在用的（启用、停用）全列；已收起的墓碑只列和这次的事沾边的几条，
   * 其余只给个数——以前 160 多条墓碑全塞进去，占了提示词三分之二，大多和这次的事无关。
   * 墓碑按收起原因分两种：做不好、被合并的（没新证据别再写）；只是数量上限、太久没用上收起的（不是做不好，这次需要就可以重写）。
   */
  forgeOverview(about: string, focus = about, maxRetired = BehaviorEngine.FORGE_TOMBSTONES): string[] {
    const all = this.overview();
    const names = this.list().map((b) => b.name);
    const text = about.toLowerCase();
    const active: string[] = [], scored: { line: string; score: number; at: number }[] = [];
    this.list().forEach((b, i) => {
      const st = this.stats[b.name];
      const line = all[i];
      if (!st?.retired) { active.push(line); return; }
      const score = tombstoneRelevance(b, text, focus);
      if (score >= 2) {
        const tag = idleRetirement(st.retired) && !this.tombstone(b.name) ? '；不是做不好，只是当时用不上，这次需要可以同名重写' : '';
        scored.push({ line: line + tag, score, at: st.retiredAt ?? 0 });
      }
    });
    const picked = scored.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, maxRetired);
    const retired = names.filter((n) => this.stats[n]?.retired).length;
    const rest = retired - picked.length;
    return [...active, ...picked.map((x) => x.line), ...all.slice(names.length),
      ...(rest > 0 ? [`另有 ${rest} 份已收起的技能和这次的事不沾边，没列出`] : [])];
  }
  static FORGE_TOMBSTONES = 8;

  /** 给模型看的一览（技能书索引之外，带成败和停用状态） */
  overview(): string[] {
    let dim = '';
    try { dim = this.adapter.state().dim; } catch { /* 状态暂不可用 */ }
    return [...this.list().map((b) => {
      const st = this.stats[b.name];
      const here = st?.byDim?.[dim];
      const untested = st && st.ok + st.fail > 0 && st.byDim && !here && !(b.when?.dim && !b.when.dim.includes(dim)) ? `（在 ${dim} 还没用过）` : '';
      return `${b.name}［${b.mode === 'auto' ? '自动' : b.mode === 'recover' ? '失败时先试' : '调用'}${b.code ? `，代码 v${b.version ?? 1}` : ''}${b.overrides.length ? `，代替本能 ${b.overrides.join('/')}` : ''}${b.needs ? `，调用时给 args.${Object.keys(b.needs).join('/')}` : ''}］${st && st.ok + st.fail ? ` 成${st.ok}/败${st.fail}` : ''}${st?.retired ? ` 已收起（${st.retired.slice(0, 30)}）` : st?.disabled ? ' 已停用' : ''}${untested}`;
    }), ...[...this.invalid].map(([n, why]) => `${n}：${why}`)];
  }
}

/** 只是因为数量上限、太久没用上而收起的（不是做不好） */
export function idleRetirement(why: string): boolean { return /^技能太多|小时没用上|一次都没用上/.test(why); }

const NAME_STOP = new Set(['and', 'the', 'then', 'when', 'with', 'from', 'into', 'out', 'for', 'off', 'low', 'get', 'use', 'first', 'skill']);
/**
 * 墓碑和这次的事沾不沾边：这次的经过里点名了它、它管的失败动作或代替的本能出现了、名字里的词出现了、
 * 描述和这次的标题（focus，短的那句；整段经过太长，常见说法处处都有）有几处相同的说法。分数越高越相关
 */
export function tombstoneRelevance(b: Pick<Behavior, 'name' | 'description' | 'when' | 'overrides'>, about: string, focus = about): number {
  const text = about.toLowerCase();
  let score = 0;
  if (text.includes(b.name.toLowerCase())) score += 5;
  // 管失败的：这次经过里那个动作真的失败过才算（dig_at、step 几乎每段经过里都有，光出现不算）
  for (const sk of b.when?.after_failure?.skill ?? []) {
    if (!sk) continue;
    const s = sk.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${s} → (?!succeeded)|${s}[^\\n]{0,40}(失败|failed)`).test(text)) score += 3;
    else if (focus.toLowerCase().includes(sk.toLowerCase())) score += 1;
  }
  for (const o of b.overrides ?? []) if (o && text.includes(o.toLowerCase())) score += 2;
  const words = b.name.toLowerCase().split(/[-_\s]+/).filter((w) => w.length >= 3 && !NAME_STOP.has(w));
  // 名字里的词只和标题比：dig、step 这类动作名在整段经过里处处都有
  score += words.filter((w) => focus.toLowerCase().includes(w)).length;
  const desc = (b.description ?? '').slice(0, 80);
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= desc.length; i++) { const g = desc.slice(i, i + 2); if (/^[\u4e00-\u9fff]{2}$/.test(g)) grams.add(g); }
  let shared = 0;
  const head = focus.toLowerCase();
  for (const g of grams) if (head.includes(g)) shared++;
  return score + (shared >= 5 ? 3 : shared >= 3 ? 2 : shared >= 2 ? 1 : 0);
}

/** Beta(a,b) 抽样（a、b 是正整数：两组指数分布之和的比值） */
export function betaSample(a: number, b: number, rand: () => number = Math.random): number {
  const gamma = (k: number) => { let x = 0; for (let i = 0; i < Math.min(k, 200); i++) x -= Math.log(1 - rand()); return x; };
  const x = gamma(Math.max(1, Math.round(a))), y = gamma(Math.max(1, Math.round(b)));
  return x / (x + y);
}
