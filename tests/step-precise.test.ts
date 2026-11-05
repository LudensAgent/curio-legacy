import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

test('a downward step finds a safe lower landing without vision confirmation', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('1,63,0');
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(w.pos, { x: 1.5, y: 62, z: 0.5 });
  assert.match(r.summary, /下落 2 格/);
  assert.equal(w.inv.get('cobblestone'), 1, 'walking does not spend blocks');
});

test('step with explicit fill bridges a one-block gap and spends one block', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1'); // 一格空腔：目标格脚下是空气、再下面一格是实心
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N', fill: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: -0.5 });
  assert.equal(w.blockAt({ x: 0, y: 63, z: -1 }), 'cobblestone');
  assert.equal(w.inv.get('cobblestone'), 0);
});

test('step without fill drops into a one-block gap without spending blocks', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 63, z: -0.5 });
  assert.match(r.summary, /下落 1 格/);
  assert.equal(w.inv.get('cobblestone'), 1, 'walking does not spend blocks');
});

test('step rejects partial diagonal movement and reports actual location', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
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
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
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

test('step auto-steps onto a one-block obstruction without looking or digging', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(w.pos, { x: 1.5, y: 65, z: 0.5 });
  assert.equal(look.mock.callCount(), 0, '不再靠转头补看');
  assert.equal(dig.mock.callCount(), 0, '没有授权挖掘');
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

test('an upward step moves without turning to scan its own head space', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }); // 目标脚格下方可站立的支撑
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 65, z: 0 });
  assert.deepEqual(w.pos, { x: 1.5, y: 65, z: 0.5 });
  assert.equal(look.mock.callCount(), 0, '不再转头补看');
  assert.equal(dig.mock.callCount(), 0);
});

test('a real overhead blocker still stops an upward step without naming unobserved blocks', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 66, z: 0 } }); // 自己头顶的实心块
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /头顶上方是 实心方块/);
  assert.doesNotMatch(r.summary, /stone/);
  assert.equal(look.mock.callCount(), 0, '不再靠转头才知道头顶被挡');
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
  assert.deepEqual(w.actions, []);
});
