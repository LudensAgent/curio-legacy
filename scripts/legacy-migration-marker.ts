/**
 * Offline helper for the retired `curio:migration` topology marker.
 *
 * The runtime no longer reads or writes this marker: the startup gate uses the
 * library's read-only legacy-store summary plus the new
 * `legacyFactsMigrationVersion` receipt. Offline normalization/verification
 * scripts may still create or inspect the old marker on an archived database.
 * Production `src` must not import this module.
 */
import type {
  JsonObject,
  JsonValue,
  SpatialNode,
  TopologyStore,
} from 'curio-minecraft-3d-memory';

type MarkerTopology = Pick<TopologyStore, 'getNode' | 'saveNode' | 'updateNode'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface LegacyMigrationMarker {
  version: number;
  completedAt: number;
  sources?: JsonValue;
}

/** Read the old marker node, or null when it never existed / is malformed. */
export function readLegacyMigrationMarker(
  topology: Pick<TopologyStore, 'getNode'>,
): LegacyMigrationMarker | null {
  const node = topology.getNode('curio:migration');
  if (!node) return null;
  const curio = isRecord(node.metadata) ? node.metadata['curio'] : undefined;
  const record = isRecord(curio) ? curio['record'] : undefined;
  if (!isRecord(record)) return null;
  return {
    version: typeof record['version'] === 'number' ? record['version'] : 0,
    completedAt: typeof record['completedAt'] === 'number' ? record['completedAt'] : 0,
    ...(record['sources'] !== undefined ? { sources: record['sources'] as JsonValue } : {}),
  };
}

/** Create or update the old marker on an offline/archived topology store. */
export function writeLegacyMigrationMarker(
  topology: MarkerTopology,
  worldId: string,
  sources: JsonObject = {},
  completedAt = Date.now(),
): SpatialNode {
  const node: SpatialNode = {
    id: 'curio:migration', kind: 'place', source: 'program', tag: 'discovery',
    label: 'spatial migration', worldId, dim: 'overworld',
    location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } }, observedAt: completedAt,
    externalRef: 'curio:migration',
    metadata: { curio: { v: 2, type: 'migration', record: { version: 1, completedAt, sources } as JsonValue } },
  };
  if (topology.getNode(node.id)) {
    topology.updateNode(node.id, {
      label: node.label, location: node.location, observedAt: node.observedAt,
      externalRef: node.externalRef, metadata: node.metadata,
    });
  } else {
    topology.saveNode(node);
  }
  return node;
}
