import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Scorecard } from '../src/observer/scorecard.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-learn-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

test('造技能：死了之后在后台拿事发经过写出技能、立刻生效；排队限频，不会每死一次就请一次', async (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const seen: any[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (messages: any[]) => {
    seen.push(messages);
    return { text: JSON.stringify({ skill: { name: 'pillar-when-chased', description: '血少被僵尸追时原地垫高', when: { hp_below: 8, hostile: { name: 'zombie', within: 6 }, hurt_within: 4 },
      code: 'const s = await api.state();\nawait api.placeAt(s.feet.x, s.feet.y, s.feet.z, "any");\nreturn { up: 1 };' } }), latencyMs: 5 };
  } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), { gapMs: 60_000 });
  smith.start();
  t.after(() => smith.stop());
  bus.publish('hurt', 'P2', '受到伤害，生命 4');
  bus.publish('task_start', 'P2', '[reflex] flee {"distance":24}');
  smith.report('death', Date.now(), 'Curio was slain by Zombie', 60_000);
  await flush();
  assert.equal(seen.length, 1);
  assert.match(seen[0][0].content, /身体技能工程师/);
  assert.match(seen[0][0].content, /api\.region/, '带着代码 api 的说明');
  assert.match(seen[0][1].content, /slain by Zombie/);
  assert.match(seen[0][1].content, /受到伤害/, '带着事发经过');
  assert.equal(engine.get('pillar-when-chased')?.mode, 'auto', '写下就生效');
  assert.ok(smith.history.at(-1)?.result.includes('pillar-when-chased'));
  // 一分钟内再死一次：先排着，不马上请
  smith.report('death', Date.now(), '又死了', 60_000);
  await flush();
  assert.equal(seen.length, 1, '离上次太近，排队等着');
});

test('造技能：同一段时间里卡住三次才算“反复卡住”；模型觉得不是技能能解决的就不写', async (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  let calls = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => { calls++; return { text: '{"none":true,"why":"缺的是材料"}', latencyMs: 5 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), { gapMs: 0 });
  smith.start();
  t.after(() => smith.stop());
  for (let i = 0; i < 2; i++) bus.publish('attempt_end', 'P1', `一段活「挖石头」→ stuck：路被挡住 ${i}`, { outcome: 'stuck' });
  await flush();
  assert.equal(calls, 0);
  bus.publish('attempt_end', 'P1', '一段活「挖石头」→ stuck：路被挡住', { outcome: 'stuck' });
  await flush();
  assert.equal(calls, 1);
  assert.match(smith.history.at(-1)!.result, /不写/);
  assert.equal(engine.list().length, 0);
});

test('学习曲线：里程碑只增不减；每条命单独记到达里程碑的用时；死得多生存分就低', (t) => {
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
  assert.equal(s1.now.survival, 100);
  bus.publish('death', 'P0', '死了', { message: 'Curio was slain by Zombie' });
  adapter.inv.clear();
  now += 10_000; bus.publish('spawn', 'P3', '复活');
  now += 120_000; adapter.inv.set('stone_pickaxe', 1); card.sample(now);
  const s2 = card.summary(now);
  assert.equal(s2.lives.length, 2);
  assert.equal(s2.lives[1].reached.stone_pickaxe, 2, '第二条命 2 分钟就拿到石镐：学会了');
  assert.equal(s2.lives[0].cause, 'Curio was slain by Zombie');
  assert.ok(s2.now.survival < 60, `刚死过一次：${s2.now.survival}`);
  assert.ok(s2.now.learning > 0 && s2.now.progress > 0);
  assert.ok(s2.curve.length >= 3);
});

test('整理技能：长期用不上的收起；说同一件事的后台合并；同时满足条件时成功率高的先上', async (t) => {
  const { SkillCurator } = await import('../src/codeskills/curator.ts');
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const mk = (name: string, priority = 50) => engine.write({ name, description: `${name} 的做法`, when: { hp_below: 8, hostile: { within: 8 } }, code: 'return 1;', priority });
  for (const n of ['run-away', 'flee-from-mobs', 'pillar-up', 'never-used']) assert.ok(mk(n).ok);
  // 成功率影响选择：同优先级下成功多的分更高
  (engine as any).stats['run-away'] = { fired: 6, ok: 5, fail: 1, lastAt: Date.now() };
  (engine as any).stats['flee-from-mobs'] = { fired: 6, ok: 1, fail: 5, lastAt: Date.now() };
  assert.ok(engine.choiceScore(engine.get('run-away')!) > engine.choiceScore(engine.get('flee-from-mobs')!));
  let asked = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => { asked++; return { text: JSON.stringify({
    merge: [{ from: ['run-away', 'flee-from-mobs'], skill: { name: 'run-away', description: '血少有怪时背对怪跑开', when: { hp_below: 8, hostile: { within: 8 } }, code: 'return 2;' } }],
    priority: [{ name: 'pillar-up', priority: 70 }] }), latencyMs: 5 }; } };
  const curator = new SkillCurator(planner as any, engine, book, bus, { unusedMs: 1000, gapMs: 0, minSkills: 2 });
  // never-used 写下很久都没用过：收起（这里把“很久”设成 1 秒）
  const now = Date.now() + 5000;
  (engine as any).stats['pillar-up'] = { fired: 1, ok: 1, fail: 0, lastAt: now };
  (engine as any).stats['run-away'].lastAt = now; (engine as any).stats['flee-from-mobs'].lastAt = now;
  const r = await curator.check(now);
  assert.equal(engine.statsOf('never-used')?.retired?.includes('没用上'), true);
  assert.equal(asked, 1);
  assert.match(r!, /run-away/);
  assert.match(engine.statsOf('flee-from-mobs')!.retired!, /合并进 run-away/);
  assert.equal(engine.get('pillar-up')?.priority, 70);
  assert.ok(engine.overview().some((l) => l.includes('flee-from-mobs') && l.includes('已收起')));
  // 没有新技能、也没有冲突：不再请模型
  await curator.check(now + 1);
  assert.equal(asked, 1);
});
