import { walkLandRules } from '../../adapter/land-rules.ts';
import type { EntityInfo, Vec3Like } from '../../adapter/types.ts';
import { bodyCells, footSurfaceY, supportTop, type StateAt } from '../../perception/geometry.ts';
import { feetCell } from '../../perception/local.ts';
import { LIQUID_BLOCKS } from '../../perception/surroundings.ts';
import {
  isDangerousBlock,
  searchLandRouteAsync,
  summarizeBoundaries,
  type LandSearchBoundarySummary,
  type LandSearchResult,
  type LandSearchTransition,
} from '../../spatial/land-search.ts';
import { fail, isAbort, obj, ok, runSkill, validateSkill, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';
import { inspectBody, stateReader } from './facts.ts';
import { navigateTo } from './navigate.ts';
import { blockerOf } from './route.ts';

type Kind = 'walk' | 'step' | 'drop';
type Target =
  | { kind: 'position'; pos: Vec3Like }
  | { kind: 'block'; pos: Vec3Like }
  | { kind: 'entity'; id?: number; name?: string };
type Args = {
  target: Target;
  radius: number;
  allowed: Kind[];
  historical: boolean;
  /** 调用方显式给的总步数上限；省略时按选定路线推导，避免默认 16 段截断普通近距离接近。 */
  maxSteps?: number;
  allowUnknownCorridor: boolean;
};
type Outcome =
  | 'ARRIVED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN' | 'UNSUPPORTED'
  | 'INVALIDATED' | 'BUDGET_EXCEEDED' | 'NOT_CONFIRMED' | 'TIMEOUT' | 'CANCELLED';
type RouteMode = 'current' | 'historical' | 'prefix' | 'none';

interface Candidate { cell: Vec3Like; stance: Vec3Like; foot: number }

interface Evaluation {
  candidate: Candidate;
  strict: LandSearchResult;
  result: LandSearchResult;
  mode: RouteMode;
  planned: readonly LandSearchTransition[];
  disallowed: LandSearchTransition | null;
  boundaries: LandSearchBoundarySummary;
  /** 历史路线按当前证据复验后还能执行的段数（首个 BLOCKED 之前）；当前证据路线为 null。 */
  executableSteps: number | null;
  /** 历史路线在当前证据下第一步就 BLOCKED：不能执行，不能当候选。 */
  deadRoute: boolean;
  /** 路线搜索解析出的落脚点与适配器实测验证的站位不一致。 */
  targetMismatch: boolean;
}

const KINDS: readonly Kind[] = ['walk', 'step', 'drop'];
const AIR = /^(air|cave_air|void_air)$/;
const DEFAULT_RADIUS = 32;
/** 局部接近的配置上限；视觉范围只能再把它调低。 */
const MAX_RADIUS = 32;
/** 视觉范围读不到时的局部回退半径；不把“未知视距”当成大范围。 */
const FALLBACK_VISUAL_RANGE = 12;
/** navigate_to 自身的硬上限；不是默认值。 */
const HARD_MAX_STEPS = 64;
const ROUTE_STEP_MARGIN = 2;
/** 所有候选站位共享的路线搜索预算。 */
const SEARCH_BUDGET_MS = 3000;
const SEARCH_SLICE_MIN_MS = 75;
const MAX_SEARCHED_STANCES = 8;
/** 每轮最多围绕多少个候选站位做有界局部观察（目标附近，不是整条路线）。 */
const OBSERVATION_STANCES = 8;
const STANCE_TOLERANCE = 0.05;
const POSITION_TOLERANCE = 0.75;
const POSITION_HEIGHT_TOLERANCE = POSITION_TOLERANCE;
const BODY_CENTER_HEIGHT = 0.9;
/** 实测位移超过这个值就不能说“没有发生部分进展”。 */
const MOVEMENT_EPS = 0.05;
const BLOCK_REACH = 2.5;
const ENTITY_REACH = 3.0;
/** 实体在搜索后小幅移动仍按同一接近处理；超过交互距离再加这个余量才判失效。 */
const ENTITY_MOVE_SLACK = 1;
/** 累计物理位移预算：最短路线超过直线距离的这个倍数加余量就不算“局部接近”。 */
const MAX_DETOUR_FACTOR = 3;
const DETOUR_SLACK = 8;
const PORTAL = new Set(['nether_portal', 'end_portal', 'end_gateway']);
/** 床/箱子/传送门的另一半不是“旁边的站立格”，必须排除。 */
const MULTI_CELL = /(_bed$|(^|_)chest$|nether_portal|end_portal|end_gateway)/;
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const Y_OFFSETS = [-1, 0, 1] as const;

const stem = (name: string) => name.replace(/^minecraft:/, '');
const round2 = (v: number) => Math.round(v * 100) / 100;
const cellKey = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
const dist3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bodyCenter = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y + BODY_CENTER_HEIGHT, z: p.z });
const entityCenter = (e: EntityInfo): Vec3Like => ({
  x: e.pos.x, y: e.pos.y + (e.height !== undefined && e.height > 0 ? e.height / 2 : BODY_CENTER_HEIGHT), z: e.pos.z,
});

const point = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

function entityTarget(e: unknown): Target | string {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entity 需要 {id?} 或 {name?}';
  const r = e as Record<string, unknown>;
  if (r.id !== undefined && (!Number.isInteger(r.id) || (r.id as number) < 0)) return 'entity.id 必须是非负整数';
  if (r.name !== undefined && (typeof r.name !== 'string' || !r.name.trim())) return 'entity.name 必须是非空字符串';
  if (r.id === undefined && r.name === undefined) return 'entity 需要 id 或 name';
  return { kind: 'entity', ...(r.id !== undefined ? { id: r.id as number } : {}), ...(r.name !== undefined ? { name: String(r.name) } : {}) };
}

function targetOf(raw: unknown): Target | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'target 必须是对象，例如 {"pos":{"x":0,"y":64,"z":0}}';
  const t = raw as Record<string, unknown>;
  const keys = Object.keys(t).filter((k) => t[k] !== undefined);
  const kind = typeof t.kind === 'string' ? t.kind.trim().toLowerCase() : undefined;
  // validate() 返回的是规范化 target，而 Arbiter 在执行前会再校验一次；必须接受自己的输出。
  // 实体规范化后是扁平的 {kind:"entity", id?, name?}，位置/方块是 {kind, pos}。
  if (kind === 'entity' && !('pos' in t) && !('block' in t) && !('entity' in t)
    && keys.every((k) => k === 'kind' || k === 'id' || k === 'name')) {
    return entityTarget({ id: t.id, name: t.name });
  }
  // kind 只是目标类型的说明，必须与唯一的目标键一致；规范化后的方块目标也写作 {kind:"block", pos}。
  const payload = keys.filter((k): k is 'pos' | 'block' | 'entity' => k === 'pos' || k === 'block' || k === 'entity');
  const key = payload[0];
  const effective = kind === 'position' ? (key === 'pos' ? 'position' : undefined)
    : kind === 'block' ? (key === 'pos' || key === 'block' ? 'block' : undefined)
    : kind === 'entity' ? (key === 'entity' ? 'entity' : undefined)
    : key === 'pos' ? 'position' : key === 'block' ? 'block' : key === 'entity' ? 'entity' : undefined;
  const foreign = keys.filter((k) => k !== 'kind' && k !== 'pos' && k !== 'block' && k !== 'entity');
  if (foreign.length || payload.length !== 1 || effective === undefined) {
    return `target 必须且只能指定 pos、block 或 entity 之一，例如 {"pos":{"x":0,"y":64,"z":0}}；不要再套 kind`;
  }
  if (effective === 'position' || effective === 'block') {
    const p = point(t[key]);
    if (!p) return `${key} 需要 {x,y,z} 三个有限数字`;
    if (effective === 'block' && !['x', 'y', 'z'].every((k) => Number.isInteger(p[k as 'x' | 'y' | 'z']))) {
      return 'block 需要整数方块坐标；站位坐标请用 pos';
    }
    return { kind: effective, pos: p };
  }
  return entityTarget(t.entity);
}

/** 当前已加载列里真实可站立脚高；分别报告未知、无支撑、身体阻挡和危险格，不把未知当空气。 */
type StanceCheck =
  | { status: 'OK'; cell: Vec3Like; stance: Vec3Like; foot: number }
  | { status: 'UNKNOWN'; missing: Vec3Like[] }
  | { status: 'NO_SUPPORT' }
  | { status: 'BLOCKED'; blocker: Vec3Like }
  | { status: 'HAZARD'; hazard: string };

function inspectStance(at: StateAt, cell: Vec3Like): StanceCheck {
  const here = at(cell);
  if (here === null) return { status: 'UNKNOWN', missing: [cell] };
  // 已看清脚格本身是水/岩浆/伤害方块时先报危险，不因为下方未观察就退化成 UNKNOWN。
  const hereName = stem(here.name);
  if (LIQUID_BLOCKS.has(hereName) || isDangerousBlock(hereName) || PORTAL.has(hereName)) return { status: 'HAZARD', hazard: hereName };
  const below = at({ x: cell.x, y: cell.y - 1, z: cell.z });
  const inCellSupport = supportTop(stem(here.name), here.properties ?? {}) !== null;
  if (!inCellSupport && below === null) return { status: 'UNKNOWN', missing: [{ x: cell.x, y: cell.y - 1, z: cell.z }] };
  const foot = footSurfaceY(cell, at);
  if (foot === null) return { status: 'NO_SUPPORT' };
  const body = inspectBody(at, foot, cell.x, cell.z);
  if (body.unknown.length) return { status: 'UNKNOWN', missing: body.unknown };
  const blocker = body.blockers[0];
  if (blocker) return { status: 'BLOCKED', blocker: blocker.cell };
  const support = { x: cell.x, y: Math.floor(foot - 0.05), z: cell.z };
  // 分数脚高时身体会跨三个格（63.5 → 63/64/65）；危险格必须覆盖整个身体，而不只是脚/头两格。
  for (const pos of [...bodyCells(foot, cell.x, cell.z), support]) {
    const state = at(pos);
    if (state === null) continue;
    const name = stem(state.name);
    if (LIQUID_BLOCKS.has(name) || isDangerousBlock(name) || PORTAL.has(name)) return { status: 'HAZARD', hazard: name };
  }
  return { status: 'OK', cell, stance: { x: cell.x + 0.5, y: foot, z: cell.z + 0.5 }, foot };
}

/** 同一多方块（床/双箱/传送门）占据的格；这些格不能当站立格。 */
function structureCells(at: StateAt, cell: Vec3Like, name: string): Set<string> {
  const target = stem(name);
  const out = new Set<string>([cellKey(cell)]);
  if (!MULTI_CELL.test(target)) return out;
  const same = (other: string): boolean => {
    const n = stem(other);
    if (target.endsWith('_bed')) return n === target;
    if (/(^|_)chest$/.test(target)) return /(^|_)chest$/.test(n);
    return n === target;
  };
  for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const pos = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    const state = at(pos);
    if (state !== null && same(state.name)) out.add(cellKey(pos));
  }
  return out;
}

type RejectionKind =
  | 'STRUCTURE' | 'UNKNOWN' | 'MISSING_SUPPORT' | 'BODY_BLOCKED' | 'HAZARD' | 'PORTAL' | 'OUT_OF_REACH' | 'OUT_OF_RADIUS';
type Rejected = {
  cell: Vec3Like;
  status: 'STRUCTURE' | 'UNKNOWN' | 'UNSUPPORTED' | 'OUT_OF_REACH' | 'OUT_OF_RADIUS';
  kind: RejectionKind;
  reason: string;
  cellBlockers?: Vec3Like[];
};

/** 目标周围的候选站立格 → 只保留真实支撑、身体净空、无危险且够得着的站位。 */
function stanceCandidates(
  at: StateAt, targetCell: Vec3Like, targetCenter: Vec3Like, structure: Set<string>,
  start: Vec3Like, radius: number, reachLimit: number,
): { valid: Candidate[]; rejected: Rejected[] } {
  const valid: Candidate[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();
  for (const [dx, dz] of DIRS8) for (const dy of Y_OFFSETS) {
    const cell = { x: targetCell.x + dx, y: targetCell.y + dy, z: targetCell.z + dz };
    if (structure.has(cellKey(cell))) {
      rejected.push({ cell, status: 'STRUCTURE', kind: 'STRUCTURE', reason: '该格属于同一多方块，不是旁侧站立格' });
      continue;
    }
    const check = inspectStance(at, cell);
    if (check.status === 'UNKNOWN') {
      rejected.push({ cell, status: 'UNKNOWN', kind: 'UNKNOWN', reason: '站位支撑/净空未观察', cellBlockers: check.missing });
      continue;
    }
    if (check.status === 'NO_SUPPORT') {
      rejected.push({ cell, status: 'UNSUPPORTED', kind: 'MISSING_SUPPORT', reason: '这一列没有可站立支撑面' });
      continue;
    }
    if (check.status === 'BLOCKED') {
      rejected.push({ cell, status: 'UNSUPPORTED', kind: 'BODY_BLOCKED', reason: '身体空间被方块占据', cellBlockers: [check.blocker] });
      continue;
    }
    if (check.status === 'HAZARD') {
      rejected.push({ cell, status: 'UNSUPPORTED', kind: PORTAL.has(check.hazard) ? 'PORTAL' : 'HAZARD', reason: `站位接触危险方块 ${check.hazard}` });
      continue;
    }
    const footCell = feetCell(check.stance);
    if (structure.has(cellKey(footCell))) {
      rejected.push({ cell, status: 'STRUCTURE', kind: 'STRUCTURE', reason: '解析出的脚位属于同一多方块' });
      continue;
    }
    const key = `${check.cell.x},${round2(check.foot)},${check.cell.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dist3(start, check.stance) > radius) {
      rejected.push({ cell: check.cell, status: 'OUT_OF_RADIUS', kind: 'OUT_OF_RADIUS', reason: '站位超出局部接近范围' });
      continue;
    }
    const reach = dist3(bodyCenter(check.stance), targetCenter);
    if (reach > reachLimit) {
      rejected.push({ cell: check.cell, status: 'OUT_OF_REACH', kind: 'OUT_OF_REACH', reason: `站位到目标 ${reach.toFixed(2)} 格，超出交互距离 ${reachLimit}` });
      continue;
    }
    valid.push({ cell: check.cell, stance: check.stance, foot: check.foot });
  }
  return { valid, rejected };
}

/**
 * navigate_to 结局 → approach_visible 结局。
 * navigate_to 把 invalidation 放在 data.segment.invalidation，且不回传搜索 stats；
 * 这里只读真实存在的字段，并用调用方保留的 strict 搜索状态区分预算耗尽与期限耗尽。
 */
function navigationOutcome(moved: SkillResult, searchStatus: LandSearchResult['status']): { cause: Outcome; executed: number } {
  const data = (moved.data ?? {}) as Record<string, unknown>;
  const executed = typeof data.executed === 'number' ? data.executed : 0;
  const segment = (data.segment ?? {}) as { invalidation?: string };
  const invalidation = typeof segment.invalidation === 'string' ? segment.invalidation : null;
  const blocker = data.blockerAhead as { status?: string } | undefined;
  const cause: Outcome =
    invalidation === 'max_steps' ? 'BUDGET_EXCEEDED'
      : invalidation === 'deadline' ? 'TIMEOUT'
        : invalidation === 'start_drift' || invalidation === 'effect_not_confirmed' ? 'NOT_CONFIRMED'
          // 已知边界优先于“证据不足”的失败码：navigate_to 在 UNKNOWN 搜索下也会报 NOT_FOUND。
          : blocker !== undefined ? (blocker.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'BLOCKED')
            : moved.failureCode === 'TIMEOUT' ? (searchStatus === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXCEEDED' : 'TIMEOUT')
              : moved.failureCode === 'NOT_FOUND' ? 'UNKNOWN'
                : moved.failureCode === 'PATH_NOT_FOUND' ? 'BLOCKED'
                  : moved.failureCode === 'EFFECT_NOT_CONFIRMED' ? 'NOT_CONFIRMED'
                    : moved.failureCode === 'BAD_ARGS' ? 'UNSUPPORTED'
                      : moved.failureCode === 'TARGET_GONE' ? 'INVALIDATED'
                        : moved.failureCode === 'WRONG_DIMENSION' || moved.failureCode === 'NOT_CONNECTED' ? 'UNSUPPORTED'
                          : 'BLOCKED';
  return { cause, executed };
}

/** 失败码只是给调度/心智的粗分类；具体 UNKNOWN/STALE/BLOCKED 等事实放在 outcome/evidence 里。 */
const failureCodeOf = (outcome: Outcome): FailureCode => {
  switch (outcome) {
    case 'UNSUPPORTED': return 'PATH_NOT_FOUND';
    case 'UNKNOWN': return 'NOT_FOUND';
    case 'TIMEOUT':
    case 'BUDGET_EXCEEDED': return 'TIMEOUT';
    case 'PARTIAL':
    case 'NOT_CONFIRMED': return 'EFFECT_NOT_CONFIRMED';
    case 'INVALIDATED': return 'TARGET_GONE';
    default: return 'PATH_NOT_FOUND';
  }
};

const evidenceStateOf = (result: LandSearchResult | undefined): 'CURRENT' | 'STALE' | 'UNKNOWN' => {
  if (result?.status === 'FOUND' && result.evidenceMode === 'current') return 'CURRENT';
  return result !== undefined && result.stats.staleEdges > 0 ? 'STALE' : 'UNKNOWN';
};

const routeSummary = (evaluation: Evaluation) => ({
  stance: { ...evaluation.candidate.stance },
  cell: { ...evaluation.candidate.cell },
  foot: evaluation.candidate.foot,
  mode: evaluation.mode,
  status: evaluation.result.status,
  evidenceMode: evaluation.result.evidenceMode,
  cost: evaluation.result.cost,
  steps: evaluation.planned.length,
  ...(evaluation.executableSteps === null ? {} : { executableSteps: evaluation.executableSteps }),
  ...(evaluation.deadRoute ? { deadRoute: true } : {}),
  ...(evaluation.targetMismatch ? { targetMismatch: true, resolvedTarget: { ...evaluation.result.resolvedTarget } } : {}),
  ...(evaluation.boundaries.total === 0 ? {} : { boundaries: evaluation.boundaries.counts }),
  ...(evaluation.disallowed === null ? {} : { disallowed: evaluation.disallowed.kind }),
});

const modeRank = (mode: RouteMode) => mode === 'current' ? 0 : mode === 'historical' ? 1 : mode === 'prefix' ? 2 : 3;

/**
 * 接近一个已经由感知或空间记忆识别出的附近目标：位置/方块/实体。
 * 只做局部选点与一次有界接近，复用现有 land-search + navigate_to 执行；
 * 不改目标、不挖/放/建、不换维度、不调用旧 Pathfinder。
 */
export const approachVisible: Skill<Args> = {
  name: 'approach_visible',
  description: '接近一个已经看见或记得的附近目标：位置（站立脚位）、方块（走到旁侧合法站立格）或实体。先用已观察几何验证支撑、身体净空、危险格和交互距离，再在所有合法站位中比较已观察路线（当前证据优先，可用历史体素候选），只执行一次有界接近；不改目标、不挖/放/建、不换维度、不调用旧 Pathfinder。ARRIVED 只按实测位置与原到达条件确认；未到达时返回 PARTIAL/UNKNOWN/BLOCKED/UNSUPPORTED/INVALIDATED 等真实结局与边界。',
  argsDoc: '{"target":{"pos":{"x":0,"y":64,"z":0}}} 或 {"target":{"block":{"x":0,"y":64,"z":0}}} 或 {"target":{"entity":{"id":123}}} 或 {"target":{"entity":{"name":"cow"}}}（target 里只放 pos/block/entity 之一，不要再套 kind；block 是整数方块坐标，不是站立格；entity 需已看见/记得）；"radius"?:32（默认 32、上限 32，且不超过当前视觉有效范围）, "allowed"?:["walk","step","drop"], "historical"?:true, "maxSteps"?:1-64（省略时按选定路线推导）, "allowUnknownCorridor"?:false。',
  timeoutMs: 45000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const target = targetOf(a.target);
    if (typeof target === 'string') return { ok: false, error: target };
    const radius = a.radius === undefined ? DEFAULT_RADIUS : Number(a.radius);
    if (!Number.isFinite(radius) || radius < 1 || radius > MAX_RADIUS) return { ok: false, error: `radius 需要 1–${MAX_RADIUS} 的有限数字；视觉范围只能再把它调低` };
    const allowedRaw = a.allowed === undefined ? KINDS : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((k) => !KINDS.includes(k as Kind))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    if (a.maxSteps !== undefined && (!Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > HARD_MAX_STEPS)) {
      return { ok: false, error: `maxSteps 需要 1–${HARD_MAX_STEPS} 的整数` };
    }
    if (a.allowUnknownCorridor !== undefined && typeof a.allowUnknownCorridor !== 'boolean') return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    return {
      ok: true,
      args: {
        target, radius: Math.round(radius * 100) / 100,
        allowed: [...new Set(allowedRaw as Kind[])],
        historical: a.historical !== false,
        ...(a.maxSteps === undefined ? {} : { maxSteps: a.maxSteps as number }),
        allowUnknownCorridor: a.allowUnknownCorridor === true,
      },
    };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial?.session?.voxel) return fail('NOT_CONNECTED', 'approach_visible 需要共享空间 VoxelMap；当前没有接线');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'approach_visible 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', '当前世界与空间会话不一致');
    if (spatial.closing || spatial.paused) {
      return fail('NOT_CONNECTED', '共享空间会话已暂停/已关闭，不能做局部接近');
    }
    const start = { ...state.pos };
    const target = args.target;
    const currentRange = ctx.senses.effectiveRange?.();
    const hasRange = currentRange !== undefined && Number.isFinite(currentRange) && currentRange > 0;
    const visualCap = Math.min(MAX_RADIUS, hasRange ? currentRange : FALLBACK_VISUAL_RANGE);
    const radius = Math.min(args.radius, visualCap);
    const snapshot = () => {
      const position = { ...ctx.adapter.state().pos };
      return { position, displacement: round2(dist3(start, position)) };
    };
    const base = {
      originalTarget: target, targetKind: target.kind,
      radius, requestedRadius: args.radius,
      visualRange: { value: visualCap, source: hasRange ? 'effectiveRange' : 'fallback' },
    };
    const cancelled = (reason: string, extra: Record<string, unknown> = {}) => {
      const { position, displacement } = snapshot();
      return { status: 'cancelled' as const, summary: `approach_visible 已取消；原目标未改变。${reason}`, data: { ...base, outcome: 'CANCELLED' as const, position, displacement, ...extra } };
    };
    if (ctx.signal.aborted) return cancelled('开始前已取消。');
    if (Date.now() >= ctx.deadline) {
      return fail('TIMEOUT', 'approach_visible 的父委托期限在开始前已耗尽，没有移动', {
        ...base, outcome: 'TIMEOUT', stop: 'TIMEOUT', position: start, displacement: 0, resolvedStance: null,
      });
    }
    // 站位几何用当前已加载 blockstate（与 move_step 执行前检查同一来源）；路线用 VoxelMap 证据；
    // 目标附近的证据缺口再由下面的有界观察补进同一张共享地图。
    const at = stateReader(ctx.adapter);
    const voxel = spatial.session.voxel;

    // ---- 1. 目标解析：位置直接是站位；方块/实体先找合法旁侧站位。 ----
    let targetName: string | null = null;
    let targetCell: Vec3Like | undefined;
    let entity: EntityInfo | undefined;
    let targetEvidence: 'current_perception' | 'voxel' | 'unobserved' | 'requested_stance' = 'unobserved';
    let targetFreshness: 'FRESH' | 'STALE' | undefined;
    let targetFreshlyObserved = false;
    let structure = new Set<string>();
    let valid: Candidate[];
    let rejected: Rejected[];

    if (target.kind === 'position') {
      const distance = dist3(start, target.pos);
      if (distance > radius) {
        return fail('BAD_ARGS', `目标位置 ${JSON.stringify(target.pos)} 距当前 ${distance.toFixed(1)} 格，超出局部接近范围 ${radius} 格`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0,
        });
      }
      targetCell = feetCell(target.pos);
      const check = inspectStance(at, targetCell);
      if (check.status === 'UNKNOWN') {
        return fail('NOT_FOUND', `目标位置所在的列 (${targetCell.x},${targetCell.y},${targetCell.z}) 支撑/净空未观察，不能把未知当作可达`, {
          ...base, outcome: 'UNKNOWN', evidenceState: 'UNKNOWN', position: start, displacement: 0,
          unknown: check.missing, resolvedStance: null,
        });
      }
      if (check.status === 'NO_SUPPORT') {
        return fail('PATH_NOT_FOUND', `目标位置所在的列 (${targetCell.x},${targetCell.y},${targetCell.z}) 没有已观察的可站立支撑面`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null,
        });
      }
      if (check.status === 'BLOCKED') {
        return fail('PATH_NOT_FOUND', `目标位置所在的身体空间被方块占据 (${check.blocker.x},${check.blocker.y},${check.blocker.z})`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null, blockedBy: check.blocker,
        });
      }
      if (check.status === 'HAZARD') {
        return fail('PATH_NOT_FOUND', `目标位置接触危险方块 ${check.hazard}，不按普通接近执行`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null, hazard: check.hazard,
        });
      }
      if (Math.abs(check.foot - target.pos.y) > POSITION_HEIGHT_TOLERANCE) {
        return fail('BAD_ARGS', `目标位置写的是脚高 ${target.pos.y}，这一列实际可站立脚高是 ${check.foot}；相差超出 ${POSITION_HEIGHT_TOLERANCE} 格，不改写你的目标`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: check.stance, actualFoot: check.foot,
        });
      }
      // 半径按解析出的实际站位再核一次；请求点靠近格边时，站位可能略超出裸半径。
      if (dist3(start, check.stance) > radius + POSITION_TOLERANCE) {
        return fail('BAD_ARGS', `解析出的站位 ${JSON.stringify(check.stance)} 距当前 ${dist3(start, check.stance).toFixed(1)} 格，超出局部接近范围 ${radius} 格`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: check.stance,
        });
      }
      valid = [{ cell: check.cell, stance: check.stance, foot: check.foot }];
      rejected = [];
      targetEvidence = 'requested_stance';
    } else if (target.kind === 'block') {
      const cell = { ...target.pos };
      targetCell = cell;
      const center = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
      const distance = dist3(start, center);
      if (distance > radius) {
        return fail('BAD_ARGS', `目标方块 (${cell.x},${cell.y},${cell.z}) 距当前 ${distance.toFixed(1)} 格，超出局部接近范围 ${radius} 格`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null,
        });
      }
      // 当前感知优先；看不见时只接受 VoxelMap 里合法观察过的空间证据。
      // 不拿“区块已加载”当作看见：看着目标接近，但目标本身仍须有观察证据。
      const fresh = ctx.senses.observeBlocks?.([cell]).find((block) => block.pos.x === cell.x && block.pos.y === cell.y && block.pos.z === cell.z);
      const view = voxel.cellAt(state.dim, cell.x, cell.y, cell.z);
      const remembered = view.observed ? view.evidence.observation.state.name : null;
      targetName = fresh?.name ?? remembered;
      targetEvidence = fresh !== undefined ? 'current_perception' : remembered !== null ? 'voxel' : 'unobserved';
      targetFreshlyObserved = fresh !== undefined;
      targetFreshness = fresh !== undefined ? undefined : view.observed ? view.evidence.freshness : undefined;
      if (targetName === null) {
        return fail('NOT_FOUND', `目标方块 (${cell.x},${cell.y},${cell.z}) 未加载/未观察`, {
          ...base, outcome: 'UNKNOWN', evidenceState: 'UNKNOWN', position: start, displacement: 0, resolvedStance: null,
          evidenceSource: targetEvidence,
        });
      }
      if (AIR.test(stem(targetName))) {
        return fail('BAD_ARGS', `目标格 (${cell.x},${cell.y},${cell.z}) 是空气；方块接近要指定方块坐标，位置接近用 pos`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null, evidenceSource: targetEvidence,
        });
      }
      structure = structureCells(at, cell, targetName);
      ({ valid, rejected } = stanceCandidates(at, cell, center, structure, start, radius, BLOCK_REACH));
    } else {
      entity = ctx.senses.perceivedEntities(radius)
        .filter((e) => e.perception !== 'heard'
          && (target.id === undefined || e.id === target.id)
          && (target.name === undefined || stem(e.name) === stem(target.name)))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!entity) {
        return fail('NOT_FOUND', `半径 ${radius} 格内没有看见/记得匹配的实体 ${JSON.stringify(target)}`, {
          ...base, outcome: 'UNKNOWN', evidenceState: 'UNKNOWN', position: start, displacement: 0, resolvedStance: null,
        });
      }
      targetCell = feetCell(entity.pos);
      targetEvidence = 'current_perception';
      const center = entityCenter(entity);
      const distance = dist3(start, center);
      if (distance > radius) {
        return fail('BAD_ARGS', `实体 ${stem(entity.name)} 距当前 ${distance.toFixed(1)} 格，超出局部接近范围 ${radius} 格`, {
          ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0, resolvedStance: null, entity: { ...entity },
        });
      }
      ({ valid, rejected } = stanceCandidates(at, targetCell, center, new Set(), start, radius, ENTITY_REACH));
    }
    if (!valid.length) {
      const unknown = rejected.filter((r) => r.status === 'UNKNOWN').length;
      const outcome: Outcome = rejected.length > 0 && unknown === rejected.length ? 'UNKNOWN' : 'UNSUPPORTED';
      const { position, displacement } = snapshot();
      return fail(failureCodeOf(outcome), `目标 ${target.kind} 周围没有已验证可用的站立格：${valid.length} 个可用、${rejected.length} 个被拒（${[...new Set(rejected.map((r) => r.kind))].join('、') || '无候选'}）`, {
        ...base, outcome, ...(outcome === 'UNKNOWN' ? { evidenceState: 'UNKNOWN' } : {}),
        position, displacement, resolvedStance: null,
        ...(targetCell === undefined ? {} : { targetCell }),
        ...(entity === undefined ? {} : { entity: { ...entity } }),
        rejected,
        rejectedCounts: rejected.reduce<Record<string, number>>((all, r) => ({ ...all, [r.status]: (all[r.status] ?? 0) + 1 }), {}),
        rejectedKinds: rejected.reduce<Record<string, number>>((all, r) => ({ ...all, [r.kind]: (all[r.kind] ?? 0) + 1 }), {}),
      });
    }

    // ---- 2. 有界局部观察：目标/候选站位附近缺证据时，用现有感知补充共享 VoxelMap。 ----
    const observationCells = new Map<string, Vec3Like>();
    const addCell = (p: Vec3Like) => { if (!observationCells.has(cellKey(p))) observationCells.set(cellKey(p), { ...p }); };
    // 目标已在解析时被亲眼观察过就不要再观察一次；同一格同一毫秒的不同内容会被库标成冲突/STALE。
    if (targetCell !== undefined && !targetFreshlyObserved) addCell(targetCell);
    for (const candidate of valid
      .slice()
      .sort((a, b) => dist3(start, a.stance) - dist3(start, b.stance) || a.stance.y - b.stance.y || a.stance.x - b.stance.x || a.stance.z - b.stance.z)
      .slice(0, OBSERVATION_STANCES)) {
      const footCell = feetCell(candidate.stance);
      addCell(candidate.cell);
      addCell({ x: candidate.cell.x, y: Math.floor(candidate.foot - 0.05), z: candidate.cell.z });
      addCell(footCell);
      addCell({ x: footCell.x, y: footCell.y + 1, z: footCell.z });
    }
    const staleInMap = (p: Vec3Like): boolean => {
      const view = voxel.cellAt(state.dim, p.x, p.y, p.z);
      return !view.observed || view.evidence.freshness !== 'FRESH' || view.evidence.validUntil < Date.now();
    };
    const observationPositions = [...observationCells.values()];
    const missingBefore = observationPositions.filter(staleInMap).length;
    const observedCellsBefore = voxel.checkpointFullCounts().observedCells;
    let observedCells = 0;
    let observationAttempted = false;
    const observeBlocks = ctx.senses.observeBlocks;
    if (observeBlocks !== undefined && missingBefore > 0) {
      observationAttempted = true;
      for (let index = 0; index < observationPositions.length; index += 32) {
        if (ctx.signal.aborted) return cancelled('局部观察期间收到取消。', { evidenceSource: targetEvidence, missingBefore });
        if (Date.now() >= ctx.deadline) {
          const { position, displacement } = snapshot();
          return fail('TIMEOUT', '父委托期限在局部观察期间耗尽，没有移动', {
            ...base, outcome: 'TIMEOUT', stop: 'TIMEOUT', position, displacement, resolvedStance: null,
          });
        }
        observedCells += observeBlocks.call(ctx.senses, observationPositions.slice(index, index + 32)).length;
      }
    }
    const newObservedCells = voxel.checkpointFullCounts().observedCells - observedCellsBefore;
    const evidenceFacts = {
      target: {
        kind: target.kind,
        source: targetEvidence,
        ...(targetName === null ? {} : { name: stem(targetName) }),
        ...(targetFreshness === undefined ? {} : { freshness: targetFreshness }),
      },
      stanceGeometry: 'live_adapter_blocks',
      localObservation: {
        attempted: observationAttempted, requested: observationPositions.length, acquired: observedCells, missingBefore,
        /** 共享 VoxelMap 中新增的已观察格数：实际写入覆盖信号，不只是接口返回条数。 */
        newObservedCells,
        unresolved: observationPositions.filter(staleInMap).length,
      },
    };

    // ---- 3. 比较候选站位上的已观察路线；所有候选共用一个搜索期限。 ----
    const ranked = valid
      .slice()
      .sort((a, b) => dist3(start, a.stance) - dist3(start, b.stance) || a.stance.y - b.stance.y || a.stance.x - b.stance.x || a.stance.z - b.stance.z)
      .slice(0, MAX_SEARCHED_STANCES);
    const searchDeadline = Math.min(ctx.deadline, Date.now() + SEARCH_BUDGET_MS);
    const evaluations: Evaluation[] = [];
    for (const [index, candidate] of ranked.entries()) {
      if (ctx.signal.aborted) return cancelled('搜索期间收到取消。', { searched: evaluations.length });
      const remaining = searchDeadline - Date.now();
      if (remaining <= 0) break;
      const slice = Math.max(SEARCH_SLICE_MIN_MS, Math.floor(remaining / (ranked.length - index)));
      const sliceStart = Date.now();
      const sliceEnd = Math.min(searchDeadline, sliceStart + slice);
      // strict 先跑；历史回退拿到同一份剩余时间，不能被 strict 搜完就饿死。
      const strictDeadline = Math.min(sliceEnd, sliceStart + Math.ceil(slice * 0.6));
      const request = {
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
        body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
        to: candidate.stance, maxDrop: 4, rules: walkLandRules, signal: ctx.signal, deadlineMs: strictDeadline,
      };
      const strict = await searchLandRouteAsync(voxel, request);
      if (strict.status === 'CANCELLED') return cancelled('路线搜索被取消。', { searched: evaluations.length, resolvedStance: candidate.stance });
      const historical = strict.status === 'FOUND' || !args.historical || ctx.signal.aborted
        ? null
        : await searchLandRouteAsync(voxel, { ...request, allowStale: true, deadlineMs: sliceEnd });
      if (historical?.status === 'CANCELLED') return cancelled('历史路线搜索被取消。', { searched: evaluations.length, resolvedStance: candidate.stance });
      const result = strict.status === 'FOUND' ? strict : historical?.status === 'FOUND' ? historical : strict;
      const planned = result.status === 'FOUND' ? result.transitions : (strict.prefix?.transitions ?? []);
      // navigate_to 只在首个 BLOCKED 段前停止；STALE/UNKNOWN 段仍会按现场证据逐步复核，
      // 所以“可执行段数”取 blocker 下标，而不是 verification.openPrefix。
      const blocker = result.status === 'FOUND' ? blockerOf(result.verification) : null;
      const executableSteps = result.status === 'FOUND' ? (blocker === null ? planned.length : blocker.index) : null;
      const historicalDead = result.evidenceMode === 'historical' && result.status === 'FOUND' && executableSteps === 0;
      const mode: RouteMode = result.status === 'FOUND' && !historicalDead
        ? (result.evidenceMode === 'current' ? 'current' : 'historical')
        : planned.length > 0 && strict.prefix?.knownBlockerAhead === undefined && result.status !== 'FOUND' ? 'prefix' : 'none';
      const resolved = result.resolvedTarget;
      const targetMismatch = !(Math.floor(resolved.x) === Math.floor(candidate.stance.x)
        && Math.floor(resolved.z) === Math.floor(candidate.stance.z)
        && Math.abs(resolved.y - candidate.stance.y) <= STANCE_TOLERANCE);
      evaluations.push({
        candidate, strict, result, mode,
        planned,
        // navigate_to 会对整条计划做 allowed 检查（不只看执行窗口），这里保持一致。
        disallowed: planned.find((transition) => !args.allowed.includes(transition.kind)) ?? null,
        boundaries: summarizeBoundaries(strict.boundaries),
        executableSteps,
        deadRoute: historicalDead,
        targetMismatch,
      });
    }
    const unranked = valid.length - ranked.length;
    if (!evaluations.length) {
      const expired = Date.now() >= ctx.deadline;
      const { position, displacement } = snapshot();
      return fail('TIMEOUT', expired
        ? '父委托期限在路线搜索前耗尽，没有移动'
        : `所有候选站位的路线搜索都没有完成（共享 ${SEARCH_BUDGET_MS}ms 预算），没有移动；先缩小范围或走近再试`, {
        ...base, outcome: expired ? 'TIMEOUT' : 'BUDGET_EXCEEDED', stop: expired ? 'TIMEOUT' : 'BUDGET_EXCEEDED',
        position, displacement, resolvedStance: null, candidateCount: valid.length,
        unrankedCandidates: unranked,
        budget: { searchMs: SEARCH_BUDGET_MS, searched: 0 },
      });
    }
    const budgetCut = ranked.length - evaluations.length;

    const allowedPool = evaluations.filter((evaluation) => evaluation.disallowed === null);
    if (!allowedPool.length) {
      const kinds = [...new Set(evaluations.flatMap((evaluation) => evaluation.disallowed === null ? [] : [evaluation.disallowed.kind]))];
      const { position, displacement } = snapshot();
      return fail('BAD_ARGS', `候选路线需要 ${kinds.join('、')}，不在 allowed（${args.allowed.join('、')}）；没有执行任何一步`, {
        ...base, outcome: 'UNSUPPORTED', stop: 'UNSUPPORTED', position, displacement, resolvedStance: null,
        candidates: evaluations.map(routeSummary), disallowed: kinds,
      });
    }
    // 路线搜索解析出的落脚点与实测验证的站位不一致（例如地图还记着整块、现场已是半砖）时，
    // 不能把“已找到路线”当成可执行；只允许前缀/无路线候选走到自己的证据边界。
    const executable = allowedPool.filter((evaluation) =>
      !evaluation.deadRoute
      && !(evaluation.targetMismatch && (evaluation.mode === 'current' || evaluation.mode === 'historical')));
    if (!executable.length) {
      const { position, displacement } = snapshot();
      return fail('NOT_FOUND', '没有可执行候选：路线落脚点与当前实测验证的站位不一致，或历史路线的第一步已被当前证据阻挡；没有执行任何一步', {
        ...base, outcome: 'UNKNOWN', stop: 'UNKNOWN', evidenceState: 'UNKNOWN',
        position, displacement, resolvedStance: null,
        candidates: evaluations.map(routeSummary),
      });
    }
    const selected = executable
      .slice()
      .sort((a, b) =>
        modeRank(a.mode) - modeRank(b.mode)
        || (a.mode === 'historical' && b.mode === 'historical' ? (b.executableSteps ?? 0) - (a.executableSteps ?? 0) : 0)
        || (a.mode === 'prefix' ? a.strict.prefix!.distanceToTarget - b.strict.prefix!.distanceToTarget : a.result.cost - b.result.cost)
        || (a.mode === 'prefix' ? b.planned.length - a.planned.length : a.planned.length - b.planned.length)
        || dist3(start, a.candidate.stance) - dist3(start, b.candidate.stance)
        || cellKey(a.candidate.stance).localeCompare(cellKey(b.candidate.stance)))[0]!;
    const routeFacts = {
      evidence: { ...evidenceFacts, searchEvidenceMode: selected.result.evidenceMode },
      resolvedStance: { ...selected.candidate.stance },
      resolvedCell: { ...selected.candidate.cell },
      routeMode: selected.mode,
      searchEvidenceMode: selected.result.evidenceMode,
      boundarySummary: selected.boundaries,
      ...(selected.boundaries.total === 0 ? {} : { boundaries: selected.strict.boundaries }),
      ...(selected.strict.prefix === undefined ? {} : { prefix: selected.strict.prefix }),
      ...(selected.strict.prefix?.knownBlockerAhead === undefined ? {} : { blockerAhead: selected.strict.prefix.knownBlockerAhead }),
      ...(selected.result.verification === undefined || blockerOf(selected.result.verification) === null
        ? {}
        : { verifiedBlocker: blockerOf(selected.result.verification) }),
      candidates: evaluations.map(routeSummary),
      candidateCount: valid.length,
      rejected,
      ...(unranked > 0 ? { unrankedCandidates: unranked } : {}),
      ...(budgetCut > 0 ? { budgetCutCandidates: budgetCut } : {}),
      ...(entity === undefined ? {} : { entity: { ...entity } }),
    };

    // ---- 4. 执行前复核：搜索到执行之间世界可能已变。 ----
    if (ctx.signal.aborted) return cancelled('执行前收到取消。', routeFacts);
    if (Date.now() >= ctx.deadline) {
      const { position, displacement } = snapshot();
      return fail('TIMEOUT', 'approach_visible 的父委托期限在开始执行前已耗尽，没有移动', {
        ...base, ...routeFacts, outcome: 'TIMEOUT', stop: 'TIMEOUT', position, displacement,
      });
    }
    const recheck = inspectStance(at, selected.candidate.cell);
    if (recheck.status !== 'OK' || Math.abs(recheck.foot - selected.candidate.stance.y) > STANCE_TOLERANCE) {
      const { position, displacement } = snapshot();
      return fail('PATH_NOT_FOUND', `选中的站位 (${selected.candidate.stance.x.toFixed(2)},${selected.candidate.stance.y},${selected.candidate.stance.z.toFixed(2)}) 在搜索后已不再可用（${recheck.status}）；没有移动`, {
        ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED', position, displacement,
      });
    }
    if (target.kind === 'block' && targetCell !== undefined && targetName !== null) {
      const now = ctx.adapter.blockAt(targetCell);
      if (now === null || stem(now) !== stem(targetName)) {
        const { position, displacement } = snapshot();
        return fail('TARGET_GONE', `目标方块在搜索后已不可用（${now === null ? '未加载' : stem(now)}，原为 ${stem(targetName)}）；没有移动`, {
          ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED', position, displacement,
        });
      }
    }
    if (target.kind === 'entity' && entity !== undefined) {
      const latest = ctx.senses.perceivedEntities(radius + ENTITY_REACH)
        .filter((e) => e.perception !== 'heard'
          && (target.id === undefined || e.id === target.id)
          && (target.name === undefined || stem(e.name) === stem(target.name)))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!latest) {
        const { position, displacement } = snapshot();
        return fail('TARGET_GONE', `实体 ${stem(entity.name)} 在搜索后不再被看见/记得；没有移动`, {
          ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED', position, displacement,
        });
      }
      if (dist3(selected.candidate.stance, latest.pos) > ENTITY_REACH + ENTITY_MOVE_SLACK) {
        const { position, displacement } = snapshot();
        return fail('TARGET_GONE', `实体 ${stem(entity.name)} 在搜索后移动到了 (${latest.pos.x.toFixed(1)},${latest.pos.y.toFixed(1)},${latest.pos.z.toFixed(1)})，已不在所选站在交互距离内；没有移动`, {
          ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED', position, displacement,
          entity: { ...latest }, entityBefore: { ...entity },
        });
      }
      entity = latest;
    }

    // ---- 5. 只执行一次有界接近；步数上限从选定路线推导，不沿用默认 16 段。 ----
    // 累计位移预算：最短路线超过“直线距离 × 3 + 8 段”就不算局部接近，交回事实由 Agent 决定。
    const direct = dist3(start, selected.candidate.stance);
    const travelLimit = Math.min(HARD_MAX_STEPS, Math.ceil(direct * MAX_DETOUR_FACTOR) + DETOUR_SLACK);
    // 历史路线只执行到首个 BLOCKED 段；位移预算按真正会执行的段数算，而不是整条历史几何。
    const executablePlanned = selected.mode === 'historical' ? (selected.executableSteps ?? selected.planned.length) : selected.planned.length;
    const executableTransitions = selected.mode === 'historical' ? selected.planned.slice(0, executablePlanned) : selected.planned;
    const plannedDistance = executableTransitions.reduce((sum, transition) => sum + dist3(transition.from, transition.to), 0);
    const distanceLimit = direct * MAX_DETOUR_FACTOR + DETOUR_SLACK;
    if ((selected.mode === 'current' || selected.mode === 'historical')
      && (executablePlanned > travelLimit || plannedDistance > distanceLimit)) {
      const { position, displacement } = snapshot();
      return fail('TIMEOUT', `可执行路线 ${executablePlanned} 段 / 路径 ${plannedDistance.toFixed(1)} 格超过本次累计位移预算（${travelLimit} 段 / ${distanceLimit.toFixed(1)} 格，直线 ${direct.toFixed(1)} 格）；没有移动`, {
        ...base, ...routeFacts, outcome: 'BUDGET_EXCEEDED', stop: 'BUDGET_EXCEEDED', position, displacement,
        budget: {
          travelLimit, distanceLimit: round2(distanceLimit), plannedDistance: round2(plannedDistance),
          plannedTransitions: selected.planned.length, executableTransitions: executablePlanned,
          maxSteps: args.maxSteps ?? null, searchedStances: evaluations.length,
        },
      });
    }
    // 已找到完整路线时按路线长度给上限；只有前缀/无路线时把执行窗口交给 navigate_to
    // 自己的逐段证据复核，同时受累计位移预算限制，硬上限仍是 64 段。
    const routeSteps = selected.mode === 'current' || selected.mode === 'historical'
      ? executablePlanned + ROUTE_STEP_MARGIN
      : travelLimit;
    const budget = {
      maxSteps: Math.min(HARD_MAX_STEPS, travelLimit, args.maxSteps ?? routeSteps),
      travelLimit,
      distanceLimit: round2(distanceLimit),
      plannedDistance: round2(plannedDistance),
      basis: args.maxSteps === undefined ? 'derived_from_route' : 'caller',
      plannedTransitions: selected.planned.length,
      searchedStances: evaluations.length,
      searchBudgetMs: SEARCH_BUDGET_MS,
      deadline: ctx.deadline,
      executedTransitions: null as number | null,
    };
    const validated = validateSkill(navigateTo, {
      to: selected.candidate.stance,
      allowed: args.allowed,
      historical: args.historical,
      maxSteps: budget.maxSteps,
      allowUnknownCorridor: args.allowUnknownCorridor,
    }, ctx.adapter);
    if (!validated.ok) {
      return fail('BAD_ARGS', `approach_visible 生成 navigate_to 参数无效：${validated.error}；没有移动`, {
        ...base, ...routeFacts, outcome: 'UNSUPPORTED', stop: 'UNSUPPORTED', position: start, displacement: 0, budget,
      });
    }
    let moved: SkillResult;
    try {
      moved = await runSkill(ctx, navigateTo, validated.args);
    } catch (error) {
      if (!isAbort(error)) throw error;
      const { position, displacement } = snapshot();
      const partial = (error as Error & { partial?: Record<string, unknown> }).partial;
      return {
        status: 'cancelled',
        summary: `approach_visible 在接近途中被取消；原目标未改变，实测在 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})，位移 ${displacement.toFixed(2)} 格`,
        data: { ...base, ...routeFacts, outcome: 'CANCELLED', position, displacement, budget, ...(partial === undefined ? {} : { partial }) },
      };
    }
    const after = snapshot();
    if (typeof moved.data?.executed === 'number') budget.executedTransitions = moved.data.executed;
    // 执行实际采用的证据模式；搜索阶段的预测另放 searchEvidenceMode。
    const executedEvidenceMode = typeof moved.data?.evidenceMode === 'string' ? moved.data.evidenceMode : selected.result.evidenceMode;
    const arrival = { ...selected.candidate.stance };
    const stanceConfirmed = Math.floor(after.position.x) === Math.floor(arrival.x)
      && Math.floor(after.position.z) === Math.floor(arrival.z)
      && Math.abs(after.position.y - arrival.y) <= STANCE_TOLERANCE;

    // ---- 6. 按实测结果与目标当前状态给出真实结局。 ----
    if (moved.status === 'cancelled') {
      return {
        status: 'cancelled',
        summary: `approach_visible 进行中被取消；原目标未改变，实测在 (${after.position.x.toFixed(2)},${after.position.y.toFixed(2)},${after.position.z.toFixed(2)})，位移 ${after.displacement.toFixed(2)} 格`,
        data: { ...base, ...routeFacts, outcome: 'CANCELLED', position: after.position, displacement: after.displacement, budget, navigation: moved.data },
      };
    }
    if (moved.status !== 'succeeded') {
      const { cause, executed } = navigationOutcome(moved, selected.strict.status);
      // 段计数器为 0 时仍可能有实测位移（例如某一步走后动作失败）；这种真实进展也要报 PARTIAL。
      const progressed = executed > 0 || after.displacement > MOVEMENT_EPS;
      const outcome: Outcome = progressed ? 'PARTIAL' : cause;
      const stop = progressed ? cause : null;
      const evidenceRelevant = outcome === 'UNKNOWN' || stop === 'UNKNOWN';
      const evidenceState = evidenceRelevant ? evidenceStateOf(selected.strict) : undefined;
      const evidence = evidenceRelevant
        ? { stale: selected.strict.stats.staleEdges, unknown: selected.strict.stats.unknownEdges, boundaries: selected.boundaries.counts }
        : undefined;
      const search = {
        status: selected.strict.status,
        cancelReason: selected.strict.stats.cancelReason,
        staleEdges: selected.strict.stats.staleEdges,
        unknownEdges: selected.strict.stats.unknownEdges,
      };
      const note = outcome === 'PARTIAL'
        ? `只完成部分接近（${executed} 段，停止原因 ${stop ?? '未知'}）；原目的地不变`
        : `没能接近${target.kind === 'entity' ? '实体' : target.kind === 'block' ? '目标方块' : '目标位置'}（${stop ?? outcome}）`;
      return fail(failureCodeOf(outcome), `approach_visible ${note}：${moved.summary}`, {
        ...base, ...routeFacts, outcome, ...(stop === null ? {} : { stop }),
        ...(evidenceState === undefined ? {} : { evidenceState }),
        ...(evidence === undefined ? {} : { evidence }),
        search,
        evidenceMode: executedEvidenceMode,
        position: after.position, displacement: after.displacement, confirmedSegments: executed,
        budget, navigation: moved.data,
      });
    }

    if (!stanceConfirmed) {
      return fail('EFFECT_NOT_CONFIRMED', `navigate_to 报成功，但实测脚位 ${JSON.stringify(feetCell(after.position))} / 脚高 ${after.position.y.toFixed(2)} 与选定站位 (${arrival.x.toFixed(2)},${arrival.y},${arrival.z.toFixed(2)}) 不符；不按到达处理`, {
        ...base, ...routeFacts, outcome: 'NOT_CONFIRMED', stop: 'NOT_CONFIRMED',
        position: after.position, displacement: after.displacement,
        evidenceMode: executedEvidenceMode,
        confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
        budget, navigation: moved.data,
      });
    }

    const confirm = (summary: string, interaction: Record<string, unknown>, extra: Record<string, unknown> = {}) => ok(
      `${summary}；实测在 (${after.position.x.toFixed(2)},${after.position.y.toFixed(2)},${after.position.z.toFixed(2)})，位移 ${after.displacement.toFixed(2)} 格；原目标 ${JSON.stringify(target)} 未改变`,
      {
        ...base, ...routeFacts, outcome: 'ARRIVED' as const,
        position: after.position, displacement: after.displacement,
        evidenceMode: executedEvidenceMode,
        confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
        interaction, budget, navigation: moved.data, ...extra,
      },
    );

    if (target.kind === 'position') {
      // 水平与垂直分开验收：半砖/雪层的脚高吸附不应把同一格内的到达判成失败。
      const horizontal = Math.hypot(after.position.x - target.pos.x, after.position.z - target.pos.z);
      const vertical = Math.abs(after.position.y - target.pos.y);
      const distance = { horizontal: round2(horizontal), vertical: round2(vertical) };
      const tolerance = { horizontal: POSITION_TOLERANCE, vertical: POSITION_HEIGHT_TOLERANCE };
      if (horizontal > POSITION_TOLERANCE || vertical > POSITION_HEIGHT_TOLERANCE) {
        return fail('EFFECT_NOT_CONFIRMED', `已站到解析站位，但实测位置与原目标点相差 水平 ${horizontal.toFixed(2)} / 垂直 ${vertical.toFixed(2)} 格，超出到达容差；不按到达处理`, {
          ...base, ...routeFacts, outcome: 'NOT_CONFIRMED', stop: 'NOT_CONFIRMED',
          position: after.position, displacement: after.displacement,
          confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
          interaction: { kind: 'position', distance, tolerance },
          budget, navigation: moved.data,
        });
      }
      return confirm(`已接近位置 (${target.pos.x},${target.pos.y},${target.pos.z})`, {
        kind: 'position', distance, tolerance,
      });
    }

    if (target.kind === 'block' && targetCell !== undefined && targetName !== null) {
      // 到达后优先用一次当前感知复核目标身份；看不见时退回已加载状态。
      const observedNow = ctx.senses.observeBlocks?.([targetCell]).find((block) => block.pos.x === targetCell.x && block.pos.y === targetCell.y && block.pos.z === targetCell.z);
      const now = observedNow?.name ?? ctx.adapter.blockAt(targetCell);
      const confirmationSource = observedNow !== undefined ? 'current_perception' : 'loaded';
      if (now === null) {
        return fail('NOT_FOUND', `到达站位后目标方块 (${targetCell.x},${targetCell.y},${targetCell.z}) 已不可观察（未加载），不能确认接近`, {
          ...base, ...routeFacts, outcome: 'UNKNOWN', stop: 'UNKNOWN', evidenceState: 'UNKNOWN',
          position: after.position, displacement: after.displacement,
          evidenceMode: executedEvidenceMode,
          confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
          budget, navigation: moved.data,
        });
      }
      if (stem(now) !== stem(targetName)) {
        return fail('TARGET_GONE', `目标方块在接近途中已变化（原 ${stem(targetName)}，现 ${stem(now)}）；已到站位但不再确认到达`, {
          ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED',
          position: after.position, displacement: after.displacement, evidenceMode: executedEvidenceMode,
          confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
          targetNow: stem(now), budget, navigation: moved.data,
        });
      }
      const reach = dist3(bodyCenter(after.position), { x: targetCell.x + 0.5, y: targetCell.y + 0.5, z: targetCell.z + 0.5 });
      if (reach > BLOCK_REACH) {
        return fail('EFFECT_NOT_CONFIRMED', `已站到站位，但实测身体到目标方块 ${stem(now)} 的距离 ${reach.toFixed(2)} 格，超出交互距离 ${BLOCK_REACH}；不按到达处理`, {
          ...base, ...routeFacts, outcome: 'PARTIAL', stop: 'NOT_CONFIRMED',
          position: after.position, displacement: after.displacement, evidenceMode: executedEvidenceMode,
          confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
          interaction: { kind: 'block', reach: round2(reach), limit: BLOCK_REACH, inReach: false },
          confirmation: { source: confirmationSource, name: stem(now) },
          budget, navigation: moved.data,
        });
      }
      return confirm(`已接近方块 ${stem(now)} (${targetCell.x},${targetCell.y},${targetCell.z})`, {
        kind: 'block', reach: round2(reach), limit: BLOCK_REACH, inReach: true,
      }, { confirmation: { source: confirmationSource, name: stem(now) } });
    }

    const latest = target.kind === 'entity' && entity !== undefined
      ? ctx.senses.perceivedEntities(radius + ENTITY_REACH)
        .filter((e) => e.perception !== 'heard'
          && (target.id === undefined || e.id === target.id)
          && (target.name === undefined || stem(e.name) === stem(target.name)))
        .sort((a, b) => a.dist - b.dist)[0]
      : undefined;
    if (latest === undefined) {
      return fail('TARGET_GONE', `已到站位，但实体 ${entity === undefined ? '' : stem(entity.name)} 已不再被看见/记得；不能确认接近`, {
        ...base, ...routeFacts, outcome: 'INVALIDATED', stop: 'INVALIDATED',
        position: after.position, displacement: after.displacement, evidenceMode: executedEvidenceMode,
        confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
        ...(entity === undefined ? {} : { entityBefore: { ...entity } }),
        budget, navigation: moved.data,
      });
    }
    const reach = dist3(bodyCenter(after.position), entityCenter(latest));
    if (reach > ENTITY_REACH) {
      return fail('EFFECT_NOT_CONFIRMED', `已站到原站位，但实体 ${stem(latest.name)} 现在在 (${latest.pos.x.toFixed(1)},${latest.pos.y.toFixed(1)},${latest.pos.z.toFixed(1)})，距身体 ${reach.toFixed(2)} 格，超出交互距离 ${ENTITY_REACH}；不追改目标`, {
        ...base, ...routeFacts, outcome: 'PARTIAL', stop: 'NOT_CONFIRMED',
        position: after.position, displacement: after.displacement, evidenceMode: executedEvidenceMode,
        confirmedSegments: typeof moved.data?.executed === 'number' ? moved.data.executed : 0,
        entity: { ...latest }, entityBefore: entity === undefined ? null : { ...entity },
        interaction: { kind: 'entity', reach: round2(reach), limit: ENTITY_REACH, inReach: false },
        budget, navigation: moved.data,
      });
    }
    return confirm(`已接近实体 ${stem(latest.name)}`, {
      kind: 'entity', reach: round2(reach), limit: ENTITY_REACH, inReach: true,
    }, { entity: { ...latest } });
  },
};
