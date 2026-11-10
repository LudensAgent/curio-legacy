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
  assert.ok(adapter.actions.some((action) => action === 'moveTo:ladder'), 'ladder body control must use the strict ladder target');
  assert.equal(adapter.actions.filter((action) => action.startsWith('moveTo:')).length, 2,
    'each ladder transition is dispatched exactly once; no second feet move after climbing');
});

test('navigate_to completes on a ladder while the body is not onGround', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }], { facing: 'north' });

  class AirborneLadderAdapter extends FakeAdapter {
    override state() { return { ...super.state(), onGround: false }; }
  }
  const adapter = new AirborneLadderAdapter();
  adapter.pos = { x: 0.5, y: 66, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  // The live adapter must also report the ladder source; goal completion prefers
  // current loaded contact over remembered geometry.
  adapter.blocks.push(
    { name: 'stone', pos: { x: 0, y: 63, z: 0 } },
    { name: 'ladder', pos: { x: 0, y: 64, z: 0 } },
    { name: 'ladder', pos: { x: 0, y: 65, z: 0 } },
    { name: 'ladder', pos: { x: 0, y: 66, z: 0 } },
  );
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 0, y: 64, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.y, 64);
  assert.equal(adapter.state().onGround, false);
});

test('stale ladder memory cannot excuse an airborne arrival', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const old = Date.now() - 120_000;
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: old, sequence: 1,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'minecraft:ladder', properties: { facing: 'north' } },
    pos: { x: 0, y: 64, z: 0 },
  });

  class AirborneAdapter extends FakeAdapter {
    override state() { return { ...super.state(), onGround: false }; }
  }
  const adapter = new AirborneAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
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
  assert.notEqual(result.status, 'succeeded', result.summary);
});

test('navigate_to enters a hanging ladder from ground and exits onto an adjacent platform', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 69; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: -1, y: 63, z: 0 }, { x: 1, y: 64, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }], { facing: 'north' });

  const adapter = new FakeAdapter();
  adapter.pos = { x: -0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 1, y: 65, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.x, 1.5);
  assert.equal(adapter.pos.y, 65);
  const transitions = result.data?.transitions as { kind: string; from: { x: number; y: number }; to: { x: number; y: number } }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.from.x, transition.from.y, transition.to.x, transition.to.y]), [
    ['ladder', -0.5, 64, 0.5, 64],
    ['ladder', 0.5, 64, 0.5, 65],
    ['ladder', 0.5, 65, 1.5, 65],
  ]);
});

test('navigate_to exits from the air cell above a ladder top onto a platform', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 69; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: -1, y: 63, z: 0 }, { x: 1, y: 64, z: 0 }]);
  // Only one ladder block: after climbing to y=65 the feet are in air above it.
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }], { facing: 'north' });

  const adapter = new FakeAdapter();
  adapter.pos = { x: -0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 1, y: 65, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.pos.x, 1.5);
  assert.equal(adapter.pos.y, 65);
  const transitions = result.data?.transitions as { kind: string; from: { x: number; y: number }; to: { x: number; y: number } }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.from.x, transition.from.y, transition.to.x, transition.to.y]), [
    ['ladder', -0.5, 64, 0.5, 64],
    ['ladder', 0.5, 64, 0.5, 65],
    ['ladder', 0.5, 65, 1.5, 65],
  ]);
});

test('navigate_to reports ladder cancellation with the measured partial position', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }], { facing: 'north' });

  const controller = new AbortController();
  class AbortOnLadderAdapter extends FakeAdapter {
    override async moveTo(target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) {
      if (target.kind === 'ladder') setTimeout(() => controller.abort(), 60);
      return super.moveTo(target, opts);
    }
  }
  const adapter = new AbortOnLadderAdapter();
  adapter.pos = { x: 0.5, y: 66, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 1;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map), signal: controller.signal };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 0, y: 64, z: 0 }, allowed: ['ladder'], historical: false, maxSteps: 8,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'cancelled', result.summary);
  assert.ok(adapter.pos.y < 66 && adapter.pos.y > 64, `partial ladder position preserved: ${adapter.pos.y}`);
  assert.equal(adapter.pos.x, 0.5);
});

test('navigate_to stops when a ladder cell changes before the next measured step', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 1; x++) for (let y = 64; y <= 68; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  fill(map, 'minecraft:ladder', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }], { facing: 'north' });

  class MutatingAdapter extends FakeAdapter {
    changed = false;
    override async moveTo(target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) {
      await super.moveTo(target, opts);
      if (target.kind === 'ladder' && !this.changed) {
        this.changed = true;
        // The already-confirmed first step is kept; the next ladder cell is
        // gone in the newer observation and must not be executed.
        fill(map, 'minecraft:air', [{ x: 0, y: 65, z: 0 }]);
      }
    }
  }
  const adapter = new MutatingAdapter();
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
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(adapter.pos.y, 65);
  assert.match(result.summary, /仍未到达/);
});
