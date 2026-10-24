import { clampInt, fail, obj, ok, type LandingOption, type Skill } from './types.ts';

/** A deliberately unmitigated, rounded-up estimate; server physics/effects can differ. */
export function assessLanding(option: LandingOption, hp: number) {
  const estimatedFallDamage = option.receipt.onGround !== true ? null
    : option.surface === 'ground' ? Math.max(0, Math.ceil(option.drop - 3)) : option.waterDepth === 2 ? 0 : null;
  const geometryKnown = option.clearance === 'clear' && option.corridor === 'clear' && option.approach === 'adjacent';
  const blocked = option.clearance === 'blocked' || option.corridor === 'blocked';
  const risk = blocked ? 'blocked' : estimatedFallDamage !== null && estimatedFallDamage >= hp ? 'lethal_estimate'
    : !geometryKnown || estimatedFallDamage === null ? 'unknown' : estimatedFallDamage > 0 ? 'injury_estimate' : 'low_fall_damage_estimate';
  return { ...option, hp, estimatedFallDamage, estimatedHpAfter: estimatedFallDamage === null ? null : Math.max(0, hp - estimatedFallDamage), risk,
    estimateAssumptions: '静止起跳前的落差粗估，未计护甲附魔/状态减伤；不是实际执行或安全保证',
    ...(option.surface === 'water' ? { waterCaution: '只确认可见水柱深度；水流、入水后呼吸和离水路线仍需判断' } : {}) };
}

export const assessLandings: Skill<{ radius: number }> = {
  name: 'assess_landings',
  description: '只读评估当前可见的较低地面或水面：精确落点、落差、入口净空、可见水深与按当前生命粗估的摔伤；未知如实保留，不选择路线',
  argsDoc: '{"radius"?:1-12}', timeoutMs: 3000, movement: false, readOnly: true,
  validate(raw) { return { ok: true, args: { radius: clampInt(obj(raw).radius, 1, 12, 6) } }; },
  async run(ctx, args) {
    if (!ctx.senses.landingOptions) return fail('NOT_FOUND', '感官没有提供可见落点，不能凭坐标读取隐藏地形');
    ctx.senses.refresh();
    const state = ctx.adapter.state();
    const options = ctx.senses.landingOptions(args.radius).map((option) => assessLanding(option, state.hp));
    return ok(options.length ? `看清 ${options.length} 处较低表面；落差、摔伤粗估与未确认项见数据，尚未移动` : '当前视野没有可确认的较低表面；可能受视角、遮挡或光照限制，不能推断四周都没有落点',
      { source: 'current_visible_landings', hp: state.hp, options, effectEvidence: { verified: true, changed: false, reasons: ['只读可见几何与风险估算，未执行下落'] } });
  },
};
