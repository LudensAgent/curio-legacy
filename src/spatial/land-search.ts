import { supportTop } from '../perception/geometry.ts';
import {
  evaluateLandTransition,
  evaluateWalkStep,
  resolveLandLimits,
  type BodyContext,
  type CellEvidence,
  type HazardFact,
  type LandRules,
  type LandTransition,
  type Vec3Like,
  type VoxelMap,
} from 'curio-minecraft-3d-memory';

export type LandSearchStatus = 'FOUND' | 'NO_PATH' | 'UNKNOWN' | 'BUDGET_EXHAUSTED' | 'CANCELLED';
export type LandSearchKind = 'walk' | 'step' | 'drop';

export interface LandSearchTransition {
  kind: LandSearchKind;
  from: Vec3Like;
  to: Vec3Like;
  /** 实际下落格数；walk/step 为 0。 */
  drop: number;
}

export type LandBoundaryDirection = 'N' | 'E' | 'S' | 'W' | 'UP' | 'DOWN' | 'HERE';

export interface LandSearchBoundary {
  from: Vec3Like;
  to: Vec3Like;
  kind: LandSearchKind;
  status: string;
  reason?: string;
  /** 从 from 指向 to 的格子方向；水平优先，纯垂直时为 UP/DOWN。 */
  direction: LandBoundaryDirection;
}

/**
 * 失败搜索仍可执行的最远 approach：从起点出发、只经由当前证据 OPEN 的边可达。
 * 这是“已知可通行前缀”，不是到达；endpoint 之外的可通行性仍为 UNKNOWN。
 */
export interface LandSearchPrefix {
  endpoint: Vec3Like;
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  /** endpoint 到 resolvedTarget 的曼哈顿格距；>0 表示没有走到目标。 */
  distanceToTarget: number;
  /** endpoint 恰好落在解析目标格；仍不代表执行层已到达。 */
  atTarget: boolean;
  /** endpoint 就是请求起点：没有任何可走前缀。 */
  atStart: boolean;
  /**
   * 端点朝目标方向最近的边界若是 BLOCKED/UNSUPPORTED，如实标出该已知阻挡；
   * 此时自动前进不会带来新证据，调用方应先交回 blocker 事实。
   */
  knownBlockerAhead?: LandSearchBoundary;
}

/** 边界证据缺口分类；只给事实，不替调用方选择观察/挖/建动作。 */
export interface LandSearchBoundarySummary {
  total: number;
  counts: Record<string, number>;
  /** UNKNOWN/STALE/INCOMPLETE：额外观察或靠近可能刷新证据。 */
  observationMayResolve: boolean;
  /** BLOCKED/UNSUPPORTED：需要显式动作、其他移动能力或换路线。 */
  needsExplicitActionOrOtherRoute: boolean;
}

export interface LandSearchRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  /** 目标脚位；x/z 会被解析为目标格，y 是目标脚高。 */
  to: Vec3Like;
  /** 允许搜索的安全下落上限；默认 4。 */
  maxDrop?: number;
  /** 默认 2048。 */
  maxNodes?: number;
  /** 默认 8192。 */
  maxEdges?: number;
  /** Absolute epoch-ms deadline shared across passes. Overrides maxSearchMs. */
  deadlineMs?: number;
  /** Wall-clock budget when no absolute deadline; default 1500 ms. */
  maxSearchMs?: number;
  /** Clock used only for the time budget/duration; defaults to Date.now. */
  clock?: () => number;
  rules: LandRules;
  /** true 时用历史体素（含过期证据）做几何推导；输出必须标记为历史路线。 */
  allowStale?: boolean;
  signal?: AbortSignal;
}

export interface LandSearchResult {
  status: LandSearchStatus;
  assurance: 'geometry_only' | 'historical_geometry';
  evidenceMode: 'current' | 'historical';
  executable: false;
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  boundaries: LandSearchBoundary[];
  /** 非 FOUND 时给出的最远可达 approach；FOUND 时完整路线就是前缀，不需要重复。 */
  prefix?: LandSearchPrefix;
  cost: number;
  resolvedTarget: Vec3Like;
  /** 历史模式下用严格当前证据复验已选路线；OPEN/STALE/BLOCKED 逐段保留。 */
  verification?: LandRouteVerification;
  stats: {
    nodesExpanded: number;
    edgesEvaluated: number;
    openEdges: number;
    blockedEdges: number;
    unknownEdges: number;
    staleEdges: number;
    unsupportedEdges: number;
    maxNodes: number;
    maxEdges: number;
    maxSearchMs: number;
    durationMs: number;
    /** Why the search stopped at a bound; null when it finished on its own. */
    cancelReason: 'signal' | 'time' | 'nodes' | 'edges' | null;
    /** Distinct Sections read during this pass. */
    visitedSections: number;
    /** Calls that returned a Section view (live or snapshot). */
    sectionReads: number;
    /** `sectionAt` deep-copy calls; expected 0 after the SectionRef fix. */
    snapshotCount: number;
    /** `cellAt` evidence clones (one per cell read). */
    cloneCount: number;
    /** Times the async search yielded to the event loop. */
    yieldCount: number;
    /**
     * Longest uninterrupted compute slice (ms). For `searchLandRouteAsync` this is
     * real event-loop blocking; the sync entry drains the same slices without yielding.
     */
    maxSyncSliceMs: number;
  };
}

export interface LandRouteVerificationTransition {
  transition: LandSearchTransition;
  status: string;
  reason?: string;
  hazards: HazardFact[];
}

export interface LandRouteVerification {
  verdict: string;
  openPrefix: number;
  transitions: LandRouteVerificationTransition[];
}

const EPS = 1e-9;
/** Default wall-clock cap for one search pass; callers may share a shorter deadline. */
export const DEFAULT_LAND_SEARCH_MS = 1500;
/** Max synchronous compute between cooperative yields in the sliced (async) search. */
const YIELD_SLICE_MS = 8;
const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'pointed_dripstone']);
const cell = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 0.05), z: Math.floor(pos.z) });
const pointEqual = (a: Vec3Like, b: Vec3Like) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS && Math.abs(a.z - b.z) <= EPS;
const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** 边界方向：水平优先（drop 也先报水平侧），纯垂直时才报 UP/DOWN。 */
function directionOf(from: Vec3Like, to: Vec3Like): LandBoundaryDirection {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > EPS) return dx > 0 ? 'E' : 'W';
  if (Math.abs(dz) > EPS) return dz > 0 ? 'S' : 'N';
  const dy = to.y - from.y;
  return dy > EPS ? 'UP' : dy < -EPS ? 'DOWN' : 'HERE';
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
}

function dangerousAt(map: VoxelMap, dim: string, pos: Vec3Like): string | null {
  const p = cell(pos);
  const view = map.cellAt(dim, p.x, p.y, p.z);
  if (!view.observed) return null;
  const name = view.evidence.observation.state.name.replace(/^minecraft:/, '');
  return DANGER.has(name) ? name : null;
}

/** walk 用同高判定器；step/drop 用库的 land transition 判定器。 */
function checkTransition(
  map: VoxelMap,
  request: Pick<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'rules'>,
  kind: LandSearchKind,
  from: Vec3Like,
  to: Vec3Like,
  limits: ReturnType<typeof resolveLandLimits>,
  now: number,
): Check {
  const body = { ...request.body, feet: { ...from } };
  if (kind === 'walk') {
    const dx = to.x - from.x, dz = to.z - from.z;
    const direction = Math.abs(dx) > EPS
      ? { axis: 'x' as const, sign: Math.sign(dx) as 1 | -1 }
      : { axis: 'z' as const, sign: Math.sign(dz) as 1 | -1 };
    const evaluation = evaluateWalkStep(map, {
      worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
      mode: 'walk', body, direction,
    }, request.rules.shapeProvider, now);
    return { status: evaluation.status, ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }), hazards: evaluation.hazards ?? [] };
  }
  const transition: LandTransition = { kind, from: { ...from }, to: { ...to } };
  const evaluation = evaluateLandTransition(map, {
    worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
    body, transition,
  }, request.rules, now, limits);
  return {
    status: evaluation.status,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason.detail }),
    hazards: evaluation.hazards,
  };
}

function safe(check: Check, map: VoxelMap, dim: string, to: Vec3Like): boolean {
  if (check.status !== 'OPEN') return false;
  // fall 是声明出来的下落事实，允许；其余 hazard 不走进。
  if (check.hazards.some((hazard) => hazard.kind !== 'fall')) return false;
  return dangerousAt(map, dim, to) === null
    && dangerousAt(map, dim, { ...to, y: to.y + 1 }) === null
    && dangerousAt(map, dim, { ...to, y: to.y - 1 }) === null;
}

class MinHeap {
  private readonly items: { key: string; f: number }[] = [];
  push(item: { key: string; f: number }) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.f <= this.items[i]!.f) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }
  pop(): { key: string; f: number } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (first === undefined || last === undefined) return first;
    if (this.items.length === 0) return first;
    this.items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1, right = left + 1;
      let best = i;
      if (left < this.items.length && this.items[left]!.f < this.items[best]!.f) best = left;
      if (right < this.items.length && this.items[right]!.f < this.items[best]!.f) best = right;
      if (best === i) break;
      [this.items[i], this.items[best]] = [this.items[best]!, this.items[i]!];
      i = best;
    }
    return first;
  }
  get size() { return this.items.length; }
}

/**
 * 一列里真实可站立面的脚高。不是按整数层猜，而是读已观察方块的碰撞顶面，
 * 包括 0.5 半砖、0.875 雪层、箱子/台阶顶面；0 < drop < 1 也保留。
 * 严格模式跳过过期/旧会话/状态不完整的证据；历史模式允许过期证据但用它推导。
 */
function standableSurfaces(
  map: VoxelMap, dim: string,
  x: number, z: number, centerY: number, down: number, up: number,
): { y: number; top: number }[] {
  const min = Math.floor(centerY - down) - 1;
  const max = Math.ceil(centerY + up) + 1;
  const out: { y: number; top: number }[] = [];
  const seen = new Set<string>();
  for (let y = min; y <= max; y++) {
    const view = map.cellAt(dim, x, y, z);
    if (!view.observed) continue;
    const evidence = view.evidence;
    if (!evidence.observation.stateComplete) continue;
    const top = supportTop(evidence.observation.state.name.replace(/^minecraft:/, ''), evidence.observation.state.properties);
    if (top === null) continue;
    const foot = y + top;
    if (foot < centerY - down - 0.01 || foot > centerY + up + 0.01) continue;
    const key = foot.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ y: foot, top });
  }
  return out;
}

/**
 * 历史体素视图：只读地把已记录但过期/旧会话的证据视为可供几何推导的观察。
 * 不写回 VoxelMap、不改 observedAt；结果必须由调用方标记为历史路线，并由真实
 * 当前证据复验后再执行。没有记录过的格子仍保持 unobserved，不做外推。
 */
function historicalMapView(map: VoxelMap, sessionId: string, now: number): VoxelMap {
  type Section = { readonly revision: number; readonly evidence: ReadonlyMap<number, Readonly<CellEvidence>> };
  // 按 Section 键 + revision 缓存。live section ref 每次都是新对象，用对象身份做 WeakMap
  // 键永远命不中，会让每一次格子读取都重建整段证据 Map。
  const views = new Map<string, Section>();
  const viewOf = (dim: string, x: number, y: number, z: number): Section | null => {
    const section = map.sectionRef(dim, x, y, z);
    if (section === null) return null;
    const id = `${dim}|${x >> 4},${z >> 4},${y >> 4}`;
    const cached = views.get(id);
    if (cached !== undefined && cached.revision === section.revision) return cached;
    const evidence = new Map<number, CellEvidence>();
    for (const [index, cell] of section.evidence) {
      const historical = cell.freshness === 'STALE' || cell.observation.sessionId !== sessionId || now > cell.validUntil;
      if (!historical) {
        evidence.set(index, cell);
        continue;
      }
      const { staleReason: _staleReason, ...rest } = cell;
      evidence.set(index, {
        ...rest,
        freshness: 'FRESH',
        validUntil: Number.POSITIVE_INFINITY,
        observation: { ...cell.observation, sessionId },
      });
    }
    const view = Object.create(section) as Section;
    Object.defineProperty(view, 'evidence', { value: evidence });
    views.set(id, view);
    return view;
  };
  return {
    worldId: map.worldId,
    sectionRef: (dim: string, x: number, y: number, z: number) => viewOf(dim, x, y, z),
    // 只用于只读求值；证据 Map 是副本，其余数组仍共享只读视图，不能写回。
    sectionAt: (dim: string, x: number, y: number, z: number) => viewOf(dim, x, y, z),
    sectionResidency: (key: Parameters<VoxelMap['sectionResidency']>[0]) => map.sectionResidency(key),
    residencyGeneration: (dim: string, cx: number, cz: number, sy: number) => map.residencyGeneration(dim, cx, cz, sy),
    cellAt: (dim: string, x: number, y: number, z: number) => map.cellAt(dim, x, y, z),
  } as unknown as VoxelMap;
}

/**
 * Read-only wrapper that counts Section views and per-cell evidence clones. It
 * delegates to the live map and never writes; evaluators only need these six
 * entry points. Counters make the deep-copy regression observable.
 */
function trackLandReads(
  map: VoxelMap,
  visited: Set<string>,
  stats: { sectionReads: number; snapshotCount: number; cloneCount: number },
): VoxelMap {
  const keyOfSection = (dim: string, x: number, y: number, z: number): string =>
    `${dim}|${x >> 4},${y >> 4},${z >> 4}`;
  return {
    worldId: map.worldId,
    sectionRef: (dim: string, x: number, y: number, z: number) => {
      stats.sectionReads += 1;
      visited.add(keyOfSection(dim, x, y, z));
      return map.sectionRef(dim, x, y, z);
    },
    sectionAt: (dim: string, x: number, y: number, z: number) => {
      stats.sectionReads += 1;
      stats.snapshotCount += 1;
      visited.add(keyOfSection(dim, x, y, z));
      return map.sectionAt(dim, x, y, z);
    },
    cellAt: (dim: string, x: number, y: number, z: number) => {
      stats.cloneCount += 1;
      return map.cellAt(dim, x, y, z);
    },
    sectionResidency: (key) => map.sectionResidency(key),
    residencyGeneration: (dim, cx, cz, sy) => map.residencyGeneration(dim, cx, cz, sy),
  } as unknown as VoxelMap;
}

/**
 * 在已观测 VoxelMap 上做有界 3D A*：节点是脚格，边是 walk（同高 ±1 X/Z）、
 * step（上一级 ±1 X/Z）、drop（下一格到 maxDrop 格、±1 X/Z）。
 * 默认只走当前证据 OPEN 的边；allowStale 时允许用历史体素推导候选路线，
 * 但结果标记为 historical，并用严格当前证据附上逐段复验。不挖、不放、不探索。
 */
function* searchLandRouteChunks(map: VoxelMap, request: LandSearchRequest, now = Date.now()): Generator<void, LandSearchResult, void> {
  const evidenceMode = request.allowStale === true ? 'historical' as const : 'current' as const;
  const assurance = evidenceMode === 'historical' ? 'historical_geometry' as const : 'geometry_only' as const;
  const maxNodes = request.maxNodes ?? 2048;
  const maxEdges = request.maxEdges ?? 8192;
  const maxSearchMs = request.maxSearchMs ?? DEFAULT_LAND_SEARCH_MS;
  if (!Number.isFinite(maxSearchMs) || maxSearchMs <= 0) {
    throw new Error(`maxSearchMs must be a positive finite number: ${String(maxSearchMs)}`);
  }
  if (request.deadlineMs !== undefined && !Number.isFinite(request.deadlineMs)) {
    throw new Error(`deadlineMs must be a finite epoch time: ${String(request.deadlineMs)}`);
  }
  const clock = request.clock ?? Date.now;
  const startedAt = clock();
  const deadlineMs = request.deadlineMs ?? startedAt + maxSearchMs;
  const maxDrop = request.maxDrop ?? 4;
  const limits = resolveLandLimits();
  const start = request.body.feet;
  const startCell = { x: Math.floor(start.x), z: Math.floor(start.z) };
  // 规划节点按格心摆放，而不是沿用身体在格内的实际偏移。身体宽 0.6，站在格边
  // （例如 z=-251.93 落在 -252 格内、身体 AABB 压进 -253 的墙角）时，任何一次
  // 相邻移动都会在评估里蹭到斜角方块，把整条路误判成 NO_PATH；而人只要先回到
  // 格心就能正常迈步。执行层仍从实测位置出发，并在相邻一步前归位。
  const startStance: Vec3Like = { x: startCell.x + 0.5, y: start.y, z: startCell.z + 0.5 };
  const targetCell = { x: Math.floor(request.to.x), z: Math.floor(request.to.z) };
  // 站立格目标的 y 可能写的是方块 y 或略偏；吸附到该列真实可站立顶面
  // （半砖/雪层/台阶/箱子顶），不按整数层硬套。容器/门/床仍应由 go_near 处理。
  const visitedSections = new Set<string>();
  const stats = {
    nodesExpanded: 0, edgesEvaluated: 0, openEdges: 0, blockedEdges: 0, unknownEdges: 0,
    staleEdges: 0, unsupportedEdges: 0, maxNodes, maxEdges, maxSearchMs, durationMs: 0,
    cancelReason: null as 'signal' | 'time' | 'nodes' | 'edges' | null,
    visitedSections: 0, sectionReads: 0, snapshotCount: 0, cloneCount: 0,
    yieldCount: 0, maxSyncSliceMs: 0,
  };
  const baseMap = trackLandReads(map, visitedSections, stats);
  const traversability = evidenceMode === 'historical' ? historicalMapView(baseMap, request.sessionId, now) : baseMap;
  // 分片边界：记录最长一段没有让出事件循环的同步计算。仅 async 调用方真正让出。
  let sliceStart = startedAt;
  const noteYield = (): void => {
    const at = clock();
    stats.maxSyncSliceMs = Math.max(stats.maxSyncSliceMs, at - sliceStart);
    sliceStart = at;
    stats.yieldCount += 1;
  };
  const finishStats = (): void => {
    stats.durationMs = Math.max(0, clock() - startedAt);
    stats.maxSyncSliceMs = Math.max(stats.maxSyncSliceMs, clock() - sliceStart);
    stats.visitedSections = visitedSections.size;
  };
  const stopReason = (): 'signal' | 'time' | null =>
    request.signal?.aborted === true ? 'signal' : clock() >= deadlineMs ? 'time' : null;
  const targetSurfaces = standableSurfaces(baseMap, request.dim, targetCell.x, targetCell.z, request.to.y, 2, 2);
  const targetY = targetSurfaces.length === 0 ? request.to.y
    : targetSurfaces.reduce((best, surface) => Math.abs(surface.y - request.to.y) < Math.abs(best - request.to.y) ? surface.y : best, targetSurfaces[0]!.y);
  const resolvedTarget: Vec3Like = { x: targetCell.x + 0.5, y: targetY, z: targetCell.z + 0.5 };
  const stanceFor = (x: number, y: number, z: number): Vec3Like => ({ x: x + 0.5, y, z: z + 0.5 });
  const heuristic = (x: number, y: number, z: number) =>
    Math.abs(x - targetCell.x) + Math.abs(z - targetCell.z) + Math.abs(y - targetY) * 2;
  const boundaries: LandSearchBoundary[] = [];

  const startKey = keyOf(startCell.x, start.y, startCell.z);
  if (startCell.x === targetCell.x && startCell.z === targetCell.z && Math.abs(start.y - targetY) <= EPS) {
    finishStats();
    return { status: 'FOUND', assurance, evidenceMode, executable: false, points: [{ ...startStance }], transitions: [], boundaries, cost: 0, resolvedTarget: { ...startStance }, stats };
  }

  const nodes = new Map<string, { cx: number; cy: number; cz: number; g: number; parent: string | null; via: LandSearchTransition | null; stance: Vec3Like }>();
  const best = new Map<string, number>();
  const open = new MinHeap();
  nodes.set(startKey, { cx: startCell.x, cy: start.y, cz: startCell.z, g: 0, parent: null, via: null, stance: { ...startStance } });
  best.set(startKey, 0);
  open.push({ key: startKey, f: heuristic(startCell.x, start.y, startCell.z) });
  let found: string | null = null;
  let budget = false;

  // 失败/取消时的 approach：nodes 里的每个节点都只经由 OPEN 边加入，所以都可从起点到达。
  // 取 heuristic 最小（离解析目标最近、即朝目标推进最远）的节点，附带 parent 链过渡。
  const prefixOf = (key: string): LandSearchPrefix | undefined => {
    const endpoint = nodes.get(key);
    if (endpoint === undefined) return undefined;
    const points: Vec3Like[] = [];
    const transitions: LandSearchTransition[] = [];
    let cursor: typeof endpoint | undefined = endpoint;
    while (cursor !== undefined) {
      points.unshift({ ...cursor.stance });
      if (cursor.via !== null) transitions.unshift(cursor.via);
      cursor = cursor.parent === null ? undefined : nodes.get(cursor.parent);
    }
    const cellDistance = Math.abs(endpoint.cx - targetCell.x) + Math.abs(endpoint.cz - targetCell.z);
    const vertical = Math.abs(endpoint.cy - targetY);
    // 朝目标方向（曼哈顿距离更近）的已观测阻挡/不支持边界；侧向边界不计。
    const closeness = (p: Vec3Like) => Math.abs(Math.floor(p.x) - targetCell.x) + Math.abs(Math.floor(p.z) - targetCell.z) + Math.abs(p.y - targetY) * 2;
    const endpointCloseness = closeness(endpoint.stance);
    const knownBlockerAhead = boundaries.find((boundary) =>
      pointEqual(boundary.from, endpoint.stance)
      && (boundary.status === 'BLOCKED' || boundary.status === 'UNSUPPORTED')
      && closeness(boundary.to) < endpointCloseness
    );
    return {
      endpoint: { ...endpoint.stance },
      points,
      transitions,
      distanceToTarget: Math.round((cellDistance + vertical) * 1000) / 1000,
      atTarget: cellDistance === 0 && vertical <= EPS,
      atStart: key === startKey,
      ...(knownBlockerAhead === undefined ? {} : { knownBlockerAhead }),
    };
  };
  const closestToTarget = (): string => {
    let chosen = startKey;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [key, node] of nodes) {
      const distance = heuristic(node.cx, node.cy, node.cz);
      if (distance < bestDistance || (distance === bestDistance && node.g < bestCost)) {
        chosen = key;
        bestDistance = distance;
        bestCost = node.g;
      }
    }
    return chosen;
  };
  const prefixFacts = (): { prefix?: LandSearchPrefix } => {
    const prefix = prefixOf(closestToTarget());
    return prefix === undefined ? {} : { prefix };
  };

  while (open.size > 0) {
    const stopped = stopReason();
    if (stopped !== null) {
      if (stopped === 'signal') {
        stats.cancelReason = 'signal';
      } else {
        budget = true;
        stats.cancelReason = 'time';
      }
      if (stopped === 'signal') {
        finishStats();
        return { status: 'CANCELLED', assurance, evidenceMode, executable: false, points: [], transitions: [], boundaries, ...prefixFacts(), cost: 0, resolvedTarget, stats };
      }
      break;
    }
    const head = open.pop()!;
    const node = nodes.get(head.key);
    if (node === undefined) continue;
    if ((best.get(head.key) ?? Infinity) < node.g) continue;
    if (node.cx === targetCell.x && node.cz === targetCell.z && Math.abs(node.cy - targetY) <= EPS) { found = head.key; break; }
    stats.nodesExpanded += 1;
    if (stats.nodesExpanded >= maxNodes) { budget = true; stats.cancelReason = 'nodes'; break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = node.cx + dx, nz = node.cz + dz;
      // 候选高度来自这一列真实可站立面，而不是 node.cy ± 整数：
      // 这样半砖 0.5、雪层 0.875、台阶/箱子顶、0<drop<1 都能成为边。
      const surfaces = standableSurfaces(baseMap, request.dim, nx, nz, node.cy, maxDrop, 1.01);
      const candidates: { kind: LandSearchKind; ny: number; drop: number; cost: number }[] = [];
      for (const surface of surfaces) {
        const dy = surface.y - node.cy;
        if (Math.abs(dy) <= 0.01) candidates.push({ kind: 'walk', ny: surface.y, drop: 0, cost: 1 });
        else if (dy > 0 && dy <= 1.01) candidates.push({ kind: 'step', ny: surface.y, drop: 0, cost: 2 + dy });
        else if (dy < 0 && -dy <= maxDrop + 0.01) candidates.push({ kind: 'drop', ny: surface.y, drop: -dy, cost: 2 + -dy });
      }
      // 整列没有已观察的可站立面：不能静默当作“没有边”。留下未知边界，
      // 让上层区分“需要观察/靠近”和“已观察地形明确阻塞”。
      if (candidates.length === 0) {
        stats.unknownEdges += 1;
        if (boundaries.length < 64) {
          const to = stanceFor(nx, node.cy, nz);
          boundaries.push({
            from: { ...node.stance }, to, kind: 'walk', direction: directionOf(node.stance, to),
            status: 'UNKNOWN', reason: 'no observed standable surface in this column',
          });
        }
      }
      for (const candidate of candidates) {
        if (stats.edgesEvaluated >= maxEdges) { budget = true; stats.cancelReason = 'edges'; break; }
        const edgeStop = stopReason();
        if (edgeStop !== null) {
          if (edgeStop === 'signal') {
            stats.cancelReason = 'signal';
            finishStats();
            return { status: 'CANCELLED', assurance, evidenceMode, executable: false, points: [], transitions: [], boundaries, ...prefixFacts(), cost: 0, resolvedTarget, stats };
          }
          budget = true; stats.cancelReason = 'time'; break;
        }
        const to = nx === targetCell.x && nz === targetCell.z && Math.abs(candidate.ny - targetY) <= EPS
          ? { ...resolvedTarget }
          : stanceFor(nx, candidate.ny, nz);
        const check = checkTransition(traversability, request, candidate.kind, node.stance, to, limits, now);
        stats.edgesEvaluated += 1;
        if (check.status === 'OPEN') stats.openEdges += 1;
        else if (check.status === 'BLOCKED') stats.blockedEdges += 1;
        else if (check.status === 'UNKNOWN' || check.status === 'INCOMPLETE') stats.unknownEdges += 1;
        else if (check.status === 'STALE') stats.staleEdges += 1;
        else stats.unsupportedEdges += 1;
        if (!safe(check, baseMap, request.dim, to)) {
          if (boundaries.length < 64) boundaries.push({ from: { ...node.stance }, to, kind: candidate.kind, direction: directionOf(node.stance, to), status: check.status, ...(check.reason === undefined ? {} : { reason: check.reason }) });
          continue;
        }
        const key = keyOf(nx, candidate.ny, nz);
        const g = node.g + candidate.cost;
        if (g >= (best.get(key) ?? Infinity)) continue;
        best.set(key, g);
        const via: LandSearchTransition = { kind: candidate.kind, from: { ...node.stance }, to, drop: candidate.drop };
        nodes.set(key, { cx: nx, cy: candidate.ny, cz: nz, g, parent: head.key, via, stance: to });
        open.push({ key, f: g + heuristic(nx, candidate.ny, nz) });
      }
      if (budget) break;
    }
    if (budget) break;
    // 分批让出：async 调用方据此保持事件循环；sync 调用方只记录切片长度。
    if (clock() - sliceStart >= YIELD_SLICE_MS) {
      noteYield();
      yield;
    }
  }

  if (found === null) {
    // STALE 和 UNKNOWN 都是“证据不足”，不是“已观测地形断连”。把 stale 当成
    // NO_PATH 会让上层误报“没有路”，其实只需要重新观察刷新证据。
    const status: LandSearchStatus = budget ? 'BUDGET_EXHAUSTED' : (stats.unknownEdges > 0 || stats.staleEdges > 0) ? 'UNKNOWN' : 'NO_PATH';
    finishStats();
    return { status, assurance, evidenceMode, executable: false, points: [], transitions: [], boundaries, ...prefixFacts(), cost: 0, resolvedTarget, stats };
  }

  const points: Vec3Like[] = [];
  const transitions: LandSearchTransition[] = [];
  let cursor: string | null = found;
  while (cursor !== null) {
    const node = nodes.get(cursor);
    if (node === undefined) break;
    points.unshift({ ...node.stance });
    if (node.via !== null) transitions.unshift(node.via);
    cursor = node.parent;
  }
  finishStats();
  return {
    status: 'FOUND', assurance, evidenceMode, executable: false, points, transitions, boundaries,
    cost: nodes.get(found)!.g, resolvedTarget, stats,
    ...(evidenceMode === 'historical' ? { verification: verifyLandRoute(map, request, transitions, now) } : {}),
  };
}

/** 同步入口：内部仍是有界 A*；脚本、基准和需要同步结果的调用方使用。 */
export function searchLandRoute(map: VoxelMap, request: LandSearchRequest, now = Date.now()): LandSearchResult {
  const chunks = searchLandRouteChunks(map, request, now);
  let step = chunks.next();
  while (!step.done) step = chunks.next();
  return step.value;
}

/**
 * 分片入口：每约 8ms 计算让出一次事件循环，长搜索不再独占主线程。
 * 取消仍按节点/边和期限检查；返回结果与同步入口一致。
 */
export async function searchLandRouteAsync(map: VoxelMap, request: LandSearchRequest, now = Date.now()): Promise<LandSearchResult> {
  const chunks = searchLandRouteChunks(map, request, now);
  let step = chunks.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = chunks.next();
  }
  return step.value;
}

/** 对已选路线逐段复验；walk 用同高判定，step/drop 用 land transition 判定。 */
export function verifyLandRoute(map: VoxelMap, request: Pick<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'rules'>, transitions: readonly LandSearchTransition[], now = Date.now()): LandRouteVerification {
  const limits = resolveLandLimits();
  const results: LandRouteVerificationTransition[] = [];
  let openPrefix = 0;
  let verdict = 'OPEN';
  for (const transition of transitions) {
    const check = checkTransition(map, request, transition.kind, transition.from, transition.to, limits, now);
    // 搜索层拒绝的危险格/非下落 hazard 也要在复验层保持一致，不能只靠 evaluate 的几何状态。
    const hazardBlocked = check.status === 'OPEN' && !safe(check, map, request.dim, transition.to);
    const status = hazardBlocked ? 'BLOCKED' : check.status;
    const reason = hazardBlocked
      ? dangerousAt(map, request.dim, transition.to)
        ?? dangerousAt(map, request.dim, { ...transition.to, y: transition.to.y + 1 })
        ?? dangerousAt(map, request.dim, { ...transition.to, y: transition.to.y - 1 })
        ?? '路线经过不允许的 hazard'
      : check.reason;
    results.push({ transition, status, ...(reason === undefined ? {} : { reason }), hazards: check.hazards });
    if (status === 'OPEN' && openPrefix === results.length - 1) openPrefix = results.length;
    else if (verdict === 'OPEN') verdict = status;
  }
  if (transitions.length === 0) openPrefix = 0;
  return { verdict, openPrefix, transitions: results };
}

export { pointEqual };
