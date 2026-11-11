import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * 主线程卡顿时找出是谁：一直开着低频率的 CPU 采样（每 5 毫秒一次，开销很小），每 10 秒换一段；
 * 这段时间里主线程卡住过（两次心跳之间隔了 3 秒以上），就把这一段的采样存成 .cpuprofile，
 * 并汇总出最占时间的几个函数（文件:行号），直接写进事件里。
 * 服务器 15~30 秒收不到心跳回包就会踢人，所以卡住的原因要当场留下来。
 */
export interface StallReport { stallMs: number; top: string[]; file: string | null }
/** 没到“卡住”但足以让身体物理（50ms 一刻）顿一下的阻塞：窗口内最长一次与当时 CPU 的去向。 */
export interface JankReport { maxMs: number; p99Ms: number; top: string[] }

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };

export function summarize(profile: { nodes: Node[]; samples?: number[]; timeDeltas?: number[] }, n = 6): string[] {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map<number, number>();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (deltas[i] ?? 0));
  const agg = new Map<string, number>();
  for (const [id, us] of self) {
    const f = byId.get(id)?.callFrame;
    if (!f || f.functionName === '(idle)') continue;
    const where = f.url ? `${path.basename(f.url.replace(/^file:\/\//, ''))}:${f.lineNumber + 1}` : '';
    const key = `${f.functionName || '(匿名)'}${where ? ` @ ${where}` : ''}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  return [...agg].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `${k} ${(us / 1000).toFixed(0)}ms`);
}

export function startStallProfiler(
  dir: string, onStall: (r: StallReport) => void,
  opts: { windowMs?: number; stallMs?: number; jankMs?: number; jankEveryMs?: number; onJank?: (r: JankReport) => void } = {},
) {
  const windowMs = opts.windowMs ?? 10_000, threshold = opts.stallMs ?? 3000;
  const jankMs = opts.jankMs ?? 150, jankEveryMs = opts.jankEveryMs ?? 60_000;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastJankAt = 0;
  const session = new Session();
  try { session.connect(); } catch { return () => {}; }
  const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => session.post(method, params, (err, res) => err ? reject(err) : resolve(res)));
  let worst = 0, running = false, stopped = false;
  const begin = async () => {
    try { await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 5000 }); await post('Profiler.start'); running = true; } catch { running = false; }
  };
  void begin();
  let last = Date.now();
  const beat = setInterval(() => {
    const now = Date.now(), stall = now - last - 1000;
    last = now;
    if (stall >= threshold) worst = Math.max(worst, stall);
  }, 1000);
  beat.unref();
  const roll = setInterval(async () => {
    if (!running || stopped) return;
    const stall = worst;
    worst = 0;
    const maxMs = delay.max / 1e6, p99Ms = delay.percentile(99) / 1e6;
    delay.reset();
    try {
      const { profile } = await post('Profiler.stop');
      running = false;
      if (!stall && opts.onJank && maxMs >= jankMs && Date.now() - lastJankAt >= jankEveryMs) {
        lastJankAt = Date.now();
        opts.onJank({ maxMs, p99Ms, top: summarize(profile) });
      }
      if (stall) {
        let file: string | null = null;
        try {
          fs.mkdirSync(dir, { recursive: true });
          file = path.join(dir, `stall-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
          fs.writeFileSync(file, JSON.stringify(profile));
        } catch { file = null; }
        onStall({ stallMs: stall, top: summarize(profile), file });
      }
    } catch { /* ignore */ }
    if (!stopped) await begin();
  }, windowMs);
  roll.unref();
  return () => { stopped = true; clearInterval(beat); clearInterval(roll); delay.disable(); try { session.disconnect(); } catch { /* ignore */ } };
}
