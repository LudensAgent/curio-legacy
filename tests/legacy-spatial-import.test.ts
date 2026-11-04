import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';
import { applyPlan, planLegacyImport } from '../scripts/legacy-spatial-import.ts';

const vec = (x: number, y: number, z: number) => ({ x, y, z });

function fixture() {
  return {
    worldMemory: {
      version: 4,
      worldId: 'w',
      passages: [{
        id: 'p1', worldId: 'w', dim: 'overworld', kind: 'dug',
        entrances: [vec(0, 64, 0)], path: [vec(0, 64, 0), vec(1, 64, 0)],
        deepestY: 64, createdAt: 100, lastUsedAt: 200, uses: 3,
        links: [{ a: vec(0, 64, 0), b: vec(1, 64, 0) }], dug: 2, ores: { 'minecraft:coal_ore': 1 },
      }],
      landmarks: [{ id: 'l1', kind: 'base', label: 'home', worldId: 'w', dim: 'overworld', pos: vec(0, 64, 0), ts: 100, primary: true }],
      hazards: [{ id: 'h1', worldId: 'w', dim: 'the_nether', pos: vec(1, 2, 3), radius: 4, kind: 'lava', note: 'lava', ts: 100 }],
      chests: {
        'w:overworld:1,64,1': { worldId: 'w', dim: 'overworld', pos: vec(1, 64, 1), block: 'chest', contents: { items: [] }, uses: 1, ts: 100, day: 1 },
      },
      farms: [{ id: 'f1', worldId: 'w', dim: 'overworld', crop: 'wheat', cells: [vec(0, 64, 0), vec(1, 64, 0)], plantedAt: 1, harvests: 0 }],
      digs: [{ ts: 1 }],
      visitedChunks: { 'w:overworld:0:0': 1 },
      seen: { 'w:stone': 1 },
    },
    travelMemory: {
      version: 1,
      endpoints: [{ id: 'e1', worldId: 'w', dim: 'overworld', pos: vec(0, 64, 0), kind: 'nether_portal', observedAt: 1 }],
      traversals: [{ fromId: 'e1', toId: 'e1', ts: 1 }],
      gateways: [],
    },
    placed: { byPos: { '0,64,0': { name: 'torch', at: 1 } } },
  };
}

test('plans faithful legacy geometry/places and accounts for unsupported data', () => {
  const plan = planLegacyImport({ ...fixture(), sourceFiles: [] });
  assert.equal(plan.worldId, 'w');
  assert.equal(plan.fragments.length, 1);
  assert.equal(plan.nodes.length, 5);
  const fragment = plan.fragments[0]!;
  assert.equal(fragment.id, 'legacy:passage:p1');
  assert.equal(fragment.geometrySource, 'legacy');
  assert.equal(fragment.kind, 'dug');
  assert.deepEqual(fragment.links, [{ a: vec(0, 64, 0), b: vec(1, 64, 0) }]);
  assert.equal(fragment.createdAt, 100);
  assert.equal(fragment.lastUsedAt, 200);
  assert.equal(fragment.uses, 3);
  assert.ok(plan.nodes.some((node) => node.id === 'legacy:landmark:l1' && node.tag === 'base' && node.source === 'agent'));
  assert.ok(plan.nodes.some((node) => node.id === 'legacy:hazard:h1' && node.tag === 'danger' && node.location.kind === 'region'));
  assert.ok(plan.nodes.some((node) => node.id.startsWith('legacy:chest:') && node.tag === 'resource'));
  assert.ok(plan.nodes.some((node) => node.id === 'legacy:farm:f1' && node.location.kind === 'region'));
  assert.ok(plan.nodes.some((node) => node.id === 'legacy:travel-endpoint:e1' && node.tag === 'portal'));
  assert.equal(plan.collections.travelTraversals!.unsupported, 1);
  assert.equal(plan.collections.digs!.unsupported, 1);
  assert.equal(plan.collections.visitedChunks!.unsupported, 1);
  assert.equal(plan.collections.seen!.unsupported, 1);
  assert.equal(plan.collections.placed!.unsupported, 1);
  assert.equal(plan.records.filter((record) => record.status === 'rejected').length, 0);
});

test('rejects malformed or out-of-scope records without producing partial writes', () => {
  const plan = planLegacyImport({
    worldMemory: {
      version: 4, worldId: 'w',
      passages: [
        { id: 'bad-world', worldId: 'other', dim: 'overworld', kind: 'dug', path: [vec(0, 64, 0)], deepestY: 64, createdAt: 1, lastUsedAt: 2, uses: 0 },
        { id: 'bad-path', worldId: 'w', dim: 'overworld', kind: 'dug', path: [null], deepestY: 64, createdAt: 1, lastUsedAt: 2, uses: 0 },
        { id: 'bad-kind', worldId: 'w', dim: 'overworld', kind: 'flight', path: [vec(0, 64, 0)], deepestY: 64, createdAt: 1, lastUsedAt: 2, uses: 0 },
        { id: 'dup', worldId: 'w', dim: 'overworld', kind: 'dug', path: [vec(0, 64, 0)], deepestY: 64, createdAt: 1, lastUsedAt: 2, uses: 0 },
        { id: 'dup', worldId: 'w', dim: 'overworld', kind: 'dug', path: [vec(1, 64, 0)], deepestY: 64, createdAt: 1, lastUsedAt: 2, uses: 0 },
      ],
      landmarks: [{ id: 'l-bad', kind: 'base', worldId: 'w', dim: 'overworld', pos: { x: 'nope' } }],
    },
    sourceFiles: [],
  });
  assert.equal(plan.fragments.length, 1);
  assert.equal(plan.nodes.length, 0);
  const reasons = plan.records.filter((record) => record.status === 'rejected').map((record) => record.reason);
  assert.ok(reasons.includes('world_mismatch'));
  assert.ok(reasons.includes('invalid_or_empty_path'));
  assert.ok(reasons.includes('unknown_passage_kind'));
  assert.ok(reasons.some((reason) => reason?.startsWith('duplicate_new_id')));
  assert.ok(reasons.includes('invalid_pos'));
});

test('applies to a real SQLite history session, is idempotent, and creates no traversal/edge/current evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-import-'));
  const databasePath = join(dir, 'spatial.sqlite');
  const bootstrap = await openHistorySession({ databasePath, worldId: 'w' });
  await bootstrap.checkpoint();
  await bootstrap.close();
  const plan = planLegacyImport({ ...fixture(), sourceFiles: [] });

  const first = await applyPlan(plan, { databasePath, backupPath: join(dir, 'backup-1.sqlite') });
  assert.equal(first.ok, true, first.errors.join('; '));
  assert.equal(first.insertedFragments, 1);
  assert.equal(first.insertedNodes, 5);
  assert.equal(first.checkpoint?.worldId, 'w');
  assert.equal(first.state?.dirty, false);
  assert.equal(first.close?.completed, true);
  assert.equal(first.close?.dirty, false);
  assert.equal(existsSync(join(dir, 'backup-1.sqlite')), true);

  const session = await openHistorySession({ databasePath, worldId: 'w' });
  const fragment = session.history.getFragment('legacy:passage:p1');
  assert.equal(fragment?.geometrySource, 'legacy');
  assert.equal(session.history.fragments({ source: 'legacy', limit: 100 }).total, 1);
  assert.equal(session.topology.nodes({ limit: 1000 }).total, 5);
  assert.equal(session.topology.edges({ limit: 10 }).total, 0);
  assert.equal(session.history.traversals({ limit: 10 }).total, 0);
  await session.close();

  const second = await applyPlan(plan, { databasePath, backupPath: join(dir, 'backup-2.sqlite') });
  assert.equal(second.ok, true, second.errors.join('; '));
  assert.equal(second.insertedFragments, 0);
  assert.equal(second.insertedNodes, 0);
  assert.equal(second.unchangedFragments, 1);
  assert.equal(second.unchangedNodes, 5);
});

test('refuses to overwrite an existing legacy id with different content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-conflict-'));
  const databasePath = join(dir, 'spatial.sqlite');
  const bootstrap = await openHistorySession({ databasePath, worldId: 'w' });
  await bootstrap.checkpoint();
  await bootstrap.close();
  const plan = planLegacyImport({ ...fixture(), sourceFiles: [] });
  const first = await applyPlan(plan, { databasePath, backupPath: join(dir, 'backup-1.sqlite') });
  assert.equal(first.ok, true, first.errors.join('; '));
  const changed = planLegacyImport({
    ...fixture(),
    worldMemory: {
      ...fixture().worldMemory,
      passages: [{ ...fixture().worldMemory.passages[0]!, uses: 99 }],
    },
    sourceFiles: [],
  });
  const second = await applyPlan(changed, { databasePath, backupPath: join(dir, 'backup-2.sqlite') });
  assert.equal(second.ok, false);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.insertedFragments, 0);
  const session = await openHistorySession({ databasePath, worldId: 'w' });
  assert.equal(session.history.getFragment('legacy:passage:p1')?.uses, 3);
  await session.close();
});
