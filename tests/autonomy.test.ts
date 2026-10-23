import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion, LlmProvider } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { buildMessages, promptCost, systemPrompt } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); };
const reply = (decision: object, extra: object = {}): Completion => ({ latencyMs: 1, text: JSON.stringify({
  goal: '观察石材取样', steps: [{ skill: 'test_sample', args: {} }], decision, ...extra,
}) });
const begin = { kind: 'begin', reason: '看见河边石材，想试试这种纹理', intent: { text: '研究河边石材', whyNow: '发现新岩层' } };

function fixture(complete: LlmProvider['complete']) {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const bus = new EventBus();
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'autonomous-test', complete }, adapter, memory, bus, null);
  let learned = 0;
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner, onLearnSkill: () => learned++ });
  SKILLS.test_sample = { name: 'test_sample', description: '测试取样', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => { adapter.inv.set('cobblestone', (adapter.inv.get('cobblestone') ?? 0) + 4); return ok('取到部分样本'); } };
  executive.start(1000000);
  return { adapter, memory, bus, arbiter, perception, planner, executive, learned: () => learned,
    stop() { executive.stop(); arbiter.cancel('test end'); memory.close(); delete SKILLS.test_sample; } };
}

test('a model-chosen interest survives short plans and partial skill success never completes its physical project', async () => {
  let calls = 0;
  const w = fixture(async () => calls++ === 0 ? reply({ ...begin, project: { title: '石材取样', successCondition: { type: 'inventory_min', item: 'cobblestone', count: 16 } } })
    : reply({ kind: 'continue', reason: '还想比较刚取到的石样' }));
  try {
    w.executive.tick(); await flush(); w.executive.tick(); await flush();
    const id = w.memory.currentIntent()!.id;
    assert.equal(w.adapter.inv.get('cobblestone'), 4);
    assert.equal(w.memory.activeProject()?.status, 'active');
    assert.equal(w.memory.activeProject()?.noProgressAttempts, 0);
    w.executive.tick(); await flush(); w.executive.tick(); await flush();
    assert.equal(w.memory.currentIntent()!.id, id);
    assert.equal(w.memory.decisions().at(-1)?.kind, 'continue');
    assert.equal(w.adapter.inv.get('cobblestone'), 8);
    assert.equal(w.memory.projects()[0].status, 'active');
  } finally { w.stop(); }
});

test('pause rejects a late success before notes, preferences, lessons, skill learning or actions; resume makes a fresh choice', async () => {
  let resolve!: (value: Completion) => void;
  const w = fixture(() => new Promise((r) => { resolve = r; }));
  try {
    w.executive.tick(); await flush();
    w.executive.pause();
    resolve(reply({ ...begin, preferences: [{ text: '石头', source: 'inferred', adjustmentReason: '测试' }] }, { memory_note: '迟到笔记', lesson: '迟到教训', learn_skill: { name: 'late' } }));
    await flush(); w.executive.tick();
    const reflex = new Reflex(w.adapter, w.arbiter, w.bus, new Vision(w.adapter));
    w.adapter.inLava = true; reflex.tick();
    assert.equal(w.arbiter.info(), null);
    assert.equal(w.memory.intents().length, 0);
    assert.equal(w.memory.preferences().length, 0);
    assert.equal(w.memory.recentNotes().length, 0);
    assert.equal(w.memory.lessons().length, 0);
    assert.equal(w.learned(), 0);
    assert.equal(w.adapter.inv.size, 0);
    w.executive.resume(); w.adapter.inLava = false;
    w.executive.tick(); await flush(); resolve(reply(begin)); await flush(); w.executive.tick(); await flush();
    assert.equal(w.adapter.inv.get('cobblestone'), 4);
  } finally { w.stop(); }
});

test('late failures after manual replan cannot trigger a rule fallback or suspend the replacement request', async () => {
  const pending: { resolve: (v: Completion) => void; reject: (e: Error) => void }[] = [];
  const w = fixture(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  try {
    w.executive.tick(); await flush();
    w.executive.replan(); await flush();
    assert.equal(pending.length, 2);
    pending[0].reject(new Error('stale offline')); await flush();
    assert.equal(w.executive.inFlight, true);
    pending[1].resolve(reply(begin)); await flush(); w.executive.tick(); await flush();
    assert.equal(w.memory.currentIntent()?.text, '研究河边石材');
    assert.equal(w.bus.recent().filter((e) => e.type === 'task_start' && e.msg.startsWith('[rule]')).length, 0);
    assert.equal(w.executive.snapshot().backoffMs, 0);
  } finally { w.stop(); }
});

test('model unavailable preserves the interest and waits with no unrelated gameplay', async () => {
  const w = fixture(async () => { throw new Error('offline'); });
  try {
    const intent = w.memory.addIntent({ text: '继续种田', whyNow: '喜欢这片田', context: [], tradeoffs: [], status: 'active', source: 'model' });
    w.executive.tick(); await flush(); w.executive.tick();
    assert.equal(w.memory.currentIntent()?.id, intent.id);
    assert.equal(w.arbiter.info(), null);
    assert.equal(w.memory.recentGoals().length, 0);
    assert.ok(w.executive.snapshot().backoffMs > 0);
    assert.ok(w.bus.recent().some((e) => e.type === 'llm_error' && e.msg.includes('保留意图')));
  } finally { w.stop(); }
});

test('voluntary deferral records the reason and performs no filler action', async () => {
  const w = fixture(async () => reply({ kind: 'defer', reason: '先欣赏眼前的风景，施工留到之后' }, { steps: [] }));
  try {
    w.memory.addIntent({ text: '装修', whyNow: '试试新风格', context: [], tradeoffs: [], status: 'active', source: 'model' });
    w.executive.tick(); await flush(); w.executive.tick(); await flush();
    assert.equal(w.memory.intents()[0].status, 'deferred');
    assert.equal(w.memory.decisions()[0].kind, 'defer');
    assert.equal(w.arbiter.info(), null);
  } finally { w.stop(); }
});

test('prompt keeps choice autonomy and enforces a whole serialized budget as history grows', () => {
  const w = fixture(async () => reply(begin));
  try {
    for (let i = 0; i < 100; i++) w.memory.recordGoal({ goal: '旧事'.repeat(30), summary: '历史'.repeat(100), goalType: 'explore', source: 'llm', status: 'failed' });
    const messages = buildMessages('Curio', { reason: 'no_goal', percept: w.perception.update(), current: null, lastFailure: null, userSuggestion: null, worldState: w.adapter.state(),
      memoryContext: { source: 'local', query: '旧事', memories: Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: '历史'.repeat(100), source: 'execution' })) } }, w.memory, 100, 30000);
    assert.ok(promptCost(messages) <= 30000);
    assert.match(systemPrompt('Curio'), /没有必须遵循的科技树/);
    assert.doesNotMatch(systemPrompt('Curio'), /家里安顿好.*就 expedition/);
  } finally { w.stop(); }
});
