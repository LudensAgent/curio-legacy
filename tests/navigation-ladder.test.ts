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
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

test('navigate_to descends an explicitly allowed ladder column with measured feet', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }], { facing: 'north' });

  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 66, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 0, y: 64, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.y, 64);
  const transitions = result.data?.transitions as { kind: string; from: { y: number }; to: { y: number } }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.from.y, transition.to.y]), [
    ['ladder', 66, 65],
    ['ladder', 65, 64],
  ]);
});

test('navigate_to climbs an explicitly allowed ladder column with measured feet', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }], { facing: 'north' });

  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 0, y: 66, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.y, 66);
  const transitions = result.data?.transitions as { kind: string; from: { y: number }; to: { y: number } }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.from.y, transition.to.y]), [
    ['ladder', 64, 65],
    ['ladder', 65, 66],
  ]);
  assert.ok(adapter.actions.some((action) => action === 'moveTo:xyz'), 'ladder body control must use the explicit xyz target');
});
