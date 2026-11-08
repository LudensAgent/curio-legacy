import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivity, doneWhenMet } from '../src/mind/activity.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { evaluateCondition, validateCondition } from '../src/projects/conditions.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = () => {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const state = adapter.state();
  return { adapter, memory, state };
};

test('exploration 条件：min_distance/find 至少一个，范围受校验', () => {
  const { adapter, memory, state } = setup();
  assert.deepEqual(validateCondition({ type: 'exploration', min_distance: 16 }, adapter, memory, state), { type: 'exploration', min_distance: 16 });
  assert.deepEqual(validateCondition({ type: 'exploration', find: 'oak_log' }, adapter, memory, state), { type: 'exploration', find: 'oak_log' });
  assert.throws(() => validateCondition({ type: 'exploration' }, adapter, memory, state), /至少/);
  assert.throws(() => validateCondition({ type: 'exploration', min_distance: 0 }, adapter, memory, state), /1–256/);
  assert.throws(() => validateCondition({ type: 'exploration', find: '  ' }, adapter, memory, state), /find/);
});

test('exploration 条件按活动实测位移/新区块/实际看见判定', () => {
  const { state } = setup();
  const evaluate = (condition: { type: 'exploration'; min_distance?: number; find?: string }, evidence: Record<string, unknown>) =>
    evaluateCondition(condition as any, state, state.worldId, [], { activityExploration: evidence } as any);
  assert.equal(evaluate({ type: 'exploration', min_distance: 16 }, { maxHorizontal: 20, visitedCells: 3, newChunks: 0, found: [], blocked: false }).status, 'satisfied');
  assert.equal(evaluate({ type: 'exploration', min_distance: 16 }, { maxHorizontal: 3, visitedCells: 1, newChunks: 1, found: [], blocked: false }).status, 'satisfied');
  assert.equal(evaluate({ type: 'exploration', min_distance: 16 }, { maxHorizontal: 3, visitedCells: 1, newChunks: 0, found: [], blocked: false }).status, 'unsatisfied');
  assert.equal(evaluate({ type: 'exploration', find: 'oak_log' }, { maxHorizontal: 0, visitedCells: 1, newChunks: 0, found: ['oak_log'], blocked: false }).status, 'satisfied');
  assert.equal(evaluate({ type: 'exploration', find: 'oak_log' }, { maxHorizontal: 0, visitedCells: 1, newChunks: 0, found: [], blocked: true }).status, 'unsatisfied');
  assert.equal(evaluateCondition({ type: 'exploration', min_distance: 8 } as any, state, state.worldId, [], undefined).status, 'unknown');
});

test('活动 done_when 可以用 exploration：按每步回执位置验收，不在开工时误判完成', () => {
  const { adapter, state } = setup();
  const activity = createActivity({
    what: '走远找树', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'move_step', args: { at: [1, 0, 0] } }],
    doneWhen: { type: 'exploration', min_distance: 16 } as any,
  }, '', 'llm', state);
  assert.equal(doneWhenMet(activity, state), false, '开工时还没有位移');
  activity.results.push({ skill: 'move_step', args: {}, status: 'succeeded', summary: '走远', at: Date.now(), durationMs: 2, pos: { x: state.pos.x + 20, y: state.pos.y, z: state.pos.z } });
  assert.equal(doneWhenMet(activity, adapter.state()), true);
});
