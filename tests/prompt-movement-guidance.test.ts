import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMON_MOVES, deliberateSystem, glanceSystem, movesCatalog } from '../src/mind/prompt.ts';

test('普通方向移动优先 advance；move_step/descend_to 只保留精确或特殊场景', () => {
  for (const system of [deliberateSystem('P', []), glanceSystem('P', [])]) {
    assert.match(system, /普通朝一个方向走一段.*advance/);
    assert.match(system, /普通走路优先 advance/);
    assert.match(system, /descend_to 只给 advance 无法安全处理的明确下落/);
  }
  assert.ok(COMMON_MOVES.includes('advance'), 'advance 进入核心动作目录');
  const catalog = movesCatalog(28);
  assert.match(catalog, /^- advance /m);
  assert.match(catalog, /N\|NE\|E\|SE\|S\|SW\|W\|NW/);
  assert.match(catalog, /1-160/);
});
