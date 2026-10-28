import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';

const guard = (Mind.prototype as any).guardFocus;
const ctx = (over: Record<string, unknown> = {}) => ({
  activity: { id: 'act1', what: '往南挖台阶下到 y12', failures: 0 },
  activityThoughtAt: Date.now() - 60_000,
  queuedNext: null as any,
  d: { arbiter: { info: () => ({ skill: 'use_skill', source: 'llm', planId: 'act1' }) } },
  ...over,
});
const decision = (extra: Record<string, unknown> = {}) => ({ kind: 'adjust', tier: 'glance', monologue: 'x', notes: [] as string[],
  activity: { what: '先捡脚边圆石，再往南挖台阶', steps: [] }, ...extra });

test('瞥一眼明确 adjust 时保留决定，不排到后面或覆盖已有 next', () => {
  const c = ctx(), d1 = decision();
  guard.call(c, d1, 'act1', false);
  assert.equal(d1.kind, 'adjust');
  assert.equal(c.queuedNext, null);
  c.queuedNext = { draft: { what: '原本的下一段' } };
  const d2 = decision({ activity: { what: '垫高再挖', steps: [] } });
  guard.call(c, d2, 'act1', false);
  assert.equal(d2.kind, 'adjust');
  assert.equal(c.queuedNext.draft.what, '原本的下一段');
  assert.match(d2.notes[0], /明确选择的 adjust/);
});

test('瞥一眼明确 switch 时仅提示放下活动的含义，不改成 detour', () => {
  const c = ctx(), d = decision({ kind: 'switch' });
  guard.call(c, d, 'act1', false);
  assert.equal(d.kind, 'switch');
  assert.equal(c.queuedNext, null);
  assert.match(d.notes.join(), /不会自动回来/);
});

test('手上没在做、已经失败过、或是认真想过的：照常改', () => {
  const idle = ctx({ d: { arbiter: { info: () => null } } }), d1 = decision();
  guard.call(idle, d1, 'act1', false);
  assert.equal(d1.kind, 'adjust');
  const failed = ctx({ activity: { id: 'act1', what: 'x', failures: 1 } }), d2 = decision();
  guard.call(failed, d2, 'act1', false);
  assert.equal(d2.kind, 'adjust');
  const d3 = decision({ tier: 'deliberate' });
  guard.call(ctx(), d3, 'act1', false);
  assert.equal(d3.kind, 'adjust');
  const d4 = decision();
  guard.call(ctx(), d4, 'act1', true);
  assert.equal(d4.kind, 'adjust', '要紧的事不受限');
});
