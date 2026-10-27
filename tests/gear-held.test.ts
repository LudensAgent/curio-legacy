import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gearAlreadyHeld } from '../src/skills/work.ts';

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
