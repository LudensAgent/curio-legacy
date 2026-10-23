import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ActionChat } from '../src/observer/action-chat.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };
const thought = '河岸的纹理让我有点好奇';
const reply = (): Completion => ({ latencyMs: 1, text: JSON.stringify({
  thought, goal: '执行取样计划', say: '先取样，再整理背包',
  decision: { kind: 'begin', reason: '发现了河岸的新纹理', intent: { text: '比较河岸纹理', whyNow: '眼前出现新岩层' } },
  steps: [{ skill: 'thought_chat_probe' }],
}) });

function fixture(t: TestContext) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const captions: string[] = [], pending: ((value: Completion) => void)[] = [];
  t.mock.method(adapter, 'chat', (text: string) => captions.push(text));
  const previousSkill = SKILLS.thought_chat_probe;
  SKILLS.thought_chat_probe = { name: 'thought_chat_probe', description: '测试取样步骤', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => ok('取样步骤结束') };
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'thought-chat-model', complete: () => new Promise((resolve) => pending.push(resolve)) }, adapter, memory, bus, null);
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner });
  const chat = new ActionChat(adapter, bus, { enabled: true, canSend: () => !executive.paused });
  chat.start(); executive.start(1_000_000);
  t.after(() => {
    chat.stop(); executive.stop(); arbiter.cancel('test end'); memory.close();
    if (previousSkill) SKILLS.thought_chat_probe = previousSkill;
    else delete SKILLS.thought_chat_probe;
  });
  const tick = async () => { executive.tick(); await flush(); };
  return { bus, captions, pending, executive, chat, tick };
}

test('only an activated model choice sends its thought through the plan event to game chat', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.pending.length, 1);
  w.pending[0](reply()); await flush();
  assert.equal(w.executive.queued?.thought, thought);
  assert.equal(w.bus.recent().some((event) => event.type === 'plan'), false);
  assert.deepEqual(w.captions, [], 'a queued choice and background observation must not narrate actions');

  await w.tick();
  const planEvent = w.bus.recent().find((event) => event.type === 'plan');
  assert.equal(planEvent?.data?.thought, thought);
  assert.equal(planEvent?.data?.source, 'llm');
  assert.deepEqual(w.captions, [`[想法] ${thought}`], 'goal, steps, task results and legacy say must stay out of automatic chat');
});

test('a model response arriving after pause cannot publish or queue a thought for later chat', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.pending.length, 1);
  w.executive.pause();
  w.pending[0](reply()); await flush();
  await w.tick(); w.chat.flush();
  assert.equal(w.executive.queued, null);
  assert.equal(w.executive.plan, null);
  assert.equal(w.bus.recent().some((event) => event.type === 'plan'), false);
  assert.deepEqual(w.captions, []);
});
