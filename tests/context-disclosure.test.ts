import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ExcursionLog } from '../src/mind/excursions.ts';
import { buildMindMessages, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { travelStore } from '../src/travel/store.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture(t: { after: (fn: () => void) => void }, tier: 'glance' | 'deliberate' = 'deliberate') {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const self = new SelfModel(null);
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  t.after(() => { self.close(); memory.close(); });
  const section = (name: string, over: Partial<MindContext> = {}) => {
    const ctx: MindContext = { tier, reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
      activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', skills: [], ...over };
    const [, user] = buildMindMessages(ctx);
    return JSON.parse(user.content.match(new RegExp(`【${name}】(.*)`))![1]);
  };
  const known = () => section('记得的地方');
  return { adapter, memory, self, section, known };
}

test('设施只给容器内容摘要，完整数量按 find_item 查', (t) => {
  const { adapter, memory, known } = fixture(t);
  adapter.blocks.push({ name: 'crafting_table', pos: { x: 2, y: 64, z: 0 } }, { name: 'chest', pos: { x: 3, y: 64, z: 0 } });
  memory.addLandmark('discovery', '我的工作台', 'overworld', { x: 2, y: 64, z: 0 }, 2);
  memory.setChest('overworld', { x: 3, y: 64, z: 0 }, [
    { name: 'cobblestone', count: 504 }, { name: 'dirt', count: 100 }, { name: 'iron_ingot', count: 30 }, { name: 'gold_nugget', count: 20 },
  ]);
  const places = known();
  const facilities = (places.my_facilities as string[]).join('\n');
  assert.match(facilities, /我的工作台|工作台/);
  assert.match(facilities, /4 类，cobblestone×504、dirt×100 等/);
  assert.match(facilities, /完整数量用 find_item 查/);
  assert.doesNotMatch(facilities, /iron_ingot|gold_nugget/, '完整容器记录不应每念展开');
});

test('places 同坐标的非设施地标也只留一条', (t) => {
  const { memory, known } = fixture(t);
  memory.addLandmark('discovery', '小湖', 'overworld', { x: 12, y: 64, z: 0 }, 0);
  memory.addLandmark('discovery', '湖边木牌', 'overworld', { x: 12, y: 64, z: 0 }, 0);
  const listed = (known().places as string[]).join('\n');
  assert.equal((listed.match(/\(12,64,0\)/g) ?? []).length, 1, listed);
});

test('places 不重复设施和门的坐标，同坐标的历史地标只留一条', (t) => {
  const { adapter, memory, known } = fixture(t);
  adapter.blocks.push({ name: 'crafting_table', pos: { x: 2, y: 64, z: 0 } }, { name: 'chest', pos: { x: 3, y: 64, z: 0 } },
    { name: 'nether_portal', pos: { x: 4, y: 64, z: 0 } });
  memory.addLandmark('discovery', '我的工作台', 'overworld', { x: 2, y: 64, z: 0 }, 2);
  memory.setChest('overworld', { x: 3, y: 64, z: 0 }, [{ name: 'dirt', count: 7 }]);
  const portal = travelStore(memory).observe(adapter.state(), { x: 4, y: 64, z: 0 }, 'nether_portal');
  memory.addLandmark('discovery', `下界门 ${portal.id}`, 'overworld', portal.pos, 4);
  memory.addLandmark('waypoint', '门厅（nether_portal）', 'overworld', portal.pos, 1);
  memory.addLandmark('discovery', '小湖', 'overworld', { x: 12, y: 64, z: 0 }, 2);
  const places = known();
  const listed = (places.places as string[]).join('\n');
  assert.match(listed, /小湖/, '与设施/门无关的地点仍要保留');
  assert.doesNotMatch(listed, /工作台|箱子|门厅|下界门/, '设施、容器和门各有主来源，不在 places 重复');
  assert.ok((places.my_facilities as string[]).some((line) => /工作台/.test(line)));
  assert.ok((places.portals as { id: string }[]).some((entry) => entry.id === portal.id));
});

test('门的落点压成短行，同一目的地只列一次并标出回程已验证', (t) => {
  const { adapter, memory, known } = fixture(t);
  const here = adapter.state();
  const store = travelStore(memory);
  const gate = store.observe(here, { x: 3, y: here.pos.y, z: 0 }, 'nether_portal');
  const far = store.observe({ ...here, dim: 'the_nether', sessionId: 'n1', observationId: here.observationId + 1 }, { x: 10, y: 70, z: 0 }, 'nether_portal');
  const far2 = store.observe({ ...here, dim: 'the_nether', sessionId: 'n2', observationId: here.observationId + 2 }, { x: 20, y: 70, z: 0 }, 'nether_portal');
  store.record(gate.id, far.id, here, { ...here, dim: 'the_nether', sessionId: 'n1', observationId: here.observationId + 1 });
  store.record(gate.id, far2.id, here, { ...here, dim: 'the_nether', sessionId: 'n2', observationId: here.observationId + 2 });
  // 反向再穿一次：同一目的地应合并，并标记回程已验证。
  store.record(far.id, gate.id, { ...here, dim: 'the_nether', sessionId: 'n3', observationId: here.observationId + 3 },
    { ...here, sessionId: 's2', observationId: here.observationId + 4 });
  const portal = (known().portals as { id: string; leads_to?: string[] }[]).find((entry) => entry.id === gate.id);
  assert.ok(portal, '门应被列出');
  const routes = portal.leads_to ?? [];
  assert.ok(routes.length >= 1);
  assert.ok(routes.every((line) => typeof line === 'string'), '落点应是短行而不是完整对象');
  assert.match(routes.join('\n'), /the_nether portal_\w+ \(10,70,0\) 回程已验证/);
  assert.match(routes.join('\n'), /回程已验证/);
  assert.equal(routes.filter((line) => line.includes('(10,70,0)')).length, 1, '同一目的地只列一次');
});

test('只给正在验证和未结论的试验；已结论的不再每次展开', (t) => {
  const { self, section } = fixture(t);
  for (const text of ['旧结论一', '旧结论二', '旧结论三']) {
    const e = self.startExperiment(text, 'act_' + text);
    self.concludeExperiment(e.id, 'unclear', 'x'.repeat(300));
  }
  const done = self.startExperiment('已经证实的假设', 'act_done');
  self.concludeExperiment(done.id, 'supported', '证实了');
  self.startExperiment('正在验证的假设', 'act_running');
  const experiments = section('我').experiments as { hypothesis: string; status: string; evidence?: string }[];
  assert.equal(experiments[0]!.status, 'running');
  assert.match(experiments[0]!.hypothesis, /正在验证的假设/);
  assert.equal(experiments.length, 2, '正在验证 + 最近一条未结论');
  assert.equal(experiments[1]!.status, 'unclear');
  assert.ok(experiments[1]!.evidence, '未结论的实验仍要带证据');
  assert.ok(experiments[1]!.evidence!.length <= 101, '未结论的证据截短');
  assert.ok(!experiments.some((e) => e.hypothesis === '已经证实的假设'));
});

test('过去出行只留一行摘要，当前这一趟不重复展开', (t) => {
  const { adapter, section } = fixture(t);
  const log = new ExcursionLog(null);
  let now = Date.now() - 30 * 60_000;
  const at = (dim: string, x: number) => ({ ...adapter.state(), dim, pos: { x: x + 0.5, y: 70, z: 0.5 } });
  for (let i = 0; i <= 6; i++) log.sample(at('overworld', i * 4), now += 10_000);
  log.sample(at('the_nether', 0), now += 10_000);
  log.sample(at('overworld', 0), now += 10_000);
  const places = section('记得的地方', { excursions: log.legs() });
  const past = places.my_trips_in_this_dimension as string[];
  assert.equal(past.length, 1, '主世界里只列已经结束的那一段');
  assert.match(past[0]!, /^主世界/);
  assert.match(past[0]!, /最远离入口 24 格/);
  assert.doesNotMatch(past[0]!, /还在这一段|背包食物|镐 \d+→\d+ 把/, '过去出行只给一行摘要');
  assert.ok(places.current_trip, '当前这一趟仍走 current_trip');
  assert.ok(places.current_trip_note);
});

test('技能索引之外只补执行状态，候选收起与可试用不能混淆', (t) => {
  const { section } = fixture(t);
  const learnedSkills = [
    'shield-hold［自动，代码 v1］ 成2/败1；候选 v1 尚未启用，用 use_skill {name:"shield-hold",trial:true} 试用，试用成3/败1；保留成功过的应急版本 v1（成2/败1），可查技能历史，由心智用 from_version 选为新候选再试',
    'old-skill［自动，代码 v1］ 成0/败2；候选 v2 已收起（连续失败），可查历史，显式修订后再试',
  ];
  const skills = section('我', { learnedSkills }).my_skills as string[];
  assert.equal(skills[0], 'shield-hold［自动，代码 v1］ 成2/败1；候选可试用（试用成3/败1）（详情查 skill）');
  assert.match(skills[1]!, /已收起/);
  assert.doesNotMatch(skills[1]!, /候选可试用/, '未识别的候选状态不能被改写成可用');
});

test('methods/macros 保留调用写法和执行状态', (t) => {
  const { section } = fixture(t);
  const mySkills = [
    { name: 'trial:dig-shaft:v2', status: 'candidate' as const, description: '一格一格往下挖竖井', trials: { verified: 2, failed: 1 } },
    { name: 'macro:harvest-loop', status: 'macro' as const, description: '收割并补种', success: '7/9' },
  ];
  const skills = section('我', { mySkills }).my_skills as string[];
  assert.match(skills[0]!, /试用成2\/败1/);
  assert.match(skills[0]!, /直接写成一步/);
  assert.match(skills[1]!, /成功率 7\/9/);
});
