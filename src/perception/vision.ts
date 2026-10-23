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
  range: number;
  hFov: number; // 度
  vFov: number; // 度
  cols: number;
  rows: number;
  hearRadius: number;
}

export const DEFAULT_VISION: VisionConfig = { range: 64, hFov: 100, vFov: 60, cols: 40, rows: 24, hearRadius: 10 };

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
export const NOTABLE = new Set([
  ...LOGS, ...ORES, 'crafting_table', 'chest', 'furnace', 'lava', 'spawner', 'bell', 'hay_block', 'sugar_cane',
  'pumpkin', 'melon', 'obsidian', 'clay', 'sweet_berry_bush',
]);
/** 采集目标常用的地表方块：也记住，但每种限量 */
export const GROUND = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'dirt', 'grass_block', 'sand', 'gravel']);

export interface SeenEntity {
  id: number;
  name: string;
  kind: EntityInfo['kind'];
  pos: Vec3Like;
  dist: number;
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
  visit: (x: number, y: number, z: number, t: number) => boolean,
) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx > 0 ? (x + 1 - ox) * tdx : dx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = dy > 0 ? (y + 1 - oy) * tdy : dy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = dz > 0 ? (z + 1 - oz) * tdz : dz < 0 ? (oz - z) * tdz : Infinity;
  let t = 0;
  for (let guard = 0; guard < 1000 && t <= max; guard++) {
    if (visit(x, y, z, t)) return;
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
    else { z += sz; t = tmz; tmz += tdz; }
  }
}

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class Vision {
  frame: VisionFrame | null = null;
  seen: SeenEntity[] = [];
  heard: SeenEntity[] = [];
  /** 本次扫描看到的值得注意的方块 */
  visibleNow = new Map<string, { name: string; pos: Vec3Like; dist: number }>();
  composition: Record<string, number> = {};
  openness = { left: 0, center: 0, right: 0 };
  lastSweepAt = 0;
  private known = new Map<string, Known>();
  private perName = new Map<string, number>();
  private lastScanAt = 0;

  constructor(private adapter: GameAdapter, public cfg: VisionConfig = DEFAULT_VISION) {}

  // ------------------------------------------------------------ 扫描
  scan(): void {
    const t0 = Date.now();
    const eye = this.adapter.eye();
    const s = this.adapter.state();
    if (!eye || !s.connected) {
      this.frame = null;
      this.seen = [];
      this.heard = [];
      this.visibleNow.clear();
      return;
    }
    const { range, cols, rows } = this.cfg;
    const hFov = (this.cfg.hFov * Math.PI) / 180;
    const vFov = (this.cfg.vFov * Math.PI) / 180;
    const t = s.timeOfDay;
    const darkness = t < 12000 ? 0 : t < 13800 || t >= 22200 ? 5 : 11;

    const optCache = new Map<number, Optics | null>();
    const lightCache = new Map<number, number>();
    const ex = Math.floor(eye.x), ey = Math.floor(eye.y), ez = Math.floor(eye.z);
    const lk = (x: number, y: number, z: number) => ((x - ex + 128) * 257 + (y - ey + 128)) * 257 + (z - ez + 128);
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
        l = r ? Math.max(r.block, r.sky - darkness) : 15;
        lightCache.set(k, l);
      }
      return l;
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

    for (let j = 0; j < rows; j++) {
      const pitch = eye.pitch + (0.5 - (j + 0.5) / rows) * vFov;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let i = 0; i < cols; i++) {
        const yaw = eye.yaw + (0.5 - (i + 0.5) / cols) * hFov;
        const dx = -Math.sin(yaw) * cp, dy = sp, dz = -Math.cos(yaw) * cp;
        let hitCat: Cat | null = null;
        let hitDist = range;
        let water = 0, leaves = 0;
        let lx = ex, ly = ey, lz = ez;
        raycast(eye.x, eye.y, eye.z, dx, dy, dz, range, (x, y, z, d) => {
          const o = opt(x, y, z);
          if (!o) { hitCat ??= 'unknown'; hitDist = Math.min(hitDist, d); return true; }
          if (o.kind === 'clear') {
            if (NOTABLE.has(o.name)) note(o.name, x, y, z, d); // 甘蔗等无碰撞箱的植物
            lx = x; ly = y; lz = z;
            return false;
          }
          if (d > seeRange(light(lx, ly, lz))) { if (!hitCat) { hitCat = 'dark'; hitDist = d; } return true; }
          if (o.kind === 'water') {
            if (!hitCat) { hitCat = 'water'; hitDist = d; }
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
        const c: Cat = hitCat ?? (dy > -0.05 ? 'sky' : 'unknown');
        const idx = j * cols + i;
        cats[idx] = CAT_INDEX[c];
        dists[idx] = Math.round((Math.min(hitDist, range) / range) * 255);
        comp[c] = (comp[c] ?? 0) + 1;
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
      const base: SeenEntity = { id: e.id, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist, dir: dirOfYaw(ayaw), rel: relOf(relYaw), how: 'seen' };
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
        heard.push({ ...base, how: 'heard' });
      }
    }
    this.seen = seen.sort((a, b) => a.dist - b.dist);
    this.heard = heard.sort((a, b) => a.dist - b.dist);
    this.lastScanAt = now;
    this.frame = { cols, rows, cats, dists, facing: dirOfYaw(eye.yaw), range, entities: ents, ts: now, scanMs: Date.now() - t0 };
  }

  private clearLine(eye: Eye, dx: number, dy: number, dz: number, max: number, opt: (x: number, y: number, z: number) => Optics | null): boolean {
    let ok = true, leaves = 0, water = 0;
    raycast(eye.x, eye.y, eye.z, dx, dy, dz, Math.max(0, max), (x, y, z) => {
      const o = opt(x, y, z);
      if (!o || o.kind === 'solid') { ok = false; return true; }
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
    return [...this.seen, ...this.heard]
      .filter((e) => e.dist <= radius)
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, pos: e.pos, dist: e.dist }))
      .sort((a, b) => a.dist - b.dist);
  }

  /**
   * 已知的方块位置：当前看得见或曾经看见过（30 分钟内）。
   * 回到记忆位置时会校验方块是否还在（被挖掉/改变则遗忘）。
   */
  knownBlocks(names: string[], maxDist: number): BlockHit[] {
    const s = this.adapter.state();
    const set = new Set(names);
    const now = Date.now();
    const out: BlockHit[] = [];
    for (const [k, v] of this.known) {
      if (!set.has(v.name)) continue;
      if (now - v.lastSeen > 30 * 60_000) { this.forget(k); continue; }
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
    if (Date.now() - this.lastScanAt >= 150) this.scan();
  }

  markSweep() {
    this.lastSweepAt = Date.now();
  }

  /** 最近的“可站立的陆地”（见过的地表方块，且上方是空气，不是海底） */
  nearestLand(here: Vec3Like): { dir: string; dist: number; pos: Vec3Like } | null {
    let best: { d: number; pos: Vec3Like } | null = null;
    for (const v of this.known.values()) {
      if (!GROUND.has(v.name) && !v.name.endsWith('_log')) continue;
      if (v.pos.y < here.y - 4) continue;
      const above = this.adapter.blockOptics(v.pos.x, v.pos.y + 1, v.pos.z);
      if (!above || above.kind !== 'clear') continue;
      const d = Math.hypot(v.pos.x - here.x, v.pos.z - here.z);
      if (!best || d < best.d) best = { d, pos: v.pos };
    }
    return best ? { dir: dirOfYaw(yawTo(best.pos.x - here.x, best.pos.z - here.z)), dist: Math.round(best.d), pos: best.pos } : null;
  }

  knownCount() {
    return this.known.size;
  }

  /** 给 LLM 的视觉摘要 */
  summary(here: Vec3Like) {
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
      .filter((r) => r.nearest <= 96)
      .slice(0, 10);
    const ent = (e: SeenEntity) => ({ name: e.name, dist: Math.round(e.dist), dir: e.dir, rel: e.rel });
    return {
      facing: eye ? dirOfYaw(eye.yaw) : null,
      fov: this.cfg.hFov,
      range: this.cfg.range,
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
    };
  }
}

export type VisionSummary = ReturnType<Vision['summary']>;
