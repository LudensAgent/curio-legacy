import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { parseDecision, Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('continue 与另一段 activity 矛盾时要求澄清，不能自动中断当前动作', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const next = { what: '挖短巷', steps: [{ skill: 'look_around', args: { seconds: 3 } }] };
  const conflicting = parseDecision({ decision: 'continue', activity: next }, adapter, memory, true, '寻找铁矿', ['explore']);
  assert.ok('error' in conflicting);
  assert.match(conflicting.error, /继续当前活.*adjust.*next/);

  const continuing = parseDecision({ decision: 'continue', next }, adapter, memory, true, '寻找铁矿', ['explore']);
  assert.ok(!('error' in continuing));
  assert.equal(continuing.kind, 'continue');
  assert.equal(continuing.next?.what, '挖短巷');

  const adjusting = parseDecision({ decision: 'adjust', activity: next }, adapter, memory, true, '寻找铁矿', ['explore']);
  assert.ok(!('error' in adjusting));
  assert.equal(adjusting.kind, 'adjust');
  assert.equal(adjusting.activity?.what, '挖短巷');

  const idle = parseDecision({ decision: 'continue', activity: next }, adapter, memory, false);
  assert.ok(!('error' in idle));
  assert.equal(idle.kind, 'new');
  assert.equal(idle.activity?.what, '挖短巷');
  memory.close();
});

test('continue 带 activity 时一律要求澄清，包括同名同技能只改了参数；纯独白 continue 仍有效', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  try {
    const changedArgs = parseDecision({ decision: 'continue', activity: {
      what: '寻找铁矿', steps: [{ skill: 'look_around', args: { seconds: 9 } }],
    } }, adapter, memory, true, '寻找铁矿', ['look_around']);
    assert.ok('error' in changedArgs);
    assert.match(changedArgs.error, /continue.*adjust.*next/);
    assert.match(changedArgs.error, /同名|改了参数/);

    const adjusting = parseDecision({ decision: 'adjust', activity: {
      what: '寻找铁矿', steps: [{ skill: 'look_around', args: { seconds: 9 } }],
    } }, adapter, memory, true, '寻找铁矿', ['look_around']);
    assert.ok(!('error' in adjusting));
    assert.equal(adjusting.kind, 'adjust');

    // 只写独白的 continue 没有可执行的 activity，仍是合法的继续：无法可靠从文字推断它想改策略。
    const pure = parseDecision({ decision: 'continue', monologue: '继续按原计划' }, adapter, memory, true, '寻找铁矿', ['look_around']);
    assert.ok(!('error' in pure));
    assert.equal(pure.kind, 'continue');
    assert.equal(pure.activity, undefined);
  } finally {
    memory.close();
  }
});

test('真实 Thinker 对矛盾回复要求重答，当前动作继续并可排队下一段', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (value: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'continue-test', complete: (messages) =>
    new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const previous = SKILLS.mind_continue_test;
  let cancelled = false;
  SKILLS.mind_continue_test = { name: 'mind_continue_test', description: '测试用动作', argsDoc: '{}', timeoutMs: 60000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: (ctx) => new Promise<SkillResult>((_, reject) => {
      ctx.signal.addEventListener('abort', () => { cancelled = true; reject(new AbortedError('cancelled')); }, { once: true });
    }) };
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '测试', thinker: new Thinker(planner, adapter, memory, bus, null) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); if (previous) SKILLS.mind_continue_test = previous; else delete SKILLS.mind_continue_test; });
  const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 1 }); await flush(); };
  mind.tick(); await flush();
  await reply(0, { decision: 'new', activity: { what: '寻找铁矿', steps: [{ skill: 'mind_continue_test', args: {} }] } });
  const current = arbiter.info();
  assert.equal(current?.skill, 'mind_continue_test');
  const running = Reflect.get(arbiter, 'current') as { startedAt: number };
  running.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  mind.tick(); await flush();
  const next = { what: '挖短巷', steps: [{ skill: 'look_around', args: { seconds: 3 } }] };
  await reply(1, { decision: 'continue', activity: next });
  assert.equal(pending.length, 3, '矛盾的决定需要模型重答');
  assert.match(pending[2].messages.at(-1)!.content, /decision=continue.*adjust.*next/);
  assert.equal(cancelled, false);
  assert.equal(arbiter.info()?.id, current?.id);
  await reply(2, { decision: 'continue', next });
  assert.equal(cancelled, false);
  assert.equal(arbiter.info()?.id, current?.id);
  assert.equal(mind.queuedNext?.draft.what, '挖短巷');
});
