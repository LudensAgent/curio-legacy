import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PASSAGE_BRIDGE_ARCHIVE_CAP, PASSAGE_LIVE_CAP, WorldMemory } from '../src/memory/store.ts';

const W = 'archive-world', D = 'overworld';
const record = (id: string, x: number, lastUsedAt: number) => ({
  id, worldId: W, dim: D, kind: 'dug' as const, entrances: [{ x, y: 64, z: 0 }],
  path: [{ x, y: 64, z: 0 }, { x: x + 1, y: 64, z: 0 }], deepestY: 64, dug: 8,
  ores: {}, createdAt: 1, lastUsedAt, uses: 1,
});

test('live cap moves the oldest passage into the archive instead of dropping it', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  for (let i = 1; i <= PASSAGE_LIVE_CAP + 1; i++) memory.savePassage(record(`p${i}`, i * 4, i));

  assert.equal(memory.passages(D).length, PASSAGE_LIVE_CAP);
  assert.deepEqual(memory.archivedPassages(D).map((p) => p.id), ['p1']);
  assert.equal(typeof memory.archivedPassages(D)[0].archivedAt, 'number');
  assert.equal(memory.allPassages(D).length, PASSAGE_LIVE_CAP + 1);
  assert.equal(memory.passages(D).some((p) => p.id === 'p1'), false);
});

test('live eviction keeps a long/deep dug mine over bridges and short stubs', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  const deep = {
    ...record('deep-mine', 8, 1),
    path: Array.from({ length: 30 }, (_, i) => ({ x: 8 + i, y: 50 - i, z: 0 })),
    deepestY: 21,
  };
  memory.savePassage(deep);
  for (let i = 0; i < PASSAGE_LIVE_CAP; i++) memory.savePassage({ ...record(`bridge-${i}`, i * 2, 100 + i), kind: 'bridge' as const });

  assert.equal(memory.passages(D).length, PASSAGE_LIVE_CAP);
  assert.equal(memory.passages(D).some((p) => p.id === 'deep-mine'), true, '主矿道不能被桥挤进归档');
  assert.equal(memory.passages(D).some((p) => p.id === `bridge-${PASSAGE_LIVE_CAP - 1}`), true, '刚保存的记录不能被自己挤掉');
  assert.ok(memory.archivedPassages(D).some((p) => p.kind === 'bridge'), '先淘汰 bridge');

  // 再用短 stub 填满：主矿道仍在，淘汰的是 stub
  const memory2 = new WorldMemory(null);
  memory2.setWorld(W);
  memory2.savePassage(deep);
  for (let i = 0; i < PASSAGE_LIVE_CAP; i++) memory2.savePassage(record(`stub-${i}`, 100 + i * 4, 100 + i));
  assert.equal(memory2.passages(D).some((p) => p.id === 'deep-mine'), true, '主矿道不能被短 stub 挤进归档');
  assert.equal(memory2.passages(D).some((p) => p.id === `stub-${PASSAGE_LIVE_CAP - 1}`), true);
  assert.ok(memory2.archivedPassages(D).some((p) => p.id.startsWith('stub-')), '淘汰短 stub');
});

test('re-saving an archived record restores it to live and does not duplicate it in allPassages', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  for (let i = 1; i <= PASSAGE_LIVE_CAP + 1; i++) memory.savePassage(record(`p${i}`, i * 4, i));
  memory.savePassage(record('p1', 4, 999));

  assert.equal(memory.passages(D).some((p) => p.id === 'p1'), true);
  assert.equal(memory.archivedPassages(D).some((p) => p.id === 'p1'), false);
  assert.equal(memory.allPassages(D).filter((p) => p.id === 'p1').length, 1);
  assert.equal(memory.archivedPassages(D).some((p) => p.id === 'p2'), true, 'the next oldest moves to the archive');
});

test('explicit forget removes the record from both live and archive', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  for (let i = 1; i <= PASSAGE_LIVE_CAP + 1; i++) memory.savePassage(record(`p${i}`, i * 4, i));
  memory.forgetPassage('p1');
  assert.equal(memory.archivedPassages(D).some((p) => p.id === 'p1'), false);
  assert.equal(memory.allPassages(D).some((p) => p.id === 'p1'), false);
});

test('bridge archive churn cannot evict a walked/dig mine record', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  memory.archivePassage(record('mine', 8, 1));
  for (let i = 0; i < PASSAGE_BRIDGE_ARCHIVE_CAP + 40; i++) {
    memory.archivePassage({ ...record(`bridge-${i}`, i * 2, 100 + i), kind: 'bridge' });
  }
  const archived = memory.archivedPassages(D);
  assert.equal(archived.some((p) => p.id === 'mine'), true);
  assert.ok(archived.filter((p) => p.kind === 'bridge').length <= PASSAGE_BRIDGE_ARCHIVE_CAP);
});

test('archived passages stay scoped to their world and dimension', () => {
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  memory.archivePassage(record('mine', 8, 1));
  memory.archivePassage({ ...record('nether', 8, 2), worldId: 'other-world', dim: D });
  assert.deepEqual(memory.archivedPassages(D).map((p) => p.id), ['mine']);
  assert.deepEqual(memory.archivedPassages('the_nether'), []);
});

test('memory-patch archivePassages applies once at load and reports it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passage-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'world-memory.json');
  fs.writeFileSync(file, JSON.stringify({ version: 4, worldId: W }));
  fs.writeFileSync(path.join(dir, 'memory-patch.json'), JSON.stringify({ archivePassages: [record('old', 12, 1)] }));

  const memory = new WorldMemory(file);
  t.after(() => memory.close());
  assert.deepEqual(memory.archivedPassages(D).map((p) => p.id), ['old']);
  assert.ok(memory.patched.some((line) => /归档 1 条历史通道/.test(line)));
  assert.equal(fs.existsSync(path.join(dir, 'memory-patch.json')), false);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('memory-patch.applied-')));
});
