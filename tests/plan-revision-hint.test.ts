import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ActivityRecord } from '../src/mind/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const rec = (what: string, outcome: ActivityRecord['outcome'], at: number): ActivityRecord =>
  ({ id: `r-${at}`, what, kind: 'explore', outcome, summary: '没进展', durationSec: 30, gained: {}, lost: {}, at, signature: 'sig', failures: 1 });

test('主目标清单观察在线没进展且最近反复卡住：提示改清单、不换主目标、不重写已勾掉的项', (t) => {
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
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /主目标「挖够粗铁做装备」的清单已观察到 15 在线分钟没勾掉一项/);
  assert.match(user.content, /主目标不用换（换目标要等阶段回顾）/);
  assert.match(user.content, /清单可以按实际情况改/);
  assert.match(user.content, /不再强制写 switch_reason/);
  assert.doesNotMatch(user.content, /删项要在 plan 里写/);
  assert.match(user.content, /「下到 y16 找铁」）保留，别写成新步骤/);
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
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(user.content, /别写成新步骤/);
  // 停滞了但只是瞥一眼（glance）：也不提（要转成认真想）
  plan.progressAt = now - 15 * 60_000;
  plan.stalledOnlineMs = 15 * 60_000;
  plan.stalledObservedSince = now - 15 * 60_000;
  plan.stalledHistoryUnknown = false;
  const [, glanced] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(glanced.content, /别写成新步骤/);
});
