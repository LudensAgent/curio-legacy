import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { AgentState } from '../src/adapter/types.ts';
import { SpatialMemoryBackend } from '../src/memory/spatial-backend.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { travelStore } from '../src/travel/store.ts';

const W = 'world-1';

function state(overrides: Partial<AgentState>): AgentState {
  return {
    connected: true, alive: true, observationReady: true, sessionId: 's1', observationId: 1,
    worldId: W, dim: 'overworld', pos: { x: 0, y: 64, z: 0 },
    ...overrides,
  } as AgentState;
}

test('portal endpoints and traversals use spatial nodes and the ledger', () => {
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);
  const memory = new WorldMemory(null);
  memory.attachSpatial(backend, { allowEmptyStore: true });
  const store = travelStore(memory);

  const overworld = store.observe(state({ dim: 'overworld', pos: { x: 10, y: 64, z: 10 } }), { x: 10, y: 64, z: 10 }, 'nether_portal');
  const nether = store.observe(state({ dim: 'the_nether', pos: { x: 2, y: 70, z: 2 }, sessionId: 's2', observationId: 2 }), { x: 2, y: 70, z: 2 }, 'nether_portal');
  assert.equal(store.get(overworld.id, W)?.pos.y, 64);
  assert.equal(store.get(nether.id, W)?.dim, 'the_nether');

  store.record(
    overworld.id, nether.id,
    state({ dim: 'overworld', pos: overworld.pos, sessionId: 's1', observationId: 1 }),
    state({ dim: 'the_nether', pos: nether.pos, sessionId: 's2', observationId: 2 }),
  );
  const snap = store.snapshot(W);
  assert.equal(snap.endpoints.length, 2);
  assert.equal(snap.routes.length, 1);
  assert.equal(snap.routes[0]?.fromId, overworld.id);
  assert.equal(snap.routes[0]?.returnVerified, false);
  assert.equal(ledger.portalTraversals().length, 1);

  // Re-observing the same portal updates the same endpoint instead of adding another.
  store.observe(state({ dim: 'overworld', pos: { x: 10, y: 64, z: 10 } }), { x: 10, y: 64, z: 10 }, 'nether_portal');
  assert.equal(store.snapshot(W).endpoints.length, 2);
});
