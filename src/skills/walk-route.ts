/**
 * walk_route：显式短路线步行（普通干燥整块、同高、沿 X/Z、无施工）。
 * 通过库的 WalkRouteExecutor 复用路线验证与单段编排；身体桥走适配器的实测物理帧，
 * 不调用会重新寻路的 moveTo。到达语义由库的 bodyArrival 判定。
 * 地图由合法视锥观测喂 VoxelMap：初始扫描路线格，移动中持续更新当前身体周边格。
 * 观测遵守 Vision 的批次限制（≤32 格/次），变化报告整批合并喂给地图，不丢支撑拆除通知。
 */

import { GROUNDED_ARRIVAL_DEFAULTS } from 'curio-minecraft-3d-memory';
import type { ChangeReport, NavResult, Observation, Vec3Like, VoxelMap } from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../adapter/walk-route.ts';
import type { BlockObservation } from '../adapter/types.ts';
import { fail, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';

interface WalkRouteArgs {
  points: Vec3Like[];
  deadlineMs?: number;
}

/** 本轮能力上限：短路线，单轴相邻一格。 */
const MAX_POINTS = 32;

/** 把一次合法视锥观测映射成库的 Observation。 */
function toObservation(b: BlockObservation): Observation {
  // 库要求 state.properties 为 Record<string,string>；本边界把 boolean/number
  // 统一成语义字符串（如 open→'true'、level→'3'），不猜测、不补默认值。
  const properties = Object.fromEntries(Object.entries(b.properties ?? {}).map(([k, v]) => [k, String(v)]));
  return {
    worldId: b.worldId, dim: b.dimension, sessionId: b.sessionId,
    observedAt: b.observedAt, sequence: b.observationId,
    source: 'vision', evidence: 'seen', stateComplete: b.stateComplete === true,
    state: { name: b.name, properties }, pos: { ...b.pos },
  };
}

function dedupe(cells: Vec3Like[]): Vec3Like[] {
  const seen = new Set<string>();
  const out: Vec3Like[] = [];
  for (const c of cells) {
    const k = `${c.x},${c.y},${c.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: c.x, y: c.y, z: c.z });
  }
  return out;
}

/**
 * 观察一组格；遵守 Vision 的 ≤32 格/次批次限制。
 * 共享模式下只触发实际合法 Vision 观测（服务/真实视觉是唯一写者），不再写地图；
 * 独立模式下保持单次 observeBatch 的既有路径，供其自身的有界批测试使用。
 */
export function observeCells(ctx: SkillCtx, map: VoxelMap, cells: Vec3Like[]): ChangeReport | null {
  if (!ctx.senses.observeBlocks) return null;
  const unique = dedupe(cells);
  const shared = ctx.spatial !== undefined;
  const observations: Observation[] = [];
  for (let i = 0; i < unique.length; i += 32) {
    const batch = ctx.senses.observeBlocks(unique.slice(i, i + 32));
    // 共享模式：Vision 在返回前已通过服务同步写入并派发报告。
    if (shared) continue;
    for (const b of batch) observations.push(toObservation(b));
  }
  if (shared || observations.length === 0) return null;
  return map.observeBatch({ observations, unobserved: [] });
}

/**
 * 从路线点列导出需要观察的格：每个点周围 3×3 的水平邻域 × 脚高/支撑/头/净空。
 * 按短路线约束有界生成，不枚举整条路线的包围矩形。额外观察的格对验证无害。
 */
function routeCells(points: Vec3Like[]): Vec3Like[] {
  const cells: Vec3Like[] = [];
  for (const p of points) {
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (let x = fx - 1; x <= fx + 1; x++)
      for (let z = fz - 1; z <= fz + 1; z++)
        for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
  }
  return cells;
}

function navToResult(nav: NavResult): SkillResult {
  const summary = nav.message;
  if (nav.outcome === 'ARRIVED') return ok(summary, { nav });
  // 取消是取消，不包装成普通 STUCK；部分位移随 nav.lastPosition/trace 保留在 data。
  if (nav.outcome === 'CANCELLED') return { status: 'cancelled', summary, data: { nav } };
  const code = nav.outcome === 'TIMEOUT' ? 'TIMEOUT' : nav.outcome === 'BLOCKED' ? 'PATH_NOT_FOUND' : 'ERROR';
  return fail(code, summary, { nav });
}

export const walkRoute: Skill<WalkRouteArgs> = {
  name: 'walk_route',
  description: '走一条显式给定的同高、无施工短路线（普通干燥整块、沿 X/Z）。由你提供点列，代码稳定执行到每个点；出发前会有限次转头（≤12 次）观察路线支撑/身体/净空格，移动中每段会低头看向该段路径的支撑格，途中只依据可见格更新；转头观察不使用任何物品',
  argsDoc: '{"points":[[x,y,z],...]}（2~32 个点，脚高 y 相同，相邻沿 X/Z 一格）',
  timeoutMs: 30000,
  movement: true,
  validate(raw, _adapter) {
    const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const points = a.points;
    if (!Array.isArray(points) || points.length < 2) return { ok: false, error: 'walk_route 需要 {"points":[[x,y,z],...]}，至少 2 个点' };
    if (points.length > MAX_POINTS) return { ok: false, error: `walk_route 本轮最多 ${MAX_POINTS} 个点` };

    const parsed: Vec3Like[] = [];
    for (const p of points) {
      const coord = readPoint(p);
      if (coord === null) return { ok: false, error: 'points 每个点必须是 [x,y,z] 数组或 {x,y,z} 对象，坐标为 ±30000000 内的有限数字' };
      parsed.push(coord);
    }
    const y = parsed[0]!.y;
    for (const p of parsed) if (p.y !== y) return { ok: false, error: 'walk_route 本轮只支持同高路线（y 相同）' };
    for (let i = 0; i < parsed.length - 1; i++) {
      const dx = parsed[i + 1]!.x - parsed[i]!.x;
      const dz = parsed[i + 1]!.z - parsed[i]!.z;
      const isXStep = Math.abs(Math.abs(dx) - 1) < 1e-9 && Math.abs(dz) < 1e-9;
      const isZStep = Math.abs(Math.abs(dz) - 1) < 1e-9 && Math.abs(dx) < 1e-9;
      if (!isXStep && !isZStep) return { ok: false, error: 'walk_route 只支持沿 X/Z 单轴相邻一格的路线（非对角、非跳跃、非跨格）' };
    }

    const rawDeadline = a.deadlineMs === undefined ? undefined : Number(a.deadlineMs);
    const deadlineMs = rawDeadline !== undefined && Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
    if (rawDeadline !== undefined && deadlineMs === undefined) return { ok: false, error: 'deadlineMs 必须是正有限数字（毫秒）' };
    return { ok: true, args: { points: parsed, ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'walk_route 需要宿主共享空间会话（ctx.spatial），当前未接线');
    const body = ctx.adapter.walkBody?.();
    const tick = ctx.adapter.walkTick?.();
    if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）');

    const state = ctx.adapter.state();
    // 共享步行只读宿主服务持有的地图；缺失/关闭时显式失败，绝不自建 VoxelMap 兜底。
    const map = spatial.session.voxel;
    // 有效期限不能超过父委托期限：子请求只能缩短，不能延长。
    const effectiveDeadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);

    // 预扫：有限次合法转头（4 个朝向 × 3 个俯仰）覆盖验证所需的支撑、身体与净空竖列。
    // 视锥配置不变；脚下/头顶不因“贴着身体”就免视线，因此必须真正低头/抬头去看。
    // 这是执行这条显式路线所需的观察，不扩宽视锥、不做额外探索，也不消耗资源。
    const route = routeCells(args.points);
    observeCells(ctx, map, route);
    if (typeof ctx.adapter.look === 'function') {
      for (const pitch of [-1.2, 0, 1.1]) {
        for (const yaw of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
          if (ctx.signal.aborted || Date.now() >= effectiveDeadline) break;
          await ctx.adapter.look(yaw, pitch);
          observeCells(ctx, map, route);
        }
        if (ctx.signal.aborted || Date.now() >= effectiveDeadline) break;
      }
    }
    if (ctx.signal.aborted) return { status: 'cancelled', summary: '预扫阶段被取消', data: {} };

    // 移动中持续更新身体周边格（视锥随身体朝向移动而更新）。
    const observe = () => {
      const p = ctx.adapter.state().pos;
      const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
      const cells: Vec3Like[] = [];
      for (let x = fx - 1; x <= fx + 1; x++)
        for (let z = fz - 1; z <= fz + 1; z++)
          for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
      return observeCells(ctx, map, cells);
    };

    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, mode: 'walk' as const,
      body: { feet: args.points[0]!, width: 0.6, height: 1.8, pose: 'standing' as const },
      points: args.points, arrival: { kind: 'exact' as const },
      bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: effectiveDeadline, timeoutMs: 4000,
    };
    const nav = await runWalkRoute({
      map, body, request, tick, signal: ctx.signal, observe,
      lifecycle: () => {
        const s = ctx.adapter.state();
        // 真实 ready 丢失（同一 sessionId 下区块消失）可能先被步行生命周期看到、
        // 且之后没有下一帧/下一次 Vision 调用；此时把已经知道的实际边界交给共享
        // 服务一次。服务仅在实际准入时 interrupt，重复读取不会重复中断。
        if (!s.observationReady && spatial.observationAdmitted) spatial.interrupt();
        return { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId, alive: s.alive, connected: s.connected, observationReady: s.observationReady };
      },
      deadlineMs: effectiveDeadline,
      now: Date.now,
      // 附着生命周期属于本次真实步行：报告在身体样本前同步进入 loop，取消走 lifecycle。
      // finally 只撤销本 token，不关闭共享会话，也不影响后续任务。
      bindActive: (loop) => {
        const token = spatial.attach({
          receiver: (report) => loop.observe(report, 64),
          cancel: () => loop.cancel('lifecycle', 'shared spatial session interrupted the active walk'),
        });
        return () => spatial.detach(token);
      },
    });
    // 父任务已取消但库以其它终态返回（期限/失效先到）：以取消返回，保留部分位移。
    if (ctx.signal.aborted && nav.outcome !== 'CANCELLED') return { status: 'cancelled', summary: nav.message, data: { nav } };
    return navToResult(nav);
  },
};

/** 坐标必须本身是有限数字，且落在可安全枚举的范围（Minecraft 世界边界内）。 */
const COORD_BOUND = 30_000_000;

function validCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_BOUND;
}

function readPoint(p: unknown): Vec3Like | null {
  if (Array.isArray(p)) {
    if (!validCoord(p[0]) || !validCoord(p[1]) || !validCoord(p[2])) return null;
    return { x: p[0], y: p[1], z: p[2] };
  }
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if (!validCoord(o.x) || !validCoord(o.y) || !validCoord(o.z)) return null;
    return { x: o.x, y: o.y, z: o.z };
  }
  return null;
}
