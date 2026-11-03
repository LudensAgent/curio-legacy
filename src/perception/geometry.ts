import minecraftData from 'minecraft-data';
import { config } from '../config.ts';

/**
 * 局部几何：用当前 blockstate 的碰撞形状判断「能不能穿过」「顶面能不能站」，
 * 不再把方块名属于“实心/可穿过”直接等同于可站立或无碰撞。
 * 只做纯几何，不查询遮挡或未观察区域——上层负责合法观测与未知反馈。
 */

const registry = minecraftData(config.mc.version) as unknown as {
  blockCollisionShapes: { blocks: Record<string, number | number[]>; shapes: Record<number, number[][]> };
};

/** 一个碰撞盒：[minX, minY, minZ, maxX, maxY, maxZ]，cell-local [0,1]^3。 */
type Box = number[];

/** 雪层：按层数给碰撞高度（1 层 = 0.125，8 层 = 1.0）。 */
function snowBoxes(props: Record<string, unknown>): Box[] {
  const layers = Number(props.layers ?? 1);
  if (!Number.isFinite(layers) || layers < 1) return [];
  return [[0, 0, 0, 1, Math.min(layers, 8) / 8, 1]];
}

/** 半砖：按 type 属性分辨下半砖 / 上半砖 / 双层。 */
function slabBoxes(name: string, props: Record<string, unknown>): Box[] {
  const type = String(props.type ?? 'bottom');
  if (type === 'top') return [[0, 0.5, 0, 1, 1, 1]];
  if (type === 'bottom') return [[0, 0, 0, 1, 0.5, 1]];
  return [[0, 0, 0, 1, 1, 1]]; // double
}

/**
 * 一个方块在当前 blockstate 下的碰撞盒集合（cell-local [0,1]^3）。空气/液体/火把等返回空。
 * 半砖与雪层按属性精确展开；其余带状态的方块（门、栅栏、梯子、箱子…）沿用静态表里各状态的并集，
 * 对「有没有碰撞」「顶面有多高」是保守但仍正确的估计。
 */
export function collisionBoxes(name: string, props: Record<string, unknown> = {}): Box[] {
  if (name === 'snow') return snowBoxes(props);
  if (name.endsWith('_slab')) return slabBoxes(name, props);
  const ids = registry.blockCollisionShapes.blocks[name];
  if (ids === undefined) return [];
  const idList = Array.isArray(ids) ? ids : [ids];
  return idList.flatMap((id) => registry.blockCollisionShapes.shapes[id] ?? []);
}

/**
 * 最高可站立顶面（cell-local Y）；无顶面返回 null。
 * 只认水平跨度够大的顶面（宽、深均 ≥ 0.5），栅栏柱、梯子板、门板这类窄条不能站。
 */
export function supportTop(name: string, props: Record<string, unknown> = {}): number | null {
  let top: number | null = null;
  for (const box of collisionBoxes(name, props)) {
    if (box[3] - box[0] < 0.5 || box[5] - box[2] < 0.5) continue;
    top = top === null ? box[4] : Math.max(top, box[4]);
  }
  return top;
}
