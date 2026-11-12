import type { Vec3Like } from '../../adapter/types.ts';
import { feetCell } from '../../perception/local.ts';
import { obj, type Skill } from '../types.ts';
import { coordinatorData, runMovementCoordinator, type CoordinatorOutcome } from './coordinator.ts';
import { targetKindOf, type NavigationArrival, type NavigationTargetKind } from './goal.ts';
import type { MoveMode } from './session.ts';
import type { MakeWayOptions } from './make-way.ts';

type NavigateArgs = {
  to: Vec3Like;
  /** validate 时冻结；直接调用 run 的旧入口可省略，run 会在唯一入口边界补齐。 */
  targetKind?: NavigationTargetKind;
  /** 内部已验证委托的验收条件；公开 navigate_to 保持精确目标语义。 */
  arrival?: NavigationArrival;
  rolling?: boolean;
  /** 内部委托（travel_to）显式允许涉水与代为游泳；公开 navigate_to 不接受。 */
  swim?: boolean;
  /** 内部委托（travel_to）显式授权开路；公开 navigate_to 不接受。 */
  makeWay?: MakeWayOptions;
  /** 内部委托（travel_to）支持开路参数：没授权时回执写明“未挖未放”。 */
  makeWayAvailable?: boolean;
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

const KINDS: readonly MoveMode[] = ['walk', 'step', 'drop', 'jump', 'ladder'];
/** Jump and ladder remain opt-in; callers must list them explicitly. */
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
 * 预算省略时按到目标的距离给出（见 defaultBudgetFor），一次调用可多段推进。
 * 不挖、不放、不搭、不换目标；UNKNOWN/STALE 不可执行，边界观察只做有限相关格。
 */
/** 连续几段既没有位移也没有新进展才交回 Agent。 */
export const DEFAULT_NO_PROGRESS_SEGMENTS = 4;
/** 默认每段最多执行多少个 transition；工具说明里的“每段最多 64 个”与此保持一致。 */
const DEFAULT_MAX_STEPS_PER_SEGMENT = 64;

/**
 * 没有显式给预算时，按到目标的直线距离给：步数约每格 3 步余量、maxSegments 约每 8 格一段，搜索约每格一次，
 * 观察约每 4 格一次；搜索节点/边预算也随距离缩放，近目标先返回本地边界而不是扫完整片连通区。
 * 这些上限只防失控，不截断正常的长途委托；显式给出的值原样生效。
 */
export function defaultBudgetFor(from: Vec3Like | undefined, to: Vec3Like) {
  const direct = from === undefined ? 16 : Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  // 精确连续脚位只能从起点格点搜到，走过一段后就解析不了：保持单段。
  const exactFeet = targetKindOf(to) === 'feet';
  return {
    maxSteps: Math.min(1024, Math.max(16, Math.ceil(direct * 3) + 8)),
    maxSegments: exactFeet ? 1 : Math.min(64, Math.max(4, Math.ceil(direct / 8))),
    maxSearches: Math.min(128, 16 + Math.ceil(direct)),
    maxObservations: Math.min(64, 8 + Math.ceil(direct / 4)),
    maxObservedCells: Math.min(4096, 512 + Math.ceil(direct) * 16),
    // 近目标（≤24 格）别按长途的节点/边预算扫完整片连通区：先在本地返回边界或
    // 证据缺口，由协调器观察/重搜；更远的路线仍用库的默认上限。
    maxNodes: direct <= 24 ? Math.min(1024, Math.max(256, 256 + Math.ceil(direct) * 24)) : 2048,
    maxEdges: direct <= 24 ? Math.min(4096, Math.max(1024, 1024 + Math.ceil(direct) * 96)) : 16384,
  };
}

export const navigateTo: Skill<NavigateArgs> = {
  name: 'navigate_to',
  description: '按你指定的目的地和允许的 walk/step/drop/jump/ladder 执行 3D 路线；jump 与 ladder 默认关闭，必须显式列入 allowed；jump 是先走到起点边缘再起跳（不疾跑），只跨 1 格宽缺口，缺口下方若是火/岩浆等危险格不走；落点脚底中心那列必须有可站立支撑（搜索按已记录体素；执行时体素缺口可由当前已加载方块即时确认），不站在邻格边缘。宿主用已记录体素做有界搜索（当前证据优先，可用历史体素作候选），并按每段连续脚位执行、实测核实；不挖、不放、不搭、不换目标，遇阻挡、落点不可见或历史路线失效就停下报事实。目标写法决定语义：整数 x/z 表示走到那一格（完成条件是脚在格内且脚高在 0.01 格容差内）；分数 x/z 表示精确连续脚位（完成条件是身体中心水平 0.12 / 垂直 0.05 格内），不会用工整格心或附近格顶替。没有完整路线时，若当前证据确认了一段可达前缀，会沿该前缀自动走到边界（最多 maxSteps 段）再停下；执行每一步前先用共享体素复验，walk/step/drop 的该格还没被感知写全时用当前已加载方块的即时几何补确认（jump/ladder 仍只认体素证据），仍确认不了才停在边界，不凭计划点穿过未加载或被阻挡的格子，也不声称到达。预算省略时按距离给分段预算（maxSegments 约每 8 格一段，实际每段最多 64 个 transition），每段从实测位置重新派生、验证，原目标不变；只要还在推进就不停，停下前会先绕向未探索的前沿点；回执带 sessionId，未完成时可原样续接（目标/允许模式/目标类型改变必须新建）。回执带原目的地、可达前缀端点、UNKNOWN/STALE/BLOCKED 边界（位置/方向/状态/原因）、搜索终态（INSUFFICIENT_EVIDENCE/NO_PATH_IN_MEMORY/UNSUPPORTED/INVALIDATED/BUDGET_EXHAUSTED）与未驻留 Section、额外观察是否可能解决、是否需要显式动作或其他移动能力。不自动挖；清障由你显式 mine_cell 后再观察/规划。',
  catalog: '{"to":{"x":…,"y":脚高,"z":…},"allowed"?:["walk","step","drop","jump","ladder"]}：走到一个确切的格（整数 x/z）或精确连续脚位（分数 x/z）；不挖不放，jump/ladder 要显式列入 allowed',
  argsDoc: '{"to":{"x":整数或分数,"y":脚高,"z":整数或分数},"allowed"?":["walk","step","drop","jump","ladder"],"historical"?true,"maxSteps"?（默认按距离约每格 3 步，最多 1024）,"allowUnknownCorridor"?false,"maxSegments"?（默认按距离约每 8 格一段）,"maxStepsPerSegment"?,"maxTransitions"?,"maxSearches"?,"maxObservations"?,"maxObservedCells"?,"maxNoProgressSegments"?,"maxNodes"?,"maxEdges"?（单次搜索预算；省略时随距离缩放，近目标更小）,"sessionId"?:,"deadlineMs"?}；to 是站立脚位/方块格，不是箱子/门方块本身；整数 x/z 按目标格验收，分数 x/z 按精确连续脚位验收（水平 0.12 / 垂直 0.05 格），不会自动改写成格心；historical 默认 true（当前证据没路时用历史体素候选，结果标 historical 并逐段当前证据复验）；没有完整路线时会自动执行当前证据/即时几何确认的前缀并在边界停止（不超过 maxSteps），前缀不是到达；maxSteps 是本次调用总 transition 上限，maxTransitions 是同一 session 的累计上限（默认 maxSteps×maxSegments），预算省略时按到目标的直线距离给出，只防失控、不截断正常长途；sessionId 只用于续接同一冻结目标/目标类型；不自动施工，不自动切换游泳/船/攀爬。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw), to = point(a.to);
    if (!to) return { ok: false, error: 'to 需要 {x,y,z} 站立脚位；箱子/门请改用旁边的站立格' };
    const allowedRaw = a.allowed === undefined ? DEFAULT_KINDS : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((k) => !KINDS.includes(k as MoveMode))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop、jump、ladder' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    if (a.maxSteps !== undefined && (!Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > 1024)) {
      return { ok: false, error: 'maxSteps 需要 1–1024 的整数' };
    }
    if (a.allowUnknownCorridor !== undefined && typeof a.allowUnknownCorridor !== 'boolean') {
      return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    }
    const ints: [string, number, number][] = [
      ['maxSegments', 1, 64], ['maxStepsPerSegment', 1, 64], ['maxTransitions', 1, 1024],
      ['maxSearches', 1, 128], ['maxObservations', 0, 64], ['maxObservedCells', 0, 4096],
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
    const defaults = defaultBudgetFor(adapter?.state().pos, to);
    const maxSteps = (a.maxSteps as number | undefined) ?? defaults.maxSteps;
    const maxSegments = (a.maxSegments as number | undefined) ?? defaults.maxSegments;
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
        maxSegments,
        maxStepsPerSegment: (a.maxStepsPerSegment as number | undefined) ?? Math.min(DEFAULT_MAX_STEPS_PER_SEGMENT, maxSteps),
        maxTransitions: (a.maxTransitions as number | undefined) ?? Math.min(1024, maxSteps * maxSegments),
        maxSearches: (a.maxSearches as number | undefined) ?? defaults.maxSearches,
        maxObservations: (a.maxObservations as number | undefined) ?? defaults.maxObservations,
        maxObservedCells: (a.maxObservedCells as number | undefined) ?? defaults.maxObservedCells,
        maxNoProgressSegments: (a.maxNoProgressSegments as number | undefined) ?? DEFAULT_NO_PROGRESS_SEGMENTS,
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
    // 门方块不是可站格：普通步行不会走进传送门。直接说明，而不是报一串碰撞/阻挡。
    const goalCell = { x: Math.floor(args.to.x), y: Math.floor(args.to.y), z: Math.floor(args.to.z) };
    const goalBlock = [goalCell, { ...goalCell, y: goalCell.y + 1 }].map((cell) => ctx.adapter.blockAt(cell)).find((name) => name === 'nether_portal' || name === 'end_portal');
    if (args.arrival === undefined && goalBlock !== undefined) {
      return { status: 'failed', failureCode: 'BAD_ARGS', summary: `目标 (${goalCell.x},${goalCell.y},${goalCell.z}) 是 ${goalBlock} 方块，步行导航不进传送门；进门用 travel_portal {"at":[${goalCell.x},${goalCell.y},${goalCell.z}]}，没有移动`,
        data: { requestedTarget: { ...args.to }, portal: goalBlock } };
    }
    const invocationStart = { ...state.pos };
    const startChunks = ctx.memory.visitedChunkCount;
    const voxel = spatial.session.voxel;
    const startObservedCells = voxel.checkpointFullCounts().observedCells;
    const defaults = defaultBudgetFor(state.pos, args.to);
    const maxSteps = args.maxSteps ?? defaults.maxSteps;
    const maxSegments = args.maxSegments ?? defaults.maxSegments;
    // validate 会冻结 targetKind；直接调用 run 的旧入口在这里按原目标补一次（只在这个边界）。
    const targetKind = args.targetKind ?? targetKindOf(args.to);
    const outcome = await runMovementCoordinator(ctx, {
      intent: { kind: 'navigate', to: { ...args.to }, targetKind, ...(args.arrival === undefined ? {} : { arrival: { ...args.arrival } }), allowed: args.allowed, historical: args.historical !== false },
      ...(args.rolling ? { rolling: true } : {}),
      ...(args.swim ? { swim: true } : {}),
      ...(args.makeWay === undefined ? {} : { makeWay: args.makeWay }),
      ...(args.makeWayAvailable === true ? { makeWayAvailable: true } : {}),
      maxSegments,
      maxStepsPerSegment: args.maxStepsPerSegment ?? Math.min(64, maxSteps),
      maxTransitions: args.maxTransitions ?? Math.min(1024, maxSteps * maxSegments),
      invocationMaxTransitions: maxSteps,
      maxSearches: args.maxSearches ?? defaults.maxSearches,
      maxObservations: args.maxObservations ?? defaults.maxObservations,
      maxObservedCells: args.maxObservedCells ?? defaults.maxObservedCells,
      maxNoProgressSegments: args.maxNoProgressSegments ?? DEFAULT_NO_PROGRESS_SEGMENTS,
      searchLimits: {
        maxNodes: args.maxNodes ?? defaults.maxNodes,
        maxEdges: args.maxEdges ?? defaults.maxEdges,
      },
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
    // 在已知地图上走过的前缀不会新增探索覆盖，但仍是实际移动。
    // 不能把探索指标的 false 告诉心智成“没走动”，诱使它改用单步或挖掘。
    const progressNote = segment.progress.meaningful ? '本段有进展'
      : outcome.segments.some((entry) => entry.confirmed.length > 0) ? '已沿确认路线移动，未新增探索覆盖'
        : segment.displacement.euclidean > 0.05 ? '身体已有部分位移，未确认新路径段' : '本段无新进展';
    const segmentNote = `；实测位移 ${segment.displacement.horizontal} 格、新区块 ${newChunks}、新观测格 ${newObservedCells}，${progressNote}`;
    const extra = {
      requestedTarget: { ...args.to },
      remainingTarget: { ...args.to },
      ...(outcome.status === 'succeeded'
        ? { remaining: [] }
        : last?.outcome === 'replan'
          ? { remaining: [{ to: { ...args.to } }], prefixRemaining: [] }
          : { remaining: last?.remaining.length ? last.remaining : [{ to: { ...args.to } }], prefixRemaining: last?.remaining ?? [] }),
      ...(last?.blockerAhead === undefined ? {} : { blockerAhead: last.blockerAhead }),
      // 计划过时后的重搜段没有执行级阻挡：回报本次调用最近一次实测到的阻挡，不让 Agent 丢掉阻挡格。
      ...(outcome.status !== 'succeeded' && [...outcome.segments].reverse().find((entry) => entry.blocker !== undefined)?.blocker !== undefined
        ? { blocker: [...outcome.segments].reverse().find((entry) => entry.blocker !== undefined)!.blocker } : {}),
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
