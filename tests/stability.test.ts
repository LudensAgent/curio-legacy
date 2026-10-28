import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { shortageOf } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { archiveForReview } from '../src/memory/clear.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { isThreat, situationOf } from '../src/mind/predicate.ts';
import { Vision } from '../src/perception/vision.ts';
import { describeBuildProblems } from '../src/skills/build.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-stab-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };

function engine() {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  return { adapter, bus, book, engine: new BehaviorEngine(book, adapter, null, bus, noSenses) };
}

test('技能改写不清空历史：成败按版本记；后台总结推翻不了还没用够几次的版本（没触发过、代码报错的除外）', () => {
  const { engine: e } = engine();
  const skill = (how: string) => ({ name: 'dodge-zombie', description: `僵尸贴脸时${how}`, when: { hostile: { name: 'zombie', within: 4 } }, steps: [{ skill: 'flee', args: { distance: 12 } }] });
  assert.ok(e.write(skill('跑开')).ok);
  assert.match(String(e.rewriteGate('dodge-zombie')), /才写下、还没用过/, '刚写下就改写：同一个想法来回换说法');
  e.statsOf('dodge-zombie')!.writtenAt = Date.now() - BehaviorEngine.REWRITE_GAP_MS - 1;
  assert.equal(e.rewriteGate('dodge-zombie'), null, '一次都没用过、也写下有一会儿了：改写不丢证据');
  const rec = (ok: boolean) => (e as any).record(e.get('dodge-zombie'), ok, ok ? '躲开了' : '还是被打', {});
  rec(false);
  const gated = e.write(skill('原地垫高'), { by: 'forge' });
  assert.equal(gated.ok, false);
  assert.match((gated as any).error, /证据还不够/);
  assert.ok(e.write(skill('原地垫高'), { by: 'mind' }).ok, '心智自己（或整理）可以改');
  assert.equal(e.statsOf('dodge-zombie')!.fail, 1, '改写不清零');
  assert.deepEqual(e.currentStats('dodge-zombie'), { ok: 0, fail: 0 }, '新版本从零记');
  assert.deepEqual(e.statsOf('dodge-zombie')!.byVersion!['1'], { ok: 0, fail: 1 }, '旧版本的成败留着');
  rec(true); rec(true); rec(false);
  assert.equal(e.rewriteGate('dodge-zombie'), null, '用够三次了，可以改');
  // 当前版本大多失败才停用（看这一版，不看历史）
  for (let i = 0; i < 6; i++) rec(false);
  assert.equal(e.statsOf('dodge-zombie')!.disabled, true);
});

test('自动技能管没管用：触发它的情况解除了才算（饿了的还饿就不算），死了、掉一大截血也不算', () => {
  const { adapter, engine: e } = engine();
  assert.ok(e.write({ name: 'eat-something', description: '饿了就找东西吃', when: { food_below: 10, not_doing: ['eat'] }, steps: [{ skill: 'eat' }] }).ok);
  assert.deepEqual(situationOf({ food_below: 10, not_doing: ['eat'] }), { food_below: 10 }, '判断时去掉“正在做什么”');
  const judge = (food: number) => { adapter.food = food; (e as any).aftermath.set('eat-something', { hp: 20, at: Date.now() - 13_000, context: '' }); (e as any).judge('eat-something', false); };
  judge(5);
  assert.equal(e.statsOf('eat-something')!.fail, 1);
  assert.match(e.statsOf('eat-something')!.lastError!, /情况还在/);
  judge(18);
  assert.equal(e.statsOf('eat-something')!.ok, 1);
});

test('只有眼下的危险能打断心智手上的事；饿了、天黑这类等手上的事做完再接手（先告诉心智一声）', async (t) => {
  assert.equal(isThreat({ hostile: { within: 6 } }), true);
  assert.equal(isThreat({ food_below: 8 }), false);
  assert.equal(isThreat({ night: true, not: { hostile: { within: 8 } } }), false, '“没有怪的时候”不是危险');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const e = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  t.after(() => { e.dispose(); arbiter.cancel('end'); memory.close(); });
  const events: any[] = [];
  bus.on('event', (ev: any) => events.push(ev));
  assert.ok(e.write({ name: 'eat-when-hungry', description: '饿了就吃点东西', when: { food_below: 10 }, steps: [{ skill: 'wait', args: { seconds: 1 } }], cooldown_s: 0 }).ok);
  assert.ok(e.write({ name: 'low-hp-retreat', description: '血少就先退开', when: { hp_below: 8 }, steps: [{ skill: 'wait', args: { seconds: 1 } }], cooldown_s: 0 }).ok);
  adapter.food = 4;
  arbiter.start({ skill: 'wait', args: { seconds: 5 } }, 'llm');
  assert.equal(e.tick(arbiter.info()), false, '心智手上有事：饿了不打断');
  assert.ok(events.some((x) => x.type === 'skill_waiting' && x.data.name === 'eat-when-hungry'));
  adapter.hp = 5;
  assert.equal(e.tick(arbiter.info()), true, '血少是危险：可以打断');
  assert.equal((arbiter.info()?.args as any)?.name, 'low-hp-retreat');
  await flush();
});

test('拉锯里输掉的一方降成只提醒、不接手，直到被改写', () => {
  const { engine: e } = engine();
  for (const n of ['hide-in-hole', 'go-to-surface']) assert.ok(e.write({ name: n, description: `${n} 的做法说明`, when: { hp_below: 15 }, steps: [{ skill: 'wait', args: { seconds: 1 } }] }).ok);
  (e as any).stats['hide-in-hole'] = { fired: 5, ok: 4, fail: 1, lastAt: 0 };
  for (const n of ['hide-in-hole', 'go-to-surface', 'hide-in-hole', 'go-to-surface']) (e as any).noteFire(n, null);
  assert.ok(e.statsOf('go-to-surface')!.advisory);
  assert.ok(e.write({ name: 'go-to-surface', description: '附近没有怪时回地表', when: { hp_below: 15, not: { hostile: { within: 10 } } }, steps: [{ skill: 'wait', args: { seconds: 1 } }] }, { by: 'curator' }).ok);
  assert.equal(e.statsOf('go-to-surface')!.advisory, undefined, '拆开条件改写后恢复');
});

test('一再缺的东西认得出来；施工缺的块集中在高处会说清楚；清空记忆前把这一局的日志和统计存进 archives', () => {
  assert.deepEqual(shortageOf('eat', 'NO_FOOD', 'x'), [{ what: '食物', how: 'eat NO_FOOD' }]);
  assert.deepEqual(shortageOf('forage', 'NOT_FOUND', 'x'), [{ what: '食物', how: 'forage NOT_FOUND' }]);
  assert.deepEqual(shortageOf('build', 'MISSING_MATERIALS', '缺少 glass_pane×2，torch×1（折算成原材料：sand×6）').map((x) => x.what), ['glass_pane', 'torch']);
  assert.deepEqual(shortageOf('craft', 'MISSING_MATERIALS', '无法合成 white_bed：MISSING_MATERIALS（white_wool 还差 3（有 0））').map((x) => x.what), ['white_wool']);
  const missing = (y: number) => ({ cellId: 'c', pos: { x: 1, y, z: 1 }, kind: 'missing', expected: 'spruce_planks', actual: 'air' });
  const text = describeBuildProblems({ inspection: { at: 0, complete: false, checked: 10, defects: [missing(67), ...Array.from({ length: 6 }, () => missing(71))], functions: {} } } as any);
  assert.match(text, /6 块在最高的 y=70~71（比最低的缺口高 4 格；施工时人站在地上、不搭柱子）：\(1,71,1\) spruce_planks/);
  assert.match(text, /自己用 place_at 放/);
  assert.doesNotMatch(text, /垫脚|搭几级台阶/, '只说事实和能用的动作，不替它定怎么上去');
  const data = tmp(), project = tmp();
  fs.mkdirSync(path.join(data, 'logs'));
  fs.writeFileSync(path.join(data, 'logs', 'events-1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(data, 'scorecard.json'), '{}');
  fs.writeFileSync(path.join(data, 'mind.json'), '{}');
  const to = archiveForReview(data, project)!;
  assert.ok(fs.existsSync(path.join(to, 'logs', 'events-1.jsonl')));
  assert.ok(fs.existsSync(path.join(to, 'scorecard.json')));
  assert.ok(!fs.existsSync(path.join(to, 'mind.json')), '只存复盘用的，不存记忆本身');
  assert.match(path.basename(to), /^run-before-clear-\d{8}-\d{6}$/);
});

test('吃东西：结果里说清吃了什么、每块值多少（生的顺带说烤熟后值多少）；背包里的食物也标上价值', async () => {
  const { foodNote } = await import('../src/skills/food.ts');
  assert.equal(foodNote('beef'), '+3 饥饿、饱和 1.8；烤熟成 cooked_beef 是 +8、饱和 12.8');
  assert.equal(foodNote('cobblestone'), null);
  const { SKILLS } = await import('../src/skills/index.ts');
  const adapter = new FakeAdapter();
  adapter.food = 8;
  adapter.inv.set('bread', 2);
  const memory = new WorldMemory(null);
  const r = await SKILLS.eat.run({ adapter, senses: noSenses as any, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 10_000, taskId: 't', progress() {} } as any, {});
  memory.close();
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /bread×1（\+5 饥饿、饱和 6）/);
});

test('箱子：先返回候选，Agent 明确选定后才翻找，并留下所见与缺物印象', async () => {
  const { SKILLS } = await import('../src/skills/index.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const chestPos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'chest', pos: chestPos });
  adapter.chests.set('3,64,0', new Map([['bread', 5], ['cobblestone', 20]]));
  const ctx = makeCtx(adapter, { memory, senses: {
    knownBlocks: (names: string[]) => names.includes('chest') ? [{ name: 'chest', pos: chestPos, dist: 3 }] : [],
    observeBlocks: (positions) => positions.map((pos) => ({ name: adapter.blockAt(pos) ?? 'air', properties: {}, pos,
      worldId: adapter.worldId, dimension: adapter.dim, sessionId: adapter.sessionId, observationId: 1, observedAt: Date.now(), source: 'vision' })),
  } });
  const candidates = await SKILLS.take_items.run(ctx, { item: 'apple', count: 4 });
  assert.equal(candidates.failureCode, 'BAD_ARGS');
  assert.deepEqual((candidates.data?.candidates as { target: unknown }[]).map((candidate) => candidate.target), [chestPos]);
  assert.equal(memory.chests().length, 0, '只列线索没有打开箱子或抄下内容');
  assert.equal(adapter.inv.get('bread') ?? 0, 0);
  const miss = await SKILLS.take_items.run(ctx, { item: 'apple', count: 4, target: chestPos });
  assert.equal(miss.failureCode, 'NOT_FOUND');
  assert.match(miss.summary, /未改选其他容器/);
  assert.equal(memory.chests()[0].traces.find((t) => t.item === 'bread')?.kind, 'glimpsed', '留下了印象');
  assert.equal(memory.chests()[0].traces.find((t) => t.item === 'apple')?.kind, 'absent', '也记得这里没有 apple');
  const got = await SKILLS.take_items.run(ctx, { item: 'bread', count: 3, target: chestPos });
  assert.equal(got.status, 'succeeded', got.summary);
  assert.equal(adapter.inv.get('bread'), 3);
  memory.close();
});

test('掉落物：看见地上新出现的东西会注意到（捡不捡自己定）；技能条件也能用 drops', async () => {
  const { Attention } = await import('../src/mind/attention.ts');
  const { evalPredicate, validatePredicate } = await import('../src/mind/predicate.ts');
  const att = new Attention();
  const percept = (drops: any[]) => ({ time: { phase: 'day' }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 10, nearby: { hostile: [], resources: [] }, light: null, vision: { visible_drops: drops } }) as any;
  att.fromPercept(percept([]));
  const n = att.fromPercept(percept([{ item: 'beef', count: 2, dist: 3, dir: 'N' }]));
  assert.ok(n.some((x) => /地上有掉落物：beef×2/.test(x.what)));
  const p = validatePredicate({ drops: { within: 6, item: ['beef', '*_log'] } });
  assert.ok(!('error' in p));
  const sense = (drops: any[]) => ({ state: { dim: 'overworld' }, drops } as any);
  assert.equal(evalPredicate(p as any, sense([{ item: 'oak_log', dist: 4 }])), true);
  assert.equal(evalPredicate(p as any, sense([{ item: 'dirt', dist: 2 }])), false);
});
