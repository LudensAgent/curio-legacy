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

test('没有入口记录时，不把另一团更高的不可达点当目标', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 两条都没有入口记录，退回“能走到的该分量最高脚点”；psg_b 更高，但和最近的 psg_a 断开 8 格。
  memory.savePassage({ ...rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }), entrances: [] });
  memory.savePassage({ ...rec(adapter, 'psg_b', [{ x: 10, y: 66, z: 0 }, { x: 12, y: 66, z: 0 }], { x: 12, y: 66, z: 0 }), entrances: [] });

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  // 走到可达的最高脚点就算到达；不能拿 y 更高的不可达团当目标。
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.resolvedTarget, { x: 0, y: 64, z: 0 });
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, true);
  assert.equal(result.data?.connectionGap, undefined, '没有把另一团当成已选目标，就不伪造 connectionGap');
});

test('没有可用入口时到达可达脚点，不伪造跨分量断口', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.savePassage({ ...rec(adapter, 'psg_a', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], { x: 2, y: 64, z: 0 }), entrances: [] });
  memory.savePassage({ ...rec(adapter, 'psg_b', [{ x: 6, y: 66, z: 0 }, { x: 8, y: 66, z: 0 }], { x: 8, y: 66, z: 0 }), entrances: [] });

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, true);
  assert.equal(result.data?.connectionGap, undefined, '没有把另一团当成已选目标，就不伪造 connectionGap');
});

test('dig:true 时先尝试接上小断口，再接回记录路线', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 一条记录被 4 格竖直断口分成两团：A (0,40)/(2,40)，B (0,44)/(0,48)，入口在 B 顶。
  memory.savePassage({
    id: 'gap-mine', worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
    entrances: [{ x: 0, y: 48, z: 0 }], deepestY: 48, dug: 20, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }, { x: 2, y: 40, z: 0 }, { x: 0, y: 44, z: 0 }, { x: 0, y: 48, z: 0 }],
    links: [{ a: { x: 0, y: 40, z: 0 }, b: { x: 2, y: 40, z: 0 } }, { a: { x: 0, y: 44, z: 0 }, b: { x: 0, y: 48, z: 0 } }],
  });
  const ctx = makeCtx(adapter, { memory });
  t.after(() => memory.close());
  const crossing: { goal: { pos: Vec3Like }; opts: { allowPlace?: boolean } }[] = [];
  t.mock.method(adapter, 'moveTo', async (goal: any, opts: any) => {
    if (goal.kind !== 'near') return;
    if (opts?.allowPlace === true && goal.pos.y === 44) crossing.push({ goal, opts });
    adapter.pos = { ...goal.pos };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance', dig: true });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(crossing.length, 1, '带 dig:true 时尝试跨断口');
  assert.deepEqual(crossing[0]!.goal.pos, { x: 0, y: 44, z: 0 }, '跨到断口远端');
  assert.equal(result.data?.connectionGap, undefined, '接上后不再报断口');
});

test('没有 dig 授权时到达可达脚点，并把记录入口未接上的事实交回', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.savePassage({
    id: 'gap-mine', worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
    entrances: [{ x: 0, y: 48, z: 0 }], deepestY: 48, dug: 20, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }, { x: 2, y: 40, z: 0 }, { x: 0, y: 44, z: 0 }, { x: 0, y: 48, z: 0 }],
    links: [{ a: { x: 0, y: 40, z: 0 }, b: { x: 2, y: 40, z: 0 } }, { a: { x: 0, y: 44, z: 0 }, b: { x: 0, y: 48, z: 0 } }],
  });
  const ctx = makeCtx(adapter, { memory });
  t.after(() => memory.close());
  t.mock.method(adapter, 'moveTo', async (goal: any) => { if (goal.kind === 'near') adapter.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  // 没有 dig 授权时只到有向可达的脚点，但记录入口和“还没接上”的事实仍要交回。
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, true);
  assert.match(result.summary, /记录的入口 \(0,48,0\).*还没接上/);
  assert.match(result.summary, /加 dig:true/);
  assert.equal(result.data?.connectionGap, undefined);
});

test('同一条通道的锚点离脚点太远时，到达可达脚点且不伪造跨分量 connectionGap', async () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 10.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  // 一条连通通道；入口记在 50 格外，路线够不到锚点，但不是两团通道断开。
  memory.savePassage(rec(adapter, 'psg_one', [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }], { x: 50, y: 64, z: 0 }));

  const ctx = makeCtx(adapter, { memory });
  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.connectionGap, undefined, '同分量/无跨分量节点对时不应伪造断口');
  assert.doesNotMatch(result.summary, /通道在/);
  assert.match(result.summary, /记录的入口 \(50,64,0\).*还没接上/);
});
