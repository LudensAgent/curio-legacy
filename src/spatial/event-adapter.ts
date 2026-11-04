/**
 * 显式生产者适配层：把一次真实导航调用、一次真实观测变化和一次真实观测缺口
 * 准备成可交给 `SpatialSession.journal.recordBatch` 的固定记录。
 *
 * 本模块只做“准备”，不订阅任何运行时事件，不创建 store/worker/定时器，也不
 * 写入游戏、配置或真实记忆文件。缺少原始委托、原始作用域、原始采样时间或真实
 * 证据时，返回结构化缺口；绝不用当前状态、墙钟时间、trace[0] 或请求目标补齐。
 *
 * 关键边界：
 * - 原始开始位置/作用域/观测时间由调用者显式提供，绝不从 NavResult.trace[0]
 *   或当前身体状态反推。
 * - NavResult 来自真实类型化生产者（WalkRouteExecution.nav 等），按引用原样
 *   保留 outcome/problem/trace/lastPosition/lastObservation/memoryWrite/consumption；
 *   不发明第二套未知 NavResult 校验器。
 * - ActionRecord 必需字段（consumption/subActions/observedChanges）必须由调用者
 *   给出“已知为空”或真实类型化证据；未知副作用不会被写成 []/0。
 * - 宿主 EffectEvidence（只有 verified/changed/reasons，没有作用域与时间）不会被
 *   提升为库 EffectEvidence；只作为诊断保留，并报告不可映射缺口。
 * - 观测事件使用显式边界接收序号，与原始 observationId 分开；previous 缺失表示
 *   未知，绝不表示空气；观测缺口不改变体素状态。
 * - 入队只调用传入的公共 `session.journal.recordBatch`，不接受 checkpoint/flush/
 *   close，也不改写任何身体结果或 `memoryWrite`。
 */

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

/** 宿主委托来源。与 Arbiter.TaskSource 一致；这里保留本地边界类型，避免加载配置/Arbiter 图。 */
export type NavigationTaskSource = 'llm' | 'rule' | 'filler' | 'reflex' | 'user';

/** 固定、版本化的宿主扩展名。未知版本由读取函数显式报告。 */
export const CURIO_ACTION_EXTENSION_VERSION = 1;

/**
 * 在深拷贝原始路线/轨迹/证据之前使用的固定形状上限。
 * 超限时拒绝并报告 limit/actual；不静默截断原始路线、轨迹或效果。
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

/** 调用者显式提供的导航捕获输入。 */
export interface NavigationCaptureInput {
  /** 稳定、可重放的调用身份；不能只用 taskId，也不能每次重放重新生成。 */
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: NavigationTaskSource;
  parentActionId?: string;
  /** 库委托/执行身份；省略时使用调用身份，不另外生成随机值。 */
  delegationId?: string;
  /** 原始动作记录时间，由调用者提供。 */
  ts: number;
  request: OriginalNavigationRequest;
  delegation: ParsedNavigationDelegation;
  originalStart: OriginalStartEvidence;
}

/** 捕获后的不可变事实快照（本层返回的是新对象；调用者原输入之后可变不影响它）。 */
export interface NavigationReceipt {
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: NavigationTaskSource;
  parentActionId?: string;
  delegationId: string;
  ts: number;
  request: OriginalNavigationRequest;
  delegation: ParsedNavigationDelegation;
  originalStart: OriginalStartEvidence;
}

/** 固定版本的宿主扩展，挂在实际 ActionRecord 的 `curio` 字段上。 */
export interface CurioActionExtensionV1 {
  version: typeof CURIO_ACTION_EXTENSION_VERSION;
  invocationId: string;
  taskId: string;
  planVersion: number;
  source: NavigationTaskSource;
  request: OriginalNavigationRequest;
  originalStart: OriginalStartEvidence;
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
  | 'limit_exceeded'
  | 'missing_consumption_evidence'
  | 'invalid_consumption_evidence'
  | 'missing_sub_actions'
  | 'invalid_sub_actions'
  | 'missing_observed_changes'
  | 'invalid_observed_changes'
  | 'missing_effect_provenance'
  | 'invalid_nav_projection'
  | 'invalid_host_effect_evidence'
  | 'unmappable_host_effect_evidence'
  | 'missing_event_identity'
  | 'invalid_event_identity'
  | 'invalid_sequence'
  | 'invalid_current_observation'
  | 'invalid_previous_observation'
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

/** 调用者必须显式说明“实际已知为空”或给出实测消耗。 */
export type ConsumptionEvidence =
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
  /** 只能是库 EffectEvidence（带自己的作用域/时间）；宿主摘要不得放在这里。 */
  effects?: readonly EffectEvidence[];
}

/** 宿主 EffectEvidence 的诊断保留；它不是库 EffectEvidence，也不参与动作记录。 */
export interface HostEffectDiagnostic {
  kind: 'host_effect_evidence';
  verified: boolean;
  changed: boolean;
  reasons: string[];
  omittedReasons: number;
}

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
    record: HostActionRecord;
    receipt: NavigationReceipt;
    nav: NavResult;
    gaps: PreparationGap[];
    diagnostics: HostEffectDiagnostic[];
  }
  | {
    status: 'unrecordable';
    receipt: NavigationReceipt;
    nav: NavResult;
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
  /** 只有在独立的已确认动作归因回执存在时才填写。 */
  actionId?: string;
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

const MOVE_MODES = new Set<MoveMode>(['walk', 'jump', 'sneak', 'swim', 'climb', 'ladder', 'drop']);
const OBSERVATION_SOURCES = new Set<Observation['source']>(['vision', 'agent_action', 'local_rescan']);
const EVIDENCE_KINDS = new Set<Observation['evidence']>(['seen', 'contact', 'confirmed_effect']);
const SUB_ACTION_ORIGINS = new Set<PreparedSubAction['origin']>(['agent', 'execution_helper', 'scheduler']);
const SUB_ACTION_OUTCOMES = new Set<PreparedSubAction['outcome']>(['ok', 'noop', 'unknown', 'refused', 'failed', 'cancelled']);
const SUB_ACTION_ROLES = new Set<NonNullable<PreparedSubAction['targetRole']>>(['body', 'head', 'support', 'placement_target', 'reference_face']);
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

function isNavigationTaskSource(value: unknown): value is NavigationTaskSource {
  return value === 'llm' || value === 'rule' || value === 'filler' || value === 'reflex' || value === 'user';
}

function isMoveMode(value: unknown): value is MoveMode {
  return typeof value === 'string' && MOVE_MODES.has(value as MoveMode);
}

function isObservationSource(value: unknown): value is Observation['source'] {
  return typeof value === 'string' && OBSERVATION_SOURCES.has(value as Observation['source']);
}

function isEvidenceKind(value: unknown): value is Observation['evidence'] {
  return typeof value === 'string' && EVIDENCE_KINDS.has(value as Observation['evidence']);
}

function isSubActionOrigin(value: unknown): value is PreparedSubAction['origin'] {
  return typeof value === 'string' && SUB_ACTION_ORIGINS.has(value as PreparedSubAction['origin']);
}

function isSubActionOutcome(value: unknown): value is PreparedSubAction['outcome'] {
  return typeof value === 'string' && SUB_ACTION_OUTCOMES.has(value as PreparedSubAction['outcome']);
}

function isSubActionRole(value: unknown): value is NonNullable<PreparedSubAction['targetRole']> {
  return typeof value === 'string' && SUB_ACTION_ROLES.has(value as NonNullable<PreparedSubAction['targetRole']>);
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
 * 捕获一次真实导航调用。输入必须是实际委托、解析约束和开始证据；缺失即拒绝，
 * 不读取当前适配器状态，也不生成任何随机/默认身份。
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
  if (!isNavigationTaskSource(source)) {
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

function readPlacedBlock(value: unknown): PlacedBlockConsumption | null {
  if (!isRecord(value)) return null;
  const pos = readVec(value.pos);
  const name = value.name;
  if (pos === null || !isNonEmptyString(name) || name.length > EVENT_ADAPTER_LIMITS.maxIdChars) return null;
  return { pos, name };
}

function readConsumption(value: unknown): ValidationResult<ActionRecord['consumption']> {
  if (value === undefined) {
    return invalid(makeGap('missing_consumption_evidence', 'consumption must be explicitly known_empty or measured; unknown consumption is not written as []/0'));
  }
  if (!isRecord(value)) {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption must be an explicit object'));
  }
  if (value.kind === 'known_empty') {
    return valid({ placed: [] });
  }
  if (value.kind !== 'measured') {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.kind must be known_empty or measured'));
  }
  if (!Array.isArray(value.placed)) {
    return invalid(makeGap('invalid_consumption_evidence', 'measured consumption.placed must be an array'));
  }
  if (value.placed.length > EVENT_ADAPTER_LIMITS.maxPlacedBlocks) {
    return invalid(makeGap('limit_exceeded', 'consumption.placed exceeds the fixed limit', {
      limit: EVENT_ADAPTER_LIMITS.maxPlacedBlocks, actual: value.placed.length,
    }));
  }
  const placedItems = value.placed.map(readPlacedBlock);
  const badPlaced = placedItems.findIndex((item) => item === null);
  if (badPlaced >= 0) {
    return invalid(makeGap('invalid_consumption_evidence', `consumption.placed[${badPlaced}] must be {pos, name}`));
  }
  const durabilityLost = value.durabilityLost;
  if (durabilityLost !== undefined && (!isFiniteNumber(durabilityLost) || durabilityLost < 0)) {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.durabilityLost must be a non-negative finite number when present'));
  }
  const digMs = value.digMs;
  if (digMs !== undefined && (!isFiniteNumber(digMs) || digMs < 0)) {
    return invalid(makeGap('invalid_consumption_evidence', 'consumption.digMs must be a non-negative finite number when present'));
  }
  return valid({
    placed: placedItems.filter((item): item is PlacedBlockConsumption => item !== null),
    ...(durabilityLost !== undefined ? { durabilityLost } : {}),
    ...(digMs !== undefined ? { digMs } : {}),
  });
}

function readLibraryEffect(value: unknown): ValidationResult<EffectEvidence> {
  if (!isRecord(value)) {
    return invalid(makeGap('missing_effect_provenance', 'subAction effect must be library EffectEvidence, not a host summary'));
  }
  const kind = value.kind;
  const worldId = value.worldId;
  const dim = value.dim;
  const sessionId = value.sessionId;
  const observedAt = value.observedAt;
  const verified = value.verified;
  if (!isNonEmptyString(kind) || kind.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isFiniteNumber(observedAt)
    || typeof verified !== 'boolean') {
    return invalid(makeGap('missing_effect_provenance', 'library EffectEvidence requires kind, worldId, dim, sessionId, observedAt and verified'));
  }
  const at = value.at === undefined ? undefined : readVec(value.at);
  if (value.at !== undefined && at === null) {
    return invalid(makeGap('missing_effect_provenance', 'library EffectEvidence.at must be a finite {x,y,z} when present'));
  }
  const block = value.block;
  if (block !== undefined && (!isNonEmptyString(block) || block.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return invalid(makeGap('missing_effect_provenance', 'library EffectEvidence.block must be a non-empty string when present'));
  }
  const actionId = value.actionId;
  if (actionId !== undefined && (!isNonEmptyString(actionId) || actionId.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return invalid(makeGap('missing_effect_provenance', 'library EffectEvidence.actionId must be a non-empty string when present'));
  }
  return valid({
    kind,
    ...(at !== null && at !== undefined ? { at } : {}),
    ...(block !== undefined ? { block } : {}),
    observedAt,
    worldId,
    dim,
    sessionId,
    ...(actionId !== undefined ? { actionId } : {}),
    verified,
  });
}

function readSubActions(value: unknown): ValidationResult<ActionRecord['subActions']> {
  if (value === undefined) {
    return invalid(makeGap('missing_sub_actions', 'subActions must be explicitly supplied; unknown side effects are not written as []'));
  }
  if (!Array.isArray(value)) {
    return invalid(makeGap('invalid_sub_actions', 'subActions must be an array'));
  }
  if (value.length > EVENT_ADAPTER_LIMITS.maxSubActions) {
    return invalid(makeGap('limit_exceeded', 'subActions exceeds the fixed limit', {
      limit: EVENT_ADAPTER_LIMITS.maxSubActions, actual: value.length,
    }));
  }
  const results = value.map((item, index): ValidationResult<ActionRecord['subActions'][number]> => {
    if (!isRecord(item)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}] must be an object`));
    }
    const kind = item.kind;
    if (!isNonEmptyString(kind) || kind.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].kind must be a non-empty string`));
    }
    if (!isSubActionOrigin(item.origin)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].origin must be agent/execution_helper/scheduler`));
    }
    if (!isSubActionOutcome(item.outcome)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].outcome is not supported`));
    }
    const at = item.at === undefined ? undefined : readVec(item.at);
    if (item.at !== undefined && at === null) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].at must be a finite {x,y,z} when present`));
    }
    const block = item.block;
    if (block !== undefined && (!isNonEmptyString(block) || block.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].block must be a non-empty string when present`));
    }
    const targetRole = item.targetRole;
    if (targetRole !== undefined && !isSubActionRole(targetRole)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].targetRole is not supported`));
    }
    if (item.effects !== undefined && !Array.isArray(item.effects)) {
      return invalid(makeGap('invalid_sub_actions', `subActions[${index}].effects must be an array when present`));
    }
    if (Array.isArray(item.effects) && item.effects.length > EVENT_ADAPTER_LIMITS.maxSubActionEffects) {
      return invalid(makeGap('limit_exceeded', `subActions[${index}].effects exceeds the fixed limit`, {
        limit: EVENT_ADAPTER_LIMITS.maxSubActionEffects, actual: item.effects.length,
      }));
    }
    const effects = Array.isArray(item.effects) ? item.effects.map(readLibraryEffect) : [];
    const badEffect = effects.findIndex((effect) => !effect.ok);
    if (badEffect >= 0) {
      const failed = effects[badEffect];
      return invalid(...(failed !== undefined && !failed.ok ? failed.gaps : []));
    }
    return valid({
      kind,
      ...(at !== null && at !== undefined ? { at } : {}),
      ...(block !== undefined ? { block } : {}),
      origin: item.origin,
      ...(targetRole !== undefined ? { targetRole } : {}),
      outcome: item.outcome,
      ...(Array.isArray(item.effects)
        ? { effects: effects.filter((effect): effect is { ok: true; value: EffectEvidence } => effect.ok).map((effect) => effect.value) }
        : {}),
    });
  });
  const bad = results.find((result) => !result.ok);
  if (bad !== undefined && !bad.ok) return invalid(...bad.gaps);
  return valid(results.filter((result): result is { ok: true; value: ActionRecord['subActions'][number] } => result.ok).map((result) => result.value));
}

function readBlockProperties(value: unknown, what: string): ValidationResult<Record<string, string>> {
  if (!isRecord(value)) {
    return invalid(makeGap('invalid_current_observation', `${what}.properties must be an object`));
  }
  const entries = Object.entries(value);
  if (entries.length > EVENT_ADAPTER_LIMITS.maxBlockProperties) {
    return invalid(makeGap('limit_exceeded', `${what}.properties exceeds the fixed limit`, {
      limit: EVENT_ADAPTER_LIMITS.maxBlockProperties, actual: entries.length,
    }));
  }
  const invalidEntry = entries.find(([, property]) => {
    if (typeof property === 'string') return false;
    if (typeof property === 'number') return !Number.isFinite(property);
    return typeof property !== 'boolean';
  });
  if (invalidEntry !== undefined) {
    return invalid(makeGap('invalid_current_observation', `${what}.properties.${invalidEntry[0]} must be a string, finite number or boolean`));
  }
  return valid(Object.fromEntries(entries.map(([key, property]) => [key, String(property)] as const)));
}

function readObservation(value: unknown, what: string): ValidationResult<Observation> {
  if (!isRecord(value)) {
    return invalid(makeGap('invalid_previous_observation', `${what} must be a library Observation object`));
  }
  const worldId = value.worldId;
  const dim = value.dim;
  const sessionId = value.sessionId;
  if (!isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return invalid(makeGap('invalid_previous_observation', `${what} requires non-empty worldId, dim and sessionId`));
  }
  const pos = readVec(value.pos);
  if (pos === null) {
    return invalid(makeGap('invalid_previous_observation', `${what}.pos must be a finite {x,y,z}`));
  }
  const observedAt = value.observedAt;
  if (!isFiniteNumber(observedAt)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.observedAt must be finite`));
  }
  const state = value.state;
  if (!isRecord(state) || !isNonEmptyString(state.name) || state.name.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return invalid(makeGap('invalid_previous_observation', `${what}.state must contain a non-empty block name`));
  }
  const properties = readBlockProperties(state.properties, `${what}.state`);
  if (!properties.ok) {
    const propertyGap = properties.gaps[0];
    return propertyGap?.code === 'limit_exceeded'
      ? invalid(propertyGap)
      : invalid(makeGap('invalid_previous_observation', propertyGap?.detail ?? `${what}.state.properties is invalid`));
  }
  const stateComplete = value.stateComplete;
  if (typeof stateComplete !== 'boolean') {
    return invalid(makeGap('invalid_previous_observation', `${what}.stateComplete must be an explicit boolean`));
  }
  const evidence = value.evidence;
  if (!isEvidenceKind(evidence)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.evidence is not supported`));
  }
  const source = value.source;
  if (!isObservationSource(source)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.source is not supported`));
  }
  const sequence = value.sequence;
  if (!isSafeCount(sequence)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.sequence must be a non-negative safe integer`));
  }
  const originObservationId = value.originObservationId;
  if (originObservationId !== undefined && !isSafeCount(originObservationId)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.originObservationId must be a non-negative safe integer when present`));
  }
  const actionId = value.actionId;
  if (actionId !== undefined && (!isNonEmptyString(actionId) || actionId.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.actionId must be a non-empty string when present`));
  }
  const observedWorldTick = value.observedWorldTick;
  if (observedWorldTick !== undefined && (!isFiniteNumber(observedWorldTick) || observedWorldTick < 0)) {
    return invalid(makeGap('invalid_previous_observation', `${what}.observedWorldTick must be a non-negative finite number when present`));
  }
  return valid({
    pos,
    state: { name: state.name, properties: properties.value },
    stateComplete,
    evidence,
    observedAt,
    ...(observedWorldTick !== undefined ? { observedWorldTick } : {}),
    source,
    sessionId,
    ...(originObservationId !== undefined ? { originObservationId } : {}),
    sequence,
    ...(actionId !== undefined ? { actionId } : {}),
    dim,
    worldId,
  });
}

function readObservedChanges(value: unknown): ValidationResult<Observation[]> {
  if (value === undefined) {
    return invalid(makeGap('missing_observed_changes', 'observedChanges must be explicitly supplied; unknown observation evidence is not written as []'));
  }
  if (!Array.isArray(value)) {
    return invalid(makeGap('invalid_observed_changes', 'observedChanges must be an array of library Observations'));
  }
  if (value.length > EVENT_ADAPTER_LIMITS.maxObservedChanges) {
    return invalid(makeGap('limit_exceeded', 'observedChanges exceeds the fixed limit', {
      limit: EVENT_ADAPTER_LIMITS.maxObservedChanges, actual: value.length,
    }));
  }
  const results = value.map((item, index) => readObservation(item, `observedChanges[${index}]`));
  const bad = results.find((result) => !result.ok);
  if (bad !== undefined && !bad.ok) {
    const limitGap = bad.gaps.find((gap) => gap.code === 'limit_exceeded');
    if (limitGap !== undefined) return invalid(limitGap);
    const detail = bad.gaps.map((gap) => gap.detail).join('; ');
    return invalid(makeGap('invalid_observed_changes', detail.length > 0 ? detail : 'observedChanges contains an invalid Observation'));
  }
  return valid(results.filter((result): result is { ok: true; value: Observation } => result.ok).map((result) => result.value));
}

function readHostEffectDiagnostic(value: unknown): { diagnostic: HostEffectDiagnostic | null; gaps: PreparationGap[] } {
  if (!isRecord(value)) {
    return {
      diagnostic: null,
      gaps: [makeGap('invalid_host_effect_evidence', 'hostEffectEvidence must be {verified, changed, reasons}', { blocking: false })],
    };
  }
  const verified = value.verified;
  const changed = value.changed;
  const rawReasons = value.reasons;
  if (typeof verified !== 'boolean' || typeof changed !== 'boolean' || !Array.isArray(rawReasons)) {
    return {
      diagnostic: null,
      gaps: [makeGap('invalid_host_effect_evidence', 'hostEffectEvidence must be {verified:boolean, changed:boolean, reasons:string[]}', { blocking: false })],
    };
  }
  const reasons = rawReasons.filter((reason): reason is string => typeof reason === 'string');
  if (reasons.length !== rawReasons.length) {
    return {
      diagnostic: null,
      gaps: [makeGap('invalid_host_effect_evidence', 'hostEffectEvidence.reasons must contain only strings', { blocking: false })],
    };
  }
  const bounded = reasons.filter((reason) => reason.length <= EVENT_ADAPTER_LIMITS.maxReasonChars)
    .slice(0, EVENT_ADAPTER_LIMITS.maxHostEffectReasons);
  const omittedReasons = reasons.length - bounded.length;
  const gaps: PreparationGap[] = [
    makeGap(
      'unmappable_host_effect_evidence',
      'host EffectEvidence has no observation scope/time and is never promoted to library EffectEvidence; it is retained only as a typed diagnostic',
      { blocking: false },
    ),
  ];
  if (omittedReasons > 0) {
    gaps.push(makeGap('limit_exceeded', 'hostEffectEvidence.reasons was bounded; omitted count is explicit', {
      blocking: false,
      limit: EVENT_ADAPTER_LIMITS.maxHostEffectReasons,
      actual: reasons.length,
    }));
  }
  return {
    diagnostic: { kind: 'host_effect_evidence', verified, changed, reasons: bounded, omittedReasons },
    gaps,
  };
}

/**
 * 把真实类型化 NavResult 和调用者显式提供的实际证据准备成宿主 ActionRecord。
 * 纯函数：不读取当前状态、不写库、不生成 ID、不改写 nav 或 `memoryWrite`。
 */
export function prepareNavigationAction(
  receipt: NavigationReceipt,
  nav: NavResult,
  input: NavigationActionEvidence,
): NavigationActionPreparation {
  const raw: unknown = input;
  const gaps: PreparationGap[] = [];
  const diagnostics: HostEffectDiagnostic[] = [];

  // 只对会被投影进记录的 NavResult 字段做有界检查；不重造完整 NavResult 校验器。
  const trace = nav.trace;
  if (!Array.isArray(trace)) {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.trace must be an array'));
  } else {
    if (trace.length > EVENT_ADAPTER_LIMITS.maxTracePoints) {
      gaps.push(makeGap('limit_exceeded', 'NavResult.trace exceeds the fixed record limit', {
        limit: EVENT_ADAPTER_LIMITS.maxTracePoints, actual: trace.length,
      }));
    }
    if (trace.some((step) => readVec(step.pos) === null || !isFiniteNumber(step.ts))) {
      gaps.push(makeGap('invalid_nav_projection', 'every NavResult.trace step must have a finite {x,y,z} and ts'));
    }
  }
  if (nav.lastPosition !== undefined && readVec(nav.lastPosition) === null) {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.lastPosition must be a finite {x,y,z} when present'));
  }
  if (typeof nav.message !== 'string') {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.message must be a string'));
  }
  if (typeof nav.confirmed !== 'boolean') {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.confirmed must be a boolean'));
  }
  if (nav.outcome !== 'ARRIVED' && nav.outcome !== 'PARTIAL' && nav.outcome !== 'NO_PATH' && nav.outcome !== 'BLOCKED'
    && nav.outcome !== 'CANCELLED' && nav.outcome !== 'TIMEOUT' && nav.outcome !== 'FAILED') {
    gaps.push(makeGap('invalid_nav_projection', 'NavResult.outcome is not a supported navigation outcome'));
  }

  if (!isRecord(raw)) {
    gaps.push(makeGap('missing_consumption_evidence', 'action evidence must be an object with explicit consumption/subActions/observedChanges'));
    return { status: 'unrecordable', receipt, nav, gaps, diagnostics };
  }

  const consumption = readConsumption(raw.consumption);
  if (!consumption.ok) gaps.push(...consumption.gaps);
  const subActions = readSubActions(raw.subActions);
  if (!subActions.ok) gaps.push(...subActions.gaps);
  const observedChanges = readObservedChanges(raw.observedChanges);
  if (!observedChanges.ok) gaps.push(...observedChanges.gaps);

  if (raw.hostEffectEvidence !== undefined) {
    const host = readHostEffectDiagnostic(raw.hostEffectEvidence);
    if (host.diagnostic !== null) diagnostics.push(host.diagnostic);
    gaps.push(...host.gaps);
  }

  if (gaps.some((gap) => gap.blocking)) {
    return { status: 'unrecordable', receipt, nav, gaps, diagnostics };
  }
  if (!consumption.ok || !subActions.ok || !observedChanges.ok) {
    // 理论上已被 blocking 分支覆盖；保留显式不可录制，避免静默构造不完整记录。
    return { status: 'unrecordable', receipt, nav, gaps, diagnostics };
  }

  const extension: CurioActionExtensionV1 = {
    version: CURIO_ACTION_EXTENSION_VERSION,
    invocationId: receipt.invocationId,
    taskId: receipt.taskId,
    planVersion: receipt.planVersion,
    source: receipt.source,
    request: copyOriginalRequest(receipt.request),
    originalStart: copyStart(receipt.originalStart),
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
    subActions: subActions.value,
    from: { ...receipt.originalStart.pos },
    ...(nav.outcome === 'ARRIVED'
      ? { to: { ...nav.lastPosition } }
      : nav.lastPosition !== undefined
        ? { failureAt: { ...nav.lastPosition } }
        : {}),
    trace: trace.map((step) => ({ pos: { ...step.pos }, ts: step.ts })),
    consumption: consumption.value,
    observedChanges: observedChanges.value,
    ...(nav.outcome !== 'ARRIVED' ? { failureReason: nav.message } : {}),
    confirmed: nav.outcome === 'ARRIVED' && nav.confirmed,
    result: nav,
    curio: extension,
  };

  return { status: 'prepared', record, receipt, nav, gaps, diagnostics };
}

/** 把实际视锥 BlockObservation 映射为库 Observation；序列与原始 observationId 分开。 */
function convertCurrentObservation(value: unknown): ValidationResult<{
  observation: Observation;
  worldId: string;
  dim: string;
  sessionId: string;
  pos: Vec3Like;
  observedAt: number;
}> {
  if (!isRecord(value)) {
    return invalid(makeGap('invalid_current_observation', 'current must be an actual BlockObservation object'));
  }
  const worldId = value.worldId;
  const dim = value.dimension;
  const sessionId = value.sessionId;
  if (!isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return invalid(makeGap('invalid_current_observation', 'current requires non-empty worldId, dimension and sessionId'));
  }
  const pos = readVec(value.pos);
  if (pos === null) {
    return invalid(makeGap('invalid_current_observation', 'current.pos must be a finite {x,y,z}'));
  }
  const observedAt = value.observedAt;
  if (!isFiniteNumber(observedAt)) {
    return invalid(makeGap('invalid_current_observation', 'current.observedAt must be the real acquisition time'));
  }
  const observationId = value.observationId;
  if (!isSafeCount(observationId)) {
    return invalid(makeGap('invalid_current_observation', 'current.observationId must be a non-negative safe integer'));
  }
  const name = value.name;
  if (!isNonEmptyString(name) || name.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return invalid(makeGap('invalid_current_observation', 'current.name must be a non-empty block name'));
  }
  if (value.source !== 'vision') {
    return invalid(makeGap('invalid_current_observation', 'current.source must be vision'));
  }
  if (value.stateComplete !== undefined && typeof value.stateComplete !== 'boolean') {
    return invalid(makeGap('invalid_current_observation', 'current.stateComplete must be boolean when present'));
  }
  // 缺失的属性对象按空属性处理，但 stateComplete 仍严格由显式 true 决定；不推断完整。
  const rawProperties = value.properties === undefined ? {} : value.properties;
  const properties = readBlockProperties(rawProperties, 'current');
  if (!properties.ok) {
    const propertyGap = properties.gaps[0];
    return propertyGap?.code === 'limit_exceeded'
      ? invalid(propertyGap)
      : invalid(makeGap('invalid_current_observation', propertyGap?.detail ?? 'current.properties is invalid'));
  }
  const observation: Observation = {
    pos,
    state: { name, properties: properties.value },
    stateComplete: value.stateComplete === true,
    evidence: 'seen',
    observedAt,
    source: 'vision',
    sessionId,
    originObservationId: observationId,
    sequence: 0,
    dim,
    worldId,
  };
  return valid({ observation, worldId, dim, sessionId, pos, observedAt });
}

/**
 * 准备一条 observed_cell_change 事件。current 必须是实际 BlockObservation，
 * sequence 是显式边界接收序号；previous 缺失表示未知，不表示空气。
 */
export function prepareObservedCellEvent(input: ObservedCellEventInput): ObservedCellEventPreparation {
  const raw: unknown = input;
  if (!isRecord(raw)) {
    return { status: 'refused', gaps: [makeGap('missing_event_identity', 'observed cell event input must be an object')] };
  }
  const id = raw.id;
  if (!isNonEmptyString(id)) {
    return { status: 'refused', gaps: [makeGap('missing_event_identity', 'event id must be a stable caller-supplied identity')] };
  }
  if (id.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('limit_exceeded', 'event id is too long', {
      limit: EVENT_ADAPTER_LIMITS.maxIdChars, actual: id.length,
    })] };
  }
  if (!isSafeCount(raw.sequence)) {
    return { status: 'refused', gaps: [makeGap('invalid_sequence', 'sequence must be the explicit non-negative boundary receive order, not observationId')] };
  }
  const current = convertCurrentObservation(raw.current);
  if (!current.ok) return { status: 'refused', gaps: current.gaps };

  let previous: Observation | undefined;
  if (raw.previous !== undefined) {
    const readPrevious = readObservation(raw.previous, 'previous');
    if (!readPrevious.ok) return { status: 'refused', gaps: readPrevious.gaps };
    if (readPrevious.value.worldId !== current.value.worldId
      || readPrevious.value.dim !== current.value.dim
      || !sameVec(readPrevious.value.pos, current.value.pos)) {
      return { status: 'refused', gaps: [makeGap('previous_scope_mismatch', 'previous observation scope/cell does not match the current event; older session/time is allowed but scope is not')] };
    }
    previous = readPrevious.value;
  }

  const actionId = raw.actionId;
  if (actionId !== undefined && (!isNonEmptyString(actionId) || actionId.length > EVENT_ADAPTER_LIMITS.maxIdChars)) {
    return { status: 'refused', gaps: [makeGap('invalid_event_identity', 'actionId must be a non-empty string within the id limit when present; it is never inferred from vision')] };
  }

  const observation: Observation = { ...current.value.observation, sequence: raw.sequence };
  const event: ObservedCellChangeEvent = {
    kind: 'observed_cell_change',
    id,
    observedAt: current.value.observedAt,
    worldId: current.value.worldId,
    dim: current.value.dim,
    sessionId: current.value.sessionId,
    pos: { ...current.value.pos },
    current: observation,
    ...(previous !== undefined ? { previous } : {}),
    ...(actionId !== undefined ? { actionId } : {}),
  };
  return { status: 'prepared', event };
}

/** 准备一条 observation_gap 事件；不改变体素状态，不使用当前作用域/发布时刻补齐。 */
export function prepareObservationGapEvent(input: ObservationGapEventInput): ObservationGapEventPreparation {
  const raw: unknown = input;
  if (!isRecord(raw)) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_scope', 'observation gap input must be an object')] };
  }
  const id = raw.id;
  if (!isNonEmptyString(id)) {
    return { status: 'refused', gaps: [makeGap('missing_event_identity', 'gap id must be a stable caller-supplied identity')] };
  }
  if (id.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('limit_exceeded', 'gap id is too long', {
      limit: EVENT_ADAPTER_LIMITS.maxIdChars, actual: id.length,
    })] };
  }
  const worldId = raw.worldId;
  const dim = raw.dim;
  const sessionId = raw.sessionId;
  if (!isNonEmptyString(worldId) || worldId.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(dim) || dim.length > EVENT_ADAPTER_LIMITS.maxIdChars
    || !isNonEmptyString(sessionId) || sessionId.length > EVENT_ADAPTER_LIMITS.maxIdChars) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_scope', 'gap requires the original non-empty worldId, dim and sessionId')] };
  }
  const observedAt = raw.observedAt;
  if (!isFiniteNumber(observedAt)) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_time', 'gap observedAt must be the original lifecycle/observation time; publish time is not a substitute')] };
  }
  if (!isGapReason(raw.reason)) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_reason', 'gap reason must be one of the actual observation/lifecycle gap reasons')] };
  }
  const pos = raw.pos === undefined ? undefined : readVec(raw.pos);
  if (raw.pos !== undefined && pos === null) {
    return { status: 'refused', gaps: [makeGap('invalid_gap_scope', 'gap pos must be a finite {x,y,z} when present')] };
  }
  return {
    status: 'prepared',
    event: {
      kind: 'observation_gap',
      id,
      observedAt,
      worldId,
      dim,
      sessionId,
      reason: raw.reason,
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
  if (!isNavigationTaskSource(source)) {
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
 * 接受不是保存：返回 accepted_pending_checkpoint。拒绝时保留原记录引用以便显式重试；
 * 不 checkpoint/flush/close，不创建 store/worker/定时器，不重试、不去重、不重新编号。
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
