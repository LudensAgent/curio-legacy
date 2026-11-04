/**
 * 显式生产者适配层：把一次真实导航调用、一次真实观测变化和一次真实观测缺口
 * 准备成可交给 `SpatialSession.journal.recordBatch` 的固定记录。
 *
 * 本模块只做“准备”，不订阅任何运行时事件，不创建 store/worker/定时器，也不
 * 写入游戏、配置或真实记忆文件。缺少原始委托、原始作用域、原始采样时间、执行
 * 预算或真实证据时，返回结构化缺口；绝不用当前状态、墙钟时间、trace[0] 或
 * 请求目标补齐。所有 import 都是 type-only；source 侧因此不会加载 Arbiter 或配置。
 *
 * 关键边界：
 * - 原始开始位置/作用域/观测时间由调用者显式提供，绝不从 NavResult.trace[0]
 *   或当前身体状态反推。TaskInfo.startedAt 也不会被当作身体采样时间。
 * - 原始执行预算分开保存：request.deadlineMs 保持原值（可缺省），taskStartedAt
 *   与 taskDeadline 是原 TaskInfo 事实，effectiveDeadline 是解析后的实际约束。
 * - NavResult 来自真实类型化生产者，按完整结构做有界独立快照；不重造 NavResult
 *   校验器，也不把原对象和旧副本混在一条记录里。超限时拒绝并保留调用者原来的
 *   NavResult 引用，明确说明未创建快照。
 * - record.confirmed 直接保留 nav.confirmed；lastPosition 不推断为 failureAt；
 *   top-level to 只在 ARRIVED 且 LastObservation 与动作作用域一致时投影。
 * - 宿主 EffectEvidence（只有 verified/changed/reasons，没有作用域与时间）不会被
 *   提升为库 EffectEvidence；只作为有界诊断保留，并报告不可映射缺口。
 * - 观测事件使用显式边界接收序号，与原始 observationId 分开；previous 缺失表示
 *   未知，绝不表示空气；普通视觉不提供 actionId 归因；观测缺口不改变体素状态。
 * - 入队只调用传入的公共 `session.journal.recordBatch`，不接受 checkpoint/flush/
 *   close，也不改写任何身体结果或 `memoryWrite`。
 */

import type { TaskSource } from '../arbiter/arbiter.ts';
import type { BlockObservation, EffectEvidence as HostEffectEvidence } from '../adapter/types.ts';
import type {
  ActionRecord,
  EffectEvidence,
  MaterialAllowance,
  MoveMode,
  NavResult,
  Observation,
  ObservationGap,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import type {
  JournalBatchAcceptResult,
  JournalController,
  SpatialEvent,
} from 'curio-minecraft-3d-memory/storage/sqlite';

/** 固定、版本化的宿主扩展名。未知版本由读取函数显式报告。 */
export const CURIO_ACTION_EXTENSION_VERSION = 1;

/**
 * 有界快照与证据的固定形状上限。数组长度在索引任何元素之前检查；对象键数量在
 * 读取任何值之前检查；字符串长度在复制前检查。超限拒绝并报告 limit/actual。
 */
export const EVENT_ADAPTER_LIMITS = {
  maxRoutePoints: 32,
  maxTracePoints: 128,
  maxPlacedBlocks: 32,
  maxSubActions: 32,
  maxSubActionEffects: 16,
  maxObservedChanges: 32,
  maxMaterials: 32,
  maxAllowedModes: 8,
  maxBlockProperties: 64,
  maxHostEffectReasons: 16,
  maxIdChars: 512,
  maxReasonChars: 2048,
  maxStringChars: 4096,
  maxObjectKeys: 64,
  maxArrayLength: 128,
  maxSnapshotDepth: 8,
} as const;

export type WalkToArrival = { kind: 'exact' } | { kind: 'near'; radius: number };

/** 实际进入捕获边界的原始导航请求（walk_known_route 使用真实 fragmentId）。 */
export type OriginalNavigationRequest =
  | { skill: 'walk_to'; to: Vec3Like; arrival: WalkToArrival; deadlineMs?: number }
  | { skill: 'walk_route'; points: Vec3Like[]; deadlineMs?: number }
  | { skill: 'walk_known_route'; fragmentId: string; deadlineMs?: number };

/** 解析后的库风格委托约束，与 ActionRecord.delegation 同形。 */
export interface ParsedNavigationDelegation {
  requestedTarget: string | Vec3Like;
  target: Vec3Like;
  allowedModes: MoveMode[];
  arrival: WalkToArrival;
  allowDigging: boolean;
  allowPlacing: boolean;
  allowTower: boolean;
  materials: MaterialAllowance[];
  exploration: 'known_only' | 'allow_frontier';
}

/** 委托开始时实际测量到的身体起点证据；没有默认值。 */
export interface OriginalStartEvidence {
  worldId: string;
  dim: string;
  sessionId: string;
  pos: Vec3Like;
  observedAt: number;
}

/**
 * 原始执行预算事实：
 * - taskStartedAt = 原 TaskInfo.startedAt（用于解释截止时间，不是身体采样时间）；
 * - taskDeadline = 原 TaskInfo.deadline / ctx.deadline（父委托绝对期限）；
 * - effectiveDeadline = 生产者实际使用的 min(request.deadlineMs ?? taskDeadline, taskDeadline)。
 */
export interface OriginalExecutionBudget {
  taskStartedAt: number;
  taskDeadline: number;
  effectiveDeadline: number;
}

/** 调用者显式提供的导航捕获输入。 */
export interface NavigationCaptureInput {
  /** 稳定、可重放的调用身份；不能只用 taskId，也不能每次重放重新生成。 */
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: TaskSource;
  parentActionId?: string;
  /** 库委托/执行身份；省略时使用调用身份，不另外生成随机值。 */
  delegationId?: string;
  /** 原始动作记录时间，由调用者提供。 */
  ts: number;
  request: OriginalNavigationRequest;
  delegation: ParsedNavigationDelegation;
  originalStart: OriginalStartEvidence;
  budget: OriginalExecutionBudget;
}

/** 捕获后的新事实快照；调用者原输入之后可变不影响它。 */
export interface NavigationReceipt {
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: TaskSource;
  parentActionId?: string;
  delegationId: string;
  ts: number;
  request: OriginalNavigationRequest;
  delegation: ParsedNavigationDelegation;
  originalStart: OriginalStartEvidence;
  budget: OriginalExecutionBudget;
}

/** 固定版本的宿主扩展，挂在实际 ActionRecord 的 `curio` 字段上。 */
export interface CurioActionExtensionV1 {
  version: typeof CURIO_ACTION_EXTENSION_VERSION;
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: TaskSource;
  request: OriginalNavigationRequest;
  originalStart: OriginalStartEvidence;
  budget: OriginalExecutionBudget;
}

/** 实际写入 journal 的宿主动作记录（库只声明基础 ActionRecord）。 */
export type HostActionRecord = ActionRecord & { curio: CurioActionExtensionV1 };

export type PreparationGapCode =
  | 'missing_invocation_identity'
  | 'invalid_invocation_identity'
  | 'missing_task_identity'
  | 'invalid_task_identity'
  | 'invalid_plan_version'
  | 'invalid_source'
  | 'invalid_ts'
  | 'missing_request'
  | 'invalid_request'
  | 'unsupported_request'
  | 'missing_delegation'
  | 'invalid_delegation'
  | 'delegation_target_mismatch'
  | 'delegation_arrival_mismatch'
  | 'missing_original_start'
  | 'invalid_original_start'
  | 'missing_original_start_time'
  | 'missing_budget'
  | 'invalid_budget'
  | 'deadline_relationship_mismatch'
  | 'limit_exceeded'
  | 'invalid_snapshot_value'
  | 'missing_consumption_evidence'
  | 'unknown_consumption_evidence'
  | 'invalid_consumption_evidence'
  | 'consumption_conflict'
  | 'missing_sub_actions'
  | 'missing_observed_changes'
  | 'invalid_nav_projection'
  | 'unmappable_host_effect_evidence'
  | 'terminal_scope_mismatch'
  | 'missing_event_identity'
  | 'invalid_sequence'
  | 'invalid_current_observation'
  | 'previous_scope_mismatch'
  | 'invalid_gap_scope'
  | 'invalid_gap_time'
  | 'invalid_gap_reason';

/** 结构化缺口；`blocking` 为 true 时不会生成记录。 */
export interface PreparationGap {
  code: PreparationGapCode;
  detail: string;
  blocking: boolean;
  limit?: number;
  actual?: number;
}

export type NavigationCaptureResult =
  | { status: 'captured'; receipt: NavigationReceipt }
  | { status: 'refused'; gaps: PreparationGap[] };

export interface PlacedBlockConsumption {
  pos: Vec3Like;
  name: string;
}

/** 调用者必须显式说明“实际已知为空”“实测消耗”或“未知”。 */
export type ConsumptionEvidence =
  | { kind: 'unknown' }
  | { kind: 'known_empty' }
  | {
    kind: 'measured';
    placed: readonly PlacedBlockConsumption[];
    durabilityLost?: number;
    digMs?: number;
  };

export interface PreparedSubAction {
  kind: string;
  at?: Vec3Like;
  block?: string;
  origin: 'agent' | 'execution_helper' | 'scheduler';
  targetRole?: 'body' | 'head' | 'support' | 'placement_target' | 'reference_face';
  outcome: 'ok' | 'noop' | 'unknown' | 'refused' | 'failed' | 'cancelled';
  /** 只能是库 EffectEvidence（带自己的作用域/时间）。 */
  effects?: readonly EffectEvidence[];
}

/** 宿主 EffectEvidence 的有界诊断保留；它不是库 EffectEvidence，也不参与动作记录。 */
export interface HostEffectDiagnostic {
  kind: 'host_effect_evidence';
  verified: boolean;
  changed: boolean;
  reasons: string[];
  omittedReasons: number;
}

/** 类型化的动作证据；未知/缺失用可选字段或 consumption.kind='unknown' 表达。 */
export interface NavigationActionEvidence {
  consumption: ConsumptionEvidence;
  subActions: readonly PreparedSubAction[];
  observedChanges: readonly Observation[];
  /** 仅用于诊断；绝不会被提升为库 EffectEvidence。 */
  hostEffectEvidence?: HostEffectEvidence;
}

export type NavigationActionPreparation =
  | {
    status: 'prepared';
    /** record.result 是独立的有界完整 NavResult 快照，不是调用者的 nav 引用。 */
    snapshot: 'independent_bounded_copy';
    record: HostActionRecord;
    receipt: NavigationReceipt;
    /** 调用者原来的 NavResult 引用，仅供诊断；不会被改写。 */
    nav: NavResult;
    gaps: PreparationGap[];
    diagnostics: HostEffectDiagnostic[];
  }
  | {
    status: 'unrecordable';
    /** 没有创建快照；nav 与（若提供）evidence 都是调用者拥有的原引用。 */
    snapshot: 'not_created';
    receipt: NavigationReceipt;
    nav: NavResult;
    evidence?: NavigationActionEvidence;
    gaps: PreparationGap[];
    diagnostics: HostEffectDiagnostic[];
  };

export interface ObservedCellEventInput {
  /** 调用者提供的稳定事件身份，在 (worldId, sessionId) 内唯一。 */
  id: string;
  /** 显式边界接收序号；与 current.observationId 是不同概念。 */
  sequence: number;
  current: BlockObservation;
  /** 原始旧观测；缺失表示过去状态未知，绝不表示空气。 */
  previous?: Observation;
}

export type ObservedCellChangeEvent = Extract<SpatialEvent, { kind: 'observed_cell_change' }>;
export type ObservationGapEvent = Extract<SpatialEvent, { kind: 'observation_gap' }>;

export type ObservedCellEventPreparation =
  | { status: 'prepared'; event: ObservedCellChangeEvent }
  | { status: 'refused'; gaps: PreparationGap[] };

export type ObservationGapEventReason =
  | ObservationGap['reason']
  | 'disconnected'
  | 'paused'
  | 'scope_changed'
  | 'not_ready';

export interface ObservationGapEventInput {
  id: string;
  worldId: string;
  dim: string;
  sessionId: string;
  /** 原始生命周期边界/观测时间，由调用者提供。 */
  observedAt: number;
  reason: ObservationGapEventReason;
  pos?: Vec3Like;
}

export type ObservationGapEventPreparation =
  | { status: 'prepared'; event: ObservationGapEvent }
  | { status: 'refused'; gaps: PreparationGap[] };

export interface PreparedJournalFacts {
  actions?: readonly HostActionRecord[];
  events?: readonly SpatialEvent[];
}

export interface PersistenceErrorFacts {
  kind: string;
  name: string;
  message: string;
}

export type EnqueuePreparedResult =
  | {
    status: 'accepted_pending_checkpoint';
    accepted: number;
    duplicates: number;
    revision: number;
    pendingRecords: number;
    pendingBytes: number;
  }
  | {
    status: 'rejected';
    error: PersistenceErrorFacts;
    /** 与传入记录相同的引用；库的批次验证是原子拒绝，调用者仍持有它们以便显式重试。 */
    records: { actions: readonly HostActionRecord[]; events: readonly SpatialEvent[] };
  };

export interface PreparedJournalSink {
  readonly journal: Pick<JournalController, 'recordBatch'>;
}

export type CurioActionExtensionRead =
  | { status: 'ok'; extension: CurioActionExtensionV1 }
  | { status: 'missing' }
  | { status: 'unsupported_version'; version: unknown }
  | { status: 'malformed'; errors: string[] };

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; gaps: PreparationGap[] };

type SnapshotResult<T> =
  | { ok: true; value: T }
  | { ok: false; gap: PreparationGap };

const MOVE_MODES = new Set<MoveMode>(['walk', 'jump', 'sneak', 'swim', 'climb', 'ladder', 'drop']);
const GAP_REASONS = new Set<ObservationGapEventReason>([
  'out_of_view', 'occluded', 'too_dark', 'unloaded', 'budget_not_scanned', 'unknown',
  'disconnected', 'paused', 'scope_changed', 'not_ready',
]);

function makeGap(
  code: PreparationGapCode,
  detail: string,
  extra: { blocking?: boolean; limit?: number; actual?: number } = {},
): PreparationGap {
  return {
    code,
    detail,
    blocking: extra.blocking ?? true,
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
  };
}

function invalid<T>(...gaps: PreparationGap[]): ValidationResult<T> {
  return { ok: false, gaps };
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTaskSource(value: unknown): value is TaskSource {
  return value === 'llm' || value === 'rule' || value === 'filler' || value === 'reflex' || value === 'user';
}

function isMoveMode(value: unknown): value is MoveMode {
  return typeof value === 'string' && MOVE_MODES.has(value as MoveMode);
}

function isGapReason(value: unknown): value is ObservationGapEventReason {
  return typeof value === 'string' && GAP_REASONS.has(value as ObservationGapEventReason);
}

function readVec(value: unknown): Vec3Like | null {
  if (!isRecord(value)) return null;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

function sameVec(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameArrival(a: WalkToArrival, b: WalkToArrival): boolean {
  return a.kind === b.kind && (a.kind === 'exact' || (b.kind === 'near' && a.radius === b.radius));
}

function readArrival(value: unknown): WalkToArrival | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'exact') return { kind: 'exact' };
  if (value.kind === 'near' && isFiniteNumber(value.radius) && value.radius > 0) {
    return { kind: 'near', radius: value.radius };
  }
  return null;
}

function readDeadline(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!isFiniteNumber(value) || value <= 0) return { ok: false };
  return { ok: true, value };
}

function readVecList(value: unknown, what: string, limit: number): ValidationResult<Vec3Like[]> {
  if (!Array.isArray(value)) {
    return invalid(makeGap('invalid_request', `${what} must be an array of {x,y,z}`));
  }
  if (value.length > limit) {
    return invalid(makeGap('limit_exceeded', `${what} exceeds the fixed point limit`, { limit, actual: value.length }));
  }
  const items = value.map(readVec);
  const badIndex = items.findIndex((item) => item === null);
  if (badIndex >= 0) {
    return invalid(makeGap('invalid_request', `${what}[${badIndex}] must be a finite {x,y,z}`));
  }
  return valid(items.filter((item): item is Vec3Like => item !== null));
}

function readOriginalRequest(value: unknown): ValidationResult<OriginalNavigationRequest> {
  if (!isRecord(value)) {
    return invalid(makeGap('missing_request', 'the original navigation request must be an object'));
  }
  const skill = value.skill;
  if (skill === 'walk_to') {
    const to = readVec(value.to);
    if (to === null) {
      return invalid(makeGap('invalid_request', 'walk_to.to must be a finite {x,y,z}'));
    }
    const arrival = readArrival(value.arrival);
    if (arrival === null) {
      return invalid(makeGap('invalid_request', 'walk_to.arrival must be {kind:"exact"} or {kind:"near",radius>0}'));
    }
    const deadline = readDeadline(value.deadlineMs);
    if (!deadline.ok) {
      return invalid(makeGap('invalid_request', 'walk_to.deadlineMs must be a positive finite number when present'));
    }
    return valid({ skill: 'walk_to', to, arrival, ...(deadline.value !== undefined ? { deadlineMs: deadline.value } : {}) });
  }
  if (skill === 'walk_route') {
    const points = readVecList(value.points, 'walk_route.points', EVENT_ADAPTER_LIMITS.maxRoutePoints);
    if (!points.ok) return points;
    if (points.value.length < 2) {
      return invalid(makeGap('invalid_request', 'walk_route.points must contain at least two ordered points'));
    }
    const deadline = readDeadline(value.deadlineMs);
    if (!deadline.ok) {
      return invalid(makeGap('invalid_request', 'walk_route.deadlineMs must be a positive finite number when present'));
    }
    return valid({ skill: 'walk_route', points: points.value, ...(deadline.value !== undefined ? { deadlineMs: deadline.value } : {}) });
  }
  if (skill === 'walk_known_route') {
    const fragmentId = value.fragmentId;
    if (!isNonEmptyString(fragmentId)) {
      const detail = value.pathId !== undefined
        ? 'walk_known_route requires fragmentId; pathId is not the actual parameter'
        : 'walk_known_route requires a non-empty fragmentId';
      return invalid(makeGap('invalid_request', detail));
    }
    if (fragmentId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
      return invalid(makeGap('limit_exceeded', 'walk_known_route.fragmentId is too long', {
        limit: EVENT_ADAPTER_LIMITS.maxIdChars, actual: fragmentId.length,
      }));
    }
    const deadline = readDeadline(value.deadlineMs);
    if (!deadline.ok) {
      return invalid(makeGap('invalid_request', 'walk_known_route.deadlineMs must be a positive finite number when present'));
    }
    return valid({
      skill: 'walk_known_route',
      fragmentId,
      ...(deadline.value !== undefined ? { deadlineMs: deadline.value } : {}),
    });
  }
  return invalid(makeGap('unsupported_request', 'original navigation request skill must be walk_to, walk_route or walk_known_route'));
}

function readRequestedTarget(value: unknown): string | Vec3Like | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.length <= EVENT_ADAPTER_LIMITS.maxIdChars ? value : null;
  }
  return readVec(value);
}

function readMaterialAllowance(value: unknown): MaterialAllowance | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  const maxCount = value.maxCount;
  if (!isNonEmptyString(name) || name.length > EVENT_ADAPTER_LIMITS.maxIdChars) return null;
  if (!isFiniteNumber(maxCount) || maxCount < 0) return null;
  return { name, maxCount };
}

function readDelegation(value: unknown): ValidationResult<ParsedNavigationDelegation> {
  if (!isRecord(value)) {
    return invalid(makeGap('missing_delegation', 'the parsed navigation delegation must be an object'));
  }
  const requestedTarget = readRequestedTarget(value.requestedTarget);
  if (requestedTarget === null) {
    return invalid(makeGap('invalid_delegation', 'delegation.requestedTarget must be a non-empty string or finite {x,y,z}'));
  }
  const target = readVec(value.target);
  if (target === null) {
    return invalid(makeGap('invalid_delegation', 'delegation.target must be a finite {x,y,z}'));
  }
  if (!Array.isArray(value.allowedModes) || value.allowedModes.length === 0) {
    return invalid(makeGap('invalid_delegation', 'delegation.allowedModes must be a non-empty array'));
  }
  if (value.allowedModes.length > EVENT_ADAPTER_LIMITS.maxAllowedModes) {
    return invalid(makeGap('limit_exceeded', 'delegation.allowedModes exceeds the fixed limit', {
      limit: EVENT_ADAPTER_LIMITS.maxAllowedModes, actual: value.allowedModes.length,
    }));
  }
  const modes = value.allowedModes.filter(isMoveMode);
  if (modes.length !== value.allowedModes.length) {
    return invalid(makeGap('invalid_delegation', 'delegation.allowedModes contains an unsupported move mode'));
  }
  const arrival = readArrival(value.arrival);
  if (arrival === null) {
    return invalid(makeGap('invalid_delegation', 'delegation.arrival must be {kind:"exact"} or {kind:"near",radius>0}'));
  }
  const allowDigging = value.allowDigging;
  const allowPlacing = value.allowPlacing;
  const allowTower = value.allowTower;
  if (typeof allowDigging !== 'boolean' || typeof allowPlacing !== 'boolean' || typeof allowTower !== 'boolean') {
    return invalid(makeGap('invalid_delegation', 'delegation allowDigging/allowPlacing/allowTower must be explicit booleans'));
  }
  if (!Array.isArray(value.materials)) {
    return invalid(makeGap('invalid_delegation', 'delegation.materials must be an array'));
  }
  if (value.materials.length > EVENT_ADAPTER_LIMITS.maxMaterials) {
    return invalid(makeGap('limit_exceeded', 'delegation.materials exceeds the fixed limit', {
      limit: EVENT_ADAPTER_LIMITS.maxMaterials, actual: value.materials.length,
    }));
  }
  const materials = value.materials.map(readMaterialAllowance);
  const badMaterial = materials.findIndex((item) => item === null);
  if (badMaterial >= 0) {
    return invalid(makeGap('invalid_delegation', `delegation.materials[${badMaterial}] must be {name, maxCount>=0}`));
  }
  const exploration = value.exploration;
  if (exploration !== 'known_only' && exploration !== 'allow_frontier') {
    return invalid(makeGap('invalid_delegation', 'delegation.exploration must be known_only or allow_frontier'));
  }
  return valid({
    requestedTarget,
    target,
    allowedModes: modes,
    arrival,
    allowDigging,
    allowPlacing,
    allowTower,
    materials: materials.filter((item): item is MaterialAllowance => item !== null),
    exploration,
  });
}

function readOriginalStart(value: unknown): ValidationResult<OriginalStartEvidence> {
  if (!isRecord(value)) {
    return invalid(makeGap('missing_original_start', 'originalStart must be captured explicitly; it is never inferred from current state or trace[0]'));
  }
  const worldId = value.worldId;
  const dim = value.dim;
  const sessionId = value.sessionId;
  if (!isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return invalid(makeGap('invalid_original_start', 'originalStart requires non-empty worldId, dim and sessionId'));
  }
  const pos = readVec(value.pos);
  if (pos === null) {
    return invalid(makeGap('invalid_original_start', 'originalStart.pos must be a finite {x,y,z} measured at the start'));
  }
  const observedAt = value.observedAt;
  if (!isFiniteNumber(observedAt)) {
    return invalid(makeGap('missing_original_start_time', 'originalStart.observedAt must be the actual start observation time; no current-time fallback'));
  }
  return valid({ worldId, dim, sessionId, pos, observedAt });
}

/**
 * 预算关系检查：effectiveDeadline 必须等于生产者实际使用的
 * min(request.deadlineMs ?? taskDeadline, taskDeadline)。request.deadlineMs 仍单独
 * 保留在 request 中，缺失时不会被填成 0 或当前时间。
 */
function readBudget(value: unknown, request: OriginalNavigationRequest): ValidationResult<OriginalExecutionBudget> {
  if (!isRecord(value)) {
    return invalid(makeGap('missing_budget', 'budget must supply the original taskStartedAt, taskDeadline and effectiveDeadline'));
  }
  const taskStartedAt = value.taskStartedAt;
  const taskDeadline = value.taskDeadline;
  const effectiveDeadline = value.effectiveDeadline;
  if (!isFiniteNumber(taskStartedAt) || !isFiniteNumber(taskDeadline) || !isFiniteNumber(effectiveDeadline)) {
    return invalid(makeGap('invalid_budget', 'budget values must be finite epoch milliseconds'));
  }
  if (taskDeadline < taskStartedAt) {
    return invalid(makeGap('invalid_budget', 'taskDeadline must not precede taskStartedAt'));
  }
  const expected = Math.min(request.deadlineMs ?? taskDeadline, taskDeadline);
  if (effectiveDeadline !== expected) {
    return invalid(makeGap(
      'deadline_relationship_mismatch',
      'effectiveDeadline must equal min(request.deadlineMs ?? taskDeadline, taskDeadline)',
    ));
  }
  return valid({ taskStartedAt, taskDeadline, effectiveDeadline });
}

/**
 * 捕获一次真实导航调用。输入必须是实际委托、解析约束、开始证据和原始预算；
 * 缺失即拒绝，不读取当前适配器状态，也不生成任何随机/默认身份。
 */
export function captureNavigationReceipt(input: NavigationCaptureInput): NavigationCaptureResult {
  const raw: unknown = input;
  if (!isRecord(raw)) {
    return { status: 'refused', gaps: [makeGap('missing_invocation_identity', 'capture input must be an object')] };
  }

  const invocationId = raw.invocationId;
  if (!isNonEmptyString(invocationId)) {
    return { status: 'refused', gaps: [makeGap('missing_invocation_identity', 'invocationId must be a stable caller-supplied identity')] };
  }
  if (invocationId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('limit_exceeded', 'invocationId is too long', {
      limit: EVENT_ADAPTER_LIMITS.maxIdChars, actual: invocationId.length,
    })] };
  }
  const taskId = raw.taskId;
  if (!isNonEmptyString(taskId)) {
    return { status: 'refused', gaps: [makeGap('missing_task_identity', 'taskId must be a non-empty string')] };
  }
  if (taskId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('limit_exceeded', 'taskId is too long', {
      limit: EVENT_ADAPTER_LIMITS.maxIdChars, actual: taskId.length,
    })] };
  }
  if (invocationId === taskId) {
    return { status: 'refused', gaps: [makeGap('invalid_invocation_identity', 'invocationId must not equal taskId; reused task ids are not a stable invocation identity')] };
  }
  const planVersion = raw.planVersion;
  if (typeof planVersion !== 'number' || !Number.isSafeInteger(planVersion) || planVersion < 0) {
    return { status: 'refused', gaps: [makeGap('invalid_plan_version', 'planVersion must be a non-negative safe integer')] };
  }
  const source = raw.source;
  if (!isTaskSource(source)) {
    return { status: 'refused', gaps: [makeGap('invalid_source', 'source must be the original llm/rule/filler/reflex/user TaskSource')] };
  }
  const ts = raw.ts;
  if (!isFiniteNumber(ts)) {
    return { status: 'refused', gaps: [makeGap('invalid_ts', 'ts must be the original finite action time supplied by the caller')] };
  }
  const parentActionId = raw.parentActionId;
  if (parentActionId !== undefined && (!isNonEmptyString(parentActionId) || parentActionId.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return { status: 'refused', gaps: [makeGap('invalid_task_identity', 'parentActionId must be a non-empty string within the id limit when present')] };
  }
  const explicitDelegationId = raw.delegationId;
  if (explicitDelegationId !== undefined && (!isNonEmptyString(explicitDelegationId) || explicitDelegationId.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return { status: 'refused', gaps: [makeGap('invalid_invocation_identity', 'delegationId must be a non-empty string within the id limit when present')] };
  }

  const request = readOriginalRequest(raw.request);
  if (!request.ok) return { status: 'refused', gaps: request.gaps };
  const delegation = readDelegation(raw.delegation);
  if (!delegation.ok) return { status: 'refused', gaps: delegation.gaps };
  const originalStart = readOriginalStart(raw.originalStart);
  if (!originalStart.ok) return { status: 'refused', gaps: originalStart.gaps };
  const budget = readBudget(raw.budget, request.value);
  if (!budget.ok) return { status: 'refused', gaps: budget.gaps };

  if (request.value.skill === 'walk_to') {
    if (!sameVec(delegation.value.target, request.value.to)) {
      return { status: 'refused', gaps: [makeGap('delegation_target_mismatch', 'walk_to parsed target must equal the original to; no requested-target fallback')] };
    }
    if (!sameArrival(delegation.value.arrival, request.value.arrival)) {
      return { status: 'refused', gaps: [makeGap('delegation_arrival_mismatch', 'walk_to parsed arrival must preserve the original exact/near tolerance')] };
    }
    if (typeof delegation.value.requestedTarget !== 'string' && !sameVec(delegation.value.requestedTarget, request.value.to)) {
      return { status: 'refused', gaps: [makeGap('delegation_target_mismatch', 'walk_to requestedTarget must preserve the original to')] };
    }
  } else if (request.value.skill === 'walk_route') {
    const last = request.value.points[request.value.points.length - 1];
    if (last === undefined || !sameVec(delegation.value.target, last)) {
      return { status: 'refused', gaps: [makeGap('delegation_target_mismatch', 'walk_route parsed target must be the last ordered point')] };
    }
    if (delegation.value.arrival.kind !== 'exact') {
      return { status: 'refused', gaps: [makeGap('delegation_arrival_mismatch', 'walk_route preserves the full ordered route and uses exact arrival')] };
    }
  } else {
    if (delegation.value.requestedTarget !== request.value.fragmentId) {
      return { status: 'refused', gaps: [makeGap('delegation_target_mismatch', 'walk_known_route requestedTarget must be the real fragmentId')] };
    }
    if (delegation.value.arrival.kind !== 'exact') {
      return { status: 'refused', gaps: [makeGap('delegation_arrival_mismatch', 'walk_known_route uses exact arrival')] };
    }
  }

  const receipt: NavigationReceipt = {
    invocationId,
    taskId,
    planVersion,
    source,
    ...(parentActionId !== undefined ? { parentActionId } : {}),
    delegationId: explicitDelegationId ?? invocationId,
    ts,
    request: request.value,
    delegation: delegation.value,
    originalStart: originalStart.value,
    budget: budget.value,
  };
  return { status: 'captured', receipt };
}

function copyArrival(arrival: WalkToArrival): WalkToArrival {
  return arrival.kind === 'exact' ? { kind: 'exact' } : { kind: 'near', radius: arrival.radius };
}

function copyOriginalRequest(request: OriginalNavigationRequest): OriginalNavigationRequest {
  if (request.skill === 'walk_to') {
    return {
      skill: 'walk_to',
      to: { ...request.to },
      arrival: copyArrival(request.arrival),
      ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    };
  }
  if (request.skill === 'walk_route') {
    return {
      skill: 'walk_route',
      points: request.points.map((point) => ({ ...point })),
      ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
    };
  }
  return {
    skill: 'walk_known_route',
    fragmentId: request.fragmentId,
    ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
  };
}

function copyDelegation(delegation: ParsedNavigationDelegation): ActionRecord['delegation'] {
  return {
    requestedTarget: typeof delegation.requestedTarget === 'string'
      ? delegation.requestedTarget
      : { ...delegation.requestedTarget },
    target: { ...delegation.target },
    allowedModes: [...delegation.allowedModes],
    arrival: copyArrival(delegation.arrival),
    allowDigging: delegation.allowDigging,
    allowPlacing: delegation.allowPlacing,
    allowTower: delegation.allowTower,
    materials: delegation.materials.map((material) => ({ ...material })),
    exploration: delegation.exploration,
  };
}

function copyStart(start: OriginalStartEvidence): OriginalStartEvidence {
  return {
    worldId: start.worldId,
    dim: start.dim,
    sessionId: start.sessionId,
    pos: { ...start.pos },
    observedAt: start.observedAt,
  };
}

function copyBudget(budget: OriginalExecutionBudget): OriginalExecutionBudget {
  return {
    taskStartedAt: budget.taskStartedAt,
    taskDeadline: budget.taskDeadline,
    effectiveDeadline: budget.effectiveDeadline,
  };
}

function limitSnapshotGap(what: string, limit: number, actual: number): PreparationGap {
  return makeGap('limit_exceeded', `${what} exceeds the fixed snapshot limit`, { limit, actual });
}

/**
 * 有界完整快照：保留类型化值的完整结构，只在读取前检查数组长度、对象键数量、
 * 字符串/键长度和嵌套深度。它不是 schema 校验器；不认识的字段照常复制。
 * 数组在索引任何元素之前先检查 length，因此超限数组的元素 getter 不会被调用。
 */
function copySnapshotValue(value: unknown, depth: number): SnapshotResult<unknown> {
  if (depth > EVENT_ADAPTER_LIMITS.maxSnapshotDepth) {
    return { ok: false, gap: limitSnapshotGap('snapshot depth', EVENT_ADAPTER_LIMITS.maxSnapshotDepth, depth) };
  }
  if (value === null) return { ok: true, value: null };
  switch (typeof value) {
    case 'string':
      return value.length > EVENT_ADAPTER_LIMITS.maxStringChars
        ? { ok: false, gap: limitSnapshotGap('snapshot string', EVENT_ADAPTER_LIMITS.maxStringChars, value.length) }
        : { ok: true, value };
    case 'number':
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, gap: makeGap('invalid_snapshot_value', 'snapshot numbers must be finite') };
    case 'boolean':
      return { ok: true, value };
    case 'undefined':
      return { ok: false, gap: makeGap('invalid_snapshot_value', 'undefined is not a journal-safe value') };
    case 'bigint':
    case 'symbol':
    case 'function':
      return { ok: false, gap: makeGap('invalid_snapshot_value', `${typeof value} is not a journal-safe value`) };
    default:
      break;
  }
  if (Array.isArray(value)) {
    if (value.length > EVENT_ADAPTER_LIMITS.maxArrayLength) {
      return { ok: false, gap: limitSnapshotGap('snapshot array', EVENT_ADAPTER_LIMITS.maxArrayLength, value.length) };
    }
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = copySnapshotValue(value[i], depth + 1);
      if (!item.ok) return item;
      out.push(item.value);
    }
    return { ok: true, value: out };
  }
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, gap: makeGap('invalid_snapshot_value', 'snapshot objects must be plain objects') };
  }
  const keys = Object.keys(object);
  if (keys.length > EVENT_ADAPTER_LIMITS.maxObjectKeys) {
    return { ok: false, gap: limitSnapshotGap('snapshot object keys', EVENT_ADAPTER_LIMITS.maxObjectKeys, keys.length) };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
      return { ok: false, gap: limitSnapshotGap('snapshot object key', EVENT_ADAPTER_LIMITS.maxIdChars, key.length) };
    }
    const item = object[key];
    // 对象中的 undefined 与 JSON 语义一致（省略），不是伪造值。
    if (item === undefined) continue;
    const copied = copySnapshotValue(item, depth + 1);
    if (!copied.ok) return copied;
    out[key] = copied.value;
  }
  return { ok: true, value: out };
}

function snapshotTyped<T>(value: T): SnapshotResult<T> {
  const copied = copySnapshotValue(value, 0);
  if (!copied.ok) return copied;
  // 快照保留原结构，仅做了资源边界检查；类型由调用点拥有的 typed 值保证。
  return { ok: true, value: copied.value as T };
}

function resolveConsumption(
  evidence: ConsumptionEvidence | undefined,
  nav: NavResult,
): ValidationResult<ActionRecord['consumption']> {
  if (evidence === undefined) {
    return invalid(makeGap('missing_consumption_evidence', 'consumption must be explicitly unknown/known_empty/measured; missing evidence is not written as []/0'));
  }
  const navConsumption = nav.consumption;
  if (evidence.kind === 'unknown') {
    return invalid(makeGap(
      'unknown_consumption_evidence',
      navConsumption === undefined
        ? 'consumption is explicitly unknown and cannot be written as []/0'
        : 'unknown consumption cannot override the actual consumption reported by the producer',
    ));
  }
  if (evidence.kind === 'known_empty') {
    if (navConsumption !== undefined
      && (navConsumption.placed.length > 0 || navConsumption.durabilityLost !== undefined || navConsumption.digMs !== undefined)) {
      return invalid(makeGap('consumption_conflict', 'known_empty evidence conflicts with the producer-reported consumption; no zero/default inserted'));
    }
    return valid({ placed: [] });
  }
  if (evidence.kind !== 'measured') {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.kind must be unknown, known_empty or measured'));
  }
  if (evidence.placed.length > EVENT_ADAPTER_LIMITS.maxPlacedBlocks) {
    return invalid(limitSnapshotGap('consumption.placed', EVENT_ADAPTER_LIMITS.maxPlacedBlocks, evidence.placed.length));
  }
  if (navConsumption !== undefined && navConsumption.placed.length > EVENT_ADAPTER_LIMITS.maxPlacedBlocks) {
    return invalid(limitSnapshotGap('NavResult.consumption.placed', EVENT_ADAPTER_LIMITS.maxPlacedBlocks, navConsumption.placed.length));
  }
  const placed: PlacedBlockConsumption[] = [];
  for (const item of evidence.placed) {
    if (item.name.length > EVENT_ADAPTER_LIMITS.maxStringChars) {
      return invalid(limitSnapshotGap('consumption placed name', EVENT_ADAPTER_LIMITS.maxStringChars, item.name.length));
    }
    placed.push({ pos: { ...item.pos }, name: item.name });
  }
  const durabilityLost = evidence.durabilityLost;
  if (durabilityLost !== undefined && (!isFiniteNumber(durabilityLost) || durabilityLost < 0)) {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.durabilityLost must be a non-negative finite number when present'));
  }
  const digMs = evidence.digMs;
  if (digMs !== undefined && (!isFiniteNumber(digMs) || digMs < 0)) {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.digMs must be a non-negative finite number when present'));
  }
  if (navConsumption !== undefined) {
    if (navConsumption.placed.length !== placed.length) {
      return invalid(makeGap('consumption_conflict', 'measured placed count differs from the producer-reported consumption'));
    }
    const mismatch = navConsumption.placed.findIndex((item, index) => {
      const other = placed[index]!;
      return !sameVec(item.pos, other.pos) || item.name !== other.name;
    });
    if (mismatch >= 0) {
      return invalid(makeGap('consumption_conflict', `measured placed[${mismatch}] position/name differs from the producer-reported consumption`));
    }
    if (navConsumption.durabilityLost !== undefined) {
      if (durabilityLost === undefined) {
        return invalid(makeGap('consumption_conflict', 'measured evidence omits the producer-reported durabilityLost; no zero/default inserted'));
      }
      if (durabilityLost !== navConsumption.durabilityLost) {
        return invalid(makeGap('consumption_conflict', 'measured durabilityLost differs from the producer-reported consumption'));
      }
    }
    if (navConsumption.digMs !== undefined) {
      if (digMs === undefined) {
        return invalid(makeGap('consumption_conflict', 'measured evidence omits the producer-reported digMs; no zero/default inserted'));
      }
      if (digMs !== navConsumption.digMs) {
        return invalid(makeGap('consumption_conflict', 'measured digMs differs from the producer-reported consumption'));
      }
    }
  }
  return valid({
    placed,
    ...(durabilityLost !== undefined ? { durabilityLost } : {}),
    ...(digMs !== undefined ? { digMs } : {}),
  });
}

function hostEffectDiagnostic(host: HostEffectEvidence | undefined): { diagnostic: HostEffectDiagnostic | null; gaps: PreparationGap[] } {
  if (host === undefined) return { diagnostic: null, gaps: [] };
  const reasons = host.reasons;
  const total = Array.isArray(reasons) ? reasons.length : 0;
  const take = Math.min(total, EVENT_ADAPTER_LIMITS.maxHostEffectReasons);
  const kept: string[] = [];
  let omitted = total - take;
  // 只检查有界前缀；不 filter/slice 整个数组，因此不会触碰超限后的元素。
  for (let i = 0; i < take; i += 1) {
    const reason = reasons[i];
    if (typeof reason !== 'string' || reason.length > EVENT_ADAPTER_LIMITS.maxReasonChars) {
      omitted += 1;
      continue;
    }
    kept.push(reason);
  }
  const gaps: PreparationGap[] = [
    makeGap(
      'unmappable_host_effect_evidence',
      'host EffectEvidence has no observation scope/time and is never promoted to library EffectEvidence; it is retained only as a bounded diagnostic',
      { blocking: false },
    ),
  ];
  if (omitted > 0) {
    gaps.push(makeGap('limit_exceeded', 'hostEffectEvidence.reasons was bounded; omitted count is explicit', {
      blocking: false,
      limit: EVENT_ADAPTER_LIMITS.maxHostEffectReasons,
      actual: total,
    }));
  }
  return {
    diagnostic: {
      kind: 'host_effect_evidence',
      verified: host.verified,
      changed: host.changed,
      reasons: kept,
      omittedReasons: omitted,
    },
    gaps,
  };
}

/**
 * 把真实类型化 NavResult 和调用者显式提供的类型化证据准备成宿主 ActionRecord。
 * NavResult 通过固定形状上限后做完整独立快照；超限时不做快照，保留调用者原引用。
 * 纯函数：不读取当前状态、不写库、不生成 ID、不改写 nav 或 `memoryWrite`。
 */
export function prepareNavigationAction(
  receipt: NavigationReceipt,
  nav: NavResult,
  input: NavigationActionEvidence,
): NavigationActionPreparation {
  const gaps: PreparationGap[] = [];
  const diagnostics: HostEffectDiagnostic[] = [];
  const evidence: NavigationActionEvidence | undefined = isRecord(input) ? input : undefined;

  // 资源/关系预检：在索引或遍历之前完成；NavResult 超限时不再处理证据。
  const trace = nav.trace;
  if (!Array.isArray(trace)) {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.trace must be an array'));
  } else if (trace.length > EVENT_ADAPTER_LIMITS.maxTracePoints) {
    gaps.push(limitSnapshotGap('NavResult.trace', EVENT_ADAPTER_LIMITS.maxTracePoints, trace.length));
  }
  const navPlaced = nav.consumption?.placed;
  if (navPlaced !== undefined && !Array.isArray(navPlaced)) {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.consumption.placed must be an array when present'));
  } else if (navPlaced !== undefined && navPlaced.length > EVENT_ADAPTER_LIMITS.maxPlacedBlocks) {
    gaps.push(limitSnapshotGap('NavResult.consumption.placed', EVENT_ADAPTER_LIMITS.maxPlacedBlocks, navPlaced.length));
  }
  if (gaps.some((gap) => gap.blocking)) {
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }

  const consumption = resolveConsumption(evidence?.consumption, nav);
  if (!consumption.ok) gaps.push(...consumption.gaps);

  const subActions = evidence?.subActions;
  if (subActions === undefined) {
    gaps.push(makeGap('missing_sub_actions', 'subActions must be explicitly supplied; missing evidence is not written as []'));
  } else if (subActions.length > EVENT_ADAPTER_LIMITS.maxSubActions) {
    gaps.push(limitSnapshotGap('subActions', EVENT_ADAPTER_LIMITS.maxSubActions, subActions.length));
  } else {
    // 只检查有界数量的子动作的 effects 长度；不做字段 schema 重校验。
    const badEffects = subActions.findIndex((action) => (action.effects?.length ?? 0) > EVENT_ADAPTER_LIMITS.maxSubActionEffects);
    if (badEffects >= 0) {
      gaps.push(limitSnapshotGap(`subActions[${badEffects}].effects`, EVENT_ADAPTER_LIMITS.maxSubActionEffects, subActions[badEffects]!.effects!.length));
    }
  }

  const observedChanges = evidence?.observedChanges;
  if (observedChanges === undefined) {
    gaps.push(makeGap('missing_observed_changes', 'observedChanges must be explicitly supplied; missing evidence is not written as []'));
  } else if (observedChanges.length > EVENT_ADAPTER_LIMITS.maxObservedChanges) {
    gaps.push(limitSnapshotGap('observedChanges', EVENT_ADAPTER_LIMITS.maxObservedChanges, observedChanges.length));
  }

  if (evidence?.hostEffectEvidence !== undefined) {
    const host = hostEffectDiagnostic(evidence.hostEffectEvidence);
    if (host.diagnostic !== null) diagnostics.push(host.diagnostic);
    gaps.push(...host.gaps);
  }

  if (gaps.some((gap) => gap.blocking)) {
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }
  if (!consumption.ok || subActions === undefined || observedChanges === undefined) {
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }

  const subActionSnapshot = snapshotTyped(subActions);
  if (!subActionSnapshot.ok) gaps.push(subActionSnapshot.gap);
  const observedChangeSnapshot = snapshotTyped(observedChanges);
  if (!observedChangeSnapshot.ok) gaps.push(observedChangeSnapshot.gap);
  if (gaps.some((gap) => gap.blocking)) {
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }
  if (!consumption.ok || !subActionSnapshot.ok || !observedChangeSnapshot.ok) {
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }

  // 全部上限通过后才创建完整 NavResult 快照；不挑字段、不保留原对象引用。
  const navSnapshot = snapshotTyped(nav);
  if (!navSnapshot.ok) {
    gaps.push(navSnapshot.gap);
    return {
      status: 'unrecordable',
      snapshot: 'not_created',
      receipt,
      nav,
      ...(evidence !== undefined ? { evidence } : {}),
      gaps,
      diagnostics,
    };
  }
  const terminal = navSnapshot.value;

  // confirmed 直接保留原值（PARTIAL/CANCELLED 也可能为 true）。
  // to 只在 ARRIVED 且真实 LastObservation 与动作作用域一致时投影；lastPosition 不推断 failureAt。
  const lastObservation = terminal.lastObservation;
  const observationScopeMatches = lastObservation !== undefined
    && lastObservation.worldId === receipt.originalStart.worldId
    && lastObservation.dim === receipt.originalStart.dim
    && lastObservation.sessionId === receipt.originalStart.sessionId;
  if (terminal.outcome === 'ARRIVED' && !observationScopeMatches) {
    gaps.push(makeGap(
      'terminal_scope_mismatch',
      'ARRIVED lastPosition is not projected to top-level to because the real LastObservation does not match the original action scope',
      { blocking: false },
    ));
  }
  const projectTo = terminal.outcome === 'ARRIVED' && observationScopeMatches;

  const extension: CurioActionExtensionV1 = {
    version: CURIO_ACTION_EXTENSION_VERSION,
    invocationId: receipt.invocationId,
    taskId: receipt.taskId,
    planVersion: receipt.planVersion,
    source: receipt.source,
    request: copyOriginalRequest(receipt.request),
    originalStart: copyStart(receipt.originalStart),
    budget: copyBudget(receipt.budget),
  };

  const record: HostActionRecord = {
    id: receipt.invocationId,
    ts: receipt.ts,
    worldId: receipt.originalStart.worldId,
    dim: receipt.originalStart.dim,
    sessionId: receipt.originalStart.sessionId,
    delegationId: receipt.delegationId,
    ...(receipt.parentActionId !== undefined ? { parentActionId: receipt.parentActionId } : {}),
    delegation: copyDelegation(receipt.delegation),
    subActions: [...subActionSnapshot.value],
    from: { ...receipt.originalStart.pos },
    ...(projectTo ? { to: { ...terminal.lastPosition } } : {}),
    trace: terminal.trace.map((step) => ({ pos: { ...step.pos }, ts: step.ts })),
    consumption: consumption.value,
    observedChanges: [...observedChangeSnapshot.value],
    ...(terminal.outcome !== 'ARRIVED' ? { failureReason: terminal.message } : {}),
    confirmed: terminal.confirmed,
    result: terminal,
    curio: extension,
  };

  return {
    status: 'prepared',
    snapshot: 'independent_bounded_copy',
    record,
    receipt,
    nav,
    gaps,
    diagnostics,
  };
}

/**
 * 把实际视锥 BlockObservation 映射为库 Observation。properties 是真实 typed
 * 字段：缺失时拒绝，不用 {} 顶替并保留 stateComplete=true。普通视觉不携带
 * actionId；序号与原始 observationId 分开。
 */
export function prepareObservedCellEvent(input: ObservedCellEventInput): ObservedCellEventPreparation {
  const id = input?.id;
  if (!isNonEmptyString(id)) {
    return { status: 'refused', gaps: [makeGap('missing_event_identity', 'event id must be a stable caller-supplied identity')] };
  }
  if (id.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [limitSnapshotGap('event id', EVENT_ADAPTER_LIMITS.maxIdChars, id.length)] };
  }
  if (!isSafeCount(input.sequence)) {
    return { status: 'refused', gaps: [makeGap('invalid_sequence', 'sequence must be the explicit non-negative boundary receive order, not observationId')] };
  }
  const current = input.current;
  if (current === null || typeof current !== 'object') {
    return { status: 'refused', gaps: [makeGap('invalid_current_observation', 'current must be an actual BlockObservation object')] };
  }
  const pos = readVec(current.pos);
  if (!isNonEmptyString(current.worldId) || current.worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(current.dimension) || current.dimension.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(current.sessionId) || current.sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(current.name) || current.name.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isFiniteNumber(current.observedAt)
    || !isSafeCount(current.observationId)
    || current.source !== 'vision'
    || pos === null) {
    return { status: 'refused', gaps: [makeGap('invalid_current_observation', 'current requires the actual typed BlockObservation scope, position, name, observationId, observedAt and source')] };
  }
  if (!isRecord(current.properties)) {
    return { status: 'refused', gaps: [makeGap(
      'invalid_current_observation',
      'BlockObservation.properties is required; missing properties are not defaulted to {} and stateComplete is not inferred',
    )] };
  }
  const propertyKeys = Object.keys(current.properties);
  if (propertyKeys.length > EVENT_ADAPTER_LIMITS.maxBlockProperties) {
    return { status: 'refused', gaps: [limitSnapshotGap('current.properties', EVENT_ADAPTER_LIMITS.maxBlockProperties, propertyKeys.length)] };
  }
  const properties: Record<string, string> = {};
  for (const key of propertyKeys) {
    if (key.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
      return { status: 'refused', gaps: [limitSnapshotGap('current.properties key', EVENT_ADAPTER_LIMITS.maxIdChars, key.length)] };
    }
    const value = current.properties[key];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { status: 'refused', gaps: [makeGap('invalid_current_observation', `current.properties.${key} must be a string, number or boolean`) ] };
    }
    const text = String(value);
    if (text.length > EVENT_ADAPTER_LIMITS.maxStringChars) {
      return { status: 'refused', gaps: [limitSnapshotGap(`current.properties.${key}`, EVENT_ADAPTER_LIMITS.maxStringChars, text.length)] };
    }
    properties[key] = text;
  }

  const observation: Observation = {
    pos,
    state: { name: current.name, properties },
    stateComplete: current.stateComplete === true,
    evidence: 'seen',
    observedAt: current.observedAt,
    source: 'vision',
    sessionId: current.sessionId,
    originObservationId: current.observationId,
    sequence: input.sequence,
    dim: current.dimension,
    worldId: current.worldId,
  };

  let previous: Observation | undefined;
  if (input.previous !== undefined) {
    if (input.previous.worldId !== current.worldId
      || input.previous.dim !== current.dimension
      || !sameVec(input.previous.pos, pos)) {
      return { status: 'refused', gaps: [makeGap('previous_scope_mismatch', 'previous observation scope/cell does not match the current event; older session/time is allowed but scope is not')] };
    }
    const copied = snapshotTyped(input.previous);
    if (!copied.ok) return { status: 'refused', gaps: [copied.gap] };
    previous = copied.value;
  }

  const event: ObservedCellChangeEvent = {
    kind: 'observed_cell_change',
    id,
    observedAt: current.observedAt,
    worldId: current.worldId,
    dim: current.dimension,
    sessionId: current.sessionId,
    pos: { ...pos },
    current: observation,
    ...(previous !== undefined ? { previous } : {}),
  };
  return { status: 'prepared', event };
}

/** 准备一条 observation_gap 事件；不改变体素状态，不使用当前作用域/发布时刻补齐。 */
export function prepareObservationGapEvent(input: ObservationGapEventInput): ObservationGapEventPreparation {
  const id = input?.id;
  if (!isNonEmptyString(id)) {
    return { status: 'refused', gaps: [makeGap('missing_event_identity', 'gap id must be a stable caller-supplied identity')] };
  }
  if (id.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [limitSnapshotGap('gap id', EVENT_ADAPTER_LIMITS.maxIdChars, id.length)] };
  }
  const worldId = input.worldId;
  const dim = input.dim;
  const sessionId = input.sessionId;
  if (!isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_scope', 'gap requires the original non-empty worldId, dim and sessionId')] };
  }
  if (!isFiniteNumber(input.observedAt)) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_time', 'gap observedAt must be the original lifecycle/observation time; publish time is not a substitute')] };
  }
  if (!isGapReason(input.reason)) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_reason', 'gap reason must be one of the actual observation/lifecycle gap reasons')] };
  }
  const pos = input.pos === undefined ? undefined : readVec(input.pos);
  if (input.pos !== undefined && pos === null) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_scope', 'gap pos must be a finite {x,y,z} when present')] };
  }
  return {
    status: 'prepared',
    event: {
      kind: 'observation_gap',
      id,
      observedAt: input.observedAt,
      worldId,
      dim,
      sessionId,
      reason: input.reason,
      ...(pos !== null && pos !== undefined ? { pos } : {}),
    },
  };
}

/**
 * 窄读取/校验宿主扩展。库的 queryActions 只声明基础 ActionRecord；这里在未知边界
 * 校验一次并返回规范化副本，未知版本或畸形元数据显式报告，绝不盲目 cast。
 */
export function readCurioActionExtension(record: unknown): CurioActionExtensionRead {
  if (!isRecord(record)) {
    return { status: 'malformed', errors: ['action record must be an object'] };
  }
  const rawExtension = record.curio;
  if (rawExtension === undefined) return { status: 'missing' };
  if (!isRecord(rawExtension)) {
    return { status: 'malformed', errors: ['curio extension must be an object'] };
  }
  if (rawExtension.version !== CURIO_ACTION_EXTENSION_VERSION) {
    return { status: 'unsupported_version', version: rawExtension.version };
  }
  const invocationId = rawExtension.invocationId;
  if (!isNonEmptyString(invocationId) || invocationId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'malformed', errors: ['curio.invocationId must be a non-empty string within the id limit'] };
  }
  const taskId = rawExtension.taskId;
  if (!isNonEmptyString(taskId) || taskId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'malformed', errors: ['curio.taskId must be a non-empty string within the id limit'] };
  }
  const planVersion = rawExtension.planVersion;
  if (typeof planVersion !== 'number' || !Number.isSafeInteger(planVersion) || planVersion < 0) {
    return { status: 'malformed', errors: ['curio.planVersion must be a non-negative safe integer'] };
  }
  const source = rawExtension.source;
  if (!isTaskSource(source)) {
    return { status: 'malformed', errors: ['curio.source must be the original llm/rule/filler/reflex/user TaskSource'] };
  }
  const request = readOriginalRequest(rawExtension.request);
  if (!request.ok) {
    return { status: 'malformed', errors: request.gaps.map((gap) => `curio.request: ${gap.detail}`) };
  }
  const originalStart = readOriginalStart(rawExtension.originalStart);
  if (!originalStart.ok) {
    return { status: 'malformed', errors: originalStart.gaps.map((gap) => `curio.originalStart: ${gap.detail}`) };
  }
  const budget = readBudget(rawExtension.budget, request.value);
  if (!budget.ok) {
    return { status: 'malformed', errors: budget.gaps.map((gap) => `curio.budget: ${gap.detail}`) };
  }
  return {
    status: 'ok',
    extension: {
      version: CURIO_ACTION_EXTENSION_VERSION,
      invocationId,
      taskId,
      planVersion,
      source,
      request: request.value,
      originalStart: originalStart.value,
      budget: budget.value,
    },
  };
}

function describePersistenceError(error: unknown): PersistenceErrorFacts {
  if (error instanceof Error) {
    const kind: unknown = (error as Error & { kind?: unknown }).kind;
    return {
      kind: typeof kind === 'string' ? kind : 'unknown',
      name: error.name,
      message: error.message,
    };
  }
  return { kind: 'unknown', name: typeof error, message: String(error) };
}

/**
 * 只通过传入的公共 `session.journal.recordBatch` 入队已准备事实。
 * acceptance 不是持久 ACK：返回 accepted_pending_checkpoint。拒绝时保留原记录引用
 * 以便显式重试；不 checkpoint/flush/close，不创建 store/worker/定时器，不重试、
 * 不去重、不重新编号。
 */
export function enqueuePreparedFacts(
  session: PreparedJournalSink,
  facts: PreparedJournalFacts,
): EnqueuePreparedResult {
  const actions = facts.actions ?? [];
  const events = facts.events ?? [];
  try {
    const result: JournalBatchAcceptResult = session.journal.recordBatch({ actions, events });
    return {
      status: 'accepted_pending_checkpoint',
      accepted: result.accepted,
      duplicates: result.duplicates,
      revision: result.revision,
      pendingRecords: result.pendingRecords,
      pendingBytes: result.pendingBytes,
    };
  } catch (error) {
    // 库的 journal 以同步异常报告 capacity/conflict/lifecycle；这里只做边界事实转述。
    return {
      status: 'rejected',
      error: describePersistenceError(error),
      records: { actions, events },
    };
  }
}
