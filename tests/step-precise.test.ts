import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('step rejects partial diagonal movement and reports actual location', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 1], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 1 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(move.mock.callCount(), 1);
});

test('step confirms position even when movement resolves or rejects', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'succeeded');
  move.mock.mockImplementation(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortedError' }); });
  await assert.rejects(stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' }), { name: 'AbortedError' });
});

test('step looks at the selected obstruction without changing the target or digging', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  let looked = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => looked ? positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) : [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => { looked = true; });
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /stone/);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.equal(look.mock.callCount(), 1);
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
});

test('step keeps an obstructed target unknown if looking does not reveal it', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /stone/);
  assert.equal(look.mock.callCount(), 1);
});

test('ladder step rejects a higher position in a different column', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'ladder', pos: { x: 0, y: 64, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 65, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [0, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 0, y: 65, z: 0 });
});

test('water step does not claim to land on the selected bank when it lands adjacent', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 59;
  w.pos = { x: 0.5, y: 62.4, z: 0.5 };
  w.inWater = true;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 63, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'swimTo', async () => { w.pos = { x: 1.5, y: 64, z: 1.5 }; w.inWater = false; return { ok: true, landed: true, oxygen: 20 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 1.5 });
});
