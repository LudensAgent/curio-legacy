import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok, type Senses, type Skill } from '../src/skills/types.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-caller-credit-'));
const noSenses: Senses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

const outcome = (id: string, name: string, version = 1): TaskOutcome => ({
  task: { id, planVersion: 1, skill: 'use_skill', args: { name }, source: 'llm', startedAt: Date.now(), deadline: Date.now() + 1000,
    progress: 0, note: '', movement: true, planId: 'p1' },
  result: { status: 'succeeded', summary: `照技能「${name}」做完了`, data: { version, verified: true } },
  durationMs: 10,
});

/** 测试用动作：一次真实（非只读、非空转）的步骤，让 use_skill 不算 noop。 */
function installStepAction(t: TestContext) {
  const prev = SKILLS.t_shore_step;
  SKILLS.t_shore_step = { name: 't_shore_step', description: 'test', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => ok('踩上干地') } as Skill;
  t.after(() => { if (prev) SKILLS.t_shore_step = prev; else delete SKILLS.t_shore_step; setBehaviorRegistry(null); });
}

test('调用方收工条件未满足：只把同一任务刚记的成功降级，不误伤别的运行或别的技能', (t) => {
  const adapter = new FakeAdapter();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, new EventBus(), noSenses);
  t.after(() => engine.dispose());
  const written = engine.write({ name: 'shore-climb', description: '从水里爬上干地',
    code: 'return "up";', verify: 'const s = await api.state(); return !s.inWater && s.onGround ? true : "没有站稳";' });
  assert.ok(written.ok, JSON.stringify(written));

  // 技能自述做完、verify 通过：先按现有规则记一次成功。
  (engine as any).onDone(outcome('task-1', 'shore-climb'));
  const st = engine.statsOf('shore-climb')!;
  const dim = adapter.state().dim;
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 0 });
  assert.deepEqual(st.byVersion?.['1'], { ok: 1, fail: 0 });
  assert.deepEqual(st.byDim?.[dim], { ok: 1, fail: 0 });

  // taskId 不一致：不能降级。
  assert.equal(engine.callerUnmet('shore-climb', 'task-other', '调用方收工条件未满足'), false);
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 0 });

  // 同名但另一个任务的最近一次成功存在时，旧任务的 id 也对不上：不降级。
  (engine as any).onDone(outcome('task-2', 'shore-climb'));
  assert.equal(engine.callerUnmet('shore-climb', 'task-1', '调用方收工条件未满足'), false, '只认最近一次记账的任务');
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 2, fail: 0 });

  // 同一任务、同一技能：把刚记的成功改成一次失败。
  const why = '调用方收工条件未满足：实际 {"field":"inWater","value":false,"onGround":false}；条件 {"type":"self_state","field":"inWater","equals":false}';
  assert.equal(engine.callerUnmet('shore-climb', 'task-2', why), true);
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 1 });
  assert.deepEqual(st.byVersion?.['1'], { ok: 1, fail: 1 });
  assert.deepEqual(st.byDim?.[dim], { ok: 1, fail: 1 });
  assert.match(st.lastError ?? '', /"onGround":false/);
  const last = st.recent?.at(-1);
  assert.equal(last?.ok, false);
  assert.equal(last?.callerUnmet, true);
  assert.match(last?.summary ?? '', /调用方收工条件未满足/);

  // 已经降级过的任务不能再降一次。
  assert.equal(engine.callerUnmet('shore-climb', 'task-2', '再来一次'), false);
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 1 });

  // 别的技能名字对不上：不动账。
  assert.equal(engine.callerUnmet('other-skill', 'task-2', '调用方收工条件未满足'), false);
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 1 });

  // 失败不会被“降级”成又一次失败。
  (engine as any).onDone({ ...outcome('task-3', 'shore-climb'), result: { status: 'failed', failureCode: 'ERROR', summary: '没成', data: { version: 1, verified: false } } });
  assert.equal(engine.callerUnmet('shore-climb', 'task-3', '调用方收工条件未满足'), false);
  assert.deepEqual({ ok: st.ok, fail: st.fail }, { ok: 1, fail: 2 });
});

test('集成：use_skill 自述做完且 verify 通过，但活动 done_when 明确未满足，不记技能成功', async (t) => {
  installStepAction(t);
  const adapter = new FakeAdapter();
  // 水面浮动的瞬时状态：inWater=false，但没有触地，没真正上岸。
  adapter.inWater = false;
  adapter.onGround = false;
  const memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const book = new SkillBook(null, tmp());
  const behaviors = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(behaviors);
  // 技能自己的判定太弱（只看瞬时 inWater），调用方的 done_when 才是真正的上岸标准。
  const written = behaviors.write({ name: 'shore-climb', description: '从水里爬上干地', steps: [{ skill: 't_shore_step' }],
    verify: 'const s = await api.state(); return s.inWater ? "还在水里" : true;' });
  assert.ok(written.ok, JSON.stringify(written));
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'scripted', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, book), behaviors });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); behaviors.dispose(); arbiter.cancel('end'); memory.close(); });

  const reply = async (body: object) => { pending.at(-1)!.resolve({ text: JSON.stringify(body), latencyMs: 10 }); await flush(); };
  mind.tick(); await flush();
  await reply({ monologue: '先想办法爬上干地', decision: 'new',
    activity: { what: '爬上干地', steps: [{ skill: 'use_skill', args: { name: 'shore-climb' } }],
      done_when: { type: 'self_state', field: 'inWater', equals: false } } });

  for (let i = 0; i < 8; i++) {
    mind.tick();
    const current = arbiter.info();
    if (current?.planId && current.planId === mind.activity?.id) await new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    await flush();
  }

  const st = behaviors.statsOf('shore-climb');
  assert.equal(st?.ok ?? 0, 0, '调用方收工条件未满足，执行完毕不能记成技能成功');
  assert.equal(st?.fail, 1, '这次运行记成一次失败，而不是凭空消失');
  assert.equal(st?.byVersion?.['1']?.ok ?? 0, 0);
  assert.equal(st?.recent?.at(-1)?.callerUnmet, true);
  assert.match(st?.recent?.at(-1)?.summary ?? '', /调用方收工条件未满足/);
});
