import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRouteAsync, summarizeBoundaries, type LandSearchBoundary, type LandSearchBoundarySummary, type LandSearchResult, type LandSearchTransition } from '../../spatial/land-search.ts';
import { feetCell } from '../../perception/local.ts';
import { isAbort, runSkill, validateSkill, type FailureCode, type SkillCtx, type SkillResult } from '../types.ts';
import type { PrimitiveProblemKind } from './receipt.ts';
import { moveStep } from './primitives.ts';
import { descendTo } from './descend.ts';
import { executionWindow } from './route.ts';
import type { MoveMode } from './session.ts';

/**
 * 单段执行器：只完成“一次搜索 + 一段前缀/路线”，持有跨段 session 的协调循环不在这里。
 * 它把已有 navigate_to 的搜索、历史候选复验、逐 transition 身体动作与实测验收原样搬出来；
 * 不换目标、不施工、不做观察后重搜。
 */

export type SegmentOutcome =
  | 'reached_waypoint'
  | 'partial_prefix'
  | 'unknown_boundary'
  | 'blocked'
  | 'corridor_exhausted'
  | 'lateral_authorization'
  | 'unsupported'
  | 'physical_failure'
  | 'disallowed'
  | 'search_budget'
  | 'cancelled'
  | 'timeout';

export type SegmentRequest = {
  /** 本段中间目标；不是新的移动意图。 */
  to: Vec3Like;
  allowed: MoveMode[];
  historical: boolean;
  /** 本段最多执行多少个已确认 transition。 */
  maxTransitions: number;
  allowUnknownCorridor: boolean;
  /** 当前 invocation 的绝对 deadline。 */
  deadline: number;
  /** 本段还可发起的搜索次数（0 表示不再搜索）。 */
  searchBudget: number;
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
    remediation?: unknown;
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
  stepIndex?: number;
  transition?: LandSearchTransition;
  detail?: string;
}

const KINDS: readonly MoveMode[] = ['walk', 'step', 'drop'];
const SEARCH_CAP_MS = 1500;
const OBSERVATION_RESOLVABLE = new Set(['UNKNOWN', 'STALE', 'INCOMPLETE']);

const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const sameCell = (a: Vec3Like, b: Vec3Like) => a.x === b.x && a.y === b.y && a.z === b.z;

function facingOf(from: Vec3Like, to: Vec3Like): 'N' | 'E' | 'S' | 'W' {
  const dx = to.x - from.x, dz = to.z - from.z;
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N');
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

/**
 * 执行一段。每次动作后都必须读取真实身体状态；计划点、waypoint、Promise resolve 都不能代替实测。
 * 已确认前缀在后续失败时保留，不把整个 segment 归零。
 */
export async function runNavigationSegment(ctx: SkillCtx, request: SegmentRequest): Promise<SegmentReceipt> {
  const spatial = ctx.spatial;
  const state = ctx.adapter.state();
  const start = { ...state.pos };
  if (!spatial?.session?.voxel) {
    return {
      waypoint: { ...request.to }, outcome: 'unsupported', measuredStart: start, measuredEnd: start,
      chosen: null, search: emptySearch(request.to), evidenceMode: 'current', searches: 0,
      planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
      boundarySummary: summarizeBoundaries([]), detail: '没有共享空间 VoxelMap',
    };
  }
  const voxel = spatial.session.voxel;
  const base = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
    to: request.to, maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
    ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
  };
  const lateralOf = (p: Vec3Like): number => request.corridor === undefined
    ? 0
    : Math.abs((p.x - request.corridor.origin.x) * request.corridor.bearing.z - (p.z - request.corridor.origin.z) * request.corridor.bearing.x);
  const corridorLimit = request.corridor === undefined ? Infinity : request.corridor.maxLateral + 0.01;
  const searchDeadline = () => Math.min(request.deadline, Date.now() + SEARCH_CAP_MS);
  let searches = 0;

  if (request.searchBudget < 1) {
    return {
      waypoint: { ...request.to }, outcome: 'search_budget', measuredStart: start, measuredEnd: start,
      chosen: null, search: emptySearch(request.to), evidenceMode: 'current', searches: 0,
      planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
      boundarySummary: summarizeBoundaries([]), detail: '搜索预算已用尽',
    };
  }
  request.onPhase?.('searching');
  const strict = await searchLandRouteAsync(voxel, { ...base, deadlineMs: searchDeadline() });
  searches += 1;
  if (strict.status === 'CANCELLED') {
    return cancelledReceipt(strict, request, start, searches);
  }
  let chosen: LandSearchResult | null = strict.status === 'FOUND' ? strict : null;
  if (chosen === null && request.historical && request.searchBudget - searches > 0) {
    const historical = await searchLandRouteAsync(voxel, { ...base, allowStale: true, deadlineMs: searchDeadline() });
    searches += 1;
    if (historical.status === 'CANCELLED') return cancelledReceipt(historical, request, start, searches);
    if (historical.status === 'FOUND') chosen = historical;
  }
  const boundarySummary = summarizeBoundaries(strict.boundaries);

  // 1×1 平台/柱顶没有普通 A* 路线：明确允许 drop 且目标就在相邻列时，直接尝试一次 descend_to。
  if (chosen === null) {
    const from = feetCell(state.pos);
    const dropTo = { x: Math.floor(request.to.x), y: request.to.y, z: Math.floor(request.to.z) };
    const drop = from.y - dropTo.y;
    if (request.allowed.includes('drop') && Math.abs(dropTo.x - from.x) + Math.abs(dropTo.z - from.z) === 1
      && drop > 0.25 && drop <= 4.01 && lateralOf({ x: dropTo.x + 0.5, y: dropTo.y, z: dropTo.z + 0.5 }) <= corridorLimit) {
      const validated = validateSkill(descendTo, {
        target: { x: dropTo.x, y: dropTo.y, z: dropTo.z },
        ...(request.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
      }, ctx.adapter);
      if (validated.ok) {
        let moved: SkillResult;
        try {
          moved = await runSkill(ctx, descendTo, validated.args);
        } catch (error) {
          if (!isAbort(error)) throw error;
          return cancelledReceipt(strict, request, { ...ctx.adapter.state().pos }, searches, start);
        }
        const end = { ...ctx.adapter.state().pos };
        const transition = { kind: 'drop' as const, from: { ...state.pos }, to: { ...dropTo }, drop };
        if (moved.status === 'succeeded') {
          return {
            waypoint: { ...request.to }, outcome: 'reached_waypoint', measuredStart: start, measuredEnd: end,
            chosen: null, search: strict, evidenceMode: 'current', searches,
            planned: [transition], confirmed: [{
              transition, measuredFrom: start, measuredTo: end,
              measuredHorizontal: Math.hypot(end.x - start.x, end.z - start.z),
              measuredVertical: Math.abs(end.y - start.y), pathLength: drop,
            }],
            remaining: [], pathLength: drop, arrived: true, directDrop: true, boundarySummary,
          };
        }
        if (moved.status === 'cancelled') return cancelledReceipt(strict, request, end, searches, start);
        return {
          waypoint: { ...request.to }, outcome: 'physical_failure', measuredStart: start, measuredEnd: end,
          chosen: null, search: strict, evidenceMode: 'current', searches,
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
    // 直接阻挡（朝目标方向的边界已 BLOCKED）与“整个授权走廊内没有路”分开：
    // 后者可能是绕行超出横向授权，不是前方地形没有替代路线。
    const outcome: SegmentOutcome = blockerAhead !== undefined ? 'blocked'
      : strict.status === 'UNKNOWN' ? 'unknown_boundary'
        : strict.status === 'BUDGET_EXHAUSTED' ? 'search_budget'
          : strict.corridorLimited === true ? 'corridor_exhausted' : 'unsupported';
    const blockedBoundary = blockerAhead ?? boundaryAfter(strict.boundaries, reachable?.endpoint ?? start, request.to);
    return {
      waypoint: { ...request.to }, outcome, stopCode: blockerAhead === undefined ? 'no_route' : 'blocker', measuredStart: start, measuredEnd: start,
      chosen: null, search: strict, evidenceMode: 'current', searches,
      planned: reachable?.transitions ?? [], confirmed: [], remaining: reachable?.transitions ?? [],
      pathLength: 0, arrived: false, directDrop: false, boundarySummary,
      ...(blockerAhead === undefined ? {} : { blockerAhead }),
      ...(outcome === 'unknown_boundary' && blockedBoundary !== undefined ? { boundary: blockedBoundary } : {}),
      detail: blockerAhead !== undefined
        ? `朝目标方向的边界已是 ${blockerAhead.status}${blockerAhead.reason === undefined ? '' : `（${blockerAhead.reason}）`}`
        : strict.corridorLimited === true
          ? `授权横向走廊（±${request.corridor?.maxLateral ?? 0} 格）内没有 walk/step/drop 路线；外侧绕行未授权`
          : strict.status === 'UNKNOWN' ? '当前证据不足（UNKNOWN/STALE）'
            : strict.status === 'BUDGET_EXHAUSTED' ? '搜索预算耗尽' : '已观测地形里没有 walk/step/drop 路线',
    };
  }

  const prefixOnly = chosen === null;
  const route = chosen ?? strict;
  const planned = chosen === null ? (reachable?.transitions ?? []) : chosen.transitions;
  const disallowed = planned.find((transition) => !request.allowed.includes(transition.kind));
  if (disallowed !== undefined) {
    return {
      waypoint: { ...request.to }, outcome: 'disallowed', measuredStart: start, measuredEnd: start,
      chosen: null, search: strict, evidenceMode: 'current', searches,
      planned, confirmed: [], remaining: planned, pathLength: 0, arrived: false, directDrop: false,
      boundarySummary, disallowed, stopCode: 'disallowed_transition',
      detail: `第一段是 ${disallowed.kind}，不在 allowed（${request.allowed.join('、')}）`,
    };
  }

  request.onPhase?.('executing');
  const { blocker, limit } = executionWindow(prefixOnly ? undefined : route.verification, request.maxTransitions, planned.length);
  const transitions = planned.slice(0, limit);
  const truncated = transitions.length < planned.length;
  const confirmed: TransitionReceipt[] = [];
  let pathLength = 0;
  let last: AgentState = state;
  let executed = 0;
  const receipt = (outcome: SegmentOutcome, extra: Partial<SegmentReceipt> = {}): SegmentReceipt => {
    const end = { ...ctx.adapter.state().pos };
    return {
      waypoint: { ...request.to }, outcome, measuredStart: start, measuredEnd: end,
      chosen, search: strict, evidenceMode: route.evidenceMode, searches,
      planned, confirmed, remaining: planned.slice(executed), pathLength,
      arrived: false, directDrop: false, boundarySummary,
      ...extra,
    };
  };

  for (const [index, transition] of transitions.entries()) {
    if (Date.now() >= request.deadline) {
      return receipt('timeout', { stopCode: 'deadline', detail: `执行期限耗尽：已执行 ${executed}/${planned.length} 段` });
    }
    const current = ctx.adapter.state();
    const from = cell(transition.from);
    // 每个 transition 都复核横向授权；搜索已过滤，这里是执行前的最后一道闸。
    if (lateralOf(transition.from) > corridorLimit || lateralOf(transition.to) > corridorLimit) {
      return receipt('lateral_authorization', {
        stopCode: 'lateral_authorization',
        detail: `第 ${index + 1} 段 ${transition.kind} 会横向偏移 ${Math.max(lateralOf(transition.from), lateralOf(transition.to)).toFixed(2)} 格，超出授权 ${request.corridor?.maxLateral ?? 0} 格；没有执行这段`,
        failureCode: 'PATH_NOT_FOUND', stepIndex: index, transition,
      });
    }
    if (!sameCell(cell(feetCell(current.pos)), cell({ ...transition.from, y: current.pos.y }))) {
      return receipt('physical_failure', {
        stopCode: 'start_drift',
        detail: `起点漂移：第 ${index + 1} 段应在 ${JSON.stringify(from)}，实际脚下在 ${JSON.stringify(feetCell(current.pos))}`,
        failureCode: 'EFFECT_NOT_CONFIRMED', stepIndex: index, transition,
      });
    }
    const to = cell(transition.to);
    let step: SkillResult;
    if (transition.kind === 'drop' && transition.drop > 1) {
      const validated = validateSkill(descendTo, {
        target: { x: to.x, y: transition.to.y, z: to.z },
        ...(request.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
      }, ctx.adapter);
      if (!validated.ok) {
        return receipt('unsupported', { stopCode: 'invalid_step', detail: `descend_to 参数无效：${validated.error}`, failureCode: 'BAD_ARGS', stepIndex: index, transition });
      }
      try {
        step = await runSkill(ctx, descendTo, validated.args);
      } catch (error) {
        if (!isAbort(error)) throw error;
        return { ...receipt('cancelled', { stopCode: 'cancelled', detail: '父任务取消；已确认前缀保留', stepIndex: index, transition }), measuredEnd: { ...ctx.adapter.state().pos } };
      }
    } else {
      const validated = validateSkill(moveStep, {
        xyz: [to.x, transition.to.y, to.z], facing: facingOf(from, to),
      }, ctx.adapter);
      if (!validated.ok) {
        return receipt('unsupported', { stopCode: 'invalid_step', detail: `move_step 参数无效：${validated.error}`, failureCode: 'BAD_ARGS', stepIndex: index, transition });
      }
      try {
        step = await runSkill(ctx, moveStep, validated.args);
      } catch (error) {
        if (!isAbort(error)) throw error;
        return { ...receipt('cancelled', { stopCode: 'cancelled', detail: '父任务取消；已确认前缀保留', stepIndex: index, transition }), measuredEnd: { ...ctx.adapter.state().pos } };
      }
    }
    if (step.status !== 'succeeded') {
      const stopped = { ...ctx.adapter.state().pos };
      const partial = {
        from: { ...current.pos }, to: stopped,
        horizontal: Math.hypot(stopped.x - current.pos.x, stopped.z - current.pos.z),
        vertical: Math.abs(stopped.y - current.pos.y),
        atTarget: sameCell(cell(feetCell(stopped)), to) && Math.abs(stopped.y - transition.to.y) <= 0.01,
      };
      if (partial.atTarget) {
        // 动作报失败但实测身体已经在目标格/脚高：按实测确认这段，保留进展；
        // 段仍以失败结束，下一段从真实位置重新规划，不重放旧的起点动作。
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
                  ...(step.data?.targetCell === undefined ? { cell: { ...to } } : { cell: step.data.targetCell as Vec3Like }),
                  ...(step.data?.remediation === undefined ? {} : { remediation: step.data.remediation }),
                },
              }
            : {}),
        }),
        measuredEnd: stopped,
      };
    }
    const arrived = ctx.adapter.state();
    if (!sameCell(cell(feetCell(arrived.pos)), to) || Math.abs(arrived.pos.y - transition.to.y) > 0.01) {
      return {
        ...receipt('physical_failure', {
          stopCode: 'effect_not_confirmed',
          partialDisplacement: {
            from: { ...current.pos }, to: { ...arrived.pos },
            horizontal: Math.hypot(arrived.pos.x - current.pos.x, arrived.pos.z - current.pos.z),
            vertical: Math.abs(arrived.pos.y - current.pos.y), atTarget: false,
          },
          detail: `第 ${index + 1} 段动作报成功，但实际脚下 ${JSON.stringify(feetCell(arrived.pos))} 不是 ${JSON.stringify(to)}（Promise/计划点不能代替实测）`,
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
    // 与既有导航回执一致：每确认一步就上报进度并让出事件循环。
    ctx.progress(executed / Math.max(1, planned.length), `segment ${executed}/${planned.length}`);
  }

  if (blocker !== null && blocker.index < request.maxTransitions) {
    return receipt('blocked', {
      stopCode: 'blocker',
      detail: `第 ${blocker.index + 1} 段当前证据 ${blocker.status}${blocker.reason === undefined ? '' : `（${blocker.reason}）`}`,
      blocker,
      failureCode: 'PATH_NOT_FOUND',
    });
  }
  if (truncated) {
    return receipt('partial_prefix', { stopCode: 'max_steps', detail: `分段上限 ${request.maxTransitions} 用尽，还剩 ${planned.length - executed} 段` });
  }
  if (prefixOnly) {
    if (strict.prefix?.atTarget === true) {
      return receipt('reached_waypoint', { arrived: true, detail: `已走完当前证据前缀，实测终点就是解析目标 ${JSON.stringify(cell(strict.resolvedTarget))}` });
    }
    const boundary = boundaryAfter(strict.boundaries, last.pos, request.to);
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

function emptySearch(to: Vec3Like): LandSearchResult {
  return {
    status: 'NO_PATH', assurance: 'geometry_only', evidenceMode: 'current', executable: false,
    points: [], transitions: [], boundaries: [], cost: 0,
    resolvedTarget: { ...to },
    stats: {
      nodesExpanded: 0, edgesEvaluated: 0, openEdges: 0, blockedEdges: 0, unknownEdges: 0,
      staleEdges: 0, unsupportedEdges: 0, maxNodes: 0, maxEdges: 0, maxSearchMs: 0, durationMs: 0,
      cancelReason: null, corridorSkipped: 0, visitedSections: 0, sectionReads: 0, snapshotCount: 0, cloneCount: 0,
      yieldCount: 0, maxSyncSliceMs: 0,
    },
  };
}

function cancelledReceipt(
  search: LandSearchResult, request: SegmentRequest, end: Vec3Like, searches: number, start?: Vec3Like,
): SegmentReceipt {
  return {
    waypoint: { ...request.to }, outcome: 'cancelled', measuredStart: start ?? { ...end }, measuredEnd: { ...end },
    chosen: null, search, evidenceMode: search.evidenceMode, searches,
    planned: [], confirmed: [], remaining: [], pathLength: 0, arrived: false, directDrop: false,
    boundarySummary: summarizeBoundaries(search.boundaries), detail: '搜索被取消，没有移动',
  };
}

export { KINDS as SEGMENT_KINDS };
