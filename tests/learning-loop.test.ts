import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Scorecard } from '../src/observer/scorecard.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-learn-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

test('造技能：死了之后在后台拿事发经过写出技能、立刻生效；不限次数，同一时间只写一份，其余排队', async (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const seen: any[] = [];
  let n = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async (messages: any[]) => {
    seen.push(messages);
    n++;
    return { text: JSON.stringify({ skill: { name: `pillar-when-chased-${n}`, description: '血少被僵尸追时原地垫高', when: { hp_below: 8, hostile: { name: 'zombie', within: 6 }, hurt_within: 4 },
      code: 'const s = await api.state();\nawait api.placeAt(s.feet.x, s.feet.y, s.feet.z, "any");\nreturn { up: 1 };', verify: 'const s = await api.state(); return s.feet.y > args.before.feet.y ? true : "没垫高";' } }), latencyMs: 5 };
  } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state());
  smith.start(1_000_000);
  t.after(() => smith.stop());
  bus.publish('hurt', 'P2', '受到伤害，生命 4');
  bus.publish('task_start', 'P2', '[reflex] flee {"distance":24}');
  smith.report('death', Date.now(), 'Curio was slain by Zombie', 60_000);
  smith.report('noted', Date.now() + 120_000, '老是被坑困住', 60_000, '老是被坑困住，不会垫高');
  await flush();
  assert.equal(seen.length, 2, '两件事都写了：一件写完接着写下一件');
  assert.match(seen[0][0].content, /身体技能工程师/);
  assert.match(seen[0][0].content, /api\.region/, '带着代码 api 的说明');
  assert.match(seen[0][1].content, /slain by Zombie/);
  assert.match(seen[0][1].content, /受到伤害/, '带着事发经过');
  assert.match(seen[1][1].content, /不会垫高/, '心智自己的说明也带上');
  assert.equal(engine.get('pillar-when-chased-1')?.mode, 'auto', '写下就生效');
});

test('值得学的时机不写死：吃亏程度跟着它自己的平时水平走；回顾这段时间的经历；模型觉得不是技能能解决的就不写', async (t) => {
  const { PainMeter } = await import('../src/codeskills/smith.ts');
  const meter = new PainMeter(60_000);
  let now = 0;
  // 平时：每分钟掉一点血、偶尔失败
  for (let i = 0; i < 30; i++) { now += 30_000; meter.add(1 + (i % 3) * 0.5, '掉血', now); assert.equal(meter.sample(now), false, `平常的小亏不算（第 ${i} 次）`); }
  now += 30_000; meter.add(25, '死亡', now); meter.add(6, '卡住：挖石头', now);
  assert.equal(meter.sample(now), true, '明显比平时痛');
  assert.match(meter.describe(), /死亡/);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => { asked.push(m[0].content + m[1].content); return { text: '{"none":true,"why":"缺的是材料"}', latencyMs: 5 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), () => ['找石头 → stuck（240s）：视野里没有 stone', '找石头 → done（300s）']);
  smith.start(1_000_000);
  t.after(() => smith.stop());
  (smith as any).lastReview = 0;
  bus.publish('reflect_start', 'P3', '回想一下这段时间');
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /反复出现、费时间、常失败/);
  assert.match(asked[0], /找石头/);
  assert.match(smith.history.at(-1)!.result, /不写/);
  assert.equal(engine.list().length, 0);
});

test('学习曲线：里程碑只增不减；每条命单独记到达里程碑的用时；生存分按活了多久走 S 形曲线', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const learn = { skills: [{ ok: 3, fail: 1 }, { ok: 0, fail: 3 }], knowHow: [{ wins: 2, losses: 0 }], housesComplete: 0 };
  const card = new Scorecard(bus, () => adapter.state(), path.join(tmp(), 'score.json'), () => learn);
  card.start(1_000_000);
  t.after(() => card.stop());
  bus.publish('spawn', 'P3', '出生');
  now += 60_000; adapter.inv.set('oak_log', 4); card.sample(now);
  now += 60_000; bus.publish('task_end', 'P2', '[llm] craft → succeeded', { source: 'llm', status: 'succeeded', skill: 'craft', summary: '合成了 1 个 crafting_table' });
  now += 120_000; adapter.inv.set('stone_pickaxe', 1); card.sample(now);
  const s1 = card.summary(now);
  assert.ok(s1.milestones.find((m) => m.key === 'crafting_table')?.at, '合成后马上放下的工作台也算');
  assert.equal(s1.lives[0].reached.stone_pickaxe, 4, '第一条命 4 分钟拿到石镐');
  assert.ok(s1.now.survival < 15, `才活了 4 分钟，生存分很低：${s1.now.survival}`);
  bus.publish('death', 'P0', '死了', { message: 'Curio was slain by Zombie' });
  adapter.inv.clear();
  now += 10_000; bus.publish('spawn', 'P3', '复活');
  now += 120_000; adapter.inv.set('stone_pickaxe', 1); card.sample(now);
  const s2 = card.summary(now);
  assert.equal(s2.lives.length, 2);
  assert.equal(s2.lives[1].reached.stone_pickaxe, 2, '第二条命 2 分钟就拿到石镐：学会了');
  assert.equal(s2.lives[0].cause, 'Curio was slain by Zombie');
  assert.ok(s2.now.survival < 15, `刚死过一次、上一条命只活了 4 分钟：${s2.now.survival}`);
  const { lifeCurve } = await import('../src/observer/scorecard.ts');
  assert.ok(Math.abs(lifeCurve(20) - 0.5) < 1e-9, '活过一个游戏日正好一半');
  assert.ok(lifeCurve(5) < 0.1 && lifeCurve(40) > 0.95, 'S 形：前期很少、后期接近满分');
  assert.ok(s2.now.learning > 0 && s2.now.progress > 0);
  assert.ok(s2.curve.length >= 3);
});

test('整理技能：长期用不上的收起；说同一件事的后台合并；同时满足条件时成功率高的先上', async (t) => {
  const { SkillCurator } = await import('../src/codeskills/curator.ts');
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const mk = (name: string, priority = 50) => engine.write({ name, description: `${name} 的做法`, when: { hp_below: 8, hostile: { within: 8 } }, code: 'return 1;', verify: 'return true;', priority });
  for (const n of ['run-away', 'flee-from-mobs', 'pillar-up']) assert.ok(mk(n).ok);
  // 实际成功过的可用稳定应急版不按闲置收；未验证的应急候选没有这种保护。
  assert.ok(engine.write({ name: 'never-used', description: '饿了先吃背包里的面包', when: { food_below: 8 }, code: 'return 1;' }).ok);
  // 成功率影响选择：同优先级下成功多的分更高
  (engine as any).stats['run-away'] = { fired: 6, ok: 5, fail: 1, lastAt: Date.now(), byVersion: { '1': { ok: 5, fail: 1 } } };
  (engine as any).stats['flee-from-mobs'] = { fired: 6, ok: 1, fail: 5, lastAt: Date.now(), byVersion: { '1': { ok: 1, fail: 5 } } };
  assert.ok(engine.choiceScore(engine.get('run-away')!) > engine.choiceScore(engine.get('flee-from-mobs')!));
  let asked = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => { asked++; return { text: JSON.stringify({
    merge: [{ from: ['run-away', 'flee-from-mobs'], skill: { name: 'run-away', description: '血少有怪时背对怪跑开', when: { hp_below: 8, hostile: { within: 8 } }, code: 'return 2;', verify: 'return true;' } }],
    priority: [{ name: 'pillar-up', priority: 70 }] }), latencyMs: 5 }; } };
  const curator = new SkillCurator(planner as any, engine, book, bus, { unusedDays: 1, gapMs: 0, minSkills: 2 });
  // 通过实际观测刻数推进一个游戏日。
  const now = Date.now() + 5000;
  (engine as any).stats['pillar-up'] = { fired: 1, ok: 1, fail: 0, lastAt: now, byVersion: { '1': { ok: 1, fail: 0 } } };
  (engine as any).stats['run-away'].lastAt = now; (engine as any).stats['flee-from-mobs'].lastAt = now;
  curator.observe({ ...adapter.state(), worldAgeTicks: 0 }, false, 0);
  curator.observe({ ...adapter.state(), worldAgeTicks: 24_000 }, false, 1000);
  const r = await curator.check(now);
  assert.equal(engine.statsOf('never-used')?.retired?.includes('没用上'), true);
  assert.equal(asked, 1);
  assert.match(r!, /run-away/);
  assert.match(engine.statsOf('flee-from-mobs')!.retired!, /当前版本用了/);
  assert.equal(engine.get('pillar-up', true)?.priority, 70, '优先级修改先保存候选，不直接替换稳定版');
  assert.ok(engine.overview().some((l) => l.includes('flee-from-mobs') && l.includes('已收起')));
  // 没有新技能、也没有冲突：不再请模型
  await curator.check(now + 1);
  assert.equal(asked, 1);
});

test('里程碑沿原版成就：游戏播报的成就直接记上，表外的成就也算一点进度；进下界按维度认', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const card = new Scorecard(bus, () => adapter.state(), null, () => ({ skills: [], knowHow: [], housesComplete: 0 }));
  card.start(1_000_000);
  t.after(() => card.stop());
  const before = card.summary(now).now.progress;
  bus.publish('game_message', 'P1', 'Curio has made the advancement [Stone Age]', { kind: 'advancement_self' });
  bus.publish('game_message', 'P1', 'Curio has made the advancement [Bullseye]', { kind: 'advancement_self' });
  adapter.dim = 'the_nether'; card.sample(now);
  const s = card.summary(now);
  assert.ok(s.milestones.find((m) => m.key === 'cobblestone')?.at, '石器时代 → 圆石');
  assert.ok(s.milestones.find((m) => m.key === 'nether')?.at);
  assert.deepEqual(s.advancements.map((a) => a.title), ['Stone Age', 'Bullseye']);
  assert.ok(s.now.progress > before);
  assert.ok(s.milestones.length >= 35, `${s.milestones.length} 个里程碑`);
});

test('专注：点子和疑问不能当主目标；抄回来的清单格式会被清掉；原样重写清单不算推进', async () => {
  const { SelfModel, cleanPlanStep } = await import('../src/mind/self.ts');
  const self = new SelfModel(null);
  const idea = self.addAgenda('甘蔗能造纸，回头记下这片甘蔗的位置', 'idea', 'someday')!;
  assert.equal(self.setPlan(idea.id, ['去甘蔗那记坐标']), null, '点子不能当主目标');
  assert.equal(cleanPlanStep('0. [ ] 0. [x] 吃东西保命'), '吃东西保命');
  const plan = self.setPlan('盖一间小屋', ['0. [ ] 砍木头', '1. [ ] 做木板'])!;
  assert.deepEqual(plan.steps.map((s) => s.text), ['砍木头', '做木板']);
  const at = plan.progressAt;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(self.setPlan(plan.agendaId, ['砍木头', '做木板'])!.progressAt, at, '原样重写不算推进');
  self.checkPlan([0]);
  assert.ok(self.plan()!.progressAt! > at!);
});

test('老毛病：同一个动作因为同一种原因一再失败（吃亏程度看不出来，因为天天如此），攒到几次就拿着归好类的原因去学', async (t) => {
  const { reasonOf, RECURRING } = await import('../src/codeskills/smith.ts');
  assert.deepEqual(reasonOf('[llm] step → failed(PATH_NOT_FOUND)：迈不到 [1,1,0]：目标格是 stone；目标格上方是 dirt（会碰头）'), ['目标格是 stone', '目标格上方是 dirt（会碰头）']);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => { asked.push(m[0].content + '\n' + m[1].content); return { text: JSON.stringify({ skill: { name: 'pad-then-step', description: '迈不过去因为脚下踩不住时先垫一块', when: { after_failure: { skill: 'step', code: 'PATH_NOT_FOUND' } }, steps: [{ skill: 'place_at', args: { at: [1, 0, 0] } }] } }), latencyMs: 5 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state());
  smith.start(1_000_000);
  t.after(() => smith.stop());
  const fail = (why: string) => bus.publish('task_end', 'P1', `[llm] step → failed(PATH_NOT_FOUND)：迈不到 [1,1,0]：${why}`, { status: 'failed', skill: 'step', failureCode: 'PATH_NOT_FOUND', source: 'llm' });
  fail('目标格脚下是 空气，往下 3 格内也没有落脚处（踩不住）');
  bus.publish('task_end', 'P1', '[llm] craft → failed(MISSING_MATERIALS)：缺木板', { status: 'failed', skill: 'craft', failureCode: 'MISSING_MATERIALS', source: 'llm' });
  fail('目标格脚下是 空气，往下 3 格内也没有落脚处（踩不住）');
  await flush();
  assert.equal(asked.length, 0, `${RECURRING.times} 次以前不算老毛病；别的动作的失败不掺进来`);
  fail('目标格上方是 stone（会碰头）');
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /一再因为同一种原因失败/);
  assert.match(asked[0], /踩不住.*（2 次）/, '原因归好类、带次数');
  assert.match(asked[0], /会碰头/);
  assert.equal(engine.get('pad-then-step')?.mode, 'recover');
  // 刚学过：同样的错马上又来几次，先看新技能管不管用，不连着再学
  fail('踩不住'); fail('踩不住'); fail('踩不住');
  await flush();
  assert.equal(asked.length, 1);
});

test('一再重复的同一串动作：心智一步步指挥做了好几遍，就去练成一个技能（看一看、等一等不算）', async (t) => {
  const { findRepeat } = await import('../src/codeskills/smith.ts');
  const stair = ['dig_at {"at":[1,1,0]}', 'dig_at {"at":[1,2,0]}', 'step {"at":[1,1,0]}'];
  assert.deepEqual(findRepeat([...stair, ...stair, 'look_around {}', ...stair])?.times, 3);
  assert.equal(findRepeat([...stair, ...stair]), null, '两遍还不算');
  assert.equal(findRepeat(['glance {}', 'wait {}', 'glance {}', 'wait {}', 'glance {}', 'wait {}']), null);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => { asked.push(m[0].content + '\n' + m[1].content); return { text: '{"none":true,"why":"测试"}', latencyMs: 5 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state());
  smith.start(1_000_000);
  t.after(() => smith.stop());
  const act = (skill: string, args: object, facing = 'E') => bus.publish('task_start', 'P2', `[llm] ${skill}`, { skill, args: { ...args, facing }, source: 'llm' });
  for (let i = 0; i < 3; i++) { act('dig_at', { at: [1, 1, 0] }, i % 2 ? 'N' : 'E'); act('dig_at', { at: [1, 2, 0] }); act('step', { at: [1, 1, 0] }); }
  // 身体自己（反射）做的不算心智指挥
  bus.publish('task_start', 'P2', '[reflex] place_at', { skill: 'place_at', args: {}, source: 'reflex' });
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /同一串动作重复了好几遍/);
  assert.match(asked[0], /dig_at.*dig_at.*step.*3 遍/);
});

test('来回拉锯：两个技能交替接手就先让不那么管用的歇一会儿；一个技能一再打断手上同一件事就告诉心智和整理的', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const { Arbiter } = await import('../src/arbiter/arbiter.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, vision);
  t.after(() => { engine.dispose(); arbiter.cancel('end'); memory.close(); });
  const loops: any[] = [];
  bus.on('event', (e: any) => { if (e.type === 'skill_loop') loops.push(e.data); });
  assert.ok(engine.write({ name: 'hide-from-spider', description: '被蜘蛛盯上时躲进洞里', when: { hp_below: 15 }, code: 'return 1;', priority: 50, cooldown_s: 0 }).ok);
  assert.ok(engine.write({ name: 'back-to-surface', description: '在地下时回到地表上去', when: { hp_below: 15 }, code: 'return 1;', priority: 50, cooldown_s: 0 }).ok);
  (engine as any).stats['hide-from-spider'] = { fired: 5, ok: 4, fail: 1, lastAt: 0 };
  const fire = (name: string, doing: string | null = null) => (engine as any).noteFire(name, doing);
  fire('hide-from-spider'); fire('back-to-surface'); fire('hide-from-spider'); fire('back-to-surface');
  assert.equal(loops.length, 1);
  assert.equal(loops[0].kind, 'pingpong');
  assert.equal(loops[0].held, 'back-to-surface', '成功率低的那个先歇');
  assert.deepEqual(engine.heldNow(), ['back-to-surface']);
  assert.ok(engine.statsOf('back-to-surface')!.loops![0].with === 'hide-from-spider');
  adapter.hp = 10;
  arbiter.start({ skill: 'wait', args: { seconds: 1 } }, 'llm');
  // 歇着的那个条件成立也不接手
  (engine as any).lastFired.clear();
  engine.tick(arbiter.info());
  assert.notEqual((arbiter.info()?.args as any)?.name, 'back-to-surface');
  fire('hide-from-spider', 'goto'); fire('hide-from-spider', 'goto'); fire('hide-from-spider', 'goto');
  assert.equal(loops.at(-1).kind, 'tug');
  assert.match(engine.statsOf('hide-from-spider')!.loops!.at(-1)!.with, /doing:goto/);
});
