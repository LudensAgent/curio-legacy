import { FEET_ARRIVAL_TOLERANCE, type Vec3Like } from '../../adapter/types.ts';

/**
 * 移动目标的唯一语义来源。两种目标不能互相顶替：
 *
 * - `cell`：调用者要走到某个方块格的脚位（整数 x/z）。格内的实际站位不是语义的一部分；
 *   搜索仍从实测脚位派生同一格内的连续格点，完成判定按“脚所在格 + 脚高”。
 * - `feet`：调用者要走到一个精确连续脚位（分数 x/z）。搜索、执行和完成判定都必须使用
 *   这个点本身；不能用格心、附近格或吸附后的支撑面代替。
 *
 * `requested` 始终保存调用者原始写法；`footY` 是请求的脚高，或在拥有“近似候选”语义的
 * 边界（go_near/approach_visible）里由该边界显式解析出的真实支撑面。这里不做任何吸附。
 */
/** travel_to 的已验证到达条件；只改变验收谓词，不改写搜索目的地。 */
export type NavigationArrival = { radius: number; metric: 'horizontal' | '3d' };

export type NavigationGoal = (
  | {
      kind: 'cell';
      requested: Vec3Like;
      cell: { x: number; z: number };
      footY: number;
    }
  | {
      kind: 'feet';
      requested: Vec3Like;
      feet: Vec3Like;
    }
) & { arrival?: NavigationArrival };

export type NavigationTargetKind = NavigationGoal['kind'];

/** 旧 cell 目标的脚高完成容差，保持与基线一致；feet 目标另有自己的物理精度。 */
export const CELL_FOOT_TOLERANCE = 0.01;

/** 请求边界只按整数 x/z 判定一次格目标；内部调用不得再从分数值反推语义。 */
export const targetKindOf = (to: Vec3Like): NavigationTargetKind =>
  Number.isInteger(to.x) && Number.isInteger(to.z) ? 'cell' : 'feet';

export function goalOf(to: Vec3Like): NavigationGoal {
  if (!Number.isInteger(to.x) || !Number.isInteger(to.z)) {
    return { kind: 'feet', requested: { ...to }, feet: { ...to } };
  }
  return {
    kind: 'cell',
    requested: { ...to },
    cell: { x: Math.floor(to.x), z: Math.floor(to.z) },
    footY: to.y,
  };
}

/** 明确的连续脚位目标；不经过整数 x/z 猜测。 */
export function feetGoal(feet: Vec3Like): NavigationGoal {
  return { kind: 'feet', requested: { ...feet }, feet: { ...feet } };
}

/** 已知目标格和脚高时构造格目标（go_near/approach_visible/advance 路点）。 */
export function cellGoal(cell: { x: number; z: number }, footY: number, requested: Vec3Like): NavigationGoal {
  return { kind: 'cell', requested: { ...requested }, cell: { x: Math.floor(cell.x), z: Math.floor(cell.z) }, footY };
}

/** 恢复会话意图时使用已冻结的 targetKind，不重新猜测。 */
export function goalFromIntent(to: Vec3Like, kind: NavigationTargetKind, arrival?: NavigationArrival): NavigationGoal {
  const completion = arrival === undefined ? {} : { arrival: { ...arrival } };
  return kind === 'cell'
    ? { kind: 'cell', requested: { ...to }, cell: { x: Math.floor(to.x), z: Math.floor(to.z) }, footY: to.y, ...completion }
    : { kind: 'feet', requested: { ...to }, feet: { ...to }, ...completion };
}

/**
 * 交给库搜索的连续目标点：格目标取“实测起点同一格内偏移”的格点，
 * 保证与起点相差整数格；连续目标保持原样。
 */
export function stanceFor(goal: NavigationGoal, from: Vec3Like): Vec3Like {
  if (goal.kind === 'feet') return { ...goal.feet };
  return {
    x: from.x + (goal.cell.x - Math.floor(from.x)),
    y: goal.footY,
    z: from.z + (goal.cell.z - Math.floor(from.z)),
  };
}

/** 用于摘要/边界距离的单一目标锚点；格目标是格心脚位，连续目标是精确点。 */
export function anchorOf(goal: NavigationGoal): Vec3Like {
  return goal.kind === 'cell'
    ? { x: goal.cell.x + 0.5, y: goal.footY, z: goal.cell.z + 0.5 }
    : { ...goal.feet };
}

/**
 * 连续脚位是否被实测位置满足。水平 0.12 / 垂直 0.05 与库声明的
 * GROUNDED_ARRIVAL_DEFAULTS 一致，是身体控制的实际精度，不是放宽目标。
 */
export function feetReached(point: Vec3Like, measured: Vec3Like, onGround: boolean): boolean {
  if (!onGround) return false;
  return Math.hypot(measured.x - point.x, measured.z - point.z) <= FEET_ARRIVAL_TOLERANCE.horizontal
    && Math.abs(measured.y - point.y) <= FEET_ARRIVAL_TOLERANCE.vertical;
}

/** 目标格是否被实测位置满足：脚所在格一致且脚高在既有 0.01 容差内。 */
export function cellReached(point: Vec3Like, measured: Vec3Like, onGround: boolean): boolean {
  if (!onGround) return false;
  return Math.floor(measured.x) === Math.floor(point.x)
    && Math.floor(measured.z) === Math.floor(point.z)
    && Math.abs(measured.y - point.y) <= CELL_FOOT_TOLERANCE;
}

/**
 * 冻结目标的完成判定；格目标与连续目标使用不同谓词。
 * `airborneLadderGoal` 只允许目标脚位本身由已证明的攀爬源支撑时免除
 * onGround：真实停在梯子上通常 onGround=false，位置已满足仍应完成。
 */
export function goalReached(
  goal: NavigationGoal,
  measured: Vec3Like,
  onGround: boolean,
  airborneLadderGoal = false,
): boolean {
  if (goal.arrival !== undefined) {
    const horizontal = Math.hypot(Math.floor(measured.x) - Math.floor(goal.requested.x), Math.floor(measured.z) - Math.floor(goal.requested.z));
    const distance = goal.arrival.metric === 'horizontal' ? horizontal
      : Math.hypot(horizontal, Math.floor(measured.y) - Math.floor(goal.requested.y));
    return onGround && distance <= goal.arrival.radius;
  }
  const grounded = onGround || airborneLadderGoal;
  return goal.kind === 'cell'
    ? cellReached({ x: goal.cell.x + 0.5, y: goal.footY, z: goal.cell.z + 0.5 }, measured, grounded)
    : feetReached(goal.feet, measured, grounded);
}
