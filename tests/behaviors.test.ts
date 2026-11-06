import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { cornerSafe } from '../src/adapter/corner-safe.ts';
import type { AgentState, EntityInfo, GameAdapter } from '../src/adapter/types.ts';
import { Arbiter, type Step, type TaskInfo, type TaskOutcome, type TaskSource } from '../src/arbiter/arbiter.ts';
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
/** 以前内置的示范技能，现在只作为测试用的样本（游戏里技能书一开始是空的，靠它自己总结） */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');
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
  const vision = new Vision(adapter);
  assert.match((validatePredicate({ teleport: true }) as any).error, /不认识的条件/);
  assert.match((validatePredicate({ cell: { at: [9, 0, 0], is: 'solid' } }) as any).error, /cell\.at/);
  const p = validatePredicate({ after_failure: { skill: 'goto', code: 'PATH_NOT_FOUND|STUCK' }, cell: [{ at: [1, 0, 0], is: 'solid' }, { at: [1, 1, 0], is: 'open' }] });
  assert.ok(!('error' in p));
  if ('error' in p) return;
  const s = senseNow(adapter, vision, null, { skill: 'goto', code: 'STUCK' });
  assert.equal(s.facing, 'E');
  assert.ok(evalPredicate(p, s));
  assert.ok(!evalPredicate(p, senseNow(adapter, vision, null, { skill: 'craft', code: 'STUCK' })), '别的动作失败不算');
  assert.ok(!evalPredicate(p, senseNow(adapter, vision, null)), '没有失败时恢复类条件不成立');
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
  assert.ok(!('error' in validateBehavior({ name: 'swim-no', description: '水里自主选择反应', when: { in_water: true, oxygen_below: 8 }, steps: [{ skill: 'look_around' }], overrides: ['drowning'] }, adapter)));
  assert.ok(!('error' in validateBehavior({ name: 'lava-choose', description: '在岩浆里自主选择反应', when: { in_lava: true }, steps: [{ skill: 'look_around' }], overrides: ['lava'] }, adapter)));
  assert.match((validateBehavior({ name: 'nest', description: '套娃技能', steps: [{ skill: 'use_skill', args: { name: 'a' } }] }, adapter) as any).error, /不能再调用技能/);
  const v = validateBehavior({ name: 'Pillar From Skeletons', description: '血少被骷髅射时垫高', when: { hp_below: 8, hostile: { name: 'skeleton', within: 16 } },
    steps: [{ skill: 'place_at', args: { at: [0, 0, 0], item: 'any' }, if: { cell: { at: [0, 2, 0], is: 'air' } } }], overrides: ['low-hp-flee'] }, adapter);
  assert.ok(!('error' in v) && v.name === 'pillar-from-skeletons');
});

for (const liquid of ['water', 'lava'] as const) test(`自学技能可在${liquid}危险条件下自主响应`, () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  adapter.inWater = liquid === 'water';
  adapter.inLava = liquid === 'lava';
  adapter.oxygen = 7;
  const starts: Step[] = [];
  const current = { id: 'task', planVersion: 1, skill: 'dig_at', args: {}, source: 'llm', progress: 0,
    note: '', startedAt: Date.now(), deadline: Date.now() + 30000, movement: false } as TaskInfo;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => {
      starts.push(step);
      return { ...current, id: 'learned', skill: step.skill, args: step.args, source };
    } } as unknown as Arbiter;
  const engine = new BehaviorEngine(new SkillBook(null, tmp()), adapter, arbiter, bus, noSenses);
  try {
    const when = liquid === 'water' ? { in_water: true, oxygen_below: 8 } : { in_lava: true };
    const name = `${liquid}-learned`;
    const result = engine.write({ name, description: '自己学会的液体处境反应', when, overrides: [liquid === 'water' ? 'drowning' : 'lava'], steps: [{ skill: 'look_around' }] });
    assert.ok(result.ok, JSON.stringify(result));
    const reflex = new Reflex(adapter, arbiter, bus, noSenses, { instincts: 'skills', routineCare: false, behaviors: engine });
    reflex.tick();
    assert.equal(starts.at(-1)?.skill, 'use_skill');
    assert.equal((starts.at(-1)?.args as { name: string }).name, name);
  } finally { engine.dispose(); }
});

test('救命类候选技能在要命条件下也会自动接手（以 trial 试用），普通候选不自动接手', () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  adapter.hp = 6;
  adapter.inv.set('oak_planks', 2);
  const skeleton: Senses = { ...noSenses, perceivedEntities: () => [{ id: 1, name: 'skeleton', kind: 'hostile', dist: 12, pos: { x: 12, y: 64, z: 0 } } as EntityInfo] };
  const starts: Step[] = [];
  const current = { id: 'task', planVersion: 1, skill: 'dig_at', args: {}, source: 'llm', progress: 0, note: '', startedAt: Date.now(), deadline: Date.now() + 30000, movement: false } as TaskInfo;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => { starts.push(step); return { ...current, id: 'learned', skill: step.skill, args: step.args, source }; } } as unknown as Arbiter;
  const book = new SkillBook(null, tmp());
  book.write('shield-retreat-when-hurt', '血少被骷髅射时举盾后撤', '候选', { when: { hp_below: 8, hostile: { name: 'skeleton', within: 16 } }, steps: [{ skill: 'look_around' }] }, { candidate: true });
  book.write('grab-planks', '有木板就收起来', '候选', { when: { has: { item: 'oak_planks', count: 1 } }, steps: [{ skill: 'look_around' }] }, { candidate: true });
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, skeleton);
  try {
    const reflex = new Reflex(adapter, arbiter, bus, skeleton, { instincts: 'skills', routineCare: false, behaviors: engine });
    reflex.tick();
    assert.equal(starts.at(-1)?.skill, 'use_skill');
    assert.equal((starts.at(-1)?.args as { name: string }).name, 'shield-retreat-when-hurt', '救命候选自动接手');
    assert.equal((starts.at(-1)?.args as { trial?: boolean }).trial, true, '候选以 trial 试用');
    assert.ok(!starts.some((s) => (s.args as { name: string }).name === 'grab-planks'), '普通候选不自动接手');
  } finally { engine.dispose(); }
});

test('副手装备的盾会让贴身防御候选自动接管（has 不再只数背包）', () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const zombie: Senses = { ...noSenses, perceivedEntities: () => [{ id: 3, name: 'zombie', kind: 'hostile', dist: 1.3, perception: 'seen', pos: { x: 1.3, y: 64, z: 0 } } as EntityInfo] };
  const starts: Step[] = [];
  const current = { id: 'task', planVersion: 1, skill: 'dig_at', args: {}, source: 'llm', progress: 0, note: '', startedAt: Date.now(), deadline: Date.now() + 30000, movement: false } as TaskInfo;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => { starts.push(step); return { ...current, id: 'learned', skill: step.skill, args: step.args, source }; } } as unknown as Arbiter;
  const book = new SkillBook(null, tmp());
  book.write('shield-melee-defense', '近战怪贴身时举盾还手', '候选', {
    when: { hostile: { within: 4, seen: true }, has: { item: 'shield', count: 1 } }, steps: [{ skill: 'look_around' }],
  }, { candidate: true });
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, zombie);
  try {
    const reflex = new Reflex(adapter, arbiter, bus, zombie, { instincts: 'skills', routineCare: false, behaviors: engine });
    reflex.tick();
    assert.equal(starts.length, 0, '没有盾时不启动');
    adapter.equipped.set('off-hand', 'shield');
    reflex.tick();
    assert.equal(starts.at(-1)?.skill, 'use_skill');
    assert.equal((starts.at(-1)?.args as { name: string }).name, 'shield-melee-defense');
    assert.equal((starts.at(-1)?.args as { trial?: boolean }).trial, true, '候选以 trial 试用');
  } finally { engine.dispose(); }
});

test('advisory 只压被降级的版本：同名候选改写后重新获得自动接手机会', () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  adapter.hp = 10;
  const zombie: Senses = { ...noSenses, perceivedEntities: () => [{ id: 4, name: 'zombie', kind: 'hostile', dist: 2, perception: 'seen', pos: { x: 2, y: 64, z: 0 } } as EntityInfo] };
  const starts: Step[] = [];
  const current = { id: 'task', planVersion: 1, skill: 'dig_at', args: {}, source: 'llm', progress: 0, note: '', startedAt: Date.now(), deadline: Date.now() + 30000, movement: false } as TaskInfo;
  const arbiter = { paused: false, info: () => current, on() {}, off() {},
    start: (step: Step, source: TaskSource) => { starts.push(step); return { ...current, id: 'learned', skill: step.skill, args: step.args, source }; } } as unknown as Arbiter;
  const book = new SkillBook(null, tmp());
  book.write('shield-retreat-test', '贴身怪时举盾后撤', '候选', { when: { hp_below: 16, hostile: { within: 6 } }, steps: [{ skill: 'look_around' }] }, { candidate: true });
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, zombie);
  try {
    const st = { fired: 0, ok: 0, fail: 0, lastAt: 0, advisory: { since: 0, why: '测试', version: '1' } };
    (engine as any).stats['shield-retreat-test'] = st;
    assert.equal(engine.tick(current), false, '被降级的候选 v1 不自动接手');
    st.advisory.version = '0';
    assert.equal(engine.tick(current), true, 'advisory 不再匹配当前版本时重新获得自动接手机会');
    assert.equal((starts.at(-1)?.args as { name: string }).name, 'shield-retreat-test');
  } finally { engine.dispose(); }
});

test('样本技能读取：恢复类、调用类与写技能说明可用，引用隐藏动作的旧样本拒绝启用', () => {
  const book = new SkillBook(BUILTIN_SKILLS_DIR, FIXTURES);
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, new EventBus(), noSenses);
  assert.equal(engine.get('local-path')?.mode, 'recover');
  assert.equal(engine.get('pillar-out-of-pit')?.mode, 'manual');
  assert.ok(book.get('writing-skills')?.body.includes('after_failure'));
  assert.ok(book.index().some((l) => l.startsWith('local-path') && l.includes('动作失败时先试')));
  assert.equal(engine.get('step-up-when-blocked'), undefined, '旧样本的 wander 已不是可调用恢复目标');
  assert.match(engine.overview().join('\n'), /step-up-when-blocked.*恢复条件没有可调用的动作 wander/);
});

test('技能目录按行为引擎状态区分文字、可执行、候选和无效定义', () => {
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, new EventBus(), noSenses);
  const text = '这是记录下来的做法，需要阅读后自行选择动作。';
  const valid = { steps: [{ skill: 'look_around', args: {} }] };
  assert.ok(book.write('notes-only', '一份文字做法', text).ok);
  assert.ok(book.write('ready-action', '一个可执行动作', text, valid).ok);
  assert.ok(book.write('candidate-action', '一个待试用动作', text, valid, { candidate: true }).ok);
  assert.ok(book.write('bad-action', '一个失效动作', text, { steps: [{ skill: 'no_such_action' }] }).ok);
  assert.ok(book.write('ready-action', '待试用的新版本', text, valid, { candidate: true }).ok);
  const index = book.index(undefined, (name, trial) => engine.executionError(name, trial));
  assert.match(index.find((line) => line.startsWith('notes-only'))!, /［文字］/);
  assert.match(index.find((line) => line.startsWith('ready-action'))!, /可执行.*候选可试/);
  assert.match(index.find((line) => line.startsWith('candidate-action'))!, /［候选可试］/);
  assert.match(index.find((line) => line.startsWith('bad-action'))!, /不可执行/);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const [system] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null),
    memory, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '测试', skills: index });
  assert.match(system.content, /notes-only[^\n]*［文字］/);
  assert.match(system.content, /candidate-action[^\n]*［候选可试］/);
  assert.doesNotMatch(system.content, /一份文字做法/);
  memory.close();
  engine.dispose();
});

test('模型写下恢复候选后显式试用，取得实际证据才参与失败恢复并验证重做结果', async (t) => {
  const ran = testSkills(t);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const advance = SKILLS.t_ok;
  SKILLS.t_ok = { ...advance, async run(ctx, args) {
    const result = await advance.run(ctx, args);
    adapter.pos = { ...adapter.pos, x: adapter.pos.x + 1 };
    return result;
  } };
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
    skill: { name: 'hop-when-blocked', description: '路被挡住时先迈一步', when: { after_failure: { skill: 't_fail', code: 'PATH_NOT_FOUND' } }, steps: [{ skill: 't_ok' }],
      verify: 'const s = await api.state(); return s.pos.x > args.before.pos.x ? true : "实际没有前进";' },
    activity: { what: '走过去', steps: [{ skill: 't_fail' }] } });
  assert.equal(behaviors.get('hop-when-blocked', true)?.mode, 'recover');
  assert.ok(behaviors.executionError('hop-when-blocked'), '候选不能当已学会的技能直接用');
  assert.equal(behaviors.recoveryFor({ skill: 't_fail', code: 'PATH_NOT_FOUND' }), null, '未验收的候选不自动接手失败');
  for (let i = 0; i < BehaviorEngine.MIN_EVIDENCE; i++) {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill: 'use_skill', args: { name: 'hop-when-blocked', trial: true } }, 'llm');
    assert.ok(!('error' in started), JSON.stringify(started));
    const outcome = await done;
    assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
    assert.equal(outcome.result.data?.verified, true, '每次试用核对实际位置变化');
  }
  assert.equal(behaviors.get('hop-when-blocked', true), undefined, '达到实际验收次数后晋级');
  assert.equal(behaviors.get('hop-when-blocked')?.mode, 'recover');
  assert.equal(behaviors.currentStats('hop-when-blocked').ok, BehaviorEngine.MIN_EVIDENCE);
  ran.length = 0;
  for (let i = 0; i < 6 && pending.length < 2; i++) { mind.tick(); await flush(); }
  assert.ok(pending.length >= 2, '初次未验收的恢复方案交回心智');
  await reply({ monologue: '已经试过有效的前进一步，继续走过去', decision: 'new', activity: { what: '再走过去', steps: [{ skill: 't_fail' }] } });
  const thinksBefore = pending.length;
  for (let i = 0; i < 6; i++) {
    mind.tick();
    const current = arbiter.info();
    if (current?.planId && current.planId === mind.activity?.id) await new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    await flush();
  }
  assert.deepEqual(ran.slice(0, 3), ['t_fail', 't_ok', 't_fail'], `先失败、照技能做、再重做：${ran}`);
  assert.equal(behaviors.statsOf('hop-when-blocked')?.fail, 1, '照技能做完了、但重做的那一步还是没成：记一次没用');
  assert.equal(behaviors.statsOf('hop-when-blocked')?.ok, BehaviorEngine.MIN_EVIDENCE, '自动恢复失败不能把试用证据改成成功');
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
  assert.ok(!engine.suppresses('lava', null), '没有声明替代 lava 的技能');
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
  assert.match((arbiter.start({ skill: 'use_skill', args: { name: 'nope' } }, 'llm') as any).error, /没有.*nope/);
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

test('专注提醒不改写瞥一眼的 switch：做完新活动不会自动恢复旧活动', async (t) => {
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
  assert.notEqual(mind.activity?.what, '砍木头', '明确放下的旧活动不自动恢复');
  assert.equal(mind.suspended.length, 0);
  assert.equal(mind.lastDecision!.kind, 'switch');
  assert.match(mind.lastDecision!.notes.join(), /保留你的明确决定/);
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
  const book = new SkillBook(BUILTIN_SKILLS_DIR, FIXTURES);
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

test('最后一步仍在执行时，不自动反复询问下一段', async (t) => {
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
  assert.equal(pending.length, 1, '最后一步仍在执行，不预判快干完');
  for (let i = 0; i < 5; i++) { mind.tick(); await flush(); }
  assert.equal(pending.length, 1, '运行中不会追问下一段');
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
  const book = new SkillBook(BUILTIN_SKILLS_DIR, FIXTURES);
  const engine = new BehaviorEngine(book, adapter, null, new EventBus(), noSenses);
  setBehaviorRegistry(engine);
  t.after(() => setBehaviorRegistry(null));
  assert.match((SKILLS.use_skill.validate({ name: 'local-path' }, adapter) as any).error, /args\.target/);
  assert.ok(SKILLS.use_skill.validate({ name: 'local-path', args: { target: '4,64,0' } }, adapter).ok);
  assert.ok(SKILLS.use_skill.validate({ name: 'local-path', failure: { skill: 'goto', args: { target: '4,64,0' }, target: { x: 4, y: 64, z: 0 } } }, adapter).ok, '恢复时由失败的那一步提供原参数和绝对目标');
});

test('身边方块图附带算好的落脚点和能放方块的格子', async () => {
  const { localMap } = await import('../src/perception/local.ts');
  const adapter = new FakeAdapter(); // 面朝东，平地
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }); // 正前方一格石头
  const m = localMap(adapter, adapter.pos, 'E', (positions) => positions.map((pos) => ({ pos, name: adapter.blockAt(pos)! })));
  assert.ok(m.spots.stand.some((s: string) => s.startsWith('[1,1,0]')), `能迈上前方的石头：${m.spots.stand}`);
  assert.ok(!m.spots.stand.some((s: string) => s.startsWith('[1,0,0]')), '石头那格站不进去');
  assert.ok(m.spots.place.some((s: string) => s.startsWith('[0,0,-1]')), `左边地上能放：${m.spots.place}`);
});

test('反射也是技能：躲苦力怕、受伤撤退、还手、饿了吃这类反应写成代码技能后由引擎接手', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, FIXTURES);
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
  // 事后观测：死亡、掉血、处境变化都是事实，不再自动把死亡算成这项技能的失败、把活着算成成功
  const aftermath: { type: string; data?: any }[] = [];
  bus.on('event', (e: any) => { if (e.type === 'skill_aftermath') aftermath.push(e); });
  current = null;
  bus.publish('death', 'P0', '死了');
  assert.equal(engine.statsOf('retreat-when-hurt')?.fail, 0, '死亡不再自动归因成技能失败');
  assert.ok(aftermath.some((e) => e.data.name === 'retreat-when-hurt' && e.data.died === true), '事后观测报告死亡事实');
  // 再来一次，12 秒后还活着、没再掉血：也不再自动算成功（成败由执行结果/verify 决定）
  now += 20_000; bus.publish('hurt', 'P2', '受到伤害'); reflex.tick();
  current = null; now += 13_000; reflex.tick();
  assert.equal(engine.statsOf('retreat-when-hurt')?.ok, 0);
  // 岩浆没有内置强制逃跑
  state.inLava = true; current = null; reflex.tick();
  assert.notEqual(starts.at(-1)?.skill, 'flee');
});
