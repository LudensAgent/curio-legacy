import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { fail, ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('顺手的一步“东西已经没了”：后面几轮不再做，不是每轮都白做一遍', () => {
  const adapter = new FakeAdapter();
  const a = createActivity({ what: '往下挖找床', why: '', kind: 'other', repeat: 4, steps: [
    { skill: 'mine_cell', args: { at: [0, -1, 0] } },
    { skill: 'dig', args: { target: { x: 1, y: 64, z: 1 } }, optional: true },
    { skill: 'pickup_items', args: { radius: 6 } },
  ] }, '', 'llm', adapter.state());
  const run = (r: any) => { const s = nextStep(a)!; return { s, v: afterStep(a, s, r, 10, adapter.state()) }; };
  run(ok('挖了'));
  const second = run(fail('TARGET_GONE', '目标位置已经没有方块，未拆除'));
  assert.equal(second.s.skill, 'dig');
  assert.equal(second.v.kind, 'continue');
  assert.match((second.v as any).adapted, /后面几轮不再做/);
  const skills: string[] = [];
  for (let i = 0; i < 8; i++) { const s = nextStep(a); if (!s) break; skills.push(s.skill); afterStep(a, s, ok('好'), 10, adapter.state()); }
  assert.ok(!skills.includes('dig'), skills.join(','));
});
