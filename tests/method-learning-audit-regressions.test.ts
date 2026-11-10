import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { MethodLibrary, type MethodDefinition } from '../src/methods/learning.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

const savedMethod = (name: string, idleTicks?: number) => ({
  name, description: '取样并确认库存增加', version: 1, createdAt: Date.now() - 4 * 86_400_000,
  parameters: {}, program: { type: 'call', skill: 'craft', args: { item: 'stone', count: 1 } },
  postcondition: { type: 'inventory_gain', item: 'stone', count: 1 },
  status: 'candidate', trials: [], scope: { worldId: 'fake-world', dimension: 'overworld' },
  ...(idleTicks === undefined ? {} : { idleTicks }),
});

function fixture(t: TestContext, saved: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'method-audit-'));
  const file = path.join(dir, 'methods.json');
  fs.writeFileSync(file, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.setWorld(adapter.worldId);
  const library = new MethodLibrary(file, adapter, memory, bus);
  t.after(() => {
    library.dispose(); memory.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, adapter, memory, bus, library };
}

test('one incompatible method neither blocks later methods nor disappears after an unrelated save', (t) => {
  const invalid = { ...savedMethod('old_primitive'), program: { type: 'call', skill: 'goto', args: { target: 'home' } }, notes: { retained: 'original contract' } };
  const valid = savedMethod('valid_craft');
  const { file, library, bus } = fixture(t, { version: 1, methods: [invalid, valid], gaps: [] });
  assert.deepEqual(library.list().map((method) => method.name), ['valid_craft']);
  assert.equal(SKILLS['trial:old_primitive:v1'], undefined);
  assert.ok(SKILLS['trial:valid_craft:v1']);
  assert.equal(bus.recent().filter((event) => event.type === 'method_load_failed').length, 1);
  library.recordGap('无关的能力缺口');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { methods: { name: string }[]; gaps: unknown[] };
  assert.equal(saved.methods.length, 2);
  assert.deepEqual(saved.methods.find((method) => method.name === invalid.name), invalid);
  assert.ok(saved.methods.find((method) => method.name === valid.name));
  assert.equal(saved.gaps.length, 1);
});

test('an unreadable method file is not replaced by an empty library during ordinary saves', (t) => {
  const source = '{"methods": [{"name": "unfinished"';
  const { file, library, bus } = fixture(t, source);
  library.recordGap('加载失败后出现的新缺口');
  library.dispose();
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(library.list().length, 0);
  assert.match(bus.recent().find((event) => event.type === 'method_load_failed')!.msg, /停止覆盖原文件/);
});

test('old timestamps, offline gaps, pauses, unknown samples and new sessions do not count as method idle time', (t) => {
  const old = savedMethod('observed_idle');
  const { file, library, adapter, memory, bus } = fixture(t, { version: 1, methods: [old], gaps: [] });
  library.pruneStale();
  assert.equal(library.list()[0].status, 'candidate');
  assert.equal(library.list()[0].idleTicks, 0);
  const state = { ...adapter.state(), worldAgeTicks: 100 };
  library.observe(state, false, 0);
  state.worldAgeTicks += 20;
  library.observe(state, false, 1000);
  assert.equal(library.list()[0].idleTicks, 20);
  state.worldAgeTicks += 4 * 86_400 * 20;
  library.observe(state, false, 4 * 86_400_000);
  assert.equal(library.list()[0].idleTicks, 20);
  library.observe(state, true, 4 * 86_400_000 + 1000);
  state.worldAgeTicks += 100;
  library.observe(state, false, 4 * 86_400_000 + 2000);
  bus.publish('paused', 'P3', 'pause between observations');
  bus.publish('resumed', 'P3', 'resume between observations');
  state.worldAgeTicks += 100;
  library.observe(state, false, 4 * 86_400_000 + 3000);
  library.observe({ ...state, observationReady: false }, false, 4 * 86_400_000 + 4000);
  state.worldAgeTicks += 100;
  library.observe(state, false, 4 * 86_400_000 + 5000);
  state.sessionId = 'reconnected'; state.worldAgeTicks += 100;
  library.observe(state, false, 4 * 86_400_000 + 6000);
  assert.equal(library.list()[0].idleTicks, 20);
  library.dispose();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { methods: MethodDefinition[] };
  assert.equal(saved.methods[0].idleTicks, 20);
  assert.equal(saved.methods[0].createdAt, old.createdAt, 'real historical timestamps remain unchanged');
  const restored = new MethodLibrary(file, adapter, memory, new EventBus());
  restored.observe({ ...state, worldAgeTicks: state.worldAgeTicks + 100000 }, false, 5 * 86_400_000);
  restored.pruneStale();
  assert.equal(restored.list()[0].idleTicks, 20);
  assert.equal(restored.list()[0].status, 'candidate');
  restored.dispose();
});

test('only observed ticks can cross the existing 72-hour idle threshold', (t) => {
  const { library, adapter } = fixture(t, { version: 1, methods: [savedMethod('idle_threshold', 3 * 86_400 * 20 - 10)], gaps: [] });
  const state = { ...adapter.state(), worldAgeTicks: 1000 };
  library.observe(state, false, 0);
  library.pruneStale();
  assert.equal(library.list()[0].status, 'candidate');
  state.worldAgeTicks += 20;
  library.observe(state, false, 1000);
  library.pruneStale();
  assert.equal(library.list()[0].status, 'retired');
  assert.equal(SKILLS['trial:idle_threshold:v1'], undefined);
});

test('a real trial resets observed idle time while preserving its real result timestamp', async (t) => {
  const { library, adapter, memory, bus } = fixture(t, { version: 1, methods: [savedMethod('idle_trial', 1000)], gaps: [] });
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  t.after(() => arbiter.cancel('cleanup'));
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  const before = Date.now();
  const started = arbiter.start({ skill: 'trial:idle_trial:v1', args: {} }, 'llm');
  assert.ok(!('error' in started));
  assert.equal((await done).result.status, 'succeeded');
  const definition = library.list()[0];
  assert.equal(definition.idleTicks, 0);
  assert.equal(definition.trials[0].status, 'verified');
  assert.ok(definition.trials[0].ts >= before && definition.trials[0].ts <= Date.now());
});
