import type { BlockHit, EntityInfo, Eye, GameAdapter, Optics, Vec3Like } from '../adapter/types.ts';

/**
 * AI 视觉（不使用图片）：用区块数据模拟“人眼能看到的范围”。
 *
 * - 视锥：以角色当前的 yaw/pitch 为中心，水平 FOV × 垂直 FOV 发射 cols × rows 条射线（像一台低分辨率相机）
 * - 遮挡：每条射线用体素遍历（Amanatides & Woo DDA）前进，遇到第一个不透明方块就停下 → 只能看到表面，不能透视
 * - 透明介质：空气/玻璃/草/花可穿过；水最多穿过 6 格；树叶最多穿过 2 层
 * - 光照：命中面的亮度决定能看多远（黑暗的洞穴里只能看清身边几格）
 * - 实体：在视锥内 + 视线不被遮挡 + 足够亮 才算“看见”；看不见但离得近的算“听见”（只有大致方向和距离）
 * - 记忆：看见过的资源方块会被记住（位置 + 时间），转身之后仍然知道它在哪
 *
 * 上层（感知摘要、LLM、技能、反射层）只能通过这个模块获取方块和实体信息。
 */

export interface VisionConfig {
  /** 能看多远（格）。0 = 自动：服务器实际下发的渲染距离（view-distance × 16） */
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

export const DEFAULT_VISION: VisionConfig = { range: 0, hFov: 100, vFov: 60, cols: 40, rows: 24, hearRadius: 10, bandCols: 160, bandRows: 8 };
const FALLBACK_RANGE = 160;
const MAX_RANGE = 256;

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
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'].flatMap((o) => [`${o}_ore`, `deepslate_${o}_ore`]);
/** 值得记住位置的方块（资源/结构/危险） */
/** 可交互的功能方块（中文名）：看见了会记住位置，自己放下的记成“我的X”，用的时候先复用 */
export const INTERACTIVE_BLOCKS: Record<string, string> = {
  crafting_table: '工作台', furnace: '熔炉', smoker: '烟熏炉', blast_furnace: '高炉', chest: '箱子', trapped_chest: '陷阱箱', barrel: '木桶',
  ender_chest: '末影箱', anvil: '铁砧', chipped_anvil: '开裂的铁砧', damaged_anvil: '损坏的铁砧', enchanting_table: '附魔台', smithing_table: '锻造台',
  stonecutter: '切石机', loom: '织布机', grindstone: '砂轮', brewing_stand: '酿造台', cauldron: '炼药锅', water_cauldron: '炼药锅', composter: '堆肥桶',
  lectern: '讲台', cartography_table: '制图台', fletching_table: '制箭台', note_block: '音符盒', jukebox: '唱片机', bell: '钟', beacon: '信标',
  respawn_anchor: '重生锚', lodestone: '磁石', campfire: '营火', soul_campfire: '灵魂营火', hopper: '漏斗', dispenser: '发射器', dropper: '投掷器',
};
/** 任意颜色的床都算“床” */
export const interactiveName = (block: string): string | undefined => INTERACTIVE_BLOCKS[block] ?? (block.endsWith('_bed') ? '床' : undefined);

export const NOTABLE = new Set([
  ...LOGS, ...ORES, ...Object.keys(INTERACTIVE_BLOCKS),
  ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`), 'lava', 'spawner', 'hay_block', 'sugar_cane',
  'pumpkin', 'melon', 'obsidian', 'clay', 'sweet_berry_bush', 'nether_portal', 'end_portal', 'end_gateway', 'end_portal_frame', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'bookshelf', 'iron_bars',
]);
/** 采集目标常用的地表方块：也记住，但每种限量 */
export const GROUND = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'dirt', 'grass_block', 'sand', 'gravel', 'short_grass', 'tall_grass', 'grass', 'fern', 'water', 'netherrack', 'blackstone', 'basalt', 'soul_sand', 'soul_soil', 'end_stone', 'snow_block', 'ice', 'packed_ice', 'blue_ice']);

export interface SeenEntity {
  id: number;
  name: string;
  kind: EntityInfo['kind'];
  pos: Vec3Like;
  dist: number;
  height?: number;
  velocity?: Vec3Like;
  phase?: number;
  hp?: number;
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

export class Vision {
  frame: VisionFrame | null = null;
  seen: SeenEntity[] = [];
  heard: SeenEntity[] = [];
  /** 最近亲眼看见的生物及其最后位置（3 分钟） */
  sightings = new Map<number, { id: number; name: string; kind: string; pos: Vec3Like; at: number }>();
  /** 本次扫描看到的值得注意的方块 */
  visibleNow = new Map<string, { name: string; pos: Vec3Like; dist: number }>();
  composition: Record<string, number> = {};
  openness = { left: 0, center: 0, right: 0 };
  lastSweepAt = 0;
  private known = new Map<string, Known>();
  private perName = new Map<string, number>();
  private lastScanAt = 0;
  private scope = '';
  private session = '';
  private scopes = new Map<string, { known: Map<string, Known>; perName: Map<string, number> }>();

  constructor(private adapter: GameAdapter, public cfg: VisionConfig = DEFAULT_VISION) {}

  private syncScope() {
    const state = this.adapter.state();
    const scope = `${state.worldId}\u0000${state.dim}`;
    if (scope !== this.scope || state.sessionId !== this.session || !state.observationReady) {
      this.frame = null;
      this.seen = [];
      this.heard = [];
      this.sightings.clear();
      this.visibleNow.clear();
      this.composition = {};
      this.openness = { left: 0, center: 0, right: 0 };
      this.lastScanAt = 0;
      this.lastSweepAt = 0;
      if (scope !== this.scope) {
        this.scopes.set(this.scope, { known: this.known, perName: this.perName });
        const saved = this.scopes.get(scope);
        this.known = saved?.known ?? new Map();
        this.perName = saved?.perName ?? new Map();
        this.scope = scope;
      }
      this.session = state.sessionId;
    }
    const now = Date.now();
    for (const [key, block] of this.known) if (now - block.lastSeen > RESOURCE_MEMORY_TTL_MS) this.forget(key);
    return state;
  }

  /** 实际视距：配置值，或服务器下发的渲染距离（区块数 × 16） */
  effectiveRange(): number {
    if (this.cfg.range > 0) return Math.min(MAX_RANGE, this.cfg.range);
    const rd = this.adapter.renderDistance?.();
    return Math.min(MAX_RANGE, rd && rd > 0 ? rd : FALLBACK_RANGE);
  }

  // ------------------------------------------------------------ 扫描
  scan(): void {
    const t0 = Date.now();
    const s = this.syncScope();
    const eye = this.adapter.eye();
    if (!eye || !s.connected || !s.alive || !s.observationReady) {
      this.frame = null;
      this.seen = [];
      this.heard = [];
      this.sightings.clear();
      this.visibleNow.clear();
      return;
    }
    const { cols, rows } = this.cfg;
    const range = this.effectiveRange();
    const hFov = (this.cfg.hFov * Math.PI) / 180;
    const vFov = (this.cfg.vFov * Math.PI) / 180;
    const t = s.timeOfDay;
    const darkness = t < 12000 ? 0 : t < 13800 || t >= 22200 ? 5 : 11;

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
        const r = this.adapter.lightAt(x, y, z);
        // The End uses a brightened client lightmap even with zero sky/block
        // light (1.20.1 DimensionEffects.End). This floor belongs only to
        // visibility; raw light and mob-spawn rules remain unchanged.
        l = r ? Math.max(r.block, r.sky - darkness, s.dim === 'the_end' ? 4 : 0) : 15;
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
    const seeRange = (l: number) => (l >= 4 ? range : l >= 2 ? 12 : l >= 1 ? 6 : 3);

    const cats: number[] = new Array(cols * rows);
    const dists: number[] = new Array(cols * rows);
    const comp: Record<string, number> = {};
    this.visibleNow.clear();
    const now = Date.now();

    const note = (name: string, x: number, y: number, z: number, dist: number) => {
      if (!NOTABLE.has(name) && !GROUND.has(name)) return;
      const k = keyOf(x, y, z);
      if (!this.visibleNow.has(k)) this.visibleNow.set(k, { name, pos: { x, y, z }, dist });
      this.remember(k, name, { x, y, z }, now);
    };

    /** 一条视线：返回第一眼看到的表面类别与距离；沿途记录值得注意的方块 */
    const cast = (dx: number, dy: number, dz: number): { cat: Cat; dist: number } => {
      let hitCat: Cat | null = null;
      let hitDist = range;
      let water = 0, leaves = 0;
      let lx = ex, ly = ey, lz = ez;
      raycast(eye.x, eye.y, eye.z, dx, dy, dz, range, (x, y, z, d) => {
        if (y > 320 || y < -64) return true; // 出了世界高度
        if (sectionEmpty(x, y, z)) {
          // 整个 16³ 区段都是空气：直接跳到区段出口（远处天空方向的射线因此很便宜）
          const te = sectionExit(eye.x, eye.y, eye.z, dx, dy, dz, x, y, z);
          lx = Math.floor(eye.x + dx * (te - 0.01)); ly = Math.floor(eye.y + dy * (te - 0.01)); lz = Math.floor(eye.z + dz * (te - 0.01));
          return te;
        }
        const o = opt(x, y, z);
        if (!o) { if (!hitCat) { hitCat = 'unknown'; hitDist = d; } return true; }
        if (o.kind === 'clear') {
          if (NOTABLE.has(o.name) || GROUND.has(o.name)) note(o.name, x, y, z, d); // 甘蔗、草等无碰撞箱的植物
          lx = x; ly = y; lz = z;
          return false;
        }
        if (o.kind === 'solid' && o.shapes) {
          const hit = shapeHitDistance(o.shapes, eye, dx, dy, dz, x, y, z, range);
          if (hit === null) { lx = x; ly = y; lz = z; return false; }
          d = hit;
        }
        if (d > seeRange(light(lx, ly, lz))) { if (!hitCat) { hitCat = 'dark'; hitDist = d; } return true; }
        if (o.kind === 'water') {
          if (!hitCat) { hitCat = 'water'; hitDist = d; if (o.name === 'water') note('water', x, y, z, d); }
          return ++water > 6;
        }
        if (o.kind === 'foliage') {
          if (!hitCat) { hitCat = 'leaves'; hitDist = d; }
          return ++leaves >= 2;
        }
        note(o.name, x, y, z, d);
        if (!hitCat) { hitCat = catOf(o.name); hitDist = d; }
        return true;
      });
      return { cat: hitCat ?? (dy > -0.05 ? 'sky' : 'unknown'), dist: hitDist };
    };

    for (let j = 0; j < rows; j++) {
      const pitch = eye.pitch + (0.5 - (j + 0.5) / rows) * vFov;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let i = 0; i < cols; i++) {
        const yaw = eye.yaw + (0.5 - (i + 0.5) / cols) * hFov;
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
      const base: SeenEntity = { id: e.id, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist, height: e.height, velocity: e.velocity, phase: e.phase, hp: e.hp, dir: dirOfYaw(ayaw), rel: relOf(relYaw), how: 'seen' };
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
    // 记住亲眼看见过的生物在哪（像人一样：“刚才那头牛在坡那边”）；只记看见的，不记听见/墙后的
    for (const e of seen) if (e.kind !== 'item' && e.kind !== 'other') this.sightings.set(e.id, { id: e.id, name: e.name, kind: e.kind, pos: { ...e.pos }, at: now });
    for (const [id, x] of this.sightings) if (now - x.at > 180_000) this.sightings.delete(id);
    this.lastScanAt = now;
    this.frame = { cols, rows, cats, dists, facing: dirOfYaw(eye.yaw), range, entities: ents, ts: now, scanMs: Date.now() - t0 };
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
    const old = this.known.get(k);
    if (old) {
      if (old.name !== name) {
        this.perName.set(old.name, (this.perName.get(old.name) ?? 1) - 1);
        this.perName.set(name, (this.perName.get(name) ?? 0) + 1);
      }
      old.name = name;
      old.lastSeen = now;
      return;
    }
    const cap = GROUND.has(name) ? 300 : 600;
    const n = this.perName.get(name) ?? 0;
    if (n >= cap) {
      // 淘汰同名里最久没看到的
      let oldestK = '', oldestT = Infinity;
      for (const [kk, v] of this.known) if (v.name === name && v.lastSeen < oldestT) { oldestT = v.lastSeen; oldestK = kk; }
      if (oldestK) this.known.delete(oldestK);
    } else this.perName.set(name, n + 1);
    this.known.set(k, { name, pos, lastSeen: now });
  }

  private forget(k: string) {
    const v = this.known.get(k);
    if (!v) return;
    this.known.delete(k);
    this.perName.set(v.name, Math.max(0, (this.perName.get(v.name) ?? 1) - 1));
  }

  // ------------------------------------------------------------ 查询（给技能、反射层、感知摘要用）
  /** 看见的 + 听见的实体（反射层/战斗只能对这些做出反应） */
  perceivedEntities(radius = 16): EntityInfo[] {
    if (!this.syncScope().observationReady) return [];
    return [...this.seen, ...this.heard]
      .filter((e) => e.dist <= radius)
      .map((e) => ({ id: e.id, perception: e.how, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist, height: e.height, velocity: e.velocity, phase: e.phase, hp: e.hp }))
      .sort((a, b) => a.dist - b.dist);
  }

  /**
   * 已知的方块位置：当前看得见或曾经看见过（15 分钟内）。
   * 回到记忆位置时会校验方块是否还在（被挖掉/改变则遗忘）。
   */
  knownBlocks(names: string[], maxDist: number): BlockHit[] {
    const s = this.syncScope();
    if (!s.observationReady) return [];
    const set = new Set(names);
    const now = Date.now();
    const out: BlockHit[] = [];
    for (const [k, v] of this.known) {
      if (!set.has(v.name)) continue;
      if (now - v.lastSeen > RESOURCE_MEMORY_TTL_MS) { this.forget(k); continue; }
      const d = Math.hypot(v.pos.x - s.pos.x, v.pos.y - s.pos.y, v.pos.z - s.pos.z);
      if (d > maxDist) continue;
      const cur = this.adapter.blockOptics(v.pos.x, v.pos.y, v.pos.z);
      if (cur && cur.name !== v.name) { this.forget(k); continue; }
      out.push({ name: v.name, pos: v.pos, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** 让最近扫描一次（例如转头之后）。距离上次不足 150ms 则跳过。 */
  refresh() {
    this.syncScope();
    if (Date.now() - this.lastScanAt >= 150) this.scan();
  }

  /** 最近一次亲眼看见符合条件的生物在哪里（不透视：只来自以往的视觉扫描） */
  lastSighting(match: (name: string) => boolean, maxAgeMs = 120_000): { id: number; name: string; pos: Vec3Like; ageMs: number } | null {
    const now = Date.now();
    let best: { id: number; name: string; pos: Vec3Like; at: number } | null = null;
    for (const x of this.sightings.values()) if (match(x.name) && now - x.at <= maxAgeMs && (!best || x.at > best.at)) best = x;
    return best ? { id: best.id, name: best.name, pos: best.pos, ageMs: now - best.at } : null;
  }

  markSweep() {
    this.lastSweepAt = Date.now();
  }

  /** 最近的“可站立的陆地”（见过的地表方块，且上方是空气，不是海底） */
  nearestLand(here: Vec3Like, excluded: Vec3Like[] = []): { dir: string; dist: number; pos: Vec3Like } | null {
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
    return best ? { dir: dirOfYaw(yawTo(best.pos.x - here.x, best.pos.z - here.z)), dist: Math.round(best.d), pos: best.pos } : null;
  }

  knownCount() {
    this.syncScope();
    return this.known.size;
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
    const ent = (e: SeenEntity) => ({ name: e.name, dist: Math.round(e.dist), dir: e.dir, rel: e.rel });
    return {
      facing: eye ? dirOfYaw(eye.yaw) : null,
      fov: this.cfg.hFov,
      range: this.effectiveRange(),
      view: view || '（什么也看不见）',
      openness: this.openness,
      visible_resources: visible,
      remembered_resources: remembered,
      seen_entities: this.seen.filter((e) => e.kind !== 'item').slice(0, 8).map(ent),
      heard: this.heard.slice(0, 5).map((e) => ({ name: e.name, approx: `${e.rel}约 ${Math.max(2, Math.round(e.dist / 2) * 2)} 格`, dir: e.dir })),
      nearest_land: (() => {
        const l = this.nearestLand(here);
        return l ? { dir: l.dir, dist: l.dist } : null;
      })(),
      last_look_around_s: this.lastSweepAt ? Math.round((now - this.lastSweepAt) / 1000) : null,
      ...(() => {
        // 刚才看见、现在不在视野里的生物（“半分钟前东北边有头牛”）
        const visibleIds = new Set(this.seen.map((e) => e.id));
        const recent = [...this.sightings.values()].filter((x) => !visibleIds.has(x.id) && now - x.at <= 120_000)
          .sort((a, b) => b.at - a.at).slice(0, 6)
          .map((x) => ({ name: x.name, dir: dirOfYaw(yawTo(x.pos.x - here.x, x.pos.z - here.z)), dist: Math.round(Math.hypot(x.pos.x - here.x, x.pos.z - here.z)), seconds_ago: Math.round((now - x.at) / 1000) }));
        return recent.length ? { recent_sightings: recent } : {};
      })(),
    };
  }
}

export type VisionSummary = ReturnType<Vision['summary']>;
