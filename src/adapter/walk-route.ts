/**
 * 最小步行闭环的身体桥与路线入口（离线接线）。
 *
 * 只接普通干燥整块、同高、沿 X/Z 的短路线；不含挖掘、放置、跳跃、绕路、水面、飞行。
 * MoveExecutor 只执行库已选定的单段，不转发给会自行寻路的 moveTo。
 * 制动沿用 finishAdjacentStep 的思路；到达语义由库的 WalkRouteExecutor（显式 bodyArrival）判定。
 *
 * 生产接线注意：这里的 `tick` 是离线测试夹具里推进 prismarine-physics 的帧源；
 * 真实适配层应由游戏服务器的 physicsTick 驱动帧、再喂给本执行器，而不是由执行器
 * 主动推进物理。生命周期/作用域也来自实际适配器，不从请求复制。
 *
 * 控制归属：身体桥的全部控制写入（look/clearControlStates/setControlState/stop）都经
 * WalkMoveExecutor 发出，并在每次写入前、每次异步帧等待恢复后复核父任务信号、当前段
 * 信号与期限；物理帧等待本身支持取消、截止时间和连接结束，不在没有下一帧时永久挂起。
 */

import { GROUNDED_ARRIVAL_DEFAULTS, WalkRouteExecutor, VoxelMap, serializeBlockState } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  ChangeReport,
  CollisionShape,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  KnownWalkRouteStart,
  MoveExecutor,
  NavResult,
  WalkRouteRequest,
  WalkRouteStatus,
} from 'curio-minecraft-3d-memory';

const EMPTY: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const DRY_FULL = new Set(['stone', 'grass_block', 'dirt', 'cobblestone', 'sand']);
const AIR = new Set(['air', 'cave_air', 'void_air']);

/**
 * 移动中看向所委托路径支撑的俯仰角（弧度）。与预扫的向下俯仰一致：同列/近处路径
 * 支撑位于身体下方，水平朝向（pitch=0）的视锥看不到它们，必须向下看才能让支撑
 * 真正进入视锥、成为合法视觉证据。目标朝向（yaw）不受影响，且不消耗资源。
 */
export const WALK_GAZE_PITCH = -1.2;

/** 版本明确的碰撞形状提供器：只接普通干燥整块；未知形状返回能力缺口，不猜。 */
export const walkCollisionProvider: CollisionShapeProvider = {
  version: 'curio-1.20.1-dry-full-v1',
  resolve(state, _cell, _read) {
    const name = state.name.replace(/^minecraft:/, '');
    if (AIR.has(name)) return { kind: 'shape', shape: EMPTY };
    if (DRY_FULL.has(name)) return { kind: 'shape', shape: FULL_CUBE };
    return { kind: 'unsupported_shape', block: serializeBlockState(state), detail: `未接入的形状：${name}` };
  },
};

/**
 * 宿主控制归属：身体桥创建时绑定当时的 action epoch。宿主换主（stopAll、
 * 断线重连、换 bot）后 `owns()` 返回 false，旧执行不得再写控制或释放新任务的控制。
 */
export interface WalkControlOwnership {
  owns(): boolean;
}

/** 身体桥需要的最小接口：只控制前向与朝向、可读取实体状态。 */
export interface WalkBody {
  setControlState(name: string, value: boolean): void;
  clearControlStates(): void;
  /** 转向目标朝向；返回 Promise 时调用方应等待转向完成再按前进键，避免转弯时残留旧朝向。 */
  look(yaw: number, pitch: number): void | Promise<void>;
  entity: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    onGround: boolean;
    isInWater: boolean;
  };
  /** 可选：适配器提供的宿主控制归属；离线夹具不提供时不做宿主归属检查。 */
  controlOwnership?: WalkControlOwnership;
}

/**
 * 一次物理帧推进：离线夹具同步推进 prismarine-physics；生产由 physicsTick 驱动（异步）。
 * 传入 `signal`，在取消、断线或截止时返回 null 而非挂起，并清理自己的监听器。
 */
export interface WalkTick {
  (signal: AbortSignal): Promise<WalkBody['entity'] | null>;
}

/** 实际适配器的存活/连接/观测就绪状态与作用域；不从请求复制后冒充观测。 */
export interface WalkLifecycle {
  worldId: string;
  dim: string;
  sessionId: string;
  alive: boolean;
  connected: boolean;
  observationReady: boolean;
}

/**
 * 库实际发出的一次单段移动请求快照。只复制位置/作用域/执行归属等事实，
 * 不携带 signal、期限或控制入口；收到它不代表已经开始运动或已经到达。
 */
export interface WalkMoveRequestObservation {
  executionId: string;
  worldId: string;
  dim: string;
  sessionId: string;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}

/** 生命周期是否已不可用：死亡/断线/观测未就绪都算失效，需立即终止委托。 */
function lifecycleBroken(lc: WalkLifecycle): boolean {
  return !lc.alive || !lc.connected || !lc.observationReady;
}

/** 身体作用域是否已偏离委托（world/dim/session 任一不一致）。 */
function scopeMismatch(lc: WalkLifecycle, scope: { worldId: string; dim: string; sessionId: string }): boolean {
  return lc.worldId !== scope.worldId || lc.dim !== scope.dim || lc.sessionId !== scope.sessionId;
}

/** 从实际实体观测构造一个 BodySample；作用域与生命周期都来自实际适配器，不从请求复制。 */
export function bodySample(
  executionId: string,
  entity: WalkBody['entity'],
  observedAt: number,
  sequence: number,
  lifecycle: WalkLifecycle,
): BodySample {
  return {
    worldId: lifecycle.worldId, dim: lifecycle.dim, sessionId: lifecycle.sessionId, executionId,
    pos: { ...entity.position }, velocity: { ...entity.velocity }, observedAt, sequence,
    alive: lifecycle.alive, connected: lifecycle.connected, observationReady: lifecycle.observationReady,
    onGround: entity.onGround, inWater: entity.isInWater,
  };
}

/**
 * 有界等待下一物理帧：任一信号中止、期限到达或 tick 自身断线都返回 null，
 * 不会依赖“再收到一帧”才发现已经失效。期限由调用方给定（含每段 timeout 与总 deadline 的最小者）。
 */
export async function awaitFrame(
  tick: WalkTick,
  deadlineMs: number,
  now: () => number,
  ...signals: AbortSignal[]
): Promise<WalkBody['entity'] | null> {
  for (const s of signals) if (s.aborted) return null;
  if (now() >= deadlineMs) return null;
  const controller = new AbortController();
  const onAbort = () => { controller.abort(); };
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  const remaining = Math.max(0, deadlineMs - now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      tick(controller.signal),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const s of signals) s.removeEventListener('abort', onAbort);
  }
}

/**
 * 库 MoveExecutor 的窄身体桥：朝向目标向量 + 前向推进，按地面摩擦制动、到点松键，
 * 再把实测物理帧交给宿主构造样本。控制前先检查取消/期限；stop 只释放所属段。
 */
export class WalkMoveExecutor implements MoveExecutor {
  private frameSink: ((entity: WalkBody['entity']) => void) | null = null;
  private activeExecutionId: string | null = null;
  /** 创建时绑定的宿主控制归属；不提供时保持纯离线夹具的既有行为。 */
  private readonly hostOwnership: WalkControlOwnership | undefined;

  constructor(
    private readonly body: WalkBody,
    private readonly tick: WalkTick,
    private readonly parentSignal: AbortSignal,
    private readonly now: () => number = Date.now,
    private readonly lifecycle?: () => WalkLifecycle,
    private readonly onLifecycleBroken?: (detail: string) => void,
    private readonly runSignal?: AbortSignal,
    private readonly onMoveRequest?: (move: WalkMoveRequestObservation) => void,
  ) {
    this.hostOwnership = body.controlOwnership;
  }

  /** 宿主在帧回调里构造样本（掌握单调序号与生命周期），再喂给库。 */
  setFrameSink(fn: (entity: WalkBody['entity']) => void) { this.frameSink = fn; }

  private aborted(request: ExecutableMove): boolean {
    return request.signal.aborted || this.parentSignal.aborted || this.runSignal?.aborted === true;
  }

  /** 仍持有宿主控制权：换主后的旧执行既不能写控制，也不能释放新任务的键。 */
  private ownsHost(): boolean {
    return this.hostOwnership === undefined || this.hostOwnership.owns();
  }

  async move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const { from, to } = request;
    // 记录库实际发出的请求事实；回调只观察，不参与控制、等待或验证。
    this.onMoveRequest?.({
      executionId: request.executionId,
      worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
      from: { ...from }, to: { ...to },
    });
    // 控制前先检查取消、期限与宿主归属：已取消/已到期/已换主的请求不得写任何控制。
    if (this.aborted(request) || !this.ownsHost()) return { failure: { kind: 'cancelled' } };
    // 每段有效期限：总期限与单段 timeout 的较小者，不能靠单段拖过总期限。
    const moveDeadline = Math.min(request.deadlineMs, this.now() + request.timeoutMs);
    if (this.now() >= moveDeadline) return { failure: { kind: 'timed_out' } };

    await this.body.look(Math.atan2(-(to.x - from.x), -(to.z - from.z)), WALK_GAZE_PITCH);
    // 转头后重新检查取消/期限/归属：转头等待期间可能被抢占、到期或换主。
    if (this.aborted(request) || !this.ownsHost()) return { failure: { kind: 'cancelled' } };
    if (this.now() >= moveDeadline) return { failure: { kind: 'timed_out' } };
    // 启动该段前检查生命周期与作用域：已断线/死亡/观测未就绪/换会话时不得写前进键，直接取消本委托。
    const lc = this.lifecycle?.();
    if (lc !== undefined && (lifecycleBroken(lc) || scopeMismatch(lc, request))) {
      this.onLifecycleBroken?.(`alive=${lc.alive} connected=${lc.connected} observationReady=${lc.observationReady} scope=${lc.worldId}/${lc.dim}/${lc.sessionId}`);
      return { failure: { kind: 'cancelled' } };
    }
    // 换主检查之后才写控制；此后同一同步块内不会跨 await，写入都属于本执行。
    if (!this.ownsHost()) return { failure: { kind: 'cancelled' } };
    this.body.clearControlStates();
    this.body.setControlState('forward', true);
    this.activeExecutionId = request.executionId;

    // 制动距离系数：真实 1.20.1 服务器上松开前进键后约再走 1.19 个 tick 的位移即停
    // （实测 coast≈0.256 格、帧间位移≈0.216 格/tick）。离线 prismarine-physics 的 0.546
    // 摩擦口径与之不符，不能直接套用。
    const GROUND_STOP = 1.2;
    const TICK_MS = 50;
    // 接近终点的减速阈值：进入该距离后潜行，限制余速与越过平台的幅度。
    // 满速 + 采样间隔不均匀（如补跑 4 tick）时一次可前冲约 0.86 格，故提前减速，
    // 让实际运动轨迹留在已验证范围内；越过后的纠偏只作补充。
    const SLOW_DISTANCE = 0.7;
    // 到达容差：制动后落在容差外时按此做有限位置修正（前后蠕行），不放大容差掩盖误差。
    const tol = request.bodyArrival?.horizontalTolerance ?? 0.12;
    const axis = { x: to.x - from.x, z: to.z - from.z }; // 单轴 ±1
    let prevPos: { x: number; z: number } | null = null;
    let prevTime: number | null = null;
    for (let i = 0; i < 400; i++) {
      if (this.aborted(request) || !this.ownsHost()) { this.releaseIf(request.executionId); return { failure: { kind: 'cancelled' } }; }
      if (this.now() >= moveDeadline) { this.releaseIf(request.executionId); return { failure: { kind: 'timed_out' } }; }
      const e = await awaitFrame(this.tick, moveDeadline, this.now, request.signal, this.parentSignal, ...(this.runSignal ? [this.runSignal] : []));
      // 每次异步等待返回后，在写控制或提交样本之前，复核取消/期限/归属：旧段迟到恢复不能
      // 松开新段的键、提交旧样本；到期帧也不能再写控制。
      if (this.aborted(request) || !this.ownsHost()) { this.releaseIf(request.executionId); return { failure: { kind: 'cancelled' } }; }
      if (this.now() >= moveDeadline) { this.releaseIf(request.executionId); return { failure: { kind: 'timed_out' } }; }
      if (e === null) {
        // 无帧：取消与期限已在上方排除。null 是帧源结束/取消的结果，不是重试授权——
        // 继续重试会在微任务队列上空转、过早耗尽 400 次迭代，把正常等待误判为超时。
        const lc = this.lifecycle?.();
        if (lc !== undefined && (lifecycleBroken(lc) || scopeMismatch(lc, request))) {
          this.onLifecycleBroken?.(`alive=${lc.alive} connected=${lc.connected} observationReady=${lc.observationReady} scope=${lc.worldId}/${lc.dim}/${lc.sessionId}`);
          this.releaseIf(request.executionId);
          return { failure: { kind: 'cancelled' } };
        }
        // 生命周期仍有效却无帧可交付：显式执行失败，不伪造超时也不伪造生命周期取消。
        this.releaseIf(request.executionId);
        return { failure: { kind: 'execution_error', detail: 'no physics frame delivered while connected' } };
      }
      const dist = Math.hypot(to.x - e.position.x, to.z - e.position.z);
      // 用实际帧间位移估计速度，并按采样间隔折算为每 tick 速度：每 2 tick 采样一次时位移是
      // 2 倍，直接当速度会让制动距离翻倍而提前停下。首帧没有前值，退回 velocity 作启动近似。
      const t = this.now();
      const speed = prevPos !== null && prevTime !== null
        ? Math.hypot(e.position.x - prevPos.x, e.position.z - prevPos.z) / Math.max(1, (t - prevTime) / TICK_MS)
        : Math.hypot(e.velocity.x, e.velocity.z);
      // 沿运动轴的实际运动方向：>0 朝目标轴正向移动，<0 反向。首帧无前值，置 0。
      const movingAlong = prevPos !== null
        ? (e.position.x - prevPos.x) * axis.x + (e.position.z - prevPos.z) * axis.z
        : 0;
      prevPos = { x: e.position.x, z: e.position.z };
      prevTime = t;
      // 沿运动轴的有符号误差：>0 冲过头，<0 还没到。
      const signed = (e.position.x - to.x) * axis.x + (e.position.z - to.z) * axis.z;
      if (dist <= tol) {
        this.body.setControlState('forward', false);
        this.body.setControlState('back', false);
        this.body.setControlState('sneak', false);
      } else if (signed * movingAlong > 0) {
        // 越过目标且继续同向远离：不能只等「进入制动距离窗口」（采样间隔不均匀时可能直接跳过去），
        // 立即松键制动，再交由下面的有限纠偏。
        this.body.setControlState('forward', false);
        this.body.setControlState('back', false);
        this.body.setControlState('sneak', false);
      } else if (speed < 0.01) {
        // 静止且差一点：潜行缓慢纠偏（冲过头就倒退）。满速纠偏会来回冲过头而振荡，
        // 潜行余速小、停得准，结合速度方向让剩余速度和停止位置共同收敛。
        this.body.setControlState('forward', signed < 0);
        this.body.setControlState('back', signed > 0);
        this.body.setControlState('sneak', true);
      } else if (dist <= speed * GROUND_STOP) {
        this.body.setControlState('forward', false);
        this.body.setControlState('back', false);
        this.body.setControlState('sneak', false);
      } else {
        // 仍在靠近：接近终点时潜行减速（限制余速，防越过平台），否则满速。
        this.body.setControlState('sneak', dist <= SLOW_DISTANCE);
      }
      this.frameSink?.(e);
      // 让出事件循环：库的 onSample 确认到达 → stop/abort，及其 move 结果微任务得以执行。
      await new Promise((r) => setImmediate(r));
    }
    this.releaseIf(request.executionId);
    return { failure: { kind: 'timed_out' } };
  }

  stop(executionId: string): void {
    if (executionId !== this.activeExecutionId) return; // 旧段不能清理新段的控制
    // 结束本次执行的控制权：迟到收尾（releaseIf）再也不能操作身体。
    this.activeExecutionId = null;
    // 宿主已换主时，这些键属于新任务；旧执行只放弃自己的归属，不写任何控制。
    if (!this.ownsHost()) return;
    this.body.setControlState('forward', false);
    this.body.clearControlStates();
  }

  private releaseIf(executionId: string): void {
    // 归属检查必须同时保护松键与清空归属：旧段的迟到收尾不能清掉新段的归属。
    if (executionId !== this.activeExecutionId) return;
    this.activeExecutionId = null;
    // 释放当前执行用到的全部移动键（前进/倒退/潜行）；换主后新任务的键不归旧执行释放。
    if (this.ownsHost()) this.body.clearControlStates();
  }
}

/** 宿主的窄活动句柄：只暴露报告注入与取消，供共享会话在 loop.start 边界附着。 */
export interface ActiveWalkLoop {
  observe(report: ChangeReport, budget: number): void;
  cancel(by: 'lifecycle', reason: string): void;
  /** Read-only progress projection; never advances or mutates the delegation. */
  status(): WalkRouteStatus | null;
}

/**
 * 驱动一个已选短路线，直到终态。MoveExecutor 在 advance 里自驱单段，宿主负责采样、
 * 序号与生命周期，并在到达确认前先处理世界观测。父任务取消经 `signal` 贯通到库取消。
 * `bindActive` 在 loop.start 后立即调用，返回的解除函数只在 finally 里撤销本次附着；
 * 共享会话的关闭/取消不属于这里。
 */
export async function runWalkRoute(opts: {
  map: VoxelMap;
  body: WalkBody;
  request: WalkRouteRequest;
  tick: WalkTick;
  signal: AbortSignal;
  lifecycle?: () => WalkLifecycle;
  observe?: () => ChangeReport | null;
  deadlineMs?: number;
  now?: () => number;
  bindActive?: (loop: ActiveWalkLoop) => (() => void) | void;
  /** 观察库实际发出的单段移动请求；不改变本次执行的控制、等待或验证。 */
  onMoveRequest?: (move: WalkMoveRequestObservation) => void;
  /**
   * 可选启动接缝：收到本次运行的同一个 executor 与已取有效期限的请求。
   * 调用者可据此调用 `startKnownWalkRoute` 并原样返回其结果；STARTED 后本运行
   * 继续驱动该实例。REJECTED 时不会附着活动 loop、不订阅物理帧、不写控制，
   * 直接返回携带原 reason/message 的 FAILED，不冒充世界 BLOCKED/TIMEOUT/ARRIVED。
   */
  starter?: (loop: WalkRouteExecutor, request: WalkRouteRequest) => KnownWalkRouteStart;
}): Promise<NavResult> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadlineMs ?? opts.request.deadlineMs;
  const lifecycle = opts.lifecycle ?? (() => ({
    worldId: opts.request.worldId, dim: opts.request.dim, sessionId: opts.request.sessionId,
    alive: true, connected: true, observationReady: true,
  }));
  // 本次运行自己的取消通道：先让库写入 lifecycle 原因，再唤醒本运行的帧等待。
  // 只中止这个运行态 signal，绝不 abort 父任务 signal。
  const runAbort = new AbortController();
  const cancelRun = (by: 'lifecycle' | 'agent' | 'scheduler', reason: string) => {
    loop.cancel(by, reason);
    runAbort.abort();
  };
  const executor = new WalkMoveExecutor(opts.body, opts.tick, opts.signal, now, lifecycle, (detail) => {
    cancelRun('lifecycle', detail);
  }, runAbort.signal, opts.onMoveRequest);
  const loop = new WalkRouteExecutor(opts.map, executor, { now });
  let sequence = 0; // 委托内单调递增，跨段不重置

  // 父任务取消贯通到库执行与身体执行：取消所属段、释放控制，不启动下一段。
  const onParentAbort = () => { loop.cancel('agent', 'parent task cancelled'); };
  opts.signal.addEventListener('abort', onParentAbort, { once: true });

  // 生命周期失效或作用域偏离时立即以 lifecycle 取消本委托：保留已测位移、释放当前控制，不再启动下一段。
  const cancelBrokenLifecycle = () => {
    const lc = lifecycle();
    if (!lifecycleBroken(lc) && !scopeMismatch(lc, opts.request)) return false;
    cancelRun('lifecycle', `alive=${lc.alive} connected=${lc.connected} observationReady=${lc.observationReady} scope=${lc.worldId}/${lc.dim}/${lc.sessionId}`);
    return true;
  };

  let unbindActive: (() => void) | null = null;
  try {
    const startRequest: WalkRouteRequest = { ...opts.request, deadlineMs: deadline };
    if (opts.starter) {
      const start = opts.starter(loop, startRequest);
      if (start.kind === 'REJECTED') {
        // 拒绝发生在 executor.start 之前：不附着活动 loop、不订阅帧、不写控制。
        // 原 reason 保留在结构化 problem 中，message 原样带回；不改写成世界事实。
        return {
          outcome: 'FAILED',
          message: start.message,
          problem: { kind: 'unavailable', detail: `known walk route rejected: ${start.reason}` },
          confirmed: false,
          trace: [],
        };
      }
    } else {
      loop.start(startRequest);
    }
    unbindActive = opts.bindActive?.({
      observe: (report, budget) => { loop.observe(report, budget); },
      cancel: (by, reason) => { cancelRun(by, reason); },
      status: () => loop.status(),
    }) ?? null;
    const executionId = loop.status()!.delegationId;

    // 统一帧处理顺序：本轮合法观测先进入地图并复验，再让身体样本确认到达。
    const observeThenSample = (entity: WalkBody['entity']) => {
      const report = opts.observe?.();
      if (report) loop.observe(report, 64);
      loop.onSample(bodySample(executionId, entity, now(), ++sequence, lifecycle()));
    };
    executor.setFrameSink(observeThenSample);

    // 初始实测位置：bodyArrival 需要多帧确认身体稳定在起点，advance 才会启动首段。
    // 固定 8 帧不能代表起点已稳定（采样间隔不均会重置稳定窗口，停止取样后没人再喂样本，
    // 身体执行未启动、库又等稳定样本，只能原地等到超时）。因此持续采样直到 advance 启动首段、
    // 产生终态、取消或到期，再交给下面的行走循环。
    let initFrames = 0;
    let frameEnded = false;
    while (loop.status()!.result === null && loop.status()!.activeStepIndex === null && now() < deadline && !opts.signal.aborted && !runAbort.signal.aborted && initFrames < 400) {
      const entity = await awaitFrame(opts.tick, deadline, now, opts.signal, runAbort.signal);
      if (entity === null) {
        // 无帧：先区分本运行取消（已由 loop.cancel 写入 lifecycle/共享取消原因）、
        // 父取消/期限耗尽/生命周期失效；三者之外即「帧源结束但仍连接」。
        // null 不是重试授权——继续重试会在微任务队列上空转，饿死定时器与取消信号。
        if (runAbort.signal.aborted || opts.signal.aborted) break;
        if (now() >= deadline) break;
        if (cancelBrokenLifecycle()) break;
        frameEnded = true;
        break;
      }
      observeThenSample(entity);
      // 每处理一个样本后立即检查终态/取消；首帧就失效时不继续订阅下一帧。
      if (opts.signal.aborted || loop.status()!.result !== null) break;
      if (cancelBrokenLifecycle()) break;
      loop.advance(64);
      loop.checkTimeout();
      initFrames++;
    }

    if (!frameEnded) {
      let iterations = 0;
      while (loop.status()!.result === null && now() < deadline && !opts.signal.aborted && !runAbort.signal.aborted && iterations++ < 20000) {
        if (cancelBrokenLifecycle()) break;
        loop.advance(64);
        loop.checkTimeout();
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    // 退出时若仍无终态：主动取消返回 CANCELLED，期限耗尽返回 TIMEOUT，两者分别反馈，保留已测位移。
    let result = loop.status()!.result;
    if (result === null) {
      if (frameEnded) {
        // 生命周期仍有效却无帧可交付：这是执行失败，不是超时，也不是生命周期取消。
        // 保留已测末位（若有），不伪造 TIMEOUT/CANCELLED。
        const lastPosition = loop.status()!.lastPosition;
        result = {
          outcome: 'FAILED',
          message: 'the body stopped producing physics frames while still connected',
          problem: { kind: 'execution_failed', detail: 'no physics frame delivered while connected' },
          confirmed: false,
          trace: [],
          ...(lastPosition !== null ? { lastPosition: { ...lastPosition } } : {}),
        };
      } else if (opts.signal.aborted) {
        result = loop.cancel('agent', 'parent task cancelled');
      } else {
        loop.checkTimeout(); // 期限耗尽 → guard 判定 TIMEOUT
        result = loop.status()!.result;
        if (result === null) result = loop.cancel('scheduler', 'host deadline exceeded');
      }
    }
    return result;
  } finally {
    unbindActive?.();
    opts.signal.removeEventListener('abort', onParentAbort);
    // 异常路径也不得把活动移动的控制留在身体上；正常返回时 result 已非 null，这里为空操作。
    const status = loop.status();
    if (status !== null && status.result === null) cancelRun('scheduler', 'host walk-route error');
  }
}

export { GROUNDED_ARRIVAL_DEFAULTS };
