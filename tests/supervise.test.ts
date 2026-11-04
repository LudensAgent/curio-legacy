import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-ignore 纯 JS 脚本
import { supervise, dataDirFrom } from '../scripts/supervise.mjs';

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

test('dataDirFrom 接受 test 模式并解析 DATA_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-dir-'));
  const envFile = path.join(root, '.env.test');
  fs.writeFileSync(envFile, 'CURIO_MODE=test\nDATA_DIR=./data/test\n');
  assert.equal(dataDirFrom(root, envFile), path.join(root, 'data', 'test'));
  // 缺 DATA_DIR 时回退到默认 data/test（按 CURIO_MODE=test）
  fs.writeFileSync(envFile, 'CURIO_MODE=test\n');
  assert.equal(dataDirFrom(root, envFile), path.join(root, 'data', 'test'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('dataDirFrom 拒绝未知模式', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervise-dir-'));
  const envFile = path.join(root, '.env.bad');
  fs.writeFileSync(envFile, 'CURIO_MODE=bad\n');
  assert.throws(() => dataDirFrom(root, envFile), /CURIO_MODE/);
  fs.rmSync(root, { recursive: true, force: true });
});
