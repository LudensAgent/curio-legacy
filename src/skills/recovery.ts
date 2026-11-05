import type { Vec3Like } from '../adapter/types.ts';
import { facingOfYaw, feetCell, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces } from '../perception/surroundings.ts';
import type { SkillCtx } from './types.ts';
import { readPoint } from './walk-route.ts';

type NavArrival = { kind: 'exact' } | { kind: 'near'; radius: number };

export type RecoveryContext = { skill: string; args: Record<string, unknown>; target?: Vec3Like; position?: Vec3Like; entityId?: number; allowPlace?: boolean; allowDig?: boolean; climb?: { height: number; spent: number; startY: number }; arrival?: NavArrival; fragmentId?: string; deadlineMs?: number };

/** 恢复时只有这三个库入口能继承/重做同一导航委托；其他动作不能静默替换目标或完成条件。 */
const NAVIGATION_SKILLS = new Set(['walk_route', 'walk_to', 'walk_known_route']);
/**
 * 新导航恢复不能用其他直接移动/导航动作绕过原后端、目标与手段。
 * 一个显式有限集合：旧寻路/单步/按键/旧路线，以及会直接改变身体位置或移动方式的
 * 游泳、旅行、沿矿道、下行、攀爬、载具、上浮和下潜。普通非恢复调用不受影响。
 */
const NAVIGATION_BYPASS = new Set([
  'goto', 'step', 'move', 'press_keys', 'walk_route',
  'swim_to', 'travel', 'follow_passage', 'descend', 'climb_up', 'ride', 'surface', 'dive',
]);

/** 组合施工必须由原委托本身授权；其他动作失败不能借恢复自动引入挖放/搭柱组合。 */
const COMBINATION_SKILLS = new Set(['excavate_path', 'climb_up']);
/** 水面/载具的入口、出口、方式与时间预算在恢复中保持不变。 */
const WATER_SKILLS = new Set(['travel', 'swim_to', 'surface', 'ride', 'dive']);
/** 原始按键控制不能由其他委托的恢复升级获得。 */
const RAW_INPUT_SKILLS = new Set(['press_keys', 'move']);
/** 只读观察不改变身体或世界，任何恢复都可先看再决定。 */
const OBSERVATION_SKILLS = new Set(['look', 'look_around', 'wait', 'inspect_block', 'assess_landings', 'spatial_query']);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pointEquals = (a: Vec3Like | undefined, b: Vec3Like | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
/** 原动作参数还没经过该技能校验，可能写成数组/字符串；恢复核对时按同样的三种写法解析。 */
const rawPoint = (value: unknown): Vec3Like | undefined => {
  if (typeof value === 'string') {
    const parts = value.trim().split(/[,， ]+/).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], z: parts[2] } : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], z: parts[2] } : undefined;
  }
  return worldPoint(value);
};
const travelTarget = (value: unknown): string | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const point = value as Record<string, unknown>;
    return [point.x, point.y, point.z].every((item) => typeof item === 'number' && Number.isFinite(item)) ? `${point.x},${point.y},${point.z}`
      : [point.x, point.z].every((item) => typeof item === 'number' && Number.isFinite(item)) ? `${point.x},${point.z}` : undefined;
  }
  return typeof value === 'string' ? value.trim() : undefined;
};
const rideTarget = (value: unknown): { x: number; z: number } | undefined => {
  if (typeof value === 'string') {
    const match = value.match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)\s*$/);
    return match ? { x: +match[1], z: +match[2] } : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const point = value as Record<string, unknown>;
    return finite(point.x) && finite(point.z) ? { x: point.x, z: point.z } : undefined;
  }
  return undefined;
};
const activeKeys = (value: unknown): string[] => !value || typeof value !== 'object' || Array.isArray(value) ? []
  : Object.entries(value as Record<string, unknown>).filter(([, on]) => on === true).map(([key]) => key).sort();

/** 原动作校验器里的默认值：恢复核对范围时按同一套默认值比较，不把“没写”当成扩权。 */
function excavationScope(args: Record<string, unknown>) {
  return {
    entry: args.entry,
    mode: typeof args.mode === 'string' ? args.mode : 'stairs',
    direction: args.direction,
    steps: Number.isInteger(args.steps) ? args.steps as number : 4,
  };
}

function climbScope(args: Record<string, unknown>) {
  const untilExit = (args.until_exit ?? args.untilExit) === true;
  const untilSky = typeof args.until_sky === 'boolean' ? args.until_sky
    : typeof args.untilSky === 'boolean' ? args.untilSky : args.height === undefined && !untilExit;
  return {
    height: Number.isInteger(args.height) ? args.height as number : untilSky || untilExit ? 16 : 3,
    untilSky,
    untilExit,
  };
}

/** 原 failure 里的绝对期限只在失败交接边界校验一次；正值绝对 epoch，不当作时长。 */
function recoveryDeadline(value: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: 'failure.args.deadlineMs 必须是正的绝对 epoch 毫秒' };
}

/** World coordinates only; never guess at/to relative arrays or coerce null into zero. */
export function worldPoint(value: unknown): Vec3Like | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const point = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every((key) => typeof point[key] === 'number' && Number.isFinite(point[key]))
    ? { x: point.x as number, y: point.y as number, z: point.z as number } : undefined;
}

export function recoveryContext(value: unknown): RecoveryContext | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'failure 须为原动作的失败记录对象' };
  const raw = value as Record<string, unknown>;
  if (typeof raw.skill !== 'string' || !raw.skill.trim() || !raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args)) return { error: 'failure 需要原动作 skill 和原参数 args' };
  const skill = raw.skill.trim();
  let args = raw.args as Record<string, unknown>;
  let navTarget: Vec3Like | undefined;
  let arrival: NavArrival | undefined;
  let fragmentId: string | undefined;
  let deadlineMs: number | undefined;
  const providedTarget = worldPoint(raw.target);
  if (raw.target !== undefined && !providedTarget) return { error: 'failure.target 须为明确的世界坐标 {x,y,z}，不能将相对 at/to 当作目标' };
  if (skill === 'walk_to') {
    const to = readPoint(args.to);
    if (to === null) return { error: 'failure.args.to 必须是 walk_to 的有限世界坐标（保留小数与负数）' };
    const ra = args.arrival;
    if (ra === null || typeof ra !== 'object' || Array.isArray(ra)) return { error: 'failure.args.arrival 必须是 walk_to 的原始到达条件' };
    const kind = (ra as Record<string, unknown>).kind;
    if (kind === 'exact') arrival = { kind: 'exact' };
    else if (kind === 'near') {
      const radius = (ra as Record<string, unknown>).radius;
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) return { error: 'failure.args.arrival.radius 必须是正的有限数字' };
      arrival = { kind: 'near', radius };
    } else return { error: 'failure.args.arrival.kind 必须是 exact 或 near' };
    const deadline = recoveryDeadline(args.deadlineMs);
    if (!deadline.ok) return { error: deadline.error };
    // 实际失败记录若带 target，只能是与原 to 完全相同的绝对目标；不静默改目标。
    if (providedTarget && (providedTarget.x !== to.x || providedTarget.y !== to.y || providedTarget.z !== to.z)) {
      return { error: 'failure.target 必须与 walk_to 原绝对目标一致，不能替换目标' };
    }
    navTarget = to;
    deadlineMs = deadline.value;
    args = { ...args, to, arrival, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
  } else if (skill === 'walk_route') {
    // walk_route 的目标就是调用者给定的路线末点；原请求的点列必须整条保留，
    // 恢复不能重选路线、缩短点列或把末点换成当前位置。
    if (!Array.isArray(args.points)) return { error: 'failure.args.points 必须是 walk_route 的原路线点列' };
    const parsed = args.points.map(readPoint);
    const badIndex = parsed.findIndex((point) => point === null);
    if (badIndex >= 0) return { error: `failure.args.points[${badIndex}] 必须是有限世界坐标` };
    const points = parsed.filter((point): point is Vec3Like => point !== null);
    const last = points[points.length - 1];
    if (last === undefined) return { error: 'failure.args.points 至少需要一个点' };
    const deadline = recoveryDeadline(args.deadlineMs);
    if (!deadline.ok) return { error: deadline.error };
    if (providedTarget && !pointEquals(providedTarget, last)) {
      return { error: 'failure.target 必须与 walk_route 原路线末点一致，不能替换目标' };
    }
    navTarget = last;
    deadlineMs = deadline.value;
    args = { ...args, points, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
  } else if (skill === 'walk_known_route') {
    if (typeof args.fragmentId !== 'string' || args.fragmentId.length === 0) return { error: 'failure.args.fragmentId 必须是原路线 ID' };
    const deadline = recoveryDeadline(args.deadlineMs);
    if (!deadline.ok) return { error: deadline.error };
    fragmentId = args.fragmentId;
    deadlineMs = deadline.value;
    // known route 的终点来自实际失败记录；没有就保持缺失，不由 fragment 几何臆造。
    navTarget = providedTarget;
    args = { ...args, fragmentId, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
  }
  const target = navTarget ?? providedTarget, position = worldPoint(raw.position);
  if (raw.position !== undefined && !position) return { error: 'failure.position 须为明确的世界坐标' };
  const entityId = raw.entityId ?? args.entityId;
  if (entityId !== undefined && (!Number.isSafeInteger(entityId) || Number(entityId) < 0)) return { error: 'failure.entityId 须为原实体整数 ID' };
  let climb: RecoveryContext['climb'];
  if (raw.climb !== undefined) {
    const ledger = raw.climb;
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return { error: 'failure.climb 须为原高度额度账本' };
    const { height, spent, startY } = ledger as Record<string, unknown>;
    if (!finite(height) || height <= 0 || !finite(spent) || spent < 0 || typeof startY !== 'number') return { error: 'failure.climb 需要正的高度额度、非负已用高度和逻辑起点 startY' };
    climb = { height, spent, startY };
  }
  const { allowPlace: _allowPlace, allowDig: _allowDig, ...rest } = raw;
  return { ...rest, skill, args, ...(target ? { target } : {}), ...(position ? { position } : {}), ...(entityId !== undefined ? { entityId: Number(entityId) } : {}), ...(climb ? { climb } : {}),
    ...(arrival ? { arrival } : {}), ...(fragmentId !== undefined ? { fragmentId } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(raw.allowPlace === true ? { allowPlace: true } : {}), ...(raw.allowDig === true ? { allowDig: true } : {}) };
}

/** Shared after primitive validation, including code, steps and nested learned calls. */
export function constrainRecoveryAction(ctx: SkillCtx, name: string, values: Record<string, unknown>) {
  const scope = ctx.recovery;
  if (!scope) return values;
  const original = scope.args, args = { ...values };
  // 原委托的绝对期限跨恢复保留；过期后恢复不能借自己的超时重新获得时间。
  if (scope.deadlineMs !== undefined && Date.now() >= scope.deadlineMs) throw new Error('原委托的期限已过，恢复不能延长执行');
  // 自动准备与原始按键都不在恢复的默认可得范围内。
  if (args.make === true && original.make !== true) throw new Error('原动作没有授权自动准备（make），恢复不能开启');
  if (original.make === false) args.make = false;
  // 新导航恢复必须沿用同一原语：既不能换成旧寻路/单步/按键，也不能从旧动作
  // 静默切进新导航（后者的目标/完成条件不等价）。普通非恢复调用不受影响。
  if (NAVIGATION_SKILLS.has(scope.skill) && NAVIGATION_BYPASS.has(name) && name !== scope.skill) {
    throw new Error(`恢复「${scope.skill}」必须沿用原导航动作，不能用 ${name} 绕过原后端、目标或手段`);
  }
  if (NAVIGATION_SKILLS.has(name) && name !== scope.skill) {
    throw new Error(`恢复「${scope.skill}」不能改用 ${name}：缺少等价的原始目标与完成条件`);
  }
  if (name === 'walk_route') {
    if (scope.skill !== 'walk_route') throw new Error('恢复 walk_route 只能沿用原导航委托');
    const originalPoints = Array.isArray(original.points) ? original.points.map(readPoint) : [];
    const points = Array.isArray(args.points) ? args.points.map(readPoint) : [];
    const same = originalPoints.length > 0 && points.length === originalPoints.length
      && points.every((point, index) => point !== null && pointEquals(point, originalPoints[index] ?? undefined));
    if (!same) throw new Error('恢复 walk_route 必须保留原路线点列与末点，不能重选路线或替换目标');
    if (scope.deadlineMs !== undefined) {
      if (args.deadlineMs === undefined) args.deadlineMs = scope.deadlineMs;
      else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > scope.deadlineMs) throw new Error('恢复 walk_route 不能延长原绝对期限');
    }
  }
  if (name === 'walk_to') {
    const to = readPoint(args.to);
    if (!scope.target) throw new Error('恢复 walk_to 缺少原绝对目标，不能自行发明目标');
    if (to === null || to.x !== scope.target.x || to.y !== scope.target.y || to.z !== scope.target.z) throw new Error('恢复 walk_to 必须使用失败动作的原绝对目标');
    const requested = args.arrival as NavArrival | undefined;
    const same = requested !== undefined && scope.arrival !== undefined && requested.kind === scope.arrival.kind
      && (requested.kind === 'exact' || (requested.kind === 'near' && scope.arrival.kind === 'near' && requested.radius === scope.arrival.radius));
    if (!same) throw new Error('恢复 walk_to 必须保留原 arrival 种类与 near 半径，不能替换完成条件');
    if (scope.deadlineMs !== undefined) {
      if (args.deadlineMs === undefined) args.deadlineMs = scope.deadlineMs;
      else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > scope.deadlineMs) throw new Error('恢复 walk_to 不能延长原绝对期限');
    }
  }
  if (name === 'walk_known_route') {
    if (!scope.fragmentId) throw new Error('恢复 walk_known_route 缺少原 fragmentId，不能自行发明路线');
    if (args.fragmentId !== scope.fragmentId) throw new Error('恢复 walk_known_route 必须使用失败动作的原 fragmentId');
    if (scope.deadlineMs !== undefined) {
      if (args.deadlineMs === undefined) args.deadlineMs = scope.deadlineMs;
      else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > scope.deadlineMs) throw new Error('恢复 walk_known_route 不能延长原绝对期限');
    }
  }
  // 只读观察不改变身体或世界，任何恢复都可先看，不扩大物理委托。
  if (OBSERVATION_SKILLS.has(name)) return args;
  // 水面/载具：恢复沿用原入口、出口、方式和时间预算；不能在失败后换成别的移动/施工方式。
  if (WATER_SKILLS.has(scope.skill)) {
    if (name !== scope.skill) throw new Error(`恢复「${scope.skill}」不能改用 ${name}：水面/载具的目标、出口或时间预算不能被恢复扩大`);
    if (name === 'travel') {
      if (travelTarget(args.to) !== travelTarget(original.to ?? original.target)) throw new Error('恢复 travel 必须保留原目标');
      if (original.noBoat === true && args.noBoat !== true) throw new Error('原出行没有授权使用船，恢复不能改用船');
      if (args.place === true && original.place !== true) throw new Error('原出行没有授权垫方块，恢复不能增加放置');
      const origin = worldPoint(original.headingOrigin);
      if (origin) {
        if (!pointEquals(worldPoint(args.headingOrigin), origin)) throw new Error('恢复 travel 必须保留原方向起点，不能把目标移到当前位置');
        args.headingOrigin = origin;
      }
    }
    if (name === 'swim_to') {
      if (!pointEquals(rawPoint(args.xyz), rawPoint(original.xyz ?? original.to ?? original.at))) throw new Error('恢复 swim_to 必须使用原目标坐标');
      if (finite(original.timeoutMs) && finite(args.timeoutMs) && args.timeoutMs > original.timeoutMs) throw new Error('恢复 swim_to 不能延长原时间预算');
    }
    if (name === 'surface' && finite(original.timeoutMs) && finite(args.timeoutMs) && args.timeoutMs > original.timeoutMs) {
      throw new Error('恢复 surface 不能延长原时间预算');
    }
    if (name === 'ride') {
      const to = rideTarget(args.to), from = rideTarget(original.to);
      const sameTo = to === undefined && from === undefined
        || !!to && !!from && to.x === from.x && to.z === from.z;
      if (!sameTo) throw new Error('恢复 ride 必须保留原目标');
      const direction = typeof original.direction === 'string' ? original.direction.toUpperCase() : undefined;
      if (args.direction !== direction) throw new Error('恢复 ride 必须保留原方向');
      if (finite(original.distance) && finite(args.distance) && args.distance > original.distance) throw new Error('恢复 ride 不能扩大原距离额度');
      const until = typeof original.until === 'string' && original.until.trim() ? original.until.trim().toLowerCase().slice(0, 80) : undefined;
      if (args.until !== until) throw new Error('恢复 ride 必须保留原停止条件');
    }
    if (name === 'dive') {
      if (!pointEquals(rawPoint(args.xyz), rawPoint(original.xyz ?? original.to ?? original.at))) throw new Error('恢复 dive 必须使用原目标格');
      const minOxygen = finite(original.min_oxygen) ? original.min_oxygen : 8;
      if (finite(args.min_oxygen) && args.min_oxygen < minOxygen) throw new Error('恢复 dive 不能降低原氧气下限');
    }
  }
  // 原始按键（press_keys）是独立的身体控制委托：其他动作的恢复不能升级成它。
  // api.move 的有界短推仍可作为恢复内的身体纠偏，但不能从按键委托新增按键或延长时间。
  if (name === 'press_keys' && scope.skill !== 'press_keys') throw new Error('恢复不能改用原始按键控制：原委托没有授权');
  if (scope.skill === 'press_keys' && name !== 'press_keys' && name !== 'move') {
    throw new Error(`恢复「press_keys」不能改用 ${name}：原始按键委托不能升级成其他移动或施工`);
  }
  if (scope.skill === 'press_keys' && RAW_INPUT_SKILLS.has(name)) {
    const extra = activeKeys(name === 'move' ? args : args.keys).filter((key) => !activeKeys(original.keys).includes(key));
    if (extra.length) throw new Error(`恢复按键不能新增原委托没有的 ${extra.join('、')}`);
    // press_keys 与 api.move 上限不同（50–10000 vs 50–1000），但恢复都只能缩短、
    // 不能超过原委托的按压时长；api.move 自己的入口校验再应用 1000ms 上限。
    if (finite(original.ms) && finite(args.ms) && args.ms > original.ms) throw new Error('恢复按键不能超过原按压时长');
  }
  const terrain = ['goto', 'step', 'explore'].includes(scope.skill) && original.dig === true;
  const placement = scope.skill === 'goto' ? (original.place ?? terrain) === true : terrain || scope.allowPlace === true;
  const tower = scope.skill === 'goto' ? placement && (original.tower ?? terrain) === true : placement;
  if (name === 'goto') {
    if (args.dig === true && !terrain) throw new Error('原动作没有授权挖穿或垫块，恢复不能升级为 dig:true');
    if (args.place === true && !placement) throw new Error('原动作没有授权放置，恢复不能增加放置');
    if (args.tower === true && !tower) throw new Error('原动作没有授权搭柱，恢复不能增加搭柱');
    if (!placement) args.place = false;
    if (!tower) args.tower = false;
    if (['goto', 'step', 'explore'].includes(scope.skill) && args.sprint === true && original.sprint !== true) throw new Error('原动作没有选择冲刺，恢复不能增加冲刺消耗');
    if (original.lead !== undefined && args.lead !== original.lead) throw new Error('恢复必须保留原带领对象');
    if (scope.target) {
      const match = typeof args.target === 'string' ? args.target.trim().split(/[,\s]+/).map(Number) : [];
      if (match.length !== 3 || !match.every(Number.isFinite) || match[0] !== scope.target.x || match[1] !== scope.target.y || match[2] !== scope.target.z) throw new Error('恢复 goto 必须使用失败动作的原绝对目标');
    }
    const avoid = Array.isArray(original.avoid) ? original.avoid.filter((item): item is string => typeof item === 'string') : [];
    args.avoid = [...new Set([...avoid, ...(Array.isArray(args.avoid) ? args.avoid : [])])];
  }
  if (name === 'dig_at' || name === 'place_at' || name === 'step') {
    if (name === 'dig_at' && scope.skill !== 'dig_at' && !terrain && scope.allowDig !== true) throw new Error('原委托没有授权挖掘，恢复不能改挖其他方块');
    if (name === 'place_at' && scope.skill !== 'place_at' && !placement) throw new Error('原委托没有授权支出方块；需要心智显式选择 allowPlace 才能放置');
    if (name === 'place_at' && scope.skill === 'goto' && !tower && Array.isArray(args.at) && args.at[0] === 0 && args.at[1] === 0 && args.at[2] === 0
      && !(typeof args.item === 'string' && args.item !== 'any' && attachmentFaces(args.item))) throw new Error('原动作没有授权搭柱，恢复不能原地垫高');
    if (name === scope.skill && scope.target) {
      const facing = (args.facing ?? facingOfYaw(ctx.adapter.eye()?.yaw ?? 0)) as Facing;
      const target = worldPoint(args.xyz) ?? (Array.isArray(args.at) && args.at.length === 3 ? toWorld(feetCell(ctx.adapter.state().pos), facing, args.at as [number, number, number]) : undefined);
      if (!target || target.x !== scope.target.x || target.y !== scope.target.y || target.z !== scope.target.z) throw new Error('恢复不能替换原动作的目标格');
    }
    if (name === 'dig_at' && args.fall === true && original.fall !== true) throw new Error('原委托没有允许 fall:true，恢复不能擅自接受坠落风险');
    if (name === 'dig_at' && scope.skill === 'dig_at') {
      for (const flag of ['wet', 'lava', 'own'] as const) if (args[flag] === true && original[flag] !== true) throw new Error(`原挖掘没有允许 ${flag}:true，恢复不能擅自打开`);
    }
    if (name === 'place_at' && scope.skill === 'place_at' && original.item !== undefined && args.item !== original.item) throw new Error('恢复必须保留原放置物品');
  }
  // 组合施工（有界开挖、搭柱爬升）只沿用同一原委托的剩余额度，不能由别的失败自动引入。
  if (COMBINATION_SKILLS.has(name) && scope.skill !== name) {
    throw new Error(`恢复「${scope.skill}」不能引入 ${name} 组合施工：需要原委托显式授权`);
  }
  if (name === 'excavate_path' && scope.skill === 'excavate_path') {
    const originalScope = excavationScope(original);
    if (args.entry !== originalScope.entry) throw new Error('恢复 excavate_path 必须使用原入口，不能另开入口');
    if (args.mode !== originalScope.mode || args.direction !== originalScope.direction) throw new Error('恢复 excavate_path 必须保留原方向与模式');
    if (!Number.isInteger(args.steps) || (args.steps as number) > originalScope.steps) throw new Error(`恢复 excavate_path 不能超过原 ${originalScope.steps} 步额度`);
  }
  if (name === 'climb_up' && scope.skill === 'climb_up') {
    const originalScope = climbScope(original);
    if (args.untilSky !== originalScope.untilSky || (args.untilExit === true) !== originalScope.untilExit) throw new Error('恢复 climb_up 必须保留原停止条件');
    const remaining = scope.climb ? Math.max(0, scope.climb.height - scope.climb.spent) : originalScope.height;
    if (remaining <= 0) throw new Error('恢复 climb_up 的原高度额度已用完，不能重新获得完整高度');
    if (!finite(args.height) || args.height > remaining) args.height = remaining;
  }
  // 通道式 dig 也不能由其他委托的恢复自动获得，且同一次委派只能沿用原方向/目标与更小的额度。
  if (name === 'dig') {
    if (scope.skill !== 'dig' && !terrain && scope.allowDig !== true) throw new Error('原委托没有授权挖掘，恢复不能改用 dig');
    if (scope.skill === 'dig') {
      if (original.target !== undefined) {
        const point = (value: unknown): Vec3Like | undefined => {
          const text = typeof value === 'string' ? value.trim() : '';
          const parts = text ? text.split(/[,， ]+/).map(Number) : [];
          const parsed = parts.length === 3 && parts.every(Number.isFinite) ? { x: Math.floor(parts[0]), y: Math.floor(parts[1]), z: Math.floor(parts[2]) } : worldPoint(value);
          return parsed ? { x: Math.floor(parsed.x), y: Math.floor(parsed.y), z: Math.floor(parsed.z) } : undefined;
        };
        const from = point(original.target), to = point(args.target);
        if (from && to ? !pointEquals(from, to) : String(original.target).trim() !== String(args.target ?? '').trim()) throw new Error('恢复 dig 必须使用原目标方块或地标');
        if ((original.block ?? undefined) !== (args.block ?? undefined) || (original.own === true) !== (args.own === true)) throw new Error('恢复 dig 必须保留原方块约束与归属条件');
      } else {
        if (args.target !== undefined || args.dir !== original.dir) throw new Error('恢复 dig 必须保留原挖掘方向');
        if (finite(original.blocks) && finite(args.blocks) && args.blocks > original.blocks) throw new Error('恢复 dig 不能超过原格数额度');
      }
      for (const flag of ['wet', 'lava'] as const) if (args[flag] === true && original[flag] !== true) throw new Error(`原挖掘没有允许 ${flag}:true，恢复不能擅自打开`);
    }
  }
  if (name === 'craft' && scope.skill !== 'craft') throw new Error('恢复不能隐式增加合成任务');
  if (name === 'explore' && scope.skill !== 'explore') throw new Error('恢复不能隐式增加探索任务');
  if (name === 'defend' || name === 'hit_entity' || name === 'interact') {
    const id = args.entityId ?? args.entity;
    // 实体也是原委托的一部分：没有指定实体时，恢复不能自己挑一个攻击/交互对象。
    if (scope.entityId === undefined && original.entity === undefined && original.entityId === undefined && original.target === undefined) {
      throw new Error('原委托没有指定实体，恢复不能自行选择交互或攻击对象');
    }
    if (scope.entityId !== undefined && id !== scope.entityId) throw new Error('恢复必须保留原实体 ID，不能改选同名或其他实体');
    if (scope.skill === name) {
      const originalEntity = original.entityId ?? original.entity;
      if (originalEntity !== undefined && id !== originalEntity) throw new Error('恢复必须保留原实体，不能改选其他目标');
    }
    if (name === 'defend' && original.target !== undefined && args.target !== original.target) throw new Error('恢复必须保留原目标种类');
    if (scope.skill === 'defend' && typeof original.target === 'string' && typeof id === 'number') {
      ctx.senses.refresh();
      const target = ctx.senses.perceivedEntities(32).find((entity) => entity.id === id && entity.perception !== 'heard');
      if (!target || target.name !== original.target) throw new Error('当前没有看见符合原种类的实体，恢复不能改打其他目标');
    }
  }
  if (original.make === false) args.make = false;
  return args;
}
