import type { Vec3Like } from '../adapter/types.ts';
import { fail, finitePoint, obj, ok, type Skill } from './types.ts';

/**
 * 只保留探索范围事实（已访问区块的八方位范围与边缘）。
 * deepest/farthest/gaps 曾从历史路径片段读取几何；路线片段读面已退役，
 * 这些 metric 不再可用，传入会返回 BAD_ARGS，而不是用空结果冒充无记录。
 */
const METRICS = ['explored'] as const;
type Metric = typeof METRICS[number];

interface ExtremaArgs {
  metric: Metric;
  dim?: string;
  origin?: Vec3Like;
}

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
  description: '只读统计共享空间记忆里的访问范围：explored 返回已访问区块的八方位范围与边缘；返回事实，不代表区块里看全了。旧 deepest/farthest/gaps（历史路径片段几何）已随路线片段读面退役，传入会返回 BAD_ARGS。',
  argsDoc: '{"metric":"explored","dim"?:"维度（默认当前）","origin"?:{x,y,z}（默认当前脚位；跨维度必须显式给）}；只读，不选目标、不执行；导航用 navigate_to/advance。',
  timeoutMs: 5000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['metric', 'dim', 'origin']);
    const unknown = Object.keys(a).filter((key) => !allowed.has(key));
    if (unknown.length) return { ok: false, error: `spatial_extrema 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const metric = a.metric;
    if (!METRICS.includes(metric as Metric)) {
      const retired = metric === 'deepest' || metric === 'farthest' || metric === 'gaps'
        ? `metric:"${String(metric)}" 已退役：历史路径片段几何不再作为查询面；`
        : '';
      return { ok: false, error: `${retired}metric 只支持 explored` };
    }
    if (a.dim !== undefined && (typeof a.dim !== 'string' || a.dim.length === 0)) return { ok: false, error: 'dim 必须是非空字符串' };
    const parsedOrigin = a.origin === undefined ? undefined : finitePoint(a.origin);
    if (a.origin !== undefined && parsedOrigin === null) return { ok: false, error: 'origin 需要 {x,y,z} 三个有限数字' };
    return { ok: true, args: {
      metric: metric as Metric,
      ...(a.dim === undefined ? {} : { dim: a.dim as string }),
      ...(parsedOrigin === null || parsedOrigin === undefined ? {} : { origin: parsedOrigin }),
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
    const origin = args.origin ?? (dim === state.dim ? state.pos : null);
    if (origin === null) return fail('BAD_ARGS', `跨维度查询 explored 需要显式 origin；当前位置属于另一个维度`, { dim, currentDim: state.dim });
    const envelope = { status: 'ok', metric: args.metric, dim, origin: { ...origin }, readOnly: true, executable: false, evidence: 'chunk_visits', currentPassability: 'UNKNOWN' };
    const visits = spatial.session.ledger.chunkVisits(dim);
    const facts = exploredFacts(visits, origin);
    const sectors = Object.entries(facts.sectors).map(([dir, s]) => `${dir} 最远 ${s.farthest!.distance} 格${s.nearestEdge ? `、最近边缘 ${s.nearestEdge.distance} 格` : ''}`);
    return ok(`${dim} 记录里访问过 ${facts.visitedChunks} 个区块${sectors.length ? `：${sectors.join('；')}` : ''}；只是访问记录，不代表区块里看全了；往哪去由你决定`, { ...envelope, ...facts });
  },
};
