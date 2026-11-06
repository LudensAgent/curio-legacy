import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { moveStep, mineCell, placeCell, placeSupport, pillarOne } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const visibleTargets = (w: FakeAdapter) => (positions: Vec3Like[]) => positions.flatMap((pos) => {
  const name = w.blockAt(pos);
  return name === null ? [] : [{
    name, pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  }];
});

function flat() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

function pocket() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  return w;
}

test('move_step 同层：站到相邻格，按实际脚高验收', async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const v = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
  assert.ok(v.ok, !v.ok ? v.error : '');
  const r = await moveStep.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.x), 1);
  assert.equal(Math.floor(w.pos.y), 64);
});

test('move_step 下一级：只接受正好低 1 格的目标脚高', async (t) => {
  const w = flat();
  w.removed.add('1,63,0');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const ok = await moveStep.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(ok.status, 'succeeded', ok.summary);
  assert.equal(Math.floor(w.pos.y), 63);
});

test('move_step 支持半砖的分数脚高（相对和绝对 xyz）', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const relative = await moveStep.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(relative.status, 'succeeded', relative.summary);
  assert.equal(w.pos.y, 63.5);

  const w2 = flat();
  w2.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w2.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx2 = makeCtx(w2);
  t.after(() => ctx2.memory.close());
  const absolute = await moveStep.run(ctx2, { at: [0, 0, 0], facing: 'N', xyz: { x: 1, y: 63.5, z: 0 } });
  assert.equal(absolute.status, 'succeeded', absolute.summary);
  assert.equal(w2.pos.y, 63.5);
});

test('move_step 不自动改落点：目标列下方多格才有地面时拒绝', async (t) => {
  const w = flat();
  for (const key of ['1,63,0', '1,62,0']) w.removed.add(key);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.match(r.summary, /descend_to|可站立面/);
});

test('move_step 绝对脚高与真实支撑不符时拒绝，不悄悄改落点', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const before = { ...w.pos };
  const r = await moveStep.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 64, z: 0 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.equal(r.data?.actualSupport, 63.5);
  assert.deepEqual(w.pos, before);
});

test('move_step 同列向上只能沿梯子', () => {
  const w = flat();
  const bad = moveStep.validate({ to: [0, 1, 0], facing: 'E' }, w);
  assert.equal(bad.ok, false);
  w.blocks.push({ name: 'ladder', pos: { x: 0, y: 64, z: 0 } });
  const good = moveStep.validate({ to: [0, 1, 0], facing: 'E' }, w);
  assert.ok(good.ok, !good.ok ? good.error : '');
});

test('mine_cell：只挖指定格，液体邻格默认拒绝，wet 显式接受', async (t) => {
  const w = pocket();
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -1 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 60, z: -1 }), 'air');

  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -2 }, });
  w.blocks.push({ name: 'water', pos: { x: 0, y: 60, z: -3 } });
  ctx.senses.observeBlocks = visibleTargets(w);
  const wet = await mineCell.run(ctx, { at: [2, 0, 0], facing: 'N' });
  assert.equal(wet.status, 'failed');
  assert.match(wet.summary, /water/);
});

test('mine_cell 不做未观察的推测：目标看不见时返回未知且不挖', async (t) => {
  const w = pocket();
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -1 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(w.blockAt({ x: 0, y: 60, z: -1 }), 'stone', '未观察的格子不能被挖');
  assert.equal(r.data?.unknown, true);
});

test('place_cell：放置请求的材料，已有不同材料只报占用', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const ok = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(ok.status, 'succeeded', ok.summary);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
  const again = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(again.status, 'succeeded');
  assert.equal(again.data?.noop, true);
  const wrong = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'dirt' });
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.summary, /占据/);
});

test('place_support：已有可站立顶面不消耗材料；空支撑格才放', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const existing = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(existing.status, 'succeeded', existing.summary);
  assert.equal(existing.data?.noop, true);
  assert.equal(w.inv.get('cobblestone'), 2);

  w.removed.add('1,63,0');
  const placed = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'cobblestone');
  assert.equal(w.inv.get('cobblestone'), 1);
});

test('place_support 支持脚下方两格', async (t) => {
  const w = flat();
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -2, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 62, z: 0 }), 'cobblestone');
});

test('pillar_one：垫高一级；头顶受阻时返回具体失败', async (t) => {
  const w = pocket();
  w.removed.add('0,62,0');
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.y), 61);
  assert.equal(w.blockAt({ x: 0, y: 60, z: 0 }), 'cobblestone');

  w.blocks.push({ name: 'stone', pos: { x: 0, y: 62, z: 0 } });
  const blocked = await pillarOne.run(ctx, {});
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.summary, /头顶|跳跃空间/);
});
