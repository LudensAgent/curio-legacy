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
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, type SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };

function fixture(t: TestContext, rescue: 'swim_path' | 'flee') {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'test-model', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const self = new SelfModel(null, []);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '', thinker: new Thinker(planner, adapter, memory, bus, null), say() {} });
  const original = SKILLS[rescue], oldStep = SKILLS.surface_wait_step;
  let finishRescue: (result: SkillResult) => void = () => {};
  SKILLS[rescue] = { ...original, run: async (ctx) => new Promise<SkillResult>((resolve, reject) => {
    finishRescue = resolve;
    ctx.signal.addEventListener('abort', () => reject(new AbortedError('cancelled')), { once: true });
  }) };
  SKILLS.surface_wait_step = { name: 'surface_wait_step', description: 'test step', argsDoc: '{}', timeoutMs: 60000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new AbortedError('cancelled')), { once: true });
    }) };
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); SKILLS[rescue] = original; if (oldStep) SKILLS.surface_wait_step = oldStep; else delete SKILLS.surface_wait_step; });
  const tick = async () => { mind.tick(); await flush(); };
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 10 }); await flush(); };
  return { adapter, arbiter, mind, pending, tick, reply, finishRescue: (r: SkillResult) => finishRescue(r) };
}

for (const outcome of ['failed', 'afloat', 'landed', 'cancelled', 'other-reflex'] as const) test(`plan formed during rescue: ${outcome}`, async (t) => {
  const w = fixture(t, outcome === 'other-reflex' ? 'flee' : 'swim_path');
  w.adapter.inWater = true;
  await w.tick();
  assert.equal(w.pending.length, 1);
  w.arbiter.start({ skill: outcome === 'other-reflex' ? 'flee' : 'swim_path', args: {} }, 'reflex');
  await w.reply(0, { decision: 'new', activity: { what: '挖开头顶', steps: [{ skill: 'surface_wait_step' }] } });
  assert.equal(w.mind.activity?.what, '挖开头顶');
  if (outcome === 'cancelled') w.arbiter.cancel('取消');
  else {
    if (outcome === 'landed') w.adapter.inWater = false;
    if (outcome === 'failed' || outcome === 'afloat') w.adapter.pos = { ...w.adapter.pos, x: w.adapter.pos.x + 1 };
    w.finishRescue(outcome === 'failed' ? fail('STUCK', '水中未上岸') : ok(outcome === 'landed' ? '已上岸' : '仍在水中', { landed: outcome === 'landed' }));
  }
  await flush();
  await w.tick();
  if (outcome === 'cancelled' || outcome === 'other-reflex') {
    assert.equal(w.arbiter.info()?.skill, 'surface_wait_step');
  } else {
    assert.notEqual(w.arbiter.info()?.skill, 'surface_wait_step');
    assert.equal(w.pending.length, 2);
    assert.match(JSON.stringify(w.pending[1].messages), outcome === 'landed' ? /已上岸/ : /水中/);
    await w.reply(1, { decision: 'continue', monologue: '继续刚才的活动' });
    await w.tick();
    assert.equal(w.arbiter.info()?.skill, 'surface_wait_step');
  }
});

for (const finishBeforeReply of [false, true]) test(`reflex moves before a pending decision returns: finished=${finishBeforeReply}`, async (t) => {
  const w = fixture(t, 'flee');
  await w.tick();
  w.arbiter.start({ skill: 'flee', args: {} }, 'reflex');
  w.adapter.pos = { ...w.adapter.pos, x: w.adapter.pos.x + 3 };
  if (finishBeforeReply) { w.finishRescue(ok('已后撤三格')); await flush(); }
  await w.reply(0, { decision: 'new', activity: { what: '在原处挖矿', steps: [{ skill: 'surface_wait_step' }] } });
  if (!finishBeforeReply) { w.finishRescue(ok('已后撤三格')); await flush(); }
  await w.tick();
  assert.notEqual(w.arbiter.info()?.skill, 'surface_wait_step');
  assert.equal(w.pending.length, 2);
  assert.match(JSON.stringify(w.pending[1].messages), /后撤三格/);
  await w.reply(1, { decision: 'continue' });
  await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'surface_wait_step');
});

test('an interrupted reflex which moved still requires reviewing the pending plan', async (t) => {
  const w = fixture(t, 'flee');
  await w.tick();
  w.arbiter.start({ skill: 'flee', args: {} }, 'reflex');
  await w.reply(0, { decision: 'new', activity: { what: '挖矿', steps: [{ skill: 'surface_wait_step' }] } });
  w.adapter.pos = { ...w.adapter.pos, z: w.adapter.pos.z + 1 };
  w.arbiter.cancel('中断反射');
  await flush();
  await w.tick();
  assert.notEqual(w.arbiter.info()?.skill, 'surface_wait_step');
  assert.equal(w.pending.length, 2);
  assert.match(JSON.stringify(w.pending[1].messages), /中断反射/);
});

test('oxygen rising across the drowning threshold prompts review without suppressing the reflex', async (t) => {
  const w = fixture(t, 'swim_path');
  w.adapter.inWater = true; w.adapter.oxygen = 14;
  await w.tick();
  w.arbiter.start({ skill: 'swim_path', args: { mode: 'surface' } }, 'reflex');
  await w.reply(0, { decision: 'new', activity: { what: '处理水下障碍', steps: [{ skill: 'surface_wait_step' }] } });
  assert.equal(w.arbiter.info()?.skill, 'swim_path');
  w.adapter.oxygen = 20;
  w.finishRescue(ok('氧气恢复，仍在水中'));
  await flush();
  await w.tick();
  assert.notEqual(w.arbiter.info()?.skill, 'surface_wait_step');
  assert.match(JSON.stringify(w.pending.at(-1)?.messages), /氧气恢复/);
});

test('damage during a non-swim_path reflex prompts review of a waiting plan', async (t) => {
  const w = fixture(t, 'flee');
  await w.tick();
  w.arbiter.start({ skill: 'flee', args: {} }, 'reflex');
  await w.reply(0, { decision: 'new', activity: { what: '继续挖矿', steps: [{ skill: 'surface_wait_step' }] } });
  w.adapter.hp -= 4;
  w.finishRescue(ok('受伤后撤离'));
  await flush();
  await w.tick();
  assert.notEqual(w.arbiter.info()?.skill, 'surface_wait_step');
  assert.match(JSON.stringify(w.pending.at(-1)?.messages), /受伤后撤离/);
});
