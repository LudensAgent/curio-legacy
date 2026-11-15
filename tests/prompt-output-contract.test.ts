import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, moveDetails, movesCatalog } from '../src/mind/prompt.ts';

test('取物与下一步：find_item 只查线索，take_items 带 target 才取出，next 必须能由自己的 steps 确认', () => {
  for (const system of [deliberateSystem('你叫 Curio。', []), glanceSystem('你叫 Curio。', [])]) {
    for (const marker of [
      'find_item 只查线索',
      '不代表已取得',
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

test('出发准备：区分随身/已装备/据点/历史/未取得，身体事实不冒充随身', () => {
  const system = deliberateSystem('你叫 Curio。', []);
  for (const marker of [
    '随身库存', '已装备', '副手槽里放着的', '已核实据点库存', '位置、内容和可访问性', '取出前不算随身',
    '历史库存', '只是线索，不算随身准备', '未取得资源', '数量未核实', '工具连耐久一起看',
  ]) assert.ok(system.includes(marker), `缺少补给状态语义「${marker}」`);
});

test('plan.needs 与 activity 写的是需求预算，不是已取得物资', () => {
  const system = deliberateSystem('你叫 Curio。', []);
  for (const marker of ['是需求不是已取得物资', 'activity/next/methods 里写的物资同样只是需求', '换 method 不清空未完成 needs（除非明确重估了目标或需求）']) {
    assert.ok(system.includes(marker), `缺少需求预算语义「${marker}」`);
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
