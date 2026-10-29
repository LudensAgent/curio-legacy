import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeItems } from '../src/skills/economy.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('take_items：远处（或别的维度）的箱子不去开，记录不删，告诉它在哪', async (t) => {
  const w = new FakeAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(w.state().worldId);
  const dim = w.state().dim;
  ctx.memory.setChest(dim, { x: 1100, y: 63, z: -11 }, [{ name: 'obsidian', count: 2 }]);
  ctx.memory.setChest('the_nether', { x: 5, y: 70, z: 5 }, [{ name: 'obsidian', count: 1 }]);
  const r = await takeItems.run(ctx, { item: 'obsidian', count: 4 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS', '未指定箱子就只列线索');
  const hints = r.data?.hints as { dimension: string; text: string }[];
  assert.deepEqual(new Set(hints.map((hint) => hint.dimension)), new Set([dim, 'the_nether']));
  assert.ok(hints.every((hint) => /obsidian×\d/.test(hint.text)), '精确数量和位置');
  assert.doesNotMatch(JSON.stringify(hints), /"target"/, '远箱子不暴露精确 target');
  assert.match(r.summary, /未自动搜索/);
  assert.deepEqual(w.actions, []);
  assert.equal(w.inv.get('obsidian') ?? 0, 0);
  assert.equal(ctx.memory.chests().length, 2, '记录都还在');
});
