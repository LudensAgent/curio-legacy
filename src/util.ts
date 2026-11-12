export class AbortedError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortedError';
  }
}

/**
 * 显式挂起而不是终止执行：任务被暂时让出身体，可恢复的执行层应保留会话与实测进度。
 * 与普通取消区分开，调用方不必靠中文理由猜测“还要不要回来”。
 */
export const SUSPEND_ABORT_REASON = 'SUSPEND';

export const isSuspendAbort = (signal?: AbortSignal) =>
  signal?.aborted === true && signal.reason === SUSPEND_ABORT_REASON;

export class TimeoutError extends Error {
  constructor(msg = 'timeout') {
    super(msg);
    this.name = 'TimeoutError';
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
}

/** 可被取消的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError(String(signal.reason ?? 'aborted')));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError(String(signal?.reason ?? 'aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 让一个底层 Promise 可以被 AbortSignal 和超时打断。
 * 打断时调用 onCancel（例如停止寻路、停止挖掘），并吞掉底层 Promise 之后的迟到结果。
 */
export function raceAbort<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  onCancel: () => void,
): Promise<T> {
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () =>
      finish(() => {
        try { onCancel(); } catch { /* ignore */ }
        reject(new AbortedError(String(signal?.reason ?? 'aborted')));
      });
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(
            () =>
              finish(() => {
                try { onCancel(); } catch { /* ignore */ }
                reject(new TimeoutError(`timeout after ${timeoutMs}ms`));
              }),
            timeoutMs,
          )
        : undefined;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

export const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const round1 = (n: number) => Math.round(n * 10) / 10;

export function shortId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8);
}

/** 天光随时间变暗：白天 0，黄昏/黎明 5，夜晚 11（与原版大致一致） */
export function skyDarkness(timeOfDay: number) {
  return timeOfDay < 12000 ? 0 : timeOfDay < 13800 || timeOfDay >= 22200 ? 5 : 11;
}

/**
 * 取身体附近可透光格的脚/头亮度；床、半砖、土径等非整块方块也可采样。
 * 实心墙格、未加载格和异常光照值不能替代角色实际所在空隙的亮度。
 */
export function lightAround(adapter: { lightAt(x: number, y: number, z: number): { block: number; sky: number } | null; blockAt?(pos: { x: number; y: number; z: number }): string | null }, x: number, y: number, z: number) {
  let block = 0, sky = 0, sampled = false;
  const readable = /^(?:air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|dirt_path|farmland|ladder|vine|glow_lichen|lever|redstone_wire|(?:soul_|redstone_)?(?:wall_)?torch|(?:powered_|detector_|activator_)?rail|[a-z_]+_(?:bed|slab|stairs|carpet|button|pressure_plate))$/;
  for (const yy of [y, y + 1]) {
    if (adapter.blockAt) {
      const name = adapter.blockAt({ x, y: yy, z });
      if (name === null || !readable.test(name)) continue;
    }
    const light = adapter.lightAt(x, yy, z);
    if (!light || ![light.block, light.sky].every((n) => Number.isFinite(n) && n >= 0 && n <= 15)) continue;
    block = Math.max(block, light.block); sky = Math.max(sky, light.sky); sampled = true;
  }
  return sampled ? { block, sky } : null;
}

/** 实际亮度 = max(方块光, 天光 - 时间造成的变暗) */
export function effectiveLight(l: { block: number; sky: number }, timeOfDay: number) {
  return Math.max(l.block, l.sky - skyDarkness(timeOfDay));
}
