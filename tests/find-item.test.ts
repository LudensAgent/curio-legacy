import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findItem } from '../src/skills/economy.ts';
import { WorldMemory } from '../src/memory/store.ts';

const ctx = (m: WorldMemory, inventory: { name: string; count: number }[] = []) => ({
  adapter: { state: () => ({ inventory, pos: { x: 0.5, y: 64, z: 0.5 }, dim: 'overworld' }) },
  memory: m,
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
  assert.equal(d.inChests, 109);
  assert.equal(d.total, 109);
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
