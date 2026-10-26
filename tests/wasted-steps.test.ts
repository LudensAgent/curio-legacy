import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity } from '../src/mind/activity.ts';
import { sleepReason } from '../src/skills/build.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('a routine whose dig_at keeps hitting air is handed back to the mind instead of looping', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'dig_at', args: { at: [1, 1, 0], facing: 'N' } }, step = { skill: 'step', args: { at: [1, 0, 0], facing: 'N' } };
  const a = createActivity({ what: '挖阶梯上去', why: '', kind: 'explore', repeat: 12, steps: [step, dig] }, '', 'llm', adapter.state());
  const air = { status: 'succeeded' as const, summary: '[1,1,0] 本来就是空的，不用挖', data: { cell: [1, 1, 0], was: 'air' } };
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
  assert.match((verdict as any).why, /连着 3 轮挖到的都是空气/);
});

test('a dig that actually removes a block resets the air count', () => {
  const adapter = new FakeAdapter();
  const dig = { skill: 'dig_at', args: { at: [1, 2, 0] } };
  const a = createActivity({ what: '挖', why: '', kind: 'explore', repeat: 12, steps: [dig] }, '', 'llm', adapter.state());
  const air = { status: 'succeeded' as const, summary: 'air', data: { was: 'air' } }, stone = { status: 'succeeded' as const, summary: 'stone', data: { was: 'stone' } };
  for (const r of [air, air, stone, air, air]) { a.index = 1; assert.equal(afterStep(a, dig, r, 50, adapter.state()).kind === 'stuck', false); }
});

test('an occupied bed is explained as not worth waiting for', () => {
  assert.match(sleepReason('the bed is occupied'), /等下去它也不会空出来/);
});
