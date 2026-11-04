/**
 * Read-only compatibility layer for legacy spatial memory.
 *
 * This module exposes the read subset used by the old passage/landmark queries
 * and by the `{"kind":"passages"}` thinker branch. It deliberately owns no
 * storage: it never constructs a WorldMemory, never imports runtime store or
 * config modules, and never writes, migrates or deletes anything. The caller
 * owns the existing instance or supplies an already-validated typed snapshot.
 */

import type { Vec3Like } from '../adapter/types.ts';
import type { Landmark, PassageRecord, WorldMemory } from '../memory/store.ts';
import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';

/** The legacy read methods only; writes, selection and persistence are out of scope. */
export type LegacySpatialReadBackend = {
  passages(dim?: string): PassageRecord[];
  landmarks(): Landmark[];
  bases(dim?: string): Landmark[];
  base(dim?: string): Landmark | undefined;
  findLandmark(q: string, dim?: string): Landmark | undefined;
};

/**
 * A caller-validated, JSON-shaped view of the legacy storage. The caller is
 * responsible for parsing/validating files; this facade never reads disk.
 */
export type LegacySpatialSnapshot = {
  worldId: string;
  passages?: readonly PassageRecord[];
  landmarks: readonly Landmark[];
};

export type LegacyPassageQueryContext = {
  worldId: string;
  dim: string;
  pos: Vec3Like;
};

const inWorld = (record: { worldId?: string }, worldId: string) => (record.worldId ?? 'default') === worldId;
const clone = <T>(value: T): T => structuredClone(value);

/** Old membership convention: a missing worldId belongs to the literal "default" scope. */
const matchingBases = (snapshot: LegacySpatialSnapshot, dim?: string) =>
  snapshot.landmarks.filter((l) => inWorld(l, snapshot.worldId) && l.kind === 'base' && (!dim || l.dim === dim));

/**
 * Wrap an already-constructed, caller-owned memory object. Every operation
 * delegates to the corresponding read method with its original `this`, then
 * returns a defensive clone. The owner keeps owning its lifecycle.
 *
 * Note: the legacy `landmarks()` method can hand back mutable internal objects;
 * that aliasing is NOT a write API of this facade. The clone is read-only by
 * isolation, not by freezing.
 */
export function createWorldMemoryReadAdapter(
  memory: Pick<WorldMemory, 'passages' | 'landmarks' | 'bases' | 'base' | 'findLandmark'>,
): LegacySpatialReadBackend {
  return {
    passages: (dim) => clone(memory.passages(dim)),
    landmarks: () => clone(memory.landmarks()),
    bases: (dim) => clone(memory.bases(dim)),
    base: (dim) => clone(memory.base(dim)),
    findLandmark: (q, dim) => clone(memory.findLandmark(q, dim)),
  };
}

/**
 * Read from a caller-supplied typed snapshot provider.
 *
 * Each top-level method captures exactly one snapshot, including composite
 * `base`/`findLandmark` operations, so a concurrent world switch or deletion
 * cannot mix two reads. Scope comes from that snapshot's own `worldId`; no
 * record cache or fallback source exists, and records are cloned on the way
 * out. Missing `passages` behaves like the old method: an empty array.
 */
export function createJsonWorldMemoryReadBackend(
  readSnapshot: () => LegacySpatialSnapshot,
): LegacySpatialReadBackend {
  return {
    passages(dim) {
      const snapshot = readSnapshot();
      return (snapshot.passages ?? [])
        .filter((rec) => inWorld(rec, snapshot.worldId) && (!dim || rec.dim === dim))
        .map(clone);
    },

    landmarks() {
      const snapshot = readSnapshot();
      return snapshot.landmarks.filter((l) => inWorld(l, snapshot.worldId)).map(clone);
    },

    bases(dim) {
      const snapshot = readSnapshot();
      return matchingBases(snapshot, dim).map(clone);
    },

    base(dim) {
      const snapshot = readSnapshot();
      const bases = matchingBases(snapshot, dim);
      const found = bases.find((l) => l.primary) ?? bases[0];
      return found ? clone(found) : undefined;
    },

    findLandmark(q, dim) {
      const snapshot = readSnapshot();
      const s = q.trim().toLowerCase();
      if (s === 'base' || s === '基地') {
        const bases = matchingBases(snapshot, dim);
        const found = bases.find((l) => l.primary) ?? bases[0];
        return found ? clone(found) : undefined;
      }
      const candidates = snapshot.landmarks.filter((l) => inWorld(l, snapshot.worldId) && (!dim || l.dim === dim));
      const found = (
        candidates.find((l) => l.id.toLowerCase() === s) ??
        candidates.find((l) => l.label.toLowerCase() === s) ??
        candidates.find((l) => l.label.toLowerCase().includes(s))
      );
      if (!found) return undefined;
      if (!isContainerLandmark(found.label)) return clone(found);
      // Legacy display projection only: same pure helpers as the old
      // findLandmark. observedAt here is display metadata derived from the old
      // record timestamp, not a fresh observation or new evidence.
      const location = chestLocation(found);
      return clone({ ...found, pos: location.pos, radius: location.radius, precise: location.precise, observedAt: location.observedAt });
    },
  };
}

const PASSAGE_QUERY_NOTE = '历史脚点已稀疏采样、去重或合并，不代表连续顺序或双向可走；地表参考点也不保证现在是入口。';

/**
 * Reproduce the current thinker `passages` branch byte-for-byte against a
 * read backend. This is a projection of legacy records; it is not a route,
 * an executable path, or a fresh observation.
 *
 * The function is directly callable. The thinker still owns its current query
 * until a later wiring change; this module does not edit or intercept it.
 */
export function queryLegacyPassages(
  backend: LegacySpatialReadBackend,
  raw: Record<string, unknown>,
  context: LegacyPassageQueryContext,
): string {
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) return 'id 需要非空的矿道记录 ID 字符串；不指定 id 可列出记录';
  if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isSafeInteger(raw.offset) || raw.offset < 0)) return 'offset 需要非负整数，表示历史脚点的起始索引';
  const id = raw.id as string | undefined;
  const offset = (raw.offset ?? 0) as number;
  if (id === undefined && raw.offset !== undefined) return 'offset 需要与 id 一起使用；不指定 id 时列出矿道记录';
  const scope = { worldId: context.worldId, dim: context.dim, historical: true, connectivity: 'unknown', note: PASSAGE_QUERY_NOTE };
  const records = backend.passages(context.dim).filter((rec) => (rec.worldId ?? 'default') === context.worldId).map((rec) => {
    const nearest = rec.path.reduce<{ index: number; distance: number } | null>((best, point, index) => {
      const distance = Math.hypot(point.x - context.pos.x, point.y - context.pos.y, point.z - context.pos.z);
      return !best || distance < best.distance ? { index, distance } : best;
    }, null);
    return {
      rec,
      summary: {
        id: rec.id, kind: rec.kind ?? 'dug', surfaceReferences: rec.entrances, deepestY: rec.deepestY, createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt, dug: rec.dug, ores: rec.ores, pointCount: rec.path.length,
        nearestPointIndex: nearest?.index ?? null, distance: nearest?.distance ?? null,
      },
    };
  }).sort((a, b) => (a.summary.distance ?? Infinity) - (b.summary.distance ?? Infinity));
  if (id === undefined) return JSON.stringify({ ...scope, action: 'list', records: records.map(({ summary }) => summary) });
  const record = records.find(({ rec }) => rec.id === id.trim());
  if (!record) return JSON.stringify({ ...scope, error: '当前世界和维度没有这个矿道记录', id: id.trim() });
  const points = record.rec.path.slice(offset, offset + 32);
  return JSON.stringify({
    ...scope, action: 'read', ...record.summary, path: points, offset, total: record.rec.path.length,
    nextOffset: offset + points.length < record.rec.path.length ? offset + points.length : null,
  });
}
