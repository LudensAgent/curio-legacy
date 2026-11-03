import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const runSkill = async (adapter: FakeAdapter, skill: string, args: unknown, memory = new WorldMemory(null)) => {
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, new EventBus(), vision);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill, args }, 'llm');
  return { o: await done, memory, vision };
};

// 默认地面 y=63 是 grass_block；目标空气格 (0,64,2) 正下方就是实心方块，倒水能贴面。
test('use_item 满水桶倒进坐标空气格：目标变成 water、水桶转空桶', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: { x: 0, y: 64, z: 2 } }, memory);
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(a.blockAt({ x: 0, y: 64, z: 2 }), 'water');
  assert.equal(a.inv.get('water_bucket'), 0, '水桶应被消耗');
  assert.equal(a.inv.get('bucket'), 1, '满桶应转成空桶');
});

test('use_item 也收 "x,y,z" 字符串坐标倒水', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: '0,64,2' }, memory);
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(a.blockAt({ x: 0, y: 64, z: 2 }), 'water');
  assert.equal(a.inv.get('water_bucket'), 0);
  assert.equal(a.inv.get('bucket'), 1);
});

test('use_item 满桶坐标倒水只认空气格：目标被占就报失败，不倒', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  a.blocks.push({ name: 'stone', pos: { x: 0, y: 64, z: 2 } });
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: { x: 0, y: 64, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(a.inv.get('water_bucket'), 1, '没倒成不该扣水桶');
});

test('use_item 满桶倒进没有实心面可贴的空气格：NO_REFERENCE 不扣桶', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  // (0,66,2)：正下方 (0,65,2) 是空气，四周都是空气，没有可贴面
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: { x: 0, y: 66, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(a.inv.get('water_bucket'), 1, '没贴面不该扣水桶');
});

test('use_item 坐标只对桶/点火物品生效：其他物品报 BAD_ARGS', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('cobblestone', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'cobblestone', on: { x: 0, y: 64, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'BAD_ARGS');
});

test('use_item 空桶对坐标流体源收集：bucket→water_bucket、源格变空气', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('bucket', 1);
  a.blocks.push({ name: 'water', pos: { x: 0, y: 64, z: 2 } });
  const { o } = await runSkill(a, 'use_item', { item: 'bucket', on: { x: 0, y: 64, z: 2 } }, memory);
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(a.blockAt({ x: 0, y: 64, z: 2 }), 'air');
  assert.equal(a.inv.get('bucket'), 0);
  assert.equal(a.inv.get('water_bucket'), 1);
});

test('use_item 空桶对流动水收集：报 BAD_ARGS，不装', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('bucket', 1);
  a.blocks.push({ name: 'water', pos: { x: 0, y: 64, z: 2 } });
  a.blockProperties.set('0,64,2', { level: 1 });
  const { o } = await runSkill(a, 'use_item', { item: 'bucket', on: { x: 0, y: 64, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'BAD_ARGS');
  assert.equal(a.inv.get('bucket'), 1);
  assert.equal(a.inv.get('water_bucket') ?? 0, 0);
});

test('use_item on:"self" 沿准星使用：没观察到变化就报未确认，不冒充成功', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: 'self' }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(o.result.summary, /未确认/);
});
