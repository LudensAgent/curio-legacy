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
import { buildMindMessages } from '../src/mind/prompt.ts';
import { DEFAULT_MOOD, feel, moodWords, SelfModel } from '../src/mind/self.ts';
import { embeddedQuery, parseDecision, Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { fail, ok, type SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };

function fixture(t: TestContext, opts: { autonomous?: boolean; book?: import('../src/knowledge/skillbook.ts').SkillBook } = {}) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; reject: (e: Error) => void; messages: ChatMessage[]; hint: any }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: (opts.autonomous === false ? 'mock' : 'openai') as 'openai', maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: opts.autonomous === false ? 'mock' : 'mind-test-model', complete: (messages, _signal, hint) =>
    new Promise((resolve, reject) => pending.push({ resolve, reject, messages, hint })) }, adapter, memory, bus, null);
  const self = new SelfModel(null, ['好奇', '谨慎']);
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
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, opts.book ?? null), say: (s) => said.push(s) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); if (previous) SKILLS.mind_step = previous; else delete SKILLS.mind_step; });
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 1200 }); await flush(); };
  const tick = async () => { mind.tick(); await flush(); };
  const finish = async (r?: SkillResult) => { finishes.shift()!(r); await flush(); };
  return { adapter, memory, bus, arbiter, planner, self, mind, pending, reply, tick, finish, said, finishes };
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

test('身体自己应变：没找到换地方找、偶发失败再试一次、缺材料才叫脑子', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '挖石头', why: '做石镐', kind: 'gather', repeat: 1, steps: [{ skill: 'gather', args: { block: 'stone', count: 3 } }, { skill: 'craft', args: { item: 'stone_pickaxe' } }] }, '', 'llm', adapter.state());
  const s1 = nextStep(a)!;
  const v1 = afterStep(a, s1, fail('NOT_FOUND', '看不到石头'), 100, adapter.state());
  assert.equal(v1.kind, 'continue');
  assert.match((v1 as any).adapted, /换个方向找/);
  assert.equal(nextStep(a)!.skill, 'explore');
  const v2 = afterStep(a, { skill: 'explore' }, ok('找到了'), 100, adapter.state());
  assert.equal(v2.kind, 'continue');
  const s3 = nextStep(a)!;
  assert.equal(s3.skill, 'gather');
  // explore 之后人已经换了地方：同一目标的失败在新位置值得再试一次
  for (const r of a.results) if (r.skill === 'gather') r.pos = { x: 99, y: 64, z: 99 };
  const v3 = afterStep(a, s3, fail('PATH_NOT_FOUND', '路被挡住'), 100, adapter.state());
  assert.match((v3 as any).adapted, /再试一次/);
  assert.equal(nextStep(a)!.skill, 'gather');
  afterStep(a, s3, ok('挖到了'), 100, adapter.state());
  const s5 = nextStep(a)!;
  const v5 = afterStep(a, s5, fail('MISSING_MATERIALS', '缺木棍'), 100, adapter.state());
  assert.equal(v5.kind, 'stuck');
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

test('决定的校验：能纠正就纠正，关键部分错了才要求重答', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  assert.ok('error' in parseDecision({ decision: 'continue', monologue: '嗯' }, adapter, memory, false));
  const d = parseDecision({ decision: 'new', monologue: '去砍树', activity: { what: '砍树', steps: [{ skill: 'no_such_skill' }, { skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
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
  assert.equal(w.mind.activity?.source, 'rule');
  assert.ok(w.arbiter.info());
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

test('在原地失败、周围也没变化时不原样重试；goto 找不到路也不重试', () => {
  const adapter = new FakeAdapter();
  const here = { ...adapter.state().pos };
  const a = createActivity({ what: '挖石头', why: '', kind: 'gather', repeat: 1, steps: [{ skill: 'gather', args: { block: 'stone', count: 3 } }] }, '', 'llm', adapter.state());
  const s1 = nextStep(a)!;
  a.stepStart = { pos: here };
  assert.equal(afterStep(a, s1, fail('PATH_NOT_FOUND', '路被挡住'), 100, adapter.state()).kind, 'stuck');
  const g = createActivity({ what: '回家', why: '', kind: 'explore', repeat: 1, steps: [{ skill: 'goto', args: { target: 'home' } }] }, '', 'llm', adapter.state());
  const s2 = nextStep(g)!;
  g.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(g, s2, fail('PATH_NOT_FOUND', '眼前没有可确认的通路'), 100, adapter.state()).kind, 'stuck');
});

test('顺手的步骤没成不算这段活失败，接着做后面的', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '往西走，路上见到牛就打', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'hunt', args: { animal: 'cow' }, optional: true }, { skill: 'explore', args: { direction: 'W', distance: 32 } }] }, '', 'llm', adapter.state());
  const s1 = nextStep(a)!;
  const v = afterStep(a, s1, fail('NOT_FOUND', '视野里没有 cow'), 100, adapter.state());
  assert.equal(v.kind, 'continue');
  assert.match((v as any).adapted, /顺手/);
  assert.equal(a.failures, 0);
  assert.equal(nextStep(a)!.skill, 'explore');
  const v2 = afterStep(a, { skill: 'explore', args: {} }, ok('走了 32 格'), 100, adapter.state());
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
  assert.deepEqual(w.arbiter.info()?.args, { n: 2 });
});

for (const kind of ['new', 'adjust'] as const) test(`注意到事情后明确 ${kind} 仍立即改变当前活动`, async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [step()] } });
  w.mind.attention.notice('x', '附近有事情', 0.6);
  (w.mind as any).lastThoughtAt = 0;
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.reply(1, { monologue: '现在改做法', decision: kind, activity: { what: '改为收集石头', steps: [step(2)] } });
  assert.equal(w.mind.lastDecision?.kind, kind);
  assert.equal(w.mind.activity?.what, '改为收集石头');
  assert.equal(w.mind.lastDecision?.next, undefined);
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
  assert.ok(self.data.knowHow.some((k) => k.text === '掉进浅坑时原地垫方块爬出去' && k.wins === 2));
  assert.ok(!self.data.knowHow.some((k) => k.id === c.id));
  assert.ok(self.data.knowHow.some((k) => k.text === '桦木林边上常有羊'));
  assert.equal(self.insights().length, 0);
  assert.equal(self.reflectionBacklog(), 0);
});

test('打转提醒同一种失败只提一次，几分钟内不反复逼着深想', () => {
  const att = new Attention();
  const here = { x: 0, y: 64, z: 0 };
  const now = Date.now();
  const recs = [1, 2, 3].map((i) => ({ pos: here, outcome: 'stuck' as const, failureCode: 'PATH_NOT_FOUND', what: `试法${i}`, at: now - 60_000 + i * 1000 }));
  assert.ok(att.fromLoop(recs, here, now));
  recs.push({ pos: here, outcome: 'stuck', failureCode: 'PATH_NOT_FOUND', what: '试法4', at: now + 1000 });
  assert.equal(att.fromLoop(recs, here, now + 2000), null);
  assert.ok(att.fromLoop(recs, here, now + 5 * 60_000));
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
  assert.ok(deliberate.content.length <= 10000, `认真想的系统提示词 ${deliberate.content.length} 字`);
  assert.match(deliberate.content, /其他动作（用 \{"kind":"moves"/);
  const label = argsLabel({ skill: 'build', args: { spec: { name: '小屋', width: 5, depth: 5, design: { legend: {}, layers: [['PPP']] }, components: Array(100).fill({}) } } });
  assert.ok(label.length < 80 && /小屋/.test(label) && !/components/.test(label), label);
  memory.close();
});

test('思考时可以查动作的完整参数', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { kind: 'moves', names: ['use_item', 'ride'] });
  assert.match(w.pending[1].messages.at(-1)!.content, /- ride /);
});

test('被困地下时，模型用原子动作写一段挖阶梯的 routine，身体照着一格格执行直到见天', async (t) => {
  const w = fixture(t);
  w.adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  (w.adapter as any).removed.add('0,60,0'); (w.adapter as any).removed.add('0,61,0');
  await w.tick();
  const user = w.pending[0].messages[1].content;
  assert.match(user, /"local":/, '身边方块图在提示词里');
  assert.match(user, /dig_at/, '被困时提醒自己一格格挖出去');
  await w.reply(0, { monologue: '四面都是石头，朝北挖阶梯上去', decision: 'new', activity: { what: '朝北挖阶梯回地面', kind: 'survive', repeat: 10,
    steps: [{ skill: 'dig_at', args: { at: [0, 2, 0], facing: 'N' } }, { skill: 'dig_at', args: { at: [1, 1, 0], facing: 'N' } }, { skill: 'dig_at', args: { at: [1, 2, 0], facing: 'N' } }, { skill: 'step', args: { to: [1, 1, 0], facing: 'N' } }],
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
  const same = parseDecision({ decision: 'continue', monologue: '接着等', activity: { what: '在坑里等到天亮', steps: [{ skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, true, '在坑里等到天亮');
  assert.ok(!('error' in same) && same.kind === 'continue');
});

test('写错被丢掉的步骤会记下来，心智看得到它们根本没做', () => {
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter();
  const d = parseDecision({ decision: 'new', monologue: '放床', activity: { what: '放床', steps: [{ skill: 'no_such_skill', args: { item: 'white_bed' } }, { skill: 'look_around', args: { seconds: 3 } }] } }, adapter, memory, false);
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

test('goto 可以选择挖穿/垫高直走；工地附近的坐标能当收工位置', async () => {
  const { goTo } = await import('../src/skills/movement.ts');
  const v = goTo.validate({ target: 'base', dig: true }, new FakeAdapter());
  assert.ok(v.ok && v.args.dig === true);
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

for (const scenario of ['same', 'position', 'direction', 'pitch', 'parameters', 'code', 'reason', 'danger'] as const) test(`重复失败的思考级别：${scenario}`, async (t) => {
  const w = fixture(t);
  await w.tick();
  const activity = { what: '尝试动作', steps: [step(3)] };
  await w.reply(0, { decision: 'new', activity });
  await w.tick();
  await w.finish(fail('BAD_ARGS', '目标不在当前视野'));
  await w.tick();
  assert.equal(w.bus.recent().filter((e) => e.type === 'llm_request').at(-1)?.data?.tier, 'deliberate');
  await w.reply(w.pending.length - 1, { decision: 'new', activity: scenario === 'parameters' ? { ...activity, steps: [step(4)] } : activity });
  await w.tick();
  if (scenario === 'position') w.adapter.pos.x += 1;
  if (scenario === 'direction') w.adapter.yaw += Math.PI / 2;
  if (scenario === 'pitch') w.adapter.pitch += Math.PI / 4;
  if (scenario === 'danger') w.adapter.hp = 10;
  await w.finish(fail(scenario === 'code' ? 'UNKNOWN_ITEM' : 'BAD_ARGS', scenario === 'reason' ? '目标已经消失' : '目标不在当前视野'));
  await w.tick();
  const request = w.bus.recent().filter((e) => e.type === 'llm_request').at(-1);
  assert.equal(request?.data?.tier, scenario === 'same' ? 'glance' : 'deliberate');
  if (scenario === 'same') {
    assert.match(request?.msg ?? '', /刚才相同动作也失败：目标不在当前视野/);
    await w.reply(w.pending.length - 1, { kind: 'deliberate', reason: '需要想清楚' });
    assert.equal(w.bus.recent().filter((e) => e.type === 'llm_escalate').length, 1, 'Agent 可主动升级为认真想');
  }
});

test('盖房、走路这类事做着做着挨了打，又没有技能接手：先停下、马上认真想（不边挨打边砌墙）', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '砌墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 });
  (w.mind as any).d.perception.snapshot = () => ({ nearby: { hostile: [{ name: 'zombie', dist: 2, how: 'seen' }] } });
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

test('提示词：太阳还高就想着躲起来过夜，提醒里把尺度摆出来；状态里的时间是游戏钟点', async () => {
  const { situationalReminders } = await import('../src/mind/prompt.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const base = { reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', tier: 'glance' as const };
  const hiding = situationalReminders({ ...base, activity: { what: '就地挖坑封顶过夜', why: '离天黑不远了' } } as any);
  assert.ok(hiding.some((r) => /早上 7 点.*离天黑还有约 12 个小时.*别提前躲起来干等/.test(r)), hiding.join('\n'));
  const working = situationalReminders({ ...base, activity: { what: '砍 16 个原木', why: '盖小屋' } } as any);
  assert.ok(!working.some((r) => /别提前躲/.test(r)));
  const [, user] = buildMindMessages({ ...base, activity: null } as any);
  assert.match(user.content, /早上 7 点，太阳刚升起不久；离天黑（晚上 7 点，开始刷怪）还有约 12 个小时（游戏时间）/);
  const percept = { ...base.percept, death_recovery: { dir: 'N', dist: 20, lost: 'stone×1', seconds_left: 50 } };
  const [, timed] = buildMindMessages({ ...base, percept, state: { ...adapter.state(), effects: [{ name: 'speed', level: 1, seconds: 50 }] }, activity: null } as any);
  assert.match(timed.content, /估计还剩约 1 个小时游戏时间；实际状态未知/);
  assert.match(timed.content, /剩余时间按正常速度估算为约 1 个小时游戏时间/);
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
  assert.equal(bare.wearing, '没穿盔甲，副手空着');
  const dressed = JSON.parse(body({ ...adapter.state(), equipment: [
    { slot: 'head', name: 'iron_helmet', durabilityRemaining: 165 }, { slot: 'torso', name: 'iron_chestplate', durabilityRemaining: 240 },
    { slot: 'legs', name: 'iron_leggings' }, { slot: 'feet', name: 'iron_boots', durabilityRemaining: 195 }] }));
  assert.deepEqual(dressed.wearing, { 头: 'iron_helmet（耐久剩 165）', 胸: 'iron_chestplate（耐久剩 240）', 腿: 'iron_leggings', 脚: 'iron_boots（耐久剩 195）' });
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

test('决定里有一步写错：当场退回去让它改一次（改了用新的，说不要就用原来的），不默默丢掉', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '先这样', decision: 'new', activity: { what: '两步活', steps: [step(1), { skill: 'use_skill', args: {} }] } });
  assert.equal(w.pending.length, 2, '退回去改');
  assert.match(w.pending[1].messages.at(-1)!.content, /执行时会被丢掉.*keep/s);
  await w.reply(1, { monologue: '改好了', decision: 'new', activity: { what: '两步活', steps: [step(1), step(2)] } });
  assert.equal(w.mind.activity?.steps.length, 2);

  const v = fixture(t);
  await v.tick();
  await v.reply(0, { monologue: '先这样', decision: 'new', activity: { what: '一步活', steps: [step(1), { skill: 'use_skill', args: {} }] } });
  await v.reply(1, { keep: true });
  assert.equal(v.mind.activity?.what, '一步活');
  assert.equal(v.mind.activity?.steps.length, 1, '不要就按丢掉写错那步的原样执行');
});
