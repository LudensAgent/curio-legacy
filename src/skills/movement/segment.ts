import { type AgentState, type Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import {
  searchLandRouteAsync, summarizeBoundaries, verifyLandRoute,
  type LandSearchBoundary, type LandSearchBoundarySummary, type LandSearchBudget,
  type LandSearchResult, type LandSearchStatus, type LandSearchTransition, type SectionKey,
} from '../../spatial/land-search.ts';
import type { LandSearchPolicySummary } from 'curio-minecraft-3d-memory/navigation';
import { feetCell } from '../../perception/local.ts';
import { codeFromError, isAbort, runSkill, validateSkill, type FailureCode, type SkillCtx, type SkillResult } from '../types.ts';
import { anchorOf, cellReached, feetReached } from './goal.ts';
import type { NavigationGoal } from './goal.ts';
import type { PrimitiveProblemKind } from './receipt.ts';
import { descendTo } from './descend.ts';
import type { MoveMode } from './session.ts';

/**
 * 单段执行器：只完成“一次搜索 + 一段前缀/路线”，持有跨段 session 的协调循环不在这里。
 * 搜索由库的有界 A* 提供；执行按 transition 的连续脚位使用身体控制完成，
 * 不把格心化动作冒充为精确 transition。不换目标、不施工、不做观察后重搜。
 */

export type SegmentOutcome =
  | 'reached_waypoint'
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
  | 'replan'
  | 'cancelled'
  | 'timeout';

export type SegmentRequest = {
  /** 本段冻结目标；格目标与连续脚位的完成语义不同。 */
  goal: NavigationGoal;
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
  /** 当前证据的严格搜索结果；边界与统计事实始终指向它。 */
  search: LandSearchResult;
  /** 严格搜索的终态，保留 INSUFFICIENT_EVIDENCE/NO_PATH_IN_MEMORY/UNSUPPORTED/INVALIDATED 的区别。 */
  searchStatus: LandSearchStatus;
  searchReason: string;
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

const KINDS: readonly MoveMode[] = ['walk', 'step', 'drop'];
const OBSERVATION_RESOLVABLE = new Set(['UNKNOWN', 'STALE', 'INCOMPLETE']);

const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
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

const BLOCKING_PROBLEMS = new Set<PrimitiveProblemKind>([
  'TARGET_BLOCKED', 'HEAD_BLOCKED', 'UNSUPPORTED_STEP_HEIGHT', 'TARGET_LIQUID',
  'UNSUPPORTED_ENVIRONMENT', 'NOT_ADJACENT',
]);

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
 */
export async function runNavigationSegment(ctx: SkillCtx, request: SegmentRequest): Promise<SegmentReceipt> {
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
  const base = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
    goal: request.goal, allowed: request.allowed, maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
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
  const strict = await searchLandRouteAsync(voxel, { ...base, ...searchWindow() });
  searches += 1;
  if (strict.status === 'CANCELLED') {
    return cancelledReceipt(strict, request, start, searches);
  }
  let chosen: LandSearchResult | null = strict.status === 'FOUND' ? strict : null;
  let historical: LandSearchResult | null = null;
  // 当前证据已有可执行前缀时先走前缀，不再为“完整历史路线”消耗一次长搜索；
  // 前缀走到边界后由 Coordinator 观察/重搜。历史候选只在前缀不可用时兜底。
  const currentPrefixUsable = strict.prefix !== undefined
    && strict.prefix.transitions.length > 0
    && strict.prefix.knownBlockerAhead === undefined;
  if (chosen === null && !currentPrefixUsable && request.historical && request.searchBudget - searches > 0) {
    historical = await searchLandRouteAsync(voxel, { ...base, evidenceMode: 'remembered', ...searchWindow() });
    searches += 1;
    if (historical.status === 'CANCELLED') return cancelledReceipt(historical, request, start, searches);
    if (historical.status === 'FOUND') chosen = historical;
  }
  const boundarySummary = summarizeBoundaries(strict.boundaries);

  // 1×1 平台/柱顶没有普通 A* 路线：格目标、明确允许 drop 且目标就在相邻列时，直接尝试一次 descend_to。
  // 连续精确脚位不走这条格心化回退，避免把附近格冒充原目标。
  if (chosen === null && request.goal.kind === 'cell') {
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

  // 2. 没有完整路线：只有“证据缺口”前缀值得先走过去观察；朝目标方向已观测
  // BLOCKED/UNSUPPORTED 时前进不会带来新证据，交回前缀端点 + blocker。
  const reachable = strict.prefix;
  const blockerAhead = reachable?.knownBlockerAhead;
  if (chosen === null && (reachable === undefined || reachable.transitions.length === 0 || blockerAhead !== undefined)) {
    // 历史几何搜索的预算耗尽是真实终态，不能被 strict 的“证据不足”覆盖成普通未知边界。
    const historicalBudget = blockerAhead === undefined && chosen === null && historical?.status === 'BUDGET_EXHAUSTED'
      ? historical : null;
    // 直接阻挡/不支持与“整个授权走廊内没有路”、“已存几何无路”、“证据不足”分开，不互相顶替。
    const outcome: SegmentOutcome = blockerAhead?.status === 'BLOCKED' ? 'blocked'
      : blockerAhead?.status === 'UNSUPPORTED' ? 'unsupported'
        : strict.corridorLimited === true ? 'corridor_exhausted'
          : historicalBudget !== null ? 'search_budget'
            : outcomeOfStatus(strict.status);
    const blockedBoundary = blockerAhead ?? boundaryAfter(strict.boundaries, reachable?.endpoint ?? state.pos, anchorOf(request.goal));
    return {
      waypoint, outcome, stopCode: blockerAhead === undefined ? 'no_route' : 'blocker', measuredStart: start, measuredEnd: start,
      chosen: null, search: strict, searchStatus: strict.status, searchReason: strict.reason,
      evidenceMode: 'current', searches,
      planned: reachable?.transitions ?? [], confirmed: [], remaining: reachable?.transitions ?? [],
      pathLength: 0, arrived: false, directDrop: false, boundarySummary,
      ...(historicalBudget?.budget !== undefined ? { budget: historicalBudget.budget }
        : strict.budget === undefined ? {} : { budget: strict.budget }),
      ...(historicalBudget !== null && historicalBudget.unavailableSections.length > 0
        ? { unavailableSections: historicalBudget.unavailableSections }
        : strict.unavailableSections.length === 0 ? {} : { unavailableSections: strict.unavailableSections }),
      ...(strict.policy === undefined ? {} : { policy: strict.policy }),
      ...(blockerAhead === undefined ? {} : { blockerAhead }),
      ...(outcome === 'unknown_boundary' && blockedBoundary !== undefined ? { boundary: blockedBoundary } : {}),
      detail: blockerAhead !== undefined
        ? `朝目标方向的边界已是 ${blockerAhead.status}${blockerAhead.reason === undefined ? '' : `（${blockerAhead.reason}）`}`
        : strict.corridorLimited === true
          ? `授权横向走廊（±${request.corridor?.maxLateral ?? 0} 格）内没有 walk/step/drop 路线；外侧绕行未授权`
          : historicalBudget !== null
            ? `历史体素搜索预算耗尽（${historicalBudget.budget ?? 'unknown'}）：${historicalBudget.reason}`
            : statusDetail(strict),
    };
  }

  const prefixOnly = chosen === null;
  const route = chosen ?? strict;
  const planned = chosen === null ? (reachable?.transitions ?? []) : chosen.transitions;
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
  const truncated = transitions.length < planned.length;
  const confirmed: TransitionReceipt[] = [];
  let pathLength = 0;
  let last: AgentState = state;
  let executed = 0;
  const receipt = (outcome: SegmentOutcome, extra: Partial<SegmentReceipt> = {}): SegmentReceipt => {
    const end = { ...ctx.adapter.state().pos };
    return {
      waypoint, outcome, measuredStart: start, measuredEnd: end,
      chosen, search: strict, searchStatus: strict.status, searchReason: strict.reason,
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
  const cancelledHere = (index: number, transition: LandSearchTransition, from: Vec3Like): SegmentReceipt => {
    const stoppedState = ctx.adapter.state();
    const stopped = { ...stoppedState.pos };
    // 与普通失败分支同一套“实测端点”谓词：取消发生在身体已经到位之后时，
    // 这段是真实完成的进展，不能因为取消就把已确认的 transition 丢掉。
    const atTarget = transition.kind === 'drop' && transition.drop > 1
      ? cellReached(transition.to, stopped, stoppedState.onGround)
      : feetReached(transition.to, stopped, stoppedState.onGround);
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

  for (const [index, transition] of transitions.entries()) {
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    const current = ctx.adapter.state();
    const physicalTarget = transition.kind === 'drop' && transition.drop > 1
      ? { x: Math.floor(transition.to.x) + 0.5, y: transition.to.y, z: Math.floor(transition.to.z) + 0.5 }
      : transition.to;
    // 授权按真实身体起点和将要到达的物理 endpoint 检查；计划点不能代替实测。
    if (lateralOf(current.pos) > corridorLimit || lateralOf(physicalTarget) > corridorLimit) {
      return receipt('lateral_authorization', {
        stopCode: 'lateral_authorization',
        detail: `第 ${index + 1} 段实际横向偏移 ${Math.max(lateralOf(current.pos), lateralOf(physicalTarget)).toFixed(2)} 格，超出授权 ${request.corridor?.maxLateral ?? 0} 格；没有执行这段`,
        failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition,
        ...(route.policy === undefined ? {} : { policy: route.policy }),
      });
    }
    // 旧计划只在实测起点与计划 from 完全一致时才有几何意义；有偏差就交回 Coordinator
    // 按冻结目标从实测位置重新规划，不用单位步判定器证明另一条运动。
    if (current.pos.x !== transition.from.x || current.pos.y !== transition.from.y || current.pos.z !== transition.from.z) {
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
    const verification = verifyLandRoute(voxel, currentRequest, [{ ...transition, from: { ...current.pos } }], Date.now());
    const check = verification.transitions[0]!;
    if (check.status !== 'OPEN') {
      return refusal(index, transition, check, current);
    }
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出身体控制前耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    let step: SkillResult | null = null;
    let actionError: unknown = null;
    if (transition.kind === 'drop' && transition.drop > 1 && request.goal.kind === 'feet') {
      // 连续精确目标不能被多格下落的格心落点执行；前面已确认的段保留。
      return receipt('unsupported', {
        stopCode: 'unsupported_drop_endpoint',
        detail: `第 ${index + 1} 段是 ${transition.drop.toFixed(2)} 格下落，现有 descend_to 只按目标格心落地，不能保证精确连续 endpoint；没有执行这段`,
        failureCode: 'BAD_ARGS', stepIndex: index, transition,
      });
    }
    if (transition.kind === 'drop' && transition.drop > 1) {
      // descend_to 只按目标格心落地；只有计划 endpoint 就是该格心时，单步复验才证明了
      // 实际将要发生的下落。非格心起点不能靠格心落点冒充连续 endpoint。
      const centered = Math.abs(transition.to.x - (Math.floor(transition.to.x) + 0.5)) <= 1e-9
        && Math.abs(transition.to.z - (Math.floor(transition.to.z) + 0.5)) <= 1e-9;
      if (!centered) {
        return receipt('unsupported', {
          stopCode: 'unsupported_centered_drop',
          detail: `第 ${index + 1} 段是多格下落，但计划 endpoint 不是目标格心；descend_to 的格心落点无法被连续复验，未执行`,
          failureCode: 'BAD_ARGS', stepIndex: index, transition,
        });
      }
      const to = cell(transition.to);
      const validated = validateSkill(descendTo, {
        target: { x: to.x, y: transition.to.y, z: to.z },
        ...(request.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
      }, ctx.adapter);
      if (!validated.ok) {
        return receipt('unsupported', { stopCode: 'invalid_step', detail: `descend_to 参数无效：${validated.error}`, failureCode: 'BAD_ARGS', stepIndex: index, transition });
      }
      // nested 动作也必须遵守本段的绝对期限，不能沿用更宽的 ctx.deadline。
      const nestedCtx = { ...ctx, deadline: Math.min(ctx.deadline, request.deadline) };
      try {
        step = await runSkill(nestedCtx, descendTo, validated.args);
      } catch (error) {
        if (!isAbort(error)) throw error;
        return cancelledHere(index, transition, current.pos);
      }
    } else {
      const remaining = request.deadline - Date.now();
      if (remaining < 1) {
        return receipt('timeout', { stopCode: 'deadline', detail: `执行期限在发出身体控制前耗尽：已执行 ${executed}/${planned.length} 段` });
      }
      try {
        await ctx.adapter.moveTo(
          { kind: 'feet', x: transition.to.x, y: transition.to.y, z: transition.to.z },
          {
            signal: ctx.signal,
            // 不能把剩余 50ms 扩成 1s；向下取整后不超过原 deadline。
            timeoutMs: Math.min(6000, Math.floor(remaining)),
            allowTerrainChanges: false,
            ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
          },
        );
      } catch (error) {
        if (isAbort(error)) return cancelledHere(index, transition, current.pos);
        actionError = error;
      }
    }

    if (actionError !== null) {
      const stopped = { ...ctx.adapter.state().pos };
      const atTarget = feetReached(transition.to, stopped, ctx.adapter.state().onGround);
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

    if (step !== null && step.status !== 'succeeded') {
      const stopped = { ...ctx.adapter.state().pos };
      // 多格下落由 descend_to 落到格心：格目标的完成谓词按格验收；连续目标已在上面拒绝。
      const atTarget = transition.kind === 'drop' && transition.drop > 1
        ? cellReached(transition.to, stopped, ctx.adapter.state().onGround)
        : feetReached(transition.to, stopped, ctx.adapter.state().onGround);
      const partial = {
        from: { ...current.pos }, to: stopped,
        horizontal: Math.hypot(stopped.x - current.pos.x, stopped.z - current.pos.z),
        vertical: Math.abs(stopped.y - current.pos.y),
        atTarget,
      };
      if (partial.atTarget) {
        executed += 1;
        const path = partial.horizontal + partial.vertical;
        confirmed.push({
          transition, measuredFrom: partial.from, measuredTo: partial.to,
          measuredHorizontal: partial.horizontal, measuredVertical: partial.vertical, pathLength: path,
        });
        pathLength += path;
      }
      if (step.status === 'cancelled') {
        return {
          ...receipt('cancelled', { stopCode: 'step_failed', detail: step.summary, stepIndex: index, transition, partialDisplacement: partial }),
          measuredEnd: stopped,
        };
      }
      const kind = problemKindOf(step.data);
      const outcome: SegmentOutcome = kind !== undefined && BLOCKING_PROBLEMS.has(kind) ? 'blocked'
        : kind === 'UNKNOWN_GEOMETRY' ? 'unknown_boundary' : 'physical_failure';
      const { local: _local, around: _around, ...nestedData } = (step.data ?? {}) as Record<string, unknown>;
      if (lateralOf(stopped) > corridorLimit) {
        return {
          ...receipt('lateral_authorization', {
            stopCode: 'lateral_authorization',
            partialDisplacement: partial,
            detail: `第 ${index + 1} 段在实测横向 ${lateralOf(stopped).toFixed(2)} 格处停下，超出授权 ${request.corridor?.maxLateral ?? 0} 格；不再发出后续动作`,
            nested: { code: step.failureCode ?? 'ERROR', summary: step.summary, data: nestedData },
            stepIndex: index, transition, failureCode: 'PATH_NOT_FOUND',
          }),
          measuredEnd: stopped,
        };
      }
      return {
        ...receipt(outcome, {
          stopCode: 'step_failed',
          partialDisplacement: partial,
          detail: `第 ${index + 1} 段 ${transition.kind} 停下：${step.summary}${partial.horizontal > 0.05 || partial.vertical > 0.05 ? `；实测已发生水平 ${partial.horizontal.toFixed(2)} / 垂直 ${partial.vertical.toFixed(2)} 格位移，位置保留` : ''}`,
          nested: { code: step.failureCode ?? 'ERROR', summary: step.summary, data: nestedData },
          stepIndex: index, transition,
          ...(step.failureCode === undefined ? {} : { failureCode: step.failureCode }),
          ...(kind === undefined ? {} : { problemKind: kind }),
          ...(kind === 'TARGET_BLOCKED' || kind === 'HEAD_BLOCKED'
            ? {
                blocker: {
                  index, transition, status: 'BLOCKED', problem: kind,
                  ...(step.data?.targetCell === undefined ? { cell: { ...cell(transition.to) } } : { cell: step.data.targetCell as Vec3Like }),
                  ...(step.data?.remediation === undefined ? {} : { remediation: step.data.remediation }),
                },
              }
            : {}),
        }),
        measuredEnd: stopped,
      };
    }

    const arrived = ctx.adapter.state();
    // 多格下落的 descend_to 按格落地；其余 transition 必须连续到位。
    const reached = transition.kind === 'drop' && transition.drop > 1
      ? cellReached(transition.to, arrived.pos, arrived.onGround)
      : feetReached(transition.to, arrived.pos, arrived.onGround);
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
  }

  if (truncated) {
    return receipt('partial_prefix', { stopCode: 'max_steps', detail: `分段上限 ${request.maxTransitions} 用尽，还剩 ${planned.length - executed} 段` });
  }
  if (prefixOnly) {
    if (strict.prefix?.atTarget === true) {
      return receipt('reached_waypoint', { arrived: true, detail: `已走完当前证据前缀，实测终点就是解析目标 ${JSON.stringify(cell(strict.target))}` });
    }
    const boundary = boundaryAfter(strict.boundaries, last.pos, anchorOf(request.goal));
    return receipt('unknown_boundary', {
      stopCode: 'prefix_boundary',
      detail: `已走完当前证据前缀 ${executed} 段，终点可通行性仍未知`,
      ...(boundary === undefined ? {} : { boundary }),
      ...(reachable?.knownBlockerAhead === undefined ? {} : { blockerAhead: reachable.knownBlockerAhead }),
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
  // 与多格下落普通失败分支相同的“实测脚在目标格且着地”谓词验收。
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
