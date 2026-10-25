import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { cornerSafe } from '../src/adapter/corner-safe.ts';
import type { AgentState, EntityInfo, GameAdapter } from '../src/adapter/types.ts';
import { Arbiter, type Step, type TaskInfo, type TaskSource } from '../src/arbiter/arbiter.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine, validateBehavior } from '../src/mind/behaviors.ts';
import { Mind } from '../src/mind/mind.ts';
import { evalPredicate, senseNow, validatePredicate } from '../src/mind/predicate.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, type Senses, type Skill } from '../src/skills/types.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-behaviors-'));
const noSenses: Senses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

/** 测试用的两个动作：一个总是“路被挡住”，一个总能做成 */
function testSkills(t: TestContext) {
  const prev = { t_fail: SKILLS.t_fail, t_ok: SKILLS.t_ok };
  const ran: string[] = [];
  const mk = (name: string, result: () => ReturnType<Skill['run']>): Skill => ({ name, description: name, argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => { ran.push(name); return result(); } });
  SKILLS.t_fail = mk('t_fail', async () => fail('PATH_NOT_FOUND', '路被脚边的方块挡住'));
  SKILLS.t_ok = mk('t_ok', async () => ok('迈上去了'));
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v) SKILLS[k] = v; else delete SKILLS[k]; } setBehaviorRegistry(null); });
  return ran;
}

test('触发条件：只认能感觉到的事，写错给出中文说明；身边方块、怪和失败都能判断', () => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'dirt', pos: { x: 1, y: 64, z: 0 } }); // 面朝东，正前方脚边一格土
  assert.match((validatePredicate({ teleport: true }) as any).error, /不认识的条件/);
  assert.match((validatePredicate({ cell: { at: [9, 0, 0], is: 'solid' } }) as any).error, /cell\.at/);
  const p = validatePredicate({ after_failure: { skill: 'goto', code: 'PATH_NOT_FOUND|STUCK' }, cell: [{ at: [1, 0, 0], is: 'solid' }, { at: [1, 1, 0], is: 'open' }] });
  assert.ok(!('error' in p));
  if ('error' in p) return;
  const s = senseNow(adapter, noSenses, null, { skill: 'goto', code: 'STUCK' });
  assert.equal(s.facing, 'E');
  assert.ok(evalPredicate(p, s));
  assert.ok(!evalPredicate(p, senseNow(adapter, noSenses, null, { skill: 'craft', code: 'STUCK' })), '别的动作失败不算');
  assert.ok(!evalPredicate(p, senseNow(adapter, noSenses, null)), '没有失败时恢复类条件不成立');
  const skel: Senses = { ...noSenses, perceivedEntities: () => [{ id: 1, name: 'skeleton', kind: 'hostile', dist: 12, pos: { x: 12, y: 64, z: 0 } } as EntityInfo] };
  const danger = validatePredicate({ hp_below: 8, hostile: { name: 'skeleton', within: 16 }, has: { item: '*_planks', count: 2 } }) as any;
  adapter.hp = 6; adapter.inv.set('oak_planks', 3);
  assert.ok(evalPredicate(danger, senseNow(adapter, skel, null)));
  adapter.inv.set('oak_planks', 1);
  assert.ok(!evalPredicate(danger, senseNow(adapter, skel, null)), '通配的背包数量不够');
});

test('写技能：动作和参数要合法；太宽的自动条件、换掉保命本能都会被拒绝', () => {
  const adapter = new FakeAdapter();
  assert.match((validateBehavior({ name: 'x1', description: '乱写一通', steps: [{ skill: 'teleport' }] }, adapter) as any).error, /没有 "teleport"/);
  assert.match((validateBehavior({ name: 'night-thing', description: '天黑就做点什么', when: { night: true }, steps: [{ skill: 'look_around', args: { seconds: 3 } }] }, adapter) as any).error, /太宽/);
  assert.match((validateBehavior({ name: 'swim-no', description: '水里不想上浮', when: { in_water: true, oxygen_below: 8 }, steps: [{ skill: 'look_around' }], overrides: ['drowning'] }, adapter) as any).error, /底线/);
  assert.match((validateBehavior({ name: 'nest', description: '套娃技能', steps: [{ skill: 'use_skill', args: { name: 'a' } }] }, adapter) as any).error, /不能再调用技能/);
  const v = validateBehavior({ name: 'Pillar From Skeletons', description: '血少被骷髅射时垫高', when: { hp_below: 8, hostile: { name: 'skeleton', within: 16 } },
    steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'any' }, if: { cell: { at: [0, 2, 0], is: 'air' } } }], overrides: ['low-hp-flee'] }, adapter);
  assert.ok(!('error' in v) && v.name === 'pillar-from-skeletons');
});

test('内置的示范技能都能被引擎读懂：恢复类、调用类各有一份，写技能的说明可以翻开', () => {
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, new EventBus(), noSenses);
  assert.equal(engine.get('step-up-when-blocked')?.mode, 'recover');
  assert.equal(engine.get('pillar-out-of-pit')?.mode, 'manual');
  assert.ok(book.get('writing-skills')?.body.includes('after_failure'));
  assert.ok(book.index().some((l) => l.startsWith('step-up-when-blocked') && l.includes('动作失败时先试')));
  assert.ok(!engine.overview().some((l) => l.includes('格式不对')), engine.overview().join('\n'));
});

test('模型写下的恢复技能立刻生效：动作失败时身体先照它做，再重做失败的那步，不用先叫脑子', async (t) => {
  const ran = testSkills(t);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const behaviors = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(behaviors);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'scripted', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, book), behaviors });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); behaviors.dispose(); arbiter.cancel('end'); memory.close(); });
  const reply = async (body: object) => { pending.at(-1)!.resolve({ text: JSON.stringify(body), latencyMs: 10 }); await flush(); };
  mind.tick(); await flush();
  // 第一次思考：写下技能 + 开始一段活
  await reply({ monologue: '老是被脚边的方块卡住，记下怎么办', decision: 'new',
    skill: { name: 'hop-when-blocked', description: '路被挡住时先迈一步', when: { after_failure: { skill: 't_fail', code: 'PATH_NOT_FOUND' } }, steps: [{ skill: 't_ok' }] },
    activity: { what: '走过去', steps: [{ skill: 't_fail' }] } });
  assert.equal(behaviors.get('hop-when-blocked')?.mode, 'recover', '写下就生效');
  const thinksBefore = pending.length;
  for (let i = 0; i < 6; i++) { mind.tick(); await flush(); }
  assert.deepEqual(ran.slice(0, 3), ['t_fail', 't_ok', 't_fail'], `先失败、照技能做、再重做：${ran}`);
  assert.equal(behaviors.statsOf('hop-when-blocked')?.fail, 1, '照技能做完了、但重做的那一步还是没成：记一次没用');
  assert.equal(behaviors.statsOf('hop-when-blocked')?.ok ?? 0, 0);
  assert.ok(pending.length >= thinksBefore, '技能试过还不行才叫脑子');
  assert.match(pending.at(-1)!.messages.at(-1)!.content, /走过去/);
});

test('自动技能接手：条件成立时由身体去做，并且能换掉它声明的本能', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const state: AgentState = {
    connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1, username: 'test', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld',
    hp: 5, food: 20, oxygen: 20, timeOfDay: 15000, isDay: false, biome: null, onGround: true, inWater: false, inLava: false, inventory: [{ name: 'cobblestone', count: 8 }], emptySlots: 30, held: null,
  };
  let current: TaskInfo | null = null;
  const starts: Step[] = [];
  const adapter = { state: () => state, hasFood: () => false, blockAt: ({ y }: { y: number }) => y < 64 ? 'stone' : 'air', lightAt: () => ({ block: 0, sky: 0 }), eye: () => ({ yaw: 0, pitch: 0 }),
    isKnownItem: () => true } as unknown as GameAdapter;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => { starts.push(step); current = { id: 't', planVersion: 1, skill: step.skill, args: step.args, source, progress: 0, note: '', startedAt: now, deadline: now + 1000, movement: false }; return current; },
    cancel: () => { current = null; } } as unknown as Arbiter;
  const entities: EntityInfo[] = [{ id: 7, name: 'skeleton', kind: 'hostile', dist: 9, pos: { x: 9, y: 64, z: 0 } } as EntityInfo];
  const senses: Senses = { ...noSenses, perceivedEntities: () => entities };
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, new EventBus(), senses);
  const reflex = new Reflex(adapter, arbiter, new EventBus(), senses, { routineCare: false, behaviors: engine });
  reflex.tick();
  assert.equal(starts.at(-1)?.skill, 'flee', '没学过时：天生的本能是逃');
  current = null;
  const w = engine.write({ name: 'pillar-from-skeletons', description: '血少被骷髅盯上就垫高', when: { hp_below: 8, hostile: { name: 'skeleton', within: 16 }, has: 'cobblestone' },
    steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }], priority: 70, overrides: ['low-hp-flee'] });
  assert.ok(w.ok && w.mode === 'auto', JSON.stringify(w));
  now += 10_000;
  reflex.tick();
  assert.equal(starts.at(-1)?.skill, 'use_skill', '学会之后：照自己的做法');
  assert.equal((starts.at(-1)?.args as any).name, 'pillar-from-skeletons');
  assert.equal((starts.at(-1)?.args as any).args.trigger.hostiles[0].name, 'skeleton', '触发时的情况交给技能');
  const n = starts.length;
  now += 5_000; reflex.tick();
  assert.equal(starts.length, n, '做的时候本能不再插手，冷却内也不重复触发');
  assert.ok(engine.suppresses('low-hp-flee', null));
  assert.ok(!engine.suppresses('lava', null), '保命底线换不掉');
});

test('use_skill：一步步照做，每步的 if 当场判断', async (t) => {
  const ran = testSkills(t);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { engine.dispose(); memory.close(); });
  assert.ok(engine.write({ name: 'combo', description: '前面是土就先做 t_ok', steps: [{ skill: 't_ok', if: { cell: { at: [1, 0, 0], is: 'solid' } } }, { skill: 't_ok' }] }).ok);
  const done = new Promise<any>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'use_skill', args: { name: 'combo' } }, 'llm');
  const o = await done;
  assert.equal(o.result.status, 'succeeded');
  assert.deepEqual(ran, ['t_ok'], '前面是空气，第一步跳过');
  assert.match(o.result.summary, /跳过/);
  assert.match((arbiter.start({ skill: 'use_skill', args: { name: 'nope' } }, 'llm') as any).error, /没有叫 nope/);
});

test('斜着走不切角：一侧有实心方块就不走斜线', () => {
  const block = (physical: boolean) => ({ physical });
  const world = new Map<string, boolean>([['0,0,1', true]]); // 南边脚边一格实心
  let called = 0;
  const mv = cornerSafe({
    getBlock: (node: any, dx: number, dy: number, dz: number) => block(world.get(`${node.x + dx},${node.y + dy},${node.z + dz}`) ?? false),
    getMoveDiagonal: () => { called++; },
  });
  mv.getMoveDiagonal({ x: 0, y: 0, z: 0 }, { x: 1, z: 1 }, []);
  assert.equal(called, 0, '贴着方块的斜线被拒绝');
  mv.getMoveDiagonal({ x: 0, y: 0, z: 0 }, { x: 1, z: -1 }, []);
  assert.equal(called, 1, '两边都空就照常');
  assert.equal(cornerSafe(mv), mv);
});

test('专注：瞥一眼不能整个换掉手上的事（改成 detour 做完回来）；主目标有清单，做完一项勾掉', async (t) => {
  const ran = testSkills(t);
  const prev = SKILLS.t_slow;
  t.after(() => { if (prev) SKILLS.t_slow = prev; else delete SKILLS.t_slow; });
  SKILLS.t_slow = { name: 't_slow', description: '慢活', argsDoc: '{}', timeoutMs: 60000, movement: false, validate: () => ({ ok: true, args: {} }),
    run: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortedError' })), { once: true })) };
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'scripted', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const self = new SelfModel(null);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, null), timing: { glanceGapMs: 0 } });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('end'); memory.close(); });
  const reply = async (body: object) => { pending.at(-1)!.resolve({ text: JSON.stringify(body), latencyMs: 10 }); await flush(); };
  mind.tick(); await flush();
  await reply({ monologue: '盖个小屋', decision: 'new', plan: { focus: '盖一间小屋', steps: ['砍木头', '做木板', '盖起来'] }, activity: { what: '砍木头', steps: [{ skill: 't_slow' }] } });
  assert.equal(self.plan()?.steps.length, 3);
  assert.equal(mind.activity?.agendaId, self.plan()?.agendaId, '手上的活挂在主目标上');
  assert.match(buildMindMessages({ ...(mind as any).lastCtxForTest ?? {}, ...minimalCtx(adapter, memory, perception, self, mind) })[1].content, /【专注】[\s\S]*0\. \[ \] 砍木头/);
  // 天黑了，瞥一眼想整个换成躲起来
  mind.attention.notice('night', '天黑了', 0.6);
  mind.tick(); await flush();
  await reply({ monologue: '天黑了，先躲起来', decision: 'switch', activity: { what: '挖坑躲一晚', steps: [{ skill: 't_ok' }] } });
  for (let i = 0; i < 4; i++) { mind.tick(); await flush(); }
  assert.ok(ran.includes('t_ok'), '躲了');
  assert.equal(mind.activity?.what, '砍木头', '做完插曲回到原来的活');
  assert.match(mind.lastDecision!.notes.join(), /detour/);
  // 勾掉清单
  (mind as any).applyPlan({ plan: { done: [0] }, notes: [] });
  assert.equal(self.plan()?.steps[0].done, true);
});

function minimalCtx(adapter: FakeAdapter, memory: WorldMemory, perception: Perception, self: SelfModel, mind: Mind) {
  return { tier: 'deliberate' as const, reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, activity: mind.activity, suspended: mind.suspended,
    lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '你叫 Curio。', plan: self.plan() };
}

test('想起来：按关键词从做过的事、日记和技能书里挑出相关的；半颗心不会显示成 0', () => {
  const memory = new WorldMemory(null);
  const self = new SelfModel(null);
  self.record({ id: 'r1', what: '挖阶梯回地面', kind: 'explore', outcome: 'stuck', summary: '迈不到 [1,1,0]：目标格上方是 oak_leaves', durationSec: 5, gained: {}, lost: {}, at: Date.now() - 60_000, signature: 'dig_at>step', failures: 1 });
  self.record({ id: 'r2', what: '砍橡木', kind: 'gather', outcome: 'done', summary: '采集了 8 个 oak_log', durationSec: 40, gained: { oak_log: 8 }, lost: {}, at: Date.now(), signature: 'gather:oak_log', failures: 0 });
  self.writeDiary('在雪地边上被骷髅射死了', 'overworld', [0, 64, 0]);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const r = recallLocal('被树叶挡住 挖阶梯 回地面 step', { self, memory, book });
  assert.equal(r[0]?.kind, 'experience');
  assert.match(r[0].text, /挖阶梯回地面/);
  assert.ok(recallLocal('骷髅 射死', { self, memory, book }).some((x) => x.kind === 'diary'));
  assert.ok(recallLocal('被方块挡住 卡住 step up blocked', { self, memory, book }).some((x) => x.kind === 'skill' && x.ref === 'step-up-when-blocked'));
  const adapter = new FakeAdapter(); adapter.hp = 0.4;
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const msg = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '你叫 Curio。' })[1].content;
  assert.match(msg, /"hp":0\.4/);
  memory.close();
});

test('“快干完了想想接下来”每段活只问一次：模型没写 next 也不会被连着追问', async (t) => {
  const prev = SKILLS.t_slow2;
  t.after(() => { if (prev) SKILLS.t_slow2 = prev; else delete SKILLS.t_slow2; });
  SKILLS.t_slow2 = { name: 't_slow2', description: '慢活', argsDoc: '{}', timeoutMs: 60000, movement: false, validate: () => ({ ok: true, args: {} }),
    run: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortedError' })), { once: true })) };
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'scripted', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self: new SelfModel(null), persona: '你叫 Curio。', thinker: new Thinker(planner, adapter, memory, bus, null) });
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('end'); memory.close(); });
  const reply = async (body: object) => { pending.at(-1)!.resolve({ text: JSON.stringify(body), latencyMs: 10 }); await flush(); };
  mind.tick(); await flush();
  await reply({ monologue: '砍树', decision: 'new', activity: { what: '砍树', steps: [{ skill: 't_slow2' }] } });
  mind.tick(); await flush();
  assert.equal(pending.length, 2, '快干完了，想一次接下来');
  await reply({ monologue: '接着砍', decision: 'continue' });
  for (let i = 0; i < 5; i++) { mind.tick(); await flush(); }
  assert.equal(pending.length, 2, '没写 next 也不再追问');
});

function reflexWorld(t: TestContext, blockAt: (p: { x: number; y: number; z: number }) => string) {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const state: AgentState = {
    connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1, username: 'test', pos: { x: 0.5, y: 64, z: 0.5 }, dim: 'overworld',
    hp: 5, food: 20, oxygen: 20, timeOfDay: 15000, isDay: false, biome: null, onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 30, held: null,
  };
  let current: TaskInfo | null = null;
  const starts: Step[] = [];
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('event', (e: any) => events.push(e.type));
  const adapter = { state: () => state, hasFood: () => false, blockAt, lightAt: () => ({ block: 0, sky: 0 }), eye: () => ({ yaw: 0, pitch: 0 }) } as unknown as GameAdapter;
  const arbiter = { paused: false, info: () => current,
    start: (step: Step, source: TaskSource) => { starts.push(step); current = { id: 't', planVersion: 1, skill: step.skill, args: step.args, source, progress: 0, note: '', startedAt: now, deadline: now + 1000, movement: false }; return current; },
    cancel: () => { current = null; } } as unknown as Arbiter;
  const entities: EntityInfo[] = [{ id: 7, name: 'skeleton', kind: 'hostile', dist: 3, pos: { x: 3, y: 64, z: 0 }, perception: 'seen' } as EntityInfo];
  const reflex = new Reflex(adapter, arbiter, bus, { ...noSenses, perceivedEntities: () => entities }, { routineCare: false });
  const setTask = (skill: string | null) => { current = skill ? { id: 'x', planVersion: 1, skill, args: {}, source: 'llm', progress: 0, note: '', startedAt: now - 3000, deadline: now + 60000, movement: false } : null; };
  return { state, starts, events, bus, reflex, setTask, advance: (ms: number) => { now += ms; } };
}

test('反射不再把自己从掩体里拽出去：封好的坑里不跑；在坑里/正在垫高挖坑时只有真被打到才动；连跑几次甩不掉就交给脑子', (t) => {
  // 四面和头顶都是石头：完全躲好了
  const sealed = reflexWorld(t, ({ x, y, z }) => (x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : 'stone');
  sealed.reflex.tick();
  assert.equal(sealed.starts.length, 0, '封好的坑里不出去');
  // 正在原地垫高（place_at），没被打到：不跑
  const open = reflexWorld(t, ({ y }) => y < 64 ? 'stone' : 'air');
  open.setTask('place_at');
  open.reflex.tick();
  assert.equal(open.starts.length, 0, '在挖三填一时不被拽走');
  open.bus.publish('hurt', 'P2', '受到伤害');
  open.reflex.tick();
  assert.equal(open.starts.at(-1)?.skill, 'flee', '真被打到、怪就在身边才跑');
  // 空地上连跑：第 4 次放弃，交给脑子
  const run = reflexWorld(t, ({ y }) => y < 64 ? 'stone' : 'air');
  for (let i = 0; i < 5; i++) { run.setTask(null); run.reflex.tick(); run.advance(5000); }
  assert.equal(run.starts.filter((s) => s.skill === 'flee').length, 3);
  assert.ok(run.events.includes('reflex_gaveup'));
});

test('写技能：恢复类必须写清是哪个动作失败；技能声明的参数没给时 use_skill 当场说清', (t) => {
  const adapter = new FakeAdapter();
  assert.match((validateBehavior({ name: 'fix-all', description: '什么失败都挖一下', when: { after_failure: {} }, steps: [{ skill: 'dig_at', args: { at: [1, 0, 0] } }] }, adapter) as any).error, /哪个动作失败/);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const engine = new BehaviorEngine(book, adapter, null, new EventBus(), noSenses);
  setBehaviorRegistry(engine);
  t.after(() => setBehaviorRegistry(null));
  assert.match((SKILLS.use_skill.validate({ name: 'local-path' }, adapter) as any).error, /args\.target/);
  assert.ok(SKILLS.use_skill.validate({ name: 'local-path', args: { target: '4,64,0' } }, adapter).ok);
  assert.ok(SKILLS.use_skill.validate({ name: 'local-path', failure: { skill: 'goto' } }, adapter).ok, '恢复时由失败的那一步提供');
});

test('身边方块图附带算好的落脚点和能放方块的格子', async () => {
  const { localMap } = await import('../src/perception/local.ts');
  const adapter = new FakeAdapter(); // 面朝东，平地
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }); // 正前方一格石头
  const m = localMap(adapter, adapter.pos, 'E');
  assert.ok(m.spots.stand.some((s: string) => s.startsWith('[1,1,0]')), `能迈上前方的石头：${m.spots.stand}`);
  assert.ok(!m.spots.stand.some((s: string) => s.startsWith('[1,0,0]')), '石头那格站不进去');
  assert.ok(m.spots.place.some((s: string) => s.startsWith('[0,0,-1]')), `左边地上能放：${m.spots.place}`);
});

test('反射也是技能：内置的躲苦力怕、受伤撤退、还手、饿了吃都是可改进的代码技能；代码里只剩岩浆和溺水', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const state: AgentState = {
    connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1, username: 'test', pos: { x: 0.5, y: 64, z: 0.5 }, dim: 'overworld',
    hp: 5, food: 20, oxygen: 20, timeOfDay: 15000, isDay: false, biome: null, onGround: true, inWater: false, inLava: false, inventory: [{ name: 'cobblestone', count: 8 }], emptySlots: 30, held: null,
  };
  let current: TaskInfo | null = null;
  const starts: Step[] = [];
  const bus = new EventBus();
  const adapter = { state: () => state, hasFood: () => false, blockAt: ({ y }: { y: number }) => y < 64 ? 'stone' : 'air', lightAt: () => ({ block: 0, sky: 0 }), eye: () => ({ yaw: 0, pitch: 0 }), isKnownItem: () => true } as unknown as GameAdapter;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => { starts.push(step); current = { id: 't', planVersion: 1, skill: step.skill, args: step.args, source, progress: 0, note: '', startedAt: now, deadline: now + 1000, movement: false }; return current; },
    cancel: () => { current = null; } } as unknown as Arbiter;
  const entities: EntityInfo[] = [{ id: 7, name: 'zombie', kind: 'hostile', dist: 2.5, pos: { x: 3, y: 64, z: 0 }, perception: 'seen' } as EntityInfo];
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, { ...noSenses, perceivedEntities: () => entities }, path.join(tmp(), 'stats.json'));
  for (const n of ['dodge-creeper', 'retreat-when-hurt', 'fight-back', 'eat-when-starving']) {
    assert.equal(engine.get(n)?.mode, 'auto', n);
    assert.ok(engine.get(n)?.code, `${n} 是代码技能`);
  }
  const reflex = new Reflex(adapter, arbiter, bus, { ...noSenses, perceivedEntities: () => entities }, { routineCare: false, behaviors: engine, instincts: 'skills' });
  reflex.tick();
  assert.equal(starts.length, 0, '没挨打：血少也不乱跑（代码里不再有逃跑本能）');
  bus.publish('hurt', 'P2', '受到伤害');
  reflex.tick();
  assert.equal(starts.at(-1)?.skill, 'use_skill');
  assert.equal((starts.at(-1)?.args as any).name, 'retreat-when-hurt', '血少又挨打：交给受伤撤退技能');
  // 事后评判：12 秒内死了就记一次没用（代码会被后台改进）
  current = null;
  bus.publish('death', 'P0', '死了');
  assert.equal(engine.statsOf('retreat-when-hurt')?.fail, 1);
  assert.match(engine.statsOf('retreat-when-hurt')!.recent![0].summary, /触发时血 5.*zombie.*死了/);
  // 再来一次，这回 12 秒后还活着、没再掉血：算管用
  now += 20_000; bus.publish('hurt', 'P2', '受到伤害'); reflex.tick();
  current = null; now += 13_000; reflex.tick();
  assert.equal(engine.statsOf('retreat-when-hurt')?.ok, 1);
  // 岩浆仍是代码里的底线
  state.inLava = true; current = null; reflex.tick();
  assert.equal(starts.at(-1)?.skill, 'flee');
});
