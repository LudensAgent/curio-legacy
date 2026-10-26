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
