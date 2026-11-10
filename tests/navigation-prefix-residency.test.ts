import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { feetGoal } from '../src/skills/movement/goal.ts';
import { runNavigationSegment, type SegmentRequest } from '../src/skills/movement/segment.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('manual navigation walks the resident prefix before loading the next saved section', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.speed = 100_000;
  const { worldId, dim, sessionId } = adapter.state();
  const directory = mkdtempSync(join(tmpdir(), 'nav-prefix-'));
  const spatial = await SharedSpatialSession.open({
    worldId, databasePath: join(directory, 'world.db'), voxelLoading: 'manual', voxelValidityWindowMs: 60_000,
  });
  t.after(async () => {
    const { close } = await spatial.shutdown();
    if (close?.completed && !close.unconfirmedRequest) rmSync(directory, { recursive: true, force: true });
  });
  spatial.beginSession({ worldId, dim, sessionId });
  let id = 0;
  const observe = async (start: number) => {
    const observedAt = Date.now();
    spatial.observe(Array.from({ length: 32 - start }, (_, offset) => [63, 64, 65].map(y => ({
      worldId, dimension: dim, sessionId, observationId: ++id, observedAt, source: 'vision' as const,
      pos: { x: start + offset, y, z: 0 }, name: y === 63 ? 'stone' : 'air', properties: {}, stateComplete: true,
    }))).flat());
    await spatial.drainObservations({ deadline: Date.now() + 5000 });
  };
  await observe(0);
  await spatial.checkpoint();
  const nextPage = [3, 4].map(sy => ({ worldId, dim, cx: 1, cz: 0, sy }));
  assert.equal(spatial.session.unloadSections(nextPage).unloaded.length, 2);
  const ctx = { ...makeCtx(adapter), spatial };
  t.after(() => ctx.memory.close());
  const request: SegmentRequest = {
    goal: feetGoal({ x: 31.5, y: 64, z: 0.5 }), allowed: ['walk'], historical: true,
    maxTransitions: 64, allowUnknownCorridor: false, deadline: Date.now() + 20_000, searchBudget: 16,
  };

  const prefix = await runNavigationSegment(ctx, request);
  assert.equal(prefix.confirmed.length, 15, prefix.detail);
  assert.equal(prefix.searches, 1, 'fresh, resident steps can execute on the first search');
  assert.ok(nextPage.every(key => spatial.session.sectionResidency(key).residency === 'not_resident'));

  const boundary = await runNavigationSegment(ctx, request);
  assert.ok(boundary.searches >= 2, 'at the frontier the missing saved pages must be loaded and searched');
  assert.ok(nextPage.every(key => spatial.session.sectionResidency(key).residency === 'resident'));
  assert.equal(boundary.confirmed.length, 0, 'loaded historical evidence still needs a current observation');
  await observe(16);
  const arrived = await runNavigationSegment(ctx, request);
  assert.equal(arrived.arrived, true, arrived.detail);
  assert.deepEqual(arrived.measuredEnd, request.goal.requested);
  assert.equal(spatial.workingSetStats().pinnedLeases, 0);
});
