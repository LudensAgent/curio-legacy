import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { navigateTo } from '../src/skills/movement/index.ts';
import type { SegmentReceipt } from '../src/skills/movement/segment.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

function setup() {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const voxel = new VoxelMap(adapter.worldId, { validityWindowMs: 60_000 });
  let sequence = 0;
  const observe = (pos: { x: number; y: number; z: number }, observedAt = Date.now()) => {
    const name = pos.y < 64 ? 'minecraft:stone' : 'minecraft:air';
    voxel.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt, sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos });
    return { pos, name, properties: {}, stateComplete: true, worldId: adapter.worldId,
      sessionId: adapter.sessionId, dimension: adapter.dim, observationId: sequence,
      observedAt, source: 'vision' as const };
  };
  Array.from({ length: 5 }, (_, x) => x - 1).forEach((x) =>
    Array.from({ length: 3 }, (_, z) => z - 1).forEach((z) =>
      [63, 64, 65, 66].forEach((y) => observe({ x, y, z }, Date.now() - 61_000))));
  const controller = new AbortController();
  const ctx = { ...makeCtx(adapter), signal: controller.signal,
    spatial: { worldId: adapter.worldId, session: { voxel } } as unknown as SharedSpatialSession };
  return { adapter, ctx, observe, controller };
}

const args = { to: { x: 1, y: 64, z: 0 }, allowed: ['walk'] as ['walk'],
  historical: true, maxSteps: 8, maxSegments: 1, allowUnknownCorridor: false };

test('a stale start refreshes current evidence before historical search without spending its body window', async (t) => {
  const { adapter, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  ctx.senses.observeBlocks = (positions) => positions.map((pos) => observe(pos));

  const result = await navigateTo.run(ctx, args);
  const counters = result.data?.counters as { segments: number; searches: number; observations: number };
  const segment = result.data?.lastSegment as SegmentReceipt;

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(counters.segments, 2);
  assert.equal(counters.searches, 2, 'one initial current search and one after observation, without searching history');
  assert.equal(counters.observations, 1);
  assert.equal(segment.confirmed.length, 1, 'evidence refresh leaves the requested body window available');
  assert.equal(Math.floor(adapter.pos.x), 1);
});

test('a stale start with no new visible evidence stops without replaying history or moving', async (t) => {
  const { adapter, ctx } = setup();
  t.after(() => ctx.memory.close());
  ctx.senses.observeBlocks = () => [];

  const result = await navigateTo.run(ctx, args);
  const counters = result.data?.counters as { segments: number; searches: number };
  const segment = result.data?.lastSegment as SegmentReceipt;

  assert.equal(result.status, 'failed');
  assert.equal(counters.segments, 1);
  assert.equal(counters.searches, 1);
  assert.equal(segment.confirmed.length, 0);
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
});

test('cancellation during stale evidence refresh prevents any later movement', async (t) => {
  const { adapter, ctx, observe, controller } = setup();
  t.after(() => ctx.memory.close());
  ctx.senses.observeBlocks = (positions) => {
    controller.abort();
    return positions.map((pos) => observe(pos));
  };

  const result = await navigateTo.run(ctx, args);

  assert.equal(result.status, 'cancelled', result.summary);
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
});

test('ongoing perception can resolve a search boundary before explicit observation begins', async (t) => {
  const { adapter, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  let refreshed = false;
  ctx.setStationaryWait = (waiting) => {
    if (waiting || refreshed) return;
    refreshed = true;
    Array.from({ length: 5 }, (_, x) => x - 1).forEach((x) =>
      Array.from({ length: 3 }, (_, z) => z - 1).forEach((z) =>
        [63, 64, 65, 66].forEach((y) => observe({ x, y, z }))));
  };
  ctx.senses.observeBlocks = () => { assert.fail('already current geometry needs no redundant turn or observation'); };

  const result = await navigateTo.run(ctx, args);

  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(adapter.pos, { x: 1.5, y: 64, z: 0.5 });
  const counters = result.data?.counters as { searches: number; observations: number };
  assert.equal(counters.searches, 2);
  assert.equal(counters.observations, 0);
});
