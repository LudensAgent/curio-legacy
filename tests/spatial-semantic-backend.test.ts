import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import { SpatialMemoryBackend } from '../src/memory/spatial-backend.ts';
import { WorldMemory } from '../src/memory/store.ts';

const W = 'world-1';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

test('WorldMemory 在附着空间后端后从 fragments/nodes/ledger 读写语义记录', () => {
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);

  const first = new WorldMemory(null);
  first.attachSpatial(backend, { allowEmptyStore: true });
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
  first.syncSpatial();

  assert.equal(history.getFragment('psg_1')?.metadata?.curio && (history.getFragment('psg_1')!.metadata!.curio as any).dug, 2);
  const landmarkNode = topology.nodes({ limit: 100 }).items.find((node) => node.id === first.landmarks().find((l) => l.kind === 'resource')!.id);
  assert.equal(landmarkNode?.metadata && (landmarkNode.metadata.curio as any).type, 'landmark');
  assert.equal(ledger.placedBlocks()[0]?.name, 'torch');
  assert.equal(ledger.chunkVisitCount(D, 1, 1), 1);

  const second = new WorldMemory(null);
  second.attachSpatial(backend);
  assert.equal(second.passages(D).length, 1);
  assert.equal(second.passages(D)[0]?.ores.iron_ore, 1);
  assert.equal(second.landmarks().find((l) => l.kind === 'resource')?.label, 'iron_ore');
  assert.equal(second.base(D)?.label, '主基地');
  assert.equal(second.chests(D)[0]?.contents?.items.find((item) => item.name === 'dirt')?.count, 12);
  assert.equal(second.furnaces(D)[0]?.burning, true);
  assert.equal(second.farms()[0]?.crop, 'wheat');
  assert.equal(second.hazards(D)[0]?.kind, 'lava');
  assert.equal(second.goneNear(D, at(9, 40, 9), 1)[0]?.label, 'iron_ore');
  assert.equal(second.getPlaced(at(6, 64, 6)), 'torch');
  assert.equal(second.chunkVisits(D, 16, 16), 1);
  assert.throws(() => second.setWorld('other-world'), /bound to world/);
});

test('attached WorldMemory writes spatial facts only to the spatial store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-semantic-'));
  const file = path.join(dir, 'world-memory.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);
  const memory = new WorldMemory(file);
  memory.attachSpatial(backend, { allowEmptyStore: true });
  memory.addLandmark('waypoint', '测试点', D, at(3, 64, 3));
  memory.setChest(D, at(4, 64, 4), [{ name: 'stone', count: 2 }]);
  memory.putPlaced(at(5, 64, 5), 'torch');
  memory.flush();
  memory.close();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(disk.landmarks, []);
  assert.deepEqual(disk.chests, {});
  assert.deepEqual(disk.passages, []);
  assert.equal(backend.load().landmarks[0]?.label, '测试点');
  assert.equal(backend.load().chests[`${W}:${D}:4,64,4`]?.contents?.items[0]?.count, 2);
  assert.equal(backend.load().placed[0]?.name, 'torch');
});
