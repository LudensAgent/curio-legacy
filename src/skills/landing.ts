import { supportTop } from '../perception/geometry.ts';
import { clampInt, fail, obj, ok, type LandingOption, type Skill } from './types.ts';

/**
 * A deliberately unmitigated, rounded-up estimate; server physics/effects can differ.
 * supportTopValue 是落点支撑方块按共享碰撞形状算出的格内顶面（与 step/descend 同一来源）；
 * undefined 表示没有可用状态，null 表示形状未确认。只复核，不改写 target/surfaceY。
 */
export function assessLanding(option: LandingOption, hp: number, supportTopValue?: number | null) {
  const estimatedFallDamage = option.receipt.onGround !== true ? null
    : option.surface === 'ground' ? Math.max(0, Math.ceil(option.drop - 3)) : option.waterDepth === 2 ? 0 : null;
  const supportGeometry = option.surface === 'water' ? 'not_applicable' : supportTopValue === undefined ? 'unavailable' : supportTopValue === null ? 'unknown' : 'known';
  const collisionSurfaceY = typeof supportTopValue === 'number' ? option.support.pos.y + supportTopValue : null;
  const surfaceConsistent = collisionSurfaceY === null ? null : Math.abs(collisionSurfaceY - option.surfaceY) <= 0.01;
  const geometryKnown = option.clearance === 'clear' && option.corridor === 'clear' && option.approach === 'adjacent'
    && (supportGeometry === 'known' || supportGeometry === 'not_applicable') && surfaceConsistent !== false;
  const blocked = option.clearance === 'blocked' || option.corridor === 'blocked';
  const risk = blocked ? 'blocked' : estimatedFallDamage !== null && estimatedFallDamage >= hp ? 'lethal_estimate'
    : !geometryKnown || estimatedFallDamage === null ? 'unknown' : estimatedFallDamage > 0 ? 'injury_estimate' : 'low_fall_damage_estimate';
  return { ...option, hp, estimatedFallDamage, estimatedHpAfter: estimatedFallDamage === null ? null : Math.max(0, hp - estimatedFallDamage), risk,
    supportTop: typeof supportTopValue === 'number' ? supportTopValue : null, collisionSurfaceY, surfaceConsistent, supportGeometry,
    ...(surfaceConsistent === false ? { supportNote: '支撑方块按碰撞形状的顶面与视觉落点脚高不一致；落点身份保留，未自动改写' } : {}),
    ...(supportGeometry === 'unknown' ? { supportNote: '支撑方块形状未确认，不能按整数脚高假定可站立' } : {}),
    unknowns: [
      ...option.unknowns,
      ...(supportGeometry === 'unknown' ? ['支撑方块形状未确认'] : []),
      ...(supportGeometry === 'unavailable' ? ['支撑方块状态不可读，顶面无法复核'] : []),
    ],
    geometrySource: '支撑顶面用共享碰撞形状复核；净空/通道仍取当前可见落点评估，未逐格复验身体碰撞',
    estimateAssumptions: '静止起跳前的落差粗估，未计护甲附魔/状态减伤；不是实际执行或安全保证',
    ...(option.surface === 'water' ? { waterCaution: '只确认可见水柱深度；水流、入水后呼吸和离水路线仍需判断' } : {}) };
}

export const assessLandings: Skill<{ radius: number }> = {
  name: 'assess_landings',
  description: '只读评估当前可见的较低地面或水面：精确落点、落差、入口净空、可见水深与按当前生命粗估的摔伤；支撑顶面用与 move_step/descend_to 相同的碰撞形状复核并标出不一致，未知如实保留；不选择落点，也不保证四周无路',
  argsDoc: '{"radius"?:1-12}', timeoutMs: 3000, movement: false, readOnly: true,
  validate(raw) { return { ok: true, args: { radius: clampInt(obj(raw).radius, 1, 12, 6) } }; },
  async run(ctx, args) {
    if (!ctx.senses.landingOptions) return fail('NOT_FOUND', '感官没有提供可见落点，不能凭坐标读取隐藏地形');
    ctx.senses.refresh();
    const state = ctx.adapter.state();
    // 支撑顶面按当前已观察 blockstate 的碰撞形状复核，与 move_step/descend_to 共用 supportTop；
    // 拿不到状态或形状未确认时如实返回 null/unknown，不按整数脚高假定。
    const options = ctx.senses.landingOptions(args.radius).map((option) => {
      if (option.surface === 'water') return assessLanding(option, state.hp);
      const support = ctx.adapter.blockStateAt?.(option.support.pos);
      // No readable state means the top surface is unavailable, not a guess from
      // the visible name with empty properties.
      return assessLanding(
        option,
        state.hp,
        support === undefined || support === null ? undefined : supportTop(support.name, support.properties ?? {}),
      );
    });
    return ok(options.length ? `看清 ${options.length} 处较低表面；落差、摔伤粗估与未确认项见数据，尚未移动` : '当前视野没有可确认的较低表面；可能受视角、遮挡或光照限制，不能推断四周都没有落点',
      { source: 'current_visible_landings', hp: state.hp, options, effectEvidence: { verified: true, changed: false, reasons: ['只读可见几何与风险估算，未执行下落'] } });
  },
};
