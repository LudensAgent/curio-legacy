import type { Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { observedFootY, searchLandRouteAsync, type LandSearchResult } from '../../spatial/land-search.ts';
import { cellGoal, type NavigationGoal } from './goal.ts';
import { navigateTo } from './navigate.ts';
import { fail, obj, ok, runSkill, validateSkill, type Skill, type SkillResult } from '../types.ts';

type Kind = 'walk' | 'step' | 'drop';
type ApproachArgs = {
  target: Vec3Like;
  allowed: Kind[];
  historical: boolean;
  maxSteps: number;
  allowUnknownCorridor: boolean;
};

const KINDS: readonly Kind[] = ['walk', 'step', 'drop'];
const AIR = /^(air|cave_air|void_air)$/;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const Y_OFFSETS = [0, -1, 1] as const;
/** Shared wall-clock budget for all candidate searches in one go_near call. */
const GO_NEAR_SEARCH_MS = 5000;

const point = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

/**
 * 容器/门/床/传送门的目标是方块，不是站立格。这个动作只负责走到方块旁一个
 * 可到达的相邻站立格；不打开、不拿、不睡、不穿门，也不改交互目标。
 */
export const goNear: Skill<ApproachArgs> = {
  name: 'go_near',
  description: '走到指定容器/门/床/传送门方块旁的一个相邻站立格，为后续 take_items/sleep/travel_portal 做准备。只做路线规划与移动，不打开、不拿、不睡、不穿门，不换交互目标；没有可到达的相邻站立格就停下报事实。',
  catalog: '{"target":{x,y,z}}：走到容器/门/床/传送门方块旁的站立格（target 是方块坐标，不是站立格）',
  argsDoc: '{"target":{"x":整数,"y":整数,"z":整数}（容器/门/床/传送门的方块坐标）,"allowed"?":["walk","step","drop"],"historical"?true,"maxSteps"?16,"allowUnknownCorridor"?false}；不是站立格，站立格先用 resolve_target。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw), target = point(a.target);
    if (!target || !['x', 'y', 'z'].every((k) => Number.isInteger(target[k as 'x' | 'y' | 'z']))) {
      return { ok: false, error: 'target 需要容器/门/床/传送门的整数方块坐标 {x,y,z}' };
    }
    const allowedRaw = a.allowed === undefined ? KINDS : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((k) => !KINDS.includes(k as Kind))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    if (a.maxSteps !== undefined && (!Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > 64)) {
      return { ok: false, error: 'maxSteps 需要 1–64 的整数' };
    }
    if (a.allowUnknownCorridor !== undefined && typeof a.allowUnknownCorridor !== 'boolean') {
      return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    }
    return {
      ok: true,
      args: {
        target,
        allowed: [...new Set(allowedRaw as Kind[])],
        historical: a.historical !== false,
        maxSteps: (a.maxSteps as number | undefined) ?? 16,
        allowUnknownCorridor: a.allowUnknownCorridor === true,
      },
    };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial?.session?.voxel) return fail('NOT_CONNECTED', 'go_near 需要共享空间 VoxelMap；当前没有接线');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'go_near 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', '当前世界与空间会话不一致');
    const target = { x: args.target.x, y: args.target.y, z: args.target.z };
    const targetName = ctx.adapter.blockAt(target);
    if (targetName !== null && AIR.test(targetName)) {
      return fail('BAD_ARGS', `target (${target.x},${target.y},${target.z}) 是空气/站立格；go_near 只用于容器/门/床/传送门方块；走到这个位置用 travel_to {"to":{"x":${target.x},"y":${target.y},"z":${target.z}}} 或 approach_visible {"target":{"pos":…}}，需要逐格核实的精确站位才用 navigate_to`, { target });
    }
    // One deadline for every candidate and the historical fallback: a single
    // go_near call must not multiply the per-search wall-clock budget by 12.
    const deadlineMs = Date.now() + GO_NEAR_SEARCH_MS;
    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
      allowed: args.allowed, maxDrop: 4, rules: walkLandRules, signal: ctx.signal, deadlineMs,
    };
    const targetStem = targetName?.replace(/^minecraft:/, '') ?? '';
    const sameKind = (name: string) => {
      const n = name.replace(/^minecraft:/, '');
      if (targetStem === 'nether_portal') return n === 'nether_portal';
      if (targetStem.endsWith('_bed')) return n.endsWith('_bed');
      return n === targetStem;
    };
    const columnYs = [target.y - 1, target.y, target.y + 1, target.y + 2];
    const candidates = DIRS.flatMap(([dx, dz]) => Y_OFFSETS.map((dy) => ({
      x: target.x + dx, y: target.y + dy, z: target.z + dz,
    }))).filter((to) => !columnYs.some((y) => {
      // 床的另一半、传送门同平面的另一格、双箱子的邻箱都不是“旁边的站立格”。
      const name = ctx.adapter.blockAt({ x: to.x, y, z: to.z })?.replace(/^minecraft:/, '');
      return name !== undefined && name !== null && sameKind(name);
    })).map((to) => ({
      to,
      // 近似候选语义由这里拥有：只在地图里已观测的该列解析真实支撑面；
      // 解析不到就保留候选格猜测脚高，让库返回真实证据缺口，不做全局吸附。
      footY: observedFootY(spatial.session.voxel, state.dim, to.x, to.z, to.y, 2, 2),
    }));
    // 先只跑严格证据；严格全失败才用历史证据回退。
    // 分片搜索：所有候选共用同一个截止时间；搜索期间让出事件循环，取消不必等整轮跑完。
    const strictResults: { to: Vec3Like; footY: number; goal: NavigationGoal; result: LandSearchResult }[] = [];
    for (const candidate of candidates) {
      if (ctx.signal.aborted) break;
      const footY = candidate.footY ?? candidate.to.y;
      const goal = cellGoal({ x: candidate.to.x, z: candidate.to.z }, footY, candidate.to);
      strictResults.push({
        to: candidate.to, footY, goal,
        result: await searchLandRouteAsync(spatial.session.voxel, { ...request, goal }),
      });
    }
    const usable = strictResults.flatMap((entry) =>
      entry.result.status === 'FOUND' && !entry.result.transitions.some((transition) => !(args.allowed as readonly string[]).includes(transition.kind))
        ? [entry] : []);
    if (!usable.length && args.historical) {
      for (const entry of strictResults) {
        if (entry.result.status === 'FOUND' || ctx.signal.aborted) continue;
        const historical = await searchLandRouteAsync(spatial.session.voxel, { ...request, goal: entry.goal, evidenceMode: 'remembered' });
        if (historical.status === 'FOUND'
          && !historical.transitions.some((transition) => !(args.allowed as readonly string[]).includes(transition.kind))) {
          usable.push({ ...entry, result: historical });
        }
      }
    }
    usable.sort((a, b) => (a.result.evidenceMode === b.result.evidenceMode ? 0 : a.result.evidenceMode === 'current' ? -1 : 1)
      || a.result.cost - b.result.cost);
    const chosen = usable[0];
    if (!chosen) {
      const attempts = strictResults.map(({ to, result }) => ({
        to, status: result.status, budget: result.budget ?? null,
        searchMs: result.stats.durationMs, yieldCount: result.stats.yieldCount,
        maxSyncSliceMs: result.stats.maxSyncSliceMs, boundaries: result.boundaries.length,
        unavailableSections: result.unavailableSections.length, policy: result.policy ?? null,
      }));
      // 预算耗尽、证据不足和“已存几何无路”都不是同一件事：不能一律报 PATH_NOT_FOUND。
      const budgetHit = strictResults.some(({ result }) => result.status === 'BUDGET_EXHAUSTED');
      const timeBudgetHit = strictResults.some(({ result }) => result.budget === 'time');
      const noPath = strictResults.some(({ result }) => result.status === 'NO_PATH_IN_MEMORY');
      const insufficientEvidence = strictResults.some(({ result }) => result.status === 'INSUFFICIENT_EVIDENCE');
      const unsupported = !budgetHit && !noPath && !insufficientEvidence
        && strictResults.some(({ result }) => result.status === 'UNSUPPORTED');
      const reason = budgetHit
        ? `搜索预算已耗尽（${timeBudgetHit ? `时间 ${GO_NEAR_SEARCH_MS}ms` : `原因 ${strictResults.find(({ result }) => result.status === 'BUDGET_EXHAUSTED')?.result.budget ?? '节点/边'}`}；${strictResults.length} 个候选），不代表没有路；先缩小范围或走近再试`
        : noPath
          ? '所有候选都返回 NO_PATH_IN_MEMORY（已存几何里没有相邻站立格路线）'
          : insufficientEvidence
            ? `候选都缺证据（INSUFFICIENT_EVIDENCE），不能当成已确认无路；先 look_around/走近刷新证据`
            : unsupported
              ? `候选目标不被现有搜索支持（UNSUPPORTED）：${strictResults.find(({ result }) => result.status === 'UNSUPPORTED')?.result.reason ?? ''}`
              : '所有候选都没有找到可用路线';
      return fail(budgetHit ? 'TIMEOUT' : unsupported ? 'BAD_ARGS' : noPath ? 'PATH_NOT_FOUND' : 'NOT_FOUND', `go_near 没有找到可到达 ${targetName ?? '目标方块'} 旁的相邻站立格：${reason}；不会把目标方块本身当站立格`, {
        target, targetName, candidates: attempts, candidateCount: strictResults.length,
        budgetMs: GO_NEAR_SEARCH_MS, budgetHit, timeBudgetHit, insufficientEvidence, position: { ...state.pos },
      });
    }
    // 候选站位的脚高在搜索边界解析（近似候选语义）；库只接受这个精确脚高，
    // 不会在执行时再把它吸附到别的支撑面。交给 navigate_to 的格目标使用同一脚高。
    const stance = { x: chosen.to.x, y: chosen.result.target.y, z: chosen.to.z };
    const nested = validateSkill(navigateTo, {
      to: stance,
      allowed: args.allowed,
      historical: args.historical,
      maxSteps: args.maxSteps,
      allowUnknownCorridor: args.allowUnknownCorridor,
    }, ctx.adapter);
    if (!nested.ok) return fail('BAD_ARGS', `go_near 生成 navigate_to 参数无效：${nested.error}；没有移动`, { target, chosen: stance });
    const moved: SkillResult = await runSkill(ctx, navigateTo, nested.args);
    if (moved.status !== 'succeeded') {
      const { local: _local, around: _around, ...data } = (moved.data ?? {}) as Record<string, unknown>;
      return fail(moved.failureCode ?? 'ERROR', `go_near 没能走到 ${targetName ?? '目标方块'} 旁：${moved.summary}`, {
        target, targetName, chosen: stance, navigation: { code: moved.failureCode ?? 'ERROR', summary: moved.summary, data },
      });
    }
    // 把原目标的精确坐标回显进摘要：模型只看到摘要，写“指向原目标”时经常丢掉 target。
    const targetArg = JSON.stringify({ x: target.x, y: target.y, z: target.z });
    return ok(`已到 ${targetName ?? '目标方块'} (${target.x},${target.y},${target.z}) 旁的站立格 (${stance.x},${stance.y},${stance.z})；后续动作的 target 写 ${targetArg}（容器用 take_items/store_items，床用 sleep，门/工作站用 interact_block/use_gui，传送门用 observe_portal/travel_portal）`, {
      target, targetName, chosen: stance, evidenceMode: chosen.result.evidenceMode,
      policy: chosen.result.policy ?? null,
      candidateCount: strictResults.length, budgetMs: GO_NEAR_SEARCH_MS,
      maxSyncSliceMs: Math.max(...strictResults.map(({ result }) => result.stats.maxSyncSliceMs)),
      navigation: moved.data, position: { ...ctx.adapter.state().pos },
    });
  },
};
