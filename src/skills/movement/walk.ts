import {
  GROUNDED_ARRIVAL_DEFAULTS,
  createWalkPath,
  createWalkPathExecution,
  type BodySample,
  type ChangeReport,
  type ExecutableMove,
  type ExecutableMoveResult,
  type NavProblem,
  type RoutePlan,
  type RoutePlanRegistryProblem,
  type RoutePlanScope,
  type Vec3Like,
  type WalkBodyPort,
  type WalkPathChangeReportSource,
  type WalkPathEnvironment,
  type WalkPathResult,
} from 'curio-minecraft-3d-memory';
import { WalkMoveExecutor, walkCollisionProvider } from '../../adapter/walk-route.ts';
import type { WalkBody, WalkLifecycle, WalkMoveRequestObservation, WalkTick } from '../../adapter/walk-route.ts';
import { bodyLocalCells, observeCells } from '../walk-route.ts';
import { fail, ok, obj, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';
import { clearRouteRecords, consumeRoutePlan, noteRouteScope, releaseRoutePlan } from './route.ts';

const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };
/** 没有新物理帧时，库重复拉取样本的最长复用时间；到点重新测量一次实测状态。 */
const SAMPLE_REFRESH_MS = 50;

type WalkArgs = { routeId: string; deadlineMs?: number };

const clonePoints = (points: readonly Vec3Like[]) => points.map((p) => ({ ...p }));
const isPlan = (value: RoutePlan | RoutePlanRegistryProblem): value is RoutePlan => 'backend' in value;

/** 已消费计划的固定外壳；逐次执行只补实测/终态字段。 */
function planFacts(plan: RoutePlan) {
  return {
    routeId: plan.routeId,
    routeKind: plan.source === 'history' ? 'known' : 'snapshot',
    pathId: plan.pathId ?? null,
    backend: plan.backend,
    requestedTarget: plan.requestedTarget,
    resolvedTarget: plan.resolvedTarget,
  };
}

/** 未启动执行时的固定事实：没有任何已确认段，剩余点就是整条计划。 */
function notStarted(plan: RoutePlan) {
  return {
    ...planFacts(plan),
    confirmed: false,
    confirmedSegments: 0,
    remainingPoints: clonePoints(plan.points),
    consumption: { placed: [] },
    trace: [],
  };
}

/** 宿主在执行钩子里发现的能力缺口；库已在入口消费该 routeId，因此仍走已消费计划的信封。 */
function hostInvalidated(plan: RoutePlan, executionId: string, reason: string, problem: NavProblem): WalkPathResult {
  return {
    outcome: 'INVALIDATED',
    contract: 'memory-host-contract/1',
    routeId: plan.routeId,
    executionId,
    confirmedSegments: 0,
    remainingPoints: clonePoints(plan.points),
    invalidation: { segment: 0, reason },
    problem,
    consumption: { placed: [] },
    confirmed: false,
    trace: [],
  };
}

/** 库的终态 → 摘要；明确区分失效、阻塞、没路、部分进展与未到。 */
function summaryOf(result: WalkPathResult): string {
  const detail = result.problem !== undefined && 'detail' in result.problem ? `：${result.problem.detail}` : '';
  switch (result.outcome) {
    case 'ARRIVED': return 'walk_path 已按实测身体条件确认到达';
    case 'CANCELLED': return 'walk_path 被取消，已保留实测位移';
    case 'TIMEOUT': return 'walk_path 期限耗尽，未确认到达';
    case 'BLOCKED': return `路线被当前证据阻挡，停在阻塞前${detail}`;
    case 'NO_PATH': return `当前已知空间内没有可行路线${detail}`;
    case 'INVALIDATED': return `路线失效（${result.invalidation?.reason ?? result.problem?.kind ?? 'unknown'}）${detail}`;
    case 'PARTIAL': return `只确认了部分路段（${result.confirmedSegments} 段），未到达${detail}`;
  }
}

/** 已消费计划的终态信封：库只给出实测/终态字段，宿主补固定事实。 */
function planData(plan: RoutePlan, result: WalkPathResult) {
  return {
    ...planFacts(plan),
    contract: result.contract,
    executionId: result.executionId,
    outcome: result.outcome,
    navOutcome: result.outcome === 'INVALIDATED' ? 'FAILED' : result.outcome,
    confirmed: result.confirmed,
    message: summaryOf(result),
    position: result.lastPosition ?? null,
    lastObservation: result.lastObservation ?? null,
    trace: result.trace,
    problem: result.problem ?? null,
    // 已确认位移由统一的 TraversalRecorder 写共享空间记忆；walk_path 不再另建 fragment。
    memoryWrite: result.memoryWrite ?? null,
    confirmedSegments: result.confirmedSegments,
    remainingPoints: result.remainingPoints,
    consumption: result.consumption ?? { placed: [] },
    ...(result.invalidation === undefined ? {} : { invalidation: result.invalidation }),
    // 库把起点漂移报成 INVALIDATED/route_start_changed；宿主保留 C-WALK-01 的 unsupported 标记。
    ...(result.invalidation?.reason === 'route_start_changed'
      ? { unsupported: { reason: 'route_start_changed' } }
      : {}),
  };
}

/** 注册表拒绝：routeId 从未（或已不能）成为可执行路线，没有可读的计划几何。 */
function registryData(routeId: string, result: WalkPathResult) {
  return {
    routeId,
    contract: result.contract,
    executionId: result.executionId,
    outcome: result.outcome,
    navOutcome: 'FAILED',
    confirmed: false,
    plan: null,
    invalidation: result.invalidation ?? null,
    problem: result.problem ?? null,
    trace: [],
    position: result.lastPosition ?? null,
    consumption: { placed: [] },
  };
}

function registryMessage(routeId: string, problem: RoutePlanRegistryProblem['kind']): string {
  switch (problem) {
    case 'invalid_request': return `routeId ${routeId} 无效；重新 plan_route`;
    case 'route_not_found': return `routeId ${routeId} 不存在或已过期；重新 plan_route`;
    case 'route_consumed': return `routeId ${routeId} 已被消费；每次执行都必须重新 plan_route`;
    case 'route_expired': return `routeId ${routeId} 已过期；重新 plan_route`;
    case 'scope_mismatch': return '路线作用域与当前世界/维度/会话不符；重新 plan_route';
    case 'route_not_executable': return `routeId ${routeId} 不可执行；重新 plan_route`;
  }
}

function registryResult(routeId: string, result: WalkPathResult): SkillResult {
  const reason = result.invalidation?.reason;
  const problem = isRegistryProblem(reason) ? reason : 'route_not_found';
  const code: FailureCode = problem === 'scope_mismatch'
    ? 'WRONG_DIMENSION'
    : problem === 'route_expired' ? 'EFFECT_NOT_CONFIRMED' : 'BAD_ARGS';
  return fail(code, registryMessage(routeId, problem), registryData(routeId, result));
}

function isRegistryProblem(reason: string | undefined): reason is RoutePlanRegistryProblem['kind'] {
  return reason === 'invalid_request' || reason === 'route_not_found' || reason === 'route_consumed'
    || reason === 'route_expired' || reason === 'scope_mismatch' || reason === 'route_not_executable';
}

function skillResult(plan: RoutePlan | null, result: WalkPathResult): SkillResult {
  if (plan === null) return registryResult(result.routeId, result);
  const data = planData(plan, result);
  if (result.outcome === 'ARRIVED') return ok(summaryOf(result), data);
  if (result.outcome === 'CANCELLED') return { status: 'cancelled', summary: summaryOf(result), data };
  if (result.outcome === 'TIMEOUT') return fail('TIMEOUT', summaryOf(result), data);
  if (result.outcome === 'BLOCKED' || result.outcome === 'NO_PATH') return fail('PATH_NOT_FOUND', summaryOf(result), data);
  return fail('EFFECT_NOT_CONFIRMED', summaryOf(result), data);
}

/**
 * 已确认段的通道几何：`[首段实际出发位置, ...每段终态 trace 的实测位置]`（长度 =
 * 确认段数 + 1）。这是实测经过的几何，不是计划点列；未确认半段、剩余点与计划
 * 坐标都不进入。`entrances` 为空（不保证实际开口）。
 */
const watchedAdapters = new WeakSet<object>();

/** 每个适配器只订阅一次真实会话重置：旧 routeId 立即失效，不跨会话执行。 */
function watchSessionReset(adapter: SkillCtx['adapter']) {
  if (watchedAdapters.has(adapter)) return;
  watchedAdapters.add(adapter);
  adapter.on('session_reset', clearRouteRecords);
}

/**
 * 宿主单步身体端口：把库授权的单个 ExecutableMove 原样交给 WalkMoveExecutor，
 * 只补该段最后一帧真实物理帧的 BodySample。`to`/`from`/期限都不改写，也不提供
 * 任何挖/放/寻路入口；stop 只释放所属 executionId。
 */
export function createWalkBodyPort(opts: {
  body: WalkBody;
  tick: WalkTick;
  signal: AbortSignal;
  now: () => number;
  lifecycle: () => WalkLifecycle;
  onLifecycleBroken: (detail: string) => void;
  /** 每帧顺序固定为：观察入库 → 派发报告 → 构造该帧实测样本。 */
  onFrame: (entity: WalkBody['entity'], executionId: string) => BodySample;
  /**
   * 库实际发出的每一段单步请求（含 `ExecutableMove.from`），在执行前同步记录；
   * 只观察，不参与控制。用于把已确认段归属到真实的出发位置。
   */
  onMoveRequest?: (move: WalkMoveRequestObservation) => void;
}): WalkBodyPort {
  const executor = new WalkMoveExecutor(
    opts.body, opts.tick, opts.signal, opts.now, opts.lifecycle, opts.onLifecycleBroken,
    undefined, opts.onMoveRequest,
  );
  let active: string | null = null;
  let lastSample: BodySample | null = null;
  executor.setFrameSink((entity) => {
    if (active !== null) lastSample = opts.onFrame(entity, active);
  });
  return {
    async move(request) {
      active = request.executionId;
      lastSample = null;
      const result = await executor.move(request);
      active = null;
      // 原样保留失败原因；样本保持该帧的 sequence（同一测量重投不重新编号）。
      return lastSample === null ? result : { ...result, sample: lastSample };
    },
    stop(executionId) {
      executor.stop(executionId);
    },
  };
}

/**
 * 执行 plan_route 返回的 routeId。只沿已规划路线走：不重新搜索、不换路、不挖/垫/搭柱。
 * 入口由库的 walkPath 消费 routeId 并复核可执行/过期/作用域/起点；宿主只提供实测
 * BodySample、单步身体端口与观察变化源。逐段证据复验、失效、到达与部分进展由库判定；
 * 宿主只在任何身体动作之前补库不拥有的会话/身体能力缺口。
 */
export const walkPath: Skill<WalkArgs> = {
  name: 'walk_path',
  description: '执行 plan_route source:"search" 返回的 routeId。memory/spatial 的 points/steps 不是 routeId。只沿已规划路线走，不重新搜索、不换路、不挖/垫/搭柱；每段按当前证据复验，证据失效即停并返回 INVALIDATED。routeId 单次使用。ARRIVED 必须由实测身体位置确认；PARTIAL 只表示部分进展，不是到达。',
  argsDoc: '{"routeId":"plan_route source:\'search\' 返回的 routeId", "deadlineMs"?:绝对 epoch 毫秒}；只接受这两个参数。需要适配器的 walkBody/walkTick 和共享空间会话；路线不可执行/已消费/过期/作用域不符/起点改变时拒绝执行。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const unknown = Object.keys(a).filter((k) => !['routeId', 'deadlineMs'].includes(k));
    if (unknown.length) return { ok: false, error: `walk_path 不认识参数 ${unknown.join('、')}；只接受 routeId、deadlineMs` };
    if (typeof a.routeId !== 'string' || !a.routeId.trim()) return { ok: false, error: 'routeId 需要 plan_route source:"search" 当场返回的非空 ID；memory/spatial 的 points/steps 不是 routeId' };
    if (/^(pending|todo|later|auto|routeId|\$.*|<.*>|{.*})$/i.test(a.routeId.trim())) {
      return { ok: false, error: `routeId "${a.routeId.trim()}" 是占位符，不能执行；plan_route source:"search" 成功会返回 rt_… 的 routeId；memory/spatial 返回的是 points/steps，按 steps 执行，不要调用 walk_path` };
    }
    if (a.deadlineMs !== undefined && (typeof a.deadlineMs !== 'number' || !Number.isFinite(a.deadlineMs) || a.deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { routeId: a.routeId, ...(a.deadlineMs !== undefined ? { deadlineMs: a.deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const state = ctx.adapter.state();
    const scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    watchSessionReset(ctx.adapter);
    // 换会话/换维的入口对账先于消费：旧 routeId 必须 route_not_found，而不是 scope_mismatch 后仍可换作用域复用。
    noteRouteScope(scope);
    // 契约 §7.3 的稳定外部身份：入口起始样本必须带上它；execute 内以库给的 start.executionId 为准。
    const executionId = `exec_${args.routeId}`;
    const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    const body = ctx.adapter.walkBody?.();
    const tick = ctx.adapter.walkTick?.();
    const now = Date.now;

    // 库的入口在消费 routeId 后自行复核 scope/expiry/executable/起点；宿主不再重复这些门禁。
    // 消费包装只截获库实际消费到的计划，作为宿主信封字段的唯一真实来源。
    let consumedPlan: RoutePlan | null = null;
    const registry = {
      consume: (routeId: string, planScope: RoutePlanScope) => {
        const consumed = consumeRoutePlan(routeId, planScope);
        if (isPlan(consumed)) consumedPlan = consumed;
        return consumed;
      },
      release: releaseRoutePlan,
    };

    const listeners = new Set<(report: ChangeReport) => void>();
    const changes: WalkPathChangeReportSource = {
      subscribe(callback) {
        listeners.add(callback);
        return () => { listeners.delete(callback); };
      },
    };
    const emit = (report: ChangeReport) => {
      for (const listener of [...listeners]) listener(report);
    };

    const runAbort = new AbortController();
    const onParentAbort = () => { runAbort.abort(); };
    if (ctx.signal.aborted) runAbort.abort();
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true });

    // 身体端口在执行钩子里按实际会话/地图构造；入口预检期间不会被调用。
    let activePort: WalkBodyPort | null = null;
    /** 库实际发出的每段单步请求；执行结束后只取其中已确认段的前缀。 */
    const moveRequests: WalkMoveRequestObservation[] = [];

    let sequence = 0;
    /** 最新一次测量；库高频拉取时重复返回同一序号，库会按重放忽略。 */
    let latestSample: BodySample | null = null;
    /** 最新样本是否来自执行期的 live 物理实体（否则是入口实测状态）。 */
    let latestIsLive = false;

    /**
     * 入口起始样本：位置/生命周期取 adapter 的实测状态，供库的起点复核使用。
     * 实测未就绪或坐标不可测时返回 null，不用 {0,0,0} 占位。
     */
    const entrySample = (sampleExecutionId: string): BodySample | null => {
      const s = ctx.adapter.state();
      if (!s.alive || !s.connected || !s.observationReady || s.dim === 'unknown') return null;
      if (![s.pos.x, s.pos.y, s.pos.z].every(Number.isFinite)) return null;
      latestSample = {
        worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, executionId: sampleExecutionId,
        pos: { ...s.pos }, observedAt: now(), sequence: ++sequence,
        alive: s.alive, connected: s.connected, observationReady: s.observationReady,
        onGround: s.onGround, inWater: s.inWater,
      };
      latestIsLive = false;
      return latestSample;
    };

    /** 执行期样本：pos/velocity/接地/入水全部取同一个 live walkBody 物理实体。 */
    const liveSample = (sampleExecutionId: string, entity: WalkBody['entity']): BodySample => {
      const s = ctx.adapter.state();
      latestSample = {
        worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, executionId: sampleExecutionId,
        pos: { ...entity.position }, velocity: { ...entity.velocity }, observedAt: now(), sequence: ++sequence,
        alive: s.alive, connected: s.connected, observationReady: s.observationReady,
        onGround: entity.onGround, inWater: entity.isInWater,
      };
      latestIsLive = true;
      return latestSample;
    };

    // 库在入口和运行中主动拉取样；只有确实测不到身体时才返回 null（库会失败关闭）。
    const sample = (): BodySample | null => {
      if (activePort === null) {
        if (latestSample !== null && !latestIsLive && now() - latestSample.observedAt < SAMPLE_REFRESH_MS) return latestSample;
        return entrySample(executionId);
      }
      if (latestSample !== null && latestIsLive && now() - latestSample.observedAt < SAMPLE_REFRESH_MS) return latestSample;
      return body === undefined ? null : liveSample(executionId, body.entity);
    };

    const bodyPort: WalkBodyPort = {
      move: (request: ExecutableMove): Promise<ExecutableMoveResult> => activePort === null
        ? Promise.resolve({ failure: { kind: 'execution_error', detail: 'walk body port is not active' } })
        : activePort.move(request),
      stop: (id: string) => { activePort?.stop(id); },
    };

    const environment: WalkPathEnvironment = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: { ...BODY, feet: { ...state.pos } },
      shapeProvider: walkCollisionProvider,
      sample,
      bodyPort,
      changes,
      now,
      cancellationOrigin: 'agent',
    };

    let hostFailure: SkillResult | null = null;
    /** 宿主能力缺口/门禁：所有身体动作之前返回，routeId 仍保持已消费；身份以库传入的 start.executionId 为准。 */
    const gate = (plan: RoutePlan, gateExecutionId: string, reason: string, code: FailureCode, summary: string, problem: NavProblem, extra: Record<string, unknown> = {}) => {
      hostFailure = fail(code, summary, {
        ...notStarted(plan), contract: 'memory-host-contract/1', executionId: gateExecutionId,
        outcome: 'INVALIDATED', invalidation: { segment: 0, reason }, ...extra,
      });
      return hostInvalidated(plan, gateExecutionId, reason, problem);
    };

    const libraryWalkPath = createWalkPath(registry, {
      execute: async (start) => {
        const plan = start.plan;
        const id = start.executionId;
        const spatial = ctx.spatial;
        if (!spatial) {
          return gate(plan, id, 'invalid_request', 'NOT_CONNECTED', 'walk_path 需要宿主共享空间会话（ctx.spatial）', {
            kind: 'unavailable', detail: 'the host has no shared spatial session',
          });
        }
        const current = ctx.adapter.state();
        if (current.worldId !== spatial.worldId) {
          return gate(plan, id, 'scope_mismatch', 'WRONG_DIMENSION', `当前世界 ${current.worldId} 与空间会话 ${spatial.worldId} 不一致`, {
            kind: 'scope_changed', detail: `adapter world "${current.worldId}" does not match shared session "${spatial.worldId}"`,
          }, { expected: { worldId: spatial.worldId }, actual: { worldId: current.worldId } });
        }
        if (spatial.closing || spatial.paused || !spatial.observationAdmitted) {
          return gate(plan, id, 'route_body_unavailable', 'NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能执行路线', {
            kind: 'unavailable', detail: 'shared spatial session is closing, paused or not admitted',
          });
        }
        if (body === undefined || tick === undefined) {
          return gate(plan, id, 'route_body_unavailable', 'ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）', {
            kind: 'unavailable', detail: 'the adapter exposes no walkBody/walkTick bridge',
          });
        }
        // 可执行计划由 planRoute 保证 verdict==='OPEN'、start===points[0]（且 registry.consume 拒绝 candidate），
        // 因此不再重复添加不可达的 verdict/历史首点门禁；起点复核归库的 start precheck。
        const map = spatial.session.voxel;
        activePort = createWalkBodyPort({
          body, tick, signal: runAbort.signal, now,
          lifecycle: () => {
            const s = ctx.adapter.state();
            return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
          },
          onLifecycleBroken: () => {
            environment.cancellationOrigin = 'lifecycle';
            runAbort.abort();
          },
          // 帧内顺序固定：观察写入共享地图（会话同步派发报告）→ 报告同步给订阅者 → 实测样本。
          onFrame: (entity, frameExecutionId) => {
            const report = observeCells(ctx, map, bodyLocalCells(ctx.adapter.state().pos));
            if (report !== null) emit(report);
            return liveSample(frameExecutionId, entity);
          },
          onMoveRequest: (move) => { moveRequests.push(move); },
        });
        const token = spatial.attach({
          receiver: emit,
          cancel: () => {
            environment.cancellationOrigin = 'lifecycle';
            runAbort.abort();
          },
        });
        try {
          return await createWalkPathExecution({
            map,
            moveTimeoutMs: Math.max(1, Math.min(4000, deadline - now())),
            now,
          })(start);
        } finally {
          spatial.detach(token);
          activePort = null;
        }
      },
    });

    const request = {
      routeId: args.routeId,
      deadlineMs: deadline,
      signal: runAbort.signal,
      bodyArrival: GROUNDED_ARRIVAL_DEFAULTS,
    };
    const result = await libraryWalkPath(request, environment).finally(() => {
      ctx.signal.removeEventListener('abort', onParentAbort);
    });
    if (hostFailure !== null) return hostFailure;
    // 已确认位移由统一的 TraversalRecorder 写共享空间记忆；这里只返回身体结果。
    // 父任务取消先于库终态时仍以取消返回，保留库已记录的部分位移；注册表拒绝没有计划可报。
    if (consumedPlan !== null && ctx.signal.aborted && result.outcome !== 'CANCELLED') {
      return { status: 'cancelled', summary: 'walk_path 被父任务取消', data: planData(consumedPlan, result) };
    }
    return skillResult(consumedPlan, result);
  },
};
