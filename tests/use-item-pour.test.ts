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

test('use_item 把水桶倒进 on 指定的空气格', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  // 空气格 (0,65,2)：默认地面之上，是 air
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: { x: 0, y: 65, z: 2 } }, memory);
  assert.equal(o.result.status, 'succeeded');
  assert.equal(a.blockAt({ x: 0, y: 65, z: 2 }), 'water_bucket');
  assert.equal(a.inv.get('water_bucket'), 0);
});

test('use_item 也收 "x,y,z" 字符串坐标倒水', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: '0,65,2' }, memory);
  assert.equal(o.result.status, 'succeeded');
  assert.equal(a.blockAt({ x: 0, y: 65, z: 2 }), 'water_bucket');
});

test('use_item 倒水只认空气格：目标被占就报失败，不倒', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('water_bucket', 1);
  a.blocks.push({ name: 'stone', pos: { x: 0, y: 65, z: 2 } });
  const { o } = await runSkill(a, 'use_item', { item: 'water_bucket', on: { x: 0, y: 65, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(a.inv.get('water_bucket'), 1, '没倒成不该扣水桶');
});

test('use_item 坐标只对水桶/岩浆桶生效：其他物品报 BAD_ARGS', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  a.inv.set('cobblestone', 1);
  const { o } = await runSkill(a, 'use_item', { item: 'cobblestone', on: { x: 0, y: 65, z: 2 } }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'BAD_ARGS');
});
