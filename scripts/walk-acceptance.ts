/**
 * walk_route 真实 Minecraft M2 验收入口：连接 test 服务器，用真实
 * MineflayerAdapter + Arbiter + Vision 从 Arbiter 入口发起 walk_route，
 * 对 W1/W2/W4/W5/W6/W7 逐场景判定 PASS / FAIL / NOT_RUN，保存结构化 JSON 证据。
 *
 *   默认运行：node --import tsx scripts/walk-acceptance.ts --curio=test
 *   选择场景：node --import tsx scripts/walk-acceptance.ts --curio=test --scenarios=W1,W6
 *   帮助：    node --import tsx scripts/walk-acceptance.ts --curio=test --help
 *
 * 只走/只读；W2 平台夹具通过 RCON 在限定竞技场内搭建并全程记录命令与响应。
 * 任一场景失败不中断其余场景；失败只写入该场景的 FAIL 与部分证据，不伪造未运行场景为通过。
 * 任一场景的自有清理失败即令该场景 FAIL 并中止后续场景（不把污染状态喂给下一场景）。
 * 证据标记为 provisional：不自动宣告 M2 完成，待协调者最终 C 证据确认后裁定。
 *
 * 控制归属证据全部来自真实运行时：WalkMoveExecutor.move / WalkRouteExecutor.onSample /
 * adapter.stopAll 都是公开身体桥，只做「委托原实现 + 创建时绑定归属」的诊断包装，
 * 不改请求、不访问私有字段，并在所有任务结果落定后恢复原实现。不伪造 id / 状态。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEventListeners } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bot, ControlState } from 'mineflayer';
import { VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  CellView,
  ChangeReport,
  ExecutableMove,
  NavResult,
  Observation,
  ObservationBatch,
  RouteStatus,
  WalkRouteStatus,
} from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskInfo, type TaskOutcome, type TaskSource } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { Rcon } from '../src/observer/rcon.ts';
import type { SkillResult } from '../src/skills/types.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import { WalkMoveExecutor, type WalkBody, type WalkTick } from '../src/adapter/walk-route.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import {
  classifySpatialShutdown,
  errorFacts,
  spatialShutdownDiagnostics,
  type ErrorFacts,
  type SpatialShutdownDiagnostics,
} from '../src/spatial/host-shutdown.ts';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

type ScenarioId = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7';
type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';

const SUPPORTED_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W4', 'W5', 'W6', 'W7'];
const ALL_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];
/** 本轮未实现、不得被选中执行；仍会在证据里以 NOT_RUN 诚实列出。 */
const UNSUPPORTED: ScenarioId[] = ['W3'];

const KEYS: ControlState[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

type KeyState = Record<ControlState, boolean>;
type Keys = KeyState;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 场景内唯一的单调事件序号：同毫秒事件仍可严格排序，不依赖 Date.now 分窗。 */
export class EventSeq {
  private n = 0;
  next(): number { return ++this.n; }
}

export interface FrameRecord {
  seq: number;
  ts: number;
  dtMs: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  inWater: boolean;
  keys: Keys;
  ownerTaskId: string | null;
  worldAgeTicks: number | null;
}

/**
 * 身体桥发出的控制「请求」（walkBody 包装层，调用前记录）。它只证明请求，
 * 不证明原始 Bot 方法真的采纳（内部 guard 可能仍是 no-op）。
 */
export interface ControlAttempt {
  seq: number;
  ts: number;
  op: 'set' | 'clear' | 'look';
  name?: string;
  value?: boolean;
  ownerTaskId: string | null;
}

/**
 * 原始 Bot 的 setControlState / clearControlStates 实际入口记录。
 * before/after 都是真实 7 键状态；即使按键原本就是目标值也保留这次真实调用。
 */
export interface ActualControlEntry {
  seq: number;
  ts: number;
  op: 'set' | 'clear';
  name?: string;
  value?: boolean;
  ownerTaskId: string | null;
  keysBefore: Keys;
  keysAfter: Keys;
}

/**
 * adapter.stopAll 的真实前后全键与事件序号；kind 区分生产/测试夹具回退。
 * `recentBodyOwnerTaskId` 只证明最近一次 walkBody 创建时的归属，不证明本次 stopAll
 * 的调用者，不能再当作「stopAll 属于该任务」的归属证据。
 */
export interface StopAllRecord {
  seqBefore: number;
  seqAfter: number;
  ts: number;
  label: string;
  kind: 'production' | 'harness';
  keysBefore: Keys;
  keysAfter: Keys;
  recentBodyOwnerTaskId: string | null;
}

/** walkTick 每次等待与交付的事件序号，owner 绑定在 walkTick 创建时。 */
export interface TickEntry {
  seqStart: number;
  seqEnd: number;
  tsStart: number;
  tsEnd: number;
  /** 稳定诊断 ID；不含 Function 本体，可安全写入证据 JSON。 */
  diagId: string;
  ownerTaskId: string | null;
  delivered: boolean;
  pos?: Vec3;
  /** true 表示该等待尚未被 physicsTick/abort/end/期限解除；完成时原地改回 false。 */
  pending: boolean;
  signalAbortedAtEnd: boolean;
  /** 全局监听器总数，仅作诊断；归属判定使用下面的 owned 计数。 */
  signalAbortListenersAtStart: number;
  signalAbortListenersWhilePending: number;
  signalAbortListenersAtEnd: number;
  botPhysicsTickListenersAtStart: number;
  botPhysicsTickListenersWhilePending: number;
  botPhysicsTickListenersAtEnd: number;
  botEndListenersAtStart: number;
  botEndListenersWhilePending: number;
  botEndListenersAtEnd: number;
  /** 本 tick 在同步返回 Promise 后新增的真实函数数量（来自 getEventListeners 差集）。 */
  ownedAbortAdded: number;
  ownedPhysicsTickAdded: number;
  ownedEndAdded: number;
  /** 等待结束时，上述本 tick 自己的函数仍留在监听器集合中的数量。 */
  ownedAbortResidual: number;
  ownedPhysicsTickResidual: number;
  ownedEndResidual: number;
}

type ListenerSet = Set<Function>;

interface OwnedTickListeners {
  abort: ListenerSet;
  physicsTick: ListenerSet;
  end: ListenerSet;
}

/** WalkMoveExecutor.move 的实际段请求（公开桥包装，记录创建时绑定的任务与段身份）。 */
export interface MoveRecord {
  seq: number;
  ts: number;
  taskId: string | null;
  delegationId: string | null;
  executionId: string; // 段 executionId（walk-<gen>-step-<i>），与 taskId / delegationId 区分
  from: Vec3;
  to: Vec3;
  deadlineMs: number;
  timeoutMs: number;
  signalAborted: boolean;
}

export interface RouteStateSnapshot {
  stepCount: number;
  complete: boolean;
  verdict: string;
  openPrefix: number;
  verifiedStepIndexes: number[];
  pendingStepIndexes: number[];
  invalidatedCount: number;
  earliestProblem: { stepIndex: number; status: string; problemKind: string | null } | null;
  steps: Array<{ kind: 'verified'; status: string; problemKind: string | null } | { kind: 'pending'; reason: string }>;
}

export interface RouteStatusSnapshot {
  /** 真实 public status 的委托作用域；用于拒绝「同位置但 scope 已错」的样本。 */
  worldId: string;
  dim: string;
  sessionId: string;
  delegationId: string;
  nextPointIndex: number;
  activeStepIndex: number | null;
  lastPosition: Vec3 | null;
  result: NavResult | null;
  /** 真实 public status().route 的最小只读快照，用于证明未来段验证是否受报告影响。 */
  route: RouteStateSnapshot | null;
}

/** 公开 WalkRouteExecutor 调用（start/advance 状态变化/onSample）及其前后状态。 */
export interface RouteCallRecord {
  seq: number;
  ts: number;
  op: 'start' | 'advance' | 'onSample';
  ownerTaskId: string | null;
  delegationId: string | null;
  statusBefore: RouteStatusSnapshot | null;
  statusAfter: RouteStatusSnapshot;
}

/**
 * onSample 被调用只代表样本「已交付」。这里保存完整原始 BodySample（真实 scope/
 * lifecycle/id/time/sequence）与公开状态前后；是否被接受必须由 scope、lastPosition、
 * nextPointIndex 推进和最终 NavResult.trace/lastObservation 另行证明。
 *
 * `ownerTaskId` 是目标 loop 实例的静态绑定；`sourceOwnerTaskId` 是样本实际通过
 * 公开 setFrameSink 回调送达时的来源 loop 绑定（直接调用时为 null）。两者必须分开，
 * 否则旧 A 来源把 payload 改写成 B 后无法辨识。
 */
export interface DeliveredSampleRecord {
  seq: number;
  ts: number;
  /** 交付时的实际 physics frame（现 capture.frame，不用时间推断）。 */
  frame: number;
  ownerTaskId: string | null;
  delegationId: string;
  /** 实际交付通道：经公开 setFrameSink 回调（活动段）或直接调用（初始化）。 */
  source: 'frameSink' | 'direct';
  sourceOwnerTaskId: string | null;
  sample: BodySample;
  statusBefore: RouteStatusSnapshot;
  statusAfter: RouteStatusSnapshot;
}

/** 被公开状态证明确认到达的一段实测完成点。 */
export interface MeasuredCompletion {
  stepIndex: number;
  sampleSequence: number;
  observedAt: number;
  pos: Vec3;
  sample: DeliveredSampleRecord;
}

/** 身体桥/执行器创建时的静态归属，供旧回调正确归属。 */
export interface BindingRecord {
  seq: number;
  ts: number;
  ownerTaskId: string | null;
  kind: 'body' | 'tick' | 'frameSink' | 'route';
}

export interface TimelineMark {
  seq: number;
  ts: number;
  label: string;
  taskId: string | null;
}

interface ControlSnapshot {
  ts: number;
  label: string;
  keys: Keys;
  ownerTaskId: string | null;
}

interface ServerCorrection {
  ts: number;
  kind: 'forcedMove' | 'position' | 'position_look';
  x?: number; y?: number; z?: number;
}

/** 任务启动时捕获的完整请求与真实作用域（不做「成功后补路线」的伪造）。 */
export interface TaskStartRecord {
  task: TaskInfo;
  request: { points: Vec3Like[]; deadlineMs: number };
  scope: { worldId: string; dim: string; sessionId: string; alive: boolean; connected: boolean; observationReady: boolean };
  registeredAt: number;
}

/** 任务终态完整记录：完整 TaskInfo + 完整 SkillResult + duration。 */
export interface TaskDoneRecord {
  task: TaskInfo;
  result: SkillResult;
  durationMs: number;
  preemptedBy?: TaskSource;
  gentle?: boolean;
  doneAt: number;
}

interface ScenarioEvidence {
  verdict: Verdict;
  note?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  taskStarts: TaskStartRecord[];
  results: TaskDoneRecord[];
  frames: FrameRecord[];
  framesTruncated: boolean;
  controlAttempts: ControlAttempt[];
  actualControls: ActualControlEntry[];
  controlSnapshots: ControlSnapshot[];
  stopAlls: StopAllRecord[];
  ticks: TickEntry[];
  routeCalls: RouteCallRecord[];
  deliveredSamples: DeliveredSampleRecord[];
  visionCalls: VisionCallRecord[];
  mapBatches: StoredMapBatchRecord[];
  observes: ObserveCallRecord[];
  moves: MoveRecord[];
  bindings: BindingRecord[];
  marks: TimelineMark[];
  serverCorrections: ServerCorrection[];
  trajectory?: Record<string, unknown>;
  error?: string;
  cleanupError?: string;
  extra?: Record<string, unknown>;
}

/**
 * 竞技场与步行道候选：控制面预检后确认；不可与流体道 x76..90,z76..86 重叠。
 * y 为脚高（feetY），非方块坐标；实际坐标在授权运行的控制面预检中最终确定。
 */
const ARENA = {
  candidate: 'x200..220, z200..220',
  fluidLaneAvoid: 'x76..90, z76..86',
};

/**
 * W2 平台：真正 2×1 的整数方块支撑面（x205..206, z205），
 * 世界连续支撑面为 x[205,207)、z[205,206)（inclusive bounds → max+1）。
 */
const W2_PLATFORM = {
  // 整数方块 inclusive bounds：2 格长 × 1 格宽。
  xMin: 205, xMax: 206, zMin: 205, zMax: 205,
  // 台面顶的脚高（feetY，方块在 feetY-1）。
  feetY: 64,
  material: 'minecraft:stone',
  // 分数起点与目标：目标 x=206.55 紧邻真实外边缘 x=207（身体半宽 0.3 仍在支撑面上）。
  start: { x: 205.55, y: 64, z: 205.52 },
  target: { x: 206.55, y: 64, z: 205.52 },
};

/**
 * W4：3×1 支撑（x210..212, z205），显式 3 点 / 2 段 +X 路线。
 * 首段 active 时只拆 x211 目标支撑；x212 保留为尚未启动的第二段，
 * 使「不启动后续段」具备区分力，也不加替代侧路。
 */
const W4_FIXTURE = {
  xMin: 210, xMax: 212, zMin: 205, zMax: 205,
  feetY: 64,
  material: 'minecraft:stone',
  start: { x: 210.55, y: 64, z: 205.52 },
  targetSupport: { x: 211, y: 63, z: 205 },
  route: [
    { x: 210.55, y: 64, z: 205.52 },
    { x: 211.55, y: 64, z: 205.52 },
    { x: 212.55, y: 64, z: 205.52 },
  ],
};

/**
 * W5：3×1 支撑（x215..217, z205）上的显式往返。
 * 去程到 floor(x)=217 且前向段仍 active 时拆身后的 x215（fx±1 候选外、
 * 实际 yaw 也在 FOV 外）；只有同一活跃委托自然折返、经自身 observeCells
 * 再次合法看见时才算完整回看。
 */
const W5_FIXTURE = {
  xMin: 215, xMax: 217, zMin: 205, zMax: 205,
  feetY: 64,
  material: 'minecraft:stone',
  start: { x: 215.55, y: 64, z: 205.52 },
  targetSupport: { x: 215, y: 63, z: 205 },
  route: [
    { x: 215.55, y: 64, z: 205.52 },
    { x: 216.55, y: 64, z: 205.52 },
    { x: 217.55, y: 64, z: 205.52 },
    { x: 216.55, y: 64, z: 205.52 },
    { x: 215.55, y: 64, z: 205.52 },
  ],
};

/**
 * W1/W6/W7 的平坦步行道：显式建造的支撑面，不假设天然地形。
 * W1 路线在 z216.5 先 +X 再 +Z 到 z217.5，因此 z 至少覆盖 216..217；
 * x 覆盖 W6 的十格直行与 W7 的直行余量，仍落在授权 x200..220, z200..220 内。
 */
const WALK_LANE = {
  // 整数方块 inclusive bounds（支撑方块在 feetY-1，净空在 feetY/feetY+1）。
  // x 上限 218（世界支撑面到 x219）为 W7a 留出单轴长路线，仍在授权 x200..220 内。
  xMin: 200, xMax: 218, zMin: 216, zMax: 217,
  feetY: 64,
  material: 'minecraft:stone',
  start: { x: 200.5, y: 64, z: 216.5 },
};

// ---------------------------------------------------------------------------
// 纯函数（供脚本与窄测试复用，无副作用）
// ---------------------------------------------------------------------------

export function parseScenarioSelector(raw: string | undefined): ScenarioId[] {
  if (!raw || raw.trim() === '') return [...SUPPORTED_SCENARIOS];
  const tokens = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (tokens.length === 0) return [...SUPPORTED_SCENARIOS];
  for (const t of tokens) {
    if (!(ALL_SCENARIOS as string[]).includes(t)) throw new Error(`未知场景 ${t}；可选：${ALL_SCENARIOS.join(',')}`);
    if (UNSUPPORTED.includes(t as ScenarioId)) {
      throw new Error(`场景 ${t} 本轮未实现（可选：${SUPPORTED_SCENARIOS.join(',')}）；不会以全 NOT_RUN 判为通过`);
    }
  }
  return tokens as ScenarioId[];
}

/** 解析 RCON `list` 的在线玩家名；格式/数量不符时抛错（fail closed），不当空列表。 */
export function parseRconList(raw: string): string[] {
  const m = /^There are (\d+) of a max of (\d+) players online:(.*)$/.exec(raw.trim());
  if (!m) throw new Error(`RCON list 响应格式无法解析：${JSON.stringify(raw)}`);
  const declared = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(max) || max < declared) throw new Error(`RCON list 数量非法：declared=${declared} max=${m[2]}`);
  const tail = m[3].trim();
  const names = tail ? tail.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (names.length !== declared) throw new Error(`RCON list 在线数不一致：声明 ${declared} 实际 ${names.length}`);
  return names;
}

export function dist2(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function snapshotKeys(bot: { controlState: KeyState }): Keys {
  const out = {} as Keys;
  for (const k of KEYS) out[k] = !!bot.controlState[k];
  return out;
}

/** 解析 `git status --porcelain=v1 -z`：每条 `XY <path>\0`，保留前导空格、仅按 NUL 分条。 */
export function gitPorcelainPaths(raw: string): string[] {
  const tokens = raw.split('\0').filter((t) => t !== '');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // 每条记录都是 2 字符状态码 + 1 空格分隔 + 路径；前导空格（未暂存/未跟踪）原样保留。
    paths.push(t.slice(3));
    // 重命名/复制还有一条紧跟的源路径（无状态前缀），一并记录为脏路径。
    if (t[0] === 'R' || t[0] === 'C') {
      const src = tokens[i + 1];
      if (src !== undefined) { paths.push(src); i++; }
    }
  }
  return paths;
}

export function summarizeTrajectory(frames: FrameRecord[]): Record<string, unknown> {
  const xs = frames.map((f) => f.x), zs = frames.map((f) => f.z), ys = frames.map((f) => f.y);
  const dts = frames.map((f) => f.dtMs).filter((d) => d > 0);
  const min = (a: number[]) => (a.length ? Math.min(...a) : NaN);
  const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const first = frames[0], last = frames[frames.length - 1];
  return {
    frameCount: frames.length,
    minFeetY: min(ys), maxFeetY: max(ys),
    minX: min(xs), maxX: max(xs), minZ: min(zs), maxZ: max(zs),
    airborneFrames: frames.filter((f) => !f.onGround).length,
    allGrounded: frames.length > 0 && frames.every((f) => f.onGround),
    dtMs: { min: min(dts), max: max(dts), avg: avg(dts) },
    horizontalSpan: first && last ? Number(dist2(first, last).toFixed(3)) : null,
  };
}

/** 沿 X 单轴的相邻分数步点列（start → target 逐格）。 */
/** 方块名按无命名空间比较；只做比较，不据此补全状态。 */
export function bareBlockName(name: string): string {
  return name.replace(/^minecraft:/, '');
}

export function isAirBlockName(name: string): boolean {
  return ['air', 'cave_air', 'void_air'].includes(bareBlockName(name));
}

/** 只读快照：cellAt 返回单格证据；不刷新时间/版本。 */
export interface CellEvidenceSnapshot {
  observed: boolean;
  name?: string;
  properties?: Record<string, string>;
  observedAt?: number;
  sequence?: number;
  originObservationId?: number;
  sessionId?: string;
  revision?: number;
  freshness?: string;
  validUntil?: number;
}

export function cellEvidenceSnapshot(view: CellView): CellEvidenceSnapshot {
  if (!view.observed) return { observed: false };
  const e = view.evidence;
  return {
    observed: true,
    name: e.observation.state.name,
    properties: { ...e.observation.state.properties },
    observedAt: e.observation.observedAt,
    sequence: e.observation.sequence,
    originObservationId: e.observation.originObservationId,
    sessionId: e.observation.sessionId,
    revision: e.revision,
    freshness: e.freshness,
    validUntil: e.validUntil,
  };
}

/** 隐藏期只允许 TTL/年龄自然增长；原始 state/properties/time/sequence/revision/validUntil 全不得变化。 */
export function sameCellEvidence(a: CellEvidenceSnapshot | null, b: CellEvidenceSnapshot | null): boolean {
  if (!a || !b || !a.observed || !b.observed) return false;
  return a.name === b.name
    && JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {})
    && a.observedAt === b.observedAt
    && a.sequence === b.sequence
    && a.originObservationId === b.originObservationId
    && a.sessionId === b.sessionId
    && a.revision === b.revision
    && a.freshness === b.freshness
    && a.validUntil === b.validUntil;
}

export interface W4ChainInput {
  taskId: string;
  issueSeq: number;
  /** 拆支撑前经实际 Vision→map 的 stone 证据（同一实际 map）。 */
  initialStone: { visionSeq: number; mapSeq: number; mapId: number; name: string } | null;
  airVision: { seq: number; name: string; frame: number } | null;
  airBatch: { seq: number; reportId: number; mapId: number; targetChanged: boolean; frame: number } | null;
  observe: {
    enterSeq: number;
    exitSeq: number;
    frameEnter: number;
    frameExit: number;
    reportId: number | null;
    statusBeforeActiveStepIndex: number | null;
    statusBeforeOutcome: string | null;
    statusAfterOutcome: string | null;
    statusAfterActiveStepIndex: number | null;
    statusAfterProblem: string | null;
  } | null;
  release: { seq: number; ownerTaskId: string | null } | null;
  nextSample: { seq: number; frame: number } | null;
  laterMoveCount: number;
  terminalOutcome: string | null;
}

/**
 * W4 正向链路：合法初观测 → 实际 Vision air → 同一 ChangeReport 对象 → loop.observe
 * 在活动段内同步释放控制（早于该帧 onSample），且之后不启动新段、不 ARRIVED。
 */
export function checkW4ObservationChain(x: W4ChainInput): { ok: boolean; reason?: string } {
  if (!x.initialStone) return { ok: false, reason: '缺少拆支撑前的合法 stone 初观测' };
  if (bareBlockName(x.initialStone.name) !== 'stone') {
    return { ok: false, reason: `初观测不是 stone：${x.initialStone.name}` };
  }
  if (x.initialStone.mapId !== x.airBatch?.mapId) return { ok: false, reason: '初观测与air报告不是同一个实际map' };
  if (x.initialStone.visionSeq >= x.issueSeq || x.initialStone.mapSeq >= x.issueSeq) return { ok: false, reason: '初观测晚于拆支撑' };
  if (!x.airVision) return { ok: false, reason: '实际Vision未输出目标格air' };
  if (!isAirBlockName(x.airVision.name)) return { ok: false, reason: `Vision输出不是air：${x.airVision.name}` };
  if (x.airVision.seq <= x.issueSeq) return { ok: false, reason: 'air观测不晚于拆支撑' };
  if (!x.airBatch) return { ok: false, reason: 'air观测未形成ChangeReport' };
  if (!x.airBatch.targetChanged) return { ok: false, reason: 'ChangeReport未包含目标格变化' };
  if (x.airBatch.seq <= x.airVision.seq) return { ok: false, reason: 'map报告早于Vision输出' };
  if (!x.observe) return { ok: false, reason: '缺少loop.observe调用' };
  if (x.observe.reportId === null || x.observe.reportId !== x.airBatch.reportId) return { ok: false, reason: 'loop.observe收到不是同一个ChangeReport对象' };
  if (x.observe.statusBeforeActiveStepIndex === null || x.observe.statusBeforeOutcome !== null) {
    return { ok: false, reason: '观察时所属段已不在途（非活动段或已终态）' };
  }
  if (x.observe.statusAfterOutcome !== 'FAILED' || x.observe.statusAfterProblem !== 'route_invalidated') {
    return { ok: false, reason: `库终态非 FAILED/route_invalidated：${x.observe.statusAfterOutcome}/${x.observe.statusAfterProblem}` };
  }
  if (x.observe.statusAfterActiveStepIndex !== null) return { ok: false, reason: '撤销后 activeStepIndex 未清空' };
  if (x.airBatch.frame !== x.airVision.frame) return { ok: false, reason: 'map报告与Vision不在同一physics frame' };
  if (x.observe.frameEnter !== x.airVision.frame || x.observe.frameExit !== x.airVision.frame) {
    return { ok: false, reason: 'loop.observe 不在该Vision的同一physics frame' };
  }
  if (x.release === null) return { ok: false, reason: 'observe 内未捕获所属段实际控制释放' };
  if (x.release.ownerTaskId !== x.taskId) return { ok: false, reason: '控制释放不属于本task身体' };
  if (!(x.observe.enterSeq < x.release.seq && x.release.seq < x.observe.exitSeq)) return { ok: false, reason: '控制释放不在 observe enter/exit 之内' };
  if (x.nextSample === null) return { ok: false, reason: '缺少后续真实 onSample' };
  if (x.nextSample.seq <= x.observe.exitSeq || x.nextSample.seq <= x.release.seq) {
    return { ok: false, reason: '该帧 onSample 不晚于 observe exit/控制释放' };
  }
  if (x.nextSample.frame !== x.airVision.frame) return { ok: false, reason: 'onSample 来自 later frame，不是同一physics frame' };
  if (x.laterMoveCount > 0) return { ok: false, reason: `撤销后仍启动 ${x.laterMoveCount} 个后续段` };
  if (x.terminalOutcome === 'ARRIVED') return { ok: false, reason: '已拆支撑仍误报 ARRIVED' };
  return { ok: true };
}

export interface W5HiddenView {
  seq: number;
  frame: number;
  eye: EyeSnapshot | null;
  targetInPositions: boolean;
  targetInFov: boolean;
  targetOutput: string | null;
}

export interface W5HiddenBatch {
  seq: number;
  frame: number;
  targetObservation: boolean;
  targetChanged: boolean;
}

/** 带真实采集时刻/序号/帧的 cellAt 只读快照；年龄只用各自 captureAt。 */
export interface W5CellCapture extends CellEvidenceSnapshot {
  captureAt: number;
  captureSeq: number;
  captureFrame: number;
  body: Vec3;
  eye: EyeSnapshot | null;
}

export interface W5RouteProof {
  /** 同一次 revealObserve 调用进入前的真实 status().route（不是拆支撑前的旧快照）。 */
  before: RouteStateSnapshot | null;
  /** 同一次 revealObserve 调用返回后的真实 status().route。 */
  after: RouteStateSnapshot | null;
  totalSteps: number;
  step3Started: boolean;
  moveExecutionIds: string[];
  moveCount: number;
  startedStepIndexes: number[];
}

export interface W5Terminal {
  navPresent: boolean;
  outcome: string | null;
  confirmed: boolean | null;
  problemKind: string | null;
  lastPosition: Vec3 | null;
  allKeysReleased: boolean;
}

export interface W5ChainInput {
  taskId: string;
  delegationId: string;
  stoneMapId: number | null;
  removalSeq: number;
  hidden: {
    startSeq: number;
    startAt: number;
    /** 真实 parseSetBlock 成功后的 response 事件序号（已执行上界）。 */
    responseSeq: number | null;
    /** 收到成功 response 时的 physics frame 计数。 */
    responseFrame: number | null;
    endSeq: number;
    endAt: number | null;
    views: W5HiddenView[];
    batches: W5HiddenBatch[];
  } | null;
  cellBefore: W5CellCapture | null;
  cellDuring: W5CellCapture | null;
  returnMove: { seq: number; executionId: string; from: Vec3; to: Vec3 } | null;
  reveal: {
    seq: number;
    frame: number;
    name: string;
    mapId: number;
    observedAt: number;
    eye: EyeSnapshot | null;
    targetInFov: boolean;
    precedingTargetOutputs: string[];
  } | null;
  revealBatch: { seq: number; mapId: number; reportId: number; targetChanged: boolean } | null;
  revealObserve: {
    reportId: number | null;
    ownerTaskId: string | null;
    delegationId: string;
    enterSeq: number;
    statusBeforeOutcome: string | null;
    statusBeforeActiveStepIndex: number | null;
    statusAfterOutcome: string | null;
    statusAfterActiveStepIndex: number | null;
  } | null;
  routeProof: W5RouteProof | null;
  terminal: W5Terminal | null;
}

/**
 * W5 需要「隐藏半段 + 同一实际委托返程回看 + 真实终态/未来段失效」全部成立：
 * 隐藏窗口由真实去程几何/候选排除/返程 move 边界限定，期间任何目标输出、
 * map 目标输入或报告变化都失败；回看必须是返程 step2 后的合法 Vision 并作为
 * 同一 ChangeReport 对象进入活跃 loop.observe；终态保留真实 Nav/problem/lastPosition，
 * 且真实 air 报告使未启动的未来 step3 从 OPEN 变为非 OPEN。
 */
export function checkW5HiddenReveal(x: W5ChainInput): { ok: boolean; reason?: string } {
  if (x.stoneMapId === null) return { ok: false, reason: '缺少拆支撑前合法 stone 初观测的实际map' };
  const hidden = x.hidden;
  if (!hidden) return { ok: false, reason: '缺少隐藏期观察边界' };
  if (!x.cellBefore?.observed || !x.cellDuring?.observed) return { ok: false, reason: '隐藏期缺少可读的 cellAt 证据' };
  if (x.cellBefore.captureSeq < hidden.startSeq || x.cellBefore.captureAt < hidden.startAt) {
    return { ok: false, reason: '隐藏 baseline 早于隐藏起点' };
  }
  if (x.cellBefore.captureSeq >= x.removalSeq) {
    return { ok: false, reason: '隐藏 baseline 不是在拆支撑前采集' };
  }
  if (x.cellDuring.captureSeq <= x.cellBefore.captureSeq || x.cellDuring.captureAt <= x.cellBefore.captureAt) {
    return { ok: false, reason: '隐藏期 cellAt capture 时刻未推进' };
  }
  if (hidden.responseSeq === null || hidden.responseFrame === null || !Number.isInteger(hidden.responseFrame) || hidden.responseFrame < 0) {
    return { ok: false, reason: '缺少拆支撑成功 response 边界' };
  }
  if (hidden.responseSeq <= x.removalSeq) return { ok: false, reason: '成功 response 早于拆支撑发出' };
  if (hidden.responseSeq <= hidden.startSeq || hidden.responseSeq >= hidden.endSeq) {
    return { ok: false, reason: '成功 response 不在真实隐藏窗口内' };
  }
  if (x.cellDuring.captureSeq <= hidden.responseSeq) {
    return { ok: false, reason: 'cellDuring 未在成功 response 后采集' };
  }
  // 只有「已确认变化之后、cellDuring 之前」的帧能证明变化已执行后仍隐藏；
  // 后续帧不能补采为采集前证据。
  const postResponseBeforeDuring = hidden.views.filter((v) => v.seq > hidden.responseSeq! && v.seq < x.cellDuring!.captureSeq);
  if (new Set(postResponseBeforeDuring.map((v) => v.frame)).size < 2) {
    return { ok: false, reason: '成功 response 后至 cellDuring 前不足两个不同 physics frame' };
  }
  if (x.cellDuring.captureSeq >= hidden.endSeq) {
    return { ok: false, reason: '隐藏期 cellDuring 不在真实隐藏窗口内' };
  }
  if (!sameCellEvidence(x.cellBefore, x.cellDuring)) return { ok: false, reason: '隐藏期 cellAt 原证据被人工刷新' };
  if (x.cellBefore.observedAt === undefined || x.cellDuring.observedAt === undefined) {
    return { ok: false, reason: '隐藏期 cellAt 缺少原始 observedAt' };
  }
  if (x.cellBefore.captureAt < x.cellBefore.observedAt || x.cellDuring.captureAt < x.cellDuring.observedAt) {
    return { ok: false, reason: '隐藏期 capture 早于原始 observedAt' };
  }
  const beforeAge = x.cellBefore.captureAt - x.cellBefore.observedAt;
  const duringAge = x.cellDuring.captureAt - x.cellDuring.observedAt;
  if (duringAge <= beforeAge) return { ok: false, reason: '隐藏期 cellAt 年龄未实际推进' };

  if (hidden.views.length < 2) return { ok: false, reason: '隐藏期真实观察边界不足' };
  if (new Set(hidden.views.map((v) => v.frame)).size < 2) {
    return { ok: false, reason: '隐藏期不足两个不同 physics frame' };
  }
  if (hidden.batches.length < 1) return { ok: false, reason: '隐藏期缺少真实 map 观察边界' };
  for (const view of hidden.views) {
    if (view.seq <= hidden.startSeq || view.seq >= hidden.endSeq) return { ok: false, reason: '隐藏期 Vision 不在真实隐藏窗口内' };
    if (view.targetOutput !== null) return { ok: false, reason: `隐藏期 Vision 已输出目标格 ${view.targetOutput}` };
    if (view.targetInPositions) return { ok: false, reason: '隐藏期 Vision 候选仍包含目标格' };
    if (!view.eye || view.targetInFov) return { ok: false, reason: '隐藏期真实朝向未排除目标 FOV' };
  }
  for (const batch of hidden.batches) {
    if (batch.seq <= hidden.startSeq || batch.seq >= hidden.endSeq) return { ok: false, reason: '隐藏期 map 批次不在真实隐藏窗口内' };
    if (batch.targetObservation) return { ok: false, reason: '隐藏期 map 输入刷新了目标格' };
    if (batch.targetChanged) return { ok: false, reason: '隐藏期 ChangeReport 已含目标格变化' };
  }

  if (!x.returnMove) return { ok: false, reason: '缺少真实返程 step2 move' };
  if (!x.returnMove.executionId.endsWith('-step-2')) return { ok: false, reason: `返程 move 不是 step2：${x.returnMove.executionId}` };
  if (!(x.returnMove.from.x > x.returnMove.to.x)) return { ok: false, reason: '返程 move 不是 -X 折返' };
  if (x.returnMove.seq !== hidden.endSeq) return { ok: false, reason: '隐藏窗口未以真实返程 move 结束' };

  if (!x.reveal) return { ok: false, reason: '只有隐藏半段，缺少同一活跃委托的生产回看' };
  if (x.reveal.seq <= x.returnMove.seq) return { ok: false, reason: '回看不是返程 move 之后的实际 Vision' };
  if (x.reveal.precedingTargetOutputs.length > 0) {
    return { ok: false, reason: `返程后出现未被采用的目标输出：${x.reveal.precedingTargetOutputs.join(',')}` };
  }
  if (!isAirBlockName(x.reveal.name)) return { ok: false, reason: `回看输出不是air：${x.reveal.name}` };
  if (!x.reveal.eye || !x.reveal.targetInFov) return { ok: false, reason: '回看真实朝向未包含目标 FOV' };
  if (x.reveal.observedAt <= (x.cellBefore.observedAt ?? 0)) return { ok: false, reason: '回看 observedAt 未刷新' };
  if (x.reveal.mapId !== x.stoneMapId) return { ok: false, reason: '回看不是同一个实际map' };
  if (!x.revealBatch) return { ok: false, reason: '回看未形成 ChangeReport' };
  if (x.revealBatch.seq <= x.reveal.seq) return { ok: false, reason: '回看报告早于Vision' };
  if (x.revealBatch.mapId !== x.stoneMapId) return { ok: false, reason: '回看报告来自别的map' };
  if (!x.revealBatch.targetChanged) return { ok: false, reason: '回看ChangeReport未包含目标格变化' };
  if (!x.revealObserve || x.revealObserve.reportId === null || x.revealObserve.reportId !== x.revealBatch.reportId) {
    return { ok: false, reason: '回看报告未作为同一对象进入活跃loop.observe' };
  }
  if (x.revealObserve.ownerTaskId !== x.taskId || x.revealObserve.delegationId !== x.delegationId) {
    return { ok: false, reason: '回看不是同一 task/delegation' };
  }
  if (x.revealObserve.statusBeforeActiveStepIndex !== 2 || x.revealObserve.statusBeforeOutcome !== null) {
    return { ok: false, reason: '回看不在返程 step2 活动段' };
  }
  if (x.revealObserve.enterSeq <= x.revealBatch.seq) return { ok: false, reason: '回看 observe 早于真实报告' };

  const route = x.routeProof;
  if (!route) return { ok: false, reason: '缺少真实公共 route 验证状态' };
  if (route.totalSteps < 4) return { ok: false, reason: `真实路线不足 4 步：${route.totalSteps}` };
  if (route.step3Started || route.startedStepIndexes.includes(3)) return { ok: false, reason: '未来 step3 已启动' };
  if (route.moveCount !== 3 || route.moveExecutionIds.length !== 3 || new Set(route.moveExecutionIds).size !== 3) {
    return { ok: false, reason: `实际 move 数/ID 不是 0..2：${route.moveCount}` };
  }
  if (route.startedStepIndexes.join(',') !== '0,1,2') {
    return { ok: false, reason: `实际启动段不是 0..2：${route.startedStepIndexes.join(',')}` };
  }
  if (!route.before || !route.after) return { ok: false, reason: '缺少拆支撑前/后的真实 route 状态' };
  if (route.before.stepCount !== route.totalSteps || route.after.stepCount !== route.totalSteps) {
    return { ok: false, reason: 'route 状态与真实步数不一致' };
  }
  const beforeStep3 = route.before.steps[3];
  if (!beforeStep3 || beforeStep3.kind !== 'verified' || beforeStep3.status !== 'OPEN') {
    return { ok: false, reason: '拆支撑前未来 step3 不是 OPEN' };
  }
  const afterStep3 = route.after.steps[3];
  if (!afterStep3) return { ok: false, reason: '拆支撑后缺少未来 step3 状态' };
  if (afterStep3.kind !== 'verified') {
    return { ok: false, reason: '真实 air 报告后未来 step3 尚未重算为 verified' };
  }
  if (afterStep3.status === 'OPEN') {
    return { ok: false, reason: '真实 air 报告后未来 step3 仍为 OPEN' };
  }
  // invalidatedCount 只统计「当前仍 pending 且曾失效」的步数；预算内全部重算后
  // 会归零，不是累计失效事件数，因此不参与判定，原字段仍保留在 route 快照中。

  const terminal = x.terminal;
  if (!terminal || !terminal.navPresent) return { ok: false, reason: '缺少真实 Nav 终态' };
  if (terminal.outcome !== 'FAILED' && terminal.outcome !== 'BLOCKED') {
    return { ok: false, reason: `终态不是 FAILED/BLOCKED：${terminal.outcome ?? 'null'}` };
  }
  if (terminal.confirmed !== false) return { ok: false, reason: '终态 confirmed 不是 false' };
  if (terminal.problemKind === null) return { ok: false, reason: '终态未保留真实 problem' };
  if (terminal.lastPosition === null) return { ok: false, reason: '终态未保留真实 lastPosition' };
  if (!terminal.allKeysReleased) return { ok: false, reason: '终态后 7 键未全部释放' };
  return { ok: true };
}

export interface S1ReturnInput {
  taskIdA: string;
  taskIdB: string;
  aRoute: Vec3[];
  /** A 最后一段实测完成点；B 必须原样从这里出发。 */
  aLastCompletion: Vec3;
  delegationB: string;
  bRoute: Vec3[];
  bStartSeq: number;
  /** B 自己记录里的 public route 快照（owner/seq 用于拒绝复用 A 的旧 OPEN）。 */
  bRouteStatus: { ownerTaskId: string | null; seq: number; status: RouteStatusSnapshot };
  bMoves: MoveRecord[];
  bCompletions: MeasuredCompletion[];
  /** 只含 B 开始后的真实 map 批次。 */
  bMaps: MapBatchRecord[];
  expectedMap: VoxelMap;
  expectedScope: { worldId: string; dim: string; sessionId: string };
  witnessCell: Vec3;
  baselineCell: CellEvidenceSnapshot;
  beforeStartCell: CellEvidenceSnapshot;
  bVision: VisionCallRecord | null;
  afterCell: CellEvidenceSnapshot;
}

const unitStep = (d: Vec3) => Math.abs(d.x) + Math.abs(d.z) === 1 && d.y === 0;

/**
 * S1 返程证明：同一真实 map、B 独立 task（delegation 允许同名）、反向严格相邻
 * 三段、实测接续，以及 witness 格必须由 B 期真实 Vision 重新观测并写入同一
 * svc.voxel 的 sequence 链路。跨 task 同名 delegation、换 map、没有新合法观测
 * 或旧证据被刷新，都不得通过。
 */
export function checkS1Return(x: S1ReturnInput): { ok: boolean; reason?: string } {
  if (x.taskIdA === x.taskIdB) return { ok: false, reason: 'A/B 不是两个不同任务' };
  if (x.aRoute.length !== 4 || x.bRoute.length !== 4) return { ok: false, reason: 'A/B 路线不是三段四节点' };
  for (let i = 0; i < 3; i++) {
    const a = x.aRoute[i]!;
    const aNext = x.aRoute[i + 1]!;
    const b = x.bRoute[i]!;
    const bNext = x.bRoute[i + 1]!;
    const aDelta = { x: aNext.x - a.x, y: aNext.y - a.y, z: aNext.z - a.z };
    const bDelta = { x: bNext.x - b.x, y: bNext.y - b.y, z: bNext.z - b.z };
    if (!unitStep(aDelta) || !unitStep(bDelta)) return { ok: false, reason: `第 ${i} 段不是严格单格相邻` };
    const forward = x.aRoute[2 - i]!;
    const forwardNext = x.aRoute[3 - i]!;
    const expected = { x: forward.x - forwardNext.x, y: forward.y - forwardNext.y, z: forward.z - forwardNext.z };
    if (!vecEqual(bDelta, expected)) return { ok: false, reason: `B 第 ${i} 段不是 A 单位方向的逆序` };
  }
  if (!vecEqual(x.bRoute[0]!, x.aLastCompletion)) return { ok: false, reason: 'B 起点不是 A 实测末位原坐标' };

  const segments = checkTaskSegments(x.bMoves, x.delegationB, x.taskIdB, 3);
  if (!segments.ok) return { ok: false, reason: `B 段集合不合法：${segments.reason}` };
  for (let i = 0; i < 3; i++) {
    if (!vecEqual(segments.segments[i]!.to, x.bRoute[i + 1]!)) return { ok: false, reason: `B 第 ${i} 段目标偏离路线` };
  }
  if (!vecEqual(segments.segments[0]!.from, x.bRoute[0]!)) return { ok: false, reason: 'B 首段不是从实测末位出发' };
  if (x.bCompletions.length !== 3) return { ok: false, reason: `B 实测完成点 ${x.bCompletions.length} != 3` };
  if (x.bCompletions.some((c) => c.sample.ownerTaskId !== x.taskIdB || c.sample.delegationId !== x.delegationB)) {
    return { ok: false, reason: 'B 完成点不属于本 task+delegation（同名 delegation 不得跨任务复用）' };
  }
  if (!segmentsFollowMeasured(segments.segments, x.bCompletions)) {
    return { ok: false, reason: 'B 段间未从实测完成点严格接续' };
  }

  const route = x.bRouteStatus.status.route;
  if (x.bRouteStatus.ownerTaskId !== x.taskIdB) return { ok: false, reason: 'B route 快照不属于 B task（不得复用 A 的旧 OPEN）' };
  if (x.bRouteStatus.seq <= x.bStartSeq) return { ok: false, reason: 'B route 快照早于 B 起点（不得复用 A 的旧 OPEN）' };
  if (x.bRouteStatus.status.delegationId !== x.delegationB) return { ok: false, reason: 'B public status 不是本 delegation' };
  if (!route || route.stepCount !== 3 || route.steps.length !== 3) return { ok: false, reason: 'B 真实 public route 不是三步' };
  if (route.verifiedStepIndexes.join(',') !== '0,1,2') return { ok: false, reason: `B route 未验证 0..2：${route.verifiedStepIndexes.join(',')}` };
  if (route.steps.some((s) => s.kind !== 'verified' || s.status !== 'OPEN')) {
    return { ok: false, reason: 'B route 存在非 verified OPEN 的步骤' };
  }

  if (x.bMaps.length === 0) return { ok: false, reason: 'B 缺少真实 map 批次' };
  if (x.bMaps.some((b) => b.map !== x.expectedMap)) return { ok: false, reason: 'B 实际 map 不是同一个 svc.voxel 实例' };
  if (x.bMaps.some((b) => b.mapWorldId !== x.expectedMap.worldId)) return { ok: false, reason: 'B map 世界不一致' };

  if (!x.baselineCell.observed || !x.beforeStartCell.observed) return { ok: false, reason: 'witness 基准缺少原始 cellAt 证据' };
  if (!sameCellEvidence(x.baselineCell, x.beforeStartCell)) {
    return { ok: false, reason: 'B 开始前 witness 原证据被清空/刷新' };
  }

  const vision = x.bVision;
  if (!vision) return { ok: false, reason: 'B 缺少实际 Vision 调用' };
  if (vision.seq <= x.bStartSeq) return { ok: false, reason: 'B Vision 早于 B 起点（不能复用 A 旧观测）' };
  const output = visionOutputAt(vision, x.witnessCell);
  if (!output) return { ok: false, reason: 'B Vision 输出不含 witness 格' };
  if (output.worldId !== x.expectedScope.worldId || output.dimension !== x.expectedScope.dim || output.sessionId !== x.expectedScope.sessionId) {
    return { ok: false, reason: 'B Vision 输出 scope 与真实当前 scope 不一致' };
  }
  if (!(output.observedAt > (x.baselineCell.observedAt ?? Number.NEGATIVE_INFINITY))) {
    return { ok: false, reason: 'B Vision 时间未晚于 witness 原证据（不是新观测）' };
  }
  if (output.observationId === x.baselineCell.sequence) return { ok: false, reason: 'B Vision 不是新 observationId' };
  const producer = x.bMaps.find((b) => b.seq > vision.seq
    && b.observations.some((o) => observationMatchesVision(o, x.witnessCell, output)));
  if (!producer) return { ok: false, reason: 'B 新观测未写入同一 svc.voxel（sequence 未对上生产 map）' };

  if (!x.afterCell.observed) return { ok: false, reason: 'B 后 witness 格已无证据' };
  if (x.afterCell.sequence !== output.observationId) return { ok: false, reason: 'B 后 cellAt sequence 不是本次 Vision observationId' };
  if (x.afterCell.observedAt !== output.observedAt) return { ok: false, reason: 'B 后 cellAt 时间不是本次 Vision 原时间' };
  if (x.afterCell.sessionId !== output.sessionId) return { ok: false, reason: 'B 后 cellAt session 不是本次 Vision scope' };
  if (x.afterCell.name !== output.name) return { ok: false, reason: 'B 后 cellAt 名称不是本次 Vision 结果' };
  const expectedProps = Object.fromEntries(Object.entries(output.properties).map(([k, v]) => [k, String(v)]));
  if (JSON.stringify(x.afterCell.properties ?? {}) !== JSON.stringify(expectedProps)) {
    return { ok: false, reason: 'B 后 cellAt properties 不是本次 Vision 结果' };
  }
  return { ok: true };
}

export interface SpatialFinalSaveInput {
  anchorCheckpointId: string;
  anchorState: { dirty: boolean; lastConfirmedCheckpointId: string | null; voxelRevision: number };
  checkpoint: { checkpointId: string; voxelRevision: number; fragmentRevision: number; topologyRevision: number } | null;
  state: {
    dirty: boolean;
    voxelRevision: number; confirmedVoxelRevision: number;
    fragmentRevision: number; confirmedFragmentRevision: number;
    topologyRevision: number; confirmedTopologyRevision: number;
  };
  close: { completed: boolean; lastConfirmedCheckpointId: string | null; unconfirmedRequest: boolean; dirty: boolean; error: unknown } | null;
}

/**
 * S3 第一会话：空 anchor 干净，最终 checkpoint 是新 id，当前/已确认各域 revision
 * 与 checkpoint 完全一致，dirty=false，close 成功且确认同一 checkpoint；最终
 * voxel revision 必须领先空 anchor，证明 witness 相对 anchor 是新增事实。
 */
export function checkSpatialFinalSave(x: SpatialFinalSaveInput): { ok: boolean; reason?: string } {
  if (!x.anchorCheckpointId) return { ok: false, reason: 'anchor 缺少真实 checkpointId' };
  if (x.anchorState.dirty) return { ok: false, reason: '空 anchor 保存后仍 dirty' };
  if (x.anchorState.lastConfirmedCheckpointId !== x.anchorCheckpointId) {
    return { ok: false, reason: 'anchor 不是最后确认的 checkpoint' };
  }
  const cp = x.checkpoint;
  if (!cp) return { ok: false, reason: '缺少最终 checkpoint' };
  if (cp.checkpointId === x.anchorCheckpointId) return { ok: false, reason: '最终 checkpoint 仍是 anchor' };
  if (x.state.dirty) return { ok: false, reason: '最终保存后 dirty 仍为 true' };
  if (cp.voxelRevision !== x.state.voxelRevision || cp.voxelRevision !== x.state.confirmedVoxelRevision) {
    return { ok: false, reason: 'voxel revision 与当前/已确认版本不一致' };
  }
  if (cp.fragmentRevision !== x.state.fragmentRevision || cp.fragmentRevision !== x.state.confirmedFragmentRevision) {
    return { ok: false, reason: 'fragment revision 与当前/已确认版本不一致' };
  }
  if (cp.topologyRevision !== x.state.topologyRevision || cp.topologyRevision !== x.state.confirmedTopologyRevision) {
    return { ok: false, reason: 'topology revision 与当前/已确认版本不一致' };
  }
  if (cp.voxelRevision <= x.anchorState.voxelRevision) return { ok: false, reason: 'witness 未使 voxel revision 领先空 anchor' };
  const close = x.close;
  if (!close) return { ok: false, reason: '缺少真实 close 结果' };
  if (!close.completed) return { ok: false, reason: 'close 未完成' };
  if (close.unconfirmedRequest) return { ok: false, reason: 'close 存在未确认请求' };
  if (close.dirty) return { ok: false, reason: 'close 报告 dirty' };
  if (close.error !== null) return { ok: false, reason: 'close 自身报告错误' };
  if (close.lastConfirmedCheckpointId !== cp.checkpointId) return { ok: false, reason: 'close 未确认最终 checkpoint' };
  return { ok: true };
}

export interface SpatialWitness {
  pos: Vec3;
  dim: string;
  worldId: string;
  sessionId: string;
  name: string;
  properties: Record<string, string>;
  observedAt: number;
  sequence: number;
  cell: CellEvidenceSnapshot;
}

/** S3 重开：witness 原 state/properties/时间/sequence/session 保持，freshness 为 STALE。 */
export function checkSpatialReopen(witness: SpatialWitness, readback: CellEvidenceSnapshot): { ok: boolean; reason?: string } {
  if (!readback.observed) return { ok: false, reason: '重开后 witness 格无证据' };
  if (readback.freshness !== 'STALE') return { ok: false, reason: `重开后 freshness=${readback.freshness ?? 'missing'} 不是 STALE` };
  if (readback.name !== witness.name) return { ok: false, reason: '重开后 state 名称变化' };
  if (JSON.stringify(readback.properties ?? {}) !== JSON.stringify(witness.properties)) return { ok: false, reason: '重开后 properties 变化' };
  if (readback.observedAt !== witness.observedAt) return { ok: false, reason: '重开后 observedAt 变化' };
  if (readback.sequence !== witness.sequence) return { ok: false, reason: '重开后 sequence 变化' };
  if (readback.sessionId !== witness.sessionId) return { ok: false, reason: '重开后 session 变化' };
  return { ok: true };
}

export function adjacentRouteX(start: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): { x: number; y: number; z: number }[] {
  const n = Math.round(target.x - start.x);
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: start.x + i, y: start.y, z: start.z });
  return out;
}

// ---------------------------------------------------------------------------
// 断言谓词（供场景与窄测试复用；负例夹具验证其拒绝能力，不是镜像实现）
// ---------------------------------------------------------------------------

/** 结果确认为到达：outcome ARRIVED 且 confirmed（类型守卫，供场景安全取 lastPosition）。 */
export function isArrived(nav: NavResult | undefined): nav is NavResult & { outcome: 'ARRIVED' } {
  return !!nav && nav.outcome === 'ARRIVED' && nav.confirmed === true;
}

/** 非到达终态是否保留了实测部分位移（lastPosition 存在）。 */
export function hasPartialPosition(nav: NavResult | undefined): boolean {
  return !!nav && nav.outcome !== 'ARRIVED' && nav.lastPosition !== undefined;
}

/** 部分位移的 lastPosition 是否与最后一条已接受样本一致（有界容差）。 */
export function partialMatchesLastSample(nav: NavResult | undefined, accepted: { x: number; y: number; z: number }[], tol = 0.01): boolean {
  if (!nav?.lastPosition) return false;
  const last = accepted[accepted.length - 1];
  return !!last && Math.hypot(nav.lastPosition.x - last.x, nav.lastPosition.z - last.z) <= tol
    && Math.abs(nav.lastPosition.y - last.y) <= tol;
}

/** 整数方块 inclusive bounds → 世界连续支撑面 [min, max+1]（例如格 x205..206 → 面 [205,207)）。 */
export function blockFaceBounds(f: { xMin: number; xMax: number; zMin: number; zMax: number }) {
  return { xMin: f.xMin, xMax: f.xMax + 1, zMin: f.zMin, zMax: f.zMax + 1 };
}

/** 两段连续区间是否有严格正重叠；恰好边界接触（长度为 0）不算。 */
export function positiveOverlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

/**
 * 位置是否有水平支撑：身体半宽 0.3 的 AABB 与连续支撑面在两个轴上都有严格正重叠。
 * 不要求整个脚掌留在台面；刚好零接触不算支撑。
 */
export function withinFootprint(pos: { x: number; z: number }, f: { xMin: number; xMax: number; zMin: number; zMax: number }, halfWidth = 0.3): boolean {
  const face = blockFaceBounds(f);
  return positiveOverlap(pos.x - halfWidth, pos.x + halfWidth, face.xMin, face.xMax) > 0
    && positiveOverlap(pos.z - halfWidth, pos.z + halfWidth, face.zMin, face.zMax) > 0;
}

/** 是否任一帧没有水平支撑（已把整数方块 bounds 转为连续面并应用半宽）。 */
export function platformEscaped(frames: { x: number; z: number }[], f: { xMin: number; xMax: number; zMin: number; zMax: number }, halfWidth = 0.3): boolean {
  return frames.some((p) => !withinFootprint(p, f, halfWidth));
}

/** 所有帧都在实测脚高上且着地（无坠落/腾空）。 */
export function allGroundedAt(frames: { y: number; onGround: boolean }[], feetY: number, feetTol = 0.05): boolean {
  return frames.length > 0 && frames.every((fr) => fr.onGround && Math.abs(fr.y - feetY) <= feetTol);
}

/** 时间戳之后的帧（用于把 teleport/搭设帧排除在支撑断言之外，防 setup 污染）。 */
export function framesSince(frames: FrameRecord[], ts: number): FrameRecord[] {
  return frames.filter((f) => f.ts >= ts);
}

export function vecEqual(a: { x: number; y: number; z: number } | null | undefined, b: { x: number; y: number; z: number } | null | undefined, eps = 1e-9): boolean {
  return !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

export function allKeysReleased(keys: Keys): boolean {
  return KEYS.every((k) => keys[k] === false);
}

function finiteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** 公开 EventEmitter/EventTarget 的真实监听器函数集合；非 emitter 返回空集（假夹具不伪造）。 */
function listenerSet(target: unknown, event: string): ListenerSet {
  if (target === null || typeof target !== 'object') return new Set();
  const t = target as { on?: unknown; addEventListener?: unknown };
  if (typeof t.on === 'function') return new Set(getEventListeners(target as NodeJS.EventEmitter, event));
  if (typeof t.addEventListener === 'function') return new Set(getEventListeners(target as EventTarget, event));
  return new Set();
}

/** 公开 EventEmitter/EventTarget 监听器计数；非 emitter 返回 0（假夹具不伪造）。 */
function eventListenerCount(target: unknown, event: string): number {
  return listenerSet(target, event).size;
}

function addedListenerSet(before: ListenerSet, after: ListenerSet): ListenerSet {
  return new Set([...after].filter((fn) => !before.has(fn)));
}

/** 只按函数身份确认本 tick 自己新增的监听器是否仍存在，不受总数巧合影响。 */
function residualListenerCount(owned: ListenerSet, after: ListenerSet): number {
  return [...owned].filter((fn) => after.has(fn)).length;
}

export interface ListenerCounts { physicsTick: number; end: number }

/** 真实 Bot 上 physicsTick/end 的监听器基线；用于确认本任务等待结束后没有残留。 */
export function botListenerCounts(target: unknown): ListenerCounts {
  return { physicsTick: eventListenerCount(target, 'physicsTick'), end: eventListenerCount(target, 'end') };
}

export function assertListenerBaseline(before: ListenerCounts, after: ListenerCounts, label: string): void {
  if (after.physicsTick !== before.physicsTick || after.end !== before.end) {
    throw new Error(`${label} 监听器未恢复到基线：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

/** 本任务仍 pending 的 walkTick 等待。 */
export function pendingTicksFor(ticks: TickEntry[], taskId: string): TickEntry[] {
  return ticks.filter((t) => t.pending && t.ownerTaskId === taskId);
}

function tickListenerLeaks(t: TickEntry): boolean {
  return t.ownedAbortResidual > 0 || t.ownedPhysicsTickResidual > 0 || t.ownedEndResidual > 0;
}

/**
 * 本任务所有 walkTick 等待必须解除，且本 tick 自己新增的 physicsTick/end/abort 函数
 * 全部消失。只看函数身份差集，不用全局总数相等推断归属（其它监听器可合法增减）。
 */
export function assertOwnedTicksReleased(ticks: TickEntry[], taskId: string, label: string): void {
  const pending = pendingTicksFor(ticks, taskId);
  if (pending.length > 0) {
    throw new Error(`${label} 仍有 ${pending.length} 个未解除的 walkTick 等待：${JSON.stringify(pending.map((t) => ({ diagId: t.diagId, seqStart: t.seqStart, tsStart: t.tsStart })))}`);
  }
  const leaks = ticks.filter((t) => t.ownerTaskId === taskId && tickListenerLeaks(t));
  if (leaks.length > 0) {
    throw new Error(`${label} 残留 walkTick 监听器：${JSON.stringify(leaks.map((t) => ({
      diagId: t.diagId,
      abort: { added: t.ownedAbortAdded, residual: t.ownedAbortResidual },
      physicsTick: { added: t.ownedPhysicsTickAdded, residual: t.ownedPhysicsTickResidual },
      end: { added: t.ownedEndAdded, residual: t.ownedEndResidual },
    })))}`);
  }
}

/** 真实结束时刻必须不早于全局 deadline（排除每段 timeout），且不超过有限延迟边界。 */
export function assertTimeoutAfterDeadline(observedAt: number, deadlineMs: number, maxLatenessMs: number, label: string): void {
  if (!Number.isFinite(observedAt)) throw new Error(`${label} TIMEOUT 时刻非有限数：${observedAt}`);
  if (observedAt < deadlineMs) {
    throw new Error(`${label} TIMEOUT 早于全局 deadline ${deadlineMs - observedAt}ms（疑似每段 timeout/错误，不能冒充全局超时）`);
  }
  if (observedAt > deadlineMs + maxLatenessMs) {
    throw new Error(`${label} TIMEOUT 超出有限延迟边界：晚 ${observedAt - deadlineMs}ms > ${maxLatenessMs}ms`);
  }
}

/**
 * 非到达终态必须保留真实部分位移：位置来自该 task+delegation 最后一条被公开状态证明的
 * 原始 sample，nav.lastPosition/lastObservation 与它一致，且相对任务起点实测距离 > minDistance。
 */
export function assertRealPartial(
  nav: NavResult | undefined,
  records: DeliveredSampleRecord[],
  taskId: string,
  delegationId: string,
  startPos: Vec3,
  minDistance: number,
  label: string,
): DeliveredSampleRecord {
  if (nav?.outcome === 'ARRIVED' || nav?.confirmed !== false) {
    throw new Error(`${label} 非到达终态必须 confirmed=false：outcome=${nav?.outcome} confirmed=${nav?.confirmed}`);
  }
  if (!nav?.lastPosition) throw new Error(`${label} 终态未保留 lastPosition`);
  const accepted = acceptedMeasurements(records, taskId, delegationId);
  const last = accepted[accepted.length - 1];
  if (!last) throw new Error(`${label} 无被公开状态证明的实测样本（wrong task/sample 不得冒充）`);
  if (!partialMatchesRecorded(nav, accepted)) throw new Error(`${label} 部分位移与最后有效原始 sample 的时间/scope/位置不一致`);
  const moved = dist2(nav.lastPosition, startPos);
  if (!(moved > minDistance)) {
    throw new Error(`${label} 实际位移 ${moved.toFixed(3)} <= ${minDistance}（初始位置存在不等于部分位移）`);
  }
  return last;
}

/** 真实断线必须同时观察到 adapter.disconnected 与 bot.end，且都发生在 quit 之后。 */
export function assertEndObserved(
  adapterDisconnectedSeq: number | null,
  botEndSeq: number | null,
  quitSeq: number,
  label: string,
): void {
  if (adapterDisconnectedSeq === null) throw new Error(`${label} 未观察到真实 adapter.disconnected`);
  if (botEndSeq === null) throw new Error(`${label} 未观察到真实 bot.end`);
  if (adapterDisconnectedSeq <= quitSeq) throw new Error(`${label} adapter.disconnected 早于 quit（不是本次真实断线）`);
  if (botEndSeq <= quitSeq) throw new Error(`${label} bot.end 早于 quit（不是本次真实断线）`);
}

/**
 * 本任务实际 move 段集合：必须恰好包含 delegation 的 0..expectedCount-1 段，
 * 每段归属正确、from/to 完整；0/1/2 段或额外段都不通过。
 */
export interface SegmentSetCheck {
  ok: boolean;
  reason?: string;
  segments: MoveRecord[];
  missing: string[];
  extra: string[];
  incomplete: MoveRecord[];
}

/**
 * 本任务段集合必须同时按真实 taskId 与 delegationId 定位：delegationId 是按实例递增的
 * `walk-<generation>`，不同任务可能同名（例如两个实例都是 walk-1）。同名 ID 下另一任务
 * 的合法段既不算本任务的 extra，也不算 wrongOwner；本任务漏段仍必须 FAIL。
 */
export function checkTaskSegments(
  moves: MoveRecord[],
  delegationId: string,
  taskId: string,
  expectedCount: number,
): SegmentSetCheck {
  const own = moves.filter((m) => m.taskId === taskId && m.delegationId === delegationId);
  const expected = Array.from({ length: expectedCount }, (_, i) => `${delegationId}-step-${i}`);
  const ids = own.map((m) => m.executionId);
  const missing = expected.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !expected.includes(id));
  const segments = expected.flatMap((id) => own.filter((m) => m.executionId === id));
  const incomplete = segments.filter((m) => !finiteVec(m.from) || !finiteVec(m.to));
  const ok = own.length === expectedCount && missing.length === 0 && extra.length === 0
    && incomplete.length === 0 && segments.length === expectedCount;
  const reason = !ok
    ? `own=${own.length} expected=${expectedCount} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} incomplete=${incomplete.length}`
    : undefined;
  return { ok, reason, segments, missing, extra, incomplete };
}

function finiteSample(sample: BodySample): boolean {
  return Number.isFinite(sample.pos.x) && Number.isFinite(sample.pos.y) && Number.isFinite(sample.pos.z)
    && Number.isFinite(sample.observedAt) && Number.isFinite(sample.sequence);
}

/**
 * 公开 onSample 状态证明「该原始测量确实被库记录为候选测量」：样本有限、id 属于该
 * delegation、sequence/observedAt 单调、调用前未终结、样本 scope 与真实 public status
 * 的作用域一致、调用后 lastPosition 正是该原始测量。
 *
 * 这不是「每次交付都被接纳」的声明：lastPosition 在拒绝同位置的错误 scope 样本时
 * 保持不变，必须靠 scope 比对排除；真正的完成/部分位移还要用 nextPointIndex 推进
 * 和最终 NavResult.lastObservation 的原 time/scope/position 证明（见 measuredCompletions /
 * partialMatchesRecorded）。
 *
 * 查询必须用「目标真实 taskId + delegationId」组合定位：delegation 是按实例递增的
 * `walk-<generation>`，两个任务都可能是 walk-1；sequence/observedAt 单调也只在该组合
 * 内隔离，不能用另一任务的高 sequence 拒绝本任务的低 sequence 样本。
 */
export function acceptedMeasurements(
  records: DeliveredSampleRecord[],
  taskId: string,
  delegationId: string,
): DeliveredSampleRecord[] {
  let prevSeq = Number.NEGATIVE_INFINITY;
  let prevObserved = Number.NEGATIVE_INFINITY;
  const out: DeliveredSampleRecord[] = [];
  for (const r of records) {
    if (r.ownerTaskId !== taskId || r.delegationId !== delegationId) continue;
    const recorded = finiteSample(r.sample)
      && r.sample.executionId === r.delegationId
      && r.sample.worldId === r.statusAfter.worldId
      && r.sample.dim === r.statusAfter.dim
      && r.sample.sessionId === r.statusAfter.sessionId
      && r.statusBefore.result === null
      && r.sample.sequence > prevSeq
      && r.sample.observedAt >= prevObserved
      && r.statusAfter.lastPosition !== null
      && vecEqual(r.statusAfter.lastPosition, r.sample.pos);
    if (recorded) {
      out.push(r);
      prevSeq = r.sample.sequence;
      prevObserved = r.sample.observedAt;
    }
  }
  return out;
}

/**
 * 本 task+delegation 最新被公开状态证明的实测 sample 相对起点确实超过 minDistance 时返回它。
 * 触发注入前置只能用执行器已确认的测量，不能用比已交付样本超前的 body/adapter 原始状态。
 */
export function acceptedMovementBeyond(
  records: DeliveredSampleRecord[],
  taskId: string,
  delegationId: string,
  startPos: Vec3,
  minDistance: number,
): DeliveredSampleRecord | undefined {
  const accepted = acceptedMeasurements(records, taskId, delegationId);
  const last = accepted[accepted.length - 1];
  return last && last.statusAfter.result === null && last.statusAfter.activeStepIndex !== null
    && dist2(last.sample.pos, startPos) > minDistance ? last : undefined;
}

/**
 * 终态 NavResult 的 lastObservation 必须就是最后一条候选测量的原始 time/scope 与位置，
 * 从而把 partial/完成所用测量绑定到真实观测，而不是仅凭「位置看起来一致」。
 */
export function partialMatchesRecorded(
  nav: NavResult | undefined,
  records: DeliveredSampleRecord[],
  tol = 0.01,
): boolean {
  if (!nav?.lastPosition) return false;
  const last = records[records.length - 1];
  if (!last) return false;
  const obs = nav.lastObservation;
  if (!obs) return false;
  const s = last.sample;
  return Math.hypot(nav.lastPosition.x - s.pos.x, nav.lastPosition.z - s.pos.z) <= tol
    && Math.abs(nav.lastPosition.y - s.pos.y) <= tol
    && obs.observedAt === s.observedAt
    && obs.worldId === s.worldId
    && obs.dim === s.dim
    && obs.sessionId === s.sessionId;
}

/** 被公开状态证明的逐段到达：nextPointIndex 真实推进且该次原始测量已记录。 */
export function measuredCompletions(
  records: DeliveredSampleRecord[],
  taskId: string,
  delegationId: string,
): MeasuredCompletion[] {
  return acceptedMeasurements(records, taskId, delegationId)
    .filter((r) => r.statusAfter.nextPointIndex > r.statusBefore.nextPointIndex)
    .map((r) => ({
      stepIndex: r.statusBefore.nextPointIndex - 1,
      sampleSequence: r.sample.sequence,
      observedAt: r.sample.observedAt,
      pos: { ...r.statusAfter.lastPosition! },
      sample: r,
    }));
}

/**
 * 下一段的 from 必须严格等于上一段由公开状态证明的实测完成点（x/y/z 全部），
 * 不接受名义 prev.to，也不接受 arrival tolerance 内的近似。
 */
export function segmentsFollowMeasured(
  moves: MoveRecord[],
  completions: MeasuredCompletion[],
  eps = 1e-9,
): boolean {
  if (moves.length === 0) return false;
  for (let i = 1; i < moves.length; i++) {
    const completion = completions.find((c) => c.stepIndex === i - 1);
    if (!completion || !vecEqual(moves[i]!.from, completion.pos, eps)) return false;
  }
  return true;
}

/** 取消/交接边界后的旧任务实际控制调用是否违规（只用 eventSeq 判定先后）。 */
export interface OldOwnerBoundary {
  cancelSeq: number;
  takeoverSeq: number;
}

export interface OldOwnerViolations {
  /** 取消后仍实际写入并保持 7 键中任一 keysAfter=true。 */
  revived: ActualControlEntry[];
  /** B 已接管后，旧任务仍发出任何实际 set/clear。 */
  afterTakeover: ActualControlEntry[];
  /** 取消后、接管前的旧任务真实松键（允许，仅作证据）。 */
  releasedBeforeTakeover: ActualControlEntry[];
}

export function classifyOldOwnerControls(
  actualControls: ActualControlEntry[],
  ownerTaskId: string,
  boundary: OldOwnerBoundary,
): OldOwnerViolations {
  const own = actualControls.filter((c) => c.ownerTaskId === ownerTaskId && c.seq > boundary.cancelSeq);
  // 任何 7 键之一的真实 keysAfter=true 都是复活；只写 forward 会漏掉 back/left/right/jump/sprint/sneak。
  const revived = own.filter((c) => c.op === 'set' && c.value === true
    && c.name !== undefined && (KEYS as string[]).includes(c.name)
    && c.keysAfter[c.name as ControlState] === true);
  const revivedSeq = new Set(revived.map((c) => c.seq));
  return {
    revived,
    afterTakeover: own.filter((c) => c.seq > boundary.takeoverSeq),
    // 接管前允许合法松键；但已真实复活的 true 条目不能同时被说成「松键」。
    releasedBeforeTakeover: own.filter((c) => c.seq <= boundary.takeoverSeq && !revivedSeq.has(c.seq)),
  };
}

/**
 * B 目标 loop（真实 taskId + delegationId）的交付样本必须保留原始 sample id，并且
 * （活动段）实际经 B 自己的 frameSink 送达：旧 A 来源把 executionId 改写成 B 仍会因
 * sourceOwner 被拒。直接调用只允许出现在初始化阶段；活动段无法确认来源时同样拒绝。
 *
 * 先按 taskId+delegationId 定位目标 loop：同名 delegation 下 A 自己 loop 的合法记录
 * 不属于 B 的外来样本；只有进入 B 目标 loop 的记录才接受来源检查。
 */
export function foreignSampleDeliveries(
  records: DeliveredSampleRecord[],
  delegationId: string,
  taskId: string,
): DeliveredSampleRecord[] {
  return records.filter((r) => r.ownerTaskId === taskId && r.delegationId === delegationId && (
    r.sample.executionId !== delegationId
    || (r.source === 'frameSink' && r.sourceOwnerTaskId !== taskId)
    || (r.source === 'direct' && r.statusBefore.activeStepIndex !== null)
  ));
}

/**
 * 目标任务+delegation 的首条真实 public 终态（statusAfter.result 非 null）事件序号。
 * 终态可能出现在 advance/start 记录，也可能出现在 onSample 交付记录里；活动窗口终点
 * 只来自这些已记录的公开状态，不用预计结束时间或 done 后补的标记。
 */
export function publicRouteTerminalSeq(
  routeCalls: RouteCallRecord[],
  deliveredSamples: DeliveredSampleRecord[],
  taskId: string,
  delegationId: string,
): number | null {
  const terminalSeqs = [
    ...routeCalls
      .filter((c) => c.ownerTaskId === taskId && c.delegationId === delegationId && c.statusAfter.result !== null)
      .map((c) => c.seq),
    ...deliveredSamples
      .filter((r) => r.ownerTaskId === taskId && r.delegationId === delegationId && r.statusAfter.result !== null)
      .map((r) => r.seq),
  ];
  return terminalSeqs.length > 0 ? Math.min(...terminalSeqs) : null;
}

/**
 * seqBefore 严格落在 (afterSeq, beforeSeq) 内的生产 stopAll。W6 的 B 活动窗口内没有
 * 授权的 cancel/pause/disconnect，因此窗口内任何生产 stopAll 都是未授权的旧 A 迟到清理
 * 嫌疑；B 公开终态之后（包含终态事件本身之后）的正常收尾不在窗口内。
 */
export function productionStopAllsInWindow(
  stopAlls: StopAllRecord[],
  afterSeq: number,
  beforeSeq: number,
): StopAllRecord[] {
  return stopAlls.filter((s) => s.kind === 'production' && s.seqBefore > afterSeq && s.seqBefore < beforeSeq);
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; } catch { return false; }
}

// ---------------------------------------------------------------------------
// 诊断采集（不改任何运行时行为：只包装并委托原实现，所有权在创建时绑定一次）
// ---------------------------------------------------------------------------

export interface WalkBridge {
  walkBody?: () => WalkBody;
  walkTick?: () => WalkTick;
  stopAll: () => void;
}

/** 原始 Bot 的最小控制入口；包装后完全透传原参数/this/返回。 */
export interface RawControlTarget {
  setControlState(name: string, value: boolean): void;
  clearControlStates(): void;
}

/**
 * 采集身体桥控制请求、原始 Bot 实际控制调用、生产 stopAll 前后、walkTick 等待/交付。
 * 归属（taskId）绑定在「walkBody / walkTick 创建那一刻」，不是旧回调触发时的 arbiter.current。
 */
export class WalkDiagnostics {
  readonly attempts: ControlAttempt[] = [];
  readonly actualControls: ActualControlEntry[] = [];
  readonly stopAlls: StopAllRecord[] = [];
  readonly ticks: TickEntry[] = [];
  readonly bindings: BindingRecord[] = [];
  /** 最近一次 walkBody 创建时的任务；仅上下文证据，不代表 stopAll 调用者。 */
  private recentBodyOwner: string | null = null;
  private rawCallOwner: string | null = null;
  private origBody?: () => WalkBody;
  private origTick?: () => WalkTick;
  private origStop?: () => void;
  private origRawSet?: RawControlTarget['setControlState'];
  private origRawClear?: RawControlTarget['clearControlStates'];

  constructor(
    private readonly target: WalkBridge,
    private readonly owner: () => string | null,
    private readonly readKeys: () => Keys,
    private readonly seq: EventSeq,
    private readonly rawBot?: RawControlTarget,
    private readonly now: () => number = Date.now,
  ) {}

  wrap() {
    const origBody = this.target.walkBody;
    const origTick = this.target.walkTick;
    const origStop = this.target.stopAll;
    const raw = this.rawBot;

    // 原始 Bot 实际入口：先读 before，调用原方法，再读 after；所有调用都记录，
    // 包括「按键原本已是目标值」的 false/no-op，以及被内部 guard 拦住的请求。
    if (raw) {
      const self = this;
      const origSet = raw.setControlState;
      const origClear = raw.clearControlStates;
      raw.setControlState = function (name: string, value: boolean) {
        const seq = self.seq.next();
        const ts = self.now();
        const ownerTaskId = self.rawCallOwner;
        const keysBefore = self.readKeys();
        origSet.call(raw, name, value);
        const keysAfter = self.readKeys();
        self.actualControls.push({ seq, ts, op: 'set', name, value, ownerTaskId, keysBefore, keysAfter });
      };
      raw.clearControlStates = function () {
        const seq = self.seq.next();
        const ts = self.now();
        const ownerTaskId = self.rawCallOwner;
        const keysBefore = self.readKeys();
        origClear.call(raw);
        const keysAfter = self.readKeys();
        self.actualControls.push({ seq, ts, op: 'clear', ownerTaskId, keysBefore, keysAfter });
      };
      this.origRawSet = origSet;
      this.origRawClear = origClear;
    }

    if (origBody) {
      this.target.walkBody = () => {
        const owner = this.owner();
        this.recentBodyOwner = owner;
        this.bindings.push({ seq: this.seq.next(), ts: this.now(), ownerTaskId: owner, kind: 'body' });
        const body = origBody.call(this.target);
        // 这些只是身体桥请求（attempt）；是否真的写入由原始 Bot 入口记录证明。
        return {
          setControlState: (name: string, value: boolean) => {
            this.attempts.push({ seq: this.seq.next(), ts: this.now(), op: 'set', name, value, ownerTaskId: owner });
            const prevOwner = this.rawCallOwner;
            this.rawCallOwner = owner;
            try { body.setControlState(name, value); } finally { this.rawCallOwner = prevOwner; }
          },
          clearControlStates: () => {
            this.attempts.push({ seq: this.seq.next(), ts: this.now(), op: 'clear', ownerTaskId: owner });
            const prevOwner = this.rawCallOwner;
            this.rawCallOwner = owner;
            try { body.clearControlStates(); } finally { this.rawCallOwner = prevOwner; }
          },
          look: (yaw: number, pitch: number) => {
            this.attempts.push({ seq: this.seq.next(), ts: this.now(), op: 'look', ownerTaskId: owner });
            return body.look(yaw, pitch);
          },
          entity: body.entity,
        };
      };
    }

    if (origTick) {
      this.target.walkTick = () => {
        const owner = this.owner();
        this.bindings.push({ seq: this.seq.next(), ts: this.now(), ownerTaskId: owner, kind: 'tick' });
        const tick = origTick.call(this.target);
        return async (signal: AbortSignal) => {
          const seqStart = this.seq.next();
          const tsStart = this.now();
          // 调用原 tick 前的真实函数集合；差值即本 tick 自己的监听器。
          const signalBefore = listenerSet(signal, 'abort');
          const botTickBefore = listenerSet(this.rawBot, 'physicsTick');
          const botEndBefore = listenerSet(this.rawBot, 'end');
          const entry: TickEntry = {
            seqStart, seqEnd: 0, tsStart, tsEnd: 0, diagId: `tick-${seqStart}`, ownerTaskId: owner, delivered: false,
            pending: true, signalAbortedAtEnd: false,
            signalAbortListenersAtStart: signalBefore.size,
            signalAbortListenersWhilePending: 0,
            signalAbortListenersAtEnd: 0,
            botPhysicsTickListenersAtStart: botTickBefore.size,
            botPhysicsTickListenersWhilePending: 0,
            botPhysicsTickListenersAtEnd: 0,
            botEndListenersAtStart: botEndBefore.size,
            botEndListenersWhilePending: 0,
            botEndListenersAtEnd: 0,
            ownedAbortAdded: 0, ownedPhysicsTickAdded: 0, ownedEndAdded: 0,
            ownedAbortResidual: 0, ownedPhysicsTickResidual: 0, ownedEndResidual: 0,
          };
          // 等待一开始就记录：W7b 需要在 physics 暂停期间证明本任务确有未完成的帧等待，
          // 而不是等 250ms 后凭现有 snapshot 假定存在。
          this.ticks.push(entry);
          const pending = tick(signal);
          // tick() 同步注册 physicsTick/end/abort；按函数身份保存本 tick 新增的集合。
          const signalPending = listenerSet(signal, 'abort');
          const botTickPending = listenerSet(this.rawBot, 'physicsTick');
          const botEndPending = listenerSet(this.rawBot, 'end');
          const owned: OwnedTickListeners = {
            abort: addedListenerSet(signalBefore, signalPending),
            physicsTick: addedListenerSet(botTickBefore, botTickPending),
            end: addedListenerSet(botEndBefore, botEndPending),
          };
          entry.ownedAbortAdded = owned.abort.size;
          entry.ownedPhysicsTickAdded = owned.physicsTick.size;
          entry.ownedEndAdded = owned.end.size;
          entry.signalAbortListenersWhilePending = signalPending.size;
          entry.botPhysicsTickListenersWhilePending = botTickPending.size;
          entry.botEndListenersWhilePending = botEndPending.size;
          const entity = await pending;
          entry.seqEnd = this.seq.next();
          entry.tsEnd = this.now();
          entry.delivered = entity !== null;
          if (entity) entry.pos = { ...entity.position };
          entry.pending = false;
          entry.signalAbortedAtEnd = signal.aborted;
          const signalEnd = listenerSet(signal, 'abort');
          const botTickEnd = listenerSet(this.rawBot, 'physicsTick');
          const botEndEnd = listenerSet(this.rawBot, 'end');
          entry.signalAbortListenersAtEnd = signalEnd.size;
          entry.botPhysicsTickListenersAtEnd = botTickEnd.size;
          entry.botEndListenersAtEnd = botEndEnd.size;
          entry.ownedAbortResidual = residualListenerCount(owned.abort, signalEnd);
          entry.ownedPhysicsTickResidual = residualListenerCount(owned.physicsTick, botTickEnd);
          entry.ownedEndResidual = residualListenerCount(owned.end, botEndEnd);
          return entity;
        };
      };
    }

    this.target.stopAll = () => {
      // recentBodyOwnerTaskId 只作为上下文记录，不是本次 stopAll 的调用者归属。
      // 嵌套的 raw.clearControlStates 调用者未知，rawCallOwner 置 null，避免把未知真实
      // 调用者冒充成最近 body 任务。
      const recentBodyOwnerTaskId = this.recentBodyOwner;
      const seqBefore = this.seq.next();
      const ts = this.now();
      const keysBefore = this.readKeys();
      const prevOwner = this.rawCallOwner;
      this.rawCallOwner = null;
      try { origStop.call(this.target); } finally { this.rawCallOwner = prevOwner; }
      const keysAfter = this.readKeys();
      this.stopAlls.push({ seqBefore, seqAfter: this.seq.next(), ts, label: 'production-stopAll', kind: 'production', keysBefore, keysAfter, recentBodyOwnerTaskId });
    };

    this.origBody = origBody;
    this.origTick = origTick;
    this.origStop = origStop;
  }

  /** 只恢复原实现；绝不调用 clear/stop，避免清理时误清接管任务的新键。 */
  unwrap() {
    if (this.origBody) this.target.walkBody = this.origBody;
    if (this.origTick) this.target.walkTick = this.origTick;
    if (this.origStop) this.target.stopAll = this.origStop;
    if (this.rawBot) {
      if (this.origRawSet) this.rawBot.setControlState = this.origRawSet;
      if (this.origRawClear) this.rawBot.clearControlStates = this.origRawClear;
    }
    this.origBody = undefined;
    this.origTick = undefined;
    this.origStop = undefined;
    this.origRawSet = undefined;
    this.origRawClear = undefined;
  }
}

/**
 * 采集库执行层的真实记录：WalkRouteExecutor 的公开 start/advance/onSample，
 * WalkMoveExecutor 的公开 setFrameSink/move。归属在创建时绑定到具体实例，
 * 旧 A 的迟到回调仍按 A 的静态绑定记录，不读取调用时的 arbiter.current。
 */
type MoveFn = (this: WalkMoveExecutor, request: ExecutableMove) => ReturnType<WalkMoveExecutor['move']>;
type OnSampleFn = (this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus;
type StartFn = (this: WalkRouteExecutor, request: Parameters<WalkRouteExecutor['start']>[0]) => WalkRouteStatus;
type AdvanceFn = (this: WalkRouteExecutor, budget: number) => WalkRouteStatus;
type SetFrameSinkFn = (this: WalkMoveExecutor, fn: Parameters<WalkMoveExecutor['setFrameSink']>[0]) => void;
type ObserveBatchFn = (this: VoxelMap, batch: ObservationBatch) => ChangeReport;
type LoopObserveFn = (this: WalkRouteExecutor, report: ChangeReport, budget: number) => WalkRouteStatus;

export interface EyeSnapshot { x: number; y: number; z: number; yaw: number; pitch: number }

/** 实际 Vision.observeBlocks 的输入与实际输出（含真实 scope/时间/observationId）。 */
export interface VisionCallRecord {
  seq: number;
  ts: number;
  frame: number;
  visionId: number;
  positions: Vec3[];
  eye: EyeSnapshot | null;
  /** observeBlocks 原返回的完整 typed 副本（保留 source 与可选字段的未定义状态，不补字段）。 */
  payload: BlockObservation[];
  output: Array<{
    pos: Vec3;
    name: string;
    properties: Record<string, string | number | boolean>;
    stateComplete: boolean | null;
    worldId: string;
    sessionId: string;
    dimension: string;
    observedAt: number;
    observationId: number;
  }>;
}

/** 实际 map.observeBatch 的输入、返回对象，以及 WeakMap 编号证明的同一对象身份。 */
export interface MapBatchRecord {
  seq: number;
  ts: number;
  frame: number;
  mapId: number;
  mapWorldId: string;
  map: VoxelMap;
  observations: Observation[];
  unobserved: ObservationBatch['unobserved'];
  reportId: number;
  report: ChangeReport;
}

/** 可写入证据 JSON 的 map 批次：保留公开输入/报告与编号，剔除临时 VoxelMap 引用。 */
export type StoredMapBatchRecord = Omit<MapBatchRecord, 'map'> & {
  /** 采集时该批次 map 是否为 ctx.spatial.session.voxel 同一实例（不写入 map 引用）。 */
  mapIsSessionVoxel?: boolean;
};

/** loop.observe 进入/退出时的完整公开状态、7 键、事件序号与 physics frame。 */
export interface ObserveCallRecord {
  enterSeq: number;
  exitSeq: number;
  tsEnter: number;
  tsExit: number;
  frameEnter: number;
  frameExit: number;
  ownerTaskId: string | null;
  delegationId: string;
  /** 每个真实入参 ChangeReport 对象独立分配；生命周期报告也有稳定编号。 */
  reportId: number;
  /** 入参原报告对象（不改内容），生命周期/其他来源报告原样保留。 */
  report: ChangeReport;
  /**
   * 该报告是否就是已记录 mapBatch 的同一对象。false 表示它不来自已捕获取的
   * observeBatch/Vision 链路，绝不能当作合法视觉报告。
   */
  mapBatchMatched: boolean;
  /** mapBatch 匹配来源，或明确标为非 Vision/mapBatch 来源。 */
  reportSource: 'mapBatch' | 'unmatched';
  statusBefore: RouteStatusSnapshot | null;
  statusAfter: RouteStatusSnapshot;
  keysBefore: Keys;
  keysAfter: Keys;
}

export interface ExecutionCaptureOptions {
  vision?: Vision;
  frame?: () => number;
  eye?: () => EyeSnapshot | null;
  readKeys?: () => Keys;
}

export class ExecutionDiagnostics {
  readonly moves: MoveRecord[] = [];
  readonly deliveredSamples: DeliveredSampleRecord[] = [];
  readonly routeCalls: RouteCallRecord[] = [];
  readonly observes: ObserveCallRecord[] = [];
  readonly mapBatches: MapBatchRecord[] = [];
  readonly visionCalls: VisionCallRecord[] = [];
  readonly bindings: BindingRecord[] = [];
  private wrapped = false;
  private readonly reportIds = new WeakMap<object, number>();
  /** 真实 observeBatch 返回过的报告对象；用于确认 loop.observe 入参的同一对象来源。 */
  private readonly mapReports = new WeakSet<ChangeReport>();
  private readonly mapIds = new WeakMap<object, number>();
  private nextReportId = 0;
  private nextMapId = 0;
  private nextVisionId = 0;
  private origObserveBatch?: ObserveBatchFn;
  private origLoopObserve?: LoopObserveFn;
  private origObserveBlocks?: Vision['observeBlocks'];
  private readonly capture: ExecutionCaptureOptions;
  private readonly routeOwners = new WeakMap<WalkRouteExecutor, { taskId: string | null; delegationId: string }>();
  private readonly moveOwners = new WeakMap<WalkMoveExecutor, { taskId: string | null }>();
  /** 当前同步 frameSink 回调的来源 loop 绑定；直接 onSample（初始化）时为 null。 */
  private frameSinkSourceOwner: string | null = null;
  private inFrameSink = false;
  private origMove?: MoveFn;
  private origOnSample?: OnSampleFn;
  private origStart?: StartFn;
  private origAdvance?: AdvanceFn;
  private origSetFrameSink?: SetFrameSinkFn;

  constructor(
    private readonly seq: EventSeq,
    private readonly owner: () => string | null,
    private readonly now: () => number = Date.now,
    capture: ExecutionCaptureOptions = {},
  ) {
    this.capture = capture;
  }

  private keys(): Keys {
    return this.capture.readKeys?.() ?? { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  }

  private frame(): number {
    return this.capture.frame?.() ?? 0;
  }

  private idForMap(map: VoxelMap): number {
    let id = this.mapIds.get(map);
    if (id === undefined) { id = ++this.nextMapId; this.mapIds.set(map, id); }
    return id;
  }

  private idForReport(report: ChangeReport): number {
    let id = this.reportIds.get(report);
    if (id === undefined) { id = ++this.nextReportId; this.reportIds.set(report, id); }
    return id;
  }

  wrap() {
    if (this.wrapped) return;
    this.wrapped = true;
    const self = this;
    const origMove = WalkMoveExecutor.prototype.move as MoveFn;
    const origOnSample = WalkRouteExecutor.prototype.onSample as OnSampleFn;
    const origStart = WalkRouteExecutor.prototype.start as StartFn;
    const origAdvance = WalkRouteExecutor.prototype.advance as AdvanceFn;
    const origSetFrameSink = WalkMoveExecutor.prototype.setFrameSink as SetFrameSinkFn;
    const origObserveBatch = VoxelMap.prototype.observeBatch as ObserveBatchFn;
    const origLoopObserve = WalkRouteExecutor.prototype.observe as LoopObserveFn;
    this.origMove = origMove;
    this.origOnSample = origOnSample;
    this.origStart = origStart;
    this.origAdvance = origAdvance;
    this.origSetFrameSink = origSetFrameSink;
    this.origObserveBatch = origObserveBatch;
    this.origLoopObserve = origLoopObserve;

    (WalkRouteExecutor.prototype as { start: StartFn }).start = function (this: WalkRouteExecutor, request: Parameters<WalkRouteExecutor['start']>[0]) {
      const owner = self.owner();
      const before = snapshotStatus(this.status());
      const status = origStart.call(this, request);
      self.routeOwners.set(this, { taskId: owner, delegationId: status.delegationId });
      self.routeCalls.push({
        seq: self.seq.next(), ts: self.now(), op: 'start', ownerTaskId: owner,
        delegationId: status.delegationId, statusBefore: before, statusAfter: snapshotStatus(status)!,
      });
      return status;
    };

    (WalkRouteExecutor.prototype as { advance: AdvanceFn }).advance = function (this: WalkRouteExecutor, budget: number) {
      // 归属在进入调用前静态取出；即使原实现内发生重入 start，也不改标本次事件。
      const binding = self.routeOwners.get(this);
      const before = snapshotStatus(this.status());
      const status = origAdvance.call(this, budget);
      const after = snapshotStatus(status)!;
      if (!sameStatus(before, after)) {
        self.routeCalls.push({
          seq: self.seq.next(), ts: self.now(), op: 'advance',
          ownerTaskId: binding?.taskId ?? null, delegationId: binding?.delegationId ?? status.delegationId,
          statusBefore: before, statusAfter: after,
        });
      }
      return status;
    };

    (WalkRouteExecutor.prototype as { onSample: OnSampleFn }).onSample = function (this: WalkRouteExecutor, sample: BodySample) {
      const binding = self.routeOwners.get(this);
      const frame = self.frame();
      const before = snapshotStatus(this.status());
      // 目标 loop owner 来自实例静态绑定；sourceOwner 只在同步 frameSink 回调内才可知，
      // 初始化直调如实标为 direct/null，不伪造成目标任务。
      const source: DeliveredSampleRecord['source'] = self.inFrameSink ? 'frameSink' : 'direct';
      const sourceOwnerTaskId = self.inFrameSink ? self.frameSinkSourceOwner : null;
      const status = origOnSample.call(this, sample);
      const after = snapshotStatus(status)!;
      self.deliveredSamples.push({
        seq: self.seq.next(), ts: self.now(), frame, ownerTaskId: binding?.taskId ?? null,
        delegationId: binding?.delegationId ?? after.delegationId, source, sourceOwnerTaskId,
        sample: cloneSample(sample), statusBefore: before ?? after, statusAfter: after,
      });
      return status;
    };

    (WalkMoveExecutor.prototype as { setFrameSink: SetFrameSinkFn }).setFrameSink = function (this: WalkMoveExecutor, fn: Parameters<WalkMoveExecutor['setFrameSink']>[0]) {
      const owner = self.owner();
      self.moveOwners.set(this, { taskId: owner });
      self.bindings.push({ seq: self.seq.next(), ts: self.now(), ownerTaskId: owner, kind: 'frameSink' });
      // 窄同步上下文包装：原 fn 的参数/返回/this 原样保留，finally 还原来源上下文。
      const wrapped = function (this: unknown, ...args: Parameters<typeof fn>) {
        const prevSourceOwner = self.frameSinkSourceOwner;
        const prevInFrameSink = self.inFrameSink;
        self.frameSinkSourceOwner = owner;
        self.inFrameSink = true;
        try {
          return fn.apply(this as never, args);
        } finally {
          self.frameSinkSourceOwner = prevSourceOwner;
          self.inFrameSink = prevInFrameSink;
        }
      };
      return origSetFrameSink.call(this, wrapped);
    };

    (WalkMoveExecutor.prototype as { move: MoveFn }).move = function (this: WalkMoveExecutor, request: ExecutableMove) {
      const delegationId = segmentDelegationId(request.executionId);
      // 归属只取本实例真实的 setFrameSink 创建绑定；delegationId 是实例内递增的
      // `walk-<generation>`，全局 Map 会被同名任务覆盖，不能用来猜缺失的 owner。
      const instanceOwner = self.moveOwners.get(this)?.taskId ?? null;
      self.moves.push({
        seq: self.seq.next(), ts: self.now(),
        taskId: instanceOwner,
        delegationId,
        executionId: request.executionId,
        from: { ...request.from },
        to: { ...request.to },
        deadlineMs: request.deadlineMs,
        timeoutMs: request.timeoutMs,
        signalAborted: request.signal.aborted,
      });
      return origMove.call(this, request);
    };

    // 实际 Vision 实例：只按原 this/args 透传，记录真实输入与输出；finally 在 unwrap 还原。
    const vision = this.capture.vision;
    if (vision) {
      const origObserveBlocks = vision.observeBlocks;
      this.origObserveBlocks = origObserveBlocks;
      vision.observeBlocks = function (this: Vision, positions: Parameters<Vision['observeBlocks']>[0]) {
        const self2 = self;
        const seq = self2.seq.next();
        const ts = self2.now();
        const frame = self2.frame();
        const eye = self2.capture.eye?.() ?? null;
        const copied = positions.map((p) => ({ x: p.x, y: p.y, z: p.z }));
        const output = origObserveBlocks.call(this, positions);
        const visionId = self2.nextVisionId += 1;
        self2.visionCalls.push({
          seq, ts, frame, visionId, positions: copied, eye,
          payload: output.map((b) => ({ ...b, pos: { ...b.pos }, properties: { ...b.properties } })),
          output: output.map((b) => ({
            pos: { ...b.pos }, name: b.name, properties: { ...b.properties },
            stateComplete: b.stateComplete ?? null,
            worldId: b.worldId, sessionId: b.sessionId, dimension: b.dimension,
            observedAt: b.observedAt, observationId: b.observationId,
          })),
        });
        return output;
      };
    }

    // 实际 VoxelMap.observeBatch：完全透传返回对象；同一返回对象用 WeakMap 编号，
    // 供 loop.observe 侧确认是同一个 ChangeReport，而不是内容相同的另一份对象。
    (VoxelMap.prototype as { observeBatch: ObserveBatchFn }).observeBatch = function (this: VoxelMap, batch: ObservationBatch) {
      const seq = self.seq.next();
      const ts = self.now();
      const frame = self.frame();
      const mapId = self.idForMap(this);
      const report = origObserveBatch.call(this, batch);
      const reportId = self.idForReport(report);
      self.mapReports.add(report);
      self.mapBatches.push({
        seq, ts, frame, mapId, mapWorldId: this.worldId, map: this,
        observations: batch.observations.map((o) => ({ ...o, pos: { ...o.pos }, state: { name: o.state.name, properties: { ...o.state.properties } } })),
        unobserved: batch.unobserved.map((u) => ({ ...u, pos: { ...u.pos } })),
        reportId, report,
      });
      return report;
    };

    (WalkRouteExecutor.prototype as { observe: LoopObserveFn }).observe = function (this: WalkRouteExecutor, report: ChangeReport, budget: number) {
      const binding = self.routeOwners.get(this);
      const enterSeq = self.seq.next();
      const tsEnter = self.now();
      const frameEnter = self.frame();
      const statusBefore = snapshotStatus(this.status());
      const keysBefore = self.keys();
      // 每个真实入参对象都分配稳定编号；同一对象重复进入保持同一编号，内容相同的新对象不同。
      const reportId = self.idForReport(report);
      // 只有实际 observeBatch 返回过的同一对象才算 mapBatch/Vision 链路；生命周期报告在这里明确为 unmatched。
      const mapBatchMatched = self.mapReports.has(report);
      const status = origLoopObserve.call(this, report, budget);
      const tsExit = self.now();
      const exitSeq = self.seq.next();
      const after = snapshotStatus(status)!;
      self.observes.push({
        enterSeq, exitSeq, tsEnter, tsExit, frameEnter, frameExit: self.frame(),
        ownerTaskId: binding?.taskId ?? null,
        delegationId: binding?.delegationId ?? after.delegationId,
        reportId, report, mapBatchMatched, reportSource: mapBatchMatched ? 'mapBatch' : 'unmatched',
        statusBefore, statusAfter: after, keysBefore, keysAfter: self.keys(),
      });
      return status;
    };
  }

  unwrap() {
    if (!this.wrapped) return;
    if (this.origMove) (WalkMoveExecutor.prototype as { move: MoveFn }).move = this.origMove;
    if (this.origOnSample) (WalkRouteExecutor.prototype as { onSample: OnSampleFn }).onSample = this.origOnSample;
    if (this.origStart) (WalkRouteExecutor.prototype as { start: StartFn }).start = this.origStart;
    if (this.origAdvance) (WalkRouteExecutor.prototype as { advance: AdvanceFn }).advance = this.origAdvance;
    if (this.origSetFrameSink) (WalkMoveExecutor.prototype as { setFrameSink: SetFrameSinkFn }).setFrameSink = this.origSetFrameSink;
    if (this.origObserveBatch) (VoxelMap.prototype as { observeBatch: ObserveBatchFn }).observeBatch = this.origObserveBatch;
    if (this.origLoopObserve) (WalkRouteExecutor.prototype as { observe: LoopObserveFn }).observe = this.origLoopObserve;
    if (this.origObserveBlocks && this.capture.vision) this.capture.vision.observeBlocks = this.origObserveBlocks;
    this.origMove = undefined;
    this.origOnSample = undefined;
    this.origStart = undefined;
    this.origAdvance = undefined;
    this.origSetFrameSink = undefined;
    this.origObserveBatch = undefined;
    this.origLoopObserve = undefined;
    this.origObserveBlocks = undefined;
    this.wrapped = false;
  }
}

/** 剔除外部的临时 VoxelMap 引用，只保留批次公开输入、真实报告对象与编号。 */
export function mapBatchForEvidence(batch: MapBatchRecord): StoredMapBatchRecord {
  return {
    seq: batch.seq,
    ts: batch.ts,
    frame: batch.frame,
    mapId: batch.mapId,
    mapWorldId: batch.mapWorldId,
    observations: batch.observations,
    unobserved: batch.unobserved,
    reportId: batch.reportId,
    report: batch.report,
  };
}

function snapshotRoute(route: RouteStatus | null | undefined): RouteStateSnapshot | null {
  if (!route) return null;
  return {
    stepCount: route.stepCount,
    complete: route.complete,
    verdict: route.verdict,
    openPrefix: route.openPrefix,
    verifiedStepIndexes: [...route.verifiedStepIndexes],
    pendingStepIndexes: [...route.pendingStepIndexes],
    invalidatedCount: route.invalidatedCount,
    earliestProblem: route.earliestProblem === null ? null : {
      stepIndex: route.earliestProblem.stepIndex,
      status: route.earliestProblem.status,
      problemKind: route.earliestProblem.problem?.kind ?? null,
    },
    steps: route.steps.map((step) => step.kind === 'verified'
      ? { kind: 'verified' as const, status: step.result.status, problemKind: step.result.problem?.kind ?? null }
      : { kind: 'pending' as const, reason: step.reason }),
  };
}

function snapshotStatus(status: WalkRouteStatus | null): RouteStatusSnapshot | null {
  if (status === null) return null;
  return {
    worldId: status.worldId,
    dim: status.dim,
    sessionId: status.sessionId,
    delegationId: status.delegationId,
    nextPointIndex: status.nextPointIndex,
    activeStepIndex: status.activeStepIndex,
    lastPosition: status.lastPosition ? { ...status.lastPosition } : null,
    result: status.result,
    route: snapshotRoute(status.route),
  };
}

function sameStatus(a: RouteStatusSnapshot | null, b: RouteStatusSnapshot | null): boolean {
  return !!a && !!b && a.worldId === b.worldId && a.dim === b.dim && a.sessionId === b.sessionId
    && a.delegationId === b.delegationId
    && a.nextPointIndex === b.nextPointIndex
    && a.activeStepIndex === b.activeStepIndex
    && (a.result?.outcome ?? null) === (b.result?.outcome ?? null)
    && vecEqual(a.lastPosition, b.lastPosition)
    && JSON.stringify(a.route) === JSON.stringify(b.route);
}

function cloneSample(sample: BodySample): BodySample {
  return {
    ...sample,
    pos: { ...sample.pos },
    ...(sample.velocity === undefined ? {} : { velocity: { ...sample.velocity } }),
  };
}

function segmentDelegationId(executionId: string): string | null {
  const idx = executionId.lastIndexOf('-step-');
  return idx > 0 ? executionId.slice(0, idx) : null;
}

class FrameRecorder {
  frames: FrameRecord[] = [];
  truncated = false;
  private seq = 0;
  private lastTs: number | null = null;
  private readonly onTick = () => this.capture();

  constructor(private readonly bot: Bot, private readonly owner: () => string | null) {}

  private capture() {
    const now = Date.now();
    const e = this.bot.entity;
    if (!e) return;
    const dtMs = this.lastTs === null ? 0 : now - this.lastTs;
    this.lastTs = now;
    this.frames.push({
      seq: this.seq++, ts: now, dtMs,
      x: e.position.x, y: e.position.y, z: e.position.z,
      vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z,
      onGround: e.onGround, inWater: (e as { isInWater?: boolean }).isInWater === true,
      keys: snapshotKeys(this.bot),
      ownerTaskId: this.owner(),
      worldAgeTicks: typeof this.bot.time?.age === 'number' ? this.bot.time.age : null,
    });
  }

  start() { this.bot.on('physicsTick', this.onTick); }
  stop() { this.bot.removeListener('physicsTick', this.onTick); }
}

class ServerCorrectionRecorder {
  corrections: ServerCorrection[] = [];
  private readonly onForced = () => {
    const e = this.bot.entity;
    this.corrections.push({ ts: Date.now(), kind: 'forcedMove', x: e?.position.x, y: e?.position.y, z: e?.position.z });
  };

  constructor(private readonly bot: Bot) {}

  start() { this.bot.on('forcedMove', this.onForced); }
  stop() { this.bot.removeListener('forcedMove', this.onForced); }
}

/** 从 SkillResult.data 取出完整 NavResult（公开类型），不手工挑选字段拼子集。 */
function navFromResult(result: SkillResult): NavResult | undefined {
  const nav = result.data?.nav;
  if (nav === null || typeof nav !== 'object' || Array.isArray(nav)) return undefined;
  if (!('outcome' in nav)) return undefined;
  return nav as NavResult;
}

/** 完整记录 TaskOutcome（完整 TaskInfo + 完整 SkillResult + duration）。 */
function toDoneRecord(o: TaskOutcome): TaskDoneRecord {
  return {
    task: o.task,
    result: o.result,
    durationMs: o.durationMs,
    preemptedBy: o.preemptedBy,
    gentle: o.gentle,
    doneAt: Date.now(),
  };
}

/** ARRIVED+confirmed、横向 <=0.12、脚高 <=0.05、最终观测着地且干燥。 */
function assertArrivedAt(nav: NavResult | undefined, target: Vec3, feetY: number, label: string) {
  if (!isArrived(nav)) throw new Error(`${label} 未确认到达：outcome=${nav?.outcome} confirmed=${nav?.confirmed}`);
  const pos = nav.lastPosition;
  if (!pos) throw new Error(`${label} ARRIVED 缺少 lastPosition`);
  const horizontalError = dist2(pos, target);
  const feetError = Math.abs(pos.y - feetY);
  if (horizontalError > 0.12 || feetError > 0.05) {
    throw new Error(`${label} 到达但超容差：横向 ${horizontalError.toFixed(3)} (>0.12) 脚高 ${feetError.toFixed(3)} (>0.05)`);
  }
  const obs = nav.lastObservation;
  if (!obs) throw new Error(`${label} ARRIVED 缺少 lastObservation`);
  if (!obs.onGround) throw new Error(`${label} 最终观测未着地`);
  if (obs.inWater !== false) throw new Error(`${label} 最终观测不干燥：inWater=${String(obs.inWater)}`);
  return { horizontalError, feetError, obs, pos };
}

/**
 * 用最终 NavResult 的 trace/lastObservation 证明最后一次到达来自原始测量：
 * 观测时间/scope/位置与实测完成点一致，trace 条数等于真实到达次数。
 */
function assertArrivalProvenance(nav: NavResult, completions: MeasuredCompletion[], label: string) {
  const last = completions[completions.length - 1];
  if (!last) throw new Error(`${label} 无实测完成点`);
  if (nav.trace.length !== completions.length) throw new Error(`${label} trace 条数 ${nav.trace.length} != 实测到达 ${completions.length}`);
  const traceTail = nav.trace[nav.trace.length - 1];
  if (!traceTail || !vecEqual(traceTail.pos, last.pos) || traceTail.ts !== last.observedAt) {
    throw new Error(`${label} trace 末项与最后实测完成点不一致`);
  }
  const obs = nav.lastObservation;
  if (!obs) throw new Error(`${label} 缺少 lastObservation`);
  const raw = last.sample.sample;
  if (obs.observedAt !== raw.observedAt) throw new Error(`${label} lastObservation.observedAt 非原始测量时间`);
  if (obs.worldId !== raw.worldId || obs.dim !== raw.dim || obs.sessionId !== raw.sessionId) {
    throw new Error(`${label} lastObservation scope 与原始测量不一致`);
  }
}

/**
 * 用最近 body/context 归属找到该任务的终态生产 stopAll，并要求其 before/after 与最终键
 * 全部 false：证明 body 在 stopAll 之前已经释放全部 7 键，而不是靠 stopAll 掩盖残留。
 * 该归属只用于定位上下文，不作为「stopAll 由本任务调用」的证据。
 */
function assertProductionRelease(stopAlls: StopAllRecord[], taskId: string, finalKeys: Keys, label: string): StopAllRecord {
  // 这里只能按「最近的 body 拥有者」定位上下文记录，不能把它当成 stopAll 调用者归属。
  const record = [...stopAlls].reverse().find((s) => s.kind === 'production' && s.recentBodyOwnerTaskId === taskId);
  if (!record) throw new Error(`${label} 未捕获最近 body 归属 ${taskId} 的生产 stopAll`);
  if (!allKeysReleased(record.keysBefore)) throw new Error(`${label} stopAll 之前存在未释放键：${JSON.stringify(record.keysBefore)}`);
  if (!allKeysReleased(record.keysAfter)) throw new Error(`${label} stopAll 之后仍存在未释放键：${JSON.stringify(record.keysAfter)}`);
  if (!allKeysReleased(finalKeys)) throw new Error(`${label} 最终仍存在未释放键：${JSON.stringify(finalKeys)}`);
  return record;
}

// ---------------------------------------------------------------------------
// 元数据与证据落盘
// ---------------------------------------------------------------------------

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha512Base64(buf: Buffer): string {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

/** tgz 字节与 package-lock integrity（sha512-…）是否一致。 */
export function integrityMatches(buf: Buffer, integrity: string): boolean {
  const m = /^sha512-(.+)$/.exec(integrity.trim());
  if (!m) return false;
  return sha512Base64(buf) === m[1];
}

/** Git 元数据：用 `--porcelain=v1 -z` 解析脏路径，保留前导空格、仅按 NUL 分条。 */
export function gitMeta() {
  const run = (args: string[]) => execFileSync('git', args, { cwd: path.resolve('.'), encoding: 'utf8' });
  const sha = run(['rev-parse', 'HEAD']).trim();
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirtyPaths = gitPorcelainPaths(run(['status', '--porcelain=v1', '-z']));
  return { sha, branch, dirtyPaths, scriptFingerprint: sha256File(fileURLToPath(import.meta.url)) };
}

interface PackageMetaOptions {
  /** 根目录（含 package.json / package-lock.json / node_modules / vendor）。默认当前目录。 */
  base?: string;
}

/** 固定期望包名：package.json 键、已安装包与 provenance 都必须是这个名字。 */
const EXPECTED_PACKAGE_NAME = 'curio-minecraft-3d-memory';

/**
 * 源元数据校验：读实际 package.json 依赖声明、package-lock 条目（含 integrity）、
 * 已安装包与引用 tgz 的 SHA256/SHA512，并校验彼此对应；再读 provenance.json，
 * 交叉校验 artifactSHA256 / npmIntegrity / package name/version 与 sourceBinding 后报告 sourceHEAD。
 * 任一步缺失或不一致都抛错（fail source check），不用 unknown/missing 占位符掩盖。
 */
export function packageMeta(opts: PackageMetaOptions = {}) {
  const base = path.resolve(opts.base ?? '.');
  const root = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const dep = root.dependencies?.[EXPECTED_PACKAGE_NAME];
  if (typeof dep !== 'string' || !dep.startsWith('file:')) {
    throw new Error(`package.json 对 ${EXPECTED_PACKAGE_NAME} 的依赖必须是 file: 规格：${JSON.stringify(dep)}`);
  }
  const tgzRel = dep.slice('file:'.length);
  if (tgzRel.length === 0) throw new Error(`package.json 对 ${EXPECTED_PACKAGE_NAME} 的 file: 依赖缺少路径`);
  const tgzPath = path.resolve(base, tgzRel);
  const tgzBytes = fs.readFileSync(tgzPath);
  const tgzSha256 = crypto.createHash('sha256').update(tgzBytes).digest('hex');

  const installed = JSON.parse(fs.readFileSync(path.join(base, 'node_modules', EXPECTED_PACKAGE_NAME, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (installed.name !== EXPECTED_PACKAGE_NAME) throw new Error(`已安装包名 ${installed.name ?? '(missing)'} 与固定期望包名 ${EXPECTED_PACKAGE_NAME} 不一致`);
  if (typeof installed.version !== 'string' || installed.version.length === 0) throw new Error('已安装包缺少版本');

  const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
  };
  const rootLockDep = lock.packages?.['']?.dependencies?.[EXPECTED_PACKAGE_NAME];
  if (rootLockDep !== dep) throw new Error(`package-lock root packages[''].dependencies 与 manifest 不一致：lock ${rootLockDep} vs manifest ${dep}`);
  const lockEntry = lock.packages?.[`node_modules/${EXPECTED_PACKAGE_NAME}`];
  if (!lockEntry) throw new Error(`package-lock.json 缺少 node_modules/${EXPECTED_PACKAGE_NAME} 条目`);
  if (lockEntry.name !== undefined && lockEntry.name !== EXPECTED_PACKAGE_NAME) throw new Error(`lock 包名 ${lockEntry.name} 与固定期望包名 ${EXPECTED_PACKAGE_NAME} 不一致`);
  if (lockEntry.version !== installed.version) throw new Error(`版本不一致：lock ${lockEntry.version} vs installed ${installed.version}`);
  if (lockEntry.resolved !== dep) throw new Error(`依赖声明 ${dep} 与 lock resolved ${lockEntry.resolved} 不一致`);
  if (!lockEntry.integrity) throw new Error(`package-lock 缺少 ${EXPECTED_PACKAGE_NAME} 的 integrity`);
  if (!integrityMatches(tgzBytes, lockEntry.integrity)) throw new Error('tgz 字节与 package-lock integrity（sha512）不一致');

  // provenance.json：与已安装版本对应的本地来源声明。
  const provenanceRel = path.join('vendor', `${EXPECTED_PACKAGE_NAME}-${installed.version}.provenance.json`);
  const provenancePath = path.resolve(base, provenanceRel);
  if (!fs.existsSync(provenancePath)) throw new Error(`缺少来源声明：${provenanceRel}`);
  const prov = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
    package?: { name?: string; version?: string };
    sourceHEAD?: string;
    artifactSHA256?: string;
    npmIntegrity?: string;
    sourceBinding?: { clean?: boolean; head?: string };
  };
  if (prov.package?.name !== EXPECTED_PACKAGE_NAME) throw new Error(`provenance 包名 ${prov.package?.name} 与固定期望包名 ${EXPECTED_PACKAGE_NAME} 不一致`);
  if (prov.package?.version !== installed.version) throw new Error(`provenance 版本 ${prov.package?.version} 与 installed ${installed.version} 不一致`);
  if (prov.artifactSHA256 !== tgzSha256) throw new Error('provenance artifactSHA256 与 tgz SHA256 不一致');
  if (prov.npmIntegrity !== lockEntry.integrity) throw new Error('provenance npmIntegrity 与 lock integrity 不一致');
  if (typeof prov.sourceHEAD !== 'string' || !/^[0-9a-f]{40}$/.test(prov.sourceHEAD)) throw new Error('provenance 缺少合法 sourceHEAD');
  if (prov.sourceBinding?.clean !== true) throw new Error('provenance sourceBinding.clean 必须为 true');
  if (prov.sourceBinding?.head !== prov.sourceHEAD) throw new Error('provenance sourceBinding.head 与 sourceHEAD 不一致');

  return {
    name: installed.name,
    version: installed.version,
    dependencySpec: dep,
    lockVersion: lockEntry.version,
    lockResolved: lockEntry.resolved,
    lockIntegrity: lockEntry.integrity,
    tgzPath,
    tgzSha256,
    sourceHEAD: prov.sourceHEAD,
    sourceBindingClean: prov.sourceBinding.clean,
  };
}

// ---------------------------------------------------------------------------
// 任务追踪：done 一触发即记录终态（每次 taskId 一次），不因后续断言/等待丢失
// ---------------------------------------------------------------------------

export class TaskTracker {
  readonly starts: TaskStartRecord[] = [];
  readonly outcomes: TaskDoneRecord[] = [];
  private entries = new Map<string, { promise: Promise<TaskOutcome>; resolve: (o: TaskOutcome) => void; settled: boolean }>();
  private readonly arbiter: Pick<Arbiter, 'on' | 'removeListener'>;
  private readonly onDone = (o: TaskOutcome) => {
    const e = this.entries.get(o.task.id);
    if (!e || e.settled) return;
    // done 可能在后续位移断言之前异步到达：立即保存完整 TaskOutcome，只保存一次。
    this.outcomes.push(toDoneRecord(o));
    e.settled = true;
    e.resolve(o);
  };

  constructor(arbiter: Arbiter) {
    this.arbiter = arbiter;
    arbiter.on('done', this.onDone);
  }

  register(task: TaskInfo, request: TaskStartRecord['request'], scope: TaskStartRecord['scope']): Promise<TaskOutcome> {
    this.starts.push({ task, request, scope, registeredAt: Date.now() });
    let resolve!: (o: TaskOutcome) => void;
    const promise = new Promise<TaskOutcome>((r) => { resolve = r; });
    this.entries.set(task.id, { promise, resolve, settled: false });
    return promise;
  }

  /** 所有已登记任务是否都已触发 done。 */
  settled(): boolean {
    return [...this.entries.values()].every((e) => e.settled);
  }

  /** 有界等待所有已登记任务 done；超时返回 false（视为清理失败）。 */
  async settle(timeoutMs: number): Promise<boolean> {
    const promises = [...this.entries.values()].map((e) => e.promise);
    if (promises.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const all = Promise.all(promises).then(() => true);
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  dispose() {
    this.arbiter.removeListener('done', this.onDone);
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// 连接生命周期追踪：quitClient 判断「已观测到的断线」，避免等一个过去的事件
// ---------------------------------------------------------------------------

/** 只依赖公开事件追踪「连接是否已结束」；connected=false 不能证明已关闭（连接中也为 false）。 */
export class ConnectionTracker {
  private endedAt: number | null = null;
  private spawnedAt: number | null = null;
  private readonly onDisconnected = () => { this.endedAt = Date.now(); this.spawnedAt = null; };
  private readonly onSpawn = () => { this.spawnedAt = Date.now(); this.endedAt = null; };

  constructor(private readonly adapter: { on: (e: string, fn: () => void) => void; removeListener: (e: string, fn: () => void) => void }) {
    adapter.on('disconnected', this.onDisconnected);
    adapter.on('spawn', this.onSpawn);
  }

  /** 已观测到断线且其后未再 spawn。 */
  alreadyEnded(): boolean {
    return this.endedAt !== null && this.spawnedAt === null;
  }

  dispose() {
    this.adapter.removeListener('disconnected', this.onDisconnected);
    this.adapter.removeListener('spawn', this.onSpawn);
  }
}

export interface QuitResult { ended: boolean; reason: string }

/** 有界等待自己的 Bot 客户端真正结束；缺真实 end（超时）返回 ended=false 而非静默成功。 */
export function quitClient(
  adapter: { bot: { quit: () => void } | null; quit: () => void; on: (e: string, fn: (reason: string) => void) => void; removeListener: (e: string, fn: (reason: string) => void) => void },
  tracker: ConnectionTracker,
  timeoutMs: number,
): Promise<QuitResult> {
  return new Promise((resolve) => {
    if (!adapter.bot) { resolve({ ended: true, reason: 'no bot' }); return; }
    if (tracker.alreadyEnded()) { resolve({ ended: true, reason: 'already-observed end' }); return; }
    let settled = false;
    const finish = (ended: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      adapter.removeListener('disconnected', onDisconnected);
      resolve({ ended, reason });
    };
    const onDisconnected = (reason: string) => finish(true, `disconnected: ${reason}`);
    const timer = setTimeout(() => finish(false, 'no end observed within deadline'), timeoutMs);
    adapter.on('disconnected', onDisconnected);
    adapter.quit();
  });
}

/** 关停证据：分类、结构化诊断与调用/等待错误各自保留，任一失败都不得算作已关停。 */
export interface SpatialShutdownRecord {
  ok: boolean;
  problems: string[];
  diagnostics: SpatialShutdownDiagnostics | null;
  serviceCallError: ErrorFacts | null;
  serviceAwaitError: ErrorFacts | null;
}

/**
 * 汇总真实 SharedSpatialSession.shutdown 结果。shutdown 调用抛错或 promise 拒绝时
 * 没有可信的 checkpoint/close 结果，只能如实记为未确认；只有分类通过、最终
 * checkpoint 被 close 确认，且调用/等待都没有错误时才 ok。
 */
export function spatialShutdownRecord(
  result: ShutdownResult | null,
  serviceCallError: unknown,
  serviceAwaitError: unknown,
  expectedWorldId: string,
): SpatialShutdownRecord {
  const callError = serviceCallError === null ? null : errorFacts(serviceCallError);
  const awaitError = serviceAwaitError === null ? null : errorFacts(serviceAwaitError);
  const classification = result === null ? null : classifySpatialShutdown(result, expectedWorldId);
  const problems = classification === null ? ['shutdown_result_missing'] : [...classification.problems];
  if (callError !== null) problems.push('shutdown_call_error');
  if (awaitError !== null) problems.push('shutdown_await_error');
  return {
    ok: classification !== null && classification.ok && callError === null && awaitError === null,
    problems,
    diagnostics: result === null ? null : spatialShutdownDiagnostics(result, expectedWorldId),
    serviceCallError: callError,
    serviceAwaitError: awaitError,
  };
}

export interface HarnessContext {
  bot: Bot;
  adapter: MineflayerAdapter;
  arbiter: Arbiter;
  /** main 创建并交给生产的同一个真实 Vision 实例；不另造替身。 */
  vision: Vision;
  /** 与 Vision/Arbiter 注入的同一个共享空间会话，供后续阶段复用。 */
  spatial: SharedSpatialSession;
  rcon: Rcon;
  evidenceDir: string;
  runId: string;
}

interface ScenarioDiag {
  recorder: FrameRecorder;
  corrections: ServerCorrectionRecorder;
  diag: WalkDiagnostics;
  exec: ExecutionDiagnostics;
  tasks: TaskTracker;
  seq: EventSeq;
  ev: ScenarioEvidence;
}

function markTimeline(d: ScenarioDiag, label: string, taskId: string | null): number {
  const seq = d.seq.next();
  d.ev.marks.push({ seq, ts: Date.now(), label, taskId });
  return seq;
}

// ---------------------------------------------------------------------------
// RCON 预检与夹具
// ---------------------------------------------------------------------------

async function rconPreflight(rcon: Rcon, expected: Set<string>): Promise<{ ok: boolean; raw: string; occupants: string[]; duplicateBot: boolean; unexpected: string[] }> {
  const raw = await rcon.send('list');
  const occupants = parseRconList(raw);
  const duplicateBot = occupants.filter((o) => o === config.mc.username).length > 0;
  const unexpected = occupants.filter((o) => !expected.has(o));
  return { ok: !duplicateBot && unexpected.length === 0, raw, occupants, duplicateBot, unexpected };
}

/** 记录一条 RCON 命令与响应（命令与响应都落盘，不只响应）。 */
export interface RconOp { command: string; response: string }

export type BlockProbeState = 'air' | 'cave_air' | 'void_air' | 'material' | 'unknown';

/** air / cave_air / void_air 都是合法空格；material 与 unknown 才是真实占用。 */
export function isEmptyBlockState(state: BlockProbeState): boolean {
  return state === 'air' || state === 'cave_air' || state === 'void_air';
}

/** 严格解析 Java `execute if block` 的反馈：只有 Test passed / Test failed 合法。 */
export function parseExecuteIfBlock(raw: string): 'match' | 'mismatch' {
  const text = raw.trim();
  if (text === 'Test passed') return 'match';
  if (text === 'Test failed') return 'mismatch';
  throw new Error(`execute if block 响应无法解析：${JSON.stringify(raw)}`);
}

/** 严格解析 Java `setblock` 的成功反馈（1.20 语言文件：`Changed the block at %s, %s, %s`）。 */
export function parseSetBlock(raw: string): void {
  if (!/^Changed the block at -?\d+, -?\d+, -?\d+$/.test(raw.trim())) {
    throw new Error(`setblock 响应无法确认为成功：${JSON.stringify(raw)}`);
  }
}

/**
 * 用真实 Java 1.20.1 支持的 `execute if block` 精确判定格子状态：
 * 依次检查 minecraft:air / cave_air / void_air / 指定材料，全部不匹配则为 unknown。
 * 每条命令与响应都通过 send 记录（调用方在尝试时落盘）。
 */
export async function probeBlock(
  send: (command: string) => Promise<string>,
  pos: { x: number; y: number; z: number },
  material: string,
): Promise<BlockProbeState> {
  const candidates: Array<{ block: string; state: BlockProbeState }> = [
    { block: 'minecraft:air', state: 'air' },
    { block: 'minecraft:cave_air', state: 'cave_air' },
    { block: 'minecraft:void_air', state: 'void_air' },
    { block: material, state: 'material' },
  ];
  for (const candidate of candidates) {
    const command = `execute if block ${pos.x} ${pos.y} ${pos.z} ${candidate.block}`;
    if (parseExecuteIfBlock(await send(command)) === 'match') return candidate.state;
  }
  return 'unknown';
}

/** 夹具/启动前准备只需要可写入 extra 的证据容器，不要求完整 ScenarioEvidence。 */
interface FixtureEvidence { extra?: Record<string, unknown> }

/**
 * 在限定范围内搭建支撑面：先逐格确认支撑格（feetY-1）与净空格（feetY/feetY+1）。
 * 支撑格接受同材料（同 run 或旧 run 遗留）或任意合法空格（air/cave_air/void_air，此时补建）；
 * 净空格接受任意合法空格。未知材料或真实占用一律中止，不覆写。
 * 所有控制端命令与响应在尝试时立即写入本场景证据，中途失败也保留。
 */
async function buildSupportFixture(
  rcon: Rcon,
  ev: FixtureEvidence,
  footprint: { xMin: number; xMax: number; zMin: number; zMax: number },
  feetY: number,
  material: string,
): Promise<void> {
  const extra = (ev.extra ??= {});
  const ops = (extra.fixtureOps ??= []) as RconOp[];
  const send = async (command: string) => {
    const response = await rcon.send(command);
    ops.push({ command, response });
    return response;
  };

  // 第一阶段：只检查，不写入；未知/占用时保持现场原样。
  const toBuild: Array<{ x: number; z: number }> = [];
  let reused = 0;
  for (let x = footprint.xMin; x <= footprint.xMax; x++) {
    for (let z = footprint.zMin; z <= footprint.zMax; z++) {
      const support = await probeBlock(send, { x, y: feetY - 1, z }, material);
      if (isEmptyBlockState(support)) toBuild.push({ x, z });
      else if (support === 'material') reused++;
      else {
        throw new Error(`支撑格状态不可复用（x=${x} y=${feetY - 1} z=${z} → ${support}），中止且不覆写`);
      }
      for (const y of [feetY, feetY + 1]) {
        const clear = await probeBlock(send, { x, y, z }, material);
        if (!isEmptyBlockState(clear)) {
          throw new Error(`净空格被占用（x=${x} y=${y} z=${z} → ${clear}），中止且不覆写`);
        }
      }
    }
  }

  // 第二阶段：只补建确认为 air 的支撑格。
  for (const { x, z } of toBuild) {
    const command = `setblock ${x} ${feetY - 1} ${z} ${material}`;
    parseSetBlock(await send(command));
  }
  extra.fixture = { footprint, feetY, material, reused, built: toBuild.length };
}

async function teleportTo(rcon: Rcon, bot: Bot, pos: { x: number; y: number; z: number }): Promise<string> {
  return rcon.send(`tp ${bot.username} ${pos.x} ${pos.y} ${pos.z}`);
}

/** 把 Bot 传送到指定脚位并等其落地（分数坐标，记录操作）。 */
async function teleportAndSettle(ctx: HarnessContext, ev: FixtureEvidence, pos: { x: number; y: number; z: number }, label: string): Promise<void> {
  const op = await teleportTo(ctx.rcon, ctx.bot, pos);
  const extra = (ev.extra ??= {}) as Record<string, unknown>;
  extra.teleports = [...((extra.teleports as unknown[]) ?? []), { label, pos, rconOp: op }];
  await waitFor(() => {
    const st = ctx.adapter.state();
    return st.observationReady && Math.abs(st.pos.y - pos.y) < 0.1 && Math.abs(st.pos.x - pos.x) < 0.5 && Math.abs(st.pos.z - pos.z) < 0.5 && st.onGround;
  }, 20_000, `${label} 落到指定点`);
}

// ---------------------------------------------------------------------------
// 场景运行器外壳
// ---------------------------------------------------------------------------

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`超时：${label}`)); }
    }, 50);
  });
}

/** 短窗口前置（如去程仅数百毫秒）用 5ms 轮询，避免 50ms 轮询错过活动段。 */
function waitForPrecise(cond: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`超时：${label}`)); }
    }, 5);
  });
}

async function awaitOrTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超时：${label}`)), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function snapControl(ctx: HarnessContext, label: string, ev: ScenarioEvidence) {
  ev.controlSnapshots.push({ ts: Date.now(), label, keys: snapshotKeys(ctx.bot), ownerTaskId: ctx.arbiter.current?.id ?? null });
}

/** 从当前适配器状态取真实作用域（世界/维度/会话/存活/连接/观测就绪），不复制请求冒充观测。 */
function actualScope(ctx: HarnessContext): TaskStartRecord['scope'] {
  const s = ctx.adapter.state();
  return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
}

/** 启动 walk_route 任务：捕获完整请求与真实作用域，登记任务 promise。 */
function startWalkTask(
  ctx: HarnessContext,
  d: ScenarioDiag,
  points: Vec3Like[],
  deadlineMs: number,
): { task: TaskInfo; done: Promise<TaskOutcome> } | { error: string } {
  const scope = actualScope(ctx);
  const started = ctx.arbiter.start({ skill: 'walk_route', args: { points, deadlineMs } }, 'user');
  if (!started || 'error' in started) return { error: started && 'error' in started ? started.error : '未知' };
  const done = d.tasks.register(started, { points, deadlineMs }, scope);
  return { task: started, done };
}

/**
 * 有界等待本任务真实 walk_route.start 记录（真实启动在 adapter.look 预扫之后）。
 * 不能凭任意 sleep 猜测 ID：只接受 ownerTaskId 匹配且有 delegationId 的真实记录。
 * 任务若在 start 前结束，原样抛出完整 TaskOutcome，交由场景如实 FAIL。
 */
export async function awaitRouteStartRecord(
  routeCalls: RouteCallRecord[],
  taskId: string,
  done: Promise<TaskOutcome>,
  timeoutMs: number,
  label: string,
): Promise<{ startCall: RouteCallRecord; delegationId: string }> {
  let outcome: TaskOutcome | null = null;
  void done.then((o) => { outcome = o; });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const start = routeCalls.find((c) => c.op === 'start' && c.ownerTaskId === taskId && !!c.delegationId);
    if (start?.delegationId) return { startCall: start, delegationId: start.delegationId };
    if (outcome) throw new Error(`${label} 任务在真实 walk_route.start 前已结束：${JSON.stringify(outcome)}`);
    if (Date.now() >= deadline) throw new Error(`${label} 在 ${timeoutMs}ms 内未观察到本任务真实 walk_route.start`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function runScenario(
  ctx: HarnessContext,
  body: (d: ScenarioDiag) => Promise<void>,
): Promise<ScenarioEvidence> {
  const ev: ScenarioEvidence = {
    verdict: 'NOT_RUN', startedAt: Date.now(), taskStarts: [], results: [],
    frames: [], framesTruncated: false, controlAttempts: [], actualControls: [], controlSnapshots: [],
    stopAlls: [], ticks: [], routeCalls: [], deliveredSamples: [], visionCalls: [], mapBatches: [],
    observes: [], moves: [], bindings: [], marks: [], serverCorrections: [],
  };
  const seq = new EventSeq();
  const recorder = new FrameRecorder(ctx.bot, () => ctx.arbiter.current?.id ?? null);
  const corrections = new ServerCorrectionRecorder(ctx.bot);
  const diag = new WalkDiagnostics(ctx.adapter, () => ctx.arbiter.current?.id ?? null, () => snapshotKeys(ctx.bot), seq, ctx.bot);
  const exec = new ExecutionDiagnostics(seq, () => ctx.arbiter.current?.id ?? null, Date.now, {
    vision: ctx.vision,
    frame: () => recorder.frames.length,
    eye: () => ctx.adapter.eye(),
    readKeys: () => snapshotKeys(ctx.bot),
  });
  const tasks = new TaskTracker(ctx.arbiter);
  recorder.start();
  corrections.start();
  diag.wrap();
  exec.wrap();
  try {
    await body({ recorder, corrections, diag, exec, tasks, seq, ev });
    if (ev.verdict === 'NOT_RUN') ev.verdict = 'PASS';
  } catch (e) {
    ev.verdict = 'FAIL';
    ev.error = (e as Error)?.message ?? String(e);
  } finally {
    // 取消仍未结束的任务并等待所有登记任务 done；缺真实收尾即清理失败 → FAIL。
    try {
      const active = ctx.arbiter.info();
      if (active) {
        // 明确标记这是 harness 收尾取消；其嵌套 stopAll 可由该 eventSeq/时间/task 分辨，
        // 但此标记不参与 PASS 判定，也不替失败场景清键。
        ev.marks.push({ seq: seq.next(), ts: Date.now(), label: 'harness-cleanup-cancel', taskId: active.id });
        ctx.arbiter.cancel('场景收尾：取消未完成任务');
      }
      const settled = await tasks.settle(10_000);
      if (!settled) throw new Error('已登记任务未在期限内全部结束');
    } catch (ce) {
      ev.cleanupError = (ce as Error)?.message ?? String(ce);
      if (ev.verdict !== 'FAIL') ev.verdict = 'FAIL';
    }
    // 场景失败也要恢复宿主物理（W7 会关 physicsEnabled）。
    ctx.bot.physicsEnabled = true;
    ev.finishedAt = Date.now();
    ev.durationMs = ev.finishedAt - ev.startedAt;
    ev.frames = recorder.frames;
    ev.framesTruncated = recorder.truncated;
    ev.controlAttempts = diag.attempts;
    ev.actualControls = diag.actualControls;
    ev.stopAlls = diag.stopAlls;
    ev.ticks = diag.ticks;
    ev.routeCalls = exec.routeCalls;
    ev.deliveredSamples = exec.deliveredSamples;
    // 原始 Vision 输出、map 输入/报告与 observe 输入/输出在成功和失败路径都落盘；
    // mapBatches 只剔除临时 VoxelMap 引用，不复制/快照库内部状态。
    ev.visionCalls = exec.visionCalls;
    ev.mapBatches = exec.mapBatches.map((b) => ({
      ...mapBatchForEvidence(b),
      mapIsSessionVoxel: b.map === ctx.spatial.session.voxel,
    }));
    ev.observes = exec.observes;
    ev.moves = exec.moves;
    ev.bindings = [...diag.bindings, ...exec.bindings];
    ev.serverCorrections = corrections.corrections;
    ev.taskStarts = tasks.starts;
    ev.results = tasks.outcomes;
    recorder.stop();
    corrections.stop();
    diag.unwrap();
    exec.unwrap();
    tasks.dispose();
  }
  return ev;
}

// ---------------------------------------------------------------------------
// 场景实现
// ---------------------------------------------------------------------------

function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function sameCell(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** 取本 task/delegation 的最新公开状态（含 start/advance/onSample/observe 的真实快照）。 */
function latestRouteStatus(exec: ExecutionDiagnostics, taskId: string, delegationId: string): RouteStatusSnapshot | null {
  const rows: Array<{ seq: number; status: RouteStatusSnapshot }> = [
    ...exec.routeCalls.filter((c) => c.ownerTaskId === taskId && c.delegationId === delegationId).map((c) => ({ seq: c.seq, status: c.statusAfter })),
    ...exec.deliveredSamples.filter((s) => s.ownerTaskId === taskId && s.delegationId === delegationId).map((s) => ({ seq: s.seq, status: s.statusAfter })),
    ...exec.observes.filter((o) => o.ownerTaskId === taskId && o.delegationId === delegationId).map((o) => ({ seq: o.exitSeq, status: o.statusAfter })),
  ];
  return rows.sort((a, b) => b.seq - a.seq)[0]?.status ?? null;
}

/** 在某次实际 Vision 调用的输出中查找目标格。 */
function visionOutputAt(call: VisionCallRecord, pos: Vec3): VisionCallRecord['output'][number] | undefined {
  return call.output.find((b) => sameCell(b.pos, pos));
}

type VisionBlock = Pick<
  BlockObservation,
  'pos' | 'name' | 'properties' | 'worldId' | 'sessionId' | 'dimension' | 'observedAt' | 'observationId'
>;

/**
 * 生产 toObservation 用 `sequence = observationId` 连接本次 Vision 输出；
 * 不要求 originObservationId（真实输入未填），也不靠位置/时间近似猜。
 */
function observationMatchesVision(o: Observation, target: Vec3, v: VisionBlock): boolean {
  return sameCell(o.pos, target)
    && o.sequence === v.observationId
    && o.worldId === v.worldId
    && o.dim === v.dimension
    && o.sessionId === v.sessionId
    && o.observedAt === v.observedAt
    && o.state.name === v.name;
}

export interface SpatialWitnessPick {
  vision: VisionCallRecord;
  block: BlockObservation;
  batch: StoredMapBatchRecord;
  cell: CellEvidenceSnapshot;
}

function normalizedProperties(properties: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, String(v)]));
}

/**
 * S3 witness 只从真实 Vision 返回并原样保存的 typed payload 中选：该 payload 必须先被
 * 同一 svc.voxel 的 map 批次写入，且该格当前 cellAt 的 name/properties/time/sequence/scope
 * 与原 payload 一致。未真正入图的 payload 不可能入选；不从诊断投影重建。
 */
export function pickSpatialWitness(
  scenarios: ReadonlyArray<{ visionCalls: readonly VisionCallRecord[]; mapBatches: readonly StoredMapBatchRecord[] }>,
  voxel: VoxelMap,
): SpatialWitnessPick | null {
  const candidates = scenarios
    .flatMap((ev) => ev.visionCalls.flatMap((vision) => vision.payload.map((block) => ({ ev, vision, block }))))
    .sort((a, b) => b.vision.ts - a.vision.ts || b.vision.visionId - a.vision.visionId);
  for (const c of candidates) {
    const expectedProperties = normalizedProperties(c.block.properties);
    const batch = c.ev.mapBatches.find((b) => b.mapIsSessionVoxel === true
      && b.seq > c.vision.seq
      && b.observations.some((o) => observationMatchesVision(o, c.block.pos, c.block)
        && o.stateComplete === (c.block.stateComplete === true)
        && JSON.stringify(normalizedProperties(o.state.properties)) === JSON.stringify(expectedProperties)));
    if (!batch) continue;
    const cell = cellEvidenceSnapshot(voxel.cellAt(c.block.dimension, c.block.pos.x, c.block.pos.y, c.block.pos.z));
    if (!cell.observed || cell.sequence !== c.block.observationId || cell.observedAt !== c.block.observedAt
      || cell.sessionId !== c.block.sessionId || cell.name !== c.block.name
      || JSON.stringify(cell.properties ?? {}) !== JSON.stringify(expectedProperties)) continue;
    return { vision: c.vision, block: c.block, batch, cell };
  }
  return null;
}

/** ChangeReport 是否包含目标格的真实变化（单格 change，不是 section 共用 revision）。 */
function reportTouchesCell(report: ChangeReport, pos: Vec3): boolean {
  return report.sections.some((s) => s.cells.some((c) => sameCell(c.pos, pos)));
}

/** W1：同高三段相邻 X/Z 转弯，ARRIVED 且容差内，每段从实测终点严格接续。 */
async function scenarioW1(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const lane = WALK_LANE;
  ev.extra = { lane };
  await buildSupportFixture(ctx.rcon, ev, { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax }, lane.feetY, lane.material);
  await teleportAndSettle(ctx, ev, lane.start, 'W1 步行道起点');

  const y = lane.feetY;
  const route = [
    { x: lane.start.x, y, z: lane.start.z },
    { x: lane.start.x + 1, y, z: lane.start.z },
    { x: lane.start.x + 1, y, z: lane.start.z + 1 },
    { x: lane.start.x + 2, y, z: lane.start.z + 1 },
  ];
  const taskStartTs = Date.now();
  const deadlineMs = Date.now() + 30_000;
  const started = startWalkTask(ctx, d, route, deadlineMs);
  if ('error' in started) throw new Error(`W1 启动失败：${started.error}`);
  const o = await awaitOrTimeout(started.done, 60_000, 'W1 完成');
  if (o.result.status !== 'succeeded') throw new Error(`W1 未成功：status=${o.result.status} 摘要=${o.result.summary}`);
  const nav = navFromResult(o.result);
  const arrival = assertArrivedAt(nav, route[route.length - 1]!, y, 'W1');

  const taskId = started.task.id;
  const startCall = d.exec.routeCalls.find((c) => c.op === 'start' && c.ownerTaskId === taskId);
  if (!startCall?.delegationId) throw new Error('W1 未捕获本任务的真实 delegation 启动');
  const delegationId = startCall.delegationId;

  // 恰好 3 段本任务 move；0/1/2/额外段都 FAIL，每段身份/归属/from/to 完整。
  const segments = checkTaskSegments(d.exec.moves, delegationId, taskId, 3);
  if (!segments.ok) throw new Error(`W1 段集合不合法：${segments.reason}`);

  // 每段完成点必须来自公开 nextPointIndex 推进 + 该次原始测量；下一段 from 严格等于它。
  const completions = measuredCompletions(d.exec.deliveredSamples, taskId, delegationId);
  if (completions.length !== 3) throw new Error(`W1 实测到达完成点 ${completions.length} != 3`);
  if (!segmentsFollowMeasured(segments.segments, completions)) {
    throw new Error(`W1 段间未从实测完成点严格接续：${JSON.stringify(segments.segments.map((m) => ({ id: m.executionId, from: m.from, to: m.to })))}`);
  }
  assertArrivalProvenance(nav!, completions, 'W1');
  const release = assertProductionRelease(d.diag.stopAlls, taskId, snapshotKeys(ctx.bot), 'W1');

  ev.extra = {
    ...ev.extra,
    route, deadlineMs, taskStartTs, delegationId,
    horizontalError: Number(arrival.horizontalError.toFixed(3)), feetError: Number(arrival.feetError.toFixed(3)),
    onGroundAtArrival: arrival.obs.onGround, inWaterAtArrival: arrival.obs.inWater,
    segmentCount: segments.segments.length,
    segmentIds: segments.segments.map((m) => m.executionId),
    measuredCompletionPositions: completions.map((c) => c.pos),
    stopAllSeq: { before: release.seqBefore, after: release.seqAfter },
    acceptedSampleCount: acceptedMeasurements(d.exec.deliveredSamples, taskId, delegationId).length,
  };

  // ---- S1：A 结束后不 TP/不新 map/不关服务，沿 A 方向逆序追加真实 B 任务 ----
  const aLast = completions[completions.length - 1]!;
  const aBodyAtEnd = { ...ctx.adapter.state().pos };
  const s1: Record<string, unknown> = {
    status: 'RUNNING',
    a: {
      taskId, delegationId,
      route, lastCompletion: { ...aLast.pos },
      lastCompletionSample: { sequence: aLast.sampleSequence, observedAt: aLast.observedAt },
      bodyAtEnd: aBodyAtEnd,
      segmentIds: segments.segments.map((m) => m.executionId),
      stopAllSeq: { before: release.seqBefore, after: release.seqAfter },
    },
  };
  ev.extra = { ...ev.extra, s1 };
  ev.verdict = 'NOT_RUN';

  const persistence = ctx.spatial.getPersistenceState();
  s1.boundary = { lifecycle: persistence.lifecycle, closing: ctx.spatial.closing };
  if (persistence.lifecycle !== 'open' || ctx.spatial.closing) {
    throw new Error(`S1 A 结束/B 开始前共享服务不是 open：${persistence.lifecycle} closing=${ctx.spatial.closing}`);
  }

  // B 起点就是 A 实测末位原坐标；方向严格取 A 单位 delta 的逆序 -X/-Z/-X。
  const bY = aLast.pos.y;
  const bRoute = [
    { ...aLast.pos },
    { x: aLast.pos.x - 1, y: bY, z: aLast.pos.z },
    { x: aLast.pos.x - 1, y: bY, z: aLast.pos.z - 1 },
    { x: aLast.pos.x - 2, y: bY, z: aLast.pos.z - 1 },
  ];
  // B 首目标的 floor 支撑：A 必须已通过真实 Vision→同一 svc.voxel 的 map 观测过它。
  const witnessCell = {
    x: Math.floor(bRoute[1]!.x),
    y: Math.floor(bRoute[1]!.y) - 1,
    z: Math.floor(bRoute[1]!.z),
  };
  const aChain = (() => {
    for (let i = d.exec.visionCalls.length - 1; i >= 0; i--) {
      const vision = d.exec.visionCalls[i]!;
      const output = visionOutputAt(vision, witnessCell);
      if (!output) continue;
      const batch = d.exec.mapBatches.find((b) => b.map === ctx.spatial.session.voxel
        && b.seq > vision.seq
        && b.observations.some((o) => observationMatchesVision(o, witnessCell, output)));
      if (batch) return { vision, output, batch };
    }
    return null;
  })();
  if (!aChain) throw new Error('S1 A 阶段没有 witness 格的合法 Vision→同 svc.voxel 观测');
  const witnessDim = aChain.output.dimension;
  const baselineCell = cellEvidenceSnapshot(ctx.spatial.session.voxel.cellAt(witnessDim, witnessCell.x, witnessCell.y, witnessCell.z));
  s1.witness = {
    cell: witnessCell,
    dim: witnessDim,
    aVision: {
      seq: aChain.vision.seq, ts: aChain.vision.ts, visionId: aChain.vision.visionId,
      frame: aChain.vision.frame, observationId: aChain.output.observationId,
      observedAt: aChain.output.observedAt, name: aChain.output.name,
      worldId: aChain.output.worldId, sessionId: aChain.output.sessionId,
    },
    aMap: { seq: aChain.batch.seq, mapId: aChain.batch.mapId, mapWorldId: aChain.batch.mapWorldId, reportId: aChain.batch.reportId, mapIsSessionVoxel: aChain.batch.map === ctx.spatial.session.voxel },
    baselineCell,
  };
  if (!baselineCell.observed) throw new Error(`S1 witness 基准格不可读：${JSON.stringify(baselineCell)}`);
  if (bareBlockName(baselineCell.name ?? '') !== bareBlockName(lane.material)) {
    throw new Error(`S1 witness 不是步行道支撑格：${JSON.stringify(baselineCell)}`);
  }
  if (baselineCell.sequence !== aChain.output.observationId || baselineCell.observedAt !== aChain.output.observedAt
    || baselineCell.sessionId !== aChain.output.sessionId || baselineCell.name !== aChain.output.name) {
    throw new Error(`S1 witness 基准与 A 实际 Vision 不一致：${JSON.stringify(baselineCell)}`);
  }

  // B 开始前再次只读确认：A 动作结束没有清空/刷新这份原证据。
  const beforeStartCell = cellEvidenceSnapshot(ctx.spatial.session.voxel.cellAt(witnessDim, witnessCell.x, witnessCell.y, witnessCell.z));
  s1.witness = { ...(s1.witness as Record<string, unknown>), beforeStartCell };
  if (!sameCellEvidence(baselineCell, beforeStartCell)) {
    throw new Error(`S1 B 开始前 witness 原证据被清空/刷新：before=${JSON.stringify(baselineCell)} after=${JSON.stringify(beforeStartCell)}`);
  }

  const bStartSeq = d.seq.next();
  const bDeadlineMs = Date.now() + 30_000;
  const startedB = startWalkTask(ctx, d, bRoute, bDeadlineMs);
  if ('error' in startedB) throw new Error(`S1 B 启动失败：${startedB.error}`);
  const bTaskId = startedB.task.id;
  s1.b = { taskId: bTaskId, route: bRoute, startSeq: bStartSeq, deadlineMs: bDeadlineMs, startRegisteredAt: Date.now() };
  const bStarted = await awaitRouteStartRecord(d.exec.routeCalls, bTaskId, startedB.done, 10_000, 'S1 B');
  const bDelegation = bStarted.delegationId;
  s1.b = { ...(s1.b as Record<string, unknown>), delegationId: bDelegation, startStatus: bStarted.startCall.statusAfter };
  const bOutcome = await awaitOrTimeout(startedB.done, 60_000, 'S1 B 完成');
  if (bOutcome.result.status !== 'succeeded') {
    s1.b = { ...(s1.b as Record<string, unknown>), outcome: bOutcome.result };
    throw new Error(`S1 B 未成功：status=${bOutcome.result.status} 摘要=${bOutcome.result.summary}`);
  }
  const bNav = navFromResult(bOutcome.result);
  const bArrival = assertArrivedAt(bNav, bRoute[bRoute.length - 1]!, bY, 'S1 B');
  const bSegments = checkTaskSegments(d.exec.moves, bDelegation, bTaskId, 3);
  const bCompletions = measuredCompletions(d.exec.deliveredSamples, bTaskId, bDelegation);
  assertArrivalProvenance(bNav!, bCompletions, 'S1 B');
  const bRelease = assertProductionRelease(d.diag.stopAlls, bTaskId, snapshotKeys(ctx.bot), 'S1 B');
  // B 自己的真实 public route 验证状态（按 task+delegation 过滤，不拿 A 旧 OPEN）。
  const bRouteRows = [
    ...d.exec.routeCalls.filter((c) => c.ownerTaskId === bTaskId && c.delegationId === bDelegation)
      .map((c) => ({ ownerTaskId: c.ownerTaskId, seq: c.seq, status: c.statusAfter })),
    ...d.exec.deliveredSamples.filter((s) => s.ownerTaskId === bTaskId && s.delegationId === bDelegation)
      .map((s) => ({ ownerTaskId: s.ownerTaskId, seq: s.seq, status: s.statusAfter })),
    ...d.exec.observes.filter((o) => o.ownerTaskId === bTaskId && o.delegationId === bDelegation)
      .map((o) => ({ ownerTaskId: o.ownerTaskId, seq: o.exitSeq, status: o.statusAfter })),
  ];
  const bRouteOpen = (status: RouteStatusSnapshot) => status.route !== null
    && status.route.stepCount === 3
    && status.route.verifiedStepIndexes.join(',') === '0,1,2'
    && status.route.steps.length === 3
    && status.route.steps.every((step) => step.kind === 'verified' && step.status === 'OPEN');
  const bRouteProof = [...bRouteRows].reverse().find((row) => bRouteOpen(row.status))
    ?? { ownerTaskId: bStarted.startCall.ownerTaskId, seq: bStarted.startCall.seq, status: bStarted.startCall.statusAfter };
  s1.b = {
    ...(s1.b as Record<string, unknown>),
    routeProof: { ownerTaskId: bRouteProof.ownerTaskId, seq: bRouteProof.seq, status: bRouteProof.status },
    segmentIds: bSegments.segments.map((m) => m.executionId),
    measuredCompletionPositions: bCompletions.map((c) => c.pos),
    horizontalError: Number(bArrival.horizontalError.toFixed(3)),
    feetError: Number(bArrival.feetError.toFixed(3)),
    stopAllSeq: { before: bRelease.seqBefore, after: bRelease.seqAfter },
    acceptedSampleCount: acceptedMeasurements(d.exec.deliveredSamples, bTaskId, bDelegation).length,
    maps: d.exec.mapBatches.filter((b) => b.seq > bStartSeq).map((b) => ({
      seq: b.seq, mapId: b.mapId, mapWorldId: b.mapWorldId,
      mapIsSessionVoxel: b.map === ctx.spatial.session.voxel,
    })),
  };

  // B 期真实 Vision→同一 svc.voxel 的重观测链路；取最后一个实际写入的候选。
  const bChains = (() => {
    const out: Array<{ vision: VisionCallRecord; output: VisionCallRecord['output'][number]; batch: MapBatchRecord }> = [];
    for (let i = d.exec.visionCalls.length - 1; i >= 0; i--) {
      const vision = d.exec.visionCalls[i]!;
      if (vision.seq <= bStartSeq || !visionOutputAt(vision, witnessCell)) continue;
      const output = visionOutputAt(vision, witnessCell)!;
      const batch = d.exec.mapBatches.find((b) => b.map === ctx.spatial.session.voxel
        && b.seq > vision.seq
        && b.observations.some((o) => observationMatchesVision(o, witnessCell, output)));
      if (batch) out.push({ vision, output, batch });
    }
    return out;
  })();
  const bVision = bChains[0]?.vision
    ?? [...d.exec.visionCalls].reverse().find((c) => c.seq > bStartSeq && visionOutputAt(c, witnessCell) !== undefined)
    ?? null;
  const afterCell = cellEvidenceSnapshot(ctx.spatial.session.voxel.cellAt(witnessDim, witnessCell.x, witnessCell.y, witnessCell.z));
  const bScope = actualScope(ctx);
  const bMaps = d.exec.mapBatches.filter((b) => b.seq > bStartSeq);
  s1.witness = {
    ...(s1.witness as Record<string, unknown>),
    bVision: bChains[0] ? {
      seq: bChains[0].vision.seq, ts: bChains[0].vision.ts, visionId: bChains[0].vision.visionId,
      frame: bChains[0].vision.frame, observationId: bChains[0].output.observationId,
      observedAt: bChains[0].output.observedAt, name: bChains[0].output.name,
      worldId: bChains[0].output.worldId, sessionId: bChains[0].output.sessionId,
    } : null,
    bMap: bChains[0] ? { seq: bChains[0].batch.seq, mapId: bChains[0].batch.mapId, mapWorldId: bChains[0].batch.mapWorldId, reportId: bChains[0].batch.reportId } : null,
    afterCell,
  };

  const s1Check = checkS1Return({
    taskIdA: taskId, taskIdB: bTaskId, aRoute: route, aLastCompletion: aLast.pos,
    delegationB: bDelegation, bRoute, bStartSeq, bRouteStatus: bRouteProof,
    bMoves: d.exec.moves, bCompletions, bMaps,
    expectedMap: ctx.spatial.session.voxel,
    expectedScope: { worldId: bScope.worldId, dim: bScope.dim, sessionId: bScope.sessionId },
    witnessCell, baselineCell, beforeStartCell, bVision, afterCell,
  });
  s1.check = s1Check;
  s1.status = s1Check.ok ? 'PASS' : 'FAIL';
  if (!s1Check.ok) throw new Error(`S1 返程证明失败：${s1Check.reason}`);
  ev.verdict = 'PASS';
}

/** W2：受控平台边缘、分数起终点、整条真实轨迹无坠落/失支撑，并做终态全键断言。 */
async function scenarioW2(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const p = W2_PLATFORM;
  const route = [p.start, { ...p.target }];
  ev.extra = { platform: p, route };
  await buildSupportFixture(ctx.rcon, ev, { xMin: p.xMin, xMax: p.xMax, zMin: p.zMin, zMax: p.zMax }, p.feetY, p.material);
  await teleportAndSettle(ctx, ev, p.start, 'W2 平台起点');

  // 只在 teleport 落定、任务启动前开始计量；搭设/传送帧单独保留，不进支撑断言。
  const taskStartTs = Date.now();
  const deadlineMs = Date.now() + 30_000;
  const started = startWalkTask(ctx, d, route, deadlineMs);
  if ('error' in started) throw new Error(`W2 启动失败：${started.error}`);
  const o = await awaitOrTimeout(started.done, 60_000, 'W2 完成');
  if (o.result.status !== 'succeeded') throw new Error(`W2 未成功：status=${o.result.status} 摘要=${o.result.summary}`);
  const nav = navFromResult(o.result);
  const arrival = assertArrivedAt(nav, p.target, p.feetY, 'W2');

  const taskId = started.task.id;
  const startCall = d.exec.routeCalls.find((c) => c.op === 'start' && c.ownerTaskId === taskId);
  if (!startCall?.delegationId) throw new Error('W2 未捕获本任务的真实 delegation 启动');
  const delegationId = startCall.delegationId;
  const segments = checkTaskSegments(d.exec.moves, delegationId, taskId, 1);
  if (!segments.ok) throw new Error(`W2 段集合不合法：${segments.reason}`);
  const completions = measuredCompletions(d.exec.deliveredSamples, taskId, delegationId);
  if (completions.length !== 1) throw new Error(`W2 实测到达完成点 ${completions.length} != 1`);
  assertArrivalProvenance(nav!, completions, 'W2');
  const release = assertProductionRelease(d.diag.stopAlls, taskId, snapshotKeys(ctx.bot), 'W2');

  const motionFrames = framesSince(d.recorder.frames, taskStartTs);
  ev.trajectory = summarizeTrajectory(motionFrames);
  const footprint = { xMin: p.xMin, xMax: p.xMax, zMin: p.zMin, zMax: p.zMax };
  if (motionFrames.length === 0) throw new Error('W2 无运动帧');
  if (!allGroundedAt(motionFrames, p.feetY)) {
    const minFeet = (ev.trajectory.minFeetY as number) ?? NaN;
    const airborne = (ev.trajectory.airborneFrames as number) ?? 0;
    throw new Error(`W2 轨迹失支撑：minFeetY=${minFeet} airborneFrames=${airborne}`);
  }
  if (platformEscaped(motionFrames, footprint)) {
    throw new Error(`W2 逃出平台足迹：bounds=${JSON.stringify(ev.trajectory)}`);
  }
  ev.extra = {
    ...ev.extra, arrival: nav, taskStartTs, delegationId,
    horizontalError: Number(arrival.horizontalError.toFixed(3)), feetError: Number(arrival.feetError.toFixed(3)),
    onGroundAtArrival: arrival.obs.onGround, inWaterAtArrival: arrival.obs.inWater,
    segmentCount: segments.segments.length,
    stopAllSeq: { before: release.seqBefore, after: release.seqAfter },
    acceptedSampleCount: acceptedMeasurements(d.exec.deliveredSamples, taskId, delegationId).length,
  };
  ev.verdict = 'PASS';
}

/**
 * W4：真实可见支撑失效。只有「合法 stone 初观测 → 控制端拆 exact target →
 * 实际 Vision 看到 air → 同一 ChangeReport 进入 loop.observe → 所属段在 observe
 * 内释放控制（早于该帧 onSample）」全链成立才 PASS；不靠终态后补观测或 harness 写图。
 */
async function scenarioW4(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const f = W4_FIXTURE;
  const target = f.targetSupport;
  ev.extra = { fixture: f, route: f.route, targetSupport: target };
  await buildSupportFixture(ctx.rcon, ev, { xMin: f.xMin, xMax: f.xMax, zMin: f.zMin, zMax: f.zMax }, f.feetY, f.material);
  await teleportAndSettle(ctx, ev, f.start, 'W4 起点');
  const startPos = { ...ctx.adapter.state().pos };
  const started = startWalkTask(ctx, d, f.route, Date.now() + 30_000);
  if ('error' in started) throw new Error(`W4 启动失败：${started.error}`);
  const taskId = started.task.id;
  const done = started.done;
  const { startCall, delegationId } = await awaitRouteStartRecord(d.exec.routeCalls, taskId, done, 10_000, 'W4');

  const stoneChain = () => {
    const status = latestRouteStatus(d.exec, taskId, delegationId);
    const eye = ctx.adapter.eye();
    if (!status || status.result !== null || status.activeStepIndex === null) return null;
    const moved = acceptedMovementBeyond(d.exec.deliveredSamples, taskId, delegationId, startPos, 0.3);
    if (moved === undefined || !eye) return null;
    if (Math.abs(eye.pitch + 1.2) > 0.08 || angularDistance(eye.yaw, -Math.PI / 2) > 0.2) return null;
    const vision = [...d.exec.visionCalls].reverse().find((c) => c.seq > startCall.seq
      && bareBlockName(visionOutputAt(c, target)?.name ?? '') === 'stone');
    if (!vision) return null;
    const observed = visionOutputAt(vision, target)!;
    const batch = d.exec.mapBatches.find((b) => b.seq > vision.seq
      && b.observations.some((o) => observationMatchesVision(o, target, observed)));
    if (!batch) return null;
    // 初选时刻的真实身体与时刻，区别于该 Vision 记录的原始 observedAt。
    return { status, eye, moved, vision, observed, batch, body: { ...ctx.adapter.state().pos }, selectedAt: Date.now() };
  };
  await waitForPrecise(() => stoneChain() !== null, 20_000, 'W4 活动段内合法 stone 初观测与行进/俯视');
  const initial = stoneChain()!;
  const map = initial.batch.map;
  const mapId = initial.batch.mapId;
  const cellBefore = cellEvidenceSnapshot(map.cellAt(ctx.adapter.state().dim, target.x, target.y, target.z));
  // 已获得的初观测证据立即挂入，后续断言失败也不会丢。
  ev.extra = {
    ...ev.extra,
    initialStone: {
      visionSeq: initial.vision.seq, mapSeq: initial.batch.seq, frame: initial.vision.frame,
      name: initial.observed.name, observedAt: initial.observed.observedAt, observationId: initial.observed.observationId,
      body: initial.body, bodyLabel: 'selection-time', selectedAt: initial.selectedAt,
      eye: initial.vision.eye,
    },
    cellBefore,
  };
  if (!cellBefore.observed || bareBlockName(cellBefore.name ?? '') !== 'stone') {
    throw new Error(`W4 初观测 cellAt 不是 stone：${JSON.stringify(cellBefore)}`);
  }

  // 拆之前复核仍在同一委托活动段；只拆 exact target，不加替代侧路。
  const beforeStatus = latestRouteStatus(d.exec, taskId, delegationId);
  if (ctx.arbiter.current?.id !== taskId || !beforeStatus || beforeStatus.result !== null || beforeStatus.activeStepIndex !== 0) {
    throw new Error(`W4 拆支撑前不在首段在途：${beforeStatus?.activeStepIndex}/${beforeStatus?.result?.outcome ?? null}`);
  }
  const eyeBefore = ctx.adapter.eye();
  const bodyBefore = { ...ctx.adapter.state().pos };
  if (Math.floor(bodyBefore.x) !== 210) {
    throw new Error(`W4 拆支撑时目标 x211 已非前方支撑（body.x=${bodyBefore.x}）`);
  }
  const command = `setblock ${target.x} ${target.y} ${target.z} minecraft:air`;
  const issueSeq = d.seq.next();
  const issueTs = Date.now();
  const frameAtIssue = d.recorder.frames.length;
  // 先挂同一个诊断记录引用，再发 RCON；issued 立即可见，response 只有真实收到后才填。
  const rconDiag: Record<string, unknown> = {
    command,
    issued: { seq: issueSeq, ts: issueTs, frame: frameAtIssue, body: bodyBefore, eye: eyeBefore },
    responded: null,
  };
  ev.extra = { ...ev.extra, rcon: rconDiag };
  const response = await ctx.rcon.send(command);
  const responseSeq = d.seq.next();
  const responseTs = Date.now();
  const frameAtResponse = d.recorder.frames.length;
  rconDiag.response = response;
  rconDiag.responded = { seq: responseSeq, ts: responseTs, frame: frameAtResponse };
  // 真实 setblock 响应必须能被已有严格解析确认；失败不吞。
  parseSetBlock(response);

  const airChain = () => {
    const vision = d.exec.visionCalls.find((c) => c.seq > issueSeq
      && isAirBlockName(visionOutputAt(c, target)?.name ?? ''));
    if (!vision) return null;
    const observed = visionOutputAt(vision, target)!;
    const batch = d.exec.mapBatches.find((b) => b.seq > vision.seq
      && b.observations.some((o) => observationMatchesVision(o, target, observed)));
    if (!batch) return null;
    const observe = d.exec.observes.find((o) => o.ownerTaskId === taskId && o.delegationId === delegationId
      && o.reportId !== null && o.reportId === batch.reportId && o.enterSeq > batch.seq);
    if (!observe) return null;
    return { vision, observed, batch, observe };
  };
  await waitFor(() => airChain() !== null, 15_000, 'W4 实际 Vision air → 同一 report → loop.observe');
  const air = airChain()!;
  const o = await awaitOrTimeout(done, 20_000, 'W4 完成');

  // 只接受本任务身体真实下发的 clear，且确实从按下状态松开全部 7 键；
  // 其他任务/unknown stopAll 的 clear 不能算所属段释放。
  const release = d.diag.actualControls
    .filter((c) => c.seq > air.observe.enterSeq && c.seq < air.observe.exitSeq
      && c.op === 'clear' && c.ownerTaskId === taskId
      && Object.values(c.keysBefore).some(Boolean) && allKeysReleased(c.keysAfter))
    .sort((a, b) => a.seq - b.seq)[0];
  const nextSample = d.exec.deliveredSamples
    .filter((s) => s.ownerTaskId === taskId && s.delegationId === delegationId && s.seq > air.observe.exitSeq)
    .sort((a, b) => a.seq - b.seq)[0];
  const taskMoves = d.exec.moves.filter((m) => m.taskId === taskId && m.delegationId === delegationId);
  const firstStepMoveId = `${delegationId}-step-0`;
  const laterMoves = taskMoves.filter((m) => m.executionId !== firstStepMoveId);
  const nav = navFromResult(o.result);
  // 拆支撑与看到 air 必须属于同一个在途段，不能等到后续段或终态才补观察。
  if (air.observe.statusBefore?.activeStepIndex !== beforeStatus.activeStepIndex) {
    throw new Error(`W4 air 观察不在拆支撑所属段：拆时=${beforeStatus.activeStepIndex} 观察时=${air.observe.statusBefore?.activeStepIndex}`);
  }
  const chain = checkW4ObservationChain({
    taskId,
    issueSeq,
    initialStone: { visionSeq: initial.vision.seq, mapSeq: initial.batch.seq, mapId, name: initial.observed.name },
    airVision: { seq: air.vision.seq, name: air.observed.name, frame: air.vision.frame },
    airBatch: {
      seq: air.batch.seq, reportId: air.batch.reportId, mapId: air.batch.mapId,
      targetChanged: reportTouchesCell(air.batch.report, target), frame: air.batch.frame,
    },
    observe: {
      enterSeq: air.observe.enterSeq, exitSeq: air.observe.exitSeq,
      frameEnter: air.observe.frameEnter, frameExit: air.observe.frameExit,
      reportId: air.observe.reportId,
      statusBeforeActiveStepIndex: air.observe.statusBefore?.activeStepIndex ?? null,
      statusBeforeOutcome: air.observe.statusBefore?.result?.outcome ?? null,
      statusAfterOutcome: air.observe.statusAfter.result?.outcome ?? null,
      statusAfterActiveStepIndex: air.observe.statusAfter.activeStepIndex,
      statusAfterProblem: air.observe.statusAfter.result?.problem?.kind ?? null,
    },
    release: release ? { seq: release.seq, ownerTaskId: release.ownerTaskId } : null,
    nextSample: nextSample ? { seq: nextSample.seq, frame: nextSample.frame } : null,
    laterMoveCount: laterMoves.length,
    terminalOutcome: nav?.outcome ?? null,
  });
  if (!chain.ok) throw new Error(`W4 观察链不成立：${chain.reason}`);
  if (nav?.outcome !== 'FAILED' || nav.problem?.kind !== 'route_invalidated') {
    throw new Error(`W4 库终态非 FAILED/route_invalidated：outcome=${nav?.outcome} problem=${nav?.problem?.kind}`);
  }
  // 首段 active 时只应启动 step-0；第二段在任意时刻都不得启动。
  if (taskMoves.length !== 1 || taskMoves[0]!.executionId !== firstStepMoveId) {
    throw new Error(`W4 本任务总 move 非唯一首段 step0：${JSON.stringify(taskMoves.map((m) => m.executionId))}`);
  }
  const finalKeys = snapshotKeys(ctx.bot);
  if (!allKeysReleased(finalKeys)) throw new Error(`W4 终态 7 键未全部松开：${JSON.stringify(finalKeys)}`);
  rconDiag.firstObservation = {
    seq: air.vision.seq, ts: air.vision.ts, frame: air.vision.frame,
    observedAt: air.observed.observedAt, observationId: air.observed.observationId,
  };
  // 客户端可能先合法看到 air，再收到 setblock 应答；如实保留两者，不强制排序。
  rconDiag.observedBeforeResponse = air.vision.seq < responseSeq;

  ev.extra = {
    ...ev.extra,
    taskId, delegationId, mapId,
    initialStone: {
      visionSeq: initial.vision.seq, mapSeq: initial.batch.seq, frame: initial.vision.frame,
      name: initial.observed.name, observedAt: initial.observed.observedAt, observationId: initial.observed.observationId,
      // 初选时刻真实身体与关联 Vision 记录的 eye；不与最终状态或原 observedAt 混用。
      body: initial.body, bodyLabel: 'selection-time', selectedAt: initial.selectedAt, eye: initial.vision.eye,
    },
    cellBefore,
    air: {
      visionSeq: air.vision.seq, visionFrame: air.vision.frame, visionTs: air.vision.ts,
      mapSeq: air.batch.seq, reportId: air.batch.reportId, mapId: air.batch.mapId,
      reportTouchesTarget: reportTouchesCell(air.batch.report, target),
      observe: {
        enterSeq: air.observe.enterSeq, exitSeq: air.observe.exitSeq, tsEnter: air.observe.tsEnter, tsExit: air.observe.tsExit,
        frameEnter: air.observe.frameEnter, frameExit: air.observe.frameExit,
        statusBefore: air.observe.statusBefore, statusAfter: air.observe.statusAfter,
        keysBefore: air.observe.keysBefore, keysAfter: air.observe.keysAfter,
      },
    },
    release: release ? { seq: release.seq, ts: release.ts, op: release.op, ownerTaskId: release.ownerTaskId, keysBefore: release.keysBefore, keysAfter: release.keysAfter } : null,
    nextSample: nextSample ? { seq: nextSample.seq, frame: nextSample.frame, ts: nextSample.ts } : null,
    taskMoveIds: taskMoves.map((m) => m.executionId),
    laterMoveCount: laterMoves.length,
    final: {
      status: o.result.status, failureCode: o.result.failureCode, summary: o.result.summary,
      outcome: nav?.outcome, problem: nav?.problem, lastPosition: nav?.lastPosition,
      activeStepIndex: latestRouteStatus(d.exec, taskId, delegationId)?.activeStepIndex ?? null,
      finalKeys,
    },
    timeline: [
      { kind: 'rcon-issued', seq: issueSeq, ts: issueTs, frame: frameAtIssue },
      { kind: 'vision-air', seq: air.vision.seq, ts: air.vision.ts, frame: air.vision.frame },
      { kind: 'map-report', seq: air.batch.seq, ts: air.batch.ts, frame: air.batch.frame },
      { kind: 'observe-enter', seq: air.observe.enterSeq, ts: air.observe.tsEnter, frame: air.observe.frameEnter },
      { kind: 'control-release', seq: release!.seq, ts: release!.ts, frame: null },
      { kind: 'observe-exit', seq: air.observe.exitSeq, ts: air.observe.tsExit, frame: air.observe.frameExit },
      { kind: 'onSample', seq: nextSample!.seq, ts: nextSample!.ts, frame: nextSample!.frame },
      { kind: 'rcon-response', seq: responseSeq, ts: responseTs, frame: frameAtResponse },
    ],
    deltas: {
      visionToMapMs: air.batch.ts - air.vision.ts,
      mapToObserveEnterMs: air.observe.tsEnter - air.batch.ts,
      observeDurationMs: air.observe.tsExit - air.observe.tsEnter,
      releaseAfterEnterMs: release!.ts - air.observe.tsEnter,
      onSampleAfterExitMs: nextSample!.ts - air.observe.tsExit,
      issueToFirstObservationMs: air.vision.ts - issueTs,
      firstObservationToResponseMs: responseTs - air.vision.ts,
    },
  };
  ev.verdict = 'PASS';
}

/**
 * W5：隐藏变化后由同一活跃显式往返委托自然回看。隐藏期只证明「未看到/未刷新」，
 * 回看必须是真实 Vision→map→report→同一 loop，不能由 harness 直接写图或动作后补查。
 */
async function scenarioW5(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const f = W5_FIXTURE;
  const target = f.targetSupport;
  // 只读当前配置的既有 FOV，不放大视锥；用于证明目标确实在身后 FOV 外。
  const visionHfovRad = config.vision.hFov * Math.PI / 180;
  ev.extra = { fixture: f, route: f.route, targetSupport: target };
  await buildSupportFixture(ctx.rcon, ev, { xMin: f.xMin, xMax: f.xMax, zMin: f.zMin, zMax: f.zMax }, f.feetY, f.material);
  await teleportAndSettle(ctx, ev, f.start, 'W5 起点');
  // 合法预扫发生在 loop.start 之前；用任务启动边界区分本场景真实视觉来源，而不是伪造 loop 归属。
  const taskStartSeq = d.seq.next();
  const started = startWalkTask(ctx, d, f.route, Date.now() + 30_000);
  if ('error' in started) throw new Error(`W5 启动失败：${started.error}`);
  const taskId = started.task.id;
  const done = started.done;
  const { delegationId } = await awaitRouteStartRecord(d.exec.routeCalls, taskId, done, 10_000, 'W5');

  // 初观测可以在合法预扫或移动观察中；只接受实际 Vision 输出 + 实际 map 写入的同一 observationId。
  const stoneChain = () => {
    const vision = d.exec.visionCalls.find((c) => c.seq > taskStartSeq
      && bareBlockName(visionOutputAt(c, target)?.name ?? '') === 'stone');
    if (!vision) return null;
    const observed = visionOutputAt(vision, target)!;
    const batch = d.exec.mapBatches.find((b) => b.seq > vision.seq
      && b.observations.some((o) => observationMatchesVision(o, target, observed)));
    if (!batch) return null;
    return { vision, observed, batch, body: { ...ctx.adapter.state().pos }, selectedAt: Date.now() };
  };
  await waitFor(() => stoneChain() !== null, 20_000, 'W5 目标支撑合法 stone 初观测');
  const initial = stoneChain()!;
  const map = initial.batch.map;
  const mapId = initial.batch.mapId;
  const dim = ctx.adapter.state().dim;
  const initialCell = cellEvidenceSnapshot(map.cellAt(dim, target.x, target.y, target.z));
  // 初观测证据立即挂入，后续断言失败也保留。
  ev.extra = {
    ...ev.extra,
    initialStone: {
      visionSeq: initial.vision.seq, mapSeq: initial.batch.seq, frame: initial.vision.frame,
      name: initial.observed.name, observedAt: initial.observed.observedAt, observationId: initial.observed.observationId,
      body: initial.body, bodyLabel: 'selection-time', selectedAt: initial.selectedAt, eye: initial.vision.eye,
    },
    initialCell,
  };
  if (!initialCell.observed || bareBlockName(initialCell.name ?? '') !== 'stone') {
    throw new Error(`W5 初观测 cellAt 不是 stone：${JSON.stringify(initialCell)}`);
  }

  const forwardGaze = () => {
    const status = latestRouteStatus(d.exec, taskId, delegationId);
    const eye = ctx.adapter.eye();
    const pos = ctx.adapter.state().pos;
    if (!status || status.result !== null || status.activeStepIndex !== 1) return null;
    if (Math.floor(pos.x) !== 217) return null;
    if (!eye || Math.abs(eye.pitch + 1.2) > 0.08 || angularDistance(eye.yaw, -Math.PI / 2) > 0.25) return null;
    const dx = target.x + 0.5 - eye.x;
    const dz = target.z + 0.5 - eye.z;
    const dy = target.y + 0.5 - eye.y;
    const targetYaw = Math.atan2(-dx, -dz);
    const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (angularDistance(eye.yaw, targetYaw) <= visionHfovRad / 2) return null;
    return { status, eye, pos, targetYaw, targetPitch };
  };
  await waitForPrecise(() => forwardGaze() !== null, 20_000, 'W5 去程 floor(x)=217 且前向段 active、x0 在 FOV 外');
  const forward = forwardGaze()!;
  const candidates: Vec3[] = [];
  const fx = Math.floor(forward.pos.x), fy = Math.floor(forward.pos.y), fz = Math.floor(forward.pos.z);
  for (let x = fx - 1; x <= fx + 1; x++) for (let z = fz - 1; z <= fz + 1; z++) for (let y = fy - 1; y <= fy + 2; y++) candidates.push({ x, y, z });
  if (candidates.some((c) => sameCell(c, target))) throw new Error('W5 目标支撑仍在本帧生产 fx±1 候选内，隐藏前提不成立');

  const beforeStatus = latestRouteStatus(d.exec, taskId, delegationId);
  if (ctx.arbiter.current?.id !== taskId || !beforeStatus || beforeStatus.result !== null || beforeStatus.activeStepIndex !== 1) {
    throw new Error('W5 拆支撑前委托已不在前向活动段');
  }
  const beforeRoute = beforeStatus.route;

  // baseline 必须在真实前向条件成立后、setblock 发出前立即采集；loop.start 时的初观测
  // 可能已被途中 Vision 刷新，不能作为隐藏不变比较的基线。
  const captureCell = (): W5CellCapture => ({
    ...cellEvidenceSnapshot(map.cellAt(dim, target.x, target.y, target.z)),
    captureAt: Date.now(),
    captureSeq: d.seq.next(),
    captureFrame: d.recorder.frames.length,
    body: { ...ctx.adapter.state().pos },
    eye: ctx.adapter.eye(),
  });
  const cellBefore = captureCell();
  ev.extra = { ...ev.extra, cellBefore };
  if (!cellBefore.observed || bareBlockName(cellBefore.name ?? '') !== 'stone') {
    throw new Error(`W5 隐藏 baseline cellAt 不是 stone：${JSON.stringify(cellBefore)}`);
  }
  const hiddenStartSeq = cellBefore.captureSeq;
  const hiddenStartAt = cellBefore.captureAt;

  const command = `setblock ${target.x} ${target.y} ${target.z} minecraft:air`;
  const issueSeq = d.seq.next();
  const issueTs = Date.now();
  const frameAtIssue = d.recorder.frames.length;
  const eyeAtIssue = ctx.adapter.eye();
  const bodyAtIssue = { ...ctx.adapter.state().pos };
  // 先挂诊断记录引用再发 RCON；issued 先落盘，response 收到后才填。
  const rconDiag: Record<string, unknown> = {
    command,
    issued: { seq: issueSeq, ts: issueTs, frame: frameAtIssue, body: bodyAtIssue, eye: eyeAtIssue },
    responded: null,
  };
  ev.extra = { ...ev.extra, rcon: rconDiag };
  const response = await ctx.rcon.send(command);
  const responseSeq = d.seq.next();
  const responseTs = Date.now();
  const frameAtResponse = d.recorder.frames.length;
  rconDiag.response = response;
  rconDiag.responded = { seq: responseSeq, ts: responseTs, frame: frameAtResponse };
  // 先保存真实原 response 作为失败证据；严格解析失败会直接中止，后续 hidden
  // 判定只在 parse 成功后执行，因此成功边界仍以真实 responseSeq 为准。
  parseSetBlock(response);

  const ownMoves = () => d.exec.moves.filter((m) => m.taskId === taskId && m.delegationId === delegationId);
  const returnMoveOf = () => ownMoves().find((m) => m.executionId.endsWith('-step-2')) ?? null;
  const targetInFovOf = (eye: EyeSnapshot | null): boolean => {
    if (!eye) return false;
    const dx = target.x + 0.5 - eye.x;
    const dz = target.z + 0.5 - eye.z;
    const yaw = Math.atan2(-dx, -dz);
    return angularDistance(eye.yaw, yaw) <= visionHfovRad / 2;
  };
  const hiddenVisionAt = (endSeq: number) => d.exec.visionCalls.filter((c) => c.seq > hiddenStartSeq && c.seq < endSeq);
  const hiddenBatchesAt = (endSeq: number) => d.exec.mapBatches.filter((b) => b.seq > hiddenStartSeq && b.seq < endSeq);
  const viewOf = (c: VisionCallRecord): W5HiddenView => {
    const output = visionOutputAt(c, target);
    return {
      seq: c.seq,
      frame: c.frame,
      eye: c.eye,
      targetInPositions: c.positions.some((p) => sameCell(p, target)),
      targetInFov: targetInFovOf(c.eye),
      targetOutput: output ? output.name : null,
    };
  };

  // 隐藏窗口只由真实去程几何/候选排除与首次真实返程 move 限定；绝不按首个 air 截断。
  let cellDuring: W5CellCapture | null = null;
  let returnMove: MoveRecord | null = null;
  const hiddenDeadline = Date.now() + 20_000;
  while (Date.now() < hiddenDeadline) {
    returnMove = returnMoveOf();
    if (returnMove) break;
    // 只统计成功 response 之后的真实 Vision 帧；窗口后段帧不能补成采集前证据。
    const frames = new Set(hiddenVisionAt(Number.POSITIVE_INFINITY)
      .filter((c) => c.seq > responseSeq)
      .map((c) => c.frame));
    if (!cellDuring && frames.size >= 2) {
      cellDuring = captureCell();
      ev.extra = { ...ev.extra, cellDuring };
    }
    const status = latestRouteStatus(d.exec, taskId, delegationId);
    if (status?.result !== null) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  returnMove = returnMoveOf();
  const hiddenEndSeq = returnMove?.seq ?? Number.POSITIVE_INFINITY;
  const hiddenCalls = hiddenVisionAt(hiddenEndSeq);
  const hiddenMaps = hiddenBatchesAt(hiddenEndSeq);
  const hiddenViews = hiddenCalls.map(viewOf);
  const hiddenBatchViews: W5HiddenBatch[] = hiddenMaps.map((b) => ({
    seq: b.seq,
    frame: b.frame,
    targetObservation: b.observations.some((o) => sameCell(o.pos, target)),
    targetChanged: reportTouchesCell(b.report, target),
  }));
  const postResponseBeforeDuring = hiddenViews.filter((v) => cellDuring !== null && v.seq > responseSeq && v.seq < cellDuring.captureSeq);
  const hidden = {
    startSeq: hiddenStartSeq,
    startAt: hiddenStartAt,
    responseSeq,
    responseFrame: frameAtResponse,
    endSeq: hiddenEndSeq,
    endAt: returnMove?.ts ?? null,
    views: hiddenViews,
    batches: hiddenBatchViews,
    distinctFrames: new Set(hiddenViews.map((v) => v.frame)).size,
    postResponseFramesBeforeDuring: new Set(postResponseBeforeDuring.map((v) => v.frame)).size,
  };
  ev.extra = { ...ev.extra, hidden };

  if (!returnMove) {
    const st = latestRouteStatus(d.exec, taskId, delegationId);
    throw new Error(`W5 未到达真实返程 step2 move 即结束：${st?.result?.outcome}/${st?.result?.problem?.kind}`);
  }
  if (!cellDuring) throw new Error('W5 隐藏窗口不足：未能在返程前采集第二个真实 cellAt 样本');
  if (hidden.distinctFrames < 2) throw new Error(`W5 隐藏窗口不足两个不同 physics frame：${hidden.distinctFrames}`);
  if (hidden.postResponseFramesBeforeDuring < 2) {
    throw new Error(`W5 成功 response 后至 cellDuring 前不足两个不同 physics frame：${hidden.postResponseFramesBeforeDuring}`);
  }
  if (hiddenMaps.length < 1) throw new Error('W5 隐藏窗口缺少真实 map 观察边界');
  const badView = hiddenViews.find((v) => v.targetOutput !== null || v.targetInPositions || !v.eye || v.targetInFov);
  if (badView) throw new Error(`W5 隐藏期观察不合法：${JSON.stringify(badView)}`);
  const badBatch = hiddenBatchViews.find((b) => b.targetObservation || b.targetChanged);
  if (badBatch) throw new Error(`W5 隐藏期 map 已刷新/报告目标格：${JSON.stringify(badBatch)}`);

  const revealCandidate = () => d.exec.visionCalls.find((c) => c.seq > returnMove!.seq && visionOutputAt(c, target) !== undefined);
  await waitForPrecise(() => revealCandidate() !== undefined || latestRouteStatus(d.exec, taskId, delegationId)?.result !== null,
    20_000, 'W5 返程 step2 合法回看或终态');
  const revealVision = revealCandidate();
  if (!revealVision) {
    const st = latestRouteStatus(d.exec, taskId, delegationId);
    throw new Error(`W5 只有隐藏半段，终态先到且无生产回看：${st?.result?.outcome}/${st?.result?.problem?.kind}`);
  }
  const revealOutput = visionOutputAt(revealVision, target)!;
  // 返程后第一个目标输出就是回看候选；若它不是 air/合法朝向则失败，不静默跳到更晚的 air。
  const precedingTargetOutputs = d.exec.visionCalls
    .filter((c) => c.seq > returnMove.seq && c.seq < revealVision.seq)
    .flatMap((c) => {
      const output = visionOutputAt(c, target);
      return output ? [output.name] : [];
    });
  // 真实 toObservation 输入只有 sequence=observationId；originObservationId 未填，
  // 不能拿它匹配。只在 harness join 用实际 sequence 与原 payload 字段核对。
  const revealBatch = d.exec.mapBatches.find((b) => b.seq > revealVision.seq
    && b.observations.some((o) => observationMatchesVision(o, target, revealOutput)));
  if (!revealBatch) throw new Error('W5 回看未形成实际 map ChangeReport');
  const revealObserve = d.exec.observes.find((o) => o.reportId !== null && o.reportId === revealBatch.reportId && o.enterSeq > revealBatch.seq);
  if (!revealObserve) throw new Error('W5 回看 report 未被同一活跃 loop.observe 消费');
  if (revealObserve.ownerTaskId !== taskId || revealObserve.delegationId !== delegationId) {
    throw new Error(`W5 回看不是同一 task/delegation：${revealObserve.ownerTaskId}/${revealObserve.delegationId}`);
  }
  const revealBeforeOutcome = revealObserve.statusBefore?.result?.outcome ?? null;
  const revealAfterOutcome = revealObserve.statusAfter.result?.outcome ?? null;
  if (revealObserve.statusBefore?.result !== null || revealObserve.statusBefore?.activeStepIndex !== 2) {
    throw new Error('W5 回看不在返程 step2 活动段');
  }
  // 本次合法 report 可以让 loop 在 observe 内进入 FAILED/BLOCKED；这只要求
  // before 仍在途，after 的终态由下方真实 Nav/全部键断言另行核对。

  const o = await awaitOrTimeout(done, 20_000, 'W5 完成');
  const nav = navFromResult(o.result);
  const cellAfter = cellEvidenceSnapshot(map.cellAt(dim, target.x, target.y, target.z));
  const revealBody = revealVision.eye;
  const moves = ownMoves();
  const startedStepIndexes = [...new Set(moves.map((m) => {
    const match = /-step-(\d+)$/.exec(m.executionId);
    return match ? Number(match[1]) : -1;
  }))].sort((a, b) => a - b);
  const observedBeforeRoute = revealObserve.statusBefore?.route ?? null;
  const routeProof: W5RouteProof = {
    before: observedBeforeRoute,
    after: revealObserve.statusAfter?.route ?? null,
    totalSteps: observedBeforeRoute?.stepCount ?? 0,
    step3Started: startedStepIndexes.includes(3),
    moveExecutionIds: moves.map((m) => m.executionId),
    moveCount: moves.length,
    startedStepIndexes,
  };
  const finalKeys = snapshotKeys(ctx.bot);
  const terminal: W5Terminal = {
    navPresent: nav !== undefined,
    outcome: nav?.outcome ?? null,
    confirmed: nav !== undefined ? nav.confirmed : null,
    problemKind: nav?.problem?.kind ?? null,
    lastPosition: nav?.lastPosition ? { ...nav.lastPosition } : null,
    allKeysReleased: allKeysReleased(finalKeys),
  };
  const chain = checkW5HiddenReveal({
    taskId,
    delegationId,
    stoneMapId: mapId,
    removalSeq: issueSeq,
    hidden,
    cellBefore,
    cellDuring,
    returnMove: {
      seq: returnMove.seq,
      executionId: returnMove.executionId,
      from: { ...returnMove.from },
      to: { ...returnMove.to },
    },
    reveal: {
      seq: revealVision.seq,
      frame: revealVision.frame,
      name: revealOutput.name,
      mapId: revealBatch.mapId,
      observedAt: revealOutput.observedAt,
      eye: revealVision.eye,
      targetInFov: targetInFovOf(revealVision.eye),
      precedingTargetOutputs,
    },
    revealBatch: {
      seq: revealBatch.seq,
      mapId: revealBatch.mapId,
      reportId: revealBatch.reportId,
      targetChanged: reportTouchesCell(revealBatch.report, target),
    },
    revealObserve: {
      reportId: revealObserve.reportId,
      ownerTaskId: revealObserve.ownerTaskId,
      delegationId: revealObserve.delegationId,
      enterSeq: revealObserve.enterSeq,
      statusBeforeOutcome: revealBeforeOutcome,
      statusBeforeActiveStepIndex: revealObserve.statusBefore?.activeStepIndex ?? null,
      statusAfterOutcome: revealAfterOutcome,
      statusAfterActiveStepIndex: revealObserve.statusAfter.activeStepIndex,
    },
    routeProof,
    terminal,
  });
  if (!chain.ok) throw new Error(`W5 隐藏→回看链不成立：${chain.reason}`);
  if (!cellAfter.observed || !isAirBlockName(cellAfter.name ?? '')) throw new Error(`W5 回看后 cellAt 不是 air：${JSON.stringify(cellAfter)}`);
  if (cellAfter.observedAt === undefined || cellAfter.observedAt < revealOutput.observedAt) {
    throw new Error('W5 cellAt 新证据早于真实回看 observedAt');
  }
  if (cellAfter.revision === undefined || cellBefore.revision === undefined || cellAfter.revision <= cellBefore.revision) {
    throw new Error(`W5 cellAt revision 未推进：before=${cellBefore.revision} after=${cellAfter.revision}`);
  }
  if (cellAfter.sequence === undefined || cellAfter.sequence < revealOutput.observationId) {
    throw new Error(`W5 cellAt sequence 未连接到真实回看：${cellAfter.sequence} < ${revealOutput.observationId}`);
  }

  rconDiag.firstObservation = { seq: revealVision.seq, ts: revealVision.ts, frame: revealVision.frame };
  rconDiag.observedBeforeResponse = revealVision.seq < responseSeq;

  ev.extra = {
    ...ev.extra,
    taskId, delegationId, mapId,
    initialStone: {
      visionSeq: initial.vision.seq, mapSeq: initial.batch.seq, frame: initial.vision.frame,
      name: initial.observed.name, observedAt: initial.observed.observedAt, observationId: initial.observed.observationId,
      body: initial.body, bodyLabel: 'selection-time', selectedAt: initial.selectedAt, eye: initial.vision.eye,
    },
    forward: {
      body: bodyAtIssue, eye: eyeAtIssue, targetYaw: forward.targetYaw, targetPitch: forward.targetPitch,
      angularDifference: angularDistance(forward.eye.yaw, forward.targetYaw),
      hFovHalfRad: visionHfovRad / 2,
      candidates, targetInCandidates: false,
    },
    initialCell,
    cellBefore, cellDuring, cellAfter,
    hidden: { ...hidden, visionSeqs: hiddenCalls.map((c) => c.seq), batchSeqs: hiddenMaps.map((b) => b.seq) },
    returnMove: { seq: returnMove.seq, executionId: returnMove.executionId, from: returnMove.from, to: returnMove.to, ts: returnMove.ts },
    // 拆除前的旧路线快照仅作原诊断保留；判定用的是同一次 revealObserve 的前后状态。
    beforeRemovalRoute: beforeRoute,
    routeProof,
    terminal,
    moves: moves.map((m) => ({ seq: m.seq, executionId: m.executionId, from: m.from, to: m.to })),
    reveal: {
      visionSeq: revealVision.seq, visionFrame: revealVision.frame, visionTs: revealVision.ts,
      positions: revealVision.positions, eye: revealBody, output: revealOutput,
      targetInFov: targetInFovOf(revealVision.eye),
      precedingTargetOutputs,
      batchSeq: revealBatch.seq, mapId: revealBatch.mapId, reportId: revealBatch.reportId,
      reportTouchesTarget: reportTouchesCell(revealBatch.report, target),
      observeEnterSeq: revealObserve.enterSeq, observeExitSeq: revealObserve.exitSeq,
      observeStatusBefore: revealObserve.statusBefore, observeStatusAfter: revealObserve.statusAfter,
    },
    final: {
      status: o.result.status, failureCode: o.result.failureCode, summary: o.result.summary,
      outcome: nav?.outcome, problem: nav?.problem, lastPosition: nav?.lastPosition,
      activeStepIndex: latestRouteStatus(d.exec, taskId, delegationId)?.activeStepIndex ?? null,
      finalKeys,
    },
  };
  ev.verdict = 'PASS';
}

/** W6：移动中取消并立即交接给新 walk 任务；按 eventSeq 检查旧回调复活/清键与样本归属。 */
async function scenarioW6(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const lane = WALK_LANE;
  ev.extra = { lane };
  await buildSupportFixture(ctx.rcon, ev, { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax }, lane.feetY, lane.material);
  await teleportAndSettle(ctx, ev, lane.start, 'W6 步行道起点');

  const routeA = Array.from({ length: 10 }, (_, i) => ({ x: lane.start.x + i, y: lane.feetY, z: lane.start.z }));
  const a = startWalkTask(ctx, d, routeA, Date.now() + 30_000);
  if ('error' in a) throw new Error(`W6 任务A启动失败：${a.error}`);
  const aDone = a.done;
  const moveStart = ctx.adapter.state().pos;
  await waitFor(() => dist2(ctx.adapter.state().pos, moveStart) > 0.5, 15_000, 'W6 任务A开始移动');

  snapControl(ctx, 'before-arbiter-cancel', ev);
  const cancelSeq = markTimeline(d, 'arbiter-cancel', a.task.id);
  ctx.arbiter.cancel('W6 取消并交接');
  snapControl(ctx, 'after-arbiter-cancel', ev);

  // B 启动/接管前：真实取消后全部 7 键必须为 false。合法的 Arbiter.cancel →
  // production stopAll 释放即可，不要求此处由 body 独自释放，也不用 harness fallback。
  const keysAfterCancel = snapshotKeys(ctx.bot);
  const stopAfterCancel = [...d.diag.stopAlls].reverse().find((s) =>
    s.kind === 'production' && s.recentBodyOwnerTaskId === a.task.id && s.seqBefore > cancelSeq);
  ev.extra = {
    ...ev.extra,
    cancelSeq,
    keysAfterCancel,
    stopAllAfterCancel: stopAfterCancel
      ? { seqBefore: stopAfterCancel.seqBefore, seqAfter: stopAfterCancel.seqAfter, keysBefore: stopAfterCancel.keysBefore, keysAfter: stopAfterCancel.keysAfter }
      : null,
    taskBRun: false,
  };
  if (!stopAfterCancel) throw new Error('W6 取消后未捕获任务A的生产 stopAll 释放');
  if (!allKeysReleased(stopAfterCancel.keysAfter)) {
    throw new Error(`W6 取消后生产 stopAll keysAfter 仍有残留：${JSON.stringify(stopAfterCancel.keysAfter)}`);
  }
  if (!allKeysReleased(keysAfterCancel)) {
    throw new Error(`W6 取消后真实全键仍有残留：${JSON.stringify(keysAfterCancel)}`);
  }

  // B 立刻从取消后的真实实测 handoff x/y/z 开始（不沿用 A 起点、不硬编码 y）。
  const handoff = { ...ctx.adapter.state().pos };
  const routeB = [
    { x: handoff.x, y: handoff.y, z: handoff.z },
    { x: handoff.x + 1, y: handoff.y, z: handoff.z },
    { x: handoff.x + 2, y: handoff.y, z: handoff.z },
  ];
  const b = startWalkTask(ctx, d, routeB, Date.now() + 30_000);
  if ('error' in b) throw new Error(`W6 任务B启动失败：${b.error}`);
  const bDone = b.done;

  // B 接管边界取 B 的真实 walkBody 创建事件（eventSeq），不是调用时的 arbiter.current。
  const bBody = [...d.diag.bindings].reverse().find((x) => x.kind === 'body' && x.ownerTaskId === b.task.id);
  if (!bBody) throw new Error('W6 未捕获任务B的 body 创建绑定');
  const takeoverSeq = bBody.seq;
  markTimeline(d, 'task-B-body-bound', b.task.id);

  // 两个 done promise 都在 await 之前持有，避免丢失快的 B 事件；有界等待两者落定。
  const [oA, oB] = await awaitOrTimeout(Promise.all([aDone, bDone]), 60_000, 'W6 A/B 完成');
  snapControl(ctx, 'after-both-complete', ev);

  const taskIds = d.tasks.outcomes.map((r) => r.task.id);
  if (!taskIds.includes(a.task.id) || !taskIds.includes(b.task.id)) throw new Error('W6 两个任务的 done 结果未完整保存');

  // A：CANCELLED / confirmed=false / 保留与最后有效原始样本一致的 partial。
  if (oA.result.status !== 'cancelled') throw new Error(`W6 任务A未以 cancelled 结束：status=${oA.result.status} 摘要=${oA.result.summary}`);
  const navA = navFromResult(oA.result);
  if (!navA || navA.outcome !== 'CANCELLED' || navA.confirmed !== false) throw new Error(`W6 任务A终态非 CANCELLED/unconfirmed：${navA?.outcome}`);
  if (!hasPartialPosition(navA)) throw new Error('W6 任务A取消未保留实测部分位移（lastPosition 缺失）');
  const aStart = d.exec.routeCalls.find((c) => c.op === 'start' && c.ownerTaskId === a.task.id);
  if (!aStart?.delegationId) throw new Error('W6 未捕获任务A的真实 delegation');
  const aAccepted = acceptedMeasurements(d.exec.deliveredSamples, a.task.id, aStart.delegationId);
  const aLast = aAccepted[aAccepted.length - 1];
  if (!aLast) throw new Error('W6 任务A无被公开状态证明的实测样本');
  if (!vecEqual(navA.lastPosition, aLast.sample.pos)) throw new Error('W6 任务A partial 与最后有效原始样本位置不一致');
  const aObs = navA.lastObservation;
  if (!aObs) throw new Error('W6 任务A partial 缺少 lastObservation');
  if (aObs.observedAt !== aLast.sample.observedAt
    || aObs.worldId !== aLast.sample.worldId || aObs.dim !== aLast.sample.dim || aObs.sessionId !== aLast.sample.sessionId) {
    throw new Error('W6 任务A lastObservation 的原始时间/scope 与最后有效样本不一致');
  }

  // B：ARRIVED/confirmed/容差/着地干燥；B 的段与交付样本不得混入旧 A 来源。
  if (oB.result.status !== 'succeeded') throw new Error(`W6 任务B未成功：status=${oB.result.status} 摘要=${oB.result.summary}`);
  const navB = navFromResult(oB.result);
  const bArrival = assertArrivedAt(navB, routeB[routeB.length - 1]!, handoff.y, 'W6 B');
  const bStart = d.exec.routeCalls.find((c) => c.op === 'start' && c.ownerTaskId === b.task.id);
  if (!bStart?.delegationId) throw new Error('W6 未捕获任务B的真实 delegation');
  const bSegments = checkTaskSegments(d.exec.moves, bStart.delegationId, b.task.id, 2);
  if (!bSegments.ok) throw new Error(`W6 任务B段集合不合法：${bSegments.reason}`);
  const bCompletions = measuredCompletions(d.exec.deliveredSamples, b.task.id, bStart.delegationId);
  if (bCompletions.length !== 2) throw new Error(`W6 任务B实测到达完成点 ${bCompletions.length} != 2`);
  if (!segmentsFollowMeasured(bSegments.segments, bCompletions)) throw new Error('W6 任务B段间未从实测完成点严格接续');
  const foreign = foreignSampleDeliveries(d.exec.deliveredSamples, bStart.delegationId, b.task.id);
  if (foreign.length > 0) throw new Error(`W6 任务B delegation 混入 ${foreign.length} 条错误归属样本`);

  // B 活动窗口 = B body 绑定之后、B 真实 public 终态之前；此窗口没有任何授权的
  // cancel/pause/disconnect，出现生产 stopAll 即视为旧 A 迟到清理，必须拒绝。
  const bTerminalSeq = publicRouteTerminalSeq(d.exec.routeCalls, d.exec.deliveredSamples, b.task.id, bStart.delegationId);
  if (bTerminalSeq === null) throw new Error('W6 未捕获任务B的真实公开终态');
  const stopAllsDuringB = productionStopAllsInWindow(d.diag.stopAlls, takeoverSeq, bTerminalSeq);
  if (stopAllsDuringB.length > 0) {
    throw new Error(`W6 任务B活动窗口内出现 ${stopAllsDuringB.length} 次未授权生产 stopAll：${JSON.stringify(stopAllsDuringB.map((s) => ({ seqBefore: s.seqBefore, keysAfter: s.keysAfter })))}`);
  }

  const bRelease = assertProductionRelease(d.diag.stopAlls, b.task.id, snapshotKeys(ctx.bot), 'W6 B');

  // 旧 A 实际控制边界：取消后实际复活拒绝；B 接管后任何 A 真实 set/clear 拒绝。
  const violations = classifyOldOwnerControls(d.diag.actualControls, a.task.id, { cancelSeq, takeoverSeq });
  if (violations.revived.length > 0) {
    throw new Error(`W6 旧任务A在取消后实际复活按键 ${violations.revived.length} 次：${JSON.stringify(violations.revived.map((c) => ({ seq: c.seq, name: c.name, keysAfter: c.keysAfter })))}`);
  }
  if (violations.afterTakeover.length > 0) {
    throw new Error(`W6 旧任务A在B接管后仍有 ${violations.afterTakeover.length} 次实际控制：${JSON.stringify(violations.afterTakeover.map((c) => ({ seq: c.seq, op: c.op, name: c.name, value: c.value })))}`);
  }
  // 旧 A tick 的迟到交付本身允许（会被丢弃），只要求它没有提交进 B 的 delegation/segment。
  const oldTicksAfterCancel = d.diag.ticks.filter((t) => t.ownerTaskId === a.task.id && t.seqEnd > cancelSeq && t.delivered);

  ev.extra = {
    ...ev.extra,
    taskA: a.task.id, taskB: b.task.id, taskBRun: true,
    cancelSeq, takeoverSeq, handoff, bTerminalSeq,
    stopAllsDuringB: stopAllsDuringB.length,
    finalKeys: snapshotKeys(ctx.bot),
    delegationA: aStart.delegationId, delegationB: bStart.delegationId,
    aPartial: { lastPosition: navA.lastPosition, lastObservation: navA.lastObservation, acceptedSamples: aAccepted.length },
    bArrival: {
      horizontalError: Number(bArrival.horizontalError.toFixed(3)), feetError: Number(bArrival.feetError.toFixed(3)),
      onGround: bArrival.obs.onGround, inWater: bArrival.obs.inWater, acceptedSamples: acceptedMeasurements(d.exec.deliveredSamples, b.task.id, bStart.delegationId).length,
    },
    oldARevived: violations.revived.map((c) => ({ seq: c.seq, name: c.name, keysAfter: c.keysAfter })),
    oldAPreTakeoverNonRevival: violations.releasedBeforeTakeover.map((c) => ({ seq: c.seq, op: c.op, name: c.name, value: c.value })),
    oldATickDeliveriesAfterCancel: oldTicksAfterCancel.length,
    stopAllSeqB: { before: bRelease.seqBefore, after: bRelease.seqAfter },
  };
  ev.verdict = 'PASS';
}

/** W7：独立超时（7a）、宿主帧交付暂停（7b）、移动中真实断线（7c）；各自独立判定。 */
async function scenarioW7(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const lane = WALK_LANE;
  const y = lane.feetY;
  ev.extra = { lane };
  await buildSupportFixture(ctx.rcon, ev, { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax }, lane.feetY, lane.material);
  await teleportAndSettle(ctx, ev, lane.start, 'W7 步行道起点');

  const subcases: Record<string, { verdict: Verdict; error?: string; [k: string]: unknown }> = {};
  const settleAtStart = (label: string) => teleportAndSettle(ctx, ev, lane.start, label);
  const lineRoute = (count: number) => Array.from({ length: count }, (_, i) => ({ x: lane.start.x + i, y, z: lane.start.z }));
  const ownSegments = (taskId: string, delegationId: string) =>
    d.exec.moves.filter((m) => m.taskId === taskId && m.delegationId === delegationId).map((m) => m.executionId);
  const taskStartRecord = (taskId: string) => d.tasks.starts.find((r) => r.task.id === taskId);
  const taskDoneRecord = (taskId: string) => d.tasks.outcomes.find((r) => r.task.id === taskId);
  let aPass = false;
  let bPass = false;

  // --- 7a：真实全局 deadline（含 12 次预扫与稳定初始化），长路线在 lane 内，超时后保留实测位移 ---
  try {
    await settleAtStart('W7a 起点');
    const startPos = { ...ctx.adapter.state().pos };
    const route = lineRoute(19); // x200.5..x218.5，支撑面 x[200,219)，始终在已建 lane 内
    // 本轮合法 12 次 adapter.look 非 force 预扫实测 6.1~7.3 秒，预算需覆盖该既存正常耗时。
    const budgetMs = 12_000;
    const deadlineMs = Date.now() + budgetMs;
    const listenersBefore = botListenerCounts(ctx.bot);
    const t = startWalkTask(ctx, d, route, deadlineMs);
    if ('error' in t) throw new Error(`W7a 启动失败：${t.error}`);
    const { delegationId } = await awaitRouteStartRecord(d.exec.routeCalls, t.task.id, t.done, 10_000, 'W7a');
    const o = await awaitOrTimeout(t.done, budgetMs + 10_000, 'W7a 完成');
    const doneSeq = markTimeline(d, 'task-done-w7a', t.task.id);
    const doneRecord = taskDoneRecord(t.task.id);
    if (!doneRecord) throw new Error('W7a done 结果未即时保存');
    const nav = navFromResult(o.result);
    const base = {
      taskId: t.task.id, delegationId, request: taskStartRecord(t.task.id)?.request, scope: taskStartRecord(t.task.id)?.scope,
      route, budgetMs, deadlineMs, timeoutObservedAt: doneRecord.doneAt, doneSeq,
      elapsedMs: doneRecord.doneAt - t.task.startedAt,
      status: o.result.status, failureCode: o.result.failureCode, summary: o.result.summary,
      outcome: nav?.outcome, confirmed: nav?.confirmed, lastPosition: nav?.lastPosition,
      segments: ownSegments(t.task.id, delegationId),
    };
    subcases.a = { verdict: 'NOT_RUN', ...base };
    if (o.result.status !== 'failed' || o.result.failureCode !== 'TIMEOUT') {
      throw new Error(`W7a 未以真实 TIMEOUT 失败结束：status=${o.result.status} failureCode=${o.result.failureCode}`);
    }
    if (nav?.outcome !== 'TIMEOUT' || nav.confirmed !== false) {
      throw new Error(`W7a NavResult 非 TIMEOUT/unconfirmed：outcome=${nav?.outcome} confirmed=${nav?.confirmed}`);
    }
    assertTimeoutAfterDeadline(doneRecord.doneAt, deadlineMs, 1500, 'W7a');
    const last = assertRealPartial(nav, d.exec.deliveredSamples, t.task.id, delegationId, startPos, 0.5, 'W7a');
    await waitFor(() => pendingTicksFor(d.diag.ticks, t.task.id).length === 0, 1_000, 'W7a pending tick 解除');
    assertOwnedTicksReleased(d.diag.ticks, t.task.id, 'W7a');
    assertListenerBaseline(listenersBefore, botListenerCounts(ctx.bot), 'W7a');
    const finalKeys = snapshotKeys(ctx.bot);
    if (!allKeysReleased(finalKeys)) throw new Error(`W7a 最终仍有按键未释放：${JSON.stringify(finalKeys)}`);
    subcases.a = {
      ...base, verdict: 'PASS', finalKeys,
      lastValidSample: {
        sequence: last.sample.sequence, observedAt: last.sample.observedAt,
        worldId: last.sample.worldId, dim: last.sample.dim, sessionId: last.sample.sessionId,
        pos: last.sample.pos,
      },
      lastObservation: nav.lastObservation,
    };
    aPass = true;
  } catch (e) {
    subcases.a = { ...(subcases.a ?? {}), verdict: 'FAIL', error: (e as Error)?.message ?? String(e) };
  }

  // --- 7b：宿主帧交付暂停（宿主注入，非服务端停摆）：先证明本 task 有真实 pending 帧等待，
  // 再走真实 Arbiter.setPaused(true) 暂停；暂停取消旧 loop、生命周期报告使旧 OPEN 失效，
  // 无新帧/新 Vision 时证据格 STALE；physics 仍关闭时真实 resume 且不伪复鲜。 ---
  if (!aPass) {
    subcases.b = { verdict: 'NOT_RUN', note: 'W7a 未通过；不继续不安全的后续子case' };
  } else {
    try {
      await settleAtStart('W7b 起点');
      const startPos = { ...ctx.adapter.state().pos };
      const route = lineRoute(12);
      const listenersBefore = botListenerCounts(ctx.bot);
      const t = startWalkTask(ctx, d, route, Date.now() + 30_000);
      if ('error' in t) throw new Error(`W7b 启动失败：${t.error}`);
      const { delegationId } = await awaitRouteStartRecord(d.exec.routeCalls, t.task.id, t.done, 10_000, 'W7b');
      const done = t.done;
      await waitFor(
        () => ctx.arbiter.current?.id === t.task.id
          && publicRouteTerminalSeq(d.exec.routeCalls, d.exec.deliveredSamples, t.task.id, delegationId) === null
          && acceptedMovementBeyond(d.exec.deliveredSamples, t.task.id, delegationId, startPos, 0.5) !== undefined,
        15_000, 'W7b 本 task 活跃已接受测量开始移动',
      );
      const acceptedBeforePause = acceptedMeasurements(d.exec.deliveredSamples, t.task.id, delegationId).length;
      snapControl(ctx, 'before-paused-frame-cancel', ev);
      const framesBefore = d.recorder.frames.length;
      ctx.bot.physicsEnabled = false; // 宿主帧注入：暂停 physicsTick，服务端仍在运行。
      const pausedAt = Date.now();
      // 等待开始时就已建好的 tick；必须确认它属于本 task 且仍未完成，而不是等一段时间后假定。
      await waitFor(() => pendingTicksFor(d.diag.ticks, t.task.id).length > 0, 2_000, 'W7b 真实 pending walkTick');
      const pendingAtPause = pendingTicksFor(d.diag.ticks, t.task.id)[0]!;
      const holdMs = 300;
      await new Promise((r) => setTimeout(r, holdMs));
      const stillPending = pendingTicksFor(d.diag.ticks, t.task.id).find((p) => p.seqStart === pendingAtPause.seqStart);
      const framesDuringHold = d.recorder.frames.length - framesBefore;
      if (!stillPending) throw new Error('W7b 保持期间 pending 等待已解除，无法证明无新帧等待');
      if (framesDuringHold !== 0) throw new Error(`W7b 暂停期间仍有 ${framesDuringHold} 帧送达`);
      // 这些监听器由真实 walkTick 在等待开始时同步注册：按函数身份确认本 tick 各自新增。
      if (pendingAtPause.ownedPhysicsTickAdded < 1) {
        throw new Error(`W7b pending 等待未新增本 tick 的 physicsTick 监听器：${pendingAtPause.diagId}`);
      }
      if (pendingAtPause.ownedEndAdded < 1) {
        throw new Error(`W7b pending 等待未新增本 tick 的 end 监听器：${pendingAtPause.diagId}`);
      }
      if (pendingAtPause.ownedAbortAdded < 1) {
        throw new Error(`W7b pending 等待未新增本 tick 的 abort 监听器：${pendingAtPause.diagId}`);
      }
      // 暂停前只从本 task 真实开始后、由真实 Vision typed payload 写入同一 svc.voxel 的
      // 批次中取一个当前 FRESH 格；不复用 W7a 旧证据，也不从诊断投影重建。
      const w7bVisionCalls = d.exec.visionCalls.filter((c) => c.ts >= t.task.startedAt);
      const w7bBatches = d.exec.mapBatches
        .filter((b) => b.ts >= t.task.startedAt)
        .map((b) => ({ ...mapBatchForEvidence(b), mapIsSessionVoxel: b.map === ctx.spatial.session.voxel }));
      const witness = pickSpatialWitness([{ visionCalls: w7bVisionCalls, mapBatches: w7bBatches }], ctx.spatial.session.voxel);
      if (!witness) throw new Error('W7b 暂停前未找到本任务真实 Vision 写入同一 svc.voxel 的证据格');
      if (witness.cell.freshness !== 'FRESH') throw new Error(`W7b 证据格暂停前非 FRESH：${witness.cell.freshness ?? 'missing'}`);
      const readWitnessCell = () => cellEvidenceSnapshot(
        ctx.spatial.session.voxel.cellAt(witness.block.dimension, witness.block.pos.x, witness.block.pos.y, witness.block.pos.z),
      );
      const witnessCellBefore = readWitnessCell();
      const assertStaleWitness = (label: string, cell: CellEvidenceSnapshot) => {
        if (cell.freshness !== 'STALE') throw new Error(`${label} 证据格 freshness=${cell.freshness ?? 'missing'} 不是 STALE`);
        const before = witness.cell;
        if (cell.name !== before.name
          || JSON.stringify(cell.properties ?? {}) !== JSON.stringify(before.properties ?? {})
          || cell.observedAt !== before.observedAt
          || cell.sequence !== before.sequence
          || cell.originObservationId !== before.originObservationId
          || cell.sessionId !== before.sessionId) {
          throw new Error(`${label} 证据格原 state/properties/时间/sequence/session 未保持`);
        }
      };
      const statusBeforePause = latestRouteStatus(d.exec, t.task.id, delegationId);
      const oldOpenSteps = statusBeforePause?.route?.steps
        .flatMap((step, index) => step.kind === 'verified' && step.status === 'OPEN' ? [index] : []) ?? [];
      if (oldOpenSteps.length === 0) throw new Error('W7b 暂停前没有公开 route OPEN 步骤可供失效证明');
      const sharedPause: Record<string, unknown> = {
        witnessSource: {
          worldId: witness.block.worldId, dim: witness.block.dimension, sessionId: witness.block.sessionId,
          pos: { ...witness.block.pos }, name: witness.block.name, properties: { ...witness.block.properties },
          stateComplete: witness.block.stateComplete, observedAt: witness.block.observedAt,
          observationId: witness.block.observationId,
          vision: { seq: witness.vision.seq, ts: witness.vision.ts, frame: witness.vision.frame, visionId: witness.vision.visionId },
          batch: {
            seq: witness.batch.seq, mapId: witness.batch.mapId, mapWorldId: witness.batch.mapWorldId,
            reportId: witness.batch.reportId, mapIsSessionVoxel: true,
          },
        },
        witnessCellBefore,
        routeBeforePause: statusBeforePause?.route ?? null,
        oldOpenSteps,
      };
      subcases.b = { verdict: 'NOT_RUN', sharedPause };

      snapControl(ctx, 'before-arbiter-pause-w7b', ev);
      const framesBeforePause = d.recorder.frames.length;
      const visionCallsBeforePause = d.exec.visionCalls.length;
      const observesBeforePause = d.exec.observes.length;
      if (ctx.bot.physicsEnabled) throw new Error('W7b 暂停前 physics 未关闭，无法证明无帧等待');
      const pausedFlagsBefore = { arbiter: ctx.arbiter.paused, spatial: ctx.spatial.paused };
      const cancelSeq = markTimeline(d, 'arbiter-setpaused-true-w7b', t.task.id);
      const cancelTs = Date.now();
      ctx.arbiter.setPaused(true); // 真实 Arbiter 暂停：spatial 生命周期先取消旧 loop，再 cancel/stopAll。
      const pauseReturnSeq = d.seq.next();
      const pauseReturnTs = Date.now();
      const pausedFlagsAfter = { arbiter: ctx.arbiter.paused, spatial: ctx.spatial.paused };
      sharedPause.pause = {
        label: 'arbiter-setPaused(true)', cause: '真实 Arbiter 暂停触发取消（不是 disconnect）',
        markSeq: cancelSeq, callTs: cancelTs, returnSeq: pauseReturnSeq, returnTs: pauseReturnTs,
        flagsBefore: pausedFlagsBefore, flagsAfter: pausedFlagsAfter,
        physicsEnabled: ctx.bot.physicsEnabled,
        framesBeforePause, visionCallsBeforePause, observesBeforePause,
      };
      if (!pausedFlagsAfter.arbiter || !pausedFlagsAfter.spatial) {
        throw new Error(`W7b 暂停后 paused 标志非 true：${JSON.stringify(pausedFlagsAfter)}`);
      }
      if (d.recorder.frames.length !== framesBeforePause) {
        throw new Error(`W7b 暂停调用期间出现 ${d.recorder.frames.length - framesBeforePause} 个新帧`);
      }
      if (d.exec.visionCalls.length !== visionCallsBeforePause) {
        throw new Error(`W7b 暂停调用期间出现 ${d.exec.visionCalls.length - visionCallsBeforePause} 次新 Vision`);
      }
      // 生命周期报告在 loop.cancel 之后同步进入 observe：必须保留为真实 report，
      // 明确非 Vision/mapBatch 来源，并检查同一 this/task 的旧 OPEN 是否被报告失效。
      const lifecycleObserves = d.exec.observes
        .filter((o) => o.enterSeq > cancelSeq && o.ownerTaskId === t.task.id && o.delegationId === delegationId);
      if (lifecycleObserves.length !== 1) {
        throw new Error(`W7b 暂停后应恰好有 1 次生命周期 observe，实际 ${lifecycleObserves.length}`);
      }
      const lifecycle = lifecycleObserves[0]!;
      if (lifecycle.reportSource !== 'unmatched' || lifecycle.mapBatchMatched) {
        throw new Error(`W7b 生命周期报告被错标为 Vision/mapBatch 来源：${lifecycle.reportSource}`);
      }
      if (d.exec.mapBatches.some((b) => b.reportId === lifecycle.reportId)) {
        throw new Error('W7b 生命周期报告编号与 mapBatch 冲突');
      }
      const witnessChange = lifecycle.report.sections
        .flatMap((section) => section.cells)
        .find((change) => sameCell(change.pos, witness.block.pos));
      if (!witnessChange || witnessChange.kind !== 'staled') {
        throw new Error(`W7b 生命周期报告未把证据格标为 staled：${JSON.stringify(witnessChange ?? null)}`);
      }
      const statusAfterLifecycle = lifecycle.statusAfter.route;
      const invalidatedOldOpenSteps = oldOpenSteps.filter((index) => {
        const step = statusAfterLifecycle?.steps[index];
        return !(step?.kind === 'verified' && step.status === 'OPEN');
      });
      if (invalidatedOldOpenSteps.length === 0) {
        throw new Error('W7b 生命周期报告后旧 OPEN 步骤仍全部 OPEN，未证明路线失效');
      }
      sharedPause.lifecycleObserve = {
        enterSeq: lifecycle.enterSeq, exitSeq: lifecycle.exitSeq,
        tsEnter: lifecycle.tsEnter, tsExit: lifecycle.tsExit,
        frameEnter: lifecycle.frameEnter, frameExit: lifecycle.frameExit,
        ownerTaskId: lifecycle.ownerTaskId, delegationId: lifecycle.delegationId,
        reportId: lifecycle.reportId, mapBatchMatched: lifecycle.mapBatchMatched, reportSource: lifecycle.reportSource,
        report: lifecycle.report,
        statusBefore: lifecycle.statusBefore, statusAfter: lifecycle.statusAfter,
        keysBefore: lifecycle.keysBefore, keysAfter: lifecycle.keysAfter,
      };
      sharedPause.routeInvalidation = {
        oldOpenSteps, invalidatedOldOpenSteps,
        invalidatedCountBefore: statusBeforePause?.route?.invalidatedCount ?? null,
        invalidatedCountAfter: statusAfterLifecycle?.invalidatedCount ?? null,
        lifecycleOutcome: lifecycle.statusAfter.result?.outcome ?? null,
      };
      // 无新帧/新 Vision 时只读同一格：应 STALE，原事实/时间/sequence/session 不变。
      const witnessCellAfterPause = readWitnessCell();
      sharedPause.witnessCellAfterPause = witnessCellAfterPause;
      assertStaleWitness('W7b 暂停后', witnessCellAfterPause);
      if (d.exec.observes.length !== observesBeforePause + 1) {
        throw new Error(`W7b 暂停读取不应产生额外 observe：before=${observesBeforePause} after=${d.exec.observes.length}`);
      }

      const o = await awaitOrTimeout(done, 10_000, 'W7b 暂停取消完成');
      const doneSeq = markTimeline(d, 'task-done-w7b', t.task.id);
      const finishedAt = Date.now();
      const framesAtDone = d.recorder.frames.length;
      const nav = navFromResult(o.result);
      const base = {
        taskId: t.task.id, delegationId, request: taskStartRecord(t.task.id)?.request, scope: taskStartRecord(t.task.id)?.scope,
        route, hostInjection: 'bot.physicsEnabled=false（宿主帧注入，非服务端停摆）',
        holdMs, framesBefore, framesDuringHold, framesAtDone, pausedAt, cancelSeq, cancelTs, finishedAt, doneSeq,
        elapsedMs: finishedAt - t.task.startedAt,
        pendingTick: {
          diagId: pendingAtPause.diagId, seqStart: pendingAtPause.seqStart, tsStart: pendingAtPause.tsStart,
          signalAbort: [pendingAtPause.signalAbortListenersAtStart, pendingAtPause.signalAbortListenersWhilePending, pendingAtPause.signalAbortListenersAtEnd],
          physicsTick: [pendingAtPause.botPhysicsTickListenersAtStart, pendingAtPause.botPhysicsTickListenersWhilePending, pendingAtPause.botPhysicsTickListenersAtEnd],
          end: [pendingAtPause.botEndListenersAtStart, pendingAtPause.botEndListenersWhilePending, pendingAtPause.botEndListenersAtEnd],
          ownedAdded: {
            abort: pendingAtPause.ownedAbortAdded,
            physicsTick: pendingAtPause.ownedPhysicsTickAdded,
            end: pendingAtPause.ownedEndAdded,
          },
        },
        status: o.result.status, outcome: nav?.outcome, confirmed: nav?.confirmed,
        lastPosition: nav?.lastPosition, segments: ownSegments(t.task.id, delegationId),
      };
      subcases.b = { verdict: 'NOT_RUN', ...base, sharedPause };
      if (framesAtDone !== framesBefore) throw new Error(`W7b 取消完成前仍有 ${framesAtDone - framesBefore} 帧送达`);
      if (o.result.status !== 'cancelled') throw new Error(`W7b 暂停帧后未以 cancelled 结束：status=${o.result.status}`);
      if (nav?.outcome !== 'CANCELLED' || nav.confirmed !== false) {
        throw new Error(`W7b NavResult 非 CANCELLED/unconfirmed：outcome=${nav?.outcome} confirmed=${nav?.confirmed}`);
      }
      const last = assertRealPartial(nav, d.exec.deliveredSamples, t.task.id, delegationId, startPos, 0.5, 'W7b');
      // 真实 Arbiter.setPaused(true) → spatial 生命周期取消 → production stopAll 是合法权限撤销：
      // 只要求 keysAfter/最终键释放，不要求 keysBefore。
      const stopAfterCancel = d.diag.stopAlls.find((s) => s.kind === 'production' && s.seqBefore > cancelSeq && s.recentBodyOwnerTaskId === t.task.id);
      if (!stopAfterCancel) throw new Error('W7b 未捕获取消后的生产 stopAll');
      if (!allKeysReleased(stopAfterCancel.keysAfter)) throw new Error(`W7b production stopAll keysAfter 仍有残留：${JSON.stringify(stopAfterCancel.keysAfter)}`);
      const finalKeys = snapshotKeys(ctx.bot);
      if (!allKeysReleased(finalKeys)) throw new Error(`W7b 最终仍有按键未释放：${JSON.stringify(finalKeys)}`);
      const lateMoves = d.exec.moves.filter((m) => m.taskId === t.task.id && m.delegationId === delegationId && m.seq > cancelSeq);
      if (lateMoves.length > 0) throw new Error(`W7b 取消后仍有 ${lateMoves.length} 个旧段启动：${JSON.stringify(lateMoves.map((m) => m.executionId))}`);
      await waitFor(() => pendingTicksFor(d.diag.ticks, t.task.id).length === 0, 1_000, 'W7b pending tick 解除');
      assertOwnedTicksReleased(d.diag.ticks, t.task.id, 'W7b');
      assertListenerBaseline(listenersBefore, botListenerCounts(ctx.bot), 'W7b');

      // 取消/监听/键证据完成后，physics 仍关闭时真实 resume：不调用 observe、不更新时间，
      // 再读同一格仍 STALE 且原事实保持，证明无观测 pause/resume gap 真实成立。
      const framesBeforeResume = d.recorder.frames.length;
      const visionCallsBeforeResume = d.exec.visionCalls.length;
      const observesBeforeResume = d.exec.observes.length;
      const pausedFlagsBeforeResume = { arbiter: ctx.arbiter.paused, spatial: ctx.spatial.paused };
      if (!pausedFlagsBeforeResume.arbiter || !pausedFlagsBeforeResume.spatial) {
        throw new Error(`W7b resume 前 paused 标志非 true：${JSON.stringify(pausedFlagsBeforeResume)}`);
      }
      if (ctx.bot.physicsEnabled) throw new Error('W7b resume 前 physics 已恢复，无法证明纯暂停 gap');
      const resumeSeq = markTimeline(d, 'arbiter-setpaused-false-w7b', t.task.id);
      const resumeTs = Date.now();
      ctx.arbiter.setPaused(false);
      const resumeReturnSeq = d.seq.next();
      const resumeReturnTs = Date.now();
      const resumedFlags = { arbiter: ctx.arbiter.paused, spatial: ctx.spatial.paused };
      const witnessCellAfterResume = readWitnessCell();
      sharedPause.resume = {
        label: 'arbiter-setPaused(false)', markSeq: resumeSeq, callTs: resumeTs,
        returnSeq: resumeReturnSeq, returnTs: resumeReturnTs,
        flagsBefore: pausedFlagsBeforeResume, flagsAfter: resumedFlags,
        physicsEnabled: ctx.bot.physicsEnabled,
        framesBeforeResume, visionCallsBeforeResume, observesBeforeResume,
      };
      sharedPause.witnessCellAfterResume = witnessCellAfterResume;
      if (resumedFlags.arbiter || resumedFlags.spatial) {
        throw new Error(`W7b resume 后 paused 标志非 false：${JSON.stringify(resumedFlags)}`);
      }
      if (d.exec.observes.length !== observesBeforeResume) {
        throw new Error(`W7b resume 不应调用 observe：before=${observesBeforeResume} after=${d.exec.observes.length}`);
      }
      if (d.recorder.frames.length !== framesBeforeResume) {
        throw new Error(`W7b resume 期间出现 ${d.recorder.frames.length - framesBeforeResume} 个新帧`);
      }
      if (d.exec.visionCalls.length !== visionCallsBeforeResume) {
        throw new Error(`W7b resume 期间出现 ${d.exec.visionCalls.length - visionCallsBeforeResume} 次新 Vision`);
      }
      assertStaleWitness('W7b resume 后', witnessCellAfterResume);

      subcases.b = {
        ...base, verdict: 'PASS', finalKeys, sharedPause,
        acceptedBeforePause,
        pendingOwnedResidual: {
          abort: pendingAtPause.ownedAbortResidual,
          physicsTick: pendingAtPause.ownedPhysicsTickResidual,
          end: pendingAtPause.ownedEndResidual,
        },
        stopAll: { seqBefore: stopAfterCancel.seqBefore, seqAfter: stopAfterCancel.seqAfter, keysBefore: stopAfterCancel.keysBefore, keysAfter: stopAfterCancel.keysAfter },
        lastValidSample: {
          sequence: last.sample.sequence, observedAt: last.sample.observedAt,
          worldId: last.sample.worldId, dim: last.sample.dim, sessionId: last.sample.sessionId,
          pos: last.sample.pos,
        },
        lastObservation: nav.lastObservation,
      };
      bPass = true;
    } catch (e) {
      const primary = e;
      // 失败清理：仅在确实仍暂停时真实 resume；该次 resume 标为 harness fallback，
      // 不参与 PASS，失败也单独保留，绝不覆盖原始失败。
      let cleanupResume: Record<string, unknown> | null = null;
      if (ctx.arbiter.paused || ctx.spatial.paused) {
        const fallbackSeq = markTimeline(d, 'harness-fallback-arbiter-setpaused-false-w7b', null);
        const fallbackTs = Date.now();
        let cleanupError: string | null = null;
        try {
          ctx.arbiter.setPaused(false);
        } catch (error) {
          cleanupError = (error as Error)?.message ?? String(error);
        }
        cleanupResume = {
          label: 'harness fallback: arbiter-setPaused(false)', markSeq: fallbackSeq, ts: fallbackTs,
          arbiterPaused: ctx.arbiter.paused, spatialPaused: ctx.spatial.paused, error: cleanupError,
        };
      }
      subcases.b = {
        ...(subcases.b ?? {}),
        verdict: 'FAIL',
        error: (primary as Error)?.message ?? String(primary),
        ...(cleanupResume === null ? {} : { cleanupResume }),
      };
    } finally {
      ctx.bot.physicsEnabled = true;
    }
  }

  // --- 7c：移动中真实断线（只断客户端，服务器存活）：观察 adapter.disconnected + bot.end，保留旧样本 ---
  if (!bPass) {
    subcases.c = { verdict: 'NOT_RUN', note: 'W7b 未通过或取消未收完；不启动断线子case' };
  } else {
    let onAdapterDisconnected: (() => void) | undefined;
    let onBotEnd: (() => void) | undefined;
    try {
      await settleAtStart('W7c 起点');
      const startPos = { ...ctx.adapter.state().pos };
      const route = lineRoute(12);
      const t = startWalkTask(ctx, d, route, Date.now() + 30_000);
      if ('error' in t) throw new Error(`W7c 启动失败：${t.error}`);
      const { delegationId } = await awaitRouteStartRecord(d.exec.routeCalls, t.task.id, t.done, 10_000, 'W7c');
      const done = t.done;
      await waitFor(
        () => ctx.arbiter.current?.id === t.task.id
          && publicRouteTerminalSeq(d.exec.routeCalls, d.exec.deliveredSamples, t.task.id, delegationId) === null
          && acceptedMovementBeyond(d.exec.deliveredSamples, t.task.id, delegationId, startPos, 0.5) !== undefined,
        15_000, 'W7c 本 task 活跃已接受测量开始移动',
      );
      const acceptedBefore = acceptedMeasurements(d.exec.deliveredSamples, t.task.id, delegationId);
      const lastBefore = acceptedBefore[acceptedBefore.length - 1];
      if (!lastBefore) throw new Error('W7c 断线前无被公开状态证明的实测样本');
      snapControl(ctx, 'before-client-disconnect', ev);
      const observed: { adapterDisconnectedSeq: number | null; botEndSeq: number | null } = {
        adapterDisconnectedSeq: null, botEndSeq: null,
      };
      onAdapterDisconnected = () => { observed.adapterDisconnectedSeq = markTimeline(d, 'adapter-disconnected', t.task.id); };
      onBotEnd = () => { observed.botEndSeq = markTimeline(d, 'bot-end', t.task.id); };
      ctx.adapter.on('disconnected', onAdapterDisconnected);
      ctx.bot.on('end', onBotEnd);
      const quitSeq = markTimeline(d, 'adapter-quit', t.task.id);
      const quitTs = Date.now();
      ctx.adapter.quit(); // 只断客户端；共享服务器继续运行。
      const o = await awaitOrTimeout(done, 20_000, 'W7c 断线完成');
      const doneSeq = markTimeline(d, 'task-done-w7c', t.task.id);
      const finishedAt = Date.now();
      const nav = navFromResult(o.result);
      const base = {
        taskId: t.task.id, delegationId, request: taskStartRecord(t.task.id)?.request, scope: taskStartRecord(t.task.id)?.scope,
        route, quitSeq, quitTs, finishedAt, doneSeq, elapsedMs: finishedAt - t.task.startedAt, observed, status: o.result.status, outcome: nav?.outcome,
        confirmed: nav?.confirmed, summary: o.result.summary, lastPosition: nav?.lastPosition,
        lastBefore: lastBefore.sample, segments: ownSegments(t.task.id, delegationId),
      };
      subcases.c = { verdict: 'NOT_RUN', ...base };
      // 任务先 done 不代表断线事件已观察完；在有界窗口内确认本次真实双事件后才撤探针。
      await waitFor(
        () => observed.adapterDisconnectedSeq !== null && observed.botEndSeq !== null,
        5_000,
        'W7c 真实 adapter.disconnected 与 bot.end 双事件',
      );
      assertEndObserved(observed.adapterDisconnectedSeq, observed.botEndSeq, quitSeq, 'W7c');
      if (o.result.status !== 'cancelled') throw new Error(`W7c 断线未以 cancelled 结束：status=${o.result.status} 摘要=${o.result.summary}`);
      if (nav?.outcome !== 'CANCELLED' || nav.confirmed !== false) {
        throw new Error(`W7c NavResult 非 CANCELLED/unconfirmed：outcome=${nav?.outcome} confirmed=${nav?.confirmed}`);
      }
      const last = assertRealPartial(nav, d.exec.deliveredSamples, t.task.id, delegationId, startPos, 0.5, 'W7c');
      if (last.sample.sequence < lastBefore.sample.sequence) throw new Error('W7c 最终有效样本早于断线前已记录样本');
      // production newSession.stopAll 是合法生命周期撤销；只记录并确认其 keysAfter 释放。
      const stopOnDisconnect = d.diag.stopAlls.find((s) => s.kind === 'production' && s.seqBefore > quitSeq && s.recentBodyOwnerTaskId === t.task.id);
      if (!stopOnDisconnect) throw new Error('W7c 未记录断线 newSession 的生产 stopAll');
      if (!allKeysReleased(stopOnDisconnect.keysAfter)) throw new Error(`W7c 断线 stopAll keysAfter 仍有残留：${JSON.stringify(stopOnDisconnect.keysAfter)}`);
      const finalKeys = snapshotKeys(ctx.bot);
      if (!allKeysReleased(finalKeys)) throw new Error(`W7c 最终仍有按键未释放：${JSON.stringify(finalKeys)}`);
      const lateMoves = d.exec.moves.filter((m) => m.taskId === t.task.id && m.delegationId === delegationId && m.seq > quitSeq);
      if (lateMoves.length > 0) throw new Error(`W7c 断线后仍有 ${lateMoves.length} 个旧段启动：${JSON.stringify(lateMoves.map((m) => m.executionId))}`);
      await waitFor(() => pendingTicksFor(d.diag.ticks, t.task.id).length === 0, 1_000, 'W7c pending tick 解除');
      assertOwnedTicksReleased(d.diag.ticks, t.task.id, 'W7c');
      // 真实断线会合法移除原生 once/end 监听器；全局总数相等不能证明归属清理，故只用 owned 残留守门。
      subcases.c = {
        ...base, verdict: 'PASS', finalKeys,
        stopAll: { seqBefore: stopOnDisconnect.seqBefore, seqAfter: stopOnDisconnect.seqAfter, keysBefore: stopOnDisconnect.keysBefore, keysAfter: stopOnDisconnect.keysAfter },
        lastValidSample: {
          sequence: last.sample.sequence, observedAt: last.sample.observedAt,
          worldId: last.sample.worldId, dim: last.sample.dim, sessionId: last.sample.sessionId,
          pos: last.sample.pos,
        },
        lastObservation: nav.lastObservation,
        eventOrder: d.ev.marks
          .filter((m) => m.taskId === t.task.id && ['adapter-quit', 'adapter-disconnected', 'bot-end'].includes(m.label))
          .map((m) => ({ seq: m.seq, ts: m.ts, label: m.label })),
      };
    } catch (e) {
      subcases.c = { ...(subcases.c ?? {}), verdict: 'FAIL', error: (e as Error)?.message ?? String(e) };
    } finally {
      // 无论等待 done 还是等待双事件失败，都只移除本次探针，不改真实事件顺序/处理。
      if (onAdapterDisconnected) ctx.adapter.removeListener('disconnected', onAdapterDisconnected);
      if (onBotEnd) ctx.bot.removeListener('end', onBotEnd);
    }
  }

  ev.extra = { ...ev.extra, subcases };
  const allPass = Object.values(subcases).every((s) => s.verdict === 'PASS');
  if (!allPass) {
    throw new Error(`W7 子场景未全过：${JSON.stringify(Object.fromEntries(Object.entries(subcases).map(([k, s]) => [k, s.verdict])))}`);
  }
  ev.verdict = 'PASS';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 首个选中场景的固定夹具与已确认支撑起点。仅用于「Bot 连接前建场地、spawn 后立即 TP」，
 * 不改变各场景自己的夹具核验与任务起终点。
 */
interface SetupFixture {
  scenario: ScenarioId;
  footprint: { xMin: number; xMax: number; zMin: number; zMax: number };
  feetY: number;
  material: string;
  start: Vec3;
}

function setupFixtureFor(id: ScenarioId): SetupFixture | null {
  if (id === 'W2') {
    const p = W2_PLATFORM;
    return {
      scenario: id,
      footprint: { xMin: p.xMin, xMax: p.xMax, zMin: p.zMin, zMax: p.zMax },
      feetY: p.feetY, material: p.material, start: { ...p.start },
    };
  }
  if (id === 'W4' || id === 'W5') {
    const f = id === 'W4' ? W4_FIXTURE : W5_FIXTURE;
    return {
      scenario: id,
      footprint: { xMin: f.xMin, xMax: f.xMax, zMin: f.zMin, zMax: f.zMax },
      feetY: f.feetY, material: f.material, start: { ...f.start },
    };
  }
  if (id === 'W1' || id === 'W6' || id === 'W7') {
    const lane = WALK_LANE;
    return {
      scenario: id,
      footprint: { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax },
      feetY: lane.feetY, material: lane.material, start: { ...lane.start },
    };
  }
  return null;
}

/** 等待 spawn，超时/断线都清理监听器与定时器。 */
function waitForSpawn(adapter: MineflayerAdapter, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => { cleanup(); resolve(); };
    const onDisconnect = (reason: string) => { cleanup(); reject(new Error(`spawn 前断线：${reason}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('spawn 超时')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      adapter.removeListener('spawn', onSpawn);
      adapter.removeListener('disconnected', onDisconnect);
    };
    adapter.on('spawn', onSpawn);
    adapter.on('disconnected', onDisconnect);
  });
}

interface CleanupError { step: string; message: string }

function errorMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

async function main() {
  if (config.mode !== 'test') throw new Error(`联机验收只允许在 test 环境运行，当前 ${config.mode}`);

  const selector = parseScenarioSelector(process.argv.find((a) => a.startsWith('--scenarios='))?.slice('--scenarios='.length));
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceDir = path.join(config.dataDir, 'walk-acceptance', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const evidence: Record<string, unknown> = {
    schema: 'walk-acceptance',
    provisional: true,
    provisionalNote: '联机验收结果仍为 provisional，待协调者最终 C 证据确认后裁定，不自动宣告 M2 完成',
    mode: config.mode,
    worldId: config.memory.worldId,
    runId,
    startedAt: Date.now(),
    host: {
      mcHost: config.mc.host, mcPort: config.mc.port, username: config.mc.username, version: config.mc.version,
      rconHost: config.observer.rconHost, rconPort: config.observer.rconPort,
      dataDir: config.dataDir,
    },
    arena: ARENA,
    scenarios: {} as Record<ScenarioId, ScenarioEvidence | { verdict: Verdict; note?: string }>,
  };

  const cleanupErrors: CleanupError[] = [];
  let adapter: MineflayerAdapter | null = null;
  let rcon: Rcon | null = null;
  let memory: WorldMemory | null = null;
  let tracker: ConnectionTracker | null = null;
  let arbiter: Arbiter | null = null;
  let spatial: SharedSpatialSession | null = null;
  const spatialDatabasePath = path.join(evidenceDir, 'spatial.sqlite');
  const spatialEvidence: Record<string, unknown> = {
    mode: 'shared',
    databasePath: spatialDatabasePath,
    opened: false,
    anchor: null,
    shutdown: null,
    s3: null,
    // 本 harness 不启动 periodic scheduler；只验证共享服务的最终保存/close/重开读回。
    scheduler: 'not-started',
  };
  evidence.spatial = spatialEvidence;
  const observedScenarios: ScenarioEvidence[] = [];
  let s3Witness: SpatialWitness | null = null;
  let s3Anchor: {
    checkpointId: string;
    voxelRevision: number;
    fragmentRevision: number;
    topologyRevision: number;
    dirty: boolean;
    confirmedId: string | null;
    ts: number;
  } | null = null;

  try {
    evidence.commit = gitMeta();
    evidence.package = packageMeta();

    const bus = new EventBus();
    adapter = new MineflayerAdapter(config, bus);
    // 与 main 一致：共享空间记忆先于 Bot 连接真实打开；本轮证据只写入本 run 的 DB。
    spatial = await SharedSpatialSession.open({
      worldId: config.memory.worldId,
      databasePath: spatialDatabasePath,
      timeoutMs: 5000,
    });
    spatialEvidence.opened = true;
    // S3 anchor：Bot 连接/任何真实 Vision 之前，对空库做一次显式保存，记录真实 id/revisions/dirty。
    // 这不是伪造事实；后续 witness 相对该空 anchor 必须是实际新增。
    const anchorCheckpoint = await spatial.checkpoint();
    const anchorState = spatial.getPersistenceState();
    s3Anchor = {
      checkpointId: anchorCheckpoint.checkpointId,
      voxelRevision: anchorCheckpoint.voxelRevision,
      fragmentRevision: anchorCheckpoint.fragmentRevision,
      topologyRevision: anchorCheckpoint.topologyRevision,
      dirty: anchorState.dirty,
      confirmedId: anchorState.lastConfirmedCheckpointId,
      ts: Date.now(),
    };
    spatialEvidence.anchor = { ...s3Anchor, worldId: anchorCheckpoint.worldId };
    if (anchorState.dirty || anchorState.lastConfirmedCheckpointId !== anchorCheckpoint.checkpointId) {
      throw new Error(`S3 空 anchor 未确认为干净 checkpoint：dirty=${anchorState.dirty} confirmed=${anchorState.lastConfirmedCheckpointId}`);
    }
    // 合法的 Vision 观测写入只经由这个共享服务；harness 不另造观察者或第二次 observeBatch。
    const vision = new Vision(adapter, config.vision, spatial);
    memory = new WorldMemory(path.join(evidenceDir, 'world-memory.json'));
    arbiter = new Arbiter(adapter, memory, bus, vision, spatial);
    rcon = new Rcon(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);
    tracker = new ConnectionTracker(adapter);

    const expected = new Set([config.observer.player, ...config.observer.admins, config.mc.username].filter(Boolean));

    const preflight = await rconPreflight(rcon, expected);
    evidence.preflight = preflight;
    if (!preflight.ok) throw new Error(`RCON 预检未通过：重复Bot=${preflight.duplicateBot} 意外在线=${JSON.stringify(preflight.unexpected)} 在线=${JSON.stringify(preflight.occupants)}`);

    // RCON 已证实无重复/意外在线后、Bot 连接前，先准备首个选中场景的固定夹具。
    // 这样 spawn 时落点已有支撑，避免上一轮流体测试留下的危险位置让 setup 期间溺水/漂移。
    const firstSelected = ALL_SCENARIOS.find((id) => !UNSUPPORTED.includes(id) && selector.includes(id));
    const setupFixture = firstSelected ? setupFixtureFor(firstSelected) : null;
    const setupEv: FixtureEvidence = { extra: {} };
    if (firstSelected && setupFixture) {
      // 「0 玩家后、连接前建场地」：预期管理员在线也不满足该门槛。
      if (preflight.occupants.length !== 0) {
        throw new Error(`建场前服务器仍有玩家在线（要求 0）：${JSON.stringify(preflight.occupants)}`);
      }
      // 先挂同一个 extra 记录引用；中途失败时已发出的 RCON 命令/响应也会保留在证据里。
      const preSetup: Record<string, unknown> = {
        scenario: firstSelected,
        start: setupFixture.start,
        setup: setupEv.extra,
      };
      evidence.preSetup = preSetup;
      await buildSupportFixture(rcon, setupEv, setupFixture.footprint, setupFixture.feetY, setupFixture.material);
      preSetup.fixture = setupEv.extra?.fixture;
      preSetup.fixtureOps = setupEv.extra?.fixtureOps;
    }

    const spawnPromise = waitForSpawn(adapter, 30_000);
    adapter.connect();
    await spawnPromise;

    const ctx: HarnessContext = { bot: adapter.bot as Bot, adapter, arbiter, vision, spatial, rcon, evidenceDir, runId };
    if (setupFixture) {
      // spawn 后立即用测试控制端 TP 到已确认支撑的固定起点，再稳定定位。
      // 先挂引用，TP/稳定失败时已发出的原始命令与响应也不会丢。
      const preSetupRecord = evidence.preSetup as Record<string, unknown>;
      preSetupRecord.teleportEvidence = setupEv.extra;
      await teleportAndSettle(ctx, setupEv, setupFixture.start, 'pre-setup 起点');
      preSetupRecord.teleports = setupEv.extra?.teleports;
    }
    await waitFor(() => adapter!.state().observationReady, 30_000, 'observationReady');
    const scenarioMap: Partial<Record<ScenarioId, (c: HarnessContext, d: ScenarioDiag) => Promise<void>>> = {
      W1: scenarioW1, W2: scenarioW2, W4: scenarioW4, W5: scenarioW5, W6: scenarioW6, W7: scenarioW7,
    };

    let stopped = false;
    for (const id of ALL_SCENARIOS) {
      const scenarios = evidence.scenarios as Record<string, unknown>;
      if (UNSUPPORTED.includes(id)) {
        scenarios[id] = { verdict: 'NOT_RUN', note: id === 'W3' ? '引用 C1 离线 irregular 子步矩阵证据（真实持续前 8 帧 onGround=false，随后恢复），本轮不联机运行' : '留待下一阶段' };
        continue;
      }
      if (stopped) { scenarios[id] = { verdict: 'NOT_RUN', note: '前一场景清理失败，已停止后续场景' }; continue; }
      if (!selector.includes(id)) { scenarios[id] = { verdict: 'NOT_RUN', note: '未选择' }; continue; }
      const ev = await runScenario(ctx, (d) => scenarioMap[id]!(ctx, d));
      scenarios[id] = ev;
      observedScenarios.push(ev);
      if (ev.cleanupError) stopped = true;
    }
  } catch (e) {
    evidence.fatalError = errorMessage(e);
  } finally {
    if (adapter?.bot) { try { (adapter.bot as Bot).physicsEnabled = true; } catch (e) { cleanupErrors.push({ step: 'restore-physics', message: errorMessage(e) }); } }
    // S3 witness：从本轮全部真实场景记录里取最后一个「实际 Vision 返回且已写入同一
    // svc.voxel」的合法事实；不写图、不另造 observer，也不用 RCON sentinel。
    if (spatial !== null && s3Anchor !== null) {
      const s3: Record<string, unknown> = { status: 'RUNNING', anchorCheckpointId: s3Anchor.checkpointId };
      spatialEvidence.s3 = s3;
      if (observedScenarios.length === 0) {
        s3.status = evidence.fatalError === undefined ? 'FAIL' : 'NOT_RUN';
        s3.reason = `没有可用的真实场景记录（fatal=${String(evidence.fatalError ?? 'none')}）`;
        if (evidence.fatalError === undefined) cleanupErrors.push({ step: 'spatial-s3', message: 'S3 没有可用的真实 Vision witness' });
      } else {
        const picked = pickSpatialWitness(observedScenarios, spatial.session.voxel);
        if (picked === null) {
          s3.status = evidence.fatalError === undefined ? 'FAIL' : 'NOT_RUN';
          s3.reason = '本轮没有“实际 Vision 返回且已写入同一 svc.voxel”的合法事实';
          if (evidence.fatalError === undefined) cleanupErrors.push({ step: 'spatial-s3', message: 'S3 缺少真实写入同一 svc.voxel 的 witness' });
        } else {
          const properties = normalizedProperties(picked.block.properties);
          s3Witness = {
            pos: { ...picked.block.pos }, dim: picked.block.dimension, worldId: picked.block.worldId,
            sessionId: picked.block.sessionId, name: picked.block.name, properties,
            observedAt: picked.block.observedAt, sequence: picked.block.observationId,
            cell: picked.cell,
          };
          s3.witness = {
            ...s3Witness,
            // 原 typed payload 供随后 S2 原样重放；不是诊断投影。
            payload: picked.block,
            vision: { seq: picked.vision.seq, ts: picked.vision.ts, visionId: picked.vision.visionId, frame: picked.vision.frame },
            map: { seq: picked.batch.seq, mapId: picked.batch.mapId, mapWorldId: picked.batch.mapWorldId, reportId: picked.batch.reportId },
          };
          s3.status = 'PENDING';
        }
      }
    }
    if (spatialEvidence.s3 === null) {
      spatialEvidence.s3 = {
        status: evidence.fatalError === undefined ? 'FAIL' : 'NOT_RUN',
        reason: `共享服务/anchor 未建立：${String(evidence.fatalError ?? 'unknown')}`,
      };
      if (spatial !== null && evidence.fatalError === undefined) {
        cleanupErrors.push({ step: 'spatial-s3', message: 'S3 共享服务/anchor 未建立' });
      }
    }
    // 先同步进入 closing（拒绝新委托/写入并取消活动委托），随后保留原有有界清理；
    // 其他清理失败也不能跳过关停，最终结果统一在下面等待并入证据。
    let servicePromise: Promise<ShutdownResult> | null = null;
    let serviceCallError: unknown = null;
    if (spatial !== null) {
      try { servicePromise = spatial.shutdown(); } catch (e) { serviceCallError = e; }
    }
    // 只移除真实持有对象的会话监听；共享服务本身由 shutdown 负责 flush/checkpoint/close。
    arbiter?.dispose();
    if (adapter && tracker) {
      const q = await quitClient(adapter, tracker, 5000);
      if (!q.ended) cleanupErrors.push({ step: 'quit-client', message: q.reason });
    }
    if (rcon) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', message: errorMessage(e) }); } }
    if (memory) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', message: errorMessage(e) }); } }
    tracker?.dispose();
    let serviceResult: ShutdownResult | null = null;
    let serviceAwaitError: unknown = null;
    if (servicePromise !== null) {
      try { serviceResult = await servicePromise; } catch (e) { serviceAwaitError = e; }
    }
    // open 未成功时没有可信会话可关，保留 opened=false 且不伪造 shutdown 结果。
    if (spatial !== null) {
      const shutdown = spatialShutdownRecord(serviceResult, serviceCallError, serviceAwaitError, spatial.worldId);
      spatialEvidence.shutdown = shutdown;
      if (!shutdown.ok) cleanupErrors.push({ step: 'spatial-shutdown', message: `关停未确认：${shutdown.problems.join(',')}` });

      // S3：只在第一会话真实 close 已确认后，才用同一 world/DB 重新打开只读验证 witness。
      if (s3Anchor !== null) {
        const s3 = spatialEvidence.s3 as Record<string, unknown>;
        const finalState = spatial.getPersistenceState();
        const proof = checkSpatialFinalSave({
          anchorCheckpointId: s3Anchor.checkpointId,
          anchorState: { dirty: s3Anchor.dirty, lastConfirmedCheckpointId: s3Anchor.confirmedId, voxelRevision: s3Anchor.voxelRevision },
          checkpoint: serviceResult?.checkpoint ?? null,
          state: finalState,
          close: serviceResult?.close ?? null,
        });
        s3.firstClose = {
          proof,
          shutdown,
          checkpoint: serviceResult?.checkpoint ?? null,
          state: {
            lifecycle: finalState.lifecycle, dirty: finalState.dirty,
            voxelRevision: finalState.voxelRevision, confirmedVoxelRevision: finalState.confirmedVoxelRevision,
            fragmentRevision: finalState.fragmentRevision, confirmedFragmentRevision: finalState.confirmedFragmentRevision,
            topologyRevision: finalState.topologyRevision, confirmedTopologyRevision: finalState.confirmedTopologyRevision,
          },
        };
        // 第一会话的成功/重开门槛必须同时有真实 shutdown 分类通过；仅 CP/revisions/close
        // 成功而 cancelError 等存在时不得写 PASS。shutdown 诊断已完整保存在 firstClose。
        if (!proof.ok || !shutdown.ok) {
          const reason = [
            !proof.ok ? `第一会话最终保存/close 证明失败：${proof.reason}` : null,
            !shutdown.ok ? `第一会话 shutdown 未确认：${shutdown.problems.join(',')}` : null,
          ].filter((r): r is string => r !== null).join('；');
          s3.status = 'FAIL';
          s3.reason = reason;
          cleanupErrors.push({ step: 'spatial-s3', message: reason });
        } else if (s3Witness !== null) {
          const witness = s3Witness;
          let reopened: SharedSpatialSession | null = null;
          let reopenResult: ShutdownResult | null = null;
          let reopenAwaitError: unknown = null;
          try {
            reopened = await SharedSpatialSession.open({ worldId: spatial.worldId, databasePath: spatial.databasePath, timeoutMs: 5000 });
            const readback = cellEvidenceSnapshot(reopened.session.voxel.cellAt(witness.dim, witness.pos.x, witness.pos.y, witness.pos.z));
            const reopenCheck = checkSpatialReopen(witness, readback);
            s3.reopen = { cell: readback, check: reopenCheck };
            if (!reopenCheck.ok) {
              s3.status = 'FAIL';
              s3.reason = `重开读回失败：${reopenCheck.reason}`;
              cleanupErrors.push({ step: 'spatial-s3-reopen', message: `S3 重开读回失败：${reopenCheck.reason}` });
            }
          } catch (e) {
            s3.reopen = { error: errorFacts(e) };
            s3.status = 'FAIL';
            cleanupErrors.push({ step: 'spatial-s3-reopen', message: `S3 重开失败：${errorMessage(e)}` });
          } finally {
            // 第二会话真实 shutdown/close；结果与第一会话最终 id 分开保存，失败也不覆盖第一保存主错。
            if (reopened !== null) {
              const reopenCallError: unknown = null;
              try { reopenResult = await reopened.shutdown(); } catch (e) { reopenAwaitError = e; }
              const second = spatialShutdownRecord(reopenResult, reopenCallError, reopenAwaitError, reopened.worldId);
              s3.secondClose = second;
              if (!second.ok) {
                s3.status = 'FAIL';
                cleanupErrors.push({ step: 'spatial-s3-second-shutdown', message: `S3 第二会话关停未确认：${second.problems.join(',')}` });
              }
            }
          }
          if (s3.status !== 'FAIL') s3.status = 'PASS';
        }
      }
    }
  }

  const scenariosOk = Object.values(evidence.scenarios as Record<ScenarioId, ScenarioEvidence | { verdict: Verdict }>)
    .every((s) => s.verdict !== 'FAIL');
  evidence.finishedAt = Date.now();
  if (cleanupErrors.length) evidence.cleanupErrors = cleanupErrors;
  evidence.ok = evidence.fatalError === undefined && scenariosOk && cleanupErrors.length === 0;

  const file = path.join(evidenceDir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`[accept] 证据已保存：${file}`);

  process.exitCode = evidence.ok ? 0 : 1;
}

async function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node --import tsx scripts/walk-acceptance.ts --curio=test [--scenarios=W1,W2,W4,W5,W6,W7] [--help]');
    console.log('场景：W1 到达转弯 / W2 平台边缘 / W4 可见支撑失效 / W5 隐藏变化后生产回看 / W6 取消交接 / W7 超时·暂停帧·断线（W3 引用离线证据）');
    return;
  }
  await main();
}

if (isDirectRun()) {
  run().catch((e) => {
    console.error(`[accept] 致命错误：${(e as Error)?.message ?? e}`);
    process.exitCode = 1;
  });
}
