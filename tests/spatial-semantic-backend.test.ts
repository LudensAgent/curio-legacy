import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { memoryFrom, semanticMemory } from './semantic-fixture.ts';

const W = 'world-1';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

test('WorldMemory 从 library fragments/nodes/ledger 读写语义记录', () => {
  const firstRun = semanticMemory(W);
  const { memory: first, stores, containers } = firstRun;
  first.savePassage({
    id: 'psg_1', worldId: W, dim: D, kind: 'dug', entrances: [at(1, 64, 0)],
    path: [at(1, 64, 0), at(2, 63, 0), at(3, 62, 0)], links: [{ a: at(1, 64, 0), b: at(2, 63, 0) }],
    deepestY: 62, dug: 2, ores: { iron_ore: 1 }, createdAt: 10, lastUsedAt: 20, uses: 3,
  });
  first.addLandmark('resource', 'iron_ore', D, at(8, 40, 8));
  first.setBase(D, at(0, 64, 0), '主基地', { select: true });
  first.setChest(D, at(4, 64, 4), [{ name: 'dirt', count: 12 }]);
  first.setFurnace({ dim: D, pos: at(5, 64, 5), block: 'furnace', input: { name: 'iron_ore', count: 2 }, output: null, fuel: { name: 'coal', count: 1 }, burning: true });
  first.addFarm({ id: 'farm_1', dim: D, crop: 'wheat', cells: [at(10, 64, 10), at(11, 64, 10)], plantedAt: 30, harvests: 2 });
  first.addHazard({ dim: D, pos: at(7, 30, 7), kind: 'lava', note: 'test' });
  first.markGone('iron_ore', D, at(9, 40, 9), 'stone');
  first.putPlaced(at(6, 64, 6), 'torch');
  first.visit(D, at(16, 64, 16));

  const fragment = stores.history.getFragment('psg_1');
  assert.equal((fragment?.metadata?.curio as { dug?: number } | undefined)?.dug, 2);
  assert.equal((fragment?.metadata?.curio as { type?: string } | undefined)?.type, 'passage');
  const landmarkNode = stores.topology.nodes({ limit: 100 }).items.find((node) => node.id === first.landmarks().find((landmark) => landmark.kind === 'resource')!.id);
  assert.equal((landmarkNode?.metadata?.curio as { type?: string } | undefined)?.type, 'landmark');
  assert.equal(stores.ledger.placedBlocks()[0]?.name, 'torch');
  assert.equal(stores.ledger.chunkVisitCount(D, 1, 1), 1);

  const second = memoryFrom(stores, containers, W).memory;
  assert.equal(second.passages(D).length, 1);
  assert.equal(second.passages(D)[0]?.ores.iron_ore, 1);
  assert.equal(second.landmarks().find((landmark) => landmark.kind === 'resource')?.label, 'iron_ore');
  assert.equal(second.base(D)?.label, '主基地');
  assert.equal(second.chests(D)[0]?.contents?.items.find((item) => item.name === 'dirt')?.count, 12);
  assert.equal(second.furnaces(D)[0]?.burning, true);
  assert.equal(second.farms()[0]?.crop, 'wheat');
  assert.equal(second.hazards(D)[0]?.kind, 'lava');
  assert.equal(second.goneNear(D, at(9, 40, 9), 1)[0]?.label, 'iron_ore');
  assert.equal(second.getPlaced(at(6, 64, 6)), 'torch');
  assert.equal(second.chunkVisits(D, 16, 16), 1);
  assert.throws(() => second.setWorld('other-world'), /空间会话绑定|bound to world/);
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

test('visitedExtent 报本维度区块外框和记录路径四向最远脚点，别的维度与非亲历几何不算', () => {
  const { memory, stores } = semanticMemory(W);
  memory.visit(D, at(0, 64, 0));
  memory.visit(D, at(40, 64, -400));
  memory.visit('the_nether', at(900, 64, 900));
  const fragment = (id: string, dim: string, polyline: { x: number; y: number; z: number }[], lastUsedAt: number, geometrySource: 'traversal' | 'legacy' = 'traversal') =>
    stores.history.saveFragment({ id, worldId: W, dim, kind: 'walked', entrances: [], polyline, geometrySource, deepestY: 0, createdAt: lastUsedAt, lastUsedAt, uses: 1 });
  fragment('near', D, [at(0.4, 64, 0.6), at(-5, 64, 3)], 10);
  fragment('far', D, [at(7.2, 44, -420.3), at(30, 44, -380)], 20);
  fragment('other', 'the_nether', [at(900, 64, 900)], 30);
  fragment('legacy', D, [at(5000, 64, 0)], 40, 'legacy');

  const extent = memory.visitedExtent(D);
  assert.equal(extent.chunks, 2);
  assert.deepEqual(extent.bounds, { minX: 0, maxX: 47, minZ: -400, maxZ: 15 });
  assert.deepEqual(extent.farthest?.N, { pos: at(7, 44, -420), at: 20 });
  assert.deepEqual(extent.farthest?.S.pos, at(-5, 64, 3));
  assert.deepEqual(extent.farthest?.E.pos, at(30, 44, -380), '非亲历的 legacy 几何不算走过');
  assert.deepEqual(extent.farthest?.W.pos, at(-5, 64, 3));
  assert.deepEqual(memory.visitedExtent('the_end'), { chunks: 0, bounds: null, farthest: null });
});
