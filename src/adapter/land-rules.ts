import type { ClimbRegionProvider, LandMotionModel, LandRules } from 'curio-minecraft-3d-memory';
import { walkCollisionProvider } from './walk-route.ts';

/**
 * Java 1.20.1 站立身体的跳跃几何上限。库的 LandMotionModel 只接受连续二次曲线；
 * 这里给的是几何模型，不是对 Minecraft 物理的完整仿真，也不代表落地一定安全。
 */
export const walkJumpModel: LandMotionModel = {
  version: 'curio-java-1.20.1-standing-jump-v1',
  resolve({ from, to, body }) {
    if (body.width !== 0.6 || body.height !== 1.8 || body.pose !== 'standing') {
      return { kind: 'unsupported', detail: '跳跃模型只接 0.6×1.8 站立身体' };
    }
    if (Math.abs(from.y - to.y) > 1e-9) return { kind: 'unsupported', detail: '跳跃模型只接同脚高的水平移动' };
    return { kind: 'supported', trajectory: { apexHeight: 1.25 } };
  },
};

const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding']);

/** Same explicit climbable set as `walkClimbProvider`; no collision inference. */
export function isClimbableBlockName(name: string): boolean {
  return CLIMBABLE.has(name.replace(/^minecraft:/, ''));
}

/** 可攀爬方块由 blockstate + 身体尺寸显式声明；不从“碰撞为空”反推是梯子。 */
export const walkClimbProvider: ClimbRegionProvider = {
  version: 'curio-java-1.20.1-climbable-v1',
  resolve(input) {
    const name = input.state.name.replace(/^minecraft:/, '');
    if (input.body.width !== 0.6 || input.body.height !== 1.8 || input.body.pose !== 'standing') {
      return { kind: 'unsupported', detail: '攀爬只接 0.6×1.8 站立身体' };
    }
    if (!CLIMBABLE.has(name)) return { kind: 'regions', regions: [] };
    return { kind: 'regions', regions: [{ minFeetY: input.cell.y, maxFeetY: input.cell.y + 1 }] };
  },
};

/** 垂直/台阶/下落/跳跃/梯子判定共用的 1.20.1 规则集合。 */
export const walkLandRules: LandRules = {
  shapeProvider: walkCollisionProvider,
  jumpModel: walkJumpModel,
  climbProvider: walkClimbProvider,
};
