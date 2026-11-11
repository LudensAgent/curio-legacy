import { supportTop } from '../perception/geometry.ts';
import {
  evaluateLandTransition,
  evaluateWalkTo,
  resolveLandLimits,
  type BodyContext,
  type HazardFact,
  type LandRules,
  type LandSearchBudget,
  type LandSearchPrefix as LibraryPrefix,
  type LandSearchRequest as LibraryRequest,
  type LandSearchResult as LibraryResult,
  type LandSearchStatus,
  type LandSearchTransition as LibraryTransition,
  type SectionKey,
  type Vec3Like,
  type VoxelMap,
} from 'curio-minecraft-3d-memory';
import {
  searchLandRoute as librarySearchLandRoute,
  searchLandRouteAsync as librarySearchLandRouteAsync,
  type LandSearchArrival,
  type LandSearchBoundary as LibraryBoundary,
  type LandSearchBoundaryStatus,
  type LandSearchCorridor,
  type LandSearchKind,
  type LandSearchPolicySummary,
} from 'curio-minecraft-3d-memory/navigation';
import { hostLandEdgePolicy, hostWadingEdgePolicy, isWaterBlock, supportCellsUnder, sweptBodyCells } from './land-edge-policy.ts';
import type { NavigationGoal } from '../skills/movement/goal.ts';
import { stanceFor } from '../skills/movement/goal.ts';

export { isDangerousBlock } from './land-edge-policy.ts';
import { isDangerousBlock } from './land-edge-policy.ts';

/**
 * 宿主侧的 land-search 边界：目标语义、风险/几何复验仍由宿主拥有，
 * 有界 A*、堆、分片搜索和 residency/失效处理由库提供。
 *
 * 这里不再有第二套 A*、状态提升或历史证据伪装成 FRESH 的视图。
 * 历史/remembered 搜索只给候选几何，逐段当前证据复验仍由 host 完成。
 */

export type { LandSearchStatus, LandSearchKind, LandSearchBudget, LandSearchArrival, SectionKey };
export type LandBoundaryDirection = 'N' | 'E' | 'S' | 'W' | 'UP' | 'DOWN' | 'HERE';

export interface LandSearchTransition {
  kind: LandSearchKind;
  from: Vec3Like;
  to: Vec3Like;
  /** 计划中的下落格数；walk/step 为 0。执行层仍以实测位置为准。 */
  drop: number;
  /** 库的几何代价单位，不是时间或风险估计。 */
  cost?: number;
  hazards?: HazardFact[];
}

export interface LandSearchBoundary {
  from: Vec3Like;
  to: Vec3Like;
  kind: LandSearchKind;
  status: LandSearchBoundaryStatus;
  reason: string;
  /** 从 from 指向 to 的方向；水平优先，纯垂直时为 UP/DOWN。 */
  direction: LandBoundaryDirection;
  /** 搜索尚未找到支撑面时实际读取的方块 y 范围（闭区间）。 */
  supportColumn?: { minY: number; maxY: number };
}

export interface LandSearchPrefix {
  endpoint: Vec3Like;
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  /** endpoint 到原始目标的距离，按请求的 goalMetric 计算。 */
  distanceToTarget: number;
  /** 原始 exact/near 完成谓词在 endpoint 上成立；仍不代表身体已到达。 */
  atTarget: boolean;
  atStart: boolean;
  knownBlockerAhead?: LandSearchBoundary;
}

/** 边界证据缺口分类；只给事实，不替调用方选择观察/挖/建动作。 */
export interface LandSearchBoundarySummary {
  total: number;
  counts: Record<string, number>;
  observationMayResolve: boolean;
  needsExplicitActionOrOtherRoute: boolean;
}

export interface LandSearchRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  /** 共享目标语义：格目标不会退化成格心精确点，连续目标不会被格心替代。 */
  goal: NavigationGoal;
  /** 方向推进只约束目标列；精确目的地默认保留 3D 脚高。 */
  goalMetric?: '3d' | 'horizontal';
  rules: LandRules;
  /** current 只认当前证据（不含待重新确认的格）；remembered 连待确认的几何也用来做候选，绝不冒充当前 OPEN。 */
  evidenceMode?: 'current' | 'remembered';
  /** 委托显式允许涉水：接受身体接触水的地面边（不含淹没、水流、气泡柱）。 */
  wade?: boolean;
  allowed?: readonly LandSearchKind[];
  corridor?: LandSearchCorridor;
  maxDrop?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxSurfaceReads?: number;
  maxSections?: number;
  maxRoutePoints?: number;
  maxBoundaries?: number;
  maxSearchMs?: number;
  maxSliceMs?: number;
  maxWorkPerSlice?: number;
  /** 共享绝对期限；maxSearchMs 仍单独限制本次调用。 */
  deadlineMs?: number;
  signal?: AbortSignal;
  clock?: () => number;
}

export interface LandSearchResult {
  status: LandSearchStatus;
  assurance: 'geometry_only' | 'historical_geometry';
  evidenceMode: 'current' | 'historical';
  executable: false;
  needsRevalidation: true;
  from: Vec3Like;
  /** 实际交给库搜索的精确目标点（格目标落在起点同一格内偏移上）。 */
  target: Vec3Like;
  arrival: LandSearchArrival;
  goalMetric?: '3d' | 'horizontal';
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  cost: number;
  boundaries: LandSearchBoundary[];
  /** Host edge-policy diagnostics; policy rejections are not terrain boundaries. */
  policy?: LandSearchPolicySummary;
  prefix?: LandSearchPrefix;
  corridorLimited?: true;
  unavailableSections: SectionKey[];
  reason: string;
  budget?: LandSearchBudget;
  evaluatedAt: number;
  stats: LibraryResult['stats'];
  /** 因搜索期间依赖 Section 被新观测改变而作废、随后用最新地图重跑的次数；只有分片搜索会出现。 */
  invalidatedAttempts?: number;
  /** 由显式兼容调用方填充；普通搜索返回不做隐式整条路线复验。 */
  verification?: LandRouteVerification;
  /** 兼容旧读取方：等于 target，绝不是吸附后的支撑面。 */
  resolvedTarget: Vec3Like;
}

export interface LandRouteVerificationTransition {
  transition: LandSearchTransition;
  status: string;
  reason?: string;
  hazards: HazardFact[];
  /** Real geometry refusal kind from the library evaluator, when present. */
  problem?: string;
  /** Observed obstacle cell for a real collision/missing-support refusal. */
  obstacle?: Vec3Like;
  /** BLOCKED came from host risk policy (water/lava/fire), not an observed collision. */
  risk?: true;
}

export interface LandRouteVerification {
  verdict: string;
  openPrefix: number;
  transitions: LandRouteVerificationTransition[];
  /** Bounded callers report how much of the route was actually checked. */
  coverage?: { checked: number; total: number; complete: boolean; stopped?: 'deadline' | 'cancelled' };
}

const EPS = 1e-9;
const cell = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 0.05), z: Math.floor(pos.z) });

/** 边界方向：水平优先（drop 也先报水平侧），纯垂直时才报 UP/DOWN。 */
function directionOf(from: Vec3Like, to: Vec3Like): LandBoundaryDirection {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > EPS) return dx > 0 ? 'E' : 'W';
  if (Math.abs(dz) > EPS) return dz > 0 ? 'S' : 'N';
  const dy = to.y - from.y;
  return dy > EPS ? 'UP' : dy < -EPS ? 'DOWN' : 'HERE';
}

function kindOf(from: Vec3Like, to: Vec3Like): LandSearchKind {
  const dy = to.y - from.y;
  return Math.abs(dy) <= EPS ? 'walk' : dy > 0 ? 'step' : 'drop';
}

const OBSERVATION_RESOLVABLE = new Set(['UNKNOWN', 'STALE', 'INCOMPLETE']);
const BEYOND_WALK = new Set(['BLOCKED', 'UNSUPPORTED']);

/** 边界证据缺口汇总；route.ts 与 navigate.ts 共用同一份状态/原因分类。 */
export function summarizeBoundaries(boundaries: readonly LandSearchBoundary[]): LandSearchBoundarySummary {
  const counts: Record<string, number> = {};
  for (const boundary of boundaries) counts[boundary.status] = (counts[boundary.status] ?? 0) + 1;
  return {
    total: boundaries.length,
    counts,
    observationMayResolve: boundaries.some((boundary) => OBSERVATION_RESOLVABLE.has(boundary.status)),
    needsExplicitActionOrOtherRoute: boundaries.some((boundary) => BEYOND_WALK.has(boundary.status)),
  };
}

interface Check {
  status: string;
  reason?: string;
  hazards: HazardFact[];
  /** Library problem kind for a real geometry refusal (never a risk-policy decision). */
  problem?: string;
  /** First observed obstacle cell, when the evaluator reports one. */
  obstacle?: Vec3Like;
}

function waterAt(map: VoxelMap, dim: string, pos: Vec3Like): boolean {
  const p = cell(pos);
  const view = map.cellAt(dim, p.x, p.y, p.z);
  return view.observed && isWaterBlock(view.evidence.observation.state.name);
}

function dangerousAt(map: VoxelMap, dim: string, pos: Vec3Like): string | null {
  const p = cell(pos);
  const view = map.cellAt(dim, p.x, p.y, p.z);
  if (!view.observed) return null;
  const name = view.evidence.observation.state.name.replace(/^minecraft:/, '');
  return isDangerousBlock(name) ? name : null;
}

/** walk 用同高判定器；step/drop 用库的 land transition 判定器。两者都是只读当前证据。 */
function checkTransition(
  map: VoxelMap,
  request: Pick<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'rules'>,
  kind: LandSearchKind,
  from: Vec3Like,
  to: Vec3Like,
  limits: ReturnType<typeof resolveLandLimits>,
  now: number,
  plannedFrom?: Vec3Like,
): Check {
  const body = { ...request.body, feet: { ...from } };
  if (kind === 'walk') {
    // 直线 walk（四向或斜向）从实测起点证明到原计划落点的整段扫掠与连续支撑；
    // 有起点偏差时只接受仍在计划起点格列内、脚高 0.05 内的实测位置。
    const query = {
      worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
      mode: 'walk' as const, body, direction: { axis: 'x' as const, sign: 1 as const },
    };
    const outsideColumn = plannedFrom !== undefined
      && (Math.floor(from.x) !== Math.floor(plannedFrom.x) || Math.floor(from.z) !== Math.floor(plannedFrom.z));
    const evaluation = outsideColumn
      ? { status: 'UNSUPPORTED' as const, reason: 'actual start must stand in the planned start column', hazards: [], obstacles: [], problem: undefined }
      : evaluateWalkTo(map, query, to, request.rules.shapeProvider, now, { feetTolerance: plannedFrom === undefined ? 0 : 0.05 });
    const obstacle = evaluation.obstacles.find((entry) => entry.kind === 'block');
    return {
      status: evaluation.status,
      ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
      hazards: evaluation.hazards ?? [],
      ...(evaluation.problem === undefined ? {} : { problem: evaluation.problem.kind }),
      ...(obstacle === undefined || obstacle.kind !== 'block' ? {} : { obstacle: { ...obstacle.observation.pos } }),
    };
  }
  const evaluation = evaluateLandTransition(map, {
    worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
    body, transition: { kind, from: { ...from }, to: { ...to } },
    ...(plannedFrom === undefined ? {} : { plannedFrom }),
  }, request.rules, now, limits);
  const obstacle = evaluation.obstacles.find((entry) => entry.kind === 'block');
  return {
    status: evaluation.status,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason.detail }),
    hazards: evaluation.hazards,
    ...(evaluation.reason === undefined ? {} : { problem: evaluation.reason.kind }),
    ...(obstacle === undefined || obstacle.kind !== 'block' ? {} : { obstacle: { ...obstacle.observation.pos } }),
  };
}

/** OPEN 且只有可声明的 fall hazard；危险方块仍由宿主风险策略拒绝。 */
function safe(check: Check, map: VoxelMap, dim: string, from: Vec3Like, to: Vec3Like, wade: boolean): boolean {
  if (check.status !== 'OPEN') return false;
  if (check.hazards.some((hazard) => hazard.kind !== 'fall' && !(wade && hazard.kind === 'water_contact'))) return false;
  // step/drop 几何只报坠落：落点脚/头格的已观察水由这里判定，与搜索边策略一致。
  if (waterAt(map, dim, { ...to, y: to.y + 1 }) || !wade && waterAt(map, dim, to)) return false;
  return sweptDangerAt(map, dim, from, to) === null;
}

/** 与搜索边策略同一口径：身体扫过的格子与落点脚下支撑里已观察的危险方块。 */
function sweptDangerAt(map: VoxelMap, dim: string, from: Vec3Like, to: Vec3Like): string | null {
  for (const cell of [...sweptBodyCells(from, to), ...supportCellsUnder(to)]) {
    const name = dangerousAt(map, dim, cell);
    if (name !== null) return `${name} (${cell.x},${cell.y},${cell.z})`;
  }
  return null;
}

/**
 * (x,z) 这一列已观测的、离 aroundY 最近的站立脚高：支撑格完整观测、脚部格已观测且不是支撑面。
 * 脚高按实际碰撞顶面算（0.5 半砖、0.875 雪层、箱子/台阶顶面），不是按整数层猜。
 * 只读当前 VoxelMap，没观测过的列返回 null，不外推。用于给分段路点一个脚高提示。
 *
 * 分片版本让前沿扫描在高度探测循环中途也能检查时间预算；返回值与同步版本一致。
 */
export function* observedFootYSlices(map: VoxelMap, dim: string, x: number, z: number, aroundY: number, down: number, up: number): Generator<void, number | null, void> {
  const min = Math.floor(aroundY - down) - 1;
  const max = Math.ceil(aroundY + up) + 1;
  let best: number | null = null;
  let work = 0;
  for (let y = min; y <= max; y++) {
    const view = map.cellAt(dim, x, y, z);
    if (view.observed) {
      const evidence = view.evidence;
      if (evidence.observation.stateComplete) {
        const state = evidence.observation.state;
        const top = supportTop(state.name.replace(/^minecraft:/, ''), state.properties);
        if (top !== null) {
          const foot = y + top;
          if (foot >= aroundY - down - 0.01 && foot <= aroundY + up + 0.01) {
            const footCell = map.cellAt(dim, x, Math.floor(foot) + (top >= 1 ? 0 : 1), z);
            if (footCell.observed
              && supportTop(footCell.evidence.observation.state.name.replace(/^minecraft:/, ''), footCell.evidence.observation.state.properties) === null
              && (best === null || Math.abs(foot - aroundY) < Math.abs(best - aroundY))) best = foot;
          }
        }
      }
    }
    if (++work >= 8) { work = 0; yield; }
  }
  return best;
}

export function observedFootY(map: VoxelMap, dim: string, x: number, z: number, aroundY: number, down: number, up: number): number | null {
  const slices = observedFootYSlices(map, dim, x, z, aroundY, down, up);
  for (;;) {
    const step = slices.next();
    if (step.done) return step.value;
  }
}

function hostTransition(transition: LibraryTransition): LandSearchTransition {
  return {
    kind: transition.kind,
    from: { ...transition.from },
    to: { ...transition.to },
    drop: Math.max(0, transition.from.y - transition.to.y),
    cost: transition.cost,
    hazards: transition.hazards.map((hazard) => ({ ...hazard, pos: { ...hazard.pos } })),
  };
}

function hostBoundary(boundary: LibraryBoundary): LandSearchBoundary {
  return {
    from: { ...boundary.from },
    to: { ...boundary.to },
    kind: kindOf(boundary.from, boundary.to),
    status: boundary.status,
    reason: boundary.reason,
    direction: directionOf(boundary.from, boundary.to),
    ...(boundary.supportColumn === undefined ? {} : { supportColumn: { ...boundary.supportColumn } }),
  };
}

function hostPrefix(prefix: LibraryPrefix): LandSearchPrefix {
  return {
    endpoint: { ...prefix.endpoint },
    points: prefix.points.map((point) => ({ ...point })),
    transitions: prefix.transitions.map(hostTransition),
    distanceToTarget: prefix.distanceToTarget,
    atTarget: prefix.atTarget,
    atStart: prefix.atStart,
    ...(prefix.knownBlockerAhead === undefined ? {} : { knownBlockerAhead: hostBoundary(prefix.knownBlockerAhead) }),
  };
}

function libraryRequest(request: LandSearchRequest): LibraryRequest {
  return {
    worldId: request.worldId,
    dim: request.dim,
    sessionId: request.sessionId,
    body: request.body,
    to: stanceFor(request.goal, request.body.feet),
    // travel 的范围参与规划，不能先强求进入箱子/床所在的不可站立坐标，
    // 再在执行层检查范围；与实测验收使用同一个原目标、格距和维度。
    arrival: request.goal.arrival === undefined ? { kind: 'exact' }
      : { kind: 'near', radius: request.goal.arrival.radius, coordinates: 'cell' },
    ...(request.goal.arrival !== undefined ? { goalMetric: request.goal.arrival.metric }
      : request.goalMetric === undefined ? {} : { goalMetric: request.goalMetric }),
    rules: request.rules,
    edgePolicy: request.wade === true ? hostWadingEdgePolicy : hostLandEdgePolicy,
    // 危险策略读取身体扫过的全部格子：每条边约二三十次读取，总量随边数放宽。
    maxPolicyReads: 2_000_000,
    ...(request.evidenceMode === undefined ? {} : { evidenceMode: request.evidenceMode }),
    ...(request.allowed === undefined ? {} : { allowed: request.allowed }),
    ...(request.corridor === undefined ? {} : { corridor: request.corridor }),
    ...(request.maxDrop === undefined ? {} : { maxDrop: request.maxDrop }),
    ...(request.maxNodes === undefined ? {} : { maxNodes: request.maxNodes }),
    ...(request.maxEdges === undefined ? {} : { maxEdges: request.maxEdges }),
    ...(request.maxSurfaceReads === undefined ? {} : { maxSurfaceReads: request.maxSurfaceReads }),
    ...(request.maxSections === undefined ? {} : { maxSections: request.maxSections }),
    ...(request.maxRoutePoints === undefined ? {} : { maxRoutePoints: request.maxRoutePoints }),
    ...(request.maxBoundaries === undefined ? {} : { maxBoundaries: request.maxBoundaries }),
    ...(request.maxSearchMs === undefined ? {} : { maxSearchMs: request.maxSearchMs }),
    ...(request.maxSliceMs === undefined ? {} : { maxSliceMs: request.maxSliceMs }),
    ...(request.maxWorkPerSlice === undefined ? {} : { maxWorkPerSlice: request.maxWorkPerSlice }),
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  };
}

/**
 * 只做形状映射：库搜索保持有界的候选，不在返回路径上重算整条路线。
 * 搜索期的风险策略在 `edgePolicy` 内执行并把诊断留在 `result.policy`；这里只复制事实，
 * 不把策略拒绝伪装成已观察碰撞。逐段当前证据复验仍是显式调用或执行层单步检查。
 */
function normalize(result: LibraryResult): LandSearchResult {
  const prefix = result.prefix === undefined ? undefined : hostPrefix(result.prefix);
  return {
    status: result.status,
    assurance: result.assurance,
    evidenceMode: result.evidenceMode === 'remembered' ? 'historical' : 'current',
    executable: false,
    needsRevalidation: true,
    from: { ...result.from },
    target: { ...result.target },
    arrival: { ...result.arrival },
    goalMetric: result.goalMetric,
    points: result.points.map((point) => ({ ...point })),
    transitions: result.transitions.map(hostTransition),
    cost: result.cost,
    boundaries: result.boundaries.map(hostBoundary),
    ...(result.policy === undefined ? {} : { policy: { ...result.policy, ...(result.policy.firstRejection === undefined ? {} : { firstRejection: { ...result.policy.firstRejection, from: { ...result.policy.firstRejection.from }, to: { ...result.policy.firstRejection.to } } }) } }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(result.corridorLimited === true ? { corridorLimited: true as const } : {}),
    unavailableSections: result.unavailableSections.map((key) => ({ ...key })),
    reason: result.reason,
    ...(result.budget === undefined ? {} : { budget: result.budget }),
    evaluatedAt: result.evaluatedAt,
    stats: result.stats,
    resolvedTarget: { ...result.target },
  };
}

/** 同步入口：库的有界 A*；不移动、不观察、不写记忆。 */
export function searchLandRoute(map: VoxelMap, request: LandSearchRequest, now = Date.now()): LandSearchResult {
  return normalize(librarySearchLandRoute(map, libraryRequest(request), now));
}

/**
 * 分片搜索每片的工作量上限。库默认 32 个读/边就让出一次，繁忙的事件循环里每次让出约要数毫秒，
 * 百余节点的搜索因此拖到半秒，期间视觉写入几乎必然作废它。单片时长仍由 maxSliceMs（默认 5ms）限制。
 */
const ASYNC_WORK_PER_SLICE = 4096;
/**
 * 搜索期间依赖的 Section 被新观测改变时，库返回 INVALIDATED 而不给结果。这是地图并发更新的
 * 一致性冲突，不是路线结论：用最新地图重跑同一请求，次数有界，并受原 signal / deadline 约束。
 */
const MAX_INVALIDATION_RERUNS = 3;

/** 分片入口：库在约 maxSliceMs 计算后让出事件循环；返回同样的宿主结果。 */
export async function searchLandRouteAsync(map: VoxelMap, request: LandSearchRequest, now = Date.now()): Promise<LandSearchResult> {
  const libRequest = libraryRequest({ maxWorkPerSlice: ASYNC_WORK_PER_SLICE, ...request });
  const startedAt = Date.now();
  let result = await librarySearchLandRouteAsync(map, libRequest, now);
  let invalidatedAttempts = 0;
  while (result.status === 'INVALIDATED' && invalidatedAttempts < MAX_INVALIDATION_RERUNS
    && request.signal?.aborted !== true && (request.deadlineMs === undefined || Date.now() < request.deadlineMs)) {
    invalidatedAttempts += 1;
    // 证据新鲜度按调用方的时间基准推进到重跑时刻。
    result = await librarySearchLandRouteAsync(map, libRequest, now + Date.now() - startedAt);
  }
  return { ...normalize(result), ...(invalidatedAttempts === 0 ? {} : { invalidatedAttempts }) };
}

/** 对已选路线逐段用当前证据复验；remembered 候选在执行前必须过这一关。 */
export function verifyLandRoute(map: VoxelMap, request: Pick<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'rules' | 'wade'> & {
  /** 执行前复验第一步的真实起点；计划落点保持不变。 */
  measuredStart?: Vec3Like;
}, transitions: readonly LandSearchTransition[], now = Date.now()): LandRouteVerification {
  const limits = resolveLandLimits();
  const results: LandRouteVerificationTransition[] = [];
  let openPrefix = 0;
  let verdict = 'OPEN';
  for (const transition of transitions) {
    const kind = transition.kind;
    const from = results.length === 0 ? request.measuredStart ?? transition.from : transition.from;
    const drifted = from.x !== transition.from.x || from.y !== transition.from.y || from.z !== transition.from.z;
    const check = checkTransition(map, request, kind, from, transition.to, limits, now, drifted ? transition.from : undefined);
    // 搜索层拒绝的危险格/非下落 hazard 也要在复验层保持一致，不能只靠 evaluate 的几何状态。
    const hazardBlocked = check.status === 'OPEN' && !safe(check, map, request.dim, from, transition.to, request.wade === true);
    const status = hazardBlocked ? 'BLOCKED' : check.status;
    const rejectedHazards = [...new Set(check.hazards.map((hazard) => hazard.kind)
      .filter((kind) => kind !== 'fall' && !(request.wade === true && kind === 'water_contact')))];
    const reason = hazardBlocked
      ? (rejectedHazards.length > 0 ? `路线经过不允许的 hazard（${rejectedHazards.join('、')}）` : undefined)
        ?? sweptDangerAt(map, request.dim, from, transition.to)
        ?? (waterAt(map, request.dim, { ...transition.to, y: transition.to.y + 1 }) ? '落点头部格已观察为水（会被淹没）'
          : request.wade !== true && waterAt(map, request.dim, transition.to) ? '落点脚部格已观察为水；本次委托没有允许涉水' : undefined)
        ?? '路线经过不允许的 hazard'
      : check.reason;
    results.push({
      transition, status,
      ...(reason === undefined ? {} : { reason }),
      hazards: check.hazards,
      ...(hazardBlocked
        ? { risk: true as const }
        : {
            ...(check.problem === undefined ? {} : { problem: check.problem }),
            ...(check.obstacle === undefined ? {} : { obstacle: { ...check.obstacle } }),
          }),
    });
    if (status === 'OPEN' && openPrefix === results.length - 1) openPrefix = results.length;
    else if (verdict === 'OPEN') verdict = status;
  }
  if (transitions.length === 0) openPrefix = 0;
  return { verdict, openPrefix, transitions: results };
}

/**
 * 兼容读取方的有界逐段复验：共享原 deadline，定期让出事件循环，取消/到期时
 * 返回已检查部分并标 INCOMPLETE；只有全部检查且全 OPEN 才可能得到 OPEN。
 */
export async function verifyLandRouteBounded(
  map: VoxelMap,
  request: Pick<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'rules'>,
  transitions: readonly LandSearchTransition[],
  opts: { deadlineMs: number; signal?: AbortSignal; now?: () => number; yieldEvery?: number },
): Promise<LandRouteVerification> {
  const now = opts.now ?? Date.now;
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 16);
  const results: LandRouteVerificationTransition[] = [];
  let openPrefix = 0;
  let verdict = 'OPEN';
  const partial = (checked: number, stopped: 'deadline' | 'cancelled'): LandRouteVerification => ({
    verdict: verdict === 'OPEN' && checked < transitions.length ? 'INCOMPLETE' : verdict,
    openPrefix,
    transitions: results,
    coverage: { checked, total: transitions.length, complete: false, stopped },
  });
  for (let index = 0; index < transitions.length; index++) {
    if (opts.signal?.aborted) return partial(results.length, 'cancelled');
    if (now() >= opts.deadlineMs) return partial(results.length, 'deadline');
    const transition = transitions[index]!;
    const entry = verifyLandRoute(map, request, [transition], now()).transitions[0]!;
    results.push({ ...entry, transition });
    if (entry.status === 'OPEN' && openPrefix === results.length - 1) openPrefix = results.length;
    else if (verdict === 'OPEN') verdict = entry.status;
    if ((index + 1) % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (opts.signal?.aborted) return partial(results.length, 'cancelled');
      if (now() >= opts.deadlineMs) return partial(results.length, 'deadline');
    }
  }
  return { verdict, openPrefix, transitions: results, coverage: { checked: results.length, total: transitions.length, complete: true } };
}
