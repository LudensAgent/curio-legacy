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

function messagesFor(what: string, why: string, recentActionFailures: MindContext['recentActionFailures'] = []) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state(), self = new SelfModel(null);
  const activity = createActivity({ what, why, kind: 'gather', repeat: 1, steps: [{ skill: 'look_around', args: { seconds: 1 } }] }, '', 'llm', state);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept, state, self, memory, activity,
    recentActionFailures, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  return { memory, user };
}

type MindContext = Parameters<typeof buildMindMessages>[0];

test('下矿意图只提供相关事实，不自动选择下行施工', (t) => {
  const { memory, user } = messagesFor('下矿挖铁', '要攒装备');
  t.after(() => memory.close());
  assert.match(user.content, /铁地下分布/);
  assert.doesNotMatch(user.content, /下矿有稳定下行辅助|excavate_run|assess_landings/);
});

test('手工阶梯失败保留原始回执，不归因成手工阶梯固有限制', (t) => {
  const fails = ['move_step', 'mine_cell'].map((skill, i) => ({ skill, args: { at: [1, -1, 0] }, failure_code: 'PATH_NOT_FOUND',
    summary: '迈不到', position: { x: 0.5, y: 60, z: 0.5 } as const, observed_at: `2026-10-30T12:0${i}:00.000Z` }));
  const { memory, user } = messagesFor('挖阶梯斜井往下', '下到 y16', fails);
  t.after(() => memory.close());
  assert.match(user.content, /PATH_NOT_FOUND/);
  assert.match(user.content, /迈不到/);
  assert.doesNotMatch(user.content, /excavate_run|手工阶梯的固有限制/);
});

test('非下矿意图不注入下行辅助', (t) => {
  const { memory, user } = messagesFor('喂鸡', '肚子饿了');
  t.after(() => memory.close());
  assert.doesNotMatch(user.content, /excavate_run/);
  assert.doesNotMatch(user.content, /assess_landings/);
});
