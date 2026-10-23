import type { Vec3Like } from '../adapter/types.ts';

export type Rotation = 0 | 90 | 180 | 270;
export type BuildingPhase = 'foundation' | 'frame' | 'enclosure' | 'roof' | 'openings' | 'facilities';
export type BlockProperties = Record<string, string | number | boolean>;
export interface BuildingComponent {
  pos: Vec3Like;
  name: string;
  properties: BlockProperties;
  phase: BuildingPhase;
  tags: string[];
  dependsOn: string[];
}
export interface BuildingSpec {
  name: string;
  purpose: string;
  width: number;
  depth: number;
  height: number;
  roof: 'flat' | 'gable';
  palette: { foundation: string; wall: string; roof: string; window: string; door: string };
  windows: boolean;
  door: boolean;
  facilities: ('crafting_table' | 'furnace' | 'chest' | 'torch')[];
  maxFoundationDepth: number;
  budget: number;
  layout: 'house' | 'custom';
  /** Composable exact parts may extend/replace generated house cells, or define a whole custom layout. */
  components: BuildingComponent[];
}
export interface BuildingCell {
  id: string;
  pos: Vec3Like;
  name: string;
  properties: BlockProperties;
  phase: BuildingPhase;
  tags: string[];
  dependsOn: string[];
  /** Doors have two blocks but consume a single item and a single placement. */
  placedBy?: string;
}
export interface BuildingBlueprint {
  spec: BuildingSpec;
  cells: BuildingCell[];
  clearances: Vec3Like[];
  home?: Vec3Like;
}
export const PHASES: BuildingPhase[] = ['foundation', 'frame', 'enclosure', 'roof', 'openings', 'facilities'];
export const DEFAULT_SPEC: BuildingSpec = {
  name: 'hut_5x5', purpose: '可通行的庇护所', width: 5, depth: 5, height: 3, roof: 'gable',
  palette: { foundation: 'cobblestone', wall: 'cobblestone', roof: 'cobblestone', window: 'glass', door: 'oak_door' },
  windows: true, door: true, facilities: [], maxFoundationDepth: 4, budget: 512, layout: 'house', components: [],
};
const BLOCK_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// Structural palette cells must be full, non-falling cubes. Stateful parts are explicit below.
const STRUCTURAL = /^(?:cobblestone|mossy_cobblestone|stone|stone_bricks|mossy_stone_bricks|bricks|deepslate|cobbled_deepslate|deepslate_bricks|polished_deepslate|blackstone|polished_blackstone|polished_blackstone_bricks|netherrack|nether_bricks|red_nether_bricks|end_stone|end_stone_bricks|quartz_block|smooth_quartz|sandstone|smooth_sandstone|cut_sandstone|red_sandstone|smooth_red_sandstone|cut_red_sandstone|dirt|packed_mud|mud_bricks|terracotta|(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(?:concrete|terracotta|wool)|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_planks)$/;

export function normalizeSpec(raw: unknown): BuildingSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('spec 必须是对象');
  const input = raw as Record<string, any>;
  const palette = { ...DEFAULT_SPEC.palette, ...(input.palette ?? {}) };
  const spec = { ...DEFAULT_SPEC, ...input, palette, facilities: input.facilities ?? [] } as BuildingSpec;
  if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 100) throw new Error('name 需要 1-100 字符');
  if (typeof spec.purpose !== 'string' || !spec.purpose.trim() || spec.purpose.length > 300) throw new Error('purpose 需要 1-300 字符');
  for (const field of ['width', 'depth', 'height', 'maxFoundationDepth', 'budget'] as const) {
    const [min, max] = field === 'height' ? [3, 6] : field === 'maxFoundationDepth' ? [1, 8] : field === 'budget' ? [1, 4096] : [5, 11];
    if (!Number.isInteger(spec[field]) || spec[field] < min || spec[field] > max) throw new Error(`${field} 需要 ${min}-${max} 的整数`);
  }
  if (!['flat', 'gable'].includes(spec.roof)) throw new Error('roof 只支持 flat/gable');
  if (typeof spec.windows !== 'boolean' || typeof spec.door !== 'boolean') throw new Error('windows/door 必须为布尔值');
  if (Object.values(palette).some((v) => typeof v !== 'string' || !BLOCK_NAME.test(v))) throw new Error('palette 需要合法方块名称');
  for (const field of ['foundation', 'wall', 'roof'] as const) if (!STRUCTURAL.test(palette[field])) throw new Error(`${field} 必须是受支持的实心、非重力方块`);
  if (!/^(?:glass|(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_stained_glass)$/.test(palette.window)) throw new Error('window 必须为完整玻璃方块');
  if (!/^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|crimson|warped)_door$/.test(palette.door)) throw new Error('door 必须为可手动打开的木门');
  if (!Array.isArray(spec.facilities) || spec.facilities.length > 4 || new Set(spec.facilities).size !== spec.facilities.length || spec.facilities.some((f) => !['crafting_table', 'furnace', 'chest', 'torch'].includes(f))) throw new Error('facilities 支持不重复的 crafting_table/furnace/chest/torch');
  if (!['house', 'custom'].includes(spec.layout)) throw new Error('layout 支持 house/custom');
  if (!Array.isArray(spec.components) || spec.components.length > 150 || spec.layout === 'custom' && !spec.components.length) throw new Error('components 最多 150 项；custom 至少需要一项');
  const components: BuildingComponent[] = spec.components.map((c: any) => {
    if (!c || typeof c !== 'object' || !c.pos || [c.pos.x, c.pos.y, c.pos.z].some((v) => !Number.isInteger(v) || Math.abs(v) > 12) || typeof c.name !== 'string' || !BLOCK_NAME.test(c.name)) throw new Error('component 需要合法 name 和绝对值 ≤12 的整数 pos');
    if (c.properties !== undefined && (!c.properties || typeof c.properties !== 'object' || Array.isArray(c.properties) || Object.keys(c.properties).length > 16 || Object.values(c.properties).some((v) => !['string', 'number', 'boolean'].includes(typeof v)))) throw new Error('component.properties 需要简单方块状态对象');
    if (c.phase !== undefined && !PHASES.includes(c.phase)) throw new Error('component.phase 无效');
    if (c.tags !== undefined && (!Array.isArray(c.tags) || c.tags.length > 10 || c.tags.some((v: unknown) => typeof v !== 'string' || v.length > 50))) throw new Error('component.tags 无效');
    if (c.dependsOn !== undefined && (!Array.isArray(c.dependsOn) || c.dependsOn.length > 10 || c.dependsOn.some((v: unknown) => typeof v !== 'string' || !/^-?\d+,-?\d+,-?\d+$/.test(v)))) throw new Error('component.dependsOn 需要局部坐标 ID');
    return { pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, name: c.name, properties: { ...(c.properties ?? {}) }, phase: c.phase ?? 'frame', tags: [...(c.tags ?? [])], dependsOn: [...(c.dependsOn ?? [])] };
  });
  if (new Set(components.map((c) => cellKey(c.pos))).size !== components.length) throw new Error('components 坐标不能重复');
  // Keep a canonical shape: unknown input fields never leak into the persisted design.
  return { name: spec.name.trim(), purpose: spec.purpose.trim(), width: spec.width, depth: spec.depth, height: spec.height, roof: spec.roof, palette, windows: spec.windows, door: spec.door, facilities: [...spec.facilities], maxFoundationDepth: spec.maxFoundationDepth, budget: spec.budget, layout: spec.layout, components };
}

export function rotatePosition(p: Vec3Like, origin: Vec3Like, rotation: Rotation): Vec3Like {
  const [x, z] = rotation === 0 ? [p.x, p.z] : rotation === 90 ? [-p.z, p.x] : rotation === 180 ? [-p.x, -p.z] : [p.z, -p.x];
  return { x: origin.x + x, y: origin.y + p.y, z: origin.z + z };
}

export function rotateProperties(properties: BlockProperties, rotation: Rotation): BlockProperties {
  const result = { ...properties };
  const directions = ['north', 'east', 'south', 'west'];
  const i = directions.indexOf(String(result.facing));
  if (i >= 0) result.facing = directions[(i + rotation / 90) % 4];
  if ((rotation === 90 || rotation === 270) && (result.axis === 'x' || result.axis === 'z')) result.axis = result.axis === 'x' ? 'z' : 'x';
  return result;
}

export const cellKey = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;

/** Composes exact typed cells. A stepped gable deliberately uses full cubes, never fake stair states. */
export function compileBuilding(spec: BuildingSpec): BuildingBlueprint {
  if (spec.layout === 'custom') {
    const cells: BuildingCell[] = spec.components.map((c) => ({ ...structuredClone(c), id: cellKey(c.pos) }));
    linkPairedCells(cells);
    validateDependencies(cells);
    return { spec, cells, clearances: [] };
  }
  const cells: BuildingCell[] = [];
  const byPos = new Map<string, BuildingCell>();
  const add = (pos: Vec3Like, name: string, phase: BuildingPhase, tags: string[], properties: BlockProperties = {}, placedBy?: string) => {
    const id = cellKey(pos);
    if (byPos.has(id)) throw new Error(`重复蓝图坐标 ${id}`);
    const below = byPos.get(cellKey({ ...pos, y: pos.y - 1 }));
    const cell = { id, pos, name, phase, tags, properties, dependsOn: below ? [below.id] : [], ...(placedBy ? { placedBy } : {}) };
    byPos.set(id, cell); cells.push(cell);
    return cell;
  };
  const mid = Math.floor(spec.width / 2);
  for (let x = 0; x < spec.width; x++) for (let z = 0; z < spec.depth; z++) add({ x, y: -1, z }, spec.palette.foundation, 'foundation', ['floor', 'support']);
  add({ x: mid, y: -1, z: -1 }, spec.palette.foundation, 'foundation', ['threshold', 'support']);
  for (let y = 0; y < spec.height; y++) for (let x = 0; x < spec.width; x++) for (let z = 0; z < spec.depth; z++) {
    if (x !== 0 && z !== 0 && x !== spec.width - 1 && z !== spec.depth - 1) continue;
    if (z === 0 && x === mid && y < 2) continue;
    const window = spec.windows && y === 1 && ((x === 0 || x === spec.width - 1) && z === Math.floor(spec.depth / 2) || z === spec.depth - 1 && x === mid);
    const corner = (x === 0 || x === spec.width - 1) && (z === 0 || z === spec.depth - 1);
    add({ x, y, z }, window ? spec.palette.window : spec.palette.wall, corner ? 'frame' : window ? 'openings' : 'enclosure', [window ? 'window' : 'wall']);
  }
  // Each horizontal layer is complete, with the next one inset: connected, supported roof tiers.
  const tiers = spec.roof === 'gable' ? Math.ceil(spec.width / 2) : 1;
  for (let tier = 0; tier < tiers; tier++) for (let x = tier; x < spec.width - tier; x++) for (let z = 0; z < spec.depth; z++) {
    const cell = add({ x, y: spec.height + tier, z }, spec.palette.roof, 'roof', ['roof', spec.roof]);
    if (!cell.dependsOn.length) {
      // Roof over interior attaches sideways to an earlier cell on this row.
      const side = byPos.get(cellKey({ x: x - 1, y: spec.height + tier, z }));
      if (side) cell.dependsOn.push(side.id);
    }
  }
  if (spec.door) {
    const lower = add({ x: mid, y: 0, z: 0 }, spec.palette.door, 'openings', ['entry', 'door'], { facing: 'north', half: 'lower', hinge: 'left', open: false });
    add({ x: mid, y: 1, z: 0 }, spec.palette.door, 'openings', ['entry', 'door'], { facing: 'north', half: 'upper', hinge: 'left', open: false }, lower.id);
  }
  const slots = [{ x: 1, z: 1 }, { x: spec.width - 2, z: 1 }, { x: 1, z: spec.depth - 2 }, { x: spec.width - 2, z: spec.depth - 2 }];
  spec.facilities.forEach((name, i) => add({ ...slots[i], y: 0 }, name, 'facilities', [name === 'torch' ? 'lighting' : name === 'chest' ? 'storage' : 'workstation']));
  for (const component of spec.components) {
    const id = cellKey(component.pos);
    const index = cells.findIndex((c) => c.id === id);
    const cell = { ...structuredClone(component), id };
    if (index >= 0) cells[index] = cell; else cells.push(cell);
    byPos.set(id, cell);
  }
  linkPairedCells(cells);
  validateDependencies(cells);
  const clearances: Vec3Like[] = [];
  for (let x = 1; x < spec.width - 1; x++) for (let z = 1; z < spec.depth - 1; z++) for (let y = 0; y < spec.height; y++) if (!byPos.has(cellKey({ x, y, z }))) clearances.push({ x, y, z });
  for (const z of [-1, 0, 1]) for (const y of [0, 1]) if (!byPos.has(cellKey({ x: mid, y, z }))) clearances.push({ x: mid, y, z });
  return { spec, cells, clearances, home: { x: mid, y: 0, z: Math.floor(spec.depth / 2) } };
}

function validateDependencies(cells: BuildingCell[]) {
  const map = new Map(cells.map((c) => [c.id, c]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`循环施工依赖 ${id}`);
    if (visited.has(id)) return;
    const cell = map.get(id);
    if (!cell) throw new Error(`未知施工依赖 ${id}`);
    visiting.add(id);
    for (const dependency of cell.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const cell of cells) visit(cell.id);
}

/** Vanilla paired blocks consume one item; the other exact cell remains mandatory inspection. */
function linkPairedCells(cells: BuildingCell[]) {
  const directions: Record<string, Vec3Like> = { north: { x: 0, y: 0, z: -1 }, east: { x: 1, y: 0, z: 0 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 } };
  for (const cell of cells) {
    let position: Vec3Like | undefined, property: 'half' | 'part' = 'half', value = 'upper';
    if (cell.name.endsWith('_door') && cell.properties.half === 'lower') position = { ...cell.pos, y: cell.pos.y + 1 };
    if (cell.name.endsWith('_bed') && cell.properties.part === 'foot') {
      const direction = directions[String(cell.properties.facing)];
      if (direction) { position = { x: cell.pos.x + direction.x, y: cell.pos.y, z: cell.pos.z + direction.z }; property = 'part'; value = 'head'; }
    }
    if (!position) continue;
    const pair = cells.find((candidate) => cellKey(candidate.pos) === cellKey(position!) && candidate.name === cell.name && candidate.properties[property] === value);
    if (pair) { pair.placedBy = cell.id; pair.dependsOn = [...new Set([...pair.dependsOn, cell.id])]; }
  }
}

export function materialCost(cells: BuildingCell[]): Record<string, number> {
  const cost: Record<string, number> = {};
  for (const cell of cells) if (!cell.placedBy) cost[cell.name] = (cost[cell.name] ?? 0) + 1;
  return cost;
}
