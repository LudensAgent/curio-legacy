import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/index.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
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

test('travel_to continues up observed stairs with real landing residuals without spending a search per step', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const cells = Array.from({ length: 13 }, (_, x) =>
    Array.from({ length: 3 }, (_, z) =>
      Array.from({ length: 16 }, (_, y) => ({ x: x - 8, y: y + 63, z: z - 2 })))).flat(2);
  fill(map, 'minecraft:air', cells);
  fill(map, 'minecraft:stone', Array.from({ length: 11 }, (_, x) => ({ x: x - 8, y: x + 63, z: -1 })));
  const { adapter, ctx } = setup(map, { x: -7.5, y: 64, z: -0.5 });
  t.after(() => ctx.memory.close());
  const targets: { x: number; y: number; z: number }[] = [];
  t.mock.method(adapter, 'moveTo', async (target) => {
    assert.equal(target.kind, 'feet');
    if (target.kind !== 'feet') return;
    targets.push({ x: target.x, y: target.y, z: target.z });
    // 日志中的每次落脚约差 0.032 格，另有很小的横向误差。
    adapter.pos = { x: target.x - 0.0324, y: target.y, z: target.z + 0.00015 };
  });
  const validation = travelTo.validate({ to: { x: 2, y: 74, z: -1 }, range: 1 }, adapter);
  assert.ok(validation.ok, validation.ok ? '' : validation.error);
  const result = await travelTo.run(ctx, validation.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(targets.length, 10, '应走完整段阶梯，不在第 6 次搜索时停止');
  assert.equal((result.data?.counters as { searches: number }).searches, 1);
  assert.deepEqual(targets.at(-1), { x: 2.5, y: 74, z: -0.5 }, '保留计划落点，不随残余误差逐步漂移');
  assert.deepEqual(result.data?.position, adapter.pos, '回执保留实际落脚，不用计划点覆盖');
});
