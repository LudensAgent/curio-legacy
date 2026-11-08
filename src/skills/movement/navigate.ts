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
const round2 = (v: number) => Math.round(v * 100) / 100;

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
    // 有界分段的实测事实：起点、区块访问数、已观测格都在段前取快照，段后按差值报告。
    // 新区块数是“身体进入过”的计数，不是观测覆盖；覆盖只认 VoxelMap 里新增的已观测格。
    const voxel = spatial.session.voxel;
    const start = { ...state.pos };
    const startChunks = ctx.memory.visitedChunkCount;
    const startObservedCells = voxel.checkpointFullCounts().observedCells;
    const segmentFacts = (end: Vec3Like, facts: { executed: number; planned: number; remaining: number; invalidation: string | null; arrived: boolean; backend?: 'land-search' | 'direct-drop' | 'none' }) => {
      const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
      const horizontal = Math.hypot(dx, dz);
      const euclidean = Math.hypot(dx, dy, dz);
      // 请求距离只按“实测段起点 → Agent 给的目标”算，不用计划点或段终点冒充。
      const requestedHorizontal = Math.hypot(args.to.x - start.x, args.to.z - start.z);
      const requestedEuclidean = Math.hypot(args.to.x - start.x, args.to.y - start.y, args.to.z - start.z);
      const newChunks = ctx.memory.visitedChunkCount - startChunks;
      const newObservedCells = voxel.checkpointFullCounts().observedCells - startObservedCells;
      const observationCoverage = newObservedCells > 0;
      const movedCells = !sameCell(cell(start), cell(end));
      // 有意义的进展只认新观测覆盖、进入新区块/扩大区域覆盖或到达选定站位；
      // 单纯移动不算进展（位移仍作为实测事实报告）。进入新区块不算“观测覆盖”。
      const reason = observationCoverage ? 'new_observation'
        : newChunks > 0 ? 'new_chunk'
          : facts.arrived ? 'arrived_at_target' : 'none';
      return {
        segment: {
          startStance: { ...start },
          endStance: { ...end },
          displacement: { horizontal: round2(horizontal), vertical: round2(dy), euclidean: round2(euclidean) },
          requestedDistance: { horizontal: round2(requestedHorizontal), euclidean: round2(requestedEuclidean) },
          distanceFromStart: round2(euclidean),
          // 实际产出本段的路线来源：land-search / 相邻下落直执行 / 无可用路线；由调用点如实传入。
          backend: facts.backend ?? 'land-search',
          newChunks,
          newObservedCells,
          observationCoverage,
          movedCells,
          arrivedAtTarget: facts.arrived,
          remainingTarget: { ...args.to },
          remainingTransitions: facts.remaining,
          bounds: { maxSteps: args.maxSteps, plannedTransitions: facts.planned, executed: facts.executed },
          invalidation: facts.invalidation,
          progress: { meaningful: reason !== 'none', reason },
        },
      };
    };
    const segmentNote = (s: ReturnType<typeof segmentFacts>['segment']) =>
      `；实测位移 ${s.displacement.horizontal} 格、新区块 ${s.newChunks}、新观测格 ${s.newObservedCells}，${s.progress.meaningful ? '本段有进展' : '本段无新进展'}`;
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
            const facts = segmentFacts(position, { executed: 1, planned: 1, remaining: 0, invalidation: null, arrived: true, backend: 'direct-drop' });
            return ok(`navigate_to 没有普通 walk/step 路线；按你允许的 drop 直接下落到相邻目标 (${dropTo.x},${dropTo.y},${dropTo.z})（落差 ${drop.toFixed(2)}）${segmentNote(facts.segment)}`, {
              ...routeFacts(strict), transitions: [transition], directDrop: true, executed: 1, total: 1, remaining: [], position,
              ...facts,
            });
          }
          const { local: _local, around: _around, ...nested } = (moved.data ?? {}) as Record<string, unknown>;
          const facts = segmentFacts(position, { executed: 0, planned: 1, remaining: 1, invalidation: 'step_failed', arrived: false, backend: 'direct-drop' });
          return fail(moved.failureCode ?? 'ERROR', `navigate_to 没有普通路线；直接下落也失败：${moved.summary}${segmentNote(facts.segment)}`, {
            ...routeFacts(strict), transitions: [transition], directDrop: true, nested: { code: moved.failureCode ?? 'ERROR', summary: moved.summary, data: nested }, position,
            ...facts,
          });
        }
      }
      const code: FailureCode = strict.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT' : strict.status === 'UNKNOWN' ? 'NOT_FOUND' : 'PATH_NOT_FOUND';
      const facts = segmentFacts(ctx.adapter.state().pos, { executed: 0, planned: 0, remaining: 0, invalidation: 'no_route', arrived: false, backend: 'none' });
      return fail(code, `navigate_to 找不到可执行的 walk/step/drop 路线：${strict.status}（${strict.boundaries.length} 个边界事实）；需要挖/垫/搭或换目标时由你决定${segmentNote(facts.segment)}`, {
        ...routeFacts(strict), position: { ...state.pos },
        ...facts,
      });
    }
    const disallowed = result.transitions.find((transition) => !args.allowed.includes(transition.kind));
    if (disallowed) {
      const facts = segmentFacts(ctx.adapter.state().pos, { executed: 0, planned: result.transitions.length, remaining: result.transitions.length, invalidation: 'disallowed_transition', arrived: false });
      return fail('BAD_ARGS', `navigate_to 路线第一段是 ${disallowed.kind}，不在 allowed（${args.allowed.join('、')}）；没有执行任何一步${segmentNote(facts.segment)}`, {
        ...routeFacts(result), position: { ...state.pos }, disallowed: disallowed,
        ...facts,
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
        const facts = segmentFacts(ctx.adapter.state().pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - index, invalidation: 'deadline', arrived: false });
        return fail('TIMEOUT', `navigate_to 期限耗尽：已执行 ${executed}/${result.transitions.length} 段；下一步重新规划${segmentNote(facts.segment)}`, {
          ...routeFacts(result), executed, remaining: result.transitions.slice(index), position: { ...ctx.adapter.state().pos },
          ...facts,
        });
      }
      const current = ctx.adapter.state();
      const from = cell(transition.from);
      if (!sameCell(cell(feetCell(current.pos)), cell({ ...transition.from, y: current.pos.y }))) {
        const facts = segmentFacts(current.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'start_drift', arrived: false });
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 起点漂移：第 ${index + 1} 段应在 ${JSON.stringify(from)}，实际脚下在 ${JSON.stringify(feetCell(current.pos))}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
          ...facts,
        });
      }
      const to = cell(transition.to);
      let step: SkillResult;
      if (transition.kind === 'drop' && transition.drop > 1) {
        const validated = validateSkill(descendTo, {
          target: { x: to.x, y: transition.to.y, z: to.z },
          ...(args.allowUnknownCorridor ? { allowUnknownCorridor: true } : {}),
        }, ctx.adapter);
        if (!validated.ok) {
          const facts = segmentFacts(current.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'invalid_step', arrived: false });
          return fail('BAD_ARGS', `navigate_to 生成 descend_to 参数无效：${validated.error}；没有继续执行${segmentNote(facts.segment)}`, {
            ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
            ...facts,
          });
        }
        step = await runSkill(ctx, descendTo, validated.args);
      } else {
        const validated = validateSkill(moveStep, {
          xyz: [to.x, transition.to.y, to.z], facing: facingOf(from, to),
        }, ctx.adapter);
        if (!validated.ok) {
          const facts = segmentFacts(current.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'invalid_step', arrived: false });
          return fail('BAD_ARGS', `navigate_to 生成 move_step 参数无效：${validated.error}；没有继续执行${segmentNote(facts.segment)}`, {
            ...routeFacts(result), executed, stepIndex: index, transition, position: { ...current.pos },
            ...facts,
          });
        }
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
        const facts = segmentFacts(stopped.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'step_failed', arrived: false });
        return fail(step.failureCode ?? 'ERROR', `navigate_to 在第 ${index + 1} 段 ${transition.kind} 停下：${step.summary}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(result), executed,
          ...(blocker === null ? {} : { confirmedSegments: executed, blocker, lastMeasuredPosition: { ...stopped.pos } }),
          stepIndex: index, transition, remaining: result.transitions.slice(index),
          nested: { code: step.failureCode ?? 'ERROR', summary: step.summary, data: nested },
          position: { ...stopped.pos },
          ...facts,
        });
      }
      const arrived = ctx.adapter.state();
      if (!sameCell(cell(feetCell(arrived.pos)), to) || Math.abs(arrived.pos.y - transition.to.y) > 0.01) {
        const facts = segmentFacts(arrived.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'effect_not_confirmed', arrived: false });
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 第 ${index + 1} 段动作报成功，但实际脚下 ${JSON.stringify(feetCell(arrived.pos))} 不是 ${JSON.stringify(to)}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(result), executed, stepIndex: index, transition, position: { ...arrived.pos },
          ...facts,
        });
      }
      executed += 1;
      last = arrived;
      ctx.progress(executed / Math.max(1, result.transitions.length), `navigate_to ${executed}/${result.transitions.length}`);
    }
    if (blocker !== null && blocker.index < args.maxSteps) {
      const facts = segmentFacts(last.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'blocker', arrived: false });
      return fail('PATH_NOT_FOUND', `navigate_to 停在 blocker 前：第 ${blocker.index + 1} 段当前证据 ${blocker.status}${blocker.reason === undefined ? '' : `（${blocker.reason}）`}；已确认 ${executed} 段，最后实测位置 ${JSON.stringify(cell(feetCell(last.pos)))}；剩余 ${result.transitions.length - executed} 段；未自动挖，清障由你显式 mine_cell 后重新观察/规划${segmentNote(facts.segment)}`, {
        ...routeFacts(result), executed, confirmedSegments: executed,
        remaining: result.transitions.slice(executed), position: { ...last.pos },
        blocker,
        ...facts,
      });
    }
    if (truncated) {
      const facts = segmentFacts(last.pos, { executed, planned: result.transitions.length, remaining: result.transitions.length - executed, invalidation: 'max_steps', arrived: false });
      return fail('EFFECT_NOT_CONFIRMED', `navigate_to 已执行前 ${executed} 段，未到终点（maxSteps=${args.maxSteps}）；目标 (${args.to.x},${args.to.y},${args.to.z}) 不变，可再次调用继续${segmentNote(facts.segment)}`, {
        ...routeFacts(result), executed, remaining: result.transitions.slice(executed), position: { ...last.pos },
        ...facts,
      });
    }
    const facts = segmentFacts(last.pos, { executed, planned: result.transitions.length, remaining: 0, invalidation: null, arrived: true });
    return ok(`navigate_to 到达 ${JSON.stringify(cell(feetCell(last.pos)))}（${executed} 段，${result.evidenceMode}${result.evidenceMode === 'historical' ? '，历史体素、当前可通行性未知' : ''}）${segmentNote(facts.segment)}`, {
      ...routeFacts(result), executed, total: result.transitions.length, remaining: [], position: { ...last.pos },
      ...facts,
    });
  },
};
