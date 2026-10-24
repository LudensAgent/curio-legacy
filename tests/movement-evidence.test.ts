import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { goTo, lookAround } from '../src/skills/movement.ts';
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
  assert.equal(views, 2, 'neither north nor remembered south stone can short-circuit looking');
  assert.equal(found.data?.newlyDiscovered, true);
  assert.equal(found.data?.directionInspected, true);
  assert.equal(found.data?.alreadyVisible, false);
  const known = await lookAround.run(ctx, { for: 'stone', direction: 'S', seconds: 2 });
  assert.equal(views, 2, 'a currently visible target in the requested direction needs no extra turn');
  assert.equal(known.data?.alreadyVisible, true); assert.equal(known.data?.newlyDiscovered, false);
  visible = false;
  const missing = await lookAround.run(ctx, { for: 'stone', direction: 'S', seconds: 2 });
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.equal(missing.data?.searched, true);
  assert.equal(lookAround.outcomeBoundary, true, 'actual observation remains a decision boundary');
});

test('coordinate goto requires the target cell and reports measured movement including a no-op', async (t) => {
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
  for (const moves of [false, true]) {
    const adapter = new TestWorld(); adapter.pos = { x: 25.45, y: 77, z: -21.2 };
    const ctx = makeCtx(adapter); t.after(() => ctx.memory.close());
    let calls = 0;
    t.mock.method(adapter, 'moveTo', async (target) => {
      calls++; assert.equal(target.kind, 'near');
      if (target.kind === 'near') assert.equal(target.range, 0, 'pathfinder must enter the coordinate cell');
      if (moves) adapter.pos = { x: 24.5, y: 77, z: -21.5 };
    });
    const result = await goTo.run(ctx, { target: '24,77,-22' });
    assert.equal(calls, 1, 'an adjacent cell is not already at the destination');
    assert.equal(result.status, moves ? 'succeeded' : 'failed');
    assert.equal(result.data?.arrivedCell, moves);
    assert.deepEqual(result.data?.targetCell, { x: 24, y: 77, z: -22 });
    assert.equal(result.data?.moved === 0, !moves);
    if (moves) {
      assert.ok((result.data?.moved as number) > .9, 'half-block node centers are valid arrival positions');
      const again = await goTo.run(ctx, { target: '24,77,-22' });
      assert.equal(calls, 1); assert.equal(again.data?.alreadyHere, true); assert.equal(again.data?.moved, 0);
      assert.match(again.summary, /没有执行新的位移/);
    }
  }
});
