import type { Vec3Like } from '../../adapter/types.ts';
import { lookAround, sighted } from '../movement.ts';
import { fail, isAbort, obj, ok, runSkill, type Skill, type SkillResult } from '../types.ts';
import { coordinatorResult, runMovementCoordinator } from './coordinator.ts';
import { COMPASS_DIRECTIONS, type CompassDirection } from './session.ts';
import { bearingOf } from './intent.ts';
import { defaultBudgetFor } from './navigate.ts';
import { MAKE_WAY_ARGS_DOC, MAKE_WAY_DOC, makeWayArgs, makeWayRequest, parseMakeWay } from './make-way.ts';

type ExploreArgs = {
  direction: CompassDirection;
  distance: number;
  origin: Vec3Like;
  until?: string;
  segment: number;
  maxLateralDrift: number;
  /** 相对冻结起点脚高允许的累计净下降；descend:true 时省略表示不限制。 */
  maxDescent?: number;
  descend?: true;
  timeoutMs: number;
  sessionId?: string;
  swim?: boolean;
  /** 显式授权开路；保持委托原样的平铺参数，校验结果可再次通过校验（计划录入后执行前会再校验一次）。 */
  dig?: true | string;
  requireTool?: true;
  place?: string;
  maxEdits?: number;
};

export const MAX_EXPLORE_DISTANCE = 512;
/** 地表方向探索默认允许的累计净下降（格）：超过就停，要下探需显式 descend:true 或更大 maxDescent。 */
export const EXPLORE_DEFAULT_MAX_DESCENT = 8;
/** 方向探索一段最多连续执行多少 transition（同时是 segment 参数默认值）。 */
const EXPLORE_SEGMENT_STEPS = 48;

/** Directional exploration composes the same voxel coordinator with explicit observation. */
export const exploreToward: Skill<ExploreArgs> = {
  name: 'explore_toward',
  description: '沿你指定的八方向（N/NE/E/SE/S/SW/W/NW）按共享 VoxelMap 三维路线推进，原方向、距离与横向范围冻结；对角只在角落净空已确认时斜穿，否则走正交/L 形。默认只允许相对出发脚高累计下降 8 格（maxDescent 可调，descend:true 不限），路线会下探更深时在执行前停下并交回事实；优先沿原方向直行，当前方缺少证据就靠近前沿观察，已知阻挡时在授权横向范围内绕行。边走边确认下一段，行进中看到 until 目标就停止；在有证据缺口的停点可再朝原方向寻找一次。距离 16–512 格，只执行已验证的 walk/step/drop（体素证据缺失时用当前已加载方块即时确认，确认不了才停）与跨越 1 格缺口的 jump（走到起点边缘起跳）。未知前沿有界观察后，相关证据变化才继续，否则返回边界。默认不下水，swim:true 时才涉水并代为游泳；' + MAKE_WAY_DOC + '。回执保留 sessionId、原目标、累计预算和实测进展，续接须带原 sessionId。只接受声明的参数，其他参数一律拒绝。',
  catalog: `{"direction":"N|NE|E|SE|S|SW|W|NW","distance":16-512,"until"?:"log|stem|方块或生物名","maxLateralDrift"?:8-48,"maxDescent"?:8,"descend"?:true,"swim"?:true,"dig"?:true|"工具名","place"?:"方块名|any","sessionId"?}：没有具体目的地时，朝一个方向去没去过的地方、边走边看，until 本轮看见就停；默认不允许下探超过出发脚高 8 格，descend:true 明确下洞；dig/place 同 travel_to`,
  argsDoc: `{"direction":"N|NE|E|SE|S|SW|W|NW","distance":16-512,"until"?:"log|stem|方块或生物名","segment"?:16-48（规划前瞻，本段最多${EXPLORE_SEGMENT_STEPS}步）,"maxLateralDrift"?:0-64（省略按距离给 8-48，0 只直行）,"maxDescent"?:8（0-64；相对出发脚高允许的累计净下降，超过则在执行前停下）,"descend"?:true（不限下降；与 maxDescent 互斥）,"timeoutMs"?:300000（30000-600000）,"sessionId"?,"origin"?:{x,y,z},"swim"?:false（true 时允许涉水，并在水中或水边用 swim_path 游向已观察到、沿委托有推进的岸边站立格，没有岸时游向前方水面点；会消耗氧气、不潜水、每次调用最多 8 段，回执 swimLegs 记录每段游泳）,` + MAKE_WAY_ARGS_DOC + '}；只接受 direction/distance/until/segment/maxLateralDrift/maxDescent/descend/timeoutMs/sessionId/origin/swim/dig/requireTool/place/maxEdits/make，未知参数会被拒绝；until 只认本次实际看见的目标；续接时 maxDescent/descend 必须与原委托相同（改下降授权算新委托）。',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const allowedKeys = new Set(['direction', 'distance', 'until', 'segment', 'maxLateralDrift', 'maxDescent', 'descend', 'timeoutMs', 'sessionId', 'origin', 'swim', 'dig', 'requireTool', 'place', 'maxEdits', 'make']);
    const unknown = Object.keys(a).filter((key) => !allowedKeys.has(key));
    if (unknown.length) return { ok: false, error: `explore_toward 不认识参数 ${unknown.join('、')}；只接受 ${[...allowedKeys].join('、')}` };
    const direction = String(a.direction ?? '').toUpperCase();
    if (!COMPASS_DIRECTIONS.includes(direction as CompassDirection)) return { ok: false, error: `direction 需要 ${COMPASS_DIRECTIONS.join('/')}` };
    if (!Number.isInteger(a.distance) || a.distance < 16 || a.distance > MAX_EXPLORE_DISTANCE) return { ok: false, error: `distance 需要 16–${MAX_EXPLORE_DISTANCE} 的整数；原目标不会被缩短` };
    if (a.until !== undefined && (typeof a.until !== 'string' || !a.until.trim() || a.until.length > 40)) return { ok: false, error: 'until 需要 1–40 字的方块/生物名或类别' };
    if (a.segment !== undefined && (!Number.isInteger(a.segment) || a.segment < 16 || a.segment > 48)) return { ok: false, error: 'segment 需要 16–48 的整数' };
    if (a.maxLateralDrift !== undefined && (!Number.isInteger(a.maxLateralDrift) || a.maxLateralDrift < 0 || a.maxLateralDrift > 64)) return { ok: false, error: 'maxLateralDrift 需要 0–64 的整数，0 表示沿原方向直行' };
    if (a.maxDescent !== undefined && (!Number.isInteger(a.maxDescent) || a.maxDescent < 0 || a.maxDescent > 64)) return { ok: false, error: 'maxDescent 需要 0–64 的整数（相对出发脚高允许的累计净下降）' };
    if (a.descend !== undefined && typeof a.descend !== 'boolean') return { ok: false, error: 'descend 需要 true 或 false' };
    if (a.descend === true && a.maxDescent !== undefined) return { ok: false, error: 'descend:true 与 maxDescent 只能写一个' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 30000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 30000–600000 的整数' };
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) return { ok: false, error: 'sessionId 需要非空字符串' };
    if (a.swim !== undefined && typeof a.swim !== 'boolean') return { ok: false, error: 'swim 需要 true 或 false' };
    const makeWay = parseMakeWay(a);
    if (!makeWay.ok) return makeWay;
    const origin = a.origin === undefined ? { ...adapter.state().pos } : obj(a.origin);
    if (![origin.x, origin.y, origin.z].every((n) => typeof n === 'number' && Number.isFinite(n))) return { ok: false, error: 'origin 需要 {x,y,z} 有限数字' };
    return { ok: true, args: {
      direction: direction as CompassDirection, distance: a.distance,
      origin: { x: origin.x as number, y: origin.y as number, z: origin.z as number },
      segment: a.segment ?? EXPLORE_SEGMENT_STEPS, maxLateralDrift: a.maxLateralDrift ?? Math.min(48, Math.max(8, Math.ceil(a.distance / 8))), timeoutMs: a.timeoutMs ?? 300000,
      ...(a.descend === true ? { descend: true as const } : { maxDescent: (a.maxDescent as number | undefined) ?? EXPLORE_DEFAULT_MAX_DESCENT }),
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
    // 协调预算按请求距离缩放：这些数只防失控，不该先于委托距离截断。搭桥时每处施工
    // 都会交回并重搜一次，所以搜索/分段预算要按距离留足，否则长距离探索会走一半就停。
    const maxTransitions = Math.min(4096, args.distance * 3 + 64);
    const bearing = bearingOf(args.direction);
    const searchLimits = defaultBudgetFor(args.origin, {
      x: args.origin.x + bearing.x * args.distance,
      y: args.origin.y,
      z: args.origin.z + bearing.z * args.distance,
    });
    const until = args.until;
    let sighting: Record<string, unknown> | undefined;
    const checkSighting = until === undefined ? undefined : () => {
      // 命中检查只读已完成的帧，并请求后台分片刷新；不再每步同步扫整帧。
      ctx.senses.requestRefresh?.();
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
        intent: {
          kind: 'advance', direction: args.direction, distance: args.distance, maxLateralDrift: args.maxLateralDrift,
          allowed: ['walk', 'step', 'drop', 'jump'], historical: true,
          ...(args.descend === true ? {} : { maxDescent: args.maxDescent }),
        },
        rolling: true, checkSighting, maxSegments: Math.min(1024, 64 + Math.ceil(args.distance / 2)),
        maxStepsPerSegment: Math.min(EXPLORE_SEGMENT_STEPS, args.segment),
        invocationMaxTransitions: maxTransitions, maxTransitions,
        maxSearches: Math.min(2048, 64 + args.distance * 2),
        searchLimits: { maxNodes: searchLimits.maxNodes, maxEdges: searchLimits.maxEdges },
        maxObservations: Math.min(256, 32 + Math.ceil(args.distance / 4)),
        maxObservedCells: Math.min(8192, 2048 + args.distance * 16), maxNoProgressSegments: 4,
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
