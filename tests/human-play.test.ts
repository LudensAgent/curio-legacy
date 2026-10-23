import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter, type Step, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { normalizeDecision, validateIntentDecision } from '../src/intentions/decision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { explore, lookAround, surface } from '../src/skills/movement.ts';
import { ok, type SkillCtx } from '../src/skills/types.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };

// ------------------------------------------------------------ 决策格式：能纠正的就地纠正
test('decision 格式小错就地纠正：缺省、continue 带 intent、无当前意图的 continue', () => {
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter();
  try {
    let n = normalizeDecision(undefined, { goal: '砍几棵树', thought: '想要点木头' }, memory);
    assert.equal(n.decision.kind, 'begin');
    assert.equal(n.decision.intent.text, '砍几棵树');
    assert.ok(validateIntentDecision(n.decision, memory, adapter).ok);

    n = normalizeDecision({ kind: 'continue', reason: '继续砍树', intent: { text: '砍树' } }, { goal: '砍树' }, memory);
    assert.equal(n.decision.kind, 'begin', '没有进行中的意图时 continue 改为 begin');
    assert.ok(validateIntentDecision(n.decision, memory, adapter).ok, JSON.stringify(n));

    memory.addIntent({ text: '收集木头', whyNow: '要做工具', context: [], tradeoffs: [], source: 'model', status: 'active' });
    n = normalizeDecision({ kind: 'continue', reason: '还差几块', intent: { text: '收集更多木头' } }, { goal: '继续砍树' }, memory);
    assert.equal(n.decision.kind, 'continue');
    assert.equal(n.decision.intent, undefined, 'continue 附带的 intent 文字被忽略而不是让整轮作废');
    assert.ok(n.notes.some((x) => x.includes('忽略')));
    assert.ok(validateIntentDecision(n.decision, memory, adapter).ok);

    n = normalizeDecision(undefined, { goal: '继续砍树' }, memory);
    assert.equal(n.decision.kind, 'continue');
    assert.ok(validateIntentDecision(n.decision, memory, adapter).ok);
  } finally { memory.close(); }
});

// ------------------------------------------------------------ 执行层 fixture
const reply = (body: object): Completion => ({ latencyMs: 500, text: JSON.stringify(body) });

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const previous = SKILLS.test_guard;
  SKILLS.test_guard = { name: 'test_guard', description: 'test survival reflex', argsDoc: '{}', timeoutMs: 30000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async (ctx) => { await sleep(100, ctx.signal); return ok('打退了'); } };
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (value: Completion) => void }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'human-play-test', complete: () => new Promise((resolve) => pending.push({ resolve })) }, adapter, memory, bus, null);
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner });
  executive.start(1_000_000);
  t.after(() => {
    executive.stop(); arbiter.cancel('test end'); memory.close();
    if (previous) SKILLS.test_guard = previous; else delete SKILLS.test_guard;
  });
  const tick = async () => { executive.tick(); await flush(); };
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) {
      const step = Math.min(25, left);
      t.mock.timers.tick(step); await flush(); left -= step;
    }
    await tick();
  };
  const started = (skill: string) => bus.recent().filter((e) => e.type === 'task_start' && e.data?.skill === skill && e.data?.source === 'llm');
  return { adapter, memory, bus, arbiter, executive, pending, tick, advance, started };
}

test('被生存反射打断的采集，反射结束后接着采剩下的；同一步被同一反射打断两次才交还给 LLM', async (t) => {
  const w = fixture(t);
  w.adapter.speed = 4;
  w.adapter.blocks.push(...[8, 10, 12].map((x) => ({ name: 'oak_log', pos: { x, y: 64, z: 0 } })));
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍三块木头', thought: '前面有树', steps: [{ skill: 'gather', args: { block: 'log', count: 3 } }] }));
  await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'gather');
  await w.advance(300);
  w.arbiter.start({ skill: 'test_guard', args: {} }, 'reflex');
  await w.advance(200);
  assert.ok(w.bus.recent().some((e) => e.type === 'resume_step'), '反射结束后继续原计划');
  assert.equal(w.started('gather').length, 2);
  assert.equal(w.bus.recent().filter((e) => e.type === 'attempt_end' && e.data?.status === 'interrupted').length, 0, '一次打断不会丢掉计划');
  assert.ok(w.executive.plan, '计划还在');

  await w.advance(300);
  w.arbiter.start({ skill: 'test_guard', args: {} }, 'reflex');
  await w.advance(200);
  assert.equal(w.executive.plan, null);
  const failure = w.executive.snapshot().lastFailure;
  assert.equal(failure?.code, 'REFLEX_REPEATED');
  assert.match(failure?.summary ?? '', /换个方法或方向/);
});

test('计划细化：explore 后面的无目标环顾被跳过；explore 后要采集的东西会成为 until', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '去找树', thought: '这里没树', steps: [
    { skill: 'explore', args: { direction: 'E', distance: 48 } },
    { skill: 'look_around', args: { seconds: 6 } },
    { skill: 'gather', args: { block: 'log', count: 4 } },
  ] }));
  await flush(); await w.tick();
  const plan = w.executive.plan!;
  assert.deepEqual(plan.steps.map((s) => s.skill), ['explore', 'gather']);
  assert.equal((plan.steps[0].args as any).until, 'log');
  assert.ok(w.bus.recent().some((e) => e.type === 'plan_refined'));
});

test('有目的的寻找（look_around for）不会被跳过', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '找牛', thought: '饿了', steps: [{ skill: 'explore', args: { direction: 'E', distance: 48 } }, { skill: 'look_around', args: { for: 'cow' } }] }));
  await flush(); await w.tick();
  assert.deepEqual(w.executive.plan!.steps.map((s) => s.skill), ['explore', 'look_around']);
});

test('模型的 continue 带了 intent 文字也能直接执行，不会被判无效', async (t) => {
  const w = fixture(t);
  w.memory.addIntent({ text: '收集木头', whyNow: '要做工具', context: [], tradeoffs: [], source: 'model', status: 'active' });
  await w.tick();
  w.pending[0].resolve(reply({ goal: '继续砍树', thought: '还差几块', decision: { kind: 'continue', reason: '还差几块', intent: { text: '砍树' } },
    steps: [{ skill: 'look_around', args: { for: 'log' } }] }));
  await flush(); await w.tick();
  assert.equal(w.bus.recent().filter((e) => e.type === 'llm_invalid').length, 0);
  assert.ok(w.bus.recent().some((e) => e.type === 'decision_normalized'));
  assert.equal(w.arbiter.info()?.skill, 'look_around');
});

// ------------------------------------------------------------ 技能：边走边看、定向寻找、冰下上浮
function skillCtx(adapter: FakeAdapter, vision = new Vision(adapter), memory = new WorldMemory(null)): SkillCtx {
  return { adapter, senses: vision, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 60000, taskId: 't', progress() {} };
}

test('explore until：路上一看见要找的东西就停下，不走完全程', async () => {
  const adapter = new FakeAdapter();
  adapter.speed = 80;
  adapter.blocks.push({ name: 'oak_log', pos: { x: 60, y: 64, z: 0 } }, { name: 'oak_log', pos: { x: 60, y: 65, z: 0 } });
  const ctx = skillCtx(adapter);
  try {
    const r = await explore.run(ctx, { direction: 'E', distance: 160, until: 'log' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.found, 'oak_log');
    assert.ok(adapter.pos.x < 140, `应该在看见树后停下，实际走到 x=${adapter.pos.x}`);
  } finally { ctx.memory.close(); }
});

test('explore：每段路走完会左右张望（不需要额外 look_around）', async () => {
  const adapter = new FakeAdapter();
  adapter.speed = 200;
  const yaws: number[] = [];
  const look = adapter.look.bind(adapter);
  adapter.look = async (yaw: number, pitch: number) => { yaws.push(yaw); return look(yaw, pitch); };
  const ctx = skillCtx(adapter);
  try {
    const r = await explore.run(ctx, { direction: 'E', distance: 64 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(yaws.length >= 6, `两段路各张望一次，实际转头 ${yaws.length} 次`);
  } finally { ctx.memory.close(); }
});

test('look_around for + direction：只看指定方向的扇形，看见就停', async () => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'oak_log', pos: { x: 0, y: 64, z: 15 } }, { name: 'oak_log', pos: { x: 0, y: 65, z: 15 } }); // 南边
  const yaws: number[] = [];
  const look = adapter.look.bind(adapter);
  adapter.look = async (yaw: number, pitch: number) => { yaws.push(yaw); return look(yaw, pitch); };
  const ctx = skillCtx(adapter);
  try {
    const r = await lookAround.run(ctx, { seconds: 2, for: 'log', direction: 'S' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(yaws.length <= 5);
    const miss = await lookAround.run(ctx, { seconds: 2, for: 'cow', direction: 'N' });
    assert.equal(miss.status, 'failed');
    assert.equal(miss.failureCode, 'NOT_FOUND');
  } finally { ctx.memory.close(); }
});

test('surface：头顶被冰封住时先挖开；找不到岸但能呼吸时算脱险', async () => {
  const adapter = new FakeAdapter();
  adapter.inWater = true; adapter.oxygen = 8;
  adapter.pos = { x: 0.5, y: 61, z: 0.5 };
  adapter.blocks.push({ name: 'water', pos: { x: 0, y: 62, z: 0 } }, { name: 'ice', pos: { x: 0, y: 63, z: 0 } });
  const dug: string[] = [];
  const dig = adapter.dig.bind(adapter);
  adapter.dig = async (pos, signal) => { dug.push(`${adapter.blockAt(pos)}@${pos.y}`); return dig(pos, signal); };
  let now = Date.now();
  const realNow = Date.now;
  Date.now = () => (now += 2000);
  const ctx = skillCtx(adapter);
  ctx.deadline = Infinity;
  ctx.senses = { ...ctx.senses, refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [], nearestLand: () => null };
  try {
    const r = await surface.run(ctx, {});
    assert.deepEqual(dug.slice(0, 1), ['ice@63']);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.afloat, true);
    assert.equal(r.data?.landed, false);
  } finally { Date.now = realNow; ctx.memory.close(); }
});

void ({} as TaskOutcome);

test('合成失败时说清楚还差多少材料（1 块原木做不了工作台 + 木镐）', async () => {
  const { woodShortfall } = await import('../src/skills/work.ts');
  assert.match(woodShortfall('wooden_pickaxe', 1, [{ name: 'dark_oak_log', count: 1 }], false) ?? '', /还差约 1 块原木/);
  assert.equal(woodShortfall('wooden_pickaxe', 1, [{ name: 'oak_log', count: 2 }], false), null);
  assert.match(woodShortfall('stone_pickaxe', 1, [{ name: 'oak_planks', count: 4 }, { name: 'cobblestone', count: 1 }], true) ?? '', /圆石还差 2 块/);
});

test('失败后不干等：先做补救动作（没找到 → 边走边找），同时请求新决策；新决策一到就替换补救', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍木头', thought: '要做工具', steps: [{ skill: 'gather', args: { block: 'log', count: 2 } }] }));
  await flush(); await w.tick();
  await w.advance(5000); // gather 会先转头找一圈，然后 NOT_FOUND
  const fallback = w.bus.recent().find((e) => e.type === 'plan_fallback');
  assert.ok(fallback, '应该有补救动作');
  assert.equal(w.arbiter.info()?.skill, 'explore');
  assert.equal((w.arbiter.info()?.args as any).until, 'log');
  assert.equal(w.executive.inFlight, true, '补救的同时已经在请求新决策');
  const last = w.pending.at(-1)!;
  last.resolve(reply({ goal: '换个地方', thought: '这边没树', steps: [{ skill: 'look_around', args: { for: 'cow' } }] }));
  await flush(); await w.tick(); await w.tick();
  const ends = w.bus.recent().filter((e) => e.type === 'attempt_end');
  assert.equal(ends.at(-1)?.data?.status, 'failed');
  assert.match(ends.at(-1)?.msg ?? '', /补救动作已被新决策取代/);
  assert.equal(w.arbiter.info()?.skill, 'look_around');
});

test('模型给的 on_fail 优先于程序推断的补救', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍木头', thought: '要做工具', steps: [{ skill: 'gather', args: { block: 'log', count: 2 } }],
    on_fail: [{ skill: 'explore', args: { direction: 'S', distance: 30, until: 'log' } }] }));
  await flush(); await w.tick();
  await w.advance(5000);
  assert.equal(w.arbiter.info()?.skill, 'explore');
  assert.equal((w.arbiter.info()?.args as any).direction, 'S');
  assert.match(w.bus.recent().find((e) => e.type === 'plan_fallback')?.msg ?? '', /按预案/);
});

test('吃东西的反射不算危险：同一步被打断多次也照样接着做', async (t) => {
  const w = fixture(t);
  w.adapter.speed = 4;
  w.adapter.blocks.push(...[8, 10, 12].map((x) => ({ name: 'oak_log', pos: { x, y: 64, z: 0 } })));
  const prev = SKILLS.eat;
  t.after(() => { SKILLS.eat = prev; });
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍三块木头', thought: '前面有树', steps: [{ skill: 'gather', args: { block: 'log', count: 3 } }] }));
  await flush(); await w.tick();
  for (let i = 0; i < 3; i++) {
    await w.advance(300);
    w.adapter.inv.set('bread', 1);
    w.arbiter.start({ skill: 'eat', args: {} }, 'reflex');
    await w.advance(300);
  }
  assert.ok(w.executive.plan, '计划没有被丢掉');
  assert.notEqual(w.executive.snapshot().lastFailure?.code, 'REFLEX_REPEATED');
  assert.equal(w.bus.recent().filter((e) => e.type === 'resume_step').length, 3);
});

test('吃东西一次吃饱：饱食度到 18 以上才停', async () => {
  const adapter = new FakeAdapter();
  adapter.food = 8; adapter.inv.set('bread', 10);
  adapter.eat = async () => { adapter.food = Math.min(20, adapter.food + 3); adapter.inv.set('bread', adapter.inv.get('bread')! - 1); return true; };
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.eat.run(ctx, {});
    assert.equal(r.status, 'succeeded');
    assert.ok(adapter.food >= 18, `food=${adapter.food}`);
    assert.equal(r.data?.bites, 4);
  } finally { ctx.memory.close(); }
});

test('采集只算真正拿到手的：挖了但掉落物没进背包不算数', async () => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'stone', pos: { x: 3, y: 64, z: 0 } });
  adapter.dig = async () => ({ ok: true }); // 方块挖了，但什么都没进背包（掉进水里）
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.gather.run(ctx, { block: 'stone', count: 2 });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /掉落物都没捡到/);
    assert.equal(r.data?.dug, 0);
  } finally { ctx.memory.close(); }
});

test('打猎：动物刚走出视线先转头找；跑掉的不算猎到', async () => {
  const adapter = new FakeAdapter();
  adapter.entities.push({ id: 41, name: 'rabbit', kind: 'passive', pos: { x: -10, y: 64, z: 0 }, dist: 0, height: 0.5 }); // 在背后
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.hunt.run(ctx, { animal: 'rabbit', count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(adapter.actions.includes('attack:41'), '转头看见后追上去打');
  } finally { ctx.memory.close(); }
  const a2 = new FakeAdapter();
  a2.entities.push({ id: 42, name: 'cow', kind: 'passive', pos: { x: 12, y: 64, z: 0 }, dist: 0, height: 1.4 });
  a2.moveTo = async () => { a2.entities = []; }; // 一追就跑出视线
  const c2 = skillCtx(a2);
  try {
    const r = await SKILLS.hunt.run(c2, { animal: 'cow', count: 1 });
    assert.equal(r.status, 'failed', '跑掉的牛不能算猎到');
    assert.match(r.summary, /跑出了视线|跑掉/);
  } finally { c2.memory.close(); }
});

test('旁边有水时不往下挖（一挖水就灌进来）', async () => {
  const adapter = new FakeAdapter();
  adapter.pitch = 0.3; // 抬头看不到可采的石头，只能考虑往下挖
  adapter.blocks.push({ name: 'water', pos: { x: 1, y: 63, z: 0 } }); // 紧挨着脚下那块草方块
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.gather.run(ctx, { block: 'stone', count: 1 });
    assert.ok(!adapter.actions.some((a) => a.startsWith('dig:')), `不应往下挖：${adapter.actions.join(',')}`);
    assert.equal(r.status, 'failed');
  } finally { ctx.memory.close(); }
});

test('最后一步是很快的合成时，在倒数第二步就开始想下一步，并告诉模型还剩哪些步骤', async (t) => {
  const w = fixture(t);
  w.adapter.speed = 4;
  w.adapter.blocks.push({ name: 'oak_log', pos: { x: 8, y: 64, z: 0 } });
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍树做木板', thought: '前面有树', steps: [
    { skill: 'gather', args: { block: 'log', count: 1 } }, { skill: 'craft', args: { item: 'oak_planks', count: 4 } }] }));
  await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'gather');
  await w.tick();
  assert.equal(w.executive.inFlight, true, 'gather 还在进行时就已经在预规划');
  const msgs = w.bus.recent().filter((e) => e.type === 'llm_request');
  assert.match(msgs.at(-1)?.msg ?? '', /prefetch/);
});

test('打猎：远远看见过的牛被墙挡住了，先走到最后看见它的地方再打（不透视）', async () => {
  const adapter = new FakeAdapter();
  adapter.speed = 80;
  adapter.entities.push({ id: 51, name: 'cow', kind: 'passive', pos: { x: 20, y: 64, z: 0 }, dist: 0, height: 1.4 });
  const vision = new Vision(adapter);
  vision.refresh(); // 看见了牛
  assert.ok(vision.lastSighting((n) => n === 'cow'), '应记住看见牛的位置');
  for (let y = 64; y <= 68; y++) for (let z = -4; z <= 4; z++) adapter.blocks.push({ name: 'stone', pos: { x: 10, y, z } });
  await sleep(200); vision.refresh();
  assert.equal(vision.perceivedEntities(48).filter((e) => e.name === 'cow').length, 0, '墙后看不见');
  const ctx = skillCtx(adapter, vision);
  try {
    const r = await SKILLS.hunt.run(ctx, { animal: 'cow', count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(adapter.actions.includes('attack:51'));
  } finally { ctx.memory.close(); }
});

test('explore until 支持多个目标和 animal 类别', async () => {
  const adapter = new FakeAdapter();
  adapter.entities.push({ id: 61, name: 'pig', kind: 'passive', pos: { x: 8, y: 64, z: 0 }, dist: 0, height: 0.9 });
  const ctx = skillCtx(adapter);
  try {
    let r = await explore.run(ctx, { direction: 'E', distance: 48, until: 'cow|pig' });
    assert.equal(r.data?.found, 'pig');
    r = await explore.run(ctx, { direction: 'E', distance: 48, until: 'animal' });
    assert.equal(r.data?.found, 'pig');
  } finally { ctx.memory.close(); }
});

test('1.20.1 的草丛方块名是 grass：collect_seeds 能找到', async () => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'grass', pos: { x: 4, y: 64, z: 0 } }, { name: 'grass', pos: { x: 5, y: 64, z: 1 } });
  const ctx = skillCtx(adapter);
  try {
    ctx.senses.refresh();
    const r = await SKILLS.collect_seeds.run(ctx, { count: 1 });
    assert.doesNotMatch(r.summary, /视野里没有草丛/);
    assert.ok(adapter.actions.some((a) => a === 'dig:grass'), adapter.actions.join(','));
  } finally { ctx.memory.close(); }
});

// ------------------------------------------------------------ 分级决策
test('小决策只发精简上下文；模型要求时升级为完整决策', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.addIntent({ text: '收集木头做工具', whyNow: '空手', context: [], tradeoffs: [], source: 'model', status: 'active' });
  const vision = new Vision(adapter);
  const perception = new Perception(adapter, memory, bus, vision);
  const sent: string[][] = [];
  const replies = [JSON.stringify({ kind: 'need_full_context', reason: '想换个目标' }), JSON.stringify({ goal: '去探索', thought: '换换口味', steps: [{ skill: 'explore', args: { direction: 'N', distance: 48 } }] })];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const rows: any[] = [];
  const planner = new Planner(cfg, { name: 'tier-test', complete: async (messages) => { sent.push(messages.map((m) => m.content)); return { text: replies.shift()!, latencyMs: 10 }; } }, adapter, memory, bus, { write: (r: unknown) => rows.push(r) } as any);
  try {
    const base = { percept: perception.update(), current: null, lastFailure: null, userSuggestion: null, results: [] };
    const plan = await planner.propose({ ...base, reason: 'prefetch', tier: 'light' });
    assert.equal(plan.goal, '去探索');
    assert.equal(sent.length, 2);
    const lightChars = sent[0].join('').length, fullChars = sent[1].join('').length;
    assert.match(sent[0][0], /小决策/);
    assert.ok(lightChars * 2 < fullChars, `小决策应明显更短：${lightChars} vs ${fullChars}`);
    assert.deepEqual(planner.stats.tiers, { light: 1, full: 1, escalated: 1 });
    assert.equal(rows.at(-1)?.tier, 'full', 'LLM 日志记录这次是哪一级决策');
    assert.equal(planner.stats.tierLatency.light.n, 1);
    assert.ok(bus.recent().some((e) => e.type === 'llm_escalate'));
    assert.equal(bus.recent().filter((e) => e.type === 'llm_invalid').length, 0);
  } finally { memory.close(); }
});

test('执行层：进展顺利时的预规划用小决策，失败后和每隔几次用完整决策', async (t) => {
  const w = fixture(t);
  w.adapter.speed = 2;
  w.adapter.blocks.push(...[10, 12, 14, 16, 18].map((x) => ({ name: 'oak_log', pos: { x, y: 64, z: 0 } })));
  await w.tick();
  const tiers = () => w.bus.recent().filter((e) => e.type === 'llm_request').map((e) => e.data?.tier);
  assert.deepEqual(tiers(), ['full'], '第一次决策是完整的');
  w.pending[0].resolve(reply({ goal: '砍木头', thought: '有树', steps: [{ skill: 'gather', args: { block: 'log', count: 1 } }] }));
  await flush(); await w.tick(); await w.tick();
  assert.equal(tiers().at(-1), 'light', '有意图、没失败的预规划走小决策');
});

test('小决策是常态：有进行中的意图时，失败后的换法也走小请求并带上失败原因；没有意图时走完整决策', async (t) => {
  const w = fixture(t);
  const sent: string[] = [];
  // 截获发给模型的消息
  const planner = (w.executive as any).d.planner as Planner;
  const provider = (planner as any).provider;
  const complete = provider.complete;
  provider.complete = (messages: any[], ...rest: any[]) => { sent.push(messages.map((m) => m.content).join('\n')); return complete(messages, ...rest); };
  await w.tick();
  let tiers = () => w.bus.recent().filter((e) => e.type === 'llm_request').map((e) => e.data?.tier);
  assert.deepEqual(tiers(), ['full'], '还没有意图：完整决策');
  w.pending[0].resolve(reply({ goal: '砍木头', thought: '要做工具', steps: [{ skill: 'gather', args: { block: 'log', count: 2 } }] }));
  await flush(); await w.tick();
  await w.advance(5000); // gather 找不到 → 失败 → 请求新决策
  assert.ok(w.bus.recent().some((e) => e.type === 'llm_request' && /failure/.test(e.msg)));
  assert.equal(tiers().at(-1), 'light', '有意图时失败后的换法走小决策');
  assert.match(sent.at(-1) ?? '', /小决策/);
  assert.match(sent.at(-1) ?? '', /last_failure/);
  assert.match(sent.at(-1) ?? '', /刚才那一步没成功/);
});

test('缓存友好：只有实时状态变化时，连续两次请求共享大部分前缀', async () => {
  const { buildMessages, buildLightMessages } = await import('../src/planner/prompt.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.addIntent({ text: '收集木头做工具', whyNow: '空手', context: ['附近有树'], tradeoffs: [], source: 'model', status: 'active' });
  for (let i = 0; i < 6; i++) memory.addLandmark('resource', `oak_log_${i}`, 'overworld', { x: i * 20, y: 64, z: i * 7 });
  for (let i = 0; i < 4; i++) memory.recordGoal({ goal: `尝试 ${i}`, goalType: 'gather', source: 'llm', status: 'succeeded', summary: '采集了 3 个 oak_log', steps: ['gather:log'] });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const ctxAt = (x: number) => { adapter.pos = { x, y: 64, z: 0 }; return { reason: 'prefetch', percept: perception.update(), current: null, lastFailure: null, userSuggestion: null, results: [] }; };
  const common = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  try {
    for (const build of [(c: any) => buildMessages('Curio', c, memory), (c: any) => buildLightMessages('Curio', c, memory)]) {
      const a = build(ctxAt(0)), b = build(ctxAt(3));
      assert.equal(a[0].content, b[0].content, '系统提示完全不变');
      const shared = common(a[1].content, b[1].content) / a[1].content.length;
      assert.ok(shared > 0.5, `用户消息共享前缀 ${(shared * 100).toFixed(0)}% 太短`);
    }
  } finally { memory.close(); }
});
