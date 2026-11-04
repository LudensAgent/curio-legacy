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
 */
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  CloseResult,
  SnapshotLimits,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ChangeReport, Observation } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../adapter/types.ts';

/** 正常操作的持久化时限；supervisor 20s 窗口内约可容纳一次保存 + 最终 checkpoint + close。 */
const DEFAULT_TIMEOUT_MS = 5000;

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
}

/** 当前唯一的步行委托附着：同步接收变化报告 + 可被服务取消。 */
export interface WalkAttachment {
  /** 同步接收每次变化报告（在宿主 body onSample 之前，D2 使用）。 */
  receiver: (report: ChangeReport) => void;
  /** 服务在断开/死亡/作用域变化/关闭时调用，取消活动委托。 */
  cancel: () => void;
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

/** 一个附着同时保留 report 通道和取消通道；取消后仍保留 receiver 完成本次同步派发。 */
interface Attachment {
  token: number;
  receiver: (report: ChangeReport) => void;
  cancel: () => void;
  /** 已调用过 cancel；重复生命周期信号不再重复取消。 */
  cancelled: boolean;
}

/** 取消失败保留原始抛出对象（包括 null 之类的非 Error 值）。 */
interface CancelFailure {
  error: unknown;
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

  private constructor(session: SpatialSession, worldId: string, databasePath: string) {
    this.session = session;
    this.worldId = worldId;
    this.databasePath = databasePath;
  }

  static async open(options: SharedSpatialOpenOptions): Promise<SharedSpatialSession> {
    const session = await openSpatialSession({
      worldId: options.worldId,
      databasePath: options.databasePath,
      voxelOptions: options.now ? { now: options.now } : undefined,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      snapshotLimits: options.snapshotLimits,
    });
    return new SharedSpatialSession(session, options.worldId, options.databasePath);
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
   * ready beginSession 才重新准入观测。
   */
  interrupt(): ChangeReport {
    if (this.closingFlag) return { sections: [] };
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
    return this.dispatch(this.session.voxel.observeBatch({ observations: scoped.map(toObservation), unobserved: [] }));
  }

  /**
   * 挂起/恢复空间写入（Arbiter.setPaused 直接调用）。暂停与恢复都记录中断边界；
   * 暂停会在报告为空/无更多身体帧时也取消当前委托。
   */
  setPaused(paused: boolean): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; setPaused is rejected');
    }
    if (paused === this.pausedFlag) return { sections: [] };
    const revoked = paused ? this.revokeCurrent() : null;
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
    this.attachment = { token, receiver: attachment.receiver, cancel: attachment.cancel, cancelled: false };
    return token;
  }

  /** 按 token 解除附着；旧 token 无法解除新附着。 */
  detach(token: number): void {
    if (this.attachment !== null && this.attachment.token === token) this.attachment = null;
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
   * 关停：同步拒绝新写入/附着/公开保存并取消活动委托，等待已接受的保存，捕获最终
   * checkpoint 并核对实际返回 id 与各域确认版本，随后始终尝试真实 close。
   * 主保存错误、取消错误与次关闭错误/结果分别保留原始对象；幂等共享同一 promise。
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

    // 等待已接受的保存；flush 只等待已接受 I/O，不产生新保存。
    let error: unknown = null;
    let checkpoint: SpatialCheckpointResult | null = null;
    try {
      error = (await this.session.flush()).error;
    } catch (err) {
      error = err;
    }

    // 捕获最终 checkpoint 并核对实际返回值与已确认状态。
    if (error === null) {
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
          error = new PersistenceError('data', 'final checkpoint did not confirm clean state');
        }
      } catch (err) {
        error = err;
      }
    }

    // 始终尝试真实 close；close 自身抛出的原始对象单独保留，绝不伪造 CloseResult。
    let close: CloseResult | null = null;
    let closeError: unknown = null;
    try {
      close = await this.session.close();
    } catch (err) {
      closeError = err;
    }

    return { checkpoint, error, cancelError, close, closeError };
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
