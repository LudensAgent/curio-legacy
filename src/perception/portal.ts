import type { Vec3Like } from '../adapter/types.ts';
import { isSoftBlock } from './surroundings.ts';

type BlockAt = (pos: Vec3Like) => string | null;

/** 会被身体走进而切换维度的方块。 */
export const PORTAL_KINDS = new Set(['nether_portal', 'end_portal']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

export interface PortalOpening {
  kind: 'nether_portal' | 'end_portal';
  /** 门面宽度所在的水平轴。 */
  widthAxis: 'x' | 'z';
  /** 门底行（可走入的最底一行）。 */
  bottomY: number;
  /** 门底行沿 widthAxis 的连续范围，闭区间。 */
  min: number;
  max: number;
  /** 门洞中心（世界坐标，沿 widthAxis）：(min + max + 1) / 2。 */
  center: number;
  /** 门面在法线方向上的格坐标。 */
  plane: number;
  /** 门面宽度（格）。 */
  width: number;
}

const isPortal = (blockAt: BlockAt, p: Vec3Like) => PORTAL_KINDS.has(blockAt(p) ?? '');

/** 同一竖列里连续门方块的最低一行；观察点可能不是最底层。 */
function bottomOf(blockAt: BlockAt, pos: Vec3Like, kind: string): number {
  let y = pos.y;
  while (y > -64 && blockAt({ x: pos.x, y: y - 1, z: pos.z }) === kind) y--;
  return y;
}

/** 从 start 沿某个水平轴向两侧扩展同一行走廊里的连续门方块。 */
function run(blockAt: BlockAt, start: Vec3Like, kind: string, axis: 'x' | 'z'): { min: number; max: number } {
  const at = (n: number) => axis === 'x'
    ? { x: n, y: start.y, z: start.z }
    : { x: start.x, y: start.y, z: n };
  let min = axis === 'x' ? start.x : start.z;
  let max = min;
  while (blockAt(at(min - 1)) === kind) min--;
  while (blockAt(at(max + 1)) === kind) max++;
  return { min, max };
}

/**
 * 门洞几何：宽的一轴是门面宽度，另一轴是法线；门只有一格厚。
 * 只读已加载方块，读不到就把范围缩小，不用未观察格猜测更大的门。
 */
export function portalOpening(blockAt: BlockAt, pos: Vec3Like): PortalOpening | null {
  const kind = blockAt(pos);
  if (kind !== 'nether_portal' && kind !== 'end_portal') return null;
  const bottomY = bottomOf(blockAt, pos, kind);
  const start = { x: pos.x, y: bottomY, z: pos.z };
  const xRun = run(blockAt, start, kind, 'x');
  const zRun = run(blockAt, start, kind, 'z');
  const widthAxis: 'x' | 'z' = xRun.max - xRun.min >= zRun.max - zRun.min ? 'x' : 'z';
  const width = widthAxis === 'x' ? xRun : zRun;
  return {
    kind,
    widthAxis,
    bottomY,
    min: width.min,
    max: width.max,
    center: (width.min + width.max + 1) / 2,
    plane: widthAxis === 'x' ? pos.z : pos.x,
    width: width.max - width.min + 1,
  };
}

/**
 * 门外可站的格：脚和头都必须看清是空气，脚下是实心、非液体、非软方块。
 * 未加载/未知不当作可站；不把另一格门方块或岩浆/水当站位。
 */
function standable(blockAt: BlockAt, cell: Vec3Like): boolean {
  const foot = blockAt(cell);
  if (foot === null || !AIR.has(foot)) return false;
  const head = blockAt({ ...cell, y: cell.y + 1 });
  if (head === null || !AIR.has(head)) return false;
  const below = blockAt({ ...cell, y: cell.y - 1 });
  return below !== null && !AIR.has(below) && !LIQUID.has(below) && !isSoftBlock(below) && !isPortal(blockAt, { ...cell, y: cell.y - 1 });
}

/**
 * 下界门的接近格与走向门洞中心的朝向点。
 * 门洞中心按连续宽度计算（两格宽的门中心在两格之间），这样走进门时身体会对准门洞，
 * 不会像按单个门方块坐标瞄准那样斜着撞上黑曜石框。
 */
export function portalApproach(blockAt: BlockAt, pos: Vec3Like): { cell: Vec3Like; center: Vec3Like } | null {
  const opening = portalOpening(blockAt, pos);
  if (!opening || opening.kind !== 'nether_portal') return null;
  let best: { cell: Vec3Like; center: Vec3Like; offset: number } | null = null;
  for (const dir of [1, -1]) {
    for (let t = opening.min; t <= opening.max; t++) {
      const cell = opening.widthAxis === 'x'
        ? { x: t, y: opening.bottomY, z: opening.plane + dir }
        : { x: opening.plane + dir, y: opening.bottomY, z: t };
      if (!standable(blockAt, cell)) continue;
      const offset = Math.abs(t + 0.5 - opening.center);
      if (best && offset >= best.offset) continue;
      const center = opening.widthAxis === 'x'
        ? { x: opening.center, y: opening.bottomY + 1.2, z: opening.plane + 0.5 }
        : { x: opening.plane + 0.5, y: opening.bottomY + 1.2, z: opening.center };
      best = { cell, center, offset };
    }
  }
  return best ? { cell: best.cell, center: best.center } : null;
}

/** 门外安全站位（格中心）；没有可站的面时返回 null。 */
export function portalStance(blockAt: BlockAt, pos: Vec3Like): Vec3Like | null {
  const approach = portalApproach(blockAt, pos);
  return approach ? { x: approach.cell.x + 0.5, y: approach.cell.y, z: approach.cell.z + 0.5 } : null;
}

/**
 * 身体 AABB（0.6×1.8）是否与门方块重叠。
 * 传送触发看的是身体与门方块的重叠，不只是脚所在的那一格；站在门边缘时脚格可能已经不是门，
 * 身体却还压在门上，反过来也一样。
 */
export function bodyOverlapsPortal(blockAt: BlockAt, feet: Vec3Like, kinds: readonly string[] = [...PORTAL_KINDS]): boolean {
  const wanted = new Set(kinds);
  const minX = Math.floor(feet.x - 0.3 + 1e-3), maxX = Math.floor(feet.x + 0.3 - 1e-3);
  const minY = Math.floor(feet.y + 1e-3), maxY = Math.floor(feet.y + 1.8 - 1e-3);
  const minZ = Math.floor(feet.z - 0.3 + 1e-3), maxZ = Math.floor(feet.z + 0.3 - 1e-3);
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
    if (wanted.has(blockAt({ x, y, z }) ?? '')) return true;
  }
  return false;
}
