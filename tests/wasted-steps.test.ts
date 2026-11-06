import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity } from '../src/mind/activity.ts';
import { sleepReason } from '../src/skills/build.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('a routine whose mine_cell keeps hitting air is handed back to the mind instead of looping', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'N' } }, step = { skill: 'step', args: { at: [1, 0, 0], facing: 'N' } };
  const a = createActivity({ what: '挖阶梯上去', why: '', kind: 'explore', repeat: 12, steps: [step, dig] }, '', 'llm', adapter.state());
  const air = { status: 'succeeded' as const, summary: '[1,1,0] 本来就是空的，不用挖', data: { cell: [1, 1, 0], targetCell: { x: 0, y: 65, z: -1 }, was: 'air' } };
  const moved = { status: 'succeeded' as const, summary: '站到了 [1,0,0]' };
  let verdict;
  for (let round = 0; round < 3; round++) {
    a.index++; verdict = afterStep(a, step, moved, 100, adapter.state());
    assert.equal(verdict.kind, 'continue');
    a.index++; verdict = afterStep(a, dig, air, 50, adapter.state());
    if (round < 2) assert.equal(verdict.kind, 'continue');
    a.index = 0;
  }
  assert.equal(verdict!.kind, 'stuck');
  if (verdict?.kind === 'stuck') assert.match(verdict.why, /连续 3 次确认目标格 .* 是空气/);
});

test('a dig that actually removes a block resets the air count', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'mine_cell', args: { at: [1, 2, 0] } };
  const a = createActivity({ what: '挖', why: '', kind: 'explore', repeat: 12, steps: [dig] }, '', 'llm', adapter.state());
  const air = { status: 'succeeded' as const, summary: 'air', data: { was: 'air', targetCell: { x: 0, y: 66, z: -1 } } }, stone = { status: 'succeeded' as const, summary: 'stone', data: { was: 'stone' } };
  for (const r of [air, air, stone, air, air]) { a.index = 1; assert.equal(afterStep(a, dig, r, 50, adapter.state()).kind === 'stuck', false); }
});

test('a bed that stays occupied after a click is explained, with other ways to sleep', () => {
  assert.match(sleepReason('the bed is occupied'), /点了一下床也没空出来/);
  assert.match(sleepReason('the bed is occupied'), /sleep \{"place":true\}/);
});
