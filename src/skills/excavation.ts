import minecraftData from 'minecraft-data';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { bodyCells, bodyProbe, estimatedFallDamage, footSurfaceY, isReplaceable, shapeKnown, supportTop, type ObservedState, type StateAt } from '../perception/geometry.ts';
import { codeFromError, fail, isAbort, obj, ok, type FailureCode, type Skill, type SkillCtx } from './types.ts';
import { placeSupport } from './movement/primitives.ts';
import { markSelfModified, type WalkCorridorSegment } from '../spatial/shared-session.ts';
import type { PathFragment } from 'curio-minecraft-3d-memory';
import { EXCAVATION_WAYPOINT_CAP } from '../memory/store.ts';

/** 记录回执：只报告记忆写没写、写到哪，不把记忆失败混进身体动作结果。 */
type ExcavationRouteMemory = {
  status: 'written' | 'failed' | 'skipped';
  fragmentId?: string;
  traversalIds?: string[];
  stage?: string;
  message?: string;
};

export interface ExcavationArgs {
  entry: string;
  mode: 'stairs' | 'stairs_up' | 'tunnel';
  direction: 'north' | 'east' | 'south' | 'west';
  steps: number;
  /** Agent 明确选择的本轮主手工具（物品注册名）；不给时沿用身体现有的换工具规则 */
  tool?: string;
  /** Agent 明确授权用哪种方块补下一级支撑（会消耗材料）；不给则不补，遇空支撑停下并报缺口。 */
  fill?: string;
  /** 接受相邻水流入；不写则在水邻格前停下。 */
  wet?: boolean;
  /** 接受相邻岩浆流入/接触风险；不写则在岩浆邻格前停下。 */
  lava?: boolean;
  /** 接受工作面/落点上方的沙砾、沙子等下落方块；不写则在下落方块前停下。 */
  allowFalling?: boolean;
}

export type ExcavationStopKind = 'impossible' | 'risk' | 'capability' | 'missing_support' | 'unknown' | 'budget';

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
const liquid = (name: string) => ['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(name);

/** 授权开关：wet/lava 只放行相邻液体流入；allowFalling 适用于工作面（默认接受）与落点/身体/上方。 */
type RiskAuthorization = 'wet' | 'lava' | 'allowFalling';

/** 下一落点缺支撑时的契约字段：格、建议材料、可用站位、代价、原因。 */
type SupportMissing = {
  at: Vec3Like;
  item: string;
  stance: { kind: 'adjacent'; recommended: ExcavationArgs['direction'] };
  cost: number;
  reason: 'next_landing_support_air';
};
/** 一步补救：只建议 Agent 已有的元语，不在这里代做。 */
type Remediation =
  | { action: 'place_support'; at: Vec3Like; item: string; reason: string }
  | { action: 'move_step'; at: Vec3Like; reason: string }
  | { action: 'authorize'; authorization: RiskAuthorization; at: Vec3Like; reason: 'unaccepted_risk' }
  | { action: 'change_direction'; at: Vec3Like; reason: 'unaccepted_contact_hazard' | 'work_face_impossible' };

/** 只在开挖过程中收集事实：风险格、邻格未知。接受与否分开记录，成功回执也要带上。 */
interface ExcavationRisk {
  at: Vec3Like;
  name: string;
  kind: 'falling' | 'liquid' | 'contact';
  role: 'work_face' | 'neighbor' | 'landing_support' | 'body' | 'above_body';
  authorization: RiskAuthorization | null;
  accepted: boolean;
}
interface RiskLedger {
  risks: ExcavationRisk[];
  unknownAdjacent: Vec3Like[];
  riskKeys: Set<string>;
  unknownKeys: Set<string>;
}
const cellKey = (at: Vec3Like) => `${at.x},${at.y},${at.z}`;
/** 返回该风险是否已被显式授权；同一格同一方块只记一次。 */
function noteRisk(ledger: RiskLedger, at: Vec3Like, name: string, role: ExcavationRisk['role'], opts: Pick<ExcavationArgs, 'wet' | 'lava' | 'allowFalling'>, accepted?: boolean) {
  // wet/lava 只适用于相邻液体流入；落点支撑/身体/上方的液体在本动作里没有可授权开关，只能避开。
  const authorization: RiskAuthorization | null = falling(name) ? 'allowFalling' : role === 'neighbor' && (liquid(name) || name === 'lava') ? name === 'lava' ? 'lava' : 'wet' : null;
  const authorized = accepted ?? (authorization === 'wet' ? !!opts.wet : authorization === 'lava' ? !!opts.lava : authorization === 'allowFalling' ? !!opts.allowFalling : false);
  const key = `${cellKey(at)},${name}`;
  if (!ledger.riskKeys.has(key)) {
    ledger.riskKeys.add(key);
    const kind = falling(name) ? 'falling' : liquid(name) || name === 'lava' ? 'liquid' : 'contact';
    ledger.risks.push({ at: { ...at }, name, kind, role, authorization, accepted: authorized });
  }
  return authorized;
}
function noteUnknown(ledger: RiskLedger, at: Vec3Like) {
  const key = cellKey(at);
  if (ledger.unknownKeys.has(key)) return;
  ledger.unknownKeys.add(key);
  ledger.unknownAdjacent.push({ ...at });
}
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' } as const;
/** 缺支撑的契约缺口：支撑格、建议材料、当前站位在支撑格的哪一侧、补一块的代价。 */
const supportGap = (nextLanding: Vec3Like, direction: ExcavationArgs['direction'], fill?: string): SupportMissing => ({
  at: { x: nextLanding.x, y: nextLanding.y - 1, z: nextLanding.z },
  item: fill ?? 'any',
  stance: { kind: 'adjacent', recommended: OPPOSITE[direction] },
  cost: 1,
  reason: 'next_landing_support_air',
});

interface BelowSupport { at: Vec3Like; foot: number; drop: number; block: string }
interface BelowScan { found: BelowSupport | null; unknownAt: Vec3Like | null; hazardAt: { at: Vec3Like; name: string } | null; scanned: number }

class ExcavationStop extends Error {
  /** 下一落点没有支撑时带上该落点，供失败回执附可见落点事实，而不是只给一句硬错误 */
  nextLanding?: Vec3Like;
  /** 缺口下方实际能站的第一处支撑；没有就保留检查深度/未知位置，不把 air 当成“无限深”。 */
  below?: BelowScan;
  /** 契约字段：缺支撑时缺哪格、建议材料、站位与代价。 */
  supportMissing?: SupportMissing;
  /** 一步补救建议，供调用方直接选择下一个动作。 */
  remediation?: Remediation;
  /** 挖后复核发现目标格没有被清空（例如上方的下落方块回填）时的实际方块。 */
  refill?: { at: Vec3Like; name: string };
  /** fill 补支撑失败时 placeSupport 的站位尝试，作为结构化事实带回。 */
  fillAttempts?: Record<string, unknown>[];
  constructor(public code: FailureCode, message: string, public unsupportedGeometry = false, public kind: ExcavationStopKind = 'impossible') { super(message); }
}

/** 读当前方块状态：适配器提供 blockstate 时用真实状态；只有名字时碰撞形状按“未确认”处理，不拿默认状态冒充。 */
const stateAt = (adapter: SkillCtx['adapter']): StateAt => (pos) => {
  const state = adapter.blockStateAt?.(pos);
  if (state?.name) return state;
  const name = adapter.blockAt(pos);
  return name === null ? null : { name, properties: {} };
};

/** 从某个脚高向下找第一处可站立支撑；给出精确落差，而不是只说“下面是空气”。 */
function scanSupportBelow(ctx: SkillCtx, fromFoot: Vec3Like, maxDepth = 64, opts: Pick<ExcavationArgs, 'allowFalling'> = {}): BelowScan {
  const at = stateAt(ctx.adapter);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const pos = { x: fromFoot.x, y: fromFoot.y - depth, z: fromFoot.z };
    const state = at(pos);
    if (!state) return { found: null, unknownAt: pos, hazardAt: null, scanned: depth };
    if (hazard(state.name) && !(falling(state.name) && opts.allowFalling)) {
      return { found: null, unknownAt: null, hazardAt: { at: pos, name: state.name }, scanned: depth };
    }
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
function supportProblem(ctx: SkillCtx, cell: Vec3Like, expectedFoot: number, label: string, ledger: RiskLedger, args: ExcavationArgs): ExcavationStop | null {
  const state: ObservedState | null = stateAt(ctx.adapter)(cell);
  const at = `(${cell.x},${cell.y},${cell.z})`;
  const landing = `(${cell.x},${expectedFoot},${cell.z})`;
  if (state === null) return new ExcavationStop('NOT_FOUND', `${label}${landing}的支撑格 ${at} 未加载/未知，不能确认支撑`, false, 'unknown');
  if (hazard(state.name)) {
    // 落点支撑本身是液体时，wet/lava 只放行相邻流入，不能把液体当脚面；下落方块可用 allowFalling 接受。
    const accepted = noteRisk(ledger, cell, state.name, 'landing_support', args, falling(state.name) ? !!args.allowFalling : false);
    if (!accepted) return new ExcavationStop('BAD_ARGS', `${label}${landing}的支撑格 ${at} 是 ${state.name}（${hazardLabel(state.name)}），不能冒险下落`, false, 'risk');
  }
  if (PORTAL_BLOCKS.has(state.name)) return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}（传送门，不能承重），不能作为站立支撑`, false, 'impossible');
  if (!shapeKnown(state.name, state.properties ?? {})) return new ExcavationStop('NOT_FOUND', `${label}${landing}的支撑格 ${at} 是 ${state.name}，状态未确认（缺少 blockstate），不能确认支撑顶面`, false, 'unknown');
  const top = supportTop(state.name, state.properties ?? {});
  if (top === null) {
    if (AIR.has(state.name)) {
      const below = scanSupportBelow(ctx, { ...cell, y: expectedFoot }, 64, args);
      if (below.hazardAt) noteRisk(ledger, below.hazardAt.at, below.hazardAt.name, 'landing_support', args, falling(below.hazardAt.name) && !!args.allowFalling);
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
      const gap = new ExcavationStop('PATH_NOT_FOUND', `${label}${landing}的支撑格 ${at} 是 ${state.name}：下一落点下面是空的，${where}${damage ? `；落差约 ${below.found!.drop.toFixed(Number.isInteger(below.found!.drop) ? 0 : 2)} 格，按当前生命预计约 ${damage} 点摔伤（未计护甲/摔落保护）` : ''}`, false, 'missing_support');
      gap.nextLanding = { ...cell, y: expectedFoot };
      gap.below = below;
      gap.supportMissing = supportGap(gap.nextLanding, args.direction, args.fill);
      gap.remediation = { action: 'place_support', at: gap.supportMissing.at, item: gap.supportMissing.item, reason: gap.supportMissing.reason };
      return gap;
    }
    return new ExcavationStop('ERROR', `${label}${landing}的支撑格 ${at} 是 ${state.name}，没有水平承重顶面，不能作为落点支撑`, false, 'impossible');
  }
  const surface = cell.y + top;
  if (Math.abs(surface - expectedFoot) > 0.01) {
    const stop = new ExcavationStop('BAD_ARGS', `${label}${landing}的支撑格 ${at} 支撑面在 y=${surface.toFixed(2)}（${state.name}），与期望脚高 y=${expectedFoot.toFixed(2)} 不符；当前整格开挖未实现半格/非整块脚高转换`, true, 'capability');
    stop.remediation = { action: 'move_step', at: cell, reason: 'fractional_landing_support' };
    return stop;
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

function standingCell(ctx: SkillCtx, feet: Vec3Like, ledger: RiskLedger, opts: Pick<ExcavationArgs, 'allowFalling'> = {}) {
  const states = stateAt(ctx.adapter);
  const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.05), z: Math.floor(feet.z) };
  const surface = footSurfaceY(cell, states);
  if (surface === null) {
    const below = states({ ...cell, y: cell.y - 1 });
    if (below === null) throw new ExcavationStop('NOT_FOUND', '落点支撑未加载/未知，不能确认支撑', false, 'unknown');
    throw new ExcavationStop('ERROR', `落点脚下是 ${below.name}，没有已确认的承重顶面`, false, 'impossible');
  }
  if (Math.abs(surface - feet.y) > 0.01) {
    const stop = new ExcavationStop('BAD_ARGS', `落点支撑面在 y=${surface.toFixed(2)}，与脚高 y=${feet.y.toFixed(2)} 不符，没有把身体当成站稳`, true, 'capability');
    stop.remediation = { action: 'move_step', at: cell, reason: 'fractional_foot_support' };
    throw stop;
  }
  const probe = bodyProbe(feet.y, cell.x, cell.z, states);
  if (probe.unknown.length) throw new ExcavationStop('NOT_FOUND', '落点身体空间未加载/未知，不能确认两格干燥身体空间', false, 'unknown');
  for (const pos of bodyCells(feet.y, cell.x, cell.z)) {
    const state = states(pos);
    if (state && hazard(state.name)) {
      // 身体空间只接受下落方块的 allowFalling；液体仍在身体里时 wet/lava 不把落点变成可站。
      const accepted = noteRisk(ledger, pos, state.name, 'body', opts, falling(state.name) ? !!opts.allowFalling : false);
      if (!accepted) throw new ExcavationStop('BAD_ARGS', `落点身体空间是 ${state.name}（${hazardLabel(state.name)}）`, false, 'risk');
    }
  }
  // 身体上方（头顶再上一格）的下落方块在开挖/落脚后可能落进来：这是「落点/身体上方」风险，
  // 工作面自身不算。没有 allowFalling 时不继续；授权后只记录事实。其它危险由工作面预检负责。
  const above = { x: cell.x, y: cell.y + 2, z: cell.z };
  const aboveState = states(above);
  if (aboveState && falling(aboveState.name)) {
    const accepted = noteRisk(ledger, above, aboveState.name, 'above_body', opts, !!opts.allowFalling);
    if (!accepted) throw new ExcavationStop('BAD_ARGS', `落点身体上方是 ${aboveState.name}（下落方块）`, false, 'risk');
  }
  if (probe.blockers.length) throw new ExcavationStop('BAD_ARGS', '落点没有已确认的两格干燥身体空间', false, 'risk');
}

/** Only this adjacent work column and its touching hazard boundaries are read.
 * These reads never discover structures or choose an underground direction. */
function preflightColumn(ctx: SkillCtx, feet: Vec3Like, height: number, ledger: RiskLedger, opts: Pick<ExcavationArgs, 'wet' | 'lava' | 'allowFalling'> = {}) {
  const { adapter } = ctx;
  const cells = Array.from({ length: height }, (_, level) => ({ ...feet, y: feet.y + level }));
  for (const pos of cells) {
    const name = adapter.blockAt(pos);
    if (name === null) throw new ExcavationStop('NOT_FOUND', '局部工作面未加载/未知', false, 'unknown');
    // 工作面自身的下落方块默认可挖（挖后逐格复核是否被落回填）；液体/接触型危险仍然硬停。
    if (hazard(name) && !falling(name)) {
      // 工作面本身是液体不能靠 wet/lava「挖开」：授权只放行相邻流入，这里始终硬停。
      noteRisk(ledger, pos, name, 'work_face', opts, false);
      const stop = new ExcavationStop(liquid(name) || name === 'lava' ? 'ERROR' : 'BAD_ARGS', `局部工作面是 ${name}（${hazardLabel(name)}）`, false, liquid(name) || name === 'lava' ? 'impossible' : 'risk');
      stop.remediation = { action: 'change_direction', at: pos, reason: 'work_face_impossible' };
      throw stop;
    }
    if (falling(name)) noteRisk(ledger, pos, name, 'work_face', opts, true);
    if (!AIR.has(name)) {
      const block = registry.blocksByName[name];
      // 工作面只要求「可挖、非保护、非危险」：火把/梯子/告示牌这类透明方块不是完整立方，却一样能瞬挖通过，
      // 不能再拿整块判定（完整立方）去卡它，否则 agent 自己插的火把会反过来堵死开挖通道
      if (PROTECTED.has(name) || name.endsWith('_bed') || !block?.diggable || !Number.isFinite(block.hardness) || block.hardness! < 0) throw new ExcavationStop('ERROR', `工作面 ${name} 不能作为普通安全通道挖除`, false, 'impossible');
      // 清路只看能不能挖开，不要求能采到掉落：指定工具在背包与否由开挖前的检查负责，
      // 逐格能否挖开交给 dig 的真实结果（会如实回报 noDrop / HAND_DIG_TIMEOUT）。
    }
    for (const offset of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }]) {
      const at = { x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z };
      const neighbor = adapter.blockAt(at);
      // 邻格未加载不是已确认的危险；只作为未知边界报告，工作面/落点/身体空间未知仍在别处硬停。
      if (neighbor === null) { noteUnknown(ledger, at); continue; }
      if (hazard(neighbor) && !noteRisk(ledger, at, neighbor, 'neighbor', opts)) {
        throw new ExcavationStop('BAD_ARGS', `紧邻开挖面是 ${neighbor}（${hazardLabel(neighbor)}）`, false, 'risk');
      }
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
    handoff: `可见落点需由 assess_landings 明确选择；确认支撑与净空后可用 descend_to 选落点（落体通道未看清时可显式 allowUnknownCorridor），也可用 place_support 补支撑或换方向；${fillTried ? '已按 fill 授权尝试补支撑，没成，缺口仍在' : '本次没有自动垫方块'}；只有 stairs 下行会对安全整格落差 1..4 格自动继续，stairs_up/tunnel 需要你补支撑或换方向`,
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
  let entryId: string | undefined, checkpointId: string | undefined, completed = 0, excavated = 0, noDropBlocks = 0, filled = 0, fillTried = false;
  /** 风险与邻格未知作为数据返回，成功/失败都带；不让它们只活在错误文本里。 */
  const ledger: RiskLedger = { risks: [], unknownAdjacent: [], riskKeys: new Set(), unknownKeys: new Set() };
  const path: { pos: Vec3Like; observationId: number }[] = [];
  /** 已确认落地的连续段；只记录实测到达，不把计划/未确认步补进来。 */
  const confirmedSegments: { from: Vec3Like; to: Vec3Like; sessionId: string; observedAt: number }[] = [];
  let routeMemory: ExcavationRouteMemory | undefined;
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
  const noDropNote = () => noDropBlocks ? `（其中 ${noDropBlocks} 格没有掉落）` : '';
  const details = () => {
    const checkpoint = path.at(-1)?.pos ?? null;
    return { structureVerified: false, mode: args.mode, direction: args.direction, requestedSteps: args.steps, completedSteps: completed, descendedLevels: args.mode === 'stairs' ? completed : 0, ascendedLevels: args.mode === 'stairs_up' ? completed : 0,
      excavatedBlocks: excavated, noDropBlocks, filledBlocks: filled, fillFacts, entryId, nextEntryId: checkpointId ?? entryId, checkpoint, path, adjustedDrops,
      risks: ledger.risks.map((risk) => ({ ...risk, at: { ...risk.at } })), riskCells: ledger.risks.map((risk) => ({ ...risk.at })), unknownAdjacent: ledger.unknownAdjacent.map((at) => ({ ...at })),
      actualOffset: checkpoint ? { x: checkpoint.x - origin.pos.x, y: checkpoint.y - origin.pos.y, z: checkpoint.z - origin.pos.z } : null,
      ...(routeMemory ? { routeMemory } : {}),
      coverage: '仅探索实际经过的单条有界通道，未证明已覆盖地下区域或找到要塞' };
  };
  /** 只把已确认落地写成 dug fragment/traversal/拓扑；记忆失败不改身体结果。 */
  const recordRoute = () => {
    if (routeMemory !== undefined || confirmedSegments.length === 0) return;
    if (!ctx.spatial) { routeMemory = { status: 'skipped' }; return; }
    const first = confirmedSegments[0]!;
    const last = confirmedSegments.at(-1)!;
    const polyline = [{ ...first.from }, ...confirmedSegments.map((segment) => ({ ...segment.to }))];
    const fragment: PathFragment = {
      id: `dug:${ctx.taskId}:${origin.observationId}`,
      worldId: origin.worldId,
      dim: origin.dim,
      kind: 'dug',
      entrances: [{ ...first.from }],
      polyline,
      geometrySource: 'traversal',
      links: confirmedSegments.map((segment) => ({ a: { ...segment.from }, b: { ...segment.to } })),
      deepestY: Math.min(...polyline.map((point) => point.y)),
      createdAt: first.observedAt,
      lastUsedAt: last.observedAt,
      uses: 1,
      externalRef: ctx.taskId,
      metadata: { curio: { v: 1, type: 'route', source: 'excavate_run', mode: args.mode } },
    };
    const segments: WalkCorridorSegment[] = confirmedSegments.map((segment, index) => ({
      id: `${fragment.id}:${index}`,
      fragmentId: fragment.id,
      from: { ...segment.from },
      to: { ...segment.to },
      worldId: origin.worldId,
      dim: origin.dim,
      sessionId: segment.sessionId,
      observedAt: segment.observedAt,
      source: 'confirmed_excavate_run',
      executionId: ctx.taskId,
      ...(args.mode === 'tunnel' ? { mode: 'walk' as const } : {}),
    }));
    const outcome = ctx.spatial.recordRouteCorridor({ fragment, segments });
    routeMemory = outcome.status === 'written'
      ? { status: 'written', fragmentId: outcome.fragmentId, traversalIds: outcome.traversalIds }
      : { status: 'failed', fragmentId: outcome.fragmentId, traversalIds: outcome.traversalIds, stage: outcome.stage, message: outcome.message };
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
    standingCell(ctx, origin.pos, ledger, args);
    if (Math.abs(origin.pos.y - Math.round(origin.pos.y)) > 0.01) {
      const stop = new ExcavationStop('BAD_ARGS', `当前脚高 y=${origin.pos.y.toFixed(2)}，站在半格/非整块支撑上；整格阶梯/通道会挖掉这层支撑，未实现半格脚高转换，未开始`, true, 'capability');
      stop.remediation = { action: 'move_step', at: voxel(origin.pos), reason: 'fractional_foot_support' };
      throw stop;
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
      standingCell(ctx, current.pos, ledger, args);
      if (Math.abs(current.pos.y - Math.round(current.pos.y)) > 0.01) {
        const stop = new ExcavationStop('BAD_ARGS', `脚高 y=${current.pos.y.toFixed(2)} 站在半格/非整块支撑上；整格开挖未实现半格脚高转换`, true, 'capability');
        stop.remediation = { action: 'move_step', at: here, reason: 'fractional_foot_support' };
        throw stop;
      }
      let next = { x: here.x + direction.x, y: here.y + (args.mode === 'stairs' ? -1 : args.mode === 'stairs_up' ? 1 : 0), z: here.z + direction.z };
      // 下一落脚要落在 next.y。先按碰撞顶面确认脚下支撑：空气/未知/半格顶面都在挖掘前报缺口。
      // 只有 Agent 显式给了 fill 才用指定材料补这一格；否则不擅自消耗背包方块。
      let supportProblemNow = supportProblem(ctx, { x: next.x, y: next.y - 1, z: next.z }, next.y, `[${args.direction}] 下一落点`, ledger, args);
      // 下行阶梯的下一级没有精确支撑、但同列下方 1..4 格就有安全整块楼面时，按更低的实际脚面继续，
      // 不消耗材料。Agent 已经选择“向下开阶梯”，落到下一处实际楼面属于执行这项委托；只有危险、未知、
      // 半格脚高或落差 >4 才停下，把缺口交回给 Agent 决定 descend_to/place_support/换方向。
      if (supportProblemNow && args.mode === 'stairs') {
        const below = supportProblemNow.below;
        const found = below?.found;
        const safeDrop = found !== null && found !== undefined && !below!.hazardAt && !below!.unknownAt
          && found.drop > 0 && found.drop <= 4 && Math.abs(found.foot - Math.round(found.foot)) <= 1e-6;
        if (safeDrop) {
          const adjusted = { ...next, y: found!.foot };
          const adjustedProblem = supportProblem(ctx, { x: adjusted.x, y: adjusted.y - 1, z: adjusted.z }, adjusted.y, `[${args.direction}] 下一落点`, ledger, args);
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
          // 补支撑统一交给 place_support：它在内部处理站位/边缘放置并复核可站顶面，避免第二套支撑逻辑。
          const placed = await placeSupport.run(ctx, { at: [0, 0, 0], xyz: supportCell, facing: FACING[args.direction], item: fillItem });
          if (placed.status !== 'succeeded') {
            const attempts = (placed.data as { attempts?: unknown } | undefined)?.attempts;
            const failureCode = placed.failureCode ?? 'PATH_NOT_FOUND';
            // 只有「仍无支撑」才是缺支撑；材料/工具/效果类失败是能力缺口，不能继续报 missing_support。
            const stop = new ExcavationStop(failureCode,
              `[${args.direction}] 下一落点 (${next.x},${next.y},${next.z}) 的支撑格 (${supportCell.x},${supportCell.y},${supportCell.z}) 是 ${supportState.name}；按 fill:"${args.fill}" 调用 place_support 没成：${placed.summary}${Array.isArray(attempts) ? `；站位尝试 ${JSON.stringify(attempts)}` : ''}`, false, failureCode === 'PATH_NOT_FOUND' ? 'missing_support' : 'capability');
            if (Array.isArray(attempts)) stop.fillAttempts = attempts as Record<string, unknown>[];
            stop.nextLanding = { ...next };
            stop.supportMissing = supportGap(stop.nextLanding, args.direction, args.fill);
            stop.remediation = { action: 'place_support', at: stop.supportMissing.at, item: stop.supportMissing.item, reason: stop.supportMissing.reason };
            throw stop;
          }
          const actual = String((placed.data as { placed?: unknown } | undefined)?.placed ?? args.fill);
          filled++;
          fillFacts.push({ at: supportCell, item: actual });
          supportProblemNow = supportProblem(ctx, supportCell, next.y, `[${args.direction}] 下一落点`, ledger, args);
          if (supportProblemNow) {
            const stop = new ExcavationStop(supportProblemNow.code,
              `[${args.direction}] 下一落点 (${next.x},${next.y},${next.z}) 的支撑格 (${supportCell.x},${supportCell.y},${supportCell.z}) 已按 fill 放了 ${actual}，但仍不能确认支撑：${supportProblemNow.message}`, supportProblemNow.unsupportedGeometry, supportProblemNow.kind);
            stop.nextLanding = supportProblemNow.nextLanding;
            stop.below = supportProblemNow.below;
            stop.supportMissing = supportProblemNow.supportMissing;
            stop.remediation = supportProblemNow.remediation;
            throw stop;
          }
        }
      }
      if (supportProblemNow) throw supportProblemNow;
      const height = args.mode === 'stairs' ? 3 : 2;
      const cells = preflightColumn(ctx, next, height, ledger, args).reverse();
      // A one-block jump needs extra clearance above the current head before
      // moving. Its floor and the next step block are never dug out.
      const workCheck = () => { preflightColumn(ctx, next, height, ledger, args); if (args.mode === 'stairs_up') preflightColumn(ctx, here, 3, ledger, args); };
      workCheck();
      if (args.mode === 'stairs_up') cells.unshift({ ...here, y: here.y + 2 });
      for (const pos of cells) {
        assertSession(ctx, origin);
        workCheck();
        const before = adapter.blockAt(pos) ?? '';
        if (AIR.has(before)) continue;
        // 指定了工具就交给适配器：只装备这一把，不自动换别的工具；不掉落也照挖，真实失败原因原样报出
        const result = await adapter.dig(pos, signal, args.tool ? { tool: args.tool } : undefined);
        // 先确认这一格是否真的挖空，再检查会话/期限：已经发生的挖掘要计进部分效果，
        // 取消/超时不能把它报成“没挖过”。
        if (!result.ok) {
          assertSession(ctx, origin);
          // 适配器返回的 TOOL_MISSING（可能带前缀说明）原样报出，不吞成笼统的 ERROR
          throw new ExcavationStop(result.reason?.startsWith('TOOL_MISSING') ? 'TOOL_MISSING' : 'ERROR', `安全通道开挖失败：${result.reason}`);
        }
        // 挖开与采集分开：清路成功但这一格没有掉落时，把事实计进回执，不因此判失败。
        if (result.noDrop) noDropBlocks++;
        // 工作面自身的下落方块默认可挖，但挖后要复核目标格：沙/沙砾可能从上方落回填。
        if (falling(before)) await sleep(50, signal);
        const cleared = adapter.blockAt(pos);
        if (cleared === null) {
          assertSession(ctx, origin);
          throw new ExcavationStop('NOT_FOUND', `挖掘后目标格 (${pos.x},${pos.y},${pos.z}) 未加载/未知，不能确认已经挖空`, false, 'unknown');
        }
        if (!AIR.has(cleared)) {
          assertSession(ctx, origin);
          const stop = new ExcavationStop('EFFECT_NOT_CONFIRMED', `挖掘后复核目标格 (${pos.x},${pos.y},${pos.z})：实际是 ${cleared}，不是空气${falling(before) ? `（原工作面 ${before} 是下落方块，可能被上方落下的方块回填）` : ''}`, false, falling(before) ? 'risk' : 'capability');
          stop.refill = { at: { ...pos }, name: cleared };
          throw stop;
        }
        // 只有挖后复核确实变成空气才计入：这时才是已确认的自身动作修改。
        markSelfModified(ctx.spatial, origin.dim, pos, ctx.taskId);
        excavated++;
        assertSession(ctx, origin);
      }
      workCheck();
      standingCell(ctx, next, ledger, args);
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
      preflightColumn(ctx, next, height, ledger, args);
      standingCell(ctx, next, ledger, args);
      completed++;
      path.push({ pos: { ...landed.pos }, observationId: landed.observationId });
      const segmentFrom = confirmedSegments.at(-1)?.to ?? { ...origin.pos };
      confirmedSegments.push({ from: { ...segmentFrom }, to: { ...landed.pos }, sessionId: origin.sessionId, observedAt: Date.now() });
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
      if (await observe()) {
        recordRoute();
        return ok(`有界开挖中观察到目标，保留实际入口与路径${dropNote()}${fillNote()}${noDropNote()}`, { ...details(), stoppedByObservation: true });
      }
    }
    recordRoute();
    return ok(`实际探索 ${completed} 格${args.mode === 'stairs' ? '下降阶梯' : args.mode === 'stairs_up' ? '上升阶梯' : '水平通道'}${dropNote()}${fillNote()}${noDropNote()}，保留下一入口；尚未证明找到结构`, details());
  } catch (error) {
    if (isAbort(error)) {
      // 取消/超时也要保留已经实际挖掉的格数与路径；不足一步的移动不算完成，不伪造入口。
      recordRoute();
      (error as Error & { partial?: Record<string, unknown> }).partial = details();
      throw error;
    }
    recordRoute();
    const msg = (error as Error).message;
    const cavity = error instanceof ExcavationStop && error.nextLanding ? cavityGap(ctx, error.nextLanding, error.below, fillTried) : null;
    const fall = cavity && 'fall' in cavity ? cavity.fall : null;
    // 风险/缺支撑/能力缺口分别给结构化事实和一步补救；只有 impossible/unknown/budget 不再附建议。
    const unaccepted = ledger.risks.find((risk) => !risk.accepted);
    const remediation: Remediation | undefined = error instanceof ExcavationStop
      ? error.remediation ?? (error.refill
        ? { action: 'move_step', at: error.refill.at, reason: 'target_refilled' }
        : error.kind === 'risk' && unaccepted
          ? unaccepted.authorization
            ? { action: 'authorize', authorization: unaccepted.authorization, at: unaccepted.at, reason: 'unaccepted_risk' }
            : { action: 'change_direction', at: unaccepted.at, reason: 'unaccepted_contact_hazard' }
          : undefined)
      : undefined;
    // 拒绝时把「为什么 + 能怎么办」一起报，别只留一句 ERROR 让它盲试
    // 用「液体」标记和方块名判断，不能用单个「水」字：它会把「没有水平承重顶面」误判成液体提示。
    const dropRule = args.mode === 'stairs'
      ? '；stairs 下行遇到安全整格落差 1..4 格会自动继续，这里停下是因为危险、未知、半格脚高或落差更大'
      : args.mode === 'stairs_up'
        ? '；stairs_up 是上行，不会自动下落：要站上这一级得先 place_support 补支撑，或换方向/descend_to'
        : '；tunnel 是平巷，不会自动下落：要过去得先 place_support 补支撑，或换方向/descend_to';
    const hint = /液体|lava|water|岩浆/.test(msg) ? '（先换方向避开液体，或先 place_cell 堵上再挖）'
      : /没有水平承重顶面|传送门/.test(msg) ? '（这一格不是能站的水平承重面：换方向，或先用 mine_cell / place_support 改变这一格）'
      : /下落方块/.test(msg) ? '（下面是沙子/沙砾这类下落方块，换方向或先 place_cell 堵住再挖）'
      : /未知|未加载/.test(msg) ? '（先照亮/转头看清那一格再挖，或换方向）'
      : cavity ? `（下一落点 (${cavity.nextLanding.x},${cavity.nextLanding.y},${cavity.nextLanding.z}) 的支撑格 (${cavity.supportCell.x},${cavity.supportCell.y},${cavity.supportCell.z}) 是空的${fall ? `；实际可站立脚面在 y=${fall.landing.y.toFixed(2)}，方块在 (${fall.landing.x},${fall.landing.y - 1},${fall.landing.z})（落差 ${fall.drop.toFixed(Number.isInteger(fall.drop) ? 0 : 2)} 格${fall.damage ? `，按当前生命预计约 ${fall.damage} 点摔伤` : ''}）` : ''}${dropRule}；${args.fill ? '已带 fill：补支撑失败时先确认材料和站位，或换方向/换落点；没有去挖/垫别处' : '要补支撑得自己显式 place_support 这一格，或换方向，或选落点用 descend_to；本次开挖没有自动垫方块'}）`
      : /下面是空的|洞穴|虚空/.test(msg) ? `（前面脚下是空的：要补支撑得自己显式 place_support，或换方向、下去探这个洞${dropRule}）`
      : /支撑面在|半格|整格脚高/.test(msg) ? '（落点实际支撑顶面与所选脚高不符；可确认落点高度、换一格/换方向，或改用 move_step 明确落脚）'
      : /身体空间|干燥|站稳/.test(msg) ? '（先挖开落点那两格的脚/头空间，或换方向）'
      : '';
    const unsupported = error instanceof ExcavationStop && error.unsupportedGeometry ? { unsupportedGeometry: true } : {};
    const stop = error instanceof ExcavationStop ? { stopKind: error.kind, decisionRequired: error.kind !== 'impossible' } : {};
    const structured = error instanceof ExcavationStop
      ? { ...(error.supportMissing ? { supportMissing: error.supportMissing } : {}), ...(remediation ? { remediation } : {}), ...(error.refill ? { refill: error.refill } : {}), ...(error.fillAttempts ? { fillAttempts: error.fillAttempts } : {}) }
      : {};
    return fail(error instanceof ExcavationStop ? error.code : codeFromError(error), `有界开挖停止：${msg}${hint}`, { ...details(), ...unsupported, ...stop, ...(cavity ? { cavity } : {}), ...structured });
  }
}

export const excavationSkill: Skill<ExcavationArgs> = {
  name: 'excavate_path',
  description: '显式选择后，从实际当前位置或附近可信入口开挖单条有界下降/上升阶梯或水平通道；每次最多8格，逐格确认能否挖开、地板、跳跃头部空间、干燥和真实落地。stairs 下行时，下一级支撑格为空但同列 1..4 格内有安全整格楼面，会按实际楼面继续下落，不消耗材料；危险、未知、半格或更大落差才停。工作面自身的沙/沙砾默认可挖并在挖后复核；落点或身体上方的下落方块需要 allowFalling。可加 fill 明确授权用哪种方块补下一级支撑（会消耗材料）；补支撑时先在当前站位试，必要时退/侧移一格或潜行到方块边缘再放同一个目标格，补不上就在挖前停下并报缺口，不把手工 place_support 的工作推回给你。可加 tool 明确本轮用哪件工具（先装备到主手）；指定后不会自动改用别的工具，该工具不在背包时返回 TOOL_MISSING；能挖开但采不到掉落时照样挖开并回报 noDrop，预计耗时超出动作预算才报 HAND_DIG_TIMEOUT。只报告实际路线，不保证覆盖地下、登塔或找到结构。',
  argsDoc: '{"entry":"current|<waypointId>","mode"?:"stairs|stairs_up|tunnel","direction":"north|east|south|west","steps"?:1-8,"tool"?:"物品注册名，如 iron_pickaxe（不掉落也会挖开并回报 noDrop）","fill"?:"<方块名>|any","wet"?:true,"lava"?:true,"allowFalling"?:true}（fill 授权补支撑、耗材料；wet/lava 接受相邻液体流入；allowFalling 接受落点/身体上方的下落方块，工作面自身的沙砾默认可挖并复核；这些都不写时在风险前停下；邻格未加载只跳过、不阻断）', timeoutMs: 180000, movement: true,
  validate(raw, adapter) {
    const value = obj(raw), mode = value.mode ?? 'stairs', steps = value.steps ?? 4, tool = value.tool;
    if (typeof value.entry !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.entry)) return { ok: false, error: 'entry 为 current 或可信入口ID' };
    if (!['stairs', 'stairs_up', 'tunnel'].includes(mode) || typeof value.direction !== 'string' || !Object.hasOwn(DIRECTIONS, value.direction) || !Number.isInteger(steps) || steps < 1 || steps > 8) return { ok: false, error: 'mode=stairs|stairs_up|tunnel；direction=north|east|south|west；steps 为1-8整数' };
    if (tool !== undefined && (typeof tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(tool))) return { ok: false, error: 'tool 为可选物品注册名（小写字母、数字、下划线，如 iron_pickaxe）；不写则沿用身体自己的换工具规则' };
    const fill = value.fill;
    if (fill !== undefined && (typeof fill !== 'string' || !/^[a-z0-9_]{1,80}$/.test(fill) || (fill !== 'any' && !adapter.isKnownItem(fill)))) {
      return { ok: false, error: 'fill 为可选方块名或 "any"（如 netherrack）；不写则不补支撑' };
    }
    if (typeof fill === 'string' && /_(boat|raft)$/.test(fill)) return { ok: false, error: `${fill} 是船/筏（实体，不是方块），不能用来补支撑` };
    for (const flag of ['wet', 'lava', 'allowFalling'] as const) {
      if (value[flag] !== undefined && typeof value[flag] !== 'boolean') return { ok: false, error: `${flag} 需要布尔值` };
    }
    return { ok: true, args: {
      entry: value.entry, mode, direction: value.direction as ExcavationArgs['direction'], steps,
      ...(tool !== undefined ? { tool } : {}), ...(typeof fill === 'string' ? { fill } : {}),
      ...(value.wet === true ? { wet: true } : {}), ...(value.lava === true ? { lava: true } : {}),
      ...(value.allowFalling === true ? { allowFalling: true } : {}),
    } };
  },
  run: excavatePath,
};
