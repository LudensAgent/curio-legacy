import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ExperienceMiner, family } from '../src/methods/experience.ts';
import { MethodLibrary } from '../src/methods/learning.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok, type SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 模拟“模型选的一步做完了”：先改背包，再把任务结果交给经历记录 */
function harness() {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.setWorld(adapter.worldId);
  const methods = new MethodLibrary(null, adapter, memory, bus);
  const miner = new ExperienceMiner(null, adapter, memory, methods, bus);
  let n = 0;
  const step = (skill: string, args: Record<string, unknown>, change: Record<string, number>, durationMs = 10_000, source: 'llm' | 'reflex' = 'llm') => {
    for (const [k, d] of Object.entries(change)) adapter.inv.set(k, Math.max(0, (adapter.inv.get(k) ?? 0) + d));
    for (const [k, v] of [...adapter.inv]) if (v === 0) adapter.inv.delete(k);
    miner.onDone({ task: { id: `t${++n}`, skill, args, source, planId: 'p', startedAt: Date.now() - durationMs, deadline: Date.now() + 1000, progress: 1 } as any,
      result: { status: 'succeeded', summary: 'ok' } as any, durationMs } as TaskOutcome);
  };
  const events = () => bus.recent().map((e) => `${e.type}:${e.msg}`);
  return { adapter, memory, bus, methods, miner, step, events, close: () => { methods.dispose(); memory.close(); } };
}

const woodenPickaxe = (h: ReturnType<typeof harness>, ms = 10_000) => {
  h.step('look_around', { seconds: 4 }, {}, 4000);                                  // 不相关的步骤不进入做法
  h.step('gather', { block: 'spruce_log', count: 3 }, { spruce_log: 3 }, ms);
  h.step('eat', {}, { bread: -1 }, 2000, 'reflex');                                  // 反射：背包变化被吸收，不进入做法
  h.step('craft', { item: 'wooden_pickaxe', count: 1 }, { spruce_log: -2, wooden_pickaxe: 1 }, ms);
};

test('物品家族：各种原木、木板、木棍都算木头', () => {
  assert.equal(family('spruce_log'), 'wood'); assert.equal(family('oak_planks'), 'wood'); assert.equal(family('stick'), 'wood');
  assert.equal(family('cobblestone'), 'cobblestone');
});

test('物品增加时记录候选动作链，保留原本目标、数量和开关', (t) => {
  const h = harness(); t.after(h.close);
  h.adapter.inv.set('bread', 3);
  woodenPickaxe(h);
  const [ep] = h.miner.episodes('wooden_pickaxe');
  assert.ok(ep, '应记下一次经历');
  assert.deepEqual(ep.steps.map((s) => s.skill), ['gather', 'craft']);
  assert.equal((ep.steps[0].args as { block: string }).block, 'spruce_log');
  assert.equal((ep.steps[0].args as { count: number }).count, 3);
  assert.equal(SKILLS['method:get_wooden_pickaxe'], undefined, '只做成过一次：还不算学会');
});

test('两个地点的重复经历只能提出候选，不伪造试验或写成已掌握经验', (t) => {
  const h = harness(); t.after(h.close);
  woodenPickaxe(h);
  h.adapter.inv.delete('wooden_pickaxe');
  h.adapter.pos = { x: 100, y: 64, z: 100 };
  woodenPickaxe(h);
  assert.equal(SKILLS['method:get_wooden_pickaxe'], undefined);
  assert.ok(SKILLS['trial:get_wooden_pickaxe:v1']);
  const [candidate] = h.methods.list();
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(candidate.trials, []);
  assert.ok(h.events().some((e) => e.startsWith('experience_candidate:')));
  assert.ok(!h.events().some((e) => e.startsWith('skill_learned:')));
  assert.equal(h.memory.lessonsFor(10).length, 0);
  const v = SKILLS['trial:get_wooden_pickaxe:v1'].validate({}, h.adapter);
  assert.equal(v.ok, true, v.ok ? '' : v.error);
});

for (const make of [true, false]) test(`经历和候选程序保留显式 make:${make}`, (t) => {
  const h = harness(); t.after(h.close);
  for (const x of [0, 100]) {
    h.adapter.pos.x = x;
    h.step('gather', { block: 'spruce_log', count: 3, make }, { spruce_log: 3 });
    h.step('craft', { item: 'wooden_pickaxe', count: 1, extra: true, make }, { spruce_log: -2, wooden_pickaxe: 1 });
  }
  assert.ok(h.miner.episodes('wooden_pickaxe').every((episode) => episode.steps.every((step) => (step.args as { make: boolean }).make === make)));
  const [candidate] = h.methods.list();
  assert.equal(candidate.status, 'candidate');
  if (candidate.program.type !== 'sequence') assert.fail('expected sequence');
  assert.ok(candidate.program.steps.every((step) => step.type === 'call' && (step.args as { make: boolean }).make === make));
});

test('同一个地方做两次不算“在不同情境里验证过”', (t) => {
  const h = harness(); t.after(h.close);
  woodenPickaxe(h); h.adapter.inv.delete('wooden_pickaxe'); woodenPickaxe(h);
  assert.equal(SKILLS['method:get_wooden_pickaxe'], undefined);
});

test('经历提出的候选只有实际执行并通过两个情境的结果验收才晋升', async (t) => {
  const h = harness(); t.after(h.close);
  woodenPickaxe(h);
  h.adapter.pos.x = 100;
  woodenPickaxe(h);
  t.mock.method(SKILLS.gather, 'run', async () => {
    h.adapter.inv.set('spruce_log', (h.adapter.inv.get('spruce_log') ?? 0) + 3);
    return ok('gather observation');
  });
  t.mock.method(SKILLS.craft, 'run', async () => {
    h.adapter.inv.set('wooden_pickaxe', (h.adapter.inv.get('wooden_pickaxe') ?? 0) + 1);
    return ok('craft observation');
  });
  const trial = SKILLS['trial:get_wooden_pickaxe:v1'];
  const validation = trial.validate({}, h.adapter);
  if (!validation.ok) assert.fail(validation.error);
  const ctx: SkillCtx = { adapter: h.adapter, memory: h.memory, bus: h.bus, signal: new AbortController().signal,
    deadline: Date.now() + 10000, taskId: 'experience-trial', progress() {},
    senses: { refresh() {}, markSweep() {}, knownBlocks: () => [], perceivedEntities: () => [] } };
  assert.equal((await trial.run(ctx, validation.args)).status, 'succeeded');
  assert.equal(h.methods.list()[0].status, 'candidate');
  h.adapter.pos.x = 200;
  assert.equal((await trial.run(ctx, validation.args)).status, 'succeeded');
  assert.equal(h.methods.list()[0].status, 'verified');
  assert.equal(h.methods.list()[0].trials.length, 2);
  assert.ok(h.methods.list()[0].trials.every((e) => e.sessionId === h.adapter.sessionId && e.observationId !== 'observed'));
});

test('只是一步合成（材料早就在背包里）不算学到做法', (t) => {
  const h = harness(); t.after(h.close);
  h.adapter.inv.set('oak_planks', 8);
  h.step('craft', { item: 'crafting_table', count: 1 }, { oak_planks: -4, crafting_table: 1 });
  assert.equal(h.miner.episodes('crafting_table').length, 0);
});

test('更快的新动作链仍只提出候选，不以旧经历晋升或自动淘汰其它版本', (t) => {
  const h = harness(); t.after(h.close);
  woodenPickaxe(h, 30_000); h.adapter.inv.delete('wooden_pickaxe');
  h.adapter.pos = { x: 100, y: 64, z: 100 }; woodenPickaxe(h, 30_000); h.adapter.inv.delete('wooden_pickaxe');
  const first = h.methods.list();
  assert.equal(first.length, 1);
  const faster = () => {
    h.step('explore', { direction: 'N', distance: 32, until: 'spruce_log' }, {}, 3000);
    h.step('gather', { block: 'spruce_log', count: 3 }, { spruce_log: 3 }, 4000);
    h.step('craft', { item: 'wooden_pickaxe', count: 1 }, { spruce_log: -2, wooden_pickaxe: 1 }, 3000);
  };
  h.adapter.pos = { x: 300, y: 64, z: 0 }; faster(); h.adapter.inv.delete('wooden_pickaxe');
  h.adapter.pos = { x: 500, y: 64, z: 0 }; faster();
  const now = h.methods.list().filter((d) => d.name === 'get_wooden_pickaxe');
  assert.equal(now.length, 2);
  assert.ok(now.every((d) => d.status === 'candidate' && d.trials.length === 0));
  assert.equal(now.find((d) => d.version === first[0].version)?.status, 'candidate');
  assert.ok(!h.events().some((e) => /更快的办法|skill_learned/.test(e)));
});

test('提取候选保留 extra 和探索方向；已有旧式 observed 伪证据加载后不算通过', (t) => {
  const h = harness(); t.after(h.close);
  for (const x of [0, 100]) {
    h.adapter.pos = { x, y: 64, z: x };
    h.step('explore', { direction: 'N', distance: 32, until: 'spruce_log' }, {});
    h.step('gather', { block: 'spruce_log', count: 3 }, { spruce_log: 3 });
    h.step('craft', { item: 'wooden_pickaxe', count: 1, extra: true }, { spruce_log: -2, wooden_pickaxe: 1 });
  }
  const [candidate] = h.methods.list();
  assert.equal(candidate.program.type, 'sequence');
  if (candidate.program.type !== 'sequence') assert.fail('expected sequence');
  const [explore, , craft] = candidate.program.steps;
  assert.equal(explore.type, 'call'); assert.equal(craft.type, 'call');
  if (explore.type !== 'call' || craft.type !== 'call') assert.fail('expected calls');
  assert.equal((explore.args as { direction: string }).direction, 'N');
  assert.equal((explore.args as { distance: number }).distance, 32);
  assert.equal((craft.args as { extra: boolean }).extra, true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-experience-migration-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'methods.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, methods: [{ ...candidate, status: 'verified', trials: [0, 1].map((i) => ({
    id: `legacy-${i}`, worldId: h.adapter.worldId, contextKey: `place-${i}`, sessionId: 'observed', observationId: 'observed', status: 'verified', source: 'adapter.state',
  })) }], gaps: [] }));
  h.methods.dispose();
  const loaded = new MethodLibrary(file, h.adapter, h.memory, h.bus); t.after(() => loaded.dispose());
  assert.equal(loaded.list()[0].status, 'candidate');
  assert.deepEqual(loaded.list()[0].trials, []);
  assert.equal(SKILLS['method:get_wooden_pickaxe'], undefined);
});
