import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import { fragmentArchivedAt, pageFragments } from '../spatial/fragments.ts';
import { buildPathGraph, pathComponents, pathGaps } from '../spatial/path-graph.ts';
import { fail, finitePoint, obj, ok, type Skill } from './types.ts';

const KINDS = ['dug', 'walked', 'bridge', 'built'] as const;
const METRICS = ['deepest', 'farthest', 'gaps', 'explored'] as const;
type Metric = typeof METRICS[number];

interface ExtremaArgs {
  metric: Metric;
  dim?: string;
  kinds?: PathFragment['kind'][];
  origin?: Vec3Like;
  space?: 'horizontal' | 'euclidean';
  includeArchived?: boolean;
  maxFragments?: number;
  maxDistance?: number;
  maxGap?: number;
  limit?: number;
}

const distance = (a: Vec3Like, b: Vec3Like, space: 'horizontal' | 'euclidean') =>
  space === 'horizontal' ? Math.hypot(a.x - b.x, a.z - b.z) : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const round1 = (v: number) => Math.round(v * 10) / 10;
const at = (p: Vec3Like) => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;

const fragmentFacts = (fragment: PathFragment) => ({
  id: fragment.id,
  kind: fragment.kind,
  geometrySource: fragment.geometrySource,
  deepestY: fragment.deepestY,
  createdAt: fragment.createdAt,
  lastUsedAt: fragment.lastUsedAt,
  uses: fragment.uses,
  ...(fragmentArchivedAt(fragment) === undefined ? {} : { archived: true }),
  ...(fragment.externalRef === undefined ? {} : { externalRef: fragment.externalRef }),
  ...(fragment.entrances.length ? { entrances: fragment.entrances.map((p) => ({ ...p })) } : {}),
});

type FragmentFacts = ReturnType<typeof fragmentFacts>;
type ExtremaBest =
  | { kind: 'deepest'; point: Vec3Like; pointY: number; deepestY: number; value: number; fragment: FragmentFacts }
  | { kind: 'farthest'; point: Vec3Like; distance: number; origin: Vec3Like; space: 'horizontal' | 'euclidean'; fragment: FragmentFacts };

/** 片段里记录过的脚点：polyline 是抽样，旧 passage 的 links 才含每一格，两者都算。 */
const recordedPoints = (fragment: PathFragment): Vec3Like[] =>
  [...fragment.polyline, ...(fragment.links ?? []).flatMap((l) => [l.a, l.b])];

/** 已访问区块的八方位范围：每个方位里最远的已访问区块，以及“边缘区块”（至少一个四邻区块没访问过）里最近/最远的。 */
function exploredFacts(visits: { cx: number; cz: number; count: number }[], origin: Vec3Like) {
  const seen = new Set(visits.map((v) => `${v.cx},${v.cz}`));
  const SECTORS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;
  const sectors = new Map(SECTORS.map((s) => [s, { farthest: null as null | { center: Vec3Like; distance: number }, edgeChunks: 0, nearestEdge: null as null | { center: Vec3Like; distance: number }, farthestEdge: null as null | { center: Vec3Like; distance: number } }]));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of visits) {
    const center = { x: v.cx * 16 + 8, y: origin.y, z: v.cz * 16 + 8 };
    minX = Math.min(minX, v.cx * 16); maxX = Math.max(maxX, v.cx * 16 + 15); minZ = Math.min(minZ, v.cz * 16); maxZ = Math.max(maxZ, v.cz * 16 + 15);
    const dx = center.x - origin.x, dz = center.z - origin.z;
    const d = Math.round(Math.hypot(dx, dz));
    // 方位按 Minecraft 坐标：+x 东、+z 南
    const sector = sectors.get(SECTORS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8]!)!;
    if (sector.farthest === null || d > sector.farthest.distance) sector.farthest = { center, distance: d };
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => !seen.has(`${v.cx + ox!},${v.cz + oz!}`));
    if (!edge) continue;
    sector.edgeChunks++;
    if (sector.nearestEdge === null || d < sector.nearestEdge.distance) sector.nearestEdge = { center, distance: d };
    if (sector.farthestEdge === null || d > sector.farthestEdge.distance) sector.farthestEdge = { center, distance: d };
  }
  return {
    visitedChunks: visits.length,
    bounds: visits.length ? { minX, maxX, minZ, maxZ } : null,
    sectors: Object.fromEntries([...sectors].filter(([, s]) => s.farthest !== null)),
  };
}

export const spatialExtrema: Skill<ExtremaArgs> = {
  name: 'spatial_extrema',
  description: '只读统计共享空间记忆里的历史路径与访问范围：deepest 最深记录点（可限定离原点多远以内）、farthest 最远记录点、gaps 记录路径之间断开处的最近格对、explored 已访问区块的八方位范围与边缘；返回历史几何事实，不代表当前可通行。',
  argsDoc: '{"metric":"deepest|farthest|gaps|explored","dim"?:"维度（默认当前）","kinds"?:["dug"|"walked"|"bridge"|"built"]（默认全部路径 kind）,"origin"?:{x,y,z}（默认当前脚位；跨维度必须显式给）,"space"?:"horizontal|euclidean"（默认 horizontal）,"maxDistance"?:1-10000（deepest/farthest 只看离 origin 这么远以内的记录点；gaps 只列至少一端在这范围内的缺口）,"maxGap"?:2-32（gaps 两片记录相距不超过多少格才列出，默认 8）,"limit"?:1-50（gaps 最多列几处，默认 10）,"includeArchived"?:true（false 时不计旧运行时归档的片段）,"maxFragments"?:1-1000}；gaps 的“断开”只按记录判断：两片记录没有记录过的相连，不代表中间实际是实心；explored 按区块访问记录，edge 区块是至少一侧邻区块没去过的；只读，不选目标、不执行。',
  timeoutMs: 5000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const metric = a.metric;
    if (!METRICS.includes(metric as Metric)) return { ok: false, error: `metric 必须是 ${METRICS.join('|')}` };
    if (a.dim !== undefined && (typeof a.dim !== 'string' || a.dim.length === 0)) return { ok: false, error: 'dim 必须是非空字符串' };
    const kinds = a.kinds;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => !KINDS.includes(kind)))) {
      return { ok: false, error: `kinds 必须是非空的 ${KINDS.join('|')} 数组；不写则默认全部路径 kind` };
    }
    const parsedOrigin = a.origin === undefined ? undefined : finitePoint(a.origin);
    if (a.origin !== undefined && parsedOrigin === null) return { ok: false, error: 'origin 需要 {x,y,z} 三个有限数字' };
    const space = a.space ?? 'horizontal';
    if (space !== 'horizontal' && space !== 'euclidean') return { ok: false, error: 'space 必须是 horizontal 或 euclidean' };
    if (a.includeArchived !== undefined && typeof a.includeArchived !== 'boolean') return { ok: false, error: 'includeArchived 必须是 boolean' };
    const ints = { maxFragments: [1, 1000, 1000], maxDistance: [1, 10000, undefined], maxGap: [2, 32, 8], limit: [1, 50, 10] } as const;
    const nums: Partial<Record<keyof typeof ints, number>> = {};
    for (const [key, [min, max, fallback]] of Object.entries(ints) as [keyof typeof ints, readonly [number, number, number | undefined]][]) {
      const v = a[key] ?? fallback;
      if (v === undefined) continue;
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) return { ok: false, error: `${key} 必须是 ${min}-${max} 的整数` };
      nums[key] = v as number;
    }
    return { ok: true, args: {
      metric: metric as Metric,
      ...(a.dim === undefined ? {} : { dim: a.dim as string }),
      ...(Array.isArray(kinds) ? { kinds: kinds as PathFragment['kind'][] } : {}),
      ...(parsedOrigin === null || parsedOrigin === undefined ? {} : { origin: parsedOrigin }),
      space,
      includeArchived: a.includeArchived !== false,
      ...nums,
    } };
  },
  async run(ctx, args) {
    if (ctx.signal.aborted) return { status: 'cancelled', summary: '空间极值查询已取消', data: { reason: 'aborted' } };
    if (Date.now() >= ctx.deadline) return fail('TIMEOUT', 'spatial_extrema 超过调用期限', { reason: 'deadline_exceeded' });
    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'spatial_extrema 需要宿主共享空间会话（ctx.spatial）', { reason: 'spatial_session_unavailable' });
    if (spatial.closing) return fail('ERROR', '共享空间会话正在关闭，未执行查询', { reason: 'spatial_session_closing' });
    if (spatial.session.lifecycle !== 'open') return fail('ERROR', '共享空间会话不在 open 生命周期，未执行查询', { reason: 'spatial_session_not_open' });

    const state = ctx.adapter.state();
    const dim = args.dim ?? state.dim;
    const needsOrigin = args.metric === 'farthest' || args.metric === 'explored' || args.maxDistance !== undefined;
    const origin = needsOrigin ? args.origin ?? (dim === state.dim ? state.pos : null) : args.origin ?? null;
    if (needsOrigin && origin === null) {
      return fail('BAD_ARGS', `跨维度查询 ${args.metric}${args.maxDistance === undefined ? '' : ' + maxDistance'} 需要显式 origin；当前位置属于另一个维度`, { dim, currentDim: state.dim });
    }
    const space = args.space ?? 'horizontal';
    const envelope = { status: 'ok', metric: args.metric, dim, origin: origin === null ? null : { ...origin }, space, readOnly: true, executable: false, evidence: 'historical', currentPassability: 'UNKNOWN' };

    if (args.metric === 'explored') {
      const visits = spatial.session.ledger.chunkVisits(dim);
      const facts = exploredFacts(visits, origin!);
      const sectors = Object.entries(facts.sectors).map(([dir, s]) => `${dir} 最远 ${s.farthest!.distance} 格${s.nearestEdge ? `、最近边缘 ${s.nearestEdge.distance} 格` : ''}`);
      return ok(`${dim} 记录里访问过 ${facts.visitedChunks} 个区块${sectors.length ? `：${sectors.join('；')}` : ''}；只是访问记录，不代表区块里看全了；往哪去由你决定`, { ...envelope, evidence: 'chunk_visits', ...facts });
    }

    const scan = pageFragments(spatial, {
      dim,
      kinds: args.kinds ?? [...KINDS],
      maxFragments: args.maxFragments ?? 1000,
      signal: ctx.signal,
      deadline: ctx.deadline,
    });
    const archivedSkipped = args.includeArchived === false ? scan.items.filter((f) => fragmentArchivedAt(f) !== undefined).length : 0;
    const fragments = args.includeArchived === false ? scan.items.filter((f) => fragmentArchivedAt(f) === undefined) : scan.items;
    const scanned = { fragments: scan.items.length, pages: scan.pages, archived: scan.items.filter((f) => fragmentArchivedAt(f) !== undefined).length, archivedSkipped };
    const truncated = scan.truncated || scan.partial;

    if (args.metric === 'gaps') {
      const graph = buildPathGraph(fragments);
      const { componentOf, sizes } = pathComponents(graph);
      const found = pathGaps(graph, componentOf, args.maxGap ?? 8, Math.min(ctx.deadline, Date.now() + 3000));
      const fragmentsOf = new Map<string, Set<string>>();
      for (const [k, comp] of componentOf) (fragmentsOf.get(comp) ?? fragmentsOf.set(comp, new Set()).get(comp)!).add(graph.fragmentOf.get(k)!);
      const side = (comp: string) => ({ cells: sizes.get(comp)!, fragments: [...fragmentsOf.get(comp)!].slice(0, 4) });
      const gaps = found.gaps
        .map((g) => ({ ...g, fromOrigin: origin === null ? null : round1(Math.min(distance(g.a, origin, space), distance(g.b, origin, space))) }))
        .filter((g) => args.maxDistance === undefined || g.fromOrigin! <= args.maxDistance)
        .slice(0, args.limit ?? 10)
        .map((g) => ({
          a: { ...g.a }, b: { ...g.b }, distance: round1(g.distance), delta: { dx: g.b.x - g.a.x, dy: g.b.y - g.a.y, dz: g.b.z - g.a.z },
          ...(g.fromOrigin === null ? {} : { fromOrigin: g.fromOrigin }), sideA: side(g.componentA), sideB: side(g.componentB),
        }));
      const label = gaps.length
        ? `记录路径分成 ${sizes.size} 片；最近的断开处：${gaps.slice(0, 3).map((g) => `${at(g.a)}↔${at(g.b)} 相距 ${g.distance} 格`).join('；')}`
        : `记录路径分成 ${sizes.size} 片，相距 ${args.maxGap ?? 8} 格以内${args.maxDistance === undefined ? '' : `、离原点 ${args.maxDistance} 格内`}没有断开处`;
      return ok(`${label}；只是记录里没连上，中间实际是什么要看当前方块；连不连、怎么连由你决定`, {
        ...envelope, gaps, components: sizes.size, graph: graph.stats, complete: found.complete, scanned, truncated, partial: scan.partial,
      });
    }

    let withoutPolyline = 0;
    let best: ExtremaBest | null = null;
    let bestValue = args.metric === 'deepest' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const inRange = (p: Vec3Like) => args.maxDistance === undefined || distance(p, origin!, space) <= args.maxDistance;
    for (const fragment of fragments) {
      if (fragment.polyline.length === 0) { withoutPolyline += 1; continue; }
      const points = recordedPoints(fragment).filter(inRange);
      if (points.length === 0) continue;
      if (args.metric === 'deepest') {
        const lowest = points.reduce((winner, point) => point.y < winner.y ? point : winner);
        // 限定范围时 deepestY 可能在范围外，只按范围内的点比较
        const value = args.maxDistance === undefined ? Math.min(fragment.deepestY, lowest.y) : lowest.y;
        if (value < bestValue || (value === bestValue && best !== null && fragment.id < best.fragment.id)) {
          bestValue = value;
          best = { kind: 'deepest', point: { ...lowest }, pointY: lowest.y, deepestY: fragment.deepestY, value, fragment: fragmentFacts(fragment) };
        }
      } else {
        const farthest = points.reduce((winner, point) => distance(point, origin!, space) > distance(winner, origin!, space) ? point : winner);
        const value = distance(farthest, origin!, space);
        if (value > bestValue || (value === bestValue && best !== null && fragment.id < best.fragment.id)) {
          bestValue = value;
          best = { kind: 'farthest', point: { ...farthest }, distance: value, origin: { ...origin! }, space, fragment: fragmentFacts(fragment) };
        }
      }
    }
    const data = { ...envelope, best, scanned: { ...scanned, withoutPolyline }, truncated, partial: scan.partial };
    const range = args.maxDistance === undefined ? '' : `离原点 ${args.maxDistance} 格内`;
    const label = args.metric === 'deepest'
      ? (best === null || best.kind !== 'deepest'
        ? `${range}没有找到符合条件的最深记录点`
        : `${range}最深记录脚点 ${at(best.point)}${args.maxDistance === undefined && best.deepestY < best.point.y ? `；记录里还有更低观测 y=${best.deepestY}（未保留为脚点）` : ''}，fragment ${best.fragment.id}${best.fragment.archived ? '（旧运行时归档）' : ''}`)
      : (best === null || best.kind !== 'farthest'
        ? `${range}没有找到符合条件的最远记录点`
        : `${range}最远记录点 ${at(best.point)}，距原点 ${best.distance.toFixed(1)} 格，fragment ${best.fragment.id}`);
    return ok(`${label}；历史记录，不代表当前可通行；是否前往由你决定（沿记录走可用 travel_to 的 via:{"fragment":id}）`, data);
  },
};
