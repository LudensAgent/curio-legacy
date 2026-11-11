import type { Vec3Like } from '../../adapter/types.ts';
import { shortId } from '../../util.ts';
import { fail, isAbort, ok, runSkill, validateSkill, type FailureCode, type SkillCtx, type SkillResult, type SkillStatus } from '../types.ts';
import { bearingOf, closeReasonOf, progressOf, summaryOf, waypointOf } from './intent.ts';
import { observeBoundary, type ObservationReceipt } from './observation.ts';
import { observedFootY, verifyLandRoute, type LandSearchBoundary } from '../../spatial/land-search.ts';
import { cellGoal, feetReached, goalFromIntent, stanceFor, type NavigationGoal } from './goal.ts';
import { isClimbableBlockName, walkLandRules } from '../../adapter/land-rules.ts';
import { runNavigationSegment, type SegmentReceipt } from './segment.ts';
import { findSwimTarget, waterAhead } from './swim-leg.ts';
import { swimPath } from './water.ts';
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
  const goal = goalFromIntent(intent.to, intent.targetKind, intent.arrival);
  const foot = goal.kind === 'cell'
    ? { x: goal.cell.x, y: Math.floor(goal.footY), z: goal.cell.z }
    : { x: Math.floor(goal.feet.x), y: Math.floor(goal.feet.y), z: Math.floor(goal.feet.z) };
  const state = ctx.adapter.state();
  const dim = state.dim;
  const now = Date.now();
  const climbable = (y: number): boolean => {
    const pos = { x: foot.x, y, z: foot.z };
    // Prefer the live loaded block: that is current contact, not memory.
    const live = ctx.adapter.blockAt(pos);
    if (live !== null) return isClimbableBlockName(live);
    const view = voxel.cellAt(dim, pos.x, y, pos.z);
    return view.observed
      && view.evidence.freshness === 'FRESH'
      && view.evidence.validUntil >= now
      && view.evidence.observation.sessionId === state.sessionId
      && view.evidence.observation.stateComplete
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
  /** 边走边规划时，这个窗口用于前瞻；真实移动仍受原分段总量、步数和期限约束。 */
  rolling?: boolean;
  checkSighting?: () => string | undefined;
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
  /**
   * 显式方向探索允许在本次 invocation 的分段上限处仍完成一次前沿观察。
   * 观察本身不是新段；若相关证据变化，本次调用以 BUDGET_EXHAUSTED 交回，
   * 由调用方续接同一 session 继续确认已观测的前缀。其他入口保持原有语义。
   */
  observeFrontierBeyondSegments?: boolean;
  /**
   * 委托显式允许下水：陆地路线接受涉水；身体在水中悬浮，或陆路在水边走不下去时，
   * 用 swim_path 游向已观察到的、沿委托有推进的岸边站立格（没有岸时游向前方水面点）。
   */
  swim?: boolean;
}

/** 一段由协调器代为执行的游泳：目标来自已观察体素，结果按实测记录。 */
export type SwimLegReceipt = {
  mode: 'dry_shore' | 'water_point'; target: Vec3Like; from: Vec3Like; to: Vec3Like;
  status: SkillStatus; summary: string; oxygenBefore: number; oxygenAfter: number;
};

/** 一次调用最多代为游泳的段数；每段仍受原期限约束。 */
const MAX_SWIM_LEGS = 8;

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
      swimLegs?: SwimLegReceipt[];
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
  const budgetExhausted = session.counters.confirmedTransitions >= session.budget.maxTransitions
    || session.counters.searches >= session.budget.maxSearches;
  const canContinue = reason !== undefined && canResume(reason) && !budgetExhausted && Date.now() <= session.expiresAt;
  return {
    canContinue,
    ...(canContinue ? { sessionId: session.id } : {}),
    requires: canContinue
      ? reason === 'BLOCKED' ? ['已记录受阻的出边；附近可见证据或站位变化后，同一目标可用原 sessionId 复核']
        : reason === 'UNKNOWN_BOUNDARY' ? ['观察相关边界或靠近后重新调用；原目标不变时用同一 sessionId']
          : reason === 'NO_PROGRESS' ? ['换一个意图或先改变地形/证据，再决定是否续接']
            : reason === 'RESIDENCY_NOT_READY' ? ['所需数据未加载/驻留；可稍后重试、先观察或换位置；同一 sessionId 续接，累计预算不会重置']
              : ['用同一 sessionId 续接；累计预算不会重置']
      : budgetExhausted && reason !== undefined && canResume(reason)
        ? ['累计 transition 或搜索预算已用尽；同一 session 不能增加预算，若仍要推进需明确新建移动委托']
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
  const swimLegs: SwimLegReceipt[] = [];
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
    const deviations = new Set<string>();
    let swimPending = false;
    // 委托推进量：方向委托按冻结轴线的前进，到点委托按到目标的水平距离缩短；横向授权仍是硬限制。
    const gainFrom = (from: Vec3Like) => (p: Vec3Like) => {
      if (session.intent.kind === 'advance') return progressOf(session, p, 0).along - progressOf(session, from, 0).along;
      const goal = session.intent.to;
      return Math.hypot(goal.x - from.x, goal.z - from.z) - Math.hypot(goal.x - p.x, goal.z - p.z);
    };
    const withinCorridor = (p: Vec3Like) => session.intent.kind !== 'advance' || Math.abs(progressOf(session, p, 0).lateral) <= session.intent.maxLateralDrift;
    while (executedSegments < request.maxSegments) {
      if (ctx.signal.aborted) {
        stop = stopOf('CANCELLED', '父任务取消；保留已确认的位移');
        break;
      }
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
      const seen = request.checkSighting?.();
      if (seen !== undefined) { stop = stopOf('UNTIL_SEEN', seen); break; }
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
      if (request.swim === true && (swimPending || state.inWater && !state.onGround)) {
        swimPending = false;
        if (swimLegs.length >= MAX_SWIM_LEGS) {
          stop = stopOf('BUDGET_EXHAUSTED', `本次调用已代为游泳 ${MAX_SWIM_LEGS} 段；已确认进展与 session 保留`);
          break;
        }
        const target = findSwimTarget(spatial.session.voxel, scope.dim, state.pos, gainFrom(state.pos), withinCorridor);
        if (target === null) {
          stop = stopOf('UNKNOWN_BOUNDARY', '在水中或水边，但沿委托方向没有已观察到的岸边站立格或水面点可游向；没有下水');
          break;
        }
        const validated = validateSkill(swimPath, {
          mode: target.mode, xyz: [target.pos.x, target.pos.y, target.pos.z],
          timeoutMs: Math.max(1000, Math.min(20000, deadline - Date.now())),
        }, ctx.adapter);
        if (!validated.ok) {
          stop = stopOf('ACTION_FAILURE', `游泳目标没有通过 swim_path 参数校验：${validated.error}`);
          break;
        }
        const swimResult = await runSkill({ ...ctx, deadline }, swimPath, validated.args);
        const end = ctx.adapter.state();
        swimLegs.push({ mode: target.mode, target: { ...target.pos }, from: { ...state.pos }, to: { ...end.pos },
          status: swimResult.status, summary: swimResult.summary, oxygenBefore: state.oxygen, oxygenAfter: end.oxygen });
        if (swimResult.status === 'cancelled') { stop = stopOf('CANCELLED', '游泳时父任务取消；实测位置保留'); break; }
        if (Math.hypot(end.pos.x - state.pos.x, end.pos.z - state.pos.z) < 1) {
          stop = stopOf('PHYSICAL_FAILURE', `游向 ${cellText(target.pos)} 没有推进：${swimResult.summary}`);
          break;
        }
        executedSegments += 1;
        session.progress.stagnationSegments = 0;
        session.progress.lastProgressAt = Date.now();
        continue;
      }
      const remainingCumulative = session.budget.maxTransitions - session.counters.confirmedTransitions;
      const perSegment = Math.max(1, Math.min(
        request.maxStepsPerSegment * (request.rolling ? request.maxSegments - executedSegments : 1),
        request.invocationMaxTransitions - invocationTransitions,
        remainingCumulative,
      ));
      // 路点脚高取该列已观测的站立面（下坡/上坡时不再沿用当前脚高）；没观测过才用当前脚高。
      const voxel = spatial.session.voxel;
      const goalAt = (pos: Vec3Like): NavigationGoal => {
        if (session.intent.kind === 'navigate') return goalFromIntent(session.intent.to, session.intent.targetKind, session.intent.arrival);
        const waypoint = waypointOf(session, pos, request.maxStepsPerSegment,
          (x, z, aroundY) => observedFootY(voxel, scope.dim, x, z, aroundY, 24, 8));
        const goal = cellGoal(waypoint, waypoint.y, waypoint);
        const bearing = session.bearing;
        if (bearing !== undefined && goal.kind === 'cell') {
          const stance = stanceFor(goal, pos);
          if ((stance.x - pos.x) * bearing.x + (stance.z - pos.z) * bearing.z <= 1e-9) {
            return cellGoal({ x: goal.cell.x + bearing.x, z: goal.cell.z + bearing.z }, waypoint.y, waypoint);
          }
        }
        return goal;
      };
      const chunksBefore = ctx.memory.visitedChunkCount;
      const segment = await runNavigationSegment(ctx, {
        goal: goalAt(state.pos),
        ...(request.rolling ? { nextWindow: goalAt } : {}),
        ...(request.checkSighting === undefined ? {} : { checkSighting: request.checkSighting }),
        ...(session.intent.kind === 'advance' ? { goalMetric: 'horizontal' as const, minimumAlong: session.intent.distance } : {}),
        allowed: session.intent.allowed,
        historical: session.intent.historical,
        ...(request.swim === true ? { wade: true } : {}),
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
        // 原地补证据不是一次身体执行；保留本次窗口，观察成功后仍能执行原委托。
        // 搜索、观察、无进展次数与 deadline 继续约束原地重试。
        if (progressed) executedSegments += 1;
        session.progress.stagnationSegments = progressed ? 0 : session.progress.stagnationSegments + 1;
      }
      if (progressed) session.progress.lastProgressAt = Date.now();
      ctx.progress(Math.min(1, executedSegments / request.maxSegments), `${session.intent.kind} ${executedSegments}/${request.maxSegments}`);
      // 陆路在水边走不下去：委托允许下水时，下一轮先游一段，再从实测位置继续陆路。
      if (request.swim === true && !['reached_waypoint', 'replan', 'sighting', 'cancelled', 'timeout'].includes(segment.outcome)
        && closeReasonOf(session, after.pos, Date.now(), after.onGround, false) === null
        && waterAhead(voxel, scope.dim, after.pos, gainFrom(after.pos))) {
        swimPending = true;
        continue;
      }

      if (segment.outcome === 'cancelled') {
        stop = stopOf('CANCELLED', segment.detail ?? '执行被取消；已确认段保留');
        break;
      }
      if (segment.stopCode === 'settlement_failed') {
        stop = stopOf(segment.failureCode === 'TIMEOUT' ? 'TIMEOUT' : 'PHYSICAL_FAILURE',
          segment.detail ?? '已松开运动键，但未确认身体停稳；保留实测位置');
        break;
      }
      if (segment.outcome === 'sighting') {
        stop = stopOf('UNTIL_SEEN', segment.detail ?? '当前视野已看见委托目标');
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
        // 执行偏差只在每个脚格重试一次；同一处再偏差说明身体做不到这段计划，如实停下。
        if (segment.stopCode === 'execution_deviation') {
          const cell = `${Math.floor(after.pos.x)},${Math.floor(after.pos.y)},${Math.floor(after.pos.z)}`;
          if (deviations.has(cell)) {
            stop = stopOf('PHYSICAL_FAILURE', `${segment.detail ?? '执行偏差'}；同一站位已重新规划过一次，仍未按计划落位`);
            break;
          }
          deviations.add(cell);
        }
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
        const canObserveSides = (session.intent.kind === 'advance' ? session.intent.maxLateralDrift > 0
          : session.intent.arrival !== undefined && segment.searchStatus === 'INSUFFICIENT_EVIDENCE')
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
              allowDrop: session.intent.allowed.includes('drop'),
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
        // 已移动的前缀会消耗分段窗口；显式探索例外：前沿观察不是新段，
        // 在分段上限处仍允许观察一次，然后由调用方用同一 session 续接确认。
        const boundary = segment.boundary;
        const frontierObservation = request.observeFrontierBeyondSegments === true;
        if (boundary === undefined && !frontierObservation) {
          stop = stopOf('UNKNOWN_BOUNDARY', segment.detail ?? '搜索边界证据不足；未进入 UNKNOWN/STALE', { boundaries: [] });
          break;
        }
        if (boundary !== undefined && executedSegments >= request.maxSegments && !frontierObservation) {
          stop = stopOf('UNKNOWN_BOUNDARY', segment.detail ?? '搜索边界证据不足；未进入 UNKNOWN/STALE', { boundaries: [boundary] });
          break;
        }
        // 感知在走前缀期间仍会更新地图。旧搜索边界已可通时，不能要求本次
        // observe 再产生一次变化；只复验当前脚边这条边，OPEN 才从实测位置重搜。
        const canProceed = () => {
          if (boundary === undefined || !feetReached(boundary.from, after.pos, after.onGround)) return false;
          const check = verifyLandRoute(voxel, {
            ...scope, body: { feet: { ...after.pos }, width: 0.6, height: 1.8, pose: 'standing' },
            rules: walkLandRules, measuredStart: after.pos,
          }, [{ kind: boundary.kind, from: boundary.from, to: boundary.to,
            drop: Math.max(0, boundary.from.y - boundary.to.y) }], Date.now());
          return check.transitions[0]?.status === 'OPEN';
        };
        if (canProceed()) {
          session.phase = 'replanning';
          continue;
        }
        const boundaryKey = boundary === undefined ? undefined : boundaryKeyOf(boundary, after.pos);
        const boundaryDone = boundaryKey !== undefined && session.observedBoundaries?.includes(boundaryKey) === true;
        // 当前列回退只属于显式探索：空地图可能连前沿边界都定位不到，
        // 此时对当前身体所在列做一次有界观察（脚/头/支撑），让下一次搜索有起点证据。
        // 普通 advance/navigate_to 保持原路径，不额外探测。
        let currentKey: string | undefined;
        let currentDone = false;
        let needCurrent = false;
        if (frontierObservation) {
          currentKey = `current@${Math.floor(after.pos.x)},${Math.floor(after.pos.y)},${Math.floor(after.pos.z)}`;
          currentDone = session.observedBoundaries?.includes(currentKey) === true;
          if (boundary === undefined) {
            needCurrent = true;
          } else {
            const supportCell = { x: Math.floor(after.pos.x), y: Math.floor(after.pos.y) - 1, z: Math.floor(after.pos.z) };
            const supportView = voxel.cellAt(scope.dim, supportCell.x, supportCell.y, supportCell.z);
            needCurrent = !(supportView.observed
              && supportView.evidence.freshness === 'FRESH'
              && supportView.evidence.validUntil >= Date.now()
              && supportView.evidence.observation.stateComplete);
          }
        }
        if ((boundary === undefined || boundaryDone) && (!needCurrent || currentDone)) {
          stop = stopOf('UNKNOWN_BOUNDARY', '同一 session 已在这个站位观察过相关证据；没有新的相关证据时不重复观察/搜索', {
            boundaries: boundary === undefined ? [] : [boundary],
          });
          break;
        }
        if (session.counters.observations >= session.budget.maxObservations || session.counters.newObservedCells >= session.budget.maxObservedCells) {
          stop = stopOf('BUDGET_EXHAUSTED', `观察预算已用尽（${session.counters.observations}/${session.budget.maxObservations} 次，${session.counters.newObservedCells}/${session.budget.maxObservedCells} 格）；边界仍未知`, { boundaries: boundary === undefined ? [] : [boundary] });
          break;
        }
        session.phase = 'observing';
        ctx.setStationaryWait?.(true);
        let currentReceipt: ObservationReceipt | undefined;
        let boundaryReceipt: ObservationReceipt | undefined;
        try {
          if (needCurrent && !currentDone
            && session.counters.observations < session.budget.maxObservations
            && session.counters.newObservedCells < session.budget.maxObservedCells) {
            currentReceipt = await observeBoundary(ctx, {
              boundary: {
                from: { ...after.pos }, to: { ...after.pos }, kind: 'walk', status: 'UNKNOWN',
                reason: '当前位置自身支撑/身体证据不足；只观察身体所在列', direction: 'HERE',
              },
              maxCells: session.budget.maxObservedCells - session.counters.newObservedCells,
              ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
            });
            session.counters.observations += 1;
            session.counters.newObservedCells += currentReceipt.newObservedCells;
            session.lastObservation = currentReceipt;
          }
          if (boundary !== undefined && !boundaryDone
            && session.counters.observations < session.budget.maxObservations
            && session.counters.newObservedCells < session.budget.maxObservedCells) {
            boundaryReceipt = await observeBoundary(ctx, {
              boundary,
              canProceed,
              allowDrop: session.intent.allowed.includes('drop'),
              maxCells: session.budget.maxObservedCells - session.counters.newObservedCells,
              ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
            });
            session.counters.observations += 1;
            session.counters.newObservedCells += boundaryReceipt.newObservedCells;
            session.lastObservation = boundaryReceipt;
          }
        } finally {
          ctx.setStationaryWait?.(false);
        }
        observation = boundaryReceipt ?? currentReceipt;
        if (observation === undefined) {
          stop = stopOf('BUDGET_EXHAUSTED', '观察预算不足以再执行一次前沿观察；边界仍未知', {
            boundaries: boundary === undefined ? [] : [boundary],
          });
          break;
        }
        if (currentReceipt !== undefined && boundaryReceipt !== undefined) {
          observation = {
            ...boundaryReceipt,
            cells: [...currentReceipt.cells, ...boundaryReceipt.cells],
            observed: currentReceipt.observed + boundaryReceipt.observed,
            attempted: currentReceipt.attempted || boundaryReceipt.attempted,
            newObservedCells: currentReceipt.newObservedCells + boundaryReceipt.newObservedCells,
            relatedCells: [...currentReceipt.relatedCells, ...boundaryReceipt.relatedCells],
            relatedChanged: currentReceipt.relatedChanged || boundaryReceipt.relatedChanged,
            turned: currentReceipt.turned || boundaryReceipt.turned,
          };
          session.lastObservation = observation;
        }
        // 相关证据有实际变化时，有限探测可能只补齐了一部分身体/扫掠格。
        // 剩余缺口仍可使用原观察预算；未取得新证据的站位才需要去重。
        if (boundaryReceipt !== undefined && !boundaryReceipt.relatedChanged) {
          session.observedBoundaries = [...(session.observedBoundaries ?? []), boundaryKey!];
        }
        if (currentReceipt !== undefined && !currentReceipt.relatedChanged && currentKey !== undefined) {
          session.observedBoundaries = [...(session.observedBoundaries ?? []), currentKey];
        }
        session.updatedAt = Date.now();
        // 段内已先走到证据前缀端点，观察就是在新站位朝边界做的；没有相关变化时从同一站位重搜不会有新结果。
        if (ctx.signal.aborted) { stop = stopOf('CANCELLED', '前沿观察时父任务取消'); break; }
        if (Date.now() >= deadline) { stop = stopOf('TIMEOUT', '前沿观察到达原期限'); break; }
        const boundarySighting = request.checkSighting?.();
        if (boundarySighting !== undefined) { stop = stopOf('UNTIL_SEEN', boundarySighting); break; }
        if (!observation.relatedChanged) {
          stop = stopOf('UNKNOWN_BOUNDARY', '在前缀端点观察后相关边界证据没有变化，不重复搜索同一未知边界', {
            boundaries: boundary === undefined ? [] : [boundary],
          });
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
    summary: renderSummary(session, finalStop, segments) + (swimLegs.length === 0 ? ''
      : `；代为游泳 ${swimLegs.length} 段（${swimLegs.map((leg) => `${leg.mode === 'dry_shore' ? '上岸' : '水面点'} ${cellText(leg.target)} ${leg.status}，氧气 ${leg.oxygenBefore}→${leg.oxygenAfter}`).join('；')}）`),
    session,
    segments,
    stop: finalStop,
    ...(observation === undefined ? {} : { observation }),
    ...(swimLegs.length === 0 ? {} : { swimLegs }),
  };
}

/** 供 skill 入口拼装回执；不参与执行。 */
export function coordinatorData(outcome: Extract<CoordinatorOutcome, { ok: true }>, extra: Record<string, unknown> = {}) {
  const session = outcome.session;
  const last = outcome.segments.at(-1);
  const replans = outcome.segments.filter((segment) => segment.outcome === 'replan');
  return {
    ...extra,
    ...(outcome.swimLegs === undefined ? {} : { swimLegs: outcome.swimLegs }),
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
    position: { ...session.measured.current },
    ...(last === undefined ? {} : {
      executed: session.counters.confirmedTransitions,
      confirmedSegments: session.counters.confirmedTransitions,
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
