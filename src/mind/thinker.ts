import type { GameAdapter } from '../adapter/types.ts';
import { FACINGS, type Facing } from '../perception/local.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { queryMechanics } from '../methods/mechanics.ts';
import { boundedJson } from '../planner/prompt.ts';
import { extractJson, normalizeStep, ruleProposal } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { validateCondition } from '../projects/conditions.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { validateSkill } from '../skills/types.ts';
import { buildMindMessages, buildReflectionMessages, moveDetails, type MindContext } from './prompt.ts';
import type { SelfModel } from './self.ts';
import { cleanLesson, cleanPlanStep } from './self.ts';
import { designBuilding } from '../building/architect.ts';
import { terrainSketch } from '../building/site.ts';
import { homeOf } from './home.ts';
import { draftsFor } from '../building/drafts.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import type { KnowledgeBase } from '../knowledge/library.ts';
import { describeBuild, myBuilds } from './home.ts';
import type { LedgerView } from './ledger.ts';
import type { BehaviorEngine, BehaviorStats } from './behaviors.ts';
import { recallLocal, RECALL_LABEL } from './recall.ts';

/** 思考时可以先做的只读查询（不占游戏时间） */
const QUERY_KINDS = ['recipes', 'recall', 'mechanics', 'skill', 'design', 'moves', 'knowledge', 'passages'];
/** 需要完整上下文（技能、图纸、Wiki 资料、矿道记录）才值得从瞥一眼升级成认真想的查询；其余轻量查询就地回答 */
const HEAVY_QUERY_KINDS = ['skill', 'design', 'knowledge', 'passages'];
import { ACTIVITY_KINDS, DECISION_KINDS, type ActivityDraft, type ActivityKind, type ActivityStep, type Consolidation, type DecisionKind, type Habits, type MindDecision } from './types.ts';

const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/** 只规范能无歧义识别的写法；位置仍交给事实校验，不能补造可信坐标。 */
function normalizeDoneWhen(raw: unknown, depth = 0): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 4) return raw;
  const o = { ...raw } as Record<string, any>;
  const aliases: Record<string, string> = { in_water: 'inWater', in_lava: 'inLava', on_ground: 'onGround', skyVisible: 'sky_visible' };
  const selfFields = ['held', 'riding', 'inWater', 'inLava', 'onGround', 'sky_visible', 'underground'];
  const fieldName = (field: unknown) => typeof field === 'string' ? aliases[field] ?? field : undefined;
  if (o.type === undefined) {
    if (Array.isArray(o.conditions)) o.type = o.any === true || o.mode === 'any' ? 'any_of' : 'all_of';
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
  if (o.type === 'inventory_full' && o.free_slots === undefined) o.free_slots = o.freeSlots ?? o.slots ?? o.count ?? 0;
  if (o.type === 'inventory_space_min' && o.free_slots === undefined) o.free_slots = o.freeSlots ?? o.slots ?? o.count;
  if ((o.type === 'all_of' || o.type === 'any_of') && Array.isArray(o.conditions)) o.conditions = o.conditions.map((c: unknown) => normalizeDoneWhen(c, depth + 1));
  return o;
}

/** 从步骤猜活动类型（模型没写或写错时） */
export function inferKind(steps: Step[]): ActivityKind {
  const first = steps.map((s) => s.skill);
  if (first.some((s) => ['build', 'repair', 'build_structure'].includes(s))) return 'build';
  if (first.some((s) => ['gather', 'hunt', 'fish', 'collect_seeds', 'forage', 'farm'].includes(s))) return 'gather';
  if (first.some((s) => ['craft', 'smelt'].includes(s))) return 'craft';
  if (first.some((s) => ['explore', 'expedition', 'goto', 'ride', 'travel'].includes(s))) return 'explore';
  if (first.some((s) => ['sleep', 'wait', 'shelter'].includes(s))) return 'rest';
  if (first.some((s) => ['store_items', 'take_items'].includes(s))) return 'tidy';
  if (first.some((s) => ['experiment_method'].includes(s) || s.startsWith('trial:'))) return 'experiment';
  return 'other';
}

/** 决定里能当场退回去改的毛病：步骤写错被丢、收工条件无效、next 被忽略 */
const FIXABLE_NOTE = /丢掉了不能执行的步骤|done_when 无效|next 已忽略/;

/** 校验一段活：必需步骤必须可执行，可选步骤写错则丢掉并记录原因。 */
export function validateDraft(raw: unknown, adapter: GameAdapter, memory: WorldMemory, notes: string[], label = 'activity'): ActivityDraft | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} 必须是对象` };
  const o = raw as Record<string, any>;
  const what = str(o.what ?? o.goal, 80);
  if (!what) return { error: `${label}.what 不能为空` };
  if (!Array.isArray(o.steps) || !o.steps.length) return { error: `${label}.steps 需要 1–6 个动作` };
  if (o.steps.length > 6) return { error: `${label}.steps 最多 6 个动作，请自行精简或分成多段` };
  const requestedFacing = typeof o.facing === 'string' ? o.facing.trim().toUpperCase() : undefined;
  const facing = FACINGS.find((value) => value === requestedFacing);
  if (o.facing !== undefined && !facing) return { error: `${label}.facing 必须是 N/E/S/W，表示本段相对坐标的前方，不是镜头朝向` };
  const steps: ActivityStep[] = [];
  const errors: string[] = [];
  const requiredErrors: string[] = [];
  const dropped: string[] = [];
  for (const [i, s0] of o.steps.entries()) {
    const s = normalizeStep(s0) as Record<string, any>;
    const name = String(s?.skill ?? '');
    const skill = SKILLS[name];
    const raw = `${name} ${JSON.stringify(s?.args ?? {}).slice(0, 60)}`;
    const optional = !!s0 && typeof s0 === 'object' && ((s0 as any).optional === true || (s0 as any).opportunistic === true);
    if (!skill || LLM_HIDDEN.has(name)) {
      const error = `steps[${i}] 没有 "${name}" 这个技能`;
      if (optional) { errors.push(error); dropped.push(`${raw}（没有这个动作）`); } else requiredErrors.push(error);
      continue;
    }
    const v = validateSkill(skill, s?.args ?? {}, adapter);
    if (!v.ok) {
      const error = `steps[${i}] ${name} 校验失败：${v.error}`;
      if (optional) { errors.push(error); dropped.push(`${raw}（${v.error.slice(0, 300)}）`); } else requiredErrors.push(error);
      continue;
    }
    let args = v.args;
    if (['dig_at', 'step', 'place_at'].includes(name)) {
      // Primitive validation owns coordinate aliases and absolute-to-relative conversion.
      const cell = args as { at: [number, number, number]; facing: Facing; xyz?: object };
      if (!cell.xyz && (cell.at[0] !== 0 || cell.at[2] !== 0)) {
        if (!facing) return { error: `${label}.steps[${i}] ${name} 使用水平相对坐标，必须显式声明 ${label}.facing（N/E/S/W）；文字描述和当前镜头不会自动确定本段坐标方向。请按实际意图补齐，或改用 xyz 世界坐标` };
        if (s.args?.facing != null && cell.facing !== facing) return { error: `${label}.facing=${facing}，但 steps[${i}] ${name} 的 facing=${cell.facing} 与本段坐标参考方向冲突；未改写或执行该步骤。请统一坐标表达或改用 xyz，若要改变本段参考方向请明确修改 ${label}.facing` };
        args = { ...args, facing };
      } else if (!cell.xyz && facing && s.args?.facing == null) args = { ...args, facing };
    }
    steps.push({ skill: name, args, ...(optional ? { optional: true } : {}) });
  }
  if (requiredErrors.length) return { error: `${label} 必需步骤无法执行，整段未安排：${requiredErrors.join('；')}。请修正、明确删去或重新决定` };
  if (!steps.length) return { error: `${label} 没有可执行的动作：${errors.join('；')}` };
  if (errors.length) notes.push(`${label} 里丢掉了不能执行的步骤：${errors.join('；')}`.slice(0, 300));
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
    what, why: str(o.why, 120), kind, steps, repeat, ...(facing ? { facing } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(str(o.expect, 120) ? { expect: str(o.expect, 120) } : {}),
    ...(str(o.if_stuck, 120) ? { ifStuck: str(o.if_stuck, 120) } : {}),
    ...(typeof o.agenda_id === 'string' ? { agendaId: o.agenda_id } : {}),
    ...(dropped.length ? { dropped } : {}),
  };
}

const NEEDS_ACTIVITY = new Set<DecisionKind>(['adjust', 'new', 'detour', 'switch', 'experiment']);

/** 把模型的 JSON 变成一次决定；能纠正的就地纠正，关键部分无效才要求重答 */
export function parseDecision(raw: unknown, adapter: GameAdapter, memory: WorldMemory, hasActivity: boolean, currentWhat?: string, currentSkills?: string[]): Omit<MindDecision, 'source' | 'tier' | 'requestedAt'> | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '顶层必须是 JSON 对象' };
  const o = raw as Record<string, any>;
  const notes: string[] = [];
  let kind: DecisionKind = DECISION_KINDS.includes(o.decision) ? o.decision : (o.activity ? 'new' : 'continue');
  if (!DECISION_KINDS.includes(o.decision) && o.decision !== undefined) notes.push(`decision "${String(o.decision)}" 不认识，按 ${kind} 处理`);
  const monologue = str(o.monologue ?? o.thought, 200);
  // continue 和另一段活含义冲突：让模型说明是继续、修改当前活还是安排下一段。
  if (kind === 'continue' && hasActivity && currentWhat && o.activity && Array.isArray(o.activity.steps) && o.activity.steps.length
    && typeof o.activity.what === 'string' && o.activity.what.trim() && o.activity.what.trim() !== currentWhat.trim()
    && (!currentSkills || o.activity.steps.map((st: any) => String(st?.skill ?? '')).join('>') !== currentSkills.join('>'))) {
    return { error: `decision=continue 但 activity 写了另一段活「${str(o.activity.what, 40)}」：继续当前活请省略 activity；要修改当前活请明确用 adjust；要排在当前活之后请写 next` };
  }
  let activity: ActivityDraft | undefined;
  if (o.activity !== undefined && o.activity !== null && kind !== 'continue') {
    const v = validateDraft(o.activity, adapter, memory, notes);
    if ('error' in v) return { error: v.error };
    else activity = v;
  }
  if (kind === 'rest' && !activity) {
    const w = SKILLS.wait && !LLM_HIDDEN.has('wait') ? SKILLS.wait.validate({ seconds: 15 }, adapter) : null;
    activity = { what: '歇一会儿', why: monologue || '喘口气', kind: 'rest', repeat: 1,
      steps: [w?.ok ? { skill: 'wait', args: w.args } : { skill: 'look_around', args: { seconds: 6 } }] };
  }
  if (NEEDS_ACTIVITY.has(kind) && !activity) return { error: `decision=${kind} 需要给出 activity（what/steps）` };
  let promotedNext = false;
  if (kind === 'continue' && !hasActivity) {
    // 手上没活却写了 continue：把写好的 activity（或 next）当成新的一段
    const candidate = o.activity ?? o.next;
    const v = candidate ? validateDraft(candidate, adapter, memory, notes, o.activity ? 'activity' : 'next') : null;
    if (v && !('error' in v)) { activity = v; kind = 'new'; promotedNext = !o.activity; notes.push('手上没活，continue 按 new 处理'); }
    else if (v && 'error' in v) return { error: v.error };
    else return { error: '手上没有正在做的活，不能 continue：请给出 decision=new 和一段 activity' };
  }
  if (kind === 'adjust' && !hasActivity) kind = 'new';
  if (kind === 'experiment' && activity) activity.kind = 'experiment';
  let next: ActivityDraft | undefined;
  if (o.next && !promotedNext && Array.isArray(o.next.steps) && o.next.steps.length) {
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
    ...(str(o.liked, 60) ? { liked: str(o.liked, 60) } : {}),
    ...(parseHabits(o.habits) ? { habits: parseHabits(o.habits)! } : {}),
    ...(o.skill && typeof o.skill === 'object' && !Array.isArray(o.skill) ? { skill: o.skill as Record<string, unknown> } : {}),
    ...(() => {
      const plan = parsePlan(o.plan, (c, i) => {
        try { return validateCondition(normalizeDoneWhen(c), adapter, memory, adapter.state()); }
        catch (e) { notes.push(`plan.steps[${i}].done_when 无效已忽略：${e instanceof Error ? e.message : String(e)}`); return null; }
      });
      return plan ? { plan } : {};
    })(),
    ...(str(o.switch_reason, 120) ? { switchReason: str(o.switch_reason, 120) } : {}),
    ...(str(o.worth_learning, 240) ? { worthLearning: str(o.worth_learning, 240) } : {}),
    ...(o.operator && typeof o.operator === 'object' && ['doing', 'done', 'cannot', 'adopted', 'declined'].includes(String((o.operator as any).status))
      ? { operator: { status: String((o.operator as any).status) as NonNullable<MindDecision['operator']>['status'], ...(str((o.operator as any).note, 200) ? { note: str((o.operator as any).note, 200) } : {}) } } : {}),
  };
}

/** {"focus":"a_…|一句话","steps":["…" 或 {"text":"…","done_when":{条件}}],"done":[0,"…"]} */
export function parsePlan(raw: unknown, condition?: (c: unknown, i: number) => import('../projects/types.ts').Condition | null): MindDecision['plan'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, any>;
  const items = (Array.isArray(o.steps) ? o.steps : []).map((x: unknown) => ({ text: cleanPlanStep(str(typeof x === 'string' ? x : (x as any)?.text, 80)), when: x && typeof x === 'object' ? (x as any).done_when ?? (x as any).doneWhen : undefined }))
    .filter((x: { text: string }) => x.text).slice(0, 8);
  const steps: string[] = items.map((x: { text: string }) => x.text);
  const conditions = items.map((x: { when: unknown }, i: number) => x.when !== undefined && x.when !== null && condition ? condition(x.when, i) : null);
  const done = (Array.isArray(o.done) ? o.done : o.done !== undefined ? [o.done] : [])
    .filter((x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 8 || typeof x === 'string' && x.trim()).slice(0, 8);
  const focus = str(o.focus ?? o.agenda_id, 100), goal = str(o.goal, 100), switchReason = str(o.switch_reason, 120);
  if (!steps.length && !done.length) return null;
  return { ...(focus ? { focus } : {}), ...(goal ? { goal } : {}), ...(steps.length ? { steps } : {}), ...(conditions.some(Boolean) ? { conditions } : {}), ...(done.length ? { done } : {}),
    ...(switchReason ? { switchReason } : {}) };
}

/**
 * 思考器：把当前的心思（念头、情绪、议程、窍门、感知）交给模型，拿回一次“像人一样”的决定。
 * mock 模式下用规则凑出同样形状的决定，整条链路保持一致。
 */
export class Thinker {
  /** 正在后台画的图纸 */
  designing: { brief: string; startedAt: number } | null = null;
  /** 收获账本：主动回想时也能想起拿某样东西花多少、在哪多 */
  ledger: LedgerView | null = null;
  skillStats: ((name: string) => BehaviorStats | undefined) | null = null;
  successfulEmergencyVersions: BehaviorEngine['successfulEmergencyVersions'] | null = null;
  constructor(private planner: Planner, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private book: SkillBook | null = null, private knowledge: KnowledgeBase | null = null) {}

  get autonomous() { return this.planner.autonomous; }
  get skillBook(): SkillBook | null { return this.book; }

  async think(ctx: MindContext, signal: AbortSignal): Promise<MindDecision> {
    const requestedAt = Date.now();
    if (!this.planner.autonomous) return this.ruleDecision(ctx, requestedAt);
    let tier = ctx.tier;
    let messages = buildMindMessages(ctx);
    let queries = 0, invalid = 0;
    let knowledgeBytes = 0;
    const knowledgeExhausted = JSON.stringify({ error: '本次思考的知识查询预算已用完，请根据已读资料作决定。' });
    const knowledgeReserve = Buffer.byteLength(knowledgeExhausted, 'utf8');
    const query = async (kind: string, raw: Record<string, unknown>) => {
      if (kind !== 'knowledge') return this.query(kind, raw, ctx, signal);
      const remaining = 10_000 - knowledgeBytes;
      if (remaining < 512 + knowledgeReserve) {
        knowledgeBytes += knowledgeReserve;
        return knowledgeExhausted;
      }
      const result = await this.query(kind, raw, ctx, signal, remaining - knowledgeReserve);
      knowledgeBytes += Buffer.byteLength(result, 'utf8');
      return result;
    };
    let repaired = false;
    let firstDraft: Omit<MindDecision, 'source' | 'tier' | 'requestedAt'> | null = null;
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
      if (ask === 'deliberate' || ask === 'need_full_context' || (tier === 'glance' && HEAVY_QUERY_KINDS.includes(ask))) {
        if (tier === 'deliberate' && !QUERY_KINDS.includes(ask)) {
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
      if (QUERY_KINDS.includes(ask)) {
        if (queries >= 3) { messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: '这次的查询次数用完了，请根据已知信息给出决定。' }); continue; }
        queries++;
        const result = await query(ask, raw);
        messages.push({ role: 'assistant', content: c.text.slice(0, 600) }, { role: 'user', content: `查询结果（只读，不是现场事实）：${result}\n剩余查询 ${3 - queries} 次。请继续：可以再查，或给出决定。` });
        continue;
      }
      // 瞥一眼时把“想深一点”写成了动作：照它的意思转成认真想
      if (tier === 'glance' && wantsDeliberate(raw)) {
        tier = 'deliberate';
        this.planner.stats.tiers.escalated++;
        this.bus.publish('llm_escalate', 'P3', '抬头一看觉得需要好好想想（把 deliberate 写成了动作）');
        messages = buildMindMessages({ ...ctx, tier });
        continue;
      }
      // 把查询（design/skill/recipes…）写成了 routine 里的一步：替它查了，再请它据此做决定
      const embedded = embeddedQuery(raw);
      if (embedded && queries < 3) {
        if (tier === 'glance' && ['knowledge', 'passages'].includes(embedded.kind)) {
          tier = 'deliberate';
          this.planner.stats.tiers.escalated++;
          this.bus.publish('llm_escalate', 'P3', `抬头一看觉得需要好好想想（把 ${embedded.kind} 查询写成了动作）`);
          messages = buildMindMessages({ ...ctx, tier });
        }
        queries++;
        const result = await query(embedded.kind, embedded.args);
        messages.push({ role: 'assistant', content: c.text.slice(0, 1500) },
          { role: 'user', content: `${embedded.kind} 是思考时的查询，不是身体的动作，不能写进 steps。已经替你查了：${result}\n请据此给出决定（steps 里只写动作）。` });
        continue;
      }
      if (firstDraft && raw?.keep === true) { this.planner.stats.ok++; return { ...firstDraft, source: 'llm', tier, requestedAt }; }
      const parsed = parseDecision(raw, this.adapter, this.memory, !!ctx.activity, ctx.activity?.what, ctx.activity?.steps.map((st) => st.skill));
      if ('error' in parsed) {
        // 模型已提出新决定，不能在新决定无效时擅自执行旧稿。
        firstDraft = null;
        invalid++;
        this.planner.noteInvalid(ctx.reason, parsed.error);
        if (invalid >= 2) throw new Error(`INVALID_DECISION: ${parsed.error}`);
        messages.push({ role: 'assistant', content: c.text.slice(0, 1500) }, { role: 'user', content: `这个决定没法执行：${parsed.error}。请改正后只输出一个 JSON 对象。` });
        continue;
      }
      // 能执行，但有几处写错被丢掉了（步骤参数、收工条件）：当场退回去让它改一次，不默默丢掉
      // （以前一下午约 100 次：漏了参数的那一步直接没了，收工条件被忽略，活做一半才发现）
      const fixable = parsed.notes.filter((n) => FIXABLE_NOTE.test(n));
      if (fixable.length && !repaired && Date.now() - requestedAt < 40_000) {
        repaired = true;
        firstDraft = parsed;
        messages.push({ role: 'assistant', content: c.text.slice(0, 2500) },
          { role: 'user', content: `这个决定有几处写错了，执行时会被丢掉：${fixable.join('；').slice(0, 600)}。\n要这些就改正后重新输出整个 JSON 对象；觉得丢掉也无所谓，就输出 {"keep":true}。` });
        continue;
      }
      this.planner.stats.ok++;
      return { ...parsed, source: 'llm', tier, requestedAt };
    }
    if (firstDraft) return { ...firstDraft, source: 'llm', tier, requestedAt };
    throw new Error('INVALID_DECISION: 思考轮次用完');
  }

  /**
   * 休息/睡前回想：把零碎的经验整理成少数几条靠谱的窍门，顺便写一句日记。
   * 在后台进行，不打断手上的事；mock 模式下不做（规则模式不会写窍门）。
   */
  async reflect(self: SelfModel, persona: string, signal: AbortSignal, strategy: string[] = []): Promise<Consolidation | null> {
    if (!this.planner.autonomous) return null;
    const messages = buildReflectionMessages(self, persona, this.book?.list().filter((k) => k.source === 'self').map((k) => `${k.name}：${k.description}`) ?? [], strategy, this.memory);
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

  private async query(kind: string, raw: Record<string, any>, ctx: MindContext, signal?: AbortSignal, maxBytes?: number): Promise<string> {
    try {
      if (kind === 'passages') {
        if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) return 'id 需要非空的矿道记录 ID 字符串；不指定 id 可列出记录';
        if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isSafeInteger(raw.offset) || raw.offset < 0)) return 'offset 需要非负整数，表示历史脚点的起始索引';
        const id = raw.id as string | undefined;
        const offset = (raw.offset ?? 0) as number;
        if (id === undefined && raw.offset !== undefined) return 'offset 需要与 id 一起使用；不指定 id 时列出矿道记录';
        const context = { worldId: ctx.state.worldId, dim: ctx.state.dim, historical: true, connectivity: 'unknown',
          note: '历史脚点已稀疏采样、去重或合并，不代表连续顺序或双向可走；地表参考点也不保证现在是入口。' };
        const records = this.memory.passages(ctx.state.dim).filter((rec) => (rec.worldId ?? 'default') === ctx.state.worldId).map((rec) => {
          const nearest = rec.path.reduce<{ index: number; distance: number } | null>((best, point, index) => {
            const distance = Math.hypot(point.x - ctx.state.pos.x, point.y - ctx.state.pos.y, point.z - ctx.state.pos.z);
            return !best || distance < best.distance ? { index, distance } : best;
          }, null);
          return { rec, summary: { id: rec.id, surfaceReferences: rec.entrances, deepestY: rec.deepestY, createdAt: rec.createdAt,
            lastUsedAt: rec.lastUsedAt, dug: rec.dug, ores: rec.ores, pointCount: rec.path.length,
            nearestPointIndex: nearest?.index ?? null, distance: nearest?.distance ?? null } };
        }).sort((a, b) => (a.summary.distance ?? Infinity) - (b.summary.distance ?? Infinity));
        if (id === undefined) return JSON.stringify({ ...context, action: 'list', records: records.map(({ summary }) => summary) });
        const record = records.find(({ rec }) => rec.id === id.trim());
        if (!record) return JSON.stringify({ ...context, error: '当前世界和维度没有这个矿道记录', id: id.trim() });
        const points = record.rec.path.slice(offset, offset + 32);
        return JSON.stringify({ ...context, action: 'read', ...record.summary, path: points, offset, total: record.rec.path.length,
          nextOffset: offset + points.length < record.rec.path.length ? offset + points.length : null });
      }
      if (kind === 'knowledge') {
        if (!this.knowledge) return '知识库未启用，无法查询游戏资料';
        const result = this.knowledge.query(raw, maxBytes);
        this.bus.publish('knowledge_query', 'P3', `查知识：${String(raw.id ?? raw.query ?? '目录').slice(0, 80)}`);
        return JSON.stringify(result);
      }
      if (kind === 'moves') {
        const names = (Array.isArray(raw.names) ? raw.names : [raw.name ?? raw.names]).map((n: unknown) => String(n ?? '').trim()).filter(Boolean);
        return names.length ? moveDetails(names) : '要查哪些动作？写 {"kind":"moves","names":["动作名"]}';
      }
      if (kind === 'skill') {
        const name = String(raw.name ?? '').trim();
        if (!name) {
          const query = String(raw.query ?? '').trim().toLowerCase();
          const offset = Number.isSafeInteger(raw.offset) && raw.offset >= 0 ? raw.offset : 0;
          const found = (this.book?.list() ?? []).filter((entry) => !query || `${entry.name} ${entry.description} ${entry.body} ${entry.notes ?? ''}`.toLowerCase().includes(query));
          const entries = found.slice(offset, offset + 30).map((entry) => {
            const stats = this.skillStats?.(entry.name);
            return { name: entry.name, description: entry.description, source: entry.source,
              retired: stats?.retired ?? null, disabled: !!stats?.disabled, candidate: !!this.book?.candidate(entry.name), candidateRetired: stats?.candidateRetired ?? null,
              successfulEmergencyVersions: this.successfulEmergencyVersions?.(entry.name) ?? [] };
          });
          return JSON.stringify({ query, total: found.length, entries, nextOffset: offset + entries.length < found.length ? offset + entries.length : null });
        }
        if (raw.version !== undefined && (!Number.isSafeInteger(raw.version) || raw.version < 1)) return 'version 需要正整数；不指定 version 可查看已保存的历史版本';
        const candidate = this.book?.candidate(name);
        const current = this.book?.get(name);
        if (!current) return `没有叫「${String(raw.name ?? '')}」的技能；有这些：${this.book?.index().join('；') ?? '（没有技能书）'}`;
        const version = raw.version as number | undefined;
        const skill = version === undefined ? (raw.trial === true ? candidate : current)
          : [current, candidate].find((entry) => Number((entry?.behavior as Record<string, unknown> | undefined)?.version) === version)
            ?? this.book?.definitionVersion(name, version);
        const code = version !== undefined && !skill ? this.book?.codeVersion(name, version) : null;
        const versions = this.book?.versions(name) ?? [];
        if (!skill && !code) return `没有「${name}」${version === undefined ? '的候选版本' : `的 v${version}`}；已保存历史：${JSON.stringify(versions)}`;
        const stats = this.skillStats?.(name);
        const evidence = stats ? { retired: stats.retired ?? null, disabled: !!stats.disabled, candidateRetired: stats.candidateRetired ?? null, lastError: stats.lastError ?? null,
          byVersion: version === undefined ? stats.byVersion ?? null : stats.byVersion?.[String(version)] ?? null,
          recent: (stats.recent ?? []).filter((record) => version === undefined || record.version === version).slice(-5) } : null;
        if (!skill) {
          this.bus.publish('skill_read', 'P3', `翻开技能：${name} v${version}`, { name, version, source: current.source });
          return `技能「${name}」v${version} 仅保存了历史代码，没有完整执行契约；读取不代表启用或验证：\n${code}\n当前收起/停用状态及按版本保存的运行记录（无记录为未知）：${JSON.stringify(evidence)}`;
        }
        this.bus.publish('skill_read', 'P3', `翻开技能：${skill.name}`, { name: skill.name, source: skill.source });
        return `技能「${skill.name}」${version !== undefined ? `v${version}` : ''}（读取不代表启用或验证）：\n${skill.body}${current.notes ? `\n\n当前学习笔记（不代表该版本已验证）：\n${current.notes}` : ''}${skill.behavior ? `\n完整执行契约：\n${JSON.stringify(skill.behavior)}` : ''}${version === undefined && candidate ? `\n\n候选 v${(candidate.behavior as Record<string, unknown>).version} 尚未启用；用 use_skill {name:"${name}",trial:true,args:{…}} 显式试用。候选的完整参数、触发、代码和验收：\n${JSON.stringify(candidate.behavior)}` : ''}\n已保存历史版本：${JSON.stringify(versions)}；可指定 version 阅读。\n保留成功过的应急版本：${JSON.stringify(this.successfulEmergencyVersions?.(name) ?? [])}。历史成功不保证现在有效；可用 skill {"name":"${name}","from_version":版本号} 选择完整契约生成新候选，需显式试用重新验收，不会直接启用。\n当前收起/停用状态及按版本保存的运行记录（无记录为未知）：${JSON.stringify(evidence)}`;
      }
      if (kind === 'design') {
        const brief = String(raw.brief ?? raw.request ?? '').trim().slice(0, 400);
        if (!brief) return '要设计什么？写 {"kind":"design","brief":"想要的建筑：用途、大概多大、风格、在哪儿"}';
        // 建筑师在后台画：想得久（几分钟），这段时间心智照常玩，画好了作为“注意到的事”回来
        if (this.designing) return `建筑师还在画「${this.designing.brief.slice(0, 40)}」（已经 ${Math.max(1, Math.round((Date.now() - this.designing.startedAt) / 60_000))} 现实分钟），画好会告诉你；先去做别的，别重复请`;
        this.bus.publish('design_start', 'P2', `请建筑师设计：${brief.slice(0, 80)}`);
        const p = ctx.percept;
        // 盖在哪：where = here（默认，脚下这一带）| base（家旁边）| "x,y,z"。只看得清附近（约 96 格内）的地形，太远就不给地形，到了再定位置
        const whereRaw = String(raw.where ?? 'here').trim().toLowerCase();
        const home = homeOf(this.memory, { worldId: ctx.state.worldId, dim: p.self.dim, pos: ctx.state.pos });
        const coords = whereRaw.match(/^(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)$/);
        const wanted = /^(base|home|家|基地)$/.test(whereRaw) ? home?.pos ?? null : coords ? { x: +coords[1], y: +coords[2], z: +coords[3] } : undefined;
        const siteAt = wanted === undefined ? undefined : wanted && Math.hypot(wanted.x - ctx.state.pos.x, wanted.z - ctx.state.pos.z) <= 96 ? wanted : null;
        const job = designBuilding(this.planner, this.book, draftsFor(this.memory), this.adapter, {
          brief, persona: ctx.persona, inventory: ctx.state.inventory, biome: p.self.biome,
          nearby: [...new Set(p.nearby.resources.map((r) => r.block))].slice(0, 12),
          likes: ctx.self.tastes(),
          pastWorks: myBuilds(this.memory, { worldId: ctx.state.worldId, dim: p.self.dim, pos: ctx.state.pos }).map(describeBuild),
          ...(siteAt !== null ? { terrain: terrainSketch(this.adapter, 8, siteAt) } : {}),
        }, AbortSignal.timeout(20 * 60_000));
        this.designing = { brief, startedAt: Date.now() };
        job.then((res) => {
          if (!res.ok) this.bus.publish('design_failed', 'P1', res.error.slice(0, 300), { brief });
          else this.bus.publish('design', 'P2', res.summary.slice(0, 400), { draftId: res.draft.id, name: res.draft.name, size: res.draft.size });
        }).catch((e) => this.bus.publish('design_failed', 'P1', `建筑师没画成：${e instanceof Error ? e.message : String(e)}`.slice(0, 300), { brief }))
          .finally(() => { this.designing = null; });
        return `已经请建筑师去画「${brief.slice(0, 60)}」了：要想几现实分钟，画好会告诉你（图纸会出现在 my_drafts）。这段时间先去做别的——攒木头石头、找吃的都行，不用干等`;
      }
      if (kind === 'recipes') {
        if (!this.planner.recipeBook) return '没有配方记忆';
        this.bus.publish('recipe_query', 'P3', `查配方：${raw.uses ? `能拿 ${raw.uses} 做什么` : raw.item ? `物品 ${raw.item}` : `类别 ${raw.category ?? '（列出类别）'}`}`);
        return JSON.stringify(this.planner.recipeBook.query(raw, ctx.state.inventory)).slice(0, 4000);
      }
      if (kind === 'mechanics') {
        const result = queryMechanics(String(raw.query ?? '').slice(0, 300), 6);
        this.planner.controlKnowledge.expose(ctx.state.worldId, result.mechanics.map((m) => m.primitive));
        this.bus.publish('mechanics_query', 'P3', `查底层操作：${String(raw.query ?? '').slice(0, 80)}`);
        return JSON.stringify(result).slice(0, 5000);
      }
      const recall = this.planner.recall;
      if (!recall) {
        const q = String(raw.query ?? '').slice(0, 300);
        if (!q.trim()) return '想回忆什么？写 {"kind":"recall","query":"关键词"}';
        const found = recallLocal(q, { self: ctx.self, memory: this.memory, book: this.book, ledger: this.ledger }, { n: 8 });
        this.bus.publish('recall_local', 'P3', `回想：${q.slice(0, 60)}（${found.length} 条）`);
        return found.length ? found.map((r) => `[${RECALL_LABEL[r.kind]}] ${r.text}`).join('\n') : '想不起和这些关键词有关的事';
      }
      const res = await recall.recall({ percept: { self: { dim: ctx.percept.self.dim, pos: ctx.percept.self.pos }, objective: null, nearby: ctx.percept.nearby },
        lastFailure: null, userSuggestion: ctx.userSuggestion }, String(raw.query ?? '').slice(0, 400));
      return boundedJson(res.memories, 3500);
    } catch (e) {
      return `查询失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * 脑子一时转不动（模型报错）时的兜底：不替它定玩法（以前是一棵写死的“砍树→木镐→石镐、天黑挖坑”），
   * 只停下来看看四周，等下一次想清楚；危险状态由感知如实提供。
   */
  idleDecision(requestedAt = Date.now()): MindDecision {
    return { kind: 'new', monologue: '脑子有点乱，先停下看看四周', notes: [], source: 'rule', tier: 'glance', requestedAt,
      activity: { what: '先停下看看四周', why: '等想清楚再动', kind: 'rest', repeat: 1, steps: [{ skill: 'look_around', args: { seconds: 4 } }] } };
  }

  /** mock 模式（没有模型）：规则目标包装成一段活，保证整条链路能连贯地跑 */
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
  const sk = o.skill && typeof o.skill === 'object' && !Array.isArray(o.skill) ? o.skill as Record<string, unknown> : null;
  const executable = !!sk && (Array.isArray(sk.steps) || sk.when !== undefined);
  const skill = sk && typeof sk.name === 'string' && typeof sk.description === 'string' && (typeof sk.body === 'string' && sk.body.trim().length >= 20 || executable)
    ? { name: sk.name.slice(0, 41), description: sk.description.slice(0, 200), body: typeof sk.body === 'string' ? sk.body.slice(0, 6000) : '', ...(executable ? { raw: sk } : {}) } : undefined;
  const agendaAdd = (Array.isArray(o.agenda_add) ? o.agenda_add : []).map((a: any) => typeof a === 'string' ? { text: a } : a)
    .map((a: any) => ({ text: str(a?.text, 60), kind: a?.kind === 'goal' ? 'goal' as const : 'idea' as const, horizon: a?.horizon === 'someday' ? 'someday' as const : 'today' as const }))
    .filter((a: { text: string }) => a.text.length >= 4).slice(0, 3);
  return { rewrite, merge, drop, add, agendaDrop: ids(o.agenda_drop, agendaIds), ...(agendaAdd.length ? { agendaAdd } : {}), ...(skill ? { skill } : {}),
    ...(str(o.diary, 160) ? { diary: str(o.diary, 160) } : {}), ...(str(o.monologue, 160) ? { monologue: str(o.monologue, 160) } : {}) };
}

/** 模型把查询写成了 routine 的一步（{"skill":"design","args":{"brief":…}}）：认出来，按查询处理 */
export function embeddedQuery(raw: unknown): { kind: string; args: Record<string, any> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  for (const part of [o.activity, o.next]) {
    const steps = Array.isArray(part?.steps) ? part.steps : [];
    for (const st of steps) {
      const kind = String(st?.skill ?? '');
      if (QUERY_KINDS.includes(kind)) return { kind, args: { ...(st?.args ?? {}), ...(kind === 'design' && !st?.args?.brief ? { brief: String(part?.what ?? '') } : {}) } };
    }
  }
  return null;
}

/** {"torch_every":8,"eat_below":12,"pickup":true}；0/false 关掉某个习惯 */
export function parseHabits(raw: unknown): Habits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: Habits = {};
  const num = (v: unknown, lo: number, hi: number) => v === false || v === 0 || v === null ? 0 : Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : undefined;
  const t = num(o.torch_every, 4, 16); if (t !== undefined) out.torch_every = t;
  const e = num(o.eat_below, 2, 19); if (e !== undefined) out.eat_below = e;
  if (typeof o.pickup === 'boolean') out.pickup = o.pickup;
  return Object.keys(out).length ? out : null;
}

/** 快速思考时把 deliberate 写成了一步动作 */
function wantsDeliberate(raw: unknown): boolean {
  const o = raw as Record<string, any> | null;
  return !!o && [o.activity, o.next].some((part) => Array.isArray(part?.steps) && part.steps.some((st: any) => st?.skill === 'deliberate'));
}
