/**
 * Fluid handover regression: a late cancelled public `swim_to` must not keep or
 * re-acquire ownership of the real MineflayerAdapter controls, and its delayed
 * async resumption must not feed samples, reports or map writes into the shared
 * `walk_route` replacement.
 *
 * This uses the production call chain, not a copied algorithm:
 *   - real Arbiter.start and the registered public swim_to → walk_route skills;
 *   - real MineflayerAdapter swimTo/walkBody/walkTick/stopAll with its real
 *     action-ownership epoch (only bot/world/physics are a low-level fixture);
 *   - real Vision as the only spatial writer and a real SharedSpatialSession
 *     backed by an actual SQLite Worker.
 *
 * Timing evidence is collected as control-log/timeline indices and real wall
 * timestamps, not by searching log strings. The old swim's own `waitForTicks`
 * Promise is left unresolved across window A and only released in window B.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as tickImmediate } from 'node:timers/promises';
import { Vec3 } from 'vec3';
import { GROUNDED_ARRIVAL_DEFAULTS, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { BodySample, ChangeReport } from 'curio-minecraft-3d-memory';
import { Arbiter, type TaskInfo, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { spatialShutdownDiagnostics } from '../src/spatial/host-shutdown.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics') as {
  Physics: (d: unknown, w: unknown) => { simulatePlayer(ps: unknown, w: unknown): { apply(bot: unknown): void } };
  PlayerState: new (bot: unknown, control: Record<string, boolean>) => unknown;
};

const STONE = data.blocksByName.stone.defaultState as number;
const AIR = data.blocksByName.air.defaultState as number;
/** Same-height dry route on the flat stone floor (feet y=0, support y=-1). */
const POINTS = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }];
const SWIM_TARGET = { x: 6.5, y: 0, z: 0.5 };

function flatBlock(x: number, y: number, z: number) {
  const block = Block.fromStateId(y <= -1 ? STONE : AIR, 0);
  block.position = new Vec3(x, y, z);
  return block;
}

/** Real prismarine-physics world shared by the body simulation and the adapter optics. */
const physicsWorld = {
  getBlock(position: { floored(): { x: number; y: number; z: number } }) {
    const p = position.floored();
    return flatBlock(p.x, p.y, p.z);
  },
};

/** Adapter optics/light surface that reads the same world as the physics simulator. */
const botWorld = {
  getColumnAt: () => ({}),
  getBlockStateId: (v: { y: number }) => (v.y <= -1 ? STONE : AIR),
  getBlockLight: () => 0,
  getSkyLight: () => 15,
};

interface ControlEvent { kind: 'set' | 'clear'; name?: string; value?: boolean; at: number }

/**
 * Low-level bot fixture. Everything above it (Arbiter, skills, adapter action
 * ownership, Vision, shared session) is production code. `look` can be held at
 * the pre-scan boundary and `waitForTicks` is a single deferred Promise that is
 * only released in window B.
 */
class HandoverBot extends EventEmitter {
  readonly version = '1.20.1';
  readonly username = 'HandoverProbe';
  readonly game = { dimension: 'overworld' };
  readonly entity = {
    position: new Vec3(0.54, 0, 0.52),
    velocity: new Vec3(0, 0, 0),
    eyeHeight: 1.62,
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: false,
    yaw: 0,
    pitch: 0,
    effects: {},
    attributes: {},
  };
  readonly controls: Record<string, boolean> = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  readonly controlLog: ControlEvent[] = [];
  readonly inventory = { slots: [] as unknown[], items: () => [] as unknown[], emptySlotCount: () => 0 };
  readonly pathfinder = { setGoal(_goal: unknown) {}, stop() {} };
  readonly time = { age: 0, timeOfDay: 6000, day: 1 };
  readonly world = botWorld;
  health = 20;
  food = 20;
  oxygenLevel = 17;
  jumpTicks = 0;
  jumpQueued = false;
  fireworkRocketDuration = 0;

  holdLook = false;
  onLookHeld: (() => void) | null = null;
  onSwimWait: (() => void) | null = null;
  private pendingLook: { yaw: number; pitch: number; resolve: () => void } | null = null;
  private resolveSwimWait!: () => void;
  private readonly swimWait = new Promise<void>((resolve) => { this.resolveSwimWait = resolve; });

  constructor(private readonly now: () => number) {
    super();
  }

  blockAt(p: { x: number; y: number; z: number }) {
    return flatBlock(p.x, p.y, p.z);
  }

  setControlState(name: string, value: boolean) {
    this.controls[name] = value;
    this.controlLog.push({ kind: 'set', name, value, at: this.now() });
  }

  clearControlStates() {
    for (const key of Object.keys(this.controls)) this.controls[key] = false;
    this.controlLog.push({ kind: 'clear', at: this.now() });
  }

  look(yaw: number, pitch: number, _force?: boolean): Promise<void> {
    if (this.holdLook) {
      this.holdLook = false;
      return new Promise<void>((resolve) => {
        this.pendingLook = { yaw, pitch, resolve };
        this.onLookHeld?.();
        this.onLookHeld = null;
      });
    }
    this.entity.yaw = yaw;
    this.entity.pitch = pitch;
    return Promise.resolve();
  }

  lookPending(): boolean {
    return this.pendingLook !== null;
  }

  releaseHeldLook() {
    const pending = this.pendingLook;
    this.pendingLook = null;
    if (!pending) return;
    this.entity.yaw = pending.yaw;
    this.entity.pitch = pending.pitch;
    pending.resolve();
  }

  /** The old swim's real physics wait. It stays unresolved until window B. */
  waitForTicks(_count: number): Promise<void> {
    this.onSwimWait?.();
    this.onSwimWait = null;
    return this.swimWait;
  }

  releaseSwimWait() {
    this.resolveSwimWait();
  }
}

function started(info: ReturnType<Arbiter['start']>): TaskInfo {
  if ('error' in info) assert.fail(`task rejected: ${info.error}`);
  return info;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await tickImmediate();
}

/** Bounded wait for a Promise so a wiring gap fails instead of hanging the run. */
function withDeadline<T>(p: Promise<T>, what: string, ms = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      settle();
    };
    p.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

interface OldPartial {
  landed: boolean;
  target: { x: number; y: number; z: number };
  pos: { x: number; y: number; z: number };
  oxygen: number;
  observedAt: number;
}

interface NavData { outcome: string; message?: string; lastPosition?: { x: number; y: number; z: number } }

test('late cancelled swim_to cannot own or contaminate a shared walk_route replacement', { timeout: 30000 }, async (t) => {
  const clock = { now: 1_000_000 };
  t.mock.method(Date, 'now', () => clock.now);

  const bot = new HandoverBot(() => clock.now);
  let onboardSwimWait: (() => void) | null = null;
  bot.onSwimWait = () => onboardSwimWait?.();
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = data;
  Reflect.set(adapter, 'connectedFlag', true);
  Reflect.set(adapter, 'spawned', true);

  const worldId = adapter.state().worldId;
  const dim = adapter.state().dim;
  const physics = Physics(data, physicsWorld);

  // The only async physics drive: emits the same `physicsTick` event the real
  // adapter listens to, so only an awaited walkTick is ever honoured.
  let frames = 0;
  const simulateFrame = () => {
    frames++;
    clock.now += 50;
    physics.simulatePlayer(new PlayerState(bot, bot.controls), physicsWorld).apply(bot);
    bot.emit('physicsTick');
  };

  // Patch the real loop's instance methods only for this process-local test.
  const prototype = WalkRouteExecutor.prototype;
  const originalOnSample = prototype.onSample;
  const originalObserve = prototype.observe;
  let samples = 0;
  let loopObserves = 0;
  prototype.onSample = function onSampleWrapped(this: WalkRouteExecutor, sample: BodySample) {
    samples++;
    return originalOnSample.call(this, sample);
  };
  prototype.observe = function observeWrapped(this: WalkRouteExecutor, report: ChangeReport, budget: number) {
    loopObserves++;
    return originalObserve.call(this, report, budget);
  };

  let arbiter: Arbiter | null = null;
  let memory: WorldMemory | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'shared-fluid-handover-'));
  let svc: SharedSpatialSession | null = null;
  let cleanClosed = false;
  let shutdownFinished = false;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let activeTaskId: string | null = null;

  // Outcome collection lives outside the try so teardown can await the actual
  // active task even when an assertion fails mid-handover.
  const outcomes = new Map<string, TaskOutcome>();
  const outcomeWaiters = new Map<string, (outcome: TaskOutcome) => void>();
  const doneFor = (id: string): Promise<TaskOutcome> => {
    const existing = outcomes.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise<TaskOutcome>((resolve) => outcomeWaiters.set(id, resolve));
  };

  try {
    svc = await SharedSpatialSession.open({ worldId, databasePath: join(dir, 'memory.db') });
    const shared = svc;
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, shared);
    memory = new WorldMemory(null);
    arbiter = new Arbiter(adapter, memory, new EventBus(), vision, shared);

    // ---- observation instrumentation: real Vision is the only writer. ----
    const visionCalls: number[] = [];
    const observeBlocks = vision.observeBlocks.bind(vision);
    vision.observeBlocks = (positions) => {
      visionCalls.push(clock.now);
      return observeBlocks(positions);
    };
    const voxel = shared.session.voxel;
    const writtenReports: ChangeReport[] = [];
    const observeBatch = voxel.observeBatch.bind(voxel);
    voxel.observeBatch = (request) => {
      const report = observeBatch(request);
      writtenReports.push(report);
      return report;
    };
    const delivered: ChangeReport[] = [];
    const attach = shared.attach.bind(shared);
    shared.attach = (attachment) => attach({
      receiver: (report) => { delivered.push(report); attachment.receiver(report); },
      cancel: attachment.cancel,
    });

    // ---- ownership instrumentation on the real adapter. ----
    const stopAll = adapter.stopAll.bind(adapter);
    let stops = 0;
    adapter.stopAll = () => { stops++; stopAll(); };

    arbiter.on('done', (outcome) => {
      outcomes.set(outcome.task.id, outcome);
      outcomeWaiters.get(outcome.task.id)?.(outcome);
      outcomeWaiters.delete(outcome.task.id);
    });

    // ================= Window A =================
    // Start the old public swim_to; it must truly own the controls and settle
    // into the adapter's real `waitForTicks` await before we replace it.
    let resolveSwimWaitEntered!: () => void;
    const swimWaitEntered = new Promise<void>((resolve) => { resolveSwimWaitEntered = resolve; });
    onboardSwimWait = resolveSwimWaitEntered;

    const oldTask = started(arbiter.start({ skill: 'swim_to', args: { xyz: SWIM_TARGET } }, 'llm'));
    activeTaskId = oldTask.id;
    await withDeadline(swimWaitEntered, 'old swim waitForTicks');
    const owned = {
      pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      oxygen: bot.oxygenLevel,
      observedAt: clock.now,
    };
    const oldControlIndex = bot.controlLog.length;
    assert.equal(bot.controls.forward, true, 'real swimTo must hold forward before the handover');
    assert.ok(oldControlIndex > 0, 'real swimTo must have written controls');

    // Replace it through the same Arbiter.start path. Arm the pre-scan look gate
    // only now, so it can only hold the replacement's legitimate pre-scan look.
    clock.now += 1000;
    let resolveLookHeld!: () => void;
    const lookHeld = new Promise<void>((resolve) => { resolveLookHeld = resolve; });
    bot.onLookHeld = resolveLookHeld;
    bot.holdLook = true;

    const newTask = started(arbiter.start({ skill: 'walk_route', args: { points: POINTS } }, 'llm'));
    activeTaskId = newTask.id;
    assert.notEqual(newTask.id, oldTask.id);
    // Capture the boundary at the real synchronous handover: Arbiter.start has
    // already run cancel + adapter.stopAll (synchronous key release), but the
    // old swim's async catch/finally has not run yet. Anything below must not
    // add control writes, stops, samples or loop observations while the new
    // walk stays suspended in its legal pre-scan look.
    const boundaryA = {
      index: bot.controlLog.length,
      controls: { ...bot.controls },
      stops,
      samples,
      observes: loopObserves,
      reports: delivered.length,
      visionCalls: visionCalls.length,
      at: clock.now,
      wall: performance.now(),
    };
    assert.equal(bot.controls.forward, false, 'the synchronous cancel/stopAll already released old forward');

    await withDeadline(lookHeld, 'replacement pre-scan look');
    // The old task's catch/finally/TaskOutcome completes while the new walk is
    // genuinely suspended inside a legal pre-scan look.
    const oldOutcome = await withDeadline(doneFor(oldTask.id), 'old swim cancelled outcome');
    await settle(4);

    assert.equal(oldOutcome.task.id, oldTask.id, 'old result is collected by its actual taskId');
    assert.equal(oldOutcome.result.status, 'cancelled', oldOutcome.result.summary);
    const partial = oldOutcome.result.data as unknown as OldPartial;
    assert.equal(partial.landed, false);
    assert.deepEqual(partial.target, SWIM_TARGET, 'old partial keeps the requested target');
    assert.deepEqual(partial.pos, owned.pos, 'old partial keeps the last owned position');
    assert.equal(partial.oxygen, owned.oxygen, 'old partial keeps the frozen oxygen');
    assert.equal(partial.observedAt, owned.observedAt, 'old partial keeps the observedAt sample time');
    assert.equal(bot.lookPending(), true, 'the replacement is still suspended in its legal pre-scan look');
    t.diagnostic(`window A: handover boundary at control-index ${boundaryA.index} (clock ${boundaryA.at}, wall ${boundaryA.wall.toFixed(1)}ms); old ${oldTask.id} then cancelled while replacement ${newTask.id} look stayed pending`);

    assert.equal(bot.controlLog.length, boundaryA.index,
      `no old set/clear after the real handover boundary (index ${boundaryA.index} at wall ${boundaryA.wall.toFixed(1)}ms)`);
    assert.deepEqual(bot.controls, boundaryA.controls, 'no control key changed during the old async cancellation');
    assert.equal(stops, boundaryA.stops, 'no extra stopAll/ownership change during the old async cancellation');
    assert.equal(samples, boundaryA.samples, 'no body sample entered the replacement during the old cancellation');
    assert.equal(loopObserves, boundaryA.observes, 'no loop observation reached the replacement during the old cancellation');
    assert.equal(delivered.length, boundaryA.reports, 'no shared report was delivered during the old cancellation');
    assert.equal(visionCalls.length, boundaryA.visionCalls, 'no observation ran during the old async cancellation');

    // ================= release pre-scan, move the real physics =================
    bot.releaseHeldLook();
    await settle(2);

    const driveUntil = async (what: string, condition: () => boolean, maxMs = 15000) => {
      const until = performance.now() + maxMs;
      while (!condition()) {
        if (performance.now() > until) assert.fail(`timed out driving physics for ${what}`);
        if (bot.listenerCount('physicsTick') > 0) {
          simulateFrame();
          await settle();
        } else {
          await delay(2);
        }
      }
    };

    // The replacement must genuinely press forward itself and then wait on the
    // real pending `physicsTick` subscription.
    await driveUntil('replacement forward + pending tick',
      () => bot.controls.forward === true && bot.listenerCount('physicsTick') > 0);
    assert.equal(bot.listenerCount('physicsTick'), 1, 'one real pending walkTick subscription');
    assert.ok(visionCalls.length > boundaryA.visionCalls, 'the replacement did real Vision work');
    assert.ok(delivered.length > 0, 'the replacement attached and received real shared reports');
    assert.ok(loopObserves > 0, 'real reports reached the replacement loop');

    // ================= Window B =================
    // Resolve the old physics wait while the new walk's tick stays paused.
    const boundaryB = {
      index: bot.controlLog.length,
      controls: { ...bot.controls },
      visionCalls: visionCalls.length,
      reports: delivered.length,
      writes: writtenReports.length,
      samples,
      observes: loopObserves,
      stops,
      at: clock.now,
      wall: performance.now(),
    };
    bot.releaseSwimWait();
    await settle(4);

    assert.equal(bot.controlLog.length, boundaryB.index,
      `late old wait resolution wrote no controls (index ${boundaryB.index} at wall ${boundaryB.wall.toFixed(1)}ms)`);
    assert.deepEqual(bot.controls, boundaryB.controls, 'new owner keys are unchanged by the old resumption');
    assert.equal(visionCalls.length, boundaryB.visionCalls, 'old resumption performed no Vision reads');
    assert.equal(delivered.length, boundaryB.reports, 'old resumption delivered no shared report to the loop');
    assert.equal(writtenReports.length, boundaryB.writes, 'old resumption wrote nothing into the shared map');
    assert.equal(samples, boundaryB.samples, 'old resumption fed no body sample into the replacement loop');
    assert.equal(loopObserves, boundaryB.observes, 'old resumption produced no loop observation');
    assert.equal(stops, boundaryB.stops, 'old resumption did not stop/replace the new owner');
    assert.equal(bot.controls.forward, true, 'the replacement still owns forward across the late completion');
    assert.ok(bot.listenerCount('physicsTick') > 0, 'the replacement is still waiting on its real physics tick');
    t.diagnostic(`window B: old waitForTicks resolved at control-index ${boundaryB.index} (clock ${boundaryB.at}, wall ${boundaryB.wall.toFixed(1)}ms); vision=${boundaryB.visionCalls} reports=${boundaryB.reports} writes=${boundaryB.writes} samples=${boundaryB.samples} loops=${boundaryB.observes} stops=${boundaryB.stops}, all unchanged`);

    // ================= finish the replacement on real physics frames =================
    const newOutcomePromise = withDeadline(doneFor(newTask.id), 'replacement walk outcome');
    await driveUntil('replacement ARRIVED', () => outcomes.has(newTask.id));
    const newOutcome = await newOutcomePromise;
    await settle(3);

    assert.equal(newOutcome.task.id, newTask.id, 'new result is collected by its actual taskId');
    assert.equal(newOutcome.result.status, 'succeeded', newOutcome.result.summary);
    const nav = newOutcome.result.data?.nav as unknown as NavData;
    assert.equal(nav.outcome, 'ARRIVED');
    const final = bot.entity.position;
    const last = POINTS[POINTS.length - 1]!;
    assert.ok(Math.hypot(final.x - last.x, final.z - last.z) <= GROUNDED_ARRIVAL_DEFAULTS.horizontalTolerance,
      `final position ${final.x},${final.z} must stay inside the existing horizontal tolerance`);
    assert.ok(Math.abs(final.y - last.y) <= GROUNDED_ARRIVAL_DEFAULTS.feetTolerance,
      `final height ${final.y} must stay inside the existing feet tolerance`);
    assert.equal(bot.controls.forward, false, 'the completed walk released forward');
    assert.equal(bot.listenerCount('physicsTick'), 0, 'no physics listener survives arrival');
    assert.equal(arbiter.current, null, 'no task remains current');
    assert.equal(shared.closing, false, 'an action finishing must not close the shared session');
    assert.equal(shared.session.voxel, voxel, 'the replacement used the same shared VoxelMap');
    assert.equal(voxel.cellAt(dim, 2, -1, 0).observed, true, 'real Vision observations must remain in the shared map');
    for (const report of delivered) assert.ok(writtenReports.includes(report),
      'every report delivered to the loop must be the same object written by real Vision');

    // Later real body state changes cannot rewrite the frozen old result.
    bot.oxygenLevel = 3;
    const after = oldOutcome.result.data as unknown as OldPartial;
    assert.equal(oldOutcome.result.status, 'cancelled');
    assert.deepEqual(after.pos, owned.pos, 'later body movement cannot rewrite the old partial position');
    assert.equal(after.oxygen, owned.oxygen, 'later oxygen changes cannot rewrite the old partial oxygen');
    assert.equal(after.observedAt, owned.observedAt, 'later time cannot rewrite the old observedAt');
    assert.notEqual(final.x, owned.pos.x, 'the new task did move the body away from the old sample');

    // ================= real shutdown =================
    const result = await shared.shutdown();
    shutdownFinished = true;
    const diagnostics = spatialShutdownDiagnostics(result, worldId);
    assert.deepEqual(diagnostics.problems, [], `shutdown diagnostics: ${JSON.stringify(diagnostics)}`);
    assert.equal(result.error, null, 'final save must not fail');
    assert.equal(result.cancelError, null, 'attachment cancel must not fail');
    assert.ok(result.close !== null, 'real close must return a result');
    assert.equal(result.close.completed, true);
    assert.equal(result.close.error, null);
    assert.equal(result.close.unconfirmedRequest, false);
    assert.equal(shared.closing, true);
    t.diagnostic(`result: old=${oldTask.id} cancelled, new=${newTask.id} ARRIVED, frames=${frames}, visionCalls=${visionCalls.length}, writes=${writtenReports.length}, reports=${delivered.length}, samples=${samples}, final=(${final.x.toFixed(3)},${final.y.toFixed(3)},${final.z.toFixed(3)}), checkpoint=${result.checkpoint?.checkpointId ?? 'none'}, close=${result.close.completed ? 'confirmed' : 'unconfirmed'}`);
    cleanClosed = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupProblems: string[] = [];
    try {
      // Cancel the test's actual active task first. The synchronous stopAll is
      // part of cancellation; the async outcome is awaited below under a bound.
      const active = arbiter?.current ?? null;
      if (active !== null) {
        activeTaskId = active.id;
        arbiter!.cancel('test cleanup');
      }
      // Release this fixture's held low-level awaiters so no adapter/hook await
      // outlives the test: the pre-scan look and the old swim's physics wait.
      bot.releaseHeldLook();
      bot.releaseSwimWait();

      if (activeTaskId !== null && !outcomes.has(activeTaskId)) {
        try {
          await withDeadline(doneFor(activeTaskId), `cleanup task ${activeTaskId}`, 3000);
        } catch (error) {
          cleanupProblems.push(`active task did not finish: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // A cancelled walkTick removes its own physics listener; wait rather than
      // assume the microtask ordering.
      const listenerUntil = performance.now() + 2000;
      while (bot.listenerCount('physicsTick') > 0 && performance.now() < listenerUntil) await delay(5);
      if (bot.listenerCount('physicsTick') > 0) cleanupProblems.push('physicsTick listener still attached after cancellation');
    } finally {
      prototype.onSample = originalOnSample;
      prototype.observe = originalObserve;
      arbiter?.dispose();
    }

    if (svc !== null && !shutdownFinished) {
      try {
        const secondary = await svc.shutdown();
        shutdownFinished = true;
        const diagnostics = spatialShutdownDiagnostics(secondary, worldId);
        if (diagnostics.problems.length > 0) {
          cleanupProblems.push(`secondary shutdown problems: ${diagnostics.problems.join(',')}`);
        }
      } catch (error) {
        cleanupProblems.push(`secondary shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Only a confirmed clean close may delete the fixture; otherwise retain it
    // and surface the diagnostics.
    if (cleanClosed) rmSync(dir, { recursive: true, force: true });
    else if (primaryError !== null) console.error('shared spatial fixture retained at', dir);

    if (cleanupProblems.length > 0) {
      cleanupError = new Error(cleanupProblems.join('; '));
      if (primaryError !== null) console.error('secondary cleanup problems', cleanupError.message);
      else throw cleanupError;
    }
  }
});
