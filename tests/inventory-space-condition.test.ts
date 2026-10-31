import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { parseDecision } from '../src/mind/thinker.ts';
import { conditionDeficit, evaluateCondition, validateCondition } from '../src/projects/conditions.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('inventory_space_min requires an explicit integral target of 1–36 free slots', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const state = adapter.state();
  [1, 36].forEach((free_slots) => {
    const raw = { type: 'inventory_space_min', free_slots };
    assert.deepEqual(validateCondition(raw, adapter, memory, state), raw);
  });
  [undefined, 0, -1, 37, 2.5, '3', NaN].forEach((free_slots) => {
    assert.throws(() => validateCondition({ type: 'inventory_space_min', free_slots }, adapter, memory, state), /1–36/);
  });
  assert.deepEqual(validateCondition({ type: 'inventory_full' }, adapter, memory, state), { type: 'inventory_full', free_slots: 0 });
});

test('clearing space and filling a bag retain opposite comparisons and measured progress', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const state = { ...adapter.state(), emptySlots: 0 };
  const space = validateCondition({ type: 'inventory_space_min', free_slots: 3 }, adapter, memory, state);
  const full = validateCondition({ type: 'inventory_full', free_slots: 2 }, adapter, memory, state);
  [0, 2, 3, 36].forEach((emptySlots) => {
    const observed = { ...state, emptySlots };
    assert.equal(evaluateCondition(space, observed).status, emptySlots >= 3 ? 'satisfied' : 'unsatisfied');
    assert.equal(evaluateCondition(full, observed).status, emptySlots <= 2 ? 'satisfied' : 'unsatisfied');
    assert.equal(conditionDeficit(space, observed), Math.max(0, 3 - emptySlots) / 36);
  });
  const combined = validateCondition({ type: 'all_of', conditions: [{ type: 'inventory_space_min', free_slots: 3 }] }, adapter, memory, state);
  assert.equal(evaluateCondition(combined, state).status, 'unsatisfied');
  assert.equal(evaluateCondition(combined, { ...state, emptySlots: 3 }).status, 'satisfied');
  assert.equal(evaluateCondition(space, { ...state, observationReady: false }).status, 'unknown');
  assert.equal(conditionDeficit(space, { ...state, observationReady: false }), null);
  assert.equal(evaluateCondition(space, { ...state, emptySlots: NaN }).status, 'unknown');
  assert.equal(conditionDeficit(space, { ...state, emptySlots: NaN }), null);
});

test('a parsed cleanup activity and checklist preserve the free-space target until it is observed', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const state = { ...adapter.state(), emptySlots: 0 };
  const done_when = { type: 'inventory_space_min', freeSlots: 3 };
  const decision = parseDecision({ decision: 'new', activity: { what: '腾出三格空位', kind: 'tidy', repeat: 3,
    steps: [{ skill: 'toss_item', args: { item: 'cobblestone', count: 64 } }], done_when },
    plan: { focus: '清理背包', steps: [{ text: '腾出三格空位', done_when }] } }, adapter, memory, false);
  assert.ok(!('error' in decision));
  assert.ok(decision.activity);
  assert.deepEqual(decision.activity.doneWhen, { type: 'inventory_space_min', free_slots: 3 });
  assert.deepEqual(decision.plan?.conditions, [{ type: 'inventory_space_min', free_slots: 3 }]);
  assert.ok(!decision.notes.some((note) => note.includes('无效')));
  const activity = createActivity(decision.activity, '', 'llm', state);
  [0, 2, 3].forEach((emptySlots) => {
    const step = nextStep(activity);
    assert.ok(step);
    const verdict = afterStep(activity, step, ok('扔出了一组石头'), 10, { ...state, emptySlots });
    if (emptySlots < 3) assert.equal(verdict.kind, 'continue', 'action success alone does not certify free space');
    else {
      assert.equal(verdict.kind, 'done');
      if (verdict.kind === 'done') assert.equal(verdict.met, true);
    }
  });
});

test('cleanup steps finishing with a full bag leave the completion condition unmet', () => {
  const state = { ...new FakeAdapter().state(), emptySlots: 0 };
  const activity = createActivity({ what: '腾出三格空位', why: '', kind: 'tidy', repeat: 1,
    steps: [{ skill: 'toss_item', args: { item: 'cobblestone', count: 64 } }],
    doneWhen: { type: 'inventory_space_min', free_slots: 3 } }, '', 'llm', state);
  const step = nextStep(activity);
  assert.ok(step);
  const verdict = afterStep(activity, step, ok('物品已扔出'), 10, state);
  assert.equal(verdict.kind, 'done');
  if (verdict.kind === 'done') {
    assert.equal(verdict.met, false);
    assert.match(verdict.why, /未满足/);
  }
});

test('a succeeded final step whose condition is unmet keeps the step caveat in the unmet reason', () => {
  const state = { ...new FakeAdapter().state(), emptySlots: 0 };
  const activity = createActivity({ what: '把石块存进箱子腾出空间', why: '', kind: 'tidy', repeat: 1,
    steps: [{ skill: 'store_items', args: { items: ['granite', 'gravel'] } }],
    doneWhen: { type: 'inventory_space_min', free_slots: 3 } }, '', 'llm', state);
  const step = nextStep(activity);
  assert.ok(step);
  const verdict = afterStep(activity, step, ok('在选定容器存入 granite×3、gravel×4，箱子还剩 0 格空'), 10, state);
  assert.equal(verdict.kind, 'done');
  if (verdict.kind === 'done') {
    assert.equal(verdict.met, false);
    // 部分成功（status=succeeded 但收工条件没达成）时，最后一步的 caveat 要跟着 unmet 反馈一起送回去
    assert.match(verdict.why, /最后一步：在选定容器存入 granite×3、gravel×4，箱子还剩 0 格空/);
    assert.match(verdict.why, /未满足/);
  }
});
