import { walkCollisionProvider } from '../../adapter/walk-collision.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import type { MoveOpts, MoveTarget, NavigationDelegate, Vec3Like } from '../../adapter/types.ts';
import { bodyCells } from '../../perception/geometry.ts';
import { observedFootY, searchLandRouteAsync, type LandSearchResult } from '../../spatial/land-search.ts';
import type { CollisionShape } from 'curio-minecraft-3d-memory';
import { AbortedError } from '../../util.ts';
import { runSkill, type SkillCtx, type SkillResult } from '../types.ts';
import { cellGoal, type NavigationGoal } from './goal.ts';

/**
 * 通用 MoveTarget → 宿主已观测 VoxelMap 有界导航的翻译层。
 *
 * - 目标完成条件仍由原始 MoveTarget 决定（near 半径、xz 水平带脚高、精确脚位、
 *   交互距离、当前实体位置）。
 * - 选点只用共享体素里已观测的站立面；不扫描客户端全部方块，也不回退旧寻路器。
 * - 路线搜索/执行交给 navigate_to 的 3D A* 与逐段身体控制；近身单步、明确下落和
 *   梯子由适配器本地执行（见 mineflayer）。
 */

const ALLOWED = ['walk', 'step', 'drop', 'ladder'] as const;
/** 所有候选共享的路线搜索预算；不是每个候选各得一份。 */
const CANDIDATE_SEARCH_BUDGET_MS = 4000;
const MAX_CANDIDATES = 18;
const MAX_SCAN_RADIUS = 6;
const REACH_DISTANCE = 4;
const FOLLOW_ROUNDS = 8;
const DIRS6: readonly [number, number, number][] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];
const dist3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cellOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const sameCell = (a: Vec3Like, b: Vec3Like) => a.x === b.x && a.y === b.y && a.z === b.z;

type Candidate = { goal: NavigationGoal; foot: number; cell: Vec3Like; rank: number };
type Attempt = { candidate: Candidate; result: LandSearchResult };
type GapKind = 'NO_EVIDENCE' | 'NO_PATH' | 'UNSUPPORTED' | 'TIMEOUT' | 'NOT_CONFIRMED';

function gap(kind: GapKind, summary: string, data: Record<string, unknown> = {}): Error {
  const error = new Error(summary);
  error.name = kind === 'NO_PATH' ? 'NoPath' : kind === 'TIMEOUT' ? 'Timeout' : kind === 'UNSUPPORTED' ? 'UnsupportedNavigation' : 'NavigationGap';
  const partial = { ...data, gap: kind, position: data.position, progressNote: summary };
  Object.assign(error, { data: { gap: kind, ...data }, partial });
  return error;
}

function assertLive(ctx: SkillCtx, deadline: number, signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError('navigation cancelled');
  if (Date.now() >= deadline) throw gap('TIMEOUT', 'TIMEOUT: 导航期限已耗尽');
  const state = ctx.adapter.state();
  if (!state.connected || !state.alive || !state.observationReady) throw gap('NO_EVIDENCE', 'NOT_CONNECTED: 没有有效的存活观测');
}

function voxelOf(ctx: SkillCtx): NonNullable<SkillCtx['spatial']>['session']['voxel'] {
  const voxel = ctx.spatial?.session?.voxel;
  if (!voxel) throw gap('NO_EVIDENCE', 'NAVIGATION_UNAVAILABLE: 非本地移动需要共享 VoxelMap；没有可用导航证据，不回退旧寻路器');
  return voxel;
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.cell.x},${Math.round(candidate.foot * 1000)},${candidate.cell.z}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function byRank(candidates: Candidate[]): Candidate[] {
  return dedupe(candidates).sort((a, b) => a.rank - b.rank).slice(0, MAX_CANDIDATES);
}

/**
 * 原 GoalNear 语义：目标坐标先取整，再在整数节点上比较三维距离。
 * 候选只取共享体素里已观测的真实脚高；候选脚格的整数高度仍须满足原半径。
 */
function nearCandidates(ctx: SkillCtx, target: { pos: Vec3Like; range: number }): Candidate[] {
  const voxel = voxelOf(ctx);
  const state = ctx.adapter.state();
  const base = { x: Math.floor(target.pos.x), y: Math.floor(target.pos.y), z: Math.floor(target.pos.z) };
  const radius = Math.max(0, Math.ceil(target.range));
  if (radius > MAX_SCAN_RADIUS) throw gap('UNSUPPORTED', `UNSUPPORTED_NAVIGATION: near 半径 ${target.range} 超出有界候选扫描上限 ${MAX_SCAN_RADIUS}`, { target: target.pos, range: target.range });
  const out: Candidate[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -radius; dy <= radius; dy++) {
    if (dx * dx + dy * dy + dz * dz > target.range * target.range + 1e-9) continue;
    const foot = observedFootY(voxel, state.dim, base.x + dx, base.z + dz, base.y + dy, 2, 2);
    if (foot === null) continue;
    const fy = Math.floor(foot + 1e-6);
    const nodeD2 = dx * dx + (fy - base.y) * (fy - base.y) + dz * dz;
    if (nodeD2 > target.range * target.range + 1e-9) continue;
    const cell = { x: base.x + dx, y: fy, z: base.z + dz };
    out.push({
      goal: cellGoal({ x: cell.x, z: cell.z }, foot, cell), foot, cell,
      rank: Math.hypot(state.pos.x - (cell.x + 0.5), state.pos.y - foot, state.pos.z - (cell.z + 0.5)),
    });
  }
  return byRank(out);
}

/** 原 GoalNearXZ 语义：只看水平节点距离；可选的脚格带只约束终点脚高。 */
function xzCandidates(ctx: SkillCtx, target: { x: number; z: number; range: number; footY?: [number, number] }): Candidate[] {
  const voxel = voxelOf(ctx);
  const state = ctx.adapter.state();
  const baseX = Math.floor(target.x), baseZ = Math.floor(target.z);
  const radius = Math.max(0, Math.ceil(target.range));
  if (radius > MAX_SCAN_RADIUS) throw gap('UNSUPPORTED', `UNSUPPORTED_NAVIGATION: xz 半径 ${target.range} 超出有界候选扫描上限 ${MAX_SCAN_RADIUS}`, { target: { x: target.x, z: target.z }, range: target.range });
  const band = target.footY;
  const aroundY = band === undefined ? Math.floor(state.pos.y) : Math.max(band[0], Math.min(band[1], Math.floor(state.pos.y)));
  const down = band === undefined ? 3 : Math.max(2, band[1] - band[0] + 2);
  const up = band === undefined ? 3 : Math.max(2, band[1] - band[0] + 2);
  const out: Candidate[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > target.range * target.range + 1e-9) continue;
    const foot = observedFootY(voxel, state.dim, baseX + dx, baseZ + dz, aroundY, down, up);
    if (foot === null) continue;
    const fy = Math.floor(foot + 1e-6);
    if (band !== undefined && (fy < band[0] || fy > band[1])) continue;
    const cell = { x: baseX + dx, y: fy, z: baseZ + dz };
    out.push({
      goal: cellGoal({ x: cell.x, z: cell.z }, foot, cell), foot, cell,
      rank: Math.hypot(state.pos.x - (cell.x + 0.5), state.pos.z - (cell.z + 0.5)),
    });
  }
  return byRank(out);
}

/** 只读共享 VoxelMap 的新鲜、完整、同会话观测；未观测/过期/不完整都返回 null（不是空气）。 */
function observedState(ctx: SkillCtx, pos: Vec3Like): { name: string; properties: Record<string, string> } | null {
  const voxel = voxelOf(ctx);
  const state = ctx.adapter.state();
  const view = voxel.cellAt(state.dim, pos.x, pos.y, pos.z);
  if (!view.observed) return null;
  const evidence = view.evidence;
  if (evidence.freshness !== 'FRESH' || evidence.validUntil < Date.now()
    || evidence.observation.sessionId !== state.sessionId || !evidence.observation.stateComplete) return null;
  return evidence.observation.state as { name: string; properties: Record<string, string> };
}

/** 观测证据上的真实碰撞盒；未知形状/未观测都返回 null，不按方块名猜。 */
function observedShape(ctx: SkillCtx, pos: Vec3Like): CollisionShape | null {
  const state = observedState(ctx, pos);
  if (state === null) return null;
  const resolved = walkCollisionProvider.resolve(state, pos, {
    cell: (x, y, z) => ({ pos: { x, y, z }, kind: 'unobserved' as const }),
  });
  return resolved.kind === 'shape' ? resolved.shape : null;
}

function observedSolid(ctx: SkillCtx, pos: Vec3Like): boolean | null {
  const shape = observedShape(ctx, pos);
  return shape === null ? null : shape.boxes.length > 0;
}

function shapeBlocksPoint(shape: CollisionShape, point: Vec3Like, cell: Vec3Like): boolean {
  const x = point.x - cell.x, y = point.y - cell.y, z = point.z - cell.z;
  return shape.boxes.some((box) => x > box.minX + 1e-9 && x < box.maxX - 1e-9
    && y > box.minY + 1e-9 && y < box.maxY - 1e-9
    && z > box.minZ + 1e-9 && z < box.maxZ - 1e-9);
}

/**
 * 只用已观测碰撞盒的视线采样：任一段未观测/形状未知都算不能确认。
 * 跳过目标格与参照格自身（采样点最多落在它们的边界上）。
 */
function observedRayClear(ctx: SkillCtx, from: Vec3Like, to: Vec3Like, skip: Vec3Like[]): boolean {
  const distance = dist3(from, to);
  if (distance <= 1e-9) return true;
  const steps = Math.max(1, Math.ceil(distance / 0.2));
  const skipKeys = new Set(skip.map((p) => `${p.x},${p.y},${p.z}`));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
    const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
    if (skipKeys.has(`${cell.x},${cell.y},${cell.z}`)) continue;
    const shape = observedShape(ctx, cell);
    if (shape === null || shapeBlocksPoint(shape, point, cell)) return false;
  }
  return true;
}

function facingDir(facing: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'): [number, number, number] {
  switch (facing) {
    case 'north': return [0, 0, -1];
    case 'south': return [0, 0, 1];
    case 'east': return [1, 0, 0];
    case 'west': return [-1, 0, 0];
    case 'up': return [0, 1, 0];
    case 'down': return [0, -1, 0];
  }
}

/**
 * 规划期贴附面：参照方块的碰撞盒和整条视线都来自共享观测证据。
 * 任一采样格未观测或形状未知时，这个面不算已验证。
 */
function observedVisibleFace(
  ctx: SkillCtx, target: Vec3Like, eye: Vec3Like,
  facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down',
): { dir: [number, number, number]; ref: Vec3Like; point: Vec3Like } | null {
  const wanted = facing === undefined ? null : facingDir(facing);
  for (const dir of DIRS6) {
    if (wanted !== null && (dir[0] !== wanted[0] || dir[1] !== wanted[1] || dir[2] !== wanted[2])) continue;
    const ref = { x: target.x + dir[0], y: target.y + dir[1], z: target.z + dir[2] };
    if (observedSolid(ctx, ref) !== true) continue;
    const point = { x: target.x + 0.5 + dir[0] * 0.5, y: target.y + 0.5 + dir[1] * 0.5, z: target.z + 0.5 + dir[2] * 0.5 };
    if (dist3(eye, point) > REACH_DISTANCE + 0.25) continue;
    if (!observedRayClear(ctx, eye, point, [target, ref])) continue;
    return { dir, ref, point };
  }
  return null;
}

function blockCandidates(
  ctx: SkillCtx, target: Vec3Like, kind: 'reach_block' | 'place_block',
  facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down',
): Candidate[] {
  const voxel = voxelOf(ctx);
  const state = ctx.adapter.state();
  // 目标格自身也必须有观测形状：未观测不是空气，不能凭坐标猜它可以站/可以放。
  const targetShape = observedShape(ctx, target);
  if (targetShape === null) return [];
  const hollow = kind === 'reach_block' && targetShape.boxes.length === 0;
  if (kind === 'place_block' && targetShape.boxes.length > 0) return [];
  const targetCenter = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
  const out: Candidate[] = [];
  for (let dx = -REACH_DISTANCE - 1; dx <= REACH_DISTANCE + 1; dx++) {
    for (let dz = -REACH_DISTANCE - 1; dz <= REACH_DISTANCE + 1; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const cell = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
        if (cell.x === target.x && cell.y === target.y && cell.z === target.z) continue;
        const foot = observedFootY(voxel, state.dim, cell.x, cell.z, cell.y, 2, 2);
        if (foot === null) continue;
        const eye = { x: cell.x + 0.5, y: foot + 1.62, z: cell.z + 0.5 };
        if (kind === 'place_block' && bodyCells(foot, cell.x, cell.z).some((bodyCell) => sameCell(bodyCell, target))) continue;
        if (hollow) {
          const node = { x: cell.x, y: Math.floor(foot + 1e-6), z: cell.z };
          if (dist3(node, { x: target.x, y: target.y, z: target.z }) > 2 + 1e-9) continue;
          // 无碰撞方块没有可点击面，但仍要看见它；不能隔着墙算可交互。
          if (!observedRayClear(ctx, eye, targetCenter, [target])) continue;
        } else {
          if (dist3(eye, targetCenter) > REACH_DISTANCE + 0.25) continue;
          if (observedVisibleFace(ctx, target, eye, facing) === null) continue;
        }
        const rank = dist3(eye, targetCenter)
          + Math.hypot(state.pos.x - (cell.x + 0.5), state.pos.y - foot, state.pos.z - (cell.z + 0.5)) * 0.1;
        out.push({ goal: cellGoal({ x: cell.x, z: cell.z }, foot, cell), foot, cell, rank });
      }
    }
  }
  return byRank(out);
}

function goalPoint(goal: NavigationGoal): Vec3Like {
  return goal.kind === 'feet' ? { ...goal.feet } : { x: goal.cell.x, y: goal.footY, z: goal.cell.z };
}

/** 一个原始目标（含 follow 的多轮接近）共享的搜索/transition 预算，不按重试次数重置。 */
type GoalBudget = { searchesLeft: number; searchMsLeft: number; transitionsLeft: number };

function goalBudget(deadline: number): GoalBudget {
  return {
    searchesLeft: 24,
    searchMsLeft: Math.max(1, Math.min(CANDIDATE_SEARCH_BUDGET_MS, deadline - Date.now())),
    transitionsLeft: 64,
  };
}

function stepBudget(routeCost: number, budget: GoalBudget): number {
  return Math.max(1, Math.min(budget.transitionsLeft, Math.min(64, Math.max(8, Math.ceil(routeCost * 1.5) + 8))));
}

/** 对每个已观测候选做一次有界严格搜索；严格证据都不可用时才用历史候选，并保留逐段复验。 */
async function chooseRoute(
  ctx: SkillCtx, candidates: Candidate[], deadline: number, signal: AbortSignal, budget: GoalBudget,
): Promise<{ chosen: Attempt; attempts: { cell: Vec3Like; status: string; reason: string; evidenceMode: string }[]; searches: number }> {
  const voxel = voxelOf(ctx);
  const state = ctx.adapter.state();
  const base = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
    allowed: ALLOWED, maxDrop: 4, rules: walkLandRules, signal,
  };
  const searchEnd = Math.min(deadline, Date.now() + budget.searchMsLeft);
  const attempts: { cell: Vec3Like; status: string; reason: string; evidenceMode: string }[] = [];
  const usable: Attempt[] = [];
  let searches = 0;
  const searchOne = async (candidate: Candidate, historical: boolean): Promise<LandSearchResult | null> => {
    const remaining = searchEnd - Date.now();
    if (remaining <= 0 || budget.searchesLeft <= 0) return null;
    const startedAt = Date.now();
    const result = await searchLandRouteAsync(voxel, {
      ...base, goal: candidate.goal,
      evidenceMode: historical ? 'remembered' : 'current',
      deadlineMs: searchEnd,
      maxSearchMs: Math.max(1, Math.min(1200, remaining)),
    });
    budget.searchesLeft -= 1;
    budget.searchMsLeft = Math.max(0, budget.searchMsLeft - (Date.now() - startedAt));
    searches += 1;
    attempts.push({
      cell: { ...candidate.cell }, status: result.status, reason: result.reason,
      evidenceMode: historical ? 'remembered' : 'current',
    });
    return result;
  };
  for (const candidate of candidates) {
    if (signal.aborted) throw new AbortedError('navigation cancelled');
    if (Date.now() >= searchEnd || budget.searchesLeft <= 0) break;
    const result = await searchOne(candidate, false);
    if (result !== null && result.status === 'FOUND' && result.transitions.every((transition) => (ALLOWED as readonly string[]).includes(transition.kind))) {
      usable.push({ candidate, result });
    }
  }
  if (usable.length === 0) {
    for (const candidate of candidates) {
      if (signal.aborted) throw new AbortedError('navigation cancelled');
      if (Date.now() >= searchEnd || budget.searchesLeft <= 0) break;
      const result = await searchOne(candidate, true);
      if (result !== null && result.status === 'FOUND' && result.transitions.every((transition) => (ALLOWED as readonly string[]).includes(transition.kind))) {
        usable.push({ candidate, result });
      }
    }
  }
  usable.sort((a, b) => (a.result.evidenceMode === b.result.evidenceMode ? 0 : a.result.evidenceMode === 'current' ? -1 : 1) || a.result.cost - b.result.cost);
  const chosen = usable[0];
  if (chosen !== undefined) return { chosen, attempts, searches };
  const stateNow = ctx.adapter.state();
  const budgetHit = attempts.some((attempt) => attempt.status === 'BUDGET_EXHAUSTED')
    || (attempts.length > 0 && (budget.searchesLeft <= 0 || Date.now() >= searchEnd));
  const noPath = attempts.some((attempt) => attempt.status === 'NO_PATH_IN_MEMORY');
  const unsupported = attempts.some((attempt) => attempt.status === 'UNSUPPORTED');
  const detail = budgetHit
    ? `候选搜索预算耗尽（${CANDIDATE_SEARCH_BUDGET_MS}ms / ${24 - budget.searchesLeft} 次搜索，${candidates.length} 个候选）；不把预算当成无路`
    : noPath ? '已存体素里没有可执行的 walk/step/drop/ladder 路线'
      : unsupported ? '候选目标不被当前 VoxelMap 搜索支持'
        : '候选都缺少足够的当前/历史体素证据';
  throw gap(budgetHit ? 'TIMEOUT' : 'NO_EVIDENCE', `${budgetHit ? 'TIMEOUT' : 'NAVIGATION_GAP'}: ${detail}；实测位置 (${stateNow.pos.x.toFixed(2)},${stateNow.pos.y.toFixed(2)},${stateNow.pos.z.toFixed(2)})`, {
    candidates: attempts, candidateCount: candidates.length, searches, budgetMs: CANDIDATE_SEARCH_BUDGET_MS,
    position: { ...stateNow.pos }, target: candidates[0]?.goal.requested ?? null,
  });
}

async function runNavigateTo(
  ctx: SkillCtx, to: Vec3Like, deadline: number, signal: AbortSignal, maxSteps: number,
): Promise<SkillResult> {
  // Load the route executor lazily at the actual navigation call: navigate.ts reaches back into
  // skills/types.ts through coordinator/segment/descend, so a static import closes an ESM cycle
  // that evaluates descend.ts before its skill object is initialized.
  const { navigateTo } = await import('./navigate.ts');
  return runSkill({ ...ctx, signal, deadline }, navigateTo, {
    to: { ...to },
    allowed: [...ALLOWED],
    historical: true,
    maxSteps,
    maxStepsPerSegment: maxSteps,
    maxSegments: 1,
    deadlineMs: deadline,
    allowUnknownCorridor: false,
  });
}

function throwNavigationFailure(result: SkillResult, ctx: SkillCtx, targetLabel: Record<string, unknown>): never {
  const position = { ...ctx.adapter.state().pos };
  if (result.status === 'cancelled') throw new AbortedError(result.summary);
  const failure = result.failureCode === 'TIMEOUT'
    ? gap('TIMEOUT', `TIMEOUT: ${result.summary}`, { ...targetLabel, position, navigation: result.data })
    : result.failureCode === 'PATH_NOT_FOUND'
      ? gap('NO_PATH', `No path: ${result.summary}`, { ...targetLabel, position, navigation: result.data })
      : gap('NOT_CONFIRMED', `NOT_CONFIRMED: ${result.summary}`, { ...targetLabel, position, navigation: result.data });
  throw failure;
}

async function executeRoute(
  ctx: SkillCtx, chosen: Attempt, deadline: number, signal: AbortSignal, targetLabel: Record<string, unknown>, budget: GoalBudget,
): Promise<void> {
  const steps = stepBudget(chosen.result.cost, budget);
  const result = await runNavigateTo(ctx, goalPoint(chosen.candidate.goal), deadline, signal, steps);
  const executed = typeof result.data?.executed === 'number' ? result.data.executed : 0;
  budget.transitionsLeft = Math.max(0, budget.transitionsLeft - Math.max(executed, result.status === 'succeeded' ? 1 : 0));
  if (result.status === 'succeeded') return;
  throwNavigationFailure(result, ctx, targetLabel);
}

/**
 * 精确 xyz：直接把原目标交给当前 navigate_to/coordinator，让前缀、观察、冷页驻留和
 * 重规划都按原期限发生；不先用一次“必须 FOUND”的预搜索把可行前缀提前判死。
 */
async function navigateExactDirect(
  ctx: SkillCtx, target: { x: number; y: number; z: number }, deadline: number, signal: AbortSignal,
  budget: GoalBudget, label: Record<string, unknown>,
): Promise<void> {
  // xyz 的 x/z 是方块列，y 是精确脚高；分数 x/z 的连续点由 kind feet 单独表达。
  const steps = Math.max(1, Math.min(budget.transitionsLeft, 64));
  const point = { x: Math.floor(target.x), y: target.y, z: Math.floor(target.z) };
  const result = await runNavigateTo(ctx, point, deadline, signal, steps);
  const executed = typeof result.data?.executed === 'number' ? result.data.executed : 0;
  budget.transitionsLeft = Math.max(0, budget.transitionsLeft - Math.max(executed, result.status === 'succeeded' ? 1 : 0));
  if (result.status === 'succeeded') return;
  throwNavigationFailure(result, ctx, label);
}

function measuredPosition(ctx: SkillCtx): Vec3Like {
  return { ...ctx.adapter.state().pos };
}

function notConfirmed(kind: string, detail: string, ctx: SkillCtx, targetLabel: Record<string, unknown>): Error {
  const position = measuredPosition(ctx);
  return gap('NOT_CONFIRMED', `NOT_CONFIRMED: ${kind} ${detail}；实测位置 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})`, {
    ...targetLabel, position,
  });
}

function nearSatisfied(ctx: SkillCtx, target: { pos: Vec3Like; range: number }): boolean {
  const node = cellOf(ctx.adapter.state().pos);
  const dx = Math.floor(target.pos.x) - node.x;
  const dy = Math.floor(target.pos.y) - node.y;
  const dz = Math.floor(target.pos.z) - node.z;
  return dx * dx + dy * dy + dz * dz <= target.range * target.range + 1e-9;
}

function xzSatisfied(ctx: SkillCtx, target: { x: number; z: number; range: number; footY?: [number, number] }): boolean {
  const node = cellOf(ctx.adapter.state().pos);
  const dx = Math.floor(target.x) - node.x;
  const dz = Math.floor(target.z) - node.z;
  const horizontalOk = dx * dx + dz * dz <= target.range * target.range + 1e-9;
  const bandOk = target.footY === undefined || (node.y >= target.footY[0] && node.y <= target.footY[1]);
  return horizontalOk && bandOk;
}

function xyzSatisfied(ctx: SkillCtx, target: { x: number; y: number; z: number }): boolean {
  const state = ctx.adapter.state();
  return Math.floor(state.pos.x) === Math.floor(target.x)
    && Math.floor(state.pos.z) === Math.floor(target.z)
    && Math.abs(state.pos.y - target.y) <= 0.01;
}

function reachSatisfied(ctx: SkillCtx, target: Vec3Like): boolean {
  if (ctx.adapter.canInteractAt !== undefined) return ctx.adapter.canInteractAt(target, { place: false });
  const state = ctx.adapter.state();
  const eye = ctx.adapter.eye();
  const actualEye = eye === null ? { x: state.pos.x, y: state.pos.y + 1.62, z: state.pos.z } : { x: eye.x, y: eye.y, z: eye.z };
  const node = cellOf(state.pos);
  const optics = ctx.adapter.blockOptics(target.x, target.y, target.z);
  if (optics?.shapes !== undefined && optics.shapes.length === 0) {
    return dist3(node, { x: target.x, y: target.y, z: target.z }) <= 2 + 1e-9;
  }
  return dist3(actualEye, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }) <= REACH_DISTANCE + 0.25;
}

function placeSatisfied(ctx: SkillCtx, target: Vec3Like, facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'): boolean {
  const state = ctx.adapter.state();
  const node = cellOf(state.pos);
  if (bodyCells(state.pos.y, node.x, node.z).some((cell) => sameCell(cell, target))) return false;
  if (ctx.adapter.canInteractAt !== undefined) return ctx.adapter.canInteractAt(target, { place: true, ...(facing === undefined ? {} : { facing }) });
  const eye = ctx.adapter.eye();
  const actualEye = eye === null ? { x: state.pos.x, y: state.pos.y + 1.62, z: state.pos.z } : { x: eye.x, y: eye.y, z: eye.z };
  return dist3(actualEye, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }) <= REACH_DISTANCE + 0.25;
}

function verifyNear(ctx: SkillCtx, target: { pos: Vec3Like; range: number }): void {
  if (nearSatisfied(ctx, target)) return;
  const node = cellOf(ctx.adapter.state().pos);
  throw notConfirmed('near', `实测节点 (${node.x},${node.y},${node.z}) 不在 (${Math.floor(target.pos.x)},${Math.floor(target.pos.y)},${Math.floor(target.pos.z)}) 半径 ${target.range} 内`, ctx, { target: target.pos, range: target.range });
}

function verifyXz(ctx: SkillCtx, target: { x: number; z: number; range: number; footY?: [number, number] }): void {
  if (xzSatisfied(ctx, target)) return;
  const node = cellOf(ctx.adapter.state().pos);
  throw notConfirmed('xz', `实测节点 (${node.x},${node.y},${node.z}) 不满足水平半径 ${target.range}${target.footY === undefined ? '' : ` / 脚格带 ${target.footY[0]}..${target.footY[1]}`}`, ctx, { target: { x: target.x, z: target.z }, range: target.range, footY: target.footY ?? null });
}

function verifyXyz(ctx: SkillCtx, target: { x: number; y: number; z: number }): void {
  if (xyzSatisfied(ctx, target)) return;
  throw notConfirmed('xyz', `不在目标列/目标脚高 ${target.y.toFixed(2)}`, ctx, { target });
}

function verifyReachBlock(ctx: SkillCtx, target: Vec3Like): void {
  const state = ctx.adapter.state();
  const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
  const eye = ctx.adapter.eye();
  const actualEye = eye === null ? { x: state.pos.x, y: state.pos.y + 1.62, z: state.pos.z } : { x: eye.x, y: eye.y, z: eye.z };
  // 实际交互验收用真实身体/已加载几何；规划期从不用这些原始读取。
  if (ctx.adapter.canInteractAt !== undefined) {
    if (!ctx.adapter.canInteractAt(target, { place: false })) {
      throw notConfirmed('reach_block', '当前眼睛没有确认可见/可点击的方块面', ctx, { target });
    }
    return;
  }
  // 没有实际验收接口的离线身体：只核对实测眼距，不伪造视线结论。
  const node = cellOf(state.pos);
  const hollow = (() => {
    const optics = ctx.adapter.blockOptics(target.x, target.y, target.z);
    return optics?.shapes !== undefined ? optics.shapes.length === 0 : false;
  })();
  if (hollow && dist3(node, { x: target.x, y: target.y, z: target.z }) > 2 + 1e-9) {
    throw notConfirmed('reach_block', `实测节点 (${node.x},${node.y},${node.z}) 距无碰撞目标超过 2 格`, ctx, { target });
  }
  if (dist3(actualEye, center) > REACH_DISTANCE + 0.25) {
    throw notConfirmed('reach_block', `眼睛到方块中心 ${dist3(actualEye, center).toFixed(2)} 格，超过交互距离 ${REACH_DISTANCE}`, ctx, { target });
  }
}

function verifyPlaceBlock(ctx: SkillCtx, target: Vec3Like, facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'): void {
  const state = ctx.adapter.state();
  const node = cellOf(state.pos);
  if (bodyCells(state.pos.y, node.x, node.z).some((cell) => sameCell(cell, target))) {
    throw notConfirmed('place_block', '身体仍站在目标格内', ctx, { target });
  }
  if (ctx.adapter.canInteractAt !== undefined) {
    if (!ctx.adapter.canInteractAt(target, { place: true, ...(facing === undefined ? {} : { facing }) })) {
      throw notConfirmed('place_block', '当前站位没有实际可见的放置贴附面', ctx, { target, facing: facing ?? null });
    }
    return;
  }
  const eye = ctx.adapter.eye();
  const actualEye = eye === null ? { x: state.pos.x, y: state.pos.y + 1.62, z: state.pos.z } : { x: eye.x, y: eye.y, z: eye.z };
  if (dist3(actualEye, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }) > REACH_DISTANCE + 0.25) {
    throw notConfirmed('place_block', '实测眼睛超出放置距离', ctx, { target, facing: facing ?? null });
  }
}

function entityById(ctx: SkillCtx, id: number): { id: number; pos: Vec3Like; height?: number } {
  // 只认当前合法感知到的实体；不读取适配器原始实体表（实时调度会把 nearbyEntities 视为透视）。
  const entity = ctx.senses.perceivedEntities(64).find((candidate) => candidate.id === id);
  if (!entity) throw Object.assign(new Error('ENTITY_GONE'), { name: 'ENTITY_GONE' });
  return { id: entity.id, pos: { ...entity.pos }, ...(entity.height === undefined ? {} : { height: entity.height }) };
}

function verifyFollow(ctx: SkillCtx, id: number, range: number): boolean {
  const entity = entityById(ctx, id);
  const node = cellOf(ctx.adapter.state().pos);
  const entityNode = cellOf(entity.pos);
  const dx = entityNode.x - node.x;
  const dy = entityNode.y - node.y;
  const dz = entityNode.z - node.z;
  return dx * dx + dy * dy + dz * dz <= range * range + 1e-9;
}

async function navigateCandidates(
  ctx: SkillCtx, candidates: Candidate[], deadline: number, signal: AbortSignal, label: Record<string, unknown>, budget: GoalBudget,
): Promise<void> {
  if (candidates.length === 0) {
    const state = ctx.adapter.state();
    throw gap('NO_EVIDENCE', `NAVIGATION_GAP: 共享 VoxelMap 里没有可验证的候选站位；实测位置 (${state.pos.x.toFixed(2)},${state.pos.y.toFixed(2)},${state.pos.z.toFixed(2)})`, {
      ...label, position: { ...state.pos },
    });
  }
  const route = await chooseRoute(ctx, candidates, deadline, signal, budget);
  await executeRoute(ctx, route.chosen, deadline, signal, label, budget);
}

async function navigateBody(ctx: SkillCtx, target: MoveTarget, opts: MoveOpts): Promise<void> {
  if (opts.signal.aborted) throw new AbortedError('navigation cancelled');
  const deadline = Math.min(ctx.deadline, Date.now() + opts.timeoutMs);
  assertLive(ctx, deadline, opts.signal);
  switch (target.kind) {
    case 'feet':
    case 'ladder':
      // 本地身体控制由适配器直接执行；委托不应收到这两类目标。
      throw gap('UNSUPPORTED', `UNSUPPORTED_NAVIGATION: ${target.kind} 属于本地身体控制，不能交给非本地路线委托`);
    case 'near':
      // 已满足的半径目标准先用当前实测身体结算，不要求地图证据或额外路线。
      if (nearSatisfied(ctx, target)) return;
      await navigateCandidates(ctx, nearCandidates(ctx, target), deadline, opts.signal, { requestedTarget: target.pos, range: target.range, kind: 'near' }, goalBudget(deadline));
      assertLive(ctx, deadline, opts.signal);
      verifyNear(ctx, target);
      return;
    case 'xz':
      if (xzSatisfied(ctx, target)) return;
      await navigateCandidates(ctx, xzCandidates(ctx, target), deadline, opts.signal, { requestedTarget: { x: target.x, z: target.z }, range: target.range, footY: target.footY ?? null, kind: 'xz' }, goalBudget(deadline));
      assertLive(ctx, deadline, opts.signal);
      verifyXz(ctx, target);
      return;
    case 'xyz':
      if (xyzSatisfied(ctx, target)) return;
      await navigateExactDirect(ctx, target, deadline, opts.signal, goalBudget(deadline), { requestedTarget: { x: target.x, y: target.y, z: target.z }, kind: 'xyz' });
      assertLive(ctx, deadline, opts.signal);
      verifyXyz(ctx, target);
      return;
    case 'reach_block':
      if (reachSatisfied(ctx, target.pos)) return;
      await navigateCandidates(ctx, blockCandidates(ctx, target.pos, 'reach_block'), deadline, opts.signal, { requestedTarget: target.pos, kind: 'reach_block' }, goalBudget(deadline));
      assertLive(ctx, deadline, opts.signal);
      verifyReachBlock(ctx, target.pos);
      return;
    case 'place_block':
      if (placeSatisfied(ctx, target.pos, target.facing)) return;
      await navigateCandidates(ctx, blockCandidates(ctx, target.pos, 'place_block', target.facing), deadline, opts.signal, { requestedTarget: target.pos, facing: target.facing ?? null, kind: 'place_block' }, goalBudget(deadline));
      assertLive(ctx, deadline, opts.signal);
      verifyPlaceBlock(ctx, target.pos, target.facing);
      return;
    case 'away_from': {
      const state = ctx.adapter.state();
      let dx = state.pos.x - target.pos.x, dz = state.pos.z - target.pos.z;
      const length = Math.hypot(dx, dz) || 1;
      dx /= length; dz /= length;
      const away = { x: state.pos.x + dx * target.distance, z: state.pos.z + dz * target.distance };
      if (xzSatisfied(ctx, { x: away.x, z: away.z, range: 3 })) return;
      await navigateCandidates(ctx, xzCandidates(ctx, { x: away.x, z: away.z, range: 3 }), deadline, opts.signal, { requestedTarget: { ...away }, from: target.pos, distance: target.distance, kind: 'away_from' }, goalBudget(deadline));
      assertLive(ctx, deadline, opts.signal);
      verifyXz(ctx, { x: away.x, z: away.z, range: 3 });
      return;
    }
    case 'follow_entity': {
      // 动态目标：每轮都以实体当前位置重新派生半径目标，但共享同一个原始期限和
      // 累计搜索/transition 预算，不为每次重试新开一份 4s/64 段。
      const budget = goalBudget(deadline);
      for (let round = 0; round < FOLLOW_ROUNDS; round++) {
        assertLive(ctx, deadline, opts.signal);
        const entity = entityById(ctx, target.entityId);
        if (verifyFollow(ctx, target.entityId, target.range)) return;
        const roundDeadline = Math.min(deadline, Date.now() + Math.max(2500, (deadline - Date.now()) / 2));
        await navigateCandidates(ctx, nearCandidates(ctx, { pos: entity.pos, range: target.range }), roundDeadline, opts.signal, { entityId: target.entityId, range: target.range, entityPosition: entity.pos, round, kind: 'follow_entity' }, budget);
      }
      assertLive(ctx, deadline, opts.signal);
      if (verifyFollow(ctx, target.entityId, target.range)) return;
      const entity = entityById(ctx, target.entityId);
      throw notConfirmed('follow_entity', `未追到实体 #${target.entityId} 的 ${target.range} 格内（实体在 ${JSON.stringify(cellOf(entity.pos))}）`, ctx, { entityId: target.entityId, range: target.range, entityPosition: entity.pos });
    }
  }
}

/** 创建当前 SkillCtx 的导航委托；由 runSkill 绑定，所有非本地 moveTo 共享这份上下文。 */
export function createBodyNavigation(ctx: SkillCtx): NavigationDelegate {
  return {
    navigate: (target: MoveTarget, opts: MoveOpts) => navigateBody(ctx, target, opts),
  };
}
