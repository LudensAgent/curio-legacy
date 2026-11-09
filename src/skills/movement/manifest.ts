import { l1Primitives } from './primitives.ts';
import type { EffectKind, PrimitiveProblemKind } from './receipt.ts';

/**
 * L1 基础动作的静态契约清单：参数、几何范围、前置条件、效果和结构化失败码。
 * name / argsDoc / timeoutMs / movement 直接从实际技能对象取，避免文档与实现脱节。
 */
export interface PrimitiveContract {
  name: string;
  args: string;
  timeoutMs: number;
  movement: boolean;
  geometry: { relative?: { front: number; up: [number, number]; right: number }; absolute?: string };
  preconditions: string[];
  effects: EffectKind[];
  problems: PrimitiveProblemKind[];
}

type Declared = Omit<PrimitiveContract, 'name' | 'args' | 'timeoutMs' | 'movement'>;

const DECLARED: Record<string, Declared> = {
  move_step: {
    geometry: {
      relative: { front: 1, up: [-1, 1], right: 1 },
      absolute: 'xyz x/z 是整数方块列；y 是精确脚高，可为分数',
    },
    preconditions: ['目标格与当前脚格水平相邻或同列梯子', '目标脚面在当前脚高 ±1 内（相对写法由宿主在同列解析实际脚高）', '身体与起跳空间无阻挡/未知', '落点身体/支撑/邻格无危险方块，或已 allowHazard 授权', '不在水/岩浆/乘骑状态', '身体已经稳定触地', '起点连续位置、脚格、维度和会话未变化'],
    effects: ['movement'],
    problems: [
      'START_CHANGED', 'NOT_ADJACENT', 'UNSUPPORTED_ENVIRONMENT', 'BODY_NOT_STABLE',
      'NO_SUPPORT', 'FOOT_HEIGHT_MISMATCH', 'UNSUPPORTED_STEP_HEIGHT',
      'HEAD_BLOCKED', 'TARGET_BLOCKED', 'UNKNOWN_GEOMETRY', 'HAZARD_RISK_UNAUTHORIZED',
      'MOVE_REJECTED', 'MOVE_TIMEOUT', 'POSITION_NOT_CONFIRMED',
    ],
  },
  mine_cell: {
    geometry: { relative: { front: 2, up: [-1, 3], right: 2 } },
    preconditions: ['目标格已加载且本次可见', '目标不是液体', '液体邻格已授权', '未知邻格已显式授权', '挖脚下支撑的落差/液体风险已授权', '目标不是自建结构或受保护箱子', '指定工具可用'],
    effects: ['block_removed'],
    problems: [
      'TARGET_STATE_UNKNOWN', 'TARGET_NOT_OBSERVED', 'TARGET_LIQUID',
      'LIQUID_RISK_UNAUTHORIZED', 'FALL_RISK_UNAUTHORIZED', 'UNKNOWN_ADJACENT_UNAUTHORIZED',
      'OWN_BUILDING', 'STORED_CHEST',
      'EFFECT_UNKNOWN', 'EFFECT_NOT_CONFIRMED',
    ],
  },
  place_cell: {
    geometry: { relative: { front: 2, up: [-2, 3], right: 2 } },
    preconditions: ['目标格已加载且为空/可替换', '请求材料在背包里且能被放置', '目标格未被其他方块占据'],
    effects: ['block_placed'],
    problems: [
      'TARGET_STATE_UNKNOWN', 'TARGET_OCCUPIED', 'MISSING_MATERIAL',
      'PLACEMENT_REFUSED', 'PLACEMENT_ADAPTER_ERROR',
      'EFFECT_UNKNOWN', 'EFFECT_NOT_CONFIRMED', 'EFFECT_MISMATCH',
    ],
  },
  place_support: {
    geometry: { relative: { front: 2, up: [-2, 3], right: 2 } },
    preconditions: ['item 显式指定或 any', '目标格已加载且没有可站立支撑', '目标格是空气/可替换方块', '指定/任选材料在背包里', '存在可点击的参照面或可达的边缘站位'],
    effects: ['support_formed'],
    problems: [
      'TARGET_STATE_UNKNOWN', 'TARGET_OCCUPIED', 'MISSING_MATERIAL',
      'NO_REFERENCE', 'REFERENCE_UNREACHABLE', 'EDGE_NO_REFERENCE', 'EDGE_NOT_REACHED', 'EDGE_HEIGHT', 'EDGE_ERROR',
      'PLACEMENT_FAILED', 'STANCE_MOVE_PARTIAL', 'EFFECT_UNKNOWN', 'EFFECT_NOT_CONFIRMED', 'EFFECT_MISMATCH',
    ],
  },
  pillar_one: {
    geometry: { absolute: '原地向上 1 格；需要头顶/跳跃空间两格未阻挡' },
    preconditions: ['item 显式指定或 any', '材料在背包里', '适配器支持 pillarUp', '头顶/侧上方空间足够'],
    effects: ['movement'],
    problems: [
      'MISSING_ARGUMENT', 'CAPABILITY_MISSING', 'MISSING_MATERIAL',
      'HEAD_BLOCKED', 'PILLAR_FAILED', 'ADAPTER_ERROR',
      'SUPPORT_NOT_CONFIRMED', 'PILLAR_HEIGHT_MISMATCH', 'EFFECT_MISMATCH',
    ],
  },
};

export const L1_MANIFEST: PrimitiveContract[] = l1Primitives.map((skill) => {
  const declared = DECLARED[skill.name];
  if (!declared) throw new Error(`缺少 ${skill.name} 的 L1 契约声明`);
  return {
    name: skill.name,
    args: skill.argsDoc,
    timeoutMs: skill.timeoutMs,
    movement: skill.movement,
    ...declared,
  };
});
