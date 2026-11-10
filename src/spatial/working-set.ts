/**
 * 宿主侧 residency 协调器（阶段 M1）。
 *
 * 这是安装包公开 `WorkingSetManager` 与 `SpatialSession` 之上的一层薄调用边界。
 * key 作用域、驻留数量/字节上限、淘汰资格、load/IO 分类与 session 操作门仍由
 * 库负责；本模块只补宿主自己的事实：
 *
 * - 一次显式请求只对应一组调用者给出的 SectionKey，不探索、不全局预取；
 * - 调用者 signal/绝对 deadline 与协调器 closing 门在开始工作前拒绝过期请求；
 * - 精确的调用者 lease 释放（重复或旧 token 都不会放掉新 lease）；
 * - 调用者已取消但底层 worker/gate 仍在执行时继续跟踪到结算；迟到的 ready
 *   lease 会被释放，后续关停可以先等待这些真实 I/O，再做自己的最终保存/关闭。
 *
 * 本模块不观察世界、不 checkpoint、不隐式保存，也不关闭或替换 SpatialSession。
 */
import { PersistenceError, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  FreeResult,
  PrepareResult,
  SpatialSession,
  WorkingSetLimits,
  WorkingSetStats,
} from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SectionKey } from 'curio-minecraft-3d-memory';

/** Node 的单次 setTimeout 最大延迟；更大的值会被钳到 1ms 而提前触发。 */
export const MAX_DEADLINE_DELAY_MS = 2_147_483_647;

/** prepare 未取得可用结果的原因。 */
export type WorkingSetCancelReason = 'aborted' | 'deadline' | 'closing';

/** 调用者必须显式释放的精确 lease。 */
export interface WorkingSetLease {
  token: string;
  keys: SectionKey[];
}

/**
 * 一次 prepare 的结果。
 *
 * - `ready` 携带库的原始 `PrepareResult` 与 lease；
 * - `incomplete`/`failed` 同样携带原始结果，但没有 lease；
 * - `cancelled` 只表示调用者取消、绝对期限或 closing 门胜出，绝不表示缺失的
 *   section 已被准备，也不把 incomplete/failed 改写成成功。
 */
export type WorkingSetPrepareOutcome =
  | { status: 'ready'; result: PrepareResult; lease: WorkingSetLease }
  | { status: 'incomplete' | 'failed'; result: PrepareResult; lease: null }
  | { status: 'cancelled'; reason: WorkingSetCancelReason; result: PrepareResult | null; lease: null };

/** 单次请求的调用者取消/期限输入。 */
export interface WorkingSetPrepareOptions {
  signal?: AbortSignal;
  /** 绝对 epoch 毫秒期限；非有限值会被拒绝。 */
  deadline?: number;
}

export class WorkingSetCoordinator {
  private readonly session: SpatialSession;
  private readonly manager: WorkingSetManager;
  /** 本协调器发出的、尚未释放的 token。 */
  private readonly leases = new Set<string>();
  /** 尚未向调用者结算的请求取消入口。 */
  private readonly cancellers = new Set<(reason: WorkingSetCancelReason) => void>();
  /** 每个已开始、尚未结算的真实 manager 操作。 */
  private readonly pending = new Set<Promise<void>>();
  /** 最近一次 free 的目标；只读报告用，不参与缓存决策。 */
  private lastFreeTargetValue: { sections?: number; bytes?: number } | null = null;
  private closingFlag = false;
  private settlement: Promise<void> | null = null;
  private resolveSettlement: (() => void) | null = null;

  constructor(session: SpatialSession, limits?: WorkingSetLimits) {
    this.session = session;
    this.manager = new WorkingSetManager(session, limits);
  }

  /**
   * 准备调用者明确给出的 sections。
   *
   * closing 期间的新请求与非法 deadline 以 `PersistenceError` 拒绝；库的
   * busy/closed/IO 失败保留原始对象与 kind。调用者在库加载仍未完成时取消，
   * 返回的 Promise 立即以 cancelled 结算，但真实加载会继续跟踪到 worker/gate
   * 结算，期间产生的迟到 ready lease 由本协调器释放。
   */
  prepare(keys: readonly SectionKey[], options: WorkingSetPrepareOptions = {}): Promise<WorkingSetPrepareOutcome> {
    if (this.closingFlag) {
      return Promise.reject(new PersistenceError('closing', 'working set coordinator is closing; prepare is rejected'));
    }
    const { signal, deadline } = options;
    const now = Date.now();
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline - now > MAX_DEADLINE_DELAY_MS)) {
      return Promise.reject(new PersistenceError(
        'invalid_argument',
        `deadline must be a finite absolute epoch-millisecond value no more than ${MAX_DEADLINE_DELAY_MS} ms ahead`,
      ));
    }
    if (signal?.aborted === true) {
      return Promise.resolve({ status: 'cancelled', reason: 'aborted', result: null, lease: null });
    }
    if (deadline !== undefined && now >= deadline) {
      return Promise.resolve({ status: 'cancelled', reason: 'deadline', result: null, lease: null });
    }

    return new Promise<WorkingSetPrepareOutcome>((resolve, reject) => {
      let callerSettled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const removeCanceller = () => {
        this.cancellers.delete(cancel);
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const settleCaller = (outcome: WorkingSetPrepareOutcome) => {
        if (callerSettled) return;
        callerSettled = true;
        removeCanceller();
        resolve(outcome);
      };

      const cancel = (reason: WorkingSetCancelReason) => {
        settleCaller({ status: 'cancelled', reason, result: null, lease: null });
      };

      const onAbort = () => cancel('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.cancellers.add(cancel);
      if (deadline !== undefined) {
        const delay = Math.min(Math.max(0, deadline - Date.now()), MAX_DEADLINE_DELAY_MS);
        timer = setTimeout(() => cancel('deadline'), delay);
        timer.unref?.();
      }

      let finishTracked!: () => void;
      const settlement = new Promise<void>((finish) => { finishTracked = finish; });
      this.pending.add(settlement);

      const work = this.manager.prepare(keys);
      const workOutcome = work.then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );

      workOutcome.then((outcome) => {
        const token = outcome.kind === 'result' && outcome.result.status === 'ready' ? outcome.result.lease.token : '';

        if (callerSettled) {
          // 调用者已看到取消/期限/closing；仍完成的 ready 结果不能留下可用 lease。
          if (token !== '') this.session.releasePins([token]);
          this.finishSettlement(settlement, finishTracked);
          return;
        }

        // 工作先完成时，owned 门仍可能在本轮事件中已变化；交付前再核对一次。
        const stale: WorkingSetCancelReason | null = this.closingFlag
          ? 'closing'
          : signal?.aborted === true
            ? 'aborted'
            : deadline !== undefined && Date.now() >= deadline
              ? 'deadline'
              : null;
        if (stale !== null) {
          if (token !== '') this.session.releasePins([token]);
          settleCaller({
            status: 'cancelled',
            reason: stale,
            result: outcome.kind === 'result' ? outcome.result : null,
            lease: null,
          });
          this.finishSettlement(settlement, finishTracked);
          return;
        }

        if (outcome.kind === 'error') {
          callerSettled = true;
          removeCanceller();
          this.finishSettlement(settlement, finishTracked);
          reject(outcome.error);
          return;
        }

        if (outcome.result.status === 'ready') {
          this.leases.add(token);
          settleCaller({
            status: 'ready',
            result: outcome.result,
            lease: { token, keys: outcome.result.lease.keys },
          });
        } else {
          settleCaller({ status: outcome.result.status, result: outcome.result, lease: null });
        }
        this.finishSettlement(settlement, finishTracked);
      });
    });
  }

  /**
   * 显式释放工作集空间；closing 之后拒绝新操作，其余直接走库内同一 session 门的
   * `WorkingSetManager.free`。不加载、不保存、不关闭会话。
   *
   * 无显式目标时（例如保存后换出）使用有界容量目标：保留约 75% 的驻留数量/字节
   * 作为近期热页，只从 LRU 最旧淘汰到上限；不会再把所有 eligible 冷页一次清空。
   * pinned/dirty/未确认保存仍由库拒绝，导航执行依赖继续用 lease 保护。
   */
  free(target?: { sections?: number; bytes?: number }): FreeResult {
    if (this.closingFlag) {
      throw new PersistenceError('closing', 'working set coordinator is closing; free is rejected');
    }
    const applied = target ?? this.postSaveTarget();
    const result = this.manager.free(applied);
    this.lastFreeTargetValue = { ...applied };
    return result;
  }

  /** 最近一次 `free` 实际使用的目标；只读，用于保存报告/基准。 */
  lastFreeTarget(): { sections?: number; bytes?: number } | null {
    return this.lastFreeTargetValue === null ? null : { ...this.lastFreeTargetValue };
  }

  /** 有界回收目标：驻留上限的 75%（向下取整，至少 1），保留有限近期热页。 */
  private postSaveTarget(): { sections: number; bytes: number } {
    const limits = this.session.residencyLimits;
    return {
      sections: Math.max(1, Math.floor(limits.maxResidentSections * 3 / 4)),
      bytes: Math.max(1, Math.floor(limits.maxResidentBytes * 3 / 4)),
    };
  }

  /**
   * 精确释放本协调器发出的 token。未知、已释放或过期的 token 都是 no-op，
   * 因此旧请求的迟到释放不会放掉新请求的 lease。
   */
  release(token: string): void {
    if (!this.leases.delete(token)) return;
    this.session.releasePins([token]);
  }

  /** 有界只读工作集快照；不加载、不淘汰、不保存。 */
  stats(): WorkingSetStats {
    return this.manager.stats();
  }

  /**
   * 同步停止接受新工作，并返回所有已开始 manager 操作的结算 Promise。该
   * Promise 只会在真实 worker/gate 结算且迟到 ready lease 已释放后 resolve；
   * 它不 checkpoint、不保存、不关闭 SpatialSession。调用者随后可在既有
   * worker 时限内做最终 checkpoint 与真实 close。
   */
  beginClose(): Promise<void> {
    if (this.settlement !== null) return this.settlement;
    this.closingFlag = true;
    const settlement = new Promise<void>((resolve) => {
      this.resolveSettlement = resolve;
    });
    this.settlement = settlement;
    for (const cancel of [...this.cancellers]) cancel('closing');
    if (this.pending.size === 0 && this.resolveSettlement !== null) {
      this.resolveSettlement();
      this.resolveSettlement = null;
    }
    return settlement;
  }

  private finishSettlement(settlement: Promise<void>, finish: () => void): void {
    this.pending.delete(settlement);
    finish();
    if (this.pending.size === 0 && this.resolveSettlement !== null) {
      this.resolveSettlement();
      this.resolveSettlement = null;
    }
  }
}
