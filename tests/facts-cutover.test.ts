import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { cutoverFacts } from '../scripts/spatial-facts-cutover.ts';
import { checkMigrationGate } from '../src/spatial/migration-state.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'w';
const DIM = 'overworld';

/**
 * schema 10 creates no retired route tables, so tests seed the historical
 * world_id/seq/id/payload layouts explicitly.
 */
async function seedLegacyRows(
  databasePath: string,
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[] = [],
): Promise<void> {
  const bootstrap = await openSpatialSession({ databasePath, worldId: String(nodes[0]?.worldId ?? WORLD) });
  try { await bootstrap.checkpoint(); } finally { await bootstrap.close(); }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS spatial_nodes (world_id TEXT, seq INTEGER, id TEXT, payload TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS spatial_edges (world_id TEXT, seq INTEGER, id TEXT, payload TEXT)');
    const insert = (table: string, rows: Record<string, unknown>[]) => rows.forEach((row, index) => {
      db.prepare(`INSERT INTO ${table}(world_id, seq, id, payload) VALUES (?, ?, ?, ?)`)
        .run(String(row.worldId ?? WORLD), index + 1, String(row.id), JSON.stringify(row));
    });
    insert('spatial_nodes', nodes);
    insert('spatial_edges', edges);
  } finally { db.close(); }
}

function rawRows(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      nodes: db.prepare('SELECT world_id, seq, id, payload FROM spatial_nodes ORDER BY id').all(),
      edges: db.prepare('SELECT world_id, seq, id, payload FROM spatial_edges ORDER BY id').all(),
    };
  } finally { db.close(); }
}

const exactNode = (id: string, x: number, y: number, z: number, overrides: Record<string, unknown> = {}) => ({
  id, worldId: WORLD, dim: DIM, kind: 'place', source: 'agent', observedAt: 100,
  location: { kind: 'exact', pos: { x, y, z } },
  ...overrides,
});

function walkEdge(
  from: string,
  to: string,
  fromPos: { x: number; y: number; z: number },
  toPos: { x: number; y: number; z: number },
  options: { edge?: Record<string, unknown>; snapshot?: Record<string, unknown> } = {},
) {
  return {
    id: `edge:${from}->${to}`, from, to, type: 'WALK', basis: 'traversed', source: 'confirmed_walk_path',
    fragmentId: 'trail:test',
    refs: [{
      evidenceId: 'snap:0',
      snapshot: {
        id: 'snap:0', fragmentId: 'trail:test', from: fromPos, to: toPos, worldId: WORLD, dim: DIM,
        sessionId: 'session_test', observedAt: 200, source: 'confirmed_traversal', executionId: 'trail:test', mode: 'walk',
        ...options.snapshot,
      },
    }],
    directed: true, modes: ['walk'], verifications: [],
    ...options.edge,
  };
}

test('offline facts cutover preserves farm fields and commits an explicit migration receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-cutover-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [{ id: 'farm', worldId: WORLD, dim: DIM, kind: 'place', source: 'program', tag: 'resource', label: 'farm: wheat', observedAt: 100,
      location: { kind: 'region', center: { x: 1, y: 64, z: 0 }, radius: 2 },
      metadata: { curio: { type: 'farm', record: { id: 'farm', dim: DIM, pos: { x: 1, y: 64, z: 0 }, crop: 'wheat', plantedAt: 80, cells: [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], harvests: 3 } } } }]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(dry.executed, false); assert.equal(dry.report.migrated, 1);
    const result = await cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite') });
    assert.equal(result.executed, true); assert.equal(existsSync(join(dir, 'backup.sqlite')), true);
    const current = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      const farm = current.facts.places().items[0];
      assert.equal(farm.observedAt, 100); assert.equal(farm.hostData?.farm && (farm.hostData.farm as { harvests: number }).harvests, 3);
    } finally { await current.close(); }
    assert.equal(rawRows(databasePath).nodes.length, 1, '旧 spatial_nodes 行保持原样，不被删除');
    const repeat = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(repeat.report.migrated, 0); assert.equal(repeat.report.conflicts, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startup refuses old semantic data without migration receipt and queries only new facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-gate-'));
  const databasePath = join(dir, 'spatial.sqlite');
  await seedLegacyRows(databasePath, [{ id: 'old', worldId: WORLD, dim: DIM, kind: 'place', source: 'program', tag: 'resource', label: 'old ore', observedAt: 100, location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } }, metadata: { curio: { type: 'landmark' } } }]);
  const shared = await SharedSpatialSession.open({ databasePath, worldId: WORLD });
  try {
    const input = {
      legacyStore: shared.session.legacyStoreSummary,
      ledger: shared.session.ledger,
      dataDir: dir, databasePath, worldId: WORLD, worldMemoryPath: join(dir, 'world-memory.json'), legacyFactsMigrationVersion: 0,
    };
    assert.equal(input.legacyStore.nodes, 1);
    assert.equal(checkMigrationGate(input).reason, 'facts_migration_required');
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    shared.session.facts.upsertResource({ id: 'new', worldId: WORLD, dim: DIM, label: 'iron_ore', sourceCell: { x: 1, y: 64, z: 0 }, observedAt: 200, source: { source: 'vision' }, revoked: false });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 1);
    shared.session.facts.revokeResource('new', { observedAt: 300, source: { source: 'vision' } });
    assert.equal(shared.query({ kind: 'resourceAnchors' }).total, 0);
    assert.equal(checkMigrationGate({ ...input, legacyFactsMigrationVersion: 1 }).ok, true);
    assert.equal(rawRows(databasePath).nodes.length, 1, '新事实查询不删除旧行');
  } finally { await shared.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed traversal edges skip unlabeled agent place endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-route-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    const edge = walkEdge('route:a', 'route:b', { x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 });
    // A stale confirmed snapshot first must not hide the later valid one.
    edge.refs.unshift({
      evidenceId: 'snap:stale',
      snapshot: { ...edge.refs[0]!.snapshot, id: 'snap:stale', from: { x: 99, y: 64, z: 99 } },
    });
    await seedLegacyRows(databasePath, [
      exactNode('route:a', 1, 64, 1),
      exactNode('route:b', 2, 64, 2),
    ], [edge]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(dry.executed, false);
    assert.equal(dry.report.skippedRoute, 2);
    assert.deepEqual([...dry.report.skippedRouteIds].sort(), ['route:a', 'route:b']);
    assert.equal(dry.report.unknown, 0);
    assert.equal(dry.gaps.filter(gap => gap.reason === 'route_geometry').length, 2);
    assert.deepEqual(dry.archived, []);
    const result = await cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite') });
    assert.equal(result.executed, true);
    const current = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      assert.equal(current.facts.places().total, 0);
    } finally { await current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('region locations with a matching flat pos are not route endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-region-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    const region = (id: string, x: number, z: number) => exactNode(id, x, 64, z, {
      location: { kind: 'region', center: { x, y: 64, z }, radius: 2 },
      pos: { x, y: 64, z },
    });
    await seedLegacyRows(databasePath, [
      region('route:region:a', 3, 3),
      region('route:region:b', 4, 4),
    ], [walkEdge('route:region:a', 'route:region:b', { x: 3, y: 64, z: 3 }, { x: 4, y: 64, z: 4 })]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(dry.report.skippedRoute, 0);
    assert.equal(dry.report.unknown, 2);
    assert.equal(dry.gaps.some(gap => gap.reason === 'route_geometry'), false);
    await assert.rejects(
      cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite') }),
      /unresolved facts/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed legacy node payload refuses before backups or destination writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-corrupt-node-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [exactNode('base:home', 0, 64, 0, { label: 'home', tag: 'base' })]);
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare('INSERT INTO spatial_nodes(world_id, seq, id, payload) VALUES (?, ?, ?, ?)')
        .run(WORLD, 2, 'corrupt:node', 'null');
    } finally { db.close(); }
    const backupPath = join(dir, 'backup.sqlite');
    await assert.rejects(
      cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath }),
      /malformed non-object payload in spatial_nodes row corrupt:node/,
    );
    assert.equal(existsSync(backupPath), false);
    assert.equal(rawRows(databasePath).nodes.length, 2);
    const current = await openSpatialSession({ databasePath, worldId: WORLD });
    try { assert.equal(current.facts.places().total, 0); } finally { await current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('walk-prefixed ids without matching traversal evidence stay unknown and refuse execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-prefix-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [
      exactNode('walk:the_nether:-14,52,-96', -14, 52, -96),
      exactNode('walk:the_nether:-15,52,-97', -15, 52, -97),
    ]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(dry.report.skippedRoute, 0);
    assert.equal(dry.report.unknown, 2);
    assert.equal(dry.gaps.some(gap => gap.reason === 'route_geometry'), false);
    await assert.rejects(
      cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite') }),
      /unresolved facts/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('labels and nonempty semantic metadata are never discarded by the route test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-semantic-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [
      exactNode('route:turn', 6, 64, 6),
      exactNode('base:home', 5, 64, 5, { label: 'home base' }),
      exactNode('route:meta', 7, 64, 7, { metadata: { curio: { type: 'landmark' } } }),
    ], [
      walkEdge('route:turn', 'base:home', { x: 6, y: 64, z: 6 }, { x: 5, y: 64, z: 5 }),
      walkEdge('route:meta', 'base:home', { x: 7, y: 64, z: 7 }, { x: 5, y: 64, z: 5 }),
    ]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.deepEqual(dry.report.skippedRouteIds, ['route:turn']);
    assert.equal(dry.report.migrated, 1);
    assert.equal(dry.report.unknown, 1);
    assert.deepEqual(dry.report.migratedIds, ['base:home']);
    assert.equal(dry.report.unknownIds.includes('route:meta'), true);
    assert.equal(dry.report.unknownIds.includes('base:home'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('route inference rejects wrong source, snapshot scope and endpoint coordinates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-mismatch-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    const cases: { edge?: Record<string, unknown>; snapshot?: Record<string, unknown> }[] = [
      { edge: { source: 'program' } },
      { edge: { basis: 'observed' } },
      { snapshot: { source: 'walk' } },
      { snapshot: { worldId: 'other-world' } },
      { snapshot: { dim: 'the_nether' } },
      { snapshot: { from: { x: 100, y: 64, z: 0 } } },
      { snapshot: { to: { x: 100, y: 64, z: 1 } } },
      { edge: { to: 'missing:node' } },
    ];
    const nodes = cases.flatMap((_, index) => [
      exactNode(`case${index}:from`, index, 64, 0),
      exactNode(`case${index}:to`, index, 64, 1),
    ]);
    const edges = cases.map((entry, index) => walkEdge(
      `case${index}:from`,
      entry.edge?.to === undefined ? `case${index}:to` : String(entry.edge.to),
      { x: index, y: 64, z: 0 },
      { x: index, y: 64, z: 1 },
      entry,
    ));
    await seedLegacyRows(databasePath, nodes, edges);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(dry.report.skippedRoute, 0);
    assert.equal(dry.report.unknown, nodes.length);
    assert.equal(dry.gaps.some(gap => gap.reason === 'route_geometry'), false);
    await assert.rejects(
      cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite') }),
      /unresolved facts/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reviewed archive returns the original raw node and leaves source rows unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-archive-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    const quarry = exactNode('quarry', 9, 64, 9, {
      extra: { nested: [1, 2, 3], note: 'keep me' },
      sessionId: 'session_quarry',
    });
    await seedLegacyRows(databasePath, [
      quarry,
      exactNode('base:home', 5, 64, 5, { label: 'home', tag: 'base' }),
      exactNode('route:a', 1, 64, 1),
      exactNode('route:b', 2, 64, 2),
    ], [walkEdge('route:a', 'route:b', { x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 })]);
    const before = rawRows(databasePath);
    const archiveNodes = [{ id: 'quarry', reason: 'agent reviewed: topology only, no semantic content' }];
    const dry = await cutoverFacts({ databasePath, worldId: WORLD, archiveNodes });
    assert.equal(dry.executed, false);
    assert.equal(dry.report.unknown, 0);
    assert.equal(dry.report.migrated, 1);
    assert.equal(dry.report.skippedRoute, 2);
    assert.deepEqual(dry.archived, [{ id: 'quarry', reason: archiveNodes[0]!.reason, node: quarry }]);
    const result = await cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup.sqlite'), archiveNodes });
    assert.equal(result.executed, true);
    assert.deepEqual(result.archived, dry.archived);
    assert.deepEqual(rawRows(databasePath), before, '归档只影响计划，不改原始 SQLite 行');
    const current = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      assert.deepEqual(current.facts.places().items.map(fact => fact.id), ['base:home']);
    } finally { await current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown nodes outside the reviewed archive still block execute before backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-blocked-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [exactNode('archive:me', 1, 64, 1), exactNode('keep:unknown', 2, 64, 2)]);
    const dry = await cutoverFacts({ databasePath, worldId: WORLD, archiveNodes: [{ id: 'archive:me', reason: 'reviewed' }] });
    assert.equal(dry.report.unknown, 1);
    assert.deepEqual(dry.report.unknownIds, ['keep:unknown']);
    assert.equal(dry.archived.length, 1);
    const backupPath = join(dir, 'backup.sqlite');
    await assert.rejects(
      cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath, archiveNodes: [{ id: 'archive:me', reason: 'reviewed' }] }),
      /unresolved facts/,
    );
    assert.equal(existsSync(backupPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid archive entries are refused before execution and backups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-archive-invalid-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [exactNode('present', 1, 64, 1)]);
    const backupPath = join(dir, 'backup.sqlite');
    const base = { databasePath, worldId: WORLD };
    await assert.rejects(
      cutoverFacts({ ...base, archiveNodes: { id: 'present', reason: 'x' } as unknown as { id: string; reason: string }[] }),
      /must be an array/,
    );
    await assert.rejects(cutoverFacts({ ...base, archiveNodes: [{ id: '', reason: 'x' }] }), /id must be nonempty/);
    await assert.rejects(cutoverFacts({ ...base, archiveNodes: [{ id: 'present', reason: '   ' }] }), /reason must be nonempty/);
    await assert.rejects(
      cutoverFacts({ ...base, archiveNodes: [null] as unknown as { id: string; reason: string }[] }),
      /archive entries/,
    );
    await assert.rejects(
      cutoverFacts({ ...base, archiveNodes: [{ id: 'present', reason: 'a' }, { id: 'present', reason: 'b' }] }),
      /duplicate id/,
    );
    await assert.rejects(
      cutoverFacts({ ...base, execute: true, backupPath, archiveNodes: [{ id: 'missing', reason: 'x' }] }),
      /not a source legacy node/,
    );
    assert.equal(existsSync(backupPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('successful execute is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-facts-idempotent-'));
  const databasePath = join(dir, 'spatial.sqlite');
  try {
    await seedLegacyRows(databasePath, [exactNode('base:home', 0, 64, 0, { label: 'home', tag: 'base' })]);
    const first = await cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup-1.sqlite') });
    assert.equal(first.executed, true);
    assert.equal(first.applied.inserted, 1);
    assert.equal(first.applied.duplicate, 0);
    const repeatDry = await cutoverFacts({ databasePath, worldId: WORLD });
    assert.equal(repeatDry.report.migrated, 0);
    assert.equal(repeatDry.report.duplicates, 1);
    assert.equal(repeatDry.report.conflicts, 0);
    assert.equal(repeatDry.report.unknown, 0);
    const second = await cutoverFacts({ databasePath, worldId: WORLD, execute: true, backupPath: join(dir, 'backup-2.sqlite') });
    assert.equal(second.executed, true);
    assert.equal(second.applied.inserted, 0);
    assert.equal(second.applied.duplicate, 1);
    const current = await openSpatialSession({ databasePath, worldId: WORLD });
    try {
      assert.equal(current.legacyFactsMigrationVersion, 1);
      assert.equal(current.facts.places().total, 1);
    } finally { await current.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
