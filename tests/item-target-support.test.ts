import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemBlockTargetProblem } from '../src/adapter/mineflayer.ts';

test('锄头：可耕地且上方空气才通过；上方有草/目标不是可耕地时给出具体原因', () => {
  assert.equal(itemBlockTargetProblem('stone_hoe', 'grass_block', 'air'), null);
  assert.equal(itemBlockTargetProblem('wooden_hoe', 'dirt', 'cave_air'), null);
  assert.match(itemBlockTargetProblem('stone_hoe', 'grass_block', 'short_grass')!, /上方是 short_grass/);
  assert.match(itemBlockTargetProblem('stone_hoe', 'farmland', 'air')!, /已经是耕地/);
  assert.match(itemBlockTargetProblem('stone_hoe', 'stone', 'air')!, /只能把/);
  assert.match(itemBlockTargetProblem('stone_hoe', 'rooted_dirt', 'air')!, /只能把/, '缠根泥土只会先变泥土');
  assert.match(itemBlockTargetProblem('stone_hoe', 'coarse_dirt', 'air')!, /只能把/, '粗泥只会先变泥土');
  assert.equal(itemBlockTargetProblem('stone_hoe', 'grass_block', null), null, '上方未加载时不提前判定');
});

test('作物种子：只能种在耕地上、上方要空；对泥土/已有作物给出具体原因；堆肥桶不拦', () => {
  assert.equal(itemBlockTargetProblem('wheat_seeds', 'farmland', 'air'), null);
  assert.equal(itemBlockTargetProblem('carrot', 'farmland', 'air'), null);
  assert.equal(itemBlockTargetProblem('torchflower_seeds', 'farmland', 'air'), null);
  assert.match(itemBlockTargetProblem('wheat_seeds', 'dirt', 'air')!, /只能种在耕地上/);
  assert.match(itemBlockTargetProblem('wheat_seeds', 'farmland', 'wheat')!, /已经有 wheat/);
  assert.match(itemBlockTargetProblem('potato', 'farmland', 'water')!, /已经有 water/);
  assert.equal(itemBlockTargetProblem('wheat_seeds', 'composter', null), null, '种子可以放进堆肥桶');
  assert.equal(itemBlockTargetProblem('wheat_seeds', 'farmland', null), null, '上方未加载时不提前判定');
});

test('与种植无关的物品不额外限制', () => {
  assert.equal(itemBlockTargetProblem('flint_and_steel', 'obsidian', 'air'), null);
  assert.equal(itemBlockTargetProblem('bone_meal', 'wheat', 'air'), null);
  assert.equal(itemBlockTargetProblem('bucket', 'water', null), null);
});
