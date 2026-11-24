import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { GOAL_SWITCH_RULE, SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ActivityRecord } from '../src/mind/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const rec = (what: string, outcome: ActivityRecord['outcome'], at: number): ActivityRecord =>
  ({ id: `r-${at}`, what, kind: 'explore', outcome, summary: '没进展', durationSec: 30, gained: {}, lost: {}, at, signature: 'sig', failures: 1 });

test('主目标清单观察在线没进展且最近反复卡住：提示改清单的条件、不换主目标、不重写已勾掉的项', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  self.setPlan('挖够粗铁做装备', ['下到 y16 找铁', '挖到 24 个粗铁']);
  self.checkPlan([0]); // 已勾掉第一项
  const plan = self.plan()!;
  self.setOnline(true, now);
  plan.progressAt = now - 15 * 60_000;
  plan.stalledOnlineMs = 15 * 60_000;
  plan.stalledObservedSince = now - 15 * 60_000;
  plan.stalledHistoryUnknown = false;
  self.data.history.push(
    rec('原地往下挖竖井', 'stuck', now - 5 * 60_000),
    rec('原地往下挖竖井', 'stuck', now - 4 * 60_000),
    rec('往下挖竖井', 'unmet', now - 3 * 60_000),
  );
  const [system, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /主目标「挖够粗铁做装备」的清单已观察到 15 在线分钟没勾掉一项/);
  assert.ok(system.content.includes(GOAL_SWITCH_RULE), '完整换目标规则在 System【专注】里');
  assert.match(user.content, /清单是成果，做法可以随时换/);
  assert.match(user.content, /删掉没做完的成果/);
  assert.match(user.content, /写 switch_reason/);
  assert.match(user.content, /距上次删改满 15 分钟/);
  assert.match(user.content, /只观察停滞不构成删项理由/);
  assert.doesNotMatch(user.content, /不再强制写 switch_reason/);
  assert.match(user.content, /「下到 y16 找铁」）保留，别写成新步骤/);
  const hint = user.content.split('\n').find((line) => line.includes('的清单已观察到'))!;
  assert.match(hint, /按【专注】/, '提醒引用完整规则，不整段复述');
  assert.doesNotMatch(hint, /清单是成果，做法可以随时换/, '完整规则只在【专注】里出现一次');
});

test('计划已勾步骤但 needs 仍缺：提示按当前背包复核，装备可能断/丢', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  adapter.inv.set('iron_ingot', 1);
  self.setPlan('备齐下界补给', ['做一把铁镐', '凑 3 份熟食'], [], { needs: [{ item: 'iron_ingot', count: 3, why: '补铁镐/修甲' }] });
  self.checkPlan([0]);
  const plan = self.plan()!;
  self.setOnline(true, now);
  plan.progressAt = now - 20 * 60_000;
  plan.stalledOnlineMs = 20 * 60_000;
  plan.stalledObservedSince = now - 20 * 60_000;
  plan.stalledHistoryUnknown = false;
  self.data.history.push(
    rec('门厅找铁', 'stuck', now - 6 * 60_000),
    rec('门厅找铁', 'stuck', now - 5 * 60_000),
    rec('门厅找熟食', 'unmet', now - 4 * 60_000),
  );
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /needs 仍缺 iron_ingot×3（现有 1）/);
  assert.match(user.content, /已勾步骤只在当前仍满足时保留/);
  assert.match(user.content, /别当成现在就满足/);
});

test('没有停滞、或瞥一眼，不提示改清单', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  self.setPlan('挖够粗铁做装备', ['下到 y16 找铁']);
  const plan = self.plan()!;
  self.setOnline(true, now);
  // 没停滞：不应出现改清单提示
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(user.content, /别写成新步骤/);
  // 停滞了但只是瞥一眼（glance）：也不提（要转成认真想）
  plan.progressAt = now - 15 * 60_000;
  plan.stalledOnlineMs = 15 * 60_000;
  plan.stalledObservedSince = now - 15 * 60_000;
  plan.stalledHistoryUnknown = false;
  const [, glanced] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(glanced.content, /别写成新步骤/);
});

test('改过清单后，要等新清单也卡住两段才再提示改清单；改写次数作为事实列在【专注】里', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  self.setPlan('挖够粗铁做装备', ['下到 y16 找铁', '挖到 24 个粗铁']);
  self.setOnline(true, now);
  const stall = () => {
    const plan = self.plan()!;
    plan.progressAt = now - 30 * 60_000;
    plan.stalledOnlineMs = 30 * 60_000;
    plan.stalledObservedSince = now - 30 * 60_000;
    plan.stalledHistoryUnknown = false;
    return plan;
  };
  stall();
  self.data.history.push(rec('挖竖井', 'stuck', now - 9 * 60_000), rec('挖竖井', 'stuck', now - 8 * 60_000), rec('挖竖井', 'unmet', now - 7 * 60_000));
  const think = () => buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan: self.plan()!, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' })[1].content;
  assert.match(think(), /的清单已观察到/);
  now += 60_000;
  self.setPlan(self.plan()!.agendaId, ['换个地方挖竖井', '挖到 24 个粗铁']);
  stall();
  const afterRewrite = think();
  assert.doesNotMatch(afterRewrite, /的清单已观察到/, '刚改过清单，旧的卡住记录不再催改');
  assert.match(afterRewrite, /"checklist_rewrites_since_progress":1/);
  now += 60_000;
  self.data.history.push(rec('换地方挖竖井', 'stuck', now - 30_000), rec('换地方挖竖井', 'unmet', now - 10_000));
  assert.match(think(), /的清单已观察到/, '新清单也卡住两段，再提示');
});
