/**
 * 常规运行时的空间记忆 checkpoint 调度。
 *
 * 只使用 SharedSpatialSession 的公开单 I/O 门与 checkpoint 入口：单个定时器、
 * 同一时刻最多一次调度保存、不排队，不在失败后立即重试；后续周期按真实状态
 * 决定是否保存。周期到达时先读实际持久化状态，clean/忙/非 open 一律跳过；
 * 保存结果与剩余 dirty 原样汇报，绝不代替库确认版本或清除 dirty。最终
 * flush/checkpoint/close 仍由宿主的 SharedSpatialSession.shutdown 负责；
 * stop() 只停未来触发，不取消已接受的 I/O。
 */
import type { SpatialCheckpointResult, SpatialPersistenceState } from 'curio-minecraft-3d-memory/storage/sqlite';
import { errorFacts, type ErrorFacts } from './host-shutdown.ts';
import type { PostSaveEviction } from './shared-session.ts';

/** 常规运行时存档周期；固定默认值，不提供用户配置开关。 */
export const DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS = 30_000;
/** 每个调度周期最多提交多少个 bounded dirty 批次；防止一次周期无限占用。 */
export const DEFAULT_SPATIAL_CHECKPOINT_BATCHES = 8;

/** 调度器需要的最小公开表面；SharedSpatialSession 直接满足。 */
export interface SpatialCheckpointSource {
  /** 服务已开始关停（同步标志，早于底层会话 lifecycle 变更）。 */
  readonly closing: boolean;
  /** 组合会话的公开单 I/O 门；checkpoint/load/working-set 进行中时为 true。 */
  readonly session: { readonly busy: boolean };
  checkpoint(): Promise<SpatialCheckpointResult>;
  getPersistenceState(): SpatialPersistenceState;
  /** 最近一次保存后换出事实；eager/未保存时可为 null 或缺失。 */
  lastPostSaveEviction?(): PostSaveEviction | null;
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
    /** 与本次 checkpoint 相邻的换出事实；不表示保存失败。 */
    eviction: PostSaveEviction | null;
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
  maxBatchesPerCycle = 1,
  compact?: () => void,
  foreground?: () => boolean,
): () => void {
  // 只接受 Node 定时器支持范围内的整数毫秒（1..2147483647）。
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new RangeError(`spatial checkpoint interval must be an integer between 1 and 2147483647 ms, got ${intervalMs}`);
  }
  if (!Number.isInteger(maxBatchesPerCycle) || maxBatchesPerCycle < 1 || maxBatchesPerCycle > 64) {
    throw new RangeError(`maxBatchesPerCycle must be an integer between 1 and 64, got ${maxBatchesPerCycle}`);
  }
  let stopped = false;
  let pending = false;
  const runCycle = async (): Promise<void> => {
    for (let batch = 0; batch < maxBatchesPerCycle; batch++) {
      if (stopped) return;
      // 动作期间让路：后台保存不能占住单 I/O 门，让前台的 section prepare 变 busy。
      if (foreground?.() === true) return;
      const before = spatial.getPersistenceState();
      if (spatial.closing || before.lifecycle !== 'open'
        || before.inFlightCheckpointId !== null || spatial.session.busy || !before.dirty) return;
      let checkpoint: SpatialCheckpointResult;
      try {
        checkpoint = await spatial.checkpoint();
      } catch (error) {
        const state = spatial.getPersistenceState();
        report({ status: 'failed', error: errorFacts(error), remainingDirty: state.dirty, state: { ...state } });
        return;
      }
      const state = spatial.getPersistenceState();
      report({
        status: 'saved', checkpoint, remainingDirty: state.dirty, state: { ...state },
        eviction: spatial.lastPostSaveEviction?.() ?? null,
      });
      if (!state.dirty) return;
    }
  };
  const timer = setInterval(() => {
    if (stopped || pending) return;
    const before = spatial.getPersistenceState();
    if (spatial.closing || before.lifecycle !== 'open' || before.inFlightCheckpointId !== null || spatial.session.busy) return;
    if (foreground?.() === true) return;
    // 物理压缩 gone 历史是 checkpoint 的前置维护：它本身会让 facts 变 dirty，
    // 所以必须在 dirty 判断之前执行；失败按一次保存失败上报，不进入 checkpoint。
    if (compact !== undefined) {
      try {
        compact();
      } catch (error) {
        const state = spatial.getPersistenceState();
        report({ status: 'failed', error: errorFacts(error), remainingDirty: state.dirty, state: { ...state } });
        return;
      }
    }
    if (!spatial.getPersistenceState().dirty) return;
    pending = true;
    void runCycle().finally(() => { pending = false; });
  }, intervalMs);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
