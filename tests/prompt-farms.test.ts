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
  return { context, close };
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
  assert.match(user.content, /床见 my_bed/);
  assert.doesNotMatch(situationalReminders(context('deliberate')).join(' '), /农田|成熟/, '普通农田状态不进入每念提醒');

  const [, known] = buildMindMessages(context('deliberate', [{ crop: 'wheat', cells: 1, dist: 12, mature: 0, minutes_since_planted: 10 }]));
  assert.match(known.content, /"mature":0/, '实际观察到的 0 成熟数照实显示');
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
