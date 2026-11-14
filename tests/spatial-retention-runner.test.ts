import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ContainerAnchorFact,
  FactPage,
  PlaceFact,
  ResourceAnchorFact,
  SectionKey,
  SectionResidency,
  VoxelDirectoryEntry,
} from 'curio-minecraft-3d-memory';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { ChunkVisitRecord, PlacedBlockRecord } from 'curio-minecraft-3d-memory/storage/sqlite';
import { EventBus } from '../src/events.ts';
import { RetentionRunner, type RetentionSettings } from '../src/spatial/retention-runner.ts';

const WORLD = 'w';
const DIM = 'overworld';
const provenance = { source: 'test' };

const entry = (cx: number, sy = 4, overrides: Partial<Omit<VoxelDirectoryEntry, 'key'>> = {}): VoxelDirectoryEntry => {
  const seq = overrides.seq ?? cx * 10 + sy;
  return {
    key: { worldId: WORLD, dim: DIM, cx, cz: 0, sy },
    seq, bytes: overrides.bytes ?? 100, observedCells: overrides.observedCells ?? 300,
    paletteEntries: overrides.paletteEntries ?? 5, revision: overrides.revision ?? seq,
  };
};

const settings = (overrides: Partial<RetentionSettings> = {}): RetentionSettings => ({
  enabled: true, trigger: 0.8, target: 0.5, maxSectionsPerPass: 16, maxCellsPerPass: 200_000,
  keepHalo: 1, keepVisits: 1, cooldownMs: 60_000, ...overrides,
});

const limits = { maxVoxelSections: 100, maxObservedCells: 1000, maxPaletteEntries: 1000, maxBytes: 1_000_000 };

function pageOf<T extends { id: string }>(items: readonly T[], after: string | undefined, limit: number): FactPage<T> {
  const index = after === undefined ? 0 : items.findIndex((item) => item.id > after);
  const start = index === -1 ? items.length : index;
  const page = items.slice(start, start + limit);
  return { items: page, total: items.length, ...(start + page.length < items.length ? { nextAfter: page.at(-1)!.id } : {}) };
}

function fixture(entries: readonly VoxelDirectoryEntry[], overrides: {
  settings?: RetentionSettings;
  places?: readonly PlaceFact[];
  resources?: readonly ResourceAnchorFact[];
  containers?: readonly ContainerAnchorFact[];
  placed?: readonly PlacedBlockRecord[];
  visits?: readonly ChunkVisitRecord[];
  resident?: readonly SectionKey[];
  reject?: readonly SectionKey[];
  current?: { x: number; y: number; z: number };
  base?: { x: number; y: number; z: number } | null;
  landmarks?: readonly { dim: string; pos: { x: number; y: number; z: number } }[];
  pruneError?: Error;
  busy?: boolean;
  eager?: boolean;
} = {}) {
  const pruned: SectionKey[][] = [];
  const events: { type: string; msg: string; data?: Record<string, unknown> }[] = [];
  const bus = new EventBus();
  bus.on('event', (event) => { events.push({ type: event.type, msg: event.msg, ...(event.data === undefined ? {} : { data: event.data }) }); });
  const orderedFacts = <T extends { id: string }>(items: readonly T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const session = {
    voxelLoading: overrides.eager === true ? 'eager' as const : 'manual' as const,
    busy: overrides.busy === true,
    voxelDirectoryStats: () => ({
      sections: entries.length,
      observedCells: entries.reduce((sum, e) => sum + e.observedCells, 0),
      paletteEntries: entries.reduce((sum, e) => sum + e.paletteEntries, 0),
      bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
      maxSeq: Math.max(-1, ...entries.map((e) => e.seq)),
    }),
    directoryPage: async ({ after, limit = 512 }: { after?: number; limit?: number } = {}) => {
      const sorted = [...entries].sort((a, b) => a.seq - b.seq).filter((e) => after === undefined || e.seq > after);
      const items = sorted.slice(0, limit);
      return { items, ...(items.length < sorted.length ? { nextAfter: items.at(-1)!.seq } : {}) };
    },
    sectionResidency: (key: SectionKey): { residency: SectionResidency } => ({
      residency: (overrides.resident ?? []).some((r) => r.dim === key.dim && r.cx === key.cx && r.cz === key.cz && r.sy === key.sy)
        ? 'resident' : 'not_resident',
    }),
    pruneSections: async (keys: readonly SectionKey[]) => {
      if (overrides.pruneError !== undefined) throw overrides.pruneError;
      pruned.push([...keys]);
      const rejected = (overrides.reject ?? []).filter((r) => keys.some((key) => key.dim === r.dim && key.cx === r.cx && key.cz === r.cz && key.sy === r.sy));
      const deleted = keys.filter((key) => !rejected.some((r) => key.dim === r.dim && key.cx === r.cx && key.cz === r.cz && key.sy === r.sy));
      return { deleted: [...deleted], rejected: rejected.map((key) => ({ key, reason: 'pinned' as const })), totals: { sections: 0, observedCells: 0, paletteEntries: 0, bytes: 0, maxSeq: -1 } };
    },
    facts: {
      places: (query: { after?: string } = {}) => pageOf(orderedFacts(overrides.places ?? []), query.after, 1),
      resources: (query: { after?: string } = {}) => pageOf(orderedFacts(overrides.resources ?? []), query.after, 1),
      containers: (query: { after?: string } = {}) => pageOf(orderedFacts(overrides.containers ?? []), query.after, 1),
    },
    ledger: {
      placedBlocks: () => [...(overrides.placed ?? [])],
      chunkVisits: () => [...(overrides.visits ?? [])],
    },
  };
  const current = overrides.current ?? { x: -16_000, y: 64, z: 0 };
  const base = overrides.base === null ? undefined : overrides.base ?? current;
  const runner = new RetentionRunner({
    worldId: WORLD, session, settings: overrides.settings ?? settings(), limits,
    memory: {
      base: () => base === undefined ? undefined : { dim: DIM, pos: base },
      landmarks: () => overrides.landmarks ?? [],
    },
    bus,
    current: () => ({ dim: DIM, pos: current }),
  });
  return { runner, pruned, events };
}

const place = (id: string, x: number): PlaceFact => ({
  id, kind: 'base', label: 'base', worldId: WORLD, dim: DIM, observedAt: 1,
  location: { kind: 'exact', pos: { x, y: 64, z: 0 } }, source: provenance, gone: false,
});
const resource = (id: string, x: number): ResourceAnchorFact => ({
  id, worldId: WORLD, dim: DIM, label: 'iron_ore', sourceCell: { x, y: 64, z: 0 },
  observedAt: 1, source: provenance, revoked: false,
});
const container = (id: string, x: number): ContainerAnchorFact => ({
  id, worldId: WORLD, dim: DIM, pos: { x, y: 64, z: 0 }, externalRef: id,
  observedAt: 1, source: provenance, gone: false,
});
const visit = (cx: number, count: number): ChunkVisitRecord => ({ key: `k${cx}`, worldId: WORLD, dim: DIM, cx, cz: 0, count, source: 'live' });

test('水位以下不裁剪；非 manual/关闭/忙碌时不动', async () => {
  const below = fixture([entry(0, 0, { observedCells: 100 })]);
  assert.equal((await below.runner.run()).status, 'below_trigger');
  assert.equal(below.pruned.length, 0);

  const over = [entry(0, 0), entry(1, 0), entry(2, 0)];
  assert.equal((await fixture(over, { eager: true }).runner.run()).status, 'eager');
  assert.equal((await fixture(over, { busy: true }).runner.run()).status, 'busy');
  assert.equal((await fixture(over, { settings: settings({ enabled: false }) }).runner.run()).status, 'disabled');
});

test('超水位时保留事实/热点/驻留列，只忘最老的其余列并发布事实', async () => {
  const entries = [entry(0), entry(1), entry(2), entry(3)];
  const { runner, pruned, events } = fixture(entries, {
    settings: settings({ keepHalo: 0 }),
    places: [place('p1', 16)],
    resources: [resource('r1', 32)],
    visits: [visit(3, 9)],
  });
  const result = await runner.run();
  assert.equal(result.status, 'pruned', JSON.stringify(result));
  assert.deepEqual(pruned, [[{ worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 }]]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'spatial_retention');
  assert.match(events[0]!.msg, /overworld 1 个 Section/);
  assert.match(events[0]!.msg, /未记录/);
  assert.equal(events[0]!.data?.deleted, 1);
});

test('只按真正删除的 Section 计数：被库拒绝的部分不算已遗忘', async () => {
  const entries = [entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })];
  const { runner, events } = fixture(entries, {
    settings: settings({ keepHalo: 0, target: 0.2 }),
    reject: [{ worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 }],
  });
  const result = await runner.run();
  assert.equal(result.status, 'pruned');
  assert.equal(result.deleted, 1);
  assert.equal(events[0]!.data?.rejected, 1);
  assert.equal(events[0]!.data?.observedCells, 400, '只有真正删掉的列计入释放格数');
  assert.match(events[0]!.msg, /本轮未删除/);
});

test('区域事实按整块锚定；保留集占满目标时如实报告这一轮没有删除', async () => {
  const entries = [entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })];
  const area: PlaceFact = {
    ...place('station', 16), location: { kind: 'area', center: { x: 16, y: 64, z: 0 }, radius: 32 },
  };
  const { runner, events, pruned } = fixture(entries, { settings: settings({ keepHalo: 0 }), places: [area] });
  const result = await runner.run();
  assert.equal(result.status, 'nothing');
  assert.equal(pruned.length, 0);
  assert.equal(events.length, 1);
  assert.match(events[0]!.msg, /没有删除/);
  assert.equal(events[0]!.data?.keepSections, 2, '区域事实的多个锚点覆盖整个区域');
});

test('计划全部被库拒绝时如实报告没有删除', async () => {
  const entries = [entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })];
  const { runner, events } = fixture(entries, {
    settings: settings({ keepHalo: 0, target: 0.2 }),
    reject: [
      { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 },
      { worldId: WORLD, dim: DIM, cx: 1, cz: 0, sy: 4 },
    ],
  });
  assert.equal((await runner.run()).status, 'nothing');
  assert.equal(events.length, 1);
  assert.match(events[0]!.msg, /没有删除/);
  assert.equal(events[0]!.data?.rejected, 2);
});

test('当前身体、基地与宿主地标所在列都保留', async () => {
  const entries = [entry(0, 4, { observedCells: 300 }), entry(1, 4, { observedCells: 300 }), entry(2, 4, { observedCells: 300 }), entry(3, 4, { observedCells: 300 })];
  const { runner, pruned } = fixture(entries, {
    settings: settings({ keepHalo: 0 }),
    current: { x: 0, y: 64, z: 0 },
    base: { x: 16, y: 64, z: 0 },
    landmarks: [{ dim: DIM, pos: { x: 32, y: 64, z: 0 } }],
  });
  await runner.run();
  assert.deepEqual(pruned[0]?.map((key) => key.cx), [3], '只删不在当前现场/基地/地标上的列');
});

test('库在裁剪时返回 busy 视为稍后再试，不当作失败', async () => {
  const { runner } = fixture([entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })], {
    settings: settings({ target: 0.2 }),
    pruneError: new PersistenceError('busy', 'session is busy'),
  });
  assert.equal((await runner.run()).status, 'busy');
});

test('驻留中的列不做候选；冷却期内不重复尝试', async () => {
  const entries = [entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })];
  const { runner, pruned } = fixture(entries, {
    resident: [{ worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 }],
    settings: settings({ cooldownMs: 60_000 }),
  });
  assert.equal((await runner.run(1_000)).status, 'pruned');
  assert.deepEqual(pruned[0]?.map((key) => key.cx), [1]);
  assert.equal((await runner.run(2_000)).status, 'cooling');
  assert.equal(pruned.length, 1);
});

test('事实分页全部读取：第二页的资源点也保住所在列', async () => {
  const entries = [entry(0), entry(1), entry(2)];
  const { runner, pruned } = fixture(entries, {
    settings: settings({ keepHalo: 0 }),
    places: [place('a', 16)],
    resources: [resource('a1', 30), resource('a2', 33)], // 分页 limit=1；'a2' 在第二页
  });
  await runner.run();
  assert.ok(pruned[0]?.every((key) => key.cx === 0), '列 1（a1）与列 2（a2）都保留');
});

test('自己放过的方块与容器也保留所在列', async () => {
  const placed: PlacedBlockRecord[] = [{
    key: 'p', worldId: WORLD, dim: DIM, pos: { x: 20, y: 64, z: 0 }, name: 'cobblestone', lruAt: 1, source: 'live',
  }];
  const { runner, pruned } = fixture([entry(0, 4, { observedCells: 400 }), entry(1, 4, { observedCells: 400 })], {
    settings: settings({ keepHalo: 0 }), placed, containers: [container('c1', 33)],
  });
  await runner.run();
  assert.deepEqual(pruned[0]?.map((key) => key.cx), [0], '列 1 被自建方块与容器保住');
});
