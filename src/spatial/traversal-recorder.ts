import type { PathFragment } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../adapter/types.ts';
import type { SharedSpatialSession, WalkCorridorSegment } from './shared-session.ts';

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

  /** 结束当前段；没有已确认 segment 时不写空 fragment。 */
  flush(carry = false): void {
    const run = this.run;
    this.run = null;
    // carry 时即使本段还没有 segment，也要保留最后已确认记录点：否则 8 点 flush 之后
    // 若先停走/抖动再落盘，会把拼接同一个 exact 节点的 seam 悄悄丢掉。
    if (carry && run !== null) {
      this.pendingStart = { worldId: run.worldId, dim: run.dim, sessionId: run.sessionId, pos: { ...run.points.at(-1)! } };
    } else if (!carry) {
      this.pendingStart = null;
    }
    if (this.sink === undefined || run === null || run.segments.length === 0) return;
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
    try {
      const outcome = this.sink.recordWalkCorridor({ fragment, segments: run.segments });
      if (outcome.status === 'failed') this.onFailure?.(`空间记忆写入失败：${outcome.stage} ${outcome.message}`);
    } catch (error) {
      this.onFailure?.(`空间记忆写入异常：${(error as Error)?.message ?? String(error)}`);
    }
  }
}
