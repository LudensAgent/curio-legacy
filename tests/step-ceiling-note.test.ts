import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ceilingNote } from '../src/skills/movement/segment.ts';

test('往上一级被起步处头顶第三格挡住时，阻挡说明讲清是两格高巷道上不去台阶', () => {
  const step = { kind: 'step', from: { x: -34.5, y: 66, z: -43.4 }, to: { x: -34.5, y: 67, z: -42.4 } };
  assert.match(ceilingNote({ transition: step, reason: 'collision with netherrack at (-35, 68, -44)' }), /起步处上方第三格 \(-35,68,-44\) 的 netherrack.*两格高的巷道里上不去台阶/);
  assert.equal(ceilingNote({ transition: step, reason: 'collision with netherrack at (-35, 67, -43)' }), '', '不是头顶第三格就不加解释');
  assert.equal(ceilingNote({ transition: { ...step, kind: 'walk' }, reason: 'collision with netherrack at (-35, 68, -44)' }), '');
});
