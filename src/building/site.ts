import type { GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { DIRS } from '../perception/perception.ts';
import { rotatePosition, type BuildingSpec, type Rotation } from './spec.ts';

/**
 * 选址：像玩家盖房前那样看看身边的地形——每一列地表有多高、是不是水、有没有别人的东西——
 * 找一块够平、不挨水、不在出过事的地方的空地。只看各列最上面的地表（站在附近就看得见的地形），不往地下透视。
 */
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'powder_snow']);
/** 地表上可以清掉、不算地面的东西：草、花、树、雪层…… */
const COVER = /(^air$|^cave_air$|_leaves$|_log$|_wood$|_stem$|_sapling$|_flower$|_tulip$|_mushroom$|^short_grass$|^grass$|^tall_grass$|fern$|bush$|vine|^dandelion$|^poppy$|orchid$|allium$|bluet$|daisy$|cornflower$|lily_of_the_valley$|peony$|lilac$|^rose_bush$|^sunflower$|^snow$|^sugar_cane$|^torch$|^wall_torch$)/;
const NATURAL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'stone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'gravel', 'sand', 'red_sand', 'clay', 'sandstone', 'red_sandstone', 'terracotta', 'snow_block', 'mud', 'moss_block', 'netherrack', 'end_stone']);
const TREE = /_log$|_wood$|_stem$/;

export interface Column { y: number; ground: string; wet: boolean; tree: boolean; artificial: string | null }

export interface SiteCandidate {
  origin: Vec3Like; rotation: Rotation; score: number; dist: number; trees: number; spread: number;
  /** 整地工作量：要铲掉的高出来的自然方块数、要填的低洼格数（0/0 = 现成平地） */
  cut: number; fill: number;
}
/** 整地上限：铲最多高出 3 格、填最多低 2 格；5×5（含余量）总量不超过约 40 块，按面积放大 */
const MAX_CUT = 3, MAX_FILL = 2;
export const levelBudget = (spec: Pick<BuildingSpec, 'width' | 'depth'>) => Math.round(40 * (spec.width * spec.depth) / 25);

export interface SiteSurvey {
  best: SiteCandidate | null;
  checked: number;
  rejected: { wet: number; uneven: number; hazard: number; artificial: number; unknown: number };
  /** 地势更平、更干的方向（失败时给建议） */
  hint: string | null;
}

/** 房子 + 门口 + 脚手架占的局部坐标范围（未旋转），外加 1 格余量 */
export function footprintBounds(spec: Pick<BuildingSpec, 'width' | 'depth' | 'height' | 'layout'>) {
  const scaffold = spec.layout === 'house';
  return { minX: (scaffold ? -2 : 0) - 1, maxX: spec.width, minZ: (scaffold ? -spec.height - 2 : -1) - 1, maxZ: spec.depth };
}

/** 一列地表：从上往下穿过空气和植被，第一块是液体 → wet；第一块地面 → 地表高度 */
export function surfaceColumn(adapter: GameAdapter, x: number, z: number, top: number, bottom: number, own: Set<string>): Column | null {
  let tree = false;
  // 扫描起点必须是露天的空气/植被：起点就是实心方块说明在山体里或地下，“找到的地面”并不是地表
  const first = adapter.blockAt({ x, y: top, z });
  if (first === null || !(AIR.has(first) || COVER.test(first) || LIQUID.has(first))) return null;
  for (let y = top; y >= bottom; y--) {
    const name = adapter.blockAt({ x, y, z });
    if (name === null) return null;
    if (AIR.has(name)) continue;
    if (LIQUID.has(name)) return { y, ground: name, wet: true, tree, artificial: null };
    if (own.has(`${x},${y},${z}`)) continue; // 自己的工作台/熔炉：盖房时会收起来再放
    if (COVER.test(name)) { if (TREE.test(name)) tree = true; continue; }
    const below = adapter.blockAt({ x, y: y - 1, z });
    const wet = below !== null && LIQUID.has(below);
    return { y, ground: name, wet, tree, artificial: NATURAL.has(name) ? null : name };
  }
  return null;
}

export function surveyBuildSite(adapter: GameAdapter, memory: WorldMemory | null, spec: Pick<BuildingSpec, 'width' | 'depth' | 'height' | 'layout'> & { maxFoundationDepth?: number }, opts: { radius?: number; rotations?: Rotation[]; ownStations?: Vec3Like[]; center?: Vec3Like } = {}): SiteSurvey {
  const s = adapter.state();
  const radius = opts.radius ?? 24;
  const rotations = opts.rotations ?? [0, 90, 180, 270];
  const own = new Set((opts.ownStations ?? []).map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`));
  // center：围绕某个点（比如模型给的 origin）找；默认围绕自己
  const c0 = opts.center ?? s.pos;
  const bx = Math.floor(c0.x), by = Math.floor(c0.y), bz = Math.floor(c0.z);
  const b = footprintBounds(spec);
  // 候选位置最远 radius，占地的角最远再加上半对角线（按矩形的角算，不是按最长边）
  const reach = radius + Math.hypot(Math.max(-b.minX, b.maxX), Math.max(-b.minZ, b.maxZ)) + 1;
  const cols = new Map<string, Column | null>();
  const col = (x: number, z: number) => {
    const k = `${x},${z}`;
    if (!cols.has(k)) cols.set(k, Math.hypot(x - bx, z - bz) > reach ? null : surfaceColumn(adapter, x, z, by + 10, by - 12, own));
    return cols.get(k)!;
  };
  const rejected = { wet: 0, uneven: 0, hazard: 0, artificial: 0, unknown: 0 };
  const dirScore = new Map<string, { ok: number; n: number; wet: number }>();
  let best: SiteCandidate | null = null, checked = 0;
  for (let dx = -radius; dx <= radius; dx += radius ? 2 : 1) for (let dz = -radius; dz <= radius; dz += radius ? 2 : 1) {
    if (Math.hypot(dx, dz) > radius) continue;
    const ox = bx + dx, oz = bz + dz;
    const dir = Object.entries(DIRS).reduce((acc, [d, [ux, uz]]) => { const dot = ux * dx + uz * dz; return dot > acc.dot ? { d, dot } : acc; }, { d: 'N', dot: -Infinity }).d;
    const ds = dirScore.get(dir) ?? { ok: 0, n: 0, wet: 0 };
    dirScore.set(dir, ds);
    for (const rotation of rotations) {
      checked++;
      ds.n++;
      let reason: keyof typeof rejected | null = null;
      const heights: number[] = [];
      let trees = 0;
      for (let lx = b.minX; lx <= b.maxX && !reason; lx++) for (let lz = b.minZ; lz <= b.maxZ && !reason; lz++) {
        const p = rotatePosition({ x: lx, y: 0, z: lz }, { x: ox, y: 0, z: oz }, rotation);
        const c = col(p.x, p.z);
        if (!c) { reason = 'unknown'; break; }
        if (c.wet) { reason = 'wet'; break; }
        const margin = lx === b.minX || lx === b.maxX || lz === b.minZ || lz === b.maxZ;
        if (margin) continue; // 余量这一圈只要求干燥
        if (c.artificial) { reason = 'artificial'; break; }
        heights.push(c.y);
        if (c.tree) trees++;
      }
      if (!reason) {
        const lo = Math.min(...heights), hi = Math.max(...heights);
        // 地基高度：平地取最常见的地表；坡地取中位数（铲 + 填的总量最少）
        const freq = new Map<number, number>();
        for (const h of heights) freq.set(h, (freq.get(h) ?? 0) + 1);
        const sorted = [...heights].sort((p, q) => p - q);
        const ground = hi - lo <= 1 ? [...freq].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0] : sorted[Math.floor(sorted.length / 2)];
        const cut = heights.reduce((a, h) => a + Math.max(0, h - ground), 0);
        const fill = heights.reduce((a, h) => a + Math.max(0, ground - h), 0);
        if (hi - ground > MAX_CUT || ground - lo > Math.min(MAX_FILL, spec.maxFoundationDepth ?? MAX_FILL) || cut + fill > levelBudget(spec)) reason = 'uneven';
        else {
          const origin = { x: ox, y: ground + 1, z: oz };
          const center = rotatePosition({ x: Math.floor(spec.width / 2), y: 0, z: Math.floor(spec.depth / 2) }, origin, rotation);
          if (memory?.hazardAt?.(center, s.dim)) reason = 'hazard';
          else {
            const dist = Math.hypot(center.x + 0.5 - c0.x, center.z + 0.5 - c0.z);
            const spread = heights.filter((h) => h !== ground).length;
            // 越平、树越少、越近越好；离得太近（站在占地中间）也没关系，整地时会先走开
            // 现成的平地（高低差 ≤1）永远优先；没有才挑整地量最少的坡地
            const levelling = hi - lo > 1 ? 50 + (cut + fill) : spread * 0.6;
            const score = levelling + trees * 0.4 + dist * 0.15 + Math.abs(ground + 1 - c0.y) * 0.5;
            ds.ok++;
            if (!best || score < best.score) best = { origin, rotation, score, dist: Math.round(dist), trees, spread, cut: hi - lo > 1 ? cut : 0, fill: hi - lo > 1 ? fill : 0 };
          }
        }
      }
      if (reason) { rejected[reason]++; if (reason === 'wet') ds.wet++; }
    }
  }
  // 都不行时建议往“水最少”的方向走（那边多半是干燥的陆地）
  const hintDir = [...dirScore].filter(([, v]) => v.n).sort((p, q) => p[1].wet / p[1].n - q[1].wet / q[1].n)[0];
  const hint = best ? null : hintDir ? hintDir[0] : null;
  return { best, checked, rejected, hint };
}

/** 失败时的人话说明 */
export function describeSiteFailure(survey: SiteSurvey, spec: Pick<BuildingSpec, 'width' | 'depth'>, radius = 24): string {
  const r = survey.rejected;
  const why = [r.wet ? '挨水/岩浆' : '', r.uneven ? '坡太陡、要铲/填的方块太多' : '', r.artificial ? '有不是自然地形的方块' : '', r.hazard ? '在出过事的危险区域' : '', r.unknown ? '有区块没加载、或地表被山体/洞顶盖住' : ''].filter(Boolean).join('、');
  return `附近 ${radius} 格内没有够平（或整得平）又不挨水的 ${spec.width}×${spec.depth} 空地${why ? `（试过的位置主要问题：${why}）` : ''}，换个地方${survey.hint ? `（比如往 ${survey.hint} 走 30 格以上）` : ''}再试，或直接给 origin`;
}

/** 某个指定 origin 能不能盖：能盖返回校正过高度的 origin；不能盖返回原因 */
export function checkSiteAt(adapter: GameAdapter, memory: WorldMemory | null, spec: Pick<BuildingSpec, 'width' | 'depth' | 'height' | 'layout'> & { maxFoundationDepth?: number }, origin: Vec3Like, rotation: Rotation, ownStations: Vec3Like[] = []): { ok: true; origin: Vec3Like } | { ok: false; why: string } {
  const r = surveyBuildSite(adapter, memory, spec, { radius: 0, rotations: [rotation], ownStations, center: origin });
  if (r.best && Math.abs(r.best.origin.y - origin.y) <= 2) return { ok: true, origin: r.best.origin };
  const x = r.rejected;
  const why = r.best ? `地面高度是 ${r.best.origin.y - 1}，和给的 y=${origin.y} 差太多` : [x.wet ? '挨着水/岩浆' : '', x.uneven ? '坡太陡（一边要挖进山里超过 3 格或悬空超过 2 格，整地量太大）' : '', x.artificial ? '占地里有不是自然地形的方块' : '', x.hazard ? '在出过事的危险区域' : '', x.unknown ? '地表被山体/洞顶盖住或区块没加载' : ''].filter(Boolean).join('、') || '地形不合适';
  return { ok: false, why };
}

/** 给建筑师看的地形草图：以自己为中心，每格是这一列地表比脚下高/低几格（只看露在外面的地表） */
export interface TerrainSketch {
  /** 中心（自己站的那一列）的世界坐标，y 是脚下地面的高度 */
  center: { x: number; y: number; z: number };
  radius: number;
  /** 每格相对高度；null = 看不清/在山体里，'water' = 水面 */
  heights: (number | 'water' | null)[][];
  trees: boolean[][];
  rows: string[];
  summary: string;
}

export function terrainSketch(adapter: GameAdapter, radius = 8, at?: Vec3Like): TerrainSketch {
  const s = adapter.state();
  const c = at ?? s.pos;
  const bx = Math.floor(c.x), bz = Math.floor(c.z), py = Math.floor(c.y);
  const here = surfaceColumn(adapter, bx, bz, py + 2, py - 6, new Set());
  const base = here && !here.wet ? here.y : py - 1;
  const heights: (number | 'water' | null)[][] = [], trees: boolean[][] = [], rows: string[] = [];
  const stats = { n: [0, 0], s: [0, 0], w: [0, 0], e: [0, 0], water: { n: 0, s: 0, w: 0, e: 0 }, trees: 0, flat: 0, known: 0 };
  for (let dz = -radius; dz <= radius; dz++) {
    const hr: (number | 'water' | null)[] = [], tr: boolean[] = [], toks: string[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      const c = surfaceColumn(adapter, bx + dx, bz + dz, base + 12, base - 10, new Set());
      const h: number | 'water' | null = !c ? null : c.wet ? 'water' : c.y - base;
      hr.push(h); tr.push(!!c?.tree);
      const tok = h === null ? '?' : h === 'water' ? '~' : h > 0 ? `+${h}` : String(h);
      toks.push(`${tok}${c?.tree ? 'T' : ''}`);
      if (h === null) continue;
      stats.known++;
      if (c!.tree) stats.trees++;
      const side = (k: 'n' | 's' | 'w' | 'e') => { if (h === 'water') stats.water[k]++; else { stats[k][0] += h; stats[k][1]++; } };
      if (dz < 0) side('n'); if (dz > 0) side('s'); if (dx < 0) side('w'); if (dx > 0) side('e');
      if (h !== 'water' && Math.abs(h) <= 1) stats.flat++;
    }
    heights.push(hr); trees.push(tr); rows.push(toks.join(' '));
  }
  const avg = (k: 'n' | 's' | 'w' | 'e') => stats[k][1] ? stats[k][0] / stats[k][1] : 0;
  const notes: string[] = [];
  const ns = avg('n') - avg('s'), we = avg('w') - avg('e');
  if (Math.abs(ns) >= 1) notes.push(ns > 0 ? `北高南低（约 ${ns.toFixed(1)} 格）` : `南高北低（约 ${(-ns).toFixed(1)} 格）`);
  if (Math.abs(we) >= 1) notes.push(we > 0 ? `西高东低（约 ${we.toFixed(1)} 格）` : `东高西低（约 ${(-we).toFixed(1)} 格）`);
  if (!notes.length) notes.push('大体平坦');
  const wet = (Object.entries(stats.water) as [string, number][]).filter(([, n]) => n >= 3).map(([k]) => ({ n: '北', s: '南', w: '西', e: '东' } as Record<string, string>)[k]);
  if (wet.length) notes.push(`${wet.join('、')}边有水`);
  if (stats.trees) notes.push(`有 ${stats.trees} 列长着树`);
  notes.push(`和脚下差不多高（±1）的格子占 ${stats.known ? Math.round(stats.flat / stats.known * 100) : 0}%`);
  return { center: { x: bx, y: base, z: bz }, radius, heights, trees, rows, summary: notes.join('；') };
}
