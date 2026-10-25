import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemTextures, textureCandidates } from '../src/observer/item-textures.ts';

test('背包贴图：物品用物品图，方块用正面/侧面，台阶楼梯用原料方块，找不到给 null', () => {
  assert.deepEqual(textureCandidates('spruce_stairs').slice(-4, -3), ['blocks/spruce_planks.png']);
  assert.ok(textureCandidates('glass_pane').includes('blocks/glass.png'));
  assert.ok(textureCandidates('oak_wood').includes('blocks/oak_log.png'));
  const t = itemTextures('1.20.1');
  if (!t.available) return; // 没装 prismarine-viewer 时跳过
  assert.match(t.resolve('wooden_pickaxe')!, /items[\\/]wooden_pickaxe\.png$/);
  assert.match(t.resolve('crafting_table')!, /crafting_table_front\.png$/);
  assert.match(t.resolve('cobblestone_slab')!, /blocks[\\/]cobblestone\.png$/);
  assert.equal(t.resolve('../../etc/passwd'), null);
});
