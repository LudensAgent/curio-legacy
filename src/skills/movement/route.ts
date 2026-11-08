import {
  RoutePlanRegistryImpl,
  RouteVerifier,
  WalkRouteSearch,
  createWalkRouteSearchSource,
  inspectRoute,
  planRoute as libraryPlanRoute,
  type BodySample,
  type NavProblem,
  type RoutePlan,
  type RoutePlanRegistryProblem,
  type RoutePlanScope,
  type RouteUnsupported,
} from 'curio-minecraft-3d-memory';
import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkCollisionProvider } from '../../adapter/walk-route.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRoute, type LandSearchResult } from '../../spatial/land-search.ts';
import { fail, obj, ok, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';

type Scope = { worldId: string; dim: string; sessionId: string };
type RouteSource = 'auto' | 'search' | 'memory' | 'spatial';
type PlanArgs = {
  to: Vec3Like;
  mode: 'walk';
  source: RouteSource;
  arrival: { kind: 'exact' };
  constraints?: { avoid?: string[]; maxNodes?: number; maxEdges?: number };
  deadlineMs?: number;
};
type PlanProblem = NavProblem | RouteUnsupported;

const BODY = { feet: { x: 0, y: 0, z: 0 }, width: 0.6, height: 1.8, pose: 'standing' as const };
const REGISTRY_CAPACITY = 128;
const REGISTRY_TTL_MS = 30_000;
const SEARCH_DEFAULTS = { maxNodes: 512, maxEdges: 2048, maxFrontiers: 32, maxDiagnostics: 32 };

const newRegistry = () => new RoutePlanRegistryImpl({ capacity: REGISTRY_CAPACITY, ttlMs: REGISTRY_TTL_MS, now: Date.now });
let routeRegistry = newRegistry();
let lastScope: Scope | null = null;

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
  lastScope = null;
}

/**
 * 入口作用域对账：world/dim/session 任一变化都先清空旧路线，
 * 让旧 routeId 变成 route_not_found，而不是可被新作用域误用的残留。
 */
export function noteRouteScope(scope: RoutePlanScope): void {
  if (lastScope !== null && (lastScope.worldId !== scope.worldId || lastScope.dim !== scope.dim || lastScope.sessionId !== scope.sessionId)) {
    clearRouteRecords();
  }
  lastScope = scope;
}

const finitePoint = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

/**
 * `plan_route` 的 to 沿用其它动作的方块格坐标约定：x/z 是整数时表示“走到那一格”。
 * 库的步行格点以实测脚位为原点，只接受整数 X/Z 偏移；玩家实际脚位几乎总带小数
 * （如 -61.3/-42.7），直接把整数格坐标传进去会被判成“非整数偏移”。
 * 这里在目标格内取与当前脚下相同的偏移，既落在目标格内，又正好是库的格点。
 * 分数 x/z 仍按精确脚位原样传入，供测试/内部调用使用。
 */
function targetStance(to: Vec3Like, from: Vec3Like): { stance: Vec3Like; cell?: Vec3Like } {
  if (!Number.isInteger(to.x) || !Number.isInteger(to.z)) return { stance: { ...to } };
  const cell = { x: Math.floor(to.x), y: to.y, z: Math.floor(to.z) };
  return {
    stance: {
      x: from.x + (cell.x - Math.floor(from.x)),
      y: to.y,
      z: from.z + (cell.z - Math.floor(from.z)),
    },
    cell,
  };
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

type MemoryTransition = 'walk' | 'step' | 'drop' | 'climb' | 'swim' | 'portal' | 'other';

/** 拓扑边类型 → 通用过渡；行走/挖洞/桥的区别只在 fragment 证据里，不在这里分支。 */
const transitionOf = (type: string): MemoryTransition => {
  switch (type) {
    case 'HORIZONTAL': case 'CAVE_PASSAGE': case 'BRIDGE': return 'walk';
    case 'STAIRCASE': return 'step';
    case 'DROP': return 'drop';
    case 'VERTICAL_SHAFT': case 'LADDER': case 'CLIMB': return 'climb';
    case 'SWIM': return 'swim';
    case 'PORTAL': return 'portal';
    default: return 'other';
  }
};

/**
 * 共享空间记忆的路线：库的 topology 查询已经把 walked/dug/bridge/built 统一成
 * 节点/边；这里只把边类型翻译成通用过渡，不按 fragment.kind 走不同逻辑。
 */
function memoryRoute(spatial: NonNullable<SkillCtx['spatial']>, dim: string, from: Vec3Like, to: Vec3Like) {
  const query = spatial.query({ kind: 'historyRoute', dim, from, to, near: 5 });
  const data = query.data;
  if (query.status !== 'ok' || data?.kind !== 'historyRoute') {
    return {
      status: 'gap' as const,
      summary: `空间记忆路线查询失败：${query.status}${query.problem?.kind ? `（${query.problem.kind}）` : ''}`,
      facts: { source: 'memory', backend: 'spatial_topology', queryStatus: query.status, problem: query.problem ?? null, executable: false, currentPassability: 'UNKNOWN' as const },
    };
  }
  const inspection = data.inspection;
  if (inspection.status !== 'FOUND' || inspection.points.length === 0) {
    return {
      status: 'gap' as const,
      summary: `空间记忆里没有可用路线：${inspection.status}；${inspection.message}`,
      facts: {
        source: 'memory', backend: 'spatial_topology', status: inspection.status,
        fromNodeId: inspection.fromNodeId, toNodeId: inspection.toNodeId,
        gaps: inspection.gaps, message: inspection.message,
        historicalGeometry: true, executable: false, currentPassability: 'UNKNOWN' as const,
      },
    };
  }
  const legs = inspection.segments.map((segment, index) => ({
    index,
    from: { ...inspection.points[index]! },
    to: { ...inspection.points[index + 1]! },
    edgeType: segment.type,
    transition: transitionOf(segment.type),
    direction: segment.direction,
    evidenceId: segment.evidenceId,
    mode: segment.evidence.mode ?? null,
    source: segment.evidence.source,
  }));
  const counts = legs.reduce<Record<string, number>>((all, leg) => ({ ...all, [leg.transition]: (all[leg.transition] ?? 0) + 1 }), {});
  const detail = Object.entries(counts).map(([transition, count]) => `${transition}×${count}`).join('、');
  const p = (v: Vec3Like) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
  const preview = legs.slice(0, 2).map((leg) => `第${leg.index + 1}段 ${leg.transition} ${p(leg.from)}→${p(leg.to)}`).join('；');
  const more = legs.length > 2 ? `；另有 ${legs.length - 2} 段` : '';
  return {
    status: 'route' as const,
    summary: `空间记忆路线 ${legs.length} 段（${detail || '无'}）：从 ${p(from)} 到 ${p(to)}；先按现有动作执行：${preview}${more}（walk 段可再 plan_route source:"search" 取得 routeId 后 walk_path，或用 move_step；step 用 move_step；drop 先 assess_landings 再 descend_to；climb/swim/portal/other 用对应现有动作或停下由你决定）；这是历史几何，未验证当前可通，完成后按当前证据重新规划`,
    facts: {
      source: 'memory', backend: 'spatial_topology', status: inspection.status,
      fromNodeId: inspection.fromNodeId, toNodeId: inspection.toNodeId,
      points: inspection.points, legs,
      gaps: inspection.gaps, message: inspection.message,
      historicalGeometry: true, executable: false, currentPassability: 'UNKNOWN' as const,
    },
  };
}

const facingOf = (from: Vec3Like, to: Vec3Like): 'N' | 'E' | 'S' | 'W' => {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W';
  return dz >= 0 ? 'S' : 'N';
};

/** 3D 搜索结果只翻译成现有动作：walk/step/drop=1 → move_step，drop>1 → descend_to。 */
export function landSearchSteps(result: LandSearchResult) {
  return result.transitions.map((transition) => {
    // L1 move_step 的绝对 xyz 是“方块格”坐标；descend_to 的 target 也会规整到格心。
    const fromCell = { x: Math.floor(transition.from.x), y: transition.from.y, z: Math.floor(transition.from.z) };
    const toCell = { x: Math.floor(transition.to.x), y: transition.to.y, z: Math.floor(transition.to.z) };
    return transition.kind === 'drop' && transition.drop > 1
      ? { skill: 'descend_to', args: { target: { x: toCell.x, y: toCell.y, z: toCell.z } } }
      : {
          skill: 'move_step',
          args: { xyz: [toCell.x, toCell.y, toCell.z], facing: facingOf(fromCell, toCell) },
        };
  });
}

function spatialRoute(spatial: NonNullable<SkillCtx['spatial']>, state: AgentState, to: Vec3Like, signal: AbortSignal) {
  const result = searchLandRoute(spatial.session.voxel, {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: BODY.width, height: BODY.height, pose: BODY.pose },
    to,
    maxDrop: 4,
    rules: walkLandRules,
    signal,
  });
  const steps = result.status === 'FOUND' ? landSearchSteps(result) : [];
  const counts = result.transitions.reduce<Record<string, number>>((all, transition) => ({ ...all, [transition.kind]: (all[transition.kind] ?? 0) + 1 }), {});
  const detail = Object.entries(counts).map(([kind, count]) => `${kind}×${count}`).join('、');
  const stepCounts = steps.reduce<Record<string, number>>((all, step) => ({ ...all, [step.skill]: (all[step.skill] ?? 0) + 1 }), {});
  const stepDetail = Object.entries(stepCounts).map(([skill, count]) => `${skill}×${count}`).join('、');
  // 只给数量时模型无法执行这些步骤；把前几步参数放进摘要，明确“先执行它们，再重新规划”。
  const stepPreview = steps.slice(0, 3).map((step) => `${step.skill} ${JSON.stringify(step.args)}`).join('；');
  const boundaryCounts = result.boundaries.reduce<Record<string, number>>((all, boundary) => {
    const key = `${boundary.status}/${boundary.kind}`;
    all[key] = (all[key] ?? 0) + 1;
    return all;
  }, {});
  const boundaryDetail = Object.entries(boundaryCounts).map(([key, count]) => `${key}×${count}`).join('、');
  const stale = result.stats.staleEdges > 0;
  const boundaryGuidance = result.status === 'UNKNOWN'
    ? `还有未观察/证据过期（STALE）的边界${stale ? '，当前证据已过期' : ''}；先 look_around/靠近刷新证据再试`
    : result.status === 'NO_PATH'
      ? '已观察地形里没有 walk/step/drop 路线；需要挖/垫/搭或换目标时由你决定'
      : result.status === 'BUDGET_EXHAUSTED'
        ? '搜索预算耗尽，先规划更近的一段'
        : '先规划更近的一段，或走近/看清后再试';
  return {
    result,
    steps,
    summary: result.status === 'FOUND'
      ? `空间 3D 路线 ${result.transitions.length} 段（${detail || '无'}）；已生成现有动作步骤：${stepDetail || '无'}。先执行：${stepPreview}${steps.length > 3 ? '；…' : ''}；只读规划，不是执行授权，执行后按当前证据重新规划；drop>1 的 descend_to 仍要求当前可见落点`
      : `空间 3D 搜索没有可用路线：${result.status}（${result.boundaries.length} 个边界事实${boundaryDetail ? `：${boundaryDetail}` : ''}）；${boundaryGuidance}`,
    facts: {
      source: 'spatial', backend: 'spatial_voxel_search',
      assurance: result.assurance, executable: false,
      points: result.points, transitions: result.transitions, steps: result.status === 'FOUND' ? steps : [],
      boundaries: result.boundaries, cost: result.cost, resolvedTarget: result.resolvedTarget, stats: result.stats,
    },
  };
}

/**
 * 只读路线规划：共享空间记忆的 topology 历史路线 + 3D 体素搜索 + 库的已知空间搜索。
 * 不移动、不转头、不观察、不写库；不重新搜索、无 pathfinder 兜底、不自造 routeId。
 * `source:"memory"` 只查历史拓扑；`spatial` 在已观测 VoxelMap 上做 3D A*；
 * `auto` 依次尝试 memory → spatial → 同高 search。
 */
export const planRoute: Skill<PlanArgs> = {
  name: 'plan_route',
  description: '只读规划路线：memory 查共享历史拓扑，spatial 在已观测 VoxelMap 上做 3D A*（walk/step/drop），search 查同高空间。memory 返回路点/过渡，spatial 返回现有动作 steps（move_step/descend_to），search 返回 routeId（下一步交给 walk_path）；不新增动作。不移动/观察/写库，不挖/放/搭柱。auto 先 memory→spatial；只有目标脚高与当前一致时才回退 search。失败/gaps 时不要调用 walk_path；远目标证据不足时先规划更近的一段。',
  argsDoc: '{"to":{"x":0,"y":64,"z":0},"mode"?:"walk","source"?:"auto|memory|spatial|search","arrival"?:{"kind":"exact"},"deadlineMs"?:绝对 epoch 毫秒}；to 是绝对坐标（整数 x/z 为方块格，分数按精确脚位；名字先用 resolve_target）。search 只走当前脚高的同高格点，目标 y 不同时不会回退到 search；spatial 返回 points/transitions 和现有动作 steps；search 返回 routeId（单次，交给 walk_path）；memory 返回路点/过渡；memory/spatial 都不是 routeId，也不直接授权执行。',
  timeoutMs: 15000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['to', 'mode', 'source', 'arrival', 'constraints', 'deadlineMs']);
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length) return { ok: false, error: `plan_route 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const to = finitePoint(a.to);
    if (!to) return { ok: false, error: 'to 需要绝对坐标 {x,y,z}；名字/方向先用 resolve_target' };
    const mode = a.mode ?? 'walk';
    if (mode !== 'walk') return { ok: false, error: 'plan_route 当前只支持 mode:"walk"；游泳用 swim_path，船用 boat_path' };
    const source = a.source ?? 'auto';
    if (source !== 'auto' && source !== 'search' && source !== 'memory' && source !== 'spatial') return { ok: false, error: 'source 必须是 auto、memory、spatial 或 search' };
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
    return { ok: true, args: { to, mode: 'walk', source, arrival: { kind: 'exact' }, ...(constraints ? { constraints } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
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
    noteRouteScope(scope);
    const from = { ...state.pos };
    const { stance, cell } = targetStance(args.to, from);
    const cellNote = cell === undefined
      ? ''
      : `；目标格 (${cell.x},${cell.y},${cell.z})，按当前脚下偏移取格内站位 (${stance.x.toFixed(2)},${stance.y},${stance.z.toFixed(2)})`;

    // 共享空间记忆优先：所有 kind 的历史通道在同一张拓扑图里，不按旧矿道/桥分支。
    if ((args.source === 'memory' || args.source === 'auto') && typeof spatial.query === 'function') {
      const memory = memoryRoute(spatial, state.dim, from, stance);
      const facts = { ...memory.facts, ...(cell === undefined ? {} : { targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance }) };
      if (memory.status === 'route') return ok(`${memory.summary}${cellNote}`, facts);
      if (args.source === 'memory') return fail('PATH_NOT_FOUND', `${memory.summary}${cellNote}`, facts);
    } else if (args.source === 'memory') {
      return fail('NOT_CONNECTED', 'plan_route source:"memory" 需要共享空间会话的查询端口');
    }

    // 已观测体素上的 3D 搜索：结果只翻译成现有 move_step/descend_to，
    // 不新增动作，也不把步骤当执行授权。
    let spatialGap: { summary: string; facts: Record<string, unknown> } | null = null;
    if (args.source === 'spatial' || args.source === 'auto') {
      if (!spatial.session?.voxel) {
        if (args.source === 'spatial') return fail('NOT_CONNECTED', 'plan_route source:"spatial" 需要共享空间 VoxelMap');
      } else {
        const candidate = spatialRoute(spatial, state, stance, ctx.signal);
        const facts = { ...candidate.facts, ...(cell === undefined ? {} : { targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance }) };
        if (candidate.result.status === 'FOUND') return ok(`${candidate.summary}${cellNote}`, facts);
        if (candidate.result.status === 'CANCELLED') return { status: 'cancelled', summary: `${candidate.summary}${cellNote}`, data: facts };
        if (args.source === 'spatial') {
          const code: FailureCode = candidate.result.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT' : candidate.result.status === 'UNKNOWN' ? 'NOT_FOUND' : 'PATH_NOT_FOUND';
          return fail(code, `${candidate.summary}${cellNote}`, facts);
        }
        spatialGap = { summary: candidate.summary, facts };
      }
    }

    // 同高 search 的库只接受与当前脚高完全一致的精确目标；目标 y 变化时它必然
    // 返回 unsupported_target，再回退只会把真正有用的 3D 边界事实淹没。auto 到这里
    // 说明 memory/spatial 都没有给出可执行路线，直接把换层事实和边界交回。
    const heightChange = Math.abs(stance.y - from.y) > 0.01;
    if (args.source === 'auto' && heightChange) {
      const gap = spatialGap ? `；空间 3D：${spatialGap.summary}` : '';
      return fail('BAD_ARGS', `目标脚高 ${stance.y} 与当前 ${from.y} 不同（${(stance.y - from.y).toFixed(2)} 格），同高 search 只支持固定脚高 ${from.y}，不能表示换层${gap}；换层由你用相邻一格 move_step，或更大落差先 assess_landings 再 descend_to 显式处理（不自动改目标）${cellNote}`, {
        ...(spatialGap?.facts ?? {}),
        targetFoot: stance.y, currentFoot: from.y, heightChange: stance.y - from.y,
        ...(cell === undefined ? {} : { targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance }),
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
      to: { ...stance }, mode: 'walk', source: 'search',
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
      const outcome = planProblemResult(problem, result.message, search);
      const annotated = cell === undefined ? outcome : {
        ...outcome,
        summary: `${outcome.summary}${cellNote}`,
        data: { ...(outcome.data ?? {}), targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance },
      };
      return spatialGap === null ? annotated : {
        ...annotated,
        summary: `${annotated.summary}；空间 3D：${spatialGap.summary}`,
        data: { ...(annotated.data ?? {}), spatialGap: spatialGap.facts },
      };
    }
    const plan = result.plan;
    const data = planData(plan, scope, search);
    return ok(`已知空间路线已规划：${plan.points.length - 1} 段，${plan.confidence}/${plan.verdict ?? 'UNKNOWN'}；routeId ${plan.routeId}，下一步用 walk_path（routeId 单次），执行前仍会按当前证据复核${cellNote}`, cell === undefined ? data : {
      ...data, targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance,
    });
  },
};
