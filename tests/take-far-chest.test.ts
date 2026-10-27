import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeItems } from '../src/skills/economy.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('take_items：远处（或别的维度）的箱子不去开，记录不删，告诉它在哪', async (t) => {
  const w = new FakeAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const dim = w.state().dim;
  ctx.memory.setChest(dim, { x: 1100, y: 63, z: -11 }, [{ name: 'obsidian', count: 2 }]);
  ctx.memory.setChest('the_nether', { x: 5, y: 70, z: 5 }, [{ name: 'obsidian', count: 1 }]);
  const r = await takeItems.run(ctx, { item: 'obsidian', count: 4 });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /\(1100,63,-11\) \d+ 格外的箱子里记得有 obsidian×2/);
  assert.match(r.summary, /the_nether/);
  assert.equal(ctx.memory.chests().length, 2, '记录都还在');
});
