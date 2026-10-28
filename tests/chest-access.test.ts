import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from './fake-adapter.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { Vision } from '../src/perception/vision.ts';
import { storedChestAt } from '../src/skills/build.ts';

const runSkill = async (adapter: FakeAdapter, skill: string, args: unknown, memory: WorldMemory) => {
  const arbiter = new Arbiter(adapter, memory, new EventBus(), new Vision(adapter));
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill, args }, 'llm');
  return (await done).result;
};
const chestAt = (a: FakeAdapter, m: WorldMemory, pos: { x: number; y: number; z: number }, items: Record<string, number>) => {
  a.blocks.push({ name: 'chest', pos });
  a.chests.set(`${pos.x},${pos.y},${pos.z}`, new Map(Object.entries(items)));
  m.setChest('overworld', pos, Object.entries(items).map(([name, count]) => ({ name, count })));
};

test('箱子顶上压着石头：take_items 先挖掉盖子上的方块再取，箱子还在', async () => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  const pos = { x: 2, y: 64, z: 0 };
  chestAt(a, m, pos, { iron_ingot: 5 });
  a.blocks.push({ name: 'stone', pos: { x: 2, y: 65, z: 0 } });
  const r = await runSkill(a, 'take_items', { item: 'iron_ingot', count: 3 }, m);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(a.inv.get('iron_ingot'), 3);
  assert.equal(a.blockAt(pos), 'chest', '箱子没被挖');
  assert.match(r.summary, /挖掉了压在箱子顶上的 stone/);
});

test('记得的箱子已经没了：删掉记录，换下一个记得的箱子', async () => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  m.setChest('overworld', { x: 1, y: 64, z: 1 }, [{ name: 'coal', count: 9 }]); // 那里其实没有箱子了
  chestAt(a, m, { x: 4, y: 64, z: 0 }, { coal: 6 });
  const r = await runSkill(a, 'take_items', { item: 'coal', count: 4 }, m);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(a.inv.get('coal'), 4);
  assert.equal(m.chests().length, 1, '没了的箱子记录删掉');
});

test('存着东西的箱子：dig 不拆，告诉它怎么取', async () => {
  const m = new WorldMemory(null);
  m.setChest('overworld', { x: 3, y: 64, z: 3 }, [{ name: 'iron_ingot', count: 8 }]);
  assert.match(storedChestAt(m, { dim: 'overworld' }, { x: 3, y: 64, z: 3 }, 'chest') ?? '', /存着 iron_ingot 的箱子[\s\S]*take_items/);
  assert.equal(storedChestAt(m, { dim: 'overworld' }, { x: 3, y: 64, z: 3 }, 'stone'), null);
  assert.equal(storedChestAt(m, { dim: 'overworld' }, { x: 9, y: 64, z: 9 }, 'chest'), null, '不记得的箱子不拦');
  const a = new FakeAdapter();
  a.blocks.push({ name: 'chest', pos: { x: 3, y: 64, z: 3 } });
  const r = await runSkill(a, 'dig', { target: '3,64,3' }, m);
  assert.match(r.summary, /存着 iron_ingot 的箱子，没拆/);
  assert.equal(a.blockAt({ x: 3, y: 64, z: 3 }), 'chest');
});
