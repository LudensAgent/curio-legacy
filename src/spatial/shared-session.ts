/**
 * shared-session：宿主级共享空间记忆服务（阶段 D1）。
 *
 * 持有唯一一个公开的 SpatialSession（组合会话：voxel + facts + ledger +
 * journal + 单个 SQLite Worker），以及最后一份可信的有效 world/dim/session
 * 作用域、暂停/关停状态和当前唯一的步行委托 report/cancel 附着。
 *
 * 证据只来自 Curio 感知产出的 typed BlockObservation[]；生命周期/作用域由
 * adapter 的真实状态单独供给，绝不从观测载荷激活。模块加载只读取宿主配置里的
 * 体素证据新鲜度上限（可被 open 选项覆盖）；D2 会接入真实 Arbiter/adapter，
 * 本阶段只暴露 D2 需要的最小操作。
 *
 * manual 体素加载（M2a1）沿用库的 WorkingSetCoordinator，只补宿主自己的接缝：
 * resident 证据同步写入并在同一调用内派发；saved 但未驻留的证据按原始载荷有界
 * 排队、一次只跟踪一个真实 load，成功后按原观测时间/序列补写；容量/未就绪/
 * 作用域失效都留下可见结构化缺口，绝不伪造已观察空气或已保存。
 */
import { config } from '../config.ts';
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  CapacityGapKind,
  CloseResult,
  FreeResult,
  SnapshotLimits,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
  WorkingSetStats,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import { createVoxelFactsQueryPort, VoxelResidencyError } from 'curio-minecraft-3d-memory';
import type {
  BatchChangeReport,
  ChangeReport,
  Observation,
  ObservationBatch,
  ResidencyLimits,
  SectionKey,
  SectionResidency,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  StaleReason,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import { capabilityGate, readHostCapabilities } from './capabilities.ts';
import type { CapabilityDomain, HostCapabilityReport, MemoryWriteCapability } from './capabilities.ts';
import type { BlockObservation } from '../adapter/types.ts';
import { MAX_DEADLINE_DELAY_MS, WorkingSetCoordinator } from './working-set.ts';
import type { WorkingSetPrepareOptions, WorkingSetPrepareOutcome } from './working-set.ts';

/** 正常操作的持久化时限；supervisor 20s 窗口内约可容纳一次保存 + 最终 checkpoint + close。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 运行时默认的快照字节上限（与 config 的 SPATIAL_SNAPSHOT_MAX_MB 默认值一致）；离线迁移工具不读 config，按它打开。 */
export const DEFAULT_SNAPSHOT_MAX_MB = 192;

/** 关停时最终保存窗口内最多提交多少个 bounded dirty 批次。 */
const MAX_FINAL_CHECKPOINT_BATCHES = 16;

/** 宿主侧待加载原始证据的硬上限；超出时保留时间/数量并显式报告，不静默覆盖。 */
export const MAX_PENDING_OBSERVATIONS = 256;

/** 宿主侧待加载原始 JSON 载荷的 UTF8 字节预算；与库内驻留字节上限相互独立。 */
export const MAX_PENDING_OBSERVATION_BYTES = 1024 * 1024;

/**
 * 工作集容量失败后的有界退避。新证据仍会入 pending，但不会每条观测都重新
 * prepare；显式 drain 可以立即重试。这样容量缺口只报告一次，不在同一状态下
 * 反复刷诊断/占用主线程。
 */
const CAPACITY_RETRY_BACKOFF_MS = 5000;

/** 诊断摘要里保留的 Section 键上限；超出只保留总数事实，不累积历史键。 */
const MAX_DIAGNOSTIC_KEYS = 32;

/** 诊断消息 UTF8 字节上限；键与消息截断都留下明确数量事实。 */
export const MAX_DIAGNOSTIC_MESSAGE_BYTES = 512;

/** 宿主可信作用域（来自 adapter 真实状态，绝不来自观测载荷）。 */
export interface TrustedScope {
  worldId: string;
  /** 具体维度；adapter 未就绪时可能为 'unknown'，此时保留上一份有效维度。 */
  dim: string;
  sessionId: string;
}

/** 打开共享空间会话的选项。 */
export interface SharedSpatialOpenOptions {
  worldId: string;
  /** 绝对数据库文件路径。 */
  databasePath: string;
  /** 中断边界时钟；默认 Date.now。测试可注入假时钟以验证延迟证据被拒绝。 */
  now?: () => number;
  /** 单次持久化操作时限；默认 5000ms。 */
  timeoutMs?: number;
  /** 快照容量上限（诚实用于快照容量，不是运行时驻留上限）；测试可用小上限。 */
  snapshotLimits?: SnapshotLimits;
  /** 体素加载模式；默认 eager。manual 时才构造宿主工作集协调器。 */
  voxelLoading?: VoxelLoading;
  /** manual 模式的运行时驻留上限；透传库的 ResidencyLimits。 */
  residencyLimits?: ResidencyLimits;
  /** 单次 checkpoint 的体素 dirty 批次字节上限；省略时沿用快照 maxBytes。 */
  voxelBatchMaxBytes?: number;
  /** 体素证据新鲜度上限；默认取宿主 config.spatial.voxelValidityWindowMs（5 分钟）。 */
  voxelValidityWindowMs?: number;
  /** 可选诊断回调：容量、队列、未就绪与作用域丢弃事件。 */
  onWorkingSetDiagnostic?: (diagnostic: SharedSpatialDiagnostic) => void;
}

/** 身体直接接触到的当前站位事实；只用于本地重扫，不是远处视野。 */
export interface LocalStanceCell {
  pos: Vec3Like;
  name: string;
  properties?: Record<string, string | number | boolean>;
  stateComplete: boolean;
}

export interface LocalStanceObservation {
  dim: string;
  sessionId: string;
  /** 与感知观测共用的接收顺序；只用于库内的顺序/关联。 */
  sequence: number;
  observedAt: number;
  cells: readonly LocalStanceCell[];
}

/** 当前唯一的步行委托附着：同步接收变化报告 + 可被服务取消。 */
export interface WalkAttachment {
  /** 同步接收每次变化报告（在宿主 body onSample 之前，D2 使用）。 */
  receiver: (report: ChangeReport) => void;
  /** 服务在断开/死亡/作用域变化/关闭时调用，取消活动委托。 */
  cancel: () => void;
  /**
   * 可选：本委托正在保护/依赖的 Section。M2b 接入；M2a1 只用于在 resident
   * 字节增长失败时取消真正受影响的当前 owner，不中断无关任务。
   */
  protectedSections?: readonly SectionKey[];
}

/** 关停结果：主保存错误、取消错误与次关闭错误/结果分开保留。 */
export interface ShutdownResult {
  /** 最终已提交的 checkpoint；最终保存失败时为 null。 */
  checkpoint: SpatialCheckpointResult | null;
  /** 主保存错误（原始抛出对象，从不重贴 kind）；无错误时为 null。 */
  error: unknown;
  /** 取消附着时的原始抛出对象；取消成功或没有附着时为 null。 */
  cancelError: unknown;
  /** 真实 close() 结果；close 自身抛错时为 null（绝不伪造结果）。 */
  close: CloseResult | null;
  /** close() 自身抛出的原始对象；无错误时为 null。 */
  closeError: unknown;
}

/**
 * 附着 receiver 回调失败；保留原始抛出对象和“已经应用多少条观测”的显式事实。
 * `applied > 0` 表示写入已经发生、失败只属于回调，不能把这段证据算作待处理。
 */
export interface SharedSpatialReceiverFailure {
  error: unknown;
  applied: number;
}

/** 宿主写入口拒绝的类别；每一类都说明“没有调用库”或“作用域不符”，不是世界事实。 */
export type SharedSpatialWriteRejection =
  | { kind: 'capability_unavailable'; method: MemoryWriteCapability; detail: string }
  | { kind: 'not_ready'; detail: string }
  | { kind: 'closed'; detail: string }
  | { kind: 'scope_mismatch'; detail: string; expectedDim: string; actualDim: string };

/** 共享会话直接拥有并仍使用的体素写方法。 */
export type MemoryWriteMethod = Extract<MemoryWriteCapability, 'markTraversed' | 'markModified' | 'markStale'>;

/**
 * 一次写入的结果。`written` 只表示内存接受；`deliveryError.committed === true`
 * 表示写入已经提交，失败只属于报告转发（契约 §8.1 规则 6）。
 */
export type SharedSpatialWriteResult =
  | {
      status: 'written';
      report: ChangeReport;
      deliveryError: { committed: true; error: unknown } | null;
    }
  | { status: 'rejected'; reason: SharedSpatialWriteRejection };

/** 结构化缺口类别；只描述宿主实际拒绝/未完成的事实。 */
export type SharedSpatialGapKind =
  | 'queue_full'
  | 'count_capacity'
  | 'byte_capacity'
  | 'capacity'
  | 'load_failed'
  | 'not_ready'
  | 'busy'
  | 'prepare_cancelled'
  | 'observe_failed';

/** 一次可见的原始证据缺口：包含受影响的 Section、条数与原始 observedAt 范围。 */
export interface SharedSpatialGap {
  kind: SharedSpatialGapKind;
  message: string;
  keys: SectionKey[];
  count: number;
  observedAtMin: number | null;
  observedAtMax: number | null;
}

/** 因 interrupt/pause/新作用域而丢弃的旧 handoff；保留原始条数/键/时间范围。 */
export interface SharedSpatialDiscarded {
  kind: 'discarded';
  reason: 'interrupt' | 'pause' | 'scope';
  message: string;
  keys: SectionKey[];
  count: number;
  observedAtMin: number | null;
  observedAtMax: number | null;
}

export type SharedSpatialDiagnostic = SharedSpatialGap | SharedSpatialDiscarded;

/** 只读待处理 handoff 快照。 */
export interface SharedSpatialPendingInfo {
  observations: number;
  /** 当前待处理原始载荷的 UTF8 JSON 字节数。 */
  bytes: number;
  /** 条数上限。 */
  countLimit: number;
  /** 字节上限。 */
  byteLimit: number;
  sections: SectionKey[];
  observedAtMin: number | null;
  observedAtMax: number | null;
  /** 是否有真实 manager load 正在跟踪（不是“一定会成功”）。 */
  loading: boolean;
}

export interface SharedSpatialDrainOptions {
  signal?: AbortSignal;
  /** 绝对 epoch 毫秒期限；支持范围与 WorkingSetCoordinator 一致。 */
  deadline?: number;
}

/** 显式 drain 的结果；未完成就如实保留 pending/gap，不把 busy 当成功。 */
export interface SharedSpatialDrainResult {
  cancelled: boolean;
  reason: 'aborted' | 'deadline' | 'closing' | null;
  pending: SharedSpatialPendingInfo;
  gap: SharedSpatialGap | null;
  /** 等待已接受 checkpoint 时 flush 返回/抛出的原始对象。 */
  checkpointError: unknown;
}

/**
 * 一次保存后换出的事实。`status` 只描述本次淘汰尝试，不改变已确认保存的
 * 成功/失败；sample 是有界诊断键，不是完整换代清单。
 */
export interface PostSaveEviction {
  status: 'evicted' | 'skipped' | 'failed';
  evictedSections: number;
  rejectedSections: number;
  capacity: string | null;
  /** Capacity target actually applied; null when the attempt failed before it. */
  target: { sections?: number; bytes?: number } | null;
  sample: SectionKey[];
  error?: unknown;
}

/** 一个附着同时保留 report 通道和取消通道；取消后仍保留 receiver 完成本次同步派发。 */
interface Attachment {
  token: number;
  receiver: (report: ChangeReport) => void;
  cancel: () => void;
  protectedSections?: readonly SectionKey[];
  /** 已调用过 cancel；重复生命周期信号不再重复取消。 */
  cancelled: boolean;
}

/** 取消失败保留原始抛出对象（包括 null 之类的非 Error 值）。 */
interface CancelFailure {
  error: unknown;
}

/** 已接受但尚未写入的原始证据；generation/session/dim 用来拒绝迟到或跨作用域的应用。 */
interface PendingHandoff {
  observation: Observation;
  /** 原始 JSON UTF8 字节数；入队时计算一次。 */
  bytes: number;
  generation: number;
  sessionId: string;
  dim: string;
}

/** 一次真实写入的结果；accepted 只由 observeBatch 成功返回决定。 */
interface ObservedBatch {
  accepted: boolean;
  report: ChangeReport;
}

/** 把一次合法视锥观测映射成库的 Observation。 */
function toObservation(b: BlockObservation): Observation {
  const properties = Object.fromEntries(Object.entries(b.properties ?? {}).map(([k, v]) => [k, String(v)]));
  return {
    worldId: b.worldId, dim: b.dimension, sessionId: b.sessionId,
    observedAt: b.observedAt, sequence: b.observationId,
    source: 'vision', evidence: 'seen', stateComplete: b.stateComplete === true,
    state: { name: b.name, properties }, pos: { ...b.pos },
  };
}

/** 每个坐标都按 floor(blockCoord / 16) 归入 Section。 */
function sectionKeyOf(observation: Observation): SectionKey {
  return {
    worldId: observation.worldId,
    dim: observation.dim,
    cx: Math.floor(observation.pos.x / 16),
    cz: Math.floor(observation.pos.z / 16),
    sy: Math.floor(observation.pos.y / 16),
  };
}

/** 本地稳定的 SectionKey 身份表示；不依赖包的私有序列化导出。 */
function sectionKeyId(key: SectionKey): string {
  return JSON.stringify([key.worldId, key.dim, key.cx, key.cz, key.sy]);
}

interface ObservationFields {
  keys: SectionKey[];
  /** 本批不同 Section 的完整数量；keys 最多保留 MAX_DIAGNOSTIC_KEYS 个。 */
  keyCount: number;
  count: number;
  observedAtMin: number | null;
  observedAtMax: number | null;
}

function observationFields(observations: readonly Observation[]): ObservationFields {
  const keys: SectionKey[] = [];
  const seen = new Set<string>();
  let keyCount = 0;
  let observedAtMin: number | null = null;
  let observedAtMax: number | null = null;
  for (const observation of observations) {
    const key = sectionKeyOf(observation);
    const id = sectionKeyId(key);
    if (!seen.has(id)) {
      seen.add(id);
      keyCount += 1;
      if (keys.length < MAX_DIAGNOSTIC_KEYS) keys.push(key);
    }
    observedAtMin = observedAtMin === null ? observation.observedAt : Math.min(observedAtMin, observation.observedAt);
    observedAtMax = observedAtMax === null ? observation.observedAt : Math.max(observedAtMax, observation.observedAt);
  }
  return { keys, keyCount, count: observations.length, observedAtMin, observedAtMax };
}

/**
 * 诊断消息按 UTF8 字节有界；键截断与消息截断都留下明确数量事实。
 * 按码点截断，避免把代理对切成半个字符。
 */
function boundedDiagnosticMessage(message: string, keys: number, keyCount: number): string {
  const keyFact = keyCount > keys ? ` [keys ${keys}/${keyCount}]` : '';
  const full = `${message}${keyFact}`;
  if (Buffer.byteLength(full, 'utf8') <= MAX_DIAGNOSTIC_MESSAGE_BYTES) return full;
  const suffixBytes = 64;
  const budget = MAX_DIAGNOSTIC_MESSAGE_BYTES - suffixBytes;
  let keptBytes = 0;
  let kept = '';
  for (const char of full) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (keptBytes + charBytes > budget) break;
    keptBytes += charBytes;
    kept += char;
  }
  return `${kept}…[truncated ${Buffer.byteLength(full, 'utf8') - keptBytes} bytes]`;
}

function gapFor(kind: SharedSpatialGapKind, observations: readonly Observation[], message: string): SharedSpatialGap {
  const fields = observationFields(observations);
  return {
    kind,
    message: boundedDiagnosticMessage(message, fields.keys.length, fields.keyCount),
    keys: fields.keys,
    count: fields.count,
    observedAtMin: fields.observedAtMin,
    observedAtMax: fields.observedAtMax,
  };
}

/** 原始载荷按 JSON UTF8 计字节；队列预算与库内驻留字节估算无关。 */
function utf8JsonBytes(observation: Observation): number {
  return Buffer.byteLength(JSON.stringify(observation), 'utf8');
}

function uniqueKeys(groups: readonly (readonly SectionKey[])[]): SectionKey[] {
  const seen = new Set<string>();
  const keys: SectionKey[] = [];
  for (const group of groups) {
    for (const key of group) {
      const id = sectionKeyId(key);
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(key);
    }
  }
  return keys;
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** manual 写入容量拒绝是库内普通 Error；按消息里的上限名归类，不猜私有字节。 */
function capacityKindOf(error: unknown): 'count_capacity' | 'byte_capacity' | 'capacity' | null {
  if (error instanceof PersistenceError && error.kind === 'capacity') return 'capacity';
  if (!(error instanceof Error)) return null;
  if (error.message.includes('maxResidentSections')) return 'count_capacity';
  if (error.message.includes('maxResidentBytes')) return 'byte_capacity';
  return null;
}

function capacityGapKind(kind: CapacityGapKind): SharedSpatialGapKind {
  if (kind === 'count_capacity' || kind === 'byte_capacity') return kind;
  return 'capacity';
}

/** 把库的公开淘汰结果压成有界事实，保留 pinned/dirty/not_committed 数量。 */
function freeSummary(result: FreeResult): string {
  const pinned = result.evictionRejected.filter((entry) => entry.reason === 'pinned').length;
  const dirty = result.evictionRejected.filter((entry) => entry.reason === 'dirty').length;
  const notCommitted = result.evictionRejected.filter((entry) => entry.reason === 'not_committed').length;
  return `free evicted ${result.evicted.length} section(s); rejected ${pinned} pinned/${dirty} dirty/${notCommitted} not_committed`;
}

export class SharedSpatialSession {
  readonly worldId: string;
  readonly databasePath: string;
  /** 公开的组合会话；宿主通过它做只读查询（cellAt 等）。 */
  readonly session: SpatialSession;

  private scope: TrustedScope | null = null;
  /** 可信 ready beginSession 之后才允许接收观测；interrupt 会挂起直到下一次 ready beginSession。 */
  private admitted = false;
  private pausedFlag = false;
  private closingFlag = false;
  private attachment: Attachment | null = null;
  private nextToken = 1;
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private readonly operationTimeoutMs: number;
  private readonly coordinator: WorkingSetCoordinator | null;
  private readonly diagnostic: ((diagnostic: SharedSpatialDiagnostic) => void) | undefined;
  /** 唯一查询端口：只读组合 session 的 voxel/history/topology，不暴露写入方法。 */
  private readonly queryPort: SpatialQueryPort;
  /** 启动时读取一次的能力报告（契约 §2.3/§13.1）；只读，不在运行中重新协商。 */
  private readonly capabilityReport: HostCapabilityReport;

  /** 已接受的原始 handoff，按到达顺序；最多 MAX_PENDING_OBSERVATIONS 条。 */
  private pending: PendingHandoff[] = [];
  /** interrupt/pause/新作用域递增；迟到 load 只有同代 handoff 才能写入。 */
  private pendingGeneration = 0;
  /** 唯一一个已开始、尚未结算的有限加载任务；结束后不自动重跑。 */
  private loadTask: Promise<void> | null = null;
  /** 上次真实加载以容量/未就绪/忙碌/硬失败停下；新证据或显式 drain 才再试一次。 */
  private loadBlocked = false;
  /** 容量失败后的重试时间下限；pending 保留，仅限制自动重试频率。 */
  private loadRetryNotBefore = 0;
  private lastGap: SharedSpatialGap | null = null;
  private discarded: SharedSpatialDiscarded | null = null;
  /** 已丢弃批次的累计不同 Section 数；用于保留“已存键/总数”事实。 */
  private discardedKeyCount = 0;
  /** 异步加载/派发路径保留的原始错误；不静默吞掉，也不改写成排队成功。 */
  private loadFailure: unknown | null = null;
  private loadFailureGeneration = -1;
  /** 可选诊断回调自身抛出的原始错误；只保留第一份，绝不阻断 close/lease finally。 */
  private diagnosticFailure: unknown | null = null;
  private diagnosticFailureGeneration = -1;
  /** cancel 回调自身抛出的原始错误；保留对象身份，由各生命周期路径暴露。 */
  private cancelFailure: unknown | null = null;
  private cancelFailureGeneration = -1;
  /** 当前附着的 receiver 回调失败；applied 说明写入是否已经发生。 */
  private receiverFailure: SharedSpatialReceiverFailure | null = null;
  /** 最近一次报告转发失败；写入已经提交（契约 §8.1 规则 6）。 */
  private deliveryFailure: { committed: true; error: unknown } | null = null;
  /** 最近一次因库能力为 false 而未调用的写方法；`null` 表示没有拒绝过。 */
  private capabilityRejection: SharedSpatialWriteRejection | null = null;
  /** 最近一次保存后换出的事实；只描述换出，不改写已确认保存。 */
  private lastEviction: PostSaveEviction | null = null;

  private constructor(
    session: SpatialSession,
    worldId: string,
    databasePath: string,
    operationTimeoutMs: number,
    diagnostic: ((diagnostic: SharedSpatialDiagnostic) => void) | undefined,
    now: () => number,
  ) {
    this.session = session;
    this.worldId = worldId;
    this.databasePath = databasePath;
    this.operationTimeoutMs = operationTimeoutMs;
    this.diagnostic = diagnostic;
    this.coordinator = session.voxelLoading === 'manual' ? new WorkingSetCoordinator(session) : null;
    // 生产查询组合只需要体素与 fact 域：语义查询读 facts，容器内容仍由宿主精确
    // ledger 负责。旧 Fragment/Topology 不参与查询，也不为构造查询而实例化占位对象。
    this.queryPort = createVoxelFactsQueryPort({
      worldId,
      voxel: session.voxel,
      facts: session.facts,
      query: { now },
    });
    // 契约 §13.1：启动时读取能力报告并留下契约版本；读取失败就是启动失败。
    this.capabilityReport = readHostCapabilities(this);
  }

  /** 启动时已读取的库能力报告（契约 §2.3）；宿主组合的持久化生命周期单独列出。 */
  capabilities(): HostCapabilityReport {
    return this.capabilityReport;
  }

  static async open(options: SharedSpatialOpenOptions): Promise<SharedSpatialSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 同一个时钟供体素中断边界与查询信封使用；测试可注入固定时钟。
    const now = options.now ?? Date.now;
    const session = await openSpatialSession({
      worldId: options.worldId,
      databasePath: options.databasePath,
      voxelOptions: { now, validityWindowMs: options.voxelValidityWindowMs ?? config.spatial.voxelValidityWindowMs },
      ...(options.voxelLoading === undefined ? {} : { voxelLoading: options.voxelLoading }),
      ...(options.residencyLimits === undefined ? {} : { residencyLimits: options.residencyLimits }),
      ...(options.voxelBatchMaxBytes === undefined ? {} : { voxelBatchMaxBytes: options.voxelBatchMaxBytes }),
      timeoutMs,
      snapshotLimits: options.snapshotLimits,
    });
    return new SharedSpatialSession(
      session,
      options.worldId,
      options.databasePath,
      timeoutMs,
      options.onWorkingSetDiagnostic,
      now,
    );
  }

  /**
   * 只读查询委托（契约 §5.1）：不观察、不移动、不加载 Section、不刷新证据时间、
   * 不写库、不 pin/保存。所有事实都来自 session 已经拥有的内存存储。
   *
   * 请求在这里只做一次类型化：库的 `SpatialQueryPort` 是运行期 schema 的拥有者，
   * 未知 kind/字段与越界值都由它返回结构化 `invalid_request`。
   */
  query(request: unknown): SpatialQueryResult {
    return this.queryPort.query(request as SpatialQueryRequest);
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /**
   * 可信 ready 准入：只有 adapter 真实 ready 的 beginSession 之后为 true，任何
   * interrupt 之后为 false。与 paused 无关（暂停不会撤销准入，也不代表已准入）。
   * 生命周期观察者据此决定是否还需要把“已知道的未就绪边界”交给服务。
   */
  get observationAdmitted(): boolean {
    return this.admitted;
  }

  get closing(): boolean {
    return this.closingFlag;
  }

  /**
   * 开始（或切换到）一个就绪观察会话，作用域来自 adapter 真实状态。外部世界或
   * dim='unknown' 是显式失败；同一世界的新 session 先取消旧委托（即使 map/report
   * 为空），再由库的 beginSession 把旧 session 证据跨维度置 STALE；同一 session
   * 换维则先取消旧委托并使旧维度失效。旧附着的 receiver 仍同步收到本次生命周期
   * 报告，随后才解除；取消抛错在完成 gating/stale 后原样抛给调用者。
   *
   * 作用域变化同时丢弃旧 scope 下尚未应用的 handoff；迟到的 load 不能把它们
   * 当作新 scope 的当前证据重新提交。
   */
  beginSession(scope: TrustedScope): ChangeReport {
    if (!this.allowed('memory', 'beginSession')) {
      this.recordCapabilityRejection('beginSession');
      throw new PersistenceError('invalid_argument', 'library reports memory.beginSession=false; the host does not call it');
    }
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; beginSession is rejected');
    }
    if (scope.worldId !== this.worldId) {
      throw new PersistenceError('invalid_argument', `foreign world "${scope.worldId}" does not match shared session worldId "${this.worldId}"`);
    }
    if (scope.dim === 'unknown') {
      throw new PersistenceError('invalid_argument', 'trusted scope dim is not ready ("unknown")');
    }
    const prev = this.scope;
    const sessionChanged = prev === null || prev.sessionId !== scope.sessionId;
    const dimChanged = prev !== null && prev.dim !== scope.dim;
    if (sessionChanged || dimChanged) this.invalidatePending('scope');
    const revoked = sessionChanged || dimChanged ? this.revokeCurrent() : null;
    let report = this.session.voxel.beginSession(scope.sessionId);
    if (dimChanged) {
      const stale = this.staleReport(prev!.dim);
      report = { sections: [...report.sections, ...(stale.status === 'written' ? stale.report.sections : [])] };
    }
    this.scope = scope;
    this.admitted = true;
    this.deliverLifecycle(report, revoked);
    if (revoked !== null && revoked.failure !== null) throw revoked.failure.error;
    return report;
  }

  /**
   * 断开/死亡/未就绪：取消活动委托，挂起观测准入，再把最后有效维度置 STALE 并
   * 派发真实报告（即使报告为空也照常派发给保留的旧 receiver）。只有下一次可信
   * ready beginSession 才重新准入观测。旧 scope 的未应用 handoff 同步作废。
   */
  interrupt(): ChangeReport {
    if (this.closingFlag) return { sections: [] };
    this.invalidatePending('interrupt');
    const revoked = this.revokeCurrent();
    this.admitted = false;
    const stale = this.scope === null ? null : this.staleReport(this.scope.dim);
    const report = stale?.status === 'written' ? stale.report : { sections: [] };
    this.deliverLifecycle(report, revoked);
    if (revoked !== null && revoked.failure !== null) throw revoked.failure.error;
    return report;
  }

  /**
   * 接受 Curio 感知的 typed 观测。暂停、interrupt 后未重新 beginSession、或作用域
   * 不匹配（旧 session / 其他维度 / 外部世界）时挂起写入；时间戳更晚也不能让
   * 被中断作用域的旧证据复活。
   *
   * eager 模式保持原有同步单批写入并原样返回/派发报告；manual 模式先写 resident
   * 支持，再处理 no_record 首观测，最后才把 saved 未驻留的原始载荷交给有界后台。
   * 因此缺失后台永远不会延迟 resident 支持失效的报告。
   */
  observe(observations: readonly BlockObservation[]): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; observations are rejected');
    }
    const scope = this.scope;
    if (this.pausedFlag || !this.admitted || scope === null) return { sections: [] };
    const scoped = observations.filter(
      (b) => b.worldId === this.worldId && b.sessionId === scope.sessionId && b.dimension === scope.dim,
    );
    if (scoped.length === 0) return { sections: [] };
    const converted = scoped.map(toObservation);
    return this.applyObservations(converted);
  }

  /**
   * 当前站位的本地重扫：脚/头/脚下支撑是身体直接接触到的实时事实，不是远处视野。
   * 只更新这三格的新鲜证据，不把历史格子删掉，也不改变 Agent 的目标或路线。
   */
  observeLocalStance(input: LocalStanceObservation): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; observations are rejected');
    }
    const scope = this.scope;
    if (this.pausedFlag || !this.admitted || scope === null) return { sections: [] };
    if (input.dim !== scope.dim || input.sessionId !== scope.sessionId) return { sections: [] };
    const observations: Observation[] = input.cells.flatMap((cell) => cell.name
      ? [{
          worldId: this.worldId, dim: scope.dim, sessionId: scope.sessionId,
          pos: { ...cell.pos },
          state: { name: cell.name, properties: Object.fromEntries(Object.entries(cell.properties ?? {}).map(([k, v]) => [k, String(v)])) },
          stateComplete: cell.stateComplete, evidence: 'seen', source: 'local_rescan',
          observedAt: input.observedAt, originObservationId: input.sequence, sequence: input.sequence,
        }]
      : []);
    return observations.length === 0 ? { sections: [] } : this.applyObservations(observations);
  }

  private applyObservations(converted: readonly Observation[]): ChangeReport {
    if (!this.allowed('memory', 'observeBatch')) {
      // 能力 false 不调用库；拒绝留在可见缺口，不伪造空报告为“已写入”。
      this.recordGap('observe_failed', converted, 'library reports memory.observeBatch=false; the host does not call it');
      return { sections: [] };
    }
    if (this.coordinator === null) {
      return this.dispatch(
        this.session.voxel.observeBatch({ observations: [...converted], unobserved: [] }),
        converted.length,
      );
    }
    return this.observeManual(converted);
  }

  /** 契约 §4.1 `observeBatch`；admission/pause/作用域与 `observe` 同一套门禁。 */
  observeBatch(batch: ObservationBatch): BatchChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; observations are rejected');
    }
    if (!this.allowed('memory', 'observeBatch')) {
      this.recordCapabilityRejection('observeBatch');
      return { sections: [], gaps: batch.unobserved };
    }
    const scope = this.scope;
    if (this.pausedFlag || !this.admitted || scope === null) return { sections: [], gaps: [] };
    const report: BatchChangeReport = this.session.voxel.observeBatch({
      observations: batch.observations.filter(
        (o) => o.worldId === this.worldId && o.sessionId === scope.sessionId && o.dim === scope.dim,
      ),
      // gap 只有坐标与原因，没有 world/dim，无法按作用域过滤；原样交给库作为诊断。
      unobserved: batch.unobserved,
    });
    this.dispatch(report, report.sections.length);
    return report;
  }

  /**
   * 实测站位的共享会话包装。只接受当前可信维度；能力 false、未准入、暂停或关停
   * 时不调用库、也不回退到更宽的旧后端。
   */
  markTraversed(dim: string, pos: Vec3Like): SharedSpatialWriteResult {
    const rejection = this.writeRejection(dim, 'markTraversed');
    return rejection === null
      ? this.deliverApplied(this.session.voxel.markTraversed(dim, pos), 1)
      : { status: 'rejected', reason: rejection };
  }

  /** 已确认自身动作修改的格；`actionId` 必填，未确认的动作不得调用。 */
  markModified(dim: string, pos: Vec3Like, actionId: string): SharedSpatialWriteResult {
    const rejection = this.writeRejection(dim, 'markModified');
    return rejection === null
      ? this.deliverApplied(this.session.voxel.markModified(dim, pos, actionId), 1)
      : { status: 'rejected', reason: rejection };
  }

  /** 外部显式 markStale；返回报告并转发给活跃执行器。 */
  markStale(dim: string, reason: StaleReason): SharedSpatialWriteResult {
    const rejection = this.writeRejection(dim, 'markStale');
    return rejection === null
      ? this.deliverApplied(this.session.voxel.markStale(dim, reason), 0)
      : { status: 'rejected', reason: rejection };
  }

  /**
   * 挂起/恢复空间写入（Arbiter.setPaused 直接调用）。暂停与恢复都记录中断边界；
   * 暂停会在报告为空/无更多身体帧时也取消当前委托，并作废未应用的旧 handoff。
   */
  setPaused(paused: boolean): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; setPaused is rejected');
    }
    if (paused === this.pausedFlag) return { sections: [] };
    const revoked = paused ? this.revokeCurrent() : null;
    if (paused) this.invalidatePending('pause');
    this.pausedFlag = paused;
    const stale = this.scope === null ? null : this.staleReport(this.scope.dim);
    const report = stale?.status === 'written' ? stale.report : { sections: [] };
    this.deliverLifecycle(report, revoked);
    if (revoked !== null && revoked.failure !== null) throw revoked.failure.error;
    return report;
  }

  /**
   * 绑定当前唯一的步行委托附着，返回 token 用于后续解除。暂停、interrupt 后未重新
   * ready、或尚未 beginSession 时拒绝新的活动委托；替换已有 owner 前先取消它。
   */
  attach(attachment: WalkAttachment): number {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; attachment is rejected');
    }
    if (!this.admitted || this.pausedFlag || this.scope === null) {
      throw new PersistenceError('invalid_argument', 'shared spatial session is not accepting a delegation while paused or not ready');
    }
    const revoked = this.revokeCurrent();
    if (revoked !== null) {
      if (this.attachment === revoked.attachment) this.attachment = null;
      if (revoked.failure !== null) throw revoked.failure.error;
    }
    const token = this.nextToken++;
    this.attachment = {
      token,
      receiver: attachment.receiver,
      cancel: attachment.cancel,
      protectedSections: attachment.protectedSections,
      cancelled: false,
    };
    return token;
  }

  /** 按 token 解除附着；旧 token 无法解除新附着。 */
  detach(token: number): void {
    if (this.attachment !== null && this.attachment.token === token) this.attachment = null;
  }

  /** 显式准备调用者给出的 sections（manual 模式）；eager 模式拒绝。 */
  prepare(keys: readonly SectionKey[], options: WorkingSetPrepareOptions = {}): Promise<WorkingSetPrepareOutcome> {
    if (this.coordinator === null) {
      return Promise.reject(new PersistenceError('invalid_argument', 'working-set prepare requires manual voxel loading'));
    }
    if (this.closingFlag) {
      return Promise.reject(new PersistenceError('closing', 'shared spatial session is closing; working-set prepare is rejected'));
    }
    return this.coordinator.prepare(keys, options);
  }

  /** 精确释放本服务发出的 lease token；未知 token 是 no-op。 */
  release(token: string): void {
    this.coordinator?.release(token);
  }

  /** 有界只读工作集快照（manual 模式）；不加载、不淘汰、不保存。 */
  workingSetStats(): WorkingSetStats {
    if (this.coordinator === null) {
      throw new PersistenceError('invalid_argument', 'working-set stats require manual voxel loading');
    }
    return this.coordinator.stats();
  }

  /** 只读待处理 handoff 快照；不触发加载。 */
  pendingObservations(): SharedSpatialPendingInfo {
    const fields = observationFields(this.pending.map((record) => record.observation));
    return {
      observations: fields.count,
      bytes: this.pendingBytes(),
      countLimit: MAX_PENDING_OBSERVATIONS,
      byteLimit: MAX_PENDING_OBSERVATION_BYTES,
      sections: fields.keys,
      observedAtMin: fields.observedAtMin,
      observedAtMax: fields.observedAtMax,
      loading: this.loadTask !== null,
    };
  }

  /** 最近一次被 interrupt/pause/新作用域丢弃的 handoff；没有则为 null。 */
  discardedObservations(): SharedSpatialDiscarded | null {
    return this.discarded;
  }

  /** 最近一次可见的容量/未就绪/队列缺口；没有则为 null。 */
  observationGap(): SharedSpatialGap | null {
    return this.lastGap;
  }

  /** 当前离线代最近一次真实加载失败；成功或作用域变化后不再报告旧错误。 */
  lastLoadFailure(): unknown | null {
    return this.loadFailureGeneration === this.pendingGeneration ? this.loadFailure : null;
  }

  /** 可选诊断回调在当前代抛出的原始失败；作用域变化后不再报告。 */
  lastDiagnosticFailure(): unknown | null {
    return this.diagnosticFailureGeneration === this.pendingGeneration ? this.diagnosticFailure : null;
  }

  /** 当前代 cancel 回调抛出的原始对象；没有失败或已换代时为 null。 */
  lastCancelFailure(): unknown | null {
    return this.cancelFailureGeneration === this.pendingGeneration ? this.cancelFailure : null;
  }

  /** 当前附着的 receiver 回调失败；`applied` 明确写入是否已经发生。 */
  lastReceiverFailure(): SharedSpatialReceiverFailure | null {
    return this.receiverFailure;
  }

  /**
   * 最近一次报告转发失败；`committed:true` 表示写入已提交（契约 §8.1 规则 6），
   * 调用者不得把它当成观测被拒绝而重试写入。覆盖 observeBatch/beginSession/
   * interrupt 与保留的体素写（markTraversed/markModified/markStale）。
   */
  lastDeliveryFailure(): { committed: true; error: unknown } | null {
    return this.deliveryFailure;
  }

  /** 最近一次因库能力 false 而拒绝调用的写方法（B1 门禁的可观察事实）。 */
  lastCapabilityRejection(): SharedSpatialWriteRejection | null {
    return this.capabilityRejection;
  }

  /**
   * 显式等待本服务已接受的真实 handoff 与已接受 checkpoint 结算。加载由本服务
   * 唯一的跟踪循环完成；checkpoint 只用公开 flush 等待，不产生新保存。调用方
   * signal/deadline 只结束等待，不把残留工作改写成成功，也不不断轮询空转。
   */
  drainObservations(options: SharedSpatialDrainOptions = {}): Promise<SharedSpatialDrainResult> {
    const { signal, deadline } = options;
    const now = Date.now();
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline - now > MAX_DEADLINE_DELAY_MS)) {
      return Promise.reject(new PersistenceError(
        'invalid_argument',
        `deadline must be a finite absolute epoch-millisecond value no more than ${MAX_DEADLINE_DELAY_MS} ms ahead`,
      ));
    }
    if (this.coordinator === null) {
      return Promise.resolve({
        cancelled: false, reason: null, pending: this.pendingObservations(), gap: this.lastGap, checkpointError: null,
      });
    }
    if (signal?.aborted === true) {
      return Promise.resolve({
        cancelled: true, reason: 'aborted', pending: this.pendingObservations(), gap: this.lastGap, checkpointError: null,
      });
    }
    if (this.closingFlag) {
      return Promise.resolve({
        cancelled: true, reason: 'closing', pending: this.pendingObservations(), gap: this.lastGap, checkpointError: null,
      });
    }
    if (deadline !== undefined && now >= deadline) {
      return Promise.resolve({
        cancelled: true, reason: 'deadline', pending: this.pendingObservations(), gap: this.lastGap, checkpointError: null,
      });
    }
    return this.doDrain(signal, deadline);
  }

  /** 关停开始后同步拒绝新的公开保存；已接受的保存仍可完成，内部最终保存另行执行。 */
  async checkpoint(): Promise<SpatialCheckpointResult> {
    if (this.closingFlag) {
      throw new PersistenceError('closing', 'shared spatial session is closing; checkpoint is rejected');
    }
    const result = await this.session.checkpoint();
    // 保存确认后淘汰已提交、非 pinned/dirty 的冷 Section；保存成功不因换出结果改写。
    if (!this.closingFlag && this.coordinator !== null) {
      const free = this.freeOnce();
      this.lastEviction = free.kind === 'result'
        ? {
            status: free.result.evicted.length > 0 ? 'evicted' : 'skipped',
            evictedSections: free.result.evicted.length,
            rejectedSections: free.result.evictionRejected.length,
            capacity: free.result.capacity?.kind ?? null,
            target: this.coordinator.lastFreeTarget(),
            sample: free.result.evicted.slice(0, 8).map((key) => ({ ...key })),
          }
        : {
            status: 'failed',
            evictedSections: 0,
            rejectedSections: 0,
            capacity: null,
            target: null,
            sample: [],
            error: free.error,
          };
    }
    return result;
  }

  /** 最近一次保存后换出的事实；eager 或尚未保存时为 null。只读，不触发换出。 */
  lastPostSaveEviction(): PostSaveEviction | null {
    return this.lastEviction;
  }

  getPersistenceState(): SpatialPersistenceState {
    return this.session.getPersistenceState();
  }

  /**
   * 关停：同步拒绝新写入/附着/公开保存并取消活动委托，封住工作集新批次，等待
   * 已开始的 manager 工作（有界），应用现已驻留且仍有效的原始证据，然后把仍
   * 未处理的 handoff 计入 error，再做最终 checkpoint 与真实 close。主保存错误、
   * 取消错误与次关闭错误/结果分别保留原始对象；幂等共享同一 promise。
   */
  shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.closingFlag = true;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<ShutdownResult> {
    const revoked = this.revokeCurrent();
    if (revoked !== null && this.attachment === revoked.attachment) this.attachment = null;
    const cancelError = revoked !== null && revoked.failure !== null ? revoked.failure.error : null;

    // 主错误只保留第一次真实失败；后续 pending/cancel/close 错误各自单独报告。
    let error: unknown = null;
    const capture = (candidate: unknown): void => {
      if (error === null) error = candidate;
    };
    let checkpoint: SpatialCheckpointResult | null = null;
    let close: CloseResult | null = null;
    let closeError: unknown = null;

    try {
      // 封住新批次；只等待已经开始的 manager 工作，超时/拒绝都不能当成成功。
      if (this.coordinator !== null) {
        try {
          const settlement = this.coordinator.beginClose();
          const waited = await this.waitWithin(settlement, this.operationTimeoutMs);
          if (!waited.settled) {
            capture(new PersistenceError(
              'timeout',
              `working-set settlement did not complete within ${this.operationTimeoutMs} ms; final checkpoint and close were still attempted`,
            ));
          } else if (waited.error !== null) {
            capture(waited.error);
          }
        } catch (err) {
          capture(err);
        }
        try {
          this.applyReadyPending();
        } catch (err) {
          capture(err);
        }
      }

      // 等待已接受的保存；flush 只等待已接受 I/O，不产生新保存。
      try {
        const flushed = await this.session.flush();
        if (flushed.error !== null) capture(flushed.error);
      } catch (err) {
        capture(err);
      }

      // 捕获最终 checkpoint；分片保存时在同一关停期限内提交后续批次，直到 clean
      // 或达到有界批数。最后一批的版本可能低于已确认的最大版本，最终以 state 核对。
      try {
        // All final batches share one absolute shutdown window. A batch never
        // gets a fresh per-request timeout that could extend the total drain.
        const finalDeadline = Date.now() + this.operationTimeoutMs;
        checkpoint = await this.session.checkpoint({ deadlineMs: finalDeadline });
        let state = this.session.getPersistenceState();
        for (
          let batch = 1;
          batch < MAX_FINAL_CHECKPOINT_BATCHES && state.dirty && Date.now() < finalDeadline;
          batch++
        ) {
          checkpoint = await this.session.checkpoint({ deadlineMs: finalDeadline });
          state = this.session.getPersistenceState();
        }
        const expired = Date.now() >= finalDeadline;
        if (
          state.dirty ||
          state.lastConfirmedCheckpointId !== checkpoint.checkpointId ||
          state.voxelRevision !== state.confirmedVoxelRevision ||
          state.journalRevision !== state.confirmedJournalRevision ||
          state.ledgerRevision !== state.confirmedLedgerRevision ||
          state.factsRevision !== state.confirmedFactsRevision
        ) {
          capture(new PersistenceError(
            expired && state.dirty ? 'timeout' : 'data',
            expired && state.dirty
              ? 'final checkpoint window expired with remaining dirty state; confirmed batches are preserved'
              : 'final checkpoint did not confirm clean state',
          ));
        }
      } catch (err) {
        capture(err);
      }

      // 仍未处理的 handoff 是真实缺口：保留原始条数与观测时间范围，绝不声称已保存。
      const pending = this.pendingObservations();
      if (pending.observations > 0) {
        const range = pending.observedAtMin === null
          ? ''
          : ` (observedAt ${pending.observedAtMin}..${pending.observedAtMax})`;
        capture(new PersistenceError(
          'data',
          `shutdown left ${pending.observations} pending observation(s) unapplied${range}`,
        ));
      }
    } catch (err) {
      capture(err);
    } finally {
      // 无论等待/应用/receiver/diagnostic 如何失败，都必须尝试真实 close。
      try {
        close = await this.session.close();
      } catch (err) {
        closeError = err;
      }
    }

    return { checkpoint, error, cancelError, close, closeError };
  }

  /**
   * 有界等待一个永不改变会话事实的本地 promise；超时返回 settled=false，
   * 拒绝保留原始错误对象，绝不把未完成或失败改写成成功。
   */
  private waitWithin(
    promise: Promise<void>,
    ms: number,
  ): Promise<{ settled: boolean; error: unknown | null }> {
    return new Promise<{ settled: boolean; error: unknown | null }>((resolve) => {
      let done = false;
      const finish = (settled: boolean, error: unknown | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled, error });
      };
      const timer = setTimeout(() => finish(false, null), ms);
      timer.unref?.();
      promise.then(
        () => finish(true, null),
        (error: unknown) => {
          // 超时后迟到的真实失败仍保留身份；始终挂处理器，绝不上浮为未处理拒绝。
          this.setLoadFailure(error);
          finish(true, error);
        },
      );
    });
  }

  private async doDrain(signal: AbortSignal | undefined, deadline: number | undefined): Promise<SharedSpatialDrainResult> {
    const state: { reason: 'aborted' | 'deadline' | null } = { reason: null };
    let resolveCancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => { resolveCancelled = resolve; });
    const cancel = (reason: 'aborted' | 'deadline'): void => {
      if (state.reason !== null) return;
      state.reason = reason;
      resolveCancelled();
    };
    const onAbort = (): void => cancel('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadline !== undefined) {
      timer = setTimeout(
        () => cancel('deadline'),
        Math.min(Math.max(0, deadline - Date.now()), MAX_DEADLINE_DELAY_MS),
      );
      timer.unref?.();
    }

    let checkpointError: unknown = null;
    const flush = this.session.flush().then(
      (result) => {
        checkpointError = result.error;
      },
      (error: unknown) => {
        checkpointError = error;
      },
    );

    try {
      // 先等待已接受 checkpoint；取消/期限只结束等待，不伪造完成。
      await Promise.race([flush, cancelledPromise]);
      if (state.reason === null) {
        this.applyReadyPending();
        // 已有真实 load 在跟踪时只等这一批结算，不另起并发批次。
        if (this.loadTask !== null) {
          await Promise.race([this.loadTask, cancelledPromise]);
          this.applyReadyPending();
        }
        // 显式 drain 最多对上次容量/未就绪/忙碌结果再试一次；没有循环轮询。
        if (!this.closingFlag && state.reason === null && this.hasLoadablePending()) {
          this.loadBlocked = false;
          this.loadRetryNotBefore = 0;
          if (this.session.busy) {
            const current = this.pending.filter((record) => this.isCurrent(record));
            this.recordGap(
              'busy',
              current.map((record) => record.observation),
              `session is busy; ${current.length} pending observation(s) were not loaded by this drain`,
            );
            this.loadBlocked = true;
          } else {
            this.requestLoadAttempt();
            if (this.loadTask !== null) await Promise.race([this.loadTask, cancelledPromise]);
          }
        } else if (state.reason === null && this.reportNotReadyGap()) {
          this.loadBlocked = true;
        }
        if (this.pending.length === 0) this.clearLoadFailure();
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    }

    return {
      cancelled: state.reason !== null,
      reason: state.reason,
      pending: this.pendingObservations(),
      gap: this.lastGap,
      checkpointError,
    };
  }

  /** manual 观测分流：resident 同步写、no_record 单独首写、saved 未驻留有界排队。 */
  private observeManual(observations: readonly Observation[]): ChangeReport {
    const residency = new Map<string, SectionResidency>();
    const residencyOf = (key: SectionKey): SectionResidency => {
      const id = sectionKeyId(key);
      const cached = residency.get(id);
      if (cached !== undefined) return cached;
      const value = this.session.sectionResidency(key).residency;
      residency.set(id, value);
      return value;
    };

    const resident: Observation[] = [];
    const first: Observation[] = [];
    const deferred: Observation[] = [];
    for (const observation of observations) {
      const state = residencyOf(sectionKeyOf(observation));
      if (state === 'resident') resident.push(observation);
      else if (state === 'no_record') first.push(observation);
      else deferred.push(observation);
    }

    const reports: ChangeReport[] = [];
    // resident 支持失效必须先派发；后面 no_record 的容量拒绝不能回滚这次报告。
    if (resident.length > 0) {
      const applied = this.applyResident(resident);
      if (applied.accepted) {
        this.clearLoadFailure();
        reports.push(this.dispatch(applied.report, resident.length));
      }
    }
    if (first.length > 0) {
      const applied = this.applyFirstObservation(first);
      if (applied.accepted) {
        this.clearLoadFailure();
        reports.push(this.dispatch(applied.report, first.length));
      }
    }
    if (deferred.length > 0) this.enqueueHandoff(deferred);
    return { sections: reports.flatMap((report) => report.sections) };
  }

  /** resident 写入；字节增长超限时留下缺口并只取消受影响的当前 owner。 */
  private applyResident(observations: readonly Observation[]): ObservedBatch {
    try {
      return {
        accepted: true,
        report: this.session.voxel.observeBatch({ observations: [...observations], unobserved: [] }),
      };
    } catch (error) {
      if (error instanceof VoxelResidencyError) {
        this.recordGap('not_ready', observations, error.message);
        return { accepted: false, report: { sections: [] } };
      }
      const kind = capacityKindOf(error);
      if (kind === null) throw error;
      const gap = this.recordGap(kind, observations, messageOf(error));
      this.cancelOwnerFor(gap.keys);
      return { accepted: false, report: { sections: [] } };
    }
  }

  /**
   * no_record 是真实首次观测，不是已观察空气。若真实 count/byte 容量拒绝，
   * 只调用一次公开的有界 free，然后原样重交同一载荷一次；仍失败则留下缺口。
   */
  private applyFirstObservation(observations: readonly Observation[]): ObservedBatch {
    const batch = { observations: [...observations], unobserved: [] };
    try {
      return { accepted: true, report: this.session.voxel.observeBatch(batch) };
    } catch (error) {
      if (error instanceof VoxelResidencyError) {
        this.recordGap('not_ready', observations, error.message);
        return { accepted: false, report: { sections: [] } };
      }
      const kind = capacityKindOf(error);
      if (kind === null) throw error;
      const free = this.freeOnce();
      if (free.kind === 'error') {
        this.recordGap(kind, observations, `${messageOf(error)}; free refused: ${messageOf(free.error)}`);
        return { accepted: false, report: { sections: [] } };
      }
      const freeFact = freeSummary(free.result);
      try {
        return { accepted: true, report: this.session.voxel.observeBatch(batch) };
      } catch (retryError) {
        if (retryError instanceof VoxelResidencyError) {
          this.recordGap('not_ready', observations, `${retryError.message}; ${freeFact}`);
          return { accepted: false, report: { sections: [] } };
        }
        const retryKind = capacityKindOf(retryError);
        if (retryKind === null) throw retryError;
        this.recordGap(retryKind, observations, `${messageOf(retryError)}; ${freeFact}`);
        return { accepted: false, report: { sections: [] } };
      }
    }
  }

  /** 有界 free 一次：成功保留库的真实淘汰/拒绝字段，失败保留原始错误。 */
  private freeOnce(): { kind: 'result'; result: FreeResult } | { kind: 'error'; error: unknown } {
    if (this.coordinator === null) {
      return { kind: 'error', error: new PersistenceError('invalid_argument', 'manual working set is not enabled') };
    }
    try {
      return { kind: 'result', result: this.coordinator.free() };
    } catch (error) {
      return { kind: 'error', error };
    }
  }

  /** 只取消真正保护了受影响 Section 的当前 owner；无关任务不动。 */
  private cancelOwnerFor(keys: readonly SectionKey[]): void {
    const current = this.attachment;
    if (current === null || current.protectedSections === undefined) return;
    const affected = new Set(keys.map((key) => sectionKeyId(key)));
    if (!current.protectedSections.some((key) => affected.has(sectionKeyId(key)))) return;
    const revoked = this.revokeCurrent();
    if (this.attachment === revoked?.attachment) this.attachment = null;
  }

  private recordGap(kind: SharedSpatialGapKind, observations: readonly Observation[], message: string): SharedSpatialGap {
    const gap = gapFor(kind, observations, message);
    this.lastGap = gap;
    this.emitDiagnostic(gap);
    return gap;
  }

  /** 可选日志边界：回调失败只保留原始错误，不影响真实写入/lease/close。 */
  private emitDiagnostic(diagnostic: SharedSpatialDiagnostic): void {
    if (this.diagnostic === undefined) return;
    try {
      this.diagnostic(diagnostic);
    } catch (error) {
      if (this.diagnosticFailure === null) {
        this.diagnosticFailure = error;
        this.diagnosticFailureGeneration = this.pendingGeneration;
      }
    }
  }

  private recordDiscarded(
    reason: SharedSpatialDiscarded['reason'],
    observations: readonly Observation[],
  ): void {
    const fields = observationFields(observations);
    const next: SharedSpatialDiscarded = {
      kind: 'discarded',
      reason,
      message: boundedDiagnosticMessage(
        `discarded ${fields.count} pending observation(s) on ${reason}`,
        fields.keys.length,
        fields.keyCount,
      ),
      keys: fields.keys,
      count: fields.count,
      observedAtMin: fields.observedAtMin,
      observedAtMax: fields.observedAtMax,
    };
    this.discardedKeyCount += fields.keyCount;
    const prev = this.discarded;
    if (prev === null) {
      this.discarded = next;
    } else {
      // 只保留最新一条有界摘要 + 累计条数/时间范围；不拼接历史消息、不累积历史键。
      // keys 只存有界样本，消息里保留“已存键/累计键数”两个事实。
      const keys = uniqueKeys([prev.keys, next.keys]).slice(0, MAX_DIAGNOSTIC_KEYS);
      const count = prev.count + next.count;
      this.discarded = {
        kind: 'discarded',
        reason,
        message: boundedDiagnosticMessage(
          `discarded ${next.count} on ${reason}; cumulative ${count} observation(s)`,
          keys.length,
          this.discardedKeyCount,
        ),
        keys,
        count,
        observedAtMin: minNullable(prev.observedAtMin, next.observedAtMin),
        observedAtMax: maxNullable(prev.observedAtMax, next.observedAtMax),
      };
    }
    this.emitDiagnostic(next);
  }

  /** 作废所有尚未应用的旧 scope handoff；迟到 load 只会释放 lease，不会补写。 */
  private invalidatePending(reason: SharedSpatialDiscarded['reason']): void {
    this.pendingGeneration += 1;
    // 换代后旧失败不再描述当前作用域；访问器也会按代过滤。
    this.loadFailure = null;
    this.diagnosticFailure = null;
    this.cancelFailure = null;
    this.loadBlocked = false;
    if (this.pending.length === 0) return;
    const observations = this.pending.map((record) => record.observation);
    this.pending = [];
    this.recordDiscarded(reason, observations);
  }

  /**
   * 有界接收；预算按到达顺序严格截断：一旦某条超限，它和本批其后所有条目都
   * 被拒绝，后面的小载荷不能插队。拒绝事实进入可见 gap，包含已接受/拒绝条数。
   */
  private enqueueHandoff(observations: readonly Observation[]): void {
    const scope = this.scope;
    if (scope === null) return;
    let bytes = this.pendingBytes();
    let full = false;
    const accepted: PendingHandoff[] = [];
    const rejected: Observation[] = [];
    for (const observation of observations) {
      const size = utf8JsonBytes(observation);
      if (
        full
        || this.pending.length + accepted.length >= MAX_PENDING_OBSERVATIONS
        || bytes + size > MAX_PENDING_OBSERVATION_BYTES
      ) {
        full = true;
        rejected.push(observation);
        continue;
      }
      accepted.push({
        observation,
        bytes: size,
        generation: this.pendingGeneration,
        sessionId: scope.sessionId,
        dim: scope.dim,
      });
      bytes += size;
    }
    this.pending.push(...accepted);
    if (rejected.length > 0) {
      this.recordGap(
        'queue_full',
        rejected,
        `pending handoff budget exceeded (${MAX_PENDING_OBSERVATIONS} observations / ${MAX_PENDING_OBSERVATION_BYTES} bytes); accepted prefix ${accepted.length}, rejected ${rejected.length} observation(s)`,
      );
    }
    if (accepted.length > 0) {
      // 新证据允许一次有限尝试；若已有 load 在跑，等这一批结束后留待显式 drain/新证据。
      this.loadBlocked = false;
      this.requestLoadAttempt();
    }
  }

  private pendingBytes(): number {
    let bytes = 0;
    for (const record of this.pending) bytes += record.bytes;
    return bytes;
  }

  /** handoff 是否仍属于当前可信作用域且未被生命周期作废。 */
  private isCurrent(record: PendingHandoff): boolean {
    const scope = this.scope;
    return scope !== null
      && this.admitted
      && !this.pausedFlag
      && record.generation === this.pendingGeneration
      && record.sessionId === scope.sessionId
      && record.dim === scope.dim;
  }

  /**
   * 已有当前 scope、尚未应用、可直接写入的 resident/no_record handoff。
   * 只有 observeBatch 真正接受后才移除对应原始载荷；容量拒绝或未就绪重抛时
   * 保留原记录，绝不因为空变化报告而误判为已写入。
   */
  private applyReadyPending(): void {
    if (this.pending.length === 0) return;
    const residentRecords: PendingHandoff[] = [];
    const firstRecords: PendingHandoff[] = [];
    for (const record of this.pending) {
      if (!this.isCurrent(record)) continue;
      const residency = this.session.sectionResidency(sectionKeyOf(record.observation)).residency;
      if (residency === 'resident') residentRecords.push(record);
      else if (residency === 'no_record') firstRecords.push(record);
    }

    if (residentRecords.length > 0) {
      const applied = this.applyResident(residentRecords.map((record) => record.observation));
      if (applied.accepted) {
        // 先移除已应用记录：receiver 之后再抛错也只能算回调失败，不能回退证据。
        this.removePending(residentRecords);
        this.clearLoadFailure();
        this.dispatch(applied.report, residentRecords.length);
      }
    }
    if (firstRecords.length > 0) {
      const applied = this.applyFirstObservation(firstRecords.map((record) => record.observation));
      if (applied.accepted) {
        this.removePending(firstRecords);
        this.clearLoadFailure();
        this.dispatch(applied.report, firstRecords.length);
      }
    }
  }

  private removePending(records: readonly PendingHandoff[]): void {
    const remove = new Set(records);
    this.pending = this.pending.filter((record) => !remove.has(record));
  }

  private hasLoadablePending(): boolean {
    return this.pending.some(
      (record) => this.isCurrent(record) && this.session.sectionResidency(sectionKeyOf(record.observation)).residency === 'not_resident',
    );
  }

  /**
   * 启动本服务唯一一个有限加载尝试。已有任务在跑时不重跑，只等它结算；
   * 新证据或显式 drain 之后由调用者再次请求。
   */
  private requestLoadAttempt(): void {
    if (this.coordinator === null || this.closingFlag) return;
    if (this.loadTask !== null || this.loadBlocked) return;
    if (Date.now() < this.loadRetryNotBefore) return;
    if (!this.hasLoadablePending()) return;

    const task = this.runLoadAttempt();
    this.loadTask = task;
    task.then(
      () => {
        if (this.loadTask === task) this.loadTask = null;
      },
      (error: unknown) => {
        // 最后一道异步边界：保留原始错误，绝不产生未处理拒绝。
        if (this.loadTask === task) this.loadTask = null;
        this.loadBlocked = true;
        this.setLoadFailure(error);
        const current = this.currentObservations();
        if (current.length > 0) this.recordGap('observe_failed', current, messageOf(error));
      },
    );
  }

  private currentObservations(): Observation[] {
    return this.pending.filter((record) => this.isCurrent(record)).map((record) => record.observation);
  }

  /**
   * 一次有限加载：先应用已可写 handoff，再对 not_resident 的 saved sections
   * 发起至多一次真实 prepare。busy 立即留下 pending/gap 返回；成功后释放 lease
   * 并停止，不轮询、不因 settle 自动重跑。
   */
  private async runLoadAttempt(): Promise<void> {
    try {
      this.applyReadyPending();
      if (this.closingFlag) return;

      const loadable = this.pending.filter(
        (record) => this.isCurrent(record)
          && this.session.sectionResidency(sectionKeyOf(record.observation)).residency === 'not_resident',
      );
      if (loadable.length === 0) {
        if (this.reportNotReadyGap()) this.loadBlocked = true;
        return;
      }

      if (this.session.busy) {
        const current = this.currentObservations();
        this.recordGap(
          'busy',
          current,
          `session is busy; ${current.length} pending observation(s) were not loaded`,
        );
        this.loadBlocked = true;
        return;
      }

      const keys: SectionKey[] = [];
      const seen = new Set<string>();
      for (const record of loadable) {
        const key = sectionKeyOf(record.observation);
        const id = sectionKeyId(key);
        if (seen.has(id)) continue;
        seen.add(id);
        keys.push(key);
      }

      const outcome = await this.coordinator!.prepare(keys).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );

      const readyLease = outcome.kind === 'result' && outcome.result.status === 'ready'
        ? outcome.result.lease
        : null;
      if (readyLease !== null) {
        try {
          this.applyReadyPending();
        } finally {
          // ready lease 属于本次 prepare；即使 receiver/diagnostic/apply 抛错也必须释放。
          this.coordinator!.release(readyLease.token);
        }
        this.clearLoadFailure();
        return;
      }

      this.applyReadyPending();

      if (outcome.kind === 'error') {
        if (outcome.error instanceof PersistenceError && outcome.error.kind === 'closing') {
          // 关停取消同样必须留下可见事实，不能静默设置 loadBlocked。
          this.loadBlocked = true;
          this.recordGap(
            'prepare_cancelled',
            loadable.map((record) => record.observation),
            `working-set prepare was rejected by the closing gate; ${loadable.length} pending observation(s) were not loaded`,
          );
          return;
        }
        this.loadBlocked = true;
        this.setLoadFailure(outcome.error);
        const current = this.currentObservations();
        if (current.length === 0) return;
        if (outcome.error instanceof PersistenceError && outcome.error.kind === 'busy') {
          this.recordGap('busy', current, `session is busy; ${current.length} pending observation(s) were not loaded`);
        } else {
          this.recordGap('load_failed', current, messageOf(outcome.error));
        }
        return;
      }

      const result = outcome.result;
      if (result.status === 'cancelled') {
        // 取消不是成功：留下可见事实，保留 pending，等待新证据或显式 drain。
        this.loadBlocked = true;
        this.recordGap(
          'prepare_cancelled',
          loadable.map((record) => record.observation),
          `working-set prepare was cancelled (${result.reason}); ${loadable.length} pending observation(s) were not loaded`,
        );
        return;
      }
      if (this.closingFlag) return;
      if (result.status === 'ready') {
        this.coordinator!.release(result.lease.token);
        this.clearLoadFailure();
        return;
      }
      if (result.status === 'failed') {
        this.loadBlocked = true;
        const capacity = result.result.capacity;
        if (capacity !== null) this.loadRetryNotBefore = Date.now() + CAPACITY_RETRY_BACKOFF_MS;
        const kind = capacity === null ? 'load_failed' : capacityGapKind(capacity.kind);
        const current = this.currentObservations();
        if (current.length > 0) {
          this.recordGap(kind, current, capacity?.message ?? 'working-set prepare failed');
        }
        return;
      }

      // incomplete：已驻留部分已写入；其余保持 pending，等新证据/显式 drain。
      this.loadBlocked = true;
      const notReady = result.result.notReady;
      const remaining = this.pending.filter((record) => this.isCurrent(record)
        && notReady.some((key) => sectionKeyId(key) === sectionKeyId(sectionKeyOf(record.observation))));
      if (remaining.length === 0) return;
      const residencies = remaining.map(
        (record) => this.session.sectionResidency(sectionKeyOf(record.observation)).residency,
      );
      this.recordGap(
        residencies.includes('load_failed') ? 'load_failed' : 'not_ready',
        remaining.map((record) => record.observation),
        `working-set prepare left ${remaining.length} pending observation(s) not ready`,
      );
    } catch (error) {
      // 异步边界：保留原始错误并留下可见缺口；不再向下抛出造成未处理拒绝。
      this.setLoadFailure(error);
      this.loadBlocked = true;
      const current = this.currentObservations();
      if (current.length > 0) this.recordGap('observe_failed', current, messageOf(error));
    }
  }

  /** 无 loadable 但仍有 loading/load_failed 时留下准确缺口；返回是否记录。 */
  private reportNotReadyGap(): boolean {
    const current = this.pending.filter((record) => this.isCurrent(record));
    if (current.length === 0) return false;
    const residencies = current.map(
      (record) => this.session.sectionResidency(sectionKeyOf(record.observation)).residency,
    );
    if (residencies.every((residency) => residency === 'resident' || residency === 'no_record')) return false;
    this.recordGap(
      residencies.includes('load_failed') ? 'load_failed' : 'not_ready',
      current.map((record) => record.observation),
      `pending handoff is not loadable now (${residencies.includes('loading') ? 'loading' : 'not ready'})`,
    );
    return true;
  }

  /**
   * 同步把变化报告交给当前附着（无附着或空报告也照常派发）。
   * receiver 抛错只记录为回调失败，不推翻已经发生的写入，也不冒泡去打断物理帧；
   * `applied` 让调用者区分“写入后回调失败”和“未写入”。
   */
  private dispatch(report: ChangeReport, applied = 0): ChangeReport {
    this.dispatchError(report, applied);
    return report;
  }

  /**
   * 保留写入的统一门禁：能力 false 不调用（也不回退），关停/未准入/暂停拒绝，
   * 维度不是当前可信维度时拒绝——绝不按时间接近或请求推断写入。
   */
  private writeRejection(
    dim: string,
    method: MemoryWriteMethod,
  ): SharedSpatialWriteRejection | null {
    if (!this.allowed('memory', method)) {
      this.recordCapabilityRejection(method);
      return {
        kind: 'capability_unavailable', method,
        detail: `library reports memory.${method}=false; the host does not call it and does not fall back`,
      };
    }
    if (this.closingFlag) return { kind: 'closed', detail: 'shared spatial session is closing; history writes are rejected' };
    const scope = this.scope;
    if (this.pausedFlag || !this.admitted || scope === null) {
      return { kind: 'not_ready', detail: 'shared spatial session is paused, not admitted, or has no trusted scope' };
    }
    if (dim !== scope.dim) {
      return {
        kind: 'scope_mismatch',
        detail: `dimension "${dim}" is not the trusted dimension "${scope.dim}"`,
        expectedDim: scope.dim, actualDim: dim,
      };
    }
    return null;
  }

  /**
   * 生命周期 markStale 的唯一入口：beginSession（换维）/interrupt/setPaused 都走这里。
   * 能力 false 时不调用库，返回结构化 rejected 并记录 `lastCapabilityRejection()`；
   * 调用方不得把空报告当成已应用的 STALE。
   */
  private staleReport(dim: string): SharedSpatialWriteResult {
    if (!this.allowed('memory', 'markStale')) {
      this.recordCapabilityRejection('markStale');
      return {
        status: 'rejected',
        reason: {
          kind: 'capability_unavailable', method: 'markStale',
          detail: 'library reports memory.markStale=false; the lifecycle STALE boundary was not applied',
        },
      };
    }
    return { status: 'written', report: this.session.voxel.markStale(dim, 'observation_gap'), deliveryError: null };
  }

  /** 每���按启动时记录的那份报告读取能力位（测试可替换同一对象来模拟库答复）。 */
  private allowed(domain: CapabilityDomain, name: string): boolean {
    return capabilityGate(this.capabilityReport)(domain, name);
  }

  private recordCapabilityRejection(method: MemoryWriteCapability): void {
    this.capabilityRejection = {
      kind: 'capability_unavailable', method,
      detail: `library reports memory.${method}=false; the host does not call it and does not fall back`,
    };
  }

  /**
   * 写入已提交后同步转发报告。订阅者失败按 §8.1 规则 6 保留为 `committed:true`，
   * 不把已发生的写入改写成被拒绝。
   */
  private deliverApplied(report: ChangeReport, applied: number): SharedSpatialWriteResult {
    const deliveryError = this.dispatchError(report, applied);
    return { status: 'written', report, deliveryError };
  }

  /**
   * 同步派发并保留第一份回调失败；`null` 表示没有失败。写入已经提交，失败只属于
   * 报告转发（契约 §8.1 规则 6），调用者不得把它当成观测被拒绝而重试写入。
   */
  private dispatchError(report: ChangeReport, applied: number): { committed: true; error: unknown } | null {
    const attachment = this.attachment;
    if (attachment === null) return null;
    try {
      attachment.receiver(report);
      return null;
    } catch (error) {
      this.recordReceiverFailure(error, applied);
      this.deliveryFailure = { committed: true, error };
      return this.deliveryFailure;
    }
  }

  private recordReceiverFailure(error: unknown, applied: number): void {
    if (this.receiverFailure === null) this.receiverFailure = { error, applied };
  }

  private recordCancelFailure(error: unknown): void {
    if (this.cancelFailure === null) {
      this.cancelFailure = error;
      this.cancelFailureGeneration = this.pendingGeneration;
    }
  }

  private setLoadFailure(error: unknown): void {
    if (this.loadFailure === null) {
      this.loadFailure = error;
      this.loadFailureGeneration = this.pendingGeneration;
    }
  }

  /** 真实成功（写入/就绪）后清掉旧的加载失败，避免 lastLoadFailure 报告陈旧错误。 */
  private clearLoadFailure(): void {
    this.loadFailure = null;
    this.loadFailureGeneration = this.pendingGeneration;
    this.loadRetryNotBefore = 0;
  }

  /**
   * 取消当前附着的执行但保留其 receiver，供本次生命周期报告同步派发；取消失败只
   * 记录原始对象，交由调用者在完成 stale/gating 后抛出，绝不以干净关停掩盖。
   */
  private revokeCurrent(): { attachment: Attachment; failure: CancelFailure | null } | null {
    const current = this.attachment;
    if (current === null) return null;
    if (current.cancelled) return { attachment: current, failure: null };
    current.cancelled = true;
    try {
      current.cancel();
      return { attachment: current, failure: null };
    } catch (err) {
      this.recordCancelFailure(err);
      return { attachment: current, failure: { error: err } };
    }
  }

  /**
   * 把生命周期报告派发给被撤销 token 保留的 receiver；派发期间该 token 的 detach
   * 只影响它自己。若 receiver 未换成新 owner，则派发后解除该旧附着。
   * receiver 失败只记录并且仍然解除旧附着，不影响已经完成的 stale/gating。
   */
  private deliverLifecycle(
    report: ChangeReport,
    revoked: { attachment: Attachment; failure: CancelFailure | null } | null,
  ): void {
    if (revoked === null) {
      this.dispatch(report);
      return;
    }
    try {
      revoked.attachment.receiver(report);
    } catch (error) {
      this.recordReceiverFailure(error, 0);
      this.deliveryFailure = { committed: true, error };
    } finally {
      if (this.attachment === revoked.attachment) this.attachment = null;
    }
  }
}

/**
 * 动作确认链的 `markModified` 接线（D-070 B3）：技能只在自己核实过格子变化后才调用。
 * 能力 false / 未准入 / 暂停 / 维度不符时返回 `null`——不调用库、不回退、不把拒绝报成成功；
 * 已提交的写入报告原样返回。没有共享会话（测试或未接线的宿主）时不写。
 */
export function markSelfModified(
  spatial: SharedSpatialSession | undefined,
  dim: string,
  pos: Vec3Like,
  actionId: string,
) {
  if (!spatial) return null;
  const result = spatial.markModified(dim, pos, actionId);
  return result.status === 'rejected' ? null : result;
}
