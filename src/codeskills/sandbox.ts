import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./sandbox-worker.mjs', import.meta.url);

/**
 * 代码技能的沙箱：模型自己写的 JavaScript（寻路、躲避、搭建……）在这里跑，只能通过 api.* 碰游戏。
 *
 * - 跑在独立的工作线程里（sandbox-worker.mjs）：死循环、算太久时主线程直接终止这个线程，游戏不受影响；
 * - 线程里再用 vm 隔开：全局对象没有原型（拿不到线程的 Object/Function/process），禁止 eval / new Function，
 *   和 vm 之间只传字符串；
 * - 每段同步计算有时限（pokeMs），另有总时限、api 调用次数上限和取消信号。
 *
 * Node 的 vm 不是严格的安全边界；这里防的是写错的代码（死循环、乱调用），不是蓄意攻击。代码只来自自己的模型。
 */
export type SandboxHandler = (method: string, args: unknown[]) => Promise<unknown>;
export interface SandboxResult { ok: boolean; result?: unknown; error?: string; line?: number; calls: number; trace: string[]; logs: string[] }

export const API_METHODS = ['useSkill', 'state', 'blockAt', 'region', 'entities', 'nearestLand', 'act', 'moveTo', 'stepTo', 'digAt', 'placeAt', 'look', 'sleep',
  'move', 'lookAt', 'attack', 'equip', 'shield', 'draw', 'release', 'shoot'] as const;
export const MAX_CODE = 8000;
/** 判定代码（verify）只能看、不能动：这些读的 api */
export const VERIFY_METHODS = ['state', 'blockAt', 'region', 'entities', 'nearestLand'] as const;
export const MAX_VERIFY = 2000;

const wrap = (code: string) => `const __user = async (api, args) => {\n${code}\n};`;

/** 只编译不运行：语法错误时返回中文说明（带行号） */
export function compileCheck(code: string, opts: { allowed?: readonly string[]; maxLen?: number } = {}): string | null {
  const maxLen = opts.maxLen ?? MAX_CODE;
  if (typeof code !== 'string' || !code.trim()) return '代码是空的';
  if (code.length > maxLen) return `代码太长（${code.length} 字符，最多 ${maxLen}）`;
  if (/\b(?:require|process|eval)\b|\bimport\s*\(|\bFunction\s*\(|globalThis\s*\.\s*constructor/.test(code)) return '代码只能用 api.* 和普通 JavaScript：不能 require/import、碰 process、eval 或 new Function';
  // 用了不存在的 api：保存前就说清楚，别等到游戏里第一次触发才报 TypeError（那一次还会记成技能失败）
  const known = new Set<string>([...(opts.allowed ?? API_METHODS), 'log', ...(opts.allowed ? [] : ['progress'])]);
  const unknown = [...new Set([...code.matchAll(/\bapi\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((n) => !known.has(n)))];
  if (unknown.length) return `没有 ${unknown.map((n) => `api.${n}`).join('、')}；能用的只有：${[...known].map((n) => `api.${n}`).join('、')}`;
  try { new vm.Script(wrap(code), { filename: 'skill.js', lineOffset: -1 }); return null; } catch (e) {
    const line = String((e as Error).stack ?? '').match(/skill\.js:(\d+)/)?.[1];
    return `语法错误${line ? `（第 ${line} 行）` : ''}：${(e as Error).message}`;
  }
}

export async function runSandboxed(code: string, args: unknown, handle: SandboxHandler,
  opts: { signal: AbortSignal; deadline: number; pokeMs?: number; maxCalls?: number; onLog?: (t: string) => void; onProgress?: (p: number) => void }): Promise<SandboxResult> {
  const pokeMs = opts.pokeMs ?? 1500, maxCalls = opts.maxCalls ?? 12000;
  const trace: string[] = [], logs: string[] = [];
  let calls = 0;
  const finish = (r: Omit<SandboxResult, 'calls' | 'trace' | 'logs'>): SandboxResult => ({ ...r, calls, trace: trace.slice(-30), logs: logs.slice(-20) });
  const failWith = (error: string) => {
    const line = Number(error.match(/skill\.js:(\d+)/)?.[1]);
    return finish({ ok: false, error: error.split('\n').slice(0, 3).join(' | ').slice(0, 400), ...(Number.isFinite(line) && line > 0 ? { line } : {}) });
  };
  const err = compileCheck(code);
  if (err) return finish({ ok: false, error: err });
  opts.signal.throwIfAborted();
  // 独立线程：死循环、算太久时直接终止线程（在主线程里打断 vm 会弄坏 Node 的异步上下文）
  const worker = new Worker(WORKER, { workerData: { methods: API_METHODS }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }, stdout: true, stderr: true });
  let settle!: (r: SandboxResult) => void;
  let rejectAbort!: (e: Error) => void;
  const result = new Promise<SandboxResult>((res, rej) => { settle = res; rejectAbort = rej; });
  let watchdog: NodeJS.Timeout | null = null;
  let done = false;
  const end = (r: SandboxResult | Error) => {
    if (done) return;
    done = true;
    if (watchdog) clearTimeout(watchdog);
    clearTimeout(overall);
    opts.signal.removeEventListener('abort', onAbort);
    void worker.terminate();
    if (r instanceof Error) rejectAbort(r); else settle(r);
  };
  // 等工作线程回话时才计时：超过 pokeMs 没动静就是同步代码停不下来
  const arm = (extra = 0) => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => end(failWith(`代码卡住了：一次同步计算超过 ${pokeMs} 毫秒（死循环，或者循环里没有 await api）`)), pokeMs + extra); };
  const disarm = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
  const onAbort = () => end(Object.assign(new Error('task cancelled'), { name: 'AbortedError' }));
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const overall = setTimeout(() => end(failWith('代码超时：总时限用完了（循环太多、或者在等很久的动作）')), Math.max(100, opts.deadline - Date.now()));
  let chain = Promise.resolve();
  worker.on('error', (e) => end(failWith(`代码出错：${String((e as Error)?.message ?? e)}`)));
  worker.on('exit', () => end(failWith('沙箱线程意外退出')));
  worker.on('message', (msg: any) => {
    if (done) return;
    if (msg.t === 'log') { const t = String(msg.text ?? ''); logs.push(t); opts.onLog?.(t); return; }
    if (msg.t === 'progress') { opts.onProgress?.(Number(msg.p) || 0); return; }
    if (msg.t === 'done') { end(msg.ok ? finish({ ok: true, result: msg.result }) : failWith(String(msg.error ?? '出错了'))); return; }
    if (msg.t !== 'call') return;
    disarm();
    // 一个一个处理（代码里 Promise.all 也按顺序做）
    chain = chain.then(async () => {
      if (done) return;
      if (++calls > maxCalls) { end(failWith(`api 调用超过 ${maxCalls} 次：多半是循环没有出口`)); return; }
      const a = Array.isArray(msg.a) ? msg.a : [];
      let out: string, isError = false;
      try {
        const value = await handle(String(msg.m), a);
        out = JSON.stringify(value === undefined ? null : value);
        trace.push(`${msg.m}(${JSON.stringify(a).slice(1, -1).slice(0, 60)}) → ${out.slice(0, 80)}`);
      } catch (e) {
        if ((e as Error)?.name === 'AbortedError') { end(e as Error); return; }
        out = String((e as Error)?.message ?? e).slice(0, 300); isError = true;
        trace.push(`${msg.m}(${JSON.stringify(a).slice(1, -1).slice(0, 60)}) ✗ ${out.slice(0, 80)}`);
      }
      if (done) return;
      worker.postMessage({ t: 'result', id: msg.id, json: out, isError });
      arm();
    });
  });
  worker.postMessage({ t: 'start', code, args: JSON.stringify(args ?? {}) });
  arm(3000); // 线程启动要一点时间
  return result;
}
