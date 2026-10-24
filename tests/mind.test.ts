import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, createActivity, nextStep, remainingSteps } from '../src/mind/activity.ts';
import { Attention } from '../src/mind/attention.ts';
import { Mind } from '../src/mind/mind.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { DEFAULT_MOOD, feel, moodWords, SelfModel } from '../src/mind/self.ts';
import { parseDecision, Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, type SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };

function fixture(t: TestContext, opts: { autonomous?: boolean } = {}) {
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
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus), say: (s) => said.push(s) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); if (previous) SKILLS.mind_step = previous; else delete SKILLS.mind_step; });
  const reply = async (i: number, body: object) => { pending[i].resolve({ text: JSON.stringify(body), latencyMs: 1200 }); await flush(); };
  const tick = async () => { mind.tick(); await flush(); };
  const finish = async (r?: SkillResult) => { finishes.shift()!(r); await flush(); };
  return { adapter, memory, bus, arbiter, planner, self, mind, pending, reply, tick, finish, said, finishes };
}

const step = (n = 1) => ({ skill: 'mind_step', args: { n } });

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

test('一段活连续执行多轮；快干完时边做边想，干完立刻接上提前想好的下一段', async (t) => {
  const w = fixture(t);
  await w.tick();
  assert.equal(w.pending.length, 1, '没有活时先认真想想');
  assert.equal(w.pending[0].hint.tier, 'full');
  assert.match(w.pending[0].messages[0].content, /真人玩家/);
  await w.reply(0, { monologue: '先砍点树', say: '开工！', decision: 'new', activity: { what: '砍树', why: '缺木头', kind: 'gather', steps: [step()], repeat: 2 } });
  assert.equal(w.arbiter.info()?.skill, 'mind_step');
  const first = w.mind.activity!.id;
  assert.deepEqual(w.said, ['开工！']);
  await w.finish();
  await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'mind_step', '第二轮接着做，不用问模型');
  assert.equal(w.pending.length, 1);
  await w.tick();
  assert.equal(w.pending.length, 2, '最后一步在做时就开始想接下来');
  assert.equal(w.pending[1].hint.tier, 'light');
  await w.reply(1, { monologue: '木头差不多了', decision: 'continue', next: { what: '做工作台', steps: [step(2)] } });
  assert.equal(w.mind.activity?.id, first, 'continue 不打断手上的活');
  await w.finish();
  await w.tick();
  assert.notEqual(w.mind.activity?.id, first);
  assert.equal(w.mind.activity?.what, '做工作台');
  assert.equal(w.arbiter.info()?.skill, 'mind_step', '干完立刻接上，没有停下来等');
  assert.equal(w.self.history(1)[0].outcome, 'done');
  assert.ok(w.self.recentThoughts().some((x) => x.text === '先砍点树'));
});

test('绕路：先处理别的事，做完自动回到被打断的那段活', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '盖墙', decision: 'new', activity: { what: '砌墙', steps: [step(1), step(2)] } });
  const wall = w.mind.activity!;
  w.mind.attention.notice('hungry', '饿了', 0.6);
  await w.tick();
  assert.equal(w.pending.length, 2);
  await w.reply(1, { monologue: '先吃点东西', decision: 'detour', activity: { what: '弄点吃的', steps: [step(9)] } });
  await w.tick();
  assert.equal(w.mind.activity?.what, '弄点吃的');
  assert.deepEqual(w.mind.suspended.map((a) => a.id), [wall.id]);
  await w.finish();
  assert.equal(w.mind.activity?.id, wall.id, '吃完回到砌墙');
  await w.tick();
  assert.deepEqual(w.arbiter.info()?.args, { n: 1 }, '从被打断的那一步重新开始');
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

test('模型出错时凭习惯继续玩，不发呆', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].reject(new Error('HTTP 503'));
  await flush();
  assert.equal(w.mind.activity?.source, 'habit');
  assert.ok(w.arbiter.info(), '有事在做');
});

test('瞥一眼觉得需要深想时升级为完整思考', async (t) => {
  const w = fixture(t);
  await w.tick();
  await w.reply(0, { monologue: '走走', decision: 'new', activity: { what: '散步', steps: [step()] } });
  w.mind.attention.notice('x', '看见了奇怪的建筑', 0.55);
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
