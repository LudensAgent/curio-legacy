import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LandSearchStatus } from '../src/spatial/land-search.ts';
import type { SegmentOutcome } from '../src/skills/movement/segment.ts';
import type { StopReason } from '../src/skills/movement/session.ts';
import {
  failureCodeOfMovement, movementFailureOfError, movementFailureOfSearch, movementFailureOfSegment, movementFailureOfStop,
} from '../src/skills/movement/contract.ts';
import { policyRejectionNotes, resumeAuthorizationAllowed } from '../src/skills/movement/coordinator.ts';
import type { MovementAuthorization } from '../src/skills/movement/session.ts';

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
    TOOL_REQUIRED: 'TOOL_MISSING',
    DESCENT_NOT_AUTHORIZED: 'DELEGATION_RESTRICTION',
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
  assert.equal(code('TOOL_REQUIRED'), 'TOOL_MISSING', '缺工具要保留专门分类，不折叠成走不通');
  assert.equal(code('DESCENT_NOT_AUTHORIZED'), 'PATH_NOT_FOUND', '未能满足的是本次下降授权，仍是一类委托限制');
  assert.equal(code('SCOPE_CHANGED'), 'WRONG_DIMENSION');
  assert.equal(failureCodeOfMovement('NO_PATH_EVIDENCE'), 'NOT_FOUND');
});

test('策略拒绝回执：含第一条边与可改项；没有开路授权时不承诺顺手灭火', () => {
  const policy = { rejectedEdges: 3, firstRejection: { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 }, reason: 'host policy rejects recorded dangerous block fire at the destination feet cell' } };
  const clearable = policyRejectionNotes(policy, true);
  assert.match(clearable.lead, /拒绝 3 条边/);
  assert.match(clearable.lead, /第一条 \(0,64,0\)→\(1,64,0\)/);
  assert.match(clearable.remedy, /宿主会顺手打灭/);
  assert.match(policyRejectionNotes(policy, false).remedy, /没有开路授权/);
  const none = policyRejectionNotes(undefined, true);
  assert.equal(none.lead, ''); assert.equal(none.remedy, ''); assert.equal(none.danger, '');
});

test('续接授权只能收窄：放弃施工、同材料、更小 maxEdits 可以；新增/换材料/放大不行', () => {
  const auth = (over: Partial<MovementAuthorization> = {}): MovementAuthorization => ({ swim: false, ...over });
  const way = (over: Partial<NonNullable<MovementAuthorization['makeWay']>> = {}) => ({ maxEdits: 16, ...over });
  assert.equal(resumeAuthorizationAllowed(auth(), auth()), true);
  assert.equal(resumeAuthorizationAllowed(auth({ swim: true }), auth({ swim: false })), true, '可以放弃涉水');
  assert.equal(resumeAuthorizationAllowed(auth(), auth({ swim: true })), false, '不能新增涉水');
  assert.equal(resumeAuthorizationAllowed(auth(), auth({ makeWay: way() })), false, '不能新增施工');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way() }), auth()), true, '可以放弃施工');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: { tool: 'iron_pickaxe' } }) }), auth({ makeWay: way({ dig: { tool: 'iron_pickaxe' }, maxEdits: 8 }) })), true);
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: { tool: 'iron_pickaxe' } }) }), auth({ makeWay: way({ dig: { tool: 'stone_pickaxe' } }) })), false, '不能换工具');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: { tool: 'iron_pickaxe' } }) }), auth({ makeWay: way({ dig: {} }) })), false, '不能从指定工具放宽到当前手持');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: {} }) }), auth({ makeWay: way({ dig: { tool: 'iron_pickaxe' }, maxEdits: 8 }) })), true, '原来不限工具，续接可以收窄到指定工具');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ place: { item: 'dirt' } }) }), auth({ makeWay: way({ place: { item: 'dirt' }, maxEdits: 8 }) })), true);
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ place: { item: 'dirt' } }) }), auth({ makeWay: way({ place: { item: 'stone' } }) })), false, '不能换材料');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ place: { item: 'any' } }) }), auth({ makeWay: way({ place: { item: 'dirt' } }) })), true, 'any 可以收窄到具体材料');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ place: { item: 'dirt' } }) }), auth({ makeWay: way({ place: { item: 'any' } }) })), false, '不能从具体材料放宽到 any');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way() }), auth({ makeWay: way({ maxEdits: 20 }) })), false, '不能放大 maxEdits');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: {} }) }), auth({ makeWay: way({ dig: {}, requireTool: true }) })), true, '新增必须用工具是收窄');
  assert.equal(resumeAuthorizationAllowed(auth({ makeWay: way({ dig: {}, requireTool: true }) }), auth({ makeWay: way({ dig: {} }) })), false, '不能把必须用工具放宽成允许空手');
});
