import type { Vec3Like } from '../adapter/types.ts';
import type { SharedSpatialSession } from './shared-session.ts';

/**
 * 普通移动的实测到访记录器。
 *
 * v0.11 起普通移动只把“实际确认站过的格”写进 VoxelMap 的到访位，不再生成
 * Fragment、traversal、拓扑节点或路线边。历史几何的显式兼容写入仍由
 * `TraversalRecorder` / `SharedSpatialSession.recordWalkCorridor` 提供，但不属于
 * 普通感知/移动流程。
 *
 * 与旧 recorder 相同的边界：不记录瞬移、断线/换维/换会话、水里/岩浆/骑乘位移，
 * 不把计划点或采样间隔内的中间格插值成到访。一次确认观测只标记实测脚位所在的
 * 整数格；较大下落只标记落地帧，不标记空中位置。
 */

/** 一次实测身体观测；只接收已经确认连接、存活、观测就绪的位置。 */
export interface TraversalVisitObservation {
  worldId: string;
  dim: string;
  sessionId: string;
  pos: Vec3Like;
  /** 水里/岩浆里/骑乘时的位移不是普通步行，不标记为走到。 */
  inWater?: boolean;
  inLava?: boolean;
  riding?: boolean;
  /** 用于区分较大下落的落地帧；不写按未知处理，不推断下落。 */
  onGround?: boolean;
}

/** 到访位写入的真实结局；rejected/failed 都不表示格子已被标记。 */
export type TraversalVisitOutcome =
  | { status: 'written'; deliveryError: { committed: true; error: unknown } | null }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; message: string };

/** 一次确认到访的写入回执；只描述实际标记的格，不含插值路径。 */
export interface TraversalVisitReceipt {
  /** 本次 recorder 生命周期内单调递增的回执序号。 */
  sequence: number;
  dim: string;
  /** 实际标记的整数格。 */
  cell: Vec3Like;
  /** 触发标记的实测脚位；同格内抖动不会产生第二个记录点。 */
  measured: Vec3Like;
  observedAt: number;
  outcome: TraversalVisitOutcome;
}

/** 回执有界保留条数；只用于证据链观察，不累积长期历史。 */
export const MAX_TRAVERSAL_VISIT_RECEIPTS = 16;

const TELEPORT = 24;
/** 较大下落：竖直下降超过普通步行，水平偏移不超过这个距离才当作同一次掉落。 */
const FALL_HORIZONTAL = 4;

const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 两次观测之间算“身体走过”的位移；和旧通道追踪同一口径，避免把瞬移接成一条路。 */
const observedStep = (a: Vec3Like, b: Vec3Like): boolean => {
  const d = d3(a, b), dy = Math.abs(a.y - b.y);
  return d > 0 && ((d <= 3.5 && dy <= 2) || (d <= 10 && dy <= 1));
};

const cellOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellKey = (dim: string, cell: Vec3Like) => `${dim}:${cell.x},${cell.y},${cell.z}`;

export class TraversalVisitRecorder {
  private last: { worldId: string; dim: string; sessionId: string; pos: Vec3Like } | null = null;
  /**
   * 离开地面时最后一个已落地观测位置。离地期间不标记；落地帧必须先从
   * 这个位置检查连续位移，瞬移不能借“落地”绕过。
   */
  private airborneFrom: Vec3Like | null = null;
  /** 上一个已标记的格；连续观测停在同一格时不重复写/发回执。 */
  private lastMarkedCell: string | null = null;
  private readonly receiptsLog: TraversalVisitReceipt[] = [];
  private receiptSequence = 0;

  constructor(
    private readonly sink: Pick<SharedSpatialSession, 'markTraversed'> | undefined,
    private readonly now: () => number = Date.now,
    private readonly onFailure?: (message: string) => void,
  ) {}

  observe(observation: TraversalVisitObservation): void {
    if (this.sink === undefined) return;
    const { worldId, dim, sessionId, pos } = observation;
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) return;
    const previous = this.last;
    if (previous === null) {
      // 起始站位本身不算一次“走到”；等下一次确认位移再标记落点。
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      if (observation.onGround === false) this.airborneFrom = { ...pos };
      return;
    }
    const sameScope = previous.worldId === worldId && previous.dim === dim && previous.sessionId === sessionId;
    // 游泳、岩浆、骑乘或换作用域都不是普通步行；结束当前段，不携带旧段位置。
    if (!sameScope || observation.inWater || observation.inLava || observation.riding) {
      this.airborneFrom = null;
      this.lastMarkedCell = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      return;
    }
    if (observation.onGround === undefined) {
      // 不知道是否着地时不能推断下落；按普通步行口径处理，并结束此前离地状态。
      this.airborneFrom = null;
    } else if (observation.onGround === false) {
      // 离地期间的位置不是到访；记住最后一个已落地位置，落地帧再检查连续性。
      this.airborneFrom ??= { ...previous.pos };
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      return;
    } else if (this.airborneFrom !== null) {
      // 落地帧：先从最后一个已落地位置检查位移是否连续，再决定是否标记。
      const from = this.airborneFrom;
      this.airborneFrom = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      const moved = d3(from, pos);
      const horizontal = Math.hypot(pos.x - from.x, pos.z - from.z);
      if (moved > TELEPORT || horizontal > FALL_HORIZONTAL) {
        // 下落期间发生瞬移/远距横移：不能把目的地当作这次下落的落点。
        this.lastMarkedCell = null;
        return;
      }
      const fell = from.y - pos.y > 2 && horizontal <= FALL_HORIZONTAL;
      if (fell || observedStep(from, pos)) this.mark(dim, pos);
      return;
    }
    const moved = d3(previous.pos, pos);
    if (moved === 0) return;
    if (moved > TELEPORT || !observedStep(previous.pos, pos)) {
      // 瞬移或相邻观测之间的位移超出步行口径；不插值、不标记中间格。
      this.lastMarkedCell = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      return;
    }
    this.mark(dim, pos);
    this.last = { worldId, dim, sessionId, pos: { ...pos } };
  }

  /** 最近的有界到访回执（旧→新）。只报告已发生的写入，不触发重试。 */
  receipts(limit = MAX_TRAVERSAL_VISIT_RECEIPTS): readonly TraversalVisitReceipt[] {
    return this.receiptsLog.slice(Math.max(0, this.receiptsLog.length - Math.max(0, limit)));
  }

  private mark(dim: string, pos: Vec3Like): void {
    const cell = cellOf(pos);
    const key = cellKey(dim, cell);
    if (key === this.lastMarkedCell) return;
    this.lastMarkedCell = key;
    const observedAt = this.now();
    let outcome: TraversalVisitOutcome;
    try {
      const result = this.sink!.markTraversed(dim, cell);
      outcome = result.status === 'written'
        ? { status: 'written', deliveryError: result.deliveryError }
        : { status: 'rejected', reason: result.reason.detail };
    } catch (error) {
      outcome = { status: 'failed', message: `实测到访写入异常：${(error as Error)?.message ?? String(error)}` };
    }
    const receipt: TraversalVisitReceipt = {
      sequence: this.receiptSequence += 1,
      dim,
      cell: { ...cell },
      measured: { ...pos },
      observedAt,
      outcome,
    };
    this.receiptsLog.push(receipt);
    if (this.receiptsLog.length > MAX_TRAVERSAL_VISIT_RECEIPTS) {
      this.receiptsLog.splice(0, this.receiptsLog.length - MAX_TRAVERSAL_VISIT_RECEIPTS);
    }
    if (outcome.status === 'failed') this.onFailure?.(outcome.message);
  }
}
