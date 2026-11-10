import type { Vec3Like } from '../../adapter/types.ts';
import { goalFromIntent, goalReached } from './goal.ts';
import type { CardinalDirection, MovementIntent, MovementProgress, MovementSession, StopReason } from './session.ts';

/** 与世界方向一致：N=-Z、E=+X、S=+Z、W=-X。 */
const BEARINGS: Record<CardinalDirection, { x: number; z: number }> = {
  N: { x: 0, z: -1 },
  E: { x: 1, z: 0 },
  S: { x: 0, z: 1 },
  W: { x: -1, z: 0 },
};

export const bearingOf = (direction: CardinalDirection) => ({ ...BEARINGS[direction] });

/**
 * 冻结方向上的有符号投影与横向偏移。distance 按水平世界距离（方块格）解释；
 * 斜向也先归一化，不按 X/Z 两轴各走多少重复计数（本版只开放四方向）。
 */
export function project(origin: Vec3Like, bearing: { x: number; z: number }, current: Vec3Like) {
  const dx = current.x - origin.x, dz = current.z - origin.z;
  return {
    along: dx * bearing.x + dz * bearing.z,
    lateral: Math.abs(dx * bearing.z - dz * bearing.x),
  };
}

export function progressOf(session: MovementSession, current: Vec3Like, sampledAt: number): MovementProgress {
  const dx = current.x - session.frozenOrigin.x;
  const dz = current.z - session.frozenOrigin.z;
  const horizontalNet = Math.hypot(dx, dz);
  const projection = session.bearing === undefined
    ? { along: 0, lateral: 0 }
    : project(session.frozenOrigin, session.bearing, current);
  return {
    along: round2(projection.along),
    lateral: round2(projection.lateral),
    horizontalNet: round2(horizontalNet),
    verticalDelta: round2(current.y - session.frozenOrigin.y),
    ...(session.intent.kind === 'advance' ? { remaining: round2(Math.max(0, session.intent.distance - projection.along)) } : {}),
    stagnationSegments: session.progress.stagnationSegments,
    lastProgressAt: session.progress.lastProgressAt,
  };
}

/**
 * 关闭条件只看实测位置与冻结目标语义：
 * - advance：沿冻结方向的进度达到 distance，且横向偏移未超授权；
 * - navigate 格目标：实测脚所在格一致且脚高在声明容差内；
 * - navigate 连续脚位：实测身体中心到精确脚位的水平/垂直距离在声明容差内。
 * `onGround` 是完成证据的一部分；悬空经过目标格不算到达。返回 null 表示尚未满足，也不是失败。
 */
export function closeReasonOf(
  session: MovementSession, current: Vec3Like, now: number, onGround = true,
): { reason: StopReason; detail: string } | null {
  const intent = session.intent;
  if (intent.kind === 'advance') {
    const projection = session.bearing === undefined
      ? { along: 0, lateral: 0 }
      : project(session.frozenOrigin, session.bearing, current);
    if (projection.lateral > intent.maxLateralDrift + 0.01) {
      return {
        reason: 'LATERAL_DRIFT',
        detail: `横向偏移 ${round2(projection.lateral)} 格超过授权 ${intent.maxLateralDrift} 格；不擅自改方向`,
      };
    }
    if (projection.along >= intent.distance - 0.01) {
      return {
        reason: 'DISTANCE_MET',
        detail: `沿 ${intent.direction} 已推进 ${round2(projection.along)} 格，达到请求距离 ${intent.distance} 格（横向偏移 ${round2(projection.lateral)} 格）`,
      };
    }
    return null;
  }
  const goal = goalFromIntent(intent.to, intent.targetKind);
  if (goalReached(goal, current, onGround)) {
    const where = `实测脚位 (${round2(current.x)},${round2(current.y)},${round2(current.z)})`;
    return goal.kind === 'cell'
      ? { reason: 'ARRIVED', detail: `${where} 在目标格 (${goal.cell.x},${goal.footY},${goal.cell.z})，脚高在容差内` }
      : { reason: 'ARRIVED', detail: `${where} 与精确脚位目标一致（水平/垂直容差内）` };
  }
  return null;
}

/**
 * 从冻结意图派生本段 waypoint。中间目标只是执行提示，不覆盖原意图。
 * - advance：沿冻结射线取“已推进 + 本段预算”处；Y 取该列已观测的、离当前脚高最近的站立面
 *   （footY），没观测过才用当前脚高。Y 只作搜索提示，实际脚高仍由 land-search 按落点几何解析；
 * - navigate：原目标不变，分段上限只限制本次执行步数。
 */
export function waypointOf(session: MovementSession, current: Vec3Like, maxStepsPerSegment: number,
  footY?: (x: number, z: number, aroundY: number) => number | null): Vec3Like {
  const intent = session.intent;
  if (intent.kind === 'navigate') return { ...intent.to };
  if (session.bearing === undefined) return { ...current };
  const { along } = project(session.frozenOrigin, session.bearing, current);
  const step = Math.max(1, Math.min(maxStepsPerSegment, intent.distance - along));
  const reach = Math.min(intent.distance, Math.max(0, along) + step);
  const x = roundTo(session.frozenOrigin.x + session.bearing.x * reach, 0.5);
  const z = roundTo(session.frozenOrigin.z + session.bearing.z * reach, 0.5);
  return { x, y: footY?.(Math.floor(x), Math.floor(z), current.y) ?? current.y, z };
}

export function summaryOf(intent: MovementIntent): string {
  return intent.kind === 'advance'
    ? `沿 ${intent.direction} 推进 ${intent.distance} 格（横向授权 ${intent.maxLateralDrift} 格，${intent.allowed.join('/')}${intent.historical ? '，可用历史体素候选' : ''}）`
    : `到脚位 (${intent.to.x},${intent.to.y},${intent.to.z})（${intent.allowed.join('/')}${intent.historical ? '，可用历史体素候选' : ''}）`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
