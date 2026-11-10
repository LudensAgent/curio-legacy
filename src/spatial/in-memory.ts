import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialLibraryStores } from './semantic-store.ts';
import { createInMemoryHostFactsPort } from './facts-adapter.ts';

/**
 * In-memory stores used by tests and non-persistent WorldMemory instances.
 * Production always supplies the stores of the open SQLite session (whose fact
 * port is backed by the persistent facts domain).
 */
export function createInMemoryLibraryStores(worldId = 'test'): SpatialLibraryStores {
  const history = new FragmentStore(worldId);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(worldId);
  return { facts: createInMemoryHostFactsPort(), history, topology, ledger };
}
