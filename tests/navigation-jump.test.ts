import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], properties: Record<string, string> = {}) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: { name, properties }, pos,
    });
  }
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

test('navigate_to crosses an observed one-cell gap with an explicit horizontal jump', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  // Both platforms have a standable top at feet y=64; x=0 has no support.
  fill(map, 'minecraft:stone', [{ x: -1, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }]);

  const adapter = new FakeAdapter();
  adapter.pos = { x: -0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 1, y: 64, z: 0 }, allowed: ['jump'], historical: false, maxSteps: 4,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.x, 1.5);
  assert.equal(adapter.pos.y, 64);
  const transitions = result.data?.transitions as { kind: string; from: { x: number }; to: { x: number } }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.from.x, transition.to.x]), [
    ['jump', -0.5, 1.5],
  ]);
  assert.ok(adapter.actions.includes('moveTo:feet'), 'horizontal jump must use measured feet body control');
  assert.equal(adapter.actions.filter((action) => action.startsWith('moveTo:')).length, 1,
    'a jump transition is dispatched exactly once, not repeated by a generic feet move');
});
