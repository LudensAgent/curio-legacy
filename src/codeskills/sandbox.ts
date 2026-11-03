import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';

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

export const API_METHODS = ['useSkill', 'state', 'blockAt', 'region', 'entities', 'drops', 'nearestLand', 'act', 'moveTo', 'stepTo', 'digAt', 'placeAt', 'look', 'sleep',
  'move', 'lookAt', 'attack', 'equip', 'shield', 'draw', 'release', 'shoot'] as const;
export const MAX_CODE = 8000;
/** 判定代码（verify）只能看、不能动：这些读的 api */
export const VERIFY_METHODS = ['state', 'blockAt', 'region', 'entities', 'drops', 'nearestLand'] as const;
export const MAX_VERIFY = 2000;

const wrap = (code: string) => `const __user = async (api, args) => {\n${code}\n};`;
const VM_GLOBALS = (vm.runInNewContext('Object.getOwnPropertyNames(globalThis)') as string[])
  .filter((name) => name !== 'globalThis' && name !== 'undefined')
  .map((name) => `declare const ${name}: unknown;`).join('\n');
const checkedCode = new Map<string, string | null>();

/** 只分析、不运行：检查语法、词法作用域和已知 api；不把普通 JavaScript 当严格类型程序检查。 */
export function compileCheck(code: string, opts: { allowed?: readonly string[]; maxLen?: number } = {}): string | null {
  const maxLen = opts.maxLen ?? MAX_CODE;
  if (typeof code !== 'string' || !code.trim()) return '代码是空的';
  if (code.length > maxLen) return `代码太长（${code.length} 字符，最多 ${maxLen}）`;
  const known = new Set<string>([...(opts.allowed ?? API_METHODS), 'log', ...(opts.allowed ? [] : ['progress'])]);
  const key = `${[...known].join(',')}\0${code}`;
  if (checkedCode.has(key)) return checkedCode.get(key)!;
  const finish = (error: string | null) => {
    if (checkedCode.size >= 1024) checkedCode.delete(checkedCode.keys().next().value!);
    checkedCode.set(key, error);
    return error;
  };
  try { new vm.Script(wrap(code), { filename: 'skill.js', lineOffset: -1 }); } catch (e) {
    const line = String((e as Error).stack ?? '').match(/skill\.js:(\d+)/)?.[1];
    return finish(`语法错误${line ? `（第 ${line} 行）` : ''}：${(e as Error).message}`);
  }

  // 不加载项目或 Node 的类型：声明的全局只来自空 vm，不能因宿主装了 @types/node 就认得 process/Buffer。
  const globals = ts.createSourceFile('sandbox.d.ts', `interface __SkillAPI {\n${[...known].map((name) => `${name}: (...values: unknown[]) => unknown;`).join('\n')}\n}\n${VM_GLOBALS}`, ts.ScriptTarget.ES2022, true);
  const source = ts.createSourceFile('skill.js', `/** @param {__SkillAPI} api */\n${wrap(code)}`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const files = new Map([['sandbox.d.ts', globals], ['skill.js', source]]);
  const program = ts.createProgram([...files.keys()], { noLib: true, allowJs: true, checkJs: true, noImplicitAny: false, target: ts.ScriptTarget.ES2022 }, {
    getSourceFile: (file) => files.get(file), getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => '', getDirectories: () => [],
    fileExists: (file) => files.has(file), readFile: (file) => files.get(file)?.text, getCanonicalFileName: (file) => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const missingApis = new Set<string>();
  const typeofNames = new Set<number>();
  const identifiers = new Set<number>();
  let forbidden = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.getStart(source));
    // typeof 未绑定名称在 JavaScript 里合法（常用来探测可用能力）；成员访问仍会正常报未定义。
    if (ts.isTypeOfExpression(node)) {
      let value: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isIdentifier(value)) typeofNames.add(value.getStart(source));
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const declarations = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee)?.declarations : undefined;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && (
        (['eval', 'Function'].includes(callee.text) && declarations?.some((declaration) => declaration.getSourceFile() === globals))
        || (callee.text === 'require' && !declarations?.length)))) forbidden = true;
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && checker.getTypeAtLocation(node.expression).getSymbol()?.name === '__SkillAPI') {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text : checker.getTypeAtLocation(node.argumentExpression);
      const name = typeof property === 'string' ? property : property.isStringLiteral() ? property.value : null;
      if (name !== null && !known.has(name)) missingApis.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const diagnostics = program.getSemanticDiagnostics(source);
  // 解构 api 的拼写错误也由同一个 API 声明检查；不限制游戏返回的数据字段和普通 JS 类型推断。
  diagnostics.filter((diagnostic) => [2339, 2551].includes(diagnostic.code) && ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').includes("'__SkillAPI'"))
    .forEach((diagnostic) => missingApis.add(source.text.slice(diagnostic.start!, diagnostic.start! + diagnostic.length!)));
  if (missingApis.size) return finish(`没有 ${[...missingApis].map((name) => `api.${name}`).join('、')}；能用的只有：${[...known].map((name) => `api.${name}`).join('、')}`);
  const missing = diagnostics.find((diagnostic) => [2304, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2662, 2663, 18004].includes(diagnostic.code)
    && diagnostic.start !== undefined && identifiers.has(diagnostic.start) && !typeofNames.has(diagnostic.start));
  if (forbidden || (missing && ['require', 'process'].includes(source.text.slice(missing.start!, missing.start! + missing.length!))))
    return finish('代码只能用 api.* 和普通 JavaScript：不能 require/import、碰 process、eval 或 new Function');
  if (missing) return finish(`引用错误（第 ${source.getLineAndCharacterOfPosition(missing.start!).line - 1} 行）：${ts.flattenDiagnosticMessageText(missing.messageText, ' ')}`);
  return finish(null);
}

/** 校验 verify：语法 + 只读 api 白名单 + 不能过宽（不能是字面恒真）。返回错误信息或 null。 */
export function compileVerify(code: string): string | null {
  const bad = compileCheck(code, { allowed: VERIFY_METHODS, maxLen: MAX_VERIFY });
  if (bad) return bad;
  const stripped = code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  if (/^return(true|!0|1);?$/.test(stripped)) return '判定不能是恒真（return true）：做完以后要真的看一眼世界再确认';
  return null;
}

let liveWorkers = 0;
/** 现在活着的沙箱线程数（每个线程有自己的 V8 堆；正常最多一两个，越来越多就是没被收掉） */
export function sandboxStats() { return { sandboxWorkers: liveWorkers }; }

export async function runSandboxed(code: string, args: unknown, handle: SandboxHandler,
  opts: { signal: AbortSignal; deadline: number; pokeMs?: number; maxCalls?: number; onLog?: (t: string) => void; onProgress?: (p: number) => void }): Promise<SandboxResult> {
  const pokeMs = opts.pokeMs ?? 1500, maxCalls = opts.maxCalls ?? 12000;
  const trace: string[] = [], logs: string[] = [];
  let calls = 0, logged = 0;
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
  liveWorkers++;
  // stdout/stderr 设成了 true 就得有人读走，不然线程里打印的东西会一直攒着
  worker.stdout.resume();
  worker.stderr.resume();
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
  // 取消时停止派发新动作，让在途动作完成有界取消结算（带着部分回执 end）；没有在途动作才立即结束。
  let inFlight = false;
  let cancelling = false;
  const onAbort = () => { cancelling = true; if (!inFlight) end(Object.assign(new Error('task cancelled'), { name: 'AbortedError' })); };
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const overall = setTimeout(() => end(failWith('代码超时：总时限用完了（循环太多、或者在等很久的动作）')), Math.max(100, opts.deadline - Date.now()));
  let chain = Promise.resolve();
  worker.on('error', (e) => end(failWith(`代码出错：${String((e as Error)?.message ?? e)}`)));
  worker.on('exit', () => { liveWorkers--; end(failWith('沙箱线程意外退出')); });
  worker.on('message', (msg: any) => {
    if (done) return;
    if (msg.t === 'log') {
      const t = String(msg.text ?? '');
      logs.push(t);
      if (logs.length > 40) logs.splice(0, logs.length - 20);
      // 循环里每圈都 log 的代码：只把前 50 条送上总线，免得刷满事件日志
      if (++logged <= 50) opts.onLog?.(t);
      return;
    }
    if (msg.t === 'progress') { opts.onProgress?.(Number(msg.p) || 0); return; }
    if (msg.t === 'done') { end(msg.ok ? finish({ ok: true, result: msg.result }) : failWith(String(msg.error ?? '出错了'))); return; }
    if (msg.t !== 'call') return;
    disarm();
    // 一个一个处理（代码里 Promise.all 也按顺序做）
    chain = chain.then(async () => {
      if (done || cancelling) return;
      if (++calls > maxCalls) { end(failWith(`api 调用超过 ${maxCalls} 次：多半是循环没有出口`)); return; }
      const a = Array.isArray(msg.a) ? msg.a : [];
      let out: string, isError = false;
      inFlight = true;
      try {
        const value = await handle(String(msg.m), a);
        out = JSON.stringify(value === undefined ? null : value);
        trace.push(`${msg.m}(${JSON.stringify(a).slice(1, -1).slice(0, 60)}) → ${out.slice(0, 80)}`); if (trace.length > 60) trace.splice(0, trace.length - 30);
      } catch (e) {
        if ((e as Error)?.name === 'AbortedError') { inFlight = false; end(e as Error); return; }
        out = String((e as Error)?.message ?? e).slice(0, 300); isError = true;
        trace.push(`${msg.m}(${JSON.stringify(a).slice(1, -1).slice(0, 60)}) ✗ ${out.slice(0, 80)}`); if (trace.length > 60) trace.splice(0, trace.length - 30);
      }
      inFlight = false;
      if (done) return;
      if (cancelling) { end(Object.assign(new Error('task cancelled'), { name: 'AbortedError' })); return; }
      worker.postMessage({ t: 'result', id: msg.id, json: out, isError });
      arm();
    });
  });
  worker.postMessage({ t: 'start', code, args: JSON.stringify(args ?? {}) });
  arm(3000); // 线程启动要一点时间
  return result;
}
