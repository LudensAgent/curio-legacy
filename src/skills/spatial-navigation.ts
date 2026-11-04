/**
 * walk_to：显式有界目的地步行。
 *
 * 只做一件事：在共享空间地图上，用库的公开 WalkRouteSearch 从**本次实测的连续
 * 脚位**出发，搜索同高、整数 X/Z 格、普通干燥整块的可达候选，再把候选交给现有
 * 的 walk_route 执行后端（真实库 + 物理帧闭环）验证与执行。
 *
 * - 搜索只是候选：FOUND 不是到达；没有核实原完成条件前不产生成功。
 * - 输入能力限制（exact 不在格上/不同高、near 半径非正/非有限、候选超过本次点数上限）
 *   明确报告为输入/预算限制，绝不改写成“世界无路”或悄悄投影目标。
 * - 搜索经共享会话的既有 attach 接收真实 ChangeReport（→ invalidate）与生命周期
 *   取消（→ cancel）；INVALIDATED 是终态，不自动重搜。
 * - 搜索前的局部准备以当前身体脚格为中心固定水平半径 4（9×9×4 格：支撑/脚/头/净空）
 *   做至多 12 次真实转头观察；范围不随目标或搜索前沿扩张，搜索推进本身不触发额外探索。
 *   执行阶段仍只观察移动中的 3×3×4 邻域。
 * - 零边候选不造路线：只用有界真实物理帧按既定 grounded 稳定窗口确认原完成条件，
 *   零控制、零移动；成功时 data.noop=true 表示没有身体效果。
 */

import {
  GROUNDED_ARRIVAL_DEFAULTS,
  WalkRouteSearch,
  type LastObservation,
  type NavResult,
  type Vec3Like,
  type WalkSearchCandidate,
  type WalkSearchSnapshot,
} from 'curio-minecraft-3d-memory';
import { awaitFrame, walkCollisionProvider } from '../adapter/walk-route.ts';
import type { WalkTick } from '../adapter/walk-route.ts';
import type { SharedSpatialSession } from '../spatial/shared-session.ts';
import { executeWalkRoute, historyFields, observeCells, readPoint } from './walk-route.ts';
import type { WalkRouteExecution } from './walk-route.ts';
import { fail, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';

/** 本次执行后端最多接受 32 个候选点；超限如实报 route_budget，绝不截断路线。 */
const MAX_CANDIDATE_POINTS = 32;

/** 固定搜索预算，与库的公开上限语义一致。 */
const SEARCH_LIMITS = { maxNodes: 512, maxEdges: 2048, maxFrontiers: 32, maxDiagnostics: 32 } as const;

/** 每批最多评估 32 条边，批次之间让出宏任务，保证取消/期限可响应。 */
const EDGES_PER_ADVANCE = 32;

/** 零边确认的帧数上限；期限/取消/生命周期仍可更早结束。 */
const MAX_ZERO_EDGE_FRAMES = 400;

/** 连续样本容差，与库执行器的 POS_EPS 同量级，只用于判断采样是否连续。 */
const SAMPLE_EPS = 1e-6;

/** 准备阶段的固定水平观察半径（格）：以当前脚格为中心，不随目标或搜索前沿扩张。 */
const PREP_RADIUS = 4;

/**
 * 搜索前局部准备的观察格：当前脚格为中心的水平半径 4（9×9）× 支撑/脚/头/净空 4 层。
 * 固定 324 格，仅由当前身体位置决定；`observeCells` 再按 Vision 的 ≤32 格/批发送。
 */
function preparationCells(pos: Vec3Like): Vec3Like[] {
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const cells: Vec3Like[] = [];
  for (let x = fx - PREP_RADIUS; x <= fx + PREP_RADIUS; x++)
    for (let z = fz - PREP_RADIUS; z <= fz + PREP_RADIUS; z++)
      for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
  return cells;
}

type WalkToArrival = { kind: 'exact' } | { kind: 'near'; radius: number };

type WalkToArgs = {
  to: Vec3Like;
  arrival: WalkToArrival;
  deadlineMs?: number;
};

type WalkToBase = {
  originalRequest: { to: Vec3Like; arrival: WalkToArrival; deadlineMs?: number };
  target: Vec3Like;
};

type SearchStop = {
  stage: 'CANCELLED' | 'TIMEOUT' | 'NOT_READY' | 'SCOPE_CHANGED';
  reason: string;
  summary: string;
};

type NavFailure = Extract<NavResult, { outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED' }>;
type ZeroEdgeNav =
  | Extract<NavResult, { outcome: 'ARRIVED' }>
  | (NavFailure & { outcome: 'CANCELLED' | 'TIMEOUT' | 'FAILED' });
type ZeroEdgeOutcome = { nav: ZeroEdgeNav; stableSamples: number };

/**
 * 搜索批次边界检查：取消与期限优先，且在父任务已取消时**不**再读取 adapter.state，
 * 避免把新任务的现场冒充旧末位。生命周期/作用域失效按取消处理，不继续执行候选。
 */
function searchStop(
  ctx: SkillCtx,
  deadlineMs: number,
  scope: { worldId: string; dim: string; sessionId: string },
): SearchStop | null {
  if (ctx.signal.aborted) {
    return { stage: 'CANCELLED', reason: 'parent task cancelled', summary: 'walk_to 搜索被父任务取消' };
  }
  if (Date.now() >= deadlineMs) {
    return { stage: 'TIMEOUT', reason: 'deadline exceeded', summary: 'walk_to 搜索到达期限' };
  }
  const s = ctx.adapter.state();
  if (!s.alive || !s.connected || !s.observationReady) {
    return {
      stage: 'NOT_READY',
      reason: `alive=${s.alive} connected=${s.connected} observationReady=${s.observationReady}`,
      summary: '共享空间搜索期间身体/观测失效，未继续执行候选',
    };
  }
  if (s.worldId !== scope.worldId || s.dim !== scope.dim || s.sessionId !== scope.sessionId) {
    return {
      stage: 'SCOPE_CHANGED',
      reason: `scope=${s.worldId}/${s.dim}/${s.sessionId}`,
      summary: '共享空间搜索期间作用域变化，未继续执行候选',
    };
  }
  return null;
}

/** 原目标与实测末位的完整 XYZ 距离（near 复核用它，不加也不改任何容差）。 */
function distance3d(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 把终态搜索快照映射成技能结果；预算/未知/失效不得泛称真实 BLOCKED。 */
function searchTerminalResult(
  snapshot: WalkSearchSnapshot,
  base: WalkToBase,
  position: Vec3Like | null,
): SkillResult {
  const data = {
    ...base,
    stage: snapshot.state,
    ...(position !== null ? { position: { ...position } } : {}),
    search: snapshot,
  };
  if (snapshot.state === 'CANCELLED') {
    return { status: 'cancelled', summary: `walk_to 搜索已取消：${snapshot.reason}`, data };
  }
  const label: Record<string, string> = {
    UNSUPPORTED: '输入/能力限制（目标未投影、未改写；不代表世界无路）',
    NO_VERIFIED_PATH: '当前已验证证据下没有可行路线（不是对未知区域的结论）',
    INSUFFICIENT_EVIDENCE: '证据不足（未知/过期/不支持的边界），未声称世界堵塞',
    BUDGET_EXHAUSTED: '搜索预算耗尽（未完成探索，不是无路）',
    INVALIDATED: '搜索证据在过程中失效（终态，不自动重搜）',
  };
  const detail = `${label[snapshot.state] ?? '搜索未成功'}：${snapshot.reason}`;
  if (snapshot.state === 'NO_VERIFIED_PATH') return fail('PATH_NOT_FOUND', detail, data);
  return fail('ERROR', detail, data);
}

/**
 * 零边候选的真实确认：不造路线、不写控制，只用有界物理帧检查原完成条件、
 * 原作用域、干燥/落地/速度与 GROUNDED_ARRIVAL_DEFAULTS.stableMs 的连续有序样本。
 * 统一返回 NavResult：trace 永远为空，lastObservation 只来自真实接受的帧，绝不
 * 伪造 move executionId、路线或 history。
 */
async function confirmZeroEdge(
  ctx: SkillCtx,
  spatial: SharedSpatialSession,
  tick: WalkTick,
  target: Vec3Like,
  arrival: WalkToArrival,
  deadlineMs: number,
  scope: { worldId: string; dim: string; sessionId: string },
): Promise<ZeroEdgeOutcome> {
  const limits = GROUNDED_ARRIVAL_DEFAULTS;
  let settledSince: number | null = null;
  let settledSamples = 0;
  let lastPos: Vec3Like | null = null;
  let lastAt: number | null = null;
  let lastObservation: LastObservation | null = null;

  const lastFields = () => ({
    ...(lastPos !== null ? { lastPosition: { ...lastPos } } : {}),
    ...(lastObservation !== null ? { lastObservation: { ...lastObservation } } : {}),
  });
  const cancelled = (
    by: 'agent' | 'lifecycle',
    reason: string,
    message: string,
  ): ZeroEdgeOutcome => {
    const nav: ZeroEdgeNav = {
      outcome: 'CANCELLED', message, confirmed: false, trace: [],
      problem: { kind: 'cancelled', by, reason }, ...lastFields(),
    };
    return { nav, stableSamples: settledSamples };
  };
  const timedOut = (message: string): ZeroEdgeOutcome => {
    const nav: ZeroEdgeNav = {
      outcome: 'TIMEOUT', message, confirmed: false, trace: [], problem: { kind: 'timeout' }, ...lastFields(),
    };
    return { nav, stableSamples: settledSamples };
  };
  const failed = (
    message: string,
    problem: { kind: 'unconfirmed_arrival'; expected: Vec3Like } | { kind: 'execution_failed'; detail: string },
  ): ZeroEdgeOutcome => {
    const nav: ZeroEdgeNav = { outcome: 'FAILED', message, confirmed: false, trace: [], problem, ...lastFields() };
    return { nav, stableSamples: settledSamples };
  };

  // 本次确认自己的生命周期通道：共享会话中断/暂停只唤醒本次等待，绝不中止父任务。
  const lifecycle = new AbortController();
  const token = spatial.attach({ receiver: () => {}, cancel: () => lifecycle.abort() });
  try {
    for (let frame = 0; frame < MAX_ZERO_EDGE_FRAMES; frame++) {
      if (ctx.signal.aborted) return cancelled('agent', 'parent task cancelled', 'walk_to 零边确认被父任务取消');
      if (lifecycle.signal.aborted) {
        return cancelled('lifecycle', 'shared spatial session interrupted the active confirmation', 'walk_to 零边确认被共享空间生命周期取消');
      }
      if (Date.now() >= deadlineMs) return timedOut('walk_to 零边确认到达期限');
      const before = ctx.adapter.state();
      if (!before.alive || !before.connected || !before.observationReady) {
        return cancelled(
          'lifecycle',
          `alive=${before.alive} connected=${before.connected} observationReady=${before.observationReady}`,
          'walk_to 零边确认期间身体/观测失效',
        );
      }
      if (before.worldId !== scope.worldId || before.dim !== scope.dim || before.sessionId !== scope.sessionId) {
        return cancelled('lifecycle', `scope=${before.worldId}/${before.dim}/${before.sessionId}`, 'walk_to 零边确认期间作用域变化');
      }
      if (spatial.closing || spatial.paused || !spatial.observationAdmitted) {
        return cancelled('lifecycle', 'shared spatial session is not accepting observations', 'walk_to 零边确认期间共享空间会话暂停/关闭/未准入');
      }

      // 父取消与本次生命周期任一到达都经 awaitFrame 合并到 WalkTick 既有 signal 契约：
      // abort/期限会中止本次等待并传递给帧源，不另设一套超时。
      const entity = await awaitFrame(tick, deadlineMs, Date.now, ctx.signal, lifecycle.signal);

      // 每次等待返回后先复核，再决定是否接受这一帧；失效后的迟到帧不能覆盖旧末位。
      if (ctx.signal.aborted) return cancelled('agent', 'parent task cancelled', 'walk_to 零边确认被父任务取消');
      if (lifecycle.signal.aborted) {
        return cancelled('lifecycle', 'shared spatial session interrupted the active confirmation', 'walk_to 零边确认被共享空间生命周期取消');
      }
      if (Date.now() >= deadlineMs) return timedOut('walk_to 零边确认到达期限');
      const after = ctx.adapter.state();
      if (!after.alive || !after.connected || !after.observationReady) {
        return cancelled(
          'lifecycle',
          `alive=${after.alive} connected=${after.connected} observationReady=${after.observationReady}`,
          'walk_to 零边确认期间身体/观测失效',
        );
      }
      if (after.worldId !== scope.worldId || after.dim !== scope.dim || after.sessionId !== scope.sessionId) {
        return cancelled('lifecycle', `scope=${after.worldId}/${after.dim}/${after.sessionId}`, 'walk_to 零边确认期间作用域变化');
      }
      if (spatial.closing || spatial.paused || !spatial.observationAdmitted) {
        return cancelled('lifecycle', 'shared spatial session is not accepting observations', 'walk_to 零边确认期间共享空间会话暂停/关闭/未准入');
      }
      if (entity === null) {
        return failed('连接仍有效但没有物理帧，无法确认原到达条件', {
          kind: 'execution_failed', detail: 'no physics frame delivered while connected',
        });
      }

      const pos = entity.position;
      const measured = { x: pos.x, y: pos.y, z: pos.z };
      const at = Date.now();

      const ticks = lastAt === null ? 0 : Math.max(0, at - lastAt) / 50;
      const continuous = lastPos !== null && lastAt !== null && settledSince !== null
        && at - lastAt <= Math.max(50, limits.stableMs)
        && Math.hypot(measured.x - lastPos.x, measured.z - lastPos.z) <= limits.maxHorizontalSpeed * ticks + SAMPLE_EPS
        && Math.abs(measured.y - lastPos.y) <= limits.maxVerticalSpeed * ticks + SAMPLE_EPS;

      const inRange = arrival.kind === 'exact'
        ? Math.hypot(measured.x - target.x, measured.z - target.z) <= limits.horizontalTolerance
          && Math.abs(measured.y - target.y) <= limits.feetTolerance
        : distance3d(measured, target) <= arrival.radius;
      const grounded = inRange && entity.onGround && !entity.isInWater
        && Math.hypot(entity.velocity.x, entity.velocity.z) <= limits.maxHorizontalSpeed
        && Math.abs(entity.velocity.y) <= limits.maxVerticalSpeed;

      if (!grounded) {
        settledSince = null;
        settledSamples = 0;
      } else if (!continuous || settledSince === null) {
        settledSince = at;
        settledSamples = 1;
      } else {
        settledSamples += 1;
      }
      lastPos = measured;
      lastAt = at;
      const observation: LastObservation = {
        worldId: after.worldId, dim: after.dim, sessionId: after.sessionId,
        observedAt: at, onGround: entity.onGround, inWater: entity.isInWater,
      };
      lastObservation = observation;

      if (grounded && settledSamples >= 2 && settledSince !== null && at - settledSince >= limits.stableMs) {
        const nav: ZeroEdgeNav = {
          outcome: 'ARRIVED',
          message: `零边候选：已在实测稳定位置确认原到达条件（无移动）：${measured.x},${measured.y},${measured.z}`,
          confirmed: true,
          trace: [],
          lastPosition: { ...measured },
          lastObservation: { ...observation },
        };
        return { nav, stableSamples: settledSamples };
      }
    }

    return failed('零边候选在有限帧内未形成稳定落地样本，未确认原到达条件', {
      kind: 'unconfirmed_arrival', expected: { ...target },
    });
  } finally {
    // 只解除本次确认自己的 token；不中止父任务 signal。
    spatial.detach(token);
  }
}

/** 把执行后端的结果映射成技能结果；候选末点到 ≠ 原目标到达。 */
function executionResult(
  execution: WalkRouteExecution,
  candidate: WalkSearchCandidate,
  snapshot: WalkSearchSnapshot,
  base: WalkToBase,
): SkillResult {
  const nav = execution.nav;
  const data = {
    ...base,
    stage: nav.outcome,
    candidate,
    search: snapshot,
    nav,
    ...historyFields(execution),
    ...(nav.outcome === 'ARRIVED' ? { position: { ...nav.lastPosition } } : {}),
    ...(nav.outcome !== 'ARRIVED' && nav.lastPosition !== undefined ? { position: { ...nav.lastPosition } } : {}),
  };
  if (nav.outcome === 'ARRIVED') {
    // exact 由库既有公开 grounded 容差语义确认；near 已在调用处按原半径复核。
    return ok(nav.message, data);
  }
  if (nav.outcome === 'CANCELLED') return { status: 'cancelled', summary: nav.message, data };
  const code = nav.outcome === 'TIMEOUT' ? 'TIMEOUT'
    : nav.outcome === 'BLOCKED' || nav.outcome === 'NO_PATH' || nav.outcome === 'PARTIAL' ? 'PATH_NOT_FOUND'
      : 'ERROR';
  return fail(code, nav.message, data);
}

export const walkTo: Skill<WalkToArgs> = {
  name: 'walk_to',
  description: '按给定目的地做一次显式有界步行搜索并执行：只支持同高、从当前连续脚位沿整数 X/Z 格、普通干燥整块的路线；不含挖掘、放置、跳跃、游泳或绕行改造。搜索前会以当前身体脚格为中心做固定水平半径 4（9×9×4 格：支撑/脚/头/净空）的有限转头观察，至多 12 次真实 look；范围不随目标或搜索前沿扩张，转头观察不使用任何物品。执行中每段会朝行进方向俯视该段支撑格，移动中只观察身体周边 3×3×4 格。搜索预算固定（512 节点/2048 边），找到的只是候选，最终到达由真实身体闭环与实测位置确认。exact 目标必须落在当前脚位的整数 XZ 格上（沿用既有 grounded 物理容差），near 使用原半径的完整 XYZ 距离；输入不支持会明确报告能力限制，不代表世界无路。',
  argsDoc: '{"to":[x,y,z],"arrival":{"kind":"exact"} 或 {"kind":"near","radius":>0的有限数字},"deadlineMs":可选绝对epoch毫秒}',
  timeoutMs: 30000,
  movement: true,
  validate(raw, _adapter) {
    const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const to = readPoint(a.to);
    if (to === null) return { ok: false, error: 'walk_to 需要 {"to":[x,y,z],...}，坐标为 ±30000000 内的有限数字（保留负数与小数）' };
    const rawArrival = a.arrival;
    if (rawArrival === null || typeof rawArrival !== 'object' || Array.isArray(rawArrival)) {
      return { ok: false, error: 'walk_to 需要显式 arrival：{"kind":"exact"} 或 {"kind":"near","radius":...}' };
    }
    const ra = rawArrival as Record<string, unknown>;
    let arrival: WalkToArrival;
    if (ra.kind === 'exact') {
      arrival = { kind: 'exact' };
    } else if (ra.kind === 'near') {
      const radius = ra.radius;
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
        return { ok: false, error: 'walk_to near.radius 必须是正的有限数字（格）' };
      }
      arrival = { kind: 'near', radius };
    } else {
      return { ok: false, error: 'walk_to arrival.kind 必须是 exact 或 near' };
    }
    const rawDeadline = a.deadlineMs;
    let deadlineMs: number | undefined;
    if (rawDeadline !== undefined) {
      if (typeof rawDeadline !== 'number' || !Number.isFinite(rawDeadline) || rawDeadline <= 0) {
        return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
      }
      deadlineMs = rawDeadline;
    }
    return { ok: true, args: { to, arrival, ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const base: WalkToBase = {
      originalRequest: {
        to: { ...args.to },
        arrival: args.arrival.kind === 'exact' ? { kind: 'exact' } : { kind: 'near', radius: args.arrival.radius },
        ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
      },
      target: { ...args.to },
    };
    const spatial = ctx.spatial;
    if (!spatial) return fail('ERROR', 'walk_to 需要宿主共享空间会话（ctx.spatial），当前未接线', base);
    // 入口同步取得本委托的身体桥，后续异步准备不再重新取，旧任务不会拿到新身体。
    const body = ctx.adapter.walkBody?.();
    const tick = ctx.adapter.walkTick?.();
    if (!body || !tick) return fail('ERROR', '当前适配器没有 walk 身体桥（walkBody/walkTick）', base);

    // 有效期限只能缩短父委托预算：args.deadlineMs 是绝对 epoch，不是相对预算。
    const effectiveDeadline = Math.min(args.deadlineMs ?? ctx.deadline, ctx.deadline);
    if (ctx.signal.aborted) return { status: 'cancelled', summary: 'walk_to 在开始前被取消', data: base };
    if (Date.now() >= effectiveDeadline) return fail('TIMEOUT', 'walk_to 期限在开始前已耗尽', { ...base, stage: 'TIMEOUT' });

    const map = spatial.session.voxel;
    const entry = ctx.adapter.state();
    if (!entry.alive || !entry.connected || !entry.observationReady) {
      return fail('NOT_CONNECTED', '身体或观测尚未就绪', { ...base, stage: 'NOT_READY' });
    }
    if (entry.worldId !== spatial.worldId || entry.worldId !== map.worldId || entry.dim === 'unknown') {
      return fail('ERROR', '共享空间作用域与当前身体不一致', { ...base, stage: 'SCOPE_CHANGED' });
    }

    const search = new WalkRouteSearch(map, { now: Date.now, ...SEARCH_LIMITS });
    let snapshot: WalkSearchSnapshot | null = null;
    let searchToken: number | null = null;
    let startFeet: Vec3Like | null = null;
    let stop: SearchStop | null = null;

    // 局部准备期间的复核：取消、期限、原作用域/ready 与共享可接纳都通过后才继续转头或观测。
    const prepReady = (): boolean => {
      if (ctx.signal.aborted || Date.now() >= effectiveDeadline) return false;
      const s = ctx.adapter.state();
      return s.alive && s.connected && s.observationReady
        && s.worldId === entry.worldId && s.dim === entry.dim && s.sessionId === entry.sessionId
        && !spatial.closing && !spatial.paused && spatial.observationAdmitted;
    };

    // 搜索/准备期间只暂停 stationary watchdog，不延长任何任务期限；finally 恢复。
    ctx.setStationaryWait?.(true);
    try {
      // 有限局部准备：当前脚格为中心固定水平半径 4（9×9×4 格），至多 12 次真实转头；
      // 不枚举世界或目标矩形。入口先过同一门禁：已暂停/未准入/已关闭/换 scope/取消/到期
      // 时连初始观测都不发，也不转头。
      const prepCells = preparationCells(ctx.adapter.state().pos);
      let prepStopped = !prepReady();
      if (!prepStopped) {
        observeCells(ctx, map, prepCells);
        if (typeof ctx.adapter.look === 'function') {
          for (const pitch of [-1.2, 0, 1.1]) {
            for (const yaw of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
              if (!prepReady()) { prepStopped = true; break; }
              await ctx.adapter.look(yaw, pitch);
              // 转头返回后先复核；取消/换 scope/暂停后不得再发观测请求或继续转头。
              if (!prepReady()) { prepStopped = true; break; }
              observeCells(ctx, map, prepCells);
            }
            if (prepStopped) break;
          }
        }
      }

      if (ctx.signal.aborted) {
        stop = { stage: 'CANCELLED', reason: 'parent task cancelled', summary: 'walk_to 在局部准备时被取消' };
      } else if (Date.now() >= effectiveDeadline) {
        stop = { stage: 'TIMEOUT', reason: 'deadline exceeded', summary: 'walk_to 在局部准备时到达期限' };
      } else {
        const startState = ctx.adapter.state();
        if (!startState.alive || !startState.connected || !startState.observationReady) {
          stop = {
            stage: 'NOT_READY',
            reason: `alive=${startState.alive} connected=${startState.connected} observationReady=${startState.observationReady}`,
            summary: '局部准备后身体/观测失效，未开始搜索',
          };
        } else if (startState.worldId !== entry.worldId || startState.dim !== entry.dim || startState.sessionId !== entry.sessionId) {
          stop = {
            stage: 'SCOPE_CHANGED',
            reason: `scope=${startState.worldId}/${startState.dim}/${startState.sessionId}`,
            summary: '局部准备后作用域变化，未开始搜索',
          };
        } else if (spatial.closing || spatial.paused || !spatial.observationAdmitted) {
          stop = {
            stage: 'NOT_READY',
            reason: 'shared spatial session is not accepting a delegation',
            summary: '共享空间会话未就绪/已暂停/已关闭，不能开始搜索',
          };
        } else {
          // 固定搜索起点：本次实测的连续脚位（不取整、不从目标反推）。
          startFeet = { x: startState.pos.x, y: startState.pos.y, z: startState.pos.z };
          // 搜索期间的真实报告→invalidate，生命周期→cancel；token 仅覆盖本次搜索。
          searchToken = spatial.attach({
            receiver: (report) => { search.invalidate(report); },
            cancel: () => { search.cancel('shared spatial session interrupted the active search'); },
          });
          snapshot = search.start({
            worldId: startState.worldId, dim: startState.dim, sessionId: startState.sessionId, mode: 'walk',
            body: { feet: startFeet, width: 0.6, height: 1.8, pose: 'standing' },
            target: { ...args.to }, arrival: args.arrival, shapeProvider: walkCollisionProvider,
          });
          while (snapshot.state === 'PENDING') {
            const before = searchStop(ctx, effectiveDeadline, startState);
            if (before !== null) {
              search.cancel(before.reason);
              snapshot = search.status()!;
              stop = before;
              break;
            }
            search.advance(EDGES_PER_ADVANCE);
            // 宏任务让出：取消、期限与共享会话报告都能在批次之间落地。
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            const after = searchStop(ctx, effectiveDeadline, startState);
            if (after !== null) {
              search.cancel(after.reason);
              snapshot = search.status()!;
              stop = after;
              break;
            }
            // yield 期间可能收到真实报告：重新读取终态，INVALIDATED 不重搜。
            snapshot = search.status()!;
          }
        }
      }
    } finally {
      // 只解除本次搜索的 token；执行后端的附着在之后单独建立，互不越权解除。
      if (searchToken !== null) spatial.detach(searchToken);
      ctx.setStationaryWait?.(false);
    }

    if (stop !== null) {
      const data = {
        ...base,
        stage: stop.stage === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED',
        ...(startFeet !== null ? { position: { ...startFeet } } : {}),
        ...(snapshot !== null ? { search: snapshot } : {}),
        cancelBy: stop.stage === 'SCOPE_CHANGED' ? 'scope_changed' : stop.stage === 'NOT_READY' ? 'lifecycle' : stop.stage === 'CANCELLED' ? 'parent' : 'deadline',
      };
      if (stop.stage === 'TIMEOUT') return fail('TIMEOUT', stop.summary, data);
      return { status: 'cancelled', summary: stop.summary, data };
    }
    if (snapshot === null) return fail('ERROR', 'walk_to 搜索未产生快照', base);

    if (snapshot.state !== 'FOUND' || snapshot.candidate === null) {
      return searchTerminalResult(snapshot, base, startFeet);
    }
    const candidate = snapshot.candidate;

    // 候选点数上限是执行后端的明确预算：超限不截断、不执行。
    if (candidate.points.length > MAX_CANDIDATE_POINTS) {
      return fail('ERROR', `walk_to 候选路线 ${candidate.points.length} 点超过本次执行上限 ${MAX_CANDIDATE_POINTS}，未截断执行`, {
        ...base,
        stage: 'route_budget',
        ...(startFeet !== null ? { position: { ...startFeet } } : {}),
        candidate,
        search: snapshot,
      });
    }

    // 执行前再次核对父取消/期限/真实作用域；失效即停，不执行已失效候选。
    if (ctx.signal.aborted) {
      return {
        status: 'cancelled', summary: 'walk_to 在执行前被父任务取消',
        data: { ...base, stage: 'CANCELLED', candidate, search: snapshot, ...(startFeet !== null ? { position: { ...startFeet } } : {}) },
      };
    }
    if (Date.now() >= effectiveDeadline) {
      return fail('TIMEOUT', 'walk_to 在执行前到达期限', {
        ...base, stage: 'TIMEOUT', candidate, search: snapshot, ...(startFeet !== null ? { position: { ...startFeet } } : {}),
      });
    }
    const preMove = ctx.adapter.state();
    if (!preMove.alive || !preMove.connected || !preMove.observationReady) {
      return {
        status: 'cancelled', summary: 'walk_to 执行前身体/观测失效，未开始移动',
        data: { ...base, stage: 'CANCELLED', cancelBy: 'lifecycle', candidate, search: snapshot, ...(startFeet !== null ? { position: { ...startFeet } } : {}) },
      };
    }
    if (preMove.worldId !== snapshot.worldId || preMove.dim !== snapshot.dim || preMove.sessionId !== snapshot.sessionId) {
      return {
        status: 'cancelled', summary: 'walk_to 执行前作用域变化，未开始移动',
        data: { ...base, stage: 'CANCELLED', cancelBy: 'scope_changed', candidate, search: snapshot, ...(startFeet !== null ? { position: { ...startFeet } } : {}) },
      };
    }
    if (spatial.closing || spatial.paused || !spatial.observationAdmitted) {
      return fail('NOT_CONNECTED', '共享空间会话未就绪/已暂停/已关闭，未开始移动', {
        ...base, stage: 'NOT_READY', candidate, search: snapshot, ...(startFeet !== null ? { position: { ...startFeet } } : {}),
      });
    }

    // 零边 FOUND：原完成条件已在起点成立，只做有界真实帧确认，不造路线。
    if (candidate.edgeCount === 0) {
      const zero = await confirmZeroEdge(ctx, spatial, tick, args.to, args.arrival, effectiveDeadline, snapshot);
      const nav = zero.nav;
      const zeroData = {
        ...base,
        zeroEdge: true,
        candidate,
        search: snapshot,
        nav,
        // 零边候选没有任何已确认移动段：统一不记录历史、不造 traversal/move id。
        history: { status: 'not_recorded' as const, traversalIds: [] as [], reason: 'no_confirmed_segment' as const },
        ...(nav.lastPosition !== undefined ? { position: { ...nav.lastPosition } } : {}),
      };
      if (nav.outcome === 'ARRIVED') {
        // 零控制、零位移的成功确认：仍是 ARRIVED（原条件成立），但 noop=true 让调用方
        // 不把它计入身体效果；trace=[] 且没有 move executionId 保持原样。
        return ok(nav.message, {
          ...zeroData,
          stage: 'ARRIVED',
          confirmed: true,
          noop: true,
          observedAt: nav.lastObservation.observedAt,
          stableSamples: zero.stableSamples,
        });
      }
      if (nav.outcome === 'CANCELLED') {
        return {
          status: 'cancelled',
          summary: nav.message,
          data: {
            ...zeroData,
            stage: 'CANCELLED',
            cancelBy: nav.problem.kind === 'cancelled' && nav.problem.by === 'agent' ? 'parent' : 'lifecycle',
          },
        };
      }
      if (nav.outcome === 'TIMEOUT') return fail('TIMEOUT', nav.message, { ...zeroData, stage: 'TIMEOUT' });
      return fail(nav.problem.kind === 'unconfirmed_arrival' ? 'EFFECT_NOT_CONFIRMED' : 'ERROR', nav.message, {
        ...zeroData, stage: nav.problem.kind, confirmed: false, problem: nav.problem,
      });
    }

    // 候选交给既有执行后端：内部 exact 只指候选末点，原 to/arrival 完整保留在 data。
    const request = {
      worldId: snapshot.worldId, dim: snapshot.dim, sessionId: snapshot.sessionId, mode: 'walk' as const,
      body: { feet: { ...candidate.points[0]! }, width: 0.6, height: 1.8, pose: 'standing' as const },
      points: candidate.points, arrival: { kind: 'exact' as const },
      bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: effectiveDeadline, timeoutMs: 4000,
    };
    const execution = await executeWalkRoute(ctx, spatial, { map, body, tick, request, deadlineMs: effectiveDeadline });
    const nav = execution.nav;

    // 父取消但执行器以其它终态返回时，仍按取消返回并保留实际 nav/partial。
    // 位置只投影执行器已有的 lastPosition，不重读新任务的 adapter state。
    if (ctx.signal.aborted && nav.outcome !== 'CANCELLED') {
      return {
        status: 'cancelled',
        summary: nav.message,
        data: {
          ...base, stage: 'CANCELLED', candidate, search: snapshot, nav, ...historyFields(execution),
          ...(nav.lastPosition !== undefined ? { position: { ...nav.lastPosition } } : {}),
        },
      };
    }
    // near 只认原目标与原半径：候选末点到达不等于原 near 条件满足。
    if (nav.outcome === 'ARRIVED' && args.arrival.kind === 'near') {
      const actualDistance = distance3d(nav.lastPosition, args.to);
      if (actualDistance > args.arrival.radius) {
        const detail = `候选末点已到达，但原 near 条件未满足：实测距原目标 ${actualDistance.toFixed(3)} > 半径 ${args.arrival.radius}`;
        // data.nav 表示原委托的真实结果：原 near 条件未确认，不是候选 ARRIVED。
        // 原执行的 lastPosition/lastObservation/trace 原样保留；候选 ARRIVED 单独放在 executionNav。
        const delegationNav: NavResult = {
          outcome: 'FAILED',
          message: detail,
          confirmed: false,
          trace: nav.trace,
          lastPosition: { ...nav.lastPosition },
          lastObservation: { ...nav.lastObservation },
          // 内存写入状态只透传真实 pending/failed 语义，不改变原委托的身体结果。
          ...(nav.memoryWrite !== undefined ? { memoryWrite: nav.memoryWrite } : {}),
          problem: { kind: 'unconfirmed_arrival', expected: { ...args.to } },
        };
        return fail('EFFECT_NOT_CONFIRMED', detail, {
          ...base,
          stage: 'unconfirmed_arrival',
          confirmed: false,
          position: { ...nav.lastPosition },
          candidate,
          search: snapshot,
          nav: delegationNav,
          executionNav: nav,
          ...historyFields(execution),
          problem: { kind: 'unconfirmed_arrival', expected: { ...args.to } },
        });
      }
    }
    return executionResult(execution, candidate, snapshot, base);
  },
};
