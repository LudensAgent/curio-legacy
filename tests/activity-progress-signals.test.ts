import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { createActivity, prepProgressOf, progressSignals, storedItemsOf } from '../src/mind/activity.ts';

const state = (inventory: AgentState['inventory'], emptySlots: number, overrides: Partial<AgentState> = {}): AgentState => ({
  connected: true, alive: true, observationReady: true, observationId: 1, username: 'tester',
  sessionId: 's', worldId: 'w', dim: 'overworld', pos: { x: 0.5, y: 64, z: 0.5 },
  hp: 20, food: 20, oxygen: 20, timeOfDay: 0, isDay: true, biome: null,
  onGround: true, inWater: false, inLava: false, inventory, emptySlots, held: null,
  ...overrides,
});

const idle = { newChunks: false, planAdvanced: false, frontierAdvanced: false };
const empty = { exploration: { found: [] } };

test('腾出一个背包空位算准备类进展，即使没有物品/区块/清单/前沿推进', () => {
  const start = state([{ name: 'oak_log', count: 64 }], 35);
  const a = createActivity({ what: '用掉整叠木料', why: '', kind: 'build', repeat: 1, steps: [{ skill: 'place_cell', args: {} }] }, '', 'llm', start);
  const end = state([], 36);

  const signals = progressSignals(empty, { ...idle, ...prepProgressOf(a, end) });

  assert.equal(signals.freedSlot, true);
  assert.equal(signals.acquiredTarget, false);
  assert.equal(signals.locatedTarget, false);
  assert.equal(signals.observedTarget, false);
  assert.equal(signals.progressed, true);
});

test('存入容器的件数来自 store_items 回执，不来自活动文字', () => {
  const start = state([{ name: 'cobblestone', count: 12 }], 35);
  const withReceipt = createActivity({
    what: '把石头存进箱子', why: '', kind: 'tidy', repeat: 1,
    steps: [{ skill: 'store_items', args: {} }],
  }, '', 'llm', start);
  withReceipt.results.push({
    skill: 'store_items', args: {}, status: 'succeeded', summary: '存入 12 件', at: 0, durationMs: 1,
    data: { moved: 12 },
  });
  assert.equal(storedItemsOf(withReceipt), 12);

  const stored = progressSignals(empty, { ...idle, storedItems: storedItemsOf(withReceipt) });
  assert.equal(stored.storedItem, true);
  assert.equal(stored.freedSlot, false);
  assert.equal(stored.progressed, true);

  const textOnly = createActivity({
    what: '把石头存进箱子', why: '', kind: 'tidy', repeat: 1,
    steps: [{ skill: 'wait', args: {} }],
  }, '', 'llm', start);
  assert.equal(storedItemsOf(textOnly), 0);
  assert.equal(progressSignals(empty, { ...idle, storedItems: storedItemsOf(textOnly) }).progressed, false);
});

test('没有实测准备变化的活动仍不算进展', () => {
  const start = state([{ name: 'oak_log', count: 12 }], 35);
  const a = createActivity({ what: '在旁边看看', why: '', kind: 'experiment', repeat: 1, steps: [{ skill: 'look', args: {} }] }, '', 'llm', start);
  const end = state([{ name: 'oak_log', count: 12 }], 35);

  const signals = progressSignals(empty, { ...idle, ...prepProgressOf(a, end), storedItems: storedItemsOf(a) });

  assert.equal(signals.freedSlot, false);
  assert.equal(signals.foodStocked, false);
  assert.equal(signals.gearRepaired, false);
  assert.equal(signals.storedItem, false);
  assert.equal(signals.progressed, false);
});

test('食物与装备耐久按开工→结束的实测差量算准备进展', () => {
  const start = state([{ name: 'bread', count: 1 }, { name: 'iron_pickaxe', count: 1, durability: { left: 10, max: 250 } }], 35);
  const a = createActivity({ what: '补给', why: '', kind: 'tidy', repeat: 1, steps: [{ skill: 'wait', args: {} }] }, '', 'llm', start);
  const end = state([{ name: 'bread', count: 3 }, { name: 'iron_pickaxe', count: 1, durability: { left: 100, max: 250 } }], 35);

  const signals = progressSignals(empty, { ...idle, ...prepProgressOf(a, end), storedItems: storedItemsOf(a) });

  assert.equal(signals.foodStocked, true);
  assert.equal(signals.gearRepaired, true);
  assert.equal(signals.progressed, true);
});

test('中断/死亡丢失物品造成的空槽不算准备进展', () => {
  const start = state([{ name: 'oak_log', count: 64 }], 35);
  const a = createActivity({ what: '死亡掉包', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'wait', args: {} }] }, '', 'llm', start);
  const end = state([], 36);

  const signals = progressSignals(empty, { ...idle, ...prepProgressOf(a, end, { countFreedSlots: false }), storedItems: 0 });

  assert.equal(signals.freedSlot, false);
  assert.equal(signals.progressed, false);
});
