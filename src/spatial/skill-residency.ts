/**
 * 技能侧的 manual 体素驻留接缝。
 *
 * 只在技能已经决定要读/执行某条路线时，按真实身体起点、身体扫掠、支撑/净空与
 * shape provider 实际会读的格计算依赖 Section，再向共享会话做一次显式 prepare。
 * 不搜索、不预取、不扩大路线或容差：prepare 失败时把真实事实交给调用方。
 *
 * `no_record` 表示“没有已保存记录”，不是空气，也不是世界不可通行；此类 Section
 * 不进入加载请求，也不会因此否决整条路线。只有真实 `ready` 结果携带 lease，
 * 调用方在离开本次执行范围时精确释放一次。
 *
 * 这里不做任何磁盘 I/O；evaluateWalkStep 只读内存快照。物理帧内由 Vision 同步
 * 写入、共享会话同步派发 ChangeReport（resident/首观测），未驻留证据由共享会话
 * 自己的有限后台任务处理，帧内不等待。
 */
import { evaluateWalkStep } from 'curio-minecraft-3d-memory';
import type {
  SectionKey,
  StepDirection,
  Vec3Like,
  VoxelMap,
} from 'curio-minecraft-3d-memory';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import { walkCollisionProvider } from '../adapter/walk-collision.ts';
import type { SharedSpatialSession } from './shared-session.ts';
import type { WorkingSetLease } from './working-set.ts';

/** 单次 prepare 的 Section 上限；与库默认 maxLoadBatchSections 一致，超限只报事实。 */
export const MAX_ROUTE_SECTIONS = 256;

/** 容量失败后按需保存的冷却：同一会话 10 秒内只做一次，避免反复触发 checkpoint。 */
const CAPACITY_RECOVERY_COOLDOWN_MS = 10_000;
const capacityRecoveryAt = new WeakMap<SharedSpatialSession, number>();

/** 身体尺寸与执行器一致；只用于推导真实会读到的 Section，不参与移动判断。 */
const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };

export interface RouteScope {
  worldId: string;
  dim: string;
  sessionId: string;
}

export type RouteResidencyFailureReason =
  | 'cancelled'
  | 'incomplete'
  | 'failed'
  | 'busy'
  | 'closing'
  | 'closed'
  | 'error'
  | 'budget';

/** prepare 没有拿到可用 lease；`sections`/`noRecord` 是本次实际请求与缺记录事实。 */
export interface RouteResidencyFailure {
  status: 'not_ready';
  reason: RouteResidencyFailureReason;
  message: string;
  sections: SectionKey[];
  noRecord: SectionKey[];
  /** 原始错误对象（仅 error/busy/closing/closed）；绝不改写成成功。 */
  error?: unknown;
}

export type RouteResidency =
  | {
    status: 'ready';
    /** 只有真实 ready 才有 lease；全为 no_record 时为 null（无可加载记录）。 */
    lease: WorkingSetLease | null;
    /** 本次实际请求保护的 Section（resident + not_resident）。 */
    sections: SectionKey[];
    /** 明确没有保存记录、因此未请求加载的 Section；不代表空气/不可通行。 */
    noRecord: SectionKey[];
  }
  | RouteResidencyFailure;

function keyId(key: SectionKey): string {
  return JSON.stringify([key.worldId, key.dim, key.cx, key.cz, key.sy]);
}

function dedupeSections(keys: readonly SectionKey[]): SectionKey[] {
  const seen = new Set<string>();
  const out: SectionKey[] = [];
  for (const key of keys) {
    const id = keyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...key });
  }
  return out;
}

/** 每个实际格所属 Section；用于固定半径的局部准备区（不依赖地图内容）。 */
export function sectionsForCells(scope: RouteScope, cells: readonly Vec3Like[]): SectionKey[] {
  return dedupeSections(cells.map((cell) => ({
    worldId: scope.worldId,
    dim: scope.dim,
    cx: Math.floor(cell.x / 16),
    cz: Math.floor(cell.z / 16),
    sy: Math.floor(cell.y / 16),
  })));
}

function directionToward(from: Vec3Like, to: Vec3Like): StepDirection {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const axis: 'x' | 'z' = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
  const delta = axis === 'x' ? dx : dz;
  return { axis, sign: delta >= 0 ? 1 : -1 };
}

/**
 * 一次实际身体扫掠会读到的 Section 依赖（库 evaluateWalkStep 的实际依赖集合）。
 * 不按目标矩形枚举，只评估本次真实起点与路线各段的单步扫掠；额外补一层支撑
 * Section（执行器容忍脚高偏差时可能读到 y-1 层）。
 */
export function routeDependencySections(
  map: VoxelMap,
  scope: RouteScope,
  actualStart: Vec3Like,
  points: readonly Vec3Like[],
): SectionKey[] {
  const now = Date.now();
  const keys: SectionKey[] = [];
  const evaluate = (feet: Vec3Like, direction: StepDirection): void => {
    const evaluation = evaluateWalkStep(map, {
      worldId: scope.worldId,
      dim: scope.dim,
      sessionId: scope.sessionId,
      mode: 'walk',
      body: { feet: { ...feet }, ...BODY },
      direction,
    }, walkCollisionProvider, now);
    for (const dependency of evaluation.dependencies) {
      keys.push(dependency.key);
      // 支撑可能落在 y-1 层（脚位恰好落在 Section 边界时属于另一个 Section）。
      keys.push({ ...dependency.key, sy: dependency.key.sy - 1 });
    }
  };

  const firstDirection = points.length > 0 ? directionToward(actualStart, points[0]!) : { axis: 'x' as const, sign: 1 as const };
  evaluate(actualStart, firstDirection);
  for (let i = 0; i + 1 < points.length; i += 1) {
    evaluate(points[i]!, directionToward(points[i]!, points[i + 1]!));
  }
  return dedupeSections(keys);
}

/**
 * 显式准备调用方已经确定需要的 Section。
 *
 * - 先按只读 residency 把 `no_record` 排除出加载请求：缺记录不是空气，也不是
 *   不可通行，不因可选邻区缺记录而整体失败；
 * - 其余 Section（resident/not_resident/loading/load_failed）交给共享会话的
 *   `prepare`，只有 `ready` 才授予 lease；
 * - prepare 的取消/容量/读写失败原样返回，不替换路线、不扩大容差。
 */
export async function acquireRouteResidency(
  spatial: SharedSpatialSession,
  requested: readonly SectionKey[],
  options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<RouteResidency> {
  const sections = dedupeSections(requested);
  // eager 模式在打开时已经加载已提交体素；这里不做任何 prepare，保持原行为。
  if (spatial.session.voxelLoading !== 'manual') {
    return { status: 'ready', lease: null, sections, noRecord: [] };
  }
  if (sections.length > MAX_ROUTE_SECTIONS) {
    return {
      status: 'not_ready',
      reason: 'budget',
      message: `route residency needs ${sections.length} sections, exceeding the ${MAX_ROUTE_SECTIONS}-section prepare budget`,
      sections,
      noRecord: [],
    };
  }
  const noRecord = sections.filter(
    (key) => spatial.session.sectionResidency(key).residency === 'no_record',
  );
  const loadable = sections.filter(
    (key) => spatial.session.sectionResidency(key).residency !== 'no_record',
  );
  if (loadable.length === 0) {
    // 新区/首观测：所有依赖都还没有保存记录，没有需要加载或保护的数据。
    return { status: 'ready', lease: null, sections, noRecord };
  }

  const prepareOnce = () => spatial.prepare(loadable, options).then(
    (result) => ({ kind: 'result' as const, result }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  // 检查点调度器/后台加载/统计查询短暂占用时，库以 kind 'busy' 拒绝 prepare：这是忙，
  // 不是路线不可用。一次 checkpoint 的 voxel 批次提交可能远长于几十毫秒，固定 4 次
  // 几十毫秒的退避不够；在调用方 signal/deadline 范围内按 50ms 轮询，最多等
  // BUSY_WAIT_MS。等不到再原样返回 busy；closing/closed/error 等其他失败不重试。
  const BUSY_POLL_MS = 50;
  const BUSY_WAIT_MS = 3_000;
  const waitStarted = Date.now();
  const abortedNow = () => options.signal?.aborted === true;
  const retryStopped = (why: 'signal aborted' | 'deadline reached'): RouteResidencyFailure => ({
    status: 'not_ready',
    reason: 'cancelled',
    message: `route residency retry stopped: ${why}`,
    sections,
    noRecord,
  });

  let outcome = await prepareOnce();
  while (outcome.kind === 'error' && outcome.error instanceof PersistenceError && outcome.error.kind === 'busy') {
    const busyUntil = waitStarted + BUSY_WAIT_MS;
    const until = options.deadline === undefined ? busyUntil : Math.min(busyUntil, options.deadline);
    const remaining = until - Date.now();
    if (abortedNow()) return retryStopped('signal aborted');
    if (remaining <= 0) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) return retryStopped('deadline reached');
      break;
    }

    let aborted = false;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { aborted = true; cleanup(); resolve(); };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(BUSY_POLL_MS, remaining));
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (aborted) return retryStopped('signal aborted');

    outcome = await prepareOnce();
  }
  if (outcome.kind === 'error') {
    const kind = outcome.error instanceof PersistenceError ? outcome.error.kind : 'error';
    const reason: RouteResidencyFailureReason = kind === 'busy' || kind === 'closing' || kind === 'closed' ? kind : 'error';
    // busy 的原文只有一句泛化的内存门说明；把等待时长和实际在飞的 checkpoint 一并带上，
    // 心智才能区分“存储忙”与“这一片 Section 读不了”。
    const persistence = kind === 'busy' ? spatial.getPersistenceState() : null;
    const busyNote = reason !== 'busy' ? ''
      : `（已等 ${Date.now() - waitStarted}ms${persistence?.inFlightCheckpointId ? `；checkpoint ${persistence.inFlightCheckpointId} 在飞` : ''}${persistence?.dirty ? '；仍有 dirty 数据待保存' : ''}）`;
    return {
      status: 'not_ready',
      reason,
      message: `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}${busyNote}`,
      sections,
      noRecord,
      error: outcome.error,
    };
  }

  let result = outcome.result;
  // 容量不足不是“路线不可用”：先异步保存一次（提交 dirty），让已提交的冷 Section 可被换出，
  // 再重试同一个 prepare。全程在等待真实 I/O，不在物理帧里同步阻塞，也不在动作中途抢占后台保存。
  const capacityFailure = result.status === 'failed' ? result.result.capacity : null;
  let recovered = false;
  if (capacityFailure !== null && (capacityFailure.kind === 'byte_capacity' || capacityFailure.kind === 'count_capacity')
    && !abortedNow()
    && (options.deadline === undefined || options.deadline - Date.now() > 5_000)
    && Date.now() - (capacityRecoveryAt.get(spatial) ?? 0) >= CAPACITY_RECOVERY_COOLDOWN_MS) {
    capacityRecoveryAt.set(spatial, Date.now());
    const saved = await spatial.checkpoint().then(() => true, () => false);
    if (abortedNow()) return retryStopped('signal aborted');
    if (saved) {
      const retry = await prepareOnce();
      if (retry.kind === 'result') { result = retry.result; recovered = true; }
    }
  }
  if (result.status === 'ready') {
    return {
      status: 'ready',
      lease: result.lease,
      sections,
      noRecord: [...noRecord, ...result.result.noRecord],
    };
  }
  if (result.status === 'incomplete') {
    const preparedNoRecord = [...noRecord, ...result.result.noRecord];
    // 只有 no_record 缺失时不算失败：它不代表空气或不可通行，后续读取会如实
    // 报告 UNKNOWN，而不是被这里提前否决。
    if (result.result.notReady.length === 0) {
      return { status: 'ready', lease: null, sections, noRecord: preparedNoRecord };
    }
    return {
      status: 'not_ready',
      reason: 'incomplete',
      message: `working-set prepare left ${result.result.notReady.length} required section(s) not ready`,
      sections,
      noRecord: preparedNoRecord,
    };
  }
  if (result.status === 'cancelled') {
    return {
      status: 'not_ready',
      reason: 'cancelled',
      message: `working-set prepare was cancelled (${result.reason})`,
      sections,
      noRecord,
    };
  }
  const finalCapacity = result.result.capacity;
  // 把换出拒绝原因带出来：pinned/dirty/not_committed 对应完全不同的处理，别只报“腾不出空间”。
  const rejected = result.result.evictionRejected.reduce((counts, entry) => ({ ...counts, [entry.reason]: (counts[entry.reason] ?? 0) + 1 }), {} as Record<string, number>);
  const reasons = Object.entries(rejected).map(([reason, count]) => `${reason}×${count}`).join('、');
  return {
    status: 'not_ready',
    reason: 'failed',
    message: `${finalCapacity?.message ?? 'working-set prepare failed'}${reasons ? `；不可换出：${reasons}` : ''}${recovered ? '；已保存并重试一次' : ''}`,
    sections,
    noRecord: [...noRecord, ...result.result.noRecord],
  };
}

/** 精确释放本次拿到的 lease；没有 lease 或无效 token 都是 no-op。 */
export function releaseRouteResidency(spatial: SharedSpatialSession, residency: RouteResidency | null): void {
  if (residency === null || residency.status !== 'ready' || residency.lease === null) return;
  spatial.release(residency.lease.token);
}

/** 技能结果里保留的可诊断事实（不替代物理结果）。 */
export function residencyFacts(residency: RouteResidency): Record<string, unknown> {
  if (residency.status === 'ready') {
    return {
      residency: {
        status: 'ready',
        leased: residency.lease !== null,
        sections: residency.sections,
        noRecord: residency.noRecord,
      },
    };
  }
  return {
    residency: {
      status: residency.status,
      reason: residency.reason,
      message: residency.message,
      sections: residency.sections,
      noRecord: residency.noRecord,
    },
  };
}
