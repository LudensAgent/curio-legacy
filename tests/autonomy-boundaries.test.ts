import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion, LlmProvider } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { ProjectCoordinator } from '../src/projects/coordinator.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok, type Skill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); };
const begin = { kind: 'begin', reason: '想看看河岸的新石材', intent: { text: '研究河岸石材', whyNow: '发现一处岩层' }, project: { title: '取样', successCondition: { type: 'inventory_min', item: 'stone', count: 4 } } };
const reply = (decision: unknown, extra: object = {}): Completion => ({ latencyMs: 1, text: JSON.stringify({ goal: '进行一次有依据的尝试', decision, steps: [{ skill: 'boundary_action' }], ...extra }) });

function fixture(t: { after: (fn: () => void) => void }, complete: LlmProvider['complete'], memory = new WorldMemory(null), action?: Skill['run']) {
  const adapter = new FakeAdapter();
  memory.setWorld(adapter.worldId);
  const bus = new EventBus(), vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'boundary-model', complete }, adapter, memory, bus, null);
  let actions = 0, learned = 0;
  SKILLS.boundary_action = { name: 'boundary_action', description: '执行一次可观测尝试', argsDoc: '{}', timeoutMs: 2000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async (ctx, args) => { actions++; return action ? action(ctx, args) : ok('完成局部尝试，结果另行验收'); } };
  const executive = new Executive({ adapter, arbiter, perception, planner, memory, bus, onLearnSkill: () => learned++ });
  executive.start(1_000_000);
  t.after(() => { executive.stop(); arbiter.cancel('test end'); delete SKILLS.boundary_action; memory.close(); });
  const cycle = async () => { executive.tick(); await flush(); executive.tick(); await flush(); };
  return { adapter, arbiter, executive, memory, bus, planner, cycle, actions: () => actions, learned: () => learned };
}

test('a persisted user pause survives restart for an open interest without a physical project', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pause-restart-'));
  const file = path.join(dir, 'world-memory.json');
  const memory = new WorldMemory(file), adapter = new FakeAdapter();
  memory.setWorld(adapter.worldId);
  memory.addIntent({ text: '慢慢欣赏河景', whyNow: '喜欢这里', context: [], tradeoffs: [], source: 'model', status: 'active' });
  new ProjectCoordinator(memory, adapter).pause('user');
  memory.close();
  let requests = 0;
  const w = fixture(t, async () => { requests++; return reply({ kind: 'continue', reason: '继续看看风景' }); }, new WorldMemory(file));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await w.cycle();
  assert.equal(requests, 0);
  assert.equal(w.actions(), 0);
  assert.equal(w.executive.paused, true);
  assert.equal(w.arbiter.paused, true);
  w.executive.resume(); await w.cycle();
  assert.equal(requests, 1);
  assert.equal(w.actions(), 1);
});

test('a model retry can decide while its project is paused for model unavailability', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const w = fixture(t, async () => { if (calls++ === 0) throw new Error('temporary unavailable'); return reply({ kind: 'continue', reason: '连接已恢复，继续原来的取样' }); });
  const intent = w.memory.addIntent({ text: '研究河岸石材', whyNow: '发现岩层', context: [], tradeoffs: [], status: 'active', source: 'model' });
  w.executive.projects.create({ intentId: intent.id, title: '取样', successCondition: { type: 'inventory_min', item: 'stone', count: 4 } });
  await w.cycle();
  assert.equal(w.memory.activeProject()?.status, 'paused');
  assert.ok(w.memory.pauseReasons().includes('model_unavailable'));
  assert.equal(w.actions(), 0);
  now += 4000;
  await w.cycle();
  assert.equal(w.actions(), 1);
  assert.equal(w.memory.activeProject()?.status, 'active');
  assert.equal(w.memory.currentIntent()?.id, intent.id);
  assert.equal(w.memory.pauseReasons().includes('model_unavailable'), false);
  assert.equal(w.bus.recent().some((e) => e.type === 'task_start' && e.msg.startsWith('[rule]')), false);
});

test('three executed plans without progress trigger a model reevaluation rather than a fixed substitute goal', async (t) => {
  const reasons: string[] = [];
  const w = fixture(t, async (_messages, _signal, hint: any) => {
    reasons.push(hint.reason);
    return reply(reasons.length === 1 ? begin : hint.reason === 'project_blocked' ? { kind: 'change_method', reason: '先换一种现有方法取样，保留原兴趣' } : { kind: 'continue', reason: '仍想比较这处石材' });
  });
  await w.cycle(); await w.cycle(); await w.cycle();
  assert.equal(w.actions(), 3);
  assert.equal(w.memory.activeProject()?.status, 'blocked');
  assert.equal(w.memory.activeProject()?.noProgressAttempts, 3);
  const intentId = w.memory.currentIntent()?.id;
  await w.cycle();
  assert.ok(reasons.includes('project_blocked'));
  assert.equal(w.memory.currentIntent()?.id, intentId);
  assert.equal(w.memory.decisions().at(-1)?.kind, 'change_method');
  assert.equal(w.memory.activeProject()?.noProgressAttempts, 1);
});

test('milestone changes invalidate a prefetched reply before any durable model side effects', async (t) => {
  let calls = 0, resolvePrefetch!: (result: Completion) => void, finishAction!: () => void;
  const w = fixture(t, async () => {
    if (calls++ === 0) return reply({ ...begin, project: { title: '先取样再加工', successCondition: { type: 'inventory_min', item: 'stone_bricks', count: 4 }, milestones: [{ title: '取样', condition: { type: 'inventory_min', item: 'stone', count: 4 } }] } });
    if (calls === 2) return new Promise((resolve) => { resolvePrefetch = resolve; });
    return new Promise(() => {});
  }, new WorldMemory(null), async (ctx) => { ctx.progress(0.98, '接近完成'); await new Promise<void>((resolve) => { finishAction = resolve; }); return ok('结束'); });
  await w.cycle();
  w.executive.tick(); await flush();
  assert.equal(calls, 2);
  w.adapter.inv.set('stone', 4);
  w.executive.tick(); await flush();
  resolvePrefetch(reply({ kind: 'continue', reason: '旧里程碑的迟到选择', preferences: [{ text: '不应保存', adjustmentReason: '迟到' }] }, { memory_note: '过期笔记', lesson: '过期教训', learn_skill: { name: 'stale_method' } }));
  finishAction(); await flush();
  assert.equal(w.memory.projects()[0].currentMilestone, 1);
  assert.equal(w.memory.preferences().length, 0);
  assert.equal(w.memory.recentNotes().length, 0);
  assert.equal(w.memory.lessons().length, 0);
  assert.equal(w.learned(), 0);
  assert.equal(w.memory.decisions().length, 1);
});

test('disconnect and death preserve checkpoints, reject stale replies, and wait for valid stable observations', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pending: ((value: Completion) => void)[] = [];
  const w = fixture(t, () => new Promise((resolve) => pending.push(resolve)));
  const intent = w.memory.addIntent({ text: '继续研究石材', whyNow: '希望比较样本', context: [], tradeoffs: [], source: 'model', status: 'active' });
  const project = w.executive.projects.create({ intentId: intent.id, title: '取样', successCondition: { type: 'inventory_min', item: 'stone', count: 4 } });
  w.executive.tick(); await flush();
  w.adapter.connected = false; w.executive.onDisconnected();
  pending[0](reply({ kind: 'continue', reason: '断线前的旧选择' }, { memory_note: '不应保存' }));
  await flush();
  assert.equal(w.memory.recentNotes().length, 0);
  assert.equal(w.memory.activeProject()?.id, project.id);
  w.adapter.connected = true; w.adapter.observationReady = false; w.adapter.sessionId = 'reconnected';
  await w.cycle(); assert.equal(pending.length, 1);
  w.adapter.observationReady = true;
  w.executive.tick(); await flush(); assert.equal(pending.length, 2);
  w.adapter.hp = 0; w.executive.onDeath();
  pending[1](reply({ kind: 'continue', reason: '死亡前的旧选择' }, { lesson: '不应保存' }));
  await flush();
  w.adapter.hp = 20; w.adapter.sessionId = 'respawned'; w.executive.onSpawn();
  await w.cycle(); assert.equal(pending.length, 2);
  now += 1600;
  w.executive.tick(); await flush(); assert.equal(pending.length, 3);
  assert.equal(w.memory.currentIntent()?.id, intent.id);
  assert.equal(w.memory.activeProject()?.noProgressAttempts, 0);
  assert.equal(w.memory.lessons().length, 0);
  assert.equal(w.actions(), 0);
});
