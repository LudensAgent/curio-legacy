/**
 * 历史路径图：把共享空间记忆里记录过的路径片段（旧 passage 的 links、运行期片段的
 * polyline）拼成一张只读的格子图，供“沿走过的路去某处”和“片段之间差多远”这类查询用。
 *
 * - 只用真实记录过的相邻关系：links 是旧运行时亲自走过的边；没有 links 的片段按 polyline
 *   相邻点连边。另外把 26 邻域内相互贴着的记录格连起来（joins），使分开记录、但实际
 *   相邻的通道能接上；joins 单独计数，不冒充走过的边。
 * - 边按无向处理：结果只当路点提示，执行时由移动辅助逐跳实测，不代表当前可通行。
 * - 不写库、不建持久索引；每次查询现建，建图与查询都是近线性复杂度：
 *   建图 O(L)，最近格吸附按 8 格网格桶查，路线用二叉堆 Dijkstra O(E log V)，
 *   缺口用并查集分量 + 网格桶近邻（只比较相邻桶里不同分量的格）。
 */
import type { PathFragment, Vec3Like } from 'curio-minecraft-3d-memory';

const BUCKET = 8;
const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
const dist = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bucketKey = (x: number, y: number, z: number, size: number) => `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`;

export type PathGraph = ReturnType<typeof buildPathGraph>;

export function buildPathGraph(fragments: readonly PathFragment[]) {
  const cells = new Map<string, Vec3Like>();
  const adj = new Map<string, Map<string, number>>();
  const fragmentOf = new Map<string, string>();
  const joined = new Set<string>();
  let recorded = 0;
  const cell = (p: Vec3Like, fragmentId: string) => {
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const k = keyOf(c.x, c.y, c.z);
    if (!cells.has(k)) { cells.set(k, c); adj.set(k, new Map()); fragmentOf.set(k, fragmentId); }
    return k;
  };
  const link = (a: string, b: string) => {
    if (a === b || adj.get(a)!.has(b)) return false;
    const d = dist(cells.get(a)!, cells.get(b)!);
    adj.get(a)!.set(b, d);
    adj.get(b)!.set(a, d);
    return true;
  };
  for (const fragment of fragments) {
    const pairs = fragment.links?.length
      ? fragment.links.map((l) => [l.a, l.b] as const)
      : fragment.polyline.slice(1).map((p, i) => [fragment.polyline[i]!, p] as const);
    for (const [a, b] of pairs) if (link(cell(a, fragment.id), cell(b, fragment.id))) recorded++;
    if (pairs.length === 0) for (const p of fragment.polyline) cell(p, fragment.id);
  }
  for (const [k, c] of cells) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = keyOf(c.x + dx, c.y + dy, c.z + dz);
      if (n !== k && cells.has(n) && link(k, n)) { joined.add(`${k}|${n}`); joined.add(`${n}|${k}`); }
    }
  }
  const buckets = new Map<string, string[]>();
  for (const [k, c] of cells) {
    const b = bucketKey(c.x, c.y, c.z, BUCKET);
    const list = buckets.get(b);
    if (list) list.push(k); else buckets.set(b, [k]);
  }
  return { cells, adj, fragmentOf, joined, buckets, stats: { cells: cells.size, recordedEdges: recorded, joins: joined.size / 2 } };
}

/** 半径内离 p 最近的记录格；只扫覆盖半径的网格桶。 */
export function nearestCell(graph: PathGraph, p: Vec3Like, radius: number): { key: string; distance: number } | null {
  const r = Math.ceil(radius / BUCKET);
  const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET), bz = Math.floor(p.z / BUCKET);
  let best: { key: string; distance: number } | null = null;
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    for (const k of graph.buckets.get(`${bx + dx},${by + dy},${bz + dz}`) ?? []) {
      const d = dist(graph.cells.get(k)!, p);
      if (d <= radius && (best === null || d < best.distance)) best = { key: k, distance: d };
    }
  }
  return best;
}

/** 二叉堆（按 cost 最小） */
function heap() {
  const items: { key: string; cost: number }[] = [];
  return {
    get size() { return items.length; },
    push(item: { key: string; cost: number }) {
      items.push(item);
      for (let i = items.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (items[parent]!.cost <= items[i]!.cost) break;
        [items[parent], items[i]] = [items[i]!, items[parent]!];
        i = parent;
      }
    },
    pop() {
      const top = items[0]!;
      const last = items.pop()!;
      if (items.length) {
        items[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < items.length && items[l]!.cost < items[m]!.cost) m = l;
          if (r < items.length && items[r]!.cost < items[m]!.cost) m = r;
          if (m === i) break;
          [items[m], items[i]] = [items[i]!, items[m]!];
          i = m;
        }
      }
      return top;
    },
  };
}

export type PathGraphRoute =
  | { status: 'START_NOT_RECORDED'; message: string }
  | {
    /** FOUND = 终点格离目标不超过 near；PARTIAL = 目标不在同一连通的记录里，走到记录里离目标最近的格 */
    status: 'FOUND' | 'PARTIAL';
    points: Vec3Like[];
    fragments: string[];
    /** 路线里用到的 26 邻域贴合连接数（不是走过的边） */
    joinsUsed: number;
    length: number;
    startSnap: number;
    endDistance: number;
    message: string;
  };

/**
 * 在历史路径图上从 from 附近的记录格走到 to 附近的记录格。to 不在同一连通部分时返回
 * PARTIAL：走到该连通部分里离 to 最近的格（只是历史几何，不是到达证明）。
 */
export function routeOnPathGraph(graph: PathGraph, from: Vec3Like, to: Vec3Like, near: number, deadline: number): PathGraphRoute {
  const start = nearestCell(graph, from, near);
  if (start === null) return { status: 'START_NOT_RECORDED', message: `起点 ${near} 格内没有记录过的路径格` };
  const goal = nearestCell(graph, to, near);
  const cost = new Map<string, number>([[start.key, 0]]);
  const parent = new Map<string, string>();
  const queue = heap();
  queue.push({ key: start.key, cost: 0 });
  let closest = start.key, closestDistance = dist(graph.cells.get(start.key)!, to);
  let reached: string | null = null;
  let expanded = 0;
  while (queue.size) {
    const { key, cost: c } = queue.pop();
    if (c > cost.get(key)!) continue;
    if (key === goal?.key) { reached = key; break; }
    const d = dist(graph.cells.get(key)!, to);
    if (d < closestDistance) { closest = key; closestDistance = d; }
    if (++expanded % 4096 === 0 && Date.now() > deadline) break;
    for (const [next, w] of graph.adj.get(key)!) {
      const nc = c + w;
      if (nc < (cost.get(next) ?? Infinity)) { cost.set(next, nc); parent.set(next, key); queue.push({ key: next, cost: nc }); }
    }
  }
  const end = reached ?? closest;
  const keys = [end];
  while (keys[0] !== start.key) keys.unshift(parent.get(keys[0]!)!);
  const points = keys.map((k) => ({ ...graph.cells.get(k)! }));
  const fragments = [...new Set(keys.map((k) => graph.fragmentOf.get(k)!))];
  const joinsUsed = keys.slice(1).filter((k, i) => graph.joined.has(`${keys[i]}|${k}`)).length;
  const endDistance = dist(graph.cells.get(end)!, to);
  const status = reached !== null || endDistance <= near ? 'FOUND' : 'PARTIAL';
  return {
    status, points, fragments, joinsUsed,
    length: Math.round(cost.get(end)! * 10) / 10,
    startSnap: Math.round(start.distance * 10) / 10,
    endDistance: Math.round(endDistance * 10) / 10,
    message: status === 'FOUND'
      ? `记录里有连到目标附近的路径（${points.length} 格，经过 ${fragments.length} 条片段）`
      : `目标不在起点所在的这片记录里；记录路径最多到离目标 ${Math.round(endDistance)} 格处`,
  };
}

/** 连通分量（并查集，按路径压缩） */
export function pathComponents(graph: PathGraph) {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let c = k; c !== root;) { const n = parent.get(c)!; parent.set(c, root); c = n; }
    return root;
  };
  for (const k of graph.cells.keys()) parent.set(k, k);
  for (const [k, ns] of graph.adj) for (const n of ns.keys()) { const a = find(k), b = find(n); if (a !== b) parent.set(a, b); }
  const componentOf = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const k of graph.cells.keys()) { const r = find(k); componentOf.set(k, r); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  return { componentOf, sizes };
}

export type PathGap = { a: Vec3Like; b: Vec3Like; distance: number; componentA: string; componentB: string };

/**
 * 不同连通分量之间、距离不超过 maxGap 的最近格对（每对分量只留最近的一对）。
 * 网格桶边长取 maxGap，只看 27 个相邻桶；同一分量的整组格直接跳过，不做两两比较。
 */
export function pathGaps(graph: PathGraph, componentOf: Map<string, string>, maxGap: number, deadline: number) {
  const size = Math.max(2, Math.ceil(maxGap));
  const grid = new Map<string, Map<string, string[]>>();
  for (const [k, c] of graph.cells) {
    const b = bucketKey(c.x, c.y, c.z, size);
    const comp = componentOf.get(k)!;
    const groups = grid.get(b) ?? grid.set(b, new Map()).get(b)!;
    const list = groups.get(comp);
    if (list) list.push(k); else groups.set(comp, [k]);
  }
  const best = new Map<string, PathGap>();
  let complete = true;
  let scanned = 0;
  outer:
  for (const [b, groups] of grid) {
    const [bx, by, bz] = b.split(',').map(Number) as [number, number, number];
    const neighbours = [] as Map<string, string[]>[];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const g = grid.get(`${bx + dx},${by + dy},${bz + dz}`);
      if (g) neighbours.push(g);
    }
    for (const [compA, keysA] of groups) {
      for (const g of neighbours) for (const [compB, keysB] of g) {
        if (compB <= compA) continue;
        const pair = `${compA}|${compB}`;
        for (const ka of keysA) {
          if (++scanned % 4096 === 0 && Date.now() > deadline) { complete = false; break outer; }
          const a = graph.cells.get(ka)!;
          for (const kb of keysB) {
            const d = dist(a, graph.cells.get(kb)!);
            const current = best.get(pair);
            if (d <= maxGap && (current === undefined || d < current.distance)) best.set(pair, { a, b: graph.cells.get(kb)!, distance: d, componentA: compA, componentB: compB });
          }
        }
      }
    }
  }
  return { gaps: [...best.values()].sort((x, y) => x.distance - y.distance), complete };
}
