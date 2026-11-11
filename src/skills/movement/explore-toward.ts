import type { Vec3Like } from '../../adapter/types.ts';
import { lookAround, sighted } from '../movement.ts';
import { fail, isAbort, obj, ok, runSkill, type Skill, type SkillResult } from '../types.ts';
import { coordinatorResult, runMovementCoordinator } from './coordinator.ts';
import { CARDINAL_DIRECTIONS, type CardinalDirection } from './session.ts';
import { MAKE_WAY_ARGS_DOC, MAKE_WAY_DOC, makeWayArgs, makeWayRequest, parseMakeWay } from './make-way.ts';

type ExploreArgs = {
  direction: CardinalDirection;
  distance: number;
  origin: Vec3Like;
  until?: string;
  segment: number;
  maxLateralDrift: number;
  timeoutMs: number;
  sessionId?: string;
  swim?: boolean;
  /** 显式授权开路；保持委托原样的平铺参数，校验结果可再次通过校验（计划录入后执行前会再校验一次）。 */
  dig?: true | string;
  place?: string;
  maxEdits?: number;
};

export const MAX_EXPLORE_DISTANCE = 512;

/** Directional exploration composes the same voxel coordinator with explicit observation. */
export const exploreToward: Skill<ExploreArgs> = {
  name: 'explore_toward',
  description: '沿你指定的 N/E/S/W 方向按共享 VoxelMap 三维路线推进，原方向、距离与横向范围冻结；优先沿原方向直行，当前方缺少证据就靠近前沿观察，已知阻挡时在授权横向范围内绕行。边走边确认下一段，行进中看到 until 目标就停止；在有证据缺口的停点可再朝原方向寻找一次。距离 16–512 格，只执行已确认的 walk/step/drop 与跨越 1 格缺口的 jump（原地起跳）。未知前沿有界观察后，相关证据变化才继续，否则返回边界。默认不下水，swim:true 时才涉水并代为游泳；' + MAKE_WAY_DOC + '。回执保留 sessionId、原目标、累计预算和实测进展，续接须带原 sessionId。只接受声明的参数，其他参数一律拒绝。',
  catalog: '{"direction":"N|E|S|W","distance":16-512,"until"?:"log|stem|方块或生物名","maxLateralDrift"?:16,"swim"?:true,"dig"?:true|"工具名","place"?:"方块名|any","maxEdits"?:16,"sessionId"?}：没有具体目的地时，朝一个方向去没去过的地方、边走边看，until 本轮看见就停；dig/place 同 travel_to',
  argsDoc: '{"direction":"N|E|S|W","distance":16-512,"until"?:"log|stem|方块或生物名","segment"?:16-48（规划前瞻，本段最多32步）,"maxLateralDrift"?:16（0-64，0 只直行）,"timeoutMs"?:300000（30000-600000）,"sessionId"?,"origin"?:{x,y,z},"swim"?:false（true 时允许涉水，并在水中或水边用 swim_path 游向已观察到、沿委托有推进的岸边站立格，没有岸时游向前方水面点；会消耗氧气、不潜水、每次调用最多 8 段，回执 swimLegs 记录每段游泳）,' + MAKE_WAY_ARGS_DOC + '}；只接受 direction/distance/until/segment/maxLateralDrift/timeoutMs/sessionId/origin/swim/dig/place/maxEdits/make，未知参数会被拒绝；until 只认本次实际看见的目标。',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const allowedKeys = new Set(['direction', 'distance', 'until', 'segment', 'maxLateralDrift', 'timeoutMs', 'sessionId', 'origin', 'swim', 'dig', 'place', 'maxEdits', 'make']);
    const unknown = Object.keys(a).filter((key) => !allowedKeys.has(key));
    if (unknown.length) return { ok: false, error: `explore_toward 不认识参数 ${unknown.join('、')}；只接受 ${[...allowedKeys].join('、')}` };
    const direction = String(a.direction ?? '').toUpperCase();
    if (!CARDINAL_DIRECTIONS.includes(direction as CardinalDirection)) return { ok: false, error: '当前体素方向推进只支持 N/E/S/W；对角方向需要额外角落净空支持，不会替换成其他方向' };
    if (!Number.isInteger(a.distance) || a.distance < 16 || a.distance > MAX_EXPLORE_DISTANCE) return { ok: false, error: `distance 需要 16–${MAX_EXPLORE_DISTANCE} 的整数；原目标不会被缩短` };
    if (a.until !== undefined && (typeof a.until !== 'string' || !a.until.trim() || a.until.length > 40)) return { ok: false, error: 'until 需要 1–40 字的方块/生物名或类别' };
    if (a.segment !== undefined && (!Number.isInteger(a.segment) || a.segment < 16 || a.segment > 48)) return { ok: false, error: 'segment 需要 16–48 的整数' };
    if (a.maxLateralDrift !== undefined && (!Number.isInteger(a.maxLateralDrift) || a.maxLateralDrift < 0 || a.maxLateralDrift > 64)) return { ok: false, error: 'maxLateralDrift 需要 0–64 的整数，0 表示沿原方向直行' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 30000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 30000–600000 的整数' };
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) return { ok: false, error: 'sessionId 需要非空字符串' };
    if (a.swim !== undefined && typeof a.swim !== 'boolean') return { ok: false, error: 'swim 需要 true 或 false' };
    const makeWay = parseMakeWay(a);
    if (!makeWay.ok) return makeWay;
    const origin = a.origin === undefined ? { ...adapter.state().pos } : obj(a.origin);
    if (![origin.x, origin.y, origin.z].every((n) => typeof n === 'number' && Number.isFinite(n))) return { ok: false, error: 'origin 需要 {x,y,z} 有限数字' };
    return { ok: true, args: {
      direction: direction as CardinalDirection, distance: a.distance,
      origin: { x: origin.x as number, y: origin.y as number, z: origin.z as number },
      segment: a.segment ?? 32, maxLateralDrift: a.maxLateralDrift ?? 16, timeoutMs: a.timeoutMs ?? 300000,
      ...(a.until === undefined ? {} : { until: (a.until as string).trim().toLowerCase() }),
      ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
      ...(a.swim === true ? { swim: true } : {}),
      ...makeWayArgs(makeWay.value),
    } };
  },
  async run(ctx, args) {
    const start = ctx.adapter.state().pos;
    if (args.sessionId === undefined && Math.hypot(start.x - args.origin.x, start.y - args.origin.y, start.z - args.origin.z) > 0.05) {
      return fail('BAD_ARGS', '身体已离开冻结起点；续接原方向请带原 sessionId，不会从新位置重解释目标', { originalRequest: args, position: { ...start }, reason: 'INTENT_MISMATCH' });
    }
    const deadline = Math.min(ctx.deadline, Date.now() + args.timeoutMs);
    const maxTransitions = Math.min(1024, args.distance * 2 + 16);
    const until = args.until;
    let sighting: Record<string, unknown> | undefined;
    const checkSighting = until === undefined ? undefined : () => {
      ctx.senses.refresh();
      const hit = sighted(ctx, until, { visibleOnly: true, currentViewOnly: true, direction: args.direction });
      if (!hit) return undefined;
      sighting = { found: hit.what, dist: hit.dist, foundPos: hit.pos, foundRef: hit.ref,
        ...(hit.ref?.kind === 'entity' ? { foundEntityId: hit.ref.id } : {}), source: 'current_vision', turned: false, scanViews: 0 };
      return `沿 ${args.direction} 的当前视野看见 ${hit.what}（${hit.dist} 格外）`;
    };
    const extra = { planner: 'voxel_astar', requestedDirection: args.direction, requestedDistance: args.distance, originalRequest: args };
    let last: SkillResult | undefined;
    try {
      const outcome = await runMovementCoordinator({ ...ctx, deadline }, {
        intent: { kind: 'advance', direction: args.direction, distance: args.distance, maxLateralDrift: args.maxLateralDrift, allowed: ['walk', 'step', 'drop', 'jump'], historical: true },
        rolling: true, checkSighting, maxSegments: 32, maxStepsPerSegment: Math.min(32, args.segment),
        invocationMaxTransitions: maxTransitions, maxTransitions, maxSearches: 32,
        maxObservations: 32, maxObservedCells: 2048, maxNoProgressSegments: 4,
        sessionId: args.sessionId, deadlineMs: deadline, allowUnknownCorridor: false, observeFrontierBeyondSegments: true,
        ...(args.swim === true ? { swim: true } : {}),
        ...makeWayRequest(args), makeWayAvailable: true,
      });
      last = coordinatorResult(outcome, extra);
      if (!outcome.ok) return last;
      if (outcome.stop.reason === 'UNTIL_SEEN') {
        return { ...last, data: { ...last.data, ...(sighting && { ...sighting, sighting }), arrived: false, stopReason: 'UNTIL_SEEN' } };
      }
      if (!until || ctx.signal.aborted || deadline - Date.now() < 2000
        || (outcome.stop.reason !== 'UNKNOWN_BOUNDARY' && outcome.stop.reason !== 'BLOCKED')
        || (!outcome.observation?.attempted && !outcome.segments.some(part => part.confirmed.length > 0))) return last;
      const glance = await runSkill({ ...ctx, deadline }, lookAround, { seconds: 2, direction: args.direction, for: until });
      if (glance.status === 'cancelled') return { ...glance, data: { ...last.data, ...glance.data, ...extra, position: { ...ctx.adapter.state().pos } } };
      if (glance.status !== 'succeeded') return last;
      outcome.session.phase = 'completed';
      outcome.session.stop = { reason: 'UNTIL_SEEN', at: Date.now(), detail: `本轮扫视看见 ${until}` };
      return ok(`沿 ${args.direction} 的停点扫视看见 ${until}，停止本次探索`, { ...last.data, ...glance.data,
        ...extra, phase: 'completed', arrived: false, stop: outcome.session.stop, stopReason: 'UNTIL_SEEN', sighting: glance.data,
        continuation: { canContinue: false }, position: { ...ctx.adapter.state().pos } });
    } catch (error) {
      if (!isAbort(error)) throw error;
      return { status: 'cancelled', summary: 'explore_toward 已取消，保留原方向、累计预算与最后位置', data: { sessionId: args.sessionId, ...last?.data, ...extra, position: { ...ctx.adapter.state().pos } } };
    }
  },
};
