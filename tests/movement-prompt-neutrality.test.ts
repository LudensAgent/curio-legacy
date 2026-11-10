import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages, situationalReminders, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('回矿道和地表找矿不因关键词自动收到开挖阶梯指令', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const percept = new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  const state = { ...adapter.state(), gamerules: { keepInventory: true } };
  for (const what of ['沿已知矿道回到地表', '在地表向东找铁矿露头']) {
    const activity = createActivity({ what, why: '', kind: 'explore', repeat: 1,
      steps: [{ skill: 'travel_to', args: { to: { x: 16, y: 64, z: 0 } } }] }, '', 'llm', state);
    const ctx: MindContext = { tier: 'deliberate', reason: '测试', percept, state, self, memory, activity,
      suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', lastRecord: null };
    const reminders = situationalReminders(ctx).join('\n');
    assert.doesNotMatch(reminders, /excavate_run|下矿有稳定下行辅助|手工阶梯的固有限制/);
    assert.match(reminders, /keepInventory 开着（死亡不掉落）/);
    for (const tier of ['deliberate', 'glance'] as const) {
      const [system, user] = buildMindMessages({ ...ctx, tier });
      assert.doesNotMatch(user.content, /要下矿先想好|下矿有稳定下行辅助/);
      const guide = system.content.split('\n').find((line) => line.startsWith('【走到哪】'))!;
      assert.match(guide, /travel_to.*range/);
      assert.match(guide, /navigate_to/);
      assert.match(guide, /explore_toward/);
      const vertical = system.content.split('\n').find((line) => line.startsWith('【原地上下】'))!;
      assert.doesNotMatch(vertical, /改用向上阶梯|mine_cell \[0,2,0\].*→/);
      assert.doesNotMatch(system.content, /在坑里或地下想上去 →.*用 mine_cell \/ move_step/);
      assert.doesNotMatch(system.content, /按回执用 excavate_run\/place_support\/pillar_one/);
    }
  }
});

test('保存的目标与清单标明模型来源，不能凭文字标注变成操作者原话', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const percept = new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  const goal = '沿自开的下行阶梯到地底挖钻石（操作者指令）';
  const steps = ['用 excavate_run 继续开阶梯'];
  const plan = self.setPlan(goal, steps)!;
  for (const tier of ['deliberate', 'glance'] as const) {
    const [, user] = buildMindMessages({ tier, reason: '重新开始', percept, state: adapter.state(), self, memory, activity: null,
      suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', lastRecord: null,
      plan, operatorOrder: { text: '尝试用 explore_toward 移动', ageSec: 0, status: 'new' } });
    const source = user.content.split('\n').find((line) => line.startsWith('【我】'))!;
    assert.match(source, /agenda_and_plan_source.*你自己保存的计划.*不等于操作者原话/);
    assert.match(user.content, /【操作者的指令】\{"order":"尝试用 explore_toward 移动"/);
    assert.ok(user.content.includes(goal), '来源说明不改写既有目标');
    assert.ok(user.content.includes(steps[0]), '来源说明不改写既有清单');
  }
  assert.equal(self.data.plan?.goal, goal);
  assert.deepEqual(self.data.plan?.steps.map((step) => step.text), steps);
});
