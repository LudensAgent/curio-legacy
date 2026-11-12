import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LandSearchStatus } from '../src/spatial/land-search.ts';
import type { SegmentOutcome } from '../src/skills/movement/segment.ts';
import type { StopReason } from '../src/skills/movement/session.ts';
import {
  failureCodeOfMovement, movementFailureOfError, movementFailureOfSearch, movementFailureOfSegment, movementFailureOfStop,
} from '../src/skills/movement/contract.ts';

test('搜索终态映射：证据缺口、几何无路、预算、取消分开', () => {
  const expected: Record<LandSearchStatus, string | null> = {
    FOUND: null,
    INSUFFICIENT_EVIDENCE: 'NO_PATH_EVIDENCE',
    NO_PATH_IN_MEMORY: 'NO_PATH_GEOMETRY',
    UNSUPPORTED: 'TARGET_UNRESOLVED',
    INVALIDATED: 'INVALIDATED',
    BUDGET_EXHAUSTED: 'BUDGET',
    CANCELLED: 'CANCELLED',
  };
  for (const [status, failure] of Object.entries(expected)) {
    assert.equal(movementFailureOfSearch(status as LandSearchStatus), failure, status);
  }
  assert.equal(movementFailureOfSearch('UNSUPPORTED', { policyRejectedEdges: 90 }), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfSearch('UNSUPPORTED', { corridorLimited: true }), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfSearch('UNSUPPORTED', { unavailableSections: 8 }), 'RESIDENCY');
  assert.equal(movementFailureOfSearch('BUDGET_EXHAUSTED', { policyRejectedEdges: 1 }), 'BUDGET', '预算事实不被策略覆盖');
});

test('段结局映射：未知、阻挡、策略、身体、预算、驻留分开', () => {
  const expected: Record<SegmentOutcome, string | null> = {
    reached_waypoint: null,
    sighting: null,
    partial_prefix: null,
    replan: null,
    unknown_boundary: 'NO_PATH_EVIDENCE',
    blocked: 'NO_PATH_GEOMETRY',
    no_path: 'NO_PATH_GEOMETRY',
    invalidated: 'INVALIDATED',
    corridor_exhausted: 'DELEGATION_RESTRICTION',
    lateral_authorization: 'DELEGATION_RESTRICTION',
    unsupported: 'TARGET_UNRESOLVED',
    physical_failure: 'BODY_CAPABILITY',
    disallowed: 'DELEGATION_RESTRICTION',
    search_budget: 'BUDGET',
    residency_not_ready: 'RESIDENCY',
    cancelled: 'CANCELLED',
    timeout: 'TIMEOUT',
  };
  for (const [outcome, failure] of Object.entries(expected)) {
    assert.equal(movementFailureOfSegment(outcome as SegmentOutcome), failure, outcome);
  }
  assert.equal(movementFailureOfSegment('unsupported', { policyRejectedEdges: 3 }), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfSegment('unsupported', { disallowed: true }), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfSegment('unsupported', { modeGap: true }), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfSegment('unsupported', { problemKind: 'UNSUPPORTED_ENVIRONMENT' }), 'BODY_CAPABILITY');
});

test('协调器停止原因映射：成功为 null，其余不折叠成走不通', () => {
  const expected: Record<StopReason, string | null> = {
    DISTANCE_MET: null,
    REGION_ENTERED: null,
    UNTIL_SEEN: null,
    ARRIVED: null,
    UNKNOWN_BOUNDARY: 'NO_PATH_EVIDENCE',
    BLOCKED: 'NO_PATH_GEOMETRY',
    TARGET_UNRESOLVED: 'TARGET_UNRESOLVED',
    ROUTE_INVALIDATED: 'INVALIDATED',
    NO_PATH: 'NO_PATH_GEOMETRY',
    RESIDENCY_NOT_READY: 'RESIDENCY',
    PHYSICAL_FAILURE: 'BODY_CAPABILITY',
    ACTION_FAILURE: 'UNKNOWN',
    MODE_GAP: 'DELEGATION_RESTRICTION',
    DELEGATION_RESTRICTION: 'DELEGATION_RESTRICTION',
    CONFLICT: 'CONFLICT',
    NO_PROGRESS: 'NO_PROGRESS',
    LATERAL_DRIFT: 'DELEGATION_RESTRICTION',
    DETOUR_TOO_LARGE: 'DELEGATION_RESTRICTION',
    BUDGET_EXHAUSTED: 'BUDGET',
    MAKE_WAY_BUDGET_EXHAUSTED: 'BUDGET',
    TIMEOUT: 'TIMEOUT',
    CANCELLED: 'CANCELLED',
    SUSPENDED: null,
    SCOPE_CHANGED: 'SCOPE_CHANGED',
    INTENT_MISMATCH: 'INTENT_MISMATCH',
    SUPERSEDED: 'SUPERSEDED',
  };
  for (const [reason, failure] of Object.entries(expected)) {
    assert.equal(movementFailureOfStop(reason as StopReason), failure, reason);
  }
});

test('身体控制错误只按已知形状分类，未知保持 UNKNOWN', () => {
  assert.equal(movementFailureOfError(new Error('TIMEOUT: 连续脚位没有在期限内站稳')), 'TIMEOUT');
  assert.equal(movementFailureOfError(new Error('NOT_CONFIRMED: 身体控制没有完成相邻一步')), 'BODY_CAPABILITY');
  assert.equal(movementFailureOfError(new Error('CHECKPOINT_PASSED: 实测脚位已越过中间点')), 'BODY_CAPABILITY');
  assert.equal(movementFailureOfError(new Error('CORRIDOR_VIOLATION: 超出授权 2 格')), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfError(new Error('PORTAL_CELL: 目标站位是下界传送门')), 'DELEGATION_RESTRICTION');
  assert.equal(movementFailureOfError(Object.assign(new Error('cancelled'), { name: 'AbortedError' })), 'CANCELLED');
  assert.equal(movementFailureOfError(new Error('something unexpected')), 'UNKNOWN');
});

test('真实回执边界用统一分类：预算、冲突、驻留不再各自折叠', () => {
  const code = (reason: StopReason) => failureCodeOfMovement(movementFailureOfStop(reason)!);
  assert.equal(code('BUDGET_EXHAUSTED'), 'TIMEOUT', '旧 FailureCode 只有 TIMEOUT 能表达预算；精确原因保留在 stop.failure');
  assert.equal(code('CONFLICT'), 'PATH_NOT_FOUND');
  assert.equal(code('RESIDENCY_NOT_READY'), 'PATH_NOT_FOUND');
  assert.equal(code('PHYSICAL_FAILURE'), 'EFFECT_NOT_CONFIRMED');
  assert.equal(code('SCOPE_CHANGED'), 'WRONG_DIMENSION');
  assert.equal(failureCodeOfMovement('NO_PATH_EVIDENCE'), 'NOT_FOUND');
});
