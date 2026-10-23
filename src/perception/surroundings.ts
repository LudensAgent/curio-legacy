import type { GameAdapter, Vec3Like } from '../adapter/types.ts';

/**
 * 身边一圈的方块：脚下、头顶、四个方向能不能走。
 * 这是玩家贴身就能看到、摸到的东西（不是透视），用来判断“我是不是被困住了、往哪能出去”。
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 能直接穿过去的（不挡路） */
const SOFT = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|torch|wall_torch|.*_torch|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|.*_sapling|.*_mushroom|sugar_cane|vine|.*_carpet|rail|.*_rail|redstone_wire|.*_button|lever|tripwire|.*_pressure_plate|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

export const DIR_OFFSETS: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

const soft = (n: string | null) => n == null || SOFT.test(n);
const solidFloor = (n: string | null) => n != null && !SOFT.test(n) && !LIQUID.has(n);

export interface Surroundings {
  /** 一句话：脚下｜头顶｜天空｜能走的方向｜挡路的方向 */
  text: string;
  /** 四面都走不了 */
  enclosed: boolean;
  exits: string[];
  sky: boolean;
  below: string | null;
  above: string | null;
}

export function surroundings(adapter: GameAdapter, pos: Vec3Like = adapter.state().pos): Surroundings {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const at = (dx: number, dy: number, dz: number) => adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
  const below = at(0, -1, 0), above = at(0, 2, 0);
  // 天光 ≥ 12：露天（树冠、草叶只会挡掉一两级）
  const sky = (adapter.lightAt(x, y + 1, z)?.sky ?? 0) >= 12;
  const exits: string[] = [], blocked: string[] = [];
  for (const [d, [dx, dz]] of Object.entries(DIR_OFFSETS)) {
    const feet = at(dx, 0, dz), head = at(dx, 1, dz);
    if (soft(feet) && soft(head)) {
      // 平走；或者往下一格
      if (solidFloor(at(dx, -1, dz)) || solidFloor(at(dx, -2, dz))) exits.push(d);
      else if (LIQUID.has(at(dx, -1, dz) ?? '')) blocked.push(`${d} ${at(dx, -1, dz)}`);
      else blocked.push(`${d} 断崖`);
    } else if (!soft(feet) && soft(head) && soft(at(dx, 2, dz)) && soft(above)) exits.push(`${d}↑`); // 跳上一格
    else blocked.push(`${d} ${[feet, head].filter((n) => !soft(n)).join('/')}`);
  }
  const parts = [
    `脚下 ${below ?? '?'}`,
    soft(above) ? '头顶空着' : `头顶上方 ${above}`,
    sky ? '看得见天空' : '看不见天空',
    exits.length ? `能走：${exits.join('、')}` : '四面都走不了',
    ...(blocked.length ? [`挡住：${blocked.join('，')}`] : []),
  ];
  return { text: parts.join('｜'), enclosed: exits.length === 0, exits, sky, below, above };
}

export { AIR as AIR_BLOCKS, LIQUID as LIQUID_BLOCKS, soft as isSoftBlock };
