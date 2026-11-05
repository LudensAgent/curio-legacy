import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { localMap } from '../src/perception/local.ts';
import { bodyOverlapsPortal, portalStance } from '../src/perception/portal.ts';
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

test('门外站位要求空气脚格与实心非液体支撑，不落在门里/岩浆上', () => {
  const portal = new Set(['0,64,0', '1,64,0', '0,65,0', '1,65,0', '0,66,0', '1,66,0']);
  const frame = new Set(['0,63,0', '1,63,0', '-1,64,0', '-1,65,0', '-1,66,0', '2,64,0', '2,65,0', '2,66,0', '0,67,0', '1,67,0']);
  const blockAt = (support: string) => (p: { x: number; y: number; z: number }) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (portal.has(key)) return 'nether_portal';
    if (frame.has(key)) return 'obsidian';
    if (p.y === 63 && p.z === 1 && (p.x === 0 || p.x === 1)) return support;
    return 'air';
  };
  const stance = portalStance(blockAt('stone'), { x: 0, y: 64, z: 0 });
  assert.ok(stance, '门南侧有实心地面时应给出站位');
  assert.equal(stance.z, 1.5, '站位在门方块外侧一格');
  assert.equal(blockAt('stone')({ x: Math.floor(stance.x), y: Math.floor(stance.y), z: Math.floor(stance.z) }), 'air');
  assert.equal(portalStance(blockAt('lava'), { x: 0, y: 64, z: 0 }), null, '岩浆上的格不能当门外站位');
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
  assert.throws(() => validateCondition({ type: 'self_state', field: 'dim', equals: 'nether' }, adapter, memory, adapter.state()), /self_state/, '写错的维度名当场拒绝');
});
