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

test('离两段旧矿道都远时，选接得上的那团地表入口，而不是更高但接不上的', async () => {
  const adapter = new TestWorld();
  // 站在离两段旧矿道都超过 6 格的地方。psg_b 的入口高 1 格，但两团互不相连；
  // 锚点应按沿记录网的可达代价选，不能只按 y 高选一个根本走不到的入口。
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 两段之间最近的节点是 (2,64,0) 与 (6,64,0)，实际缺口 4 格；> PASSAGE_LINK(3.5)，不会被碎片自愈连上。
  memory.savePassage(rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }));
  memory.savePassage(rec(adapter, 'psg_b', [{ x: 6, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }], { x: 8, y: 65, z: 0 }));

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.resolvedTarget, { x: 2, y: 64, z: 0 }, '选接得上的 psg_a 入口，而不是 y 更高的 psg_b');
});

test('没有入口记录、两团又不相连时，报实际跨分量断口', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 两条都没有入口记录，退回“该分量最高的脚点”；psg_b 更高，但和最近的 psg_a 断开 8 格。
  memory.savePassage({ ...rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }), entrances: [] });
  memory.savePassage({ ...rec(adapter, 'psg_b', [{ x: 10, y: 66, z: 0 }, { x: 12, y: 66, z: 0 }], { x: 12, y: 66, z: 0 }), entrances: [] });

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  // 报的是实际断口和它的宽度，不是“从你脚下直线约 N 格”。
  assert.match(result.summary, /通道在 \(2,64,0\) 和 \(10,66,0\) 之间断开，相距 8 格（水平 8、垂直 2）/);
  assert.doesNotMatch(result.summary, /从你脚下/);
  const gap = result.data?.connectionGap as { from: Vec3Like; to: Vec3Like; distance: number; horizontal: number; vertical: number };
  assert.deepEqual(gap.from, { x: 2, y: 64, z: 0 });
  assert.deepEqual(gap.to, { x: 10, y: 66, z: 0 });
  assert.equal(gap.vertical, 2);
});

test('断口在 near 范围内时，走到最近的可达脚点并如实报告还差几格', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.savePassage({ ...rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }), entrances: [] });
  memory.savePassage({ ...rec(adapter, 'psg_b', [{ x: 6, y: 66, z: 0 }, { x: 8, y: 66, z: 0 }], { x: 8, y: 66, z: 0 }), entrances: [] });

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.match(result.summary, /离入口参考点约 4 格/);
  const arrival = result.data?.arrival as { satisfied: boolean };
  assert.equal(arrival.satisfied, false, '没到 ≤2 格不能报 arrived');
  assert.equal(result.data?.connectionGap, undefined, '断口在 near 内时走最近的脚点，不算确定断口');
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
