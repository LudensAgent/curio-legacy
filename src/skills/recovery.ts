import type { Vec3Like } from '../adapter/types.ts';
import { facingOfYaw, feetCell, toWorld, type Facing } from '../perception/local.ts';
import type { SkillCtx } from './types.ts';

export type RecoveryContext = { skill: string; args: Record<string, unknown>; target?: Vec3Like; position?: Vec3Like; entityId?: number; allowPlace?: boolean; allowDig?: boolean; climb?: { height: number; spent: number; startY: number }; deadlineMs?: number };

/** 恢复时只有 navigate_to/advance 能继承/重做同一导航委托；其他动作不能静默替换目标或完成条件。 */
const NAVIGATION_SKILLS = new Set(['navigate_to', 'advance']);
/**
 * 新导航恢复不能用其他直接移动/导航动作绕过原后端、目标与手段。
 * 一个显式有限集合：旧路线/单步/按键，以及会直接改变身体位置或移动方式的
 * 游泳、旅行、沿方向探索、下行、攀爬、载具、上浮和下潜。普通非恢复调用不受影响。
 */
const NAVIGATION_BYPASS = new Set([
  'plan_route', 'move_step', 'press_keys', 'pillar_one', 'swim_path', 'boat_path', 'descend_to',
  'excavate_run', 'travel_to', 'explore_toward', 'go_near', 'approach_visible',
]);

/** 组合施工必须由原委托本身授权；其他动作失败不能借恢复自动引入挖放/搭柱组合。 */
const COMBINATION_SKILLS = new Set(['excavate_run']);
/** 水面/载具的入口、出口、方式与时间预算在恢复中保持不变。 */
const WATER_SKILLS = new Set(['swim_path', 'boat_path']);
/** 原始按键控制不能由其他委托的恢复升级获得。 */
const RAW_INPUT_SKILLS = new Set(['press_keys', 'move']);
/** 只读观察不改变身体或世界，任何恢复都可先看再决定。 */
const OBSERVATION_SKILLS = new Set(['look', 'look_around', 'wait', 'inspect_block', 'assess_landings', 'spatial_query']);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
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

/** 原 failure 里的绝对期限只在失败交接边界校验一次；正值绝对 epoch，不当作时长。 */
function recoveryDeadline(value: unknown): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: 'failure.args.deadlineMs 必须是正的绝对 epoch 毫秒' };
}

/** 两个已解析的世界坐标完全相同（全等比较，不加容差）。 */
const pointEquals = (a: Vec3Like | undefined, b: Vec3Like | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
/** 恢复只能沿用原授权模式，不能新增原委托没有的移动方式。 */
const sameOrSubset = (next: unknown, original: unknown): boolean => {
  if (original === undefined) return true;
  if (!Array.isArray(next) || !Array.isArray(original)) return false;
  return next.every((item) => original.includes(item));
};
/** 导航恢复沿用的预算键：只能保留原值或更小，不能借恢复重置/扩大。 */
const NAV_BUDGET_KEYS = [
  'maxSteps', 'maxSegments', 'maxStepsPerSegment', 'maxTransitions', 'maxSearches',
  'maxObservations', 'maxObservedCells', 'maxNoProgressSegments', 'maxNodes', 'maxEdges',
] as const;
function preserveNavigationBudget(args: Record<string, unknown>, original: Record<string, unknown>, skill: string) {
  for (const key of NAV_BUDGET_KEYS) {
    const limit = original[key];
    if (typeof limit !== 'number') continue;
    const value = args[key];
    if (value === undefined) args[key] = limit;
    else if (typeof value !== 'number' || value > limit) throw new Error(`恢复 ${skill} 不能扩大原委托的 ${key} 预算`);
  }
}
function preserveNavigationScope(
  args: Record<string, unknown>, original: Record<string, unknown>, skill: string,
) {
  if (original.sessionId !== undefined) {
    if (args.sessionId === undefined) args.sessionId = original.sessionId;
    else if (args.sessionId !== original.sessionId) throw new Error(`恢复 ${skill} 必须沿用原 sessionId，不能换冻结意图`);
  }
  if (original.historical !== undefined && args.historical !== original.historical) {
    throw new Error(`恢复 ${skill} 必须保留原 historical 证据范围`);
  }
  if (!sameOrSubset(args.allowed, original.allowed)) {
    throw new Error(`恢复 ${skill} 不能新增原委托没有的移动模式`);
  }
  if (original.deadlineMs !== undefined) {
    // recoveryContext 已把原期限写进 scope；这里只限制显式值不能更长。
    if (args.deadlineMs === undefined) args.deadlineMs = original.deadlineMs;
    else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > (original.deadlineMs as number)) {
      throw new Error(`恢复 ${skill} 不能延长原绝对期限`);
    }
  }
  preserveNavigationBudget(args, original, skill);
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
  let deadlineMs: number | undefined;
  const providedTarget = worldPoint(raw.target);
  if (raw.target !== undefined && !providedTarget) return { error: 'failure.target 须为明确的世界坐标 {x,y,z}，不能将相对 at/to 当作目标' };
  if (skill === 'navigate_to') {
    // 原委托的目标是冻结语义：必须来自原参数或原动作回执，不能用当前位置或相对坐标猜。
    const to = worldPoint(args.to) ?? providedTarget;
    if (!to) return { error: 'failure.args.to 必须是原 navigate_to 的绝对目标 {x,y,z}' };
    const kind = args.targetKind;
    if (kind !== undefined && kind !== 'cell' && kind !== 'feet') return { error: 'failure.args.targetKind 只能是 cell 或 feet' };
    if (args.allowed !== undefined && (!Array.isArray(args.allowed) || args.allowed.some((item) => typeof item !== 'string'))) {
      return { error: 'failure.args.allowed 必须是移动模式字符串数组' };
    }
    if (args.historical !== undefined && typeof args.historical !== 'boolean') return { error: 'failure.args.historical 必须是布尔值' };
    if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId.trim())) return { error: 'failure.args.sessionId 必须是非空字符串' };
    const deadline = recoveryDeadline(args.deadlineMs);
    if (!deadline.ok) return { error: deadline.error };
    navTarget = to;
    deadlineMs = deadline.value;
    args = { ...args, to, ...(kind === undefined ? {} : { targetKind: kind }), ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
  }
  if (skill === 'advance') {
    // advance 的委托是方向+距离+横向允许；中间 waypoint 不是新的原目的地。
    const direction = typeof args.direction === 'string' ? args.direction.toUpperCase() : '';
    if (!['N', 'E', 'S', 'W'].includes(direction)) return { error: 'failure.args.direction 必须是原 advance 的 N/E/S/W' };
    if (!Number.isInteger(args.distance) || (args.distance as number) <= 0) return { error: 'failure.args.distance 必须是原 advance 的正整数距离' };
    if (args.allowed !== undefined && (!Array.isArray(args.allowed) || args.allowed.some((item) => typeof item !== 'string'))) {
      return { error: 'failure.args.allowed 必须是移动模式字符串数组' };
    }
    if (args.historical !== undefined && typeof args.historical !== 'boolean') return { error: 'failure.args.historical 必须是布尔值' };
    if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId.trim())) return { error: 'failure.args.sessionId 必须是非空字符串' };
    const deadline = recoveryDeadline(args.deadlineMs);
    if (!deadline.ok) return { error: deadline.error };
    deadlineMs = deadline.value;
    args = { ...args, direction, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
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
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
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
  if (name === 'navigate_to' && scope.skill === 'navigate_to') {
    const originalTo = worldPoint(original.to) ?? scope.target;
    const nextTo = worldPoint(args.to);
    if (!originalTo) throw new Error('恢复 navigate_to 缺少原目标坐标');
    if (!nextTo || !pointEquals(nextTo, originalTo)) throw new Error('恢复 navigate_to 必须保留原目标坐标，不能换目的地');
    const originalKind = original.targetKind === 'cell' || original.targetKind === 'feet'
      ? original.targetKind
      : (Number.isInteger(originalTo.x) && Number.isInteger(originalTo.z) ? 'cell' : 'feet');
    if (args.targetKind !== undefined && args.targetKind !== originalKind) {
      throw new Error('恢复 navigate_to 必须保留原目标类型（格/精确脚位），不能用附近格或格心顶替');
    }
    preserveNavigationScope(args, original, 'navigate_to');
    if (scope.deadlineMs !== undefined) {
      if (args.deadlineMs === undefined) args.deadlineMs = scope.deadlineMs;
      else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > scope.deadlineMs) throw new Error('恢复 navigate_to 不能延长原绝对期限');
    }
  }
  if (name === 'advance' && scope.skill === 'advance') {
    const direction = typeof original.direction === 'string' ? original.direction.toUpperCase() : undefined;
    if (direction === undefined || args.direction !== direction) throw new Error('恢复 advance 必须保留原方向');
    const distance = original.distance;
    if (typeof distance === 'number' && (typeof args.distance !== 'number' || args.distance > distance)) {
      throw new Error(`恢复 advance 不能超过原 ${distance} 格距离额度`);
    }
    const drift = original.maxLateralDrift;
    if (typeof drift === 'number' && (typeof args.maxLateralDrift !== 'number' || args.maxLateralDrift > drift)) {
      throw new Error(`恢复 advance 不能放宽原 ${drift} 格横向偏离额度`);
    }
    preserveNavigationScope(args, original, 'advance');
    if (scope.deadlineMs !== undefined) {
      if (args.deadlineMs === undefined) args.deadlineMs = scope.deadlineMs;
      else if (typeof args.deadlineMs !== 'number' || args.deadlineMs > scope.deadlineMs) throw new Error('恢复 advance 不能延长原绝对期限');
    }
  }
  // 只读观察不改变身体或世界，任何恢复都可先看，不扩大物理委托。
  if (OBSERVATION_SKILLS.has(name)) return args;
  // 水面/载具：恢复沿用原入口、出口、方式和时间预算；不能在失败后换成别的移动/施工方式。
  if (WATER_SKILLS.has(scope.skill)) {
    if (name !== scope.skill) throw new Error(`恢复「${scope.skill}」不能改用 ${name}：水面/载具的目标、出口或时间预算不能被恢复扩大`);
    if (name === 'swim_path') {
      const mode = typeof original.mode === 'string' ? original.mode : undefined;
      if (mode !== undefined && args.mode !== mode) throw new Error('恢复 swim_path 必须保留原模式');
      if (mode !== 'surface') {
        if (!pointEquals(rawPoint(args.xyz), rawPoint(original.xyz ?? original.to ?? original.at))) throw new Error('恢复 swim_path 必须使用原目标坐标');
      }
      if (finite(original.timeoutMs) && finite(args.timeoutMs) && args.timeoutMs > original.timeoutMs) throw new Error('恢复 swim_path 不能延长原时间预算');
    }
    if (name === 'boat_path') {
      const to = rideTarget(args.to), from = rideTarget(original.to);
      const sameTo = to === undefined && from === undefined
        || !!to && !!from && to.x === from.x && to.z === from.z;
      if (!sameTo) throw new Error('恢复 boat_path 必须保留原目标');
      const direction = typeof original.direction === 'string' ? original.direction.toUpperCase() : undefined;
      if (args.direction !== direction) throw new Error('恢复 boat_path 必须保留原方向');
      if (finite(original.distance) && finite(args.distance) && args.distance > original.distance) throw new Error('恢复 boat_path 不能扩大原距离额度');
      const until = typeof original.until === 'string' && original.until.trim() ? original.until.trim().toLowerCase().slice(0, 80) : undefined;
      if (args.until !== until) throw new Error('恢复 boat_path 必须保留原停止条件');
    }
  }
  // 原始按键（press_keys）是独立的身体控制委托：其他动作的恢复不能升级成它。
  // api.move 的有界短推仍可作为恢复内的身体纠偏，但不能从按键委托新增按键或延长时间。
  if (name === 'press_keys' && scope.skill !== 'press_keys') throw new Error('恢复不能改用原始按键控制：原委托没有授权');
  if (scope.skill === 'press_keys' && name !== 'press_keys' && name !== 'move') {
    throw new Error(`恢复「press_keys」不能改用 ${name}：原始按键委托不能升级成其他移动或施工`);
  }
  // 恢复不能关闭原委托的安全 guard；只有原动作本身就是 unsafe 时才允许沿用。
  if (name === 'move' && (args.unsafe === true)) {
    const originalUnsafe = scope.skill === 'move' && (original as Record<string, unknown>).unsafe === true;
    if (!originalUnsafe) throw new Error('恢复不能关闭原委托的 guard 保护（unsafe:true）');
  }
  if (scope.skill === 'press_keys' && RAW_INPUT_SKILLS.has(name)) {
    const extra = activeKeys(name === 'move' ? args : args.keys).filter((key) => !activeKeys(original.keys).includes(key));
    if (extra.length) throw new Error(`恢复按键不能新增原委托没有的 ${extra.join('、')}`);
    // press_keys 与 api.move 上限不同（50–10000 vs 50–1000），但恢复都只能缩短、
    // 不能超过原委托的按压时长；api.move 自己的入口校验再应用 1000ms 上限。
    if (finite(original.ms) && finite(args.ms) && args.ms > original.ms) throw new Error('恢复按键不能超过原按压时长');
  }
  if (name === 'move_step' || name === 'mine_cell' || name === 'place_cell' || name === 'place_support' || name === 'pillar_one') {
    if (name === 'mine_cell') {
      for (const flag of ['wet', 'lava', 'fall', 'own'] as const) if (args[flag] === true && original[flag] !== true) throw new Error(`原委托没有允许 ${flag}:true，恢复不能擅自打开`);
    }
    if (name === 'mine_cell' && scope.skill !== 'mine_cell' && scope.allowDig !== true) throw new Error('原委托没有授权挖掘，恢复不能改挖其他方块');
    if ((name === 'place_cell' || name === 'place_support' || name === 'pillar_one') && scope.skill !== name && scope.allowPlace !== true) {
      throw new Error('原委托没有授权支出方块；需要心智显式选择 allowPlace 才能放置');
    }
    if (name === scope.skill && scope.target) {
      const facing = (args.facing ?? facingOfYaw(ctx.adapter.eye()?.yaw ?? 0)) as Facing;
      const target = worldPoint(args.xyz) ?? (Array.isArray(args.at) && args.at.length === 3 ? toWorld(feetCell(ctx.adapter.state().pos), facing, args.at as [number, number, number]) : undefined);
      if (!target || target.x !== scope.target.x || target.y !== scope.target.y || target.z !== scope.target.z) throw new Error('恢复不能替换原动作的目标格');
    }
    if (name === 'mine_cell' && scope.skill === 'mine_cell' && original.tool !== undefined && args.tool !== original.tool) throw new Error('恢复必须保留原挖掘工具');
    if ((name === 'place_cell' || name === 'place_support') && scope.skill === name && original.item !== undefined && args.item !== original.item) throw new Error('恢复必须保留原放置物品');
    if (name === 'pillar_one' && scope.skill === 'pillar_one' && original.item !== undefined && args.item !== original.item) throw new Error('恢复必须保留原垫脚材料');
  }
  // 组合施工（有界开挖、搭柱爬升）只沿用同一原委托的剩余额度，不能由别的失败自动引入。
  if (COMBINATION_SKILLS.has(name) && scope.skill !== name) {
    throw new Error(`恢复「${scope.skill}」不能引入 ${name} 组合施工：需要原委托显式授权`);
  }
  if (name === 'excavate_run' && scope.skill === 'excavate_run') {
    const originalScope = excavationScope(original);
    if (args.entry !== undefined) throw new Error('恢复 excavate_run 从当前站位开始，不接受入口');
    if (args.mode !== originalScope.mode || args.direction !== originalScope.direction) throw new Error('恢复 excavate_run 必须保留原方向与模式');
    if (!Number.isInteger(args.steps) || (args.steps as number) > originalScope.steps) throw new Error(`恢复 excavate_run 不能超过原 ${originalScope.steps} 步额度`);
    for (const flag of ['wet', 'lava', 'allowFalling'] as const) if (args[flag] === true && original[flag] !== true) throw new Error(`原开挖没有允许 ${flag}:true，恢复不能擅自打开`);
  }
  if (name === 'craft' && scope.skill !== 'craft') throw new Error('恢复不能隐式增加合成任务');
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
