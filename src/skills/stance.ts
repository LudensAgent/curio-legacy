/**
 * 站位依赖判断：移动步骤失败后，紧跟的相对坐标动作会按当前（可能已部分位移的）站位解析，
 * 打到错误位置。这里的判断依据是「坐标是相对还是绝对」，与调用链里 withAbsolute / relValue
 * 的键名保持一致，避免被绝对目标派生出的 at 误导。
 */

/** 会改变身体站位的移动步骤；失败后身体可能已有部分位移，不再位于原起点。 */
export const STANCE_MOVES = new Set(['step', 'goto', 'descend', 'climb_up', 'follow_passage', 'travel', 'ride']);

/** withAbsolute 认的绝对目标键（xyz 绝对目标优先于派生的 at）。 */
const ABSOLUTE_CELL_KEYS = ['xyz', 'abs', 'world'];
/** relValue 认的相对坐标键（水平、竖直、零偏移都可能依赖站位）。 */
const RELATIVE_CELL_KEYS = ['at', 'to', 'pos', 'position', 'offset', 'rel', 'cell'];

/**
 * 该动作是否为依赖站位的相对挖掘/放置。xyz/abs/world 绝对目标优先，返回 false；
 * 只有 at/to/pos/offset/rel/cell 这类相对坐标才返回 true（不区分水平、竖直、零偏移）。
 * 参数可为校验后的规范化参数，也可为原始参数——键名与校验链一致。
 */
export function relativeCellAction(skill: string, args: unknown): boolean {
  if (skill !== 'dig_at' && skill !== 'place_at') return false;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const a = args as Record<string, unknown>;
  if (ABSOLUTE_CELL_KEYS.some((k) => a[k] !== undefined)) return false;
  return RELATIVE_CELL_KEYS.some((k) => a[k] !== undefined);
}
