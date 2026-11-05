import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };

function fixture(t: TestContext) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'lowair-test-model', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null, []), persona: '', thinker: new Thinker(planner, adapter, memory, bus, null), say() {} });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); });
  const tick = async () => { mind.tick(); await flush(); };
  return { adapter, bus, mind, pending, tick };
}

const requests = (bus: EventBus) => bus.recent().filter((e) => e.type === 'llm_request');

test('low on air underwater, a would-be deliberate thought is sent as a glance', async (t) => {
  const w = fixture(t);
  w.adapter.inWater = true;
  w.adapter.oxygen = 8;
  await w.tick();
  assert.equal(w.pending.length, 1);
  assert.equal(requests(w.bus).at(-1)?.data?.tier, 'glance');
});

test('a deliberate thought queued after an activity ends underwater is downgraded too', async (t) => {
  const w = fixture(t);
  w.adapter.inWater = true;
  w.adapter.oxygen = 6;
  (w.mind as any).requestThink('上一段活结束了，接下来做什么', 'deliberate');
  await w.tick();
  const request = requests(w.bus).at(-1);
  assert.equal(request?.data?.tier, 'glance');
  assert.match(request?.msg ?? '', /上一段活结束了/);
});

test('the downgrade is gated on actually being underwater with low oxygen', async (t) => {
  const dry = fixture(t);
  dry.adapter.oxygen = 8;
  await dry.tick();
  assert.equal(requests(dry.bus).at(-1)?.data?.tier, 'deliberate');

  const air = fixture(t);
  air.adapter.inWater = true;
  air.adapter.oxygen = 20;
  await air.tick();
  assert.equal(requests(air.bus).at(-1)?.data?.tier, 'deliberate');
});

test('an urgent notice does not restart the low-air glance on every tick', async (t) => {
  const w = fixture(t);
  w.adapter.inWater = true;
  w.adapter.oxygen = 8;
  await w.tick();
  w.mind.attention.notice('test_urgent', '有紧急情况需要处理', 1, 0);
  await w.tick();
  await w.tick();
  assert.equal(w.pending.length, 1, '仍应等同一个瞥一眼的回答，而不是每拍撤掉重发');
  assert.equal(requests(w.bus).length, 1);
  assert.equal(requests(w.bus).at(-1)?.data?.tier, 'glance');
});
