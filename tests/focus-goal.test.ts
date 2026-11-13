import { Mind } from '../src/mind/mind.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attention } from '../src/mind/attention.ts';
import { PLAN_REVISION_MIN, SelfModel } from '../src/mind/self.ts';

const reflection = (agendaDrop: string[]) => ({ rewrite: [], merge: [], drop: [], add: [], agendaDrop });

/** applyPlan 的最小心智壳：只接 self/bus，让测试直接检查清单改写的实际结果。 */
const applyPlanHarness = (self: SelfModel) => {
  const events: string[] = [];
  const bus = { publish: (type: string) => { events.push(type); } };
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

test('回想不能顺手收掉正在推进的主目标：留着、说出来；重复的点子照常收掉', () => {
  const self = new SelfModel(null);
  const goal = self.addAgenda('攒够铁做一整套铁盔甲', 'goal', 'someday')!;
  assert.ok(self.setPlan(goal.id, ['做铁胸甲', '做铁护腿', '做铁头盔']));
  const a = self.addAgenda('在常去的矿口搭一个前哨小窝', 'idea', 'today')!;
  const b = self.addAgenda('在矿口做个箱子存碎石', 'idea', 'today')!;
  const r = self.consolidate(reflection([goal.id, a.id, b.id]) as any);
  assert.deepEqual(r.keptGoals, [{ id: goal.id, text: '攒够铁做一整套铁盔甲' }]);
  // agenda() 只列没放下的
  const listed = (id: string) => self.agenda().some((x) => x.id === id);
  assert.ok(!listed(a.id) && !listed(b.id), '重复的点子收掉了');
  assert.ok(listed(goal.id), '主目标还在');
  assert.equal(self.plan()?.agendaId, goal.id, '主目标和清单都还在');
  // 不在推进中的旧目标，回想照常可以收
  const old = self.addAgenda('挖个封闭小窝撑到天亮', 'goal', 'today')!;
  assert.deepEqual(self.consolidate(reflection([old.id]) as any).keptGoals, []);
  assert.ok(!listed(old.id));
  // 心智会注意到
  const n = new Attention().fromEvent({ type: 'goal_kept', ts: Date.now(), severity: 'P3', msg: '回想时觉得主目标「攒够铁做一整套铁盔甲」可以放下了', data: { agendaId: goal.id } } as any);
  assert.match(n!.what, /可以放下了/);
});

test('认真想时明确把某个点子定成主目标、写了清单：升成目标；没明确选、或者没写清单的不升', () => {
  const self = new SelfModel(null);
  const idea = self.addAgenda('在常去的矿口搭常驻前哨：床、工作台、箱子', 'idea', 'today')!;
  assert.equal(self.setPlan(idea.id, ['搭前哨', '备好备用石镐']), null, '沿用手上的活顺带的点子不会自己变成目标');
  assert.equal(self.setPlan(idea.id, [], [], { promote: true }), null, '没写清单不算决定要做');
  const set = self.setPlan(idea.id, ['在矿口放床、工作台、箱子', '箱子里存备用石镐和火把'], [], { promote: true });
  assert.ok(set);
  assert.equal(set!.goal, '在常去的矿口搭常驻前哨：床、工作台、箱子');
  assert.equal(self.agenda().find((x) => x.id === idea.id)?.kind, 'goal');
  // 一句话的目标照旧：新建一个目标
  assert.ok(self.setPlan('做一套铁盔甲', ['烧铁', '做头盔']));
});

test('主目标是阶段成果：还在推进时，眼前的事顶替不了它；认真想写了理由、操作者下令、或同时放下旧目标才换', () => {
  const self = new SelfModel(null);
  const armour = self.setPlan('穿上一整套铁甲', ['挖够粗铁', '烧成铁锭', '做胸甲和护腿', '做头盔和靴子'])!;
  const goalId = armour.agendaId;
  const night = '先安全过夜，天亮再回地面清包备料';
  const refusal = self.goalSwitchRefusal(night, { deliberate: false });
  assert.match(refusal ?? '', /尚未完成.*detour/);
  assert.match(self.goalSwitchRefusal(night, { deliberate: true }) ?? '', /switch_reason/, '认真想但没写理由也不换');
  assert.equal(self.goalSwitchRefusal(night, { deliberate: false, reason: '想换' }) !== null, true, '瞥一眼写了理由也不换');
  // 刚还在推进：认真想、写了理由，一时的想法也顶不掉主目标；只有停下来回顾阶段目标时才换，时间停滞不算
  assert.match(self.goalSwitchRefusal('先吃口东西保命', { deliberate: true, reason: '血太少' }) ?? '', /一时的想法不换主目标.*agenda/);
  assert.equal(self.goalSwitchRefusal('去下界', { deliberate: true, reason: '铁甲已经够用，下一阶段去下界', review: true }), null);
  assert.notEqual(self.goalSwitchRefusal('去下界', { deliberate: false, reason: '铁甲已经够用', review: true }), null, '回顾也要认真想');
  self.data.plan!.stalledOnlineMs = (SelfModel.STALL_MIN + 1) * 60_000;
  self.data.plan!.stalledObservedSince = Date.now() - self.data.plan!.stalledOnlineMs;
  self.data.plan!.stalledHistoryUnknown = false;
  assert.notEqual(self.goalSwitchRefusal('去下界', { deliberate: true, reason: '铁甲这条卡了很久' }), null, '单纯停滞不授权换主目标');
  self.data.plan!.progressAt = Date.now();
  assert.equal(self.goalSwitchRefusal(night, { deliberate: false, operator: true }), null);
  assert.equal(self.goalSwitchRefusal(night, { deliberate: false, releasing: [goalId] }), null);
  // 改写自己的清单不算换
  assert.equal(self.goalSwitchRefusal(goalId, { deliberate: false }), null);
  assert.equal(self.goalSwitchRefusal('穿上一整套铁甲', { deliberate: false }), null);
  // 清单都勾完了，可以定下一个
  self.checkPlan([0, 1, 2, 3]);
  assert.equal(self.goalSwitchRefusal(night, { deliberate: false }), null);
});

test('清单改写要理由和冷却；停滞不是删项理由；瞥一眼不改成果清单；换做法与勾项照常', () => {
  const self = new SelfModel(null), events: string[] = [];
  const bus = { publish: (type: string) => { events.push(type); } };
  const mind = Object.create(Mind.prototype) as any;
  mind.d = { self, bus, adapter: { state: () => ({}) }, perception: { snapshot: () => undefined } };
  mind.safe = (f: () => unknown) => f();
  const apply = (plan: object, tier: 'glance' | 'deliberate' = 'deliberate') => { const d = { plan, tier, notes: [] as string[] }; mind.applyPlan(d); return d; };
  apply({ focus: '开一条固定矿道', steps: ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼'] });
  const id = self.plan()!.agendaId;
  self.setOnline(true, Date.now());
  self.data.plan!.progressAt = Date.now() - 40 * 60_000;
  self.data.plan!.stalledOnlineMs = 40 * 60_000;
  self.data.plan!.stalledObservedSince = Date.now() - 40 * 60_000;
  self.data.plan!.stalledHistoryUnknown = false;
  assert.ok(self.planStalledMin() >= 40, '测试确实处在停滞中');
  const stale = self.data.plan!.progressAt;
  // 停滞后、没写理由：拒绝（停滞不再是删项许可）
  let d = apply({ steps: ['拿到石镐走出矿道', '回地面冶炼'] });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼'], '没改');
  assert.match(d.notes.join(), /switch_reason[\s\S]*detour/);
  assert.ok(events.includes('plan_rewrite_refused'));
  // 瞥一眼即使写了理由：也不改成果清单
  d = apply({ steps: ['拿到石镐走出矿道'], switchReason: '真的' }, 'glance');
  assert.equal(self.plan()!.steps.length, 3, '瞥一眼不改成果清单');
  // 瞥一眼只加一项也不行：清单变化统一留给认真想
  d = apply({ steps: ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼', '顺手捡圆石'] }, 'glance');
  assert.equal(self.plan()!.steps.length, 3, '瞥一眼不加项');
  assert.match(d.notes.join(), /瞥一眼不改成果清单/);
  // 加项不删旧的：可以
  apply({ steps: ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼', '矿口放箱子'] });
  assert.equal(self.plan()!.steps.length, 4);
  assert.equal(self.plan()!.progressAt, stale, '改写清单不算推进');
  // 原样重写：不发 plan_set
  const n = events.filter((e) => e === 'plan_set').length;
  apply({ steps: ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼', '矿口放箱子'] });
  assert.equal(events.filter((e) => e === 'plan_set').length, n);
  // 认真想、写了理由：可以改
  apply({ steps: ['在 y-10 深板岩层推平巷', '挖到 3 块粗铁', '回地面冶炼'], switchReason: 'y30 这一片挖了 40 格没见铁，换到更深的层' });
  assert.equal(self.plan()!.steps[0].text, '在 y-10 深板岩层推平巷');
  assert.equal(self.plan()!.agendaId, id);
  // 刚改过的清单要试满 PLAN_REVISION_MIN 才能再删改：紧接着再写理由也拒绝
  d = apply({ steps: ['换一条巷', '挖到 3 块粗铁', '回地面冶炼'], switchReason: '刚又想到一条' });
  assert.match(d.notes.join(), /还没试满/);
  assert.equal(self.plan()!.steps[0].text, '在 y-10 深板岩层推平巷', '冷却期内不改清单');
  // 过了冷却：写理由可以改
  self.data.plan!.revisedAt = [Date.now() - PLAN_REVISION_MIN * 60_000];
  apply({ steps: ['换一条巷', '挖到 3 块粗铁', '回地面冶炼'], switchReason: '上一版试满了，这一带确实没铁' });
  assert.equal(self.plan()!.steps[0].text, '换一条巷');
  // 勾项照常（瞥一眼就可以）
  const stepsBefore = self.plan()!.steps.length;
  apply({ done: [1] }, 'glance');
  assert.equal(self.plan()!.steps.length, stepsBefore);
  assert.equal(self.plan()!.steps[1].done, true);
  assert.notEqual(self.plan()!.progressAt, stale, '勾掉一项才算推进');
  // 阶段回顾、操作者指令不受冷却限制
  self.data.plan!.revisedAt = [Date.now()];
  mind.inReview = true;
  apply({ steps: ['回顾后的新成果', '回地面冶炼'] });
  assert.equal(self.plan()!.steps[0].text, '回顾后的新成果', '阶段回顾可以直接改');
  mind.inReview = false;
  // 冷却已过，只挂着一道旧指令、这一念没有回应它：仍按普通删改拒绝。
  self.data.plan!.revisedAt = [Date.now() - PLAN_REVISION_MIN * 60_000];
  mind.order = { text: '换清单', at: Date.now(), status: 'doing' as const, nudged: 0, kind: 'order' as const };
  d = apply({ steps: ['回顾后的新成果'] });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['回顾后的新成果', '回地面冶炼'], '挂着的旧指令不放行');
  assert.match(d.notes.join(), /switch_reason/);
  // 这一念明确回应了指令：按操作者指令放行。
  const ordered = { plan: { steps: ['指令后的新成果'] }, tier: 'deliberate', notes: [] as string[], operator: { status: 'doing' as const } };
  mind.applyPlan(ordered);
  assert.equal(self.plan()!.steps[0].text, '指令后的新成果', '这一念回应了操作者指令：可以直接改');
  delete mind.order;
});

test('删掉未完成项的那一念不自动完成主目标；之后勾完剩余项才收工', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('修好矿道', ['修好入口', '清理碎石'])!;
  self.checkPlan([0]);
  const { apply, events } = applyPlanHarness(self);
  const d = apply({ steps: ['修好入口'], done: [0], switchReason: '碎石这条已经证明不必要，改做入口加固' });
  assert.equal(self.activeAgenda()?.id, plan.agendaId, '主目标仍在推进');
  assert.ok(self.plan(), '主目标清单还在');
  assert.match(d.notes.join(), /清单改写/);
  assert.ok(!events.includes('plan_done'), '删项那一念不自动收工');
  // 下一念明确勾掉剩余项：正常完成
  apply({ done: [0] });
  assert.ok(events.includes('plan_done'), '明确勾完才收工');
  assert.equal(self.plan(), null);
});

test('普通勾完仍然完成主目标', () => {
  const self = new SelfModel(null);
  self.setPlan('修好矿道', ['修好入口', '清理碎石']);
  const { apply, events } = applyPlanHarness(self);
  apply({ done: [0, 1] });
  assert.ok(events.includes('plan_done'), '普通勾完要能完成主目标');
  assert.equal(self.plan(), null);
});

test('清单改写的冷却按上次改写时间：刚改过就拒绝，满 15 分钟才放开', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('修好矿道', ['修好入口', '清理碎石'])!;
  const { apply, events } = applyPlanHarness(self);
  apply({ steps: ['修好入口'], switchReason: '碎石这条已经证明不必要' });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['修好入口']);
  // 加项不占用删改冷却：补一项新的工作随时可以
  apply({ steps: ['修好入口', '在矿口放箱子'] });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['修好入口', '在矿口放箱子']);
  assert.equal(self.plan()!.revisedAt?.length, 1, '加项不记改写时间');
  const refused = events.filter((e) => e === 'plan_rewrite_refused').length;
  apply({ steps: ['加固入口'], switchReason: '再换一种说法' });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['修好入口', '在矿口放箱子'], '冷却期内不改');
  assert.equal(events.filter((e) => e === 'plan_rewrite_refused').length, refused + 1);
  self.data.plan!.revisedAt = [Date.now() - PLAN_REVISION_MIN * 60_000];
  apply({ steps: ['加固入口'], switchReason: '上一版试满了' });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['加固入口'], '满 15 分钟后放开');
  assert.equal(self.plan()!.agendaId, plan.agendaId, '主目标不变');
});
