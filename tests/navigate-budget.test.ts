import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultBudgetFor, navigateTo } from '../src/skills/movement/navigate.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

test('近目标的默认搜索节点/边预算更小，长途保持库默认上限', () => {
  const at = { x: 0, y: 64, z: 0 };
  const near = defaultBudgetFor(at, { x: 3, y: 64, z: 0 });
  const edge = defaultBudgetFor(at, { x: 24, y: 64, z: 0 });
  const far = defaultBudgetFor(at, { x: 100, y: 64, z: 0 });
  assert.ok(near.maxNodes < 2048 && near.maxEdges < 16384, JSON.stringify(near));
  assert.ok(edge.maxNodes <= 1024 && edge.maxEdges <= 4096, JSON.stringify(edge));
  assert.equal(far.maxNodes, 4096);
  assert.equal(far.maxEdges, 32768);
});

test('搜索预算耗尽且本地有未知边界时先观察，再按 UNKNOWN_BOUNDARY 交回', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(0);
  t.after(() => ctx.memory.close());
  let observed = 0;
  ctx.senses.observeBlocks = () => { observed += 1; return []; };
  const validated = navigateTo.validate({
    to: { x: 5, y: 64, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: false, maxNodes: 2, maxEdges: 8,
  }, adapter);
  assert.ok(validated.ok);
  const result = await navigateTo.run({ ...ctx, deadline: Date.now() + 30_000 }, validated.args);
  assert.ok(observed > 0, '预算耗尽后应先观察本地未知边界');
  assert.equal((result.data?.stop as { reason?: string } | undefined)?.reason, 'UNKNOWN_BOUNDARY');
  assert.equal(result.data?.searchStatus, 'BUDGET_EXHAUSTED', '预算耗尽的事实仍保留在回执里');
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 }, '没有可走路线时不移动');
});
