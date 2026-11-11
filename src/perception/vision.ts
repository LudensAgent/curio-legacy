import type { BlockHit, BlockObservation, EntityInfo, Eye, GameAdapter, Optics, Vec3Like } from '../adapter/types.ts';
import type { LandingOption } from '../skills/types.ts';
import minecraftData from 'minecraft-data';
import { isResourceBlock } from '../memory/ore-spots.ts';

/**
 * AI 视觉（不使用图片）：用区块数据模拟“人眼能看到的范围”。
 *
 * - 视锥：以角色当前的 yaw/pitch 为中心，水平 FOV × 垂直 FOV 发射 cols × rows 条射线（像一台低分辨率相机）
 * - 遮挡：每条射线用体素遍历（Amanatides & Woo DDA）前进，遇到第一个不透明方块就停下 → 只能看到表面，不能透视
 * - 透明介质：空气/玻璃/草/花可穿过；水最多穿过 6 格；树叶最多穿过 2 层
 * - 光照：命中面的亮度决定能看多远（全黑仍能看清身边约 10 格；下界有维度环境光，不按漆黑处理）
 * - 实体：在视锥内 + 视线不被遮挡 + 足够亮 才算“看见”；看不见但离得近的算“听见”（只有大致方向和距离）
 * - 记忆：看见过的资源方块会被记住（位置 + 时间），转身之后仍然知道它在哪
 *
 * 上层（感知摘要、LLM、技能、反射层）只能通过这个模块获取方块和实体信息。
 */

export interface VisionConfig {
  /** 能看多远（格）。0 = 自动：服务器实际下发的渲染距离（view-distance × 16），最高 64 格 */
  range: number;
  hFov: number; // 度
  vFov: number; // 度
  cols: number;
  rows: number;
  hearRadius: number;
  /** 地平线高分辨率带：远处的树/结构都在地平线附近，用更密的射线只做“发现”，不画进画面 */
  bandCols: number;
  bandRows: number;
}

// 垂直视野 96°：平视时上缘达 +48°，能看见两格高空间里正头顶那一格；
// 72°/84° 时正头顶恰好落在视锥上缘外，只有前一格能看见。
export const DEFAULT_VISION: VisionConfig = { range: 0, hFov: 120, vFov: 96, cols: 40, rows: 32, hearRadius: 10, bandCols: 160, bandRows: 8 };
const FALLBACK_RANGE = 64;
const MAX_RANGE = 64;

/** 维度环境光：末地光照贴图整体提亮；下界没有天光，但维度环境光约 7，玩家仍能看清远处地形。 */
export const DIM_AMBIENT_LIGHT: Record<string, number> = { the_end: 4, the_nether: 7 };

/** 看得清多远：亮处全视距，昏暗 20 格，微光 14 格，全黑 10 格（不是透视）。 */
const seeRangeOf = (light: number, range: number) => (light >= 4 ? range : light >= 2 ? 20 : light >= 1 ? 14 : 10);

export const CATS = ['unknown', 'sky', 'dark', 'water', 'lava', 'leaves', 'wood', 'grass', 'dirt', 'sand', 'stone', 'ore', 'snow', 'plant', 'built', 'other'] as const;
export type Cat = (typeof CATS)[number];
const CAT_INDEX: Record<string, number> = Object.fromEntries(CATS.map((c, i) => [c, i]));

const STONE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'bedrock', 'netherrack', 'blackstone', 'basalt', 'dripstone_block', 'mossy_cobblestone', 'smooth_stone', 'end_stone', 'obsidian']);
const DIRT = new Set(['dirt', 'coarse_dirt', 'rooted_dirt', 'farmland', 'dirt_path', 'mud', 'clay', 'soul_sand', 'soul_soil']);
const SAND = new Set(['sand', 'red_sand', 'gravel', 'sandstone', 'red_sandstone', 'terracotta']);
const GRASS = new Set(['grass_block', 'moss_block', 'mycelium', 'podzol']);
const SNOW = new Set(['snow', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'powder_snow']);
const PLANT = new Set(['cactus', 'pumpkin', 'melon', 'sugar_cane', 'bamboo', 'hay_block', 'brown_mushroom_block', 'red_mushroom_block', 'sweet_berry_bush', 'wheat']);

export function catOf(name: string): Cat {
  if (name.endsWith('_ore') || name === 'ancient_debris') return 'ore';
  if (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem')) return 'wood';
  if (name.endsWith('_leaves')) return 'leaves';
  if (name === 'water' || name === 'bubble_column' || name === 'kelp' || name === 'seagrass') return 'water';
  if (name === 'lava') return 'lava';
  if (GRASS.has(name)) return 'grass';
  if (DIRT.has(name)) return 'dirt';
  if (SAND.has(name) || name.endsWith('_terracotta')) return 'sand';
  if (STONE.has(name)) return 'stone';
  if (SNOW.has(name)) return 'snow';
  if (PLANT.has(name)) return 'plant';
  if (/_planks$|crafting_table|chest|furnace|bricks|_door$|_bed$|torch|bell|_slab$|_stairs$|_fence|glass/.test(name)) return 'built';
  return 'other';
}

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const BLOCK_NAMES = minecraftData('1.20.1').blocksArray.map((block) => block.name);
/** 名称后缀表示同一交互机制；变种由当前版本的注册表提供。 */
const INTERACTIVE_FAMILIES = [['_door', '门'], ['_trapdoor', '活板门'], ['_fence_gate', '栅栏门'], ['_button', '按钮'],
  ['_pressure_plate', '压力板'], ['_sign', '告示牌'], ['_shulker_box', '潜影盒'], ['_bed', '床']];
/** 可交互的功能方块：记录世界事实，不决定何时或如何使用。 */
export const INTERACTIVE_BLOCKS: Record<string, string> = {
  crafting_table: '工作台', furnace: '熔炉', smoker: '烟熏炉', blast_furnace: '高炉', chest: '箱子', trapped_chest: '陷阱箱', barrel: '木桶',
  ender_chest: '末影箱', anvil: '铁砧', chipped_anvil: '开裂的铁砧', damaged_anvil: '损坏的铁砧', enchanting_table: '附魔台', smithing_table: '锻造台',
  stonecutter: '切石机', loom: '织布机', grindstone: '砂轮', brewing_stand: '酿造台', cauldron: '炼药锅', water_cauldron: '炼药锅', composter: '堆肥桶',
  lectern: '讲台', cartography_table: '制图台', fletching_table: '制箭台', note_block: '音符盒', jukebox: '唱片机', bell: '钟', beacon: '信标',
  respawn_anchor: '重生锚', lodestone: '磁石', campfire: '营火', soul_campfire: '灵魂营火', hopper: '漏斗', dispenser: '发射器', dropper: '投掷器',
  lever: '拉杆', shulker_box: '潜影盒', repeater: '红石中继器', comparator: '红石比较器', daylight_detector: '阳光探测器', cake: '蛋糕',
  lava_cauldron: '炼药锅', powder_snow_cauldron: '炼药锅', chiseled_bookshelf: '雕纹书架', end_portal_frame: '末地传送门框架',
  beehive: '蜂箱', bee_nest: '蜂巢',
  ...Object.fromEntries(BLOCK_NAMES.flatMap((name) => {
    const family = INTERACTIVE_FAMILIES.find(([suffix]) => name.endsWith(suffix));
    return family ? [[name, family[1]]] : [];
  })),
};
export const interactiveName = (block: string): string | undefined => INTERACTIVE_BLOCKS[block];

/** 与持久资源分类使用同一入口，避免看见了却无法留下地点。 */
export const NOTABLE = new Set([
  ...LOGS, ...BLOCK_NAMES.filter(isResourceBlock), ...Object.keys(INTERACTIVE_BLOCKS), 'spawner', 'hay_block', 'sugar_cane',
  'pumpkin', 'melon', 'obsidian', 'clay', 'sweet_berry_bush', 'nether_portal', 'end_portal', 'end_gateway', 'end_portal_frame', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'bookshelf', 'iron_bars',
]);
/** 采集目标常用的地表方块：也记住，但每种限量 */
export const GROUND = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'dirt', 'grass_block', 'sand', 'gravel', 'short_grass', 'tall_grass', 'grass', 'fern', 'water', 'netherrack', 'blackstone', 'basalt', 'soul_sand', 'soul_soil', 'end_stone', 'snow_block', 'ice', 'packed_ice', 'blue_ice']);

export interface SeenEntity {
  /** 一眼看得出的特征（羊毛颜色、幼崽、村民职业……） */
  traits?: string;
  id: number;
  name: string;
  kind: EntityInfo['kind'];
  pos: Vec3Like;
  dist: number;
  height?: number;
  velocity?: Vec3Like;
  phase?: number;
  hp?: number;
  fusing?: boolean;
  count?: number;
  dir: string; // 绝对方向 N/NE/...
  rel: string; // 相对方向 正前/右前/...
  how: 'seen' | 'heard';
  u?: number; // 画面坐标 0..1（仅 seen）
  v?: number;
}

interface Known {
  name: string;
  pos: Vec3Like;
  lastSeen: number;
}

export interface VisionFrame {
  cols: number;
  rows: number;
  cats: number[];
  dists: number[]; // 0..255 归一化
  facing: string;
  range: number;
  entities: { name: string; kind: string; u: number; v: number; dist: number }[];
  ts: number;
  scanMs: number;
  scanReason: 'direct' | 'refresh' | 'movement';
}

const DIR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const REL_NAMES = ['正前', '左前', '左侧', '左后', '正后', '右后', '右侧', '右前'];

const norm = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};
/** 与 mineflayer lookAt 相同的约定：yaw = atan2(-dx, -dz) */
export const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
export const dirOfYaw = (yaw: number) => DIR_NAMES[((Math.round(-norm(yaw) / (Math.PI / 4)) % 8) + 8) % 8];
export const relOf = (rel: number) => REL_NAMES[((Math.round(norm(rel) / (Math.PI / 4)) % 8) + 8) % 8];

/**
 * 体素遍历：从 (ox,oy,oz) 沿单位向量 (dx,dy,dz) 前进到 max，依次访问每个经过的方块格。
 * visit 返回 true 时停止。
 */
export function raycast(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number,
  visit: (x: number, y: number, z: number, t: number) => boolean | number,
) {
  // visit 返回 true = 停止；返回数字 = 直接跳到该距离继续（用于跳过整段空气区块）
  let t0 = 0;
  for (let restart = 0; restart < 64; restart++) {
    const px = ox + dx * t0, py = oy + dy * t0, pz = oz + dz * t0;
    let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = t0 + (dx > 0 ? (x + 1 - px) * tdx : dx < 0 ? (px - x) * tdx : Infinity);
    let tmy = t0 + (dy > 0 ? (y + 1 - py) * tdy : dy < 0 ? (py - y) * tdy : Infinity);
    let tmz = t0 + (dz > 0 ? (z + 1 - pz) * tdz : dz < 0 ? (pz - z) * tdz : Infinity);
    let t = t0;
    let jumped = false;
    for (let guard = 0; guard < 2000 && t <= max; guard++) {
      const r = visit(x, y, z, t);
      if (r === true) return;
      if (typeof r === 'number' && r > t) {
        t0 = r + 1e-4;
        jumped = true;
        break;
      }
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
      else { z += sz; t = tmz; tmz += tdz; }
    }
    if (!jumped || t0 > max) return;
  }
}

/** 射线离开 (x,y,z) 所在 16³ 区段时的距离 */
function sectionExit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: number, y: number, z: number): number {
  const bx = x & ~15, by = y & ~15, bz = z & ~15;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (bx + 16 - ox) / dx); else if (dx < 0) t = Math.min(t, (bx - ox) / dx);
  if (dy > 0) t = Math.min(t, (by + 16 - oy) / dy); else if (dy < 0) t = Math.min(t, (by - oy) / dy);
  if (dz > 0) t = Math.min(t, (bz + 16 - oz) / dz); else if (dz < 0) t = Math.min(t, (bz - oz) / dz);
  return t;
}

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
export const RESOURCE_MEMORY_TTL_MS = 15 * 60_000;
/**
 * 每帧最多把这么多格视线证据写进共享空间记忆（近的先写）。已驻留的 Section 直接写入；只有已存盘
 * 未驻留的格才进共享会话的待载队列（上限 MAX_PENDING_OBSERVATIONS=256，所有写入方共用，超出记为缺口，
 * 到刷新时间会重写）。近处透明格整段记录后，一个新画面约有一两千格，上限需让它在几帧内写完。
 */
export const VISION_FEED_MAX_CELLS = 512;
/**
 * 同一格名字没变时，隔这么久才补写一次。体素不按时间过期，这只补上写入时被丢弃的格（待载队列满、暂停）；
 * 每次重写都让区段变“脏”，下次保存前不能换出常驻内存，频繁重写会让工作集塞满、新区段加载不进来。
 */
export const VISION_FEED_REFRESH_MS = 300_000;
/** 每条视线除命中格外，还写入命中前紧挨着的几格透明格（命中面上方的落脚/头部空间）。 */
const FEED_TRAIL = 3;
/**
 * 这个距离内，视线穿过的、贴近地面（脚部/头部高度）的透明格都已被看清，全部写入。只记命中前几格时，
 * 平地上头部高度的空气只有身前一格被记录，行走所需的身体净空在两格外就成了未观察。更远处仍只记命中前几格。
 */
const VISION_NEAR_FEED_RADIUS = 12;
const CLEAR_AIR: Optics = { name: 'air', kind: 'clear' };
/**
 * 身体周围可感知的开放空间：从身体所在格沿透明格（空气/水）连通扩展，水平半径与上下范围内，
 * 记录贴地的透明格与包围这片空间的表面方块。玩家对身边地形的感知不限于正前方视锥；
 * 不穿墙：封闭在实心方块后面的洞穴、矿石不会被扩展到。只写导航体素，不进资源记忆。
 */
export const SURROUND_RADIUS = 16;
const SURROUND_DOWN = 6, SURROUND_UP = 5;
/**
 * 行走判定读取目标列从“脚下最大落差再下一格”到头顶的全部格（4 格落差时为脚下 5 格到脚上 2 格）。
 * 这一层里开放空间的空气全记，悬崖边整列都有证据；更高处只记贴地空气。
 */
const SURROUND_WALK_BAND_UP = 2;
/** 身体移动这么远、或隔这么久才重扫一次周边。 */
const SURROUND_MOVE = 2, SURROUND_INTERVAL_MS = 1500;
/** 周边扫描每次最多写入的格数（近的先写）；首轮未写完的下一轮继续。 */
const SURROUND_MAX_CELLS = 1024;
type FeedCell = { x: number; y: number; z: number; name: string; d: number };

/** Nearest opaque shape hit, rather than the boundary of a thin block's voxel. */
function shapeHitDistance(shapes: NonNullable<Optics['shapes']>, eye: Eye, dx: number, dy: number, dz: number,
  x: number, y: number, z: number, max: number): number | null {
  let nearest = Infinity;
  for (const box of shapes) {
    let near = 0, far = max;
    const origin = [eye.x - x, eye.y - y, eye.z - z], direction = [dx, dy, dz];
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(direction[axis]) < 1e-10) {
        if (origin[axis] < box[axis] || origin[axis] > box[axis + 3]) { far = -1; break; }
      } else {
        const a = (box[axis] - origin[axis]) / direction[axis], b = (box[axis + 3] - origin[axis]) / direction[axis];
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (far < near) break;
      }
    }
    if (far >= near && near < nearest) nearest = near;
  }
  return Number.isFinite(nearest) ? nearest : null;
}

/**
 * 共享空间记忆的窄接收口：只接受宿主可信作用域的开始与真实合法观测。
 * 作用域必须来自 adapter.state()（不是观测载荷）；调用方在观测为空时不派发。
 */
export interface SpatialObservationSink {
  beginSession(scope: { worldId: string; dim: string; sessionId: string }): unknown;
  /** Trusted-ready admission; independent of paused/closing. */
  readonly observationAdmitted: boolean;
  /** Host shutdown boundary; a closing sink accepts no begin/interrupt/observe. */
  readonly closing: boolean;
  /** 整体标过期的次数；变化时已写过的格需要立即重写。 */
  readonly staleEpoch?: number;
  interrupt(): unknown;
  observe(observations: readonly BlockObservation[]): unknown;
}

export class Vision {
  frame: VisionFrame | null = null;
  seen: SeenEntity[] = [];
  heard: SeenEntity[] = [];
  /** 最近亲眼看见的非掉落物实体及其最后位置（3 分钟；不是当前存在的保证） */
  sightings = new Map<number, { id: number; name: string; kind: string; pos: Vec3Like; at: number }>();
  /** 亲眼看见过的掉落物最后在哪（转过头就不在视野里了，但人记得“床掉在东北三格”） */
  /** 亲眼见过的掉落物：first 是第一次看到的现实时间，出生时间未知 */
  private dropSightings = new Map<number, { id: number; name: string; pos: Vec3Like; at: number; first: number; count?: number }>();
  /** 本次扫描看到的值得注意的方块 */
  visibleNow = new Map<string, { name: string; pos: Vec3Like; dist: number }>();
  private visibleSurfaces = new Map<string, { name: string; pos: Vec3Like; at: number }>();
  composition: Record<string, number> = {};
  openness = { left: 0, center: 0, right: 0 };
  lastSweepAt = 0;
  private known = new Map<string, Known>();
  /**
   * 同名方块按最近看见排序（Map 插入序：再看见就挪到队尾），队首就是最久没看见的。
   * 名额满时淘汰队首、过期时从队首清，都不必扫一遍全部记忆（下界满眼 netherrack 时每个新格都要淘汰一次）。
   */
  private byName = new Map<string, Map<string, Known>>();
  private lastExpiryAt = 0;
  private lastScanAt = 0;
  private scope = '';
  private session = '';
  private scopes = new Map<string, { known: Map<string, Known>; byName: Map<string, Map<string, Known>> }>();

  /** 上一份已可信开始的作用域（world/dim/session）；未就绪时清空，避免用旧边界接纳新证据。 */
  private spatialScope: string | null = null;
  /** 已写进共享空间记忆的视线格：名字没变且未到刷新时间就不重写。 */
  private fed = new Map<string, { name: string; at: number }>();
  private lastSurround: { pos: Vec3Like; at: number; scope: string } | null = null;
  private fedEpoch: number | undefined;

  constructor(private adapter: GameAdapter, public cfg: VisionConfig = DEFAULT_VISION, private spatial?: SpatialObservationSink) {}

  private syncScope() {
    const state = this.adapter.state();
    const scope = `${state.worldId}\u0000${state.dim}`;
    if (scope !== this.scope || state.sessionId !== this.session || !state.observationReady) {
      this.frame = null;
      this.seen = [];
      this.heard = [];
      this.sightings.clear();
      this.dropSightings.clear();
      this.visibleNow.clear();
      this.visibleSurfaces.clear();
      this.composition = {};
      this.openness = { left: 0, center: 0, right: 0 };
      this.lastScanAt = 0;
      this.lastSweepAt = 0;
      this.fed.clear();
      if (scope !== this.scope) {
        this.scopes.set(this.scope, { known: this.known, byName: this.byName });
        const saved = this.scopes.get(scope);
        this.known = saved?.known ?? new Map();
        this.byName = saved?.byName ?? new Map();
        this.scope = scope;
      }
      this.session = state.sessionId;
    }
    // 过期清理每秒最多一次，且只从各名字队首清到第一条未过期的为止（队列按最近看见排序）。
    const now = Date.now();
    if (now - this.lastExpiryAt >= 1000) {
      this.lastExpiryAt = now;
      for (const lru of this.byName.values()) {
        for (const [key, block] of lru) {
          if (now - block.lastSeen <= RESOURCE_MEMORY_TTL_MS) break;
          this.forget(key);
        }
      }
    }
    return state;
  }

  /** 实际视距：配置值，或服务器下发的渲染距离（区块数 × 16），射线扫描上限 64 格 */
  effectiveRange(): number {
    const rd = this.adapter.renderDistance?.();
    return Math.min(MAX_RANGE, this.cfg.range > 0 ? this.cfg.range : FALLBACK_RANGE, rd && rd > 0 ? rd : FALLBACK_RANGE);
  }

  /**
   * 这一格实际有多少光（只用于视觉可见距离）：方块光、扣掉夜色后的天光、维度环境光取最大。
   * 下界没有天光（sky=0）但有维度环境光，不能把整片下界当成漆黑；末地同理。
   */
  private visionLight(state: ReturnType<GameAdapter['state']>, x: number, y: number, z: number): number {
    const r = this.adapter.lightAt(x, y, z);
    const t = state.timeOfDay;
    const darkness = t < 12000 ? 0 : t < 13800 || t >= 22200 ? 5 : 11;
    return Math.max(r?.block ?? 0, (r?.sky ?? 0) - darkness, DIM_AMBIENT_LIGHT[state.dim] ?? 0);
  }

  // ------------------------------------------------------------ 扫描
  scan(scanReason: VisionFrame['scanReason'] = 'direct'): void {
    const t0 = Date.now();
    const s = this.syncScope();
    this.recordFootprint(s);
    const eye = this.adapter.eye();
    if (!eye || !s.connected || !s.alive || !s.observationReady) {
      this.frame = null;
      this.seen = [];
      this.heard = [];
      this.sightings.clear();
      this.dropSightings.clear();
      this.visibleNow.clear();
      this.visibleSurfaces.clear();
      return;
    }
    const { cols, rows } = this.cfg;
    const range = this.effectiveRange();
    const hFov = (this.cfg.hFov * Math.PI) / 180;
    const vFov = (this.cfg.vFov * Math.PI) / 180;

    const optCache = new Map<number, Optics | null>();
    const lightCache = new Map<number, number>();
    const ex = Math.floor(eye.x), ey = Math.floor(eye.y), ez = Math.floor(eye.z);
    const lk = (x: number, y: number, z: number) => ((x - ex + 512) * 1025 + (y - ey + 512)) * 1025 + (z - ez + 512);
    const opt = (x: number, y: number, z: number): Optics | null => {
      const k = lk(x, y, z);
      let o = optCache.get(k);
      if (o === undefined) {
        o = y < -64 || y > 320 ? { name: 'air', kind: 'clear' } : this.adapter.blockOptics(x, y, z);
        optCache.set(k, o);
      }
      return o;
    };
    const light = (x: number, y: number, z: number): number => {
      const k = lk(x, y, z);
      let l = lightCache.get(k);
      if (l === undefined) {
        l = this.visionLight(s, x, y, z);
        lightCache.set(k, l);
      }
      return l;
    };
    const secCache = new Map<number, boolean>();
    const canSkip = typeof this.adapter.sectionEmpty === 'function';
    const sectionEmpty = (x: number, y: number, z: number): boolean => {
      if (!canSkip) return false;
      const k = (((x >> 4) - (ex >> 4) + 64) * 129 + ((y >> 4) - (ey >> 4) + 64)) * 129 + ((z >> 4) - (ez >> 4) + 64);
      let e = secCache.get(k);
      if (e === undefined) {
        e = this.adapter.sectionEmpty!(x, y, z);
        secCache.set(k, e);
      }
      return e;
    };
    const seeRange = (l: number) => seeRangeOf(l, range);

    const cats: number[] = new Array(cols * rows);
    const dists: number[] = new Array(cols * rows);
    const comp: Record<string, number> = {};
    this.visibleNow.clear();
    const now = Date.now();
    // A quick glance to one side must not erase the floor just seen on the
    // other side. Keep only a few seconds of local visual working memory.
    for (const [key, surface] of this.visibleSurfaces) if (now - surface.at > 3000) this.visibleSurfaces.delete(key);

    const noted = new Set<number>();
    const note = (name: string, x: number, y: number, z: number, dist: number) => {
      const cell = lk(x, y, z);
      if (noted.has(cell)) {
        // A large frame can evict an earlier hit from bounded block memory.
        if (NOTABLE.has(name) || GROUND.has(name)) {
          const k = keyOf(x, y, z);
          if (!this.known.has(k)) this.remember(k, name, { x, y, z }, now);
        }
        return;
      }
      noted.add(cell);
      const k = keyOf(x, y, z);
      const pos = { x, y, z };
      this.visibleSurfaces.set(k, { name, pos, at: now });
      if (!NOTABLE.has(name) && !GROUND.has(name)) return;
      this.visibleNow.set(k, { name, pos, dist });
      this.remember(k, name, pos, now);
    };

    // 本帧视线实际看到的格：第一处看清的命中面，以及命中前紧挨着的透明格。只写这些，不读视线外的方块。
    const feed = new Map<string, FeedCell>();
    const keep = (c: FeedCell) => {
      const k = keyOf(c.x, c.y, c.z), old = feed.get(k);
      if (!old || c.d < old.d) feed.set(k, c);
    };

    // 近处只整段记录行走需要的那一层透明格：正下方一两格内有非透明方块（脚部/头部净空）。
    // 半空中的空气不影响行走，全记会让每个区段的证据量暴涨、撑满常驻内存预算。
    const grounded = (x: number, y: number, z: number) => [1, 2].some((below) => {
      if (sectionEmpty(x, y - below, z)) return false;
      const o = opt(x, y - below, z);
      return o !== null && o.kind !== 'clear';
    });

    /** 一条视线：返回第一眼看到的表面类别与距离；沿途记录值得注意的方块 */
    const cast = (dx: number, dy: number, dz: number): { cat: Cat; dist: number } => {
      let hitCat: Cat | null = null;
      let hitDist = range;
      let water = 0, leaves = 0;
      let lx = ex, ly = ey, lz = ez;
      const trail: FeedCell[] = [];
      const pass = (x: number, y: number, z: number, name: string, d: number) => {
        if (hitCat) return;
        if (d <= VISION_NEAR_FEED_RADIUS && grounded(x, y, z) && d <= seeRange(light(x, y, z))) keep({ x, y, z, name, d });
        trail.push({ x, y, z, name, d });
        if (trail.length > FEED_TRAIL) trail.shift();
      };
      const surface = (x: number, y: number, z: number, name: string, d: number) => {
        if (hitCat) return;
        keep({ x, y, z, name, d });
        for (const c of trail) if (c.d <= seeRange(light(c.x, c.y, c.z))) keep(c);
      };
      raycast(eye.x, eye.y, eye.z, dx, dy, dz, range, (x, y, z, d) => {
        if (y > 320 || y < -64) return true; // 出了世界高度
        const empty = sectionEmpty(x, y, z);
        if (empty && d > VISION_NEAR_FEED_RADIUS) {
          // 整个 16³ 区段都是空气：直接跳到区段出口（远处天空方向的射线因此很便宜）
          const te = sectionExit(eye.x, eye.y, eye.z, dx, dy, dz, x, y, z);
          lx = Math.floor(eye.x + dx * (te - 0.01)); ly = Math.floor(eye.y + dy * (te - 0.01)); lz = Math.floor(eye.z + dz * (te - 0.01));
          return te;
        }
        // 近处的空区段逐格走完：地面恰在区段边界下方时，脚部与头部空气就在这个空区段里。
        const o = empty ? CLEAR_AIR : opt(x, y, z);
        if (!o) { if (!hitCat) { hitCat = 'unknown'; hitDist = d; } return true; }
        if (o.kind === 'clear') {
          if ((NOTABLE.has(o.name) || GROUND.has(o.name)) && d <= seeRange(light(x, y, z))) note(o.name, x, y, z, d); // 透明物体同样需要看清，之后仍可透过它看向别处
          lx = x; ly = y; lz = z;
          pass(x, y, z, o.name, d);
          return false;
        }
        if (o.kind === 'solid' && o.shapes) {
          const hit = shapeHitDistance(o.shapes, eye, dx, dy, dz, x, y, z, range);
          if (hit === null) { lx = x; ly = y; lz = z; pass(x, y, z, o.name, d); return false; }
          d = hit;
        }
        if (d > seeRange(light(lx, ly, lz))) { if (!hitCat) { hitCat = 'dark'; hitDist = d; } return true; }
        if (o.kind === 'water') {
          surface(x, y, z, o.name, d);
          if (!hitCat) { hitCat = 'water'; hitDist = d; if (o.name === 'water') note('water', x, y, z, d); }
          return ++water > 6;
        }
        if (o.kind === 'foliage') {
          note(o.name, x, y, z, d);
          surface(x, y, z, o.name, d);
          if (!hitCat) { hitCat = 'leaves'; hitDist = d; }
          return ++leaves >= 2;
        }
        note(o.name, x, y, z, d);
        surface(x, y, z, o.name, d);
        if (!hitCat) { hitCat = catOf(o.name); hitDist = d; }
        return true;
      });
      return { cat: hitCat ?? (dy > -0.05 ? 'sky' : 'unknown'), dist: hitDist };
    };

    for (let j = 0; j < rows; j++) {
      const pitch = eye.pitch + (rows > 1 ? (0.5 - j / (rows - 1)) : 0) * vFov;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let i = 0; i < cols; i++) {
        const yaw = eye.yaw + (cols > 1 ? (0.5 - i / (cols - 1)) : 0) * hFov;
        const { cat: c, dist } = cast(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);
        const idx = j * cols + i;
        cats[idx] = CAT_INDEX[c];
        dists[idx] = Math.round((Math.min(dist, range) / range) * 255);
        comp[c] = (comp[c] ?? 0) + 1;
      }
    }

    // 地平线高分辨率带：只在当前视野内、绝对俯仰角 -14°..+8° 的范围（远处地物都在这里）
    const bandLo = Math.max(eye.pitch - vFov / 2, -0.25);
    const bandHi = Math.min(eye.pitch + vFov / 2, 0.14);
    if (this.cfg.bandRows > 0 && this.cfg.bandCols > 0 && bandHi > bandLo) {
      for (let j = 0; j < this.cfg.bandRows; j++) {
        const pitch = bandHi - ((j + 0.5) / this.cfg.bandRows) * (bandHi - bandLo);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        for (let i = 0; i < this.cfg.bandCols; i++) {
          const yaw = eye.yaw + (0.5 - (i + 0.5) / this.cfg.bandCols) * hFov;
          cast(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);
        }
      }
    }
    this.composition = comp;
    this.feedSpatial(feed, s, eye, now, VISION_FEED_MAX_CELLS);
    // 视距：在眼睛高度水平看出去（与低头/抬头无关），左/中/右各 3 条射线取平均，衡量前方是否开阔
    const sector = (from: number, to: number) => {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const yaw = eye.yaw + (from + ((to - from) * (k + 0.5)) / 3) * hFov;
        let d = range;
        raycast(eye.x, eye.y, eye.z, -Math.sin(yaw), 0, -Math.cos(yaw), range, (x, y, z, dd) => {
          const o = opt(x, y, z);
          if (!o || o.kind === 'solid' || o.kind === 'foliage') { d = dd; return true; }
          return false;
        });
        sum += d;
      }
      return Math.round(sum / 3);
    };
    // 画面左侧对应 yaw 偏移为正
    this.openness = { left: sector(0.5, 1 / 6), center: sector(1 / 6, -1 / 6), right: sector(-1 / 6, -0.5) };

    // ---- 实体：视锥 + 视线 + 光照
    const seen: SeenEntity[] = [];
    const heard: SeenEntity[] = [];
    const ents: VisionFrame['entities'] = [];
    for (const e of this.adapter.nearbyEntities(range)) {
      const h = e.height ?? (e.kind === 'item' ? 0.25 : 1.6);
      const cx = e.pos.x, cz = e.pos.z;
      const targets = [e.pos.y + h * 0.5, e.pos.y + h * 0.9];
      const ddx = cx - eye.x, ddz = cz - eye.z;
      const ayaw = yawTo(ddx, ddz);
      const relYaw = norm(ayaw - eye.yaw);
      const base: SeenEntity = { id: e.id, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist, height: e.height, velocity: e.velocity, phase: e.phase, hp: e.hp, ...(e.fusing ? { fusing: true } : {}), ...(e.count ? { count: e.count } : {}), ...(e.traits ? { traits: e.traits } : {}), dir: dirOfYaw(ayaw), rel: relOf(relYaw), how: 'seen' };
      let visible = false;
      let relPitch = 0;
      for (const ty of targets) {
        const ddy = ty - eye.y;
        const dist = Math.hypot(ddx, ddy, ddz);
        relPitch = Math.atan2(ddy, Math.hypot(ddx, ddz)) - eye.pitch;
        if (Math.abs(relYaw) > hFov / 2 + 0.05 || Math.abs(relPitch) > vFov / 2 + 0.05) continue;
        const maxSee = Math.max(seeRange(light(Math.floor(cx), Math.floor(e.pos.y), Math.floor(cz))), dist < 4 ? 4 : 0);
        if (dist > maxSee) continue;
        if (this.clearLine(eye, ddx / dist, ddy / dist, ddz / dist, dist - 0.4, opt)) {
          visible = true;
          break;
        }
      }
      if (visible) {
        const u = 0.5 - relYaw / hFov;
        const v = 0.5 - relPitch / vFov;
        seen.push({ ...base, u, v });
        if (e.kind !== 'item') ents.push({ name: e.name, kind: e.kind, u, v, dist: Math.round(e.dist) });
      } else if (e.kind !== 'item' && e.kind !== 'other' && e.dist <= (e.kind === 'hostile' ? this.cfg.hearRadius : this.cfg.hearRadius * 0.6)) {
        heard.push({ ...base, how: 'heard', phase: undefined, hp: undefined, velocity: undefined });
      }
    }
    this.seen = seen.sort((a, b) => a.dist - b.dist);
    this.heard = heard.sort((a, b) => a.dist - b.dist);
    // 记住亲眼看见过的实体在哪；只记看见的，不记听见/墙后的，也不跟踪视野外的移动
    for (const e of seen) if (e.kind !== 'item') this.sightings.set(e.id, { id: e.id, name: e.name, kind: e.kind, pos: { ...e.pos }, at: now });
    for (const [id, x] of this.sightings) if (now - x.at > 180_000) this.sightings.delete(id);
    for (const e of seen) if (e.kind === 'item') this.dropSightings.set(e.id, { id: e.id, name: e.name.replace(/^item:/, ''), pos: { ...e.pos }, at: now, first: this.dropSightings.get(e.id)?.first ?? now, ...((e as any).count ? { count: (e as any).count } : {}) });
    for (const [id, x] of this.dropSightings) if (now - x.at > 300_000) this.dropSightings.delete(id);
    // 正看着记得放掉落物的那块地方，东西却不在了（被捡走、烧掉、消失）：亲眼看到没了，就忘掉
    const seenIds = new Set(seen.map((e) => e.id));
    for (const [id, x] of this.dropSightings) {
      if (seenIds.has(id)) continue;
      const ddx = x.pos.x - eye.x, ddy = x.pos.y + 0.12 - eye.y, ddz = x.pos.z - eye.z, dist = Math.hypot(ddx, ddy, ddz);
      if (dist < 0.5 || dist > 12) continue;
      if (Math.abs(norm(yawTo(ddx, ddz) - eye.yaw)) > hFov / 2 - 0.1 || Math.abs(Math.atan2(ddy, Math.hypot(ddx, ddz)) - eye.pitch) > vFov / 2 - 0.1) continue;
      if (dist > Math.max(seeRange(light(Math.floor(x.pos.x), Math.floor(x.pos.y), Math.floor(x.pos.z))), 4)) continue;
      if (this.clearLine(eye, ddx / dist, ddy / dist, ddz / dist, dist - 0.4, opt)) this.dropSightings.delete(id);
    }
    this.lastScanAt = now;
    this.frame = { cols, rows, cats, dists, facing: dirOfYaw(eye.yaw), range, entities: ents, ts: now, scanReason, scanMs: Date.now() - t0 };
  }

  private clearLine(eye: Eye, dx: number, dy: number, dz: number, max: number, opt: (x: number, y: number, z: number) => Optics | null): boolean {
    let ok = true, leaves = 0, water = 0;
    raycast(eye.x, eye.y, eye.z, dx, dy, dz, Math.max(0, max), (x, y, z) => {
      const o = opt(x, y, z);
      if (!o || o.kind === 'solid' && (!o.shapes || shapeHitDistance(o.shapes, eye, dx, dy, dz, x, y, z, max) !== null)) { ok = false; return true; }
      if (o.kind === 'foliage' && ++leaves >= 2) { ok = false; return true; }
      if (o.kind === 'water' && ++water > 6) { ok = false; return true; }
      return false;
    });
    return ok;
  }

  private remember(k: string, name: string, pos: Vec3Like, now: number) {
    let lru = this.byName.get(name);
    if (lru === undefined) { lru = new Map(); this.byName.set(name, lru); }
    const old = this.known.get(k);
    if (old) {
      // 再看见：挪到这个名字队尾（名字变了就换一条队列）
      this.byName.get(old.name)?.delete(k);
      old.name = name;
      old.lastSeen = now;
      lru.set(k, old);
      return;
    }
    const cap = GROUND.has(name) ? 300 : 600;
    if (lru.size >= cap) {
      // 淘汰同名里最久没看到的：队首
      const oldest = lru.keys().next().value!;
      lru.delete(oldest);
      this.known.delete(oldest);
    }
    const entry = { name, pos, lastSeen: now };
    this.known.set(k, entry);
    lru.set(k, entry);
  }

  private forget(k: string) {
    const v = this.known.get(k);
    if (!v) return;
    this.known.delete(k);
    this.byName.get(v.name)?.delete(k);
  }

  // ------------------------------------------------------------ 查询（给技能、反射层、感知摘要用）
  /** 看见的 + 听见的实体（反射层/战斗只能对这些做出反应） */
  perceivedEntities(radius = 16): EntityInfo[] {
    if (!this.syncScope().observationReady) return [];
    return [...this.seen, ...this.heard]
      .filter((e) => e.dist <= radius)
      .map((e) => ({ id: e.id, perception: e.how, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist, height: e.height, velocity: e.velocity, phase: e.phase, hp: e.hp, ...(e.fusing ? { fusing: true } : {}) }))
      .sort((a, b) => a.dist - b.dist);
  }

  /**
   * 共享空间记忆的写入准入（scan 与 observeBlocks 共用）：可信 ready 时，作用域变化或此前被中断就
   * beginSession 一次；不 ready 时把已准入的旧证据中断一次并置 stale。没有共享记忆或正在关停时返回 false。
   */
  private admitSpatial(state: ReturnType<GameAdapter['state']>, eye: Eye | null): boolean {
    if (this.spatial === undefined || this.spatial.closing) return false;
    if (!(state.connected && state.alive && state.observationReady && state.dim !== 'unknown' && eye !== null)) {
      // 实际可信状态已不 ready（例如同一 sessionId 下区块丢失）：已准入的旧证据
      // 必须此刻中断一次并置 stale，不能等下一帧或下一次作用域变化。中断后准入为
      // false，重复的未就绪读取不会再次 interrupt。
      this.spatialScope = null;
      if (this.spatial.observationAdmitted) this.spatial.interrupt();
      return false;
    }
    const scopeKey = `${state.worldId}|${state.dim}|${state.sessionId}`;
    // 真实 ready 的作用域变化，或此前已被中断（walk 生命周期可能先看到未就绪），
    // 都需要 beginSession 重新准入。首次作用域变化即使本批最终没有合法观测也应
    // 开始会话；但同一作用域/同一批之后绝不只为每批重复 begin。
    if (scopeKey !== this.spatialScope || !this.spatial.observationAdmitted) {
      this.spatial.beginSession({ worldId: state.worldId, dim: state.dim, sessionId: state.sessionId });
      this.spatialScope = scopeKey;
    }
    return true;
  }

  /** Inspect a bounded set of actual sight lines, never cached memory behind a wall. */
  observeBlocks(positions: Vec3Like[]): BlockObservation[] {
    const state = this.syncScope(), eye = this.adapter.eye();
    // A closing shared service must not be re-admitted, interrupted, or written by
    // late reads; stop this shared writer without scanning further.
    if (this.spatial?.closing === true) return [];
    const trustedReady = state.connected && state.alive && state.observationReady && state.dim !== 'unknown' && eye !== null;
    if (this.spatial !== undefined && !this.admitSpatial(state, eye)) return [];
    if (!trustedReady) return [];
    const now = Date.now(), seen = new Set<string>(), out: BlockObservation[] = [];
    const hFov = this.cfg.hFov * Math.PI / 180, vFov = this.cfg.vFov * Math.PI / 180;
    for (const pos of positions.slice(0, 32)) {
      if (![pos.x, pos.y, pos.z].every((n) => Number.isFinite(n) && Number.isInteger(n))) continue;
      const key = keyOf(pos.x, pos.y, pos.z);
      if (seen.has(key)) continue;
      seen.add(key);
      if (Math.hypot(pos.x + .5 - eye.x, pos.y + .5 - eye.y, pos.z + .5 - eye.z) > this.effectiveRange() + 1) continue;
      const optics = this.adapter.blockOptics(pos.x, pos.y, pos.z);
      if (!optics) continue;
      const boxes = optics.kind === 'solid' || optics.kind === 'foliage' ? optics.shapes ?? [[0, 0, 0, 1, 1, 1] as const] : undefined;
      // A block's center may be hidden behind the edge of the block underfoot
      // even though part of its top face is visible. Sample inside each actual
      // collision box, and require a clear, in-view ray for every candidate.
      const points = boxes
        ? boxes.slice(0, 16).flatMap(([x0, y0, z0, x1, y1, z1]) =>
          [[pos.x + (x0 + x1) / 2, pos.y + (y0 + y1) / 2, pos.z + (z0 + z1) / 2],
            ...[0.1, 0.9].flatMap((fx) => [0.1, 0.9].flatMap((fy) => [0.1, 0.9].map((fz) =>
              [pos.x + x0 + (x1 - x0) * fx, pos.y + y0 + (y1 - y0) * fy, pos.z + z0 + (z1 - z0) * fz])))])
        : [[pos.x + .5, pos.y + .5, pos.z + .5]];
      const visible = points.some(([x, y, z]) => {
        const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z, distance = Math.hypot(dx, dy, dz);
        if (distance < .01 || distance > this.effectiveRange()) return false;
        // Every exact vision result must sit inside the configured view cone;
        // underfoot/overhead cells get no contact exemption from turning to look.
        if (Math.abs(norm(yawTo(dx, dz) - eye.yaw)) > hFov / 2 || Math.abs(Math.atan2(dy, Math.hypot(dx, dz)) - eye.pitch) > vFov / 2) return false;
        // Thin doors/fences must expose an actual shape, not merely an empty
        // part of their grid cell. Other blocks still occlude the entire ray.
        const hit = boxes ? shapeHitDistance(boxes, eye, dx / distance, dy / distance, dz / distance, pos.x, pos.y, pos.z, distance) : distance;
        if (hit === null || !this.clearLine(eye, dx / distance, dy / distance, dz / distance, hit,
          (bx, by, bz) => bx === pos.x && by === pos.y && bz === pos.z ? { name: 'air', kind: 'clear' } : this.adapter.blockOptics(bx, by, bz))) return false;
        const near = Math.max(0, hit - .1);
        const light = this.visionLight(state, Math.floor(eye.x + dx / distance * near), Math.floor(eye.y + dy / distance * near), Math.floor(eye.z + dz / distance * near));
        return hit <= seeRangeOf(light, this.effectiveRange());
      });
      if (!visible) continue;
      const block = this.adapter.blockStateAt?.(pos);
      // A fallback optics name is still useful, but empty properties from that
      // fallback are not evidence of complete state.
      const name = block?.name ?? optics.name;
      if (!name) continue;
      out.push({ name, properties: { ...block?.properties }, stateComplete: block != null, pos: { ...pos }, worldId: state.worldId, sessionId: state.sessionId,
        dimension: state.dim, observationId: state.observationId, observedAt: now, source: 'vision' });
    }
    // 合法视锥结果是共享地图的唯一写入源；空批次不产生任何写入/生命周期报告。
    // 同步调用：eager 直接写入；manual 对 resident/首观测同步写入，未驻留的已保存
    // 证据只进入服务的有限后台队列。这里不做磁盘 I/O、不等待加载、不改变作用域
    // 或中断规则；变更报告仍在返回前同步派发。
    if (out.length > 0 && !this.spatial?.closing) this.spatial?.observe(out);
    return out;
  }

  /**
   * 已知的方块位置：当前看得见或曾经看见过（15 分钟内）。
   * 只有重新亲眼看见该格已改变才遗忘；视野外或遮挡后的变化不能更新记忆。
   */
  knownBlocks(names: string[], maxDist: number): BlockHit[] {
    const s = this.syncScope();
    if (!s.observationReady) return [];
    const set = new Set(names);
    const candidates = [...this.known.entries()].filter(([, value]) => set.has(value.name))
      .map(([key, value]) => ({ key, value, dist: Math.hypot(value.pos.x - s.pos.x, value.pos.y - s.pos.y, value.pos.z - s.pos.z) }))
      .filter((candidate) => candidate.dist <= maxDist);
    const observed = new Map(Array.from({ length: Math.ceil(candidates.length / 32) }, (_, index) =>
      this.observeBlocks(candidates.slice(index * 32, (index + 1) * 32).map((candidate) => candidate.value.pos)))
      .flat().map((block) => [keyOf(block.pos.x, block.pos.y, block.pos.z), block.name]));
    return candidates.filter(({ key, value }) => {
      const current = observed.get(key);
      if (current && current !== value.name) { this.forget(key); return false; }
      return true;
    }).map(({ value, dist }) => ({ name: value.name, pos: value.pos, dist })).sort((a, b) => a.dist - b.dist);
  }

  /** 记忆整体标过期（死亡、中断、暂停恢复、换会话）后，“已写过”的记录失效：身边的格下一帧立即重写。 */
  private syncFedEpoch() {
    const epoch = this.spatial?.staleEpoch;
    if (epoch === this.fedEpoch) return;
    this.fedEpoch = epoch;
    this.fed.clear();
    this.lastSurround = null;
  }

  /** 写进共享空间记忆：只写变化或到刷新时间的格，近的先写，每次有上限。 */
  private feedSpatial(feed: Map<string, FeedCell>, s: ReturnType<GameAdapter['state']>, eye: Eye, now: number, cap: number) {
    this.syncFedEpoch();
    for (const [key, f] of this.fed) if (now - f.at > VISION_FEED_REFRESH_MS * 4) this.fed.delete(key);
    const fresh = [...feed.entries()]
      .filter(([key, c]) => { const old = this.fed.get(key); return !old || old.name !== c.name || now - old.at >= VISION_FEED_REFRESH_MS; })
      .sort((a, b) => a[1].d - b[1].d).slice(0, cap);
    if (fresh.length === 0 || !this.admitSpatial(s, eye)) return;
    this.spatial!.observe(fresh.map(([key, c]) => {
      this.fed.set(key, { name: c.name, at: now });
      const pos = { x: c.x, y: c.y, z: c.z }, block = this.adapter.blockStateAt?.(pos);
      return { name: block?.name ?? c.name, properties: { ...block?.properties }, stateComplete: block != null, pos, worldId: s.worldId, sessionId: s.sessionId,
        dimension: s.dim, observationId: s.observationId, observedAt: now, source: 'vision' as const };
    }));
  }

  /**
   * 周边地形感知（见 SURROUND_RADIUS）：身体移动或间隔到期时，从身体所在格沿空气/水连通扩展，
   * 写入贴地透明格与包围开放空间的表面方块。导航因此在身边始终有完整、新鲜的地形。
   */
  scanSurroundings(): void {
    const s = this.syncScope();
    const eye = this.adapter.eye();
    if (!eye || !s.connected || !s.alive || !s.observationReady) return;
    const now = Date.now();
    const scope = `${s.worldId}|${s.dim}|${s.sessionId}`;
    this.syncFedEpoch();
    const last = this.lastSurround;
    if (last && last.scope === scope && now - last.at < SURROUND_INTERVAL_MS
      && Math.hypot(s.pos.x - last.pos.x, s.pos.y - last.pos.y, s.pos.z - last.pos.z) < SURROUND_MOVE) return;
    this.lastSurround = { pos: { ...s.pos }, at: now, scope };
    const fx = Math.floor(s.pos.x), fy = Math.floor(s.pos.y), fz = Math.floor(s.pos.z);
    const optics = new Map<string, Optics | null>();
    const opt = (x: number, y: number, z: number) => {
      const key = keyOf(x, y, z);
      let o = optics.get(key);
      if (o === undefined) { o = this.adapter.blockOptics(x, y, z); optics.set(key, o); }
      return o;
    };
    const open = (o: Optics | null) => o !== null && (o.kind === 'clear' || o.kind === 'water');
    const inside = (x: number, y: number, z: number) => y >= fy - SURROUND_DOWN && y <= fy + SURROUND_UP
      && (x - fx) ** 2 + (z - fz) ** 2 <= SURROUND_RADIUS ** 2;
    const feed = new Map<string, FeedCell>();
    const record = (x: number, y: number, z: number, name: string) => {
      feed.set(keyOf(x, y, z), { x, y, z, name, d: Math.hypot(x + 0.5 - s.pos.x, y - s.pos.y, z + 0.5 - s.pos.z) });
    };
    const seen = new Set<string>();
    const queue: [number, number, number][] = [];
    for (const y of [fy, fy + 1]) if (open(opt(fx, y, fz))) { seen.add(keyOf(fx, y, fz)); queue.push([fx, y, fz]); }
    const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
    for (let head = 0; head < queue.length; head++) {
      const [x, y, z] = queue[head]!;
      const here = opt(x, y, z)!;
      // 行走判定层内的透明格全记；更高处只记贴地那层（脚部/头部净空）与水，半空空气全记会撑满常驻内存。
      if (here.kind === 'water' || y <= fy + SURROUND_WALK_BAND_UP
        || [1, 2].some((below) => { const o = opt(x, y - below, z); return o !== null && !open(o); })) record(x, y, z, here.name);
      for (const [dx, dy, dz] of steps) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!inside(nx, ny, nz)) continue;
        const key = keyOf(nx, ny, nz);
        if (seen.has(key)) continue;
        seen.add(key);
        const o = opt(nx, ny, nz);
        if (o === null) continue;
        if (open(o)) queue.push([nx, ny, nz]);
        else record(nx, ny, nz, o.name);
      }
    }
    this.feedSpatial(feed, s, eye, now, SURROUND_MAX_CELLS);
  }

  /** 这一格这几秒内亲眼看见是什么（看不见返回 null，不透视） */
  seenAt(pos: Vec3Like): string | null { return this.visibleSurfaces.get(keyOf(pos.x, pos.y, pos.z))?.name ?? null; }

  /** 本帧射线命中的候选表面，包括不记入资源记忆的普通方块。移动后仍需复核视线。 */
  currentBlockCandidates(names: string[]): Pick<BlockHit, 'name' | 'pos'>[] {
    const state = this.adapter.state();
    if (!this.frame || !state.observationReady || this.scope !== `${state.worldId}\u0000${state.dim}` || this.session !== state.sessionId) return [];
    return [...this.visibleSurfaces.values()].filter(hit => hit.at === this.lastScanAt && names.includes(hit.name))
      .map(hit => ({ name: hit.name, pos: { ...hit.pos } }));
  }

  /** 只读最近所见的原时间与作用域；不扫描，也不把旧会话的表面当成新观察。 */
  seenEvidence(pos: Vec3Like) {
    const state = this.adapter.state();
    if (!state.observationReady || this.scope !== `${state.worldId}\u0000${state.dim}` || this.session !== state.sessionId) return null;
    const surface = this.visibleSurfaces.get(keyOf(pos.x, pos.y, pos.z));
    if (surface === undefined || Date.now() - surface.at > 3000) return null;
    return {
      name: surface.name, pos: { ...surface.pos }, observedAt: surface.at,
      worldId: state.worldId, dimension: state.dim, sessionId: state.sessionId,
    };
  }

  /** 这一格认得出是什么吗：刚看见的，或者之前亲眼见过、记着的（矿、功能方块……）；都没有就 null */
  recognizedAt(pos: Vec3Like): string | null {
    const seen = this.seenAt(pos);
    if (seen) return seen;
    const k = this.known.get(keyOf(pos.x, pos.y, pos.z));
    return k && Date.now() - k.lastSeen <= RESOURCE_MEMORY_TTL_MS ? k.name : null;
  }

  /** 刚挖开一格后，这一格暴露出的邻面是贴脸可见的（不用转头、不用视线确认）：把值得注意的方块直接记进视野记忆。返回记下的方块名。 */
  expose(pos: Vec3Like): string | null {
    const state = this.syncScope();
    if (!state.observationReady) return null;
    const name = this.adapter.blockStateAt?.(pos)?.name ?? this.adapter.blockOptics(pos.x, pos.y, pos.z)?.name;
    if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return null;
    if (!NOTABLE.has(name) && !GROUND.has(name)) return null;
    const now = Date.now();
    const k = keyOf(pos.x, pos.y, pos.z);
    this.visibleSurfaces.set(k, { name, pos: { ...pos }, at: now });
    const dist = Math.round(Math.hypot(pos.x + 0.5 - state.pos.x, pos.y + 0.5 - state.pos.y, pos.z + 0.5 - state.pos.z));
    if (!this.visibleNow.has(k)) this.visibleNow.set(k, { name, pos: { ...pos }, dist });
    this.remember(k, name, { ...pos }, now);
    return name;
  }

  /** 让最近扫描一次（例如转头之后）。距离上次不足 150ms 则跳过。 */
  refresh() {
    this.syncScope();
    if (Date.now() - this.lastScanAt >= 150) this.scan('refresh');
  }

  /** 最近一次亲眼看见符合条件的实体在哪里（历史视觉；需要重新看见才能交互） */
  lastSighting(match: (name: string) => boolean, maxAgeMs = 120_000): { id: number; name: string; pos: Vec3Like; ageMs: number } | null {
    const now = Date.now();
    let best: { id: number; name: string; pos: Vec3Like; at: number } | null = null;
    for (const x of this.sightings.values()) if (match(x.name) && now - x.at <= maxAgeMs && (!best || x.at > best.at)) best = x;
    return best ? { id: best.id, name: best.name, pos: best.pos, ageMs: now - best.at } : null;
  }

  /** 最近亲眼看见过、现在不在视野里的掉落物（只来自以往的视觉扫描，不透视） */
  recentDrops(maxAgeMs = 120_000): { id: number; name: string; pos: Vec3Like; ageMs: number }[] {
    const now = Date.now(), visible = new Set(this.seen.map((e) => e.id));
    return [...this.dropSightings.values()].filter((d) => !visible.has(d.id) && now - d.at <= maxAgeMs).map((d) => ({ id: d.id, name: d.name, pos: d.pos, ageMs: now - d.at }));
  }

  /**
   * 见过的掉落物（看得见的和刚看不见的），带第一次看到的现实时间。
   * 出生时间、区块加载及实际消失时间未知；确认原位置已空时忘掉。
   */
  dropsSeen(): { id: number; name: string; pos: Vec3Like; firstMs: number; lastMs: number; visible: boolean; count?: number }[] {
    const now = Date.now(), visible = new Set(this.seen.map((e) => e.id));
    return [...this.dropSightings.values()].map((d) => ({ id: d.id, name: d.name, pos: d.pos, firstMs: now - d.first, lastMs: now - d.at, visible: visible.has(d.id), ...(d.count ? { count: d.count } : {}) }));
  }

  /** 走到记得的地方一看没有了（被捡走、消失、漂走）：忘掉它 */
  forgetDrop(id: number) {
    this.dropSightings.delete(id);
  }

  markSweep() {
    this.lastSweepAt = Date.now();
  }

  /**
   * 最近的“可站立的陆地”（见过的地表方块，且上方是空气，不是海底）。
   * 岸附近看到过露出空气的水面时，附带岸脚到水面的高度；只报高度和可见性，
   * 路径是否被挡仍未确认。未加载的方块不参与判断。
   */
  nearestLand(here: Vec3Like, excluded: Vec3Like[] = []): { dir: string; dist: number; pos: Vec3Like; climbableFromWater?: boolean; waterTop?: number; heightAboveWater?: number } | null {
    if (!this.syncScope().observationReady) return null;
    let best: { d: number; score: number; pos: Vec3Like } | null = null;
    for (const v of this.known.values()) {
      if (Date.now() - v.lastSeen > RESOURCE_MEMORY_TTL_MS) continue;
      if (!GROUND.has(v.name) && !v.name.endsWith('_log')) continue;
      if (['water', 'short_grass', 'tall_grass', 'grass', 'fern'].includes(v.name)) continue;
      if (excluded.some((p) => Math.hypot(p.x - v.pos.x, p.z - v.pos.z) <= 2 && Math.abs(p.y - v.pos.y) <= 2)) continue;
      if (v.pos.y < here.y - 4) continue;
      const ground = this.adapter.blockOptics(v.pos.x, v.pos.y, v.pos.z);
      const above = this.adapter.blockOptics(v.pos.x, v.pos.y + 1, v.pos.z);
      const head = this.adapter.blockOptics(v.pos.x, v.pos.y + 2, v.pos.z);
      if (ground?.kind !== 'solid' || !above || !head || !['air', 'cave_air', 'void_air'].includes(above.name) || !['air', 'cave_air', 'void_air'].includes(head.name)) continue;
      const d = Math.hypot(v.pos.x + 0.5 - here.x, v.pos.z + 0.5 - here.z);
      const score = d + Math.max(0, v.pos.y - here.y) * 2;
      if (!best || score < best.score) best = { d, score, pos: v.pos };
    }
    if (!best) return null;
    // 找岸格附近（水平 2 格内）观察到的最高的开阔水面顶。上方是水说明还没到水面，
    // 未加载（null）或实心遮挡不当作可见水面；都不猜。
    let waterTop: number | undefined;
    const now = Date.now();
    for (const v of this.known.values()) {
      if (now - v.lastSeen > RESOURCE_MEMORY_TTL_MS || catOf(v.name) !== 'water') continue;
      if (Math.abs(v.pos.x - best.pos.x) > 2 || Math.abs(v.pos.z - best.pos.z) > 2 || Math.abs(v.pos.y - best.pos.y) > 8) continue;
      const above = this.adapter.blockOptics(v.pos.x, v.pos.y + 1, v.pos.z);
      if (!above || above.kind === 'water' || above.kind === 'solid') continue;
      const top = v.pos.y + 1;
      waterTop = waterTop === undefined ? top : Math.max(waterTop, top);
    }
    return {
      dir: dirOfYaw(yawTo(best.pos.x - here.x, best.pos.z - here.z)), dist: Math.round(best.d), pos: best.pos,
      ...(waterTop !== undefined
        ? { waterTop, heightAboveWater: best.pos.y + 1 - waterTop, climbableFromWater: best.pos.y + 1 - waterTop <= 1 }
        : {}),
    };
  }

  knownCount() {
    this.syncScope();
    return this.known.size;
  }

  /** Actual visible surfaces, not the remembered terrain behind the camera or a wall. */
  landingOptions(maxHorizontal = 6): LandingOption[] {
    const state = this.syncScope(), now = Date.now();
    if (!state.observationReady || !state.connected || !state.alive || !this.adapter.eye()) return [];
    const here = state.pos, radius = Number.isFinite(maxHorizontal) ? Math.max(1, Math.min(12, maxHorizontal)) : 6;
    const water = (name: string) => name === 'water' || name === 'bubble_column';
    const hazardous = (name: string) => /lava|magma|campfire|cactus|powder_snow|berry_bush|pointed_dripstone/.test(name);
    const candidates = [...this.visibleSurfaces.values()].filter((v) => now - v.at <= 1000 && v.pos.y < here.y
      && Math.hypot(v.pos.x + .5 - here.x, v.pos.z + .5 - here.z) <= radius && !hazardous(v.name))
      .sort((a, b) => Math.hypot(a.pos.x + .5 - here.x, a.pos.z + .5 - here.z) - Math.hypot(b.pos.x + .5 - here.x, b.pos.z + .5 - here.z))
      .slice(0, 16);
    const current = new Map(this.observeBlocks(candidates.map((v) => v.pos)).map((v) => [keyOf(v.pos.x, v.pos.y, v.pos.z), v]));
    const clearNames = /^(air|cave_air|void_air|light|short_grass|grass|tall_grass|fern|large_fern|torch|wall_torch|.*_flower|dandelion|poppy)$/;
    const inspectSpace = (positions: Vec3Like[], entryWater?: Vec3Like): LandingOption['clearance'] => {
      const unique = [...new Map(positions.map((p) => { const q = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; return [keyOf(q.x, q.y, q.z), q]; })).values()];
      if (unique.length > 128) return 'unknown';
      const seen = new Map<string, BlockObservation>();
      for (let i = 0; i < unique.length; i += 32) for (const b of this.observeBlocks(unique.slice(i, i + 32))) seen.set(keyOf(b.pos.x, b.pos.y, b.pos.z), b);
      let missing = false;
      for (const p of unique) {
        const b = seen.get(keyOf(p.x, p.y, p.z));
        if (!b) {
          // The space occupied by our own body is also directly knowable;
          // looking down cannot put our current head/feet cell into the FOV.
          const ownBody = state.onGround === true && p.x === Math.floor(here.x) && p.z === Math.floor(here.z)
            && p.y >= Math.floor(here.y) && p.y <= Math.floor(here.y + 1.79);
          if (ownBody && clearNames.test(this.adapter.blockOptics(p.x, p.y, p.z)?.name ?? '')) continue;
          missing = true; continue;
        }
        if (entryWater && p.x === entryWater.x && p.z === entryWater.z && p.y === entryWater.y && water(b.name)) continue;
        if (!clearNames.test(b.name)) return 'blocked';
      }
      return missing ? 'unknown' : 'clear';
    };
    const out: LandingOption[] = [];
    for (const v of candidates) {
      if (out.length >= 8) break;
      const support = current.get(keyOf(v.pos.x, v.pos.y, v.pos.z));
      if (!support || support.name !== v.name || hazardous(support.name)) continue;
      const optics = this.adapter.blockOptics(v.pos.x, v.pos.y, v.pos.z), wet = water(support.name);
      if (!optics || !wet && optics.kind !== 'solid' && optics.kind !== 'foliage') continue;
      if (String(support.properties.waterlogged) === 'true') continue;
      if (!wet && !optics.shapes && /_slab$|_stairs$|_fence$|_wall$|_pane$|_door$|trapdoor|_bed$|carpet$|^snow$|chest|farmland|dirt_path/.test(support.name)) continue;
      // A center landing needs a full player-width supporting top, not a fence/pane sliver.
      const tops = optics.shapes?.filter(([x0, , z0, x1, , z1]) => x0 <= .2 && x1 >= .8 && z0 <= .2 && z1 >= .8).map((box) => box[4]);
      if (!wet && tops && !tops.length) continue;
      const surfaceY = v.pos.y + (wet ? 1 : tops ? Math.max(...tops) : 1);
      const target = { x: v.pos.x + .5, y: wet ? v.pos.y : surfaceY, z: v.pos.z + .5 };
      const horizontalDistance = Math.hypot(target.x - here.x, target.z - here.z), drop = here.y - surfaceY;
      if (drop < -.05 || drop > 64 || horizontalDistance < .35) continue;
      const body: Vec3Like[] = [];
      for (const dx of [-.29, .29]) for (const dz of [-.29, .29]) for (const dy of [.01, 1, 1.79]) body.push({ x: target.x + dx, y: target.y + dy, z: target.z + dz });
      const clearance = inspectSpace(body, wet ? v.pos : undefined), approach = horizontalDistance <= 1.8 ? 'adjacent' : 'distant';
      const passage: Vec3Like[] = [];
      // This only checks a local entry and fall column; it never invents a route to a distant edge.
      if (approach === 'adjacent') {
        for (let t = 0; t <= 1.01; t += .25) for (const dx of [-.29, .29]) for (const dz of [-.29, .29]) for (const dy of [.01, 1, 1.79]) {
          passage.push({ x: here.x + (target.x - here.x) * t + dx, y: here.y + dy, z: here.z + (target.z - here.z) * t + dz });
        }
        for (let y = target.y + .01; y <= here.y + 1.8; y += .5) for (const dx of [-.29, .29]) for (const dz of [-.29, .29]) passage.push({ x: target.x + dx, y, z: target.z + dz });
      }
      const corridor = approach === 'adjacent' ? inspectSpace(passage, wet ? v.pos : undefined) : 'unknown';
      let waterDepth: LandingOption['waterDepth'] = 'unknown';
      if (wet) {
        const below = this.observeBlocks([{ x: v.pos.x, y: v.pos.y - 1, z: v.pos.z }])[0];
        if (below && water(below.name)) waterDepth = 2;
      }
      const unknowns = [
        ...(clearance === 'unknown' ? ['落点身体净空没有全部看清'] : []),
        ...(corridor === 'unknown' ? ['接近入口或下落通道没有全部看清'] : []),
        ...(approach === 'distant' ? ['尚未观察到前往该落点边缘的完整路线'] : []),
        ...(wet && waterDepth === 'unknown' ? ['水深尚未看清'] : []),
        ...(state.onGround !== true ? ['当前未确认站稳，已有下落距离或速度未知'] : []),
      ];
      out.push({ target, support: { pos: { ...v.pos }, name: support.name }, surface: wet ? 'water' : 'ground', surfaceY,
        horizontalDistance, drop, clearance, corridor, approach, waterDepth, unknowns,
        receipt: { worldId: state.worldId, sessionId: state.sessionId, dimension: state.dim, observationId: state.observationId, at: now, from: { ...here }, onGround: state.onGround === true } });
    }
    return out;
  }

  // ------------------------------------------------------------ 足迹（来时的路）
  /** 自己真正站过的地方：像人记得来时的路，只记脚踏实地、不在水里的位置（是记忆，不是透视） */
  private footprints = new Map<string, { pos: Vec3Like; at: number }>();
  private lastFootprint: { scope: string; pos: Vec3Like } | null = null;

  private recordFootprint(s: ReturnType<GameAdapter['state']>) {
    if (!s.connected || !s.alive || !s.observationReady || s.onGround !== true || s.inWater || s.inLava || s.riding) return;
    const scope = `${s.worldId}:${s.dim}`;
    const last = this.lastFootprint;
    if (last && last.scope === scope && Math.hypot(last.pos.x - s.pos.x, last.pos.y - s.pos.y, last.pos.z - s.pos.z) < 4) return;
    const pos = { x: Math.floor(s.pos.x) + 0.5, y: Math.floor(s.pos.y + 0.05), z: Math.floor(s.pos.z) + 0.5 };
    const key = `${scope}:${pos.x},${pos.y},${pos.z}`;
    this.footprints.delete(key);
    this.footprints.set(key, { pos, at: Date.now() });
    this.lastFootprint = { scope, pos: { ...s.pos } };
    while (this.footprints.size > 4000) this.footprints.delete(this.footprints.keys().next().value!);
  }

  /**
   * 眼前看不到通路时，沿着自己走过的地方往目标挪：选一个站过的、更靠近目标的落脚点。
   * 只用亲身到过的位置，不推测没见过的地形；走不通由调用方换下一个。
   */
  rememberedWaypoint(target: Vec3Like, maxDistance: number, excluded: Vec3Like[]): Vec3Like | null {
    const state = this.syncScope();
    if (!state.observationReady) return null;
    const scope = `${state.worldId}:${state.dim}:`, here = state.pos;
    const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const left = d3(here, target);
    let best: { pos: Vec3Like; score: number } | null = null;
    for (const [key, fp] of this.footprints) {
      if (!key.startsWith(scope)) continue;
      const d = d3(here, fp.pos);
      if (d < 2 || d > maxDistance || Math.abs(fp.pos.y - here.y) > 8) continue;
      if (excluded.some((e) => d3(e, fp.pos) < 1.5)) continue;
      const rest = d3(fp.pos, target);
      if (rest >= left - 1) continue;
      const score = rest + d * 0.3;
      if (!best || score < best.score) best = { pos: fp.pos, score };
    }
    return best ? { ...best.pos } : null;
  }

  navigationWaypoint(target: Vec3Like, maxDistance: number, excluded: Vec3Like[]): Vec3Like | null {
    const state = this.syncScope();
    if (!state.observationReady) return null;
    const here = state.pos;
    const remaining = Math.hypot(target.x - here.x, target.z - here.z);
    // Optical transparency includes glass and barriers; it is not a collision test.
    const passable = (o: Optics | null) => !!o && /^(air|cave_air|void_air|light|short_grass|grass|tall_grass|fern|large_fern|dead_bush|torch|wall_torch|.*_torch|.*_carpet|.*_flower|.*_tulip|dandelion|poppy|vine|.*_sapling|mangrove_propagule)$/.test(o.name);
    const hazardousFloor = (name: string) => /water|lava|ice$|magma|campfire|cactus|powder_snow|berry_bush/.test(name);
    let best: { pos: Vec3Like; score: number } | null = null;
    for (const surface of this.visibleSurfaces.values()) {
      if (Date.now() - surface.at > 3000) continue;
      if (hazardousFloor(surface.name)) continue;
      const p = { x: surface.pos.x + 0.5, y: surface.pos.y + 1, z: surface.pos.z + 0.5 };
      const distance = Math.hypot(p.x - here.x, p.z - here.z);
      // A nearby requested cell is a destination, not an intermediate hop to skip.
      const destination = Math.floor(target.x) === surface.pos.x && Math.floor(target.y) === p.y && Math.floor(target.z) === surface.pos.z
        && (Math.floor(here.x) !== surface.pos.x || Math.floor(here.y) !== p.y || Math.floor(here.z) !== surface.pos.z);
      if ((!destination && distance < 1.5) || distance > maxDistance || Math.abs(p.y - here.y) > 2) continue;
      // 不挖不垫只能一格一格往上走：近处高出两格的地面是一堵墙，不是落脚点
      if (p.y - here.y > 1.2 && distance < 3 * (p.y - here.y)) continue;
      if (excluded.some((e) => destination
        ? Math.floor(e.x) === surface.pos.x && Math.floor(e.y) === p.y && Math.floor(e.z) === surface.pos.z
        : Math.hypot(e.x - p.x, e.z - p.z) < 1 && Math.abs(e.y - p.y) < 1)) continue;
      const floor = this.adapter.blockOptics(surface.pos.x, surface.pos.y, surface.pos.z);
      if (floor?.kind !== 'solid' || hazardousFloor(floor.name)) continue;
      // 短时视觉记忆只提供候选；地表状态变化或含水方块不能继续被当成干燥落脚点。
      if (String(this.adapter.blockStateAt?.(surface.pos)?.properties.waterlogged) === 'true') continue;
      if (!passable(this.adapter.blockOptics(surface.pos.x, surface.pos.y + 1, surface.pos.z))
        || !passable(this.adapter.blockOptics(surface.pos.x, surface.pos.y + 2, surface.pos.z))) continue;
      const left = Math.hypot(target.x - p.x, target.z - p.z);
      if (left > remaining + 3) continue; // 可以沿墙侧绕，不能无休止地走回头路。
      // 视野里最远的那一格可见地面往往就是坡顶、崖边或树冠边（再往前被挡住）。停在那里，下一段就从边上起步。
      // 前方一格没有看得见的地面（同高或差一格以内）的落脚点算“边缘”，叶子顶上也尽量不选。
      const ux = (p.x - here.x) / distance, uz = (p.z - here.z) / distance;
      const nx = Math.floor(surface.pos.x + 0.5 + ux), nz = Math.floor(surface.pos.z + 0.5 + uz);
      const ahead = [-1, 0, 1].some((dy) => this.visibleSurfaces.has(keyOf(nx, surface.pos.y + dy, nz)));
      const edge = left > 1.5 && !ahead ? 2.5 : 0;
      const leaves = /_leaves$/.test(surface.name) ? 4 : 0;
      const score = left + Math.abs(target.y - p.y) * 0.5 + distance * 0.08 + edge + leaves;
      if (!best || score < best.score) best = { pos: p, score };
    }
    return best?.pos ?? null;
  }

  /** 给 LLM 的视觉摘要 */
  summary(here: Vec3Like) {
    this.syncScope();
    const total = Object.values(this.composition).reduce((a, b) => a + b, 0) || 1;
    const view = Object.entries(this.composition)
      .filter(([c]) => c !== 'unknown')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c, n]) => `${c} ${Math.round((n / total) * 100)}%`)
      .join('、');

    const eye = this.adapter.eye();
    const group = (items: { name: string; pos: Vec3Like }[]) => {
      const m = new Map<string, { count: number; nearest: number; pos: Vec3Like }>();
      for (const it of items) {
        const d = Math.hypot(it.pos.x - here.x, it.pos.y - here.y, it.pos.z - here.z);
        const r = m.get(it.name);
        if (!r) m.set(it.name, { count: 1, nearest: d, pos: it.pos });
        else {
          r.count++;
          if (d < r.nearest) { r.nearest = d; r.pos = it.pos; }
        }
      }
      return [...m].map(([block, r]) => {
        const ay = yawTo(r.pos.x - here.x, r.pos.z - here.z);
        return { block, count: r.count, nearest: Math.round(r.nearest), dir: dirOfYaw(ay), rel: eye ? relOf(ay - eye.yaw) : undefined };
      }).sort((a, b) => a.nearest - b.nearest);
    };
    const visible = group([...this.visibleNow.values()].filter((b) => NOTABLE.has(b.name))).slice(0, 12);
    const visibleNames = new Set(visible.map((v) => v.block));
    const now = Date.now();
    const remembered = group([...this.known.values()].filter((b) => NOTABLE.has(b.name) && !this.visibleNow.has(keyOf(b.pos.x, b.pos.y, b.pos.z)) && !visibleNames.has(b.name)))
      .filter((r) => r.nearest <= this.effectiveRange())
      .slice(0, 10);
    const ent = (e: SeenEntity) => ({ id: e.id, name: e.name, pos: { ...e.pos }, dist: Math.round(e.dist), dir: e.dir, rel: e.rel });
    return {
      facing: eye ? dirOfYaw(eye.yaw) : null,
      fov: this.cfg.hFov,
      range: this.effectiveRange(),
      view: view || '（什么也看不见）',
      openness: this.openness,
      visible_resources: visible,
      remembered_resources: remembered,
      seen_entities: this.seen.filter((e) => e.kind !== 'item').slice(0, 8).map(ent),
      ...(() => {
        // 看得见的掉落物（按物品合并）：猎物掉的肉、挖掉的方块、死亡掉落……
        const drops = new Map<string, { ids: number[]; item: string; count: number; dist: number; dir: string; tossed_by_me?: boolean }>();
        for (const e of this.seen) {
          if (e.kind !== 'item') continue;
          const item = e.name.replace(/^item:/, '') || 'unknown';
          // 自己刚扔掉的标出来（不藏起来）：看见地上的东西，知道哪些是自己刚腾出去的
          const mine = !!(e.pos && this.adapter.isDiscarded?.(item, e.pos));
          const key = mine ? `${item}:mine` : item;
          const cur = drops.get(key);
          if (!cur) drops.set(key, { ids: [e.id], item, count: e.count ?? 1, dist: Math.round(e.dist), dir: e.dir, ...(mine ? { tossed_by_me: true } : {}) });
          else { cur.ids.push(e.id); cur.count += e.count ?? 1; if (e.dist < cur.dist) { cur.dist = Math.round(e.dist); cur.dir = e.dir; } }
        }
        const list = [...drops.values()].sort((a, b) => a.dist - b.dist).slice(0, 8);
        return list.length ? { visible_drops: list } : {};
      })(),
      heard: this.heard.slice(0, 5).map((e) => ({ name: e.name, approx: `${e.rel}约 ${Math.max(2, Math.round(e.dist / 2) * 2)} 格`, dir: e.dir })),
      nearest_land: (() => {
        const l = this.nearestLand(here);
        if (!l) return null;
        return {
          dir: l.dir, dist: l.dist,
          foot: { x: l.pos.x, y: l.pos.y + 1, z: l.pos.z },
          relative_height: l.pos.y + 1 - Math.floor(here.y),
          ...(l.waterTop !== undefined ? { climbable_from_water: l.climbableFromWater, water_surface_y: l.waterTop, height_above_water: l.heightAboveWater } : {}),
          path_confirmed: false,
          note: '候选落脚点（脚部目标格，由可见地表估计）；尚未确认能沿直线游过去，地下顶板或墙体可能挡住；从水里直接爬上岸最多高 1 格，更高的岸需要垫方块或挖台阶（由你决定）',
        };
      })(),
      last_look_around_s: this.lastSweepAt ? Math.round((now - this.lastSweepAt) / 1000) : null,
      ...(() => {
        // 历史视觉中的实体位置，可能已经移动或消失；不能作为当前交互目标
        const visibleIds = new Set(this.seen.map((e) => e.id));
        const recent = [...this.sightings.values()].filter((x) => !visibleIds.has(x.id) && now - x.at <= 120_000)
          .sort((a, b) => b.at - a.at).slice(0, 6)
          .map((x) => ({ id: x.id, name: x.name, pos: { ...x.pos }, source: 'past_visual_observation' as const, currently_visible: false as const, dir: dirOfYaw(yawTo(x.pos.x - here.x, x.pos.z - here.z)), dist: Math.round(Math.hypot(x.pos.x - here.x, x.pos.z - here.z)), seconds_ago: Math.round((now - x.at) / 1000) }));
        return recent.length ? { recent_sightings: recent } : {};
      })(),
    };
  }
}

export type VisionSummary = ReturnType<Vision['summary']>;
