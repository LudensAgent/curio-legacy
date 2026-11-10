import type { Vec3Like } from '../../adapter/types.ts';
import { lookAround } from '../movement.ts';
import { fail, isAbort, obj, ok, runSkill, type Skill, type SkillResult } from '../types.ts';
import { coordinatorResult, runMovementCoordinator } from './coordinator.ts';
import { CARDINAL_DIRECTIONS, type CardinalDirection } from './session.ts';

type ExploreArgs = {
  direction: CardinalDirection;
  distance: number;
  origin: Vec3Like;
  until?: string;
  segment: number;
  maxLateralDrift: number;
  timeoutMs: number;
  sessionId?: string;
};

export const MAX_EXPLORE_DISTANCE = 512;

/** Directional exploration composes the same voxel coordinator with explicit observation. */
export const exploreToward: Skill<ExploreArgs> = {
  name: 'explore_toward',
  description: '沿你指定的 N/E/S/W 方向按共享 VoxelMap 三维路线推进，原方向、距离与横向范围冻结；完整身体窗口后朝该方向扫视，已做前沿定向观察时不重复广角扫描；有 until 时在实际推进后扫视目标，本轮视野看见就停止。距离 16–512 格，不缩短原目标。只执行已确认的 walk/step/drop；未知前沿先做一次有界合法观察，相关证据变化才继续，否则返回边界。不挖放、不下水。回执保留 sessionId、原目标、累计预算和实测进展，续接须带原 sessionId。只接受声明的参数，其他参数一律拒绝。',
  argsDoc: '{"direction":"N|E|S|W","distance":16-512,"until"?:"log|stem|方块或生物名","segment"?:16-48（单次身体窗口最多32步）,"maxLateralDrift"?:16（4-64）,"timeoutMs"?:300000（30000-600000）,"sessionId"?,"origin"?:{x,y,z}}；只接受 direction/distance/until/segment/maxLateralDrift/timeoutMs/sessionId/origin/make，未知参数会被拒绝；until 只认当前扫视。',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const allowedKeys = new Set(['direction', 'distance', 'until', 'segment', 'maxLateralDrift', 'timeoutMs', 'sessionId', 'origin', 'make']);
    const unknown = Object.keys(a).filter((key) => !allowedKeys.has(key));
    if (unknown.length) return { ok: false, error: `explore_toward 不认识参数 ${unknown.join('、')}；只接受 ${[...allowedKeys].join('、')}` };
    const direction = String(a.direction ?? '').toUpperCase();
    if (!CARDINAL_DIRECTIONS.includes(direction as CardinalDirection)) return { ok: false, error: '当前体素方向推进只支持 N/E/S/W；对角方向需要额外角落净空支持，不会替换成其他方向' };
    if (!Number.isInteger(a.distance) || a.distance < 16 || a.distance > MAX_EXPLORE_DISTANCE) return { ok: false, error: `distance 需要 16–${MAX_EXPLORE_DISTANCE} 的整数；原目标不会被缩短` };
    if (a.until !== undefined && (typeof a.until !== 'string' || !a.until.trim() || a.until.length > 40)) return { ok: false, error: 'until 需要 1–40 字的方块/生物名或类别' };
    if (a.segment !== undefined && (!Number.isInteger(a.segment) || a.segment < 16 || a.segment > 48)) return { ok: false, error: 'segment 需要 16–48 的整数' };
    if (a.maxLateralDrift !== undefined && (!Number.isInteger(a.maxLateralDrift) || a.maxLateralDrift < 4 || a.maxLateralDrift > 64)) return { ok: false, error: 'maxLateralDrift 需要 4–64 的整数' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 30000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 30000–600000 的整数' };
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) return { ok: false, error: 'sessionId 需要非空字符串' };
    const origin = a.origin === undefined ? { ...adapter.state().pos } : obj(a.origin);
    if (![origin.x, origin.y, origin.z].every((n) => typeof n === 'number' && Number.isFinite(n))) return { ok: false, error: 'origin 需要 {x,y,z} 有限数字' };
    return { ok: true, args: {
      direction: direction as CardinalDirection, distance: a.distance,
      origin: { x: origin.x as number, y: origin.y as number, z: origin.z as number },
      segment: a.segment ?? 32, maxLateralDrift: a.maxLateralDrift ?? 16, timeoutMs: a.timeoutMs ?? 300000,
      ...(a.until === undefined ? {} : { until: (a.until as string).trim().toLowerCase() }),
      ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
    } };
  },
  async run(ctx, args) {
    const start = ctx.adapter.state().pos;
    if (args.sessionId === undefined && Math.hypot(start.x - args.origin.x, start.y - args.origin.y, start.z - args.origin.z) > 0.05) {
      return fail('BAD_ARGS', '身体已离开冻结起点；续接原方向请带原 sessionId，不会从新位置重解释目标', { originalRequest: args, position: { ...start }, reason: 'INTENT_MISMATCH' });
    }
    const deadline = Math.min(ctx.deadline, Date.now() + args.timeoutMs);
    const stepBudget = Math.min(32, args.segment);
    let sessionId = args.sessionId;
    let last: SkillResult | undefined;
    const extra = { planner: 'voxel_astar', requestedDirection: args.direction, requestedDistance: args.distance, originalRequest: args };
    try {
      for (let segment = 0; segment < 32; segment++) {
        const outcome = await runMovementCoordinator({ ...ctx, deadline }, {
          intent: { kind: 'advance', direction: args.direction, distance: args.distance, maxLateralDrift: args.maxLateralDrift, allowed: ['walk', 'step', 'drop'], historical: true },
          maxSegments: 1, maxStepsPerSegment: stepBudget, invocationMaxTransitions: stepBudget,
          maxTransitions: Math.min(1024, args.distance * 2 + 16), maxSearches: 32,
          maxObservations: 16, maxObservedCells: 512, maxNoProgressSegments: 2,
          ...(sessionId === undefined ? {} : { sessionId }), deadlineMs: deadline, allowUnknownCorridor: false,
          // 显式探索在本次分段用尽时仍允许对前沿边界/当前列做一次有界观察；
          // 相关证据变化后交回外层循环，用同一 session 续接已确认的前缀。
          observeFrontierBeyondSegments: true,
        });
        last = coordinatorResult(outcome, extra);
        if (!outcome.ok) return last;
        sessionId = outcome.session.id;
        if (last.status === 'cancelled' || Date.now() >= deadline) return last;
        const before = outcome.segments.length;
        const confirmed = outcome.segments.reduce((count, part) => count + part.confirmed.length, 0);
        const progressed = confirmed > 0 || outcome.segments.some((part) =>
          Math.hypot(part.measuredEnd.x - part.measuredStart.x, part.measuredEnd.z - part.measuredStart.z)
            + Math.abs(part.measuredEnd.y - part.measuredStart.y) > 0.05);
        const fullWindow = confirmed >= stepBudget && outcome.observation === undefined
          && (last.status === 'succeeded' || outcome.stop.reason === 'BUDGET_EXHAUSTED');
        // 短前沿已有协调器的定向观察；无进展/终止失败不再为扫描而转头。
        // until 是显式搜索目标，即使推进停在未知边界，也保留本轮发现它的机会。
        if (progressed && (args.until !== undefined || fullWindow)) {
          const glance = await runSkill({ ...ctx, deadline }, lookAround, { seconds: 2, direction: args.direction, ...(args.until ? { for: args.until } : {}) });
          if (glance.status === 'cancelled') return { ...glance, data: { ...last.data, ...glance.data, ...extra, position: { ...ctx.adapter.state().pos } } };
          if (args.until && glance.status === 'succeeded') {
            outcome.session.phase = 'completed';
            outcome.session.stop = { reason: 'UNTIL_SEEN', at: Date.now(), detail: `本轮扫视看见 ${args.until}` };
            return ok(`沿 ${args.direction} 推进后本轮看见 ${args.until}，停止本次探索`, { ...last.data, ...extra, phase: 'completed', arrived: false, stop: outcome.session.stop, stopReason: 'UNTIL_SEEN', sighting: glance.data, continuation: { canContinue: false }, position: { ...ctx.adapter.state().pos } });
          }
        }
        if (last.status === 'succeeded' || outcome.stop.reason !== 'BUDGET_EXHAUSTED') return last;
        if (outcome.session.counters.searches >= outcome.session.budget.maxSearches || outcome.session.counters.confirmedTransitions >= outcome.session.budget.maxTransitions || before === 0) return last;
      }
      return last ?? fail('ERROR', '探索未产生执行结果', extra);
    } catch (error) {
      if (!isAbort(error)) throw error;
      return { status: 'cancelled', summary: 'explore_toward 已取消，保留原方向、累计预算与最后位置', data: { ...last?.data, ...extra, sessionId, position: { ...ctx.adapter.state().pos } } };
    }
  },
};
