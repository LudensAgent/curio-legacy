import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { pickupItems } from '../src/skills/survival.ts';
import { throwIfAborted } from '../src/util.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

function ctxWith(opts: { picks: boolean; target?: Vec3Like }) {
  const world = new TestWorld(), forgot: number[] = [], moves: MoveTarget[] = [];
  world.inv.set('dirt', 3);
  world.moveTo = async (goal, options) => {
    throwIfAborted(options.signal);
    moves.push(goal);
    if ('pos' in goal) world.pos = { ...goal.pos };
    if (opts.picks) world.inv.set('white_bed', 1);
  };
  let memoryReads = 0;
  const ctx = makeCtx(world, { senses: {
    recentDrops: () => {
      memoryReads++;
      return forgot.includes(7) ? [] : [{ id: 7, name: 'white_bed', pos: opts.target ?? { x: 3, y: 64, z: -3 }, ageMs: 4000 }];
    },
    forgetDrop: (id) => forgot.push(id),
  } });
  return { ctx, world, moves, forgot, memoryReads: () => memoryReads };
}

test('pickup_items validates remembered as an explicit boolean permission', () => {
  const world = new TestWorld();
  assert.deepEqual(pickupItems.validate({}, world), { ok: true, args: { radius: 12 } });
  assert.deepEqual(pickupItems.validate({ remembered: false }, world), { ok: true, args: { radius: 12 } });
  assert.deepEqual(pickupItems.validate({ remembered: true }, world), { ok: true, args: { radius: 12, remembered: true } });
  assert.equal(pickupItems.validate({ remembered: 'true' }, world).ok, false);
});

test('pickup_items does not walk back to remembered drops without permission', async (t) => {
  const w = ctxWith({ picks: true });
  t.after(() => w.ctx.memory.close());
  const result = await pickupItems.run(w.ctx, { radius: 12 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(w.moves, []);
  assert.equal(w.memoryReads(), 0, 'unselected memories do not become pickup targets');
  assert.equal(w.world.inv.has('white_bed'), false);
});

test('pickup_items: explicitly permitted remembered pickup reports the actual inventory result', async (t) => {
  const a = ctxWith({ picks: true });
  t.after(() => a.ctx.memory.close());
  const result = await pickupItems.run(a.ctx, { radius: 12, item: 'white_bed', remembered: true });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.match(result.summary, /white_bed×1/);
  assert.deepEqual(a.moves, [{ kind: 'near', pos: { x: 3, y: 64, z: -3 }, range: 1 }]);

  const b = ctxWith({ picks: false });
  t.after(() => b.ctx.memory.close());
  const missing = await pickupItems.run(b.ctx, { radius: 12, item: 'white_bed', remembered: true });
  assert.equal(missing.status, 'failed', missing.summary);
  assert.match(missing.summary, /没有捡到/);
  assert.deepEqual(b.forgot, [7], 'at the location but still unseen: forget the missing drop');
});

test('pickup_items: 指名没找到时提示 remembered:true，但不自行走回记忆点', async (t) => {
  const w = ctxWith({ picks: false });
  t.after(() => w.ctx.memory.close());
  const result = await pickupItems.run(w.ctx, { radius: 12, item: 'white_bed' });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /remembered:true/);
  assert.equal(w.memoryReads(), 0, '没有显式许可就不使用记忆点');
});

test('remembered pickup respects the declared three-dimensional radius without adding eight blocks', async (t) => {
  for (const target of [{ x: 7, y: 64, z: 0 }, { x: 0, y: 71, z: 0 }, { x: 5, y: 68, z: 0 }]) {
    const w = ctxWith({ picks: true, target });
    t.after(() => w.ctx.memory.close());
    await pickupItems.run(w.ctx, { radius: 6, remembered: true });
    assert.deepEqual(w.moves, [], JSON.stringify(target));
    assert.equal(w.world.inv.has('white_bed'), false);
  }
  const edge = ctxWith({ picks: true, target: { x: 6, y: 64, z: 0 } });
  t.after(() => edge.ctx.memory.close());
  await pickupItems.run(edge.ctx, { radius: 6, remembered: true });
  assert.equal(edge.moves.length, 1, 'the declared boundary itself remains allowed');
});

test('visible pickup does not expand its search area after walking to the first drop', async (t) => {
  const world = new TestWorld();
  world.entities = [
    { id: 1, name: 'item:cobblestone', kind: 'item', pos: { x: 5, y: 64, z: 0 }, dist: 5, height: 0.25 },
    { id: 2, name: 'item:cobblestone', kind: 'item', pos: { x: 10, y: 64, z: 0 }, dist: 10, height: 0.25 },
  ];
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  const result = await pickupItems.run(ctx, { radius: 6 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(world.inv.get('cobblestone'), 1);
  assert.equal(world.pos.x, 5);
  assert.deepEqual(world.entities.map((e) => e.id), [2], 'the second drop is nearby now, but outside the original delegation');
});

test('remembered pickup also stays within the original radius after a visible pickup', async (t) => {
  const world = new TestWorld();
  world.entities = [{ id: 1, name: 'item:cobblestone', kind: 'item', pos: { x: 5, y: 64, z: 0 }, dist: 5, height: 0.25 }];
  const ctx = makeCtx(world, { senses: {
    recentDrops: () => [{ id: 2, name: 'white_bed', pos: { x: 10, y: 64, z: 0 }, ageMs: 4000 }],
  } });
  t.after(() => ctx.memory.close());
  const result = await pickupItems.run(ctx, { radius: 6, remembered: true });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(world.inv.get('cobblestone'), 1);
  assert.equal(world.pos.x, 5);
  assert.equal(result.data?.visits, 1);
});
