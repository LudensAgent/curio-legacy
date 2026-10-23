import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { computeDrives } from '../src/brain/drives.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception, type Percept } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { ruleProposal } from '../src/planner/plan.ts';
import { SKILLS } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';
import { FakeAdapter } from './fake-adapter.ts';

const P = (over: Partial<Percept> = {}): Percept => ({
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [{ name: 'stone_pickaxe', count: 1 }], emptySlots: 30,
  nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 160, view: 'grass 60%', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: 10 },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, efficiency: [],
  exploration: { visitedChunks: 3, noveltyByDir: { N: 0.5, NE: 0.5, E: 1, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 }, base: null },
  ...over,
});
const plan = (p: Percept, m = new WorldMemory(null)) => ruleProposal(p, m) as any;

test('欲望：饿了、背包没吃的、看见牛 → 去打猎', () => {
  const p = P();
  p.self.food = 8;
  p.vision!.seen_entities = [{ name: 'cow', dist: 12, dir: 'E', rel: '正前' }];
  const r = plan(p);
  assert.equal(r.steps[0].skill, 'hunt');
  assert.equal(r.steps[0].args.animal, 'cow');
});

test('欲望：死亡掉落物还在 → 最优先回去捡', () => {
  const p = P();
  p.self.food = 8;
  p.death_recovery = { dir: 'NW', dist: 40, lost: 'stone_pickaxe×1、oak_log×12', seconds_left: 200 };
  const r = plan(p);
  assert.equal(r.goal, '回去捡回掉落物');
  assert.deepEqual(r.steps.map((s: any) => s.skill), ['goto', 'pickup_items']);
  assert.equal(r.steps[0].args.target, 'death');
});

test('欲望：夜里没床没房子、身上有方块 → 挖坑过夜；有床 → 睡觉', () => {
  const p = P({ time: { timeOfDay: 15000, phase: 'night' } });
  p.inventory.push({ name: 'dirt', count: 10 });
  assert.equal(plan(p).steps[0].skill, 'shelter');
  p.inventory.push({ name: 'white_bed', count: 1 });
  assert.equal(plan(p).steps[0].skill, 'sleep');
});

test('欲望：石器之后、材料够 → 盖小屋；不够 → 先备料', () => {
  const p = P();
  p.inventory.push({ name: 'oak_planks', count: 80 });
  p.nearby.resources = [{ block: 'oak_log', count: 20, nearest: 10, dir: 'E', seen: 'now' }];
  assert.equal(plan(p).steps.at(-1).skill, 'build');
  const q = P();
  q.nearby.resources = [{ block: 'oak_log', count: 20, nearest: 10, dir: 'E', seen: 'now' }];
  q.inventory.push({ name: 'oak_log', count: 2 });
  const r = plan(q);
  assert.equal(r.goal, '为小屋备料');
  assert.ok(r.steps[0].args.count >= 16, '一次多砍一些');
});

test('无聊：连续多次采集后，欲望会转向建造/探索等别的事', () => {
  const m = new WorldMemory(null);
  for (let i = 0; i < 4; i++) m.recordGoal({ goal: '砍木头', goalType: 'gather', source: 'llm', status: 'succeeded', summary: '' });
  const { drives } = computeDrives(P(), m);
  assert.ok(drives.some((d) => d.drive === 'automate' && d.why.includes('无聊')));
  const top = drives[0].drive;
  assert.ok(['home', 'explore', 'curiosity', 'automate', 'bed'].includes(top), `最强欲望不应再是采集类，实际 ${top}`);
});

test('死亡追踪：感知里出现 death_recovery，回到原地且没有掉落物后清除', () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const vision = new Vision(adapter);
  const perception = new Perception(adapter, memory, new EventBus(), vision);
  memory.setWorld(adapter.worldId);
  memory.setDeath({ ts: Date.now(), dim: 'overworld', pos: { x: 30, y: 64, z: 0 }, lost: [{ name: 'oak_log', count: 5 }] });
  const p = perception.update();
  assert.equal(p.death_recovery?.dir, 'E');
  assert.equal(p.death_recovery?.dist, 30);
  assert.equal(p.drives[0].drive, 'recover');
  adapter.pos = { x: 30, y: 64, z: 1 };
  assert.equal(perception.update().death_recovery, null);
  assert.equal(memory.lastDeath(), null);
});

const runSkill = async (adapter: FakeAdapter, skill: string, args: unknown, memory = new WorldMemory(null)) => {
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, new EventBus(), vision);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill, args }, 'llm');
  return { o: await done, memory, vision };
};

test('shelter：往下挖三格，在地表封顶并留下两格头部空间', async () => {
  const a = new FakeAdapter();
  a.inv.set('dirt', 3);
  const { o } = await runSkill(a, 'shelter', { until: 'day' });
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(Math.floor(a.pos.y), 61, '应该在坑底');
  assert.equal(a.nameAt(0, 63, 0), 'dirt', '封顶应与邻接地表同高');
  assert.equal(a.nameAt(0, 62, 0), 'air', '头部应有空气');
  assert.equal(a.nameAt(0, 61, 0), 'air', '脚部应有空气');
});

test('build：材料不够时报出需要多少；够了就建成并设为基地', async () => {
  const a = new FakeAdapter();
  a.inv.set('oak_planks', 10);
  let r = await runSkill(a, 'build', { blueprint: 'hut' });
  assert.equal(r.o.result.failureCode, 'MISSING_MATERIALS');
  assert.match(r.o.result.summary, /缺少/);
  assert.deepEqual(Object.keys(r.o.result.data!.missingMaterials as object).sort(), ['cobblestone', 'glass', 'oak_door']);
  assert.ok(r.o.result.data?.projectId, '材料不足也保留可续建的工程档案');
  a.speed = 100000;
  a.inv.set('cobblestone', 180);
  a.inv.set('glass', 3);
  a.inv.set('oak_door', 1);
  r = await runSkill(a, 'build', { blueprint: 'hut' });
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.ok(r.memory.landmarks().some((l) => l.label === '我的hut_5x5'));
  assert.ok(r.memory.base());
});

test('pickup_items：捡起看得见的掉落物', async () => {
  const a = new FakeAdapter();
  a.entities.push({ id: 7, name: 'item', kind: 'item', pos: { x: 6, y: 64, z: 0 }, dist: 0, height: 0.25 });
  a.entities.push({ id: 8, name: 'item', kind: 'item', pos: { x: 9, y: 64, z: 1 }, dist: 0, height: 0.25 });
  const { o } = await runSkill(a, 'pickup_items', { radius: 16 });
  assert.equal(o.result.status, 'succeeded');
  assert.equal(a.entities.filter((e) => e.kind === 'item').length, 0);
});

test('hunt：追上看得见的牛并攻击', async () => {
  const a = new FakeAdapter();
  a.entities.push({ id: 9, name: 'cow', kind: 'passive', pos: { x: 10, y: 64, z: 0 }, dist: 0, height: 1.4 });
  const { o } = await runSkill(a, 'hunt', { animal: 'cow', count: 1 });
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.ok(a.actions.includes('attack:9'));
});

test('技能库：学会组合技能、可执行、拒绝非法定义、低成功率自动淘汰', async () => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  const lib = new SkillLibrary(null, a, memory, new EventBus());
  assert.equal(lib.learn({ name: 'Bad Name', steps: [] }).ok, false);
  assert.equal(lib.learn({ name: 'loop_me', steps: [{ skill: 'unstuck' }, { skill: 'wander' }] }).ok, false);
  const r = lib.learn({ name: 'scan_and_wander', description: '环顾后走走', steps: [{ skill: 'look_around', args: { seconds: 2 } }, { skill: 'wander', args: { radius: 4 } }] });
  assert.ok(r.ok);
  assert.ok(SKILLS['macro:scan_and_wander']);
  const { o } = await runSkill(a, 'macro:scan_and_wander', {}, memory);
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  for (let i = 0; i < 3; i++) memory.recordSkill('macro:scan_and_wander', 'failed', 'ERROR');
  lib.prune();
  assert.equal(SKILLS['macro:scan_and_wander'], undefined, '成功率低应被淘汰');
});

test('偷懒：空手砍了很多木头且很慢 → 效率洞察建议做斧头，规则目标会先做斧头', () => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  for (let i = 0; i < 6; i++) memory.recordDig('oak_log', null, 3000);
  const perception = new Perception(a, memory, new EventBus(), new Vision(a));
  a.inv.set('stone_pickaxe', 1);
  a.inv.set('oak_planks', 8);
  const p = perception.update();
  assert.equal(p.efficiency[0].block, 'oak_log');
  assert.equal(p.efficiency[0].better[0].tool, 'wooden_axe');
  assert.equal(p.efficiency[0].better[0].speedup, 2);
  const eff = p.drives.find((d) => d.drive === 'efficiency');
  assert.ok(eff && eff.suggest.includes('wooden_axe'));
  const r = ruleProposal({ ...p, drives: [eff!] }, memory) as any;
  assert.deepEqual(r.steps[0], { skill: 'craft', args: { item: 'wooden_axe', count: 1 } });
  assert.match(r.thought, /快 2 倍/);
});
