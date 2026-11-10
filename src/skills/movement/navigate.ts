import type { Vec3Like } from '../../adapter/types.ts';
import { feetCell } from '../../perception/local.ts';
import { obj, type Skill } from '../types.ts';
import { coordinatorData, runMovementCoordinator, type CoordinatorOutcome } from './coordinator.ts';
import { targetKindOf, type NavigationTargetKind } from './goal.ts';
import type { MoveMode } from './session.ts';

type NavigateArgs = {
  to: Vec3Like;
  /** validate 时冻结；直接调用 run 的旧入口可省略，run 会在唯一入口边界补齐。 */
  targetKind?: NavigationTargetKind;
  allowed: MoveMode[];
  historical: boolean;
  maxSteps: number;
  allowUnknownCorridor: boolean;
  maxSegments?: number;
  maxStepsPerSegment?: number;
  maxSearches?: number;
  maxTransitions?: number;
  maxObservations?: number;
  maxObservedCells?: number;
  maxNoProgressSegments?: number;
  /** 单次搜索的节点/边预算；省略时用库默认值。 */
  maxNodes?: number;
  maxEdges?: number;
  sessionId?: string;
  deadlineMs?: number;
};

const KINDS: readonly MoveMode[] = ['walk', 'step', 'drop', 'ladder'];
/** Ladder remains opt-in; callers must list it explicitly. */
const DEFAULT_KINDS: readonly MoveMode[] = ['walk', 'step', 'drop'];

const point = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const sameCell = (a: Vec3Like, b: Vec3Like) => a.x === b.x && a.y === b.y && a.z === b.z;
const round2 = (v: number) => Math.round(v * 100) / 100;

function segmentCompat(
  args: NavigateArgs, outcome: Extract<CoordinatorOutcome, { ok: true }>, invocationStart: Vec3Like,
  newChunks: number, newObservedCells: number,
) {
  const last = outcome.segments.at(-1);
  const end = { ...outcome.session.measured.current };
  const dx = end.x - invocationStart.x, dy = end.y - invocationStart.y, dz = end.z - invocationStart.z;
  const arrived = outcome.stop.reason === 'ARRIVED';
  const progressed = newObservedCells > 0 || newChunks > 0 || arrived;
  return {
    startStance: { ...invocationStart },
    endStance: end,
    displacement: { horizontal: round2(Math.hypot(dx, dz)), vertical: round2(dy), euclidean: round2(Math.hypot(dx, dy, dz)) },
    requestedDistance: {
      horizontal: round2(Math.hypot(args.to.x - invocationStart.x, args.to.z - invocationStart.z)),
      euclidean: round2(Math.hypot(args.to.x - invocationStart.x, args.to.y - invocationStart.y, args.to.z - invocationStart.z)),
    },
    distanceFromStart: round2(Math.hypot(dx, dy, dz)),
    backend: last?.directDrop === true ? 'direct-drop' : last === undefined || last.planned.length === 0 ? 'none' : 'land-search',
    newChunks,
    newObservedCells,
    observationCoverage: newObservedCells > 0,
    movedCells: !sameCell(cell(invocationStart), cell(end)),
    arrivedAtTarget: arrived,
    remainingTarget: { ...args.to },
    remainingTransitions: last?.remaining.length ?? 0,
    bounds: { maxSteps: args.maxSteps, plannedTransitions: last?.planned.length ?? 0, executed: last?.confirmed.length ?? 0 },
    invalidation: arrived ? null : last?.stopCode ?? outcome.stop.reason,
    progress: {
      meaningful: progressed,
      reason: newObservedCells > 0 ? 'new_observation' : newChunks > 0 ? 'new_chunk' : arrived ? 'arrived_at_target' : 'none',
    },
  };
}

/**
 * 执行 Agent 已选定的 3D 目的地。公开入口与 advance 共享同一个 Coordinator；
 * 默认 maxSegments=1，保持“一次调用执行一条路线或当前证据前缀”的既有行为。
 * 不挖、不放、不搭、不换目标；UNKNOWN/STALE 不可执行，边界观察只做有限相关格。
 */
export const navigateTo: Skill<NavigateArgs> = {
  name: 'navigate_to',
  description: '按你指定的目的地和允许的 walk/step/drop 执行 3D 路线。宿主用已记录体素做有界搜索（当前证据优先，可用历史体素作候选），并按每段连续脚位执行、实测核实；不挖、不放、不搭、不换目标，遇阻挡、落点不可见或历史路线失效就停下报事实。目标写法决定语义：整数 x/z 表示走到那一格（完成条件是脚在格内且脚高在 0.01 格容差内）；分数 x/z 表示精确连续脚位（完成条件是身体中心水平 0.12 / 垂直 0.05 格内），不会用工整格心或附近格顶替。没有完整路线时，若当前证据确认了一段可达前缀，会沿该前缀自动走到边界（最多 maxSteps 段）再停下；只走当前证据 OPEN 的段，不进入 UNKNOWN/STALE 格，不声称到达。默认 maxSegments=1（单段/单前缀）；显式提高后由 Coordinator 分段推进，每段从实测位置重新派生、验证，原目标不变；回执带 sessionId，未完成时可原样续接（目标/允许模式/目标类型改变必须新建）。回执带原目的地、可达前缀端点、UNKNOWN/STALE/BLOCKED 边界（位置/方向/状态/原因）、搜索终态（INSUFFICIENT_EVIDENCE/NO_PATH_IN_MEMORY/UNSUPPORTED/INVALIDATED/BUDGET_EXHAUSTED）与未驻留 Section、额外观察是否可能解决、是否需要显式动作或其他移动能力。不自动挖；清障由你显式 mine_cell 后再观察/规划。',
  argsDoc: '{"to":{"x":整数或分数,"y":脚高,"z":整数或分数},"allowed"?":["walk","step","drop"],"historical"?true,"maxSteps"?16,"allowUnknownCorridor"?false,"maxSegments"?1,"maxStepsPerSegment"?,"maxTransitions"?,"maxSearches"?,"maxObservations"?,"maxObservedCells"?,"maxNoProgressSegments"?,"maxNodes"?,"maxEdges"?,"sessionId"?:,"deadlineMs"?}；to 是站立脚位/方块格，不是箱子/门方块本身；整数 x/z 按目标格验收，分数 x/z 按精确连续脚位验收（水平 0.12 / 垂直 0.05 格），不会自动改写成格心；historical 默认 true（当前证据没路时用历史体素候选，结果标 historical 并逐段当前证据复验）；没有完整路线时会自动执行当前证据确认的前缀并在边界停止（不超过 maxSteps），前缀不是到达；maxSteps 是本次调用总 transition 上限（默认 16），maxTransitions 是同一 session 的累计上限（默认 maxSteps×maxSegments），maxSegments 默认 1，只有显式提高才多段协调；sessionId 只用于续接同一冻结目标/目标类型；不自动施工，不自动切换游泳/船/攀爬。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw), to = point(a.to);
    if (!to) return { ok: false, error: 'to 需要 {x,y,z} 站立脚位；箱子/门请改用旁边的站立格' };
    const allowedRaw = a.allowed === undefined ? DEFAULT_KINDS : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((k) => !KINDS.includes(k as MoveMode))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop、ladder' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    if (a.maxSteps !== undefined && (!Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > 64)) {
      return { ok: false, error: 'maxSteps 需要 1–64 的整数' };
    }
    if (a.allowUnknownCorridor !== undefined && typeof a.allowUnknownCorridor !== 'boolean') {
      return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    }
    const ints: [string, number, number][] = [
      ['maxSegments', 1, 16], ['maxStepsPerSegment', 1, 32], ['maxTransitions', 1, 1024],
      ['maxSearches', 1, 32], ['maxObservations', 0, 8], ['maxObservedCells', 0, 512],
      ['maxNoProgressSegments', 1, 8],
    ];
    for (const [key, min, max] of ints) {
      const value = a[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        return { ok: false, error: `${key} 需要 ${min}–${max} 的整数` };
      }
    }
    for (const key of ['maxNodes', 'maxEdges'] as const) {
      const value = a[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 8192)) {
        return { ok: false, error: `${key} 需要 1–8192 的整数（单次搜索预算）` };
      }
    }
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) {
      return { ok: false, error: 'sessionId 需要非空字符串；续接时必须原样传回回执里的 sessionId' };
    }
    if (a.deadlineMs !== undefined && (typeof a.deadlineMs !== 'number' || !Number.isFinite(a.deadlineMs) || a.deadlineMs <= 0)) {
      return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    }
    const maxSteps = (a.maxSteps as number | undefined) ?? 16;
    return {
      ok: true,
      args: {
        to,
        // 只在请求边界判定一次：整数 x/z 是格目标，分数是精确连续脚位。
        targetKind: targetKindOf(to),
        allowed: [...new Set(allowedRaw as MoveMode[])],
        historical: a.historical !== false,
        maxSteps,
        allowUnknownCorridor: a.allowUnknownCorridor === true,
        maxSegments: (a.maxSegments as number | undefined) ?? 1,
        maxStepsPerSegment: (a.maxStepsPerSegment as number | undefined) ?? maxSteps,
        maxTransitions: (a.maxTransitions as number | undefined) ?? maxSteps * ((a.maxSegments as number | undefined) ?? 1),
        maxSearches: (a.maxSearches as number | undefined) ?? 6,
        maxObservations: (a.maxObservations as number | undefined) ?? 2,
        maxObservedCells: (a.maxObservedCells as number | undefined) ?? 64,
        maxNoProgressSegments: (a.maxNoProgressSegments as number | undefined) ?? 2,
        ...(a.maxNodes === undefined ? {} : { maxNodes: a.maxNodes as number }),
        ...(a.maxEdges === undefined ? {} : { maxEdges: a.maxEdges as number }),
        ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
        ...(a.deadlineMs === undefined ? {} : { deadlineMs: a.deadlineMs }),
      },
    };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial?.session?.voxel) return { status: 'failed', failureCode: 'NOT_CONNECTED', summary: 'navigate_to 需要共享空间 VoxelMap；当前没有接线' };
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return { status: 'failed', failureCode: 'NOT_CONNECTED', summary: 'navigate_to 需要有效的存活观测' };
    if (state.worldId !== spatial.worldId) return { status: 'failed', failureCode: 'WRONG_DIMENSION', summary: '当前世界与空间会话不一致' };
    const invocationStart = { ...state.pos };
    const startChunks = ctx.memory.visitedChunkCount;
    const voxel = spatial.session.voxel;
    const startObservedCells = voxel.checkpointFullCounts().observedCells;
    const maxSteps = args.maxSteps ?? 16;
    const maxSegments = args.maxSegments ?? 1;
    // validate 会冻结 targetKind；直接调用 run 的旧入口在这里按原目标补一次（只在这个边界）。
    const targetKind = args.targetKind ?? targetKindOf(args.to);
    const outcome = await runMovementCoordinator(ctx, {
      intent: { kind: 'navigate', to: { ...args.to }, targetKind, allowed: args.allowed, historical: args.historical !== false },
      maxSegments,
      maxStepsPerSegment: args.maxStepsPerSegment ?? maxSteps,
      maxTransitions: args.maxTransitions ?? maxSteps * maxSegments,
      invocationMaxTransitions: maxSteps,
      maxSearches: args.maxSearches ?? 6,
      maxObservations: args.maxObservations ?? 2,
      maxObservedCells: args.maxObservedCells ?? 64,
      maxNoProgressSegments: args.maxNoProgressSegments ?? 2,
      ...(args.maxNodes === undefined && args.maxEdges === undefined
        ? {}
        : { searchLimits: { ...(args.maxNodes === undefined ? {} : { maxNodes: args.maxNodes }), ...(args.maxEdges === undefined ? {} : { maxEdges: args.maxEdges }) } }),
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }),
      allowUnknownCorridor: args.allowUnknownCorridor === true,
    });
    const newChunks = ctx.memory.visitedChunkCount - startChunks;
    const newObservedCells = voxel.checkpointFullCounts().observedCells - startObservedCells;
    if (!outcome.ok) {
      const position = { ...ctx.adapter.state().pos };
      return {
        status: 'failed', failureCode: outcome.failureCode,
        summary: `${outcome.summary}；原目的地 (${args.to.x},${args.to.y},${args.to.z}) 仍未到达（这不是到达，也没有用前缀或计划点冒充到达）`,
        data: {
          ...(outcome.data ?? {}), requestedTarget: { ...args.to }, remainingTarget: { ...args.to },
          executed: 0, confirmedSegments: 0, remaining: [{ to: { ...args.to } }],
          position, newChunks, newObservedCells,
          segment: {
            startStance: { ...invocationStart }, endStance: position,
            arrivedAtTarget: false, remainingTarget: { ...args.to }, invalidation: outcome.data?.reason ?? 'ACTION_FAILURE',
          },
        },
      };
    }
    const last = outcome.segments.at(-1);
    const segment = segmentCompat(args, outcome, invocationStart, newChunks, newObservedCells);
    const segmentNote = `；实测位移 ${segment.displacement.horizontal} 格、新区块 ${newChunks}、新观测格 ${newObservedCells}，${segment.progress.meaningful ? '本段有进展' : '本段无新进展'}`;
    const extra = {
      requestedTarget: { ...args.to },
      remainingTarget: { ...args.to },
      ...(outcome.status === 'succeeded'
        ? { remaining: [] }
        : last?.outcome === 'replan'
          ? { remaining: [{ to: { ...args.to } }], prefixRemaining: [] }
          : { remaining: last?.remaining.length ? last.remaining : [{ to: { ...args.to } }], prefixRemaining: last?.remaining ?? [] }),
      ...(last?.blockerAhead === undefined ? {} : { blockerAhead: last.blockerAhead }),
      ...(last?.blocker === undefined ? {} : { blocker: last.blocker }),
      ...(last?.disallowed === undefined ? {} : { disallowed: last.disallowed }),
      ...(last?.directDrop === true ? { directDrop: true } : {}),
      ...(last?.nested === undefined ? {} : { nested: last.nested }),
      ...(last?.stepIndex === undefined ? {} : { stepIndex: last.stepIndex }),
      ...(last?.transition === undefined ? {} : { transition: last.transition }),
      total: last?.planned.length ?? 0,
      segment,
      ...(outcome.status === 'succeeded' ? {} : {
        position: { ...ctx.adapter.state().pos },
        lastMeasuredPosition: { ...ctx.adapter.state().pos },
        requestedTarget: { ...args.to }, remainingTarget: { ...args.to },
      }),
    };
    const data = coordinatorData(outcome, extra);
    if (outcome.status === 'cancelled') return { status: 'cancelled', summary: `${outcome.summary}${segmentNote}`, data };
    if (outcome.status === 'succeeded') {
      const reached = cell(feetCell(outcome.session.measured.current));
      return { status: 'succeeded', summary: `${outcome.summary}；实测到达 ${JSON.stringify(reached)}${segmentNote}`, data };
    }
    const halted = last?.stepIndex === undefined ? '' : '；没有继续执行';
    return { status: 'failed', failureCode: outcome.failureCode ?? 'ERROR', summary: `${outcome.summary}；原目的地 (${args.to.x},${args.to.y},${args.to.z}) 仍未到达（这不是到达）${halted}${segmentNote}`, data };
  },
};
