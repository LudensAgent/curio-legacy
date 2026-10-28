import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('focus prompt distinguishes observed online stagnation from calendar age', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  self.setPlan('采矿', ['获得粗铁']);
  const plan = self.plan()!;
  plan.setAt = now - 600 * 60_000;
  plan.progressAt = plan.setAt;
  self.setOnline(true, now);
  now += 2 * 60_000;
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /"goal_age_wall_clock_min":602/);
  assert.match(user.content, /"no_progress_observed_online_min":2/);
  assert.match(user.content, /"earlier_online_time":"未知"/);
  assert.doesNotMatch(user.content, /"no_progress_min":602/);
});
