import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { lookAround } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('directional observation rejects remembered or opposite targets and distinguishes a new sighting', async (t) => {
  // Only advance awaited skill pauses; no physics, pathfinding or real waiting.
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
  const adapter = new TestWorld();
  const oldNorth = { name: 'stone', pos: { x: 0, y: 64, z: -5 }, dist: 5 };
  const hiddenSouth = { name: 'stone', pos: { x: 0, y: 64, z: 6 }, dist: 6 };
  const newSouth = { name: 'stone', pos: { x: 2, y: 64, z: 5 }, dist: 5 };
  let views = 0, visible = true;
  const ctx = makeCtx(adapter, { senses: {
    knownBlocks: (names) => names.includes('stone') ? [oldNorth, hiddenSouth, ...(views >= 2 && visible ? [newSouth] : [])] : [],
    observeBlocks: (positions) => positions.filter((p) => visible && views >= 2 && p.x === 2).map((pos): BlockObservation => ({
      name: 'stone', properties: {}, pos, worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim,
      observationId: views, observedAt: Date.now(), source: 'vision',
    })),
  } });
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'look', async () => { views++; });
  const found = await lookAround.run(ctx, { for: 'stone', direction: 'S', seconds: 2 });
  assert.equal(found.status, 'succeeded');
  assert.match(found.summary, /位置 \(2,64,5\)/, '看见的位置要进摘要，不能只给方向和距离');
  assert.equal(views, 2, 'neither north nor remembered south stone can short-circuit looking');
  assert.equal(found.data?.newlyDiscovered, true);
  assert.equal(found.data?.directionInspected, true);
  assert.equal(found.data?.alreadyVisible, false);
  assert.equal(found.data?.turned, true);
  assert.deepEqual(found.data?.foundPos, newSouth.pos);
  assert.deepEqual(found.data?.finalView, { yaw: adapter.eye()!.yaw, pitch: adapter.eye()!.pitch });
  const known = await lookAround.run(ctx, { for: 'stone', direction: 'S', seconds: 2 });
  assert.equal(views, 2, 'a currently visible target in the requested direction needs no extra turn');
  assert.equal(known.data?.alreadyVisible, true); assert.equal(known.data?.newlyDiscovered, false);
  assert.equal(known.data?.turned, false);
  assert.deepEqual(known.data?.foundPos, newSouth.pos);
  assert.match(known.summary, /没有转头/);
  assert.match(known.summary, /位置 \(2,64,5\)/);
  visible = false;
  const missing = await lookAround.run(ctx, { for: 'stone', direction: 'S', seconds: 2 });
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.equal(missing.data?.searched, true);
  assert.equal(lookAround.outcomeBoundary, true, 'actual observation remains a decision boundary');
});
