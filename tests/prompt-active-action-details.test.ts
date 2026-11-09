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

function userFor(tier: 'glance' | 'deliberate', skill: string, args: Record<string, unknown>) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const state = adapter.state(), self = new SelfModel(null);
  const activity = createActivity({ what: '试一下', why: '测试', kind: 'experiment', repeat: 1, steps: [{ skill, args }] }, '', 'llm', state);
  const [, user] = buildMindMessages({ tier, reason: '测试', percept: perception.update(), state, self, memory, activity,
    suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  memory.close();
  return user.content;
}

test('目录外的动作正在使用时，两种思考都把完整参数贴在用户消息里', () => {
  for (const tier of ['glance', 'deliberate'] as const) {
    const content = userFor(tier, 'inspect_block', { target: 'stone' });
    assert.match(content, /正在用的动作参数：/);
    assert.match(content, /^- inspect_block .*"target"/m);
  }
});

test('目录里的核心动作不重复贴参数', () => {
  for (const tier of ['glance', 'deliberate'] as const) {
    const content = userFor(tier, 'gather', { block: 'log', count: 2 });
    assert.doesNotMatch(content, /正在用的动作参数：/);
  }
});
