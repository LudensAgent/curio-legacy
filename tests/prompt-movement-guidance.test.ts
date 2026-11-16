import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMON_MOVES, deliberateSystem, glanceSystem, movesCatalog } from '../src/mind/prompt.ts';

test('普通方向移动优先 advance；move_step/descend_to 只保留精确或特殊场景', () => {
  for (const system of [deliberateSystem('P', []), glanceSystem('P', [])]) {
    assert.match(system, /普通朝一个方向走一段.*advance/);
    assert.match(system, /普通走路优先 advance/);
    assert.match(system, /descend_to 只给 advance 无法安全处理的明确下落/);
    assert.match(system, /记得的地标可写方括号里的 id（不带括号）或名字，range 是接近半径、不是脚点/);
    assert.match(system, /explore_toward.*不接收目的地坐标.*不保证到达指定点/);
    assert.match(system, /目标远于一列\/挖不到的距离用 travel_to\/navigate_to；没有具体目的地、只知方向才用 explore_toward/);
  }
  assert.ok(COMMON_MOVES.includes('advance'), 'advance 进入核心动作目录');
  const catalog = movesCatalog(28);
  assert.match(catalog, /^- advance /m);
  assert.match(catalog, /N\|NE\|E\|SE\|S\|SW\|W\|NW/);
  assert.match(catalog, /1-160/);
});
