import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryFrom, semanticMemory } from './semantic-fixture.ts';

const W = 'resource-index-world';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

test('resource index answers near/name queries from Section buckets and tracks updates', () => {
  const { memory, stores, containers } = semanticMemory(W);
  memory.addLandmark('resource', 'iron_ore', D, at(0, 64, 0), 1);
  memory.addLandmark('resource', 'iron_ore', D, at(20, 64, 0), 1);
  memory.addLandmark('resource', 'coal_ore', D, at(0, 64, 20), 1);
  memory.addLandmark('resource', 'iron_ore', D, at(1000, 64, 0), 1);

  assert.deepEqual(memory.resourceLandmarksNear(['iron_ore'], D, at(0, 64, 0), 25)
    .map((landmark) => landmark.label).sort(), ['iron_ore', 'iron_ore']);
  assert.equal(memory.resourceLandmarksAround(D, at(0, 64, 0), 25).length, 3);
  assert.equal(memory.resourceLandmarksAround(D, at(0, 64, 0), 25)
    .some((landmark) => landmark.pos.x === 1000), false);

  for (let i = 0; i < 100; i++) memory.addLandmark('resource', 'iron_ore', D, at(0, 64, 0), 1);
  assert.equal(memory.resourceLandmarksAround(D, at(0, 64, 0), 25)
    .filter((landmark) => landmark.label === 'iron_ore' && landmark.pos.x === 0).length, 1,
  '重复看见同一格不增殖索引项');

  memory.markGone('iron_ore', D, at(0, 64, 0), 'stone');
  assert.equal(memory.resourceLandmarksAround(D, at(0, 64, 0), 25)
    .some((landmark) => landmark.pos.x === 0 && landmark.label === 'iron_ore'), false,
  'gone 资源立即从近邻索引撤销');

  memory.addLandmark('resource', 'diamond_ore', D, at(5, 64, 0), 1);
  assert.equal(memory.resourceLandmarksAround(D, at(0, 64, 0), 25)
    .some((landmark) => landmark.label === 'diamond_ore'), true,
  '新增资源在 revision 变化后立即可见');

  // A new semantic-store instance rebuilds the derived index from persisted nodes.
  const reopened = memoryFrom(stores, containers, W).memory;
  assert.equal(reopened.resourceLandmarksAround(D, at(0, 64, 0), 25).length, 3);
});

test('resource index rejects invalid radii and does not claim completeness', () => {
  const { memory } = semanticMemory(W);
  assert.throws(() => memory.resourceLandmarksAround(D, at(0, 64, 0), -1), /radius/);
  assert.throws(() => memory.resourceLandmarksAround(D, at(0, 64, 0), Number.NaN), /radius/);
  // The public query returns only observed/recorded anchors; it has no full-world
  // completeness claim, so an empty result is not evidence that no resource exists.
  assert.deepEqual(memory.resourceLandmarksAround('the_nether', at(0, 64, 0), 32), []);
  const status = memory.resourceIndexStatus();
  assert.equal(status.complete, false);
  assert.match(status.reason, /not a complete world resource scan/);
});
