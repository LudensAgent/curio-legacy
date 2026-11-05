import minecraftData from 'minecraft-data';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { bodyCells, bodyProbe, footSurfaceY, shapeKnown, supportTop, type ObservedState, type StateAt } from '../perception/geometry.ts';
import { codeFromError, fail, isAbort, obj, ok, type FailureCode, type Skill, type SkillCtx } from './types.ts';
import { EXCAVATION_WAYPOINT_CAP } from '../memory/store.ts';

export interface ExcavationArgs {
  entry: string;
  mode: 'stairs' | 'stairs_up' | 'tunnel';
  direction: 'north' | 'east' | 'south' | 'west';
  steps: number;
}

const registry = minecraftData(config.mc.version);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['water', 'lava', 'bubble_column', 'powder_snow', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'cobweb', 'pointed_dripstone']);
const PROTECTED = new Set(['end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway', 'chest', 'trapped_chest', 'barrel', 'spawner', 'crafting_table', 'furnace', 'blast_furnace', 'smoker']);
/** 传送门方块：软块（薄片、可穿过），不是「半砖/台阶」这类能站但不稳的方块，也不是液体/坑 */
const PORTAL_BLOCKS = new Set(['nether_portal', 'end_portal', 'end_gateway']);
const DIRECTIONS = { north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 } };
const YAW = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };
export const EXCAVATION_ENTRY_LABEL = '实际开挖入口';
export const EXCAVATION_CHECKPOINT_LABEL = '实际开挖进度';
export const EYE_DESCENT_LABEL = '末影之眼下降搜索点';

const falling = (name: string) => ['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'dragon_egg', 'anvil', 'chipped_anvil', 'damaged_anvil'].includes(name) || name.endsWith('_concrete_powder');
const hazard = (name: string) => HAZARDS.has(name) || falling(name) || name.startsWith('infested_');
/** 危险方块的类型，决定 hint 是「避液体」还是「堵下落」还是只报名字 */
const hazardLabel = (name: string) => name === 'water' || name === 'lava' || name === 'bubble_column' ? '液体' : falling(name) ? '下落方块' : '危险方块';
const voxel = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });

class ExcavationStop extends Error {
  /** 下一落点没有支撑时带上该落点，供失败回执附可见落点事实，而不是只给一句硬错误 */
  nextLanding?: Vec3Like;
  constructor(public code: FailureCode, message: string, public unsupportedGeometry = false) { super(message); }
}

/** 读当前方块状态：适配器提供 blockstate 时用真实状态；只有名字时碰撞形状按“未确认”处理，不拿默认状态冒充。 */
const stateAt = (adapter: SkillCtx['adapter']): StateAt => (pos) => {
  const state = adapter.blockStateAt?.(pos);
  if (state?.name) return state;
  const name = adapter.blockAt(pos);
  return name === null ? null : { name, properties: {} };
};

/**
 * 落点支撑判定：用与 step 相同的碰撞顶面，而不是方块名猜“整块/不完整”。
 * 支撑面必须等于本次要落到的脚高；半格顶面会报出实际高度并明确“整格开挖未实现半格转换”，
 * 不再说游戏里“半砖站不稳”。未知/未加载单独返回，不当作空气。
 */
function supportProblem(ctx: SkillCtx, cell: Vec3Like, expectedFoot: number, label: string): ExcavationStop | null {
  const state: ObservedState | null = stateAt(ctx.adapter)(cell);
  if (state === null) return new ExcavationStop('NOT_FOUND', `${label}支撑格未加载/未知，不能确认支撑`);
  if (hazard(state.name)) return new ExcavationStop('ERROR', `${label}是 ${state.name}（${hazardLabel(state.name)}），不能冒险下落`);
  if (PORTAL_BLOCKS.has(state.name)) return new ExcavationStop('ERROR', `${label}是 ${state.name}（传送门，不能承重），不能作为站立支撑`);
  if (!shapeKnown(state.name, state.properties ?? {})) return new ExcavationStop('NOT_FOUND', `${label}的 ${state.name} 状态未确认（缺少 blockstate），不能确认支撑顶面`);
  const top = supportTop(state.name, state.properties ?? {});
  if (top === null) {
    if (AIR.has(state.name)) {
      const gap = new ExcavationStop('ERROR', `${label}下面是空的（${state.name}）：前面脚下是个坑/洞穴`);
      gap.nextLanding = { ...cell, y: expectedFoot };
      return gap;
    }
    return new ExcavationStop('ERROR', `${label}的 ${state.name} 没有水平承重顶面，不能作为落点支撑`);
  }
  const surface = cell.y + top;
  if (Math.abs(surface - expectedFoot) > 0.01) {
    return new ExcavationStop('ERROR', `${label}支撑面在 y=${surface.toFixed(2)}（${state.name}），与本次期望脚高 y=${expectedFoot.toFixed(2)} 不符；当前整格开挖未实现半格/非整块脚高转换`, true);
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
function preflightColumn(ctx: SkillCtx, feet: Vec3Like, height: number) {
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
      const tools = Object.keys(block.harvestTools ?? {});
      const held = adapter.state().inventory.some((item) => item.count > 0 && tools.includes(String(registry.itemsByName[item.name]?.id)));
      if (!adapter.canHarvest(pos) || tools.length && !held) throw new ExcavationStop('TOOL_MISSING', `缺少实际可采掘 ${name} 的工具`);
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
function cavityGap(ctx: SkillCtx, nextLanding: Vec3Like) {
  const options = ctx.senses.landingOptions?.(12) ?? [];
  const distance = (target: Vec3Like) => Math.hypot(target.x - nextLanding.x, target.y - nextLanding.y, target.z - nextLanding.z);
  return {
    reason: 'next_landing_support_air',
    nextLanding: { ...nextLanding },
    supportCell: { x: nextLanding.x, y: nextLanding.y - 1, z: nextLanding.z },
    visibleLandings: options
      .map((o) => ({ target: { ...o.target }, surface: o.surface, drop: o.drop, clearance: o.clearance, corridor: o.corridor, approach: o.approach, unknowns: o.unknowns }))
      .sort((a, b) => distance(a.target) - distance(b.target))
      .slice(0, 5),
    handoff: '可见落点需由 assess_landings 明确选择；确认支撑与净空后可用 descend 选落点（落体通道未看清时可显式 allowUnknownCorridor），也可 place_at 补支撑或换方向；本次没有自动垫块、挖掘或下落',
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
  let entryId: string | undefined, checkpointId: string | undefined, completed = 0, excavated = 0;
  const path: { pos: Vec3Like; observationId: number }[] = [];
  const details = () => {
    const checkpoint = path.at(-1)?.pos ?? null;
    return { structureVerified: false, mode: args.mode, direction: args.direction, requestedSteps: args.steps, completedSteps: completed, descendedLevels: args.mode === 'stairs' ? completed : 0, ascendedLevels: args.mode === 'stairs_up' ? completed : 0,
      excavatedBlocks: excavated, entryId, nextEntryId: checkpointId ?? entryId, checkpoint, path,
      actualOffset: checkpoint ? { x: checkpoint.x - origin.pos.x, y: checkpoint.y - origin.pos.y, z: checkpoint.z - origin.pos.z } : null,
      coverage: '仅探索实际经过的单条有界通道，未证明已覆盖地下区域或找到要塞' };
  };
  try {
    if (!Number.isInteger(args.steps) || args.steps < 1 || args.steps > 8 || !Object.hasOwn(DIRECTIONS, args.direction) || !['stairs', 'stairs_up', 'tunnel'].includes(args.mode)) throw new ExcavationStop('BAD_ARGS', '开挖必须显式指定方向与模式，每次最多8步');
    assertSession(ctx, origin);
    const initial = voxel(origin.pos);
    if (!origin.onGround) throw new ExcavationStop('ERROR', '需要先在已知干燥地板上站稳');
    standingCell(ctx, origin.pos);
    if (Math.abs(origin.pos.y - Math.round(origin.pos.y)) > 0.01) {
      throw new ExcavationStop('BAD_ARGS', `当前脚高 y=${origin.pos.y.toFixed(2)}，站在半格/非整块支撑上；整格阶梯/通道会挖掉这层支撑，未实现半格脚高转换，未开始`, true);
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
        throw new ExcavationStop('BAD_ARGS', `脚高 y=${current.pos.y.toFixed(2)} 站在半格/非整块支撑上；整格开挖未实现半格脚高转换`, true);
      }
      const next = { x: here.x + direction.x, y: here.y + (args.mode === 'stairs' ? -1 : args.mode === 'stairs_up' ? 1 : 0), z: here.z + direction.z };
      // 下一落脚要落在 next.y。先按碰撞顶面确认脚下支撑：空气/未知/半格顶面都在挖掘前报缺口，
      // 不自动消耗背包材料垫块；补支撑是 Agent 显式选择 place_at 的组合动作。
      const supportProblemNow = supportProblem(ctx, { x: next.x, y: next.y - 1, z: next.z }, next.y, `[${args.direction}] 下一落点`);
      if (supportProblemNow) throw supportProblemNow;
      const height = args.mode === 'stairs' ? 3 : 2;
      const cells = preflightColumn(ctx, next, height).reverse();
      // A one-block jump needs extra clearance above the current head before
      // moving. Its floor and the next step block are never dug out.
      const workCheck = () => { preflightColumn(ctx, next, height); if (args.mode === 'stairs_up') preflightColumn(ctx, here, 3); };
      workCheck();
      if (args.mode === 'stairs_up') cells.unshift({ ...here, y: here.y + 2 });
      for (const pos of cells) {
        assertSession(ctx, origin);
        workCheck();
        if (AIR.has(adapter.blockAt(pos) ?? '')) continue;
        const result = await adapter.dig(pos, signal);
        // 先确认这一格是否真的挖空，再检查会话/期限：已经发生的挖掘要计进部分效果，
        // 取消/超时不能把它报成“没挖过”。
        if (!result.ok) {
          assertSession(ctx, origin);
          throw new ExcavationStop(result.reason === 'TOOL_MISSING' ? 'TOOL_MISSING' : 'ERROR', `安全通道开挖失败：${result.reason}`);
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
      preflightColumn(ctx, next, height);
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
      if (await observe()) return ok('有界开挖中观察到目标，保留实际入口与路径', { ...details(), stoppedByObservation: true });
    }
    return ok(`实际探索 ${completed} 格${args.mode === 'stairs' ? '下降阶梯' : args.mode === 'stairs_up' ? '上升阶梯' : '水平通道'}，保留下一入口；尚未证明找到结构`, details());
  } catch (error) {
    if (isAbort(error)) {
      // 取消/超时也要保留已经实际挖掉的格数与路径；不足一步的移动不算完成，不伪造入口。
      (error as Error & { partial?: Record<string, unknown> }).partial = details();
      throw error;
    }
    const msg = (error as Error).message;
    const cavity = error instanceof ExcavationStop && error.nextLanding ? cavityGap(ctx, error.nextLanding) : null;
    // 拒绝时把「为什么 + 能怎么办」一起报，别只留一句 ERROR 让它盲试
    const hint = /液体|水|lava|water/.test(msg) ? '（先换方向避开液体，或先 place_at 堵上再挖）'
      : /下落方块/.test(msg) ? '（下面是沙子/沙砾这类下落方块，换方向或先堵住再挖）'
      : /未知|未加载/.test(msg) ? '（先照亮/转头看清那一格再挖，或换方向）'
      : cavity ? '（已附当前可见落点事实 cavity；要补支撑得自己显式 place_at，或换方向，或选落点用 descend；本次开挖没有自动垫/挖/下落）'
      : /下面是空的|洞穴|虚空/.test(msg) ? '（前面脚下是空的：要补支撑得自己显式 place_at，或换方向、下去探这个洞；这不是本次开挖自动做的）'
      : /支撑面在|半格|整格脚高/.test(msg) ? '（落点实际支撑顶面与所选脚高不符；可确认落点高度、换一格/换方向，或改用 step 明确落脚）'
      : /身体空间|干燥|站稳/.test(msg) ? '（先挖开落点那两格的脚/头空间，或换方向）'
      : '';
    const unsupported = error instanceof ExcavationStop && error.unsupportedGeometry ? { unsupportedGeometry: true } : {};
    return fail(error instanceof ExcavationStop ? error.code : codeFromError(error), `有界开挖停止：${msg}${hint}`, { ...details(), ...unsupported, ...(cavity ? { cavity } : {}) });
  }
}

export const excavationSkill: Skill<ExcavationArgs> = {
  name: 'excavate_path',
  description: '显式选择后，从实际当前位置或附近可信入口开挖单条有界下降/上升阶梯或水平通道；每次最多8格，逐格确认工具、地板、跳跃头部空间、干燥和真实落地。只报告实际路线，不保证覆盖地下、登塔或找到结构。',
  argsDoc: '{"entry":"current|<waypointId>","mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-8}', timeoutMs: 180000, movement: true,
  validate(raw) {
    const value = obj(raw), mode = value.mode ?? 'stairs', steps = value.steps ?? 4;
    if (typeof value.entry !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.entry) || !['stairs', 'stairs_up', 'tunnel'].includes(mode) || typeof value.direction !== 'string' || !Object.hasOwn(DIRECTIONS, value.direction) || !Number.isInteger(steps) || steps < 1 || steps > 8) return { ok: false, error: 'entry 为 current 或可信入口ID；mode=stairs|stairs_up|tunnel；direction=north|east|south|west；steps 为1-8整数' };
    return { ok: true, args: { entry: value.entry, mode, direction: value.direction as ExcavationArgs['direction'], steps } };
  },
  run: excavatePath,
};
