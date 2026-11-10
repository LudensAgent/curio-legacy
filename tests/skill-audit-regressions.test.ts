import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const definition = { name: 'measured-craft', description: '按委托合成一块木板',
  code: 'await api.act("craft", {item:"oak_planks",count:1});',
  verify: 'const s = await api.state(); const count = (items) => items.filter(i => i.name === "oak_planks").reduce((n,i) => n+i.count,0); return count(s.inventory) > count(args.before.inventory) ? true : "木板没有增加";' };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-audit-'));
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); arbiter.cancel('test end'); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = (name: string) => new Promise<TaskOutcome>((resolve, reject) => {
    arbiter.once('done', resolve);
    const started = arbiter.start({ skill: 'use_skill', args: { name, trial: true } }, 'llm');
    if ('error' in started) reject(new Error(started.error));
  });
  const record = (version: number, ok: boolean) => engine.recordInvocation(definition.name, {
    status: ok ? 'succeeded' : 'failed', summary: ok ? '实际验收通过' : '结果未达到委托目标',
    data: { version, verified: ok },
  });
  return { directory, adapter, bus, memory, senses, arbiter, book, engine, run, record };
}

test('F2 identical complete candidate writes keep version, evidence, and timestamps after reload', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  w.record(1, true);
  const before = structuredClone(w.engine.statsOf(definition.name));
  w.book.reload();
  for (const by of ['curator', 'forge', 'improve', 'mind'] as const) {
    const result = w.engine.write(definition, { by });
    assert.ok(result.ok && result.unchanged);
    assert.equal(w.engine.get(definition.name, true)?.version, 1);
    assert.deepEqual(w.engine.statsOf(definition.name), before);
  }
  assert.deepEqual(w.book.versions(definition.name), []);
});

test('F2 every background writer preserves pending evidence; mind and current program errors can revise', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  w.engine.statsOf(definition.name)!.writtenAt = 1;
  const revised = { ...definition, code: definition.code + '\n// revised' };
  for (const by of ['curator', 'forge', 'improve'] as const) {
    const result = w.engine.write(revised, { by });
    assert.ok(!result.ok && result.gated);
  }
  assert.ok(w.engine.write(revised, { by: 'mind' }).ok);
  w.engine.recordInvocation(definition.name, { status: 'failed', summary: 'TypeError: current version', data: { version: 2 } });
  assert.ok(w.engine.write(definition, { by: 'improve' }).ok);
  assert.equal(w.engine.get(definition.name, true)?.version, 3);
  assert.ok(w.bus.recent(20).some((event) => event.type === 'skill_revision_deferred'));
});

test('F2 inactive stable state cannot bypass candidate protection, and explicit historical retry preserves evidence', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.retire(definition.name, '稳定版已不适用'));
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  const rejected = w.engine.write({ ...definition, code: definition.code + '\n// background revision' }, { by: 'improve' });
  assert.ok(!rejected.ok && rejected.gated);
  w.record(2, true);
  assert.ok(w.engine.retireCandidate(definition.name, 2, '暂时收起候选'));
  const unchanged = w.engine.write(definition, { by: 'mind' });
  assert.ok(unchanged.ok && unchanged.unchanged);
  assert.match(w.engine.executionError(definition.name, true)!, /已收起/);
  const retry = w.engine.write({ name: definition.name, from_version: 2 }, { by: 'mind' });
  assert.ok(retry.ok && retry.restored);
  assert.equal(w.engine.get(definition.name, true)?.version, 2);
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 1, fail: 0 });
  assert.equal(w.engine.executionError(definition.name, true), null);
  assert.equal(w.engine.inactive(definition.name), true, 'only trial permission returns; the stable version stays inactive');
});

test('F3 steps and code both reject missing verify and promote from actual inventory gains', async (t) => {
  const w = setup(t);
  const steps = { ...definition, name: 'measured-steps', code: undefined, steps: [{ skill: 'craft', args: { item: 'oak_planks', count: 1 } }] };
  for (const contract of [definition, steps]) {
    const missing = w.engine.write({ ...contract, verify: undefined }, { by: 'mind' });
    assert.ok(!missing.ok && missing.error.includes('verify'));
    assert.equal(w.book.candidate(contract.name), undefined);
    assert.ok(w.engine.write(contract, { by: 'mind' }).ok);
    for (let trial = 0; trial < 3; trial++) {
      const outcome = await w.run(contract.name);
      assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
      assert.equal(outcome.result.data?.verified, true);
    }
    assert.equal(w.engine.get(contract.name, true), undefined);
    assert.equal(w.engine.currentStats(contract.name).ok, 3);
  }
  assert.equal(w.adapter.inv.get('oak_planks'), 6);
});

test('F5 automatic rollback skips overwritten candidates and restores the previous stable contract', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  [1, 2, 3].forEach(() => w.record(1, true));
  assert.ok(w.engine.write({ ...definition, code: definition.code + '\n// unpromoted' }, { by: 'mind' }).ok);
  w.record(2, true); w.record(2, true); w.record(2, false);
  assert.ok(w.engine.write({ ...definition, code: definition.code + '\n// new stable' }, { by: 'mind' }).ok);
  [1, 2, 3].forEach(() => w.record(3, true));
  await Promise.resolve();
  w.book.reload();
  assert.equal(w.engine.get(definition.name)?.version, 3);
  assert.equal(w.engine.rollback(definition.name, 2, 'must remain candidate').ok, false);
  [1, 2, 3, 4, 5].forEach(() => w.record(3, false));
  assert.equal(w.engine.get(definition.name)?.version, 4);
  assert.equal(w.engine.get(definition.name)?.code, definition.code);
  assert.equal(w.bus.recent(20).find((event) => event.type === 'skill_rollback')?.data?.to, 1);
});

test('F5 no previously enabled version means no automatic activation of a failed historical candidate', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  w.record(1, true); w.record(1, true); w.record(1, false);
  assert.ok(w.engine.write({ ...definition, code: definition.code + '\n// new' }, { by: 'mind' }).ok);
  [1, 2, 3].forEach(() => w.record(2, true));
  await Promise.resolve();
  [1, 2, 3, 4, 5].forEach(() => w.record(2, false));
  assert.equal(w.engine.get(definition.name)?.version, 2);
  assert.equal(w.engine.rollback(definition.name, 1, 'not stable').ok, false);
});

test('F6 physical deletion removes both contracts and prevents restore or queued execution', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.write({ ...definition, code: definition.code + '\n// pending' }, { by: 'mind' }).ok);
  const queued = useSkill.validate({ name: definition.name }, w.adapter);
  assert.ok(queued.ok);
  assert.ok(w.engine.delete(definition.name));
  assert.equal(fs.existsSync(path.join(w.directory, definition.name)), false);
  assert.equal(w.book.get(definition.name), undefined);
  assert.equal(w.engine.get(definition.name), undefined);
  assert.equal(w.engine.get(definition.name, true), undefined);
  assert.equal(w.engine.statsOf(definition.name), undefined);
  assert.equal(w.engine.restore(definition.name), false);
  const outcome = await useSkill.run({ adapter: w.adapter, senses: w.senses, memory: w.memory, bus: w.bus,
    signal: new AbortController().signal, taskId: 'deleted-queued', deadline: Date.now() + 2000, progress() {} }, queued.args);
  assert.equal(outcome.status, 'failed');
  assert.equal(w.adapter.inv.get('oak_planks'), undefined);
  w.book.reload();
  assert.equal(w.engine.get(definition.name), undefined);
  assert.ok(w.engine.write(definition, { by: 'forge' }).ok, 'a future explicit definition is not blocked by a deletion tombstone');
});
