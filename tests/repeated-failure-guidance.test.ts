import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const fail = (state: { pos: { x: number; y: number; z: number } }, repeats?: number) =>
  ({ skill: 'step', args: { at: [1, -1, 0] }, failure_code: 'PATH_NOT_FOUND', summary: '迈不到',
    position: state.pos, observed_at: '2026-10-30T12:00:00.000Z', ...(repeats !== undefined ? { repeats } : {}) });

test('同一动作反复失败时，提示先改这一步而不是整段重写', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const state = adapter.state(), self = new SelfModel(null);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state, self, memory,
    activity: null, recentActionFailures: [fail(state, 3)], suspended: [], lastRecord: null, noticed: [], changes: [],
    userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /反复 PATH_NOT_FOUND/);
  assert.match(user.content, /不必把整段活推倒重来/);
});

test('失败没有反复时不提示整段重写', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const state = adapter.state(), self = new SelfModel(null);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state, self, memory,
    activity: null, recentActionFailures: [fail(state)], suspended: [], lastRecord: null, noticed: [], changes: [],
    userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(user.content, /不必把整段活推倒重来/);
});
