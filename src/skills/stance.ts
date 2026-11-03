/**
 * 站位依赖判断：移动步骤失败后，紧跟的相对坐标动作会按当前（可能已部分位移的）站位解析，
 * 打到错误位置。
 *
 * relativeCellAction 只接受「校验后的规范化参数」（validateSkill 的输出），不复制任何原始
 * 坐标解析规则。规范化的 dig_at/place_at：绝对目标带合法的 xyz 对象，相对目标只有 at（无 xyz）。
 * 无效的 xyz（null / "invalid"）会被 withAbsolute 丢弃、按相对坐标执行，这里不能凭「键存在」
 * 就放行，必须看规范化后的 xyz 是否真存在。
 */

/** 会改变身体站位的移动步骤；失败后身体可能已有部分位移，不再位于原起点。 */
export const STANCE_MOVES = new Set(['step', 'goto', 'descend', 'climb_up', 'follow_passage', 'travel', 'ride']);

/**
 * 规范化参数下，该动作是否为依赖站位的相对挖掘/放置。
 * 只有 dig_at/place_at 且没有合法 xyz 绝对目标时才是相对（水平、竖直、零偏移都算）。
 */
export function relativeCellAction(skill: string, validatedArgs: unknown): boolean {
  if (skill !== 'dig_at' && skill !== 'place_at') return false;
  if (validatedArgs === null || typeof validatedArgs !== 'object' || Array.isArray(validatedArgs)) return false;
  return (validatedArgs as Record<string, unknown>).xyz === undefined;
}
