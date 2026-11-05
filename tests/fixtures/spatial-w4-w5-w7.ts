/**
 * WP8 离线夹具：W4（行走中可见世界变化）、W5（遮挡外变化）、W7（超时/停帧/取消）
 * 与活动委托断线。
 *
 * 这些夹具刻意驱动真实 `SharedSpatialSession`（真实 SQLite Worker）、真实
 * `RouteVerifier` 与真实 `WalkRouteExecutor`；只有身体 `MoveExecutor` 是夹具。
 * 因此断言覆盖的是生产调用链上的报告/失效/控制释放语义，而不是私有函数。
 *
 * 所有事实都是离线夹具结果：不启动服务器/Bot，也不代表真实 W4/W5/W7 已运行。
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RouteVerifier,
  WalkRouteExecutor,
} from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  ChangeReport,
  CollisionShape,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  RouteVerdict,
  SectionChange,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import { SharedSpatialSession } from '../../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../../src/spatial/shared-session.ts';
import type { BlockObservation } from '../../src/adapter/types.ts';

export const WORLD = 'wp8-fixtures-world';
export const DIM = 'overworld';
export const SESSION_1 = 's1';
export const SESSION_2 = 's2';

export const ROUTE_POINTS: Vec3Like[] = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

export const BODY = {
  feet: ROUTE_POINTS[0]!,
  width: 0.6,
  height: 1.8,
  pose: 'standing' as const,
};

const EMPTY_SHAPE: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};

/** 与宿主窄步行一致：只接普通干燥整块。未知形状是能力缺口，不猜。 */
export const fixtureShapes: CollisionShapeProvider = {
  version: 'wp8-fixture-dry-full-v1',
  resolve(state) {
    const name = state.name.replace(/^minecraft:/, '');
    if (name === 'air' || name === 'cave_air') return { kind: 'shape', shape: EMPTY_SHAPE };
    if (name === 'stone' || name === 'dirt' || name === 'grass_block') return { kind: 'shape', shape: FULL_CUBE };
    return { kind: 'unsupported_shape', block: state.name, detail: `fixture does not model ${name}` };
  },
};

/** 受控模拟时钟与帧号；帧号用于记录观测到松键的帧差。 */
export class FixtureClock {
  private clock: number;
  frame = 0;

  constructor(start = 0) {
    this.clock = start;
  }

  readonly now = (): number => this.clock;

  set(value: number): void {
    this.clock = value;
  }

  tickFrame(): number {
    this.frame += 1;
    return this.frame;
  }
}

/** 一条合法视觉观测（session/dimension 与可信作用域一致）。 */
export function blockObservation(
  pos: Vec3Like,
  name: string,
  observedAt: number,
  observationId: number,
  sessionId = SESSION_1,
): BlockObservation {
  return {
    worldId: WORLD,
    sessionId,
    dimension: DIM,
    observationId,
    observedAt,
    pos: { ...pos },
    name,
    properties: {},
    stateComplete: true,
    source: 'vision',
  };
}

/** 同高干燥短走廊：支撑 y=-1，身体 y=0/1。 */
export function corridorObservations(
  sessionId: string,
  observedAt: number,
  idBase: number,
): BlockObservation[] {
  return [0, 1, 2].flatMap((x) => [
    blockObservation({ x, y: -1, z: 0 }, 'minecraft:stone', observedAt, idBase + x * 3, sessionId),
    blockObservation({ x, y: 0, z: 0 }, 'minecraft:air', observedAt, idBase + x * 3 + 1, sessionId),
    blockObservation({ x, y: 1, z: 0 }, 'minecraft:air', observedAt, idBase + x * 3 + 2, sessionId),
  ]);
}

export function routeRequest(sessionId = SESSION_1) {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId,
    mode: 'walk' as const,
    body: BODY,
    points: ROUTE_POINTS.map((point) => ({ ...point })),
    arrival: { kind: 'exact' as const },
    shapeProvider: fixtureShapes,
    deadlineMs: 10_000,
    timeoutMs: 5_000,
  };
}

export function bodySample(
  executionId: string,
  pos: Vec3Like,
  observedAt: number,
  sequence: number,
  sessionId = SESSION_1,
): BodySample {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId,
    pos: { ...pos },
    velocity: { x: 0, y: 0, z: 0 },
    observedAt,
    sequence,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    executionId,
  };
}

export interface FixtureMoveRecord {
  executionId: string;
  from: Vec3Like;
  to: Vec3Like;
  startedAt: number;
  startedFrame: number;
  stoppedAt: number | null;
  stoppedFrame: number | null;
  stopCount: number;
  abortListenersAfterRelease: number | null;
  /** 供断言读取；不进入 JSON 证据事实。 */
  signal: AbortSignal;
}

/**
 * 身体夹具：move 只按下前进键并挂起，stop 只释放自己 executionId 的控制与监听。
 * 不寻路、不挖放、不自行到达。
 */
export class FixtureMoveExecutor implements MoveExecutor {
  readonly control: Record<string, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };
  readonly moves: FixtureMoveRecord[] = [];
  private readonly pending = new Map<string, (result: ExecutableMoveResult) => void>();
  private readonly abortListeners = new Map<string, () => void>();

  constructor(private readonly clock: FixtureClock) {}

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.control.forward = true;
    // 真实身体桥会在段信号上挂监听；stop 必须把它移除以证明没有残留监听。
    const onAbort = () => {};
    request.signal.addEventListener('abort', onAbort, { once: true });
    this.abortListeners.set(request.executionId, onAbort);
    this.moves.push({
      executionId: request.executionId,
      from: { ...request.from },
      to: { ...request.to },
      startedAt: this.clock.now(),
      startedFrame: this.clock.frame,
      stoppedAt: null,
      stoppedFrame: null,
      stopCount: 0,
      abortListenersAfterRelease: null,
      signal: request.signal,
    });
    return new Promise((resolve) => {
      this.pending.set(request.executionId, resolve);
    });
  }

  stop(executionId: string): void {
    const record = this.moves.find((move) => move.executionId === executionId);
    if (record === undefined || record.stopCount > 0) return;
    record.stopCount += 1;
    record.stoppedAt = this.clock.now();
    record.stoppedFrame = this.clock.frame;
    this.control.forward = false;
    this.control.back = false;
    this.control.left = false;
    this.control.right = false;
    this.control.jump = false;
    this.control.sprint = false;
    this.control.sneak = false;
    const listener = this.abortListeners.get(executionId);
    if (listener !== undefined) {
      record.signal.removeEventListener('abort', listener);
      this.abortListeners.delete(executionId);
    }
    record.abortListenersAfterRelease = getEventListeners(record.signal, 'abort').length;
    const resolve = this.pending.get(executionId);
    if (resolve !== undefined) {
      this.pending.delete(executionId);
      resolve({ failure: { kind: 'cancelled' } });
    }
  }

  signalAborted(executionId: string): boolean {
    const record = this.moves.find((move) => move.executionId === executionId);
    return record?.signal.aborted ?? false;
  }

  listenerCount(executionId: string): number {
    const record = this.moves.find((move) => move.executionId === executionId);
    return record === undefined ? 0 : getEventListeners(record.signal, 'abort').length;
  }
}

/** 在真实会话上运行一个夹具场景；只有确认 close 干净才删除临时目录。 */
export async function withSharedSession<T>(
  now: () => number,
  run: (session: SharedSpatialSession) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-wp8-'));
  const session = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    now,
  });
  let shutdown: ShutdownResult | null = null;
  let failed = false;
  try {
    return await run(session);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      shutdown = await session.shutdown();
    } catch (error) {
      if (!failed) throw error;
    }
    const cleanClose = shutdown !== null
      && shutdown.error === null
      && shutdown.close !== null
      && shutdown.close.completed
      && shutdown.close.error === null
      && !shutdown.close.unconfirmedRequest;
    if (cleanClose) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } else if (!failed) {
      // 未确认 clean close 时保留临时目录作为诊断证据，并让夹具失败。
      throw new Error(`fixture session did not close cleanly; evidence kept at ${dir}`);
    }
  }
}

export type W4ChangeKind = 'support_removal' | 'obstacle_placed';

function changedCellOf(kind: W4ChangeKind): Vec3Like {
  return kind === 'support_removal' ? { x: 1, y: -1, z: 0 } : { x: 1, y: 0, z: 0 };
}

function changedObservation(kind: W4ChangeKind, observedAt: number, observationId: number): BlockObservation {
  return blockObservation(
    changedCellOf(kind),
    kind === 'support_removal' ? 'minecraft:air' : 'minecraft:stone',
    observedAt,
    observationId,
  );
}

/** W4：真实合法观测 → ChangeReport → 当前段停止、后续段不启动、同帧到达不误报。 */
export async function runW4Scenario(kind: W4ChangeKind) {
  const clock = new FixtureClock(0);
  return withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const initial = session.observe(corridorObservations(SESSION_1, 0, 1));
    assert.ok(initial.sections.length > 0, 'initial corridor observation must produce a real report');

    const verifier = new RouteVerifier(session.session.voxel, { now: clock.now });
    verifier.register(routeRequest());
    assert.equal(verifier.advance(8).verdict, 'OPEN');

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    let cancelCalls = 0;
    const token = session.attach({
      receiver: (report) => { walk.observe(report, 8); },
      cancel: () => { cancelCalls += 1; walk.cancel('lifecycle', 'wp8 fixture attachment cancelled'); },
    });

    const started = walk.start(routeRequest());
    walk.onSample(bodySample(started.delegationId, ROUTE_POINTS[0]!, 0, 1));
    const running = walk.advance(8);
    assert.equal(running.activeStepIndex, 0, 'first segment must be active');
    assert.equal(body.moves.length, 1);
    assert.equal(body.control.forward, true);

    // 已发生部分位移；它必须在停止后仍作为最后实测位置保留。
    walk.onSample(bodySample(started.delegationId, { x: 0.7, y: 0, z: 0.5 }, 5, 2));
    const partial = walk.status()!.lastPosition;
    assert.ok(partial !== null && Math.abs(partial.x - 0.7) < 1e-9);

    clock.set(10);
    clock.tickFrame();
    const changeFrame = clock.frame;
    const changeAt = clock.now();
    const change = changedObservation(kind, changeAt, 100);
    const report: ChangeReport = session.observe([change]);

    assert.ok(report.sections.length > 0, 'real observation must produce a non-empty ChangeReport');
    const section: SectionChange | undefined = report.sections.find((candidate) =>
      candidate.cells.some((cell) => (
        cell.pos.x === change.pos.x && cell.pos.y === change.pos.y && cell.pos.z === change.pos.z
      )),
    );
    assert.ok(section !== undefined, 'report must name the actually observed cell');
    assert.equal(section.invalidated, true);

    const changed = session.session.voxel.cellAt(DIM, change.pos.x, change.pos.y, change.pos.z);
    assert.equal(changed.observed, true);
    if (changed.observed) {
      assert.equal(changed.evidence.observation.observedAt, changeAt);
      assert.equal(changed.evidence.observation.state.name, change.name);
      assert.equal(changed.evidence.freshness, 'FRESH');
    }

    const move = body.moves[0]!;
    assert.equal(move.stopCount, 1, 'the in-flight segment must be stopped exactly once');
    assert.equal(move.stoppedFrame, changeFrame, 'control must be released in the observing frame');
    assert.equal(body.control.forward, false, 'forward must be released before this frame ends');
    assert.equal(cancelCalls, 0, 'a world change is not a lifecycle cancellation');

    const terminal = walk.status()!;
    const terminalResult = terminal.result;
    assert.ok(terminalResult !== null, 'invalidated segment must terminate the delegation');
    assert.notEqual(terminalResult.outcome, 'ARRIVED');
    assert.equal(terminal.activeStepIndex, null);

    // 同一帧迟到的到达样本不得把已失效委托改写成 ARRIVED。
    const sameFrame = walk.onSample(bodySample(started.delegationId, ROUTE_POINTS[1]!, changeAt, 3));
    assert.notEqual(sameFrame.result?.outcome, 'ARRIVED');
    assert.deepEqual(sameFrame.lastPosition, partial, 'same-frame arrival sample must not replace measured partial position');

    // 后续段不启动：即使继续推进多帧，也只有原段一次 move。
    for (let index = 0; index < 5; index += 1) {
      clock.tickFrame();
      walk.advance(8);
    }
    assert.equal(body.moves.length, 1, 'no later segment may start after invalidation');
    assert.equal(body.control.forward, false);

    const routeVerdict: RouteVerdict = walk.status()!.route.verdict;
    assert.notEqual(routeVerdict, 'OPEN');

    session.detach(token);
    return {
      kind,
      realRun: 'NOT_RUN',
      reportSource: 'SharedSpatialSession.observe(real typed BlockObservation)',
      changeObservedAt: changeAt,
      changeFrame,
      releasedFrame: move.stoppedFrame,
      releaseFrameDelta: move.stoppedFrame! - changeFrame,
      releaseWallDeltaMs: move.stoppedAt! - changeAt,
      activeSegmentStopped: move.stopCount === 1,
      stopCount: move.stopCount,
      laterSegmentsStarted: body.moves.length - 1,
      sameFrameOutcome: sameFrame.result?.outcome ?? null,
      sameFrameArrivalRejected: sameFrame.result !== null && sameFrame.result.outcome !== 'ARRIVED',
      finalOutcome: terminalResult.outcome,
      finalProblemKind: (terminalResult as { problem?: { kind?: string } }).problem?.kind ?? null,
      lastPosition: sameFrame.lastPosition,
      controlForwardAfterChange: body.control.forward,
      routeVerdict,
      cancelCalls,
    };
  });
}

/** W5：遮挡外变化在合法观测前不写入；合法观测后更新；旧证据年龄未被改写。 */
export async function runW5Scenario() {
  const clock = new FixtureClock(0);
  return withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    session.observe(corridorObservations(SESSION_1, 0, 1));

    const verifier = new RouteVerifier(session.session.voxel, { now: clock.now });
    verifier.register(routeRequest());
    const open = verifier.advance(8);
    assert.equal(open.verdict, 'OPEN');

    const support = session.session.voxel.cellAt(DIM, 1, -1, 0);
    assert.equal(support.observed, true);
    if (!support.observed) assert.fail('support must be observed');
    const oldObservedAt = support.evidence.observation.observedAt;
    const oldValidUntil = support.evidence.validUntil;
    const oldSnapshot = support.evidence;

    clock.set(5_000);
    // 世界在遮挡外已变化（模拟隐藏状态），但没有任何合法观测被交给会话。
    const hiddenWorldSupport = 'minecraft:air';
    const hiddenReport = session.observe([]);
    assert.equal(hiddenReport.sections.length, 0, 'no observation means no fact update');

    const stillOld = session.session.voxel.cellAt(DIM, 1, -1, 0);
    assert.equal(stillOld.observed, true);
    if (!stillOld.observed) assert.fail('support must still be observed');
    assert.equal(stillOld.evidence.observation.state.name, 'minecraft:stone',
      'occluded change must not be written as a fact');
    assert.equal(stillOld.evidence.observation.observedAt, oldObservedAt);
    assert.equal(stillOld.evidence.validUntil, oldValidUntil, 'old evidence age must be preserved');

    const openAfterHidden = verifier.apply(hiddenReport, 8);
    assert.ok(openAfterHidden !== null);
    assert.equal(openAfterHidden.verdict, 'OPEN', 'hidden change must not be auto-discovered');
    assert.equal(openAfterHidden.validUntil, oldValidUntil);

    clock.set(6_000);
    const change = blockObservation({ x: 1, y: -1, z: 0 }, 'minecraft:air', 6_000, 100);
    const report = session.observe([change]);
    assert.ok(report.sections.length > 0, 'a legal observation must update the fact');

    const updated = session.session.voxel.cellAt(DIM, 1, -1, 0);
    assert.equal(updated.observed, true);
    if (!updated.observed) assert.fail('updated cell must be observed');
    assert.equal(updated.evidence.observation.state.name, 'minecraft:air');
    assert.equal(updated.evidence.observation.observedAt, 6_000);
    assert.equal(updated.evidence.freshness, 'FRESH');

    const afterReport = verifier.apply(report, 8);
    assert.ok(afterReport !== null);
    assert.notEqual(afterReport.verdict, 'OPEN', 'newly observed obstruction must invalidate the route');

    // 未被重新观察的邻格仍保留原 observation 时间与有效期限，不被新观测捎带刷新。
    const unrelated = session.session.voxel.cellAt(DIM, 2, -1, 0);
    assert.equal(unrelated.observed, true);
    if (!unrelated.observed) assert.fail('unrelated support must remain observed');
    assert.equal(unrelated.evidence.observation.observedAt, oldObservedAt);
    assert.equal(unrelated.evidence.validUntil, oldValidUntil);

    // 之前取得的证据快照不因后续更新而被改写。
    assert.equal(oldSnapshot.observation.state.name, 'minecraft:stone');
    assert.equal(oldSnapshot.observation.observedAt, oldObservedAt);

    return {
      realRun: 'NOT_RUN',
      hiddenWorldSupport,
      hiddenChangeWrittenBeforeObservation: false,
      stateBeforeObservation: stillOld.evidence.observation.state.name,
      freshnessBeforeObservation: stillOld.evidence.freshness,
      reportBeforeObservation: hiddenReport.sections.length,
      ageBeforeMs: 5_000 - oldObservedAt,
      validUntilBefore: oldValidUntil,
      oldObservedAtPreserved: oldObservedAt,
      updatedObservedAt: 6_000,
      updatedState: 'minecraft:air',
      unrelatedObservedAt: unrelated.evidence.observation.observedAt,
      unrelatedValidUntil: unrelated.evidence.validUntil,
      verdictAfterLegalObservation: afterReport.verdict,
    };
  });
}

/** W7：超时/停帧时有界退出、释放控制/监听、保留最后实测位置与部分效果。 */
export async function runW7TimeoutScenario() {
  const clock = new FixtureClock(0);
  return withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    session.observe(corridorObservations(SESSION_1, 0, 1));

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    const token = session.attach({
      receiver: (report) => { walk.observe(report, 8); },
      cancel: () => { walk.cancel('lifecycle', 'wp8 timeout fixture attachment cancelled'); },
    });

    const request = { ...routeRequest(), deadlineMs: 1_000, timeoutMs: 5_000 };
    const started = walk.start(request);
    const executionId = started.delegationId;
    walk.onSample(bodySample(executionId, ROUTE_POINTS[0]!, 0, 1));
    assert.equal(walk.advance(8).activeStepIndex, 0);
    assert.equal(body.moves.length, 1);
    const activeStartFrame = clock.frame;

    // 部分位移后不再交付任何物理帧，模拟停帧。
    walk.onSample(bodySample(executionId, { x: 0.85, y: 0, z: 0.5 }, 10, 2));
    const partial = walk.status()!.lastPosition;
    assert.ok(partial !== null && Math.abs(partial.x - 0.85) < 1e-9);
    const framesWhileActive = clock.frame - activeStartFrame;
    assert.equal(framesWhileActive, 0);

    const startedExit = Date.now();
    clock.set(1_001);
    const terminal = walk.checkTimeout();
    const exitMs = Date.now() - startedExit;
    assert.ok(exitMs < 1_000, `timeout must exit boundedly (${exitMs}ms)`);
    const terminalResult = terminal.result;
    assert.ok(terminalResult !== null);
    assert.equal(terminalResult.outcome, 'TIMEOUT');
    assert.equal((terminalResult as { problem?: { kind?: string } }).problem?.kind, 'timeout');
    assert.equal(terminal.activeStepIndex, null);
    assert.deepEqual(terminal.lastPosition, partial, 'last measured position must be preserved');

    const move = body.moves[0]!;
    assert.equal(move.stopCount, 1, 'timeout must stop the active segment');
    assert.equal(body.control.forward, false, 'timeout must release control');
    assert.equal(move.abortListenersAfterRelease, 0, 'stop must remove the fixture abort listener');
    assert.equal(body.signalAborted(move.executionId), true, 'executor must abort the released segment signal');

    // 无帧时检查超时不依赖下一帧，也不得启动下一段。
    const noFramesBefore = clock.frame;
    clock.tickFrame();
    walk.advance(8);
    assert.equal(body.moves.length, 1);
    assert.equal(body.control.forward, false);
    assert.equal(walk.status()!.result?.outcome, 'TIMEOUT');
    assert.ok(clock.frame - noFramesBefore <= 1);

    session.detach(token);
    return {
      realRun: 'NOT_RUN',
      framesDeliveredWhileActive: framesWhileActive,
      timeoutExitMs: exitMs,
      outcome: terminalResult.outcome,
      problemKind: (terminalResult as { problem?: { kind?: string } }).problem?.kind ?? null,
      stopCount: move.stopCount,
      controlReleased: body.control.forward === false,
      abortListenerCountAfterRelease: move.abortListenersAfterRelease,
      signalAbortedAfterRelease: body.signalAborted(move.executionId),
      lastPosition: terminal.lastPosition,
      partialEffectPreserved: terminal.lastPosition !== null && terminal.lastPosition.x > ROUTE_POINTS[0]!.x,
      laterSegmentsStarted: body.moves.length - 1,
    };
  });
}

/** W7：没有任何物理帧时也能立即取消，不等下一帧。 */
export async function runW7NoFrameCancelScenario() {
  const clock = new FixtureClock(0);
  return withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    session.observe(corridorObservations(SESSION_1, 0, 1));

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    const token = session.attach({
      receiver: (report) => { walk.observe(report, 8); },
      cancel: () => { walk.cancel('lifecycle', 'wp8 no-frame fixture attachment cancelled'); },
    });
    walk.start(routeRequest());
    const framesBefore = clock.frame;

    const startedCancel = Date.now();
    const cancelled = walk.cancel('agent', 'no physics frame available');
    const cancelMs = Date.now() - startedCancel;

    assert.ok(cancelMs < 1_000, `cancel without a frame must return boundedly (${cancelMs}ms)`);
    assert.equal(cancelled.outcome, 'CANCELLED');
    assert.equal(walk.status()!.result?.outcome, 'CANCELLED');
    assert.equal(walk.status()!.activeStepIndex, null);
    assert.equal(body.moves.length, 0, 'no segment may start without a measured frame');
    assert.equal(body.control.forward, false);
    assert.equal(clock.frame, framesBefore, 'cancel must not wait for or advance a frame');

    // 取消后迟到的旧样本不复活委托。
    const late = walk.onSample(bodySample(walk.status()!.delegationId, ROUTE_POINTS[0]!, clock.now(), 1));
    assert.equal(late.result?.outcome, 'CANCELLED');
    assert.equal(late.lastPosition, null);

    session.detach(token);
    return {
      realRun: 'NOT_RUN',
      framesDelivered: 0,
      framesAdvancedByCancel: clock.frame - framesBefore,
      cancelMs,
      outcome: cancelled.outcome,
      movesStarted: body.moves.length,
      lastPosition: late.lastPosition,
      lateSampleOutcome: late.result?.outcome ?? null,
      lateSampleRejected: late.result?.outcome === 'CANCELLED',
    };
  });
}

/**
 * 活动委托断线：先启动真实 walk_to 等价委托，再真实 interrupt。
 * 断言旧任务取消、旧 OPEN 失效、迟到旧观测/旧样本拒绝、重连后重新准入。
 */
export async function runDisconnectDelegationScenario() {
  const clock = new FixtureClock(0);
  return withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    session.observe(corridorObservations(SESSION_1, 0, 1));

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    let cancelCalls = 0;
    session.attach({
      receiver: (report) => { walk.observe(report, 8); },
      cancel: () => { cancelCalls += 1; walk.cancel('lifecycle', 'observation scope interrupted'); },
    });

    const started = walk.start(routeRequest());
    const oldDelegationId = started.delegationId;
    walk.onSample(bodySample(oldDelegationId, ROUTE_POINTS[0]!, 0, 1));
    assert.equal(walk.advance(8).activeStepIndex, 0);
    assert.equal(body.moves.length, 1);
    walk.onSample(bodySample(oldDelegationId, { x: 0.8, y: 0, z: 0.5 }, 5, 2));
    const partial = walk.status()!.lastPosition;
    assert.ok(partial !== null);

    const oldRouteVerdictBefore: RouteVerdict = walk.status()!.route.verdict;
    assert.equal(oldRouteVerdictBefore, 'OPEN');

    clock.set(20);
    const interruptReport = session.interrupt();
    const cancelled = walk.status()!;
    const cancelledResult = cancelled.result;
    assert.ok(cancelledResult !== null);

    assert.equal(cancelCalls, 1, 'interrupt must cancel the attached delegation once');
    assert.equal(cancelledResult.outcome, 'CANCELLED');
    assert.equal((cancelledResult as { problem?: { by?: string } }).problem?.by, 'lifecycle');
    assert.equal(cancelled.activeStepIndex, null);
    assert.deepEqual(cancelled.lastPosition, partial, 'disconnect must preserve the last measured position');
    assert.equal(body.control.forward, false);
    const move = body.moves[0]!;
    assert.equal(move.stopCount, 1);
    assert.equal(move.abortListenersAfterRelease, 0);
    assert.equal(body.signalAborted(move.executionId), true);
    assert.ok(interruptReport.sections.length > 0, 'interrupt must produce a real stale report for observed cells');

    // 旧 OPEN 失效：同一委托的 route 结论不再是 OPEN。
    const oldRouteVerdictAfter: RouteVerdict = walk.status()!.route.verdict;
    assert.notEqual(oldRouteVerdictAfter, 'OPEN');

    const stale = session.session.voxel.cellAt(DIM, 1, -1, 0);
    assert.equal(stale.observed, true);
    if (stale.observed) assert.equal(stale.evidence.freshness, 'STALE');

    // 迟到旧观测：同 session/更晚时间戳也不得写入。
    const lateOldObservation = session.observe([
      blockObservation({ x: 9, y: 0, z: 0 }, 'minecraft:stone', 30, 150, SESSION_1),
    ]);
    assert.equal(lateOldObservation.sections.length, 0);
    assert.equal(session.session.voxel.cellAt(DIM, 9, 0, 0).observed, false);

    // 迟到旧样本：不得复活旧委托或改写最后实测位置。
    const lateSample = walk.onSample(bodySample(oldDelegationId, ROUTE_POINTS[1]!, 30, 3));
    assert.equal(lateSample.result?.outcome, 'CANCELLED');
    assert.deepEqual(lateSample.lastPosition, partial);

    // 重连：新 session 重新准入，旧 session 的迟到证据继续拒绝。
    clock.set(40);
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_2 });
    assert.equal(session.observationAdmitted, true);
    session.observe(corridorObservations(SESSION_2, 40, 200));
    const reobserved = session.session.voxel.cellAt(DIM, 1, -1, 0);
    assert.equal(reobserved.observed, true);
    if (reobserved.observed) {
      assert.equal(reobserved.evidence.freshness, 'FRESH');
      assert.equal(reobserved.evidence.observation.sessionId, SESSION_2);
    }
    const lateOldSession = session.observe([
      blockObservation({ x: 10, y: 0, z: 0 }, 'minecraft:dirt', 50, 250, SESSION_1),
    ]);
    assert.equal(lateOldSession.sections.length, 0);
    assert.equal(session.session.voxel.cellAt(DIM, 10, 0, 0).observed, false);

    const newBody = new FixtureMoveExecutor(clock);
    const newWalk = new WalkRouteExecutor(session.session.voxel, newBody, { now: clock.now });
    const newToken = session.attach({
      receiver: (report) => { newWalk.observe(report, 8); },
      cancel: () => { newWalk.cancel('lifecycle', 'wp8 fixture second attachment cancelled'); },
    });
    const newStarted = newWalk.start(routeRequest(SESSION_2));
    newWalk.onSample(bodySample(newStarted.delegationId, ROUTE_POINTS[0]!, 40, 1, SESSION_2));
    const newRunning = newWalk.advance(8);
    assert.equal(newRunning.activeStepIndex, 0, 'reconnected session must accept a fresh delegation');
    assert.equal(newRunning.route.verdict, 'OPEN');
    assert.equal(newBody.moves.length, 1);

    // 旧委托保持终止，不被新委托或旧 OPEN 复活。
    assert.equal(walk.status()!.result?.outcome, 'CANCELLED');
    assert.notEqual(walk.status()!.route.verdict, 'OPEN');

    newWalk.cancel('agent', 'fixture scenario complete');
    session.detach(newToken);

    return {
      realRun: 'NOT_RUN',
      oldDelegationId,
      oldRouteVerdictBefore,
      oldRouteVerdictAfter,
      cancelCalls,
      oldOutcome: cancelledResult.outcome,
      oldCancelBy: (cancelledResult as { problem?: { by?: string } }).problem?.by ?? null,
      stopCount: move.stopCount,
      controlReleased: body.control.forward === false,
      abortListenerCountAfterRelease: move.abortListenersAfterRelease,
      signalAbortedAfterRelease: body.signalAborted(move.executionId),
      lastPosition: cancelled.lastPosition,
      lateOldObservationWrote: session.session.voxel.cellAt(DIM, 9, 0, 0).observed,
      lateOldSampleOutcome: lateSample.result?.outcome ?? null,
      lateOldSessionWrote: session.session.voxel.cellAt(DIM, 10, 0, 0).observed,
      reobservedFreshness: reobserved.observed ? reobserved.evidence.freshness : null,
      reconnectedVerdict: newRunning.route.verdict,
      newDelegationStarted: newBody.moves.length === 1,
    };
  });
}
