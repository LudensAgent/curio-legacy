import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chestHint, needsFromShortfall } from '../src/skills/chest-hint.ts';

// 10-26 晚小屋旁边那个箱子，和远处一个旧箱子
const hut = { dim: 'overworld', pos: { x: 293, y: 68, z: -369 }, ts: 0, items: [
  { name: 'jungle_log', count: 1 }, { name: 'oak_sapling', count: 4 }, { name: 'sandstone', count: 1 }, { name: 'oak_door', count: 2 },
  { name: 'spider_eye', count: 2 }, { name: 'string', count: 4 }, { name: 'sand', count: 10 }, { name: 'oak_log', count: 13 },
  { name: 'birch_log', count: 25 }, { name: 'furnace', count: 3 }, { name: 'glass_pane', count: 11 }, { name: 'iron_ingot', count: 1 },
  { name: 'cobblestone', count: 344 }] };
const old = { dim: 'overworld', pos: { x: 145, y: 63, z: -121 }, ts: 0, items: [{ name: 'stick', count: 4 }, { name: 'cobblestone', count: 38 }] };
const memory = { chests: (dim?: string) => [hut, old].filter((c) => !dim || c.dim === dim) } as any;
const here = { dim: 'overworld', pos: { x: 300, y: 64, z: -360 } };

test('缺材料时说记得的箱子里有：缺铁锭和木棍，指到最近的箱子，木棍可以拿原木回来做', () => {
  const needs = needsFromShortfall('iron_ingot 还差 2（有 0），stick 还差 1（有 0）');
  assert.deepEqual(needs, [{ item: 'iron_ingot', count: 2 }, { item: 'stick', count: 1 }]);
  const t = chestHint(memory, here, needs);
  assert.match(t, /\(293,68,-369\) 的箱子（11 格外）里有 iron_ingot×1/);
  assert.match(t, /take_items 拿（如 \{"item":"iron_ingot","count":1\}）/);
  assert.match(t, /birch_log×25/, '缺木棍：箱子里的原木也算');
  assert.doesNotMatch(t, /145,63,-121/, '同样有木头，挑近的那个箱子');
});

test('缺木板：箱子里没有木板但有原木，就说原木，按 4 块木板一根原木拿', () => {
  const t = chestHint(memory, here, [{ item: 'birch_planks', count: 6 }]);
  assert.match(t, /"item":"birch_log","count":2/);
});

test('盖房缺玻璃板：箱子里就有；缺的东西哪个箱子都没有就什么都不说', () => {
  assert.match(chestHint(memory, here, [{ item: 'glass_pane', count: 5 }]), /glass_pane×11.*"item":"glass_pane","count":5/);
  assert.equal(chestHint(memory, here, [{ item: 'diamond', count: 1 }]), '');
  assert.equal(chestHint({ chests: () => [] } as any, here, [{ item: 'stick', count: 1 }]), '');
});

test('烧东西缺燃料：箱子里的原木也能当燃料', () => {
  assert.match(chestHint(memory, here, [], { fuel: true }), /箱子.*_log/);
});
