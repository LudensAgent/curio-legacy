import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waterCrossingHint } from '../src/mind/prompt.ts';

const P = (inWater: boolean, local?: { layers: Record<string, string[]> } | null, riding: string | null = null) =>
  ({ self: { inWater, riding, ...(local ? { local } : {}) } } as any);
const S = (inventory: { name: string; count: number }[]) => ({ inventory } as any);

test('waterCrossingHint：站在水边、有木板和方块时，报出垫路方块和船的代价', () => {
  const hint = waterCrossingHint(P(false, { layers: { 'u0': ['~~'] } }), S([{ name: 'cobblestone', count: 20 }, { name: 'oak_planks', count: 6 }]));
  assert.ok(hint);
  assert.match(hint!, /能垫路的方块 26 块/);
  assert.match(hint!, /木板 6 块（够造一只船）/);
});

test('waterCrossingHint：在船上不提示', () => {
  assert.equal(waterCrossingHint(P(true, { layers: { 'u0': ['~~'] } }, 'oak_boat'), S([])), null);
});

test('waterCrossingHint：没木板没方块时报出缺料', () => {
  const hint = waterCrossingHint(P(true, null), S([]));
  assert.ok(hint);
  assert.match(hint!, /没有能垫路的方块/);
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
