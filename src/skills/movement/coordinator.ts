import { evidenceStale } from 'curio-minecraft-3d-memory';
import type { LandSearchPolicyEdge } from 'curio-minecraft-3d-memory/navigation';
import type { Vec3Like } from '../../adapter/types.ts';
import { hostLandEdgePolicy, hostWadingEdgePolicy, supportCellsUnder, sweptBodyCells } from '../../spatial/land-edge-policy.ts';
import { shortId, sleep } from '../../util.ts';
import { fail, isAbort, ok, runSkill, validateSkill, type FailureCode, type SkillCtx, type SkillResult, type SkillStatus } from '../types.ts';
import { bearingOf, closeReasonOf, progressOf, summaryOf, waypointOf } from './intent.ts';
import { observeBoundary, type ObservationReceipt } from './observation.ts';
import { observedFootY, verifyLandRoute, type LandSearchBoundary } from '../../spatial/land-search.ts';
import { cellGoal, goalFromIntent, stanceFor, type NavigationGoal } from './goal.ts';
import { isClimbableBlockName, walkLandRules } from '../../adapter/land-rules.ts';
import { failureCodeOfMovement, movementFailureOfStop } from './contract.ts';
import { runNavigationSegment, type SegmentReceipt } from './segment.ts';
import { findSwimTarget, waterAhead } from './swim-leg.ts';
import { farthestFrontier } from './frontier.ts';
import { supportTop } from '../../perception/geometry.ts';
import { planMakeWay, type MakeWayOptions, type MakeWayStep } from './make-way.ts';
import { mineCell, moveStep, pillarOne, placeSupport } from './primitives.ts';
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
      && !evidenceStale(view.evidence)
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
  /** 委托显式授权开路：普通路线走不通时，规划并执行挖开/补支撑/原地垫高的路线（见 make-way.ts）。 */
  makeWay?: MakeWayOptions;
  /** 入口支持 dig/place 但本次没授权：走不通时回执写明这一事实，由调用方决定要不要授权。 */
  makeWayAvailable?: boolean;
}

/** 为开路实际做的一次改动：挖开了哪一格（原来是什么），或在哪放了什么。 */
export type MakeWayEdit = { kind: 'dig' | 'place'; pos: Vec3Like; name: string };
/** 一段代为开路的执行：计划几步、实际走了几步、停在哪、为什么停。 */
/** stale：开路计划算完时身体已不在计划起点旁（还在滑动/被推开），这一段没执行，应按实测位置重新规划。 */
export type MakeWayLegReceipt = { from: Vec3Like; to: Vec3Like; planned: number; executed: number; failure?: string; stale?: true };
/** 普通路线以这些原因停下时，授权了开路就先试开路。 */
const MAKE_WAY_STOPS = new Set<StopReason>(['BLOCKED', 'NO_PATH', 'NO_PROGRESS', 'DETOUR_TOO_LARGE', 'TARGET_UNRESOLVED', 'UNKNOWN_BOUNDARY']);
/** 一次调用最多开路几段（每段只做到第一处改动）；总改动数另受 maxEdits 约束。 */
const MAX_MAKE_WAY_LEGS = 64;
/** 所需区段暂时加载不了（存档正在写盘等）时，等这么久再重试，最多这么多次。 */
const RESIDENCY_RETRY_MS = 300, MAX_RESIDENCY_RETRIES = 20;
/** 同一站位、同一相关证据、同一搜索终态最多重搜几次；再多就是搜索/复验矛盾，交回 Agent。 */
const MAX_SAME_EVIDENCE_SEARCHES = 1;

/**
 * 按开路计划逐步执行：每一步先挖开要占的格（mine_cell，只用授权工具或当前手持），再补支撑（place_support）
 * 或原地垫高（pillar_one，只用授权方块），然后迈到下一格（move_step）。每个基础动作照常做自己的安全检查；
 * 任一步失败就停下，把原因交回。改动逐条记入 edits。
 */
async function runMakeWay(
  ctx: SkillCtx, steps: MakeWayStep[], opts: MakeWayOptions, edits: MakeWayEdit[], deadline: number,
  nameAt: (cell: Vec3Like) => string,
  /** 目标格脚下那格的已记录支撑顶面（0–1，如灵魂沙 0.875）；未知为 null，按整格算。 */
  supportTopAt: (cell: Vec3Like) => number | null,
): Promise<MakeWayLegReceipt> {
  const from = { ...ctx.adapter.state().pos };
  // 规划是异步的：算完时身体可能还在滑动或已被推开。第一步的落点不在身边相邻格（或同格）就不执行，交回重规划。
  const first = steps[0];
  if (first !== undefined) {
    const feet = { x: Math.floor(from.x), z: Math.floor(from.z) };
    const reach = Math.abs(first.to.x - feet.x) + Math.abs(first.to.z - feet.z);
    if (first.kind === 'move' ? reach !== 1 : reach !== 0) {
      return { from, to: { ...from }, planned: steps.length, executed: 0, stale: true,
        failure: `规划完成时身体已在 (${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)})，不在开路计划起点旁` };
    }
    // 规划期间身体可能上下移动（滑落、被推开、落到下一格）：只比水平格还不够，
    // 第一步的脚高必须仍在 move_step 的同层/±1 范围内，否则旧计划必然被动作拒绝。
    if (first.kind === 'move') {
      const top = supportTopAt({ x: first.to.x, y: first.to.y - 1, z: first.to.z });
      const footY = top !== null && top > 0 && top <= 1 ? first.to.y - 1 + top : first.to.y;
      const dy = footY - from.y;
      if (dy < -1.01 || dy > 1.01) {
        return { from, to: { ...from }, planned: steps.length, executed: 0, stale: true,
          failure: `规划完成时身体脚高 ${from.y.toFixed(2)}，计划第一步落点脚高 ${footY.toFixed(2)}（相差 ${dy.toFixed(2)} 格）；move_step 只处理同层/±1，旧计划不再适用` };
      }
    } else {
      const footCell = Math.floor(from.y + 0.05);
      if (first.to.y !== footCell + 1) {
        return { from, to: { ...from }, planned: steps.length, executed: 0, stale: true,
          failure: `规划完成时身体脚高 ${from.y.toFixed(2)}（脚下格 ${footCell}），计划原地垫高到 ${first.to.y}；起点高度已变，旧计划不再适用` };
      }
    }
  }
  const run = async (skill: Parameters<typeof validateSkill>[0], raw: Record<string, unknown>) => {
    const validated = validateSkill(skill, raw, ctx.adapter);
    if (!validated.ok) return `${skill.name} 参数被拒：${validated.error}`;
    const result = await runSkill({ ...ctx, deadline }, skill, validated.args);
    return result.status === 'succeeded' ? null : `${skill.name}：${result.summary}`;
  };
  let executed = 0;
  let failure: string | undefined;
  outer: for (const step of steps) {
    if (ctx.signal.aborted || Date.now() >= deadline) { failure = ctx.signal.aborted ? '父任务取消' : '期限已到'; break; }
    for (const cell of step.dig) {
      if (edits.length >= opts.maxEdits) { failure = `开路改动已达上限 ${opts.maxEdits} 次`; break outer; }
      const name = nameAt(cell);
      // 规划时已排除已记录的液体邻格；墙后看不见的邻格是授权 dig 承担的风险，不再按“当前视野没看清”拦。
      failure = await run(mineCell, { xyz: [cell.x, cell.y, cell.z], allowUnknownAdjacent: true, ...(opts.dig?.tool === undefined ? {} : { tool: opts.dig.tool }) }) ?? undefined;
      if (failure !== undefined) break outer;
      edits.push({ kind: 'dig', pos: { ...cell }, name });
    }
    if (step.place !== undefined || step.kind === 'pillar') {
      if (edits.length >= opts.maxEdits) { failure = `开路改动已达上限 ${opts.maxEdits} 次`; break; }
      const item = opts.place!.item;
      failure = (step.kind === 'pillar'
        ? await run(pillarOne, { item })
        : await run(placeSupport, { xyz: [step.place!.x, step.place!.y, step.place!.z], item })) ?? undefined;
      if (failure !== undefined) break;
      const placed = step.kind === 'pillar' ? { x: step.to.x, y: step.to.y - 1, z: step.to.z } : step.place!;
      // 刚放下时视觉可能还没重写这一格：指定了方块就记它，写 any 才读体素。
      edits.push({ kind: 'place', pos: { ...placed }, name: item === 'any' ? nameAt(placed) : item.replace(/^minecraft:/, '') });
    }
    if (step.kind === 'move') {
      // place_support 为看见参照面可能已经挪动身体：已站进目标格列且脚高相符就不再迈；同列不同高说明计划不再适用，交回重规划。
      const now = ctx.adapter.state().pos;
      const inColumn = Math.floor(now.x) === step.to.x && Math.floor(now.z) === step.to.z;
      if (inColumn && Math.abs(now.y - step.to.y) > 0.5) { failure = `身体已在目标格列 (${step.to.x},${step.to.z})，但脚高 ${now.y.toFixed(2)} 与计划 ${step.to.y} 不符`; break; }
      if (!inColumn) {
        // 落点按脚下已记录方块的真实顶面给脚高（灵魂沙、半砖等不是整格），否则 move_step 会按“脚高不符”拒绝。
        const top = supportTopAt({ x: step.to.x, y: step.to.y - 1, z: step.to.z });
        const footY = top !== null && top > 0 && top <= 1 ? step.to.y - 1 + top : step.to.y;
        failure = await run(moveStep, { xyz: [step.to.x, footY, step.to.z] }) ?? undefined;
        if (failure !== undefined) break;
      }
    }
    executed++;
    // 做完第一处改动就交回：挖开后视觉会看到新露出的格（可能是液体或空腔），后面按新证据重新规划。
    if (step.dig.length > 0 || step.place !== undefined || step.kind === 'pillar') break;
  }
  return { from, to: { ...ctx.adapter.state().pos }, planned: steps.length, executed, ...(failure === undefined ? {} : { failure }) };
}

/** 一段由协调器代为执行的游泳：目标来自已观察体素，结果按实测记录。 */
export type SwimLegReceipt = {
  mode: 'dry_shore' | 'water_point'; target: Vec3Like; from: Vec3Like; to: Vec3Like;
  status: SkillStatus; summary: string; oxygenBefore: number; oxygenAfter: number;
};

/** 一次调用最多绕向前沿点的次数；绕不了就按真实原因交回。 */
const MAX_DETOURS = 8;
const MAX_CELL_RETRIES = 3;
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
      makeWay?: { edits: MakeWayEdit[]; legs: MakeWayLegReceipt[] };
    };

/** 真实回执边界统一用 contract 的分类；精确原因留在 stop.failure，这里只给旧 FailureCode 兼容值。 */
const failureCodeOfStop = (reason: StopReason): FailureCode => {
  const failure = movementFailureOfStop(reason);
  return failure === null ? 'ERROR' : failureCodeOfMovement(failure);
};

const isSuccess = (reason: StopReason) => reason === 'DISTANCE_MET' || reason === 'REGION_ENTERED' || reason === 'UNTIL_SEEN' || reason === 'ARRIVED';
const canResume = (reason: StopReason) =>
  reason === 'BUDGET_EXHAUSTED' || reason === 'TIMEOUT' || reason === 'NO_PROGRESS' || reason === 'UNKNOWN_BOUNDARY'
  || reason === 'BLOCKED' || reason === 'NO_PATH' || reason === 'RESIDENCY_NOT_READY'
  || reason === 'PHYSICAL_FAILURE' || reason === 'TARGET_UNRESOLVED' || reason === 'ROUTE_INVALIDATED' || reason === 'CONFLICT';

/** 终止后仍允许同一 session 续接的原因；其余终态必须新建意图。 */
const RESUMABLE_REASONS: ReadonlySet<StopReason> = new Set([
  'BUDGET_EXHAUSTED', 'TIMEOUT', 'NO_PROGRESS', 'UNKNOWN_BOUNDARY',
  'BLOCKED', 'NO_PATH', 'RESIDENCY_NOT_READY', 'PHYSICAL_FAILURE', 'TARGET_UNRESOLVED', 'ROUTE_INVALIDATED', 'CONFLICT',
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
    || session.counters.idleSearches >= session.budget.maxSearches;
  const canContinue = reason !== undefined && canResume(reason) && !budgetExhausted && Date.now() <= session.expiresAt;
  return {
    canContinue,
    ...(canContinue ? { sessionId: session.id } : {}),
    requires: canContinue
      ? reason === 'BLOCKED' ? ['已记录受阻的出边；附近可见证据或站位变化后，同一目标可用原 sessionId 复核']
        : reason === 'UNKNOWN_BOUNDARY' ? ['观察相关边界或靠近后重新调用；原目标不变时用同一 sessionId']
          : reason === 'CONFLICT' ? ['同一站位/证据下搜索与复验不一致；先观察、换站位或施工改变证据，再决定是否续接']
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
  const failure = movementFailureOfStop(reason);
  return { reason, at: Date.now(), detail, ...(failure === null ? {} : { failure }), ...extra };
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

type CellViewLike = { observed: boolean; evidence?: { revision: number } };
type VoxelLike = { cellAt(dim: string, x: number, y: number, z: number): CellViewLike };

/** 这条边界相关格的内容证据版本：无关视觉刷新不改变它，相关格变化才改变。 */
function boundaryEvidenceKeyOf(voxel: VoxelLike, dim: string, boundary: LandSearchBoundary): string {
  const endpoints = [boundary.from, boundary.to].flatMap((p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    return [{ x, y, z }, { x, y: y + 1, z }, { x, y: y - 1, z }, ...supportCellsUnder(p)];
  });
  // 扫掠身体会碰到的邻列也要算进证据版本；端点六格不足以覆盖实际依赖。
  const cells = [...endpoints, ...sweptBodyCells(boundary.from, boundary.to)];
  const unique = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, c]));
  return [...unique.values()].map((c) => {
    const view = voxel.cellAt(dim, c.x, c.y, c.z);
    return `${c.x},${c.y},${c.z}=${view.observed ? view.evidence?.revision ?? '?' : '?'}`;
  }).join(';');
}

/** 具体边的身份：冲突只对复核过的这条边成立，不能污染另一条边。 */
function edgeKeyOf(boundary: LandSearchBoundary): string {
  return `${boundary.kind}|${boundary.from.x},${boundary.from.y},${boundary.from.z}|${boundary.to.x},${boundary.to.y},${boundary.to.z}`;
}

/** 边界去重键含观察者所在格与相关格证据版本：换站位或相关格变化才是新的证据。 */
function boundaryKeyOf(boundary: LandSearchBoundary, observer: Vec3Like, voxel?: VoxelLike, dim?: string): string {
  return `${boundary.from.x},${boundary.from.y},${boundary.from.z}|${boundary.to.x},${boundary.to.y},${boundary.to.z}|${boundary.status}`
    + `@${Math.floor(observer.x)},${Math.floor(observer.y)},${Math.floor(observer.z)}`
    + (voxel !== undefined && dim !== undefined ? `|ev:${boundaryEvidenceKeyOf(voxel, dim, boundary)}` : '');
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
  const failureNote = stop.failure === undefined ? '' : `；停止分类 ${stop.failure}`;
  return `${intent}：${stop.detail}；${progress}；${path}${observationNote}${boundaryNote}${modeNote}${failureNote}`;
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
        ok: false, failureCode: failureCodeOfStop(session.stop.reason),
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
  const makeWayEdits: MakeWayEdit[] = [];
  const makeWayLegs: MakeWayLegReceipt[] = [];
  /** 同一站位/终态/边界在“没有新相关观察、身体也没动”时重复搜索的次数。 */
  const sameEvidenceSearches = new Map<string, number>();
  /** 自上次真实进展以来被记为“无位移”的搜索；后续迈出一步时改回正常搜索。 */
  let idleSearchesSinceProgress = 0;
  /** 上一次搜索之后是否真的观察到相关证据变化；无关视觉刷新不算。 */
  let evidenceChangedSinceSearch = false;
  /** 复验已把哪一条边判为 OPEN（或相反），但搜索仍给出不同结论。 */
  let searchContradictedFor: string | undefined;
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
    // 同一脚格/同一条边的执行层重来次数；用完先试绕行，再如实停下。
    const deviations = new Map<string, number>();
    const refusedEdges = new Map<string, number>();
    const triedFrontiers = new Set<string>();
    let residencyRetries = 0;
    let swimPending = false;
    // 委托推进量：方向委托按冻结轴线的前进，到点委托按到目标的水平距离缩短；横向授权仍是硬限制。
    const gainFrom = (from: Vec3Like) => (p: Vec3Like) => {
      if (session.intent.kind === 'advance') return progressOf(session, p, 0).along - progressOf(session, from, 0).along;
      const goal = session.intent.to;
      return Math.hypot(goal.x - from.x, goal.z - from.z) - Math.hypot(goal.x - p.x, goal.z - p.z);
    };
    const withinCorridor = (p: Vec3Like) => session.intent.kind !== 'advance' || Math.abs(progressOf(session, p, 0).lateral) <= session.intent.maxLateralDrift;
    for (;;) {
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
      if (session.counters.idleSearches >= session.budget.maxSearches) {
        stop = stopOf('BUDGET_EXHAUSTED', `没有带来位移的搜索已达 ${session.budget.maxSearches} 次；已确认段与 session 保留`);
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
      const frontier = session.intent.kind !== 'advance' || session.bearing === undefined ? null : await farthestFrontier(voxel, scope.dim, {
        origin: session.frozenOrigin, bearing: session.bearing,
        maxLateral: session.intent.maxLateralDrift, maxAlong: session.intent.distance, anchorY: session.frozenOrigin.y,
      }, state.pos, (cell) => triedFrontiers.has(cellText(cell)));
      if (ctx.signal.aborted) { stop = stopOf('CANCELLED', '规划前沿时父任务取消'); break; }
      const frontierGoal = frontier === null ? undefined : cellText(frontier);
      const goalAt = (pos: Vec3Like): NavigationGoal => {
        if (session.intent.kind === 'navigate') return goalFromIntent(session.intent.to, session.intent.targetKind, session.intent.arrival);
        // 方向探索就是去一个目的地：已记录体素里沿方向最远、可站立且紧挨未知的前沿（本轮规划前算好）；
        // 寻路负责怎么走过去。没有前沿（前方全已知或全未知）时，按冻结方向取前方路点。
        // 预览窗口的尾点已到达或越过这个前沿时，前沿不再是前方目的地，按方向取路点。
        const ahead = frontier !== null && session.bearing !== undefined
          && (frontier.x - pos.x) * session.bearing.x + (frontier.z - pos.z) * session.bearing.z >= 1;
        if (ahead) return cellGoal({ x: Math.floor(frontier.x), z: Math.floor(frontier.z) }, frontier.y, frontier);
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
      const searchSawNewEvidence = evidenceChangedSinceSearch;
      evidenceChangedSinceSearch = false;
      // 矛盾结论只属于同一证据版本；观察到新证据后重新判断。
      if (searchSawNewEvidence) searchContradictedFor = undefined;
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
        searchBudget: Math.max(0, session.budget.maxSearches - session.counters.idleSearches),
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
      if (!progressed) {
        session.counters.idleSearches += segment.searches;
        idleSearchesSinceProgress += segment.searches;
      } else if (idleSearchesSinceProgress > 0) {
        // 之前“没有位移”的搜索最终导向了真实移动：不再算无位移搜索，避免一边前进一边耗尽预算。
        session.counters.idleSearches = Math.max(0, session.counters.idleSearches - idleSearchesSinceProgress);
        idleSearchesSinceProgress = 0;
      }
      // 朝这个前沿走不出一步：换下一个前沿，不反复挑同一处。
      if (!progressed && frontierGoal !== undefined) triedFrontiers.add(frontierGoal);
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
      // 同一站位、同一相关证据下反复得到同一搜索终态：不是“再搜一次就好”。
      // 允许一次（边界复验可能带来新证据），第二次就交回原因和具体边界，不自动重播。
      // 若复验已判同一条边 OPEN 而搜索仍说证据不足，按 CONFLICT 交回；否则如实停在 UNKNOWN_BOUNDARY。
      if (!progressed && segment.searches > 0 && segment.outcome === 'unknown_boundary') {
        const siteKey = `${cellText(after.pos)}|${segment.searchStatus}|${segment.boundary ? boundaryKeyOf(segment.boundary, after.pos, voxel, scope.dim) : segment.stopCode ?? ''}`;
        const count = (searchSawNewEvidence ? 0 : sameEvidenceSearches.get(siteKey) ?? 0) + 1;
        sameEvidenceSearches.set(siteKey, count);
        if (!searchSawNewEvidence && count > MAX_SAME_EVIDENCE_SEARCHES) {
          const edge = segment.boundary === undefined ? '' : `（边界 ${cellText(segment.boundary.from)}→${cellText(segment.boundary.to)}）`;
          // 冲突必须绑定到复验过的那条边；换了边就只是新的未知边界。
          const contradicted = segment.boundary !== undefined && searchContradictedFor === edgeKeyOf(segment.boundary);
          stop = stopOf(contradicted ? 'CONFLICT' : 'UNKNOWN_BOUNDARY', `同一站位 ${cellText(after.pos)}、同一相关证据下搜索仍返回 ${segment.searchStatus}${edge}`
            + `；${contradicted ? '复验判这条边 OPEN，与搜索结果不一致；' : ''}${segment.searchReason}；本轮不自动重播，下一步由你决定`,
            { ...(segment.boundary === undefined ? {} : { boundaries: [segment.boundary] }) });
          break;
        }
      }
      // 身体稳稳站在地面上（活着、不在岩浆里）时，执行层的失败只是这一段的结束，后面从实测位置重新规划。
      const steady = after.alive && after.onGround && !after.inLava;
      if (segment.stopCode === 'settlement_failed' && !(steady && segment.outcome === 'physical_failure')) {
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
      // 只要还在推进就继续：本段有实测位移、调用方给的分段数还没用完，就从新位置继续规划。
      // 周边感知一直在刷新地形；边界、阻挡、窗口用完都只是这一段的结束，不是整趟委托的结束。
      const SOFT_ENDS = ['unknown_boundary', 'blocked', 'partial_prefix', 'no_path', 'corridor_exhausted', 'reached_waypoint'];
      if (progressed && SOFT_ENDS.includes(segment.outcome) && executedSegments < request.maxSegments && Date.now() < deadline) {
        session.phase = 'replanning';
        continue;
      }
      /**
       * 即将因阻挡/证据边界/无路而停下时的最后一招：绕向一个还有未探索出边的前沿点
       * （已走代价 + 剩余估计最小），走过去后从那里重新规划。每个前沿点只试一次，每次调用最多绕
       * MAX_DETOURS 次；绕不了就按原来的真实原因停下。
       */
      const tryDetour = async (): Promise<'moved' | 'none' | 'cancelled'> => {
        if (triedFrontiers.size >= MAX_DETOURS || Date.now() >= deadline) return 'none';
        const goalPoint = session.intent.kind === 'navigate' ? session.intent.to : undefined;
        const remainingOf = (p: Vec3Like) => goalPoint !== undefined ? Math.hypot(goalPoint.x - p.x, goalPoint.z - p.z)
          : -progressOf(session, p, 0).along;
        // 已经站在目标列上（只是脚高等精确条件达不到）：绕路不会让目标变得可达。
        if (remainingOf(after.pos) < 1) return 'none';
        // 精确连续脚位只能从起点格点搜到：绕到别的连续位置后就再也解析不了这个目标。
        if (session.intent.kind === 'navigate' && session.intent.targetKind === 'feet' && session.intent.arrival === undefined) return 'none';
        const here0 = remainingOf(after.pos);
        const here = cellText(after.pos);
        const frontier = segment.search.boundaries
          .filter((boundary) => boundary.status === 'UNKNOWN' || boundary.status === 'STALE')
          .map((boundary) => boundary.from)
          // 只往侧面或前方绕：离目标不比现在更远（0.5 格容差），不往回走。
          .filter((from) => cellText(from) !== here && !triedFrontiers.has(cellText(from)) && withinCorridor(from)
            && remainingOf(from) <= here0 + 0.5)
          .sort((a, b) => Math.hypot(a.x - after.pos.x, a.z - after.pos.z) + remainingOf(a)
            - (Math.hypot(b.x - after.pos.x, b.z - after.pos.z) + remainingOf(b)))[0];
        if (frontier === undefined) return 'none';
        triedFrontiers.add(cellText(frontier));
        const detour = await runNavigationSegment(ctx, {
          goal: cellGoal({ x: Math.floor(frontier.x), z: Math.floor(frontier.z) }, frontier.y, frontier),
          allowed: session.intent.allowed,
          historical: session.intent.historical,
          ...(request.swim === true ? { wade: true } : {}),
          ...(corridorOf(session) === undefined ? {} : { corridor: corridorOf(session)! }),
          maxTransitions: Math.max(1, Math.min(request.maxStepsPerSegment, session.budget.maxTransitions - session.counters.confirmedTransitions)),
          allowUnknownCorridor: request.allowUnknownCorridor,
          deadline,
          searchBudget: Math.max(0, session.budget.maxSearches - session.counters.idleSearches),
          ...(request.searchLimits === undefined ? {} : { searchLimits: request.searchLimits }),
        });
        segments.push(detour);
        session.lastSegment = detour;
        session.counters.searches += detour.searches;
        session.counters.confirmedTransitions += detour.confirmed.length;
        invocationTransitions += detour.confirmed.length;
        session.counters.confirmedRouteLength += detour.pathLength;
        if (detour.outcome === 'cancelled') return 'cancelled';
        if (detour.confirmed.length === 0) { session.counters.idleSearches += detour.searches; return 'none'; }
        if (idleSearchesSinceProgress > 0) {
          session.counters.idleSearches = Math.max(0, session.counters.idleSearches - idleSearchesSinceProgress);
          idleSearchesSinceProgress = 0;
        }
        session.progress.stagnationSegments = 0;
        session.progress.lastProgressAt = Date.now();
        session.phase = 'replanning';
        return 'moved';
      };
      // 动作没按计划落位、搜索期间地图变了：身体稳稳站着就从实测位置重来，与执行偏差同一口径。
      // 低血量门槛不是执行失败，仍按原因停下。
      const retryable = segment.outcome === 'replan' && segment.stopCode === 'execution_deviation'
        || steady && segment.outcome === 'physical_failure' && segment.failureCode !== 'LOW_HP'
        || segment.outcome === 'invalidated';
      const refusedEdge = segment.outcome === 'replan' && segment.stopCode === 'stale_plan' && segment.transition !== undefined
        ? `${cellText(segment.transition.from)}→${cellText(segment.transition.to)}` : undefined;
      if (retryable || segment.outcome === 'replan') {
        // 同一脚格（或被当前证据拒绝的同一条边）最多重来 MAX_CELL_RETRIES 次：再重搜大概率走回原处，先试绕行。
        const key = retryable ? `${Math.floor(after.pos.x)},${Math.floor(after.pos.y)},${Math.floor(after.pos.z)}` : refusedEdge;
        const seen = retryable ? deviations : refusedEdges;
        const tries = key === undefined ? 0 : (seen.get(key) ?? 0) + 1;
        if (key !== undefined) seen.set(key, tries);
        if (tries > MAX_CELL_RETRIES) {
          const detoured = await tryDetour();
          if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
          if (detoured === 'moved') continue;
          stop = retryable
            ? stopOf('PHYSICAL_FAILURE', `${segment.detail ?? '执行偏差'}；同一站位已从实测位置重新规划 ${MAX_CELL_RETRIES} 次，仍未按计划落位，也没有可绕的前沿`)
            : stopOf('BLOCKED', `${segment.detail ?? '当前证据阻挡'}；已用最新证据重搜 ${MAX_CELL_RETRIES} 次，路线仍经过这条边，也没有可绕的前沿`);
          break;
        }
        // 不把实测起点覆盖成计划点；保留冻结目标，从实测位置重新搜索。
        // 搜索次数与 deadline 由 session/本次调用预算继续约束，不重置、不延长。
        if (session.counters.idleSearches >= session.budget.maxSearches) {
          stop = stopOf('BUDGET_EXHAUSTED', `没有带来位移的搜索已达 ${session.budget.maxSearches} 次；原目标与实测进展保留`);
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
        // 所需页面暂时没加载/驻留（常见是存档正在写盘、加载排队）：这是存储侧的短暂忙，不是地形结论，
        // 等一会儿从实测位置重试；重试用完仍不行才停下，原样保留 unavailableSections。
        if (residencyRetries < MAX_RESIDENCY_RETRIES && Date.now() + RESIDENCY_RETRY_MS < deadline) {
          residencyRetries++;
          // 存储忙不是“没走出一步”的身体事实：不计入无进展段与无位移搜索。
          session.progress.stagnationSegments = Math.max(0, session.progress.stagnationSegments - 1);
          session.counters.idleSearches = Math.max(0, session.counters.idleSearches - segment.searches);
          await sleep(RESIDENCY_RETRY_MS, ctx.signal);
          session.phase = 'replanning';
          continue;
        }
        stop = stopOf('RESIDENCY_NOT_READY', segment.detail ?? '导航所需的 Section 未能加载/驻留；没有执行未复验的动作');
        break;
      }
      if (segment.outcome === 'disallowed') {
        stop = stopOf('MODE_GAP', `${segment.detail ?? '需要的移动模式不在 allowed'}；不自动切换模式`, {
          modeGap: { required: segment.disallowed?.kind ?? 'unknown', allowed: session.intent.allowed },
        });
        break;
      }
      if (segment.outcome === 'corridor_exhausted' || segment.outcome === 'no_path') {
        const detoured = await tryDetour();
        if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
        if (detoured === 'moved') continue;
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
        const boundaryKey = blockedBoundary === undefined ? undefined : boundaryKeyOf(blockedBoundary, after.pos, voxel, scope.dim);
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
            evidenceChangedSinceSearch = true;
            session.phase = 'replanning';
            continue;
          }
        }
        const detoured = await tryDetour();
        if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
        if (detoured === 'moved') continue;
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
        // 只是危险策略拒绝了几条边（火、岩浆旁）：先绕向别的前沿点，而不是当成目标无法解析。
        if (!modeGap && (segment.search.policy?.rejectedEdges ?? 0) > 0) {
          const detoured = await tryDetour();
          if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
          if (detoured === 'moved') continue;
        }
        const policyDetail = segment.search.policy?.firstRejection === undefined ? ''
          : `；被宿主边缘策略拒绝 ${segment.search.policy.rejectedEdges} 条边，第一条 ${cellText(segment.search.policy.firstRejection.from)}→${cellText(segment.search.policy.firstRejection.to)}：${segment.search.policy.firstRejection.reason}`;
        stop = modeGap
          ? stopOf('MODE_GAP', `${segment.detail ?? '需要当前不支持的移动模式'}；不自动切换游泳/船/攀爬模式${policyDetail}`, { modeGap: { problem: segment.problemKind } })
          : segment.failure === 'DELEGATION_RESTRICTION'
            ? stopOf('DELEGATION_RESTRICTION', `${segment.detail ?? '授权/策略拒绝可走边'}${policyDetail}`)
            : stopOf('TARGET_UNRESOLVED', `${segment.detail ?? 'waypoint/脚高无法解析'}${policyDetail}`);
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
          // 窗口末端松键自然停下，身体只保证在边界起点所在格列；复验从实测位置出发。
          if (boundary === undefined || !after.onGround || Math.floor(after.pos.x) !== Math.floor(boundary.from.x)
            || Math.floor(after.pos.z) !== Math.floor(boundary.from.z) || Math.abs(after.pos.y - boundary.from.y) > 0.05) return false;
          // 授权/走廊与搜索一致：被 allowed 或走廊排除的边不能因为复验 OPEN 就重搜。
          if (!session.intent.allowed.includes(boundary.kind)) return false;
          const corridor = corridorOf(session);
          if (corridor !== undefined) {
            const lateral = Math.abs((boundary.to.x - corridor.origin.x) * corridor.bearing.z - (boundary.to.z - corridor.origin.z) * corridor.bearing.x);
            if (lateral > corridor.maxLateral + 0.01) return false;
          }
          const check = verifyLandRoute(voxel, {
            ...scope, body: { feet: { ...after.pos }, width: 0.6, height: 1.8, pose: 'standing' },
            rules: walkLandRules, measuredStart: after.pos, ...(request.swim === true ? { wade: true } : {}),
          }, [{ kind: boundary.kind, from: boundary.from, to: boundary.to,
            drop: Math.max(0, boundary.from.y - boundary.to.y) }], Date.now());
          if (check.transitions[0]?.status !== 'OPEN') return false;
          // 搜索用宿主边缘策略判边；复验必须用同一策略。未知脚心支撑等情况下策略会要求观察，
          // 这里不能把“几何 OPEN”直接当成可通行，否则会把需要观察的情况误判成搜索/复验冲突。
          const edge: LandSearchPolicyEdge = {
            kind: boundary.kind, from: { ...boundary.from }, to: { ...boundary.to }, baseCost: 1, hazards: [], evidenceMode: 'current',
          };
          const decision = (request.swim === true ? hostWadingEdgePolicy : hostLandEdgePolicy).evaluate(edge, {
            cell(x, y, z) {
              const view = voxel.cellAt(scope.dim, x, y, z);
              if (!view.observed) return { kind: 'unknown' };
              if (evidenceStale(view.evidence)) return { kind: 'unavailable' };
              const observation = view.evidence.observation;
              return { kind: 'recorded', state: { name: observation.state.name, properties: observation.state.properties }, stateComplete: observation.stateComplete };
            },
          });
          return decision.allow;
        };
        if (canProceed()) {
          // 同一条边在最新证据下已 OPEN，但这次搜索仍说证据不足/无路：记录矛盾事实，
          // 允许再搜一次；仍不一致时按 CONFLICT 交回，而不是无限重播。
          if (boundary !== undefined) searchContradictedFor = edgeKeyOf(boundary);
          session.phase = 'replanning';
          continue;
        }
        const boundaryKey = boundary === undefined ? undefined : boundaryKeyOf(boundary, after.pos, voxel, scope.dim);
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
              && !evidenceStale(supportView.evidence)
              && supportView.evidence.observation.stateComplete);
          }
        }
        if ((boundary === undefined || boundaryDone) && (!needCurrent || currentDone)) {
          const detoured = await tryDetour();
          if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
          if (detoured === 'moved') continue;
          // 周边感知一直在刷新：不因“这里观察过”就停，继续重新规划；连续多段没有进展才交回。
          if (session.progress.stagnationSegments < Math.min(request.maxNoProgressSegments, session.budget.maxNoProgressSegments)) {
            session.phase = 'replanning';
            continue;
          }
          stop = stopOf('UNKNOWN_BOUNDARY', `连续 ${session.progress.stagnationSegments} 段没有进展，前方仍是未知边界`, {
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
        if (observation.relatedChanged) evidenceChangedSinceSearch = true;
        if (!observation.relatedChanged) {
          const detoured = await tryDetour();
          if (detoured === 'cancelled') { stop = stopOf('CANCELLED', '绕行时父任务取消'); break; }
          if (detoured === 'moved') continue;
          // 相关格没变不代表别处没有新证据（周边感知一直在写）：继续重新规划，连续多段没有进展才交回。
          if (session.progress.stagnationSegments < Math.min(request.maxNoProgressSegments, session.budget.maxNoProgressSegments)) {
            session.phase = 'replanning';
            continue;
          }
          stop = stopOf('UNKNOWN_BOUNDARY', `连续 ${session.progress.stagnationSegments} 段没有进展，前缀端点观察后边界仍是未知`, {
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
    // 普通路线走不通且委托授权了开路：在已记录体素上规划挖开/补支撑/垫高的路线，执行完回到普通路线。
    const makeWay = request.makeWay;
    if (makeWay === undefined || stop === null || !MAKE_WAY_STOPS.has(stop.reason) || makeWayEdits.length >= makeWay.maxEdits
      || makeWayLegs.length >= MAX_MAKE_WAY_LEGS || Date.now() >= deadline || ctx.signal.aborted) break;
    const voxel = spatial.session.voxel;
    const here = ctx.adapter.state().pos;
    const target = session.intent.kind === 'navigate' ? session.intent.to : (() => {
      const bearing = session.bearing!;
      const ahead = Math.min(24, Math.max(1, session.intent.distance - progressOf(session, here, 0).along));
      return { x: here.x + bearing.x * ahead, y: here.y, z: here.z + bearing.z * ahead };
    })();
    const start = { x: Math.floor(here.x), y: Math.floor(here.y + 0.05), z: Math.floor(here.z) };
    const steps = await planMakeWay(voxel, scope.dim, start, target, makeWay, (cell) => withinCorridor({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }),
      { signal: ctx.signal, deadlineMs: deadline });
    if (steps === null && ctx.signal.aborted) { stop = stopOf('CANCELLED', '开路规划时父任务取消'); break; }
    if (steps === null && Date.now() >= deadline) { stop = stopOf('TIMEOUT', '开路规划到达原期限'); break; }
    if (steps === null) {
      // 说清试过开路、用了哪些授权、缺哪种手段：是否补授权由调用方决定。
      const granted = [makeWay.dig === undefined ? null : 'dig', makeWay.place === undefined ? null : `place(${makeWay.place.item})`].filter((x): x is string => x !== null);
      const missing = [makeWay.dig === undefined ? 'dig（挖开挡路格）' : null, makeWay.place === undefined ? 'place（补脚下支撑/原地垫高）' : null].filter((x): x is string => x !== null);
      stop = stopOf(stop.reason, `${stop.detail}；试过开路：已授权 ${granted.join('、')}${missing.length ? `，未授权 ${missing.join('、')}` : ''}；已记录体素里找不到只用这些手段、离目标更近至少 3 格的路线${makeWayLegs.length ? '（前面几段已开过路）' : ''}`);
      break;
    }
    const editsBefore = makeWayEdits.length;
    const leg = await runMakeWay(ctx, steps, makeWay, makeWayEdits, deadline, (cell) => {
      const view = voxel.cellAt(scope.dim, cell.x, cell.y, cell.z);
      return view.observed ? view.evidence.observation.state.name.replace(/^minecraft:/, '') : 'unknown';
    }, (cell) => {
      const view = voxel.cellAt(scope.dim, cell.x, cell.y, cell.z);
      if (!view.observed) return null;
      const state = view.evidence.observation.state;
      return supportTop(state.name.replace(/^minecraft:/, ''), state.properties);
    });
    makeWayLegs.push(leg);
    session.counters.makeWayLegs += 1;
    session.counters.makeWayEdits += makeWayEdits.length - editsBefore;
    // 计划过时（身体在规划期间移动了）：不算失败，按实测位置回到普通路线重来；次数受 MAX_MAKE_WAY_LEGS 约束。
    if (leg.stale) { stop = null; continue; }
    if (leg.executed === 0) {
      stop = stopOf(stop.reason, `${stop.detail}；试过开路（计划 ${leg.planned} 步）但第一步就没成：${leg.failure ?? '未知原因'}`);
      break;
    }
    // 开出了路：从新位置回到普通路线。之前停在原地的搜索已由实际迈步证明不是空搜。
    stop = null;
    if (idleSearchesSinceProgress > 0) {
      session.counters.idleSearches = Math.max(0, session.counters.idleSearches - idleSearchesSinceProgress);
      idleSearchesSinceProgress = 0;
    }
    session.progress.stagnationSegments = 0;
    session.progress.lastProgressAt = Date.now();
    session.phase = 'replanning';
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
    ...(status === 'failed' ? { failureCode: failureCodeOfStop(finalStop.reason) } : {}),
    summary: renderSummary(session, finalStop, segments) + (swimLegs.length === 0 ? ''
      : `；代为游泳 ${swimLegs.length} 段（${swimLegs.map((leg) => `${leg.mode === 'dry_shore' ? '上岸' : '水面点'} ${cellText(leg.target)} ${leg.status}，氧气 ${leg.oxygenBefore}→${leg.oxygenAfter}`).join('；')}）`)
      + (request.makeWay === undefined && request.makeWayAvailable === true && MAKE_WAY_STOPS.has(finalStop.reason)
        ? '；本次没有授权 dig/place，没有挖也没有放' : '')
      + (makeWayLegs.length === 0 ? '' : `；代为开路 ${makeWayLegs.length} 段：${makeWayEdits.length === 0 ? '没有改动方块' : makeWayEdits.map((edit) => `${edit.kind === 'dig' ? '挖开' : '放置'} ${edit.name}${cellText(edit.pos)}`).join('、')}${makeWayLegs.some((leg) => leg.failure !== undefined) ? `（停在：${makeWayLegs.filter((leg) => leg.failure !== undefined).map((leg) => leg.failure).at(-1)}）` : ''}`),
    session,
    segments,
    stop: finalStop,
    ...(observation === undefined ? {} : { observation }),
    ...(swimLegs.length === 0 ? {} : { swimLegs }),
    ...(makeWayLegs.length === 0 ? {} : { makeWay: { edits: makeWayEdits, legs: makeWayLegs } }),
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
    ...(outcome.makeWay === undefined ? {} : { makeWay: outcome.makeWay }),
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
      ...(last.failure === undefined ? {} : { failure: last.failure }),
      ...(last.searchFailure === undefined ? {} : { searchFailure: last.searchFailure }),
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
