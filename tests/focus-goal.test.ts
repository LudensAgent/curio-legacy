import { Mind } from '../src/mind/mind.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attention } from '../src/mind/attention.ts';
import { SelfModel } from '../src/mind/self.ts';

const reflection = (agendaDrop: string[]) => ({ rewrite: [], merge: [], drop: [], add: [], agendaDrop });

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
  // 刚还在推进：认真想、写了理由，一时的想法也顶不掉主目标；停下来回顾阶段目标时、或主目标停滞了才换
  assert.match(self.goalSwitchRefusal('先吃口东西保命', { deliberate: true, reason: '血太少' }) ?? '', /一时的想法不换主目标.*agenda/);
  assert.equal(self.goalSwitchRefusal('去下界', { deliberate: true, reason: '铁甲已经够用，下一阶段去下界', review: true }), null);
  assert.notEqual(self.goalSwitchRefusal('去下界', { deliberate: false, reason: '铁甲已经够用', review: true }), null, '回顾也要认真想');
  self.data.plan!.stalledOnlineMs = (SelfModel.STALL_MIN + 1) * 60_000;
  self.data.plan!.stalledObservedSince = Date.now() - self.data.plan!.stalledOnlineMs;
  self.data.plan!.stalledHistoryUnknown = false;
  assert.equal(self.goalSwitchRefusal('去下界', { deliberate: true, reason: '铁甲这条卡了很久' }), null, '主目标停滞了，认真想写了理由就能换');
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

test('清单不随眼前的事改：没做完的项不能被顶掉；认真想写了理由才改；加项、原样重写都行，改写不算推进', () => {
  const self = new SelfModel(null), events: string[] = [];
  const bus = { publish: (type: string) => { events.push(type); } };
  const mind = Object.create(Mind.prototype) as any;
  mind.d = { self, bus, adapter: { state: () => ({}) }, perception: { snapshot: () => undefined } };
  mind.safe = (f: () => unknown) => f();
  const apply = (plan: object, tier: 'glance' | 'deliberate' = 'deliberate') => { const d = { plan, tier, notes: [] as string[] }; mind.applyPlan(d); return d; };
  apply({ focus: '开一条固定矿道', steps: ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼'] });
  const id = self.plan()!.agendaId;
  self.data.plan!.progressAt = Date.now() - 40 * 60_000;
  const stale = self.data.plan!.progressAt;
  // 镐坏了被困住：想把清单换成脱困的眼前事
  let d = apply({ steps: ['拿到石镐走出矿道', '回地面冶炼'] });
  assert.deepEqual(self.plan()!.steps.map((s) => s.text), ['在 y30 推平巷插火把', '挖到 3 块粗铁', '回地面冶炼'], '没改');
  assert.match(d.notes.join(), /switch_reason[\s\S]*detour/);
  assert.ok(events.includes('plan_rewrite_refused'));
  d = apply({ steps: ['拿到石镐走出矿道'] , switchReason: '真的' }, 'glance');
  assert.equal(self.plan()!.steps.length, 3, '瞥一眼不改清单');
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
  // 勾项照常
  apply({ done: [1] }, 'glance');
  assert.equal(self.plan()!.steps[1].done, true);
  assert.notEqual(self.plan()!.progressAt, stale, '勾掉一项才算推进');
});
