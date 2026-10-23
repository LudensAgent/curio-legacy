export class AbortedError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortedError';
  }
}

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
