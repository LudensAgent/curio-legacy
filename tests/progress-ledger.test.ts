import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { applyProgress, emptyProgressLedger, progressSummary, type ProgressInput } from '../src/mind/progress-ledger.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const base = (overrides: Partial<ProgressInput> = {}): ProgressInput => ({
  targetId: 'po_fort', label: '找到下界要塞',
  at: Date.parse('2026-01-01T00:00:00Z'), dim: 'the_nether',
  start: { x: 0.5, y: 64, z: 0.5 }, end: { x: 16.5, y: 64, z: 0.5 },
  outcome: 'done', summary: '沿北向走了 16 格', durationSec: 60,
  newChunks: 1, visitedCells: 16,
  gained: { netherrack: 6 }, lost: { torch: 2 }, targets: ['ancient_debris'], acquired: false,
  ...overrides,
});

test('换活动名/做法不清目标趋势：空间与最远点累计到同一目标', () => {
  const first = applyProgress(emptyProgressLedger(), base());
  const second = applyProgress(first, base({
    at: Date.parse('2026-01-01T00:10:00Z'), outcome: 'stuck',
    start: { x: 16.5, y: 64, z: 0.5 }, end: { x: 16.5, y: 64, z: 40.5 },
    summary: '沿旧路走到东侧尽头', newChunks: 0, visitedCells: 10, gained: {}, lost: {},
  }));
  const entry = second.entries.po_fort!;
  assert.equal(entry.spatial.newChunks, 1);
  assert.equal(entry.spatial.visitedCells, 26);
  assert.equal(entry.movement.activities, 2);
  assert.ok(entry.spatial.farthest >= 40, '沿同一目标累计最远点');
  assert.equal(entry.spatial.repeatVisits, 0);
  assert.equal(entry.execution.completed, 1);
  assert.equal(entry.execution.blocked, 1);
  assert.equal(entry.execution.reasons.stuck, 1);
});

test('重复到访按区块累计，但副产物不会清空间趋势', () => {
  const first = applyProgress(emptyProgressLedger(), base({ gained: { netherrack: 6 }, targets: [] }));
  const second = applyProgress(first, base({
    at: Date.parse('2026-01-01T00:20:00Z'), start: { x: 20.5, y: 64, z: 1.5 }, end: { x: 2.5, y: 64, z: 2.5 },
    summary: '又走回同一条旧巷', newChunks: 0, gained: { netherrack: 9 }, targets: [],
  }));
  const entry = second.entries.po_fort!;
  assert.equal(entry.spatial.repeatVisits, 1, '同一区块的再次活动记为重复到访');
  assert.equal(entry.spatial.newChunks, 1);
  assert.ok(entry.items.sideProducts.netherrack >= 15, '副产物单独记账');
  assert.equal(entry.spatial.farthest > 0, true, '副产物不清最远点');
});

test('点名目标与副产物分开；acquired 未知时不冒充取得', () => {
  const entry = applyProgress(emptyProgressLedger(), base({
    gained: { netherrack: 6, raw_iron: 2 }, targets: ['iron_ore'], acquired: true,
  })).entries.po_fort!;
  assert.equal(entry.items.explicitTargets.iron_ore, 2, 'raw_iron 计入 iron_ore 目标');
  assert.equal(entry.items.sideProducts.netherrack, 6, '地狱岩只算副产物');
  const unknown = applyProgress(emptyProgressLedger(), base({ targets: ['diamond'], acquired: null, gained: {} })).entries.po_fort!;
  assert.equal(unknown.items.explicitTargets.diamond, 0);
  assert.equal(progressSummary(unknown)?.targets_gained?.diamond, 0);
});

test('SelfModel 保存账本并给出摘要；换目标不覆盖其他目标', () => {
  const self = new SelfModel(null);
  self.recordProgress(base());
  self.recordProgress(base({ targetId: 'po_food', label: '备好食物', at: Date.parse('2026-01-01T00:05:00Z'), gained: { cooked_beef: 3 }, targets: ['cooked_beef'], acquired: true }));
  assert.equal(self.progressLedger('po_fort')?.movement.activities, 1);
  assert.equal(self.progressLedger('po_food')?.items.explicitTargets.cooked_beef, 3);
  assert.equal(self.progressSummary('po_fort')?.farthest, 16);
  assert.equal(self.progressSummary('missing'), null);
  assert.equal(self.progressLedger() .entries.po_food?.label, '备好食物');
});

test('提示词只投影当前目标摘要；详情留在按需查询的账本里', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null])!;
  const outcomeId = plan.steps[0]!.id;
  self.recordProgress(base({ targetId: outcomeId, label: plan.goal }));
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  const [, user] = buildMindMessages({
    tier: 'deliberate', reason: '测试', percept, state, self, memory, plan, activity: null,
    suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', lastRecord: null,
  } as any);
  assert.match(user.content, /progress_trend/);
  assert.match(user.content, /repeat_visits/);
  assert.match(user.content, /net_displacement/);
  assert.doesNotMatch(user.content, /"regions"/, '摘要不展开逐区块历史');
  assert.ok(self.progressLedger(outcomeId)?.spatial.regions.length, '详情账本仍可按需查');
});

test('A→B→A 的往返按真实回程记重复到访，而不是只看连续前进', () => {
  const at = (x: number) => ({ x, y: 64, z: 0.5 });
  let ledger = applyProgress(emptyProgressLedger(), base({ targetId: 'po_lane', start: at(0.5), end: at(32.5), gained: {}, targets: [] }));
  ledger = applyProgress(ledger, base({ targetId: 'po_lane', at: Date.parse('2026-01-01T00:10:00Z'), start: at(32.5), end: at(0.5), gained: {}, targets: [] }));
  ledger = applyProgress(ledger, base({ targetId: 'po_lane', at: Date.parse('2026-01-01T00:20:00Z'), start: at(0.5), end: at(32.5), gained: {}, targets: [] }));
  const entry = ledger.entries.po_lane!;
  assert.equal(entry.spatial.repeatVisits, 2, '每次走回已到过的区块都记一次');
  assert.equal(entry.movement.activities, 3);
});

test('24 格本来就能走的已知通路只记覆盖/通行，不冒充新通道或目标进展', () => {
  const entry = applyProgress(emptyProgressLedger(), base({
    outcome: 'done', summary: '24 格里挖掉 0 块、补了 0 处支撑、24 格本来就能直接走',
    newChunks: 0, visitedCells: 25, gained: {}, lost: {},
    targets: ['nether_bricks'], acquired: false, located: false, found: [],
    work: { dug: 0, filled: 0, openSteps: 24 },
  })).entries.po_fort!;
  assert.deepEqual(entry.passage, { dug: 0, filled: 0, openSteps: 24 });
  assert.equal(entry.targetEvidence.located, false);
  assert.deepEqual(entry.targetEvidence.found, []);
  assert.equal(entry.items.explicitTargets.nether_bricks, 0);
  const summary = progressSummary(entry)!;
  assert.deepEqual(summary.passage, { dug: 0, filled: 0, openSteps: 24 });
  assert.equal(summary.target_evidence?.located, false);
  assert.match(summary.coverage_note, /移动覆盖/);
  assert.equal(summary.activities, 1, '覆盖仍然记录，但与目标证据分开');
});

test('真正挖开/补支撑的尝试在 passage 里单独累计', () => {
  const first = applyProgress(emptyProgressLedger(), base({ work: { dug: 6, filled: 2, openSteps: 4 } }));
  const second = applyProgress(first, base({ work: { dug: 3, filled: 1, openSteps: 10 } }));
  assert.deepEqual(second.entries.po_fort!.passage, { dug: 9, filled: 3, openSteps: 14 });
});

test('提示词把移动覆盖与施工/目标证据分开投影，并带出最近尝试证据', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const plan = self.setPlan('找到下界要塞', ['找到下界要塞'], [null], { methods: [{ text: '沿北向开平巷', outcome: 0 }] })!;
  const outcomeId = plan.steps[0]!.id, methodId = plan.methods![0]!.id;
  const evidence = { dug: 0, filled: 0, openSteps: 24, newChunks: 0, visitedCells: 25, maxHorizontal: 24, found: [], located: false, acquired: false };
  self.recordProgress(base({ targetId: outcomeId, label: plan.goal, work: { dug: 0, filled: 0, openSteps: 24 }, newChunks: 0, visitedCells: 25, targets: ['nether_bricks'], acquired: false, located: false, found: [] }));
  self.recordPlanAttempt({ outcomeId, methodId, whatHappened: '沿已知通道走 24 格', whyStopped: 'done', evidence });
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  const [, user] = buildMindMessages({
    tier: 'deliberate', reason: '测试', percept, state, self, memory, plan, activity: null,
    suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', lastRecord: null,
  } as any);
  assert.match(user.content, /"passage":\{"dug":0,"filled":0,"openSteps":24\}/);
  assert.match(user.content, /"target_evidence":\{"located":false,"acquired":false\}/);
  assert.match(user.content, /coverage_note/);
  assert.match(user.content, /挖0\/补0\/原通24/);
  assert.match(user.content, /目标未定位/);
});
