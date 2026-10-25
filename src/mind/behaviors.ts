import fs from 'node:fs';
import path from 'node:path';
import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, TaskInfo, TaskOutcome } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import { normalizeSkillName, type KnowSkill, type SkillBook, type SkillMode } from '../knowledge/skillbook.ts';
import { normalizeStep } from '../planner/plan.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import type { Senses } from '../skills/types.ts';
import { compileCheck, MAX_CODE } from '../codeskills/sandbox.ts';
import { evalPredicate, isRecovery, senseNow, validatePredicate, type Predicate, type Sense } from './predicate.ts';

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
  /** use_skill 调用时必须给的参数：名字 → 说明（恢复时由失败的那一步提供，不检查） */
  needs?: Record<string, string>;
}
export interface RunRecord { at: number; ok: boolean; version?: number; summary: string; line?: number; trace?: string[]; logs?: string[]; args?: string }
export interface BehaviorStats {
  fired: number; ok: number; fail: number; lastAt: number; disabled?: boolean; lastError?: string;
  /** 代码技能：每个版本各自的成败，和最近几次运行的记录（给改进用） */
  byVersion?: Record<string, { ok: number; fail: number }>;
  recent?: RunRecord[];
}
/** 代码技能某次失败后，看看要不要在后台改进（改进器自己限频） */
export type ImproveHook = (name: string, why: 'failures' | 'requested', note?: string) => void;

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
    ...(b.code ? { code: b.code, version } : {}), ...(b.args ? { needs: b.args } : {}) };
}

export class BehaviorEngine {
  private behaviors = new Map<string, Behavior>();
  private stats: Record<string, BehaviorStats> = {};
  private lastFired = new Map<string, number>();
  private invalid = new Map<string, string>();
  private doneListener = (o: TaskOutcome) => this.onDone(o);
  /** 代码技能失败或心智要求改进时调用（main 接到后台改进器） */
  improve: ImproveHook | null = null;

  constructor(private book: SkillBook | null, private adapter: GameAdapter, private arbiter: Pick<Arbiter, 'start' | 'info' | 'on' | 'off'> | null,
    private bus: EventBus, private senses: Pick<Senses, 'perceivedEntities'>, private statsFile: string | null = null) {
    if (statsFile && fs.existsSync(statsFile)) { try { this.stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')) ?? {}; } catch { this.stats = {}; } }
    book?.onChange(() => this.reload());
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
    return senseNow(this.adapter, this.senses, cur && cur.source !== 'filler' ? cur.skill : null, failure);
  }

  private running(cur: TaskInfo | null): Behavior | undefined {
    return cur?.skill === 'use_skill' ? this.behaviors.get(String((cur.args as any)?.name ?? '')) : undefined;
  }

  /** 自动技能：条件成立就由身体去做（返回 true 表示这一拍已经接手） */
  tick(cur: TaskInfo | null, now = Date.now()): boolean {
    if (!this.arbiter) return false;
    const auto = this.list().filter((b) => b.mode === 'auto' && this.enabled(b));
    if (!auto.length) return false;
    const running = this.running(cur);
    // 天生的躲闪正在进行（逃跑、上浮）时，只有更要紧的技能才插手
    const floor = running ? running.priority : cur?.source === 'reflex' ? 60 : 0;
    let s: Sense | null = null;
    for (const b of auto) {
      if (b.priority <= floor || running?.name === b.name) continue;
      if (now - (this.lastFired.get(b.name) ?? 0) < b.cooldownMs) continue;
      s ??= this.sense(cur);
      if (!evalPredicate(b.when!, s)) continue;
      const r = this.arbiter.start({ skill: 'use_skill', args: { name: b.name } }, 'reflex');
      if ('error' in r) { this.lastFired.set(b.name, now); continue; }
      this.lastFired.set(b.name, now);
      this.touch(b.name, (st) => { st.fired++; st.lastAt = now; });
      this.bus.publish('instinct', 'P2', `技能「${b.name}」的条件成立，身体照着做：${b.description}`, { name: b.name, source: b.source });
      return true;
    }
    return false;
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

  /** 恢复类技能：某个动作失败时，身体先试哪一套（同一段活里每套只试一次） */
  recoveryFor(failure: { skill: string; code?: string }, tried: Set<string> = new Set(), now = Date.now()): Behavior | null {
    const rec = this.list().filter((b) => b.mode === 'recover' && this.enabled(b) && !tried.has(b.name) && now - (this.lastFired.get(b.name) ?? 0) >= Math.min(b.cooldownMs, 5000));
    if (!rec.length) return null;
    const s = this.sense(this.arbiter?.info() ?? null, failure);
    const hit = rec.find((b) => evalPredicate(b.when!, s));
    if (!hit) return null;
    this.lastFired.set(hit.name, now);
    this.touch(hit.name, (st) => { st.fired++; st.lastAt = now; });
    this.bus.publish('instinct', 'P2', `${failure.skill} 没成（${failure.code ?? '失败'}），身体先照技能「${hit.name}」试试：${hit.description}`, { name: hit.name, recover: true });
    return hit;
  }

  /**
   * 模型在思考里写下的技能：校验后写进技能书，立刻生效（技能书变更会触发 reload）。
   * {"name":…,"disable":true} 停用；同名再写一次就是修订并重新启用。
   */
  write(raw: unknown): { ok: true; name: string; created: boolean; mode: SkillMode; disabled?: boolean; improving?: boolean } | { ok: false; error: string } {
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
      this.touch(v.name, (st) => { st.disabled = true; });
      this.bus.publish('skill_disabled', 'P2', `停用了技能 ${v.name}`, { name: v.name, by: 'mind' });
      return { ok: true, name: v.name, created: false, mode: this.behaviors.get(v.name)?.mode ?? 'manual', disabled: true };
    }
    if (!this.book) return { ok: false, error: '没有技能书，存不下技能' };
    const w = this.book.write(v.name, v.description, v.body, v.behavior);
    if (!w.ok) return w;
    if (!this.behaviors.has(w.skill.name)) this.reload();
    const b = this.behaviors.get(w.skill.name);
    if (!b) return { ok: false, error: '技能写下了，但格式不对没有生效' };
    // 修订就是重新给它一次机会
    this.touch(b.name, (st) => { st.disabled = false; st.ok = 0; st.fail = 0; delete st.lastError; });
    return { ok: true, name: b.name, created: w.created, mode: b.mode };
  }

  /**
   * 换上一份代码技能的新版本（后台改进的结果，或者退回旧版本）：先校验能编译，再写进技能书，立刻生效。
   * 统计按版本分开记，用来判断新版本是不是真的更好。
   */
  replaceCode(name: string, code: string, note: string): { ok: true; version: number } | { ok: false; error: string } {
    const b = this.behaviors.get(name);
    const k = this.book?.get(name);
    if (!b?.code || !k || !this.book) return { ok: false, error: `${name} 不是代码技能` };
    const bad = compileCheck(code);
    if (bad) return { ok: false, error: bad };
    const raw = { ...(k.behavior as Record<string, unknown>), code, code_file: undefined, version: undefined };
    const body = `${k.body.replace(/```behavior[\s\S]*?```/, '').trim()}`.replace(/\n*（最近一次改进：[^）]*）$/, '') + `\n\n（最近一次改进：${note.slice(0, 100)}）`;
    const w = this.book.write(name, k.description, body, raw);
    if (!w.ok) return w;
    const nb = this.behaviors.get(name);
    this.touch(name, (st) => { st.disabled = false; delete st.lastError; });
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
  creditRecovery(name: string, worked: boolean) {
    const b = this.behaviors.get(name);
    if (!b) return;
    this.record(b, worked, worked ? '重做那一步成了' : '用了它之后，那一步还是没成', {});
  }

  private onDone(o: TaskOutcome) {
    if (o.task.skill !== 'use_skill' || o.result.status === 'cancelled') return;
    const name = String((o.task.args as any)?.name ?? '');
    const b = this.behaviors.get(name);
    if (!b) return;
    const okRun = o.result.status === 'succeeded';
    // 恢复时用的：做完了先不算成功，等重做的那一步出结果（creditRecovery）；自己就出错了才直接算失败
    if ((o.task.args as any)?.failure && okRun) return;
    this.record(b, okRun, o.result.summary, (o.result.data ?? {}) as Record<string, any>);
  }

  private record(b: Behavior, okRun: boolean, summary: string, data: Record<string, any>) {
    const name = b.name;
    let rollback: { from: number; to: number } | null = null;
    this.touch(name, (st) => {
      if (okRun) st.ok++; else { st.fail++; st.lastError = summary.slice(0, 120); }
      if (b.code) {
        const v = String(b.version ?? 1);
        const per = (st.byVersion ??= {})[v] ??= { ok: 0, fail: 0 };
        if (okRun) per.ok++; else per.fail++;
        st.recent = [...(st.recent ?? []), { at: Date.now(), ok: okRun, version: b.version, summary: summary.slice(0, 200),
          ...(typeof data.line === 'number' ? { line: data.line } : {}), ...(Array.isArray(data.trace) ? { trace: data.trace.slice(-12) } : {}),
          ...(Array.isArray(data.logs) ? { logs: data.logs.slice(-6) } : {}), ...(data.args ? { args: String(data.args).slice(0, 200) } : {}) }].slice(-6);
        // 新版本跑了几次明显比上一版差：退回上一版（真人改坏了也会改回去）
        const prev = st.byVersion[String((b.version ?? 1) - 1)];
        const rate = (x: { ok: number; fail: number }) => x.ok / Math.max(1, x.ok + x.fail);
        if (prev && prev.ok + prev.fail >= 2 && per.ok + per.fail >= 3 && rate(per) < rate(prev) - 0.25) rollback = { from: b.version ?? 1, to: (b.version ?? 1) - 1 };
      }
      // 自己写的技能用了几次大多失败：先停用，让心智回头改（同名重写即可）
      if (b.source === 'self' && st.ok + st.fail >= 4 && st.ok / (st.ok + st.fail) < 0.25 && !st.disabled) {
        st.disabled = true;
        this.bus.publish('skill_disabled', 'P1', `技能「${name}」用了 ${st.ok + st.fail} 次只成了 ${st.ok} 次，先停用；最近一次：${st.lastError ?? ''}`, { name, by: 'stats' });
      }
    });
    if (rollback) {
      const { from, to } = rollback as { from: number; to: number };
      const old = this.book?.codeVersion(name, to);
      const r = old ? this.replaceCode(name, old, `v${from} 比 v${to} 差，退回 v${to} 的代码`) : null;
      if (r?.ok) this.bus.publish('skill_rollback', 'P2', `代码技能「${name}」的 v${from} 不如 v${to}，退回旧代码（现在是 v${r.version}）`, { name, from, to });
    } else if (b.code && !okRun) this.improve?.(name, 'failures');
  }

  /** 给模型看的一览（技能书索引之外，带成败和停用状态） */
  overview(): string[] {
    return [...this.list().map((b) => {
      const st = this.stats[b.name];
      return `${b.name}［${b.mode === 'auto' ? '自动' : b.mode === 'recover' ? '失败时先试' : '调用'}${b.code ? `，代码 v${b.version ?? 1}` : ''}${b.overrides.length ? `，代替本能 ${b.overrides.join('/')}` : ''}${b.needs ? `，调用时给 args.${Object.keys(b.needs).join('/')}` : ''}］${st && st.ok + st.fail ? ` 成${st.ok}/败${st.fail}` : ''}${st?.disabled ? ' 已停用' : ''}`;
    }), ...[...this.invalid].map(([n, why]) => `${n}：${why}`)];
  }
}
