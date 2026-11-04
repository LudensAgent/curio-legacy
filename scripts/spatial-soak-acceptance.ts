/**
 * 空间记忆 soak 验收（H1 foundation + H2a smoke + H2b 场景结构）。
 *
 * H1 地基：CLI 纯解析、同步有界 JSONL 证据写入、内存/定时器聚合指标，以及在
 * 真实 SharedSpatialSession 上组合常规 30s checkpoint 调度和真实 shutdown。
 *
 * H2a smoke：夹具端点 A/B、RCON 只读 preflight 与一次自有测试 Bot 的 setup tp、
 * 真实 Vision 初始准入、真实 walk_to 往返与每段成功的 spatial_query、真实调度保存
 * 确认。每段在真实身体 settle 后从 adapter.state().pos 读取实测起点，不复用上一段
 * 的标称终点。
 *
 * H2b 场景：显式取消（真实移动后取消并核对后续物理帧/按键释放）、真实断线重连/
 * 新会话、关闭/重开后的 stale 分类（使用原始 observedAt），以及 manual residency
 * 整合场景（独立模块，仅在 manual 分支合入后启用）。full 模式必须实际活动满
 * 3,600,000ms 且所有必需场景通过；manual API 未合入时在连接前显式失败，不会空等。
 *
 * 证据是直接、可读的 JSONL（每行一条记录），大记录不编码、不分块、不截断：
 * 单条超过 64KiB 时显式失败并使本次运行失败。最终 run-result 写入失败同样返回
 * 非零退出码。
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
import type { WorkingSetStats } from 'curio-minecraft-3d-memory/storage/sqlite';
import {
  CANCEL_MOVEMENT_THRESHOLD,
  LANE,
  classifyAdapterEnd,
  classifyCancellationResult,
  classifyPostCancelFrames,
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
import {
  manualScenarioSupported,
  runManualScenario,
} from './spatial-soak-manual-scenario.ts';

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
/** 内存快照周期；定时器已 unref，stop 时清除。 */
export const SAMPLE_INTERVAL_MS = 1_000;
/** 连接物理帧/监听器诊断的落盘周期；不逐帧保存。 */
export const CONNECTION_SNAPSHOT_INTERVAL_MS = 5_000;
export const SMOKE_LEG_BUDGET_MS = 45_000;
/**
 * soak 的 near 完成半径。实测身体停止点会在候选格周围抖动，执行器默认 0.12 的
 * bodyArrival 容差与 near 目标检查叠加后，正常停止也可能略超 0.12。这里把请求的
 * near radius 与验收用的水平容差设为同一个值：既容忍真实停止抖动，又不把 A/B
 * 两格目标混在一起，且没有投影或改写目标。
 */
export const SOAK_ARRIVAL_RADIUS = 0.25;

/** 所有 soak walk_to 请求共用：固定目标 + 同一 near 半径，目标永不投影或改写。 */
export const soakWalkRequest = (target: FixtureEndpoint, deadlineMs: number) => ({
  to: { ...target },
  arrival: { kind: 'near' as const, radius: SOAK_ARRIVAL_RADIUS },
  deadlineMs,
});

export type FixtureEndpointName = keyof typeof FIXTURE_ENDPOINTS;

/** 每段 leg 的固定夹具起点与固定目标；两者都不投影、不取整、不改写。 */
export const legFixturePoints = (from: FixtureEndpointName, to: FixtureEndpointName) => ({
  setup: FIXTURE_ENDPOINTS[from],
  target: FIXTURE_ENDPOINTS[to],
});

/**
 * 每段 walk_to 前的固定 setup 序列：先把夹具 tp 到本段标称起点并结算，再由调用方
 * 从真实 `adapter.state().pos` 读取实测起点。setup 只布置夹具，不是移动证据；任何
 * 一步失败都不会发出 walk_to。
 */
export const prepareLegStart = async (
  index: number,
  setupRequested: FixtureEndpoint,
  setup: (position: FixtureEndpoint, label: string) => Promise<FixtureEndpoint>,
  measure: (label: string) => Promise<FixtureEndpoint>,
) => {
  const setupSettled = await setup(setupRequested, `leg-${index}-setup`);
  const measuredStart = await measure(`leg ${index}`);
  return { index, setupRequested, setupSettled, measuredStart };
};
export const SMOKE_MIN_SUCCESSFUL_LEGS = 2;
export const SMOKE_MIN_CHECKPOINT_SAVES = 2;
/** smoke 完成等待上限；避免 full 在 smoke 未满足时空等一小时。 */
export const SMOKE_COMPLETION_WAIT_MS = 90_000;
/** 当前任务保留给既有分类器的有界窗口。超出显式失败/取消，不静默截断。 */
export const MAX_SAMPLES_PER_TASK = 4_096;
export const MAX_MOVES_PER_TASK = 16;
export const MAX_STARTS_PER_TASK = 16;
/** full 模式必须执行的 H2b 场景；manual 仅在 manual-residency 分支合入后可用。 */
export const H2B_REQUIRED_SCENARIOS = [
  'explicit-cancel',
  'disconnect-reconnect',
  'close-reopen',
  'manual-residency',
] as const;
export type H2bScenarioId = typeof H2B_REQUIRED_SCENARIOS[number];
/** 主会话的体素加载模式。full 必须真实使用 manual；smoke 默认 eager。 */
export const VOXEL_LOADING_CHOICES = ['eager', 'manual'] as const;
export type VoxelLoadingChoice = typeof VOXEL_LOADING_CHOICES[number];
/** 主会话工作集快照与诊断事件的硬上限；长跑中只保留有界序列。 */
export const MAX_WORKING_SET_SNAPSHOTS = 32;
export const MAX_WORKING_SET_DIAGNOSTIC_EVENTS = 256;
export const MAX_WORKING_SET_DIAGNOSTIC_MESSAGE_CHARS = 512;

const DECIMAL_TOKEN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_TOKEN = /^\d+$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const EXPECTED_CURIO_PACKAGE = 'curio-minecraft-3d-memory';

export const H2_PENDING = {
  state: 'pending',
  fullPass: false,
  detail:
    'H2a smoke and H2b scenario structure, including main-session manual voxel loading when the host API is present, are implemented. Offline tests do not perform a real server run or long-run acceptance; only an actual passing run may claim FULL_PASS.',
} as const;

export const H2_PASSED = {
  state: 'passed',
  fullPass: true,
  detail: 'The full acceptance run completed and passed every required criterion in this run.',
} as const;

export type H2Status = typeof H2_PENDING | typeof H2_PASSED;

/** 最终报告里的 H2 状态必须来自实际结果；smoke 永远不宣称 full pass。 */
export const h2ForResult = (mode: 'smoke' | 'full', fullPass: boolean): H2Status =>
  mode === 'full' && fullPass ? H2_PASSED : H2_PENDING;

const H1_IMPLEMENTED = {
  state: 'implemented',
  scope: 'offline CLI, bounded evidence writer, metrics, and real-session lifecycle foundation',
} as const;

export const HELP = `spatial-soak-acceptance — H1 foundation + H2a smoke + H2b scenario structure

Usage:
  node --import tsx scripts/spatial-soak-acceptance.ts --curio=test --mode=smoke --start=207.5,64,216.5 [--duration-ms=N]

Options:
  --curio=test        Required; only the isolated test environment is accepted.
  --mode=smoke|full   Required. smoke runs the bounded real smoke path and exits once
                      its criteria are met; full runs at least 3,600,000ms of active
                      soak and requires every H2b scenario, including manual residency.
  --start=x,y,z       Required; must be exactly fixture endpoint A=(207.5,64,216.5)
                      or B=(209.5,64,216.5). Values are never rounded.
  --duration-ms=N     Optional; integer 90000..3600000, default 3600000.
                      --mode=full requires exactly 3600000.
  --voxel-loading=eager|manual
                      Optional. smoke defaults to eager; full defaults to manual and
                      rejects eager. The main session (Vision/Arbiter/walk_to) is opened
                      with this value, and the run fails if the opened session reports a
                      different actual voxelLoading. full also requires real main-session
                      working-set evidence, not only the separate manual scenario.
  --help, -h          Print this text and exit without loading config, creating a DB, or opening sockets.

Every leg first performs the fixture setup tp to its fixed nominal start, then reads
the actual adapter.state().pos as its measured start; fixed A/B targets and measured
starts are recorded separately. Any scheduled checkpoint failure,
unclean shutdown, or evidence record over 64KiB fails the run. Manual residency is
never reported as passed unless the real SharedSpatialSession manual API is present.`;

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
    voxelLoading: VoxelLoadingChoice;
    /** 值来自显式 flag 还是按模式选择的默认值，报告必须如实区分。 */
    voxelLoadingSource: 'flag' | 'default';
  }
  | { ok: false; error: string };

const isKnownFlag = (arg: string): boolean =>
  arg.startsWith('--curio=') ||
  arg.startsWith('--start=') ||
  arg.startsWith('--mode=') ||
  arg.startsWith('--duration-ms=') ||
  arg.startsWith('--voxel-loading=');

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
  const voxelLoadingFlags = argv.filter((arg) => arg.startsWith('--voxel-loading='));

  if (curio.length !== 1) return { ok: false, error: 'exactly one --curio=test is required' };
  if (curio[0] !== '--curio=test') return { ok: false, error: `only --curio=test is accepted, got ${curio[0]}` };
  if (start.length !== 1) return { ok: false, error: 'exactly one --start=x,y,z is required' };
  if (mode.length !== 1) return { ok: false, error: 'exactly one --mode=smoke|full is required' };
  if (duration.length > 1) return { ok: false, error: 'at most one --duration-ms=N is accepted' };
  if (voxelLoadingFlags.length > 1) return { ok: false, error: 'at most one --voxel-loading=eager|manual is accepted' };

  const rawMode = mode[0].slice('--mode='.length);
  if (rawMode !== 'smoke' && rawMode !== 'full') return { ok: false, error: `--mode must be smoke or full, got ${rawMode}` };

  // smoke 默认 eager；full 默认 manual。显式 eager 的 full 直接拒绝，不能把
  // eager 主会话报告成 manual 长跑。
  let voxelLoading: VoxelLoadingChoice;
  let voxelLoadingSource: 'flag' | 'default';
  if (voxelLoadingFlags.length === 1) {
    const rawLoading = voxelLoadingFlags[0].slice('--voxel-loading='.length);
    const matched = VOXEL_LOADING_CHOICES.find((choice) => choice === rawLoading);
    if (matched === undefined) {
      return { ok: false, error: `--voxel-loading must be eager or manual, got ${rawLoading}` };
    }
    voxelLoading = matched;
    voxelLoadingSource = 'flag';
  } else {
    voxelLoading = rawMode === 'full' ? 'manual' : 'eager';
    voxelLoadingSource = 'default';
  }
  if (rawMode === 'full' && voxelLoading !== 'manual') {
    return { ok: false, error: '--mode=full requires --voxel-loading=manual; eager full runs are rejected' };
  }

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
  // full 必须是完整一小时，不能把 90s 放大成一次一小时运行。
  if (rawMode === 'full' && durationMs !== DEFAULT_DURATION_MS) {
    return {
      ok: false,
      error: `--mode=full requires --duration-ms=${DEFAULT_DURATION_MS}; shorter runs are smoke only`,
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

  return {
    ok: true,
    help: false,
    curio: 'test',
    mode: rawMode,
    start: parsedStart,
    startRaw,
    durationMs,
    voxelLoading,
    voxelLoadingSource,
  };
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
    voxelLoading: {
      requested: parsed.voxelLoading,
      source: parsed.voxelLoadingSource,
      actual: null as string | null,
    },
    fixture: FIXTURE_FACTS,
    h1: H1_IMPLEMENTED,
    h2: H2_PENDING,
    requiredScenarios: H2B_REQUIRED_SCENARIOS,
  };
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sha256File = (file: string): string => sha256Hex(readFileSync(file));
const sha512Base64 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('base64');

export interface CurioPackageMeta {
  name: string;
  version: string;
  dependencySpec: string;
  tgz: { path: string; bytes: number; sha256: string; integrity: string };
  lock: { version: string; resolved: string; integrity: string };
  provenance: {
    path: string;
    sha256: string;
    sourceHEAD: string;
    artifactSHA256: string;
    npmIntegrity: string;
    tracked: boolean;
  };
  installedPackageJson: string;
  checks: Record<string, 'verified'>;
}

/**
 * 真实的 Curio 来源包校验：计算 tgz 的 SHA-256 与 npm sha512 integrity，并与
 * manifest file: 规格、package-lock 条目、已安装包身份和 provenance 声明逐项
 * 对照。不是复制声明值：每个哈希都从实际字节重新计算，任一不一致都抛错。
 */
export function collectPackageMeta(base: string): CurioPackageMeta {
  const manifestPath = path.join(base, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  const spec = manifest.dependencies?.[EXPECTED_CURIO_PACKAGE];
  if (typeof spec !== 'string' || !spec.startsWith('file:')) {
    throw new Error(`package.json dependency for ${EXPECTED_CURIO_PACKAGE} must be a file: spec`);
  }
  const tgzRel = spec.slice('file:'.length);
  if (tgzRel.length === 0) throw new Error(`file: dependency for ${EXPECTED_CURIO_PACKAGE} has no path`);
  const tgzPath = path.resolve(base, tgzRel);
  if (!existsSync(tgzPath)) throw new Error(`vendored tarball is missing: ${tgzPath}`);
  const tgzBytes = readFileSync(tgzPath);
  const tgzSha256 = sha256Hex(tgzBytes);
  const tgzIntegrity = `sha512-${sha512Base64(tgzBytes)}`;

  const installedLocal = path.join(base, 'node_modules', EXPECTED_CURIO_PACKAGE, 'package.json');
  const installedPackageJson = existsSync(installedLocal)
    ? installedLocal
    : (() => {
      const entryUrl = import.meta.resolve(EXPECTED_CURIO_PACKAGE);
      if (!entryUrl.startsWith('file:')) throw new Error(`curio package entry is not a file URL: ${entryUrl}`);
      return path.resolve(path.dirname(fileURLToPath(entryUrl)), '..', 'package.json');
    })();
  const installed = JSON.parse(readFileSync(installedPackageJson, 'utf8')) as { name?: string; version?: string };
  if (installed.name !== EXPECTED_CURIO_PACKAGE) {
    throw new Error(`installed package name ${String(installed.name)} is not ${EXPECTED_CURIO_PACKAGE}`);
  }
  if (typeof installed.version !== 'string' || !/^\d+\.\d+\.\d+/.test(installed.version)) {
    throw new Error(`installed ${EXPECTED_CURIO_PACKAGE} has no usable version`);
  }

  const lock = JSON.parse(readFileSync(path.join(base, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { name?: string; version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }>;
  };
  const rootLockDep = lock.packages?.['']?.dependencies?.[EXPECTED_CURIO_PACKAGE];
  if (rootLockDep !== spec) throw new Error(`lock root dependency ${String(rootLockDep)} differs from manifest ${spec}`);
  const lockEntry = lock.packages?.[`node_modules/${EXPECTED_CURIO_PACKAGE}`];
  if (lockEntry === undefined) throw new Error(`package-lock lacks node_modules/${EXPECTED_CURIO_PACKAGE}`);
  if (lockEntry.name !== undefined && lockEntry.name !== EXPECTED_CURIO_PACKAGE) {
    throw new Error(`lock package name ${lockEntry.name} is not ${EXPECTED_CURIO_PACKAGE}`);
  }
  if (lockEntry.version !== installed.version) {
    throw new Error(`lock version ${String(lockEntry.version)} differs from installed ${installed.version}`);
  }
  if (lockEntry.resolved !== spec) throw new Error(`lock resolved ${String(lockEntry.resolved)} differs from manifest ${spec}`);
  if (typeof lockEntry.integrity !== 'string' || lockEntry.integrity.length === 0) {
    throw new Error(`package-lock lacks integrity for ${EXPECTED_CURIO_PACKAGE}`);
  }
  if (lockEntry.integrity !== tgzIntegrity) {
    throw new Error('actual tarball sha512 integrity differs from package-lock integrity');
  }

  const provenanceRel = `vendor/${EXPECTED_CURIO_PACKAGE}-${installed.version}.provenance.json`;
  const provenancePath = path.join(base, provenanceRel);
  if (!existsSync(provenancePath)) throw new Error(`curio source provenance is missing: ${provenanceRel}`);
  const tracked = (() => {
    if (!existsSync(path.join(base, '.git'))) return false;
    execFileSync('git', ['-c', `safe.directory=${base}`, 'ls-files', '--error-unmatch', provenanceRel], {
      cwd: base,
      stdio: 'ignore',
    });
    return true;
  })();
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as {
    package?: { name?: string; version?: string };
    sourceHEAD?: string;
    artifactSHA256?: string;
    npmIntegrity?: string;
    sourceBinding?: { clean?: boolean; head?: string };
  };
  if (provenance.package?.name !== EXPECTED_CURIO_PACKAGE) {
    throw new Error(`provenance package name ${String(provenance.package?.name)} is not ${EXPECTED_CURIO_PACKAGE}`);
  }
  if (provenance.package?.version !== installed.version) {
    throw new Error(`provenance version ${String(provenance.package?.version)} differs from installed ${installed.version}`);
  }
  if (provenance.artifactSHA256 !== tgzSha256) {
    throw new Error('actual tarball SHA-256 differs from provenance artifactSHA256');
  }
  if (provenance.npmIntegrity !== lockEntry.integrity) {
    throw new Error('provenance npmIntegrity differs from package-lock integrity');
  }
  if (provenance.npmIntegrity !== tgzIntegrity) {
    throw new Error('actual tarball sha512 integrity differs from provenance npmIntegrity');
  }
  if (typeof provenance.sourceHEAD !== 'string' || !HEX_40.test(provenance.sourceHEAD)) {
    throw new Error('provenance sourceHEAD is not a full 40-char hash');
  }
  if (provenance.sourceBinding?.clean !== true) throw new Error('provenance sourceBinding.clean must be true');
  if (provenance.sourceBinding?.head !== provenance.sourceHEAD) {
    throw new Error('provenance sourceBinding.head differs from sourceHEAD');
  }
  if (!HEX_64.test(tgzSha256)) throw new Error('computed tarball SHA-256 is malformed');

  return {
    name: installed.name,
    version: installed.version,
    dependencySpec: spec,
    tgz: { path: path.relative(base, tgzPath).replaceAll('\\', '/'), bytes: tgzBytes.length, sha256: tgzSha256, integrity: tgzIntegrity },
    lock: { version: lockEntry.version, resolved: lockEntry.resolved, integrity: lockEntry.integrity },
    provenance: {
      path: provenanceRel,
      sha256: sha256File(provenancePath),
      sourceHEAD: provenance.sourceHEAD,
      artifactSHA256: provenance.artifactSHA256,
      npmIntegrity: provenance.npmIntegrity,
      tracked,
    },
    installedPackageJson: path.relative(base, installedPackageJson).replaceAll('\\', '/'),
    checks: {
      manifestSpec: 'verified',
      lockEntry: 'verified',
      installedIdentity: 'verified',
      tgzSha256: 'verified',
      tgzSha512: 'verified',
      provenance: 'verified',
    },
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
  const pkg = collectPackageMeta(repoRoot);

  return {
    status: 'OK',
    head,
    branch,
    clean: status === '',
    script: {
      path: path.relative(repoRoot, scriptPath).replaceAll('\\', '/'),
      sha256: sha256File(scriptPath),
    },
    package: pkg,
  };
}

/**
 * 主会话可选的 manual 工作集能力。旧宿主没有这些成员时保持 undefined；
 * 不构造假会话、不读取私有字段。manual-residency 分支合入后实例会真实提供。
 */
export type SpatialSoakPendingInfo = {
  observations: number;
  bytes?: number;
  countLimit?: number;
  byteLimit?: number;
  sections?: readonly unknown[];
  observedAtMin?: number | null;
  observedAtMax?: number | null;
  loading?: boolean;
};

type SpatialSoakGapFacts = {
  kind?: string;
  message?: string;
  keys?: readonly unknown[];
  count?: number;
  observedAtMin?: number | null;
  observedAtMax?: number | null;
};

type SpatialSoakDrainResult = {
  cancelled: boolean;
  reason: 'aborted' | 'deadline' | 'closing' | null;
  pending: SpatialSoakPendingInfo;
  gap?: SpatialSoakGapFacts | null;
  checkpointError: unknown;
};

/** 宿主诊断回调的结构边界；只读取有界字段，不保留历史键。 */
export type WorkingSetDiagnosticFacts = {
  kind: string;
  reason?: string;
  message?: string;
  keys?: readonly unknown[];
  count?: number;
  observedAtMin?: number | null;
  observedAtMax?: number | null;
};

type SpatialSoakMainCapabilities = {
  workingSetStats?: () => WorkingSetStats;
  pendingObservations?: () => SpatialSoakPendingInfo;
  drainObservations?: (options?: { deadline?: number }) => Promise<SpatialSoakDrainResult>;
};

/** 真实 SharedSpatialSession 加上可选能力；没有类型断言或包装对象。 */
export type SpatialSoakMainSession = SharedSpatialSession & SpatialSoakMainCapabilities;

/**
 * 主会话打开选项。`voxelLoading` 与诊断回调通过非字面量对象传入，使同一份代码
 * 在当前宿主声明（尚未包含 manual 选项）和合入后的宿主声明上都能通过类型检查；
 * 选项是否真正生效仍由打开后的 `session.voxelLoading` 核对。
 */
export const buildSpatialOpenOptions = (
  worldId: string,
  databasePath: string,
  voxelLoading: VoxelLoadingChoice,
  onWorkingSetDiagnostic?: (diagnostic: WorkingSetDiagnosticFacts) => void,
) => ({
  worldId,
  databasePath,
  timeoutMs: 5000,
  voxelLoading,
  ...(onWorkingSetDiagnostic === undefined ? {} : { onWorkingSetDiagnostic }),
});

/** 有界工作集快照：只保留计数/字节估算，不保留 Section 键或历史消息。 */
export type WorkingSetSnapshotFacts = {
  label: string;
  at: number;
  activeElapsedMs: number | null;
  voxelLoading: string | null;
  stats: {
    residentSections: number;
    /** 库内驻留字节估算，不是进程 RSS。 */
    residentBytesEstimate: number;
    maxResidentSections: number;
    maxResidentBytes: number;
    lruTracked: number;
    pinnedLeases: number;
    pinnedSections: number;
  } | null;
  pending: {
    observations: number;
    bytes: number;
    countLimit: number;
    byteLimit: number;
    sectionCount: number;
    observedAtMin: number | null;
    observedAtMax: number | null;
    loading: boolean;
  } | null;
  unavailable: string | null;
};

export function buildWorkingSetSnapshot(input: {
  label: string;
  at: number;
  activeElapsedMs: number | null;
  voxelLoading: string | null;
  stats: WorkingSetStats | null;
  pending: SpatialSoakPendingInfo | null;
  unavailable: string | null;
}): WorkingSetSnapshotFacts {
  return {
    label: input.label,
    at: input.at,
    activeElapsedMs: input.activeElapsedMs,
    voxelLoading: input.voxelLoading,
    stats: input.stats === null ? null : {
      residentSections: input.stats.residentSections,
      residentBytesEstimate: input.stats.residentBytes,
      maxResidentSections: input.stats.maxResidentSections,
      maxResidentBytes: input.stats.maxResidentBytes,
      lruTracked: input.stats.lruTracked,
      pinnedLeases: input.stats.pinnedLeases,
      pinnedSections: input.stats.pinnedSections,
    },
    pending: input.pending === null ? null : {
      observations: input.pending.observations,
      bytes: input.pending.bytes ?? 0,
      countLimit: input.pending.countLimit ?? 0,
      byteLimit: input.pending.byteLimit ?? 0,
      sectionCount: input.pending.sections?.length ?? 0,
      observedAtMin: input.pending.observedAtMin ?? null,
      observedAtMax: input.pending.observedAtMax ?? null,
      loading: input.pending.loading ?? false,
    },
    unavailable: input.unavailable,
  };
}

/** manual 主会话的实际工作集变化判据；只在 stats 快照之间比较，不使用 RSS。 */
export const workingSetStatsSignature = (stats: WorkingSetStats): string =>
  [
    stats.residentSections,
    stats.residentBytes,
    stats.lruTracked,
    stats.pinnedLeases,
    stats.pinnedSections,
  ].join(':');

export type MainManualEvidence = { ok: boolean; problems: string[] };

/**
 * full 的 manual 主会话判据：请求与打开后的实际模式必须一致；full 必须是 manual，
 * 且主会话自己的工作集 stats 至少出现两次并发生变化。pending 在关停前必须为 0；
 * 任何残留都如实失败，而不是只让独立 manual 场景通过。
 */
export function classifyMainManualEvidence(input: {
  mode: 'smoke' | 'full';
  requested: VoxelLoadingChoice;
  actual: string | null;
  statsSnapshotCount: number;
  statsChanged: boolean;
  pendingBeforeShutdown: number | null;
}): MainManualEvidence {
  const problems: string[] = [];
  if (input.actual !== input.requested) {
    problems.push(`requested voxelLoading=${input.requested} but opened session reports ${String(input.actual)}`);
  }
  if (input.mode === 'full') {
    if (input.requested !== 'manual') problems.push('full mode must run the main session with voxelLoading=manual');
    if (input.actual !== 'manual') problems.push('main session did not actually open with manual voxel loading');
    if (input.statsSnapshotCount < 2) {
      problems.push('main session produced fewer than two real workingSetStats snapshots');
    }
    if (!input.statsChanged) {
      problems.push('main-session workingSetStats never changed; no manual residency evidence in the main path');
    }
    if (input.pendingBeforeShutdown === null) {
      problems.push('main session exposed no pendingObservations snapshot before shutdown');
    }
  }
  if (input.pendingBeforeShutdown !== null && input.pendingBeforeShutdown > 0) {
    problems.push(`${input.pendingBeforeShutdown} observation(s) were still pending before shutdown`);
  }
  return { ok: problems.length === 0, problems };
}

export interface EvidenceEmitter {
  readonly failure: unknown;
  emit(kind: string, taskId: string | null, payload: unknown): { eventId: string; bytes: number } | null;
}

/**
 * 直接写入可读 JSONL 的事件发射器：一行一个事件，不做编码/分块/截断。
 * 单条记录超过 writer 的 64KiB 上限时保留首个错误并返回 null；调用方据此失败。
 */
export function createEvidenceEmitter(writer: BoundedJsonlWriter, runId: string): EvidenceEmitter {
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
      writer.append(body);
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

export interface ShutdownVerdict {
  ok: boolean;
  problems: string[];
  facts: Record<string, unknown> | null;
}

/**
 * 失败判据：真实 ShutdownResult 的每个失败面都要失败，而不是只看 stop() 是否
 * 抛错。最终 checkpoint 缺失、checkpoint 错误、cancelError、close 抛错、close
 * 未完成或 close.error 非空都列为失败；dirty/unconfirmedRequest 作为事实保留。
 */
export function classifyShutdownResult(result: ShutdownResult | null): ShutdownVerdict {
  if (result === null) {
    return { ok: false, problems: ['shared spatial shutdown returned no result'], facts: null };
  }
  const problems: string[] = [];
  if (result.checkpoint === null) problems.push('missing confirmed final checkpoint');
  if (result.error !== null) problems.push(`final checkpoint failed: ${errorText(result.error)}`);
  if (result.cancelError !== null) problems.push(`cancel error: ${errorText(result.cancelError)}`);
  if (result.closeError !== null) problems.push(`close threw: ${errorText(result.closeError)}`);
  if (result.close === null) {
    problems.push('missing close result');
  } else {
    if (result.close.completed !== true) problems.push('close did not complete');
    if (result.close.error !== null) problems.push(`close reported an error: ${errorText(result.close.error)}`);
  }
  return { ok: problems.length === 0, problems, facts: shutdownFacts(result) };
}

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

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isVec = (value: unknown): value is { x: number; y: number; z: number } =>
  isRecordValue(value) && isNumberValue(value.x) && isNumberValue(value.y) && isNumberValue(value.z);
const isNumberValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
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

interface ScenarioResult {
  id: string;
  state: 'passed' | 'failed' | 'not-integrated' | 'not-run';
  ok: boolean;
  problems: string[];
  facts: Record<string, unknown>;
}

/**
 * 相关已接受样本与确认 Nav.trace 的关联。
 *
 * accepted 样本由 onSample 阶段确认：样本 executionId 等于该路由的 delegationId、
 * 返回的 lastPosition 与样本位置深相等、sequence 为数值（见 executorWrappedOnSample
 * 与 navigation-acceptance 的既有模式）。ExecutableMove 的 executionId 是
 * `${delegationId}-step-N`，因此这里不再错误地要求两者逐字相等。
 *
 * 按真实派发顺序把 `taskMoves[i]` 对应到 `trace[i]`：确认 trace 点与派发必须
 * 一一对应，且每个 trace 点必须使用一条未被占用的 accepted 同任务/同作用域样本，
 * 位置与 observedAt 精确对应，时间落在该派发的 [receivedAt, deadlineMs] 内。
 * move.request.to 是名义请求目标，不拿它替代真实观测位置。
 * 不要求每个 move.result 都有 sample，也不拿上一移动的 result 充当下一移动的 from。
 *
 * 方向必须从 trace/派发出发：派发前的稳定起点样本、派发后的终点样本或派发间隙
 * 样本都是正常观测，只记录为 `acceptedSamplesOutsideDispatchWindows`，不能因为
 * 它们不落在任何派发窗口就把整段判失败。矛盾的作用域或 executionId 仍然失败。
 */
export function classifyLegTrace(
  nav: Record<string, unknown> | null,
  taskId: string,
  samples: readonly CapturedRouteSample[],
  moves: readonly CapturedMove[],
): {
  ok: boolean;
  problems: string[];
  facts: {
    tracePoints: number;
    dispatches: number;
    compared: number;
    acceptedSamples: number;
    acceptedSamplesOutsideDispatchWindows: number;
    acceptedSampleSequencesOutsideDispatch: number[];
    outsideDispatchSequencesTruncated: boolean;
  };
} {
  const problems: string[] = [];
  const trace = nav !== null && Array.isArray(nav.trace)
    ? nav.trace.filter((entry): entry is { pos: FixtureEndpoint; ts: number } =>
      isRecordValue(entry) && isVec(entry.pos) && isNumberValue(entry.ts))
    : [];
  if (nav === null || nav.confirmed !== true) problems.push('missing confirmed nav trace');
  if (trace.length === 0) problems.push('confirmed nav trace has no points');

  const taskMoves = moves.filter((move) => move.taskId === taskId);
  const acceptedSamples = samples.filter((sample) =>
    sample.taskId === taskId && sample.accepted && Number.isInteger(sample.sample.sequence));
  if (taskMoves.length === 0 && trace.length > 0) problems.push('confirmed trace exists but no ExecutableMove dispatch was recorded');
  // 每个确认 trace 点必须恰好对应一次真实派发；多出的派发没有 trace/样本证据，
  // 不能因为 trace 较短就被静默放过。
  if (trace.length !== taskMoves.length) {
    problems.push(
      `confirmed trace has ${trace.length} points but ${taskMoves.length} ExecutableMove dispatches were recorded; exactly one dispatch per trace point is required`,
    );
  }

  // 一个 walk 任务对应一个路由 delegation；move 的 executionId 必须由它派生。
  const routeDelegations = new Set(acceptedSamples.map((sample) => sample.delegationId));
  if (routeDelegations.size > 1) {
    problems.push(`accepted samples span ${routeDelegations.size} route delegations within ${taskId}`);
  }
  const routeDelegation = routeDelegations.size === 1 ? [...routeDelegations][0]! : null;
  if (routeDelegation !== null) {
    for (const [index, move] of taskMoves.entries()) {
      if (!move.request.executionId.startsWith(`${routeDelegation}-step-`)) {
        problems.push(`move ${index}.executionId is not derived from accepted route delegation ${routeDelegation}`);
      }
    }
  }

  const compared = Math.min(trace.length, taskMoves.length);
  // 样本按 sequence 一对一消费：重复的 pos/ts trace 点必须由不同样本分别证明，
  // 不能拿同一条 accepted 样本重复配对。
  const usedSequences = new Set<number>();
  for (let index = 0; index < compared; index += 1) {
    const point = trace[index]!;
    const move = taskMoves[index]!;
    const matched = acceptedSamples.find((sample) =>
      !usedSequences.has(sample.sample.sequence)
      && (routeDelegation === null || sample.delegationId === routeDelegation)
      && sample.sample.executionId === sample.delegationId
      && isDeepStrictEqual(sample.sample.position, point.pos)
      && sample.sample.observedAt === point.ts
      && sample.sample.worldId === move.request.worldId
      && sample.sample.dim === move.request.dim
      && sample.sample.sessionId === move.request.sessionId
      && sample.sample.observedAt >= move.receivedAt
      && sample.sample.observedAt <= move.request.deadlineMs);
    if (matched === undefined) {
      problems.push(`trace point ${index} has no unused accepted same-delegation sample matching pos/ts/scope/time-range`);
    } else {
      usedSequences.add(matched.sample.sequence);
    }
  }

  // 样本自身必须与 accepted 的条件一致；executionId 与 route delegation 矛盾仍失败。
  const contradictoryExecution = acceptedSamples.find(
    (sample) => sample.sample.executionId !== sample.delegationId,
  );
  if (contradictoryExecution !== undefined) {
    problems.push(
      `accepted sample sequence ${contradictoryExecution.sample.sequence} executionId ${contradictoryExecution.sample.executionId} contradicts route delegation ${contradictoryExecution.delegationId}`,
    );
  }

  // 样本作用域必须与至少一次真实派发一致；矛盾仍失败，但时间窗口外的
  // 稳定起点/终点样本不再因此被判失败。
  const dispatchScopeOf = (sample: CapturedRouteSample): boolean => taskMoves.some((move) =>
    sample.sample.worldId === move.request.worldId
    && sample.sample.dim === move.request.dim
    && sample.sample.sessionId === move.request.sessionId);
  const contradictoryScope = taskMoves.length === 0
    ? undefined
    : acceptedSamples.find((sample) => !dispatchScopeOf(sample));
  if (contradictoryScope !== undefined) {
    problems.push(
      `accepted sample sequence ${contradictoryScope.sample.sequence} scope contradicts the recorded dispatch scope`,
    );
  }

  // 确认的 trace 点必须匹配派发；额外的 accepted 样本（首帧稳定、末帧或派发间隙）
  // 是正常事实，只记录数量/有界序号，不作为失败。
  const outsideDispatch = acceptedSamples.filter((sample) => !taskMoves.some((move) =>
    sample.delegationId === sample.sample.executionId
    && sample.sample.observedAt >= move.receivedAt
    && sample.sample.observedAt <= move.request.deadlineMs
    && sample.sample.worldId === move.request.worldId
    && sample.sample.dim === move.request.dim
    && sample.sample.sessionId === move.request.sessionId));
  const outsideSequences = outsideDispatch.map((sample) => sample.sample.sequence);

  return {
    ok: problems.length === 0,
    problems,
    facts: {
      tracePoints: trace.length,
      dispatches: taskMoves.length,
      compared,
      acceptedSamples: acceptedSamples.length,
      acceptedSamplesOutsideDispatchWindows: outsideDispatch.length,
      acceptedSampleSequencesOutsideDispatch: outsideSequences.slice(0, 32),
      outsideDispatchSequencesTruncated: outsideSequences.length > 32,
    },
  };
}

/**
 * 时长诚实分类：full 只有在活动时长真正达到请求时长时才有资格 full pass；
 * smoke 无论跑多久都只是 smoke/scenario 结果，不转成 full pass。
 */
export function classifyDuration(
  mode: 'smoke' | 'full',
  durationMs: number,
  activeElapsedMs: number | null,
): { fullPassEligible: boolean; durationSatisfied: boolean; smokeOnly: boolean; problems: string[] } {
  const elapsed = activeElapsedMs ?? 0;
  const durationSatisfied = elapsed >= durationMs;
  if (mode === 'full') {
    return {
      fullPassEligible: durationSatisfied,
      durationSatisfied,
      smokeOnly: false,
      problems: durationSatisfied ? [] : [`full run active ${elapsed}ms < required ${durationMs}ms`],
    };
  }
  return { fullPassEligible: false, durationSatisfied, smokeOnly: true, problems: [] };
}

/**
 * smoke 与 full 共用的通过判据。证据容量溢出是确定性失败面：即使任务随后正常结束，
 * 也不能在截断的样本窗口上宣称通过。
 */
export const smokePassed = (input: {
  primaryError: boolean;
  evidenceFailure: boolean;
  cleanupErrors: number;
  successfulLegs: number;
  directions: readonly string[];
  queryVerifiedLegs: number;
  savedCheckpointReports: number;
  failedCheckpointReports: number;
  traceCapacityExceeded: boolean;
}): boolean =>
  !input.primaryError
  && !input.evidenceFailure
  && input.cleanupErrors === 0
  && input.successfulLegs >= SMOKE_MIN_SUCCESSFUL_LEGS
  && input.directions.includes('A->B')
  && input.directions.includes('B->A')
  && input.queryVerifiedLegs >= input.successfulLegs
  && input.savedCheckpointReports >= SMOKE_MIN_CHECKPOINT_SAVES
  && input.failedCheckpointReports === 0
  && !input.traceCapacityExceeded;

interface RunReport {
  schema: 'spatial-soak-acceptance';
  runId: string;
  mode: 'smoke' | 'full';
  status: 'SMOKE_PASS' | 'FULL_PASS' | 'FAIL';
  smokePass: boolean;
  fullPass: boolean;
  longRunCompleted: boolean;
  durationSatisfied: boolean;
  pendingMandatory: readonly H2bScenarioId[];
  startedAt: number | null;
  finishedAt: number | null;
  activeElapsedMs: number | null;
  durationMs: number;
  voxelLoading: {
    requested: VoxelLoadingChoice;
    source: 'flag' | 'default';
    actual: string | null;
  };
  workingSet: Record<string, unknown>;
  traceCapacity: {
    events: number;
    failure: { kind: 'samples' | 'moves' | 'starts'; taskId: string; limit: number } | null;
  };
  mainManualEvidence: MainManualEvidence;
  start: FixtureEndpoint;
  measuredStart: FixtureEndpoint | null;
  fixture: typeof FIXTURE_FACTS;
  successfulLegs: number;
  queryVerifiedLegs: number;
  directions: string[];
  savedCheckpointReports: number;
  failedCheckpointReports: number;
  scenarios: Record<string, ScenarioResult>;
  telemetry: Record<string, unknown>;
  metadata: ReturnType<typeof collectMetadata> | null;
  evidence: { dir: string; metrics: string; events: string } | null;
  primaryError: ReturnType<typeof errorFacts> | null;
  cleanupErrors: { step: string; error: ReturnType<typeof errorFacts> }[];
  evidenceFailure: ReturnType<typeof errorFacts> | null;
  shutdown: Record<string, unknown> | null;
  shutdownVerdict: ShutdownVerdict | null;
  finalEvidenceWritten: boolean;
  h2: H2Status;
}

/**
 * 真实 smoke / soak 执行器。
 *
 * 只在 config.mode === 'test' 时运行；setup 使用只读 list 和一次自有 Bot 的 tp，
 * 之后的一切世界事实来自正常 Vision 与生产 walk_to/spatial_query。任何错误都先
 * 停止新任务、采集终态分类，再做有界清理；证据与数据库保留。
 */
async function runSoak(cli: Extract<ParsedCli, { ok: true; help: false }>): Promise<number> {
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
  const scenarioResults = new Map<string, ScenarioResult>();
  /** 证据容量溢出的首个有界事实；一旦出现，整次运行必须失败。 */
  let traceCapacityFailure: { kind: 'samples' | 'moves' | 'starts'; taskId: string; limit: number } | null = null;
  let traceCapacityEvents = 0;

  let eventsWriter: BoundedJsonlWriter | null = null;
  let evidenceEmitter: EvidenceEmitter | null = null;
  let foundation: SpatialSoakFoundation | null = null;
  let spatial: SharedSpatialSession | null = null;
  let mainSession: SpatialSoakMainSession | null = null;
  let mainVoxelLoading: string | null = null;
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
    quit?(): void;
  }
  let ownedBot: OwnedBotHandle | null = null;
  let ownedBotRef: unknown = null;
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
  let failedCheckpointReports = 0;
  const directions = new Set<string>();
  let snapshotTimer: NodeJS.Timeout | null = null;
  let snapshotCallbacks = 0;
  const physicsTicks = createPhysicsTickMetrics();
  let adapterListenerBaseline: { spawn: number | null; disconnected: number | null } = { spawn: null, disconnected: null };
  let botListenerBaseline: { physicsTick: number | null; end: number | null } = { physicsTick: null, end: null };
  let primaryError: unknown = null;
  const cleanupErrors: Array<{ step: string; error: unknown }> = [];
  let shutdownFactsResult: Record<string, unknown> | null = null;
  let shutdownVerdict: ShutdownVerdict | null = null;
  let finalTelemetry: Record<string, unknown> | null = null;
  let stopping = false;
  let moveCallSequence = 0;
  let startCallSequence = 0;

  // 主会话 manual 证据全部有界：快照序列、诊断计数、drain 结果与关停前 pending。
  const workingSetSnapshots: WorkingSetSnapshotFacts[] = [];
  let latestWorkingSetSnapshot: WorkingSetSnapshotFacts | null = null;
  let workingSetSnapshotCount = 0;
  let workingSetSnapshotOverflow = 0;
  let workingSetStatsSnapshotCount = 0;
  const workingSetSignatures = new Set<string>();
  let workingSetDiagnosticTotal = 0;
  let workingSetDiagnosticWritten = 0;
  const workingSetDiagnosticKinds = new Map<string, number>();
  let workingSetDrainFacts: Record<string, unknown> | null = null;
  let pendingBeforeShutdown: number | null = null;
  let workingSetPostShutdown: Record<string, unknown> | null = null;

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

  const residencySummary = (): Record<string, unknown> => ({
    state: latestWorkingSetSnapshot === null ? 'unknown' : 'observed',
    latestSnapshotLabel: latestWorkingSetSnapshot?.label ?? null,
    voxelLoading: latestWorkingSetSnapshot?.voxelLoading ?? mainVoxelLoading,
    stats: latestWorkingSetSnapshot?.stats ?? null,
    pending: latestWorkingSetSnapshot?.pending ?? null,
    residentBytesMeaning: 'library working-set estimate, not process RSS',
    snapshotCount: workingSetSnapshotCount,
    statsSnapshotCount: workingSetStatsSnapshotCount,
    diagnosticCount: workingSetDiagnosticTotal,
  });

  /**
   * 有界诊断回调：只在内存保留每个 kind 的计数，落盘事件有上限，不保留历史键。
   * 回调自身不做 I/O 之外的工作，也绝不改写库的真实行为。
   */
  const onWorkingSetDiagnostic = (diagnostic: WorkingSetDiagnosticFacts): void => {
    workingSetDiagnosticTotal += 1;
    const kind = diagnostic.kind;
    workingSetDiagnosticKinds.set(kind, (workingSetDiagnosticKinds.get(kind) ?? 0) + 1);
    if (workingSetDiagnosticWritten >= MAX_WORKING_SET_DIAGNOSTIC_EVENTS) return;
    workingSetDiagnosticWritten += 1;
    emit('working-set-diagnostic', null, {
      at: Date.now(),
      total: workingSetDiagnosticTotal,
      kind,
      reason: diagnostic.reason ?? null,
      count: diagnostic.count ?? null,
      keyCount: diagnostic.keys?.length ?? 0,
      observedAtMin: diagnostic.observedAtMin ?? null,
      observedAtMax: diagnostic.observedAtMax ?? null,
      message: typeof diagnostic.message === 'string'
        ? diagnostic.message.slice(0, MAX_WORKING_SET_DIAGNOSTIC_MESSAGE_CHARS)
        : null,
    });
  };

  /**
   * 主会话真实工作集快照。stats 只在打开后的实际模式是 manual 时调用；eager
   * 会话没有工作集，显式记录为 unavailable，绝不把它包装成 manual 证据。
   */
  const captureWorkingSetSnapshot = (label: string): WorkingSetSnapshotFacts => {
    const session = mainSession;
    const actual = session === null ? null : session.session.voxelLoading;
    const stats = session !== null && actual === 'manual' && typeof session.workingSetStats === 'function'
      ? session.workingSetStats()
      : null;
    const pending = session !== null && typeof session.pendingObservations === 'function'
      ? session.pendingObservations()
      : null;
    const unavailable = session === null
      ? 'main session not opened'
      : stats === null
        ? 'workingSetStats is unavailable (eager voxel loading or old host)'
        : pending === null
          ? 'pendingObservations is not integrated in this host'
          : null;
    const snapshot = buildWorkingSetSnapshot({
      label,
      at: Date.now(),
      activeElapsedMs: activeStartedAt === null ? null : Date.now() - activeStartedAt,
      voxelLoading: actual,
      stats,
      pending,
      unavailable,
    });
    workingSetSnapshotCount += 1;
    latestWorkingSetSnapshot = snapshot;
    if (stats !== null) {
      workingSetStatsSnapshotCount += 1;
      workingSetSignatures.add(workingSetStatsSignature(stats));
    }
    if (workingSetSnapshots.length < MAX_WORKING_SET_SNAPSHOTS) workingSetSnapshots.push(snapshot);
    else workingSetSnapshotOverflow += 1;
    emit('working-set-snapshot', null, snapshot);
    return snapshot;
  };

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
      residency: residencySummary(),
    };
  };

  const traceOverflow = (kind: 'samples' | 'moves' | 'starts', taskId: string): void => {
    const key = `${taskId}:${kind}`;
    if (takenTraceKeys.has(key)) return;
    takenTraceKeys.add(key);
    const limit = kind === 'samples' ? MAX_SAMPLES_PER_TASK : kind === 'moves' ? MAX_MOVES_PER_TASK : MAX_STARTS_PER_TASK;
    traceCapacityEvents += 1;
    traceCapacityFailure ??= { kind, taskId, limit };
    emit('trace-window-exceeded', taskId, {
      kind,
      limit,
      note: 'Explicit evidence-capacity failure; the run fails even if the task itself finishes successfully.',
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

  const measureLegStart = async (label: string): Promise<FixtureEndpoint> => {
    const settled = await waitForEvidenceAware(() => {
      const state = adapter!.state();
      const controls = controlsSnapshot(adapter!);
      return arbiter!.info() === null
        && state.observationReady
        && controls.ok
        && controlReleaseProblems(controls.values).length === 0;
    }, 10_000, `leg start settle (${label})`);
    if (!settled) throw new Error(`leg start body did not settle with released controls before ${label}`);
    return { ...adapter!.state().pos };
  };

  const runLeg = async (
    index: number,
    target: FixtureEndpoint,
    nominalFrom: 'A' | 'B',
    nominalTo: 'A' | 'B',
    measuredFrom: FixtureEndpoint,
  ): Promise<void> => {
    if (arbiter === null) throw new Error('walk leg requested before arbiter is ready');
    if (runScope === null) throw new Error('walk leg requested before runtime scope is ready');
    if (stopping) throw new Error('run is stopping; refusing walk_to');
    const tolerance = { ...library!.GROUNDED_ARRIVAL_DEFAULTS, horizontalTolerance: SOAK_ARRIVAL_RADIUS };
    // 即使 setup tp 落在标称格，服务端结算也可能让实测起点偏离整数脚格；exact 目标
    // 会因不在 ±1 脚格上被库拒绝。用 near 且验收使用同一半径：仍要求真实终点落在
    // 容差内，不投影或改写目标。
    const request = soakWalkRequest(target, Date.now() + SMOKE_LEG_BUDGET_MS);
    // leg-start/leg-result 共用同一个真实派发时刻，不用 deadline 反推。
    const startedAt = Date.now();
    const started = arbiter.start({ skill: 'walk_to', args: request }, 'user');
    if ('error' in started) throw new Error(`walk_to rejected: ${started.error}`);
    const info = started as TaskInfo;
    emit('leg-start', info.id, {
      index,
      nominal: { from: nominalFrom, to: nominalTo },
      measuredFrom: clone(measuredFrom),
      fixedTarget: clone(target),
      request: clone(request),
      task: clone(info),
      startedAt,
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
      const verdict = classifyWalkToResult(outcome.result, measuredFrom, target, tolerance, {
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
        measuredFrom: clone(measuredFrom),
        fixedTarget: clone(target),
        startedAt,
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
      voxelLoading: { requested: cli.voxelLoading, source: cli.voxelLoadingSource },
      fixture: FIXTURE_FACTS,
      note: 'smoke runs bounded real smoke; full opens the main session with manual voxel loading, requires real main-session working-set evidence, and at least one hour of active time.',
    });

    const { EventBus } = await import('../src/events.ts');
    const { MineflayerAdapter: MineflayerAdapterClass } = await import('../src/adapter/mineflayer.ts');
    const { Vision: VisionClass } = await import('../src/perception/vision.ts');
    const { WorldMemory: WorldMemoryClass } = await import('../src/memory/store.ts');
    const { Arbiter: ArbiterClass } = await import('../src/arbiter/arbiter.ts');
    const { Rcon: RconClass } = await import('../src/observer/rcon.ts');
    const { WalkMoveExecutor: WalkMoveExecutorClass } = await import('../src/adapter/walk-route.ts');
    library = await import('curio-minecraft-3d-memory');

    // full 只有在真实 manual API 存在时才可能通过；缺失时在连接前显式失败，
    // 绝不先跑一小时再报告 pending。
    if (cli.mode === 'full' && !manualScenarioSupported(SharedSpatialSession)) {
      emit('full-blocked', null, {
        reason: 'manual residency API is not integrated; full pass cannot be evaluated',
        requiredScenarios: H2B_REQUIRED_SCENARIOS,
      });
      throw new Error(
        'full mode blocked: SharedSpatialSession manual residency API (voxelLoading/prepare/release/workingSetStats/pendingObservations) is not integrated in this worktree',
      );
    }

    const bus = new EventBus();
    adapter = new MineflayerAdapterClass(config, bus);
    spatial = await SharedSpatialSession.open(buildSpatialOpenOptions(
      config.memory.worldId,
      path.join(evidenceDir, 'spatial.sqlite'),
      cli.voxelLoading,
      onWorkingSetDiagnostic,
    ));
    // mainSession 是同一个真实对象的能力视图；没有断言，也没有包装。
    mainSession = spatial;
    mainVoxelLoading = spatial.session.voxelLoading;
    emit('voxel-loading-opened', null, {
      requested: cli.voxelLoading,
      source: cli.voxelLoadingSource,
      actual: mainVoxelLoading,
    });
    // 请求值必须在真实打开结果上生效；eager 不能被静默当成 manual，反之亦然。
    if (mainVoxelLoading !== cli.voxelLoading) {
      throw new Error(`requested voxelLoading=${cli.voxelLoading} but opened session reports ${mainVoxelLoading}`);
    }
    // 从这里开始 spatial 已打开：即使后续构造失败，finally 也必须真实 shutdown。
    const openedSpatial = spatial;
    memory = new WorldMemoryClass(null);
    vision = new VisionClass(adapter, config.vision, openedSpatial);
    arbiter = new ArbiterClass(adapter, memory, bus, vision, openedSpatial);
    rcon = new RconClass(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);

    foundation = startSpatialSoakFoundation({
      service: openedSpatial,
      evidencePath: metricsPath,
      runId,
      onCheckpointReport: (report) => {
        if (report.status === 'saved') savedCheckpointReports += 1;
        else failedCheckpointReports += 1;
        emit('checkpoint-report', null, { report, savedCheckpointReports, failedCheckpointReports });
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
      // 本次调用自己的 record 在任何 await 之前创建并保留；绝不使用 sink.at(-1)，
      // 否则并发/紧随其后的另一次 move 会让结果写到错误的 record 上。
      const entry: CapturedMove = {
        taskId,
        receivedAt: Date.now(),
        request: {
          executionId: request.executionId,
          worldId: request.worldId,
          dim: request.dim,
          sessionId: request.sessionId,
          from: clone(request.from),
          to: clone(request.to),
          deadlineMs: request.deadlineMs,
          timeoutMs: request.timeoutMs,
        },
        result: null,
        error: null,
      };
      if (canKeep) window!.moves.push(entry);
      const call = ++moveCallSequence;
      emit('walk-move-request', taskId, { call, move: clone(entry) });
      const pending = moverOriginalMove!.call(this, request);
      return pending.then(
        (result) => {
          entry.result = {
            ...(result.sample === undefined ? {} : {
              sample: {
                executionId: result.sample.executionId,
                sequence: result.sample.sequence,
                worldId: result.sample.worldId,
                dim: result.sample.dim,
                sessionId: result.sample.sessionId,
                observedAt: result.sample.observedAt,
                position: clone(result.sample.pos),
                onGround: result.sample.onGround,
                inWater: result.sample.inWater,
              },
            }),
            ...(result.failure === undefined ? {} : { failure: clone(result.failure) as Record<string, unknown> }),
          };
          emit('walk-move-result', taskId, { call, move: clone(entry) });
          return result;
        },
        (error: unknown) => {
          entry.error = errorText(error);
          emit('walk-move-error', taskId, { call, move: clone(entry), error: errorFacts(error) });
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
      const candidate: unknown = adapter?.bot;
      if (candidate === null || candidate === undefined || candidate === ownedBotRef) return;
      // 换连接后把诊断监听器从旧 bot 上移除，再挂到真实新 bot；baseline 在挂接前采集。
      const previous = ownedBotHandle();
      if (previous !== null) {
        if (physicsTickListener !== null) previous.removeListener('physicsTick', physicsTickListener);
        if (botEndListener !== null) previous.removeListener('end', botEndListener);
        physicsTickListener = null;
        botEndListener = null;
      }
      ownedBotRef = candidate;
      ownedBot = candidate as OwnedBotHandle;
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
      ownedBot.once('end', botEndListener);
      ownedBot.on('physicsTick', physicsTickListener);
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
    // 第一条基线快照：真实主会话打开且初始观测已提交。
    captureWorkingSetSnapshot('initial-observation');

    const endpointName = (point: FixtureEndpoint): 'A' | 'B' => samePoint(point, FIXTURE_A) ? 'A' : 'B';
    let nominalFrom = endpointName(cli.start);
    const activeDeadline = (activeStartedAt = Date.now()) + cli.durationMs;
    let legIndex = 0;

    const smokeSatisfied = (): boolean =>
      successfulLegs >= SMOKE_MIN_SUCCESSFUL_LEGS
      && directions.has('A->B')
      && directions.has('B->A')
      && queryVerifiedLegs >= successfulLegs
      && savedCheckpointReports >= SMOKE_MIN_CHECKPOINT_SAVES
      && failedCheckpointReports === 0;

    const runNextLeg = async (): Promise<void> => {
      const nominalTo = nominalFrom === 'A' ? 'B' : 'A';
      const points = legFixturePoints(nominalFrom, nominalTo);
      // 每段 leg 都先做一次夹具 setup tp 到本段固定标称起点。上一段可能在容差内
      // 停在半格上，不能把该落点当作下一段固定目标的起点。tp 只布置夹具，不是
      // 移动证据；落地后再读取真实身体位置作为本段实测起点。
      const prepared = await prepareLegStart(legIndex, points.setup, fixtureTeleport, measureLegStart);
      emit('leg-setup', null, {
        index: prepared.index,
        from: nominalFrom,
        requested: clone(prepared.setupRequested),
        settled: clone(prepared.setupSettled),
        at: Date.now(),
        note: 'Fixture setup teleport before the leg; not movement evidence.',
      });
      await runLeg(legIndex, points.target, nominalFrom, nominalTo, prepared.measuredStart);
      directions.add(`${nominalFrom}->${nominalTo}`);
      nominalFrom = nominalTo;
      legIndex += 1;
      // 每段真实 leg 完成后记录主会话工作集快照（计数/字节估算，不保留键）。
      captureWorkingSetSnapshot(`leg-${legIndex}`);
    };
    const recordScenario = (result: ScenarioResult): ScenarioResult => {
      scenarioResults.set(result.id, result);
      emit('scenario-result', null, result);
      return result;
    };

    const runCancelScenario = async (): Promise<ScenarioResult> => {
      const id = 'explicit-cancel';
      const problems: string[] = [];
      const facts: Record<string, unknown> = {};
      const start = await measureLegStart('cancel scenario');
      const nearest = distance(start, FIXTURE_A) <= distance(start, FIXTURE_B) ? 'A' : 'B';
      const targetName = nearest === 'A' ? 'B' : 'A';
      const target = targetName === 'A' ? FIXTURE_A : FIXTURE_B;
      const request = soakWalkRequest(target, Date.now() + SMOKE_LEG_BUDGET_MS);
      const started = arbiter!.start({ skill: 'walk_to', args: request }, 'user');
      if ('error' in started) {
        return { id, state: 'failed', ok: false, problems: [`walk_to rejected: ${started.error}`], facts };
      }
      const info = started as TaskInfo;
      emit('scenario-start', info.id, { id, start: clone(start), target: clone(target), request: clone(request), task: clone(info) });
      try {
        const moved = await waitForEvidenceAware(() => {
          const window = perTask.get(info.id);
          return window !== undefined && window.samples.some((sample) =>
            sample.accepted && sample.taskId === info.id
            && distance(sample.sample.position, start) > CANCEL_MOVEMENT_THRESHOLD);
        }, 20_000, 'explicit cancel movement');
        facts.moved = moved;
        if (!moved) problems.push('no accepted same-task sample showed real movement before cancel');
        const cancelCalledAt = Date.now();
        emit('scenario-cancel-request', info.id, { id, at: cancelCalledAt });
        arbiter!.cancel('soak acceptance: explicit cancel after measured movement');
        const outcome = await waitForTaskOutcome(info.id, 10_000, true);
        facts.cancelLatencyMs = Date.now() - cancelCalledAt;
        if (outcome === null) problems.push('cancel outcome was not delivered');
        // 取消后的有界真实物理帧：至少覆盖 300ms，并且每一帧 7 个控制键都可读且松开。
        const frames: PhysicsFrame[] = [];
        let frameNumber = 0;
        const frameDeadline = Date.now() + 1_000;
        while (Date.now() < frameDeadline) {
          const entity = await nextPhysicsFrame(Math.max(1, frameDeadline - Date.now()));
          if (entity === null) break;
          frames.push({
            frame: ++frameNumber,
            at: Date.now(),
            position: { ...entity.position },
            onGround: entity.onGround,
            inWater: entity.isInWater,
            controls: controlsSnapshot(adapter!).values,
          });
        }
        const postCancel = classifyPostCancelFrames(frames, 300);
        facts.postCancelFrames = frames;
        facts.postCancel = postCancel;
        problems.push(...postCancel.problems);
        const controls = controlsSnapshot(adapter!);
        facts.controls = controls;
        if (!controls.ok) problems.push(`control keys unreadable after cancel: ${controls.missing.join(',')}`);
        if (outcome !== null) {
          const window = perTask.get(info.id);
          const verdict = classifyCancellationResult(
            outcome.result,
            info.id,
            window?.samples ?? [],
            controls.values,
            postCancel.reactivated,
            start,
          );
          facts.verdict = verdict;
          problems.push(...verdict.problems);
        }
      } finally {
        perTask.delete(info.id);
        outcomes.delete(info.id);
      }
      return { id, state: problems.length === 0 ? 'passed' : 'failed', ok: problems.length === 0, problems, facts };
    };

    const runDisconnectReconnectScenario = async (): Promise<ScenarioResult> => {
      const id = 'disconnect-reconnect';
      const problems: string[] = [];
      const facts: Record<string, unknown> = {};
      const before = adapter!.state();
      const baselineSession = before.sessionId;
      facts.before = { sessionId: baselineSession, pos: { ...before.pos }, worldId: before.worldId, dim: before.dim };
      let disconnected = false;
      const onDisconnected = () => { disconnected = true; };
      adapter!.once('disconnected', onDisconnected);
      const botCandidate: unknown = adapter!.bot;
      const quitBot = isRecordValue(botCandidate) && typeof botCandidate.quit === 'function'
        ? botCandidate.quit
        : null;
      if (quitBot === null) {
        adapter!.off('disconnected', onDisconnected);
        return { id, state: 'failed', ok: false, problems: ['adapter exposes no real bot handle to disconnect'], facts };
      }
      emit('scenario-disconnect', null, { id, at: Date.now(), baselineSession });
      quitBot.call(botCandidate);
      const sawDisconnect = await waitForEvidenceAware(() => disconnected, 30_000, 'real disconnect');
      facts.disconnected = sawDisconnect;
      if (!sawDisconnect) problems.push('real disconnect event was not observed');
      const reconnected = await waitForEvidenceAware(() => {
        const state = adapter!.state();
        return state.observationReady && state.sessionId !== baselineSession;
      }, 60_000, 'real reconnect/new session');
      facts.reconnected = reconnected;
      const after = adapter!.state();
      facts.after = { sessionId: after.sessionId, pos: { ...after.pos }, worldId: after.worldId, dim: after.dim };
      if (!reconnected) problems.push('did not reach observationReady with a new session after reconnect');
      adapter!.off('disconnected', onDisconnected);
      // 新 bot 句柄重新挂接有界物理帧/end 诊断；旧句柄监听器在 captureOwnBot 内移除。
      botEnded = false;
      adapterDisconnected = false;
      captureOwnBot();
      const scope = adapter!.state();
      if (reconnected) {
        const cells = localBodyCells(scope.pos);
        const observations = vision!.observeBlocks(cells);
        const admitted = spatial!.observationAdmitted;
        facts.observations = observations.length;
        facts.admitted = admitted;
        if (!admitted) problems.push('shared spatial session did not admit observations under the reconnected session');
        runScope = { worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId };
        measuredStart = { ...scope.pos };
      }
      const controls = controlsSnapshot(adapter!);
      facts.controls = controls;
      if (!controls.ok || CONTROL_KEYS.some((key) => controls.values[key] === true)) {
        problems.push('controls are not readable/released after reconnect');
      }
      if (arbiter!.info() !== null) problems.push('a task is still active after reconnect');
      emit('scenario-reconnect', null, { id, ...facts, scope: runScope });
      return { id, state: problems.length === 0 ? 'passed' : 'failed', ok: problems.length === 0, problems, facts };
    };

    const runCloseReopenScenario = async (): Promise<ScenarioResult> => {
      const id = 'close-reopen';
      const problems: string[] = [];
      const facts: Record<string, unknown> = {};
      const databasePath = path.join(evidenceDir, 'scenario-close-reopen.sqlite');
      const scope = adapter!.state();
      const cells = localBodyCells(scope.pos);
      const initial = vision!.observeBlocks(cells);
      const targetObservation = initial[0];
      if (targetObservation === undefined) {
        return { id, state: 'failed', ok: false, problems: ['Vision returned no observations for close/reopen scenario'], facts };
      }
      let first: SharedSpatialSession | null = null;
      let second: SharedSpatialSession | null = null;
      try {
        first = await SharedSpatialSession.open({ worldId: scope.worldId, databasePath });
        first.beginSession({ worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId });
        first.observe(initial);
        const before = first.session.voxel.cellAt(scope.dim, targetObservation.pos.x, targetObservation.pos.y, targetObservation.pos.z);
        if (!before.observed) {
          problems.push('first session did not store the real Vision observation');
        } else {
          facts.before = before.evidence;
          if (before.evidence.observation.observedAt !== targetObservation.observedAt) {
            problems.push('first session stored a different observedAt than Vision delivered');
          }
        }
        const shutdownA = await first.shutdown();
        first = null;
        const verdictA = classifyShutdownResult(shutdownA);
        problems.push(...verdictA.problems.map((problem) => `first session: ${problem}`));
        const reopenAt = Date.now();
        facts.reopenAt = reopenAt;
        second = await SharedSpatialSession.open({ worldId: scope.worldId, databasePath });
        second.beginSession({ worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId });
        const restored = second.session.voxel.cellAt(scope.dim, targetObservation.pos.x, targetObservation.pos.y, targetObservation.pos.z);
        facts.restored = restored.observed ? restored.evidence : restored;
        if (!restored.observed) {
          problems.push('reopened session lost the observed cell');
        } else {
          const evidence = restored.evidence;
          facts.originalObservedAt = evidence.observation.observedAt;
          facts.restoredFreshness = evidence.freshness;
          facts.restoredStaleReason = evidence.staleReason ?? null;
          if (evidence.freshness !== 'STALE') {
            problems.push(`restored evidence freshness is ${evidence.freshness} (STALE required after reopen)`);
          }
          if (evidence.observation.observedAt !== targetObservation.observedAt) {
            problems.push('restored evidence observedAt was not the original observation timestamp');
          }
          if (evidence.observation.observedAt >= reopenAt) {
            problems.push('restored observedAt is not earlier than the actual reopen time');
          }
          if (evidence.observation.sessionId !== scope.sessionId) {
            problems.push('restored evidence lost its original session id');
          }
        }
        // 新的真实 Vision 观测才能把同一格恢复为 FRESH；重放旧时间戳不被当作新观测。
        const fresh = vision!.observeBlocks(cells);
        const freshMatch = fresh.find((observation) =>
          observation.pos.x === targetObservation.pos.x
          && observation.pos.y === targetObservation.pos.y
          && observation.pos.z === targetObservation.pos.z);
        if (freshMatch === undefined) {
          problems.push('fresh Vision observation did not cover the reopened cell');
        } else {
          second.observe([freshMatch]);
          const refreshed = second.session.voxel.cellAt(scope.dim, freshMatch.pos.x, freshMatch.pos.y, freshMatch.pos.z);
          facts.refreshed = refreshed.observed ? refreshed.evidence : refreshed;
          if (!refreshed.observed) problems.push('fresh observation did not restore the reopened cell');
          else {
            if (refreshed.evidence.freshness !== 'FRESH') problems.push('fresh observation did not restore freshness');
            if (refreshed.evidence.observation.observedAt !== freshMatch.observedAt) {
              problems.push('fresh observation did not preserve its delivered observedAt');
            }
            if (refreshed.evidence.observation.observedAt <= targetObservation.observedAt) {
              problems.push('fresh observation timestamp did not advance past the restored observation');
            }
          }
        }
        const shutdownB = await second.shutdown();
        second = null;
        const verdictB = classifyShutdownResult(shutdownB);
        problems.push(...verdictB.problems.map((problem) => `second session: ${problem}`));
      } finally {
        if (second !== null) {
          const shutdown = await second.shutdown();
          facts.cleanupSecondShutdown = classifyShutdownResult(shutdown).problems;
          second = null;
        }
        if (first !== null) {
          const shutdown = await first.shutdown();
          facts.cleanupFirstShutdown = classifyShutdownResult(shutdown).problems;
          first = null;
        }
      }
      emit('scenario-close-reopen', null, { ...facts, problems });
      return { id, state: problems.length === 0 ? 'passed' : 'failed', ok: problems.length === 0, problems, facts };
    };

    // smoke 活动：跑到判据满足或预算不足以再启动一段。未满足时只做有限等待，
    // 绝不把剩余的 full 时长当成空等（full 由下面显式场景与 soak 循环填充）。
    while (!stopping && !smokeSatisfied()) {
      if (failedCheckpointReports > 0) throw new Error(`scheduled checkpoint failed (${failedCheckpointReports} reports)`);
      const remaining = activeDeadline - Date.now();
      if (remaining < SMOKE_LEG_BUDGET_MS + 5_000) break;
      await runNextLeg();
    }
    if (!smokeSatisfied() && failedCheckpointReports === 0) {
      const remaining = Math.max(0, activeDeadline - Date.now());
      if (remaining > 0) {
        await waitForEvidenceAware(
          () => smokeSatisfied() || failedCheckpointReports > 0 || Date.now() >= activeDeadline,
          Math.min(remaining, SMOKE_COMPLETION_WAIT_MS),
          'smoke completion wait',
        );
      }
    }
    if (failedCheckpointReports > 0) throw new Error(`scheduled checkpoint failed (${failedCheckpointReports} reports)`);
    if (!smokeSatisfied()) {
      throw new Error(
        `smoke criteria not met: legs=${successfulLegs} directions=${[...directions].join(',')} queries=${queryVerifiedLegs} savedCheckpoints=${savedCheckpointReports}`,
      );
    }

    if (cli.mode === 'full') {
      // 场景按真实依赖顺序执行；任一失败立即抛出，不空等剩余时长。
      const cancel = recordScenario(await runCancelScenario());
      captureWorkingSetSnapshot('scenario-explicit-cancel');
      if (!cancel.ok) throw new Error(`explicit-cancel scenario failed: ${cancel.problems.join(', ')}`);
      const reconnect = recordScenario(await runDisconnectReconnectScenario());
      captureWorkingSetSnapshot('scenario-disconnect-reconnect');
      if (!reconnect.ok) throw new Error(`disconnect-reconnect scenario failed: ${reconnect.problems.join(', ')}`);
      const reopen = recordScenario(await runCloseReopenScenario());
      captureWorkingSetSnapshot('scenario-close-reopen');
      if (!reopen.ok) throw new Error(`close-reopen scenario failed: ${reopen.problems.join(', ')}`);
      const manualScope = adapter.state();
      const manual = recordScenario(await runManualScenario({
        worldId: config.memory.worldId,
        databasePath: path.join(evidenceDir, 'scenario-manual.sqlite'),
        scope: { worldId: manualScope.worldId, dim: manualScope.dim, sessionId: manualScope.sessionId },
        observe: () => vision!.observeBlocks(localBodyCells(adapter!.state().pos)),
        emit: (kind, payload) => { emit(kind, null, payload); },
      }));
      captureWorkingSetSnapshot('scenario-manual-residency');
      if (!manual.ok) throw new Error(`manual-residency scenario ${manual.state}: ${manual.problems.join(', ')}`);

      // 满足全部场景后继续真实 leg/checkpoint 活动直到完整一小时。
      while (!stopping && Date.now() < activeDeadline) {
        if (failedCheckpointReports > 0) throw new Error(`scheduled checkpoint failed (${failedCheckpointReports} reports)`);
        const remaining = activeDeadline - Date.now();
        if (remaining < SMOKE_LEG_BUDGET_MS + 5_000) {
          await sleep(remaining);
          break;
        }
        await runNextLeg();
      }
      // 最后不足一段预算时只等待到真实期限，确保 activeElapsedMs 不是被缩短的。
      while (Date.now() < activeDeadline) {
        await sleep(Math.min(1_000, Math.max(1, activeDeadline - Date.now())));
      }
    }

    activeFinishedAt = Date.now();
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

    // 先移除自有 physicsTick 监听，再处理任务与连接。
    const botHandle = ownedBotHandle();
    if (botHandle !== null && physicsTickListener !== null) {
      botHandle.removeListener('physicsTick', physicsTickListener);
      physicsTickListener = null;
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
      // 移除会话重置监听，避免 quit 产生的 session_reset 在最终 checkpoint 前把证据置 stale。
      if (doneListener !== null) {
        arbiter.off('done', doneListener);
        doneListener = null;
      }
      try {
        arbiter.dispose();
      } catch (error) {
        noteCleanupError('arbiter-dispose', error);
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

    // 监听器计数只在真实 quit 与 removeListener 之后采集，不把清理前快照冒充最终值。
    if (adapter !== null && disconnectListener !== null) {
      adapter.off('disconnected', disconnectListener);
      disconnectListener = null;
    }
    if (adapter !== null && spawnListener !== null) {
      adapter.off('spawn', spawnListener);
      spawnListener = null;
    }
    const finalBotHandle = ownedBotHandle();
    if (finalBotHandle !== null && botEndListener !== null) {
      finalBotHandle.removeListener('end', botEndListener);
      botEndListener = null;
    }
    const finalListeners = connectionListenerSnapshot();
    const telemetryFinal = {
      listeners: { baseline: { adapter: adapterListenerBaseline, bot: botListenerBaseline }, final: finalListeners },
      physicsTicks: physicsTicks.snapshot(),
      snapshotCallbacks,
      residency: residencySummary(),
    };
    finalTelemetry = telemetryFinal;
    if (foundation !== null) {
      foundation.appendMetrics({ kind: 'connection-metrics', label: 'final', ...telemetryFinal });
    }
    emit('connection-final', null, telemetryFinal);

    // 关停前先处理可接受的 handoff：manual 主会话显式 drain 一次，再记录关停前
    // 快照。残留 pending 不会被改写成功；shutdown 会把它们计入 error。
    // 快照失败只记为清理错误，绝不能阻止后续真实 shutdown。
    try {
      captureWorkingSetSnapshot('before-shutdown-drain');
    } catch (error) {
      noteCleanupError('working-set-snapshot-before-drain', error);
    }
    if (
      mainSession !== null
      && mainVoxelLoading === 'manual'
      && typeof mainSession.drainObservations === 'function'
    ) {
      try {
        const drained = await withTimeout(
          mainSession.drainObservations({ deadline: Date.now() + 15_000 }),
          30_000,
          'bounded working-set drain',
        );
        const pending = drained.pending;
        workingSetDrainFacts = {
          cancelled: drained.cancelled,
          reason: drained.reason,
          pendingObservations: pending.observations,
          pendingBytes: pending.bytes ?? 0,
          pendingSectionCount: pending.sections?.length ?? 0,
          pendingObservedAtMin: pending.observedAtMin ?? null,
          pendingObservedAtMax: pending.observedAtMax ?? null,
          gap: drained.gap === undefined || drained.gap === null ? null : {
            kind: drained.gap.kind ?? null,
            count: drained.gap.count ?? null,
            keyCount: drained.gap.keys?.length ?? 0,
            message: typeof drained.gap.message === 'string'
              ? drained.gap.message.slice(0, MAX_WORKING_SET_DIAGNOSTIC_MESSAGE_CHARS)
              : null,
          },
          checkpointError: drained.checkpointError === null ? null : errorFacts(drained.checkpointError),
        };
        emit('working-set-drain', null, workingSetDrainFacts);
      } catch (error) {
        noteCleanupError('working-set-drain', error);
      }
    }
    let preShutdownSnapshot: WorkingSetSnapshotFacts | null = null;
    try {
      preShutdownSnapshot = captureWorkingSetSnapshot('before-shutdown');
    } catch (error) {
      noteCleanupError('working-set-snapshot-before-shutdown', error);
    }
    pendingBeforeShutdown = preShutdownSnapshot?.pending?.observations ?? null;

    // spatial 已打开时必须有真实 shutdown 结果。foundation 构造失败时也要兜底关闭。
    if (foundation !== null) {
      try {
        const stopped = await withTimeout(foundation.stop(), 60_000, 'bounded foundation stop');
        shutdownFactsResult = shutdownFacts(stopped.shutdown);
        shutdownVerdict = classifyShutdownResult(stopped.shutdown);
        emit('shutdown', null, {
          shutdown: shutdownFactsResult,
          verdict: shutdownVerdict,
          evidenceError: stopped.evidenceError === null ? null : errorFacts(stopped.evidenceError),
          h2: H2_PENDING,
        });
      } catch (error) {
        noteCleanupError('foundation-stop', error);
      }
    }
    if (spatial !== null && foundation === null) {
      // 会话已 open 但 foundation 构造失败：直接调用真实 shutdown，避免泄漏。
      try {
        const shutdown = await withTimeout(spatial.shutdown(), 60_000, 'bounded fallback spatial shutdown');
        shutdownFactsResult = shutdownFacts(shutdown);
        shutdownVerdict = classifyShutdownResult(shutdown);
        emit('shutdown', null, {
          shutdown: shutdownFactsResult,
          verdict: shutdownVerdict,
          fallback: true,
          note: 'foundation construction failed; spatial session was still shut down by the caller.',
          h2: H2_PENDING,
        });
      } catch (error) {
        noteCleanupError('spatial-shutdown', error);
      }
    }
    // close 之后不再调用 workingSetStats/pendingObservations：它们属于已关闭会话。
    // 这里只记录 close 后的事实与关停前 pending，不伪造“关停后统计”。
    workingSetPostShutdown = {
      label: 'after-shutdown',
      at: Date.now(),
      available: false,
      reason: 'session was closed by real shutdown; working-set APIs are not called after close',
      voxelLoading: mainVoxelLoading,
      pendingBeforeShutdown,
      drainCancelled: workingSetDrainFacts?.cancelled ?? null,
      shutdownCheckpoint: shutdownFactsResult?.checkpoint ?? null,
      shutdownError: shutdownFactsResult?.error ?? null,
    };
    emit('working-set-post-shutdown', null, workingSetPostShutdown);

    if (spatial !== null && shutdownVerdict === null) {
      shutdownVerdict = classifyShutdownResult(null);
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
  const activeElapsedMs = activeStartedAt === null ? null : Math.max(0, activeFinishedAt - activeStartedAt);
  const evidenceFailure = currentEvidenceFailure();
  const durationVerdict = classifyDuration(cli.mode, cli.durationMs, activeElapsedMs);
  const shutdownOk = spatial === null
    ? primaryError !== null || !connectAttempted
    : shutdownVerdict !== null && shutdownVerdict.ok;
  const smokePass = smokePassed({
    primaryError: primaryError !== null,
    evidenceFailure: evidenceFailure !== null,
    cleanupErrors: cleanupErrors.length,
    successfulLegs,
    directions: [...directions],
    queryVerifiedLegs,
    savedCheckpointReports,
    failedCheckpointReports,
    traceCapacityExceeded: traceCapacityFailure !== null,
  });
  const scenariosPass = cli.mode === 'smoke'
    || H2B_REQUIRED_SCENARIOS.every((id) => scenarioResults.get(id)?.ok === true);
  const workingSetStatsChanged = workingSetSignatures.size > 1;
  const mainManualEvidence = classifyMainManualEvidence({
    mode: cli.mode,
    requested: cli.voxelLoading,
    actual: mainVoxelLoading,
    statsSnapshotCount: workingSetStatsSnapshotCount,
    statsChanged: workingSetStatsChanged,
    pendingBeforeShutdown,
  });
  const pass = smokePass
    && shutdownOk
    && scenariosPass
    && mainManualEvidence.ok
    && (cli.mode === 'smoke' || durationVerdict.fullPassEligible);

  const manualResult = scenarioResults.get('manual-residency');
  const report: RunReport = {
    schema: 'spatial-soak-acceptance',
    runId,
    mode: cli.mode,
    status: pass ? (cli.mode === 'full' ? 'FULL_PASS' : 'SMOKE_PASS') : 'FAIL',
    smokePass,
    fullPass: cli.mode === 'full' && pass,
    longRunCompleted: cli.mode === 'full' && durationVerdict.durationSatisfied,
    durationSatisfied: durationVerdict.durationSatisfied,
    pendingMandatory: cli.mode === 'smoke'
      ? H2B_REQUIRED_SCENARIOS
      : H2B_REQUIRED_SCENARIOS.filter((id) => scenarioResults.get(id)?.ok !== true),
    startedAt: activeStartedAt,
    finishedAt: activeFinishedAt,
    activeElapsedMs,
    durationMs: cli.durationMs,
    voxelLoading: {
      requested: cli.voxelLoading,
      source: cli.voxelLoadingSource,
      actual: mainVoxelLoading,
    },
    workingSet: {
      snapshots: workingSetSnapshots,
      snapshotCount: workingSetSnapshotCount,
      snapshotOverflow: workingSetSnapshotOverflow,
      statsSnapshotCount: workingSetStatsSnapshotCount,
      statsChanged: workingSetStatsChanged,
      distinctStatsSignatures: workingSetSignatures.size,
      pendingBeforeShutdown,
      diagnostics: {
        total: workingSetDiagnosticTotal,
        written: workingSetDiagnosticWritten,
        overflow: Math.max(0, workingSetDiagnosticTotal - workingSetDiagnosticWritten),
        byKind: Object.fromEntries(workingSetDiagnosticKinds),
      },
      drain: workingSetDrainFacts,
      afterShutdown: workingSetPostShutdown,
      residentBytesMeaning: 'library working-set estimate, not process RSS',
    },
    traceCapacity: {
      events: traceCapacityEvents,
      failure: traceCapacityFailure,
    },
    mainManualEvidence,
    start: clone(cli.start),
    measuredStart: measuredStart === null ? null : clone(measuredStart),
    fixture: FIXTURE_FACTS,
    successfulLegs,
    queryVerifiedLegs,
    directions: [...directions],
    savedCheckpointReports,
    failedCheckpointReports,
    scenarios: Object.fromEntries(scenarioResults),
    telemetry: {
      // 此报告本身作为下一条记录写入；这里统计的是它之前已落盘的事件。
      eventRecordsBeforeResult: eventsWriter?.recordsWritten ?? 0,
      eventBytesBeforeResult: eventsWriter?.bytesWritten ?? 0,
      listenerCounts: finalTelemetry?.listeners ?? null,
      mainWorkingSet: {
        snapshotCount: workingSetSnapshotCount,
        statsSnapshotCount: workingSetStatsSnapshotCount,
        statsChanged: workingSetStatsChanged,
        pendingBeforeShutdown,
        diagnosticTotal: workingSetDiagnosticTotal,
        drainCancelled: workingSetDrainFacts?.cancelled ?? null,
      },
      manualPendingObservations: manualResult?.facts.pendingBeforeShutdown
        ?? manualResult?.facts.pendingAfterObserve
        ?? null,
      manualUnreleasedPins: manualResult?.facts.unreleasedPins
        ?? manualResult?.facts.unreleasedPinsAtCleanup
        ?? null,
      unconfirmedCloseRequest: shutdownFactsResult?.close === null || shutdownFactsResult?.close === undefined
        ? null
        : (isRecordValue(shutdownFactsResult.close) ? shutdownFactsResult.close.unconfirmedRequest : null),
      dirtyAtClose: shutdownFactsResult?.close === null || shutdownFactsResult?.close === undefined
        ? null
        : (isRecordValue(shutdownFactsResult.close) ? shutdownFactsResult.close.dirty : null),
    },
    metadata,
    evidence: { dir: evidenceDir, metrics: metricsPath, events: eventsPath },
    primaryError: primaryError === null ? null : errorFacts(primaryError),
    cleanupErrors: cleanupErrors.map((entry) => ({ step: entry.step, error: errorFacts(entry.error) })),
    evidenceFailure: evidenceFailure === null ? null : errorFacts(evidenceFailure),
    shutdown: shutdownFactsResult,
    shutdownVerdict,
    // 该记录只有在下面真正写入成功后才存在；写入失败时 stdout 报告会改回 false。
    finalEvidenceWritten: true,
    h2: h2ForResult(cli.mode, pass),
  };

  const finalRecord = emit('run-result', null, report);
  if (finalRecord === null) {
    report.status = 'FAIL';
    report.smokePass = false;
    report.fullPass = false;
    report.finalEvidenceWritten = false;
    report.h2 = h2ForResult(cli.mode, false);
    report.primaryError ??= errorFacts(new Error('final run-result evidence record was not written'));
  }
  eventsWriter?.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === 'FAIL' || !report.finalEvidenceWritten ? 1 : 0;
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
    process.exitCode = await runSoak(parsed);
  }
}
