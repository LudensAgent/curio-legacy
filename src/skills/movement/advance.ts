import { coordinatorResult, runMovementCoordinator } from './coordinator.ts';
import { COMPASS_DIRECTIONS, MOVE_MODES, type CompassDirection, type MovementIntent, type MoveMode } from './session.ts';
import { obj, type Skill } from '../types.ts';

type AdvanceArgs = {
  direction: CompassDirection;
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

/**
 * 方向推进的公开意图入口。方向与距离冻结在 session 里；waypoint 只是中间执行目标，
 * 不会覆盖原意图。Coordinator 负责有界分段、边界观察、实测验收与累计进展。
 */
export const advance: Skill<AdvanceArgs> = {
  name: 'advance',
  description: '朝 N/NE/E/SE/S/SW/W/NW 之一水平推进指定距离。方向与距离冻结，宿主按冻结方向派生 waypoint 并分段执行已验证的 walk/step/drop（当前已加载方块可即时确认缺失证据），每步用实测位置确认；普通台阶、分数顶面和合理小落差由宿主处理，不挖、不放、不搭桥，也不因绕路改方向。遇到水/超过 2 格的缺口不会自己涉水或搭桥：要过就用 travel_to / explore_toward 带 swim:true / place（advance 不接受这两个授权）。对角由宿主按已确认的 diagonal walk 边执行，证据不足时走正交绕行，不斜穿阻挡或未确认格。回执报告 along（沿方向实测进度）、lateral（横向偏移）、horizontalNet（水平净位移）和实际路线；遇到未观察边界或已知阻挡会有限绕行/观察，确实无法继续才停下并保留 sessionId 供续接。内部预算按距离和实际进展自适应，普通调用不需要填写。',
  catalog: '{"direction":"N|NE|E|SE|S|SW|W|NW","distance":1-160}：朝一个方向走一段；宿主处理台阶、合理小落差和有限绕行，不挖不放',
  argsDoc: '{"direction":"N|NE|E|SE|S|SW|W|NW","distance":1-160}。旧参数 allowed/historical/maxLateralDrift/maxSegments/maxStepsPerSegment/maxTransitions/maxSearches/maxObservations/maxObservedCells/maxNoProgressSegments/sessionId/deadlineMs 仍兼容，但宿主会按距离和实际进展给默认值；只有想收窄授权或显式续接时才需要填写。distance 是沿方向的实际水平格数。',
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
    if (!COMPASS_DIRECTIONS.includes(direction as CompassDirection)) return { ok: false, error: 'direction 需要 N、NE、E、SE、S、SW、W 或 NW' };
    const distance = a.distance;
    if (!Number.isInteger(distance) || distance < 1 || distance > 160) return { ok: false, error: 'distance 需要 1–160 的整数水平格数' };
    const drift = a.maxLateralDrift;
    if (drift !== undefined && (!Number.isInteger(drift) || drift < 0 || drift > 32)) return { ok: false, error: 'maxLateralDrift 需要 0–32 的整数' };
    const allowedRaw = a.allowed === undefined ? MOVE_MODES : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((kind) => !MOVE_MODES.includes(kind as MoveMode))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop、jump、ladder；不接受 dig/place/pillar/swim/boat' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    const ints: [string, number, number][] = [
      ['maxSegments', 1, 64], ['maxStepsPerSegment', 1, 32], ['maxTransitions', 1, 2048],
      ['maxSearches', 1, 128], ['maxObservations', 0, 64], ['maxObservedCells', 0, 4096],
      ['maxNoProgressSegments', 1, 8],
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
    // 这些只是宿主的防失控预算，按距离和斜向路径长度给默认值；普通调用不需要填写。
    // 斜向在正交格网上要走 L 形，实际 transition 接近两轴之和，不能按直线距离只给一份。
    const defaultTransitions = Math.min(2048, Math.max(96, Math.ceil(distance * 2) + 32));
    return {
      ok: true,
      args: {
        direction: direction as CompassDirection,
        distance,
        maxLateralDrift: (drift as number | undefined) ?? Math.min(16, Math.max(4, Math.ceil(distance / 8))),
        allowed: [...new Set(allowedRaw as MoveMode[])],
        historical: a.historical !== false,
        maxSegments: (a.maxSegments as number | undefined) ?? Math.min(64, Math.max(4, Math.ceil(distance / 8))),
        maxStepsPerSegment: (a.maxStepsPerSegment as number | undefined) ?? 24,
        maxTransitions: (a.maxTransitions as number | undefined) ?? defaultTransitions,
        maxSearches: (a.maxSearches as number | undefined) ?? Math.min(128, 8 + Math.ceil(distance / 8)),
        maxObservations: (a.maxObservations as number | undefined) ?? Math.min(64, 4 + Math.ceil(distance / 16)),
        maxObservedCells: (a.maxObservedCells as number | undefined) ?? Math.min(4096, 128 + distance * 8),
        maxNoProgressSegments: (a.maxNoProgressSegments as number | undefined) ?? 4,
        ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
        ...(a.deadlineMs === undefined ? {} : { deadlineMs: a.deadlineMs }),
      },
    };
  },
  async run(ctx, args) {
    const allowed = args.allowed === undefined ? [...MOVE_MODES] : args.allowed;
    const historical = args.historical !== false;
    const maxLateralDrift = args.maxLateralDrift ?? Math.min(16, Math.max(4, Math.ceil(args.distance / 8)));
    const maxTransitions = args.maxTransitions ?? Math.min(2048, Math.max(96, Math.ceil(args.distance * 2) + 32));
    const maxSegments = args.maxSegments ?? Math.min(64, Math.max(4, Math.ceil(args.distance / 8)));
    const maxStepsPerSegment = args.maxStepsPerSegment ?? 24;
    const intent: MovementIntent = {
      kind: 'advance', direction: args.direction, distance: args.distance,
      maxLateralDrift, allowed, historical,
    };
    const outcome = await runMovementCoordinator(ctx, {
      intent,
      maxSegments,
      maxStepsPerSegment,
      maxTransitions,
      invocationMaxTransitions: Math.min(maxTransitions, maxSegments * maxStepsPerSegment),
      maxSearches: args.maxSearches ?? Math.min(128, 8 + Math.ceil(args.distance / 8)),
      maxObservations: args.maxObservations ?? Math.min(64, 4 + Math.ceil(args.distance / 16)),
      maxObservedCells: args.maxObservedCells ?? Math.min(4096, 128 + args.distance * 8),
      maxNoProgressSegments: args.maxNoProgressSegments ?? 4,
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
