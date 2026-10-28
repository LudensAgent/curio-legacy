import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { signText, editBook } from '../src/skills/text.ts';
import { useGui } from '../src/skills/gui.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('text and GUI controls require current sight before reading a coordinate or entity', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  let reads = 0;
  const ctx = { adapter: Object.assign(adapter, { signText: async () => { reads++; return { ok: true, lines: ['hidden'] }; }, useGui: async () => { reads++; return { ok: true, done: [] }; } }),
    memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 1000, taskId: 'text', progress() {},
    senses: { refresh() {}, markSweep() {}, knownBlocks: () => [], observeBlocks: () => [], perceivedEntities: () => [] } };
  assert.equal((await signText.run(ctx, { target: { x: 2, y: 64, z: 0 }, back: false })).status, 'failed');
  assert.equal((await useGui.run(ctx, { target: { x: 2, y: 64, z: 0 }, ops: [] })).status, 'failed');
  assert.equal((await useGui.run(ctx, { target: { entityId: 7 }, ops: [] })).status, 'failed');
  assert.equal(reads, 0);
  assert.equal((await useGui.run(ctx, { target: 'inventory', ops: [] })).status, 'succeeded');
  assert.equal(reads, 1, 'own inventory does not depend on world sight');
});

test('book editing and signing require an exact source and explicit valid content', () => {
  assert.equal(editBook.validate({ sourceSlot: 9, pages: ['a'], title: 'result' }, new FakeAdapter()).ok, true);
  for (const raw of [{ sourceSlot: 45, pages: [] }, { sourceSlot: 9, pages: ['x'.repeat(1025)] }, { sourceSlot: 9, pages: [], title: '' }]) assert.equal(editBook.validate(raw, new FakeAdapter()).ok, false);
  assert.equal(signText.validate({ target: 'oak_sign', lines: ['a\nb'] }, new FakeAdapter()).ok, false);
  assert.equal(signText.validate({ target: 'oak_sign', lines: ['', '', '', ''], back: true }, new FakeAdapter()).ok, true);
});
