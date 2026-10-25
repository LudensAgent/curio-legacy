import type { GameAdapter } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { queryMechanics } from '../methods/mechanics.ts';
import { boundedJson } from '../planner/prompt.ts';
import { extractJson, normalizeStep, ruleProposal } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { validateCondition } from '../projects/conditions.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { buildMindMessages, buildReflectionMessages, type MindContext } from './prompt.ts';
import type { SelfModel } from './self.ts';
import { cleanLesson } from './self.ts';
import { ACTIVITY_KINDS, DECISION_KINDS, type ActivityDraft, type ActivityKind, type ActivityStep, type Consolidation, type DecisionKind, type MindDecision } from './types.ts';

const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/** 只规范能无歧义识别的写法；位置仍交给事实校验，不能补造可信坐标。 */
function normalizeDoneWhen(raw: unknown, depth = 0): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 4) return raw;
  const o = { ...raw } as Record<string, any>;
  const aliases: Record<string, string> = { in_water: 'inWater', in_lava: 'inLava', on_ground: 'onGround', skyVisible: 'sky_visible' };
  const selfFields = ['held', 'riding', 'inWater', 'inLava', 'onGround', 'sky_visible', 'underground'];
  const fieldName = (field: unknown) => typeof field === 'string' ? aliases[field] ?? field : undefined;
  if (o.type === undefined) {
    if (Array.isArray(o.conditions)) o.type = 'all_of';
    else if (o.slot !== undefined && o.item !== undefined) o.type = 'equipment';
    else if (o.item !== undefined && o.count !== undefined) o.type = 'inventory_min';
    else if (o.pos !== undefined && o.radius !== undefined) o.type = 'location_near';
    else if (o.pos !== undefined && (o.name !== undefined || o.properties !== undefined)) o.type = 'block_state';
    else if (fieldName(o.field ?? o.state ?? o.property ?? o.key ?? o.name)
      || Object.keys(o).some((key) => selfFields.includes(fieldName(key) ?? ''))) o.type = 'self_state';
  }
  const direct = fieldName(o.type);
  if (direct && selfFields.includes(direct) && !['sky_visible', 'underground'].includes(direct)) {
    o.type = 'self_state'; o.field = direct;
  }
  if (o.type === 'self_state') {
    let field = fieldName(o.field ?? o.state ?? o.property ?? o.key ?? o.name);
    if (!field) {
      const fields = Object.keys(o).filter((key) => selfFields.includes(fieldName(key) ?? ''));
      if (fields.length === 1) field = fieldName(fields[0]);
    }
    if (field) {
      o.field = field;
      if (o.equals === undefined) {
        const key = Object.keys(o).find((k) => fieldName(k) === field);
        if (o.value !== undefined) o.equals = o.value;
        else if (o.is !== undefined) o.equals = o.is;
        else if (key) o.equals = o[key];
      }
      if (field === 'sky_visible' || field === 'underground') o.type = field;
    }
  }
  if (o.type === 'skyVisible') o.type = 'sky_visible';
  if (o.type === 'sky_visible' || o.type === 'underground') {
    if (o.equals === undefined) o.equals = o.value ?? o.is ?? o[o.type];
  }
  if ((o.type === 'sky_visible' || o.type === 'underground'
    || o.type === 'self_state' && ['inWater', 'inLava', 'onGround'].includes(o.field)) && ['true', 'false'].includes(o.equals)) o.equals = o.equals === 'true';
  if (o.type === 'all_of' && Array.isArray(o.conditions)) o.conditions = o.conditions.map((c: unknown) => normalizeDoneWhen(c, depth + 1));
  return o;
}

/** 从步骤猜活动类型（模型没写或写错时） */
export function inferKind(steps: Step[]): ActivityKind {
  const first = steps.map((s) => s.skill);
  if (first.some((s) => ['build', 'repair', 'build_structure'].includes(s))) return 'build';
  if (first.some((s) => ['gather', 'hunt', 'fish', 'collect_seeds', 'forage', 'farm'].includes(s))) return 'gather';
  if (first.some((s) => ['craft', 'smelt'].includes(s))) return 'craft';
  if (first.some((s) => ['explore', 'expedition', 'goto', 'boat'].includes(s))) return 'explore';
  if (first.some((s) => ['sleep', 'wait', 'shelter'].includes(s))) return 'rest';
  if (first.some((s) => ['store_items', 'take_items'].includes(s))) return 'tidy';
  if (first.some((s) => ['experiment_method'].includes(s) || s.startsWith('trial:'))) return 'experiment';
  return 'other';
}

/** 校验一段活：步骤必须是会的手脚、参数合法；写错的个别步骤丢掉并记下，全错才算无效 */
export function validateDraft(raw: unknown, adapter: GameAdapter, memory: WorldMemory, notes: string[], label = 'activity'): ActivityDraft | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} 必须是对象` };
  const o = raw as Record<string, any>;
  const what = str(o.what ?? o.goal, 80);
  if (!what) return { error: `${label}.what 不能为空` };
  if (!Array.isArray(o.steps) || !o.steps.length) return { error: `${label}.steps 需要 1–6 个动作` };
  const steps: ActivityStep[] = [];
  const errors: string[] = [];
  for (const [i, s0] of o.steps.slice(0, 6).entries()) {
    const s = normalizeStep(s0) as Record<string, any>;
    const name = String(s?.skill ?? '');
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name)) { errors.push(`steps[${i}] 没有 "${name}" 这个技能`); continue; }
    const v = skill.validate(s?.args ?? {}, adapter);
    if (!v.ok) { errors.push(`steps[${i}] ${name} 参数错误：${v.error}`); continue; }
    const optional = !!s0 && typeof s0 === 'object' && ((s0 as any).optional === true || (s0 as any).opportunistic === true);
    steps.push({ skill: name, args: v.args, ...(optional ? { optional: true } : {}) });
  }
  if (!steps.length) return { error: `${label} 没有可执行的动作：${errors.join('；')}` };
  if (errors.length) notes.push(`${label} 里丢掉了不能执行的步骤：${errors.join('；')}`.slice(0, 300));
  if (o.steps.length > 6) notes.push(`${label} 只保留前 6 步`);
  let doneWhen;
  if (o.done_when !== undefined && o.done_when !== null) {
    try {
      const normalized = normalizeDoneWhen(o.done_when);
      doneWhen = validateCondition(normalized, adapter, memory, adapter.state());
      if (JSON.stringify(normalized) !== JSON.stringify(o.done_when)) notes.push(`${label}.done_when 的写法已规范化`);
    }
    catch (e) { notes.push(`${label}.done_when 无效已忽略：${e instanceof Error ? e.message : String(e)}`); }
  }
  const repeatRaw = o.repeat === 'until_done' ? (doneWhen ? 8 : 1) : Math.round(Number(o.repeat ?? 1));
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.min(12, repeatRaw)) : 1;
  const kind = ACTIVITY_KINDS.includes(o.kind) ? o.kind as ActivityKind : inferKind(steps);
  return {
    what, why: str(o.why, 120), kind, steps, repeat,
    ...(doneWhen ? { doneWhen } : {}),
    ...(str(o.expect, 120) ? { expect: str(o.expect, 120) } : {}),
    ...(str(o.if_stuck, 120) ? { ifStuck: str(o.if_stuck, 120) } : {}),
    ...(typeof o.agenda_id === 'string' ? { agendaId: o.agenda_id } : {}),
  };
}

const NEEDS_ACTIVITY = new Set<DecisionKind>(['adjust', 'new', 'detour', 'switch', 'experiment']);

/** 把模型的 JSON 变成一次决定；能纠正的就地纠正，关键部分无效才要求重答 */
export function parseDecision(raw: unknown, adapter: GameAdapter, memory: WorldMemory, hasActivity: boolean): Omit<MindDecision, 'source' | 'tier' | 'requestedAt'> | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '顶层必须是 JSON 对象' };
  const o = raw as Record<string, any>;
  const notes: string[] = [];
  let kind: DecisionKind = DECISION_KINDS.includes(o.decision) ? o.decision : (o.activity ? 'new' : 'continue');
  if (!DECISION_KINDS.includes(o.decision) && o.decision !== undefined) notes.push(`decision "${String(o.decision)}" 不认识，按 ${kind} 处理`);
  const monologue = str(o.monologue ?? o.thought, 200);
  let activity: ActivityDraft | undefined;
  if (o.activity !== undefined && o.activity !== null && kind !== 'continue') {
    const v = validateDraft(o.activity, adapter, memory, notes);
    if ('error' in v) { if (NEEDS_ACTIVITY.has(kind)) return { error: v.error }; notes.push(v.error); }
    else activity = v;
  }
  if (kind === 'rest' && !activity) {
    const w = SKILLS.wait && !LLM_HIDDEN.has('wait') ? SKILLS.wait.validate({ seconds: 15 }, adapter) : null;
    activity = { what: '歇一会儿', why: monologue || '喘口气', kind: 'rest', repeat: 1,
      steps: [w?.ok ? { skill: 'wait', args: w.args } : { skill: 'look_around', args: { seconds: 6 } }] };
  }
  if (NEEDS_ACTIVITY.has(kind) && !activity) return { error: `decision=${kind} 需要给出 activity（what/steps）` };
  if (kind === 'continue' && !hasActivity) {
    if (activity) kind = 'new';
    else return { error: '手上没有正在做的活，不能 continue：请给出 decision=new 和一段 activity' };
  }
  if (kind === 'adjust' && !hasActivity) kind = 'new';
  if (kind === 'experiment' && activity) activity.kind = 'experiment';
  let next: ActivityDraft | undefined;
  if (o.next) {
    const v = validateDraft(o.next, adapter, memory, notes, 'next');
    if ('error' in v) notes.push(`next 已忽略：${v.error}`); else next = v;
  }
  let agenda: MindDecision['agenda'];
  if (o.agenda && typeof o.agenda === 'object') {
    const a = o.agenda as Record<string, any>;
    agenda = {
      add: (Array.isArray(a.add) ? a.add : []).slice(0, 4).map((x: any) => ({ text: str(typeof x === 'string' ? x : x?.text, 100),
        kind: (['goal', 'idea', 'question'].includes(x?.kind) ? x.kind : 'goal') as 'goal' | 'idea' | 'question',
        horizon: (x?.horizon === 'someday' ? 'someday' : 'today') as 'today' | 'someday' }))
        .filter((x: { text: string }) => x.text),
      done: (Array.isArray(a.done) ? a.done : []).filter((x: unknown) => typeof x === 'string').slice(0, 6),
      drop: (Array.isArray(a.drop) ? a.drop : []).filter((x: unknown) => typeof x === 'string').slice(0, 6),
      ...(typeof a.focus === 'string' ? { focus: a.focus } : {}),
    };
  }
  const hypothesis = str(o.hypothesis, 160);
  const learnedRaw = o.learned ?? o.lesson;
  const learned = learnedRaw && typeof learnedRaw === 'object' && !Array.isArray(learnedRaw)
    ? (str(learnedRaw.revise, 80) && typeof learnedRaw.text === 'string' && cleanLesson(learnedRaw.text)
      ? { revise: str(learnedRaw.revise, 80), text: cleanLesson(learnedRaw.text) } : undefined)
    : typeof learnedRaw === 'string' ? cleanLesson(learnedRaw) || undefined : undefined;
  const verdict = ['supported', 'refuted', 'unclear'].includes(o.experiment_result) ? o.experiment_result as 'supported' | 'refuted' | 'unclear' : undefined;
  if (kind === 'experiment' && !hypothesis) notes.push('experiment 没写 hypothesis，这次只当普通尝试');
  return {
    kind, monologue, notes,
    ...(str(o.say, 120) && !str(o.say, 120).startsWith('/') ? { say: str(o.say, 120) } : {}),
    ...(activity ? { activity } : {}), ...(next ? { next } : {}), ...(agenda ? { agenda } : {}),
    ...(learned ? { learned } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(verdict ? { verdict } : {}),
    ...(str(o.diary, 160) ? { diary: str(o.diary, 160) } : {}),
  };
}

/**
 * 思考器：把当前的心思（念头、情绪、议程、窍门、感知）交给模型，拿回一次“像人一样”的决定。
 * mock 模式下用规则凑出同样形状的决定，整条链路保持一致。
 */
export class Thinker {
  constructor(private planner: Planner, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus) {}

  get autonomous() { return this.planner.autonomous; }

  async think(ctx: MindContext, signal: AbortSignal): Promise<MindDecision> {
    const requestedAt = Date.now();
    if (!this.planner.autonomous) return this.ruleDecision(ctx, requestedAt);
    let tier = ctx.tier;
    let messages = buildMindMessages(ctx);
    let queries = 0, invalid = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      const c = await this.planner.complete(messages, { label: `mind:${ctx.reason}${tier === 'glance' ? '·瞥一眼' : ''}`, tier: tier === 'glance' ? 'light' : 'full', signal, attempt });
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; }
      catch (e) {
        invalid++;
        const error = c.finishReason === 'length' ? '输出被截断' : c.text.trim() ? `不是合法 JSON：${(e as Error).message}` : '空回复';
        this.planner.noteInvalid(ctx.reason, error);
        if (invalid >= 2) throw new Error(`INVALID_DECISION: ${error}`);
        messages.push({ role: 'user', content: `刚才的回复无效（${error}）。请直接输出一个简短的 JSON 对象（monologue 不超过 60 字）。` });
        continue;
      }
      const ask = String(raw?.kind ?? '');
      if (ask === 'deliberate' || ask === 'need_full_context' || (tier === 'glance' && ['recipes', 'recall', 'mechanics'].includes(ask))) {
        if (tier === 'deliberate' && ask !== 'recipes' && ask !== 'recall' && ask !== 'mechanics') {
          messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: '你已经有完整信息了，请直接给出决定。' });
          continue;
        }
        if (tier === 'glance') {
          tier = 'deliberate';
          this.planner.stats.tiers.escalated++;
          this.bus.publish('llm_escalate', 'P3', `抬头一看觉得需要好好想想：${String(raw.reason ?? ask).slice(0, 80)}`);
          messages = buildMindMessages({ ...ctx, tier });
          if (ask === 'deliberate' || ask === 'need_full_context') continue;
        }
      }
      if (['recipes', 'recall', 'mechanics'].includes(ask)) {
        if (queries >= 3) { messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: '这次的查询次数用完了，请根据已知信息给出决定。' }); continue; }
        queries++;
        const result = await this.query(ask, raw, ctx);
        messages.push({ role: 'assistant', content: c.text.slice(0, 600) }, { role: 'user', content: `查询结果（只读，不是现场事实）：${result}\n剩余查询 ${3 - queries} 次。请继续：可以再查，或给出决定。` });
        continue;
      }
      const parsed = parseDecision(raw, this.adapter, this.memory, !!ctx.activity);
      if ('error' in parsed) {
        invalid++;
        this.planner.noteInvalid(ctx.reason, parsed.error);
        if (invalid >= 2) throw new Error(`INVALID_DECISION: ${parsed.error}`);
        messages.push({ role: 'assistant', content: c.text.slice(0, 1500) }, { role: 'user', content: `这个决定没法执行：${parsed.error}。请改正后只输出一个 JSON 对象。` });
        continue;
      }
      this.planner.stats.ok++;
      return { ...parsed, source: 'llm', tier, requestedAt };
    }
    throw new Error('INVALID_DECISION: 思考轮次用完');
  }

  /**
   * 休息/睡前回想：把零碎的经验整理成少数几条靠谱的窍门，顺便写一句日记。
   * 在后台进行，不打断手上的事；mock 模式下不做（规则模式不会写窍门）。
   */
  async reflect(self: SelfModel, persona: string, signal: AbortSignal): Promise<Consolidation | null> {
    if (!this.planner.autonomous) return null;
    const messages = buildReflectionMessages(self, persona);
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.planner.complete(messages, { label: 'mind:回想', tier: 'full', signal, attempt });
      try {
        const raw = extractJson(c.text) as Record<string, any>;
        return parseConsolidation(raw, new Set(self.data.knowHow.map((k) => k.id)), new Set(self.agenda().map((a) => a.id)));
      } catch (e) {
        this.planner.noteInvalid('回想', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
      }
    }
    return null;
  }

  private async query(kind: string, raw: Record<string, any>, ctx: MindContext): Promise<string> {
    try {
      if (kind === 'recipes') {
        if (!this.planner.recipeBook) return '没有配方记忆';
        this.bus.publish('recipe_query', 'P3', `查配方：${raw.item ? `物品 ${raw.item}` : `类别 ${raw.category ?? '（列出类别）'}`}`);
        return JSON.stringify(this.planner.recipeBook.query(raw, ctx.state.inventory)).slice(0, 4000);
      }
      if (kind === 'mechanics') {
        const result = queryMechanics(String(raw.query ?? '').slice(0, 300), 6);
        this.planner.controlKnowledge.expose(ctx.state.worldId, result.mechanics.map((m) => m.primitive));
        this.bus.publish('mechanics_query', 'P3', `查底层操作：${String(raw.query ?? '').slice(0, 80)}`);
        return JSON.stringify(result).slice(0, 5000);
      }
      const recall = this.planner.recall;
      if (!recall) return '没有接长期记忆服务；只能凭日记和窍门回忆';
      const res = await recall.recall({ percept: { self: { dim: ctx.percept.self.dim, pos: ctx.percept.self.pos }, objective: null, nearby: ctx.percept.nearby },
        lastFailure: null, userSuggestion: ctx.userSuggestion }, String(raw.query ?? '').slice(0, 400));
      return boundedJson(res.memories, 3500);
    } catch (e) {
      return `查询失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** mock/兜底：规则目标包装成一段活，保证没有模型也能连贯地玩 */
  ruleDecision(ctx: MindContext, requestedAt = Date.now()): MindDecision {
    if (ctx.activity && ctx.tier === 'glance' && !ctx.noticed.some((n) => n.level !== 'note')) {
      return { kind: 'continue', monologue: '', notes: [], source: 'rule', tier: ctx.tier, requestedAt };
    }
    const p = ruleProposal(ctx.percept, this.memory, null) as Record<string, any>;
    const notes: string[] = [];
    const draft = validateDraft({ what: p.goal, why: p.thought, steps: p.steps, kind: undefined }, this.adapter, this.memory, notes);
    const activity: ActivityDraft = 'error' in draft
      ? { what: '四处看看', why: '没有想法时先观察', kind: 'explore', repeat: 1, steps: [{ skill: 'look_around', args: { seconds: 4 } }] }
      : draft;
    return { kind: ctx.activity ? 'switch' : 'new', monologue: str(p.thought, 200), activity, notes, source: 'rule', tier: ctx.tier, requestedAt };
  }
}

/** 校验回想结果：只接受指向已有窍门/议程的操作，文字统一清洗 */
export function parseConsolidation(raw: unknown, knowHowIds: Set<string>, agendaIds: Set<string>): Consolidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层必须是 JSON 对象');
  const o = raw as Record<string, any>;
  const ids = (v: unknown, pool: Set<string>) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && pool.has(x));
  const used = new Set<string>();
  const merge = (Array.isArray(o.merge) ? o.merge : []).map((m: any) => ({ ids: [...new Set(ids(m?.ids, knowHowIds))], text: cleanLesson(String(m?.text ?? '')) }))
    .filter((m: { ids: string[]; text: string }) => m.ids.length >= 2 && m.text.length >= 4 && m.ids.every((id) => !used.has(id)) && (m.ids.forEach((id) => used.add(id)), true));
  const rewrite = (Array.isArray(o.rewrite) ? o.rewrite : []).map((r: any) => ({ id: String(r?.id ?? ''), text: cleanLesson(String(r?.text ?? '')) }))
    .filter((r: { id: string; text: string }) => knowHowIds.has(r.id) && !used.has(r.id) && r.text.length >= 4 && (used.add(r.id), true));
  const drop = ids(o.drop, knowHowIds).filter((id) => !used.has(id));
  const add = (Array.isArray(o.add) ? o.add : []).map((t: unknown) => cleanLesson(String(t ?? ''))).filter((t: string) => t.length >= 4).slice(0, 5);
  return { rewrite, merge, drop, add, agendaDrop: ids(o.agenda_drop, agendaIds),
    ...(str(o.diary, 160) ? { diary: str(o.diary, 160) } : {}), ...(str(o.monologue, 160) ? { monologue: str(o.monologue, 160) } : {}) };
}
