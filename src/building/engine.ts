import type { GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { SkillCtx } from '../skills/types.ts';
import { codeFromError, isAbort } from '../skills/types.ts';
import { AbortedError, sleep, throwIfAborted } from '../util.ts';
import { type BuildingArchive, type BuildingDefect, type BuildingInspection, type BuildingProject } from './archive.ts';
import { cellKey, materialCost, PHASES, rotatePosition, rotateProperties, type BlockProperties, type BuildingBlueprint, type BuildingCell } from './spec.ts';
import { erectScaffolding, inspectScaffoldSite, planScaffolding, removeScaffolding } from './scaffold.ts';
import { availableInventoryFor } from '../projects/reservations.ts';
import { STATION_LABEL } from '../skills/stations.ts';

/** 盖房时可以先收起来、盖完再放的自己的功能方块（箱子不动：里面有东西，挖了会撒一地） */
/** 填坑可用的普通方块（整地挖出来的） */
const FILLERS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'granite', 'diorite'];
const STOWABLE = ['crafting_table', 'furnace', 'smoker', 'blast_furnace'];
/** 记忆里“我的工作台/我的熔炉”这类自己放下的功能方块：位置 → { 方块名, 地标 id } */
export function ownStationsAt(ctx: SkillCtx): Map<string, { name: string; landmarkId: string }> {
  const s = ctx.adapter.state();
  const out = new Map<string, { name: string; landmarkId: string }>();
  const byLabel = new Map(STOWABLE.filter((k) => STATION_LABEL[k]).map((k) => [STATION_LABEL[k], k]));
  for (const l of ctx.memory.landmarks?.() ?? []) {
    const kind = byLabel.get(l.label);
    if (!kind || l.dim !== s.dim || (l.worldId && l.worldId !== s.worldId)) continue;
    const p = { x: Math.round(l.pos.x), y: Math.round(l.pos.y), z: Math.round(l.pos.z) };
    for (const q of [p, { x: Math.floor(l.pos.x), y: Math.floor(l.pos.y), z: Math.floor(l.pos.z) }]) {
      if (ctx.adapter.blockAt(q) === kind) out.set(cellKey(q), { name: kind, landmarkId: l.id });
    }
  }
  return out;
}

export interface StateBuildingAdapter extends GameAdapter {
  blockStateAt?(pos: Vec3Like): { name: string; properties: BlockProperties } | null;
  placeBlockStateAt?(pos: Vec3Like, name: string, properties: BlockProperties, signal: AbortSignal): Promise<{ ok: boolean; reason?: string }>;
}
const AIR = new Set(['air', 'cave_air', 'void_air']);
const PLANTS = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'dandelion', 'poppy']);
const NATURAL_GROUND = new Set(['grass_block', 'dirt', 'stone', 'cobblestone', 'gravel', 'sand', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'deepslate', 'netherrack', 'end_stone']);
/** 可以直接当房子地板的自然地面（结实、不会掉落） */
const NATURAL_FLOOR = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'sandstone', 'red_sandstone', 'terracotta', 'mud', 'packed_mud', 'clay', 'netherrack', 'end_stone', 'moss_block']);
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow']);
const replaceable = (name: string) => AIR.has(name) || PLANTS.has(name);
/** 留空表示能通行，不要求拆掉后来布置的薄设施；门、栅栏、积雪、液体等不在其中。 */
const clearanceFixture = (name: string) => /^(?:(?:soul_|redstone_)?(?:wall_)?torch|(?:[a-z_]+_)?carpet|(?:powered_|detector_|activator_)?rail|[a-z_]+_button|[a-z_]+_pressure_plate|lever|redstone_wire)$/.test(name);
/** 整地时可以清掉的自然东西：植物、树、雪，以及会被铲平的泥土石头；自己插的火把也可以拿掉 */
const VEGETATION = /(_leaves|_log|_wood|_stem|_sapling|mangrove_propagule|_flower|_tulip|_mushroom|_carpet|grass|fern|bush|vine|vines|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|peony|lilac|rose_bush|sunflower|sugar_cane|bamboo|azalea|cactus|snow|cobweb|lily_pad|hanging_roots|spore_blossom|glow_lichen|moss_block)$/;
// 不含圆石、耕地、土径：那些多半是自己或别人做出来的（墙、农田、小路），留给验收报告
const LEVELABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'stone', 'deepslate', 'netherrack', 'end_stone', 'sand', 'red_sand', 'gravel', 'clay', 'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'sandstone', 'red_sandstone', 'terracotta', 'snow_block', 'mud', 'moss_block']);
export const siteClearable = (name: string) => !name.endsWith('grass_block') && VEGETATION.test(name) || LEVELABLE.has(name) || clearanceFixture(name);
const solidGround = (name: string) => !replaceable(name) && !HAZARDS.has(name) && !/door|torch|flower|sapling|leaves|fence|pane|carpet|bed|rail/.test(name);

function actualState(adapter: StateBuildingAdapter, pos: Vec3Like) {
  if (adapter.blockStateAt) return adapter.blockStateAt(pos);
  const name = adapter.blockAt(pos);
  return name === null ? null : { name, properties: {} };
}

/** 木头是哪一种不影响能不能住：云杉木板缺了用橡木木板顶上，像玩家一样手边有什么用什么 */
const WOOD = /^(?:stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(planks|log|wood|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button)$/;
export const woodShape = (name: string) => { const m = name.match(WOOD); return m ? `${name.startsWith('stripped_') ? 'stripped_' : ''}${m[2] === 'wood' ? 'log' : m[2]}` : null; };
export const sameMaterial = (a: string, b: string) => a === b || (!!woodShape(a) && woodShape(a) === woodShape(b));

function cellDefect(adapter: StateBuildingAdapter, cell: BuildingCell, project: BuildingProject): BuildingDefect | null {
  const pos = rotatePosition(cell.pos, project.origin, project.rotation);
  const expected = rotateProperties(cell.properties, project.rotation);
  const actual = actualState(adapter, pos);
  if (!actual) return { cellId: cell.id, pos, kind: 'unknown', expected: cell.name, actual: null };
  // 房子的地板：脚下本来就是结实的自然地面（草方块、泥土、石头…）就直接当地板用，像玩家一样不必挖掉再铺圆石
  if (actual.name !== cell.name && cell.phase === 'foundation' && cell.tags.includes('floor') && NATURAL_FLOOR.has(actual.name)) return null;
  if (!sameMaterial(actual.name, cell.name)) return { cellId: cell.id, pos, kind: AIR.has(actual.name) ? 'missing' : 'wrong_block', expected: cell.name, actual: actual.name };
  if (Object.keys(expected).length && !adapter.blockStateAt) return { cellId: cell.id, pos, kind: 'unsupported', expected: `${cell.name} ${JSON.stringify(expected)}`, actual: actual.name };
  if (Object.entries(expected).some(([key, value]) => String(actual.properties[key]) !== String(value))) return { cellId: cell.id, pos, kind: 'wrong_state', expected: `${cell.name} ${JSON.stringify(expected)}`, actual: `${actual.name} ${JSON.stringify(actual.properties)}` };
  return null;
}

/** Survey only the bounded build footprint. Unknown chunks and unsafe terrain never count as air. */
export function surveyFoundation(adapter: StateBuildingAdapter, blueprint: BuildingBlueprint, project: BuildingProject): { blueprint: BuildingBlueprint; defects: BuildingDefect[] } {
  const cells = structuredClone(blueprint.cells);
  const defects: BuildingDefect[] = [];
  for (const floor of blueprint.cells.filter((c) => c.phase === 'foundation')) {
    let supported = false;
    const added: BuildingCell[] = [];
    for (let depth = 1; depth <= blueprint.spec.maxFoundationDepth; depth++) {
      const local = { ...floor.pos, y: floor.pos.y - depth };
      const pos = rotatePosition(local, project.origin, project.rotation);
      const name = adapter.blockAt(pos);
      if (name === null || HAZARDS.has(name)) {
        defects.push({ cellId: cellKey(local), pos, kind: name === null ? 'unknown' : 'terrain', expected: '已加载、安全的承重地基', actual: name });
        break;
      }
      if (solidGround(name)) { supported = true; break; }
      // 树叶、草丛这类不承重的自然方块：挖掉换成地基
      // 火把、地毯、按钮这类薄东西也不算地基问题：拆掉就能填（以前一支火把就让整块工地被判“地基不行”，换地另起却又选回原地）
      if (!replaceable(name) && !VEGETATION.test(name) && !clearanceFixture(name)) {
        defects.push({ cellId: cellKey(local), pos, kind: 'terrain', expected: '可承重地面或可填补空隙', actual: name });
        break;
      }
      added.push({ id: cellKey(local), pos: local, name: blueprint.spec.palette.foundation, properties: {}, phase: 'foundation', tags: ['foundation_fill', 'support'], dependsOn: [] });
    }
    if (!supported) {
      if (!defects.some((d) => d.pos.x === rotatePosition(floor.pos, project.origin, project.rotation).x && d.pos.z === rotatePosition(floor.pos, project.origin, project.rotation).z)) defects.push({ cellId: floor.id, pos: rotatePosition(floor.pos, project.origin, project.rotation), kind: 'terrain', expected: `地基深度 ${blueprint.spec.maxFoundationDepth} 内有承重地面`, actual: 'void_or_unsupported' });
      continue;
    }
    added.reverse();
    for (let i = 1; i < added.length; i++) added[i].dependsOn.push(added[i - 1].id);
    if (added.length) cells.find((c) => c.id === floor.id)!.dependsOn = [added.at(-1)!.id];
    cells.push(...added);
  }
  cells.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.pos.y - b.pos.y || a.pos.z - b.pos.z || a.pos.x - b.pos.x);
  return { blueprint: { ...blueprint, cells }, defects };
}

/** Exact structural and functional inspection; there is no percentage completion threshold. */
export function inspectBuilding(adapter: StateBuildingAdapter, blueprint: BuildingBlueprint, project: BuildingProject, extra: BuildingDefect[] = []): BuildingInspection {
  const defects = [...extra];
  const state = adapter.state();
  if (!state.connected || !state.alive || !state.observationReady || state.worldId !== project.worldId || state.dim !== project.dimension) return { at: Date.now(), complete: false, checked: 0, defects: [{ cellId: 'dimension', pos: project.origin, kind: 'unknown', expected: `${project.worldId}:${project.dimension} (有效观测)`, actual: `${state.worldId}:${state.dim}` }], functions: { entry: 'unknown', shelter: 'unknown', facilities: 'unknown' } };
  for (const cell of blueprint.cells) {
    const defect = cellDefect(adapter, cell, project);
    if (defect) defects.push(defect);
  }
  let passage = true;
  for (const local of blueprint.clearances) {
    const pos = rotatePosition(local, project.origin, project.rotation);
    const name = adapter.blockAt(pos);
    if (name === null || !AIR.has(name) && !clearanceFixture(name)) {
      passage = false;
      defects.push({ cellId: `clear:${cellKey(local)}`, pos, kind: name === null ? 'unknown' : 'obstruction', expected: 'air 或可通行的薄设施（室内与入口通行空间）', actual: name });
    }
  }
  const defective = new Set(defects.map((d) => d.cellId));
  const functions: BuildingInspection['functions'] = {
    entry: passage && blueprint.cells.filter((c) => c.tags.includes('door') || c.tags.includes('threshold')).every((c) => !defective.has(c.id)) ? 'pass' : 'fail',
    shelter: blueprint.cells.filter((c) => c.tags.includes('wall') || c.tags.includes('roof') || c.tags.includes('window')).every((c) => !defective.has(c.id)) ? 'pass' : 'fail',
    facilities: blueprint.cells.filter((c) => c.phase === 'facilities').every((c) => !defective.has(c.id)) ? 'pass' : 'fail',
  };
  if (blueprint.spec.facilities.includes('torch') && blueprint.home) {
    const home = rotatePosition(blueprint.home, project.origin, project.rotation);
    const light = adapter.lightAt(home.x, home.y + 1, home.z);
    functions.lighting = light === null ? 'unknown' : light.block > 0 ? 'pass' : 'fail';
    if (functions.lighting !== 'pass') defects.push({ cellId: 'lighting', pos: home, kind: 'functional', expected: '室内实际存在方块光照', actual: light === null ? null : String(light.block) });
  }
  for (const temporary of project.temporaryBlocks ?? []) {
    const pos = rotatePosition(temporary.pos, project.origin, project.rotation), actual = adapter.blockAt(pos);
    if (actual !== 'air') defects.push({ cellId: `temporary:${cellKey(temporary.pos)}`, pos, kind: actual === null ? 'unknown' : 'obstruction', expected: '施工结束后拆除临时脚手架', actual });
  }
  return { at: Date.now(), complete: defects.length === 0, checked: blueprint.cells.length + blueprint.clearances.length, defects, functions };
}

export interface ConstructionResult {
  projectId: string;
  placed: number;
  cleared: number;
  inspection: BuildingInspection;
  missingMaterials: Record<string, number>;
  failures: { cellId: string; reason: string }[];
  scaffoldPlaced?: number;
  scaffoldRemoved?: number;
  /** 整地：清掉了什么、填了几个坑、有哪些不该动的东西挡在场地里 */
  site?: { cleared: Record<string, number>; filled: number; blocked: Record<string, number>; stowed?: string[] };
}

/**
 * 整地：像玩家盖房子前那样，先把房子占的空间里的草、花、树叶、树、凸起的土石清掉，
 * 把脚手架落脚处的小坑填上。只动自然方块（和自己插的火把）；箱子、工作台、矿石这类东西不碰，留给验收报告。
 * 有岩浆/水、未加载区块或地基太深时不整地（那是选址问题，挖了也白挖）。
 */
async function prepareSite(ctx: SkillCtx, project: BuildingProject, blueprint: BuildingBlueprint, scaffolding: BuildingCell[], check: () => void) {
  const adapter = ctx.adapter as StateBuildingAdapter;
  const spec = blueprint.spec;
  const local = new Map<string, Vec3Like>();
  const put = (p: Vec3Like) => local.set(cellKey(p), p);
  for (const c of blueprint.cells) if (c.phase !== 'foundation') put(c.pos);
  for (const c of blueprint.clearances) put(c);
  for (const c of scaffolding) put(c.pos);
  if (spec.layout === 'house') {
    const top = Math.max(...blueprint.cells.map((c) => c.pos.y));
    for (let x = 0; x < spec.width; x++) for (let z = 0; z < spec.depth; z++) for (let y = 0; y <= top; y++) put({ x, y, z });
  }
  const temp = new Map((project.temporaryBlocks ?? []).map((b) => [cellKey(b.pos), b.name]));
  const byId = new Map(blueprint.cells.map((c) => [c.id, c]));
  const clearances = new Set(blueprint.clearances.map(cellKey));
  const targets: { pos: Vec3Like; name: string; own?: string }[] = [];
  const blocked: Record<string, number> = {};
  const mine = ownStationsAt(ctx);
  const stowed: string[] = [];
  for (const [id, l] of local) {
    const pos = rotatePosition(l, project.origin, project.rotation), name = adapter.blockAt(pos);
    if (name === null || AIR.has(name)) continue;
    const cell = byId.get(id);
    if (cell && !cellDefect(adapter, cell, project)) continue; // 已经是房子的一部分
    if (!cell && clearances.has(id) && clearanceFixture(name)) continue; // 后来插的火把/铺的地毯不影响通行，保留
    if (temp.get(id) === name) continue; // 自己搭的脚手架
    if (cell && project.checkpoint.ownedCells.includes(id)) continue; // 自己放过的，交给原有流程
    if (siteClearable(name)) targets.push({ pos, name });
    else if (mine.get(cellKey(pos))?.name === name) targets.push({ pos, name, own: mine.get(cellKey(pos))!.landmarkId }); // 自己的工作台/熔炉：收起来，盖完再放
    else blocked[name] = (blocked[name] ?? 0) + 1;
  }
  const cleared: Record<string, number> = {};
  let filled = 0;
  if (targets.length) {
    // 站在房子外面干活：先离开占地范围，免得挖自己脚下
    const s = adapter.state();
    const corners = [{ x: 0, z: 0 }, { x: spec.width - 1, z: spec.depth - 1 }].map((c) => rotatePosition({ ...c, y: 0 }, project.origin, project.rotation));
    const [minX, maxX] = [Math.min(corners[0].x, corners[1].x), Math.max(corners[0].x, corners[1].x)];
    const [minZ, maxZ] = [Math.min(corners[0].z, corners[1].z), Math.max(corners[0].z, corners[1].z)];
    if (s.pos.x >= minX - 0.3 && s.pos.x <= maxX + 1.3 && s.pos.z >= minZ - 0.3 && s.pos.z <= maxZ + 1.3) {
      const front = rotatePosition({ x: Math.floor(spec.width / 2), y: 0, z: -3 }, project.origin, project.rotation);
      try { await adapter.moveTo({ kind: 'near', pos: front, range: 1 }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(15000, ctx.deadline - Date.now())) }); }
      catch (e) { if (isAbort(e)) throw e; }
      check();
    }
    // 从上往下清：先树冠树叶，再树干，最后铲平地面（避免沙砾往下掉、避免悬空）
    targets.sort((a, b) => b.pos.y - a.pos.y);
    for (const t of targets) {
      if (Date.now() >= ctx.deadline - 5000) break;
      for (let attempt = 0; attempt < 3; attempt++) {
        check();
        const name = adapter.blockAt(t.pos);
        if (name === null || AIR.has(name) || (!siteClearable(name) && !(t.own && name === t.name))) break;
        const me = adapter.state().pos;
        if (Math.floor(me.x) === t.pos.x && Math.floor(me.z) === t.pos.z && t.pos.y === Math.floor(me.y) - 1) break; // 脚下不挖
        if (Math.hypot(t.pos.x + 0.5 - me.x, t.pos.y + 0.5 - me.y, t.pos.z + 0.5 - me.z) > 4) {
          try { await adapter.moveTo({ kind: 'reach_block', pos: t.pos }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now())) }); }
          catch (e) { if (isAbort(e)) throw e; break; }
          check();
        }
        const r = await adapter.dig(t.pos, ctx.signal);
        check();
        if (!r.ok) break;
        cleared[name] = (cleared[name] ?? 0) + 1;
        if (t.own) { stowed.push(name); ctx.memory.removeLandmark?.(t.own); break; }
        if (AIR.has(adapter.blockAt(t.pos) ?? 'unknown')) break; // 没有沙砾/沙子掉下来补位
      }
      ctx.progress(0.05, `整地：清掉 ${Object.values(cleared).reduce((a, b) => a + b, 0)} 块`);
    }
    try { await adapter.collectNearbyDrops?.(ctx.signal, 8, 3000); } catch (e) { if (isAbort(e)) throw e; }
  }
  // 脚手架落脚处的小坑（3 格以内）用地基材料填上
  const seen = new Set<string>();
  for (const c of scaffolding.filter((x) => x.pos.y === 0)) {
    const top = rotatePosition({ ...c.pos, y: -1 }, project.origin, project.rotation);
    if (seen.has(`${top.x},${top.z}`)) continue;
    seen.add(`${top.x},${top.z}`);
    const holes: Vec3Like[] = [];
    let ok = false;
    for (let d = 0; d < 4; d++) {
      const p = { ...top, y: top.y - d }, n = adapter.blockAt(p);
      if (n === null || HAZARDS.has(n)) break;
      if (solidGround(n)) { ok = true; break; }
      if (!replaceable(n)) break;
      holes.push(p);
    }
    if (!ok || !holes.length) continue;
    for (const p of holes.reverse()) {
      check();
      // 填坑优先用整地铲下来的泥土等“多余”方块；只用预留之外、扣掉房子还要用的量之后剩下的（不抢墙和地基的料）
      const avail = new Map<string, number>();
      for (const i of availableInventoryFor(ctx.memory, adapter.state())) avail.set(i.name, (avail.get(i.name) ?? 0) + i.count);
      const stillNeeded = materialCost([...blueprint.cells.filter((c) => cellDefect(adapter, c, project)), ...scaffolding]);
      const filler = [...FILLERS, spec.palette.foundation].find((n) => (avail.get(n) ?? 0) - (stillNeeded[n] ?? 0) > 0);
      if (!filler) break;
      if (PLANTS.has(adapter.blockAt(p) ?? '')) await adapter.dig(p, ctx.signal);
      try { await adapter.moveTo({ kind: 'place_block', pos: p }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now())) }); }
      catch (e) { if (isAbort(e)) throw e; break; }
      const r = await adapter.placeBlockAt(p, [filler], ctx.signal);
      check();
      if (r.ok && adapter.blockAt(p) === filler) filled++; else break;
    }
  }
  return { cleared, filled, blocked, ...(stowed.length ? { stowed } : {}) };
}

/** Idempotent construction/repair: every resumed run reconciles the live world first. */
export async function constructBuilding(ctx: SkillCtx, archive: BuildingArchive, project: BuildingProject, source: BuildingBlueprint, mode: 'build' | 'inspect' | 'repair'): Promise<ConstructionResult> {
  const adapter = ctx.adapter as StateBuildingAdapter;
  throwIfAborted(ctx.signal);
  const startState = adapter.state();
  if (startState.dim !== project.dimension || startState.worldId !== project.worldId) return { projectId: project.id, placed: 0, cleared: 0, inspection: inspectBuilding(adapter, source, project), missingMaterials: {}, failures: [{ cellId: 'dimension', reason: 'WRONG_DIMENSION' }] };
  if (!startState.connected || !startState.alive) throw new Error('NOT_CONNECTED');
  if (!startState.observationReady) throw new Error('OBSERVATION_NOT_READY');
  const session = startState.sessionId;
  const checkSession = () => {
    throwIfAborted(ctx.signal);
    const current = adapter.state();
    if (!current.observationReady || current.sessionId !== session || current.worldId !== project.worldId || current.dim !== project.dimension) throw new AbortedError('建筑现场观测会话已改变');
  };
  // Local surveying is an explicit construction action, not a global resource search.
  if (Math.hypot(adapter.state().pos.x - project.origin.x, adapter.state().pos.y - project.origin.y, adapter.state().pos.z - project.origin.z) > 20) {
    if (mode === 'inspect') return { projectId: project.id, placed: 0, cleared: 0, inspection: { at: Date.now(), complete: false, checked: 0, defects: [{ cellId: 'site', pos: project.origin, kind: 'unknown', expected: '在现场检查建筑', actual: 'out_of_survey_range' }], functions: {} }, missingMaterials: {}, failures: [] };
    await adapter.moveTo({ kind: 'near', pos: project.origin, range: 4 }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(30000, ctx.deadline - Date.now())) });
    checkSession();
  }
  if (project.pendingPlacement) {
    checkSession();
    const pending = project.pendingPlacement;
    const actual = adapter.blockAt(rotatePosition(pending.pos, project.origin, project.rotation));
    if (actual === null) throw new Error('BUILD_PENDING_OBSERVATION_UNKNOWN:保留上次待核实的放置意图，等待现场区块加载');
    if (actual === pending.name) {
      if (pending.kind === 'temporary') archive.temporary(project.id, { pos: pending.pos, name: pending.name });
      else if (pending.cellId) archive.checkpoint(project.id, source.cells.find((c) => c.id === pending.cellId)?.phase ?? 'enclosure', pending.cellId, '续建时通过现场观测确认上次待核实的放置');
    }
    archive.pending(project.id, null);
    project = archive.get(project.id)!;
  }
  // Revised designs also inspect and remove obsolete owned parts; a flat roof cannot pass
  // while an old gable is silently left above the newly selected blueprint.
  const currentIds = new Set(source.cells.map((c) => c.id));
  const retired = project.checkpoint.ownedCells.filter((id) => !currentIds.has(id) && /^-?\d+,-?\d+,-?\d+$/.test(id));
  source = { ...source, clearances: [...source.clearances, ...retired.map((id) => { const [x, y, z] = id.split(',').map(Number); return { x, y, z }; })] };
  // 先整地，再勘察：坡地、树、草丛本来就该先清掉，而不是直接判“场地有缺陷”
  let site: ConstructionResult['site'];
  if (mode !== 'inspect') {
    const pre = surveyFoundation(adapter, source, project);
    if (mode === 'repair') {
      const inspection = inspectBuilding(adapter, pre.blueprint, project, pre.defects);
      checkSession();
      if (inspection.complete) {
        archive.inspect(project.id, inspection);
        return { projectId: project.id, placed: 0, cleared: 0, inspection, missingMaterials: {}, failures: [] };
      }
    }
    if (!pre.defects.length) {
      site = await prepareSite(ctx, project, pre.blueprint, planScaffolding(pre.blueprint), checkSession);
      project = archive.get(project.id) ?? project;
    }
  }
  const survey = surveyFoundation(adapter, source, project);
  const blueprint = survey.blueprint;
  const doors = blueprint.cells.filter((cell) => cell.name.endsWith('_door') && cell.properties.half === 'lower');
  // An access state is temporary during engineering. The original exact blueprint
  // is still the final acceptance contract, including its requested open value.
  const workBlueprint = { ...blueprint, cells: blueprint.cells.map((cell) => {
    if (!cell.name.endsWith('_door')) return cell;
    const properties = { ...cell.properties }; delete properties.open;
    return { ...cell, properties };
  }) };
  const workById = new Map(workBlueprint.cells.map((cell) => [cell.id, cell]));
  const workDefect = (cell: BuildingCell) => cellDefect(adapter, workById.get(cell.id) ?? cell, project);
  const setDoorOpen = async (cell: BuildingCell, open: boolean) => {
    checkSession();
    const pos = rotatePosition(cell.pos, project.origin, project.rotation), actual = actualState(adapter, pos);
    if (actual?.name !== cell.name) return false;
    if (String(actual.properties.open) === String(open)) return true;
    if (!adapter.useBlockAt) throw new Error('MISSING_CAPABILITY:useBlockAt (门的实际开关)');
    const action = await adapter.useBlockAt(pos, '', ctx.signal);
    checkSession();
    if (!action.ok) return false;
    // activateBlock resolves when the packet is sent, before the server's block update.
    // Observe the resulting state rather than immediately toggling again on stale data.
    for (let retry = 0; retry < 20; retry++) {
      checkSession();
      if (String(actualState(adapter, pos)?.properties.open) === String(open)) return true;
      if (Date.now() >= ctx.deadline - 1000) break;
      await sleep(50, ctx.signal);
    }
    return false;
  };
  const initial = inspectBuilding(adapter, blueprint, project, survey.defects);
  const result: ConstructionResult = { projectId: project.id, placed: 0, cleared: site ? Object.values(site.cleared).reduce((a, b) => a + b, 0) : 0, inspection: initial, missingMaterials: {}, failures: [], ...(site ? { site } : {}) };
  const finish = async () => {
    checkSession();
    for (const door of doors) if (mode !== 'inspect' && door.properties.open !== undefined && Date.now() < ctx.deadline - 1000 && actualState(adapter, rotatePosition(door.pos, project.origin, project.rotation))?.name === door.name) {
      try { if (!await setDoorOpen(door, String(door.properties.open) === 'true')) result.failures.push({ cellId: door.id, reason: 'DOOR_ACCESS_STATE_NOT_RESTORED' }); }
      catch (error) { if (isAbort(error)) throw error; result.failures.push({ cellId: door.id, reason: (error as Error).message }); }
    }
    result.inspection = inspectBuilding(adapter, blueprint, archive.get(project.id) ?? project, survey.defects);
    archive.inspect(project.id, result.inspection);
    return result;
  };
  if (mode === 'inspect' || survey.defects.length) return finish();
  const structural = () => inspectBuilding(adapter, workBlueprint, { ...project, temporaryBlocks: [] }, survey.defects);
  if (structural().complete) {
    result.scaffoldRemoved = await removeScaffolding(ctx, archive, project, checkSession);
    return finish();
  }
  const scaffolding = planScaffolding(blueprint);
  let siteDefects = inspectScaffoldSite(adapter, scaffolding, project);
  // 脚手架位置上的草丛、花、树叶、凸起的自然土石：顺手清掉再看，而不是因为一丛草就整栋不盖
  const removable = siteDefects.filter((d) => d.kind === 'obstruction' && d.actual && (PLANTS.has(d.actual) || siteClearable(d.actual)));
  if (removable.length && removable.length === siteDefects.filter((d) => d.kind === 'obstruction').length) {
    for (const d of removable) {
      if (Date.now() >= ctx.deadline - 5000) break;
      try {
        const me = adapter.state().pos;
        if (Math.floor(me.x) === d.pos.x && Math.floor(me.z) === d.pos.z && Math.floor(me.y) - 1 === d.pos.y) continue; // 脚下不挖
        if (Math.hypot(d.pos.x + 0.5 - me.x, d.pos.y + 0.5 - me.y, d.pos.z + 0.5 - me.z) > 4) {
          await adapter.moveTo({ kind: 'reach_block', pos: d.pos }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(10000, ctx.deadline - Date.now())) });
          checkSession();
        }
        const r = await adapter.dig(d.pos, ctx.signal);
        checkSession();
        if (r.ok && AIR.has(adapter.blockAt(d.pos) ?? 'unknown')) result.cleared++;
      } catch (error) { if (isAbort(error)) throw error; }
    }
    siteDefects = inspectScaffoldSite(adapter, scaffolding, project);
  }
  if (siteDefects.length) {
    survey.defects.push(...siteDefects);
    result.failures.push({ cellId: 'scaffolding', reason: `脚手架位置被占：${[...new Set(siteDefects.map((d) => `${d.actual ?? '看不清'}@${d.pos.x},${d.pos.y},${d.pos.z}`))].slice(0, 3).join('、')}` });
    return finish();
  }
  const totalCost = materialCost([...blueprint.cells, ...scaffolding]);
  archive.actualMaterialEstimate(project.id, totalCost);
  if (Object.values(totalCost).reduce((a, b) => a + b, 0) > blueprint.spec.budget) {
    result.failures.push({ cellId: 'budget', reason: `设计及地基超过预算 ${blueprint.spec.budget}` });
    return finish();
  }
  const unsupported = blueprint.cells.filter((c) => Object.keys(c.properties).length && (!adapter.blockStateAt || !adapter.placeBlockStateAt || doors.length && !adapter.useBlockAt));
  if (unsupported.length) {
    result.failures.push({ cellId: unsupported[0].id, reason: 'MISSING_CAPABILITY:blockStateAt/placeBlockStateAt' });
    return finish();
  }
  const needsPlacement = (cell: BuildingCell) => workDefect(cell) || blueprint.cells.some((c) => c.placedBy === cell.id && workDefect(c));
  const scaffoldTodo = scaffolding.filter((c) => {
    const previous = project.temporaryBlocks.find((b) => cellKey(b.pos) === cellKey(c.pos));
    return !previous || adapter.blockAt(rotatePosition(c.pos, project.origin, project.rotation)) !== previous.name;
  });
  const need = materialCost([...blueprint.cells.filter((c) => !c.placedBy && needsPlacement(c)), ...scaffoldTodo]);
  const inv = new Map(availableInventoryFor(ctx.memory, adapter.state()).map((i) => [i.name, i.count]));
  // 同形状的别种木头也算（缺云杉木板时橡木木板顶得上）；先满足同名的需求，剩下的才拿去顶
  const spare = new Map(inv);
  for (const [name, count] of Object.entries(need)) spare.set(name, (spare.get(name) ?? 0) - count);
  for (const [name, count] of Object.entries(need)) {
    let short = count - (inv.get(name) ?? 0);
    if (short > 0 && woodShape(name)) for (const [other, left] of spare) {
      if (short <= 0) break;
      if (other === name || left <= 0 || !sameMaterial(other, name)) continue;
      const take = Math.min(short, left); short -= take; spare.set(other, left - take);
    }
    if (short > 0) result.missingMaterials[name] = short;
  }
  // 像玩家一样有多少料先盖多少：墙基、墙身先起来，缺的那几样（玻璃、灯笼、楼梯……）留着以后补。
  // 只有一块都放不了（手上的料一样都用不上）时才直接收工
  const placeable = Object.keys(need).some((name) => [...inv].some(([n, c]) => c > 0 && sameMaterial(n, name)));
  if (Object.keys(result.missingMaterials).length && !placeable) return finish();
  // 只用自己能用的料（别的工程预留的不动），边放边扣
  const avail = new Map(inv);
  const have = (name: string) => (avail.get(name) ?? 0) > 0 && adapter.state().inventory.some((i) => i.name === name && i.count > 0);
  const outOf = new Set<string>();
  for (const door of doors) if (actualState(adapter, rotatePosition(door.pos, project.origin, project.rotation))?.name === door.name) await setDoorOpen(door, true);
  // 料不全时：脚手架的料也不够就先不搭（够得着的低处照样盖），够就搭上并从可用料里扣掉
  const scaffoldCost = materialCost(scaffoldTodo);
  const scaffoldOk = Object.entries(scaffoldCost).every(([n, c]) => (avail.get(n) ?? 0) >= c);
  if (scaffoldOk) for (const [n, c] of Object.entries(scaffoldCost)) avail.set(n, (avail.get(n) ?? 0) - c);
  if (scaffoldOk) try { result.scaffoldPlaced = await erectScaffolding(ctx, archive, project, scaffolding, checkSession); }
  catch (error) { if (isAbort(error)) throw error; result.failures.push({ cellId: 'scaffolding', reason: (error as Error).message }); return finish(); }
  const owned = new Set(project.checkpoint.ownedCells);
  const near = async (pos: Vec3Like, placement = false) => {
    checkSession();
    const s = adapter.state();
    if (placement || Math.hypot(pos.x + 0.5 - s.pos.x, pos.y - s.pos.y, pos.z + 0.5 - s.pos.z) > 3) {
      const moveOptions = () => ({ signal: ctx.signal, timeoutMs: Math.max(1, Math.min(15000, ctx.deadline - Date.now())) });
      try { await adapter.moveTo({ kind: placement ? 'place_block' : 'reach_block', pos }, moveOptions()); }
      catch (error) {
        if (isAbort(error) || !placement || blueprint.spec.layout !== 'house' || pos.y < project.origin.y + 2) throw error;
        checkSession();
        // A placement heuristic can exhaust ground-level approaches without
        // discovering the completed stairway. Explicitly use our observed,
        // recorded access bridge before one bounded upper-work retry.
        const summit = rotatePosition({ x: -1, y: blueprint.spec.height, z: 0 }, project.origin, project.rotation);
        if (adapter.blockAt(summit) !== blueprint.spec.palette.foundation || !(archive.get(project.id)?.temporaryBlocks ?? []).some((block) => cellKey(block.pos) === `-1,${blueprint.spec.height},0`)) throw error;
        const stand = { x: summit.x + 0.5, y: summit.y + 1, z: summit.z + 0.5 };
        try { await adapter.moveTo({ kind: 'near', pos: stand, range: 0.4 }, moveOptions()); }
        catch (accessError) { if (isAbort(accessError)) throw accessError; throw new Error(`SCAFFOLD_SUMMIT_UNREACHABLE:${(accessError as Error).message}`); }
        checkSession();
        const reached = adapter.state().pos;
        if (Math.hypot(reached.x - stand.x, reached.z - stand.z) > 1.2 || Math.abs(reached.y - stand.y) > 0.8) throw new Error('SCAFFOLD_SUMMIT_NOT_REACHED');
        await adapter.moveTo({ kind: 'place_block', pos }, moveOptions());
      }
    }
    checkSession();
  };
  const clear = async (pos: Vec3Like, id: string, foundation = false) => {
    const name = adapter.blockAt(pos);
    if (name === null || HAZARDS.has(name)) return false;
    if (AIR.has(name)) return true;
    if (!PLANTS.has(name) && !(foundation && NATURAL_GROUND.has(name)) && !siteClearable(name) && !owned.has(id)) return false;
    // Never excavate under the bot; choose a safe standing position through voxel navigation first.
    let s = adapter.state();
    if (Math.floor(s.pos.x) === pos.x && Math.floor(s.pos.z) === pos.z && Math.floor(s.pos.y) - 1 === pos.y) {
      await adapter.moveTo({ kind: 'near', pos: { x: pos.x + 2, y: s.pos.y, z: pos.z }, range: 0.5 }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(10000, ctx.deadline - Date.now())) });
      s = adapter.state();
      if (Math.floor(s.pos.x) === pos.x && Math.floor(s.pos.z) === pos.z) return false;
    }
    await near(pos);
    const action = await adapter.dig(pos, ctx.signal);
    checkSession();
    if (action.ok && AIR.has(adapter.blockAt(pos) ?? 'unknown')) { result.cleared++; return true; }
    return false;
  };
  // Clear only vegetation or project-owned obsolete structure, never arbitrary valuables.
  for (const local of blueprint.clearances) {
    if (Date.now() >= ctx.deadline - 1000) break;
    const pos = rotatePosition(local, project.origin, project.rotation);
    const name = adapter.blockAt(pos);
    if (name !== null && clearanceFixture(name)) {
      if (retired.includes(cellKey(local))) archive.releaseCell(project.id, cellKey(local));
      continue;
    }
    if (!await clear(pos, cellKey(local))) result.failures.push({ cellId: `clear:${cellKey(local)}`, reason: `OBSTRUCTED_PASSAGE @ (${pos.x},${pos.y},${pos.z}): expected=可通行空间, actual=${name ?? 'unknown'}；先确认该格方块归属再定点处理` });
    else if (retired.includes(cellKey(local))) archive.releaseCell(project.id, cellKey(local));
  }
  const byId = new Map(blueprint.cells.map((c) => [c.id, c]));
  // Multiple passes resolve dependencies spanning phases (e.g. windows beneath a lintel).
  for (let pass = 0; pass <= blueprint.cells.length; pass++) {
    let progress = false;
    for (const cell of blueprint.cells) {
      throwIfAborted(ctx.signal);
      if (Date.now() >= ctx.deadline - 1000) return finish();
      if (!needsPlacement(cell) || cell.placedBy) continue;
      if (cell.dependsOn.some((id) => byId.has(id) && workDefect(byId.get(id)!))) continue;
      // 这一格的料用完了/没有：换同形状的别种木头顶上；也没有就先跳过，盖别的
      let use = cell.name;
      if (outOf.has(use) || !have(use)) {
        outOf.add(cell.name);
        const sub = woodShape(cell.name) ? [...avail.keys()].find((n) => n !== cell.name && sameMaterial(n, cell.name) && have(n)) : undefined;
        if (!sub) continue;
        use = sub;
      }
      const pos = rotatePosition(cell.pos, project.origin, project.rotation);
      try {
        // A damaged two-block door is repaired as one item, including a surviving upper half.
        for (const auto of blueprint.cells.filter((c) => c.placedBy === cell.id)) {
          const autoPos = rotatePosition(auto.pos, project.origin, project.rotation);
          const autoName = adapter.blockAt(autoPos);
          if (autoName !== null && !AIR.has(autoName) && !await clear(autoPos, auto.id)) {
            result.failures.push({ cellId: auto.id, reason: 'PAIRED_BLOCK_OBSTRUCTED' });
            continue;
          }
        }
        const previous = adapter.blockAt(pos);
        if (previous === null) continue;
        if (!replaceable(previous) && !await clear(pos, cell.id, cell.phase === 'foundation')) { result.failures.push({ cellId: cell.id, reason: 'OBSTRUCTION_NOT_OWNED' }); continue; }
        if (PLANTS.has(previous) && !await clear(pos, cell.id)) continue;
        await near(pos, true);
        archive.pending(project.id, { kind: 'permanent', pos: cell.pos, name: cell.name, cellId: cell.id });
        const action = Object.keys(cell.properties).length
          ? await adapter.placeBlockStateAt!(pos, use, rotateProperties(cell.properties, project.rotation), ctx.signal)
          : await adapter.placeBlockAt(pos, [use], ctx.signal);
        checkSession();
        if (!action.ok || cellDefect(adapter, cell, project)) {
          result.failures.push({ cellId: cell.id, reason: action.reason ?? 'PLACEMENT_NOT_VERIFIED' });
          archive.pending(project.id, null);
          if (action.reason === 'NO_ITEM') outOf.add(use);
          continue;
        }
        result.placed++; progress = true; owned.add(cell.id);
        avail.set(use, (avail.get(use) ?? 0) - 1);
        archive.checkpoint(project.id, cell.phase, cell.id, `已核实 ${cell.name} @ ${cell.id}`);
        archive.pending(project.id, null);
        for (const auto of blueprint.cells.filter((c) => c.placedBy === cell.id)) if (!cellDefect(adapter, auto, project)) { owned.add(auto.id); archive.checkpoint(project.id, auto.phase, auto.id, '已核实自动生成的配对方块'); }
        if (doors.some((door) => door.id === cell.id)) await setDoorOpen(cell, true);
        ctx.progress(1 - inspectBuilding(adapter, blueprint, project).defects.length / Math.max(1, blueprint.cells.length + blueprint.clearances.length), `${cell.phase}: ${result.placed} 块已核实`);
      } catch (error) {
        if (isAbort(error)) throw error;
        result.failures.push({ cellId: cell.id, reason: `${codeFromError(error)}:${(error as Error).message}` });
        if (codeFromError(error) === 'NOT_CONNECTED' || /WRONG_DIMENSION/.test((error as Error).message)) return finish();
      }
    }
    if (!progress) break;
  }
  if (structural().complete) {
    try { result.scaffoldRemoved = await removeScaffolding(ctx, archive, project, checkSession); }
    catch (error) { if (isAbort(error)) throw error; result.failures.push({ cellId: 'scaffolding', reason: (error as Error).message }); }
  }
  return finish();
}
