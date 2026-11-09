import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import type { SharedSpatialSession, WalkCorridorSegment, WalkMemoryOutcome } from './shared-session.ts';

/** 一次实测身体观测；只接收已经确认连接、存活、观测就绪的位置。 */
export interface TraversalObservation {
  worldId: string;
  dim: string;
  sessionId: string;
  pos: Vec3Like;
  /** 水里/岩浆里/骑乘时的位移不是普通步行，记录不声明为 walk。 */
  inWater?: boolean;
  inLava?: boolean;
  riding?: boolean;
  /** 是否站在地面上；用于判断一次下落在哪里落地。不写按未知处理，不记录下落。 */
  onGround?: boolean;
  /** 本次观测前实际挖掉的格子（由适配器 recentDug 提供）。 */
  dug?: readonly { pos: Vec3Like; name: string; ts: number }[];
  /** 该位置脚下是否是自放的方块；只用于给 fragment 标来源，不参与导航。 */
  onPlacedSupport?: (pos: Vec3Like) => boolean;
}

type TraversalKind = PathFragment['kind'];

/** 共享写入入口一条通道最多 8 节点；每次 flush 不超过这个上限，长走拆成多段由同格拓扑节点接上。 */
const MAX_POINTS = 8;
const TELEPORT = 24;
const RECORD_STEP = 1;
const BRIDGE_SUPPORT_RATIO = 0.5;
/** dug 只是来源标签：挖空证据距实测路径超过这个距离时，与本次行走无关。 */
const DUG_PROXIMITY = 6;
/**
 * 这么久没有新的已确认记录点，说明这段位移已经结束。观测间隔约 0.7s；
 * 主动落盘短段，否则一次短距离步行会一直留在内存里，直到下次断点或进程退出才写入。
 */
const IDLE_FLUSH_MS = 3000;
/** 下落：两次观测间竖直下降超过普通步行（dy>2），水平偏移不超过这个距离才当作同一次掉落。 */
const FALL_HORIZONTAL = 4;

/**
 * 回执有界保留条数。回执只用于证据链观察/报告已发生的写入，旧回执被淘汰；
 * 不累积长期历史，也不替代共享空间库本身。
 */
export const MAX_TRAVERSAL_RECEIPTS = 16;

/**
 * sink 在调用边界抛出（而不是返回结构化失败）时的 recorder 侧结局。
 * 它不属于 `WalkMemoryOutcome`：库/共享会话从未返回该阶段。抛错时无法知道库
 * 是否已经写入 traversal 或提交拓扑，因此这些字段一律是 `'unknown'`，不是
 * “空数组/未写入”的事实。
 */
export interface TraversalSinkException {
  status: 'failed';
  stage: 'sink_exception';
  message: string;
  fragmentId: string;
  /** 抛错前 sink 是否已接收 traversal 未知；'unknown' 不是空数组事实。 */
  traversalIds: 'unknown';
  /** 没有结构化结果，节点/边数与是否写入都未知。 */
  topology: { nodes: 'unknown'; edges: 'unknown'; written: 'unknown' };
}

/** 回执里的真实结局：共享会话的结构化结果，或 recorder 侧 sink 抛错。 */
export type TraversalWriteOutcome = WalkMemoryOutcome | TraversalSinkException;

/**
 * 一次已确认段的真实落盘回执：复述 `recordWalkCorridor` 的结局与本次实测段。
 * 不含计划点/插值；失败时 `outcome.traversalIds` 只保留真实写入的前缀。
 */
export interface TraversalWriteReceipt {
  /** 本次 recorder 生命周期内单调递增的回执序号。 */
  sequence: number;
  fragmentId: string;
  /** 来源标签（walked/dug/bridge）；只是来源，不是当前可通行证明。 */
  kind: TraversalKind;
  /** 本段实际确认的 segment 数。 */
  segmentCount: number;
  /** 实测段首/末（原始实测位置，不是计划点）。 */
  from: Vec3Like;
  to: Vec3Like;
  /** 末个实测记录点的真实观测时间。 */
  observedAt: number;
  /** 真实写入结局；结构化失败保留已写前缀，sink 抛错时写入状态标 unknown。 */
  outcome: TraversalWriteOutcome;
}

const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cellKey = (p: Vec3Like) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** 两次观测之间算“身体走过”的位移；和旧通道追踪同一口径，避免把瞬移接成一条路。 */
const observedStep = (a: Vec3Like, b: Vec3Like): boolean => {
  const d = d3(a, b), dy = Math.abs(a.y - b.y);
  return d > 0 && ((d <= 3.5 && dy <= 2) || (d <= 10 && dy <= 1));
};

const supportOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) });

/**
 * dug 只作 fragment 的来源标签，不证明任何几何。只有挖空证据落在本次实测路径
 * （已记录点或当前实测位置）附近时，才认为这段已走过的路涉及挖掘；远离路径的
 * 挖空证据不得把一段自然行走改标成 dug。
 */
const dugOnPath = (dug: TraversalObservation['dug'], points: readonly Vec3Like[]): boolean =>
  dug?.some((entry) => points.some((point) => d3(entry.pos, point) <= DUG_PROXIMITY)) ?? false;

/**
 * 统一的空间记忆记录器：把身体实际走过的连续位移写成共享会话的 fragment +
 * traversal + topology。walked / dug / bridge 只是路径来源标签，不决定规划或执行；
 * 规划只看几何、拓扑边和时间证据。
 *
 * 不记录瞬移、断线/换维/换会话、水里/岩浆/骑乘位移，也不把计划点当实测。
 */
export class TraversalRecorder {
  private last: { worldId: string; dim: string; sessionId: string; pos: Vec3Like } | null = null;
  private run: {
    id: string;
    worldId: string;
    dim: string;
    sessionId: string;
    startedAt: number;
    lastAt: number;
    points: Vec3Like[];
    segments: WalkCorridorSegment[];
    hasDug: boolean;
    bridgeSupports: number;
  } | null = null;
  private sequence = 0;
  /** 因 8 点上限 flush 后，把上一段末点带进下一段的 seam；瞬移/换会话/水里不携带。 */
  private pendingStart: { worldId: string; dim: string; sessionId: string; pos: Vec3Like } | null = null;
  /** 正在下落：起跳点（最后一处行走记录位置）。落地后写成一条单向 drop 段，离地期间的空中位置不记。 */
  private fall: { worldId: string; dim: string; sessionId: string; from: Vec3Like } | null = null;
  /** 有界写入回执（旧→新）；证据链只读，不重放。 */
  private readonly receiptsLog: TraversalWriteReceipt[] = [];
  private receiptSequence = 0;

  constructor(
    private readonly sink: Pick<SharedSpatialSession, 'recordWalkCorridor'> | undefined,
    private readonly now: () => number = Date.now,
    private readonly onFailure?: (message: string) => void,
  ) {}

  observe(observation: TraversalObservation): void {
    if (this.sink === undefined) return;
    const { worldId, dim, sessionId, pos } = observation;
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) return;
    const previous = this.last;
    const moved = previous === null ? Number.POSITIVE_INFINITY : d3(previous.pos, pos);
    // 站着不动不写 0 长度 segment；但停走已超过阈值时，当前段确实结束了，
    // 主动落盘并保留最后已确认记录点作为下一段的 seam，避免已确认位移只留在内存里。
    if (previous !== null && moved === 0) {
      if (this.run !== null && this.now() - this.run.lastAt >= IDLE_FLUSH_MS) this.flush(true);
      return;
    }
    // 掉落：竖直下降超过步行范围、水平基本不动。普通行走口径会把它当断点，记录图就在每个坑边断开，
    // 以后既不知道这里连着下面，也不知道原路返回要爬升。落地后单独写一条 mode:'drop' 的单向段。
    const sameScope = previous !== null && previous.worldId === worldId && previous.dim === dim && previous.sessionId === sessionId;
    const horizontal = previous === null ? Infinity : Math.hypot(pos.x - previous.pos.x, pos.z - previous.pos.z);
    if (observation.inWater || observation.inLava || observation.riding || !sameScope || observation.onGround === undefined) this.fall = null;
    else if (this.fall !== null || (previous.pos.y - pos.y > 2 && horizontal <= FALL_HORIZONTAL && moved <= TELEPORT)) {
      // 离地期间只接受继续往下的位置；落地那一帧可以与上一帧同高。悬空不降、往上或横移过远都不算这次掉落。
      const descending = (pos.y < previous.pos.y - 1e-6 || observation.onGround === true) && horizontal <= FALL_HORIZONTAL;
      if (this.fall === null || descending) {
        if (this.fall === null) {
          // 起跳点取当前行走段最后一个记录点，让 drop 段与前一段落在同一格上接起来。
          const from = this.run !== null && d3(this.run.points.at(-1)!, previous.pos) <= 1.5 ? this.run.points.at(-1)! : previous.pos;
          this.fall = { worldId, dim, sessionId, from: { ...from } };
          this.flush();
        }
        this.last = { worldId, dim, sessionId, pos: { ...pos } };
        if (observation.onGround === true) {
          const fall = this.fall;
          this.fall = null;
          if (fall.from.y - pos.y > 2) this.recordDrop(fall, pos);
        }
        return;
      }
      this.fall = null;
    }
    const discontinuous = previous !== null && (
      previous.worldId !== worldId
      || previous.dim !== dim
      || previous.sessionId !== sessionId
      || moved > TELEPORT
      || !observedStep(previous.pos, pos)
    );
    if (discontinuous) {
      this.flush();
      this.pendingStart = null;
    }

    // 水里/岩浆里/骑乘的位移不是普通步行；结束当前段，不把游泳或船速算成 walk。
    if (observation.inWater || observation.inLava || observation.riding) {
      this.flush();
      this.pendingStart = null;
      this.last = { worldId, dim, sessionId, pos: { ...pos } };
      return;
    }

    this.last = { worldId, dim, sessionId, pos: { ...pos } };

    if (this.run === null) {
      // 8 点上限 flush 后，用上一段末点作为新段首点；下一帧会补上 seam segment，
      // 这样拓扑在长走分段处仍由同一个 exact 节点连接，而不是两段各自起头。
      const carried = this.pendingStart !== null
        && this.pendingStart.worldId === worldId && this.pendingStart.dim === dim && this.pendingStart.sessionId === sessionId
        ? this.pendingStart.pos : null;
      const start = carried ?? pos;
      this.pendingStart = null;
      this.run = {
        id: `trail:${worldId}:${dim}:${this.now()}:${this.sequence++}`,
        worldId, dim, sessionId,
        startedAt: this.now(), lastAt: this.now(),
        points: [{ ...start }], segments: [], hasDug: dugOnPath(observation.dug, [start]),
        bridgeSupports: observation.onPlacedSupport?.(supportOf(start)) ? 1 : 0,
      };
      if (carried === null) return;
      // 继续把本次观测作为 seam 的终点，进入下面的同一段追加逻辑。
    }
    const from = this.run.points.at(-1)!;
    if (d3(from, pos) < RECORD_STEP) {
      // 格子内抖动/慢速移动不产生记录点，但同样按停走阈值落盘，不能让它无限期留在内存。
      if (dugOnPath(observation.dug, [...this.run.points, pos])) this.run.hasDug = true;
      if (this.now() - this.run.lastAt >= IDLE_FLUSH_MS) this.flush(true);
      return;
    }
    if (!observedStep(from, pos)) {
      // 相邻记录点之间发生了不连续位移：不把这段接成同一条路。
      this.flush();
      this.run = {
        id: `trail:${worldId}:${dim}:${this.now()}:${this.sequence++}`,
        worldId, dim, sessionId,
        startedAt: this.now(), lastAt: this.now(),
        points: [{ ...pos }], segments: [], hasDug: dugOnPath(observation.dug, [pos]),
        bridgeSupports: observation.onPlacedSupport?.(supportOf(pos)) ? 1 : 0,
      };
      return;
    }
    const observedAt = this.now();
    this.run.points.push({ ...pos });
    this.run.segments.push({
      id: `${this.run.id}:${this.run.segments.length}`,
      fragmentId: this.run.id,
      from: { ...from },
      to: { ...pos },
      worldId, dim, sessionId,
      observedAt,
      source: 'confirmed_traversal',
      executionId: this.run.id,
      mode: 'walk',
    });
    this.run.lastAt = observedAt;
    if (dugOnPath(observation.dug, this.run.points)) this.run.hasDug = true;
    if (observation.onPlacedSupport?.(supportOf(pos))) this.run.bridgeSupports += 1;
    if (this.run.points.length >= MAX_POINTS) this.flush(true);
  }

  /** 一次已落地的掉落：起跳点 → 落地点两点一段，mode:'drop'；落地点作为下一段行走的起点。 */
  private recordDrop(fall: { worldId: string; dim: string; sessionId: string; from: Vec3Like }, to: Vec3Like): void {
    const at = this.now();
    const id = `trail:${fall.worldId}:${fall.dim}:${at}:${this.sequence++}`;
    this.run = {
      id, worldId: fall.worldId, dim: fall.dim, sessionId: fall.sessionId,
      startedAt: at, lastAt: at,
      points: [{ ...fall.from }, { ...to }],
      segments: [{
        id: `${id}:0`, fragmentId: id, from: { ...fall.from }, to: { ...to },
        worldId: fall.worldId, dim: fall.dim, sessionId: fall.sessionId,
        observedAt: at, source: 'confirmed_traversal', executionId: id, mode: 'drop',
      }],
      hasDug: false, bridgeSupports: 0,
    };
    this.flush(true);
  }

  /** 最近的有界写入回执（旧→新）。只报告已发生的真实写入，不触发重试。 */
  receipts(limit = MAX_TRAVERSAL_RECEIPTS): readonly TraversalWriteReceipt[] {
    return this.receiptsLog.slice(Math.max(0, this.receiptsLog.length - Math.max(0, limit)));
  }

  /** 结束当前段；没有已确认 segment 时不写空 fragment，也不产生回执。 */
  flush(carry = false): TraversalWriteReceipt | null {
    const run = this.run;
    this.run = null;
    // carry 时即使本段还没有 segment，也要保留最后已确认记录点：否则 8 点 flush 之后
    // 若先停走/抖动再落盘，会把拼接同一个 exact 节点的 seam 悄悄丢掉。
    if (carry && run !== null) {
      this.pendingStart = { worldId: run.worldId, dim: run.dim, sessionId: run.sessionId, pos: { ...run.points.at(-1)! } };
    } else if (!carry) {
      this.pendingStart = null;
    }
    if (this.sink === undefined || run === null || run.segments.length === 0) return null;
    const kind: TraversalKind = run.hasDug ? 'dug' : run.bridgeSupports >= Math.max(1, Math.ceil(run.points.length * BRIDGE_SUPPORT_RATIO)) ? 'bridge' : 'walked';
    const fragment: PathFragment = {
      id: run.id,
      worldId: run.worldId,
      dim: run.dim,
      kind,
      entrances: [],
      polyline: run.points,
      geometrySource: 'traversal',
      deepestY: Math.min(...run.points.map((point) => point.y)),
      createdAt: run.startedAt,
      lastUsedAt: run.lastAt,
      uses: 1,
    };
    let outcome: TraversalWriteOutcome;
    let exceptionMessage: string | null = null;
    // 只把 sink 调用本身的抛错转成 recorder 侧结局；成功/结构化失败时保持原样。
    try {
      outcome = this.sink.recordWalkCorridor({ fragment, segments: run.segments });
    } catch (error) {
      exceptionMessage = `空间记忆写入异常：${(error as Error)?.message ?? String(error)}`;
      outcome = {
        status: 'failed', stage: 'sink_exception', message: exceptionMessage,
        fragmentId: fragment.id, traversalIds: 'unknown',
        topology: { nodes: 'unknown', edges: 'unknown', written: 'unknown' },
      };
    }
    const receipt: TraversalWriteReceipt = {
      sequence: this.receiptSequence += 1,
      fragmentId: fragment.id,
      kind,
      segmentCount: run.segments.length,
      from: { ...run.points[0]! },
      to: { ...run.points.at(-1)! },
      observedAt: run.lastAt,
      outcome,
    };
    this.receiptsLog.push(receipt);
    if (this.receiptsLog.length > MAX_TRAVERSAL_RECEIPTS) {
      this.receiptsLog.splice(0, this.receiptsLog.length - MAX_TRAVERSAL_RECEIPTS);
    }
    // 回执先定稿入日志，再通知失败；回调抛错不得改写已记录的证据。
    if (exceptionMessage !== null) this.onFailure?.(exceptionMessage);
    else if (outcome.status === 'failed') this.onFailure?.(`空间记忆写入失败：${outcome.stage} ${outcome.message}`);
    return receipt;
  }
}
