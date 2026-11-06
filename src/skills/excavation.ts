import minecraftData from 'minecraft-data';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { bodyCells, bodyProbe, estimatedFallDamage, footSurfaceY, isReplaceable, shapeKnown, supportTop, type ObservedState, type StateAt } from '../perception/geometry.ts';
import { codeFromError, fail, isAbort, obj, ok, type FailureCode, type Skill, type SkillCtx } from './types.ts';
import { placeAt } from './primitives.ts';
import { EXCAVATION_WAYPOINT_CAP } from '../memory/store.ts';

export interface ExcavationArgs {
  entry: string;
  mode: 'stairs' | 'stairs_up' | 'tunnel';
  direction: 'north' | 'east' | 'south' | 'west';
  steps: number;
  /** Agent 明确选择的本轮主手工具（物品注册名）；不给时沿用身体现有的换工具规则 */
  tool?: string;
  /** Agent 明确授权用哪种方块补下一级支撑（会消耗材料）；不给则不补，遇空支撑停下并报缺口。 */
  fill?: string;
}

const registry = minecraftData(config.mc.version);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['water', 'lava', 'bubble_column', 'powder_snow', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'cobweb', 'pointed_dripstone']);
const PROTECTED = new Set(['end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway', 'chest', 'trapped_chest', 'barrel', 'spawner', 'crafting_table', 'furnace', 'blast_furnace', 'smoker']);
/** 传送门方块：软块（薄片、可穿过），不是「半砖/台阶」这类能站但不稳的方块，也不是液体/坑 */
const PORTAL_BLOCKS = new Set(['nether_portal', 'end_portal', 'end_gateway']);
const DIRECTIONS = { north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 } };
const FACING = { north: 'N', east: 'E', south: 'S', west: 'W' } as const;
const YAW = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };
export const EXCAVATION_ENTRY_LABEL = '实际开挖入口';
export const EXCAVATION_CHECKPOINT_LABEL = '实际开挖进度';
export const EYE_DESCENT_LABEL = '末影之眼下降搜索点';

const falling = (name: string) => ['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'dragon_egg', 'anvil', 'chipped_anvil', 'damaged_anvil'].includes(name) || name.endsWith('_concrete_powder');
const hazard = (name: string) => HAZARDS.has(name) || falling(name) || name.startsWith('infested_');
/** 危险方块的类型，决定 hint 是「避液体」还是「堵下落」还是只报名字 */
const hazardLabel = (name: string) => name === 'water' || name === 'lava' || name === 'bubble_column' ? '液体' : falling(name) ? '下落方块' : '危险方块';
const voxel = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });

interface BelowSupport { at: Vec3Like; foot: number; drop: number; block: string }
interface BelowScan { found: BelowSupport | null; unknownAt: Vec3Like | null; hazardAt: { at: Vec3Like; name: string } | null; scanned: number }

class ExcavationStop extends Error {
  /** 下一落点没有支撑时带上该落点，供失败回执附可见落点事实，而不是只给一句硬错误 */
  nextLanding?: Vec3Like;
  /** 缺口下方实际能站的第一处支撑；没有就保留检查深度/未知位置，不把 air 当成“无限深”。 */
  below?: BelowScan;
  constructor(public code: FailureCode, message: string, public unsupportedGeometry = false) { super(message); }
}

/** 读当前方块状态：适配器提供 blockstate 时用真实状态；只有名字时碰撞形状按“未确认”处理，不拿默认状态冒充。 */
const stateAt = (adapter: SkillCtx['adapter']): StateAt => (pos) => {
  const state = adapter.blockStateAt?.(pos);
  if (state?.name) return state;
  const name = adapter.blockAt(pos);
  return name === null ? null : { name, properties: {} };
};

/** 从某个脚高向下找第一处可站立支撑；给出精确落差，而不是只说“下面是空气”。 */
function scanSupportBelow(ctx: SkillCtx, fromFoot: Vec3Like, maxDepth = 64): BelowScan {
  const at = stateAt(ctx.adapter);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const pos = { x: fromFoot.x, y: fromFoot.y - depth, z: fromFoot.z };
    const state = at(pos);
    if (!state) return { found: null, unknownAt: pos, hazardAt: null, scanned: depth };
    if (hazard(state.name)) return { found: null, unknownAt: null, hazardAt: { at: pos, name: state.name }, scanned: depth };
    const top = supportTop(state.name, state.properties ?? {});
    if (top !== null) {
      const foot = pos.y + top;
      return { found: { at: pos, foot, drop: fromFoot.y - foot, block: state.name }, unknownAt: null, hazardAt: null, scanned: depth };
    }
  }
  return { found: null, unknownAt: null, hazardAt: null, scanned: maxDepth };
}

/**
 * 落点支撑判定：用与 step 相同的碰撞顶面，而不是方块名猜“整块/不完整”。
 * 支撑面必须等于本次要落到的脚高；半格顶面会报出实际高度并明确“整格开挖未实现半格转换”，
 * 不再说游戏里“半砖站不稳”。未知/未加载单独返回，不当作空气。
 */
function supportProblem(ctx: SkillCtx, cell: Vec3Like, expectedFoot: number, label: string): ExcavationStop | null {
  const state: ObservedState | null = stateAt(ctx.adapter)(cell);
  const at = `(${cell.x},${cell.y},${cell.z})`;
  const landing = `(${cell.x},${expectedFoot},${cell.z})`;
  if (state === null) return new ExcavationStop('NOT_FOUND', `${label}${landing}的支撑格 ${at} 未加载/未知，不能确认支撑`);
  if (hazard(state.name)) return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}（${hazardLabel(state.name)}），不能冒险下落`);
  if (PORTAL_BLOCKS.has(state.name)) return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}（传送门，不能承重），不能作为站立支撑`);
  if (!shapeKnown(state.name, state.properties ?? {})) return new ExcavationStop('NOT_FOUND', `${label}${landing}的支撑格 ${at} 是 ${state.name}，状态未确认（缺少 blockstate），不能确认支撑顶面`);
  const top = supportTop(state.name, state.properties ?? {});
  if (top === null) {
    if (AIR.has(state.name)) {
      const below = scanSupportBelow(ctx, { ...cell, y: expectedFoot });
      // 脚面高度和方块格坐标分开写：以前把 foot 高度填进 (x,foot,z)，和“支撑格是 air”并列时
      // 看起来像同一格既空又有方块，调用方会转而手工补支撑。
      const where = below.found
        ? `向下 ${below.found.drop.toFixed(Number.isInteger(below.found.drop) ? 0 : 2)} 格到可站立脚面 y=${below.found.foot.toFixed(2)}（方块 ${below.found.block} 在 (${below.found.at.x},${below.found.at.y},${below.found.at.z})）`
        : below.unknownAt
          ? `向下 ${below.scanned} 格到 (${below.unknownAt.x},${below.unknownAt.y},${below.unknownAt.z}) 起未加载/未知`
          : below.hazardAt
            ? `向下 ${below.scanned} 格是 ${below.hazardAt.name}（${hazardLabel(below.hazardAt.name)}）`
            : '向下 64 格没有已加载的可站立面';
      const damage = below.found ? estimatedFallDamage(below.found.drop) : 0;
      const gap = new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}：下一落点下面是空的，${where}${damage ? `；落差约 ${below.found!.drop.toFixed(Number.isInteger(below.found!.drop) ? 0 : 2)} 格，按当前生命预计约 ${damage} 点摔伤（未计护甲/摔落保护）` : ''}`);
      gap.nextLanding = { ...cell, y: expectedFoot };
      gap.below = below;
      return gap;
    }
    return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}，没有水平承重顶面，不能作为落点支撑`);
  }
  const surface = cell.y + top;
  if (Math.abs(surface - expectedFoot) > 0.01) {
    return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 支撑面在 y=${surface.toFixed(2)}（${state.name}），与期望脚高 y=${expectedFoot.toFixed(2)} 不符；当前整格开挖未实现半格/非整块脚高转换`, true);
  }
  return null;
}

function assertSession(ctx: SkillCtx, origin: AgentState) {
  throwIfAborted(ctx.signal);
  const state = ctx.adapter.state();
  if (state.worldId !== origin.worldId || state.dim !== origin.dim || state.sessionId !== origin.sessionId) throw new AbortedError('excavation observation session changed');
  if (!state.connected || !state.alive || !state.observationReady) throw new ExcavationStop('NOT_CONNECTED', '没有有效的当前世界观测，停止开挖');
  if (state.inWater || state.inLava || state.oxygen < 18) throw new ExcavationStop('ERROR', '当前位置不再干燥或空气不足，停止开挖');
  if (Date.now() >= ctx.deadline) throw new ExcavationStop('TIMEOUT', '本次有界开挖时间已用完');
  return state;
}

function standingCell(ctx: SkillCtx, feet: Vec3Like) {
  const states = stateAt(ctx.adapter);
  const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.05), z: Math.floor(feet.z) };
  const surface = footSurfaceY(cell, states);
  if (surface === null) {
    const below = states({ ...cell, y: cell.y - 1 });
    if (below === null) throw new ExcavationStop('NOT_FOUND', '落点支撑未加载/未知，不能确认支撑');
    throw new ExcavationStop('ERROR', `落点脚下是 ${below.name}，没有已确认的承重顶面`);
  }
  if (Math.abs(surface - feet.y) > 0.01) {
    throw new ExcavationStop('ERROR', `落点支撑面在 y=${surface.toFixed(2)}，与脚高 y=${feet.y.toFixed(2)} 不符，没有把身体当成站稳`, true);
  }
  const probe = bodyProbe(feet.y, cell.x, cell.z, states);
  if (probe.unknown.length) throw new ExcavationStop('NOT_FOUND', '落点身体空间未加载/未知，不能确认两格干燥身体空间');
  for (const pos of bodyCells(feet.y, cell.x, cell.z)) {
    const state = states(pos);
    if (state && hazard(state.name)) throw new ExcavationStop('ERROR', `落点身体空间是 ${state.name}（${hazardLabel(state.name)}）`);
  }
  if (probe.blockers.length) throw new ExcavationStop('ERROR', '落点没有已确认的两格干燥身体空间');
}

/** Only this adjacent work column and its touching hazard boundaries are read.
 * These reads never discover structures or choose an underground direction. */
function preflightColumn(ctx: SkillCtx, feet: Vec3Like, height: number, tool?: string) {
  const { adapter } = ctx;
  const cells = Array.from({ length: height }, (_, level) => ({ ...feet, y: feet.y + level }));
  for (const pos of cells) {
    const name = adapter.blockAt(pos);
    if (name === null) throw new ExcavationStop('NOT_FOUND', '局部工作面未加载/未知');
    if (hazard(name)) throw new ExcavationStop('ERROR', `局部工作面是 ${name}（${hazardLabel(name)}）`);
    if (!AIR.has(name)) {
      const block = registry.blocksByName[name];
      // 工作面只要求「可挖、非保护、非危险」：火把/梯子/告示牌这类透明方块不是完整立方，却一样能瞬挖通过，
      // 不能再拿整块判定（完整立方）去卡它，否则 agent 自己插的火把会反过来堵死开挖通道
      if (PROTECTED.has(name) || name.endsWith('_bed') || !block?.diggable || !Number.isFinite(block.hardness) || block.hardness! < 0) throw new ExcavationStop('ERROR', `工作面 ${name} 不能作为普通安全通道挖除`);
      // 指定了工具：每一格都必须能用这件工具挖；哪一格挖不了就报哪一格，不自动改用别的工具
      if (tool) {
        if (adapter.digTimeEstimate(name, tool) === null) throw new ExcavationStop('TOOL_MISSING', `指定的 ${tool} 挖不了工作格 (${pos.x},${pos.y},${pos.z}) 的 ${name}`);
      } else {
        const tools = Object.keys(block.harvestTools ?? {});
        const held = adapter.state().inventory.some((item) => item.count > 0 && tools.includes(String(registry.itemsByName[item.name]?.id)));
        if (!adapter.canHarvest(pos) || tools.length && !held) throw new ExcavationStop('TOOL_MISSING', `缺少实际可采掘 ${name} 的工具`);
      }
    }
    for (const offset of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }]) {
      const neighbor = adapter.blockAt({ x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z });
      if (neighbor === null) throw new ExcavationStop('NOT_FOUND', '紧邻开挖面的方块未加载/未知');
      if (hazard(neighbor)) throw new ExcavationStop('ERROR', `紧邻开挖面是 ${neighbor}（${hazardLabel(neighbor)}）`);
    }
  }
  return cells;
}

/** 下一落点没支撑时的只读缺口：把当前可见的较低落点原样列出，不选择、不自动垫/挖/下落。 */
function cavityGap(ctx: SkillCtx, nextLanding: Vec3Like, below = scanSupportBelow(ctx, nextLanding), fillTried = false) {
  const options = ctx.senses.landingOptions?.(12) ?? [];
  const distance = (target: Vec3Like) => Math.hypot(target.x - nextLanding.x, target.y - nextLanding.y, target.z - nextLanding.z);
  return {
    reason: 'next_landing_support_air',
    nextLanding: { ...nextLanding },
    supportCell: { x: nextLanding.x, y: nextLanding.y - 1, z: nextLanding.z },
    ...(below.found ? {
      fall: { drop: below.found.drop, landing: { x: below.found.at.x, y: below.found.foot, z: below.found.at.z }, block: below.found.block, damage: estimatedFallDamage(below.found.drop) },
    } : { fallScan: { checked: below.scanned, unknownAt: below.unknownAt, hazardAt: below.hazardAt } }),
    visibleLandings: options
      .map((o) => ({ target: { ...o.target }, surface: o.surface, drop: o.drop, clearance: o.clearance, corridor: o.corridor, approach: o.approach, unknowns: o.unknowns }))
      .sort((a, b) => distance(a.target) - distance(b.target))
      .slice(0, 5),
    handoff: `可见落点需由 assess_landings 明确选择；确认支撑与净空后可用 descend 选落点（落体通道未看清时可显式 allowUnknownCorridor），也可 place_at 补支撑或换方向；${fillTried ? '已按 fill 授权尝试补支撑，没成，缺口仍在' : '本次没有自动垫方块'}；只有 stairs 下行会对安全整格落差 1..4 格自动继续，stairs_up/tunnel 需要你补支撑或换方向`,
  };
}

export function trustedExcavationEntry(ctx: SkillCtx, id: string, strongholdOnly = false) {
  const state = ctx.adapter.state();
  const entry = ctx.memory.landmarks().find((landmark) => landmark.id === id && landmark.dim === state.dim && landmark.worldId === state.worldId);
  if (!entry || entry.kind !== 'waypoint') return undefined;
  if (strongholdOnly && ![EYE_DESCENT_LABEL, EXCAVATION_ENTRY_LABEL, EXCAVATION_CHECKPOINT_LABEL].some((label) => entry.label.startsWith(label))) return undefined;
  return entry;
}

/** 开挖入口/进度恢复点只留最近几个：每次开挖都净增两条，不清理会无限堆积、挤占地标容量 */
function pruneExcavationWaypoints(ctx: SkillCtx) {
  const dim = ctx.adapter.state().dim;
  const waypoints = ctx.memory.landmarks().filter((l) => l.kind === 'waypoint' && l.dim === dim
    && (l.label === EXCAVATION_ENTRY_LABEL || l.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)));
  const stale = waypoints.sort((a, b) => a.ts - b.ts).slice(0, Math.max(0, waypoints.length - EXCAVATION_WAYPOINT_CAP));
  for (const landmark of stale) ctx.memory.removeLandmark(landmark.id);
}

/** The callback is internal code supplied by a structure skill, never model code. */
export async function excavatePath(ctx: SkillCtx, args: ExcavationArgs, stopOnObservation?: () => boolean) {
  const { adapter, senses, signal } = ctx;
  const origin = adapter.state();
  let entryId: string | undefined, checkpointId: string | undefined, completed = 0, excavated = 0, filled = 0, fillTried = false;
  const path: { pos: Vec3Like; observationId: number }[] = [];
  /** stairs 下行时，记录点下一级没有精确支撑、但同列 ≤4 格内有安全楼面而多落下的地方。 */
  const adjustedDrops: { requestedFoot: number; landingFoot: number; drop: number; block: string; blockCell: Vec3Like }[] = [];
  /** 按 Agent 显式 fill 授权补上的支撑格；材料会真实消耗。 */
  const fillFacts: { at: Vec3Like; item: string }[] = [];
  const dropNote = () => adjustedDrops.length
    ? `（其中 ${adjustedDrops.length} 处按实际楼面多下降 ${adjustedDrops.reduce((n, d) => n + d.drop, 0)} 格）`
    : '';
  const fillNote = () => filled
    ? `（按 fill 补了 ${filled} 处支撑：${fillFacts.map((f) => `${f.item} 在 (${f.at.x},${f.at.y},${f.at.z})`).join('、')}）`
    : '';
  const details = () => {
    const checkpoint = path.at(-1)?.pos ?? null;
    return { structureVerified: false, mode: args.mode, direction: args.direction, requestedSteps: args.steps, completedSteps: completed, descendedLevels: args.mode === 'stairs' ? completed : 0, ascendedLevels: args.mode === 'stairs_up' ? completed : 0,
      excavatedBlocks: excavated, filledBlocks: filled, fillFacts, entryId, nextEntryId: checkpointId ?? entryId, checkpoint, path, adjustedDrops,
      actualOffset: checkpoint ? { x: checkpoint.x - origin.pos.x, y: checkpoint.y - origin.pos.y, z: checkpoint.z - origin.pos.z } : null,
      coverage: '仅探索实际经过的单条有界通道，未证明已覆盖地下区域或找到要塞' };
  };
  try {
    if (!Number.isInteger(args.steps) || args.steps < 1 || args.steps > 8 || !Object.hasOwn(DIRECTIONS, args.direction) || !['stairs', 'stairs_up', 'tunnel'].includes(args.mode)) throw new ExcavationStop('BAD_ARGS', '开挖必须显式指定方向与模式，每次最多8步');
    assertSession(ctx, origin);
    // Agent 明确指定了本轮工具：先做无副作用的校验；真正换手放到其它校验都通过之后
    if (args.tool) {
      if (!origin.inventory.some((item) => item.name === args.tool && item.count > 0)) throw new ExcavationStop('TOOL_MISSING', `背包里没有 ${args.tool}（数量为 0 也算没有），不能按指定工具开挖`);
      if (!adapter.equipItem) throw new ExcavationStop('ERROR', '当前适配器没有装备接口，不能把指定工具装备到主手；未开挖');
    }
    const initial = voxel(origin.pos);
    if (!origin.onGround) throw new ExcavationStop('ERROR', '需要先在已知干燥地板上站稳');
    standingCell(ctx, origin.pos);
    if (Math.abs(origin.pos.y - Math.round(origin.pos.y)) > 0.01) {
      throw new ExcavationStop('PATH_NOT_FOUND', `当前脚高 y=${origin.pos.y.toFixed(2)}，站在半格/非整块支撑上；整格阶梯/通道会挖掉这层支撑，未实现半格脚高转换，未开始`, true);
    }
    ctx.memory.setWorld(origin.worldId);
    if (args.entry !== 'current') {
      const entry = trustedExcavationEntry(ctx, args.entry);
      if (!entry || Math.hypot(entry.pos.x - origin.pos.x, entry.pos.z - origin.pos.z) > 6
        || !entry.label.startsWith(EYE_DESCENT_LABEL) && Math.abs(entry.pos.y - origin.pos.y) > 2) throw new ExcavationStop('BAD_ARGS', 'entry 必须是当前世界、维度附近的可信入口；先实际到达该入口再开挖');
      entryId = entry.id;
    } else {
      pruneExcavationWaypoints(ctx);
      const landmark = ctx.memory.addLandmark('waypoint', EXCAVATION_ENTRY_LABEL, origin.dim, initial, 1);
      entryId = landmark?.id ?? ctx.memory.landmarks().find((item) => item.kind === 'waypoint' && item.dim === origin.dim && item.label === EXCAVATION_ENTRY_LABEL && dist3(item.pos, initial) < 1)?.id;
    }
    // 其它校验都过了再真正换手：失败在这个动作里不会留下“已经换了主手”的副作用
    if (args.tool) {
      const equipped = await adapter.equipItem!(args.tool, 'hand', signal);
      if (!equipped.ok) throw new ExcavationStop('ERROR', `无法把指定工具 ${args.tool} 装备到主手：${equipped.reason}；未开挖`);
    }
    path.push({ pos: { ...origin.pos }, observationId: origin.observationId });
    const peek = async (direction: 'north' | 'east' | 'south' | 'west') => {
      assertSession(ctx, origin);
      await adapter.look(YAW[direction], -0.15, signal);
      assertSession(ctx, origin);
      const scanner = senses as typeof senses & { scan?: () => unknown };
      if (typeof scanner.scan === 'function') scanner.scan();
      else { await sleep(160, signal); assertSession(ctx, origin); senses.refresh(); }
    };
    // 结构搜索才需要四向环顾（捕捉任意方向刚挖出的门框）；纯开挖只看挖掘方向一眼刷新工作面，
    // 其余朝向交给 700ms 的感知循环，安全预检本就走 blockAt 实时查询、不依赖这次扫。
    const observe = async () => {
      if (!stopOnObservation) {
        await peek(args.direction);
        return false;
      }
      for (const direction of ['north', 'east', 'south', 'west'] as const) {
        await peek(direction);
        if (stopOnObservation()) return true;
      }
      senses.markSweep();
      return false;
    };
    if (await observe()) return ok('在当前实际入口观察到目标，未继续开挖', { ...details(), stoppedByObservation: true });
    const direction = DIRECTIONS[args.direction];
    for (let step = 0; step < args.steps; step++) {
      const current = assertSession(ctx, origin), here = voxel(current.pos);
      if (!current.onGround) throw new ExcavationStop('ERROR', '尚未站稳，不能继续开挖下一格');
      standingCell(ctx, current.pos);
      if (Math.abs(current.pos.y - Math.round(current.pos.y)) > 0.01) {
        throw new ExcavationStop('PATH_NOT_FOUND', `脚高 y=${current.pos.y.toFixed(2)} 站在半格/非整块支撑上；整格开挖未实现半格脚高转换`, true);
      }
      let next = { x: here.x + direction.x, y: here.y + (args.mode === 'stairs' ? -1 : args.mode === 'stairs_up' ? 1 : 0), z: here.z + direction.z };
      // 下一落脚要落在 next.y。先按碰撞顶面确认脚下支撑：空气/未知/半格顶面都在挖掘前报缺口。
      // 只有 Agent 显式给了 fill 才用指定材料补这一格；否则不擅自消耗背包方块。
      let supportProblemNow = supportProblem(ctx, { x: next.x, y: next.y - 1, z: next.z }, next.y, `[${args.direction}] 下一落点`);
      // 下行阶梯的下一级没有精确支撑、但同列下方 1..4 格就有安全整块楼面时，按更低的实际脚面继续，
      // 不消耗材料。Agent 已经选择“向下开阶梯”，落到下一处实际楼面属于执行这项委托；只有危险、未知、
      // 半格脚高或落差 >4 才停下，把缺口交回给 Agent 决定 descend/place_at/换方向。
      if (supportProblemNow && args.mode === 'stairs') {
        const below = supportProblemNow.below;
        const found = below?.found;
        const safeDrop = found !== null && found !== undefined && !below!.hazardAt && !below!.unknownAt
          && found.drop > 0 && found.drop <= 4 && Math.abs(found.foot - Math.round(found.foot)) <= 1e-6;
        if (safeDrop) {
          const adjusted = { ...next, y: found!.foot };
          const adjustedProblem = supportProblem(ctx, { x: adjusted.x, y: adjusted.y - 1, z: adjusted.z }, adjusted.y, `[${args.direction}] 下一落点`);
          if (!adjustedProblem) {
            adjustedDrops.push({ requestedFoot: next.y, landingFoot: found!.foot, drop: found!.drop, block: found!.block, blockCell: { ...found!.at } });
            next = adjusted;
            supportProblemNow = null;
          }
        }
      }
      // Agent 显式给了 fill：在挖掘前把支撑补实；只替换空气/液体/可替换植物，
      // 不拿 fill 硬盖半砖、火把、沙子/沙砾这类不该当支撑的方块。
      if (supportProblemNow && args.fill) {
        const fillItem = args.fill;
        const supportCell = { x: next.x, y: next.y - 1, z: next.z };
        const supportState = stateAt(ctx.adapter)(supportCell);
        if (supportState && isReplaceable(supportState.name)) {
          fillTried = true;
          const attempt = () => placeAt.run(ctx, { at: [0, 0, 0], xyz: supportCell, facing: FACING[args.direction], item: fillItem, purpose: 'support' });
          let placed = await attempt();
          // 当前站位唯一的参照面可能在脚下/身后，射线打到别的面。退一格或侧移一格再试同一个目标格：
          // 只换站位，不换目标、不换材料、不挖别处；每格最多试 3 个相邻站位。
          if (placed.status !== 'succeeded') {
            const stances = [
              { x: here.x - direction.x, y: here.y, z: here.z - direction.z },
              { x: here.x + direction.z, y: here.y, z: here.z + direction.x },
              { x: here.x - direction.z, y: here.y, z: here.z - direction.x },
            ];
            for (const stance of stances) {
              assertSession(ctx, origin);
              const at = voxel(adapter.state().pos);
              if (at.x === stance.x && at.y === stance.y && at.z === stance.z) continue;
              try {
                await adapter.moveTo({ kind: 'near', pos: stance, range: 0.3 }, { signal, timeoutMs: 2500, allowSwimming: false, constructionSafe: true });
              } catch (e) {
                if (isAbort(e)) throw e;
                continue;
              }
              placed = await attempt();
              if (placed.status === 'succeeded') break;
            }
          }
          if (placed.status !== 'succeeded') {
            throw new ExcavationStop(placed.failureCode ?? 'PATH_NOT_FOUND',
              `[${args.direction}] 下一落点 (${next.x},${next.y},${next.z}) 的支撑格 (${supportCell.x},${supportCell.y},${supportCell.z}) 是 ${supportState.name}；按 fill:"${args.fill}" 在当前及相邻站位补支撑都没成：${placed.summary}`);
          }
          const actual = String((placed.data as { placed?: unknown } | undefined)?.placed ?? args.fill);
          filled++;
          fillFacts.push({ at: supportCell, item: actual });
          supportProblemNow = supportProblem(ctx, supportCell, next.y, `[${args.direction}] 下一落点`);
          if (supportProblemNow) {
            throw new ExcavationStop(supportProblemNow.code,
              `[${args.direction}] 下一落点 (${next.x},${next.y},${next.z}) 的支撑格 (${supportCell.x},${supportCell.y},${supportCell.z}) 已按 fill 放了 ${actual}，但仍不能确认支撑：${supportProblemNow.message}`);
          }
        }
      }
      if (supportProblemNow) throw supportProblemNow;
      const height = args.mode === 'stairs' ? 3 : 2;
      const cells = preflightColumn(ctx, next, height, args.tool).reverse();
      // A one-block jump needs extra clearance above the current head before
      // moving. Its floor and the next step block are never dug out.
      const workCheck = () => { preflightColumn(ctx, next, height, args.tool); if (args.mode === 'stairs_up') preflightColumn(ctx, here, 3, args.tool); };
      workCheck();
      if (args.mode === 'stairs_up') cells.unshift({ ...here, y: here.y + 2 });
      for (const pos of cells) {
        assertSession(ctx, origin);
        workCheck();
        if (AIR.has(adapter.blockAt(pos) ?? '')) continue;
        // 指定了工具就交给适配器：只装备这一把、挖不动就返回 TOOL_MISSING，不自动换别的工具
        const result = await adapter.dig(pos, signal, args.tool ? { tool: args.tool } : undefined);
        // 先确认这一格是否真的挖空，再检查会话/期限：已经发生的挖掘要计进部分效果，
        // 取消/超时不能把它报成“没挖过”。
        if (!result.ok) {
          assertSession(ctx, origin);
          // 适配器返回的 TOOL_MISSING（可能带前缀说明）原样报出，不吞成笼统的 ERROR
          throw new ExcavationStop(result.reason?.startsWith('TOOL_MISSING') ? 'TOOL_MISSING' : 'ERROR', `安全通道开挖失败：${result.reason}`);
        }
        if (!AIR.has(adapter.blockAt(pos) ?? '')) {
          assertSession(ctx, origin);
          throw new ExcavationStop('ERROR', '挖掘回执没有对应的实际空气方块');
        }
        excavated++;
        assertSession(ctx, origin);
      }
      workCheck();
      standingCell(ctx, next);
      assertSession(ctx, origin);
      await adapter.moveTo({ kind: 'near', pos: { x: next.x + 0.5, y: next.y, z: next.z + 0.5 }, range: 0.3 }, { signal, timeoutMs: Math.max(1, Math.min(10000, ctx.deadline - Date.now())), constructionSafe: true });
      const landedBy = Math.min(ctx.deadline, Date.now() + 2500);
      let landed: AgentState;
      while (true) {
        landed = assertSession(ctx, origin);
        if (landed.onGround && Math.abs(landed.pos.y - next.y) <= 0.1 && Math.hypot(landed.pos.x - next.x - 0.5, landed.pos.z - next.z - 0.5) <= 0.45) break;
        if (Date.now() >= landedBy) throw new ExcavationStop('PATH_NOT_FOUND', '移动回执未对应实际站稳的下一落点');
        await sleep(50, signal);
      }
      preflightColumn(ctx, next, height, args.tool);
      standingCell(ctx, next);
      completed++;
      path.push({ pos: { ...landed.pos }, observationId: landed.observationId });
      assertSession(ctx, origin);
      checkpointId = ctx.memory.transaction(() => {
        const checkpoint = ctx.memory.addLandmark('waypoint', `${EXCAVATION_CHECKPOINT_LABEL}（${args.mode}/${args.direction}）`, origin.dim, next, 0);
        if (checkpoint) {
          if (checkpointId) ctx.memory.removeLandmark(checkpointId);
          return checkpoint.id;
        }
        return checkpointId; // 存不下恢复点就保留上一入口，不影响继续挖
      });
      ctx.progress(completed / args.steps, `实际推进 ${completed}/${args.steps} 格，${args.mode === 'stairs' ? '沿阶梯下降' : args.mode === 'stairs_up' ? '沿阶梯上升' : '搜索当前层通道'}`);
      if (await observe()) return ok(`有界开挖中观察到目标，保留实际入口与路径${dropNote()}${fillNote()}`, { ...details(), stoppedByObservation: true });
    }
    return ok(`实际探索 ${completed} 格${args.mode === 'stairs' ? '下降阶梯' : args.mode === 'stairs_up' ? '上升阶梯' : '水平通道'}${dropNote()}${fillNote()}，保留下一入口；尚未证明找到结构`, details());
  } catch (error) {
    if (isAbort(error)) {
      // 取消/超时也要保留已经实际挖掉的格数与路径；不足一步的移动不算完成，不伪造入口。
      (error as Error & { partial?: Record<string, unknown> }).partial = details();
      throw error;
    }
    const msg = (error as Error).message;
    const cavity = error instanceof ExcavationStop && error.nextLanding ? cavityGap(ctx, error.nextLanding, error.below, fillTried) : null;
    const fall = cavity && 'fall' in cavity ? cavity.fall : null;
    // 拒绝时把「为什么 + 能怎么办」一起报，别只留一句 ERROR 让它盲试
    // 用「液体」标记和方块名判断，不能用单个「水」字：它会把「没有水平承重顶面」误判成液体提示。
    const dropRule = args.mode === 'stairs'
      ? '；stairs 下行遇到安全整格落差 1..4 格会自动继续，这里停下是因为危险、未知、半格脚高或落差更大'
      : args.mode === 'stairs_up'
        ? '；stairs_up 是上行，不会自动下落：要站上这一级得先 place_at 补支撑，或换方向/descend'
        : '；tunnel 是平巷，不会自动下落：要过去得先 place_at 补支撑，或换方向/descend';
    const hint = /液体|lava|water|岩浆/.test(msg) ? '（先换方向避开液体，或先 place_at 堵上再挖）'
      : /没有水平承重顶面|传送门/.test(msg) ? '（这一格不是能站的水平承重面：换方向，或先用 dig_at / place_at 改变这一格）'
      : /下落方块/.test(msg) ? '（下面是沙子/沙砾这类下落方块，换方向或先堵住再挖）'
      : /未知|未加载/.test(msg) ? '（先照亮/转头看清那一格再挖，或换方向）'
      : cavity ? `（下一落点 (${cavity.nextLanding.x},${cavity.nextLanding.y},${cavity.nextLanding.z}) 的支撑格 (${cavity.supportCell.x},${cavity.supportCell.y},${cavity.supportCell.z}) 是空的${fall ? `；实际可站立脚面在 y=${fall.landing.y.toFixed(2)}，方块在 (${fall.landing.x},${fall.landing.y - 1},${fall.landing.z})（落差 ${fall.drop.toFixed(Number.isInteger(fall.drop) ? 0 : 2)} 格${fall.damage ? `，按当前生命预计约 ${fall.damage} 点摔伤` : ''}）` : ''}${dropRule}；${args.fill ? '已带 fill：补支撑失败时先确认材料和站位，或换方向/换落点；没有去挖/垫别处' : '要补支撑得自己显式 place_at 这一格，或换方向，或选落点用 descend；本次开挖没有自动垫方块'}）`
      : /下面是空的|洞穴|虚空/.test(msg) ? `（前面脚下是空的：要补支撑得自己显式 place_at，或换方向、下去探这个洞${dropRule}）`
      : /支撑面在|半格|整格脚高/.test(msg) ? '（落点实际支撑顶面与所选脚高不符；可确认落点高度、换一格/换方向，或改用 step 明确落脚）'
      : /身体空间|干燥|站稳/.test(msg) ? '（先挖开落点那两格的脚/头空间，或换方向）'
      : '';
    const unsupported = error instanceof ExcavationStop && error.unsupportedGeometry ? { unsupportedGeometry: true } : {};
    return fail(error instanceof ExcavationStop ? error.code : codeFromError(error), `有界开挖停止：${msg}${hint}`, { ...details(), ...unsupported, ...(cavity ? { cavity } : {}) });
  }
}

export const excavationSkill: Skill<ExcavationArgs> = {
  name: 'excavate_path',
  description: '显式选择后，从实际当前位置或附近可信入口开挖单条有界下降/上升阶梯或水平通道；每次最多8格，逐格确认工具、地板、跳跃头部空间、干燥和真实落地。stairs 下行时，下一级支撑格为空但同列 1..4 格内有安全整格楼面，会按实际楼面继续下落，不消耗材料；危险、未知、半格或更大落差才停。可加 fill 明确授权用哪种方块补下一级支撑（会消耗材料）；补支撑时先在当前站位试，必要时退/侧移一格再放同一个目标格，补不上就在挖前停下并报缺口，不把手工 place_at 的工作推回给你。可加 tool 明确本轮用哪件工具（先装备到主手）；指定后不会自动改用别的工具，该工具不在背包或挖不了某一格时返回 TOOL_MISSING。只报告实际路线，不保证覆盖地下、登塔或找到结构。',
  argsDoc: '{"entry":"current|<waypointId>","mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-8,"tool"?:"物品注册名，如 iron_pickaxe","fill"?:"<方块名>|any"}（fill 授权补支撑、耗材料；不写则遇空支撑停下）', timeoutMs: 180000, movement: true,
  validate(raw, adapter) {
    const value = obj(raw), mode = value.mode ?? 'stairs', steps = value.steps ?? 4, tool = value.tool;
    if (typeof value.entry !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.entry) || !['stairs', 'stairs_up', 'tunnel'].includes(mode) || typeof value.direction !== 'string' || !Object.hasOwn(DIRECTIONS, value.direction) || !Number.isInteger(steps) || steps < 1 || steps > 8) return { ok: false, error: 'entry 为 current 或可信入口ID；mode=stairs|stairs_up|tunnel；direction=north|east|south|west；steps 为1-8整数' };
    if (tool !== undefined && (typeof tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(tool))) return { ok: false, error: 'tool 为可选物品注册名（小写字母、数字、下划线，如 iron_pickaxe）；不写则沿用身体自己的换工具规则' };
    const fill = value.fill;
    if (fill !== undefined && (typeof fill !== 'string' || !/^[a-z0-9_]{1,80}$/.test(fill) || (fill !== 'any' && !adapter.isKnownItem(fill)))) {
      return { ok: false, error: 'fill 为可选方块名或 "any"（如 netherrack）；不写则不补支撑' };
    }
    if (typeof fill === 'string' && /_(boat|raft)$/.test(fill)) return { ok: false, error: `${fill} 是船/筏（实体，不是方块），不能用来补支撑` };
    return { ok: true, args: { entry: value.entry, mode, direction: value.direction as ExcavationArgs['direction'], steps, ...(tool !== undefined ? { tool } : {}), ...(typeof fill === 'string' ? { fill } : {}) } };
  },
  run: excavatePath,
};
