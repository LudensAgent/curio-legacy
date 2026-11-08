import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRouteAsync, type LandSearchResult, type LandSearchTransition } from '../../spatial/land-search.ts';
import { feetCell } from '../../perception/local.ts';
import { fail, obj, ok, runSkill, validateSkill, type FailureCode, type Skill, type SkillCtx, type SkillResult } from '../types.ts';
import { moveStep } from './primitives.ts';
import { descendTo } from './descend.ts';
import { executionWindow } from './route.ts';

type Kind = 'walk' | 'step' | 'drop';
type NavigateArgs = {
  to: Vec3Like;
  allowed: Kind[];
  historical: boolean;
  maxSteps: number;
  allowUnknownCorridor: boolean;
};

const KINDS: readonly Kind[] = ['walk', 'step', 'drop'];
const DIRS = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } } as const;

const point = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const sameCell = (a: Vec3Like, b: Vec3Like) => a.x === b.x && a.y === b.y && a.z === b.z;

function facingOf(from: Vec3Like, to: Vec3Like): keyof typeof DIRS {
  const dx = to.x - from.x, dz = to.z - from.z;
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N');
}

function routeFacts(result: LandSearchResult) {
  return {
    evidenceMode: result.evidenceMode,
    assurance: result.assurance,
    points: result.points,
    transitions: result.transitions,
    boundaries: result.boundaries,
    resolvedTarget: result.resolvedTarget,
    ...(result.verification === undefined ? {} : { verification: result.verification }),
  };
}

/**
 * 执行 Agent 已选定的 3D 目的地：宿主负责规划与逐步执行 walk/step/drop，
 * 不挖、不放、不搭、不换目标。当前证据没路时可用历史体素生成候选路线，
 * 但每一步仍由 move_step/descend_to 按现场事实确认；任何一步失败就停下报事实。
 */
export const navigateTo: Skill<NavigateArgs> = {
  name: 'navigate_to',
  description: '按你指定的目的地和允许的 walk/step/drop 执行 3D 路线。宿主用已记录体素规划（当前证据优先，可用历史体素），并逐步用 move_step/descend_to 核实；不挖、不放、不搭、不换目标，遇 2 格以上高差、阻挡、落点不可见或历史路线失效就停下报事实。历史候选被当前证据判定 BLOCKED 时只执行 blocker 前的前缀，返回最后实测位置、已确认段、剩余段与 blocker；不自动挖，清障由你显式 mine_cell 后再观察/规划。',
  argsDoc: '{"to":{"x":整数,"y":脚高,"z":整数},"allowed"?":["walk","step","drop"],"historical"?true,"maxSteps"?16,"allowUnknownCorridor"?false}；to 是站立脚位/方块格，不是箱子/门方块本身；historical 默认 true（当前证据没路时用历史体素，结果标 historical/UNKNOWN）；不自动施工。',
  timeoutMs: 30000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw), to = point(a.to);
    if (!to) return { ok: false, error: 'to 需要 {x,y,z} 站立脚位；箱子/门请改用旁边的站立格' };
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
        to,
        allowed: [...new Set(allowedRaw as Kind[])],
        historical: a.historical !== false,
        maxSteps: (a.maxSteps as number | undefined) ?? 16,
        allowUnknownCorridor: a.allowUnknownCorridor === true,
      },
    };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial?.session?.voxel) return fail('NOT_CONNECTED', 'navigate_to 需要共享空间 VoxelMap；当前没有接线');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'navigate_to 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', '当前世界与空间会话不一致');
    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
      to: args.to, maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
    };
    // 分片搜索：搜索期间让出事件循环，按键/取消/观测不必等整段 A* 跑完。
    const strict = await searchLandRouteAsync(spatial.session.voxel, request);
    let result = strict.status === 'FOUND' ? strict : null;
    if (result === null && args.historical) {
      const historical = await searchLandRouteAsync(spatial.session.voxel, { ...request, allowStale: true });
      if (historical.status === 'FOUND') result = historical;
    }
    if (result === null) {
      // 1×1 平台/柱顶没有普通 A* 路线：Agent 明确允许 drop 且目标就在相邻列时，
      // 直接尝试一次 descend_to。是否可见、净空、落差和摔伤仍由 descend_to 核实。
      const from = feetCell(state.pos);
      const dropTo = { x: Math.floor(args.to.x), y: args.to.y, z: Math.floor(args.to.z) };
      const drop = from.y - dropTo.y;
      if (args.allowed.includes('drop') && Math.abs(dropTo.x - from.x) + Math.abs(dropTo.z - from.z) === 1
        && drop > 0.25 && drop <= 4.01) {
        const validated = validateSkill(descendTo, {
          target: { x: dropTo.x, y: dropTo.y, z: dropTo.z },
          ...(args.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
        }, ctx.adapter);
        if (validated.ok) {
          const moved = await runSkill(ctx, descendTo, validated.args);
          const position = { ...ctx.adapter.state().pos };
          const transition = { kind: 'drop' as const, from: { ...state.pos }, to: { ...dropTo }, drop };
          if (moved.status === 'succeeded') {
            return ok(`navigate_to 没有普通 walk/step 路线；按你允许的 drop 直接下落到相邻目标 (${dropTo.x},${dropTo.y},${dropTo.z})（落差 ${drop.toFixed(2)}）`, {
              ...routeFacts(strict), transitions: [transition], directDrop: true, executed: 1, total: 1, remaining: [], position,
            });
          }
          const { local: _local, around: _around, ...nested } = (moved.data ?? {}) as Record<string, unknown>;
          return fail(moved.failureCode ?? 'ERROR', `navigate_to 没有普通路线；直接下落也失败：${moved.summary}`, {
            ...routeFacts(strict), transitions: [transition], directDrop: true, nested: { code: moved.failureCode ?? 'ERROR', summary: moved.summary, data: nested }, position,
          });
        }
      }
      const code: FailureCode = strict.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT' : strict.status === 'UNKNOWN' ? 'NOT_FOUND' : 'PATH_NOT_FOUND';
      return fail(code, `navigate_to 找不到可执行的 walk/step/drop 路线：${strict.status}（${strict.boundaries.length} 个边界事实）；需要挖/垫/搭或换目标时由你决定`, { ...routeFacts(strict), position: { ...state.pos } });
    }
    const disallowed = result.transitions.find((transition) => !args.allowed.includes(transition.kind));
    if (disallowed) {
      return fail('BAD_ARGS', `navigate_to 路线第一段是 ${disallowed.kind}，不在 allowed（${args.allowed.join('、')}）；没有执行任何一步`, {
        ...routeFacts(result), position: { ...state.pos }, disallowed: disallowed,
      });
    }
    // 历史候选的逐段复验已在搜索层按当前证据完成：BLOCKED 段之前的前缀才交给身体，
    // 该段本身不启动。STALE/UNKNOWN 不等于已观测阻挡，仍由 move_step/descend_to
    // 在执行前用现场证据确认。
    const { blocker, limit } = executionWindow(result.verification, args.maxSteps, result.transitions.length);
    const transitions = result.transitions.slice(0, limit);
    const truncated = transitions.length < result.transitions.length;
    let executed = 0;
    let last: AgentState = state;
    for (const [index, transition] of transitions.entries()) {
      if (Date.now() >= ctx.deadline) {
        return fail('TIMEOUT', `navigate_to 期限耗尽：已执行 ${executed}/${result.transitions.length} 段；下一步重新规划`, {
          ...routeFacts(result), executed, remaining: result.transitions.slice(index), position: { ...ctx.adapter.state().pos },
        });
      }
      const current = ctx.adapter.state();
      const from = cell(transition.from);
      if (!sameCell(cell(feetCell(current.pos)), cell({ ...transition.from, y: current.pos.y }))) {
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 起点漂移：第 ${index + 1} 段应在 ${JSON.stringify(from)}，实际脚下在 ${JSON.stringify(feetCell(current.pos))}；没有继续执行`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
        });
      }
      const to = cell(transition.to);
      let step: SkillResult;
      if (transition.kind === 'drop' && transition.drop > 1) {
        const validated = validateSkill(descendTo, {
          target: { x: to.x, y: transition.to.y, z: to.z },
          ...(args.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
        }, ctx.adapter);
        if (!validated.ok) return fail('BAD_ARGS', `navigate_to 生成 descend_to 参数无效：${validated.error}；没有继续执行`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
        });
        step = await runSkill(ctx, descendTo, validated.args);
      } else {
        const validated = validateSkill(moveStep, {
          xyz: [to.x, transition.to.y, to.z], facing: facingOf(from, to),
        }, ctx.adapter);
        if (!validated.ok) return fail('BAD_ARGS', `navigate_to 生成 move_step 参数无效：${validated.error}；没有继续执行`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
        });
        step = await runSkill(ctx, moveStep, validated.args);
      }
      if (step.status !== 'succeeded') {
        const { local: _local, around: _around, ...nested } = (step.data ?? {}) as Record<string, unknown>;
        const stopped = ctx.adapter.state();
        const problemKind = (step.data?.problem as { kind?: string } | undefined)?.kind;
        const blocker = problemKind === 'TARGET_BLOCKED' || problemKind === 'HEAD_BLOCKED'
          ? {
              index, transition, status: 'BLOCKED', problem: problemKind,
              ...(step.data?.targetCell === undefined ? {} : { cell: step.data.targetCell }),
              ...(step.data?.remediation === undefined ? {} : { remediation: step.data.remediation }),
            }
          : null;
        return fail(step.failureCode ?? 'ERROR', `navigate_to 在第 ${index + 1} 段 ${transition.kind} 停下：${step.summary}；没有继续执行`, {
          ...routeFacts(result), executed,
          ...(blocker === null ? {} : { confirmedSegments: executed, blocker, lastMeasuredPosition: { ...stopped.pos } }),
          stepIndex: index, transition, remaining: result.transitions.slice(index),
          nested: { code: step.failureCode ?? 'ERROR', summary: step.summary, data: nested },
          position: { ...stopped.pos },
        });
      }
      const arrived = ctx.adapter.state();
      if (!sameCell(cell(feetCell(arrived.pos)), to) || Math.abs(arrived.pos.y - transition.to.y) > 0.01) {
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 第 ${index + 1} 段动作报成功，但实际脚下 ${JSON.stringify(feetCell(arrived.pos))} 不是 ${JSON.stringify(to)}；没有继续执行`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...arrived.pos },
        });
      }
      executed += 1;
      last = arrived;
      ctx.progress(executed / Math.max(1, result.transitions.length), `navigate_to ${executed}/${result.transitions.length}`);
    }
    if (blocker !== null && blocker.index < args.maxSteps) {
      return fail('PATH_NOT_FOUND', `navigate_to 停在 blocker 前：第 ${blocker.index + 1} 段当前证据 ${blocker.status}${blocker.reason === undefined ? '' : `（${blocker.reason}）`}；已确认 ${executed} 段，最后实测位置 ${JSON.stringify(cell(feetCell(last.pos)))}；剩余 ${result.transitions.length - executed} 段；未自动挖，清障由你显式 mine_cell 后重新观察/规划`, {
        ...routeFacts(result), executed, confirmedSegments: executed,
        remaining: result.transitions.slice(executed), position: { ...last.pos },
        blocker,
      });
    }
    if (truncated) {
      return fail('EFFECT_NOT_CONFIRMED', `navigate_to 已执行前 ${executed} 段，未到终点（maxSteps=${args.maxSteps}）；可再次调用继续`, {
        ...routeFacts(result), executed, remaining: result.transitions.slice(executed), position: { ...last.pos },
      });
    }
    return ok(`navigate_to 到达 ${JSON.stringify(cell(feetCell(last.pos)))}（${executed} 段，${result.evidenceMode}${result.evidenceMode === 'historical' ? '，历史体素、当前可通行性未知' : ''}）`, {
      ...routeFacts(result), executed, total: result.transitions.length, remaining: [], position: { ...last.pos },
    });
  },
};
