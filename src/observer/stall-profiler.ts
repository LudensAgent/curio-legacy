import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * 主线程卡顿时找出是谁。事件循环延迟一直在量（几乎没有开销）；CPU 采样默认按需开：
 * 某个 10 秒窗口里出现过 ≥jankMs 的阻塞或 ≥stallMs 的卡死，就在接下来的窗口里采样，
 * 采到的窗口有阻塞就汇总最占时间的函数（文件:行号）写进事件，卡死的窗口另存 .cpuprofile；
 * 连续一段平稳就停采。
 *
 * 以前一直开着采样、每 10 秒 stop/start 一次：大工程的 profile 很大，取回和解析本身就会把主线程
 * 卡住一两百毫秒（local-test-01 里 inspector post 每窗口约 0.3 秒），成了最常见的“卡顿”来源之一。
 * 按需采样看不到第一次卡顿当时的 CPU（之后同类卡顿会被采到）；要一直采可设 STALL_PROFILER=always。
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
  opts: { windowMs?: number; stallMs?: number; jankMs?: number; jankEveryMs?: number; onJank?: (r: JankReport) => void; always?: boolean;
    /** 按需模式下连续这么多个平稳窗口就停采 */ calmWindows?: number } = {},
) {
  const windowMs = opts.windowMs ?? 10_000, threshold = opts.stallMs ?? 3000;
  const jankMs = opts.jankMs ?? 150, jankEveryMs = opts.jankEveryMs ?? 60_000;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastJankAt = 0;
  const session = new Session();
  try { session.connect(); } catch { return () => {}; }
  const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => session.post(method, params, (err, res) => err ? reject(err) : resolve(res)));
  let worst = 0, running = false, stopped = false, calm = 0;
  const calmWindows = opts.calmWindows ?? 3;
  const begin = async () => {
    try { await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 5000 }); await post('Profiler.start'); running = true; } catch { running = false; }
  };
  if (opts.always) void begin();
  let last = Date.now();
  const beat = setInterval(() => {
    const now = Date.now(), stall = now - last - 1000;
    last = now;
    if (stall >= threshold) worst = Math.max(worst, stall);
  }, 1000);
  beat.unref();
  const roll = setInterval(async () => {
    if (stopped) return;
    const stall = worst;
    worst = 0;
    const maxMs = delay.max / 1e6, p99Ms = delay.percentile(99) / 1e6;
    delay.reset();
    const rough = stall > 0 || maxMs >= jankMs;
    if (!running) {
      // 这一窗没在采样：不平稳就从下一窗开始采；阻塞本身照样报（没有 CPU 去向）。
      if (!rough) return;
      if (!stall && opts.onJank && Date.now() - lastJankAt >= jankEveryMs) {
        lastJankAt = Date.now();
        opts.onJank({ maxMs, p99Ms, top: ['（这一窗没有 CPU 采样，下一窗开始采）'] });
      }
      if (stall) onStall({ stallMs: stall, top: ['（卡住时没有 CPU 采样，下一窗开始采；同类卡顿再出现会存采样文件）'], file: null });
      calm = 0;
      await begin();
      return;
    }
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
    } catch { running = false; }
    calm = rough ? 0 : calm + 1;
    if (!stopped && (opts.always || calm < calmWindows)) await begin();
  }, windowMs);
  roll.unref();
  return () => { stopped = true; clearInterval(beat); clearInterval(roll); delay.disable(); try { session.disconnect(); } catch { /* ignore */ } };
}
