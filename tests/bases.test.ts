import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldMemory } from '../src/memory/store.ts';
import { baseMemory } from '../src/skills/bases.ts';
import { memoryFrom, semanticMemory } from './semantic-fixture.ts';
import { EventBus } from '../src/events.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import type { SkillCtx } from '../src/skills/types.ts';

const context = (adapter: FakeAdapter, memory: WorldMemory, signal = new AbortController().signal): SkillCtx => ({ adapter, memory, signal, taskId: 'base-test', deadline: Date.now() + 10000, bus: new EventBus(), senses: { knownBlocks: () => [], perceivedEntities: () => [], refresh() {}, markSweep() {} }, progress() {} });

test('multiple named bases survive within one dimension and selection preserves actual observation timestamps', async () => {
  const memory = new WorldMemory(null); memory.setWorld('world-a');
  const river = memory.setBase('overworld', { x: 10, y: 64, z: 10 }, '河边小屋');
  await sleep(2);
  const mountain = memory.setBase('overworld', { x: 100, y: 90, z: 100 }, '山顶营地', { select: true });
  assert.equal(memory.bases('overworld').length, 2);
  assert.equal(memory.base('overworld')!.id, mountain.id);
  // 盖好一个新地方不等于搬家：没说 select 的话首选还是原来的
  memory.setBase('overworld', { x: 200, y: 90, z: 200 }, '林间工棚');
  assert.equal(memory.bases('overworld').length, 3);
  assert.equal(memory.base('overworld')!.id, mountain.id);
  assert.equal(memory.bases('overworld').filter((b) => b.primary).length, 1);
  const selected = memory.selectBase(river.id);
  assert.equal(selected.ts, river.ts);
  assert.equal(memory.base('overworld')!.id, river.id);
  assert.equal(memory.bases().find((b) => b.id === mountain.id)!.ts, mountain.ts);
});

test('nearby confirmations dedupe at four blocks while names, dimensions and worlds remain isolated', () => {
  const memory = new WorldMemory(null); memory.setWorld('a');
  const first = memory.setBase('overworld', { x: 0, y: 64, z: 0 }, '家');
  const confirmed = memory.setBase('overworld', { x: 2, y: 64, z: 0 });
  assert.equal(first.id, confirmed.id);
  assert.equal(confirmed.label, '家');
  memory.setBase('the_nether', { x: 2, y: 64, z: 0 }, '地狱门营地');
  assert.equal(memory.bases().length, 2);
  assert.equal(memory.base('overworld')!.label, '家');
  assert.equal(memory.base('the_nether')!.label, '地狱门营地');
  memory.setWorld('b');
  assert.equal(memory.bases().length, 0);
  assert.throws(() => memory.selectBase(first.id), /当前世界/);
  memory.setBase('overworld', { x: 2, y: 64, z: 0 }, '另一世界');
  memory.setWorld('a');
  assert.equal(memory.bases().length, 2);
  assert.equal(memory.base('overworld')!.label, '家');
});

test('base changes checkpoint immediately and survive restart with independently selected dimension primaries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bases-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'memory.json');
  const { memory, stores, containers } = semanticMemory('base-world', file);
  const first = memory.setBase('overworld', { x: 0, y: 64, z: 0 }, '旧屋');
  memory.setBase('overworld', { x: 100, y: 64, z: 100 }, '新屋');
  const nether = memory.setBase('the_nether', { x: 10, y: 70, z: 10 }, '下界营地');
  memory.selectBase(first.id);
  assert.equal(memory.bases().filter((base) => base.kind === 'base').length, 3);
  memory.close();
  const reopened = memoryFrom(stores, containers, 'base-world', file).memory;
  t.after(() => reopened.close());
  assert.equal(reopened.base('overworld')!.id, first.id);
  assert.equal(reopened.base('the_nether')!.id, nether.id);
  assert.equal(reopened.bases().length, 3);
});

test('base memory skill accepts only actual current observed positions or existing trusted IDs', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId); adapter.pos = { x: 12.3, y: 64, z: 34.7 };
  assert.equal(baseMemory.validate({ operation: 'remember', label: '虚构', pos: { x: 999, y: 64, z: 999 } }, adapter).ok, false);
  const validation = baseMemory.validate({ operation: 'remember', label: '海边住处' }, adapter);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal((await baseMemory.run(context(adapter, memory), validation.args)).status, 'succeeded');
  assert.deepEqual(memory.base()!.pos, { x: 12, y: 64, z: 34 });
  const known = memory.base()!;
  assert.equal((await baseMemory.run(context(adapter, memory), { operation: 'select', baseId: 'never-seen' })).failureCode, 'NOT_FOUND');
  adapter.observationReady = false;
  assert.equal((await baseMemory.run(context(adapter, memory), { operation: 'remember', label: '没有观测' })).failureCode, 'NOT_CONNECTED');
  assert.equal(memory.bases().length, 1);
  adapter.observationReady = true;
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(baseMemory.run(context(adapter, memory, cancel.signal), { operation: 'select', baseId: known.id }));
  assert.equal(memory.base()!.ts, known.ts);
  assert.equal(adapter.actions.length, 0);
});

test('base cap rejects a new site without silently dropping any important existing bases', () => {
  const memory = new WorldMemory(null); memory.setWorld('many-bases');
  for (let i = 0; i < 64; i++) memory.setBase('overworld', { x: i * 10, y: 64, z: 0 }, `营地 ${i}`);
  const before = memory.bases();
  assert.throws(() => memory.setBase('overworld', { x: 1000, y: 64, z: 0 }, '更多营地'), /64 个基地/);
  assert.deepEqual(memory.bases(), before);
});
