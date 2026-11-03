import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const rawUse = 'await api.act("use_item", {item:"water_bucket", on:"self"});';
const rawStep = { skill: 'use_item', args: { item: 'water_bucket', on: 'self' } };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-fluid-learning-'));
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  adapter.inv.set('water_bucket', 1);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => {
    setBehaviorRegistry(null); setReliableSkills(null); engine.dispose(); arbiter.cancel('test end'); memory.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const run = (name: string) => new Promise<TaskOutcome>((resolve, reject) => {
    arbiter.once('done', resolve);
    const started = arbiter.start({ skill: 'use_skill', args: { name } }, 'llm');
    if ('error' in started) { arbiter.off('done', resolve); reject(new Error(started.error)); }
  });
  return { adapter, engine, arbiter, run };
}

for (const kind of ['code', 'steps'] as const) {
  test(`${kind} raw use completes input without becoming noop or successful learning evidence`, async (t) => {
    const w = setup(t), name = `raw-${kind}`;
    assert.ok(w.engine.write({ name, description: '沿当前准星使用水桶', ...(kind === 'code' ? { code: rawUse } : { steps: [rawStep] }) }).ok);
    const { result } = await w.run(name);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.data?.inputCompleted, true);
    assert.equal(result.data?.effectUnconfirmed, true);
    assert.notEqual(result.data?.noop, true);
    assert.ok(w.adapter.actions.includes('use:water_bucket:self'));
    assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
    assert.equal(w.engine.statsOf(name)?.uses, 1);
    assert.equal(w.engine.statsOf(name)?.skipped ?? 0, 0);
    assert.equal(w.engine.statsOf(name)?.idleInterrupts ?? 0, 0);
  });
}

test('unrelated inventory pickup cannot confirm raw use through a code skill', async (t) => {
  const w = setup(t), name = 'raw-with-pickup';
  w.adapter.useItemOn = async () => {
    w.adapter.inv.set('dirt', 1);
    return { ok: true, effectEvidence: { verified: false, changed: false, reasons: ['使用输入完成，效果未知'] } };
  };
  assert.ok(w.engine.write({ name, description: '沿准星使用水桶时捡到无关物品', code: rawUse }).ok);
  const { result } = await w.run(name);
  assert.equal(w.adapter.inv.get('dirt'), 1);
  assert.equal(result.data?.effectUnconfirmed, true);
  assert.notEqual(result.data?.noop, true);
  assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
});

test('nested raw use preserves unknown effects for both parent and child evidence', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ name: 'raw-child', description: '子技能沿准星使用水桶', code: rawUse }).ok);
  assert.ok(w.engine.write({ name: 'raw-parent', description: '父技能调用已有用桶技能', code: 'await api.useSkill("raw-child");' }).ok);
  setReliableSkills(() => null);
  const { result } = await w.run('raw-parent');
  assert.equal(result.data?.effectUnconfirmed, true);
  assert.notEqual(result.data?.noop, true);
  for (const name of ['raw-child', 'raw-parent']) {
    assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
    assert.equal(w.engine.statsOf(name)?.uses, 1);
    assert.equal(w.engine.statsOf(name)?.skipped ?? 0, 0);
  }
});

test('a later real movement is preserved through nested skill completion', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ name: 'moving-child', description: '使用后按委托向前移动', code: `${rawUse} await api.move({forward:true},50);` }).ok);
  assert.ok(w.engine.write({ name: 'moving-parent', description: '调用使用后移动的子技能', code: 'await api.useSkill("moving-child");' }).ok);
  setReliableSkills(() => null);
  const { result } = await w.run('moving-parent');
  assert.equal(result.data?.effectUnconfirmed, false);
  for (const name of ['moving-child', 'moving-parent']) assert.deepEqual(w.engine.currentStats(name), { ok: 1, fail: 0 });
});

test('an independent verify can confirm the goal after raw item input', async (t) => {
  const w = setup(t), name = 'verified-input';
  w.adapter.food = 10;
  w.adapter.inv.set('bread', 1);
  w.adapter.useItemOn = async () => { w.adapter.food = 15; return { ok: true }; };
  assert.ok(w.engine.write({ name, description: '使用食物并读取饱食度确认结果',
    code: 'await api.act("use_item",{item:"bread",on:"self"});',
    verify: 'const s = await api.state(); return s.food > args.before.food;' }).ok);
  const { result } = await w.run(name);
  assert.equal(result.data?.verified, true);
  assert.equal(result.data?.effectUnconfirmed, false);
  assert.notEqual(result.data?.noop, true);
  assert.deepEqual(w.engine.currentStats(name), { ok: 1, fail: 0 });
});

test('unknown raw input is not idle and existing delayed reflex judgment still applies', async (t) => {
  const w = setup(t), name = 'raw-reflex';
  assert.ok(w.engine.write({ name, description: '低血量时执行自学的用桶动作', when: { hp_below: 8 }, code: rawUse }).ok);
  w.adapter.hp = 6;
  const done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  const now = Date.now();
  assert.equal(w.engine.tick(null, now), true);
  assert.equal((await done).result.data?.effectUnconfirmed, true);
  assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
  assert.equal(w.engine.statsOf(name)?.idleInterrupts ?? 0, 0);
  assert.equal(w.engine.statsOf(name)?.skipped ?? 0, 0);
  w.adapter.hp = 20;
  w.engine.tick(null, now + BehaviorEngine.AFTERMATH_MS + 1);
  assert.deepEqual(w.engine.currentStats(name), { ok: 1, fail: 0 });
});


test('passive drift during raw use does not certify an action effect', async (t) => {
  const w = setup(t), name = 'raw-with-drift';
  w.adapter.useItemOn = async () => {
    w.adapter.pos = { ...w.adapter.pos, x: w.adapter.pos.x + 1 };
    return { ok: true };
  };
  assert.ok(w.engine.write({ name, description: '水流推动身体时沿准星使用水桶', code: rawUse }).ok);
  const { result } = await w.run(name);
  assert.equal(w.adapter.pos.x, 1);
  assert.equal(result.data?.effectUnconfirmed, true);
  assert.notEqual(result.data?.noop, true);
  assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
});

for (const kind of ['code', 'steps'] as const) {
  test(`${kind} observations cannot turn unknown raw use into success evidence`, async (t) => {
    const w = setup(t), name = `look-then-raw-${kind}`;
    assert.ok(w.engine.write({ name, description: '转头观察后沿准星使用水桶', ...(kind === 'code'
      ? { code: `await api.act("look", {dir:"N"}); ${rawUse}` }
      : { steps: [{ skill: 'look', args: { dir: 'N' } }, rawStep] }) }).ok);
    const { result } = await w.run(name);
    assert.equal(result.data?.effectUnconfirmed, true);
    assert.notEqual(result.data?.noop, true);
    assert.deepEqual(w.engine.currentStats(name), { ok: 0, fail: 0 });
  });
}

test('steps retain subsequent movement as a confirmed action instead of unknown input', async (t) => {
  const w = setup(t), name = 'raw-then-step';
  assert.ok(w.engine.write({ name, description: '使用水桶后按委托前进一步',
    steps: [rawStep, { skill: 'press_keys', args: { keys: { forward: true }, ms: 50 } }] }).ok);
  const { result } = await w.run(name);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.effectUnconfirmed, false);
  assert.deepEqual(w.engine.currentStats(name), { ok: 1, fail: 0 });
});
