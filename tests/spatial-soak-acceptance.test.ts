/**
 * spatial-soak-acceptance 的离线验收。
 *
 * 只使用临时 SQLite 数据库、真实 SharedSpatialSession/public scheduler 和纯内存
 * 指标；不连接游戏、RCON、服务器、网络或 LLM。观察数据是本文件的合成 typed
 * 离线 fixture，不是线上 Vision 或真实游戏证据。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSpatialCheckpointScheduler, type SpatialCheckpointReport } from '../src/spatial/checkpoint-scheduler.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import {
  BoundedJsonlWriter,
  DEFAULT_DURATION_MS,
  HELP,
  MAX_JSONL_RECORD_BYTES,
  buildRunReport,
  createSoakMetrics,
  parseCliArgs,
  startSpatialSoakFoundation,
} from '../scripts/spatial-soak-acceptance.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

test('CLI parsing accepts exact runs, rejects malformed flags, and keeps help pure', () => {
  assert.deepEqual(parseCliArgs(['--help']), { ok: true, help: true });
  assert.deepEqual(parseCliArgs(['--mode=full', '-h', '--curio=test']), { ok: true, help: true });
  assert.match(HELP, /--mode=smoke\|full/);
  assert.match(HELP, /--duration-ms=N/);
  assert.match(HELP, /without loading config, creating a DB, or opening sockets/);

  const accepted = parseCliArgs([
    '--curio=test',
    '--mode=full',
    '--start=200.5,64,217.5',
    '--duration-ms=90000',
  ]);
  assert.deepEqual(accepted, {
    ok: true,
    help: false,
    curio: 'test',
    mode: 'full',
    start: { x: 200.5, y: 64, z: 217.5 },
    startRaw: '200.5,64,217.5',
    durationMs: 90000,
  });

  const defaulted = parseCliArgs(['--curio=test', '--mode=smoke', '--start=200.5,64,216.5']);
  assert.ok(defaulted.ok && !defaulted.help);
  assert.equal(defaulted.durationMs, DEFAULT_DURATION_MS);

  const rejected = [
    [],
    ['--curio=live', '--mode=full', '--start=200.5,64,216.5'],
    ['--curio=test', '--curio=test', '--mode=full', '--start=200.5,64,216.5'],
    ['--curio=test', '--mode=full', '--mode=smoke', '--start=200.5,64,216.5'],
    ['--curio=test', '--mode=full', '--start=200.5,64,216.5', '--nope=1'],
    ['--curio=test', '--mode=full', '--start=200.5,64,216.5', '--duration-ms=89999'],
    ['--curio=test', '--mode=full', '--start=200.5,64,216.5', '--duration-ms=3600001'],
    ['--curio=test', '--mode=full', '--start=200.5,64,216.5', '--duration-ms=90000.5'],
    ['--curio=test', '--mode=full', '--start=200.5,64,216.5', '--duration-ms=9e4'],
    ['--curio=test', '--mode=full', '--start=199.9,64,216.5'],
    ['--curio=test', '--mode=full', '--start=200.5,63,216.5'],
    ['--curio=test', '--mode=full', '--start=200.5,64,218'],
    ['--curio=test', '--mode=full', '--start=200.5,64,NaN'],
    ['--curio=test', '--mode=full', '--start=200.5,64,0x10'],
  ];
  for (const argv of rejected) assert.equal(parseCliArgs(argv).ok, false, `expected rejection: ${argv.join(' ')}`);
});

test('run report stays H2 pending and never claims a full pass', () => {
  const parsed = parseCliArgs(['--curio=test', '--mode=full', '--start=200.5,64,216.5']);
  assert.ok(parsed.ok && !parsed.help);
  const report = buildRunReport(parsed);
  assert.equal(report.status, 'H2_PENDING');
  assert.equal(report.fullPass, false);
  assert.equal(report.h2.state, 'pending');
  assert.equal(report.h2.fullPass, false);
  assert.equal(report.h1.state, 'implemented');
});

test('bounded JSONL writer appends individual records and rejects oversized records before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-writer-'));
  const path = join(dir, 'evidence.jsonl');
  try {
    const writer = new BoundedJsonlWriter(path, 512);
    assert.equal(MAX_JSONL_RECORD_BYTES, 64 * 1024);
    assert.equal('records' in writer, false);

    const first = writer.append({ kind: 'a', timestamp: 111 });
    writer.append({ kind: 'b', timestamp: 222 });
    writer.append({ kind: 'c', timestamp: 333 });
    assert.equal(first.sequence, 1);

    assert.throws(() => writer.append({ kind: 'too-big', blob: 'x'.repeat(1024) }), RangeError);
    const afterFailure = writer.append({ kind: 'after-failure', timestamp: 444 });
    assert.equal(afterFailure.sequence, 4);
    assert.equal(writer.recordsWritten, 4);
    assert.ok(writer.bytesWritten > 0);

    writer.close();
    assert.throws(() => writer.append({ kind: 'closed' }), /closed/);

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 4, 'oversized record must not be partially written');
    const entries = lines.map((line): unknown => JSON.parse(line)).filter(isRecord);
    assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2, 3, 4]);
    assert.ok(entries.every((entry) => typeof entry.captureTime === 'number'));
    assert.ok(entries.every((entry) => isRecord(entry.record)));
    const firstRecord = entries[0].record;
    assert.ok(isRecord(firstRecord));
    assert.equal(firstRecord.timestamp, 111, 'original payload timestamp is preserved');
    assert.ok(!lines.some((line) => line.includes('too-big')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics aggregate memory, timer drift, and checkpoint timing without claiming frames or a leak', () => {
  let mono = 1_000;
  const metrics = createSoakMetrics(() => mono);
  const initial = metrics.snapshot().memory.initial;

  mono = 1_200;
  const firstSample = metrics.recordMemory();
  mono = 1_500;
  metrics.recordTimerTick(1_400, 1_500);
  mono = 1_800;
  metrics.recordTimerTick(1_700, 1_750);
  mono = 2_000;
  const secondSample = metrics.recordMemory();
  metrics.recordCheckpointLatency(40);
  metrics.recordCheckpointLatency(60);
  metrics.recordCheckpointReport('saved');
  metrics.recordCheckpointReport('failed');

  const view = metrics.snapshot();
  assert.deepEqual(view.memory.final, secondSample);
  assert.equal(view.memory.samples, 3);
  assert.ok(view.memory.peak.rss >= Math.max(initial.rss, firstSample.rss, secondSample.rss));
  assert.ok(view.memory.peak.heapUsed >= Math.max(initial.heapUsed, firstSample.heapUsed, secondSample.heapUsed));
  assert.equal(view.elapsedMs, 1_000);
  assert.deepEqual(view.timerDriftMs, { count: 2, maxMs: 100, meanMs: 75, totalMs: 150 });
  assert.deepEqual(view.checkpointLatencyMs, { count: 2, maxMs: 60, meanMs: 50, totalMs: 100 });
  assert.deepEqual(view.checkpointReports, { saved: 1, failed: 1 });
  assert.equal(view.gameFrames.state, 'pending');
  assert.equal(view.leakConclusion.state, 'not-concluded');
  assert.equal(view.h2.state, 'pending');
});

test('real SQLite session reaches actual checkpoint/close and foundation preserves bounded evidence', async () => {
  const worldId = 'spatial-soak-offline-fixture-world';
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-live-'));
  const databasePath = join(dir, 'memory.db');
  const evidencePath = join(dir, 'evidence.jsonl');

  let service: SharedSpatialSession | null = null;
  let shutdown: ShutdownResult | null = null;
  let primaryError: unknown = null;
  let secondaryShutdownError: unknown = null;

  try {
    service = await SharedSpatialSession.open({ worldId, databasePath });
    service.beginSession({
      worldId,
      dim: 'overworld',
      sessionId: 'offline-fixture-session',
    });
    // 合成 typed fixture，仅用于离线生命周期验证，不是真实 Vision/游戏证据。
    service.observe([
      offlineObservation(worldId, 1, 0, -1, 0, 'minecraft:stone'),
      offlineObservation(worldId, 2, 0, 0, 0, 'minecraft:air'),
      offlineObservation(worldId, 3, 0, 1, 0, 'minecraft:air'),
    ]);

    // 走真实 public scheduler 的缩短测试周期；生产 foundation 仍用默认 30s。
    let resolveFact: ((fact: SpatialCheckpointReport) => void) | undefined;
    const factPromise = new Promise<SpatialCheckpointReport>((resolve) => {
      resolveFact = resolve;
    });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => resolve(null), 5_000);
    });
    const stopScheduler = startSpatialCheckpointScheduler(
      service,
      (fact) => resolveFact?.(fact),
      20,
    );

    const fact = await Promise.race([factPromise, timeoutPromise]);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    stopScheduler();

    assert.ok(fact !== null, 'shortened scheduler did not report within 5s');
    assert.equal(fact.status, 'saved');
    if (fact.status === 'saved') {
      assert.equal(typeof fact.checkpoint.checkpointId, 'string');
      for (const key of [
        'dirty',
        'lifecycle',
        'voxelRevision',
        'confirmedVoxelRevision',
        'fragmentRevision',
        'confirmedFragmentRevision',
        'topologyRevision',
        'confirmedTopologyRevision',
        'lastConfirmedCheckpointId',
        'inFlightCheckpointId',
      ]) {
        assert.ok(key in fact.state, `scheduler state preserved ${key}`);
      }
      assert.equal(typeof fact.state.dirty, 'boolean');
      assert.equal(typeof fact.state.voxelRevision, 'number');
    }

    const fixtureWriter = new BoundedJsonlWriter(evidencePath);
    fixtureWriter.append({
      kind: 'offline-fixture',
      detail: 'synthetic typed observations for SQLite lifecycle; not live Vision or game evidence',
    });
    fixtureWriter.close();

    const foundation = startSpatialSoakFoundation({ service, evidencePath });
    const stopped = await foundation.stop();
    shutdown = stopped.shutdown;

    assert.equal(stopped.evidenceError, null, 'foundation evidence writes must not fail');
    assert.equal(stopped.h2.state, 'pending');
    assert.equal(stopped.finalMetrics.gameFrames.state, 'pending');
    assert.equal(stopped.finalMetrics.h2.fullPass, false);
    assert.equal(shutdown.error, null);
    assert.ok(shutdown.checkpoint !== null, 'shutdown must capture a real final checkpoint');
    assert.ok((shutdown.checkpoint?.voxelRevision ?? 0) > 0);
    assert.ok(shutdown.close !== null, 'shutdown must return a real close result');
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.unconfirmedRequest, false);
    assert.equal(shutdown.close?.dirty, false);

    const entries = readFileSync(evidencePath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord);
    assert.ok(entries.every((entry) => Number.isInteger(entry.sequence)));
    assert.ok(entries.every((entry) => typeof entry.captureTime === 'number'));

    const kinds = entries.map((entry) => (isRecord(entry.record) ? entry.record.kind : undefined));
    assert.equal(kinds.filter((kind) => kind === 'offline-fixture').length, 1);
    assert.ok(kinds.includes('foundation-start'));
    assert.ok(kinds.includes('memory'));
    assert.ok(kinds.includes('metrics-final'));
    assert.ok(kinds.includes('shutdown'));

    const shutdownEntry = entries.find((entry) => isRecord(entry.record) && entry.record.kind === 'shutdown');
    assert.ok(shutdownEntry !== undefined);
    assert.ok(isRecord(shutdownEntry.record));
    assert.ok(isRecord(shutdownEntry.record.shutdown));
    assert.equal(shutdownEntry.record.shutdown.finalCheckpointSaved, true);
    assert.equal(shutdownEntry.record.shutdown.close instanceof Object, true);
  } catch (error) {
    primaryError = error;
  }

  if (shutdown === null && service !== null) {
    try {
      shutdown = await service.shutdown();
    } catch (error) {
      secondaryShutdownError = error;
    }
  }

  const cleanup = discardFixtureAfterCleanClose(dir, shutdown);
  if (primaryError !== null) {
    if (!cleanup.cleaned) console.error(`spatial soak fixture kept at ${dir}`);
    if (secondaryShutdownError !== null) console.error('secondary shutdown error:', secondaryShutdownError);
    throw primaryError;
  }
  assert.equal(secondaryShutdownError, null);
  assert.equal(cleanup.error, null, `fixture cleanup failed at ${dir}`);
});

/** 构造一条显式离线的 typed BlockObservation；source 字段仅为类型形状，不代表线上能力。 */
function offlineObservation(
  worldId: string,
  observationId: number,
  x: number,
  y: number,
  z: number,
  name: string,
): BlockObservation {
  return {
    name,
    properties: {},
    worldId,
    sessionId: 'offline-fixture-session',
    dimension: 'overworld',
    source: 'vision',
    stateComplete: true,
    observedAt: 1_700_000_000_000 + observationId,
    observationId,
    pos: { x, y, z },
  };
}

/** 只有 close 实际确认干净时才删除临时目录；否则保留并返回真实错误。 */
function discardFixtureAfterCleanClose(
  dir: string,
  result: ShutdownResult | null,
): { cleaned: boolean; error: unknown } {
  if (result === null || result.close === null || result.close.completed === false || result.close.error !== null) {
    return { cleaned: false, error: null };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { cleaned: true, error: null };
  } catch (error) {
    return { cleaned: false, error };
  }
}
