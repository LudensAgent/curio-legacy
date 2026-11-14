import { claimEdits } from './edits.ts';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import { normalizeSkillName, type KnowSkill, type SkillBook, type SkillMode } from '../knowledge/skillbook.ts';
import { normalizeStep } from '../planner/plan.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import type { Senses, SkillResult } from '../skills/types.ts';
import { compileCheck, compileVerify, MAX_CODE, VERIFY_METHODS } from '../codeskills/sandbox.ts';
import { evalPredicate, isRecovery, isThreat, senseNow, situationOf, validatePredicate, type Predicate, type Sense } from './predicate.ts';

/**
 * 行为技能：模型总结候选，通过显式游戏试用验收后启用的做法。
 *
 *   {"name":"pillar-up-from-skeletons","description":"血少又被骷髅射时先垫高三格躲箭",
 *    "when":{"hp_below":8,"hostile":{"name":"skeleton","within":16}},
 *    "steps":[{"skill":"mine_cell","args":{"at":[0,2,0]}},{"skill":"pillar_one","args":{"item":"any"}} …],"priority":70,"overrides":["low-hp-flee"]}
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
  body?: string; notes?: string;
  when?: Predicate; steps: BehaviorStep[]; priority: number; cooldownMs: number; overrides: string[];
  /** 代码技能：模型写的 JavaScript（在沙箱里跑，只能用 api.*），可以被后台自动改进出新版本 */
  code?: string; version?: number;
  candidate?: boolean;
  /** 判定：做完以后看一眼世界，确认真的做成了（只能读的 api；return true 算成，return "原因" 算没成） */
  verify?: string;
  /** use_skill 调用时必须给的参数：名字 → 说明（恢复时由失败的那一步提供，不检查） */
  needs?: Record<string, string>;
}
export interface RunRecord { at: number; ok: boolean; version?: number; summary: string; line?: number; trace?: string[]; logs?: string[]; args?: string; /** 技能自述做完并通过了 verify，但调用方的收工条件判定这次没有达成目标 */ callerUnmet?: boolean }
export interface BehaviorStats {
  fired: number; ok: number; fail: number; lastAt: number; disabled?: boolean; lastError?: string;
  /** 最近一次写下（新写或改写）的时刻 */
  writtenAt?: number;
  lastUsedAt?: number;
  /** Actual completed invocations since these counters were introduced; legacy totals are not inferred. */
  uses?: number;
  cancelled?: number;
  usageByVersion?: Record<string, { uses: number; skipped: number; cancelled: number; lastUsedAt?: number }>;
  candidatePermit?: number;
  /** 收起的是这个候选版本，不影响同名稳定版和学习笔记。 */
  candidateRetired?: { version: number; at: number; why: string };
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
  /** 手动恢复的时间与原收起记录；不代表技能被调用过。 */
  restoredAt?: number;
  lastRestoration?: { at: number; retiredAt: number; reason: string };
  /** 不是代码的技能每改写一次加一（代码技能用自己的版本号）：成败按版本记，改写不清空历史 */
  rev?: number;
  /** 拉锯里输掉的一方：条件成立也不自动接手，只提醒心智；只压被降级的那个版本，改写出的新版本重新获得机会 */
  advisory?: { since: number; why: string; version?: string };
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

/** Normalize persisted retirement state without discarding version evidence or history. */
export function normalizeSkillStates(stats: Record<string, BehaviorStats>): string[] {
  return Object.entries(stats).flatMap(([name, st]) => {
    if (!st.retired || st.disabled === true) return [];
    st.disabled = true;
    delete st.candidatePermit;
    if (st.disabledAt === undefined && st.retiredAt !== undefined) st.disabledAt = st.retiredAt;
    return [name];
  });
}

/** Shared by the runtime and explicit migrations; retired evidence keeps its version numbers. */
export function nextSkillVersion(book: SkillBook | null, name: string, stats?: BehaviorStats): number {
  const recorded = Object.keys(stats?.byVersion ?? {}).map(Number).filter(Number.isFinite);
  return Math.max(0, stats?.rev ?? 0, book?.versionCeiling(name) ?? 0, ...recorded) + 1;
}
/** 代码技能某次失败后，看看要不要在后台改进（改进器自己限频） */
export type ImproveHook = (name: string, why: 'failures' | 'requested' | 'slow', note?: string) => void;

/** 天生的本能（代码里的身体反应）可以被自己写的技能用 overrides 换掉。
 * off：这次运行里代码没开这条（比如躲怪、还手交给自己写的技能）——要如实告诉模型，别让它以为身体会自己躲 */
export const INSTINCTS: Record<string, { text: string; locked?: boolean; off?: string }> = {
  lava: { text: '掉进岩浆时的反应', off: '代码里没开，靠自己写的技能' },
  drowning: { text: '水里快没气时的反应', off: '代码里没开，靠自己写的技能' },
  creeper: { text: '苦力怕嘶嘶响或贴脸时躲开' },
  'losing-fight': { text: '打架时血掉到 6 以下就撤' },
  'low-hp-flee': { text: '血 ≤6 又有怪在 10 格内就逃' },
  'fight-back': { text: '怪贴到 4 格内：血多就还手，血少就跑' },
  'night-shelter': { text: '夜里血少就地挖坑封顶（默认关闭）' },
  eat: { text: '很饿时有什么吃什么' },
  torch: { text: 'habits.torch_every 打开时，空闲且暗处消耗火把照明' },
};

/** 标出这次运行里哪些本能代码没开（由反射层的配置决定） */
export function markInstincts(active: Iterable<string>, why = '代码里没开，靠自己写的技能') {
  const on = new Set(active);
  for (const [k, v] of Object.entries(INSTINCTS)) { if (on.has(k) || v.locked) delete v.off; else v.off = why; }
}

let instinctSource: (() => Iterable<string>) | null = null;
/** 本能开没开由反射层的配置决定（习惯会变，所以每次用时现问） */
export function setInstinctSource(fn: () => Iterable<string>) { instinctSource = fn; refreshInstincts(); }
export function refreshInstincts() { if (instinctSource) { try { markInstincts(instinctSource()); } catch { /* 反射层还没好 */ } } }

/** 给模型看的本能现状：哪些身体会自己做、哪些不会 */
export function instinctNote(): string {
  refreshInstincts();
  const on = Object.entries(INSTINCTS).filter(([, v]) => !v.off).map(([k, v]) => `${k}（${v.text}）`);
  const off = Object.entries(INSTINCTS).filter(([, v]) => v.off).map(([k, v]) => `${k}（${v.text}）`);
  return `身体自己会做的本能：${on.join('、') || '无'}。${off.length ? `没开、身体不会自己做的：${off.join('、')}——遇到这些情况只能靠自己写的技能或心智临场决定。` : ''}`;
}

/**
 * 救命的技能：条件成立时自动做、或某个动作失败时先试，而且管的是要命的处境（掉血、挨打、怪在附近、窒息、溺水、岩浆）或换掉某个本能。
 * 这种技能平时很少触发是正常的——不能因为“好久没用上”“技能太多”就收起来，不然越久没出事，出事时越没招。
 */
export function isEmergency(b: Pick<Behavior, 'mode' | 'when' | 'overrides'>): boolean {
  return (b.mode === 'auto' || b.mode === 'recover') && (isThreat(b.when) || (b.overrides?.length ?? 0) > 0);
}

/**
 * 应急技能按「威胁谓词 key」粗分：管同一处境的归到一簇，给后台去重/合并用。
 * - override:覆盖哪个本能（覆盖不同本能算不同簇）；
 * - lava（岩浆）/ drown（氧气不足）/ suffocate（卡墙窒息）/ combat（怪在附近、挨打、血少）。
 * 只看谓词的键、不看阈值数值，所以「hostile.within 8」和「hostile.within 5」同属 combat。
 */
export function emergencyKind(b: { when?: Predicate; overrides?: string[] }): string {
  const ov = (b.overrides ?? []).slice().sort().join('+');
  if (ov) return `override:${ov}`;
  const has = (p: Predicate | undefined, ...keys: (keyof Predicate)[]): boolean => {
    if (!p) return false;
    if (keys.some((k) => p[k] !== undefined)) return true;
    return (p.any ?? []).some((x) => has(x, ...keys)) || (p.all ?? []).some((x) => has(x, ...keys));
  };
  if (has(b.when, 'in_lava')) return 'lava';
  if (has(b.when, 'oxygen_below')) return 'drown';
  if (has(b.when, 'in_wall')) return 'suffocate';
  if (has(b.when, 'hostile', 'hurt_within', 'hp_below')) return 'combat';
  return 'other';
}

/** 执行候选必须带判定时的说明（写技能、改技能时都用这一句） */
export const VERIFY_REQUIRED = 'skill.verify：步骤和代码技能都要同时写 verify——一段 JavaScript 函数体，做完以后看一眼世界确认真的做成了。参数 api 和 args：args.before 是开工前的 api.state()，args.result 是 code 的返回值，args.args 是调用参数（目标要拿它核对，别拿 args.result 里代码自己算的值）；只能用 api.state/blockAt/region/entities/nearestLand；做成了 return true，没做成 return "原因"（比如把一个人从水里弄出来，不能只看一次瞬时的 inWater=false——水面上下浮动时它也会是 false；要确认已经站稳、脚下有支撑，如 const s = await api.state(); return s.inWater ? "还在水里" : s.onGround ? true : "漂在水面上，没有落脚"）';

const MAX_STEPS = 8;
type Validated = { name: string; description: string; body: string; behavior: Record<string, unknown>; disable?: boolean };

/** 校验模型写的技能：动作必须是会的、参数合法，条件必须是能感觉到的事 */
export function validateBehavior(raw: unknown, adapter?: GameAdapter, opts?: { deferCompile?: boolean }): Validated | { error: string } {
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
    // 启动时批量加载候选可推迟编译：真正被 use_skill 调用时 runSandboxed 还会再查一遍，这里不预先花 TypeScript 编译的时间
    const bad = opts?.deferCompile ? null : compileCheck(code);
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
    if (!adapter) return { error: `steps[${i}]：步骤技能需要身体校验环境；离线迁移仅校验代码技能` };
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
    const bad = opts?.deferCompile ? null : compileVerify(verify);
    if (bad) return { error: `skill.verify：${bad}（判定只能看：${VERIFY_METHODS.map((m) => `api.${m}`).join('、')}）` };
    behavior.verify = verify;
  }
  if (o.when !== undefined && o.when !== null) {
    const p = validatePredicate(o.when);
    if ('error' in p) return { error: `skill.when：${p.error}` };
    // 恢复类必须写清是哪个动作失败：什么失败都套用的“万能恢复”会在放方块、睡觉失败时也去乱挖
    const failureOf = (q: Predicate): Predicate['after_failure'] | undefined => q.after_failure ?? q.all?.map(failureOf).find(Boolean);
    const af = failureOf(p);
    if (af && !af.skill?.length) return { error: 'after_failure 要写清是哪个动作失败（"skill":["navigate_to"]），不能什么失败都套用这一套' };
    // 只看状态、条件太宽（比如只写 night:true）会一直打断手上的活：自动技能至少要有一个具体的触发
    if (!isRecovery(p) && Object.keys(p).every((k) => ['night', 'dark', 'on_ground', 'doing', 'not_doing'].includes(k))) {
      return { error: 'skill.when 太宽了：自动做的技能要写清具体情况（血量、怪、身边的方块、失败的动作……）' };
    }
    behavior.when = p;
    const failures = (condition: Predicate): string | null => {
      for (const name of condition.after_failure?.skill ?? []) {
        if (!SKILLS[name] || LLM_HIDDEN.has(name)) return `恢复条件没有可调用的动作 ${name}`;
        if (SKILLS[name].readOnly && condition.after_failure?.code?.includes('NOT_FOUND')) return `${name} 的 NOT_FOUND 是观察结果，不进入恢复调度；请由心智选择下一步`;
      }
      return [...(condition.all ?? []), ...(condition.any ?? [])].map(failures).find((why) => why !== null) ?? null;
    };
    const unreachable = failures(p);
    if (unreachable) return { error: `skill.when：${unreachable}` };
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
  const body = String(o.body ?? o.note ?? o.notes ?? '').trim().slice(0, 3000) || `${description}\n\n（从经历里提出的做法；先显式试用，用实际观测验收。）`;
  return { name, description, body, behavior };
}

/** 把技能书里一份带 behavior 的技能变成可执行的行为；格式不对就跳过 */
function toBehavior(k: KnowSkill, adapter: GameAdapter, deferCompile = false): Behavior | { error: string } | null {
  if (!k.behavior || typeof k.behavior !== 'object') return null;
  const v = validateBehavior({ name: k.name, description: k.description || k.name, ...(k.behavior as object) }, adapter, { deferCompile });
  if ('error' in v) return v;
  if (v.disable) return null;
  const b = v.behavior as Record<string, any>;
  const version = Number((k.behavior as any).version) || (b.code ? 1 : undefined);
  return { name: k.name, description: k.description, source: k.source, mode: b.when ? (isRecovery(b.when) ? 'recover' : 'auto') : 'manual',
    body: k.body.replace(/```behavior[\s\S]*?```/, '').trim(), notes: k.notes,
    ...(b.when ? { when: b.when } : {}), steps: b.steps ?? [], priority: b.priority, cooldownMs: b.cooldown_s * 1000, overrides: b.overrides ?? [],
    ...(b.code ? { code: b.code } : {}), version, ...((k.behavior as Record<string, unknown>).candidate === true ? { candidate: true } : {}), ...(b.verify ? { verify: b.verify } : {}), ...(b.args ? { needs: b.args } : {}) };
}

/** 恢复技能按“哪个动作、什么错误码”失败来归类 */
const recoverySig = (f: { skill: string; code?: string | null }) => `${f.skill}:${f.code ?? ''}`;

export class BehaviorEngine {
  private behaviors = new Map<string, Behavior>();
  private candidates = new Map<string, Behavior>();
  private stats: Record<string, BehaviorStats> = {};
  /** 最近用过哪些技能（名字@版本、什么时候）：收获账本拿它算“用了这个技能拿东西是快了还是慢了” */
  private usage: { at: number; tag: string }[] = [];
  /** 最近身体自己接手（自动/恢复）的记录：认出来回拉锯 */
  private fires: { at: number; name: string; doing: string | null }[] = [];
  /** 拉锯/空转时先让一边歇一会儿（不是停用：过了这段时间照常）；版本变了就不再压住新版本。 */
  private holds = new Map<string, { until: number; why: string; closer?: number; version: string }>();
  private loopSaid = new Map<string, number>();
  /** 恢复技能 × 失败种类 → 最近一次没帮上（或跳过）的时刻 */
  private recentMiss = new Map<string, number>();
  static readonly RECOVERY_MISS_MS = 3 * 60_000;
  static readonly LOOP_WINDOW_MS = 5 * 60_000;
  static readonly HOLD_MS = 90_000;
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
  private invalidCandidates = new Map<string, string>();
  private doneListener = (o: TaskOutcome) => this.onDone(o);
  private lastHurtAt = 0;
  /** 自动技能做完后补充事后观测，不把后来受伤或死亡直接归因成技能失败。 */
  private aftermath = new Map<string, { taskId: string; behavior: Behavior; hp: number; at: number; summary?: string; data?: Record<string, unknown>; context: string; pos?: { x: number; y: number; z: number }; interrupted?: string; nearest?: number }>();
  private recoveries = new Map<string, { behavior: Behavior; data?: Record<string, unknown>; ignored?: boolean; invocationRecorded?: boolean }>();
  /** 最近一次记成成功的运行身份（技能、版本、维度、arbiter 任务 id）：调用方事后判定收工条件未满足时，只降级这一条。 */
  private lastCredit: { name: string; version: string; dim: string; taskId: string; entry: RunRecord } | null = null;
  /** 同一版本连续空转的次数与最近一次时间：超过重置窗口重新从 1 数；第二次起硬暂停。 */
  private idleStreak = new Map<string, { version: string; streak: number; lastIdleAt: number }>();
  static readonly IDLE_STREAK_RESET_MS = 5 * 60_000;
  static readonly IDLE_STREAK_ESCALATE = 2;
  static readonly AFTERMATH_MS = 12_000;
  /** 代码技能失败或心智要求改进时调用（main 接到后台改进器） */
  improve: ImproveHook | null = null;
  /** 死后掉在地上还没捡回的东西（main 接到世界记忆）：给 dropped_items 条件用 */
  drops: (() => Sense['deathDrop']) | null = null;

  constructor(private book: SkillBook | null, private adapter: GameAdapter, private arbiter: Pick<Arbiter, 'start' | 'info' | 'on' | 'off'> | null,
    private bus: EventBus, private senses: Pick<Senses, 'perceivedEntities' | 'observeBlocks'>, private statsFile: string | null = null) {
    if (statsFile && fs.existsSync(statsFile)) { try { this.stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')) ?? {}; } catch { this.stats = {}; } }
    const normalized = normalizeSkillStates(this.stats);
    if (normalized.length) this.touch(normalized[0], () => {});
    book?.onChange(() => this.reload());
    bus.on('event', (ev: { type: string; msg?: string; data?: Record<string, unknown> }) => {
      if (ev.type === 'hurt') this.lastHurtAt = Date.now();
      else if (ev.type === 'death') for (const name of [...this.aftermath.keys()]) this.judge(name, true);
      else if (ev.type === 'effect_broken') this.noteBroken(String((ev.data as any)?.by ?? ''), ev.msg ?? '');
    });
    arbiter?.on('done', this.doneListener);
    this.reload();
  }

  dispose() { this.arbiter?.off('done', this.doneListener); }

  reload() {
    this.behaviors.clear();
    this.candidates.clear();
    this.invalid.clear();
    this.invalidCandidates.clear();
    for (const k of this.book?.list() ?? []) {
      if (k.behavior === undefined) continue;
      const b = toBehavior(k, this.adapter, (k.behavior as Record<string, unknown>).candidate === true);
      if (b && !('error' in b)) { b.version ??= this.stats[b.name]?.rev ?? 1; this.behaviors.set(b.name, b); }
      else if ((k.behavior as Record<string, unknown>).candidate !== true) this.invalid.set(k.name, b?.error ?? '格式不对，没有生效');
    }
    for (const k of this.book?.pending() ?? []) {
      const b = toBehavior(k, this.adapter, true);
      if (b && !('error' in b)) this.candidates.set(b.name, b);
      else this.invalidCandidates.set(k.name, b?.error ?? '格式不对');
    }
  }

  list(trial = false): Behavior[] { return [...(trial ? this.candidates : this.behaviors).values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)); }
  get(name: string, trial = false): Behavior | undefined { return trial ? this.candidates.get(name) : this.behaviors.get(name); }

  /**
   * 这个技能当前的 when 是否成立。没有 when 的手动/知识技能不拦；
   * 自动展开全文前用它核对适用条件，避免只凭关键词就把正文塞进提示词。
   */
  conditionHolds(name: string, cur: TaskInfo | null): boolean {
    const b = this.get(name) ?? this.get(name, true);
    if (!b?.when) return true;
    try { return evalPredicate(b.when, this.sense(cur)); } catch { return false; }
  }
  statsOf(name: string): BehaviorStats | undefined { return this.stats[name]; }
  enabled(b: Behavior): boolean { return !b.candidate && !this.inactive(b.name); }
  candidateRetirement(name: string) {
    const retired = this.stats[name]?.candidateRetired;
    return retired?.version === this.get(name, true)?.version ? retired : undefined;
  }
  /** 收起候选时仍展示同名稳定版或文字记录；明确修订后的候选也可以重新出现。 */
  hidden(name: string): boolean {
    if (this.inactive(name)) return !!this.executionError(name, true);
    return !!this.candidateRetirement(name) && this.book?.get(name) === this.book?.candidate(name);
  }
  executionError(name: string, trial = false): string | null {
    const b = this.get(name, trial);
    const retiredCandidate = this.candidateRetirement(name);
    if ((trial || b?.candidate) && retiredCandidate) return `技能 ${name} 候选 v${retiredCandidate.version} 已收起：${retiredCandidate.why}；可读取历史，由心智显式修订后再试`;
    if (this.inactive(name) && !(trial && b?.candidate && this.stats[name]?.candidatePermit === b.version)) return `技能 ${name} 已停用或收起；由心智显式修订后再试`;
    if (!b) {
      const invalid = trial ? this.invalidCandidates.get(name) : this.invalid.get(name);
      if (invalid) return `技能 ${name} 的${trial ? '候选版本' : '可执行定义'}未通过校验：${invalid}`;
      if (!trial && this.candidates.has(name)) return `${name} 尚为候选；用 use_skill {name:"${name}",trial:true} 显式试用`;
      if (!trial && this.invalidCandidates.has(name)) return `技能 ${name} 的候选版本未通过校验：${this.invalidCandidates.get(name)}`;
      const entry = this.book?.get(name);
      if (!trial && entry && entry.behavior === undefined) return `技能 ${name} 是文字记录，没有可执行行为；可用 {"kind":"skill","name":"${name}"} 阅读`;
      return trial ? `没有 ${name} 的候选版本` : `没有技能 ${name}`;
    }
    return b.candidate && !trial ? `${name} 尚为候选；用 use_skill {name:"${name}",trial:true} 显式试用` : null;
  }
  editToken(name: string): string | undefined {
    const k = this.book?.get(name), candidate = this.book?.candidate(name), st = this.stats[name];
    return k || candidate || st ? JSON.stringify([k?.updatedAt, k?.behavior, candidate?.updatedAt, candidate?.behavior, st?.disabled, st?.retired, st?.disabledAt, st?.retiredAt, st?.candidateRetired]) : undefined;
  }

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
    // 救命类的候选也允许在要命条件下自动接手（事后按结果判定启用还是收起），其余候选仍只显式试用
    const auto = this.list().filter((b) => b.mode === 'auto' && this.enabled(b))
      .concat(this.list(true).filter((b) => b.mode === 'auto' && isEmergency(b) && !this.inactive(b.name) && !this.candidateRetirement(b.name)));
    if (!auto.length) return false;
    const running = this.running(cur);
    // 天生的躲闪正在进行（逃跑、上浮）时，只有更要紧的技能才插手
    const floor = running ? running.priority : cur?.source === 'reflex' ? 60 : 0;
    let s: Sense | null = null;
    const matches: Behavior[] = [];
    for (const b of auto) {
      if (b.priority <= floor || running?.name === b.name) continue;
      const hold = this.activeHold(b, now);
      if (hold) {
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
      // 拉锯里输掉的那个版本只提醒、不自动接手；同名新版本（改写/候选）重新获得机会。
      // 旧数据没有版本号：只压稳定版，避免把已经改写过的候选一起压住。
      if (adv && (adv.version !== undefined ? adv.version === this.versionOf(b) : !b.candidate)) {
        const candidate = this.candidates.get(b.name);
        const candidateCanTake = !!candidate && candidate.mode === 'auto' && isEmergency(candidate)
          && !this.inactive(b.name) && !this.candidateRetirement(b.name)
          && (adv.version === undefined || adv.version !== this.versionOf(candidate));
        if (!candidateCanTake) this.waiting(b, cur, now, adv.why);
        continue;
      }
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
      const r = this.arbiter.start({ skill: 'use_skill', args: { name: b.name, ...(b.candidate ? { trial: true } : {}), args: { trigger } } }, 'reflex');
      if ('error' in r) { this.lastFired.set(b.name, now); continue; }
      this.aftermath.set(b.name, { taskId: r.id, behavior: b, hp: s.state.hp, at: now, pos: { ...s.state.pos }, nearest: Math.min(Infinity, ...s.hostiles.map((h) => h.dist)), ...(s.doing && cur && cur.source !== 'filler' ? { interrupted: s.doing } : {}), context: `触发时血 ${trigger.hp}${trigger.hostiles.length ? `，${trigger.hostiles.map((h) => `${h.name} ${h.dist}格`).join('、')}` : ''}，${trigger.cover === 'open' ? '在空地' : trigger.cover === 'pit' ? '在坑里' : '在封好的坑里'}${s.doing ? `，当时在做 ${s.doing}` : ''}${trigger.offHand ? `，副手拿着 ${trigger.offHand}` : ''}` });
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
    // 要看到两轮 A、B、A、B 才算互相拉锯：只交替一轮常常只是环境切换（水里/陆上、氧气够不够），
    // 不足以证明两个技能在互相拆台；误判会把一个保命技能永久降级。
    if (last.length === 4 && last[0] === last[2] && last[1] === last[3] && last[0] !== last[1]) {
      loop = { kind: 'pingpong', a: last[2], b: last[3], times: this.fires.filter((f) => f.name === last[0] || f.name === last[1]).length };
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
        this.holds.set(loser.name, { until: now + BehaviorEngine.HOLD_MS, why, version: this.versionOf(loser) });
        // 只歇一会儿压不住：降成“只提醒、不接手”，直到它被改写（整理时拆开条件）才恢复
        this.touch(loser.name, (st) => { st.advisory = { since: now, why, version: this.versionOf(loser) }; });
      }
      this.bus.publish('skill_loop', 'P1', `技能「${loop.a}」和「${loop.b}」在来回拉锯：一个做完另一个又把它推回去（几分钟里 ${loop.times} 回）${loser ? `；「${loser.name}」先改成只提醒、不自动接手，直到它被改写` : ''}`,
        { kind: loop.kind, a: loop.a, b: loop.b, times: loop.times, held: loser?.name ?? null });
    } else {
      record(loop.a, `doing:${loop.b}`);
      this.bus.publish('skill_loop', 'P1', `技能「${loop.a}」几分钟里第 ${loop.times} 次打断手上的「${loop.b}」：技能和手上的事在拉锯——要么换个做法完成这件事，要么等情况过去再做，要么改这个技能的条件`,
        { kind: loop.kind, a: loop.a, b: loop.b, times: loop.times, held: null });
    }
  }

  /** 当前版本仍有效的暂停；同名新版本不受旧暂停影响。 */
  private activeHold(b: Behavior, now: number) {
    const h = this.holds.get(b.name);
    return h && h.until > now && h.version === this.versionOf(b) ? h : null;
  }

  /** 拉锯时被叫停的技能（给控制台和测试看）：旧版本的暂停不算在当前版本头上 */
  heldNow(now = Date.now()): string[] {
    return [...this.holds].flatMap(([name, h]) => {
      const b = this.get(name) ?? this.get(name, true);
      return h.until > now && b && h.version === this.versionOf(b) ? [name] : [];
    });
  }

  /** 同时满足条件时的选择分：优先级 + 实际成功率（没用过的按五五开） */
  choiceScore(b: Behavior): number {
    const st = this.currentStats(b.name, !!b.candidate);
    const rate = ((st?.ok ?? 0) + 1) / ((st?.ok ?? 0) + (st?.fail ?? 0) + 2);
    return b.priority + 40 * (rate - 0.5);
  }

  /** 整理：把技能收起来（停用并写明原因）；同名重写会恢复 */
  retire(name: string, why: string, opts: { preserveCandidate?: boolean } = {}): boolean {
    if (!this.behaviors.has(name) && this.book?.get(name)?.source !== 'self') return false;
    const candidate = opts.preserveCandidate && !this.candidateRetirement(name) ? this.get(name, true) : undefined;
    this.touch(name, (st) => {
      st.disabled = true; st.retired = why.slice(0, 120); st.retiredAt = Date.now();
      if (candidate) st.candidatePermit = candidate.version; else delete st.candidatePermit;
    });
    this.bus.publish('skill_retired', 'P2', `整理技能：收起「${name}」（${why.slice(0, 80)}）${candidate ? `；候选 v${candidate.version} 仍可显式试用` : ''}`, { name, why, ...(candidate ? { candidateVersion: candidate.version } : {}) });
    return true;
  }

  retireCandidate(name: string, version: number, why: string): boolean {
    const candidate = this.get(name, true);
    if (!candidate || candidate.version !== version || this.candidateRetirement(name)) return false;
    this.touch(name, (st) => {
      st.candidateRetired = { version, at: Date.now(), why: why.slice(0, 120) };
      if (st.candidatePermit === version) delete st.candidatePermit;
    });
    this.bus.publish('skill_retired', 'P2', `整理技能：收起「${name}」候选 v${version}（${why.slice(0, 80)}）；同名稳定版保持原状态`, { name, version, why, candidate: true });
    return true;
  }

  /** 文字记录没有游戏验收阶段，显式恢复只让它重回目录。 */
  restoreNote(name: string): boolean {
    const entry = this.book?.get(name);
    if (!entry || entry.source !== 'self' || entry.behavior !== undefined || this.book?.candidate(name) || !this.inactive(name)) return false;
    this.touch(name, (st) => { st.disabled = false; st.restoredAt = Date.now(); delete st.retired; delete st.retiredAt; delete st.disabledAt; });
    this.bus.publish('skill_restored', 'P2', `恢复文字技能 ${name}；只恢复阅读目录，不代表已验证做法`, { name, knowledge: true });
    return true;
  }

  /** 控制台恢复一个被手动禁用的自学技能（行为或文字记录都行，取消 disabled/retired）。 */
  restore(name: string): boolean {
    const entry = this.book?.get(name);
    if (!entry || entry.source !== 'self' || !this.inactive(name)) return false;
    this.touch(name, (st) => { st.disabled = false; st.restoredAt = Date.now(); delete st.retired; delete st.retiredAt; delete st.disabledAt; });
    this.bus.publish('skill_restored', 'P2', `控制台恢复技能 ${name}`, { name });
    return true;
  }

  /** 控制台清除自学技能后，删掉它们的统计（含墓碑），让同名技能将来能重新被写，而不是被 2 小时墓碑挡住。 */
  forgetStats(names: Iterable<string>): number {
    let removed = 0;
    for (const name of names) {
      if (delete this.stats[name]) removed++;
      this.aftermath.delete(name);
      this.recoveries.delete(name);
      this.holds.delete(name);
      this.idleStreak.delete(name);
      this.waitSaid.delete(name);
      this.lastFired.delete(name);
      this.usage = this.usage.filter((entry) => !entry.tag.startsWith(`${name}@`));
      this.fires = this.fires.filter((entry) => entry.name !== name);
      if (this.lastCredit?.name === name) this.lastCredit = null;
    }
    if (removed && this.statsFile) {
      try { fs.mkdirSync(path.dirname(this.statsFile), { recursive: true }); fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 1)); } catch { /* 统计写不进去不影响游玩 */ }
    }
    return removed;
  }

  /** 物理删除同时移除目录、候选与运行缓存；收起仍保留这些记录。 */
  delete(name: string): boolean {
    if (!this.book?.remove(name)) return false;
    this.forgetStats([name]);
    return true;
  }

  /** 恢复明确指定且状态未变的闲置技能；保留版本与使用历史。 */
  restoreRetired(entries: { name: string; retiredAt: number }[], now = Date.now()): string[] {
    if (!this.statsFile) throw new Error('没有技能统计文件，不能持久化恢复');
    for (const { name, retiredAt } of entries) {
      const b = this.behaviors.get(name), st = this.stats[name];
      if (!b || b.source !== 'self' || b.candidate || !st?.retired || st.retiredAt !== retiredAt || !/小时没用上|个有效游戏日没用上|一次都没用上/.test(st.retired)) {
        throw new Error(`技能 ${name} 不存在或收起状态已变化，未恢复任何技能`);
      }
    }
    const next = { ...this.stats };
    for (const { name, retiredAt } of entries) {
      const old = next[name];
      const restored = { ...old, disabled: false, restoredAt: now, lastRestoration: { at: now, retiredAt, reason: old.retired! } };
      delete restored.retired;
      delete restored.retiredAt;
      delete restored.disabledAt;
      next[name] = restored;
    }
    fs.writeFileSync(this.statsFile, JSON.stringify(next, null, 1));
    this.stats = next;
    return entries.map(({ name }) => name);
  }

  /** 整理：调整优先级（同时满足条件时谁先上） */
  setPriority(name: string, priority: number, expectedToken?: string): boolean {
    const k = this.book?.candidate(name) ?? this.book?.get(name);
    if (!k || !this.book || !k.behavior || typeof k.behavior !== 'object') return false;
    const p = Math.max(1, Math.min(90, Math.round(priority)));
    const raw = { ...(k.behavior as Record<string, unknown>), priority: p, code_file: undefined, version: undefined };
    const w = this.write({ name, description: k.description, body: k.body, ...raw }, { by: 'curator', ...(expectedToken !== undefined ? { expectedToken } : {}) });
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
    const hit = rec.filter((b) => !this.activeHold(b, now) && evalPredicate(b.when!, s))
      .sort((a, b) => this.choiceScore(b) - this.choiceScore(a))[0];
    if (!hit) return null;
    // 按它以往的成败“掷一次骰子”（Beta 后验抽样）：常成功的几乎总会上，老失败的偶尔还给它机会、多数时候直接交还给心智。
    // 不设硬门槛，也不替它判死刑——成败一变，上场的机会跟着变
    const st = this.currentStats(hit.name);
    const p = betaSample((st?.ok ?? 0) + 1, (st?.fail ?? 0) + 1, this.rand);
    if ((st?.ok ?? 0) + (st?.fail ?? 0) >= 3 && p < BehaviorEngine.RECOVERY_MIN_CHANCE) { // 还没用够 3 次的照常试，先攒证据
      this.recentMiss.set(`${hit.name}|${sig}`, now);
      this.bus.publish('instinct_skipped', 'P3', `${failure.skill} 没成，「${hit.name}」以往成 ${st?.ok ?? 0} 败 ${st?.fail ?? 0}，这次多半也不管用，交给脑子想`, { name: hit.name, ok: st?.ok ?? 0, fail: st?.fail ?? 0 });
      return null;
    }
    this.noteFire(hit.name, failure.skill, now);
    this.recoveries.set(hit.name, { behavior: hit });
    this.lastFired.set(hit.name, now);
    this.touch(hit.name, (st) => { st.fired++; st.lastAt = now; });
    this.bus.publish('instinct', 'P2', `${failure.skill} 没成（${failure.code ?? '失败'}），身体先照技能「${hit.name}」试试：${hit.description}`, { name: hit.name, recover: true });
    return hit;
  }

  /**
   * 模型写出的版本先存候选，稳定版继续使用；disable 同时拦调度和直接调用。
   */
  write(raw: unknown, opts: { by?: 'mind' | 'forge' | 'curator' | 'improve'; expectedToken?: string } = {}): { ok: true; name: string; created: boolean; mode: SkillMode; disabled?: boolean; restored?: boolean; improving?: boolean; candidate?: boolean; unchanged?: boolean } | { ok: false; error: string; gated?: boolean } {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const requestedName = normalizeSkillName(String(o.name ?? ''));
    if (Object.hasOwn(opts, 'expectedToken') && opts.expectedToken !== this.editToken(requestedName)) return { ok: false, error: '技能在生成期间已修订、停用或收起，忽略过期结果', gated: true };
    if (o.from_version !== undefined) {
      if (opts.by !== 'mind') return { ok: false, error: '选择历史版本再试需要心智明确选择' };
      if (typeof o.from_version !== 'number' || !Number.isSafeInteger(o.from_version) || o.from_version < 1) return { ok: false, error: 'from_version 需要正整数' };
      const version = o.from_version;
      const current = this.get(requestedName), candidate = this.get(requestedName, true);
      const old = current && !current.candidate && Number(this.versionOf(current)) === version ? this.book?.get(requestedName)
        : candidate?.version === version ? this.book?.candidate(requestedName) : this.book?.definitionVersion(requestedName, version);
      if (!old?.behavior || old.source !== 'self') return { ok: false, error: `v${version} 缺少自学技能的完整契约，不能仅凭历史代码生成候选` };
      const result = this.write({ ...old.behavior as Record<string, unknown>, name: requestedName, description: old.description, body: old.body,
        version: undefined, candidate: undefined, code_file: undefined }, opts);
      if (result.ok && result.unchanged && (this.candidateRetirement(requestedName) || this.inactive(requestedName))) {
        this.touch(requestedName, (st) => { st.candidatePermit = version; st.restoredAt = Date.now(); delete st.candidateRetired; });
        this.bus.publish('skill_restored', 'P2', `重新开放候选 ${requestedName} v${version} 的显式试用；保留原契约和证据，不启用稳定版`, { name: requestedName, version, candidate: true });
        return { ...result, restored: true };
      }
      return result;
    }
    if (o.restore === true) {
      if (opts.by !== 'mind') return { ok: false, error: '恢复文字技能需要心智明确选择' };
      return this.restoreNote(requestedName) ? { ok: true, name: requestedName, created: false, mode: 'manual', restored: true }
        : { ok: false, error: '只能直接恢复已收起或停用的纯文字技能；行为技能需显式修订和试用' };
    }
    const previousCandidate = this.get(requestedName, true);
    const inheritCandidatePermit = opts.by === 'improve' && previousCandidate !== undefined
      && this.stats[requestedName]?.candidatePermit === previousCandidate.version && this.executionError(requestedName, true) === null;
    // 停用/收起的技能给后台一个 2 小时墓碑期：期内同名结果仍被拦（防写→停用→重写循环）；过了墓碑期，后台可重新写成候选复活
    if (opts.by && opts.by !== 'mind' && !inheritCandidatePermit) {
      const tomb = this.tombstone(requestedName);
      if (tomb) return { ok: false, error: tomb, gated: true };
    }
    if (opts.by && opts.by !== 'mind' && this.candidateRetirement(requestedName)) return { ok: false, error: '这份候选已收起，后台结果不能重新启用或重写它；由心智显式修订', gated: true };
    // {"name":…,"improve":"哪里不好"}：请后台改进这份代码技能（异步，改进器限频）
    if (typeof o.improve === 'string' && !o.code && !o.steps) {
      const name = normalizeSkillName(String(o.name ?? ''));
      const b = this.get(name, true) ?? this.get(name);
      if (!b?.code) return { ok: false, error: `${name || '这份技能'} 不是代码技能，改不了；可以同名重写` };
      this.improve?.(name, 'requested', o.improve.slice(0, 200));
      return { ok: true, name, created: false, mode: b.mode, improving: true };
    }
    const v = validateBehavior(raw, this.adapter);
    if ('error' in v) return { ok: false, error: v.error };
    if (v.disable) {
      if (!this.behaviors.has(v.name) && !this.book?.get(v.name)) return { ok: false, error: `没有叫 ${v.name} 的技能` };
      this.touch(v.name, (st) => { st.disabled = true; st.disabledAt = Date.now(); delete st.candidatePermit; });
      this.bus.publish('skill_disabled', 'P2', `停用了技能 ${v.name}`, { name: v.name, by: 'mind' });
      return { ok: true, name: v.name, created: false, mode: this.behaviors.get(v.name)?.mode ?? 'manual', disabled: true };
    }
    if (!this.book) return { ok: false, error: '没有技能书，存不下技能' };
    // 步骤与代码候选都靠同一验收机制晋级，在保存入口明确要求判定。
    if (opts.by && !v.behavior.verify) return { ok: false, error: VERIFY_REQUIRED };
    const pending = this.book.candidate(v.name);
    if (opts.by && pending && previousCandidate) {
      const { version: _version, candidate: _candidate, code_file: _codeFile, ...contract } = pending.behavior as Record<string, unknown>;
      const body = v.body.replace(/```behavior[\s\S]*?```/, '').trim();
      if (isDeepStrictEqual(v.behavior, contract) && v.description === pending.description && body === previousCandidate.body) {
        return { ok: true, name: v.name, created: false, mode: previousCandidate.mode, candidate: true, unchanged: true };
      }
    }
    // 后台总结（每死一次、每吃一次亏都会来一遍）不能推翻一个还没攒够证据的版本：
    // 否则同一个技能在几种打法之间来回改，没有一个版本用够几次，永远不知道哪个管用
    if (opts.by === 'forge' || opts.by && opts.by !== 'mind' && previousCandidate) {
      const gate = this.rewriteGate(v.name) ?? (inheritCandidatePermit ? null : this.tombstone(v.name));
      if (gate) {
        this.bus.publish('skill_revision_deferred', 'P2', gate, { name: v.name, version: previousCandidate?.version, by: opts.by });
        return { ok: false, error: gate, gated: true };
      }
    }
    const version = this.nextVersion(v.name);
    const w = this.book.write(v.name, v.description, v.body, v.behavior, { candidate: !!opts.by, version, previousVersion: this.get(v.name)?.version });
    if (!w.ok) return w;
    if (!this.behaviors.has(w.skill.name)) this.reload();
    const b = opts.by ? this.candidates.get(w.skill.name) : this.behaviors.get(w.skill.name);
    if (!b) return { ok: false, error: '技能写下了，但格式不对没有生效' };
    // 稳定版重写会换掉自动接手的执行内容：旧版本的暂停/空转计数不应继续压着它。候选版本不解除稳定版的暂停。
    if (!opts.by) { this.holds.delete(b.name); this.idleStreak.delete(b.name); }
    // 修订就是重新给它一次机会：新版本从零记，旧版本的成败留着（好拿来比）
    this.touch(b.name, (st) => {
      if (!opts.by) { st.disabled = false; delete st.lastError; delete st.retired; delete st.advisory; delete st.retiredAt; delete st.disabledAt; }
      st.candidatePermit = opts.by === 'mind' || inheritCandidatePermit || (opts.by && this.inactive(requestedName)) ? b.version : undefined;
      delete st.swappedAt; st.versionAt = Date.now(); st.writtenAt = Date.now();
      if (!b.code && !w.created && !b.version) st.rev = (st.rev ?? 1) + 1;
    });
    return { ok: true, name: b.name, created: w.created, mode: b.mode, ...(opts.by ? { candidate: true } : {}) };
  }

  /**
   * 修订保存候选，按版本积累真实证据；回退恢复完整契约。
   * 统计按版本分开记，用来判断新版本是不是真的更好。
   */
  /** 当前版本的成败 */
  versionOf(b: Behavior): string { return String(b.version ?? this.stats[b.name]?.rev ?? 1); }
  nextVersion(name: string): number {
    return nextSkillVersion(this.book, name, this.stats[name]);
  }
  currentStats(name: string, trial = false): { ok: number; fail: number } {
    const b = this.get(name, trial);
    const st = this.stats[name];
    return (b && st?.byVersion?.[this.versionOf(b)]) ?? (b && st && !st.byVersion && !b.candidate ? { ok: st.ok, fail: st.fail } : { ok: 0, fail: 0 });
  }
  /** 完整契约与真实成功证据仍在的应急版本；仅供选择，不赋予新版成功或启用权限。 */
  successfulEmergencyVersions(name: string) {
    const stable = this.get(name), candidate = this.get(name, true);
    const versions = [...new Set([
      ...(stable && !stable.candidate ? [Number(this.versionOf(stable))] : []), ...(candidate ? [candidate.version!] : []),
      ...(this.book?.versions(name) ?? []).filter((entry) => entry.definition).map((entry) => entry.version),
    ])].sort((a, b) => b - a);
    return versions.flatMap((version) => {
      const location = stable && !stable.candidate && Number(this.versionOf(stable)) === version ? 'stable' as const
        : candidate?.version === version ? 'candidate' as const : 'history' as const;
      const evidence = this.stats[name]?.byVersion?.[String(version)];
      if (!evidence?.ok) return [];
      const saved = location === 'history' ? this.book?.definitionVersion(name, version) : undefined;
      const behavior = location === 'stable' ? stable : location === 'candidate' ? candidate : saved ? toBehavior(saved, this.adapter) : null;
      if (!behavior || 'error' in behavior || behavior.source !== 'self' || !isEmergency(behavior)) return [];
      return [{ version, ok: evidence.ok, fail: evidence.fail, location }];
    });
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
    if (b.candidate) return `${name} 尚为候选，需要显式试用验收`;
    const cur = this.currentStats(name);
    if (cur.ok < BehaviorEngine.MIN_EVIDENCE || cur.ok < cur.fail * 2) return `${name} 当前版本还不够可靠（成 ${cur.ok} 败 ${cur.fail}）`;
    return null;
  }
  reliableList(): string[] {
    return this.list().filter((b) => !this.reliable(b.name)).map((b) => { const c = this.currentStats(b.name); return `${b.name}：${b.description.slice(0, 60)}（成 ${c.ok} 败 ${c.fail}${b.needs ? `，args.${Object.keys(b.needs).join('/')}` : ''}）`; });
  }

  /** 拉锯里输掉、只提醒不自动接手的技能：显式调用和组合仍可用，但不能宣称它自动覆盖某件事。 */
  isAdvisory(name: string): boolean { return !!this.stats[name]?.advisory; }

  /** 技能能不能真正接管某件事（covered_by 用它判断“这事已有技能管”，不是只问有没有这个名字）。
   *  区分可试验候选与可复用的稳定版：候选（需 trial:true 才可试）不算覆盖；稳定版无论显式调用还是自动接手都可算覆盖，
   *  但已收起/停用/拉锯只提醒的返回原因。null = 可以接管。 */
  handlesNow(name: string): string | null {
    const b = this.get(name);
    if (!b) return `没有技能 ${name}`;
    if (b.candidate) return `${name} 尚为候选，需要显式试用验收`;
    if (this.inactive(name)) return `${name} 已收起或停用`;
    const adv = this.stats[name]?.advisory;
    if (adv) return `${name} 拉锯后只提醒、不自动接手：${adv.why}`;
    return null;
  }

  /** 给提示词看的自动接手状态：null=按声明自动接手；否则一句话说明为什么不会自动做（但仍可显式调用）。 */
  autoNote(name: string): string | null {
    const b = this.get(name);
    if (!b || b.mode !== 'auto') return null;
    if (this.inactive(name)) return '已收起或停用';
    const adv = this.stats[name]?.advisory;
    if (adv) return `拉锯后只提醒、不自动接手（${adv.why}）`;
    return null;
  }
  /** 能不能改写这份技能：当前版本用得太少就先别动（停用了、或者代码本身报错的除外） */
  rewriteGate(name: string): string | null {
    const b = this.get(name, true) ?? this.get(name);
    const st = this.stats[name];
    if (!b || b.source !== 'self' || !st || st.disabled && !b.candidate) return null;
    const cur = this.currentStats(name, !!b.candidate);
    const uses = cur.ok + cur.fail;
    const latest = st.recent?.filter((record) => record.version === b.version).at(-1);
    const codeBroke = latest?.ok === false && /参数错误|SyntaxError|TypeError|ReferenceError/.test(latest.summary);
    if (b.candidate && uses === 0 && !codeBroke)
      return `「${name}」候选 v${b.version} 还没用过（成 0 败 0），保留待试用版本；由心智选择试用时机或显式修订`;
    // 刚换上（写下、改进、退回）的版本还没跑过：先让它跑几次（以前退回旧版本生成的新版本号马上又被改）
    if (uses === 0 && st.swappedAt && Date.now() - st.swappedAt < BehaviorEngine.FRESH_MS && !codeBroke)
      return `「${name}」当前版本 ${Math.round((Date.now() - st.swappedAt) / 60_000)} 分钟前才换上，还没用过：先让它跑几次，这次的经过已经记进它的成败`;
    // 一次都没触发过：说明条件没对上这次的事，改写它不会丢掉什么证据——但刚写下几分钟就再改，等于同一个想法来回换说法
    // （10-26：stairway-up-when-water-blocks-climb 三分钟里被改写四次，一次都没用上）
    if (uses === 0 && !codeBroke && st.writtenAt && Date.now() - st.writtenAt < BehaviorEngine.REWRITE_GAP_MS)
      return `「${name}」${Math.max(1, Math.round((Date.now() - st.writtenAt) / 60_000))} 分钟前才写下、还没用过：先别急着改写，等它用上几次或过一会儿再看`;
    if (uses === 0 || codeBroke) return null;
    // 用了 3 次以上却一次没成：重写只是把一套坏代码换成另一套，计数还归零，抢在 curator 按 4 次失败收起它之前又换新版本，
    // 于是零成功技能陷入「重写→再失败→再重写」的死循环。这里拦住重写，让 retireLowValue 有机会把它收起。
    if (uses >= BehaviorEngine.MIN_EVIDENCE && cur.ok === 0)
      return `「${name}」当前版本用了 ${uses} 次一次都没成（成 ${cur.ok} 败 ${cur.fail}）：重写多半还是同一套失败，先等整理收起，或由心智显式修订；这次的经过已经记进它的成败`;
    if (uses >= BehaviorEngine.MIN_EVIDENCE) return null;
    return `「${name}」当前版本只用了 ${uses} 次（成 ${cur.ok} 败 ${cur.fail}），证据还不够，先不改写它；这次的经过已经记进它的成败，等用够 ${BehaviorEngine.MIN_EVIDENCE} 次再看要不要改`;
  }

  replaceCode(name: string, code: string, note: string, verify?: string, expectedToken?: string): { ok: true; version: number } | { ok: false; error: string } {
    const b = this.get(name, true) ?? this.get(name);
    const k = this.book?.candidate(name) ?? this.book?.get(name);
    if (!b?.code || !k || !this.book) return { ok: false, error: `${name} 不是代码技能` };
    const bad = compileCheck(code);
    if (bad) return { ok: false, error: bad };
    const codeChanged = code.trim() !== b.code.trim();
    if (codeChanged && (!verify || !verify.trim())) return { ok: false, error: '代码变了必须同时复核 verify：改进不能沿用旧判定' };
    if (verify !== undefined && verify.trim()) {
      const badVerify = compileVerify(verify);
      if (badVerify) return { ok: false, error: `verify：${badVerify}` };
    }
    const raw = { ...(k.behavior as Record<string, unknown>), code, code_file: undefined, version: undefined, ...(verify !== undefined && verify.trim() ? { verify } : {}) };
    const body = `${k.body.replace(/```behavior[\s\S]*?```/, '').trim()}`.replace(/\n*（最近一次改进：[^）]*）$/, '') + `\n\n（最近一次改进：${note.slice(0, 100)}）`;
    const w = this.write({ name, description: k.description, body, ...raw }, { by: 'improve', ...(expectedToken !== undefined ? { expectedToken } : {}) });
    if (!w.ok) return w;
    const nb = this.candidates.get(name);
    return { ok: true, version: nb?.version ?? 0 };
  }

  rollback(name: string, to: number, note: string): { ok: true; version: number } | { ok: false; error: string } {
    if (this.inactive(name)) return { ok: false, error: '停用或收起的技能不能由后台回滚重新启用' };
    const old = this.book?.definitionVersion(name, to);
    if (!old?.behavior || !this.book) return { ok: false, error: `v${to} 缺少完整技能快照，不能只退代码并沿用新契约` };
    if ((old.behavior as Record<string, unknown>).candidate === true) return { ok: false, error: `v${to} 是未启用候选；由心智选择历史版本并重新试用，不能直接回滚启用` };
    const raw = { ...old.behavior as Record<string, unknown>, name, description: old.description, body: old.body, candidate: undefined };
    const checked = validateBehavior(raw, this.adapter);
    if ('error' in checked) return { ok: false, error: checked.error };
    const w = this.book.write(name, old.description, old.body, checked.behavior, { version: this.nextVersion(name), previousVersion: this.get(name)?.version });
    if (!w.ok) return w;
    this.touch(name, (st) => { st.versionAt = Date.now(); st.swappedAt = Date.now(); });
    this.bus.publish('skill_restored', 'P2', `恢复 ${name} v${to} 的完整契约：${note}`);
    return { ok: true, version: this.get(name)?.version ?? 0 };
  }

  /** 嵌套调用也保留子技能自己的版本证据；顶层由 arbiter 的 done 事件记账。resolved 供 onDone 在回执缺版本时传入按 trial 归属的行为。 */
  /** 记一次调用；返回 true 表示这次什么都没做（no-op），调用方据此决定要不要让反射歇一会儿。 */
  recordInvocation(name: string, result: SkillResult, resolved?: Behavior, taskId?: string): boolean {
    const b = resolved ?? this.completed(name, result.data?.version);
    if (result.status === 'cancelled') { this.noteInvocation(name, resolved || result.data?.version !== undefined ? b : undefined, result); return false; }
    if (!b) return false;
    if (this.noteInvocation(name, b, result)) return true;
    // 统一目标达成未知的记账：失败才算失败、verify 通过才算成功；没写/没通过 verify 的“跑完了”只记使用、不记成败。
    const okRun = this.runOutcome(result);
    if (okRun === null) return false;
    this.record(b, okRun, result.summary, result.data ?? {}, taskId);
    return false;
  }

  /** 一次运行的成败：失败算失败，verify 通过算成功；其余是目标达成未知（只记使用）。恢复技能不看 verify。 */
  private runOutcome(result: SkillResult, recoveryRun = false): boolean | null {
    if (recoveryRun) return result.status === 'succeeded';
    if (result.status === 'failed') return false;
    return result.data?.verified === true ? true : null;
  }

  /** Count one invocation separately from delayed recovery/automatic success evidence. */
  private noteInvocation(name: string, b: Behavior | undefined, result: SkillResult) {
    const now = Date.now();
    const returned = result.data?.result;
    const skipped = result.status === 'succeeded' && !!(result.data?.noop === true || returned && typeof returned === 'object' && 'skipped' in returned && returned.skipped);
    // 产生了实际效果（或明确失败/取消）就不再算“连续空转”；下一次空转从 1 重新数。
    if (!skipped) this.idleStreak.delete(name);
    this.touch(name, (st) => {
      st.lastUsedAt = now;
      st.uses = (st.uses ?? 0) + 1;
      if (skipped) st.skipped = (st.skipped ?? 0) + 1;
      if (result.status === 'cancelled') st.cancelled = (st.cancelled ?? 0) + 1;
      if (b) {
        const usage = (st.usageByVersion ??= {})[this.versionOf(b)] ??= { uses: 0, skipped: 0, cancelled: 0 };
        usage.uses++;
        usage.lastUsedAt = now;
        if (skipped) usage.skipped++;
        if (result.status === 'cancelled') usage.cancelled++;
      }
    });
    if (b && result.status !== 'cancelled') {
      this.usage.push({ at: now, tag: `${name}@v${this.versionOf(b)}` });
      if (this.usage.length > 600) this.usage.splice(0, this.usage.length - 600);
    }
    return skipped;
  }

  private completed(name: string, version: unknown) {
    const current = [this.get(name), this.get(name, true)].find((entry) => entry && (version === undefined || this.versionOf(entry) === String(version)));
    if (current) return current;
    const old = typeof version === 'number' ? this.book?.definitionVersion(name, version) : null;
    const restored = old ? toBehavior(old, this.adapter) : null;
    return restored && !('error' in restored) ? restored : undefined;
  }

  /** 这次任务实际执行的是哪个版本：优先用回执/反射捕获的版本；执行期间没被改写才按当前 trial 归属；
   *  执行期间被改写又没捕获到版本时返回 undefined——不按完成时的 trial:true 猜当前候选。 */
  private executedRun(name: string, o: TaskOutcome, pending: { behavior: Behavior } | undefined): Behavior | undefined {
    const capturedVersion = o.result.data?.version;
    if (capturedVersion !== undefined) return this.completed(name, capturedVersion);
    const args = o.task.args as { trial?: boolean; failure?: unknown };
    const captured = pending?.behavior ?? (args.failure ? this.recoveries.get(name)?.behavior : undefined);
    if (captured) return captured;
    const changedAt = Math.max(this.stats[name]?.versionAt ?? 0, this.book?.get(name)?.updatedAt ?? 0);
    if (changedAt <= o.task.startedAt) return this.get(name, args.trial === true) ?? this.completed(name, undefined);
    return undefined;
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
    const pending = this.recoveries.get(name);
    this.recoveries.delete(name);
    if (pending?.ignored) return;
    const b = pending?.behavior ?? this.behaviors.get(name);
    if (!b) return;
    if (!worked && failure) this.recentMiss.set(`${name}|${recoverySig(failure)}`, Date.now());
    this.record(b, worked, worked ? '重做那一步成了' : '用了它之后，那一步还是没成', pending?.data ?? {});
  }

  /**
   * 恢复技能自己判断“这次跟我无关”（返回 skipped）：不算成也不算败，不算一次接手（不进拉锯统计），
   * 几分钟内同一种失败不再找它。那一步不用白白重做一遍——交给下一个对得上的技能，或者交还给心智。
   */
  recoverySkipped(name: string, failure: { skill: string; code?: string | null }, now = Date.now()) {
    const recovery = this.recoveries.get(name);
    this.recoveries.delete(name);
    if (!recovery?.invocationRecorded) this.noteInvocation(name, recovery?.behavior ?? this.get(name), {
      status: 'succeeded', summary: '恢复技能跳过本次失败', data: { result: { skipped: true } },
    });
    this.recentMiss.set(`${name}|${recoverySig(failure)}`, now);
    for (let i = this.fires.length - 1; i >= 0; i--) if (this.fires[i].name === name) { this.fires.splice(i, 1); break; }
    this.touch(name, (st) => { st.fired = Math.max(0, st.fired - 1); });
  }

  private onDone(o: TaskOutcome) {
    if (o.task.skill !== 'use_skill') return;
    const name = String((o.task.args as any)?.name ?? '');
    const aftermath = this.aftermath.get(name);
    const pending = aftermath?.taskId === o.task.id ? aftermath : undefined;
    const args = o.task.args as { trial?: boolean; failure?: unknown };
    const recovery = this.recoveries.get(name);
    // 回执带版本按版本归属；反射捕获按捕获版本；执行期间没被改写才按当前 trial 归属；
    // STUCK/TIMEOUT 常缺回执版本，执行期间又被改成新候选时只能保留未知，不按完成时的 trial:true 猜当前候选。
    const b = this.executedRun(name, o, pending);
    if (o.result.status === 'cancelled') {
      this.noteInvocation(name, b, o.result);
      if (pending) this.aftermath.delete(name);
      if (args.failure && recovery) { recovery.ignored = true; recovery.invocationRecorded = true; }
      return;
    }
    if (!b) { this.noteInvocation(name, undefined, o.result); if (pending) this.aftermath.delete(name); return; }
    this.noteUndo(name, o.task.id);
    const recoveryRun = !!args.failure && !!recovery;
    if (recoveryRun) recovery.invocationRecorded = true;
    // 成败只看“目标是否真的达成”：恢复技能由 creditRecovery 按“重做失败的那一步”定成败；
    // 普通技能只有 verify 通过（verified:true）才算成功；没写 verify 的“跑完了”是目标达成未知，只记使用、不记成败。
    const okRun = this.runOutcome(o.result, recoveryRun);
    // 公共完成路径：无论候选还是稳定版，先记下这次执行已结束（事后观测据此区分“做完后”还是“执行期间”），再分别处理候选与稳定版记账。
    if (pending && o.task.source === 'reflex') {
      pending.behavior = b;
      pending.summary = o.result.summary; pending.data = o.result.data ?? {};
      // 代码本身出错（参数、异常）才不等事后观测：马上记失败；其余保留 aftermath 供 judge 补记死亡、掉血、处境等事实。
      if (okRun === false && ['ERROR', 'BAD_ARGS'].includes(String(o.result.failureCode))) this.aftermath.delete(name);
    }
    if (b.candidate) {
      // 试用中的反射接手后什么都没做：和稳定版一样记 idle 并歇一会儿，否则冷却一过又会打断手上的事。
      if (this.recordInvocation(name, o.result, b, o.task.id) && o.task.source === 'reflex') {
        this.noteIdle(name, b, pending?.nearest, pending?.interrupted);
        if (pending) this.aftermath.delete(name);
      }
      return;
    }
    const skipped = this.noteInvocation(name, b, o.result);
    if (recoveryRun) {
      recovery.behavior = b;
      recovery.data = o.result.data;
      recovery.ignored = !okRun || o.result.data?.noop === true;
    }
    if (skipped) {
      // no-op（身体什么都没做）：不记 ok/fail；反射触发的记 idle 信号（收窄 when、歇一会儿别反复空转），非反射的只是这次没成
      if (o.task.source === 'reflex') this.noteIdle(name, b, pending?.nearest, pending?.interrupted);
      if (pending) this.aftermath.delete(name);
      if (recovery) recovery.ignored = true;
      return;
    }
    // 恢复时用的：做完了先不算成功，等重做的那一步出结果（creditRecovery）；自己就出错了才直接算失败
    if (recoveryRun && okRun) return;
    // 跑完了但没有 verify 判定：目标达成未知——只记使用与经过，不记成败（不把“运行完成”冒充成“成功证据”）。
    if (okRun === null) return;
    this.record(b, okRun, o.result.summary, (o.result.data ?? {}) as Record<string, any>, o.task.id);
  }

  /** 反射技能触发后什么都没做：记 idle（整理技能的据此收窄 when）、歇一会儿；第一次允许威胁更近或挨打时重试，连续空转则不再被同一处境唤醒 */
  private noteIdle(name: string, b: Behavior, nearest: number | undefined, interrupted?: string) {
    const now = Date.now();
    // 什么都没做的接手不算一次“来回”：否则在别的技能的地盘上让位（水下让给换气）也会被误判成拉锯
    for (let i = this.fires.length - 1; i >= 0; i--) if (this.fires[i].name === name) { this.fires.splice(i, 1); break; }
    const version = this.versionOf(b);
    const prev = this.idleStreak.get(name);
    const streak = prev?.version === version && now - prev.lastIdleAt < BehaviorEngine.IDLE_STREAK_RESET_MS ? prev.streak + 1 : 1;
    this.idleStreak.set(name, { version, streak, lastIdleAt: now });
    this.touch(name, (st) => { st.fired = Math.max(0, st.fired - 1); st.idleInterrupts = (st.idleInterrupts ?? 0) + 1; st.idleAt = now; });
    const escalated = streak >= BehaviorEngine.IDLE_STREAK_ESCALATE;
    this.holds.set(name, { until: now + BehaviorEngine.HOLD_MS, why: escalated ? `连续 ${streak} 次空转` : '条件成立接手后什么都没做就返回', version, ...(escalated ? {} : { closer: Number.isFinite(nearest) ? nearest : Infinity }) });
    this.bus.publish('instinct_idle', 'P3', `技能「${name}」接手后什么都没做就返回${interrupted ? `（打断了「${interrupted}」）` : ''}，连续第 ${streak} 次；先歇 ${BehaviorEngine.HOLD_MS / 1000} 秒${escalated ? '，暂停期间不再因为威胁靠近或挨打就立刻重试' : '（怪更近或挨打时照常接手）'}；它的 when 或执行可能对不上当前处境`, { name, ...(interrupted ? { interrupted } : {}), streak, escalated, times: this.stats[name]?.idleInterrupts });
  }

  /** 自动技能的事后观测：12 秒后（或死亡时）补记事实——死了、又掉多少血、触发处境是否还在。
   *  成败已在 onDone 按执行结果（含声明判定 verify）记下，这里不再用“没死、掉血少、处境解除”替技能目标定成败，
   *  也不把后来的死亡、掉血自动归因成这项技能的失败。事实单独报给心智与整理，归因由 Agent 决定。 */
  private judge(name: string, died: boolean) {
    const a = this.aftermath.get(name);
    this.aftermath.delete(name);
    if (!a) return;
    const b = a.behavior;
    const version = b.version ?? this.stats[b.name]?.rev ?? 1;
    const hp = this.adapter.state().hp;
    const lost = Math.max(0, a.hp - hp);
    const situation = b.when ? situationOf(b.when) : null;
    // 三态：true 触发处境还在；false 确认解除；null 判断不了（死了、没有处境可查、或读世界失败）——不能误说成“解除了”。
    let still: boolean | null = null;
    if (!died && situation) { try { still = evalPredicate(situation, this.sense(null)); } catch { still = null; } }
    // 观测区间是「触发到判断」：净掉血是触发以来的，不是“做完后”；死亡按是否已完成区分执行阶段。
    const completed = a.summary !== undefined;
    const facts = [
      died ? (completed ? '做完后不久就死了' : '执行期间就死了') : '',
      lost >= 1 ? `从触发到现在净掉了 ${Math.round(lost)} 点血` : '',
      still === true ? '触发它的情况还在' : still === false ? '触发它的情况解除了' : '',
    ].filter(Boolean).join('；');
    const context = a.context ? `；触发时：${a.context}` : '';
    this.bus.publish('skill_aftermath', 'P3', `技能「${name}」v${version} 事后观测：${facts}${a.summary ? `（它做了：${a.summary.slice(0, 80)}）` : ''}${context}`,
      { name, version, taskId: a.taskId, died, lost: Math.round(lost), still, context: a.context });
  }

  private record(b: Behavior, okRun: boolean, summary: string, data: Record<string, any>, taskId?: string) {
    const name = b.name;
    const currentStable = this.get(name);
    const isCurrentStable = !b.candidate && !currentStable?.candidate && currentStable?.version === b.version;
    // 稳定版被替换时的完整快照构成启用沿革；被覆盖候选不能充当上一稳定版。
    const previousStable = b.code && isCurrentStable ? this.book?.versions(name).filter((entry) => entry.definition && entry.version < (b.version ?? 1))
      .reverse().find((entry) => {
        const saved = this.book?.definitionVersion(name, entry.version);
        return saved?.behavior && (saved.behavior as Record<string, unknown>).candidate !== true;
      })?.version : undefined;
    let rollback: { from: number; to: number } | null = null;
    let dim = 'unknown';
    try { dim = this.adapter.state().dim; } catch { /* 状态暂不可用 */ }
    const v = this.versionOf(b);
    const entry: RunRecord = { at: Date.now(), ok: okRun, version: Number(v), summary: summary.slice(0, 200),
      ...(typeof data.line === 'number' ? { line: data.line } : {}), ...(Array.isArray(data.trace) ? { trace: data.trace.slice(-12) } : {}),
      ...(Array.isArray(data.logs) ? { logs: data.logs.slice(-6) } : {}), ...(data.args ? { args: String(data.args).slice(0, 200) } : {}) };
    this.touch(name, (st) => {
      if (!st.byVersion) st.byVersion = currentStable && !currentStable.candidate
        ? { [this.versionOf(currentStable)]: { ok: st.ok, fail: st.fail } } : {};
      if (okRun) st.ok++; else { st.fail++; st.lastError = summary.slice(0, 120); }
      const pd = (st.byDim ??= {})[dim] ??= { ok: 0, fail: 0 };
      if (okRun) pd.ok++; else pd.fail++;
      const per = (st.byVersion ??= {})[v] ??= { ok: 0, fail: 0 };
      if (okRun) per.ok++; else per.fail++;
      st.recent = [...(st.recent ?? []), entry].slice(-6);
      if (b.code && isCurrentStable) {
        // 新版本跑了几次明显比上一版差：退回上一版（真人改坏了也会改回去）
        const prev = previousStable === undefined ? undefined : st.byVersion[String(previousStable)];
        const rate = (x: { ok: number; fail: number }) => x.ok / Math.max(1, x.ok + x.fail);
        // 两个版本都要跑够几次才比（以前凭“3 成 0 败”就当标杆，来回退了十几次）
        if (prev && previousStable !== undefined && prev.ok + prev.fail >= BehaviorEngine.MIN_EVIDENCE && per.ok + per.fail >= BehaviorEngine.MIN_EVIDENCE + 1 && rate(per) < rate(prev) - 0.25) rollback = { from: b.version ?? 1, to: previousStable };
      }
      // 自己写的技能，当前版本用了几次大多失败：先停用，让心智回头改（同名重写即可）
      if (isCurrentStable && b.source === 'self' && per.ok + per.fail >= 4 && per.ok / (per.ok + per.fail) < 0.25 && !st.disabled) {
        st.disabled = true;
        st.disabledAt = Date.now();
        delete st.candidatePermit;
        this.bus.publish('skill_disabled', 'P1', `技能「${name}」这一版用了 ${per.ok + per.fail} 次只成了 ${per.ok} 次，先停用；最近一次：${st.lastError ?? ''}`, { name, by: 'stats' });
      }
    });
    // 同一个 done 事件里，心智还可能判定调用方的收工条件没有达成。先记下这次成功的身份，
    // 让 callerUnmet 能精确降级这一条，而不是按“同名技能最近一次”去猜。
    if (okRun && taskId) this.lastCredit = { name, version: v, dim, taskId, entry };
    if (b.candidate) {
      // 晋级判定延后一个微任务：同一个 done 事件里，心智还会用调用方的收工条件复核这次成功（callerUnmet）。
      // 先让它把假成功降级，再按降级后的 per.ok/per.fail 决定是否真的够格晋级。
      queueMicrotask(() => this.considerPromotion(name, b, currentStable?.version));
      if (!okRun && b.code && this.get(name, true)?.version === b.version) this.improve?.(name, 'failures');
      return;
    }
    if (rollback) {
      const { from, to } = rollback as { from: number; to: number };
      const r = this.rollback(name, to, `v${from} 比 v${to} 差`);
      if (r?.ok) this.bus.publish('skill_rollback', 'P2', `代码技能「${name}」的 v${from} 不如 v${to}，退回旧代码（现在是 v${r.version}）`, { name, from, to });
    } else if (b.code && !okRun && isCurrentStable) this.improve?.(name, 'failures');
  }

  /** 候选晋级：延后到微任务再看账本，留出同一 done 事件里调用方否决这次成功（callerUnmet）的时机。 */
  private considerPromotion(name: string, b: Behavior, stableVersion?: number) {
    const per = this.stats[name]?.byVersion?.[this.versionOf(b)];
    if (this.executionError(name, true) || this.candidates.get(name)?.version !== b.version || !per
      || per.ok < BehaviorEngine.MIN_EVIDENCE || per.ok < per.fail * 2 || !this.book?.promote(name, stableVersion)) return;
    this.touch(name, (st) => { st.disabled = false; delete st.retired; delete st.retiredAt; delete st.disabledAt; delete st.candidatePermit; delete st.lastError; delete st.advisory; });
    this.bus.publish('skill_promoted', 'P2', `候选技能 ${name} v${b.version} 已通过 ${per.ok} 次实际验收，启用其原定模式`, { name, version: b.version });
  }

  /**
   * 调用方判定这次调用没有达成目标：技能自述做完了、自己声明的 verify 也过了，但它所在的活动的收工条件明确未满足
   * （例如只浮到水面、没有站上干地）。把刚记下的这一次成功降级成失败——执行完毕不等于调用方要的结果。
   * 只认同一技能、同一 arbiter 任务、且是最近一次记成成功的那一条；taskId 不匹配（别的运行、别的技能）时不动账。
   * 停用/回退/候选晋级等启发式不在这里重算，避免对这次降级凭空追加别的判断。
   */
  callerUnmet(name: string, taskId: string, reason: string): boolean {
    const credit = this.lastCredit;
    if (!credit || credit.name !== name || credit.taskId !== taskId) return false;
    this.lastCredit = null;
    const why = reason.slice(0, 120);
    this.touch(name, (st) => {
      st.ok = Math.max(0, st.ok - 1);
      st.fail++;
      st.lastError = why;
      const per = (st.byVersion ??= {})[credit.version];
      if (per) { per.ok = Math.max(0, per.ok - 1); per.fail++; }
      const pd = (st.byDim ??= {})[credit.dim];
      if (pd) { pd.ok = Math.max(0, pd.ok - 1); pd.fail++; }
      // 原地改判最近这条运行记录：保留时间与过程证据（trace/logs/args），只把成败和原因改过来。
      credit.entry.ok = false;
      credit.entry.callerUnmet = true;
      credit.entry.summary = reason.slice(0, 200);
    });
    return true;
  }

  /** 做完的事过一会儿被自己打破（比如扔掉的东西又捡回来）：那一次“成功”其实是假阳性，记成一次失败，让停用/整理按真实成败来 */
  noteBroken(name: string, summary: string) {
    const b = this.behaviors.get(name);
    if (!b || b.candidate) return;
    this.touch(name, (st) => {
      st.fail++;
      st.lastError = summary.slice(0, 120);
      const per = (st.byVersion ??= {})[this.versionOf(b)] ??= { ok: 0, fail: 0 };
      per.fail++;
    });
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
      const candidateRetired = b.candidate ? this.candidateRetirement(b.name) : undefined;
      const retired = st?.retired ?? candidateRetired?.why;
      if (!retired) { active.push(line); return; }
      const score = tombstoneRelevance(b, text, focus);
      if (score >= 2) {
        const tag = idleRetirement(retired) && !this.tombstone(b.name) ? '；不是做不好，只是当时用不上，这次需要由心智显式修订' : '';
        scored.push({ line: line + tag, score, at: st?.retiredAt ?? candidateRetired?.at ?? 0 });
      }
    });
    const picked = scored.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, maxRetired);
    const retired = names.filter((n) => this.stats[n]?.retired || this.get(n)?.candidate && this.candidateRetirement(n)).length;
    const rest = retired - picked.length;
    return [...active, ...picked.map((x) => x.line), ...all.slice(names.length),
      ...(rest > 0 ? [`另有 ${rest} 份已收起的技能和这次的事不沾边，没列出`] : [])];
  }
  static FORGE_TOMBSTONES = 8;

  /** 给模型看的一览（技能书索引之外，带成败和停用状态） */
  overview(): string[] {
    refreshInstincts();
    let dim = '';
    try { dim = this.adapter.state().dim; } catch { /* 状态暂不可用 */ }
    return [...this.list().map((b) => {
      const st = this.stats[b.name];
      const here = st?.byDim?.[dim];
      const untested = st && st.ok + st.fail > 0 && st.byDim && !here && !(b.when?.dim && !b.when.dim.includes(dim)) ? `（在 ${dim} 还没用过）` : '';
      const candidate = this.candidates.get(b.name);
      const retiredCandidate = this.candidateRetirement(b.name);
      const trial = retiredCandidate ? `；候选 v${retiredCandidate.version} 已收起（${retiredCandidate.why}），可查历史，显式修订后再试`
        : candidate ? `；候选 v${candidate.version} 尚未启用，用 use_skill {name:"${b.name}",trial:true} 试用，试用成${this.currentStats(b.name, true).ok}/败${this.currentStats(b.name, true).fail}` : '';
      const successful = this.successfulEmergencyVersions(b.name);
      const history = successful.length ? `；保留成功过的应急版本 ${successful.slice(0, 4).map((entry) => `v${entry.version}（成${entry.ok}/败${entry.fail}）`).join('、')}，可查技能历史，由心智用 from_version 选为新候选再试` : '';
      return `${b.name}［${b.mode === 'auto' ? '自动' : b.mode === 'recover' ? '失败时先试' : '调用'}${b.code ? `，代码 v${b.version ?? 1}` : ''}${b.overrides.length ? `，代替本能 ${b.overrides.map((o) => INSTINCTS[o]?.off ? `${o}（这条本能本来就没开）` : o).join('/')}` : ''}${b.needs ? `，调用时给 args.${Object.keys(b.needs).join('/')}` : ''}］${st && st.ok + st.fail ? ` 成${st.ok}/败${st.fail}` : ''}${st?.retired ? ` 已收起（${st.retired.slice(0, 30)}）` : st?.disabled ? ' 已停用' : ''}${st?.advisory ? ` 拉锯后只提醒不自动接手（${st.advisory.why.slice(0, 24)}）` : ''}${untested}${trial}${history}`;
    }), ...[...this.invalid].map(([n, why]) => `${n}：${why}`),
      ...[...this.invalidCandidates].map(([n, why]) => `${n}：候选未通过校验：${why}`)];
  }
}

/** 只是因为数量上限、太久没用上而收起的（不是做不好） */
export function idleRetirement(why: string): boolean { return /^技能太多|小时没用上|个有效游戏日没用上|一次都没用上/.test(why); }

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
