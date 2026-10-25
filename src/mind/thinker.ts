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
import { buildMindMessages, buildReflectionMessages, moveDetails, type MindContext } from './prompt.ts';
import type { SelfModel } from './self.ts';
import { cleanLesson } from './self.ts';
import { designBuilding } from '../building/architect.ts';
import { terrainSketch } from '../building/site.ts';
import { homeOf } from './home.ts';
import { draftsFor } from '../building/drafts.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import { describeBuild, myBuilds } from './home.ts';

/** 思考时可以先做的只读查询（不占游戏时间） */
const QUERY_KINDS = ['recipes', 'recall', 'mechanics', 'skill', 'design', 'moves'];
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
  const dropped: string[] = [];
  for (const [i, s0] of o.steps.slice(0, 6).entries()) {
    const s = normalizeStep(s0) as Record<string, any>;
    const name = String(s?.skill ?? '');
    const skill = SKILLS[name];
    const raw = `${name} ${JSON.stringify(s?.args ?? {}).slice(0, 60)}`;
    if (!skill || LLM_HIDDEN.has(name)) { errors.push(`steps[${i}] 没有 "${name}" 这个技能`); dropped.push(`${raw}（没有这个动作）`); continue; }
    const v = skill.validate(s?.args ?? {}, adapter);
    if (!v.ok) { errors.push(`steps[${i}] ${name} 参数错误：${v.error}`); dropped.push(`${raw}（参数写错）`); continue; }
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
  // 说着 continue，却写了一段新的活（带 steps、what 也换了）：嘴上没改口，心里已经换了，按 adjust 处理
  if (kind === 'continue' && hasActivity && currentWhat && o.activity && Array.isArray(o.activity.steps) && o.activity.steps.length
    && typeof o.activity.what === 'string' && o.activity.what.trim() && o.activity.what.trim() !== currentWhat.trim()
    // 只是换了个说法、做法一样（同一串动作）：还是 continue，不打断手上的活
    && (!currentSkills || o.activity.steps.map((st: any) => String(st?.skill ?? '')).join('>') !== currentSkills.join('>'))) {
    kind = 'adjust';
    notes.push(`说的是 continue，但写了新的活「${str(o.activity.what, 40)}」，按 adjust 处理`);
  }
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
  let promotedNext = false;
  if (kind === 'continue' && !hasActivity) {
    // 手上没活却写了 continue：把写好的 activity（或 next）当成新的一段
    const candidate = o.activity ?? o.next;
    const v = candidate ? validateDraft(candidate, adapter, memory, notes, o.activity ? 'activity' : 'next') : null;
    if (v && !('error' in v)) { activity = v; kind = 'new'; promotedNext = !o.activity; notes.push('手上没活，continue 按 new 处理'); }
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
  };
}

/**
 * 思考器：把当前的心思（念头、情绪、议程、窍门、感知）交给模型，拿回一次“像人一样”的决定。
 * mock 模式下用规则凑出同样形状的决定，整条链路保持一致。
 */
export class Thinker {
  /** 正在后台画的图纸 */
  designing: { brief: string; startedAt: number } | null = null;
  constructor(private planner: Planner, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private book: SkillBook | null = null) {}

  get autonomous() { return this.planner.autonomous; }
  get skillBook(): SkillBook | null { return this.book; }

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
      if (ask === 'deliberate' || ask === 'need_full_context' || (tier === 'glance' && QUERY_KINDS.includes(ask))) {
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
        const result = await this.query(ask, raw, ctx, signal);
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
        queries++;
        const result = await this.query(embedded.kind, embedded.args, ctx, signal);
        messages.push({ role: 'assistant', content: c.text.slice(0, 1500) },
          { role: 'user', content: `${embedded.kind} 是思考时的查询，不是身体的动作，不能写进 steps。已经替你查了：${result}\n请据此给出决定（steps 里只写动作）。` });
        continue;
      }
      const parsed = parseDecision(raw, this.adapter, this.memory, !!ctx.activity, ctx.activity?.what, ctx.activity?.steps.map((st) => st.skill));
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
    const messages = buildReflectionMessages(self, persona, this.book?.list().filter((k) => k.source === 'self').map((k) => `${k.name}：${k.description}`) ?? []);
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

  private async query(kind: string, raw: Record<string, any>, ctx: MindContext, signal?: AbortSignal): Promise<string> {
    try {
      if (kind === 'moves') {
        const names = (Array.isArray(raw.names) ? raw.names : [raw.name ?? raw.names]).map((n: unknown) => String(n ?? '').trim()).filter(Boolean);
        return names.length ? moveDetails(names) : '要查哪些动作？写 {"kind":"moves","names":["动作名"]}';
      }
      if (kind === 'skill') {
        const skill = this.book?.get(String(raw.name ?? '').trim());
        if (!skill) return `没有叫「${String(raw.name ?? '')}」的技能；有这些：${this.book?.index().join('；') ?? '（没有技能书）'}`;
        this.bus.publish('skill_read', 'P3', `翻开技能：${skill.name}`, { name: skill.name, source: skill.source });
        return `技能「${skill.name}」：\n${skill.body}`.slice(0, 9000);
      }
      if (kind === 'design') {
        const brief = String(raw.brief ?? raw.request ?? '').trim().slice(0, 400);
        if (!brief) return '要设计什么？写 {"kind":"design","brief":"想要的建筑：用途、大概多大、风格、在哪儿"}';
        // 建筑师在后台画：想得久（几分钟），这段时间心智照常玩，画好了作为“注意到的事”回来
        if (this.designing) return `建筑师还在画「${this.designing.brief.slice(0, 40)}」（已经 ${Math.max(1, Math.round((Date.now() - this.designing.startedAt) / 60_000))} 分钟），画好会告诉你；先去做别的，别重复请`;
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
        return `已经请建筑师去画「${brief.slice(0, 60)}」了：要想几分钟，画好会告诉你（图纸会出现在 my_drafts）。这段时间先去做别的——攒木头石头、找吃的都行，不用干等`;
      }
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
  const sk = o.skill && typeof o.skill === 'object' && !Array.isArray(o.skill) ? o.skill as Record<string, unknown> : null;
  const skill = sk && typeof sk.name === 'string' && typeof sk.description === 'string' && typeof sk.body === 'string' && sk.body.trim().length >= 20
    ? { name: sk.name.slice(0, 41), description: sk.description.slice(0, 200), body: sk.body.slice(0, 6000) } : undefined;
  return { rewrite, merge, drop, add, agendaDrop: ids(o.agenda_drop, agendaIds), ...(skill ? { skill } : {}),
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
