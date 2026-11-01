import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';

test('putPlaced / getPlaced / removePlaced 记录自己放置的方块', () => {
  const m = new WorldMemory(null);
  m.putPlaced({ x: 1, y: 64, z: 2 }, 'cobblestone');
  assert.equal(m.getPlaced({ x: 1, y: 64, z: 2 }), 'cobblestone');
  assert.equal(m.getPlaced({ x: 3, y: 64, z: 2 }), null);
  m.removePlaced({ x: 1, y: 64, z: 2 });
  assert.equal(m.getPlaced({ x: 1, y: 64, z: 2 }), null);
  // 移除不存在的格是无害 no-op
  m.removePlaced({ x: 9, y: 9, z: 9 });
  m.close();
});

test('queryPlacedNear 只返回半径内的，并按距离排', () => {
  const m = new WorldMemory(null);
  m.putPlaced({ x: 0, y: 64, z: 0 }, 'cobblestone'); // 距离 0
  m.putPlaced({ x: 5, y: 64, z: 0 }, 'torch'); // 距离 5
  m.putPlaced({ x: 100, y: 64, z: 0 }, 'obsidian'); // 距离 100，超半径
  const near = m.queryPlacedNear({ x: 0, y: 64, z: 0 }, 8);
  assert.deepEqual(near.map((b) => b.name).sort(), ['cobblestone', 'torch']);
  assert.equal(near.some((b) => b.name === 'obsidian'), false);
  m.close();
});

test('超出 LRU 上限淘汰最久未用的', () => {
  const m = new WorldMemory(null);
  // 塞满 4096（默认 cap）+ 再放一个，最旧的一个应被淘汰
  for (let i = 0; i < 4097; i++) m.putPlaced({ x: i, y: 64, z: 0 }, 'cobblestone');
  assert.equal(m.getPlaced({ x: 0, y: 64, z: 0 }), null, '最旧的被淘汰');
  assert.equal(m.getPlaced({ x: 1, y: 64, z: 0 }), 'cobblestone', '稍新的保留');
  m.close();
});
