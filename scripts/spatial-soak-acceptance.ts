/**
 * 空间记忆 soak 验收（H1-minimal）。
 *
 * 本文件只实现可离线验证的地基：CLI 纯解析、同步有界 JSONL 证据写入、
 * 内存/定时器聚合指标，以及在真实 SharedSpatialSession 上组合常规 30s
 * checkpoint 调度和真实 shutdown 的启动器。H1 不接线 Bot、动作、RCON、
 * 服务器、网络或 LLM；实际运行只报告 H2 未就绪并以非零码退出。
 *
 * 证据文件由调用方给出路径；每条记录同步追加一行，不保留全部历史帧。
 * 单条记录超过 MAX_JSONL_RECORD_BYTES 时在写入前抛出，不静默丢弃。
 */
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
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

/** 保留的测试干道；与 navigation-acceptance 的 LANE 相同。 */
export const LANE = {
  minX: 200,
  maxXExclusive: 219,
  minZ: 216,
  maxZExclusive: 218,
  feetY: 64,
} as const;

export const DEFAULT_DURATION_MS = 3_600_000;
export const MIN_DURATION_MS = 90_000;
export const MAX_DURATION_MS = 3_600_000;
/** 单条 JSONL 记录（含 envelope）的硬上限。超出即失败，不写半条记录。 */
export const MAX_JSONL_RECORD_BYTES = 64 * 1024;
/** 内存快照周期；定时器已 unref，stop 时清除。 */
export const SAMPLE_INTERVAL_MS = 1_000;

const DECIMAL_TOKEN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_TOKEN = /^\d+$/;

export const H2_PENDING = {
  state: 'pending',
  fullPass: false,
  detail:
    'H2 live execution is not implemented: no Bot, RCON, server, sockets, network, LLM, action wiring, cancellation, reconnect, or source provenance. No live game or game-time validation was performed.',
} as const;

const H1_IMPLEMENTED = {
  state: 'implemented',
  scope: 'offline CLI, bounded evidence writer, metrics, and real-session lifecycle foundation only',
} as const;

export const HELP = `spatial-soak-acceptance — H1-minimal spatial soak foundation

Usage:
  node --import tsx scripts/spatial-soak-acceptance.ts --curio=test --mode=smoke|full --start=x,y,z [--duration-ms=N]

Options:
  --curio=test        Required; only the isolated test environment is accepted.
  --mode=smoke|full   Required; explicit run label. Both modes remain H1/H2 pending here.
  --start=x,y,z       Required; explicit feet position inside x[200,219), z[216,218), y=64.
                      Plain decimal values are used as written and never rounded.
  --duration-ms=N     Optional; integer 90000..3600000, default 3600000.
  --help, -h          Print this text and exit without loading config, creating a DB, or opening sockets.

This H1 build has no live soak path. A validated invocation prints H2 pending facts and exits nonzero.
No game frames are captured, and no live game validation is claimed.`;

export type ParsedCli =
  | { ok: true; help: true; value?: never }
  | {
    ok: true;
    help: false;
    curio: 'test';
    mode: 'smoke' | 'full';
    start: { x: number; y: number; z: number };
    startRaw: string;
    durationMs: number;
  }
  | { ok: false; error: string };

const isKnownFlag = (arg: string): boolean =>
  arg.startsWith('--curio=') ||
  arg.startsWith('--start=') ||
  arg.startsWith('--mode=') ||
  arg.startsWith('--duration-ms=');

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

  const startRaw = start[0].slice('--start='.length);
  const parts = startRaw.split(',');
  if (parts.length !== 3 || parts.some((part) => part === '')) return { ok: false, error: '--start must be x,y,z' };
  if (!parts.every((part) => DECIMAL_TOKEN.test(part))) {
    return { ok: false, error: '--start coordinates must be plain decimal numbers (values are never rounded)' };
  }
  const [x, y, z] = parts.map((part) => Number(part));
  if (![x, y, z].every(Number.isFinite)) return { ok: false, error: '--start coordinates must be finite' };
  if (y !== LANE.feetY) return { ok: false, error: `--start feet y must be ${LANE.feetY}` };
  if (x < LANE.minX || x >= LANE.maxXExclusive || z < LANE.minZ || z >= LANE.maxZExclusive) {
    return { ok: false, error: '--start is outside the reserved lane x[200,219), z[216,218)' };
  }

  return { ok: true, help: false, curio: 'test', mode: rawMode, start: { x, y, z }, startRaw, durationMs };
}

export function buildRunReport(parsed: Extract<ParsedCli, { ok: true; help: false }>) {
  return {
    status: 'H2_PENDING' as const,
    fullPass: false,
    mode: parsed.mode,
    start: parsed.start,
    startRaw: parsed.startRaw,
    durationMs: parsed.durationMs,
    h1: H1_IMPLEMENTED,
    h2: H2_PENDING,
  };
}

/**
 * 同步追加 JSONL 的有界写入器。
 *
 * 每条记录立即落盘，内存中只保留序号与字节计数，不保留记录数组。
 * envelope 提供独立的 sequence/captureTime；payload 内的原始时间戳原样保留。
 * 单条超过 maxRecordBytes 时抛 RangeError，并且不会先写出一部分。
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
  timerDriftMs: TimingAggregate;
  checkpointLatencyMs: TimingAggregate;
  checkpointReports: { saved: number; failed: number };
  gameFrames: { state: 'pending'; detail: string };
  leakConclusion: { state: 'not-concluded'; detail: string };
  h2: typeof H2_PENDING;
}

export interface SoakMetrics {
  /** actualMono 与计划触发时刻的差值；负值按 0 计，表示非负事件循环延迟。 */
  recordTimerTick(expectedMono: number, actualMono: number): void;
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
  const timerDrift = emptyTiming();
  const checkpointLatency = emptyTiming();
  let saved = 0;
  let failed = 0;

  return {
    recordTimerTick(expectedMono, actualMono) {
      addTiming(timerDrift, actualMono - expectedMono);
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
        timerDriftMs: timingView(timerDrift),
        checkpointLatencyMs: timingView(checkpointLatency),
        checkpointReports: { saved, failed },
        gameFrames: {
          state: 'pending',
          detail: 'No game-frame capture is wired in H1; frame metrics are not measured.',
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

export interface SoakFoundationOptions {
  service: SharedSpatialSession;
  evidencePath: string;
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
  stop(): Promise<SoakFoundationStop>;
}

const shutdownFacts = (result: ShutdownResult): Record<string, unknown> => ({
  checkpoint: result.checkpoint,
  finalCheckpointSaved: result.checkpoint !== null && result.error === null,
  error: result.error === null ? null : errorFacts(result.error),
  cancelError: result.cancelError === null ? null : errorFacts(result.cancelError),
  close: result.close,
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
  let evidenceError: unknown = null;

  const write = (payload: unknown): void => {
    if (evidenceError !== null) return;
    try {
      writer.append(payload);
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

  let expectedTickMono = performance.now() + SAMPLE_INTERVAL_MS;
  const sampleTimer = setInterval(() => {
    const actualMono = performance.now();
    metrics.recordTimerTick(expectedTickMono, actualMono);
    expectedTickMono += SAMPLE_INTERVAL_MS;
    write({ kind: 'memory', elapsedMs: metrics.elapsedMs(), ...metrics.recordMemory() });
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref();

  let lastCheckpointLatencyMs = 0;
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
  });

  let stopPromise: Promise<SoakFoundationStop> | null = null;

  const stop = (): Promise<SoakFoundationStop> => {
    if (stopPromise !== null) return stopPromise;
    clearInterval(sampleTimer);
    stopScheduler();

    stopPromise = (async () => {
      try {
        metrics.recordMemory();
      } catch (error) {
        evidenceError = evidenceError ?? error;
      }
      const finalMetrics = metrics.snapshot();
      write({ kind: 'metrics-final', metrics: finalMetrics });

      // 即使采样/写证据失败，也必须走真实 shutdown；其结果不被清理错误覆盖。
      const shutdown = await options.service.shutdown();
      write({ kind: 'shutdown', shutdown: shutdownFacts(shutdown), h2: H2_PENDING });
      try {
        writer.close();
      } catch (error) {
        evidenceError = evidenceError ?? error;
      }
      return { shutdown, evidenceError, finalMetrics, h2: H2_PENDING };
    })();

    return stopPromise;
  };

  return { evidencePath: options.evidencePath, stop };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
  } else if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(buildRunReport(parsed), null, 2)}\n`);
    process.exitCode = 2;
  }
}
