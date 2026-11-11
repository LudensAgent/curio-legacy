import type { SectionKey } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import type { SharedSpatialSession } from '../spatial/shared-session.ts';
import { acquireRouteResidency, releaseRouteResidency } from '../spatial/skill-residency.ts';
import { fail, finitePoint, obj, ok, type Skill } from './types.ts';

/**
 * 空间记忆里的只读统计事实：
 * - explored：已访问区块的八方位范围与边缘（chunk_visits）
 * - deepest：身体实际站过的最低脚格（体素的 traversed 标记，例如以前挖过、走过的矿道最深处）
 * farthest/gaps 曾从历史路径片段读取几何；路线片段读面已退役，传入会返回 BAD_ARGS。
 */
const METRICS = ['explored', 'deepest'] as const;
type Metric = typeof METRICS[number];

interface ExtremaArgs {
  metric: Metric;
  dim?: string;
  origin?: Vec3Like;
  /** deepest 的水平查找半径（格）。 */
  radius?: number;
}

/** deepest 默认/最大水平半径；一次调用最多读这么多个区段，每批加载这么多个。 */
const DEEPEST_DEFAULT_RADIUS = 128, DEEPEST_MAX_RADIUS = 512, DEEPEST_MAX_SECTIONS = 512, DEEPEST_BATCH = 64;

/**
 * 在体素的到访标记（身体实际站过的脚格）里找最低的一格：按区段高度从低到高逐层读，某一层找到就停。
 * 存盘但未驻留的区段按需显式加载、用完释放；读不到的区段如实计数。同一高度取离 origin 最近的。
 */
async function deepestTraversed(
  spatial: SharedSpatialSession, dim: string, origin: Vec3Like, radius: number, signal: AbortSignal, deadline: number,
) {
  const voxel = spatial.session.voxel;
  const near = (k: SectionKey) => Math.hypot(k.cx * 16 + 8 - origin.x, k.cz * 16 + 8 - origin.z) <= radius + 12;
  const keys = new Map<string, SectionKey>();
  const add = (k: SectionKey) => { if (k.dim === dim && near(k)) keys.set(`${k.cx},${k.cz},${k.sy}`, k); };
  voxel.residentSectionKeys().forEach(add);
  if (spatial.session.voxelLoading === 'manual') {
    let after: number | undefined;
    do {
      const page = voxel.directoryPage({ ...(after === undefined ? {} : { after }), limit: 512 });
      page.items.forEach((item) => add(item.key));
      after = page.nextAfter;
    } while (after !== undefined);
  }
  const levels = [...new Set([...keys.values()].map((k) => k.sy))].sort((a, b) => a - b);
  let best: Vec3Like | null = null;
  let scanned = 0, unreadable = 0, truncated = false;
  for (const sy of levels) {
    const level = [...keys.values()].filter((k) => k.sy === sy);
    for (let i = 0; i < level.length; i += DEEPEST_BATCH) {
      if (signal.aborted || Date.now() >= deadline || scanned >= DEEPEST_MAX_SECTIONS) { truncated = true; break; }
      const batch = level.slice(i, i + DEEPEST_BATCH);
      const residency = await acquireRouteResidency(spatial, batch, { signal, deadline });
      if (residency.status !== 'ready') { unreadable += batch.length; continue; }
      for (const k of batch) {
        scanned++;
        const ref = voxel.sectionRef(dim, k.cx * 16, k.sy * 16, k.cz * 16);
        if (ref === null) continue;
        for (let index = 0; index < 4096; index++) {
          if ((ref.traversed[index >>> 3]! & (1 << (index & 7))) === 0) continue;
          const cell = { x: k.cx * 16 + (index & 15), y: k.sy * 16 + (index >>> 8), z: k.cz * 16 + ((index >>> 4) & 15) };
          if (Math.hypot(cell.x + 0.5 - origin.x, cell.z + 0.5 - origin.z) > radius) continue;
          const closer = best !== null && cell.y === best.y
            && Math.hypot(cell.x - origin.x, cell.z - origin.z) < Math.hypot(best.x - origin.x, best.z - origin.z);
          if (best === null || cell.y < best.y || closer) best = cell;
        }
      }
      releaseRouteResidency(spatial, residency);
    }
    if (best !== null || truncated) break;
  }
  return { deepest: best as Vec3Like | null, candidateSections: keys.size, scannedSections: scanned, unreadableSections: unreadable, truncated };
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
  description: '只读统计共享空间记忆：explored 返回已访问区块的八方位范围与边缘；deepest 返回 radius 内身体实际站过的最低脚格（以前走过、挖过的矿道最深处等），按体素到访标记读取。返回事实，不代表区块里看全了，也不代表那里现在还能走到。farthest/gaps（历史路径片段几何）已退役，传入会返回 BAD_ARGS。',
  argsDoc: '{"metric":"explored|deepest","dim"?:"维度（默认当前）","origin"?:{x,y,z}（默认当前脚位；跨维度必须显式给）,"radius"?:128（deepest 的水平半径，1–512）}；只读，不选目标、不执行；要去那里用 travel_to。',
  // deepest 可能要从存盘加载区段读到访标记。
  timeoutMs: 20000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['metric', 'dim', 'origin', 'radius']);
    const unknown = Object.keys(a).filter((key) => !allowed.has(key));
    if (unknown.length) return { ok: false, error: `spatial_extrema 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const metric = a.metric;
    if (!METRICS.includes(metric as Metric)) {
      const retired = metric === 'farthest' || metric === 'gaps'
        ? `metric:"${String(metric)}" 已退役：历史路径片段几何不再作为查询面；`
        : '';
      return { ok: false, error: `${retired}metric 只支持 explored、deepest` };
    }
    if (a.dim !== undefined && (typeof a.dim !== 'string' || a.dim.length === 0)) return { ok: false, error: 'dim 必须是非空字符串' };
    if (a.radius !== undefined && (!Number.isInteger(a.radius) || (a.radius as number) < 1 || (a.radius as number) > DEEPEST_MAX_RADIUS)) {
      return { ok: false, error: `radius 需要 1–${DEEPEST_MAX_RADIUS} 的整数` };
    }
    const parsedOrigin = a.origin === undefined ? undefined : finitePoint(a.origin);
    if (a.origin !== undefined && parsedOrigin === null) return { ok: false, error: 'origin 需要 {x,y,z} 三个有限数字' };
    return { ok: true, args: {
      metric: metric as Metric,
      ...(a.dim === undefined ? {} : { dim: a.dim as string }),
      ...(parsedOrigin === null || parsedOrigin === undefined ? {} : { origin: parsedOrigin }),
      ...(a.radius === undefined ? {} : { radius: a.radius as number }),
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
    if (origin === null) return fail('BAD_ARGS', `跨维度查询 ${args.metric} 需要显式 origin；当前位置属于另一个维度`, { dim, currentDim: state.dim });
    if (args.metric === 'deepest') {
      const radius = args.radius ?? DEEPEST_DEFAULT_RADIUS;
      const found = await deepestTraversed(spatial, dim, origin, radius, ctx.signal, ctx.deadline);
      const envelope = { status: 'ok', metric: args.metric, dim, origin: { ...origin }, radius, readOnly: true, executable: false, evidence: 'voxel_traversed', currentPassability: 'UNKNOWN' };
      const gaps = `${found.unreadableSections ? `；${found.unreadableSections} 个区段这次读不到` : ''}${found.truncated ? '；没读完全部区段（期限或数量上限），可能还有更深的' : ''}`;
      const d = found.deepest;
      if (d === null) return ok(`${dim} 里 origin 周围 ${radius} 格内没有身体站过的记录（读了 ${found.scannedSections} 个区段）${gaps}`, { ...envelope, ...found });
      return ok(`${dim} 里 origin 周围 ${radius} 格内身体站过的最低脚格是 (${d.x},${d.y},${d.z})，离 origin 水平 ${Math.round(Math.hypot(d.x + 0.5 - origin.x, d.z + 0.5 - origin.z))} 格${gaps}；只是到访记录，不代表现在还能走到；去不去由你决定`, { ...envelope, ...found });
    }
    const envelope = { status: 'ok', metric: args.metric, dim, origin: { ...origin }, readOnly: true, executable: false, evidence: 'chunk_visits', currentPassability: 'UNKNOWN' };
    const visits = spatial.session.ledger.chunkVisits(dim);
    const facts = exploredFacts(visits, origin);
    const sectors = Object.entries(facts.sectors).map(([dir, s]) => `${dir} 最远 ${s.farthest!.distance} 格${s.nearestEdge ? `、最近边缘 ${s.nearestEdge.distance} 格` : ''}`);
    return ok(`${dim} 记录里访问过 ${facts.visitedChunks} 个区块${sectors.length ? `：${sectors.join('；')}` : ''}；只是访问记录，不代表区块里看全了；往哪去由你决定`, { ...envelope, ...facts });
  },
};
