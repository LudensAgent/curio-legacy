import type { Vec3Like } from '../../adapter/types.ts';
import type { VoxelMap } from 'curio-minecraft-3d-memory';
import { observedFootYSlices } from '../../spatial/land-search.ts';

/** 向前最多查这么远的已记录体素找探索前沿；不受周边扫描半径限制。 */
export const FRONTIER_MAX_AHEAD = 256;
/** 站立面相对探索出发脚高的上下查找范围。 */
const FRONTIER_FOOT_RANGE = 16;
/** 大片已知区域要读几十万格：每扫这么久就让出主线程，不卡住身体物理（50ms 一刻）。 */
const FRONTIER_SLICE_MS = 5;

/**
 * 在冻结方向的授权走廊内，从已记录体素里找沿方向最远的探索前沿：一个已观测、可站立的脚位，且四邻至少一列的
 * 脚部或头部格从未观测。每列取离 anchorY 最近的站立面，只看 anchorY ±16 格：高度参照固定为探索出发时的脚高，
 * 不随当前位置漂移——跟着身体下移时，每段都会在更低处找到旧矿道里的前沿，一段段把身体往下引。
 * 同一前进距离上优先离当前横向位置近的列。只读体素、不观察、不移动；可达性由随后的寻路决定。
 * 没有前沿返回 null。分片执行，片间让出主线程。
 */
export async function farthestFrontier(
  voxel: VoxelMap, dim: string,
  corridor: { origin: Vec3Like; bearing: { x: number; z: number }; maxLateral: number; maxAlong: number; anchorY: number },
  from: Vec3Like, skip: (cell: Vec3Like) => boolean,
): Promise<Vec3Like | null> {
  const { origin, bearing, maxLateral, maxAlong, anchorY } = corridor;
  const side = { x: -bearing.z, z: bearing.x };
  const along0 = (from.x - origin.x) * bearing.x + (from.z - origin.z) * bearing.z;
  const lateral0 = (from.x - origin.x) * side.x + (from.z - origin.z) * side.z;
  const lateralOrder = Array.from({ length: 2 * Math.floor(maxLateral) + 1 }, (_, i) => i - Math.floor(maxLateral))
    .sort((a, b) => Math.abs(a - lateral0) - Math.abs(b - lateral0));
  const unknown = (x: number, y: number, z: number) => !voxel.cellAt(dim, x, y, z).observed || !voxel.cellAt(dim, x, y + 1, z).observed;
  let sliceEnd = performance.now() + FRONTIER_SLICE_MS;
  const yieldIfNeeded = async () => {
    if (performance.now() < sliceEnd) return;
    await new Promise((resolve) => setImmediate(resolve));
    sliceEnd = performance.now() + FRONTIER_SLICE_MS;
  };
  for (let along = Math.floor(Math.min(maxAlong, along0 + FRONTIER_MAX_AHEAD)); along > along0 + 1; along--) {
    if (performance.now() >= sliceEnd) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceEnd = performance.now() + FRONTIER_SLICE_MS;
    }
    for (const lateral of lateralOrder) {
      await yieldIfNeeded();
      const x = Math.floor(origin.x + bearing.x * along + side.x * lateral);
      const z = Math.floor(origin.z + bearing.z * along + side.z * lateral);
      // 高度探测也分片：一列要读大约 33 层，长走廊下不能只在整列之间检查预算。
      const heights = observedFootYSlices(voxel, dim, x, z, anchorY, FRONTIER_FOOT_RANGE, FRONTIER_FOOT_RANGE);
      let footY: number | null;
      for (;;) {
        const step = heights.next();
        if (step.done) { footY = step.value; break; }
        await yieldIfNeeded();
      }
      if (footY === null) continue;
      const feet = { x: x + 0.5, y: footY, z: z + 0.5 };
      if (skip(feet)) continue;
      const y = Math.floor(footY);
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => unknown(x + dx!, y, z + dz!))) return feet;
    }
  }
  return null;
}
