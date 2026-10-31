import assert from 'node:assert/strict';
import { test } from 'node:test';
import { efficiencyInsights, effortFacts } from '../src/brain/efficiency.ts';
import { computeDrives, observedNeeds } from '../src/brain/drives.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { EventBus } from '../src/events.ts';
import { FakeAdapter } from './fake-adapter.ts';

// 只实现 digTimeEstimate 的适配器存根：挖圆石，空手 7.5s、木镐 1.5s、石镐 0.75s、铁镐 0.5s、钻石镐 0.3s
const adapter = {
  digTimeEstimate: (block: string, tool: string | null) => {
    if (block !== 'cobblestone') return null;
    if (!tool) return 7500;
    if (tool === 'wooden_pickaxe') return 1500;
    if (tool === 'stone_pickaxe') return 750;
    if (tool === 'iron_pickaxe') return 500;
    if (tool === 'diamond_pickaxe') return 300;
    return null;
  },
};

const P = (over: Partial<Percept> = {}): Percept => ({
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [], emptySlots: 30,
  nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 160, view: '', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: 10 },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, efficiency: [], light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  exploration: { visitedChunks: 3, noveltyByDir: { N: 0.5, NE: 0.5, E: 1, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 }, base: null },
  ...over,
});

test('efficiencyInsights：钻石镐挖圆石，给出更省的铁镐', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  for (let i = 0; i < 6; i++) m.recordDig('cobblestone', 'diamond_pickaxe', 300);
  const ins = efficiencyInsights(adapter as any, m, [{ name: 'iron_pickaxe', count: 1 }]);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].tool, 'diamond_pickaxe');
  assert.equal(ins[0].cheaper.length, 1);
  assert.equal(ins[0].cheaper[0].tool, 'iron_pickaxe');
  assert.equal(ins[0].cheaper[0].savesItem, 'diamond');
  assert.equal(ins[0].cheaper[0].have, true);
});

test('efficiencyInsights：石镐（不稀缺）不给 cheaper，只给更快的 better', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  for (let i = 0; i < 4; i++) m.recordDig('cobblestone', 'stone_pickaxe', 750);
  const ins = efficiencyInsights(adapter as any, m, [{ name: 'stone_pickaxe', count: 1 }]);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].cheaper.length, 0, '石镐不是稀缺材料，没有 cheaper');
  assert.ok(ins[0].better.length >= 1, '石镐换铁/钻石更快，有 better');
});

test('computeDrives：钻石稀缺（≤6）且用钻石镐挖圆石时，给出抠门 drive', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  const p = P({
    inventory: [{ name: 'diamond', count: 3 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }],
    efficiency: [{ block: 'cobblestone', mined: 6, avg_s: 0.3, tool: 'diamond_pickaxe',
      better: [], cheaper: [{ tool: 'iron_pickaxe', est_s: 0.5, slowdown: 1.7, savesItem: 'diamond', savesZh: '钻石', have: true }] }],
  });
  const { drives } = computeDrives(p, m);
  const frugal = drives.find((d) => d.drive === 'frugal');
  assert.ok(frugal, '应有抠门 drive');
  assert.match(frugal!.why, /diamond_pickaxe/);
  assert.match(frugal!.why, /慢 70%/);
  assert.match(frugal!.why, /钻石/);
  assert.match(frugal!.why, /3 个/);
});

test('computeDrives：钻石充足（>6）时不给抠门 drive', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  const p = P({
    inventory: [{ name: 'diamond', count: 20 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }],
    efficiency: [{ block: 'cobblestone', mined: 6, avg_s: 0.3, tool: 'diamond_pickaxe',
      better: [], cheaper: [{ tool: 'iron_pickaxe', est_s: 0.5, slowdown: 1.7, savesItem: 'diamond', savesZh: '钻石', have: true }] }],
  });
  const { drives } = computeDrives(p, m);
  assert.ok(!drives.some((d) => d.drive === 'frugal'), '钻石多就不用省');
});

test('observedNeeds：effort 事实带上更快/更省的替代与稀缺度（只报事实，不替它决定）', () => {
  const p = P({
    inventory: [{ name: 'diamond', count: 3 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }],
    efficiency: [{ block: 'cobblestone', mined: 6, avg_s: 0.3, tool: 'diamond_pickaxe',
      better: [{ tool: 'netherite_pickaxe', est_s: 0.2, speedup: 1.5, have: false, materials: '3 下界合金锭' }],
      cheaper: [{ tool: 'iron_pickaxe', est_s: 0.5, slowdown: 1.7, savesItem: 'diamond', savesZh: '钻石', have: true }] }],
  });
  const effort = observedNeeds(p).find((n) => n.need === 'effort');
  assert.ok(effort);
  const facts = effort!.facts.join(' ');
  assert.match(facts, /diamond_pickaxe/);
  assert.match(facts, /netherite_pickaxe.*快 1.5 倍/);
  assert.match(facts, /iron_pickaxe.*慢 70%/);
  assert.match(facts, /钻石/);
  assert.match(facts, /3 个/);
});

test('提示词：身体段带上挖矿的双面权衡事实（dig_effort）', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('diamond', 3);
  adapter.inv.set('diamond_pickaxe', 1);
  adapter.inv.set('iron_pickaxe', 1);
  const memory = new WorldMemory(null);
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const p = perception.update();
  p.efficiency = [{ block: 'cobblestone', mined: 6, avg_s: 0.3, tool: 'diamond_pickaxe',
    better: [{ tool: 'netherite_pickaxe', est_s: 0.2, speedup: 1.5, have: false, materials: '3 下界合金锭' }],
    cheaper: [{ tool: 'iron_pickaxe', est_s: 0.5, slowdown: 1.7, savesItem: 'diamond', savesZh: '钻石', have: true }] }];
  const ctx = { reason: '测试', percept: p, state: adapter.state(), self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'deliberate' };
  const [, user] = buildMindMessages(ctx as any);
  const body = JSON.stringify(user.content);
  assert.match(body, /dig_effort/);
  assert.match(body, /netherite_pickaxe.*快 1.5 倍/);
  assert.match(body, /iron_pickaxe.*慢 70%/);
  assert.match(body, /钻石/);
  assert.match(body, /3 个/);
});

test('efficiencyInsights：实测含延迟时，快慢倍数按理论耗时比（延迟不混入）', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  // 石镐挖铁矿石：实测 1153ms（含 ~400ms 延迟），理论石 750、铁 500
  for (let i = 0; i < 4; i++) m.recordDig('iron_ore', 'stone_pickaxe', 1153);
  const oreAdapter = {
    digTimeEstimate: (block: string, tool: string | null) => {
      if (block !== 'iron_ore') return null;
      if (tool === 'stone_pickaxe') return 750;
      if (tool === 'iron_pickaxe') return 500;
      if (tool === 'diamond_pickaxe') return 375;
      return null;
    },
  };
  const ins = efficiencyInsights(oreAdapter as any, m, []);
  assert.equal(ins[0].tool, 'stone_pickaxe');
  assert.equal(ins[0].better[0].tool, 'iron_pickaxe');
  assert.equal(ins[0].better[0].speedup, 1.5); // 750/500，不是 1153/500≈2.3
});

test('efficiencyInsights：首挖离群样本只抬高平均、不抬高中位', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  // 9 次正常 ~1150ms + 1 次首挖离群 5655ms；中位仍是 1150
  for (let i = 0; i < 9; i++) m.recordDig('cobblestone', 'wooden_pickaxe', 1150);
  m.recordDig('cobblestone', 'wooden_pickaxe', 5655);
  const ins = efficiencyInsights(adapter as any, m, []);
  const stone = ins.find((e) => e.block === 'cobblestone');
  assert.equal(stone!.mined, 10);
  assert.equal(stone!.avg_s, 1.2); // 中位 1150ms，不是平均 ~1600ms
});

test('effortFacts：升级方向带上成本与可行性（没有则说要什么料，有则说已有）', () => {
  const e = {
    block: 'stone', mined: 6, avg_s: 1.2, tool: 'stone_pickaxe',
    better: [{ tool: 'iron_pickaxe', est_s: 0.4, speedup: 1.5, have: false, materials: '3 铁锭 + 2 木棍' }],
    cheaper: [],
  };
  const facts = effortFacts(e as any, [], undefined).join(' ');
  assert.match(facts, /快 1.5 倍，做一把要 3 铁锭/);
  const owned = effortFacts({ ...e, better: [{ ...e.better[0], have: true }] } as any, [], undefined).join(' ');
  assert.match(owned, /快 1.5 倍，已有/);
});
