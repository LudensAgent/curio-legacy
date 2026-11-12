import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressMeterOf } from '../src/skills/movement/intent.ts';
import { clearMovementSessions, createMovementSession, type MovementIntent, type MoveScope } from '../src/skills/movement/session.ts';

const scope: MoveScope = { worldId: 'w', dim: 'overworld', sessionId: 's' };
const budget = { maxTransitions: 100, maxSearches: 10, maxObservations: 10, maxObservedCells: 100, maxNoProgressSegments: 4, maxLateralDrift: 16 };

function sessionOf(intent: MovementIntent, origin = { x: 0.5, y: 64, z: 0.5 }) {
  clearMovementSessions();
  return createMovementSession({
    intent, origin,
    ...(intent.kind === 'advance' ? { bearing: { x: 1, z: 0 } } : {}),
    scope, budget, authorization: { swim: false }, now: Date.now(),
  });
}

test('进度条口径：advance 按沿冻结方向的距离占比', () => {
  const session = sessionOf({ kind: 'advance', direction: 'E', distance: 32, maxLateralDrift: 4, allowed: ['walk', 'step', 'drop'], historical: true });
  const meter = progressMeterOf(session, { x: 8.5, y: 64, z: 0.5 });
  assert.equal(meter.fraction, 0.25);
  assert.equal(meter.note, '沿 E 实测 8/32 格');
});

test('进度条口径：反向移动不产生负进度', () => {
  const session = sessionOf({ kind: 'advance', direction: 'E', distance: 32, maxLateralDrift: 4, allowed: ['walk', 'step', 'drop'], historical: true });
  assert.equal(progressMeterOf(session, { x: -4, y: 64, z: 0.5 }).fraction, 0);
});

test('进度条口径：navigate 跟随原到达条件的水平距离；到达与否留给完成判定', () => {
  const session = sessionOf({
    kind: 'navigate', to: { x: 10, y: 64, z: 0 }, targetKind: 'cell',
    arrival: { radius: 2, metric: 'horizontal' }, allowed: ['walk'], historical: true,
  });
  const halfway = progressMeterOf(session, { x: 5, y: 64, z: 0 });
  assert.equal(halfway.fraction, 0.5);
  assert.equal(halfway.note, '距原目标水平 5 格');
  // 进入半径但还没站稳时不能自行写成完成：协调器按 goalReached 判定后才报 1。
  assert.equal(progressMeterOf(session, { x: 8, y: 64, z: 0 }).fraction, 0.8);
});

test('进度条口径：起点与目标同格时不自行报满，完成仍由 goalReached 判定', () => {
  const session = sessionOf({
    kind: 'navigate', to: { x: 0, y: 64, z: 0 }, targetKind: 'cell',
    arrival: { radius: 2, metric: 'horizontal' }, allowed: ['walk'], historical: true,
  });
  assert.equal(progressMeterOf(session, { x: 0.5, y: 64, z: 0.5 }).fraction, 0);
});

test('进度条口径：navigate 无到达半径时按三维距离，接近目标才接近完成', () => {
  const session = sessionOf({
    kind: 'navigate', to: { x: 0, y: 68, z: 0 }, targetKind: 'cell',
    allowed: ['walk'], historical: true,
  }, { x: 0, y: 64, z: 0 });
  const meter = progressMeterOf(session, { x: 0, y: 66, z: 0 });
  assert.equal(meter.fraction, 0.5);
  assert.equal(meter.note, '距原目标直线 2 格');
});
