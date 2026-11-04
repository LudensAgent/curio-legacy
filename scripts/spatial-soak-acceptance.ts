/**
 * 空间记忆 soak 验收（H1 foundation + H2a real smoke）。
 *
 * H1 地基：CLI 纯解析、同步有界 JSONL 证据写入、内存/定时器聚合指标，以及在
 * 真实 SharedSpatialSession 上组合常规 30s checkpoint 调度和真实 shutdown。
 *
 * H2a 只增加受限的真实游戏 smoke：夹具端点 A/B、RCON 只读 preflight 与一次
 * 自有测试 Bot 的 setup tp、真实 Vision 初始准入、真实 walk_to 往返与每段成功的
 * spatial_query、真实调度保存确认。全量 60 分钟、显式取消、自动重连和手动重开
 * 仍留给 H2b；H2a 的 full 模式只报告 pending/not-run，不连接任何服务。
 *
 * 证据由两个独占新建文件承载：metrics.jsonl（H1 foundation 自有 writer）与
 * events.jsonl（运行事件；大记录按稳定 eventId 分块）。每条记录同步追加，
 * 不保留全部历史帧；单条超过硬上限时显式失败，不静默截断。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
  startSpatialCheckpointScheduler,
  type SpatialCheckpointReport,
  type SpatialCheckpointSource,
} from '../src/spatial/checkpoint-scheduler.ts';
import { errorFacts } from '../src/spatial/host-shutdown.ts';
import {
  SharedSpatialSession,
  type ShutdownResult,
} from '../src/spatial/shared-session.ts';
import type { Arbiter } from '../src/arbiter/arbiter.ts';
import type { TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import type { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { Rcon } from '../src/observer/rcon.ts';
import type { Vision } from '../src/perception/vision.ts';
import type { WorldMemory } from '../src/memory/store.ts';
import type { WalkMoveExecutor } from '../src/adapter/walk-route.ts';
import type {
  BodySample,
  ExecutableMove,
  ExecutableMoveResult,
  WalkRouteExecutor,
  WalkRouteRequest,
  WalkRouteStatus,
} from 'curio-minecraft-3d-memory';
import {
  LANE,
  captureMoveCall,
  classifyAdapterEnd,
  classifySettledFrames,
  classifyTerminalBody,
  classifyWalkToResult,
  controlReleaseProblems,
  inLane,
  initialObservationFacts,
  localBodyCells,
  parseRconList,
  preflightBotConflict,
  validateFragmentsQuery,
  type CapturedMove,
  type CapturedRouteSample,
  type PhysicsFrame,
} from './navigation-acceptance.ts';

/** 保留的测试干道；与 navigation-acceptance 的 LANE 相同。 */
export { LANE };

/** 夹具固定端点；x208 是 Section 边界，y63 是支撑层、y64 是身体层。 */
export const FIXTURE_A = { x: 207.5, y: 64, z: 216.5 } as const;
export const FIXTURE_B = { x: 209.5, y: 64, z: 216.5 } as const;
export const FIXTURE_ENDPOINTS = { A: FIXTURE_A, B: FIXTURE_B } as const;
export const FIXTURE_FACTS = {
  endpoints: FIXTURE_ENDPOINTS,
  crossSectionX: 208,
  supportY: 63,
  bodyY: 64,
} as const;

export const DEFAULT_DURATION_MS = 3_600_000;
export const MIN_DURATION_MS = 90_000;
export const MAX_DURATION_MS = 3_600_000;
/** 单条 JSONL 记录（含 envelope）的硬上限。超出即失败，不写半条记录。 */
export const MAX_JSONL_RECORD_BYTES = 64 * 1024;
/** 大记录分块的 UTF-8 负载上限；base64 后的单块仍低于 64KiB。 */
export const CHUNK_PAYLOAD_BYTES = 16 * 1024;
/** 单个逻辑事件的硬上限；超出显式失败，不截断、不丢字段。 */
export const MAX_EVENT_BYTES = 1024 * 1024;
/** 内存快照周期；定时器已 unref，stop 时清除。 */
export const SAMPLE_INTERVAL_MS = 1_000;
/** 连接物理帧/监听器诊断的落盘周期；不逐帧保存。 */
export const CONNECTION_SNAPSHOT_INTERVAL_MS = 5_000;
export const SMOKE_LEG_BUDGET_MS = 45_000;
export const SMOKE_MIN_SUCCESSFUL_LEGS = 2;
export const SMOKE_MIN_CHECKPOINT_SAVES = 2;
/** 当前任务保留给既有分类器的有界窗口。超出显式失败/取消，不静默截断。 */
export const MAX_SAMPLES_PER_TASK = 4_096;
export const MAX_MOVES_PER_TASK = 16;
export const MAX_STARTS_PER_TASK = 16;

const DECIMAL_TOKEN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_TOKEN = /^\d+$/;
const HEX_40 = /^[0-9a-f]{40}$/;

export const H2_PENDING = {
  state: 'pending',
  fullPass: false,
  detail:
    'H2a implements a bounded real-game smoke path only. Full 60-minute soak, explicit cancel acceptance, auto-reconnect, and manual reopen remain pending; no full pass is claimed.',
} as const;

export const H2A_PENDING_MANDATORY = [
  'full-60-minute-run',
  'explicit-cancel-scenarios',
  'auto-reconnect',
  'manual-reopen',
] as const;

const H1_IMPLEMENTED = {
  state: 'implemented',
  scope: 'offline CLI, bounded evidence writer, metrics, and real-session lifecycle foundation',
} as const;

export const HELP = `spatial-soak-acceptance — H1 foundation + H2a bounded real smoke

Usage:
  node --import tsx scripts/spatial-soak-acceptance.ts --curio=test --mode=smoke --start=207.5,64,216.5 [--duration-ms=N]

Options:
  --curio=test        Required; only the isolated test environment is accepted.
  --mode=smoke|full   Required. smoke may run the bounded real path; full is reserved for
                      H2b and remains pending/not-run without connecting.
  --start=x,y,z       Required; must be exactly fixture endpoint A=(207.5,64,216.5)
                      or B=(209.5,64,216.5). Values are never rounded.
  --duration-ms=N     Optional; integer 90000..3600000, default 3600000.
                      --mode=full requires exactly 3600000 and does not run in H2a.
  --help, -h          Print this text and exit without loading config, creating a DB, or opening sockets.

The smoke path uses only RCON list and one setup tp of the configured test Bot. Map facts
come from normal Vision and production navigation; H2a never claims a full pass.`;

export type FixtureEndpoint = { x: number; y: number; z: number };

export type ParsedCli =
  | { ok: true; help: true; value?: never }
  | {
    ok: true;
    help: false;
    curio: 'test';
    mode: 'smoke' | 'full';
    start: FixtureEndpoint;
    startRaw: string;
    durationMs: number;
  }
  | { ok: false; error: string };

const isKnownFlag = (arg: string): boolean =>
  arg.startsWith('--curio=') ||
  arg.startsWith('--start=') ||
  arg.startsWith('--mode=') ||
  arg.startsWith('--duration-ms=');

const samePoint = (a: FixtureEndpoint, b: FixtureEndpoint): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  if (argv.includes('--help') || argv.includes('-h')) return { ok: true, help: true };

  const unknown = argv.filter((arg) => !isKnownFlag(arg));
  if (unknown.length > 0) return { ok: false, error: `unknown argument(s): ${unknown.join(' ')}` };

  const curio = argv.filter((arg) => arg.startsWith('--curio='));
  const start = argv.filter((arg) => arg.startsWith('--start='));
  const mode = argv.filter((arg) => arg.startsWith('--mode='));
  const duration = argv.filter((arg) => arg.startsWith('--duration-ms='));

  if (curio.length !== 1) return { ok: false, error: 'exactly one --curio=test is required' };
  if (curio[0] !== '--curio=test') return { ok: false, error: `only --curio=test is accepted, got ${curio[0]}` };
  if (start.length !== 1) return { ok: false, error: 'exactly one --start=x,y,z is required' };
  if (mode.length !== 1) return { ok: false, error: 'exactly one --mode=smoke|full is required' };
  if (duration.length > 1) return { ok: false, error: 'at most one --duration-ms=N is accepted' };

  const rawMode = mode[0].slice('--mode='.length);
  if (rawMode !== 'smoke' && rawMode !== 'full') return { ok: false, error: `--mode must be smoke or full, got ${rawMode}` };

  let durationMs = DEFAULT_DURATION_MS;
  if (duration.length === 1) {
    const rawDuration = duration[0].slice('--duration-ms='.length);
    if (!INTEGER_TOKEN.test(rawDuration)) return { ok: false, error: '--duration-ms must be a plain non-negative integer' };
    durationMs = Number(rawDuration);
    if (!Number.isInteger(durationMs)) return { ok: false, error: '--duration-ms must be an integer' };
    if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      return { ok: false, error: `--duration-ms must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}` };
    }
  }
  // H2a 的 full 只是占位：90s 不能被放大成 1h，也不允许冒充满时长运行。
  if (rawMode === 'full' && durationMs !== DEFAULT_DURATION_MS) {
    return {
      ok: false,
      error: `--mode=full requires --duration-ms=${DEFAULT_DURATION_MS} in H2a; full remains pending/not-run`,
    };
  }

  const startRaw = start[0].slice('--start='.length);
  const parts = startRaw.split(',');
  if (parts.length !== 3 || parts.some((part) => part === '')) return { ok: false, error: '--start must be x,y,z' };
  if (!parts.every((part) => DECIMAL_TOKEN.test(part))) {
    return { ok: false, error: '--start coordinates must be plain decimal numbers (values are never rounded)' };
  }
  const [x, y, z] = parts.map((part) => Number(part));
  if (![x, y, z].every(Number.isFinite)) return { ok: false, error: '--start coordinates must be finite' };
  const parsedStart = { x, y, z };
  const endpoint = Object.entries(FIXTURE_ENDPOINTS)
    .find(([, point]) => samePoint(point, parsedStart));
  if (endpoint === undefined) {
    return {
      ok: false,
      error: `--start must be exactly fixture endpoint A=${FIXTURE_A.x},${FIXTURE_A.y},${FIXTURE_A.z} or B=${FIXTURE_B.x},${FIXTURE_B.y},${FIXTURE_B.z}; got ${startRaw}`,
    };
  }

  return { ok: true, help: false, curio: 'test', mode: rawMode, start: parsedStart, startRaw, durationMs };
}

export function buildRunReport(parsed: Extract<ParsedCli, { ok: true; help: false }>) {
  return {
    status: 'H2_PENDING' as const,
    fullPass: false,
    longRunCompleted: false,
    mode: parsed.mode,
    start: parsed.start,
    startRaw: parsed.startRaw,
    durationMs: parsed.durationMs,
    fixture: FIXTURE_FACTS,
    h1: H1_IMPLEMENTED,
    h2: H2_PENDING,
  };
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sha256File = (file: string): string => sha256Hex(readFileSync(file));

export interface ChunkPartRecord {
  kind: 'evidence-chunk';
  eventId: string;
  partIndex: number;
  partCount: number;
  payloadBytes: number;
  payloadSha256: string;
  partSha256: string;
  encoding: 'base64';
  data: string;
}

export interface EncodedChunkedRecord {
  eventId: string;
  payloadBytes: number;
  payloadSha256: string;
  partCount: number;
  parts: ChunkPartRecord[];
}

/**
 * 把一个大 payload 编成稳定、可重建的分块记录。
 *
 * 按 UTF-8 字节切片（每片不超过 maxChunkBytes），最后统一解码，避免把多字节字符
 * 切断后各自解码造成损坏。每块都带 eventId、partIndex/partCount、整包与分块哈希；
 * 超出 MAX_EVENT_BYTES 时抛 RangeError，绝不截断字段。
 */
export function encodeChunkedRecord(
  eventId: string,
  payload: unknown,
  maxChunkBytes = CHUNK_PAYLOAD_BYTES,
): EncodedChunkedRecord {
  if (eventId === '') throw new TypeError('chunked record eventId must not be empty');
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1) {
    throw new RangeError(`maxChunkBytes must be a positive integer, got ${maxChunkBytes}`);
  }
  const json = JSON.stringify(payload);
  if (json === undefined) throw new TypeError('chunked record payload is not JSON serializable');
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > MAX_EVENT_BYTES) {
    throw new RangeError(`event ${eventId} is ${bytes.length} bytes, exceeds hard limit ${MAX_EVENT_BYTES}`);
  }
  const payloadSha256 = sha256Hex(bytes);
  const partCount = Math.max(1, Math.ceil(bytes.length / maxChunkBytes));
  const parts = Array.from({ length: partCount }, (_, partIndex): ChunkPartRecord => {
    const slice = bytes.subarray(partIndex * maxChunkBytes, (partIndex + 1) * maxChunkBytes);
    return {
      kind: 'evidence-chunk',
      eventId,
      partIndex,
      partCount,
      payloadBytes: bytes.length,
      payloadSha256,
      partSha256: sha256Hex(slice),
      encoding: 'base64',
      data: slice.toString('base64'),
    };
  });
  return { eventId, payloadBytes: bytes.length, payloadSha256, partCount, parts };
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumberValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface DecodedChunkedRecord {
  ok: boolean;
  problems: string[];
  eventId: string | null;
  payload: unknown;
  payloadSha256: string | null;
  partCount: number | null;
}

/** 重建分块事件；缺块、重复块、哈希不符或 JSON 损坏都显式报告。 */
export function decodeChunkedRecord(records: readonly unknown[]): DecodedChunkedRecord {
  const problems: string[] = [];
  const parts = records.filter(isRecordValue);
  if (parts.length !== records.length) problems.push('non-object chunk record encountered');
  if (parts.length === 0) {
    return { ok: false, problems: ['no chunk records supplied'], eventId: null, payload: null, payloadSha256: null, partCount: null };
  }
  if (parts.some((part) => part.kind !== 'evidence-chunk')) problems.push('record kind is not evidence-chunk');
  if (parts.some((part) => part.encoding !== 'base64')) problems.push('chunk encoding is not base64');

  const eventIds = new Set(parts.map((part) => part.eventId).filter((id): id is string => typeof id === 'string'));
  if (eventIds.size !== 1) problems.push(`chunk eventIds are not exactly one: ${eventIds.size}`);
  const eventId = eventIds.size === 1 ? [...eventIds][0]! : null;

  const declaredCounts = new Set(parts.map((part) => part.partCount).filter(isNumberValue));
  if (declaredCounts.size !== 1) problems.push('chunk partCount is inconsistent');
  const declaredCount = declaredCounts.size === 1 ? [...declaredCounts][0]! : null;
  if (declaredCount !== null && (!Number.isInteger(declaredCount) || declaredCount < 1)) problems.push('chunk partCount is invalid');

  const payloadSizes = new Set(parts.map((part) => part.payloadBytes).filter(isNumberValue));
  if (payloadSizes.size !== 1) problems.push('chunk payloadBytes is inconsistent');
  const payloadBytes = payloadSizes.size === 1 ? [...payloadSizes][0]! : null;

  const payloadHashes = new Set(parts.map((part) => part.payloadSha256).filter((hash): hash is string => typeof hash === 'string'));
  if (payloadHashes.size !== 1) problems.push('chunk payloadSha256 is inconsistent');
  const payloadSha256 = payloadHashes.size === 1 ? [...payloadHashes][0]! : null;

  const byIndex = new Map<number, Record<string, unknown>>();
  for (const part of parts) {
    if (!Number.isInteger(part.partIndex) || (part.partIndex as number) < 0) {
      problems.push(`chunk partIndex is invalid: ${String(part.partIndex)}`);
      continue;
    }
    const index = part.partIndex as number;
    if (declaredCount !== null && index >= declaredCount) problems.push(`chunk partIndex ${index} is outside partCount ${declaredCount}`);
    if (byIndex.has(index)) problems.push(`duplicate evidence chunk part ${index}`);
    byIndex.set(index, part);
  }

  const slices: Buffer[] = [];
  if (declaredCount !== null) {
    for (let index = 0; index < declaredCount; index += 1) {
      const part = byIndex.get(index);
      if (part === undefined) {
        problems.push(`missing evidence chunk part ${index} of ${declaredCount}`);
        continue;
      }
      if (typeof part.data !== 'string') {
        problems.push(`evidence chunk part ${index} data is not a string`);
        continue;
      }
      if (typeof part.partSha256 !== 'string') {
        problems.push(`evidence chunk part ${index} partSha256 is missing`);
        continue;
      }
      const slice = Buffer.from(part.data, 'base64');
      if (sha256Hex(slice) !== part.partSha256) problems.push(`evidence chunk part ${index} hash mismatch`);
      slices.push(slice);
    }
  }

  let payload: unknown = null;
  if (problems.length === 0 && payloadBytes !== null && payloadSha256 !== null) {
    const combined = Buffer.concat(slices);
    if (combined.length !== payloadBytes) problems.push(`reconstructed ${combined.length} bytes, expected ${payloadBytes}`);
    const reconstructedHash = sha256Hex(combined);
    if (reconstructedHash !== payloadSha256) problems.push('reconstructed payload hash mismatch');
    if (problems.length === 0) {
      try {
        payload = JSON.parse(combined.toString('utf8'));
      } catch (error) {
        problems.push(`reconstructed payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    eventId,
    payload,
    payloadSha256,
    partCount: declaredCount,
  };
}

/**
 * 同步追加 JSONL 的有界写入器。
 *
 * 每条记录立即落盘，内存中只保留序号与字节计数，不保留记录数组。
 * envelope 提供独立的 sequence/captureTime；payload 内的原始时间戳原样保留。
 * 单条超过 maxRecordBytes 时抛 RangeError，并且不会先写出一部分。
 *
 * 一个证据文件只允许一个 writer：构造时以独占方式新建空文件，已存在的路径
 * （无论是否为空）一律拒绝，避免从 sequence 0 追加到旧文件造成序号重复。
 * 不提供续写/恢复/覆盖路径；需要新证据时使用新文件。
 */
export class BoundedJsonlWriter {
  readonly path: string;
  readonly maxRecordBytes: number;
  private sequence = 0;
  private bytes = 0;
  private closed = false;

  constructor(path: string, maxRecordBytes = MAX_JSONL_RECORD_BYTES) {
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError(`maxRecordBytes must be a positive integer, got ${maxRecordBytes}`);
    }
    this.path = path;
    this.maxRecordBytes = maxRecordBytes;
    // 'wx' 原子地要求路径不存在；失败时不会截断或修改已有文件。
    writeFileSync(path, '', { flag: 'wx' });
  }

  get recordsWritten(): number {
    return this.sequence;
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  append(payload: unknown): { sequence: number; captureTime: number } {
    if (this.closed) throw new Error(`JSONL writer for ${this.path} is closed`);
    if (payload === undefined) throw new TypeError('JSONL record payload is undefined');
    const sequence = this.sequence + 1;
    const captureTime = Date.now();
    const line = `${JSON.stringify({ sequence, captureTime, record: payload })}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (size > this.maxRecordBytes) {
      throw new RangeError(
        `JSONL record ${size} bytes exceeds limit ${this.maxRecordBytes}; record was not written`,
      );
    }
    appendFileSync(this.path, line, 'utf8');
    this.sequence = sequence;
    this.bytes += size;
    return { sequence, captureTime };
  }

  close(): void {
    this.closed = true;
  }
}

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface TimingAggregate {
  count: number;
  maxMs: number;
  meanMs: number;
  totalMs: number;
}

export interface SoakMetricsView {
  elapsedMs: number;
  memory: {
    initial: MemorySnapshot;
    final: MemorySnapshot;
    peak: MemorySnapshot;
    samples: number;
  };
  /** 相邻两次真实采样回调之间的实际单调时钟间隔。 */
  timerGapMs: TimingAggregate;
  /** 单次实际间隔超出计划周期的部分（按 0 下限截断），不是累计相位偏移。 */
  timerLatenessMs: TimingAggregate;
  checkpointLatencyMs: TimingAggregate;
  checkpointReports: { saved: number; failed: number };
  gameFrames: { state: 'pending'; detail: string };
  leakConclusion: { state: 'not-concluded'; detail: string };
  h2: typeof H2_PENDING;
}

export interface SoakMetrics {
  /**
   * 记录一次真实采样回调。间隔按上一个真实回调的 actualMono 计算，而不是
   * 固定计划相位；因此一次延迟只会在下一次真实回调时计入 gap。
   * 计划周期与负值都按 0 下限截断。
   */
  recordTimerTick(previousActualMono: number, actualMono: number, plannedIntervalMs: number): void;
  recordCheckpointLatency(durationMs: number): void;
  recordCheckpointReport(status: 'saved' | 'failed'): void;
  recordMemory(): MemorySnapshot;
  elapsedMs(): number;
  snapshot(): SoakMetricsView;
}

const readMemory = (): MemorySnapshot => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
  };
};

const emptyTiming = (): TimingAggregate => ({ count: 0, maxMs: 0, meanMs: 0, totalMs: 0 });

const addTiming = (aggregate: TimingAggregate, value: number): void => {
  const measured = Math.max(0, value);
  aggregate.count += 1;
  aggregate.totalMs += measured;
  aggregate.maxMs = Math.max(aggregate.maxMs, measured);
  aggregate.meanMs = aggregate.totalMs / aggregate.count;
};

const timingView = (aggregate: TimingAggregate): TimingAggregate => ({ ...aggregate });

export function createSoakMetrics(
  nowMono: () => number = () => performance.now(),
): SoakMetrics {
  const startedMono = nowMono();
  const initial = readMemory();
  let final = initial;
  let peak = initial;
  let samples = 1;
  const timerGap = emptyTiming();
  const timerLateness = emptyTiming();
  const checkpointLatency = emptyTiming();
  let saved = 0;
  let failed = 0;

  return {
    recordTimerTick(previousActualMono, actualMono, plannedIntervalMs) {
      const gap = actualMono - previousActualMono;
      addTiming(timerGap, gap);
      addTiming(timerLateness, gap - plannedIntervalMs);
    },
    recordCheckpointLatency(durationMs) {
      addTiming(checkpointLatency, durationMs);
    },
    recordCheckpointReport(status) {
      if (status === 'saved') saved += 1;
      else failed += 1;
    },
    recordMemory() {
      const sample = readMemory();
      final = sample;
      peak = {
        rss: Math.max(peak.rss, sample.rss),
        heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
        heapTotal: Math.max(peak.heapTotal, sample.heapTotal),
        external: Math.max(peak.external, sample.external),
      };
      samples += 1;
      return sample;
    },
    elapsedMs() {
      return Math.max(0, nowMono() - startedMono);
    },
    snapshot() {
      return {
        elapsedMs: Math.max(0, nowMono() - startedMono),
        memory: {
          initial: { ...initial },
          final: { ...final },
          peak: { ...peak },
          samples,
        },
        timerGapMs: timingView(timerGap),
        timerLatenessMs: timingView(timerLateness),
        checkpointLatencyMs: timingView(checkpointLatency),
        checkpointReports: { saved, failed },
        gameFrames: {
          state: 'pending',
          detail: 'H2a does not persist per-physics-frame evidence; tick timing is aggregated per connection.',
        },
        leakConclusion: {
          state: 'not-concluded',
          detail: 'A single run cannot prove or disprove a leak; recorded growth is an observation only.',
        },
        h2: H2_PENDING,
      };
    },
  };
}

export interface PhysicsTickAggregate {
  count: number;
  lastAt: number | null;
  maxGapMs: number;
  meanGapMs: number;
  totalGapMs: number;
  gapCount: number;
}

/** 只聚合真实 physicsTick 回调的时间；不保存每一帧。 */
export function createPhysicsTickMetrics() {
  let count = 0;
  let lastAt: number | null = null;
  let maxGapMs = 0;
  let totalGapMs = 0;
  let gapCount = 0;

  const record = (at: number): void => {
    if (lastAt !== null) {
      const gap = Math.max(0, at - lastAt);
      totalGapMs += gap;
      gapCount += 1;
      maxGapMs = Math.max(maxGapMs, gap);
    }
    lastAt = at;
    count += 1;
  };

  const snapshot = (): PhysicsTickAggregate => ({
    count,
    lastAt,
    maxGapMs,
    meanGapMs: gapCount === 0 ? 0 : totalGapMs / gapCount,
    totalGapMs,
    gapCount,
  });

  return { record, snapshot };
}

export interface SoakFoundationOptions {
  service: SharedSpatialSession;
  evidencePath: string;
  /** H2a run identity; each record is tagged so per-file sequences are not claimed global. */
  runId?: string;
  /** Observable copy of the actual scheduler report; called after the foundation records it. */
  onCheckpointReport?: (report: SpatialCheckpointReport) => void;
}

export interface SoakFoundationStop {
  /** 真实 shutdown 结果；checkpoint、error、cancelError、close、closeError 原样保留。 */
  shutdown: ShutdownResult;
  /** 采集或写证据时的首个错误；不影响 shutdown 仍被执行。 */
  evidenceError: unknown;
  finalMetrics: SoakMetricsView;
  h2: typeof H2_PENDING;
}

export interface SpatialSoakFoundation {
  readonly evidencePath: string;
  /**
   * 首个证据写入错误；尚未失败时为 null。getter 立即反映当前状态，调用方可在
   * 运行中据此停止 live run，而不必等 stop()。首个错误之后不再尝试写入。
   */
  readonly evidenceFailure: unknown;
  /** 复用同一个 foundation writer 追加有界诊断记录；失败/关闭后返回 false。 */
  appendMetrics(payload: unknown): boolean;
  /** 当前 H1 聚合视图（内存、采样间隔、checkpoint 计数）；不触发额外扫描。 */
  snapshotMetrics(): SoakMetricsView;
  stop(): Promise<SoakFoundationStop>;
}

/**
 * 把真实 shutdown 结果转成可稳定写入 JSONL 的事实。
 *
 * close.error 是 Error 实例，直接 JSON 序列化只会得到 {}，因此只把该字段换成
 * errorFacts；completed/dirty/unconfirmedRequest/checkpointId 等真实字段保持原样。
 * 原始 close.error 仍保留在 SoakFoundationStop.shutdown.close.error 中。
 */
export const shutdownFacts = (result: ShutdownResult): Record<string, unknown> => ({
  checkpoint: result.checkpoint,
  finalCheckpointSaved: result.checkpoint !== null && result.error === null,
  error: result.error === null ? null : errorFacts(result.error),
  cancelError: result.cancelError === null ? null : errorFacts(result.cancelError),
  close: result.close === null ? null : {
    ...result.close,
    error: result.close.error === null ? null : errorFacts(result.close.error),
  },
  closeError: result.closeError === null ? null : errorFacts(result.closeError),
});

/**
 * 用调用方提供的真实服务与证据路径启动采样、常规 30s checkpoint 调度，
 * 并保证 stop 时先停未来触发，再通过服务自身的 shutdown 做最终保存和关闭。
 * 不创建进程级常驻定时器，不启动游戏连接。
 */
export function startSpatialSoakFoundation(options: SoakFoundationOptions): SpatialSoakFoundation {
  const writer = new BoundedJsonlWriter(options.evidencePath);
  const metrics = createSoakMetrics();
  const runId = options.runId ?? null;
  let evidenceError: unknown = null;
  let stopping = false;

  const write = (payload: unknown): void => {
    if (evidenceError !== null) return;
    try {
      writer.append({ runId, ...(isRecordValue(payload) ? payload : { payload }) });
    } catch (error) {
      evidenceError = error;
    }
  };

  write({
    kind: 'foundation-start',
    h1: H1_IMPLEMENTED,
    h2: H2_PENDING,
    schedulerIntervalMs: DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
  });
  write({ kind: 'memory', elapsedMs: metrics.elapsedMs(), ...metrics.recordMemory() });

  let lastTickMono = performance.now();
  const sampleTimer = setInterval(() => {
    const actualMono = performance.now();
    metrics.recordTimerTick(lastTickMono, actualMono, SAMPLE_INTERVAL_MS);
    lastTickMono = actualMono;
    write({ kind: 'memory', elapsedMs: metrics.elapsedMs(), ...metrics.recordMemory() });
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref();

  let lastCheckpointLatencyMs = 0;
  /** 当前已接受、但 report 尚未送达的完成信号；调度器同一时刻最多一个。 */
  let pendingReport: { promise: Promise<void>; resolve: () => void } | null = null;

  const source: SpatialCheckpointSource = {
    get closing() {
      return options.service.closing;
    },
    session: {
      get busy() {
        return options.service.session.busy;
      },
    },
    getPersistenceState: () => options.service.getPersistenceState(),
    checkpoint: async () => {
      let resolvePending: (() => void) | undefined;
      pendingReport = {
        promise: new Promise<void>((resolve) => {
          resolvePending = resolve;
        }),
        resolve: () => resolvePending?.(),
      };
      const startedMono = performance.now();
      try {
        return await options.service.checkpoint();
      } finally {
        lastCheckpointLatencyMs = performance.now() - startedMono;
        metrics.recordCheckpointLatency(lastCheckpointLatencyMs);
      }
    },
  };

  const stopScheduler = startSpatialCheckpointScheduler(source, (report: SpatialCheckpointReport) => {
    metrics.recordCheckpointReport(report.status);
    write({
      kind: 'checkpoint-scheduler',
      latencyMs: lastCheckpointLatencyMs,
      report,
    });
    const pending = pendingReport;
    pendingReport = null;
    pending?.resolve();
    options.onCheckpointReport?.(report);
  });

  let stopPromise: Promise<SoakFoundationStop> | null = null;

  const stop = (): Promise<SoakFoundationStop> => {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    clearInterval(sampleTimer);
    stopScheduler();
    // 停止未来触发后，仍可能有一次已接受的保存正在完成；等它和真实 shutdown
    // 都结束，再采集最终内存/指标，避免最终计数漏掉迟到的 report。
    const reportCompletion = pendingReport?.promise ?? null;

    stopPromise = (async () => {
      let shutdown: ShutdownResult | null = null;
      let shutdownError: unknown = null;
      try {
        shutdown = await options.service.shutdown();
      } catch (error) {
        shutdownError = error;
      }
      if (reportCompletion !== null) await reportCompletion;

      metrics.recordMemory();
      const finalMetrics = metrics.snapshot();
      write({ kind: 'metrics-final', metrics: finalMetrics });
      if (shutdown !== null) {
        write({ kind: 'shutdown', shutdown: shutdownFacts(shutdown), h2: H2_PENDING });
      } else {
        write({ kind: 'shutdown-error', error: errorFacts(shutdownError), h2: H2_PENDING });
      }
      writer.close();
      // 真实 shutdown 抛错时保留原始错误，但先关闭证据 writer 再向上抛。
      if (shutdown === null) throw shutdownError ?? new Error('shared spatial shutdown returned no result');
      return { shutdown, evidenceError, finalMetrics, h2: H2_PENDING };
    })();

    return stopPromise;
  };

  return {
    evidencePath: options.evidencePath,
    get evidenceFailure() {
      return evidenceError;
    },
    appendMetrics(payload) {
      if (stopping || evidenceError !== null) return false;
      try {
        writer.append({ runId, ...(isRecordValue(payload) ? payload : { payload }) });
        return true;
      } catch (error) {
        evidenceError = error;
        return false;
      }
    },
    snapshotMetrics: () => metrics.snapshot(),
    stop,
  };
}

const isVec = (value: unknown): value is { x: number; y: number; z: number } =>
  isRecordValue(value) && isNumberValue(value.x) && isNumberValue(value.y) && isNumberValue(value.z);
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
const controlsSnapshot = (source: { bot: unknown }) => {
  const bot = isRecordValue(source.bot) ? source.bot : null;
  const state = bot !== null && isRecordValue(bot.controlState) ? bot.controlState : null;
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of CONTROL_KEYS) {
    if (state !== null && typeof state[key] === 'boolean') values[key] = state[key];
    else missing.push(key);
  }
  return { ok: missing.length === 0, values, missing };
};

const listenerCountOf = (emitter: unknown, event: string): number | null => {
  if (!isRecordValue(emitter) || typeof emitter.listenerCount !== 'function') return null;
  return (emitter.listenerCount as (name: string) => number)(event);
};

interface RuntimeScope {
  worldId: string;
  dim: string;
  sessionId: string;
}

interface TaskWindow {
  samples: CapturedRouteSample[];
  moves: CapturedMove[];
  starts: Record<string, unknown>[];
  lastSequence: number;
}

interface EvidenceEmitter {
  readonly failure: unknown;
  emit(kind: string, taskId: string | null, payload: unknown): { eventId: string; bytes: number } | null;
}

/** 事件落盘：小记录单行；大记录按稳定 eventId 分块；任一失败都保留首错。 */
function createEvidenceEmitter(writer: BoundedJsonlWriter, runId: string): EvidenceEmitter {
  let sequence = 0;
  let failure: unknown = null;

  const emit = (kind: string, taskId: string | null, payload: unknown) => {
    if (failure !== null) return null;
    const eventId = `${runId}:event-${++sequence}`;
    const body = { kind, runId, eventId, taskId, at: Date.now(), payload };
    try {
      const json = JSON.stringify(body);
      if (json === undefined) throw new TypeError(`evidence event ${eventId} is not JSON serializable`);
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > MAX_EVENT_BYTES) {
        throw new RangeError(`evidence event ${eventId} is ${bytes} bytes, exceeds ${MAX_EVENT_BYTES}`);
      }
      if (bytes <= CHUNK_PAYLOAD_BYTES) {
        writer.append(body);
      } else {
        for (const part of encodeChunkedRecord(eventId, body).parts) writer.append(part);
      }
      return { eventId, bytes };
    } catch (error) {
      failure = error;
      return null;
    }
  };

  return {
    get failure() {
      return failure;
    },
    emit,
  };
}

function collectMetadata(repoRoot: string, scriptPath: string) {
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', `safe.directory=${repoRoot}`, ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();

  const top = git(['rev-parse', '--show-toplevel']);
  if (path.resolve(top).toLowerCase() !== path.resolve(repoRoot).toLowerCase()) {
    throw new Error(`git top-level mismatch: ${top}`);
  }
  const head = git(['rev-parse', 'HEAD']);
  if (!HEX_40.test(head)) throw new Error(`git HEAD is not a full 40-char hash: ${head}`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(['status', '--porcelain=v1']);

  // 由当前安装解析出的实际入口定位 package.json，不假定工作区存在局部 node_modules。
  const entryUrl = import.meta.resolve('curio-minecraft-3d-memory');
  if (!entryUrl.startsWith('file:')) throw new Error(`curio package entry is not a file URL: ${entryUrl}`);
  const entryPath = fileURLToPath(entryUrl);
  const packageJsonPath = path.resolve(path.dirname(entryPath), '..', 'package.json');
  if (!existsSync(packageJsonPath)) throw new Error(`installed curio package.json is missing: ${packageJsonPath}`);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (name !== 'curio-minecraft-3d-memory' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`installed curio package identity is unavailable: ${name}@${version}`);
  }

  const provenanceRel = `vendor/curio-minecraft-3d-memory-${version}.provenance.json`;
  const provenanceAbs = path.join(repoRoot, provenanceRel);
  if (!existsSync(provenanceAbs)) throw new Error(`curio source provenance is missing: ${provenanceRel}`);
  // 未跟踪文件不能作为可复现的来源证据。
  execFileSync('git', ['-c', `safe.directory=${repoRoot}`, 'ls-files', '--error-unmatch', provenanceRel], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  const provenance = JSON.parse(readFileSync(provenanceAbs, 'utf8')) as Record<string, unknown>;
  const provenancePackage = isRecordValue(provenance.package) ? provenance.package : null;
  if (provenancePackage === null || provenancePackage.name !== name || provenancePackage.version !== version) {
    throw new Error(`curio provenance version does not match installed ${name}@${version}`);
  }
  if (typeof provenance.sourceHEAD !== 'string' || !HEX_40.test(provenance.sourceHEAD)) {
    throw new Error('curio provenance sourceHEAD is unavailable');
  }
  if (typeof provenance.artifactSHA256 !== 'string') throw new Error('curio provenance artifactSHA256 is unavailable');

  return {
    status: 'OK',
    head,
    branch,
    clean: status === '',
    script: {
      path: path.relative(repoRoot, scriptPath).replaceAll('\\', '/'),
      sha256: sha256File(scriptPath),
    },
    package: {
      name,
      version,
      entry: {
        path: path.relative(repoRoot, entryPath).replaceAll('\\', '/'),
        sha256: sha256File(entryPath),
      },
      provenance: {
        path: provenanceRel,
        sha256: sha256File(provenanceAbs),
        sourceHEAD: provenance.sourceHEAD,
        artifactSHA256: provenance.artifactSHA256,
      },
    },
  };
}

interface RunReport {
  schema: 'spatial-soak-acceptance';
  runId: string;
  mode: 'smoke';
  status: 'SMOKE_PASS' | 'FAIL';
  smokePass: boolean;
  fullPass: false;
  longRunCompleted: false;
  pendingMandatory: typeof H2A_PENDING_MANDATORY;
  startedAt: number | null;
  finishedAt: number | null;
  activeElapsedMs: number | null;
  durationMs: number;
  start: FixtureEndpoint;
  measuredStart: FixtureEndpoint | null;
  fixture: typeof FIXTURE_FACTS;
  successfulLegs: number;
  queryVerifiedLegs: number;
  directions: string[];
  savedCheckpointReports: number;
  metadata: ReturnType<typeof collectMetadata> | null;
  evidence: { dir: string; metrics: string; events: string } | null;
  primaryError: ReturnType<typeof errorFacts> | null;
  cleanupErrors: { step: string; error: ReturnType<typeof errorFacts> }[];
  evidenceFailure: ReturnType<typeof errorFacts> | null;
  shutdown: Record<string, unknown> | null;
  h2: typeof H2_PENDING;
}

/**
 * H2a 的真实 smoke 执行器。
 *
 * 只在 config.mode === 'test' 时运行；setup 使用只读 list 和一次自有 Bot 的 tp，
 * 之后的一切世界事实来自正常 Vision 与生产 walk_to/spatial_query。任何错误都先
 * 停止新任务、采集终态分类，再做有界清理；证据与数据库保留。
 */
async function runSmoke(cli: Extract<ParsedCli, { ok: true; help: false }>): Promise<number> {
  const { config } = await import('../src/config.ts');
  if (config.mode !== 'test') {
    process.stderr.write(`spatial-soak-acceptance: only test mode is accepted, got ${config.mode}\n`);
    return 3;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  let metadata: ReturnType<typeof collectMetadata> | null = null;
  try {
    metadata = collectMetadata(repoRoot, scriptPath);
  } catch (error) {
    process.stderr.write(`spatial-soak-acceptance: metadata unavailable: ${errorText(error)}\n`);
    return 1;
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceDir = path.join(config.dataDir, 'spatial-soak', runId);
  const metricsPath = path.join(evidenceDir, 'metrics.jsonl');
  const eventsPath = path.join(evidenceDir, 'events.jsonl');
  mkdirSync(evidenceDir, { recursive: true });

  const startedAt = Date.now();
  const outcomes = new Map<string, TaskOutcome>();
  const waitTimers = new Set<NodeJS.Timeout>();
  const perTask = new Map<string, TaskWindow>();
  const executorTasks = new WeakMap<object, { taskId: string; delegationId: string }>();
  const takenTraceKeys = new Set<string>();

  let eventsWriter: BoundedJsonlWriter | null = null;
  let evidenceEmitter: EvidenceEmitter | null = null;
  let foundation: SpatialSoakFoundation | null = null;
  let spatial: SharedSpatialSession | null = null;
  let memory: WorldMemory | null = null;
  let vision: Vision | null = null;
  let arbiter: Arbiter | null = null;
  let rcon: Rcon | null = null;
  let adapter: MineflayerAdapter | null = null;
  let library: typeof import('curio-minecraft-3d-memory') | null = null;
  let doneListener: ((outcome: TaskOutcome) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  let spawnListener: (() => void) | null = null;
  let botEndListener: (() => void) | null = null;
  let physicsTickListener: (() => void) | null = null;
  interface OwnedBotHandle {
    once(event: 'end', listener: () => void): void;
    on(event: 'physicsTick', listener: () => void): void;
    removeListener(event: 'end' | 'physicsTick', listener: () => void): void;
    listenerCount?(event: string): number;
  }
  let ownedBot: OwnedBotHandle | null = null;
  // TypeScript 不会把闭包内对 ownedBot 的赋值反映到外层的控制流收窄，用显式读取函数
  // 保持清理代码看到真实的可空句柄类型。
  const ownedBotHandle = (): OwnedBotHandle | null => ownedBot;
  let executorOriginalStart: ((this: WalkRouteExecutor, request: WalkRouteRequest) => WalkRouteStatus) | null = null;
  let executorOriginalOnSample: ((this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus) | null = null;
  let executorWrappedStart: ((this: WalkRouteExecutor, request: WalkRouteRequest) => WalkRouteStatus) | null = null;
  let executorWrappedOnSample: ((this: WalkRouteExecutor, sample: BodySample) => WalkRouteStatus) | null = null;
  let moverOriginalMove: ((this: unknown, request: ExecutableMove) => Promise<ExecutableMoveResult>) | null = null;
  let moverWrappedMove: ((this: unknown, request: ExecutableMove) => Promise<ExecutableMoveResult>) | null = null;

  let connectAttempted = false;
  let spawnObserved = false;
  let botOwned = false;
  let botEnded = false;
  let adapterDisconnected = false;
  let runScope: RuntimeScope | null = null;
  let measuredStart: FixtureEndpoint | null = null;
  let activeStartedAt: number | null = null;
  let activeFinishedAt: number | null = null;
  let successfulLegs = 0;
  let queryVerifiedLegs = 0;
  let savedCheckpointReports = 0;
  const directions = new Set<string>();
  let snapshotTimer: NodeJS.Timeout | null = null;
  let snapshotCallbacks = 0;
  const physicsTicks = createPhysicsTickMetrics();
  let adapterListenerBaseline: { spawn: number | null; disconnected: number | null } = { spawn: null, disconnected: null };
  let botListenerBaseline: { physicsTick: number | null; end: number | null } = { physicsTick: null, end: null };
  let primaryError: unknown = null;
  const cleanupErrors: Array<{ step: string; error: unknown }> = [];
  let shutdownFactsResult: Record<string, unknown> | null = null;
  let stopping = false;
  let moveCallSequence = 0;
  let startCallSequence = 0;

  const currentEvidenceFailure = (): unknown =>
    evidenceEmitter?.failure ?? foundation?.evidenceFailure ?? null;

  const emit = (kind: string, taskId: string | null, payload: unknown) =>
    evidenceEmitter?.emit(kind, taskId, payload) ?? null;

  const noteCleanupError = (step: string, error: unknown): void => {
    cleanupErrors.push({ step, error });
    emit('cleanup-error', null, { step, error: errorFacts(error) });
  };

  // 这些诊断函数在 try 和 finally 两处都要用；状态变量已在上面声明。
  const connectionListenerSnapshot = () => ({
    adapter: {
      spawn: listenerCountOf(adapter, 'spawn'),
      disconnected: listenerCountOf(adapter, 'disconnected'),
    },
    bot: {
      physicsTick: listenerCountOf(ownedBot, 'physicsTick'),
      end: listenerCountOf(ownedBot, 'end'),
    },
  });

  const connectionSnapshot = (label: string) => {
    const at = Date.now();
    const ticks = physicsTicks.snapshot();
    return {
      kind: 'connection-metrics',
      label,
      at,
      activeElapsedMs: activeStartedAt === null ? null : at - activeStartedAt,
      physicsTicks: ticks,
      callbacks: { physicsTickListenerCalls: ticks.count, snapshotCallbacks },
      listeners: {
        baseline: { adapter: adapterListenerBaseline, bot: botListenerBaseline },
        current: connectionListenerSnapshot(),
      },
      foundationMetrics: foundation?.snapshotMetrics() ?? null,
      residency: {
        state: 'unavailable',
        detail: 'SharedSpatialSession exposes no public residency/pin API; H2a does not probe private state. Manual integration remains pending.',
      },
    };
  };

  const traceOverflow = (kind: 'samples' | 'moves' | 'starts', taskId: string): void => {
    const key = `${taskId}:${kind}`;
    if (takenTraceKeys.has(key)) return;
    takenTraceKeys.add(key);
    const limit = kind === 'samples' ? MAX_SAMPLES_PER_TASK : kind === 'moves' ? MAX_MOVES_PER_TASK : MAX_STARTS_PER_TASK;
    emit('trace-window-exceeded', taskId, {
      kind,
      limit,
      note: 'Explicit evidence-capacity failure; the run is cancelled rather than silently truncating the classifier window.',
    });
    const active = arbiter?.info() ?? null;
    if (active !== null && active.id === taskId) {
      try {
        arbiter?.cancel(`harness evidence capacity exceeded: ${kind} > ${limit}`);
      } catch (error) {
        emit('cancel-error', taskId, { reason: 'evidence-capacity', error: errorFacts(error) });
      }
    }
  };

  const taskWindow = (taskId: string): TaskWindow => {
    const existing = perTask.get(taskId);
    if (existing !== undefined) return existing;
    const created: TaskWindow = { samples: [], moves: [], starts: [], lastSequence: -1 };
    perTask.set(taskId, created);
    return created;
  };

  const waitForTaskOutcome = (taskId: string, timeoutMs: number, checkEvidence: boolean): Promise<TaskOutcome | null> => {
    const existing = outcomes.get(taskId);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<TaskOutcome | null>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        const outcome = outcomes.get(taskId);
        if (outcome !== undefined) {
          clearInterval(timer);
          waitTimers.delete(timer);
          resolve(outcome);
          return;
        }
        if (checkEvidence) {
          const failure = currentEvidenceFailure();
          if (failure !== null) {
            clearInterval(timer);
            waitTimers.delete(timer);
            reject(new Error(`evidence failure while waiting for task ${taskId}: ${errorText(failure)}`));
            return;
          }
        }
        if (Date.now() >= deadline) {
          clearInterval(timer);
          waitTimers.delete(timer);
          resolve(null);
        }
      }, 50);
      waitTimers.add(timer);
    });
  };

  const waitForEvidenceAware = async (predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (predicate()) return true;
      const failure = currentEvidenceFailure();
      if (failure !== null) throw new Error(`evidence failure during ${label}: ${errorText(failure)}`);
      if (Date.now() >= deadline) return predicate();
      await sleep(50);
    }
  };

  const runQuery = async (legTaskId: string, dim: string): Promise<void> => {
    if (arbiter === null || runScope === null) throw new Error('spatial query requested before runtime scope is ready');
    if (stopping) throw new Error('run is stopping; refusing spatial_query');
    const args = { kind: 'fragments', dim, limit: 8 };
    const started = arbiter.start({ skill: 'spatial_query', args }, 'user');
    if ('error' in started) throw new Error(`spatial_query rejected: ${started.error}`);
    const info = started as TaskInfo;
    emit('query-start', info.id, { legTaskId, request: clone(args), task: clone(info), startedAt: Date.now() });
    const outcome = await waitForTaskOutcome(info.id, 20_000, true);
    emit('query-outcome', info.id, { legTaskId, outcome: outcome === null ? null : clone(outcome) });
    try {
      if (outcome === null) throw new Error('spatial_query timed out before terminal outcome');
      if (outcome.result.status !== 'succeeded') throw new Error(`spatial_query status ${outcome.result.status}`);
      const query = isRecordValue(outcome.result.data) ? outcome.result.data.spatialQuery : undefined;
      const checked = validateFragmentsQuery(query);
      emit('query-verdict', info.id, { legTaskId, verdict: checked, query: query === undefined ? null : clone(query) });
      if (!checked.ok) throw new Error(`spatial_query invalid: ${checked.problems.join(', ')}`);
      queryVerifiedLegs += 1;
    } finally {
      outcomes.delete(info.id);
    }
  };

  const classifyLegTrace = (
    nav: Record<string, unknown> | null,
    taskId: string,
    samples: readonly CapturedRouteSample[],
    moves: readonly CapturedMove[],
  ): { ok: boolean; problems: string[] } => {
    const problems: string[] = [];
    const trace = nav !== null && Array.isArray(nav.trace)
      ? nav.trace.filter((entry): entry is { pos: FixtureEndpoint; ts: number } =>
        isRecordValue(entry) && isVec(entry.pos) && isNumberValue(entry.ts))
      : [];
    if (nav === null || nav.confirmed !== true) problems.push('missing confirmed nav trace');
    if (trace.length === 0) problems.push('confirmed nav trace has no points');
    for (let index = 0; index < trace.length; index += 1) {
      const point = trace[index]!;
      const matched = samples.some((sample) =>
        sample.taskId === taskId
        && sample.accepted
        && sample.sample.observedAt === point.ts
        && isDeepStrictEqual(sample.sample.position, point.pos));
      if (!matched) problems.push(`trace point ${index} does not match an accepted same-task raw sample`);
    }

    const taskMoves = moves.filter((move) => move.taskId === taskId);
    for (let index = 1; index < taskMoves.length; index += 1) {
      const previous = taskMoves[index - 1]!;
      const current = taskMoves[index]!;
      const previousPosition = previous.result?.sample?.position;
      if (previousPosition === undefined) {
        problems.push(`move ${index - 1} has no actual result sample required by move ${index}.from`);
        continue;
      }
      if (!isDeepStrictEqual(current.request.from, previousPosition)) {
        problems.push(`move ${index}.from does not match previous actual trace position`);
      }
    }
    return { ok: problems.length === 0, problems };
  };

  const runLeg = async (
    index: number,
    from: FixtureEndpoint,
    target: FixtureEndpoint,
    nominalFrom: 'A' | 'B',
    nominalTo: 'A' | 'B',
  ): Promise<void> => {
    if (arbiter === null) throw new Error('walk leg requested before arbiter is ready');
    if (runScope === null) throw new Error('walk leg requested before runtime scope is ready');
    if (stopping) throw new Error('run is stopping; refusing walk_to');
    const request = {
      to: clone(target),
      arrival: { kind: 'exact' as const },
      deadlineMs: Date.now() + SMOKE_LEG_BUDGET_MS,
    };
    const started = arbiter.start({ skill: 'walk_to', args: request }, 'user');
    if ('error' in started) throw new Error(`walk_to rejected: ${started.error}`);
    const info = started as TaskInfo;
    emit('leg-start', info.id, {
      index,
      nominal: { from: nominalFrom, to: nominalTo },
      from: clone(from),
      target: clone(target),
      request: clone(request),
      task: clone(info),
      startedAt: Date.now(),
    });

    try {
      const outcome = await waitForTaskOutcome(info.id, SMOKE_LEG_BUDGET_MS + 5_000, true);
      if (outcome === null) {
        emit('leg-timeout', info.id, { index, budgetMs: SMOKE_LEG_BUDGET_MS + 5_000 });
        throw new Error(`walk_to leg ${index} timed out before terminal outcome`);
      }
      const terminalState = adapter!.state();
      const terminalControls = controlsSnapshot(adapter!);
      const window = perTask.get(info.id) ?? { samples: [], moves: [], starts: [], lastSequence: -1 };
      const tolerance = library!.GROUNDED_ARRIVAL_DEFAULTS;
      const verdict = classifyWalkToResult(outcome.result, from, target, tolerance, {
        taskId: info.id,
        samples: window.samples,
      });
      const bodyVerdict = classifyTerminalBody(
        { state: terminalState, controls: terminalControls.values },
        target,
        tolerance,
        runScope,
      );
      const traceVerdict = classifyLegTrace(verdict.nav, info.id, window.samples, window.moves);
      const finishedAt = Date.now();
      emit('leg-result', info.id, {
        index,
        nominal: { from: nominalFrom, to: nominalTo },
        from: clone(from),
        target: clone(target),
        startedAt: request.deadlineMs - SMOKE_LEG_BUDGET_MS,
        finishedAt,
        outcome: clone(outcome),
        body: clone(terminalState),
        controls: terminalControls,
        verdict,
        bodyVerdict,
        traceVerdict,
        samplesKept: window.samples.length,
        movesKept: window.moves.length,
      });
      const problems = [...verdict.problems, ...bodyVerdict.problems, ...traceVerdict.problems];
      if (problems.length > 0) throw new Error(`walk_to leg ${index} failed verification: ${problems.join(', ')}`);
      successfulLegs += 1;
      await runQuery(info.id, terminalState.dim);
    } finally {
      perTask.delete(info.id);
      outcomes.delete(info.id);
    }
  };

  try {
    eventsWriter = new BoundedJsonlWriter(eventsPath);
    evidenceEmitter = createEvidenceEmitter(eventsWriter, runId);
    emit('run-start', null, {
      metadata,
      mode: cli.mode,
      start: clone(cli.start),
      startRaw: cli.startRaw,
      durationMs: cli.durationMs,
      fixture: FIXTURE_FACTS,
      note: 'H2a bounded smoke. RCON is limited to list and one setup tp of the configured test Bot; world facts come from normal Vision/navigation.',
    });

    const { EventBus } = await import('../src/events.ts');
    const { MineflayerAdapter: MineflayerAdapterClass } = await import('../src/adapter/mineflayer.ts');
    const { Vision: VisionClass } = await import('../src/perception/vision.ts');
    const { WorldMemory: WorldMemoryClass } = await import('../src/memory/store.ts');
    const { Arbiter: ArbiterClass } = await import('../src/arbiter/arbiter.ts');
    const { SharedSpatialSession: SharedSpatialSessionClass } = await import('../src/spatial/shared-session.ts');
    const { Rcon: RconClass } = await import('../src/observer/rcon.ts');
    const { WalkMoveExecutor: WalkMoveExecutorClass } = await import('../src/adapter/walk-route.ts');
    library = await import('curio-minecraft-3d-memory');

    const bus = new EventBus();
    adapter = new MineflayerAdapterClass(config, bus);
    spatial = await SharedSpatialSessionClass.open({
      worldId: config.memory.worldId,
      databasePath: path.join(evidenceDir, 'spatial.sqlite'),
      timeoutMs: 5000,
    });
    memory = new WorldMemoryClass(null);
    vision = new VisionClass(adapter, config.vision, spatial);
    arbiter = new ArbiterClass(adapter, memory, bus, vision, spatial);
    rcon = new RconClass(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);

    foundation = startSpatialSoakFoundation({
      service: spatial,
      evidencePath: metricsPath,
      runId,
      onCheckpointReport: (report) => {
        if (report.status === 'saved') savedCheckpointReports += 1;
        emit('checkpoint-report', null, { report, savedCheckpointReports });
      },
    });

    adapterListenerBaseline = {
      spawn: listenerCountOf(adapter, 'spawn'),
      disconnected: listenerCountOf(adapter, 'disconnected'),
    };
    disconnectListener = () => {
      adapterDisconnected = true;
      emit('adapter-disconnected', null, { at: Date.now() });
    };
    adapter.on('disconnected', disconnectListener);

    doneListener = (outcome: TaskOutcome) => {
      outcomes.set(outcome.task.id, outcome);
      // 真实终态（含失败/取消）在 done 到达时立即完整落盘，不等到清理。
      emit('task-done', outcome.task.id, { outcome });
    };
    arbiter.on('done', doneListener);

    // 只在真实原型方法仍是我们安装的版本时还原；不改动旧脚本。
    const executorProto = library.WalkRouteExecutor.prototype as unknown as {
      start(this: WalkRouteExecutor, request: WalkRouteRequest): WalkRouteStatus;
      onSample(this: WalkRouteExecutor, sample: BodySample): WalkRouteStatus;
    };
    executorOriginalStart = executorProto.start;
    executorOriginalOnSample = executorProto.onSample;
    executorWrappedStart = function (this: WalkRouteExecutor, request: WalkRouteRequest) {
      const status = executorOriginalStart!.call(this, request);
      const task = arbiter?.info() ?? null;
      if (task !== null) {
        executorTasks.set(this as unknown as object, { taskId: task.id, delegationId: status.delegationId });
        const window = taskWindow(task.id);
        const startRecord = {
          taskId: task.id,
          delegationId: status.delegationId,
          receivedAt: Date.now(),
          request: {
            worldId: request.worldId,
            dim: request.dim,
            sessionId: request.sessionId,
            mode: request.mode,
            body: clone(request.body),
            points: clone(request.points),
            arrival: clone(request.arrival),
            ...(request.bodyArrival === undefined ? {} : { bodyArrival: clone(request.bodyArrival) }),
            deadlineMs: request.deadlineMs,
            timeoutMs: request.timeoutMs,
          },
          status: {
            delegationId: status.delegationId,
            nextPointIndex: status.nextPointIndex,
            activeStepIndex: status.activeStepIndex,
            lastPosition: status.lastPosition === null ? null : clone(status.lastPosition),
            resultOutcome: status.result === null ? null : status.result.outcome,
          },
        };
        if (window.starts.length >= MAX_STARTS_PER_TASK) traceOverflow('starts', task.id);
        else window.starts.push(startRecord);
        emit('executor-start', task.id, { call: ++startCallSequence, start: startRecord });
      } else {
        emit('executor-start', null, {
          call: ++startCallSequence,
          delegationId: status.delegationId,
          note: 'No active Arbiter task; request is not attributed to a task.',
        });
      }
      return status;
    };
    executorWrappedOnSample = function (this: WalkRouteExecutor, sample: BodySample) {
      const returned = executorOriginalOnSample!.call(this, sample);
      const binding = executorTasks.get(this as unknown as object);
      const scopeOk = binding !== undefined && runScope !== null
        && sample.worldId === runScope.worldId
        && sample.dim === runScope.dim
        && sample.sessionId === runScope.sessionId;
      const window = binding === undefined ? null : perTask.get(binding.taskId) ?? null;
      const ordered = binding === undefined || window === null
        ? false
        : Number.isInteger(sample.sequence) && sample.sequence > window.lastSequence;
      const accepted = binding !== undefined
        && scopeOk
        && ordered
        && sample.executionId === binding.delegationId
        && returned.delegationId === binding.delegationId
        && isDeepStrictEqual(returned.lastPosition, sample.pos);
      const captured: CapturedRouteSample | null = binding === undefined ? null : {
        taskId: binding.taskId,
        delegationId: binding.delegationId,
        accepted,
        receivedAt: Date.now(),
        sample: {
          executionId: sample.executionId,
          sequence: sample.sequence,
          worldId: sample.worldId,
          dim: sample.dim,
          sessionId: sample.sessionId,
          observedAt: sample.observedAt,
          position: { ...sample.pos },
          onGround: sample.onGround,
          inWater: sample.inWater,
        },
        returned: {
          delegationId: returned.delegationId,
          lastPosition: returned.lastPosition === null ? null : { ...returned.lastPosition },
          nextPointIndex: returned.nextPointIndex,
          activeStepIndex: returned.activeStepIndex,
          resultOutcome: returned.result === null ? null : returned.result.outcome,
          resultLastPosition: returned.result?.lastPosition === undefined ? null : { ...returned.result.lastPosition },
          resultLastObservation: returned.result?.lastObservation === undefined
            ? null
            : { ...returned.result.lastObservation } as Record<string, unknown>,
        },
      };
      emit('walk-sample', binding?.taskId ?? null, {
        accepted,
        sample: captured,
        scopeOk,
        ordered,
        windowOverflow: false,
      });
      if (captured !== null && window !== null) {
        if (window.samples.length >= MAX_SAMPLES_PER_TASK) {
          traceOverflow('samples', captured.taskId);
        } else {
          window.samples.push(captured);
          if (ordered) window.lastSequence = sample.sequence;
        }
      }
      return returned;
    };
    executorProto.start = executorWrappedStart;
    executorProto.onSample = executorWrappedOnSample;

    const moverProto = WalkMoveExecutorClass.prototype as unknown as {
      move(this: unknown, request: ExecutableMove): Promise<ExecutableMoveResult>;
    };
    moverOriginalMove = moverProto.move;
    moverWrappedMove = function (this: unknown, request: ExecutableMove) {
      const taskId = arbiter?.info()?.id ?? null;
      const window = taskId === null ? null : taskWindow(taskId);
      const canKeep = window !== null && window.moves.length < MAX_MOVES_PER_TASK;
      if (window !== null && !canKeep) traceOverflow('moves', taskId!);
      const sink: CapturedMove[] = canKeep ? window!.moves : [];
      const call = ++moveCallSequence;
      const pending = captureMoveCall(
        { move: (moveRequest) => moverOriginalMove!.call(this, moveRequest) },
        request,
        taskId,
        sink,
      );
      const entry = sink.at(-1);
      if (entry !== undefined) emit('walk-move-request', taskId, { call, move: clone(entry) });
      return pending.then(
        (result) => {
          const current = sink.at(-1);
          if (current !== undefined) emit('walk-move-result', taskId, { call, move: clone(current) });
          return result;
        },
        (error: unknown) => {
          const current = sink.at(-1);
          if (current !== undefined) emit('walk-move-error', taskId, { call, move: clone(current), error: errorFacts(error) });
          throw error;
        },
      );
    };
    moverProto.move = moverWrappedMove;

    const botName = config.mc.username;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(botName)) throw new Error(`unsafe bot username: ${botName}`);

    const sendRcon = async (command: string): Promise<string> => {
      const tpPrefix = `tp ${botName} `;
      const tpAllowed = command.startsWith(tpPrefix)
        && /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(command.slice(tpPrefix.length));
      if (!(command === 'list' || tpAllowed)) throw new Error(`RCON command not allowed: ${command}`);
      emit('rcon-request', null, { command, at: Date.now() });
      const response = await rcon!.send(command);
      emit('rcon-response', null, { command, response, at: Date.now() });
      return response;
    };

    const preflight = parseRconList(await sendRcon('list'));
    emit('rcon-preflight', null, { at: Date.now(), preflight });
    const conflict = preflightBotConflict(preflight.names, botName);
    if (conflict !== null) throw new Error(conflict);

    spawnListener = () => {
      spawnObserved = true;
      emit('spawn', null, { at: Date.now() });
    };
    adapter.once('spawn', spawnListener);
    const captureOwnBot = (): void => {
      if (ownedBot !== null || adapter?.bot === null || adapter?.bot === undefined) return;
      ownedBot = adapter.bot as unknown as OwnedBotHandle;
      botOwned = true;
      botListenerBaseline = {
        physicsTick: listenerCountOf(ownedBot, 'physicsTick'),
        end: listenerCountOf(ownedBot, 'end'),
      };
      botEndListener = () => {
        botEnded = true;
        emit('bot-end', null, { at: Date.now() });
      };
      physicsTickListener = () => physicsTicks.record(Date.now());
      ownedBot!.once('end', botEndListener);
      ownedBot!.on('physicsTick', physicsTickListener);
      emit('adapter-listeners', null, {
        baseline: { adapter: adapterListenerBaseline, bot: botListenerBaseline },
        current: connectionListenerSnapshot(),
        note: 'baseline is captured before this harness attaches its own listeners.',
      });
    };

    connectAttempted = true;
    adapter.connect();
    captureOwnBot();
    try {
      const spawned = await waitForEvidenceAware(() => spawnObserved, 30_000, 'bounded spawn wait');
      if (!spawned) throw new Error('bounded spawn wait timed out');
      captureOwnBot();
    } finally {
      if (spawnListener !== null) {
        adapter.off('spawn', spawnListener);
        spawnListener = null;
      }
    }
    const ready = await waitForEvidenceAware(
      () => adapter!.state().observationReady,
      30_000,
      'bounded observationReady wait',
    );
    if (!ready) throw new Error('bounded observationReady wait timed out');

    const postConnect = parseRconList(await sendRcon('list'));
    emit('rcon-post-connect', null, { at: Date.now(), postConnect });
    if (postConnect.names.filter((name) => name === botName).length !== 1) {
      throw new Error(`post-connect RCON list must contain owned bot exactly once; got ${JSON.stringify(postConnect.names)}`);
    }

    const nextPhysicsFrame = async (timeoutMs: number): Promise<{ position: FixtureEndpoint; onGround: boolean; isInWater: boolean } | null> => {
      const tick = adapter!.walkTick?.();
      if (tick === undefined) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      try {
        const entity = await tick(controller.signal);
        if (entity === null) return null;
        return {
          position: { ...entity.position },
          onGround: entity.onGround,
          isInWater: entity.isInWater,
        };
      } finally {
        clearTimeout(timer);
      }
    };

    const collectSetupSettle = async (timeoutMs: number): Promise<{ position: FixtureEndpoint; frames: PhysicsFrame[] }> => {
      const frames: PhysicsFrame[] = [];
      const settleStartedAt = Date.now();
      let settled = classifySettledFrames(frames, 300);
      let frameNumber = 0;
      while (!settled.ok && Date.now() - settleStartedAt < timeoutMs) {
        const entity = await nextPhysicsFrame(Math.min(1_000, timeoutMs - (Date.now() - settleStartedAt)));
        if (entity === null) break;
        frames.push({
          frame: ++frameNumber,
          at: Date.now(),
          position: { ...entity.position },
          onGround: entity.onGround,
          inWater: entity.isInWater,
          controls: controlsSnapshot(adapter!).values,
        });
        settled = classifySettledFrames(frames, 300);
      }
      if (!settled.ok || settled.position === null) {
        throw new Error(`bounded body settle failed: ${settled.problems.join(', ')}`);
      }
      if (!adapter!.state().observationReady) throw new Error('body settled only after observationReady was lost');
      return { position: settled.position, frames };
    };

    snapshotTimer = setInterval(() => {
      snapshotCallbacks += 1;
      foundation?.appendMetrics(connectionSnapshot('interval'));
    }, CONNECTION_SNAPSHOT_INTERVAL_MS);
    snapshotTimer.unref();

    const fixtureTeleport = async (position: FixtureEndpoint, label: string): Promise<FixtureEndpoint> => {
      if (arbiter!.info() !== null) throw new Error(`refusing fixture tp while a task is active (${label})`);
      if (adapter!.state().username !== botName) {
        throw new Error(`connected bot identity ${adapter!.state().username} is not configured test user ${botName}`);
      }
      if (!isVec(position) || !inLane(position)) throw new Error(`refusing to tp outside lane: ${JSON.stringify(position)}`);
      const list = parseRconList(await sendRcon('list'));
      if (list.names.filter((name) => name === botName).length !== 1) {
        throw new Error(`fixture tp requires RCON to list the configured test bot exactly once`);
      }
      const command = `tp ${botName} ${String(position.x)} ${String(position.y)} ${String(position.z)}`;
      emit('fixture-tp', null, { label, at: Date.now(), command, position: clone(position) });
      await sendRcon(command);
      const reached = await waitForEvidenceAware(() => {
        const state = adapter!.state();
        return state.observationReady && state.onGround && distance(state.pos, position) <= 0.75;
      }, 10_000, `fixture tp settle (${label})`);
      if (!reached) throw new Error(`fixture tp did not settle at ${label}`);
      const settled = await collectSetupSettle(15_000);
      emit('setup-settle', null, {
        label,
        requested: clone(position),
        settled: clone(settled.position),
        frames: settled.frames,
        note: 'Setup physics frames are kept separate from navigation leg traces.',
      });
      const interference = adapter!.nearbyEntities(24)
        .filter((entity) => entity.kind === 'player' && entity.name !== botName && inLane(entity.pos))
        .map((entity) => ({ name: entity.name, pos: { ...entity.pos }, dist: entity.dist }));
      emit('lane-interference-check', null, { label, at: Date.now(), players: interference });
      if (interference.length > 0) {
        throw new Error(`player(s) in reserved measurement lane at ${label}: ${interference.map((entry) => entry.name).join(',')}`);
      }
      return settled.position;
    };

    measuredStart = await fixtureTeleport(cli.start, 'initial-safe-start');
    emit('measured-start', null, { measured: clone(measuredStart), requested: clone(cli.start) });

    const initialCells = localBodyCells(measuredStart);
    const initialObservations = vision.observeBlocks(initialCells);
    const admitted = spatial.observationAdmitted;
    emit('initial-observation', null, initialObservationFacts(admitted, initialCells, initialObservations, Date.now()));
    if (!admitted) throw new Error('initial Vision observation was not admitted by the shared session');

    const state = adapter.state();
    runScope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    emit('runtime-scope', null, { scope: clone(runScope) });

    const endpointName = (point: FixtureEndpoint): 'A' | 'B' => samePoint(point, FIXTURE_A) ? 'A' : 'B';
    let nominalFrom = endpointName(cli.start);
    let from: FixtureEndpoint = measuredStart;
    const activeDeadline = (activeStartedAt = Date.now()) + cli.durationMs;
    let legIndex = 0;

    const smokeSatisfied = (): boolean =>
      successfulLegs >= SMOKE_MIN_SUCCESSFUL_LEGS
      && directions.has('A->B')
      && directions.has('B->A')
      && queryVerifiedLegs >= successfulLegs
      && savedCheckpointReports >= SMOKE_MIN_CHECKPOINT_SAVES;

    while (!stopping && !smokeSatisfied()) {
      const remaining = activeDeadline - Date.now();
      if (remaining < SMOKE_LEG_BUDGET_MS + 5_000) break;
      const nominalTo = nominalFrom === 'A' ? 'B' : 'A';
      const target = nominalTo === 'A' ? FIXTURE_A : FIXTURE_B;
      await runLeg(legIndex, from, target, nominalFrom, nominalTo);
      directions.add(`${nominalFrom}->${nominalTo}`);
      nominalFrom = nominalTo;
      // 每段使用固定标称端点，避免累计浮点漂移；实际起点/终态仍按实测分类。
      from = target;
      legIndex += 1;
    }

    if (!smokeSatisfied() && !stopping) {
      // 剩余时间不足以保证下一段 45s 委托时，只做有界等待，不启动必然超时的任务。
      const idleRemaining = Math.max(0, activeDeadline - Date.now());
      if (idleRemaining > 0) {
        await waitForEvidenceAware(
          () => smokeSatisfied() || Date.now() >= activeDeadline,
          idleRemaining,
          'smoke completion wait',
        );
      }
    }
    activeFinishedAt = Date.now();
    if (!smokeSatisfied()) {
      throw new Error(
        `smoke criteria not met: legs=${successfulLegs} directions=${[...directions].join(',')} queries=${queryVerifiedLegs} savedCheckpoints=${savedCheckpointReports}`,
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    stopping = true;
    activeFinishedAt ??= Date.now();
    if (snapshotTimer !== null) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
    for (const timer of waitTimers) clearInterval(timer);
    waitTimers.clear();

    const botHandle = ownedBotHandle();
    if (botHandle !== null && physicsTickListener !== null) {
      botHandle.removeListener('physicsTick', physicsTickListener);
      physicsTickListener = null;
    }
    // 移除自有监听器后再取最终连接快照，明确显示 current 已回落。
    if (foundation !== null) {
      foundation.appendMetrics(connectionSnapshot('final'));
      emit('connection-final', null, {
        physicsTicks: physicsTicks.snapshot(),
        listeners: connectionListenerSnapshot(),
        foundationMetrics: foundation.snapshotMetrics(),
        residency: { state: 'unavailable', detail: 'No public residency/pin API; not probed.' },
      });
    }

    if (arbiter !== null) {
      const active = arbiter.info();
      if (active !== null) {
        const reason = 'harness cleanup: soak run finishing; no further tasks will be started';
        emit('harness-cancel', active.id, { reason, at: Date.now() });
        try {
          arbiter.cancel(reason);
        } catch (error) {
          noteCleanupError('cancel', error);
        }
        try {
          const ended = await waitForTaskOutcome(active.id, 10_000, false);
          emit('harness-cancel-outcome', active.id, { outcome: ended === null ? null : clone(ended) });
          if (ended === null) noteCleanupError('cancel-await', new Error('bounded active-task end wait timed out'));
        } catch (error) {
          noteCleanupError('cancel-await', error);
        }
      }
    }

    if (foundation !== null) {
      try {
        const stopped = await withTimeout(foundation.stop(), 60_000, 'bounded foundation stop');
        shutdownFactsResult = shutdownFacts(stopped.shutdown);
        emit('shutdown', null, {
          shutdown: shutdownFactsResult,
          evidenceError: stopped.evidenceError === null ? null : errorFacts(stopped.evidenceError),
          h2: H2_PENDING,
        });
      } catch (error) {
        noteCleanupError('foundation-stop', error);
      }
    }

    if (arbiter !== null) {
      try {
        arbiter.dispose();
      } catch (error) {
        noteCleanupError('arbiter-dispose', error);
      }
    }
    if (memory !== null) {
      try {
        memory.close();
      } catch (error) {
        noteCleanupError('memory-close', error);
      }
    }
    if (rcon !== null) {
      try {
        rcon.close();
      } catch (error) {
        noteCleanupError('rcon-close', error);
      }
    }

    if (connectAttempted && adapter !== null) {
      try {
        // connect() 一旦发起就必须 quit，即使 spawn 失败或 bot 已结束，以禁用重连。
        adapter.quit();
        const ended = await waitFor(() => botEnded && adapterDisconnected, 5_000);
        const classification = classifyAdapterEnd(botEnded, adapterDisconnected, !ended);
        emit('adapter-end', null, {
          ...classification,
          connectAttempted,
          spawnObserved,
          botOwned,
          botEnded,
          adapterDisconnected,
        });
        if (!classification.ok) {
          noteCleanupError('adapter-end', new Error(classification.problems.join(', ')));
        }
      } catch (error) {
        noteCleanupError('adapter-quit', error);
      }
    } else {
      emit('adapter-end', null, {
        status: 'not-owned: no Bot client was connected by this harness',
        connectAttempted,
        spawnObserved,
      });
    }

    if (adapter !== null && disconnectListener !== null) {
      adapter.off('disconnected', disconnectListener);
      disconnectListener = null;
    }
    if (adapter !== null && spawnListener !== null) {
      adapter.off('spawn', spawnListener);
      spawnListener = null;
    }
    if (botHandle !== null && botEndListener !== null) {
      botHandle.removeListener('end', botEndListener);
      botEndListener = null;
    }

    // 只还原自己安装的实际原型包装；若已被他人替换则不动。
    if (library !== null) {
      const executorProto = library.WalkRouteExecutor.prototype as unknown as {
        start(this: WalkRouteExecutor, request: WalkRouteRequest): WalkRouteStatus;
        onSample(this: WalkRouteExecutor, sample: BodySample): WalkRouteStatus;
      };
      if (executorOriginalStart !== null && executorWrappedStart !== null && executorProto.start === executorWrappedStart) {
        executorProto.start = executorOriginalStart;
      }
      if (executorOriginalOnSample !== null && executorWrappedOnSample !== null && executorProto.onSample === executorWrappedOnSample) {
        executorProto.onSample = executorOriginalOnSample;
      }
      const moverProto = (await import('../src/adapter/walk-route.ts')).WalkMoveExecutor.prototype as unknown as {
        move(this: unknown, request: ExecutableMove): Promise<ExecutableMoveResult>;
      };
      if (moverOriginalMove !== null && moverWrappedMove !== null && moverProto.move === moverWrappedMove) {
        moverProto.move = moverOriginalMove;
      }
    }

    outcomes.clear();
    perTask.clear();
    takenTraceKeys.clear();
  }

  activeFinishedAt ??= Date.now();
  const evidenceFailure = currentEvidenceFailure();
  const smokePass = primaryError === null
    && evidenceFailure === null
    && cleanupErrors.length === 0
    && successfulLegs >= SMOKE_MIN_SUCCESSFUL_LEGS
    && directions.has('A->B')
    && directions.has('B->A')
    && queryVerifiedLegs >= successfulLegs
    && savedCheckpointReports >= SMOKE_MIN_CHECKPOINT_SAVES;

  const report: RunReport = {
    schema: 'spatial-soak-acceptance',
    runId,
    mode: 'smoke',
    status: smokePass ? 'SMOKE_PASS' : 'FAIL',
    smokePass,
    fullPass: false,
    longRunCompleted: false,
    pendingMandatory: H2A_PENDING_MANDATORY,
    startedAt: activeStartedAt === null ? null : activeStartedAt,
    finishedAt: activeFinishedAt,
    activeElapsedMs: activeStartedAt === null ? null : Math.max(0, activeFinishedAt - activeStartedAt),
    durationMs: cli.durationMs,
    start: clone(cli.start),
    measuredStart: measuredStart === null ? null : clone(measuredStart),
    fixture: FIXTURE_FACTS,
    successfulLegs,
    queryVerifiedLegs,
    directions: [...directions],
    savedCheckpointReports,
    metadata,
    evidence: { dir: evidenceDir, metrics: metricsPath, events: eventsPath },
    primaryError: primaryError === null ? null : errorFacts(primaryError),
    cleanupErrors: cleanupErrors.map((entry) => ({ step: entry.step, error: errorFacts(entry.error) })),
    evidenceFailure: evidenceFailure === null ? null : errorFacts(evidenceFailure),
    shutdown: shutdownFactsResult,
    h2: H2_PENDING,
  };

  emit('run-result', null, report);
  eventsWriter?.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return smokePass ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
  } else if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
  } else if (parsed.mode === 'full') {
    // H2a 的 full 只报告 pending/not-run：不加载 config/DB，不连接 socket/Bot/RCON。
    process.stdout.write(`${JSON.stringify({
      ...buildRunReport(parsed),
      status: 'H2_FULL_PENDING',
      full: {
        state: 'not-run',
        reason: 'H2a implements smoke only; full 60-minute/cancel/reconnect/reopen remain H2b.',
      },
      connections: 0,
    }, null, 2)}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = await runSmoke(parsed);
  }
}
