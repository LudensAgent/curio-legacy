import type { Vec3Like } from '../adapter/types.ts';
import type { BlockProperties, BuildingComponent, BuildingPhase } from './spec.ts';

/**
 * 字符画分层设计：让模型自己设计建筑，而不是从预制蓝图里挑。
 * design = { legend: {字符: 方块名}, layers: [[行, …], …] }
 * - layers 从下往上：第 0 层是地板（y=-1，地基），第 1 层起是地面以上；
 * - 每层的行从前（北，z=0）到后，每行的字符从左（西，x=0）到右；
 * - "." 表示必须留空（室内、通道），空格表示不管；
 * - 门只写下半格（上半格自动补上），朝向按它在哪条外墙上自动定（朝外）。
 * - 台阶、半砖可以带状态：legend 写 "oak_stairs[facing=north,half=bottom]"、"oak_slab[type=top]"；
 *   台阶不写 facing 时按“朝房子中间往上走”自动定（做坡屋顶、屋檐最常用），半砖默认下半块；
 * - 栅栏、玻璃板、墙、活板门、梯子、地毯、灯笼、花盆等可以直接用（朝向和连接由放置时自然决定）。
 * 其余的施工阶段、依赖、门前通道都由程序推导，模型只管“哪里放什么”。
 */
export interface DesignInput { legend?: Record<string, unknown>; layers?: unknown }
export interface CompiledDesign { width: number; depth: number; height: number; components: BuildingComponent[]; clearances: Vec3Like[]; warnings: string[] }

const BLOCK_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** 会掉落、需要复杂方块状态或放不稳的方块：设计里不用 */
const UNSUPPORTED = /^(sand|red_sand|gravel|.*_concrete_powder|.*_fence_gate|.*_bed|.*_sign|.*_hanging_sign|.*_button|.*_pressure_plate|lever|water|lava|fire|scaffolding|anvil|.*_anvil|.*_banner|redstone.*|tnt)$/;
/** 需要明确方块状态才能放对的：台阶（朝向、上下半）、半砖（上下半） */
const STAIRS = /_stairs$/, SLAB = /_slab$/;
const FACINGS = ['north', 'south', 'east', 'west'];
const WINDOW = /glass/;
const FACILITY = /^(ladder|.*_carpet|.*_trapdoor|flower_pot|potted_.*|crafting_table|furnace|blast_furnace|smoker|chest|barrel|torch|lantern|soul_torch|soul_lantern|bookshelf|cartography_table|smithing_table|loom|stonecutter|grindstone|composter|cauldron|brewing_stand|enchanting_table|jukebox|note_block)$/;

export const DESIGN_EXAMPLE = '{"legend":{"C":"cobblestone","P":"oak_planks","G":"glass","D":"oak_door","T":"torch",".":"air"},"layers":[["CCCCC","CCCCC","CCCCC","CCCCC","CCCCC"],["PPDPP","P...P","P.T.P","P...P","PPPPP"],["PG.GP","P...P","G...G","P...P","PPGPP"],["PPPPP","PPPPP","PPPPP","PPPPP","PPPPP"]]}';
/** 带原木柱、玻璃板窗和台阶坡顶的示例（教模型怎么用台阶/半砖） */
export const DESIGN_EXAMPLE_RICH = '{"legend":{"C":"cobblestone","L":"oak_log","P":"oak_planks","G":"glass_pane","D":"oak_door","T":"lantern","S":"spruce_stairs","s":"spruce_slab",".":"air"},"layers":[["CCCCC","CCCCC","CCCCC","CCCCC","CCCCC"],["LPDPL","P...P","P...P","P...P","LPPPL"],["LG.GL","G...G","P.T.P","G...G","LPGPL"],["SSSSS","PsssP","PsssP","PsssP","SSSSS"],[".....","SSSSS","PPPPP","SSSSS","....."]]}';

/** "oak_stairs[facing=north,half=top]" 或 {"block":"oak_stairs","facing":"north"} → 名称 + 状态 */
function parseLegendValue(v: unknown): { name: string; properties: BlockProperties } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const name = String(o.block ?? o.name ?? '').trim().replace(/^minecraft:/, '');
    const properties: BlockProperties = {};
    for (const [k, val] of Object.entries(o.properties && typeof o.properties === 'object' ? o.properties as Record<string, unknown> : o)) {
      if (['block', 'name', 'properties'].includes(k)) continue;
      if (['string', 'number', 'boolean'].includes(typeof val)) properties[k] = val as string | number | boolean;
    }
    return { name, properties };
  }
  const raw = String(v ?? '').trim().replace(/^minecraft:/, '');
  const m = raw.match(/^([a-z0-9_]+)\[(.*)\]$/);
  if (!m) return { name: raw, properties: {} };
  const properties: BlockProperties = {};
  for (const part of m[2].split(',')) {
    const [k, val] = part.split('=').map((x) => x.trim());
    if (k && val !== undefined) properties[k] = val === 'true' ? true : val === 'false' ? false : val;
  }
  return { name: m[1], properties };
}

export function compileDesign(raw: DesignInput): CompiledDesign {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`design 需要 {legend, layers}；例如 ${DESIGN_EXAMPLE}`);
  const legend: Record<string, string> = {};
  const legendProps: Record<string, BlockProperties> = {};
  for (const [k, v] of Object.entries(raw.legend ?? {})) {
    if ([...k].length !== 1) throw new Error(`legend 的键必须是单个字符：${k}`);
    const { name, properties } = parseLegendValue(v);
    if (name === 'air' || name === '.') { legend[k] = 'air'; continue; }
    if (!BLOCK_NAME.test(name)) throw new Error(`legend 里的方块名不合法：${k}=${name}`);
    if (UNSUPPORTED.test(name)) throw new Error(`${name} 会掉落、需要红石或复杂交互，暂时不能用在设计里；换成整块方块、台阶、半砖、栅栏、活板门之类`);
    if (properties.facing !== undefined && !FACINGS.includes(String(properties.facing))) throw new Error(`${k}=${name} 的 facing 只能是 north/south/east/west`);
    if (STAIRS.test(name) && properties.half !== undefined && !['top', 'bottom'].includes(String(properties.half))) throw new Error(`${k}=${name} 的 half 只能是 top/bottom`);
    if (SLAB.test(name) && properties.type !== undefined && !['top', 'bottom'].includes(String(properties.type))) throw new Error(`${k}=${name} 的 type 只能是 top/bottom`);
    legend[k] = name;
    legendProps[k] = properties;
  }
  legend['.'] = 'air';
  const layers = raw.layers;
  if (!Array.isArray(layers) || layers.length < 3 || layers.length > 12) throw new Error('layers 需要 3–12 层（第 0 层是地板，至少再有墙和顶）');
  const rows = layers.map((layer, i) => {
    const r = Array.isArray(layer) ? layer.map(String) : typeof layer === 'string' ? layer.split(/[\n/|]/) : null;
    if (!r || !r.length) throw new Error(`第 ${i} 层需要是字符串数组（每行一个字符串）`);
    return r;
  });
  const depth = Math.max(...rows.map((r) => r.length));
  const width = Math.max(...rows.flatMap((r) => r.map((line) => [...line].length)));
  if (width < 3 || depth < 3 || width > 13 || depth > 13) throw new Error(`每层需要 3–13 行、每行 3–13 个字符（现在 ${width}×${depth}）`);
  const at = (y: number, x: number, z: number) => [...(rows[y]?.[z] ?? '')][x] ?? ' ';
  const components: BuildingComponent[] = [];
  const clearances: Vec3Like[] = [];
  const byPos = new Map<string, BuildingComponent>();
  const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
  // 房子的“墙脚”范围按地板（第 0 层）算：外面多画出来的一圈是屋檐，不算外墙
  const floorCells: [number, number][] = [];
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) { const c = [...(rows[0]?.[z] ?? '')][x] ?? ' '; if (c !== ' ' && c !== '.') floorCells.push([x, z]); }
  const fx0 = floorCells.length ? Math.min(...floorCells.map((c) => c[0])) : 0, fx1 = floorCells.length ? Math.max(...floorCells.map((c) => c[0])) : width - 1;
  const fz0 = floorCells.length ? Math.min(...floorCells.map((c) => c[1])) : 0, fz1 = floorCells.length ? Math.max(...floorCells.map((c) => c[1])) : depth - 1;
  const inFoot = (x: number, z: number) => x >= fx0 && x <= fx1 && z >= fz0 && z <= fz1;
  const edge = (x: number, z: number) => inFoot(x, z) && (x === fx0 || z === fz0 || x === fx1 || z === fz1);
  const add = (pos: Vec3Like, name: string, phase: BuildingPhase, tags: string[], properties: BlockProperties = {}) => {
    const c: BuildingComponent = { pos, name, properties, phase, tags, dependsOn: [] };
    components.push(c); byPos.set(key(pos), c);
    return c;
  };
  // 台阶默认“朝房子中间往上走”（坡屋顶、屋檐），半砖默认下半块
  const stateFor = (li: number, ch: string, name: string, x: number, z: number): BlockProperties => {
    const given = { ...(legendProps[ch] ?? {}) };
    if (STAIRS.test(name)) {
      if (given.facing === undefined) {
        // 一排台阶沿 x 排开就朝 z 方向往中间爬，沿 z 排开就朝 x 方向；单独一块按离中心更远的那个方向
        const dx = (width - 1) / 2 - x, dz = (depth - 1) / 2 - z;
        const same = (xx: number, zz: number) => legend[at(li, xx, zz)] === name;
        const alongX = same(x - 1, z) || same(x + 1, z), alongZ = same(x, z - 1) || same(x, z + 1);
        const byZ = alongX && !alongZ ? true : alongZ && !alongX ? false : Math.abs(dz) >= Math.abs(dx);
        given.facing = byZ ? (dz >= 0 ? 'south' : 'north') : (dx >= 0 ? 'east' : 'west');
      }
      if (given.half === undefined) given.half = 'bottom';
      delete given.shape; delete given.waterlogged;
    } else if (SLAB.test(name)) {
      if (given.type === undefined) given.type = 'bottom';
      delete given.waterlogged;
    } else for (const k of Object.keys(given)) delete given[k]; // 其他方块的朝向/连接交给放置时自然决定，不拿来验收
    return given;
  };
  for (let li = 0; li < rows.length; li++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const ch = at(li, x, z);
    if (ch === ' ') continue;
    const name = legend[ch];
    if (!name) throw new Error(`第 ${li} 层第 ${z + 1} 行有没在 legend 里定义的字符「${ch}」`);
    const y = li - 1, pos = { x, y, z };
    if (name === 'air') { if (y >= 0 && !byPos.has(key(pos))) clearances.push(pos); continue; } // 门的上半格不算留空
    if (byPos.has(key(pos))) continue; // 门的上半格已自动补上
    if (y === -1) { add(pos, name, 'foundation', ['floor', 'support']); continue; }
    if (name.endsWith('_door')) {
      const facing = z === fz0 ? 'north' : z === fz1 ? 'south' : x === fx0 ? 'west' : x === fx1 ? 'east' : 'north';
      if (!edge(x, z)) throw new Error(`门要开在外墙上（第 ${li} 层 x=${x}, z=${z} 在房子里面）`);
      add(pos, name, 'openings', ['entry', 'door'], { facing, half: 'lower', hinge: 'left', open: false });
      add({ x, y: y + 1, z }, name, 'openings', ['entry', 'door'], { facing, half: 'upper', hinge: 'left', open: false });
      // 门前门后留出通道
      const out = facing === 'north' ? { x, z: fz0 - 1 } : facing === 'south' ? { x, z: fz1 + 1 } : facing === 'west' ? { x: fx0 - 1, z } : { x: fx1 + 1, z };
      const inside = facing === 'north' ? { x, z: fz0 + 1 } : facing === 'south' ? { x, z: fz1 - 1 } : facing === 'west' ? { x: fx0 + 1, z } : { x: fx1 - 1, z };
      for (const p of [out, inside]) for (const dy of [0, 1]) clearances.push({ x: p.x, y: y + dy, z: p.z });
      continue;
    }
    const below = at(li - 1, x, z), belowName = legend[below];
    const supportedBelow = !!belowName && belowName !== 'air';
    const phase: BuildingPhase = FACILITY.test(name) ? 'facilities' : WINDOW.test(name) ? 'openings'
      : !supportedBelow && !edge(x, z) ? 'roof' : edge(x, z) && (x === 0 || x === width - 1) && (z === 0 || z === depth - 1) ? 'frame' : supportedBelow && edge(x, z) ? 'enclosure' : 'roof';
    add(pos, name, phase, [phase === 'openings' ? 'window' : phase === 'roof' ? 'roof' : phase === 'facilities' ? 'facility' : 'wall'], stateFor(li, ch, name, x, z));
  }
  if (!components.some((c) => c.pos.y === -1)) throw new Error('第 0 层是地板：至少要有地板方块');
  if (!components.some((c) => c.name.endsWith('_door')) && !clearances.some((p) => p.y === 0 && edge(p.x, p.z)))
    throw new Error('房子要能进出：在外墙上放一扇门（legend 里写 oak_door 之类），或在外墙留 "." 的门洞');
  if (components.length > 900) throw new Error(`设计太大（${components.length} 块），控制在 900 块以内`);
  // 依赖：有下面的方块就等它；悬空的（屋顶、过梁）挂在同层旁边先放的方块上，按从外到内的顺序放
  // 有下面的方块就等它；悬空的（屋顶、过梁、屋檐）在同一层里从“有东西托着”的方块一格格往外接：
  // 每块只挂在它旁边先放好的那一块上，像真人搭屋檐那样从墙头往外延伸，不会互相等
  const anchored = new Set<string>();
  const queue: BuildingComponent[] = [];
  for (const c of components) {
    const below = byPos.get(key({ ...c.pos, y: c.pos.y - 1 }));
    if (below) c.dependsOn.push(key(below.pos));
    if (below || c.pos.y === -1) { anchored.add(key(c.pos)); queue.push(c); }
  }
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const n = byPos.get(key({ x: from.pos.x + dx, y: from.pos.y, z: from.pos.z + dz }));
      if (!n || anchored.has(key(n.pos))) continue;
      anchored.add(key(n.pos));
      n.dependsOn.push(key(from.pos));
      queue.push(n);
    }
  }
  const floating = components.filter((c) => !anchored.has(key(c.pos))).length;
  // 设计提示（不拦着盖，只告诉模型这样的房子住起来有什么问题，下一版可以改）
  const warnings: string[] = [];
  const solid = (x: number, y: number, z: number) => { const c = byPos.get(key({ x, y, z })); return !!c && !FACILITY.test(c.name); };
  let uncovered = 0, interior = 0;
  for (let x = fx0 + 1; x < fx1; x++) for (let z = fz0 + 1; z < fz1; z++) {
    interior++;
    let roofed = false;
    for (let y = 1; y < rows.length - 1; y++) if (solid(x, y, z)) { roofed = true; break; }
    if (!roofed) uncovered++;
  }
  if (uncovered) warnings.push(`屋顶有 ${uncovered}/${interior} 格没盖住，下雨、怪物会从上面进来`);
  let gaps = 0;
  const doorway = new Set(clearances.filter((p) => p.y === 0 && edge(p.x, p.z)).map((p) => `${p.x},${p.z}`));
  for (let x = fx0; x <= fx1; x++) for (let z = fz0; z <= fz1; z++) {
    if (!edge(x, z) || doorway.has(`${x},${z}`)) continue;
    for (const y of [0, 1]) if (!byPos.has(key({ x, y, z }))) gaps++;
  }
  if (gaps) warnings.push(`外墙在人站立的高度有 ${gaps} 个空洞（没画方块、也不是 "." 门洞），怪物能钻进来`);
  if (!components.some((c) => /torch|lantern/.test(c.name))) warnings.push('屋里没有光源，晚上会刷怪；可以加一个 torch');
  if (floating) warnings.push(`有 ${floating} 块悬在半空、旁边和下面都没有能挂靠的方块，放不上去；让它和墙或屋顶连起来`);
  // 门的上半格由下半格一起放
  return { width, depth, height: Math.max(2, rows.length - 1), components, clearances, warnings };
}
