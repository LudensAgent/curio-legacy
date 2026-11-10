import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialLibraryStores } from './semantic-store.ts';
import { createInMemoryHostFactsPort } from './facts-adapter.ts';

/**
 * In-memory stores used by tests and non-persistent WorldMemory instances.
 * Production always supplies the facts/ledger views of the open SQLite session.
 * Legacy Fragment/Topology stores are not part of the semantic composition.
 */
export function createInMemoryLibraryStores(worldId = 'test'): SpatialLibraryStores {
  return {
    facts: createInMemoryHostFactsPort(),
    ledger: new LedgerStore(worldId),
  };
}
