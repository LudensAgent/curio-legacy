import type { Vec3Like } from '../../adapter/types.ts';
import { surface } from '../movement.ts';
import { swimTo } from '../actions.ts';
import { fail, obj, type Skill } from '../types.ts';

const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

type SwimMode = 'water_point' | 'dry_shore' | 'surface';
type SwimArgs = { xyz?: Vec3Like; mode: SwimMode; timeoutMs?: number };

/**
 * L2 水面执行器：把旧 swim_to / surface 的完成语义收成一个入口。
 * 不挖、不垫、不换目标；水面路线规划仍由现有 planWaterRoute 承担。
 */
export const swimPath: Skill<SwimArgs> = {
  name: 'swim_path',
  description: '在水面/水中执行一次有界游泳：mode:"water_point" 到指定水中点，mode:"dry_shore" 到指定干岸并离水站稳，mode:"surface" 有界上浮换气。不挖、不垫、不换目标；未到时如实报告位置、氧气、阶段、头顶挡块和最近开口水面。',
  argsDoc: '{"xyz":[x,y,z], "mode":"water_point|dry_shore|surface", "timeoutMs"?:1000-20000}；surface 不接受 xyz；water_point/dry_shore 必须给 xyz（脚坐标；整数 x/z 按方块坐标取格心 +0.5；目标格必须可查询/已加载〔blockAt 非 null〕，否则拒绝）。旧名 step/dig_at/place_at 不再注册（改用 move_step/mine_cell/place_cell）；自动 ≤4 格落差已移交 descend_to/move_step，水中上岸由 swim_path 完成；jump/climb_one 的替代是 pillar_one 与 move_step [1,1,0]。',
  timeoutMs: 25000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const mode = a.mode ?? (a.xyz !== undefined ? 'dry_shore' : 'surface');
    if (mode !== 'water_point' && mode !== 'dry_shore' && mode !== 'surface') return { ok: false, error: 'mode 必须是 water_point、dry_shore 或 surface' };
    const timeoutMs = a.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 20000)) return { ok: false, error: 'timeoutMs 必须是 1000–20000 的毫秒数' };
    if (mode === 'surface') {
      if (a.xyz !== undefined) return { ok: false, error: 'surface 不接受 xyz；要游到指定点用 water_point/dry_shore' };
      return { ok: true, args: { mode, ...(timeoutMs !== undefined ? { timeoutMs: Math.round(Number(timeoutMs)) } : {}) } };
    }
    const v = a.xyz ?? a.to ?? a.at;
    const arr = typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean).map(Number)
      : Array.isArray(v) ? v.map(Number)
        : v && typeof v === 'object' ? [Number((v as Record<string, unknown>).x), Number((v as Record<string, unknown>).y), Number((v as Record<string, unknown>).z)]
          : null;
    if (!arr || arr.length !== 3 || !arr.every(Number.isFinite)) return { ok: false, error: 'water_point/dry_shore 需要 xyz:[x,y,z]（脚坐标）' };
    // 整数 x/z 是方块边界，身体会卡在两列之间（实机两次“目标 x/z 落在方块边界上”）：在这一层按方块坐标取格心。
    // 已带小数的脚坐标原样保留；规范化结果带 .5，再校验不变。底层 swim_to 仍原样使用给它的坐标。
    const centre = (n: number) => Number.isInteger(n) ? n + 0.5 : n;
    return { ok: true, args: { mode, xyz: { x: centre(arr[0]), y: arr[1], z: centre(arr[2]) }, ...(timeoutMs !== undefined ? { timeoutMs: Math.round(Number(timeoutMs)) } : {}) } };
  },
  async run(ctx, args) {
    if (args.mode === 'surface') return surface.run(ctx, { ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) });
    // 脚坐标可带小数（整数 x/z 已取格心）：按所在方块格查询。
    const target = ctx.adapter.blockAt({ x: Math.floor(args.xyz!.x), y: Math.floor(args.xyz!.y), z: Math.floor(args.xyz!.z) });
    // 目标格不可查询（blockAt 返回 null，通常是区块未加载）就拒绝：底层 swimTo 对未知目标会按干岸验收，会把 water_point/dry_shore 静默重解释。
    if (target === null) {
      return fail('BAD_ARGS', `目标 (${args.xyz!.x},${args.xyz!.y},${args.xyz!.z}) 不可查询（blockAt 返回 null，通常是区块未加载）；不进入游泳控制器，避免把 mode:"${args.mode}" 静默当成干岸验收`, { target: args.xyz, blockKnown: false, mode: args.mode });
    }
    if (args.mode === 'dry_shore' && WATER.has(target)) {
      return fail('BAD_ARGS', `目标是水中 ${target}，不是干岸；要游到水中点用 mode:"water_point"`, { target: args.xyz, unsupportedTarget: target });
    }
    if (args.mode === 'water_point' && !WATER.has(target)) {
      return fail('BAD_ARGS', `目标格是 ${target}，不是水中点；要上岸用 mode:"dry_shore"`, { target: args.xyz, unsupportedTarget: target });
    }
    // 旧 swimTo 已有 water_point/dry_shore 的完成语义；这里只把参数收窄到明确的 xyz。
    return swimTo.run(ctx, { xyz: args.xyz!, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) });
  },
};
