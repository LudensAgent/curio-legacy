/**
 * walk_route 真实 Minecraft M2 验收入口：连接 test 服务器，用真实
 * MineflayerAdapter + Arbiter + Vision 从 Arbiter 入口发起 walk_route，
 * 对 W1/W2/W6/W7 逐场景判定 PASS / FAIL / NOT_RUN，保存结构化 JSON 证据。
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bot, ControlState } from 'mineflayer';
import { WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  ExecutableMove,
  NavResult,
  WalkRouteStatus,
} from 'curio-minecraft-3d-memory';
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

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

type ScenarioId = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7';
type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';

const SUPPORTED_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W6', 'W7'];
const ALL_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];
/** 本轮未实现、不得被选中执行；仍会在证据里以 NOT_RUN 诚实列出。 */
const UNSUPPORTED: ScenarioId[] = ['W3', 'W4', 'W5'];

const KEYS: ControlState[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

type KeyState = Record<ControlState, boolean>;
type Keys = KeyState;

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

/** 一次控制写入：身体桥 set/clear/look 与全局 stopAll 都在同一条时间线上，靠 op 区分。 */
export interface ControlEntry {
  ts: number;
  op: 'set' | 'clear' | 'look' | 'stopAll';
  name?: string;
  value?: boolean;
  ownerTaskId: string | null;
}

/** 真实 adapter.stopAll 之前采集的全键快照（stopAll 会清键，之前才是「释放前」状态）。 */
export interface StopAllSnapshot {
  ts: number;
  label: string;
  keys: Keys;
  ownerTaskId: string | null;
}

/** walkTick 交付的实测帧采样日志：owner 绑定在 walkTick 创建时，用于检测旧任务迟到样本。 */
export interface SampleEntry {
  ts: number;
  ownerTaskId: string | null;
  x: number; y: number; z: number;
}

/** WalkMoveExecutor.move 的实际执行记录（公开身体桥诊断包装，不伪造）。 */
export interface MoveRecord {
  ts: number;
  executionId: string; // 段 executionId（walk-<gen>-step-<i>），与 taskId / delegationId 区分
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  deadlineMs: number;
}

/** WalkRouteExecutor.onSample 收到的委托样本（sample.executionId 即 delegationId）。 */
export interface AcceptedSampleRecord {
  ts: number;
  delegationId: string;
  sequence: number;
  pos: { x: number; y: number; z: number };
  observedAt: number;
  onGround: boolean;
  nextPointIndex: number;
  lastPosition: { x: number; y: number; z: number } | null;
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
  controlLog: ControlEntry[];
  controlSnapshots: ControlSnapshot[];
  stopSnapshots: StopAllSnapshot[];
  sampleLog: SampleEntry[];
  acceptedSamples: AcceptedSampleRecord[];
  moves: MoveRecord[];
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
 * W1/W6/W7 的平坦步行道：显式建造的支撑面，不假设天然地形。
 * W1 路线在 z216.5 先 +X 再 +Z 到 z217.5，因此 z 至少覆盖 216..217；
 * x 覆盖 W6 的十格直行与 W7 的直行余量，仍落在授权 x200..220, z200..220 内。
 */
const WALK_LANE = {
  // 整数方块 inclusive bounds（支撑方块在 feetY-1，净空在 feetY/feetY+1）。
  xMin: 200, xMax: 216, zMin: 216, zMax: 217,
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

/** 归属为某任务的迟到 forward=true 写入（取消/换主之后仍写前进键即复活/清键）。 */
export function lateForwardWritesByOwner(controlLog: ControlEntry[], ownerTaskId: string, sinceTs: number): ControlEntry[] {
  return controlLog.filter((c) => c.ownerTaskId === ownerTaskId && c.ts >= sinceTs && c.op === 'set' && c.name === 'forward' && c.value === true);
}

/** 连续段是否从上一段的实测终点接续（每个后续段的 from 紧贴上一段的 to）。 */
export function segmentsContiguous(moves: MoveRecord[], tol = 0.2): boolean {
  for (let i = 1; i < moves.length; i++) {
    const prev = moves[i - 1]!, cur = moves[i]!;
    if (Math.hypot(cur.from.x - prev.to.x, cur.from.z - prev.to.z) > tol) return false;
  }
  return true;
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

/**
 * 采集身体桥控制写入、真实 stopAll 前的全键快照、walkTick 交付的样本，全部把
 * 归属（taskId）绑定在「walkBody / walkTick 创建那一刻」，而不是写入那一刻。
 */
export class WalkDiagnostics {
  readonly controlLog: ControlEntry[] = [];
  readonly stopSnapshots: StopAllSnapshot[] = [];
  readonly sampleLog: SampleEntry[] = [];
  private lastBodyOwner: string | null = null;
  private origBody?: () => WalkBody;
  private origTick?: () => WalkTick;
  private origStop?: () => void;

  constructor(
    private readonly target: WalkBridge,
    private readonly owner: () => string | null,
    private readonly readKeys: () => Keys,
    private readonly now: () => number = Date.now,
  ) {}

  wrap() {
    const origBody = this.target.walkBody;
    const origTick = this.target.walkTick;
    const origStop = this.target.stopAll;

    if (origBody) {
      this.target.walkBody = () => {
        const owner = this.owner();
        this.lastBodyOwner = owner;
        const body = origBody.call(this.target);
        return {
          setControlState: (name: string, value: boolean) => {
            this.controlLog.push({ ts: this.now(), op: 'set', name, value, ownerTaskId: owner });
            body.setControlState(name, value);
          },
          clearControlStates: () => {
            this.controlLog.push({ ts: this.now(), op: 'clear', ownerTaskId: owner });
            body.clearControlStates();
          },
          look: (yaw: number, pitch: number) => {
            this.controlLog.push({ ts: this.now(), op: 'look', ownerTaskId: owner });
            return body.look(yaw, pitch);
          },
          entity: body.entity,
        };
      };
    }

    if (origTick) {
      this.target.walkTick = () => {
        const owner = this.owner();
        const tick = origTick.call(this.target);
        return async (signal: AbortSignal) => {
          const entity = await tick(signal);
          if (entity) this.sampleLog.push({ ts: this.now(), ownerTaskId: owner, x: entity.position.x, y: entity.position.y, z: entity.position.z });
          return entity;
        };
      };
    }

    this.target.stopAll = () => {
      const keys = this.readKeys();
      const owner = this.lastBodyOwner;
      this.stopSnapshots.push({ ts: this.now(), label: 'pre-stopAll', keys, ownerTaskId: owner });
      this.controlLog.push({ ts: this.now(), op: 'stopAll', ownerTaskId: owner });
      origStop.call(this.target);
    };

    this.origBody = origBody;
    this.origTick = origTick;
    this.origStop = origStop;
  }

  unwrap() {
    if (this.origBody) this.target.walkBody = this.origBody;
    if (this.origTick) this.target.walkTick = this.origTick;
    if (this.origStop) this.target.stopAll = this.origStop;
    this.origBody = undefined;
    this.origTick = undefined;
    this.origStop = undefined;
  }
}

/**
 * 采集库执行层的真实记录：WalkMoveExecutor.move 的每段 from/to/executionId，
 * WalkRouteExecutor.onSample 收到的委托样本。两个都是公开方法，只做原型级诊断
 * 包装并委托原实现，不访问私有字段、不改请求；所有任务结果落定后恢复。
 */
type MoveFn = (this: WalkMoveExecutor, request: ExecutableMove) => ReturnType<WalkMoveExecutor['move']>;
type OnSampleFn = (this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus;

export class ExecutionDiagnostics {
  readonly moves: MoveRecord[] = [];
  readonly acceptedSamples: AcceptedSampleRecord[] = [];
  private wrapped = false;
  private origMove?: MoveFn;
  private origOnSample?: OnSampleFn;

  constructor(private readonly now: () => number = Date.now) {}

  wrap() {
    if (this.wrapped) return;
    this.wrapped = true;
    const self = this;
    const origMove = WalkMoveExecutor.prototype.move as MoveFn;
    const origOnSample = WalkRouteExecutor.prototype.onSample as OnSampleFn;
    this.origMove = origMove;
    this.origOnSample = origOnSample;

    (WalkMoveExecutor.prototype as { move: MoveFn }).move = function (this: WalkMoveExecutor, request: ExecutableMove) {
      self.moves.push({
        ts: self.now(),
        executionId: request.executionId,
        from: { ...request.from },
        to: { ...request.to },
        deadlineMs: request.deadlineMs,
      });
      return origMove.call(this, request);
    };

    (WalkRouteExecutor.prototype as { onSample: OnSampleFn }).onSample = function (this: WalkRouteExecutor, sample: BodySample) {
      const status = origOnSample.call(this, sample);
      self.acceptedSamples.push({
        ts: self.now(),
        delegationId: sample.executionId,
        sequence: sample.sequence,
        pos: { ...sample.pos },
        observedAt: sample.observedAt,
        onGround: sample.onGround,
        nextPointIndex: status.nextPointIndex,
        lastPosition: status.lastPosition ? { ...status.lastPosition } : null,
      });
      return status;
    };
  }

  unwrap() {
    if (!this.wrapped) return;
    if (this.origMove) (WalkMoveExecutor.prototype as { move: MoveFn }).move = this.origMove;
    if (this.origOnSample) (WalkRouteExecutor.prototype as { onSample: OnSampleFn }).onSample = this.origOnSample;
    this.origMove = undefined;
    this.origOnSample = undefined;
    this.wrapped = false;
  }
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
  const relToBase = path.relative(base, tgzPath);
  if (relToBase === '' || relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
    throw new Error(`依赖路径越出包根目录：${tgzRel}`);
  }
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

class TaskTracker {
  readonly starts: TaskStartRecord[] = [];
  readonly outcomes: TaskDoneRecord[] = [];
  private entries = new Map<string, { promise: Promise<TaskOutcome>; resolve: (o: TaskOutcome) => void; settled: boolean }>();
  private readonly arbiter: Arbiter;
  private readonly onDone = (o: TaskOutcome) => {
    const e = this.entries.get(o.task.id);
    if (!e) return;
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

export interface HarnessContext {
  bot: Bot;
  adapter: MineflayerAdapter;
  arbiter: Arbiter;
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
  ev: ScenarioEvidence;
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

/** 严格解析 Java `execute if block` 的反馈：只有 Test passed / Test failed 合法。 */
export function parseExecuteIfBlock(raw: string): 'match' | 'mismatch' {
  const text = raw.trim();
  if (text === 'Test passed') return 'match';
  if (text === 'Test failed') return 'mismatch';
  throw new Error(`execute if block 响应无法解析：${JSON.stringify(raw)}`);
}

/** 严格解析 Java `setblock` 的成功反馈；其他（错误/未知）一律抛错，不当作已写入。 */
export function parseSetBlock(raw: string): void {
  if (!/^Changed the block at -?\d+, -?\d+, -?\d+ to /.test(raw.trim())) {
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

/**
 * 在限定范围内搭建支撑面：先逐格确认支撑格（feetY-1）与净空格（feetY/feetY+1）。
 * 支撑格接受同材料（同 run 或旧 run 遗留）或 air（此时补建）；净空格必须是 air。
 * 其余状态（cave_air/void_air/未知材料/占用）一律中止，不覆写。
 * 所有控制端命令与响应在尝试时立即写入本场景证据，中途失败也保留。
 */
async function buildSupportFixture(
  rcon: Rcon,
  ev: ScenarioEvidence,
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
      if (support === 'air') toBuild.push({ x, z });
      else if (support === 'material') reused++;
      else {
        throw new Error(`支撑格状态不可复用（x=${x} y=${feetY - 1} z=${z} → ${support}），中止且不覆写`);
      }
      for (const y of [feetY, feetY + 1]) {
        const clear = await probeBlock(send, { x, y, z }, material);
        if (clear !== 'air') {
          throw new Error(`净空格不是 air（x=${x} y=${y} z=${z} → ${clear}），中止且不覆写`);
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
async function teleportAndSettle(ctx: HarnessContext, ev: ScenarioEvidence, pos: { x: number; y: number; z: number }, label: string): Promise<void> {
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

async function runScenario(
  ctx: HarnessContext,
  body: (d: ScenarioDiag) => Promise<void>,
): Promise<ScenarioEvidence> {
  const ev: ScenarioEvidence = {
    verdict: 'NOT_RUN', startedAt: Date.now(), taskStarts: [], results: [],
    frames: [], framesTruncated: false, controlLog: [], controlSnapshots: [], stopSnapshots: [],
    sampleLog: [], acceptedSamples: [], moves: [], serverCorrections: [],
  };
  const recorder = new FrameRecorder(ctx.bot, () => ctx.arbiter.current?.id ?? null);
  const corrections = new ServerCorrectionRecorder(ctx.bot);
  const diag = new WalkDiagnostics(ctx.adapter, () => ctx.arbiter.current?.id ?? null, () => snapshotKeys(ctx.bot));
  const exec = new ExecutionDiagnostics();
  const tasks = new TaskTracker(ctx.arbiter);
  recorder.start();
  corrections.start();
  diag.wrap();
  exec.wrap();
  try {
    await body({ recorder, corrections, diag, exec, tasks, ev });
    if (ev.verdict === 'NOT_RUN') ev.verdict = 'PASS';
  } catch (e) {
    ev.verdict = 'FAIL';
    ev.error = (e as Error)?.message ?? String(e);
  } finally {
    // 取消仍未结束的任务并等待所有登记任务 done；缺真实收尾即清理失败 → FAIL。
    try {
      const active = ctx.arbiter.info();
      if (active) {
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
    ev.controlLog = diag.controlLog;
    ev.stopSnapshots = diag.stopSnapshots;
    ev.sampleLog = diag.sampleLog;
    ev.acceptedSamples = exec.acceptedSamples;
    ev.moves = exec.moves;
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

/** W1：同高三段相邻 X/Z 转弯，ARRIVED 且容差内，每段从实测终点接续。 */
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
  if (!isArrived(nav)) throw new Error(`W1 未确认到达：outcome=${nav?.outcome} 摘要=${o.result.summary}`);
  const finalTarget = route[route.length - 1]!;
  const finalPos = nav!.lastPosition;
  const err = dist2(finalPos, finalTarget);
  const feetErr = Math.abs(finalPos.y - y);
  if (err > 0.12 || feetErr > 0.05) {
    throw new Error(`W1 到达但超容差：横向 ${err.toFixed(3)} (>0.12) 脚高 ${feetErr.toFixed(3)} (>0.05)`);
  }
  // 每段从实测终点接续：库的 move.from 是上一段实测位置，不是名义路点。
  if (d.exec.moves.length > 1 && !segmentsContiguous(d.exec.moves)) {
    throw new Error(`W1 段间不接续：${JSON.stringify(d.exec.moves.map((m) => ({ from: m.from, to: m.to })))}`);
  }
  // 全键释放必须在生产 stopAll 之前被捕获（stopSnapshots 非空即真实记录到释放前状态）。
  if (d.diag.stopSnapshots.length === 0) throw new Error('W1 未捕获任何 stopAll 前全键快照');
  ev.extra = {
    ...ev.extra,
    route, deadlineMs, taskStartTs,
    horizontalError: Number(err.toFixed(3)), feetError: Number(feetErr.toFixed(3)),
    onGroundAtArrival: nav!.lastObservation?.onGround,
    segmentCount: d.exec.moves.length,
  };
  ev.verdict = 'PASS';
}

/** W2：受控平台边缘、分数起终点、整条真实轨迹无坠落/失支撑。 */
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
  if (!isArrived(nav)) throw new Error(`W2 未到达：outcome=${nav?.outcome} 摘要=${o.result.summary}`);

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
  ev.extra = { ...ev.extra, arrival: nav, taskStartTs };
  ev.verdict = 'PASS';
}

/** W6：移动中取消并立即交接给新 walk 任务，收集两任务 id 与结果，检查旧回调是否复活/清键。 */
async function scenarioW6(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const lane = WALK_LANE;
  ev.extra = { lane };
  await buildSupportFixture(ctx.rcon, ev, { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax }, lane.feetY, lane.material);
  await teleportAndSettle(ctx, ev, lane.start, 'W6 步行道起点');

  const y = lane.feetY;
  const routeA = Array.from({ length: 10 }, (_, i) => ({ x: lane.start.x + i, y, z: lane.start.z }));
  const a = startWalkTask(ctx, d, routeA, Date.now() + 30_000);
  if ('error' in a) throw new Error(`W6 任务A启动失败：${a.error}`);
  const aDone = a.done;
  const moveStart = ctx.adapter.state().pos;
  await waitFor(() => dist2(ctx.adapter.state().pos, moveStart) > 0.5, 15_000, 'W6 任务A开始移动');

  snapControl(ctx, 'before-arbiter-cancel', ev);
  const cancelTs = Date.now();
  ctx.arbiter.cancel('W6 取消并交接');
  snapControl(ctx, 'after-arbiter-cancel', ev);

  // 立即用交接点实测位置作为 B 起点，不是 A 的原始 p。
  const handoff = ctx.adapter.state().pos;
  const routeB = [{ x: handoff.x, y, z: handoff.z }, { x: handoff.x + 1, y, z: handoff.z }, { x: handoff.x + 2, y, z: handoff.z }];
  const b = startWalkTask(ctx, d, routeB, Date.now() + 30_000);
  if ('error' in b) throw new Error(`W6 任务B启动失败：${b.error}`);
  const bDone = b.done;

  // 两个 done promise 都在 await 之前持有，避免丢失快的 B 事件。
  const [oA, oB] = await Promise.all([aDone, bDone]);

  snapControl(ctx, 'after-both-complete', ev);

  if (oA.result.status !== 'cancelled') throw new Error(`W6 任务A未以 cancelled 结束：status=${oA.result.status} 摘要=${oA.result.summary}`);
  if (oB.result.status !== 'succeeded') throw new Error(`W6 任务B未成功：status=${oB.result.status} 摘要=${oB.result.summary}`);
  const navA = navFromResult(oA.result);
  if (!hasPartialPosition(navA)) throw new Error('W6 任务A取消未保留实测部分位移（lastPosition 缺失）');

  // 旧回调复活检查：取消后（cancelTs 之后）归属 A 的 forward=true 写入即为复活/清键。
  const resurrected = lateForwardWritesByOwner(d.diag.controlLog, a.task.id, cancelTs);
  ev.extra = { ...ev.extra,
    taskA: a.task.id, taskB: b.task.id,
    cancelTs, handoff,
    finalKeys: snapshotKeys(ctx.bot),
    lateOldForwardWrites: resurrected.length,
  };
  if (resurrected.length > 0) throw new Error(`W6 检测到 ${resurrected.length} 次旧任务A迟到 forward=true（复活/清键）`);
  ev.verdict = 'PASS';
}

/** W7：独立超时（7a）、宿主帧交付暂停（7b）、移动中真实断线（7c）；各自独立判定。 */
async function scenarioW7(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const lane = WALK_LANE;
  ev.extra = { lane };
  await buildSupportFixture(ctx.rcon, ev, { xMin: lane.xMin, xMax: lane.xMax, zMin: lane.zMin, zMax: lane.zMax }, lane.feetY, lane.material);
  await teleportAndSettle(ctx, ev, lane.start, 'W7 步行道起点');
  const y = lane.feetY;

  const subcases: Record<string, { verdict: Verdict; error?: string; [k: string]: unknown }> = {};

  // --- 7a：独立超时（epoch 期限，非字面 2500；真实移动后再 TIMEOUT，保留部分位移） ---
  try {
    const budget = 2500;
    const pA = ctx.adapter.state().pos;
    const routeTimeout = Array.from({ length: 8 }, (_, i) => ({ x: pA.x + i, y, z: pA.z }));
    const deadlineMs = Date.now() + budget;
    const t = startWalkTask(ctx, d, routeTimeout, deadlineMs);
    if ('error' in t) throw new Error(`W7a 启动失败：${t.error}`);
    const oTimeout = await awaitOrTimeout(t.done, 20_000, 'W7a 完成');
    const nav = navFromResult(oTimeout.result);
    const timeoutTs = Date.now();
    subcases.a = {
      verdict: 'NOT_RUN', deadlineMs, budget, timeoutObservedAt: timeoutTs,
      status: oTimeout.result.status, failureCode: oTimeout.result.failureCode,
      summary: oTimeout.result.summary, outcome: nav?.outcome, lastPosition: nav?.lastPosition,
    };
    if (oTimeout.result.status !== 'failed' || nav?.outcome !== 'TIMEOUT') {
      throw new Error(`W7a 未以真实 TIMEOUT 结束：status=${oTimeout.result.status} outcome=${nav?.outcome}`);
    }
    if (!hasPartialPosition(nav)) throw new Error('W7a TIMEOUT 未保留实测部分位移');
    // 部分位移必须与最后一条已接受样本一致（非初始位置）。
    const accepted = d.exec.acceptedSamples.filter((s) => s.lastPosition !== null).map((s) => s.lastPosition!);
    if (!partialMatchesLastSample(nav, accepted)) throw new Error('W7a 部分位移与最后已接受样本不一致');
    if (timeoutTs > deadlineMs + 1000) throw new Error('W7a 实际结束远超期限');
    subcases.a = { ...(subcases.a as object), verdict: 'PASS' };
  } catch (e) {
    subcases.a = { ...(subcases.a as object), verdict: 'FAIL', error: (e as Error)?.message ?? String(e) };
  }

  // --- 7b：宿主帧交付暂停（宿主注入，非服务端停摆）：关物理后无帧、取消不依赖新帧 ---
  try {
    const pB = ctx.adapter.state().pos;
    const routePause = Array.from({ length: 8 }, (_, i) => ({ x: pB.x + i, y, z: pB.z }));
    const t2 = startWalkTask(ctx, d, routePause, Date.now() + 30_000);
    if ('error' in t2) throw new Error(`W7b 启动失败：${t2.error}`);
    const t2Done = t2.done;
    const pauseStart = ctx.adapter.state().pos;
    await waitFor(() => dist2(ctx.adapter.state().pos, pauseStart) > 0.5, 15_000, 'W7b 开始移动');
    snapControl(ctx, 'before-paused-frame-cancel', ev);
    const baseline = d.recorder.frames.length;
    ctx.bot.physicsEnabled = false; // 宿主帧注入：暂停帧交付，服务端仍在运行。
    const pausedAt = ctx.adapter.state().pos;
    const holdMs = 250;
    await new Promise((r) => setTimeout(r, holdMs));
    const framesDuringHold = d.recorder.frames.length - baseline;
    ctx.arbiter.cancel('W7 暂停帧后取消');
    const cancelTs = Date.now();
    const oPause = await awaitOrTimeout(t2Done, 10_000, 'W7b 取消完成');
    ctx.bot.physicsEnabled = true;
    const nav = navFromResult(oPause.result);
    subcases.b = {
      verdict: 'NOT_RUN', hostInjection: 'bot.physicsEnabled=false（宿主帧注入，非服务端停摆）',
      baselineFrames: baseline, holdMs, framesDuringHold, cancelTs,
      status: oPause.result.status, lastPosition: nav?.lastPosition, pausedAt,
    };
    if (framesDuringHold !== 0) throw new Error(`W7b 暂停期间仍有 ${framesDuringHold} 帧送达`);
    if (oPause.result.status !== 'cancelled') throw new Error(`W7b 暂停帧后未以 cancelled 结束：status=${oPause.result.status}`);
    if (!hasPartialPosition(nav)) throw new Error('W7b 取消未保留部分位移');
    subcases.b = { ...(subcases.b as object), verdict: 'PASS' };
  } catch (e) {
    ctx.bot.physicsEnabled = true;
    subcases.b = { ...(subcases.b as object), verdict: 'FAIL', error: (e as Error)?.message ?? String(e) };
  }

  // --- 7c：移动中真实断线（只断客户端，服务器存活）：生命周期取消、保留部分位移 ---
  try {
    const pC = ctx.adapter.state().pos;
    const routeDisc = Array.from({ length: 8 }, (_, i) => ({ x: pC.x + i, y, z: pC.z }));
    const t3 = startWalkTask(ctx, d, routeDisc, Date.now() + 30_000);
    if ('error' in t3) throw new Error(`W7c 启动失败：${t3.error}`);
    const t3Done = t3.done;
    const discStart = ctx.adapter.state().pos;
    await waitFor(() => dist2(ctx.adapter.state().pos, discStart) > 0.5, 15_000, 'W7c 开始移动');
    const lastValid = ctx.adapter.state().pos;
    snapControl(ctx, 'before-client-disconnect', ev);
    ctx.adapter.quit(); // 断客户端并置 stopped；共享服务器不受影响。
    const oDisc = await awaitOrTimeout(t3Done, 30_000, 'W7c 断线完成');
    const nav = navFromResult(oDisc.result);
    subcases.c = {
      verdict: 'NOT_RUN', status: oDisc.result.status, outcome: nav?.outcome,
      lastValidMeasuredPosition: lastValid, lastPosition: nav?.lastPosition, summary: oDisc.result.summary,
    };
    if (oDisc.result.status !== 'cancelled') throw new Error(`W7c 断线未以 cancelled 结束：status=${oDisc.result.status} 摘要=${oDisc.result.summary}`);
    if (!hasPartialPosition(nav)) throw new Error('W7c 断线未保留实测部分位移');
    const accepted = d.exec.acceptedSamples.filter((s) => s.lastPosition !== null).map((s) => s.lastPosition!);
    if (!partialMatchesLastSample(nav, accepted)) throw new Error('W7c 部分位移与最后已接受样本不一致');
    subcases.c = { ...(subcases.c as object), verdict: 'PASS' };
  } catch (e) {
    subcases.c = { ...(subcases.c as object), verdict: 'FAIL', error: (e as Error)?.message ?? String(e) };
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

  try {
    evidence.commit = gitMeta();
    evidence.package = packageMeta();

    const bus = new EventBus();
    adapter = new MineflayerAdapter(config, bus);
    const vision = new Vision(adapter, config.vision);
    memory = new WorldMemory(path.join(evidenceDir, 'world-memory.json'));
    const arbiter = new Arbiter(adapter, memory, bus, vision);
    rcon = new Rcon(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);
    tracker = new ConnectionTracker(adapter);

    const expected = new Set([config.observer.player, ...config.observer.admins, config.mc.username].filter(Boolean));

    const preflight = await rconPreflight(rcon, expected);
    evidence.preflight = preflight;
    if (!preflight.ok) throw new Error(`RCON 预检未通过：重复Bot=${preflight.duplicateBot} 意外在线=${JSON.stringify(preflight.unexpected)} 在线=${JSON.stringify(preflight.occupants)}`);

    const spawnPromise = waitForSpawn(adapter, 30_000);
    adapter.connect();
    await spawnPromise;
    await waitFor(() => adapter!.state().observationReady, 30_000, 'observationReady');

    const ctx: HarnessContext = { bot: adapter.bot as Bot, adapter, arbiter, rcon, evidenceDir, runId };
    const scenarioMap: Partial<Record<ScenarioId, (c: HarnessContext, d: ScenarioDiag) => Promise<void>>> = {
      W1: scenarioW1, W2: scenarioW2, W6: scenarioW6, W7: scenarioW7,
    };

    let stopped = false;
    for (const id of ALL_SCENARIOS) {
      const scenarios = evidence.scenarios as Record<string, unknown>;
      if (UNSUPPORTED.includes(id)) {
        scenarios[id] = { verdict: 'NOT_RUN', note: id === 'W3' ? '引用 C1 离线 irregular 子步矩阵证据，本轮不联机运行' : '留待下一阶段' };
        continue;
      }
      if (stopped) { scenarios[id] = { verdict: 'NOT_RUN', note: '前一场景清理失败，已停止后续场景' }; continue; }
      if (!selector.includes(id)) { scenarios[id] = { verdict: 'NOT_RUN', note: '未选择' }; continue; }
      const ev = await runScenario(ctx, (d) => scenarioMap[id]!(ctx, d));
      scenarios[id] = ev;
      if (ev.cleanupError) stopped = true;
    }
  } catch (e) {
    evidence.fatalError = errorMessage(e);
  } finally {
    if (adapter?.bot) { try { (adapter.bot as Bot).physicsEnabled = true; } catch (e) { cleanupErrors.push({ step: 'restore-physics', message: errorMessage(e) }); } }
    if (adapter && tracker) {
      const q = await quitClient(adapter, tracker, 5000);
      if (!q.ended) cleanupErrors.push({ step: 'quit-client', message: q.reason });
    }
    if (rcon) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', message: errorMessage(e) }); } }
    if (memory) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', message: errorMessage(e) }); } }
    tracker?.dispose();
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
    console.log('用法：node --import tsx scripts/walk-acceptance.ts --curio=test [--scenarios=W1,W2,W6,W7] [--help]');
    console.log('场景：W1 到达转弯 / W2 平台边缘 / W6 取消交接 / W7 超时·暂停帧·断线（W4/W5 下一阶段，W3 引用离线证据）');
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
