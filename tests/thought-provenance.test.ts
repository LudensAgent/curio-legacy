import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('prior thoughts and activity reasons stay separate from observed feedback', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const oldThought = '背包只剩四格，挖到铁也没处放';
  self.think(oldThought);
  self.think('挖到了 raw_iron×2', 'outcome');
  self.think('背包剩余 4 个空位', 'notice');
  const activity = createActivity({ what: '整理背包', why: oldThought, kind: 'tidy', steps: [{ skill: 'look_around', args: {} }], repeat: 1 }, oldThought, 'llm', adapter.state());
  activity.results.push({ skill: 'look_around', args: {}, status: 'succeeded', summary: '看到了箱子', at: Date.now(), durationMs: 1 });
  for (const tier of ['glance', 'deliberate'] as const) {
    const [, user] = buildMindMessages({ tier, reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, activity,
      suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
    const recent = JSON.parse(user.content.match(/【最近】(.*)/)![1]);
    assert.deepEqual(recent.stream, [`[此前想法，未经核实] ${oldThought}`, '[outcome] 挖到了 raw_iron×2', '[notice] 背包剩余 4 个空位']);
    const work = JSON.parse(user.content.match(/【手上的活】(.*)/)![1]);
    assert.equal(work.current_activity.why, oldThought);
    assert.match(work.activity_reason_source, /先前选择的理由，不等于观测事实/);
    assert.match(work.current_activity.recent[0], /看到了箱子/);
  }
  memory.close();
});
