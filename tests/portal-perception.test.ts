import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { localMap } from '../src/perception/local.ts';
import { bodyOverlapsPortal } from '../src/perception/portal.ts';
import { surroundings } from '../src/perception/surroundings.ts';
import { evaluateCondition, validateCondition } from '../src/projects/conditions.ts';
import { FakeAdapter } from './fake-adapter.ts';

const throwingAdapter = { blockAt: () => { throw new Error('不能用隐藏世界补全视觉'); } };

test('身体 AABB 压着门方块时，身边描述和 state 都报出身体所在格', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.bodyPortal = 'nether_portal';
  adapter.blocks.push(
    { name: 'nether_portal', pos: { x: 0, y: 64, z: 0 } },
    { name: 'nether_portal', pos: { x: 0, y: 65, z: 0 } },
  );
  const around = surroundings(adapter);
  assert.match(around.text, /身体所在格 nether_portal/, `身体格必须在身边描述里：${around.text}`);
  assert.equal(around.feet.block, 'nether_portal');
  assert.equal(around.head.block, 'nether_portal');
  assert.equal(around.support.block, 'grass_block');
  assert.equal(adapter.state().bodyPortal, 'nether_portal', 'state 的触觉事实必须能直接看出在门里');
});

test('身体不在门里时 bodyPortal 为 null，身边描述不虚构身体格', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'nether_portal', pos: { x: 3, y: 64, z: 0 } });
  const around = surroundings(adapter);
  assert.doesNotMatch(around.text, /身体所在格/);
  assert.equal(adapter.state().bodyPortal, null);
});

test('bodyOverlapsPortal 按身体 AABB 判断：门边缘擦到也算，站开一格不算', () => {
  const blockAt = (p: { x: number; y: number; z: number }) => (p.x === 0 && p.y === 64 && p.z === 0 ? 'nether_portal' : 'air');
  assert.equal(bodyOverlapsPortal(blockAt, { x: 0.5, y: 64, z: 0.5 }), true);
  assert.equal(bodyOverlapsPortal(blockAt, { x: 1.2, y: 64, z: 0.5 }), true, 'AABB 只擦到门格边缘也要报出来');
  assert.equal(bodyOverlapsPortal(blockAt, { x: 1.4, y: 64, z: 0.5 }), false, '身体完全离开门格');
  assert.equal(bodyOverlapsPortal(blockAt, { x: 0.5, y: 65, z: 0.5 }), false, '门只在 y=64 这一格');
});

test('local 地图不再用 Y 遮住身体所在的门方块', () => {
  const pos = { x: 0.5, y: 64, z: 0.5 };
  const empty = () => [];
  const map = localMap(throwingAdapter, pos, 'N', empty, 2, { feet: 'nether_portal', head: 'nether_portal' });
  assert.equal(map.layers['u+0'][2][2], '@', '脚格必须显示实际方块');
  assert.equal(map.layers['u+1'][2][2], '%', '头格必须显示实际方块');
  assert.match(map.legend['@'] ?? '', /nether_portal/);
  assert.match(map.legend['%'] ?? '', /nether_portal/);
  assert.deepEqual(map.body, { feet: 'nether_portal', head: 'nether_portal' });
  // 空气仍然保持原来的 Y，不把普通站立画成方块格。
  const plain = localMap(throwingAdapter, pos, 'N', empty, 2);
  assert.equal(plain.layers['u+0'][2][2], 'Y');
  assert.deepEqual(plain.body, { feet: null, head: null });
});

test('收工条件可以直接验收维度变化', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const condition = validateCondition({ type: 'self_state', field: 'dim', equals: 'the_nether' }, adapter, memory, adapter.state());
  assert.deepEqual(condition, { type: 'self_state', field: 'dim', equals: 'the_nether' });
  assert.equal(evaluateCondition(condition, adapter.state()).status, 'unsatisfied');
  adapter.dim = 'the_nether';
  const met = evaluateCondition(condition, adapter.state());
  assert.equal(met.status, 'satisfied');
  assert.deepEqual(met.actual, { field: 'dim', value: 'the_nether', expected: 'the_nether' });
  assert.throws(() => validateCondition({ type: 'self_state', field: 'dim', equals: 7 }, adapter, memory, adapter.state()), /self_state/);
});
