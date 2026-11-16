import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, createActivity, nextStep, recordOf, remainingSteps, signatureOf } from '../src/mind/activity.ts';
import { Attention } from '../src/mind/attention.ts';
import { Mind } from '../src/mind/mind.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { buildMindMessages, buildReflectionMessages } from '../src/mind/prompt.ts';
import { DEFAULT_MOOD, feel, moodWords, SelfModel } from '../src/mind/self.ts';
import { embeddedQuery, parseDecision, Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { feetCell } from '../src/perception/local.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { fail, ok, type SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };

function fixture(t: TestContext, opts: { autonomous?: boolean; book?: import('../src/knowledge/skillbook.ts').SkillBook; behaviors?: boolean; reviewClock?: { at: number; gapMs: number } } = {}) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; reject: (e: Error) => void; messages: ChatMessage[]; hint: any }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: (opts.autonomous === false ? 'mock' : 'openai') as 'openai', maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: opts.autonomous === false ? 'mock' : 'mind-test-model', complete: (messages, _signal, hint) =>
    new Promise((resolve, reject) => pending.push({ resolve, reject, messages, hint })) }, adapter, memory, bus, null);
  const self = new SelfModel(null, ['好奇', '谨慎']);
  if (opts.reviewClock) self.setReviewClock(opts.reviewClock.at, opts.reviewClock.gapMs);
  const finishes: ((r?: SkillResult) => void)[] = [];
  const previous = SKILLS.mind_step;
  SKILLS.mind_step = { name: 'mind_step', description: '测试用的一步活', argsDoc: '{"n"?: 数字}', timeoutMs: 60000, movement: false,
    validate: (raw: any) => ({ ok: true, args: { n: Number(raw?.n ?? 1) } }),
    run: async (ctx) => {
      ctx.progress(0.5);
      return await new Promise<SkillResult>((resolve, reject) => {
        const entry = (r?: SkillResult) => resolve(r ?? ok('做完一步'));
        finishes.push(entry);
        ctx.signal.addEventListener('abort', () => { finishes.splice(finishes.indexOf(entry) >>> 0, 1); reject(new AbortedError('cancelled')); }, { once: true });
      });
    } };
  const said: string[] = [];
  const behaviors = opts.behaviors && opts.book ? new BehaviorEngine(opts.book, adapter, arbiter, bus, vision) : undefined;
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, opts.book ?? null), behaviors, say: (s) => said.push(s) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); behaviors?.dispose(); arbiter.cancel('test end'); memory.close(); if (previous) SKILLS.mind_step = previous; else delete SKILLS.mind_step; });
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 1200 }); await flush(); };
  const tick = async () => { mind.tick(); await flush(); };
  const finish = async (r?: SkillResult) => { finishes.shift()!(r); await flush(); };
  return { adapter, memory, bus, arbiter, planner, perception, vision, self, mind, pending, reply, tick, finish, said, finishes };
}

const step = (n = 1) => ({ skill: 'mind_step', args: { n } });

for (const scenario of ['noop', 'skipped', 'changed', 'steps-noop', 'steps-changed', 'steps-condition'] as const) test(`恢复技能实际执行后按效果处理原动作：${scenario}`, async (t) => {
  const w = fixture(t);
  const code = scenario === 'changed' ? 'await api.move({forward:true}, 100); return {ok:true};'
    : scenario === 'skipped' ? 'return {skipped:"条件不符"};' : 'return {ok:true,plugged:0,moved:false,note:"头顶没有液体"};';
  const previous = SKILLS.repair_probe;
  SKILLS.repair_probe = { name: 'repair_probe', description: '测试恢复动作', argsDoc: '{}', timeoutMs: 3000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      if (scenario === 'steps-changed') {
        await ctx.adapter.drive!({ forward: true }, 100, ctx.signal);
        return ok('身体已移动');
      }
      return ok('没有需要移动', { noop: true });
    } };
  t.after(() => { if (previous) SKILLS.repair_probe = previous; else delete SKILLS.repair_probe; });
  const repair = { name: 'repair-test', description: '尝试恢复', steps: scenario.startsWith('steps-')
    ? [{ skill: 'repair_probe', ...(scenario === 'steps-condition' ? { if: { hp_below: 1 } } : {}) }]
    : [], ...(scenario.startsWith('steps-') ? {} : { code }) };
  setBehaviorRegistry({ get: (name) => name === repair.name ? repair : undefined, list: () => [{ name: repair.name }] });
  t.after(() => setBehaviorRegistry(null));
  let selected = false, skipped = 0;
  (w.mind as any).d.behaviors = {
    recoveryFor: () => { if (selected) return null; selected = true; return repair; },
    recoverySkipped: () => { skipped++; },
    creditRecovery: () => {},
  };
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '原动作', steps: [step()] } });
  await w.finish(fail('STUCK', '原动作没有成功'));
  const completed = new Promise<import('../src/arbiter/arbiter.ts').TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  await w.tick();
  const done = await completed;
  assert.equal(done.task.skill, 'use_skill');
  assert.equal(done.result.status, 'succeeded', done.result.summary);
  assert.equal(done.result.data?.noop === true, scenario !== 'changed' && scenario !== 'steps-changed');
  await flush();
  if (scenario === 'changed' || scenario === 'steps-changed') {
    assert.equal(skipped, 0);
    await w.tick();
    assert.equal(w.arbiter.info()?.skill, 'mind_step', '恢复有实际动作后可以重试原动作');
  } else {
    assert.equal(skipped, 1);
    assert.equal(w.mind.activity, null, '没有恢复效果时交回心智');
    assert.ok(!w.arbiter.info() || w.arbiter.info()?.skill !== 'mind_step');
    const outcome = w.bus.recent().slice().reverse().find((event) => event.type === 'attempt_end');
    assert.match(outcome?.msg ?? '', /原动作没有成功/);
    if (scenario === 'noop' || scenario.startsWith('steps-')) assert.match(outcome?.msg ?? '', /没有观察到实际动作效果/);
  }
});

test('手动调用未产生动作的技能仍正常返回成功和 noop 证据', async (t) => {
  const w = fixture(t);
  const skill = { name: 'manual-noop', description: '观察后结束', steps: [], code: 'return {ok:true,note:"没有需要做的"};' };
  setBehaviorRegistry({ get: (name) => name === skill.name ? skill : undefined, list: () => [{ name: skill.name }] });
  t.after(() => setBehaviorRegistry(null));
  const completed = new Promise<import('../src/arbiter/arbiter.ts').TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const started = w.arbiter.start({ skill: 'use_skill', args: { name: skill.name } }, 'llm');
  assert.ok(!('error' in started));
  const outcome = await completed;
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.result.data?.noop, true);
});

test('找不到目标时交回心智，不自动加探索或改目标', () => {
  const adapter = new FakeAdapter();
  for (const skill of ['gather', 'hunt', 'collect_seeds', 'forage']) {
    const steps = [{ skill, args: { block: 'stone', count: 3 } }, { skill: 'craft', args: { item: 'stone_pickaxe' } }];
    const a = createActivity({ what: '尝试采集', why: '', kind: 'gather', repeat: 1, steps }, '', 'llm', adapter.state());
    const s = nextStep(a)!;
    assert.deepEqual(afterStep(a, s, fail('NOT_FOUND', '当前没有看到目标'), 100, adapter.state()), { kind: 'stuck', why: '当前没有看到目标' });
    assert.deepEqual(a.steps.map((x) => x.skill), steps.map((x) => x.skill), '失败不额外加入探索动作');
    assert.equal(a.results.at(-1)?.summary, '当前没有看到目标');
  }
});

test('动作失败后环境改变时可以重试原动作，缺材料交回心智', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '挖石头', why: '做石镐', kind: 'gather', repeat: 1, steps: [{ skill: 'gather', args: { block: 'stone', count: 3 } }, { skill: 'craft', args: { item: 'stone_pickaxe' } }] }, '', 'llm', adapter.state());
  const s = nextStep(a)!;
  a.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.match((afterStep(a, s, fail('PATH_NOT_FOUND', '路被挡住'), 100, adapter.state()) as { adapted?: string }).adapted ?? '', /再试一次/);
  assert.equal(nextStep(a)!.skill, 'gather');
  afterStep(a, s, ok('挖到了'), 100, adapter.state());
  assert.equal(afterStep(a, nextStep(a)!, fail('MISSING_MATERIALS', '缺木棍'), 100, adapter.state()).kind, 'stuck');
});

test('routine 可以重复多轮，达到收工条件就提前结束', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '砍树', why: '', kind: 'gather', repeat: 3, steps: [step()], doneWhen: { type: 'inventory_min', item: 'oak_log', count: 2 } }, '', 'llm', adapter.state());
  assert.equal(remainingSteps(a), 3);
  const s = nextStep(a)!;
  assert.deepEqual(afterStep(a, s, ok('一根'), 10, adapter.state()), { kind: 'continue' });
  nextStep(a);
  adapter.inv.set('oak_log', 2);
  const v = afterStep(a, s, ok('又一根'), 10, adapter.state());
  assert.equal(v.kind, 'done');
  assert.equal((v as any).met, true);
});

test('a stopping condition records its actual evidence rather than claiming the activity description is verified', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 1375, y: 62, z: 297 };
  const state = adapter.state();
  const a = createActivity({ what: '挖台阶到 y30', why: '', kind: 'gather', repeat: 6, steps: [step()],
    doneWhen: { type: 'underground', equals: true } }, '', 'llm', state);
  const percept = { ts: Date.now(), observation: { ready: true, worldId: state.worldId, sessionId: state.sessionId },
    self: { pos: [state.pos.x, state.pos.y, state.pos.z], dim: state.dim, around: {} }, nearby: { resources: [] }, light: { underground: true } } as any;
  const next = nextStep(a)!;
  const verdict = afterStep(a, next, ok('往下走了一格'), 10, state, percept);
  assert.equal(verdict.kind, 'done');
  if (verdict.kind !== 'done') return;
  assert.match(verdict.why, /underground/);
  assert.match(verdict.why, /62\.0/);
  assert.match(verdict.why, /其他目标未由此验证/);
  const record = recordOf(a, 'done', verdict.why, state);
  assert.equal(record.completion, 'condition');
  const self = new SelfModel(null, []);
  const lesson = self.learn('沿下坡前进', { kind: 'gather', signature: record.signature, source: 'reflection' })!;
  self.record(record);
  assert.equal(lesson.wins, 0, 'a stopping condition is not proof that the described task succeeded');
});

test('开工前已成立的 done_when 不能验收目标：活动记为 attempted，不编造资源结论', async (t) => {
  const w = fixture(t);
  w.adapter.inv.set('stone_axe', 1);
  await w.tick();
  await w.reply(0, { monologue: '找木料', decision: 'new', activity: {
    what: '找木料砍原木', kind: 'gather', steps: [step()],
    done_when: { type: 'inventory_min', item: 'stone_axe', count: 1 },
  } });
  assert.ok(w.mind.activity?.attemptOnly, '开工前已成立的条件不能当完成依据');
  assert.equal(w.mind.activity?.doneWhen, undefined);
  await w.finish(ok('步骤做完了'));
  const end = w.bus.recent().slice().reverse().find((event) => event.type === 'attempt_end');
  assert.equal(end?.data?.completion, 'attempt');
  assert.equal(end?.data?.status, 'attempted');
  assert.equal(end?.data?.resource, undefined, '没有显式资源目标时不做资源结论');
  assert.match(end?.msg ?? '', /有界尝试/);
});

test('计划说走远找树但只有观察/采集：活动开始时报告计划覆盖缺口', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '走远找树', decision: 'new', activity: {
    what: '沿地表走远找树砍原木', kind: 'gather', steps: [step()],
  } });
  assert.ok(w.mind.activity?.planCoverageGap);
  const gap = w.bus.recent().slice().reverse().find((event) => event.type === 'plan_coverage_gap');
  assert.match(gap?.msg ?? '', /没有会让身体移动的动作/);
  await w.finish(ok('做完一步'));
  const end = w.bus.recent().slice().reverse().find((event) => event.type === 'attempt_end');
  assert.match(end?.msg ?? '', /计划覆盖缺口/);
});

test('决定的校验：能纠正就纠正，关键部分错了才要求重答', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  assert.ok('error' in parseDecision({ decision: 'continue', monologue: '嗯' }, adapter, memory, false));
  const d = parseDecision({ decision: 'new', monologue: '去砍树', activity: { what: '砍树', steps: [{ skill: 'no_such_skill', optional: true }, { skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
  assert.ok(!('error' in d));
  if ('error' in d) return;
  assert.equal(d.activity!.steps.length, 1);
  assert.match(d.notes.join(), /丢掉了不能执行的步骤/);
  const rest = parseDecision({ decision: 'rest', monologue: '累了' }, adapter, memory, true);
  assert.ok(!('error' in rest) && rest.activity?.kind === 'rest');
  const say = parseDecision({ decision: 'continue', monologue: '嗯', say: '/op me' }, adapter, memory, true);
  assert.ok(!('error' in say) && say.say === undefined);
  memory.close();
});

test('情绪由真实经历推动：失败让人烦躁，新鲜事驱散无聊', () => {
  let m = { ...DEFAULT_MOOD, boredom: 0.7 };
  for (let i = 0; i < 4; i++) m = feel(m, { type: 'step', ok: false });
  assert.ok(m.frustration > 0.35);
  assert.ok(moodWords(m).some((w) => /不顺心|烦躁/.test(w)));
  m = feel(m, { type: 'novelty', strength: 1 });
  assert.ok(m.boredom < 0.7);
});

test('窍门的可信度由后来的实际结果修正，并能按眼下的事挑出来', () => {
  const self = new SelfModel(null);
  const k = self.learn('砍橡树时先做木斧会快很多 oak_log', { kind: 'gather', signature: 'gather:oak_log', source: 'reflection', outcome: 'done' })!;
  self.record({ id: 'a', what: '砍树', kind: 'gather', outcome: 'stuck', summary: '', durationSec: 10, gained: {}, lost: {}, at: Date.now(), signature: 'gather:oak_log', failures: 2 });
  assert.equal(k.wins, 1);
  assert.equal(k.losses, 1);
  assert.equal(self.relevantKnowHow('想去砍点橡树 oak_log', 'gather')[0]?.id, k.id);
  const a1 = self.addAgenda('在湖边盖一个小木屋', 'goal', 'today');
  const a2 = self.addAgenda('在湖边盖一个小木屋', 'goal', 'today');
  assert.equal(a1?.id, a2?.id);
});

test('注意力：天黑、饿了、背包满是值得抬头想一想的事；同一件事不重复提', () => {
  const att = new Attention();
  const base: any = { time: { phase: 'day' }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 5, nearby: { hostile: [], resources: [] }, light: null };
  att.fromPercept(base);
  const n = att.fromPercept({ ...base, time: { phase: 'dusk' }, self: { ...base.self, food: 5 } });
  assert.ok(n.some((x) => x.key === 'dusk' && x.level === 'reconsider'));
  assert.ok(n.some((x) => x.key === 'hungry'));
  assert.equal(att.notice('dusk', '又是黄昏', 0.6), null);
});

test('一段活连续执行多轮；最后一步执行时不预判完成，干完接上已决定的下一段', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.pending.length, 1, '没有活时先认真想想');
  assert.equal(w.pending[0].hint.tier, 'full');
  assert.match(w.pending[0].messages[0].content, /真人玩家/);
  await w.reply(0, { monologue: '先砍点树', say: '开工！', decision: 'new', activity: { what: '砍树', why: '缺木头', kind: 'gather', steps: [step()], repeat: 2 }, next: { what: '做工作台', steps: [step(2)] } });
  assert.equal(w.arbiter.info()?.skill, 'mind_step');
  const first = w.mind.activity!.id;
  assert.deepEqual(w.said, ['开工！']);
  await w.finish();
  await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'mind_step', '第二轮接着做，不用问模型');
  assert.equal(w.pending.length, 1);
  await w.tick();
  assert.equal(w.pending.length, 1, '最后一步仍在执行，不推测它已经快完成');
  assert.equal(w.mind.activity?.id, first);
  await w.finish();
  await w.tick();
  assert.notEqual(w.mind.activity?.id, first);
  assert.equal(w.mind.activity?.what, '做工作台');
  assert.equal(w.arbiter.info()?.skill, 'mind_step', '干完立刻接上，没有停下来等');
  assert.equal(w.self.history(1)[0].outcome, 'done');
  assert.ok(w.self.recentThoughts().some((x) => x.text === '先砍点树'));
});

test('绕路：先处理别的事，做完回到被打断的那段活——回去之前先想一想还要不要接着做', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '盖墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  const wall = w.mind.activity!;
  w.mind.attention.notice('hungry', '饿了', 0.6);
  (w.mind as any).lastThoughtAt = 0; // 离上次想事情够久了
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.reply(1, { monologue: '先吃点东西', decision: 'detour', activity: { what: '弄点吃的', steps: [step(9)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '弄点吃的');
  assert.deepEqual(w.mind.suspended.map((a) => a.id), [wall.id]);
  await w.finish();
  assert.equal(w.mind.activity?.id, wall.id, '吃完回到砌墙');
  await w.tick();
  assert.notDeepEqual(w.arbiter.info()?.args, { n: 1 }, '不闷头接着做：先想一想');
  const last = w.pending.length - 1;
  assert.match(w.pending[last].messages[1].content, /弄点吃的」已收工[\s\S]*放下的「砌墙」[\s\S]*还要接着做吗/);
  await w.reply(last, { monologue: '接着砌', decision: 'continue' });
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 }, '从被打断的那一步重新开始');
});

test('绕路回来时前提已经变了（等的东西到了、要的已经够了）：可以不再接着做', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '等图纸时先攒木头', decision: 'new', activity: { what: '攒原木等图纸', steps: [step(1), step(2)] } });
  w.mind.attention.notice('dusk', '天快黑了', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(1, { monologue: '先回家', decision: 'detour', activity: { what: '回基地', steps: [step(9)] } });
  await w.finish();
  await w.tick();
  assert.match(w.pending.at(-1)!.messages[1].content, /还要接着做吗/);
  await w.reply(w.pending.length - 1, { monologue: '图纸到了木头也够了，开工盖房', decision: 'switch', activity: { what: '照图纸盖房', steps: [step(5)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '照图纸盖房');
  assert.deepEqual(w.arbiter.info()?.args, { n: 5 });
  assert.equal(w.self.history(1)[0].what, '攒原木等图纸', '旧活被放下了');
});

test('绕路时挂起长程移动，回来带同一 sessionId 续接原委托', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.explore_toward;
  SKILLS.explore_toward = {
    name: 'explore_toward', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: (raw: any) => ({ ok: true, args: { direction: 'W', distance: 64, ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}) } }),
    run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
      const stop = () => {
        const error = new AbortedError('cancelled');
        (error as Error & { partial?: Record<string, unknown> }).partial = { sessionId: 'ms_test', stop: { reason: 'SUSPENDED' } };
        reject(error);
      };
      if (ctx.signal.aborted) return stop();
      ctx.signal.addEventListener('abort', stop, { once: true });
    }),
  };
  t.after(() => { if (previous) SKILLS.explore_toward = previous; else delete SKILLS.explore_toward; });

  await w.tick();
  await w.reply(0, { monologue: '向西走', decision: 'new', activity: { what: '向西探索', steps: [{ skill: 'explore_toward', args: { direction: 'W', distance: 64 } }] } });
  await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'explore_toward');
  const original = w.mind.activity!;

  w.mind.attention.notice('hungry', '饿了', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  const detourAt = w.pending.length - 1;
  await w.reply(detourAt, { monologue: '先捡点东西', decision: 'detour', activity: { what: '捡东西', steps: [step(9)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '捡东西');
  assert.deepEqual(w.mind.suspended.map((a) => a.id), [original.id]);
  assert.equal(w.mind.suspended[0]?.movementPause?.sessionId, 'ms_test', '挂起回执归还到原步骤');

  await w.finish();
  await w.tick();
  const askAt = w.pending.length - 1;
  assert.match(w.pending[askAt].messages[1].content, /还要接着做吗/);
  await w.reply(askAt, { monologue: '接着向西', decision: 'continue' });
  await w.tick();
  const running = w.arbiter.info();
  assert.equal(running?.skill, 'explore_toward');
  assert.equal((running?.args as { sessionId?: string }).sessionId, 'ms_test', '续接时把保存的 sessionId 加进派发参数');
  assert.equal(w.mind.activity?.id, original.id);
});

test('长程移动仍在跑时，不包含该步骤的 adjust 被拒绝，原任务不被静默取消', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.explore_toward;
  SKILLS.explore_toward = {
    name: 'explore_toward', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: (raw: any) => ({ ok: true as const, args: { direction: 'W', distance: 64, ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}) } }),
    run: async () => new Promise<SkillResult>(() => {}),
  };
  t.after(() => { if (previous) SKILLS.explore_toward = previous; else delete SKILLS.explore_toward; });

  await w.tick();
  await w.reply(0, { monologue: '向西走', decision: 'new', activity: { what: '向西探索', steps: [{ skill: 'explore_toward', args: { direction: 'W', distance: 64 } }] } });
  await w.tick();
  const original = w.mind.activity!;
  assert.equal(w.arbiter.info()?.skill, 'explore_toward');

  w.mind.attention.notice('adjust-test', '测试调整', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  const adjustAt = w.pending.length - 1;
  await w.reply(adjustAt, { monologue: '改做别的', decision: 'adjust', activity: { what: '改做别的', steps: [step(9)] } });
  await w.tick();

  assert.equal(w.mind.activity?.id, original.id, '被拒绝的 adjust 不改写活动');
  assert.equal(w.arbiter.info()?.skill, 'explore_toward', '在途长程移动没有被取消');
  assert.equal(w.mind.activity?.steps.length, 1);
  assert.ok(w.bus.recent().some((event) => event.type === 'activity_adjust' && /调整被拒绝/.test(event.msg)),
    '把拒绝事实交回给心智');
});

test('同一半格脚位被 excavate_run 拒绝后，先要求换整块脚位，不原样重开', async (t) => {
  const w = fixture(t);
  w.adapter.pos = { x: -513.3, y: 106.9375, z: -281.3 };
  (w.mind as any).footSupportHold = {
    at: Date.now(), worldId: w.adapter.worldId, sessionId: w.adapter.sessionId, dim: w.adapter.dim,
    feet: feetCell(w.adapter.pos),
  };
  const activity = createActivity({
    what: '朝南开挖整格下行阶梯', why: '测试', kind: 'gather', repeat: 1,
    steps: [{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'south', steps: 18 } }],
  }, '', 'llm', w.adapter.state());
  const decision = { kind: 'new' as const, activity, notes: [] as string[], monologue: '继续挖' };
  assert.equal((w.mind as any).enforceFootSupport(decision, {}), false);
  assert.equal(decision.activity, undefined);
  assert.equal(decision.kind, 'continue');
  assert.match(decision.notes[0]!, /先 move_step 到相邻整块脚位/);
  assert.ok(w.bus.recent().some((event) => event.type === 'foot_support_hold'));

  // 先 move_step 的草案照常放行；换到整块脚位后 hold 自动清除
  const moving = createActivity({
    what: '先站到整块地面', why: '测试', kind: 'other', repeat: 1,
    steps: [{ skill: 'move_step', args: { at: [1, 1, 0], facing: 'E' } }, { skill: 'excavate_run', args: { mode: 'stairs', direction: 'south', steps: 18 } }],
  }, '', 'llm', w.adapter.state());
  assert.equal((w.mind as any).enforceFootSupport({ kind: 'new', activity: moving, notes: [] }, {}), true);
  w.adapter.pos = { x: -513.3, y: 107, z: -281.3 };
  assert.equal((w.mind as any).enforceFootSupport({ kind: 'new', activity, notes: [] }, {}), true);
  assert.equal((w.mind as any).footSupportHold, null);
});

test('挂起回执晚于插曲开始/续接时，按 taskId 与步骤实例归还，不结束当前活动', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.explore_toward;
  SKILLS.explore_toward = {
    name: 'explore_toward', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: (raw: any) => ({ ok: true as const, args: { direction: 'W', distance: 64, ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}) } }),
    run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
      const stop = () => {
        // 模拟取消回执慢于插曲开始：先让 detour 和续接跑起来，再把 sessionId 交回。
        setTimeout(() => {
          const error = new AbortedError('cancelled');
          (error as Error & { partial?: Record<string, unknown> }).partial = { sessionId: 'ms_late', stop: { reason: 'SUSPENDED' } };
          reject(error);
        }, 100);
      };
      if (ctx.signal.aborted) return stop();
      ctx.signal.addEventListener('abort', stop, { once: true });
    }),
  };
  t.after(() => { if (previous) SKILLS.explore_toward = previous; else delete SKILLS.explore_toward; });

  await w.tick();
  await w.reply(0, { monologue: '向西走', decision: 'new', activity: { what: '向西探索', steps: [{ skill: 'explore_toward', args: { direction: 'W', distance: 64 } }] } });
  await w.tick();
  const original = w.mind.activity!;

  w.mind.attention.notice('hungry', '饿了', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  const detourAt = w.pending.length - 1;
  await w.reply(detourAt, { monologue: '先捡点东西', decision: 'detour', activity: { what: '捡东西', steps: [step(9)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '捡东西', '插曲已经开始');
  await w.finish();
  await w.tick();
  const askAt = w.pending.length - 1;
  await w.reply(askAt, { monologue: '接着向西', decision: 'continue' });
  await w.tick();
  assert.equal(w.mind.activity?.id, original.id);

  // 等迟到的取消回执：它只应把 sessionId 归还给原步骤，不能结束当前活动或改错步骤。
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flush();
  assert.equal(original.movementPause?.sessionId, 'ms_late');
  assert.equal(original.movementPause?.stepId, original.steps[0]?.id);
  assert.equal(w.mind.activity?.id, original.id, '迟到回执没有结束当前活动');
  assert.equal(w.mind.suspended.length, 0);
});

test('挂起任务以 failed 自然落定时也归还 session，不丢给插曲活动', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.explore_toward;
  SKILLS.explore_toward = {
    name: 'explore_toward', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: (raw: any) => ({ ok: true as const, args: { direction: 'W', distance: 64, ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}) } }),
    run: async (ctx) => new Promise<SkillResult>((resolve) => {
      const stop = () => resolve(fail('PATH_NOT_FOUND', '挂起前搜索自然停止', { sessionId: 'ms_failed', stop: { reason: 'NO_PATH' } }));
      if (ctx.signal.aborted) return stop();
      ctx.signal.addEventListener('abort', stop, { once: true });
    }),
  };
  t.after(() => { if (previous) SKILLS.explore_toward = previous; else delete SKILLS.explore_toward; });

  await w.tick();
  await w.reply(0, { monologue: '向西走', decision: 'new', activity: { what: '向西探索', steps: [{ skill: 'explore_toward', args: { direction: 'W', distance: 64 } }] } });
  await w.tick();
  const original = w.mind.activity!;

  w.mind.attention.notice('hungry', '饿了', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  const detourAt = w.pending.length - 1;
  await w.reply(detourAt, { monologue: '先捡点东西', decision: 'detour', activity: { what: '捡东西', steps: [step(9)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '捡东西');
  assert.equal(original.movementPause?.sessionId, 'ms_failed', 'failed 回执同样归还 session');
  assert.equal(w.mind.activity?.what, '捡东西', '原任务的 failed 回执没有结束插曲');
});

test('绕路回来时原活动收工条件已满足：复核后收工，不重新派发移动步', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.explore_toward;
  SKILLS.explore_toward = {
    name: 'explore_toward', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: (raw: any) => ({ ok: true, args: { direction: 'W', distance: 64, ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}) } }),
    run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
      const stop = () => {
        const error = new AbortedError('cancelled');
        (error as Error & { partial?: Record<string, unknown> }).partial = { sessionId: 'ms_test' };
        reject(error);
      };
      if (ctx.signal.aborted) return stop();
      ctx.signal.addEventListener('abort', stop, { once: true });
    }),
  };
  t.after(() => { if (previous) SKILLS.explore_toward = previous; else delete SKILLS.explore_toward; });

  await w.tick();
  await w.reply(0, { monologue: '向西走', decision: 'new', activity: {
    what: '向西探索', steps: [{ skill: 'explore_toward', args: { direction: 'W', distance: 64 } }],
    done_when: { type: 'exploration', min_distance: 24 },
  } });
  await w.tick();
  const original = w.mind.activity!;

  w.mind.attention.notice('hungry', '饿了', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  const detourAt = w.pending.length - 1;
  await w.reply(detourAt, { monologue: '先捡点东西', decision: 'detour', activity: { what: '捡东西', steps: [step(9)] } });
  await w.tick();
  // 插曲期间身体实际已经走够 24 格：回来复核应收工，而不是再派发一次长程移动。
  w.adapter.pos = { x: 30.5, y: 64, z: 0.5 };
  await w.finish();
  await w.tick();
  const askAt = w.pending.length - 1;
  assert.match(w.pending[askAt].messages[1].content, /还要接着做吗/);
  await w.reply(askAt, { monologue: '已经走够了', decision: 'continue' });
  await w.tick();
  assert.equal(w.mind.activity, null, '复核已满足收工条件，不重派移动步');
  assert.notEqual(w.arbiter.info()?.skill, 'explore_toward');
  assert.equal(original.conditionTriggered, true);
});

test('长程移动部分推进不写成失败练习；真实无进展失败仍记失败', async (t) => {
  const previous = SKILLS.travel_to;
  const fake = (position: { x: number; y: number; z: number }, summary: string, reason = 'NO_PATH') => ({
    name: 'travel_to', description: '测试长程移动', argsDoc: '{}', timeoutMs: 60000, movement: true,
    validate: () => ({ ok: true as const, args: { to: { x: 0, y: 64, z: -96 }, range: 2 } }),
    run: async () => fail('PATH_NOT_FOUND', summary, {
      sessionId: 'ms_test', confirmedSegments: 0, position, stop: { reason },
    }),
  });
  t.after(() => { if (previous) SKILLS.travel_to = previous; else delete SKILLS.travel_to; });

  SKILLS.travel_to = fake({ x: 0.5, y: 64, z: -30 }, '底层搜索无路，但身体已向南移动 30 格');
  const partial = fixture(t);
  await partial.tick();
  await partial.reply(0, { decision: 'new', activity: { what: '向南走', steps: [{ skill: 'travel_to', args: { to: { x: 0, y: 64, z: -96 }, range: 2 } }] } });
  await partial.tick();
  await flush();
  assert.equal(partial.self.data.feel.travel_to, undefined, '有实测位移但未到达的长程移动不写失败样本');

  SKILLS.travel_to = fake({ x: 0, y: 64, z: 0 }, '在原地施工，等待更多授权', 'MAKE_WAY_BUDGET_EXHAUSTED');
  const waiting = fixture(t);
  await waiting.tick();
  await waiting.reply(0, { decision: 'new', activity: { what: '向南走', steps: [{ skill: 'travel_to', args: { to: { x: 0, y: 64, z: -96 }, range: 2 } }] } });
  await waiting.tick();
  await flush();
  assert.equal(waiting.self.data.feel.travel_to, undefined, '等待施工授权且本次无位移时不写失败样本');

  SKILLS.travel_to = fake({ x: 0, y: 64, z: 0 }, '身体执行失败，原地未动', 'PHYSICAL_FAILURE');
  const stalled = fixture(t);
  await stalled.tick();
  await stalled.reply(0, { decision: 'new', activity: { what: '向南走', steps: [{ skill: 'travel_to', args: { to: { x: 0, y: 64, z: -96 }, range: 2 } }] } });
  await stalled.tick();
  await flush();
  assert.ok((stalled.self.data.feel.travel_to?.fail ?? 0) > 0, '没有实测进展的真实执行失败仍计一次失败练习');
});

test('卡住时认真想，并把实际结果和卡住时的备选交给模型；学到的窍门会记下来', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '做石镐', decision: 'new', activity: { what: '做石镐', steps: [step()], if_stuck: '去挖点圆石' } });
  await w.finish(fail('MISSING_MATERIALS', '缺圆石'));
  assert.equal(w.mind.activity, null);
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].hint.tier, 'full');
  const user = w.pending[1].messages[1].content;
  assert.match(user, /卡住了/);
  assert.match(user, /去挖点圆石/);
  await w.reply(1, { monologue: '原来要先挖圆石', decision: 'new', learned: '做石镐之前要先有 3 个圆石', activity: { what: '挖圆石', steps: [step()] } });
  assert.ok(w.self.data.knowHow.some((k) => /圆石/.test(k.text)));
  assert.ok(w.memory.lessonsFor(5).some((l) => /圆石/.test(l.text)));
});

test('模型出错时不发呆：先停下看看四周，不替它定玩法', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].reject(new Error('HTTP 503'));
  await flush();
  assert.equal(w.mind.activity?.source, 'habit');
  assert.ok(w.arbiter.info(), '有事在做');
  assert.equal(w.arbiter.info()?.skill, 'look_around', '只停下看看，不替它定玩法');
});

test('瞥一眼觉得需要深想时升级为完整思考', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '走走', decision: 'new', activity: { what: '散步', steps: [step()] } });
  w.mind.attention.notice('x', '看见了奇怪的建筑', 0.55);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.equal(w.pending[1].hint.tier, 'light');
  await w.reply(1, { kind: 'deliberate', reason: '这是什么建筑' });
  assert.equal(w.pending.length, 3);
  assert.equal(w.pending[2].hint.tier, 'full');
  await w.reply(2, { monologue: '过去看看', decision: 'switch', activity: { what: '去看建筑', kind: 'explore', steps: [step()] }, agenda: { add: [{ text: '弄清那座建筑是什么', kind: 'question' }] } });
  assert.equal(w.mind.activity?.what, '去看建筑');
  assert.ok(w.self.agenda().some((a) => a.kind === 'question'));
});

test('mock 模式下用规则凑出同样形状的决定，整条链路照常', async (t) => {
  const w = fixture(t, { autonomous: false });
  await w.tick();
  assert.equal(w.pending.length, 0);
  await flush();
  const plan = w.bus.recent().slice().reverse().find((event) => event.type === 'plan');
  assert.equal(plan?.data?.source, 'rule', '规则模式产出的决定标为 rule');
  assert.ok(Array.isArray(plan?.data?.steps) && plan!.data.steps.length > 0, '规则模式也安排可执行步骤');
});

test('提示词包含情绪、议程、窍门、念头和实际变化', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), perception = new Perception(adapter, memory, bus, vision);
  const self = new SelfModel(null, ['好奇']);
  self.addAgenda('盖小屋', 'goal', 'today');
  self.think('刚才在想要不要去河边');
  const p = perception.update();
  const msgs = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: p, state: adapter.state(), self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [{ at: 0, key: 'dusk', what: '太阳快下山了', salience: 0.55, level: 'reconsider' }], changes: ['走了 10 格'], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  const u = msgs[1].content;
  for (const s of ['盖小屋', '刚才在想要不要去河边', '太阳快下山了', '走了 10 格', 'feeling']) assert.ok(u.includes(s), s);
  assert.ok(msgs[0].content.includes('gather'));
  memory.close();
});

test('被生存反射打断的那一步，等身体安全了再做一遍，不用重新想', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '挖矿', decision: 'new', activity: { what: '挖矿', steps: [step(1), step(2)] } });
  await w.finish();
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 2 });
  w.arbiter.start({ skill: 'look_around', args: { seconds: 2 } }, 'reflex');
  await flush();
  await w.tick();
  assert.equal(w.arbiter.info()?.source, 'reflex', '反射期间心智不抢控制');
  w.arbiter.cancel('反射结束');
  await flush();
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 2 }, '回到被打断的那一步');
  assert.equal(w.pending.length, 1, '没有为此额外调用模型');
  assert.equal(w.mind.activity?.interruptions, 1, '身体反射打断被记在活动状态里');
  assert.equal(w.mind.activity?.lastInterruption?.kind, 'body_reflex');
  assert.match(w.mind.activity?.lastInterruption?.reason ?? '', /躲闪反应/);
});

test('死亡后放下手上的活，复活后认真想想，并记进日记和情绪', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '探险', decision: 'new', activity: { what: '探洞', steps: [step()] } });
  const before = w.self.mood.frustration;
  w.mind.onDeath({ cause: 'lava' });
  assert.equal(w.mind.activity, null);
  assert.ok(w.self.mood.frustration > before);
  assert.ok(w.self.diary(1)[0].text.includes('死了'));
  await new Promise((r) => setTimeout(r, 1600));
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].hint.tier, 'full');
  assert.match(w.pending[1].messages[1].content, /刚刚死了/);
});

test('在原地失败、周围也没变化时不原样重试；navigate_to 找不到路也不重试', () => {
  const adapter = new FakeAdapter();
  const here = { ...adapter.state().pos };
  const a = createActivity({ what: '挖石头', why: '', kind: 'gather', repeat: 1, steps: [{ skill: 'gather', args: { block: 'stone', count: 3 } }] }, '', 'llm', adapter.state());
  const s1 = nextStep(a)!;
  a.stepStart = { pos: here };
  assert.equal(afterStep(a, s1, fail('PATH_NOT_FOUND', '路被挡住'), 100, adapter.state()).kind, 'stuck');
  const g = createActivity({ what: '回家', why: '', kind: 'explore', repeat: 1, steps: [{ skill: 'navigate_to', args: { to: { x: 1, y: 64, z: 0 } } }] }, '', 'llm', adapter.state());
  const s2 = nextStep(g)!;
  g.stepStart = { pos: { ...adapter.state().pos } };
  assert.equal(afterStep(g, s2, fail('PATH_NOT_FOUND', '眼前没有可确认的通路'), 100, adapter.state()).kind, 'stuck');
});

test('顺手的步骤没成不算这段活失败，接着做后面的', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '往西走，路上见到牛就打', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'hunt', args: { animal: 'cow' }, optional: true }, { skill: 'navigate_to', args: { to: { x: 1, y: 64, z: 0 } } }] }, '', 'llm', adapter.state());
  const s1 = nextStep(a)!;
  const v = afterStep(a, s1, fail('NOT_FOUND', '视野里没有 cow'), 100, adapter.state());
  assert.equal(v.kind, 'continue');
  assert.match((v as any).adapted, /顺手/);
  assert.equal(a.failures, 0);
  assert.equal(nextStep(a)!.skill, 'navigate_to');
  const v2 = afterStep(a, { skill: 'navigate_to', args: {} }, ok('走了 32 格'), 100, adapter.state());
  assert.deepEqual(v2, { kind: 'done', met: true, why: '这段活的步骤都做完了' });
});

test('模型可以把步骤标成 optional，校验时保留', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const d = parseDecision({ decision: 'new', monologue: '走走', activity: { what: '散步', steps: [{ skill: 'look_around', args: { seconds: 3 }, optional: true }, { skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
  assert.ok(!('error' in d));
  if ('error' in d) return;
  assert.equal(d.activity!.steps[0].optional, true);
  assert.equal(d.activity!.steps[1].optional, undefined);
  memory.close();
});

test('最后一步做着时不预判完成，完成后根据真实结果思考', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step(1), step(2)] } });
  await w.tick();
  assert.equal(w.pending.length, 1, '第一步刚开工不问“接下来做什么”（以前一开工就问，模型常顺手把刚开工的活换掉）');
  await w.finish();
  await w.tick();
  await w.tick();
  assert.equal(w.pending.length, 1, '最后一步运行中不触发预判');
  await w.finish();
  await w.tick();
  assert.equal(w.pending.length, 2, '实际完成后再想接下来');
  assert.match(w.pending[1].messages[1].content, /砍树/);
  await w.reply(1, { monologue: '然后做工作台', decision: 'new', activity: { what: '做工作台', steps: [step(3)] } });
  assert.equal(w.mind.activity?.what, '做工作台');
});

test('存物动作刚启动也不自动预判完成', async (t) => {
  const w = fixture(t), previous = SKILLS.store_items;
  SKILLS.store_items = { ...SKILLS.mind_step, name: 'store_items' };
  t.after(() => { SKILLS.store_items = previous; });
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '存物', steps: [{ skill: 'store_items', args: {} }] } });
  await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'store_items');
  assert.equal(w.pending.length, 1, '动作开始时没有为下一段触发思考');
  await w.finish();
  await w.tick();
  assert.equal(w.pending.length, 2, '确认动作结束后再想接下来');
});

test('最后一步运行一段时间后提前想下一段，结果未知时不打断，每段活只问一次', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '砍树', steps: [step()] } });
  (w.arbiter as any).current.startedAt = Date.now() - 4_000;
  await w.tick();
  assert.equal(w.pending.length, 1, '运行四秒时不提前规划');
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].hint.tier, 'light');
  assert.match(w.pending[1].messages[1].content, /最后一步正在执行，结果还不知道/);
  await w.reply(1, { decision: 'continue', next: { what: '做工作台', steps: [step(2)] } });
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 });
  assert.equal(w.mind.activity?.what, '砍树');
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(w.pending.length, 2);
  await w.finish();
  await w.tick();
  assert.equal(w.mind.activity?.what, '做工作台');
  assert.deepEqual(w.arbiter.info()?.args, { n: 2 });
});

test('冻结方向仍在推进时等真实回执再计划下一段，显式新指令仍可改意', async (t) => {
  const w = fixture(t);
  t.mock.method(SKILLS.explore_toward, 'run', SKILLS.mind_step.run);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: {
    what: '朝东探索 50 格', steps: [{ skill: 'explore_toward', args: { direction: 'E', distance: 50 } }],
  } });
  const running = w.arbiter.current!;
  assert.equal(running.skill, 'explore_toward');
  w.adapter.pos.x += 13.57;
  running.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  assert.equal(w.pending.length, 1, '走了 13.57 格时，定时器不能触发以最后一步已完成为前提的接续');
  assert.equal(w.arbiter.info()?.id, running.id);
  w.mind.suggest('!去做别的事');
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.reply(1, { decision: 'new', activity: { what: '照新指令改意', steps: [step(2)] }, operator: { status: 'doing' } });
  assert.equal(w.arbiter.info()?.skill, 'mind_step');
  assert.equal(w.mind.activity?.what, '照新指令改意');
});

for (const stop of ['身体失败', '反射打断']) test(`部分开挖后${stop}，交回实际脚位，不从新位置恢复整段施工`, async (t) => {
  const w = fixture(t);
  t.mock.method(SKILLS.excavate_run, 'run', SKILLS.mind_step.run);
  const recovery = t.mock.fn(() => null);
  Reflect.get(w.mind, 'd').behaviors = { recoveryFor: recovery };
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '朝东开六级阶梯', steps: [
    { skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 6 } },
  ] } });
  assert.equal(w.arbiter.info()?.skill, 'excavate_run');
  w.adapter.pos = { x: w.adapter.pos.x + 3, y: w.adapter.pos.y - 4, z: w.adapter.pos.z };
  if (stop === '身体失败') await w.finish(fail('EFFECT_NOT_CONFIRMED', '实测下落超过授权 1 格', { completedSteps: 3, requestedSteps: 6 }));
  else { w.arbiter.cancel('反射打断', undefined, 'reflex'); await flush(); }
  await w.tick();
  assert.equal(w.mind.activity, null);
  assert.equal(recovery.mock.callCount(), 0);
  assert.equal(w.bus.recent().filter(e => e.type === 'task_start' && e.data?.skill === 'excavate_run').length, 1);
  assert.match(w.self.history(1)[0]?.summary ?? '', /当前脚位/);
});

test('刚开始动作时普通掉落物暂存，不单独触发瞥一眼', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '下行', steps: [step()] } });
  (w.mind as any).lastThoughtAt = 0;
  (w.arbiter as any).current.startedAt = Date.now() - 4_000;
  w.mind.attention.notice('drops:dirt', '地上有泥土掉落物', 0.5, 0);
  await w.tick();
  assert.equal(w.pending.length, 1);
  assert.equal(w.mind.attention.peek().some((n) => n.key === 'drops:dirt'), true);
  assert.equal(w.arbiter.info()?.skill, 'mind_step');
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.match(JSON.stringify(w.pending[1].messages), /地上有泥土掉落物/);
});

test('旧 pickup 习惯在等待模型回复时也不会启动 filler 拾取', async (t) => {
  const w = fixture(t);
  w.self.setHabits({ pickup: true });
  w.adapter.entities = [{ id: 301, name: 'item:cobblestone', kind: 'item', count: 1, dist: 3, pos: { x: 3, y: 64, z: 0 } }];
  const start = { ...w.adapter.pos };
  await w.tick();
  assert.equal(w.pending.length, 1);
  assert.ok(w.perception.snapshot().vision?.visible_drops?.some((d) => d.item === 'cobblestone'), '眼前确实有可捡的掉落');
  await w.tick();
  assert.ok(w.bus.recent().every((e) => e.type !== 'task_start' || e.data?.skill !== 'pickup_items'));
  assert.deepEqual(w.adapter.pos, start, '等待回复时不先走去捡');
});

for (const pick of [false, true]) test(`新掉落先触发轻量判断，模型${pick ? '选择拾取才执行' : '选择继续就不捡'}`, async (t) => {
  const w = fixture(t);
  w.self.setHabits({ pickup: true });
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '继续手上的工作', steps: [step(), step(2)] } });
  const current = w.arbiter.info()!;
  w.arbiter.current!.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  Reflect.set(w.mind, 'lastThoughtAt', 0);
  Reflect.set(w.mind, 'lastPerceptAt', 0);
  w.adapter.entities = [{ id: 302, name: 'item:cobblestone', kind: 'item', count: 1, dist: 3, pos: { x: 3, y: 64, z: 0 } }];
  w.adapter.yaw = -Math.PI / 2;
  w.vision.scan();
  const start = { ...w.adapter.pos };
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].hint.tier, 'light');
  assert.match(JSON.stringify(w.pending[1].messages), /附近有掉落物：cobblestone/);
  assert.equal(w.arbiter.info()?.id, current.id, '判断期间手上的动作继续');
  assert.deepEqual(w.adapter.pos, start);
  assert.ok(w.bus.recent().every((e) => e.type !== 'task_start' || e.data?.skill !== 'pickup_items'));
  await w.reply(1, pick
    ? { decision: 'detour', activity: { what: '捡眼前的圆石', steps: [{ skill: 'pickup_items', args: { item: 'cobblestone', radius: 4 } }] } }
    : { decision: 'continue', monologue: '先把手上的事做完，这块圆石不捡' });
  await w.tick();
  const pickups = w.bus.recent().filter((e) => e.type === 'task_start' && e.data?.skill === 'pickup_items');
  if (pick) {
    assert.equal(pickups.length, 1);
    assert.equal(pickups[0].data?.source, 'llm');
  } else {
    Reflect.set(w.mind, 'lastThoughtAt', 0);
    Reflect.set(w.mind, 'lastPerceptAt', 0);
    await w.tick();
    assert.equal(pickups.length, 0);
    assert.equal(w.arbiter.info()?.id, current.id);
    assert.deepEqual(w.adapter.pos, start);
    assert.equal(w.pending.length, 2, '同一批掉落判断过后不再次提问');
  }
});

test('关闭 pickup 注意偏好后，新掉落只留给下次思考，不另发请求', async (t) => {
  const w = fixture(t);
  w.self.setHabits({ pickup: false });
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '继续手上的工作', steps: [step(), step(2)] } });
  w.arbiter.current!.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  Reflect.set(w.mind, 'lastThoughtAt', 0);
  Reflect.set(w.mind, 'lastPerceptAt', 0);
  w.adapter.entities = [{ id: 303, name: 'item:cobblestone', kind: 'item', count: 1, dist: 3, pos: { x: 3, y: 64, z: 0 } }];
  w.adapter.yaw = -Math.PI / 2;
  w.vision.scan();
  await w.tick();
  assert.equal(w.pending.length, 1);
  assert.ok(w.mind.attention.peek().some((n) => n.key.startsWith('drops:') && n.level === 'note'));
  assert.ok(w.bus.recent().every((e) => e.type !== 'task_start' || e.data?.skill !== 'pickup_items'));
});

test('刚开始动作时紧急通知仍立即思考，也带上暂存的掉落物', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '下行', steps: [step()] } });
  w.mind.attention.notice('drops:dirt', '地上有泥土掉落物', 0.5, 0);
  w.mind.attention.notice('urgent-test', '附近出现紧急事件', 0.8, 0);
  await w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.pending[1].hint.tier, 'full');
  assert.match(JSON.stringify(w.pending[1].messages), /地上有泥土掉落物/);
  assert.match(JSON.stringify(w.pending[1].messages), /附近出现紧急事件/);
});

test('提前规划没写 next 也不反复追问', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '砍树', steps: [step()] } });
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  await w.reply(1, { decision: 'continue' });
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(w.pending.length, 2);
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 });
});

test('提前规划时动作失败，过期的 next 不会执行，失败交给下一次思考', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '砍树', steps: [step()] } });
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  await w.finish(fail('MISSING_MATERIALS', '缺少斧头'));
  await w.reply(1, { decision: 'continue', next: { what: '过期的下一段', steps: [step(2)] } });
  assert.notEqual(w.mind.activity?.what, '过期的下一段');
  assert.equal(w.mind.queuedNext, null);
  await w.tick();
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /缺少斧头/);
});

test('寻找目标失败时丢弃提前思考，不隐式探索，并把失败交还心智', async (t) => {
  const w = fixture(t);
  const original = SKILLS.gather;
  SKILLS.gather = { ...SKILLS.mind_step, name: 'gather', validate: (raw) => ({ ok: true, args: raw }) };
  t.after(() => { SKILLS.gather = original; });
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '采铁', steps: [{ skill: 'gather', args: { block: 'iron_ore', count: 8 } }] } });
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  await w.finish(fail('NOT_FOUND', '当前视野没有铁矿'));
  await w.reply(1, { decision: 'experiment', activity: { what: '旧观察的实验', steps: [step(2)] } });
  assert.equal(w.mind.activity, null);
  assert.equal(w.mind.queuedNext, null);
  assert.equal(w.bus.recent().filter((event) => event.type === 'task_start' && event.msg.includes('explore')).length, 0);
  await w.tick();
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /当前视野没有铁矿/);
});

test('提前规划已排队的 next 在当前动作失败后丢弃', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '砍树', steps: [step()] } });
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  await w.reply(1, { decision: 'continue', next: { what: '过期的下一段', steps: [step(2)] } });
  assert.ok(w.mind.queuedNext);
  await w.finish(fail('MISSING_MATERIALS', '缺少斧头'));
  assert.equal(w.mind.queuedNext, null);
  await w.tick();
  assert.notEqual(w.mind.activity?.what, '过期的下一段');
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /缺少斧头/);
});

test('提前规划明确选择调整时仍执行新的动作', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '砍树', steps: [step()] } });
  (w.arbiter as any).current.startedAt = Date.now() - Mind.NEAR_END_AFTER_MS;
  await w.tick();
  await w.reply(1, { decision: 'adjust', activity: { what: '采石头', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '采石头');
  assert.equal(w.mind.activity?.lastInterruption?.kind, 'adjusted', '主动改做法也留下未完成事实');
  assert.match(w.mind.activity?.lastInterruption?.reason ?? '', /调整取消了正在执行/);
  assert.deepEqual(w.arbiter.info()?.args, { n: 2 });
});

test('调整期间原步骤刚成功时先提供结果，重新决定后仍可明确重复', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '清理背包', steps: [step(1), step(2)] } });
  w.mind.attention.notice('urgent-adjust', '注意到要紧的事', 0.9, 0);
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.finish(ok('已经丢出 64 个圆石'));
  await w.reply(1, { decision: 'adjust', activity: { what: '清理背包并继续', steps: [step(1), step(2), step(3)] } });
  assert.equal(w.mind.activity?.what, '清理背包');
  assert.equal(w.mind.activity?.index, 1, '不重置尚未完成的原计划');
  assert.equal(w.arbiter.info()?.skill, undefined, '不能在未说明成功结果前重复执行');
  await w.tick();
  assert.equal(w.pending.length, 3);
  assert.match(JSON.stringify(w.pending[2].messages), /已经丢出 64 个圆石/);
  await w.reply(2, { decision: 'adjust', activity: { what: '明确再做一次', steps: [step(1), step(2)] } });
  assert.equal(w.mind.activity?.what, '明确再做一次');
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 }, '看到实际结果后明确选择重复，应予执行');
});

test('思考期间完成的动作不阻止不同的明确调整', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '原计划', steps: [step(1), step(2)] } });
  w.mind.attention.notice('urgent-adjust', '注意到要紧的事', 0.9, 0);
  await w.tick();
  await w.finish(ok('原步骤已完成'));
  await w.reply(1, { decision: 'adjust', activity: { what: '明确改做法', steps: [step(3)] } });
  assert.equal(w.mind.activity?.what, '明确改做法');
  assert.deepEqual(w.arbiter.info()?.args, { n: 3 });
});

for (const kind of ['new', 'adjust'] as const) test(`注意到事情后明确 ${kind}：adjust 立即改做法，new 排到下一段`, async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.attention.notice('x', '附近有事情', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.reply(1, { monologue: '现在改做法', decision: kind, activity: { what: '改为收集石头', steps: [step(2)] } });
  if (kind === 'new') {
    assert.equal(w.mind.lastDecision?.kind, 'continue');
    assert.equal(w.mind.activity?.what, '砍树', '瞥一眼 new 不放下当前活动');
    assert.equal(w.mind.lastDecision?.next?.what, '改为收集石头', '排到下一段');
  } else {
    assert.equal(w.mind.lastDecision?.kind, 'adjust');
    assert.equal(w.mind.activity?.what, '改为收集石头');
    assert.equal(w.mind.lastDecision?.next, undefined);
  }
});

test('紧急瞥一眼 switch 只挂起原活动，不清空暂停记录', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.suspended.push({ id: 'old', what: '旧暂停', why: '', kind: 'other', steps: [], index: 0, results: [], startedAt: Date.now(), failures: 0 } as any);
  w.mind.attention.notice('danger', '有危险', 0.9);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(1, { monologue: '先躲', decision: 'switch', activity: { what: '躲开', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '躲开');
  assert.ok(w.mind.suspended.some((a) => a.what === '砍树'), '原活动进 suspended');
  assert.ok(w.mind.suspended.some((a) => a.what === '旧暂停'), '旧暂停记录还在');
});

test('紧急活动做完后原活动回到手上，先复核再决定是否继续', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.attention.notice('danger', '有危险', 0.9);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(1, { monologue: '先躲', decision: 'switch', activity: { what: '躲开', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '躲开');
  await w.finish(ok('躲开了'));
  assert.equal(w.mind.activity?.what, '砍树', '紧急活动结束后原活动回到手上');
  await w.tick();
  assert.match(JSON.stringify(w.pending.at(-1)?.messages ?? []), /还要接着做吗/);
});

for (const s of [
  { name: '低血', set: (w: ReturnType<typeof fixture>) => { w.adapter.hp = 10; } },
  { name: '饥饿', set: (w: ReturnType<typeof fixture>) => { w.adapter.food = 5; } },
  { name: '岩浆', set: (w: ReturnType<typeof fixture>) => { w.adapter.inLava = true; } },
] as const) test(`${s.name}也算紧急：切换只挂起原活动，不记成换掉/放弃`, async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  s.set(w);
  (w.mind as any).think('测试紧急状态', 'deliberate');
  await flush();
  await w.reply(w.pending.length - 1, { monologue: '先处理', decision: 'switch', activity: { what: '处理紧急', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '处理紧急');
  assert.ok(w.mind.suspended.some((a) => a.what === '砍树'), '原活动挂起');
  assert.ok(!w.bus.recent().some((e) => e.type === 'attempt_end' && /replaced|abandoned/.test(e.msg)), '没有记成换掉/放弃');
});

test('紧急活动结束但人还在水里/缺氧：不恢复原活动，先交回心智脱险', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.attention.notice('danger', '有危险', 0.9);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(1, { monologue: '先躲', decision: 'switch', activity: { what: '躲开', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '躲开');
  w.adapter.inWater = true;
  w.adapter.oxygen = 5;
  await w.finish(ok('换了口气'));
  assert.equal(w.mind.activity, null, '危险未解除时不把原活动交回手上');
  assert.ok(w.mind.suspended.some((a) => a.what === '砍树'), '原活动仍挂起，等安全后再复核');
  assert.ok(!w.bus.recent().some((e) => e.type === 'activity_start' && /回到/.test(e.msg)), '没有恢复原活动');
});

test('已挂着的操作者指令这一念写 doing：照做，不受紧急挂起限制', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.order = { text: '先去下界', at: Date.now(), status: 'doing', nudged: 1, kind: 'order' };
  w.mind.attention.notice('danger', '有危险', 0.9);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(w.pending.length - 1, { monologue: '照做', decision: 'switch', activity: { what: '去下界', steps: [step(2)] }, operator: { status: 'doing' } });
  assert.equal(w.mind.activity?.what, '去下界');
  assert.ok(!w.mind.suspended.some((a) => a.what === '砍树'), '操作者指令照做时不挂起原活动');
});

test('重启后从 SelfModel 恢复阶段回顾计时，过期目标也不会立刻再回顾', (t) => {
  const at = Date.now() - 10 * 60_000;
  const w = fixture(t, { reviewClock: { at, gapMs: 60 * 60_000 } });
  assert.equal((w.mind as any).lastReviewAt, at);
  assert.equal((w.mind as any).reviewGapMs, 60 * 60_000);
  const thinks: string[] = [];
  (w.mind as any).requestThink = (reason: string) => thinks.push(reason);
  // 目标已经过期、情绪也到了，但上次回顾只在 10 分钟前：不立刻再触发
  w.self.setPlan('测试目标', ['一步']);
  w.self.setOnline(true, Date.now());
  w.self.data.plan!.progressAt = Date.now() - 60 * 60_000;
  w.self.data.plan!.stalledOnlineMs = 60 * 60_000;
  w.self.data.plan!.stalledObservedSince = Date.now() - 60 * 60_000;
  w.self.data.plan!.stalledHistoryUnknown = false;
  w.self.data.plan!.reviewDays = 1;
  w.self.data.mood.boredom = 0.9;
  w.self.notePlanDay(60);
  w.self.setObservedProgress({ planId: w.self.plan()!.agendaId, planGameTicks: 48000, planObservedSince: Date.now() });
  (w.mind as any).stageReviewCheck();
  assert.equal(thinks.length, 0, '没到回顾间隔，连过期路径也不触发');
  // 间隔过了：可以回顾
  (w.mind as any).lastReviewAt = Date.now() - 2 * 60 * 60_000;
  (w.mind as any).stageReviewCheck();
  assert.equal(thinks.length, 1, '间隔过了才回顾');
});

test('零碎经验先存着，出乎意料（卡住）才马上记成窍门', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', learned: '砍树前先看看周围有没有动物', activity: { what: '砍树', steps: [step()] } });
  assert.equal(w.self.data.knowHow.length, 1, '第一条直接记下');
  w.mind.attention.notice('test_lesson', '看看树', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  await w.reply(1, { monologue: '嗯', decision: 'continue', learned: '橡树比白桦好砍一点点', next: { what: '再砍', steps: [step()] } });
  assert.equal(w.self.data.knowHow.length, 1, '紧接着的平常想法先不立规矩');
  assert.equal(w.self.insights().length, 1);
  await w.finish(fail('MISSING_MATERIALS', '缺斧头'));
  await w.tick();
  const i = w.pending.length - 1;
  (w.mind as any).lastLessonAt = Date.now() - 100_000;
  await w.reply(i, { monologue: '原来要先有斧头', decision: 'new', learned: '没有斧头时砍树会卡住，先做木斧', activity: { what: '做斧头', steps: [step()] } });
  assert.ok(w.self.data.knowHow.some((k) => /斧头/.test(k.text)), '卡住之后的教训马上记下');
});

test('模型在活动成功后写出的结论不能直接继承活动验证结果', async (t) => {
  const w = fixture(t);
  (w.mind as any).lastRecord = { id: 'done', what: '站上岸', kind: 'survive', outcome: 'done', summary: '站上岸',
    durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'step', failures: 0 };
  await w.tick();
  await w.reply(0, { monologue: '我有个想法', decision: 'new', learned: '铁镐可以采收黑曜石', activity: { what: '看看周围', steps: [step()] } });
  const lesson = w.self.data.knowHow.find((k) => k.text === '铁镐可以采收黑曜石')!;
  assert.equal(lesson.unverified, true);
  assert.equal(lesson.wins, 0);
  assert.equal(lesson.signature, undefined);
});

test('活动显式 applying 把结果交给对应窍门，并快照开工时的说法', async (t) => {
  const w = fixture(t);
  const lesson = w.self.learn('先看看再走', { source: 'reflection' })!;
  await w.tick();
  await w.reply(0, { monologue: '按这条窍门试试', decision: 'new', activity: { what: '按窍门走一步', applying: lesson.id, steps: [step()] } });
  assert.equal(w.mind.activity?.applying, lesson.id);
  assert.equal(w.mind.activity?.applyingText, lesson.text);
  await w.finish(ok('走通了'));
  assert.equal(lesson.applications?.length, 1);
  assert.equal(lesson.applications?.[0].outcome, 'done');
  assert.equal(lesson.unverified, true, '应用证据不等于自动验证结论');
});

test('活动按窍门开工后同一 id 在后台被改写，旧活动不记到新结论', async (t) => {
  const w = fixture(t);
  const lesson = w.self.learn('卡住时向上开巷', { source: 'reflection' })!;
  const startedText = lesson.text;
  await w.tick();
  await w.reply(0, { monologue: '按这条窍门试试', decision: 'new', activity: { what: '按窍门走一步', applying: lesson.id, steps: [step()] } });
  assert.equal(w.mind.activity?.applyingText, startedText);
  w.self.learn('卡住时向下开巷', { source: 'reflection', revise: lesson.id });
  await w.finish(ok('走通了'));
  assert.equal(lesson.wins, 0, '改写后的新结论不能继承旧活动的成功');
  assert.equal(lesson.applications, undefined);
  const payload = JSON.parse(buildReflectionMessages(w.self, 'P', [], [], w.memory)[1].content.split('\n')[0]);
  const recent = payload.recent.find((entry: { applying?: string }) => entry.applying === lesson.id);
  assert.equal(recent.applying_at_start, startedText, '反思并列显示开工时的旧说法，不把新结论和旧成功放一起');
});

test('不存在的 applying id 保留为未解析关联，且不回退签名误记其他窍门', async (t) => {
  const w = fixture(t);
  const unrelated = w.self.learn('另一个做法', { source: 'reflection', signature: 'mind_step' })!;
  await w.tick();
  await w.reply(0, { monologue: '用一个不存在的 id', decision: 'new', activity: { what: '不该关联', applying: 'k_missing', steps: [step()] } });
  assert.equal(w.mind.activity?.applying, 'k_missing', '保留明确声明的原 id');
  assert.equal(w.mind.activity?.applyingText, undefined, '找不到原文，快照未知');
  await w.finish(ok('走通了'));
  assert.equal(unrelated.wins, 0, '未解析的显式关联不能回退签名');
  assert.equal(unrelated.applications, undefined);
  const payload = JSON.parse(buildReflectionMessages(w.self, 'P', [], [], w.memory)[1].content.split('\n')[0]);
  const recent = payload.recent.find((entry: { applying?: string }) => entry.applying === 'k_missing');
  assert.equal(recent.applying_at_start, 'unknown', '旧记录缺快照时明确 unknown');
});

test('改写结论后，旧动作的结果不能替新结论验证', () => {
  const self = new SelfModel(null);
  const old = self.learn('站干岸浇水', { source: 'reflection', signature: 'pour', outcome: 'done' })!;
  const revised = self.learn('站干岸浇水，铁镐可以采收黑曜石', { source: 'reflection', revise: old.id })!;
  assert.equal(revised.signature, undefined);
  assert.equal(revised.unverified, true);
  self.record({ id: 'a', what: '浇水', kind: 'gather', outcome: 'done', summary: '', durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'pour', failures: 0 });
  assert.equal(revised.wins, 0);
  assert.equal(revised.unverified, true);
});

test('相同动作成功计入活动反馈，但不自动证实未验证的结论', () => {
  const self = new SelfModel(null);
  const lesson = self.learn('假设一种挖矿方法有效', { source: 'reflection', signature: 'dig' })!;
  self.record({ id: 'a', what: '挖矿', kind: 'gather', outcome: 'done', summary: '', durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'dig', failures: 0 });
  assert.equal(lesson.wins, 1);
  assert.equal(lesson.unverified, true);
});

test('回想：合并重复、丢掉被推翻的、证实的零碎想法变成窍门', async () => {
  const { parseConsolidation } = await import('../src/mind/thinker.ts');
  const self = new SelfModel(null);
  const a = self.learn('卡在坑里时先垫方块往上爬', { source: 'reflection', outcome: 'done' })!;
  const b = self.learn('掉进三格深的坑就往上垫两格出来', { source: 'reflection', outcome: 'done' })!;
  const c = self.learn('夜里一定要往水里跳躲怪', { source: 'reflection', outcome: 'stuck' })!;
  self.jot('桦木林边上常有羊');
  const parsed = parseConsolidation({ merge: [{ ids: [a.id, b.id, 'k_nope'], text: '掉进浅坑时原地垫方块爬出去（成2/败0）' }], drop: [c.id, a.id], add: ['桦木林边上常有羊'], diary: '今天学会了出坑' },
    new Set(self.data.knowHow.map((k) => k.id)), new Set());
  assert.deepEqual(parsed.drop, [c.id], '已合并的不能再被丢');
  const r = self.consolidate(parsed);
  assert.equal(r.before, 3);
  assert.ok(self.data.knowHow.some((k) => k.text === '掉进浅坑时原地垫方块爬出去' && k.wins === 0 && k.unverified));
  assert.ok(!self.data.knowHow.some((k) => k.id === c.id));
  assert.ok(self.data.knowHow.some((k) => k.text === '桦木林边上常有羊'));
  assert.equal(self.insights().length, 0);
  assert.equal(self.reflectionBacklog(), 0);
});

test('回想合并或改写结论不能继承旧做法的验证证据', () => {
  const self = new SelfModel(null);
  const old = self.learn('用水接触岩浆形成黑曜石', { source: 'reflection', signature: 'pour', outcome: 'done' })!;
  const guess = self.learn('铁镐可以采收黑曜石', { source: 'reflection' })!;
  self.record({ id: 'apply-old', what: '按旧结论做', kind: 'gather', applying: old.id, applyingText: old.text, outcome: 'done', summary: '按旧结论做成了', durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'other', failures: 0 });
  assert.equal(old.applications?.length, 1);
  self.consolidate({ merge: [{ ids: [old.id, guess.id], text: '用水接触岩浆形成黑曜石；铁镐可以采收' }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  assert.equal(old.wins, 0);
  assert.equal(old.unverified, true);
  assert.equal(old.signature, undefined);
  assert.equal(old.applications, undefined, '改写后的结论不能继承旧结论的应用证据');
  self.record({ id: 'a', what: '浇水', kind: 'gather', outcome: 'done', summary: '', durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'pour', failures: 0 });
  assert.equal(old.wins, 0, '重复旧做法不能验证加入的新结论');
  assert.equal(old.unverified, true);

  const original = self.learn('下矿时用镐挖石头', { source: 'reflection', signature: 'dig', outcome: 'done' })!;
  self.record({ id: 'apply-original', what: '按旧结论挖', kind: 'gather', applying: original.id, applyingText: original.text, outcome: 'stuck', summary: '按旧结论没挖通', durationSec: 1, gained: {}, lost: {}, at: Date.now(), signature: 'other', failures: 1 });
  assert.equal(original.applications?.length, 1);
  self.consolidate({ merge: [], rewrite: [{ id: original.id, text: '下矿时用镐挖石头，铁镐能采收黑曜石' }], drop: [], add: [], agendaDrop: [] });
  assert.equal(original.wins, 0);
  assert.equal(original.unverified, true);
  assert.equal(original.signature, undefined);
  assert.equal(original.applications, undefined);
});

test('回想完全保留同一结论及做法时仍可合并成败记录', () => {
  const self = new SelfModel(null);
  const first = self.learn('沿下坡前进', { source: 'reflection', signature: 'step', outcome: 'done' })!;
  self.data.knowHow.push({ ...first, id: 'other', wins: 2, losses: 1 });
  self.consolidate({ merge: [{ ids: [first.id, 'other'], text: first.text }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  assert.equal(first.wins, 3);
  assert.equal(first.losses, 1);
  assert.equal(first.unverified, false);
  assert.equal(first.signature, 'step');
});

test('附近失败提醒只报告新失败，等待冷却时间不会重复旧证据', () => {
  const att = new Attention();
  const here = { x: 0, y: 64, z: 0 };
  const now = Date.now();
  const failure = (i: number) => ({ pos: here, outcome: 'stuck' as const, skill: 'move_step', failureCode: 'PATH_NOT_FOUND',
    what: `迈上台阶 ${i}`, summary: `目标脚下是 air（尝试 ${i}）`, at: now - 4000 + i * 1000 });
  const recs = [1, 2, 3].map(failure);
  const timestamps = recs.map((r) => r.at);
  const first = att.fromLoop(recs, here, now);
  assert.ok(first);
  assert.equal(first.level, 'note');
  assert.equal(first.salience, 0.45);
  assert.match(first.what, /3.*step.*PATH_NOT_FOUND|step.*PATH_NOT_FOUND.*3/);
  assert.match(first.what, /目标脚下是 air/);
  assert.doesNotMatch(first.what, /卡住.*分钟|换.*(思路|目标|办法)/);
  att.drain();
  recs.push(failure(4));
  assert.equal(att.fromLoop(recs, here, now + 2000), null);
  assert.equal(att.fromLoop(recs, here, now + 5 * 60_000), null, '同一批失败不会在四分钟后重新报警');
  recs.push(failure(5));
  assert.equal(att.fromLoop(recs, here, now + 5 * 60_000), null);
  recs.push(failure(6));
  assert.ok(att.fromLoop(recs, here, now + 5 * 60_000), '再有三次新失败才形成下一批');
  assert.deepEqual(recs.slice(0, 3).map((r) => r.at), timestamps, '保留真实失败时间戳');
});

for (const boundary of ['pause', 'disconnect'] as const) test(`停止在线观察后旧失败不会再次报警：${boundary}`, async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const w = fixture(t);
  await w.tick();
  const records = [1, 2, 3].map((i) => ({ pos: { ...w.adapter.pos }, outcome: 'stuck' as const, skill: 'move_step',
    failureCode: 'PATH_NOT_FOUND', what: '迈上台阶', summary: '目标脚下是 air', at: now - 4000 + i * 1000 }));
  Reflect.set(w.mind, 'recentEnds', records);
  assert.ok(w.mind.attention.fromLoop(records, w.adapter.pos, now));
  if (boundary === 'pause') w.mind.pause();
  else { w.adapter.connected = false; w.mind.onDisconnected(); }
  assert.deepEqual(Reflect.get(w.mind, 'recentEnds'), []);
  assert.ok(w.mind.attention.peek().every((n) => !n.key.startsWith('loop:')));
  now += 5 * 60_000;
  if (boundary === 'pause') w.mind.resume();
  else w.adapter.connected = true;
  await w.tick();
  assert.ok(w.bus.recent().every((e) => e.type !== 'notice' || !/附近.*失败|一带.*卡住/.test(e.msg)));
});

test('每轮思考保留实际失败详情，不再推断持续卡住或强制换目标', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const w = fixture(t), state = w.adapter.state();
  const records = [1, 2, 3].map((i) => ({ pos: { ...state.pos }, outcome: 'stuck' as const, skill: 'move_step',
    failureCode: 'PATH_NOT_FOUND', what: '迈上台阶', summary: '目标脚下是 air', at: now - 4000 + i * 1000 }));
  Reflect.set(w.mind, 'recentEnds', records);
  Reflect.set(w.mind, 'recentActionFailures', [{ step: { skill: 'move_step', args: { at: [1, 1, 0] } }, code: 'PATH_NOT_FOUND',
    summary: '目标脚下是 air', pos: { ...state.pos }, worldId: state.worldId, sessionId: state.sessionId, dim: state.dim, at: records[2].at }]);
  await w.tick();
  const original = w.pending[0].messages.map((m) => m.content).join('\n');
  assert.match(original, /recent_action_failures/);
  assert.match(original, /目标脚下是 air/);
  assert.match(original, /"at":\[1,1,0\]/);
  assert.match(original, /observed_at/);
  assert.doesNotMatch(original, /stuck_here|必须换完全不同|别碰 repeated_failures|换区域、换目标|一带已经卡了/);
  await w.reply(0, { decision: 'new', activity: { what: '继续观察入口', steps: [step()] } });
  now += 5 * 60_000;
  w.mind.replan();
  await w.tick();
  const again = w.pending.at(-1)!.messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(again, /stuck_here|必须换完全不同|别碰 repeated_failures|换区域、换目标|一带已经卡了/);
  const notices = w.bus.recent().filter((e) => e.type === 'notice' && /附近.*失败/.test(e.msg));
  assert.equal(notices.length, 1, '每轮思考没有绕开事件去重再次提醒');
});

test('活动完成时立即撤掉旧失败提醒，不等下一次感知', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '走上台阶', steps: [step()] } });
  await w.tick();
  const now = Date.now();
  const records = [1, 2, 3].map((i) => ({ pos: { ...w.adapter.pos }, outcome: 'stuck' as const, skill: 'move_step',
    failureCode: 'PATH_NOT_FOUND', what: '迈上台阶', summary: '目标脚下是 air', at: now - 4000 + i * 1000 }));
  Reflect.set(w.mind, 'recentEnds', records);
  assert.ok(w.mind.attention.fromLoop(records, w.adapter.pos, now));
  await w.finish(ok('已走上台阶'));
  assert.ok(w.mind.attention.peek().every((n) => !n.key.startsWith('loop:')));
  assert.equal(w.self.history(1)[0].outcome, 'done');
  assert.equal(w.mind.attention.fromLoop(Reflect.get(w.mind, 'recentEnds'), w.adapter.pos, now + 5 * 60_000), null);
});

test('歇下来时在后台回想，整理窍门、写日记，不打断手上的事', async (t) => {
  const w = fixture(t);
  for (const s of ['桦木林边常有羊', '夜里坑里插火把就不刷怪', '石头在山坡露头处多', '腐肉很饿时才吃', '回家沿着来时的路走']) w.self.jot(s);
  const old = w.self.learn('夜里一定要往水里跳躲怪', { source: 'reflection', outcome: 'stuck' })!;
  await w.tick();
  await w.reply(0, { monologue: '歇会儿', decision: 'rest' });
  const before = w.pending.length;
  (w.mind as any).maybeReflect('歇下来了');
  assert.equal(w.pending.length, before + 1, '回想是一次独立的后台思考');
  assert.match(w.pending.at(-1)!.messages[0].content, /回想一下这段时间/);
  assert.ok(w.arbiter.info(), '手上的事照常进行');
  await w.reply(w.pending.length - 1, { drop: [old.id], add: ['夜里在坑里插火把就不刷怪'], diary: '今天在桦木林边过得挺安稳', monologue: '理清楚了' });
  assert.ok(!w.self.data.knowHow.some((k) => k.id === old.id));
  assert.ok(w.self.data.knowHow.some((k) => k.text === '夜里在坑里插火把就不刷怪'));
  assert.equal(w.self.insights().length, 0);
  assert.ok(w.self.diary(1)[0].text.includes('桦木林'));
});

test('思考时可以翻开技能书、请建筑师设计；图纸进入之后的思考，build 只要 draft ID', async (t) => {
  const { BUILTIN_SKILLS_DIR, SkillBook } = await import('../src/knowledge/skillbook.ts');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { draftsFor } = await import('../src/building/drafts.ts');
  const book = new SkillBook(BUILTIN_SKILLS_DIR, path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills'));
  const w = fixture(t, { book });
  draftsFor(w.memory);
  const md = fs.readFileSync(path.join(BUILTIN_SKILLS_DIR, 'architect', 'SKILL.md'), 'utf8');
  // 第一座房子要当天盖完：用省料的那张参考图（林间小屋太费料，会被要求改）
  const cottage = JSON.parse([...md.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)][1][1]);
  await w.tick();
  assert.match(w.pending[0].messages[0].content, /architect：/, '技能索引在提示词里');
  await w.reply(0, { kind: 'skill', name: 'homemaking' });
  assert.match(w.pending[1].messages.at(-1)!.content, /安家/);
  await w.reply(1, { kind: 'design', brief: '湖边能住的小家，云杉木' });
  assert.match(w.pending[2].messages[0].content, /建筑师/, '建筑师在独立上下文里设计');
  assert.match(w.pending[3].messages.at(-1)!.content, /已经请建筑师/, '设计在后台进行，心智不用干等');
  await w.reply(3, { monologue: '图纸要等一会儿，先攒云杉木', decision: 'new', activity: { what: '砍云杉', steps: [step()] } });
  assert.equal(w.mind.activity?.what, '砍云杉');
  await w.reply(2, { name: '湖边小屋', purpose: '住处', design: cottage });
  await setImmediate();
  const { activeDrafts } = await import('../src/building/drafts.ts');
  const id = activeDrafts()!.list(4)[0]?.id;
  assert.ok(id, '图纸画好了');
  await w.finish();
  await w.tick();
  assert.match(w.pending.at(-1)!.messages[1].content, new RegExp(id!), '没用过的图纸会出现在之后的思考里');
});

test('发现自己喜欢的东西会记成喜好，之后的思考里能看到', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '这片樱花林真好看', decision: 'new', liked: '樱花林', activity: { what: '看看风景', steps: [step()] } });
  assert.deepEqual(w.self.tastes(), ['樱花林']);
  w.mind.attention.notice('test_liked', '看看风景', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.match(w.pending.at(-1)!.messages[1].content, /樱花林/);
});

test('躲在坑里过夜时，一般的事不会把它叫起来重新想', async (t) => {
  const w = fixture(t);
  const previous = SKILLS.shelter;
  t.after(() => { SKILLS.shelter = previous; });
  SKILLS.shelter = { ...SKILLS.mind_step, name: 'shelter' };
  await w.tick();
  await w.reply(0, { monologue: '躲一晚', decision: 'new', activity: { what: '过夜', kind: 'rest', steps: [{ skill: 'shelter', args: {} }], next: undefined } });
  const n = w.pending.length;
  w.mind.attention.notice('night', '天黑了', 0.6);
  await w.tick();
  await w.tick();
  assert.ok(w.pending.length <= n + 1, '最多只有“想想接下来”的那一次');
  assert.ok(!w.pending.slice(n).some((p) => /注意到了一些事/.test(p.messages[1].content)));
});

test('回想时琢磨出的一整套做法会写成自己的技能', async (t) => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BUILTIN_SKILLS_DIR, SkillBook } = await import('../src/knowledge/skillbook.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-self-skills-'));
  const book = new SkillBook(BUILTIN_SKILLS_DIR, dir);
  const w = fixture(t, { book });
  for (const s of ['山坡上先垫平', '墙基做高一层', '门开高的一边', '低的一边加柱子', '屋檐朝坡下']) w.self.jot(s);
  await w.tick();
  await w.reply(0, { monologue: '歇会儿', decision: 'rest' });
  (w.mind as any).maybeReflect('歇下来了');
  await w.reply(w.pending.length - 1, { skill: { name: 'hillside-house', description: '在山坡上盖房子', body: '1. 低的一边用圆石垫平\n2. 墙基做高一层\n3. 门开在高的一边，屋檐朝坡下' }, diary: '学会了在山坡上盖房' });
  assert.equal(book.get('hillside-house')?.source, 'self');
  assert.ok(fs.existsSync(path.join(dir, 'hillside-house', 'SKILL.md')));
});

test('提示词：盖房的念头会在消息末尾提醒先请建筑师；瞥一眼也知道 design；图纸参数不会被原样展开', async () => {
  const { argsLabel } = await import('../src/mind/activity.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  self.addAgenda('在河边盖一间小屋', 'goal', 'today');
  const base = { reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: ['architect：设计建筑'] };
  for (const tier of ['deliberate', 'glance'] as const) {
    const [system, user] = buildMindMessages({ ...base, tier });
    assert.match(system.content, /"kind":"design"/, `${tier} 也知道请建筑师`);
    assert.match(user.content, /【此刻要留意】[\s\S]*(design|draft)[\s\S]*只输出一个 JSON 对象。$/, '提醒放在消息最后');
  }
  const [deliberate] = buildMindMessages({ ...base, tier: 'deliberate' });
  assert.ok(deliberate.content.length <= 30000, `认真想的系统提示词 ${deliberate.content.length} 字`);
  assert.match(deliberate.content, /其他动作（用 \{"kind":"moves"/);
  const label = argsLabel({ skill: 'build', args: { spec: { name: '小屋', width: 5, depth: 5, design: { legend: {}, layers: [['PPP']] }, components: Array(100).fill({}) } } });
  assert.ok(label.length < 80 && /小屋/.test(label) && !/components/.test(label), label);
  memory.close();
});

test('思考时可以查动作的完整参数', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { kind: 'moves', names: ['use_item', 'boat_path'] });
  assert.match(w.pending[1].messages.at(-1)!.content, /- boat_path /);
});

test('被困地下时，模型用原子动作写一段挖阶梯的 routine，身体照着一格格执行直到见天', async (t) => {
  const w = fixture(t);
  w.adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  (w.adapter as any).removed.add('0,60,0'); (w.adapter as any).removed.add('0,61,0');
  await w.tick();
  const user = w.pending[0].messages[1].content;
  assert.match(user, /"local":/, '身边方块图在提示词里');
  assert.match(w.pending[0].messages[0].content, /mine_cell/, '模型可以自行选择挖掘动作');
  assert.doesNotMatch(user, /怎么上去自己定|一格一格自己出去/, '地形不会替模型决定要出去');
  await w.reply(0, { monologue: '四面都是石头，朝北挖阶梯上去', decision: 'new', activity: { what: '朝北挖阶梯回地面', facing: 'N', kind: 'survive', repeat: 10,
    steps: [{ skill: 'mine_cell', args: { at: [0, 2, 0], facing: 'N', allowUnknownAdjacent: true } }, { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'N', allowUnknownAdjacent: true } }, { skill: 'mine_cell', args: { at: [1, 2, 0], facing: 'N', allowUnknownAdjacent: true } }, { skill: 'move_step', args: { at: [1, 1, 0], facing: 'N' } }],
    done_when: { type: 'sky_visible', equals: true } } });
  const deadline = Date.now() + 15000;
  while (w.self.history(1).length === 0 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 30)); await w.tick(); }
  const rec = w.self.history(1)[0];
  assert.ok(rec, '这段活结束了');
  assert.equal(rec.outcome, 'done', rec.summary);
  assert.ok(w.adapter.pos.y >= 63, `回到了地表、头顶见天（y=${w.adapter.pos.y}）`);
});

test('游戏的系统消息进记忆：死亡播报写进日记和念头，之后的思考能看到原话', async (t) => {
  const { parseGameMessage } = await import('../src/memory/game-messages.ts');
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '探洞', decision: 'new', activity: { what: '探洞', steps: [step()] } });
  w.mind.onDeath({ cause: 'unknown' });
  w.mind.onGameMessage(parseGameMessage('FakeBot was blown up by Creeper', 'FakeBot'));
  assert.ok(w.self.diary(1)[0].text.includes('blown up by Creeper'), '日记里有游戏原话');
  assert.ok(w.self.recentThoughts().some((x) => x.text.includes('[游戏] FakeBot was blown up by Creeper')));
  w.mind.onGameMessage(parseGameMessage('FakeBot has made the advancement [Stone Age]', 'FakeBot'));
  assert.ok(w.self.diary(1)[0].text.includes('Stone Age'));
  await new Promise((r) => setTimeout(r, 1600));
  await w.tick();
  const user = w.pending.at(-1)!.messages[1].content;
  assert.match(user, /"game_messages":\[[^\]]*blown up by Creeper/);
  assert.match(user, /Creeper/);
});

test('死亡时已经有游戏播报：直接按原话记，不用推测的死因', async (t) => {
  const w = fixture(t);
  w.mind.onDeath({ cause: 'fall', message: 'FakeBot was slain by Zombie' });
  assert.ok(w.self.diary(1)[0].text.includes('slain by Zombie'));
});

test('手上没活却写 continue：带着 activity 或 next 就当成新的一段；把 design 写成步骤会被认成查询', () => {
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter();
  const a = parseDecision({ decision: 'continue', monologue: '接着走', activity: { what: '看看四周', steps: [{ skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
  assert.ok(!('error' in a) && a.kind === 'new' && a.activity?.what === '看看四周');
  const n = parseDecision({ decision: 'continue', monologue: '接着走', next: { what: '再看看', steps: [{ skill: 'look_around', args: { seconds: 2 } }] } }, adapter, memory, false);
  assert.ok(!('error' in n) && n.kind === 'new' && n.activity?.what === '再看看' && !n.next);
  assert.deepEqual(embeddedQuery({ activity: { what: '设计湖边小屋', steps: [{ skill: 'design' }, { skill: 'build' }] } }), { kind: 'design', args: { brief: '设计湖边小屋' } });
  assert.equal(embeddedQuery({ activity: { what: '砍树', steps: [{ skill: 'gather' }] } }), null);
});

test('说着 continue 却写了一段新的活：要求澄清', () => {
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter();
  const d = parseDecision({ decision: 'continue', monologue: '趁空做点别的', activity: { what: '做木板', steps: [{ skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, true, '在坑里等到天亮');
  assert.ok('error' in d && /continue.*adjust.*next/.test(d.error));
  // 同名同技能也不行：continue 只按原 routine 原参数执行，写 activity（哪怕只改了参数）会让执行哪一套含糊。
  const same = parseDecision({ decision: 'continue', monologue: '接着等', activity: { what: '在坑里等到天亮', steps: [{ skill: 'look_around', args: { seconds: 9 } }] } }, adapter, memory, true, '在坑里等到天亮');
  assert.ok('error' in same && /省略 activity.*adjust/.test(same.error));
});

test('写错被丢掉的步骤会记下来，心智看得到它们根本没做', () => {
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter();
  const d = parseDecision({ decision: 'new', monologue: '放床', activity: { what: '放床', steps: [{ skill: 'no_such_skill', args: { item: 'white_bed' }, optional: true }, { skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
  assert.ok(!('error' in d) && d.activity?.dropped?.[0]?.startsWith('no_such_skill'));
  const a = createActivity(d.activity!, '放床', 'llm', adapter.state());
  assert.ok(a.dropped?.length === 1);
});

test('身体习惯由模型定：解析 habits，0/false 关掉，合并后长期有效', async () => {
  const { parseHabits } = await import('../src/mind/thinker.ts');
  assert.deepEqual(parseHabits({ torch_every: 8, eat_below: 30, pickup: true }), { torch_every: 8, eat_below: 19, pickup: true });
  assert.equal(parseHabits({ nonsense: 1 }), null);
  const self = new SelfModel(null, ['好奇']);
  assert.deepEqual(self.setHabits({ torch_every: 8, pickup: true }), ['torch_every=8', 'pickup=true']);
  assert.deepEqual(self.setHabits(parseHabits({ torch_every: 0 })!), ['torch_every=0']);
  assert.deepEqual(self.habits(), { pickup: true });
});

test('白天站在地表、天光数据没更新时，不会误报“周围很暗”；提示词按块分好、此刻放在最后', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  adapter.light = 2; // 客户端天光读数没更新
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const p = perception.update();
  assert.equal(p.light?.level, 'bright');
  assert.equal(p.light?.mob_spawn_risk, false);
  const self = new SelfModel(null);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: p, state: adapter.state(), self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  const order = ['【我】', '【记得的地方】', '【最近】', '【手上的活】', '【身边】', '【身体】', '【此刻】'].map((h) => user.content.indexOf(h));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `分块顺序 ${order}`);
  assert.match(user.content, /【身边】\{"local":/);
  assert.match(user.content, /【身体】\{"where":"在地表/);
  memory.close();
});

test('工地附近的坐标能当收工位置', async () => {
  const { validateCondition } = await import('../src/projects/conditions.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  memory.addLandmark('base', '基地 1', 'overworld', { x: 19, y: 76, z: 22 });
  assert.doesNotThrow(() => validateCondition({ type: 'location_near', dimension: 'overworld', pos: { x: 12, y: 75, z: 20 }, radius: 6 }, adapter, memory, adapter.state()));
  assert.throws(() => validateCondition({ type: 'location_near', dimension: 'overworld', pos: { x: 300, y: 75, z: 20 }, radius: 6 }, adapter, memory, adapter.state()));
  memory.close();
});

test('操作者的指令：放在最前面、一直挂着；只是 continue 不回应就再想一次；照做时不受专注限制；回应 done 才撤下', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砌墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  w.mind.suggest('！先去挖矿');
  assert.equal(w.mind.order?.kind, 'order', '以“！”开头的是指令');
  await w.tick();
  const first = w.pending.at(-1)!;
  assert.match(first.messages[0].content, /【操作者的指令】：优先于自己的主目标/);
  assert.match(first.messages[1].content, /^【操作者的指令】\{"order":"先去挖矿"/);
  assert.match(first.messages[1].content, /【此刻要留意】\n- 操作者的指令「先去挖矿」刚收到/);
  await w.reply(w.pending.length - 1, { monologue: '我还是想先砌墙', decision: 'continue' });
  assert.equal(w.mind.order?.status, 'new', '没照做也没回应：指令还在');
  await w.tick();
  const again = w.pending.at(-1)!;
  assert.match(again.messages[1].content, /没有照做也没有回应/);
  await w.reply(w.pending.length - 1, { monologue: '好，去挖矿', decision: 'switch', operator: { status: 'doing' }, activity: { what: '挖矿', steps: [step(7)] } });
  assert.equal(w.mind.order?.status, 'doing');
  assert.equal(w.mind.activity?.what, '挖矿', '刚收到的指令：瞥一眼也能整个换掉手上的事');
  await w.tick();
  assert.match(w.pending.at(-1)?.messages[1].content ?? '', /操作者的指令|.*/);
  assert.equal(w.mind.order?.activityId, w.mind.activity?.id, '记下为指令开的那段活');
  await w.finish();
  assert.equal(w.mind.order, null, '那段活做完了，指令就算完成，不用一直挂着');
});

test('操作者的建议：想一次，采纳或不采纳都行，之后就放下（不追问、不一直挂着）', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砌墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  w.mind.suggest('要不去看看那边的村庄');
  assert.equal(w.mind.order?.kind, 'suggestion');
  await w.tick();
  const msg = w.pending.at(-1)!.messages[1].content;
  assert.match(msg, /^【操作者的建议】/);
  assert.doesNotMatch(msg, /【操作者的指令】/);
  const before = w.pending.length;
  await w.reply(w.pending.length - 1, { monologue: '先把墙砌完', decision: 'continue', operator: { status: 'declined', note: '墙快好了' } });
  assert.equal(w.mind.order, null, '没采纳就放下了');
  await w.tick();
  for (const p of w.pending.slice(before)) assert.doesNotMatch(p.messages[1].content, /操作者的(建议|指令)/, '不会因为没采纳再追问、也不再挂在提示里');
  assert.equal(w.mind.activity?.what, '砌墙');
});

test('同一步失败三次后仍执行 Agent 明确选择的重试，并提示历史', async (t) => {
  const w = fixture(t);
  await w.tick();
  for (let i = 0; i < 3; i++) {
    await w.reply(w.pending.length - 1, { monologue: '补屋顶', decision: 'new', activity: { what: '照图纸补屋顶', steps: [step(3)] } });
    await w.tick();
    assert.deepEqual(w.arbiter.info()?.args, { n: 3 }, `第 ${i + 1} 次照常做`);
    await w.finish(fail('ERROR', `尚未验收（还差 ${53 - i} 处）`));
    await w.tick();
  }
  await w.reply(w.pending.length - 1, { monologue: '再试一次', decision: 'new', activity: { what: '照图纸补屋顶', steps: [step(3)] } });
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 3 }, '第四次仍按选择执行');
  assert.match(w.bus.recent().filter((e) => e.type === 'notice').at(-1)?.msg ?? '', /此前出现 3 次同类失败/);
});

test('再次决策时提供附近实际失败动作的参数、结果、位置和时间', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '尝试动作', steps: [step(3)] } });
  await w.tick();
  const position = { ...w.adapter.pos };
  await w.finish(fail('BAD_ARGS', '目标脚下是 air'));
  await w.tick();
  let current = JSON.parse(w.pending.at(-1)!.messages[1].content.split('\n').find((line) => line.startsWith('【此刻】'))!.slice('【此刻】'.length));
  assert.equal(current.recent_action_failures.note, '动作结束时的实际反馈，位置和环境可能随后改变');
  assert.deepEqual(current.recent_action_failures.entries[0], { skill: 'mind_step', args: { n: 3 }, failure_code: 'BAD_ARGS',
    summary: '目标脚下是 air', position, observed_at: current.recent_action_failures.entries[0].observed_at,
    scope: 'step', implication: '这次失败只否定这个动作/落点，不否定其他方向、其他来源或整个维度' });
  assert.ok(Number.isFinite(Date.parse(current.recent_action_failures.entries[0].observed_at)));
  await w.reply(w.pending.length - 1, { decision: 'new', activity: { what: '再次尝试', steps: [step(4)] } });
  await w.tick();
  await w.finish(fail('BAD_ARGS', '目标仍然是 air'));
  await w.tick();
  current = JSON.parse(w.pending.at(-1)!.messages[1].content.split('\n').find((line) => line.startsWith('【此刻】'))!.slice('【此刻】'.length));
  assert.deepEqual(current.recent_action_failures.entries.map((e: { args: unknown }) => e.args), [{ n: 3 }, { n: 4 }]);
});

test('失败反馈只包含近期同一会话附近的最近六次', async (t) => {
  const w = fixture(t), state = w.adapter.state(), now = Date.now();
  const entry = (n: number) => ({ step: step(n), code: 'BAD_ARGS', summary: `失败 ${n}`, pos: { ...state.pos },
    worldId: state.worldId, sessionId: state.sessionId, dim: state.dim, at: now });
  (w.mind as any).recentActionFailures = [
    ...Array.from({ length: 8 }, (_, i) => entry(i)),
    { ...entry(8), worldId: 'other-world' }, { ...entry(9), sessionId: 'other-session' },
    { ...entry(10), dim: 'other-dimension' }, { ...entry(11), pos: { ...state.pos, x: state.pos.x + 9 } },
    { ...entry(12), at: now - Mind.SAME_FAIL_MS - 1 },
  ];
  await w.tick();
  const current = JSON.parse(w.pending.at(-1)!.messages[1].content.split('\n').find((line) => line.startsWith('【此刻】'))!.slice('【此刻】'.length));
  assert.deepEqual(current.recent_action_failures.entries.map((e: { args: { n: number } }) => e.args.n), [2, 3, 4, 5, 6, 7]);
});

for (const scenario of ['same', 'position', 'direction', 'pitch', 'parameters', 'code', 'reason', 'world', 'session', 'dimension', 'expired', 'danger', 'water', 'lava', 'urgent'] as const) test(`重复失败的思考级别：${scenario}`, async (t) => {
  const w = fixture(t);
  await w.tick();
  const activity = { what: '尝试动作', steps: [step(3)] };
  await w.reply(0, { decision: 'new', activity });
  await w.tick();
  await w.finish(fail('BAD_ARGS', '目标不在当前视野'));
  await w.tick();
  assert.equal(w.bus.recent().filter((e) => e.type === 'llm_request').at(-1)?.data?.tier, 'deliberate');
  if (scenario === 'direction' || scenario === 'pitch') {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3001 });
    await w.tick();
    assert.equal(w.arbiter.info()?.source, 'filler', '等待答复时身体只在自动张望');
    await w.adapter.look(w.adapter.yaw + (scenario === 'direction' ? 0.16 : 0), w.adapter.pitch + (scenario === 'pitch' ? 0.16 : 0));
  }
  await w.reply(w.pending.length - 1, { decision: 'new', activity: scenario === 'parameters' ? { ...activity, steps: [step(4)] } : activity });
  await w.tick();
  if (scenario === 'position') w.adapter.pos.x += 1;
  if (scenario === 'world') w.adapter.worldId = 'other-world';
  if (scenario === 'session') w.adapter.sessionId = 'other-session';
  if (scenario === 'dimension') w.adapter.dim = 'the_nether';
  if (scenario === 'expired') t.mock.timers.enable({ apis: ['Date'], now: Date.now() + Mind.SAME_FAIL_MS + 1 });
  if (scenario === 'danger') w.adapter.hp = 10;
  if (scenario === 'water') w.adapter.inWater = true;
  if (scenario === 'lava') w.adapter.inLava = true;
  if (scenario === 'urgent') w.mind.attention.notice('test_urgent', '有紧急情况需要处理', 1, 0);
  await w.finish(fail(scenario === 'code' ? 'UNKNOWN_ITEM' : 'BAD_ARGS', scenario === 'reason' ? '目标已经消失' : '目标不在当前视野'));
  await w.tick();
  const request = w.bus.recent().filter((e) => e.type === 'llm_request').at(-1);
  const repeated = scenario === 'same' || scenario === 'direction' || scenario === 'pitch';
  assert.equal(request?.data?.tier, repeated ? 'glance' : 'deliberate');
  if (repeated) {
    assert.match(request?.msg ?? '', /刚才相同动作也失败：目标不在当前视野/);
    await w.reply(w.pending.length - 1, { kind: 'deliberate', reason: '需要想清楚' });
    assert.equal(w.bus.recent().filter((e) => e.type === 'llm_escalate').length, 1, 'Agent 可主动升级为认真想');
  }
});

for (const scenario of ['gaze', 'target', 'facing'] as const) test(`相对迈步重复失败按动作目标而非镜头判断：${scenario}`, async (t) => {
  const w = fixture(t), previous = SKILLS.move_step;
  SKILLS.move_step = { ...previous, run: SKILLS.mind_step.run };
  t.after(() => { SKILLS.move_step = previous; });
  const activity = { what: '尝试下一级', facing: 'N', steps: [{ skill: 'move_step', args: { at: [1, -1, 0] } }] };
  const failure = fail('PATH_NOT_FOUND', '目标脚下没有支撑', { movementNotAttempted: true });
  await w.tick();
  await w.reply(0, { decision: 'new', activity });
  await w.finish(failure);
  await w.tick();
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, 'deliberate');
  w.adapter.yaw += 0.16;
  w.adapter.pitch += 0.16;
  await w.reply(w.pending.length - 1, { decision: 'new', activity: {
    ...activity,
    ...(scenario === 'facing' ? { facing: 'W' } : {}),
    ...(scenario === 'target' ? { steps: [{ skill: 'move_step', args: { at: [0, -1, 1] } }] } : {}),
  } });
  await w.finish(failure);
  await w.tick();
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, scenario === 'gaze' ? 'glance' : 'deliberate');
});

test('盖房、走路这类事做着做着挨了打，又没有技能接手：先停下、马上认真想（不边挨打边砌墙）', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砌墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 });
  (w.mind as any).d.perception.snapshot = () => ({ nearby: { hostile: [{ name: 'zombie', dist: 2, how: 'seen' }] } });
  w.adapter.hp = 15;
  w.bus.publish('hurt', 'P1', '受到伤害，生命 15');
  await new Promise((r) => setTimeout(r, 800));
  await flush();
  assert.equal(w.arbiter.info()?.source === 'llm', false, '手上的事停了');
  await w.tick();
  assert.match(w.pending.at(-1)!.messages[1].content, /挨打了/);
  assert.notDeepEqual(w.arbiter.info()?.args, { n: 2 }, '想好之前不接着做');
});

test('步骤做完、收工条件没达到：提前想好的下一段不照接，回头重新想', async (t) => {
  const w = fixture(t);
  const statuses: string[] = [], events: any[] = [];
  const recorded = t.mock.method(w.memory, 'recordGoal');
  (w.mind as any).d.onGoalEnd = (status: string) => statuses.push(status);
  w.bus.on('event', (event) => { if (event.type === 'attempt_end') events.push(event); });
  await w.tick();
  await w.reply(0, { monologue: '挖条巷子找铁', decision: 'new', activity: { what: '开巷找铁', steps: [step(1)], done_when: { type: 'inventory_min', item: 'raw_iron', count: 1 } },
    next: { what: '把铁烧成锭', steps: [step(2)] } });
  assert.equal(w.mind.activity?.what, '开巷找铁');
  assert.ok(w.mind.queuedNext);
  const learned = w.self.learn('开巷找铁的做法', { kind: 'gather', signature: signatureOf(w.mind.activity!.steps), source: 'reflection' })!;
  (w.mind as any).order = { text: '找铁', status: 'doing', kind: 'order', at: Date.now(), activityId: w.mind.activity!.id };
  const before = w.pending.length;
  await w.finish();
  await w.tick();
  const record = w.self.history(1)[0];
  assert.equal(record.outcome, 'unmet');
  assert.equal(record.completion, 'unmet');
  assert.match(record.summary, /收工条件未满足或无法确认/);
  assert.match(record.summary, /raw_iron/);
  assert.equal(recorded.mock.calls[0].arguments[0].status, 'condition_unmet');
  assert.deepEqual(statuses, ['condition_unmet']);
  assert.equal(events[0].data.status, 'condition_unmet');
  assert.equal(events[0].data.outcome, 'unmet');
  assert.equal(learned.wins, 0);
  assert.equal((w.mind as any).order.text, '找铁');
  assert.equal(w.self.diary(1).length, 0);
  assert.notEqual(w.mind.activity?.what, '把铁烧成锭');
  assert.equal(w.mind.queuedNext, null);
  assert.ok(w.pending.length > before, '要回头想');
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /先不接着做/);
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, 'glance');
  await w.reply(w.pending.length - 1, { kind: 'deliberate', reason: '需要更多上下文' });
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_escalate').length, 1, 'Agent 仍能主动升级认真想');
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /收工条件未满足/);
});

test('思考期间活动卡住，丢弃基于旧状态的答复并把失败和注意事项交给下一次思考', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '找铁', steps: [step(1), step(2)] } });
  w.mind.attention.notice('test_notice', '旁边有一个箱子', 0.4, 0);
  (w.mind as any).think('回顾这一阶段', 'deliberate');
  assert.equal(w.pending.length, 2);
  await w.finish(fail('MISSING_MATERIALS', '缺少石镐'));
  await w.reply(1, { decision: 'switch', activity: { what: '旧决定', steps: [step(3)] } });
  assert.notEqual(w.mind.activity?.what, '旧决定');
  await w.tick();
  assert.equal(w.pending.length, 3);
  assert.match(JSON.stringify(w.pending[2].messages), /缺少石镐/);
  assert.match(JSON.stringify(w.pending[2].messages), /旁边有一个箱子/);
  await w.reply(2, { decision: 'new', activity: { what: '处理缺口', steps: [step(4)] } });
  assert.equal(w.mind.activity?.what, '处理缺口');
});

test('思考期间收工条件未满足，重新思考实际结果', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '找铁', steps: [step(1)], done_when: { type: 'inventory_min', item: 'raw_iron', count: 1 } } });
  (w.mind as any).think('注意到新的事情', 'glance');
  assert.equal(w.pending.length, 2);
  await w.finish();
  await w.reply(1, { decision: 'new', activity: { what: '旧决定', steps: [step(3)] } });
  assert.notEqual(w.mind.activity?.what, '旧决定');
  await w.tick();
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /收工条件未满足/);
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, 'glance');
});

test('收工条件无法确认时保留认真想', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '检查方块', steps: [step(1)], done_when: {
    type: 'block_state', dimension: w.adapter.state().dim, pos: { x: 1000, y: 64, z: 1000 }, name: 'stone',
  } } });
  await w.finish();
  await w.tick();
  assert.equal(w.self.history(1)[0].outcome, 'unmet');
  assert.match(JSON.stringify(w.pending.at(-1)!.messages), /状态 unknown/);
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, 'deliberate');
});

test('收工条件未达到且需要全局判断时仍认真想', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '找铁', steps: [step(1)], done_when: { type: 'inventory_min', item: 'raw_iron', count: 1 } } });
  (w.mind as any).lastDeliberateAt = 0;
  await w.finish();
  await w.tick();
  assert.equal(w.self.history(1)[0].outcome, 'unmet');
  assert.equal(w.bus.recent().filter((event) => event.type === 'llm_request').at(-1)?.data?.tier, 'deliberate');
});

test('活动卡住时保留正在处理的危险和操作者指令', async (t) => {
  for (const kind of ['danger', 'order'] as const) {
    const w = fixture(t);
    await w.tick();
    await w.reply(0, { decision: 'new', activity: { what: '找铁', steps: [step(1), step(2)] } });
    if (kind === 'order') (w.mind as any).order = { text: '回家', status: 'new', kind: 'order', at: Date.now() };
    (w.mind as any).think(kind === 'danger' ? Mind.DANGER_REASON : '操作者下了指令', 'deliberate');
    await w.finish(fail('MISSING_MATERIALS', '缺少石镐'));
    assert.equal(w.mind.inFlight, true, `${kind} 应继续处理`);
    assert.match((w.mind as any).pendingReason.reason, /缺少石镐/);
  }
});

test('stopping on a condition preserves evidence while following the queued activity', async (t) => {
  const w = fixture(t), statuses: string[] = [];
  const recorded = t.mock.method(w.memory, 'recordGoal');
  (w.mind as any).d.onGoalEnd = (status: string) => statuses.push(status);
  await w.tick();
  await w.reply(0, { monologue: '下去看看', decision: 'new', activity: { what: '下到 y30', steps: [step(1)],
    done_when: { type: 'inventory_min', item: 'oak_log', count: 1 } }, next: { what: '接下来的事', steps: [step(2)] } });
  assert.ok(w.mind.queuedNext);
  (w.mind as any).order = { text: '下到 y30', status: 'doing', kind: 'order', at: Date.now(), activityId: w.mind.activity!.id };
  w.adapter.inv.set('oak_log', 1);
  await w.finish();
  await w.tick();
  const record = w.self.history(1)[0];
  assert.equal(record.completion, 'condition');
  assert.match(record.summary, /inventory_min/);
  assert.match(record.summary, /64\.0/);
  assert.equal(recorded.mock.calls[0].arguments[0].status, 'condition_met');
  assert.deepEqual(statuses, ['condition_met']);
  assert.equal((w.mind as any).order.text, '下到 y30', 'a stop condition does not mark the operator instruction complete');
  assert.equal(w.self.diary(1).length, 0, 'a stop condition does not write a goal-completion diary');
  assert.ok(w.self.recentThoughts().some((x) => x.text.includes('收工条件满足') && x.text.includes('64.0')));
  assert.equal(w.mind.queuedNext, null);
  assert.equal(w.mind.activity?.what, '接下来的事');
});

test('提示词：白天想着躲起来过夜不再报“离天黑还有多久”；状态里的时间只有太阳在哪', async () => {
  const { situationalReminders } = await import('../src/mind/prompt.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const base = { reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', tier: 'glance' as const };
  const hiding = situationalReminders({ ...base, activity: { what: '就地挖坑封顶过夜', why: '离天黑不远了' } } as any);
  assert.ok(!hiding.some((r) => /离天黑|天黑还有|动身|躲/.test(r)), hiding.join('\n'));
  const [, user] = buildMindMessages({ ...base, activity: null } as any);
  assert.match(user.content, /太阳刚升起不久/);
  assert.ok(!/离天黑|时长是现实时间|早上 7 点/.test(user.content));
  const percept = { ...base.percept, death_recovery: { dir: 'N', dist: 20, lost: 'stone×1', seconds_left: 50 } };
  const [, timed] = buildMindMessages({ ...base, percept, state: { ...adapter.state(), effects: [{ name: 'speed', level: 1, seconds: 50 }] }, activity: null } as any);
  assert.match(timed.content, /估计还剩约 50 秒现实时间；实际状态未知/);
  assert.match(timed.content, /剩余时间按正常速度估算为约 50 秒现实时间/);
  const [, expired] = buildMindMessages({ ...base, percept: { ...percept, death_recovery: { ...percept.death_recovery, seconds_left: 0 } }, activity: null } as any);
  assert.match(expired.content, /估算已过常规寿命；实际状态未知/);
  memory.close();
});

test('提示词：【身体】写出身上穿戴的盔甲和副手（不在背包里，不写它就以为没穿）', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const base = { reason: '测试', percept: perception.update(), self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'deliberate' as const };
  const body = (state: any) => buildMindMessages({ ...base, state } as any)[1].content.match(/【身体】(.*)/)![1];
  const bare = JSON.parse(body({ ...adapter.state(), equipment: [] }));
  assert.deepEqual(bare.wearing, { 头: '空', 胸: '空', 腿: '空', 脚: '空', 副手: '空' });
  const dressed = JSON.parse(body({ ...adapter.state(), equipment: [
    { slot: 'head', name: 'iron_helmet', durabilityRemaining: 165, durabilityMax: 165 }, { slot: 'torso', name: 'iron_chestplate', durabilityRemaining: 240, durabilityMax: 240 },
    { slot: 'legs', name: 'iron_leggings' }, { slot: 'feet', name: 'iron_boots', durabilityRemaining: 195, durabilityMax: 195 }] }));
  assert.deepEqual(dressed.wearing, { 头: 'iron_helmet（耐久 165/165）', 胸: 'iron_chestplate（耐久 240/240）', 腿: 'iron_leggings', 脚: 'iron_boots（耐久 195/195）', 副手: '空' });
});

test('提示词：背包里的护甲和空槽并列写出，避免把背包里的护甲当成已穿戴', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const state = { ...adapter.state(), equipment: [{ slot: 'torso', name: 'iron_chestplate', durabilityRemaining: 15, durabilityMax: 240 }],
    inventory: [{ name: 'iron_boots', count: 1, durability: { left: 20, max: 195 }, durabilities: [20] },
      { name: 'iron_chestplate', count: 1, durability: { left: 4, max: 240 }, durabilities: [4] }] };
  const [, user] = buildMindMessages({ reason: '测试', percept: perception.update(), state, self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'deliberate' } as any);
  const body = JSON.parse(user.content.match(/【身体】(.*)/)![1]);
  assert.equal(body.wearing['脚'], '空');
  assert.match(body.wearables_in_backpack, /iron_boots（耐久 20\/195，快坏了），脚槽空着/);
  assert.match(body.wearables_in_backpack, /iron_chestplate（耐久 4\/240，快坏了），胸槽现穿着 iron_chestplate（耐久 15\/240）/);
  assert.match(body.mergeable_gear, /iron_chestplate 2 件（背包 4\/240、身上 15\/240）/);
  assert.match(body.mergeable_gear, /min\(满耐久, 两件耐久之和 \+ 满耐久5%\)/);
  assert.match(body.mergeable_gear, /多出的耐久会被丢掉、合计耐久反而下降/);
  memory.close();
});

test('提示词区分背包空槽与物品的堆叠上限', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = { ...perception.update(), emptySlots: 4 };
  const state = { ...adapter.state(), emptySlots: 4, inventory: [{ name: 'raw_iron', count: 4, stackSize: 64 }, { name: 'bucket', count: 2, stackSize: 16 }] };
  const [, user] = buildMindMessages({ reason: '测试', percept, state, self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'deliberate' } as any);
  const body = JSON.parse(user.content.match(/【身体】(.*)/)![1]);
  assert.equal(body.empty_slots, '4 个空槽（每槽放一叠，不是一件）');
  assert.deepEqual(body.inventory, ['raw_iron×4（每叠上限 64）', 'bucket×2（每叠上限 16）']);
  assert.match(body.inventory_space, /4 个空槽由所有物品共用/);
  assert.match(body.inventory_space, /64 个铁矿石只占 1 个空槽/);
  memory.close();
});

test('维度名译成中文，非主世界时额外提醒不是主世界', () => {
  for (const [dim, zh] of [['the_nether', '下界'], ['the_end', '末地']] as const) {
    const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
    adapter.dim = dim;
    const perception = new Perception(adapter, memory, bus, new Vision(adapter));
    const percept = perception.update();
    const state = adapter.state();
    const [, user] = buildMindMessages({ reason: '测试', percept, state, self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
      noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'deliberate' } as any);
    const body = JSON.parse(user.content.match(/【身体】(.*)/)![1]);
    assert.equal(body.dim, `${zh}（${dim}）`);
    assert.equal(body.time, `${zh}没有昼夜（光照恒定）`);
    assert.match(user.content, new RegExp(`你在${zh}，不是主世界`));
    assert.match(user.content, /火把只能照明，不能像主世界那样靠光拦住刷怪/);
    memory.close();
  }
});

test('要命的处境（头被沙砾埋住、正在掉血）：撤掉正在慢慢想的，马上快想一次，并告诉它眼前的事实', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.pending.length, 1, '先在认真想');
  const s = w.adapter.state();
  w.adapter.blocks.push({ name: 'gravel', pos: { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1.62), z: Math.floor(s.pos.z) } });
  w.bus.publish('hurt', 'P2', '受到伤害，生命 9（当时：身体碰着 gravel）');
  (w.mind as any).lastPerceptAt = 0;
  await w.tick();
  assert.equal(w.pending.length, 2, '马上又想了一次');
  assert.equal(w.pending[1].hint?.tier, 'light', '用快的那一档');
  const user = w.pending[1].messages.at(-1)!.content;
  assert.match(user, /头被 gravel 埋住了，正在窒息掉血/);
});

test('决定里有可选步骤写错：当场退回去让它改一次（改了用新的，说不要就用原来的）', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '先这样', decision: 'new', activity: { what: '两步活', steps: [step(1), { skill: 'use_skill', args: {}, optional: true }] } });
  assert.equal(w.pending.length, 2, '退回去改');
  assert.match(w.pending[1].messages.at(-1)!.content, /执行时会被丢掉.*keep/s);
  await w.reply(1, { monologue: '改好了', decision: 'new', activity: { what: '两步活', steps: [step(1), step(2)] } });
  assert.equal(w.mind.activity?.steps.length, 2);

  const v = fixture(t);
  await v.tick();
  await v.reply(0, { monologue: '先这样', decision: 'new', activity: { what: '一步活', steps: [step(1), { skill: 'use_skill', args: {}, optional: true }] } });
  await v.reply(1, { keep: true });
  assert.equal(v.mind.activity?.what, '一步活');
  assert.equal(v.mind.activity?.steps.length, 1, '不要就按丢掉写错那步的原样执行');
});

test('必需步骤写错时整段不执行，返回错误让 Agent 自己修正', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '先这样', decision: 'new', activity: { what: '两步活', steps: [step(1), { skill: 'use_skill', args: {} }] } });
  assert.equal(w.pending.length, 2);
  assert.match(w.pending[1].messages.at(-1)!.content, /必需步骤无法执行.*steps\[1\]/);
  assert.equal(Boolean(w.mind.activity), false);
  await w.reply(1, { monologue: '不做那一步了', decision: 'new', activity: { what: '先看看', steps: [step(1)] } });
  assert.equal(w.mind.activity?.what, '先看看');
  assert.equal(w.mind.activity?.steps.length, 1);
});

test('修订稿的必需步骤无效时不会回退执行旧稿', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '旧稿', steps: [step(1), { skill: 'use_skill', args: {}, optional: true }] } });
  await w.reply(1, { decision: 'new', activity: { what: '修订稿', steps: [step(1), { skill: 'use_skill', args: {} }] } });
  assert.equal(w.pending.length, 3);
  assert.match(w.pending[2].messages.at(-1)!.content, /必需步骤无法执行/);
  assert.equal(Boolean(w.mind.activity), false);
  await w.reply(2, { decision: 'new', activity: { what: '重新决定', steps: [step(1)] } });
  assert.equal(w.mind.activity?.what, '重新决定');
});

test('换维度时观测暂时不可用不算断线，落地后按换了地方继续想', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '走近下界门', steps: [step()] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '走近下界门');
  // 穿门：连接和生命都还在，只是新维度和区块还没观测就绪
  w.adapter.dim = 'the_nether';
  w.adapter.sessionId = 'session-after-portal';
  w.adapter.observationReady = false;
  await w.tick();
  await w.tick();
  assert.ok(w.bus.recent().every((e) => e.type !== 'attempt_end' || !/断线了/.test(e.msg)), '换维度不应把这段活记成断线');
  assert.ok(w.bus.recent().every((e) => e.type !== 'llm_request' || !/重新连上了/.test(e.msg)), '换维度不应让它以为重连了');
  assert.equal(w.mind.activity?.what, '走近下界门', '世界还没就绪时先不打断手上的活');
  w.adapter.observationReady = true;
  await w.tick();
  const request = w.bus.recent().filter((e) => e.type === 'llm_request').at(-1);
  assert.match(request?.msg ?? '', /换了个地方|第一次来到/);
  const ended = w.bus.recent().filter((e) => e.type === 'attempt_end').at(-1);
  assert.match(ended?.msg ?? '', /换了世界\/维度/);
});

test('换维度后，预先排好的 next 不启动，等按新位置重新评估', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { decision: 'new', activity: { what: '在下界挖掘', steps: [step()] },
    next: { what: '砍菌柄', steps: [{ skill: 'mind_step', args: { n: 2 } }] } });
  assert.equal(w.mind.activity?.what, '在下界挖掘');
  assert.equal(w.mind.queuedNext?.draft.what, '砍菌柄');
  assert.deepEqual(w.mind.queuedNext?.scope, { worldId: w.adapter.worldId, dim: 'overworld', sessionId: 'fake-session' });
  // 意外换维：连接和生命都还在，观测恢复后按新地方继续想。
  w.adapter.dim = 'the_nether';
  w.adapter.sessionId = 'session-after-portal';
  await w.tick();
  assert.equal(w.mind.activity, null, '换维度中断原活动');
  assert.equal(w.mind.queuedNext, null, '旧作用域预排的 next 不能自动启动');
  assert.ok(w.bus.recent().some((e) => e.type === 'decision_stale' && /砍菌柄/.test(e.msg)), '作废要留下可复盘的事实');
  assert.ok(!w.bus.recent().some((e) => e.type === 'activity_start' && /砍菌柄/.test(e.msg)));
  assert.ok(w.bus.recent().some((e) => e.type === 'llm_request' && /换了个地方|第一次来到/.test(e.msg)), '换地方后要求重新想');
});

test('预排 next 的作用域与当前不符时不启动，并请求重新决定', async (t) => {
  const w = fixture(t);
  await w.tick();
  (w.mind as any).queuedNext = {
    draft: { what: '旧世界的下一步', steps: [step(2)] }, monologue: '', at: Date.now(),
    scope: { worldId: 'other-world', dim: 'the_nether', sessionId: 'old-session' }, epoch: (w.mind as any).decisionEpoch,
  };
  await w.tick();
  assert.equal(w.mind.activity, null);
  assert.equal(w.mind.queuedNext, null);
  assert.ok(w.bus.recent().some((e) => e.type === 'decision_stale' && /旧世界的下一步/.test(e.msg)));
  assert.ok(!w.bus.recent().some((e) => e.type === 'activity_start' && /旧世界的下一步/.test(e.msg)));
});

test('开工时没有计划的活动，不会被后来新建的计划认领进展', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '先探一段', decision: 'new', activity: { what: '向北探一段', kind: 'explore', steps: [step()] } });
  assert.equal(w.self.plan(), null, '开工时没有计划');
  const plan = w.self.setPlan('找到下界要塞', ['找到下界要塞'])!;
  const outcomeId = plan.steps[0]!.id;
  await w.finish(ok('探完一段'));
  assert.equal(w.self.progressLedger(outcomeId), null, '旧活动不能计入后来新建的成果');
  assert.equal(w.self.progressLedger('unassigned')?.movement.activities, 1, '记到未关联当前计划');
});

test('没有显式 outcome_id 的活动不归到第一个未完成清单项', async (t) => {
  const w = fixture(t);
  await w.tick();
  const plan = w.self.setPlan('找到下界要塞', ['向北开出稳定巷道推进', '找到下界要塞'])!;
  const firstOutcome = plan.steps[0]!.id;
  await w.reply(0, { monologue: '先沿已知通道走一段', decision: 'new', activity: { what: '沿已知通道走 24 格', kind: 'explore', steps: [step()] } });
  assert.equal(w.mind.activity?.outcomeId, undefined);
  await w.finish(ok('走完 24 格'));
  assert.equal(w.self.progressLedger(firstOutcome), null, '没有明确关联就不能算到第一个未完成成果');
  assert.equal(w.self.progressLedger('unassigned')?.movement.activities, 1, '记到 unassigned');
});

test('纯文字技能和定义无效的技能能被想起，但不会自动翻开正文', async (t) => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BUILTIN_SKILLS_DIR, SkillBook } = await import('../src/knowledge/skillbook.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-auto-open-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const book = new SkillBook(BUILTIN_SKILLS_DIR, dir);
  assert.ok(book.write('observe-text', '观察脚下位置', '只观察当前脚下位置，不移动、不挖掘、不放置。').ok);
  assert.ok(book.write('observe-broken', '观察脚下位置', '只观察当前脚下位置。', { steps: [{ skill: 'no-such-skill', args: {} }] }).ok);
  const w = fixture(t, { book, behaviors: true });
  const opened: string[] = [];
  w.bus.on('event', (e: { type: string; data?: { auto?: boolean; name?: string } }) => { if (e.type === 'skill_read' && e.data?.auto) opened.push(e.data.name!); });
  await w.tick();
  await w.reply(0, { monologue: '看看脚下', decision: 'new', activity: { what: '观察脚下位置', steps: [step()] } });
  w.mind.attention.notice('test_auto', '观察脚下位置', 0.8);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.deepEqual(opened, [], '文字笔记和无效定义都不会被自动接手');
});

test('加载成功的可执行技能仍会按关键词自动翻开正文', async (t) => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BUILTIN_SKILLS_DIR, SkillBook } = await import('../src/knowledge/skillbook.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-auto-open-ok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const book = new SkillBook(BUILTIN_SKILLS_DIR, dir);
  assert.ok(book.write('observe-valid', '观察脚下位置', '观察当前脚下位置。', { code: 'return { ok: true };', verify: "const s = await api.state(); return s.onGround ? true : '不在落地';" }).ok);
  const w = fixture(t, { book, behaviors: true });
  const opened: string[] = [];
  w.bus.on('event', (e: { type: string; data?: { auto?: boolean; name?: string } }) => { if (e.type === 'skill_read' && e.data?.auto) opened.push(e.data.name!); });
  
  await w.tick();
  await w.reply(0, { monologue: '看看脚下', decision: 'new', activity: { what: '观察脚下位置', steps: [step()] } });
  w.mind.attention.notice('test_auto', '观察脚下位置', 0.8);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.deepEqual(opened, ['observe-valid'], '可执行技能照常自动翻开');
});
