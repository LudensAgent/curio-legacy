import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { EntityInfo } from '../src/adapter/types.ts';
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
import { SKILLS } from '../src/skills/index.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: TestContext, skill: 'press_keys' | 'swim_path') {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'test-model', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const self = new SelfModel(null, []);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '', thinker: new Thinker(planner, adapter, memory, bus, null), say() {} });
  const original = SKILLS[skill];
  SKILLS[skill] = { ...original, run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => reject(new AbortedError('cancelled')), { once: true });
  }) };
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); SKILLS[skill] = original; });
  return { adapter, arbiter, bus, mind, pending };
}

async function startWaterTask(t: TestContext, skill: 'press_keys' | 'swim_path') {
  const w = fixture(t, skill);
  const events: { type: string; msg: string }[] = [];
  w.bus.on('event', (e: { type: string; msg: string }) => events.push(e));
  w.adapter.inWater = true;
  const hostile: EntityInfo = { id: 7, name: 'drowned', kind: 'hostile', pos: { x: w.adapter.pos.x + 1, y: w.adapter.pos.y, z: w.adapter.pos.z }, dist: 1 };
  w.adapter.entities = [hostile];
  w.mind.tick();
  const started = w.arbiter.start({ skill, args: skill === 'press_keys' ? { keys: { jump: true }, ms: 10000 } : { mode: 'surface' } }, 'llm');
  if ('error' in started) assert.fail(started.error);
  await flush();
  return { ...w, events };
}

for (const skill of ['press_keys', 'swim_path'] as const) test(`hurt while in water does not cancel ${skill}`, async (t) => {
  const w = await startWaterTask(t, skill);
  w.bus.publish('hurt', 'P1', '受到伤害', { around: '身体碰着 water、drowned 在 1 格' });
  await sleep(850);
  assert.equal(w.arbiter.info()?.skill, skill, '人在水里时，挨打不能取消出水/换气动作');
  assert.ok(w.events.some((e) => e.type === 'notice' && /动作没停/.test(e.msg)), '仍应把挨打事实告诉心智');
});

test('hurt on dry land still stops unrelated work', async (t) => {
  const w = await startWaterTask(t, 'press_keys');
  w.adapter.inWater = false;
  w.bus.publish('hurt', 'P1', '受到伤害', { around: 'drowned 在 1 格' });
  await sleep(850);
  assert.notEqual(w.arbiter.info()?.skill, 'press_keys', '陆地上挨打仍应停下手上的事');
  assert.ok(w.events.some((e) => e.type === 'notice' && /手上的事先停了/.test(e.msg)));
});
