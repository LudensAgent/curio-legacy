import assert from 'node:assert/strict';
import { test } from 'node:test';
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
