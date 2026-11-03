import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { TestWorld } from './survival-helpers.ts';
import { makeCtx } from './survival-helpers.ts';

/** 站在整块上（脚高 64），朝北迈向相邻一格。 */
function level(w: TestWorld) {
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

test('下半砖：脚高取实际顶面 64.5，不取整假成功', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 64.5, z: -0.5 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /脚高 64\.50/);
});

test('moveTo 停在整数格时，不是落到下半砖的真实脚高，不算到达', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(r.summary, /脚高 64\.00 与目标脚高 64\.50 不符/);
});

test('上半砖占住目标格：平走被挡，不能把半格顶面当成自己这格能站', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'top' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /目标格是 oak_slab/);
  assert.equal(move.mock.callCount(), 0);
});

test('火把不挡路也不提供支撑，站在它下面那格；地毯是能站的薄层', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'torch');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 64, z: -0.5 }; });
  const torch = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(torch.status, 'succeeded', torch.summary);

  const c = level(new TestWorld());
  c.setBlock({ x: 0, y: 64, z: -1 }, 'red_carpet');
  const ctx2 = makeCtx(c);
  t.after(() => ctx2.memory.close());
  t.mock.method(c, 'moveTo', async () => { c.pos = { x: 0.5, y: 64.0625, z: -0.5 }; });
  const carpet = await stepTo.run(ctx2, { at: [1, 0, 0], facing: 'N' });
  assert.equal(carpet.status, 'succeeded', carpet.summary);
  assert.match(carpet.summary, /脚高 64\.06/);
});

test('斜向一步会扫过角落：角落里有整块时拒绝，不能只查终点净空', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 1, y: 64, z: 0 }, 'stone'); // 斜向迈步扫过的角落列
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 0, 1], facing: 'E' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /斜向迈步会撞到角落 stone/);
  assert.equal(move.mock.callCount(), 0);
});
