import type { Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRoute, type LandSearchResult } from '../../spatial/land-search.ts';
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
      return fail('BAD_ARGS', `target (${target.x},${target.y},${target.z}) 是空气/站立格；go_near 只用于容器/门/床/传送门方块，走到站立格请用 navigate_to`, { target });
    }
    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
      maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
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
    }));
    const usable = candidates.flatMap((to) => {
      const strict = searchLandRoute(spatial.session.voxel, { ...request, to });
      const historical = strict.status === 'FOUND' || !args.historical
        ? null : searchLandRoute(spatial.session.voxel, { ...request, to, allowStale: true });
      const result: LandSearchResult | null = strict.status === 'FOUND' ? strict
        : historical?.status === 'FOUND' ? historical : null;
      if (result === null || result.transitions.some((transition) => !args.allowed.includes(transition.kind))) return [];
      return [{ to, result }];
    });
    usable.sort((a, b) => (a.result.evidenceMode === b.result.evidenceMode ? 0 : a.result.evidenceMode === 'current' ? -1 : 1)
      || a.result.cost - b.result.cost);
    const chosen = usable[0];
    if (!chosen) {
      const attempts = candidates.map((to) => {
        const strict = searchLandRoute(spatial.session.voxel, { ...request, to });
        return { to, status: strict.status, boundaries: strict.boundaries.length };
      });
      return fail('PATH_NOT_FOUND', `go_near 没有找到可到达 ${targetName ?? '目标方块'} 旁的相邻站立格；不会把目标方块本身当站立格`, {
        target, targetName, candidates: attempts, position: { ...state.pos },
      });
    }
    const nested = validateSkill(navigateTo, {
      to: chosen.to,
      allowed: args.allowed,
      historical: args.historical,
      maxSteps: args.maxSteps,
      allowUnknownCorridor: args.allowUnknownCorridor,
    }, ctx.adapter);
    if (!nested.ok) return fail('BAD_ARGS', `go_near 生成 navigate_to 参数无效：${nested.error}；没有移动`, { target, chosen: chosen.to });
    const moved: SkillResult = await runSkill(ctx, navigateTo, nested.args);
    if (moved.status !== 'succeeded') {
      const { local: _local, around: _around, ...data } = (moved.data ?? {}) as Record<string, unknown>;
      return fail(moved.failureCode ?? 'ERROR', `go_near 没能走到 ${targetName ?? '目标方块'} 旁：${moved.summary}`, {
        target, targetName, chosen: chosen.to, navigation: { code: moved.failureCode ?? 'ERROR', summary: moved.summary, data },
      });
    }
    return ok(`已到 ${targetName ?? '目标方块'} (${target.x},${target.y},${target.z}) 旁的站立格 (${chosen.to.x},${chosen.to.y},${chosen.to.z})；现在可以用 take_items/sleep/travel_portal 指向原目标`, {
      target, targetName, chosen: chosen.to, evidenceMode: chosen.result.evidenceMode,
      navigation: moved.data, position: { ...ctx.adapter.state().pos },
    });
  },
};
