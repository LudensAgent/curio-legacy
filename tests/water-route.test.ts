import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWaterRoute } from '../src/skills/water-route.ts';

/** 一片浅水：y<=59 石头，y60-62 水，y>=63 空气；再用 lid/support 覆盖个别格。 */
function waterWorld(overrides: Record<string, string> = {}) {
  return (p: { x: number; y: number; z: number }) => {
    const key = `${p.x},${p.y},${p.z}`;
    if (key in overrides) return overrides[key];
    if (p.y <= 59) return 'stone';
    if (p.y <= 62) return 'water';
    return 'air';
  };
}

test('water route goes around a ceiling and ends at an open surface column next to the shore', () => {
  // 身体在 (0,61,0) 的水柱里，正上方 (0,63,0) 是岩盖；目标脚在 (1,64,0) 的岩顶。
  // 直游会顶在岩盖下；唯一能上浮的开口在 x=2。
  const blockAt = waterWorld({
    '0,63,0': 'netherrack', '0,63,1': 'netherrack', '0,63,2': 'netherrack',
    '1,63,0': 'netherrack', '1,63,1': 'netherrack', '1,63,2': 'netherrack',
  });
  const route = planWaterRoute(blockAt, { x: 0.5, y: 61.2, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 });
  assert.ok(route, 'start is in observed water');
  assert.ok(route.cells.length >= 1, route.why);
  const last = route.cells.at(-1)!;
  assert.ok(!(last.x <= 1 && last.z >= 0 && last.z <= 2), `last water point ${last.x},${last.y},${last.z} must clear the lid`);
  assert.equal(last.y, 62, 'the last water point is at the open surface');
  assert.equal(blockAt({ x: last.x, y: last.y + 1, z: last.z }), 'air', 'the last column can be surfaced');
  assert.ok(route.cells.every((c) => blockAt(c) === 'water'), 'every waypoint is an observed water cell');
});

test('water route returns null when the body is not in observed water', () => {
  const route = planWaterRoute(waterWorld(), { x: 0.5, y: 64, z: 0.5 }, { x: 3, y: 64, z: 0.5 });
  assert.equal(route, null, 'no water contact: the caller should keep the direct behavior');
});

test('water route returns null when a dry target is not adjacent to water', () => {
  const blockAt = waterWorld();
  // 水只在 x<=3；目标 x=20 的干地离水太远，不属于 swim_to 的水路委托。
  const route = planWaterRoute(blockAt, { x: 0.5, y: 61, z: 0.5 }, { x: 20.5, y: 63, z: 0.5 });
  assert.equal(route, null);
});

test('water route to an in-water target descends and ends inside the target cell', () => {
  const blockAt = waterWorld({ '4,61,4': 'water' });
  const route = planWaterRoute(blockAt, { x: 0.5, y: 61, z: 0.5 }, { x: 4, y: 61, z: 4 });
  assert.ok(route, 'in-water target should be plannable');
  assert.ok(route.cells.length >= 1, route.why);
  const last = route.cells.at(-1)!;
  assert.ok(Math.hypot(last.x + 0.5 - 4, last.z + 0.5 - 4) <= 1.5, `last point ${last.x},${last.y},${last.z} should be at the target water cell`);
});

test('water route reports why when observed water cannot connect to the target bank', () => {
  // 目标岸边有可用的发射水柱（x=3），但身体所在的水袋被 x=1 的石墙隔开。
  const blockAt = (p: { x: number; y: number; z: number }) => {
    if (p.y <= 59) return 'stone';
    if (p.x === 1) return 'stone';
    if (p.x === 0 && p.y === 63 && p.z === 0) return 'netherrack'; // 起点水柱上方被封，不能就地发射
    if (p.y <= 62) return 'water';
    if (p.x === 2 && p.y === 63 && p.z === 0) return 'netherrack';
    return 'air';
  };
  const route = planWaterRoute(blockAt, { x: 0.5, y: 61, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 });
  assert.ok(route);
  assert.equal(route.cells.length, 0);
  assert.match(route.why ?? '', /水路|上岸|封住/);
});
