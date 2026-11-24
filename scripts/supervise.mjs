#!/usr/bin/env node
/**
 * Curio 守护进程：让 Agent 出错退出或卡死后自己爬起来。
 *
 *   npm run supervise          （等同 npm start，外面多一层守护）
 *   npm run supervise:proxy    （等同 npm run start:proxy）
 *
 * - 子进程非正常退出（崩溃、内存耗尽、被杀）→ 写崩溃报告、记一条事件，等几秒后重启；连续崩溃时等待逐步拉长。
 * - 子进程卡死（事件循环停住，心跳超时）→ 杀掉重启。
 * - 子进程正常退出（Ctrl+C / 关闭，退出码 0）→ 守护一起退出；退出码 75 = 子进程自己要求重启（内存快满时先存档再退）。
 * - stderr 全部落盘到 DATA_DIR/logs/console-err-YYYYMMDD.log；Node 致命错误另有诊断报告（--report-on-fatalerror）。
 *
 * 纯 JS，不依赖 tsx，守护本身尽量不出错。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const RESTART_EXIT_CODE = 75;
const pad = (n) => String(n).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${day(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** 与子进程（src/config.ts）一致的合并顺序：进程环境变量 > 模式文件 > 公共 .env。 */
export function envVars(envFile) {
  const common = path.join(path.dirname(envFile), '.env');
  return {
    ...(fs.existsSync(common) ? parseEnv(fs.readFileSync(common, 'utf8')) : {}),
    ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}),
    ...process.env,
  };
}

export function modeFrom(envFile, env) {
  const configuredMode = (env.CURIO_MODE ?? '').trim() || 'local';
  if (configuredMode !== 'local' && configuredMode !== 'test') throw new Error('CURIO_MODE 必须为 local 或 test');
  return path.basename(envFile) === '.env.test' ? 'test' : configuredMode;
}

/** 守护日志跟随所选配置；与子进程相同的数据目录（相对路径按配置文件所在目录解析）。 */
export function dataDirFrom(envFile) {
  const env = envVars(envFile);
  const mode = modeFrom(envFile, env);
  return path.resolve(path.dirname(envFile), (env.DATA_DIR ?? '').trim() || path.join('data', mode));
}

/**
 * test 配置预检：在父进程写日志、启动子进程之前，用子进程同一份 src/config.ts 做完整配置解析与隔离校验。
 * 校验失败（非零退出）即配置错误；父进程据此直接失败，不写盘、不进入崩溃重启循环。
 */
export function preflightConfig(envFile, root, extraEnv = {}) {
  const code = "import('./src/config.ts').catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });";
  const args = [
    ...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []),
    '--import', 'tsx', '--eval', code,
  ];
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
}

/** 第 n 次连续崩溃后等多久再起（毫秒） */
export function backoffMs(n) { return [3_000, 10_000, 30_000, 60_000][Math.min(n, 4) - 1] ?? 120_000; }

/**
 * @param {object} o
 * @param {string[]} o.command  [可执行文件, ...参数]
 * @param {string} o.cwd
 * @param {string} o.logDir
 * @param {number} [o.hangMs]      心跳多久没来算卡死
 * @param {number} [o.startupMs]   启动后多久内还没心跳不算卡死
 * @param {number} [o.stableMs]    跑满多久后连续崩溃计数清零
 * @param {(n:number)=>number} [o.backoff]
 * @param {(line:string)=>void} [o.say]
 * @returns {{ stop(): Promise<void>, done: Promise<void> }}
 */
export function supervise(o) {
  // 卡死判定：Minecraft 服务器 30 秒收不到包就把 bot 踢掉（游戏里显示“退出了游戏”），守护要赶在那之后不久就重启，不能干等两分钟
  const hangMs = o.hangMs ?? 45_000, startupMs = o.startupMs ?? 300_000, stableMs = o.stableMs ?? 600_000;
  const backoff = o.backoff ?? backoffMs;
  const say = o.say ?? ((l) => console.log(`\x1b[35m[守护 ${new Date().toLocaleTimeString()}]\x1b[0m ${l}`));
  fs.mkdirSync(o.logDir, { recursive: true });

  let child = null, stopping = false, crashes = 0, restarts = 0, timer = null, resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const event = (severity, type, msg, data) => {
    try { fs.appendFileSync(path.join(o.logDir, `events-${day()}.jsonl`), JSON.stringify({ ts: Date.now(), type, severity, msg, data }) + '\n'); } catch { /* 写不了日志也要继续守护 */ }
  };

  const start = () => {
    if (stopping) return;
    const startedAt = Date.now();
    let lastBeat = null, killedForHang = false;
    const errTail = [], outTail = [];
    const keep = (arr, s, max) => { for (const line of stripAnsi(s).split(/\r?\n/)) if (line) { arr.push(line); if (arr.length > max) arr.shift(); } };
    const errFile = () => path.join(o.logDir, `console-err-${day()}.log`);

    const c = spawn(o.command[0], o.command.slice(1), { cwd: o.cwd, stdio: ['inherit', 'pipe', 'pipe', 'ipc'], windowsHide: false });
    child = c;
    c.stdout.on('data', (b) => { process.stdout.write(b); keep(outTail, b.toString(), 80); });
    c.stderr.on('data', (b) => {
      process.stderr.write(b);
      const s = b.toString();
      keep(errTail, s, 200);
      try { fs.appendFileSync(errFile(), stripAnsi(s).split(/\r?\n/).map((l) => (l ? `[${new Date().toISOString()}] ${l}` : l)).join('\n')); } catch { /* ignore */ }
    });
    // busy：子进程要故意停一会儿（比如写堆快照），先说一声，这段时间不算卡死
    let busyUntil = 0;
    c.on('message', (m) => {
      if (m && m.type === 'hb') lastBeat = { at: Date.now(), ...m };
      else if (m && m.type === 'busy') busyUntil = Date.now() + Math.min(Number(m.ms) || 0, 10 * 60_000);
    });

    const watchdog = setInterval(() => {
      const since = lastBeat ? Date.now() - lastBeat.at : Date.now() - startedAt;
      if (Date.now() < busyUntil) return;
      if (since > (lastBeat ? hangMs : startupMs) && !killedForHang && !stopping) {
        killedForHang = true;
        say(`${Math.round(since / 1000)} 秒没有心跳，判定卡死，强制结束`);
        try { c.kill('SIGKILL'); } catch { /* 已经没了 */ }
      }
    }, 5_000);
    watchdog.unref?.();

    c.on('exit', (code, signal) => {
      clearInterval(watchdog);
      child = null;
      const ranMs = Date.now() - startedAt;
      if (stopping) { say('Agent 已退出，守护结束'); resolveDone(); return; }
      if (code === 0 && !killedForHang) { say('Agent 正常退出，守护结束'); resolveDone(); return; }

      const planned = code === RESTART_EXIT_CODE;
      const why = killedForHang ? '卡死（心跳超时）' : planned ? '自己要求重启（内存快满，已先存档）' : signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      if (!planned) crashes = ranMs >= stableMs ? 1 : crashes + 1;
      restarts++;
      const wait = planned ? 2_000 : backoff(crashes);
      const report = path.join(o.logDir, `crash-${stamp()}.log`);
      const mem = lastBeat ? `最后一次心跳 ${new Date(lastBeat.at).toLocaleString()}：rss ${mb(lastBeat.rss)}，堆 ${mb(lastBeat.heapUsed)} / 上限 ${mb(lastBeat.heapLimit)}` : '没有收到过心跳';
      try {
        fs.writeFileSync(report, [
          `Curio 异常退出：${why}`, `时间：${new Date().toLocaleString()}，本次运行 ${Math.round(ranMs / 1000)} 秒`, mem, '',
          '---- stderr 最后 200 行 ----', ...errTail, '', '---- stdout 最后 80 行 ----', ...outTail, '',
        ].join('\n'));
      } catch { /* ignore */ }
      event(planned ? 'P1' : 'P0', 'process_restart', `Agent ${why}，${Math.round(wait / 1000)} 秒后自动重启（第 ${restarts} 次）`, { code, signal, hang: killedForHang, planned, ranSec: Math.round(ranMs / 1000), crashes, report: path.basename(report), lastBeat });
      say(`Agent ${why}；崩溃报告 ${path.relative(o.cwd, report)}；${Math.round(wait / 1000)} 秒后重启`);
      timer = setTimeout(() => { timer = null; start(); }, wait);
    });
  };

  const stop = async () => {
    if (stopping) return done;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; resolveDone(); return done; }
    const c = child;
    if (!c) { resolveDone(); return done; }
    // 先请它自己存档退出（Windows 上 kill('SIGINT') 等于直接杀掉，不能用）
    try { c.send({ type: 'shutdown' }); } catch { /* IPC 断了 */ }
    const force = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 20_000);
    force.unref?.();
    return done;
  };

  start();
  return { stop, done };
}

const mb = (n) => (typeof n === 'number' ? `${Math.round(n / 1048576)} MB` : '?');

// ------------------------------------------------------------ 命令行入口
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // CURIO_ROOT：数据 + env 文件放在项目外时，用它定位模式文件。
  // 优先进程环境变量，其次读项目根目录 .env（与子进程加载顺序一致）。
  const rootEnvVars = (() => {
    const f = path.join(root, '.env');
    return fs.existsSync(f) ? parseEnv(fs.readFileSync(f, 'utf8')) : {};
  })();
  const curioRoot = (process.env.CURIO_ROOT || rootEnvVars.CURIO_ROOT || '').trim();
  const curioArg = process.argv.find((a) => a.startsWith('--curio='))?.slice('--curio='.length);
  if (curioArg) {
    if (curioArg !== 'local' && curioArg !== 'test') throw new Error(`--curio 只支持 local / test，收到：${curioArg}`);
    if (!curioRoot) throw new Error('--curio 需要 CURIO_ROOT（进程环境变量或项目根目录 .env 里设置）');
  }
  // 多个 --env-file 时最后一个才是模式覆盖文件（与 src/config.ts 一致），否则会把子进程指向公共 .env。
  const execArgvEnvFile = process.execArgv.filter((arg) => arg.startsWith('--env-file=')).map((arg) => arg.slice('--env-file='.length));
  let selectedEnv = curioArg
    ? path.join(curioRoot, `.env.${curioArg}`)
    : execArgvEnvFile[execArgvEnvFile.length - 1]
      || process.env.ENV_FILE?.trim();
  if (selectedEnv === 'local' || selectedEnv === 'test') {
    if (!curioRoot) throw new Error(`裸模式 ${selectedEnv} 需要 CURIO_ROOT（进程环境变量或项目根目录 .env 里设置）`);
    selectedEnv = path.join(curioRoot, `.env.${selectedEnv}`);
  }
  const envFile = path.resolve(root, selectedEnv || '.env');
  const hasEnv = fs.existsSync(envFile);
  if (selectedEnv && !hasEnv) throw new Error(`找不到配置文件：${envFile}`);
  // test 是宿主运行环境：写日志、启动子进程前先做完整配置与隔离校验，配置错误直接失败，不写盘、不进入崩溃重启循环。
  if (modeFrom(envFile, envVars(envFile)) === 'test') {
    const preflight = preflightConfig(envFile, root);
    if (preflight.status !== 0) {
      process.stderr.write(stripAnsi(preflight.stderr || preflight.stdout || ''));
      process.exit(preflight.status || 1);
    }
  }
  const logDir = path.join(dataDirFrom(envFile), 'logs');
  const proxy = process.argv.includes('--proxy');
  const command = [process.execPath,
    ...(hasEnv ? [`--env-file=${envFile}`] : []),
    ...(proxy ? ['--use-env-proxy'] : []),
    // Node 自己的致命错误（比如内存耗尽）会写一份诊断报告，崩溃原因不再只留在终端里
    '--report-on-fatalerror', `--report-directory=${logDir}`, '--report-compact',
    '--import', 'tsx', 'src/main.ts'];
  const s = supervise({ command, cwd: root, logDir });
  // 终端里按 Ctrl+C：子进程自己也会收到并存档退出；这里只等它，不重复发
  let interrupted = 0;
  const onSignal = () => {
    interrupted++;
    if (interrupted === 1) void s.stop();
    else process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  s.done.then(() => process.exit(0));
}
