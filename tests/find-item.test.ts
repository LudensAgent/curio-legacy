import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findItem } from '../src/skills/economy.ts';
import { WorldMemory } from '../src/memory/store.ts';

const ctx = (m: WorldMemory, inventory: { name: string; count: number }[] = []) => ({
  adapter: { state: () => ({ inventory, pos: { x: 0.5, y: 64, z: 0.5 }, dim: 'overworld' }) },
  memory: m,
  // find_item 现在会把附近未打开的容器说进摘要；纯记忆测试里没有可见方块。
  senses: { refresh() {}, knownBlocks: () => [], observeBlocks: () => [] },
  signal: new AbortController().signal,
});

test('find_item 只返回最近、其次数量最多的箱子，并给合计', async (t) => {
  const m = new WorldMemory(null);
  t.after(() => m.close());
  m.setWorld('w');
  m.setChest('overworld', { x: 20, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 100 }]); // 远但最多，不该被选
  m.setChest('overworld', { x: 2, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 1 }]);   // 近但少
  m.setChest('overworld', { x: 2, y: 64, z: 1 }, [{ name: 'iron_ingot', count: 8 }]);   // 同近且多
  const r = await findItem.run(ctx(m) as any, { item: 'iron_ingot' });
  assert.equal(r.status, 'succeeded');
  const d = r.data as any;
  assert.equal(d.backpack, 0);
  assert.equal(d.chest.count, 8, '同近（约 2 格）选数量多的');
  assert.deepEqual(d.chest.pos, { x: 2, y: 64, z: 1 });
  assert.deepEqual(d.target, { x: 2, y: 64, z: 1 }, 'find_item 直接给出可复制的 target');
  assert.match(r.summary, /take_items \{"item":"iron_ingot","target":\{"x":2,"y":64,"z":1\}\}/);
  assert.equal(d.inChests, 109);
  assert.equal(d.total, 109);
});

test('find_item 没有打开记录时，列出看见的未打开容器和 target', async (t) => {
  const m = new WorldMemory(null);
  t.after(() => m.close());
  m.setWorld('w');
  const block = { name: 'chest', pos: { x: 2, y: 64, z: 0 }, dist: 2 };
  const c = {
    adapter: { state: () => ({ inventory: [], pos: { x: 0.5, y: 64, z: 0.5 }, dim: 'overworld', worldId: 'w' }) },
    memory: m,
    senses: {
      refresh() {},
      knownBlocks: () => [block],
      observeBlocks: (positions: { x: number; y: number; z: number }[]) => positions.map((pos) => ({
        name: 'chest', pos, properties: {}, worldId: 'w', sessionId: 's', dimension: 'overworld',
        observationId: 1, observedAt: Date.now(), source: 'vision' as const,
      })),
    },
    signal: new AbortController().signal,
  };
  const r = await findItem.run(c as any, { item: 'diamond' });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /附近有未打开的容器/);
  assert.ok(r.summary.includes('target {"x":2,"y":64,"z":0}'), r.summary);
});

test('find_item 背包也计入总计，没有时给空', async (t) => {
  const m = new WorldMemory(null);
  t.after(() => m.close());
  m.setWorld('w');
  m.setChest('overworld', { x: 5, y: 64, z: 0 }, [{ name: 'coal', count: 3 }]);
  const withPack = await findItem.run(ctx(m, [{ name: 'coal', count: 7 }]) as any, { item: 'coal' });
  assert.equal((withPack.data as any).backpack, 7);
  assert.equal((withPack.data as any).total, 10);
  const missing = await findItem.run(ctx(m) as any, { item: 'diamond' });
  assert.equal((missing.data as any).total, 0);
  assert.equal((missing.data as any).chest, null);
});
