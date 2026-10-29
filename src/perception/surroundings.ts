import type { GameAdapter, Vec3Like } from '../adapter/types.ts';

/**
 * 身边一圈的方块：脚下、头顶、四个方向能不能走。
 * 这是玩家贴身就能看到、摸到的东西（不是透视），用来判断“我是不是被困住了、往哪能出去”。
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 能直接穿过去的（不挡路） */
const SOFT = /^(air|cave_air|void_air|ladder|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|torch|wall_torch|.*_torch|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|.*_sapling|.*_mushroom|sugar_cane|vine|.*_carpet|rail|.*_rail|redstone_wire|.*_button|lever|tripwire|.*_pressure_plate|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

/** 贴墙放的东西能挂在哪一面：梯子只能挂在实心方块的侧面；火把、告示牌、杠杆可以立在地上或挂墙；其余整块方块哪面都行（null） */
export function attachmentFaces(name: string): 'side' | 'floor_or_side' | null {
  if (name === 'ladder' || /_wall_(sign|torch|banner|fan)$|^(tripwire_hook|item_frame|glow_item_frame|painting)$/.test(name)) return 'side';
  if (/(^|_)torch$|_sign$|_banner$|^(lever|.*_button)$/.test(name)) return 'floor_or_side';
  return null;
}


export const DIR_OFFSETS: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
export type ExitOptions = Record<string, { walk: boolean | null; step_down: boolean | null; step_up: boolean | null }>;

const soft = (n: string | null) => n == null || SOFT.test(n);
const solidFloor = (n: string | null) => n != null && !SOFT.test(n) && !LIQUID.has(n);

export interface Surroundings {
  /** 一句话：脚下｜头顶｜天空｜能走的方向｜挡路的方向 */
  text: string;
  /** 四面都走不了 */
  enclosed: boolean;
  exits: string[];
  exitOptions: ExitOptions;
  sky: boolean;
  below: string | null;
  above: string | null;
  /** Touch-local coordinates, distinct from the body's feet position. */
  support: { block: string | null; pos: Vec3Like };
  feet: { block: string | null; pos: Vec3Like };
  head: { block: string | null; pos: Vec3Like };
}

export function surroundings(adapter: GameAdapter, pos: Vec3Like = adapter.state().pos): Surroundings {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const at = (dx: number, dy: number, dz: number) => adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
  const supportPos = { x, y: Math.floor(pos.y - .01), z };
  const below = adapter.blockAt(supportPos), above = at(0, 2, 0);
  // 天光 ≥ 12：露天（树冠、草叶只会挡掉一两级）
  const sky = (adapter.lightAt(x, y + 1, z)?.sky ?? 0) >= 12;
  const exits: string[] = [], blocked: string[] = [];
  const exitOptions: ExitOptions = {};
  for (const [d, [dx, dz]] of Object.entries(DIR_OFFSETS)) {
    const feet = at(dx, 0, dz), head = at(dx, 1, dz);
    const floor = at(dx, -1, dz), lowerFloor = at(dx, -2, dz), upperHead = at(dx, 2, dz);
    const unknown = feet === null || head === null;
    exitOptions[d] = {
      walk: unknown ? null : !soft(feet) || !soft(head) ? false : floor === null ? null : solidFloor(floor),
      step_down: unknown ? null : !soft(feet) || !soft(head) ? false : floor === null ? null : !soft(floor) || LIQUID.has(floor) ? false : lowerFloor === null ? null : solidFloor(lowerFloor),
      step_up: unknown ? null : soft(feet) || !solidFloor(feet) || !soft(head) ? false : upperHead === null || above === null ? null : soft(upperHead) && soft(above),
    };
    if (feet === null || head === null) blocked.push(`${d} 邻格未加载`);
    else if (soft(feet) && soft(head)) {
      if (exitOptions[d].walk) exits.push(d);
      else if (exitOptions[d].step_down) exits.push(`${d}↓`);
      else if (LIQUID.has(floor ?? '')) blocked.push(`${d} ${floor}`);
      else if (exitOptions[d].walk === null || exitOptions[d].step_down === null) blocked.push(`${d} 下方未知`);
      else blocked.push(`${d} 下方有落差，需观察落点`);
    } else if (exitOptions[d].step_up) exits.push(`${d}↑`); // 跳上一格
    else blocked.push(`${d} ${[feet, head].filter((n) => !soft(n)).join('/')}`);
  }
  const parts = [
    `脚下 ${below ?? '?'}`,
    soft(above) ? '头顶空着' : `头顶上方 ${above}`,
    sky ? '看得见天空' : '看不见天空',
    exits.length ? `一步内可走：${exits.join('、')}（↑ 上一级，↓ 下一级，无箭头为同层）` : '没有确认可走的一步落点',
    ...(blocked.length ? [`挡住：${blocked.join('，')}`] : []),
  ];
  return { text: parts.join('｜'), enclosed: exits.length === 0, exits, exitOptions, sky, below, above,
    support: { block: below, pos: supportPos }, feet: { block: at(0, 0, 0), pos: { x, y, z } },
    head: { block: at(0, 1, 0), pos: { x, y: y + 1, z } } };
}

export { AIR as AIR_BLOCKS, LIQUID as LIQUID_BLOCKS, soft as isSoftBlock };
