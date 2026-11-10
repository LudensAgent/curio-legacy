import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { evaluateCondition, observeCondition, observationReady, validateCondition } from '../projects/conditions.ts';
import type { Condition, EvidenceStatus } from '../projects/types.ts';
import { SKILLS } from '../skills/index.ts';
import { fail, isAbort, ok, type Skill, type SkillCtx, type SkillResult } from '../skills/types.ts';
import { shortId, throwIfAborted } from '../util.ts';
import { SMELTABLE } from '../skills/economy.ts';
import { bindParameters, executeProgram, substitute, validateParameters, validateProgram, type Parameters, type Program } from './program.ts';

export interface AbilityGap {
  id: string;
  description: string;
  worldId: string;
  dimension: string;
  intentId?: string;
  projectId?: string;
  missingPrimitive?: string;
  status: 'open' | 'resolved';
  ts: number;
}
export interface MethodTrial {
  id: string;
  ts: number;
  worldId: string;
  dimension: string;
  sessionId: string;
  observationId: number | string;
  contextKey: string;
  parameters: Record<string, string | number>;
  before: unknown;
  after: unknown;
  expected?: unknown;
  beforeStatus?: EvidenceStatus;
  afterStatus?: EvidenceStatus;
  executionStatus?: SkillResult['status'];
  failureCode?: string;
  status: 'verified' | 'failed' | 'uninformative';
  reason: string;
  source: 'adapter.state' | 'adapter.state+vision';
}
export interface MethodDefinition {
  name: string;
  description: string;
  /** Model claims remain hypotheses even when a particular program has passed its tests. */
  question?: string;
  hypothesis?: string;
  version: number;
  parameters: Parameters;
  program: Program;
  postcondition: unknown;
  status: 'candidate' | 'verified' | 'retired';
  createdAt: number;
  trials: MethodTrial[];
  scope: { intentId?: string; projectId?: string; worldId?: string; dimension?: string };
}

export type ResearchOutcome = 'supported' | 'counterexample' | 'unknown';
export interface ResearchEvidence {
  trialId: string;
  version: number;
  hypothesis?: string;
  outcome: ResearchOutcome;
  at: number;
  worldId: string;
  dimension: string;
  source: MethodTrial['source'];
  parameters: unknown;
  expected: unknown;
  before: unknown;
  actual: unknown;
  reason: string;
  failureCode?: string;
}
export interface ResearchQuestion {
  name: string;
  version: number;
  question?: string;
  hypothesis?: string;
  prediction: unknown;
  methodStatus: MethodDefinition['status'];
  outcomes: Record<ResearchOutcome, number>;
  recentEvidence: ResearchEvidence[];
  truncated?: boolean;
}
export interface ResearchContext {
  source: 'method_trials';
  claims: 'model_hypotheses';
  evidence: 'historical_not_current_state';
  questions: ResearchQuestion[];
}

function researchOutcome(trial: MethodTrial): ResearchOutcome {
  if (trial.status === 'verified') return 'supported';
  // A broken action or an unobserved result does not refute a mechanism.
  return trial.executionStatus === 'succeeded' && trial.beforeStatus === 'unsatisfied' && trial.afterStatus === 'unsatisfied'
    ? 'counterexample' : 'unknown';
}

/** Keep evidence readable and explicitly mark omissions instead of silently dropping arbitrary fields. */
function researchFact(value: unknown, maxBytes = 600): unknown {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return structuredClone(value ?? null);
  let preview = json.slice(0, maxBytes);
  while (Buffer.byteLength(preview, 'utf8') > maxBytes - 100) preview = preview.slice(0, Math.floor(preview.length * .8));
  return { truncated: true, preview, details: 'method_catalog' };
}

/** 采集某种方块后背包里会多出的物品（别名与常见掉落物）；拿不准的（log 可能是任何树种）返回 null */
const GATHER_DROPS: Record<string, string> = {
  stone: 'cobblestone', cobblestone: 'cobblestone', coal: 'coal', coal_ore: 'coal', deepslate_coal_ore: 'coal',
  iron: 'raw_iron', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', copper: 'raw_copper', copper_ore: 'raw_copper',
  gold: 'raw_gold', gold_ore: 'raw_gold', diamond: 'diamond', diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  redstone: 'redstone', redstone_ore: 'redstone', lapis: 'lapis_lazuli', lapis_ore: 'lapis_lazuli', emerald_ore: 'emerald',
  grass_block: 'dirt', dirt: 'dirt', sand: 'sand', gravel: 'gravel', clay: 'clay_ball', deepslate: 'cobbled_deepslate',
  oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log', jungle_log: 'jungle_log', acacia_log: 'acacia_log',
  dark_oak_log: 'dark_oak_log', mangrove_log: 'mangrove_log', cherry_log: 'cherry_log',
};

export interface SimpleStep { skill: string; args?: unknown }

/**
 * 从一串步骤推导一个可观测的验收条件（不信任“技能成功”的文字）：
 * 最后一个合成/采集/冶炼步骤 → 背包里至少有那件东西；去往已知地标/当前位置 → 到了那附近。
 * 推不出来就返回 null（调用方退回为普通组合技能）。
 */
export function derivePostcondition(steps: SimpleStep[], adapter: Pick<GameAdapter, 'isKnownItem' | 'state'>, memory: WorldMemory): Record<string, unknown> | null {
  const state = adapter.state();
  for (const st of [...steps].reverse()) {
    const a = (st.args && typeof st.args === 'object' ? st.args : {}) as Record<string, unknown>;
    const n = (v: unknown, d: number) => Number.isInteger(v) && (v as number) >= 1 ? Math.min(64, v as number) : d;
    let item: string | null = null, count = 1;
    if (st.skill === 'craft' && typeof a.item === 'string') { item = a.item; count = n(a.count, 1); }
    else if (st.skill === 'smelt' && typeof a.item === 'string') { item = SMELTABLE[a.item] ?? null; count = 1; }
    else if (st.skill === 'gather' && typeof a.block === 'string') {
      item = GATHER_DROPS[a.block] ?? (/(_ore|^log|^wood|^logs)$/.test(a.block) ? null : a.block);
      // 写了 for 时采多少由缺口决定，只要求至少拿到 1 个
      count = a.for ? 1 : n(a.count, 1);
    } else if (['plan_route', 'navigate_to', 'advance', 'boat_path'].includes(st.skill)) {
      const target = String(a.target ?? a.to ?? '').trim();
      if (!target) continue;
      const lm = memory.findLandmark(target, state.dim);
      if (lm && lm.kind !== 'resource') return { type: 'location_near', dimension: lm.dim, pos: { ...lm.pos }, radius: 4, landmarkId: lm.id };
      continue;
    } else continue;
    // 相对条件：试验开始时背包里已有多少不重要，要求“又多了 count 个”，这样已经有这件东西时试验也有意义
    if (item && adapter.isKnownItem(item)) return { type: 'inventory_gain', item, count };
  }
  return null;
}

/**
 * 把相对的 inventory_gain {item,count} 按某一刻的真实背包换成绝对的 inventory_min（当时数量 + count）。
 * 方法每次试验/执行都在开始时绑定一次，验收仍然只用受支持的事实条件。
 */
export function bindRelative(cond: unknown, state: Pick<AgentState, 'inventory'>, depth = 0): unknown {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond) || depth > 4) return cond;
  const c = cond as Record<string, any>;
  if (c.type === 'inventory_gain') {
    const held = (state.inventory ?? []).filter((i) => i.name === c.item).reduce((n, i) => n + i.count, 0);
    const gain = Number.isInteger(c.count) && c.count >= 1 ? Math.min(2304, c.count) : 1;
    return { type: 'inventory_min', item: c.item, count: Math.min(2304, held + gain) };
  }
  if ((c.type === 'all_of' || c.type === 'any_of') && Array.isArray(c.conditions)) return { ...c, conditions: c.conditions.map((x: unknown) => bindRelative(x, state, depth + 1)) };
  return cond;
}

/** 合法的方法名：小写字母开头，3–32 位，不与已有技能重名 */
export function methodName(raw: unknown, fallback = 'learned'): string {
  let name = String(raw ?? '').trim().toLowerCase().replace(/^(macro|trial|method):/, '').replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!/^[a-z]/.test(name)) name = `m_${name || fallback}`;
  name = name.slice(0, 32).replace(/_$/, '');
  if (name.length < 3) name = `${name}_m`.slice(0, 32);
  return SKILLS[name] ? `my_${name}`.slice(0, 32) : name;
}

/**
 * 简单格式 {name, description, steps:[{skill,args}]} → 方法库候选（顺序程序 + 自动推导的验收条件）。
 * 已经是完整格式（带 program）的原样返回；显式组合默认可退回 macro，自动习惯可用 allowMacro=false 要求事实验收。
 */
export function simpleToMethod(raw: unknown, adapter: Pick<GameAdapter, 'isKnownItem' | 'state'>, memory: WorldMemory, options: { allowMacro?: boolean } = {}):
  { kind: 'method'; method: Record<string, unknown> } | { kind: 'macro'; macro: { name: string; description: string; steps: SimpleStep[] } } | { kind: 'invalid'; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', error: 'learn_skill 须为对象' };
  const o = raw as Record<string, any>;
  if (o.program) return { kind: 'method', method: o };
  if (!Array.isArray(o.steps) || !o.steps.length) return { kind: 'invalid', error: 'learn_skill 需要 steps 或 program' };
  const steps: SimpleStep[] = o.steps.slice(0, 12).map((st: any) => {
    // 和计划一样容忍参数平铺在步骤上
    if (!st || typeof st !== 'object') return { skill: String(st ?? '') };
    const { skill, args, ...rest } = st;
    return { skill: String(skill ?? ''), args: args && typeof args === 'object' && Object.keys(args).length ? args : Object.keys(rest).length ? rest : args ?? {} };
  });
  const name = methodName(o.name);
  const description = String(o.description ?? '').trim().slice(0, 200) || steps.map((st) => st.skill).join(' → ');
  const postcondition = derivePostcondition(steps, adapter, memory);
  if (!postcondition) return options.allowMacro === false
    ? { kind: 'invalid', error: '自动习惯缺少可观测的验收条件，不能把执行成功直接记成已掌握的宏' }
    : { kind: 'macro', macro: { name, description, steps } };
  return { kind: 'method', method: { name, description, ...(o.question !== undefined ? { question: o.question } : {}),
    ...(o.hypothesis !== undefined ? { hypothesis: o.hypothesis } : {}),
    program: { type: 'sequence', steps: steps.map((st) => ({ type: 'call', skill: st.skill, args: st.args ?? {} })) }, postcondition } };
}

/** 把方法程序展开成线性步骤（用于和习惯候选的签名比对） */
export function flattenProgram(program: Program): SimpleStep[] {
  if (program.type === 'call') return [{ skill: program.skill, args: program.args }];
  if (program.type === 'sequence') return program.steps.flatMap(flattenProgram);
  if (program.type === 'repeat') return flattenProgram(program.body);
  return [...flattenProgram(program.then), ...(program.else ? flattenProgram(program.else) : [])];
}

/** Candidates remain visibly unverified until isolated executions establish their postcondition. */
export class MethodLibrary {
  private definitions: MethodDefinition[] = [];
  private gaps: AbilityGap[] = [];
  private installed = new Map<string, Skill>();
  private trialWorldIds: Set<string>;

  constructor(private file: string | null, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, options: { trialWorldIds?: string[] } = {}) {
    this.trialWorldIds = new Set(options.trialWorldIds ?? []);
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.gaps = Array.isArray(saved.gaps) ? saved.gaps.slice(-100) : [];
        for (const raw of (Array.isArray(saved.methods) ? saved.methods : []).slice(-100)) {
          const validated = this.prepare(raw);
          // Earlier experience mining attached old inventory gains to a different
          // extracted program. Those synthetic trials never executed this version.
          const trials = Array.isArray(raw.trials) ? raw.trials.slice(-20).filter((trial: MethodTrial) => trial.sessionId !== 'observed' && trial.observationId !== 'observed') : [];
          const status = raw.status === 'retired' ? 'retired' : raw.status === 'verified' && this.hasProof(trials) ? 'verified' : 'candidate';
          const definition: MethodDefinition = { ...validated, version: raw.version, createdAt: raw.createdAt, trials, status, scope: raw.scope ?? {} };
          this.definitions.push(definition);
          if (status !== 'retired') this.install(definition);
        }
      } catch { /* Keep the source file intact; invalid saved programs never become executable. */ }
    }
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, methods: this.definitions, gaps: this.gaps }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  list(): MethodDefinition[] { return structuredClone(this.definitions); }
  abilityGaps(): AbilityGap[] { return structuredClone(this.gaps.filter((g) => g.worldId === this.memory.worldId)); }

  /** Carry self-chosen questions forward without relying on another explicit catalog query. */
  researchContext(options: { limit?: number; maxBytes?: number } = {}): ResearchContext {
    const state = this.adapter.state(), intentId = this.memory.currentIntent()?.id, projectId = this.memory.activeProject()?.id;
    const limit = Math.max(0, Math.min(5, options.limit ?? 3)), budget = Math.max(256, Math.min(8000, options.maxBytes ?? 4500));
    const localTrial = (t: MethodTrial) => t.worldId === state.worldId && t.dimension === state.dim;
    const local = this.definitions.filter((d) => (d.question || d.hypothesis) &&
      (d.scope.worldId === state.worldId && d.scope.dimension === state.dim || d.trials.some(localTrial)));
    const latest = new Map<string, MethodDefinition>();
    for (const d of local) if (!latest.has(d.name) || d.version > latest.get(d.name)!.version) latest.set(d.name, d);
    const relevance = (d: MethodDefinition) => Number(!!intentId && d.scope.intentId === intentId) + 2 * Number(!!projectId && d.scope.projectId === projectId);
    const recentAt = (d: MethodDefinition) => Math.max(d.createdAt, ...d.trials.filter(localTrial).map((t) => t.ts));
    const selected = [...latest.values()].sort((a, b) => relevance(b) - relevance(a) || recentAt(b) - recentAt(a));
    const context: ResearchContext = { source: 'method_trials', claims: 'model_hypotheses', evidence: 'historical_not_current_state', questions: [] };
    for (const d of selected) {
      if (context.questions.length >= limit) break;
      const trials = local.filter((v) => v.name === d.name && v.version <= d.version)
        .flatMap((v) => v.trials.filter(localTrial).map((trial) => ({ definition: v, trial })))
        .sort((a, b) => a.trial.ts - b.trial.ts);
      const outcomes: ResearchQuestion['outcomes'] = { supported: 0, counterexample: 0, unknown: 0 };
      for (const trial of d.trials.filter(localTrial)) outcomes[researchOutcome(trial)]++;
      const evidence = new Map<ResearchOutcome, typeof trials[number]>();
      for (const t of [...trials].reverse()) if (!evidence.has(researchOutcome(t.trial))) evidence.set(researchOutcome(t.trial), t);
      const question: ResearchQuestion = { name: d.name, version: d.version, ...(d.question ? { question: d.question } : {}),
        ...(d.hypothesis ? { hypothesis: d.hypothesis } : {}), prediction: researchFact(d.postcondition, 500), methodStatus: d.status, outcomes,
        recentEvidence: [...evidence.values()].sort((a, b) => a.trial.ts - b.trial.ts).map(({ definition: v, trial: t }) => ({ trialId: t.id, version: v.version,
          ...(v.version !== d.version && v.hypothesis ? { hypothesis: v.hypothesis } : {}), outcome: researchOutcome(t), at: t.ts,
          worldId: t.worldId, dimension: t.dimension, source: t.source, parameters: researchFact(t.parameters, 300), expected: researchFact(t.expected ?? v.postcondition, 400),
          before: researchFact(t.before, 400), actual: researchFact(t.after, 400), reason: t.reason.slice(0, 160), ...(t.failureCode ? { failureCode: t.failureCode } : {}) })) };
      // Keep the newest concrete evidence before sacrificing an entire question to the context budget.
      while (question.recentEvidence.length > 1 && Buffer.byteLength(JSON.stringify({ ...context, questions: [...context.questions, question] }), 'utf8') > budget) {
        question.recentEvidence.shift(); question.truncated = true;
      }
      if (Buffer.byteLength(JSON.stringify({ ...context, questions: [...context.questions, question] }), 'utf8') <= budget) context.questions.push(question);
    }
    return context;
  }

  recordGap(description: string, scope: { intentId?: string; projectId?: string; missingPrimitive?: string } = {}): AbilityGap {
    const state = this.adapter.state();
    const existing = this.gaps.find((g) => g.worldId === state.worldId && g.dimension === state.dim && g.description === description && g.intentId === scope.intentId && g.projectId === scope.projectId && g.status === 'open');
    if (existing) return structuredClone(existing);
    const gap: AbilityGap = { id: shortId('gap_'), description: description.slice(0, 300), worldId: state.worldId, dimension: state.dim, ...scope, status: 'open', ts: Date.now() };
    this.gaps.push(gap);
    if (this.gaps.length > 100) this.gaps.shift();
    this.save();
    this.bus.publish('ability_gap', 'P2', gap.description, { ...gap });
    return structuredClone(gap);
  }

  resolveGap(id: string, methodName: string): boolean {
    const method = this.definitions.find((m) => m.name === methodName && m.status === 'verified');
    const gap = this.gaps.find((g) => g.id === id && g.worldId === this.memory.worldId);
    if (!gap || !method) return false;
    gap.status = 'resolved';
    this.save();
    return true;
  }

  private prepare(raw: any) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{2,31}$/.test(raw.name) || SKILLS[raw.name]) throw new Error('方法名称须为 3–32 位小写字母/数字/下划线且不与底层技能重名');
    if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 240) throw new Error('方法需要简短用途说明');
    for (const field of ['question', 'hypothesis']) {
      if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 240)) throw new Error(`${field} 须为 1–240 字符的待检验陈述`);
    }
    const parameters = validateParameters(raw.parameters, this.adapter);
    const bound = bindParameters(parameters, {});
    const program = validateProgram(raw.program, bound, this.adapter, this.memory, this.adapter.state());
    if (flattenProgram(program).some((step) => step.skill === 'experiment_method')) throw new Error('试验入口不能嵌入方法程序；请直接组合底层动作，保留统一的调用与循环上限');
    if (!raw.postcondition) throw new Error('候选方法需要可观测的 postcondition，执行成功文字不能代替验收');
    validateCondition(bindRelative(substitute(raw.postcondition, bound), this.adapter.state()), this.adapter, this.memory, this.adapter.state());
    return { name: raw.name, description: raw.description.trim(), ...(raw.question !== undefined ? { question: raw.question.trim() as string } : {}),
      ...(raw.hypothesis !== undefined ? { hypothesis: raw.hypothesis.trim() as string } : {}), parameters, program, postcondition: structuredClone(raw.postcondition) };
  }

  /**
   * 退役反复出现明确反例且无有效支持的候选，或长期未试的版本；未知和动作失败不否定机制。
   * 在库快满时清掉已退役的旧版本，
   * 免得容量上限挡住新的学习。
   */
  pruneStale(now = Date.now()) {
    let changed = false;
    for (const d of this.definitions) {
      if (d.status !== 'candidate') continue;
      const counterexamples = d.trials.filter((t) => researchOutcome(t) === 'counterexample').length, verified = d.trials.filter((t) => t.status === 'verified').length;
      const lastTry = Math.max(d.createdAt, ...d.trials.map((t) => t.ts));
      if (counterexamples >= 3 && verified === 0) { this.retire(d.name, d.version, `当前方法预测在 ${counterexamples} 次有效观测中不成立`); changed = true; }
      else if (now - lastTry > 3 * 86_400_000) { this.retire(d.name, d.version, '三天没有试用'); changed = true; }
    }
    while (this.definitions.length >= 90) {
      const i = this.definitions.findIndex((d) => d.status === 'retired');
      if (i < 0) break;
      this.definitions.splice(i, 1);
      changed = true;
    }
    if (changed) this.save();
  }

  propose(raw: unknown, scope: { intentId?: string; projectId?: string } = {}): { ok: true; name: string; version: number; status: 'candidate' | 'verified'; existing?: boolean } | { ok: false; error: string } {
    try {
      this.pruneStale();
      const prepared = this.prepare(raw);
      const previous = this.definitions.filter((d) => d.name === prepared.name).sort((a, b) => b.version - a.version)[0];
      // Revising the program keeps the same question unless the model explicitly changes it.
      prepared.question ??= previous?.question;
      prepared.hypothesis ??= previous?.hypothesis;
      // 同一个程序和验收条件已经在库里（候选或已验证）：不再存一个新版本
      const key = JSON.stringify([prepared.program, prepared.postcondition, prepared.parameters]);
      const same = this.definitions.find((d) => d.status !== 'retired' && JSON.stringify([d.program, d.postcondition, d.parameters]) === key
        && (prepared.question === undefined || d.question === prepared.question) && (prepared.hypothesis === undefined || d.hypothesis === prepared.hypothesis));
      if (same) {
        const name = same.status === 'verified' ? `method:${same.name}` : `trial:${same.name}:v${same.version}`;
        return { ok: true, name, version: same.version, status: same.status as 'candidate' | 'verified', existing: true };
      }
      if (this.definitions.length >= 100) throw new Error('方法版本库已满，请先回顾或退役旧版本');
      const version = 1 + Math.max(0, ...this.definitions.filter((d) => d.name === prepared.name).map((d) => d.version));
      const state = this.adapter.state();
      const definition: MethodDefinition = { ...prepared, version, createdAt: Date.now(), trials: [], status: 'candidate',
        scope: { ...scope, worldId: state.worldId, dimension: state.dim } };
      this.definitions.push(definition);
      this.install(definition);
      this.save();
      const name = `trial:${definition.name}:v${version}`;
      this.bus.publish('method_candidate', 'P2', `保存未验证的方法 ${name}：${definition.description}`, { name, version });
      return { ok: true, name, version, status: 'candidate' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('不可组合的底层技能')) this.recordGap(message, scope);
      return { ok: false, error: message };
    }
  }

  /** Propose and try one bounded program inside the caller's existing action ownership. */
  async experiment(raw: unknown, parameters: unknown, ctx: SkillCtx): Promise<SkillResult> {
    throwIfAborted(ctx.signal);
    const proposed = this.propose(raw, { intentId: ctx.memory.currentIntent()?.id, projectId: ctx.memory.activeProject()?.id });
    if (!proposed.ok) return fail('BAD_ARGS', `未保存试验：${proposed.error}`);
    const definition = this.definitions.find((d) => d.version === proposed.version
      && (proposed.name === `trial:${d.name}:v${d.version}` || proposed.name === `method:${d.name}`));
    if (!definition) return fail('NOT_FOUND', '刚保存的方法版本已不可用');
    const skill = this.toSkill(definition, true);
    const validation = skill.validate({ parameters: parameters ?? {} }, ctx.adapter);
    if (!validation.ok) return fail('BAD_ARGS', `候选已保存，但本次不能试验：${validation.error}`, {
      methodName: skill.name, version: definition.version, methodStatus: definition.status, expected: definition.postcondition,
    });
    const result = await skill.run(ctx, validation.args);
    throwIfAborted(ctx.signal);
    const latest = definition.trials.at(-1);
    return { ...result,
      summary: `${result.summary}；${definition.status === 'verified' ? '该版本已通过两个情境的事实验收' : '该版本仍是候选，尚未晋升为已验证方法'}${result.status === 'failed' ? '；可保留同名并修订 program、参数或 postcondition 后再次试验' : ''}`,
      data: { ...result.data, methodName: skill.name, version: definition.version, methodStatus: definition.status,
        expected: result.data?.expected ?? definition.postcondition, trialStatus: latest?.status },
    };
  }

  /** 已验证方法的当前版本（同名取最新），给“更快的做法替换旧做法”用 */
  verifiedVersions(name: string): MethodDefinition[] {
    return structuredClone(this.definitions.filter((d) => d.name === name && d.status === 'verified').sort((a, b) => a.version - b.version));
  }

  /**
   * 没有配置隔离试验世界时，候选方法可以在正常游玩中试用（就像玩家试一个新办法），
   * 晋升仍然要求在两个不同情境里由真实观测验收；配置了试验世界则只在这些世界里试验。
   */
  private trialAllowed(worldId: string) {
    return this.trialWorldIds.size === 0 || this.trialWorldIds.has(worldId);
  }

  private hasProof(trials: MethodTrial[]) {
    return new Set(trials.filter((t) => t.status === 'verified' && ['adapter.state', 'adapter.state+vision'].includes(t.source) && this.trialAllowed(t.worldId)).map((t) => t.contextKey)).size >= 2;
  }

  promote(name: string, version: number): boolean {
    const definition = this.definitions.find((d) => d.name === name && d.version === version && d.status === 'candidate');
    if (!definition || !this.hasProof(definition.trials)) return false;
    definition.status = 'verified';
    this.install(definition);
    this.save();
    this.bus.publish('method_verified', 'P2', `方法 method:${name} v${version} 在两个不同情境中通过事实验收`);
    return true;
  }

  retire(name: string, version: number, reason: string) {
    const definition = this.definitions.find((d) => d.name === name && d.version === version);
    if (!definition) return;
    definition.status = 'retired';
    for (const key of [`trial:${name}:v${version}`, `method:${name}`]) {
      if (SKILLS[key] === this.installed.get(key)) { delete SKILLS[key]; this.installed.delete(key); }
    }
    const previous = this.definitions.filter((d) => d.name === name && d.status === 'verified').sort((a, b) => b.version - a.version)[0];
    if (previous) this.install(previous);
    this.save();
    this.bus.publish('method_retired', 'P2', `方法 ${name} v${version} 退役：${reason}`);
  }

  dispose() { for (const [name, skill] of this.installed) if (SKILLS[name] === skill) delete SKILLS[name]; this.installed.clear(); }

  private install(definition: MethodDefinition) {
    const trialName = `trial:${definition.name}:v${definition.version}`;
    const trial = this.toSkill(definition, true);
    SKILLS[trialName] = trial;
    this.installed.set(trialName, trial);
    if (definition.status === 'verified') {
      const name = `method:${definition.name}`;
      const skill = this.toSkill(definition, false);
      SKILLS[name] = skill;
      this.installed.set(name, skill);
    }
  }

  private toSkill(definition: MethodDefinition, trial: boolean): Skill<{ parameters: Record<string, string | number> }> {
    return {
      name: trial ? `trial:${definition.name}:v${definition.version}` : `method:${definition.name}`,
      description: `${trial ? '【候选试验，尚未证明】' : '【已验证方法】'}${definition.description}`,
      argsDoc: `${JSON.stringify({ parameters: Object.fromEntries(Object.entries(definition.parameters).map(([name, p]) => [name, p.default])) })}；参数约束：${JSON.stringify(definition.parameters)}`,
      timeoutMs: 600_000,
      movement: true,
      validate: (raw) => {
        try {
          const parameters = bindParameters(definition.parameters, (raw as any)?.parameters ?? {});
          validateProgram(definition.program, parameters, this.adapter, this.memory, this.adapter.state());
          validateCondition(bindRelative(substitute(definition.postcondition, parameters), this.adapter.state()), this.adapter, this.memory, this.adapter.state());
          if (trial && !this.trialAllowed(this.adapter.state().worldId)) throw new Error('候选方法只能在配置的隔离测试世界中执行');
          return { ok: true, args: { parameters } };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      },
      run: async (ctx, args) => {
        throwIfAborted(ctx.signal);
        const beforeState = ctx.adapter.state();
        if (trial && !this.trialAllowed(beforeState.worldId)) return fail('BAD_ARGS', '当前世界没有隔离试验授权');
        const postcondition: Condition = validateCondition(bindRelative(substitute(definition.postcondition, args.parameters), beforeState), ctx.adapter, ctx.memory, beforeState);
        const before = evaluateCondition(postcondition, beforeState, beforeState.worldId, observeCondition(postcondition, ctx.senses));
        if (!observationReady(beforeState)) return fail('NOT_CONNECTED', '方法试验需要有效观测');
        let result: SkillResult;
        try { result = await executeProgram(definition.program, args.parameters, ctx); }
        catch (error) { if (isAbort(error)) throw error; result = fail('ERROR', error instanceof Error ? error.message : String(error)); }
        throwIfAborted(ctx.signal);
        const afterState: AgentState = ctx.adapter.state();
        const afterObservations = observeCondition(postcondition, ctx.senses);
        const after = evaluateCondition(postcondition, afterState, beforeState.worldId, afterObservations);
        const sameSession = afterState.sessionId === beforeState.sessionId && afterState.dim === beforeState.dim && afterState.observationId !== beforeState.observationId;
        const satisfied = sameSession && after.status === 'satisfied';
        if (trial) {
          const status: MethodTrial['status'] = result.status !== 'succeeded' || !satisfied ? 'failed' : before.status === 'unsatisfied' ? 'verified' : 'uninformative';
          definition.trials.push({ id: shortId('trial_'), ts: Date.now(), worldId: afterState.worldId, dimension: afterState.dim, sessionId: afterState.sessionId, observationId: afterState.observationId,
            contextKey: `${beforeState.worldId}:${beforeState.dim}:${Math.floor(beforeState.pos.x / 16)}:${Math.floor(beforeState.pos.z / 16)}:${JSON.stringify(args.parameters)}`,
            parameters: args.parameters, before: before.actual, after: after.actual, expected: postcondition,
            beforeStatus: before.status, afterStatus: sameSession ? after.status : 'unknown', executionStatus: result.status,
            ...(result.failureCode ? { failureCode: result.failureCode } : {}), status,
            reason: result.status !== 'succeeded' ? result.summary : satisfied ? before.status === 'satisfied' ? '条件在试验前已成立，不作为学习证据' : before.status === 'unknown' ? '试验前状态未知，不能证明本次动作改变了条件' : '执行后同会话事实条件成立' : after.reason ?? '执行结束但事实条件未成立',
            source: afterObservations.length ? 'adapter.state+vision' : 'adapter.state' });
          if (definition.trials.length > 20) definition.trials.shift();
          this.save();
          if (status === 'verified') this.promote(definition.name, definition.version);
        }
        const facts = { verified: definition.status === 'verified', expected: postcondition, before: before.actual, actual: after.actual };
        if (result.status !== 'succeeded') return { ...result, data: { ...result.data, ...facts } };
        if (!satisfied) return fail('EFFECT_NOT_CONFIRMED', '方法步骤结束，但真实观测未满足约定结果', facts);
        return ok(`${trial ? '候选试验' : '方法'} ${definition.name} v${definition.version} 的当前事实条件成立`, facts);
      },
    };
  }
}
