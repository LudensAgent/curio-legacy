import { type AgentState, type Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import {
  searchLandRouteAsync, summarizeBoundaries, verifyLandRoute,
  type LandSearchBoundary, type LandSearchBoundarySummary, type LandSearchBudget,
  type LandSearchResult, type LandSearchStatus, type LandSearchTransition, type SectionKey,
} from '../../spatial/land-search.ts';
import {
  acquireRouteResidency, releaseRouteResidency, routeDependencySections, sectionsForCells,
  type RouteResidency, type RouteResidencyFailure,
} from '../../spatial/skill-residency.ts';
import { DEFAULT_LAND_SEARCH_MAX_EDGES, DEFAULT_LAND_SEARCH_MAX_NODES, type LandSearchPolicySummary } from 'curio-minecraft-3d-memory/navigation';
import { feetCell } from '../../perception/local.ts';
import { codeFromError, isAbort, runSkill, validateSkill, type FailureCode, type SkillCtx, type SkillResult } from '../types.ts';
import { anchorOf, cellReached, feetReached, goalReached } from './goal.ts';
import type { NavigationGoal } from './goal.ts';
import type { PrimitiveProblemKind } from './receipt.ts';
import { descendTo } from './descend.ts';
import { boundaryProbeCells } from './observation.ts';
import type { MoveMode } from './session.ts';

/**
 * 单段执行器：只完成“一次搜索 + 一段前缀/路线”，持有跨段 session 的协调循环不在这里。
 * 搜索由库的有界 A* 提供；执行按 transition 的连续脚位使用身体控制完成，
 * 不把格心化动作冒充为精确 transition。不换目标、不施工、不做观察后重搜。
 */

export type SegmentOutcome =
  | 'reached_waypoint'
  | 'sighting'
  | 'partial_prefix'
  | 'unknown_boundary'
  | 'blocked'
  | 'no_path'
  | 'invalidated'
  | 'corridor_exhausted'
  | 'lateral_authorization'
  | 'unsupported'
  | 'physical_failure'
  | 'disallowed'
  | 'search_budget'
  | 'residency_not_ready'
  | 'replan'
  | 'cancelled'
  | 'timeout';

export type SegmentRequest = {
  /** 本段冻结目标；格目标与连续脚位的完成语义不同。 */
  goal: NavigationGoal;
  /** 方向推进的临时列按水平距离评估；普通目的地保留三维距离。 */
  goalMetric?: '3d' | 'horizontal';
  /** 方向委托的冻结总距离。只给计划端点已到这条线的地面身体动作增加终点条件。 */
  minimumAlong?: number;
  /** 从已验证路线的预计尾点继续同一委托；只会同时规划一个后续窗口。 */
  nextWindow?: (tail: Vec3Like) => NavigationGoal;
  /** 已确认一步后的当前可见命中，由委托定义具体观察对象。 */
  checkSighting?: () => string | undefined;
  allowed: MoveMode[];
  historical: boolean;
  /** 本段最多执行多少个已确认 transition。 */
  maxTransitions: number;
  allowUnknownCorridor: boolean;
  /** 当前 invocation 的绝对 deadline。 */
  deadline: number;
  /** 本段还可发起的搜索次数（0 表示不再搜索）。 */
  searchBudget: number;
  /** 单次搜索的节点/边预算；省略时用库默认值。 */
  searchLimits?: { maxNodes?: number; maxEdges?: number };
  /** advance 的横向授权走廊；搜索与每个 transition 都按它检查。 */
  corridor?: { origin: Vec3Like; bearing: { x: number; z: number }; maxLateral: number };
  /** 搜索/执行阶段切换；调用方据此只在“静止规划”阶段抑制卡死反射。 */
  onPhase?: (phase: 'searching' | 'executing') => void;
};

export interface TransitionReceipt {
  transition: LandSearchTransition;
  measuredFrom: Vec3Like;
  measuredTo: Vec3Like;
  /** 水平与垂直实测分量，分别验收；pathLength 是两者之和。 */
  measuredHorizontal: number;
  measuredVertical: number;
  pathLength: number;
}

export interface SegmentReceipt {
  waypoint: Vec3Like;
  outcome: SegmentOutcome;
  measuredStart: Vec3Like;
  measuredEnd: Vec3Like;
  /** 搜索实际选中的结果：当前证据完整路线 / 历史候选完整路线 / null（只有前缀）。 */
  chosen: LandSearchResult | null;
  /** 当前证据的严格搜索结果。若历史候选耗尽预算，记录实际耗尽预算的那次搜索；边界摘要仍来自当前证据。 */
  search: LandSearchResult;
  /** 对应 search 的真实终态，包括历史候选的预算耗尽。 */
  searchStatus: LandSearchStatus;
  searchReason: string;
  historicalSearch?: Pick<LandSearchResult, 'status' | 'budget' | 'stats'>;
  evidenceMode: 'current' | 'historical';
  searches: number;
  planned: LandSearchTransition[];
  confirmed: TransitionReceipt[];
  remaining: LandSearchTransition[];
  pathLength: number;
  arrived: boolean;
  directDrop: boolean;
  boundarySummary: LandSearchBoundarySummary;
  /** 与当前前缀端点相关、仍值得有限观察的边界。 */
  boundary?: LandSearchBoundary;
  /** 前缀端点朝目标方向已观测的阻挡。 */
  blockerAhead?: LandSearchBoundary;
  /** 历史候选/路线内部的首个当前证据 BLOCKED 段，或单步动作报告的已观测阻挡。 */
  blocker?: {
    index: number;
    transition: LandSearchTransition;
    status: string;
    reason?: string;
    problem?: PrimitiveProblemKind;
    cell?: Vec3Like;
    obstacle?: Vec3Like;
    /** Host risk policy refused this step; not an observed collision. */
    risk?: true;
    remediation?: unknown;
  };
  /** Result of the current one-step VoxelMap evidence check immediately before this action. */
  currentCheck?: {
    status: string;
    reason?: string;
    problem?: string;
    obstacle?: Vec3Like;
    risk?: true;
  };
  disallowed?: LandSearchTransition;
  problemKind?: PrimitiveProblemKind;
  failureCode?: FailureCode;
  /** 兼容既有回执的分类：start_drift / step_failed / effect_not_confirmed / max_steps / ... */
  stopCode?: string;
  /** 子动作的真实失败与证据，原样交给上层，不把执行完毕当成目标达成。 */
  nested?: { code: FailureCode; summary: string; data?: Record<string, unknown> };
  /** 动作失败/未确认时身体实际走过的部分位移；水平与垂直分开，位置必须来自实测。 */
  partialDisplacement?: { from: Vec3Like; to: Vec3Like; horizontal: number; vertical: number; atTarget: boolean };
  /** 搜索预算原因与未驻留的 Section；调用方据此区分“时间/节点/边/几何”和“需要加载”。 */
  budget?: LandSearchBudget;
  unavailableSections?: SectionKey[];
  /** Host edge-policy facts from the search that produced this segment. */
  policy?: LandSearchPolicySummary;
  stepIndex?: number;
  transition?: LandSearchTransition;
  detail?: string;
}

const KINDS: readonly MoveMode[] = ['walk', 'step', 'drop', 'jump', 'ladder'];
const OBSERVATION_RESOLVABLE = new Set(['UNKNOWN', 'STALE', 'INCOMPLETE']);
/** manual 模式下，一次搜索因未驻留页面最多重试加载几轮；每轮都受 deadline/搜索预算约束。 */
const MAX_RESIDENCY_ROUNDS = 8;
/** 这些搜索终态可能仅由未驻留页面造成；prepare 后值得重试。 */
const RESIDENCY_RETRYABLE: ReadonlySet<LandSearchStatus> = new Set([
  'INSUFFICIENT_EVIDENCE', 'NO_PATH_IN_MEMORY', 'INVALIDATED',
]);

const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
/** Ladder transitions may legitimately end with onGround=false; use the declared body precision. */
const ladderReached = (to: Vec3Like, point: Vec3Like): boolean =>
  Math.hypot(point.x - to.x, point.z - to.z) <= 0.12 && Math.abs(point.y - to.y) <= 0.05;
const meetsDistance = (request: SegmentRequest, point: Vec3Like): boolean => request.minimumAlong !== undefined && request.corridor !== undefined
  && (point.x - request.corridor.origin.x) * request.corridor.bearing.x + (point.z - request.corridor.origin.z) * request.corridor.bearing.z >= request.minimumAlong;
const directionalFinishFor = (request: SegmentRequest, transition: LandSearchTransition): boolean =>
  (transition.kind === 'walk' || transition.kind === 'step' || transition.kind === 'drop' && transition.drop <= 0.6) && meetsDistance(request, transition.to);
const transitionReached = (request: SegmentRequest, transition: LandSearchTransition, point: Vec3Like, onGround: boolean): boolean =>
  transition.kind === 'ladder'
    ? ladderReached(transition.to, point)
    : feetReached(transition.to, point, onGround) && (!directionalFinishFor(request, transition) || meetsDistance(request, point));
const centeredXZ = (point: Vec3Like): boolean =>
  Math.abs(point.x - (Math.floor(point.x) + 0.5)) <= 1e-9
  && Math.abs(point.z - (Math.floor(point.z) + 0.5)) <= 1e-9;
const sameCell = (a: Vec3Like, b: Vec3Like) => a.x === b.x && a.y === b.y && a.z === b.z;

function facingOf(from: Vec3Like, to: Vec3Like): 'N' | 'E' | 'S' | 'W' {
  const dx = to.x - from.x, dz = to.z - from.z;
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N');
}

const BOUNDARY_STATUS = new Set<LandSearchBoundary['status']>(['BLOCKED', 'UNKNOWN', 'STALE', 'UNSUPPORTED', 'INCOMPLETE']);
function boundaryStatusOf(status: string): LandSearchBoundary['status'] {
  return BOUNDARY_STATUS.has(status as LandSearchBoundary['status']) ? status as LandSearchBoundary['status'] : 'INCOMPLETE';
}

function directionOf(from: Vec3Like, to: Vec3Like): LandSearchBoundary['direction'] {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > 1e-9) return dx > 0 ? 'E' : 'W';
  if (Math.abs(dz) > 1e-9) return dz > 0 ? 'S' : 'N';
  return to.y > from.y ? 'UP' : to.y < from.y ? 'DOWN' : 'HERE';
}

function blockingProblemOf(
  entry: { problem?: string; obstacle?: Vec3Like }, targetCellY: number,
): PrimitiveProblemKind | undefined {
  if (entry.problem !== 'collision' || entry.obstacle === undefined) return undefined;
  return entry.obstacle.y === targetCellY ? 'TARGET_BLOCKED' : 'HEAD_BLOCKED';
}

/**
 * 从边界列表里只挑“起点就是当前前缀端点”且仍可由观察解决的那一个，取朝目标最近的方向。
 * 前缀端点之外的、侧向/上方的边界与本次推进无关，不能拿它们授权观察或重搜。
 */
function boundaryAfter(
  boundaries: readonly LandSearchBoundary[], endpoint: Vec3Like, target: Vec3Like,
): LandSearchBoundary | undefined {
  const endpointCell = cell(endpoint);
  const targetCell = cell(target);
  const closeness = (p: Vec3Like) =>
    Math.abs(Math.floor(p.x) - targetCell.x) + Math.abs(Math.floor(p.z) - targetCell.z) + Math.abs(p.y - target.y) * 2;
  return boundaries
    .filter((boundary) => sameCell(cell(boundary.from), endpointCell) && OBSERVATION_RESOLVABLE.has(boundary.status))
    .sort((a, b) => closeness(a.to) - closeness(b.to))[0];
}

function problemKindOf(data: Record<string, unknown> | undefined): PrimitiveProblemKind | undefined {
  const kind = (data?.problem as { kind?: unknown } | undefined)?.kind;
  return typeof kind === 'string' ? kind as PrimitiveProblemKind : undefined;
}

/** 非 BLOCKED 的搜索终态 → 段结局；NO_PATH_IN_MEMORY 不冒充已观测阻挡。 */
function outcomeOfStatus(status: LandSearchStatus): SegmentOutcome {
  switch (status) {
    case 'INSUFFICIENT_EVIDENCE': return 'unknown_boundary';
    case 'NO_PATH_IN_MEMORY': return 'no_path';
    case 'UNSUPPORTED': return 'unsupported';
    case 'INVALIDATED': return 'invalidated';
    case 'BUDGET_EXHAUSTED': return 'search_budget';
    case 'CANCELLED': return 'cancelled';
    default: return 'unsupported';
  }
}

function statusDetail(result: LandSearchResult): string {
  const sections = result.unavailableSections.length === 0 ? '' : `；${result.unavailableSections.length} 个 Section 未驻留`;
  switch (result.status) {
    case 'INSUFFICIENT_EVIDENCE': return `当前证据不足（INSUFFICIENT_EVIDENCE）${sections}；${result.reason}`;
    case 'NO_PATH_IN_MEMORY': return `已存几何里没有 walk/step/drop 路线（NO_PATH_IN_MEMORY）${sections}；${result.reason}`;
    case 'UNSUPPORTED': return `搜索不支持该精确目标（UNSUPPORTED）：${result.reason}`;
    case 'INVALIDATED': return `搜索期间证据/驻留发生变化（INVALIDATED）：${result.reason}`;
    case 'BUDGET_EXHAUSTED': return `搜索预算耗尽（${result.budget ?? 'unknown'}）：${result.reason}`;
    case 'CANCELLED': return `搜索被取消：${result.reason}`;
    default: return result.reason;
  }
}

function emptySearch(goal: NavigationGoal, status: LandSearchStatus, detail: string): LandSearchResult {
  return {
    status, assurance: 'geometry_only', evidenceMode: 'current', executable: false,
    needsRevalidation: true, from: { ...anchorOf(goal) }, target: { ...anchorOf(goal) },
    arrival: { kind: 'exact' }, points: [], transitions: [], cost: 0, boundaries: [],
    unavailableSections: [], reason: detail, evaluatedAt: Date.now(),
    stats: {
      nodesReached: 0, nodesExpanded: 0, edgesEvaluated: 0, surfaceReads: 0, sectionsRead: 0,
      staleReads: 0, corridorSkipped: 0, boundariesTruncated: false, durationMs: 0,
      yieldCount: 0, maxSyncSliceMs: 0,
    },
    resolvedTarget: { ...anchorOf(goal) },
  };
}

/**
 * 执行一段。每次动作后都必须读取真实身体状态；计划点、waypoint、Promise resolve 都不能代替实测。
 * 已确认前缀在后续失败时保留，不把整个 segment 归零。
 *
 * manual 模式下，搜索/执行期间实际依赖的 Section 由内层持有 lease；本包装器
 * 保证所有返回路径都释放，不让 pin 泄漏到会话账本。
 */
type SegmentExecution = { handedOver: boolean; finishPreview?: () => Promise<number> };

export async function runNavigationSegment(ctx: SkillCtx, request: SegmentRequest): Promise<SegmentReceipt> {
  const leases: RouteResidency[] = [];
  const execution: SegmentExecution = { handedOver: false };
  let result: SegmentReceipt | undefined;
  try {
    result = await runNavigationSegmentInner(ctx, request, leases, execution);
    return result;
  } finally {
    const finishedSearches = execution.finishPreview?.();
    if (execution.handedOver) {
      const remaining = request.deadline - Date.now();
      let error: unknown = null;
      if (!ctx.signal.aborted && result?.outcome !== 'cancelled') {
        if (remaining <= 0) error = new Error('TIMEOUT: 原期限已耗尽，身体尚未实测停稳');
        else if (ctx.adapter.settleMovement !== undefined) {
          error = await ctx.adapter.settleMovement({ signal: ctx.signal, timeoutMs: Math.min(2000, remaining) }).then(() => null, (cause: unknown) => cause);
        }
      }
      const stopped = ctx.adapter.state();
      if (result !== undefined) {
        const from = result.partialDisplacement?.from ?? result.confirmed.at(-1)?.measuredTo ?? result.measuredStart;
        const horizontal = Math.hypot(stopped.pos.x - from.x, stopped.pos.z - from.z);
        const vertical = Math.abs(stopped.pos.y - from.y);
        result.measuredEnd = { ...stopped.pos };
        if (result.partialDisplacement !== undefined || horizontal > 0.001 || vertical > 0.001) {
          result.partialDisplacement = {
            from: { ...from }, to: { ...stopped.pos }, horizontal, vertical,
            atTarget: result.transition === undefined ? goalReached(request.goal, stopped.pos, stopped.onGround)
              : transitionReached(request, result.transition, stopped.pos, stopped.onGround),
          };
        }
        if (ctx.signal.aborted || isAbort(error)) {
          result.outcome = 'cancelled';
          result.stopCode = 'cancelled';
          result.arrived = false;
          result.detail = '连续移动已取消，保留最新实测位置';
        } else if (error !== null) {
          result.failureCode = codeFromError(error);
          result.outcome = result.failureCode === 'TIMEOUT' ? 'timeout' : 'physical_failure';
          result.stopCode = 'settlement_failed';
          result.arrived = false;
          result.detail = `${result.detail ?? '连续移动停止'}；释放控制后的停稳确认失败：${error instanceof Error ? error.message : String(error)}`;
        } else if (result.arrived && request.goalMetric !== 'horizontal' && !goalReached(request.goal, stopped.pos, stopped.onGround)) {
          result.outcome = 'physical_failure';
          result.arrived = false;
          result.failureCode = 'EFFECT_NOT_CONFIRMED';
          result.detail = '连续移动释放控制后，实测停点不再满足原目标；保留实际位移';
        }
      }
    }
    if (finishedSearches !== undefined) {
      const count = await finishedSearches;
      if (result !== undefined) result.searches = count;
    }
    const spatial = ctx.spatial;
    if (spatial !== undefined) for (const residency of leases) releaseRouteResidency(spatial, residency);
  }
}

async function runNavigationSegmentInner(
  ctx: SkillCtx, request: SegmentRequest, leases: RouteResidency[], execution: SegmentExecution,
): Promise<SegmentReceipt> {
  const spatial = ctx.spatial;
  const state = ctx.adapter.state();
  const start = { ...state.pos };
  const waypoint = { ...request.goal.requested };
  if (!spatial?.session?.voxel) {
    return {
      waypoint, outcome: 'unsupported', measuredStart: start, measuredEnd: start,
      chosen: null, search: emptySearch(request.goal, 'INVALIDATED', '没有共享空间 VoxelMap'), searchStatus: 'INVALIDATED',
      searchReason: '没有共享空间 VoxelMap', evidenceMode: 'current', searches: 0,
      planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
      boundarySummary: summarizeBoundaries([]), detail: '没有共享空间 VoxelMap',
    };
  }
  const voxel = spatial.session.voxel;
  const manual = spatial.session.voxelLoading === 'manual';
  const scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
  // 放在对象里，避免 TypeScript 把闭包内赋值前的变量窄化成 null。
  const residencyState: { failure: RouteResidencyFailure | null } = { failure: null };
  const base = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
    goal: request.goal, allowed: request.allowed, maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
    ...(request.goalMetric === undefined ? {} : { goalMetric: request.goalMetric }),
    ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
    ...(request.searchLimits?.maxNodes === undefined ? {} : { maxNodes: request.searchLimits.maxNodes }),
    ...(request.searchLimits?.maxEdges === undefined ? {} : { maxEdges: request.searchLimits.maxEdges }),
  };
  const lateralOf = (p: Vec3Like): number => request.corridor === undefined
    ? 0
    : Math.abs((p.x - request.corridor.origin.x) * request.corridor.bearing.z - (p.z - request.corridor.origin.z) * request.corridor.bearing.x);
  const corridorLimit = request.corridor === undefined ? Infinity : request.corridor.maxLateral + 0.01;
  // 搜索与执行共享原 invocation deadline；库的 maxSyncSliceMs 保证同步切片有界，
  // 不再用固定 1500ms 截断长路线搜索。预算耗尽时仍由同一个 deadline 停止。
  const searchWindow = () => ({ deadlineMs: request.deadline, maxSearchMs: Math.max(1, request.deadline - Date.now()) });
  let searches = 0;
  let nodesRead = 0, edgesRead = 0;
  // 这份判断同时决定是否加载更远的冷页、是否改查历史路线。范围目标可能在前缀阻挡之前就已可达。
  const currentPrefix = (result: LandSearchResult, goal = request.goal) => {
    const prefix = result.evidenceMode === 'current' ? result.prefix : undefined;
    const reachesArrival = goal.arrival !== undefined
      && prefix?.transitions.some(transition => goalReached(goal, transition.to, true)) === true;
    // 范围导航可从已知前缀端点观察绕路。远端一条出边碰墙，不会使到端点的 OPEN 路段失效。
    const approachBlocker = goal.arrival !== undefined && result.status === 'INSUFFICIENT_EVIDENCE'
      && prefix?.knownBlockerAhead?.status === 'BLOCKED';
    const usable = prefix !== undefined && prefix.transitions.length > 0
      && (prefix.knownBlockerAhead === undefined || reachesArrival || approachBlocker);
    return { usable, reachesArrival };
  };
  /**
   * 一次搜索的真实调用。manual 下库不会隐式加载已保存页面，只把遇到的未驻留
   * Section 报告为 unavailableSections；这里显式 prepare 后重试同一搜索。
   * 每次重试都是真实搜索，计入 searches；加载失败原样保留为回执事实。
   */
  const runSearch = async (searchRequest: Parameters<typeof searchLandRouteAsync>[1]) => {
    // 范围导航的 current / remembered 共用两次默认搜索的总工作量。当前搜索提前
    // 结束时，历史绕路可使用余量；调用者显式指定的单次上限仍逐次原样执行。
    const share = request.goal.arrival !== undefined && searchRequest.evidenceMode === 'remembered';
    const result = await searchLandRouteAsync(voxel, {
      ...searchRequest,
      ...(share && searchRequest.maxNodes === undefined ? { maxNodes: DEFAULT_LAND_SEARCH_MAX_NODES + Math.max(0, DEFAULT_LAND_SEARCH_MAX_NODES - nodesRead) } : {}),
      ...(share && searchRequest.maxEdges === undefined ? { maxEdges: DEFAULT_LAND_SEARCH_MAX_EDGES + Math.max(0, DEFAULT_LAND_SEARCH_MAX_EDGES - edgesRead) } : {}),
    });
    searches += 1;
    nodesRead += result.stats.nodesReached;
    edgesRead += result.stats.edgesEvaluated;
    return result;
  };
  const search = async (searchRequest: Parameters<typeof searchLandRouteAsync>[1]): Promise<LandSearchResult> => {
    let result = await runSearch(searchRequest);
    if (!manual) return result;
    for (let round = 0; round < MAX_RESIDENCY_ROUNDS; round += 1) {
      if (result.unavailableSections.length === 0 || !RESIDENCY_RETRYABLE.has(result.status)
        || searches >= request.searchBudget || Date.now() >= request.deadline) break;
      if (currentPrefix(result).usable) break;
      const residency = await acquireRouteResidency(spatial, result.unavailableSections, {
        signal: ctx.signal, deadline: request.deadline,
      });
      if (residency.status !== 'ready') {
        residencyState.failure = residency;
        break;
      }
      leases.push(residency);
      result = await runSearch(searchRequest);
    }
    return result;
  };

  if (request.searchBudget < 1) {
    return {
      waypoint, outcome: 'search_budget', measuredStart: start, measuredEnd: start,
      chosen: null, search: emptySearch(request.goal, 'BUDGET_EXHAUSTED', '搜索预算已用尽'), searchStatus: 'BUDGET_EXHAUSTED',
      searchReason: '搜索预算已用尽', evidenceMode: 'current', searches: 0,
      planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
      boundarySummary: summarizeBoundaries([]), detail: '搜索预算已用尽',
    };
  }
  request.onPhase?.('searching');
  // 方向委托先检查身体当前所在的直线。允许横向绕行的宽度不参与这次直行探测；
  // 只有已知阻挡才需要搜索整个授权走廊。证据不全时先走直行前缀并观察前方。
  const heading = request.goalMetric === 'horizontal' ? request.corridor : undefined;
  let straight = heading !== undefined && heading.maxLateral > 0 && lateralOf(start) <= corridorLimit;
  const line = straight && heading !== undefined ? { ...heading, origin: start, maxLateral: 0 } : undefined;
  let strict = await search({ ...base, ...(line === undefined ? {} : { corridor: line }), ...searchWindow() });
  if (straight && (strict.prefix?.knownBlockerAhead !== undefined || strict.status === 'NO_PATH_IN_MEMORY')
    && searches < request.searchBudget && Date.now() < request.deadline && !ctx.signal.aborted) {
    straight = false;
    strict = await search({ ...base, ...searchWindow() });
  }
  if (strict.status === 'CANCELLED') {
    return cancelledReceipt(strict, request, start, searches);
  }
  const localStale = strict.status === 'INSUFFICIENT_EVIDENCE'
    && (strict.prefix?.atStart === true || strict.prefix === undefined && strict.transitions.length === 0)
    ? boundaryAfter(strict.boundaries.filter((boundary) => boundary.status === 'STALE'
      && boundary.from.x === start.x && boundary.from.y === start.y && boundary.from.z === start.z), start, anchorOf(request.goal))
    : undefined;
  if (localStale !== undefined) {
    return {
      waypoint, outcome: 'unknown_boundary', measuredStart: start, measuredEnd: { ...ctx.adapter.state().pos },
      chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
      evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
      arrived: false, directDrop: false, boundarySummary: summarizeBoundaries(strict.boundaries), boundary: localStale,
      stopCode: 'current_geometry', detail: '当前站位的局部边界证据已过期；先观察恢复当前证据，没有扫描历史候选或执行移动',
    };
  }
  let chosen: LandSearchResult | null = strict.status === 'FOUND' ? strict : null;
  let historical: LandSearchResult | null = null;
  // 当前证据已有可执行前缀时先走前缀，不再为“完整历史路线”消耗一次长搜索；
  // 前缀走到边界后由 Coordinator 观察/重搜。历史候选只在前缀不可用时兜底。
  // 范围委托可以在阻挡之前完成：这里只判断当前已验证前缀是否包含合法候选，
  // 不把计划位置当成身体到达；执行时仍逐步当前复验并按实测站稳位置收工。
  const { usable: currentPrefixUsable, reachesArrival: prefixReachesArrival } = currentPrefix(strict);
  const partialToWall = request.goal.arrival !== undefined && strict.prefix?.knownBlockerAhead !== undefined && !prefixReachesArrival;
  if (chosen === null && (!currentPrefixUsable || partialToWall) && !straight && request.historical && request.searchBudget - searches > 0) {
    historical = await search({ ...base, evidenceMode: 'remembered', ...searchWindow() });
    if (historical.status === 'CANCELLED') return cancelledReceipt(historical, request, start, searches);
    if (historical.status === 'FOUND') chosen = historical;
  }
  let boundarySummary = summarizeBoundaries(strict.boundaries);
  const historicalAttempt = historical === null ? {} : { historicalSearch: { status: historical.status, budget: historical.budget, stats: historical.stats } };

  // 1×1 平台/柱顶没有普通 A* 路线：格目标、明确允许 drop 且目标就在相邻列时，直接尝试一次 descend_to。
  // 连续精确脚位不走这条格心化回退，避免把附近格冒充原目标。
  if (chosen === null && !prefixReachesArrival && request.goal.kind === 'cell') {
    const dropStart = { ...ctx.adapter.state().pos };
    const from = feetCell(dropStart);
    const dropTo = { x: Math.floor(request.goal.requested.x), y: request.goal.requested.y, z: Math.floor(request.goal.requested.z) };
    const drop = from.y - dropTo.y;
    if (lateralOf(dropStart) > corridorLimit) {
      return {
        waypoint, outcome: 'lateral_authorization', measuredStart: start, measuredEnd: dropStart,
        chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
        evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
        arrived: false, directDrop: false, boundarySummary, failureCode: 'PATH_NOT_FOUND',
        stopCode: 'lateral_authorization',
        detail: `实测起点横向 ${lateralOf(dropStart).toFixed(2)} 格已超出授权 ${request.corridor?.maxLateral ?? 0} 格；没有执行直接下落`,
      };
    }
    if (request.allowed.includes('drop') && Math.abs(dropTo.x - from.x) + Math.abs(dropTo.z - from.z) === 1
      && drop > 0.25 && drop <= 4.01 && lateralOf({ x: dropTo.x + 0.5, y: dropTo.y, z: dropTo.z + 0.5 }) <= corridorLimit) {
      const physicalTo = { x: dropTo.x + 0.5, y: dropTo.y, z: dropTo.z + 0.5 };
      // 1×1 回退只按格心落地；格心起点才能用单位 drop 几何复验真实动作。
      if (dropStart.x !== from.x + 0.5 || dropStart.z !== from.z + 0.5) {
        return {
          waypoint, outcome: 'unsupported', measuredStart: start, measuredEnd: dropStart,
          chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
          evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
          arrived: false, directDrop: false, boundarySummary, failureCode: 'BAD_ARGS',
          stopCode: 'unsupported_direct_drop',
          detail: '直接下落回退需要身体在起点格心；当前实测起点不是格心，不能用格心落点证明连续 endpoint',
        };
      }
      if (manual) {
        const residency = await acquireRouteResidency(spatial, sectionsForCells(scope, [dropStart, physicalTo]), {
          signal: ctx.signal, deadline: request.deadline,
        });
        if (residency.status !== 'ready') {
          return {
            waypoint, outcome: 'residency_not_ready', measuredStart: start, measuredEnd: dropStart,
            chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
            evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
            arrived: false, directDrop: false, boundarySummary,
            unavailableSections: residency.sections,
            failureCode: 'PATH_NOT_FOUND', stopCode: 'residency_gap',
            detail: `直接下落所需的 ${residency.sections.length} 个 Section 未能加载/驻留（${residency.reason}）：${residency.message}；没有执行未复验的动作`,
          };
        }
        leases.push(residency);
      }
      const dropCheck = verifyLandRoute(voxel, {
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
        body: base.body, rules: walkLandRules,
      }, [{ kind: 'drop', from: { ...dropStart }, to: physicalTo, drop }], Date.now()).transitions[0]!;
      if (dropCheck.status !== 'OPEN') {
        return {
          waypoint, outcome: dropCheck.status === 'BLOCKED' ? 'blocked' : dropCheck.status === 'UNSUPPORTED' ? 'unsupported' : 'unknown_boundary',
          measuredStart: start, measuredEnd: dropStart,
          chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
          evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
          arrived: false, directDrop: false, boundarySummary,
          currentCheck: {
            status: dropCheck.status,
            ...(dropCheck.reason === undefined ? {} : { reason: dropCheck.reason }),
            ...(dropCheck.problem === undefined ? {} : { problem: dropCheck.problem }),
            ...(dropCheck.obstacle === undefined ? {} : { obstacle: { ...dropCheck.obstacle } }),
            ...(dropCheck.risk === true ? { risk: true as const } : {}),
          },
          failureCode: dropCheck.status === 'BLOCKED' ? 'PATH_NOT_FOUND' : dropCheck.status === 'UNSUPPORTED' ? 'BAD_ARGS' : 'NOT_FOUND',
          stopCode: 'current_geometry',
          detail: `直接下落目标格心的当前证据 ${dropCheck.status}${dropCheck.reason === undefined ? '' : `（${dropCheck.reason}）`}；没有执行`,
        };
      }
      const validated = validateSkill(descendTo, {
        target: { x: dropTo.x, y: dropTo.y, z: dropTo.z },
        ...(request.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
      }, ctx.adapter);
      if (validated.ok) {
        if (Date.now() >= request.deadline) {
          return {
            waypoint, outcome: 'timeout', measuredStart: start, measuredEnd: start,
            chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
            evidenceMode: 'current', searches, planned: [], confirmed: [], remaining: [], pathLength: 0,
            arrived: false, directDrop: false, boundarySummary, stopCode: 'deadline', detail: '执行期限在直接下落前耗尽',
          };
        }
        const transition = { kind: 'drop' as const, from: { ...dropStart }, to: { ...dropTo }, drop };
        let moved: SkillResult;
        try {
          const nestedCtx = { ...ctx, deadline: Math.min(ctx.deadline, request.deadline) };
          moved = await runSkill(nestedCtx, descendTo, validated.args);
        } catch (error) {
          if (!isAbort(error)) throw error;
          const cancelledEnd = ctx.adapter.state();
          return directDropCancelled(strict, request, start, dropStart, { ...cancelledEnd.pos }, cancelledEnd.onGround, transition, searches, '执行直接下落时被取消');
        }
        const endState = ctx.adapter.state();
        const end = { ...endState.pos };
        const directConfirmed = [{
          transition, measuredFrom: dropStart, measuredTo: end,
          measuredHorizontal: Math.hypot(end.x - dropStart.x, end.z - dropStart.z),
          measuredVertical: Math.abs(end.y - dropStart.y), pathLength: drop,
        }];
        if (moved.status === 'succeeded') {
          if (lateralOf(end) > corridorLimit) {
            return {
              waypoint, outcome: 'lateral_authorization', measuredStart: start, measuredEnd: end,
              chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
              evidenceMode: 'current', searches,
              planned: [transition], confirmed: directConfirmed, remaining: [], pathLength: drop,
              arrived: false, directDrop: true, boundarySummary,
              failureCode: 'PATH_NOT_FOUND', stopCode: 'lateral_authorization',
              detail: `直接下落实测停在横向 ${lateralOf(end).toFixed(2)} 格，超出授权 ${request.corridor?.maxLateral ?? 0} 格；确认位移保留`,
            };
          }
          return {
            waypoint, outcome: 'reached_waypoint', measuredStart: start, measuredEnd: end,
            chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
            evidenceMode: 'current', searches,
            planned: [transition], confirmed: directConfirmed,
            remaining: [], pathLength: drop, arrived: true, directDrop: true, boundarySummary,
          };
        }
        if (moved.status === 'cancelled') return directDropCancelled(strict, request, start, dropStart, end, endState.onGround, transition, searches, '直接下落未完成，已确认位移保留');
        return {
          waypoint, outcome: 'physical_failure', measuredStart: start, measuredEnd: end,
          chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
          evidenceMode: 'current', searches,
          planned: [transition], confirmed: [], remaining: [transition], pathLength: 0, arrived: false,
          directDrop: true, boundarySummary,
          ...(moved.failureCode === undefined ? {} : { failureCode: moved.failureCode }),
          detail: moved.summary,
          ...(problemKindOf(moved.data) === undefined ? {} : { problemKind: problemKindOf(moved.data)! }),
        };
      }
    }
  }

  // 2. 没有完整路线：执行证据缺口前缀，或能够完成显式范围委托的当前前缀。
  // 其余 BLOCKED/UNSUPPORTED 前缀交回端点 + blocker，不自动靠近阻挡。
  const reachable = strict.prefix;
  const blockerAhead = reachable?.knownBlockerAhead;
  if (chosen === null && !currentPrefixUsable) {
    // 历史几何搜索的预算耗尽是真实终态，不能被 strict 的“证据不足”覆盖成普通未知边界。
    const historicalBudget = blockerAhead === undefined && chosen === null && historical?.status === 'BUDGET_EXHAUSTED'
      ? historical : null;
    const residencyFailure = residencyState.failure;
    // A failed cold-page load is a capability/residency fact, not "no path" and
    // not an evidence gap. It must win over the search status derived from the
    // pages that happened to be available.
    // 直接阻挡/不支持与“整个授权走廊内没有路”、“已存几何无路”、“证据不足”分开，不互相顶替。
    const outcome: SegmentOutcome = residencyFailure !== null ? 'residency_not_ready'
      : blockerAhead?.status === 'BLOCKED' ? 'blocked'
        : blockerAhead?.status === 'UNSUPPORTED' ? 'unsupported'
          : !straight && strict.corridorLimited === true ? 'corridor_exhausted'
            : historicalBudget !== null ? 'search_budget'
              : outcomeOfStatus(strict.status);
    const blockedBoundary = blockerAhead ?? boundaryAfter(strict.boundaries, reachable?.endpoint ?? state.pos, anchorOf(request.goal));
    const unavailable = residencyFailure !== null && residencyFailure.sections.length > 0
      ? residencyFailure.sections
      : historicalBudget !== null && historicalBudget.unavailableSections.length > 0
        ? historicalBudget.unavailableSections
        : strict.unavailableSections.length > 0
          ? strict.unavailableSections
          : [];
    const residencyNote = residencyFailure === null
      ? ''
      : `；驻留加载失败（${residencyFailure.reason}）：${residencyFailure.message}`;
    return {
      waypoint, outcome, stopCode: residencyFailure !== null ? 'residency_gap' : blockerAhead === undefined ? 'no_route' : 'blocker', measuredStart: start, measuredEnd: start,
      chosen: null, search: historicalBudget ?? strict, ...historicalAttempt,
      searchStatus: (historicalBudget ?? strict).status, searchReason: (historicalBudget ?? strict).reason,
      evidenceMode: 'current', searches,
      planned: reachable?.transitions ?? [], confirmed: [], remaining: reachable?.transitions ?? [],
      pathLength: 0, arrived: false, directDrop: false, boundarySummary,
      ...(historicalBudget?.budget !== undefined ? { budget: historicalBudget.budget }
        : strict.budget === undefined ? {} : { budget: strict.budget }),
      ...(unavailable.length === 0 ? {} : { unavailableSections: unavailable }),
      ...(strict.policy === undefined ? {} : { policy: strict.policy }),
      ...(blockerAhead === undefined ? {} : { blockerAhead }),
      ...(outcome === 'unknown_boundary' && blockedBoundary !== undefined ? { boundary: blockedBoundary } : {}),
      detail: residencyFailure !== null
        ? `导航所需的 ${residencyFailure.sections.length} 个 Section 未能加载/驻留（${residencyFailure.reason}）：${residencyFailure.message}；没有把冷页失败当成无路或未知，未执行未复验的动作`
        : `${blockerAhead !== undefined
          ? `朝目标方向的边界已是 ${blockerAhead.status}${blockerAhead.reason === undefined ? '' : `（${blockerAhead.reason}）`}`
          : !straight && strict.corridorLimited === true
            ? `授权横向走廊（±${request.corridor?.maxLateral ?? 0} 格）内没有 walk/step/drop 路线；外侧绕行未授权`
            : historicalBudget !== null
              ? `历史体素搜索预算耗尽（${historicalBudget.budget ?? 'unknown'}）：${historicalBudget.reason}`
              : statusDetail(strict)}${residencyNote}`,
    };
  }

  let route = chosen ?? strict;
  let tailGoal = request.goal;
  const planned = [...(chosen === null ? reachable?.transitions ?? [] : chosen.transitions)];
  const disallowed = planned.find((transition) => !request.allowed.includes(transition.kind));
  if (disallowed !== undefined) {
    return {
      waypoint, outcome: 'disallowed', measuredStart: start, measuredEnd: start,
      chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
      evidenceMode: 'current', searches,
      planned, confirmed: [], remaining: planned, pathLength: 0, arrived: false, directDrop: false,
      boundarySummary, disallowed, stopCode: 'disallowed_transition',
      ...(route.policy === undefined ? {} : { policy: route.policy }),
      detail: `第一段是 ${disallowed.kind}，不在 allowed（${request.allowed.join('、')}）`,
    };
  }
  request.onPhase?.('executing');
  const transitions = planned.slice(0, request.maxTransitions);
  let truncated = transitions.length < planned.length;
  const confirmed: TransitionReceipt[] = [];
  let pathLength = 0;
  let last: AgentState = state;
  let executed = 0;
  const receipt = (outcome: SegmentOutcome, extra: Partial<SegmentReceipt> = {}): SegmentReceipt => {
    const end = { ...ctx.adapter.state().pos };
    return {
      waypoint: { ...tailGoal.requested }, outcome, measuredStart: start, measuredEnd: end,
      chosen, search: strict, searchStatus: strict.status, searchReason: strict.reason, ...historicalAttempt,
      evidenceMode: route.evidenceMode, searches,
      planned, confirmed, remaining: planned.slice(executed), pathLength,
      arrived: false, directDrop: false, boundarySummary,
      ...(route.policy === undefined ? {} : { policy: route.policy }),
      ...extra,
    };
  };
  // 每段只用当前 VoxelMap 证据复验这一次动作；不读隐藏的已加载客户端方块，
  // 也不在一次同步调用里重算整条路线。
  const currentRequest = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: base.body, rules: walkLandRules,
  };
  // manual 下先保护本次真正会读的 Section：搜索与执行之间可能发生周期 checkpoint，
  // 未 pin 的页面会被保存后换出，逐步复验随后只能看到 UNKNOWN。依赖只来自已选
  // 路线和真实 drop/ladder 跨度，不预取目标走廊。
  const pinTransitions = async (feet: Vec3Like, edges: LandSearchTransition[], signal: AbortSignal) => {
    const verticalCells = edges.flatMap((transition) => {
      const span = Math.round(transition.from.y - transition.to.y);
      if (transition.kind !== 'ladder' && !(transition.kind === 'drop' && span > 1)) return [];
      return Array.from({ length: Math.abs(span) + 1 }, (_, index) => ({
        x: transition.to.x,
        y: transition.to.y + Math.sign(span) * index,
        z: transition.to.z,
      }));
    });
    const sections = [
      ...routeDependencySections(voxel, scope, feet, edges.map((transition) => transition.to)),
      ...sectionsForCells(scope, [
        ...edges.flatMap((transition) => [transition.from, transition.to]),
        ...verticalCells,
      ]),
    ];
    const residency = await acquireRouteResidency(spatial, sections, {
      signal, deadline: request.deadline,
    });
    if (residency.status === 'ready') leases.push(residency);
    return residency;
  };
  if (manual && transitions.length > 0) {
    const residency = await pinTransitions(ctx.adapter.state().pos, transitions, ctx.signal);
    if (residency.status !== 'ready') {
      return receipt('residency_not_ready', {
        stopCode: 'residency_gap',
        detail: `执行 ${transitions.length} 段所需的 Section 未能加载/驻留（${residency.reason}）：${residency.message}；没有执行未复验的动作`,
        failureCode: 'PATH_NOT_FOUND',
        unavailableSections: residency.sections,
      });
    }
  }
  const cancelledHere = (index: number, transition: LandSearchTransition, from: Vec3Like): SegmentReceipt => {
    const stoppedState = ctx.adapter.state();
    const stopped = { ...stoppedState.pos };
    // 与普通失败分支同一套“实测端点”谓词：取消发生在身体已经到位之后时，
    // 这段是真实完成的进展，不能因为取消就把已确认的 transition 丢掉。
    const atTarget = transitionReached(request, transition, stopped, stoppedState.onGround);
    const horizontal = Math.hypot(stopped.x - from.x, stopped.z - from.z);
    const vertical = Math.abs(stopped.y - from.y);
    if (atTarget) {
      executed += 1;
      const path = horizontal + vertical;
      confirmed.push({
        transition, measuredFrom: { ...from }, measuredTo: stopped,
        measuredHorizontal: horizontal, measuredVertical: vertical, pathLength: path,
      });
      pathLength += path;
    }
    const partial = { from: { ...from }, to: stopped, horizontal, vertical, atTarget };
    return {
      ...receipt('cancelled', {
        stopCode: 'cancelled',
        detail: atTarget
          ? '父任务取消；取消前身体已实测到本段端点，这段按确认进展保留，任务仍未到达'
          : '父任务取消；本段已确认进展与实测部分位移保留',
        partialDisplacement: partial, stepIndex: index, transition,
      }),
      measuredEnd: stopped,
    };
  };
  const refusal = (index: number, transition: LandSearchTransition, check: ReturnType<typeof verifyLandRoute>['transitions'][number], current: AgentState): SegmentReceipt => {
    const currentCheck = {
      status: check.status,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      ...(check.problem === undefined ? {} : { problem: check.problem }),
      ...(check.obstacle === undefined ? {} : { obstacle: { ...check.obstacle } }),
      ...(check.risk === true ? { risk: true as const } : {}),
    };
    const boundary: LandSearchBoundary = {
      from: { ...current.pos }, to: { ...transition.to }, kind: transition.kind,
      status: boundaryStatusOf(check.status),
      reason: check.reason ?? check.status,
      direction: directionOf(current.pos, transition.to),
    };
    if (check.status === 'BLOCKED') {
      const problem = blockingProblemOf(check, Math.floor(transition.to.y + 0.05));
      return receipt('blocked', {
        stopCode: check.risk === true ? 'risk_boundary' : 'blocker',
        detail: `第 ${index + 1} 段当前证据 ${check.status}${check.reason === undefined ? '' : `（${check.reason}）`}；没有执行`,
        failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition, currentCheck, boundary,
        ...(problem === undefined ? {} : { problemKind: problem }),
        blocker: {
          index, transition, status: 'BLOCKED',
          ...(check.reason === undefined ? {} : { reason: check.reason }),
          ...(problem === undefined ? {} : { problem, cell: { x: Math.floor(transition.to.x), y: Math.floor(transition.to.y + 0.05), z: Math.floor(transition.to.z) } }),
          ...(check.obstacle === undefined ? {} : { obstacle: { ...check.obstacle } }),
          ...(check.risk === true ? { risk: true as const } : {}),
        },
      });
    }
    if (check.status === 'UNSUPPORTED') {
      return receipt('unsupported', {
        stopCode: 'unsupported_transition',
        detail: `第 ${index + 1} 段当前证据不支持这条过渡（${check.reason ?? check.status}）；没有执行`,
        failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition, currentCheck, boundary,
      });
    }
    return receipt('unknown_boundary', {
      stopCode: 'current_geometry',
      detail: `第 ${index + 1} 段当前证据 ${check.status}${check.reason === undefined ? '' : `（${check.reason}）`}；没有执行`,
      failureCode: 'NOT_FOUND', stepIndex: index, transition, currentCheck, boundary,
    });
  };

  // 后续规划始终从已知路线尾点出发，当前身体继续执行逐步复验过的前缀。
  // 只有新窗口的当前 OPEN 链会被追加；走到尾点时仍没有后续证据则先按原端点停稳。
  const attemptedTails = new Map<string, number>();
  let preview: Promise<void> | undefined;
  let previewAbort: AbortController | undefined, stopWatching: (() => void) | undefined;
  let previewClosed = false, physicalIndex = 0;
  const previewEnd: { result?: LandSearchResult; goal?: NavigationGoal; residency?: RouteResidencyFailure; error?: string; newEvidence?: () => boolean } = {};
  if (request.nextWindow !== undefined) execution.finishPreview = async () => {
    previewClosed = true;
    stopWatching?.();
    previewAbort?.abort();
    await preview;
    return searches;
  };
  const startPreview = (index: number) => {
    const nextWindow = request.nextWindow;
    if (nextWindow === undefined || previewClosed || preview !== undefined || previewEnd.error !== undefined
      || transitions.length - index > 3 || transitions.length >= request.maxTransitions
      || searches >= request.searchBudget || Date.now() >= request.deadline || ctx.signal.aborted) return;
    const tail = transitions[transitions.length - 1]!.to;
    if (meetsDistance(request, tail) || request.goalMetric !== 'horizontal' && goalReached(request.goal, tail, true)) return;
    const key = `${tail.x},${tail.y},${tail.z}`;
    const attempts = attemptedTails.get(key) ?? 0;
    if (attempts > 0 && (attempts !== 1 || previewEnd.newEvidence?.() !== true)) return;
    stopWatching?.(); stopWatching = undefined;
    delete previewEnd.newEvidence; delete previewEnd.result; delete previewEnd.goal;
    attemptedTails.set(key, attempts + 1);
    const abort = new AbortController();
    previewAbort = abort;
    const signal = AbortSignal.any([ctx.signal, abort.signal]);
    // 放到微任务中启动，让本次身体动作先取得控制。前瞻只读当前证据，不用历史候选授权接续。
    const task = Promise.resolve().then(async () => {
      if (signal.aborted || Date.now() >= request.deadline) return;
      const goal = nextWindow({ ...tail });
      const result = await runSearch({ ...base, goal, body: { ...base.body, feet: { ...tail } }, signal,
        ...(heading === undefined ? {} : { corridor: { ...heading, origin: { ...tail }, maxLateral: 0 } }), ...searchWindow() });
      if (signal.aborted) return;
      const extension = result.status === 'FOUND' ? result.transitions
        : currentPrefix(result, goal).usable ? result.prefix!.transitions : [];
      const edges = extension.slice(0, request.maxTransitions - transitions.length);
      if (edges.length > 0 && manual) {
        const residency = await pinTransitions(tail, edges, signal);
        if (signal.aborted) return;
        if (residency.status !== 'ready') previewEnd.residency = residency;
      }
      if (edges.length === 0 || previewEnd.residency !== undefined) {
        previewEnd.result = result;
        previewEnd.goal = goal;
        // 初看无路时，身体可能还有两三步才到前沿。只监听这条出边实际涉及的格；
        // 新鲜度恢复/内容改变时允许同一尾点再查一次，无关观察与同内容刷新都不重播。
        const boundary = result.prefix?.knownBlockerAhead ?? boundaryAfter(result.boundaries, tail, anchorOf(goal));
        if (attempts === 0 && previewEnd.residency === undefined && boundary !== undefined
          && (result.status === 'INSUFFICIENT_EVIDENCE' || result.status === 'NO_PATH_IN_MEMORY')) {
          const revision = (point: Vec3Like) => {
            const cell = voxel.cellAt(scope.dim, point.x, point.y, point.z);
            return cell.observed && cell.evidence.freshness === 'FRESH' && cell.evidence.validUntil >= Date.now()
              && cell.evidence.observation.sessionId === scope.sessionId && cell.evidence.observation.stateComplete ? cell.evidence.revision : undefined;
          };
          const related = boundaryProbeCells(boundary, 32, heading === undefined ? undefined : { ...heading, origin: tail, maxLateral: 0 }).cells;
          const watched = related.map(point => ({ point, before: revision(point) }));
          const keyOf = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
          const keys = new Set(related.map(keyOf));
          previewEnd.newEvidence = () => watched.some(({ point, before }) => {
            const current = revision(point);
            return current !== undefined && current !== before;
          });
          let queued = false;
          stopWatching = voxel.subscribeChanges(report => {
            if (!queued && report.sections.some(section => section.cells.some(cell => keys.has(keyOf(cell.pos))))) {
              queued = true;
              queueMicrotask(() => { queued = false; startPreview(physicalIndex); });
            }
          });
        }
        return;
      }
      strict = result;
      route = result;
      chosen = result.status === 'FOUND' ? result : null;
      tailGoal = goal;
      boundarySummary = summarizeBoundaries(result.boundaries);
      planned.push(...extension);
      transitions.push(...edges);
      truncated = edges.length < extension.length;
    }).catch((cause: unknown) => {
      if (!signal.aborted) previewEnd.error = cause instanceof Error ? cause.message : String(cause);
    }).finally(() => {
      preview = undefined;
      if (!previewClosed && previewEnd.newEvidence?.()) startPreview(physicalIndex);
    });
    preview = task;
  };

  for (const [index, transition] of transitions.entries()) {
    physicalIndex = index;
    if (ctx.signal.aborted) return cancelledHere(index, transition, ctx.adapter.state().pos);
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    const current = ctx.adapter.state();
    const physicalTarget = transition.to;
    const directionalFinish = directionalFinishFor(request, transition);
    // 授权按真实身体起点和将要到达的物理 endpoint 检查；计划点不能代替实测。
    if (lateralOf(current.pos) > corridorLimit || lateralOf(physicalTarget) > corridorLimit) {
      return receipt('lateral_authorization', {
        stopCode: 'lateral_authorization',
        detail: `第 ${index + 1} 段实际横向偏移 ${Math.max(lateralOf(current.pos), lateralOf(physicalTarget)).toFixed(2)} 格，超出授权 ${request.corridor?.maxLateral ?? 0} 格；没有执行这段`,
        failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition,
        ...(route.policy === undefined ? {} : { policy: route.policy }),
      });
    }
    // 身体按已声明的到达精度停下，不会精确等于计划浮点坐标。步行/台阶/下落在这个
    // 范围内复验“实测起点 → 原计划落点”的真实几何；更大偏差仍从实测位置重规划。
    const startDrift = current.pos.x !== transition.from.x || current.pos.y !== transition.from.y || current.pos.z !== transition.from.z;
    const canVerifyResidual = (transition.kind === 'walk' || transition.kind === 'step' || transition.kind === 'drop')
      && feetReached(transition.from, current.pos, current.onGround);
    if (startDrift && !canVerifyResidual) {
      return receipt('replan', {
        stopCode: 'start_drift',
        currentCheck: { status: 'START_DRIFT' },
        detail: `第 ${index + 1} 段计划起点 (${transition.from.x.toFixed(2)},${transition.from.y.toFixed(2)},${transition.from.z.toFixed(2)}) 与实测 (${current.pos.x.toFixed(2)},${current.pos.y.toFixed(2)},${current.pos.z.toFixed(2)}) 不一致；原计划几何不再适用，按实测位置重规划原目标`,
        stepIndex: index, transition,
      });
    }
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在动作前耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    // 只对这一次动作做有界当前证据复验（支撑、扫掠、头部空间与现有风险约束）。
    const verification = verifyLandRoute(voxel, { ...currentRequest, measuredStart: current.pos }, [transition], Date.now());
    const check = verification.transitions[0]!;
    if (check.status !== 'OPEN') {
      return refusal(index, transition, check, current);
    }
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出身体控制前耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    startPreview(index);
    let actionError: unknown = null;
    let continuous = false;
    if (transition.kind === 'jump') {
      const remaining = request.deadline - Date.now();
      if (remaining < 1) {
        return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出跳跃控制前耗尽：已执行 ${executed}/${planned.length} 段` });
      }
      try {
        await ctx.adapter.moveTo(
          { kind: 'feet', x: transition.to.x, y: transition.to.y, z: transition.to.z },
          {
            signal: ctx.signal,
            timeoutMs: Math.min(6000, Math.floor(remaining)),
            horizontalJump: true,
            ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
          },
        );
      } catch (error) {
        if (isAbort(error)) return cancelledHere(index, transition, current.pos);
        actionError = error;
      }
    } else if (transition.kind === 'ladder') {
      // Ladder body control uses the explicit xyz target and requires the
      // measured start/endpoint to be cell-centered; a continuous offset would
      // be silently moved by the cell-centered adapter and is not executable.
      if (!centeredXZ(current.pos) || !centeredXZ(transition.to)) {
        return receipt('unsupported', {
          stopCode: 'unsupported_ladder_endpoint',
          detail: `第 ${index + 1} 段是梯子过渡，但实测起点或计划 endpoint 不是格心；现有梯子身体控制只接受格心列，未执行`,
          failureCode: 'BAD_ARGS', stepIndex: index, transition,
        });
      }
      const remaining = request.deadline - Date.now();
      if (remaining < 1) {
        return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出梯子控制前耗尽：已执行 ${executed}/${planned.length} 段` });
      }
      try {
        await ctx.adapter.moveTo(
          { kind: 'ladder', x: Math.floor(transition.to.x), y: transition.to.y, z: Math.floor(transition.to.z) },
          {
            signal: ctx.signal,
            timeoutMs: Math.min(6000, Math.floor(remaining)),
            ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
          },
        );
      } catch (error) {
        if (isAbort(error)) return cancelledHere(index, transition, current.pos);
        actionError = error;
      }
    } else {
      const drop = current.pos.y - transition.to.y;
      if (transition.kind === 'drop' && transition.drop > 1) {
        // 保留原多格下落的保守生命余量条件；路线几何已用当前实测起点复验。
        const estimatedDamageUpperBound = Math.ceil(drop) + 2;
        if (!Number.isFinite(current.hp) || current.hp - estimatedDamageUpperBound < 4) {
          return receipt('physical_failure', {
            stopCode: 'step_failed', failureCode: 'LOW_HP', stepIndex: index, transition,
            detail: `当前生命 ${current.hp} 不足以保守承受这次约 ${drop.toFixed(1)} 格落差并保留余量`,
          });
        }
      }
      const remaining = request.deadline - Date.now();
      if (remaining < 1) {
        return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出身体控制前耗尽：已执行 ${executed}/${planned.length} 段` });
      }
      const next = transitions[index + 1];
      // 已证实的同向 walk/step/小落差链保留中间速度；转向、大落差、边界和末点仍停车。
      // <=0.6 的地面小落差仍由身体控制落边制动，真实落地到位后才交接。
      // 前视用下一段计划几何，交接时仍会以上方实测起点再次复验，不能跳过未知格。
      continuous = ctx.adapter.settleMovement !== undefined && next !== undefined
        && !directionalFinish
        && [transition, next].every(edge => edge.kind === 'walk' || edge.kind === 'step' || edge.kind === 'drop' && edge.drop <= 0.6)
        && (transition.kind !== 'drop' || drop <= 0.6)
        && transition.to.x - transition.from.x === next.to.x - next.from.x
        && transition.to.z - transition.from.z === next.to.z - next.from.z
        && (request.nextWindow !== undefined && request.goalMetric === 'horizontal' || !goalReached(request.goal, transition.to, true))
        && verifyLandRoute(voxel, currentRequest, [next], Date.now()).transitions[0]?.status === 'OPEN';
      try {
        execution.handedOver ||= continuous;
        await ctx.adapter.moveTo(
          { kind: 'feet', x: transition.to.x, y: transition.to.y, z: transition.to.z },
          {
            signal: ctx.signal,
            // 不能把剩余 50ms 扩成 1s；向下取整后不超过原 deadline。
            timeoutMs: Math.min(6000, Math.floor(remaining)),
            ...(continuous ? { settleAtTarget: false } : {}),
            ...(transition.kind === 'drop' && drop > 1 ? { maxDropDown: Math.ceil(drop) } : {}),
            ...(request.corridor === undefined ? {} : { corridor: directionalFinish ? { ...request.corridor, minimumAlong: request.minimumAlong } : request.corridor }),
          },
        );
        execution.handedOver = continuous;
      } catch (error) {
        if (isAbort(error)) return cancelledHere(index, transition, current.pos);
        actionError = error;
      }
    }

    if (actionError !== null) {
      const stopped = { ...ctx.adapter.state().pos };
      const atTarget = transitionReached(request, transition, stopped, ctx.adapter.state().onGround);
      const partial = {
        from: { ...current.pos }, to: stopped,
        horizontal: Math.hypot(stopped.x - current.pos.x, stopped.z - current.pos.z),
        vertical: Math.abs(stopped.y - current.pos.y),
        atTarget,
      };
      if (partial.atTarget) {
        // 动作报失败但实测身体已经连续到位：按实测确认这段，保留进展；段仍以失败结束。
        executed += 1;
        const path = partial.horizontal + partial.vertical;
        confirmed.push({
          transition, measuredFrom: partial.from, measuredTo: partial.to,
          measuredHorizontal: partial.horizontal, measuredVertical: partial.vertical, pathLength: path,
        });
        pathLength += path;
      }
      const code = codeFromError(actionError);
      if (lateralOf(stopped) > corridorLimit) {
        return {
          ...receipt('lateral_authorization', {
            stopCode: 'lateral_authorization',
            partialDisplacement: partial,
            detail: `第 ${index + 1} 段在实测横向 ${lateralOf(stopped).toFixed(2)} 格处停下，超出授权 ${request.corridor?.maxLateral ?? 0} 格；不再发出后续动作`,
            failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition,
            nested: { code, summary: (actionError as Error).message },
          }),
          measuredEnd: stopped,
        };
      }
      if (continuous && actionError instanceof Error && 'code' in actionError && actionError.code === 'CHECKPOINT_PASSED') {
        return receipt('replan', { stopCode: 'checkpoint_passed', detail: actionError.message,
          partialDisplacement: partial, stepIndex: index, transition, measuredEnd: stopped });
      }
      return {
        ...receipt('physical_failure', {
          stopCode: 'step_failed',
          partialDisplacement: partial,
          detail: `第 ${index + 1} 段 ${transition.kind} 停下：${(actionError as Error).message}${partial.horizontal > 0.05 || partial.vertical > 0.05 ? `；实测已发生水平 ${partial.horizontal.toFixed(2)} / 垂直 ${partial.vertical.toFixed(2)} 格位移，位置保留` : ''}`,
          nested: { code, summary: (actionError as Error).message },
          stepIndex: index, transition, failureCode: code,
        }),
        measuredEnd: stopped,
      };
    }

    const arrived = ctx.adapter.state();
    // 所有地面 transition 都必须在原计划连续端点落稳，格内位置不能顶替它。
    const reached = transitionReached(request, transition, arrived.pos, arrived.onGround);
    if (!reached) {
      return {
        ...receipt('physical_failure', {
          stopCode: 'effect_not_confirmed',
          partialDisplacement: {
            from: { ...current.pos }, to: { ...arrived.pos },
            horizontal: Math.hypot(arrived.pos.x - current.pos.x, arrived.pos.z - current.pos.z),
            vertical: Math.abs(arrived.pos.y - current.pos.y), atTarget: false,
          },
          detail: `第 ${index + 1} 段动作报成功，但实际脚位 (${arrived.pos.x.toFixed(2)},${arrived.pos.y.toFixed(2)},${arrived.pos.z.toFixed(2)}) 不在 ${transition.kind} 端点的声明精度内（Promise/计划点不能代替实测）`,
          failureCode: 'EFFECT_NOT_CONFIRMED', stepIndex: index, transition,
        }),
        measuredEnd: { ...arrived.pos },
      };
    }
    executed += 1;
    confirmed.push({
      transition,
      measuredFrom: { ...current.pos },
      measuredTo: { ...arrived.pos },
      measuredHorizontal: Math.hypot(arrived.pos.x - current.pos.x, arrived.pos.z - current.pos.z),
      measuredVertical: Math.abs(arrived.pos.y - current.pos.y),
      pathLength: Math.hypot(arrived.pos.x - current.pos.x, arrived.pos.z - current.pos.z) + Math.abs(arrived.pos.y - current.pos.y),
    });
    pathLength += confirmed.at(-1)!.pathLength;
    last = arrived;
    // 到达精度不是横向授权：实测停点越界时保留这次实测进展，但不再发下一段动作。
    if (lateralOf(arrived.pos) > corridorLimit) {
      return {
        ...receipt('lateral_authorization', {
          stopCode: 'lateral_authorization',
          detail: `第 ${index + 1} 段实测停在横向 ${lateralOf(arrived.pos).toFixed(2)} 格，超出授权 ${request.corridor?.maxLateral ?? 0} 格；确认位移保留，不再发出后续动作`,
          failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition,
        }),
        measuredEnd: { ...arrived.pos },
      };
    }
    // 与既有导航回执一致：每确认一步就上报进度并让出事件循环。
    ctx.progress(executed / Math.max(1, planned.length), `segment ${executed}/${planned.length}`);
    const sighting = request.checkSighting?.();
    if (sighting !== undefined) return receipt('sighting', { stopCode: 'sighting', detail: sighting });
    if (directionalFinish) return receipt('reached_waypoint', { arrived: true, detail: `已执行 ${executed} 段，实测停点达到冻结方向的 ${request.minimumAlong} 格距离` });
    if (request.goal.arrival !== undefined && goalReached(request.goal, arrived.pos, arrived.onGround)) {
      return receipt('reached_waypoint', { arrived: true, detail: `已执行 ${executed} 段，实测停点满足原目标的到达范围` });
    }
    // 下一窗口来不及在末步发出前完成时，这一步已经按完整停稳执行，可在这里等待有界搜索。
    if (index + 1 === transitions.length && preview !== undefined) await preview;
  }

  if (ctx.signal.aborted) return receipt('cancelled', { stopCode: 'cancelled', detail: '后续窗口规划或移动已取消，保留已确认位移' });
  if (previewEnd.error !== undefined) {
    return receipt('unsupported', { stopCode: 'search_failed', failureCode: 'ERROR', detail: `后续窗口搜索失败：${previewEnd.error}` });
  }
  if (previewEnd.result !== undefined && previewEnd.goal !== undefined) {
    const next = previewEnd.result;
    const facts = { search: next, searchStatus: next.status, searchReason: next.reason, boundarySummary: summarizeBoundaries(next.boundaries),
      ...(next.budget === undefined ? {} : { budget: next.budget }), ...(next.unavailableSections.length ? { unavailableSections: next.unavailableSections } : {}) };
    if (previewEnd.residency !== undefined) return receipt('residency_not_ready', { ...facts, stopCode: 'residency_gap',
      unavailableSections: previewEnd.residency.sections, detail: `后续路线依赖未驻留：${previewEnd.residency.message}` });
    const blocker = next.prefix?.knownBlockerAhead;
    if (heading !== undefined && heading.maxLateral > 0 && (blocker !== undefined || next.status === 'NO_PATH_IN_MEMORY')) {
      return receipt('replan', { ...facts, stopCode: 'straight_boundary', detail: '前方直线遇到阻挡，从实测停点重新检查已授权横向走廊' });
    }
    if (blocker?.status === 'BLOCKED') return receipt('blocked', { ...facts, blockerAhead: blocker, stopCode: 'blocker', detail: blocker.reason });
    const boundary = boundaryAfter(next.boundaries, last.pos, anchorOf(previewEnd.goal));
    return receipt(outcomeOfStatus(next.status), { ...facts, stopCode: 'window_boundary', detail: statusDetail(next),
      ...(boundary === undefined ? {} : { boundary }) });
  }
  if (truncated) {
    return receipt('partial_prefix', { stopCode: 'max_steps', detail: `分段上限 ${request.maxTransitions} 用尽，还剩 ${planned.length - executed} 段` });
  }
  if (chosen === null) {
    if (strict.prefix?.atTarget === true) {
      return receipt('reached_waypoint', { arrived: true, detail: `已走完当前证据前缀，实测终点就是解析目标 ${JSON.stringify(cell(strict.target))}` });
    }
    const boundary = boundaryAfter(strict.boundaries, last.pos, anchorOf(tailGoal));
    const tailBlocker = strict.prefix?.knownBlockerAhead;
    if (tailBlocker?.status === 'BLOCKED' && request.goal.arrival !== undefined) {
      return receipt('blocked', { stopCode: 'blocker', blockerAhead: tailBlocker,
        detail: `已实际走完 ${executed} 段可通行前缀，端点的一条出边受阻（${tailBlocker.reason}）` });
    }
    return receipt('unknown_boundary', {
      stopCode: 'prefix_boundary',
      detail: `已走完当前证据前缀 ${executed} 段，终点可通行性仍未知`,
      ...(boundary === undefined ? {} : { boundary }),
      ...(tailBlocker === undefined ? {} : { blockerAhead: tailBlocker }),
    });
  }
  return receipt('reached_waypoint', {
    arrived: true,
    detail: `已沿${route.evidenceMode === 'historical' ? '历史体素候选（逐步实测确认）' : '当前证据路线'}走完 ${executed} 段`,
  });
}

function directDropCancelled(
  search: LandSearchResult, request: SegmentRequest, start: Vec3Like, dropStart: Vec3Like,
  end: Vec3Like, onGround: boolean, transition: LandSearchTransition, searches: number, detail: string,
): SegmentReceipt {
  const measuredHorizontal = Math.hypot(end.x - dropStart.x, end.z - dropStart.z);
  const measuredVertical = Math.abs(end.y - dropStart.y);
  // descend_to 按目标格心落地，计划 transition 的 to 是该格坐标；取消后仍要用
  // 与直接下落成功路径相同的“实测脚在目标格且着地”谓词验收。
  const atTarget = cellReached(transition.to, end, onGround);
  return {
    waypoint: { ...request.goal.requested }, outcome: 'cancelled', measuredStart: { ...start }, measuredEnd: { ...end },
    chosen: null, search, searchStatus: search.status, searchReason: search.reason, evidenceMode: 'current', searches,
    planned: [transition],
    confirmed: atTarget
      ? [{ transition, measuredFrom: { ...dropStart }, measuredTo: { ...end }, measuredHorizontal, measuredVertical, pathLength: transition.drop }]
      : [],
    remaining: atTarget ? [] : [transition],
    pathLength: atTarget ? transition.drop : 0,
    arrived: false, directDrop: true,
    boundarySummary: summarizeBoundaries(search.boundaries),
    partialDisplacement: {
      from: { ...dropStart }, to: { ...end },
      horizontal: measuredHorizontal, vertical: measuredVertical, atTarget,
    },
    stepIndex: 0,
    stopCode: 'cancelled', detail,
    ...(search.budget === undefined ? {} : { budget: search.budget }),
    ...(search.unavailableSections.length === 0 ? {} : { unavailableSections: search.unavailableSections }),
  };
}

function cancelledReceipt(
  search: LandSearchResult, request: SegmentRequest, end: Vec3Like, searches: number, start?: Vec3Like,
): SegmentReceipt {
  return {
    waypoint: { ...request.goal.requested }, outcome: 'cancelled', measuredStart: start ?? { ...end }, measuredEnd: { ...end },
    chosen: null, search, searchStatus: search.status, searchReason: search.reason, evidenceMode: search.evidenceMode, searches,
    planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
    boundarySummary: summarizeBoundaries(search.boundaries),
    ...(search.budget === undefined ? {} : { budget: search.budget }),
    ...(search.unavailableSections.length === 0 ? {} : { unavailableSections: search.unavailableSections }),
    detail: '搜索被取消，没有移动',
  };
}

export { KINDS as SEGMENT_KINDS };
