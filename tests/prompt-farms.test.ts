import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages, deliberateSystem, glanceSystem, situationalReminders, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const harness = () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  adapter.worldId = 'default';
  const close = () => { memory.close(); self.close(); };
  for (const x of [1, 4, 7, 10, 30]) {
    adapter.blocks.push({ name: 'crafting_table', pos: { x, y: 64, z: 0 } });
    memory.addLandmark('discovery', '我的工作台', 'overworld', { x, y: 64, z: 0 }, 1);
  }
  memory.addFarm({ id: 'farm_1', dim: 'overworld', crop: 'wheat', cells: [{ x: 12, y: 63, z: 0 }], plantedAt: Date.now() - 180_000, harvests: 3 });
  memory.addLandmark('discovery', '我的农田', 'overworld', { x: 12, y: 63, z: 0 }, 1);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = { ...perception.update(), farms: [
    { crop: 'wheat', cells: 1, dist: 12, mature: null, minutes_since_planted: 180 },
    { crop: 'carrot', cells: 4, dist: 60, mature: null, minutes_since_planted: 300 },
  ] };
  const context = (tier: 'glance' | 'deliberate', farms = percept.farms): MindContext => ({
    tier, reason: '测试', percept: { ...percept, farms }, state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P',
  });
  return { context, memory, close };
};

test('持续运营只进入认真想：区分 Task/Project/Ongoing Operation，成熟以观察为准', () => {
  const deliberate = deliberateSystem('P', []);
  for (const marker of ['【持续运营】', 'Ongoing Operation', '不按现实时间推断成熟', 'farm 动作只管开垦/收割/补种']) {
    assert.ok(deliberate.includes(marker), `缺少持续运营「${marker}」`);
  }
  assert.ok(!glanceSystem('P', []).includes('【持续运营】'), '瞥一眼不加载持续运营段');
});

test('农田状态进入认真想的 user 消息；未知成熟度不伪装成 0，也不重复列农田地标', (t) => {
  const { context, close } = harness();
  t.after(close);
  const [, user] = buildMindMessages(context('deliberate'));
  assert.match(user.content, /my_farms/);
  assert.match(user.content, /"mature":null/);
  assert.match(user.content, /成熟以观察为准/);
  assert.match(user.content, /minutes_since_planted/);
  assert.match(user.content, /"harvests":3/);
  assert.match(user.content, /"at":\{"x":12/);
  assert.doesNotMatch(user.content, /"mature":0/);
  assert.doesNotMatch(user.content, /我的农田/, '农田状态只走 my_farms，不在 my_facilities 重复');
  assert.match(user.content, /my_facilities/);
  assert.match(user.content, /use_gui\/interact_block/);
  assert.match(user.content, /容器先 find_item 查线索/);
  assert.match(user.content, /床也会列在这里/);
  assert.doesNotMatch(situationalReminders(context('deliberate')).join(' '), /农田|成熟/, '普通农田状态不进入每念提醒');

  const [, known] = buildMindMessages(context('deliberate', [{ crop: 'wheat', cells: 1, dist: 12, mature: 0, minutes_since_planted: 10 }]));
  assert.match(known.content, /"mature":0/, '实际观察到的 0 成熟数照实显示');
});

test('自己的床和邻近箱子一起进入设施表，带坐标和记录时间', (t) => {
  const { context, memory, close } = harness();
  t.after(close);
  memory.addLandmark('discovery', '我的床', 'overworld', { x: 70, y: 64, z: 0 }, 2);
  memory.addLandmark('discovery', '我的箱子', 'overworld', { x: 71, y: 64, z: 0 }, 0.1);
  const [, user] = buildMindMessages(context('deliberate'));
  assert.match(user.content, /床 \(70,64,0\) 70格（sleep；/);
  assert.match(user.content, /我的箱子 \(71,64,0\).*find_item/);
  assert.match(user.content, /记下/);
  assert.match(user.content, /"my_bed":"\(70,64,0\) 70格/);
});

test('设施表超过 8 项时仍保留远处的床', (t) => {
  const { context, memory, close } = harness();
  t.after(close);
  for (let i = 0; i < 12; i++) memory.addLandmark('discovery', '我的箱子', 'overworld', { x: i + 1, y: 64, z: 2 }, 0.1);
  memory.addLandmark('discovery', '我的床', 'overworld', { x: 70, y: 64, z: 0 }, 2);
  memory.addLandmark('discovery', '我的箱子', 'overworld', { x: 71, y: 64, z: 0 }, 0.1);
  const [, user] = buildMindMessages(context('deliberate'));
  assert.match(user.content, /床 \(70,64,0\) 70格（sleep/);
  assert.match(user.content, /我的箱子 \(71,64,0\).*find_item/, '床边的箱子也保留');
});

test('旧开挖入口/进度点单独列出，和普通地点分开', (t) => {
  const { context, memory, close } = harness();
  t.after(close);
  const checkpoint = memory.addLandmark('waypoint', '实际开挖进度（tunnel/east）', 'overworld', { x: 5, y: 11, z: 0 }, 0);
  const entry = memory.addLandmark('waypoint', '实际开挖入口', 'overworld', { x: 6, y: 11, z: 0 }, 0);
  assert.ok(checkpoint && entry);
  const [, user] = buildMindMessages(context('deliberate'));
  assert.match(user.content, /"my_tunnels"/);
  assert.match(user.content, new RegExp(`深层进度前端 实际开挖进度（tunnel/east）\\[${checkpoint.id}\\] \\(5,11,0\\)`));
  assert.match(user.content, new RegExp(`入口 实际开挖入口\\[${entry.id}\\] \\(6,11,0\\)`));
  assert.match(user.content, /两者都只是历史坐标/);
  assert.match(user.content, /不代表现在仍连通/);
  const places = user.content.match(/"places":\[(.*?)\],"my_tunnels"/s)?.[1] ?? '';
  assert.doesNotMatch(places, /实际开挖进度|实际开挖入口/, '旧开挖点只走 my_tunnels，不在 places 重复');
});

test('下矿意图同时给出镐的总耐久余量', (t) => {
  const { context, close } = harness();
  t.after(close);
  const base = context('deliberate');
  base.self.addAgenda('下矿挖钻石', 'goal', 'today');
  const state = { ...base.state, inventory: [
    { name: 'stone_pickaxe', count: 2, durability: { left: 45, max: 131 }, durabilities: [45, 45] },
  ] };
  const percept = { ...base.percept, self: { ...base.percept.self, sky_visible: false, where: { kind: 'underground', text: '地下' } } };
  const ctx = { ...base, state, percept } as unknown as MindContext;
  const [, user] = buildMindMessages(ctx);
  assert.match(user.content, /镐的余量/);
  assert.match(user.content, /约还能挖 90 格/);
});

test('瞥一眼只给附近设施与附近农田，不展开完整设施/农田表', (t) => {
  const { context, close } = harness();
  t.after(close);
  const [, user] = buildMindMessages(context('glance'));
  assert.match(user.content, /nearby_facilities/);
  assert.match(user.content, /nearby_farms/);
  assert.doesNotMatch(user.content, /my_farms/, '瞥一眼不展开完整农田表');
  assert.doesNotMatch(user.content, /my_facilities/, '瞥一眼不展开完整设施表');
  assert.ok((user.content.match(/use_gui\/interact_block/g) ?? []).length <= 3, '瞥一眼附近设施最多 3 处');
  assert.doesNotMatch(user.content, /30格/, '超过 24 格的设施不进入 nearby_facilities');
  assert.match(user.content, /"dist":60/, '远于 48 格的农田仍报未知成熟度');

  const [, empty] = buildMindMessages(context('glance', []));
  assert.doesNotMatch(empty.content, /nearby_farms/, '没有农田时不凭空出现 nearby_farms');
  assert.doesNotMatch(empty.content, /my_farms/, '没有农田时不凭空出现 my_farms');
  const [, emptyFull] = buildMindMessages(context('deliberate', []));
  assert.doesNotMatch(emptyFull.content, /my_farms/, '认真想没有农田时也不凭空出现 my_farms');
});
