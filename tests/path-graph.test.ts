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
  assert.ok(down.status === 'FOUND');
  assert.deepEqual(down.climbs, []);
  const up = routeOnPathGraph(graph, { x: 6, y: 52, z: 0 }, { x: 0, y: 70, z: 0 }, 2, Date.now() + 1000);
  assert.ok(up.status === 'FOUND');
  assert.deepEqual(up.climbs, [{ from: { x: 2, y: 52, z: 0 }, to: { x: 1, y: 70, z: 0 }, height: 18 }]);
});

const trail = (id: string, cells: { x: number; y: number; z: number }[]): PathFragment => ({
  id, worldId: 'w', dim: 'the_nether', kind: 'dug', entrances: [], polyline: cells, geometrySource: 'traversal',
  deepestY: Math.min(...cells.map((c) => c.y)), createdAt: 1, lastUsedAt: 1, uses: 1,
} as PathFragment);
const column = (x: number, y: number, z0: number, z1: number) => Array.from({ length: Math.abs(z1 - z0) + 1 }, (_, i) => ({ x, y, z: z0 + Math.sign(z1 - z0) * i }));
/** 把折线顶点按整数格补齐成真实连续路径。 */
const through = (points: { x: number; y: number; z: number }[]) => {
  const out = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    for (let s = 1; s <= n; s++) out.push({ x: a.x + Math.sign(b.x - a.x) * s, y: a.y + Math.sign(b.y - a.y) * s, z: a.z + Math.sign(b.z - a.z) * s });
  }
  return out;
};
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

test('preferRecorded：U 形长旧路能连接相距很近的两端，不因假想直线便宜被抛弃', () => {
  const u = [
    ...Array.from({ length: 26 }, (_, i) => ({ x: i, y: 64, z: 0 })),
    ...Array.from({ length: 10 }, (_, i) => ({ x: 25, y: 64, z: i + 1 })),
    ...Array.from({ length: 26 }, (_, i) => ({ x: 25 - i, y: 64, z: 10 })),
  ];
  const graph = buildPathGraph([trail('u', u)]);
  const start = { x: 0.5, y: 64, z: 0.5 }, target = { x: 0.5, y: 64, z: 10.5 };
  assert.equal(routeOnPathGraph(graph, start, target, 3, Date.now() + 2000, { reach: 8, maxGap: 8 }).status, 'NO_BENEFIT');
  const route = routeOnPathGraph(graph, start, target, 3, Date.now() + 2000, { reach: 8, maxGap: 8, preferRecorded: true });
  assert.ok(route.status === 'FOUND', 'message' in route ? route.message : '');
  assert.ok(route.length > 50, `沿真实 U 形记录走，实际 ${route.length} 格`);
  assert.ok(route.points.some((p) => p.x === 25 && p.z > 0), '走过 U 形的远端');
});

test('preferRecorded：同一近起点锚点下有两条旧连接时按实际记录长度选较短的一条', () => {
  const short = Array.from({ length: 11 }, (_, i) => ({ x: 0, y: 64, z: i }));
  const long = [
    ...Array.from({ length: 21 }, (_, i) => ({ x: i, y: 64, z: 0 })),
    ...Array.from({ length: 11 }, (_, i) => ({ x: 20, y: 64, z: i })),
    ...Array.from({ length: 21 }, (_, i) => ({ x: 20 - i, y: 64, z: 10 })),
  ];
  const graph = buildPathGraph([trail('short', short), trail('long', long)]);
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 10.5 }, 3, Date.now() + 2000, { reach: 8, maxGap: 8, preferRecorded: true });
  assert.ok(route.status === 'FOUND', 'message' in route ? route.message : '');
  assert.deepEqual(route.fragments, ['short']);
  assert.equal(route.length, 10, '目标格本身在记录里时，必须走到该记录格，不用 near 半径提前停止');
});

test('preferRecorded：目标脚格在记录里时必须走到目标格，near 只表示接近不能提前标 FOUND', () => {
  const u = through([{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 12 }, { x: 6, y: 64, z: 12 }, { x: 6, y: 64, z: 0 }]);
  const graph = buildPathGraph([trail('u', u)]);
  for (const near of [8, 0]) {
    const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 6.5, y: 64, z: 0.5 }, near, Date.now() + 2000, { reach: 8, maxGap: 8, preferRecorded: true });
    assert.ok(route.status === 'FOUND', `near=${near}`);
    if (route.status !== 'FOUND') continue;
    assert.equal(route.length, 30, `沿完整 U 形记录走到目标格，near=${near}`);
    assert.equal(route.targetRecorded, true);
    assert.equal(route.recordedOnly, true);
    assert.ok(route.points.length > 20);
  }
});

test('preferRecorded：目标不在记录里时最多 PARTIAL，near 半径不能冒充完整连接', () => {
  const road = trail('road', through([{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 10 }]));
  const graph = buildPathGraph([road]);
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 15.5 }, 8, Date.now() + 2000, { reach: 8, maxGap: 0, preferRecorded: true });
  assert.equal(route.status, 'PARTIAL');
  if (route.status !== 'PARTIAL') return;
  assert.equal(route.targetRecorded, false);
  assert.ok(route.endDistance >= 5, `最后一段未记录，仍差 ${route.endDistance} 格`);
});

test('preferRecorded：完整真实记录路优先于 26 邻接和跨片假想连接', () => {
  const viaZ30 = through([{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 30 }, { x: 20, y: 64, z: 30 }, { x: 20, y: 64, z: 0 }]);
  const viaZ40 = through([{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: -40 }, { x: 20, y: 64, z: -40 }, { x: 20, y: 64, z: 0 }]);
  const graph = buildPathGraph([
    trail('via30', viaZ30), trail('via40', viaZ40),
    trail('gapA', through([{ x: 4, y: 64, z: 0 }, { x: 6, y: 64, z: 0 }])),
    trail('gapB', through([{ x: 14, y: 64, z: 0 }, { x: 16, y: 64, z: 0 }])),
  ]);
  for (const near of [0, 8]) {
    const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 20.5, y: 64, z: 0.5 }, near, Date.now() + 2000, { reach: 8, maxGap: 16, preferRecorded: true });
    assert.ok(route.status === 'FOUND', `near=${near}`);
    if (route.status !== 'FOUND') continue;
    assert.equal(route.length, 80, `选较短的完整真实旧路，near=${near}`);
    assert.equal(route.hypothetical, false);
    assert.equal(route.connectors.length, 0);
    assert.deepEqual(route.fragments, ['via30']);
  }
});

test('preferRecorded：真实拐角不能被 26 邻接斜边冒充，joined 与真实记录边分开', () => {
  const corner = through([{ x: 0, y: 64, z: 0 }, { x: -1, y: 64, z: 0 }, { x: -1, y: 64, z: 2 }, { x: 1, y: 64, z: 2 }, { x: 1, y: 64, z: 1 }]);
  const graph = buildPathGraph([trail('corner', corner)]);
  assert.ok(graph.joined.has('0,64,0|1,64,1'), '26 邻接候选存在，但它不是走过的边');
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 1.5 }, 0, Date.now() + 2000, { reach: 4, maxGap: 8, preferRecorded: true });
  assert.ok(route.status === 'FOUND');
  if (route.status !== 'FOUND') return;
  assert.equal(route.length, 6, '沿真实拐角记录走，不走斜向 joins');
  assert.equal(route.joinsUsed, 0);
});

test('buildPathGraph：已有真实记录边的相邻格不会被后续片段误标成 26 邻接', () => {
  const graph = buildPathGraph([
    trail('real', through([{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }])),
    trail('touch', [{ x: 1, y: 64, z: 0 }]),
  ]);
  assert.equal(graph.joined.has('0,64,0|1,64,0'), false, '真实记录边不应同时算 joins');
  assert.equal(graph.joined.has('1,64,0|0,64,0'), false);
  assert.equal(graph.recordedEdges.has('0,64,0|1,64,0'), true);
});

test('preferRecorded：身体实际脚格有记录时优先该格，不被更近的隔墙记录格替代', () => {
  const road = trail('road', through([{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 12 }]));
  const wallSide = trail('wall_side', [{ x: 1, y: 64, z: 0 }]);
  const graph = buildPathGraph([road, wallSide]);
  // 身体中心在 x=0.9：到 x=1 的记录格更近，但实际脚格是 x=0。
  const route = routeOnPathGraph(graph, { x: 0.9, y: 64, z: 0.1 }, { x: 0.5, y: 64, z: 12.5 }, 0, Date.now() + 2000, { reach: 4, maxGap: 0, preferRecorded: true });
  assert.ok(route.status === 'FOUND');
  if (route.status !== 'FOUND') return;
  assert.deepEqual(route.points[0], { x: 0, y: 64, z: 0 });
  assert.deepEqual(route.fragments, ['road']);
});

test('preferRecorded：PARTIAL 端点按离目标更近的已连通记录选，不被起点或假想离路代价拉回', () => {
  const road = trail('road', through([{ x: 0, y: 64, z: 0 }, { x: 80, y: 64, z: 0 }]));
  const graph = buildPathGraph([road]);
  const route = routeOnPathGraph(graph, { x: 0.5, y: 64, z: 0.5 }, { x: 100.5, y: 64, z: 0.5 }, 8, Date.now() + 2000, { reach: 8, maxGap: 0, preferRecorded: true });
  assert.equal(route.status, 'PARTIAL');
  if (route.status !== 'PARTIAL') return;
  assert.equal(route.points.at(-1)!.x, 80, '终点应沿记录推进到更接近目标的末端，而不是停在起点');
  assert.ok(route.endDistance < 30);
});
