import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { ProjectCoordinator } from '../src/projects/coordinator.ts';
import { evaluateCondition, validateCondition } from '../src/projects/conditions.ts';
import { validateIntentDecision } from '../src/intentions/decision.ts';
import type { Condition } from '../src/projects/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const inventory = (item: string, count: number): Condition => ({ type: 'inventory_min', item, count });
function fixture(file: string | null = null) {
  const memory = new WorldMemory(file);
  const adapter = new FakeAdapter();
  memory.setWorld(adapter.worldId);
  const coordinator = new ProjectCoordinator(memory, adapter);
  const intent = memory.addIntent({ text: '看看当地石材适不适合做小雕塑', whyNow: '河边发现了新岩层', context: ['河岸观察'], tradeoffs: ['先取样而不规定建筑风格'], status: 'active', source: 'model' });
  return { memory, adapter, coordinator, intent };
}

test('facts use complete inventory and one snapshot; disconnected, dead and not ready are unknown', () => {
  const { memory, adapter } = fixture();
  adapter.inv = new Map([...Array.from({ length: 50 }, (_, i) => [`misc_${i}`, 1] as [string, number]), ['cobblestone', 16]]);
  const condition: Condition = { type: 'all_of', conditions: [inventory('cobblestone', 16), { type: 'location_near', dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, radius: 1 }] };
  const state = adapter.state();
  assert.equal(evaluateCondition(condition, state).status, 'satisfied');
  adapter.inv.clear(); // The old immutable snapshot remains authoritative for its own observation.
  assert.equal(evaluateCondition(condition, state).status, 'satisfied');
  assert.equal(evaluateCondition(condition, adapter.state()).status, 'unsatisfied');
  for (const change of [{ connected: false }, { alive: false }, { observationReady: false }, { worldId: 'other' }]) {
    assert.equal(evaluateCondition(condition, { ...state, ...change }, 'fake-world').status, 'unknown');
  }
  memory.close();
});

test('conditions reject invented items, coordinates, excessive nesting and invalid numbers', () => {
  const { memory, adapter } = fixture();
  const registry = { isKnownItem: (name: string) => ['stone', 'cobblestone'].includes(name) };
  assert.throws(() => validateCondition(inventory('invented_material', 1), registry, memory, adapter.state()), /未知物品/);
  for (const count of [0, -1, 1.5, Infinity, NaN, 2305]) assert.throws(() => validateCondition(inventory('stone', count), registry, memory, adapter.state()));
  assert.throws(() => validateCondition({ type: 'location_near', dimension: 'overworld', pos: { x: 999, y: 64, z: 999 }, radius: 2 }, registry, memory, adapter.state()), /可信记忆/);
  memory.setBase('overworld', { x: 100, y: 64, z: 0 });
  assert.equal(validateCondition({ type: 'location_near', dimension: 'overworld', pos: { x: 100, y: 64, z: 0 }, radius: 3 }, registry, memory, adapter.state()).type, 'location_near');
  assert.throws(() => validateCondition({ type: 'all_of', conditions: [] }, registry, memory, adapter.state()));
  let nested: unknown = inventory('stone', 1);
  for (let i = 0; i < 6; i++) nested = { type: 'all_of', conditions: [nested] };
  assert.throws(() => validateCondition(nested, registry, memory, adapter.state()));
  memory.close();
});

test('skill success with partial material does not complete a project; stale chests never supply current inventory', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  memory.setChest('overworld', adapter.pos, [{ name: 'cobblestone', count: 64 }]);
  const project = coordinator.create({ intentId: intent.id, title: '采样', successCondition: inventory('cobblestone', 16) });
  adapter.inv.set('cobblestone', 4);
  assert.equal(coordinator.reconcile()?.status, 'active');
  assert.equal(memory.evidence().at(-1)?.status, 'unsatisfied');
  adapter.inv.set('cobblestone', 16);
  assert.equal(coordinator.reconcile()?.status, 'completed');
  assert.equal(memory.projects()[0].revision, project.revision);
  memory.close();
});

test('milestone evidence remains historical after crafting consumes inputs, while final possession is current', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  coordinator.create({ intentId: intent.id, title: '比较石材的加工结果', successCondition: inventory('stone_bricks', 4), milestones: [{ title: '取样四块石头', condition: inventory('stone', 4) }, { title: '加工成砖', condition: inventory('stone_bricks', 4) }] });
  adapter.inv.set('stone', 4);
  assert.equal(coordinator.reconcile()?.currentMilestone, 1);
  const historic = memory.projects()[0].milestones[0].evidenceId;
  adapter.inv.clear();
  coordinator.reconcile();
  assert.equal(memory.projects()[0].milestones[0].evidenceId, historic);
  assert.equal(memory.evidence().find((e) => e.id === historic)?.status, 'satisfied');
  assert.equal(memory.projects()[0].status, 'active');
  adapter.inv.set('stone_bricks', 4);
  assert.equal(coordinator.reconcile()?.status, 'completed');
  memory.close();
});

test('three actual attempts without progress block, while interruption and waits do not count and measured progress resets', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  coordinator.create({ intentId: intent.id, title: '取样', successCondition: inventory('stone', 16) });
  coordinator.reconcile();
  coordinator.recordAttempt({ executed: false });
  coordinator.recordAttempt({ executed: true, cancelled: true });
  coordinator.recordAttempt({ executed: true, interrupted: true });
  assert.equal(memory.projects()[0].noProgressAttempts, 0);
  coordinator.recordAttempt({ executed: true });
  coordinator.recordAttempt({ executed: true });
  adapter.inv.set('stone', 2);
  assert.equal(coordinator.recordAttempt({ executed: true })?.noProgressAttempts, 0);
  coordinator.recordAttempt({ executed: true });
  coordinator.recordAttempt({ executed: true });
  assert.equal(coordinator.recordAttempt({ executed: true })?.status, 'blocked');
  assert.equal(coordinator.isBindingCurrent(coordinator.currentBinding()), false);
  memory.close();
});

test('pause reasons are independent, user pause needs its own explicit resume and checkpoints never change revision', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  coordinator.create({ intentId: intent.id, title: '取样', successCondition: inventory('stone', 16) });
  const binding = coordinator.currentBinding();
  coordinator.pause('user');
  coordinator.pause('reflex');
  coordinator.resume('reflex');
  assert.equal(memory.activeProject()?.status, 'paused');
  assert.deepEqual(memory.activeProject()?.pauseReasons, ['user']);
  assert.equal(coordinator.isBindingCurrent(binding), false);
  coordinator.resume('user');
  assert.equal(coordinator.isBindingCurrent(binding), true);
  assert.equal(memory.activeProject()?.revision, 1);
  adapter.connected = false;
  coordinator.pause('disconnected');
  coordinator.resume('disconnected');
  assert.equal(memory.activeProject()?.status, 'paused');
  memory.close();
});

test('decision validation has no side effects, preference provenance is enforced and subjective completion cannot fabricate a fact', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  coordinator.create({ intentId: intent.id, title: '取样', successCondition: inventory('stone', 16) });
  assert.equal(validateIntentDecision({ kind: 'continue', reason: '还想试试', preferences: [{ text: '喜欢石头', source: 'user' }] }, memory, adapter).ok, false);
  assert.equal(memory.preferences().length, 0);
  assert.equal(memory.decisions().length, 0);
  const valid = validateIntentDecision({ kind: 'complete', reason: '已经看够了，不必继续采样', context: ['刚才的观察'] }, memory, adapter);
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  coordinator.decide(valid.decision);
  assert.equal(memory.intents()[0].status, 'ended');
  assert.equal(memory.projects()[0].status, 'cancelled');
  assert.equal(memory.evidence().some((e) => e.status === 'satisfied'), false);
  assert.equal(memory.decisions()[0].reason, '已经看够了，不必继续采样');
  memory.close();
});

test('revision and sequential milestone advancement invalidate bindings, normal progress does not', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  const project = coordinator.create({ intentId: intent.id, title: '取样加工', successCondition: inventory('stone_bricks', 4), milestones: [{ title: '取样', condition: inventory('stone', 4) }] });
  const initial = coordinator.currentBinding();
  adapter.inv.set('stone', 2);
  coordinator.reconcile();
  assert.equal(coordinator.isBindingCurrent(initial), true);
  adapter.inv.set('stone', 4);
  coordinator.reconcile();
  assert.equal(coordinator.isBindingCurrent(initial), false);
  const second = coordinator.currentBinding();
  coordinator.revise(project.id, { intentId: intent.id, title: '改变取样量', successCondition: inventory('stone', 8) });
  assert.equal(coordinator.isBindingCurrent(second), false);
  assert.equal(memory.projects()[0].revision, 2);
  memory.close();
});

test('legacy migration preserves existing memory and converts objective into an open suggestion; restart pauses rather than replaying', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-intents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'world-memory.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, objective: { text: '研究建筑风格', ts: 1 }, notes: [{ kind: 'fact', text: '旧观察', ts: 2 }], lessons: [{ text: '旧教训', ts: 3 }] }));
  const memory = new WorldMemory(file);
  assert.equal(memory.intents()[0].status, 'open');
  assert.equal(memory.activeProject(), undefined);
  assert.equal(memory.recentNotes()[0].text, '旧观察');
  assert.equal(memory.lessons()[0].text, '旧教训');
  const adapter = new FakeAdapter();
  memory.setWorld(adapter.worldId);
  const intent = memory.updateIntent(memory.intents()[0].id, { status: 'active' });
  const coordinator = new ProjectCoordinator(memory, adapter);
  coordinator.create({ intentId: intent.id, title: '取样', successCondition: inventory('stone', 4) });
  coordinator.pause('user');
  memory.close();
  const restored = new WorldMemory(file);
  assert.equal(restored.activeProject()?.status, 'paused');
  assert.deepEqual(restored.activeProject()?.pauseReasons.sort(), ['restart', 'user']);
  assert.equal(restored.currentIntent()?.id, intent.id);
  assert.equal(restored.dataDirectory, dir);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  restored.close();
});

test('world and dimension scoped spatial records cannot validate imaginary cross-world locations', () => {
  const { memory, adapter } = fixture();
  memory.setBase('overworld', { x: 100, y: 64, z: 0 });
  memory.setBase('the_nether', { x: 10, y: 70, z: 0 });
  memory.setChest('the_nether', adapter.pos, [{ name: 'stone', count: 64 }]);
  assert.equal(memory.base('overworld')?.pos.x, 100);
  assert.equal(memory.findLandmark('base', 'the_nether')?.pos.x, 10);
  assert.equal(memory.storedTotals('overworld').get('stone'), undefined);
  memory.setWorld('another-world');
  assert.equal(memory.landmarks().length, 0);
  assert.equal(memory.chests().length, 0);
  assert.throws(() => validateCondition({ type: 'location_near', dimension: 'overworld', pos: { x: 100, y: 64, z: 0 }, radius: 1 }, adapter, memory, adapter.state()));
  memory.close();
});

test('failed multi-record transactions roll back in memory and on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-transaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'world-memory.json');
  const { memory } = fixture(file);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => memory.transaction(() => {
    memory.recordDecision({ kind: 'continue', reason: '不该落盘', context: [] });
    throw new Error('invalid later change');
  }));
  assert.equal(memory.decisions().length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  memory.close();
});

test('changing worlds preserves the old project but rejects its action binding and continuation decisions', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  const project = coordinator.create({ intentId: intent.id, title: '旧世界取样', successCondition: inventory('stone', 16) });
  const old = coordinator.currentBinding();
  adapter.worldId = 'second-world'; adapter.sessionId = 'second-session'; memory.setWorld(adapter.worldId);
  assert.equal(coordinator.isBindingCurrent(old), false);
  assert.equal(coordinator.reconcile()?.status, 'paused');
  assert.ok(memory.activeProject()?.pauseReasons.includes('world_changed'));
  assert.equal(memory.activeProject()?.id, project.id);
  assert.equal(memory.evidence().at(-1)?.status, 'unknown');
  for (const kind of ['continue', 'change_method', 'revise']) assert.equal(validateIntentDecision({ kind, reason: '不能把旧项目当作新世界动作' }, memory, adapter).ok, false);
  assert.equal(validateIntentDecision({ kind: 'begin', intentId: intent.id, reason: '不能跨世界恢复原工程' }, memory, adapter).ok, false);
  const beginNew = validateIntentDecision({ kind: 'begin', reason: '在新世界看看当地地貌', intent: { text: '欣赏新世界', whyNow: '刚进入新世界' } }, memory, adapter);
  assert.equal(beginNew.ok, true);
  if (beginNew.ok) coordinator.decide(beginNew.decision);
  assert.equal(memory.projects()[0].status, 'deferred');
  assert.equal(memory.intents().find((i) => i.id === intent.id)?.status, 'deferred');
  assert.equal(memory.currentIntent()?.text, '欣赏新世界');
  memory.close();
});

test('explicitly beginning a deferred interest restores its original project revision, milestones and evidence', () => {
  const { memory, adapter, coordinator, intent } = fixture();
  const project = coordinator.create({ intentId: intent.id, title: '保留取样进度', successCondition: inventory('stone_bricks', 4), milestones: [{ title: '取样', condition: inventory('stone', 4) }] });
  adapter.inv.set('stone', 4); coordinator.reconcile();
  const evidenceId = memory.activeProject()?.milestones[0].evidenceId;
  coordinator.pause('reflex');
  const defer = validateIntentDecision({ kind: 'defer', reason: '先欣赏一会儿风景' }, memory, adapter);
  assert.equal(defer.ok, true); if (defer.ok) coordinator.decide(defer.decision);
  coordinator.resume('reflex'); // Clearing a global pause while no project is active must not lose the old checkpoint.
  assert.equal(memory.activeProject(), undefined);
  assert.equal(coordinator.context().deferredProjects[0].id, project.id);
  const resume = validateIntentDecision({ kind: 'begin', intentId: intent.id, reason: '风景已经看够，回到之前的石样加工' }, memory, adapter);
  assert.equal(resume.ok, true); if (resume.ok) coordinator.decide(resume.decision);
  assert.equal(memory.activeProject()?.id, project.id);
  assert.equal(memory.activeProject()?.status, 'active');
  assert.equal(memory.activeProject()?.revision, 1);
  assert.equal(memory.activeProject()?.currentMilestone, 1);
  assert.equal(memory.activeProject()?.milestones[0].evidenceId, evidenceId);
  assert.deepEqual(memory.activeProject()?.pauseReasons, []);
  assert.equal(memory.activeProject()?.checkpoint.reason, 'explicit_resume_deferred');
  memory.close();
});
