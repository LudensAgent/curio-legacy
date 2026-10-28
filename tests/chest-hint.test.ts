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

test('缺材料时说记得往哪个箱子放过：缺铁锭和木棍，指到小屋的箱子，木棍可以拿原木回来做；不报精确数量', () => {
  const needs = needsFromShortfall('iron_ingot 还差 2（有 0），stick 还差 1（有 0）');
  assert.deepEqual(needs, [{ item: 'iron_ingot', count: 2 }, { item: 'stick', count: 1 }]);
  const t = chestHint(fresh(), here, needs);
  assert.match(t, /记得往 箱子 \(293,68,-369\)（11 格外） 放过几个 iron_ingot/);
  assert.match(t, /放过不少 birch_log/, '缺木棍：记得放过原木也算');
  assert.doesNotMatch(t, /×\d/, '不说精确数量');
  assert.doesNotMatch(t, /"item"/, '不替它写好参数');
  assert.match(t, /选定并重新看见箱子后，用 target 指定这一只/);
  assert.doesNotMatch(t, /145,63,-121/, '同样有木头，挑记得更牢（自己放过）的那个箱子');
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

test('只看过一眼的箱子记得浅：顺眼看到的多的东西有印象，少的没印象', () => {
  const m = fresh();
  assert.match(chestHint(m, here, [{ item: 'stick', count: 1 }]), /stick|_log/);
  // 只瞥见过的 spruce_log×2 排在最多的三样之外（stick 4、cobblestone 38、spruce_log 2 → 三样都在），再多一样就挤掉
  m.noteChestUse('overworld', { x: 150, y: 63, z: -121 }, { seen: [{ name: 'dirt', count: 60 }, { name: 'gravel', count: 30 }, { name: 'sand', count: 20 }, { name: 'string', count: 2 }], day: 3 });
  assert.equal(chestHint(m, here, [{ item: 'string', count: 1 }]), '', '只有 2 根线，开箱时没注意到');
});

test('记忆会淡：放过的东西过了许多天、中间开了很多次别的箱子，就只剩“好像”，再久就忘了', () => {
  const m = fresh();
  const sure = m.recallChests('iron_ingot', { day: 3 })[0];
  assert.equal(sure.confidence, 'sure');
  const later = m.recallChests('iron_ingot', { day: 9 })[0];
  assert.equal(later?.confidence, 'likely', '6 天后：好像放过');
  for (let i = 0; i < 16; i++) m.noteChestUse('overworld', { x: 400 + i, y: 64, z: 0 }, { seen: [{ name: 'dirt', count: 5 }], day: 9 });
  assert.equal(m.recallChests('iron_ingot', { day: 12 }).length, 0, '又开了十几次别的箱子：忘了');
  assert.ok(m.recallChests('birch_log', { day: 12 }).length, '原木放过、后来开箱又看见过（印象加深），还记得');
});

test('拿光了就记成“这里没有”，近期不会再去翻；再放进去就又记得了', () => {
  const m = fresh();
  m.noteChestUse('overworld', hutPos, { took: [{ name: 'iron_ingot', count: 1 }], seen: [{ name: 'birch_log', count: 25 }], sought: ['iron_ingot'], day: 3 });
  assert.equal(m.recallChests('iron_ingot', { day: 3 }).length, 0);
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'iron_ingot', count: 3 }], seen: [{ name: 'birch_log', count: 25 }, { name: 'iron_ingot', count: 3 }], day: 3 });
  assert.equal(m.recallChests('iron_ingot', { day: 3 })[0]?.confidence, 'sure');
});

test('起过名的箱子按名字说', () => {
  const m = new WorldMemory(null);
  m.noteChestUse('overworld', hutPos, { put: [{ name: 'raw_iron', count: 9 }], seen: [{ name: 'raw_iron', count: 9 }], note: '放矿的', day: 1 });
  assert.match(chestHint(m, here, [{ item: 'raw_iron', count: 2 }]), /放矿的的?箱子 \(293,68,-369\)/);
});

test('旧版整箱快照加载后变成印象：最多的几样有印象，不再有精确数量', () => {
  const m = new WorldMemory(null) as any;
  m.data.chests['default:overworld:1,2,3'] = { dim: 'overworld', pos: { x: 1, y: 2, z: 3 }, ts: Date.now(), items: [{ name: 'cobblestone', count: 344 }, { name: 'iron_ingot', count: 1 }] };
  m.migrate();
  const rec = m.chests()[0];
  assert.equal(rec.items, undefined);
  assert.ok(rec.traces.some((t: any) => t.item === 'cobblestone' && t.kind === 'glimpsed' && t.qty === 'lots'));
});
