import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InvItem } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { budgetFacts } from '../src/brain/supply.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { parsePlan } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('plan.needs：Agent 写的预算持久化；不改写法时保留；显式空数组清空', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('备木头再进下界', ['备好木头'], [], { needs: [{ item: 'oak_log', count: 16, why: '工作台+工具+火把' }] })!;
  assert.deepEqual(plan.needs, [{ item: 'oak_log', count: 16, why: '工作台+工具+火把' }]);
  const kept = self.setPlan(plan.agendaId, ['备好木头'])!;
  assert.deepEqual(kept.needs, plan.needs, '只改清单/做法不丢预算');
  const replaced = self.updatePlanNeeds([{ item: 'coal', count: 8, why: '照明' }])!;
  assert.deepEqual(replaced.needs, [{ item: 'coal', count: 8, why: '照明' }]);
  self.updatePlanNeeds([]);
  assert.equal(self.plan()?.needs, undefined, '显式清空');
  const cleared = self.setPlan(plan.agendaId, ['备好木头'], [], { needs: [] })!;
  assert.equal(cleared.needs, undefined, 'setPlan 显式空数组清空');
  const capped = self.setPlan(plan.agendaId, ['备好木头'], [], { needs: [{ item: 'oak_log', count: 99999 }] })!;
  assert.equal(capped.needs?.[0]?.count, 2304, '数量上限');
});

test('budgetFacts：按配方与背包算差额，不自动改采集数量', () => {
  const inv: InvItem[] = [{ name: 'oak_log', count: 2 }];
  const facts = budgetFacts([{ item: 'oak_log', count: 16, why: '工具/火把' }], inv);
  assert.equal(facts.length, 1);
  assert.match(facts[0], /oak_log×16/);
  assert.match(facts[0], /还差/);
  assert.match(facts[0], /oak_log×14/);
  const enough = budgetFacts([{ item: 'oak_log', count: 2 }], inv);
  assert.match(enough[0], /材料已经够了/);
});

test('budgetFacts：前一项消耗共享库存，后一项按剩余算', () => {
  const inv: InvItem[] = [{ name: 'oak_log', count: 4 }];
  const facts = budgetFacts([{ item: 'oak_log', count: 2 }, { item: 'oak_log', count: 4 }], inv);
  assert.match(facts[0], /材料已经够了/);
  assert.match(facts[1], /现有 2/);
  assert.match(facts[1], /还差/);
  assert.match(facts[1], /oak_log×2/);
});

test('parsePlan 只解析 needs 形状；空项由 setPlan 的 cleanNeeds 过滤', () => {
  const valid = { item: 'oak_log', count: 16, why: '工具' };
  const p = parsePlan({ focus: 'a_x', steps: ['备木头'], needs: [valid, { item: '', count: 2 }] });
  assert.equal(p?.needs?.length, 2, 'parse 只做形状');
  const self = new SelfModel(null);
  const stored = self.setPlan('备木头', ['备木头'], [], { needs: p!.needs! })!;
  assert.deepEqual(stored.needs, [valid], '存储边界过滤空项');
  const only = parsePlan({ focus: 'a_x', needs: [{ item: 'coal', count: 8 }] });
  assert.deepEqual(only?.needs, [{ item: 'coal', count: 8 }]);
  const empty = parsePlan({ focus: 'a_x', needs: [] });
  assert.deepEqual(empty?.needs, [], '空数组表示显式清空，不是省略');
});

test('applyPlan：needs 只更新预算，不改清单/做法', () => {
  const self = new SelfModel(null);
  const plan = self.setPlan('备木头再进下界', ['备好木头'], [], { needs: [{ item: 'oak_log', count: 8 }] })!;
  const mind = Object.create(Mind.prototype) as Mind;
  const harness = mind as unknown as { d: unknown; safe: <T>(f: () => T) => T; applyPlan: (decision: unknown) => void };
  harness.d = { self, bus: { publish: () => {} }, adapter: { state: () => ({}) }, perception: { snapshot: () => undefined } };
  harness.safe = (f) => f();
  harness.applyPlan({ plan: { focus: plan.agendaId, needs: [{ item: 'coal', count: 8, why: '照明' }] }, tier: 'deliberate', notes: [] });
  assert.deepEqual(self.plan()?.needs, [{ item: 'coal', count: 8, why: '照明' }]);
  assert.deepEqual(self.plan()?.steps.map((st) => st.text), ['备好木头']);
});

test('needs 跨重启保留', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curio-budget-')), 'self.json');
  const a = new SelfModel(file);
  a.setPlan('备木头再进下界', ['备好木头'], [], { needs: [{ item: 'oak_log', count: 16 }] });
  a.close();
  const b = new SelfModel(file);
  assert.deepEqual(b.plan()?.needs, [{ item: 'oak_log', count: 16 }]);
  b.close();
});

test('【专注】展示 material_budget：需要/现有/还差，并标明数量由 Agent 定', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const plan = self.setPlan('备木头再进下界', ['备好木头'], [], { needs: [{ item: 'oak_log', count: 16, why: '工具/火把' }] })!;
  adapter.inv.set('oak_log', 2);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null,
    audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /material_budget/);
  assert.match(user.content, /oak_log×16/);
  assert.match(user.content, /还差/);
  assert.match(user.content, /数量写在 count 里/);
});
