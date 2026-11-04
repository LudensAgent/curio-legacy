/**
 * H2b manual residency 场景（独立模块）。
 *
 * 只使用 manual-residency 分支在 SharedSpatialSession 上提供的真实 API：
 * `voxelLoading: 'manual'` 打开、`prepare`/`release` 显式工作集租约、
 * `workingSetStats` 与 `pendingObservations` 只读快照。当前工作树尚未合入该分支时，
 * 这些实例能力不存在；本模块在打开会话前先检查原型，明确返回 not-integrated，
 * 绝不伪造 manual 会话、绝不把 eager 运行报告成 manual 通过。
 *
 * 可选能力用可选属性描述：SharedSpatialSession 现在可赋值给这个契约，合入
 * manual 分支后实例会真实提供这些方法；没有任何类型断言或制造对象。
 */
import type { SectionKey } from 'curio-minecraft-3d-memory';
import type { WorkingSetStats } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import type { BlockObservation } from '../src/adapter/types.ts';

/** manual-residency 分支的 prepare 结算形状；只读取状态与真实 lease token。 */
type ManualPrepareOutcome = {
  status: 'ready' | 'incomplete' | 'failed' | 'cancelled';
  lease: { token: string } | null;
};

/** manual-residency 分支的只读 pending 快照；字段与宿主实际返回值一致。 */
type ManualPendingInfo = {
  observations: number;
  sections: readonly SectionKey[];
  loading: boolean;
};

type ManualCapabilities = {
  prepare?: (keys: readonly SectionKey[]) => Promise<ManualPrepareOutcome>;
  release?: (token: string) => void;
  workingSetStats?: () => WorkingSetStats;
  pendingObservations?: () => ManualPendingInfo;
};

type ManualSession = SharedSpatialSession & ManualCapabilities;

export interface ManualScenarioScope {
  worldId: string;
  dim: string;
  sessionId: string;
}

export interface ManualScenarioDeps {
  worldId: string;
  databasePath: string;
  scope: ManualScenarioScope;
  /** 正常 Vision.observeBlocks 的真实输出；在 reopen 前后分别调用。 */
  observe: () => readonly BlockObservation[];
  emit: (kind: string, payload: unknown) => void;
  /** 等待一次真实 load/handoff 结算的期限。 */
  drainTimeoutMs?: number;
}

export interface ManualScenarioResult {
  id: 'manual-residency';
  state: 'passed' | 'failed' | 'not-integrated';
  ok: boolean;
  problems: string[];
  facts: Record<string, unknown>;
}

/** 原型上的真实能力检查；不构造会话，不读取私有字段。 */
export const manualScenarioSupported = (ctor: typeof SharedSpatialSession): boolean =>
  ['prepare', 'release', 'workingSetStats', 'pendingObservations'].every((name) => name in ctor.prototype);

type ManualApi = {
  prepare: (keys: readonly SectionKey[]) => Promise<ManualPrepareOutcome>;
  release: (token: string) => void;
  stats: () => WorkingSetStats;
  pending: () => ManualPendingInfo;
};

/**
 * 实例级能力绑定：方法必须真实存在才返回对象；缺任何一项返回 null。
 * 不读取私有字段，也不把 eager 会话包装成 manual。
 */
const manualApiOf = (session: ManualSession): ManualApi | null => {
  const prepare = session.prepare;
  const release = session.release;
  const stats = session.workingSetStats;
  const pending = session.pendingObservations;
  if (prepare === undefined || release === undefined || stats === undefined || pending === undefined) return null;
  return {
    prepare: (keys) => prepare.call(session, keys),
    release: (token) => release.call(session, token),
    stats: () => stats.call(session),
    pending: () => pending.call(session),
  };
};

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

const shutdownProblems = (result: ShutdownResult | null): string[] => {
  if (result === null) return ['shutdown returned no result'];
  const problems: string[] = [];
  if (result.checkpoint === null) problems.push('missing confirmed final checkpoint');
  if (result.error !== null) problems.push('final checkpoint error');
  if (result.closeError !== null) problems.push('close threw');
  if (result.close === null) problems.push('missing close result');
  else {
    if (result.close.completed !== true) problems.push('close did not complete');
    if (result.close.error !== null) problems.push('close reported error');
  }
  return problems;
};

const sectionKeyOf = (scope: ManualScenarioScope, pos: { x: number; y: number; z: number }): SectionKey => ({
  worldId: scope.worldId,
  dim: scope.dim,
  cx: Math.floor(pos.x / 16),
  sy: Math.floor(pos.y / 16),
  cz: Math.floor(pos.z / 16),
});

const sameSection = (left: SectionKey, right: SectionKey): boolean =>
  left.worldId === right.worldId
  && left.dim === right.dim
  && left.cx === right.cx
  && left.sy === right.sy
  && left.cz === right.cz;

/**
 * 打开真实 manual 会话。`voxelLoading` 通过非字面量 options 传入，避免在当前
 * 尚未合入 manual 分支的声明上触发多余属性检查；合入后该字段就是真实类型。
 * 能力检查在任何读写之前完成，未合入时不会打开任何 manual/eager 会话。
 */
const openManualSession = async (worldId: string, databasePath: string): Promise<ManualSession> => {
  const voxelLoading: 'manual' = 'manual';
  const options = { worldId, databasePath, voxelLoading };
  return SharedSpatialSession.open(options);
};

/**
 * 真实 manual 场景：
 * 1. manual 打开 -> 首次观测 -> checkpoint -> 真实 shutdown；
 * 2. 重新 manual 打开同一数据库 -> 对 committed-not-resident section 再观测，
 *    证据必须进入有界 handoff 队列并最终由真实 load 补写；
 * 3. 显式 prepare 取得 lease，stats 显示 pinnedLeases，release 后归零；
 * 4. 补写证据保留原始 observedAt，不改成 load/持久化时间；
 * 5. 最终 shutdown 的真实 checkpoint/close 逐项分类。
 */
export async function runManualScenario(deps: ManualScenarioDeps): Promise<ManualScenarioResult> {
  if (!manualScenarioSupported(SharedSpatialSession)) {
    return {
      id: 'manual-residency',
      state: 'not-integrated',
      ok: false,
      problems: [
        'SharedSpatialSession manual residency API (voxelLoading/prepare/release/workingSetStats/pendingObservations) is not integrated in this worktree; manual pass is not claimed',
      ],
      facts: { supported: false },
    };
  }

  const problems: string[] = [];
  const facts: Record<string, unknown> = { supported: true };
  const scope = deps.scope;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 15_000;
  let first: ManualSession | null = null;
  let second: ManualSession | null = null;
  let secondApi: ManualApi | null = null;
  let leaseToken: string | null = null;

  const initial = deps.observe();
  if (initial.length === 0) {
    return {
      id: 'manual-residency',
      state: 'failed',
      ok: false,
      problems: ['Vision returned no observations for the manual residency scenario'],
      facts,
    };
  }
  const key = sectionKeyOf(scope, initial[0]!.pos);

  try {
    first = await openManualSession(deps.worldId, deps.databasePath);
    first.beginSession({ worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId });
    first.observe(initial);
    const checkpointA = await first.checkpoint();
    facts.firstCheckpointId = checkpointA.checkpointId;
    facts.firstObservedAt = initial[0]!.observedAt;
    const shutdownA = await first.shutdown();
    first = null;
    facts.firstShutdown = {
      checkpoint: shutdownA.checkpoint === null ? null : shutdownA.checkpoint.checkpointId,
      error: shutdownA.error === null ? null : String(shutdownA.error),
      close: shutdownA.close === null ? null : {
        completed: shutdownA.close.completed,
        error: shutdownA.close.error === null ? null : String(shutdownA.close.error),
        dirty: shutdownA.close.dirty,
        unconfirmedRequest: shutdownA.close.unconfirmedRequest,
      },
    };
    problems.push(...shutdownProblems(shutdownA).map((problem) => `first session: ${problem}`));

    const fresh = deps.observe();
    facts.reopenAt = Date.now();
    second = await openManualSession(deps.worldId, deps.databasePath);
    secondApi = manualApiOf(second);
    facts.sectionResidencyAfterReopen = second.session.sectionResidency(key).residency;
    if (secondApi === null) {
      problems.push('opened manual session does not expose the required prepare/release/workingSetStats/pendingObservations methods');
    } else {
      const api = secondApi;
      second.beginSession({ worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId });
      facts.pendingBeforeObserve = api.pending().observations;
      second.observe(fresh);
      const queued = api.pending();
      facts.pendingAfterObserve = queued.observations;
      facts.queuedSections = queued.sections;
      if (facts.sectionResidencyAfterReopen !== 'not_resident') {
        problems.push(`saved section residency after reopen is ${String(facts.sectionResidencyAfterReopen)} (not_resident required before handoff)`);
      }
      if (queued.observations === 0) {
        problems.push('saved-but-not-resident observations were not queued for real handoff');
      }
      if (!queued.sections.some((section) => sameSection(section, key))) {
        problems.push('re-observed committed section was not reported in the handoff queue');
      }
      const drained = await waitFor(
        () => api.pending().observations === 0,
        drainTimeoutMs,
      );
      facts.pendingDrained = drained;
      if (!drained) problems.push(`pending handoff did not drain within ${drainTimeoutMs}ms`);

      const statsAfterDrain = api.stats();
      facts.statsAfterDrain = statsAfterDrain;
      if (statsAfterDrain.residentSections === 0) problems.push('no resident section after the real handoff load');

      const prepared = await api.prepare([key]);
      facts.prepare = { status: prepared.status, lease: prepared.lease === null ? null : prepared.lease.token };
      if (prepared.status !== 'ready' || prepared.lease === null) {
        problems.push(`explicit prepare did not return a ready lease (status ${prepared.status})`);
      }
      if (prepared.lease !== null) {
        leaseToken = prepared.lease.token;
        const pinned = api.stats();
        facts.statsPinned = pinned;
        if (pinned.pinnedLeases < 1) problems.push('prepared lease is not reflected in pinnedLeases');
        api.release(prepared.lease.token);
        leaseToken = null;
        const released = api.stats();
        facts.statsAfterRelease = released;
        if (released.pinnedLeases !== 0) problems.push('released lease is still pinned');
      }

      // 只取与首次写入同一 Section 的新观测，确保核对的是真实 handoff 补写。
      const freshCell = fresh.find((observation) => sameSection(sectionKeyOf(scope, observation.pos), key));
      if (freshCell === undefined) {
        problems.push('reopen Vision returned no fresh observation in the committed section');
      } else {
        const view = second.session.voxel.cellAt(scope.dim, freshCell.pos.x, freshCell.pos.y, freshCell.pos.z);
        if (!view.observed) problems.push('re-observed cell is missing after the handoff write');
        else {
          facts.reobservedObservedAt = view.evidence.observation.observedAt;
          facts.freshObservedAt = freshCell.observedAt;
          facts.reobservedFreshness = view.evidence.freshness;
          facts.reobservedSessionId = view.evidence.observation.sessionId;
          if (view.evidence.observation.observedAt !== freshCell.observedAt) {
            problems.push('handoff write did not preserve the original observation timestamp');
          }
          if (view.evidence.freshness !== 'FRESH') {
            problems.push(`handoff write freshness is ${view.evidence.freshness} (FRESH required)`);
          }
          if (view.evidence.observation.sessionId !== scope.sessionId) {
            problems.push('handoff write lost the trusted observation session id');
          }
        }
      }

      const statsBeforeShutdown = api.stats();
      facts.statsBeforeShutdown = statsBeforeShutdown;
      facts.unreleasedPins = statsBeforeShutdown.pinnedLeases;
      facts.pendingBeforeShutdown = api.pending().observations;
      const shutdownB = await second.shutdown();
      second = null;
      facts.secondShutdown = {
        checkpoint: shutdownB.checkpoint === null ? null : shutdownB.checkpoint.checkpointId,
        error: shutdownB.error === null ? null : String(shutdownB.error),
        close: shutdownB.close === null ? null : {
          completed: shutdownB.close.completed,
          error: shutdownB.close.error === null ? null : String(shutdownB.close.error),
          dirty: shutdownB.close.dirty,
          unconfirmedRequest: shutdownB.close.unconfirmedRequest,
        },
      };
      problems.push(...shutdownProblems(shutdownB).map((problem) => `second session: ${problem}`));
    }
  } finally {
    if (second !== null && leaseToken !== null) {
      const api = secondApi ?? manualApiOf(second);
      api?.release(leaseToken);
      leaseToken = null;
    }
    if (second !== null) {
      const api = secondApi ?? manualApiOf(second);
      if (api !== null) {
        facts.pendingAtCleanup = api.pending().observations;
        facts.unreleasedPinsAtCleanup = api.stats().pinnedLeases;
      }
      const released = await second.shutdown();
      facts.cleanupSecondShutdown = shutdownProblems(released);
      second = null;
    }
    if (first !== null) {
      const released = await first.shutdown();
      facts.cleanupFirstShutdown = shutdownProblems(released);
      first = null;
    }
  }

  deps.emit('scenario-manual', { ...facts, problems });
  return {
    id: 'manual-residency',
    state: problems.length === 0 ? 'passed' : 'failed',
    ok: problems.length === 0,
    problems,
    facts,
  };
}
