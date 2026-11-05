import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { goTo } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const start = () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.pitch = -0.18;
  return adapter;
};

test('goto sends pathfinder straight to the target without vision waypoints', async (t) => {
  const adapter = start();
  const moves: MoveTarget[] = [];
  const ctx = makeCtx(adapter, { senses: { navigationWaypoint: () => { throw new Error('vision waypoint must not be used for walking'); } } });
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async (target, opts) => {
    moves.push(target);
    assert.equal(opts.allowTerrainChanges, undefined);
    assert.equal(target.kind, 'near');
    if (target.kind === 'near') adapter.pos = { ...target.pos };
  });
  const result = await goTo.run(ctx, { target: '10,64,0' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves.length, 1);
  assert.deepEqual(adapter.pos, { x: 10, y: 64, z: 0 });
});

test('a pathfinder resolution without movement cannot claim arrival', async (t) => {
  const adapter = start();
  const ctx = makeCtx(adapter, { senses: { navigationWaypoint: () => ({ x: 4.5, y: 64, z: 0.5 }) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(adapter, 'moveTo', async () => {});
  const result = await goTo.run(ctx, { target: '8,64,0' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(move.mock.callCount(), 1);
  assert.deepEqual(result.data?.position, adapter.pos);
});

test('goto walks through a closed wooden door via the pathfinder, without digging', async (t) => {
  const adapter = start(), door = { x: 2, y: 64, z: 0 };
  adapter.setBlock(door, 'oak_door');
  adapter.blockProperties.set('2,64,0', { open: false, half: 'lower' });
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async (target) => {
    // Installed Pathfinder opens the door as part of walking; emulate that here.
    if (target.kind === 'near') {
      adapter.blockProperties.set('2,64,0', { open: true, half: 'lower' });
      adapter.pos = { ...target.pos };
    }
  });
  const use = t.mock.method(adapter, 'useBlockAt', async () => { throw new Error('door should not be toggled separately'); });
  const dig = t.mock.method(adapter, 'dig', async () => { throw new Error('walking must not dig'); });
  const result = await goTo.run(ctx, { target: '6,64,0' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(use.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
  assert.equal(adapter.blockAt(door), 'oak_door');
});

test('visual guidance selects a visible floor and excludes ground hidden behind a wall', () => {
  const adapter = start();
  const cfg = { range: 16, hFov: 70, vFov: 65, cols: 15, rows: 11, bandCols: 0, bandRows: 0, hearRadius: 10 };
  const vision = new Vision(adapter, cfg);
  const target: Vec3Like = { x: 12, y: 64, z: 0 };
  vision.scan();
  const clear = vision.navigationWaypoint(target, 12, []);
  assert.ok(clear && clear.x > 3, 'surface ground ahead is an observed foothold');
  const walled = start();
  for (let y = 64; y <= 69; y++) for (let z = -10; z <= 10; z++) walled.setBlock({ x: 3, y, z }, 'stone');
  const blockedVision = new Vision(walled, cfg); blockedVision.scan();
  const blocked = blockedVision.navigationWaypoint(target, 12, []);
  assert.ok(!blocked || blocked.x < 3, 'seeing a wall cannot reveal footholds behind it');
});

test('visual guidance can select an observed adjacent destination', () => {
  const adapter = start();
  adapter.pos.x = 0.8;
  adapter.pitch = -0.9;
  const vision = new Vision(adapter, { range: 16, hFov: 70, vFov: 65, cols: 31, rows: 21, bandCols: 0, bandRows: 0, hearRadius: 10 });
  vision.scan();
  const surfaces = (vision as any).visibleSurfaces as Map<string, unknown>;
  assert.ok(surfaces.has('1,63,0'), 'the target floor is actually seen by the vision scan');
  const target = { x: 1, y: 64, z: 0 };
  assert.deepEqual(vision.navigationWaypoint(target, 12, [adapter.pos]), { x: 1.5, y: 64, z: 0.5 });
  assert.notDeepEqual(vision.navigationWaypoint(target, 12, [adapter.pos, { x: 1.5, y: 64, z: 0.5 }]), { x: 1.5, y: 64, z: 0.5 }, 'a previously attempted destination stays excluded');
  adapter.setBlock({ x: 1, y: 64, z: 0 }, 'stone');
  assert.notDeepEqual(vision.navigationWaypoint(target, 12, [adapter.pos]), { x: 1.5, y: 64, z: 0.5 }, 'a newly blocked cell is not treated as a valid landing');
});

test('real wooden-door state shapes reveal ground through an opened narrow doorway', (t) => {
  const require = createRequire(import.meta.url);
  const data = require('minecraft-data')('1.20.1'), Block = require('prismarine-block')(data);
  const definition = data.blocksByName.oak_door;
  const stateOf = (half: string, open: boolean) => {
    for (let state = definition.minStateId; state <= definition.maxStateId; state++) {
      const p = Block.fromStateId(state, 0).getProperties();
      if (p.half === half && p.open === open && p.facing === 'east' && p.hinge === 'left' && !p.powered) return state;
    }
    throw new Error('missing real oak door state');
  };
  const adapter = start();
  for (let x = 0; x <= 12; x++) for (let y = 64; y <= 68; y++) for (const z of [-1, 1]) adapter.setBlock({ x, y, z }, 'stone');
  adapter.setBlock({ x: 3, y: 64, z: 0 }, 'oak_door');
  adapter.setBlock({ x: 3, y: 65, z: 0 }, 'oak_door');
  let opened = false;
  const originalOptics = adapter.blockOptics.bind(adapter);
  const optics = (MineflayerAdapter.prototype as any).classifyOptics;
  t.mock.method(adapter, 'blockOptics', (x, y, z) => {
    if (x === 3 && z === 0 && (y === 64 || y === 65)) {
      const state = stateOf(y === 64 ? 'lower' : 'upper', opened);
      return optics.call({ mcData: data }, Block.fromStateId(state, 0), state);
    }
    return originalOptics(x, y, z);
  });
  const vision = new Vision(adapter, { range: 16, hFov: 50, vFov: 65, cols: 17, rows: 15, bandCols: 0, bandRows: 0, hearRadius: 10 });
  const target = { x: 10, y: 64, z: 0 };
  vision.scan();
  const closed = vision.navigationWaypoint(target, 12, []);
  assert.ok(!closed || closed.x < 3, 'closed door hides the corridor floor behind it');
  assert.ok(vision.knownBlocks(['oak_door'], 12).length > 0, 'an observed wooden door remains available to the opening action');
  opened = true; vision.scan();
  const open = vision.navigationWaypoint(target, 12, []);
  assert.ok(open && open.x > 3, 'open door geometry exposes a real foothold inside');
});

test('goto does not toggle a door again when the pathfinder already opened it', async (t) => {
  const adapter = start(), door = { x: 2, y: 64, z: 0 };
  adapter.setBlock(door, 'oak_door');
  adapter.blockProperties.set('2,64,0', { open: false, half: 'lower' });
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async (target) => {
    if (target.kind !== 'near') return;
    adapter.blockProperties.set('2,64,0', { open: true, half: 'lower' });
    adapter.pos = { ...target.pos };
  });
  const use = t.mock.method(adapter, 'useBlockAt', async () => { throw new Error('door would close again'); });
  const result = await goTo.run(ctx, { target: '6,64,0' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(use.mock.callCount(), 0);
  assert.equal(adapter.blockStateAt(door).properties.open, true);
});

test('a visible destination across water does not authorize switching from walking to swimming or boating', async (t) => {
  const adapter = start(), water = { x: 3, y: 64, z: 0 };
  adapter.setBlock(water, 'water');
  const ctx = makeCtx(adapter, { senses: {
    navigationWaypoint: () => ({ x: 8.5, y: 64, z: 0.5 }),
    knownBlocks: (names) => names.includes('water') ? [{ name: 'water', pos: water, dist: 3 }] : [],
  } });
  t.after(() => ctx.memory.close());
  const walk = t.mock.method(adapter, 'moveTo', async (_target, opts) => {
    assert.equal(opts.allowSwimming, false, 'a dry destination does not authorize swimming across the route');
    throw new Error('No path on dry land');
  });
  const swim = t.mock.method(adapter, 'swimTo');
  const result = await goTo.run(ctx, { target: '8,64,0' });
  assert.equal(result.status, 'failed');
  assert.ok(walk.mock.callCount() >= 1);
  assert.equal(result.data?.waterAhead, true);
  assert.equal(result.data?.viaTravel, undefined);
  assert.equal(swim.mock.callCount(), 0, 'the agent chooses how to cross the water');
  assert.equal(adapter.inWater, false);
});

test('visual waypoints reject submerged, newly hazardous and waterlogged landing cells', () => {
  const adapter = start(), vision = new Vision(adapter);
  vision.knownCount(); // Establish scope without a ray scan or movement simulation.
  const floor = { x: 4, y: 63, z: 0 }, feet = { x: 4, y: 64, z: 0 };
  (vision as any).visibleSurfaces.set('4,63,0', { name: 'grass_block', pos: floor, at: Date.now() });
  const target = { x: 8, y: 64, z: 0 };
  assert.ok(vision.navigationWaypoint(target, 12, []));
  adapter.setBlock(feet, 'water');
  assert.equal(vision.navigationWaypoint(target, 12, []), null, 'submerged ground is not a dry waypoint');
  adapter.setBlock(feet, 'air'); adapter.setBlock(floor, 'magma_block');
  assert.equal(vision.navigationWaypoint(target, 12, []), null, 'live floor overrides a stale safe surface name');
  adapter.setBlock(floor, 'oak_slab'); adapter.blockProperties.set('4,63,0', { waterlogged: true, type: 'top' });
  assert.equal(vision.navigationWaypoint(target, 12, []), null, 'waterlogged terrain is not certified dry');
});

test('waypoints avoid the last visible block before an unseen drop and treetop leaves', async () => {
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter();
  const vision = new Vision(adapter);
  vision.scan();
  const surfaces = (vision as any).visibleSurfaces as Map<string, { name: string; pos: { x: number; y: number; z: number }; at: number }>;
  surfaces.clear();
  const now = Date.now();
  for (let x = 2; x <= 11; x++) surfaces.set(`${x},63,0`, { name: 'grass_block', pos: { x, y: 63, z: 0 }, at: now });
  const edge = vision.navigationWaypoint({ x: 30, y: 64, z: 0 }, 12, []);
  assert.equal(edge?.x, 10.5, 'the block before the unseen continuation is preferred over the visible rim');
  surfaces.set('12,63,0', { name: 'grass_block', pos: { x: 12, y: 63, z: 0 }, at: now });
  assert.equal(vision.navigationWaypoint({ x: 30, y: 64, z: 0 }, 12, [])?.x, 11.5, 'once ground beyond it is visible, it is no longer an edge');
});

test('with no visible way forward, remembered footprints lead back along the path actually walked', async () => {
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter();
  const vision = new Vision(adapter);
  for (const x of [0, 5, 10, 15, 20, 25]) { adapter.pos = { x, y: 64, z: 0 }; vision.scan(); }
  adapter.pos = { x: 25, y: 64, z: 0 };
  const back = vision.rememberedWaypoint({ x: 0, y: 64, z: 0 }, 12, [adapter.pos]);
  assert.ok(back && back.x < 25 && back.x >= 13, 'a footprint on the way home within reach');
  assert.equal(vision.rememberedWaypoint({ x: 60, y: 64, z: 0 }, 12, [adapter.pos]), null, 'never invents a path toward unvisited places');
  const excluded = vision.rememberedWaypoint({ x: 0, y: 64, z: 0 }, 12, [adapter.pos, back!]);
  assert.notDeepEqual(excluded, back, 'a footprint that failed is skipped');
});

test('goto walks directly even when only remembered footprints exist', async (t) => {
  const adapter = start();
  adapter.pos = { x: 20.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter, { senses: {
    navigationWaypoint: () => null,
    rememberedWaypoint: () => { throw new Error('remembered footprints must not gate walking'); },
  } });
  t.after(() => ctx.memory.close());
  const moves: MoveTarget[] = [];
  t.mock.method(adapter, 'moveTo', async (target: MoveTarget) => { moves.push(target); if (target.kind === 'near') adapter.pos = { ...target.pos }; });
  const result = await goTo.run(ctx, { target: '4,64,0' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(moves.map((m) => m.kind === 'near' ? m.pos.x : null), [4], 'pathfinder goes straight to the target');
});
