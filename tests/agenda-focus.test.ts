import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';

/** applyAgendaFocus 的最小壳：只接 self/bus，用来检查目标完成/放下/换目标的实际结果。 */
const harness = (self: SelfModel) => {
  const events: { type: string; msg: string }[] = [];
  const mind = Object.create(Mind.prototype) as any;
  mind.d = { self, bus: { publish: (type: string, _severity: string, msg: string) => { events.push({ type, msg }); } } };
  mind.inReview = false;
  const apply = (agenda: { add?: object[]; done?: string[]; drop?: string[]; focus?: string }, extra: { plan?: { focus?: string; goal?: string; steps?: unknown[]; done?: (number | string)[]; switchReason?: string }; operator?: { status: string } } = {}) => {
    const d = { agenda: { add: [], done: [], drop: [], ...agenda }, tier: 'deliberate', notes: [] as string[], ...extra };
    mind.applyAgendaFocus(d);
    return d;
  };
  return { mind, apply, events };
};

test('活跃目标还有未完成项：普通念头写 done 被拒绝，清单与阶段记录都不动', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石', '做工作台'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] });
  assert.equal(self.plan()?.agendaId, plan.agendaId);
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'active');
  assert.equal(self.stages().length, 0);
  assert.match(d.notes.join('；'), /还有 2 项没完成/);
  assert.ok(events.some((e) => e.type === 'goal_done_refused'));
  assert.ok(!events.some((e) => e.type === 'goal_done'));
});

test('阶段回顾/操作者指令可以结束未完成目标，但记为 dropped（abandoned），不是 done', () => {
  for (const end of ['review', 'operator'] as const) {
    const self = new SelfModel(null);
    const plan = self.setPlan('整备基地', ['补圆石', '做工作台'])!;
    const { mind, apply, events } = harness(self);
    if (end === 'review') mind.inReview = true;
    const d = apply({ done: [plan.agendaId], add: [], drop: [] }, end === 'operator' ? { operator: { status: 'doing' } } : {});
    assert.equal(self.plan(), null, `${end}：清单收起`);
    assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'dropped');
    assert.equal(self.stages().at(-1)?.outcome, 'dropped', `${end}：阶段记为放下`);
    assert.ok(events.some((e) => e.type === 'goal_dropped'), `${end}：有放下事件`);
    assert.ok(!events.some((e) => e.type === 'goal_done'), `${end}：不冒充完成`);
    assert.match(d.notes.join('；'), /不是完成/);
  }
});

test('没有明确回应操作者指令（declined）不能结束未完成目标', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { operator: { status: 'declined' } });
  assert.equal(self.plan()?.agendaId, plan.agendaId);
  assert.match(d.notes.join('；'), /没完成/);
  assert.ok(events.some((e) => e.type === 'goal_done_refused'));
});

test('同一念里一个字符串 done 只勾第一处匹配：不能把后续同名项也算作已勾', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['挖 5 块石头', '烧 5 块石头'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: plan.agendaId, done: ['石头'] } });
  assert.match(d.notes.join('；'), /还有 2 项没完成/);
  assert.ok(events.some((e) => e.type === 'goal_done_refused'));
  assert.equal(self.plan()?.agendaId, plan.agendaId);
});

test('同一 id 既在 done 又在 drop：按 done 处理，drop 不覆盖结果', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  self.checkPlan([0]);
  const { apply } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [plan.agendaId] });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'done');
  assert.equal(self.stages().at(-1)?.outcome, 'done');
  assert.match(d.notes.join('；'), /按 done 处理/);
});

test('非活跃目标的 drop 照常清理，并发放下事件', () => {
  const self = new SelfModel(null);
  self.setPlan('整备基地', ['补圆石'])!;
  const old = self.addAgenda('旧目标', 'goal', 'someday')!;
  const { apply, events } = harness(self);
  apply({ done: [], add: [], drop: [old.id] });
  assert.equal(self.data.agenda.find((a) => a.id === old.id)?.status, 'dropped');
  assert.ok(events.some((e) => e.type === 'goal_dropped' && /agenda_cleanup|放下/.test(e.msg)));
});

test('已完成的目标准则重复 done 不会改成 dropped', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  self.checkPlan([0]);
  const { apply, events } = harness(self);
  apply({ done: [plan.agendaId], add: [], drop: [] });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'done');
  const d = apply({ done: [plan.agendaId], add: [], drop: [] });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'done');
  assert.match(d.notes.join('；'), /已经完成/);
  assert.ok(!events.some((e) => e.type === 'goal_dropped'));
});

test('同一念 done 和 focus 指向同一目标：完成优先，不再把它激活回来', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  self.checkPlan([0]);
  const { mind, apply } = harness(self);
  mind.inReview = true;
  const d = apply({ done: [plan.agendaId], add: [], drop: [], focus: plan.agendaId });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'done');
  assert.equal(self.activeAgenda(), undefined, '不再激活已完成的目标');
  assert.match(d.notes.join('；'), /同时结束和聚焦/);
});

test('活跃主目标还没有清单：普通念头 done 也不能结束', () => {
  const self = new SelfModel(null);
  const g = self.addAgenda('去下界', 'goal', 'today')!;
  self.setAgendaStatus(g.id, 'active');
  const { apply, events } = harness(self);
  const d = apply({ done: [g.id], add: [], drop: [] });
  assert.equal(self.data.agenda.find((a) => a.id === g.id)?.status, 'active');
  assert.match(d.notes.join('；'), /还没有清单/);
  assert.ok(events.some((e) => e.type === 'goal_done_refused'));
});

test('被拒绝的 done 不进入 releasing，不能顺带授权同一念换目标', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const other = self.addAgenda('去下界', 'goal', 'today')!;
  const { apply } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: other.id, steps: ['搭传送门'] } });
  assert.deepEqual(d.agenda.done, [], '未真正结束的目标不进入 releasing');
  assert.notEqual(self.goalSwitchRefusal(other.id, { deliberate: true, reason: '想换', releasing: d.agenda.done }), null, '换目标仍被拒绝');
});

test('done 被拒绝后同一 id 的 drop 按实际结果拒绝，不写“按 done 处理”', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [plan.agendaId] });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'active');
  assert.ok(events.some((e) => e.type === 'goal_drop_refused'));
  assert.doesNotMatch(d.notes.join('；'), /按 done 处理/);
});

test('done 被拒绝时同一念给它写的清单不被撤下', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { apply } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: plan.agendaId, steps: ['补圆石', '做床'] } });
  assert.equal((d.plan?.steps as unknown[] | undefined)?.length, 2, '清单保留');
  assert.doesNotMatch(d.notes.join('；'), /结束优先/);
});

test('采纳操作者建议（adopted）不等于操作者下令，不能结束未完成目标', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { operator: { status: 'adopted' } });
  assert.equal(self.plan()?.agendaId, plan.agendaId);
  assert.match(d.notes.join('；'), /没完成/);
  assert.ok(events.some((e) => e.type === 'goal_done_refused'));
  assert.ok(!events.some((e) => e.type === 'goal_done'));
});

test('plan.focus 写成目标文字时，结束优先同样拦住复活', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { mind, apply } = harness(self);
  mind.inReview = true;
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: plan.goal, steps: ['补圆石', '做床'] } });
  assert.match(d.notes.join('；'), /结束优先/);
  assert.equal(d.plan?.steps, undefined);
});

test('没写 plan.focus 时按 goal 文字新建目标的路径也要拦住“结束又复活”', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { mind, apply } = harness(self);
  mind.inReview = true;
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { goal: plan.goal, steps: ['补圆石', '做床'] } });
  assert.match(d.notes.join('；'), /结束优先/);
  assert.equal(d.plan?.steps, undefined, '清单被撤下，不会用 goal 文字新建同名目标');
});

test('清单全部勾完才记 done；只是原文重复 done 不算证据', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石', '做工作台'])!;
  self.checkPlan([0, 1]);
  const { apply, events } = harness(self);
  apply({ done: [plan.agendaId], add: [], drop: [] });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'done');
  assert.equal(self.stages().at(-1)?.outcome, 'done');
  assert.ok(events.some((e) => e.type === 'goal_done'));
});

test('同一念已经排好勾掉剩余项：完成判定交给 applyPlanDone，不在 agenda 提前算完成', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石', '做工作台'])!;
  const { apply, events } = harness(self);
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: plan.agendaId, done: [0, 1] } });
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'active');
  assert.equal(self.plan()?.agendaId, plan.agendaId);
  assert.ok(!events.some((e) => e.type === 'goal_done'));
  assert.ok(!d.notes.some((n) => /没完成/.test(n)), '不提前报未完成');
});

test('非活跃目标没有清单证据：done 按放下记，不冒充完成', () => {
  const self = new SelfModel(null);
  self.setPlan('整备基地', ['补圆石'])!;
  const old = self.addAgenda('旧目标', 'goal', 'someday')!;
  const { apply, events } = harness(self);
  apply({ done: [old.id], add: [], drop: [] });
  assert.equal(self.data.agenda.find((a) => a.id === old.id)?.status, 'dropped');
  assert.ok(events.some((e) => e.type === 'goal_dropped' && /没有清单证据/.test(e.msg)));
});

test('活跃目标的 drop：普通念头拒绝，阶段回顾/操作者指令才放下', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { mind, apply, events } = harness(self);
  let d = apply({ done: [], add: [], drop: [plan.agendaId] });
  assert.equal(self.plan()?.agendaId, plan.agendaId);
  assert.match(d.notes.join('；'), /不能随手放下/);
  assert.ok(events.some((e) => e.type === 'goal_drop_refused'));
  mind.inReview = true;
  apply({ done: [], add: [], drop: [plan.agendaId] });
  assert.equal(self.plan(), null);
  assert.equal(self.data.agenda.find((a) => a.id === plan.agendaId)?.status, 'dropped');
});

test('同一念 plan.focus 与 agenda.focus 冲突：只认带清单的 plan.focus，另一个不生效', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const other = self.addAgenda('去下界', 'goal', 'today')!;
  const { apply } = harness(self);
  const d = apply({ focus: other.id, done: [], add: [], drop: [] }, { plan: { focus: plan.agendaId, steps: ['补圆石'] } });
  assert.match(d.notes.join('；'), /同时给了两个主目标/);
  assert.equal(self.activeAgenda()?.id, plan.agendaId, '现有主目标保留');
  assert.equal(self.data.agenda.find((a) => a.id === other.id)?.status, 'open', '另一个没有生效');
});

test('同一念既要结束目标又给它写清单：结束优先，清单不应用，目标不会被复活', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const { mind, apply } = harness(self);
  mind.inReview = true;
  const d = apply({ done: [plan.agendaId], add: [], drop: [] }, { plan: { focus: plan.agendaId, steps: ['补圆石', '做床'] } });
  assert.match(d.notes.join('；'), /结束优先/);
  assert.equal(d.plan?.steps, undefined, '清单被撤下');
});

test('阶段回顾里换主目标：旧阶段记 switched，新目标成为活跃目标', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('整备基地', ['补圆石'])!;
  const other = self.addAgenda('去下界', 'goal', 'today')!;
  const { mind, apply } = harness(self);
  mind.inReview = true;
  apply({ focus: other.id, done: [], add: [], drop: [] }, { plan: { focus: other.id, steps: ['搭传送门'], switchReason: '基地已够，进入下一阶段' } });
  assert.equal(self.activeAgenda()?.id, other.id);
  assert.equal(self.stages().find((s) => s.goal === plan.goal)?.outcome, 'switched');
});
