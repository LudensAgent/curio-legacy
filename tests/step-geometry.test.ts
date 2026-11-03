import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { collisionBoxes, supportTop } from '../src/perception/geometry.ts';
import { TestWorld, makeCtx, observeAllBlocks } from './survival-helpers.ts';

/** 站在整块上（脚高 64），朝北迈向相邻一格。 */
function level(w: TestWorld) {
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

/** 默认观察所有已加载格（Fake 无遮挡）。 */
function ctx(w: TestWorld) {
  return makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
}

test('下半砖：脚高取实际顶面 64.5，不取整假成功', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'bottom' });
  const c = ctx(w);
  t.after(() => c.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 64.5, z: -0.5 }; });
  const r = await stepTo.run(c, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /脚高 64\.50/);
});

test('moveTo 停在整数格（不是半砖真实脚高）时不报到达', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'bottom' });
  const c = ctx(w);
  t.after(() => c.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 64, z: -0.5 }; });
  const r = await stepTo.run(c, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(r.summary, /脚高 64\.00 与目标脚高 64\.50 不符/);
});

test('上半砖占住目标格：平走被挡，不能把半格顶面当成自己这格能站', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,64,-1', { type: 'top' });
  const c = ctx(w);
  t.after(() => c.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const r = await stepTo.run(c, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /目标格是 oak_slab/);
  assert.equal(move.mock.callCount(), 0);
});

test('脚高 64、头格 65 有下半砖时身体会撞到，不能只查终点净空', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 65, z: -1 }, 'oak_slab');
  w.blockProperties.set('0,65,-1', { type: 'bottom' });
  const c = ctx(w);
  t.after(() => c.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const r = await stepTo.run(c, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /目标格上方是 oak_slab/);
  assert.equal(move.mock.callCount(), 0);
});

test('火把不挡路也不提供支撑，站在它下面那格；地毯是能站的薄层', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 0, y: 64, z: -1 }, 'torch');
  const c = ctx(w);
  t.after(() => c.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 64, z: -0.5 }; });
  const torch = await stepTo.run(c, { at: [1, 0, 0], facing: 'N' });
  assert.equal(torch.status, 'succeeded', torch.summary);

  const c2w = level(new TestWorld());
  c2w.setBlock({ x: 0, y: 64, z: -1 }, 'red_carpet');
  const c2 = ctx(c2w);
  t.after(() => c2.memory.close());
  t.mock.method(c2w, 'moveTo', async () => { c2w.pos = { x: 0.5, y: 64.0625, z: -0.5 }; });
  const carpet = await stepTo.run(c2, { at: [1, 0, 0], facing: 'N' });
  assert.equal(carpet.status, 'succeeded', carpet.summary);
  assert.match(carpet.summary, /脚高 64\.06/);
});

test('碰撞形状按当前 blockstate：雪层高度、打开的栅栏门、关闭的下半活板门', () => {
  assert.equal(supportTop('snow', { layers: 1 }), null, '一层雪无碰撞');
  assert.equal(supportTop('snow', { layers: 5 }), 0.5);
  assert.equal(supportTop('snow', { layers: 8 }), 0.875);
  assert.deepEqual(collisionBoxes('snow', { layers: 5 }), [[0, 0, 0, 1, 0.5, 1]]);
  assert.equal(collisionBoxes('oak_fence_gate', { open: true }).length, 0, '打开的栅栏门不挡路');
  assert.equal(supportTop('oak_trapdoor', { half: 'bottom', open: false }), 0.1875, '关闭的下半活板门高 0.1875');
});

test('step 踩 5 层雪：脚高取实际顶面 63.5', async (t) => {
  const w = level(new TestWorld());
  w.removed.add('0,63,-1');
  w.setBlock({ x: 0, y: 63, z: -1 }, 'snow');
  w.blockProperties.set('0,63,-1', { layers: 5 });
  const c = ctx(w);
  t.after(() => c.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 63.5, z: -0.5 }; });
  const r = await stepTo.run(c, { at: [1, -1, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /脚高 63\.50/);
});

test('斜向一步会扫过角落：角落里有整块时拒绝，不能只查终点净空', async (t) => {
  const w = level(new TestWorld());
  w.setBlock({ x: 1, y: 64, z: 0 }, 'stone'); // 斜向迈步扫过的角落列
  const c = ctx(w);
  t.after(() => c.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const r = await stepTo.run(c, { at: [1, 0, 1], facing: 'E' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /斜向迈步会撞到角落 stone/);
  assert.equal(move.mock.callCount(), 0);
});
