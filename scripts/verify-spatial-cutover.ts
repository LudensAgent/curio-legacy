/**
 * Read-only verification that a migrated spatial database can be loaded through
 * the production SemanticBackend/WorldMemory path.
 *
 * Open a copy of the database, never the live one while the Agent is running.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialNode } from 'curio-minecraft-3d-memory';
import { ContainerLedger } from '../src/memory/container-ledger.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { SpatialSemanticStore } from '../src/spatial/semantic-store.ts';
import { DEFAULT_SNAPSHOT_MAX_MB, MAX_FRAGMENT_LINKS } from '../src/spatial/shared-session.ts';

const [database, worldId, dim = 'overworld', containerLedger] = process.argv.slice(2);
if (!database || !worldId) {
  process.stderr.write('usage: verify-spatial-cutover <database-copy> <worldId> [dim] [container-ledger]\n');
  process.exitCode = 1;
} else if (!existsSync(resolve(database))) {
  // 只读校验：路径不存在时打开会新建一个空库，结果全是 0，还会留下一个空库文件
  process.stderr.write(`verify-spatial-cutover: database not found: ${resolve(database)}\n`);
  process.exitCode = 1;
} else {
  // 与运行时同样的上限打开：库默认比运行时小，运行时能读的库会在这里被误判
  const session = await openSpatialSession({
    databasePath: resolve(database), worldId, timeoutMs: 30_000,
    snapshotLimits: { maxBytes: DEFAULT_SNAPSHOT_MAX_MB * 1024 * 1024 }, fragmentOptions: { maxLinks: MAX_FRAGMENT_LINKS },
  });
  try {
    const containers = new ContainerLedger(containerLedger ? resolve(containerLedger) : null, worldId);
    const semantic = new SpatialSemanticStore(session, containers, { worldId });
    const memory = new WorldMemory(null, { semantic });
    const passages = memory.allPassages(dim);
    const landmarks = memory.landmarks().filter((l) => l.dim === dim);
    const chests = memory.chests(dim);
    const farms = memory.farms().filter((f) => f.dim === dim);
    const hazards = memory.hazards(dim);
    const gone = memory.goneNear(dim, { x: 0, y: 0, z: 0 }, 30_000);
    const placed = memory.placedBlocks();
    const visits = memory.visitedChunkCount;
    const nodes = (() => {
      const out: SpatialNode[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10_000; guard++) {
        const page = session.topology.nodes({ after, limit: 100 });
        out.push(...page.items);
        if (page.nextAfter === undefined) break;
        after = page.nextAfter;
      }
      return out;
    })();
    const contentsInMetadata = nodes.filter((node) => {
      const record = (node.metadata as { curio?: { record?: Record<string, unknown> } } | undefined)?.curio?.record;
      return !!record && (record.contents !== undefined || record.input !== undefined || record.output !== undefined || record.fuel !== undefined);
    }).map((node) => node.id);
    process.stdout.write(`${JSON.stringify({
      worldId,
      dim,
      backend: semantic.counts(),
      containerLedger: { chests: containers.chests(dim).length, furnaces: containers.furnaces(dim).length },
      contentsInMetadata,
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
