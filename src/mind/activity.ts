import type { AgentState } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { Percept } from '../perception/perception.ts';
import { FACINGS, feetCell, toWorld, type Facing } from '../perception/local.ts';
import { evaluateCondition, type ConditionPerception } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import { STANCE_MOVES } from '../skills/stance.ts';
import { PLACEABLE } from '../skills/survival.ts';
import type { SkillResult } from '../skills/types.ts';
import { shortId } from '../util.ts';
import type { Activity, ActivityDraft, ActivityOutcome, ActivityRecord, ActivityStep, CollectionReceipt, NavigationProgress } from './types.ts';

/**
 * 截断长反馈时同时保留头尾：开头交代是哪一步/什么失败，结尾常带可执行事实
 * （如 `→ mine_cell {"at":[-1,2,0],"facing":"N"}`）。只留开头会把下一步动作切掉，
 * agent 就会照着半截话重做错事。默认 320 字，兼顾提示词成本。
 */
export function clipFeedback(text: string, max = 320): string {
  if (text.length <= max) return text;
  // max 太小时 head+tail 会挤掉分隔符，tail=0 时 slice(-0) 还会返回整串；直接硬截。
  if (max <= 5) return text.slice(0, max);
  const head = Math.ceil((max * 2) / 3);
  const tail = max - head - 1;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export const inventoryOf = (s: Pick<AgentState, 'inventory'>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of s.inventory) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
};

/** 物品名在技能参数里可能带 `minecraft:` 前缀，背包账本用不带前缀的名字。 */
const itemBaseName = (name: string) => name.replace(/^minecraft:/, '');

export function diffInventory(before: Record<string, number>, after: Record<string, number>) {
  const gained: Record<string, number> = {}, lost: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d;
  }
  return { gained, lost };
}

/**
 * 同一逻辑动作的原始派发额度：绝对期限与开工背包。
 * 自动重试/续跑沿用这份账本；新的一段活（新的 Agent 委托）重新起算，不设全局配额。
 * 只放在内存里，随 Activity 一起被回收。
 */
type StepLedger = {
  deadline: number;
  resume: boolean;
  /** Inventory snapshot at the previous dispatch, so consumption accumulates per attempt. */
  last: Record<string, number>;
  /** Normalized item name -> units lost across attempts. Pickups cannot erase prior spend. */
  spent: Record<string, number>;
};
const ledgers = new WeakMap<Activity, Map<string, StepLedger>>();
const stepKeyOf = (step: Step) => step.id ?? `${step.skill}:${JSON.stringify(step.args ?? {})}`;

function ledgerOf(a: Activity) {
  let map = ledgers.get(a);
  if (!map) {
    map = new Map();
    ledgers.set(a, map);
  }
  return map;
}

/** 派发前读取这个逻辑动作的期限与材料基线；只有被标记为自动续跑的动作沿用旧账本。 */
export function beginStep(a: Activity, step: Step, state: Pick<AgentState, 'inventory'>) {
  const map = ledgerOf(a);
  const key = stepKeyOf(step);
  const previous = map.get(key);
  const continuation = previous?.resume === true;
  const inventory = inventoryOf(state);
  if (!previous || !continuation) {
    map.set(key, {
      deadline: Date.now() + (SKILLS[step.skill]?.timeoutMs ?? 0),
      resume: false,
      last: inventory,
      spent: {},
    });
  } else {
    previous.resume = false;
    const { lost } = diffInventory(previous.last, inventory);
    for (const [name, count] of Object.entries(lost)) {
      const base = itemBaseName(name);
      previous.spent[base] = (previous.spent[base] ?? 0) + count;
    }
    previous.last = inventory;
  }
  const ledger = map.get(key)!;
  return { deadlineMs: ledger.deadline, remainingMs: ledger.deadline - Date.now(), continuation };
}

/** 标记下一次派发是同一逻辑动作的自动重试/续跑，而不是新的独立动作。 */
export function markContinuation(a: Activity, step: Step | undefined) {
  if (!step) return;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (ledger) ledger.resume = true;
}

/** 新一轮 routine 是同一段活里的再次执行，按新一次派发重新起算，不继承上一轮的期限与耗材。 */
function resetStepBudgets(a: Activity) {
  ledgers.delete(a);
}

/**
 * 原委托声明的材料额度。当前 schema 里只有这两处能表达数量：
 * - pillar_one 的一次原地垫高：最多消耗 1 个垫脚方块；
 * - place_cell / place_support 的一次放置：最多花 1 个指定物品。
 * 通用 make 只是 boolean，没有数量，不能在这里假装有额度。
 */
function materialAllowance(a: Activity, step: Step, state: AgentState) {
  const args = (step.args ?? {}) as Record<string, unknown>;
  const item = typeof args.item === 'string' && args.item !== 'any' ? itemBaseName(args.item) : null;
  const declared = step.skill === 'pillar_one'
    ? { max: 1, names: null as Set<string> | null }
    : (step.skill === 'place_cell' || step.skill === 'place_support')
      ? { max: 1, names: item === null ? null : new Set([item]) }
      : undefined;
  if (!declared || declared.max <= 0) return undefined;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (!ledger) return undefined;
  // Consumption accumulates across attempts; a later pickup of the same item
  // must not erase earlier spend. Include the loss since the last dispatch so a
  // just-finished attempt is counted before the next beginStep folds it in.
  const { lost } = diffInventory(ledger.last, inventoryOf(state));
  const spent: Record<string, number> = { ...ledger.spent };
  for (const [name, count] of Object.entries(lost)) {
    const base = itemBaseName(name);
    spent[base] = (spent[base] ?? 0) + count;
  }
  const consumed = Object.entries(spent).reduce((n, [name, count]) =>
    n + ((declared.names ? declared.names.has(itemBaseName(name)) : PLACEABLE.includes(itemBaseName(name))) ? count : 0), 0);
  return { max: declared.max, consumed, remaining: Math.max(0, declared.max - consumed) };
}

/** 自动重试前检查原委托的期限与材料额度；返回停止原因，未超限时返回 undefined。 */
function continuationGuard(a: Activity, step: Step | undefined, state: AgentState) {
  if (!step) return undefined;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (ledger && Date.now() >= ledger.deadline) return `「${step.skill}」的自动重试沿用的是原动作期限，现在已经到期；不再拿一个新的超时重来`;
  const material = materialAllowance(a, step, state);
  if (material && material.remaining <= 0) return `「${step.skill}」的自动重试不能超出原委托的材料额度：已消耗 ${material.consumed}，额度 ${material.max}；不再自动花材料`;
  return undefined;
}

/** 技能回执里明确报告的导航阶段（如 navigate_to 的 nav.outcome）；没有报告就不编。 */
function reportedStage(result: SkillResult): string | undefined {
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const data = result.data;
  const nav = data?.nav && typeof data.nav === 'object' ? data.nav as Record<string, unknown> : undefined;
  return text(nav?.stage) ?? text(nav?.outcome) ?? text(data?.stage);
}

/** 做法的“签名”：技能 + 主要对象，用来认出“同一套做法”，修正窍门的成败次数 */
export function signatureOf(steps: Step[]): string {
  return steps.map((st) => {
    const a = (st.args ?? {}) as Record<string, unknown>;
    const key = a.block ?? a.item ?? a.animal ?? a.target ?? a.blueprint ?? a.crop ?? a.for ?? a.direction ?? '';
    return key && typeof key !== 'object' ? `${st.skill}:${String(key)}` : st.skill;
  }).join('>');
}

export function targetKeyOf(step: Step): string {
  const a = (step.args ?? {}) as Record<string, unknown>;
  const target = a.target ?? a.block ?? a.item ?? a.animal ?? a.projectId ?? a.blueprint ?? a.for ?? a.direction ?? '';
  return `${step.skill}:${typeof target === 'object' && target ? JSON.stringify(target) : String(target)}`;
}

/** 只有位置相关的接触/支撑事实（around）变化才算新的重试依据；转头会改变 vision.view 与 nearby.resources（无关资源），不能当作环境变化触发原样重试。 */
export function viewOf(p?: Percept): string | undefined {
  return p ? JSON.stringify({ around: p.self.around }) : undefined;
}

/**
 * 自动重试只看失败回执里实际观测到的相关事实：支撑/净空、目标格、进度、额度和身体位置。
 * 转头、背包/附近资源增减、无关火把不在其中，不能用来给同一缺口再要一次重试。
 * pillarClearance 由 pillar_one 的失败回执真实产出（movement/primitives.ts），属于缺口证据。
 */
const GAP_EVIDENCE_FIELDS = [
  'movementNotAttempted', 'obscured', 'failureCause', 'pillarFailure', 'pillarClearance', 'reference', 'occupied',
  'problems', 'landingSupport', 'completedSteps', 'excavatedBlocks', 'ascendedLevels', 'descendedLevels',
  'goalReached', 'climbed', 'spent', 'targetCell', 'target', 'targetFoot', 'was', 'drop', 'expectedFoot', 'below', 'partialStop',
  'unsupportedGeometry', 'problem', 'placementEffect', 'cavity', 'position', 'placed', 'consumed',
] as const;

function gapEvidence(result: SkillResult): string {
  const data = result.data;
  const stage = reportedStage(result);
  if (!data) return stage ? `{"navStage":${JSON.stringify(stage)}}` : '';
  const picked: Record<string, unknown> = {};
  for (const key of GAP_EVIDENCE_FIELDS) if (data[key] !== undefined) picked[key] = data[key];
  if (stage) picked.navStage = stage;
  const text = JSON.stringify(picked);
  return text.length > 240 ? text.slice(0, 240) : text;
}

/** 短指纹：把“同一技能/参数/失败码/证据版本”记进 adaptations，避免长参数撑大提示词。 */
function digest(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** 会让身体走向目的地或为其做只读预览的动作；只有它们参与导航目标。相对 move_step 不在此列。 */
const NAVIGATION_SKILLS = new Set(['plan_route', 'navigate_to', 'advance']);

type NavPoint = { x: number; y: number; z: number };

const navPoint = (value: unknown): NavPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

const sameNavPoint = (a: NavPoint, b: NavPoint) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01;

/** 只接受 Agent 明确给出的绝对目的地；相对 at 不在移动后重新解析。 */
function addressedTarget(step: Step): NavPoint | null {
  const args = (step.args ?? {}) as Record<string, unknown>;
  const to = navPoint(args.to);
  if (to) return to;
  const target = navPoint(args.target);
  if (target) return target;
  const xyz = args.xyz;
  return Array.isArray(xyz) && xyz.length === 3
    && xyz.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { x: xyz[0] as number, y: xyz[1] as number, z: xyz[2] as number } : null;
}

const navPoints = (value: unknown): NavPoint[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const point = navPoint(item) ?? navPoint((item as { to?: unknown } | null)?.to);
    return point ? [point] : [];
  });
};

/** 回执里已确认的段数：navigate_to/advance 报 executed，兼容旧的 confirmedSegments 字段。 */
function confirmedSegmentsOf(data: Record<string, unknown>): number {
  if (typeof data.confirmedSegments === 'number' && Number.isFinite(data.confirmedSegments)) return data.confirmedSegments;
  return typeof data.executed === 'number' && Number.isFinite(data.executed) ? data.executed : 0;
}

function adoptDestination(nav: NavigationProgress, target: NavPoint) {
  nav.destination = { ...target };
  nav.remaining = [{ ...target }];
}

/** 已退役的 route handle 不再产生失效报告；只认回执顶层明确给出的失效原因。 */
function invalidationReasonOf(data: Record<string, unknown>): string | undefined {
  const invalidation = data.invalidation as { reason?: unknown } | undefined;
  return typeof invalidation?.reason === 'string' && invalidation.reason ? invalidation.reason : undefined;
}

function newNavigation(a: Activity, state: Pick<AgentState, 'pos' | 'worldId' | 'dim'>): NavigationProgress {
  const destination = a.steps
    .filter((step) => NAVIGATION_SKILLS.has(step.skill))
    .map(addressedTarget)
    .find((point): point is NavPoint => point !== null);
  const now = Date.now();
  const nav: NavigationProgress = {
    delegationId: a.id,
    ...(a.doneWhen ? { arrivalCondition: a.doneWhen } : {}),
    worldId: state.worldId, dim: state.dim,
    measured: { pos: { ...state.pos }, at: now },
    completedSegments: 0,
    remaining: [],
    phase: 'planning', updatedAt: now,
  };
  if (destination) adoptDestination(nav, destination);
  return nav;
}

/**
 * 派发下一段前复核实测位置，并保留父委托的期限快照。
 * 期限来自现有 beginStep/stepExpiry 账本；这里不新建预算，也不延长它。
 */
export function noteNavigationDispatch(
  a: Activity, step: Step,
  state: Pick<AgentState, 'pos' | 'worldId' | 'dim'>,
  opts: { deadlineMs?: number } = {},
) {
  const nav = a.navigation;
  if (!NAVIGATION_SKILLS.has(step.skill) || !nav) return undefined;
  const now = Date.now();
  const destination = addressedTarget(step);
  if (!nav.destination && destination) adoptDestination(nav, destination);
  nav.worldId = state.worldId;
  nav.dim = state.dim;
  nav.measured = { pos: { ...state.pos }, at: now };
  nav.segmentStart = { ...state.pos };
  if (opts.deadlineMs !== undefined) nav.parentDeadlineMs = opts.deadlineMs;
  nav.phase = step.skill === 'plan_route' ? 'planning' : 'executing';
  nav.updatedAt = now;
  return nav;
}

/**
 * 把一步的实测回执并入当前导航目标：更新实测位置、已完成段、剩余目标、来源和失效/失败。
 * 只保留当前委托的一份状态；路线几何、traversal 和体素仍留在共享空间库。
 */
function noteNavigationResult(
  a: Activity, step: Step,
  result: Pick<SkillResult, 'status' | 'failureCode' | 'summary' | 'data'>,
  state: AgentState,
) {
  const nav = a.navigation;
  if (!nav) return undefined;
  const now = Date.now();
  nav.measured = { pos: { ...state.pos }, at: now };
  nav.updatedAt = now;
  if (!NAVIGATION_SKILLS.has(step.skill)) return nav;
  const data = (result.data ?? {}) as Record<string, unknown>;
  const segment = data.segment && typeof data.segment === 'object' ? data.segment as Record<string, unknown> : undefined;
  const requested = navPoint(data.requestedTarget) ?? navPoint(data.to) ?? addressedTarget(step);
  if (!nav.destination && requested) adoptDestination(nav, requested);
  const confirmed = confirmedSegmentsOf(data);
  const source = [data.source, data.backend].find((value): value is string => typeof value === 'string' && !!value);
  nav.completedSegments += confirmed;
  const invalidation = invalidationReasonOf(data);
  const remaining = navPoints(data.remainingPoints) ?? navPoints(data.remaining);
  const position = navPoint(data.position) ?? navPoint(data.lastPosition);
  const outcome = typeof data.outcome === 'string' ? data.outcome : typeof data.navOutcome === 'string' ? data.navOutcome : undefined;
  const arrived = outcome === 'ARRIVED' || data.arrived === true || segment?.arrivedAtTarget === true;
  const failure = result.status === 'failed'
    ? { at: now, ...(result.failureCode ? { code: String(result.failureCode) } : {}), summary: clipFeedback(result.summary, 220) }
    : undefined;
  // 保留当前计划的剩余目标与最后实测落点；同一语义在多条终态分支复用。
  const keepProgress = (nextRemaining: NavPoint[] | undefined) => {
    if (nextRemaining) nav.remaining = nextRemaining;
    nav.lastConfirmed = { pos: { ...(position ?? state.pos) }, at: now };
  };
  if (invalidation) {
    nav.phase = 'replanning';
    nav.lastInvalidation = { at: now, reason: clipFeedback(invalidation, 200) };
    // 失效前已确认的段仍是实测进展：保留最后落点与当前计划的剩余目标，别因失效丢掉。
    if (confirmed > 0) keepProgress(remaining);
  } else if (result.status === 'cancelled') {
    nav.phase = 'cancelled';
    // 取消只终止本段：已确认的段、剩余目标和最后实测落点照实保留。
    if (confirmed > 0) keepProgress(remaining);
    else if (remaining) nav.remaining = remaining;
  } else if (arrived) {
    // 段终点等于原目的地才算到达；中间 waypoint 只是完成了一段。
    const final = !nav.destination || !requested || sameNavPoint(nav.destination, requested);
    if (final) {
      nav.phase = 'arrived';
      keepProgress([]);
    } else {
      nav.phase = 'segment_completed';
      keepProgress(remaining?.length ? remaining : [{ ...nav.destination! }]);
    }
  } else if (confirmed > 0) {
    // 有实测确认的段就是进展；保留剩余目标，不把这一段当整趟失败。
    nav.phase = 'segment_completed';
    keepProgress(remaining);
    if (failure) nav.lastFailure = failure;
  } else if (result.status === 'failed') {
    nav.phase = 'failed';
    if (failure) nav.lastFailure = failure;
    // 段失败（无可确认段）也要保留当前计划的剩余目标；空数组照实写空，不用旧计划冒充。
    if (remaining) nav.remaining = remaining;
  } else if (remaining) {
    nav.remaining = remaining;
  } else if (step.skill === 'plan_route') {
    nav.phase = 'planning';
  }
  const strategy = `${step.skill}${source ? `/${source}` : ''}`;
  nav.strategy = strategy.slice(0, 120);
  nav.updatedAt = now;
  return nav;
}

/**
 * Agent 明确改写同一段委托的步骤（mind 的 adjust 分支）时，只有新步骤声明了新的绝对目的地
 * 才替换原目的地/到达条件；路线回执里的近处 waypoint、剩余段不调用这里。
 */
export function retargetNavigation(a: Activity, steps: ActivityStep[]) {
  const nav = a.navigation;
  if (!nav) return undefined;
  const destination = steps
    .filter((step) => NAVIGATION_SKILLS.has(step.skill))
    .map(addressedTarget)
    .find((point): point is NavPoint => point !== null);
  const now = Date.now();
  if (destination && (!nav.destination || !sameNavPoint(nav.destination, destination))) {
    adoptDestination(nav, destination);
    nav.phase = 'planning';
  }
  if (a.doneWhen) nav.arrivalCondition = a.doneWhen; else delete nav.arrivalCondition;
  nav.updatedAt = now;
  return nav;
}

/** 换维/死亡/断线/会话失效：保留原目的地与已完成进度，下一段从实测位置重新派发。 */
export function invalidateNavigation(
  a: Activity, reason: string,
  state?: Pick<AgentState, 'pos' | 'worldId' | 'dim'>,
) {
  const nav = a.navigation;
  if (!nav) return undefined;
  const now = Date.now();
  if (state) {
    nav.worldId = state.worldId;
    nav.dim = state.dim;
    nav.measured = { pos: { ...state.pos }, at: now };
  }
  nav.lastInvalidation = { at: now, reason: clipFeedback(reason, 200) };
  nav.phase = 'replanning';
  nav.updatedAt = now;
  return nav;
}

function describeNavigation(nav: NavigationProgress) {
  return {
    delegation_id: nav.delegationId,
    state: nav.phase,
    ...(nav.destination ? { original_destination: nav.destination } : {}),
    ...(nav.arrivalCondition ? { arrival_condition: nav.arrivalCondition } : {}),
    scope: `${nav.worldId}/${nav.dim}`,
    measured_position: nav.measured.pos,
    ...(nav.segmentStart ? { segment_start: nav.segmentStart } : {}),
    completed_segments: nav.completedSegments,
    remaining_count: nav.remaining.length,
    // 只给当前计划的剩余点（上限 8），不把历史路点塞进提示词。
    remaining_targets: nav.remaining.slice(0, 8),
    ...(nav.parentDeadlineMs !== undefined
      ? { parent_deadline_ms: nav.parentDeadlineMs, parent_budget_remaining_ms: Math.max(0, nav.parentDeadlineMs - Date.now()) }
      : {}),
    ...(nav.lastConfirmed ? { last_confirmed_position: nav.lastConfirmed.pos } : {}),
    ...(nav.lastInvalidation ? { last_invalidation: nav.lastInvalidation.reason } : {}),
    ...(nav.lastFailure ? { last_failure: nav.lastFailure.summary } : {}),
    ...(nav.strategy ? { strategy: nav.strategy } : {}),
  };
}

export function createActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], state: Pick<AgentState, 'inventory' | 'pos' | 'worldId' | 'dim'>): Activity {
  const a: Activity = {
    id: shortId('act_'), what: draft.what, why: draft.why, kind: draft.kind, steps: draft.steps.map((s) => ({ ...s, id: shortId('st_') })),
    ...(draft.facing ? { facing: draft.facing } : {}),
    repeat: Math.max(1, Math.min(12, draft.repeat || 1)), iteration: 0, index: 0,
    ...(draft.doneWhen ? { doneWhen: draft.doneWhen } : {}), ...(draft.expect ? { expect: draft.expect } : {}),
    ...(draft.ifStuck ? { ifStuck: draft.ifStuck } : {}), ...(draft.agendaId ? { agendaId: draft.agendaId } : {}),
    ...(draft.applying ? { applying: draft.applying } : {}),
    source, monologue, startedAt: Date.now(), startPos: { ...state.pos }, failures: 0, consecutiveFailures: 0, adaptations: [], results: [],
    ...(draft.dropped?.length ? { dropped: [...draft.dropped] } : {}),
    startInventory: inventoryOf(state),
  };
  if (a.steps.some((step) => NAVIGATION_SKILLS.has(step.skill))) a.navigation = newNavigation(a, state);
  return a;
}

export function doneWhenMet(a: Activity, state: AgentState, percept?: Percept): boolean {
  return !!a.doneWhen && evaluateCondition(a.doneWhen, state, state.worldId, [], activityPerception(a, state, percept)).status === 'satisfied';
}

/** 刚刚结束的那一步在 routine 里的原样（带 optional 标记） */
function ownStep(a: Activity, step: Step): ActivityStep | undefined {
  const own = a.steps[Math.max(0, a.index - 1)];
  return own && own.skill === step.skill ? own : undefined;
}

/**
 * 没做成但不算这段活失败的情况：只读观察没看到目标，或者本来就是“顺手、碰运气”的一步。
 * 真人“路上见到动物就打一只”，没见到就接着赶路，不会因此觉得整件事搞砸了。
 */
export function softMiss(a: Activity | null | undefined, step: Step, result: Pick<SkillResult, 'status' | 'failureCode'>): boolean {
  if (result.status !== 'failed') return false;
  if (SKILLS[step.skill]?.readOnly && result.failureCode === 'NOT_FOUND') return true;
  return !!a && ownStep(a, step)?.optional === true;
}

/**
 * 放置的站位副作用改变脚格后，按上一动作开始前的锚点重解释下一步相对移动。
 * 只有按旧锚点算出的世界目标正好是本次确认的支撑脚位时才返回绝对目标；不替 Agent 猜别的落点。
 */
export function rebindStanceTarget(args: unknown, gap: NonNullable<Activity['stanceGap']>) {
  const intended = gap.intendedStandTarget, before = gap.before;
  if (!intended || !before || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const normalized = args as { at?: unknown; facing?: unknown };
  const at = normalized.at;
  if (!Array.isArray(at) || at.length !== 3 || !at.every((n) => Number.isInteger(n))) return null;
  if (!FACINGS.includes(normalized.facing as Facing)) return null;
  const anchored = toWorld(feetCell(before), normalized.facing as Facing, at as [number, number, number]);
  if (anchored.x !== intended.x || anchored.z !== intended.z) return null;
  return { xyz: [intended.x, intended.y, intended.z] as [number, number, number], facing: normalized.facing, from: anchored };
}

/** 身体是否已经站在给定脚位（脚格与脚高一致）。 */
export function stanceReached(pos: { x: number; y: number; z: number }, intended: { x: number; y: number; z: number }): boolean {
  const feet = feetCell(pos);
  return feet.x === intended.x && feet.z === intended.z && Math.abs(pos.y - intended.y) <= 0.01;
}

/** 下一个动作；这一轮做完了就开始下一轮；都做完返回 null */
export function nextStep(a: Activity): (Step & { id?: string }) | null {
  if (a.index >= a.steps.length) {
    if (a.iteration + 1 >= a.repeat) return null;
    a.iteration++;
    a.index = 0;
    resetStepBudgets(a);
  }
  const step = a.steps[a.index++];
  if (!step) return null;
  // 归因随逻辑步骤一起下传：自动插步保留 execution_helper 与授权链，普通步骤仍是 agent。
  // 普通 agent 步骤维持原来的 {skill,args} 形状（调用方按它比较同一步）；只有插步额外带 id，
  // 便于把自动动作追溯到被执行的逻辑步骤。
  const attribution = { ...(step.origin ? { origin: step.origin } : {}), ...(step.authorizedBy ? { authorizedBy: step.authorizedBy } : {}) };
  return { skill: step.skill, args: step.args, ...(step.origin && step.id ? { id: step.id } : {}), ...attribution };
}

/** 还剩多少个动作（估计，用来决定什么时候开始想“接下来做什么”） */
export function remainingSteps(a: Activity): number {
  return Math.max(0, a.steps.length - a.index) + Math.max(0, a.repeat - a.iteration - 1) * a.steps.length;
}

/** 顺手的步骤遇到这些失败，再做几轮也一样：直接从这段活里去掉 */
const OPTIONAL_HOPELESS = new Set(['TARGET_GONE', 'BAD_ARGS', 'UNKNOWN_ITEM', 'WRONG_DIMENSION', 'WOULD_WASTE']);

/** 失败了值得原样再试一次的情况（路被挡、东西跑了、偶发错误） */
const RETRYABLE = new Set(['TIMEOUT', 'STUCK', 'PATH_NOT_FOUND', 'TARGET_GONE', 'ERROR', 'EFFECT_NOT_CONFIRMED']);
/** 技能报告的确定性停点：几何/材料/站位不变时，原样重放不会改变结果。 */
const DETERMINISTIC_STOPS = new Set(['impossible', 'risk', 'capability', 'missing_support']);

/**
 * 同一失败的自动重试上限。EFFECT_NOT_CONFIRMED 的回填/未加载失败与结构化确定性停点
 * （risk/capability/missing_support/decisionRequired/缺支撑）最多再确认一次；
 * 路被挡、超时、目标消失等暂时失败仍保留两次复验额度。
 */
function autoRetryLimit(code: string, data: Record<string, unknown> | undefined): number {
  const deterministic = code === 'EFFECT_NOT_CONFIRMED'
    || data?.decisionRequired === true
    || (typeof data?.stopKind === 'string' && DETERMINISTIC_STOPS.has(data.stopKind))
    || (!!data?.supportMissing && typeof data.supportMissing === 'object');
  return deterministic ? 1 : 2;
}
/** 不想清楚就没法继续的失败（缺材料、缺工具、背包满…） */
const NEEDS_THOUGHT = new Set(['MISSING_MATERIALS', 'WOULD_WASTE', 'NO_CRAFTING_TABLE', 'TOOL_MISSING', 'UNKNOWN_ITEM', 'BAD_ARGS', 'INVENTORY_FULL', 'NO_FOOD', 'WRONG_DIMENSION', 'LOW_HP']);

export type StepVerdict =
  | { kind: 'continue'; adapted?: string }
  | { kind: 'done'; met: boolean; why: string }
  | { kind: 'stuck'; why: string; /** 额度耗尽，直接终止自动推进，不再插入学得恢复或重放原动作 */ exhausted?: boolean };

/**
 * 一个动作结束后，处理同一动作的短暂失败；需要改变目标或增加探索时交给心智。
 * 返回这段活接下来怎么办。
 */
export function afterStep(a: Activity, step: Step, result: SkillResult, durationMs: number, state: AgentState, percept?: Percept): StepVerdict {
  const conditionReached = (): StepVerdict | null => {
    if (!a.doneWhen) return null;
    const evidence = evaluateCondition(a.doneWhen, state, state.worldId, [], activityPerception(a, state, percept));
    if (evidence.status !== 'satisfied') return null;
    a.conditionTriggered = true;
    return { kind: 'done', met: true, why: `收工条件满足：${JSON.stringify(a.doneWhen)}；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})；实际 ${JSON.stringify(evidence.actual)}；只确认该条件，其他目标未由此验证` };
  };
  const conditionUnmet = () => {
    if (!a.doneWhen) return '';
    const evidence = evaluateCondition(a.doneWhen, state, state.worldId, [], activityPerception(a, state, percept));
    return `；收工条件未满足或无法确认：${JSON.stringify(a.doneWhen)}；状态 ${evidence.status}，实际 ${JSON.stringify(evidence.actual)}${evidence.reason ? `；原因：${evidence.reason}` : ''}；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})`;
  };
  const previous = [...a.results].reverse().find((r) => r.status === 'failed' && targetKeyOf(r) === targetKeyOf(step));
  const view = viewOf(percept);
  const baseline = previous?.pos ? previous : a.stepStart;
  const previousPosition = a.results.at(-1)?.pos;
  if (previousPosition && JSON.stringify(feetCell(previousPosition)) !== JSON.stringify(feetCell(state.pos))) delete a.airDigs;
  // 只记录技能明确报告过的阶段（如 navigate_to 的 nav.outcome、
  // 水面技能的 data.stage）；没有报告的技能保持没有，不由耗时或位置臆造阶段。
  const navStage = reportedStage(result);
  // 只留能判定“定位/取得/位移/覆盖”的回执字段；整份 data（尤其 local 图）不进活动历史。
  const RECEIPT_KEYS = new Set(['found', 'foundPos', 'foundRef', 'foundEntityId', 'visibleEntities', 'coverage', 'dug', 'moved', 'crafted', 'placed', 'block', 'cell', 'was', 'noDrop',
    'searched', 'scanViews', 'displacement', 'travelled', 'unopened', 'container', 'onGround', 'pendingFall', 'collection']);
  const receipt = result.data
    ? Object.fromEntries(Object.entries(result.data).filter(([key]) => RECEIPT_KEYS.has(key)))
    : undefined;
  const recorded: Activity['results'][number] & { stage?: string } = {
    skill: step.skill, args: step.args, status: result.status, failureCode: result.failureCode, summary: clipFeedback(result.summary), at: Date.now(), durationMs,
    pos: { ...state.pos }, ...(state.worldId ? { worldId: state.worldId } : {}), ...(state.dim ? { dim: state.dim } : {}), ...(view !== undefined ? { view } : {}),
    ...(receipt && Object.keys(receipt).length ? { data: receipt } : {}),
  };
  if (navStage) recorded.stage = navStage;
  a.results.push(recorded);
  if (a.results.length > 16) a.results = a.results.slice(-16);
  // 导航目标只并入当前委托的实测进度/来源/失效；几何与 traversal 不复制到这里。
  noteNavigationResult(a, step, result, state);
  // 放置/补支撑也会为了让出参照面而轻推身体。0.25 格就足以跨过格边界，让后续相对坐标换到另一列；
  // 只要脚格变了，就记下站位缺口，下一步若是相对动作先交回心智，不按旧站位继续。
  if ((step.skill === 'place_cell' || step.skill === 'place_support') && a.stepStart?.pos
    && JSON.stringify(feetCell(a.stepStart.pos)) !== JSON.stringify(feetCell(state.pos))) {
    const intended = result.data?.intendedStandTarget as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    a.stanceGap = {
      skill: step.skill, pos: { ...state.pos }, before: { ...a.stepStart.pos },
      ...(intended && ['x', 'y', 'z'].every((k) => typeof intended[k as 'x' | 'y' | 'z'] === 'number')
        ? { intendedStandTarget: { x: intended.x as number, y: intended.y as number, z: intended.z as number } }
        : {}),
    };
  }
  if (result.status === 'succeeded') {
    a.consecutiveFailures = 0;
    // 已确认的放置/支撑、挖掘和位移是这段活的实际效果；收工时和背包增减一起汇总，
    // 避免「放了支撑、身体也挪了」仍被写成 changed:false。
    const effect = result.data?.effect as { confirmed?: boolean; kind?: string } | undefined;
    const cell = (result.data?.targetCell ?? result.data?.cell) as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    const where = cell && ['x', 'y', 'z'].every((k) => typeof cell[k as 'x' | 'y' | 'z'] === 'number')
      ? `${cell.x},${cell.y},${cell.z}` : undefined;
    const movementChanged = (result.data?.movement as { changed?: boolean } | undefined)?.changed === true;
    if (effect?.confirmed === true || movementChanged) {
      a.effects ??= { placements: [], removed: 0, moved: false };
      if (effect?.kind === 'block_placed') a.effects.placements.push(`${step.skill}${where ? `@${where}` : ''}`);
      else if (effect?.kind === 'support_formed') a.effects.placements.push(`${step.skill}支撑${where ? `@${where}` : ''}`);
      else if (effect?.kind === 'block_removed') a.effects.removed += 1;
      if (effect?.kind === 'movement' || movementChanged) a.effects.moved = true;
    }
    // 真实挖掘、放置或跨格移动是执行进展，不能沿用之前的空挖计数。
    if ((step.skill === 'place_cell' || step.skill === 'place_support') && result.data?.placed
      || step.skill === 'mine_cell' && result.data?.was && result.data.was !== 'air'
      || step.skill === 'excavate_run' && (result.data?.dug as string[] | undefined)?.length) delete a.airDigs;
    // 相对坐标会随身体移动；只统计同一实际目标格的重复空挖。
    if (step.skill === 'mine_cell') {
      const key = JSON.stringify(step.args ?? {});
      const air = result.data?.was === 'air';
      const target = result.data?.targetCell as AgentState['pos'] | undefined;
      a.airDigs ??= {};
      if (air && target) {
        const previous = a.airDigs[key];
        const same = previous && previous.target.x === target.x && previous.target.y === target.y && previous.target.z === target.z;
        const count = same ? previous.count + 1 : 1;
        a.airDigs[key] = { target: { ...target }, count };
        if (count >= 3) return { kind: 'stuck', why: `mine_cell 连续 ${count} 次确认目标格 (${target.x},${target.y},${target.z}) 是空气，这几次未在该格发生挖掘` };
      }
      else delete a.airDigs[key];
    }
    const reached = conditionReached();
    if (reached) return reached;
    // approach_visible 已实测抵达：重复同一个接近步骤不会产生新的探索距离。
    // exploration 收工条件只验收本段，不能反过来逼着重放一个已完成的接近。
    if (step.skill === 'approach_visible' && result.data?.outcome === 'ARRIVED'
      && a.repeat > 1 && a.steps.slice(a.index).length === 0
      && a.steps.every((own) => own.skill === step.skill && JSON.stringify(own.args) === JSON.stringify(step.args))
      && hasExplorationCondition(a.doneWhen)) {
      return {
        kind: 'done', met: false,
        why: `approach_visible 已实测抵达；重复同一接近不会产生新的探索距离，不再重复执行；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})${conditionUnmet()}`,
      };
    }
    // 挖了一部分后遇到空洞也算动作有实际效果，但重复回到同一格继续挖不能当作下行进展。
    // 只记录身体明确报告的停点；交回心智决定是否继续，不能替它选路。
    if (step.skill === 'excavate_run' && a.repeat > 1) {
      const key = `${a.index - 1}:${JSON.stringify(step.args ?? {})}`;
      const stop = result.data?.partialStop as { pos: { x: number; y: number; z: number }; below: string | null; completed: number; requested: number } | undefined;
      a.partialStops ??= {};
      const prev = a.partialStops[key];
      if (stop && stop.completed < stop.requested) {
        const same = prev && prev.iteration === a.iteration - 1 && prev.pos.x === stop.pos.x && prev.pos.y === stop.pos.y && prev.pos.z === stop.pos.z && prev.below === stop.below;
        const count = same ? prev.count + 1 : 1;
        a.partialStops[key] = { pos: stop.pos, below: stop.below, iteration: a.iteration, count };
        if (count >= 3 && remainingSteps(a) > 0) return { kind: 'stuck', why: `excavate_run 连续 ${count} 轮在 (${stop.pos.x},${stop.pos.y},${stop.pos.z}) 上方停下：本轮确认到达下一级 ${stop.completed}/${stop.requested} 次，再下面是 ${stop.below ?? '未知'}；这几轮停在同一处，请根据实际情况决定下一步` };
      } else delete a.partialStops[key];
    }
    if (remainingSteps(a) === 0) {
      if (a.doneWhen) return { kind: 'done', met: false, why: `${a.repeat} 轮做完了（最后一步：${clipFeedback(result.summary)}）${conditionUnmet()}` };
      return { kind: 'done', met: true, why: '这段活的步骤都做完了' };
    }
    return { kind: 'continue' };
  }
  if (result.status === 'cancelled') return { kind: 'continue' };
  // 已确认的导航段是进展，不是这段活的失败：navigate_to/advance 每次从实测位置重新派生，
  // 原样重放同一参数不构成新的实测依据。索引照常前进，由后续步骤/新一轮路线从实测位置继续，
  // Activity 不按 failed 收尾。
  if (result.status === 'failed' && NAVIGATION_SKILLS.has(step.skill)) {
    const data = (result.data ?? {}) as Record<string, unknown>;
    const confirmed = confirmedSegmentsOf(data);
    if (confirmed > 0) {
      a.consecutiveFailures = 0;
      const why = `${step.skill} 已确认 ${confirmed} 段但未到原目的地；保留这段实测进展，下一段从实测位置重新派发`;
      const reached = conditionReached();
      if (reached) return reached;
      return remainingSteps(a) === 0 ? { kind: 'done', met: false, why } : { kind: 'continue' };
    }
  }
  if (softMiss(a, step, result)) {
    a.consecutiveFailures = 0;
    const own = ownStep(a, step);
    const optional = own?.optional === true;
    // optional 移动没到新站位：记下事实，下一步校验后若为相对挖掘/放置则报告依赖缺口（不在此用原始参数判断）。
    if (optional && STANCE_MOVES.has(step.skill)) {
      a.stanceGap = { skill: step.skill, pos: { ...state.pos } };
    }
    // 顺手的一步这次是“再试也不会成”的失败（要挖的已经没了、参数本身就不对；找不到连着两轮）：后面几轮不再做它
    const code = result.failureCode ?? 'ERROR';
    const missKey = `optmiss:${step.skill}:${JSON.stringify(step.args ?? {}).slice(0, 80)}`;
    if (optional && code === 'NOT_FOUND') a.adaptations.push(missKey);
    const hopeless = optional && (OPTIONAL_HOPELESS.has(code) || (code === 'NOT_FOUND' && a.adaptations.filter((x) => x === missKey).length >= 2));
    if (hopeless && own && a.steps.length > 1) {
      const i = a.steps.indexOf(own);
      if (i >= 0) { a.steps.splice(i, 1); if (i < a.index) a.index--; }
      const reached = conditionReached();
      if (reached) return reached;
      return remainingSteps(a) === 0
        ? { kind: 'done', met: !a.doneWhen, why: `顺手的「${step.skill}」没成（${code}）；这段活的步骤都做完了${conditionUnmet()}` }
        : { kind: 'continue', adapted: `顺手的「${step.skill}」再做也不会成（${result.summary.slice(0, 40)}），后面几轮不再做它` };
    }
    const reached = conditionReached();
    if (reached) return reached;
    return remainingSteps(a) === 0
      ? { kind: 'done', met: !a.doneWhen, why: `${optional ? `顺手的「${step.skill}」没成` : '观察没有找到目标'}；这段活的步骤都做完了${conditionUnmet()}` }
      : { kind: 'continue', ...(optional ? { adapted: `顺手的「${step.skill}」没成（${result.failureCode ?? '失败'}），不碍事，接着做` } : {}) };
  }
  a.failures++;
  a.consecutiveFailures++;
  const code = result.failureCode ?? 'ERROR';
  // 自动插步只能是已选动作契约里明确包含的执行辅助；挖、放、耗材和改目标默认交回事实。
  const data = result.data as Record<string, any> | undefined;
  if (a.failures >= 5) return { kind: 'stuck', why: `这段活已经失败 ${a.failures} 次了（最近：${clipFeedback(result.summary, 200)}）` };
  // move_step 的“同一目标列、只错脚高”是确定性但可原地修正的 BAD_ARGS；
  // 先留给下面的同格改写，不用 BAD_ARGS 的通用停点把可执行的修正也挡掉。
  const sameCellMoveFix = step.skill === 'move_step' && data?.movementNotAttempted === true
    && (data?.remediation?.at !== undefined || data?.remediation?.xyz !== undefined);
  if (NEEDS_THOUGHT.has(code) && !sameCellMoveFix) return { kind: 'stuck', why: clipFeedback(result.summary) };
  // use_skill 等嵌套动作报出确定的图断口（connectionGap）时，
  // 原样重试不会改变通道拓扑：按数据字段判断，交回心智，不领重试额度。
  if (data?.connectionGap && typeof data.connectionGap === 'object') {
    const gap = data.connectionGap as { from?: AgentState['pos']; to?: AgentState['pos']; distance?: number };
    const at = (p?: AgentState['pos']) => p ? `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})` : '未知位置';
    return { kind: 'stuck', why: `${clipFeedback(result.summary, 220)}；connectionGap ${at(gap.from)} ↔ ${at(gap.to)}（相距 ${typeof gap.distance === 'number' ? Math.round(gap.distance) : '未知'} 格）是记录几何里的确定断口，原样重试不会接上` };
  }
  // 嵌套结果明确报告身体被寻路带离记录路线时，这段位移不是进展：
  // 原样重试不会回到记录点，也不把它当自动重试的依据。
  const nestedNavData = data?.lastNavigationFailure as { result?: { data?: Record<string, unknown> } } | undefined;
  if (data?.offRoute === true || nestedNavData?.result?.data?.offRoute === true) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary, 220)}；寻路把身体带离了记录路线（offRoute），这段位移不算进展，原样重试不会回到记录点` };
  }
  // move_step 的确定性高度修正：回执锁定了同一目标列，只是相对 at/绝对 xyz 的脚高写错。
  // 直接改写这一步的同格落点再试（不换方向、不换目标列）；只修正实际脚高，不替 Agent 选新落点。
  if (step.skill === 'move_step' && data?.movementNotAttempted === true && (data?.remediation?.at || data?.remediation?.xyz)) {
    const args = (step.args ?? {}) as Record<string, unknown>;
    const fix = data.remediation as { at?: unknown; xyz?: unknown };
    const at = Array.isArray(fix.at) && fix.at.length === 3 && fix.at.every((n) => Number.isInteger(n))
      && Math.abs(fix.at[0] as number) + Math.abs(fix.at[2] as number) === 1 && Math.abs(fix.at[1] as number) <= 1
      ? fix.at as [number, number, number] : null;
    const rawXyz = fix.xyz as Record<string, unknown> | undefined;
    const xyz = rawXyz && ['x', 'y', 'z'].every((k) => typeof rawXyz[k] === 'number' && Number.isFinite(rawXyz[k]))
      ? { x: rawXyz.x as number, y: rawXyz.y as number, z: rawXyz.z as number } : null;
    const absolute = args.xyz !== undefined;
    // 只接受同一目标列：相对 at 的前/右分量必须与失败步骤一致；绝对 xyz 的 x/z 格必须与回执目标一致。
    const requested = Array.isArray(args.at) ? args.at as number[] : null;
    const target = data.targetCell as { x: number; y: number; z: number } | undefined;
    const sameColumn = absolute
      ? !!xyz && (!target || (Math.floor(xyz.x) === Math.floor(target.x) && Math.floor(xyz.z) === Math.floor(target.z)))
      : !!at && (!requested || (requested[0] === at[0] && requested[2] === at[2]));
    const corrected = absolute
      ? xyz && sameColumn ? { xyz, ...(typeof args.facing === 'string' ? { facing: args.facing } : {}) } : null
      : at && sameColumn ? { at, ...(typeof args.facing === 'string' ? { facing: args.facing } : {}) } : null;
    const attempts = a.adaptations.filter((item) => item.startsWith('step-move:')).length;
    const changed = corrected !== null && JSON.stringify(step.args ?? {}) !== JSON.stringify(corrected);
    if (corrected !== null && changed && attempts < 2) {
      const mark = `step-move:${digest(JSON.stringify(step.args ?? {}))}:${digest(JSON.stringify(corrected))}`;
      const own = ownStep(a, step);
      if (own && !a.adaptations.includes(mark)) {
        a.adaptations.push(mark);
        const originalArgs = step.args;
        own.args = corrected;
        own.origin = 'execution_helper';
        own.authorizedBy = { skill: step.skill, ...(own.id ? { stepId: own.id } : {}), args: originalArgs };
        a.index = Math.max(0, a.index - 1);
        return { kind: 'continue', adapted: `迈步目标格不变，按实际脚高把这一步改成 ${JSON.stringify(corrected)} 再试（不换方向/目标）` };
      }
    }
  }
  // move_step 的确定性障碍：回执给出了具体要挖的格，且这段活本身已经在挖（mine_cell/excavate_run），
  // 就按同一委托先插入这一步挖掘再重试。只处理同一目标列/头脚格，不换方向、不换材料、不扩目标。
  if (step.skill === 'move_step' && data?.movementNotAttempted === true && data?.remediation?.dig) {
    const rel = data.remediation.dig as unknown;
    const digging = a.steps.some((s) => s.skill === 'mine_cell' || s.skill === 'excavate_run');
    const scope = `step-dig:${digest(JSON.stringify(step.args ?? {}))}:${digest(JSON.stringify(rel))}`;
    const attempts = a.adaptations.filter((item) => item.startsWith(`step-dig:`)).length;
    if (digging && Array.isArray(rel) && rel.length === 3 && attempts < 2) {
      const mark = `${scope}:${digest(gapEvidence(result))}`;
      if (!a.adaptations.includes(mark)) {
        const own = ownStep(a, step);
        const facing = (step.args as Record<string, unknown> | undefined)?.facing ?? a.facing;
        a.adaptations.push(mark);
        a.steps.splice(Math.max(0, a.index - 1), 0, {
          skill: 'mine_cell',
          args: { at: rel, ...(facing ? { facing } : {}) },
          id: shortId('st_'), origin: 'execution_helper',
          authorizedBy: { skill: step.skill, ...(own?.id ? { stepId: own.id } : {}), args: step.args },
        });
        a.index = Math.max(0, a.index - 1);
        markContinuation(a, own);
        return { kind: 'continue', adapted: `迈步被挡，先按回执挖开 [${(rel as number[]).join(',')}] 再重试（同一段活已包含挖掘；不新增目标/材料）` };
      }
    }
  }
  // 确定性预检拒绝先于任何自动照明/清障处理：暗处未知支撑、预检一步未推进，交回事实，不自动耗火把或原样重试。
  // >1 格落差时把已观察到的同列落点写成可复制的 descend_to 目标，但仍由 Agent 先 assess_landings 核实并选择。
  if (step.skill === 'move_step' && data?.movementNotAttempted === true) {
    const landing = (data.remediation?.landing ?? data.landing) as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    const handoff = landing && ['x', 'y', 'z'].every((k) => typeof landing[k as 'x' | 'y' | 'z'] === 'number')
      ? `；同一目标列已观察到落点 (${landing.x},${landing.y},${landing.z})：先用 assess_landings 核实当前可见性，再把 options[].target 原样交给 descend_to {"target":{"x":${landing.x},"y":${landing.y},"z":${landing.z}}}（不自动选落点）`
      : '';
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}${handoff}` };
  }
  if (step.skill === 'excavate_run' && data?.completedSteps === 0 && (data?.excavatedBlocks ?? 0) === 0) return { kind: 'stuck', why: clipFeedback(result.summary) };
  const stepArgs = (step.args ?? {}) as Record<string, any>;
  const facing = stepArgs.facing ?? a.facing;
  // 1) 看不清：交回事实，不自动插火把（照明是耗材，未授权不支出）
  if (data?.obscured) return { kind: 'stuck', why: clipFeedback(result.summary) };
  // 2) pillar_one 的契约是「只垫不挖」：头顶阻挡是确定性失败，交回 Agent 决定先挖哪一格。
  if (step.skill === 'pillar_one' && data?.failureCause === 'PILLAR_CLEARANCE') {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // place_cell / place_support 是普通放置：不隐式清顶或挖脚下；交回事实，挖哪一格由 Agent 决定。
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间受阻') return { kind: 'stuck', why: clipFeedback(result.summary) };
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间未加载') return { kind: 'stuck', why: clipFeedback(result.summary) };
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && data?.pillarFailure === 'NOT_PLACED:跳不起来') return { kind: 'stuck', why: clipFeedback(result.summary) };
  // 3) 脚下有非空气的可替换物（火把/草/雪层…）：place_cell/place_support 没有授予挖掘，不自动 mine_cell 清掉。
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && typeof data?.pillarFailure === 'string' && data.pillarFailure.startsWith('BLOCKED:')) {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 4) 脚下没有实心地面（悬空/水里/梯子上）：确定性缺支撑，原地垫高垫不了，别白重试。
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && data?.pillarFailure === 'NO_REFERENCE') {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 裸 NOT_PLACED（适配器自身已重试两次仍未放下）和“贴面方块变了”都是确定性拒绝，
  // 不能当成服务器暂时延迟再回放。
  if (
    (step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') &&
    typeof data?.pillarFailure === 'string' &&
    (data.pillarFailure === 'NOT_PLACED' || data.pillarFailure.includes('脚下贴面方块变了'))
  ) {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 服务器暂时拒绝/尚未站稳不是“没有附着面”：在同一个父委托的期限和材料额度内有限重试（最多两次）。
  // 这些是暂时条件（服务器确认延迟/身体还没落稳），不是同一确定性缺口的原样重试；确定性拒绝已在上面的分支停止。
  if ((step.skill === 'place_cell' || step.skill === 'place_support' || step.skill === 'pillar_one') && typeof data?.pillarFailure === 'string' && /^NOT_PLACED(?::|$)/.test(data.pillarFailure)) {
    const own = ownStep(a, step);
    const scope = `pillar-retry:${digest(JSON.stringify(step.args ?? {}))}`;
    const attempts = a.adaptations.filter((item) => item.startsWith(`${scope}:`)).length;
    const mark = `${scope}:${digest(gapEvidence(result))}`;
    // 服务器拒绝/尚未站稳是有界的暂时条件：最多两次；确定性拒绝已在上面的分支立即停止。
    if (attempts >= 2) return { kind: 'stuck', why: clipFeedback(result.summary) };
    const guard = continuationGuard(a, own, state);
    if (guard) return { kind: 'stuck', why: guard };
    a.adaptations.push(mark);
    markContinuation(a, own);
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `${step.skill} 被服务器暂时拒绝或身体尚未落稳（${data.pillarFailure.slice(0, 60)}）；沿用原委托期限和材料额度再确认一次` };
  }
  // 5) 同一技能+错误+原参数+同一证据版本不原样重试。首次重试要求身体实际移动（相关进展）；
  //    之后只有失败回执里的支撑/净空/目标/进度等事实变了才允许复验。
  //    EFFECT_NOT_CONFIRMED 与 risk/capability/missing_support/decisionRequired 这类确定性失败
  //    最多自动再确认一次，避免回填/未加载或几何没变时反复尝试。
  //    转头、附近资源增减、无关火把不计入证据。
  const retryScope = `${step.skill}:${digest(JSON.stringify(step.args ?? {}))}:${code}`;
  const retryMark = `retry:${retryScope}:${digest(gapEvidence(result))}`;
  const retries = a.adaptations.filter((item) => item.startsWith(`retry:${retryScope}:`)).length;
  // 0.5 格阈值抓不住“只挪 0.25 但跨过格边界”：相对坐标按 floor(脚位) 取格，跨边界就等于换了落点格。
  const movedCell = !!baseline?.pos && JSON.stringify(feetCell(baseline.pos)) !== JSON.stringify(feetCell(state.pos));
  const physicallyMoved = !!baseline?.pos && (movedCell || Math.hypot(state.pos.x - baseline.pos.x, state.pos.y - baseline.pos.y, state.pos.z - baseline.pos.z) >= 0.5);
  // 相对 step 只有“前/上/右”偏移，没有固定世界目标。失败后身体已经换位时，自动重试会
  // 用新站位重新解释同一个 [1,-1,0]，实际变成下一格（空腔里会一路下沉/换列）。这不是
  // 同一个逻辑动作的复验，交回心智按实测位置重新选择；绝对 step/xyz 仍可按原目标复验。
  if (step.skill === 'move_step' && (step.args as Record<string, unknown> | undefined)?.xyz === undefined && physicallyMoved) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；相对 step 失败后身体已换位，自动重试会用新站位重算落点，交回心智重新选择` };
  }
  // 上浮时头顶被实心方块封住是确定性失败：上浮只按跳、不会挖开；原样重放不会把方块弄掉。
  if (step.skill === 'swim_path' && data?.blockedAbove) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；头顶被 ${data.blockedAbove.name} 封住，swim_path 上浮只按跳不能挖，原样重放不会改变结果，交回心智` };
  }
  // 同一目标、同一地形下的物理停滞：身体在失败前动过，不代表路线变了。
  // 原样重放同一个目标只会再耗一次时间与氧气；换路线、换手段交回心智决定。
  if (step.skill === 'swim_path' && data?.reason === 'SWIM_NO_PROGRESS') {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；同一目标在同样的地形里重放不会改变结果，交回心智换路线或换手段` };
  }
  // 穿门等待超时且身体此刻仍在门方块里：这次失败没有新的身体事实可复验，自动续跑不再
  // 原样重放同一次 30 秒等待；先离开门、换门还是放弃交回心智决定。
  // 只认 travel_portal/recall_portal 回执里明确标注的 portalReason，避免把其它技能数据里的 transition 当成门。
  const portalInsideMs = typeof data?.transition?.insideMs === 'number' ? data.transition.insideMs : 0;
  if (data?.portalReason === 'PORTAL_TRANSITION_TIMEOUT' && portalInsideMs >= 1000) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；这次失败没有新的身体事实可复验，自动续跑不再原样重放，交回心智` };
  }
  // 显式移动辅助（travel_to / explore_toward）内部已有偏转跳、分段与停止判定，请求又是冻结的
  // （目标/方向/起点不变）：原样重放只会得到同一停止原因，落水时还会白耗氧气。交回心智按回执决定。
  if (step.skill === 'travel_to' || step.skill === 'explore_toward') {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；${step.skill} 内部已重试过，原样重放会得到同一结果，交回心智` };
  }
  if (RETRYABLE.has(code)
    && !a.adaptations.includes(retryMark) && retries < autoRetryLimit(code, data) && (retries > 0 || physicallyMoved)) {
    const guard = continuationGuard(a, ownStep(a, step), state);
    if (guard) return { kind: 'stuck', why: guard };
    a.adaptations.push(retryMark);
    markContinuation(a, ownStep(a, step));
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `${step.skill} 没成；身体位置或失败回执证据有更新，按原委托再试一次` };
  }
  return { kind: 'stuck', why: clipFeedback(result.summary) };
}

/** 资源型活动：步骤、标题或收工条件在要某样东西。只用于回执分类，不替 Agent 选资源。 */
const RESOURCE_SKILLS = new Set(['gather', 'forage', 'hunt', 'fish', 'farm', 'take_items', 'mine_cell', 'craft', 'smelt', 'expedition', 'excavate_run']);
const RESOURCE_WORDS = /木料|原木|木板|木棍|菌柄|木头|矿石|铁|煤|钻石|食物|材料|资源|gather|mine|wood|log|plank|stick|ore|iron|coal|diamond/i;
const SEARCH_SKILLS = new Set(['look_around', 'gather', 'forage', 'hunt', 'fish', 'find_item', 'expedition']);
const SEARCH_WORDS = /找|搜索|搜寻|探|扫|环顾|查看|look|search|explore|scout/i;

function resourceIntentOf(a: Activity): boolean {
  const done = a.doneWhen ? JSON.stringify(a.doneWhen) : '';
  return a.steps.some((step) => RESOURCE_SKILLS.has(step.skill)
    && (step.skill !== 'expedition' || !!(step.args as Record<string, unknown> | undefined)?.find))
    || RESOURCE_WORDS.test(`${a.what} ${done}`);
}

function searchIntentOf(a: Activity): boolean {
  return SEARCH_WORDS.test(a.what) || a.steps.some((step) => SEARCH_SKILLS.has(step.skill));
}

/**
 * 计划声称要走远/换地方/找远处的资源，却没有任何会实际改变身体位置的动作：
 * 这是计划覆盖缺口，只提示，不替 Agent 改步骤或阻止执行。
 */
export function planCoverageGap(a: Activity): string | null {
  const travelIntent = /走远|走一段|远行|远走|探路|探索|找树|找.*(树|木|原木|菌柄|log|wood)|换.*(地方|方向)|过去|走到|前往|搜索|搜寻|search|explore|scout|wander/i.test(a.what);
  const changesPosition = a.steps.some((step) => {
    if (['move_step', 'navigate_to', 'advance', 'travel_to', 'explore_toward', 'approach_visible', 'swim_path', 'boat_path', 'go_near', 'descend_to', 'excavate_run', 'expedition', 'travel_portal', 'recall_portal', 'use_end_gateway'].includes(step.skill)) return true;
    if (step.skill !== 'press_keys') return false;
    const keys = (step.args as { keys?: Record<string, unknown> } | undefined)?.keys ?? {};
    return ['forward', 'back', 'left', 'right', 'sprint'].some((key) => keys[key] === true);
  });
  if (!travelIntent || changesPosition) return null;
  return '目标需要走到/换地方/扩大观察范围，但步骤里没有会实际移动身体的动作；只转头、观察或采集不会改变位置，不能当作远行或远处搜索';
}

/** 从每步执行回执的实测位置算覆盖；没有回执的位置不猜。 */
function explorationOf(a: Activity, end: { x: number; y: number; z: number }, newChunks: number | null) {
  const positions = [...a.results.map((result) => result.pos).filter((pos): pos is { x: number; y: number; z: number } => !!pos), end];
  const start = a.startPos ?? end;
  const maxHorizontal = Math.max(0, ...positions.map((pos) => Math.hypot(pos.x - start.x, pos.z - start.z)));
  const searchIntent = searchIntentOf(a);
  const found = a.results.flatMap((result) => {
    const value = result.data?.found;
    if (typeof value === 'string') return [value.replace(/^minecraft:/, '')];
    if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
      return [String((value as { name: string }).name).replace(/^minecraft:/, '')];
    }
    return [];
  });
  const blocked = a.results.some((result) => ['PATH_NOT_FOUND', 'NO_SUPPORT', 'UNSUPPORTED_STEP_HEIGHT', 'HEAD_BLOCKED', 'TARGET_BLOCKED', 'MOVE_TIMEOUT']
    .includes(String(result.failureCode ?? '')));
  return {
    start: { ...start }, end: { ...end },
    maxHorizontal: Math.round(maxHorizontal * 100) / 100,
    visitedCells: new Set(positions.map((pos) => `${Math.floor(pos.x)},${Math.floor(pos.z)}`)).size,
    newChunks, searchIntent, found, blocked,
    localOnly: searchIntent && maxHorizontal < 8 && (newChunks ?? 0) <= 0,
  };
}

/**
 * done_when 里是否含 exploration（含 all_of/any_of 嵌套）。
 * 这类条件按本段实测位移验收，不能用重复一个已完成的接近来“凑距离”。
 */
function hasExplorationCondition(condition: Activity['doneWhen']): boolean {
  if (condition === undefined) return false;
  if (condition.type === 'exploration') return true;
  return (condition.type === 'all_of' || condition.type === 'any_of')
    && condition.conditions.some(hasExplorationCondition);
}

/** 活动内评估 done_when 时附带实测探索证据；没有它时 exploration 条件只能返回 unknown。 */
function activityPerception(a: Activity, state: AgentState, percept?: Percept): ConditionPerception {
  return { ...(percept as unknown as ConditionPerception), activityExploration: explorationOf(a, state.pos, null) };
}

const LOCAL_FAILURE_SKILLS = new Set(['move_step', 'navigate_to', 'advance', 'travel_to', 'explore_toward', 'go_near', 'descend_to', 'excavate_run', 'pillar_one', 'place_support', 'place_cell', 'swim_path', 'boat_path']);
const LOCAL_FAILURE_KINDS = new Set(['FOOT_HEIGHT_MISMATCH', 'UNSUPPORTED_STEP_HEIGHT', 'NO_SUPPORT', 'HEAD_BLOCKED', 'TARGET_BLOCKED', 'POSITION_NOT_CONFIRMED', 'MOVE_REJECTED', 'MOVE_TIMEOUT', 'UNKNOWN_GEOMETRY', 'PATH_NOT_FOUND']);

/** 把一个步骤失败归到“局部动作/落点”层；只有这类失败会阻止无证据换来源。 */
export function localStepFailure(
  step: Pick<Step, 'skill'>,
  result: { failureCode?: string | null; summary: string; data?: Record<string, unknown> },
  state: Pick<AgentState, 'worldId' | 'sessionId' | 'dim' | 'pos'>,
  chunks: number,
) {
  const kind = (result.data?.problem as { kind?: string } | undefined)?.kind ?? String(result.failureCode ?? '');
  if (!LOCAL_FAILURE_SKILLS.has(step.skill) || !LOCAL_FAILURE_KINDS.has(kind)) return null;
  return {
    at: Date.now(), skill: step.skill, code: result.failureCode ?? null, summary: clipFeedback(result.summary, 220),
    worldId: state.worldId, sessionId: state.sessionId, dim: state.dim, pos: { ...state.pos }, chunks,
  };
}

export function recordOf(a: Activity, outcome: ActivityOutcome, summary: string, state: AgentState, info: { newChunks?: number | null } = {}): ActivityRecord {
  const { gained, lost } = diffInventory(a.startInventory, inventoryOf(state));
  const receipts = a.results.flatMap((result) => result.data ? [result.data] : []);
  // 定位看“这一趟实际看见了/采到了什么”，不把 find_item 的历史记录或 go_near 的到达算成找到资源。
  const located = receipts.some((data) => !!data.found || Number(data.dug ?? 0) > 0
    || (Number(data.travelled ?? 0) > 0 && !!data.coverage));
  const acquired = Object.keys(gained).length > 0
    || receipts.some((data) => Number(data.dug ?? 0) > 0 || Number(data.moved ?? 0) > 0 || Number(data.crafted ?? 0) > 0);
  const intent = resourceIntentOf(a);
  const attemptOnly = !!a.attemptOnly;
  const exploration = explorationOf(a, state.pos, info.newChunks ?? null);
  const failed = [...a.results].reverse().find((result) => result.status === 'failed');
  // 采集回执只在活动期间的结果里有；结束时要把它带进最近记录，否则单步 gather 结束就只剩一句摘要。
  const collectionResult = [...a.results].reverse().find((result) => !!result.data?.collection);
  const collectionReceipt = collectionResult?.data?.collection as CollectionReceipt | undefined;
  return {
    id: a.id, what: a.what, kind: a.kind, outcome, summary: summary.slice(0, 200),
    ...(a.facing ? { facing: a.facing } : {}),
    completion: attemptOnly ? 'attempt' as const
      : outcome === 'done' ? (a.conditionTriggered ? 'condition' as const : 'steps' as const)
        : outcome === 'unmet' ? 'unmet' as const : undefined,
    operationCompleted: outcome === 'done',
    ...(intent || attemptOnly ? { resource: { intent, located, acquired, goalIncomplete: attemptOnly || (intent && !acquired) } } : {}),
    ...(collectionResult && collectionReceipt ? { collection: { ...collectionReceipt, skill: collectionResult.skill, ...(collectionResult.args !== undefined ? { args: collectionResult.args } : {}), at: collectionResult.at } } : {}),
    ...(exploration.searchIntent || hasExplorationCondition(a.doneWhen) ? { exploration } : {}),
    durationSec: Math.round((Date.now() - a.startedAt) / 1000), gained, lost,
    ...(a.expect ? { expect: a.expect } : {}), ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
    ...(a.applying ? { applying: a.applying } : {}), ...(a.applyingText ? { applyingText: a.applyingText } : {}),
    ...(failed ? { failure: { skill: failed.skill, ...(failed.args !== undefined ? { args: failed.args } : {}), code: failed.failureCode ?? null, summary: failed.summary.slice(0, 240),
      at: failed.at, ...(failed.worldId ? { worldId: failed.worldId } : {}), ...(failed.dim ? { dim: failed.dim } : {}), ...(failed.pos ? { pos: { ...failed.pos } } : {}) } } : {}),
    at: Date.now(), signature: signatureOf(a.steps),
    failures: a.failures,
  };
}

/** 步骤参数的简短写法：图纸只写名字和尺寸，其余太长的截断（免得撑大提示词、又被模型原样抄回来） */
export function argsLabel(step: Step): string {
  const args = (step.args ?? {}) as Record<string, any>;
  if (args.spec && typeof args.spec === 'object') {
    const { spec, ...rest } = args;
    const size = spec.width && spec.depth ? ` ${spec.width}×${spec.depth}` : '';
    return JSON.stringify({ ...rest, spec: `「${spec.name ?? '设计'}」${size}（图纸已省略）` });
  }
  const text = JSON.stringify(args);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** 把一段活压成一行给模型看 */
export function describeActivity(a: Activity, state: AgentState, percept?: Percept,
  /** 正在执行的实际动作（来自调度器，不是活动计划）：让模型分清“仍在执行”和“已经失败/取消”。 */
  running?: { skill: string; args: unknown; source: string; startedAt: number }) {
  const done = a.doneWhen ? evaluateCondition(a.doneWhen, state, state.worldId, [], activityPerception(a, state, percept)) : null;
  const stageOf = (r: Activity['results'][number]) => (r as { stage?: unknown }).stage;
  const lastStage = [...a.results].reverse().find((r) => typeof stageOf(r) === 'string');
  const lastCollection = [...a.results].reverse().find((r) => r.data?.collection)?.data?.collection;
  const explore = explorationOf(a, state.pos, null);
  // 继续 = 原样执行剩下的 routine；这里按调度器正在跑的步骤和剩余 index/repeat 说明会发生什么，
  // 不把独白、what、expect 或注意到的事当成执行内容。
  const remaining = remainingSteps(a);
  const roundsLeft = Math.max(0, a.repeat - a.iteration - 1);
  const nextOwn = a.index < a.steps.length ? a.steps[a.index] : undefined;
  // 只有这段活自己的步骤才算“继续时会照原参数执行”；filler/reflex 是身体自己的动作，不是 routine。
  // 后续步骤/轮次都可能被失败、取消或 done_when 提前打断，不能承诺它们一定全部执行。
  const stopCaveat = a.doneWhen ? '若收工条件未触发且没有失败/取消' : '若没有失败/取消';
  const continueEffect = running && running.source !== 'filler' && running.source !== 'reflex'
    ? {
        executing: `${running.skill} ${argsLabel({ skill: running.skill, args: running.args })}`,
        position: a.index >= a.steps.length ? 'in_flight_final_step' : 'in_flight_with_following_steps',
        executes_if_continue: a.index >= a.steps.length
          ? `这一步照原参数执行完；本轮已无已排后续步骤${roundsLeft ? `，${stopCaveat}，之后还有 ${roundsLeft} 轮` : ''}`
          : `这一步照原参数执行完，${stopCaveat}，再按原 routine 做本轮剩余 ${a.steps.length - a.index} 步${roundsLeft ? `，之后还有 ${roundsLeft} 轮` : ''}`,
        // 不含正在执行的这一步；它与剩余轮次分开数。
        remaining_steps_after_running: remaining,
        remaining_rounds: roundsLeft,
        done_when_can_stop_early: !!a.doneWhen,
      }
    : {
        executing: null,
        position: 'between_steps',
        executes_if_continue: nextOwn
          ? `从下一步「${nextOwn.skill} ${argsLabel(nextOwn)}」按原参数继续（${stopCaveat}）${roundsLeft ? `；本轮之后还有 ${roundsLeft} 轮` : ''}`
          : roundsLeft ? `本轮结束，进入下一轮第 1 步（${stopCaveat}）${roundsLeft > 1 ? `；共剩 ${roundsLeft} 轮` : ''}` : '没有剩余步骤，这段活会收工',
        remaining_steps: remaining,
        remaining_rounds: roundsLeft,
        done_when_can_stop_early: !!a.doneWhen,
      };
  return {
    what: a.what, why: a.why, kind: a.kind,
    ...(a.facing ? { facing: a.facing } : {}),
    routine: a.steps.map((s) => `${s.skill} ${argsLabel(s)}${s.id ? ` #${s.id}` : ''}${s.optional ? '（顺手）' : ''}`),
    round: `${a.iteration + 1}/${a.repeat}`, next_step: a.index,
    elapsed_real_s: Math.round((Date.now() - a.startedAt) / 1000),
    ...(running ? { running_step: { skill: running.skill, args: running.args, source: running.source, elapsed_real_s: Math.round((Date.now() - running.startedAt) / 1000) } } : {}),
    continue_effect: continueEffect,
    ...(lastCollection ? { last_collection: lastCollection } : {}),
    ...(a.applying ? { applying: a.applying, applying_at_start: a.applyingText ?? 'unknown' } : {}),
    ...(a.interruptions ? { interruptions: a.interruptions } : {}),
    ...(a.lastInterruption ? { last_interruption: { at: new Date(a.lastInterruption.at).toISOString(), kind: a.lastInterruption.kind, skill: a.lastInterruption.skill, reason: a.lastInterruption.reason, ...(a.lastInterruption.pos ? { pos: a.lastInterruption.pos } : {}) } } : {}),
    ...(done ? { done_when: { status: done.status, actual: done.actual } } : {}),
    ...(a.attemptOnly ? { attempt_only: a.attemptOnly.reason, original_done_when: a.attemptOnly.originalDoneWhen } : {}),
    ...(a.planCoverageGap ? { plan_coverage_gap: a.planCoverageGap } : {}),
    ...(a.navigation ? { navigation: describeNavigation(a.navigation) } : {}),
    ...(explore.searchIntent ? { exploration: {
      start: explore.start, end: explore.end, max_horizontal: explore.maxHorizontal,
      visited_cells: explore.visitedCells, local_only_so_far: explore.localOnly,
    } } : {}),
    ...(a.failures ? { failures: a.failures } : {}),
    ...(a.adaptations.length ? { body_adapted: a.adaptations } : {}),
    ...(a.dropped?.length ? { not_done_rejected: a.dropped } : {}),
    // 只在技能真的报告阶段时带上；没报告的步骤不补一个假阶段。
    ...(lastStage ? { last_nav_stage: stageOf(lastStage) } : {}),
    recent: a.results.slice(-3).map((r) => {
      const stage = stageOf(r);
      // 3 条的尾部各自至少留 ~80 字（260 的上限按 2/3 头、1/3 尾切，尾部长 260-174-1=85），
      // 否则 `[前,上,右]=…→ mine_cell {…}` 这类可执行尾巴仍会被切掉。
      return `${r.skill} → ${r.status}${r.failureCode ? `(${r.failureCode})` : ''}${typeof stage === 'string' ? `〔阶段 ${stage}〕` : ''}：${clipFeedback(r.summary, 260)}`;
    }),
    ...(a.expect ? { my_expectation: a.expect } : {}),
    ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
  };
}
