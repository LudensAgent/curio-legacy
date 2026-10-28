import { storeItems } from '../src/skills/economy.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { habitName, learnCandidates, signatureOf } from '../src/brain/habits.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { ruleProposal } from '../src/planner/plan.ts';
import { pickVariant, resolveItemAlias } from '../src/skills/work.ts';
import { FakeAdapter } from './fake-adapter.ts';

const runSkill = async (adapter: FakeAdapter, skill: string, args: unknown, memory = new WorldMemory(null)) => {
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, new EventBus(), vision);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill, args }, 'llm');
  return { o: await done, memory, vision };
};

const P = (over: Partial<Percept> = {}): Percept => ({
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [{ name: 'stone_pickaxe', count: 1 }], emptySlots: 30,
  nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 160, view: 'grass 60%', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: 10 },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, efficiency: [], light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  exploration: { visitedChunks: 3, noveltyByDir: { N: 0.5, NE: 0.5, E: 1, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 }, base: null },
  ...over,
});

test('记忆迁移：旧版本穿墙得来的矿物地标被清掉，自己的家/箱子/路标保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const file = path.join(dir, 'world-memory.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    seen: { blocks: { iron_ore: 1 }, entities: {}, biomes: {} },
    landmarks: [
      { id: 'base', kind: 'base', label: '基地', dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, ts: 1 },
      { id: 'res_1', kind: 'resource', label: 'iron_ore', dim: 'overworld', pos: { x: -7, y: 44, z: 87 }, ts: 1 },
      { id: 'dis_1', kind: 'discovery', label: 'spawner', dim: 'overworld', pos: { x: 5, y: 20, z: 5 }, ts: 1 },
      { id: 'dis_2', kind: 'discovery', label: '我的箱子', dim: 'overworld', pos: { x: 2, y: 64, z: 0 }, ts: 1 },
      { id: 'way_1', kind: 'waypoint', label: '路标 E-1', dim: 'overworld', pos: { x: 64, y: 70, z: 0 }, ts: 1 },
    ],
  }));
  const m = new WorldMemory(file);
  assert.equal(m.migrated, 2);
  assert.deepEqual(m.landmarks().map((l) => l.id), ['base', 'dis_2', 'way_1']);
  assert.equal(m.seenCount().blocks, 0);
  m.flush();
  assert.equal(new WorldMemory(file).migrated, 0, '迁移只做一次');
});

test('过时地标：走到资源地标跟前（5 格内）却看不到矿，gather 失败并把地标删掉', async () => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.addLandmark('resource', 'iron_ore', 'overworld', { x: 2, y: 63, z: 2 });
  const { o } = await runSkill(a, 'gather', { block: 'iron_ore', count: 2 }, memory);
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.match(o.result.summary, /过时的 iron_ore 地标/);
  assert.equal(memory.landmarks().filter((l) => l.kind === 'resource').length, 0);
});

test('远一点、埋在石头里的矿点看不见不删：留着，并在失败结果里说出在哪', async () => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.setWorld(a.state().worldId);
  memory.addLandmark('resource', 'iron_ore', 'overworld', { x: 3, y: 56, z: 2 });
  const { o } = await runSkill(a, 'gather', { block: 'iron_ore', count: 2 }, memory);
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.match(o.result.summary, /记得别处有 iron_ore：\(3,56,2\)/);
  assert.equal(memory.landmarks().filter((l) => l.kind === 'resource').length, 1);
});

test('物品泛称：bed → white_bed、planks → oak_planks；按背包材料挑颜色/木种', () => {
  const known = new Set(['white_bed', 'red_bed', 'oak_planks', 'spruce_planks', 'torch']);
  const ad = { isKnownItem: (n: string) => known.has(n) };
  assert.equal(resolveItemAlias('bed', ad), 'white_bed');
  assert.equal(resolveItemAlias('planks', ad), 'oak_planks');
  assert.equal(resolveItemAlias('torches', ad), 'torch');
  assert.equal(resolveItemAlias('nonsense', ad), null);
  assert.equal(pickVariant('white_bed', [{ name: 'red_wool', count: 3 }]), 'red_bed');
  assert.equal(pickVariant('white_bed', [{ name: 'white_wool', count: 3 }]), 'white_bed');
  assert.equal(pickVariant('oak_planks', [{ name: 'spruce_log', count: 4 }]), 'spruce_planks');
});

test('冶炼：生铁 + 煤 → 铁锭', async () => {
  const a = new FakeAdapter();
  a.inv.set('raw_iron', 3);
  a.inv.set('coal', 2);
  a.inv.set('cobblestone', 8);
  const { o } = await runSkill(a, 'smelt', { item: 'raw_iron' });
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(a.inv.get('iron_ingot'), 3);
});

test('仓储：存进箱子（工具留身上），再取出来', async () => {
  const a = new FakeAdapter();
  a.inv.set('chest', 1);
  a.inv.set('dirt', 40);
  a.inv.set('raw_copper', 9);
  const memory = new WorldMemory(null);
  let r = await runSkill(a, 'store_items', { items: ['dirt:24', 'raw_copper'], make: true }, memory);
  assert.equal(r.o.result.status, 'succeeded', JSON.stringify(r.o.result));
  assert.equal(a.inv.get('dirt'), 16, '只存点名的 24 个泥土');
  assert.equal(a.inv.get('raw_copper'), 0);
  assert.equal(a.inv.get('stone_pickaxe') ?? a.inv.get('wooden_pickaxe') ?? 1, a.inv.get('stone_pickaxe') ?? a.inv.get('wooden_pickaxe') ?? 1);
  assert.equal(memory.chests().length, 1);
  r = await runSkill(a, 'take_items', { item: 'raw_copper', count: 4 }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(a.inv.get('raw_copper'), 4);
});

test('农业：开垦并播种；成熟后收割补种', async () => {
  const a = new FakeAdapter();
  a.inv.set('wooden_hoe', 1);
  a.inv.set('wheat_seeds', 9);
  const memory = new WorldMemory(null);
  let r = await runSkill(a, 'farm', { crop: 'wheat', size: 4 }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(memory.farms().length, 1);
  const n = memory.farms()[0].cells.length;
  assert.ok(n >= 2);
  assert.equal(a.crops.size, n);
  for (const c of a.crops.values()) c.age = 7;
  r = await runSkill(a, 'farm', { crop: 'wheat' }, memory);
  assert.match(r.o.result.summary, new RegExp(`收割 ${n}`));
});

test('规则目标：背包快满 → 存箱子；有生铁和圆石 → 冶炼', () => {
  const m = new WorldMemory(null);
  const full = ruleProposal(P({ emptySlots: 1 }), m) as any;
  assert.notEqual(full?.steps?.[0]?.skill, 'store_items', '存哪些得它自己点名，规则兜底不替它挑');
  const p = P();
  p.inventory.push({ name: 'raw_iron', count: 4 }, { name: 'cobblestone', count: 20 });
  const r = ruleProposal(p, m) as any;
  assert.ok(r.steps.some((s: any) => s.skill === 'smelt' && s.args.item === 'raw_iron'), JSON.stringify(r.steps));
});

test('自学：重复 succeeded 步骤不自动变成习惯；步骤签名仍可明确生成', () => {
  const m = new WorldMemory(null);
  const plan = [{ skill: 'gather', args: { block: 'coal', count: 3 } }, { skill: 'craft', args: { item: 'torch', count: 8 } }];
  for (let i = 0; i < 3; i++) m.recordGoal({ goal: '做火把', goalType: 'craft', source: 'llm', status: 'succeeded', summary: '', steps: signatureOf(plan).split(' → '), plan });
  const c = learnCandidates(m, new Set());
  assert.deepEqual(c, [], '动作返回成功不证明目标达成，也不授权将重复步骤写成习惯');
  assert.equal(signatureOf(plan), 'gather:coal → craft:torch');
  assert.equal(habitName({ signature: signatureOf(plan), times: 3, steps: plan, goal: '做火把' }), 'gather_coal_craft_torch');
  assert.equal(learnCandidates(m, new Set([signatureOf(plan)])).length, 0, '学过的不再提示');
});

test('仓储：存什么由它点名，没点名的一样不动；结果写清箱子坐标', async () => {
  const a = new FakeAdapter();
  a.inv.set('chest', 1);
  a.inv.set('iron_ingot', 7);
  a.inv.set('cobblestone', 50);
  a.inv.set('andesite', 10);
  a.inv.set('raw_copper', 5);
  const memory = new WorldMemory(null);
  assert.equal(storeItems.validate({}, undefined as any).ok, false, '不点名就不存');
  assert.equal(storeItems.validate({ items: 'not an array!' }, undefined as any).ok, false);
  assert.deepEqual((storeItems.validate({ items: ['dirt:32', 'minecraft:*_log'] }, undefined as any) as any).args.items, [{ name: 'dirt', count: 32 }, { name: '*_log' }]);
  // 模型实际常写的对象形式（10-27 日志里连着十几次 BAD_ARGS）
  assert.deepEqual((storeItems.validate({ items: [{ name: 'granite', count: 40 }, { name: 'diorite' }, { item: 'minecraft:gravel', count: 0 }] }, undefined as any) as any).args.items,
    [{ name: 'granite', count: 40 }, { name: 'diorite' }, { name: 'gravel' }]);
  assert.deepEqual((storeItems.validate({ items: { dirt: 32, andesite: true } }, undefined as any) as any).args.items, [{ name: 'dirt', count: 32 }, { name: 'andesite' }]);
  assert.equal(storeItems.validate({ items: [{ count: 3 }] }, undefined as any).ok, false, '对象没名字不收');
  let r = await runSkill(a, 'store_items', { items: ['cobblestone', 'and*', 'gravel'], make: true }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(a.inv.get('cobblestone') ?? 0, 0, '点名的整包存');
  assert.equal(a.inv.get('andesite') ?? 0, 0, '通配');
  assert.equal(a.inv.get('raw_copper'), 5, '没点名的不动');
  assert.equal(a.inv.get('iron_ingot'), 7, '没点名的不动');
  assert.match(r.o.result.summary, /\(-?\d+,-?\d+,-?\d+\)/);
  assert.match(r.o.result.summary, /cobblestone×50/);
  assert.match(r.o.result.summary, /没有 gravel/);
});

test('仓储默认不制造或放置箱子，缺的是已放置箱子而非断言缺材料', async (t) => {
  for (const preparation of ['chest', 'oak_planks']) {
    const a = new FakeAdapter(), memory = new WorldMemory(null);
    t.after(() => memory.close());
    a.inv.set(preparation, preparation === 'chest' ? 1 : 8);
    a.inv.set('dirt', 40);
    const before = [...a.inv];
    const { o } = await runSkill(a, 'store_items', { items: ['dirt:24'] }, memory);
    assert.equal(o.result.status, 'failed');
    assert.equal(o.result.failureCode, 'MISSING_MATERIALS');
    assert.match(o.result.summary, /箱子/);
    assert.match(o.result.summary, /make:true/);
    assert.doesNotMatch(o.result.summary, /也做不了/);
    assert.deepEqual([...a.inv], before, '准备材料和待存物品都保留');
    assert.ok(!a.actions.some((action) => /^(craft|place):chest$/.test(action)));
    assert.equal(a.chests.size, 0);
    assert.equal(memory.chests().length, 0);
  }
});
