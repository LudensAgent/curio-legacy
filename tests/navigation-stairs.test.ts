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

function setup(map: VoxelMap, pos = { x: 0.5, y: 64, z: 0.5 }) {
  const adapter = new FakeAdapter();
  adapter.pos = { ...pos };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

test('navigate_to walks a half-slab step down/up with fractional feet heights', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 3; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', Array.from({ length: 5 }, (_, x) => ({ x: x - 1, y: 63, z: 0 })));
  fill(map, 'minecraft:stone_slab', [{ x: 1, y: 63, z: 0 }], { type: 'bottom' });

  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const validated = navigateTo.validate({
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.y, 64);
  const transitions = result.data?.transitions as { kind: string; from: { y: number }; to: { y: number } }[] | undefined;
  assert.ok(transitions?.some((transition) => transition.from.y === 64 && transition.to.y === 63.5), 'must step down onto the slab');
  assert.ok(transitions?.some((transition) => transition.from.y === 63.5 && transition.to.y === 64), 'must step up off the slab');
});

test('navigate_to performs a one-block step up through the measured body path', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 64; y <= 67; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:stone', [{ x: 1, y: 64, z: 0 }]);

  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const validated = navigateTo.validate({
    to: { x: 1, y: 65, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.y, 65);
  const transitions = result.data?.transitions as { kind: string; from: { y: number }; to: { y: number } }[] | undefined;
  assert.ok(transitions?.some((transition) => transition.kind === 'step' && transition.from.y === 64 && transition.to.y === 65));
});
