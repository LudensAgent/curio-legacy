import type { Vec3Like } from '../adapter/types.ts';
import { facingOfYaw, feetCell, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces } from '../perception/surroundings.ts';
import type { SkillCtx } from './types.ts';
import { readPoint } from './walk-route.ts';

type NavArrival = { kind: 'exact' } | { kind: 'near'; radius: number };

export type RecoveryContext = { skill: string; args: Record<string, unknown>; target?: Vec3Like; position?: Vec3Like; entityId?: number; allowPlace?: boolean; allowDig?: boolean; climb?: { height: number; spent: number; startY: number }; arrival?: NavArrival; fragmentId?: string; deadlineMs?: number };

/** 恢复时只有这两个动作能继承/重做同一导航委托；其他动作不能静默替换目标或完成条件。 */
const NAVIGATION_SKILLS = new Set(['walk_to', 'walk_known_route']);
/**
 * 新导航恢复不能用其他直接移动/导航动作绕过原后端、目标与手段。
 * 一个显式有限集合：旧寻路/单步/按键/旧路线，以及会直接改变身体位置或移动方式的
 * 游泳、旅行、沿矿道、下行、攀爬、载具、上浮和下潜。普通非恢复调用不受影响。
 */
const NAVIGATION_BYPASS = new Set([
  'goto', 'step', 'move', 'press_keys', 'walk_route',
  'swim_to', 'travel', 'follow_passage', 'descend', 'climb_up', 'ride', 'surface', 'dive',
]);

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
  const climb = raw.climb && typeof raw.climb === 'object' && !Array.isArray(raw.climb) ? raw.climb as { height: number; spent: number; startY: number } : undefined;
  return { ...raw, skill, args, ...(target ? { target } : {}), ...(position ? { position } : {}), ...(entityId !== undefined ? { entityId: Number(entityId) } : {}), ...(climb ? { climb } : {}),
    ...(arrival ? { arrival } : {}), ...(fragmentId !== undefined ? { fragmentId } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
}

/** Shared after primitive validation, including code, steps and nested learned calls. */
export function constrainRecoveryAction(ctx: SkillCtx, name: string, values: Record<string, unknown>) {
  const scope = ctx.recovery;
  if (!scope) return values;
  const original = scope.args, args = { ...values };
  // 新导航恢复必须沿用同一原语：既不能换成旧寻路/单步/按键，也不能从旧动作
  // 静默切进新导航（后者的目标/完成条件不等价）。普通非恢复调用不受影响。
  if (NAVIGATION_SKILLS.has(scope.skill) && NAVIGATION_BYPASS.has(name)) {
    throw new Error(`恢复「${scope.skill}」必须沿用原导航动作，不能用 ${name} 绕过原后端、目标或手段`);
  }
  if ((name === 'walk_to' || name === 'walk_known_route') && name !== scope.skill) {
    throw new Error(`恢复「${scope.skill}」不能改用 ${name}：缺少等价的原始目标与完成条件`);
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
  if (name === 'craft' && scope.skill !== 'craft') throw new Error('恢复不能隐式增加合成任务');
  if (name === 'explore' && scope.skill !== 'explore') throw new Error('恢复不能隐式增加探索任务');
  if (name === 'defend' || name === 'hit_entity' || name === 'interact') {
    const id = args.entityId ?? args.entity;
    if (scope.entityId !== undefined && id !== scope.entityId) throw new Error('恢复必须保留原实体 ID，不能改选同名或其他实体');
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
