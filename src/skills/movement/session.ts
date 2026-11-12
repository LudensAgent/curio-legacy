import type { Vec3Like } from '../../adapter/types.ts';
import { shortId } from '../../util.ts';
import type { NavigationArrival, NavigationTargetKind } from './goal.ts';
import type { MakeWayOptions } from './make-way.ts';

/**
 * 短期移动委托状态：只保存“一个尚未完成的移动意图”的控制事实。
 * 已确认的观测/通行/世界修改仍由 VoxelMap 与共享空间记忆管理，Activity 只读快照。
 *
 * 这里刻意不保存 deadline：单次 invocation 的 deadline 由 ctx.deadline 决定，
 * session.expiresAt 只控制“还能不能续接”，累计预算跨调用保留、不因续接重置。
 */

export type MoveMode = 'walk' | 'step' | 'drop' | 'jump' | 'ladder';
/**
 * Default modes for advance. `navigate_to` has its own KINDS list so jump and
 * ladder body control remain explicitly opt-in; advance keeps its documented
 * walk/step/drop default.
 */
export const MOVE_MODES: readonly MoveMode[] = ['walk', 'step', 'drop'];

/** Phase 1 只开放四方向；对角线必须先验证 corner clearance（设计 D19）。 */
export type CardinalDirection = 'N' | 'E' | 'S' | 'W';
export const CARDINAL_DIRECTIONS: readonly CardinalDirection[] = ['N', 'E', 'S', 'W'];

export type MovementIntent =
  /** targetKind 在请求边界冻结：格目标的完成条件与精确连续脚位不同，续接不能改语义。 */
  | { kind: 'navigate'; to: Vec3Like; targetKind: NavigationTargetKind; arrival?: NavigationArrival; allowed: MoveMode[]; historical: boolean }
  | {
      kind: 'advance';
      direction: CardinalDirection;
      distance: number;
      maxLateralDrift: number;
      allowed: MoveMode[];
      historical: boolean;
    };

export type MoveScope = { worldId: string; dim: string; sessionId: string };

export type MovementPhase =
  | 'planning' | 'executing' | 'observing'
  | 'replanning' | 'stopped' | 'completed' | 'cancelled';

export type StopReason =
  | 'DISTANCE_MET'
  | 'REGION_ENTERED'
  | 'UNTIL_SEEN'
  | 'ARRIVED'
  | 'UNKNOWN_BOUNDARY'
  | 'BLOCKED'
  | 'TARGET_UNRESOLVED'
  | 'ROUTE_INVALIDATED'
  | 'NO_PATH'
  | 'RESIDENCY_NOT_READY'
  | 'PHYSICAL_FAILURE'
  | 'ACTION_FAILURE'
  | 'MODE_GAP'
  /** 宿主的授权/走廊/风险策略拒绝了唯一可用边；不是目标无法解析。 */
  | 'DELEGATION_RESTRICTION'
  /** 同一站位、同一相关证据下，搜索与复验给出不一致结论；本轮不自动重播。 */
  | 'CONFLICT'
  | 'NO_PROGRESS'
  | 'LATERAL_DRIFT'
  | 'DETOUR_TOO_LARGE'
  | 'BUDGET_EXHAUSTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  /** 身体被其他活动暂借（如 detour）：保留 session 与实测进展，可用同一 sessionId 续接。 */
  | 'SUSPENDED'
  /** 本次委托的施工授权已在前面用尽；普通路线仍可用，新的挖/放需要 Agent 重新授权。 */
  | 'MAKE_WAY_BUDGET_EXHAUSTED'
  | 'SCOPE_CHANGED'
  | 'INTENT_MISMATCH'
  | 'SUPERSEDED';

export interface MovementBudget {
  maxTransitions: number;
  maxSearches: number;
  maxObservations: number;
  maxObservedCells: number;
  maxNoProgressSegments: number;
  maxLateralDrift: number;
}

/** 创建 session 时冻结的委托授权；续接不得借旧 sessionId 扩大。 */
export interface MovementAuthorization {
  swim: boolean;
  makeWay?: MakeWayOptions;
}

export interface MovementCounters {
  searches: number;
  /** 没有带来任何位移的搜索；搜索预算只约束这一部分，正常推进中的规划不消耗预算。 */
  idleSearches: number;
  /** 代为开路的段数与实际改动数；与搜索/观察预算分开累计，不互相冲抵。 */
  makeWayLegs: number;
  makeWayEdits: number;
  segments: number;
  confirmedTransitions: number;
  /** 沿实际确认路线累计，不等于净位移。 */
  confirmedRouteLength: number;
  newChunks: number;
  newObservedCells: number;
  observations: number;
}

export interface MovementMeasured {
  start: Vec3Like;
  current: Vec3Like;
  sampledAt: number;
  onGround: boolean;
  inWater: boolean;
}

export interface MovementProgress {
  /** 沿冻结 bearing 的有符号投影；navigate 意图为 0。 */
  along: number;
  /** 相对冻结 bearing 的横向偏移。 */
  lateral: number;
  /** frozenOrigin 到 current 的水平直线距离。 */
  horizontalNet: number;
  verticalDelta: number;
  remaining?: number;
  stagnationSegments: number;
  lastProgressAt: number;
}

export interface StopReceipt {
  reason: StopReason;
  /** 统一错误分类；与 reason 同时出现在真实回执里，调用方不必自己猜。 */
  failure?: import('./contract.ts').MovementFailure;
  at: number;
  detail: string;
  blocker?: unknown;
  boundaries?: unknown[];
  modeGap?: unknown;
}

export interface MovementSession {
  id: string;
  intent: MovementIntent;
  intentKey: string;
  /** 创建时实测脚位；续接时不得改变。 */
  frozenOrigin: Vec3Like;
  /** advance 的归一化水平向量；navigate 意图没有。 */
  bearing?: { x: number; z: number };
  scope: MoveScope;

  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  phase: MovementPhase;

  budget: MovementBudget;
  /** 本次委托冻结的 swim/施工授权；恢复时沿用，不让有效 sessionId 变成扩大权限的依据。 */
  authorization: MovementAuthorization;
  counters: MovementCounters;
  measured: MovementMeasured;
  progress: MovementProgress;
  /** 最近一次实际施工改动（跨调用保留），额度耗尽时用来说明停在哪一处。 */
  lastMakeWayEdit?: { kind: 'dig' | 'place'; pos: Vec3Like; name: string };

  lastSegment?: unknown;
  lastSearch?: unknown;
  lastObservation?: unknown;
  /** 已检查的阻挡或观察后没有新证据的边界；有实际更新的未知边界仍受原观察预算约束。 */
  observedBoundaries?: string[];
  stop?: StopReceipt;

  /** 当前持有身体执行租约的 invocation；sessionId 本身不是锁。 */
  lease?: { id: string; at: number };
}

const CAPACITY = 8;
const TTL_MS = 10 * 60_000;
/** 租约超过单次 skill 最长执行时间仍未释放，视为前一次 invocation 异常退出。 */
const LEASE_TTL_MS = 5 * 60_000;

const sessions = new Map<string, MovementSession>();

const inScope = (session: MovementSession, scope: MoveScope) =>
  session.scope.worldId === scope.worldId && session.scope.dim === scope.dim && session.scope.sessionId === scope.sessionId;

/** 已完成/已取消/已停止的 session 不再参与“同一 scope 只能有一个活动意图”的取代。 */
const isTerminal = (session: MovementSession) =>
  session.phase === 'completed' || session.phase === 'cancelled' || session.phase === 'stopped';

/** 同一委托的施工改动余额：冻结授权 − 会话累计，恢复不重新获得额度。 */
export function remainingMakeWayEdits(session: MovementSession): number {
  return Math.max(0, (session.authorization.makeWay?.maxEdits ?? 0) - session.counters.makeWayEdits);
}

/** 同一 intent 的稳定指纹（不含预算与单次调用旋钮）。 */
export function intentKeyOf(intent: MovementIntent): string {
  return JSON.stringify(intent.kind === 'navigate'
    ? { kind: intent.kind, to: intent.to, targetKind: intent.targetKind, ...(intent.arrival === undefined ? {} : { arrival: intent.arrival }), allowed: [...intent.allowed].sort(), historical: intent.historical }
    : {
        kind: intent.kind, direction: intent.direction, distance: intent.distance,
        maxLateralDrift: intent.maxLateralDrift, allowed: [...intent.allowed].sort(), historical: intent.historical,
      });
}

function prune(now: number) {
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
  if (sessions.size < CAPACITY) return;
  const removable = [...sessions.values()]
    .filter(isTerminal)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  while (sessions.size >= CAPACITY && removable.length) sessions.delete(removable.shift()!.id);
  // 全是活动 session 时仍要守容量：丢掉最久未更新的一个，绝不让 map 无界增长。
  while (sessions.size >= CAPACITY) {
    const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest === undefined) break;
    sessions.delete(oldest.id);
  }
}

/** 同一 scope 同时最多一个活动移动 session；新意图把旧的标记为 superseded。 */
export function supersedeScope(scope: MoveScope, now: number, keep?: string) {
  for (const session of sessions.values()) {
    if (session.id === keep) continue;
    if (!inScope(session, scope) || isTerminal(session)) continue;
    session.phase = 'stopped';
    session.updatedAt = now;
    session.stop = { reason: 'SUPERSEDED', at: now, detail: '同一 scope 出现了新的移动意图，旧 session 不再允许继续执行' };
  }
}

/**
 * 身体被插曲临时借用（detour）：把原 session 标成可续接的 stopped，
 * 插曲随后创建的新意图只会取代仍在执行的 session，不会把原委托误判成 SUPERSEDED。
 */
export function suspendScopeSessions(scope: MoveScope, now = Date.now()) {
  for (const session of sessions.values()) {
    if (!inScope(session, scope) || isTerminal(session)) continue;
    session.phase = 'stopped';
    session.updatedAt = now;
    session.stop = { reason: 'SUSPENDED', at: now, detail: '身体被其他活动暂时借走；原移动委托与实测进展保留，可用同一 sessionId 续接' };
  }
}

export function createMovementSession(opts: {
  intent: MovementIntent;
  origin: Vec3Like;
  bearing?: { x: number; z: number };
  scope: MoveScope;
  budget: MovementBudget;
  authorization: MovementAuthorization;
  now: number;
}): MovementSession {
  const now = opts.now;
  prune(now);
  supersedeScope(opts.scope, now);
  const session: MovementSession = {
    id: shortId('ms_'),
    intent: opts.intent,
    intentKey: intentKeyOf(opts.intent),
    frozenOrigin: { ...opts.origin },
    ...(opts.bearing === undefined ? {} : { bearing: { ...opts.bearing } }),
    scope: { ...opts.scope },
    createdAt: now,
    updatedAt: now,
    expiresAt: now + TTL_MS,
    phase: 'planning',
    budget: { ...opts.budget },
    authorization: {
      swim: opts.authorization.swim,
      ...(opts.authorization.makeWay === undefined ? {} : { makeWay: { ...opts.authorization.makeWay } }),
    },
    counters: {
      searches: 0, idleSearches: 0, makeWayLegs: 0, makeWayEdits: 0, segments: 0, confirmedTransitions: 0, confirmedRouteLength: 0,
      newChunks: 0, newObservedCells: 0, observations: 0,
    },
    measured: {
      start: { ...opts.origin }, current: { ...opts.origin }, sampledAt: now,
      onGround: false, inWater: false,
    },
    progress: {
      along: 0, lateral: 0, horizontalNet: 0, verticalDelta: 0,
      ...(opts.intent.kind === 'advance' ? { remaining: opts.intent.distance } : {}),
      stagnationSegments: 0, lastProgressAt: now,
    },
  };
  sessions.set(session.id, session);
  return session;
}

export function findMovementSession(id: string, now = Date.now()): MovementSession | undefined {
  const session = sessions.get(id);
  if (session === undefined) return undefined;
  if (now > session.expiresAt) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function activeMovementSession(scope: MoveScope): MovementSession | undefined {
  return [...sessions.values()].find((session) => inScope(session, scope) && !isTerminal(session));
}

/**
 * 原子取得身体执行租约。作用域级并发由 Arbiter 保证只有一个任务，
 * 这里再保证同一 session 不会被两次 invocation（迟到回调/嵌套）同时驱动。
 */
export function acquireSessionLease(session: MovementSession, invocationId: string, now = Date.now()): boolean {
  if (session.lease !== undefined && session.lease.id !== invocationId && now - session.lease.at < LEASE_TTL_MS) return false;
  session.lease = { id: invocationId, at: now };
  return true;
}

export function releaseSessionLease(session: MovementSession, invocationId: string) {
  if (session.lease?.id === invocationId) delete session.lease;
}

/** 进程重启/换会话后不恢复；测试与宿主重置时显式调用。 */
export function clearMovementSessions() {
  sessions.clear();
}

export function movementSessionCount(): number {
  return sessions.size;
}

export { CAPACITY as MOVEMENT_SESSION_CAPACITY, TTL_MS as MOVEMENT_SESSION_TTL_MS };
