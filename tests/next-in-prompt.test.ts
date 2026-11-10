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

test('next.requires 作为下一段的前置条件如实回显，区别于当前活动的 done_when', () => {
  const { adapter, memory, perception, self } = base();
  try {
    const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [],
      next: { what: '挖铁', why: '做镐', requires: { type: 'inventory_min', item: 'raw_iron', count: 3 } },
      lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
    assert.match(user.content, /queued_next_requires/);
    assert.match(user.content, /开始前会按当时状态验收/);
    assert.match(user.content, /raw_iron/);
  } finally {
    memory.close();
  }
});

test('系统提示词先要求核对 continue_effect，只有决定原样执行剩余计划才 continue', () => {
  const { adapter, memory, perception, self } = base();
  try {
    const [system] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [], next: null, lastRecord: null, noticed: [], changes: [],
      userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
    assert.match(system.content, /核对【手上的活】的 continue_effect/);
    assert.match(system.content, /只有决定原样执行剩余计划才 continue/);
    assert.match(system.content, /adjust\/detour\/switch/);
    assert.doesNotMatch(system.content, /手上的活还顺，就 continue/);
    assert.doesNotMatch(system.content, /在推进清单就 continue/);
  } finally {
    memory.close();
  }
});

test('完成的活动记录里保留采集回执快照，并标明是历史值', () => {
  const { adapter, memory, perception, self } = base();
  try {
    const at = Date.now();
    const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [], next: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P',
      lastRecord: {
        id: 'act_done', what: '挖铁', kind: 'gather', outcome: 'done', summary: 'raw_iron 2→3（目标 3，已达成）',
        durationSec: 3, gained: { raw_iron: 1 }, lost: {}, at, signature: 'gather:iron_ore', failures: 0,
        collection: { block: 'iron_ore', items: ['raw_iron'], initial: 2, target: 3, final: 3, gained: 1, dug: 1, targetMet: true,
          skill: 'gather', args: { block: 'iron_ore', count: 3 }, at },
      } });
    assert.match(user.content, /历史采集回执/);
    assert.match(user.content, /raw_iron/);
    assert.match(user.content, /gather.*iron_ore/);
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
