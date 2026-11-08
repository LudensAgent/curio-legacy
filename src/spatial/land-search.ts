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

export interface LandSearchBoundary {
  from: Vec3Like;
  to: Vec3Like;
  kind: LandSearchKind;
  status: string;
  reason?: string;
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
const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'pointed_dripstone']);
const cell = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 0.05), z: Math.floor(pos.z) });
const pointEqual = (a: Vec3Like, b: Vec3Like) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS && Math.abs(a.z - b.z) <= EPS;
const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

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
 * 历史体素视图：只读地把已记录但过期/旧会话的证据视为可供几何推导的观察。
 * 不写回 VoxelMap、不改 observedAt；结果必须由调用方标记为历史路线，并由真实
 * 当前证据复验后再执行。没有记录过的格子仍保持 unobserved，不做外推。
 */
function historicalMapView(map: VoxelMap, sessionId: string, now: number): VoxelMap {
  type Section = { readonly revision: number; readonly evidence: ReadonlyMap<number, Readonly<CellEvidence>> };
  const views = new WeakMap<object, Section>();
  const viewOf = (section: Section | null): Section | null => {
    if (section === null) return null;
    const cached = views.get(section);
    if (cached !== undefined) return cached;
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
    views.set(section, view);
    return view;
  };
  return {
    worldId: map.worldId,
    sectionRef: (dim: string, x: number, y: number, z: number) => viewOf(map.sectionRef(dim, x, y, z)),
    sectionAt: (dim: string, x: number, y: number, z: number) => viewOf(map.sectionAt(dim, x, y, z)),
    sectionResidency: (key: Parameters<VoxelMap['sectionResidency']>[0]) => map.sectionResidency(key),
    residencyGeneration: (dim: string, cx: number, cz: number, sy: number) => map.residencyGeneration(dim, cx, cz, sy),
    cellAt: (dim: string, x: number, y: number, z: number) => map.cellAt(dim, x, y, z),
  } as unknown as VoxelMap;
}

/**
 * 在已观测 VoxelMap 上做有界 3D A*：节点是脚格，边是 walk（同高 ±1 X/Z）、
 * step（上一级 ±1 X/Z）、drop（下一格到 maxDrop 格、±1 X/Z）。
 * 默认只走当前证据 OPEN 的边；allowStale 时允许用历史体素推导候选路线，
 * 但结果标记为 historical，并用严格当前证据附上逐段复验。不挖、不放、不探索。
 */
export function searchLandRoute(map: VoxelMap, request: LandSearchRequest, now = Date.now()): LandSearchResult {
  const evidenceMode = request.allowStale === true ? 'historical' as const : 'current' as const;
  const assurance = evidenceMode === 'historical' ? 'historical_geometry' as const : 'geometry_only' as const;
  const traversability = evidenceMode === 'historical' ? historicalMapView(map, request.sessionId, now) : map;
  const maxNodes = request.maxNodes ?? 2048;
  const maxEdges = request.maxEdges ?? 8192;
  const maxDrop = request.maxDrop ?? 4;
  const limits = resolveLandLimits();
  const start = request.body.feet;
  const startCell = { x: Math.floor(start.x), z: Math.floor(start.z) };
  const targetCell = { x: Math.floor(request.to.x), z: Math.floor(request.to.z) };
  const targetY = request.to.y;
  const resolvedTarget: Vec3Like = {
    x: start.x + (targetCell.x - startCell.x),
    y: targetY,
    z: start.z + (targetCell.z - startCell.z),
  };
  const stanceFor = (x: number, y: number, z: number): Vec3Like => x === startCell.x && z === startCell.z && y === start.y
    ? { ...start }
    : { x: start.x + (x - startCell.x), y, z: start.z + (z - startCell.z) };
  const heuristic = (x: number, y: number, z: number) =>
    Math.abs(x - targetCell.x) + Math.abs(z - targetCell.z) + Math.abs(y - targetY) * 2;
  const stats = { nodesExpanded: 0, edgesEvaluated: 0, openEdges: 0, blockedEdges: 0, unknownEdges: 0, staleEdges: 0, unsupportedEdges: 0, maxNodes, maxEdges };
  const boundaries: LandSearchBoundary[] = [];

  const startKey = keyOf(startCell.x, start.y, startCell.z);
  if (startCell.x === targetCell.x && startCell.z === targetCell.z && Math.abs(start.y - targetY) <= EPS) {
    return { status: 'FOUND', assurance, evidenceMode, executable: false, points: [{ ...start }], transitions: [], boundaries, cost: 0, resolvedTarget: { ...start }, stats };
  }

  const nodes = new Map<string, { cx: number; cy: number; cz: number; g: number; parent: string | null; via: LandSearchTransition | null; stance: Vec3Like }>();
  const best = new Map<string, number>();
  const open = new MinHeap();
  nodes.set(startKey, { cx: startCell.x, cy: start.y, cz: startCell.z, g: 0, parent: null, via: null, stance: { ...start } });
  best.set(startKey, 0);
  open.push({ key: startKey, f: heuristic(startCell.x, start.y, startCell.z) });
  let found: string | null = null;
  let budget = false;

  while (open.size > 0) {
    if (request.signal?.aborted) return { status: 'CANCELLED', assurance, evidenceMode, executable: false, points: [], transitions: [], boundaries, cost: 0, resolvedTarget, stats };
    const head = open.pop()!;
    const node = nodes.get(head.key);
    if (node === undefined) continue;
    if ((best.get(head.key) ?? Infinity) < node.g) continue;
    if (node.cx === targetCell.x && node.cz === targetCell.z && Math.abs(node.cy - targetY) <= EPS) { found = head.key; break; }
    stats.nodesExpanded += 1;
    if (stats.nodesExpanded >= maxNodes) { budget = true; break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = node.cx + dx, nz = node.cz + dz;
      const candidates: { kind: LandSearchKind; ny: number; drop: number; cost: number }[] = [
        { kind: 'walk', ny: node.cy, drop: 0, cost: 1 },
        { kind: 'step', ny: node.cy + 1, drop: 0, cost: 2 },
        ...Array.from({ length: maxDrop }, (_, i) => ({ kind: 'drop' as const, ny: node.cy - (i + 1), drop: i + 1, cost: 2 + i })),
      ];
      for (const candidate of candidates) {
        if (stats.edgesEvaluated >= maxEdges) { budget = true; break; }
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
        if (!safe(check, map, request.dim, to)) {
          if (boundaries.length < 64) boundaries.push({ from: { ...node.stance }, to, kind: candidate.kind, status: check.status, ...(check.reason === undefined ? {} : { reason: check.reason }) });
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
  }

  if (found === null) {
    // STALE 和 UNKNOWN 都是“证据不足”，不是“已观测地形断连”。把 stale 当成
    // NO_PATH 会让上层误报“没有路”，其实只需要重新观察刷新证据。
    const status: LandSearchStatus = budget ? 'BUDGET_EXHAUSTED' : (stats.unknownEdges > 0 || stats.staleEdges > 0) ? 'UNKNOWN' : 'NO_PATH';
    return { status, assurance, evidenceMode, executable: false, points: [], transitions: [], boundaries, cost: 0, resolvedTarget, stats };
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
  return {
    status: 'FOUND', assurance, evidenceMode, executable: false, points, transitions, boundaries,
    cost: nodes.get(found)!.g, resolvedTarget, stats,
    ...(evidenceMode === 'historical' ? { verification: verifyLandRoute(map, request, transitions, now) } : {}),
  };
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
