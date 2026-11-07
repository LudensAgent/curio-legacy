import {
  RoutePlanRegistryImpl,
  RouteVerifier,
  WalkRouteSearch,
  createWalkRouteSearchSource,
  inspectRoute,
  planRoute as libraryPlanRoute,
  type BodySample,
  type NavProblem,
  type PathFragment,
  type RoutePlan,
  type RoutePlanRegistryProblem,
  type RoutePlanScope,
  type RouteUnsupported,
  type WalkSearchSnapshot,
} from 'curio-minecraft-3d-memory';
import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkCollisionProvider } from '../../adapter/walk-route.ts';
import { fail, obj, ok, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';

type Scope = { worldId: string; dim: string; sessionId: string };
type RouteSource = 'auto' | 'search' | 'history';
type PlanArgs = {
  to: Vec3Like;
  mode: 'walk';
  source: RouteSource;
  pathId?: string;
  arrival: { kind: 'exact' };
  constraints?: { avoid?: string[]; maxNodes?: number; maxEdges?: number };
  deadlineMs?: number;
};
type PlanProblem = NavProblem | RouteUnsupported;

const BODY = { feet: { x: 0, y: 0, z: 0 }, width: 0.6, height: 1.8, pose: 'standing' as const };
/** 历史召回/执行起点容差；超过就必须重新规划，不能从别的起点硬套。 */
const START_TOLERANCE = 0.05;
const REGISTRY_CAPACITY = 128;
const REGISTRY_TTL_MS = 30_000;
const SEARCH_DEFAULTS = { maxNodes: 512, maxEdges: 2048, maxFrontiers: 32, maxDiagnostics: 32 };

const newRegistry = () => new RoutePlanRegistryImpl({ capacity: REGISTRY_CAPACITY, ttlMs: REGISTRY_TTL_MS, now: Date.now });
let routeRegistry = newRegistry();
let lastScope: Scope | null = null;

/**
 * 进程内路线句柄；重启即失效，不持久化。`plan` 是库注册表签发的完整计划
 * （A7 的置信度/可执行/verdict/边界/证据/过期/起点/目标/来源/pathId/作用域）；
 * `snapshot` 只保留给现有 walk 执行器读取点列，C-WALK-01 改用 consume 后可删。
 */
export type RouteRecord =
  | {
      kind: 'snapshot';
      plan: RoutePlan;
      snapshot: WalkSearchSnapshot;
      scope: Scope;
      from: Vec3Like;
      target: Vec3Like;
      validUntil: number;
      expiresAt: number;
    }
  | {
      kind: 'known';
      plan: RoutePlan;
      pathId: string;
      pathKind?: PathFragment['kind'];
      points: Vec3Like[];
      scope: Scope;
      from: Vec3Like;
      target: Vec3Like;
      validUntil: number;
      expiresAt: number;
    };

/** 旧 walk.ts 的只读视图；routeId 本身由库注册表签发和约束。 */
const routeRecords = new Map<string, RouteRecord>();

export function getRouteRecord(routeId: string): RouteRecord | undefined {
  const record = routeRecords.get(routeId);
  if (!record) return undefined;
  if (Date.now() > record.expiresAt) { routeRecords.delete(routeId); return undefined; }
  return record;
}

/** Atomically consume a plan handle. First call consumes it even if the checks fail. */
export function consumeRoutePlan(routeId: string, scope: RoutePlanScope): RoutePlan | RoutePlanRegistryProblem {
  return routeRegistry.consume(routeId, scope, Date.now());
}

/** Release an execution pin after the terminal outcome (handle stays consumed). */
export function releaseRoutePlan(routeId: string): void {
  routeRegistry.release(routeId);
}

/** 清空全部易失路线；重启/换会话/换维时调用。 */
export function clearRouteRecords() {
  routeRegistry = newRegistry();
  routeRecords.clear();
  lastScope = null;
}

function rememberRecord(record: RouteRecord) {
  const now = Date.now();
  for (const [id, existing] of routeRecords) {
    if (now > existing.expiresAt) routeRecords.delete(id);
  }
  while (routeRecords.size >= REGISTRY_CAPACITY) {
    const oldest = routeRecords.keys().next().value;
    if (oldest === undefined) break;
    routeRecords.delete(oldest);
  }
  routeRecords.set(record.plan.routeId, record);
}

const finitePoint = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

const distance3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

type Recall =
  | { kind: 'match'; pathId: string }
  | { kind: 'start_mismatch'; pathId: string; drift: number; routeStart: Vec3Like; routeEnd: Vec3Like };

/**
 * 宿主侧历史召回：只按起点做有界选择，不按终点过滤、不截断几何、不补边。
 * 终点是否等于请求由库的 history 规划给出 requested/resolvedTarget（允许略近的候选）。
 * 起点与实测脚位相差 >0.05 的片段不会硬套；source:'history' 会返回拒绝事实。
 */
function selectRecordedRoute(
  spatial: NonNullable<SkillCtx['spatial']>,
  state: { worldId: string; dim: string },
  from: Vec3Like,
): Recall | null {
  const page = spatial.session.history.fragments({ dim: state.dim, limit: 64 });
  let best: { pathId: string; drift: number; routeStart: Vec3Like; routeEnd: Vec3Like } | null = null;
  for (const fragment of page.items) {
    if (fragment.worldId !== state.worldId || fragment.polyline.length < 2) continue;
    const routeStart = fragment.polyline[0]!;
    const drift = distance3(routeStart, from);
    if (best !== null && drift >= best.drift) continue;
    best = { pathId: fragment.id, drift, routeStart, routeEnd: fragment.polyline.at(-1)! };
  }
  if (best === null) return null;
  return best.drift <= START_TOLERANCE
    ? { kind: 'match', pathId: best.pathId }
    : { kind: 'start_mismatch', ...best };
}

const measuredSample = (state: AgentState): BodySample => ({
  worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
  pos: { ...state.pos }, observedAt: Date.now(),
  alive: state.alive, connected: state.connected, observationReady: state.observationReady,
  onGround: state.onGround, inWater: state.inWater,
  executionId: 'plan_route', sequence: 0,
});

/** 搜索终态的结构化事实；历史规划没启动搜索时返回空。 */
function searchFacts(search: WalkRouteSearch) {
  const snapshot = search.status();
  if (snapshot === null) return {};
  const inspection = inspectRoute(snapshot);
  return {
    state: inspection.state,
    counters: inspection.counters,
    limits: inspection.limits,
    inspection: {
      state: inspection.state,
      reason: inspection.reason,
      boundaries: inspection.boundaries,
      counters: inspection.counters,
      limits: inspection.limits,
      ...(inspection.problem === undefined ? {} : { problem: inspection.problem }),
    },
  };
}

const UNSUPPORTED_KINDS = new Set<string>([
  'unsupported_mode', 'unsupported_arrival', 'unsupported_constraint', 'unsupported_geometry',
  'unobserved', 'budget_exhausted', 'not_authorized', 'scope_mismatch',
]);

function classificationOf(problem: PlanProblem): string {
  switch (problem.kind) {
    case 'cancelled': return 'CANCELLED';
    case 'timeout': return 'TIMEOUT';
    case 'budget_exhausted':
    case 'search_budget_exhausted': return 'BUDGET_EXHAUSTED';
    case 'unobserved':
    case 'stale':
    case 'unloaded': return 'INSUFFICIENT_EVIDENCE';
    case 'unavailable': return 'UNAVAILABLE';
    case 'no_path': return 'NO_PATH';
    case 'route_invalidated': return 'INVALIDATED';
    case 'scope_changed':
    case 'scope_mismatch': return 'SCOPE_MISMATCH';
    case 'unsupported_mode':
    case 'unsupported_arrival':
    case 'unsupported_constraint':
    case 'unsupported_geometry':
    case 'unsupported_target': return 'UNSUPPORTED';
    case 'not_authorized': return 'NOT_AUTHORIZED';
    case 'invalid_request': return 'INVALID_REQUEST';
    default: return 'FAILED';
  }
}

function failureCodeOf(problem: PlanProblem): FailureCode {
  switch (problem.kind) {
    case 'timeout':
    case 'budget_exhausted':
    case 'search_budget_exhausted': return 'TIMEOUT';
    case 'no_path':
    case 'route_invalidated': return 'PATH_NOT_FOUND';
    case 'unobserved':
    case 'stale':
    case 'unloaded': return 'NOT_FOUND';
    case 'unavailable': return 'NOT_CONNECTED';
    case 'scope_changed':
    case 'scope_mismatch': return 'WRONG_DIMENSION';
    case 'unsupported_mode':
    case 'unsupported_arrival':
    case 'unsupported_constraint':
    case 'unsupported_geometry':
    case 'unsupported_target':
    case 'invalid_request': return 'BAD_ARGS';
    default: return 'ERROR';
  }
}

/** 库失败分类 → 不同的技能结果；unsupported 保留 kind/detail，搜索附带 limits/counters/boundaries。 */
function planProblemResult(problem: PlanProblem, message: string | undefined, search: WalkRouteSearch): SkillResult {
  const facts = {
    backend: 'spatial_library',
    classification: classificationOf(problem),
    problem,
    ...(UNSUPPORTED_KINDS.has(problem.kind) ? { unsupported: problem } : {}),
    ...searchFacts(search),
  };
  if (problem.kind === 'cancelled') {
    return { status: 'cancelled', summary: message ?? `路线规划被取消：${problem.reason}`, data: facts };
  }
  const base = message ?? `路线规划失败（${problem.kind}）`;
  const detail = 'detail' in problem ? problem.detail : undefined;
  const summary = detail !== undefined && !base.includes(detail) ? `${base}：${detail}` : base;
  return fail(failureCodeOf(problem), summary, facts);
}

function planData(plan: RoutePlan, scope: Scope, search: WalkRouteSearch) {
  return {
    routeId: plan.routeId,
    backend: plan.backend,
    source: plan.source,
    ...(plan.kind === undefined ? {} : { kind: plan.kind }),
    points: plan.points,
    segments: plan.segments,
    cost: plan.cost,
    confidence: plan.confidence,
    executable: plan.executable,
    boundaries: plan.boundaries,
    unsupported: plan.unsupported ?? null,
    evidence: plan.evidence,
    expiresAt: plan.expiresAt,
    ...(plan.pathId === undefined ? {} : { pathId: plan.pathId }),
    ...(plan.verdict === undefined ? {} : { verdict: plan.verdict }),
    requestedTarget: plan.requestedTarget,
    resolvedTarget: plan.resolvedTarget,
    start: plan.start,
    scope,
    ...searchFacts(search),
  };
}

function rememberPlan(plan: RoutePlan, scope: Scope, search: WalkRouteSearch) {
  const common = { plan, scope, from: plan.start, target: plan.resolvedTarget, validUntil: plan.evidence.validUntil, expiresAt: plan.expiresAt };
  if (plan.source === 'history') {
    if (plan.pathId === undefined) return;
    rememberRecord({ kind: 'known', ...common, pathId: plan.pathId, ...(plan.kind === undefined ? {} : { pathKind: plan.kind }), points: plan.points });
    return;
  }
  const snapshot = search.status();
  if (snapshot === null) return;
  rememberRecord({ kind: 'snapshot', ...common, snapshot });
}

/** 历史起点不符：结构化 failure，不返回可执行 routeId，也不从路线中间开始。 */
function historyStartFailure(
  pathId: string | undefined,
  start: Vec3Like,
  routeStart: Vec3Like,
  drift: number,
  requestedTarget: Vec3Like,
  resolvedTarget: Vec3Like,
): SkillResult {
  const detail = `historical route "${pathId ?? 'recalled'}" starts at (${routeStart.x}, ${routeStart.y}, ${routeStart.z}) `
    + `but the measured body is at (${start.x}, ${start.y}, ${start.z}) (drift ${drift.toFixed(3)} > ${START_TOLERANCE})`;
  return fail('PATH_NOT_FOUND', `历史路线起点与当前实测脚位相差 ${drift.toFixed(2)} 格（须 ≤${START_TOLERANCE}）；不能从别的起点硬套，重新 plan_route 或改用 source:"auto"/"search"`, {
    backend: 'spatial_library',
    classification: 'HISTORY_START_MISMATCH',
    source: 'history',
    ...(pathId === undefined ? {} : { pathId }),
    start,
    routeStart,
    drift,
    requestedTarget,
    resolvedTarget,
    unsupported: { kind: 'unsupported_geometry', detail },
  });
}

/**
 * 只读路线规划：薄适配库的 `planRoute` + `RoutePlanRegistryImpl`。
 * 不移动、不转头、不观察、不写库；不重新搜索、无 pathfinder 兜底、不自造 routeId。
 * 返回库签发的单次 routeId；候选计划 executable:false，执行层必须拒绝。
 */
export const planRoute: Skill<PlanArgs> = {
  name: 'plan_route',
  description: '只读规划一条步行路线：用空间记忆库的 planRoute 做有界 WalkRouteSearch，或读取 Agent 明确指定/附近匹配的历史 fragment（walked/bridge/dug/built）并按当前证据复验。返回库签发的 routeId、路点、边界/阻断、置信度和过期时间；候选计划 executable:false。不移动、不转头、不观察、不写库。当前只支持 walk、exact 到达、同高 ±X/±Z、干燥整块；其他模式/台阶/下落/水面返回结构化 unsupported，不回退 pathfinder。',
  argsDoc: '{"to":{"x":0,"y":64,"z":0}, "mode"?: "walk", "source"?: "auto|search|history", "pathId"?: "历史 fragment ID", "arrival"?:{"kind":"exact"}, "deadlineMs"?:绝对 epoch 毫秒}；to 必须是绝对坐标（名字先用 resolve_target）；history 必须给 pathId，或能按 ≤0.05 起点从历史召回；终点是否精确由库的 requestedTarget/resolvedTarget 结论给出。不支持 near/reach_block、非空 avoid、挖/放/搭柱。',
  timeoutMs: 15000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['to', 'mode', 'source', 'pathId', 'fragmentId', 'arrival', 'constraints', 'deadlineMs']);
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length) return { ok: false, error: `plan_route 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const to = finitePoint(a.to);
    if (!to) return { ok: false, error: 'to 需要绝对坐标 {x,y,z}；名字/方向先用 resolve_target' };
    const mode = a.mode ?? 'walk';
    if (mode !== 'walk') return { ok: false, error: 'plan_route 当前只支持 mode:"walk"；游泳用 swim_path，船用 boat_path' };
    const source = a.source ?? 'auto';
    if (source !== 'auto' && source !== 'search' && source !== 'history') return { ok: false, error: 'source 必须是 auto、search 或 history' };
    const pathId = a.pathId ?? a.fragmentId;
    if (pathId !== undefined && (typeof pathId !== 'string' || !pathId.trim())) return { ok: false, error: 'pathId 必须是非空历史 fragment ID' };
    if (a.pathId !== undefined && a.fragmentId !== undefined && a.pathId !== a.fragmentId) return { ok: false, error: 'pathId 与 fragmentId 同时出现时必须相同' };
    if (source === 'search' && pathId !== undefined) return { ok: false, error: 'source:"search" 不接受 pathId；要沿历史路线用 source:"history"' };
    const arrival = a.arrival ?? { kind: 'exact' };
    if (!arrival || typeof arrival !== 'object' || Array.isArray(arrival) || (arrival as Record<string, unknown>).kind !== 'exact') {
      return { ok: false, error: 'arrival 当前只支持 {"kind":"exact"}；要走到附近请指定具体目标格' };
    }
    let constraints: PlanArgs['constraints'];
    if (a.constraints !== undefined) {
      if (!a.constraints || typeof a.constraints !== 'object' || Array.isArray(a.constraints)) return { ok: false, error: 'constraints 必须是对象' };
      const c = a.constraints as Record<string, unknown>;
      const cUnknown = Object.keys(c).filter((k) => !['avoid', 'maxNodes', 'maxEdges'].includes(k));
      if (cUnknown.length) return { ok: false, error: `constraints 不支持 ${cUnknown.join('、')}` };
      const avoid = c.avoid;
      if (avoid !== undefined && (!Array.isArray(avoid) || avoid.some((x) => typeof x !== 'string'))) return { ok: false, error: 'constraints.avoid 必须是字符串数组' };
      if (Array.isArray(avoid) && avoid.length) return { ok: false, error: 'plan_route 当前不支持非空 avoid；请换目标或先用其他动作处理' };
      for (const key of ['maxNodes', 'maxEdges'] as const) {
        if (c[key] !== undefined && (!Number.isInteger(c[key]) || (c[key] as number) <= 0)) return { ok: false, error: `constraints.${key} 必须是正整数` };
      }
      constraints = { ...(typeof c.maxNodes === 'number' ? { maxNodes: c.maxNodes } : {}), ...(typeof c.maxEdges === 'number' ? { maxEdges: c.maxEdges } : {}) };
    }
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { to, mode: 'walk', source, ...(typeof pathId === 'string' ? { pathId } : {}), arrival: { kind: 'exact' }, ...(constraints ? { constraints } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial) return fail('NOT_CONNECTED', 'plan_route 需要宿主共享空间会话（ctx.spatial）；当前未接线，不能用 pathfinder 兜底');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'plan_route 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', `当前世界 ${state.worldId} 与空间会话 ${spatial.worldId} 不一致`);
    if (spatial.closing || spatial.paused || !spatial.observationAdmitted) return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能规划路线');
    const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    if (Date.now() >= deadline) return fail('TIMEOUT', 'plan_route 期限在开始前已耗尽', { classification: 'TIMEOUT' });
    const scope: Scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    // 换会话/换维：旧 routeId 必须失效；重启由进程内注册表天然满足。
    if (lastScope !== null && (lastScope.worldId !== scope.worldId || lastScope.dim !== scope.dim || lastScope.sessionId !== scope.sessionId)) {
      clearRouteRecords();
    }
    lastScope = scope;
    const from = { ...state.pos };

    let pathId = args.pathId;
    if (pathId === undefined && args.source !== 'search') {
      const recall = selectRecordedRoute(spatial, state, from);
      if (recall?.kind === 'match') pathId = recall.pathId;
      else if (recall?.kind === 'start_mismatch' && args.source === 'history') {
        return historyStartFailure(recall.pathId, from, recall.routeStart, recall.drift, { ...args.to }, { ...recall.routeEnd });
      }
    }
    if (args.source === 'history' && pathId === undefined) {
      return fail('NOT_FOUND', '没有起点与当前实测脚位（≤0.05）匹配的记录路线（walked/bridge/dug/built）；用 spatial_query 列出，或改用 source:"search"', {
        backend: 'spatial_library',
        classification: 'INSUFFICIENT_EVIDENCE',
        source: 'history',
        start: from,
        requestedTarget: { ...args.to },
        detail: 'no recorded fragment starts within 0.05 of the measured feet',
      });
    }

    const search = new WalkRouteSearch(spatial.session.voxel, {
      now: Date.now,
      maxNodes: args.constraints?.maxNodes ?? SEARCH_DEFAULTS.maxNodes,
      maxEdges: args.constraints?.maxEdges ?? SEARCH_DEFAULTS.maxEdges,
      maxFrontiers: SEARCH_DEFAULTS.maxFrontiers,
      maxDiagnostics: SEARCH_DEFAULTS.maxDiagnostics,
    });
    const sample = measuredSample(state);
    const result = await libraryPlanRoute({
      to: { ...args.to }, mode: 'walk', source: args.source,
      ...(pathId === undefined ? {} : { pathId }),
      arrival: { kind: 'exact' },
      ...(args.constraints === undefined ? {} : { constraints: { ...(args.constraints.maxNodes === undefined ? {} : { maxNodes: args.constraints.maxNodes }), ...(args.constraints.maxEdges === undefined ? {} : { maxEdges: args.constraints.maxEdges }) } }),
      deadlineMs: deadline,
    }, {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: BODY,
      shapeProvider: walkCollisionProvider,
      sample: () => sample,
      search: createWalkRouteSearchSource(search),
      history: spatial.session.history,
      verifier: new RouteVerifier(spatial.session.voxel, { now: Date.now }),
      registry: routeRegistry,
      now: Date.now,
      signal: ctx.signal,
      cancellationOrigin: 'agent',
    });

    if (result.plan === undefined) {
      const problem: PlanProblem = result.problem ?? { kind: 'unavailable', detail: 'route planning returned neither a plan nor a problem' };
      return planProblemResult(problem, result.message, search);
    }
    const plan = result.plan;
    // 历史路线只从实测脚位开始：库给的可执行结论必须与起点一致；不符就返回拒绝，不硬套。
    if (plan.source === 'history') {
      const routeStart = plan.points[0];
      const drift = routeStart === undefined ? Infinity : distance3(plan.start, routeStart);
      if (routeStart === undefined || drift > START_TOLERANCE) {
        return historyStartFailure(plan.pathId, plan.start, routeStart ?? plan.resolvedTarget, drift, plan.requestedTarget, plan.resolvedTarget);
      }
    }
    rememberPlan(plan, scope, search);
    const label = plan.source === 'history'
      ? `历史路线 ${plan.pathId ?? ''}（${plan.kind ?? 'unknown'}）`
      : '已知空间路线';
    return ok(`${label}已规划：${plan.points.length - 1} 段，${plan.confidence}/${plan.verdict ?? 'UNKNOWN'}；routeId ${plan.routeId}，执行前仍会按当前证据复核`, planData(plan, scope, search));
  },
};
