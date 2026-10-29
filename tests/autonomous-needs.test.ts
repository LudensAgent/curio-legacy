import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDrives, observedNeeds } from '../src/brain/drives.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import { ruleProposal } from '../src/planner/plan.ts';
function percept(): Percept {
  return {
    ts: 1, connected: true, time: { timeOfDay: 1000, phase: 'day' },
    self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
    inventory: [{ name: 'stone_pickaxe', count: 1 }], emptySlots: 35,
    nearby: { hostile: [], passive: ['sheep'], players: [], resources: [{ block: 'oak_log', count: 4, nearest: 5, seen: 'now' }] },
    vision: { facing: 'N', fov: 100, range: 64, view: 'sky 50%', openness: { left: 64, center: 64, right: 64 },
      visible_resources: [], remembered_resources: [], seen_entities: [{ id: 1, name: 'sheep', pos: { x: 5, y: 64, z: 0 }, dist: 5, dir: 'E', rel: '前方' }],
      heard: [], nearest_land: null, last_look_around_s: null },
    exploration: { visitedChunks: 1, noveltyByDir: { N: 1, S: 0 }, base: null },
    death_recovery: null, curiosities: [], objective: null, drives: [], stock: null,
    efficiency: [{ block: 'stone', mined: 4, avg_s: 2, tool: 'stone_pickaxe',
      better: [{ tool: 'iron_pickaxe', est_s: 1, speedup: 2, have: false, materials: '3 铁锭 + 2 木棍' }], cheaper: [] }],
    light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  };
}

const payload = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1, text.indexOf('\n', text.indexOf('\n') + 1)));

test('autonomous drives retain observed needs without selecting a home, bed, stock quota or new pastime', () => {
  const p = percept();
  p.self.hp = 7; p.self.food = 10; p.emptySlots = 2;
  p.time.phase = 'night';
  p.light = { here: 0, block: 0, sky: 0, level: 'dark', mob_spawn_risk: true, dark_view_pct: 80, underground: true, torches: 0 };
  const needs = observedNeeds(p);
  assert.deepEqual(needs.map((n) => n.need), ['health', 'hunger', 'time', 'visibility', 'carry_space', 'effort']);
  assert.match(JSON.stringify(needs), /生命 7\/20|饥饿值 10\/20|实测平均 2 秒/);
  assert.doesNotMatch(JSON.stringify(needs), /suggest|level|hunt|craft|build|71|3 羊毛|换个玩法|先准备/);
  const healthy = percept(); healthy.inventory.push({ name: 'apple', count: 1 }); healthy.efficiency = [];
  assert.deepEqual(observedNeeds(healthy), [], 'lack of a house, bed or stockpile does not choose an interest for a healthy player');
});

test('rule compatibility retains the existing sheep-to-bed proposal', () => {
  const p = percept();
  p.drives = [{ drive: 'bed', level: 1, why: '没有床', suggest: 'hunt {animal:"sheep", count:3} 拿羊毛，再 craft white_bed' }];
  const proposal = ruleProposal(p) as { steps: unknown[] };
  assert.deepEqual(proposal.steps[0], { skill: 'hunt', args: { animal: 'sheep', count: 3 } });
});
