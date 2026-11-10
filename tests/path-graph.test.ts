import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PathFragment } from 'curio-minecraft-3d-memory';
import { buildPathGraph, pathComponents, pathGaps, routeOnPathGraph } from '../src/spatial/path-graph.ts';

const line = (id: string, from: { x: number; y: number; z: number }, dx: number, n: number, withLinks = true): PathFragment => {
  const cells = Array.from({ length: n }, (_, i) => ({ x: from.x + dx * i, y: from.y, z: from.z }));
  return {
    id, worldId: 'w', dim: 'overworld', kind: 'dug', entrances: [], polyline: withLinks ? [cells[0]!] : cells,
    geometrySource: withLinks ? 'legacy' : 'traversal', deepestY: from.y, createdAt: 1, lastUsedAt: 1, uses: 1,
    ...(withLinks ? { links: cells.slice(1).map((b, i) => ({ a: cells[i]!, b })) } : {}),
  } as PathFragment;
};

test('路径图：旧 links 与运行期 polyline 贴着时用 joins 接上，路线回报用到的片段与 joins', () => {
  const graph = buildPathGraph([line('a', { x: 0, y: 64, z: 0 }, 1, 10), line('b', { x: 10, y: 64, z: 1 }, 1, 10, false)]);
  const route = routeOnPathGraph(graph, { x: 0, y: 64, z: 0 }, { x: 19, y: 64, z: 1 }, 4, Date.now() + 1000);
  assert.ok(route.status === 'FOUND');
  assert.deepEqual(route.fragments, ['a', 'b']);
  assert.ok(route.joinsUsed >= 1);
});

test('路径图：目标不在同一片记录里返回 PARTIAL，终点是记录里离目标最近的格；起点附近没记录如实说', () => {
  const graph = buildPathGraph([line('a', { x: 0, y: 64, z: 0 }, 1, 10), line('far', { x: 40, y: 64, z: 0 }, 1, 5)]);
  const route = routeOnPathGraph(graph, { x: 0, y: 64, z: 0 }, { x: 42, y: 64, z: 0 }, 4, Date.now() + 1000);
  assert.equal(route.status, 'PARTIAL');
  assert.ok(route.status === 'PARTIAL' && route.points.at(-1)!.x === 9);
  assert.equal(routeOnPathGraph(graph, { x: 0, y: 64, z: 30 }, { x: 9, y: 64, z: 0 }, 4, Date.now() + 1000).status, 'START_NOT_RECORDED');
});

test('路径图缺口：每对分量只报最近一对格，超过 maxGap 的不报', () => {
  const graph = buildPathGraph([line('a', { x: 0, y: 64, z: 0 }, 1, 10), line('b', { x: 13, y: 64, z: 0 }, 1, 5), line('c', { x: 60, y: 64, z: 0 }, 1, 5)]);
  const { componentOf, sizes } = pathComponents(graph);
  assert.equal(sizes.size, 3);
  const { gaps, complete } = pathGaps(graph, componentOf, 8, Date.now() + 1000);
  assert.equal(complete, true);
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0]!.a.x, gaps[0]!.b.x].sort((x, y) => x - y), [9, 13]);
  assert.equal(gaps[0]!.distance, 4);
});

test('记录过的掉落是单向的：往下照常走，逆着往上要爬升，路线里单独列出且优先绕开', () => {
  const base = { worldId: 'w', dim: 'the_nether', entrances: [], geometrySource: 'traversal' as const, deepestY: 0, createdAt: 0, lastUsedAt: 0, uses: 1 };
  const graph = buildPathGraph([
    { ...base, id: 'top', kind: 'walked', polyline: [{ x: 0, y: 70, z: 0 }, { x: 1, y: 70, z: 0 }] },
    { ...base, id: 'drop', kind: 'walked', polyline: [{ x: 1, y: 70, z: 0 }, { x: 2, y: 52, z: 0 }] },
    { ...base, id: 'bottom', kind: 'walked', polyline: [{ x: 2, y: 52, z: 0 }, { x: 6, y: 52, z: 0 }] },
  ]);
  const down = routeOnPathGraph(graph, { x: 0, y: 70, z: 0 }, { x: 6, y: 52, z: 0 }, 2, Date.now() + 1000);
  assert.equal(down.status, 'FOUND');
  assert.deepEqual(down.status === 'START_NOT_RECORDED' ? null : down.climbs, []);
  const up = routeOnPathGraph(graph, { x: 6, y: 52, z: 0 }, { x: 0, y: 70, z: 0 }, 2, Date.now() + 1000);
  assert.equal(up.status, 'FOUND');
  assert.deepEqual(up.status === 'START_NOT_RECORDED' ? null : up.climbs, [{ from: { x: 2, y: 52, z: 0 }, to: { x: 1, y: 70, z: 0 }, height: 18 }]);
});

const trail = (id: string, cells: { x: number; y: number; z: number }[]): PathFragment => ({
  id, worldId: 'w', dim: 'the_nether', kind: 'dug', entrances: [], polyline: cells, geometrySource: 'traversal',
  deepestY: Math.min(...cells.map((c) => c.y)), createdAt: 1, lastUsedAt: 1, uses: 1,
} as PathFragment);
const column = (x: number, y: number, z0: number, z1: number) => Array.from({ length: Math.abs(z1 - z0) + 1 }, (_, i) => ({ x, y, z: z0 + Math.sign(z1 - z0) * i }));
const opts = { reach: 24, maxGap: 16 };

test('历史路线：脚下是一小段孤立记录、旁边隔着空当有通往目标的长隧道时，跨过空当接上隧道走，而不是只走脚下这段', () => {
  // 线上 09:18：刚 explore 出来的一段在 x=23 附近，通往门的长隧道在 x=-13（z -340..-120），起点离隧道 35 格、超出上路半径。
  const graph = buildPathGraph([
    // 新记录沿 z=-300 往西走到 x=0，离隧道（x=-13，高 9 格）约 15.8 格，不相连。
    trail('fresh', [...column(23, 45, -326, -301), ...Array.from({ length: 24 }, (_, i) => ({ x: 23 - i, y: 45, z: -300 }))]),
    trail('tunnel', column(-13, 54, -340, -120)),
  ]);
  const route = routeOnPathGraph(graph, { x: 23.5, y: 45, z: -326.5 }, { x: -13, y: 54, z: -122 }, 8, Date.now() + 2000, opts);
  assert.equal(route.status, 'FOUND', 'message' in route ? route.message : '');
  if (route.status !== 'FOUND') return;
  assert.ok(route.fragments.includes('tunnel'), '路线用上了那条长隧道');
  assert.equal(route.connectors.length, 1, '跨过一处两片记录之间的空当');
  assert.ok(route.points.filter((p) => p.x === -13).length > 150, '大部分路程沿隧道走');
});

test('历史路线：附近只有方向相反的旧路时，不被它带偏，如实说沿记录走没有好处', () => {
  const graph = buildPathGraph([trail('away', column(0, 64, 0, -60))]);
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 64, z: 80 }, 8, Date.now() + 2000, opts);
  assert.equal(route.status, 'NO_BENEFIT');
});

test('历史路线：起点不在记录上、旁边 20 格有通往目标的旧路时，从旁边上路；不传 reach 时仍按旧口径只认近处', () => {
  const graph = buildPathGraph([trail('road', column(20, 64, 0, 200))]);
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 20, y: 64, z: 198 }, 8, Date.now() + 2000, opts);
  assert.equal(route.status, 'FOUND');
  if (route.status !== 'FOUND') return;
  assert.ok(route.startSnap >= 19 && route.startSnap <= 21, `从 20 格外上路，实际 ${route.startSnap}`);
  assert.equal(routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 20, y: 64, z: 198 }, 8, Date.now() + 2000).status, 'START_NOT_RECORDED');
});
