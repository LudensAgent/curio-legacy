import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { boundaryProbeCells, observeBoundary } from '../src/skills/movement/observation.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const boundary = {
  from: { x: -504.58, y: 105, z: -291.56 },
  to: { x: -504.58, y: 104.9375, z: -292.56 },
  kind: 'drop' as const, status: 'STALE' as const,
  reason: 'required evidence is marked stale', direction: 'N' as const,
};
const key = (pos: Vec3Like) => `${pos.x},${pos.y},${pos.z}`;

function setup() {
  const adapter = new FakeAdapter();
  adapter.pos = { ...boundary.from };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 60_000 });
  const ctx = { ...makeCtx(adapter), spatial: {
    worldId: adapter.worldId, session: { voxel: map },
  } as unknown as SharedSpatialSession };
  let sequence = 0;
  const observe = (pos: Vec3Like, observedAt = Date.now()) => {
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt, sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: 'minecraft:air', properties: {} }, pos });
    return { pos, name: 'minecraft:air', properties: {}, stateComplete: true,
      worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim,
      observationId: sequence, observedAt, source: 'vision' as const };
  };
  return { adapter, map, ctx, observe };
}

test('seeing fresh nearby cells still turns once toward the unresolved boundary cell', async (t) => {
  const { adapter, map, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell, Date.now() - 1000));
  map.markStale(adapter.dim, 'observation_gap');
  // Interruption restoration requires observations strictly after its timestamp.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const stale = cells[1]!;
  cells.filter((cell) => key(cell) !== key(stale)).forEach((cell) => observe(cell));
  let reads = 0;
  const looks: { yaw: number; pitch: number }[] = [];
  t.mock.method(adapter, 'look', async (yaw: number, pitch: number) => { looks.push({ yaw, pitch }); });
  ctx.senses.observeBlocks = () => {
    reads += 1;
    return looks.length ? [observe(stale)] : [observe(cells[0]!)];
  };

  const result = await observeBoundary(ctx, { boundary, maxCells: 32 });

  assert.equal(reads, 2, 'fresh cells in view must not suppress a turn toward the missing evidence');
  assert.equal(looks.length, 1, 'frontier observation stays bounded to one turn');
  const eye = adapter.eye()!;
  const dx = stale.x + 0.5 - eye.x, dy = stale.y + 0.5 - eye.y, dz = stale.z + 0.5 - eye.z;
  assert.equal(looks[0]!.yaw, Math.atan2(-dx, -dz));
  assert.equal(looks[0]!.pitch, Math.atan2(dy, Math.hypot(dx, dz)));
  assert.equal(result.turned, true);
  assert.deepEqual(result.relatedCells, [stale]);
});

test('refreshing expired unchanged evidence enables replanning without a content revision', async (t) => {
  const { map, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell));
  const expired = { x: -505, y: 104, z: -293 };
  // Use a separate never-written cell so its original observation can be old.
  const expiredBoundary = { ...boundary, to: { x: -510.58, y: 104.9375, z: -292.56 } };
  expired.x = Math.floor(expiredBoundary.to.x);
  observe(expired, Date.now() - 61_000);
  const before = map.cellAt('overworld', expired.x, expired.y, expired.z);
  assert.ok(before.observed);
  ctx.senses.observeBlocks = () => [observe(expired)];

  const result = await observeBoundary(ctx, { boundary: expiredBoundary, maxCells: 32 });
  const after = map.cellAt('overworld', expired.x, expired.y, expired.z);
  assert.ok(after.observed);
  assert.equal(after.evidence.revision, before.evidence.revision);
  assert.equal(result.relatedChanged, true, 'expired-to-current is new usable evidence');
  assert.ok(result.relatedCells.some((cell) => key(cell) === key(expired)));
});

test('refreshing still-current unchanged evidence neither turns nor authorizes a new search', async (t) => {
  const { adapter, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell, Date.now() - 1000));
  let turns = 0;
  t.mock.method(adapter, 'look', async () => { turns += 1; });
  ctx.senses.observeBlocks = () => cells.map((cell) => observe(cell));

  const result = await observeBoundary(ctx, { boundary, maxCells: 32 });

  assert.equal(turns, 0);
  assert.equal(result.relatedChanged, false);
});
