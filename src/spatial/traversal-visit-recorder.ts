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
 *
 * 离地连续性按相邻采样判断，不按“最后一个落地位置”到落点的累计位移：真实长
 * 下落（即使累计超过 24 格）只要相邻采样仍符合下落速度就保留落地到访。水平
 * 瞬移会被识别；纯竖直且快于重力上限的瞬移也会被拒绝，但在物理下落速度以内
 * 的竖直瞬移与真实下落仅凭位置无法区分，这是采样式感知的能力边界。
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
/** Minecraft 终端下落约 3.92 格/tick（50ms），折算为毫秒；用于相邻样本的物理上限。 */
const FALL_BLOCKS_PER_MS = 3.92 / 50;
/** 相邻下落样本的保底允许量：覆盖 1ms 测试时钟、零间隔样本和采样抖动。 */
const MIN_FALL_STEP = 4;
/** 速度估算与采样延迟的余量。 */
const FALL_STEP_MARGIN = 1;

const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 两次观测之间算“身体走过”的位移；和旧通道追踪同一口径，避免把瞬移接成一条路。 */
const observedStep = (a: Vec3Like, b: Vec3Like): boolean => {
  const d = d3(a, b), dy = Math.abs(a.y - b.y);
  return d > 0 && ((d <= 3.5 && dy <= 2) || (d <= 10 && dy <= 1));
};

/**
 * 相邻离地样本是否仍像同一次下落：水平不横移，竖直不上升超过跳跃量级，
 * 向下不超过按实际采样间隔折算的终端下落速度上限。
 */
const airborneStep = (a: Vec3Like, b: Vec3Like, elapsedMs: number): boolean => {
  if (Math.hypot(b.x - a.x, b.z - a.z) > FALL_HORIZONTAL) return false;
  const drop = a.y - b.y;
  if (drop < -2) return false;
  const maxDrop = Math.max(MIN_FALL_STEP, FALL_BLOCKS_PER_MS * Math.max(0, elapsedMs) + FALL_STEP_MARGIN);
  return drop <= maxDrop;
};

const cellOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellKey = (dim: string, cell: Vec3Like) => `${dim}:${cell.x},${cell.y},${cell.z}`;

export class TraversalVisitRecorder {
  /** `at` 是本条实测观测时间，用于按真实采样间隔折算下落速度上限。 */
  private last: { worldId: string; dim: string; sessionId: string; pos: Vec3Like; at: number } | null = null;
  /**
   * 当前是否处于一次离地序列。离地期间不标记；落地帧只检查与紧邻样本的
   * 连续性，而不是从最后一个落地位置累计的总位移。
   */
  private airborne = false;
  /** 本次离地序列是否已经出现不连续样本；一旦断开，落地帧不能标记。 */
  private airborneBroken = false;
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
    const at = this.now();
    const previous = this.last;
    if (previous === null) {
      // 起始站位本身不算一次“走到”；等下一次确认位移再标记落点。
      this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
      if (observation.onGround === false) {
        this.airborne = true;
        this.airborneBroken = false;
      }
      return;
    }
    const sameScope = previous.worldId === worldId && previous.dim === dim && previous.sessionId === sessionId;
    // 游泳、岩浆、骑乘或换作用域都不是普通步行；结束当前段，不携带旧段位置。
    if (!sameScope || observation.inWater || observation.inLava || observation.riding) {
      this.airborne = false;
      this.airborneBroken = false;
      this.lastMarkedCell = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
      return;
    }
    if (observation.onGround === undefined) {
      // 不知道是否着地时不能推断下落；按普通步行口径处理，并结束此前离地状态。
      this.airborne = false;
      this.airborneBroken = false;
    } else if (observation.onGround === false) {
      // 离地期间的位置不是到访；按紧邻样本判断这一段是否仍可能是同一次下落。
      const continuous = airborneStep(previous.pos, pos, at - previous.at);
      if (!this.airborne) {
        this.airborne = true;
        this.airborneBroken = !continuous;
      } else if (!continuous) {
        this.airborneBroken = true;
      }
      this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
      return;
    } else if (this.airborne) {
      // 落地帧：只检查与紧邻样本的连续性；累计位移不再参与瞬移判断。
      const continuous = !this.airborneBroken && airborneStep(previous.pos, pos, at - previous.at);
      this.airborne = false;
      this.airborneBroken = false;
      this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
      if (!continuous) {
        // 下落期间发生瞬移/远距横移/超重力下落：不能把目的地当作这次下落的落点。
        this.lastMarkedCell = null;
        return;
      }
      const horizontal = Math.hypot(pos.x - previous.pos.x, pos.z - previous.pos.z);
      const fell = previous.pos.y - pos.y > 2 && horizontal <= FALL_HORIZONTAL;
      if (fell || observedStep(previous.pos, pos)) this.mark(dim, pos);
      return;
    }
    const moved = d3(previous.pos, pos);
    if (moved === 0) return;
    if (moved > TELEPORT || !observedStep(previous.pos, pos)) {
      // 瞬移或相邻观测之间的位移超出步行口径；不插值、不标记中间格。
      this.lastMarkedCell = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
      return;
    }
    this.mark(dim, pos);
    this.last = { worldId, dim, sessionId, pos: { ...pos }, at };
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
