import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { WorldMemory, type PassageRecord } from '../src/memory/store.ts';
import { followPassage } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const rec = (adapter: TestWorld, id: string, path: Vec3Like[], entrance: Vec3Like): PassageRecord => ({
  id, worldId: adapter.worldId, dim: 'overworld', kind: 'dug', entrances: [entrance], path,
  deepestY: Math.min(...path.map((p) => p.y)), dug: 8, ores: {}, createdAt: 1, lastUsedAt: 1, uses: 1,
});

test('follow_passage 报告实际跨分量断口，而不是 agent 到最近脚点的距离', async () => {
  const adapter = new TestWorld();
  // 站在离两段旧矿道都超过 6 格的地方：锚点先按全网选，接回最近脚点后才暴露两团不连通。
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 两段之间最近的节点是 (2,64,0) 与 (6,64,0)，实际缺口 4 格；> PASSAGE_LINK(3.5)，不会被碎片自愈连上。
  memory.savePassage(rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }));
  memory.savePassage(rec(adapter, 'psg_b', [{ x: 6, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }], { x: 8, y: 65, z: 0 }));

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  // 报的是实际断口和它的宽度，不是“从你脚下直线约 N 格”。
  assert.match(result.summary, /通道在 \(2,64,0\) 和 \(6,64,0\) 之间断开，相距 4 格/);
  assert.doesNotMatch(result.summary, /从你脚下/);
  const gap = result.data?.connectionGap as { from: Vec3Like; to: Vec3Like; distance: number; horizontal: number; vertical: number };
  assert.deepEqual(gap.from, { x: 2, y: 64, z: 0 });
  assert.deepEqual(gap.to, { x: 6, y: 64, z: 0 });
  assert.equal(gap.distance, 4);
  assert.equal(gap.horizontal, 4);
  assert.equal(gap.vertical, 0);
});

test('同一条通道的锚点离脚点太远时，不伪造跨分量 connectionGap', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 一条连通通道；入口记在 50 格外，路线够不到锚点，但不是两团通道断开。
  memory.savePassage(rec(adapter, 'psg_one', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }], { x: 50, y: 64, z: 0 }));

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(result.data?.connectionGap, undefined, '同分量/无跨分量节点对时不应伪造断口');
  assert.doesNotMatch(result.summary, /通道在/);
  assert.match(result.summary, /锚点本身接不上一条可走的路/);
});
