import { GROUNDED_ARRIVAL_DEFAULTS, startKnownWalkRoute, type NavResult, type WalkRouteRequest } from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../../adapter/walk-route.ts';
import { bodyLocalCells, observeCells } from '../walk-route.ts';
import { fail, ok, obj, type Skill, type SkillResult } from '../types.ts';
import { getRouteRecord } from './route.ts';

const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };

type WalkArgs = { routeId: string; deadlineMs?: number };

const navData = (routeId: string, record: NonNullable<ReturnType<typeof getRouteRecord>>, nav: NavResult) => ({
  routeId,
  routeKind: record.kind,
  pathId: record.kind === 'known' ? record.pathId : null,
  backend: record.kind === 'snapshot' ? 'spatial_library' : 'spatial_library_known',
  outcome: nav.outcome,
  confirmed: nav.confirmed,
  message: nav.message,
  position: nav.lastPosition ?? null,
  lastObservation: nav.lastObservation ?? null,
  trace: nav.trace,
  problem: nav.problem ?? null,
  memoryWrite: nav.memoryWrite ?? null,
});

function navToResult(routeId: string, record: NonNullable<ReturnType<typeof getRouteRecord>>, nav: NavResult): SkillResult {
  const data = navData(routeId, record, nav);
  if (nav.outcome === 'ARRIVED') return ok(nav.message, data);
  if (nav.outcome === 'CANCELLED') return { status: 'cancelled', summary: nav.message, data };
  if (nav.outcome === 'PARTIAL') return fail('EFFECT_NOT_CONFIRMED', nav.message, data);
  if (nav.outcome === 'TIMEOUT') return fail('TIMEOUT', nav.message, data);
  if (nav.outcome === 'NO_PATH' || nav.outcome === 'BLOCKED') return fail('PATH_NOT_FOUND', nav.message, data);
  return fail('ERROR', nav.message, data);
}

/**
 * 执行 plan_route 返回的 routeId。只沿已规划路线走：不重新搜索、不换路、不挖/垫。
 * 使用现有的 WalkRouteExecutor 身体桥（runWalkRoute），到达由库的实测 BodySample
 * 与 bodyArrival 容差确认；路线失效/取消保留实测位置与 trace。
 */
export const walkPath: Skill<WalkArgs> = {
  name: 'walk_path',
  description: '执行 plan_route 返回的 routeId。只沿已规划路线走，不重新搜索、不换路、不挖/垫/搭柱；每段按当前证据复验，证据失效即停并返回 INVALIDATED。ARRIVED 必须由实测身体位置确认；PARTIAL 只表示部分进展，不是到达。',
  argsDoc: '{"routeId":"plan_route 返回的 routeId", "deadlineMs"?:绝对 epoch 毫秒}；只接受这两个参数。需要适配器的 walkBody/walkTick 和共享空间会话；路线过期/作用域不符/起点改变时拒绝执行。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const unknown = Object.keys(a).filter((k) => !['routeId', 'deadlineMs'].includes(k));
    if (unknown.length) return { ok: false, error: `walk_path 不认识参数 ${unknown.join('、')}；只接受 routeId、deadlineMs` };
    if (typeof a.routeId !== 'string' || !a.routeId.trim()) return { ok: false, error: 'routeId 需要 plan_route 返回的非空 ID' };
    if (a.deadlineMs !== undefined && (typeof a.deadlineMs !== 'number' || !Number.isFinite(a.deadlineMs) || a.deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { routeId: a.routeId, ...(a.deadlineMs !== undefined ? { deadlineMs: a.deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const record = getRouteRecord(args.routeId);
    if (!record) return fail('BAD_ARGS', `routeId ${args.routeId} 不存在或已过期；重新 plan_route`, { unsupported: { reason: 'unknown_or_expired_route' } });
    const spatial = ctx.spatial;
    if (!spatial) return fail('NOT_CONNECTED', 'walk_path 需要宿主共享空间会话（ctx.spatial）', { routeId: args.routeId });
    const state = ctx.adapter.state();
    if (record.scope.worldId !== state.worldId || record.scope.dim !== state.dim || record.scope.sessionId !== state.sessionId) {
      return fail('WRONG_DIMENSION', '路线作用域与当前世界/维度/会话不符；重新 plan_route', { routeId: args.routeId, scope: record.scope });
    }
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', `当前世界 ${state.worldId} 与空间会话 ${spatial.worldId} 不一致`, { routeId: args.routeId });
    if (spatial.closing || spatial.paused || !spatial.observationAdmitted) return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能执行路线', { routeId: args.routeId });
    if (Math.hypot(state.pos.x - record.from.x, state.pos.z - record.from.z) > 2 || Math.abs(state.pos.y - record.from.y) > 2) {
      return fail('PATH_NOT_FOUND', `路线起点 (${record.from.x},${record.from.y},${record.from.z}) 与当前站位不符；重新 plan_route`, { routeId: args.routeId, from: record.from, position: state.pos, unsupported: { reason: 'route_start_changed' } });
    }
    const body = ctx.adapter.walkBody?.();
    const tick = ctx.adapter.walkTick?.();
    if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）', { routeId: args.routeId });
    const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    if (Date.now() >= deadline) return fail('TIMEOUT', 'walk_path 期限在开始前已耗尽', { routeId: args.routeId });
    const map = spatial.session.voxel;
    const points = record.kind === 'known' ? record.points : record.snapshot.candidate?.points;
    if (!points || points.length === 0) return fail('ERROR', `路线 ${args.routeId} 没有可执行点列；重新 plan_route`, { routeId: args.routeId });
    const request: WalkRouteRequest = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk',
      body: { feet: { ...record.from }, ...BODY },
      points: points.map((p) => ({ ...p })),
      arrival: { kind: 'exact' },
      bodyArrival: GROUNDED_ARRIVAL_DEFAULTS,
      shapeProvider: walkCollisionProvider,
      deadlineMs: deadline,
      timeoutMs: Math.max(1, Math.min(4000, deadline - Date.now())),
    };
    const detachRef: { fn: (() => void) | null } = { fn: null };
    try {
      const nav = await runWalkRoute({
        map, body, tick, request, signal: ctx.signal, deadlineMs: deadline,
        lifecycle: () => {
          const s = ctx.adapter.state();
          return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
        },
        observe: () => observeCells(ctx, map, bodyLocalCells(ctx.adapter.state().pos)),
        bindActive: (loop) => {
          const token = spatial.attach({
            receiver: (report) => loop.observe(report, 64),
            cancel: () => loop.cancel('lifecycle', 'shared spatial session interrupted the active walk_path'),
          });
          detachRef.fn = () => spatial.detach(token);
          return () => { detachRef.fn?.(); detachRef.fn = null; };
        },
        ...(record.kind === 'known' ? {
          starter: (loop, startRequest) => {
            const { points: _ignored, ...rest } = startRequest;
            return startKnownWalkRoute(spatial.session.history, loop, { ...rest, pathId: record.pathId });
          },
        } : {}),
      });
      if (ctx.signal.aborted && nav.outcome !== 'CANCELLED') {
        return { status: 'cancelled', summary: 'walk_path 被父任务取消', data: navData(args.routeId, record, nav) };
      }
      return navToResult(args.routeId, record, nav);
    } finally {
      detachRef.fn?.();
    }
  },
};
