import type { GameAdapter, Vec3Like } from '../adapter/types.ts';

/**
 * 身边一圈的方块：脚下、头顶、四个方向能不能走。
 * 这是玩家贴身就能看到、摸到的东西（不是透视），用来判断“我是不是被困住了、往哪能出去”。
 */

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** 能直接穿过去的（不挡路）；传送门（下界门/末地门/折跃门）也是能走进去的，算可通行 */
const SOFT = /^(air|cave_air|void_air|nether_portal|end_portal|end_gateway|ladder|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|torch|wall_torch|.*_torch|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|.*_sapling|.*_mushroom|sugar_cane|vine|.*_carpet|rail|.*_rail|redstone_wire|.*_button|lever|tripwire|.*_pressure_plate|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const LIQUID = new Set(['water', 'lava', 'bubble_column']);

/** 1.20.1 原版能种下普通树苗的土壤（目标格正下方必须是其中一种）。 */
export const SAPLING_SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'moss_block', 'rooted_dirt', 'mud', 'muddy_mangrove_roots']);

/** 树苗类物品：树木树苗 *_sapling 与红树苗 mangrove_propagule；不含 azalea 等灌木。 */
export const isTreeSaplingItem = (name: string) => /_sapling$/.test(name) || name === 'mangrove_propagule';

/** 按物品取可种土壤：红树苗在普通树苗土壤外多认 clay（1.20.1），普通树苗不能种在黏土上。 */
const MANGROVE_SOIL = new Set([...SAPLING_SOIL, 'clay']);
export const saplingSoilFor = (item: string) => item === 'mangrove_propagule' ? MANGROVE_SOIL : SAPLING_SOIL;

/** 给错误信息用的土壤说明（红树苗与普通树苗口径不同）。 */
export const saplingSoilText = (item: string) => item === 'mangrove_propagule'
  ? '草方块/泥土/砂土/灰化土/菌丝体/苔藓块/缠根泥土/泥/沾泥的红树根/黏土'
  : '草方块/泥土/砂土/灰化土/菌丝体/苔藓块/缠根泥土/泥/沾泥的红树根（普通树苗不能种在黏土上）';

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

/**
 * 挖掉 pos 这格（通常是脚下支撑块）后身体会往下掉几格：向下扫最多 3 格找第一个实心落点（3 格以内不掉血）。
 * 0 = 未加载或落差超过 3 格（不安全）；landing 为液体时也属于「会掉进去」的不安全落点。
 */
export function dropBelow(adapter: { blockAt(pos: Vec3Like): string | null }, pos: Vec3Like): { drop: number; landing: string | null } {
  let drop = 0, landing: string | null = null;
  for (let d = 1; d <= 3; d++) {
    const b = adapter.blockAt({ x: pos.x, y: pos.y - d, z: pos.z });
    if (b === null) break;                          // 未加载：落点未知，按不安全处理
    if (LIQUID.has(b)) { landing = b; drop = d; break; } // 会掉进液体
    if (!soft(b)) { landing = b; drop = d; break; }      // 实心落点
    // 软的（空气/草/藤蔓/铁轨…）继续往下扫
  }
  return { drop, landing };
}

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
  /** 脚下这一列向下最近的落点：null = 正站在实心地板上；{depth, block} = 悬空时向下最近的实心/液体落点（depth 0 = 超过 3 格或未加载看不清） */
  drop: { depth: number; block: string | null } | null;
}

export function surroundings(adapter: GameAdapter, pos: Vec3Like = adapter.state().pos): Surroundings {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const at = (dx: number, dy: number, dz: number) => adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
  const supportPos = { x, y: Math.floor(pos.y - .01), z };
  const below = adapter.blockAt(supportPos), above = at(0, 2, 0);
  // 脚下这一列向下最近的落点：站在实心地板上是 null；悬空（脚下是空气/液体/不满一格的东西）时向下扫
  // 最多 3 格（空气透明、看得见），报告离脚底最近的实心/液体落点；超过 3 格或未加载则 depth=0。
  const drop = below !== null && !solidFloor(below) ? (() => {
    const scan = dropBelow(adapter, supportPos);
    return scan.drop > 0 ? { depth: scan.drop, block: scan.landing } : { depth: 0, block: null };
  })() : null;
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
  const feetBlock = at(0, 0, 0), headBlock = at(0, 1, 0);
  // 身体占据的两格：软方块（传送门、水）不挡路，单看“脚下支撑”会以为站在普通地板上；
  // 把这两格实际是什么直接说出来，避免站在门方块里还以为自己在门旁。
  const bodyCells = [...new Set([feetBlock, headBlock].filter((n): n is string => !!n && !AIR.has(n)))];
  const parts = [
    `脚下 ${below ?? '?'}`,
    ...(bodyCells.length ? [`身体所在格 ${bodyCells.join('/')}`] : []),
    ...(drop ? [drop.depth > 0 ? `悬空，向下 ${drop.depth} 格是 ${drop.block}` : '悬空，向下超过 3 格看不清落点'] : []),
    soft(above) ? '头顶空着' : `头顶上方 ${above}`,
    sky ? '看得见天空' : '看不见天空',
    exits.length ? `一步内可走：${exits.join('、')}（↑ 上一级，↓ 下一级，无箭头为同层）` : '没有确认可走的一步落点',
    ...(blocked.length ? [`挡住：${blocked.join('，')}`] : []),
  ];
  return { text: parts.join('｜'), enclosed: exits.length === 0, exits, exitOptions, sky, below, above, drop,
    support: { block: below, pos: supportPos }, feet: { block: feetBlock, pos: { x, y, z } },
    head: { block: headBlock, pos: { x, y: y + 1, z } } };
}

export { AIR as AIR_BLOCKS, LIQUID as LIQUID_BLOCKS, soft as isSoftBlock };
