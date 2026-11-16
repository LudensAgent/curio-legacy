import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structureFromAchievement } from '../src/memory/structure-achievements.ts';
import { WorldMemory } from '../src/memory/store.ts';

test('结构成就转成结构化发现，旧 note 可补成地标且不重复', (t) => {
  assert.deepEqual(structureFromAchievement('Deepseek has made the advancement [A Terrible Fortress]'), {
    label: '下界要塞（暗红砖）', achievement: 'A Terrible Fortress',
  });
  assert.equal(structureFromAchievement('Deepseek has made the advancement [Taking Inventory]'), null);
  assert.equal(structureFromAchievement('Deepseek has made the advancement [The End?]'), null, '进入末地不是要塞坐标');
  assert.equal(structureFromAchievement('Deepseek has made the advancement [Those Were the Days]')?.label, '猪灵堡垒遗迹');
  assert.equal(structureFromAchievement('Deepseek has made the advancement [Hidden in the Depths]')?.label, '远古城市');

  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  const pos = { x: 219, y: 60, z: -224 };
  memory.addNote('fact', '游戏提示：Deepseek has made the advancement [A Terrible Fortress]', 'the_nether', pos);
  assert.equal(memory.promoteStructureAchievements(), 1);
  const found = memory.landmarks().find((landmark) => landmark.kind === 'discovery' && landmark.label === '下界要塞（暗红砖）');
  assert.ok(found);
  assert.deepEqual(found.pos, pos);
  assert.equal(found.dim, 'the_nether');
  assert.equal(memory.promoteStructureAchievements(), 0, '同一结构不重复写入');
});
