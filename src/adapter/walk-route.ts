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
  MoveExecutor,
  NavResult,
  WalkRouteRequest,
} from 'curio-minecraft-3d-memory';

const EMPTY: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const DRY_FULL = new Set(['stone', 'grass_block', 'dirt', 'cobblestone', 'sand']);
const AIR = new Set(['air', 'cave_air', 'void_air']);

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
async function awaitFrame(
  tick: WalkTick,
  deadlineMs: number,
  now: () => number,
  ...signals: AbortSignal[]
): Promise<WalkBody['entity'] | null> {
  for (const s of signals) if (s.aborted) return null;
  if (now() >= deadlineMs) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
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

  constructor(
    private readonly body: WalkBody,
    private readonly tick: WalkTick,
    private readonly parentSignal: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}

  /** 宿主在帧回调里构造样本（掌握单调序号与生命周期），再喂给库。 */
  setFrameSink(fn: (entity: WalkBody['entity']) => void) { this.frameSink = fn; }

  private aborted(request: ExecutableMove): boolean {
    return request.signal.aborted || this.parentSignal.aborted;
  }

  async move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const { from, to } = request;
    // 控制前先检查取消与期限：已取消/已到期的请求不得写任何控制。
    if (this.aborted(request)) return { failure: { kind: 'cancelled' } };
    // 每段有效期限：总期限与单段 timeout 的较小者，不能靠单段拖过总期限。
    const moveDeadline = Math.min(request.deadlineMs, this.now() + request.timeoutMs);
    if (this.now() >= moveDeadline) return { failure: { kind: 'timed_out' } };

    await this.body.look(Math.atan2(-(to.x - from.x), -(to.z - from.z)), 0);
    // 转头后重新检查所有权/取消：转头等待期间可能被抢占。
    if (this.aborted(request)) return { failure: { kind: 'cancelled' } };
    this.body.clearControlStates();
    this.body.setControlState('forward', true);
    this.activeExecutionId = request.executionId;

    // 制动距离系数：真实 1.20.1 服务器上松开前进键后约再走 1.19 个 tick 的位移即停
    // （实测 coast≈0.256 格、帧间位移≈0.216 格/tick）。离线 prismarine-physics 的 0.546
    // 摩擦口径与之不符，不能直接套用。
    const GROUND_STOP = 1.2;
    let braked = false;
    let prevPos: { x: number; z: number } | null = null;
    for (let i = 0; i < 400; i++) {
      if (this.aborted(request)) { this.releaseIf(request.executionId); return { failure: { kind: 'cancelled' } }; }
      if (this.now() >= moveDeadline) { this.releaseIf(request.executionId); return { failure: { kind: 'timed_out' } }; }
      const e = await awaitFrame(this.tick, moveDeadline, this.now, request.signal, this.parentSignal);
      if (e === null) {
        // 无帧：复核取消/期限后再决定终态，不把断线误判为普通成功。
        if (this.aborted(request)) { this.releaseIf(request.executionId); return { failure: { kind: 'cancelled' } }; }
        if (this.now() >= moveDeadline) { this.releaseIf(request.executionId); return { failure: { kind: 'timed_out' } }; }
        this.releaseIf(request.executionId);
        return { failure: { kind: 'execution_error', detail: 'no physics frame available' } };
      }
      const dist = Math.hypot(to.x - e.position.x, to.z - e.position.z);
      // 用实际帧间位移估计速度：真实适配器 entity.velocity 约为每 tick 实际位移的 0.546 倍
      // （服务器上报的是摩擦后的速度），直接用它会让制动距离少算一半而冲过目标。首帧没有前值，
      // 退回到 velocity 作为启动近似。
      const speed = prevPos === null
        ? Math.hypot(e.velocity.x, e.velocity.z)
        : Math.hypot(e.position.x - prevPos.x, e.position.z - prevPos.z);
      prevPos = { x: e.position.x, z: e.position.z };
      if (!braked && dist <= speed * GROUND_STOP) { this.body.setControlState('forward', false); braked = true; }
      this.frameSink?.(e);
      // 让出事件循环：库的 onSample 确认到达 → stop/abort，及其 move 结果微任务得以执行。
      await new Promise((r) => setImmediate(r));
    }
    this.releaseIf(request.executionId);
    return { failure: { kind: 'timed_out' } };
  }

  stop(executionId: string): void {
    if (executionId !== this.activeExecutionId) return; // 旧段不能清理新段的控制
    this.body.setControlState('forward', false);
    this.body.clearControlStates();
  }

  private releaseIf(executionId: string): void {
    // 归属检查必须同时保护松键与清空归属：旧段的迟到收尾不能清掉新段的归属。
    if (executionId !== this.activeExecutionId) return;
    this.body.setControlState('forward', false);
    this.activeExecutionId = null;
  }
}

/**
 * 驱动一个已选短路线，直到终态。MoveExecutor 在 advance 里自驱单段，宿主负责采样、
 * 序号与生命周期，并在到达确认前先处理世界观测。父任务取消经 `signal` 贯通到库取消。
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
}): Promise<NavResult> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadlineMs ?? opts.request.deadlineMs;
  const lifecycle = opts.lifecycle ?? (() => ({
    worldId: opts.request.worldId, dim: opts.request.dim, sessionId: opts.request.sessionId,
    alive: true, connected: true, observationReady: true,
  }));
  const executor = new WalkMoveExecutor(opts.body, opts.tick, opts.signal, now);
  const loop = new WalkRouteExecutor(opts.map, executor, { now });
  let sequence = 0; // 委托内单调递增，跨段不重置

  // 父任务取消贯通到库执行与身体执行：取消所属段、释放控制，不启动下一段。
  const onParentAbort = () => { loop.cancel('agent', 'parent task cancelled'); };
  opts.signal.addEventListener('abort', onParentAbort, { once: true });

  loop.start({ ...opts.request, deadlineMs: deadline });
  const executionId = loop.status()!.delegationId;

  // 统一帧处理顺序：本轮合法观测先进入地图并复验，再让身体样本确认到达。
  const observeThenSample = (entity: WalkBody['entity']) => {
    const report = opts.observe?.();
    if (report) loop.observe(report, 64);
    loop.onSample(bodySample(executionId, entity, now(), ++sequence, lifecycle()));
  };
  executor.setFrameSink(observeThenSample);

  // 初始实测位置：bodyArrival 需要多帧确认身体稳定在起点，advance 才会启动首段。
  // 初始采样与行走采样使用同一套期限和生命周期约束，不在期限检查循环之前无限等待。
  if (loop.status()!.result === null) {
    for (let i = 0; i < 8; i++) {
      const entity = await awaitFrame(opts.tick, deadline, now, opts.signal);
      if (entity === null) break;
      observeThenSample(entity);
      if (opts.signal.aborted) break;
    }
  }

  let iterations = 0;
  while (loop.status()!.result === null && now() < deadline && !opts.signal.aborted && iterations++ < 20000) {
    loop.advance(64);
    loop.checkTimeout();
    await new Promise((r) => setTimeout(r, 10));
  }
  // 退出时若仍无终态：区分父任务取消与宿主期限到期，保留已测位移后返回。
  let result = loop.status()!.result;
  if (result === null) {
    result = opts.signal.aborted
      ? loop.cancel('agent', 'parent task cancelled')
      : loop.cancel('scheduler', 'host deadline exceeded');
  }
  opts.signal.removeEventListener('abort', onParentAbort);
  return result;
}

export { GROUNDED_ARRIVAL_DEFAULTS };
