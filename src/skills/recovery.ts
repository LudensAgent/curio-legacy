import type { Vec3Like } from '../adapter/types.ts';
import { facingOfYaw, feetCell, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces } from '../perception/surroundings.ts';
import type { SkillCtx } from './types.ts';

export type RecoveryContext = { skill: string; args: Record<string, unknown>; target?: Vec3Like; position?: Vec3Like; entityId?: number; allowPlace?: boolean; allowDig?: boolean; climb?: { height: number; spent: number; startY: number } };

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
  const target = worldPoint(raw.target), position = worldPoint(raw.position), args = raw.args as Record<string, unknown>;
  if (raw.target !== undefined && !target) return { error: 'failure.target 须为明确的世界坐标 {x,y,z}，不能将相对 at/to 当作目标' };
  if (raw.position !== undefined && !position) return { error: 'failure.position 须为明确的世界坐标' };
  const entityId = raw.entityId ?? args.entityId;
  if (entityId !== undefined && (!Number.isSafeInteger(entityId) || Number(entityId) < 0)) return { error: 'failure.entityId 须为原实体整数 ID' };
  const climb = raw.climb && typeof raw.climb === 'object' && !Array.isArray(raw.climb) ? raw.climb as { height: number; spent: number; startY: number } : undefined;
  return { ...raw, skill: raw.skill, args, ...(target ? { target } : {}), ...(position ? { position } : {}), ...(entityId !== undefined ? { entityId: Number(entityId) } : {}), ...(climb ? { climb } : {}) };
}

/** Shared after primitive validation, including code, steps and nested learned calls. */
export function constrainRecoveryAction(ctx: SkillCtx, name: string, values: Record<string, unknown>) {
  const scope = ctx.recovery;
  if (!scope) return values;
  const original = scope.args, args = { ...values };
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
