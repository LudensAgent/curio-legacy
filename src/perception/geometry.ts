import minecraftData from 'minecraft-data';
import BlockFactory from 'prismarine-block';
import type { Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';

/**
 * 局部几何：按「当前已观察 blockstate」解析碰撞盒，判断支撑顶面与身体净空。
 * 只做纯几何，不查询遮挡或未观察区域——上层负责合法观测与未知反馈。
 * 用 prismarine-block 的 fromProperties 取当前状态的碰撞盒，不把方块名属于
 * “实心/可穿过”直接等同于可站立或无碰撞，也不再取所有状态的形状并集。
 *
 * 只给了一部分属性时（例如只写 {type:"bottom"}、没写 waterlogged），按这些属性
 * 能筛出的全部状态求交：形状一致才算确认；形状不一致（如没写 type 的半砖）返回未知，
 * 不用 prismarine 的默认状态冒充实际状态。
 */

const version = config.mc.version;
const data = minecraftData(version);
const Block = BlockFactory(version);

type Box = number[];
export type BlockProps = Record<string, string | number | boolean>;
/** 一个已观察的方块状态；properties 缺省表示只知道名字、不知道具体状态。 */
export interface ObservedState { name: string; properties?: BlockProps }
/** 观测来源：null 表示这一格未知/未看清，不能当成空气。 */
export type StateAt = (pos: Vec3Like) => ObservedState | null;

const AIR = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column']);
/**
 * 原版 1.20.1 `#minecraft:replaceable` 中的植物与火：放方块时直接被顶掉（雪层按已占用处理，见下）。
 * 花、树苗、蘑菇、下界菌不在标签里——它们占着格子时方块放不进去，要先破坏。
 */
const REPLACEABLE_PLANT = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|hanging_roots|seagrass|tall_seagrass|crimson_roots|warped_roots|nether_sprouts|fire|soul_fire|light|structure_void)$/;

/**
 * 放方块时这一格能否被替换：空气、流体，以及原版可被方块直接替换的地面植物/火。
 * 火把、雪层、地毯、半砖、门等沿用 WP3 的“已占用”口径，不在这里放宽。
 */
export const isReplaceable = (name: string): boolean => REPLACEABLE.has(name) || REPLACEABLE_PLANT.test(name);

/** 打开的（非铁）门可以让身体通过；关闭或状态未知的门按碰撞形状处理。 */
export const isPassableDoor = (name: string, properties: BlockProps = {}): boolean =>
  name.endsWith('_door') && name !== 'iron_door' && properties.open === true;

interface StateVariant { properties: Record<string, string | number | boolean>; shapes: Box[] }
const variantCache = new Map<string, StateVariant[]>();
function stateVariants(name: string): StateVariant[] {
  const block = data.blocksByName[name];
  if (!block) return [];
  let variants = variantCache.get(name);
  if (!variants) {
    variants = [];
    for (let id = block.minStateId; id <= block.maxStateId; id++) {
      const state = Block.fromStateId(id, 0) as unknown as { getProperties?: () => Record<string, string | number | boolean>; state?: Record<string, string | number | boolean>; shapes?: Box[] } | null;
      if (!state) continue;
      variants.push({ properties: state.getProperties?.() ?? state.state ?? {}, shapes: state.shapes ?? [] });
    }
    variantCache.set(name, variants);
  }
  return variants;
}

const shapesKey = (shapes: Box[]) => JSON.stringify(shapes);
function matchingVariants(name: string, properties: BlockProps): StateVariant[] {
  const entries = Object.entries(properties);
  return stateVariants(name).filter((variant) => entries.every(([key, value]) => String(variant.properties[key]) === String(value)));
}

/** 给定属性是否能唯一确定这个方块的碰撞形状；false = 还缺关键状态（如没写半砖的 type）。 */
export function shapeKnown(name: string, properties: BlockProps = {}): boolean {
  if (!data.blocksByName[name]) return false;
  const variants = matchingVariants(name, properties);
  if (!variants.length) return false;
  const key = shapesKey(variants[0].shapes);
  return variants.every((variant) => shapesKey(variant.shapes) === key);
}

function resolvedShapes(name: string, properties: BlockProps): Box[] | null {
  if (!data.blocksByName[name]) return null;
  const variants = matchingVariants(name, properties);
  if (!variants.length) return null;
  const key = shapesKey(variants[0].shapes);
  return variants.every((variant) => shapesKey(variant.shapes) === key) ? variants[0].shapes : null;
}

/** 一个方块在当前 blockstate 下的碰撞盒（cell-local，可超出 [0,1]，如栅栏 1.5 高）。形状未确认时返回空数组，调用方须先用 shapeKnown 判断。 */
export function collisionBoxes(name: string, properties: BlockProps = {}): Box[] {
  if (name === null || name === undefined || AIR.has(name)) return [];
  return resolvedShapes(name, properties) ?? [];
}

/** 是否至少有一种与已知属性相符的状态带碰撞盒；用于“不能当空气穿过”的保守判断。 */
export function hasAnyCollision(name: string, properties: BlockProps = {}): boolean {
  if (name === null || name === undefined || AIR.has(name)) return false;
  const variants = matchingVariants(name, properties);
  return variants.length ? variants.some((variant) => variant.shapes.length > 0) : true;
}

/**
 * 一个方块状态里的可站立顶面：顶面高度（cell-local Y）和它在 x/z 上覆盖的范围。
 * 楼梯、内/外角楼梯、箱子等不同顶面只覆盖方块的一部分；只保留高度不够描述支撑时，
 * 局部高顶面会被误当成整格支撑。
 */
export interface SupportSurface { top: number; minX: number; maxX: number; minZ: number; maxZ: number }

/**
 * 一个方块状态的全部可站立顶面（cell-local）；形状未确认或无承重顶面返回空数组。
 * 只认水平跨度够大的顶面（宽、深均 ≥ 0.5），栅栏柱、梯子板、门板这类窄条不能站。
 */
export function supportSurfaces(name: string, properties: BlockProps = {}): SupportSurface[] {
  const boxes = collisionBoxes(name, properties);
  if (!boxes.length || !shapeKnown(name, properties)) return [];
  return boxes
    .filter((box) => box[3] - box[0] >= 0.5 && box[5] - box[2] >= 0.5)
    .map((box) => ({ top: box[4], minX: box[0], maxX: box[3], minZ: box[2], maxZ: box[5] }));
}

/** 最高可站立顶面（cell-local Y）；无顶面或状态形状未确认返回 null。 */
export function supportTop(name: string, properties: BlockProps = {}): number | null {
  const surfaces = supportSurfaces(name, properties);
  return surfaces.length ? Math.max(...surfaces.map((s) => s.top)) : null;
}

/** 水平覆盖范围：用于判断某个支撑面是否真的位于身体脚底下方。 */
export interface Footprint { minX: number; maxX: number; minZ: number; maxZ: number }

/** 站在 cell 中心时的身体脚底范围（0.6×0.6）。 */
const centeredFootprint = (cell: Vec3Like): Footprint => ({
  minX: cell.x + 0.2, maxX: cell.x + 0.8, minZ: cell.z + 0.2, maxZ: cell.z + 0.8,
});

/** 顶面与脚底范围是否有正面积的水平交集；只贴边不算托住。 */
function surfaceOverlaps(surface: SupportSurface, cell: Vec3Like, footprint: Footprint): boolean {
  return cell.x + surface.maxX > footprint.minX && cell.x + surface.minX < footprint.maxX
    && cell.z + surface.maxZ > footprint.minZ && cell.z + surface.minZ < footprint.maxZ;
}

/** cell 内与脚底范围相交的最高支撑面（世界 Y）；没有相交顶面返回 null。 */
function supportSurfaceTop(cell: Vec3Like, state: ObservedState | null, footprint: Footprint): number | null {
  if (!state) return null;
  let top: number | null = null;
  for (const surface of supportSurfaces(state.name, state.properties ?? {})) {
    if (!surfaceOverlaps(surface, cell, footprint)) continue;
    top = top === null ? surface.top : Math.max(top, surface.top);
  }
  return top === null ? null : cell.y + top;
}

/**
 * 相对 step/localMap 的脚高容差：一步之内可站立的非整块顶面都算进所请求的脚格，
 * 覆盖床/切石机 9/16、灵魂沙/箱子/讲台 7/8、土径/耕地 15/16 等；整格 1.0 的落差
 * 仍留给 [1,±1,0]，不能靠平走冒充。step 与 localMap 必须共用同一个值。
 */
export const RELATIVE_FOOT_TOLERANCE = 0.95;
/** 1.20.1 站立玩家的 stepHeight（格）。不超过它由原版自动迈步完成，不需要起跳。 */
export const PLAYER_STEP_HEIGHT = 0.6;
/** 相邻上下级的最小实际高差；更小按同层处理，避免把采样噪声当成台阶。 */
export const MIN_STEP_DELTA = 0.01;

/**
 * 单步竖直关系：同层 0，上一级 1，下一级 -1，超出 ±1 为 null。
 * move_step 预检与局部图的 executable 落点共用这一份判据。
 */
export function verticalStepKind(delta: number): -1 | 0 | 1 | null {
  if (Math.abs(delta) <= MIN_STEP_DELTA) return 0;
  if (delta > 0 && delta <= 1 + MIN_STEP_DELTA) return 1;
  if (delta < 0 && delta >= -1 - MIN_STEP_DELTA) return -1;
  return null;
}

/**
 * 坠落伤害的粗估（生命点，2 点 = 1 颗心）：原版超过 3 格开始受伤，
 * 之后约每多 1 格多 1 点；这里只给决策参考，不把护甲/摔落保护算进去。
 */
export function estimatedFallDamage(drop: number): number {
  return drop > 3 ? Math.ceil(drop - 3) : 0;
}

/**
 * 站在这列时的实际脚高（世界 Y）：优先取脚格里薄层（半砖/雪/地毯/床）的顶面，
 * 否则取脚下一格的支撑顶面。没有已观察的承重面返回 null。
 *
 * cell 必须是方块格坐标（y 为整数格号），不是连续脚高；调用方要先用 feetCell()
 * 把实测脚位或目标脚高换算成脚所在格，否则分数 y 会被当成格坐标再算一次顶面。
 * footprint 缺省按身体站在 cell 中心计算；身体偏心时要传入实测脚底范围。
 */
export function footSurfaceY(cell: Vec3Like, at: StateAt, footprint: Footprint = centeredFootprint(cell)): number | null {
  const inCell = supportSurfaceTop(cell, at(cell), footprint);
  const belowCell = { ...cell, y: cell.y - 1 };
  const below = supportSurfaceTop(belowCell, at(belowCell), footprint);
  if (inCell !== null && (below === null || inCell > below)) return inCell;
  return below;
}

/** 身体 AABB（0.6×1.8）：脚底在 footY，水平居中于整数列 (cx, cz)。 */
export interface BodyBox { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** 身体 AABB 下、顶面与当前脚高齐平的承重格；身体跨格时会包含相邻块边缘。 */
export interface BodySupport { pos: Vec3Like; top: number; name: string }

/**
 * 扫描身体 0.6 宽 AABB 覆盖的所有列，返回实际与脚底范围相交、且顶面正好托住
 * 当前脚高的格子。只报已加载/已观察的承重面；未加载的格子不算支撑，也不猜。
 * 身体中心在一列、AABB 却压到相邻列时（窄柱/边缘），这里会同时报出相邻的支撑格。
 * 只存在于方块另一侧、与脚底不相交的局部高顶面不算支撑。
 */
export function supportCellsUnderBody(pos: Vec3Like, at: StateAt): BodySupport[] {
  const y = Math.floor(pos.y - 0.05);
  const x0 = Math.floor(pos.x - 0.3), x1 = Math.floor(pos.x + 0.3);
  const z0 = Math.floor(pos.z - 0.3), z1 = Math.floor(pos.z + 0.3);
  const footprint: Footprint = { minX: pos.x - 0.3, maxX: pos.x + 0.3, minZ: pos.z - 0.3, maxZ: pos.z + 0.3 };
  const out: BodySupport[] = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    for (const cellY of [y, y - 1]) {
      const state = at({ x, y: cellY, z });
      if (!state) continue;
      const cell = { x, y: cellY, z };
      const top = supportSurfaceTop(cell, state, footprint);
      if (top === null || Math.abs(top - pos.y) > 0.01) continue;
      out.push({ pos: cell, top, name: state.name });
    }
  }
  return out;
}

/**
 * 身体 AABB：身体中心固定在整数列 cx/cz 的中心。调用方传入的是「身体中心所在列」，
 * 不是任意连续坐标；身体偏心压在两列之间时，要先由调用方决定归位或传入正确列。
 */
export function bodyBoxAt(footY: number, cx: number, cz: number): BodyBox {
  return { minX: cx + 0.2, maxX: cx + 0.8, minY: footY, maxY: footY + 1.8, minZ: cz + 0.2, maxZ: cz + 0.8 };
}

/** 身体（脚高 footY、中心列 cx/cz）竖直方向实际覆盖的整数格；只枚举中心列。 */
export function bodyCells(footY: number, cx: number, cz: number): Vec3Like[] {
  const cells: Vec3Like[] = [];
  for (let y = Math.floor(footY); y <= Math.floor(footY + 1.8 - 1e-6); y++) cells.push({ x: cx, y, z: cz });
  return cells;
}

/** 连续脚位的站立身体（0.6×1.8）及直接支撑格；只贴边的邻格不计入。 */
export function standingContactCells(feet: Vec3Like): Vec3Like[] {
  const epsilon = 1e-9;
  const minX = Math.floor(feet.x - 0.3 + epsilon), maxX = Math.floor(feet.x + 0.3 - epsilon);
  const minZ = Math.floor(feet.z - 0.3 + epsilon), maxZ = Math.floor(feet.z + 0.3 - epsilon);
  const minY = Math.floor(feet.y - epsilon), maxY = Math.floor(feet.y + 1.8 - epsilon);
  return Array.from({ length: maxX - minX + 1 }, (_, dx) => minX + dx).flatMap((x) =>
    Array.from({ length: maxZ - minZ + 1 }, (_, dz) => minZ + dz).flatMap((z) =>
      Array.from({ length: maxY - minY + 1 }, (_, dy) => ({ x, y: minY + dy, z }))));
}

/** 方块 (name, properties) 位于 cell，其碰撞盒是否与身体 AABB 相交。状态形状未确认时保守视为可能相交。 */
export function blockCollidesBody(name: string, properties: BlockProps, cell: { x: number; y: number; z: number }, body: BodyBox): boolean {
  if (isPassableDoor(name, properties)) return false;
  if (!shapeKnown(name, properties)) return hasAnyCollision(name, properties);
  for (const box of collisionBoxes(name, properties)) {
    const [x0, y0, z0, x1, y1, z1] = box;
    if (x1 - x0 <= 0 || y1 - y0 <= 0 || z1 - z0 <= 0) continue;
    if (cell.x + x1 > body.minX && cell.x + x0 < body.maxX
      && cell.y + y1 > body.minY && cell.y + y0 < body.maxY
      && cell.z + z1 > body.minZ && cell.z + z0 < body.maxZ) return true;
  }
  return false;
}

/**
 * 身体覆盖的格子中，哪些与碰撞形状相交、哪些还没观察。
 * 只扫描身体中心所在列：这只对「身体在格心」成立；偏心身体须先归位，
 * 不能把这个结果当成任意连续站位的完整碰撞检测。
 */
export function bodyProbe(footY: number, cx: number, cz: number, at: StateAt): { blockers: { cell: Vec3Like; state: ObservedState }[]; unknown: Vec3Like[] } {
  const body = bodyBoxAt(footY, cx, cz);
  const blockers: { cell: Vec3Like; state: ObservedState }[] = [];
  const unknown: Vec3Like[] = [];
  for (const cell of bodyCells(footY, cx, cz)) {
    const state = at(cell);
    if (!state) { unknown.push(cell); continue; }
    if (blockCollidesBody(state.name, state.properties ?? {}, cell, body)) blockers.push({ cell, state });
  }
  return { blockers, unknown };
}

export type PlacementReference = 'observed' | 'unknown' | 'none';
const SIDE_FACES = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];
const FLOOR_SIDE_FACES = [{ x: 0, y: -1, z: 0 }, ...SIDE_FACES];
const ALL_FACES = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, ...SIDE_FACES];

/**
 * 放置这一格时，有没有已观察到的方块面能贴。
 * 适配器能点的是任何有碰撞盒的非空气方块（chest/半砖/地毯等 boundingBox 也是 block），
 * 不是只限完整立方体；实际射线与距离仍由适配器确认。
 * - observed：至少一个方向已看清是可贴面的方块；
 * - unknown：没看到可靠贴面，但还有方向没看清，不能据此断言放不上；
 * - none：这些方向都看清了，却没有可贴面的方块。
 * attach: 'side' 只能贴侧面；'floor_or_side' 可贴地面或侧面；null 为整块方块（任一面）。
 */
export function placementReference(target: Vec3Like, at: StateAt, attach: 'side' | 'floor_or_side' | null = null): PlacementReference {
  const faces = attach === 'side' ? SIDE_FACES : attach === 'floor_or_side' ? FLOOR_SIDE_FACES : ALL_FACES;
  let unknown = false;
  for (const face of faces) {
    const state = at({ x: target.x + face.x, y: target.y + face.y, z: target.z + face.z });
    if (!state) { unknown = true; continue; }
    if (hasAnyCollision(state.name, state.properties ?? {})) return 'observed';
  }
  return unknown ? 'unknown' : 'none';
}
