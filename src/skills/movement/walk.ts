import { GROUNDED_ARRIVAL_DEFAULTS, startKnownWalkRoute, type NavResult, type RoutePlan, type RoutePlanRegistryProblem, type Vec3Like, type WalkRouteStatus, type WalkRouteRequest } from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../../adapter/walk-route.ts';
import { bodyLocalCells, observeCells } from '../walk-route.ts';
import { fail, ok, obj, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';
import { clearRouteRecords, consumeRoutePlan, noteRouteScope, releaseRoutePlan } from './route.ts';

const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };
/** 规划时实测起点与执行时实测脚位的最大欧氏距离；超过就必须重新规划。 */
const START_TOLERANCE = 0.05;

type WalkArgs = { routeId: string; deadlineMs?: number };
type WalkOutcome = 'ARRIVED' | 'PARTIAL' | 'NO_PATH' | 'BLOCKED' | 'INVALIDATED' | 'TIMEOUT' | 'CANCELLED' | 'EFFECT_NOT_CONFIRMED' | 'ERROR';

const distance3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clonePoints = (points: readonly Vec3Like[]) => points.map((p) => ({ ...p }));
const isPlan = (value: RoutePlan | RoutePlanRegistryProblem): value is RoutePlan => 'backend' in value;

/**
 * 库的终态 → 宿主结局。证据/作用域失效独立为 INVALIDATED，不折叠成没路或通用错误；
 * 偏离是部分进展，不能冒充到达；能力/执行失败是 ERROR，不能伪装 TIMEOUT。
 */
function outcomeOf(nav: NavResult): WalkOutcome {
  if (nav.outcome === 'ARRIVED') return 'ARRIVED';
  if (nav.outcome === 'CANCELLED') return 'CANCELLED';
  if (nav.outcome === 'TIMEOUT') return 'TIMEOUT';
  switch (nav.problem?.kind) {
    case 'route_invalidated':
    case 'scope_changed':
    case 'stale':
    case 'unobserved':
    case 'unloaded': return 'INVALIDATED';
    case 'deviation': return 'PARTIAL';
    case 'support_missing':
    case 'blocked':
    case 'head_blocked':
    case 'hazard':
    case 'occupied': return 'BLOCKED';
    case 'unconfirmed_arrival':
    case 'unmeasured_position': return 'EFFECT_NOT_CONFIRMED';
    case 'unavailable':
    case 'execution_failed': return 'ERROR';
    case 'no_path': return 'NO_PATH';
    case 'timeout': return 'TIMEOUT';
    case 'cancelled': return 'CANCELLED';
    default: return nav.outcome === 'NO_PATH' ? 'NO_PATH' : nav.outcome === 'BLOCKED' ? 'BLOCKED' : nav.outcome === 'PARTIAL' ? 'PARTIAL' : 'ERROR';
  }
}

/** 已消费计划的固定外壳；逐次执行只补实测/终态字段。 */
function planFacts(plan: RoutePlan) {
  return {
    routeId: plan.routeId,
    routeKind: plan.source === 'history' ? 'known' : 'snapshot',
    pathId: plan.pathId ?? null,
    backend: plan.backend,
    requestedTarget: plan.requestedTarget,
    resolvedTarget: plan.resolvedTarget,
    consumption: [] as [],
  };
}

/**
 * 执行终态结果。`confirmedSegments`/`remainingPoints` 只来自执行器终态 status；
 * 没有 status（启动被拒）就是 0/全部计划点，不根据 outcome 反推。
 */
function navData(plan: RoutePlan, status: WalkRouteStatus | null, nav: NavResult) {
  const outcome = outcomeOf(nav);
  // 已确认段数只来自执行器终态 status；启动被拒（无 status）就是 0，不按 outcome 反推。
  const confirmedSegments = status === null ? 0 : Math.max(0, status.nextPointIndex - 1);
  const remainingPoints = nav.outcome === 'ARRIVED'
    ? []
    : status === null ? clonePoints(plan.points) : clonePoints(plan.points.slice(status.nextPointIndex));
  return {
    ...planFacts(plan),
    outcome,
    navOutcome: nav.outcome,
    confirmed: outcome === 'ARRIVED',
    message: nav.message,
    position: nav.lastPosition ?? null,
    lastObservation: nav.lastObservation ?? null,
    trace: nav.trace,
    problem: nav.problem ?? null,
    memoryWrite: nav.memoryWrite ?? null,
    confirmedSegments,
    remainingPoints,
    ...(outcome === 'INVALIDATED'
      ? { invalidation: { segment: confirmedSegments, reason: nav.problem?.kind ?? 'route_invalidated' } }
      : {}),
  };
}

function navToResult(plan: RoutePlan, status: WalkRouteStatus | null, nav: NavResult): SkillResult {
  const data = navData(plan, status, nav);
  const outcome = data.outcome;
  if (outcome === 'ARRIVED') return ok(nav.message, data);
  if (outcome === 'CANCELLED') return { status: 'cancelled', summary: nav.message, data };
  if (outcome === 'TIMEOUT') return fail('TIMEOUT', nav.message, data);
  if (outcome === 'BLOCKED' || outcome === 'NO_PATH') return fail('PATH_NOT_FOUND', nav.message, data);
  if (outcome === 'ERROR') return fail('ERROR', nav.message, data);
  return fail('EFFECT_NOT_CONFIRMED', nav.message, data);
}

/** 未启动执行时的固定事实：没有任何已确认段，剩余点就是整条计划。 */
function notStarted(plan: RoutePlan) {
  return {
    ...planFacts(plan),
    confirmed: false,
    confirmedSegments: 0,
    remainingPoints: clonePoints(plan.points),
    trace: [],
  };
}

/** 执行前的结构化拒绝：路线已消费，但没有任何身体动作。 */
function gateFailure(plan: RoutePlan, reason: string, code: FailureCode, summary: string, extra: Record<string, unknown> = {}): SkillResult {
  return fail(code, summary, {
    ...notStarted(plan),
    outcome: 'INVALIDATED',
    invalidation: { segment: 0, reason },
    ...extra,
  });
}

/**
 * 注册表拒绝：routeId 从未（或已不能）成为可执行路线。
 * 这里没有可读的计划几何，因此不谎报 confirmedSegments/remainingPoints。
 */
function registryFailure(routeId: string, problem: RoutePlanRegistryProblem): SkillResult {
  const messages: Record<RoutePlanRegistryProblem['kind'], string> = {
    invalid_request: `routeId ${routeId} 无效；重新 plan_route`,
    route_not_found: `routeId ${routeId} 不存在或已过期；重新 plan_route`,
    route_consumed: `routeId ${routeId} 已被消费；每次执行都必须重新 plan_route`,
    route_expired: `routeId ${routeId} 已过期；重新 plan_route`,
    scope_mismatch: '路线作用域与当前世界/维度/会话不符；重新 plan_route',
    route_not_executable: `routeId ${routeId} 不可执行；重新 plan_route`,
  };
  const code: FailureCode = problem.kind === 'scope_mismatch'
    ? 'WRONG_DIMENSION'
    : problem.kind === 'route_expired' ? 'EFFECT_NOT_CONFIRMED' : 'BAD_ARGS';
  return fail(code, messages[problem.kind], {
    routeId,
    outcome: 'INVALIDATED',
    confirmed: false,
    plan: null,
    invalidation: { segment: 0, reason: problem.kind },
    consumption: [],
    problem,
    trace: [],
    ...(problem.kind === 'scope_mismatch' ? { expected: problem.expected, actual: problem.actual } : {}),
    ...(problem.kind === 'route_not_found' ? { unsupported: { reason: 'unknown_or_expired_route' } } : {}),
  });
}

const watchedAdapters = new WeakSet<object>();

/** 每个适配器只订阅一次真实会话重置：旧 routeId 立即失效，不跨会话执行。 */
function watchSessionReset(adapter: SkillCtx['adapter']) {
  if (watchedAdapters.has(adapter)) return;
  watchedAdapters.add(adapter);
  adapter.on('session_reset', clearRouteRecords);
}

/**
 * 执行 plan_route 返回的 routeId。只沿已规划路线走：不重新搜索、不换路、不挖/垫。
 * routeId 单次消费；consume 复核 executable/过期/作用域，宿主另查 verdict/起点，失败不写控制。
 * 到达由库的实测 BodySample 与 bodyArrival 容差确认；失效/取消保留实测位置与 trace。
 */
export const walkPath: Skill<WalkArgs> = {
  name: 'walk_path',
  description: '执行 plan_route 返回的 routeId。只沿已规划路线走，不重新搜索、不换路、不挖/垫/搭柱；每段按当前证据复验，证据失效即停并返回 INVALIDATED。routeId 单次使用。ARRIVED 必须由实测身体位置确认；PARTIAL 只表示部分进展，不是到达。',
  argsDoc: '{"routeId":"plan_route 返回的 routeId", "deadlineMs"?:绝对 epoch 毫秒}；只接受这两个参数。需要适配器的 walkBody/walkTick 和共享空间会话；路线不可执行/已消费/过期/作用域不符/起点改变时拒绝执行。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const unknown = Object.keys(a).filter((k) => !['routeId', 'deadlineMs'].includes(k));
    if (unknown.length) return { ok: false, error: `walk_path 不认识参数 ${unknown.join('、')}；只接受 routeId、deadlineMs` };
    if (typeof a.routeId !== 'string' || !a.routeId.trim()) return { ok: false, error: 'routeId 需要 plan_route 返回的非空 ID' };
    if (a.deadlineMs !== undefined && (typeof a.deadlineMs !== 'number' || !Number.isFinite(a.deadlineMs) || a.deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { routeId: a.routeId, ...(a.deadlineMs !== undefined ? { deadlineMs: a.deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const state = ctx.adapter.state();
    const scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    watchSessionReset(ctx.adapter);
    // 换会话/换维的入口对账先于消费：旧 routeId 必须 route_not_found，而不是 scope_mismatch 后仍可换作用域复用。
    noteRouteScope(scope);
    const consumed = consumeRoutePlan(args.routeId, scope);
    if (!isPlan(consumed)) return registryFailure(args.routeId, consumed);
    const plan = consumed;
    try {
      // consume 已唯一负责 executable/expiry/scope；这里只补注册表不做的作用域后 verdict 门禁。
      if (plan.verdict !== undefined && plan.verdict !== 'OPEN') {
        return gateFailure(plan, 'route_not_executable', 'EFFECT_NOT_CONFIRMED', `路线 ${plan.routeId} 的 verdict 是 ${plan.verdict}，不是 OPEN；重新 plan_route`);
      }
      const spatial = ctx.spatial;
      if (!spatial) return fail('NOT_CONNECTED', 'walk_path 需要宿主共享空间会话（ctx.spatial）', notStarted(plan));
      if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', `当前世界 ${state.worldId} 与空间会话 ${spatial.worldId} 不一致`, notStarted(plan));
      if (spatial.closing || spatial.paused || !spatial.observationAdmitted) return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能执行路线', notStarted(plan));
      // 规划起点是规划时的实测脚位；执行前只允许很小的物理漂移，超过就重新规划。
      const startDrift = distance3(plan.start, state.pos);
      if (startDrift > START_TOLERANCE) {
        return gateFailure(plan, 'route_start_changed', 'EFFECT_NOT_CONFIRMED', `路线起点 (${plan.start.x},${plan.start.y},${plan.start.z}) 与当前站位相差 ${startDrift.toFixed(2)} 格；重新 plan_route`, {
          start: plan.start,
          position: { ...state.pos },
          drift: startDrift,
          unsupported: { reason: 'route_start_changed' },
        });
      }
      // A9：历史几何首点必须就是规划时的实测起点；body.feet 也取 plan.start，不能拿当前漂移后的脚位硬套。
      if (plan.source === 'history') {
        const routeStart = plan.points[0];
        const routeDrift = routeStart === undefined ? Infinity : distance3(plan.start, routeStart);
        if (routeStart === undefined || routeDrift > START_TOLERANCE) {
          return gateFailure(plan, 'route_start_changed', 'EFFECT_NOT_CONFIRMED', `历史路线首点与规划起点相差 ${Number.isFinite(routeDrift) ? routeDrift.toFixed(2) : '未知'} 格（须 ≤${START_TOLERANCE}）；不从别的起点硬套`, {
            start: plan.start,
            ...(routeStart === undefined ? {} : { routeStart }),
            drift: routeDrift,
            unsupported: { reason: 'route_start_changed' },
          });
        }
      }
      const body = ctx.adapter.walkBody?.();
      const tick = ctx.adapter.walkTick?.();
      if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）', notStarted(plan));
      const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
      if (Date.now() >= deadline) return fail('TIMEOUT', 'walk_path 期限在开始前已耗尽', notStarted(plan));
      const map = spatial.session.voxel;
      const points = plan.points;
      const request: WalkRouteRequest = {
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk',
        body: { feet: { ...plan.start }, ...BODY },
        points: clonePoints(points),
        arrival: { kind: 'exact' },
        bodyArrival: GROUNDED_ARRIVAL_DEFAULTS,
        shapeProvider: walkCollisionProvider,
        deadlineMs: deadline,
        timeoutMs: Math.max(1, Math.min(4000, deadline - Date.now())),
      };
      const detachRef: { fn: (() => void) | null } = { fn: null };
      const statusRef: { read: (() => WalkRouteStatus | null) | null } = { read: null };
      try {
        const nav = await runWalkRoute({
          map, body, tick, request, signal: ctx.signal, deadlineMs: deadline,
          lifecycle: () => {
            const s = ctx.adapter.state();
            return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
          },
          observe: () => observeCells(ctx, map, bodyLocalCells(ctx.adapter.state().pos)),
          bindActive: (loop) => {
            statusRef.read = () => loop.status();
            const token = spatial.attach({
              receiver: (report) => loop.observe(report, 64),
              cancel: () => loop.cancel('lifecycle', 'shared spatial session interrupted the active walk_path'),
            });
            detachRef.fn = () => spatial.detach(token);
            return () => { detachRef.fn?.(); detachRef.fn = null; };
          },
          ...(plan.source === 'history' ? {
            starter: (loop, startRequest) => {
              const { points: _ignored, ...rest } = startRequest;
              return startKnownWalkRoute(spatial.session.history, loop, {
                ...rest,
                ...(plan.pathId === undefined ? {} : { pathId: plan.pathId }),
                // A4：执行器不得读到规划几何之外的历史点。
                maxRoutePoints: plan.points.length,
              });
            },
          } : {}),
        });
        const status = statusRef.read === null ? null : statusRef.read();
        if (ctx.signal.aborted && nav.outcome !== 'CANCELLED') {
          return { status: 'cancelled', summary: 'walk_path 被父任务取消', data: navData(plan, status, nav) };
        }
        return navToResult(plan, status, nav);
      } finally {
        detachRef.fn?.();
      }
    } finally {
      // 终态（含入口拒绝）之后才解除 pin；句柄保持已消费，不能再次执行。
      releaseRoutePlan(plan.routeId);
    }
  },
};
