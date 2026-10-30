import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const base = () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  return { adapter, memory, bus, perception, self };
};

test('提前想好的下一段（next）会如实回显进提示词，不因清单而丢失', () => {
  const { adapter, memory, perception, self } = base();
  try {
    const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [], next: { what: '挖短巷', why: '通到矿点' }, lastRecord: null, noticed: [], changes: [],
      userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
    assert.match(user.content, /已经想好接下来做「挖短巷」/);
    assert.match(user.content, /（通到矿点）/);
  } finally {
    memory.close();
  }
});

test('没有 next 时不出现多余的下一段提示', () => {
  const { adapter, memory, perception, self } = base();
  try {
    const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [], next: null, lastRecord: null, noticed: [], changes: [],
      userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
    assert.doesNotMatch(user.content, /已经想好接下来做/);
  } finally {
    memory.close();
  }
});
