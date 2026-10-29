import assert from 'node:assert/strict';
import { test } from 'node:test';
import { efficiencyInsights } from '../src/brain/efficiency.ts';
import { computeDrives, observedNeeds } from '../src/brain/drives.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';

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
