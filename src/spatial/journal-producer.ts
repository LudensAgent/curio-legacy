/**
 * journal 生产者接缝：把 Arbiter 已结算的任务事实准备成 `journal.recordBatch`
 * 可接受的记录。
 *
 * 状态：**默认关闭的接缝模块。** `src/main.ts` 只在 `SPATIAL_TASK_JOURNAL=true`
 * 时创建并注入生产者（默认 `false`，不改变现有运行时行为）。
 * - Arbiter 只在调用方显式传入 `taskFactProducer` 时调用它；不注入时这条路径
 *   完全不存在（不读 journal、不加载库、不创建定时器/Worker）。
 * - 本模块本身是纯准备 + 显式 sink 调用，模块加载无副作用。只有 `createTaskJournalProducer`
 *   返回的回调会在“全部字段已确认”时调用传入的 `session.journal.recordBatch`。
 *
 * 只写已确认事实：
 * - 只接受 walk_to / walk_route / walk_known_route 的已结算结果；其它技能返回 skipped。
 * - 开始作用域/位置/观测时间来自 Arbiter 派发时实测的 `startScope`；缺失即拒绝。
 * - 结束作用域只有结束回调仍拥有该 planVersion 时才交给生产者；迟到回调整条拒绝，
 *   绝不拿新任务的 adapter.state 归给旧任务。结束作用域缺失只记非阻塞缺口，
 *   不伪造、也不用当前状态补齐。
 * - `ts` 固定为原任务的 `startedAt`（动作开始时实测），不是结束时间或墙钟。
 * - `lastPosition` 只在 event-adapter 的既有规则里作为结果快照保留，不写成
 *   `failureAt`；失败/取消/超时不会因为时间邻近获得归因。
 * - 消费、子动作、已观测变化必须由调用者显式提供；本模块只允许从真实
 *   `NavResult.consumption` 派生“实测消费”，绝不补 `[]`/`0`、不补 `known_empty`。
 * - 入队结果只报 `accepted_pending_checkpoint`；它不是 `saved`。拒绝时保留原记录
 *   引用与有界错误事实，供调用者显式重试。
 */

import type { TaskCompletionFact } from '../arbiter/arbiter.ts';
import type { Vec3Like } from '../adapter/types.ts';
import type { NavResult } from 'curio-minecraft-3d-memory';
import type { SpatialEvent } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { WalkToArrival } from './event-adapter.ts';
import {
  captureNavigationReceipt,
  enqueuePreparedFacts,
  prepareNavigationAction,
  type ConsumptionEvidence,
  type HostActionRecord,
  type HostEffectDiagnostic,
  type NavigationActionEvidence,
  type NavigationReceipt,
  type OriginalExecutionBudget,
  type OriginalNavigationRequest,
  type ParsedNavigationDelegation,
  type PersistenceErrorFacts,
  type PreparedJournalSink,
  type PreparationGap,
  type PreparationGapCode,
} from './event-adapter.ts';

/** 当前接缝只处理这三个宿主导航入口。 */
const NAVIGATION_SKILLS = new Set(['walk_to', 'walk_route', 'walk_known_route']);
const NAV_OUTCOMES = new Set(['ARRIVED', 'PARTIAL', 'NO_PATH', 'BLOCKED', 'CANCELLED', 'TIMEOUT', 'FAILED']);

/** 任务级缺口；event-adapter 的既有缺口代码原样透传。 */
export type TaskJournalGapCode =
  | PreparationGapCode
  | 'unsupported_skill'
  | 'late_completion'
  | 'missing_start_scope'
  | 'missing_end_scope'
  | 'missing_resolved_target'
  | 'missing_nav_result'
  | 'missing_action_evidence'
  | 'completion_scope_mismatch'
  | 'nav_scope_mismatch'
  | 'evidence_scope_mismatch';

export interface TaskJournalGap {
  code: TaskJournalGapCode;
  detail: string;
  blocking: boolean;
  limit?: number;
  actual?: number;
}

export type TaskJournalPreparation =
  | { status: 'skipped'; gaps: TaskJournalGap[] }
  | { status: 'refused'; gaps: TaskJournalGap[] }
  | {
    status: 'ready';
    /** event-adapter 创建了完整 NavResult 的独立有界快照。 */
    snapshot: 'independent_bounded_copy';
    records: { actions: readonly HostActionRecord[]; events: readonly SpatialEvent[] };
    receipt: NavigationReceipt;
    gaps: TaskJournalGap[];
    diagnostics: HostEffectDiagnostic[];
  };

export type TaskJournalWriteOutcome =
  | { status: 'skipped'; gaps: TaskJournalGap[] }
  | { status: 'refused'; gaps: TaskJournalGap[] }
  | {
    status: 'accepted_pending_checkpoint';
    accepted: number;
    duplicates: number;
    revision: number;
    pendingRecords: number;
    pendingBytes: number;
    receipt: NavigationReceipt;
    gaps: TaskJournalGap[];
  }
  | {
    status: 'rejected';
    error: PersistenceErrorFacts;
    /** 与传入记录相同的引用；调用者仍持有它们以便显式重试。 */
    records: { actions: readonly HostActionRecord[]; events: readonly SpatialEvent[] };
    receipt: NavigationReceipt;
    gaps: TaskJournalGap[];
  };

export interface TaskJournalProducerOptions {
  sink: PreparedJournalSink;
  /**
   * 显式动作证据来源。返回 undefined 表示“本任务没有可用的已确认证据”，
   * 生产结果会是 `missing_action_evidence`，而不是写空数组。
   */
  evidenceFor?: (fact: TaskCompletionFact) => NavigationActionEvidence | undefined;
  /** 可选的有界报告回调（不创建文件/定时器）；每次生产结果都会带缺口。 */
  report?: (outcome: TaskJournalWriteOutcome, fact: TaskCompletionFact) => void;
}

function makeGap(
  code: TaskJournalGapCode,
  detail: string,
  extra: { blocking?: boolean; limit?: number; actual?: number } = {},
): TaskJournalGap {
  return {
    code,
    detail,
    blocking: extra.blocking ?? true,
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
  };
}

/** event-adapter 的缺口结构直接兼容；保留其 blocking/limit 事实。 */
function fromAdapter(gap: PreparationGap): TaskJournalGap {
  return gap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readVec(value: unknown): Vec3Like | null {
  if (!isRecord(value)) return null;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

function readArrival(value: unknown): WalkToArrival | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'exact') return { kind: 'exact' };
  if (value.kind === 'near' && isFiniteNumber(value.radius) && value.radius > 0) {
    return { kind: 'near', radius: value.radius };
  }
  return null;
}

function readDeadlineField(value: unknown): { ok: true; field: { deadlineMs?: number } } | { ok: false } {
  if (value === undefined) return { ok: true, field: {} };
  if (!isFiniteNumber(value)) return { ok: false };
  // 只透传；有限性/正数关系由 event-adapter 的 capture 边界统一校验一次。
  return { ok: true, field: { deadlineMs: value } };
}

type RequestRead =
  | { ok: true; request: OriginalNavigationRequest; target: Vec3Like }
  | { ok: false; gaps: TaskJournalGap[] };

/**
 * 从归一化后的 TaskInfo.args 重建进入 capture 边界的请求。args 是未知边界，
 * 这里只做一次形状读取；预算、目标一致性与上限由 event-adapter 再校验。
 * walk_known_route 的解析目标不在 args 里，必须由结果显式给出。
 */
function readNavigationRequest(skill: string, args: unknown, result: unknown): RequestRead {
  if (!isRecord(args)) {
    return { ok: false, gaps: [makeGap('invalid_request', 'task.args must be the normalized navigation argument object')] };
  }
  if (skill === 'walk_to') {
    const to = readVec(args.to);
    const arrival = readArrival(args.arrival);
    if (to === null || arrival === null) {
      return { ok: false, gaps: [makeGap('invalid_request', 'walk_to requires a finite to and explicit exact/near arrival')] };
    }
    const deadline = readDeadlineField(args.deadlineMs);
    if (!deadline.ok) {
      return { ok: false, gaps: [makeGap('invalid_request', 'walk_to.deadlineMs must be a finite number when present')] };
    }
    return {
      ok: true,
      request: { skill: 'walk_to', to, arrival, ...deadline.field },
      target: { ...to },
    };
  }
  if (skill === 'walk_route') {
    if (!Array.isArray(args.points)) {
      return { ok: false, gaps: [makeGap('invalid_request', 'walk_route.points must be the normalized ordered point array')] };
    }
    const points = Array.from(args.points, readVec);
    const badIndex = points.findIndex((point) => point === null);
    if (badIndex >= 0) {
      return { ok: false, gaps: [makeGap('invalid_request', `walk_route.points[${badIndex}] must be a finite {x,y,z}`)] };
    }
    const typed = points.filter((point): point is Vec3Like => point !== null);
    const last = typed[typed.length - 1];
    if (last === undefined) {
      return { ok: false, gaps: [makeGap('invalid_request', 'walk_route requires at least one ordered point')] };
    }
    const deadline = readDeadlineField(args.deadlineMs);
    if (!deadline.ok) {
      return { ok: false, gaps: [makeGap('invalid_request', 'walk_route.deadlineMs must be a finite number when present')] };
    }
    return {
      ok: true,
      request: { skill: 'walk_route', points: typed, ...deadline.field },
      target: { ...last },
    };
  }
  const fragmentId = args.fragmentId;
  if (typeof fragmentId !== 'string' || fragmentId.length === 0) {
    return { ok: false, gaps: [makeGap('invalid_request', 'walk_known_route requires the normalized fragmentId')] };
  }
  const deadline = readDeadlineField(args.deadlineMs);
  if (!deadline.ok) {
    return { ok: false, gaps: [makeGap('invalid_request', 'walk_known_route.deadlineMs must be a finite number when present')] };
  }
  const data = isRecord(result) ? result : null;
  const target = readVec(data?.target);
  if (target === null) {
    return {
      ok: false,
      gaps: [makeGap(
        'missing_resolved_target',
        'walk_known_route has no explicit result target; the fragment endpoint cannot be inferred from args or current state',
      )],
    };
  }
  return {
    ok: true,
    request: { skill: 'walk_known_route', fragmentId, ...deadline.field },
    target,
  };
}

/** 从未知 `result.data.nav` 读到真实 NavResult；不满足可辨别结构就拒绝。 */
function readNavResult(value: unknown): NavResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.outcome !== 'string' || !NAV_OUTCOMES.has(value.outcome)) return null;
  if (!Array.isArray(value.trace) || typeof value.confirmed !== 'boolean' || typeof value.message !== 'string') return null;
  if (value.outcome === 'ARRIVED') {
    if (readVec(value.lastPosition) === null || !isRecord(value.lastObservation)) return null;
  } else if (value.outcome !== 'PARTIAL' && !isRecord(value.problem)) {
    // PARTIAL 的 problem 是可选的；其余失败终态必须带结构化 problem。
    return null;
  }
  return value as unknown as NavResult;
}

function sameScope(
  left: { worldId: string; dim: string; sessionId: string },
  right: { worldId: string; dim: string; sessionId: string },
): boolean {
  return left.worldId === right.worldId && left.dim === right.dim && left.sessionId === right.sessionId;
}

/** 只从真实 NavResult.consumption 派生实测消费；缺失时保留“未知”，不填零。 */
function deriveConsumption(nav: NavResult): ConsumptionEvidence | undefined {
  const reported = nav.consumption;
  if (reported === undefined) return undefined;
  return {
    kind: 'measured',
    placed: reported.placed.map((item) => ({ pos: { ...item.pos }, name: item.name })),
    ...(reported.durabilityLost !== undefined ? { durabilityLost: reported.durabilityLost } : {}),
    ...(reported.digMs !== undefined ? { digMs: reported.digMs } : {}),
  };
}

/**
 * 纯准备：把已结算任务事实转成一条宿主 ActionRecord。没有显式 `evidence`
 * （消费/子动作/已观测变化）时不写动作；没有真实 startScope/nav 时拒绝。
 */
export function prepareTaskJournalRecords(
  fact: TaskCompletionFact,
  evidence?: NavigationActionEvidence,
): TaskJournalPreparation {
  const { task, result } = fact;
  if (!NAVIGATION_SKILLS.has(task.skill)) {
    return {
      status: 'skipped',
      gaps: [makeGap('unsupported_skill', `skill ${task.skill} is not a supported navigation action`, { blocking: false })],
    };
  }
  if (fact.lateCompletion) {
    return {
      status: 'refused',
      gaps: [makeGap(
        'late_completion',
        'late completion cannot be attributed: the task no longer owns the current scope and end-state facts belong to another planVersion',
      )],
    };
  }
  const startScope = fact.startScope;
  if (startScope === null) {
    return {
      status: 'refused',
      gaps: [makeGap('missing_start_scope', 'no measured start scope/position was captured at dispatch; current state is not a substitute')],
    };
  }
  if (fact.endScope !== null && !sameScope(fact.endScope, startScope)) {
    return {
      status: 'refused',
      gaps: [makeGap('completion_scope_mismatch', 'measured end scope differs from the dispatch scope; completion cannot be attributed')],
    };
  }

  const requestRead = readNavigationRequest(task.skill, task.args, result.data);
  if (!requestRead.ok) return { status: 'refused', gaps: requestRead.gaps };
  const { request, target } = requestRead;

  const data = isRecord(result.data) ? result.data : null;
  const nav = readNavResult(data?.nav);
  if (nav === null) {
    return {
      status: 'refused',
      gaps: [makeGap('missing_nav_result', 'result.data.nav must be the real returned NavResult; it is never reconstructed from status/position')],
    };
  }
  const lastObservation = nav.lastObservation;
  if (lastObservation !== undefined && !sameScope(lastObservation, startScope)) {
    return {
      status: 'refused',
      gaps: [makeGap('nav_scope_mismatch', 'NavResult.lastObservation scope differs from the dispatch scope; it cannot be attributed to this action')],
    };
  }
  if (evidence === undefined) {
    return {
      status: 'refused',
      gaps: [makeGap('missing_action_evidence', 'subActions and observedChanges are not present in the task result; they are not written as empty arrays')],
    };
  }

  const gaps: TaskJournalGap[] = [];
  if (fact.endScope === null) {
    gaps.push(makeGap(
      'missing_end_scope',
      'no measured end scope was available; the record keeps only the dispatch scope and writes no end scope',
      { blocking: false },
    ));
  }

  // 只检查有界前缀；超限交给 event-adapter 报告 limit_exceeded，不遍历超限数组。
  const observed = evidence.observedChanges;
  if (Array.isArray(observed)) {
    const checked = Math.min(observed.length, 32);
    for (let i = 0; i < checked; i += 1) {
      const observation = observed[i];
      if (observation !== undefined && !sameScope(observation, startScope)) {
        return {
          status: 'refused',
          gaps: [makeGap('evidence_scope_mismatch', `observedChanges[${i}] belongs to another scope; it is not attributed to this action`)],
        };
      }
    }
  }

  const derivedConsumption = evidence.consumption === undefined ? deriveConsumption(nav) : undefined;
  const resolvedEvidence: NavigationActionEvidence = derivedConsumption === undefined
    ? evidence
    : { ...evidence, consumption: derivedConsumption };

  const arrival: WalkToArrival = request.skill === 'walk_to' ? request.arrival : { kind: 'exact' };
  const delegation: ParsedNavigationDelegation = {
    requestedTarget: request.skill === 'walk_known_route' ? request.fragmentId : { ...target },
    target: { ...target },
    allowedModes: ['walk'],
    arrival,
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
  };
  const budget: OriginalExecutionBudget = {
    taskStartedAt: task.startedAt,
    taskDeadline: task.deadline,
    effectiveDeadline: Math.min(request.deadlineMs ?? task.deadline, task.deadline),
  };

  const capture = captureNavigationReceipt({
    // 任务 id 本身不是调用身份；planVersion 让同一任务重试/重放不互相覆盖。
    invocationId: `${task.id}@v${task.planVersion}`,
    taskId: task.id,
    planVersion: task.planVersion,
    source: task.source,
    ...(task.stepId !== undefined ? { parentActionId: task.stepId } : {}),
    // 动作开始时的实测时间；不是结束时间或当前墙钟。
    ts: task.startedAt,
    request,
    delegation,
    originalStart: {
      worldId: startScope.worldId,
      dim: startScope.dim,
      sessionId: startScope.sessionId,
      pos: { ...startScope.pos },
      observedAt: startScope.at,
    },
    budget,
  });
  if (capture.status === 'refused') {
    return { status: 'refused', gaps: capture.gaps.map(fromAdapter) };
  }

  const prepared = prepareNavigationAction(capture.receipt, nav, resolvedEvidence);
  if (prepared.status === 'unrecordable') {
    return { status: 'refused', gaps: prepared.gaps.map(fromAdapter) };
  }
  return {
    status: 'ready',
    snapshot: prepared.snapshot,
    records: { actions: [prepared.record], events: [] },
    receipt: prepared.receipt,
    gaps: [...gaps, ...prepared.gaps.map(fromAdapter)],
    diagnostics: prepared.diagnostics,
  };
}

/**
 * 创建一个显式生产者回调；调用方必须自行选择是否把它注入 Arbiter（默认不注入）。
 * 入队只走传入的 `sink.journal.recordBatch`；返回 `accepted_pending_checkpoint`
 * 绝不改写成 `saved`。没有任何定时器、重试或隐式异步。
 */
export function createTaskJournalProducer(
  options: TaskJournalProducerOptions,
): (fact: TaskCompletionFact) => TaskJournalWriteOutcome {
  return (fact) => {
    const evidence = options.evidenceFor?.(fact);
    const prepared = prepareTaskJournalRecords(fact, evidence);
    if (prepared.status !== 'ready') {
      options.report?.(prepared, fact);
      return prepared;
    }
    const enqueued = enqueuePreparedFacts(options.sink, prepared.records);
    if (enqueued.status === 'accepted_pending_checkpoint') {
      const outcome: TaskJournalWriteOutcome = {
        status: 'accepted_pending_checkpoint',
        accepted: enqueued.accepted,
        duplicates: enqueued.duplicates,
        revision: enqueued.revision,
        pendingRecords: enqueued.pendingRecords,
        pendingBytes: enqueued.pendingBytes,
        receipt: prepared.receipt,
        gaps: prepared.gaps,
      };
      options.report?.(outcome, fact);
      return outcome;
    }
    const outcome: TaskJournalWriteOutcome = {
      status: 'rejected',
      error: enqueued.error,
      records: enqueued.records,
      receipt: prepared.receipt,
      gaps: prepared.gaps,
    };
    options.report?.(outcome, fact);
    return outcome;
  };
}
