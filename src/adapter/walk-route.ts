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
const DRY_FULL = new Set(['minecraft:stone', 'minecraft:grass_block', 'minecraft:dirt', 'minecraft:cobblestone', 'minecraft:sand']);
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'air']);

/** 版本明确的碰撞形状提供器：只接普通干燥整块；未知形状返回能力缺口，不猜。 */
export const walkCollisionProvider: CollisionShapeProvider = {
  version: 'curio-1.20.1-dry-full-v1',
  resolve(state, _cell, _read) {
    if (AIR.has(state.name)) return { kind: 'shape', shape: EMPTY };
    if (DRY_FULL.has(state.name)) return { kind: 'shape', shape: FULL_CUBE };
    return { kind: 'unsupported_shape', block: serializeBlockState(state), detail: `未接入的形状：${state.name}` };
  },
};

/** 身体桥需要的最小接口：只控制前向与朝向、可读取实体状态。 */
export interface WalkBody {
  setControlState(name: string, value: boolean): void;
  clearControlStates(): void;
  look(yaw: number, pitch: number): void;
  entity: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    onGround: boolean;
    isInWater: boolean;
  };
}

/** 一次物理帧推进：离线夹具同步推进 prismarine-physics；生产由 physicsTick 驱动（异步）。 */
export interface WalkTick {
  (): WalkBody['entity'] | Promise<WalkBody['entity']>;
}

/** 实际适配器的存活/连接/观测就绪状态；不从请求复制后冒充观测。 */
export interface WalkLifecycle {
  alive: boolean;
  connected: boolean;
  observationReady: boolean;
}

/** 从实体状态构造一个 BodySample；速度单位为格/tick。 */
export function bodySample(
  scope: { worldId: string; dim: string; sessionId: string; executionId: string },
  entity: WalkBody['entity'],
  observedAt: number,
  sequence: number,
  lifecycle: WalkLifecycle,
): BodySample {
  return {
    worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId, executionId: scope.executionId,
    pos: { ...entity.position }, velocity: { ...entity.velocity }, observedAt, sequence,
    alive: lifecycle.alive, connected: lifecycle.connected, observationReady: lifecycle.observationReady,
    onGround: entity.onGround, inWater: entity.isInWater,
  };
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
    private readonly now: () => number = Date.now,
  ) {}

  /** 宿主在帧回调里构造样本（掌握单调序号与生命周期），再喂给库。 */
  setFrameSink(fn: (entity: WalkBody['entity']) => void) { this.frameSink = fn; }

  async move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const { from, to } = request;
    // 控制前先检查取消与期限：已取消的请求不得写任何控制。
    if (request.signal.aborted) return { failure: { kind: 'cancelled' } };
    if (this.now() >= request.deadlineMs) return { failure: { kind: 'timed_out' } };
    this.body.look(Math.atan2(-(to.x - from.x), -(to.z - from.z)), 0);
    // 转头后重新检查所有权/取消：转头等待期间可能被抢占。
    if (request.signal.aborted) return { failure: { kind: 'cancelled' } };
    this.body.clearControlStates();
    this.body.setControlState('forward', true);
    this.activeExecutionId = request.executionId;
    const GROUND_STOP = 1 / (1 - 0.546); // 地面摩擦每 tick 衰减到约 0.546 倍
    let braked = false;
    for (let i = 0; i < 400; i++) {
      if (request.signal.aborted) { this.releaseIf(request.executionId); return { failure: { kind: 'cancelled' } }; }
      if (this.now() >= request.deadlineMs) { this.releaseIf(request.executionId); return { failure: { kind: 'timed_out' } }; }
      const e = await this.tick();
      const dist = Math.hypot(to.x - e.position.x, to.z - e.position.z);
      const speed = Math.hypot(e.velocity.x, e.velocity.z);
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
 * 序号与生命周期，并在到达确认前先处理世界观测。
 */
export async function runWalkRoute(opts: {
  map: VoxelMap;
  body: WalkBody;
  request: WalkRouteRequest;
  tick: WalkTick;
  lifecycle?: () => WalkLifecycle;
  observe?: () => ChangeReport | null;
  deadlineMs?: number;
  now?: () => number;
}): Promise<NavResult> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadlineMs ?? opts.request.deadlineMs;
  const lifecycle = opts.lifecycle ?? (() => ({ alive: true, connected: true, observationReady: true }));
  const executor = new WalkMoveExecutor(opts.body, opts.tick, now);
  const loop = new WalkRouteExecutor(opts.map, executor, { now });
  let sequence = 0; // 委托内单调递增，跨段不重置
  const scope = { worldId: opts.request.worldId, dim: opts.request.dim, sessionId: opts.request.sessionId, executionId: '' };

  // 统一有效期限：宿主期限与库执行期限一致，避免宿主到期后库仍继续执行。
  loop.start({ ...opts.request, deadlineMs: deadline });
  scope.executionId = loop.status()!.delegationId;

  // 统一帧处理顺序：本轮合法观测先进入地图并复验，再让身体样本确认到达。
  const observeThenSample = (entity: WalkBody['entity']) => {
    const report = opts.observe?.();
    if (report) loop.observe(report, 64);
    loop.onSample(bodySample(scope, entity, now(), ++sequence, lifecycle()));
  };
  executor.setFrameSink(observeThenSample);

  // 初始实测位置：bodyArrival 需要多帧确认身体稳定在起点，advance 才会启动首段。
  for (let i = 0; i < 8; i++) observeThenSample(await opts.tick());

  let iterations = 0;
  while (loop.status()!.result === null && now() < deadline && iterations++ < 20000) {
    loop.advance(64);
    loop.checkTimeout();
    await new Promise((r) => setTimeout(r, 10));
  }
  // 退出时若仍无终态：取消所属库执行与身体执行、释放控制，保留已测位移后返回。
  let result = loop.status()!.result;
  if (result === null) result = loop.cancel('scheduler', 'host deadline exceeded');
  return result;
}

export { GROUNDED_ARRIVAL_DEFAULTS };
