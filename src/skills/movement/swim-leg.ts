import type { Vec3Like } from '../../adapter/types.ts';
import type { VoxelMap } from 'curio-minecraft-3d-memory';
import { observedFootY } from '../../spatial/land-search.ts';

const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 岸边目标的水平搜索半径；水面中继点更近，避免一次游太远。 */
const SHORE_RADIUS = 24;
const WATER_POINT_RADIUS = 16;
/** 一段游泳至少要让委托推进这么多，否则不值得下水。 */
const MIN_GAIN = 2;

export type SwimTarget = { mode: 'dry_shore' | 'water_point'; pos: Vec3Like; gain: number };

/**
 * 在已观察的体素里，为一次有界游泳挑目标：沿委托推进量最大的岸边站立格（站立面已观察、
 * 脚与头不是水、紧邻水），没有就挑推进量最大的开阔水面点。只读地图，不移动、不观察。
 * gain 衡量相对当前位置的委托推进；allowed 是委托的横向授权等限制。
 */
export function findSwimTarget(map: VoxelMap, dim: string, from: Vec3Like,
  gain: (p: Vec3Like) => number, allowed: (p: Vec3Like) => boolean): SwimTarget | null {
  const nameAt = (x: number, y: number, z: number) => {
    const view = map.cellAt(dim, x, y, z);
    return view.observed && view.evidence.observation.stateComplete ? view.evidence.observation.state.name.replace(/^minecraft:/, '') : null;
  };
  const water = (x: number, y: number, z: number) => WATER.has(nameAt(x, y, z) ?? '');
  const fx = Math.floor(from.x), fy = Math.floor(from.y), fz = Math.floor(from.z);
  let shore: SwimTarget | null = null, open: SwimTarget | null = null;
  const better = (current: SwimTarget | null, next: SwimTarget) => current === null || next.gain > current.gain + 1e-9
    || Math.abs(next.gain - current.gain) <= 1e-9 && Math.hypot(next.pos.x - from.x, next.pos.z - from.z) < Math.hypot(current.pos.x - from.x, current.pos.z - from.z);
  for (let dx = -SHORE_RADIUS; dx <= SHORE_RADIUS; dx++) for (let dz = -SHORE_RADIUS; dz <= SHORE_RADIUS; dz++) {
    const distance = Math.hypot(dx, dz);
    if (distance > SHORE_RADIUS) continue;
    const x = fx + dx, z = fz + dz;
    const foot = observedFootY(map, dim, x, z, from.y, 3, 3);
    if (foot !== null) {
      const pos = { x: x + 0.5, y: foot, z: z + 0.5 };
      const feetY = Math.floor(foot + 1e-6);
      const dry = !water(x, feetY, z) && !water(x, feetY + 1, z);
      const besideWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => water(x + ox!, feetY, z + oz!) || water(x + ox!, feetY - 1, z + oz!));
      const g = gain(pos);
      if (dry && besideWater && g >= MIN_GAIN && allowed(pos)) {
        const candidate = { mode: 'dry_shore' as const, pos, gain: g };
        if (better(shore, candidate)) shore = candidate;
      }
    }
    if (distance > WATER_POINT_RADIUS) continue;
    for (let y = fy - 1; y <= fy + 1; y++) {
      if (!water(x, y, z) || !AIR.has(nameAt(x, y + 1, z) ?? '')) continue;
      const pos = { x: x + 0.5, y, z: z + 0.5 };
      const g = gain(pos);
      if (g < MIN_GAIN || !allowed(pos)) continue;
      const candidate = { mode: 'water_point' as const, pos, gain: g };
      if (better(open, candidate)) open = candidate;
    }
  }
  return shore ?? open;
}

/** 陆路停下时离水多近才改为游泳：游泳控制器会从干岸自己走进水里。 */
const WATER_AHEAD_RADIUS = 4;

/** 当前站位附近、沿委托有推进的方向上是否有已观察的水（脚高或下一层）。 */
export function waterAhead(map: VoxelMap, dim: string, from: Vec3Like, gain: (p: Vec3Like) => number): boolean {
  const fx = Math.floor(from.x), fy = Math.floor(from.y), fz = Math.floor(from.z);
  for (let dx = -WATER_AHEAD_RADIUS; dx <= WATER_AHEAD_RADIUS; dx++) for (let dz = -WATER_AHEAD_RADIUS; dz <= WATER_AHEAD_RADIUS; dz++) {
    if (gain({ x: fx + dx + 0.5, y: from.y, z: fz + dz + 0.5 }) <= 0) continue;
    for (const y of [fy, fy - 1]) {
      const view = map.cellAt(dim, fx + dx, y, fz + dz);
      if (view.observed && WATER.has(view.evidence.observation.state.name.replace(/^minecraft:/, ''))) return true;
    }
  }
  return false;
}
