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
import { searchLandRouteAsync, summarizeBoundaries, verifyLandRouteBounded, type LandRouteVerification, type LandSearchResult } from '../../spatial/land-search.ts';
import { goalOf, stanceFor, type NavigationGoal } from './goal.ts';
import { fail, obj, ok, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';

/**
 * 注册表拒绝 routeId 的六种原因。这是 route handle 是否“还能被注册表消费”的判定，
 * 与库在执行期报告的路线失效原因（route_invalidated/route_start_changed/scope_changed）
 * 分开：后者不是注册表问题，不能拿来实现 registryResult 的分类。
 */
export const ROUTE_REGISTRY_PROBLEM_KINDS = [
  'invalid_request', 'route_not_found', 'route_consumed', 'route_expired', 'scope_mismatch', 'route_not_executable',
] as const;
export type RouteRegistryProblemKind = typeof ROUTE_REGISTRY_PROBLEM_KINDS[number];
export const isRouteRegistryProblem = (reason: string | undefined): reason is RouteRegistryProblemKind =>
  reason !== undefined && (ROUTE_REGISTRY_PROBLEM_KINDS as readonly string[]).includes(reason);

type Scope = { worldId: string; dim: string; sessionId: string };
type RouteSource = 'auto' | 'search' | 'memory' | 'spatial';
/** Shared wall-clock budget for the strict + historical 3D A* passes. */
const SPATIAL_SEARCH_MS = 2500;
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
 * 这里只由共享 goal 语义派生一次：格目标取目标格内与起点相同的偏移；连续目标原样。
 */
function planTarget(to: Vec3Like, from: Vec3Like): { goal: NavigationGoal; stance: Vec3Like; cell?: Vec3Like } {
  const goal = goalOf(to);
  const stance = stanceFor(goal, from);
  return {
    goal,
    stance,
    ...(goal.kind === 'cell' ? { cell: { x: goal.cell.x, y: goal.footY, z: goal.cell.z } } : {}),
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
 * 历史 leg 的几何跨度。拓扑 leg 是节点到节点，可能跨多格；这里只描述记录几何，
 * 不证明支撑/净空/流体，也不把相邻一格当作当前可通行。`oneCellHop` 仅表示
 * 几何上可能由一步水平移动（或一格上下）覆盖，执行前仍须按当前证据复验。
 */
function legGeometry(from: Vec3Like, to: Vec3Like) {
  const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y), dz = Math.abs(to.z - from.z);
  const oneCellHop = dx + dz === 1 ? dy <= 1.001 : dx === 0 && dz === 0 && dy > 0.001 && dy <= 1.001;
  // maxSpan 是切比雪夫跨度（对角 (1,1) 仍为 1），不是格数；oneCellHop 才是“几何上可能一步”。
  return { span: { dx, dy, dz }, maxSpan: Math.max(dx, dy, dz), oneCellHop };
}

/**
 * 历史候选复验中的首个当前证据 BLOCKED 段；没有复验或没有 BLOCKED 时返回 null。
 * 只报告事实，不挖/不放，也不把该段自动改道。
 */
export function blockerOf(verification: LandRouteVerification | undefined) {
  if (verification === undefined) return null;
  const index = verification.transitions.findIndex((entry) => entry.status === 'BLOCKED');
  if (index < 0) return null;
  const entry = verification.transitions[index]!;
  return {
    index,
    transition: entry.transition,
    status: entry.status,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    hazards: entry.hazards,
  };
}

/** 只执行 blocker 之前的前缀；STALE/UNKNOWN 不算已观测阻挡，由执行动作逐步复核。 */
export function executionWindow(verification: LandRouteVerification | undefined, maxSteps: number, total: number) {
  const blocker = blockerOf(verification);
  return { blocker, limit: Math.min(maxSteps, blocker === null ? total : blocker.index) };
}

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
  const legs = inspection.segments.map((segment, index) => {
    const from = { ...inspection.points[index]! };
    const to = { ...inspection.points[index + 1]! };
    return {
      index, from, to,
      edgeType: segment.type,
      transition: transitionOf(segment.type),
      direction: segment.direction,
      evidenceId: segment.evidenceId,
      mode: segment.evidence.mode ?? null,
      source: segment.evidence.source,
      observedAt: segment.evidence.observedAt,
      ...legGeometry(from, to),
      historicalGeometry: true as const,
      executable: false as const,
      currentPassability: 'UNKNOWN' as const,
    };
  });
  const counts = legs.reduce<Record<string, number>>((all, leg) => ({ ...all, [leg.transition]: (all[leg.transition] ?? 0) + 1 }), {});
  const detail = Object.entries(counts).map(([transition, count]) => `${transition}×${count}`).join('、');
  const p = (v: Vec3Like) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
  const preview = legs.slice(0, 2).map((leg) => `第${leg.index + 1}段 ${leg.transition} ${p(leg.from)}→${p(leg.to)}`).join('；');
  const more = legs.length > 2 ? `；另有 ${legs.length - 2} 段` : '';
  // 拓扑 leg 可能跨多格：只把真正相邻的一格说成可能的一步，其余要求重新搜索或逐格核实。
  const walkLike = legs.filter((leg) => leg.transition === 'walk' || leg.transition === 'step');
  const multiCell = walkLike.filter((leg) => !leg.oneCellHop);
  const stepHint = walkLike.length === 0
    ? '本路线没有 walk/step 段'
    : multiCell.length > 0
      ? `其中 ${multiCell.length}/${walkLike.length} 段 walk/step 跨多格，不是一步 move_step：先 plan_route source:"search" 取 routeId 后 walk_path，或按实测逐格 move_step 并每步核实当前证据`
      : '相邻单格 walk/step 段可按当前证据逐段 move_step';
  const endpoint = inspection.points.at(-1)!;
  return {
    status: 'route' as const,
    summary: `空间记忆路线 ${legs.length} 段（${detail || '无'}）：从 ${p(from)} 到 ${p(to)}；先按现有动作执行：${preview}${more}（${stepHint}；drop 先 assess_landings 再 descend_to；climb/swim/portal/other 用对应现有动作或停下由你决定）；只到你选定的端点 ${p(endpoint)}，不要越过最后一点；这是历史几何，未验证当前可通，完成后按当前证据重新规划`,
    facts: {
      source: 'memory', backend: 'spatial_topology', status: inspection.status,
      fromNodeId: inspection.fromNodeId, toNodeId: inspection.toNodeId,
      points: inspection.points, legs, selectedEndpoint: { ...inspection.points.at(-1)! },
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

/**
 * 格目标的 3D 搜索结果只翻译成现有动作：walk/step/drop=1 → move_step，drop>1 → descend_to。
 * 连续精确脚位没有等价的格动作，返回空数组；执行请用 navigate_to 保持连续 endpoint，
 * 不能用 move_step 的格心动作冒充。
 */
export function landSearchSteps(result: Pick<LandSearchResult, 'transitions'>, goalKind: NavigationGoal['kind'] = 'cell') {
  const centered = (p: Vec3Like) => Math.abs(p.x - (Math.floor(p.x) + 0.5)) <= 1e-6
    && Math.abs(p.z - (Math.floor(p.z) + 0.5)) <= 1e-6;
  // 连续目标只有恰好落在目标格心时，move_step/descend_to 才是等价动作；
  // 任意分数偏移不生成会把它格心化的步骤。
  if (goalKind === 'feet' && !result.transitions.every((transition) => centered(transition.from) && centered(transition.to))) return [];
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

async function spatialRoute(spatial: NonNullable<SkillCtx['spatial']>, state: AgentState, goal: NavigationGoal, signal: AbortSignal, deadlineMs: number) {
  const request = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: BODY.width, height: BODY.height, pose: BODY.pose },
    goal,
    maxDrop: 4,
    rules: walkLandRules,
    signal,
    deadlineMs,
  };
  // 先用当前证据；找不到时再用历史体素候选。历史路线逐段用真实当前证据复验，
  // 执行时仍由连续身体控制逐步核实。两次搜索共用同一截止时间。
  const strict = await searchLandRouteAsync(spatial.session.voxel, request);
  const historical = strict.status === 'FOUND' ? null
    : await searchLandRouteAsync(spatial.session.voxel, { ...request, evidenceMode: 'remembered' });
  const result = strict.status === 'FOUND' ? strict
    : historical?.status === 'FOUND' ? historical
      : historical?.status === 'NO_PATH_IN_MEMORY' ? historical
        : strict;
  const steps = result.status === 'FOUND' ? landSearchSteps(result, goal.kind) : [];
  // boundarySummary 只汇总它伴随的 result.boundaries，避免同一回执里边界列表与计数
  // 来自不同证据来源。当前证据（strict）的前缀单独命名，历史几何不冒充可通行。
  const resultBoundarySummary = summarizeBoundaries(result.boundaries);
  const currentPrefix = strict.prefix;
  const currentBoundarySummary = summarizeBoundaries(strict.boundaries);
  const accessible = result === strict ? currentPrefix : undefined;
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
  const stale = result.stats.staleReads > 0;
  const boundaryGuidance = result.status === 'INSUFFICIENT_EVIDENCE'
    ? `还有未观察/证据过期（STALE）的边界${stale ? '，当前证据已过期' : ''}；先 look_around/靠近刷新证据再试`
    : result.status === 'NO_PATH_IN_MEMORY'
      ? result.evidenceMode === 'historical'
        ? '历史体素里也没有 walk/step/drop 路线（NO_PATH_IN_MEMORY）；需要挖/垫/搭、观察或换目标时由你决定'
        : '已存几何里没有 walk/step/drop 路线（NO_PATH_IN_MEMORY）；需要挖/垫/搭、观察或换目标时由你决定'
      : result.status === 'UNSUPPORTED'
        ? `搜索不支持该精确目标：${result.reason}；不自动改写成附近格或吸附脚高`
        : result.status === 'INVALIDATED'
          ? '搜索期间地图证据/驻留发生变化；重新观察或重试由你决定'
          : result.status === 'BUDGET_EXHAUSTED'
            ? result.budget === 'time'
              ? `搜索时间预算耗尽（${result.stats.durationMs}ms / ${SPATIAL_SEARCH_MS}ms），先规划更近的一段或走近再试`
              : `搜索 ${result.budget ?? '节点/边'} 预算耗尽（${result.stats.durationMs}ms），先规划更近的一段`
            : '先规划更近的一段，或走近/看清后再试';
  const fmt = (v: Vec3Like) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
  const accessibleNote = result === strict
    ? accessible === undefined || accessible.transitions.length === 0
      ? '没有已知可通行前缀'
      : `已知可通行的最远 approach 只到 ${fmt(accessible.endpoint)}（${accessible.transitions.length} 段），这不是到达`
    : currentPrefix === undefined || currentPrefix.transitions.length === 0
      ? '历史搜索无完整路线；当前证据下也没有可达前缀'
      : `历史搜索无完整路线；当前证据下存在可达前缀到 ${fmt(currentPrefix.endpoint)}（${currentPrefix.transitions.length} 段），这不是到达`;
  const boundaryNote = `；${resultBoundarySummary.observationMayResolve ? '额外观察/靠近可能刷新证据' : resultBoundarySummary.total === 0 ? '没有记录到边界' : '额外观察不会改变已观测阻挡'}；${resultBoundarySummary.needsExplicitActionOrOtherRoute ? '存在需要显式动作/其他移动能力/换路线的边界（由你决定）' : '未记录到需要挖/建或换路线的边界'}`;
  const routeLabel = result.evidenceMode === 'historical' ? '历史体素路线（含过期证据，当前可通行性未知）' : '空间 3D 路线';
  // 兼容读取方的显式历史候选复验：共享原 deadline、取消感知、逐段有界并让出事件循环。
  const verification = result.status === 'FOUND' && result.evidenceMode === 'historical'
    ? await verifyLandRouteBounded(spatial.session.voxel, {
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
        body: { feet: { ...state.pos }, width: BODY.width, height: BODY.height, pose: BODY.pose },
        rules: walkLandRules,
      }, result.transitions, { deadlineMs, signal })
    : undefined;
  // 历史候选的复验已经逐段在当前证据上重算；把首个 BLOCKED 段作为 blocker 事实
  // 交给调用方，执行方据此停在 blocker 前，不自动挖/放。
  const blocker = blockerOf(verification);
  const verifyCoverage = verification?.coverage;
  // 搜索候选已经完整（FOUND），但当前证据复验可以因真实取消提前停止。两者是不同事实：
  // 保留搜索终态与候选，只把“复验被取消、没有完整 OPEN”作为这次规划的公开结局。
  const verificationCancelled = verifyCoverage?.stopped === 'cancelled';
  const verifyNote = verification === undefined
    ? ''
    : `；严格当前证据复验：${verification.verdict}（当前 OPEN ${verification.openPrefix}/${result.transitions.length} 段${verifyCoverage !== undefined && !verifyCoverage.complete ? `；只检查了 ${verifyCoverage.checked}/${verifyCoverage.total} 段，其余为 UNKNOWN，不是 OPEN` : ''}${verificationCancelled ? '；复验被取消，没有完成整条路线' : ''}）${blocker === null ? '' : `；第 ${blocker.index + 1} 段 ${blocker.status}，执行时停在 blocker 前、不自动挖`}`;
  const stepsNote = goal.kind === 'feet'
    ? '；这是精确连续脚位路线，没有 move_step 等价动作，请用 navigate_to 执行'
    : '';
  return {
    result,
    steps,
    verificationCancelled,
    verificationCoverage: verifyCoverage,
    summary: result.status === 'FOUND'
      ? `${routeLabel} ${result.transitions.length} 段（${detail || '无'}）；${steps.length > 0 ? `已生成现有动作步骤：${stepDetail || '无'}。先执行：${stepPreview}${steps.length > 3 ? '；…' : ''}` : '未生成格动作步骤'}${stepsNote}；只读规划，不是执行授权；执行时按现场事实逐步核实，失败再重新规划${verifyNote}；drop>1 的 descend_to 仍要求当前可见落点`
      : `${result.evidenceMode === 'historical' ? '历史体素' : '空间 3D'}搜索没有可用路线：${result.status}（${result.boundaries.length} 个边界事实${boundaryDetail ? `：${boundaryDetail}` : ''}）；${accessibleNote}；${boundaryGuidance}${boundaryNote}`,
    facts: {
      source: 'spatial', backend: 'spatial_voxel_search', searchStatus: result.status,
      assurance: result.assurance, evidenceMode: result.evidenceMode, currentPassability: 'UNKNOWN', executable: false,
      targetKind: goal.kind, requestedTarget: { ...goal.requested },
      points: result.points, transitions: result.transitions, steps: result.status === 'FOUND' ? steps : [],
      boundaries: result.boundaries, cost: result.cost, resolvedTarget: result.resolvedTarget,
      stats: result.stats, budgetMs: SPATIAL_SEARCH_MS, searchMs: result.stats.durationMs,
      budget: result.budget ?? null, reason: result.reason,
      policy: result.policy ?? null,
      unavailableSections: result.unavailableSections,
      boundarySummary: resultBoundarySummary,
      ...(accessible === undefined ? {} : { prefix: accessible, prefixSteps: landSearchSteps(accessible, goal.kind) }),
      ...(result === strict ? {} : {
        ...(currentPrefix === undefined ? {} : { currentPrefix }),
        currentBoundaries: strict.boundaries,
        currentBoundarySummary,
      }),
      ...(verification === undefined ? {} : { verification, verifiedOpenSegments: verification.openPrefix, blocker }),
    },
  };
}

/**
 * 只读路线规划：共享空间记忆的 topology 历史路线 + 3D 体素搜索 + 库的已知空间搜索。
 * 不移动、不转头、不观察、不写库；不重新搜索、无 pathfinder 兜底、不自造 routeId。
 * `source:"memory"` 只查历史拓扑；`spatial` 在已观测 VoxelMap 上做 3D A*；
 * `auto` 只用实测体素（当前证据优先，可返回 remembered 几何候选，不回退同高搜索）；
 * 历史拓扑仅由显式 `source:"memory"` 选择，同高兼容搜索仅由显式 `source:"search"` 选择。
 */
export const planRoute: Skill<PlanArgs> = {
  name: 'plan_route',
  description: '只读规划路线：memory 查共享历史拓扑，spatial 在已观测 VoxelMap 上做有界 3D 搜索（walk/step/drop），search 查同高空间。memory 返回历史路点/过渡（legs 均带 executable:false、currentPassability UNKNOWN；跨多格 leg 不是一步 move_step），spatial 返回现有动作 steps（move_step/descend_to；精确连续脚位不给格动作），仅历史候选额外带当前证据逐段复验的 verifiedOpenSegments/blocker，search 返回 routeId（下一步交给 walk_path）；不新增动作。不移动/观察/写库，不挖/放/搭柱。spatial 失败时额外返回搜索终态（INSUFFICIENT_EVIDENCE/NO_PATH_IN_MEMORY/UNSUPPORTED/INVALIDATED/BUDGET_EXHAUSTED）、当前证据可达前缀 endpoint/transitions/prefixSteps 与 boundarySummary（边界位置/方向/状态/原因；前缀不是到达）；若回执采用历史候选，当前证据前缀另放 currentPrefix/currentBoundaries/currentBoundarySummary，不混用。auto 只用实测体素（当前证据优先、可返回 remembered 几何候选），不查询/不选择历史拓扑；只有显式 source:"memory" 才返回历史路线。目标脚高与当前不一致时不再回退同高 search。失败/gaps 时不要调用 walk_path；远目标证据不足时先规划更近的一段。',
  argsDoc: '{"to":{"x":0,"y":64,"z":0},"mode"?:"walk","source"?:"auto|memory|spatial|search","arrival"?:{"kind":"exact"},"deadlineMs"?:绝对 epoch 毫秒}；to 是绝对坐标（整数 x/z 为方块格，分数按精确脚位；名字先用 resolve_target）。search 只走当前脚高的同高格点，目标 y 不同时不会回退到 search；spatial 返回 points/transitions 和现有动作 steps，可能带 historical 标记（历史体素、当前可通行性未知，执行时逐步核实）；spatial 失败时返回可达前缀与边界摘要，前缀不是到达，也不会自动执行；search 返回 routeId（单次，交给 walk_path）；memory 返回路点/过渡；memory/spatial 都不是 routeId，也不直接授权执行；auto 只用实测体素（当前证据优先、可返回 remembered 几何候选）；历史拓扑路线只由显式 source:"memory" 选择。',
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
    // 有效能力取库报告与宿主声明的交集；显式 false 不调用对应库接口。
    const effectiveCaps = spatial.capabilities().effective;
    const scope: Scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    // 换会话/换维：旧 routeId 必须失效；重启由进程内注册表天然满足。
    noteRouteScope(scope);
    const from = { ...state.pos };
    const { goal, stance, cell } = planTarget(args.to, from);
    const cellNote = cell === undefined
      ? ''
      : `；目标格 (${cell.x},${cell.y},${cell.z})，按当前脚下偏移取格内站位 (${stance.x.toFixed(2)},${stance.y},${stance.z.toFixed(2)})`;

    // 普通 auto 与 spatial 都只用实测体素（当前/remembered 候选）；历史拓扑只由显式 source:"memory" 选择。
    // 已观测体素上的 3D 搜索：结果只翻译成现有 move_step/descend_to（格目标），
    // 不新增动作，也不把步骤当执行授权。
    if (args.source === 'spatial' || args.source === 'auto') {
      if (!spatial.session?.voxel) {
        return fail('NOT_CONNECTED', `plan_route source:"${args.source}" 需要共享空间 VoxelMap`);
      }
      const candidate = await spatialRoute(spatial, state, goal, ctx.signal, Math.min(deadline, Date.now() + SPATIAL_SEARCH_MS));
      const facts = { ...candidate.facts, ...(cell === undefined ? {} : { targetCell: cell }), requestedTarget: { ...args.to }, targetStance: { ...stance } };
      // 搜索已完成并给出候选，但随后的当前证据复验被真实取消：公开结局是取消，
      // 不能因为搜索 FOUND 就报 ok，也不能把搜索改写成 CANCELLED 或丢掉候选事实。
      if (candidate.verificationCancelled) {
        const coverage = candidate.verificationCoverage;
        const checked = coverage?.checked ?? 0;
        const total = coverage?.total ?? facts.transitions.length;
        return { status: 'cancelled', summary: `路线规划被取消：搜索候选仍是 FOUND（${facts.transitions.length} 段），但当前证据复验在取消时只检查了 ${checked}/${total} 段，未得到完整 OPEN${cellNote}`, data: facts };
      }
      if (candidate.result.status === 'FOUND') return ok(`${candidate.summary}${cellNote}`, facts);
      if (candidate.result.status === 'CANCELLED') return { status: 'cancelled', summary: `${candidate.summary}${cellNote}`, data: facts };
      // auto 必须原样交回体素终态；不落到历史、同高兼容搜索或能力门禁。
      const code: FailureCode = candidate.result.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT'
        : candidate.result.status === 'INSUFFICIENT_EVIDENCE' ? 'NOT_FOUND'
          : candidate.result.status === 'UNSUPPORTED' ? 'BAD_ARGS'
            : 'PATH_NOT_FOUND';
      return fail(code, `${candidate.summary}${cellNote}`, facts);
    }

    // 普通 auto 只用实测体素；历史拓扑路线只能由显式 source:"memory" 选择。
    if (args.source === 'memory') {
      if (typeof spatial.query !== 'function') {
        return fail('NOT_CONNECTED', 'plan_route source:"memory" 需要共享空间会话的查询端口');
      }
      const memory = effectiveCaps.query?.historyRoute === false
        ? { status: 'gap' as const, summary: '有效能力报告未授予 query.historyRoute，未查询历史拓扑', facts: { source: 'memory', executable: false, currentPassability: 'UNKNOWN' as const, capability: { domain: 'query', name: 'historyRoute' } } }
        : memoryRoute(spatial, state.dim, from, stance);
      const facts = { ...memory.facts, ...(cell === undefined ? {} : { targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance }) };
      if (memory.status === 'route') return ok(`${memory.summary}${cellNote}`, facts);
      return fail('PATH_NOT_FOUND', `${memory.summary}${cellNote}`, facts);
    }

    // 只有显式 source:"search" 使用同高兼容搜索。
    if (!spatial.session?.voxel) {
      return fail('NOT_CONNECTED', 'plan_route source:"search" 需要共享空间 VoxelMap');
    }
    if (effectiveCaps.plan?.walkSearch === false) {
      return fail('NOT_CONNECTED', '有效能力报告未授予 plan.walkSearch，未调用库路线搜索', {
        classification: 'CAPABILITY_UNAVAILABLE', capability: { domain: 'plan', name: 'walkSearch' },
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
      return cell === undefined ? outcome : {
        ...outcome,
        summary: `${outcome.summary}${cellNote}`,
        data: { ...(outcome.data ?? {}), targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance },
      };
    }
    const plan = result.plan;
    const data = planData(plan, scope, search);
    return ok(`已知空间路线已规划：${plan.points.length - 1} 段，${plan.confidence}/${plan.verdict ?? 'UNKNOWN'}；routeId ${plan.routeId}，下一步用 walk_path（routeId 单次），执行前仍会按当前证据复核${cellNote}`, cell === undefined ? data : {
      ...data, targetCell: cell, requestedTarget: { ...args.to }, targetStance: stance,
    });
  },
};
