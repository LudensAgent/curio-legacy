import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// @ts-ignore 纯 JS 脚本
import { dataDirFrom, envVars, modeFrom, preflightConfig, supervise } from '../scripts/supervise.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAKE = path.resolve('tests/fixtures/fake-agent.mjs');
function run(plan: string[], extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-'));
  const count = path.join(dir, 'count');
  const lines: string[] = [];
  const s = supervise({ command: [process.execPath, FAKE, count, ...plan], cwd: dir, logDir: path.join(dir, 'logs'), backoff: () => 50, say: (l: string) => lines.push(l), ...extra });
  const runs = () => Number(fs.readFileSync(count, 'utf8'));
  const events = () => fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith('events-'))
    .flatMap((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  return { s, dir, runs, events, lines };
}

test('a crash is reported and the agent is started again; a clean exit ends supervision', async () => {
  const r = run(['crash', 'crash', 'ok']);
  await r.s.done;
  assert.equal(r.runs(), 3);
  const ev = r.events().filter((e: any) => e.type === 'process_restart');
  assert.equal(ev.length, 2);
  assert.equal(ev[0].severity, 'P0');
  assert.equal(ev[0].data.code, 134);
  const report = fs.readFileSync(path.join(r.dir, 'logs', ev[0].data.report), 'utf8');
  assert.match(report, /JavaScript heap out of memory/);
  assert.match(fs.readdirSync(path.join(r.dir, 'logs')).join(' '), /console-err-\d{8}\.log/);
});

test('exit code 75 is a planned restart', async () => {
  const r = run(['restart', 'ok']);
  await r.s.done;
  assert.equal(r.runs(), 2);
  const ev = r.events().find((e: any) => e.type === 'process_restart');
  assert.equal(ev.data.planned, true);
  assert.equal(ev.severity, 'P1');
});

test('a hung agent (no heartbeat) is killed and restarted', async () => {
  const r = run(['hang', 'ok'], { hangMs: 300, startupMs: 300 });
  await r.s.done;
  assert.equal(r.runs(), 2);
  assert.equal(r.events().find((e: any) => e.type === 'process_restart').data.hang, true);
});

test('stop() asks the agent to save and exit instead of killing it', async () => {
  const r = run(['wait']);
  await new Promise((res) => setTimeout(res, 300));
  await r.s.stop();
  assert.equal(r.runs(), 1);
  assert.deepEqual(r.events(), []);
});

test('an agent that announced it will be busy (heap snapshot) is not killed for missing heartbeats', async () => {
  const r = run(['busy'], { hangMs: 300, startupMs: 300 });
  await r.s.done;
  assert.equal(r.runs(), 1);
  assert.deepEqual(r.events(), []);
});

test('dataDirFrom 合并公共 .env 与模式文件，与子进程解析一致', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-cfg-'));
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR=./data/common\nCURIO_MODE=local\n');
  fs.writeFileSync(path.join(root, '.env.test'), 'CURIO_MODE=test\n');
  const envFile = path.join(root, '.env.test');
  assert.equal(modeFrom(envFile, envVars(envFile)), 'test');
  assert.equal(dataDirFrom(envFile), path.join(root, 'data', 'common'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('preflightConfig 对沿用 local 目录的 test 配置返回非零（隔离校验提前失败）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-pre-'));
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR=./data/local\nSERVER_DIR=./world\nMC_PORT=25565\nRCON_PORT=25575\n');
  fs.writeFileSync(path.join(root, '.env.test'), 'MEMORY_WORLD_ID=curio-test-01\n');
  const r = preflightConfig(path.join(root, '.env.test'), REPO, { CURIO_ROOT: root });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr || r.stdout || '', /冲突|隔离|MEMORY_WORLD_ID|可写目录/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('preflightConfig 对独立合法的 test 配置返回 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-pre-'));
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR=./data/local\nSERVER_DIR=./world\nMC_PORT=25565\nRCON_PORT=25575\n');
  fs.writeFileSync(path.join(root, '.env.test'), [
    'MEMORY_WORLD_ID=curio-test-01', 'DATA_DIR=./data/test', 'SERVER_DIR=./world-test', 'MC_PORT=25566',
    'RCON_PORT=25576', 'DASHBOARD_PORT=3002', 'AGENTS_DIR=./agents/test', 'LLM_ARCHIVE_DIR=./archives/test/llm-calls',
    'DANMAKU_ARCHIVE_DIR=./archives/test/danmaku', 'OBSERVER_HUD_CONFIG=./live/observer-hud.test.json',
  ].join('\n') + '\n');
  const r = preflightConfig(path.join(root, '.env.test'), REPO, { CURIO_ROOT: root });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
});
