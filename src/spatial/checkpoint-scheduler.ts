/**
 * 常规运行时的空间记忆 checkpoint 调度。
 *
 * 只使用 SharedSpatialSession 的公开单 I/O 门与 checkpoint 入口：单个定时器、
 * 同一时刻最多一次调度保存、不排队也不自行重试。周期到达时先读实际持久化状态，
 * clean/忙/非 open 一律跳过；保存结果与剩余 dirty 原样汇报，绝不代替库确认版本
 * 或清除 dirty。最终 flush/checkpoint/close 仍由宿主的 SharedSpatialSession.shutdown
 * 负责；stop() 只停未来触发，不取消已接受的 I/O。
 */
import type { SpatialCheckpointResult, SpatialPersistenceState } from 'curio-minecraft-3d-memory/storage/sqlite';
import { errorFacts, type ErrorFacts } from './host-shutdown.ts';

/** 常规运行时存档周期；固定默认值，不提供用户配置开关。 */
export const DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS = 30_000;

/** 调度器需要的最小公开表面；SharedSpatialSession 直接满足。 */
export interface SpatialCheckpointSource {
  /** 服务已开始关停（同步标志，早于底层会话 lifecycle 变更）。 */
  readonly closing: boolean;
  /** 组合会话的公开单 I/O 门；checkpoint/load/working-set 进行中时为 true。 */
  readonly session: { readonly busy: boolean };
  checkpoint(): Promise<SpatialCheckpointResult>;
  getPersistenceState(): SpatialPersistenceState;
}

/** 一次调度保存的事实：已确认的 checkpoint，或失败与当时的真实状态。 */
export type SpatialCheckpointReport =
  | {
    status: 'saved';
    /** 实际提交的 checkpoint 身份与各域捕获版本。 */
    checkpoint: SpatialCheckpointResult;
    /** 保存完成后的最新状态；保存期间的新观测会让它再次 dirty。 */
    state: SpatialPersistenceState;
    remainingDirty: boolean;
  }
  | {
    status: 'failed';
    error: ErrorFacts;
    /** 失败后原样的持久化状态；调度器不改变 dirty 或版本。 */
    state: SpatialPersistenceState;
    remainingDirty: boolean;
  };

/**
 * 启动周期存档，返回同步停止句柄。周期之间不补跑、不排队：上一次保存尚未
 * 落定时本周期直接跳过。已接受的保存即使 stop() 之后完成，也照实汇报。
 */
export function startSpatialCheckpointScheduler(
  spatial: SpatialCheckpointSource,
  report: (fact: SpatialCheckpointReport) => void,
  intervalMs = DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
): () => void {
  // Node 会把超范围/小数延迟压到 1ms，等于取消有界重试间隔；只接受整数毫秒。
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new RangeError(`spatial checkpoint interval must be an integer between 1 and 2147483647 ms, got ${intervalMs}`);
  }
  let stopped = false;
  let pending = false;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    const before = spatial.getPersistenceState();
    if (spatial.closing || before.lifecycle !== 'open' || before.inFlightCheckpointId !== null || spatial.session.busy || !before.dirty) return;
    pending = true;
    void spatial.checkpoint()
      .then((checkpoint) => {
        // 公开 checkpoint 只在提交确认后 resolve；当前状态只用于汇报剩余 dirty。
        const state = spatial.getPersistenceState();
        report({ status: 'saved', checkpoint, remainingDirty: state.dirty, state: { ...state } });
      }, (error: unknown) => {
        const state = spatial.getPersistenceState();
        report({ status: 'failed', error: errorFacts(error), remainingDirty: state.dirty, state: { ...state } });
      })
      .finally(() => { pending = false; });
  }, intervalMs);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
