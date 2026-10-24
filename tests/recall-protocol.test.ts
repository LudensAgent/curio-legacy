import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { OpenAICompatibleProvider } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('mechanics inquiry upgrades routine continuation to deliberate reasoning without executing actions or changing intent', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const percept = new Perception(adapter, memory, bus, new Vision(adapter)).update();
  const intent = memory.addIntent({ text: '研究眼前环境', whyNow: '有未知机制', context: [], tradeoffs: [], source: 'model', status: 'active' });
  const tiers: unknown[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 20, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'mechanics-protocol-stub', async complete(messages, _signal, ctx) {
    tiers.push((ctx as any).tier);
    if (tiers.length === 1) return { latencyMs: 1, text: JSON.stringify({ kind: 'mechanics', query: '右键 放置' }) };
    assert.match(messages.at(-1)!.content, /registered_skills/);
    assert.match(messages.at(-1)!.content, /parameters/);
    assert.match(messages.at(-1)!.content, /experiment_method/);
    return { latencyMs: 1, text: JSON.stringify({ goal: '先核对可见线索', steps: [{ skill: 'look_around', args: { seconds: 2 } }] }) };
  } }, adapter, memory, bus, null);
  const plan = await planner.propose({ reason: 'no_goal', tier: 'light', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state() });
  assert.deepEqual(tiers, ['light', 'full']);
  assert.equal(plan.steps[0].skill, 'look_around');
  assert.equal(planner.stats.calls, 2);
  assert.equal(planner.stats.tiers.escalated, 1);
  assert.deepEqual(adapter.actions, []);
  assert.equal(memory.currentIntent()?.id, intent.id, 'knowledge retrieval leaves the actual interest to the model');
});

test('a new experiment proposed in light mode is reconsidered with full facts before any action runs', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const percept = new Perception(adapter, memory, bus, new Vision(adapter)).update(), tiers: unknown[] = [];
  const planner = new Planner({ ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 20, maxPromptTokens: 40000 } }, {
    name: 'experiment-deliberation-stub', async complete(messages, _signal, ctx) {
      tiers.push((ctx as any).tier);
      if (tiers.length === 1) return { latencyMs: 1, text: JSON.stringify({ goal: '尝试一种组合', steps: [{ skill: 'experiment_method', args: { name: 'unreviewed_idea' } }] }) };
      assert.match(messages.at(-1)!.content, /尚未执行/);
      return { latencyMs: 1, text: JSON.stringify({ goal: '先取得缺失的观察', steps: [{ skill: 'look_around', args: { seconds: 2 } }] }) };
    },
  }, adapter, memory, bus, null);
  const plan = await planner.propose({ reason: 'no_goal', tier: 'light', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state() });
  assert.deepEqual(tiers, ['light', 'full']);
  assert.equal(plan.steps[0].skill, 'look_around');
  assert.deepEqual(adapter.actions, []);
  assert.equal(memory.intents().length, 0);
});

test('read-only recall can search then read the returned ID, counts every model call, and never mutates intent before activation', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const percept = new Perception(adapter, memory, bus, new Vision(adapter)).update();
  const outputs = [ { kind: 'recall', query: '旧河岸经历' }, { kind: 'recall', ids: ['old-river'] },
    { goal: '观察河岸', steps: [{ skill: 'look_around', args: { seconds: 2 } }], decision: { kind: 'begin', reason: '想重新看看以前的河岸', intent: { text: '观察河岸', whyNow: '回想起相关经历' } } } ];
  let modelCalls = 0, memoryCalls = 0;
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 10, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'real-protocol-fixture', async complete(messages) {
    if (modelCalls === 2) assert.match(messages.at(-1)!.content, /old-river/);
    return { latencyMs: 1, text: JSON.stringify(outputs[modelCalls++]), usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } }, adapter, memory, bus, null, null, { async recall(_context, query) {
    memoryCalls++;
    return { source: 'local', query: query ?? '', memories: query ? [{ id: 'old-river', text: '以前河边涉水受困，仍想看看景色', source: 'historical event' }] : [] };
  } });
  const plan = await planner.propose({ reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state() });
  assert.equal(plan.decision?.kind, 'begin');
  assert.equal(modelCalls, 3); assert.equal(memoryCalls, 1);
  assert.equal(planner.stats.tokenUsage.totalTokens, 6);
  assert.equal(memory.intents().length, 0);
  assert.equal(memory.decisions().length, 0);
  memory.close();
});

test('optional visual messages use standard image_url parts without changing text-only request format', async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
  });
  const provider = new OpenAICompatibleProvider({ ...config.llm, apiKey: '', stream: false, fakeDelayMs: 0 });
  await provider.complete([{ role: 'user', content: '比较实际轮廓', images: [{ url: 'data:image/png;base64,eA==', detail: 'low' }] }], new AbortController().signal);
  assert.deepEqual(bodies[0].messages[0].content, [{ type: 'text', text: '比较实际轮廓' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==', detail: 'low' } }]);
  await provider.complete([{ role: 'user', content: '普通观察' }], new AbortController().signal);
  assert.equal(bodies[1].messages[0].content, '普通观察');
});
