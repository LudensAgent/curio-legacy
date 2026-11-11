import type { Vec3Like } from '../../adapter/types.ts';
import type { VoxelMap } from 'curio-minecraft-3d-memory';
import { observedFootY } from '../../spatial/land-search.ts';

/** 向前最多查这么远的已记录体素找探索前沿；不受周边扫描半径限制。 */
export const FRONTIER_MAX_AHEAD = 256;
/** 站立面相对当前脚高的上下查找范围。 */
const FRONTIER_FOOT_RANGE = 16;

/**
 * 在冻结方向的授权走廊内，从已记录体素里找沿方向最远的探索前沿：一个已观测、可站立的脚位，
 * 且四邻至少一列的脚部或头部格从未观测。只读体素、不观察、不移动；可达性由随后的寻路决定。
 * 同一前进距离上优先离当前横向位置近的列。没有前沿返回 null。
 */
export function farthestFrontier(
  voxel: VoxelMap, dim: string,
  corridor: { origin: Vec3Like; bearing: { x: number; z: number }; maxLateral: number; maxAlong: number },
  from: Vec3Like, skip: (cell: Vec3Like) => boolean,
): Vec3Like | null {
  const { origin, bearing, maxLateral, maxAlong } = corridor;
  const side = { x: -bearing.z, z: bearing.x };
  const along0 = (from.x - origin.x) * bearing.x + (from.z - origin.z) * bearing.z;
  const lateral0 = (from.x - origin.x) * side.x + (from.z - origin.z) * side.z;
  const lateralOrder = Array.from({ length: 2 * Math.floor(maxLateral) + 1 }, (_, i) => i - Math.floor(maxLateral))
    .sort((a, b) => Math.abs(a - lateral0) - Math.abs(b - lateral0));
  const unknown = (x: number, y: number, z: number) => !voxel.cellAt(dim, x, y, z).observed || !voxel.cellAt(dim, x, y + 1, z).observed;
  for (let along = Math.floor(Math.min(maxAlong, along0 + FRONTIER_MAX_AHEAD)); along > along0 + 1; along--) {
    for (const lateral of lateralOrder) {
      const x = Math.floor(origin.x + bearing.x * along + side.x * lateral);
      const z = Math.floor(origin.z + bearing.z * along + side.z * lateral);
      const footY = observedFootY(voxel, dim, x, z, from.y, FRONTIER_FOOT_RANGE, FRONTIER_FOOT_RANGE);
      if (footY === null) continue;
      const feet = { x: x + 0.5, y: footY, z: z + 0.5 };
      if (skip(feet)) continue;
      const y = Math.floor(footY);
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => unknown(x + dx!, y, z + dz!))) return feet;
    }
  }
  return null;
}
