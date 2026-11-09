import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { EventBus } from '../events.ts';

/** 和 scripts/supervise.mjs 约定：退出码 75 = 请守护进程马上重启 */
export const RESTART_EXIT_CODE = 75;

/** external / arrayBuffers：V8 堆外的内存（Buffer、套接字待发数据、区块数据等），堆没满而 rss 一直涨时看这两项 */
export interface MemoryReading { rss: number; heapUsed: number; heapLimit: number; ratio: number; external?: number; arrayBuffers?: number }
export function readMemory(): MemoryReading {
  const h = v8.getHeapStatistics();
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: h.used_heap_size, heapLimit: h.heap_size_limit, ratio: h.used_heap_size / h.heap_size_limit, external: m.external, arrayBuffers: m.arrayBuffers };
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** 快照目录里 withinMs 内写过的堆快照（读不了目录按没有处理） */
function recentSnapshot(dir: string, now: number, withinMs: number): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => /^heap-.*\.heapsnapshot$/.test(name) && now - fs.statSync(path.join(dir, name)).mtimeMs < withinMs);
}

/**
 * 进程健康：
 * - 在守护进程下运行时（有 IPC），每 10 秒发一次心跳（带内存），守护靠它判断卡死；守护发来 shutdown 就正常存档退出。
 * - 每 10 分钟把内存记进事件日志，事后能看出是不是在慢慢涨。
 * - 堆用到 80% 提醒一次；到 92% 且有守护时先存档退出（退出码 75），由守护马上重启——比等到内存耗尽被直接中止强。
 */
export function installProcessHealth(bus: EventBus, opts: {
  onShutdown: () => void;
  onMemoryRestart: () => void;
  read?: () => MemoryReading;
  beatMs?: number;
  logEveryMs?: number;
  warnAt?: number;
  restartAt?: number;
  send?: ((m: unknown) => void) | null;
  /** 各模块自己报的数字（实时连接积压、沙箱线程数……），随内存日志一起记下 */
  extra?: () => Record<string, number>;
  /**
   * 堆用到这么多字节时写一份堆快照（每个进程一次），下次再涨就能直接看出是谁占的。
   * 正常运行堆只有一两百 MB；快照要暂停进程几十秒、占和堆一样大的磁盘。0 = 不写。
   */
  snapshotAtBytes?: number;
  snapshotDir?: string;
  /**
   * 目录里这么近的时间内已经有快照就不再写（跨重启）。堆的冲高常在启动后不久出现、随后回落：
   * 每次重启都写一份，会每次都停顿几十秒、每份占几百 MB 磁盘，却只是同一种冲高的重复样本。
   */
  snapshotCooldownMs?: number;
  writeSnapshot?: (file: string) => string;
}): { check(): void; dispose(): void } {
  const read = opts.read ?? readMemory;
  const send = opts.send !== undefined ? opts.send : typeof process.send === 'function' ? (m: unknown) => { try { process.send!(m); } catch { /* 守护已经没了 */ } } : null;
  const warnAt = opts.warnAt ?? 0.8, restartAt = opts.restartAt ?? 0.92, logEveryMs = opts.logEveryMs ?? 600_000;
  let lastLog = 0, lastLogged = 0, lastWarn = 0, restarting = false, snapshotted = false;
  const extra = () => { try { return opts.extra?.() ?? {}; } catch { return {}; } };

  const check = () => {
    const m = read();
    const now = Date.now();
    send?.({ type: 'hb', ts: now, rss: m.rss, heapUsed: m.heapUsed, heapLimit: m.heapLimit });
    // 涨得快的时候（比上次记录多一半以上）提前记一笔，不必等满 10 分钟
    if (now - lastLog >= logEveryMs || (lastLogged && m.heapUsed > lastLogged * 1.5 && now - lastLog >= 60_000)) {
      lastLog = now;
      lastLogged = m.heapUsed;
      const x = extra();
      const off = m.external !== undefined ? `，堆外 ${mb(m.external)}（Buffer ${mb(m.arrayBuffers ?? 0)}）` : '';
      const more = Object.entries(x).map(([k, v]) => `${k}=${/backlog|bytes/i.test(k) ? mb(v) : v}`).join(' ');
      bus.publish('process_memory', 'P3', `内存：rss ${mb(m.rss)}，堆 ${mb(m.heapUsed)} / ${mb(m.heapLimit)}（${Math.round(m.ratio * 100)}%）${off}${more ? `｜${more}` : ''}`, { ...m, ...x });
    }
    const snapAt = opts.snapshotAtBytes ?? 0;
    const dir = opts.snapshotDir ?? '.';
    if (snapAt > 0 && !snapshotted && m.heapUsed >= snapAt && recentSnapshot(dir, now, opts.snapshotCooldownMs ?? 24 * 3600_000)) {
      snapshotted = true;
      bus.publish('memory_snapshot', 'P2', `堆已用 ${mb(m.heapUsed)}，但 ${dir} 里 ${Math.round((opts.snapshotCooldownMs ?? 24 * 3600_000) / 3600_000)} 小时内已有堆快照，这次不再写（避免进程停顿）`, { ...m, ...extra() });
    }
    if (snapAt > 0 && !snapshotted && m.heapUsed >= snapAt) {
      snapshotted = true;
      const file = path.join(dir, `heap-${new Date(now).toISOString().replace(/[:.]/g, '-')}.heapsnapshot`);
      bus.publish('memory_snapshot', 'P1', `堆已用 ${mb(m.heapUsed)}（远高于平时），写一份堆快照留着查是谁占的：${file}（进程会停顿一会儿）`, { ...m, ...extra(), file });
      // 写快照会停住事件循环几十秒：先告诉守护进程，免得被当成卡死杀掉
      send?.({ type: 'busy', ms: 5 * 60_000 });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const written = (opts.writeSnapshot ?? ((f: string) => v8.writeHeapSnapshot(f)))(file);
        bus.publish('memory_snapshot', 'P1', `堆快照写好了：${written}（用 Chrome DevTools → Memory 打开）`, { file: written });
      } catch (e) {
        bus.publish('memory_snapshot', 'P1', `堆快照没写成：${String((e as Error)?.message ?? e)}`);
      }
    }
    if (m.ratio >= restartAt && send && !restarting) {
      restarting = true;
      bus.publish('memory_restart', 'P0', `堆内存用到 ${Math.round(m.ratio * 100)}%（${mb(m.heapUsed)} / ${mb(m.heapLimit)}），先存档退出，由守护进程马上重启`, { ...m });
      opts.onMemoryRestart();
    } else if (m.ratio >= warnAt && now - lastWarn >= 600_000) {
      lastWarn = now;
      bus.publish('memory_high', 'P1', `堆内存已用 ${Math.round(m.ratio * 100)}%（${mb(m.heapUsed)} / ${mb(m.heapLimit)}）${send ? '' : '；没有守护进程，满了会直接崩溃，建议用 npm run supervise 启动'}`, { ...m });
    }
  };

  const timer = setInterval(check, opts.beatMs ?? 10_000);
  timer.unref?.();
  const onMessage = (msg: any) => { if (msg?.type === 'shutdown') opts.onShutdown(); };
  if (send) process.on('message', onMessage);
  queueMicrotask(check);
  return { check, dispose() { clearInterval(timer); process.off('message', onMessage); } };
}
