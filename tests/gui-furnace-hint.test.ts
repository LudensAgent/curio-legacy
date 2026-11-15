import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useGui } from '../src/skills/gui.ts';
import { WorldMemory } from '../src/memory/store.ts';

test('use_gui 看到熔炉产物时，明确说还没取出并给出 collect_furnace/ops 写法', async (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld('w');
  const target = { x: 2, y: 64, z: 0 };
  const adapter = {
    state: () => ({
      worldId: 'w', dim: 'overworld', worldDay: 1, pos: { x: 0.5, y: 64, z: 0.5 },
      inventory: [], emptySlots: 36, observationReady: true, connected: true,
    }),
    useGui: async () => ({
      ok: true, done: [], view: { type: 'furnace', slots: [
        { slot: 0, role: 'input', name: null, count: 0 },
        { slot: 1, role: 'fuel', name: null, count: 0 },
        { slot: 2, role: 'output', name: 'iron_ingot', count: 1 },
      ] },
    }),
  };
  const senses = {
    refresh() {},
    observeBlocks: (positions: { x: number; y: number; z: number }[]) =>
      positions.map((pos) => ({ pos, name: 'furnace', source: 'vision', observedAt: Date.now(), properties: {} })),
  };
  const result = await useGui.run({ adapter, memory, senses, signal: new AbortController().signal } as never, { target, ops: [] });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.match(result.summary, /产物格 2 还有 iron_ingot×1/);
  assert.match(result.summary, /没有取出/);
  assert.match(result.summary, /collect_furnace \{"at":\{"x":2,"y":64,"z":0\}\}/);
  assert.match(result.summary, /ops":\[\{"take":\{"slot":2\}\}\]/);
});
