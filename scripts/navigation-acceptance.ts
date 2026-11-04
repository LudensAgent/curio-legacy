/**
 * 小型真实导航验收 harness（N-H1）。
 *
 * walk_to → 本轮历史查询 → walk_known_route → 测量中取消 → 共享服务最终保存/关闭/重开读回。
 * 不启动 main.ts/LLM 循环，也没有周期调度器。--help 与参数拒绝发生在任何运行时 import 之前；
 * 夹具 RCON 只允许 list 与 tp 本测试 Bot，TP 只算 setup。所有等待有界，失败保留原始数据。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { Rcon } from '../src/observer/rcon.ts';
import type { SharedSpatialSession as SharedSpatialSessionType, ShutdownResult } from '../src/spatial/shared-session.ts';
import type { SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { BodySample, ExecutableMove, ExecutableMoveResult, PathFragment, WalkRouteExecutor, WalkRouteRequest, WalkRouteStatus } from 'curio-minecraft-3d-memory';

export const LANE = { minX: 200, maxXExclusive: 219, minZ: 216, maxZExclusive: 218, feetY: 64 } as const;
const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
const WALK_BUDGET_MS = 45_000;
const QUERY_BUDGET_MS = 20_000;

export const HELP = `navigation-acceptance — bounded real navigation acceptance (N-H1)

Usage:
  node --import tsx scripts/navigation-acceptance.ts --curio=test --start=200.5,64,216.5

Options:
  --curio=test            Required; only the isolated test environment is accepted.
  --start=x,y,z           Required; explicit feet position inside the reserved dry lane
                          x[200,219), z[216,218), y=64. Values are never rounded.
  --help, -h              Print this text and exit without loading config or connecting.

A unique run DB and evidence folder are created under DATA_DIR/navigation-acceptance/<runId>.
No periodic scheduler is started.`;

export type ParsedCli =
  | { ok: true; help: true; value?: never }
  | { ok: true; help: false; curio: 'test'; start: Vec3Like; startRaw: string }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3Like => isRecord(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  if (argv.includes('--help') || argv.includes('-h')) return { ok: true, help: true };
  const curio = argv.filter((a) => a.startsWith('--curio='));
  const start = argv.filter((a) => a.startsWith('--start='));
  const unknown = argv.filter((a) => !a.startsWith('--curio=') && !a.startsWith('--start='));
  if (unknown.length) return { ok: false, error: `unknown argument(s): ${unknown.join(' ')}` };
  if (curio.length !== 1) return { ok: false, error: 'exactly one --curio=test is required' };
  if (start.length !== 1) return { ok: false, error: 'exactly one --start=x,y,z is required' };
  if (curio[0] !== '--curio=test') return { ok: false, error: `only --curio=test is accepted, got ${curio[0]}` };
  const startRaw = start[0].slice('--start='.length);
  const parts = startRaw.split(',');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) return { ok: false, error: '--start must be x,y,z' };
  const [x, y, z] = parts.map((p) => Number(p));
  if (![x, y, z].every(Number.isFinite)) return { ok: false, error: '--start coordinates must be finite' };
  if (y !== LANE.feetY) return { ok: false, error: `--start feet y must be ${LANE.feetY}` };
  if (x < LANE.minX || x >= LANE.maxXExclusive || z < LANE.minZ || z >= LANE.maxZExclusive) {
    return { ok: false, error: '--start is outside the reserved dry lane x[200,219), z[216,218)' };
  }
  return { ok: true, help: false, curio: 'test', start: { x, y, z }, startRaw };
}

export const inLane = (p: Vec3Like): boolean =>
  isVec(p) && p.y === LANE.feetY && p.x >= LANE.minX && p.x < LANE.maxXExclusive && p.z >= LANE.minZ && p.z < LANE.maxZExclusive;

const distance = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
interface Tolerance { horizontalTolerance: number; feetTolerance: number }
const withinArrival = (pos: Vec3Like, target: Vec3Like, tol: Tolerance) =>
  Math.hypot(pos.x - target.x, pos.z - target.z) <= tol.horizontalTolerance && Math.abs(pos.y - target.y) <= tol.feetTolerance;

/** 小型诊断记录：真实 WalkRouteExecutor.onSample 交付的 BodySample 及其返回值。 */
export interface CapturedRouteSample {
  taskId: string;
  delegationId: string;
  accepted: boolean;
  /** 诊断接收时间；sample.observedAt 仍是原始交付值，不用接收时间替换。 */
  receivedAt: number;
  sample: {
    executionId: string; sequence: number; worldId: string; dim: string; sessionId: string;
    observedAt: number; position: Vec3Like; onGround: boolean; inWater: boolean;
  };
  returned: {
    delegationId: string; lastPosition: Vec3Like | null; nextPointIndex: number;
    activeStepIndex: number | null; resultOutcome: string | null;
    resultLastPosition: Vec3Like | null; resultLastObservation: Record<string, unknown> | null;
  };
}
export interface TerminalSampleEvidence { taskId: string; samples: readonly CapturedRouteSample[] }

/** 成功与取消共用同一把尺：取消只需证明真实部分位移，不能比触发取消的阈值更严。 */
export const CANCEL_MOVEMENT_THRESHOLD = 0.15;

/** 终态必须精确对上该任务真实交付且被 onSample 接受的样本，不能靠时间容差或事后 state 推断。 */
function terminalSampleProblems(nav: Record<string, unknown>, evidence: TerminalSampleEvidence | undefined, start: Vec3Like,
  minMovement = 0.25) {
  const p: string[] = [];
  if (evidence === undefined) return { problems: ['missing actual same-task WalkRouteExecutor samples'] };
  const samples = evidence.samples.filter((s) => s.taskId === evidence.taskId);
  if (!samples.some((s) => s.accepted && distance(s.sample.position, start) > minMovement)) p.push('no accepted same-task sample shows measured movement');
  const pos = nav.lastPosition;
  const obs = isRecord(nav.lastObservation) ? nav.lastObservation : null;
  if (!isVec(pos) || obs === null || !isNum(obs.observedAt)) {
    p.push('missing terminal lastPosition/lastObservation');
    return { problems: p };
  }
  const matched = samples.find((s) => s.accepted
    && isDeepStrictEqual(s.sample.position, pos)
    && s.sample.worldId === obs.worldId && s.sample.dim === obs.dim && s.sample.sessionId === obs.sessionId
    && s.sample.observedAt === obs.observedAt
    && s.sample.onGround === obs.onGround && s.sample.inWater === obs.inWater);
  if (matched === undefined) p.push('terminal lastPosition/lastObservation does not exactly match an accepted same-task sample');
  return { problems: p };
}
const navOf = (result: unknown): Record<string, unknown> | null => {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  return isRecord(result.data.nav) ? result.data.nav : null;
};

/** walk_to 终态：succeeded + 原始 nav ARRIVED/confirmed + 实测位移 + 同任务真实样本 + 运行时到达容差。 */
export function classifyWalkToResult(result: unknown, start: Vec3Like, target: Vec3Like, tol: Tolerance, evidence?: TerminalSampleEvidence) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'succeeded') p.push('skill status is not succeeded');
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'ARRIVED') p.push(`nav.outcome=${String(nav.outcome)} (ARRIVED required)`);
    if (nav.confirmed !== true) p.push('nav.confirmed is not true');
    if (!isVec(nav.lastPosition)) p.push('missing nav.lastPosition');
    else {
      if (distance(nav.lastPosition, start) <= 0.25) p.push('no measured movement from start');
      if (!withinArrival(nav.lastPosition, target, tol)) p.push('nav.lastPosition outside runtime arrival tolerance');
    }
    if (!isRecord(nav.lastObservation)) p.push('missing nav.lastObservation');
    p.push(...terminalSampleProblems(nav, evidence, start).problems);
  }
  return { ok: p.length === 0, problems: p, nav };
}

/** walk_known_route 终态：STARTED + 原样历史几何 + nav ARRIVED/confirmed + 同任务真实样本。 */
export function classifyKnownRouteResult(result: unknown, originalPoints: readonly Vec3Like[], start: Vec3Like, tol: Tolerance, evidence?: TerminalSampleEvidence) {
  const p: string[] = [];
  const nav = navOf(result);
  const data = isRecord(result) && isRecord(result.data) ? result.data : null;
  const known = data !== null && isRecord(data.knownStart) ? data.knownStart : null;
  const last = originalPoints[originalPoints.length - 1];
  if (!isRecord(result) || result.status !== 'succeeded') p.push('skill status is not succeeded');
  if (known === null) p.push('missing data.knownStart');
  else {
    if (known.kind !== 'STARTED') p.push(`knownStart.kind=${String(known.kind)} (STARTED required)`);
    const route = isRecord(known.route) ? known.route : null;
    if (route === null) p.push('missing data.knownStart.route');
    else {
      if (!Array.isArray(route.points) || !route.points.every(isVec)) p.push('knownStart.route.points malformed');
      else if (!isDeepStrictEqual(route.points, originalPoints)) p.push('knownStart route geometry/order changed');
      if (!isVec(route.target) || !isDeepStrictEqual(route.target, last)) p.push('knownStart route target is not original last point');
    }
  }
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'ARRIVED') p.push(`nav.outcome=${String(nav.outcome)} (ARRIVED required)`);
    if (nav.confirmed !== true) p.push('nav.confirmed is not true');
    if (!isVec(nav.lastPosition)) p.push('missing nav.lastPosition');
    else {
      if (distance(nav.lastPosition, start) <= 0.25) p.push('no measured movement from settled start');
      if (last !== undefined && !withinArrival(nav.lastPosition, last, tol)) p.push('nav.lastPosition outside runtime arrival tolerance');
    }
    if (!isRecord(nav.lastObservation)) p.push('missing nav.lastObservation');
    p.push(...terminalSampleProblems(nav, evidence, start).problems);
  }
  return { ok: p.length === 0, problems: p, nav };
}

/** 7 个移动控制键必须全部可读且已松开；结算与取消终态共用。 */
export function controlReleaseProblems(controls: Record<string, unknown>): string[] {
  const p: string[] = [];
  const missing = CONTROL_KEYS.filter((k) => typeof controls[k] !== 'boolean');
  if (missing.length) p.push(`missing control keys: ${missing.join(',')}`);
  const active = CONTROL_KEYS.filter((k) => controls[k] === true);
  if (active.length) p.push(`controls not released: ${active.join(',')}`);
  return p;
}

/** 取消终态：cancelled/unconfirmed、部分数据精确对上同任务真实样本、7 个控制键已释放。 */
export function classifyCancellationResult(result: unknown, taskId: string, samples: readonly CapturedRouteSample[],
  controls: Record<string, unknown>, reactivated: boolean, start: Vec3Like) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'cancelled') p.push('skill status is not cancelled');
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'CANCELLED') p.push(`nav.outcome=${String(nav.outcome)} (CANCELLED required)`);
    if (nav.confirmed !== false) p.push('cancelled nav must be unconfirmed');
    if (!isVec(nav.lastPosition)) p.push('missing cancelled nav.lastPosition');
    if (!isRecord(nav.lastObservation)) p.push('missing cancelled nav.lastObservation');
    // 触发取消与终态分类使用同一阈值；取消只要求真实测得的部分位移。
    p.push(...terminalSampleProblems(nav, { taskId, samples }, start, CANCEL_MOVEMENT_THRESHOLD).problems);
  }
  p.push(...controlReleaseProblems(controls));
  if (reactivated) p.push('control reactivated during bounded post-cancel window');
  return { ok: p.length === 0, problems: p, nav };
}

/** 终态实际身体：与 NavResult 分开核对位置、落地/干燥/就绪、会话作用域与全部 7 个控制键。 */
export interface TerminalBodyEvidence {
  state: {
    pos: Vec3Like; onGround: boolean; inWater: boolean; observationReady: boolean;
    worldId: string; dim: string; sessionId: string;
  };
  controls: Record<string, unknown>;
}
export function classifyTerminalBody(body: TerminalBodyEvidence | undefined, target: Vec3Like, tol: Tolerance,
  scope: { worldId: string; dim: string; sessionId: string }) {
  const p: string[] = [];
  if (body === undefined) return { ok: false, problems: ['missing terminal body snapshot'] };
  const s = body.state;
  if (!withinArrival(s.pos, target, tol)) p.push('terminal body outside runtime arrival tolerance');
  if (!s.onGround) p.push('terminal body is not grounded');
  if (s.inWater) p.push('terminal body is in water');
  if (!s.observationReady) p.push('terminal body observation is not ready');
  if (s.worldId !== scope.worldId || s.dim !== scope.dim || s.sessionId !== scope.sessionId) {
    p.push('terminal body world/dim/session differs from this run');
  }
  p.push(...controlReleaseProblems(body.controls));
  return { ok: p.length === 0, problems: p };
}

/** 真实 WalkMoveExecutor.move 的诊断记录：只保留有限请求/结果字段，AbortSignal 等句柄明确不序列化。 */
export interface CapturedMoveRequest {
  executionId: string; worldId: string; dim: string; sessionId: string;
  from: Vec3Like; to: Vec3Like; deadlineMs: number; timeoutMs: number;
}
export interface CapturedMoveSample {
  executionId: string; sequence: number; worldId: string; dim: string; sessionId: string;
  observedAt: number; position: Vec3Like; onGround: boolean; inWater: boolean;
}
export interface CapturedMove {
  /** 发起该 move 的真实 Arbiter 任务；没有活动任务时必须是 null，不能借用样本 id。 */
  taskId: string | null;
  /** 诊断接收时间；请求里的 from/to 和结果样本时间仍是原值。 */
  receivedAt: number;
  request: CapturedMoveRequest;
  result: { sample?: CapturedMoveSample; failure?: Record<string, unknown> } | null;
  error: string | null;
}

/** 调用真实 MoveExecutor.move 并记录请求/结果；原 Promise 与返回值/异常原样透传。 */
export async function captureMoveCall(
  executor: { move(request: ExecutableMove): Promise<ExecutableMoveResult> },
  request: ExecutableMove,
  taskId: string | null,
  sink: CapturedMove[],
): Promise<ExecutableMoveResult> {
  const entry: CapturedMove = {
    taskId,
    receivedAt: Date.now(),
    request: {
      executionId: request.executionId, worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
      from: clone(request.from), to: clone(request.to), deadlineMs: request.deadlineMs, timeoutMs: request.timeoutMs,
    },
    result: null, error: null,
  };
  sink.push(entry);
  try {
    const result = await executor.move(request);
    entry.result = {
      ...(result.sample === undefined ? {} : {
        sample: {
          executionId: result.sample.executionId, sequence: result.sample.sequence,
          worldId: result.sample.worldId, dim: result.sample.dim, sessionId: result.sample.sessionId,
          observedAt: result.sample.observedAt, position: clone(result.sample.pos),
          onGround: result.sample.onGround, inWater: result.sample.inWater,
        },
      }),
      ...(result.failure === undefined ? {} : { failure: clone(result.failure) as Record<string, unknown> }),
    };
    return result;
  } catch (e) {
    entry.error = errorText(e);
    throw e;
  }
}

/**
 * N3 traversal 归属：actionId 必须是真实首个 walk 任务，executionId 必须来自该任务真实
 * ExecutableMove 请求；from 用请求原值，scope 用请求原值，to/observedAt 必须对应该请求在
 * 真实派发顺序中的确认 trace 点。不按字符串猜索引，也不接受跨段的 from/id + 端点/时间混搭。
 * 不要求 move 返回过样本（合法 onSample 已确认即可），也不拿 fragment 名义几何冒充轨迹。
 */
export function classifyTraversalOwnership(
  record: Record<string, unknown> | null,
  walkTaskId: string | null,
  moves: readonly CapturedMove[],
  nav: Record<string, unknown> | null,
) {
  const p: string[] = [];
  if (record === null) { p.push('missing traversal record'); return { ok: false, problems: p }; }
  if (walkTaskId === null) { p.push('missing actual first walk task id'); return { ok: false, problems: p }; }
  if (record.actionId !== walkTaskId) p.push(`traversal.actionId ${String(record.actionId)} is not the actual walk task ${walkTaskId}`);
  const executionId = typeof record.executionId === 'string' ? record.executionId : null;
  if (executionId === null) p.push('traversal.executionId is missing');
  // 真实派发顺序 = 该任务实际发出的 move 请求顺序；executionId 只用来定位这次派发。
  const taskMoves = moves.filter((m) => m.taskId === walkTaskId);
  const indices = executionId === null ? [] : taskMoves.flatMap((m, i) => m.request.executionId === executionId ? [i] : []);
  if (executionId !== null && indices.length === 0) p.push(`traversal.executionId ${executionId} has no actual WalkMoveExecutor request owned by ${walkTaskId}`);
  if (indices.length > 1) p.push(`traversal.executionId ${executionId} is ambiguous within ${walkTaskId} (${indices.length} actual dispatches)`);
  const move = indices.length === 1 ? taskMoves[indices[0]!] : undefined;
  if (move !== undefined) {
    if (!isDeepStrictEqual(record.from, move.request.from)) p.push('traversal.from differs from the actual move request.from');
    if (record.worldId !== move.request.worldId || record.dim !== move.request.dim || record.sessionId !== move.request.sessionId) {
      p.push('traversal world/dim/session differs from the actual move request scope');
    }
  }
  if (record.source !== 'confirmed_walk_corridor') p.push(`traversal.source=${String(record.source)} (confirmed_walk_corridor required)`);
  if (record.mode !== 'walk') p.push(`traversal.mode=${String(record.mode)} (walk required)`);
  const trace = nav !== null && Array.isArray(nav.trace) ? nav.trace.filter((t): t is { pos: Vec3Like; ts: number } => isRecord(t) && isVec(t.pos) && isNum(t.ts)) : [];
  if (nav === null || nav.confirmed !== true) p.push('missing confirmed walk nav result');
  else if (!isVec(record.to) || !isNum(record.observedAt)) p.push('traversal.to/observedAt malformed');
  else if (move === undefined) {
    // 前面的归属问题已经报告；没有确定的派发序号就不能接受任何 trace 点。
  } else if (indices[0]! >= trace.length) {
    p.push(`traversal dispatch index ${indices[0]} has no corresponding confirmed nav.trace point`);
  } else {
    const expected = trace[indices[0]!]!;
    if (!isDeepStrictEqual(record.to, expected.pos) || record.observedAt !== expected.ts) {
      p.push('traversal.to/observedAt does not correspond to the confirmed nav.trace point at the actual dispatch index');
    }
  }
  return { ok: p.length === 0, problems: p };
}

/** 初始观测批次：只取身体附近的有界局部格，交给正常 Vision.observeBlocks 视线判定。 */
export function localBodyCells(start: Vec3Like, radius = 1): Vec3Like[] {
  const feet = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const seen = new Set<string>();
  const cells: Vec3Like[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -1; dy <= 1; dy++) {
    const pos = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz };
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(pos);
  }
  return cells;
}

/**
 * 初始观测证据：`admitted` 必须取共享会话的实际准入状态，不能由 Vision 返回条数猜测；
 * Vision 的真实输出单独保留。正常 Vision.observeBlocks 仍是唯一准入/写入路径，
 * 这里不 beginSession、不填格、不强制 FRESH。
 */
export function initialObservationFacts(
  admitted: boolean,
  cells: readonly Vec3Like[],
  observations: readonly unknown[],
  at: number,
) {
  return {
    at,
    cells: clone(cells),
    admitted,
    vision: { returned: observations.length, observations: clone(observations) },
    note: 'admitted is the actual SharedSpatialSession observationAdmitted state after normal Vision.observeBlocks; Vision output is retained separately. No manual beginSession, fill or forced freshness.',
  };
}

/** 有界实际物理帧：每帧只记录交付时的位置与控制键，不事后读状态补帧。 */
export interface PhysicsFrame {
  frame: number; at: number; position: Vec3Like; onGround: boolean; inWater: boolean;
  controls: Record<string, unknown>;
}
export interface FrameControls { values: Record<string, unknown>; missing: string[] }

/**
 * 稳定落点：在真实物理帧中找一段连续、落地、干燥且位置不变的窗口，帧间时间必须自行跨越
 * 请求的稳定时长。
 *
 * 连续性上限与库执行器一致：相邻帧间隔不得超过 `Math.max(50, stableMs)`。更大的空档、
 * 非递增/重复的帧号或时间都重置窗口；不插值、不用墙钟补足，也不接受零帧。
 */
export function classifySettledFrames(frames: readonly PhysicsFrame[], stableMs: number) {
  const p: string[] = [];
  if (frames.length === 0) { p.push('no physics frames observed during settle'); return { ok: false, problems: p, position: null }; }
  const maxGapMs = Math.max(50, stableMs);
  let window: PhysicsFrame[] = [];
  let stable: PhysicsFrame[] | null = null;
  for (const frame of frames) {
    if (!frame.onGround || frame.inWater) { window = []; continue; }
    if (window.length === 0) { window = [frame]; continue; }
    const previous = window[window.length - 1]!;
    const ordered = frame.at > previous.at && frame.frame > previous.frame;
    const gapOk = frame.at - previous.at <= maxGapMs;
    const samePosition = distance(frame.position, window[0]!.position) <= 1e-6;
    if (!ordered || !gapOk || !samePosition) { window = [frame]; continue; }
    window.push(frame);
    if (frame.at - window[0]!.at >= stableMs) { stable = window; break; }
  }
  if (stable === null) {
    if (frames.length < 2) p.push('fewer than 2 distinct physics frames during settle');
    else if (!frames.some((f) => f.onGround && !f.inWater)) p.push('settle frames are not grounded and dry');
    else p.push(`no stationary grounded/dry physics-frame window spans ${stableMs}ms with gaps <= ${maxGapMs}ms`);
  }
  const last = stable === null ? null : stable[stable.length - 1]!;
  return { ok: stable !== null, problems: p, position: last === null ? null : { ...last.position } };
}

/**
 * 取消后的有界实际物理帧：没有帧、覆盖不足或任一控制键按下/缺失都不能通过。
 * 只描述这些实际采样帧上的按键状态，不声称采样间隔内每一瞬间的按键都必然为松开。
 */
export function classifyPostCancelFrames(frames: readonly PhysicsFrame[], durationMs: number) {
  const p: string[] = [];
  if (frames.length === 0) { p.push('no physics frames observed after cancel'); return { ok: false, problems: p, reactivated: true }; }
  if (frames.length < 2) p.push('fewer than 2 distinct post-cancel physics frames');
  const first = frames[0]!, last = frames[frames.length - 1]!;
  if (last.at - first.at < durationMs) p.push(`post-cancel frames span ${last.at - first.at}ms < required ${durationMs}ms`);
  let reactivated = false;
  for (const f of frames) {
    const missing = CONTROL_KEYS.filter((k) => typeof f.controls[k] !== 'boolean');
    if (missing.length || CONTROL_KEYS.some((k) => f.controls[k] === true)) { reactivated = true; break; }
  }
  if (reactivated) p.push('control reactivated or unreadable during bounded post-cancel frames');
  return { ok: p.length === 0, problems: p, reactivated };
}

/** fragments 稳定契约；返回原始条目，不把几何改写成观测。 */
export function validateFragmentsQuery(value: unknown) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], fragments: [] as Record<string, unknown>[], page: null };
  const page = isRecord(value.page) ? value.page : null;
  if (page === null) p.push('missing page');
  else {
    if (page.scan !== 'full_index_filter_sort') p.push('page.scan is not full_index_filter_sort');
    if (typeof page.scanNote !== 'string') p.push('missing page.scanNote');
    if (!isNum(page.limit) || !isNum(page.total) || !isNum(page.returned)) p.push('page numeric fields malformed');
    if (!(page.after === null || typeof page.after === 'string')) p.push('page.after malformed');
  }
  const fragments = Array.isArray(value.fragments) ? value.fragments.filter(isRecord) : [];
  if (!Array.isArray(value.fragments)) p.push('missing fragments array');
  if (page !== null && isNum(page.returned) && page.returned !== fragments.length) p.push('page.returned differs from fragments.length');
  for (const f of fragments) {
    if (typeof f.id !== 'string' || typeof f.worldId !== 'string' || typeof f.dim !== 'string') p.push('fragment identity fields malformed');
    if (typeof f.kind !== 'string' || typeof f.geometrySource !== 'string') p.push('fragment provenance fields malformed');
    if (!isNum(f.createdAt) || !isNum(f.lastUsedAt) || !isNum(f.uses)) p.push('fragment time/uses fields malformed');
    const projectionProblems = (name: string, projection: unknown) => {
      if (!isRecord(projection)) { p.push(`fragment ${name} projection malformed`); return; }
      if (!isNum(projection.points) || projection.points < 0) p.push(`fragment ${name}.points is not a non-negative count`);
      else if (projection.points === 0) {
        if (projection.first !== null || projection.last !== null) p.push(`fragment ${name} with zero points must have null first/last`);
      } else if (!isVec(projection.first) || !isVec(projection.last)) p.push(`fragment ${name} first/last malformed`);
    };
    projectionProblems('polyline', f.polyline);
    projectionProblems('entrances', f.entrances);
    const links = isRecord(f.links) ? f.links : null;
    if (links === null) p.push('fragment links projection malformed');
    else if (links.recorded === false) {
      if (typeof links.note !== 'string') p.push('fragment unrecorded links must explain that absence is not no-connection');
    } else if (links.recorded !== true) p.push('fragment links.recorded must be boolean');
    else {
      if (!isNum(links.points) || links.points < 0) p.push('fragment links.points malformed');
      else if (links.points === 0 && (links.first !== null || links.last !== null)) p.push('fragment links with zero points must have null first/last');
    }
  }
  return { ok: p.length === 0, problems: p, fragments, page };
}

/** 列表投影（点数/首末点）必须与真实 PathFragment 全量几何和元数据一致。 */
export function fragmentProjectionMatches(fragment: unknown, actual: PathFragment | null) {
  const p: string[] = [];
  if (!isRecord(fragment) || actual === null) return { ok: false, problems: ['fragment projection or typed original missing'] };
  for (const field of ['id', 'worldId', 'dim', 'kind', 'geometrySource'] as const) {
    if (fragment[field] !== actual[field]) p.push(`fragment ${field} differs from typed original`);
  }
  for (const field of ['createdAt', 'lastUsedAt', 'uses', 'deepestY'] as const) {
    if (fragment[field] !== actual[field]) p.push(`fragment ${field} differs from typed original`);
  }
  const compared = (name: 'polyline' | 'entrances' | 'links', source: readonly unknown[] | undefined) => {
    const projection = isRecord(fragment[name]) ? fragment[name] as Record<string, unknown> : null;
    if (projection === null) { p.push(`fragment ${name} projection missing`); return; }
    if (source === undefined) {
      if (projection.recorded !== false) p.push(`fragment ${name} should be reported as unrecorded`);
      return;
    }
    if (projection.points !== source.length) p.push(`fragment ${name}.points differs from typed original length`);
    if (!isDeepStrictEqual(projection.first, source[0] ?? null)) p.push(`fragment ${name}.first differs from typed original`);
    if (!isDeepStrictEqual(projection.last, source.at(-1) ?? null)) p.push(`fragment ${name}.last differs from typed original`);
  };
  compared('polyline', actual.polyline);
  compared('entrances', actual.entrances);
  compared('links', actual.links);
  return { ok: p.length === 0, problems: p };
}

/** fragment.polyline 稳定契约；返回原始有序点。 */
export function validateFragmentQuery(value: unknown, fragmentId: string) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], points: [] as Vec3Like[], total: 0 };
  if (value.found !== true) return { ok: false, problems: [`fragment not found (reason=${String(value.reason ?? 'missing')})`], points: [] as Vec3Like[], total: 0 };
  const fragment = isRecord(value.fragment) ? value.fragment : null;
  if (fragment === null || fragment.id !== fragmentId) p.push('fragment query identity mismatch');
  const poly = fragment !== null && isRecord(fragment.polyline) ? fragment.polyline : null;
  if (poly === null) return { ok: false, problems: [...p, 'missing fragment.polyline'], points: [] as Vec3Like[], total: 0 };
  if (poly.recorded !== true) p.push('polyline.recorded is not true');
  if (!isNum(poly.total) || !isNum(poly.offset) || !isNum(poly.returned)) p.push('polyline page fields malformed');
  const points = Array.isArray(poly.items) ? poly.items.filter(isVec) : [];
  if (!Array.isArray(poly.items)) p.push('polyline.items missing');
  if (poly.offset !== 0) p.push('polyline.offset is not 0');
  if (isNum(poly.returned) && poly.returned !== points.length) p.push('polyline.returned differs from items.length');
  if (isNum(poly.total) && isNum(poly.returned) && poly.returned !== poly.total) p.push('polyline page incomplete (raise limit only with a new bounded query)');
  if (points.length < 2) p.push('polyline has fewer than 2 points');
  return { ok: p.length === 0, problems: p, points, total: isNum(poly.total) ? poly.total : 0 };
}

/** traversals 稳定契约；返回原始 TraversalEvidence，不做时间/session 合成。 */
export function validateTraversalsQuery(value: unknown, fragmentId: string, scope: { worldId: string; dim: string; sessionId: string }) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], items: [] as unknown[], record: null };
  const items = Array.isArray(value.items) ? value.items : [];
  if (!Array.isArray(value.items)) p.push('missing items array');
  if (!isRecord(value.page)) p.push('missing page');
  else if (!isNum(value.page.total) || !isNum(value.page.returned) || !isNum(value.page.limit)) p.push('traversals page malformed');
  const record = items.filter((item) => isRecord(item) && item.status === 'found' && isRecord(item.record))
    .map((item) => (item as Record<string, unknown>).record as Record<string, unknown>)
    .find((r) => r.fragmentId === fragmentId) ?? null;
  if (record === null) p.push('no found TraversalEvidence for selected fragment');
  else {
    if (typeof record.id !== 'string') p.push('traversal id missing');
    if (!isVec(record.from) || !isVec(record.to)) p.push('traversal from/to malformed');
    if (record.worldId !== scope.worldId || record.dim !== scope.dim) p.push('traversal world/dim mismatch');
    if (record.sessionId !== scope.sessionId) p.push('traversal sessionId does not match this run');
    if (!isNum(record.observedAt)) p.push('traversal observedAt missing');
    if (typeof record.source !== 'string') p.push('traversal source missing');
    if (!(typeof record.actionId === 'string' && record.actionId !== '') && !(typeof record.executionId === 'string' && record.executionId !== '')) {
      p.push('traversal is not linked to an action/execution');
    }
  }
  return { ok: p.length === 0, problems: p, items, record };
}

/** Bot 客户端退出的有界分类（真实 bot.end 与 adapter disconnected 都观察到才算完整）。 */
export function classifyAdapterEnd(botEnd: boolean, adapterDisconnected: boolean, timedOut: boolean) {
  const p: string[] = [];
  if (!botEnd) p.push('bot end was not observed');
  if (!adapterDisconnected) p.push('adapter disconnect was not observed');
  if (timedOut) p.push('bounded end wait timed out');
  return { ok: p.length === 0, problems: p };
}

/** 清理失败也必须反映为非零退出，不能被主场景的错误掩盖。 */
export const acceptanceExitCode = (fatal: unknown, failures: readonly unknown[], cleanupErrors: readonly unknown[]) =>
  fatal !== null || failures.length > 0 || cleanupErrors.length > 0 ? 1 : 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(intervalMs); }
  return predicate();
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function collectMetadata(repoRoot: string, scriptPath: string) {
  const git = (args: string[]) => execFileSync('git', ['-c', `safe.directory=${repoRoot}`, ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const top = git(['rev-parse', '--show-toplevel']);
  if (path.resolve(top).toLowerCase() !== path.resolve(repoRoot).toLowerCase()) throw new Error(`git top-level mismatch: ${top}`);
  const head = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git HEAD is not a full 40-char hash: ${head}`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const packagePath = path.join(repoRoot, 'node_modules', 'curio-minecraft-3d-memory', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('installed curio package version is missing');
  const provenanceRel = `vendor/curio-minecraft-3d-memory-${version}.provenance.json`;
  const provenanceAbs = path.join(repoRoot, provenanceRel);
  let provenance: Record<string, unknown>;
  if (!fs.existsSync(provenanceAbs)) provenance = { available: false, path: provenanceRel, reason: 'missing' };
  else {
    let tracked = false;
    try { execFileSync('git', ['-c', `safe.directory=${repoRoot}`, 'ls-files', '--error-unmatch', provenanceRel], { cwd: repoRoot, stdio: 'ignore' }); tracked = true; } catch { tracked = false; }
    provenance = tracked ? { available: true, path: provenanceRel, sha256: sha256(provenanceAbs) } : { available: false, path: provenanceRel, reason: 'untracked' };
  }
  return {
    status: 'OK', gitTop: top, branch, head, clean: git(['status', '--porcelain=v1']) === '',
    script: { path: path.relative(repoRoot, scriptPath).replaceAll('\\', '/'), sha256: sha256(scriptPath) },
    package: { name: 'curio-minecraft-3d-memory', version, provenance },
  };
}

/** 声明人数必须与解析出的名字一一对应；缺冒号、count=0 却有名字都算格式错误。 */
export function parseRconList(text: string) {
  const m = /There are (\d+) of a max of (\d+) players online/i.exec(text);
  if (!m) throw new Error(`cannot parse RCON list response: ${text}`);
  const colon = text.indexOf(':');
  if (colon < 0) throw new Error(`RCON list response has no player list separator: ${text}`);
  const count = Number(m[1]);
  const rawNames = text.slice(colon + 1).split(',').map((s) => s.trim());
  if (count === 0) {
    if (rawNames.some(Boolean)) throw new Error(`RCON list declared 0 players but listed names: ${text}`);
    return { count, max: Number(m[2]), names: [] as string[], raw: text };
  }
  if (rawNames.some((s) => s === '')) throw new Error(`RCON list has an empty player entry: ${text}`);
  if (rawNames.length !== count) throw new Error(`RCON list declared ${count} players but parsed ${rawNames.length} names: ${text}`);
  return { count, max: Number(m[2]), names: rawNames, raw: text };
}

/** 连接前只要名单里已有任意一个同名测试 Bot 就拒绝：再连一个同名客户端会把已在线的踢下线。 */
export function preflightBotConflict(names: readonly string[], botName: string): string | null {
  const occurrences = names.filter((n) => n === botName).length;
  return occurrences > 0
    ? `configured test bot ${botName} already listed before connection (${occurrences}); connecting would kick it`
    : null;
}

function controlsSnapshot(adapter: { bot: unknown }) {
  const bot = isRecord(adapter.bot) ? adapter.bot : null;
  const state = bot !== null && isRecord(bot.controlState) ? bot.controlState : null;
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of CONTROL_KEYS) {
    if (state !== null && typeof state[key] === 'boolean') values[key] = state[key];
    else missing.push(key);
  }
  return { ok: missing.length === 0, values, missing };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.ok) { console.error(`navigation-acceptance: ${cli.error}`); process.exitCode = 2; return; }
  if (cli.help) { console.log(HELP); return; }
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  const { config } = await import('../src/config.ts');
  if (config.mode !== 'test') { console.error(`navigation-acceptance: only test mode is accepted, got ${config.mode}`); process.exitCode = 3; return; }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceDir = path.join(config.dataDir, 'navigation-acceptance', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });
  // 原始路线诊断只在这里放一份：真实 executor 请求、真实 move 请求/结果、原始样本。
  // 不按场景重复整个数组；样本的 observedAt/sequence/world/dim/session 是交付原值。
  const routeDiagnostics: { note: string; starts: unknown[]; moves: CapturedMove[]; samples: CapturedRouteSample[] } = {
    note: 'Original WalkRouteExecutor/WalkMoveExecutor diagnostics. sample observedAt/sequence/world/dim/session are delivered values; receivedAt is separate. AbortSignal/shapeProvider/request signals are execution handles and are omitted.',
    starts: [], moves: [], samples: [],
  };
  const evidence: Record<string, unknown> = {
    schema: 'navigation-acceptance', runId, startedAt: Date.now(), mode: config.mode, evidenceDir,
    host: { mcHost: config.mc.host, mcPort: config.mc.port, username: config.mc.username, version: config.mc.version, rconHost: config.observer.rconHost, rconPort: config.observer.rconPort },
    scheduler: 'not-started', note: 'No periodic scheduler. RCON fixture teleports are setup only, never navigation success.',
    scenarios: {} as Record<string, unknown>, tasks: [] as unknown[],
    routeDiagnostics,
    // RCON 记录从创建时就写入 evidence；中途失败也能立即保留已发出的命令与响应。
    rcon: { records: [] as unknown[] },
  };
  const rconRecords = (evidence.rcon as { records: unknown[] }).records;
  const writeEvidence = () => fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const scenarios = evidence.scenarios as Record<string, unknown>;
  const scenario = (name: string, extra: Record<string, unknown> = {}) => {
    const s: Record<string, unknown> = { name, status: 'NOT_RUN', problems: [] as string[], ...extra };
    scenarios[name] = s; writeEvidence(); return s;
  };
  const finish = (s: Record<string, unknown>) => { s.status = (s.problems as string[]).length === 0 ? 'PASS' : 'FAIL'; s.finishedAt = Date.now(); writeEvidence(); };
  const addProblem = (s: Record<string, unknown>, message: string) => { (s.problems as string[]).push(message); writeEvidence(); };
  const cleanupErrors: Array<{ step: string; error: unknown }> = [];
  let fatal: unknown = null;
  writeEvidence();

  const { EventBus } = await import('../src/events.ts');
  const { MineflayerAdapter } = await import('../src/adapter/mineflayer.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const { Arbiter } = await import('../src/arbiter/arbiter.ts');
  const { SharedSpatialSession } = await import('../src/spatial/shared-session.ts');
  const { Rcon } = await import('../src/observer/rcon.ts');
  const { WalkMoveExecutor } = await import('../src/adapter/walk-route.ts');
  const shutdownMod = await import('../src/spatial/host-shutdown.ts');
  const library = await import('curio-minecraft-3d-memory');
  const storage = await import('curio-minecraft-3d-memory/storage/sqlite');
  const tolerance = library.GROUNDED_ARRIVAL_DEFAULTS;

  try { evidence.metadata = collectMetadata(repoRoot, scriptPath); }
  catch (e) { evidence.metadata = { status: 'FAIL', error: shutdownMod.errorFacts(e) }; fatal = new Error(`metadata unavailable: ${errorText(e)}`); writeEvidence(); }

  const bus = new EventBus();
  const adapter = new MineflayerAdapter(config, bus);
  let spatial: SharedSpatialSessionType | null = null;
  let memory: InstanceType<typeof WorldMemory> | null = null;
  let arbiter: InstanceType<typeof Arbiter> | null = null;
  let rcon: Rcon | null = null;
  let shutdownResult: ShutdownResult | null = null;
  let shutdownCallError: unknown = null;
  let botEnded = false, adapterDisconnected = false, eventSequence = 0;
  let doneListener: ((outcome: TaskOutcome) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  let botEndListener: (() => void) | null = null;
  let botOwned = false;
  /** connect() 已发起（即使 spawn 失败或没有拿到 bot 引用），清理时也必须 quit 以禁用重连。 */
  let connectAttempted = false;
  let spawnObserved = false;
  type OwnedBot = { once(event: 'end', listener: () => void): void; removeListener(event: 'end', listener: () => void): void };
  let ownedBot: OwnedBot | null = null;
  let dim = 'unknown';
  let measuredStart: Vec3Like | null = null;
  let walk1TaskId: string | null = null;
  let originalFragment: PathFragment | null = null;
  let selectedTraversal: Record<string, unknown> | null = null;
  let knownPoints: Vec3Like[] | null = null;
  let voxelFact: Record<string, unknown> | null = null;
  const outcomes = new Map<string, TaskOutcome>();
  const waiters = new Map<string, { resolve: (outcome: TaskOutcome) => void; timer: NodeJS.Timeout }>();
  const routeSamples = routeDiagnostics.samples;
  let executorOriginalStart: ((this: WalkRouteExecutor, request: WalkRouteRequest) => WalkRouteStatus) | null = null;
  let executorOriginalOnSample: ((this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus) | null = null;
  let executorWrappedStart: ((this: WalkRouteExecutor, request: WalkRouteRequest) => WalkRouteStatus) | null = null;
  let executorWrappedOnSample: ((this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus) | null = null;
  let moverOriginalMove: ((this: unknown, request: ExecutableMove) => Promise<ExecutableMoveResult>) | null = null;
  let moverWrappedMove: ((this: unknown, request: ExecutableMove) => Promise<ExecutableMoveResult>) | null = null;
  const executorTasks = new WeakMap<object, { taskId: string; delegationId: string }>();
  let waitForOutcome: ((taskId: string, timeoutMs: number) => Promise<TaskOutcome | null>) | null = null;

  try {
    if (fatal !== null) throw fatal;
    spatial = await SharedSpatialSession.open({ worldId: config.memory.worldId, databasePath: path.join(evidenceDir, 'spatial.sqlite'), timeoutMs: 5000 });
    memory = new WorldMemory(null);
    const vision = new Vision(adapter, config.vision, spatial);
    arbiter = new Arbiter(adapter, memory, bus, vision, spatial);
    rcon = new Rcon(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);

    doneListener = (outcome: TaskOutcome) => {
      outcomes.set(outcome.task.id, outcome);
      (evidence.tasks as unknown[]).push({ sequence: ++eventSequence, at: Date.now(), outcome: clone(outcome) });
      writeEvidence();
      const waiter = waiters.get(outcome.task.id);
      if (waiter) { clearTimeout(waiter.timer); waiters.delete(outcome.task.id); waiter.resolve(outcome); }
    };
    arbiter.on('done', doneListener);

    // 小型诊断包装：只观察真实 WalkRouteExecutor.start/onSample，不改变请求、样本或返回值；
    // 把实际委托绑定到启动它的 Arbiter 任务，清理时只还原自己装的包装。
    const executorProto = library.WalkRouteExecutor.prototype as unknown as {
      start(this: WalkRouteExecutor, request: WalkRouteRequest): WalkRouteStatus;
      onSample(this: WalkRouteExecutor, sample: BodySample): WalkRouteStatus;
    };
    executorOriginalStart = executorProto.start;
    executorOriginalOnSample = executorProto.onSample;
    executorWrappedStart = function (this: WalkRouteExecutor, request: WalkRouteRequest) {
      const status = executorOriginalStart!.call(this, request);
      const task = arbiter?.info();
      if (task !== null && task !== undefined) executorTasks.set(this, { taskId: task.id, delegationId: status.delegationId });
      routeDiagnostics.starts.push({
        taskId: task?.id ?? null, delegationId: status.delegationId, receivedAt: Date.now(),
        // 信号、shapeProvider 等执行句柄不序列化；这里只保留证明路线/期限的有限字段。
        request: {
          worldId: request.worldId, dim: request.dim, sessionId: request.sessionId, mode: request.mode,
          body: { feet: clone(request.body.feet), width: request.body.width, height: request.body.height, pose: request.body.pose },
          points: clone(request.points), arrival: clone(request.arrival),
          ...(request.bodyArrival === undefined ? {} : { bodyArrival: clone(request.bodyArrival) }),
          deadlineMs: request.deadlineMs, timeoutMs: request.timeoutMs,
        },
        status: {
          delegationId: status.delegationId, nextPointIndex: status.nextPointIndex, activeStepIndex: status.activeStepIndex,
          lastPosition: status.lastPosition === null ? null : clone(status.lastPosition),
          resultOutcome: status.result === null ? null : status.result.outcome,
        },
      });
      writeEvidence();
      return status;
    };
    executorWrappedOnSample = function (this: WalkRouteExecutor, sample: BodySample) {
      const returned = executorOriginalOnSample!.call(this, sample);
      const binding = executorTasks.get(this as unknown as object);
      if (binding !== undefined) {
        routeSamples.push({
          taskId: binding.taskId,
          delegationId: binding.delegationId,
          accepted: sample.executionId === returned.delegationId && isDeepStrictEqual(returned.lastPosition, sample.pos) && isNum(sample.sequence),
          receivedAt: Date.now(),
          sample: {
            executionId: sample.executionId, sequence: sample.sequence,
            worldId: sample.worldId, dim: sample.dim, sessionId: sample.sessionId,
            observedAt: sample.observedAt, position: { ...sample.pos },
            onGround: sample.onGround, inWater: sample.inWater,
          },
          returned: {
            delegationId: returned.delegationId,
            lastPosition: returned.lastPosition === null ? null : { ...returned.lastPosition },
            nextPointIndex: returned.nextPointIndex, activeStepIndex: returned.activeStepIndex,
            resultOutcome: returned.result === null ? null : returned.result.outcome,
            resultLastPosition: returned.result?.lastPosition === undefined ? null : { ...returned.result.lastPosition },
            resultLastObservation: returned.result?.lastObservation === undefined ? null : { ...returned.result.lastObservation } as Record<string, unknown>,
          },
        });
        writeEvidence();
      }
      return returned;
    };
    executorProto.start = executorWrappedStart;
    executorProto.onSample = executorWrappedOnSample;

    // 真实单段移动诊断：只观察实际 WalkMoveExecutor.move 的请求/结果，原样透传 Promise、
    // 返回值与异常；任务归属在该 move 被发起时从真实 Arbiter 读取，不借用样本 id。
    const moverProto = WalkMoveExecutor.prototype as unknown as {
      move(this: unknown, request: ExecutableMove): Promise<ExecutableMoveResult>;
    };
    moverOriginalMove = moverProto.move;
    moverWrappedMove = function (this: unknown, request: ExecutableMove) {
      const taskId = arbiter?.info()?.id ?? null;
      // captureMoveCall 在第一个 await 前同步登记请求，所以这里立即落盘请求；结果到达后再写一次。
      const pending = captureMoveCall(
        { move: (r) => moverOriginalMove!.call(this, r) }, request, taskId, routeDiagnostics.moves,
      );
      writeEvidence();
      return pending.finally(writeEvidence);
    };
    moverProto.move = moverWrappedMove;

    /** 有界等待某任务的真实终态；即使已在 done 竞态中先到，也从 outcomes 取回。 */
    waitForOutcome = (taskId: string, timeoutMs: number): Promise<TaskOutcome | null> => {
      const existing = outcomes.get(taskId);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { arbiter?.off('done', onDone); resolve(null); }, timeoutMs);
        const onDone = (outcome: TaskOutcome) => {
          if (outcome.task.id !== taskId) return;
          clearTimeout(timer);
          arbiter?.off('done', onDone);
          resolve(outcome);
        };
        arbiter!.on('done', onDone);
      });
    };

    const startTask = (skill: string, args: unknown, budgetMs: number) => {
      const started = arbiter!.start({ skill, args }, 'user');
      if ('error' in started) throw new Error(`${skill} rejected: ${started.error}`);
      const info = started as TaskInfo;
      const done = new Promise<TaskOutcome | null>((resolve) => {
        const timer = setTimeout(() => { waiters.delete(info.id); resolve(null); }, budgetMs);
        waiters.set(info.id, { resolve: (outcome) => { clearTimeout(timer); resolve(outcome); }, timer });
      });
      // 同步终态可能在 waiter 注册前已经写入 outcomes：先查结果，避免永久等到预算耗尽。
      const settled = outcomes.get(info.id);
      if (settled !== undefined) {
        const waiter = waiters.get(info.id);
        if (waiter !== undefined) clearTimeout(waiter.timer);
        waiters.delete(info.id);
        return { info, done: Promise.resolve(settled) };
      }
      return { info, done };
    };

    const sendRcon = async (command: string) => {
      if (!(command === 'list' || /^tp [A-Za-z0-9_]{1,16} -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(command))) throw new Error(`RCON command not allowed: ${command}`);
      const rec: Record<string, unknown> = { sequence: ++eventSequence, at: Date.now(), command };
      try { rec.response = await rcon!.send(command); rconRecords.push(rec); writeEvidence(); return rec.response as string; }
      catch (e) { rec.error = shutdownMod.errorFacts(e); rconRecords.push(rec); writeEvidence(); throw e; }
    };

    // 当前物理帧源：只订阅真实的 physicsTick；没有帧时显式失败，不事后读 state 补帧。
    // 每次现取 walkTick，避免在 Bot 连接前捕获空实现。
    let frameCounter = 0;
    const nextPhysicsFrame = async (timeoutMs: number) => {
      const tick = adapter.walkTick?.();
      if (!tick) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      try { return await tick(controller.signal); } finally { clearTimeout(timer); }
    };
    const collectPhysicsFrames = async (spanMs: number, hardCapMs: number): Promise<PhysicsFrame[]> => {
      const frames: PhysicsFrame[] = [];
      if (!adapter.walkTick) return frames;
      const startedAt = Date.now();
      let firstAt: number | null = null;
      while (Date.now() - startedAt < hardCapMs) {
        const entity = await nextPhysicsFrame(Math.min(1000, hardCapMs - (Date.now() - startedAt)));
        if (entity === null) break;
        const at = Date.now();
        firstAt ??= at;
        frames.push({ frame: ++frameCounter, at, position: { ...entity.position }, onGround: entity.onGround, inWater: entity.isInWater, controls: controlsSnapshot(adapter).values });
        if (at - firstAt >= spanMs) break;
      }
      return frames;
    };

    const settleBody = async (timeoutMs: number) => {
      // 在硬上限内持续收集真实物理帧，直到出现连续 300ms 的落地/干燥/静止窗口；
      // 早期残余速度只重置窗口，不用墙钟或补造帧凑时长。
      const frames: PhysicsFrame[] = [];
      const startedAt = Date.now();
      let settled = classifySettledFrames(frames, 300);
      while (!settled.ok && Date.now() - startedAt < timeoutMs) {
        const entity = await nextPhysicsFrame(Math.min(1000, timeoutMs - (Date.now() - startedAt)));
        if (entity === null) break;
        frames.push({ frame: ++frameCounter, at: Date.now(), position: { ...entity.position }, onGround: entity.onGround, inWater: entity.isInWater, controls: controlsSnapshot(adapter).values });
        settled = classifySettledFrames(frames, 300);
      }
      if (!settled.ok || settled.position === null) throw new Error(`bounded body settle failed: ${settled.problems.join(', ')}`);
      if (!adapter.state().observationReady) throw new Error('body settled only after observationReady was lost');
      return settled.position;
    };

    const fixtureTeleport = async (position: Vec3Like, label: string) => {
      if (arbiter!.info() !== null) throw new Error(`refusing fixture tp while a task is active (${label})`);
      const name = config.mc.username;
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`unsafe bot username: ${name}`);
      if (adapter.state().username !== name) throw new Error(`connected bot identity ${adapter.state().username} is not configured test user ${name}`);
      if (!isVec(position) || !inLane(position)) throw new Error(`refusing to tp outside lane: ${JSON.stringify(position)}`);
      // 每次夹具 tp 前都确认：真实连接身份就是配置的测试 Bot，且 RCON 只列出这一个同名 Bot。
      const list = parseRconList(await sendRcon('list'));
      const occurrences = list.names.filter((n) => n === name).length;
      if (occurrences !== 1) throw new Error(`fixture tp requires RCON to list ${name} exactly once; got ${occurrences}`);
      const command = `tp ${name} ${String(position.x)} ${String(position.y)} ${String(position.z)}`;
      if (!command.startsWith(`tp ${name} `)) throw new Error(`refusing non-literal fixture tp command: ${command}`);
      (scenarios.fixture ??= { requests: [] as unknown[], responses: [] as unknown[] });
      const fixture = scenarios.fixture as Record<string, unknown>;
      (fixture.requests as unknown[]).push({ label, at: Date.now(), command, position: clone(position), sequence: eventSequence + 1 });
      const response = await sendRcon(command);
      (fixture.responses as unknown[]).push({ label, at: Date.now(), response });
      writeEvidence();
      const reached = await waitFor(() => { const s = adapter!.state(); return s.observationReady && s.onGround && distance(s.pos, position) <= 0.75; }, 10_000);
      if (!reached) throw new Error(`fixture tp did not settle at ${label}`);
      const settled = await settleBody(15_000);
      // 保留测量通道：别的玩家若在保留通道内，只报告干扰并失败，绝不移动他们。
      const interference = adapter.nearbyEntities(24)
        .filter((e) => e.kind === 'player' && e.name !== name && inLane(e.pos))
        .map((e) => ({ name: e.name, pos: { ...e.pos }, dist: e.dist }));
      if (interference.length) {
        fixture.interference = [...((fixture.interference as unknown[] | undefined) ?? []), { label, at: Date.now(), players: interference }];
        writeEvidence();
        throw new Error(`fixture interference in reserved measurement lane at ${label}: ${interference.map((p) => p.name).join(',')}`);
      }
      return settled;
    };

    const captureVoxelFact = (voxel: { cellAt(dim: string, x: number, y: number, z: number): unknown }, dimension: string, points: readonly Vec3Like[]) => {
      const seen = new Set<string>();
      for (const point of points) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 1; dy++) {
        const x = Math.floor(point.x) + dx, y = Math.floor(point.y) + dy, z = Math.floor(point.z) + dz;
        const key = `${x},${y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = voxel.cellAt(dimension, x, y, z);
        if (!isRecord(cell) || cell.observed !== true || !isRecord(cell.evidence)) continue;
        const observation = cell.evidence.observation;
        if (cell.evidence.freshness !== 'FRESH' || !isRecord(observation)) continue;
        return { dim: dimension, pos: { x, y, z }, freshness: 'FRESH', observation: clone(observation), revision: cell.evidence.revision, validUntil: cell.evidence.validUntil };
      }
      return null;
    };

    disconnectListener = () => { adapterDisconnected = true; };
    adapter.on('disconnected', disconnectListener);

    const botName = config.mc.username;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(botName)) throw new Error(`unsafe bot username: ${botName}`);
    const preflight = parseRconList(await sendRcon('list'));
    evidence.preflight = { at: Date.now(), ...preflight, sequence: (rconRecords.at(-1) as Record<string, unknown> | undefined)?.sequence };
    writeEvidence();
    // 根检查只读 list；其他玩家可以远远旁观。连接前名单里只要已有任意一个同名测试 Bot 就拒绝：
    // 再连一个同名客户端会把已在线的踢下线。绝不据此发命令或移动其他玩家。
    const preflightConflict = preflightBotConflict(preflight.names, botName);
    if (preflightConflict !== null) throw new Error(preflightConflict);

    let spawnTimer: NodeJS.Timeout | null = null;
    let spawnListener: (() => void) | null = null;
    const spawn = new Promise<void>((resolve, reject) => {
      spawnTimer = setTimeout(() => reject(new Error('bounded spawn wait timed out')), 30_000);
      spawnListener = () => { spawnObserved = true; resolve(); };
      adapter.once('spawn', spawnListener);
    });
    // MineflayerAdapter.connect 同步 createBot 并立即赋值 this.bot；连接后马上捕获实际拥有的引用。
    const ownBot = () => {
      if (ownedBot !== null || !adapter.bot) return;
      ownedBot = adapter.bot as unknown as OwnedBot;
      botOwned = true;
      botEndListener = () => { botEnded = true; };
      ownedBot!.once('end', botEndListener);
    };
    try {
      connectAttempted = true;
      adapter.connect();
      ownBot();
      await spawn;
      ownBot();
    } finally {
      // spawn 成功/失败/超时都要撤掉自己的有界监听器与计时器。
      if (spawnTimer !== null) { clearTimeout(spawnTimer); spawnTimer = null; }
      if (spawnListener !== null) { adapter.off('spawn', spawnListener); spawnListener = null; }
    }
    const ready = await waitFor(() => adapter.state().observationReady, 30_000);
    if (!ready) throw new Error('bounded observationReady wait timed out');

    const postConnect = parseRconList(await sendRcon('list'));
    evidence.postConnect = { at: Date.now(), ...postConnect, sequence: (rconRecords.at(-1) as Record<string, unknown> | undefined)?.sequence };
    writeEvidence();
    if (postConnect.names.filter((n) => n === botName).length !== 1) {
      throw new Error(`post-connect RCON list must contain owned bot ${botName} exactly once; got ${JSON.stringify(postConnect.names)}`);
    }
    dim = adapter.state().dim;
    evidence.dim = dim;

    measuredStart = await fixtureTeleport(cli.start, 'initial-safe-start');
    evidence.measuredStart = clone(measuredStart);
    writeEvidence();

    // 初始化审计：构造 Vision/Arbiter 本身不构成观测准入。夹具站位稳定后，用生产同一条
    // 正常合法视线路径做一次有界局部观测，并原样记录返回的观察；不手动 beginSession、
    // 不填充路线、不强制 FRESH，也不读隐藏地形。
    const initialCells = localBodyCells(measuredStart);
    const initialObservations = vision.observeBlocks(initialCells);
    // 准入状态取共享会话实际值；Vision 返回条数单独保留，不用它猜 admitted。
    evidence.initialObservation = initialObservationFacts(
      spatial.observationAdmitted, initialCells, initialObservations, Date.now(),
    );
    writeEvidence();

    const preHistory = scenario('pre_walk_empty_history');
    try {
      const task = startTask('spatial_query', { kind: 'fragments', dim, limit: 8 }, QUERY_BUDGET_MS);
      const outcome = await task.done;
      preHistory.task = clone(task.info);
      preHistory.outcome = outcome === null ? null : clone(outcome);
      if (outcome === null) throw new Error('pre-walk history query timed out');
      if (outcome.result.status !== 'succeeded') throw new Error(`pre-walk history query status ${outcome.result.status}`);
      const q = isRecord(outcome.result.data) ? outcome.result.data.spatialQuery : undefined;
      const checked = validateFragmentsQuery(q);
      preHistory.query = q === undefined ? null : clone(q);
      preHistory.verdict = checked;
      if (!checked.ok) throw new Error(`pre-walk query invalid: ${checked.problems.join(', ')}`);
      if (checked.page === null || checked.page.total !== 0 || checked.fragments.length !== 0) throw new Error('fresh run history is not empty before first walk');
    } catch (e) { addProblem(preHistory, errorText(e)); } finally { finish(preHistory); }

    const s1 = scenario('walk_to');
    try {
      const start = measuredStart;
      if (start === null) throw new Error('missing measured start');
      const target = { x: start.x + 2, y: start.y, z: start.z };
      s1.measuredStart = clone(start); s1.target = clone(target);
      if (!inLane(start) || !inLane(target)) throw new Error('walk_to start/target outside reserved lane');
      const scope = { worldId: adapter.state().worldId, dim: adapter.state().dim, sessionId: adapter.state().sessionId };
      s1.scope = clone(scope);
      const request = { to: clone(target), arrival: { kind: 'exact' as const }, deadlineMs: Date.now() + WALK_BUDGET_MS };
      s1.request = clone(request);
      const task = startTask('walk_to', request, WALK_BUDGET_MS + 5000);
      walk1TaskId = task.info.id;
      s1.task = clone(task.info); writeEvidence();
      const outcome = await task.done;
      s1.outcome = outcome === null ? null : clone(outcome);
      // 终态同一时刻的真实身体与控制键：位置用运行时同一个 Math.hypot 水平/脚位容差。
      const terminalState = adapter.state();
      const terminalControls = controlsSnapshot(adapter);
      s1.body = clone(terminalState); s1.controls = terminalControls;
      if (outcome === null) throw new Error('walk_to timed out before terminal outcome');
      const nav = navOf(outcome.result);
      // 历史写入标记原样保留：pending/缺失不能被当成已保存。
      s1.memoryWrite = nav?.memoryWrite ?? null;
      const verdict = classifyWalkToResult(outcome.result, start, target, tolerance, { taskId: task.info.id, samples: routeSamples });
      const bodyVerdict = classifyTerminalBody({ state: terminalState, controls: terminalControls.values }, target, tolerance, scope);
      s1.verdict = verdict; s1.bodyVerdict = bodyVerdict;
      if (!verdict.ok || !bodyVerdict.ok) throw new Error([...verdict.problems, ...bodyVerdict.problems].join(', '));
    } catch (e) { addProblem(s1, errorText(e)); } finally { finish(s1); }

    const s2 = scenario('spatial_query_history');
    const queries: Array<Record<string, unknown>> = [];
    s2.queries = queries;
    try {
      const runQuery = async (name: string, args: Record<string, unknown>) => {
        const task = startTask('spatial_query', args, QUERY_BUDGET_MS);
        const outcome = await task.done;
        const entry: Record<string, unknown> = { name, at: Date.now(), request: clone(args), task: clone(task.info), outcome: outcome === null ? null : clone(outcome) };
        queries.push(entry); writeEvidence();
        if (outcome === null) throw new Error(`${name} query timed out`);
        if (outcome.result.status !== 'succeeded') throw new Error(`${name} query status ${outcome.result.status}`);
        const q = isRecord(outcome.result.data) ? outcome.result.data.spatialQuery : undefined;
        entry.query = q === undefined ? null : clone(q); writeEvidence();
        if (q === undefined) throw new Error(`${name} query missing data.spatialQuery`);
        return q;
      };
      const fragments = validateFragmentsQuery(await runQuery('fragments', { kind: 'fragments', dim, limit: 8 }));
      s2.fragmentsVerdict = fragments;
      if (!fragments.ok) throw new Error(fragments.problems.join(', '));
      const selected = fragments.fragments.find((f) => f.geometrySource === 'traversal') ?? null;
      if (selected === null) throw new Error('no traversal-sourced fragment in fresh history');
      s2.selectedProjection = clone(selected);
      const fragmentId = selected.id as string;

      // 用真实历史读取完整几何：列表里的 polyline.points 是点数，不是数组，不能拿来与完整点列比较。
      const typed = spatial.session.history.getFragment(fragmentId);
      if (typed === null) throw new Error(`typed PathFragment ${fragmentId} missing after walk`);
      originalFragment = typed;
      const projection = fragmentProjectionMatches(selected, typed);
      s2.fragmentProjection = projection;
      if (!projection.ok) throw new Error(`fragment listing projection differs from typed original: ${projection.problems.join(', ')}`);

      // 路线点上限 32：单页 limit=32 已是有界完整读取；helper 要求 offset=0 且该页完整，
      // 不写一个实际无法翻页的循环来假装分页。
      const polylinePage = validateFragmentQuery(await runQuery('fragment.polyline', { kind: 'fragment', dim, fragmentId, field: 'polyline', offset: 0, limit: 32 }), fragmentId);
      s2.polylineVerdict = polylinePage;
      if (!polylinePage.ok) throw new Error(polylinePage.problems.join(', '));
      const points: Vec3Like[] = polylinePage.points;
      const total = polylinePage.total;
      if (points.length !== total) throw new Error(`fragment query returned ${points.length}/${total} polyline points`);
      if (!isDeepStrictEqual(points, typed.polyline)) throw new Error('fragment query polyline differs from typed original geometry/order');
      if (!points.every(inLane)) throw new Error('stored route leaves the reserved dry lane');
      if (!points.slice(1).every((p, i) => p.y === points[i].y && Math.abs(p.x - points[i].x) + Math.abs(p.z - points[i].z) === 1)) throw new Error('stored polyline is not same-height unit-adjacent');
      knownPoints = points;

      const scope = { worldId: adapter.state().worldId, dim, sessionId: adapter.state().sessionId };
      const traversals = validateTraversalsQuery(await runQuery('traversals', { kind: 'traversals', dim, fragmentId, limit: 8 }), fragmentId, scope);
      s2.traversalsVerdict = traversals;
      if (!traversals.ok) throw new Error(traversals.problems.join(', '));
      selectedTraversal = traversals.record;
      // N3 归属：actionId 必须等于真实首个 walk 任务，executionId 必须来自该任务真实
      // ExecutableMove 请求；from 用请求原值，to/observedAt 必须对应已确认 nav.trace 点。
      // delegation 样本 id 与逐段 executionId 不同，不能再用样本 id 反推归属。
      const walk1Outcome = walk1TaskId === null ? null : outcomes.get(walk1TaskId) ?? null;
      const walk1Nav = walk1Outcome === null ? null : navOf(walk1Outcome.result);
      const ownership = classifyTraversalOwnership(selectedTraversal, walk1TaskId, routeDiagnostics.moves, walk1Nav);
      s2.traversalOwnership = ownership;
      // 历史写入原样记录：pending/缺失只是 accepted-pending，不等于已保存。
      s2.memoryWrite = walk1Nav?.memoryWrite ?? null;
      s2.geometryRole = 'typed fragment polyline is nominal route geometry; actual traversal endpoints/times come from captured move requests plus confirmed nav.trace';
      if (!ownership.ok) addProblem(s2, ownership.problems.join(', '));
    } catch (e) { addProblem(s2, errorText(e)); } finally { finish(s2); }

    const s3 = scenario('walk_known_route');
    try {
      if (originalFragment === null || knownPoints === null) throw new Error('no typed original fragment geometry from this run');
      const first = knownPoints[0], last = knownPoints[knownPoints.length - 1];
      s3.storedGeometry = { first: clone(first), last: clone(last), points: clone(knownPoints) };
      if (!inLane(first)) throw new Error('stored first point outside lane');
      const settled = await fixtureTeleport(first, 'known-route-first-point');
      s3.settledStart = clone(settled);
      if (!(Math.hypot(settled.x - first.x, settled.z - first.z) <= tolerance.horizontalTolerance && Math.abs(settled.y - first.y) <= tolerance.feetTolerance)) throw new Error('actual settled body does not satisfy the runtime start point');
      const scope = { worldId: adapter.state().worldId, dim: adapter.state().dim, sessionId: adapter.state().sessionId };
      s3.scope = clone(scope);
      const request = { fragmentId: originalFragment.id, deadlineMs: Date.now() + WALK_BUDGET_MS };
      s3.request = clone(request);
      const task = startTask('walk_known_route', request, WALK_BUDGET_MS + 5000);
      s3.task = clone(task.info); writeEvidence();
      const outcome = await task.done;
      s3.outcome = outcome === null ? null : clone(outcome);
      const terminalState = adapter.state();
      const terminalControls = controlsSnapshot(adapter);
      s3.body = clone(terminalState); s3.controls = terminalControls;
      if (outcome === null) throw new Error('walk_known_route timed out before terminal outcome');
      const nav = navOf(outcome.result);
      s3.memoryWrite = nav?.memoryWrite ?? null;
      const verdict = classifyKnownRouteResult(outcome.result, knownPoints, settled, tolerance, { taskId: task.info.id, samples: routeSamples });
      // 原始终点：已知路线最后一个原始点，不是名义几何之外的猜测。
      const bodyVerdict = classifyTerminalBody({ state: terminalState, controls: terminalControls.values }, last, tolerance, scope);
      s3.verdict = verdict; s3.bodyVerdict = bodyVerdict;
      if (!verdict.ok || !bodyVerdict.ok) throw new Error([...verdict.problems, ...bodyVerdict.problems].join(', '));
    } catch (e) { addProblem(s3, errorText(e)); } finally { finish(s3); }

    const s4 = scenario('cancel_after_movement');
    let cancelTask: { info: TaskInfo; done: Promise<TaskOutcome | null> } | null = null;
    try {
      const start = await settleBody(15_000);
      const target = { x: start.x + (start.x + 2 < LANE.maxXExclusive ? 2 : -2), y: start.y, z: start.z };
      if (!inLane(target)) throw new Error('cancel walk target outside reserved lane');
      const request = { to: clone(target), arrival: { kind: 'exact' as const }, deadlineMs: Date.now() + 15_000 };
      s4.request = clone(request); s4.measuredStart = clone(start); s4.target = clone(target);
      cancelTask = startTask('walk_to', request, 20_000);
      s4.task = clone(cancelTask.info); writeEvidence();
      // 只在实际同任务样本证明已经移动后才取消；触发与终态分类共用同一个取消阈值。
      const taskId = cancelTask.info.id;
      const moved = await waitFor(() => routeSamples.some((s) => s.taskId === taskId && s.accepted
        && distance(s.sample.position, start) > CANCEL_MOVEMENT_THRESHOLD), 15_000, 25);
      if (!moved) throw new Error('no accepted same-task movement sample before cancel');
      // 取消必须发生在任务尚未完成时，不能等它自然到达后再补一个 cancelled 结论。
      if (outcomes.has(taskId)) throw new Error('walk task reached a terminal outcome before cancellation was triggered');
      const cancelAt = Date.now();
      arbiter!.cancel('navigation acceptance cancel');
      // 生产 cancel 后立即读取全部 7 个控制键，再等真实终态；两处都在任何 harness fallback 之前读取。
      const controlsAtCancel = controlsSnapshot(adapter);
      s4.cancellation = { sequence: ++eventSequence, at: cancelAt, reason: 'navigation acceptance cancel', controlsAtCancel };
      writeEvidence();
      const outcome = await cancelTask.done;
      s4.outcome = outcome === null ? null : clone(outcome);
      const controlsAtTerminal = controlsSnapshot(adapter);
      s4.controlsAtTerminal = controlsAtTerminal; writeEvidence();
      // 终态同样要求全部 7 个控制键可读且已释放（在 fallback 清理之前读取）。
      const terminalControlProblems = controlReleaseProblems(controlsAtTerminal.values);
      if (terminalControlProblems.length) throw new Error(`terminal controls: ${terminalControlProblems.join(', ')}`);
      // 有界实际物理帧覆盖取消后窗口；没有帧不能 PASS。
      const postCancelFrames = await collectPhysicsFrames(600, 2500);
      const postCancel = classifyPostCancelFrames(postCancelFrames, 600);
      s4.postCancelWindow = { durationMs: 600, frames: postCancelFrames, verdict: postCancel };
      if (!postCancel.ok) throw new Error(postCancel.problems.join(', '));
      if (outcome === null) throw new Error('cancelled task timed out before terminal outcome');
      const verdict = classifyCancellationResult(outcome.result, taskId, routeSamples, controlsAtCancel.values, postCancel.reactivated, start);
      s4.verdict = verdict;
      if (!verdict.ok) throw new Error(verdict.problems.join(', '));
    } catch (e) { addProblem(s4, errorText(e)); }
    finally {
      if (cancelTask !== null && arbiter?.info()?.id === cancelTask.info.id) arbiter.cancel('acceptance cleanup');
      finish(s4);
    }

    if (spatial !== null && knownPoints !== null) {
      voxelFact = captureVoxelFact(spatial.session.voxel, dim, knownPoints) as Record<string, unknown> | null;
      evidence.voxelFact = voxelFact === null ? { status: 'not-captured' } : voxelFact;
      writeEvidence();
    }
  } catch (e) {
    fatal = e;
    evidence.fatalError = shutdownMod.errorFacts(e);
    writeEvidence();
  }

  const s5 = scenario('shutdown_reopen');
  let reopened: SpatialSession | null = null;
  try {
    // 关停前先用现有 setPaused/cancel gating Arbiter，并等活动任务的真实终态；done 监听此时仍保留。
    const active = arbiter?.info() ?? null;
    evidence.shutdownGate = { activeTaskId: active?.id ?? null, at: Date.now() };
    writeEvidence();
    if (arbiter !== null) {
      // 用现有 pause/cancel 关闸，阻止新任务；然后有界等待活动任务的真实终态，done 监听仍保留。
      try { arbiter.setPaused(true); }
      catch (e) { addProblem(s5, `shutdown gate pause/cancel failed: ${errorText(e)}`); cleanupErrors.push({ step: 'shutdown-gate', error: e }); }
      if (active !== null) {
        const settled = waitForOutcome === null ? null : await waitForOutcome(active.id, 15_000);
        s5.activeTaskOutcome = settled === null ? null : clone(settled);
        if (settled === null) addProblem(s5, `active task ${active.id} did not settle after pause/cancel`);
      }
    }
    if (spatial === null) addProblem(s5, 'shared session was never opened');
    else {
      try {
        shutdownResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded shutdown wait');
      } catch (e) { shutdownCallError = e; }
      const diagnostics = shutdownResult === null ? null : shutdownMod.spatialShutdownDiagnostics(shutdownResult, spatial.worldId);
      const state = spatial.getPersistenceState();
      s5.shutdown = {
        diagnostics, callError: shutdownCallError === null ? null : shutdownMod.errorFacts(shutdownCallError),
        finalState: {
          lifecycle: state.lifecycle, dirty: state.dirty, voxelRevision: state.voxelRevision, confirmedVoxelRevision: state.confirmedVoxelRevision,
          fragmentRevision: state.fragmentRevision, confirmedFragmentRevision: state.confirmedFragmentRevision,
          topologyRevision: state.topologyRevision, confirmedTopologyRevision: state.confirmedTopologyRevision, lastConfirmedCheckpointId: state.lastConfirmedCheckpointId,
        },
        checkpoint: shutdownResult?.checkpoint ?? null, close: shutdownResult?.close ?? null,
      };
      writeEvidence();
      if (shutdownResult === null) addProblem(s5, 'shared.shutdown did not return a result');
      else {
        if (diagnostics === null || !diagnostics.ok) addProblem(s5, `shutdown diagnostics: ${(diagnostics?.problems ?? ['missing']).join(',')}`);
        const checkpoint = shutdownResult.checkpoint;
        if (checkpoint === null) addProblem(s5, 'missing final checkpoint');
        else {
          if (state.dirty) addProblem(s5, 'final persistence state is dirty');
          if (state.lastConfirmedCheckpointId !== checkpoint.checkpointId) addProblem(s5, 'final checkpoint id was not confirmed');
          const revisions: Array<[string, number, number, number]> = [
            ['voxel', checkpoint.voxelRevision, state.voxelRevision, state.confirmedVoxelRevision],
            ['fragment', checkpoint.fragmentRevision, state.fragmentRevision, state.confirmedFragmentRevision],
            ['topology', checkpoint.topologyRevision, state.topologyRevision, state.confirmedTopologyRevision],
          ];
          for (const [name, cp, current, confirmed] of revisions) if (cp !== current || cp !== confirmed) addProblem(s5, `${name} revision not current+confirmed`);
        }
        const close = shutdownResult.close;
        if (close === null) addProblem(s5, 'missing close result');
        else if (!close.completed || close.error !== null || close.unconfirmedRequest || close.dirty) addProblem(s5, 'close was not cleanly completed');
        if (shutdownResult.error !== null) addProblem(s5, 'primary save error present');
        if (shutdownResult.cancelError !== null) addProblem(s5, 'cancel error present');
        if (shutdownResult.closeError !== null) addProblem(s5, 'close error present');
      }
    }

    // 重开与持久化 PASS 必须同时具备：确认的干净 close + 原始 typed 片段/记录 + 可核对的 voxel 证据。
    // 只有 close 成功不算保存证据；缺任何一项都保持 FAIL。
    if (originalFragment === null) addProblem(s5, 'no typed original PathFragment for persistence comparison');
    if (selectedTraversal === null) addProblem(s5, 'no original traversal record for persistence comparison');
    if (voxelFact === null) addProblem(s5, 'no captured voxel evidence; voxel persistence is unverified');
    const closeConfirmed = shutdownResult !== null && shutdownResult.close !== null
      && shutdownResult.close.completed && shutdownResult.close.error === null
      && !shutdownResult.close.unconfirmedRequest && !shutdownResult.close.dirty;
    if ((s5.problems as string[]).length === 0 && closeConfirmed) {
      reopened = await withTimeout(storage.openSpatialSession({ databasePath: spatial!.databasePath, worldId: spatial!.worldId, timeoutMs: 10_000 }), 30_000, 'bounded reopen wait');
      s5.reopened = true;
      const compareFields = (label: string, original: unknown, copy: unknown, fields: readonly string[]) => {
        if (!isRecord(original) || !isRecord(copy)) { addProblem(s5, `${label} missing on one side`); return; }
        for (const field of fields) {
          const a = Object.prototype.hasOwnProperty.call(original, field), b = Object.prototype.hasOwnProperty.call(copy, field);
          if (a !== b) addProblem(s5, `${label}.${field} presence differs`);
          else if (a && !isDeepStrictEqual(original[field], copy[field])) addProblem(s5, `${label}.${field} changed after reopen`);
        }
      };
      if (originalFragment !== null) {
        const copy = reopened.history.getFragment(originalFragment.id);
        s5.reopenedFragment = copy;
        // 同形状的 typed PathFragment 逐字段比较：几何、元数据、时间、会话与来源都必须保持原样。
        if (copy === null || !isDeepStrictEqual(originalFragment, copy)) addProblem(s5, 'typed original fragment changed after reopen');
      }
      if (selectedTraversal !== null) {
        const copy = reopened.history.getTraversal(String(selectedTraversal.id));
        s5.reopenedTraversal = copy;
        compareFields('traversal', selectedTraversal, copy, ['id', 'fragmentId', 'from', 'to', 'worldId', 'dim', 'sessionId', 'observedAt', 'source', 'executionId', 'actionId', 'mode']);
      }
      if (voxelFact !== null) {
        const pos = voxelFact.pos as Vec3Like, factDim = voxelFact.dim as string;
        const cell = reopened.voxel.cellAt(factDim, pos.x, pos.y, pos.z);
        const ev = isRecord(cell) && cell.observed === true && isRecord(cell.evidence) ? cell.evidence : null;
        s5.reopenedVoxel = cell;
        if (ev === null) addProblem(s5, 'captured voxel fact disappeared after reopen');
        else {
          if (ev.freshness !== 'STALE') addProblem(s5, 'reopened voxel freshness is not STALE');
          compareFields('voxel.observation', voxelFact.observation, ev.observation, Object.keys(isRecord(voxelFact.observation) ? voxelFact.observation : {}));
        }
      }
    } else s5.reopenSkipped = closeConfirmed ? 'missing mandatory original evidence; reopen is not allowed for a PASS' : 'first close not confirmed; reopen is not allowed';
  } catch (e) {
    addProblem(s5, errorText(e));
  } finally {
    if (reopened !== null) {
      try {
        const second = await withTimeout(reopened.close(), 15_000, 'bounded second close wait');
        s5.secondClose = second;
        if (!second.completed || second.error !== null || second.unconfirmedRequest || second.dirty) { addProblem(s5, 'second close was not cleanly completed'); cleanupErrors.push({ step: 'second-close', error: new Error('second close was not cleanly completed') }); }
      } catch (e) { s5.secondCloseError = shutdownMod.errorFacts(e); addProblem(s5, `second close failed: ${errorText(e)}`); cleanupErrors.push({ step: 'second-close', error: e }); }
    }
    finish(s5);
  }

  // 早先失败不能跳过服务关停/其他清理；原始主失败保留。shutdown 幂等，失败后仍再次有界尝试真实 close。
  if (spatial !== null && shutdownResult === null) {
    try {
      const cleanupResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded cleanup shutdown wait');
      shutdownResult = cleanupResult;
      const diagnostics = shutdownMod.spatialShutdownDiagnostics(cleanupResult, spatial.worldId);
      s5.cleanupShutdown = diagnostics;
      if (!diagnostics.ok) cleanupErrors.push({ step: 'shutdown', error: new Error(diagnostics.problems.join(',')) });
    } catch (e) { cleanupErrors.push({ step: 'shutdown', error: e }); }
  }
  // 收集完关停结果后清除所有遗留 waiter 计时器；已到达的终态仍留在 evidence.tasks。
  for (const [id, waiter] of waiters) { clearTimeout(waiter.timer); waiters.delete(id); }
  if (arbiter !== null && doneListener !== null) arbiter.off('done', doneListener);
  if (arbiter !== null) arbiter.dispose();
  // 只还原自己装上的执行器包装。
  const executorProto = library.WalkRouteExecutor.prototype as unknown as {
    start(this: WalkRouteExecutor, request: WalkRouteRequest): WalkRouteStatus;
    onSample(this: WalkRouteExecutor, sample: BodySample): WalkRouteStatus;
  };
  if (executorOriginalStart !== null && executorWrappedStart !== null && executorProto.start === executorWrappedStart) executorProto.start = executorOriginalStart;
  if (executorOriginalOnSample !== null && executorWrappedOnSample !== null && executorProto.onSample === executorWrappedOnSample) executorProto.onSample = executorOriginalOnSample;
  const moverProto = WalkMoveExecutor.prototype as unknown as {
    move(this: unknown, request: ExecutableMove): Promise<ExecutableMoveResult>;
  };
  if (moverOriginalMove !== null && moverWrappedMove !== null && moverProto.move === moverWrappedMove) moverProto.move = moverOriginalMove;
  if (rcon !== null) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', error: e }); } }
  if (memory !== null) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', error: e }); } }
  // connect() 一旦发起就必须 quit（sets stopped=true 并禁用重连），即使 spawn 失败或没拿到 bot 引用。
  if (connectAttempted) {
    try {
      adapter.quit();
      const ended = await waitFor(() => botEnded && adapterDisconnected, 5000);
      const classification = classifyAdapterEnd(botEnded, adapterDisconnected, !ended);
      // 只报告实际观察：spawnObserved 单独记录，不因连接尝试或结束事件声称曾经 spawn。
      evidence.adapterEnd = {
        ...classification, connectAttempted, spawnObserved, botOwned: ownedBot !== null,
        botEnded, adapterDisconnected,
      };
      if (!classification.ok) cleanupErrors.push({ step: 'adapter-end', error: new Error(classification.problems.join(', ')) });
    } catch (e) { cleanupErrors.push({ step: 'adapter-quit', error: e }); }
  } else evidence.adapterEnd = { status: 'not-owned: no Bot client was connected by this harness', connectAttempted, spawnObserved };
  if (disconnectListener !== null) adapter.off('disconnected', disconnectListener);
  // 只从实际捕获的自有 Bot 引用上移除自己的 end 监听器（适配器重连后 this.bot 可能已换）。
  if (botEndListener !== null) (ownedBot as OwnedBot | null)?.removeListener('end', botEndListener);

  evidence.rcon = { records: rconRecords };
  evidence.finishedAt = Date.now();
  const failures = Object.values(scenarios).flatMap((s) => isRecord(s) && Array.isArray(s.problems) ? s.problems.map((p) => ({ scenario: s.name, problem: p })) : []);
  evidence.failures = failures;
  evidence.cleanupErrors = cleanupErrors.map((item) => ({ step: item.step, error: shutdownMod.errorFacts(item.error) }));
  evidence.ok = acceptanceExitCode(fatal, failures, cleanupErrors) === 0;
  writeEvidence();
  process.exitCode = acceptanceExitCode(fatal, failures, cleanupErrors);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(`navigation-acceptance: ${errorText(e)}`); process.exitCode = 1; });
}
