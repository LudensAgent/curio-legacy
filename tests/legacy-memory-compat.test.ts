import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Landmark, PassageRecord } from '../src/memory/store.ts';
import {
  passageDeepestAnchor,
  passageFragmentation,
  passageNext,
  passageRoute,
  passageSurfaceAnchor,
} from '../src/memory/passages.ts';
import {
  createJsonWorldMemoryReadBackend,
  createWorldMemoryReadAdapter,
  queryLegacyPassages,
  type LegacySpatialReadBackend,
  type LegacySpatialSnapshot,
} from '../src/spatial/legacy-memory-compat.ts';

const PASSAGE_NOTE = '历史脚点已稀疏采样、去重或合并，不代表连续顺序或双向可走；地表参考点也不保证现在是入口。';
const ID_ERROR = 'id 需要非空的矿道记录 ID 字符串；不指定 id 可列出记录';
const OFFSET_ERROR = 'offset 需要非负整数，表示历史脚点的起始索引';
const OFFSET_WITHOUT_ID_ERROR = 'offset 需要与 id 一起使用；不指定 id 时列出矿道记录';
const NOT_FOUND_ERROR = '当前世界和维度没有这个矿道记录';

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const counting = (backend: LegacySpatialReadBackend) => {
  const calls: { method: string; dim?: string }[] = [];
  return {
    calls,
    backend: {
      ...backend,
      passages: (dim?: string) => { calls.push({ method: 'passages', dim }); return backend.passages(dim); },
      landmarks: () => { calls.push({ method: 'landmarks' }); return backend.landmarks(); },
      bases: (dim?: string) => { calls.push({ method: 'bases', dim }); return backend.bases(dim); },
      base: (dim?: string) => { calls.push({ method: 'base', dim }); return backend.base(dim); },
      findLandmark: (q: string, dim?: string) => { calls.push({ method: 'findLandmark' }); return backend.findLandmark(q, dim); },
    } satisfies LegacySpatialReadBackend,
  };
};

// ------------------------------------------------------------------ fixtures

const queryPath = Array.from({ length: 65 }, (_, i) => ({ x: i === 0 ? 0 : -i, y: 10, z: 0 }));

const psgA: PassageRecord & { origin: string; extraMeta: { labels: (string | { nested: boolean })[] } } = {
  id: 'psg_a', worldId: 'w1', dim: 'overworld', kind: 'walked',
  entrances: [{ x: 0, y: 10, z: 0 }],
  path: queryPath,
  links: [{ a: { x: 0, y: 10, z: 0 }, b: { x: -1, y: 10, z: 0 } }],
  deepestY: -3, dug: 7, ores: { iron_ore: 2 },
  createdAt: 111, lastUsedAt: 222, uses: 3,
  origin: 'legacy',
  extraMeta: { labels: ['keep', { nested: true }] },
};

const psgTie = {
  id: 'psg_tie', worldId: 'w1', dim: 'overworld',
  entrances: [], path: [{ x: -2, y: 10, z: -1 }, { x: -2, y: 10, z: 1 }],
  deepestY: 10, dug: 0, ores: {}, createdAt: 100, lastUsedAt: 200, uses: 1,
} satisfies PassageRecord;

const psgTie2 = {
  id: 'psg_tie2', worldId: 'w1', dim: 'overworld', kind: 'bridge',
  entrances: [], path: [{ x: -3, y: 10, z: 0 }],
  deepestY: 10, dug: 4, ores: { coal_ore: 1 }, createdAt: 101, lastUsedAt: 201, uses: 2,
} satisfies PassageRecord;

const psgEmpty = {
  id: 'psg_empty', worldId: 'w1', dim: 'overworld',
  entrances: [], path: [], deepestY: 5, dug: 0, ores: {}, createdAt: 1, lastUsedAt: 2, uses: 0,
} satisfies PassageRecord;

const psgOtherWorld = {
  id: 'psg_w2', worldId: 'w2', dim: 'overworld',
  entrances: [], path: [{ x: 0, y: 10, z: 0 }], deepestY: 10, dug: 0, ores: {}, createdAt: 3, lastUsedAt: 4, uses: 0,
} satisfies PassageRecord;

const psgOtherDim = {
  id: 'psg_nether', worldId: 'w1', dim: 'the_nether',
  entrances: [], path: [{ x: 0, y: 10, z: 0 }], deepestY: 10, dug: 0, ores: {}, createdAt: 5, lastUsedAt: 6, uses: 0,
} satisfies PassageRecord;

const psgMissingWorld = {
  id: 'psg_default', dim: 'overworld',
  entrances: [], path: [{ x: 0, y: 10, z: 0 }], deepestY: 10, dug: 0, ores: {}, createdAt: 7, lastUsedAt: 8, uses: 0,
} satisfies PassageRecord;

const querySnapshot: LegacySpatialSnapshot = deepFreeze({
  worldId: 'w1',
  passages: [psgA, psgTie, psgTie2, psgEmpty, psgOtherWorld, psgOtherDim],
  landmarks: [],
});

const queryContext = { worldId: 'w1', dim: 'overworld', pos: { x: -2, y: 10, z: 0 } };
const scope = { worldId: 'w1', dim: 'overworld', historical: true, connectivity: 'unknown', note: PASSAGE_NOTE };
const summaryA = {
  id: 'psg_a', kind: 'walked', surfaceReferences: [{ x: 0, y: 10, z: 0 }], deepestY: -3, createdAt: 111,
  lastUsedAt: 222, dug: 7, ores: { iron_ore: 2 }, pointCount: 65, nearestPointIndex: 2, distance: 0,
};
const summaryTie = {
  id: 'psg_tie', kind: 'dug', surfaceReferences: [], deepestY: 10, createdAt: 100,
  lastUsedAt: 200, dug: 0, ores: {}, pointCount: 2, nearestPointIndex: 0, distance: 1,
};
const summaryTie2 = {
  id: 'psg_tie2', kind: 'bridge', surfaceReferences: [], deepestY: 10, createdAt: 101,
  lastUsedAt: 201, dug: 4, ores: { coal_ore: 1 }, pointCount: 1, nearestPointIndex: 0, distance: 1,
};
const summaryEmpty = {
  id: 'psg_empty', kind: 'dug', surfaceReferences: [], deepestY: 5, createdAt: 1,
  lastUsedAt: 2, dug: 0, ores: {}, pointCount: 0, nearestPointIndex: null, distance: null,
};

// ------------------------------------------------------- exact query bytes

test('passages list reproduces the old thinker bytes, order and omission fields', () => {
  const { backend, calls } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
  const expected = {
    ...scope,
    action: 'list',
    records: [summaryA, summaryTie, summaryTie2, summaryEmpty],
  };
  assert.equal(queryLegacyPassages(backend, {}, queryContext), JSON.stringify(expected));
  assert.deepEqual(calls, [{ method: 'passages', dim: 'overworld' }]);
  const parsed = JSON.parse(queryLegacyPassages(backend, {}, queryContext));
  for (const record of parsed.records) {
    assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'deepestY', 'distance', 'dug', 'id', 'kind', 'lastUsedAt', 'nearestPointIndex', 'ores', 'pointCount', 'surfaceReferences'].sort());
    assert.ok(!('path' in record) && !('links' in record) && !('uses' in record), 'list must omit path/links/uses');
    assert.ok(!('entrances' in record), 'list must expose surfaceReferences, not entrances');
  }
  assert.deepEqual(parsed.records.map((r: { id: string }) => r.id), ['psg_a', 'psg_tie', 'psg_tie2', 'psg_empty']);
});

test('passages read paginates 65 negative-coordinate points as 32/32/1 pages', () => {
  const read = (offset: number) => {
    const { backend } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
    return queryLegacyPassages(backend, { id: 'psg_a', offset }, queryContext);
  };
  const page0 = { ...scope, action: 'read', ...summaryA, path: queryPath.slice(0, 32), offset: 0, total: 65, nextOffset: 32 };
  const page32 = { ...scope, action: 'read', ...summaryA, path: queryPath.slice(32, 64), offset: 32, total: 65, nextOffset: 64 };
  const page64 = { ...scope, action: 'read', ...summaryA, path: queryPath.slice(64, 96), offset: 64, total: 65, nextOffset: null };
  assert.equal(read(0), JSON.stringify(page0));
  assert.equal(read(32), JSON.stringify(page32));
  assert.equal(read(64), JSON.stringify(page64));
  const first = JSON.parse(read(32)).path as { x: number }[];
  assert.equal(first.length, 32);
  assert.equal(first[0].x, -32, 'negative coordinates keep their sign and order');
  const last = JSON.parse(read(64)).path as { x: number }[];
  assert.deepEqual(last, [{ x: -64, y: 10, z: 0 }]);
});

test('passages read past the end is empty with null nextOffset; missing id keeps the old JSON error', () => {
  const read = (offset: number) => {
    const { backend } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
    return queryLegacyPassages(backend, { id: 'psg_a', offset }, queryContext);
  };
  assert.equal(read(65), JSON.stringify({ ...scope, action: 'read', ...summaryA, path: [], offset: 65, total: 65, nextOffset: null }));
  assert.equal(read(100), JSON.stringify({ ...scope, action: 'read', ...summaryA, path: [], offset: 100, total: 65, nextOffset: null }));
  const missing = { ...scope, error: NOT_FOUND_ERROR, id: 'missing' };
  const { backend, calls } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
  assert.equal(queryLegacyPassages(backend, { id: ' missing ' }, queryContext), JSON.stringify(missing));
  assert.deepEqual(calls, [{ method: 'passages', dim: 'overworld' }]);
});

test('id whitespace is trimmed but the stored record id is unchanged', () => {
  const { backend } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
  const parsed = JSON.parse(queryLegacyPassages(backend, { id: '  psg_tie  ' }, queryContext));
  assert.equal(parsed.action, 'read');
  assert.equal(parsed.id, 'psg_tie');
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.path, psgTie.path);
});

test('all old id/offset validation errors and their order are preserved without a backend read', () => {
  const cases: { raw: Record<string, unknown>; message: string }[] = [
    { raw: { id: 7 }, message: ID_ERROR },
    { raw: { id: '' }, message: ID_ERROR },
    { raw: { id: '   ' }, message: ID_ERROR },
    { raw: { id: null }, message: ID_ERROR },
    { raw: { id: 7, offset: -1 }, message: ID_ERROR },
    { raw: { id: '', offset: 'bad' }, message: ID_ERROR },
    { raw: { offset: -1 }, message: OFFSET_ERROR },
    { raw: { offset: 1.5 }, message: OFFSET_ERROR },
    { raw: { offset: '3' }, message: OFFSET_ERROR },
    { raw: { offset: NaN }, message: OFFSET_ERROR },
    { raw: { offset: Infinity }, message: OFFSET_ERROR },
    { raw: { offset: 0 }, message: OFFSET_WITHOUT_ID_ERROR },
    { raw: { id: undefined, offset: 0 }, message: OFFSET_WITHOUT_ID_ERROR },
  ];
  for (const { raw, message } of cases) {
    const { backend, calls } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
    assert.equal(queryLegacyPassages(backend, raw, queryContext), message);
    assert.deepEqual(calls, [], `invalid input ${JSON.stringify(raw)} must not read records`);
  }
});

test('explicit undefined defaults behave like the old query', () => {
  const list = () => {
    const { backend, calls } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
    const result = queryLegacyPassages(backend, { id: undefined, offset: undefined }, queryContext);
    assert.deepEqual(calls, [{ method: 'passages', dim: 'overworld' }]);
    return result;
  };
  assert.equal(JSON.parse(list()).action, 'list');
  const { backend } = counting(createJsonWorldMemoryReadBackend(() => querySnapshot));
  const parsed = JSON.parse(queryLegacyPassages(backend, { id: 'psg_a', offset: undefined }, queryContext));
  assert.equal(parsed.action, 'read');
  assert.equal(parsed.offset, 0);
});

test('query-level world filter uses the literal default scope for records without worldId', () => {
  const records = [psgMissingWorld, psgOtherWorld];
  const backend: LegacySpatialReadBackend = {
    passages: () => records,
    landmarks: () => [],
    bases: () => [],
    base: () => undefined,
    findLandmark: () => undefined,
  };
  const inDefault = JSON.parse(queryLegacyPassages(backend, {}, { ...queryContext, worldId: 'default' }));
  assert.deepEqual(inDefault.records.map((r: { id: string }) => r.id), ['psg_default']);
  const inW1 = JSON.parse(queryLegacyPassages(backend, {}, queryContext));
  assert.deepEqual(inW1.records, []);
  assert.ok(!('worldId' in psgMissingWorld), 'the query must not fill worldId into the original record');
});

// ------------------------------------------------------- typed snapshot read

const basePlain: Landmark & { note: string } = {
  id: 'base_ow_plain', kind: 'base', label: '草原小屋', dim: 'overworld',
  pos: { x: -10, y: 64, z: 20 }, ts: 10, worldId: 'w1', note: 'keep-extra',
};
const baseNetherPrimary = {
  id: 'base_nether', kind: 'base', label: '下界主基地', dim: 'the_nether',
  pos: { x: 4, y: 32, z: -8 }, ts: 20, primary: true, worldId: 'w1',
} satisfies Landmark;
const baseOverworldPrimary = {
  id: 'base_ow_primary', kind: 'base', label: '矿山基地', dim: 'overworld',
  pos: { x: -40, y: 12, z: 5 }, ts: 30, primary: true, worldId: 'w1',
} satisfies Landmark;
const baseEndFallback = {
  id: 'base_end', kind: 'base', label: '末地前哨', dim: 'the_end',
  pos: { x: 0, y: 70, z: 0 }, ts: 40, worldId: 'w1',
} satisfies Landmark;
const baseOtherWorld = {
  id: 'base_w2', kind: 'base', label: '别世界', dim: 'overworld',
  pos: { x: 0, y: 64, z: 0 }, ts: 50, primary: true, worldId: 'w2',
} satisfies Landmark;
const baseMissingWorld = {
  id: 'base_default', kind: 'base', label: '默认世界', dim: 'overworld',
  pos: { x: 1, y: 64, z: 1 }, ts: 60,
} satisfies Landmark;
const resourceMark = {
  id: 'res_ore', kind: 'resource', label: '铁矿', dim: 'overworld',
  pos: { x: -5, y: 20, z: -5 }, ts: 70, worldId: 'w1',
} satisfies Landmark;
const landmarkSub = {
  id: 'lm_sub', kind: 'discovery', label: '矿洞入口', dim: 'overworld',
  pos: { x: 2, y: 30, z: 2 }, ts: 80, worldId: 'w1',
} satisfies Landmark;
const landmarkExact = {
  id: 'lm_exact', kind: 'discovery', label: '矿洞', dim: 'overworld',
  pos: { x: -2, y: 30, z: -2 }, ts: 81, worldId: 'w1',
} satisfies Landmark;
const landmarkById = {
  id: 'target_id', kind: 'discovery', label: '别处', dim: 'overworld',
  pos: { x: 5, y: 64, z: 5 }, ts: 82, worldId: 'w1',
} satisfies Landmark;
const landmarkLabelWins = {
  id: 'other_id', kind: 'discovery', label: 'target_id', dim: 'overworld',
  pos: { x: 6, y: 64, z: 6 }, ts: 83, worldId: 'w1',
} satisfies Landmark;
const containerLandmark: Landmark & { tags: string[] } = {
  id: 'lm_chest', kind: 'discovery', label: '我的箱子', dim: 'overworld',
  pos: { x: 3, y: 64, z: -7 }, ts: 84, worldId: 'w1', tags: ['container'],
};

const spatialSnapshot: LegacySpatialSnapshot = deepFreeze({
  worldId: 'w1',
  passages: [psgA, psgTie, psgOtherDim, psgOtherWorld, psgMissingWorld],
  landmarks: [
    basePlain, baseNetherPrimary, resourceMark, baseOverworldPrimary,
    baseOtherWorld, baseEndFallback, baseMissingWorld,
    landmarkSub, landmarkExact, landmarkById, landmarkLabelWins, containerLandmark,
  ],
});

test('snapshot backend isolates worlds and dimensions and preserves arrays and missing passages', () => {
  const backend = createJsonWorldMemoryReadBackend(() => spatialSnapshot);
  assert.deepEqual(backend.passages().map((r) => r.id), ['psg_a', 'psg_tie', 'psg_nether']);
  assert.deepEqual(backend.passages('overworld').map((r) => r.id), ['psg_a', 'psg_tie']);
  assert.deepEqual(backend.passages('the_nether').map((r) => r.id), ['psg_nether']);
  assert.deepEqual(backend.passages('').map((r) => r.id), ['psg_a', 'psg_tie', 'psg_nether'], 'empty dim keeps the old !dim behavior');
  assert.deepEqual(createJsonWorldMemoryReadBackend(() => ({ worldId: 'w1', landmarks: [] })).passages(), []);
});

test('snapshot backend retains all legacy and unknown fields and isolates the source from mutation', () => {
  const backend = createJsonWorldMemoryReadBackend(() => spatialSnapshot);
  const got = backend.passages('overworld');
  assert.deepEqual(got, [psgA, psgTie]);
  assert.notEqual(got[0], psgA);
  assert.notEqual(got[0].path, psgA.path);
  const copy = got[0] as typeof psgA;
  copy.path[0].x = 999;
  copy.path.reverse();
  copy.links![0].a.x = 999;
  copy.ores.iron_ore = 99;
  copy.extraMeta.labels[0] = 'mutated';
  (copy.extraMeta.labels[1] as { nested: boolean }).nested = false;
  assert.deepEqual(psgA.path[0], { x: 0, y: 10, z: 0 });
  assert.deepEqual(psgA.path[31], { x: -31, y: 10, z: 0 });
  assert.equal(psgA.links![0].a.x, 0);
  assert.equal(psgA.ores.iron_ore, 2);
  assert.equal(psgA.extraMeta.labels[0], 'keep');
  assert.deepEqual(psgA.extraMeta.labels[1], { nested: true });
  const landmarks = backend.landmarks();
  landmarks[0].pos.x = 999;
  (landmarks[0] as typeof basePlain).note = 'mutated';
  assert.equal(basePlain.pos.x, -10);
  assert.equal(basePlain.note, 'keep-extra');
  assert.equal(backend.bases('overworld')[0].id, 'base_ow_plain');
  assert.equal(backend.base('overworld')!.id, 'base_ow_primary');
});

test('base and bases preserve original array order, primary selection and cross-dimension fallback', () => {
  const backend = createJsonWorldMemoryReadBackend(() => spatialSnapshot);
  assert.deepEqual(backend.landmarks().map((l) => l.id), [
    'base_ow_plain', 'base_nether', 'res_ore', 'base_ow_primary', 'base_end', 'lm_sub', 'lm_exact', 'target_id', 'other_id', 'lm_chest',
  ]);
  assert.deepEqual(backend.bases().map((l) => l.id), ['base_ow_plain', 'base_nether', 'base_ow_primary', 'base_end']);
  assert.deepEqual(backend.bases('overworld').map((l) => l.id), ['base_ow_plain', 'base_ow_primary']);
  assert.equal(backend.base('overworld')!.id, 'base_ow_primary', 'first primary in the matching dimension');
  assert.equal(backend.base()!.id, 'base_nether', 'first primary across dimensions in array order');
  assert.equal(backend.base('the_end')!.id, 'base_end', 'no primary falls back to the first matching base');
  assert.equal(backend.base('the_nether')!.id, 'base_nether');
  assert.equal(backend.base('missing_dim'), undefined);
});

test('findLandmark preserves id, exact-label, substring and base-alias precedence', () => {
  const backend = createJsonWorldMemoryReadBackend(() => spatialSnapshot);
  assert.equal(backend.findLandmark('TARGET_ID')!.id, 'target_id', 'id match wins over an earlier exact label');
  assert.equal(backend.findLandmark('矿洞')!.id, 'lm_exact', 'exact label wins over an earlier substring');
  assert.equal(backend.findLandmark('矿洞入口')!.id, 'lm_sub');
  assert.equal(backend.findLandmark('入口')!.id, 'lm_sub', 'substring match stays case/order compatible');
  assert.equal(backend.findLandmark('base', 'overworld')!.id, 'base_ow_primary');
  assert.equal(backend.findLandmark('基地')!.id, 'base_nether');
  assert.equal(backend.findLandmark('基地', 'the_end')!.id, 'base_end');
  assert.equal(backend.findLandmark('矿洞', 'the_nether'), undefined);
  assert.equal(backend.findLandmark('nothing'), undefined);
});

test('container landmark keeps the old display projection without reading or copying contents', () => {
  const backend = createJsonWorldMemoryReadBackend(() => spatialSnapshot);
  const found = backend.findLandmark('我的箱子');
  assert.deepEqual(found, { ...containerLandmark, pos: { x: 3, y: 64, z: -7 }, radius: 0, precise: true, observedAt: 84 });
  assert.ok(!('radius' in containerLandmark));
  assert.ok(!('precise' in containerLandmark));
  assert.ok(!('observedAt' in containerLandmark));
  assert.ok(!('contents' in found!), 'legacy display projection must not invent a chest contents field');
  assert.deepEqual(containerLandmark.pos, { x: 3, y: 64, z: -7 });
  assert.deepEqual(containerLandmark.tags, ['container']);
  const nonContainer = backend.findLandmark('矿洞')!;
  assert.ok(!('radius' in nonContainer) && !('precise' in nonContainer) && !('observedAt' in nonContainer));
});

test('each top-level snapshot operation reads exactly one latest snapshot', () => {
  const snapA = deepFreeze({ worldId: 'w1', passages: [psgA], landmarks: [baseOverworldPrimary, landmarkExact] });
  const snapB = deepFreeze({ worldId: 'w1', passages: [psgTie], landmarks: [baseNetherPrimary, landmarkSub] });
  const oneRead = <T>(invoke: (backend: LegacySpatialReadBackend) => T): T => {
    let reads = 0;
    const backend = createJsonWorldMemoryReadBackend(() => { reads++; return reads === 1 ? snapA : snapB; });
    const value = invoke(backend);
    assert.equal(reads, 1, 'composite operations must not mix two snapshots');
    return value;
  };
  assert.deepEqual(oneRead((b) => b.passages('overworld').map((r) => r.id)), ['psg_a']);
  assert.deepEqual(oneRead((b) => b.landmarks().map((l) => l.id)), ['base_ow_primary', 'lm_exact']);
  assert.deepEqual(oneRead((b) => b.bases('overworld').map((l) => l.id)), ['base_ow_primary']);
  assert.equal(oneRead((b) => b.base('overworld')!.id), 'base_ow_primary');
  assert.equal(oneRead((b) => b.findLandmark('base', 'overworld')!.id), 'base_ow_primary');
  assert.equal(oneRead((b) => b.findLandmark('矿洞')!.id), 'lm_exact');
  assert.equal(oneRead((b) => {
    const parsed = JSON.parse(queryLegacyPassages(b, {}, queryContext));
    return parsed.records[0].id;
  }), 'psg_a');
});

test('world switches and source deletions are visible on the next read, with no stale cache', () => {
  let snapshot: LegacySpatialSnapshot = { worldId: 'w1', passages: [psgA], landmarks: [baseOverworldPrimary] };
  const backend = createJsonWorldMemoryReadBackend(() => snapshot);
  assert.deepEqual(backend.passages('overworld').map((r) => r.id), ['psg_a']);
  assert.deepEqual(backend.bases().map((l) => l.id), ['base_ow_primary']);
  snapshot = { worldId: 'w1', passages: [], landmarks: [] };
  assert.deepEqual(backend.passages('overworld'), [], 'deleted record must not be resurrected');
  assert.deepEqual(backend.bases(), []);
  assert.equal(backend.findLandmark('矿山基地'), undefined);
  snapshot = { worldId: 'w2', passages: [psgOtherWorld], landmarks: [baseOtherWorld] };
  assert.deepEqual(backend.passages().map((r) => r.id), ['psg_w2']);
  assert.equal(backend.base()!.id, 'base_w2');
  assert.equal(backend.findLandmark('草原小屋'), undefined, 'no cross-world fallback');
  snapshot = { worldId: 'default', passages: [psgMissingWorld], landmarks: [baseMissingWorld] };
  assert.deepEqual(backend.passages().map((r) => r.id), ['psg_default']);
  assert.ok(!('worldId' in backend.passages()[0]), 'scope is not filled into the record');
  assert.equal(backend.base()!.id, 'base_default');
});

test('snapshot facade reads only the spatial lists, not unrelated root fields', () => {
  const snapshot = { worldId: 'w1', passages: [psgA], landmarks: [] } as LegacySpatialSnapshot;
  Object.defineProperty(snapshot, 'chests', {
    enumerable: true,
    get() { throw new Error('facade touched unrelated root field'); },
  });
  const backend = createJsonWorldMemoryReadBackend(() => snapshot);
  assert.equal(backend.passages('overworld').length, 1);
  assert.deepEqual(backend.landmarks(), []);
  assert.deepEqual(backend.bases(), []);
  assert.equal(backend.base(), undefined);
  assert.equal(backend.findLandmark('missing'), undefined);
});

// ------------------------------------------------------- owner read adapter

const makeHost = () => {
  const state = {
    worldId: 'w1',
    passages: [structuredClone(psgA), structuredClone(psgTie)] as PassageRecord[],
    landmarks: [structuredClone(baseOverworldPrimary), structuredClone(landmarkById), structuredClone(containerLandmark)] as Landmark[],
  };
  const calls: string[] = [];
  let writes = 0;
  const write = (name: string): never => { writes++; throw new Error(`unexpected write: ${name}`); };
  const host = {
    state,
    passages(dim?: string) {
      calls.push(`passages:${dim ?? '<none>'}`);
      assert.equal(this, host);
      return state.passages.filter((r) => (r.worldId ?? 'default') === state.worldId && (!dim || r.dim === dim));
    },
    landmarks() {
      calls.push('landmarks');
      assert.equal(this, host);
      return state.landmarks.filter((l) => (l.worldId ?? 'default') === state.worldId);
    },
    bases(dim?: string) {
      calls.push(`bases:${dim ?? '<none>'}`);
      assert.equal(this, host);
      return state.landmarks.filter((l) => (l.worldId ?? 'default') === state.worldId && l.kind === 'base' && (!dim || l.dim === dim));
    },
    base(dim?: string) {
      calls.push(`base:${dim ?? '<none>'}`);
      assert.equal(this, host);
      const bases = state.landmarks.filter((l) => (l.worldId ?? 'default') === state.worldId && l.kind === 'base' && (!dim || l.dim === dim));
      return bases.find((l) => l.primary) ?? bases[0];
    },
    findLandmark(q: string, dim?: string) {
      calls.push(`findLandmark:${q}:${dim ?? '<none>'}`);
      assert.equal(this, host);
      const s = q.trim().toLowerCase();
      const candidates = state.landmarks.filter((l) => (l.worldId ?? 'default') === state.worldId && (!dim || l.dim === dim));
      return candidates.find((l) => l.id.toLowerCase() === s) ?? candidates.find((l) => l.label.toLowerCase() === s) ?? candidates.find((l) => l.label.toLowerCase().includes(s));
    },
    savePassage: () => write('savePassage'),
    forgetPassage: () => write('forgetPassage'),
    removeLandmark: () => write('removeLandmark'),
    selectBase: () => write('selectBase'),
    setWorld: () => write('setWorld'),
    checkpoint: () => write('checkpoint'),
    close: () => write('close'),
  };
  return { host, state, calls, writes: () => writes };
};

test('owner adapter delegates each read with its original binding and returns isolated clones', () => {
  const { host, state, calls, writes } = makeHost();
  const adapter = createWorldMemoryReadAdapter(host);
  const passages = adapter.passages('overworld');
  const landmarks = adapter.landmarks();
  const bases = adapter.bases('overworld');
  const base = adapter.base('overworld');
  const found = adapter.findLandmark('target_id', 'overworld');
  assert.deepEqual(calls, [
    'passages:overworld', 'landmarks', 'bases:overworld', 'base:overworld', 'findLandmark:target_id:overworld',
  ]);
  assert.deepEqual(passages.map((r) => r.id), ['psg_a', 'psg_tie']);
  assert.equal(base!.id, 'base_ow_primary');
  assert.equal(found!.id, 'target_id');
  assert.equal(writes(), 0, 'never invoke owner write/lifecycle methods');
  passages[0].path[0].x = 999;
  passages[0].ores.iron_ore = 99;
  landmarks[0].pos.x = 999;
  bases[0].pos.z = 999;
  base!.pos.y = 999;
  found!.pos.x = 999;
  assert.equal(state.passages[0].path[0].x, 0);
  assert.equal(state.passages[0].ores.iron_ore, 2);
  assert.equal(state.landmarks[0].pos.x, -40);
  assert.equal(state.landmarks[0].pos.z, 5);
});

test('owner adapter sees owner deletions and world changes on the next call', () => {
  const { host, state } = makeHost();
  const adapter = createWorldMemoryReadAdapter(host);
  assert.deepEqual(adapter.passages('overworld').map((r) => r.id), ['psg_a', 'psg_tie']);
  state.passages = state.passages.filter((r) => r.id !== 'psg_a');
  assert.deepEqual(adapter.passages('overworld').map((r) => r.id), ['psg_tie'], 'no cached deleted record');
  state.worldId = 'w2';
  state.passages = [structuredClone(psgOtherWorld)];
  assert.deepEqual(adapter.passages().map((r) => r.id), ['psg_w2']);
  assert.deepEqual(adapter.landmarks(), [], 'no cross-world fallback');
});

test('owner adapter preserves owner errors instead of falling back', () => {
  const { host } = makeHost();
  const boom = new Error('owner read failed');
  const failing = { ...host, passages() { throw boom; } };
  const adapter = createWorldMemoryReadAdapter(failing);
  assert.throws(() => adapter.passages('overworld'), (error) => error === boom);
  const failingBase = { ...host, base() { throw boom; } };
  assert.throws(() => createWorldMemoryReadAdapter(failingBase).base(), (error) => error === boom);
  assert.deepEqual(createWorldMemoryReadAdapter({ ...host, passages: () => [] }).passages(), [], 'an empty owner result stays empty');
});

// ------------------------------------------------ existing pure helpers still work

const routeMain = {
  id: 'route_main', worldId: 'w1', dim: 'overworld', kind: 'dug',
  entrances: [{ x: -9, y: 40, z: 0 }],
  path: [
    { x: 0, y: 40, z: 0 }, { x: -3, y: 40, z: 0 }, { x: -6, y: 40, z: 0 }, { x: -9, y: 40, z: 0 },
    { x: -9, y: 40, z: -3 }, { x: -9, y: 40, z: -6 },
  ],
  deepestY: 40, dug: 10, ores: {}, createdAt: 5, lastUsedAt: 6, uses: 1,
} satisfies PassageRecord;
const routeBranch = {
  id: 'route_branch', worldId: 'w1', dim: 'overworld', kind: 'walked',
  entrances: [],
  path: [{ x: -11, y: 40, z: -6 }, { x: -14, y: 40, z: -6 }, { x: -17, y: 40, z: -6 }],
  deepestY: 40, dug: 0, ores: {}, createdAt: 7, lastUsedAt: 8, uses: 1,
} satisfies PassageRecord;

test('backend records feed unchanged route/next/anchor/fragmentation helpers with old results', () => {
  const backend = createJsonWorldMemoryReadBackend(() => ({ worldId: 'w1', passages: [routeMain, routeBranch], landmarks: [] }));
  const recs = backend.passages('overworld');
  const originals = [routeMain, routeBranch];
  assert.deepEqual(recs.map((r) => r.path), [routeMain.path, routeBranch.path], 'negative route coordinates stay untouched');
  const from = { x: 0, y: 40, z: 0 };
  const to = { x: -17, y: 40, z: -6 };
  const opts = { near: 6, hop: 5, link: 3.5 };
  const expectedRoute = passageRoute(originals, from, to, opts);
  assert.deepEqual(passageRoute(recs, from, to, opts), expectedRoute);
  assert.deepEqual(expectedRoute!.map((p) => `${p.x},${p.z}`), ['0,0', '-3,0', '-6,0', '-9,0', '-9,-3', '-9,-6', '-11,-6', '-14,-6', '-17,-6']);
  assert.deepEqual(passageNext(recs, from, to), passageNext(originals, from, to));
  assert.deepEqual(passageNext(recs, from, to), { next: { x: -3, y: 40, z: 0 }, inside: true, kind: 'dug' });
  assert.deepEqual(passageSurfaceAnchor(recs, from), passageSurfaceAnchor(originals, from));
  assert.deepEqual(passageSurfaceAnchor(recs, from), { x: -9, y: 40, z: 0 });
  assert.deepEqual(passageDeepestAnchor(recs, from), passageDeepestAnchor(originals, from));
  assert.deepEqual(passageFragmentation(recs), passageFragmentation(originals));
  assert.deepEqual(passageFragmentation(recs), { records: 2, points: 9, components: 1, pieces: [{ points: 9, records: 2 }] });
});

// ------------------------------------------------------- module boundary

test('module source has no runtime store/config import and constructs no services', () => {
  const source = readFileSync(new URL('../src/spatial/legacy-memory-compat.ts', import.meta.url), 'utf8');
  const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)([^;]+);/gm)].map((match) => match[1]);
  assert.ok(runtimeImports.length > 0, 'test should see the pure chest-memory import');
  for (const statement of runtimeImports) {
    assert.doesNotMatch(statement, /memory\/store\.ts|src\/config|\bconfig\/|sqlite/i, `unexpected runtime import: ${statement}`);
  }
  assert.match(source, /^import type \{[^}]*WorldMemory[^}]*\} from '\.\.\/memory\/store\.ts';/m);
  assert.doesNotMatch(source, /\bnew\s+(?:WorldMemory|TravelStore)\b/);
  assert.doesNotMatch(source, /better-sqlite3/);
  assert.doesNotMatch(source, /\b(?:savePassage|forgetPassage|removeLandmark|selectBase|setWorld)\s*\(/);
});
