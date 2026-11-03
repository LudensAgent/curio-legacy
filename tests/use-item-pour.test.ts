import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectEvidence } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

// 默认地面 y=63 是 grass_block；目标空气格 (0,64,2) 正下方就是实心方块，倒水能贴面。
test('use_item 满水桶倒进坐标空气格：目标变成 water、水桶转空桶', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('water_bucket', 1);
  const r = await useItem.run(ctx, { item: 'water_bucket', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 2 }), 'water');
  assert.equal(w.inv.get('water_bucket'), 0);
  assert.equal(w.inv.get('bucket'), 1);
});

test('use_item 也收 "x,y,z" 字符串坐标倒水', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('water_bucket', 1);
  const v = useItem.validate({ item: 'water_bucket', on: '0,64,2' }, w);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const r = await useItem.run(ctx, v.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 2 }), 'water');
  assert.equal(w.inv.get('water_bucket'), 0);
  assert.equal(w.inv.get('bucket'), 1);
});

test('use_item 满桶坐标倒水只认空气格：目标被占就报失败，不倒', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('water_bucket', 1);
  w.setBlock({ x: 0, y: 64, z: 2 }, 'stone');
  const r = await useItem.run(ctx, { item: 'water_bucket', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(w.inv.get('water_bucket'), 1, '没倒成不该扣水桶');
});

test('use_item 满桶倒进没有实心面可贴的空气格：NO_REFERENCE 不扣桶', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('water_bucket', 1);
  // (0,66,2)：正下方 (0,65,2) 是空气，四周都是空气，没有可贴面
  const r = await useItem.run(ctx, { item: 'water_bucket', on: { x: 0, y: 66, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.equal(w.inv.get('water_bucket'), 1, '没贴面不该扣水桶');
});

test('use_item 坐标只对桶/点火物品生效：其他物品报 BAD_ARGS', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('cobblestone', 1);
  const r = await useItem.run(ctx, { item: 'cobblestone', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
});

test('use_item 空桶对坐标流体源收集：bucket→water_bucket、源格变空气', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('bucket', 1);
  w.setBlock({ x: 0, y: 64, z: 2 }, 'water');
  w.blockProperties.set('0,64,2', { level: 0 });
  const r = await useItem.run(ctx, { item: 'bucket', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 2 }), 'air');
  assert.equal(w.inv.get('bucket'), 0);
  assert.equal(w.inv.get('water_bucket'), 1);
});

test('use_item 空桶对流动水收集：报 BAD_ARGS，不装', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('bucket', 1);
  w.setBlock({ x: 0, y: 64, z: 2 }, 'water');
  w.blockProperties.set('0,64,2', { level: 0 });
  w.blockProperties.set('0,64,2', { level: 1 });
  const r = await useItem.run(ctx, { item: 'bucket', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.equal(w.inv.get('bucket'), 1);
  assert.equal(w.inv.get('water_bucket') ?? 0, 0);
});

test('use_item 空桶坐标不泄漏看不见的方块名', async (t) => {
  const w = new TestWorld();
  // 原始区块里确实有 diamond_block，但当前没有任何可见证据
  w.blocks.push({ name: 'diamond_block', pos: { x: 10, y: 64, z: 10 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  w.inv.set('bucket', 1);
  const r = await useItem.run(ctx, { item: 'bucket', on: { x: 10, y: 64, z: 10 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.doesNotMatch(r.summary, /diamond/);
});

test('use_item 空桶收集无限水源：源格被邻近源重新填回也算成功', async (t) => {
  const w = new TestWorld();
  w.inv.set('bucket', 1);
  w.setBlock({ x: 0, y: 64, z: 2 }, 'water');
  w.blockProperties.set('0,64,2', { level: 0 });
  // 模拟无限水源：取走后源格仍被填回 water，但 bucket→water_bucket 已发生
  w.useItemOn = async (item: string, target: { kind: string; pos?: { x: number; y: number; z: number } }) => {
    if (item === 'bucket' && target.kind === 'block' && target.pos) {
      w.inv.set('bucket', (w.inv.get('bucket') ?? 0) - 1);
      w.inv.set('water_bucket', (w.inv.get('water_bucket') ?? 0) + 1);
      // 源格保持 water（无限水源）
      return { ok: true, effectEvidence: { verified: true, changed: true, reasons: ['背包 bucket 减少 1、water_bucket 增加 1'] } };
    }
    return { ok: true };
  };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await useItem.run(ctx, { item: 'bucket', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.inv.get('water_bucket'), 1);
  assert.match(r.summary, /bucket→water_bucket/);
});

test('use_item on:"self" 沿准星使用：满桶不冒充定点倒水成功，落点未确认', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('water_bucket', 1);
  const r = await useItem.run(ctx, { item: 'water_bucket', on: 'self' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /未确认/);
  assert.match(r.summary, /没有自动低头/);
});

test('use_item on:"self" 对不消耗物品的工具（鱼竿）不算失败', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('fishing_rod', 1);
  const r = await useItem.run(ctx, { item: 'fishing_rod', on: 'self' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.failureCode, undefined);
});


test('coordinate collection rejects stale, cross-session and out-of-range observations before using the bucket', async (t) => {
  for (const mode of ['old', 'world', 'session', 'dimension', 'not-ready', 'far', 'unknown-level']) {
    const w = new TestWorld();
    const pos = { x: mode === 'far' ? 10 : 0, y: 64, z: 2 };
    w.inv.set('bucket', 1);
    let uses = 0;
    w.useItemOn = async () => { uses++; return { ok: true }; };
    if (mode === 'not-ready') w.observationReady = false;
    const properties: Record<string, number> = mode === 'unknown-level' ? {} : { level: 0 };
    const ctx = makeCtx(w, { senses: { observeBlocks: () => [{
      name: 'water', pos, properties, source: 'vision',
      worldId: mode === 'world' ? 'other-world' : w.worldId,
      sessionId: mode === 'session' ? 'old-session' : w.sessionId,
      dimension: mode === 'dimension' ? 'the_nether' : w.dim,
      observationId: 1, observedAt: Date.now() - (mode === 'old' ? 5000 : 0),
    }] } });
    t.after(() => ctx.memory.close());
    const r = await useItem.run(ctx, { item: 'bucket', on: pos });
    assert.equal(r.status, 'failed', mode);
    assert.equal(uses, 0, mode);
    assert.equal(w.inv.get('bucket'), 1, mode);
  }
});

test('collection reports only current observations after use, without reading a newly hidden cell', async (t) => {
  const w = new TestWorld(), pos = { x: 0, y: 64, z: 2 };
  w.inv.set('bucket', 1);
  let used = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: () => used ? [] : [{
    name: 'water', pos, properties: { level: 0 }, source: 'vision',
    worldId: w.worldId, sessionId: w.sessionId, dimension: w.dim, observationId: 1, observedAt: Date.now(),
  }] } });
  t.after(() => ctx.memory.close());
  w.blockAt = () => { throw new Error('must not read raw world cells'); };
  w.useItemOn = async () => {
    used = true;
    w.inv.set('bucket', 0); w.inv.set('water_bucket', 1);
    return { ok: true };
  };
  const r = await useItem.run(ctx, { item: 'bucket', on: pos });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.actual, null);
  assert.match(r.summary, /后续状态未知/);
});

test('collection requires both sides of the expected container conversion and preserves partial changes', async (t) => {
  for (const mode of ['spent-only', 'filled-only', 'wrong-fluid', 'water-refilled', 'water-flowing', 'lava']) {
    const w = new TestWorld(), pos = { x: 0, y: 64, z: 2 };
    const fluid = mode === 'lava' ? 'lava' : 'water';
    w.inv.set('bucket', 1);
    w.setBlock(pos, fluid); w.blockProperties.set('0,64,2', { level: 0 });
    w.useItemOn = async () => {
      if (mode !== 'filled-only') w.inv.set('bucket', 0);
      if (mode !== 'spent-only') w.inv.set(mode === 'wrong-fluid' ? 'lava_bucket' : `${fluid}_bucket`, 1);
      if (mode === 'water-flowing') w.blockProperties.set('0,64,2', { level: 3 });
      return { ok: true };
    };
    const ctx = makeCtx(w);
    t.after(() => ctx.memory.close());
    const r = await useItem.run(ctx, { item: 'bucket', on: pos });
    const succeeds = ['water-refilled', 'water-flowing', 'lava'].includes(mode);
    assert.equal(r.status, succeeds ? 'succeeded' : 'failed', `${mode}: ${r.summary}`);
    assert.equal((r.data?.effectEvidence as EffectEvidence | undefined)?.changed, true, `${mode}: partial changes must not be erased`);
    if (!succeeds) assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    if (succeeds) assert.equal(r.data?.collected, `${fluid}_bucket`);
  }
});

test('collection interrupted by cancellation or a session change cannot report success', async (t) => {
  for (const mode of ['cancel', 'session']) {
    const w = new TestWorld(), pos = { x: 0, y: 64, z: 2 };
    w.inv.set('bucket', 1); w.setBlock(pos, 'water'); w.blockProperties.set('0,64,2', { level: 0 });
    const ctx = makeCtx(w), controller = new AbortController();
    ctx.signal = controller.signal;
    t.after(() => ctx.memory.close());
    w.useItemOn = async () => {
      w.inv.set('bucket', 0); w.inv.set('water_bucket', 1);
      if (mode === 'cancel') controller.abort();
      else w.sessionId = 'new-session';
      return { ok: true };
    };
    await assert.rejects(useItem.run(ctx, { item: 'bucket', on: pos }), { name: 'AbortedError' });
  }
});

test('self distinguishes completed input from unknown effect for consumable and reusable items', async (t) => {
  for (const item of ['water_bucket', 'fishing_rod']) {
    const w = new TestWorld(); w.inv.set(item, 1);
    w.useItemOn = async () => ({ ok: true, effectEvidence: { verified: false, changed: false, reasons: ['输入完成，效果未知'] } });
    const ctx = makeCtx(w); t.after(() => ctx.memory.close());
    const r = await useItem.run(ctx, { item, on: 'self' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.inputCompleted, true);
    assert.equal((r.data?.effectEvidence as EffectEvidence | undefined)?.verified, false);
    assert.equal((r.data?.effectEvidence as EffectEvidence | undefined)?.changed, false);
    assert.equal(r.data?.poured_unconfirmed, undefined);
  }
});

test('use_item 空桶名称取源：侧面可接触、顶部被遮挡的源仍可收集', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('bucket', 1);
  // 源 (0,64,2) 上方 (0,65,2) 是石头，顶被遮挡；但侧面可接触
  w.setBlock({ x: 0, y: 64, z: 2 }, 'water');
  w.blockProperties.set('0,64,2', { level: 0 });
  w.setBlock({ x: 0, y: 65, z: 2 }, 'stone');
  const r = await useItem.run(ctx, { item: 'bucket', on: 'water' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.inv.get('bucket'), 0);
  assert.equal(w.inv.get('water_bucket'), 1);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 2 }), 'air');
});

test('use_item 放船仍要求开阔水面：顶部被遮挡的水格不选为放船点', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('oak_boat', 1);
  // 顶部被遮挡的水格：放船需要上面是空气的开阔水面，不应选中
  w.setBlock({ x: 0, y: 64, z: 2 }, 'water');
  w.blockProperties.set('0,64,2', { level: 0 });
  w.setBlock({ x: 0, y: 65, z: 2 }, 'stone');
  const r = await useItem.run(ctx, { item: 'oak_boat', on: 'water' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(w.inv.get('oak_boat'), 1, '没放成不该扣船');
});
