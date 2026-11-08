import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import { fragmentRecord } from '../memory/spatial-backend.ts';
import { passageRouteInspection, type PassageRouteInspection, type PassageTransition } from '../memory/passages.ts';
import { fragmentArchivedAt, pageFragments } from '../spatial/fragments.ts';
import { fail, finitePoint, obj, ok, type Skill } from './types.ts';

const TRANSITIONS: readonly PassageTransition[] = ['walk', 'step', 'drop', 'climb'];

interface MemoryRouteArgs {
  to: Vec3Like;
  from?: Vec3Like;
  allowed?: PassageTransition[];
  snapRadius?: number;
  maxWaypoints?: number;
  heal?: boolean;
  maxPoints?: number;
}

/** 实测脚点没有 links 时，用连续点补真实相邻边；不跨越 1.5 格以上的缺口。 */
const synthesizedLinks = (polyline: readonly Vec3Like[]) => polyline.slice(1).flatMap((point, index) => {
  const a = polyline[index]!;
  return Math.hypot(point.x - a.x, point.y - a.y, point.z - a.z) <= 1.5
    ? [{ a: { ...a }, b: { ...point } }]
    : [];
});

type MemoryRouteGapReason = NonNullable<PassageRouteInspection['reason']> | 'truncated';

const reasonText = (reason: MemoryRouteGapReason | undefined) => {
  switch (reason) {
    case 'from_far_from_records': return '起点离记录通道太远';
    case 'to_far_from_records': return '目标离记录通道太远';
    case 'disconnected': return '记录通道不连通';
    case 'disallowed_transition': return '路线需要你未允许的移动方式';
    case 'truncated': return '路线超过 maxWaypoints';
    case 'empty': return '没有可用的历史通道';
    default: return reason ?? '没有可用路线';
  }
};

export const planMemoryRoute: Skill<MemoryRouteArgs> = {
  name: 'plan_memory_route',
  description: '只读历史路线规划：在共享空间记忆的挖/走/桥通道图上找 from→to 的稀疏路点，返回每段 transition/可逆性/证据或结构化缺口；不执行、不挖、不放、不搭柱。',
  argsDoc: '{"to":{x,y,z},"from"?:{x,y,z}（默认当前脚位）,"allowed"?：["walk"|"step"|"drop"|"climb"]（默认 walk+step，drop/climb 需显式允许）,"snapRadius"?:0-16（默认5）,"maxWaypoints"?:1-1024,"heal"?:false（显式允许跨记录近距自愈）,"maxPoints"?:1-500000}；历史几何，未验证当前可通行；不执行。',
  timeoutMs: 15000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const to = finitePoint(a.to);
    if (to === null) return { ok: false, error: 'to 需要 {x,y,z} 三个有限数字' };
    const from = a.from === undefined ? undefined : finitePoint(a.from);
    if (a.from !== undefined && from === null) return { ok: false, error: 'from 需要 {x,y,z} 三个有限数字' };
    const allowedRaw = a.allowed;
    if (allowedRaw !== undefined && (!Array.isArray(allowedRaw) || allowedRaw.some((item) => !TRANSITIONS.includes(item)))) {
      return { ok: false, error: `allowed 必须是 ${TRANSITIONS.join('|')} 的数组` };
    }
    const snapRadius = a.snapRadius ?? 5;
    if (typeof snapRadius !== 'number' || !Number.isFinite(snapRadius) || snapRadius < 0 || snapRadius > 16) return { ok: false, error: 'snapRadius 必须是 0-16 的数字' };
    const maxWaypoints = a.maxWaypoints ?? 1024;
    if (!Number.isInteger(maxWaypoints) || maxWaypoints < 1 || maxWaypoints > 1024) return { ok: false, error: 'maxWaypoints 必须是 1-1024 的整数' };
    if (a.heal !== undefined && typeof a.heal !== 'boolean') return { ok: false, error: 'heal 必须是 boolean' };
    const maxPoints = a.maxPoints ?? 200_000;
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 500_000) return { ok: false, error: 'maxPoints 必须是 1-500000 的整数' };
    return { ok: true, args: {
      to,
      ...(from === null || from === undefined ? {} : { from }),
      ...(Array.isArray(allowedRaw) ? { allowed: allowedRaw as PassageTransition[] } : {}),
      snapRadius, maxWaypoints,
      ...(a.heal === true ? { heal: true } : {}),
      maxPoints,
    } };
  },
  async run(ctx, args) {
    if (ctx.signal.aborted) return { status: 'cancelled', summary: '历史路线查询已取消', data: { reason: 'aborted' } };
    if (Date.now() >= ctx.deadline) return fail('TIMEOUT', 'plan_memory_route 超过调用期限', { reason: 'deadline_exceeded' });
    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'plan_memory_route 需要宿主共享空间会话（ctx.spatial）', { reason: 'spatial_session_unavailable' });
    if (spatial.closing) return fail('ERROR', '共享空间会话正在关闭，未执行规划', { reason: 'spatial_session_closing' });
    if (spatial.session.lifecycle !== 'open') return fail('ERROR', '共享空间会话不在 open 生命周期，未执行规划', { reason: 'spatial_session_not_open' });

    const state = ctx.adapter.state();
    const dim = state.dim;
    const from = args.from ?? state.pos;
    const scan = pageFragments(spatial, { dim, maxFragments: 1000, signal: ctx.signal, deadline: ctx.deadline });
    const records: ReturnType<typeof fragmentRecord>[] = [];
    const maxPoints = args.maxPoints ?? 200_000;
    let points = 0, archivedSkipped = 0;
    let truncated = scan.truncated || scan.partial;
    for (const fragment of scan.items) {
      if (fragmentArchivedAt(fragment) !== undefined) { archivedSkipped += 1; continue; }
      if (points + fragment.polyline.length > maxPoints) { truncated = true; break; }
      points += fragment.polyline.length;
      const record = fragmentRecord(fragment);
      const links = record.links?.length
        ? record.links
        : fragment.geometrySource === 'traversal' || fragment.kind === 'dug'
          ? synthesizedLinks(fragment.polyline)
          : undefined;
      records.push({ ...record, ...(links && links.length ? { links } : {}) });
    }

    const allowed = args.allowed ?? ['walk', 'step'];
    const inspection = passageRouteInspection(records, from, args.to, {
      near: args.snapRadius ?? 5,
      heal: args.heal ?? false,
      allowed,
    });
    const maxWaypoints = args.maxWaypoints ?? 1024;
    const overLimit = inspection.status === 'route' && inspection.waypoints.length > maxWaypoints;
    if (overLimit) truncated = true;
    const status = overLimit ? 'gap' : inspection.status;
    const reason: MemoryRouteGapReason | undefined = overLimit ? 'truncated' : inspection.reason;
    const waypoints = overLimit ? [] : inspection.waypoints;
    const legs = overLimit ? [] : inspection.legs;
    const data = {
      status, ...(reason === undefined ? {} : { reason }),
      source: 'shared_fragments', dim,
      from: { ...from }, to: { ...args.to },
      allowed,
      waypoints, legs,
      ...(inspection.nearest === undefined ? {} : { nearest: inspection.nearest }),
      ...(inspection.rejectedLeg === undefined ? {} : { rejectedLeg: inspection.rejectedLeg }),
      snapRadius: inspection.near,
      snapped: inspection.snapped,
      heal: inspection.heal,
      truncated,
      scanned: {
        fragments: records.length, fetched: scan.items.length, pages: scan.pages,
        points, truncated: scan.truncated, partial: scan.partial, archivedSkipped,
      },
      historical: true,
      executable: false,
      currentPassability: 'UNKNOWN',
    };
    const end = waypoints.at(-1);
    const truncatedNote = truncated ? '；本次扫描/图规模已截断，结果可能不完整' : '';
    const summary = status === 'route'
      ? `历史路线 ${legs.length} 段、${waypoints.length} 个路点${end === undefined ? '' : `，终点 (${Math.floor(end.x)},${end.y},${Math.floor(end.z)})`}${truncatedNote}。这是历史几何，未验证当前可通行；执行和复核由你决定。`
      : `没有可用的历史路线：${reasonText(reason)}${inspection.nearest === undefined ? '' : `；最近可达 (${Math.floor(inspection.nearest.x)},${inspection.nearest.y},${Math.floor(inspection.nearest.z)})`}${truncatedNote}。这是历史几何事实，未验证当前可通行；是否绕路/挖/垫由你决定。`;
    return ok(summary, data);
  },
};
