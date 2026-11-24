import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import type { MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('收起技能的版本、证据和仅有代码的历史可只读查询，不能因此启用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-history-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const book = new SkillBook(null, dir);
  const body = '先观察目标，再按自己选择的动作试验并确认实际结果。';
  assert.ok(book.write('test-descent', '测试逐级下降的历史做法', body, { code: 'return "version one";' }, { version: 1 }).ok);
  assert.ok(book.write('test-descent', '测试逐级下降的历史做法', body, { code: 'return "version two";' }, { version: 2 }).ok);
  fs.writeFileSync(path.join(dir, 'test-descent', 'versions', 'v3.js'), 'return "code only";');
  const statsPath = path.join(dir, 'stats.json');
  fs.writeFileSync(statsPath, JSON.stringify({ 'test-descent': { fired: 3, ok: 1, fail: 2, lastAt: 1, disabled: true, retired: '当前版本不可靠',
    byVersion: { 1: { ok: 1, fail: 0 }, 2: { ok: 0, fail: 2 } }, recent: [{ at: 1, ok: true, version: 1, summary: '下降 12 格但未到目标' }] } }));
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, statsPath);
  const calls: ChatMessage[][] = [];
  const replies = [{ kind: 'skill', query: 'test-descent' }, { kind: 'skill', name: 'test-descent', version: 1 },
    { kind: 'skill', name: 'test-descent', version: 3 },
    { decision: 'new', activity: { what: '观察身边', steps: [{ skill: 'look_around', args: { seconds: 1 } }] } }];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000 } };
  const planner = new Planner(cfg, { name: 'skill-history-test', complete: async (messages) => {
    calls.push(structuredClone(messages));
    return { text: JSON.stringify(replies[calls.length - 1]), latencyMs: 1 };
  } }, adapter, memory, bus, null);
  const thinker = new Thinker(planner, adapter, memory, bus, book);
  thinker.skillStats = (name) => engine.statsOf(name);
  const ctx: MindContext = { tier: 'deliberate', reason: '阅读旧技能', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: '你是 Curio。' };
  const before = structuredClone(engine.statsOf('test-descent'));
  const result = await thinker.think(ctx, new AbortController().signal);
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  assert.match(calls[1].at(-1)!.content, /当前版本不可靠/);
  assert.match(calls[1].at(-1)!.content, /"disabled":true/);
  assert.match(calls[2].at(-1)!.content, /"version":1,"definition":true,"code":true/);
  assert.match(calls[2].at(-1)!.content, /version one/);
  assert.match(calls[2].at(-1)!.content, /下降 12 格但未到目标/);
  assert.match(calls[3].at(-1)!.content, /仅保存了历史代码，没有完整执行契约/);
  assert.match(calls[3].at(-1)!.content, /code only/);
  assert.deepEqual(engine.statsOf('test-descent'), before);
  assert.equal(engine.inactive('test-descent'), true);
  assert.deepEqual(adapter.actions, []);
  engine.dispose();
  memory.close();
});
