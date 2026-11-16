import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskKey } from '../src/mind/task-label.ts';

test('任务标签保留字符串目标，对象目标写 JSON 而不是 [object Object]', () => {
  assert.equal(taskKey({ skill: 'advance', args: { direction: 'E' } }), 'advance E');
  assert.equal(taskKey({ skill: 'defend' }), 'defend');
  assert.equal(taskKey({ skill: 'place_cell', args: { block: 'cobblestone' } }), 'place_cell cobblestone');
  assert.equal(taskKey({ skill: 'travel_to', args: { to: 'base' } }), 'travel_to base');
  assert.equal(taskKey({ skill: 'travel_to', args: { to: { x: 12, y: 64, z: -3 } } }), 'travel_to {"x":12,"y":64,"z":-3}');
  assert.equal(taskKey(null), undefined);
});
