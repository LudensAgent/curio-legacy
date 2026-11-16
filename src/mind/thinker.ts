import type { GameAdapter } from '../adapter/types.ts';
import { FACINGS, type Facing } from '../perception/local.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { MemoryRecall } from '../memory/types.ts';
import { queryMechanics } from '../methods/mechanics.ts';
import { boundedJson } from '../planner/prompt.ts';
import { extractJson, normalizeStep, ruleProposal } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { CONDITION_KINDS, evaluateCondition, minDistanceOnly, validateCondition } from '../projects/conditions.ts';
import type { Condition } from '../projects/types.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { validatePlanSkill } from '../skills/types.ts';
import { buildMindMessages, buildReflectionMessages, moveDetails, moveDirectory, type MindContext } from './prompt.ts';
import { NO_ARBITRARY_TRAVEL_STEPS, NON_OBSERVING_STEPS, NON_PRODUCING_STEPS } from './step-capability.ts';
import type { SelfModel } from './self.ts';
import { cleanLesson, cleanPlanStep } from './self.ts';
import { designBuilding } from '../building/architect.ts';
import { surveyBuildSite, terrainSketch } from '../building/site.ts';
import { planConstruction, type ConstructionPlan } from '../building/plan.ts';
import { normalizeSpec } from '../building/spec.ts';
import { homeOf } from './home.ts';
import { draftsFor } from '../building/drafts.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import type { KnowledgeBase, KnowledgeMatch } from '../knowledge/library.ts';
import { describeBuild, myBuilds } from './home.ts';
import type { LedgerView } from './ledger.ts';
import type { BehaviorEngine, BehaviorStats } from './behaviors.ts';
import { recallLocal, RECALL_LABEL } from './recall.ts';

/** 思考时可以先做的只读查询（不占游戏时间） */
const QUERY_KINDS = ['recipes', 'recall', 'mechanics', 'skill', 'design', 'moves', 'knowledge', 'progress', 'terrain', 'construction'];
/** 需要完整上下文（技能、图纸、Wiki 资料、矿道记录）才值得从瞥一眼升级成认真想的查询；其余轻量查询就地回答 */
const HEAVY_QUERY_KINDS = ['skill', 'design', 'knowledge'];
/**
 * 水里低氧阈值：身体在水里、氧气低于这个数时，只够“瞥一眼”，不够完整想一轮。
 * 完整认真想的中位约 9 秒、长尾几十秒；水下氧气从 10 掉到 0 往往也在这几秒内，等回答回来可能已经溺死。
 * Mind 用它决定前景思考的档位，Thinker 用它拒绝在思考中途升级为更慢的一轮。
 */
export const LOW_AIR_OXYGEN = 10;
import { ACTIVITY_KINDS, AGENDA_NOTE_MAX, DECISION_KINDS, type ActivityDraft, type ActivityKind, type ActivityStep, type Consolidation, type DecisionKind, type Habits, type MindDecision, type NextDraft } from './types.ts';

/** 无效决定重试时把已查到的资料压成一小段，提醒模型不要重复查询。 */
const knowledgeDigest = (result: string) => {
  let parsed: { action?: string; matches?: KnowledgeMatch[];
    document?: { id: string; sections?: { id: string; text?: string }[] } };
  // 知识库未启用时返回的是普通文字；解析边界失败就按原文截一段交给模型。
  try { parsed = JSON.parse(result) as typeof parsed; } catch { return result.slice(0, 800); }
  if (parsed.action === 'search') return (parsed.matches ?? []).map((match) => `${match.id}${match.section ? `#${match.section}` : ''}：${match.excerpt}`).join('\n').slice(0, 1200) || '没有匹配';
  const section = parsed.document?.sections?.find((candidate) => candidate.text);
  return section ? `${parsed.document!.id}#${section.id}：${section.text!.slice(0, 1200)}` : result.slice(0, 800);
};

const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/** 只规范能无歧义识别的写法；位置仍交给事实校验，不能补造可信坐标。 */
function normalizeDoneWhen(raw: unknown, depth = 0): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 4) return raw;
  const o = { ...raw } as Record<string, any>;
  const aliases: Record<string, string> = { in_water: 'inWater', in_lava: 'inLava', on_ground: 'onGround', bodyPortal: 'inPortal', body_portal: 'inPortal', body_in_portal: 'inPortal', in_portal: 'inPortal', skyVisible: 'sky_visible' };
  const selfFields = ['held', 'riding', 'inWater', 'inLava', 'onGround', 'inPortal', 'dim', 'sky_visible', 'underground'];
  const fieldName = (field: unknown) => typeof field === 'string' ? aliases[field] ?? field : undefined;
  if (o.type === undefined) {
    // 模型常把组合条件写成 {"any_of":[...]} 而不是 {"type":"any_of","conditions":[...]}；
    // 单条件也会写成 {"inventory_min":{...}}。这两种形状无歧义，先规范再交给事实校验。
    const wrappers = ([['any_of', 'any_of'], ['all_of', 'all_of']] as const).filter(([key]) => Array.isArray(o[key]));
    if (wrappers.length === 1) {
      const [key, type] = wrappers[0];
      o.type = type;
      o.conditions = o[key];
      delete o[key];
    } else if (wrappers.length === 0) {
      const wrapped = Object.keys(o).filter((key) => CONDITION_KINDS.has(key) && o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]));
      if (wrapped.length === 1) {
        const type = wrapped[0];
        const body = o[type];
        delete o[type];
        Object.assign(o, body);
        o.type = type;
      } else if (Array.isArray(o.conditions)) o.type = o.any === true || o.mode === 'any' ? 'any_of' : 'all_of';
      else if (o.slot !== undefined && o.item !== undefined) o.type = 'equipment';
      else if (o.item !== undefined && o.count !== undefined) o.type = 'inventory_min';
      else if (o.pos !== undefined && o.radius !== undefined) o.type = 'location_near';
      else if (o.pos !== undefined && (o.name !== undefined || o.properties !== undefined)) o.type = 'block_state';
      else if (fieldName(o.field ?? o.state ?? o.property ?? o.key ?? o.name)
        || Object.keys(o).some((key) => selfFields.includes(fieldName(key) ?? ''))) o.type = 'self_state';
    }
    // wrappers.length > 1：同时写 any_of 和 all_of 有歧义，不猜；交给 validateCondition 报错。
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
    || o.type === 'self_state' && ['inWater', 'inLava', 'onGround', 'inPortal'].includes(o.field)) && ['true', 'false'].includes(o.equals)) o.equals = o.equals === 'true';
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
  if (first.some((s) => ['expedition', 'explore_toward', 'travel_to', 'navigate_to', 'advance', 'swim_path', 'boat_path'].includes(s))) return 'explore';
  if (first.some((s) => ['sleep', 'wait', 'shelter'].includes(s))) return 'rest';
  if (first.some((s) => ['store_items', 'take_items'].includes(s))) return 'tidy';
  if (first.some((s) => ['experiment_method'].includes(s) || s.startsWith('trial:'))) return 'experiment';
  return 'other';
}

/** 决定里能当场退回去改的毛病：步骤写错被丢、收工条件无效、next 被忽略 */
const FIXABLE_NOTE = /丢掉了不能执行的步骤|done_when 无效|next 已忽略/;

/** llm_invalid 里保留的原始输出长度：足够看清被拒的 step/args，又不把事件日志撑大。 */
const INVALID_OUTPUT_CHARS = 2000;

/** 只陈述这条条件证明了什么；不改写法、不催着换条件。 */
const minDistanceNote = (label: string, distance: number) =>
  `${label}.done_when 有个只按 exploration.min_distance=${distance} 判断的分支：这个分支只证明本段离起点至少 ${distance} 格或进了新区块；若这段目标是找到或到达某个目标，单靠它不能证明。`;

/**
 * 只做“逻辑上不可能完成”的检查：done_when 要物品/位置，但这段 steps 全是已知不会产生物品/不会移动的动作。
 * 未知技能（自学/代码技能）一律放行，不判断具体策略，也不替 Agent 选动作。
 */
function doneWhenGap(condition: Condition, skills: Set<string>): string | null {
  switch (condition.type) {
    case 'inventory_min':
      return [...skills].every((skill) => NON_PRODUCING_STEPS.has(skill))
        ? `done_when 需要背包里有 ${condition.item}×${condition.count}，但这几步（${[...skills].join('、') || '无'}）都不会产生物品（只读/纯移动/消耗类）；把能产生它的采集/制作/拾取动作放进这段活，或换一个这段活能确认的收工条件`
        : null;
    case 'location_near':
      return [...skills].every((skill) => NO_ARBITRARY_TRAVEL_STEPS.has(skill))
        ? `done_when 需要到达 (${condition.pos.x},${condition.pos.y},${condition.pos.z}) 附近，但这几步（${[...skills].join('、') || '无'}）不能保证到达指定坐标（只读、查询或只能走到已知目标）；把移动步骤放进这段活，或换一个这段活能确认的收工条件`
        : null;
    case 'exploration': {
      if (condition.min_distance !== undefined && [...skills].every((skill) => NO_ARBITRARY_TRAVEL_STEPS.has(skill))) {
        return `done_when 要求本段实测离起点 ${condition.min_distance} 格，但这几步（${[...skills].join('、') || '无'}）不能保证带来这段实测的移动距离（只会走到已知目标）；把会实际移动的步骤放进这段活，或改用 find`;
      }
      if (condition.find !== undefined && [...skills].every((skill) => NON_OBSERVING_STEPS.has(skill))) {
        return `done_when 要求本段实际看见 ${condition.find}，但这几步（${[...skills].join('、') || '无'}）都不会观察目标；把观察/搜索/采集步骤放进这段活，或改用 min_distance`;
      }
      return null;
    }
    case 'all_of':
      return condition.conditions.map((child) => doneWhenGap(child, skills)).find((gap): gap is string => gap !== null) ?? null;
    case 'any_of': {
      const gaps = condition.conditions.map((child) => doneWhenGap(child, skills)).filter((gap): gap is string => gap !== null);
      return gaps.length === condition.conditions.length
        ? `done_when 的任一分支都无法由这段活的步骤确认：${gaps.join('；')}`
        : null;
    }
    default:
      return null;
  }
}

/** next.requires 只能在下一段开始前按当前状态验收；exploration 依赖上一段活动的实测回执，不能用于这里。 */
function containsExploration(condition: Condition): boolean {
  return condition.type === 'exploration'
    || (condition.type === 'all_of' || condition.type === 'any_of') && condition.conditions.some(containsExploration);
}

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
  if (o.facing !== undefined && !facing) return { error: `${label}.facing 必须是 N/E/S/W，表示本段相对坐标的前方，不是镜头朝向；活动里没有水平相对坐标步骤就省略这个字段` };
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
    // 计划录入只做静态校验：后续步骤是否相邻、落差多少，要等前一步执行后按最新位置预检，
    // 不能拿当前起点一次性判定整段多步绝对坐标计划。
    const v = validatePlanSkill(skill, s?.args ?? {}, adapter);
    if (!v.ok) {
      const error = `steps[${i}] ${name} 校验失败：${v.error}`;
      if (optional) { errors.push(error); dropped.push(`${raw}（${v.error.slice(0, 300)}）`); } else requiredErrors.push(error);
      continue;
    }
    let args = v.args;
    // “方向 + 距离”的起点要在这一步真正开始时冻结：计划录入时（尤其是排在后面的 next，可能几十秒、
    // 几十格之后才轮到）冻结，会让“往西 96 格”从录入时的位置算起——实机东行 95 格后接着的 next 往西走，
    // 目标按出发点算，一路走回原点再往西。Agent 自己写了 origin 的保留。
    const rawArgs = (s?.args ?? {}) as Record<string, unknown>;
    if (name === 'explore_toward' && rawArgs.origin === undefined) {
      const { origin: _frozen, ...rest } = args as Record<string, unknown>;
      args = rest as typeof args;
    }
    if (name === 'travel_to') {
      const to = (args as { to?: Record<string, unknown> }).to;
      const rawTo = rawArgs.to ?? rawArgs.target;
      const rawOrigin = rawTo && typeof rawTo === 'object' ? (rawTo as Record<string, unknown>).origin : undefined;
      if (to && 'heading' in to && rawOrigin === undefined) args = { ...args, to: { heading: to.heading, distance: to.distance } } as typeof args;
    }
    if (['mine_cell', 'move_step', 'place_cell', 'place_support'].includes(name)) {
      // Primitive validation owns coordinate aliases and absolute-to-relative conversion.
      const cell = args as { at: [number, number, number]; facing: Facing; xyz?: object };
      if (!cell.xyz && (cell.at[0] !== 0 || cell.at[2] !== 0)) {
        if (!facing) return { error: `${label}.steps[${i}] ${name} 使用水平相对坐标，必须显式声明 ${label}.facing（N/E/S/W）；文字描述和当前镜头不会自动确定本段坐标方向。请按实际意图补齐，或改用 xyz 世界坐标` };
        if (s.args?.facing != null && cell.facing !== facing) return { error: `${label}.facing=${facing}，但 steps[${i}] ${name} 的 facing=${cell.facing} 与本段坐标参考方向冲突；未改写或执行该步骤。请统一坐标表达或改用 xyz，若要改变本段参考方向请明确修改 ${label}.facing` };
        args = { ...args, facing };
      } else if (!cell.xyz && facing && s.args?.facing == null) args = { ...args, facing };
    }
    // 草案可显式引用旧实例 ID（续跑同一动作时保留其额度账本）；无 ID 则视为新建动作。
    const keepId = s0 && typeof s0 === 'object' && typeof (s0 as Record<string, unknown>).id === 'string' && (s0 as Record<string, unknown>).id ? (s0 as Record<string, unknown>).id as string : undefined;
    steps.push({ skill: name, args, ...(optional ? { optional: true } : {}), ...(keepId ? { id: keepId } : {}) });
  }
  if (requiredErrors.length) return { error: `${label} 必需步骤无法执行，整段未安排：${requiredErrors.join('；')}。请修正、明确删去或重新决定` };
  if (!steps.length) return { error: `${label} 没有可执行的动作：${errors.join('；')}` };
  if (errors.length) notes.push(`${label} 里丢掉了不能执行的步骤：${errors.join('；')}`.slice(0, 300));
  let doneWhen: Condition | undefined;
  if (o.done_when !== undefined && o.done_when !== null) {
    try {
      const normalized = normalizeDoneWhen(o.done_when);
      doneWhen = validateCondition(normalized, adapter, memory, adapter.state());
      if (JSON.stringify(normalized) !== JSON.stringify(o.done_when)) notes.push(`${label}.done_when 的写法已规范化`);
    }
    catch (e) { notes.push(`${label}.done_when 无效已忽略：${e instanceof Error ? e.message : String(e)}`); }
  }
  // 已经满足的条件不在这里拦（Mind 开工前会收下并结束）；只拒绝这段 steps 逻辑上不可能达到的收工条件。
  if (doneWhen && evaluateCondition(doneWhen, adapter.state()).status !== 'satisfied') {
    const gap = doneWhenGap(doneWhen, new Set(steps.map((step) => step.skill)));
    if (gap) return { error: `${label}.${gap}` };
  }
  if (doneWhen) {
    const distance = minDistanceOnly(doneWhen);
    if (distance !== null) notes.push(minDistanceNote(label, distance));
  }
  const repeatRaw = o.repeat === 'until_done' ? (doneWhen ? 8 : 1) : Math.round(Number(o.repeat ?? 1));
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.min(12, repeatRaw)) : 1;
  const kind = ACTIVITY_KINDS.includes(o.kind) ? o.kind as ActivityKind : inferKind(steps);
  // 这一段如果在按某条窍门做，写 stable id；是否存在由 Mind 在开工时核对，不在这里猜。
  const applying = str(o.applying, 80);
  if (o.applying !== undefined && !/^k_[A-Za-z0-9_-]{1,64}$/.test(applying)) notes.push(`${label}.applying 需要现有窍门 id（k_…），已忽略`);
  const outcomeId = str(o.outcome_id ?? o.outcomeId, 80), methodId = str(o.method_id ?? o.methodId, 80);
  return {
    what, why: str(o.why, 120), kind, steps, repeat, ...(facing ? { facing } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(str(o.expect, 120) ? { expect: str(o.expect, 120) } : {}),
    ...(str(o.if_stuck, 120) ? { ifStuck: str(o.if_stuck, 120) } : {}),
    ...(typeof o.agenda_id === 'string' ? { agendaId: o.agenda_id } : {}),
    ...(/^k_[A-Za-z0-9_-]{1,64}$/.test(applying) ? { applying } : {}),
    ...(/^po_[A-Za-z0-9_-]{1,64}$/.test(outcomeId) ? { outcomeId } : {}),
    ...(/^pm_[A-Za-z0-9_-]{1,64}$/.test(methodId) ? { methodId } : {}),
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
  // requires 只属于 next（下一段开始前的前置条件）。activity 上的同名字段不会被 validateDraft 执行，
  // 必须显式拒绝，避免模型以为自己给当前活动加了守卫。
  if (o.activity && typeof o.activity === 'object' && !Array.isArray(o.activity) && o.activity.requires !== undefined) {
    return { error: 'activity.requires 不是受支持的字段：requires 只用于 next.requires（下一段开始前按当时状态验收的前置条件），不会让当前活动带守卫。请把条件移到 next.requires；若现在就要做这段，删掉 activity.requires 并明确用 decision=new/adjust/detour/switch 写 activity' };
  }
  // continue 只表示原样执行原 routine。写着 activity（哪怕同名、同样技能、只改了参数）时执行哪一套
  // 含糊不清，退回去让它说明：改做法用 adjust/detour/switch + steps，排下一段用 next。
  if (kind === 'continue' && hasActivity && o.activity && Array.isArray(o.activity.steps) && o.activity.steps.length) {
    return { error: `decision=continue 但 activity 写了内容「${str(o.activity.what, 40)}」：继续当前活请省略 activity；continue 只会按原 routine「${currentWhat ?? '当前活动'}」照原参数继续，同名或同样动作里改了参数也不会被执行；要现在改做法请用 adjust（同一件事改 routine）/ detour / switch 并写出 steps，要排在当前活之后请写 next` };
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
  let idleGuardedNext = false;
  if (kind === 'continue' && !hasActivity) {
    const nextObj = o.next && typeof o.next === 'object' && !Array.isArray(o.next) ? o.next : null;
    // 带 requires 的 next（requires:null 也算写了，它是无效值）保留为排队 next，
    // 走和正常预排相同的 scope/epoch + 前置条件消费路径，不提升成无守卫的新活动。
    idleGuardedNext = !o.activity && !!nextObj && nextObj.requires !== undefined;
    if (!idleGuardedNext) {
      // 手上没活却写了 continue：把写好的 activity（或 next）当成新的一段。
      const candidate = o.activity ?? o.next;
      const v = candidate ? validateDraft(candidate, adapter, memory, notes, o.activity ? 'activity' : 'next') : null;
      if (v && !('error' in v)) { activity = v; kind = 'new'; promotedNext = !o.activity; notes.push('手上没活，continue 按 new 处理'); }
      else if (v && 'error' in v) return { error: v.error };
      else return { error: '手上没有正在做的活，不能 continue：请给出 decision=new 和一段 activity' };
    } else if (!Array.isArray(nextObj.steps) || !nextObj.steps.length) {
      return { error: '手上没有正在做的活，continue 的 next 带 requires 但没有可执行 steps：请给出 decision=new 和 activity，或在 next 里补上 1–6 个动作' };
    } else {
      notes.push('手上没活；带 requires 的 next 先排队，开始前按当时状态验收前置条件');
    }
  }
  if (kind === 'adjust' && !hasActivity) kind = 'new';
  if (kind === 'experiment' && activity) activity.kind = 'experiment';
  let next: NextDraft | undefined;
  if (o.next && !promotedNext && Array.isArray(o.next.steps) && o.next.steps.length) {
    const v = validateDraft(o.next, adapter, memory, notes, 'next');
    if ('error' in v) {
      if (idleGuardedNext) return { error: `continue 的 next 无法执行：${v.error}。请修正 steps/requires，或改用 decision=new 和 activity` };
      notes.push(`next 已忽略：${v.error}`);
    }
    else {
      // requires 是“轮到这段 next 时先验收”的前置条件，不是当前活动的收工条件；
      // 不套 doneWhenGap——下一段本来可以先去准备它需要的东西。无效条件不能悄悄丢掉后放行。
      let requires: Condition | undefined;
      if (o.next.requires !== undefined) {
        try { requires = validateCondition(normalizeDoneWhen(o.next.requires), adapter, memory, adapter.state()); }
        catch (e) {
          return { error: `next.requires 无效：${e instanceof Error ? e.message : String(e)}。要保留前置判断就改正这个条件；确实要无条件接上这一段，请在 next 里明确删掉 requires（不能用无效条件排一段没有守卫的活）` };
        }
        if (containsExploration(requires)) {
          return { error: 'next.requires 不能使用 exploration：exploration 依赖本段活动的实测探索回执（位移/新区块/看见目标），下一段开始前没有“这一次探索”可验收。请改用当前状态条件（inventory_min、location_near、self_state、equipment、inventory_full 等），或不写 requires' };
        }
      }
      next = { ...v, ...(requires ? { requires } : {}) };
    }
  }
  let agenda: MindDecision['agenda'];
  if (o.agenda && typeof o.agenda === 'object') {
    const a = o.agenda as Record<string, any>;
    agenda = {
      add: (Array.isArray(a.add) ? a.add : []).slice(0, 4).map((x: any) => {
        const note = str(x?.note, AGENDA_NOTE_MAX);
        return { text: str(typeof x === 'string' ? x : x?.text, 100),
          kind: (['goal', 'idea', 'question'].includes(x?.kind) ? x.kind : 'goal') as 'goal' | 'idea' | 'question',
          horizon: (x?.horizon === 'someday' ? 'someday' : 'today') as 'today' | 'someday',
          ...(note ? { note } : {}) };
      })
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
  const rawResult = o.experiment_result;
  const resultStatus = (v: unknown) => ['supported', 'refuted', 'unclear'].includes(String(v)) ? v as 'supported' | 'refuted' | 'unclear' : undefined;
  const verdict = resultStatus(rawResult);
  const settlementId = rawResult && typeof rawResult === 'object' ? str((rawResult as Record<string, unknown>).id, 20) : '';
  const settlementStatus = rawResult && typeof rawResult === 'object' ? resultStatus((rawResult as Record<string, unknown>).status) : undefined;
  const settlementEvidence = rawResult && typeof rawResult === 'object' ? str((rawResult as Record<string, unknown>).evidence, 160) : '';
  const experimentSettlement = settlementId && /^x_/.test(settlementId) && settlementStatus
    ? { id: settlementId, status: settlementStatus, ...(settlementEvidence ? { evidence: settlementEvidence } : {}) } : undefined;
  if (kind === 'experiment' && !hypothesis) notes.push('experiment 没写 hypothesis，这次只当普通尝试');
  return {
    kind, monologue, notes,
    ...(str(o.say, 120) && !str(o.say, 120).startsWith('/') ? { say: str(o.say, 120) } : {}),
    ...(activity ? { activity } : {}), ...(next ? { next } : {}), ...(agenda ? { agenda } : {}),
    ...(learned ? { learned } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(verdict ? { verdict } : {}), ...(experimentSettlement ? { experimentSettlement } : {}),
    ...(str(o.diary, 160) ? { diary: str(o.diary, 160) } : {}),
    ...(str(o.liked, 60) ? { liked: str(o.liked, 60) } : {}),
    ...(parseHabits(o.habits) ? { habits: parseHabits(o.habits)! } : {}),
    ...(o.skill && typeof o.skill === 'object' && !Array.isArray(o.skill) ? { skill: o.skill as Record<string, unknown> } : {}),
    ...(() => {
      const plan = parsePlan(o.plan, (c, i) => {
        try {
          const condition = validateCondition(normalizeDoneWhen(c), adapter, memory, adapter.state());
          // 清单勾选按当时状态核对，没有段活动的探索回执：exploration（min_distance/find）都不会自动勾。
          if (containsExploration(condition)) notes.push(`plan.steps[${i}].done_when 用了 exploration：清单勾选时按当前状态核对、没有本段探索回执，exploration（min_distance 或 find）都不会自动勾；要用能按当前状态核对的条件（location_near、self_state、inventory_min 等），或不写，做完看实际结果。`);
          return condition;
        }
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
  // 做法与成果分开：methods 只表示当前做法，换方法不删成果；method_drop 明确停用某个做法 id。
  const methods = o.methods === undefined ? undefined : (Array.isArray(o.methods) ? o.methods : [])
    .flatMap((x: unknown) => {
      const text = cleanPlanStep(str(typeof x === 'string' ? x : (x as any)?.text, 80));
      if (!text) return [];
      const outcome = Number((x as any)?.outcome);
      return [Number.isInteger(outcome) && outcome >= 0 && outcome < 8 ? { text, outcome } : { text }];
    })
    .slice(0, 8);
  const methodDrop = (Array.isArray(o.method_drop) ? o.method_drop : o.method_drop !== undefined ? [o.method_drop] : [])
    .filter((x: unknown): x is string => typeof x === 'string' && /^pm_[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 8);
  const focus = str(o.focus ?? o.agenda_id, 100), goal = str(o.goal, 100), switchReason = str(o.switch_reason, 120);
  // 只做形状解析；数量/条目上限由 setPlan 的 cleanNeeds 在存储边界处理。
  const needs = Array.isArray(o.needs) ? o.needs.flatMap((x: unknown) => {
    if (!x || typeof x !== 'object') return [];
    const n = x as Record<string, unknown>;
    return [{ item: str(n.item ?? n.name, 60), count: Number(n.count), ...(str(n.why, 60) ? { why: str(n.why, 60) } : {}) }];
  }) : undefined;
  if (!steps.length && !done.length && methods === undefined && !methodDrop.length && needs === undefined) return null;
  return { ...(focus ? { focus } : {}), ...(goal ? { goal } : {}), ...(steps.length ? { steps } : {}), ...(conditions.some(Boolean) ? { conditions } : {}), ...(done.length ? { done } : {}),
    ...(methods !== undefined ? { methods } : {}), ...(methodDrop.length ? { methodDrop } : {}),
    ...(needs !== undefined ? { needs } : {}),
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

  /** 供 Mind 做后台预取的 Hindsight 召回（每念联想，不阻塞思考） */
  get recall(): MemoryRecall | undefined { return this.planner.recall; }

  async think(ctx: MindContext, signal: AbortSignal): Promise<MindDecision> {
    const requestedAt = Date.now();
    if (!this.planner.autonomous) return this.ruleDecision(ctx, requestedAt);
    let tier = ctx.tier;
    let messages = buildMindMessages(ctx);
    let queries = 0, invalid = 0;
    let knowledgeBytes = 0;
    // 用这一念开始时的身体快照判断：水里低氧时不再升级到更慢的一轮，只把事实和“先给决定”的提示交给模型，选什么仍由它定。
    const lowAir = ctx.state.inWater && ctx.state.oxygen < LOW_AIR_OXYGEN;
    const lowAirHint = '现在人在水里、氧气不够，完整想一轮回来之前可能已经没气：先根据已有信息马上给出决定；想深一点等出水或氧气恢复后再说。';
    const suppressEscalation = (why: string) => this.bus.publish('llm_escalate_suppressed', 'P3', `水位低氧，先不升级成认真想：${why}`, { reason: ctx.reason, oxygen: ctx.state.oxygen });
    const knowledgeExhausted = JSON.stringify({ error: '本次思考的知识查询预算已用完，请根据已读资料作决定。' });
    const knowledgeReserve = Buffer.byteLength(knowledgeExhausted, 'utf8');
    // 同一念里按问题缓存资料结果：重复查同一问题不再访问后端，也不重复塞结果；
    // 无效决定重试时用最近一次结果摘要（last），都不重新查。
    const knowledgeMemo: { cache: Map<string, string>; last: string | null; retried: boolean } = { cache: new Map(), last: null, retried: false };
    const query = async (kind: string, raw: Record<string, unknown>) => {
      if (kind !== 'knowledge') return this.query(kind, raw, ctx, signal);
      const key = JSON.stringify(raw);
      if (knowledgeMemo.cache.has(key)) return '（与上次查询相同，结果同上一条，不再重复返回）';
      const remaining = 10_000 - knowledgeBytes;
      if (remaining < 512 + knowledgeReserve) {
        knowledgeBytes += knowledgeReserve;
        return knowledgeExhausted;
      }
      const result = await this.query(kind, raw, ctx, signal, remaining - knowledgeReserve);
      knowledgeBytes += Buffer.byteLength(result, 'utf8');
      knowledgeMemo.cache.set(key, result);
      knowledgeMemo.last = result;
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
        this.planner.noteInvalid(ctx.reason, error, c.text.slice(0, INVALID_OUTPUT_CHARS));
        // 查过资料后空回复/无效：把已查到的内容再压一遍交给它，并明确不要重复查询；只补这一次。
        if (knowledgeMemo.last && !knowledgeMemo.retried) {
          knowledgeMemo.retried = true;
          messages.push({ role: 'user', content: `刚才的回复无效（${error}）。资料已经查过，不要重复查询；根据这份资料给出决定：\n${knowledgeDigest(knowledgeMemo.last)}\n只输出一个简短的 JSON 对象（monologue 不超过 60 字）。` });
          continue;
        }
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
        if (tier === 'glance' && !lowAir) {
          tier = 'deliberate';
          this.planner.stats.tiers.escalated++;
          this.bus.publish('llm_escalate', 'P3', `抬头一看觉得需要好好想想：${String(raw.reason ?? ask).slice(0, 80)}`);
          messages = buildMindMessages({ ...ctx, tier });
          if (ask === 'deliberate' || ask === 'need_full_context') continue;
        }
        // 水位低氧时升级会再等一轮慢思考，来不及：留在瞥一眼这一轮，让它就地给出决定
        if (tier === 'glance' && lowAir && (ask === 'deliberate' || ask === 'need_full_context')) {
          suppressEscalation('模型要求更完整的思考');
          messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: lowAirHint });
          continue;
        }
      }
      if (QUERY_KINDS.includes(ask)) {
        if (queries >= 3) { messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: '这次的查询次数用完了，请根据已知信息给出决定。' }); continue; }
        queries++;
        const result = await query(ask, raw);
        if (lowAir && HEAVY_QUERY_KINDS.includes(ask)) suppressEscalation(`模型要查 ${ask}`);
        messages.push({ role: 'assistant', content: c.text.slice(0, 600) }, { role: 'user', content: `查询结果（只读，不是现场事实）：${result}\n剩余查询 ${3 - queries} 次。请继续：可以再查，或给出决定。${lowAir ? `\n${lowAirHint}` : ''}` });
        continue;
      }
      // 瞥一眼时把“想深一点”写成了动作：照它的意思转成认真想
      if (tier === 'glance' && wantsDeliberate(raw)) {
        if (lowAir) {
          suppressEscalation('把“想深一点”写成了动作');
          messages.push({ role: 'assistant', content: c.text.slice(0, 400) }, { role: 'user', content: lowAirHint });
          continue;
        }
        tier = 'deliberate';
        this.planner.stats.tiers.escalated++;
        this.bus.publish('llm_escalate', 'P3', '抬头一看觉得需要好好想想（把 deliberate 写成了动作）');
        messages = buildMindMessages({ ...ctx, tier });
        continue;
      }
      // 把查询（design/skill/recipes…）写成了 routine 里的一步：替它查了，再请它据此做决定
      const embedded = embeddedQuery(raw);
      if (embedded && queries < 3) {
        if (tier === 'glance' && ['knowledge'].includes(embedded.kind)) {
          if (lowAir) suppressEscalation(`把 ${embedded.kind} 查询写成了动作`);
          else {
            tier = 'deliberate';
            this.planner.stats.tiers.escalated++;
            this.bus.publish('llm_escalate', 'P3', `抬头一看觉得需要好好想想（把 ${embedded.kind} 查询写成了动作）`);
            messages = buildMindMessages({ ...ctx, tier });
          }
        }
        queries++;
        const result = await query(embedded.kind, embedded.args);
        messages.push({ role: 'assistant', content: c.text.slice(0, 1500) },
          { role: 'user', content: `${embedded.kind} 是思考时的查询，不是身体的动作，不能写进 steps。已经替你查了：${result}\n请据此给出决定（steps 里只写动作）。${lowAir ? `\n${lowAirHint}` : ''}` });
        continue;
      }
      if (firstDraft && raw?.keep === true) { this.planner.stats.ok++; return { ...firstDraft, source: 'llm', tier, requestedAt }; }
      const parsed = parseDecision(raw, this.adapter, this.memory, !!ctx.activity, ctx.activity?.what, ctx.activity?.steps.map((st) => st.skill));
      if ('error' in parsed) {
        // 模型已提出新决定，不能在新决定无效时擅自执行旧稿。
        firstDraft = null;
        invalid++;
        this.planner.noteInvalid(ctx.reason, parsed.error, c.text.slice(0, INVALID_OUTPUT_CHARS));
        if (knowledgeMemo.last && !knowledgeMemo.retried) {
          knowledgeMemo.retried = true;
          messages.push({ role: 'assistant', content: c.text.slice(0, 1500) },
            { role: 'user', content: `这个决定没法执行：${parsed.error}。资料已经查过，不要重复查询；根据它改正后只输出一个 JSON 对象：\n${knowledgeDigest(knowledgeMemo.last)}` });
          continue;
        }
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
        // 这一轮会多一次模型调用：记下来，日志里能看出是哪类写错在反复触发返工
        this.bus.publish('decision_repair', 'P3', `决定有几处写错，退回去让它改一次：${fixable.join('；').slice(0, 300)}`, { reason: ctx.reason, notes: fixable });
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
    // 反思只带与当前目标/议程（没有时退回最近经历）相关的知识摘录，最多 3 条，不把整个知识库塞进提示词。
    // 以当前目标和议程为主：把多段经历拼成搜索词会稀释中文关键词，真实知识库里反而一条都命中不了。
    const goals = [self.plan()?.goal, ...self.agenda().map((entry) => entry.text)].filter((text): text is string => !!text);
    const knowledgeQuery = (goals.length ? goals.slice(0, 2) : self.history(3).map((entry) => entry.what)).join(' ').slice(0, 120);
    const library = this.knowledge;
    const search = library && knowledgeQuery ? library.query({ query: knowledgeQuery, limit: 3 }) : null;
    const found = search?.action === 'search' ? search : null;
    // 只收有具体章节的命中：章节摘录可引用；没有章节的文档摘要只是标题串，不是事实。
    const matches = found?.matches.filter((match) => match.kind !== 'control' && match.section !== undefined) ?? [];
    const knowledge = library
      ? search?.action === 'error'
        ? { query: knowledgeQuery, edition: 'java' as const, version: library.version, evidence: 'reference_not_current_state' as const, matches, error: search.message }
        : found
          ? { query: knowledgeQuery, edition: found.edition, version: found.version, evidence: found.evidence, matches }
          : null
      : null;
    // 成功的检索也留下记录：没有命中同样是一次真实结果，不能和“没查”混在一起。
    if (knowledge) this.bus.publish('knowledge_query', 'P3', `回想时查知识：${knowledgeQuery.slice(0, 60)}（${matches.length} 条相关章节）`, { matches: matches.length, source: 'reflection' });
    const messages = buildReflectionMessages(self, persona, this.book?.list().filter((k) => k.source === 'self').map((k) => `${k.name}：${k.description}`) ?? [], strategy, this.memory, knowledge);
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
      if (kind === 'knowledge') {
        if (!this.knowledge) return '知识库未启用，无法查询游戏资料';
        const result = this.knowledge.query(raw, maxBytes);
        // 查到的资料摘录跨重启保留：下一次思考和回想还能对照，不因空回复或重连丢掉。
        // 只有命中具体章节的搜索才算“事实”；操作手册（control）不是游戏百科，不混进资料。
        const facts = result.action === 'search'
          ? result.matches.flatMap((match) => match.kind !== 'control' && match.section
            ? [{ docId: match.id, title: match.title, section: match.section, sectionTitle: match.sectionTitle, fact: match.excerpt }]
            : [])
          : result.action === 'read'
            ? result.document.kind === 'control' ? []
              : 'contents' in result.document
                ? result.document.contents.length ? [{ docId: result.document.id, title: result.document.title,
                    fact: `章节：${result.document.contents.map((section) => section.title).join('；')}`.slice(0, 120) }] : []
                : result.document.sections.flatMap((section) => 'text' in section && section.text
                  ? [{ docId: result.document.id, title: result.document.title, section: section.id, sectionTitle: section.title,
                      fact: section.text.split(/\n|。/)[0].slice(0, 120) }]
                  : [])
            : [];
        if (facts.length) ctx.self.recordKnowledgeFacts(facts);
        this.bus.publish('knowledge_query', 'P3', `查知识：${String(raw.id ?? raw.query ?? '目录').slice(0, 80)}`);
        return JSON.stringify(result);
      }
      if (kind === 'moves') {
        const names = (Array.isArray(raw.names) ? raw.names : [raw.name ?? raw.names]).map((n: unknown) => String(n ?? '').trim()).filter(Boolean);
        return names.length ? moveDetails(names) : moveDirectory();
      }
      if (kind === 'terrain') {
        // 只读地形：先看周围高差/水/树/人造方块/悬空；给了宽深再按这个足印找附近可整的平地。
        const radius = raw.radius === undefined ? 8 : Number(raw.radius);
        if (!Number.isInteger(radius) || radius < 4 || radius > 16) return 'terrain.radius 需要 4–16 的整数';
        const width = raw.width === undefined ? undefined : Number(raw.width);
        const depth = raw.depth === undefined ? undefined : Number(raw.depth);
        if ((width === undefined) !== (depth === undefined)) return 'terrain 的 width/depth 要一起写';
        if (width !== undefined && depth !== undefined && (!Number.isInteger(width) || width < 1 || width > 16 || !Number.isInteger(depth) || depth < 1 || depth > 16)) {
          return 'terrain 的 width/depth 需要 1–16 的整数（只读估算，不施工）';
        }
        const sketch = terrainSketch(this.adapter, radius);
        this.bus.publish('terrain_query', 'P3', `查地形：半径 ${radius}${width === undefined ? '' : `，足印 ${width}×${depth}`}`);
        const base = {
          center: sketch.center, radius, summary: sketch.summary, rows: sketch.rows,
          legend: '数字=地表相对中心高/低；~ 水；? 看不清；T 树；A 人造方块（门/黑曜石/建筑）；! 地表下悬空或支撑未知',
        };
        if (width === undefined || depth === undefined) {
          return JSON.stringify({
            ...base,
            note: 'rows 是当前视野内看到的；要按某个建筑的足印找可整地块，再加 width/depth（1–16）。',
          }).slice(0, 4000);
        }
        const spec = {
          width, depth, height: 4, layout: 'custom' as const, maxFoundationDepth: 4,
          components: [
            { pos: { x: 0, y: 0, z: 0 }, name: 'stone', properties: {}, phase: 'foundation' as const, tags: ['floor', 'support'], dependsOn: [] },
            { pos: { x: width - 1, y: 0, z: depth - 1 }, name: 'stone', properties: {}, phase: 'foundation' as const, tags: ['floor', 'support'], dependsOn: [] },
          ],
        };
        const survey = surveyBuildSite(this.adapter, this.memory, spec, { radius: 8 });
        const here = this.adapter.state().pos;
        const best = survey.best && (() => {
          const dx = survey.best!.origin.x - here.x, dz = survey.best!.origin.z - here.z;
          return {
            origin: survey.best!.origin, rotation: survey.best!.rotation,
            cut: survey.best!.cut, fill: survey.best!.fill, dist: survey.best!.dist,
            bearing: { dir: Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'E' : 'W') : (dz >= 0 ? 'S' : 'N'), dist: Math.round(Math.hypot(dx, dz)) },
          };
        })();
        const hint = ({ N: '北', S: '南', E: '东', W: '西' } as Record<string, string>)[survey.hint ?? ''] ?? survey.hint;
        return JSON.stringify({
          ...base,
          footprint: {
            width, depth, best,
            rejected: survey.rejected,
            rejected_legend: 'wet=挨水/岩浆，uneven=坡太陡或整地量大，hazard=出过事的危险区，artificial=有人造方块，unsupported=地基下面悬空/支撑太深，unknown=看不清/未加载，occupied=和自己别的工地重叠',
            hint: hint ?? null,
          },
          note: 'best 是附近 8 格内按这个足印挑的可整地块（cut/fill 是估算的铲/填量；rotation 是估算时用的朝向；只读）。选址/施工仍由你决定。',
        }).slice(0, 4000);
      }
      if (kind === 'construction') {
        // 只读建造顺序：spec 按阶段/层排；cells 按层和可贴面排，并列出需要先放的临时支撑。
        const hasSpec = raw.spec !== undefined;
        const cellsRaw = raw.cells;
        if (hasSpec === Array.isArray(cellsRaw)) return 'construction 只写 spec 或 cells 之一';
        if (hasSpec) {
          let spec;
          try { spec = normalizeSpec(raw.spec); } catch (e) { return `construction.spec 无效：${(e as Error).message}`; }
          this.bus.publish('construction_query', 'P3', `查建造顺序：spec ${spec.name}`);
          return boundConstruction(planConstruction(this.adapter, { spec }));
        }
        if (!Array.isArray(cellsRaw) || cellsRaw.length < 1 || cellsRaw.length > 150) return 'construction.cells 需要 1–150 项 {pos:[x,y,z],item:"…"}';
        const cells: { pos: { x: number; y: number; z: number }; name: string }[] = [];
        for (const c of cellsRaw) {
          const pos = Array.isArray(c?.pos) ? c.pos : null;
          const item = String(c?.item ?? '').trim();
          if (!pos || pos.length !== 3 || !pos.every((v: unknown) => Number.isInteger(v)) || !item) return 'construction.cells 每项需要整数 pos:[x,y,z] 和 item';
          cells.push({ pos: { x: pos[0], y: pos[1], z: pos[2] }, name: item });
        }
        const keepClear: { x: number; y: number; z: number }[] = [];
        for (const p of Array.isArray(raw.keepClear) ? raw.keepClear : []) {
          if (!Array.isArray(p) || p.length !== 3 || !p.every((v: unknown) => Number.isInteger(v))) return 'construction.keepClear 每项需要整数 [x,y,z]';
          keepClear.push({ x: p[0], y: p[1], z: p[2] });
        }
        const maxSupport = raw.maxSupport === undefined ? undefined : Number(raw.maxSupport);
        if (maxSupport !== undefined && (!Number.isInteger(maxSupport) || maxSupport < 1 || maxSupport > 12)) return 'construction.maxSupport 需要 1–12 的整数';
        this.bus.publish('construction_query', 'P3', `查建造顺序：${cells.length} 格`);
        return boundConstruction(planConstruction(this.adapter, { cells, keepClear, ...(maxSupport === undefined ? {} : { maxSupport }) }));
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
        if (this.designing) return `建筑师还在画「${this.designing.brief.slice(0, 40)}」，画好会告诉你；先去做别的，别重复请`;
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
        return `已经请建筑师去画「${brief.slice(0, 60)}」了：画好会告诉你（图纸会出现在 my_drafts）。先去做别的——攒木头石头、找吃的都行，不用干等`;
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
      if (kind === 'progress') {
        const target = String(raw.target ?? raw.outcome ?? '').trim();
        this.bus.publish('progress_query', 'P3', `查进展：${target || '全部目标'}`, { target: target || null });
        const detail = target ? ctx.self.progressLedger(target) : ctx.self.progressLedger();
        return detail === null ? `没有目标 ${target} 的进展记录` : JSON.stringify(detail).slice(0, 6000);
      }
      const recall = this.planner.recall;
      if (!recall) {
        const q = String(raw.query ?? '').slice(0, 300);
        if (!q.trim()) return '想回忆什么？写 {"kind":"recall","query":"关键词"}';
        const found = recallLocal(q, { self: ctx.self, memory: this.memory, book: this.book, ledger: this.ledger }, { n: 8 });
        this.bus.publish('recall_local', 'P3', `回想：${q.slice(0, 60)}（${found.length} 条）`, {
          backend: 'local', hits: found.length, injectedIds: found.flatMap((r) => r.ref ? [r.ref] : []), degraded: false });
        return found.length ? found.map((r) => `[${RECALL_LABEL[r.kind]}] ${r.text}`).join('\n') : '想不起和这些关键词有关的事';
      }
      const res = await recall.recall({ percept: { self: { dim: ctx.percept.self.dim, pos: ctx.percept.self.pos }, objective: null, nearby: ctx.percept.nearby },
        lastFailure: null, userSuggestion: ctx.userSuggestion }, String(raw.query ?? '').slice(0, 400));
      const output = boundedJson(res.memories, 1500);
      // 注入的是裁剪后的 tool 结果：以实际输出的 ID 为准，才能区分“检索恢复”和“命中却因预算没进上下文”。
      const injected = JSON.parse(output) as { id?: unknown }[];
      this.bus.publish('memory_inject', 'P3', `长期记忆注入 ${injected.length}/${res.memories.length} 条（${res.source}）`, {
        backend: res.source, hits: res.memories.length, injectedIds: injected.flatMap((m) => typeof m.id === 'string' ? [m.id] : []),
        dropped: injected.length < res.memories.length ? ['output_budget'] : [] });
      return output;
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
  const lessonDraft = (value: unknown) => {
    const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const limits = (Array.isArray(object?.limits) ? object.limits : [])
      .map((entry) => cleanLesson(String(entry ?? ''))).filter((entry) => entry.length >= 2).slice(0, 4);
    return { id: String(object?.id ?? ''), text: cleanLesson(typeof value === 'string' ? value : String(object?.text ?? '')), limits };
  };
  const merge = (Array.isArray(o.merge) ? o.merge : []).map((m: any) => ({ ids: [...new Set(ids(m?.ids, knowHowIds))], text: cleanLesson(String(m?.text ?? '')) }))
    .filter((m: { ids: string[]; text: string }) => m.ids.length >= 2 && m.text.length >= 4 && m.ids.every((id) => !used.has(id)) && (m.ids.forEach((id) => used.add(id)), true));
  const rewrite = (Array.isArray(o.rewrite) ? o.rewrite : []).flatMap((raw) => {
    const draft = lessonDraft(raw);
    if (!knowHowIds.has(draft.id) || used.has(draft.id) || draft.text.length < 4) return [];
    used.add(draft.id);
    return [{ id: draft.id, text: draft.text, ...(draft.limits.length ? { limits: draft.limits } : {}) }];
  });
  const drop = ids(o.drop, knowHowIds).filter((id) => !used.has(id));
  const add = (Array.isArray(o.add) ? o.add : []).flatMap((raw) => {
    const draft = lessonDraft(raw);
    return draft.text.length < 4 ? [] : [draft.limits.length ? { text: draft.text, limits: draft.limits } : draft.text];
  }).slice(0, 5);
  const sk = o.skill && typeof o.skill === 'object' && !Array.isArray(o.skill) ? o.skill as Record<string, unknown> : null;
  const executable = !!sk && (Array.isArray(sk.steps) || sk.when !== undefined);
  const skill = sk && typeof sk.name === 'string' && typeof sk.description === 'string' && (typeof sk.body === 'string' && sk.body.trim().length >= 20 || executable)
    ? { name: sk.name.slice(0, 41), description: sk.description.slice(0, 200), body: typeof sk.body === 'string' ? sk.body.slice(0, 6000) : '', ...(executable ? { raw: sk } : {}) } : undefined;
  const agendaAdd = (Array.isArray(o.agenda_add) ? o.agenda_add : []).map((a: any) => typeof a === 'string' ? { text: a } : a)
    .map((a: any) => ({ text: str(a?.text, 60), kind: a?.kind === 'goal' ? 'goal' as const : 'idea' as const, horizon: a?.horizon === 'someday' ? 'someday' as const : 'today' as const,
      ...(str(a?.note, 80) ? { note: str(a?.note, 80) } : {}) }))
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

/** 建造计划按组截断，保证返回完整 JSON；omitted 说明这一组还有多少格没列出。 */
function boundConstruction(plan: ConstructionPlan): string {
  for (const limit of [24, 12, 6, 3]) {
    const part = (cells: unknown[], y?: number) => ({
      ...(y === undefined ? {} : { y }),
      cells: cells.slice(0, limit),
      ...(cells.length > limit ? { omitted: cells.length - limit } : {}),
    });
    const text = JSON.stringify({
      ...plan,
      ...(plan.phases ? { phases: plan.phases.map((p) => ({ phase: p.phase, ...part(p.cells) })) } : {}),
      order: plan.order.slice(0, 16).map((l) => part(l.cells, l.y)),
      ...(plan.order.length > 16 ? { layersOmitted: plan.order.length - 16 } : {}),
      temporary: plan.temporary.slice(0, limit),
      ...(plan.temporary.length > limit ? { temporaryOmitted: plan.temporary.length - limit } : {}),
      warnings: plan.warnings.slice(0, 8),
      ...(plan.warnings.length > 8 ? { warningsOmitted: plan.warnings.length - 8 } : {}),
    });
    if (text.length <= 6000) return text;
  }
  return JSON.stringify(plan);
}
