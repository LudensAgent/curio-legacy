import minecraftData from 'minecraft-data';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
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
  constructor(public code: FailureCode, message: string) { super(message); }
}

/** 地板可站性判定：null=未加载、hazard=液体/下落方块、非整块=能站但不稳定。三类分别报对症消息，
 * 否则日志与 Agent 分不清「未加载」和「真水」，hint 一律说避液体。注册表几何是材质知识，绝不对世界位置做查询。 */
function floorProblem(name: string | null): ExcavationStop | null {
  if (name === null) return new ExcavationStop('NOT_FOUND', '下一落点地板未加载/未知，不能确认支撑');
  if (hazard(name)) return new ExcavationStop('ERROR', `下一落点地板是 ${name}（${hazardLabel(name)}），不能冒险下落`);
  const collisions = (registry as any).blockCollisionShapes;
  const shapes = collisions?.blocks[name];
  const ids = Array.isArray(shapes) ? shapes : [shapes];
  const full = ids.length > 0 && ids.every((id: number) => {
    const boxes = collisions.shapes[id];
    return boxes?.length === 1 && boxes[0].length === 6 && boxes[0].every((value: number, index: number) => value === (index < 3 ? 0 : 1));
  });
  return full ? null : new ExcavationStop('ERROR', `下一落点地板是 ${name}（不是完整方块，站不稳），不能冒险下落`);
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
  const { adapter } = ctx;
  const problem = floorProblem(adapter.blockAt({ ...feet, y: feet.y - 1 }));
  if (problem) throw problem;
  for (const level of [0, 1]) if (!AIR.has(adapter.blockAt({ ...feet, y: feet.y + level }) ?? '')) throw new ExcavationStop('ERROR', '落点没有已确认的两格干燥身体空间');
}

/** Only this adjacent work column and its touching hazard boundaries are read.
 * These reads never discover structures or choose an underground direction. */
function preflightColumn(ctx: SkillCtx, feet: Vec3Like, height: number) {
  const { adapter } = ctx;
  const problem = floorProblem(adapter.blockAt({ ...feet, y: feet.y - 1 }));
  if (problem) throw problem;
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
    if (!origin.onGround || Math.abs(origin.pos.y - initial.y) > 0.1) throw new ExcavationStop('ERROR', '需要先在已知干燥地板上站稳');
    standingCell(ctx, initial);
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
      if (!current.onGround || Math.abs(current.pos.y - here.y) > 0.1) throw new ExcavationStop('ERROR', '尚未站稳，不能继续开挖下一格');
      standingCell(ctx, here);
      const next = { x: here.x + direction.x, y: here.y + (args.mode === 'stairs' ? -1 : args.mode === 'stairs_up' ? 1 : 0), z: here.z + direction.z };
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
        assertSession(ctx, origin);
        if (!result.ok) throw new ExcavationStop(result.reason === 'TOOL_MISSING' ? 'TOOL_MISSING' : 'ERROR', `安全通道开挖失败：${result.reason}`);
        if (!AIR.has(adapter.blockAt(pos) ?? '')) throw new ExcavationStop('ERROR', '挖掘回执没有对应的实际空气方块');
        excavated++;
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
    if (isAbort(error)) throw error;
    const msg = (error as Error).message;
    // 拒绝时把「为什么 + 能怎么办」一起报，别只留一句 ERROR 让它盲试
    const hint = /液体|水|lava|water/.test(msg) ? '（先换方向避开液体，或先 place_at 堵上再挖）'
      : /下落方块/.test(msg) ? '（下面是沙子/沙砾这类下落方块，换方向或先堵住再挖）'
      : /未知|未加载/.test(msg) ? '（先照亮/转头看清那一格再挖，或换方向）'
      : /不是完整方块|站不稳/.test(msg) ? '（下面是能站但不完整的地板，确认落点高度或换方向）'
      : /身体空间|干燥|站稳/.test(msg) ? '（先挖开落点那两格的脚/头空间，或换方向）'
      : '';
    return fail(error instanceof ExcavationStop ? error.code : codeFromError(error), `有界开挖停止：${msg}${hint}`, details());
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
