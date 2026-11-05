import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { LedgerStore } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Vec3Like } from '../src/adapter/types.ts';
import { PassageTracker, passageDeepestAnchor, passageGraph, passageRoute, passageSurfaceAnchor } from '../src/memory/passages.ts';
import { SpatialMemoryBackend } from '../src/memory/spatial-backend.ts';
import { WorldMemory } from '../src/memory/store.ts';

const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const rec = (links: { a: Vec3Like; b: Vec3Like; cut?: boolean; reverse?: boolean }[], path: Vec3Like[] = []) => ({ path, links });

test('纯垂直落差 link 单向：记录顺序 a 上 b 下可走，反向爬不可走', () => {
  // 记录里从 (0,59,0) 直落到 (0,57,0)：只证明 a→b 能过，不能反推 b→a 能爬
  const drop = rec([{ a: at(0, 59, 0), b: at(0, 57, 0) }]);
  assert.deepEqual(passageRoute([drop], at(0, 59, 0), at(0, 57, 0), { near: 0.5 })?.map((p) => `${p.x},${p.y},${p.z}`), ['0,59,0', '0,57,0']);
  assert.equal(passageRoute([drop], at(0, 57, 0), at(0, 59, 0), { near: 0.5 }), null, '反向向上 2 格没有证据');
});

test('观察到的向上爬 link（a 下 b 上、差 2+）双向可走', () => {
  // 记录顺序是从 (0,57,0) 爬到 (0,59,0)：向上是已观察到的爬升，向下是落差
  const climb = rec([{ a: at(0, 57, 0), b: at(0, 59, 0) }]);
  assert.deepEqual(passageRoute([climb], at(0, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), '向上走');
  assert.deepEqual(passageRoute([climb], at(0, 59, 0), at(0, 57, 0), { near: 0.5 })?.at(-1), at(0, 57, 0), '反向下降也可走');
});

test('带水平位移的 dy≤-2 link 视为跨了两级台阶，保持双向', () => {
  // 两次观测间向下 2 格、水平 1 格：可能是走下两级 1 格台阶，不是竖井；回程必须可用
  const stairs = rec([{ a: at(4, 59, 0), b: at(5, 57, 0) }]);
  assert.deepEqual(passageRoute([stairs], at(4, 59, 0), at(5, 57, 0), { near: 0.5 })?.at(-1), at(5, 57, 0), '下行');
  assert.deepEqual(passageRoute([stairs], at(5, 57, 0), at(4, 59, 0), { near: 0.5 })?.at(-1), at(4, 59, 0), '回程上台阶');
});

test('reverse 标记（后来反向走过同一对格子）保持双向', () => {
  const marked = rec([{ a: at(0, 59, 0), b: at(0, 57, 0), reverse: true }]);
  assert.deepEqual(passageRoute([marked], at(0, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), '双向都有亲脚证据');
});

test('cut / 方向不确定的 link 保持双向（含纯垂直下坠）', () => {
  // merge/dedupe 拼接边界上的 a/b 顺序不是真实行程顺序，即使看着像竖井也不猜方向
  const cut = rec([{ a: at(0, 59, 0), b: at(0, 57, 0), cut: true }]);
  assert.deepEqual(passageRoute([cut], at(0, 57, 0), at(0, 59, 0), { near: 0.5 })?.at(-1), at(0, 59, 0), 'cut 不猜方向');
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

test('地表锚点兜底只取有向可达的最高点', () => {
  // 高 4 格的端点只能从高往低走；站在低处时兜底不能把不可达的高点当地表锚点
  const mine = { ...rec([{ a: at(0, 60, 0), b: at(0, 56, 0) }], [at(0, 60, 0), at(0, 56, 0)]), entrances: [] as Vec3Like[] };
  const anchor = passageSurfaceAnchor([mine], at(0, 56, 0));
  assert.deepEqual(anchor, at(0, 56, 0), '不选反向禁行边另一端的更高点');
  assert.ok(passageRoute([mine], at(0, 56, 0), anchor!, { near: 0.5 }), '兜底锚点必须自身可达');
  assert.equal(passageSurfaceAnchor([], at(0, 56, 0)), null, '没有节点时返回 null');
});

test('graphCache 的方向签名：原地补 cut/reverse 后必须重建图', () => {
  const links: { a: Vec3Like; b: Vec3Like; cut?: boolean; reverse?: boolean }[] = [{ a: at(0, 60, 0), b: at(0, 56, 0), reverse: true }];
  const recs = [{ path: [] as Vec3Like[], links }];
  const first = passageGraph(recs);
  assert.ok(passageRoute(recs, at(0, 56, 0), at(0, 60, 0), { near: 0.5 }), 'reverse 时双向');
  links[0]!.reverse = false;
  const second = passageGraph(recs);
  assert.notEqual(second, first, 'reverse 减少后重建');
  assert.equal(passageRoute(recs, at(0, 56, 0), at(0, 60, 0), { near: 0.5 }), null, '重建后按单向判');
  links[0]!.cut = true;
  const third = passageGraph(recs);
  assert.notEqual(third, second, 'cut 增加后重建');
  assert.ok(passageRoute(recs, at(0, 56, 0), at(0, 60, 0), { near: 0.5 }), 'cut 恢复双向');
});

test('merge 时 drop 的 reverse 标记不会丢：合并后反向仍可走', () => {
  const m = new WorldMemory(null); m.setWorld('w');
  const base = { worldId: 'w', dim: 'overworld', kind: 'dug' as const, entrances: [], deepestY: 57, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0 };
  const high = at(0, 60, 0), low = at(0, 58, 0);
  m.savePassage({ ...base, id: 'keep', uses: 3, path: [high], links: [{ a: high, b: low }] });
  m.savePassage({ ...base, id: 'drop', uses: 1, path: [low], links: [{ a: high, b: low, reverse: true }] });
  const tr = new PassageTracker(m, () => 'new');
  tr.observe({ worldId: 'w', dim: 'overworld', pos: at(0, 59, 0), place: 'underground' }, [], 1000);
  const ps = m.passages('overworld');
  assert.equal(ps.length, 1, '两条合并成一条');
  const p = ps[0]!;
  assert.equal(p.id, 'keep');
  assert.equal(p.links!.find((l) => l.a.y === 60 && l.b.y === 58)?.reverse, true, 'drop 的 reverse 合进同向 link');
  assert.ok(passageRoute([p], low, high, { near: 0.5 }), '合并后从低处回高处仍可路由');
  m.close();
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
  const stored = history.getFragment('p1')!;
  const linkMeta = (stored.metadata as { curio?: { linkMeta?: { cut?: unknown; reverse?: unknown } } }).curio?.linkMeta!;
  assert.equal(typeof linkMeta.cut, 'string', 'cut 用 base64 位图');
  assert.equal(typeof linkMeta.reverse, 'string', 'reverse 用 base64 位图');
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

test('1200 条 flagged link 用位图保存：flags 全保留且 metadata < 16KiB', () => {
  const W = 'world-bits', D = 'overworld';
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);
  const first = new WorldMemory(null);
  first.setWorld(W);
  first.attachSpatial(backend, { allowEmptyStore: true });
  const links = Array.from({ length: 1200 }, (_, i) => ({ a: at(i, 40, 0), b: at(i + 1, 40, 0), cut: true, reverse: true }));
  first.savePassage({
    id: 'p-bits', worldId: W, dim: D, kind: 'dug', entrances: [], path: [], deepestY: 40, dug: 0, ores: {},
    createdAt: 0, lastUsedAt: 0, uses: 1, links,
  });
  const stored = history.getFragment('p-bits')!;
  const metaJson = JSON.stringify(stored.metadata);
  assert.ok(metaJson.length < 16 * 1024, `metadata ${metaJson.length} 字符应低于 16KiB`);
  const second = new WorldMemory(null);
  second.setWorld(W);
  second.attachSpatial(backend);
  const [p] = second.passages(D);
  assert.equal(p!.links!.length, 1200);
  assert.ok(p!.links!.every((l) => l.cut && l.reverse), '1200 条 flags 全部还原');
  assert.ok(passageRoute([p!], at(0, 40, 0), at(1200, 40, 0), { near: 5 }), '重启后路由仍通');
  first.close();
  second.close();
});

test('fragmentRecord 兼容旧的 linkMeta 数组格式', () => {
  const W = 'world-legacy-meta', D = 'overworld';
  const history = new FragmentStore(W);
  const topology = new TopologyStore(history);
  const ledger = new LedgerStore(W);
  const backend = new SpatialMemoryBackend({ history, topology, ledger }, W);
  history.saveFragment({
    id: 'legacy-meta', worldId: W, dim: D, kind: 'dug', entrances: [], polyline: [], geometrySource: 'legacy',
    links: [{ a: at(0, 60, 0), b: at(0, 56, 0) }], deepestY: 56, createdAt: 0, lastUsedAt: 0, uses: 1,
    metadata: { curio: { v: 1, type: 'passage', dug: 0, ores: {}, linkMeta: [{ i: 0, cut: true, reverse: true }] } },
  });
  const memory = new WorldMemory(null);
  memory.setWorld(W);
  memory.attachSpatial(backend);
  const [p] = memory.passages(D);
  assert.equal(p?.links?.[0]?.cut, true, '旧数组 cut 仍可读');
  assert.equal(p?.links?.[0]?.reverse, true, '旧数组 reverse 仍可读');
  assert.ok(passageRoute([p!], at(0, 56, 0), at(0, 60, 0), { near: 0.5 }), '旧格式的方向证据仍生效');
  memory.close();
});
