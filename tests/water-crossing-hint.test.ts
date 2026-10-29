import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waterCrossingHint } from '../src/mind/prompt.ts';

const P = (inWater: boolean, local?: { layers: Record<string, string[]> } | null, riding: string | null = null) =>
  ({ self: { inWater, riding, ...(local ? { local } : {}) } } as any);
const S = (inventory: { name: string; count: number }[]) => ({ inventory } as any);

test('waterCrossingHint：站在水边、有木板和方块时，摆出三条路的代价', () => {
  const hint = waterCrossingHint(P(false, { layers: { 'u0': ['~~'] } }), S([{ name: 'cobblestone', count: 20 }, { name: 'oak_planks', count: 6 }]));
  assert.ok(hint);
  assert.match(hint!, /架桥.*26 块能垫/);
  assert.match(hint!, /坐船.*6 块木板/);
  assert.match(hint!, /直接游过去/);
});

test('waterCrossingHint：在船上不提示', () => {
  assert.equal(waterCrossingHint(P(true, { layers: { 'u0': ['~~'] } }, 'oak_boat'), S([])), null);
});

test('waterCrossingHint：没木板没方块时报出缺料', () => {
  const hint = waterCrossingHint(P(true, null), S([]));
  assert.ok(hint);
  assert.match(hint!, /没有能垫的方块/);
  assert.match(hint!, /没船也没够木板/);
});

test('waterCrossingHint：背包有船就报有船', () => {
  const hint = waterCrossingHint(P(true, null), S([{ name: 'oak_boat', count: 1 }]));
  assert.ok(hint);
  assert.match(hint!, /有船 1 只/);
});

test('waterCrossingHint：不近水（也不在水里）不提示', () => {
  assert.equal(waterCrossingHint(P(false, null), S([{ name: 'cobblestone', count: 20 }])), null);
});
