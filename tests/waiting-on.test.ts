import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const a = new FakeAdapter();
  const bus = new EventBus();
  const events: string[] = [];
  bus.on?.('event', (e: any) => events.push(`${e.type}:${e.msg}`));
  const vision = new Vision(a);
  const perception = new Perception(a, new WorldMemory(null), bus, vision);
  return { a, bus, events, vision, perception };
};

test('地上没捡的东西：记得第一次看到的时间，说出最多还能留多久，快消失时注意到一次', () => {
  const { a, vision, perception, events } = setup();
  a.entities.push({ id: 7, name: 'item:white_bed', kind: 'item', pos: { x: 6, y: 64, z: 0 }, dist: 6, height: 0.25, count: 1 } as any);
  perception.update();
  // 假装 4 分钟前就第一次看到了
  const rec = (vision as any).dropSightings.get(7);
  assert.ok(rec, '看见过就记下');
  rec.first -= 240_000;
  let p = perception.update();
  assert.ok(p.waiting_on?.some((t) => /white_bed×1/.test(t) && /最多再过 1 分钟/.test(t)), JSON.stringify(p.waiting_on));
  p = perception.update();
  assert.equal(events.filter((e) => e.startsWith('process_changed') && /white_bed/.test(e)).length, 1, '只提醒一次');
});

test('刚掉的不提；正看着那块地方东西却没了（被捡走）就忘掉', async () => {
  const { a, vision, perception } = setup();
  a.entities.push({ id: 8, name: 'item:cobblestone', kind: 'item', pos: { x: 5, y: 64, z: 0 }, dist: 5, height: 0.25, count: 3 } as any);
  let p = perception.update();
  assert.equal(p.waiting_on?.length ?? 0, 0, '不到 45 秒的不提');
  a.entities = a.entities.filter((e) => e.id !== 8);
  await new Promise((r) => setTimeout(r, 200));
  perception.update();
  assert.equal((vision as any).dropSightings.has(8), false);
});
