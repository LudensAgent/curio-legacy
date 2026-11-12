import { coordinatorResult, runMovementCoordinator } from './coordinator.ts';
import { CARDINAL_DIRECTIONS, MOVE_MODES, type CardinalDirection, type MoveMode } from './session.ts';
import { obj, type Skill } from '../types.ts';

type AdvanceArgs = {
  direction: CardinalDirection;
  distance: number;
  maxLateralDrift: number;
  allowed: MoveMode[];
  historical: boolean;
  maxSegments?: number;
  maxStepsPerSegment?: number;
  maxTransitions?: number;
  maxSearches?: number;
  maxObservations?: number;
  maxObservedCells?: number;
  maxNoProgressSegments?: number;
  sessionId?: string;
  deadlineMs?: number;
};

const DIAGONALS = new Set(['NE', 'NW', 'SE', 'SW']);

/**
 * 方向推进的公开意图入口。方向与距离冻结在 session 里；waypoint 只是中间执行目标，
 * 不会覆盖原意图。Coordinator 负责有界分段、边界观察、实测验收与累计进展。
 */
export const advance: Skill<AdvanceArgs> = {
  name: 'advance',
  description: '朝你指定的四方向之一（N/E/S/W）水平推进指定距离。方向与距离冻结：宿主每次按冻结方向派生中间 waypoint，分段执行已验证的 walk/step/drop（体素证据缺失时用当前已加载方块即时确认，确认不了才停），每步用实测位置确认；不挖、不放、不搭柱、不自动切换游泳/船/攀爬，也不因绕路改方向。距离按水平世界格计算，回执分别报告 along（沿方向进度）、lateral（横向偏移）、horizontalNet（水平净位移）与 confirmedRouteLength（实际路径长度）。遇到 UNKNOWN/STALE 只对相关边界做一次有限定向观察，相关证据变化才重搜；已观测 BLOCKED 或横向偏移超出 maxLateralDrift 就停下报事实。分段/搜索/观察/transition 都有硬预算（maxTransitions 是同一 session 的累计上限，续接不重置）；未完成时返回 sessionId 和 continuation，必须原样续接才算同一意图。',
  argsDoc: '{"direction":"N|E|S|W","distance":20,"maxLateralDrift"?4,"allowed"?["walk","step","drop"],"historical"?true,"maxSegments"?8,"maxStepsPerSegment"?16,"maxTransitions"?(累计硬上限，默认覆盖 distance+16),"maxSearches"?8,"maxObservations"?4,"maxObservedCells"?128,"maxNoProgressSegments"?2,"sessionId"?,"deadlineMs"?}；distance 是水平格数（4–160）；方向只用四方向，对角线需先验证两侧 corner clearance，当前不接受；allowed 只能是 walk/step/drop；sessionId 只用于续接同一冻结意图（目标/方向/距离/允许模式改变必须新建）；deadlineMs 只能缩短当前调用期限；不做 region/until，也不自动施工或切模式。',
  timeoutMs: 60000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const allowedKeys = new Set([
      'direction', 'distance', 'maxLateralDrift', 'allowed', 'historical', 'maxSegments', 'maxStepsPerSegment',
      'maxTransitions', 'maxSearches', 'maxObservations', 'maxObservedCells', 'maxNoProgressSegments',
      'sessionId', 'deadlineMs',
    ]);
    const unknown = Object.keys(a).filter((key) => !allowedKeys.has(key));
    if (unknown.length) return { ok: false, error: `advance 不认识参数 ${unknown.join('、')}；只接受 ${[...allowedKeys].join('、')}` };
    const direction = String(a.direction ?? '').toUpperCase();
    if (DIAGONALS.has(direction)) return { ok: false, error: `暂不支持对角线 ${direction}：对角移动必须先验证两侧 corner clearance；当前只用 N/E/S/W，或分两段正交推进` };
    if (!CARDINAL_DIRECTIONS.includes(direction as CardinalDirection)) return { ok: false, error: 'direction 需要 N、E、S 或 W' };
    const distance = a.distance;
    if (!Number.isInteger(distance) || distance < 4 || distance > 160) return { ok: false, error: 'distance 需要 4–160 的整数水平格数' };
    const drift = a.maxLateralDrift;
    if (drift !== undefined && (!Number.isInteger(drift) || drift < 0 || drift > 32)) return { ok: false, error: 'maxLateralDrift 需要 0–32 的整数' };
    const allowedRaw = a.allowed === undefined ? MOVE_MODES : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((kind) => !MOVE_MODES.includes(kind as MoveMode))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop；不接受 dig/place/pillar/swim/boat' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    const ints: [string, number, number, number][] = [
      ['maxSegments', 1, 16, 8], ['maxStepsPerSegment', 1, 32, 16], ['maxTransitions', 1, 256, 96],
      ['maxSearches', 1, 32, 8], ['maxObservations', 0, 8, 4], ['maxObservedCells', 0, 512, 128],
      ['maxNoProgressSegments', 1, 8, 2],
    ];
    for (const [key, min, max] of ints) {
      const value = a[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        return { ok: false, error: `${key} 需要 ${min}–${max} 的整数` };
      }
    }
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) {
      return { ok: false, error: 'sessionId 需要非空字符串；续接时必须原样传回回执里的 sessionId' };
    }
    if (a.deadlineMs !== undefined && (typeof a.deadlineMs !== 'number' || !Number.isFinite(a.deadlineMs) || a.deadlineMs <= 0)) {
      return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    }
    // 累计 transition 预算默认覆盖一次直线推进所需步数，避免默认 96 在 160 格请求上提前耗尽。
    const defaultTransitions = Math.min(256, Math.max(96, distance + 16));
    return {
      ok: true,
      args: {
        direction: direction as CardinalDirection,
        distance,
        maxLateralDrift: (drift as number | undefined) ?? 4,
        allowed: [...new Set(allowedRaw as MoveMode[])],
        historical: a.historical !== false,
        maxSegments: (a.maxSegments as number | undefined) ?? 8,
        maxStepsPerSegment: (a.maxStepsPerSegment as number | undefined) ?? 16,
        maxTransitions: (a.maxTransitions as number | undefined) ?? defaultTransitions,
        maxSearches: (a.maxSearches as number | undefined) ?? 8,
        maxObservations: (a.maxObservations as number | undefined) ?? 4,
        maxObservedCells: (a.maxObservedCells as number | undefined) ?? 128,
        maxNoProgressSegments: (a.maxNoProgressSegments as number | undefined) ?? 2,
        ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
        ...(a.deadlineMs === undefined ? {} : { deadlineMs: a.deadlineMs }),
      },
    };
  },
  async run(ctx, args) {
    const allowed = args.allowed === undefined ? [...MOVE_MODES] : args.allowed;
    const historical = args.historical !== false;
    const maxLateralDrift = args.maxLateralDrift ?? 4;
    const outcome = await runMovementCoordinator(ctx, {
      intent: {
        kind: 'advance', direction: args.direction, distance: args.distance,
        maxLateralDrift, allowed, historical,
      },
      maxSegments: args.maxSegments ?? 8,
      maxStepsPerSegment: args.maxStepsPerSegment ?? 16,
      maxTransitions: args.maxTransitions ?? Math.min(256, Math.max(96, args.distance + 16)),
      invocationMaxTransitions: Math.min(
        args.maxTransitions ?? Math.min(256, Math.max(96, args.distance + 16)),
        (args.maxSegments ?? 8) * (args.maxStepsPerSegment ?? 16),
      ),
      maxSearches: args.maxSearches ?? 8,
      maxObservations: args.maxObservations ?? 4,
      maxObservedCells: args.maxObservedCells ?? 128,
      maxNoProgressSegments: args.maxNoProgressSegments ?? 2,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }),
      allowUnknownCorridor: false,
    });
    return coordinatorResult(outcome, {
      requestedDirection: args.direction,
      requestedDistance: args.distance,
      maxLateralDrift,
      allowed,
      historical,
    });
  },
};
