/**
 * 旧空间记忆一次性导入（显式、离线、可复核）。
 *
 * 只把旧文件里能够忠实表达的历史空间事实写入新空间库：
 * - passages → PathFragment，geometrySource 固定为 'legacy'，保留原始 id/world/dim/
 *   kind/createdAt/lastUsedAt/uses/entrances/path/deepestY 与旧 links；
 * - landmarks / hazards / chest 位置 / farm / travel endpoints → SpatialNode；
 * - 不写当前体素观测、不写 traversal evidence、不写拓扑边，不把旧几何升级为
 *   “当前可通行”。旧文件里的容器账本、时间字段、没有坐标或没有作用域的记录、
 *   travel traversals（库当前拒绝 PORTAL 边）等保留在来源与报告中，不伪造。
 *
 * 这是独立的一次性工具，不是运行时迁移：不读取 config/.env，不启动 Bot，
 * 不改写来源 JSON。执行前先做一致性备份；写入通过库的 openHistorySession
 * 公开入口，checkpoint 只持久化 history/topology，不触碰已有的体素 Section。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CheckpointResult, CloseResult, PersistenceState } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { PathFragment, SpatialNode } from 'curio-minecraft-3d-memory';

type Vec = { x: number; y: number; z: number };
type SourceRole = 'world-memory' | 'travel-memory' | 'placed';
type PlanStatus = 'planned' | 'rejected' | 'unsupported';

interface SourceFile {
  role: SourceRole;
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface PlanRecord {
  category: string;
  locator: string;
  originalId: string | null;
  newId: string | null;
  status: PlanStatus;
  reason?: string;
  preservedFields: string[];
  unmappedFields: string[];
}

interface CollectionStat {
  total: number;
  planned: number;
  rejected: number;
  unsupported: number;
}

interface UnsupportedCollection {
  category: string;
  total: number;
  reason: string;
  sampleLocators: string[];
  note?: string;
}

interface RootFacts {
  version?: number;
  worldId?: string;
  unknownFields: string[];
}

export interface ImportPlan {
  worldId: string;
  fragments: PathFragment[];
  nodes: SpatialNode[];
  records: PlanRecord[];
  collections: Record<string, CollectionStat>;
  unsupported: UnsupportedCollection[];
  sourceFiles: SourceFile[];
  sourceRoots: { worldMemory: RootFacts; travelMemory: RootFacts | null; placed: RootFacts | null };
  limitations: string[];
}

const FRAGMENT_KINDS = ['dug', 'walked', 'bridge', 'built'] as const;
type FragmentKind = (typeof FRAGMENT_KINDS)[number];
const LANDMARK_TAGS = ['base', 'resource', 'danger', 'discovery', 'death', 'waypoint', 'herd', 'portal'] as const;
type LandmarkTag = (typeof LANDMARK_TAGS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
const vec = (value: unknown): Vec | null => {
  if (!isRecord(value)) return null;
  const x = finite(value.x), y = finite(value.y), z = finite(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
};
const vecList = (value: unknown): Vec[] | null => {
  if (!Array.isArray(value)) return null;
  const points = value.map(vec);
  return points.some((point) => point === null) ? null : points.filter((point): point is Vec => point !== null);
};
const fragmentKind = (value: unknown): FragmentKind | null =>
  typeof value === 'string' && (FRAGMENT_KINDS as readonly string[]).includes(value) ? value as FragmentKind : null;
const landmarkTag = (value: unknown): LandmarkTag | null =>
  typeof value === 'string' && (LANDMARK_TAGS as readonly string[]).includes(value) ? value as LandmarkTag : null;
const linkList = (value: unknown): { a: Vec; b: Vec }[] | null => {
  if (!Array.isArray(value)) return null;
  const pairs = value.map((item) => {
    if (!isRecord(item)) return null;
    const a = vec(item.a), b = vec(item.b);
    return a === null || b === null ? null : { a, b };
  });
  return pairs.some((pair) => pair === null) ? null : pairs.filter((pair): pair is { a: Vec; b: Vec } => pair !== null);
};
const unknownFields = (value: Record<string, unknown>, known: readonly string[]): string[] =>
  Object.keys(value).filter((key) => !known.includes(key)).sort();
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function emptyStat(): CollectionStat {
  return { total: 0, planned: 0, rejected: 0, unsupported: 0 };
}

function fileFact(role: SourceRole, path: string): SourceFile {
  const abs = resolve(path);
  const info = statSync(abs);
  return { role, path: abs, size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(abs) };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

/** 只读一层根事实；未知字段只报告，不迁移。 */
function rootFacts(value: unknown, known: readonly string[]): RootFacts {
  if (!isRecord(value)) throw new Error('legacy root must be an object');
  const version = finite(value.version);
  const worldId = text(value.worldId);
  return {
    ...(version === null ? {} : { version }),
    ...(worldId === null ? {} : { worldId }),
    unknownFields: unknownFields(value, known),
  };
}

/**
 * 纯映射：不读 DB、不写任何东西。每条来源记录都产生 planned / rejected /
 * unsupported 计数；不可表示的数据只进入报告。
 */
export function planLegacyImport(input: {
  worldMemory: unknown;
  travelMemory?: unknown;
  placed?: unknown;
  sourceFiles: SourceFile[];
  worldId?: string;
}): ImportPlan {
  if (!isRecord(input.worldMemory)) throw new Error('world-memory.json root must be an object');
  const rootWorldId = text(input.worldMemory.worldId);
  const worldId = input.worldId ?? rootWorldId;
  if (worldId === null) throw new Error('worldId is required (source root has none and --world-id was not given)');
  if (rootWorldId !== null && rootWorldId !== worldId) {
    throw new Error(`source worldId "${rootWorldId}" does not match target worldId "${worldId}"`);
  }

  const collections: Record<string, CollectionStat> = {
    passages: emptyStat(), landmarks: emptyStat(), hazards: emptyStat(), chests: emptyStat(),
    farms: emptyStat(), travelEndpoints: emptyStat(), travelTraversals: emptyStat(),
    travelGateways: emptyStat(), digs: emptyStat(), visitedChunks: emptyStat(), seen: emptyStat(), placed: emptyStat(),
  };
  const records: PlanRecord[] = [];
  const fragments: PathFragment[] = [];
  const nodes: SpatialNode[] = [];
  const unsupported: UnsupportedCollection[] = [];
  const seenIds = new Map<string, string>();

  const record = (category: string, locator: string, originalId: string | null, newId: string | null,
    status: PlanStatus, reason: string | undefined, preservedFields: string[], unmapped: string[]): void => {
    collections[category]!.total += 1;
    collections[category]![status] += 1;
    records.push({
      category, locator, originalId, newId, status,
      ...(reason === undefined ? {} : { reason }),
      preservedFields, unmappedFields: unmapped,
    });
  };

  const reserve = (category: string, locator: string, originalId: string | null, newId: string): boolean => {
    const prior = seenIds.get(newId);
    if (prior !== undefined) {
      record(category, locator, originalId, newId, 'rejected', `duplicate_new_id (first at ${prior})`, [], []);
      return false;
    }
    seenIds.set(newId, locator);
    return true;
  };

  const listOf = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const recordsOf = (value: unknown): [string, unknown][] =>
    isRecord(value) ? Object.entries(value) : [];

  // ---------------------------------------------------------------- passages
  const passageKnown = ['id', 'worldId', 'dim', 'kind', 'entrances', 'path', 'deepestY', 'dug', 'ores', 'createdAt', 'lastUsedAt', 'uses', 'links'];
  listOf(input.worldMemory.passages).forEach((raw, index) => {
    const locator = `/worldMemory/passages/${index}`;
    if (!isRecord(raw)) { record('passages', locator, null, null, 'rejected', 'not_an_object', [], []); return; }
    const id = text(raw.id), dim = text(raw.dim), recordWorld = text(raw.worldId);
    const kind = fragmentKind(raw.kind);
    const path = vecList(raw.path);
    const entrances = raw.entrances === undefined ? [] : vecList(raw.entrances);
    const links = raw.links === undefined ? undefined : linkList(raw.links);
    const deepestY = finite(raw.deepestY), createdAt = finite(raw.createdAt), lastUsedAt = finite(raw.lastUsedAt), uses = finite(raw.uses);
    const reason =
      id === null ? 'missing_id'
      : recordWorld !== worldId ? 'world_mismatch'
      : dim === null ? 'missing_dim'
      : kind === null ? 'unknown_passage_kind'
      : path === null || path.length === 0 ? 'invalid_or_empty_path'
      : entrances === null ? 'invalid_entrances'
      : links === null ? 'invalid_links'
      : deepestY === null ? 'missing_deepestY'
      : createdAt === null || createdAt <= 0 ? 'missing_or_nonpositive_createdAt'
      : lastUsedAt === null || lastUsedAt <= 0 ? 'missing_or_nonpositive_lastUsedAt'
      : uses === null || uses < 0 ? 'invalid_uses'
      : null;
    const newId = id === null ? null : `legacy:passage:${id}`;
    if (reason !== null || newId === null || !reserve('passages', locator, id, newId)) {
      if (reason !== null) record('passages', locator, id, newId, 'rejected', reason, [], []);
      return;
    }
    fragments.push({
      id: newId,
      worldId,
      dim: dim!,
      kind: kind!,
      entrances: entrances!,
      polyline: path!,
      geometrySource: 'legacy',
      ...(links === undefined ? {} : { links: links! }),
      deepestY: deepestY!,
      createdAt: createdAt!,
      lastUsedAt: lastUsedAt!,
      uses: uses!,
    });
    const unmapped = ['dug', 'ores', ...unknownFields(raw, passageKnown)];
    if (raw.entrances === undefined) unmapped.push('entrances_missing_treated_as_empty');
    record('passages', locator, id, newId, 'planned', undefined, passageKnown.filter((k) => k !== 'dug' && k !== 'ores'), unmapped);
  });

  // --------------------------------------------------------------- landmarks
  const landmarkKnown = ['id', 'kind', 'label', 'worldId', 'dim', 'pos', 'ts', 'primary', 'count'];
  listOf(input.worldMemory.landmarks).forEach((raw, index) => {
    const locator = `/worldMemory/landmarks/${index}`;
    if (!isRecord(raw)) { record('landmarks', locator, null, null, 'rejected', 'not_an_object', [], []); return; }
    const id = text(raw.id), dim = text(raw.dim), recordWorld = text(raw.worldId), pos = vec(raw.pos);
    const label = typeof raw.label === 'string' ? raw.label : null;
    const tag = landmarkTag(raw.kind);
    const reason =
      id === null ? 'missing_id'
      : recordWorld !== worldId ? 'world_mismatch'
      : dim === null ? 'missing_dim'
      : pos === null ? 'invalid_pos'
      : null;
    const newId = id === null ? null : `legacy:landmark:${id}`;
    if (reason !== null || newId === null || !reserve('landmarks', locator, id, newId)) {
      if (reason !== null) record('landmarks', locator, id, newId, 'rejected', reason, [], []);
      return;
    }
    nodes.push({
      id: newId, kind: 'place', source: 'agent',
      ...(tag === null ? {} : { tag }),
      ...(label === null ? {} : { label }),
      worldId, dim: dim!, location: { kind: 'exact', pos: pos! },
    });
    const unmapped = ['ts', 'primary', 'count', ...unknownFields(raw, landmarkKnown)];
    if (tag === null) unmapped.push(`unmapped_landmark_kind:${String(raw.kind)}`);
    record('landmarks', locator, id, newId, 'planned', undefined,
      ['id', 'kind', 'label', 'worldId', 'dim', 'pos'], unmapped);
  });

  // ---------------------------------------------------------------- hazards
  const hazardKnown = ['id', 'worldId', 'dim', 'pos', 'radius', 'kind', 'count', 'during', 'note', 'firstTs', 'ts'];
  listOf(input.worldMemory.hazards).forEach((raw, index) => {
    const locator = `/worldMemory/hazards/${index}`;
    if (!isRecord(raw)) { record('hazards', locator, null, null, 'rejected', 'not_an_object', [], []); return; }
    const id = text(raw.id), dim = text(raw.dim), recordWorld = text(raw.worldId), pos = vec(raw.pos);
    const radius = finite(raw.radius), kind = text(raw.kind), note = typeof raw.note === 'string' ? raw.note : null;
    const reason =
      id === null ? 'missing_id'
      : recordWorld !== worldId ? 'world_mismatch'
      : dim === null ? 'missing_dim'
      : pos === null ? 'invalid_pos'
      : radius === null || radius < 0 ? 'invalid_radius'
      : null;
    const newId = id === null ? null : `legacy:hazard:${id}`;
    if (reason !== null || newId === null || !reserve('hazards', locator, id, newId)) {
      if (reason !== null) record('hazards', locator, id, newId, 'rejected', reason, [], []);
      return;
    }
    nodes.push({
      id: newId, kind: 'place', source: 'program', tag: 'danger',
      label: note ?? kind ?? 'hazard',
      worldId, dim: dim!, location: { kind: 'region', center: pos!, radius: radius! },
    });
    record('hazards', locator, id, newId, 'planned', undefined,
      ['id', 'worldId', 'dim', 'pos', 'radius', 'kind', 'note'],
      ['count', 'during', 'firstTs', 'ts', ...unknownFields(raw, hazardKnown)]);
  });

  // ----------------------------------------------------------------- chests
  const chestKnown = ['worldId', 'dim', 'pos', 'block', 'uses', 'ts', 'day', 'note', 'contents'];
  recordsOf(input.worldMemory.chests).forEach(([key, raw]) => {
    const locator = `/worldMemory/chests/${key}`;
    if (!isRecord(raw)) { record('chests', locator, key, null, 'rejected', 'not_an_object', [], []); return; }
    const dim = text(raw.dim), recordWorld = text(raw.worldId), pos = vec(raw.pos);
    const block = text(raw.block), note = typeof raw.note === 'string' ? raw.note : null;
    const reason =
      recordWorld !== worldId ? 'world_mismatch'
      : dim === null ? 'missing_dim'
      : pos === null ? 'invalid_pos'
      : null;
    const newId = `legacy:chest:${key}`;
    if (reason !== null || !reserve('chests', locator, key, newId)) {
      if (reason !== null) record('chests', locator, key, newId, 'rejected', reason, [], []);
      return;
    }
    nodes.push({
      id: newId, kind: 'place', source: 'program', tag: 'resource',
      label: `${block ?? 'container'}${note === null ? '' : `: ${note}`}`,
      worldId, dim: dim!, location: { kind: 'exact', pos: pos! },
    });
    record('chests', locator, key, newId, 'planned', undefined,
      ['worldId', 'dim', 'pos', 'block', 'note'],
      ['contents', 'uses', 'ts', 'day', ...unknownFields(raw, chestKnown)]);
  });

  // ------------------------------------------------------------------ farms
  const farmKnown = ['id', 'dim', 'crop', 'cells', 'plantedAt', 'harvests', 'worldId'];
  listOf(input.worldMemory.farms).forEach((raw, index) => {
    const locator = `/worldMemory/farms/${index}`;
    if (!isRecord(raw)) { record('farms', locator, null, null, 'rejected', 'not_an_object', [], []); return; }
    const id = text(raw.id), dim = text(raw.dim), recordWorld = text(raw.worldId), crop = text(raw.crop);
    const cells = vecList(raw.cells);
    const reason =
      id === null ? 'missing_id'
      : recordWorld !== worldId ? 'world_mismatch'
      : dim === null ? 'missing_dim'
      : cells === null || cells.length === 0 ? 'invalid_or_empty_cells'
      : null;
    const newId = id === null ? null : `legacy:farm:${id}`;
    if (reason !== null || newId === null || !reserve('farms', locator, id, newId)) {
      if (reason !== null) record('farms', locator, id, newId, 'rejected', reason, [], []);
      return;
    }
    const center = {
      x: cells!.reduce((sum, cell) => sum + cell.x, 0) / cells!.length,
      y: cells!.reduce((sum, cell) => sum + cell.y, 0) / cells!.length,
      z: cells!.reduce((sum, cell) => sum + cell.z, 0) / cells!.length,
    };
    const radius = Math.max(...cells!.map((cell) => Math.hypot(cell.x - center.x, cell.y - center.y, cell.z - center.z)));
    nodes.push({
      id: newId, kind: 'place', source: 'program', tag: 'resource',
      label: `farm${crop === null ? '' : `: ${crop}`}`,
      worldId, dim: dim!, location: { kind: 'region', center, radius },
    });
    record('farms', locator, id, newId, 'planned', undefined,
      ['id', 'worldId', 'dim', 'crop'],
      ['cells (region center/radius derived, cells preserved in source)', 'plantedAt', 'harvests', ...unknownFields(raw, farmKnown)]);
  });

  // -------------------------------------------------------- travel endpoints
  const travel = input.travelMemory;
  const endpointKnown = ['id', 'worldId', 'dim', 'pos', 'kind', 'portalObserved', 'observedAt'];
  const travelRoot = isRecord(travel) ? rootFacts(travel, ['version', 'endpoints', 'traversals', 'gateways']) : null;
  if (isRecord(travel)) {
    listOf(travel.endpoints).forEach((raw, index) => {
      const locator = `/travelMemory/endpoints/${index}`;
      if (!isRecord(raw)) { record('travelEndpoints', locator, null, null, 'rejected', 'not_an_object', [], []); return; }
      const id = text(raw.id), dim = text(raw.dim), recordWorld = text(raw.worldId), pos = vec(raw.pos), kind = text(raw.kind);
      const reason =
        id === null ? 'missing_id'
        : recordWorld !== worldId ? 'world_mismatch'
        : dim === null ? 'missing_dim'
        : pos === null ? 'invalid_pos'
        : null;
      const newId = id === null ? null : `legacy:travel-endpoint:${id}`;
      if (reason !== null || newId === null || !reserve('travelEndpoints', locator, id, newId)) {
        if (reason !== null) record('travelEndpoints', locator, id, newId, 'rejected', reason, [], []);
        return;
      }
      const tag: LandmarkTag = kind !== null && kind.includes('portal') ? 'portal' : 'waypoint';
      nodes.push({
        id: newId, kind: 'place', source: 'program', tag,
        label: kind ?? 'travel endpoint',
        worldId, dim: dim!, location: { kind: 'exact', pos: pos! },
      });
      record('travelEndpoints', locator, id, newId, 'planned', undefined,
        ['id', 'worldId', 'dim', 'pos', 'kind'],
        ['portalObserved', 'observedAt', ...unknownFields(raw, endpointKnown)]);
    });

    const traversals = listOf(travel.traversals);
    if (traversals.length > 0) {
      collections.travelTraversals!.total = traversals.length;
      collections.travelTraversals!.unsupported = traversals.length;
      unsupported.push({
        category: 'travelTraversals', total: traversals.length,
        reason: 'portal_edges_unsupported_by_current_library',
        sampleLocators: traversals.slice(0, 20).map((_, index) => `/travelMemory/traversals/${index}`),
        note: '库当前显式拒绝 PORTAL 边；跨维度 traversal 也没有可归属的单一 PathFragment。记录保留在来源与备份中。',
      });
    }
    const gateways = listOf(travel.gateways);
    if (gateways.length > 0) {
      collections.travelGateways!.total = gateways.length;
      collections.travelGateways!.unsupported = gateways.length;
      unsupported.push({
        category: 'travelGateways', total: gateways.length, reason: 'gateway_edges_unsupported_by_current_library',
        sampleLocators: gateways.slice(0, 20).map((_, index) => `/travelMemory/gateways/${index}`),
      });
    }
  }

  // -------------------------------------------- unsupported non-spatial data
  const unsupportedEntries = (
    category: string, value: unknown, reason: string, note: string, sample: (key: string, index: number) => string,
  ): void => {
    const entries = Array.isArray(value) ? value : isRecord(value) ? Object.keys(value) : [];
    if (entries.length === 0) return;
    collections[category]!.total = entries.length;
    collections[category]!.unsupported = entries.length;
    unsupported.push({ category, total: entries.length, reason, note, sampleLocators: entries.slice(0, 20).map(sample) });
  };
  unsupportedEntries('digs', input.worldMemory.digs, 'missing_position',
    'digs 只有 ts/block/tool/ms，没有位置或作用域；不能变成空间记录。', (_, index) => `/worldMemory/digs/${index}`);
  unsupportedEntries('visitedChunks', input.worldMemory.visitedChunks, 'missing_scope_and_observation_time',
    'visitedChunks 只有计数键，没有逐记录 world/dim/观测时间；不标为地点或证据。', (key) => `/worldMemory/visitedChunks/${key}`);
  unsupportedEntries('seen', input.worldMemory.seen, 'missing_position',
    'seen 是按 worldId:block 的计数/时间，没有坐标；不写入体素当前观测。', (key) => `/worldMemory/seen/${key}`);
  unsupportedEntries('placed', isRecord(input.placed) ? input.placed.byPos : input.placed, 'missing_scope_and_timestamp_semantics',
    'placed 只有坐标/name/LRU 序号 at，没有 world/dim/观测时间；不导入。', (key) => `/placed/byPos/${key}`);
  const deaths = input.worldMemory.deaths;
  const deathCount = Array.isArray(deaths) ? deaths.length : isRecord(deaths) ? Object.keys(deaths).length : 0;
  if (deathCount > 0) {
    unsupported.push({ category: 'deaths', total: deathCount, reason: 'not_a_spatial_entity',
      sampleLocators: [], note: 'deaths 不是空间记录；死亡地点已在 landmarks(kind=death) 中按地标导入。' });
  }
  const furnaces = input.worldMemory.furnaces;
  const furnaceCount = Array.isArray(furnaces) ? furnaces.length : isRecord(furnaces) ? Object.keys(furnaces).length : 0;
  if (furnaceCount > 0) {
    unsupported.push({ category: 'furnaces', total: furnaceCount, reason: 'ledger_only',
      sampleLocators: [], note: '炉子账本不是历史几何；保留在来源。' });
  }

  const worldRoot = rootFacts(input.worldMemory, [
    'version', 'worldId', 'lastDeath', 'deaths', 'objective', 'digs', 'chests', 'farms', 'lessons', 'hazards',
    'visitedChunks', 'seen', 'landmarks', 'skillStats', 'goals', 'notes', 'preferences', 'intents', 'decisions',
    'projects', 'evidence', 'runtimePauseReasons', 'passages', 'furnaces', 'gone', 'chestOps',
  ]);
  const placedRoot = input.placed === undefined ? null : isRecord(input.placed)
    ? rootFacts(input.placed, ['byPos']) : { unknownFields: [] };

  return {
    worldId,
    fragments,
    nodes,
    records,
    collections,
    unsupported,
    sourceFiles: input.sourceFiles,
    sourceRoots: { worldMemory: worldRoot, travelMemory: travelRoot, placed: placedRoot },
    limitations: [
      'imported PathFragments use geometrySource="legacy" and are historical geometry, not current passability or traversal evidence',
      'passage links are the old file\'s personally-walked adjacent pairs; they are preserved as legacy links, not TraversalEvidence',
      'imported SpatialNodes are place indexes; original landmark ts/primary/count, hazard times, chest contents, farm cells and endpoint observedAt remain only in the source file and report',
      'travel traversals are not imported: the library rejects PORTAL edges in this phase; they remain in travel-memory.json and the report',
      'dug records, visitedChunks, seen and placed blocks have no per-record scope/observation time and are not imported',
      'no current voxel observation, traversal evidence or topology edge is created by this import',
    ],
  };
}

// ------------------------------------------------------------------ apply

export interface ApplyResult {
  ok: boolean;
  backup: { path: string; size: number; sha256: string };
  insertedFragments: number;
  unchangedFragments: number;
  insertedNodes: number;
  unchangedNodes: number;
  conflicts: string[];
  checkpoint: CheckpointResult | null;
  state: PersistenceState | null;
  close: CloseResult | null;
  errors: string[];
}

function sameFragment(existing: PathFragment, planned: PathFragment): boolean {
  return isDeepStrictEqual(existing, planned);
}
function sameNode(existing: SpatialNode, planned: SpatialNode): boolean {
  return isDeepStrictEqual(existing, planned);
}

/** 一致性备份：VACUUM INTO 生成独立快照，不改写来源库。 */
export function backupDatabase(databasePath: string, backupPath: string): { path: string; size: number; sha256: string } {
  const source = resolve(databasePath), target = resolve(backupPath);
  if (!existsSync(source)) throw new Error(`database not found: ${source}`);
  if (existsSync(target)) throw new Error(`backup already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec(`VACUUM INTO '${target.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  db.close();
  const info = statSync(target);
  return { path: target, size: info.size, sha256: sha256(target) };
}

export async function applyPlan(plan: ImportPlan, options: { databasePath: string; backupPath: string }): Promise<ApplyResult> {
  const backup = backupDatabase(options.databasePath, options.backupPath);
  const session = await openHistorySession({ databasePath: resolve(options.databasePath), worldId: plan.worldId, timeoutMs: 30_000 });
  const result: ApplyResult = {
    ok: false, backup, insertedFragments: 0, unchangedFragments: 0, insertedNodes: 0, unchangedNodes: 0,
    conflicts: [], checkpoint: null, state: null, close: null, errors: [],
  };
  try {
    // 先只读预检冲突：同一 id 不同内容时整次拒绝，不做部分写入。
    const newFragments: PathFragment[] = [];
    for (const fragment of plan.fragments) {
      const existing = session.history.getFragment(fragment.id);
      if (existing === null) newFragments.push(fragment);
      else if (sameFragment(existing, fragment)) result.unchangedFragments += 1;
      else result.conflicts.push(`fragment ${fragment.id}`);
    }
    const newNodes: SpatialNode[] = [];
    for (const node of plan.nodes) {
      const existing = session.topology.getNode(node.id);
      if (existing === null) newNodes.push(node);
      else if (sameNode(existing, node)) result.unchangedNodes += 1;
      else result.conflicts.push(`node ${node.id}`);
    }
    if (result.conflicts.length > 0) {
      result.errors.push('existing records with the same ids have different content; nothing was written');
      result.close = await session.close();
      return result;
    }
    for (const fragment of newFragments) {
      session.history.saveFragment(fragment);
      result.insertedFragments += 1;
    }
    for (const node of newNodes) {
      session.topology.saveNode(node);
      result.insertedNodes += 1;
    }
    result.checkpoint = await session.checkpoint();
    result.state = session.getPersistenceState();
    if (result.state.dirty || result.state.lastConfirmedCheckpointId === null) {
      result.errors.push('checkpoint did not confirm a clean history/topology state');
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    result.close = await session.close();
  }
  if (result.close === null || result.close.completed !== true || result.close.error !== null || result.close.dirty) {
    result.errors.push('history session close did not confirm a clean shutdown');
  }
  result.ok = result.errors.length === 0 && result.conflicts.length === 0;
  return result;
}

// ------------------------------------------------------------------- CLI

interface Cli {
  worldMemory: string;
  travelMemory: string | null;
  placed: string | null;
  database: string;
  worldId: string | null;
  report: string | null;
  backup: string | null;
  includeArchive: boolean;
  execute: boolean;
}

export function parseCli(argv: readonly string[]): { ok: true; cli: Cli } | { ok: true; help: true } | { ok: false; error: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { ok: true, help: true };
  const values = new Map<string, string>();
  let execute = false, includeArchive = false;
  for (const arg of argv) {
    if (arg === '--execute') { execute = true; continue; }
    if (arg === '--include-archive') { includeArchive = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (match === null) return { ok: false, error: `unknown argument: ${arg}` };
    if (values.has(match[1]!)) return { ok: false, error: `duplicate argument: ${match[1]}` };
    values.set(match[1]!, match[2]!);
  }
  const allowed = new Set(['world-memory', 'travel-memory', 'placed', 'database', 'world-id', 'report', 'backup']);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { ok: false, error: `unknown option(s): ${unknown.join(', ')}` };
  const worldMemory = values.get('world-memory');
  const database = values.get('database');
  if (worldMemory === undefined) return { ok: false, error: '--world-memory=<path> is required' };
  if (database === undefined) return { ok: false, error: '--database=<path> is required' };
  return {
    ok: true,
    cli: {
      worldMemory, database,
      travelMemory: values.get('travel-memory') ?? null,
      placed: values.get('placed') ?? null,
      worldId: values.get('world-id') ?? null,
      report: values.get('report') ?? null,
      backup: values.get('backup') ?? null,
      includeArchive,
      execute,
    },
  };
}

function usage(): string {
  return [
    'legacy-spatial-import — 一次性把旧 WorldMemory 历史空间事实导入新空间库',
    '',
    '默认 dry-run，不写 DB。加 --execute 才写；执行前用 VACUUM INTO 生成一致性备份。',
    '',
    '  --world-memory=<path>   必需，world-memory.json',
    '  --database=<path>       必需，目标 spatial.sqlite',
    '  --travel-memory=<path>  可选，travel-memory.json（只导入 endpoints；traversals 不导入）',
    '  --placed=<path>         可选，world-memory.json.placed（只审计，不导入）',
    '  --world-id=<id>         可选，默认取来源根 worldId；必须与目标库一致',
    '  --include-archive       同时把 world-memory.json 的 passageArchive 作为 passages 导入',
    '  --report=<path>         可选，报告 JSON；execute 时默认放在 DB 同目录',
    '  --backup=<path>         可选，备份路径；默认 <database>.pre-legacy-import-<ts>.sqlite',
    '  --execute               真正写入；默认只计划',
  ].join('\n');
}

function inspectDatabase(path: string): Record<string, number> {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    const count = (table: string): number => {
      const row = db.prepare(`select count(*) as n from "${table}"`).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      path_fragments: count('path_fragments'), spatial_nodes: count('spatial_nodes'), spatial_edges: count('spatial_edges'),
      traversal_evidence: count('traversal_evidence'), spatial_sections: count('spatial_sections'), checkpoints: count('checkpoints'),
    };
  } finally { db.close(); }
}

function databaseWorldIds(path: string): string[] {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    return (db.prepare('select distinct world_id from checkpoints').all() as { world_id: string }[]).map((row) => row.world_id);
  } finally { db.close(); }
}

function writeReport(path: string, report: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const temp = `${resolve(path)}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temp, resolve(path));
}

function summary(plan: ImportPlan): string {
  const categories = Object.entries(plan.collections)
    .filter(([, stat]) => stat.total > 0)
    .map(([name, stat]) => `${name}: ${stat.total} total / ${stat.planned} planned / ${stat.rejected} rejected / ${stat.unsupported} unsupported`);
  const unsupported = plan.unsupported.map((entry) => `${entry.category}: ${entry.total} (${entry.reason})`);
  return [
    `worldId ${plan.worldId}`,
    `fragments to import: ${plan.fragments.length}`,
    `nodes to import: ${plan.nodes.length}`,
    ...categories,
    ...(unsupported.length > 0 ? ['unsupported collections:', ...unsupported.map((line) => `  ${line}`)] : []),
  ].join('\n');
}

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write(`${parsed.error}\n`); return 1; }
  if ('help' in parsed) { process.stdout.write(`${usage()}\n`); return 0; }
  const cli = parsed.cli;
  const sourceFiles: SourceFile[] = [fileFact('world-memory', cli.worldMemory)];
  if (cli.travelMemory !== null) sourceFiles.push(fileFact('travel-memory', cli.travelMemory));
  if (cli.placed !== null) sourceFiles.push(fileFact('placed', cli.placed));
  const sourceRoot = readJson(cli.worldMemory);
  const archive = cli.includeArchive && isRecord(sourceRoot) && Array.isArray(sourceRoot.passageArchive) ? sourceRoot.passageArchive : [];
  const livePassages = isRecord(sourceRoot) && Array.isArray(sourceRoot.passages) ? sourceRoot.passages : [];
  const liveIds = new Set(livePassages.flatMap((record) => isRecord(record) && typeof record.id === 'string' ? [record.id] : []));
  const worldMemory = archive.length
    ? { ...sourceRoot as Record<string, unknown>, passages: [...livePassages, ...archive.filter((record) => !(isRecord(record) && typeof record.id === 'string' && liveIds.has(record.id)))] }
    : sourceRoot;
  const plan = planLegacyImport({
    worldMemory,
    ...(cli.travelMemory === null ? {} : { travelMemory: readJson(cli.travelMemory) }),
    ...(cli.placed === null ? {} : { placed: readJson(cli.placed) }),
    sourceFiles,
    ...(cli.worldId === null ? {} : { worldId: cli.worldId }),
  });
  process.stdout.write(`${summary(plan)}\n`);
  const stamp = Date.now();
  const reportPath = cli.report ?? `${resolve(cli.database)}.legacy-import-${stamp}.report.json`;
  const base = {
    reportVersion: 1, reportKind: 'legacy-spatial-import', generatedAt: stamp, dryRun: !cli.execute,
    plan, target: { databasePath: resolve(cli.database) },
  };
  if (!cli.execute) {
    writeReport(reportPath, base);
    process.stdout.write(`dry-run report: ${reportPath}\n`);
    return 0;
  }
  if (!existsSync(resolve(cli.database))) {
    process.stderr.write(`database not found: ${resolve(cli.database)}\n`);
    return 1;
  }
  const before = inspectDatabase(cli.database);
  const worldIds = databaseWorldIds(cli.database);
  if (worldIds.length > 0 && !worldIds.includes(plan.worldId)) {
    process.stderr.write(`database world ids ${worldIds.join(',')} do not include ${plan.worldId}\n`);
    return 1;
  }
  const backupPath = cli.backup ?? `${resolve(cli.database)}.pre-legacy-import-${stamp}.sqlite`;
  const applied = await applyPlan(plan, { databasePath: cli.database, backupPath });
  const after = inspectDatabase(cli.database);
  const deltaFragments = after.path_fragments! - before.path_fragments!;
  const deltaNodes = after.spatial_nodes! - before.spatial_nodes!;
  const deltaEdges = after.spatial_edges! - before.spatial_edges!;
  const deltaTraversals = after.traversal_evidence! - before.traversal_evidence!;
  const deltaSections = after.spatial_sections! - before.spatial_sections!;
  const countsOk = deltaFragments === applied.insertedFragments && deltaNodes === applied.insertedNodes
    && deltaEdges === 0 && deltaTraversals === 0 && deltaSections === 0;
  const ok = applied.ok && countsOk;
  const report = { ...base, dryRun: false, before, after, applied, countsOk, ok };
  writeReport(reportPath, report);
  process.stdout.write([
    `backup: ${applied.backup.path} (${applied.backup.sha256})`,
    `fragments inserted/unchanged: ${applied.insertedFragments}/${applied.unchangedFragments}`,
    `nodes inserted/unchanged: ${applied.insertedNodes}/${applied.unchangedNodes}`,
    `checkpoint: ${applied.checkpoint?.checkpointId ?? 'none'}`,
    `edges delta ${deltaEdges}, traversals delta ${deltaTraversals}, sections delta ${deltaSections}`,
    `report: ${reportPath}`,
    ok ? 'import OK' : `import FAILED: ${[...applied.conflicts, ...applied.errors].join('; ')}`,
  ].join('\n'));
  return ok ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
