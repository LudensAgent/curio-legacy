import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { MemoryContext, MemoryRecall } from '../src/memory/types.ts';
import { Mind } from '../src/mind/mind.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('长期记忆回显：experience/inference 分别标记，并注明历史非现场', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  try {
    const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
      self, memory, activity: null, suspended: [], next: null, lastRecord: null, noticed: [], changes: [],
      userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P',
      hindsightMemories: [{ text: '在旧通道附近朝南找铁矿', kind: 'experience' }, { text: '推断：矿石在 y30 一带', kind: 'inference' }] });
    assert.match(user.content, /\[经历·长期记忆\] 在旧通道附近朝南找铁矿/);
    assert.match(user.content, /\[推断·长期记忆\] 推断：矿石在 y30 一带/);
    assert.match(user.content, /长期记忆是合并后的历史经历或推断，不等于当前现场事实/);
  } finally {
    memory.close();
  }
});

test('后台预取：只取 hindsight 结果并缓存，失败静默；30 秒内不重复拉', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  let calls = 0;
  const fakeRecall: MemoryRecall = {
    recall: async (): Promise<MemoryContext> => {
      calls++;
      return { source: 'hindsight', query: '', memories: [{ id: 'm1', text: '在旧通道附近找铁矿', source: 'hindsight:consolidation', kind: 'experience' }] };
    },
  };
  const provider = { name: 'prefetch-test', complete: (): Promise<Completion> => new Promise(() => {}) };
  const planner = new Planner(cfg, provider, adapter, memory, bus, null, null, fakeRecall);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '测试',
    thinker: new Thinker(planner, adapter, memory, bus, null) });
  const any = mind as any;
  const percept = perception.update();
  await any.prefetchHindsight('挖矿 铁', percept, any.generation);
  assert.equal(calls, 1);
  assert.equal(any.hindsightMemories.items.length, 1);
  assert.equal(any.hindsightMemories.items[0].kind, 'experience');
  // 30 秒内不重复拉
  await any.prefetchHindsight('挖矿 铁', percept, any.generation);
  assert.equal(calls, 1);
  // 本地回落不算长期记忆：不覆盖已有缓存
  any.hindsightPrefetchAt = 0;
  fakeRecall.recall = async () => { calls++; return { source: 'local', query: '', memories: [] }; };
  await any.prefetchHindsight('挖矿 铁', percept, any.generation);
  assert.equal(calls, 2);
  assert.equal(any.hindsightMemories.items[0].text, '在旧通道附近找铁矿');
  memory.close();
});
