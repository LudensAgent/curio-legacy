import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { observedFootY } from '../src/spatial/land-search.ts';
import { waypointOf } from '../src/skills/movement/intent.ts';
import type { MovementSession } from '../src/skills/movement/session.ts';
import type { Vec3Like } from '../src/adapter/types.ts';

const WORLD = 'w', DIM = 'overworld';
let sequence = 0;
function fill(map: VoxelMap, name: string, cells: Vec3Like[]) {
  for (const pos of cells) map.observe({
    worldId: WORLD, dim: DIM, sessionId: 's', observedAt: Date.now(), sequence: ++sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state: { name, properties: {} }, pos,
  });
}

test('observedFootY 取该列已观测、离参考高度最近的站立面；没观测或脚部被占不算', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  // x=10：y=55 草地上方是空气（下坡 9 格）；x=11：支撑上方脚部是石头；x=12：没观测
  fill(map, 'minecraft:grass_block', [{ x: 10, y: 55, z: 0 }, { x: 11, y: 55, z: 0 }]);
  fill(map, 'minecraft:air', [{ x: 10, y: 56, z: 0 }, { x: 10, y: 57, z: 0 }]);
  fill(map, 'minecraft:stone', [{ x: 11, y: 56, z: 0 }]);
  assert.equal(observedFootY(map, DIM, 10, 0, 64, 24, 8), 56);
  assert.equal(observedFootY(map, DIM, 11, 0, 64, 24, 8), null, '脚部被石头占住；石头上方没观测，也不算站立面');
  assert.equal(observedFootY(map, DIM, 12, 0, 64, 24, 8), null);
});

test('advance 路点脚高用该列观测到的站立面，没观测时才沿用当前脚高', () => {
  const session = {
    intent: { kind: 'advance', direction: 'E', distance: 40, maxLateralDrift: 4, allowed: ['walk', 'step', 'drop'], historical: true },
    bearing: { x: 1, z: 0 }, frozenOrigin: { x: 0.5, y: 64, z: 0.5 },
  } as unknown as MovementSession;
  const here = { x: 0.5, y: 64, z: 0.5 };
  assert.deepEqual(waypointOf(session, here, 16, () => 52), { x: 16.5, y: 52, z: 0.5 });
  assert.deepEqual(waypointOf(session, here, 16, () => null), { x: 16.5, y: 64, z: 0.5 });
  assert.deepEqual(waypointOf(session, here, 16), { x: 16.5, y: 64, z: 0.5 });
});
