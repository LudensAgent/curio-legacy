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
/** 记录里相邻两点高差超过普通步行（2 格）的是一次掉落：往下走照常，逆着它往上要爬升，按这个倍数加代价。 */
const DROP_STEP = 2;
const CLIMB_PENALTY = 4;
const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
const dist = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bucketKey = (x: number, y: number, z: number, size: number) => `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`;

export type PathGraph = ReturnType<typeof buildPathGraph>;

export function buildPathGraph(fragments: readonly PathFragment[]) {
  const cells = new Map<string, Vec3Like>();
  const adj = new Map<string, Map<string, number>>();
  const fragmentOf = new Map<string, string>();
  const joined = new Set<string>();
  /** `低格|高格`：从低处沿这条边往上，是逆着一次记录过的掉落爬回去 */
  const climbs = new Set<string>();
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
    for (const [a, b] of pairs) {
      const ka = cell(a, fragment.id), kb = cell(b, fragment.id);
      if (link(ka, kb)) recorded++;
      if (Math.abs(a.y - b.y) > DROP_STEP) climbs.add(a.y < b.y ? `${ka}|${kb}` : `${kb}|${ka}`);
    }
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
  return { cells, adj, fragmentOf, joined, climbs, buckets, stats: { cells: cells.size, recordedEdges: recorded, joins: joined.size / 2, drops: climbs.size } };
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

/** 不在记录路径上的移动（上路、路接路、下路）按走记录路的这么多倍算：离开记录可能要挖或垫，pathfinder 里开一格通道约是走一格的 3 倍多。 */
const OFF_ROAD = 3;

export type PathGraphRoute =
  | { status: 'START_NOT_RECORDED'; message: string }
  /** 记录路径加上上路/下路的离路代价，不比直接走过去省：沿记录走没有好处。 */
  | { status: 'NO_BENEFIT'; message: string }
  | {
    /** FOUND = 终点格离目标不超过 near；PARTIAL = 目标不在同一连通的记录里，走到记录里离目标最近的格 */
    status: 'FOUND' | 'PARTIAL';
    points: Vec3Like[];
    fragments: string[];
    /** 路线里用到的 26 邻域贴合连接数（不是走过的边） */
    joinsUsed: number;
    /** 路线里逆着记录过的掉落往上的段（当初是掉下来的，原路返回要爬升 height 格） */
    climbs: { from: Vec3Like; to: Vec3Like; height: number }[];
    length: number;
    startSnap: number;
    endDistance: number;
    /** 路线里跨过的“路与路之间”的离路连接（两片记录不相连，中间要自己走过去） */
    connectors: { from: Vec3Like; to: Vec3Like; distance: number }[];
    message: string;
  };

/**
 * 在历史路径图上找从 from 到 to 最省的“上路 → 沿记录走（可在路与路之间跨过去） → 下路”。
 * 不在记录上的移动（上路、跨路、下路）按 offRoad 倍距离计代价：离旧路几十格但能省几百格时先接上旧路，
 * 方向不对或绕得太远的记录就不用。默认只从 near 格内上路、不跨路，与只沿脚下这条路走的旧口径一致；
 * travel_to 传更大的 reach/maxGap。终点格离 to 不超过 near 为 FOUND，否则 PARTIAL（记录只到半路）；
 * 记录路线算上离路代价也不比直接走省就是 NO_BENEFIT。只是历史几何，不是到达证明。
 */
export function routeOnPathGraph(graph: PathGraph, from: Vec3Like, to: Vec3Like, near: number, deadline: number,
  opts: { reach?: number; maxGap?: number; offRoad?: number } = {}): PathGraphRoute {
  const reach = opts.reach ?? near, off = opts.offRoad ?? OFF_ROAD;
  // 离路一段的代价：距离按 off 倍计，往上的高差另按记录里爬升同样的倍数加（没有记录时往上要搭柱或开阶梯）。
  const offCost = (a: Vec3Like, b: Vec3Like) => off * dist(a, b) + Math.max(0, b.y - a.y) * CLIMB_PENALTY;
  const entries = cellsWithin(graph, from, reach);
  if (entries.length === 0) return { status: 'START_NOT_RECORDED', message: `起点 ${reach} 格内没有记录过的路径格` };
  // 路与路之间的离路连接：每对不相连的记录只取最近的一对格，按离路代价连起来。
  const connectors = new Map<string, { key: string; w: number; distance: number }[]>();
  if (opts.maxGap) {
    const { componentOf } = pathComponents(graph);
    for (const g of pathGaps(graph, componentOf, opts.maxGap, deadline).gaps) {
      const a = keyOf(g.a.x, g.a.y, g.a.z), b = keyOf(g.b.x, g.b.y, g.b.z);
      (connectors.get(a) ?? connectors.set(a, []).get(a)!).push({ key: b, w: offCost(g.a, g.b), distance: g.distance });
      (connectors.get(b) ?? connectors.set(b, []).get(b)!).push({ key: a, w: offCost(g.b, g.a), distance: g.distance });
    }
  }
  const cost = new Map<string, number>(), parent = new Map<string, string>(), entryOf = new Map<string, number>();
  const queue = heap();
  for (const e of entries) {
    const c = offCost(from, graph.cells.get(e.key)!);
    cost.set(e.key, c); entryOf.set(e.key, e.distance); queue.push({ key: e.key, cost: c });
  }
  let best: string | null = null, bestScore = Infinity, expanded = 0;
  while (queue.size) {
    const { key, cost: c } = queue.pop();
    if (c > cost.get(key)!) continue;
    const score = c + offCost(graph.cells.get(key)!, to);
    if (score < bestScore) { best = key; bestScore = score; }
    if (++expanded % 4096 === 0 && Date.now() > deadline) break;
    const step = (next: string, nc: number) => {
      if (nc < (cost.get(next) ?? Infinity)) { cost.set(next, nc); parent.set(next, key); entryOf.delete(next); queue.push({ key: next, cost: nc }); }
    };
    for (const [next, w] of graph.adj.get(key)!) step(next, c + (graph.climbs.has(`${key}|${next}`) ? w * CLIMB_PENALTY : w));
    for (const link of connectors.get(key) ?? []) step(link.key, c + link.w);
  }
  if (best === null || bestScore >= offCost(from, to)) {
    return { status: 'NO_BENEFIT', message: `记录路径算上离路的代价也不比直接走省（离路按 ${off} 倍计）` };
  }
  const keys = [best];
  while (!entryOf.has(keys[0]!)) keys.unshift(parent.get(keys[0]!)!);
  const points = keys.map((k) => ({ ...graph.cells.get(k)! }));
  const fragments = [...new Set(keys.map((k) => graph.fragmentOf.get(k)!))];
  const pairs = keys.slice(1).map((k, i) => [keys[i]!, k] as const);
  const isConnector = ([a, b]: readonly [string, string]) => !graph.adj.get(a)!.has(b);
  const joinsUsed = pairs.filter(([a, b]) => !isConnector([a, b]) && graph.joined.has(`${a}|${b}`)).length;
  const climbs = pairs.flatMap(([a, b]) => {
    if (!graph.climbs.has(`${a}|${b}`)) return [];
    const p = graph.cells.get(a)!, q = graph.cells.get(b)!;
    return [{ from: { ...p }, to: { ...q }, height: q.y - p.y }];
  });
  const usedConnectors = pairs.filter(isConnector).map(([a, b]) => {
    const p = graph.cells.get(a)!, q = graph.cells.get(b)!;
    return { from: { ...p }, to: { ...q }, distance: Math.round(dist(p, q) * 10) / 10 };
  });
  const endDistance = dist(graph.cells.get(best)!, to);
  const status = endDistance <= near ? 'FOUND' : 'PARTIAL';
  return {
    status, points, fragments, joinsUsed, climbs, connectors: usedConnectors,
    // 路程按实际几何算，不含爬升惩罚
    length: Math.round(pairs.reduce((sum, [a, b]) => sum + dist(graph.cells.get(a)!, graph.cells.get(b)!), 0) * 10) / 10,
    startSnap: Math.round(entryOf.get(keys[0]!)! * 10) / 10,
    endDistance: Math.round(endDistance * 10) / 10,
    message: status === 'FOUND'
      ? `记录里有连到目标附近的路径（${points.length} 格，经过 ${fragments.length} 条片段${usedConnectors.length ? `，其中 ${usedConnectors.length} 处要跨过两片记录之间的空当` : ''}）`
      : `记录路径最多到离目标 ${Math.round(endDistance)} 格处`,
  };
}

/** 半径内的全部记录格（按距离升序）；只扫覆盖半径的网格桶。 */
function cellsWithin(graph: PathGraph, p: Vec3Like, radius: number) {
  const r = Math.ceil(radius / BUCKET);
  const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET), bz = Math.floor(p.z / BUCKET);
  const out: { key: string; distance: number }[] = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    for (const k of graph.buckets.get(`${bx + dx},${by + dy},${bz + dz}`) ?? []) {
      const d = dist(graph.cells.get(k)!, p);
      if (d <= radius) out.push({ key: k, distance: d });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
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
