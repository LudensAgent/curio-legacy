/**
 * Read-only verification that a migrated spatial database can be loaded through
 * the production SemanticBackend/WorldMemory path.
 *
 * Open a copy of the database, never the live one while the Agent is running.
 */
import { resolve } from 'node:path';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SpatialMemoryBackend } from '../src/memory/spatial-backend.ts';
import { WorldMemory } from '../src/memory/store.ts';

const [database, worldId, dim = 'overworld'] = process.argv.slice(2);
if (!database || !worldId) {
  process.stderr.write('usage: verify-spatial-cutover <database-copy> <worldId> [dim]\n');
  process.exitCode = 1;
} else {
  const session = await openSpatialSession({ databasePath: resolve(database), worldId, timeoutMs: 30_000 });
  try {
    const backend = new SpatialMemoryBackend(session, worldId);
    const memory = new WorldMemory(null);
    memory.attachSpatial(backend, { allowEmptyStore: true });
    const passages = memory.allPassages(dim);
    const landmarks = memory.landmarks().filter((l) => l.dim === dim);
    const chests = memory.chests(dim);
    const farms = memory.farms().filter((f) => f.dim === dim);
    const hazards = memory.hazards(dim);
    const gone = memory.goneNear(dim, { x: 0, y: 0, z: 0 }, 30_000);
    const placed = memory.placedBlocks();
    const visits = memory.visitedChunkCount;
    process.stdout.write(`${JSON.stringify({
      worldId,
      dim,
      backend: backend.counts(),
      loaded: {
        passages: passages.length,
        archivedPassages: passages.filter((p) => p.archivedAt !== undefined).length,
        landmarks: landmarks.length,
        chests: chests.length,
        farms: farms.length,
        hazards: hazards.length,
        goneWithin30k: gone.length,
        placed: placed.length,
        chunkVisitKeys: visits,
      },
      sample: {
        passage: passages[0]?.id ?? null,
        landmark: landmarks[0]?.label ?? null,
        chest: chests[0]?.block ?? null,
      },
    }, null, 2)}\n`);
  } finally {
    await session.close();
  }
}
