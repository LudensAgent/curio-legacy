import type { Vec3Like } from '../../adapter/types.ts';
import { observedFootY } from '../../spatial/land-search.ts';
import { travelStore } from '../../travel/store.ts';
import { cancelledNav, fail, isAbort, navReceipt, obj, ok, runSkill, validateSkill, type NavOutcome, type Skill, type SkillResult } from '../types.ts';
import { navigateTo } from './navigate.ts';
import { blockerCellOf, type SegmentReceipt } from './segment.ts';
import { findMovementSession } from './session.ts';
import { MAKE_WAY_ARGS_DOC, MAKE_WAY_DOC, MAKE_WAY_MAX_EDITS, MAKE_WAY_MAX_RISE, makeWayArgs, makeWayRequest, parseMakeWay } from './make-way.ts';
import { isConstructionFixablePolicyRejection } from '../../spatial/land-edge-policy.ts';
import type { MakeWayEdit } from './coordinator.ts';

type TravelTarget =
  | { x: number; y?: number; z: number }
  | { landmark: string }
  | { portal: string }
  | { death: true };

type TravelToArgs = {
  to: TravelTarget;
  /** 原到达条件：无 y 按水平格距、有 y 按三维格距，单位格。 */
  range: number;
  timeoutMs: number;
  sessionId?: string;
  swim?: boolean;
  /** 显式授权开路；保持委托原样的平铺参数，校验结果可再次通过校验（计划录入后执行前会再校验一次）。 */
  dig?: true | string;
  requireTool?: true;
  place?: string;
  maxEdits?: number;
};

/** 目标只给 x/z 时，在共享 VoxelMap 的同列观测里解析脚高；解析不到就报缺口，不猜落脚高度。 */
const TARGET_FOOT_SCAN = 16;
/** 累计位移预算：最短路线超过直线距离的这个倍数加余量就不再扩大。 */
const MAX_DETOUR_FACTOR = 3;
const DETOUR_SLACK = 8;
/** navigate_to 单次调用的 transition 硬上限。 */
/** 单次委托的步数与分段上限只防失控，不截断正常长途：每格约 3 步余量，分段随推进续接。 */
const HARD_MAX_STEPS = 1024;
const MAX_SEGMENTS = 64;
/** 一次分段执行最多连续走多少 transition；段边界会停稳并重搜，尽量放大以减少停顿。 */
const TRAVEL_SEGMENT_STEPS = 64;
const TARGET_ERROR = 'to 需要坐标 {x,z}/{x,y,z}/"x,z"/"x,y,z"、记得的地标名/base、"death" 或 "portal:<id>"';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;
const at = (p: Vec3Like) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;

function parseTarget(raw: unknown): TravelTarget | string {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return 'to 不能为空';
    if (/^death$/i.test(s)) return { death: true };
    const portal = s.match(/^portal\s*[:：]\s*(\S+)$/i);
    if (portal) return { portal: portal[1] };
    const nums = s.match(/-?\d+(?:\.\d+)?/g);
    if (nums && !/[a-z一-龥]{2,}/i.test(s.replace(/\b[xyz]\s*[=:]/gi, ''))) {
      if (nums.length === 3) return { x: +nums[0], y: +nums[1], z: +nums[2] };
      if (nums.length === 2) return { x: +nums[0], z: +nums[1] };
      return 'to 坐标需要 "x,z" 或 "x,y,z"';
    }
    return { landmark: s };
  }
  const t = obj(raw);
  const keys = Object.keys(t);
  const unexpected = keys.filter((key) => !['x', 'y', 'z', 'landmark', 'portal', 'death'].includes(key));
  if (unexpected.length) return `to 不认识字段 ${unexpected.join('、')}；${TARGET_ERROR}`;
  if (keys.some((key) => key === 'x' || key === 'y' || key === 'z')) {
    if (!keys.every((key) => key === 'x' || key === 'y' || key === 'z') || !finite(t.x) || !finite(t.z)) {
      return 'to 坐标需要有限的 x、z（y 可选）';
    }
    if (t.y !== undefined && !finite(t.y)) return 'to.y 需要有限数字';
    return { x: t.x, ...(t.y === undefined ? {} : { y: t.y }), z: t.z };
  }
  if (keys.length === 1 && 'landmark' in t) {
    if (typeof t.landmark !== 'string' || !t.landmark.trim()) return 'landmark 需要非空字符串';
    return { landmark: t.landmark.trim() };
  }
  if (keys.length === 1 && 'portal' in t) {
    if (typeof t.portal !== 'string' || !t.portal.trim()) return 'portal 需要非空字符串';
    return { portal: t.portal.trim() };
  }
  if (keys.length === 1 && 'death' in t) {
    if (t.death !== true) return 'death 需要 true';
    return { death: true };
  }
  return TARGET_ERROR;
}

/**
 * travel_to 的 VoxelMap A* 入口：只把精确目标（坐标、记得的地标/base/死亡点/传送门）转交给
 * navigate_to 执行 walk/step/drop。缺少共享 VoxelMap 时如实报缺口，不会隐式回退。
 */
export const travelTo: Skill<TravelToArgs> = {
  name: 'travel_to',
  description: '走向你给的具体位置：坐标、记得的地标/base/死亡点/已记录传送门。后端是共享 VoxelMap A*（委托 navigate_to），按已记录体素做有界 3D 搜索与实测验收，walk/step/drop 每一步体素证据缺失时用当前已加载方块即时确认（确认不了才停；jump 仍只认体素证据）；没有 VoxelMap 或需要移动但目标列缺证据时如实报缺口。无 y 且尚未在到达范围内时，用 VoxelMap 同列观测解析真实脚高，解析不到就要求补 y 或先观察，不猜落脚高度。range 保持原到达条件（无 y 按水平格距、有 y 按三维格距），实测站稳并进入范围即停止；路线目标仍是原坐标，不会把范围目标改成更近的点。默认不下水，swim:true 时才涉水并代为游泳。' + MAKE_WAY_DOC + '。只接受 to/range/timeoutMs/sessionId/swim/dig/requireTool/place/maxEdits（以及通用 make），其他参数一律拒绝。',
  catalog: `{"to":{x,y,z}|{x,z}|"地标名"|"base"|"death"|"portal:<id>","range"?:2,"swim"?:true,"dig"?:true|"工具名","place"?:"方块名|any","maxEdits"?:1-${MAKE_WAY_MAX_EDITS}（搭桥/开路约每格一次改动）,"sessionId"?}：去一个确定的位置（坐标、地标、死亡点、已登记的门）；按已记录体素寻路走过去，默认不挖不放，写 dig/place 才在走不通时代为挖开挡路格、补支撑或垫高`,
  argsDoc: '{"to": {"x":0,"y":64,"z":0} | {"x":0,"z":0} | "x,y,z" | "x,z" | "地标名" | "base" | "death" | "portal:<id>", "range"?:2（1–16；无 y 按水平格距、有 y 按三维格距） "timeoutMs"?:180000（10000–600000）,"sessionId"?:"原回执里的编号","swim"?:false（true 时允许涉水，并在水中或水边用 swim_path 游向已观察到、沿委托有推进的岸边站立格，没有岸时游向前方水面点；会消耗氧气、不潜水、每次调用最多 8 段，回执 swimLegs 记录每段游泳）,' + MAKE_WAY_ARGS_DOC + '}；只接受 to/range/timeoutMs/sessionId/swim/dig/requireTool/place/maxEdits/make，未知参数会被拒绝。',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const allowedKeys = new Set(['to', 'range', 'timeoutMs', 'sessionId', 'swim', 'dig', 'requireTool', 'place', 'maxEdits', 'make']);
    const unknown = Object.keys(a).filter((key) => !allowedKeys.has(key));
    if (unknown.length) return { ok: false, error: `travel_to 不认识参数 ${unknown.join('、')}；只接受 ${[...allowedKeys].join('、')}` };
    const to = parseTarget(a.to);
    if (typeof to === 'string') return { ok: false, error: to };
    if (a.range !== undefined && (!Number.isInteger(a.range) || a.range < 1 || a.range > 16)) return { ok: false, error: 'range 需要 1–16 的整数' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 10000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 10000–600000 的整数' };
    if (a.sessionId !== undefined && (typeof a.sessionId !== 'string' || !a.sessionId.trim())) return { ok: false, error: 'sessionId 需要非空字符串' };
    if (a.swim !== undefined && typeof a.swim !== 'boolean') return { ok: false, error: 'swim 需要 true 或 false' };
    const makeWay = parseMakeWay(a);
    if (!makeWay.ok) return makeWay;
    return { ok: true, args: { to, range: a.range ?? 2, timeoutMs: a.timeoutMs ?? 180000, ...(a.sessionId === undefined ? {} : { sessionId: (a.sessionId as string).trim() }),
      ...(a.swim === true ? { swim: true } : {}), ...makeWayArgs(makeWay.value) } };
  },
  async run(ctx, args) {
    const { adapter } = ctx;
    const s0 = adapter.state();
    const request = { ...args, to: structuredClone(args.to) } as Record<string, unknown>;
    const backend = 'voxel_astar';
    const start = { ...s0.pos };
    const trace: Vec3Like[] = [start];

    if (!s0.alive || !s0.connected) {
      return fail('NOT_CONNECTED', 'travel_to 需要存活且已连接的身体；没有移动', { originalRequest: request, backend });
    }
    if (s0.riding) {
      return fail('BAD_ARGS', `正在乘坐 ${s0.riding}；travel_to 只委托步行/台阶/下落，不驾驶载具，没有移动`, { originalRequest: request, backend });
    }
    const voxel = ctx.spatial?.session?.voxel;
    if (!voxel) {
      return fail('NOT_CONNECTED', 'travel_to 需要宿主共享空间 VoxelMap；当前没有体素证据，没有移动', { originalRequest: request, backend });
    }

    // 目标解析：坐标原样；记忆目标按当前维度解析成位置。解析失败不移动。
    const t = args.to;
    let label: string;
    let point: { x: number; y?: number; z: number };
    if ('x' in t) {
      point = { x: t.x, ...(t.y === undefined ? {} : { y: t.y }), z: t.z };
      label = `${t.x},${t.y === undefined ? '' : `${t.y},`}${t.z}`;
    } else if ('death' in t) {
      const death = ctx.memory.lastDeath();
      if (!death || death.dim !== s0.dim) {
        return fail('NOT_FOUND', `当前维度 ${s0.dim} 里没有记得的死亡地点；没有移动`, { originalRequest: request, backend });
      }
      point = { ...death.pos };
      label = '死亡地点';
    } else if ('portal' in t) {
      const portal = travelStore(ctx.memory).get(t.portal, s0.worldId);
      if (!portal || portal.dim !== s0.dim) {
        return fail('NOT_FOUND', `当前维度 ${s0.dim} 里没有记得的传送门 ${t.portal}；没有移动`, { originalRequest: request, backend });
      }
      point = { ...portal.pos };
      label = `传送门 ${portal.id}`;
    } else {
      const landmark = ctx.memory.findLandmark(t.landmark, s0.dim);
      if (!landmark || landmark.dim !== s0.dim) {
        return fail('NOT_FOUND', `当前维度 ${s0.dim} 里没有记得的地标 ${JSON.stringify(t.landmark)}；没有移动`, { originalRequest: request, backend });
      }
      point = { ...landmark.pos };
      label = landmark.label;
    }

    const requestedY = point.y !== undefined;
    const resumed = args.sessionId === undefined ? undefined : findMovementSession(args.sessionId);
    // 无 y 目标的首次解析高度属于冻结意图；续接不能随新站位/证据另选一层。
    // 原坐标、到达条件与 scope 仍由 Coordinator 统一校验，不能靠这里的复用绕过。
    const frozenY = resumed?.intent.kind === 'navigate' && resumed.intent.arrival?.metric === 'horizontal'
      ? resumed.intent.to.y : undefined;
    let goalY = point.y ?? frozenY;
    const resolvedTarget = { x: point.x, ...(requestedY ? { y: point.y } : {}), z: point.z };

    // 原到达条件只在实测边界使用：无 y 按水平格距、有 y 按三维格距。
    const flat = (p: Vec3Like) => Math.hypot(Math.floor(p.x) - Math.floor(point.x), Math.floor(p.z) - Math.floor(point.z));
    const gap = (p: Vec3Like) => requestedY
      ? Math.hypot(flat(p), Math.floor(p.y) - Math.floor(point.y!))
      : flat(p);
    const arrived = (p: Vec3Like, onGround: boolean) => onGround && gap(p) <= args.range;
    const arrivalAt = (p: Vec3Like, onGround: boolean) => ({
      mode: 'near_radius' as const,
      required: { radius: args.range, metric: requestedY ? '3d' : 'horizontal' },
      measured: { position: { ...p }, distance: round1(gap(p)), onGround },
      satisfied: arrived(p, onGround),
    });

    const startedAt = Date.now();
    const deadline = Math.min(ctx.deadline, startedAt + args.timeoutMs);
    const facts = () => {
      const end = { ...adapter.state().pos };
      const displacement = { horizontal: round1(Math.hypot(end.x - start.x, end.z - start.z)), vertical: round1(end.y - start.y) };
      return {
        requestedTarget: resolvedTarget, resolvedTarget, label,
        ...(goalY === undefined ? {} : { targetFootY: goalY, targetYSource: requestedY ? 'requested' : frozenY === undefined ? 'voxel_observed' : 'frozen_session' }),
        backend, delegate: 'navigate_to' as const,
        position: end, displacement,
        remaining: { horizontal: round1(flat(end)), ...(requestedY ? { vertical: Math.floor(point.y!) - Math.floor(end.y) } : {}) },
        closer: round1(gap(start) - gap(end)),
        elapsedRealS: Math.round((Date.now() - startedAt) / 1000),
        ...(trace.length > 1 ? { trace: trace.slice(-24).map((p) => ({ ...p })) } : {}),
      };
    };
    const receipt = (r: SkillResult, outcome: NavOutcome, settlementFailed = false) => {
      const state = adapter.state();
      const arrival = arrivalAt(state.pos, state.onGround);
      return navReceipt(r, {
        backend, originalRequest: request, resolvedTarget, outcome,
        position: { ...state.pos }, trace, arrival: settlementFailed
          ? { ...arrival, satisfied: false, measured: { ...arrival.measured, settled: false } } : arrival,
      });
    };

    if (ctx.signal.aborted) {
      return receipt({ status: 'cancelled', summary: 'travel_to 开始前已取消，没有移动', data: facts() }, 'CANCELLED');
    }

    // 开始前已满足原到达条件：这是实测事实，不是用请求坐标冒充到达。
    if (args.sessionId === undefined && arrived(start, s0.onGround)) {
      return receipt(ok(`已在 ${label} 的到达范围内：实测 ${at(start)}，距离 ${round1(gap(start))} 格 ≤ range ${args.range}；没有移动`, {
        ...facts(), outcome: 'ARRIVED' as const, alreadyWithinRange: true,
      }), 'ARRIVED');
    }
    if (Date.now() >= deadline) {
      return receipt(fail('TIMEOUT', `travel_to 的期限在开始前已耗尽（请求上限 ${Math.round(args.timeoutMs / 1000)} 秒）；没有移动`, {
        ...facts(), outcome: 'TIMEOUT' as const, stopReason: 'TIMEOUT', timeoutSource: 'budget',
      }), 'TIMEOUT');
    }

    // 只有尚未进入原到达范围、确实需要规划移动时，才要求目标列的脚高证据。
    goalY ??= observedFootY(voxel, s0.dim, Math.floor(point.x), Math.floor(point.z), Math.floor(start.y), TARGET_FOOT_SCAN, TARGET_FOOT_SCAN) ?? undefined;
    if (goalY === undefined) {
      return receipt(fail('BAD_ARGS', `目标 (${point.x},${point.z}) 没有给 y，且共享 VoxelMap 在该列 ±${TARGET_FOOT_SCAN} 格内没有可站立面的新鲜证据；travel_to 不猜落脚高度。请写 {x,y,z}（y 是脚高）或先观察该列；没有移动`, {
        ...facts(), originalRequest: request, outcome: 'UNSUPPORTED',
        capabilityGap: 'target_foot_y_unobserved', target: resolvedTarget,
      }), 'FAILED');
    }
    const goal = { x: point.x, y: goalY, z: point.z };
    // 未到达时区分“路线受阻”和“换目标语义”：方向探索不接收目的地坐标，不能当成等价替代。
    const unchangedFact = `原坐标目标 (${Math.round(goal.x)},${Math.round(goal.y)},${Math.round(goal.z)}) 未变：explore_toward 只按方向推进、不接收这个目的地坐标，也不保证到达它；有未过期的 sessionId 就原样续接，已授权 dig/place 时也可先短段挖/垫再续`;
    const failedSummary = (detail: string) => `travel_to 原目标尚未满足；${detail}；${unchangedFact}`;

    const direct = Math.hypot(goal.x - start.x, goal.y - start.y, goal.z - start.z);
    const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(16, Math.ceil(direct * MAX_DETOUR_FACTOR) + DETOUR_SLACK));
    const nested = validateSkill(navigateTo, {
      to: goal,
      allowed: ['walk', 'step', 'drop', 'jump'],
      historical: true,
      maxSteps,
      maxStepsPerSegment: Math.min(TRAVEL_SEGMENT_STEPS, maxSteps),
      // 分段/搜索/观察都随距离放大：搭桥时每处施工都会交回并重搜一次，固定上限会先把长途截断。
      maxSegments: Math.min(1024, MAX_SEGMENTS + Math.ceil(direct / 2)),
      // 边走边规划时每接一段窗口、每次绕路都要搜索：预算约每格两次，只防无限循环，不截断长途委托。
      maxSearches: Math.min(2048, 64 + Math.ceil(direct) * 2),
      // 观察次数同理：长途上每遇到一段证据边界都可能要看一眼，默认 2 次会截断委托。
      maxObservations: Math.min(256, 32 + Math.ceil(direct / 4)),
      maxObservedCells: Math.min(8192, 2048 + Math.ceil(direct) * 16),
      deadlineMs: deadline,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    }, adapter);
    if (!nested.ok) {
      return receipt(fail('BAD_ARGS', `travel_to 生成 navigate_to 参数无效：${nested.error}；没有移动`, {
        ...facts(), outcome: 'UNSUPPORTED' as const, stopReason: 'UNSUPPORTED',
      }), 'FAILED');
    }

    let moved: SkillResult;
    try {
      moved = await runSkill(ctx, navigateTo, {
        ...nested.args,
        rolling: true,
        ...(args.swim === true ? { swim: true } : {}),
        ...makeWayRequest(args), makeWayAvailable: true,
        arrival: { radius: args.range, metric: requestedY ? '3d' : 'horizontal' },
      });
    } catch (error) {
      if (!isAbort(error)) throw error;
      trace.push({ ...adapter.state().pos });
      const state = adapter.state();
      throw cancelledNav(error, { backend, originalRequest: request, resolvedTarget, position: trace.at(-1) ?? null, trace, arrival: arrivalAt(state.pos, state.onGround) });
    }
    trace.push({ ...adapter.state().pos });
    const endState = adapter.state();
    const end = { ...endState.pos };
    const movedFacts = facts();
    const stop = (moved.data?.stop ?? {}) as { reason?: string };
    const stopReason = typeof stop.reason === 'string' ? stop.reason : undefined;
    const lastSegment = moved.data?.lastSegment as SegmentReceipt | undefined;
    // 计划过时后的重搜段没有执行级阻挡；navigate_to 会把本次调用最近一次实测阻挡带到 data.blocker。
    const blocker = (lastSegment?.blocker ?? moved.data?.blocker) as SegmentReceipt['blocker'];
    const blockerCell = blockerCellOf(blocker);
    const blockerName = blockerCell === undefined ? null : ctx.adapter.blockAt(blockerCell);
    const verticalGap = Math.floor(goalY) - Math.floor(end.y);
    const policyRejection = lastSegment?.search.policy?.firstRejection;
    const gapRejected = policyRejection !== undefined && isConstructionFixablePolicyRejection(policyRejection.reason)
      && policyRejection.reason.includes('horizontal gap jump');
    const headBlocked = blocker?.problem === 'HEAD_BLOCKED';
    const needsExplicitAscent = headBlocked && verticalGap > MAKE_WAY_MAX_RISE;
    const ascentHint = needsExplicitAscent
      ? `当前 ${at(end)}，目标垂直差 ${verticalGap} 格，最近一次遇到头部阻挡${blockerCell === undefined ? '' : ` ${blockerName ?? '未知方块'}${at(blockerCell)}`}；已确认 ${lastSegment?.confirmed?.length ?? 0} 段移动，入口/深层进度点见 my_tunnels；普通路线只覆盖 walk/step/drop/jump，需要显式上行施工（例如 excavate_run stairs_up / pillar_one / place_support）或先走 my_tunnels 的实际开挖入口`
      : '';
    const gapHint = gapRejected && args.place === undefined
      ? `路线缺口超过跳跃能力，这次没有 place 授权；需要 place 搭桥，或先走 my_tunnels 里的实际开挖入口`
      : '';
    const routeHint = [ascentHint, gapHint].filter(Boolean).join('；');
    const routeFacts = {
      ...moved.data,
      ...movedFacts,
      navigation: moved.data,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(moved.failureCode === undefined ? {} : { navigationFailureCode: moved.failureCode }),
      verticalGap,
      ...(blockerCell === undefined ? {} : { blocker: { ...(blocker ?? {}), name: blockerName } }),
      ...(needsExplicitAscent ? { needsExplicitAscent: true } : {}),
      ...(gapRejected && policyRejection !== undefined ? { routeGap: { reason: policyRejection.reason } } : {}),
      ...(routeHint ? { routeHint } : {}),
    };

    if (moved.status === 'cancelled') {
      return receipt({
        ...moved,
        summary: `${moved.summary}；travel_to 原目标 ${JSON.stringify(resolvedTarget)} 未改变`,
        data: { ...(moved.data ?? {}), ...routeFacts, outcome: 'CANCELLED' as const },
      }, 'CANCELLED');
    }
    if ((moved.data?.lastSegment as SegmentReceipt | undefined)?.stopCode === 'settlement_failed') {
      const outcome = moved.failureCode === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED';
      return receipt({ ...moved, summary: failedSummary(moved.summary), data: { ...routeFacts, outcome } }, outcome, true);
    }
    // 实测进入范围不能授权一个被拒绝的会话/意图，也不能覆盖身体或作用域失效。
    if (moved.failureCode === 'BAD_ARGS' || moved.failureCode === 'WRONG_DIMENSION' || moved.failureCode === 'NOT_CONNECTED') {
      return receipt({ ...moved, data: { ...routeFacts, outcome: 'FAILED' as const } }, 'FAILED');
    }
    if (arrived(end, endState.onGround)) {
      const madeWay = (moved.data?.makeWay as { edits: MakeWayEdit[] } | undefined)?.edits ?? [];
      const effects = (moved.status === 'succeeded' ? '' : '；VoxelMap A* 没有报成功，但实测位置满足原到达条件')
        + (madeWay.length === 0 ? '' : `；代为开路改动 ${madeWay.length} 处：${madeWay.map((edit) => `${edit.kind === 'dig' ? '挖开' : '放置'} ${edit.name}(${edit.pos.x},${edit.pos.y},${edit.pos.z})`).join('、')}`);
      return receipt(ok(`到了 ${label} 附近：实测 ${at(end)}，距离 ${round1(gap(end))} 格 ≤ range ${args.range}（水平位移 ${movedFacts.displacement.horizontal} 格）${effects}`, {
        ...routeFacts, outcome: 'ARRIVED' as const,
      }), 'ARRIVED');
    }

    const outcome: NavOutcome = moved.failureCode === 'TIMEOUT' ? 'TIMEOUT' : movedFacts.closer > 0 ? 'PARTIAL' : 'FAILED';
    return receipt({
      ...moved, status: 'failed', failureCode: moved.failureCode ?? 'EFFECT_NOT_CONFIRMED',
      summary: failedSummary(`${moved.summary}${routeHint ? `；${routeHint}` : ''}`),
      data: { ...routeFacts, outcome },
    }, outcome);
  },
};
