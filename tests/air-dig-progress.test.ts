import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('air at successive relative targets does not interrupt a tunnel routine that is moving', () => {
  const adapter = new FakeAdapter();
  const steps = [
    { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'N' } },
    { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'N' } },
    { skill: 'place_cell', args: { at: [1, -1, 0], facing: 'N', item: 'cobblestone' } },
    { skill: 'move_step', args: { at: [1, 0, 0], facing: 'N' } },
  ];
  const activity = createActivity({ what: '沿北向平巷推进', why: '', kind: 'gather', repeat: 4, steps }, '', 'llm', adapter.state());
  let moved = 0;
  while (true) {
    const step = nextStep(activity);
    if (!step) break;
    const target = { x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) - 1 };
    if (step.skill === 'move_step') { adapter.pos.z--; moved++; }
    const result = step.skill === 'mine_cell' ? ok('目标是空气', { was: 'air', targetCell: target })
      : step.skill === 'place_cell' ? ok('支撑已放置', { placed: 'cobblestone' }) : ok('已进入下一格');
    const verdict = afterStep(activity, step, result, 100, adapter.state());
    assert.notEqual(verdict.kind, 'stuck');
    if (verdict.kind === 'done') assert.equal(moved, 4);
  }
  assert.equal(moved, 4);
});

test('moving between empty target cells resets the count even without digging or placement', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'N' } };
  const activity = createActivity({ what: '沿空通道走', why: '', kind: 'explore', repeat: 5, steps: [dig] }, '', 'llm', adapter.state());
  for (let i = 0; i < 5; i++) {
    adapter.pos.z--;
    const step = nextStep(activity)!;
    const targetCell = { x: 0, y: 65, z: adapter.pos.z - 1 };
    assert.notEqual(afterStep(activity, step, ok('空气', { was: 'air', targetCell }), 100, adapter.state()).kind, 'stuck');
  }
});

test('new excavation in another cell prevents empty headroom from being treated as stalled work', () => {
  const adapter = new FakeAdapter();
  const steps = [
    { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'N' } },
    { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'N' } },
  ];
  const activity = createActivity({ what: '逐格挖开岩面', why: '', kind: 'gather', repeat: 4, steps }, '', 'llm', adapter.state());
  for (let i = 0; i < 8; i++) {
    const step = nextStep(activity)!;
    const result = i % 2 === 0 ? ok('空气', { was: 'air', targetCell: { x: 0, y: 65, z: -1 } })
      : ok('挖掉方块', { was: 'sand', targetCell: { x: 0, y: 64, z: -1 } });
    assert.notEqual(afterStep(activity, step, result, 100, adapter.state()).kind, 'stuck');
  }
});

test('three confirmed empty digs at one stationary cell report facts without inventing a route', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'N' } };
  const activity = createActivity({ what: '原地尝试', why: '', kind: 'experiment', repeat: 5, steps: [dig] }, '', 'llm', adapter.state());
  const result = ok('空气', { was: 'air', targetCell: { x: 0, y: 64, z: -1 } });
  assert.equal(afterStep(activity, nextStep(activity)!, result, 100, adapter.state()).kind, 'continue');
  assert.equal(afterStep(activity, nextStep(activity)!, result, 100, adapter.state()).kind, 'continue');
  const verdict = afterStep(activity, nextStep(activity)!, result, 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  if (verdict.kind === 'stuck') {
    assert.match(verdict.why, /连续 3 次确认目标格 \(0,64,-1\) 是空气/);
    assert.doesNotMatch(verdict.why, /往上|阶梯|换|写得对不对/);
  }
});

test('stationary dig progress resets empty-dig counts only when it actually removes blocks', () => {
  for (const dug of [['stone'], []]) {
    const adapter = new FakeAdapter();
    const steps = [
      { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'N' } },
      { skill: 'excavate_run', args: { mode: 'stairs_up', direction: 'north', steps: 1 } },
    ];
    const activity = createActivity({ what: '清理头顶', why: '', kind: 'gather', repeat: 4, steps }, '', 'llm', adapter.state());
    const air = ok('空气', { was: 'air', targetCell: { x: 0, y: 64, z: -1 } });
    for (let i = 0; i < 4; i++) {
      const verdict = afterStep(activity, nextStep(activity)!, air, 100, adapter.state());
      if (!dug.length && i === 2) { assert.equal(verdict.kind, 'stuck'); break; }
      assert.equal(verdict.kind, 'continue');
      assert.notEqual(afterStep(activity, nextStep(activity)!, ok('挖掘结果', { dug }), 100, adapter.state()).kind, 'stuck');
    }
  }
});

test('missing physical target evidence cannot be treated as repeated digs at one cell', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'N' } };
  const activity = createActivity({ what: '缺少目标记录', why: '', kind: 'experiment', repeat: 4, steps: [dig] }, '', 'llm', adapter.state());
  for (let i = 0; i < 4; i++) assert.notEqual(afterStep(activity, nextStep(activity)!, ok('空气', { was: 'air' }), 100, adapter.state()).kind, 'stuck');
});
