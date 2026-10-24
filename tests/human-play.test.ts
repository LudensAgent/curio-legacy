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

test('最后一步是很快的合成时，倒数第二步快做完才开始想下一步（不在动作刚开始就想），并告诉模型还剩哪些步骤', async (t) => {
  const w = fixture(t);
  w.adapter.speed = 4;
  w.adapter.blocks.push({ name: 'oak_log', pos: { x: 8, y: 64, z: 0 } });
  await w.tick();
  w.pending[0].resolve(reply({ goal: '砍树做木板', thought: '前面有树', steps: [
    { skill: 'gather', args: { block: 'log', count: 1 } }, { skill: 'craft', args: { item: 'oak_planks', count: 4 } }] }));
  await flush(); await w.tick();
  assert.equal(w.arbiter.info()?.skill, 'gather');
  await w.tick();
  assert.equal(w.executive.inFlight, false, 'gather 刚开始时不预先想：那时的情况等它做完就过时了');
  let during = '';
  for (let i = 0; i < 80 && !w.executive.inFlight; i++) { during = w.arbiter.info()?.skill ?? ''; await w.advance(250); }
  assert.equal(w.executive.inFlight, true, '快做完时开始想下一步');
  assert.ok(['gather', 'craft'].includes(during), `应在最后两步进行时就开始想，而不是全部做完后：${during}`);
  // 假适配器里合成是瞬间完成的，所以请求可能是“合成中预先想”(prefetch)，也可能是刚做完(no_goal)；两者都只比实际晚一两秒
  const msgs = w.bus.recent().filter((e) => e.type === 'llm_request');
  assert.match(msgs.at(-1)?.msg ?? '', /prefetch|no_goal/);
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
  for (let i = 0; i < 80 && tiers().length < 2; i++) await w.advance(250);
  assert.equal(tiers().at(-1), 'light', '有意图、没失败的下一次决策走小决策');
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

test('复用自己放过的工作台/熔炉：记得的工作台在附近就去用，不再现做', async () => {
  const adapter = new FakeAdapter();
  const ctx = skillCtx(adapter);
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.addLandmark('discovery', '我的工作台', 'overworld', { x: 30, y: 64, z: 0 }, 2);
  let used: any;
  adapter.craft = async (_item: string, count: number, _signal: AbortSignal, opts?: any) => { used = opts?.tablePos; return { ok: true, crafted: count, tablePos: opts?.tablePos }; };
  try {
    const r = await SKILLS.craft.run(ctx, { item: 'white_bed', count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(used, { x: 30, y: 64, z: 0 });
    assert.match(r.summary, /记得的工作台/);
  } finally { ctx.memory.close(); }
});

test('放下工作台后记成“我的工作台”', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('crafting_table', 1);
  const memory = new WorldMemory(null);
  const ctx = skillCtx(adapter, new Vision(adapter), memory);
  adapter.useItemOn = async (item: string, target) => {
    if (target.kind !== 'block') return { ok: false, reason: 'NO_TARGET' };
    const placed = { ...target.pos, y: target.pos.y + 1 };
    adapter.blocks.push({ name: item, pos: placed });
    adapter.inv.set(item, adapter.inv.get(item)! - 1);
    return { ok: true, placed };
  };
  try {
    ctx.senses.refresh();
    const r = await SKILLS.use_item.run(ctx, { item: 'crafting_table', on: 'grass_block' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(memory.landmarks().some((l) => l.label === '我的工作台'));
  } finally { memory.close(); }
});

test('看见的功能方块（比如铁砧）会记成地标；自己放的不重复记', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.setWorld(adapter.worldId);
  adapter.blocks.push({ name: 'anvil', pos: { x: 6, y: 64, z: 0 } }, { name: 'crafting_table', pos: { x: 6, y: 64, z: 2 } });
  memory.addLandmark('discovery', '我的工作台', 'overworld', { x: 6, y: 64, z: 2 }, 2);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  try {
    perception.update();
    assert.ok(memory.landmarks().some((l) => l.label === '铁砧'));
    assert.equal(memory.landmarks().filter((l) => l.label.endsWith('工作台')).length, 1, '自己的工作台不再记一遍');
  } finally { memory.close(); }
});

test('睡觉：先走回自己记得的床，不再另放一张', async () => {
  const adapter = new FakeAdapter();
  adapter.isDay = false;
  const ctx = skillCtx(adapter);
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.addLandmark('discovery', '我的床', 'overworld', { x: 25, y: 64, z: 0 }, 2);
  adapter.sleepInBed = async () => ({ ok: true, bedPos: { x: 25, y: 64, z: 0 } });
  try {
    const r = await SKILLS.sleep.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(adapter.pos.x > 20, `应该走回床边，x=${adapter.pos.x}`);
  } finally { ctx.memory.close(); }
});

test('工作记忆：下一次决策能看到上一次的想法、笔记、打算，以及反复失败的做法', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '去东北的村子', thought: '东北 60 格有村民和铁傀儡', note: '村子在东北约 60 格', then: '到村子后找干草块和工作台',
    steps: [{ skill: 'gather', args: { block: 'log', count: 1 } }] }));
  await flush(); await w.tick();
  await w.advance(5000); // gather 失败 → 新的决策请求
  const ctx = (w.executive as any).ctx('failure');
  assert.match(ctx.notes[0], /^村子在东北约 60 格（(?:刚才|\d+ 分钟前)写于 -?\d+,-?\d+,-?\d+(?:，离这里 \d+ 格)?）$/);
  assert.equal(ctx.thread.at(-1).goal, '去东北的村子');
  assert.equal(ctx.thread.at(-1).then, '到村子后找干草块和工作台');
  assert.match(ctx.thread.at(-1).outcome, /failed/);
  const { lightUserPrompt } = await import('../src/planner/prompt.ts');
  const text = lightUserPrompt(ctx, w.memory);
  assert.match(text, /my_notes/);
  assert.match(text, /recent_thread/);
  assert.ok(w.bus.recent().some((e) => e.type === 'note'));
});

test('采集：记忆里的树已经不在了（被砍/不在加载范围）就跳过，不误报“缺工具”', async () => {
  const adapter = new FakeAdapter();
  const vision = new Vision(adapter);
  adapter.blocks.push({ name: 'oak_log', pos: { x: 6, y: 64, z: 0 } });
  vision.refresh();
  adapter.blocks = adapter.blocks.filter((b) => b.name !== 'oak_log'); // 树被别人砍了
  const ctx = skillCtx(adapter, vision);
  try {
    const r = await SKILLS.gather.run(ctx, { block: 'log', count: 1 });
    assert.notEqual(r.failureCode, 'TOOL_MISSING', r.summary);
  } finally { ctx.memory.close(); }
});

test('掉落物：看得见地上是什么、几个，能只捡想要的那种，并报告实际捡到的', async () => {
  const adapter = new FakeAdapter();
  const vision = new Vision(adapter);
  adapter.entities.push(
    { id: 501, name: 'item:raw_rabbit', kind: 'item', pos: { x: 5, y: 64, z: 0.5 }, dist: 0, height: 0.25, count: 2 },
    { id: 502, name: 'item:rabbit_hide', kind: 'item', pos: { x: 6, y: 64, z: 2 }, dist: 0, height: 0.25 },
  );
  vision.refresh();
  const drops = (vision.summary(adapter.pos) as any).visible_drops;
  assert.ok(drops?.some((d: any) => d.item === 'raw_rabbit' && d.count === 2), JSON.stringify(drops));
  const ctx = skillCtx(adapter, vision);
  try {
    const r = await SKILLS.pickup_items.run(ctx, (SKILLS.pickup_items.validate({ item: 'raw_rabbit' }, adapter) as any).args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /raw_rabbit/);
    assert.ok(adapter.entities.some((e) => e.name === 'item:rabbit_hide'), '没要的不捡');
  } finally { ctx.memory.close(); }
});

test('身边一圈：困在坑里时 self.around 说清四面走不了、看不见天；climb_up 垫方块爬出去', async () => {
  const adapter = new FakeAdapter();
  // 地下 3 格的一个一人高的小洞
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  adapter.removed.add('0,60,0'); adapter.removed.add('0,61,0');
  adapter.inv.set('cobblestone', 16);
  const { surroundings } = await import('../src/perception/surroundings.ts');
  const s = surroundings(adapter);
  assert.equal(s.enclosed, true, s.text);
  assert.equal(s.sky, false);
  assert.match(s.text, /四面都走不了/);
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.climb_up.run(ctx, { height: 12, untilSky: true });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(adapter.pos.y >= 63, `应该爬到地面，y=${adapter.pos.y}`);
    assert.match(r.summary, /看得见天空/);
  } finally { ctx.memory.close(); }
});

test('dig：往一个方向挖出一人高的通道并走进去；旁边有岩浆就停下', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  adapter.removed.add('0,60,0'); adapter.removed.add('0,61,0');
  const ctx = skillCtx(adapter);
  try {
    const r = await SKILLS.dig.run(ctx, { dir: 'E', blocks: 2 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(Math.floor(adapter.pos.x), 2);
    adapter.blocks.push({ name: 'lava', pos: { x: 4, y: 60, z: 0 } });
    const r2 = await SKILLS.dig.run(ctx, { dir: 'E', blocks: 2 });
    assert.match(r2.summary, /lava/);
    assert.equal(adapter.blockAt({ x: 3, y: 60, z: 0 }), 'stone', '岩浆旁边那格不挖');
  } finally { ctx.memory.close(); }
});

test('边做边想：决定里重复了思考期间已经做完的步骤 → 跳过；全是做完的 → 丢掉重想', async (t) => {
  const w = fixture(t);
  const ex = w.executive as any;
  const now = Date.now();
  ex.results.push({ skill: 'gather', args: { block: 'stone', count: 8 }, status: 'succeeded', summary: '采集了 8 个 stone', ts: now + 1 });
  ex.results.push({ skill: 'craft', args: { item: 'stone_sword', count: 1 }, status: 'succeeded', summary: '合成了 stone_sword', ts: now + 2 });
  const basis = { at: now, reason: 'prefetch', pending: [{ skill: 'gather', args: { block: 'stone', count: 8 } }, { skill: 'craft', args: { item: 'stone_sword' } }] };
  const p1: any = { steps: [{ skill: 'gather', args: { block: 'stone', count: 8 } }, { skill: 'craft', args: { item: 'stone_sword', count: 1 } }, { skill: 'gather', args: { block: 'log', count: 4 } }], basis };
  assert.equal(ex.dropDoneSteps(p1), true);
  assert.deepEqual(p1.steps.map((s: any) => s.skill), ['gather']);
  assert.equal(p1.steps[0].args.block, 'log');
  const p2: any = { steps: [{ skill: 'gather', args: { block: 'stone', count: 8 } }], basis };
  assert.equal(ex.dropDoneSteps(p2), false);
});

test('小决策（边做边想）明确告诉模型手头的步骤会先做完；DeepSeek 小决策关闭长篇思考', async () => {
  const { lightUserPrompt } = await import('../src/planner/prompt.ts');
  const memory = new WorldMemory(null);
  try {
    const percept: any = { inventory: [], emptySlots: 36, nearby: { hostile: [], passive: [], resources: [] }, vision: null, self: { pos: [0, 64, 0] }, time: {} };
    const text = lightUserPrompt({ reason: 'prefetch', percept, current: { skill: 'gather', args: { block: 'stone', count: 8 }, progress: 0.6 } as any, pendingSteps: [{ skill: 'craft', args: { item: 'stone_sword' } }] } as any, memory);
  assert.match(text, /仍待结果确认/);
  assert.match(text, /不能把预计产出当成已经发生的事实/);
    assert.match(text, /gather .*stone.* → craft/);
  } finally { memory.close(); }
  const http = await import('node:http');
  const bodies: any[] = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { bodies.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { OpenAICompatibleProvider } = await import('../src/planner/llm.ts');
  const p = new OpenAICompatibleProvider({ provider: 'openai', providerLabel: 'x', baseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, apiKey: '', model: 'deepseek-flash', temperature: 0.5, jsonMode: true, timeoutMs: 5000, maxTokens: 100, maxCallsPerHour: 10, fakeDelayMs: 0, stream: false });
  await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), { tier: 'light' });
  await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), { tier: 'full' });
  srv.close();
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[1].thinking, undefined, '完整决策照常思考');
});

test('材料缺口：想做什么 → 背包抵扣 → 还差哪些原材料（有桦木就用桦木，床不走改色配方，铁靠烧）', async () => {
  const { materialPlan, describePlan } = await import('../src/methods/shortfall.ts');
  const p1 = materialPlan('stone_pickaxe', 1, [{ name: 'birch_log', count: 1 }, { name: 'cobblestone', count: 1 }] as any);
  assert.deepEqual(p1.raw.map((r) => [r.item, r.count]), [['cobblestone', 2]], describePlan(p1));
  const door = materialPlan('birch_door', 1, [{ name: 'birch_log', count: 1 }] as any);
  assert.deepEqual(door.raw.map((r) => [r.item, r.count]), [['birch_log', 1]], describePlan(door));
  assert.deepEqual(materialPlan('white_bed', 1, [{ name: 'birch_planks', count: 3 }] as any).raw.map((r) => r.item), ['white_wool']);
  const pick = materialPlan('iron_pickaxe', 1, [{ name: 'stick', count: 2 }] as any);
  assert.equal(pick.raw[0].item, 'raw_iron');
  assert.equal(pick.smelts[0].item, 'iron_ingot');
  assert.equal(materialPlan('crafting_table', 1, [{ name: 'oak_planks', count: 4 }] as any).enough, true);
});

test('gather 写 for：按缺口采，够了就不采', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('birch_log', 1);
  for (const x of [4, 5, 6]) adapter.blocks.push({ name: 'birch_log', pos: { x, y: 64, z: 0 } });
  const ctx = skillCtx(adapter);
  try {
    const v = SKILLS.gather.validate({ block: 'birch_log', for: { item: 'birch_door', count: 1 } }, adapter) as any;
    assert.equal(v.ok, true, v.error);
    const r = await SKILLS.gather.run(ctx, v.args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.dug, 1, r.summary);
    const again = await SKILLS.gather.run(ctx, v.args);
    assert.match(again.summary, /不用采了/);
  } finally { ctx.memory.close(); }
});

test('goto 认得各种坐标写法、作品 ID 和记得的工作台', async () => {
  const adapter = new FakeAdapter();
  adapter.speed = 1000;
  const ctx = skillCtx(adapter);
  ctx.memory.setWorld(adapter.worldId);
  try {
    let r = await SKILLS.goto.run(ctx, { target: '(-3,64,-10)' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(Math.abs(adapter.pos.x + 3) < 3 && Math.abs(adapter.pos.z + 10) < 3);
    ctx.memory.addLandmark('discovery', '我的工作台', 'overworld', { x: 20, y: 64, z: 5 }, 2);
    r = await SKILLS.goto.run(ctx, { target: 'crafting_table' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(Math.abs(adapter.pos.x - 20) < 3);
    const { buildingArchiveFor } = await import('../src/skills/build.ts');
    const { compileBuilding, materialCost, normalizeSpec } = await import('../src/building/spec.ts');
    const spec = normalizeSpec({});
    const proj = buildingArchiveFor(ctx.memory).design({ worldId: adapter.worldId, dimension: 'overworld', origin: { x: -30, y: 64, z: 7 }, rotation: 0, spec, materials: materialCost(compileBuilding(spec).cells) });
    r = await SKILLS.goto.run(ctx, { target: proj.id.slice(0, 8) });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(Math.abs(adapter.pos.x + 30) < 3);
    r = await SKILLS.goto.run(ctx, { target: '不存在的地方' });
    assert.match(r.summary, /工作台|坐标/);
  } finally { ctx.memory.close(); }
});

test('吃东西的反射：有点饿时不在打猎中途把刚捡到的生肉吃掉；真饿了才有什么吃什么', async () => {
  const { Reflex } = await import('../src/brain/reflex.ts');
  const adapter = new FakeAdapter(), bus = new EventBus();
  const vision = new Vision(adapter);
  const memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const reflex = new Reflex(adapter, arbiter, bus, vision);
  adapter.hasFood = () => adapter.inv.size > 0;
  adapter.inv.set('beef', 2);
  adapter.food = 10;
  reflex.tick();
  assert.notEqual(arbiter.info()?.skill, 'eat', '有点饿 + 只有生肉：不反射吃');
  adapter.inv.set('bread', 1);
  reflex.tick();
  assert.equal(arbiter.info()?.skill, 'eat', '有面包就顺手吃');
  arbiter.cancel('test');
  const adapter2 = new FakeAdapter(), bus2 = new EventBus(), vision2 = new Vision(adapter2), arbiter2 = new Arbiter(adapter2, memory, bus2, vision2);
  const reflex2 = new Reflex(adapter2, arbiter2, bus2, vision2);
  adapter2.hasFood = () => true; adapter2.inv.set('beef', 2); adapter2.food = 5;
  reflex2.tick();
  assert.equal(arbiter2.info()?.skill, 'eat', '真饿了生肉也吃');
  arbiter2.cancel('test');
  memory.close();
});

test('火把反射：脚下是半砖/草丛读到 0 不算“地下太暗”；打猎、合成中途不插火把，身边已有火把也不插', async () => {
  const { Reflex } = await import('../src/brain/reflex.ts');
  const memory = new WorldMemory(null);
  const adapter = new FakeAdapter(), bus = new EventBus(), vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const reflex = new Reflex(adapter, arbiter, bus, vision);
  adapter.inv.set('torch', 8);
  // 林子里：脚那格读成 0，头那格是天光
  adapter.lightAt = (x: number, y: number) => (y === 64 ? { block: 0, sky: 0 } : { block: 0, sky: 15 });
  reflex.tick();
  assert.notEqual(arbiter.info()?.skill, 'place_torch', '露天不插');
  // 真正在地下：脚和头都暗，头顶有石头封顶（露天时读成 0 只是光照数据没下发，不算暗）
  adapter.lightAt = () => ({ block: 0, sky: 0 });
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 67, z: 0 } });
  arbiter.start({ skill: 'hunt', args: { animal: 'cow', count: 1 } }, 'llm');
  reflex.tick();
  assert.equal(arbiter.info()?.skill, 'hunt', '打猎中途不插');
  arbiter.cancel('test');
  adapter.blocks.push({ name: 'torch', pos: { x: 2, y: 64, z: 1 } });
  reflex.tick();
  assert.notEqual(arbiter.info()?.skill, 'place_torch', '身边已经有火把');
  adapter.blocks = adapter.blocks.filter((b) => b.name !== 'torch');
  (reflex as any).cooldown.clear();
  reflex.tick();
  assert.equal(arbiter.info()?.skill, 'place_torch', '空手在地下暗处才插');
  arbiter.cancel('test');
  memory.close();
});
