import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('视野里一大片矿：一次感知更新同类同片只记一次地标、且每帧有上限，不再每格都去查/写语义节点', () => {
  const adapter = new FakeAdapter();
  // 面前一整面金矿墙（下界常见）：几百格同名资源同时在视野里。
  for (let y = 60; y <= 70; y++) for (let z = -10; z <= 10; z++) adapter.blocks.push({ name: 'gold_ore', pos: { x: 6, y, z } });
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  let calls = 0;
  const add = memory.addLandmark.bind(memory);
  memory.addLandmark = ((...args: Parameters<typeof memory.addLandmark>) => { calls++; return add(...args); }) as typeof memory.addLandmark;
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  perception.update();
  assert.ok(calls > 0, '看见的资源仍会记');
  assert.ok(calls <= 12, `一次更新最多记 12 处，实际 ${calls}`);
});

test('同一片岩浆跨帧只记一次 danger；被 live 上限淘汰后也不在下一帧重建', () => {
  const adapter = new FakeAdapter();
  // 面前一整面岩浆墙，横跨两个 16³ 区段（y=60..70）。
  for (let y = 60; y <= 70; y++) for (let z = -10; z <= 10; z++) adapter.blocks.push({ name: 'lava', pos: { x: 6, y, z } });
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  const dangerWrites: { label: string; pos: { x: number; y: number; z: number } }[] = [];
  const add = memory.addLandmark.bind(memory);
  memory.addLandmark = ((kind, label, dim, pos, ...rest) => {
    if (kind === 'danger' && label === 'lava') dangerWrites.push({ label, pos: { ...pos } });
    return add(kind, label, dim, pos, ...rest);
  }) as typeof memory.addLandmark;
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  perception.update();
  const first = dangerWrites.length;
  assert.ok(first > 0, '第一次看见岩浆仍会记');
  assert.ok(first <= 2, `同一帧每个 16³ 区段只记一次，实际 ${first}`);
  perception.update();
  assert.equal(dangerWrites.length, first, '同一片岩浆后续帧不再写');
  for (const landmark of memory.landmarks().filter((l) => l.kind === 'danger' && l.label === 'lava')) memory.removeLandmark(landmark.id);
  perception.update();
  assert.equal(dangerWrites.length, first, '被淘汰后仍不在同一会话重建');
});
