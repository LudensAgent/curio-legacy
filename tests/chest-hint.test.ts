import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chestHint, needsFromShortfall } from '../src/skills/chest-hint.ts';
import { WorldMemory } from '../src/memory/store.ts';

// 10-26 晚小屋旁边那个箱子（存过几回东西），和远处一个只打开看过一眼的旧箱子
const hutPos = { x: 293, y: 68, z: -369 }, oldPos = { x: 145, y: 63, z: -121 };
const fresh = () => {
  const m = new WorldMemory(null);
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'birch_log', count: 25 }, { name: 'oak_log', count: 13 }, { name: 'cobblestone', count: 300 }], seen: [{ name: 'birch_log', count: 25 }, { name: 'oak_log', count: 13 }, { name: 'cobblestone', count: 344 }, { name: 'glass_pane', count: 11 }, { name: 'sand', count: 10 }], day: 3 });
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'iron_ingot', count: 1 }, { name: 'glass_pane', count: 11 }], seen: [{ name: 'birch_log', count: 25 }, { name: 'oak_log', count: 13 }, { name: 'cobblestone', count: 344 }, { name: 'glass_pane', count: 11 }, { name: 'iron_ingot', count: 1 }], day: 3 });
  m.noteChestUse('overworld', oldPos, { seen: [{ name: 'stick', count: 4 }, { name: 'cobblestone', count: 38 }, { name: 'spruce_log', count: 2 }], day: 3 });
  return m;
};
const here = { dim: 'overworld', pos: { x: 300, y: 64, z: -360 }, worldDay: 3 };

test('缺材料时精确指到最近的箱子并报数量', () => {
  const needs = needsFromShortfall('iron_ingot 还差 2（有 0），stick 还差 1（有 0）');
  assert.deepEqual(needs, [{ item: 'iron_ingot', count: 2 }, { item: 'stick', count: 1 }]);
  const t = chestHint(fresh(), here, needs);
  assert.match(t, /293,68,-369/);
  assert.match(t, /iron_ingot×1/);
  assert.match(t, /birch_log×25/, '缺木棍：原木也算，报精确数量');
  assert.match(t, /×\d/, '报精确数量');
  assert.doesNotMatch(t, /"item"/, '不替它写好参数');
  assert.match(t, /target 指定这一只/);
  assert.doesNotMatch(t, /145,63,-121/, '挑最近的那个箱子（小屋）');
});

test('缺木板：记得放过原木就说原木', () => {
  assert.match(chestHint(fresh(), here, [{ item: 'birch_planks', count: 6 }]), /birch_log/);
});

test('缺的东西哪个箱子都不记得就什么都不说；没箱子也不说', () => {
  assert.equal(chestHint(fresh(), here, [{ item: 'diamond', count: 1 }]), '');
  assert.equal(chestHint(new WorldMemory(null), here, [{ item: 'stick', count: 1 }]), '');
});

test('烧东西缺燃料：记得放过原木也能当燃料', () => {
  assert.match(chestHint(fresh(), here, [], { fuel: true }), /_log/);
});

test('精确记内容：开箱看到的东西都能查到', () => {
  const m = fresh();
  assert.match(chestHint(m, here, [{ item: 'stick', count: 1 }]), /stick|_log/);
  m.noteChestUse('overworld', { x: 150, y: 63, z: -121 }, { seen: [{ name: 'dirt', count: 60 }, { name: 'gravel', count: 30 }, { name: 'sand', count: 20 }, { name: 'string', count: 2 }], day: 3 });
  assert.match(chestHint(m, here, [{ item: 'string', count: 1 }]), /string×2/, '精确记得有 2 根线');
});

test('精确记忆不淡忘：过了多少天、开多少次别的箱子都不忘', () => {
  const m = fresh();
  assert.equal(m.recallChests('iron_ingot', { day: 3 })[0].count, 1);
  assert.equal(m.recallChests('iron_ingot', { day: 9 })[0].count, 1, '6 天后仍然精确');
  for (let i = 0; i < 16; i++) m.noteChestUse('overworld', { x: 400 + i, y: 64, z: 0 }, { seen: [{ name: 'dirt', count: 5 }], day: 9 });
  assert.equal(m.recallChests('iron_ingot', { day: 12 }).length, 1, '开多少次别的箱子也不忘');
  assert.equal(m.recallChests('birch_log', { day: 12 })[0].count, 25);
});

test('拿光了就没了；再放进去又精确有了', () => {
  const m = fresh();
  m.noteChestUse('overworld', hutPos, { took: [{ name: 'iron_ingot', count: 1 }], seen: [{ name: 'birch_log', count: 25 }], sought: ['iron_ingot'], day: 3 });
  assert.equal(m.recallChests('iron_ingot', { day: 3 }).length, 0, '拿光了');
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'iron_ingot', count: 3 }], seen: [{ name: 'birch_log', count: 25 }, { name: 'iron_ingot', count: 3 }], day: 3 });
  assert.equal(m.recallChests('iron_ingot', { day: 3 })[0].count, 3, '再放进去精确 3 个');
});

test('起过名的箱子按名字说', () => {
  const m = new WorldMemory(null);
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'raw_iron', count: 9 }], seen: [{ name: 'raw_iron', count: 9 }], note: '放矿的', day: 1 });
  assert.match(chestHint(m, here, [{ item: 'raw_iron', count: 2 }]), /放矿的的?箱子 \(293,68,-369\)/);
});
