/**
 * 站位依赖判断：移动步骤失败后，紧跟的相对坐标动作会按当前（可能已部分位移的）站位解析，
 * 打到错误位置。
 *
 * relativeCellAction 只接受「校验后的规范化参数」。规范化的 mine_cell/place_cell/place_support：
 * 绝对目标带合法的 xyz 对象，相对目标只有 at（无 xyz）。不能凭「键存在」就放行，必须看
 * 规范化后的 xyz 是否真存在。
 */

/** 会改变身体站位的步骤；失败后身体可能已有部分位移，不再位于原起点。
 *  放置/补支撑也可能为了让出参照面而轻推身体（哪怕不足 0.5 格），同样要计入。 */
export const STANCE_MOVES = new Set([
  'move_step', 'walk_path', 'swim_path', 'boat_path', 'descend_to', 'excavate_run', 'pillar_one',
  'place_cell', 'place_support',
]);

/**
 * 会返回结构化导航回执的入口：失败时用该步实际返回的末位/原请求，而不是事后重读当前站位。
 * 当前只有 walk_path 共用空间库的 NavResult 外壳。
 */
export const NAVIGATION_ACTIONS = new Set(['walk_path']);

/**
 * 规范化参数下，该动作是否为依赖当前站位的相对动作（挖掘/放置/迈步）。
 * 只有 move_step/mine_cell/place_cell/place_support 且没有合法 xyz 绝对目标时才是相对。
 */
export function relativeCellAction(skill: string, validatedArgs: unknown): boolean {
  if (skill !== 'move_step' && skill !== 'mine_cell' && skill !== 'place_cell' && skill !== 'place_support') return false;
  if (validatedArgs === null || typeof validatedArgs !== 'object' || Array.isArray(validatedArgs)) return false;
  return (validatedArgs as Record<string, unknown>).xyz === undefined;
}
