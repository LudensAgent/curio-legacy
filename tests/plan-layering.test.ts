import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';

/** applyPlan 的最小心智壳：只接 self/bus，用来检查成果/做法分层后的实际结果。 */
const applyPlanHarness = (self: SelfModel) => {
  const events: { type: string; msg: string }[] = [];
  const bus = { publish: (type: string, _level: string, msg: string) => { events.push({ type, msg }); } };
  const mind = Object.create(Mind.prototype) as any;
  mind.d = { self, bus, adapter: { state: () => ({}) }, perception: { snapshot: () => undefined } };
  mind.safe = (f: () => unknown) => f();
  const apply = (plan: object, tier: 'glance' | 'deliberate' = 'deliberate') => {
    const d = { plan, tier, notes: [] as string[] };
    mind.applyPlan(d);
    return d;
  };
  return { apply, events };
};

test('成果稳定 ID 与做法分层：换做法保留成果和旧做法的尝试账', () => {
  const self = new SelfModel(null);
  const first = self.setPlan('找到下界要塞', ['找到下界要塞', '备好充足食物'], [null, null], {
    methods: [{ text: '沿北向开两格高平巷', outcome: 0 }],
  })!;
  const outcomeId = first.steps[0]!.id;
  const methodId = first.methods![0]!.id;
  assert.match(outcomeId, /^po_/);
  assert.match(methodId, /^pm_/);

  self.recordPlanAttempt({ outcomeId, methodId, whatHappened: '开巷 16 格后受阻', whyStopped: 'BLOCKED' });
  const old = self.plan()!;
  assert.equal(old.methods!.find((m) => m.id === methodId)!.attempts, 1);
  assert.equal(old.methods!.find((m) => m.id === methodId)!.stopReasons.BLOCKED, 1);

  const rewritten = self.setPlan('找到下界要塞', ['找到下界要塞', '备好充足食物'], [null, null], {
    methods: [{ text: '沿旧路走到远处再找入口', outcome: 0 }],
  })!;
  assert.deepEqual(rewritten.steps.map((st) => st.id), [outcomeId, rewritten.steps[1]!.id], '文字相同的成果保留原 ID');
  const paused = rewritten.methods!.find((m) => m.text === '沿北向开两格高平巷')!;
  assert.equal(paused.id, methodId, '旧做法保留 ID 与历史');
  assert.equal(paused.status, 'paused', '新列表没再列出的做法收起，不再显示为启用中');
  assert.equal(paused.attempts, 1);
  assert.equal(rewritten.methods!.find((m) => m.text === '沿旧路走到远处再找入口')!.status, 'active');
});

test('只改做法不动成果清单、改写计时与进展时间；明确停用才标 dropped', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞', '备好充足食物'], [null, null], {
    methods: [{ text: '沿北向开两格高平巷', outcome: 0 }],
  })!;
  const before = { steps: plan.steps.map((st) => ({ id: st.id, text: st.text })), progressAt: plan.progressAt, revisedAt: plan.revisedAt };
  const methodId = plan.methods![0]!.id;

  self.updatePlanMethods([{ text: '沿旧路走到远处再找入口', outcome: 0 }], [methodId]);
  const after = self.plan()!;
  assert.deepEqual(after.steps.map((st) => ({ id: st.id, text: st.text })), before.steps);
  assert.equal(after.progressAt, before.progressAt, '换做法不算成果进展');
  assert.deepEqual(after.revisedAt, before.revisedAt, '换做法不算改写成果清单');
  assert.equal(after.methods!.find((m) => m.id === methodId)!.status, 'dropped');
  assert.equal(after.methods!.find((m) => m.text === '沿旧路走到远处再找入口')!.status, 'active');
});

test('applyPlan：成果不变时只换做法不触发清单保护；改成果仍按原规则', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞', '备好充足食物'], [null, null], {
    methods: [{ text: '沿北向开两格高平巷', outcome: 0 }],
  })!;
  const { apply, events } = applyPlanHarness(self);

  const methodsOnly = apply({ focus: plan.agendaId, steps: ['找到下界要塞', '备好充足食物'], methods: [{ text: '沿旧路走到远处再找入口', outcome: 0 }] });
  assert.deepEqual(methodsOnly.notes, []);
  assert.ok(events.some((e) => e.type === 'plan_methods'), '只换做法走单独记录');
  assert.equal(self.plan()!.methods!.find((m) => m.text === '沿旧路走到远处再找入口')!.status, 'active');

  const removed = apply({ focus: plan.agendaId, steps: ['找到下界要塞'] });
  assert.deepEqual(self.plan()!.steps.map((st) => st.text), ['找到下界要塞', '备好充足食物'], '删掉没做完的成果没有理由仍被拒绝');
  assert.match(removed.notes.join('；'), /还没做完/);

  const removedWithReason = apply({ focus: plan.agendaId, steps: ['找到下界要塞'], switchReason: '食物已够，不再单列' });
  assert.deepEqual(removedWithReason.notes, []);
  assert.deepEqual(self.plan()!.steps.map((st) => st.text), ['找到下界要塞']);
});

test('尝试账只随明确关联的记录写入，且最多保留 40 条', () => {
  const self = new SelfModel(null);
  assert.equal(self.recordPlanAttempt({ whatHappened: '无主计划的尝试' }), null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '开巷', outcome: 0 }] })!;
  const methodId = plan.methods![0]!.id;
  for (let i = 0; i < 45; i++) self.recordPlanAttempt({ outcomeId: plan.steps[0]!.id, methodId, whatHappened: `第 ${i} 次`, whyStopped: 'BUDGET' });
  const after = self.plan()!;
  assert.equal(after.attempts!.length, 40);
  assert.equal(after.methods!.find((m) => m.id === methodId)!.attempts, 45, '计数不因保留上限丢历史');
  assert.equal(after.methods!.find((m) => m.id === methodId)!.stopReasons.BUDGET, 45);
});

test('单独停用做法会生效；重新列入旧做法恢复 active 并保留尝试账', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '沿北向开巷', outcome: 0 }] })!;
  const id = plan.methods![0]!.id;
  self.recordPlanAttempt({ methodId: id, outcomeId: plan.steps[0]!.id, whatHappened: '开了一段', whyStopped: 'BLOCKED' });
  self.updatePlanMethods(undefined, [id]);
  assert.equal(self.plan()!.methods!.find((m) => m.id === id)!.status, 'dropped');
  self.updatePlanMethods([{ text: '沿北向开巷', outcome: 0 }]);
  const restored = self.plan()!.methods!.find((m) => m.id === id)!;
  assert.equal(restored.status, 'active', '重新列入就是重新启用');
  assert.equal(restored.attempts, 1, '历史尝试不丢');
});

test('只改做法时 focus 指向别的主目标会被拒绝，不污染新计划', () => {
  const self = new SelfModel(null);
  const a = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '沿北向开巷', outcome: 0 }] })!;
  const other = self.addAgenda('备好食物', 'goal', 'today')!;
  const { apply } = applyPlanHarness(self);
  const d = apply({ focus: other.id, methods: [{ text: '去农田收麦子' }] });
  assert.match(d.notes.join('；'), /只改做法时 focus 必须指向当前主目标/);
  assert.equal(self.plan()!.agendaId, a.agendaId);
  assert.deepEqual(self.plan()!.methods!.map((m) => m.text), ['沿北向开巷']);
});
