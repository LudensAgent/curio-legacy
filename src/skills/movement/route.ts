import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRouteAsync, summarizeBoundaries, verifyLandRouteBounded, type LandRouteVerification, type LandSearchResult } from '../../spatial/land-search.ts';
import { goalOf, stanceFor, type NavigationGoal } from './goal.ts';
import { fail, obj, ok, type FailureCode, type Skill, type SkillCtx } from '../types.ts';

/** 只读的体素路线预览。执行入口只有 navigate_to / advance；source 只接受 auto/spatial。 */
type RouteSource = 'auto' | 'spatial';
type PlanArgs = {
  to: Vec3Like;
  mode: 'walk';
  source: RouteSource;
  arrival: { kind: 'exact' };
  deadlineMs?: number;
};

/** Shared wall-clock budget for the strict + remembered 3D A* passes. */
const SPATIAL_SEARCH_MS = 2500;

const BODY = { feet: { x: 0, y: 0, z: 0 }, width: 0.6, height: 1.8, pose: 'standing' as const };

const finitePoint = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

/**
 * `plan_route` 的 to 沿用其它动作的方块格坐标约定：x/z 是整数时表示“走到那一格”。
 * 库的步行格点以实测脚位为原点，只接受整数 X/Z 偏移；玩家实际脚位几乎总带小数
 * （如 -61.3/-42.7），直接把整数格坐标传进去会被判成“非整数偏移”。
 * 这里只由共享 goal 语义派生一次：格目标取目标格内与起点相同的偏移；连续目标原样。
 */
function planTarget(to: Vec3Like, from: Vec3Like): { goal: NavigationGoal; stance: Vec3Like; cell?: Vec3Like } {
  const goal = goalOf(to);
  const stance = stanceFor(goal, from);
  return {
    goal,
    stance,
    ...(goal.kind === 'cell' ? { cell: { x: goal.cell.x, y: goal.footY, z: goal.cell.z } } : {}),
  };
}

const facingOf = (from: Vec3Like, to: Vec3Like): 'N' | 'E' | 'S' | 'W' => {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W';
  return dz >= 0 ? 'S' : 'N';
};

/**
 * 格目标的 3D 搜索结果只翻译成现有动作：walk/step/drop=1 → move_step，drop>1 → descend_to。
 * 连续精确脚位没有等价的格动作，返回空数组；执行请用 navigate_to 保持连续 endpoint，
 * 不能用 move_step 的格心动作冒充。
 */
export function landSearchSteps(result: Pick<LandSearchResult, 'transitions'>, goalKind: NavigationGoal['kind'] = 'cell') {
  const centered = (p: Vec3Like) => Math.abs(p.x - (Math.floor(p.x) + 0.5)) <= 1e-6
    && Math.abs(p.z - (Math.floor(p.z) + 0.5)) <= 1e-6;
  // 连续目标只有恰好落在目标格心时，move_step/descend_to 才是等价动作；
  // 任意分数偏移不生成会把它格心化的步骤。
  if (goalKind === 'feet' && !result.transitions.every((transition) => centered(transition.from) && centered(transition.to))) return [];
  return result.transitions.map((transition) => {
    // L1 move_step 的绝对 xyz 是“方块格”坐标；descend_to 的 target 也会规整到格心。
    const fromCell = { x: Math.floor(transition.from.x), y: transition.from.y, z: Math.floor(transition.from.z) };
    const toCell = { x: Math.floor(transition.to.x), y: transition.to.y, z: Math.floor(transition.to.z) };
    return transition.kind === 'drop' && transition.drop > 1
      ? { skill: 'descend_to', args: { target: { x: toCell.x, y: toCell.y, z: toCell.z } } }
      : {
          skill: 'move_step',
          args: { xyz: [toCell.x, toCell.y, toCell.z], facing: facingOf(fromCell, toCell) },
        };
  });
}

async function spatialRoute(spatial: NonNullable<SkillCtx['spatial']>, state: AgentState, goal: NavigationGoal, signal: AbortSignal, deadlineMs: number) {
  const request = {
    worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
    body: { feet: { ...state.pos }, width: BODY.width, height: BODY.height, pose: BODY.pose },
    goal,
    maxDrop: 4,
    rules: walkLandRules,
    signal,
    deadlineMs,
  };
  // 先用当前证据；找不到时再用历史体素候选。历史体素逐段用真实当前证据复验，
  // 执行时仍由连续身体控制逐步核实。两次搜索共用同一截止时间。
  const strict = await searchLandRouteAsync(spatial.session.voxel, request);
  const historical = strict.status === 'FOUND' ? null
    : await searchLandRouteAsync(spatial.session.voxel, { ...request, evidenceMode: 'remembered' });
  const result = strict.status === 'FOUND' ? strict
    : historical?.status === 'FOUND' ? historical
      : historical?.status === 'NO_PATH_IN_MEMORY' ? historical
        : strict;
  const steps = result.status === 'FOUND' ? landSearchSteps(result, goal.kind) : [];
  // boundarySummary 只汇总它伴随的 result.boundaries，避免同一回执里边界列表与计数
  // 来自不同证据来源。当前证据（strict）的前缀单独命名，历史几何不冒充可通行。
  const resultBoundarySummary = summarizeBoundaries(result.boundaries);
  const currentPrefix = strict.prefix;
  const currentBoundarySummary = summarizeBoundaries(strict.boundaries);
  const accessible = result === strict ? currentPrefix : undefined;
  const counts = result.transitions.reduce<Record<string, number>>((all, transition) => ({ ...all, [transition.kind]: (all[transition.kind] ?? 0) + 1 }), {});
  const detail = Object.entries(counts).map(([kind, count]) => `${kind}×${count}`).join('、');
  const stepCounts = steps.reduce<Record<string, number>>((all, step) => ({ ...all, [step.skill]: (all[step.skill] ?? 0) + 1 }), {});
  const stepDetail = Object.entries(stepCounts).map(([skill, count]) => `${skill}×${count}`).join('、');
  // 只给数量时模型无法执行这些步骤；把前几步参数放进摘要，明确“先执行它们，再重新规划”。
  const stepPreview = steps.slice(0, 3).map((step) => `${step.skill} ${JSON.stringify(step.args)}`).join('；');
  const boundaryCounts = result.boundaries.reduce<Record<string, number>>((all, boundary) => {
    const key = `${boundary.status}/${boundary.kind}`;
    all[key] = (all[key] ?? 0) + 1;
    return all;
  }, {});
  const boundaryDetail = Object.entries(boundaryCounts).map(([key, count]) => `${key}×${count}`).join('、');
  const stale = result.stats.staleReads > 0;
  const boundaryGuidance = result.status === 'INSUFFICIENT_EVIDENCE'
    ? `还有未观察/待重新确认（STALE：自身动作的效果未确认或观测互相矛盾）的边界${stale ? '，部分格待重新确认' : ''}；先 look_around/靠近刷新证据再试`
    : result.status === 'NO_PATH_IN_MEMORY'
      ? result.evidenceMode === 'historical'
        ? '历史体素里也没有 walk/step/drop 路线（NO_PATH_IN_MEMORY）；需要挖/垫/搭、观察或换目标'
        : '已存几何里没有 walk/step/drop 路线（NO_PATH_IN_MEMORY）；需要挖/垫/搭、观察或换目标'
      : result.status === 'UNSUPPORTED'
        ? `搜索不支持该精确目标：${result.reason}；不自动改写成附近格或吸附脚高`
        : result.status === 'INVALIDATED'
          ? '搜索期间地图证据/驻留发生变化；重新观察或重试'
          : result.status === 'BUDGET_EXHAUSTED'
            ? result.budget === 'time'
              ? `搜索时间预算耗尽（${result.stats.durationMs}ms / ${SPATIAL_SEARCH_MS}ms），先规划更近的一段或走近再试`
              : `搜索 ${result.budget ?? '节点/边'} 预算耗尽（${result.stats.durationMs}ms），先规划更近的一段`
            : '先规划更近的一段，或走近/看清后再试';
  const fmt = (v: Vec3Like) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
  const accessibleNote = result === strict
    ? accessible === undefined || accessible.transitions.length === 0
      ? '没有已知可通行前缀'
      : `已知可通行的最远 approach 只到 ${fmt(accessible.endpoint)}（${accessible.transitions.length} 段），这不是到达`
    : currentPrefix === undefined || currentPrefix.transitions.length === 0
      ? '历史搜索无完整路线；当前证据下也没有可达前缀'
      : `历史搜索无完整路线；当前证据下存在可达前缀到 ${fmt(currentPrefix.endpoint)}（${currentPrefix.transitions.length} 段），这不是到达`;
  const boundaryNote = `；${resultBoundarySummary.observationMayResolve ? '额外观察/靠近可能刷新证据' : resultBoundarySummary.total === 0 ? '没有记录到边界' : '额外观察不会改变已观测阻挡'}；${resultBoundarySummary.needsExplicitActionOrOtherRoute ? '存在需要显式动作/其他移动能力/换路线的边界' : '未记录到需要挖/建或换路线的边界'}`;
  const routeLabel = result.evidenceMode === 'historical' ? '历史体素路线（含待重新确认的证据，当前可通行性未知）' : '空间 3D 路线';
  // 历史候选的显式复验：共享原 deadline、取消感知、逐段有界并让出事件循环。
  const verification = result.status === 'FOUND' && result.evidenceMode === 'historical'
    ? await verifyLandRouteBounded(spatial.session.voxel, {
        worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
        body: { feet: { ...state.pos }, width: BODY.width, height: BODY.height, pose: BODY.pose },
        rules: walkLandRules,
      }, result.transitions, { deadlineMs, signal })
    : undefined;
  const blocker = blockerOf(verification);
  const verifyCoverage = verification?.coverage;
  // 搜索候选已经完整（FOUND），但当前证据复验可以因真实取消提前停止。两者是不同事实：
  // 保留搜索终态与候选，只把“复验被取消、没有完整 OPEN”作为这次规划的公开结局。
  const verificationCancelled = verifyCoverage?.stopped === 'cancelled';
  const verifyNote = verification === undefined
    ? ''
    : `；严格当前证据复验：${verification.verdict}（当前 OPEN ${verification.openPrefix}/${result.transitions.length} 段${verifyCoverage !== undefined && !verifyCoverage.complete ? `；只检查了 ${verifyCoverage.checked}/${verifyCoverage.total} 段，其余为 UNKNOWN，不是 OPEN` : ''}${verificationCancelled ? '；复验被取消，没有完成整条路线' : ''}）${blocker === null ? '' : `；第 ${blocker.index + 1} 段 ${blocker.status}，执行时停在 blocker 前、不自动挖`}`;
  const stepsNote = goal.kind === 'feet'
    ? '；这是精确连续脚位路线，没有 move_step 等价动作，请用 navigate_to 执行'
    : '';
  return {
    result,
    steps,
    verificationCancelled,
    verificationCoverage: verifyCoverage,
    summary: result.status === 'FOUND'
      ? `${routeLabel} ${result.transitions.length} 段（${detail || '无'}）；${steps.length > 0 ? `已生成现有动作步骤：${stepDetail || '无'}。先执行：${stepPreview}${steps.length > 3 ? '；…' : ''}` : '未生成格动作步骤'}${stepsNote}；只读规划，不是执行授权；执行请用 navigate_to/advance，按现场事实逐步核实，失败再重新规划${verifyNote}；drop>1 的 descend_to 仍要求当前可见落点`
      : `${result.evidenceMode === 'historical' ? '历史体素' : '空间 3D'}搜索没有可用路线：${result.status}（${result.boundaries.length} 个边界事实${boundaryDetail ? `：${boundaryDetail}` : ''}）；${accessibleNote}；${boundaryGuidance}${boundaryNote}`,
    facts: {
      source: 'spatial', backend: 'spatial_voxel_search', searchStatus: result.status,
      assurance: result.assurance, evidenceMode: result.evidenceMode, currentPassability: 'UNKNOWN', executable: false,
      targetKind: goal.kind, requestedTarget: { ...goal.requested },
      points: result.points, transitions: result.transitions, steps: result.status === 'FOUND' ? steps : [],
      boundaries: result.boundaries, cost: result.cost, resolvedTarget: result.resolvedTarget,
      stats: result.stats, budgetMs: SPATIAL_SEARCH_MS, searchMs: result.stats.durationMs,
      budget: result.budget ?? null, reason: result.reason,
      policy: result.policy ?? null,
      unavailableSections: result.unavailableSections,
      boundarySummary: resultBoundarySummary,
      ...(accessible === undefined ? {} : { prefix: accessible, prefixSteps: landSearchSteps(accessible, goal.kind) }),
      ...(result === strict ? {} : {
        ...(currentPrefix === undefined ? {} : { currentPrefix }),
        currentBoundaries: strict.boundaries,
        currentBoundarySummary,
      }),
      ...(verification === undefined ? {} : { verification, verifiedOpenSegments: verification.openPrefix, blocker }),
    },
  };
}

/** 历史候选复验中的首个当前证据 BLOCKED 段；没有复验或没有 BLOCKED 时返回 null。 */
export function blockerOf(verification: LandRouteVerification | undefined) {
  if (verification === undefined) return null;
  const index = verification.transitions.findIndex((entry) => entry.status === 'BLOCKED');
  if (index < 0) return null;
  const entry = verification.transitions[index]!;
  return {
    index,
    transition: entry.transition,
    status: entry.status,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    hazards: entry.hazards,
  };
}

/** 只执行 blocker 之前的前缀；STALE/UNKNOWN 不算已观测阻挡，由执行动作逐步复核。 */
export function executionWindow(verification: LandRouteVerification | undefined, maxSteps: number, total: number) {
  const blocker = blockerOf(verification);
  return { blocker, limit: Math.min(maxSteps, blocker === null ? total : blocker.index) };
}

/**
 * 只读体素路线预览。执行入口只有 navigate_to / advance；不移动、不观察、不写库。
 * `auto` 与 `spatial` 都只在已观测 VoxelMap 上做有界 3D 搜索（当前证据优先，
 * 可返回 remembered 历史体素候选）。
 */
export const planRoute: Skill<PlanArgs> = {
  name: 'plan_route',
  description: '只读体素路线预览：在已观测 VoxelMap 上做有界 3D 搜索（walk/step/drop），返回现有动作 steps（move_step/descend_to；精确连续脚位不给格动作）与搜索终态；历史体素候选额外带当前证据逐段复验的 verifiedOpenSegments/blocker。不移动/观察/写库，不挖/放/搭柱；执行请用 navigate_to/advance。spatial 失败时返回搜索终态（INSUFFICIENT_EVIDENCE/NO_PATH_IN_MEMORY/UNSUPPORTED/INVALIDATED/BUDGET_EXHAUSTED）、当前证据可达前缀 endpoint/transitions/prefixSteps 与 boundarySummary（边界位置/方向/状态/原因；前缀不是到达）；若回执采用历史体素候选，当前证据前缀另放 currentPrefix/currentBoundaries/currentBoundarySummary，不混用。',
  argsDoc: '{"to":{"x":0,"y":64,"z":0},"mode"?:"walk","source"?:"auto|spatial","arrival"?:{"kind":"exact"},"deadlineMs"?:绝对 epoch 毫秒}；to 是绝对坐标（整数 x/z 为方块格，分数按精确脚位；名字先用 resolve_target）。spatial 返回 points/transitions 和现有动作 steps，可能带 historical 标记（历史体素、当前可通行性未知，执行时逐步核实）；spatial 失败时返回可达前缀与边界摘要，前缀不是到达，也不会自动执行；执行只用 navigate_to/advance。',
  timeoutMs: 15000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const a = obj(raw);
    const allowed = new Set(['to', 'mode', 'source', 'arrival', 'deadlineMs']);
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length) return { ok: false, error: `plan_route 不认识参数 ${unknown.join('、')}；只接受 ${[...allowed].join('、')}` };
    const to = finitePoint(a.to);
    if (!to) return { ok: false, error: 'to 需要绝对坐标 {x,y,z}；名字/方向先用 resolve_target' };
    const mode = a.mode ?? 'walk';
    if (mode !== 'walk') return { ok: false, error: 'plan_route 当前只支持 mode:"walk"；游泳用 swim_path，船用 boat_path' };
    const source = a.source ?? 'auto';
    if (source !== 'auto' && source !== 'spatial') return { ok: false, error: 'source 必须是 auto 或 spatial' };
    const arrival = a.arrival ?? { kind: 'exact' };
    if (!arrival || typeof arrival !== 'object' || Array.isArray(arrival) || (arrival as Record<string, unknown>).kind !== 'exact') {
      return { ok: false, error: 'arrival 当前只支持 {"kind":"exact"}；要走到附近请指定具体目标格' };
    }
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { to, mode: 'walk', source, arrival: { kind: 'exact' }, ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial) return fail('NOT_CONNECTED', 'plan_route 需要宿主共享空间会话（ctx.spatial）；当前未接线，不能用 pathfinder 兜底');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'plan_route 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', `当前世界 ${state.worldId} 与空间会话 ${spatial.worldId} 不一致`);
    if (spatial.closing || spatial.paused || !spatial.observationAdmitted) return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，不能规划路线');
    const deadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    if (Date.now() >= deadline) return fail('TIMEOUT', 'plan_route 期限在开始前已耗尽', { classification: 'TIMEOUT' });
    if (!spatial.session?.voxel) {
      return fail('NOT_CONNECTED', `plan_route source:"${args.source}" 需要共享空间 VoxelMap`);
    }
    const from = { ...state.pos };
    const { goal, stance, cell } = planTarget(args.to, from);
    const cellNote = cell === undefined
      ? ''
      : `；目标格 (${cell.x},${cell.y},${cell.z})，按当前脚下偏移取格内站位 (${stance.x.toFixed(2)},${stance.y},${stance.z.toFixed(2)})`;
    const candidate = await spatialRoute(spatial, state, goal, ctx.signal, Math.min(deadline, Date.now() + SPATIAL_SEARCH_MS));
    const facts = { ...candidate.facts, ...(cell === undefined ? {} : { targetCell: cell }), requestedTarget: { ...args.to }, targetStance: { ...stance } };
    // 搜索已完成并给出候选，但随后的当前证据复验被真实取消：公开结局是取消，
    // 不能因为搜索 FOUND 就报 ok，也不能把搜索改写成 CANCELLED 或丢掉候选事实。
    if (candidate.verificationCancelled) {
      const coverage = candidate.verificationCoverage;
      const checked = coverage?.checked ?? 0;
      const total = coverage?.total ?? facts.transitions.length;
      return { status: 'cancelled', summary: `路线预览被取消：搜索候选仍是 FOUND（${facts.transitions.length} 段），但当前证据复验在取消时只检查了 ${checked}/${total} 段，未得到完整 OPEN${cellNote}`, data: facts };
    }
    if (candidate.result.status === 'FOUND') return ok(`${candidate.summary}${cellNote}`, facts);
    if (candidate.result.status === 'CANCELLED') return { status: 'cancelled', summary: `${candidate.summary}${cellNote}`, data: facts };
    const code: FailureCode = candidate.result.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT'
      : candidate.result.status === 'INSUFFICIENT_EVIDENCE' ? 'NOT_FOUND'
        : candidate.result.status === 'UNSUPPORTED' ? 'BAD_ARGS'
          : 'PATH_NOT_FOUND';
    return fail(code, `${candidate.summary}${cellNote}`, facts);
  },
};
