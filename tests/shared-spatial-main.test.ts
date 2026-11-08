import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult } from 'curio-minecraft-3d-memory/storage/sqlite';
import { classifySpatialShutdown, errorFacts, spatialShutdownDiagnostics } from '../src/spatial/host-shutdown.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shared-spatial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, abs: (p: string) => p.replaceAll('\\', '/') };
}

/** 子进程只拿运行所需的系统变量，不继承任何 .env/密钥/代理设置。 */
const SYSTEM_ENV = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'ProgramFiles', 'NUMBER_OF_PROCESSORS',
];

function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SYSTEM_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** 有界地跑一个子进程；超时只终止这个子进程，并保留已收到的输出作为失败证据。 */
function runChild(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ChildRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: PROJECT, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

function checkpoint(id: string) {
  return { checkpointId: id, worldId: 'world-a', voxelRevision: 1, fragmentRevision: 2, topologyRevision: 3, journalRevision: 0, ledgerRevision: 0 };
}

function closeResult(overrides: Partial<NonNullable<ShutdownResult['close']>> = {}) {
  return { completed: true, lastConfirmedCheckpointId: 'cp-1', unconfirmedRequest: false, dirty: false, error: null, ...overrides };
}

function shutdownResult(overrides: Partial<ShutdownResult> = {}): ShutdownResult {
  return { checkpoint: checkpoint('cp-1'), error: null, cancelError: null, close: closeResult(), closeError: null, ...overrides };
}

test('分类：只有 checkpoint 被 close 确认且无错误才 ok', () => {
  const good = shutdownResult();
  assert.deepEqual(classifySpatialShutdown(good, 'world-a'), { ok: true, problems: [] });
  assert.equal(spatialShutdownDiagnostics(good, 'world-a').checkpoint?.checkpointId, 'cp-1');

  assert.equal(classifySpatialShutdown(shutdownResult({ checkpoint: null })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult({ close: null })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult({ close: closeResult({ completed: false }) })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult({ close: closeResult({ dirty: true }) })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult({ close: closeResult({ unconfirmedRequest: true }) })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult({ close: closeResult({ lastConfirmedCheckpointId: 'cp-0' }) })).ok, false);
  assert.equal(classifySpatialShutdown(shutdownResult(), 'world-b').ok, false);
});

test('诊断：主保存、取消与次关闭错误分开保留 kind/name/message', () => {
  const saveError = new PersistenceError('sql', 'final checkpoint failed');
  const cancelError = new Error('cancel handler threw');
  const closeError = new TypeError('close threw');
  const result = shutdownResult({
    checkpoint: null,
    error: saveError,
    cancelError,
    close: null,
    closeError,
  });
  const classification = classifySpatialShutdown(result, 'world-a');
  assert.equal(classification.ok, false);
  assert.deepEqual(classification.problems, ['primary_save_error', 'cancel_error', 'close_error', 'missing_checkpoint', 'missing_close_result']);

  const diagnostics = spatialShutdownDiagnostics(result, 'world-a');
  assert.deepEqual(diagnostics.primarySaveError, { kind: 'sql', name: 'PersistenceError', message: 'final checkpoint failed' });
  assert.deepEqual(diagnostics.cancelError, { kind: null, name: 'Error', message: 'cancel handler threw' });
  assert.deepEqual(diagnostics.closeError, { kind: null, name: 'TypeError', message: 'close threw' });
  assert.equal(diagnostics.close, null);
  assert.equal(diagnostics.checkpoint, null);

  const closeReported = shutdownResult({ close: closeResult({ error: saveError }) });
  assert.deepEqual(spatialShutdownDiagnostics(closeReported).close?.error, { kind: 'sql', name: 'PersistenceError', message: 'final checkpoint failed' });
  assert.equal(classifySpatialShutdown(closeReported).ok, false);
});

test('诊断：非 Error 抛出值也保留类型与内容', () => {
  const diagnostics = spatialShutdownDiagnostics(shutdownResult({ error: 'boom', cancelError: 42 }));
  assert.deepEqual(diagnostics.primarySaveError, { kind: null, name: 'string', message: 'boom' });
  assert.deepEqual(diagnostics.cancelError, { kind: null, name: 'number', message: '42' });
  assert.deepEqual(errorFacts(null), { kind: null, name: 'object', message: 'null' });
  assert.deepEqual(errorFacts(undefined), { kind: null, name: 'undefined', message: 'undefined' });

  // 普通对象与 Error 走同一份字段读取：typed 字符串字段保留，缺失时才退回类型与 String。
  assert.deepEqual(
    errorFacts({ kind: 'capacity', name: 'plain-save', message: 'retained reason', code: 'X' }),
    { kind: 'capacity', name: 'plain-save', message: 'retained reason', code: 'X' },
  );
  assert.deepEqual(errorFacts({ code: 7 }), { kind: null, name: 'object', message: '[object Object]', code: 7 });
});

test('诊断：真实会话最终 checkpoint 抛普通对象时保留字段、判非成功且真实 close 完成', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shared-spatial-'));
  const dbPath = path.join(dir, 'spatial.sqlite').replaceAll('\\', '/');
  const worldId = 'shared-spatial-plain-throw';
  let result: ShutdownResult | null = null;
  let shutdownError: unknown = null;
  try {
    const svc = await SharedSpatialSession.open({ worldId, databasePath: dbPath, timeoutMs: 5000 });
    try {
      svc.beginSession({ worldId, dim: 'overworld', sessionId: 's1' });
      svc.observe([{
        name: 'minecraft:stone',
        properties: {},
        pos: { x: 0, y: 0, z: 0 },
        worldId,
        sessionId: 's1',
        dimension: 'overworld',
        observationId: 1,
        observedAt: 1,
        source: 'vision',
        stateComplete: true,
      }]);

      const thrown = { kind: 'capacity', name: 'plain-save', message: 'retained reason', code: 'X' };
      svc.session.checkpoint = async () => { throw thrown; };

      result = await svc.shutdown();
      const diagnostics = spatialShutdownDiagnostics(result, worldId);
      assert.equal(result.error, thrown, '原始抛出对象保持同一性');
      assert.equal(diagnostics.ok, false);
      assert.ok(diagnostics.problems.includes('primary_save_error'));
      assert.deepEqual(diagnostics.primarySaveError, { kind: 'capacity', name: 'plain-save', message: 'retained reason', code: 'X' });
      assert.equal(diagnostics.checkpoint, null);
      assert.equal(result.closeError, null);
      assert.notEqual(result.close, null, '保存错误后仍须尝试真实 close');
      assert.equal(result.close!.completed, true);
      assert.equal(result.close!.error, null);
      assert.equal(result.close!.unconfirmedRequest, false);
      assert.equal(classifySpatialShutdown(result, worldId).ok, false);
    } finally {
      if (result === null) {
        try { result = await svc.shutdown(); } catch (err) { shutdownError = err; }
      }
    }
  } finally {
    const close = result?.close ?? null;
    const clean = result !== null && close !== null && close.completed
      && close.error === null && !close.unconfirmedRequest && result.closeError === null;
    if (clean) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      // 未确认真实 close 时保留 fixture，并附原始关闭诊断；不覆盖主失败。
      console.error('保留未确认关闭的 fixture:', dir, 'closeError=', result?.closeError, 'close=', close, 'shutdownError=', shutdownError);
    }
  }
});

test('主启动：真实空间库打开失败时以非零码退出，且不初始化本地记忆/计时器/Bot', async (t) => {
  const { dir, abs } = fixture(t);
  const dataDir = abs(path.join(dir, 'test', 'data'));
  const spatialPath = abs(path.join(dir, 'test', 'spatial', 'db-is-a-directory'));
  fs.mkdirSync(spatialPath, { recursive: true });

  // 只监听本机回环：记录任何 Bot 连接尝试；真实打开路径不会被替换。
  let connections = 0;
  const listener = net.createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => listener.close());
  const port = (listener.address() as net.AddressInfo).port;

  fs.writeFileSync(path.join(dir, '.env.test'), [
    'CURIO_MODE=test',
    `TEST_ROOT_DIR=${abs(path.join(dir, 'test'))}`,
    `DATA_DIR=${dataDir}`,
    `SERVER_DIR=${abs(path.join(dir, 'test', 'world'))}`,
    `AGENTS_DIR=${abs(path.join(dir, 'test', 'agents'))}`,
    `LLM_ARCHIVE_DIR=${abs(path.join(dir, 'test', 'archives', 'llm'))}`,
    `DANMAKU_ARCHIVE_DIR=${abs(path.join(dir, 'test', 'archives', 'danmaku'))}`,
    `OBSERVER_HUD_CONFIG=${abs(path.join(dir, 'test', 'live', 'hud.json'))}`,
    `SPATIAL_DB_PATH=${spatialPath}`,
    'MEMORY_WORLD_ID=shared-spatial-open-failure-fixture',
    'MC_HOST=127.0.0.1',
    `MC_PORT=${port}`,
    'RCON_HOST=127.0.0.1',
    'RCON_PORT=39001',
    'DASHBOARD_PORT=39002',
    'LLM_PROVIDER=mock',
    'OBSERVER_FEED=0',
  ].join('\n') + '\n');

  // 只观测真实原型方法：主启动若构造 WorldMemory/EpisodicMemory，这两个调用必然发生。
  const preload = path.join(dir, 'observe-memory-hooks.mjs');
  const hookEvidence = path.join(dir, 'memory-hook-evidence.json');
  const storeUrl = pathToFileURL(path.join(PROJECT, 'src', 'memory', 'store.ts')).href;
  const episodicUrl = pathToFileURL(path.join(PROJECT, 'src', 'memory', 'episodic.ts')).href;
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import { WorldMemory } from ${JSON.stringify(storeUrl)};
import { EpisodicMemory } from ${JSON.stringify(episodicUrl)};

const evidenceFile = process.env.CHILD_MEMORY_EVIDENCE;
const calls = { installed: true, flush: 0, start: 0 };
const realFlush = WorldMemory.prototype.flush;
WorldMemory.prototype.flush = function (...args) {
  calls.flush += 1;
  return realFlush.apply(this, args);
};
const realStart = EpisodicMemory.prototype.start;
EpisodicMemory.prototype.start = function (...args) {
  calls.start += 1;
  return realStart.apply(this, args);
};
if (evidenceFile) process.on('exit', () => fs.writeFileSync(evidenceFile, JSON.stringify(calls)));
`);

  const child = await runChild([
    '--import', import.meta.resolve('tsx'),
    '--import', pathToFileURL(preload).href,
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    '--curio=test',
  ], sanitizedEnv({ CURIO_ROOT: dir, CHILD_MEMORY_EVIDENCE: hookEvidence }), 20_000);

  assert.equal(child.timedOut, false, `子进程超时；stdout=${child.stdout} stderr=${child.stderr}`);
  assert.notEqual(child.code, 0, `期望非零退出，实际 ${child.code}；${child.stderr}`);
  assert.equal(connections, 0, '空间库打开失败后不应尝试连接 Bot');

  // 钩子回读作为构造证据；文件不存在/钩子未装载不能算通过。
  assert.ok(fs.existsSync(hookEvidence), `缺少钩子证据；stderr=${child.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookEvidence, 'utf8')), { installed: true, flush: 0, start: 0 });

  const line = child.stderr.split(/\r?\n/).find((entry) => entry.includes('"event":"spatial_open_failed"'));
  assert.ok(line, `缺少结构化打开失败诊断；stderr=${child.stderr}`);
  const diagnostic = JSON.parse(line);
  assert.equal(diagnostic.event, 'spatial_open_failed');
  assert.equal(diagnostic.worldId, 'shared-spatial-open-failure-fixture');
  assert.equal(diagnostic.error.name, 'PersistenceError');
  assert.equal(typeof diagnostic.error.kind, 'string');
  assert.equal(diagnostic.error.message, 'unable to open database file');

  assert.equal(fs.existsSync(path.join(dataDir, 'world-memory.json')), false, 'WorldMemory 不应被构造');
  assert.equal(fs.existsSync(path.join(dataDir, 'memory')), false, 'EpisodicMemory 不应开始归档');

  // 正向探针：同一 preload 下真实构造两者时钩子必须记到调用，证明上面的 0 不是钩子失效。
  const probeDir = path.join(dir, 'probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const probeScript = path.join(dir, 'memory-hook-probe.mts');
  const probeEvidence = path.join(dir, 'memory-hook-probe.json');
  const eventsUrl = pathToFileURL(path.join(PROJECT, 'src', 'events.ts')).href;
  const inMemoryUrl = pathToFileURL(path.join(PROJECT, 'src', 'spatial', 'in-memory.ts')).href;
  const containersUrl = pathToFileURL(path.join(PROJECT, 'src', 'memory', 'container-ledger.ts')).href;
  const semanticUrl = pathToFileURL(path.join(PROJECT, 'src', 'spatial', 'semantic-store.ts')).href;
  fs.writeFileSync(probeScript, `
import path from 'node:path';
import { WorldMemory } from ${JSON.stringify(storeUrl)};
import { EpisodicMemory } from ${JSON.stringify(episodicUrl)};
import { EventBus } from ${JSON.stringify(eventsUrl)};
import { createInMemoryLibraryStores } from ${JSON.stringify(inMemoryUrl)};
import { ContainerLedger } from ${JSON.stringify(containersUrl)};
import { SpatialSemanticStore } from ${JSON.stringify(semanticUrl)};

const dir = process.env.CHILD_PROBE_DIR;
const worldId = 'probe';
const semantic = new SpatialSemanticStore(createInMemoryLibraryStores(worldId), new ContainerLedger(null, worldId), { worldId });
const memory = new WorldMemory(path.join(dir, 'world-memory.json'), { semantic });
const episodic = new EpisodicMemory(
  { provider: 'local', worldId: 'probe', agentId: 'probe', baseUrl: '', apiKey: '', bankId: '', timeoutMs: 1000, maxContextBytes: 1024 },
  memory,
  new EventBus(),
  () => { throw new Error('probe must not read agent state'); },
  dir,
);
episodic.start();
episodic.stop();
`);
  const probe = await runChild([
    '--import', import.meta.resolve('tsx'),
    '--import', pathToFileURL(preload).href,
    probeScript,
  ], sanitizedEnv({ CHILD_PROBE_DIR: probeDir, CHILD_MEMORY_EVIDENCE: probeEvidence }), 20_000);
  assert.equal(probe.timedOut, false, `探针超时；stdout=${probe.stdout} stderr=${probe.stderr}`);
  assert.equal(probe.code, 0, `探针退出码 ${probe.code}；${probe.stderr}`);
  assert.ok(fs.existsSync(probeEvidence), `探针缺少钩子证据；stderr=${probe.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(probeEvidence, 'utf8')), { installed: true, flush: 1, start: 1 });
});

test('真实会话关停：worker 自然退出，重开数据库仍读到最终事实及其 STALE 证据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shared-spatial-'));
  const dbPath = path.join(dir, 'spatial.sqlite').replaceAll('\\', '/');
  const observedAt = 1_700_000_123_456;
  let childSucceeded = false;
  let reopenedClose: CloseResult | null = null;
  try {
  const childScript = path.join(dir, 'shutdown-child.mts');
  const sharedUrl = pathToFileURL(path.join(PROJECT, 'src', 'spatial', 'shared-session.ts')).href;
  const helperUrl = pathToFileURL(path.join(PROJECT, 'src', 'spatial', 'host-shutdown.ts')).href;
  fs.writeFileSync(childScript, `
import { SharedSpatialSession } from ${JSON.stringify(sharedUrl)};
import { spatialShutdownDiagnostics } from ${JSON.stringify(helperUrl)};

const worldId = 'shared-spatial-worker-exit';
const dim = 'overworld';
const sessionId = 'session-final';
const observedAt = Number(process.env.CHILD_OBSERVED_AT);
const spatial = await SharedSpatialSession.open({
  worldId,
  databasePath: process.env.CHILD_DB,
  now: () => observedAt,
  timeoutMs: 5000,
});
const begin = spatial.beginSession({ worldId, dim, sessionId });
const observed = spatial.observe([{
  name: 'minecraft:diamond_ore',
  properties: {},
  pos: { x: 12, y: 34, z: 56 },
  worldId,
  sessionId,
  dimension: dim,
  observationId: 77,
  observedAt,
  source: 'vision',
  stateComplete: true,
}]);
const staled = spatial.interrupt();
const result = await spatial.shutdown();
process.stdout.write(JSON.stringify({
  reports: { begin: begin.sections.length, observed: observed.sections.length, staled: staled.sections.length },
  diagnostics: spatialShutdownDiagnostics(result, worldId),
}) + '\\n');
// 不调用 process.exit：成功路径必须靠真实 close 释放 worker 后自然退出。
`);

  const child = await runChild(
    ['--import', import.meta.resolve('tsx'), childScript],
    sanitizedEnv({ CHILD_DB: dbPath, CHILD_OBSERVED_AT: String(observedAt) }),
    20_000,
  );
  assert.equal(child.timedOut, false, `worker 未自然退出；stdout=${child.stdout} stderr=${child.stderr}`);
  assert.equal(child.code, 0, `child 退出码 ${child.code}；stderr=${child.stderr}`);
  childSucceeded = true;
  const parsed = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
  assert.equal(parsed.diagnostics.ok, true, JSON.stringify(parsed.diagnostics));
  assert.equal(parsed.diagnostics.close.completed, true);
  assert.equal(parsed.diagnostics.close.dirty, false);
  assert.equal(parsed.diagnostics.primarySaveError, null);
  assert.equal(parsed.diagnostics.checkpoint.worldId, 'shared-spatial-worker-exit');
  assert.ok(parsed.reports.observed > 0, '真实观察应写入');
  assert.ok(parsed.reports.staled > 0, '中断应把证据标记为 STALE');

  const { openSpatialSession } = await import('curio-minecraft-3d-memory/storage/sqlite');
  const reopened = await openSpatialSession({ worldId: 'shared-spatial-worker-exit', databasePath: dbPath, timeoutMs: 5000 });
  let readbackError: unknown = null;
  try {
    const cell = reopened.voxel.cellAt('overworld', 12, 34, 56);
    assert.equal(cell.observed, true, '重开后应读到已提交的最终事实');
    if (cell.observed) {
      assert.equal(cell.evidence.observation.state.name, 'minecraft:diamond_ore');
      assert.equal(cell.evidence.observation.observedAt, observedAt);
      assert.equal(cell.evidence.freshness, 'STALE');
      assert.equal(cell.evidence.staleReason, 'observation_gap');
    }
  } catch (err) {
    readbackError = err;
  }
  try {
    reopenedClose = await reopened.close();
  } catch (err) {
    if (readbackError === null) throw err;
    console.error('重开后真实 close 也失败（保留主读取失败）:', err);
  }
  if (readbackError !== null) throw readbackError;
  assert.ok(reopenedClose !== null, '重开后必须取得真实 CloseResult');
  assert.equal(reopenedClose.completed, true, '重开后的真实 close 必须完成');
  assert.equal(reopenedClose.error, null);
  assert.equal(reopenedClose.unconfirmedRequest, false);
  } finally {
    const clean = childSucceeded && reopenedClose !== null && reopenedClose.completed
      && reopenedClose.error === null && !reopenedClose.unconfirmedRequest;
    if (clean) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      // 子进程失败/超时或重开 close 未确认时保留 fixture，不删除可能仍打开的库。
      console.error('保留失败 fixture:', dir, 'childSucceeded=', childSucceeded, 'reopenedClose=', reopenedClose);
    }
  }
});
