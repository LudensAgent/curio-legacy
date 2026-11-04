/**
 * spatial-soak-acceptance 的离线验收。
 *
 * 只使用临时 SQLite 数据库、真实 SharedSpatialSession/public scheduler 和纯内存
 * 指标；不连接游戏、RCON、服务器、网络或 LLM。观察数据是本文件的合成 typed
 * 离线 fixture，不是线上 Vision 或真实游戏证据。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
  startSpatialCheckpointScheduler,
  type SpatialCheckpointReport,
} from '../src/spatial/checkpoint-scheduler.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import {
  BoundedJsonlWriter,
  DEFAULT_DURATION_MS,
  FIXTURE_A,
  FIXTURE_B,
  HELP,
  MAX_EVENT_BYTES,
  MAX_JSONL_RECORD_BYTES,
  buildRunReport,
  createPhysicsTickMetrics,
  createSoakMetrics,
  decodeChunkedRecord,
  encodeChunkedRecord,
  parseCliArgs,
  shutdownFacts,
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
    '--mode=smoke',
    '--start=207.5,64,216.5',
    '--duration-ms=90000',
  ]);
  assert.deepEqual(accepted, {
    ok: true,
    help: false,
    curio: 'test',
    mode: 'smoke',
    start: { x: 207.5, y: 64, z: 216.5 },
    startRaw: '207.5,64,216.5',
    durationMs: 90000,
  });

  const endpointB = parseCliArgs(['--curio=test', '--mode=smoke', '--start=209.5,64,216.5']);
  assert.ok(endpointB.ok && !endpointB.help);
  assert.deepEqual(endpointB.start, FIXTURE_B);
  assert.deepEqual(FIXTURE_A, { x: 207.5, y: 64, z: 216.5 });

  // full 是 H2b 占位：只接受真实一小时；90s 不能被当成一次一小时运行。
  const fullAccepted = parseCliArgs(['--curio=test', '--mode=full', '--start=207.5,64,216.5']);
  assert.ok(fullAccepted.ok && !fullAccepted.help);
  assert.equal(fullAccepted.mode, 'full');
  assert.equal(fullAccepted.durationMs, 3_600_000);

  const defaulted = parseCliArgs(['--curio=test', '--mode=smoke', '--start=207.5,64,216.5']);
  assert.ok(defaulted.ok && !defaulted.help);
  assert.equal(defaulted.durationMs, DEFAULT_DURATION_MS);

  const rejected = [
    [],
    ['--curio=live', '--mode=smoke', '--start=207.5,64,216.5'],
    ['--curio=test', '--curio=test', '--mode=smoke', '--start=207.5,64,216.5'],
    ['--curio=test', '--mode=full', '--mode=smoke', '--start=207.5,64,216.5'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--nope=1'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--duration-ms=89999'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--duration-ms=3600001'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--duration-ms=90000.5'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--duration-ms=9e4'],
    // full 只允许真实一小时，避免 90s 被放大或标记为一小时运行。
    ['--curio=test', '--mode=full', '--start=207.5,64,216.5', '--duration-ms=90000'],
    ['--curio=test', '--mode=full', '--start=207.5,64,216.5', '--duration-ms=3599999'],
    // 仅接受精确夹具端点，不做附近/取整替换。
    ['--curio=test', '--mode=smoke', '--start=200.5,64,216.5'],
    ['--curio=test', '--mode=smoke', '--start=207.4,64,216.5'],
    ['--curio=test', '--mode=smoke', '--start=207.5,63,216.5'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,217.5'],
    ['--curio=test', '--mode=smoke', '--start=199.9,64,216.5'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,NaN'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,0x10'],
  ];
  for (const argv of rejected) assert.equal(parseCliArgs(argv).ok, false, `expected rejection: ${argv.join(' ')}`);
});

test('run report stays H2 pending and never claims a full pass', () => {
  const parsed = parseCliArgs(['--curio=test', '--mode=full', '--start=207.5,64,216.5']);
  assert.ok(parsed.ok && !parsed.help);
  const report = buildRunReport(parsed);
  assert.equal(report.status, 'H2_PENDING');
  assert.equal(report.fullPass, false);
  assert.equal(report.longRunCompleted, false);
  assert.equal(report.h2.state, 'pending');
  assert.equal(report.h2.fullPass, false);
  assert.equal(report.h1.state, 'implemented');
  assert.deepEqual(report.fixture.endpoints, { A: FIXTURE_A, B: FIXTURE_B });
  assert.equal(report.fixture.crossSectionX, 208);
  assert.equal(report.fixture.supportY, 63);
  assert.equal(report.fixture.bodyY, 64);
});

test('chunked evidence reconstructs large payloads exactly and detects missing parts', () => {
  const largeText = '分段证据-'.repeat(9_000);
  const payload = {
    kind: 'task-done',
    at: 1_700_000_000_123,
    eventId: 'run:event-42',
    outcome: {
      task: { id: 'walk-task-1', startedAt: 1_700_000_000_000 },
      result: { status: 'succeeded', data: { text: largeText, trace: [1, 2, 3] } },
    },
  };
  const encoded = encodeChunkedRecord('run:event-42', payload, 1_024);
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16_384);
  assert.ok(encoded.partCount > 1);
  assert.deepEqual(
    encoded.parts.map((part) => part.partIndex),
    encoded.parts.map((_, index) => index),
  );
  assert.ok(encoded.parts.every((part) => part.eventId === 'run:event-42'));
  assert.ok(encoded.parts.every((part) => part.partCount === encoded.partCount));
  assert.ok(encoded.parts.every((part) => part.payloadSha256 === encoded.payloadSha256));

  const decoded = decodeChunkedRecord(encoded.parts);
  assert.equal(decoded.ok, true, decoded.problems.join(', '));
  assert.equal(decoded.eventId, 'run:event-42');
  assert.equal(decoded.partCount, encoded.partCount);
  assert.deepEqual(decoded.payload, payload, 'original time and nested data must survive reconstruction');

  // 相同输入产生相同的分块与哈希，便于离线重建。
  assert.deepEqual(encodeChunkedRecord('run:event-42', payload, 1_024), encoded);

  const missing = encoded.parts.filter((part) => part.partIndex !== 1);
  const missingDecoded = decodeChunkedRecord(missing);
  assert.equal(missingDecoded.ok, false);
  assert.match(missingDecoded.problems.join(' '), /missing evidence chunk part 1/);
  assert.equal(missingDecoded.payload, null);

  const mismatched = encoded.parts.map((part) => part.partIndex === 2 ? { ...part, partSha256: '0'.repeat(64) } : part);
  const mismatchDecoded = decodeChunkedRecord(mismatched);
  assert.equal(mismatchDecoded.ok, false);
  assert.match(mismatchDecoded.problems.join(' '), /hash mismatch/);

  assert.throws(
    () => encodeChunkedRecord('too-big', { blob: 'x'.repeat(MAX_EVENT_BYTES + 1) }),
    RangeError,
  );
});

test('physics tick metrics aggregate actual callback timing without retaining frames', () => {
  const metrics = createPhysicsTickMetrics();
  metrics.record(1_000);
  metrics.record(1_050);
  metrics.record(1_150);
  const view = metrics.snapshot();
  assert.deepEqual(view, {
    count: 3,
    lastAt: 1_150,
    maxGapMs: 100,
    meanGapMs: 75,
    totalGapMs: 150,
    gapCount: 2,
  });
  assert.equal('frames' in metrics, false);
});

test('bounded JSONL writer owns a new file, writes unique increasing records, and rejects reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-writer-'));
  const path = join(dir, 'evidence.jsonl');
  try {
    const writer = new BoundedJsonlWriter(path, 512);
    assert.equal(MAX_JSONL_RECORD_BYTES, 64 * 1024);
    assert.equal('records' in writer, false);
    assert.equal(statSync(path).size, 0, 'writer creates its own empty evidence file');

    const first = writer.append({ kind: 'a', timestamp: 111 });
    writer.append({ kind: 'b', timestamp: 222 });
    writer.append({ kind: 'c', timestamp: 333 });
    assert.equal(first.sequence, 1);

    assert.throws(() => writer.append({ kind: 'too-big', blob: 'x'.repeat(1024) }), RangeError);
    const afterFailure = writer.append({ kind: 'after-failure', timestamp: 444 });
    assert.equal(afterFailure.sequence, 4);
    assert.equal(writer.recordsWritten, 4);
    assert.ok(writer.bytesWritten > 0);

    const bytesAtClose = writer.bytesWritten;
    writer.close();
    assert.throws(() => writer.append({ kind: 'closed' }), /closed/);

    const content = readFileSync(path, 'utf8');
    const lines = content.trimEnd().split('\n');
    assert.equal(lines.length, 4, 'oversized record must not be partially written');
    const entries = lines.map((line): unknown => JSON.parse(line)).filter(isRecord);
    assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2, 3, 4]);
    assert.equal(new Set(entries.map((entry) => entry.sequence)).size, 4, 'sequences must be unique');
    assert.ok(entries.every((entry) => typeof entry.captureTime === 'number'));
    assert.ok(entries.every((entry) => isRecord(entry.record)));
    const firstRecord = entries[0].record;
    assert.ok(isRecord(firstRecord));
    assert.equal(firstRecord.timestamp, 111, 'original payload timestamp is preserved');
    assert.ok(!lines.some((line) => line.includes('too-big')));
    assert.equal(statSync(path).size, bytesAtClose, 'byte count matches the actual file');
    assert.equal(Buffer.byteLength(content, 'utf8'), bytesAtClose);

    assert.throws(() => new BoundedJsonlWriter(path, 512), /already exists|EEXIST/);
    assert.equal(readFileSync(path, 'utf8'), content, 'a rejected second writer must not modify the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics aggregate memory, per-interval timer gap/lateness, and checkpoint timing without claiming frames or a leak', () => {
  let mono = 1_000;
  const metrics = createSoakMetrics(() => mono);
  const initial = metrics.snapshot().memory.initial;

  mono = 1_200;
  const firstSample = metrics.recordMemory();
  // 第一次回调迟到 300ms；下一次按真实上次回调计时，间隔恢复正常，不重复计入延迟。
  mono = 2_500;
  metrics.recordTimerTick(1_200, 2_500, 1_000);
  mono = 3_500;
  metrics.recordTimerTick(2_500, 3_500, 1_000);
  mono = 3_700;
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
  assert.equal(view.elapsedMs, 2_700);
  assert.deepEqual(view.timerGapMs, { count: 2, maxMs: 1_300, meanMs: 1_150, totalMs: 2_300 });
  assert.deepEqual(view.timerLatenessMs, { count: 2, maxMs: 300, meanMs: 150, totalMs: 300 });
  assert.deepEqual(view.checkpointLatencyMs, { count: 2, maxMs: 60, meanMs: 50, totalMs: 100 });
  assert.deepEqual(view.checkpointReports, { saved: 1, failed: 1 });
  assert.equal(view.gameFrames.state, 'pending');
  assert.equal(view.leakConclusion.state, 'not-concluded');
  assert.equal(view.h2.state, 'pending');
});

test('shutdown facts serialize close.error through errorFacts and keep real close fields', () => {
  const injected = new Error('boundary-injected close error (test fixture, not a worker fault)');
  injected.name = 'BoundaryInjectedError';
  const close = {
    completed: false,
    error: injected,
    dirty: true,
    unconfirmedRequest: true,
    checkpointId: 'boundary-injected-checkpoint-id',
  };
  const result = {
    checkpoint: null,
    error: null,
    cancelError: null,
    close,
    closeError: null,
  } as unknown as ShutdownResult;

  const facts = shutdownFacts(result);
  const serializedClose = facts.close;
  assert.ok(isRecord(serializedClose));
  assert.equal(serializedClose.completed, false);
  assert.equal(serializedClose.dirty, true);
  assert.equal(serializedClose.unconfirmedRequest, true);
  assert.equal(serializedClose.checkpointId, 'boundary-injected-checkpoint-id');
  assert.notEqual(serializedClose.error, injected, 'close.error must be serialized, not written raw');
  const serializedError = JSON.stringify(serializedClose.error);
  assert.ok(serializedError.includes('BoundaryInjectedError'), 'serialized error must keep its name');
  assert.ok(serializedError.includes('boundary-injected close error'), 'serialized error must keep its message');
  assert.equal(close.error, injected, 'the original error stays available outside the serialized facts');
});

test('real SQLite session reaches actual checkpoint/close and foundation writes one strictly sequenced evidence file', async () => {
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

    const rawEvidence = readFileSync(evidencePath, 'utf8');
    const entries = rawEvidence
      .trimEnd()
      .split('\n')
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord);
    assert.deepEqual(
      entries.map((entry) => entry.sequence),
      entries.map((_, index) => index + 1),
      'one writer must produce strictly increasing unique sequences starting at 1',
    );
    assert.equal(new Set(entries.map((entry) => entry.sequence)).size, entries.length);
    assert.ok(entries.every((entry) => typeof entry.captureTime === 'number'));
    assert.equal(statSync(evidencePath).size, Buffer.byteLength(rawEvidence, 'utf8'));

    const kinds = entries.map((entry) => (isRecord(entry.record) ? entry.record.kind : undefined));
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
    if (!cleanup.cleaned) console.error(`spatial soak fixture kept at ${dir}: ${cleanup.detail}`);
    if (cleanup.error !== null) console.error('fixture cleanup error:', cleanup.error);
    if (shutdown !== null && shutdown.error !== null) console.error('shutdown checkpoint error:', shutdown.error);
    if (shutdown !== null && shutdown.close !== null && shutdown.close.error !== null) {
      console.error('shutdown close error:', shutdown.close.error);
    }
    if (shutdown !== null && shutdown.closeError !== null) console.error('shutdown closeError:', shutdown.closeError);
    if (secondaryShutdownError !== null) console.error('secondary shutdown error:', secondaryShutdownError);
    throw primaryError;
  }
  assert.equal(secondaryShutdownError, null);
  assert.equal(cleanup.cleaned, true, `${cleanup.detail} (${dir})`);
  assert.equal(cleanup.error, null, `fixture cleanup failed at ${dir}: ${cleanup.detail}`);
});

test('evidence write failure is exposed immediately and real shutdown still closes cleanly', async () => {
  const worldId = 'spatial-soak-evidence-failure-world';
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-evidence-failure-'));
  const databasePath = join(dir, 'memory.db');
  const evidenceDir = join(dir, 'evidence');
  const evidencePath = join(evidenceDir, 'evidence.jsonl');
  mkdirSync(evidenceDir);

  let service: SharedSpatialSession | null = null;
  let foundation: ReturnType<typeof startSpatialSoakFoundation> | null = null;
  let shutdown: ShutdownResult | null = null;
  let primaryError: unknown = null;
  let secondaryShutdownError: unknown = null;

  try {
    service = await SharedSpatialSession.open({ worldId, databasePath });
    service.beginSession({ worldId, dim: 'overworld', sessionId: 'offline-fixture-session' });
    service.observe([offlineObservation(worldId, 11, 0, -1, 0, 'minecraft:stone')]);

    foundation = startSpatialSoakFoundation({ service, evidencePath });
    assert.equal(foundation.evidenceFailure, null);
    // 删除证据目录后，下一个周期写入真实失败（ENOENT）；调用方无需等 stop 即可看到。
    rmSync(evidenceDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.ok(foundation.evidenceFailure !== null, 'evidence failure must be visible while the run is live');
    const firstFailure = foundation.evidenceFailure;

    const stopped = await foundation.stop();
    shutdown = stopped.shutdown;
    assert.equal(stopped.evidenceError, firstFailure, 'first evidence failure must be preserved');
    assert.equal(
      typeof stopped.evidenceError === 'object' && stopped.evidenceError !== null,
      true,
      'missing evidence directory surfaces a real write error object',
    );
    assert.equal(stopped.finalMetrics.h2.fullPass, false);

    assert.equal(shutdown.error, null);
    assert.ok(shutdown.checkpoint !== null, 'final checkpoint must be real even when evidence writes failed');
    assert.ok(shutdown.close !== null);
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.unconfirmedRequest, false);
    assert.equal(shutdown.close?.dirty, false);
  } catch (error) {
    primaryError = error;
  }

  if (shutdown === null) {
    try {
      if (foundation !== null) shutdown = (await foundation.stop()).shutdown;
      else if (service !== null) shutdown = await service.shutdown();
    } catch (error) {
      secondaryShutdownError = error;
    }
  }

  const cleanup = discardFixtureAfterCleanClose(dir, shutdown);
  if (primaryError !== null) {
    if (!cleanup.cleaned) console.error(`spatial soak fixture kept at ${dir}: ${cleanup.detail}`);
    if (cleanup.error !== null) console.error('fixture cleanup error:', cleanup.error);
    if (shutdown !== null && shutdown.error !== null) console.error('shutdown checkpoint error:', shutdown.error);
    if (shutdown !== null && shutdown.close !== null && shutdown.close.error !== null) {
      console.error('shutdown close error:', shutdown.close.error);
    }
    if (shutdown !== null && shutdown.closeError !== null) console.error('shutdown closeError:', shutdown.closeError);
    if (secondaryShutdownError !== null) console.error('secondary shutdown error:', secondaryShutdownError);
    throw primaryError;
  }
  assert.equal(secondaryShutdownError, null);
  assert.equal(cleanup.cleaned, true, `${cleanup.detail} (${dir})`);
  assert.equal(cleanup.error, null, `fixture cleanup failed at ${dir}: ${cleanup.detail}`);
});

test('default 30s foundation scheduler counts a delayed accepted report before final metrics', { timeout: 35_000 }, async () => {
  const worldId = 'spatial-soak-default-interval-world';
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-default-interval-'));
  const databasePath = join(dir, 'memory.db');
  const evidencePath = join(dir, 'evidence.jsonl');

  let service: SharedSpatialSession | null = null;
  let foundation: ReturnType<typeof startSpatialSoakFoundation> | null = null;
  let shutdown: ShutdownResult | null = null;
  let primaryError: unknown = null;
  let secondaryShutdownError: unknown = null;
  let releaseDelivery: () => void = () => {};
  const deliveryReleased = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });

  try {
    assert.equal(DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS, 30_000);
    service = await SharedSpatialSession.open({ worldId, databasePath });
    service.beginSession({ worldId, dim: 'overworld', sessionId: 'offline-fixture-session' });
    service.observe([
      offlineObservation(worldId, 21, 0, -1, 0, 'minecraft:stone'),
      offlineObservation(worldId, 22, 0, 0, 0, 'minecraft:air'),
    ]);
    assert.equal(service.getPersistenceState().dirty, true, 'foundation test must begin with real dirty SQLite state');

    let resolveAccepted: () => void = () => {};
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    let checkpointCalls = 0;

    // 测试本地包装真实 public checkpoint：真实保存完成后才 resolveAccepted，并扣住
    // 结果投递，使 foundation.stop 发生时 report 仍未送达。
    const gatedService = {
      get closing() {
        return service!.closing;
      },
      session: {
        get busy() {
          return service!.session.busy;
        },
      },
      getPersistenceState: () => service!.getPersistenceState(),
      shutdown: () => service!.shutdown(),
      checkpoint: async () => {
        const result = await service!.checkpoint();
        checkpointCalls += 1;
        resolveAccepted();
        await deliveryReleased;
        return result;
      },
    } as unknown as SharedSpatialSession;

    foundation = startSpatialSoakFoundation({ service: gatedService, evidencePath });
    let acceptTimer: ReturnType<typeof setTimeout> | undefined;
    const acceptedInTime = await Promise.race([
      accepted.then(() => true),
      new Promise<boolean>((resolve) => {
        acceptTimer = setTimeout(() => resolve(false), 32_000);
      }),
    ]);
    if (acceptTimer !== undefined) clearTimeout(acceptTimer);
    assert.equal(acceptedInTime, true, 'default 30s scheduler did not accept a checkpoint within 32s');
    assert.equal(checkpointCalls, 1);

    // report 仍被扣住：stop 必须等真实 shutdown 和这次已接受的投递完成后才取最终快照。
    const stopPromise = foundation.stop();
    releaseDelivery();
    const stopped = await stopPromise;
    shutdown = stopped.shutdown;

    assert.equal(stopped.evidenceError, null);
    assert.deepEqual(stopped.finalMetrics.checkpointReports, { saved: 1, failed: 0 });
    assert.equal(stopped.finalMetrics.checkpointLatencyMs.count, 1);
    assert.equal(stopped.finalMetrics.h2.fullPass, false);

    assert.equal(shutdown.error, null);
    assert.ok(shutdown.checkpoint !== null);
    assert.ok(shutdown.close !== null);
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.unconfirmedRequest, false);
    assert.equal(shutdown.close?.dirty, false);

    const rawEvidence = readFileSync(evidencePath, 'utf8');
    const entries = rawEvidence
      .trimEnd()
      .split('\n')
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord);
    assert.deepEqual(
      entries.map((entry) => entry.sequence),
      entries.map((_, index) => index + 1),
      'evidence sequences must stay strictly increasing and unique',
    );
    assert.equal(statSync(evidencePath).size, Buffer.byteLength(rawEvidence, 'utf8'));

    const records = entries.map((entry) => entry.record).filter(isRecord);
    const schedulerRecords = records.filter((record) => record.kind === 'checkpoint-scheduler');
    assert.equal(
      schedulerRecords.length,
      stopped.finalMetrics.checkpointReports.saved + stopped.finalMetrics.checkpointReports.failed,
      'JSONL callback count must agree with final metrics',
    );
    assert.equal(schedulerRecords.length, 1);
    const schedulerReport = schedulerRecords[0].report;
    assert.ok(isRecord(schedulerReport));
    assert.equal(schedulerReport.status, 'saved');
    const reportedLatency = schedulerRecords[0].latencyMs;
    assert.ok(typeof reportedLatency === 'number');
    assert.ok(Math.abs(reportedLatency - stopped.finalMetrics.checkpointLatencyMs.totalMs) < 1e-6);

    const finalIndex = records.findIndex((record) => record.kind === 'metrics-final');
    const schedulerIndex = records.findIndex((record) => record.kind === 'checkpoint-scheduler');
    const shutdownIndex = records.findIndex((record) => record.kind === 'shutdown');
    assert.ok(schedulerIndex >= 0, 'delayed report must be written');
    assert.ok(finalIndex > schedulerIndex, 'final metrics must be captured after the delayed report');
    assert.ok(shutdownIndex > finalIndex, 'shutdown record follows final metrics');
  } catch (error) {
    primaryError = error;
  }

  releaseDelivery();
  if (shutdown === null) {
    try {
      if (foundation !== null) shutdown = (await foundation.stop()).shutdown;
      else if (service !== null) shutdown = await service.shutdown();
    } catch (error) {
      secondaryShutdownError = error;
    }
  }

  const cleanup = discardFixtureAfterCleanClose(dir, shutdown);
  if (primaryError !== null) {
    if (!cleanup.cleaned) console.error(`spatial soak fixture kept at ${dir}: ${cleanup.detail}`);
    if (cleanup.error !== null) console.error('fixture cleanup error:', cleanup.error);
    if (shutdown !== null && shutdown.error !== null) console.error('shutdown checkpoint error:', shutdown.error);
    if (shutdown !== null && shutdown.close !== null && shutdown.close.error !== null) {
      console.error('shutdown close error:', shutdown.close.error);
    }
    if (shutdown !== null && shutdown.closeError !== null) console.error('shutdown closeError:', shutdown.closeError);
    if (secondaryShutdownError !== null) console.error('secondary shutdown error:', secondaryShutdownError);
    throw primaryError;
  }
  assert.equal(secondaryShutdownError, null);
  assert.equal(cleanup.cleaned, true, `${cleanup.detail} (${dir})`);
  assert.equal(cleanup.error, null, `fixture cleanup failed at ${dir}: ${cleanup.detail}`);
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

/**
 * 只有 close 实际确认 completed=true、error=null、unconfirmedRequest=false、
 * dirty=false 时才删除临时目录；否则保留 dirty/未确认的证据与数据库，并返回
 * 可供失败断言输出的具体 shutdown/cleanup 诊断。
 */
function discardFixtureAfterCleanClose(
  dir: string,
  result: ShutdownResult | null,
): { cleaned: boolean; error: unknown; detail: string } {
  const close = result?.close ?? null;
  if (
    result === null ||
    close === null ||
    close.completed !== true ||
    close.error !== null ||
    close.unconfirmedRequest !== false ||
    close.dirty !== false
  ) {
    const closeDetail = close === null
      ? 'close=null'
      : `close.completed=${String(close.completed)} close.error=${close.error === null ? 'null' : 'present'} close.unconfirmedRequest=${String(close.unconfirmedRequest)} close.dirty=${String(close.dirty)}`;
    const resultDetail = result === null
      ? 'shutdown=null'
      : `checkpoint=${result.checkpoint === null ? 'null' : 'saved'} checkpointError=${result.error === null ? 'null' : 'present'} closeError=${result.closeError === null ? 'null' : 'present'}`;
    return { cleaned: false, error: null, detail: `fixture retained: ${resultDetail} ${closeDetail}` };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { cleaned: true, error: null, detail: 'clean close confirmed; fixture removed' };
  } catch (error) {
    return { cleaned: false, error, detail: 'clean close confirmed but fixture removal failed' };
  }
}
