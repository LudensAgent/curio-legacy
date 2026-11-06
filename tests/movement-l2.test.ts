import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatPath, descendTo, swimPath } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('descend_to 只接受明确的有限落点', () => {
  const w = new FakeAdapter();
  const good = descendTo.validate({ target: { x: 1, y: 63, z: 0 } }, w);
  assert.ok(good.ok, !good.ok ? good.error : '');
  assert.equal(descendTo.name, 'descend_to');
  const bad = descendTo.validate({ target: { x: 1, y: Number.NaN, z: 0 } }, w);
  assert.equal(bad.ok, false);
});

test('swim_path surface 走有界上浮并如实报告', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 63, z: 0.5 };
  w.inWater = true;
  w.swimTo = async () => {
    w.inWater = false;
    return { ok: true, landed: true, surfaced: true, oxygen: 20 };
  };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await swimPath.run(ctx, { mode: 'surface' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(swimPath.validate({ mode: 'surface', xyz: { x: 1, y: 63, z: 0 } }, w).ok, false);
});

test('swim_path 的 mode 与实际水面/干岸不一致时拒绝', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'water', pos: { x: 1, y: 63, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const wrong = await swimPath.run(ctx, { mode: 'dry_shore', xyz: { x: 1, y: 63, z: 0 } });
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.failureCode, 'BAD_ARGS');
  assert.match(wrong.summary, /水中/);
});

test('boat_path 只驾驶已乘坐载具', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  assert.equal(boatPath.validate({ to: { x: 10, z: 10 }, distance: 48 }, w).ok, true);
  assert.equal(boatPath.validate({ distance: 48 }, w).ok, false);
  const r = await boatPath.run(ctx, { to: { x: 10, z: 10 }, distance: 48 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /没有在乘坐/);
});
