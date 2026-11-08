import { ContainerLedger } from '../src/memory/container-ledger.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createInMemoryLibraryStores } from '../src/spatial/in-memory.ts';
import { SpatialSemanticStore, type SpatialLibraryStores } from '../src/spatial/semantic-store.ts';

export function semanticMemory(worldId = 'test', file: string | null = null) {
  const stores = createInMemoryLibraryStores(worldId);
  const containers = new ContainerLedger(null, worldId);
  const semantic = new SpatialSemanticStore(stores, containers, { worldId });
  const memory = new WorldMemory(file, { semantic });
  return { memory, semantic, stores, containers };
}

export function memoryFrom(stores: SpatialLibraryStores, containers: ContainerLedger, worldId = 'test', file: string | null = null) {
  const semantic = new SpatialSemanticStore(stores, containers, { worldId });
  return { memory: new WorldMemory(file, { semantic }), semantic };
}
