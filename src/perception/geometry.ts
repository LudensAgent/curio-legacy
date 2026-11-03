import minecraftData from 'minecraft-data';
import BlockFactory from 'prismarine-block';
import { config } from '../config.ts';

/**
 * 局部几何：按「当前已观察 blockstate」解析碰撞盒，判断支撑顶面与身体净空。
 * 只做纯几何，不查询遮挡或未观察区域——上层负责合法观测与未知反馈。
 * 用 prismarine-block 的 fromProperties 取当前状态的碰撞盒，不把方块名属于
 * “实心/可穿过”直接等同于可站立或无碰撞，也不再取所有状态的形状并集。
 */

const version = config.mc.version;
const data = minecraftData(version);
const Block = BlockFactory(version);

type Box = number[];
type BlockProps = Record<string, string | number | boolean>;

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 一个方块在当前 blockstate 下的碰撞盒（cell-local，可超出 [0,1]，如栅栏 1.5 高）。空气/液体/火把返回空。 */
export function collisionBoxes(name: string, properties: BlockProps = {}): Box[] {
  if (name === null || name === undefined || AIR.has(name)) return [];
  if (!data.blocksByName[name]) return [];
  return (Block.fromProperties(name, properties as Record<string, string | number>, 0)?.shapes ?? []) as Box[];
}

/**
 * 最高可站立顶面（cell-local Y）；无顶面返回 null。
 * 只认水平跨度够大的顶面（宽、深均 ≥ 0.5），栅栏柱、梯子板、门板这类窄条不能站。
 */
export function supportTop(name: string, properties: BlockProps = {}): number | null {
  let top: number | null = null;
  for (const box of collisionBoxes(name, properties)) {
    if (box[3] - box[0] < 0.5 || box[5] - box[2] < 0.5) continue;
    top = top === null ? box[4] : Math.max(top, box[4]);
  }
  return top;
}

/** 身体 AABB（0.6×1.8）：脚底在 footY，水平居中于整数列 (cx, cz)。 */
export interface BodyBox { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** 方块 (name, properties) 位于 cell，其碰撞盒是否与身体 AABB 相交。 */
export function blockCollidesBody(name: string, properties: BlockProps, cell: { x: number; y: number; z: number }, body: BodyBox): boolean {
  for (const box of collisionBoxes(name, properties)) {
    const [x0, y0, z0, x1, y1, z1] = box;
    if (x1 - x0 <= 0 || y1 - y0 <= 0 || z1 - z0 <= 0) continue;
    if (cell.x + x1 > body.minX && cell.x + x0 < body.maxX
      && cell.y + y1 > body.minY && cell.y + y0 < body.maxY
      && cell.z + z1 > body.minZ && cell.z + z0 < body.maxZ) return true;
  }
  return false;
}
