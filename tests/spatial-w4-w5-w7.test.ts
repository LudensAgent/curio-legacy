/**
 * WP8 验收：W4/W5/W7 与活动委托断线。
 *
 * 全部用例通过 tests/fixtures/spatial-w4-w5-w7.ts 驱动真实
 * SharedSpatialSession（真实 SQLite Worker）、RouteVerifier 与 WalkRouteExecutor；
 * 身体 MoveExecutor 是夹具。这里没有任何真实服务器/Bot 运行，事实统一标
 * realRun: NOT_RUN。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runDisconnectDelegationScenario,
  runW4Scenario,
  runW5Scenario,
  runW7NoFrameCancelScenario,
  runW7TimeoutScenario,
} from './fixtures/spatial-w4-w5-w7.ts';

const TMP_PREFIX = 'spatial-wp8-test-';

test('W4 拆支撑：真实观测形成 ChangeReport 后当前段停止、后续段不启动、同帧到达不误报', { timeout: 20_000 }, async () => {
  const facts = await runW4Scenario('support_removal');

  assert.equal(facts.realRun, 'NOT_RUN', 'offline fixture must not claim a real run');
  assert.match(facts.reportSource, /SharedSpatialSession\.observe/);
  assert.ok(facts.changeFrame > 0);
  assert.equal(facts.releasedFrame, facts.changeFrame, 'control release must occur in the observing frame');
  assert.equal(facts.releaseFrameDelta, 0);
  assert.equal(facts.releaseWallDeltaMs, 0);
  assert.equal(facts.stopCount, 1);
  assert.equal(facts.activeSegmentStopped, true);
  assert.equal(facts.laterSegmentsStarted, 0, 'no later segment may start');
  assert.equal(facts.sameFrameArrivalRejected, true);
  assert.equal(facts.sameFrameOutcome, 'FAILED');
  assert.notEqual(facts.finalOutcome, 'ARRIVED');
  assert.equal(facts.finalProblemKind, 'route_invalidated');
  assert.equal(facts.controlForwardAfterChange, false);
  assert.equal(facts.routeVerdict, 'BLOCKED');
  assert.ok(facts.lastPosition !== null && Math.abs(facts.lastPosition.x - 0.7) < 1e-9);
  assert.equal(facts.cancelCalls, 0);
});

test('W4 放障碍：真实观测形成 ChangeReport 后当前段停止、后续段不启动、同帧到达不误报', { timeout: 20_000 }, async () => {
  const facts = await runW4Scenario('obstacle_placed');

  assert.equal(facts.realRun, 'NOT_RUN');
  assert.equal(facts.releaseFrameDelta, 0);
  assert.equal(facts.releaseWallDeltaMs, 0);
  assert.equal(facts.stopCount, 1);
  assert.equal(facts.laterSegmentsStarted, 0);
  assert.equal(facts.sameFrameArrivalRejected, true);
  assert.equal(facts.sameFrameOutcome, 'FAILED');
  assert.notEqual(facts.finalOutcome, 'ARRIVED');
  assert.equal(facts.finalProblemKind, 'route_invalidated');
  assert.equal(facts.controlForwardAfterChange, false);
  assert.equal(facts.routeVerdict, 'BLOCKED');
});

test('W5 遮挡外变化不写入事实，合法观测后才更新，旧证据年龄保留', { timeout: 20_000 }, async () => {
  const facts = await runW5Scenario();

  assert.equal(facts.realRun, 'NOT_RUN');
  assert.equal(facts.hiddenWorldSupport, 'minecraft:air');
  assert.equal(facts.hiddenChangeWrittenBeforeObservation, false);
  assert.equal(facts.stateBeforeObservation, 'minecraft:stone');
  assert.equal(facts.freshnessBeforeObservation, 'FRESH');
  assert.equal(facts.reportBeforeObservation, 0, 'no observation means no ChangeReport');
  assert.equal(facts.ageBeforeMs, 5_000, 'old evidence age must be preserved');
  assert.equal(facts.validUntilBefore, 60_000, 'old evidence validity ceiling must not move');
  assert.equal(facts.oldObservedAtPreserved, 0);
  assert.equal(facts.updatedObservedAt, 6_000);
  assert.equal(facts.updatedState, 'minecraft:air');
  assert.equal(facts.unrelatedObservedAt, 0, 'neighbour evidence must not be refreshed by the new observation');
  assert.equal(facts.unrelatedValidUntil, 60_000);
  assert.equal(facts.verdictAfterLegalObservation, 'BLOCKED');
});

test('W7 超时/停帧：有界退出、释放控制与监听、保留最后实测位置和部分效果', { timeout: 20_000 }, async () => {
  const facts = await runW7TimeoutScenario();

  assert.equal(facts.realRun, 'NOT_RUN');
  assert.equal(facts.framesDeliveredWhileActive, 0, 'fixture must not deliver a frame after partial displacement');
  assert.ok(facts.timeoutExitMs < 1_000);
  assert.equal(facts.outcome, 'TIMEOUT');
  assert.equal(facts.problemKind, 'timeout');
  assert.equal(facts.stopCount, 1);
  assert.equal(facts.controlReleased, true);
  assert.equal(facts.abortListenerCountAfterRelease, 0);
  assert.equal(facts.signalAbortedAfterRelease, true);
  assert.ok(facts.lastPosition !== null && Math.abs(facts.lastPosition.x - 0.85) < 1e-9);
  assert.equal(facts.partialEffectPreserved, true);
  assert.equal(facts.laterSegmentsStarted, 0);
});

test('W7 无帧取消：不等下一帧即可终止，且不启动任何段', { timeout: 20_000 }, async () => {
  const facts = await runW7NoFrameCancelScenario();

  assert.equal(facts.realRun, 'NOT_RUN');
  assert.equal(facts.framesDelivered, 0);
  assert.equal(facts.framesAdvancedByCancel, 0);
  assert.ok(facts.cancelMs < 1_000);
  assert.equal(facts.outcome, 'CANCELLED');
  assert.equal(facts.movesStarted, 0);
  assert.equal(facts.lastPosition, null);
  assert.equal(facts.lateSampleOutcome, 'CANCELLED');
  assert.equal(facts.lateSampleRejected, true);
});

test('活动委托断线：旧任务取消、旧 OPEN 失效、迟到旧证据拒绝、重连重新准入', { timeout: 20_000 }, async () => {
  const facts = await runDisconnectDelegationScenario();

  assert.equal(facts.realRun, 'NOT_RUN');
  assert.equal(facts.oldRouteVerdictBefore, 'OPEN');
  assert.equal(facts.oldRouteVerdictAfter, 'STALE');
  assert.equal(facts.cancelCalls, 1);
  assert.equal(facts.oldOutcome, 'CANCELLED');
  assert.equal(facts.oldCancelBy, 'lifecycle');
  assert.equal(facts.stopCount, 1);
  assert.equal(facts.controlReleased, true);
  assert.equal(facts.abortListenerCountAfterRelease, 0);
  assert.equal(facts.signalAbortedAfterRelease, true);
  assert.ok(facts.lastPosition !== null && Math.abs(facts.lastPosition.x - 0.8) < 1e-9);
  assert.equal(facts.lateOldObservationWrote, false);
  assert.equal(facts.lateOldSampleOutcome, 'CANCELLED');
  assert.equal(facts.lateOldSessionWrote, false);
  assert.equal(facts.reobservedFreshness, 'FRESH');
  assert.equal(facts.reconnectedVerdict, 'OPEN');
  assert.equal(facts.newDelegationStarted, true);
});

test('验收脚本离线 dry-run 非零退出语义与 NOT_RUN 事实', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  try {
    const script = join(import.meta.dirname, '..', 'scripts', 'spatial-pre-real-fixtures.ts');
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', script, '--dry-run', '--evidence-dir', dir],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    assert.match(output, /offline dry-run PASS/i);

    const summaryPath = join(dir, 'summary.json');
    assert.equal(existsSync(summaryPath), true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      mode: string;
      offlineFixtures: string;
      realTestStatus: Record<string, string>;
      scenarios: Array<{ id: string; status: string }>;
    };
    assert.equal(summary.mode, 'offline_fixture');
    assert.equal(summary.offlineFixtures, 'PASS');
    for (const key of ['W4', 'W5', 'W7', 'activityDelegationDisconnect']) {
      assert.equal(summary.realTestStatus[key], 'NOT_RUN', `${key} real run must be NOT_RUN`);
    }
    assert.ok(summary.scenarios.length >= 6);
    assert.ok(summary.scenarios.every((scenario) => scenario.status === 'PASS'));

    const eventsPath = join(dir, 'events.jsonl');
    assert.equal(existsSync(eventsPath), true);
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
    assert.ok(events.length >= 6);
    for (const line of events) {
      const event = JSON.parse(line) as { realRun: string; scenario: string };
      assert.equal(event.realRun, 'NOT_RUN');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('不支持的参数使验收脚本非零退出', { timeout: 60_000 }, () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'spatial-pre-real-fixtures.ts');
  assert.throws(
    () => execFileSync(
      process.execPath,
      ['--import', 'tsx', script, '--not-a-real-option'],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', stdio: 'pipe' },
    ),
    (error: unknown) => (
      typeof error === 'object' && error !== null
      && 'status' in error && (error as { status?: number }).status === 2
    ),
  );
});