/**
 * spatial-soak-acceptance 的离线验收。
 *
 * 只使用临时 SQLite 数据库、真实 SharedSpatialSession/public scheduler、真实
 * 文件哈希和纯内存指标；不连接游戏、RCON、服务器、网络或 LLM。观察数据是本文件
 * 的合成 typed 离线 fixture，不是线上 Vision 或真实游戏证据。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SPATIAL_CHECKPOINT_INTERVAL_MS,
  startSpatialCheckpointScheduler,
  type SpatialCheckpointReport,
} from '../src/spatial/checkpoint-scheduler.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { WorkingSetStats } from 'curio-minecraft-3d-memory/storage/sqlite';
import {
  BoundedJsonlWriter,
  DEFAULT_DURATION_MS,
  FIXTURE_A,
  FIXTURE_B,
  H2B_REQUIRED_SCENARIOS,
  H2_PENDING,
  HELP,
  MAX_JSONL_RECORD_BYTES,
  MAX_WORKING_SET_SNAPSHOTS,
  VOXEL_LOADING_CHOICES,
  buildRunReport,
  buildSpatialOpenOptions,
  buildWorkingSetSnapshot,
  classifyDuration,
  classifyMainManualEvidence,
  classifyShutdownResult,
  collectPackageMeta,
  createEvidenceEmitter,
  createPhysicsTickMetrics,
  createSoakMetrics,
  h2ForResult,
  legFixturePoints,
  parseCliArgs,
  prepareLegStart,
  shutdownFacts,
  smokePassed,
  startSpatialSoakFoundation,
  workingSetStatsSignature,
} from '../scripts/spatial-soak-acceptance.ts';
import {
  manualScenarioSupported,
  runManualScenario,
  shutdownProblems,
} from '../scripts/spatial-soak-manual-scenario.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRangeError = (value: unknown): value is RangeError => {
  if (typeof value !== 'object' || value === null) return false;
  return value instanceof RangeError;
};

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('CLI parsing accepts exact runs, rejects malformed flags, and keeps help pure', () => {
  assert.deepEqual(parseCliArgs(['--help']), { ok: true, help: true });
  assert.deepEqual(parseCliArgs(['--mode=full', '-h', '--curio=test']), { ok: true, help: true });
  assert.match(HELP, /--mode=smoke\|full/);
  assert.match(HELP, /--duration-ms=N/);
  assert.match(HELP, /--voxel-loading=eager\|manual/);
  assert.match(HELP, /without loading config, creating a DB, or opening sockets/);
  assert.match(HELP, /64KiB/);

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
    voxelLoading: 'eager',
    voxelLoadingSource: 'default',
  });

  const endpointB = parseCliArgs(['--curio=test', '--mode=smoke', '--start=209.5,64,216.5']);
  assert.ok(endpointB.ok && !endpointB.help);
  assert.deepEqual(endpointB.start, FIXTURE_B);
  assert.deepEqual(FIXTURE_A, { x: 207.5, y: 64, z: 216.5 });

  // full 必须是真实一小时；90s 不能被当成一次一小时运行。
  const fullAccepted = parseCliArgs(['--curio=test', '--mode=full', '--start=207.5,64,216.5']);
  assert.ok(fullAccepted.ok && !fullAccepted.help);
  assert.equal(fullAccepted.mode, 'full');
  assert.equal(fullAccepted.durationMs, 3_600_000);
  // full 默认 manual；smoke 默认 eager，来源必须如实区分。
  assert.equal(fullAccepted.voxelLoading, 'manual');
  assert.equal(fullAccepted.voxelLoadingSource, 'default');

  const explicitManual = parseCliArgs([
    '--curio=test',
    '--mode=smoke',
    '--start=207.5,64,216.5',
    '--voxel-loading=manual',
  ]);
  assert.ok(explicitManual.ok && !explicitManual.help);
  assert.equal(explicitManual.voxelLoading, 'manual');
  assert.equal(explicitManual.voxelLoadingSource, 'flag');
  assert.deepEqual([...VOXEL_LOADING_CHOICES], ['eager', 'manual']);

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
    // voxel loading 只接受两个值；full 不能显式选择 eager；重复 flag 拒绝。
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--voxel-loading=sideways'],
    ['--curio=test', '--mode=full', '--start=207.5,64,216.5', '--voxel-loading=eager'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--voxel-loading=eager', '--voxel-loading=manual'],
    ['--curio=test', '--mode=smoke', '--start=207.5,64,216.5', '--voxel-loading='],
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
  assert.deepEqual(report.requiredScenarios, H2B_REQUIRED_SCENARIOS);
  assert.deepEqual(report.voxelLoading, { requested: 'manual', source: 'default', actual: null });
  assert.deepEqual(report.fixture.endpoints, { A: FIXTURE_A, B: FIXTURE_B });
  assert.equal(report.fixture.crossSectionX, 208);
  assert.equal(report.fixture.supportY, 63);
  assert.equal(report.fixture.bodyY, 64);
});

test('final H2 status is derived from the actual result, not a fixed pending constant', () => {
  // smoke 即使判据全部满足也只能是 pending/false。
  assert.deepEqual(h2ForResult('smoke', true), H2_PENDING);
  assert.equal(h2ForResult('smoke', true).fullPass, false);
  // full 未通过时同样不能宣称 passed。
  assert.deepEqual(h2ForResult('full', false), H2_PENDING);
  // 只有真实 full pass 才报告 passed/true。
  const passed = h2ForResult('full', true);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.fullPass, true);
  assert.notDeepEqual(passed, H2_PENDING);
});

test('direct JSONL evidence is human-readable and a record over 64KiB fails explicitly without truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-evidence-'));
  const evidencePath = join(dir, 'events.jsonl');
  try {
    const writer = new BoundedJsonlWriter(evidencePath);
    const emitter = createEvidenceEmitter(writer, 'run-x');
    const small = emitter.emit('sample', 'task-1', { position: { x: 207.5, y: 64, z: 216.5 }, sequence: 7 });
    assert.ok(small !== null);
    assert.equal(emitter.failure, null);

    // 一条超过 64KiB 的记录必须让本次运行显式失败，而不是分块/截断/继续。
    const oversized = emitter.emit('oversized', null, { blob: 'x'.repeat(MAX_JSONL_RECORD_BYTES) });
    assert.equal(oversized, null);
    const emitterFailure = emitter.failure;
    assert.ok(isRangeError(emitterFailure));
    assert.match(String(emitterFailure), /exceeds limit/);
    // 首个错误之后不再写任何记录（包括 run-result）。
    assert.equal(emitter.emit('run-result', null, { status: 'PASS' }), null);
    writer.close();

    const raw = readFileSync(evidencePath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    assert.equal(lines.length, 1, 'oversized record must not be written, even partially');
    const entry = JSON.parse(lines[0]) as unknown;
    assert.ok(isRecord(entry));
    assert.equal(entry.sequence, 1);
    assert.equal(typeof entry.captureTime, 'number');
    assert.ok(isRecord(entry.record));
    assert.equal(entry.record.kind, 'sample');
    assert.equal(entry.record.taskId, 'task-1');
    assert.ok(isRecord(entry.record.payload));
    assert.deepEqual(entry.record.payload.position, { x: 207.5, y: 64, z: 216.5 });
    assert.ok(!raw.includes('oversized'));
    assert.ok(!raw.includes('run-result'));
    assert.equal(MAX_JSONL_RECORD_BYTES, 64 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cleanShutdown = (over: Partial<ShutdownResult> = {}): ShutdownResult => ({
  checkpoint: {
    checkpointId: 'cp', worldId: 'world', voxelRevision: 1,
    journalRevision: 1, ledgerRevision: 1, factsRevision: 1, factsCommitted: true,
  } as NonNullable<ShutdownResult['checkpoint']>,
  error: null,
  cancelError: null,
  close: { completed: true, lastConfirmedCheckpointId: 'cp', unconfirmedRequest: false, dirty: false, error: null },
  closeError: null,
  ...over,
} as ShutdownResult);

test('shutdown classification fails every real failure surface, not just a thrown stop()', () => {
  assert.equal(classifyShutdownResult(null).ok, false);
  const clean = classifyShutdownResult(cleanShutdown());
  assert.equal(clean.ok, true, clean.problems.join(', '));
  assert.equal(clean.facts?.finalCheckpointSaved, true);

  const cases: Array<[string, ShutdownResult]> = [
    ['missing final checkpoint', cleanShutdown({ checkpoint: null })],
    ['checkpoint error', cleanShutdown({ error: new Error('save failed') })],
    ['cancel error', cleanShutdown({ cancelError: new Error('cancel failed') })],
    ['close threw', cleanShutdown({ closeError: new Error('close failed') })],
    ['missing close result', cleanShutdown({ close: null })],
    ['close incomplete', cleanShutdown({ close: { completed: false, error: null, dirty: true, unconfirmedRequest: true, checkpointId: null } as never })],
    ['close error', cleanShutdown({ close: { completed: true, error: new Error('disk'), dirty: false, unconfirmedRequest: false, checkpointId: 'c' } as never })],
  ];
  for (const [label, result] of cases) {
    assert.equal(classifyShutdownResult(result).ok, false, `${label} must fail`);
  }
  assert.match(
    classifyShutdownResult(cleanShutdown({ cancelError: new Error('cancel failed') })).problems.join(' '),
    /cancel error: .*cancel failed/,
  );
  // dirty/unconfirmed 作为事实保留；失败判据仍来自明确的 checkpoint/close 失败面。
  const dirty = classifyShutdownResult(cleanShutdown({ close: { completed: true, error: null, dirty: true, unconfirmedRequest: true, checkpointId: 'c' } as never }));
  assert.equal(dirty.ok, true);
  assert.equal((dirty.facts?.close as Record<string, unknown>).dirty, true);
  assert.equal((dirty.facts?.close as Record<string, unknown>).unconfirmedRequest, true);
});

test('manual-scenario shutdown verdict fails on a non-null cancelError', () => {
  assert.deepEqual(shutdownProblems(cleanShutdown()), []);
  const verdict = shutdownProblems(cleanShutdown({ cancelError: new Error('cancel failed') }));
  assert.deepEqual(verdict, ['cancel error']);
});

test('duration classification keeps smoke separate and refuses a short full run', () => {
  const shortFull = classifyDuration('full', 3_600_000, 90_000);
  assert.equal(shortFull.fullPassEligible, false);
  assert.equal(shortFull.durationSatisfied, false);
  assert.match(shortFull.problems.join(' '), /required 3600000ms/);

  const longFull = classifyDuration('full', 3_600_000, 3_600_000);
  assert.equal(longFull.fullPassEligible, true);
  assert.deepEqual(longFull.problems, []);

  const smoke = classifyDuration('smoke', 3_600_000, 90_000);
  assert.equal(smoke.smokeOnly, true);
  assert.equal(smoke.fullPassEligible, false);
  assert.equal(smoke.durationSatisfied, false);
  assert.deepEqual(smoke.problems, []);

  const nullElapsed = classifyDuration('full', 3_600_000, null);
  assert.equal(nullElapsed.fullPassEligible, false);
});

test('evidence-capacity overflow deterministically fails the smoke/full pass criteria', () => {
  const base = {
    primaryError: false,
    evidenceFailure: false,
    cleanupErrors: 0,
    successfulLegs: 2,
    directions: ['A->B', 'B->A'],
    queryVerifiedLegs: 2,
    savedCheckpointReports: 2,
    failedCheckpointReports: 0,
    traceCapacityExceeded: false,
  };
  assert.equal(smokePassed(base), true);
  assert.equal(smokePassed({ ...base, traceCapacityExceeded: true }), false);
  // 其他既有失败面保持不变。
  assert.equal(smokePassed({ ...base, cleanupErrors: 1 }), false);
  assert.equal(smokePassed({ ...base, successfulLegs: 1 }), false);
});

test('main working-set snapshots keep bounded counts and a resident byte estimate instead of RSS or section keys', () => {
  const stats: WorkingSetStats = {
    residentSections: 3,
    residentBytes: 4096,
    maxResidentSections: 8,
    maxResidentBytes: 1_048_576,
    lruTracked: 3,
    pinnedLeases: 1,
    pinnedSections: 1,
    observedSections: 3,
    observedCells: 48,
    residentObservedSections: 3,
    notResidentSections: 0,
    persistedSections: 3,
    pendingSections: 0,
    pendingBytes: 0,
    rejections: {
      busy: 0, closed: 0, capacity: 0, no_record: 0, not_ready: 0,
      read_failed: 0, invalid_argument: 0,
    },
    counters: {
      requestedSections: 0, alreadyResidentSections: 0, loadedSections: 0,
      loadBytes: 0, loadMs: 0, evictedSections: 0, rejectedSections: 0,
    },
  };
  const key = { worldId: 'world', dim: 'overworld', cx: 12, sy: 4, cz: 13 };
  const snapshot = buildWorkingSetSnapshot({
    label: 'leg-1',
    at: 1_000,
    activeElapsedMs: 500,
    voxelLoading: 'manual',
    stats,
    pending: {
      observations: 2,
      bytes: 512,
      countLimit: 256,
      byteLimit: 1_048_576,
      sections: [key, { ...key, cx: 13 }],
      observedAtMin: 100,
      observedAtMax: 200,
      loading: true,
    },
    unavailable: null,
  });
  assert.equal(snapshot.stats?.residentSections, 3);
  assert.equal(snapshot.stats?.residentBytesEstimate, 4096);
  assert.equal(snapshot.pending?.observations, 2);
  assert.equal(snapshot.pending?.bytes, 512);
  assert.equal(snapshot.pending?.sectionCount, 2);
  assert.equal(snapshot.pending !== null && 'sections' in snapshot.pending, false, 'section keys are not retained');
  assert.equal('rss' in snapshot, false, 'resident bytes are an estimate, not process RSS');
  assert.equal(snapshot.unavailable, null);

  const eager = buildWorkingSetSnapshot({
    label: 'eager',
    at: 2_000,
    activeElapsedMs: 1_500,
    voxelLoading: 'eager',
    stats: null,
    pending: { observations: 0, bytes: 0, sections: [], loading: false },
    unavailable: 'workingSetStats is unavailable (eager voxel loading or old host)',
  });
  assert.equal(eager.stats, null);
  assert.equal(eager.pending?.sectionCount, 0);
  assert.match(String(eager.unavailable), /eager/);
  assert.notEqual(workingSetStatsSignature(stats), workingSetStatsSignature({ ...stats, residentBytes: 4097 }));
  assert.equal(MAX_WORKING_SET_SNAPSHOTS, 32);
});

test('main manual evidence requires an actually-manual session, changed stats, and no pending before shutdown', () => {
  const base = {
    mode: 'full' as const,
    requested: 'manual' as const,
    actual: 'manual',
    statsSnapshotCount: 2,
    statsChanged: true,
    pendingBeforeShutdown: 0,
  };
  assert.deepEqual(classifyMainManualEvidence(base), { ok: true, problems: [] });

  assert.match(
    classifyMainManualEvidence({ ...base, actual: 'eager' }).problems.join(' '),
    /reports eager/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, actual: 'eager' }).problems.join(' '),
    /did not actually open with manual/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, statsSnapshotCount: 1 }).problems.join(' '),
    /fewer than two real workingSetStats/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, statsChanged: false }).problems.join(' '),
    /workingSetStats never changed/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, pendingBeforeShutdown: 3 }).problems.join(' '),
    /3 observation\(s\) were still pending/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, pendingBeforeShutdown: null }).problems.join(' '),
    /no pendingObservations snapshot/,
  );
  assert.match(
    classifyMainManualEvidence({ ...base, mode: 'smoke', requested: 'eager' }).problems.join(' '),
    /reports manual/,
  );

  const smokeEager = classifyMainManualEvidence({
    mode: 'smoke',
    requested: 'eager',
    actual: 'eager',
    statsSnapshotCount: 0,
    statsChanged: false,
    pendingBeforeShutdown: null,
  });
  assert.deepEqual(smokeEager, { ok: true, problems: [] }, 'eager smoke does not require manual evidence');
});

test('main session open options select the requested voxel loading and the opened session reports the actual mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-voxel-'));
  const diagnostics: unknown[] = [];
  try {
    const eagerOptions = buildSpatialOpenOptions(
      'soak-voxel-world',
      join(dir, 'eager.sqlite'),
      'eager',
      (diagnostic) => diagnostics.push(diagnostic),
    );
    assert.equal(eagerOptions.voxelLoading, 'eager');
    assert.equal(eagerOptions.timeoutMs, 5000);
    assert.equal(typeof eagerOptions.onWorkingSetDiagnostic, 'function');
    const eager = await SharedSpatialSession.open(eagerOptions);
    try {
      assert.equal(eager.session.voxelLoading, 'eager');
      const verdict = classifyMainManualEvidence({
        mode: 'smoke',
        requested: 'eager',
        actual: eager.session.voxelLoading,
        statsSnapshotCount: 0,
        statsChanged: false,
        pendingBeforeShutdown: null,
      });
      assert.equal(verdict.ok, true, verdict.problems.join(', '));
    } finally {
      await eager.shutdown();
    }

    // 真实打开同一个选项构造器产出的 manual 请求。宿主未合入 manual API 时，
    // 选项不会被静默当成 manual；测试据实际报告验证，而不是假定成功。
    const manualOptions = buildSpatialOpenOptions(
      'soak-voxel-world',
      join(dir, 'manual.sqlite'),
      'manual',
      (diagnostic) => diagnostics.push(diagnostic),
    );
    const manual = await SharedSpatialSession.open(manualOptions);
    try {
      if (manualScenarioSupported(SharedSpatialSession)) {
        assert.equal(manual.session.voxelLoading, 'manual');
      } else {
        assert.equal(manual.session.voxelLoading, 'eager');
        const verdict = classifyMainManualEvidence({
          mode: 'smoke',
          requested: 'manual',
          actual: manual.session.voxelLoading,
          statsSnapshotCount: 0,
          statsChanged: false,
          pendingBeforeShutdown: null,
        });
        assert.equal(verdict.ok, false);
        assert.match(verdict.problems.join(' '), /reports eager/);
      }
    } finally {
      await manual.shutdown();
    }
    assert.deepEqual(diagnostics, [], 'no capacity diagnostics for these empty sessions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package metadata is verified against actual tarball bytes, lock entry, and provenance', () => {
  const repo = collectPackageMeta(REPO_ROOT);
  assert.equal(repo.name, 'curio-minecraft-3d-memory');
  assert.equal(repo.checks.tgzSha256, 'verified');
  assert.equal(repo.checks.tgzSha512, 'verified');
  assert.equal(repo.checks.lockEntry, 'verified');
  assert.equal(repo.checks.provenance, 'verified');
  assert.equal(repo.provenance.artifactSHA256, repo.tgz.sha256);
  assert.equal(repo.provenance.npmIntegrity, repo.lock.integrity);
  const actual = readFileSync(resolve(REPO_ROOT, repo.tgz.path));
  assert.equal(createHash('sha256').update(actual).digest('hex'), repo.tgz.sha256);
  assert.equal(`sha512-${createHash('sha512').update(actual).digest('base64')}`, repo.tgz.integrity);
});

test('package metadata rejects a tampered provenance hash or lock integrity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-package-'));
  try {
    const name = 'curio-minecraft-3d-memory';
    const version = '9.9.9';
    const spec = `file:vendor/${name}-${version}.tgz`;
    const tgzBytes = Buffer.from('offline fixture tarball bytes; not a real package', 'utf8');
    const tgzSha256 = createHash('sha256').update(tgzBytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(tgzBytes).digest('base64')}`;
    const sourceHEAD = 'a'.repeat(40);

    mkdirSync(join(dir, 'vendor'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'vendor', `${name}-${version}.tgz`), tgzBytes);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: spec } }, null, 2));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      packages: {
        '': { dependencies: { [name]: spec } },
        [`node_modules/${name}`]: { version, resolved: spec, integrity },
      },
    }, null, 2));
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }, null, 2));
    const provenancePath = join(dir, 'vendor', `${name}-${version}.provenance.json`);
    writeFileSync(provenancePath, JSON.stringify({
      package: { name, version },
      sourceHEAD,
      artifactSHA256: tgzSha256,
      npmIntegrity: integrity,
      sourceBinding: { clean: true, head: sourceHEAD },
    }, null, 2));

    const verified = collectPackageMeta(dir);
    assert.equal(verified.checks.tgzSha256, 'verified');
    assert.equal(verified.provenance.tracked, false);
    assert.equal(verified.tgz.sha256, tgzSha256);

    writeFileSync(provenancePath, JSON.stringify({
      package: { name, version },
      sourceHEAD,
      artifactSHA256: '0'.repeat(64),
      npmIntegrity: integrity,
      sourceBinding: { clean: true, head: sourceHEAD },
    }, null, 2));
    assert.throws(() => collectPackageMeta(dir), /artifactSHA256/);

    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      packages: {
        '': { dependencies: { [name]: spec } },
        [`node_modules/${name}`]: { version, resolved: spec, integrity: 'sha512-AAAA' },
      },
    }, null, 2));
    assert.throws(() => collectPackageMeta(dir), /package-lock integrity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual residency scenario reports not-integrated when the real manual API is absent', async (t) => {
  if (manualScenarioSupported(SharedSpatialSession)) {
    t.skip('real manual API is present; covered by the manual success-path test');
    return;
  }
  const result = await runManualScenario({
    worldId: 'manual-offline-world',
    databasePath: join(tmpdir(), 'unused-manual.sqlite'),
    scope: { worldId: 'manual-offline-world', dim: 'overworld', sessionId: 'offline' },
    observe: () => [],
    emit: () => {},
  });
  assert.equal(result.state, 'not-integrated');
  assert.equal(result.ok, false, 'manual must never be reported as passed without the real API');
  assert.match(result.problems.join(' '), /not integrated/);
});

test('manual residency scenario passes offline with real handoff, lease and shutdown facts', { timeout: 30_000 }, async (t) => {
  if (!manualScenarioSupported(SharedSpatialSession)) {
    t.skip('host has no real manual SharedSpatialSession API; run this test in the integration worktree');
    return;
  }
  const worldId = 'manual-offline-fixture-world';
  const dir = mkdtempSync(join(tmpdir(), 'spatial-soak-manual-'));
  const databasePath = join(dir, 'manual.sqlite');
  const scope = { worldId, dim: 'overworld', sessionId: 'offline-fixture-session' };
  const emissions: { kind: string; payload: unknown }[] = [];
  try {
    // 合成 typed 观测，但会话、prepare/lease、pending handoff、checkpoint 和
    // shutdown 全部来自真实 manual SharedSpatialSession 与真实 SQLite 文件。
    // 重开后的重观测必须像真实 Vision 一样带更新的 observedAt；相同时间戳会被库
    // 视为已保存证据的重复确认，保留 STALE，而不是恢复 FRESH。
    const observedBatches: BlockObservation[][] = [];
    const observe = () => {
      const base = observedBatches.length === 0 ? 41 : 51;
      const batch = [
        offlineObservation(worldId, base, 0, 0, 0, 'minecraft:stone'),
        offlineObservation(worldId, base + 1, 1, 0, 0, 'minecraft:air'),
      ];
      observedBatches.push(batch);
      return batch;
    };
    const result = await runManualScenario({
      worldId,
      databasePath,
      scope,
      observe,
      emit: (kind, payload) => { emissions.push({ kind, payload }); },
      drainTimeoutMs: 15_000,
    });

    assert.equal(result.state, 'passed', result.problems.join(', '));
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.facts.supported, true);
    assert.equal(typeof result.facts.firstCheckpointId, 'string');
    assert.equal(result.facts.sectionResidencyAfterReopen, 'not_resident');
    assert.equal(result.facts.pendingAfterObserve, observedBatches[1]!.length);
    assert.equal(result.facts.pendingDrained, true);
    assert.equal(result.facts.reobservedObservedAt, observedBatches[1]![0]!.observedAt);
    assert.equal(result.facts.reobservedFreshness, 'FRESH');
    assert.equal(result.facts.reobservedSessionId, scope.sessionId);
    assert.equal(result.facts.pendingBeforeShutdown, 0);
    assert.equal(result.facts.unreleasedPins, 0);

    const prepare = result.facts.prepare;
    assert.ok(isRecord(prepare));
    assert.equal(prepare.status, 'ready');
    assert.equal(typeof prepare.lease, 'string');
    const statsPinned = result.facts.statsPinned;
    assert.ok(isRecord(statsPinned));
    assert.ok(typeof statsPinned.pinnedLeases === 'number' && statsPinned.pinnedLeases >= 1);
    const statsAfterRelease = result.facts.statsAfterRelease;
    assert.ok(isRecord(statsAfterRelease));
    assert.equal(statsAfterRelease.pinnedLeases, 0);

    const firstShutdown = result.facts.firstShutdown;
    assert.ok(isRecord(firstShutdown));
    assert.equal(firstShutdown.error, null);
    assert.equal(typeof firstShutdown.checkpoint, 'string');
    const secondShutdown = result.facts.secondShutdown;
    assert.ok(isRecord(secondShutdown));
    assert.equal(secondShutdown.error, null);
    assert.equal(typeof secondShutdown.checkpoint, 'string');
    const secondClose = secondShutdown.close;
    assert.ok(isRecord(secondClose));
    assert.equal(secondClose.completed, true);
    assert.equal(secondClose.error, null);

    assert.equal(emissions.length, 1);
    assert.equal(emissions[0]!.kind, 'scenario-manual');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
        'journalRevision',
        'confirmedJournalRevision',
        'ledgerRevision',
        'confirmedLedgerRevision',
        'factsRevision',
        'confirmedFactsRevision',
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
    assert.equal(classifyShutdownResult(shutdown).ok, true);

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
