import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
import { PLAN_NOTE, SelfModel } from '../src/mind/self.ts';

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
  assert.match(removedWithReason.notes.join('；'), /清单改写/);
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
  const d = apply({ focus: other.id, methods: [{ text: '去农田收麦子' }], done: [0] });
  assert.match(d.notes.join('；'), /只改做法或预算时 focus 必须指向当前主目标/);
  assert.equal(self.plan()!.agendaId, a.agendaId);
  assert.deepEqual(self.plan()!.methods!.map((m) => m.text), ['沿北向开巷']);
  assert.equal(self.plan()!.steps[0]!.done, false, '被拒绝的 plan 不能顺手勾掉当前计划的项');
});

test('计划尝试保留施工量/覆盖/目标证据，方法记录最近一次证据', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '沿北向开平巷', outcome: 0 }] })!;
  const outcomeId = plan.steps[0]!.id, methodId = plan.methods![0]!.id;
  const evidence = { dug: 0, filled: 0, openSteps: 24, newChunks: 0, visitedCells: 25, maxHorizontal: 24, found: [], located: false, acquired: false };
  self.recordPlanAttempt({ outcomeId, methodId, whatHappened: '沿已知通道走 24 格', whyStopped: 'done', evidence });
  const p = self.plan()!;
  assert.deepEqual(p.attempts!.at(-1)!.evidence, evidence);
  assert.deepEqual(p.methods!.find((m) => m.id === methodId)!.lastEvidence, evidence);
});

test('按距离完成的尝试/进展不重置计划 stall 时钟；只有勾清单项才算推进', async () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '沿北向开平巷', outcome: 0 }] })!;
  const outcomeId = plan.steps[0]!.id, methodId = plan.methods![0]!.id;
  const progressAt = self.plan()!.progressAt;
  self.recordPlanAttempt({ outcomeId, methodId, whatHappened: '沿已知通道走 24 格', whyStopped: 'done',
    evidence: { dug: 0, filled: 0, openSteps: 24, newChunks: 0, visitedCells: 25, maxHorizontal: 24, found: [], located: false, acquired: false } });
  assert.equal(self.plan()!.progressAt, progressAt, '尝试记录不算清单推进');
  self.recordProgress({ targetId: outcomeId, label: plan.goal, at: Date.now(), dim: 'the_nether', start: { x: 0, y: 64, z: 0 }, end: { x: 24, y: 64, z: 0 }, outcome: 'done', summary: '走 24 格', durationSec: 10, newChunks: 0, visitedCells: 25, gained: {}, lost: {}, work: { dug: 0, filled: 0, openSteps: 24 } });
  assert.equal(self.plan()!.progressAt, progressAt, '进展账的覆盖不重置 stall');
  await new Promise((resolve) => setTimeout(resolve, 2));
  self.checkPlan([0]);
  assert.notEqual(self.plan()!.progressAt, progressAt, '勾掉清单项才是真正的计划推进');
});

test('清单行原样抄回（序号、勾选、po_ id）：不丢勾选、ID 与 done_when', () => {
  const self = new SelfModel(null);
  const cond = { type: 'self_state', field: 'dim', equals: 'the_nether' } as const;
  const plan = self.setPlan('整备基地', ['睡床并确认重生点', '整理背包'], [cond, null])!;
  self.checkPlan([0]);
  assert.equal(self.plan()!.steps[0]!.done, true);

  const id0 = self.plan()!.steps[0]!.id;
  const copied = self.setPlan(plan.agendaId, [`0. [x] 睡床并确认重生点 ${id0}`, '1. [ ] 整理背包'])!;
  assert.equal(copied.steps[0]!.text, '睡床并确认重生点', '抄回来的展示 id 不进正文');
  assert.equal(copied.steps[0]!.done, true, '文字没变，已勾掉的项保持勾掉');
  assert.equal(copied.steps[0]!.id, id0, '文字没变，成果 ID 保持稳定');
  assert.deepEqual(copied.steps[0]!.doneWhen, cond, '这次没写 done_when 也沿用原条件');
  assert.equal(copied.revisedAt, undefined, '原样抄回不算改写清单');
});

test('抄回宿主附加的注解（条件达成会自动勾 / 条件达成，自动勾的 / 其实不用做）不算改写清单', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['整理背包', '睡床并确认重生点', '门口放火把'])!;
  // “其实不用做”里带嵌套括号（耐久），也要整体剥掉
  const held = PLAN_NOTE.held('已经有 火把×8（耐久 100/100），还经用');
  const copied = self.setPlan(plan.agendaId, ['整理背包（条件达成会自动勾）', '睡床并确认重生点（条件达成，自动勾的）', `门口放火把${held}`])!;
  assert.deepEqual(copied.steps.map((st) => st.text), ['整理背包', '睡床并确认重生点', '门口放火把']);
  assert.deepEqual(copied.steps.map((st) => st.id), plan.steps.map((st) => st.id));
  assert.equal(copied.revisedAt, undefined, '宿主注解不产生改写记录');
});

test('读入旧存档时归一清单文字：带展示 id 的旧项仍能对上勾选和 ID', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curio-plan-')), 'self.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agenda: [{ id: 'a_test01', text: '整备基地', kind: 'goal', status: 'active', at: Date.now(), updatedAt: Date.now() }],
    plan: { agendaId: 'a_test01', goal: '整备基地', setAt: Date.now(), updatedAt: Date.now(), progressAt: Date.now(), steps: [
      { id: 'po_old111', text: '睡床并确认重生点 po_bzk4r8', done: true },
      { id: 'po_old222', text: '整理背包 po_0ougfk', done: false },
    ] },
  }));
  const self = new SelfModel(file);
  const plan = self.setPlan('a_test01', ['睡床并确认重生点', '整理背包'])!;
  assert.deepEqual(plan.steps.map((st) => st.text), ['睡床并确认重生点', '整理背包']);
  assert.deepEqual(plan.steps.map((st) => st.id), ['po_old111', 'po_old222'], '旧 ID 按归一后的文字沿用');
  assert.equal(plan.steps[0]!.done, true, '旧勾选保留');
});
