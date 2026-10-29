import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('熔炉离开时间按正常速度折算为现实时间，并说明未亲眼看到的推断', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.setFurnace({ dim: 'overworld', pos: { x: 100, y: 64, z: 0 }, block: 'furnace', input: { name: 'raw_iron', count: 1 }, output: null, fuel: null, burning: true, ts: Date.now() - 60_000 });
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const text = perception.update().waiting_on?.[0] ?? '';
  assert.match(text, /约 1 分前（现实时间）/);
  assert.match(text, /可能烧完了（燃料够且区块持续加载的话），没亲眼看到/);
});

test('农田提醒折算为现实时间，内部阈值仍使用现实分钟', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.addFarm({ id: 'wheat', dim: 'overworld', crop: 'wheat', cells: [{ x: 10, y: 63, z: 0 }], plantedAt: Date.now() - 25 * 60_000, harvests: 0 });
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const p = perception.update();
  assert.equal(p.farms[0].minutes_since_planted, 25);
  assert.match(p.drives.find((d) => d.drive === 'farm')?.why ?? '', /约 25 分（现实时间）/);
});
