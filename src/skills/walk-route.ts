/**
 * walk_route：显式短路线步行（普通干燥整块、同高、沿 X/Z、无施工）。
 * 通过库的 WalkRouteExecutor 复用路线验证与单段编排；身体桥走适配器的实测物理帧，
 * 不调用会重新寻路的 moveTo。到达语义由库的 bodyArrival 判定。
 * 地图由合法视锥观测喂 VoxelMap：初始扫描路线格，移动中持续更新当前身体周边格。
 */

import { GROUNDED_ARRIVAL_DEFAULTS, VoxelMap } from 'curio-minecraft-3d-memory';
import type { ChangeReport, NavResult, Vec3Like } from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider, type WalkBody, type WalkTick } from '../adapter/walk-route.ts';
import type { BlockObservation } from '../adapter/types.ts';
import { ok, fail, type Skill, type SkillCtx } from './types.ts';

interface WalkRouteArgs {
  points: Vec3Like[];
  deadlineMs?: number;
}

/** 把一次合法视锥观测喂进 VoxelMap，返回 ChangeReport。 */
function feedCell(map: VoxelMap, b: BlockObservation): ChangeReport {
  return map.observe({
    worldId: b.worldId, dim: b.dimension, sessionId: b.sessionId,
    observedAt: b.observedAt, sequence: b.observationId,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: b.name, properties: b.properties as Record<string, string> }, pos: { ...b.pos },
  });
}

/** 观察一组格并喂进地图；返回最后一个 ChangeReport（多次变更的截面由地图累计）。 */
function observeCells(ctx: SkillCtx, map: VoxelMap, cells: Vec3Like[]): ChangeReport | null {
  const observed = ctx.senses.observeBlocks?.(cells) ?? [];
  let report: ChangeReport | null = null;
  for (const b of observed) report = feedCell(map, b);
  return report;
}

/** 从路线点列导出需要观察的格（脚高、支撑、净空）。 */
function routeCells(points: Vec3Like[]): Vec3Like[] {
  const minX = Math.floor(Math.min(...points.map((p) => p.x))) - 1;
  const maxX = Math.floor(Math.max(...points.map((p) => p.x))) + 1;
  const minZ = Math.floor(Math.min(...points.map((p) => p.z))) - 1;
  const maxZ = Math.floor(Math.max(...points.map((p) => p.z))) + 1;
  const feetY = Math.floor(points[0]!.y);
  const cells: Vec3Like[] = [];
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
    for (let y = feetY - 1; y <= feetY + 2; y++) cells.push({ x, y, z });
  }
  return cells;
}

function navToResult(nav: NavResult): ReturnType<typeof fail> | ReturnType<typeof ok> {
  const summary = nav.message;
  if (nav.outcome === 'ARRIVED') return ok(summary, { nav });
  if (nav.outcome === 'CANCELLED') return fail('STUCK', summary, { nav });
  const code = nav.outcome === 'TIMEOUT' ? 'TIMEOUT' : nav.outcome === 'BLOCKED' ? 'PATH_NOT_FOUND' : 'ERROR';
  return fail(code, summary, { nav });
}

export const walkRoute: Skill<WalkRouteArgs> = {
  name: 'walk_route',
  description: '走一条显式给定的同高、无施工短路线（普通干燥整块、沿 X/Z）。由你提供点列，代码稳定执行到每个点',
  argsDoc: '{"points":[[x,y,z],...]}（≥2 个点，脚高 y 相同，相邻沿 X/Z）',
  timeoutMs: 30000,
  movement: true,
  validate(raw, adapter) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const points = a.points;
    if (!Array.isArray(points) || points.length < 2) return { ok: false, error: 'walk_route 需要 {"points":[[x,y,z],...]}，至少 2 个点' };
    const parsed: Vec3Like[] = points.map((p) => {
      const arr = Array.isArray(p) ? p : (p as Record<string, unknown>);
      const x = Number(Array.isArray(p) ? arr[0] : (arr as Record<string, unknown>).x);
      const y = Number(Array.isArray(p) ? arr[1] : (arr as Record<string, unknown>).y);
      const z = Number(Array.isArray(p) ? arr[2] : (arr as Record<string, unknown>).z);
      return { x, y, z };
    });
    if (parsed.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) return { ok: false, error: 'points 坐标必须是有限数字' };
    if (parsed.some((p) => p.y !== parsed[0]!.y)) return { ok: false, error: 'walk_route 本轮只支持同高路线（y 相同）' };
    const rawDeadline = a.deadlineMs === undefined ? undefined : Number(a.deadlineMs);
    const deadlineMs = rawDeadline !== undefined && Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
    return { ok: true, args: { points: parsed, ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const body = (ctx.adapter as unknown as { walkBody?: () => WalkBody }).walkBody?.();
    const tick = (ctx.adapter as unknown as { walkTick?: () => WalkTick }).walkTick?.();
    if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）');
    const state = ctx.adapter.state();
    const map = new VoxelMap(state.worldId, { validityWindowMs: 60_000 });
    observeCells(ctx, map, routeCells(args.points));
    // 预扫：依次转向各路线段方向、略低头观察（视锥是朝向的，脚高格在视线下方）。
    if (typeof ctx.adapter.look === 'function') {
      for (let i = 0; i < args.points.length - 1; i++) {
        const a = args.points[i]!, b = args.points[i + 1]!;
        const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
        await ctx.adapter.look(yaw, -0.6);
        observeCells(ctx, map, routeCells(args.points));
      }
    }
    // 移动中持续更新身体周边格（视锥随身体朝向移动而更新）。
    const observe = () => {
      const p = ctx.adapter.state().pos;
      const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
      const cells: Vec3Like[] = [];
      for (let x = fx - 2; x <= fx + 2; x++) for (let z = fz - 2; z <= fz + 2; z++) {
        for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
      }
      return observeCells(ctx, map, cells);
    };
    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk' as const,
      body: { feet: args.points[0]!, width: 0.6, height: 1.8, pose: 'standing' as const },
      points: args.points, arrival: { kind: 'exact' as const },
      bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: args.deadlineMs ?? ctx.deadline, timeoutMs: 4000,
    };
    const nav = await runWalkRoute({
      map, body, request, tick, observe,
      lifecycle: () => { const s = ctx.adapter.state(); return { alive: s.alive, connected: s.connected, observationReady: s.observationReady }; },
      deadlineMs: args.deadlineMs ?? ctx.deadline,
      now: Date.now,
    });
    return navToResult(nav);
  },
};
