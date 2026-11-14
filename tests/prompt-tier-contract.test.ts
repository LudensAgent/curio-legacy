import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages, deliberateSystem, glanceSystem, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('两档的职责不同：认真想综合判断，瞥一眼只记录与保持当前活动', () => {
  const deliberate = deliberateSystem('P', []), glance = glanceSystem('P', []);
  for (const marker of ['这是综合判断', '不把长期发展变成无限囤积', '换目标被拒别重复']) {
    assert.ok(deliberate.includes(marker), `认真想缺少「${marker}」`);
  }
  for (const marker of ['普通观察/资源/设施/局部失败', '不启动多阶段项目', '已有排好的 next 时再写 new/switch 会被丢弃', '紧急只授权中断', '换目标被拒别重复']) {
    assert.ok(glance.includes(marker), `瞥一眼缺少「${marker}」`);
  }
  assert.ok(!glance.includes('这是综合判断'), '瞥一眼不应加载综合判断契约');
  assert.ok(!glance.includes('重新评估阶段'), '瞥一眼不应邀请重估阶段');
});

test('【专注】在瞥一眼只保留目标/清单/下一项，认真想才展开做法、尝试、预算和进展', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const plan = self.setPlan('备木头再进下界', ['备好木头', '找铁'], [], {
    methods: [{ text: '沿河找树', outcome: 0 }],
    needs: [{ item: 'oak_log', count: 16, why: '工具/火把' }],
  })!;
  self.recordPlanAttempt({ outcomeId: plan.steps[0]!.id, methodId: plan.methods![0]!.id, whatHappened: '沿河没看到树', whyStopped: 'NOT_FOUND' });
  const activity = createActivity({
    what: '沿河找树', why: '', kind: 'gather', repeat: 1,
    steps: [{ skill: 'gather', args: { block: 'oak_log', count: 8 } }],
  }, '', 'llm', adapter.state());
  const ctx = (tier: 'glance' | 'deliberate'): MindContext => ({
    tier, reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, plan,
    activity, suspended: [activity], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P',
  });
  const focusOf = (tier: 'glance' | 'deliberate') => {
    const [, user] = buildMindMessages(ctx(tier));
    return user.content.split('\n').find((line) => line.startsWith('【专注】')) ?? '';
  };
  const glance = focusOf('glance'), deliberate = focusOf('deliberate');
  for (const marker of ['"next_item"', '"checklist"', 'current_activity_for_goal', 'will_resume_after_detour', '瞥一眼不改成果清单']) {
    assert.ok(glance.includes(marker), `瞥一眼缺少 ${marker}`);
  }
  for (const marker of ['"methods"', '"recent_attempts"', '"material_budget"', 'no_progress_observed_online_min', 'activities_since_progress']) {
    assert.ok(!glance.includes(marker), `瞥一眼不应展开 ${marker}`);
    assert.ok(deliberate.includes(marker), `认真想应保留 ${marker}`);
  }
  assert.ok(!glance.includes('progress_trend'), '瞥一眼不应展开 progress_trend');
});

test('瞥一眼在非主世界也能看到进阶动作提醒', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  adapter.dim = 'the_nether';
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const context: MindContext = {
    tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P',
  };
  const [, user] = buildMindMessages(context);
  assert.match(user.content, /进阶动作可用/);
  assert.match(user.content, /travel_portal/);
});
