import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine, validateBehavior } from '../src/mind/behaviors.ts';
import { evalPredicate, senseNow } from '../src/mind/predicate.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-skill-lifecycle-'));
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); arbiter.cancel('test end'); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = (trial = false) => new Promise<TaskOutcome>((resolve, reject) => {
    arbiter.once('done', resolve);
    const started = arbiter.start({ skill: 'use_skill', args: { name: 'measured-step', ...(trial ? { trial } : {}) } }, 'llm');
    if ('error' in started) reject(new Error(started.error));
  });
  return { directory, adapter, bus, memory, senses, arbiter, book, engine, run };
}

const definition = { name: 'measured-step', description: '血少时按选定方向迈一小步', when: { hp_below: 8 },
  code: 'await api.move({forward:true},50); return {moved:true};',
  verify: 'const s = await api.state(); return Math.hypot(s.pos.x-args.before.pos.x,s.pos.z-args.before.pos.z)>0.01 ? true : "没有移动";' };

test('生成候选跨重载保存，显式游戏试用验收后才参与原定自动调度', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'forge' }).ok);
  w.book.reload();
  assert.equal(w.engine.get(definition.name, true)?.candidate, true);
  assert.equal(w.engine.enabled(w.engine.get(definition.name)!), false);
  assert.equal(useSkill.validate({ name: definition.name }, w.adapter).ok, false);
  assert.equal(w.engine.tick(null), false);
  for (let i = 0; i < BehaviorEngine.MIN_EVIDENCE; i++) {
    const outcome = await w.run(true);
    assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  }
  assert.equal(w.engine.get(definition.name, true), undefined);
  assert.equal(w.engine.get(definition.name)?.candidate, undefined);
  assert.equal(w.engine.enabled(w.engine.get(definition.name)!), true);
  assert.equal(w.engine.currentStats(definition.name).ok, 3);
  assert.ok(w.bus.recent().some((event) => event.type === 'skill_promoted'));
});

test('修订候选保留稳定版本，回滚恢复当时的参数、触发与验收完整契约', async (t) => {
  const w = setup(t);
  const old = { ...definition, args: { distance: '可选，默认一小步' } };
  assert.ok(w.engine.write(old).ok);
  assert.ok(w.engine.write({ ...definition, code: undefined, steps: [{ skill: 'step', args: { to: [1, 0, 0] } }], when: { hp_below: 5 }, args: { count: '可选，默认一步' },
    verify: `${definition.verify}\n// 新版验收` }, { by: 'improve' }).ok);
  assert.equal(w.engine.get(definition.name)?.when?.hp_below, 8);
  assert.equal(w.engine.get(definition.name, true)?.when?.hp_below, 5);
  for (let i = 0; i < 3; i++) await w.run(true);
  w.book.reload();
  assert.equal(w.engine.get(definition.name)?.code, undefined, 'code 改 steps 后重载不能读回旧 code.js');
  assert.equal(w.engine.get(definition.name)?.when?.hp_below, 5);
  assert.ok(w.engine.rollback(definition.name, 1, '恢复已验证契约').ok);
  assert.equal(w.engine.get(definition.name)?.when?.hp_below, 8);
  assert.deepEqual(w.engine.get(definition.name)?.needs, old.args);
  assert.equal(w.engine.get(definition.name)?.verify, old.verify);
});

test('停用同时约束校验和已排队执行，后台修订也不能复活', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  const args = useSkill.validate({ name: definition.name }, w.adapter);
  assert.ok(args.ok);
  w.engine.retire(definition.name, '不再使用');
  assert.equal(useSkill.validate({ name: definition.name }, w.adapter).ok, false);
  const before = { ...w.adapter.pos };
  const result = await useSkill.run({ adapter: w.adapter, senses: w.senses, memory: w.memory, bus: w.bus,
    signal: new AbortController().signal, taskId: 'retired-call', deadline: Date.now() + 2000, progress() {} }, args.args);
  assert.equal(result.status, 'failed');
  assert.deepEqual(w.adapter.pos, before);
  assert.equal(w.engine.replaceCode(definition.name, definition.code, '旧后台结果', definition.verify).ok, false);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  assert.equal(useSkill.validate({ name: definition.name }, w.adapter).ok, false, '显式修订不提前复活旧稳定版');
  assert.equal(useSkill.validate({ name: definition.name, trial: true }, w.adapter).ok, true);
  for (let i = 0; i < 3; i++) await w.run(true);
  assert.equal(w.engine.inactive(definition.name), false, '新候选验收通过后才解除名称级停用');
});

test('跳过和无动作自报成功不能晋级，子调用保留自己的实际使用证据', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...definition, code: 'return {skipped:"不用做"};', verify: 'return true;' }, { by: 'mind' }).ok);
  for (let i = 0; i < 3; i++) await w.run(true);
  assert.equal(w.engine.currentStats(definition.name, true).ok, 0);
  assert.ok(w.engine.write({ ...definition, code: 'return {ok:true};', verify: 'return true;' }, { by: 'mind' }).ok);
  for (let i = 0; i < 3; i++) await w.run(true);
  assert.equal(w.engine.currentStats(definition.name, true).ok, 0);
  assert.ok(w.engine.get(definition.name, true));
  assert.ok(w.engine.write({ ...definition, code: undefined, steps: [{ skill: 'step', args: { to: [1, 0, 0] }, if: { hp_below: 1 } }], verify: 'return true;' }, { by: 'mind' }).ok);
  for (let i = 0; i < 3; i++) await w.run(true);
  assert.equal(w.engine.currentStats(definition.name, true).ok, 0, '步骤全部跳过不能累积晋级证据');
  assert.ok(w.engine.write(definition).ok);
  const result = await useSkill.run({ adapter: w.adapter, senses: w.senses, memory: w.memory, bus: w.bus,
    signal: new AbortController().signal, taskId: 'nested-call', deadline: Date.now() + 4000, progress() {}, skillDepth: 1 } as Parameters<typeof useSkill.run>[0], { name: definition.name });
  assert.equal(result.status, 'succeeded');
  assert.equal(w.engine.currentStats(definition.name).ok, 1, '嵌套执行也为子技能记账');
  const curator = new SkillCurator({ autonomous: false, noteInvalid() {}, async complete() { return { text: '{}', latencyMs: 0 }; } }, w.engine, w.book, w.bus, { unusedDays: 1 });
  curator.observe({ ...w.adapter.state(), worldAgeTicks: 0 }, false, 0);
  assert.deepEqual(curator.retireUnused(w.engine.statsOf(definition.name)!.lastUsedAt!), [], '实际手动使用不再被误判为从未使用');
});

test('触发条件不能通过原始世界方块识别遮挡矿物，也拒绝不可达恢复条件', () => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 1, y: 64, z: 0 } });
  const unseen = senseNow(adapter, { perceivedEntities: () => [], observeBlocks: () => [] }, null);
  assert.equal(evalPredicate({ cell: [{ at: [1, 0, 0], is: 'diamond_ore' }] }, unseen), false);
  assert.equal(unseen.cell([1, 0, 0]), null);
  assert.ok('error' in validateBehavior({ ...definition, when: { after_failure: { skill: 'look_around', code: 'NOT_FOUND' } } }, adapter));
  assert.ok('error' in validateBehavior({ ...definition, when: { after_failure: { skill: 'scan', code: 'NOT_FOUND' } } }, adapter));
});
