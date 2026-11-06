import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson } from '../src/planner/plan.ts';
import { FakeAdapter } from './fake-adapter.ts';

import { ruleProposal } from '../src/planner/plan.ts';
import type { Percept } from '../src/perception/perception.ts';

const adapter = new FakeAdapter();

test('能从 ```json 包裹或带前后缀的输出中提取 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，计划如下：{"a":{"b":2}} 祝好'), { a: { b: 2 } });
  assert.throws(() => extractJson('没有 JSON'));
});

const basePercept = (over: Partial<Percept> = {}): Percept => ({
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 62, 0], dim: 'overworld', hp: 20, food: 20, biome: 'ocean', inWater: false, inLava: false, held: null },
  inventory: [], emptySlots: 36,
  nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 64, view: 'sky 50%', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: null },
  exploration: { visitedChunks: 1, noveltyByDir: { N: 1, NE: 1, E: 1, SE: 1, S: 1, SW: 1, W: 1, NW: 1 }, base: null },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, efficiency: [], light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  ...over,
});

test('规则目标：在水里且看见过陆地 → 朝陆地方向上岸', () => {
  const p = basePercept();
  p.self.inWater = true;
  p.vision!.nearest_land = { dir: 'NE', dist: 30, foot: { x: 21, y: 62, z: -21 }, relative_height: 0, path_confirmed: false, note: '测试候选落脚点，尚未确认路径' };
  const r = ruleProposal(p) as any;
  assert.equal(r.goal, '游回陆地');
  assert.deepEqual(r.steps[0], { skill: 'resolve_target', args: { target: 'NE 36' } });
});

test('规则目标：没看到树 → 先环顾；环顾过仍没有 → 去探索；看到树 → 去砍', () => {
  const p = basePercept();
  assert.equal((ruleProposal(p) as any).steps[0].skill, 'look_around');
  p.vision!.last_look_around_s = 10;
  assert.equal((ruleProposal(p) as any).steps[0].skill, 'resolve_target');
  p.nearby.resources = [{ block: 'oak_log', count: 8, nearest: 40, dir: 'E', seen: 'now' }];
  const r = ruleProposal(p) as any;
  assert.equal(r.steps[0].skill, 'gather');
  assert.match(r.thought, /看到 E 方向 40 格/);
});
