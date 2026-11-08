import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialLibraryStores } from './semantic-store.ts';

/**
 * In-memory library stores used by tests and non-persistent WorldMemory
 * instances. Production always supplies the stores of the open SQLite session.
 */
export function createInMemoryLibraryStores(worldId = 'test'): SpatialLibraryStores {
  const history = new FragmentStore(worldId);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(worldId);
  return { history, topology, ledger };
}
