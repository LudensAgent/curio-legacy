/**
 * 最小步行闭环的身体桥与路线入口（离线接线）。
 *
 * 只接普通干燥整块、同高、沿 X/Z 的短路线；不含挖掘、放置、跳跃、绕路、水面、飞行。
 * MoveExecutor 只执行库已选定的单段，不转发给会自行寻路的 moveTo。
 * 制动沿用 finishAdjacentStep 的思路（按地面摩擦估算制动距离、到点松键），
 * 到达语义由库的 WalkRouteExecutor（显式 bodyArrival）用连续坐标 + 速度 + 稳定帧判定。
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

/** 一次物理帧推进：推进物理、返回最新实体状态（并推进模拟时钟）。 */
export interface WalkTick {
  (): WalkBody['entity'];
}

/** 从实体状态构造一个 BodySample；速度单位为格/tick。 */
export function bodySample(
  scope: { worldId: string; dim: string; sessionId: string; executionId: string },
  entity: WalkBody['entity'],
  observedAt: number,
  sequence: number,
): BodySample {
  return {
    worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId, executionId: scope.executionId,
    pos: { ...entity.position }, velocity: { ...entity.velocity }, observedAt, sequence,
    alive: true, connected: true, observationReady: true,
    onGround: entity.onGround, inWater: entity.isInWater,
  };
}

/**
 * 库 MoveExecutor 的窄身体桥：朝向目标向量 + 前向推进，按地面摩擦估算制动距离、到点松键，
 * 让身体靠摩擦停稳；再持续采样推给库，由库的 bodyArrival 判定到达并 stop/abort。
 */
export class WalkMoveExecutor implements MoveExecutor {
  private sampleSink: ((sample: BodySample) => void) | null = null;
  private delegationId: string | null = null;

  constructor(
    private readonly body: WalkBody,
    private readonly tick: WalkTick,
    private readonly now: () => number = Date.now,
  ) {}

  setSampleSink(fn: (sample: BodySample) => void) { this.sampleSink = fn; }
  /** 宿主推送的样本按库约定用 delegationId 作为执行归属，而非单段的 executionId。 */
  setDelegationId(id: string) { this.delegationId = id; }

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const { from, to } = request;
    this.body.look(Math.atan2(-(to.x - from.x), -(to.z - from.z)), 0);
    this.body.clearControlStates();
    this.body.setControlState('forward', true);
    const GROUND_STOP = 1 / (1 - 0.546); // 地面摩擦每 tick 衰减到约 0.546 倍
    let braked = false;
    let sequence = 0;
    const scope = { worldId: request.worldId, dim: request.dim, sessionId: request.sessionId, executionId: this.delegationId ?? request.executionId };
    // 同步驱动该段：采样推给库，库在 onSample 里确认到达 → stop/abort 并 recordArrival。
    // 这里的返回结果对库是 fire-and-forget（stopActive 已清 activeExecutionId），只用于超时兜底。
    for (let i = 0; i < 400; i++) {
      if (request.signal.aborted) { this.body.setControlState('forward', false); return Promise.resolve({ failure: { kind: 'cancelled' } }); }
      if (this.now() >= request.deadlineMs) { this.body.setControlState('forward', false); return Promise.resolve({ failure: { kind: 'timed_out' } }); }
      const e = this.tick();
      const dist = Math.hypot(to.x - e.position.x, to.z - e.position.z);
      const speed = Math.hypot(e.velocity.x, e.velocity.z);
      if (!braked && dist <= speed * GROUND_STOP) { this.body.setControlState('forward', false); braked = true; }
      this.sampleSink?.(bodySample(scope, e, this.now(), ++sequence));
    }
    this.body.setControlState('forward', false);
    return Promise.resolve({ failure: { kind: 'timed_out' } });
  }

  stop(executionId: string): void {
    this.body.setControlState('forward', false);
    this.body.clearControlStates();
  }
}

/**
 * 驱动一个已选短路线，直到终态。MoveExecutor 在 advance 里自驱单段（制动 + 采样 + 推库），
 * 本函数只负责推进库的验证/复验/取消归属，并在到达确认前先处理世界观测。
 */
export async function runWalkRoute(opts: {
  map: VoxelMap;
  body: WalkBody;
  request: WalkRouteRequest;
  tick: WalkTick;
  observe?: () => ChangeReport | null;
  deadlineMs?: number;
  now?: () => number;
}): Promise<NavResult> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadlineMs ?? opts.request.deadlineMs;
  const executor = new WalkMoveExecutor(opts.body, opts.tick, now);
  const loop = new WalkRouteExecutor(opts.map, executor, { now });
  executor.setSampleSink((sample) => loop.onSample(sample));

  loop.start(opts.request);
  executor.setDelegationId(loop.status()!.delegationId);
  // 初始实测位置：bodyArrival 需要多帧确认身体稳定在起点（stableMs + onGround），advance 才会启动首段。
  {
    const scope = { worldId: opts.request.worldId, dim: opts.request.dim, sessionId: opts.request.sessionId, executionId: loop.status()!.delegationId };
    for (let i = 0; i < 8; i++) loop.onSample(bodySample(scope, opts.tick(), now(), i + 1));
  }
  let iterations = 0;
  while (loop.status()!.result === null && now() < deadline && iterations++ < 2000) {
    loop.advance(64);
    // 先处理本轮世界观测，再允许身体样本确认到达。
    const report = opts.observe?.();
    if (report) loop.observe(report, 64);
    loop.checkTimeout();
    await new Promise((r) => setImmediate(r));
  }
  return loop.status()!.result ?? { outcome: 'FAILED', message: 'no route result', problem: { kind: 'execution_failed', detail: 'loop ended without a terminal result' }, confirmed: false, trace: [] };
}
