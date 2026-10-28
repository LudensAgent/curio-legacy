import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok, type SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };
const step = (n: number) => ({ skill: 'stale_review_step', args: { n } });

for (const kind of ['new', 'continue', 'danger', 'order'] as const) test(`绕路执行中提前规划，返回原活动后不应用旧 ${kind} 决定`, async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'mind-test-model', complete: () => new Promise((resolve) => pending.push({ resolve })) }, adapter, memory, bus, null);
  const finishes: ((r?: SkillResult) => void)[] = [];
  const previous = SKILLS.stale_review_step;
  SKILLS.stale_review_step = { name: 'stale_review_step', description: '测试动作', argsDoc: '{"n":数字}', timeoutMs: 60000, movement: false,
    validate: (raw: any) => ({ ok: true, args: { n: Number(raw?.n ?? 1) } }),
    run: (ctx) => new Promise((resolve, reject) => {
      const done = (r?: SkillResult) => resolve(r ?? ok('完成'));
      finishes.push(done);
      ctx.signal.addEventListener('abort', () => { finishes.splice(finishes.indexOf(done) >>> 0, 1); reject(new AbortedError('cancelled')); }, { once: true });
    }) };
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, null) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); if (previous) SKILLS.stale_review_step = previous; else delete SKILLS.stale_review_step; });
  const tick = async () => { mind.tick(); await flush(); };
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 100 }); await flush(); };
  await tick();
  await reply(0, { decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  const wallId = mind.activity!.id;
  mind.attention.notice('hungry', '饿了', 0.6);
  (mind as any).lastThoughtAt = 0;
  await tick();
  await reply(1, { decision: 'detour', activity: { what: '拿吃的', steps: [step(9)] } });
  await tick();
  (arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await tick();
  assert.equal(pending.length, 3, '绕路活动正在执行时提前规划');
  finishes.shift()!();
  await flush();
  assert.equal(mind.activity?.id, wallId, '绕路结束回到砌墙');
  if (kind === 'danger') mind.attention.notice('danger:test', '眼前有危险', 0.95, 0);
  if (kind === 'order') mind.suggest('!先观察四周');
  await reply(2, kind === 'new'
    ? { decision: 'new', activity: { what: '旧思考的新活动', steps: [step(3)] } }
    : { decision: 'continue', next: { what: '旧思考的下一段', steps: [step(3)] } });
  assert.equal(mind.activity?.id, wallId, '旧思考不能替换已恢复的活动');
  assert.equal(mind.queuedNext, null, '旧思考不能给已恢复的活动排下一段');
  await tick();
  assert.equal(pending.length, 4, '原活动的恢复检查仍被触发');
  assert.equal(mind.activity?.id, wallId);
  if (kind === 'danger') assert.match(bus.recent().filter((e) => e.type === 'llm_request').at(-1)?.msg ?? '', /有危险/);
  if (kind === 'order') assert.match(bus.recent().filter((e) => e.type === 'llm_request').at(-1)?.msg ?? '', /操作者下了指令/);
});
