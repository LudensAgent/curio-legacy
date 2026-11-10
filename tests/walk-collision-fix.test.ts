import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walkCollisionProvider } from '../src/adapter/walk-collision.ts';

const noNeighbors = { cell: (x: number, y: number, z: number) => ({ kind: 'unknown' as const, pos: { x, y, z } }) };
const resolve = (name: string, properties: Record<string, string> = {}) =>
  walkCollisionProvider.resolve({ name, properties }, { x: 0, y: 0, z: 0 }, noNeighbors);

test('整块碰撞形状精确等于单位格边界，不向相邻格膨胀', () => {
  const stone = resolve('minecraft:stone');
  assert.equal(stone.kind, 'shape');
  assert.deepEqual(stone.kind === 'shape' ? stone.shape.boxes : null, [
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
  ]);
  assert.deepEqual(stone.kind === 'shape' ? stone.shape.supportFaces : null, [
    { top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
  ]);
});

test('非整块碰撞形状保留真实子盒，不被放大成整格', () => {
  const slab = resolve('minecraft:oak_slab', { type: 'bottom' });
  assert.equal(slab.kind, 'shape');
  assert.deepEqual(slab.kind === 'shape' ? slab.shape.boxes : null, [
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 },
  ]);

  const fence = resolve('minecraft:oak_fence', {});
  assert.equal(fence.kind, 'shape');
  assert.equal(fence.kind === 'shape' ? fence.shape.boxes.length : 0, 3);
  assert.ok(fence.kind === 'shape' && fence.shape.boxes.every((box) => box.minX > 0 || box.maxX < 1 || box.minZ > 0 || box.maxZ < 1), '栅栏不得被合并或膨胀成一个整格');
});
