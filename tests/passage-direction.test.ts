import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Vec3Like } from '../src/adapter/types.ts';
import { PassageTracker, passageDeepestAnchor, passageRoute } from '../src/memory/passages.ts';
import { SpatialMemoryBackend } from '../src/memory/spatial-backend.ts';
import { WorldMemory } from '../src/memory/store.ts';

const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const rec = (links: { a: Vec3Like; b: Vec3Like; cut?: boolean; reverse?: boolean }[], path: Vec3Like[] = []) => ({ path, links });

test('落差 link 单向：记录顺序 a 上 b 下可走，反向爬不可走', () => {
  // 记录里从 y59 掉到 y57：只证明 a→b 能过，不能反推 b→a 能爬
  const drop = rec([{ a: at(0, 59, 0), b: at(1, 57, 0) }]);
  assert.deepEqual(passageRoute([drop], at(0, 59, 0), at(1, 57, 0), { near: 0.5 })?.map((p) => `${p.x},${p.y},${p.z}`), ['0,59,0', '1,57,0']);
  assert.equal(passageRoute([drop], at(1, 57, 0), at(0, 59, 0), { near: 0.5 }), null, '反向向上 2 格没有证据');
});

test('观察到的向上爬 link（a 下 b 上、差 2+）双向可走', () => {
  // 记录顺序是从 y57 爬到 y59：向上是已观察到的爬升，向下是落差
  const climb = rec([{ a: at(0, 57, 0), b: at(1, 59, 0) }]);
  assert.deepEqual(passageRoute([climb], at(0, 57, 0), at(1, 59, 0), { near: 0.5 })?.at(-1), at(1, 59, 0), '向上走');
  assert.deepEqual(passageRoute([climb], at(1, 59, 0), at(0, 57, 0), { near: 0.5 })?.at(-1), at(0, 57, 0), '反向下降也可走');
});

test('reverse 标记（后来反向走过同一对格子）保持双向', () => {
  const marked = rec([{ a: at(0, 59, 0), b: at(1, 57, 0), reverse: true }]);
  assert.deepEqual(passageRoute([marked], at(1, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), '双向都有亲脚证据');
});

test('cut / 方向不确定的 link 保持双向', () => {
  const cut = rec([{ a: at(0, 59, 0), b: at(1, 57, 0), cut: true }]);
  assert.deepEqual(passageRoute([cut], at(1, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), 'cut 不猜方向');
});

test('path-only 推断边和跨 record 几何连边保持无向', () => {
  // 旧数据没有 links：U 形稀疏路径（先下 10 格再爬回）仍能双向走
  const u: Vec3Like[] = [at(0, 40, 0), at(0, 34, 0), at(0, 30, 0), at(0, 36, 0), at(0, 42, 0)];
  assert.deepEqual(passageRoute([{ path: u }], at(0, 30, 0), at(0, 42, 0), { near: 0.5 })?.at(-1), at(0, 42, 0), '稀疏路径仍能回程');
  assert.deepEqual(passageRoute([{ path: u }], at(0, 42, 0), at(0, 30, 0), { near: 0.5 })?.at(-1), at(0, 30, 0), '反向下行也可走');
  // 两条 record 之间只有几何连边（差 2 格）：没有方向证据，保持双向
  const low = { path: [at(0, 40, 0)] };
  const high = { path: [at(0, 42, 0)] };
  assert.deepEqual(passageRoute([low, high], at(0, 40, 0), at(0, 42, 0), { near: 0.5 })?.at(-1), at(0, 42, 0));
  assert.deepEqual(passageRoute([low, high], at(0, 42, 0), at(0, 40, 0), { near: 0.5 })?.at(-1), at(0, 40, 0));
});

test('passageDeepestAnchor 不跨过反向禁行边去找够不着的更深处', () => {
  // (0,60) 掉到 (0,56)；(0,60) 横到 (4,60)，再掉到 (4,40)。站在落差下方只能停在 y56。
  const mine = rec([
    { a: at(0, 60, 0), b: at(0, 56, 0) },
    { a: at(0, 60, 0), b: at(4, 60, 0) },
    { a: at(4, 60, 0), b: at(4, 40, 0) },
  ], [at(0, 56, 0), at(4, 40, 0)]);
  assert.deepEqual(passageDeepestAnchor([mine], at(0, 56, 0)), at(0, 56, 0), '落差下方不能反向爬回 y60 再找 y40');
  assert.deepEqual(passageDeepestAnchor([mine], at(0, 60, 0)), at(4, 40, 0), '从上方可以顺落差下到最深处');
  assert.deepEqual(passageDeepestAnchor([mine]), at(4, 40, 0), '不带 here 时仍取全网最深');
});

test('记录器：同一对格子后来反向走过时给 link 标 reverse', () => {
  const m = new WorldMemory(null); m.setWorld('w');
  const tr = new PassageTracker(m, () => 'p1');
  let t = 0;
  tr.observe({ worldId: 'w', dim: 'overworld', pos: at(0, 64, 0), place: 'surface' }, [], t);
  const dug = [at(0, 63, 0), at(0, 64, 0), at(1, 62, 0), at(0, 62, 1)].map((pos) => ({ pos, name: 'stone', ts: 1 }));
  tr.observe({ worldId: 'w', dim: 'overworld', pos: at(0, 62, 0), place: 'underground' }, dug, t += 1000);
  tr.observe({ worldId: 'w', dim: 'overworld', pos: at(0, 60, 0), place: 'underground' }, [], t += 1000);
  tr.observe({ worldId: 'w', dim: 'overworld', pos: at(0, 62, 0), place: 'underground' }, [], t += 1000);
  const [p] = m.passages('overworld');
  assert.equal(p!.links?.length, 1, '相反对仍然去重成一条 link');
  assert.equal(p!.links![0]!.reverse, true, '后来反向走过要标 reverse');
  assert.ok(passageRoute([p!], at(0, 60, 0), at(0, 62, 0), { near: 0.5 }), '有反向证据后向上可走');
  m.close();
});

test('空间后端 save→reload 后 reverse/cut 仍在，路由结果一致', () => {
  const W = 'world-dir', D = 'overworld';
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);
  const first = new WorldMemory(null);
  first.setWorld(W);
  first.attachSpatial(backend, { allowEmptyStore: true });
  first.savePassage({
    id: 'p1', worldId: W, dim: D, kind: 'dug', entrances: [], path: [], deepestY: 57, dug: 0, ores: {},
    createdAt: 0, lastUsedAt: 0, uses: 1,
    links: [
      { a: at(0, 59, 0), b: at(1, 57, 0), cut: true },
      { a: at(1, 57, 0), b: at(2, 59, 0), reverse: true },
    ],
  });
  const second = new WorldMemory(null);
  second.setWorld(W);
  second.attachSpatial(backend);
  const [p] = second.passages(D);
  assert.equal(p?.links?.[0]?.cut, true, 'cut 持久化');
  assert.equal(p?.links?.[1]?.reverse, true, 'reverse 持久化');
  assert.deepEqual(passageRoute([p!], at(1, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), '重启后 cut link 仍双向');
  assert.deepEqual(passageRoute([p!], at(1, 57, 0), at(2, 59, 0), { near: 0.5 })?.at(-1), at(2, 59, 0), '重启后 reverse link 仍双向');
  first.close();
  second.close();
});
