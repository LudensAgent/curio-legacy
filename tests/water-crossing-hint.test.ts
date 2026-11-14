import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waterCrossingHint } from '../src/mind/prompt.ts';

const P = (inWater: boolean, local?: { layers: Record<string, string[]> } | null, riding: string | null = null) =>
  ({ self: { inWater, riding, ...(local ? { local } : {}) } } as any);
const S = (inventory: { name: string; count: number }[]) => ({ inventory } as any);

test('waterCrossingHint：站在水边、有木板和方块时，报出垫路方块和船的代价', () => {
  const hint = waterCrossingHint(P(false, { layers: { 'u0': ['~~'] } }), S([{ name: 'cobblestone', count: 20 }, { name: 'oak_planks', count: 6 }]));
  assert.ok(hint);
  assert.match(hint!, /any 能用的土石类方块 20 块/); // 木板不在 any 范围内，单独按造船报
  assert.match(hint!, /木板 6 块（够造一只船）/);
});

test('waterCrossingHint：在船上不提示', () => {
  assert.equal(waterCrossingHint(P(true, { layers: { 'u0': ['~~'] } }, 'oak_boat'), S([])), null);
});

test('waterCrossingHint：没木板没方块时报出缺料', () => {
  const hint = waterCrossingHint(P(true, null), S([]));
  assert.ok(hint);
  assert.match(hint!, /any 能用的土石类方块没有/);
  assert.match(hint!, /没有船，木板也不够造/);
});

test('waterCrossingHint：背包有船就报有船', () => {
  const hint = waterCrossingHint(P(true, null), S([{ name: 'oak_boat', count: 1 }]));
  assert.ok(hint);
  assert.match(hint!, /有船 1 只/);
});

test('waterCrossingHint：不近水（也不在水里）不提示', () => {
  assert.equal(waterCrossingHint(P(false, null), S([{ name: 'cobblestone', count: 20 }])), null);
});

test('waterCrossingHint：在水里时把 swim_path 的水路与脚坐标口径贴到现场', () => {
  const hint = waterCrossingHint(P(true, null), S([]));
  assert.ok(hint);
  assert.match(hint!, /swim_path \{"mode":"dry_shore","xyz":\[脚坐标\]\}/);
  assert.match(hint!, /沿已看到的水路绕行（不挖不垫）/);
  assert.match(hint!, /bx\+0\.5, by\+1, bz\+0\.5/);
});

test('waterCrossingHint：只站在水边（身体不在水里）不给 swim_path 上岸口径', () => {
  const hint = waterCrossingHint(P(false, { layers: { 'u0': ['~~'] } }), S([]));
  assert.ok(hint);
  assert.doesNotMatch(hint!, /swim_path/);
});

test('waterCrossingHint：在水边给出从水里直接上岸的高度机制事实', () => {
  for (const hint of [waterCrossingHint(P(true, null), S([])), waterCrossingHint(P(false, { layers: { 'u0': ['~~'] } }), S([]))]) {
    assert.ok(hint);
    assert.match(hint!, /从水里直接爬上岸，岸顶最多比水面高 1 格/);
    assert.match(hint!, /更高的岸要先垫方块或挖台阶/);
  }
});
