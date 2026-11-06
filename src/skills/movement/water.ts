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
  argsDoc: '{"xyz":[x,y,z], "mode":"water_point|dry_shore|surface", "timeoutMs"?:1000-20000}；surface 不接受 xyz；water_point/dry_shore 必须给 xyz（脚坐标）。',
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
    return { ok: true, args: { mode, xyz: { x: arr[0], y: arr[1], z: arr[2] }, ...(timeoutMs !== undefined ? { timeoutMs: Math.round(Number(timeoutMs)) } : {}) } };
  },
  async run(ctx, args) {
    if (args.mode === 'surface') return surface.run(ctx, { ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) });
    const target = ctx.adapter.blockAt(args.xyz!);
    if (target !== null && args.mode === 'dry_shore' && WATER.has(target)) {
      return fail('BAD_ARGS', `目标是水中 ${target}，不是干岸；要游到水中点用 mode:"water_point"`, { target: args.xyz, unsupportedTarget: target });
    }
    if (target !== null && args.mode === 'water_point' && !WATER.has(target)) {
      return fail('BAD_ARGS', `目标格是 ${target}，不是水中点；要上岸用 mode:"dry_shore"`, { target: args.xyz, unsupportedTarget: target });
    }
    // 旧 swimTo 已有 water_point/dry_shore 的完成语义；这里只把参数收窄到明确的 xyz。
    return swimTo.run(ctx, { xyz: args.xyz!, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) });
  },
};
