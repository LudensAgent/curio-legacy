import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, moveDetails, movesCatalog } from '../src/mind/prompt.ts';

test('取物与下一步：find_item 只查线索，take_items 带 target 才取出，next 必须能由自己的 steps 确认', () => {
  for (const system of [deliberateSystem('你叫 Curio。', []), glanceSystem('你叫 Curio。', [])]) {
    for (const marker of [
      'find_item 只查线索',
      '别用 inventory_min 验收',
      'take_items 不带 target 只列容器线索',
      'next 也只能写成查询段',
      'next 是下一段会实际执行的活动',
      'what 写了多个连续动作时',
      '目标远于一列',
      '同列没有可站立面是事实',
      'hold_item {"item":"物品名","to":"off-hand"}',
      'slot 只配 to:"hand" 的快捷栏 0–8',
      'interact_block {"target","item"}',
    ]) assert.ok(system.includes(marker), `缺少输出契约「${marker}」`);
  }
});

test('远距离移动动作用 travel_to/navigate_to/explore_toward，不走相邻格绝对坐标', () => {
  const system = deliberateSystem('你叫 Curio。', []);
  assert.match(system, /目标远于一列.*travel_to\/navigate_to\/explore_toward/);
});

test('explore_toward 的低频参数移出内联目录，仍能通过 moves 查到', () => {
  const line = movesCatalog(28).split('\n').find((entry) => entry.startsWith('- explore_toward '));
  assert.ok(line, 'system 目录里应有 explore_toward');
  assert.doesNotMatch(line, /maxEdits/, '低频参数不再内联，避免模型照着写错');
  assert.match(moveDetails(['explore_toward']), /maxEdits/, '完整参数仍可通过 moves 查询');
  assert.match(moveDetails(['explore_toward']), /只在写了 dig\/place 时有意义/, '低频参数附带使用前提');
});
