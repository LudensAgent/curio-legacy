import type { Vec3Like } from '../adapter/types.ts';
import type { BlockProperties, BuildingComponent, BuildingPhase } from './spec.ts';

/**
 * 字符画分层设计：让模型自己设计建筑，而不是从预制蓝图里挑。
 * design = { legend: {字符: 方块名}, layers: [[行, …], …] }
 * - layers 从下往上：第 0 层是地板（y=-1，地基），第 1 层起是地面以上；
 * - 每层的行从前（北，z=0）到后，每行的字符从左（西，x=0）到右；
 * - "." 表示必须留空（室内、通道），空格表示不管；
 * - 门只写下半格（上半格自动补上），朝向按它在哪条外墙上自动定（朝外）。
 * 其余的施工阶段、依赖、门前通道都由程序推导，模型只管“哪里放什么”。
 */
export interface DesignInput { legend?: Record<string, unknown>; layers?: unknown }
export interface CompiledDesign { width: number; depth: number; height: number; components: BuildingComponent[]; clearances: Vec3Like[]; warnings: string[] }

const BLOCK_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** 会掉落、需要复杂方块状态或放不稳的方块：设计里不用 */
const UNSUPPORTED = /^(sand|red_sand|gravel|.*_concrete_powder|.*_stairs|.*_slab|.*_trapdoor|.*_fence_gate|.*_bed|.*_sign|.*_button|.*_pressure_plate|lever|ladder|.*_carpet|water|lava|fire|scaffolding|anvil|.*_anvil)$/;
const WINDOW = /glass/;
const FACILITY = /^(crafting_table|furnace|blast_furnace|smoker|chest|barrel|torch|lantern|soul_torch|soul_lantern|bookshelf|cartography_table|smithing_table|loom|stonecutter|grindstone|composter|cauldron|brewing_stand|enchanting_table|jukebox|note_block)$/;

export const DESIGN_EXAMPLE = '{"legend":{"C":"cobblestone","P":"oak_planks","G":"glass","D":"oak_door","T":"torch",".":"air"},"layers":[["CCCCC","CCCCC","CCCCC","CCCCC","CCCCC"],["PPDPP","P...P","P.T.P","P...P","PPPPP"],["PG.GP","P...P","G...G","P...P","PPGPP"],["PPPPP","PPPPP","PPPPP","PPPPP","PPPPP"]]}';

export function compileDesign(raw: DesignInput): CompiledDesign {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`design 需要 {legend, layers}；例如 ${DESIGN_EXAMPLE}`);
  const legend: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.legend ?? {})) {
    if ([...k].length !== 1) throw new Error(`legend 的键必须是单个字符：${k}`);
    const name = String(v ?? '').trim().replace(/^minecraft:/, '');
    if (name === 'air' || name === '.') { legend[k] = 'air'; continue; }
    if (!BLOCK_NAME.test(name)) throw new Error(`legend 里的方块名不合法：${k}=${name}`);
    if (UNSUPPORTED.test(name)) throw new Error(`${name} 会掉落或需要复杂朝向，暂时不能用在设计里；换成整块方块（如 planks、cobblestone、glass）`);
    legend[k] = name;
  }
  legend['.'] = 'air';
  const layers = raw.layers;
  if (!Array.isArray(layers) || layers.length < 3 || layers.length > 9) throw new Error('layers 需要 3–9 层（第 0 层是地板，至少再有墙和顶）');
  const rows = layers.map((layer, i) => {
    const r = Array.isArray(layer) ? layer.map(String) : typeof layer === 'string' ? layer.split(/[\n/|]/) : null;
    if (!r || !r.length) throw new Error(`第 ${i} 层需要是字符串数组（每行一个字符串）`);
    return r;
  });
  const depth = Math.max(...rows.map((r) => r.length));
  const width = Math.max(...rows.flatMap((r) => r.map((line) => [...line].length)));
  if (width < 3 || depth < 3 || width > 11 || depth > 11) throw new Error(`每层需要 3–11 行、每行 3–11 个字符（现在 ${width}×${depth}）`);
  const at = (y: number, x: number, z: number) => [...(rows[y]?.[z] ?? '')][x] ?? ' ';
  const components: BuildingComponent[] = [];
  const clearances: Vec3Like[] = [];
  const byPos = new Map<string, BuildingComponent>();
  const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
  const edge = (x: number, z: number) => x === 0 || z === 0 || x === width - 1 || z === depth - 1;
  const add = (pos: Vec3Like, name: string, phase: BuildingPhase, tags: string[], properties: BlockProperties = {}) => {
    const c: BuildingComponent = { pos, name, properties, phase, tags, dependsOn: [] };
    components.push(c); byPos.set(key(pos), c);
    return c;
  };
  for (let li = 0; li < rows.length; li++) for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const ch = at(li, x, z);
    if (ch === ' ') continue;
    const name = legend[ch];
    if (!name) throw new Error(`第 ${li} 层第 ${z + 1} 行有没在 legend 里定义的字符「${ch}」`);
    const y = li - 1, pos = { x, y, z };
    if (name === 'air') { if (y >= 0) clearances.push(pos); continue; }
    if (byPos.has(key(pos))) continue; // 门的上半格已自动补上
    if (y === -1) { add(pos, name, 'foundation', ['floor', 'support']); continue; }
    if (name.endsWith('_door')) {
      const facing = z === 0 ? 'north' : z === depth - 1 ? 'south' : x === 0 ? 'west' : x === width - 1 ? 'east' : 'north';
      if (!edge(x, z)) throw new Error(`门要开在外墙上（第 ${li} 层 x=${x}, z=${z} 在房子里面）`);
      add(pos, name, 'openings', ['entry', 'door'], { facing, half: 'lower', hinge: 'left', open: false });
      add({ x, y: y + 1, z }, name, 'openings', ['entry', 'door'], { facing, half: 'upper', hinge: 'left', open: false });
      // 门前门后留出通道
      const out = facing === 'north' ? { x, z: -1 } : facing === 'south' ? { x, z: depth } : facing === 'west' ? { x: -1, z } : { x: width, z };
      const inside = facing === 'north' ? { x, z: 1 } : facing === 'south' ? { x, z: depth - 2 } : facing === 'west' ? { x: 1, z } : { x: width - 2, z };
      for (const p of [out, inside]) for (const dy of [0, 1]) clearances.push({ x: p.x, y: y + dy, z: p.z });
      continue;
    }
    const below = at(li - 1, x, z), belowName = legend[below];
    const supportedBelow = !!belowName && belowName !== 'air';
    const phase: BuildingPhase = FACILITY.test(name) ? 'facilities' : WINDOW.test(name) ? 'openings'
      : !supportedBelow && !edge(x, z) ? 'roof' : edge(x, z) && (x === 0 || x === width - 1) && (z === 0 || z === depth - 1) ? 'frame' : supportedBelow && edge(x, z) ? 'enclosure' : 'roof';
    add(pos, name, phase, [phase === 'openings' ? 'window' : phase === 'roof' ? 'roof' : phase === 'facilities' ? 'facility' : 'wall']);
  }
  if (!components.some((c) => c.pos.y === -1)) throw new Error('第 0 层是地板：至少要有地板方块');
  if (!components.some((c) => c.name.endsWith('_door')) && !clearances.some((p) => p.y === 0 && edge(p.x, p.z)))
    throw new Error('房子要能进出：在外墙上放一扇门（legend 里写 oak_door 之类），或在外墙留 "." 的门洞');
  if (components.length > 600) throw new Error(`设计太大（${components.length} 块），控制在 600 块以内`);
  // 依赖：有下面的方块就等它；悬空的（屋顶、过梁）挂在同层旁边先放的方块上，按从外到内的顺序放
  for (const c of components) {
    const below = byPos.get(key({ ...c.pos, y: c.pos.y - 1 }));
    if (below) { c.dependsOn.push(key(below.pos)); continue; }
    if (c.pos.y === -1) continue;
    const ring = (p: Vec3Like) => Math.min(p.x, p.z, width - 1 - p.x, depth - 1 - p.z);
    const side = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dz]) => byPos.get(key({ x: c.pos.x + dx, y: c.pos.y, z: c.pos.z + dz })))
      .filter((n): n is BuildingComponent => !!n && ring(n.pos) < ring(c.pos)).sort((a, b) => ring(a.pos) - ring(b.pos))[0];
    if (side) c.dependsOn.push(key(side.pos));
  }
  // 设计提示（不拦着盖，只告诉模型这样的房子住起来有什么问题，下一版可以改）
  const warnings: string[] = [];
  const solid = (x: number, y: number, z: number) => { const c = byPos.get(key({ x, y, z })); return !!c && !FACILITY.test(c.name); };
  let uncovered = 0, interior = 0;
  for (let x = 1; x < width - 1; x++) for (let z = 1; z < depth - 1; z++) {
    interior++;
    let roofed = false;
    for (let y = 1; y < rows.length - 1; y++) if (solid(x, y, z)) { roofed = true; break; }
    if (!roofed) uncovered++;
  }
  if (uncovered) warnings.push(`屋顶有 ${uncovered}/${interior} 格没盖住，下雨、怪物会从上面进来`);
  let gaps = 0;
  const doorway = new Set(clearances.filter((p) => p.y === 0 && edge(p.x, p.z)).map((p) => `${p.x},${p.z}`));
  for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
    if (!edge(x, z) || doorway.has(`${x},${z}`)) continue;
    for (const y of [0, 1]) if (!byPos.has(key({ x, y, z }))) gaps++;
  }
  if (gaps) warnings.push(`外墙在人站立的高度有 ${gaps} 个空洞（没画方块、也不是 "." 门洞），怪物能钻进来`);
  if (!components.some((c) => /torch|lantern/.test(c.name))) warnings.push('屋里没有光源，晚上会刷怪；可以加一个 torch');
  // 门的上半格由下半格一起放
  return { width, depth, height: Math.max(2, rows.length - 1), components, clearances, warnings };
}
