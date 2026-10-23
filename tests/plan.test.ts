import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson, validatePlan } from '../src/planner/plan.ts';
import { FakeAdapter } from './fake-adapter.ts';

const adapter = new FakeAdapter();

test('能从 ```json 包裹或带前后缀的输出中提取 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，计划如下：{"a":{"b":2}} 祝好'), { a: { b: 2 } });
  assert.throws(() => extractJson('没有 JSON'));
});

test('合法计划通过校验，参数被规范化/截断到允许范围', () => {
  const v = validatePlan(
    { thought: 't', goal: '砍树', goal_type: 'gather', steps: [{ skill: 'gather', args: { block: 'log', count: 999 } }], abort_if: { hp_below: 6 } },
    adapter,
    'llm',
  );
  assert.ok(v.ok);
  if (v.ok) {
    assert.deepEqual(v.plan.steps[0], { skill: 'gather', args: { block: 'log', count: 32 } });
    assert.equal(v.plan.abortIf.hpBelow, 6);
  }
});

test('不存在的技能、隐藏技能、错误参数、过多步骤都会被拒绝', () => {
  const bad = [
    { goal: 'x', steps: [{ skill: 'fly' }] },
    { goal: 'x', steps: [{ skill: 'unstuck' }] },
    { goal: 'x', steps: [{ skill: 'explore', args: { direction: 'UP' } }] },
    { goal: 'x', steps: [] },
    { goal: 'x', steps: Array(6).fill({ skill: 'wander' }) },
    { steps: [{ skill: 'wander' }] },
    'not an object',
  ];
  for (const b of bad) assert.equal(validatePlan(b, adapter, 'llm').ok, false, JSON.stringify(b));
});

import { ruleProposal } from '../src/planner/plan.ts';
import type { Percept } from '../src/perception/perception.ts';

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
  p.vision!.nearest_land = { dir: 'NE', dist: 30 };
  const r = ruleProposal(p) as any;
  assert.equal(r.goal, '游回陆地');
  assert.deepEqual(r.steps[0], { skill: 'explore', args: { direction: 'NE', distance: 36 } });
});

test('规则目标：没看到树 → 先环顾；环顾过仍没有 → 去探索；看到树 → 去砍', () => {
  const p = basePercept();
  assert.equal((ruleProposal(p) as any).steps[0].skill, 'look_around');
  p.vision!.last_look_around_s = 10;
  assert.equal((ruleProposal(p) as any).steps[0].skill, 'explore');
  p.nearby.resources = [{ block: 'oak_log', count: 8, nearest: 40, dir: 'E', seen: 'now' }];
  const r = ruleProposal(p) as any;
  assert.equal(r.steps[0].skill, 'gather');
  assert.match(r.thought, /看到 E 方向 40 格/);
});
