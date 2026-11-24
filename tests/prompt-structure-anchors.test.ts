import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { structureCoordinateConflicts } from '../src/mind/coordinates.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const anchor = { id: 'dis_p8iser', label: '下界要塞（暗红砖）', dim: 'the_nether', pos: { x: 219, y: 60, z: -224 } };

function buildRememberedSection(t: TestContext, planText: string,
  opts: { methodText?: string; stepText?: string; tier?: 'deliberate' | 'glance' } = {}) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null, { worldId: 'fake-world' }), bus = new EventBus();
  t.after(() => memory.close());
  adapter.worldId = 'fake-world';
  adapter.dim = 'the_nether';
  adapter.pos = { x: 200.5, y: 60, z: -220.5 };
  memory.addLandmark('discovery', anchor.label, anchor.dim, anchor.pos, 32);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state(), self = new SelfModel(null);
  const agenda = self.addAgenda(planText, 'goal', 'today');
  assert.ok(agenda);
  const plan = self.setPlan(agenda.id, [opts.stepText ?? '在要塞打烈焰人'], [],
    opts.methodText ? { methods: [{ text: opts.methodText }] } : {});
  assert.ok(plan);
  const [, user] = buildMindMessages({ tier: opts.tier ?? 'deliberate', reason: '查看地标', percept, state, self, memory, plan, activity: null,
    recentActionFailures: [], suspended: [], lastRecord: null, noticed: [], changes: [],
    userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  const line = user.content.split('\n').find((entry) => entry.startsWith('【记得的地方】'))!;
  return { section: JSON.parse(line.slice('【记得的地方】'.length)), self };
}

test('结构锚点冲突只报告事实与来源，不改写计划坐标', (t) => {
  const { section, self } = buildRememberedSection(t, '进已找到的下界要塞 (128,44,-223) 打烈焰人，凑够至少 6 根烈焰棒', { methodText: '朝 (128,44,-223) 推进' });
  assert.match(section.known_structures[0], /\[dis_[a-z0-9]+\] 锚点/);
  assert.match(section.known_structures_note, /travel_to 可直接把 \[id\] 当作 to/);
  assert.equal(section.structure_coordinate_conflicts.length, 1);
  assert.match(section.structure_coordinate_conflicts[0], /\(128,44,-223\)/);
  assert.match(section.structure_coordinate_conflicts[0], /\(219,60,-224\)/);
  assert.match(section.structure_coordinate_conflicts[0], /\[dis_[a-z0-9]+\]（the_nether）/);
  assert.match(section.structure_coordinate_conflicts[0], /plan\.goal、agenda a_/);
  assert.match(self.data.plan!.goal, /\(128,44,-223\)/, '只列冲突，不擅自改写 Agent 的目标');
});

test('瞥一眼也能看到结构锚点与冲突', (t) => {
  const { section } = buildRememberedSection(t, '进已找到的下界要塞 (128,44,-223) 打烈焰人', { tier: 'glance' });
  assert.match(section.known_structures[0], /锚点/);
  assert.equal(section.structure_coordinate_conflicts.length, 1);
});

test('计划坐标与锚点同点时不报冲突', (t) => {
  const { section } = buildRememberedSection(t, '进已找到的下界要塞 (222,60,-226) 打烈焰人');
  assert.equal(section.structure_coordinate_conflicts, undefined, '同一点不产生冲突');
});

test('未完成的计划步骤和启用中的做法也参与坐标冲突', (t) => {
  const { section } = buildRememberedSection(t, '打烈焰人', {
    stepText: '去下界要塞 (128,44,-223) 打', methodText: '朝下界要塞 (128,44,-223) 推进',
  });
  assert.equal(section.structure_coordinate_conflicts.length, 1);
  assert.match(section.structure_coordinate_conflicts[0], /plan\.step、plan\.method/);
});

test('冲突检测按结构标签匹配，三维距离和远景坐标都不被静默丢掉', () => {
  const conflicts = structureCoordinateConflicts([anchor], [
    { source: 'plan.goal', text: '去下界要塞 (128,44,-223) 打烈焰人' },
    { source: 'plan.goal', text: '去下界要塞 (1000,60,-1000) 看看' },
    { source: 'plan.goal', text: '去下界要塞 (219,200,-224) 看看' },
    { source: 'plan.method', text: '朝 (219,60,-224) 出发' },
    { source: 'plan.step', text: '去 (100,60,-200) 拿木头' },
  ]);
  assert.equal(conflicts.length, 3, '同标签下的远景、垂直差都列出；无结构标签的坐标不误报');
  assert.deepEqual(conflicts.map((conflict) => conflict.referenced), [
    { x: 1000, y: 60, z: -1000 },
    { x: 219, y: 200, z: -224 },
    { x: 128, y: 44, z: -223 },
  ]);
  assert.ok(conflicts.every((conflict) => conflict.sources.every((source) => source === 'plan.goal')));
});
