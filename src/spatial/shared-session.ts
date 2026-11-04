/**
 * shared-session：宿主级共享空间记忆服务（阶段 D1）。
 *
 * 持有唯一一个公开的 SpatialSession（组合会话：voxel + history + topology +
 * 单个 SQLite Worker），以及最后一份可信的有效 world/dim/session 作用域、
 * paused/closing 状态和当前唯一的步行委托 report/cancel 附着。
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

/** 关停结果：主保存错误与次关闭错误/结果分开保留。 */
export interface ShutdownResult {
  /** 最终已提交的 checkpoint；最终保存失败时为 null。 */
  checkpoint: SpatialCheckpointResult | null;
  /** 主保存错误（保留原始对象，可读 kind/message）；无错误时为 null。 */
  error: PersistenceError | null;
  /** 真实 close() 结果；close 自身抛错时为 null。 */
  close: CloseResult | null;
  /** close() 自身抛出的次关闭错误（如注入失败）；无错误时为 null。 */
  closeError: Error | null;
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

/** 把未知的保存失败归一成带 kind 的持久化错误，保留原对象/消息。 */
function toPersistenceError(err: unknown): PersistenceError {
  if (err instanceof PersistenceError) return err;
  return new PersistenceError('worker_communication', err instanceof Error ? err.message : String(err));
}

export class SharedSpatialSession {
  readonly worldId: string;
  readonly databasePath: string;
  /** 公开的组合会话；宿主通过它做只读查询（cellAt 等）。 */
  readonly session: SpatialSession;

  private scope: TrustedScope | null = null;
  private pausedFlag = false;
  private closingFlag = false;
  private attachment: { token: number; receiver: (r: ChangeReport) => void; cancel: () => void } | null = null;
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

  get closing(): boolean {
    return this.closingFlag;
  }

  /**
   * 开始（或切换到）一个就绪观察会话，作用域来自 adapter 真实状态。外部世界是
   * 显式失败；同一世界的新 session 先取消旧委托（即使 map/report 为空），再由库的
   * beginSession 把旧 session 证据跨维度置 STALE；同一 session 换维则使旧维度失效。
   */
  beginSession(scope: TrustedScope): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; beginSession is rejected');
    }
    if (scope.worldId !== this.worldId) {
      throw new PersistenceError('invalid_argument', `foreign world "${scope.worldId}" does not match shared session worldId "${this.worldId}"`);
    }
    const prev = this.scope;
    const sessionChanged = prev === null || prev.sessionId !== scope.sessionId;
    const dimChanged = prev !== null && prev.dim !== scope.dim;
    if (sessionChanged) this.cancelAttachment();
    let report = this.session.voxel.beginSession(scope.sessionId);
    if (dimChanged) {
      report = { sections: [...report.sections, ...this.session.voxel.markStale(prev!.dim, 'observation_gap').sections] };
    }
    this.scope = scope;
    return this.dispatch(report);
  }

  /** 断开/死亡/未就绪：先取消活动委托，再使最后有效维度失效并派发真实报告。 */
  interrupt(): ChangeReport {
    if (this.closingFlag) return { sections: [] };
    this.cancelAttachment();
    if (this.scope === null) return { sections: [] };
    return this.dispatch(this.session.voxel.markStale(this.scope.dim, 'observation_gap'));
  }

  /** 接受 Curio 感知的 typed 观测；暂停或尚未 beginSession 时挂起写入。 */
  observe(observations: readonly BlockObservation[]): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; observations are rejected');
    }
    if (this.pausedFlag || this.scope === null) return { sections: [] };
    const batch = observations.map(toObservation);
    return this.dispatch(this.session.voxel.observeBatch({ observations: batch, unobserved: [] }));
  }

  /** 挂起/恢复空间写入（Arbiter.setPaused 直接调用）。暂停与恢复都记录中断边界。 */
  setPaused(paused: boolean): ChangeReport {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; setPaused is rejected');
    }
    if (paused === this.pausedFlag) return { sections: [] };
    this.pausedFlag = paused;
    if (this.scope === null) return { sections: [] };
    return this.dispatch(this.session.voxel.markStale(this.scope.dim, 'observation_gap'));
  }

  /** 绑定当前唯一的步行委托附着，返回 token 用于后续解除。 */
  attach(attachment: WalkAttachment): number {
    if (this.closingFlag) {
      throw new PersistenceError('closed', 'shared spatial session is closed; attachment is rejected');
    }
    const token = this.nextToken++;
    this.attachment = { token, receiver: attachment.receiver, cancel: attachment.cancel };
    return token;
  }

  /** 按 token 解除附着；旧 token 无法解除新附着。 */
  detach(token: number): void {
    if (this.attachment !== null && this.attachment.token === token) this.attachment = null;
  }

  checkpoint(): Promise<SpatialCheckpointResult> {
    return this.session.checkpoint();
  }

  getPersistenceState(): SpatialPersistenceState {
    return this.session.getPersistenceState();
  }

  /**
   * 关停：同步拒绝新写入/附着，先取消活动委托，等待已接受的保存，捕获最终
   * checkpoint 并校验提交状态（dirty=false、各域版本一致），随后始终尝试真实 close。
   * 主保存错误与次关闭错误/结果分开保留；幂等共享同一 promise。
   */
  shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<ShutdownResult> {
    this.closingFlag = true;
    this.cancelAttachment();

    // 等待已接受的保存；flush 只等待已接受 I/O，不产生新保存，也不抛错。
    const flush = await this.session.flush();
    let error: PersistenceError | null = flush.error;

    // 捕获最终 checkpoint 并校验提交状态。
    let checkpoint: SpatialCheckpointResult | null = null;
    if (error === null) {
      try {
        checkpoint = await this.session.checkpoint();
        const state = this.session.getPersistenceState();
        if (
          state.dirty ||
          state.lastConfirmedCheckpointId !== checkpoint.checkpointId ||
          state.voxelRevision !== state.confirmedVoxelRevision ||
          state.fragmentRevision !== state.confirmedFragmentRevision ||
          state.topologyRevision !== state.confirmedTopologyRevision
        ) {
          error = new PersistenceError('data', 'final checkpoint did not confirm clean state');
        }
      } catch (err) {
        error = toPersistenceError(err);
      }
    }

    // 始终尝试真实 close；close 自身抛错单独保留为次关闭错误。
    let close: CloseResult | null = null;
    let closeError: Error | null = null;
    try {
      close = await this.session.close();
    } catch (err) {
      closeError = err instanceof Error ? err : new Error(String(err));
    }

    return { checkpoint, error, close, closeError };
  }

  /** 同步把变化报告交给当前附着（无附着或空报告也照常派发）。 */
  private dispatch(report: ChangeReport): ChangeReport {
    this.attachment?.receiver(report);
    return report;
  }

  /** 取消并清除当前附着；先清除再调用 cancel，cancel 与变化报告相互独立。 */
  private cancelAttachment(): void {
    if (this.attachment === null) return;
    const current = this.attachment;
    this.attachment = null;
    try {
      current.cancel();
    } catch {
      // cancel 是尽力而为的委托取消，不吞掉其它生命周期流程。
    }
  }
}
