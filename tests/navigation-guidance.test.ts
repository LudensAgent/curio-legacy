import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const start = () => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.pitch = -0.18;
  return adapter;
};

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
