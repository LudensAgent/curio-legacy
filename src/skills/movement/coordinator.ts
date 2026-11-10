import type { Vec3Like } from '../../adapter/types.ts';
import { shortId } from '../../util.ts';
import { fail, isAbort, ok, type FailureCode, type SkillCtx, type SkillResult, type SkillStatus } from '../types.ts';
import { bearingOf, closeReasonOf, progressOf, summaryOf, waypointOf } from './intent.ts';
import { observeBoundary, type ObservationReceipt } from './observation.ts';
import { observedFootY, type LandSearchBoundary } from '../../spatial/land-search.ts';
import { cellGoal, goalFromIntent, stanceFor, type NavigationGoal } from './goal.ts';
import { isClimbableBlockName } from '../../adapter/land-rules.ts';
import { runNavigationSegment, type SegmentReceipt } from './segment.ts';
import {
  acquireSessionLease, createMovementSession, findMovementSession, intentKeyOf, releaseSessionLease,
  type MovementBudget, type MovementIntent, type MovementSession, type MoveScope, type StopReceipt, type StopReason,
} from './session.ts';

/**
 * A ladder goal may legitimately finish with `onGround=false` while the body is
 * still held by the ladder. The exemption is derived from observed state at the
 * exact goal cell (or the source block below a ladder top), never from the fact
 * that the caller allowed a ladder transition somewhere on the route.
 */
function airborneLadderGoal(ctx: SkillCtx, intent: MovementIntent): boolean {
  if (intent.kind !== 'navigate') return false;
  const voxel = ctx.spatial?.session?.voxel;
  if (!voxel) return false;
  const goal = goalFromIntent(intent.to, intent.targetKind);
  const foot = goal.kind === 'cell'
    ? { x: goal.cell.x, y: Math.floor(goal.footY), z: goal.cell.z }
    : { x: Math.floor(goal.feet.x), y: Math.floor(goal.feet.y), z: Math.floor(goal.feet.z) };
  const dim = ctx.adapter.state().dim;
  const climbable = (y: number): boolean => {
    const view = voxel.cellAt(dim, foot.x, y, foot.z);
    return view.observed && view.evidence.observation.stateComplete
      && isClimbableBlockName(view.evidence.observation.state.name);
  };
  return climbable(foot.y) || climbable(foot.y - 1);
}

/**
 * 统一跨段协调内核：advance 与多段 navigate_to 共用。
 * 只负责有界的分段循环、停止判定和实测进展累计；不挖、不放、不搭、不换目标，
 * 也不从公开 navigate_to 再套一层协调循环。
 */

export interface CoordinatorRequest {
  intent: MovementIntent;
  /** 本次 invocation 最多执行几段（temporary；不是 session 预算）。 */
  maxSegments: number;
  maxStepsPerSegment: number;
  /** 新建 session 的累计 transition 预算；续接时沿用原 session 预算。 */
  maxTransitions: number;
  /** 本次 invocation 最多确认多少 transition，同时受剩余累计预算限制。 */
  invocationMaxTransitions: number;
  /** 新建 session 时的累计搜索预算；续接时沿用原 session 预算。 */
  maxSearches: number;
  maxObservations: number;
  maxObservedCells: number;
  maxNoProgressSegments: number;
  /** 单次搜索的节点/边预算；省略时用库默认值。 */
  searchLimits?: { maxNodes?: number; maxEdges?: number };
  sessionId?: string;
  deadlineMs?: number;
  allowUnknownCorridor: boolean;
}

export type CoordinatorOutcome =
  | { ok: false; failureCode: FailureCode; summary: string; data?: Record<string, unknown> }
  | {
      ok: true;
      status: SkillStatus;
      failureCode?: FailureCode;
      summary: string;
      session: MovementSession;
      segments: SegmentReceipt[];
      stop: StopReceipt;
      observation?: ObservationReceipt;
    };

const STOP_FAILURE: Record<StopReason, FailureCode> = {
  DISTANCE_MET: 'ERROR', REGION_ENTERED: 'ERROR', UNTIL_SEEN: 'ERROR', ARRIVED: 'ERROR',
  UNKNOWN_BOUNDARY: 'NOT_FOUND',
  BLOCKED: 'PATH_NOT_FOUND',
  TARGET_UNRESOLVED: 'PATH_NOT_FOUND',
  ROUTE_INVALIDATED: 'PATH_NOT_FOUND',
  NO_PATH: 'PATH_NOT_FOUND',
  RESIDENCY_NOT_READY: 'PATH_NOT_FOUND',
  PHYSICAL_FAILURE: 'EFFECT_NOT_CONFIRMED',
  ACTION_FAILURE: 'ERROR',
  MODE_GAP: 'PATH_NOT_FOUND',
  NO_PROGRESS: 'PATH_NOT_FOUND',
  LATERAL_DRIFT: 'PATH_NOT_FOUND',
  DETOUR_TOO_LARGE: 'PATH_NOT_FOUND',
  BUDGET_EXHAUSTED: 'TIMEOUT',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'TIMEOUT',
  SCOPE_CHANGED: 'WRONG_DIMENSION',
  INTENT_MISMATCH: 'BAD_ARGS',
  SUPERSEDED: 'BAD_ARGS',
};

const isSuccess = (reason: StopReason) => reason === 'DISTANCE_MET' || reason === 'REGION_ENTERED' || reason === 'UNTIL_SEEN' || reason === 'ARRIVED';
const canResume = (reason: StopReason) =>
  reason === 'BUDGET_EXHAUSTED' || reason === 'TIMEOUT' || reason === 'NO_PROGRESS' || reason === 'UNKNOWN_BOUNDARY'
  || reason === 'BLOCKED' || reason === 'NO_PATH' || reason === 'RESIDENCY_NOT_READY'
  || reason === 'PHYSICAL_FAILURE' || reason === 'TARGET_UNRESOLVED' || reason === 'ROUTE_INVALIDATED';

/** 终止后仍允许同一 session 续接的原因；其余终态必须新建意图。 */
const RESUMABLE_REASONS: ReadonlySet<StopReason> = new Set([
  'BUDGET_EXHAUSTED', 'TIMEOUT', 'NO_PROGRESS', 'UNKNOWN_BOUNDARY',
  'BLOCKED', 'NO_PATH', 'RESIDENCY_NOT_READY', 'PHYSICAL_FAILURE', 'TARGET_UNRESOLVED', 'ROUTE_INVALIDATED',
]);

const round2 = (n: number) => Math.round(n * 100) / 100;
const cellText = (p: Vec3Like) => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;

function stateFacts(session: MovementSession) {
  return {
    sessionId: session.id,
    phase: session.phase,
    intent: session.intent,
    frozenOrigin: { ...session.frozenOrigin },
    ...(session.bearing === undefined ? {} : { bearing: { ...session.bearing } }),
    scope: { ...session.scope },
    budget: { ...session.budget },
    counters: { ...session.counters },
    progress: { ...session.progress },
    measured: { ...session.measured },
    ...(session.lastSegment === undefined ? {} : { lastSegment: session.lastSegment }),
    ...(session.lastSearch === undefined ? {} : { lastSearch: session.lastSearch }),
    ...(session.lastObservation === undefined ? {} : { lastObservation: session.lastObservation }),
    ...(session.stop === undefined ? {} : { stop: session.stop }),
  };
}

function continuationOf(session: MovementSession) {
  const reason = session.stop?.reason;
  const canContinue = reason !== undefined && canResume(reason) && Date.now() <= session.expiresAt;
  return {
    canContinue,
    ...(canContinue ? { sessionId: session.id } : {}),
    requires: canContinue
      ? reason === 'BLOCKED' ? ['清障/改变意图后重新调用；原目标不变时用同一 sessionId']
        : reason === 'UNKNOWN_BOUNDARY' ? ['观察相关边界或靠近后重新调用；原目标不变时用同一 sessionId']
          : reason === 'NO_PROGRESS' ? ['换一个意图或先改变地形/证据，再决定是否续接']
            : reason === 'RESIDENCY_NOT_READY' ? ['所需数据未加载/驻留；可稍后重试、先观察或换位置；同一 sessionId 续接，累计预算不会重置']
              : ['用同一 sessionId 续接；累计预算不会重置']
      : [],
    expiresAt: session.expiresAt,
  };
}

function stopOf(reason: StopReason, detail: string, extra: Partial<StopReceipt> = {}): StopReceipt {
  return { reason, at: Date.now(), detail, ...extra };
}

/** advance 的横向授权走廊；navigate 意图没有。 */
function corridorOf(session: MovementSession) {
  return session.intent.kind === 'advance' && session.bearing !== undefined
    ? { origin: session.frozenOrigin, bearing: session.bearing, maxLateral: session.intent.maxLateralDrift }
    : undefined;
}

function boundaryDirectionOf(from: Vec3Like, to: Vec3Like): LandSearchBoundary['direction'] {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > 1e-9) return dx > 0 ? 'E' : 'W';
  if (Math.abs(dz) > 1e-9) return dz > 0 ? 'S' : 'N';
  return to.y > from.y ? 'UP' : to.y < from.y ? 'DOWN' : 'HERE';
}

/** 执行级 blocker（move_step 的 TARGET_BLOCKED/HEAD_BLOCKED）也转成边界事实，供侧向观察。 */
function blockerBoundaryOf(segment: SegmentReceipt): LandSearchBoundary | undefined {
  if (segment.blockerAhead !== undefined) return segment.blockerAhead;
  const blocker = segment.blocker;
  if (blocker === undefined) return undefined;
  return {
    from: { ...blocker.transition.from },
    to: { ...blocker.transition.to },
    kind: blocker.transition.kind,
    status: 'BLOCKED',
    reason: blocker.reason ?? '执行层报告已观测阻挡',
    direction: boundaryDirectionOf(blocker.transition.from, blocker.transition.to),
  };
}

/** 边界去重键含观察者所在格：换了站位就是新的视角，允许再观察同一边界。 */
function boundaryKeyOf(boundary: LandSearchBoundary, observer: Vec3Like): string {
  return `${boundary.from.x},${boundary.from.y},${boundary.from.z}|${boundary.to.x},${boundary.to.y},${boundary.to.z}|${boundary.status}`
    + `@${Math.floor(observer.x)},${Math.floor(observer.y)},${Math.floor(observer.z)}`;
}

function renderSummary(session: MovementSession, stop: StopReceipt, segments: readonly SegmentReceipt[]): string {
  const measured = session.measured.current;
  const intent = summaryOf(session.intent);
  const confirmed = session.counters.confirmedTransitions;
  const progress = session.intent.kind === 'advance'
    ? `实测沿 ${session.intent.direction} ${session.progress.along} 格、横向 ${session.progress.lateral} 格、水平净位移 ${session.progress.horizontalNet} 格`
    : `实测终点 ${cellText(measured)}，距原目标水平 ${round2(Math.hypot(measured.x - session.intent.to.x, measured.z - session.intent.to.z))} 格`;
  const path = `已确认 ${confirmed} 段 transition（路径长度 ${round2(session.counters.confirmedRouteLength)} 格）`;
  const observation = session.lastObservation as ObservationReceipt | undefined;
  const observationNote = observation === undefined
    ? ''
    : observation.relatedChanged
      ? `；相关边界观察生效（${observation.relatedCells.length} 个相关格变化，${observation.newObservedCells} 个新增观测格）`
      : `；观察了边界但相关证据没有变化（新增 ${observation.newObservedCells} 个无关观测格不足以重搜）`;
  const boundaryNote = stop.reason === 'UNKNOWN_BOUNDARY'
    ? `；边界 ${stop.boundaries === undefined ? '证据不足' : JSON.stringify(stop.boundaries).slice(0, 160)}`
    : '';
  const modeNote = stop.modeGap === undefined ? '' : `；能力缺口 ${JSON.stringify(stop.modeGap)}`;
  return `${intent}：${stop.detail}；${progress}；${path}${observationNote}${boundaryNote}${modeNote}`;
}

/**
 * 一次有界执行。返回的 session 是同一个可变对象；Activity 只能读它的快照。
 */
export async function runMovementCoordinator(ctx: SkillCtx, request: CoordinatorRequest): Promise<CoordinatorOutcome> {
  const spatial = ctx.spatial;
  if (!spatial?.session?.voxel) return { ok: false, failureCode: 'NOT_CONNECTED', summary: '需要共享空间 VoxelMap；当前没有接线' };
  const initial = ctx.adapter.state();
  if (!initial.alive || !initial.connected || !initial.observationReady) {
    return { ok: false, failureCode: 'NOT_CONNECTED', summary: '需要有效的存活观测' };
  }
  if (initial.worldId !== spatial.worldId) {
    return { ok: false, failureCode: 'WRONG_DIMENSION', summary: '当前世界与空间会话不一致' };
  }
  const scope: MoveScope = { worldId: initial.worldId, dim: initial.dim, sessionId: initial.sessionId };
  const deadline = Math.min(request.deadlineMs ?? ctx.deadline, ctx.deadline);
  if (Date.now() >= deadline) return { ok: false, failureCode: 'TIMEOUT', summary: '移动期限在开始前已耗尽' };

  const now = Date.now();
  const invocationId = shortId('mi_');
  let session: MovementSession;

  if (request.sessionId !== undefined) {
    const resumed = findMovementSession(request.sessionId, now);
    if (resumed === undefined) {
      return { ok: false, failureCode: 'BAD_ARGS', summary: `sessionId ${request.sessionId} 不存在或已过期；原意图请重新提交`, data: { reason: 'INTENT_MISMATCH', sessionId: request.sessionId } };
    }
    session = resumed;
    if (session.scope.worldId !== scope.worldId || session.scope.dim !== scope.dim || session.scope.sessionId !== scope.sessionId) {
      session.phase = 'stopped';
      session.stop = stopOf('SCOPE_CHANGED', `session 作用域 ${JSON.stringify(session.scope)} 与当前 ${JSON.stringify(scope)} 不一致`);
      return { ok: false, failureCode: 'WRONG_DIMENSION', summary: session.stop.detail + '；旧 session 不再可用，必须重新创建意图', data: stateFacts(session) };
    }
    if (session.intentKey !== intentKeyOf(request.intent)) {
      return { ok: false, failureCode: 'BAD_ARGS', summary: 'sessionId 与原意图不匹配（目标/方向/距离/允许模式任一变化都是新意图）；请不带 sessionId 新建意图', data: { reason: 'INTENT_MISMATCH', sessionId: session.id } };
    }
    if (session.stop?.reason === 'SUPERSEDED') {
      return { ok: false, failureCode: 'BAD_ARGS', summary: '该 session 已被更新的移动意图取代，不能继续执行', data: { reason: 'INTENT_MISMATCH', sessionId: session.id } };
    }
    if (session.phase === 'stopped' && session.stop !== undefined && !RESUMABLE_REASONS.has(session.stop.reason)) {
      return {
        ok: false, failureCode: STOP_FAILURE[session.stop.reason],
        summary: `该 session 已终止（${session.stop.reason}：${session.stop.detail}）；不能续接，请新建意图`,
        data: { ...stateFacts(session), reason: 'INTENT_MISMATCH' },
      };
    }
  } else {
    session = createMovementSession({
      intent: request.intent,
      origin: { ...initial.pos },
      ...(request.intent.kind === 'advance' ? { bearing: bearingOf(request.intent.direction) } : {}),
      scope,
      budget: budgetOf(request),
      now,
    });
  }

  if (!acquireSessionLease(session, invocationId, now)) {
    return { ok: false, failureCode: 'ERROR', summary: `session ${session.id} 正被另一次执行持有；同一身体同一时间只能有一个移动控制者`, data: { reason: 'BUSY', sessionId: session.id } };
  }

  const segments: SegmentReceipt[] = [];
  let observation: ObservationReceipt | undefined;
  let invocationTransitions = 0;
  let stop: StopReceipt | null = null;

  try {
    // 续接是同一冻结意图的新一次尝试：预算与冻结事实保留，但停止快照与
    // consecutive 停滞计数属于上一次 invocation，不能直接复用。
    if (session.phase === 'stopped') {
      session.stop = undefined;
      session.progress.stagnationSegments = 0;
      session.progress.lastProgressAt = Date.now();
    }
    // 已完成的 session 不再移动；如实返回原终态，不把“保留”当“继续”。
    if (session.phase === 'completed' || isSuccess(session.stop?.reason ?? 'BUDGET_EXHAUSTED')) {
      const prior = session.stop ?? stopOf((session.intent.kind === 'advance' ? 'DISTANCE_MET' : 'ARRIVED'), '该 session 已经完成冻结意图');
      return {
        ok: true, status: 'succeeded', summary: `session ${session.id} 已完成：${prior.detail}；没有再次移动`, session, segments, stop: prior,
      };
    }
    if (session.phase === 'cancelled') {
      const prior = session.stop ?? stopOf('CANCELLED', '该 session 已被取消');
      return { ok: true, status: 'cancelled', summary: `session ${session.id} 已取消：${prior.detail}；没有再次移动`, session, segments, stop: prior };
    }

    session.phase = 'executing';
    let executedSegments = 0;
    while (executedSegments < request.maxSegments) {
      const state = ctx.adapter.state();
      if (state.worldId !== session.scope.worldId || state.dim !== session.scope.dim || state.sessionId !== session.scope.sessionId) {
        stop = stopOf('SCOPE_CHANGED', `world/dimension/adapter session 已变化（${JSON.stringify(scope)} → ${state.worldId}/${state.dim}/${state.sessionId}）；旧 session 不跨 scope 续接`);
        break;
      }
      if (!state.alive || !state.connected || !state.observationReady) {
        stop = stopOf('ACTION_FAILURE', '身体或观测不再有效，停止移动');
        break;
      }
      if (Date.now() >= deadline) {
        stop = stopOf('TIMEOUT', '当前 invocation 的 deadline 到期；身体动作已停止，实测事实保留');
        break;
      }
      session.measured = {
        start: { ...session.frozenOrigin }, current: { ...state.pos }, sampledAt: Date.now(),
        onGround: state.onGround, inWater: state.inWater,
      };
      session.progress = progressOf(session, state.pos, Date.now());
      const close = closeReasonOf(
        session, state.pos, Date.now(), state.onGround,
        airborneLadderGoal(ctx, session.intent),
      );
      if (close !== null) {
        stop = stopOf(close.reason, close.detail);
        break;
      }
      if (session.counters.confirmedTransitions >= session.budget.maxTransitions) {
        stop = stopOf('BUDGET_EXHAUSTED', `累计 transition 预算 ${session.budget.maxTransitions} 已用尽；已确认段与 session 保留`);
        break;
      }
      if (session.counters.searches >= session.budget.maxSearches) {
        stop = stopOf('BUDGET_EXHAUSTED', `累计搜索预算 ${session.budget.maxSearches} 已用尽；已确认段与 session 保留`);
        break;
      }
      if (invocationTransitions >= request.invocationMaxTransitions) {
        stop = stopOf('BUDGET_EXHAUSTED', `本次调用 transition 上限 ${request.invocationMaxTransitions} 已用尽；累计进展保留`);
        break;
      }
      const remainingCumulative = session.budget.maxTransitions - session.counters.confirmedTransitions;
      const perSegment = Math.max(1, Math.min(
        request.maxStepsPerSegment,
        request.invocationMaxTransitions - invocationTransitions,
        remainingCumulative,
      ));
      // 路点脚高取该列已观测的站立面（下坡/上坡时不再沿用当前脚高）；没观测过才用当前脚高。
      const voxel = spatial.session.voxel;
      const waypoint = waypointOf(session, state.pos, request.maxStepsPerSegment,
        (x, z, aroundY) => observedFootY(voxel, scope.dim, x, z, aroundY, 24, 8));
      // advance 的路点是候选格列（x/z 可能是半格），navigate 使用冻结的 targetKind。
      let goal: NavigationGoal = session.intent.kind === 'advance'
        ? cellGoal({ x: waypoint.x, z: waypoint.z }, waypoint.y, waypoint)
        : goalFromIntent(session.intent.to, session.intent.targetKind);
      // 格目标的格内偏移取实测起点，可能让中继路点落在当前站位同一投影上（例如漂移后
      // 分数偏移变化）；此时把中继格沿冻结方向推进一格，保证推进请求仍能前进。
      const bearing = session.bearing;
      if (session.intent.kind === 'advance' && bearing !== undefined) {
        const along = (point: Vec3Like) =>
          (point.x - session.frozenOrigin.x) * bearing.x
          + (point.z - session.frozenOrigin.z) * bearing.z;
        if (goal.kind === 'cell' && along(stanceFor(goal, state.pos)) <= along(state.pos) + 1e-9) {
          goal = cellGoal(
            { x: goal.cell.x + Math.round(bearing.x), z: goal.cell.z + Math.round(bearing.z) },
            goal.footY,
            waypoint,
          );
        }
      }
      const chunksBefore = ctx.memory.visitedChunkCount;
      const segment = await runNavigationSegment(ctx, {
        goal,
        allowed: session.intent.allowed,
        historical: session.intent.historical,
        ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
        maxTransitions: perSegment,
        allowUnknownCorridor: request.allowUnknownCorridor,
        deadline,
        searchBudget: Math.max(0, session.budget.maxSearches - session.counters.searches),
        ...(request.searchLimits === undefined ? {} : { searchLimits: request.searchLimits }),
        onPhase: (phase) => ctx.setStationaryWait?.(phase === 'searching'),
      });
      ctx.setStationaryWait?.(false);
      session.counters.newChunks += Math.max(0, ctx.memory.visitedChunkCount - chunksBefore);
      const isReplan = segment.outcome === 'replan';
      segments.push(segment);
      session.lastSegment = segment;
      session.lastSearch = segment.search;
      session.counters.searches += segment.searches;
      if (!isReplan) {
        session.counters.segments += 1;
        executedSegments += 1;
      }
      session.counters.confirmedTransitions += segment.confirmed.length;
      invocationTransitions += segment.confirmed.length;
      session.counters.confirmedRouteLength += segment.pathLength;
      session.updatedAt = Date.now();

      const after = ctx.adapter.state();
      session.measured = {
        start: { ...session.frozenOrigin }, current: { ...after.pos }, sampledAt: Date.now(),
        onGround: after.onGround, inWater: after.inWater,
      };
      session.progress = progressOf(session, after.pos, Date.now());
      // 部分位移也是真实进展：动作失败/未确认但身体确实移动了，不能当成 NO_PROGRESS；
      // 下一段始终从实测位置重新规划，不重放旧起点动作。
      const measuredMove = Math.hypot(after.pos.x - segment.measuredStart.x, after.pos.z - segment.measuredStart.z)
        + Math.abs(after.pos.y - segment.measuredStart.y);
      const progressed = segment.confirmed.length > 0 || measuredMove > 0.05;
      if (!isReplan) {
        session.progress.stagnationSegments = progressed ? 0 : session.progress.stagnationSegments + 1;
      }
      if (progressed) session.progress.lastProgressAt = Date.now();
      ctx.progress(Math.min(1, executedSegments / request.maxSegments), `${session.intent.kind} ${executedSegments}/${request.maxSegments}`);

      if (segment.outcome === 'cancelled') {
        stop = stopOf('CANCELLED', segment.detail ?? '执行被取消；已确认段保留');
        break;
      }
      // 段内的实测位置已经达到冻结意图时，先按实测收工；剩余边界只说明“再往后未知”，
      // 不能推翻已经真实完成的沿方向/到达条件。横向超授权仍由 closeReasonOf 先拦。
      const closeAfterSegment = closeReasonOf(
        session, after.pos, Date.now(), after.onGround,
        airborneLadderGoal(ctx, session.intent),
      );
      if (closeAfterSegment !== null) {
        stop = stopOf(closeAfterSegment.reason, closeAfterSegment.detail);
        break;
      }
      if (segment.outcome === 'replan') {
        // 不把实测起点覆盖成计划点；保留冻结目标，从实测位置重新搜索。
        // 搜索次数与 deadline 由 session/本次调用预算继续约束，不重置、不延长。
        if (session.counters.searches >= session.budget.maxSearches) {
          stop = stopOf('BUDGET_EXHAUSTED', `起点与计划不一致，累计搜索预算 ${session.budget.maxSearches} 已用尽；原目标与实测进展保留`);
          break;
        }
        if (Date.now() >= deadline) {
          stop = stopOf('TIMEOUT', '起点与计划不一致，当前 invocation 的 deadline 已到期；原目标与实测进展保留');
          break;
        }
        session.phase = 'replanning';
        continue;
      }
      if (segment.outcome === 'timeout') {
        stop = stopOf('TIMEOUT', segment.detail ?? '执行期限耗尽');
        break;
      }
      if (segment.outcome === 'search_budget') {
        stop = stopOf('BUDGET_EXHAUSTED', segment.detail ?? '搜索预算耗尽');
        break;
      }
      if (segment.outcome === 'residency_not_ready') {
        // 所需页面没有加载/驻留，不是“已观测阻挡”或“已存几何无路”；
        // 原样保留 unavailableSections，后续由 Agent 决定重试/换目标/先观察。
        stop = stopOf('RESIDENCY_NOT_READY', segment.detail ?? '导航所需的 Section 未能加载/驻留；没有执行未复验的动作');
        break;
      }
      if (segment.outcome === 'disallowed') {
        stop = stopOf('MODE_GAP', `${segment.detail ?? '需要的移动模式不在 allowed'}；不自动切换模式`, {
          modeGap: { required: segment.disallowed?.kind ?? 'unknown', allowed: session.intent.allowed },
        });
        break;
      }
      if (segment.outcome === 'corridor_exhausted') {
        stop = stopOf('DETOUR_TOO_LARGE', segment.detail ?? '授权横向走廊内没有可走路线；外侧绕行未授权');
        break;
      }
      if (segment.outcome === 'no_path') {
        // NO_PATH_IN_MEMORY 不是“已观测阻挡”，也不升级成 BLOCKED；路线事实原样交回。
        stop = stopOf('NO_PATH', segment.detail ?? '已存几何里没有 walk/step/drop 路线', {
          boundaries: segment.search.boundaries,
        });
        break;
      }
      if (segment.outcome === 'invalidated') {
        stop = stopOf('ROUTE_INVALIDATED', segment.detail ?? '搜索期间地图证据/驻留发生变化；候选已作废');
        break;
      }
      if (segment.outcome === 'lateral_authorization') {
        stop = stopOf('LATERAL_DRIFT', segment.detail ?? 'transition 超出横向授权；没有执行');
        break;
      }
      if (segment.outcome === 'blocked') {
        // 横向授权 >0 时，先观察阻挡两侧的必要空间；相关证据变化才允许重搜，
        // 不把“正前方有阻挡”直接当成整条走廊无路。观察预算与去重沿用同一 session。
        const blockedBoundary = blockerBoundaryOf(segment);
        const boundaryKey = blockedBoundary === undefined ? undefined : boundaryKeyOf(blockedBoundary, after.pos);
        const canObserveSides = session.intent.kind === 'advance' && session.intent.maxLateralDrift > 0
          && blockedBoundary !== undefined && boundaryKey !== undefined
          && session.counters.observations < session.budget.maxObservations
          && session.counters.newObservedCells < session.budget.maxObservedCells
          && session.observedBoundaries?.includes(boundaryKey) !== true;
        if (canObserveSides) {
          session.phase = 'observing';
          ctx.setStationaryWait?.(true);
          try {
            observation = await observeBoundary(ctx, {
              boundary: blockedBoundary!,
              maxCells: session.budget.maxObservedCells - session.counters.newObservedCells,
              ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
            });
          } finally {
            ctx.setStationaryWait?.(false);
          }
          session.counters.observations += 1;
          session.counters.newObservedCells += observation.newObservedCells;
          session.lastObservation = observation;
          session.observedBoundaries = [...(session.observedBoundaries ?? []), boundaryKey!];
          session.updatedAt = Date.now();
          if (observation.relatedChanged) {
            session.phase = 'replanning';
            continue;
          }
        }
        stop = stopOf('BLOCKED', segment.detail ?? '已观测到物理阻挡；未自动挖/放', {
          ...(segment.blocker === undefined ? {} : { blocker: segment.blocker }),
          ...(segment.blockerAhead === undefined ? {} : { boundaries: [segment.blockerAhead] }),
        });
        break;
      }
      if (segment.outcome === 'physical_failure') {
        stop = stopOf('PHYSICAL_FAILURE', segment.detail ?? '身体执行与预期不符；保留最后实测位置');
        break;
      }
      if (segment.outcome === 'unsupported') {
        const modeGap = segment.problemKind === 'UNSUPPORTED_ENVIRONMENT';
        stop = modeGap
          ? stopOf('MODE_GAP', `${segment.detail ?? '需要当前不支持的移动模式'}；不自动切换游泳/船/攀爬模式`, { modeGap: { problem: segment.problemKind } })
          : stopOf('TARGET_UNRESOLVED', segment.detail ?? 'waypoint/脚高无法解析');
        break;
      }
      if (segment.outcome === 'unknown_boundary') {
        // 观察/重搜也要消耗剩余段数；没有下一段预算时如实停在边界。
        const boundary = segment.boundary;
        if (boundary === undefined || executedSegments >= request.maxSegments) {
          stop = stopOf('UNKNOWN_BOUNDARY', segment.detail ?? '搜索边界证据不足；未进入 UNKNOWN/STALE', {
            boundaries: boundary === undefined ? [] : [boundary],
          });
          break;
        }
        const boundaryKey = boundaryKeyOf(boundary, after.pos);
        if (session.observedBoundaries?.includes(boundaryKey) === true) {
          stop = stopOf('UNKNOWN_BOUNDARY', '同一 session 已在这个站位观察过这个边界；没有新的相关证据时不重复观察/搜索', { boundaries: [boundary] });
          break;
        }
        if (session.counters.observations >= session.budget.maxObservations || session.counters.newObservedCells >= session.budget.maxObservedCells) {
          stop = stopOf('BUDGET_EXHAUSTED', `观察预算已用尽（${session.counters.observations}/${session.budget.maxObservations} 次，${session.counters.newObservedCells}/${session.budget.maxObservedCells} 格）；边界仍未知`, { boundaries: [boundary] });
          break;
        }
        session.phase = 'observing';
        ctx.setStationaryWait?.(true);
        try {
          observation = await observeBoundary(ctx, {
            boundary,
            maxCells: session.budget.maxObservedCells - session.counters.newObservedCells,
            ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
          });
        } finally {
          ctx.setStationaryWait?.(false);
        }
        session.counters.observations += 1;
        session.counters.newObservedCells += observation.newObservedCells;
        session.lastObservation = observation;
        session.observedBoundaries = [...(session.observedBoundaries ?? []), boundaryKey];
        session.updatedAt = Date.now();
        // 段内已先走到证据前缀端点，观察就是在新站位朝边界做的；没有相关变化时从同一站位重搜不会有新结果。
        if (!observation.relatedChanged) {
          stop = stopOf('UNKNOWN_BOUNDARY', '在前缀端点观察后相关边界证据没有变化，不重复搜索同一未知边界', { boundaries: [boundary] });
          break;
        }
        session.phase = 'replanning';
        continue;
      }
      if (session.progress.stagnationSegments >= Math.min(request.maxNoProgressSegments, session.budget.maxNoProgressSegments)) {
        stop = stopOf('NO_PROGRESS', `连续 ${session.progress.stagnationSegments} 段没有确认位移或相关新证据；不自动脱困/改方向`);
        break;
      }
    }

    if (stop === null) {
      stop = stopOf('BUDGET_EXHAUSTED', `本次调用分段上限 ${request.maxSegments} 已用尽；冻结意图未完成，已确认进展与 session 保留`);
    }
  } catch (error) {
    stop = isAbort(error)
      ? stopOf('CANCELLED', '父任务取消；身体动作已停止，已确认段与实测位置保留')
      : stopOf('ACTION_FAILURE', `执行异常：${error instanceof Error ? error.message : String(error)}；保留最后实测位置`);
  } finally {
    if (stop !== null) {
      session.stop = stop;
      session.phase = stop.reason === 'CANCELLED' ? 'cancelled' : isSuccess(stop.reason) ? 'completed' : 'stopped';
      session.updatedAt = Date.now();
      session.measured = {
        start: { ...session.frozenOrigin },
        current: { ...ctx.adapter.state().pos },
        sampledAt: Date.now(),
        onGround: ctx.adapter.state().onGround,
        inWater: ctx.adapter.state().inWater,
      };
      session.progress = progressOf(session, session.measured.current, Date.now());
    }
    ctx.setStationaryWait?.(false);
    releaseSessionLease(session, invocationId);
  }

  const finalStop = stop ?? stopOf('ACTION_FAILURE', '协调循环没有产生终止事实');
  const status: SkillStatus = finalStop.reason === 'CANCELLED' ? 'cancelled'
    : isSuccess(finalStop.reason) ? 'succeeded' : 'failed';
  return {
    ok: true,
    status,
    ...(status === 'failed' ? { failureCode: STOP_FAILURE[finalStop.reason] } : {}),
    summary: renderSummary(session, finalStop, segments),
    session,
    segments,
    stop: finalStop,
    ...(observation === undefined ? {} : { observation }),
  };
}

/** 供 skill 入口拼装回执；不参与执行。 */
export function coordinatorData(outcome: Extract<CoordinatorOutcome, { ok: true }>, extra: Record<string, unknown> = {}) {
  const session = outcome.session;
  const last = outcome.segments.at(-1);
  const replans = outcome.segments.filter((segment) => segment.outcome === 'replan');
  return {
    ...extra,
    ...(replans.length === 0 ? {} : {
      replanCount: replans.length,
      replans: replans.map((segment) => ({
        reason: segment.detail ?? 'start_drift',
        plannedStart: segment.transition === undefined ? null : { ...segment.transition.from },
        measuredStart: { ...segment.measuredStart },
        measuredEnd: { ...segment.measuredEnd },
      })),
    }),
    ...stateFacts(session),
    continuation: continuationOf(session),
    ...(last === undefined ? {} : {
      executed: session.counters.confirmedTransitions,
      confirmedSegments: session.counters.confirmedTransitions,
      position: { ...session.measured.current },
      evidenceMode: last.evidenceMode,
      searchStatus: last.searchStatus,
      searchReason: last.searchReason,
      ...(last.budget === undefined ? {} : { budget: last.budget }),
      ...(last.unavailableSections === undefined ? {} : { unavailableSections: last.unavailableSections }),
      assurance: last.chosen?.assurance ?? last.search.assurance,
      points: last.chosen?.points ?? last.search.points,
      transitions: last.planned,
      boundaries: last.search.boundaries,
      boundarySummary: last.boundarySummary,
      resolvedTarget: last.chosen?.resolvedTarget ?? last.search.resolvedTarget,
      prefix: last.search.prefix,
      ...(last.chosen?.verification === undefined ? {} : { verification: last.chosen.verification }),
      plannedTransitions: last.planned.length,
      ...(last.partialDisplacement === undefined ? {} : { partialDisplacement: last.partialDisplacement }),
      ...(last.currentCheck === undefined ? {} : { currentCheck: last.currentCheck }),
      policy: last.chosen?.policy ?? last.search.policy ?? null,
      measuredDisplacement: {
        horizontal: Math.hypot(last.measuredEnd.x - last.measuredStart.x, last.measuredEnd.z - last.measuredStart.z),
        vertical: Math.abs(last.measuredEnd.y - last.measuredStart.y),
      },
      backend: last.directDrop ? 'direct-drop' : last.planned.length > 0 ? 'land-search' : 'none',
      arrived: outcome.status === 'succeeded' && (outcome.stop.reason === 'ARRIVED' || outcome.stop.reason === 'DISTANCE_MET'),
    }),
    stop: outcome.stop,
  };
}

export function coordinatorResult(outcome: CoordinatorOutcome, extra: Record<string, unknown> = {}): SkillResult {
  if (!outcome.ok) return fail(outcome.failureCode, outcome.summary, outcome.data);
  const data = coordinatorData(outcome, extra);
  return outcome.status === 'cancelled'
    ? { status: 'cancelled', summary: outcome.summary, data }
    : outcome.status === 'succeeded'
      ? ok(outcome.summary, data)
      : fail(outcome.failureCode ?? 'ERROR', outcome.summary, data);
}

function budgetOf(request: CoordinatorRequest): MovementBudget {
  return {
    maxTransitions: Math.max(1, request.maxTransitions),
    maxSearches: Math.max(1, request.maxSearches),
    maxObservations: Math.max(0, request.maxObservations),
    maxObservedCells: Math.max(0, request.maxObservedCells),
    maxNoProgressSegments: Math.max(1, request.maxNoProgressSegments),
    maxLateralDrift: request.intent.kind === 'advance' ? request.intent.maxLateralDrift : 0,
  };
}
