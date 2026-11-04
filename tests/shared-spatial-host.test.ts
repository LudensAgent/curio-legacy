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
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { BodySample, ChangeReport } from 'curio-minecraft-3d-memory';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { WalkBody } from '../src/adapter/walk-route.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { config } from '../src/config.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'fake-world';
const POINTS_A = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
const POINTS_B = [{ x: 1.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }];

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
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
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
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
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
    return () => new Promise<WalkBody['entity'] | null>((resolve) => {
      setTimeout(() => {
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
  const { svc, dir } = await openShared();
  const adapter = new WalkHostAdapter();
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);

  const tokens: number[] = [];
  const detached: number[] = [];
  const attach = svc.attach.bind(svc);
  const detach = svc.detach.bind(svc);
  svc.attach = (attachment) => {
    const token = attach(attachment);
    tokens.push(token);
    return token;
  };
  svc.detach = (token) => {
    detached.push(token);
    detach(token);
  };

  try {
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
    const b = await doneB;
    assert.equal(b.result.status, 'succeeded', b.result.summary);
    assert.equal((b.result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
    assert.notEqual(tokens[1], tokens[0]);
    assert.equal(svc.closing, false);
    assert.equal(svc.session.voxel, voxel);
    assert.equal(svc.session.voxel.cellAt('overworld', 2, -1, 0).observed, true, 'B 的实际观测事实必须写入同一张地图');
  } finally {
    arbiter.dispose();
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
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);

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
    arbiter.dispose();
    await closeShared(svc, dir);
  }
});

test('真实 Arbiter.setPaused 零观测间隔即 stale 证据并取消旧委托，恢复只接纳实际观测', async () => {
  const { svc, dir } = await openShared();
  const adapter = new WalkHostAdapter();
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 24 }, svc);
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision, svc);

  let cancels = 0;
  const attach = svc.attach.bind(svc);
  svc.attach = (attachment) => attach({
    receiver: attachment.receiver,
    cancel: () => { cancels++; attachment.cancel(); },
  });

  try {
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
    arbiter.dispose();
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
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), new Vision(adapter), svc);

  let resets = 0;
  adapter.on('session_reset', () => { resets++; });

  try {
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

    // 监听器异常只产生诊断，不得中断 newSession/end 的后续处理。
    adapter.on('session_reset', () => { throw new Error('listener boom'); });
    harness.dimension = 'the_nether';
    harness.bot = { game: { dimension: 'minecraft:the_end' } };
    const next = adapter.state();
    assert.notEqual(next.sessionId, changed.sessionId, '异常监听器不得中断 newSession 的会话更新');
    const diagnostic = bus.recent().find((event) => event.type === 'adapter_event_error');
    assert.ok(diagnostic, '监听器错误必须作为诊断发布');
    assert.match(diagnostic.msg, /Error: listener boom/);
  } finally {
    arbiter.dispose();
    await closeShared(svc, dir);
  }
});
