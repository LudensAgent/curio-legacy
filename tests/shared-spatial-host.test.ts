/**
 * D2a 宿主接线验收：真实 Arbiter + 真实 Vision + 真实 SharedSpatialSession（真实 Worker、
 * 唯一 mkdtemp 数据库），身体桥沿用 prismarine-physics 离线夹具。
 *
 * 证明的是生产调用链，不复制一份“正确实现”：
 *   - 同一服务地图被连续两次真实 walk_route 使用，A 结束只撤销自己的 token，服务保持打开；
 *   - 真实 Vision 合法观测是唯一地图写者，一次接受批次恰好一次写，并在同一身体样本前送达 loop；
 *   - Arbiter.setPaused 即使零观测间隔也 stale 证据并取消旧委托，恢复后只接纳真实观测；
 *   - MineflayerAdapter 的真实 newSession 路径发出一次 session_reset，旧会话/迟到调用不能重新取得控制。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { BodySample, ChangeReport, NavResult } from 'curio-minecraft-3d-memory';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { WalkBody, WalkTick } from '../src/adapter/walk-route.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { errorFacts, spatialShutdownDiagnostics } from '../src/spatial/host-shutdown.ts';
import { config } from '../src/config.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'fake-world';
const POINTS_A = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
const POINTS_B = [{ x: 1.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }];
const POINTS_LONG = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }];

async function openShared(worldId = WORLD): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-spatial-host-'));
  const svc = await SharedSpatialSession.open({ worldId, databasePath: join(dir, 'memory.db') });
  return { svc, dir };
}

/** 真实关停断言；clean close 后才删除临时数据库，unclean 时保留 fixture。 */
function closeShared(svc: SharedSpatialSession, dir: string): Promise<ShutdownResult> {
  return svc.shutdown().then((result) => {
    assert.equal(result.error, null, 'final save must not fail');
    assert.equal(result.cancelError, null, 'attachment cancel must not fail');
    assert.ok(result.close !== null, 'real close must return a result');
    assert.equal(result.close.completed, true);
    assert.equal(result.close.error, null);
    assert.equal(result.close.unconfirmedRequest, false);
    rmSync(dir, { recursive: true, force: true });
    return result;
  });
}

/**
 * 真实身体桥 + 真实 Vision 世界：平坦草地地面 y=-1，脚高 y=0。
 * Physics 推进 prismarine-physics；Vision 读取同一个 adapter 的位置/朝向与方块光学。
 */
class WalkHostAdapter extends FakeAdapter {
  readonly entity = {
    position: new Vec3(0.54, 0, 0.52), velocity: new Vec3(0, 0, 0),
    onGround: true, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  readonly control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  readonly controlLog: { name: string; value: boolean }[] = [];
  /** Test hook: false stops delivering frames (and never lets a frame reach Vision). */
  framesEnabled = true;
  readonly bot: Record<string, unknown>;
  private readonly physics: unknown;
  private readonly world: unknown;

  constructor() {
    super();
    this.worldId = WORLD;
    this.sessionId = 'session-a';
    this.groundY = -1;
    this.pos = { x: this.entity.position.x, y: this.entity.position.y, z: this.entity.position.z };
    this.yaw = 0;
    this.pitch = 0;
    this.bot = {
      version: '1.20.1', entity: this.entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
      inventory: { slots: [] },
      setControlState: (name: string, value: boolean) => {
        this.control[name] = value;
        this.controlLog.push({ name, value });
      },
      clearControlStates: () => { for (const key of Object.keys(this.control)) this.control[key] = false; },
      look: (yaw: number, pitch: number) => { this.entity.yaw = yaw; this.entity.pitch = pitch; },
    };
    const world = {
      getBlock(position: { floored(): { x: number; y: number; z: number } }) {
        const p = position.floored();
        const stateId = p.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
        const block = Block.fromStateId(stateId, 0);
        block.position = p;
        return block;
      },
    };
    this.world = world;
    this.physics = Physics(data, world);
  }

  state() {
    this.pos = { x: this.entity.position.x, y: this.entity.position.y, z: this.entity.position.z };
    return super.state();
  }

  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => {
        this.control[name] = value;
        this.controlLog.push({ name, value });
      },
      clearControlStates: () => { for (const key of Object.keys(this.control)) this.control[key] = false; },
      // 身体朝向必须同时写入物理实体与 Vision 读取的 adapter 朝向，二者是同一套控制。
      look: (yaw: number, pitch: number) => {
        this.entity.yaw = yaw;
        this.entity.pitch = pitch;
        this.yaw = yaw;
        this.pitch = pitch;
      },
      entity: {
        position: this.entity.position, velocity: this.entity.velocity,
        onGround: this.entity.onGround, isInWater: this.entity.isInWater,
      },
    };
  }

  /** 测试观测钩子：每个交付帧标记一次，用于断言报告先于同帧身体样本。 */
  beforeFrame: (() => void) | null = null;

  walkTick() {
    return (signal: AbortSignal) => new Promise<WalkBody['entity'] | null>((resolve) => {
      // A deliberately starved body delivers neither another frame nor EOF: the
      // pending tick settles only when this run's own signal aborts, and removes
      // its listener then. No background timer survives cancellation.
      const stall = () => {
        if (signal.aborted) { resolve(null); return; }
        const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve(null); };
        signal.addEventListener('abort', onAbort, { once: true });
      };
      if (!this.framesEnabled) { stall(); return; }
      setTimeout(() => {
        if (!this.framesEnabled) { stall(); return; }
        (this.physics as { simulatePlayer(ps: unknown, w: unknown): { apply(bot: unknown): void } })
          .simulatePlayer(new PlayerState(this.bot, this.control), this.world)
          .apply(this.bot);
        this.beforeFrame?.();
        this.pos = { x: this.entity.position.x, y: this.entity.position.y, z: this.entity.position.z };
        resolve({
          position: this.entity.position, velocity: this.entity.velocity,
          onGround: this.entity.onGround, isInWater: this.entity.isInWater,
        });
      }, 50);
    });
  }
}

/**
 * Actual pending physics tick: subscribes to a real emitter like production
 * walkTick and resolves null on the signal it is actually given. Counts the
 * real subscription/unsubscription so the test observes listener cleanup.
 */
class PendingTickHostAdapter extends WalkHostAdapter {
  readonly physicsTick = new EventEmitter();
  tickSubscriptions = 0;
  tickUnsubscriptions = 0;

  walkTick(): WalkTick {
    return (signal) => new Promise<WalkBody['entity'] | null>((resolve) => {
      if (signal.aborted) { resolve(null); return; }
      this.tickSubscriptions++;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        this.tickUnsubscriptions++;
        signal.removeEventListener('abort', onAbort);
        this.physicsTick.removeListener('physicsTick', onTick);
      };
      const onTick = () => {
        cleanup();
        resolve({
          position: this.entity.position, velocity: this.entity.velocity,
          onGround: this.entity.onGround, isInWater: this.entity.isInWater,
        });
      };
      const onAbort = () => { cleanup(); resolve(null); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.physicsTick.on('physicsTick', onTick);
    });
  }
}

/** 等待条件成立（有界），避免用固定 sleep 猜接线时序。 */
async function waitFor(what: string, condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function doneOf(arbiter: Arbiter): Promise<TaskOutcome> {
  return new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
}

test('真实 Arbiter 连续 walk_route A→B 共用同一 session.voxel，A 只撤销自己的附着且不关闭服务', async () => {
  const adapter = new WalkHostAdapter();
  const { svc, dir } = await openShared();
  let arbiter: Arbiter | null = null;

  const tokens: number[] = [];
  const detached: number[] = [];
  const reports: ChangeReport[] = [];
  const attach = svc.attach.bind(svc);
  const detach = svc.detach.bind(svc);
  svc.attach = (attachment) => {
    // Record the exact report the service delivers, then retain the original receiver call.
    const token = attach({ receiver: (report) => { reports.push(report); attachment.receiver(report); }, cancel: attachment.cancel });
    tokens.push(token);
    return token;
  };
  svc.detach = (token) => {
    detached.push(token);
    detach(token);
  };

  try {
    // 构造放在真实 Worker 已打开后的 try 内：任何 setup 抛错也必须 finally 关库。
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const voxel = svc.session.voxel;
    const doneA = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const a = await doneA;
    assert.equal(a.result.status, 'succeeded', a.result.summary);
    assert.equal((a.result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
    assert.equal(tokens.length, 1, 'A 必须注册自己的活动句柄');
    assert.ok(detached.includes(tokens[0]!), 'A 结束时必须只撤销自己的 token');
    assert.equal(svc.closing, false, '一次 action 结束不得关闭共享会话');
    assert.equal(svc.session.voxel, voxel, 'A 与 B 必须使用同一个共享地图实例');
    assert.equal(svc.session.voxel.cellAt('overworld', 1, -1, 0).observed, true, 'A 的实际观测事实必须留在共享地图');

    const doneB = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_B } }, 'llm');
    await waitFor('B 注册活动句柄', () => tokens.length === 2);
    // A 的 finally/detach 迟到：旧 token 不能解除 B 的附着，B 仍须独立走完。
    svc.detach(tokens[0]!);
    // B is still attached: a real legal Vision batch must reach B's original receiver
    // through the service, not merely change the static map. Aim ahead along the
    // walked +x axis with a real downward pitch (no underfoot FOV exemption).
    reports.length = 0;
    const observeBatch = voxel.observeBatch.bind(voxel);
    let batchReport: ReturnType<typeof observeBatch> | null = null;
    voxel.observeBatch = (request) => {
      const report = observeBatch(request);
      batchReport = report;
      return report;
    };
    const support = { x: Math.floor(adapter.entity.position.x) + 1, y: -1, z: Math.floor(adapter.entity.position.z) };
    adapter.pitch = -1.2;
    const observed = vision.observeBlocks([support]);
    assert.ok(observed.length > 0, 'B 活动期间真实可见支撑必须被观测');
    assert.equal(reports.length, 1, 'B 原始 receiver 必须经服务收到真实地图报告');
    assert.ok(batchReport !== null, '真实 Vision 批次必须实际调用 observeBatch 并返回报告');
    assert.strictEqual(reports[0], batchReport, 'B 原始 receiver 必须收到 observeBatch 返回的同一报告对象');
    assert.equal(svc.session.voxel.cellAt('overworld', support.x, support.y, support.z).observed, true, '真实观测必须写入共享地图');
    const b = await doneB;
    assert.equal(b.result.status, 'succeeded', b.result.summary);
    assert.equal((b.result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
    assert.notEqual(tokens[1], tokens[0]);
    assert.equal(svc.closing, false);
    assert.equal(svc.session.voxel, voxel);
    assert.equal(svc.session.voxel.cellAt('overworld', 2, -1, 0).observed, true, 'B 的实际观测事实必须写入同一张地图');
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('缺少共享会话时 walk_route 显式失败，不静默新建 VoxelMap', async () => {
  const adapter = new FakeAdapter();
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), new Vision(adapter));
  try {
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const outcome = await done;
    assert.equal(outcome.result.status, 'failed');
    assert.match(outcome.result.summary, /ctx\.spatial/);
  } finally {
    arbiter.dispose();
  }
});

test('真实 Vision→服务→loop：每接受批次恰好一次地图写，且写/报告先于同帧身体样本', async () => {
  const { svc, dir } = await openShared();
  const adapter = new WalkHostAdapter();
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
  let arbiter: Arbiter | null = null;

  const writes: ChangeReport[] = [];
  const delivered: ChangeReport[] = [];
  const trace: string[] = [];
  adapter.beforeFrame = () => { trace.push('frame'); };
  const voxel = svc.session.voxel;
  const observeBatch = voxel.observeBatch.bind(voxel);
  voxel.observeBatch = (request: Parameters<typeof observeBatch>[0]) => {
    const report = observeBatch(request);
    writes.push(report);
    trace.push('batch');
    return report;
  };

  const observe = vision.observeBlocks.bind(vision);
  const legalPositions: string[] = [];
  let acceptedBatches = 0;
  vision.observeBlocks = (positions) => {
    const blocks = observe(positions);
    if (blocks.length > 0) acceptedBatches++;
    for (const block of blocks) legalPositions.push(`${block.pos.x},${block.pos.y},${block.pos.z}`);
    return blocks;
  };

  const attach = svc.attach.bind(svc);
  svc.attach = (attachment) => attach({
    receiver: (report) => { delivered.push(report); attachment.receiver(report); },
    cancel: attachment.cancel,
  });

  // 直接观测真实 loop 的报告/样本调用顺序；只包装本次测试进程内的原型，结束后还原。
  const prototype = WalkRouteExecutor.prototype;
  const originalObserve = prototype.observe;
  const originalOnSample = prototype.onSample;
  prototype.observe = function observeWrapped(this: WalkRouteExecutor, report: ChangeReport, budget: number) {
    trace.push('observe');
    return originalObserve.call(this, report, budget);
  };
  prototype.onSample = function onSampleWrapped(this: WalkRouteExecutor, sample: BodySample) {
    trace.push('sample');
    return originalOnSample.call(this, sample);
  };

  try {
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const outcome = await done;
    assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);

    assert.ok(writes.length > 0, '真实合法观测必须写入共享地图');
    assert.equal(writes.length, acceptedBatches, '每个被接受的 Vision 批次恰好一次地图写');
    assert.ok(delivered.length > 0, '服务报告必须送达活动 walk loop');
    for (const report of delivered) assert.ok(writes.includes(report), '送达 loop 的报告必须就是本次地图写返回的对象');

    // 每次 loop.observe 都由 map.observeBatch 同步产生；它必须在下一帧标记前先遇到本帧 onSample。
    for (let i = 0; i < trace.length; i++) {
      if (trace[i] !== 'observe') continue;
      assert.equal(trace[i - 1], 'batch', 'loop.observe 必须由本帧同步地图写触发');
      const nextSample = trace.indexOf('sample', i + 1);
      const nextFrame = trace.indexOf('frame', i + 1);
      assert.notEqual(nextSample, -1, '报告必须被本帧身体样本消费');
      assert.ok(nextFrame === -1 || nextSample < nextFrame, '报告必须在下一帧前、同帧身体样本之前送达 loop');
    }
    assert.ok(trace.includes('observe') && trace.includes('sample'), '必须观察到真实报告与身体样本');

    const written = new Set(writes.flatMap((report) => report.sections.flatMap((section) => section.cells.map((cell) => `${cell.pos.x},${cell.pos.y},${cell.pos.z}`))));
    for (const key of written) assert.ok(legalPositions.includes(key), `写入格 ${key} 必须来自真实合法 Vision 结果`);
    assert.equal(voxel.cellAt('overworld', 20, 0, 20).observed, false, '未观察/缓存格不得被共享地图写入');
  } finally {
    prototype.observe = originalObserve;
    prototype.onSample = originalOnSample;
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('真实 Arbiter.setPaused 零观测间隔即 stale 证据并取消旧委托，恢复只接纳实际观测', async () => {
  const { svc, dir } = await openShared();
  const adapter = new WalkHostAdapter();
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
  let arbiter: Arbiter | null = null;

  let cancels = 0;
  const attach = svc.attach.bind(svc);
  svc.attach = (attachment) => attach({
    receiver: attachment.receiver,
    cancel: () => { cancels++; attachment.cancel(); },
  });

  try {
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const support = { x: 0, y: -1, z: 0 };
    await waitFor('首个真实观测写入', () => svc.session.voxel.cellAt('overworld', support.x, support.y, support.z).observed);
    const before = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(before.observed, true, '暂停前证据应已写入');
    assert.equal(before.observed ? before.evidence.freshness : null, 'FRESH', '暂停前证据应为 FRESH');

    // 暂停前不再观测：仅生命周期边界也必须使共享证据 stale 并取消活动委托。
    arbiter.setPaused(true);
    const outcome = await done;
    assert.equal(outcome.result.status, 'cancelled', outcome.result.summary);
    assert.equal(svc.paused, true);
    assert.ok(cancels > 0, 'D1 服务必须取消已附着的旧委托');
    const paused = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(paused.observed ? paused.evidence.freshness : null, 'STALE', '零观测间隔的暂停也必须 stale 证据');

    arbiter.setPaused(false);
    assert.equal(svc.paused, false);
    const resumed = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(resumed.observed ? resumed.evidence.freshness : null, 'STALE', '恢复本身不得复活未重新观测的证据');
    assert.equal(svc.session.voxel.cellAt('overworld', 9, 0, 9).observed, false, '恢复不得凭空接纳未观测格');

    // 只接纳真实 Vision 结果：实际看过的支撑格恢复 fresh，未看过的格仍未知。
    // 暂停/恢复边界使用实际时钟；让观测时间严格晚于边界，避免同毫秒被当作迟到证据。
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.yaw = 0;
    adapter.pitch = -1.2;
    const observed = vision.observeBlocks([support]);
    assert.ok(observed.length > 0, '实际可见支撑必须产生合法观测');
    const afterObserve = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(afterObserve.observed ? afterObserve.evidence.freshness : null, 'FRESH');
    assert.equal(svc.session.voxel.cellAt('overworld', 9, 0, 9).observed, false);

    // 真实新 session：作用域变化才 beginSession，旧 session 证据 stale，旧载荷不能写回。
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.sessionId = 'session-b';
    assert.ok(vision.observeBlocks([support]).length > 0, '新 session 下的实际观测必须被接受');
    const newSessionCell = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(newSessionCell.observed && newSessionCell.evidence.observation.sessionId, 'session-b');
    assert.deepEqual(svc.observe([{
      name: 'minecraft:stone', properties: {}, stateComplete: true, pos: { ...support },
      worldId: WORLD, sessionId: 'session-a', dimension: 'overworld', observationId: 999, observedAt: Date.now(), source: 'vision',
    }]).sections, [], '旧 session 载荷不得重新取得写入资格');
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('真实 MineflayerAdapter.newSession 发出 session_reset；空报告也取消委托，旧会话/迟到调用不能恢复控制', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-spatial-host-'));
  const bus = new EventBus();
  const adapter = new MineflayerAdapter(config, bus);
  const harness = adapter as unknown as { bot: unknown; dimension: string };
  const state0 = adapter.state();
  const svc = await SharedSpatialSession.open({ worldId: state0.worldId, databasePath: join(dir, 'memory.db') });
  let arbiter: Arbiter | null = null;

  let resets = 0;
  adapter.on('session_reset', () => { resets++; });

  try {
    // 真实 Worker 已打开：构造与后续 setup 都在 finally 保护内。
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), new Vision(adapter), svc);
    svc.beginSession({ worldId: state0.worldId, dim: 'overworld', sessionId: 'session-old' });
    let cancels = 0;
    const reports: ChangeReport[] = [];
    svc.attach({ receiver: (report) => reports.push(report), cancel: () => { cancels++; } });

    const oldSessionId = state0.sessionId;
    // 公开状态转移：状态读到真实维度变化时，adapter 自身调用 newSession。
    harness.dimension = 'overworld';
    harness.bot = { game: { dimension: 'minecraft:the_nether' } };
    const changed = adapter.state();
    assert.notEqual(changed.sessionId, oldSessionId, '真实 sessionId 必须变化');
    assert.equal(resets, 1, '生产 newSession 路径必须发出一次 session_reset');
    assert.equal(cancels, 1, '空报告/无后续身体帧时也必须取消活动委托');
    assert.equal(reports.length, 1, '生命周期空报告仍须同步派发');
    assert.equal(svc.paused, false);

    // 旧会话载荷被拒绝，迟到附着也不能重新取得控制。
    assert.deepEqual(svc.observe([{
      name: 'minecraft:stone', properties: {}, stateComplete: true, pos: { x: 0, y: -1, z: 0 },
      worldId: state0.worldId, sessionId: 'session-old', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision',
    }]).sections, []);
    assert.throws(() => svc.attach({ receiver: () => {}, cancel: () => {} }), /not accepting a delegation/);

    // 监听器异常只产生诊断，不得中断 newSession/end 的后续处理；unknown 边界
    // 仍须保留真实的 name/message 与领域错误自带的类型化 kind。
    const typedBoom = Object.assign(new Error('listener boom'), { kind: 'persistence' as const });
    adapter.on('session_reset', () => { throw typedBoom; });
    harness.dimension = 'the_nether';
    harness.bot = { game: { dimension: 'minecraft:the_end' } };
    const next = adapter.state();
    assert.notEqual(next.sessionId, changed.sessionId, '异常监听器不得中断 newSession 的会话更新');
    const diagnostic = bus.recent().find((event) => event.type === 'adapter_event_error');
    assert.ok(diagnostic, '监听器错误必须作为诊断发布');
    assert.match(diagnostic.msg, /Error: listener boom/);
    assert.match(diagnostic.msg, /kind=persistence/, '真实错误自带的 kind 必须保留');
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('真实步行生命周期检测同 session ready 丢失：一次中断、stale，重新 ready 后只由真实观测重新准入', async () => {
  const adapter = new WalkHostAdapter();
  const { svc, dir } = await openShared();
  let arbiter: Arbiter | null = null;

  let interrupts = 0;
  const interrupt = svc.interrupt.bind(svc);
  svc.interrupt = () => { interrupts++; return interrupt(); };
  let begins = 0;
  const beginSession = svc.beginSession.bind(svc);
  svc.beginSession = (scope) => { begins++; return beginSession(scope); };
  const voxel = svc.session.voxel;
  let batchWrites = 0;
  const observeBatch = voxel.observeBatch.bind(voxel);
  voxel.observeBatch = (request) => { batchWrites++; return observeBatch(request); };

  let unready = false;
  let visionCallsAfterUnready = 0;

  const support = { x: 0, y: -1, z: 0 };
  const neighbor = { x: 1, y: -1, z: 0 };

  try {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    const observeBlocks = vision.observeBlocks.bind(vision);
    vision.observeBlocks = (positions) => {
      if (unready) visionCallsAfterUnready++;
      return observeBlocks(positions);
    };
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_LONG } }, 'llm');
    await waitFor('walk 实际开始前进', () => adapter.control.forward === true);
    await waitFor('路线支撑已真实观测', () => svc.session.voxel.cellAt('overworld', support.x, support.y, support.z).observed);
    const before = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(before.observed ? before.evidence.freshness : null, 'FRESH');
    const neighborBefore = svc.session.voxel.cellAt('overworld', neighbor.x, neighbor.y, neighbor.z);
    assert.equal(neighborBefore.observed, true, '邻格应已在预扫中真实观测');

    // Same world/dim/sessionId; only observationReady disappears, and no more frames are delivered.
    unready = true;
    adapter.observationReady = false;
    adapter.framesEnabled = false;
    const controlBoundary = adapter.controlLog.length;

    const outcome = await done;
    assert.equal(outcome.result.status, 'cancelled', outcome.result.summary);
    assert.equal((outcome.result.data?.nav as { outcome: string }).outcome, 'CANCELLED');
    assert.equal(interrupts, 1, '未就绪边界只能中断一次');
    assert.equal(visionCallsAfterUnready, 0, '无下一帧时检测必须来自 walk 生命周期，而不是 Vision');
    await waitFor('取消后释放控制', () => adapter.control.forward === false);
    assert.equal(svc.observationAdmitted, false, '中断后准入必须为 false');

    const stale = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(stale.observed ? stale.evidence.freshness : null, 'STALE', '已观测支撑必须被中断置 stale');
    const neighborStale = svc.session.voxel.cellAt('overworld', neighbor.x, neighbor.y, neighbor.z);
    assert.equal(neighborStale.observed ? neighborStale.evidence.freshness : null, 'STALE');
    // Capture the real interruption boundary after cancellation has settled; recovery
    // evidence must be genuinely later than the gap it replaces, not just same-ms.
    const gapBoundary = Date.now();

    // Restore trusted ready in the same scope. Vision never saw the unready state, so
    // re-admission must come from the missing admission, not from a cached scope change.
    adapter.entity.position.x = 0.54;
    adapter.entity.position.y = 0;
    adapter.entity.position.z = 0.52;
    adapter.yaw = 0;
    adapter.pitch = -1.2;
    unready = false;
    adapter.observationReady = true;
    const beginsBeforeReobserve = begins;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const observed = vision.observeBlocks([support]);
    assert.ok(observed.length > 0, '恢复后实际可见支撑必须被观测');
    assert.ok(observed[0]!.observedAt > gapBoundary, '恢复观测必须晚于真实中断边界');
    assert.equal(begins, beginsBeforeReobserve + 1, '未准入的同一作用域必须重新 begin 一次');
    assert.equal(svc.observationAdmitted, true);
    const fresh = svc.session.voxel.cellAt('overworld', support.x, support.y, support.z);
    assert.equal(fresh.observed ? fresh.evidence.freshness : null, 'FRESH');
    const neighborStillStale = svc.session.voxel.cellAt('overworld', neighbor.x, neighbor.y, neighbor.z);
    assert.equal(neighborStillStale.observed ? neighborStillStale.evidence.freshness : null, 'STALE', '未重新看见的邻格不得被刷新');

    // Paused is not admission=false: repeated reads must not begin again or dispatch writes.
    svc.setPaused(true);
    const beginsAtPause = begins;
    const writesAtPause = batchWrites;
    vision.observeBlocks([support]);
    vision.observeBlocks([support]);
    assert.equal(begins, beginsAtPause, '暂停读取不得重复 beginSession');
    assert.equal(batchWrites, writesAtPause, '暂停时不得派发地图写入');
    svc.setPaused(false);

    // Repeated actual-unready reads: interrupt once, then gate without begin/dispatch.
    const interruptsBeforeRepeat = interrupts;
    const beginsBeforeUnready = begins;
    const writesBeforeUnready = batchWrites;
    adapter.observationReady = false;
    vision.observeBlocks([support]);
    assert.equal(interrupts, interruptsBeforeRepeat + 1);
    vision.observeBlocks([support]);
    vision.observeBlocks([support]);
    assert.equal(interrupts, interruptsBeforeRepeat + 1, '重复未就绪读取不得重复中断');
    assert.equal(begins, beginsBeforeUnready);
    assert.equal(batchWrites, writesBeforeUnready);

    const revival = adapter.controlLog.slice(controlBoundary).filter((e) => e.name === 'forward' && e.value);
    assert.deepEqual(revival, [], '取消后不得恢复前进控制');
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('共享 interrupt 在初始等待物理帧时立即给出 lifecycle CANCELLED，并清理真实 tick 订阅', async () => {
  const adapter = new PendingTickHostAdapter();
  const { svc, dir } = await openShared();
  let arbiter: Arbiter | null = null;

  try {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const parentSignal = arbiter.current!.controller.signal;
    // Init is genuinely waiting on the adapter's real pending frame subscription.
    await waitFor('初始物理帧订阅', () => adapter.tickSubscriptions === 1);
    assert.equal(adapter.control.forward, false, '初始等待时不得已按前进键');

    const startedAt = Date.now();
    svc.interrupt();
    const outcome = await done;
    assert.equal(outcome.result.status, 'cancelled', outcome.result.summary);
    assert.equal((outcome.result.data?.nav as { outcome: string }).outcome, 'CANCELLED');
    assert.ok(Date.now() - startedAt < 2000, '取消必须在有限时间内结束，不能等下一帧或期限');
    assert.equal(adapter.tickUnsubscriptions, 1, '真实 tick 订阅必须被清理');
    assert.equal(adapter.physicsTick.listenerCount('physicsTick'), 0);
    assert.equal(parentSignal.aborted, false, '只中止本次运行等待，不得 abort 父任务 signal');
    assert.equal(adapter.control.forward, false, '取消后不得按下前进键');
    assert.equal(svc.observationAdmitted, false);
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('共享服务关闭后真实 Vision 读取不抛错、不开始会话、不派发写入', async () => {
  const adapter = new WalkHostAdapter();
  const { svc, dir } = await openShared();
  let closeAttempted = false;
  let cleanClosed = false;
  try {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    let begins = 0;
    let writes = 0;
    const beginSession = svc.beginSession.bind(svc);
    svc.beginSession = (scope) => { begins++; return beginSession(scope); };
    const voxel = svc.session.voxel;
    const observeBatch = voxel.observeBatch.bind(voxel);
    voxel.observeBatch = (request) => { writes++; return observeBatch(request); };

    // Actual shutdown, not a fabricated completed flag; the real close result is asserted.
    closeAttempted = true;
    const shutdown = await svc.shutdown();
    assert.equal(shutdown.error, null);
    assert.equal(shutdown.cancelError, null);
    assert.equal(shutdown.closeError, null);
    assert.ok(shutdown.close !== null, 'real close must return a result');
    assert.equal(shutdown.close.completed, true);
    assert.equal(shutdown.close.error, null);
    assert.equal(shutdown.close.unconfirmedRequest, false);
    assert.equal(svc.closing, true);
    cleanClosed = true;

    const beginsBefore = begins;
    const writesBefore = writes;
    let observed: unknown = null;
    assert.doesNotThrow(() => { observed = vision.observeBlocks([{ x: 0, y: -1, z: 0 }]); });
    assert.deepEqual(observed, [], '关闭后读取必须返回空批次');
    assert.equal(begins, beginsBefore, '关闭后不得开始新会话');
    assert.equal(writes, writesBefore, '关闭后不得派发地图写入');
  } finally {
    if (cleanClosed) rmSync(dir, { recursive: true, force: true });
    else if (!closeAttempted) await closeShared(svc, dir);
  }
});

test('暂停时取消回调抛错仍完成父任务取消与 stopAll，并保留原始错误', async () => {
  const adapter = new WalkHostAdapter();
  const { svc, dir } = await openShared();
  let arbiter: Arbiter | null = null;
  const boom = new Error('cancel boom');
  let attached = 0;
  const attach = svc.attach.bind(svc);
  svc.attach = (attachment) => {
    attached++;
    return attach({ receiver: attachment.receiver, cancel: () => { throw boom; } });
  };

  try {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const done = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_LONG } }, 'llm');
    await waitFor('walk 注册活动句柄', () => attached === 1);
    const stopsBefore = adapter.stopAllCount;

    assert.throws(() => arbiter!.setPaused(true), (error) => error === boom);
    assert.equal(arbiter.current, null, '取消回调抛错后父任务仍必须被取消');
    assert.ok(adapter.stopAllCount > stopsBefore, '取消回调抛错后仍必须 stopAll');
    assert.equal(svc.paused, true);

    const outcome = await done;
    assert.equal(outcome.result.status, 'cancelled', outcome.result.summary);
  } finally {
    arbiter?.dispose();
    await closeShared(svc, dir);
  }
});

test('真实 checkpoint 容量失败不重写已完成移动，同一服务仍可走 B，最终真实关停保留脏事实', async (t) => {
  const adapter = new WalkHostAdapter();
  const dir = mkdtempSync(join(tmpdir(), 'shared-spatial-host-'));
  // 公开 snapshotLimits 只是快照容量，不是驻留预算；真实 Vision 自然写入的格数超过 1。
  const svc = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    snapshotLimits: { maxObservedCells: 1 },
  });
  let arbiter: Arbiter | null = null;
  let shutdown: ShutdownResult | null = null;
  let shutdownFailure: unknown = null;
  let assertionsPassed = false;

  // 只记录真实 Vision 交给服务的原始观测，不注入合成地面。
  const batches: BlockObservation[][] = [];
  const observe = svc.observe.bind(svc);
  svc.observe = (observations) => { batches.push([...observations]); return observe(observations); };

  try {
    const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
    arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);
    const voxel = svc.session.voxel;

    const doneA = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_A } }, 'llm');
    const a = await doneA;
    assert.equal(a.result.status, 'succeeded', a.result.summary);
    assert.ok(a.result.data);
    const navA = a.result.data.nav as NavResult;
    assert.equal(navA.outcome, 'ARRIVED');
    assert.equal(navA.confirmed, true);
    assert.ok(navA.lastPosition !== undefined, 'ARRIVED 必须带实测最后位置');
    assert.ok(navA.lastObservation !== undefined, 'ARRIVED 必须带实测最后观测');
    assert.ok(navA.trace.length > 0, 'ARRIVED 必须保留真实轨迹');
    assert.notEqual(navA.memoryWrite, 'saved', '尚未成功保存时不得声称 saved');

    const originalResultA = a.result;
    const resultASnapshot = structuredClone(a.result);
    const navASnapshot = structuredClone(navA);

    const observedPositions = new Set(
      batches.flatMap((list) => list.map((b) => `${b.dimension}|${b.pos.x},${b.pos.y},${b.pos.z}`)),
    );
    assert.ok(observedPositions.size >= 2, '真实 Vision 必须自然写入至少两个格，容量失败才是真实场景');

    const firstObs = batches.flat()[0];
    assert.ok(firstObs !== undefined);
    const originalCell = voxel.cellAt(firstObs.dimension, firstObs.pos.x, firstObs.pos.y, firstObs.pos.z);
    assert.ok(originalCell.observed, '选定的原始观测格必须真实存在');
    const originalEvidence = structuredClone(originalCell.evidence);
    // 同一格可能被本轮步行后续帧合法刷新；证据必须对应某条真实交付的原始观测。
    const matchingObs = batches.flat().find((b) =>
      b.dimension === firstObs.dimension && b.pos.x === firstObs.pos.x &&
      b.pos.y === firstObs.pos.y && b.pos.z === firstObs.pos.z &&
      b.observedAt === originalEvidence.observation.observedAt &&
      b.observationId === originalEvidence.observation.sequence);
    assert.ok(matchingObs !== undefined, '格证据必须对应真实交付的原始观测');
    assert.equal(originalEvidence.observation.worldId, WORLD);
    assert.equal(originalEvidence.observation.dim, matchingObs.dimension);
    assert.equal(originalEvidence.observation.sessionId, matchingObs.sessionId);
    assert.deepEqual(
      Object.keys(originalEvidence.observation.state.properties).sort(),
      Object.keys(matchingObs.properties ?? {}).sort(),
    );

    // 第一次保存前：真实内存事实已脏，且真实格证据已经存在。
    const before = svc.getPersistenceState();
    assert.equal(before.dirty, true);
    assert.ok(before.voxelRevision > before.confirmedVoxelRevision);

    let firstError: unknown = null;
    try {
      await svc.checkpoint();
    } catch (err) {
      firstError = err;
    }
    assert.ok(firstError instanceof PersistenceError, '真实 checkpoint 必须抛出 PersistenceError');
    assert.equal(firstError.kind, 'capacity');
    const firstFacts = errorFacts(firstError);
    assert.equal(firstFacts.kind, 'capacity');
    assert.equal(firstFacts.name, 'PersistenceError');
    assert.ok(firstFacts.message.length > 0, '容量错误必须保留可理解的原始消息');

    // 失败保存不确认任何版本，不抹除脏状态与内存证据。
    const afterFailure = svc.getPersistenceState();
    assert.equal(afterFailure.confirmedVoxelRevision, before.confirmedVoxelRevision);
    assert.equal(afterFailure.confirmedFragmentRevision, before.confirmedFragmentRevision);
    assert.equal(afterFailure.confirmedTopologyRevision, before.confirmedTopologyRevision);
    assert.equal(afterFailure.lastConfirmedCheckpointId, before.lastConfirmedCheckpointId);
    assert.equal(afterFailure.dirty, true);
    const retainedCell = voxel.cellAt(firstObs.dimension, firstObs.pos.x, firstObs.pos.y, firstObs.pos.z);
    assert.ok(retainedCell.observed);
    assert.deepEqual(structuredClone(retainedCell.evidence), originalEvidence, '失败保存不得删除真实内存事实');

    // 已完成移动对象与快照不得被保存失败改写；未保存是独立事实。
    assert.strictEqual(a.result, originalResultA);
    assert.strictEqual(a.result.data?.nav, navA);
    assert.deepEqual(a.result, resultASnapshot);
    assert.deepEqual(navA, navASnapshot);
    assert.notEqual(navA.memoryWrite, 'saved');

    const doneB = doneOf(arbiter);
    arbiter.start({ skill: 'walk_route', args: { points: POINTS_B } }, 'llm');
    const b = await doneB;
    assert.equal(b.result.status, 'succeeded', b.result.summary);
    assert.ok(b.result.data);
    const navB = b.result.data.nav as NavResult;
    assert.equal(navB.outcome, 'ARRIVED');
    assert.equal(navB.confirmed, true);
    assert.ok(navB.lastPosition !== undefined);
    assert.equal(svc.closing, false, '失败的保存不得关闭仍在运行的服务');
    assert.equal(svc.session.voxel, voxel, 'B 必须复用同一个共享地图');
    assert.strictEqual(a.result, originalResultA);
    assert.strictEqual(a.result.data?.nav, navA);
    assert.deepEqual(a.result, resultASnapshot);
    assert.deepEqual(navA, navASnapshot);
    const cellAfterB = voxel.cellAt(firstObs.dimension, firstObs.pos.x, firstObs.pos.y, firstObs.pos.z);
    assert.ok(cellAfterB.observed, 'B 之后原始格仍必须被见过（允许 B 的真实观测刷新时间）');

    // 实际最终关停：可能产生新的容量错误，但不要求与第一次是同一对象。
    shutdown = await svc.shutdown();
    assert.ok(shutdown.error instanceof PersistenceError);
    const finalFacts = errorFacts(shutdown.error);
    assert.equal(finalFacts.kind, 'capacity');
    assert.ok(finalFacts.message.length > 0);
    assert.equal(shutdown.checkpoint, null);
    assert.equal(shutdown.cancelError, null);
    assert.equal(shutdown.closeError, null);
    assert.ok(shutdown.close !== null, '容量失败不得跳过真实 close');
    assert.equal(shutdown.close.completed, true);
    assert.equal(shutdown.close.error, null);
    assert.equal(shutdown.close.unconfirmedRequest, false);
    assert.equal(shutdown.close.dirty, true);
    assert.equal(shutdown.close.lastConfirmedCheckpointId, null);
    const afterShutdown = svc.getPersistenceState();
    assert.equal(afterShutdown.dirty, true, '未保存的真实脏事实不得被关停抹掉');
    // 两次容量保存都未确认任何版本：状态必须与第一次失败前一致。
    assert.equal(afterShutdown.confirmedVoxelRevision, before.confirmedVoxelRevision);
    assert.equal(afterShutdown.confirmedFragmentRevision, before.confirmedFragmentRevision);
    assert.equal(afterShutdown.confirmedTopologyRevision, before.confirmedTopologyRevision);
    assert.equal(afterShutdown.lastConfirmedCheckpointId, before.lastConfirmedCheckpointId);
    // 最终关停也不得改写已完成的 A 移动对象或快照。
    assert.strictEqual(a.result, originalResultA);
    assert.strictEqual(a.result.data?.nav, navA);
    assert.deepEqual(a.result, resultASnapshot);
    assert.deepEqual(navA, navASnapshot);
    assert.notEqual(navA.memoryWrite, 'saved');

    const diagnostics = spatialShutdownDiagnostics(shutdown, WORLD);
    assert.equal(diagnostics.ok, false);
    assert.ok(diagnostics.problems.includes('primary_save_error'));
    assert.ok(diagnostics.problems.includes('missing_checkpoint'));
    assert.ok(diagnostics.problems.includes('close_dirty'));
    assert.deepEqual(diagnostics.primarySaveError, finalFacts);
    assert.equal(diagnostics.primarySaveError?.kind, 'capacity');
    assert.equal(diagnostics.primarySaveError?.name, 'PersistenceError');
    assert.ok((diagnostics.primarySaveError?.message ?? '').length > 0);
    assert.equal(diagnostics.checkpoint, null);
    assert.equal(diagnostics.cancelError, null);
    assert.equal(diagnostics.closeError, null);
    assert.ok(diagnostics.close !== null);
    assert.equal(diagnostics.close.completed, true);
    assert.equal(diagnostics.close.error, null);
    assert.equal(diagnostics.close.unconfirmedRequest, false);
    assert.equal(diagnostics.close.dirty, true);

    t.diagnostic(JSON.stringify({
      a: { task: { id: a.task.id, planVersion: a.task.planVersion, args: a.task.args }, result: a.result },
      b: { task: { id: b.task.id, planVersion: b.task.planVersion, args: b.task.args }, result: b.result },
      firstCapacity: firstFacts,
      persistence: { before, afterFailure, afterShutdown },
      finalShutdown: {
        checkpoint: shutdown.checkpoint,
        primarySaveError: finalFacts,
        cancelError: shutdown.cancelError,
        close: shutdown.close,
        closeError: shutdown.closeError,
      },
      diagnostics,
    }));

    assertionsPassed = true;
  } finally {
    // dispose 只注销 listener，不关闭共享服务。
    arbiter?.dispose();
    if (shutdown === null) {
      try {
        shutdown = await svc.shutdown();
      } catch (err) {
        shutdownFailure = err;
      }
    }
    const closeKnown = shutdown !== null && shutdown.close !== null &&
      shutdown.close.completed && shutdown.close.error === null &&
      shutdown.close.unconfirmedRequest === false;
    // 只有确认干净 close 且断言全部成功才删除本测试的 mkdtemp fixture。
    if (assertionsPassed && shutdownFailure === null && closeKnown) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
