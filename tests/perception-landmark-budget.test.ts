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
