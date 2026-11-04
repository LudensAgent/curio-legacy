/**
 * shared-session：宿主级共享空间记忆服务（阶段 D1）。
 *
 * 持有唯一一个公开的 SpatialSession（组合会话：voxel + history + topology +
 * 单个 SQLite Worker），以及最后一份可信的有效 world/dim/session 作用域、
 * 暂停/关停状态和当前唯一的步行委托 report/cancel 附着。
 *
 * 证据只来自 Curio 感知产出的 typed BlockObservation[]；生命周期/作用域由
 * adapter 的真实状态单独供给，绝不从观测载荷激活。模块加载无副作用，不导入
 * 宿主配置；D2 会接入真实 Arbiter/adapter，本阶段只暴露 D2 需要的最小操作。
 *
 * manual 体素加载（M2a1）沿用库的 WorkingSetCoordinator，只补宿主自己的接缝：
 * resident 证据同步写入并在同一调用内派发；saved 但未驻留的证据按原始载荷有界
 * 排队、一次只跟踪一个真实 load，成功后按原观测时间/序列补写；容量/未就绪/
 * 作用域失效都留下可见结构化缺口，绝不伪造已观察空气或已保存。
 */
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  CapacityGapKind,
  CloseResult,
  SnapshotLimits,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
  WorkingSetStats,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import { VoxelResidencyError } from 'curio-minecraft-3d-memory';
import type {
  ChangeReport,
  Observation,
  ResidencyLimits,
  SectionKey,
  SectionResidency,
} from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../adapter/types.ts';
import { MAX_DEADLINE_DELAY_MS, WorkingSetCoordinator } from './working-set.ts';
import type { WorkingSetPrepareOptions, WorkingSetPrepareOutcome } from './working-set.ts';

/** 正常操作的持久化时限；supervisor 20s 窗口内约可容纳一次保存 + 最终 checkpoint + close。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 宿主侧待加载原始证据的硬上限；超出时保留时间/数量并显式报告，不静默覆盖。 */
export const MAX_PENDING_OBSERVATIONS = 256;

/** 等待会话操作门释放的轮询间隔；只用于本服务唯一的加载跟踪循环。 */
const GATE_RETRY_MS = 10;

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
  /** 可选诊断回调：容量、队列、未就绪与作用域丢弃事件。 */
  onWorkingSetDiagnostic?: (diagnostic: SharedSpatialDiagnostic) => void;
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

/** 结构化缺口类别；只描述宿主实际拒绝/未完成的事实。 */
export type SharedSpatialGapKind =
  | 'queue_full'
  | 'count_capacity'
  | 'byte_capacity'
  | 'capacity'
  | 'load_failed'
  | 'not_ready'
  | 'busy'
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
  generation: number;
  sessionId: string;
  dim: string;
}

/** 一次真实写入的结果；accepted 只由 observeBatch 成功返回决定。 */
interface ObservedBatch {
  accepted: boolean;
  report: ChangeReport;
}

/** 把一次合法视锥观测映射成库的 Observation（与 walk-route 的 toObservation 一致）。 */
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
  count: number;
  observedAtMin: number | null;
  observedAtMax: number | null;
}

function observationFields(observations: readonly Observation[]): ObservationFields {
  const keys: SectionKey[] = [];
  const seen = new Set<string>();
  let observedAtMin: number | null = null;
  let observedAtMax: number | null = null;
  for (const observation of observations) {
    const key = sectionKeyOf(observation);
    const id = sectionKeyId(key);
    if (!seen.has(id)) {
      seen.add(id);
      keys.push(key);
    }
    observedAtMin = observedAtMin === null ? observation.observedAt : Math.min(observedAtMin, observation.observedAt);
    observedAtMax = observedAtMax === null ? observation.observedAt : Math.max(observedAtMax, observation.observedAt);
  }
  return { keys, count: observations.length, observedAtMin, observedAtMax };
}

function gapFor(kind: SharedSpatialGapKind, observations: readonly Observation[], message: string): SharedSpatialGap {
  return { kind, message, ...observationFields(observations) };
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

/** 只用于本服务唯一的加载循环；定时器不阻止进程退出。 */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

  /** 已接受的原始 handoff，按到达顺序；最多 MAX_PENDING_OBSERVATIONS 条。 */
  private pending: PendingHandoff[] = [];
  /** interrupt/pause/新作用域递增；迟到 load 只有同代 handoff 才能写入。 */
  private pendingGeneration = 0;
  /** 唯一一个已开始、尚未结算的加载跟踪任务。 */
  private loadTask: Promise<void> | null = null;
  /** 加载任务运行期间又有新 handoff 到达。 */
  private loadAgain = false;
  /** 上次真实加载以容量/未就绪/硬失败停下；新证据或显式 drain 才再试一次。 */
  private loadBlocked = false;
  private lastGap: SharedSpatialGap | null = null;
  private discarded: SharedSpatialDiscarded | null = null;

  private constructor(
    session: SpatialSession,
    worldId: string,
    databasePath: string,
    operationTimeoutMs: number,
    diagnostic: ((diagnostic: SharedSpatialDiagnostic) => void) | undefined,
  ) {
    this.session = session;
    this.worldId = worldId;
    this.databasePath = databasePath;
    this.operationTimeoutMs = operationTimeoutMs;
    this.diagnostic = diagnostic;
    this.coordinator = session.voxelLoading === 'manual' ? new WorkingSetCoordinator(session) : null;
  }

  static async open(options: SharedSpatialOpenOptions): Promise<SharedSpatialSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const session = await openSpatialSession({
      worldId: options.worldId,
      databasePath: options.databasePath,
      voxelOptions: options.now ? { now: options.now } : undefined,
      ...(options.voxelLoading === undefined ? {} : { voxelLoading: options.voxelLoading }),
      ...(options.residencyLimits === undefined ? {} : { residencyLimits: options.residencyLimits }),
      timeoutMs,
      snapshotLimits: options.snapshotLimits,
    });
    return new SharedSpatialSession(
      session,
      options.worldId,
      options.databasePath,
      timeoutMs,
      options.onWorkingSetDiagnostic,
    );
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
      report = { sections: [...report.sections, ...this.session.voxel.markStale(prev!.dim, 'observation_gap').sections] };
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
    const report = this.scope === null ? { sections: [] } : this.session.voxel.markStale(this.scope.dim, 'observation_gap');
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
    if (this.coordinator === null) {
      return this.dispatch(this.session.voxel.observeBatch({ observations: converted, unobserved: [] }));
    }
    return this.observeManual(converted);
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
    const report = this.scope === null ? { sections: [] } : this.session.voxel.markStale(this.scope.dim, 'observation_gap');
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
  checkpoint(): Promise<SpatialCheckpointResult> {
    if (this.closingFlag) {
      return Promise.reject(new PersistenceError('closing', 'shared spatial session is closing; checkpoint is rejected'));
    }
    return this.session.checkpoint();
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
            capture(new Error(`working-set settlement did not complete within ${this.operationTimeoutMs} ms`));
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

      // 捕获最终 checkpoint 并核对实际返回值与已确认状态。
      try {
        checkpoint = await this.session.checkpoint();
        const state = this.session.getPersistenceState();
        if (
          state.dirty ||
          state.lastConfirmedCheckpointId !== checkpoint.checkpointId ||
          checkpoint.voxelRevision !== state.voxelRevision ||
          checkpoint.voxelRevision !== state.confirmedVoxelRevision ||
          checkpoint.fragmentRevision !== state.fragmentRevision ||
          checkpoint.fragmentRevision !== state.confirmedFragmentRevision ||
          checkpoint.topologyRevision !== state.topologyRevision ||
          checkpoint.topologyRevision !== state.confirmedTopologyRevision
        ) {
          capture(new PersistenceError('data', 'final checkpoint did not confirm clean state'));
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
        (error: unknown) => finish(true, error),
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
    let flushDone = false;
    const flush = this.session.flush().then(
      (result) => {
        checkpointError = result.error;
        flushDone = true;
      },
      (error: unknown) => {
        checkpointError = error;
        flushDone = true;
      },
    );

    try {
      // 显式 drain 允许对上次容量/未就绪结果再试一次，但只限一次真实加载循环。
      this.loadBlocked = false;
      this.kickLoad();
      while (state.reason === null) {
        this.applyReadyPending();
        if (this.loadBlocked) break;
        if (this.loadTask === null) {
          if (!this.hasLoadablePending()) break;
          this.kickLoad();
          if (this.loadTask === null) break;
        }
        const waits: Promise<unknown>[] = [];
        if (this.loadTask !== null) waits.push(this.loadTask);
        if (!flushDone) waits.push(flush);
        if (waits.length === 0) break;
        await Promise.race([Promise.all(waits), cancelledPromise]);
      }
      if (state.reason === null && !flushDone) await Promise.race([flush, cancelledPromise]);
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
      if (applied.accepted) reports.push(this.dispatch(applied.report));
    }
    if (first.length > 0) {
      const applied = this.applyFirstObservation(first);
      if (applied.accepted) reports.push(this.dispatch(applied.report));
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
      const freeFailure = this.freeOnce();
      if (freeFailure !== null) {
        this.recordGap(kind, observations, `${messageOf(error)}; free refused: ${messageOf(freeFailure.error)}`);
        return { accepted: false, report: { sections: [] } };
      }
      try {
        return { accepted: true, report: this.session.voxel.observeBatch(batch) };
      } catch (retryError) {
        if (retryError instanceof VoxelResidencyError) {
          this.recordGap('not_ready', observations, retryError.message);
          return { accepted: false, report: { sections: [] } };
        }
        const retryKind = capacityKindOf(retryError);
        if (retryKind === null) throw retryError;
        this.recordGap(retryKind, observations, messageOf(retryError));
        return { accepted: false, report: { sections: [] } };
      }
    }
  }

  private freeOnce(): { error: unknown } | null {
    if (this.coordinator === null) {
      return { error: new PersistenceError('invalid_argument', 'manual working set is not enabled') };
    }
    try {
      this.coordinator.free();
      return null;
    } catch (error) {
      return { error };
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
    this.diagnostic?.(gap);
    return gap;
  }

  private recordDiscarded(
    reason: SharedSpatialDiscarded['reason'],
    observations: readonly Observation[],
  ): void {
    const fields = observationFields(observations);
    const next: SharedSpatialDiscarded = {
      kind: 'discarded',
      reason,
      message: `discarded ${fields.count} pending observation(s) on ${reason}`,
      ...fields,
    };
    const prev = this.discarded;
    this.discarded = prev === null ? next : {
      kind: 'discarded',
      reason,
      message: `${prev.message}; ${next.message}`,
      keys: uniqueKeys([prev.keys, next.keys]),
      count: prev.count + next.count,
      observedAtMin: minNullable(prev.observedAtMin, next.observedAtMin),
      observedAtMax: maxNullable(prev.observedAtMax, next.observedAtMax),
    };
    this.diagnostic?.(next);
  }

  /** 作废所有尚未应用的旧 scope handoff；迟到 load 只会释放 lease，不会补写。 */
  private invalidatePending(reason: SharedSpatialDiscarded['reason']): void {
    this.pendingGeneration += 1;
    this.loadBlocked = false;
    if (this.pending.length === 0) return;
    const observations = this.pending.map((record) => record.observation);
    this.pending = [];
    this.recordDiscarded(reason, observations);
  }

  /** 有界接收；溢出条数进入 gap，不覆盖、不静默丢弃已接收的原始载荷。 */
  private enqueueHandoff(observations: readonly Observation[]): void {
    const scope = this.scope;
    if (scope === null) return;
    const room = Math.max(0, MAX_PENDING_OBSERVATIONS - this.pending.length);
    const accepted = observations.slice(0, room);
    const rejected = observations.slice(room);
    for (const observation of accepted) {
      this.pending.push({
        observation,
        generation: this.pendingGeneration,
        sessionId: scope.sessionId,
        dim: scope.dim,
      });
    }
    if (rejected.length > 0) {
      this.recordGap(
        'queue_full',
        rejected,
        `pending handoff queue is full (${MAX_PENDING_OBSERVATIONS}); ${rejected.length} observation(s) were not queued`,
      );
    }
    if (accepted.length > 0) this.kickLoad(true);
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
        this.removePending(residentRecords);
        this.dispatch(applied.report);
      }
    }
    if (firstRecords.length > 0) {
      const applied = this.applyFirstObservation(firstRecords.map((record) => record.observation));
      if (applied.accepted) {
        this.removePending(firstRecords);
        this.dispatch(applied.report);
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
   * 启动本服务唯一一个加载跟踪任务。force=true 表示有新证据或显式 drain，允许
   * 对上次容量/未就绪结果再试一次；普通 settle 不会无限重试。
   */
  private kickLoad(force = false): void {
    if (this.coordinator === null || this.closingFlag) return;
    if (this.loadTask !== null) {
      if (force) this.loadAgain = true;
      return;
    }
    if (!force && this.loadBlocked) return;
    if (!this.hasLoadablePending()) return;
    if (force) this.loadBlocked = false;

    const task = this.runLoads().catch((error: unknown) => {
      const current = this.pending.filter((record) => this.isCurrent(record)).map((record) => record.observation);
      if (current.length > 0) this.recordGap('observe_failed', current, messageOf(error));
      this.loadBlocked = true;
    });
    this.loadTask = task;
    task.then(() => {
      if (this.loadTask === task) this.loadTask = null;
      const again = this.loadAgain;
      this.loadAgain = false;
      if (again) this.kickLoad(true);
    });
  }

  /**
   * 唯一的加载循环：先应用现已可写的 handoff，再对 not_resident 的 saved sections
   * 发起一次真实 prepare；成功后按原始载荷补写并释放自己的 lease。busy 等待操作
   * 门；notReady/容量失败留下 pending/gap 后停下，等新证据或显式 drain。
   */
  private async runLoads(): Promise<void> {
    while (!this.closingFlag) {
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
        await pause(GATE_RETRY_MS);
        continue;
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
          if (this.closingFlag) return;
        } finally {
          // ready lease 属于本次 prepare；即使 receiver/diagnostic/apply 抛错也必须释放。
          this.coordinator!.release(readyLease.token);
        }
        continue;
      }

      this.applyReadyPending();
      if (this.closingFlag) return;

      if (outcome.kind === 'error') {
        if (outcome.error instanceof PersistenceError && outcome.error.kind === 'closing') return;
        if (outcome.error instanceof PersistenceError && outcome.error.kind === 'busy') {
          await pause(GATE_RETRY_MS);
          continue;
        }
        const current = this.pending.filter((record) => this.isCurrent(record)).map((record) => record.observation);
        if (current.length > 0) this.recordGap('load_failed', current, messageOf(outcome.error));
        this.loadBlocked = true;
        return;
      }

      const result = outcome.result;
      if (result.status === 'cancelled') {
        this.loadBlocked = true;
        return;
      }
      if (result.status === 'ready') {
        this.coordinator!.release(result.lease.token);
        continue;
      }
      if (result.status === 'failed') {
        const capacity = result.result.capacity;
        const kind = capacity === null ? 'load_failed' : capacityGapKind(capacity.kind);
        const current = this.pending.filter((record) => this.isCurrent(record)).map((record) => record.observation);
        if (current.length > 0) {
          this.recordGap(kind, current, capacity?.message ?? 'working-set prepare failed');
        }
        this.loadBlocked = true;
        return;
      }

      // incomplete：已驻留的部分已在 applyReadyPending 写入，其余保持 pending。
      const notReady = result.result.notReady;
      const remaining = this.pending.filter((record) => this.isCurrent(record)
        && notReady.some((key) => sectionKeyId(key) === sectionKeyId(sectionKeyOf(record.observation))));
      if (remaining.length === 0) continue;
      const residencies = remaining.map(
        (record) => this.session.sectionResidency(sectionKeyOf(record.observation)).residency,
      );
      this.recordGap(
        residencies.includes('load_failed') ? 'load_failed' : 'not_ready',
        remaining.map((record) => record.observation),
        `working-set prepare left ${remaining.length} pending observation(s) not ready`,
      );
      this.loadBlocked = true;
      return;
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

  /** 同步把变化报告交给当前附着（无附着或空报告也照常派发）。 */
  private dispatch(report: ChangeReport): ChangeReport {
    this.attachment?.receiver(report);
    return report;
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
      return { attachment: current, failure: { error: err } };
    }
  }

  /**
   * 把生命周期报告派发给被撤销 token 保留的 receiver；派发期间该 token 的 detach
   * 只影响它自己。若 receiver 未换成新 owner，则派发后解除该旧附着。
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
    } finally {
      if (this.attachment === revoked.attachment) this.attachment = null;
    }
  }
}
