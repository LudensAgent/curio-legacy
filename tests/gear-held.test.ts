import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gearAlreadyHeld, gearAlreadyHeldInText } from '../src/skills/work.ts';

test('已经有同类、等级不低、还经用的剑 → 不再做；快坏了或等级更低才做', () => {
  const swords = [{ name: 'iron_sword', count: 3, durability: { left: 100, max: 250 }, durabilities: [133, 127, 100] }];
  assert.match(gearAlreadyHeld('iron_sword', swords)!, /iron_sword×3/);
  assert.ok(gearAlreadyHeld('stone_sword', swords), '有铁剑就不用石剑');
  assert.equal(gearAlreadyHeld('diamond_sword', swords), null, '升级可以做');
  assert.equal(gearAlreadyHeld('iron_sword', [{ name: 'iron_sword', count: 1, durability: { left: 20, max: 250 }, durabilities: [20] }]), null, '快坏了可以补');
  assert.equal(gearAlreadyHeld('iron_pickaxe', [{ name: 'iron_pickaxe', count: 1, durability: { left: 200, max: 250 }, durabilities: [200] }]), null, '镐可以多带一把备用');
  assert.ok(gearAlreadyHeld('stone_pickaxe', [{ name: 'stone_pickaxe', count: 2, durability: { left: 100, max: 131 }, durabilities: [120, 100] }]));
  assert.ok(gearAlreadyHeld('iron_helmet', [], [{ slot: 'head', name: 'iron_helmet', durabilityRemaining: 150 } as any]));
  assert.equal(gearAlreadyHeld('torch', swords), null);
});

test('清单文字里提到的装备，身上已有同级或更好的才提示不用做', () => {
  const inv = [{ name: 'diamond_sword', count: 1, durability: { left: 1289, max: 1561 }, durabilities: [1289] }];
  // 有钻石剑还写「打铁剑」→ 提示
  assert.match(gearAlreadyHeldInText('打出铁剑', inv)!, /diamond_sword/);
  // 「盾」这类简称也能对上物品名「盾牌」
  assert.match(gearAlreadyHeldInText('打出铁剑、盾和铁护甲', [...inv, { name: 'shield', count: 1, durability: { left: 336, max: 336 }, durabilities: [336] }])!, /diamond_sword/);
  // 「铁靴」对上「铁靴子」
  assert.match(gearAlreadyHeldInText('做一双铁靴', [{ name: 'iron_boots', count: 1, durability: { left: 100, max: 195 }, durabilities: [100] }])!, /iron_boots/);
  // 想升级（有铁剑想做钻石剑）不提示
  assert.equal(gearAlreadyHeldInText('打出钻石剑', [{ name: 'iron_sword', count: 1, durability: { left: 200, max: 250 }, durabilities: [200] }]), null);
  // 没提装备的文字不提示
  assert.equal(gearAlreadyHeldInText('砍树补木棍', inv), null);
});
