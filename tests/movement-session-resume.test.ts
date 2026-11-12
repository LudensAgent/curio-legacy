import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearMovementSessions, createMovementSession, findMovementSession, remainingMakeWayEdits, suspendScopeSessions,
  type MovementIntent,
} from '../src/skills/movement/session.ts';

const scope = { worldId: 'w', dim: 'overworld', sessionId: 's' };
const budget = {
  maxTransitions: 128, maxSearches: 32, maxObservations: 16, maxObservedCells: 512,
  maxNoProgressSegments: 4, maxLateralDrift: 16, maxMakeWayEdits: 12,
};

const advance = (direction: 'N' | 'E' | 'S' | 'W'): MovementIntent =>
  ({ kind: 'advance', direction, distance: 64, maxLateralDrift: 16, allowed: ['walk', 'step', 'drop'], historical: true });

test('挂起标记让插曲的新移动意图跳过原 session，而不是把它标成 SUPERSEDED', () => {
  clearMovementSessions();
  const now = Date.now();
  const first = createMovementSession({
    intent: advance('W'), origin: { x: 0, y: 64, z: 0 }, bearing: { x: -1, z: 0 },
    scope, budget, authorization: { swim: false }, now,
  });
  // 模拟协调器仍在执行时，mind 已经触发 detour：挂起必须先于插曲的新意图生效。
  first.phase = 'executing';
  suspendScopeSessions(scope, now + 1);
  assert.equal(first.phase, 'stopped');
  assert.equal(first.stop?.reason, 'SUSPENDED');

  const detour = createMovementSession({
    intent: advance('E'), origin: { x: 0, y: 64, z: 0 }, bearing: { x: 1, z: 0 },
    scope, budget, authorization: { swim: false }, now: now + 2,
  });
  assert.equal(detour.phase, 'planning');
  assert.equal(first.phase, 'stopped', '插曲的新 session 不取代已挂起的原委托');
  assert.equal(first.stop?.reason, 'SUSPENDED');
  assert.equal(findMovementSession(first.id, now + 3)?.id, first.id, '原 session 仍可凭 id 续接');
});

test('施工额度按原授权减会话累计：暂停前用 7/12，恢复后只剩 5 次', () => {
  clearMovementSessions();
  const session = createMovementSession({
    intent: advance('W'), origin: { x: 0, y: 64, z: 0 }, bearing: { x: -1, z: 0 },
    scope, budget: { ...budget, maxMakeWayEdits: 12 }, authorization: { swim: false }, now: Date.now(),
  });
  session.counters.makeWayEdits = 7;
  assert.equal(remainingMakeWayEdits(session), 5);
  session.counters.makeWayEdits = 12;
  assert.equal(remainingMakeWayEdits(session), 0, '恢复不重新获得完整授权');
});
