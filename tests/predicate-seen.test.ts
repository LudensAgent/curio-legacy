import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalPredicate, validatePredicate, type Sense } from '../src/mind/predicate.ts';

/** 构造一个只关心 hostile 条件的 Sense（其余字段用不到的给哑值） */
function sense(hostiles: Sense['hostiles']): Sense {
  return {
    state: { hp: 20, food: 20, oxygen: 20, inWater: false, inLava: false, onGround: true, isDay: true, dim: 'overworld', inventory: [] } as never,
    hostiles, lightLevel: 15, facing: 'N', doing: null, hurtAgoMs: Infinity, cover: 'open', cell: () => 'air',
  };
}

test('hostile seen:true 只匹配看得见的怪，不写 seen 则听见的也算', () => {
  const hostiles = [
    { name: 'zombie', dist: 5, perception: 'seen' as const },
    { name: 'creeper', dist: 7, perception: 'heard' as const },
  ];
  assert.equal(evalPredicate({ hostile: { name: ['zombie'], within: 8, seen: true } }, sense(hostiles)), true);
  assert.equal(evalPredicate({ hostile: { name: ['creeper'], within: 8, seen: true } }, sense(hostiles)), false, '只听见的 creeper 不算 seen');
  assert.equal(evalPredicate({ hostile: { name: ['creeper'], within: 8 } }, sense(hostiles)), true, '不写 seen 时听见的也算');
});

test('hostile seen:false 只看听见的（没坐标的那类）', () => {
  const hostiles = [
    { name: 'zombie', dist: 5, perception: 'seen' as const },
    { name: 'creeper', dist: 7, perception: 'heard' as const },
  ];
  assert.equal(evalPredicate({ hostile: { name: ['creeper'], within: 8, seen: false } }, sense(hostiles)), true);
  assert.equal(evalPredicate({ hostile: { name: ['zombie'], within: 8, seen: false } }, sense(hostiles)), false);
});

test('validatePredicate 接受 seen 字段、拒绝非法值', () => {
  assert.ok(!('error' in validatePredicate({ hostile: { within: 8, seen: true } })));
  assert.match((validatePredicate({ hostile: { within: 8, seen: 'yes' } }) as { error: string }).error, /seen/);
});
