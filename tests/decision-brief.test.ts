import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages, decisionBrief, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('wheat_seeds', 4);
  adapter.inv.set('stone_hoe', 1);
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const bus = new EventBus(), self = new SelfModel(null);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  t.after(() => { self.close(); memory.close(); });
  const ctx: MindContext = { tier: 'deliberate', reason: '测试', percept, state, self, memory, activity: null,
    suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '' };
  return { adapter, memory, self, ctx, perceive: () => perception.update() };
}

test('决策摘要从已有事实里挑出阶段、缺口、近处机会、未解决问题和查询入口', (t) => {
  const { adapter, memory, self, ctx, perceive } = fixture(t);
  adapter.blocks.push({ name: 'wheat', pos: { x: 2, y: 64, z: 0 } }, { name: 'wheat', pos: { x: 3, y: 64, z: 0 } });
  adapter.crops.set('2,64,0', { age: 7, crop: 'wheat' });
  adapter.crops.set('3,64,0', { age: 7, crop: 'wheat' });
  memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 63, z: 0 }, { x: 3, y: 63, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  self.addAgenda('麦田缺水怎么长期解决', 'question', 'today');
  self.startExperiment('石锄能翻带草的草方块', 'act_x');
  const plan = { agendaId: 'a_test', goal: '在基地盖一座能住人的石屋，屋前开一小块麦田', setAt: Date.now(), updatedAt: Date.now(), needs: [{ item: 'wheat_seeds', count: 9 }], steps: [
    { id: 'po_done', text: '封顶', done: true }, { id: 'po_farm', text: '屋前开 3×3 麦田，引水并播种', done: false },
  ] };
  const lines = decisionBrief({ ...ctx, percept: perceive(), plan, repeatedFailures: ['travel_to：卡住 ×2'] });
  assert.equal(lines.length, 5, lines.join('\n'));
  assert.match(lines[0]!, /局面：.*下一项 屋前开 3×3 麦田/);
  assert.match(lines[1]!, /直接缺口：wheat_seeds×9，还差：wheat_seeds×5/);
  assert.match(lines[1]!, /近期阻碍：travel_to：卡住 ×2/);
  assert.match(lines[2]!, /近处农田：wheat 2 格，成熟 2/);
  assert.match(lines[3]!, /待弄清：麦田缺水/);
  assert.match(lines[4]!, /"kind":"progress".*"po_farm"/);
});

test('没有可用事实时摘要为空；瞥一眼只给一条近处农田机会', (t) => {
  const { adapter, memory, ctx, perceive } = fixture(t);
  assert.deepEqual(decisionBrief(ctx), []);
  adapter.blocks.push({ name: 'wheat', pos: { x: 2, y: 64, z: 0 } });
  adapter.crops.set('2,64,0', { age: 7, crop: 'wheat' });
  memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 63, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  const glance = decisionBrief({ ...ctx, percept: perceive(), tier: 'glance' });
  assert.equal(glance.length, 1);
  assert.match(glance[0]!, /近处农田：wheat 1 格，成熟 1/);
  assert.doesNotMatch(glance.join('\n'), /局面|直接缺口/);
});

test('决策摘要进入 User Prompt 且位于【此刻】之前；System 不含摘要', (t) => {
  const { ctx } = fixture(t);
  const plan = { agendaId: 'a_test', goal: '在基地盖一座石屋', setAt: Date.now(), updatedAt: Date.now(), steps: [{ id: 'po_roof', text: '封顶', done: false }] };
  const [system, user] = buildMindMessages({ ...ctx, plan });
  assert.doesNotMatch(system.content, /决策摘要/);
  assert.match(user.content, /【决策摘要】/);
  assert.ok(user.content.indexOf('【决策摘要】') < user.content.indexOf('【此刻】'));
  assert.match(user.content, /下一项 封顶/);
  const [plainSystem, plainUser] = buildMindMessages(ctx);
  assert.equal(system.content, plainSystem.content, '决策摘要不改 System');
  assert.doesNotMatch(plainUser.content, /【决策摘要】/);
  assert.doesNotMatch(plainSystem.content, /决策摘要/);
});

test('没有成熟农田时给最近的可用设施；瞥一眼可同时给阻碍与机会', (t) => {
  const { memory, ctx } = fixture(t);
  memory.addLandmark('discovery', '我的箱子', 'overworld', { x: 3, y: 64, z: 2 }, 4);
  const withFailure = { ...ctx, percept: ctx.percept, repeatedFailures: ['move_step：被挡住'] };
  const deliberate = decisionBrief(withFailure);
  assert.ok(deliberate.some((line) => /近处设施：箱子 3 格（容器）/.test(line)), deliberate.join('\n'));
  assert.ok(deliberate.some((line) => /近期阻碍：move_step/.test(line)));
  const glance = decisionBrief({ ...withFailure, tier: 'glance' });
  assert.equal(glance.length, 2, glance.join('\n'));
  assert.match(glance[0]!, /近期阻碍/);
  assert.match(glance[1]!, /近处设施/);
});

test('没有未解决议程问题时用正在验证的实验补位', (t) => {
  const { self, ctx } = fixture(t);
  self.startExperiment('石锄能翻带草的草方块', 'act_x');
  const lines = decisionBrief(ctx);
  assert.ok(lines.some((line) => /待验证：石锄能翻带草的草方块/.test(line)), lines.join('\n'));
});
