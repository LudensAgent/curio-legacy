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

test('箱子顶上压着石头：take_items 报告选定箱子打不开，不擅自挖盖', async (t) => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  t.after(() => m.close()); m.setWorld(a.state().worldId);
  const pos = { x: 2, y: 64, z: 0 };
  chestAt(a, m, pos, { iron_ingot: 5 });
  a.blocks.push({ name: 'stone', pos: { x: 2, y: 65, z: 0 } });
  const r = await runSkill(a, 'take_items', { item: 'iron_ingot', count: 3, target: pos }, m);
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(a.inv.get('iron_ingot') ?? 0, 0);
  assert.equal(a.blockAt(pos), 'chest', '箱子没被挖');
  assert.equal(a.blockAt({ ...pos, y: 65 }), 'stone', '没有授权拆盖子');
  assert.match(r.summary, /LID_BLOCKED:stone/);
  assert.ok(!a.actions.some((action) => action.startsWith('dig:')));
});

test('选定箱子已经没了：亲眼确认后删记录，但不换下一个箱子', async (t) => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  t.after(() => m.close()); m.setWorld(a.state().worldId);
  const missing = { x: 1, y: 64, z: 1 };
  m.setChest('overworld', missing, [{ name: 'coal', count: 9 }]); // 那里其实没有箱子了
  chestAt(a, m, { x: 4, y: 64, z: 0 }, { coal: 6 });
  const r = await runSkill(a, 'take_items', { item: 'coal', count: 4, target: missing }, m);
  assert.equal(r.failureCode, 'TARGET_GONE', r.summary);
  assert.equal(a.inv.get('coal') ?? 0, 0, '另一个箱子没被自动翻找');
  assert.equal(m.chests().length, 1, '没了的箱子记录删掉');
  assert.equal(a.chests.get('4,64,0')?.get('coal'), 6);
  assert.match(r.summary, /未改选其他容器/);
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

test('take_items 不带 target：把记得的箱子坐标和数量写进失败说明，不吞掉线索', async (t) => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  t.after(() => m.close()); m.setWorld(a.state().worldId);
  m.setChest('overworld', { x: 7, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 5 }]);
  const r = await runSkill(a, 'take_items', { item: 'iron_ingot' }, m);
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /iron_ingot×5/, '把物品和数量写进失败说明');
  assert.match(r.summary, /7,64,0/, '把箱子坐标写进失败说明');
});

test('store_items 不带 target：把记得的容器坐标写进失败说明', async (t) => {
  const a = new FakeAdapter(), m = new WorldMemory(null);
  t.after(() => m.close()); m.setWorld(a.state().worldId);
  chestAt(a, m, { x: 7, y: 64, z: 0 }, { cobblestone: 10 });
  const r = await runSkill(a, 'store_items', { items: ['cobblestone'] }, m);
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /7,64,0/, '把容器坐标写进失败说明');
});
