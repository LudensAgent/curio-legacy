import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { KnowledgeBase } from '../src/knowledge/library.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

const decision = { decision: 'new', monologue: '先看看眼前的情况，再决定怎么用这些资料。',
  activity: { what: '观察身边', steps: [{ skill: 'look_around', args: { seconds: 1 } }] } };

function fixture(t: TestContext, replies: object[], tier: MindContext['tier'] = 'deliberate', body = `## conditions | 条件
测试资料：关于床的使用条件，是否采用由 Agent 自己决定。

## effects | 效果
测试资料：查询不代表已经使用床或学会了操作。`) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-knowledge-protocol-'));
  fs.writeFileSync(path.join(directory, 'fixture-topic.md'), `---
id: "fixture-topic"
title: "床的测试资料"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["bed", "床"]
sources: [{"url":"https://minecraft.wiki/w/Bed","title":"Bed"}]
---

${body}
`);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const self = new SelfModel(null), perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const calls: ChatMessage[][] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000 } };
  const planner = new Planner(cfg, { name: 'knowledge-protocol-test', complete: async (messages) => {
    calls.push(structuredClone(messages));
    const reply = replies[calls.length - 1];
    assert.ok(reply, 'unexpected additional model call');
    return { text: JSON.stringify(reply), latencyMs: 1 };
  } }, adapter, memory, bus, null);
  const knowledge = new KnowledgeBase('1.20.1', directory);
  const thinker = new Thinker(planner, adapter, memory, bus, null, knowledge);
  const ctx: MindContext = { tier, reason: '查看知识资料', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '你是 Curio。' };
  t.after(() => {
    memory.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, memory, bus, self, planner, knowledge, calls, think: () => thinker.think(ctx, new AbortController().signal) };
}

test('knowledge search and section reading inform a decision without executing actions or changing personal memory and skills', async (t) => {
  const w = fixture(t, [{ kind: 'knowledge', query: '床的使用条件' }, { kind: 'knowledge', id: 'fixture-topic', section: 'conditions' }, decision]);
  const skills = Object.entries(SKILLS);
  const personal = structuredClone({ self: w.self.data, notes: w.memory.notesFor({ n: 100 }), lessons: w.memory.lessons(100), goals: w.memory.recentGoals(100), landmarks: w.memory.landmarks() });
  const result = await w.think();
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  assert.equal(w.calls.length, 3);
  assert.match(w.calls[1].at(-1)!.content, /"action":"search"/);
  assert.match(w.calls[1].at(-1)!.content, /fixture-topic/);
  const read = w.calls[2].at(-1)!.content;
  assert.match(read, /"action":"read"/);
  assert.match(read, /"id":"conditions"/);
  assert.match(read, /https:\/\/minecraft\.wiki\/w\/Bed/);
  assert.match(read, /reference_not_current_state/);
  assert.match(read, /是否采用由 Agent 自己决定/);
  assert.equal(w.bus.recent().filter((e) => e.type === 'knowledge_query').length, 2);
  assert.deepEqual(w.adapter.actions, []);
  assert.deepEqual(Object.entries(SKILLS), skills);
  assert.deepEqual({ self: w.self.data, notes: w.memory.notesFor({ n: 100 }), lessons: w.memory.lessons(100), goals: w.memory.recentGoals(100), landmarks: w.memory.landmarks() }, personal);
});

test('knowledge is discoverable in glance and a direct query upgrades the following decision to deliberate', async (t) => {
  const w = fixture(t, [{ kind: 'knowledge' }, decision], 'glance');
  const result = await w.think();
  assert.match(w.calls[0][0].content, /"kind":"knowledge"/);
  assert.match(w.calls[1].at(-1)!.content, /"action":"catalog"/);
  assert.equal(result.tier, 'deliberate');
  assert.deepEqual(w.planner.stats.tiers, { light: 1, full: 1, escalated: 1 });
});

test('knowledge mistakenly placed in activity steps is read during thinking and never becomes a body action', async (t) => {
  const w = fixture(t, [{ decision: 'new', activity: { what: '查床的资料', steps: [{ skill: 'knowledge', args: { id: 'fixture-topic', section: 'effects' } }] } }, decision], 'glance');
  const result = await w.think();
  assert.equal(result.tier, 'deliberate');
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  assert.match(w.calls[1].at(-1)!.content, /knowledge 是思考时的查询/);
  assert.match(w.calls[1].at(-1)!.content, /查询不代表已经使用床或学会了操作/);
  assert.deepEqual(w.planner.stats.tiers, { light: 1, full: 1, escalated: 1 });
  assert.deepEqual(w.adapter.actions, []);
});

test('knowledge and existing queries share the three-query budget', async (t) => {
  const w = fixture(t, [{ kind: 'knowledge', query: '床' }, { kind: 'moves', names: ['use_item'] },
    { kind: 'knowledge', id: 'fixture-topic', section: 'effects' }, { kind: 'knowledge', query: '再查一次' }, decision]);
  const result = await w.think();
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  assert.equal(w.calls.length, 5);
  assert.match(w.calls[2].at(-1)!.content, /use_item/);
  assert.match(w.calls[4].at(-1)!.content, /查询次数用完了/);
  assert.equal(w.bus.recent().filter((e) => e.type === 'knowledge_query').length, 2);
});

test('knowledge reading obeys one cumulative byte budget, reports pagination or exhaustion and resets for the next thought', async (t) => {
  const read = { kind: 'knowledge', id: 'fixture-topic', section: 'conditions' };
  const w = fixture(t, [read, read, read, decision, read, decision], 'deliberate', `## conditions | 条件\n${'知识预算测试的完整中文正文。'.repeat(1000)}`);
  const queried = t.mock.method(w.knowledge, 'query');
  await w.think();
  const prefix = '查询结果（只读，不是现场事实）：';
  const results = w.calls[3].filter((message) => message.role === 'user' && message.content.startsWith(prefix))
    .map(({ content }) => content.slice(prefix.length, content.lastIndexOf('\n剩余查询')));
  assert.equal(results.length, 3);
  assert.ok(results.reduce((bytes, result) => bytes + Buffer.byteLength(result, 'utf8'), 0) <= 10000);
  assert.ok(results.every((result) => /"action":"read"|知识查询预算已用完|BUDGET_TOO_SMALL/.test(result)));
  const backendCalls = queried.mock.calls.length;
  if (/知识查询预算已用完/.test(results[2])) assert.ok(backendCalls < 3, 'no backend access after knowledge bytes are exhausted');
  else {
    assert.equal(backendCalls, 3);
    assert.match(results[2], /"nextCursor":|BUDGET_TOO_SMALL/);
  }
  await w.think();
  assert.equal(queried.mock.calls.length, backendCalls + 1, 'a new thought gets a fresh knowledge budget');
  assert.match(w.calls[5].at(-1)!.content, /"action":"read"/);
});
