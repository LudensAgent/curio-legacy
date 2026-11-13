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
type Decision = { kind: string; tier: string; monologue: string; notes: string[]; sent?: boolean;
  activity?: { what: string; steps: unknown[] }; next?: { what: string } };
const decision = (extra: Partial<Decision> = {}): Decision => ({ kind: 'adjust', tier: 'glance', monologue: 'x', notes: [],
  activity: { what: '先捡脚边圆石，再往南挖台阶', steps: [] }, ...extra });

test('瞥一眼明确 adjust 时保留决定，不排到后面或覆盖已有 next', () => {
  const c = ctx(), d1 = decision();
  guard.call(c, d1, 'act1', {});
  assert.equal(d1.kind, 'adjust');
  assert.equal(c.queuedNext, null);
  c.queuedNext = { draft: { what: '原本的下一段' } };
  const d2 = decision({ activity: { what: '垫高再挖', steps: [] } });
  guard.call(c, d2, 'act1', {});
  assert.equal(d2.kind, 'adjust');
  assert.equal(c.queuedNext.draft.what, '原本的下一段');
  assert.match(d2.notes[0], /明确选择的 adjust/);
});

test('非紧急的瞥一眼 new/switch 不放下活动：排到这段之后', () => {
  for (const kind of ['new', 'switch'] as const) {
    const c = ctx(), d = decision({ kind });
    guard.call(c, d, 'act1', {});
    assert.equal(d.kind, 'continue');
    assert.equal(d.activity, undefined);
    assert.equal(d.next?.what, '先捡脚边圆石，再往南挖台阶');
    assert.match(d.notes.join(), /排到这段之后/);
    assert.equal(c.queuedNext, null);
  }
});

test('紧急的瞥一眼不改写决定：原活动由 apply 挂起后照做', () => {
  for (const kind of ['new', 'switch'] as const) {
    const c = ctx(), d = decision({ kind });
    guard.call(c, d, 'act1', { emergency: true });
    assert.equal(d.kind, kind, 'Agent 的明确决定不被改写');
    assert.equal(d.activity?.what, '先捡脚边圆石，再往南挖台阶', '紧急活动保留');
    assert.equal(d.notes.length, 0);
    assert.equal(c.queuedNext, null);
  }
});

test('瞥一眼 new/switch 不覆盖已经排好的下一段', () => {
  const c = ctx(), d = decision({ kind: 'switch', next: { what: '原本的下一段' } });
  guard.call(c, d, 'act1', {});
  assert.equal(d.kind, 'continue');
  assert.equal(d.activity, undefined);
  assert.equal(d.next?.what, '原本的下一段');
  assert.match(d.notes.join(), /已有排好的下一段/);
});

test('操作者指令照做时不受瞥一眼限制；手上没活也不转', () => {
  const ordered = decision({ kind: 'switch' });
  guard.call(ctx(), ordered, 'act1', { urgent: true, operator: true });
  assert.equal(ordered.kind, 'switch', '操作者指令照做');
  const idle = ctx({ activity: null }), d = decision({ kind: 'switch' });
  guard.call(idle, d, 'act1', {});
  assert.equal(d.kind, 'switch', '手上没活时不转');
});

test('手上没在做、已经失败过、或是认真想过的：照常改', () => {
  const idle = ctx({ d: { arbiter: { info: () => null } } }), d1 = decision();
  guard.call(idle, d1, 'act1', {});
  assert.equal(d1.kind, 'adjust');
  const failed = ctx({ activity: { id: 'act1', what: 'x', failures: 1 } }), d2 = decision();
  guard.call(failed, d2, 'act1', {});
  assert.equal(d2.kind, 'adjust');
  const d3 = decision({ tier: 'deliberate' });
  guard.call(ctx(), d3, 'act1', {});
  assert.equal(d3.kind, 'adjust');
  const d4 = decision();
  guard.call(ctx(), d4, 'act1', { emergency: true });
  assert.equal(d4.kind, 'adjust', '要紧的事不受限');
});
