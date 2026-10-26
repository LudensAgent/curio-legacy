import assert from 'node:assert/strict';
import test from 'node:test';
import { hudLandmarks } from '../src/observer/landmarks-hud.ts';
import type { Landmark } from '../src/memory/store.ts';

const now = 1_000_000_000;
let n = 0;
const lm = (kind: Landmark['kind'], label: string, x: number, z: number, extra: Partial<Landmark> = {}): Landmark =>
  ({ id: String(++n), kind, label, dim: 'overworld', pos: { x, y: 64, z }, ts: now - 1000, ...extra });

test('home first, then the latest death, own things and fresh resources by distance', () => {
  const here = { pos: { x: 0, y: 64, z: 0 }, dim: 'overworld' };
  const list = hudLandmarks([
    lm('discovery', '箱子', 5, 0),
    lm('discovery', '工作台', 100, 0),
    lm('discovery', '我的工作台', 100, 1),
    lm('death', '死亡地点', 50, 0, { ts: now - 10_000 }),
    lm('death', '死亡地点', 60, 0, { ts: now - 5_000 }),
    lm('resource', 'coal_ore', 30, 0),
    lm('resource', 'iron_ore', 3, 0, { ts: now - 20 * 60_000 }),
    lm('discovery', 'biome:plains', 1, 0),
    lm('base', '我的金合欢小屋', 200, 0),
    lm('discovery', '下界传送门', 8, 8, { dim: 'the_nether' }),
  ], here, 6, now);
  assert.deepEqual(list.map((l) => l.label), ['我的金合欢小屋', '死亡地点', '我的工作台', 'coal_ore', '箱子', '下界传送门']);
  assert.equal(list[1].x, 60, 'only the latest death');
  assert.equal(Math.round(list[0].distance!), 200);
  assert.equal(list[5].distance, null, 'other dimension');
  assert.ok(!list.some((l) => l.label === '工作台'), 'same spot as 我的工作台');
});

test('without a position every distance is unknown and the limit holds', () => {
  const list = hudLandmarks(Array.from({ length: 20 }, (_, i) => lm('discovery', '箱子' + i, i * 10, 0)), null, 6, now);
  assert.equal(list.length, 6);
  assert.ok(list.every((l) => l.distance === null));
});
