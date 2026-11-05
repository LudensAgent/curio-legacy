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

/**
 * 让心智带着“从水里爬上干地”的 done_when 执行一次 use_skill。
 * 世界状态是水面浮动的瞬时快照：inWater=false 但 onGround=false，所以活动收工条件明确未满足。
 */
async function runShoreActivity(t: TestContext, stepArgs: Record<string, unknown>) {
  installStepAction(t);
  const adapter = new FakeAdapter();
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
    activity: { what: '爬上干地', steps: [{ skill: 'use_skill', args: stepArgs }],
      done_when: { type: 'self_state', field: 'inWater', equals: false } } });

  for (let i = 0; i < 8; i++) {
    mind.tick();
    const current = arbiter.info();
    if (current?.planId && current.planId === mind.activity?.id) await new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    await flush();
  }
  return behaviors.statsOf('shore-climb');
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
  const st = await runShoreActivity(t, { name: 'shore-climb' });
  assert.equal(st?.ok ?? 0, 0, '调用方收工条件未满足，执行完毕不能记成技能成功');
  assert.equal(st?.fail, 1, '这次运行记成一次失败，而不是凭空消失');
  assert.equal(st?.byVersion?.['1']?.ok ?? 0, 0);
  assert.equal(st?.recent?.at(-1)?.callerUnmet, true);
  assert.match(st?.recent?.at(-1)?.summary ?? '', /调用方收工条件未满足/);
});

test('集成：恢复类 use_skill（args.failure）的成败由 creditRecovery 管，调用方未达成也不改判', async (t) => {
  const st = await runShoreActivity(t, { name: 'shore-climb', failure: { skill: 't_fail', args: {} } });
  assert.equal(st?.ok, 1, '恢复步骤的成功不被调用方收工条件降级');
  assert.equal(st?.fail ?? 0, 0);
  assert.notEqual(st?.recent?.at(-1)?.callerUnmet, true);
});

test('候选第 3 次成功被调用方否决：先降级再判定晋级，不把假成功推成稳定版', async (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  t.after(() => engine.dispose());
  // 候选：只有显式试用才会执行，攒够 MIN_EVIDENCE 次实际成功才晋级。
  const written = engine.write({ name: 'shore-climb', description: '从水里爬上干地',
    code: 'return "up";', verify: 'const s = await api.state(); return !s.inWater && s.onGround ? true : "没有站稳";' }, { by: 'mind' });
  assert.ok(written.ok && written.candidate, JSON.stringify(written));
  for (let i = 1; i <= BehaviorEngine.MIN_EVIDENCE; i++) {
    (engine as any).onDone(outcome(`trial-${i}`, 'shore-climb'));
    // 心智的 done 监听在行为引擎之后同步运行：最后一次成功被调用方当场否决。
    if (i === BehaviorEngine.MIN_EVIDENCE) {
      assert.equal(engine.callerUnmet('shore-climb', `trial-${i}`, '调用方收工条件未满足：没有真正站稳'), true);
    }
  }
  await flush(); // 让延后的晋级检查跑完
  assert.deepEqual(engine.currentStats('shore-climb', true), { ok: 2, fail: 1 });
  assert.equal(engine.get('shore-climb', true)?.version, 1, '候选还在');
  assert.equal(engine.get('shore-climb')?.candidate, true, '被否决的成功不能把候选推成稳定版');
  assert.ok(!bus.recent().some((event) => event.type === 'skill_promoted'), '没有晋级播报');
});
