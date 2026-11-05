import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ride } from '../src/skills/actions.ts';
import { planBoatRoute } from '../src/skills/vehicles.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

/** 一大片水（x 0..20, z -5..5，水面 y=63），中间 x=10 是一道墙，只在 z=0 留一条 1 格宽的缝 */
function walledLake(a: FakeAdapter) {
  for (let x = 0; x <= 20; x++) for (let z = -5; z <= 5; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  for (let z = -5; z <= 5; z++) {
    if (z === 0) continue;
    a.blocks.push({ name: 'stone', pos: { x: 10, y: 63, z } }, { name: 'stone', pos: { x: 10, y: 64, z } });
  }
}

test('planBoatRoute treats a 1-wide gap as impassable instead of a costly shortcut', () => {
  const a = new FakeAdapter();
  walledLake(a);
  a.pos = { x: 5.5, y: 63.9, z: 0.5 };
  const ctx = makeCtx(a, { senses: { knownBlocks: () => [], observeBlocks: () => [] } });
  const route = planBoatRoute(ctx, a.pos, { x: 15.5, z: 0.5 }, {});
  // 船身 1.375 格宽，1 格宽的缝挤不过去：路线不能把 (10,0) 当路，也不能假装到了对岸
  assert.ok(route, '起点在水上，应能规划出路线');
  assert.ok(route.waypoints.every((w) => !(Math.floor(w.x) === 10 && Math.floor(w.z) === 0)), '不应穿过 1 格宽的缝');
  assert.equal(route.reach, 'partial', '缝挤不过去，水路到不了对岸，应如实报 partial');
});

test('ride cancellation keeps the measured partial position and original boat request', async (t) => {
  const a = new FakeAdapter();
  walledLake(a);
  a.pos = { x: 5.5, y: 63.9, z: 0.5 };
  a.riding = 'oak_boat';
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  t.mock.method(a, 'ride', async () => {
    a.pos = { x: 7.5, y: 63.9, z: 0.5 };
    throw new AbortedError('task cancelled');
  });
  let caught: (Error & { partial?: { nav: Record<string, unknown>; originalRequest: unknown; backend: string } }) | undefined;
  try { await ride.run(ctx, { to: { x: 15.5, z: 0.5 }, distance: 48 }); } catch (e) { caught = e as typeof caught; }
  assert.ok(caught, '取消仍抛出 AbortedError');
  const partial = caught.partial!;
  assert.equal(partial.nav.outcome, 'CANCELLED');
  assert.equal(partial.nav.confirmed, false);
  assert.deepEqual(partial.nav.lastPosition, { x: 7.5, y: 63.9, z: 0.5 });
  assert.deepEqual(partial.nav.resolvedTarget, { x: 15.5, z: 0.5 });
  assert.deepEqual(partial.originalRequest, { to: { x: 15.5, z: 0.5 }, distance: 48 });
  assert.equal(partial.nav.backend, 'vehicle_ride');
});

test('planBoatRoute still crosses a 2-wide channel', () => {
  const a = new FakeAdapter();
  walledLake(a);
  // 把 z=-1 也改成水：缝从 1 格宽变成 2 格宽（船能过）
  a.blocks = a.blocks.filter((b) => !(b.pos.x === 10 && b.pos.z === -1 && b.name === 'stone'));
  a.blocks.push({ name: 'water', pos: { x: 10, y: 63, z: -1 } });
  a.pos = { x: 5.5, y: 63.9, z: -0.5 };
  const ctx = makeCtx(a, { senses: { knownBlocks: () => [], observeBlocks: () => [] } });
  const route = planBoatRoute(ctx, a.pos, { x: 15.5, z: -0.5 }, {});
  assert.ok(route, '2 格宽的水道应能规划出路线');
  assert.equal(route.reach, 'water', '2 格宽的水道船能通过，应能到对岸');
});
