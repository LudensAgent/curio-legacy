import type { Skill } from '../types.ts';

/**
 * L1 基础动作共用的回执契约：
 * - effect：动作是否确认，以及属于哪类身体/世界变化；
 * - problem：结构化失败原因、阶段和是否可重试；
 * - execution：每次执行的关联 id，便于把观测、动作和回执对应起来。
 */

export type ProblemPhase = 'validation' | 'precondition' | 'execution' | 'verification' | 'reconciliation';
export type EffectKind = 'movement' | 'block_removed' | 'block_placed' | 'support_formed';

/** problem.kind 的完整集合；新增类别时必须同时更新 manifest 和这里。 */
export const PRIMITIVE_PROBLEM_KINDS = [
  'MISSING_ARGUMENT', 'MISSING_MATERIAL', 'CAPABILITY_MISSING',
  'START_CHANGED', 'NOT_ADJACENT', 'UNSUPPORTED_ENVIRONMENT', 'BODY_NOT_STABLE',
  'TARGET_STATE_UNKNOWN', 'TARGET_NOT_OBSERVED', 'TARGET_LIQUID', 'TARGET_OCCUPIED',
  'OWN_BUILDING', 'STORED_CHEST', 'LIQUID_RISK_UNAUTHORIZED', 'FALL_RISK_UNAUTHORIZED', 'UNKNOWN_ADJACENT_UNAUTHORIZED',
  'NO_SUPPORT', 'FOOT_HEIGHT_MISMATCH', 'UNSUPPORTED_STEP_HEIGHT', 'HEAD_BLOCKED', 'TARGET_BLOCKED', 'UNKNOWN_GEOMETRY',
  'NO_REFERENCE', 'REFERENCE_UNREACHABLE', 'EDGE_NO_REFERENCE', 'EDGE_NOT_REACHED', 'EDGE_HEIGHT', 'EDGE_ERROR',
  'PLACEMENT_REFUSED', 'PLACEMENT_FAILED', 'PLACEMENT_ADAPTER_ERROR', 'NOT_PLACED', 'EXECUTION_TIMEOUT', 'STANCE_MOVE_PARTIAL',
  'EFFECT_UNKNOWN', 'EFFECT_NOT_CONFIRMED', 'EFFECT_MISMATCH',
  'MOVE_REJECTED', 'MOVE_TIMEOUT', 'POSITION_NOT_CONFIRMED',
  'ADAPTER_ERROR', 'PILLAR_FAILED', 'SUPPORT_NOT_CONFIRMED', 'PILLAR_HEIGHT_MISMATCH',
] as const;
export type PrimitiveProblemKind = typeof PRIMITIVE_PROBLEM_KINDS[number];

export const problemOf = (kind: PrimitiveProblemKind, phase: ProblemPhase, retryable = false) => ({
  problem: { kind, phase, retryable },
});

export const effectConfirmed = (kind: EffectKind) => ({ effect: { confirmed: true, kind } });
export const effectUnconfirmed = (kind: EffectKind, partial = false) => ({
  effect: { confirmed: false, kind, ...(partial ? { partial: true } : {}) },
});

/** 适配器 reason 是字符串；这里只映射成稳定类别，供回执和重试决策使用。 */
export function placementProblem(reason?: string): PrimitiveProblemKind {
  const r = String(reason ?? '');
  if (/NO_ITEM/.test(r)) return 'MISSING_MATERIAL';
  if (/FACE_NOT_CLICKABLE|OUT_OF_REACH|NO_LINE_OF_SIGHT/.test(r)) return 'REFERENCE_UNREACHABLE';
  if (/NO_REFERENCE|NO_PLACEMENT_FACE|NO_WALL|NO_FLOOR_OR_WALL/.test(r)) return 'NO_REFERENCE';
  if (/^EDGE_NO_REFERENCE|^EDGE_LOST_SUPPORT/.test(r)) return 'EDGE_NO_REFERENCE';
  if (/^EDGE_NOT_REACHED/.test(r)) return 'EDGE_NOT_REACHED';
  if (/^EDGE_HEIGHT/.test(r)) return 'EDGE_HEIGHT';
  if (/^EDGE_/.test(r)) return 'EDGE_ERROR';
  if (/adapter_error|TIMEOUT/i.test(r)) return 'EXECUTION_TIMEOUT';
  if (/NOT_PLACED|PLACE_FAILED|TARGET_CHANGED/.test(r)) return 'NOT_PLACED';
  return 'PLACEMENT_FAILED';
}

/**
 * 适配器回执失败时，动作是否可能已经执行。确定没执行的（缺材料、缺参照面、
 * 边缘没走到）不需等待同步；超时/无说明/放置中失败要短暂等待后复核世界。
 */
export function placementMayHaveExecuted(reason?: string): boolean {
  return !/NO_ITEM|NO_REFERENCE|NO_PLACEMENT_FACE|NO_WALL|NO_FLOOR_OR_WALL|FACE_NOT_CLICKABLE|OUT_OF_REACH|NO_LINE_OF_SIGHT|^NOT_PLACED|EDGE_NOT_ADJACENT|EDGE_HEIGHT|EDGE_NO_SUPPORT|EDGE_NO_REFERENCE|EDGE_NOT_REACHED|EDGE_LOST_SUPPORT/.test(String(reason ?? ''));
}

/** 参照面/站位类失败：最终回执用它区分“缺参照/站位”和其他能力缺口。 */
export const REFERENCE_PROBLEMS: ReadonlySet<PrimitiveProblemKind> = new Set([
  'NO_REFERENCE', 'REFERENCE_UNREACHABLE', 'EDGE_NO_REFERENCE', 'EDGE_NOT_REACHED', 'EDGE_HEIGHT', 'EDGE_ERROR',
]);

let executionSequence = 0;

/**
 * 给基础动作回执加上执行关联字段。不改变动作本身，也不生成新的动作决策；
 * 只让同一 task 下的多次观测/执行能在日志和回执里对上号。
 */
export function withExecutionLink<A>(skill: Skill<A>): Skill<A> {
  return {
    ...skill,
    async run(ctx, args) {
      const sequence = ++executionSequence;
      const result = await skill.run(ctx, args);
      return {
        ...result,
        data: {
          ...(result.data ?? {}),
          actionId: skill.name,
          executionId: `${ctx.taskId}:${skill.name}:${sequence}`,
          sequence,
        },
      };
    },
  };
}
