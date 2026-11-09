import type { AgentState, Vec3Like } from '../../adapter/types.ts';
import { walkLandRules } from '../../adapter/land-rules.ts';
import { searchLandRouteAsync, summarizeBoundaries, type LandSearchBoundarySummary, type LandSearchResult, type LandSearchTransition } from '../../spatial/land-search.ts';
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

function routeFacts(result: LandSearchResult, boundarySummary = summarizeBoundaries(result.boundaries)) {
  return {
    evidenceMode: result.evidenceMode,
    assurance: result.assurance,
    points: result.points,
    transitions: result.transitions,
    boundaries: result.boundaries,
    resolvedTarget: result.resolvedTarget,
    boundarySummary,
    ...(result.prefix === undefined ? {} : { prefix: result.prefix }),
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
  description: '按你指定的目的地和允许的 walk/step/drop 执行 3D 路线。宿主用已记录体素规划（当前证据优先，可用历史体素），并逐步用 move_step/descend_to 核实；不挖、不放、不搭、不换目标，遇 2 格以上高差、阻挡、落点不可见或历史路线失效就停下报事实。没有完整路线时，若当前证据确认了一段可达前缀，会沿该前缀自动走到边界（最多 maxSteps 段）再停下；只走当前证据 OPEN 的段，不进入 UNKNOWN/STALE 格，不声称到达。回执带原目的地、可达前缀端点、UNKNOWN/STALE/BLOCKED 边界（位置/方向/状态/原因）、额外观察是否可能解决、是否需要显式动作或其他移动能力。历史候选被当前证据判定 BLOCKED 时只执行 blocker 前的前缀，返回最后实测位置、已确认段、剩余段与 blocker；不自动挖，清障由你显式 mine_cell 后再观察/规划。',
  argsDoc: '{"to":{"x":整数,"y":脚高,"z":整数},"allowed"?":["walk","step","drop"],"historical"?true,"maxSteps"?16,"allowUnknownCorridor"?false}；to 是站立脚位/方块格，不是箱子/门方块本身；historical 默认 true（当前证据没路时用历史体素，结果标 historical/UNKNOWN）；没有完整路线时会自动执行当前证据确认的前缀并在边界停止（不超过 maxSteps），前缀不是到达；朝目标为已知 BLOCKED/UNSUPPORTED 时不自动前进，只返回端点与 blocker；不自动施工。',
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
    const targetPoint = `(${args.to.x},${args.to.y},${args.to.z})`;
    // 只报边界证据状态与缺口，不替 Agent 选观察/挖/建动作。
    const boundaryText = (summary: LandSearchBoundarySummary) => {
      const counts = Object.entries(summary.counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}×${count}`).join('、');
      const observation = summary.observationMayResolve
        ? '额外观察/靠近可能刷新证据'
        : summary.total === 0 ? '没有记录到边界' : '额外观察不会改变已观测阻挡';
      const beyond = summary.needsExplicitActionOrOtherRoute
        ? '存在需要显式挖/放/搭、其他移动能力或换路线的边界（由你决定）'
        : '未记录到需要挖/建或换路线的边界';
      return `边界 ${summary.total} 个${counts ? `（${counts}）` : ''}：${observation}；${beyond}`;
    };
    const request = {
      worldId: state.worldId, dim: state.dim, sessionId: state.sessionId,
      body: { feet: { ...state.pos }, width: 0.6, height: 1.8, pose: 'standing' as const },
      to: args.to, maxDrop: 4, rules: walkLandRules, signal: ctx.signal,
    };
    // 分片搜索：搜索期间让出事件循环，按键/取消/观测不必等整段 A* 跑完。
    const strict = await searchLandRouteAsync(spatial.session.voxel, request);
    // strict 回执的边界/计数只算一次，所有 strict 分支共用同一份事实。
    const strictBoundarySummary = summarizeBoundaries(strict.boundaries);
    const strictFacts = routeFacts(strict, strictBoundarySummary);
    if (strict.status === 'CANCELLED') {
      return { status: 'cancelled', summary: 'navigate_to 搜索被取消，没有移动', data: { ...strictFacts, position: { ...state.pos }, requestedTarget: { ...args.to } } };
    }
    let result = strict.status === 'FOUND' ? strict : null;
    let historical: LandSearchResult | null = null;
    if (result === null && args.historical) {
      historical = await searchLandRouteAsync(spatial.session.voxel, { ...request, allowStale: true });
      if (historical.status === 'FOUND') result = historical;
    }
    const stoppedCode: FailureCode = strict.status === 'BUDGET_EXHAUSTED' ? 'TIMEOUT' : strict.status === 'UNKNOWN' ? 'NOT_FOUND' : 'PATH_NOT_FOUND';
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
              ...strictFacts, transitions: [transition], directDrop: true, executed: 1, total: 1, remaining: [], position,
              ...facts,
            });
          }
          const { local: _local, around: _around, ...nested } = (moved.data ?? {}) as Record<string, unknown>;
          const facts = segmentFacts(position, { executed: 0, planned: 1, remaining: 1, invalidation: 'step_failed', arrived: false, backend: 'direct-drop' });
          return fail(moved.failureCode ?? 'ERROR', `navigate_to 没有普通路线；直接下落也失败：${moved.summary}${segmentNote(facts.segment)}`, {
            ...strictFacts, transitions: [transition], directDrop: true, nested: { code: moved.failureCode ?? 'ERROR', summary: moved.summary, data: nested }, position,
            ...facts,
          });
        }
      }
      const reachable = strict.prefix;
      const blockerAhead = reachable?.knownBlockerAhead;
      // 只有“证据缺口”边界值得先走过去再观察；朝目标方向已观测为 BLOCKED/UNSUPPORTED
      // 时前进不会带来新证据，交回 prefix 端点 + blocker，由 Agent 决定挖/放/换路线。
      if (reachable === undefined || reachable.transitions.length === 0 || blockerAhead !== undefined) {
        const facts = segmentFacts(ctx.adapter.state().pos, { executed: 0, planned: 0, remaining: 0, invalidation: 'no_route', arrived: false, backend: 'none' });
        const why = blockerAhead !== undefined
          ? '朝目标方向的边界已观测为不可通行'
          : strict.status === 'UNKNOWN'
            ? '当前证据不足（UNKNOWN/STALE）'
            : strict.status === 'BUDGET_EXHAUSTED' ? '搜索预算耗尽' : '已观测地形里没有 walk/step/drop 路线';
        const endpointNote = reachable !== undefined && reachable.transitions.length > 0 && blockerAhead !== undefined
          ? `已知可通行的最远 approach 只到 ${JSON.stringify(cell(reachable.endpoint))}（${reachable.transitions.length} 段），但朝目标方向是 ${blockerAhead.status} 已观测阻挡${blockerAhead.reason === undefined ? '' : `（${blockerAhead.reason}）`}`
          : '没有任何已确认可走的前缀';
        return fail(stoppedCode, `navigate_to 找不到到原目的地 ${targetPoint} 的完整路线：${why}；${endpointNote}，这不是到达；${boundaryText(strictBoundarySummary)}；需要挖/垫/搭、额外观察或其他移动能力时由你决定${segmentNote(facts.segment)}`, {
          ...strictFacts, position: { ...state.pos },
          requestedTarget: { ...args.to }, remainingTarget: { ...args.to },
          ...(blockerAhead === undefined ? {} : { blockerAhead }),
          ...(historical?.prefix === undefined ? {} : { historicalPrefix: historical.prefix }),
          ...facts,
        });
      }
    }
    // 没有完整路线但有当前证据确认可达的前缀：先走到最远 approach，在边界停下，
    // 不把 UNKNOWN 当 OPEN，也不把前缀说成到达。
    const prefixOnly = result === null;
    const route = result ?? strict;
    const planned = result === null ? (strict.prefix?.transitions ?? []) : result.transitions;
    const disallowed = planned.find((transition) => !args.allowed.includes(transition.kind));
    if (disallowed) {
      const facts = segmentFacts(ctx.adapter.state().pos, { executed: 0, planned: planned.length, remaining: planned.length, invalidation: 'disallowed_transition', arrived: false });
      return fail('BAD_ARGS', `navigate_to ${prefixOnly ? '已知可通行前缀' : '路线'}第一段是 ${disallowed.kind}，不在 allowed（${args.allowed.join('、')}）；没有执行任何一步${segmentNote(facts.segment)}`, {
        ...routeFacts(route), position: { ...state.pos }, disallowed,
        requestedTarget: { ...args.to }, remainingTarget: { ...args.to },
        ...facts,
      });
    }
    // 历史候选的逐段复验已在搜索层按当前证据完成：BLOCKED 段之前的前缀才交给身体，
    // 该段本身不启动。STALE/UNKNOWN 不等于已观测阻挡，仍由 move_step/descend_to
    // 在执行前用现场证据确认。
    const { blocker, limit } = executionWindow(prefixOnly ? undefined : route.verification, args.maxSteps, planned.length);
    const transitions = planned.slice(0, limit);
    const truncated = transitions.length < planned.length;
    const prefixStop = (end: Vec3Like, executed: number, remainingWithinPrefix: number, invalidation: string, why: string) => {
      const facts = segmentFacts(end, { executed, planned: planned.length, remaining: remainingWithinPrefix, invalidation, arrived: false, backend: 'land-search' });
      return fail(stoppedCode, `navigate_to 已沿已确认可通行的前缀走到 ${JSON.stringify(cell(feetCell(end)))}（${executed} 段），但这不是到达；原目的地 ${targetPoint} 仍未到达，终点可通行性未知：${why}；${boundaryText(strictBoundarySummary)}；在边界处观察、挖/放或换路线由你决定${segmentNote(facts.segment)}`, {
        ...strictFacts, executed, confirmedSegments: executed,
        remaining: [{ to: { ...args.to } }], position: { ...end },
        requestedTarget: { ...args.to }, remainingTarget: { ...args.to },
        prefixRemaining: planned.slice(executed),
        ...(historical?.prefix === undefined ? {} : { historicalPrefix: historical.prefix }),
        ...facts,
      });
    };
    const whyStopped = strict.status === 'UNKNOWN'
      ? '证据不足（UNKNOWN/STALE），不能继续进入未知'
      : strict.status === 'BUDGET_EXHAUSTED'
        ? `搜索在${strict.stats.cancelReason === 'time' ? '时间' : '节点/边'}预算边界停止`
        : '已观测地形阻挡';
    let executed = 0;
    let last: AgentState = state;
    for (const [index, transition] of transitions.entries()) {
      if (Date.now() >= ctx.deadline) {
        if (prefixOnly) return prefixStop(ctx.adapter.state().pos, executed, planned.length - index, 'deadline', '执行期限耗尽，前缀尚未走完');
        const facts = segmentFacts(ctx.adapter.state().pos, { executed, planned: planned.length, remaining: planned.length - index, invalidation: 'deadline', arrived: false });
        return fail('TIMEOUT', `navigate_to 期限耗尽：已执行 ${executed}/${planned.length} 段；下一步重新规划${segmentNote(facts.segment)}`, {
          ...routeFacts(route), executed, remaining: planned.slice(index), position: { ...ctx.adapter.state().pos },
          ...facts,
        });
      }
      const current = ctx.adapter.state();
      const from = cell(transition.from);
      if (!sameCell(cell(feetCell(current.pos)), cell({ ...transition.from, y: current.pos.y }))) {
        const facts = segmentFacts(current.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'start_drift', arrived: false });
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 起点漂移：第 ${index + 1} 段应在 ${JSON.stringify(from)}，实际脚下在 ${JSON.stringify(feetCell(current.pos))}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(route), executed, stepIndex: index, transition, position: { ...current.pos },
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
          const facts = segmentFacts(current.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'invalid_step', arrived: false });
          return fail('BAD_ARGS', `navigate_to 生成 descend_to 参数无效：${validated.error}；没有继续执行${segmentNote(facts.segment)}`, {
            ...routeFacts(route), executed, stepIndex: index, transition, position: { ...current.pos },
            ...facts,
          });
        }
        step = await runSkill(ctx, descendTo, validated.args);
      } else {
        const validated = validateSkill(moveStep, {
          xyz: [to.x, transition.to.y, to.z], facing: facingOf(from, to),
        }, ctx.adapter);
        if (!validated.ok) {
          const facts = segmentFacts(current.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'invalid_step', arrived: false });
          return fail('BAD_ARGS', `navigate_to 生成 move_step 参数无效：${validated.error}；没有继续执行${segmentNote(facts.segment)}`, {
            ...routeFacts(route), executed, stepIndex: index, transition, position: { ...current.pos },
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
        const facts = segmentFacts(stopped.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'step_failed', arrived: false });
        return fail(step.failureCode ?? 'ERROR', `navigate_to 在第 ${index + 1} 段 ${transition.kind} 停下：${step.summary}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(route), executed,
          ...(blocker === null ? {} : { confirmedSegments: executed, blocker, lastMeasuredPosition: { ...stopped.pos } }),
          stepIndex: index, transition, remaining: planned.slice(index),
          nested: { code: step.failureCode ?? 'ERROR', summary: step.summary, data: nested },
          position: { ...stopped.pos },
          ...facts,
        });
      }
      const arrived = ctx.adapter.state();
      if (!sameCell(cell(feetCell(arrived.pos)), to) || Math.abs(arrived.pos.y - transition.to.y) > 0.01) {
        const facts = segmentFacts(arrived.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'effect_not_confirmed', arrived: false });
        return fail('EFFECT_NOT_CONFIRMED', `navigate_to 第 ${index + 1} 段动作报成功，但实际脚下 ${JSON.stringify(feetCell(arrived.pos))} 不是 ${JSON.stringify(to)}；没有继续执行${segmentNote(facts.segment)}`, {
          ...routeFacts(route), executed, stepIndex: index, transition, position: { ...arrived.pos },
          ...facts,
        });
      }
      executed += 1;
      last = arrived;
      ctx.progress(executed / Math.max(1, planned.length), `navigate_to ${executed}/${planned.length}`);
    }
    if (blocker !== null && blocker.index < args.maxSteps) {
      const facts = segmentFacts(last.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'blocker', arrived: false });
      return fail('PATH_NOT_FOUND', `navigate_to 停在 blocker 前：第 ${blocker.index + 1} 段当前证据 ${blocker.status}${blocker.reason === undefined ? '' : `（${blocker.reason}）`}；已确认 ${executed} 段，最后实测位置 ${JSON.stringify(cell(feetCell(last.pos)))}；剩余 ${planned.length - executed} 段；未自动挖，清障由你显式 mine_cell 后重新观察/规划${segmentNote(facts.segment)}`, {
        ...routeFacts(route), executed, confirmedSegments: executed,
        remaining: planned.slice(executed), position: { ...last.pos },
        blocker,
        ...facts,
      });
    }
    if (truncated) {
      if (prefixOnly) return prefixStop(last.pos, executed, planned.length - executed, 'max_steps', `分段上限 maxSteps=${args.maxSteps} 用尽，已知前缀还有 ${planned.length - executed} 段未执行`);
      const facts = segmentFacts(last.pos, { executed, planned: planned.length, remaining: planned.length - executed, invalidation: 'max_steps', arrived: false });
      return fail('EFFECT_NOT_CONFIRMED', `navigate_to 已执行前 ${executed} 段，未到终点（maxSteps=${args.maxSteps}）；目标 (${args.to.x},${args.to.y},${args.to.z}) 不变，可再次调用继续${segmentNote(facts.segment)}`, {
        ...routeFacts(route), executed, remaining: planned.slice(executed), position: { ...last.pos },
        ...facts,
      });
    }
    if (prefixOnly) {
      // 搜索可能因预算/期限在“目标已入队但未弹出”时停止；若已执行前缀的端点就是
      // 解析目标，且每一步都由实测确认，就如实报告到达，而不是继续声称未到达。
      if (strict.prefix?.atTarget === true) {
        const reached = segmentFacts(last.pos, { executed, planned: planned.length, remaining: 0, invalidation: null, arrived: true, backend: 'land-search' });
        return ok(`navigate_to 到达 ${JSON.stringify(cell(feetCell(last.pos)))}＝解析目标 ${JSON.stringify(cell(strict.resolvedTarget))}（${executed} 段，current；搜索在${strict.stats.cancelReason === 'time' ? '时间' : '节点/边'}预算边界停止，但已执行前缀的实测终点就是目标）${segmentNote(reached.segment)}`, {
          ...strictFacts, executed, total: planned.length, remaining: [], position: { ...last.pos },
          requestedTarget: { ...args.to }, arrived: true,
          ...reached,
        });
      }
      return prefixStop(last.pos, executed, 0, 'prefix_boundary', whyStopped);
    }
    const facts = segmentFacts(last.pos, { executed, planned: planned.length, remaining: 0, invalidation: null, arrived: true });
    return ok(`navigate_to 到达 ${JSON.stringify(cell(feetCell(last.pos)))}（${executed} 段，${route.evidenceMode}${route.evidenceMode === 'historical' ? '，历史体素、当前可通行性未知' : ''}）${segmentNote(facts.segment)}`, {
      ...routeFacts(route), executed, total: planned.length, remaining: [], position: { ...last.pos },
      ...facts,
    });
  },
};
