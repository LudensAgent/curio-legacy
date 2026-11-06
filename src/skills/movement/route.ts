import { randomUUID } from 'node:crypto';
import {
  RouteVerifier,
  WalkRouteSearch,
  inspectRoute,
  type PathFragment,
  type RouteStatus,
  type WalkSearchSnapshot,
} from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../../adapter/types.ts';
import { walkCollisionProvider } from '../../adapter/walk-route.ts';
import { throwIfAborted } from '../../util.ts';
import { fail, obj, ok, type Skill, type SkillCtx, type SkillResult } from '../types.ts';

type Scope = { worldId: string; dim: string; sessionId: string };
type RouteSource = 'auto' | 'search' | 'history';
type PlanArgs = {
  to: Vec3Like;
  mode: 'walk';
  source: RouteSource;
  pathId?: string;
  arrival: { kind: 'exact' };
  constraints?: { avoid?: string[]; maxNodes?: number; maxEdges?: number };
  deadlineMs?: number;
};

/** 进程内路线句柄；重启即失效，不持久化。 */
export type RouteRecord =
  | { kind: 'snapshot'; snapshot: WalkSearchSnapshot; scope: Scope; from: Vec3Like; target: Vec3Like; validUntil: number; expiresAt: number }
  | { kind: 'known'; pathId: string; pathKind: PathFragment['kind']; points: Vec3Like[]; scope: Scope; from: Vec3Like; target: Vec3Like; validUntil: number; expiresAt: number; verdict: string };

const records = new Map<string, RouteRecord>();

export function getRouteRecord(routeId: string): RouteRecord | undefined {
  const record = records.get(routeId);
  if (!record) return undefined;
  if (Date.now() > record.expiresAt) { records.delete(routeId); return undefined; }
  return record;
}

export function clearRouteRecords() { records.clear(); }

const finitePoint = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

const distanceXZ = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.z - b.z);

const routeSegments = (points: Vec3Like[]) => [{ index: 0, mode: 'walk' as const, points: points.map((p) => ({ ...p })), cost: Math.max(0, points.length - 1) }];

const problemOf = (status: string, reason: string, extra: Record<string, unknown> = {}): SkillResult => {
  const result = status === 'CANCELLED' ? fail('TIMEOUT', `路线搜索被取消：${reason}`)
    : status === 'BUDGET_EXHAUSTED' ? fail('PATH_NOT_FOUND', `路线搜索预算耗尽：${reason}`)
      : status === 'UNSUPPORTED' ? fail('BAD_ARGS', `路线搜索不支持这个请求：${reason}`)
        : status === 'INSUFFICIENT_EVIDENCE' ? fail('NOT_FOUND', `路线搜索证据不足：${reason}`)
          : fail('PATH_NOT_FOUND', `没有找到可确认的路线：${reason}`);
  return { ...result, data: { ...(result.data ?? {}), ...extra } };
};

/** 历史路线必须能被当前 walk 验证器逐段消费：同高、单轴 ±1。 */
function historyProblem(points: readonly Vec3Like[]): string | null {
  if (points.length < 2) return '历史路线至少需要 2 个点';
  if (points.length > 32) return `历史路线有 ${points.length} 个点，本轮上限 32`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return `第 ${i} 段坐标不是有限数字`;
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1e-9) return `第 ${i} 段改变了高度（y ${a.y} → ${b.y}）；当前 walk 执行器只支持同高路线`;
    const dx = Math.abs(b.x - a.x), dz = Math.abs(b.z - a.z);
    if (Math.abs(dx + dz - 1) > 1e-9 || (dx > 1e-9 && dz > 1e-9)) return `第 ${i} 段不是沿 X 或 Z 单格相邻（dx=${dx}, dz=${dz}）`;
  }
  return null;
}

/**
 * 宿主侧的记录路线召回：空间库还没有 `recall_route`，这里只做有界选择，
 * 不改变几何、不补边、不把历史当作当前可通行。
 * 候选必须是：当前维度、起点在当前站位附近、同高单轴、截到离目标最近的点。
 */
function selectRecordedRoute(
  spatial: NonNullable<SkillCtx['spatial']>,
  state: { worldId: string; dim: string },
  from: Vec3Like,
  to: Vec3Like,
) {
  const page = spatial.session.history.fragments({ dim: state.dim, limit: 64 });
  let best: { fragment: PathFragment; points: Vec3Like[]; score: number; targetIndex: number } | null = null;
  for (const fragment of page.items) {
    if (fragment.worldId !== state.worldId || fragment.polyline.length < 2) continue;
    const start = fragment.polyline[0]!;
    if (distanceXZ(start, from) > 2 || Math.abs(start.y - from.y) > 2) continue;
    let targetIndex = -1, targetDistance = Infinity;
    fragment.polyline.forEach((p, i) => {
      const d = Math.hypot(p.x - to.x, p.y - to.y, p.z - to.z);
      if (d < targetDistance) { targetDistance = d; targetIndex = i; }
    });
    if (targetIndex < 1 || targetDistance > 2) continue;
    const points = fragment.polyline.slice(0, targetIndex + 1).map((p) => ({ ...p }));
    if (historyProblem(points)) continue;
    const score = distanceXZ(start, from) + targetDistance;
    if (!best || score < best.score) best = { fragment, points, score, targetIndex };
  }
  return best;
}

function verifyRecordedRoute(
  spatial: NonNullable<SkillCtx['spatial']>,
  state: { worldId: string; dim: string; sessionId: string },
  start: Vec3Like,
  points: readonly Vec3Like[],
  deadline: number,
  signal: AbortSignal,
): { status: RouteStatus } | { error: string } {
  try {
    const verifier = new RouteVerifier(spatial.session.voxel, { now: Date.now });
    let status = verifier.register({
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk',
      body: { feet: { ...start }, width: 0.6, height: 1.8, pose: 'standing' },
      shapeProvider: walkCollisionProvider,
      points: points.map((p) => ({ ...p })),
    });
    while (status.verdict === 'INCOMPLETE' && Date.now() < deadline) {
      throwIfAborted(signal);
      status = verifier.advance(256);
    }
    return { status };
  } catch (e) {
    if ((e as Error)?.name === 'AbortedError') throw e;
    return { error: (e as Error).message };
  }
}

/**
 * 只读路线规划：空间库搜索/历史复验；不移动、不转头、不观察、不写库。
 * 返回 routeId 供 walk_path 执行；执行器不重新搜索。
 */
export const planRoute: Skill<PlanArgs> = {
  name: 'plan_route',
  description: '只读规划一条步行路线：用空间记忆库的 VoxelMap 做有界 WalkRouteSearch，或读取 Agent 明确指定的历史 fragment（walked/bridge/dug/built）并按当前证据复验。返回 routeId、路点、边界/阻断、置信度和过期时间；不移动、不转头、不观察、不写库。当前只支持 walk、exact 到达、同高 ±X/±Z、干燥整块；其他模式/台阶/下落/水面返回 unsupported，不回退 pathfinder。',
  argsDoc: '{"to":{"x":0,"y":64,"z":0}, "mode"?: "walk", "source"?: "auto|search|history", "pathId"?: "历史 fragment ID", "arrival"?:{"kind":"exact"}, "deadlineMs"?:绝对 epoch 毫秒}；to 必须是绝对坐标（名字先用 resolve_target）；history 必须给 pathId；不支持 near/reach_block、非空 avoid、挖/放/搭柱。',
  timeoutMs: 15000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['to', 'mode', 'source', 'pathId', 'fragmentId', 'arrival', 'constraints', 'deadlineMs']);
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length) return { ok: false, error: `plan_route 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const to = finitePoint(a.to);
    if (!to) return { ok: false, error: 'to 需要绝对坐标 {x,y,z}；名字/方向先用 resolve_target' };
    const mode = a.mode ?? 'walk';
    if (mode !== 'walk') return { ok: false, error: 'plan_route 当前只支持 mode:"walk"；游泳用 swim_path，船用 boat_path' };
    const source = a.source ?? 'auto';
    if (source !== 'auto' && source !== 'search' && source !== 'history') return { ok: false, error: 'source 必须是 auto、search 或 history' };
    const pathId = a.pathId ?? a.fragmentId;
    if (pathId !== undefined && (typeof pathId !== 'string' || !pathId.trim())) return { ok: false, error: 'pathId 必须是非空历史 fragment ID' };
    if (a.pathId !== undefined && a.fragmentId !== undefined && a.pathId !== a.fragmentId) return { ok: false, error: 'pathId 与 fragmentId 同时出现时必须相同' };
    if (source === 'search' && pathId !== undefined) return { ok: false, error: 'source:"search" 不接受 pathId；要沿历史路线用 source:"history"' };
    const arrival = a.arrival ?? { kind: 'exact' };
    if (!arrival || typeof arrival !== 'object' || Array.isArray(arrival) || (arrival as Record<string, unknown>).kind !== 'exact') {
      return { ok: false, error: 'arrival 当前只支持 {"kind":"exact"}；要走到附近请指定具体目标格' };
    }
    let constraints: PlanArgs['constraints'];
    if (a.constraints !== undefined) {
      if (!a.constraints || typeof a.constraints !== 'object' || Array.isArray(a.constraints)) return { ok: false, error: 'constraints 必须是对象' };
      const c = a.constraints as Record<string, unknown>;
      const cUnknown = Object.keys(c).filter((k) => !['avoid', 'maxNodes', 'maxEdges'].includes(k));
      if (cUnknown.length) return { ok: false, error: `constraints 不支持 ${cUnknown.join('、')}` };
      const avoid = c.avoid;
      if (avoid !== undefined && (!Array.isArray(avoid) || avoid.some((x) => typeof x !== 'string'))) return { ok: false, error: 'constraints.avoid 必须是字符串数组' };
      if (Array.isArray(avoid) && avoid.length) return { ok: false, error: 'plan_route 当前不支持非空 avoid；请换目标或先用其他动作处理' };
      for (const key of ['maxNodes', 'maxEdges'] as const) {
        if (c[key] !== undefined && (!Number.isInteger(c[key]) || (c[key] as number) <= 0)) return { ok: false, error: `constraints.${key} 必须是正整数` };
      }
      constraints = { ...(Array.isArray(avoid) ? { avoid: avoid as string[] } : {}), ...(typeof c.maxNodes === 'number' ? { maxNodes: c.maxNodes } : {}), ...(typeof c.maxEdges === 'number' ? { maxEdges: c.maxEdges } : {}) };
    }
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { to, mode: 'walk', source, ...(typeof pathId === 'string' ? { pathId } : {}), arrival: { kind: 'exact' }, ...(constraints ? { constraints } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial) return fail('NOT_CONNECTED', 'plan_route 需要宿主共享空间会话（ctx.spatial）；当前未接线，不能用 pathfinder 兜底');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'plan_route 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', `当前世界 ${state.worldId} 与空间会话 ${spatial.worldId} 不一致`);
    if (spatial.closing || spatial.paused || !spatial.observationAdmitted) return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能规划路线');
    const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    if (Date.now() >= deadline) return fail('TIMEOUT', 'plan_route 期限在开始前已耗尽');
    const from = { ...state.pos };
    const scope: Scope = { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId };
    const expiresAt = (validUntil: number) => Math.min(Number.isFinite(validUntil) ? validUntil : Infinity, Date.now() + 30_000);
    const tryHistory = args.source === 'history' || args.source === 'auto';
    const source: RouteSource = args.source === 'auto' ? (args.pathId ? 'history' : 'search') : args.source;

    // 先处理显式 pathId，再处理 auto/history 的宿主侧记录路线选择。
    let recorded: { pathId: string; kind: PathFragment['kind']; points: Vec3Like[] } | null = null;
    if (args.pathId) {
      const fragment = spatial.session.history.getFragment(args.pathId);
      if (!fragment) return fail('NOT_FOUND', `没有找到历史路线 ${args.pathId}；用 spatial_query 核对 ID`, { pathId: args.pathId });
      if (fragment.worldId !== state.worldId || fragment.dim !== state.dim) return fail('WRONG_DIMENSION', `历史路线 ${args.pathId} 在 ${fragment.worldId}/${fragment.dim}，不是当前世界/维度`, { pathId: args.pathId });
      recorded = { pathId: args.pathId, kind: fragment.kind, points: fragment.polyline.map((p) => ({ ...p })) };
    } else if (tryHistory) {
      const selected = selectRecordedRoute(spatial, state, from, args.to);
      if (selected) recorded = { pathId: selected.fragment.id, kind: selected.fragment.kind, points: selected.points };
    }
    if (recorded) {
      const problem = historyProblem(recorded.points);
      if (problem) return fail('BAD_ARGS', `记录路线 ${recorded.pathId} 不能按当前 walk 执行：${problem}`, { pathId: recorded.pathId, unsupported: { reason: 'route_geometry_unsupported', detail: problem } });
      const start = recorded.points[0]!;
      if (distanceXZ(start, from) > 2 || Math.abs(start.y - from.y) > 2) {
        return fail('PATH_NOT_FOUND', `记录路线 ${recorded.pathId} 的起点 (${start.x},${start.y},${start.z}) 与当前站位 (${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}) 不符；不能从路线中间开始执行`, { pathId: recorded.pathId, start, unsupported: { reason: 'history_start_mismatch' } });
      }
      const verified = verifyRecordedRoute(spatial, state, start, recorded.points, deadline, ctx.signal);
      if ('error' in verified) return fail('BAD_ARGS', `记录路线 ${recorded.pathId} 无法按当前证据复验：${verified.error}`, { pathId: recorded.pathId, unsupported: { reason: 'route_verification_unavailable' } });
      const status = verified.status;
      throwIfAborted(ctx.signal);
      const routeId = randomUUID();
      const record: RouteRecord = { kind: 'known', pathId: recorded.pathId, pathKind: recorded.kind, points: recorded.points.map((p) => ({ ...p })), scope, from, target: { ...recorded.points.at(-1)! }, validUntil: status.validUntil, expiresAt: expiresAt(status.validUntil), verdict: status.verdict };
      records.set(routeId, record);
      const boundaries = status.earliestProblem ? [{ stepIndex: status.earliestProblem.stepIndex, status: status.earliestProblem.status, problem: status.earliestProblem.problem ?? null }] : [];
      return ok(`记录路线 ${recorded.pathId}（${recorded.kind}）已按当前证据复验：${status.verdict}，${recorded.points.length - 1} 段`, {
        routeId, backend: 'spatial_library', source: 'history', kind: recorded.kind,
        points: record.points, segments: routeSegments(record.points), cost: Math.max(0, record.points.length - 1),
        confidence: status.verdict === 'OPEN' ? 'verified' : 'candidate', executable: status.verdict === 'OPEN',
        boundaries, unsupported: null,
        evidence: { ...scope, validUntil: status.validUntil }, expiresAt: record.expiresAt,
        pathId: recorded.pathId, verdict: status.verdict, requestedTarget: { ...args.to }, resolvedTarget: { ...record.target },
      });
    }
    if (source === 'history') return fail('NOT_FOUND', '没有与当前站位/目标匹配的记录路线（walked/bridge/dug/built）；用 spatial_query 列出，或改用 source:"search"', { unsupported: { reason: 'recall_route_not_found' } });

    // source: search
    const search = new WalkRouteSearch(spatial.session.voxel, {
      now: Date.now,
      maxNodes: args.constraints?.maxNodes ?? 512,
      maxEdges: args.constraints?.maxEdges ?? 2048,
      maxFrontiers: 32,
      maxDiagnostics: 32,
    });
    let snapshot: WalkSearchSnapshot;
    try {
      snapshot = search.start({
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk',
        body: { feet: from, width: 0.6, height: 1.8, pose: 'standing' },
        target: args.to, arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider,
      });
    } catch (e) {
      return fail('BAD_ARGS', `plan_route 请求被路线搜索拒绝：${(e as Error).message}`, { unsupported: { reason: 'search_request_rejected' } });
    }
    for (let slices = 0; snapshot.state === 'PENDING' && Date.now() < deadline; slices++) {
      throwIfAborted(ctx.signal);
      snapshot = search.advance(256);
      if (slices % 4 === 3) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throwIfAborted(ctx.signal);
    if (Date.now() >= deadline && snapshot.state === 'PENDING') return fail('TIMEOUT', 'plan_route 搜索期限已到，尚未得到终态', { snapshot: { state: snapshot.state, counters: snapshot.counters } });
    if (snapshot.state !== 'FOUND' || !snapshot.candidate) return problemOf(snapshot.state, snapshot.reason, { state: snapshot.state, counters: snapshot.counters, ...(snapshot.problem ? { problem: snapshot.problem } : {}) });
    const inspection = inspectRoute(snapshot);
    const points = snapshot.candidate.points.map((p) => ({ ...p }));
    // FOUND 只是候选；用当前证据再跑一遍 RouteVerifier，OPEN 才把路线标为 verified。
    let confidence: 'verified' | 'candidate' = 'candidate';
    let verdict = 'INCOMPLETE';
    let validUntil = snapshot.validUntil;
    let boundaries: Record<string, unknown>[] = inspection.boundaries.map((b) => ({ status: b.status, stance: b.stance, to: b.to, reason: b.reason }));
    try {
      const verifier = new RouteVerifier(spatial.session.voxel, { now: Date.now });
      let status = verifier.register({
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk',
        body: { feet: { ...points[0]! }, width: 0.6, height: 1.8, pose: 'standing' },
        shapeProvider: walkCollisionProvider,
        points,
      });
      while (status.verdict === 'INCOMPLETE' && Date.now() < deadline) {
        throwIfAborted(ctx.signal);
        status = verifier.advance(256);
      }
      verdict = status.verdict;
      confidence = status.complete && status.verdict === 'OPEN' ? 'verified' : 'candidate';
      validUntil = Math.min(snapshot.validUntil, status.validUntil);
      if (status.earliestProblem) {
        boundaries = [{ stepIndex: status.earliestProblem.stepIndex, status: status.earliestProblem.status, problem: status.earliestProblem.problem ?? null }];
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortedError') throw e;
      return fail('BAD_ARGS', `搜索候选无法按当前证据复验：${(e as Error).message}`, { unsupported: { reason: 'candidate_verification_unavailable' }, state: snapshot.state });
    }
    const routeId = randomUUID();
    const record: RouteRecord = { kind: 'snapshot', snapshot, scope, from, target: { ...args.to }, validUntil, expiresAt: expiresAt(validUntil) };
    records.set(routeId, record);
    return ok(`已规划步行路线：${points.length - 1} 段，${verdict}，${snapshot.candidate.edgeCount} 条边；执行前仍会按当前证据逐段复验`, {
      routeId, backend: 'spatial_library', source: 'search', kind: 'walk',
      points, segments: routeSegments(points), cost: snapshot.candidate.edgeCount,
      confidence, executable: confidence === 'verified',
      boundaries, unsupported: null,
      evidence: { ...scope, validUntil }, expiresAt: record.expiresAt,
      counters: snapshot.counters, state: snapshot.state, verdict,
    });
  },
};
