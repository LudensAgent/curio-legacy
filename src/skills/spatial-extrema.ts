import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import { fragmentArchivedAt, pageFragments } from '../spatial/fragments.ts';
import { fail, finitePoint, obj, ok, type Skill } from './types.ts';

const KINDS = ['dug', 'walked', 'bridge', 'built'] as const;

interface ExtremaArgs {
  metric: 'deepest' | 'farthest';
  dim?: string;
  kinds?: PathFragment['kind'][];
  origin?: Vec3Like;
  space?: 'horizontal' | 'euclidean';
  includeArchived?: boolean;
  maxFragments?: number;
}

const distance = (a: Vec3Like, b: Vec3Like, space: 'horizontal' | 'euclidean') =>
  space === 'horizontal' ? Math.hypot(a.x - b.x, a.z - b.z) : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const fragmentFacts = (fragment: PathFragment) => ({
  id: fragment.id,
  kind: fragment.kind,
  geometrySource: fragment.geometrySource,
  deepestY: fragment.deepestY,
  createdAt: fragment.createdAt,
  lastUsedAt: fragment.lastUsedAt,
  uses: fragment.uses,
  ...(fragment.externalRef === undefined ? {} : { externalRef: fragment.externalRef }),
  ...(fragment.entrances.length ? { entrances: fragment.entrances.map((p) => ({ ...p })) } : {}),
});

type FragmentFacts = ReturnType<typeof fragmentFacts>;
type ExtremaBest =
  | { kind: 'deepest'; point: Vec3Like; pointY: number; deepestY: number; value: number; fragment: FragmentFacts }
  | { kind: 'farthest'; point: Vec3Like; distance: number; origin: Vec3Like; space: 'horizontal' | 'euclidean'; fragment: FragmentFacts };

export const spatialExtrema: Skill<ExtremaArgs> = {
  name: 'spatial_extrema',
  description: '只读查询共享空间记忆里挖过/走过的最深点或离给定原点最远的记录点；返回历史几何事实，不代表当前可通行。',
  argsDoc: '{"metric":"deepest|farthest","dim"?:"维度（默认当前）","kinds"?:["dug"|"walked"|"bridge"|"built"]（默认 dug+walked）,"origin"?:{x,y,z}（farthest 用；跨维度必须显式给）,"space"?:"horizontal|euclidean"（默认 horizontal）,"includeArchived"?:false,"maxFragments"?:1-1000}；只读，不选目标、不执行。',
  timeoutMs: 5000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const metric = a.metric;
    if (metric !== 'deepest' && metric !== 'farthest') return { ok: false, error: 'metric 必须是 deepest 或 farthest' };
    if (a.dim !== undefined && (typeof a.dim !== 'string' || a.dim.length === 0)) return { ok: false, error: 'dim 必须是非空字符串' };
    const kinds = a.kinds;
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => !KINDS.includes(kind)))) {
      return { ok: false, error: `kinds 必须是 ${KINDS.join('|')} 的数组` };
    }
    const parsedOrigin = a.origin === undefined ? undefined : finitePoint(a.origin);
    if (a.origin !== undefined && parsedOrigin === null) return { ok: false, error: 'origin 需要 {x,y,z} 三个有限数字' };
    const space = a.space ?? 'horizontal';
    if (space !== 'horizontal' && space !== 'euclidean') return { ok: false, error: 'space 必须是 horizontal 或 euclidean' };
    if (a.includeArchived !== undefined && typeof a.includeArchived !== 'boolean') return { ok: false, error: 'includeArchived 必须是 boolean' };
    const maxFragments = a.maxFragments ?? 1000;
    if (!Number.isInteger(maxFragments) || maxFragments < 1 || maxFragments > 1000) return { ok: false, error: 'maxFragments 必须是 1-1000 的整数' };
    return { ok: true, args: {
      metric,
      ...(a.dim === undefined ? {} : { dim: a.dim as string }),
      ...(Array.isArray(kinds) ? { kinds: kinds as PathFragment['kind'][] } : {}),
      ...(parsedOrigin === null || parsedOrigin === undefined ? {} : { origin: parsedOrigin }),
      space,
      ...(a.includeArchived === true ? { includeArchived: true } : {}),
      maxFragments,
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
    const origin = args.metric === 'farthest' ? args.origin ?? (dim === state.dim ? state.pos : null) : null;
    if (args.metric === 'farthest' && origin === null) {
      return fail('BAD_ARGS', '跨维度查询最远记录点需要显式 origin；当前位置属于另一个维度', { dim, currentDim: state.dim });
    }
    const space = args.space ?? 'horizontal';
    const scan = pageFragments(spatial, {
      dim,
      kinds: args.kinds ?? ['dug', 'walked'],
      maxFragments: args.maxFragments ?? 1000,
      signal: ctx.signal,
      deadline: ctx.deadline,
    });

    let withoutPolyline = 0, archivedSkipped = 0;
    let best: ExtremaBest | null = null;
    let bestValue = args.metric === 'deepest' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (const fragment of scan.items) {
      if (!args.includeArchived && fragmentArchivedAt(fragment) !== undefined) { archivedSkipped += 1; continue; }
      if (fragment.polyline.length === 0) { withoutPolyline += 1; continue; }
      if (args.metric === 'deepest') {
        const lowest = fragment.polyline.reduce((winner, point) => point.y < winner.y ? point : winner);
        const value = Math.min(fragment.deepestY, lowest.y);
        if (value < bestValue || (value === bestValue && best !== null && fragment.id < best.fragment.id)) {
          bestValue = value;
          best = {
            kind: 'deepest',
            point: { ...lowest },
            pointY: lowest.y,
            deepestY: fragment.deepestY,
            value,
            fragment: fragmentFacts(fragment),
          };
        }
      } else if (origin !== null) {
        const farthest = fragment.polyline.reduce((winner, point) => distance(point, origin, space) > distance(winner, origin, space) ? point : winner);
        const value = distance(farthest, origin, space);
        if (value > bestValue || (value === bestValue && best !== null && fragment.id < best.fragment.id)) {
          bestValue = value;
          best = {
            kind: 'farthest',
            point: { ...farthest },
            distance: value,
            origin: { ...origin },
            space,
            fragment: fragmentFacts(fragment),
          };
        }
      }
    }
    const data = {
      status: 'ok',
      metric: args.metric,
      dim,
      origin: origin === null ? null : { ...origin },
      space,
      best,
      scanned: { fragments: scan.items.length, pages: scan.pages, withoutPolyline, archivedSkipped },
      truncated: scan.truncated || scan.partial,
      partial: scan.partial,
      readOnly: true,
      executable: false,
      evidence: 'historical',
      currentPassability: 'UNKNOWN',
    };
    const label = args.metric === 'deepest'
      ? (best === null || best.kind !== 'deepest'
        ? '没有找到符合条件的最深记录点'
        : `最深记录脚点 (${Math.floor(best.point.x)},${best.point.y},${Math.floor(best.point.z)})${best.deepestY < best.point.y ? `；记录里还有更低观测 y=${best.deepestY}（未保留为脚点）` : ''}，fragment ${best.fragment.id}`)
      : (best === null || best.kind !== 'farthest'
        ? '没有找到符合条件的最远记录点'
        : `最远记录点 (${Math.floor(best.point.x)},${best.point.y},${Math.floor(best.point.z)})，距原点 ${best.distance.toFixed(1)} 格，fragment ${best.fragment.id}`);
    return ok(`${label}；历史记录，不代表当前可通行；是否前往由你决定`, data);
  },
};
