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
