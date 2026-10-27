import type { Vec3Like } from '../adapter/types.ts';

/**
 * 紧急救援：Bot 卡在出不来的地方（坑底、矿道、墙缝、水下）时，操作者在控制台点一下，
 * 找离它最近的一块露天平地，用 RCON /tp 把它传送过去。只是操作者的“手”，不是 Bot 自己的能力。
 */

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
/** 从上往下找地面时当作空的：草、花、雪层这些踩上去就是站在下面那格上 */
const SOFT = new Set([...AIRISH, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'dandelion', 'poppy',
  'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom', 'red_mushroom', 'torch', 'wall_torch', 'vine', 'glow_lichen', 'pink_petals']);
/** 地面最上面一格是这些就不能落脚：液体、会伤人的、树冠（落在树顶上又是被困） */
const BAD_TOP = /^(water|lava|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant|magma_block|cactus|fire|soul_fire|campfire|soul_campfire|powder_snow|sweet_berry_bush|pointed_dripstone|lily_pad|.*_leaves|.*_fence|.*_wall|.*_fence_gate|bamboo|scaffolding|cobweb)$/;

type BlockAt = (p: Vec3Like) => string | null;
export interface SurfaceSpot { x: number; y: number; z: number; dist: number }

/** 一列方块的地面：从上往下第一块“实”的方块；null = 区块没加载或整列没地面 */
function groundY(blockAt: BlockAt, x: number, z: number, top: number, bottom: number): { y: number; name: string } | null {
  for (let y = top; y >= bottom; y--) {
    const n = blockAt({ x, y, z });
    if (n === null) return null;
    if (SOFT.has(n)) continue;
    return { y, name: n };
  }
  return null;
}

/**
 * 找离 from 最近的露天落脚点（站的那格 y = 地面 + 1，头顶直通天空）。
 * - 地面不能是水、岩浆、树叶这类；
 * - 要是一小块平地：四周至少两列地面和它差不到一格（坑底、柱子顶不算）；
 * - 不要就在原地（本来就站在露天平地上卡住的话，往旁边挪）。
 * 一圈一圈往外找，同一圈里挑高度和现在最接近的。只适用于有天空的维度（主世界）。
 */
export function findSurfaceSpot(blockAt: BlockAt, from: Vec3Like, opts: { radius?: number; top?: number; bottom?: number } = {}): SurfaceSpot | null {
  const radius = opts.radius ?? 32, top = opts.top ?? 319, bottom = opts.bottom ?? -63;
  const fx = Math.floor(from.x), fz = Math.floor(from.z);
  const cache = new Map<string, { y: number; name: string } | null>();
  const ground = (x: number, z: number) => {
    const k = `${x},${z}`;
    if (!cache.has(k)) cache.set(k, groundY(blockAt, x, z, top, bottom));
    return cache.get(k)!;
  };
  const ok = (x: number, z: number): number | null => {
    const g = ground(x, z);
    if (!g || BAD_TOP.test(g.name)) return null;
    let flat = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = ground(x + dx, z + dz);
      if (n && !BAD_TOP.test(n.name) && Math.abs(n.y - g.y) <= 1) flat++;
    }
    if (flat < 2) return null;
    const y = g.y + 1;
    if (Math.hypot(x + 0.5 - from.x, z + 0.5 - from.z) < 2 && Math.abs(y - from.y) < 1.5) return null; // 就是现在站的地方
    return y;
  };
  for (let r = 0; r <= radius; r++) {
    let best: SurfaceSpot | null = null, bestScore = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = fx + dx, z = fz + dz;
      const y = ok(x, z);
      if (y === null) continue;
      const dist = Math.hypot(x + 0.5 - from.x, z + 0.5 - from.z);
      const score = dist + Math.abs(y - from.y) * 0.05;
      if (score < bestScore) { bestScore = score; best = { x, y, z, dist: Math.round(dist * 10) / 10 }; }
    }
    if (best) return best;
  }
  return null;
}
