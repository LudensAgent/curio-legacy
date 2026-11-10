import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { memoryFrom, semanticMemory } from './semantic-fixture.ts';

const W = 'world-1';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

test('WorldMemory 从 fact port/ledger 读写语义记录', () => {
  const firstRun = semanticMemory(W);
  const { memory: first, stores, containers } = firstRun;
  first.addLandmark('resource', 'iron_ore', D, at(8, 40, 8));
  first.setBase(D, at(0, 64, 0), '主基地', { select: true });
  first.setChest(D, at(4, 64, 4), [{ name: 'dirt', count: 12 }]);
  first.setFurnace({ dim: D, pos: at(5, 64, 5), block: 'furnace', input: { name: 'iron_ore', count: 2 }, output: null, fuel: { name: 'coal', count: 1 }, burning: true });
  first.addFarm({ id: 'farm_1', dim: D, crop: 'wheat', cells: [at(10, 64, 10), at(11, 64, 10)], plantedAt: 30, harvests: 2 });
  first.addHazard({ dim: D, pos: at(7, 30, 7), kind: 'lava', note: 'test' });
  first.markGone('iron_ore', D, at(9, 40, 9), 'stone');
  first.putPlaced(at(6, 64, 6), 'torch');
  first.visit(D, at(16, 64, 16));

  const resourceId = first.landmarks().find((landmark) => landmark.kind === 'resource')!.id;
  const resourceFact = stores.facts.resources({ worldId: W, includeGone: true }).items.find((fact) => fact.id === resourceId);
  assert.equal(resourceFact?.label, 'iron_ore');
  assert.equal(stores.ledger.placedBlocks()[0]?.name, 'torch');
  assert.equal(stores.ledger.chunkVisitCount(D, 1, 1), 1);

  const second = memoryFrom(stores, containers, W).memory;
  assert.equal(second.landmarks().find((landmark) => landmark.kind === 'resource')?.label, 'iron_ore');
  assert.equal(second.base(D)?.label, '主基地');
  assert.equal(second.chests(D)[0]?.contents?.items.find((item) => item.name === 'dirt')?.count, 12);
  assert.equal(second.furnaces(D)[0]?.burning, true);
  assert.equal(second.farms()[0]?.crop, 'wheat');
  assert.deepEqual(second.farms()[0]?.cells, [at(10, 64, 10), at(11, 64, 10)]);
  assert.equal(second.farms()[0]?.harvests, 2);
  assert.equal(second.farms()[0]?.plantedAt, 30);
  assert.equal(second.hazards(D)[0]?.kind, 'lava');
  assert.equal(second.goneNear(D, at(9, 40, 9), 1)[0]?.label, 'iron_ore');
  assert.equal(second.getPlaced(at(6, 64, 6)), 'torch');
  assert.equal(second.chunkVisits(D, 16, 16), 1);
  assert.throws(() => second.setWorld('other-world'), /空间会话绑定|bound to world/);
});

test('removed resource is revoked from the default anchor view but kept in history', () => {
  const { memory, stores } = semanticMemory(W);
  const pos = at(8, 40, 8);
  memory.addLandmark('resource', 'iron_ore', D, pos);
  memory.markGone('iron_ore', D, pos, 'stone');

  assert.equal(memory.landmarks().some((landmark) => landmark.label === 'iron_ore'), false);
  assert.equal(stores.facts.resources({ worldId: W }).items.length, 0);
  assert.equal(stores.facts.resources({ worldId: W, includeGone: true }).items.length, 1, 'history keeps the revoked anchor');
  assert.equal(stores.facts.resources({ worldId: W, includeGone: true }).items[0]?.revoked, true);
});

test('semantic records are written to the fact port, not topology nodes', () => {
  const { memory, stores } = semanticMemory(W);
  memory.addLandmark('resource', 'iron_ore', D, at(1, 64, 1), 0);
  memory.setBase(D, at(0, 64, 0), 'home');
  memory.setChest(D, at(2, 64, 2), [{ name: 'dirt', count: 1 }]);
  memory.setFurnace({ dim: D, pos: at(3, 64, 3), block: 'furnace', input: { name: 'iron_ore', count: 1 }, output: null, fuel: null, burning: true });
  memory.addFarm({ id: 'farm_1', dim: D, crop: 'wheat', cells: [at(4, 64, 4), at(5, 64, 4)], plantedAt: 123, harvests: 2 });
  memory.addHazard({ dim: D, pos: at(6, 64, 6), kind: 'lava', note: 'x' });
  memory.markGone('iron_ore', D, at(1, 64, 1), 'air');

  const places = stores.facts.places({ worldId: W, includeGone: true }).items;
  const resources = stores.facts.resources({ worldId: W, includeGone: true }).items;
  const containers = stores.facts.containers({ worldId: W, includeGone: true }).items;

  const base = places.find((fact) => fact.kind === 'base');
  assert.equal(base?.label, 'home');
  const farm = places.find((fact) => fact.id === 'farm_1');
  assert.equal(farm?.kind, 'station');
  assert.equal(farm?.label, 'farm: wheat');
  assert.equal(farm?.location.kind, 'area', 'multi-cell farm stays an area');
  assert.equal(places.find((fact) => fact.kind === 'hazard')?.location.kind, 'area');
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.label, 'iron_ore');
  assert.equal(resources[0]?.revoked, true);
  assert.equal(containers.length, 2);
  for (const anchor of containers) {
    assert.equal(anchor.ledgerRef, `${W}:${D}:${anchor.pos.x},${anchor.pos.y},${anchor.pos.z}`);
  }
  assert.equal('topology' in stores, false, 'semantic composition no longer carries legacy topology');
  assert.equal('history' in stores, false, 'semantic composition no longer carries legacy fragment history');
});

test('WorldMemory JSON keeps only non-spatial facts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-semantic-'));
  const file = path.join(dir, 'world-memory.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { memory, stores, containers } = semanticMemory(W, file);
  memory.addLandmark('waypoint', '测试点', D, at(3, 64, 3));
  memory.setChest(D, at(4, 64, 4), [{ name: 'stone', count: 2 }]);
  memory.putPlaced(at(5, 64, 5), 'torch');
  memory.flush();
  memory.close();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of ['landmarks', 'chests', 'passages', 'furnaces', 'farms', 'hazards', 'gone', 'visitedChunks']) {
    assert.equal(key in disk, false, `${key} must not be written to world-memory.json`);
  }
  assert.equal(memoryFrom(stores, containers, W).memory.landmarks()[0]?.label, '测试点');
  assert.equal(memoryFrom(stores, containers, W).memory.chests(D)[0]?.contents?.items[0]?.count, 2);
  assert.equal(memoryFrom(stores, containers, W).memory.getPlaced(at(5, 64, 5)), 'torch');
});

test('visitedExtent 报本维度区块外框，别的维度不算，且不再返回记录路径四向最远脚点', () => {
  const { memory } = semanticMemory(W);
  memory.visit(D, at(0, 64, 0));
  memory.visit(D, at(40, 64, -400));
  memory.visit('the_nether', at(900, 64, 900));

  const extent = memory.visitedExtent(D);
  assert.equal(extent.chunks, 2);
  assert.deepEqual(extent.bounds, { minX: 0, maxX: 47, minZ: -400, maxZ: 15 });
  assert.equal(Object.hasOwn(extent, 'farthest'), false, 'fragment 路线读面已退役');
  assert.deepEqual(memory.visitedExtent('the_end'), { chunks: 0, bounds: null });
});

test('farm updates preserve planting evidence and persist business changes across reconstruction', () => {
  const { memory, stores, containers } = semanticMemory(W);
  const cells = [at(10, 64, 10), at(11, 64, 10)];
  memory.addFarm({ id: 'field', dim: D, crop: 'wheat', cells, plantedAt: 123, harvests: 2 });
  const before = stores.facts.places({ worldId: W }).items.find((fact) => fact.id === 'field')!;
  memory.updateFarm('field', { harvests: 3 });
  const after = stores.facts.places({ worldId: W }).items.find((fact) => fact.id === 'field')!;
  assert.equal(after.observedAt, before.observedAt, 'a counter update is not a new terrain observation');
  const reopened = memoryFrom(stores, containers, W).memory;
  assert.deepEqual(reopened.farms()[0]?.cells, cells);
  assert.equal(reopened.farms()[0]?.harvests, 3);
  assert.equal(reopened.farms()[0]?.plantedAt, 123);
});
