import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

export function voxelNavigationFixture(maxX = 80) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const state = adapter.state();
  const map = new VoxelMap(state.worldId, { validityWindowMs: 60_000 });
  let sequence = 0;
  for (let x = -1; x <= maxX; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 65; y++) {
    map.observe({ worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, observedAt: Date.now(), sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: { name: y === 63 ? 'minecraft:stone' : 'minecraft:air', properties: {} }, pos: { x, y, z } });
  }
  const spatial = {
    worldId: state.worldId, session: { voxel: map, lifecycle: 'open' },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({ owner: 'host_composed', contract: 'memory-host-contract/1', library: { execute: { walk: true } }, host: {}, effective: { execute: { walk: true } }, overclaims: [] }),
    attach: () => 1, detach() {}, query() { throw new Error('旧空间路线查询不能被调用'); },
  } as unknown as SharedSpatialSession;
  return { adapter, map, ctx: { ...makeCtx(adapter), spatial } };
}