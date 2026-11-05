/**
 * walk_route：显式短路线步行（普通干燥整块、同高、沿 X/Z、无施工）。
 * 通过库的 WalkRouteExecutor 复用路线验证与单段编排；身体桥走适配器的实测物理帧，
 * 不调用会重新寻路的 moveTo。到达语义由库的 bodyArrival 判定。
 * 地图由合法视锥观测喂 VoxelMap：初始扫描路线格，移动中持续更新当前身体周边格。
 * 观测遵守 Vision 的批次限制（≤32 格/次），变化报告整批合并喂给地图，不丢支撑拆除通知。
 */

import { randomUUID } from 'node:crypto';
import { GROUNDED_ARRIVAL_DEFAULTS } from 'curio-minecraft-3d-memory';
import type {
  ChangeReport,
  KnownWalkRouteStart,
  NavResult,
  Observation,
  SectionKey,
  Vec3Like,
  VoxelMap,
  WalkRouteExecutor,
  WalkRouteRequest,
} from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../adapter/walk-route.ts';
import type { WalkBody, WalkMoveRequestObservation, WalkTick } from '../adapter/walk-route.ts';
import type { SharedSpatialSession } from '../spatial/shared-session.ts';
import {
  acquireRouteResidency,
  releaseRouteResidency,
  residencyFacts,
  routeDependencySections,
} from '../spatial/skill-residency.ts';
import type { RouteResidency } from '../spatial/skill-residency.ts';
import type { BlockObservation } from '../adapter/types.ts';
import { fail, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';

interface WalkRouteArgs {
  points: Vec3Like[];
  deadlineMs?: number;
}

/**
 * walk_route 的父委托外壳：原请求、经校验的解析目标与唯一执行后端。
 * 成功、失败、取消、限期都保留同一份外壳；库的 NavResult 另放 data.nav。
 */
export interface WalkRouteBase {
  originalRequest: { points: Vec3Like[]; deadlineMs?: number };
  resolvedTarget: Vec3Like;
  backend: 'library_walk_route';
}

/** 终态 top-level stage：路由证据失效优先于泛化的 FAILED/BLOCKED 结局。 */
export function navStage(nav: NavResult): string {
  return nav.problem?.kind === 'route_invalidated' ? 'route_invalidated' : nav.outcome;
}

/**
 * 导航入口的参数边界：未知选项必须显式拒绝，不能静默丢弃。
 * 本轮只执行调用者给定的同高、无施工步行路线；`avoid`/`dig`/`place`/`tower`/
 * `materials` 等能力尚未贯通到这里，给了非空值就如实报缺口。显式的空 `avoid`/
 * `materials` 或不开启的 dig/place/tower 不请求额外手段，按无操作接受。
 */
export function unsupportedNavOption(skill: string, options: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue;
    const value = options[key];
    const empty = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
    if ((key === 'avoid' || key === 'materials') && empty) continue;
    if ((key === 'dig' || key === 'place' || key === 'tower') && value !== true) continue;
    const shown = typeof value === 'string' ? value.slice(0, 40) : (JSON.stringify(value) ?? String(value)).slice(0, 80);
    const capability = key === 'avoid' ? '（本入口不会另选绕行路线）'
      : key === 'dig' || key === 'place' || key === 'tower' || key === 'materials' ? '（本入口不做挖掘、放置、搭柱或耗材）' : '';
    return `${skill} 不支持参数 ${key}=${shown}${capability}；请移除该参数，或改用明确授权这些手段的入口`;
  }
  return null;
}

/** 每个结果都带同一份父委托外壳；resolvedTarget 是已校验路线的末点。 */
function walkRouteBase(args: WalkRouteArgs): WalkRouteBase {
  return {
    originalRequest: {
      points: args.points.map((point) => ({ x: point.x, y: point.y, z: point.z })),
      ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
    },
    resolvedTarget: { ...args.points[args.points.length - 1]! },
    backend: 'library_walk_route',
  };
}

/** 本轮能力上限：短路线，单轴相邻一格。 */
const MAX_POINTS = 32;

/** 把一次合法视锥观测映射成库的 Observation。 */
function toObservation(b: BlockObservation): Observation {
  // 库要求 state.properties 为 Record<string,string>；本边界把 boolean/number
  // 统一成语义字符串（如 open→'true'、level→'3'），不猜测、不补默认值。
  const properties = Object.fromEntries(Object.entries(b.properties ?? {}).map(([k, v]) => [k, String(v)]));
  return {
    worldId: b.worldId, dim: b.dimension, sessionId: b.sessionId,
    observedAt: b.observedAt, sequence: b.observationId,
    source: 'vision', evidence: 'seen', stateComplete: b.stateComplete === true,
    state: { name: b.name, properties }, pos: { ...b.pos },
  };
}

function dedupe(cells: Vec3Like[]): Vec3Like[] {
  const seen = new Set<string>();
  const out: Vec3Like[] = [];
  for (const c of cells) {
    const k = `${c.x},${c.y},${c.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: c.x, y: c.y, z: c.z });
  }
  return out;
}

/**
 * 观察一组格；遵守 Vision 的 ≤32 格/次批次限制。
 * 共享模式下只触发实际合法 Vision 观测（服务/真实视觉是唯一写者），不再写地图；
 * 独立模式下保持单次 observeBatch 的既有路径，供其自身的有界批测试使用。
 */
export function observeCells(ctx: SkillCtx, map: VoxelMap, cells: Vec3Like[]): ChangeReport | null {
  if (!ctx.senses.observeBlocks) return null;
  const unique = dedupe(cells);
  const shared = ctx.spatial !== undefined;
  const observations: Observation[] = [];
  for (let i = 0; i < unique.length; i += 32) {
    const batch = ctx.senses.observeBlocks(unique.slice(i, i + 32));
    // 共享模式：Vision 在返回前已通过服务同步写入并派发报告。
    if (shared) continue;
    for (const b of batch) observations.push(toObservation(b));
  }
  if (shared || observations.length === 0) return null;
  return map.observeBatch({ observations, unobserved: [] });
}

/** 身体附近的有界局部观察格：3×3 水平邻域 × 脚高/支撑/头/净空（3×3×4），不枚举包围矩形。 */
export function bodyLocalCells(pos: Vec3Like): Vec3Like[] {
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const cells: Vec3Like[] = [];
  for (let x = fx - 1; x <= fx + 1; x++)
    for (let z = fz - 1; z <= fz + 1; z++)
      for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
  return cells;
}

/**
 * 从路线点列导出需要观察的格：每个点周围 3×3 的水平邻域 × 脚高/支撑/头/净空。
 * 按短路线约束有界生成，不枚举整条路线的包围矩形。额外观察的格对验证无害。
 */
export function routeCells(points: Vec3Like[]): Vec3Like[] {
  const cells: Vec3Like[] = [];
  for (const p of points) {
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (let x = fx - 1; x <= fx + 1; x++)
      for (let z = fz - 1; z <= fz + 1; z++)
        for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
  }
  return cells;
}

/**
 * 一次真实步行执行的内存历史投影。已确认段的事实先进入内存，落盘状态只由宿主
 * 既有周期/final checkpoint 确认；`accepted_pending_checkpoint` 不是 `saved`。
 */
export type WalkHistoryOutcome =
  | { status: 'accepted_pending_checkpoint'; fragmentId: string; traversalIds: string[] }
  | { status: 'not_recorded'; traversalIds: []; reason: 'no_confirmed_segment' }
  | { status: 'failed'; fragmentId?: string; traversalIds: string[] };

/** 保存边界失败的精确阶段与已成功 ID；不改写实际身体结果。 */
export interface WalkHistoryFailure {
  stage: 'closed' | 'save_fragment' | 'add_traversal';
  message: string;
  fragmentId?: string;
  traversalIds: string[];
}

export interface WalkRouteExecution {
  nav: NavResult;
  history: WalkHistoryOutcome;
  historyFailure?: WalkHistoryFailure;
}

export function historyFields(execution: WalkRouteExecution): Record<string, unknown> {
  return {
    history: execution.history,
    ...(execution.historyFailure !== undefined ? { historyFailure: execution.historyFailure } : {}),
  };
}

function navToResult(nav: NavResult, execution: WalkRouteExecution, base: WalkRouteBase): SkillResult {
  const summary = nav.message;
  // 终态原因（含 route_invalidated）放在 top-level stage；库的完整 NavResult 原样保留在 data.nav。
  const data = { ...base, stage: navStage(nav), nav, ...historyFields(execution) };
  if (nav.outcome === 'ARRIVED') return ok(summary, data);
  // 取消是取消，不包装成普通 STUCK；部分位移随 nav.lastPosition/trace 保留在 data。
  if (nav.outcome === 'CANCELLED') return { status: 'cancelled', summary, data };
  const code = nav.outcome === 'TIMEOUT' ? 'TIMEOUT' : nav.outcome === 'BLOCKED' ? 'PATH_NOT_FOUND' : 'ERROR';
  return fail(code, summary, data);
}

/**
 * 实际读取当前身体状态，并在同一 session 的真实 ready 丢失时只把已经知道的边界交给
 * 共享服务一次：interrupt 后 observationAdmitted 已为 false，重复读取不会再次中断；
 * 正在关停时不再触碰服务。这里不重新 beginSession、不刷新任何格；恢复 ready 后由
 * 真实 Vision/reconnect 入口重新准入。调用方必须先检查父取消/期限，避免旧任务取消后
 * 再读取新任务的现场。
 */
export function readObservedState(ctx: SkillCtx, spatial: SharedSpatialSession) {
  const state = ctx.adapter.state();
  if (!state.observationReady && spatial.observationAdmitted && !spatial.closing) spatial.interrupt();
  return state;
}

/**
 * walk_route、walk_to 与 walk_known_route 共用的窄执行边界：同一套移动中局部观察、
 * 生命周期检查与共享会话附着/解除。调用者只提供已验证的路线请求；不在此处搜索或
 * 改写目标。可选的 starter 只把本次运行的同一个 loop 交给库的已知路线起点，不建立
 * 第二套执行循环。
 */
export async function executeWalkRoute(
  ctx: SkillCtx,
  spatial: SharedSpatialSession,
  opts: {
    map: VoxelMap;
    body: WalkBody;
    tick: WalkTick;
    request: WalkRouteRequest;
    deadlineMs: number;
    /** 本次执行实际依赖、由调用方 prepare 后持有的 Sections；附着生命周期用。 */
    protectedSections?: readonly SectionKey[];
    starter?: (loop: WalkRouteExecutor, request: WalkRouteRequest) => KnownWalkRouteStart;
    /** 进度映射区间：搜索入口把搜索前的阶段计入，路线段再映射到 [from,to]。 */
    progressRange?: { from: number; to: number };
  },
): Promise<WalkRouteExecution> {
  // 每次真实执行自己的唯一调用标识：库的 delegationId/executionId 会在新的 loop 里
  // 重用（walk-1-step-n），不能单独作为全局身份；这里只用于区分本次实际调用。
  const invocationId = randomUUID();
  // 库实际发出的单段请求事实（from/作用域/executionId）；收到不代表运动或到达，
  // 只有终态 trace 中已确认的前缀才与这些请求配对写历史。
  const moveRequests: WalkMoveRequestObservation[] = [];

  // 进度只按库已用实测样本确认起点的段数推进：库发来单段请求时身体已在该段起点，
  // 因此这不是按键次数或墙钟估算。原地跳/物理抖动不会产生新段，也就不会报进度。
  const range = opts.progressRange ?? { from: 0, to: 1 };
  const totalSegments = Math.max(1, opts.request.points.length - 1);
  let progressAt = Math.max(0, Math.min(1, range.from));
  const reportProgress = (fraction: number, note: string) => {
    const next = Math.max(0, Math.min(1, range.from + (range.to - range.from) * Math.max(0, Math.min(1, fraction))));
    if (next <= progressAt) return;
    progressAt = next;
    ctx.progress(next, note);
  };
  ctx.progress(progressAt, '开始执行已选定的步行路线');

  // 移动中持续更新身体周边格（视锥随身体朝向移动而更新），有界 3×3×4。
  const observe = () => observeCells(ctx, opts.map, bodyLocalCells(ctx.adapter.state().pos));
  const nav = await runWalkRoute({
    map: opts.map, body: opts.body, request: opts.request, tick: opts.tick, signal: ctx.signal, observe,
    onMoveRequest: (move) => {
      moveRequests.push(move);
      reportProgress(moveRequests.length / totalSegments, `步行：已开始第 ${moveRequests.length}/${totalSegments} 段（库已用实测样本确认该段起点）`);
    },
    // 真实 ready 丢失（同一 sessionId 下区块消失）可能先被步行生命周期看到、且之后
    // 没有下一帧/下一次 Vision 调用；readObservedState 把已经知道的实际边界交给共享
    // 服务一次，服务仅在实际准入时 interrupt，重复读取不会重复中断。
    lifecycle: () => {
      const s = readObservedState(ctx, spatial);
      return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
    },
    deadlineMs: opts.deadlineMs,
    starter: opts.starter,
    now: Date.now,
    // 附着生命周期属于本次真实步行：报告在身体样本前同步进入 loop，取消走 lifecycle。
    // finally 只撤销本 token，不关闭共享会话，也不影响后续任务。
    bindActive: (loop) => {
      const token = spatial.attach({
        // ChangeReport 在同步观测路径里先于同一帧的 onSample 到达，库据此失效
        // 受影响依赖；这里不做磁盘 I/O、不重复消费报告。
        receiver: (report) => loop.observe(report, 64),
        cancel: () => loop.cancel('lifecycle', 'shared spatial session interrupted the active walk'),
        ...(opts.protectedSections !== undefined ? { protectedSections: opts.protectedSections } : {}),
      });
      return () => spatial.detach(token);
    },
  });
  // 到达由库的实测条件确认；取消/超时/失效只保留已确认段对应的进度，不虚报到 1。
  if (nav.outcome === 'ARRIVED') ctx.progress(1, '已按库的实测到达条件确认到达');

  // 已确认段 = 终态 trace 的前缀，且每一段都有库实际发出的请求可供归属。
  // 未确认的当前半段不会进入 trace，也不会被补写成 traversal。
  const confirmed = Math.min(nav.trace.length, moveRequests.length);
  if (confirmed === 0) {
    return {
      nav,
      history: { status: 'not_recorded', traversalIds: [], reason: 'no_confirmed_segment' },
    };
  }

  // 共享会话已进入关停：旧步行的异步收尾不得再绕过关停直接写内存历史，也
  // 不能把未落盘事实标成 accepted_pending_checkpoint；真实 Nav/confirmed prefix 原样保留。
  if (spatial.closing) {
    nav.memoryWrite = 'failed';
    return {
      nav,
      history: { status: 'failed', traversalIds: [] },
      historyFailure: {
        stage: 'closed',
        message: 'shared spatial session is closing; confirmed walk corridor was not written',
        traversalIds: [],
      },
    };
  }

  // 原请求点列前缀（长度 = 已确认段数 + 1）作为经实际执行确认的 nominal corridor 几何。
  // 不取整、不反转、不插值、不拼接实测轨迹，也不把未走后续点写入折线。
  const prefix = opts.request.points.slice(0, confirmed + 1);
  // fragment ID 同样包含父任务、本次调用与首段实际执行归属；traversal 各自包含所属段。
  const fragmentId = `${ctx.taskId}:${invocationId}:${moveRequests[0]!.executionId}`;
  const fragment = {
    id: fragmentId,
    worldId: opts.request.worldId,
    dim: opts.request.dim,
    kind: 'walked' as const,
    entrances: [] as Vec3Like[],
    polyline: prefix.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    geometrySource: 'traversal' as const,
    deepestY: Math.min(...prefix.map((p) => p.y)),
    createdAt: nav.trace[0]!.ts,
    lastUsedAt: nav.trace[confirmed - 1]!.ts,
    uses: 1,
  };
  try {
    spatial.session.history.saveFragment(fragment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nav.memoryWrite = 'failed';
    return {
      nav,
      history: { status: 'failed', traversalIds: [] },
      historyFailure: { stage: 'save_fragment', message, traversalIds: [] },
    };
  }

  // 逐确认段写实际证据：from 来自该次库实际发出的 ExecutableMove.from，to/时间来自
  // 对应终态 trace；executionId 保留库原值，actionId 保留父任务，均不宣称全局唯一。
  const traversalIds: string[] = [];
  for (let i = 0; i < confirmed; i++) {
    const move = moveRequests[i]!;
    const trace = nav.trace[i]!;
    const evidence = {
      id: `${ctx.taskId}:${invocationId}:${move.executionId}`,
      fragmentId,
      from: { ...move.from },
      to: { ...trace.pos },
      worldId: move.worldId,
      dim: move.dim,
      sessionId: move.sessionId,
      observedAt: trace.ts,
      source: 'confirmed_walk_corridor',
      executionId: move.executionId,
      actionId: ctx.taskId,
      mode: 'walk' as const,
    };
    try {
      spatial.session.history.addTraversal(evidence);
      traversalIds.push(evidence.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      nav.memoryWrite = 'failed';
      return {
        nav,
        history: { status: 'failed', fragmentId, traversalIds: [...traversalIds] },
        historyFailure: { stage: 'add_traversal', message, fragmentId, traversalIds: [...traversalIds] },
      };
    }
  }

  nav.memoryWrite = 'pending';
  return {
    nav,
    history: { status: 'accepted_pending_checkpoint', fragmentId, traversalIds },
  };
}

export const walkRoute: Skill<WalkRouteArgs> = {
  name: 'walk_route',
  description: '走一条显式给定的同高、无施工短路线（普通干燥整块、沿 X/Z）。由你提供点列，代码稳定执行到每个点；出发前会有限次转头（≤12 次）观察路线支撑/身体/净空格，移动中每段会低头看向该段路径的支撑格，途中只依据可见格更新；转头观察不使用任何物品',
  argsDoc: '{"points":[[x,y,z],...]}（2~32 个点，脚高 y 相同，相邻沿 X/Z 一格）,"deadlineMs"?:正有限毫秒；只接受这两个参数，avoid/dig/place/tower/materials 等未贯通的选项会被明确拒绝，不会静默忽略',
  timeoutMs: 30000,
  movement: true,
  validate(raw, _adapter) {
    const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const unsupported = unsupportedNavOption('walk_route', a, ['points', 'deadlineMs']);
    if (unsupported !== null) return { ok: false, error: unsupported };
    const points = a.points;
    if (!Array.isArray(points) || points.length < 2) return { ok: false, error: 'walk_route 需要 {"points":[[x,y,z],...]}，至少 2 个点' };
    if (points.length > MAX_POINTS) return { ok: false, error: `walk_route 本轮最多 ${MAX_POINTS} 个点` };

    const parsed: Vec3Like[] = [];
    for (const p of points) {
      const coord = readPoint(p);
      if (coord === null) return { ok: false, error: 'points 每个点必须是 [x,y,z] 数组或 {x,y,z} 对象，坐标为 ±30000000 内的有限数字' };
      parsed.push(coord);
    }
    const y = parsed[0]!.y;
    for (const p of parsed) if (p.y !== y) return { ok: false, error: 'walk_route 本轮只支持同高路线（y 相同）' };
    for (let i = 0; i < parsed.length - 1; i++) {
      const dx = parsed[i + 1]!.x - parsed[i]!.x;
      const dz = parsed[i + 1]!.z - parsed[i]!.z;
      const isXStep = Math.abs(Math.abs(dx) - 1) < 1e-9 && Math.abs(dz) < 1e-9;
      const isZStep = Math.abs(Math.abs(dz) - 1) < 1e-9 && Math.abs(dx) < 1e-9;
      if (!isXStep && !isZStep) return { ok: false, error: 'walk_route 只支持沿 X/Z 单轴相邻一格的路线（非对角、非跳跃、非跨格）' };
    }

    const rawDeadline = a.deadlineMs === undefined ? undefined : Number(a.deadlineMs);
    const deadlineMs = rawDeadline !== undefined && Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
    if (rawDeadline !== undefined && deadlineMs === undefined) return { ok: false, error: 'deadlineMs 必须是正有限数字（毫秒）' };
    return { ok: true, args: { points: parsed, ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const base = walkRouteBase(args);
    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'walk_route 需要宿主共享空间会话（ctx.spatial），当前未接线', { ...base });
    const body = ctx.adapter.walkBody?.();
    const tick = ctx.adapter.walkTick?.();
    if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）', { ...base });

    const state = ctx.adapter.state();
    // 共享步行只读宿主服务持有的地图；缺失/关闭时显式失败，绝不自建 VoxelMap 兜底。
    const map = spatial.session.voxel;
    // 有效期限不能超过父委托期限：子请求只能缩短，不能延长。
    const effectiveDeadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);

    // 依赖 Section 只由真实身体起点、本次路线各段扫掠与支撑层决定；不用目标点
    // 代替起点，也不按包围盒扩展。prepare 在任何地图读取/执行之前完成。
    // eager 模式保持原有同步预扫：这里不 await，避免把首次观测推到换手边界之后。
    let residency: RouteResidency = { status: 'ready', lease: null, sections: [], noRecord: [] };
    if (spatial.session.voxelLoading === 'manual') {
      const actualStart = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
      const scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
      residency = await acquireRouteResidency(
        spatial,
        routeDependencySections(map, scope, actualStart, args.points),
        { signal: ctx.signal, deadline: effectiveDeadline },
      );
      if (residency.status !== 'ready') {
        const summary = `walk_route 空间依赖未准备好：${residency.message}`;
        const data = { ...base, stage: 'residency', ...residencyFacts(residency) };
        if (residency.reason === 'cancelled') {
          if (ctx.signal.aborted || spatial.closing || spatial.paused) {
            return { status: 'cancelled', summary, data: { ...data, cancelBy: 'lifecycle' } };
          }
          return fail('TIMEOUT', summary, data);
        }
        return fail('ERROR', summary, data);
      }
    }
    try {
      // prepare 是真实异步等待：期间可能换 scope、暂停、关闭或身体/观测失效。
      // 预扫前必须重新读取当前状态，不能沿用 prepare 前的 state；失败仍走 finally 释放 lease。
      if (ctx.signal.aborted) {
        return { status: 'cancelled', summary: 'walk_route 预扫前被父任务取消', data: { ...base, stage: 'CANCELLED', cancelBy: 'parent', ...residencyFacts(residency) } };
      }
      if (Date.now() >= effectiveDeadline) {
        return fail('TIMEOUT', 'walk_route 预扫前到达期限', { ...base, stage: 'TIMEOUT', ...residencyFacts(residency) });
      }
      const preparedState = ctx.adapter.state();
      if (!preparedState.alive || !preparedState.connected || !preparedState.observationReady) {
        return { status: 'cancelled', summary: 'walk_route 准备期间身体/观测失效，未开始预扫', data: { ...base, stage: 'CANCELLED', cancelBy: 'lifecycle', ...residencyFacts(residency) } };
      }
      if (preparedState.worldId !== state.worldId || preparedState.dim !== state.dim
        || preparedState.sessionId !== state.sessionId || preparedState.worldId !== spatial.worldId) {
        return { status: 'cancelled', summary: 'walk_route 准备期间作用域变化，未开始预扫', data: { ...base, stage: 'CANCELLED', cancelBy: 'scope_changed', ...residencyFacts(residency) } };
      }
      if (spatial.closing || spatial.paused) {
        return { status: 'cancelled', summary: 'walk_route 准备期间共享会话失效，未开始预扫', data: { ...base, stage: 'CANCELLED', cancelBy: 'lifecycle', ...residencyFacts(residency) } };
      }

      // 预扫：有限次合法转头（4 个朝向 × 3 个俯仰）覆盖验证所需的支撑、身体与净空竖列。
      // 视锥配置不变；脚下/头顶不因“贴着身体”就免视线，因此必须真正低头/抬头去看。
      // 这是执行这条显式路线所需的观察，不扩宽视锥、不做额外探索，也不消耗资源。
      const route = routeCells(args.points);
      observeCells(ctx, map, route);
      if (typeof ctx.adapter.look === 'function') {
        for (const pitch of [-1.2, 0, 1.1]) {
          for (const yaw of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
            if (ctx.signal.aborted || Date.now() >= effectiveDeadline) break;
            await ctx.adapter.look(yaw, pitch);
            observeCells(ctx, map, route);
          }
          if (ctx.signal.aborted || Date.now() >= effectiveDeadline) break;
        }
      }
      if (ctx.signal.aborted) {
        return { status: 'cancelled', summary: '预扫阶段被取消', data: { ...base, stage: 'CANCELLED', cancelBy: 'parent', ...residencyFacts(residency) } };
      }
      if (Date.now() >= effectiveDeadline) {
        return fail('TIMEOUT', '预扫阶段到达期限', { ...base, stage: 'TIMEOUT', ...residencyFacts(residency) });
      }
      const executionState = ctx.adapter.state();
      if (!executionState.alive || !executionState.connected || !executionState.observationReady) {
        return { status: 'cancelled', summary: '预扫期间身体/观测失效，未开始移动', data: { ...base, stage: 'CANCELLED', cancelBy: 'lifecycle', ...residencyFacts(residency) } };
      }
      if (executionState.worldId !== preparedState.worldId || executionState.dim !== preparedState.dim
        || executionState.sessionId !== preparedState.sessionId || executionState.worldId !== spatial.worldId) {
        return { status: 'cancelled', summary: '预扫期间作用域变化，未开始移动', data: { ...base, stage: 'CANCELLED', cancelBy: 'scope_changed', ...residencyFacts(residency) } };
      }
      if (spatial.closing || spatial.paused) {
        return { status: 'cancelled', summary: '预扫期间共享会话失效，未开始移动', data: { ...base, stage: 'CANCELLED', cancelBy: 'lifecycle', ...residencyFacts(residency) } };
      }

      const request = {
        worldId: executionState.worldId, dim: executionState.dim, sessionId: executionState.sessionId, mode: 'walk' as const,
        body: { feet: args.points[0]!, width: 0.6, height: 1.8, pose: 'standing' as const },
        points: args.points, arrival: { kind: 'exact' as const },
        bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
        deadlineMs: effectiveDeadline, timeoutMs: 4000,
      };
      const execution = await executeWalkRoute(ctx, spatial, {
        map, body, tick, request, deadlineMs: effectiveDeadline,
        protectedSections: residency.lease?.keys ?? residency.sections,
      });
      const nav = execution.nav;
      // 父任务已取消但库以其它终态返回（期限/失效先到）：以取消返回，保留部分位移。
      if (ctx.signal.aborted && nav.outcome !== 'CANCELLED') {
        return { status: 'cancelled', summary: nav.message, data: { ...base, stage: 'CANCELLED', cancelBy: 'parent', nav, ...historyFields(execution), ...residencyFacts(residency) } };
      }
      return navToResult(nav, execution, base);
    } finally {
      // 无论成功、取消、期限、异常还是关停，都只释放本次 lease 一次。
      releaseRouteResidency(spatial, residency);
    }
  },
};

/** 坐标必须本身是有限数字，且落在可安全枚举的范围（Minecraft 世界边界内）。 */
const COORD_BOUND = 30_000_000;

function validCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_BOUND;
}

export function readPoint(p: unknown): Vec3Like | null {
  if (Array.isArray(p)) {
    if (!validCoord(p[0]) || !validCoord(p[1]) || !validCoord(p[2])) return null;
    return { x: p[0], y: p[1], z: p[2] };
  }
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if (!validCoord(o.x) || !validCoord(o.y) || !validCoord(o.z)) return null;
    return { x: o.x, y: o.y, z: o.z };
  }
  return null;
}
