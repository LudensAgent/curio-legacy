// 升级到“重启不清零”的版本之前跑一次：从正在运行的控制台读出当前的累计数字，写进 DATA_DIR/run-stats.json，
// 这样重启后死亡、token、调用次数等接着累计。只读控制台、只写这一个文件，不碰游戏进程。
// 用法：node --env-file=.env.local scripts/seed-run-stats.mjs [控制台地址] [数据目录]；默认跟随所选配置。
import fs from 'node:fs';
import path from 'node:path';
const selectedEnv = process.execArgv.find((arg) => arg.startsWith('--env-file='))?.slice('--env-file='.length)
  || process.env.ENV_FILE?.trim();
const envFile = path.resolve(selectedEnv || '.env');
const hasEnv = fs.existsSync(envFile);
if (selectedEnv && !hasEnv) throw new Error(`找不到配置文件：${envFile}`);
if (hasEnv) process.loadEnvFile(envFile);
const configuredMode = process.env.CURIO_MODE?.trim() || 'local';
if (configuredMode !== 'local' && configuredMode !== 'test') throw new Error('CURIO_MODE 必须为 local 或 test');
const mode = path.basename(envFile) === '.env.test' ? 'test' : configuredMode;
const base = process.argv[2] ?? `http://127.0.0.1:${process.env.DASHBOARD_PORT || (mode === 'test' ? 3002 : 3001)}`;
const dataDir = path.resolve(process.argv[3] ?? (process.env.DATA_DIR?.trim() || `./data/${mode}`));
const file = path.join(dataDir, 'run-stats.json');
if (fs.existsSync(file)) { console.log(`已经有 ${file}，不覆盖（新版本已经在记了）`); process.exit(0); }
const state = await (await fetch(`${base}/api/state`)).json();
const m = state.metrics;
if (!m) { console.error('控制台没有返回 metrics'); process.exit(1); }
const pick = (s) => ({ calls: s.calls, ok: s.ok, errors: s.errors, invalid: s.invalid, budgetFallbacks: s.budgetFallbacks, tokenUsage: s.tokenUsage, tiers: s.tiers, tierLatency: s.tierLatency });
const saved = {
  version: 1, startedAt: Date.now() - m.uptimeSec * 1000, savedAt: Date.now(), uptimeSec: m.uptimeSec, distance: m.distance,
  counters: { tasks: m.tasks, failCodes: m.failCodes, attempts: m.attempts, goals: m.goals, discoveries: m.discoveries, deaths: m.deaths,
    plansLlm: m.plans?.llm ?? 0, plansRule: m.plans?.rule ?? 0, intentions: m.intentions },
  planners: { main: pick(m.llm) },
};
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(saved, null, 1));
console.log(`写好了 ${file}：死亡 ${m.deaths}，LLM ${m.llm.calls} 次，${m.llm.tokenUsage.totalTokens} tokens，运行 ${Math.round(m.uptimeSec / 60)} 分钟`);
