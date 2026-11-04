/**
 * walk_to 的定向验收：真实安装库的公开 WalkRouteSearch、真实公共 walk_route 执行后端
 * 与现有 prismarine 离线身体。地图由共享会话的公开 observe 写入（离线夹具，不连接
 * Bot/server，也不声称真实 Vision 集成通过）。
 */
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { RouteVerifier, type NavResult, type Vec3Like, type WalkSearchSnapshot } from 'curio-minecraft-3d-memory';
import { Vision, DEFAULT_VISION } from '../src/perception/vision.ts';
import { walkCollisionProvider } from '../src/adapter/walk-route.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { walkTo } from '../src/skills/spatial-navigation.ts';
import { runSkill } from '../src/skills/types.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'world';
const DIM = 'overworld';
const SESSION = 's1';
const START = { x: 0.54, y: 0, z: 0.52 };

function flatWorld() {
  return {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const stateId = p.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
}

function physicsFixture(start = { x: START.x, z: START.z }) {
  const control: Record<string, boolean> = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  const entity = {
    position: new Vec3(start.x, 0, start.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false,
    isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  let writes = 0;
  let clears = 0;
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { writes++; control[name] = value; },
    clearControlStates() { clears++; for (const k of Object.keys(control)) control[k] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  return {
    bot, entity, control,
    tickOnce() { physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot); },
    writes: () => writes,
    clears: () => clears,
  };
}

type EntityFrame = { position: Vec3Like; velocity: Vec3Like; onGround: boolean; isInWater: boolean };

function snapshot(entity: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  onGround: boolean;
  isInWater: boolean;
}): EntityFrame {
  return {
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
    onGround: entity.onGround,
    isInWater: entity.isInWater,
  };
}

/** 真实 prismarine 物理身体 + 50ms 帧延迟（足够形成 stableMs 窗口）。 */
function physicsHarness(opts?: { look?: boolean; delayMs?: number }) {
  const fixture = physicsFixture();
  const delayMs = opts?.delayMs ?? 50;
  let frames = 0;
  let looks = 0;
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const timer = setTimeout(() => {
      cleanup();
      fixture.tickOnce();
      frames++;
      resolve(snapshot(fixture.entity));
    }, delayMs);
    const onAbort = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const adapter = {
    state: () => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
      pos: { x: fixture.entity.position.x, y: fixture.entity.position.y, z: fixture.entity.position.z },
    }),
    walkBody: () => ({
      setControlState: (name: string, value: boolean) => fixture.bot.setControlState(name, value),
      clearControlStates: () => fixture.bot.clearControlStates(),
      look: (yaw: number, pitch: number) => fixture.bot.look(yaw, pitch),
      entity: {
        position: fixture.entity.position, velocity: fixture.entity.velocity,
        onGround: fixture.entity.onGround, isInWater: fixture.entity.isInWater,
      },
    }),
    walkTick: () => tick,
    ...(opts?.look ? { look: async () => { looks++; } } : {}),
  } as unknown as GameAdapter;
  return { adapter, fixture, frames: () => frames, looks: () => looks };
}

/**
 * 真实 Vision 的离线光学世界：FakeAdapter 提供方块、遮挡、状态与光照，脚位跟随现有
 * physics 夹具。观测仍完全由实际 `Vision.observeBlocks` 的视锥/遮挡/完整性决定。
 */
class VisionProbeAdapter extends FakeAdapter {
  feet: () => Vec3Like = () => ({ ...START });
  looks = 0;
  walkBody?: GameAdapter['walkBody'];
  walkTick?: GameAdapter['walkTick'];
  override async look(yaw: number, pitch: number) {
    this.looks++;
    await super.look(yaw, pitch);
  }
  override state() {
    const s = super.state();
    return { ...s, worldId: WORLD, sessionId: SESSION, dim: DIM, pos: this.feet() };
  }
  override eye() {
    const e = super.eye();
    const f = this.feet();
    return e === null ? null : { ...e, x: f.x, y: f.y + 1.62, z: f.z };
  }
  override lightAt() { return { block: 0, sky: 15 }; }
}

/** 无移动的脚本身体；tick 由测试决定，控制写入单独计数。 */
function scriptedHarness(opts: {
  position?: () => Vec3Like;
  tick: (signal: AbortSignal) => Promise<EntityFrame | null>;
  state?: () => {
    alive?: boolean; connected?: boolean; observationReady?: boolean;
    worldId?: string; dim?: string; sessionId?: string;
  };
  look?: boolean;
}) {
  const control: Record<string, boolean> = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  let writes = 0;
  let clears = 0;
  let tickCalls = 0;
  let looks = 0;
  const pos = opts.position ?? (() => ({ ...START }));
  const body = {
    setControlState(name: string, value: boolean) { writes++; control[name] = value; },
    clearControlStates() {
      clears++;
      for (const k of Object.keys(control)) control[k] = false;
    },
    look() {},
    entity: { position: { ...pos() }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  };
  const adapter = {
    state: () => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
      pos: { ...pos() }, ...(opts.state?.() ?? {}),
    }),
    walkBody: () => body,
    walkTick: () => (signal: AbortSignal) => { tickCalls++; return opts.tick(signal); },
    ...(opts.look ? { look: async () => { looks++; } } : {}),
  } as unknown as GameAdapter;
  return {
    adapter, control,
    writes: () => writes,
    clears: () => clears,
    tickCalls: () => tickCalls,
    looks: () => looks,
  };
}

/**
 * 尊重 signal 的真实事件式物理帧源：等待期间注册 physicsTick/end 监听，signal 中止时
 * resolve(null) 并解除自己注册的全部监听（与 Mineflayer.walkTick 的 onAbort 形态一致）。
 * 用于验证中断/期限能在已进入真实 pending 的等待中有界唤醒，而不是靠帧源忽略 signal。
 */
function eventEmitterTick() {
  const source = new EventEmitter();
  let enteredResolve: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    enteredResolve?.();
    const onAbort = () => { cleanup(); resolve(null); };
    const onFrame = (frame: EntityFrame) => { cleanup(); resolve(frame); };
    const onEnd = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      source.off('physicsTick', onFrame);
      source.off('end', onEnd);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    source.on('physicsTick', onFrame);
    source.on('end', onEnd);
  });
  return {
    entered,
    tick,
    ownedListeners: () => source.listenerCount('physicsTick') + source.listenerCount('end'),
  };
}

/** 可阻塞转头的准备夹具：控制 look 何时返回，观测请求单独计数；可切换 observationReady。 */
function blockedLookHarness(opts?: { observationReady?: () => boolean }) {
  let scope = { worldId: WORLD, dim: DIM, sessionId: SESSION };
  let looks = 0;
  let observes = 0;
  let writes = 0;
  let pendingLook: (() => void) | null = null;
  let lookStartedResolve: (() => void) | null = null;
  const lookStarted = new Promise<void>((resolve) => { lookStartedResolve = resolve; });
  const control: Record<string, boolean> = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  const body = {
    setControlState(name: string, value: boolean) { writes++; control[name] = value; },
    clearControlStates() { writes++; for (const k of Object.keys(control)) control[k] = false; },
    look() {},
    entity: { position: { ...START }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  };
  const adapter = {
    state: () => ({
      ...scope, alive: true, connected: true, observationReady: opts?.observationReady?.() ?? true, pos: { ...START },
    }),
    walkBody: () => body,
    walkTick: () => () => Promise.resolve(null),
    look: () => {
      looks++;
      lookStartedResolve?.();
      return new Promise<void>((resolve) => { pendingLook = resolve; });
    },
  } as unknown as GameAdapter;
  return {
    adapter,
    senses: { observeBlocks: () => { observes++; return []; } },
    looks: () => looks,
    observes: () => observes,
    writes: () => writes,
    lookStarted,
    resolveLook: () => { pendingLook?.(); pendingLook = null; },
    setDim: (dim: string) => { scope = { ...scope, dim }; },
  };
}

/** 一条同高合法走廊：x=0..2、z=0，支撑/脚/头都来自真实公开 observe。 */
function seedCorridor(h: { perception: ReturnType<typeof makePerception> }) {
  h.perception.seed({ xFrom: 0, xTo: 2, zFrom: 0, zTo: 0, yFrom: -1, yTo: 1 });
}

/** 用真实公开 RouteVerifier 在同一张共享地图上登记并验证一条 OPEN 走廊。 */
function openCorridorVerifier(h: { svc: SharedSpatialSession }): RouteVerifier {
  const verifier = new RouteVerifier(h.svc.session.voxel, { now: Date.now });
  verifier.register({
    worldId: WORLD, dim: DIM, sessionId: SESSION, mode: 'walk',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
    shapeProvider: walkCollisionProvider,
  });
  assert.equal(verifier.advance(10).verdict, 'OPEN');
  return verifier;
}

function cellEvidence(h: { svc: SharedSpatialSession }, x: number, y: number, z: number) {
  const view = h.svc.session.voxel.cellAt(DIM, x, y, z);
  if (!view.observed) throw new Error(`cell ${x},${y},${z} should be observed`);
  return view.evidence;
}

/**
 * 记录服务实际 interrupt 次数，并把原始 interrupt 返回的真实 ChangeReport 交给原 verifier；
 * 不构造替代报告或替代新鲜度。返回读取计数的函数。
 */
function countInterrupts(svc: SharedSpatialSession, verifier: RouteVerifier): () => number {
  const original = svc.interrupt.bind(svc);
  let count = 0;
  svc.interrupt = () => {
    count++;
    const report = original();
    verifier.apply(report, 10);
    return report;
  };
  return () => count;
}

function makePerception(svc: SharedSpatialSession) {
  let seq = 1;
  type Cell = { x: number; y: number; z: number; solid: boolean };
  const observe = (cells: Cell[], observedAt: number): BlockObservation[] => {
    const observations = cells.map((c): BlockObservation => ({
      name: c.solid ? 'minecraft:stone' : 'minecraft:air',
      properties: {}, stateComplete: true, pos: { x: c.x, y: c.y, z: c.z },
      worldId: WORLD, sessionId: SESSION, dimension: DIM,
      observationId: seq++, observedAt, source: 'vision',
    }));
    if (observations.length > 0) svc.observe(observations);
    return observations;
  };
  return {
    senses: {
      observeBlocks(positions: Vec3Like[]) {
        return observe(positions.map((p) => ({ x: p.x, y: p.y, z: p.z, solid: p.y === -1 })), Date.now());
      },
    },
    seed(spec: {
      xFrom: number; xTo: number; zFrom?: number; zTo?: number; yFrom?: number; yTo?: number;
      observedAt?: number; solid?: (x: number, y: number, z: number) => boolean;
    }) {
      const cells: Cell[] = [];
      const zFrom = spec.zFrom ?? 0;
      const zTo = spec.zTo ?? 0;
      const yFrom = spec.yFrom ?? -1;
      const yTo = spec.yTo ?? 2;
      for (let x = spec.xFrom; x <= spec.xTo; x++) {
        for (let z = zFrom; z <= zTo; z++) {
          for (let y = yFrom; y <= yTo; y++) {
            cells.push({ x, y, z, solid: spec.solid ? spec.solid(x, y, z) : y === -1 });
          }
        }
      }
      return observe(cells, spec.observedAt ?? Date.now());
    },
    observeStone(x: number, y: number, z: number) {
      svc.observe([{
        name: 'minecraft:stone', properties: {}, stateComplete: true, pos: { x, y, z },
        worldId: WORLD, sessionId: SESSION, dimension: DIM,
        observationId: seq++, observedAt: Date.now(), source: 'vision',
      }]);
    },
  };
}

async function openHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-navigation-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  return { svc, dir, perception: makePerception(svc) };
}

async function closeHarness(h: { svc: SharedSpatialSession; dir: string }): Promise<void> {
  const result = await h.svc.shutdown();
  assert.equal(result.error, null);
  assert.equal(result.cancelError, null);
  assert.equal(result.closeError, null);
  assert.ok(result.close !== null, 'real close must return a result');
  assert.equal(result.close.completed, true);
  rmSync(h.dir, { recursive: true, force: true });
}

function context(
  adapter: GameAdapter,
  svc: SharedSpatialSession,
  senses: { observeBlocks(positions: Vec3Like[]): BlockObservation[] },
  opts?: { signal?: AbortSignal; deadline?: number },
) {
  const state: { stationary: boolean | null } = { stationary: null };
  const ctx = {
    adapter, senses, spatial: svc,
    signal: opts?.signal ?? new AbortController().signal,
    deadline: opts?.deadline ?? Date.now() + 15000,
    taskId: 'walk-to-test',
    progress() {},
    setStationaryWait(waiting: boolean) { state.stationary = waiting; },
  };
  return { ctx: ctx as never, stationary: () => state.stationary };
}

function searchOf(result: { data?: Record<string, unknown> }): WalkSearchSnapshot {
  return result.data?.search as WalkSearchSnapshot;
}

function navOf(result: { data?: Record<string, unknown> }): NavResult {
  return result.data?.nav as NavResult;
}

function distance3d(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test('walk_to 参数边界：显式 arrival、有限坐标、near 正半径，缺共享会话如实失败', async () => {
  const okNear = walkTo.validate({ to: [-1.5, 0.25, -2.25], arrival: { kind: 'near', radius: 1.5 } }, {} as never);
  assert.ok(okNear.ok);
  if (okNear.ok) {
    assert.deepEqual(okNear.args.to, { x: -1.5, y: 0.25, z: -2.25 }, '保留负数与小数，不取整');
    assert.deepEqual(okNear.args.arrival, { kind: 'near', radius: 1.5 });
  }
  const okExact = walkTo.validate({ to: { x: 1.5, y: 0, z: -2.5 }, arrival: { kind: 'exact' } }, {} as never);
  assert.ok(okExact.ok);
  assert.ok(!walkTo.validate({ to: [0, 0, 0] }, {} as never).ok, 'arrival 必须显式');
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: 0 } }, {} as never).ok);
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: -1 } }, {} as never).ok);
  const okWide = walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: 33 } }, {} as never);
  assert.ok(okWide.ok, 'near 半径 33 合法，无任意上限');
  if (okWide.ok) assert.deepEqual(okWide.args.arrival, { kind: 'near', radius: 33 }, '半径原样保留，不取整');
  const okFractional = walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: 33.25 } }, {} as never);
  assert.ok(okFractional.ok);
  if (okFractional.ok) assert.deepEqual(okFractional.args.arrival, { kind: 'near', radius: 33.25 }, '不做 coerce/round');
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: '33' } }, {} as never).ok, '不做字符串 coerce');
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: Number.POSITIVE_INFINITY } }, {} as never).ok);
  assert.ok(!walkTo.validate({ to: [Number.NaN, 0, 0], arrival: { kind: 'exact' } }, {} as never).ok);
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: 1 }, deadlineMs: -1 }, {} as never).ok);
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'exact' }, deadlineMs: Number.POSITIVE_INFINITY }, {} as never).ok);

  const missing = await walkTo.run(
    { adapter: {}, senses: { observeBlocks: () => [] }, deadline: Date.now() + 1000, signal: new AbortController().signal, taskId: 't', progress() {} } as never,
    { to: { x: 0, y: 0, z: 0 }, arrival: { kind: 'exact' } },
  );
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /ctx\.spatial/);
});

test('walk_to exact 非 lattice 或不同高不投影，零帧零控制', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = physicsHarness({ look: true });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const cases = [
      { to: { x: 1.5, y: 0, z: 0.52 }, label: '非整数 X 偏移' },
      { to: { x: 0.54, y: 0.5, z: 0.52 }, label: '不同脚高' },
    ];
    for (const cse of cases) {
      const looksBefore = fixture.looks();
      const result = await runSkill(c.ctx, walkTo, { to: cse.to, arrival: { kind: 'exact' } });
      assert.equal(result.status, 'failed', cse.label);
      assert.equal(result.data?.stage, 'UNSUPPORTED', cse.label);
      const snap = searchOf(result);
      assert.equal(snap.state, 'UNSUPPORTED');
      assert.equal(snap.problem?.kind, 'unsupported_target');
      assert.deepEqual(result.data?.target, cse.to, '原目标不投影/不取整');
      assert.deepEqual(snap.target, cse.to);
      assert.equal(snap.candidate, null);
      assert.equal(fixture.frames(), 0, `${cse.label}: 不得订阅物理帧`);
      assert.equal(fixture.fixture.writes(), 0, `${cse.label}: 不得写控制`);
      assert.ok(fixture.looks() - looksBefore <= 12, `${cse.label}: 每次局部准备转头不超过 12 次`);
      assert.equal(c.stationary(), false, 'stationary wait 应恢复');
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to near 正向：真实公开搜索找到候选并由真实公共执行后端走通', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 6, zFrom: -2, zTo: 2 });
    const fixture = physicsHarness();
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const target = { x: 2.54, y: 0, z: 0.52 };
    const result = await runSkill(c.ctx, walkTo, { to: target, arrival: { kind: 'near', radius: 0.5 } });

    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal(result.data?.stage, 'ARRIVED');
    const snap = searchOf(result);
    assert.equal(snap.state, 'FOUND');
    assert.ok(snap.candidate !== null);
    assert.equal(snap.candidate.edgeCount, 2, 'BFS 应先找到两格短路线');
    assert.deepEqual(snap.limits, { maxNodes: 512, maxEdges: 2048, maxFrontiers: 32, maxDiagnostics: 32 });
    const nav = navOf(result);
    assert.equal(nav.outcome, 'ARRIVED');
    assert.ok(nav.outcome === 'ARRIVED');
    const position = result.data?.position as Vec3Like;
    assert.ok(distance3d(position, target) <= 0.5, `实测末位应在原 near 半径内，实际 ${distance3d(position, target)}`);
    assert.deepEqual(position, nav.lastPosition);
    assert.deepEqual(result.data?.target, target);
    assert.deepEqual(result.data?.originalRequest, { to: target, arrival: { kind: 'near', radius: 0.5 } });
    assert.ok(fixture.fixture.entity.position.x > START.x + 1, '应实际发生位移，而不是只返回 FOUND');
    assert.ok(fixture.frames() > 0);
    for (const key of Object.keys(fixture.fixture.control)) {
      assert.equal(fixture.fixture.control[key], false, `到达后 ${key} 键应释放`);
    }
    assert.equal(c.stationary(), false);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to near 候选到达但实测越原半径时不得 success，保留执行 nav/partial', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 6, zFrom: -2, zTo: 2 });
    const fixture = physicsHarness();
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    // 目标与格点 stance 的 Y 相差 0.045，near 半径 0.0451：搜索能接受候选，
    // 但执行器的水平落地容差会让实测末位偏离原目标的完整 XYZ 半径。
    const target = { x: 1.54, y: -0.045, z: 0.52 };
    const result = await runSkill(c.ctx, walkTo, { to: target, arrival: { kind: 'near', radius: 0.0451 } });

    assert.equal(result.status, 'failed', '候选到达不得冒充原 near 目标成功');
    assert.equal(result.data?.stage, 'unconfirmed_arrival');
    assert.equal(result.data?.confirmed, false);
    // data.nav 描述原委托：原 near 条件未确认，必须是 FAILED，而不是候选执行器的 ARRIVED。
    const nav = navOf(result);
    assert.ok(nav.outcome === 'FAILED', `data.nav 应表示原委托失败，实际 ${nav.outcome}`);
    assert.equal(nav.confirmed, false);
    assert.ok(nav.problem.kind === 'unconfirmed_arrival');
    assert.deepEqual(nav.problem.expected, target);
    assert.ok(nav.lastPosition, '执行 partial/实测位置必须保留');
    const position = result.data?.position as Vec3Like;
    const actual = distance3d(position, target);
    assert.ok(actual > 0.0451, `实测末位应越原半径，实际 ${actual}`);
    assert.deepEqual(position, nav.lastPosition);
    // 原候选执行的 ARRIVED 原样保存在 executionNav，时间/位置/trace 不在委托投影中被改写。
    const executionNav = result.data?.executionNav as NavResult;
    assert.ok(executionNav.outcome === 'ARRIVED', '候选末点确由执行器真实到达');
    assert.equal(executionNav.confirmed, true);
    assert.deepEqual(nav.lastPosition, executionNav.lastPosition, '原执行位置原样保留');
    assert.deepEqual(nav.lastObservation, executionNav.lastObservation, '原观测时间/作用域原样保留');
    assert.deepEqual(nav.trace, executionNav.trace, '原执行 trace 原样保留');
    assert.ok(nav.trace.length > 0, '真实执行应留下 trace');
    assert.deepEqual((result.data?.problem as { kind?: string }).kind, 'unconfirmed_arrival');
    assert.deepEqual(result.data?.originalRequest, { to: target, arrival: { kind: 'near', radius: 0.0451 } });
    assert.deepEqual(result.data?.target, target, '原目标不可变');
    for (const key of Object.keys(fixture.fixture.control)) {
      assert.equal(fixture.fixture.control[key], false, `结束后 ${key} 键应释放`);
    }
  } finally {
    await closeHarness(h);
  }
});

// 离线真实 Vision 链：实际 Vision.observeBlocks → 共享会话写入 → 公开 WalkRouteSearch →
// 现有 physics 闭环。不连接 Bot/server，也不声称 live 集成已通过。
test('walk_to 实际 Vision 链：空共享图经固定半径4准备取证，公开搜索与 physics 闭环走两格 exact', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const voxel = h.svc.session.voxel;
    assert.equal(voxel.cellAt(DIM, 0, 0, 0).observed, false, '共享地图开始应真正为空');

    // 现有 physics 闭环提供连续身体起点与真实帧；VisionProbe 只替换光学查询。
    const physics = physicsHarness();
    const adapter = new VisionProbeAdapter();
    let bodyLooks = 0;
    const botLook = physics.fixture.bot.look.bind(physics.fixture.bot);
    // 执行段的 body.look 只推进 physics 朝向；真实 Vision.eye 读的是 adapter 的公开
    // yaw/pitch，因此同步到 FakeAdapter，准备转头仍由 adapter.look 单独计数。
    physics.fixture.bot.look = (yaw: number, pitch: number) => {
      bodyLooks++;
      botLook(yaw, pitch);
      adapter.yaw = yaw;
      adapter.pitch = pitch;
    };
    adapter.feet = () => ({
      x: physics.fixture.entity.position.x, y: physics.fixture.entity.position.y, z: physics.fixture.entity.position.z,
    });
    adapter.walkBody = () => physics.adapter.walkBody!();
    adapter.walkTick = () => physics.adapter.walkTick!();
    adapter.groundY = -1;
    // 真实遮挡负例：z=3 的整排石墙挡住 z=4 的矿石，合法视线不应把矿石写成事实。
    for (let x = -4; x <= 4; x++) for (let y = 0; y <= 2; y++) adapter.blocks.push({ name: 'stone', pos: { x, y, z: 3 } });
    adapter.blocks.push({ name: 'diamond_ore', pos: { x: 2, y: 0, z: 4 } });

    const vision = new Vision(adapter, DEFAULT_VISION, h.svc);
    const batches: Vec3Like[][] = [];
    const senses = {
      observeBlocks(positions: Vec3Like[]) {
        batches.push(positions.map((p) => ({ ...p })));
        return vision.observeBlocks(positions);
      },
    };

    const c = context(adapter, h.svc, senses, { deadline: Date.now() + 25_000 });
    const target = { x: START.x + 2, y: START.y, z: START.z };
    const result = await runSkill(c.ctx, walkTo, { to: target, arrival: { kind: 'exact' } });

    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal(result.data?.stage, 'ARRIVED');
    const snap = searchOf(result);
    assert.equal(snap.state, 'FOUND');
    assert.equal(snap.candidate?.edgeCount, 2, '应找到两格 exact 候选');
    assert.deepEqual(result.data?.target, target, '原目标不投影/不取整');
    const position = result.data?.position as Vec3Like;
    assert.ok(Math.hypot(position.x - target.x, position.z - target.z) <= 0.12, `exact 末位应在既有 grounded 容差内，实际 ${position.x},${position.z}`);
    assert.ok(Math.abs(position.y - target.y) < 1e-6);
    assert.ok(physics.fixture.entity.position.x > START.x + 1.5, '应实际走两格，而不是只返回 FOUND');
    for (const key of Object.keys(physics.fixture.control)) {
      assert.equal(physics.fixture.control[key], false, `到达后 ${key} 键应释放`);
    }

    // 准备请求证据：每批 ≤32；固定半径 4 的 9×9×4 共 324 格全部被请求，不随目标扩张。
    assert.ok(batches.length > 0);
    for (const batch of batches) assert.ok(batch.length > 0 && batch.length <= 32, `observeBlocks 每批必须 ≤32，实际 ${batch.length}`);
    const unique = new Map<string, Vec3Like>();
    for (const batch of batches) for (const p of batch) unique.set(`${p.x},${p.y},${p.z}`, p);
    assert.equal(unique.size, 9 * 9 * 4, '固定准备范围应恰好覆盖 324 格');
    for (const p of unique.values()) {
      assert.ok(p.x >= -4 && p.x <= 4 && p.z >= -4 && p.z <= 4, `请求格超出固定水平半径 4：${p.x},${p.z}`);
      assert.ok(p.y >= -1 && p.y <= 2, `请求格超出 4 层（支撑/脚/头/净空）：y=${p.y}`);
    }
    assert.ok(adapter.looks > 0 && adapter.looks <= 12, `准备转头必须 ≤12，实际 ${adapter.looks}`);
    assert.ok(bodyLooks > 0, '执行段自己的 look 应与准备转头分开计数');

    // 实际 Vision 只写它真正看见的格：可见墙格存在，墙后矿石不存在。
    const hidden = voxel.cellAt(DIM, 2, 0, 4);
    assert.equal(hidden.observed, false, '墙后矿石不得成为观察事实');
    const wall = voxel.cellAt(DIM, 1, 0, 3);
    assert.ok(wall.observed, '实际可见的墙格应写入共享地图');
    assert.equal(wall.observed && wall.evidence.observation.state.name, 'stone');
    const rememberedNames = [...unique.values()].flatMap((p) => {
      const cell = voxel.cellAt(DIM, p.x, p.y, p.z);
      return cell.observed ? [cell.evidence.observation.state.name] : [];
    });
    assert.ok(!rememberedNames.includes('diamond_ore'), '隐藏方块的精确名称不得被写入');
    assert.ok(rememberedNames.length < 9 * 9 * 4, '不得伪称全部 324 格都可看见');
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 未知证据不当作可走：INSUFFICIENT_EVIDENCE、零帧零控制', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null), look: true });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    // 目标在固定半径 4 的准备范围之外：本轮只重见了起点 9×9×4，不能把更远处当作已知。
    const result = await runSkill(c.ctx, walkTo, { to: { x: 6.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'INSUFFICIENT_EVIDENCE');
    const snap = searchOf(result);
    assert.equal(snap.state, 'INSUFFICIENT_EVIDENCE');
    assert.equal(snap.problem?.kind, 'insufficient_evidence');
    assert.ok(snap.counters.edgesUnknown > 0, '应实际读到 UNKNOWN 边界');
    assert.equal(snap.candidate, null);
    assert.equal(fixture.tickCalls(), 0, '搜索失败不得启动执行帧');
    assert.equal(fixture.writes(), 0, '搜索失败不得写控制');
  } finally {
    await closeHarness(h);
  }
});

test('walk_to STALE 证据不当作可走：INSUFFICIENT_EVIDENCE、零控制', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    // 固定准备范围（半径 4）之外仍是过期证据；目标设在更远处，路径必须跨过这些旧格。
    h.perception.seed({ xFrom: -2, xTo: 8, observedAt: Date.now() - 120_000 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const result = await runSkill(c.ctx, walkTo, { to: { x: 8.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'INSUFFICIENT_EVIDENCE');
    const snap = searchOf(result);
    assert.equal(snap.state, 'INSUFFICIENT_EVIDENCE');
    assert.ok(snap.counters.edgesStale > 0, '应实际读到 STALE 边界');
    assert.equal(snap.candidate, null);
    assert.equal(fixture.tickCalls(), 0);
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 搜索预算固定且有界：节点/边上限触发 BUDGET_EXHAUSTED，不执行候选', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 602 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const result = await runSkill(c.ctx, walkTo, { to: { x: 560.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'BUDGET_EXHAUSTED');
    const snap = searchOf(result);
    assert.equal(snap.state, 'BUDGET_EXHAUSTED');
    assert.deepEqual(snap.limits, { maxNodes: 512, maxEdges: 2048, maxFrontiers: 32, maxDiagnostics: 32 });
    assert.ok(snap.counters.nodesReached <= 512);
    assert.ok(snap.counters.edgesEvaluated <= 2048);
    assert.ok(snap.counters.frontiersReported <= 32);
    assert.ok(snap.frontiers.length <= 32);
    assert.ok(snap.diagnostics.length <= 32);
    assert.equal(fixture.tickCalls(), 0);
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 搜索批次让出宏任务：父取消可及时终止且不启动移动', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 602 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const parent = new AbortController();
    const c = context(fixture.adapter, h.svc, h.perception.senses, { signal: parent.signal });
    const timer = setTimeout(() => parent.abort(), 0);
    try {
      const result = await runSkill(c.ctx, walkTo, { to: { x: 560.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
      assert.equal(result.status, 'cancelled');
      assert.equal(result.data?.stage, 'CANCELLED');
      const snap = searchOf(result);
      assert.equal(snap.state, 'CANCELLED');
      assert.ok(snap.counters.edgesEvaluated <= 32, `批次取消后不应继续评估，实际 ${snap.counters.edgesEvaluated}`);
      assert.equal(fixture.tickCalls(), 0);
      assert.equal(fixture.writes(), 0);
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0, '返回后不应残留 abort 监听');
      assert.equal(c.stationary(), false);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 父期限取 min：搜索阶段按 TIMEOUT 结束，不启动移动', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 602 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 25 });
    const result = await runSkill(c.ctx, walkTo, {
      to: { x: 560.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 }, deadlineMs: Date.now() + 60_000,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'TIMEOUT');
    assert.equal(searchOf(result).state, 'CANCELLED');
    assert.equal(fixture.tickCalls(), 0);
    assert.equal(fixture.writes(), 0);
    assert.equal(c.stationary(), false);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 搜索期间真实 map 报告使 search INVALIDATED：不自动重搜、不启动移动', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 602 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const timer = setTimeout(() => h.perception.observeStone(1, 0, 0), 5);
    try {
      const result = await runSkill(c.ctx, walkTo, { to: { x: 560.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
      assert.equal(result.status, 'failed');
      assert.equal(result.data?.stage, 'INVALIDATED');
      const snap = searchOf(result);
      assert.equal(snap.state, 'INVALIDATED');
      assert.equal(snap.candidate, null);
      assert.equal(fixture.tickCalls(), 0, '失效候选不得进入执行');
      assert.equal(fixture.writes(), 0);
      assert.equal(c.stationary(), false);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 搜索期间生命周期失效：search 取消、不启动移动', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 602 });
    let connected = true;
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null), state: () => ({ connected }) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const timer = setTimeout(() => { connected = false; }, 5);
    try {
      const result = await runSkill(c.ctx, walkTo, { to: { x: 560.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
      assert.equal(result.status, 'cancelled');
      assert.equal(result.data?.stage, 'CANCELLED');
      assert.equal(result.data?.cancelBy, 'lifecycle');
      assert.equal(searchOf(result).state, 'CANCELLED');
      assert.equal(fixture.tickCalls(), 0);
      assert.equal(fixture.writes(), 0);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 候选项点上限：超过 32 点明确 route_budget，不截断执行', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 45 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const result = await runSkill(c.ctx, walkTo, { to: { x: 40.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'route_budget');
    const snap = searchOf(result);
    assert.equal(snap.state, 'FOUND');
    assert.ok(snap.candidate !== null);
    assert.ok(snap.candidate.points.length > 32, '不得截断候选点列');
    assert.equal(fixture.tickCalls(), 0);
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边候选：真实连续稳定帧确认原完成条件，统一 nav、零控制、无伪段', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = physicsHarness();
    const c = context(fixture.adapter, h.svc, h.perception.senses);

    const assertZeroNav = (result: { data?: Record<string, unknown> }) => {
      const nav = navOf(result);
      assert.ok(nav.outcome === 'ARRIVED');
      assert.equal(nav.confirmed, true);
      assert.deepEqual(nav.trace, [], '零边不造 trace/history');
      assert.deepEqual(nav.lastPosition, result.data?.position);
      assert.equal(nav.lastObservation.worldId, WORLD);
      assert.equal(nav.lastObservation.dim, DIM);
      assert.equal(nav.lastObservation.sessionId, SESSION);
      assert.equal(nav.lastObservation.observedAt, result.data?.observedAt, 'lastObservation 对应真实接受帧');
      assert.equal(nav.lastObservation.onGround, true);
      assert.equal(nav.lastObservation.inWater, false);
    };

    const exact = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(exact.status, 'succeeded', exact.summary);
    assert.equal(exact.data?.stage, 'ARRIVED');
    assert.equal(exact.data?.zeroEdge, true);
    assert.equal(exact.data?.noop, true, '零控制零位移成功应标记 noop，不计入身体效果');
    assert.equal(exact.data?.confirmed, true);
    assert.equal(searchOf(exact).candidate?.edgeCount, 0);
    const exactPos = exact.data?.position as Vec3Like;
    assert.ok(Math.abs(exactPos.x - START.x) < 1e-9 && Math.abs(exactPos.z - START.z) < 1e-9);
    assert.ok((exact.data?.stableSamples as number) >= 2);
    assert.equal(fixture.fixture.writes(), 0, '零边确认不得写任何控制');
    assertZeroNav(exact);

    const near = await runSkill(c.ctx, walkTo, { to: { x: START.x, y: 0.08, z: START.z }, arrival: { kind: 'near', radius: 0.1 } });
    assert.equal(near.status, 'succeeded', near.summary);
    assert.equal(near.data?.zeroEdge, true);
    assert.equal(near.data?.noop, true);
    assertZeroNav(near);
    assert.equal(fixture.fixture.writes(), 0);

    // near 半径没有 32 的任意上限：33 仍合法，且零边确认按同一稳定窗口成立。
    const wide = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'near', radius: 33 } });
    assert.equal(wide.status, 'succeeded', wide.summary);
    assert.equal(wide.data?.zeroEdge, true);
    assert.equal(wide.data?.noop, true);
    assertZeroNav(wide);
    assert.equal(fixture.fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边负例：不稳定/无帧/取消均有界结束且零按键', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const unstable = scriptedHarness({
      tick: () => Promise.resolve({
        position: { ...START }, velocity: { x: 0.5, y: 0, z: 0 }, onGround: false, isInWater: false,
      }),
    });
    const c1 = context(unstable.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 2000 });
    const unstableResult = await runSkill(c1.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(unstableResult.status, 'failed');
    assert.equal(unstableResult.data?.stage, 'unconfirmed_arrival');
    assert.equal(unstableResult.data?.noop, undefined, '失败不得伪报 noop 成功');
    assert.equal(unstable.writes(), 0, '零边不稳定也不得写控制');
    const unstableNav = navOf(unstableResult);
    assert.ok(unstableNav.outcome === 'FAILED');
    assert.equal(unstableNav.confirmed, false);
    assert.deepEqual(unstableNav.trace, []);
    assert.ok(unstableNav.problem.kind === 'unconfirmed_arrival');
    assert.deepEqual(unstableNav.lastPosition, START, '不稳定帧仍是真实接受的末位');
    assert.ok(unstableNav.lastObservation, '真实接受帧应有 lastObservation');
    assert.equal(unstableNav.lastObservation.onGround, false);

    let tickCalls = 0;
    const noFrame = scriptedHarness({
      tick: () => { tickCalls++; return Promise.resolve(null); },
    });
    const c2 = context(noFrame.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 5000 });
    const noFrameResult = await runSkill(c2.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(noFrameResult.status, 'failed');
    assert.equal(noFrameResult.data?.stage, 'execution_failed');
    assert.equal(noFrameResult.data?.noop, undefined);
    assert.equal(tickCalls, 1, '帧源结束应只请求一次，不空转重试');
    assert.equal(noFrame.writes(), 0);
    const noFrameNav = navOf(noFrameResult);
    assert.ok(noFrameNav.outcome === 'FAILED');
    assert.equal(noFrameNav.confirmed, false);
    assert.deepEqual(noFrameNav.trace, []);
    assert.ok(noFrameNav.problem.kind === 'execution_failed');
    assert.equal(noFrameNav.lastPosition, undefined, '无帧不得伪造末位');

    const parent = new AbortController();
    const hanging = scriptedHarness({
      tick: (signal) => new Promise<EntityFrame | null>((resolve) => {
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    });
    const c3 = context(hanging.adapter, h.svc, h.perception.senses, { signal: parent.signal, deadline: Date.now() + 10_000 });
    const timer = setTimeout(() => parent.abort(), 30);
    try {
      const cancelled = await runSkill(c3.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.data?.stage, 'CANCELLED');
      assert.equal(cancelled.data?.noop, undefined, '取消不得伪报 noop 成功');
      assert.equal(hanging.writes(), 0);
      const cancelNav = navOf(cancelled);
      assert.ok(cancelNav.outcome === 'CANCELLED');
      assert.equal(cancelNav.confirmed, false);
      assert.deepEqual(cancelNav.trace, []);
      assert.ok(cancelNav.problem.kind === 'cancelled');
      assert.equal(cancelNav.problem.by, 'agent');
      assert.equal(cancelNav.lastPosition, undefined, '父取消无帧时不得伪造末位');
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0, '取消后不应残留监听');
      assert.equal(c3.stationary(), false);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 执行阶段父取消：保留真实 nav/partial 与候选信息', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    h.perception.seed({ xFrom: -2, xTo: 8, zFrom: -2, zTo: 2 });
    const fixture = physicsFixture();
    const parent = new AbortController();
    let forwardFrames = 0;
    const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
      if (signal.aborted) { resolve(null); return; }
      const timer = setTimeout(() => {
        cleanup();
        fixture.tickOnce();
        if (fixture.control.forward) {
          forwardFrames++;
          if (forwardFrames > 4) parent.abort();
        }
        resolve(snapshot(fixture.entity));
      }, 50);
      const onAbort = () => { cleanup(); resolve(null); };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const adapter = {
      state: () => ({
        worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
        pos: { x: fixture.entity.position.x, y: fixture.entity.position.y, z: fixture.entity.position.z },
      }),
      walkBody: () => ({
        setControlState: (name: string, value: boolean) => fixture.bot.setControlState(name, value),
        clearControlStates: () => fixture.bot.clearControlStates(),
        look: (yaw: number, pitch: number) => fixture.bot.look(yaw, pitch),
        entity: {
          position: fixture.entity.position, velocity: fixture.entity.velocity,
          onGround: fixture.entity.onGround, isInWater: fixture.entity.isInWater,
        },
      }),
      walkTick: () => tick,
    } as unknown as GameAdapter;
    const c = context(adapter, h.svc, h.perception.senses, { signal: parent.signal });
    const result = await runSkill(c.ctx, walkTo, { to: { x: 4.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 } });

    assert.equal(result.status, 'cancelled', result.summary);
    const snap = searchOf(result);
    assert.equal(snap.state, 'FOUND');
    assert.ok(snap.candidate !== null);
    const nav = navOf(result);
    assert.equal(nav.outcome, 'CANCELLED');
    assert.ok(nav.lastPosition, '取消后应保留已测末位');
    const position = result.data?.position as Vec3Like;
    assert.deepEqual(position, nav.lastPosition);
    assert.ok(position.x > START.x + 0.01, `应保留实际部分位移，实际 x=${position.x}`);
    assert.ok(position.x < 4.54 - 0.12, '部分位移不得伪报到达');
    assert.equal(fixture.control.forward, false, '取消后应释放前进键');
    assert.equal(fixture.control.back, false);
    assert.equal(fixture.control.sneak, false);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 准备转头返回后复核：等待期间父取消不再观测或转头', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = blockedLookHarness();
    const parent = new AbortController();
    const c = context(fixture.adapter, h.svc, fixture.senses, { signal: parent.signal, deadline: Date.now() + 10_000 });
    const running = runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
    await fixture.lookStarted;
    const observesBefore = fixture.observes();
    assert.ok(observesBefore > 0, '准备阶段应已发出初始合法观测');
    parent.abort();
    fixture.resolveLook();
    const result = await running;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    assert.equal(fixture.looks(), 1, '父取消后不得再转头');
    assert.equal(fixture.observes(), observesBefore, '父取消后不得再发观测请求');
    assert.equal(fixture.writes(), 0, '未开始移动不得写控制');
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0, '返回后不应残留监听');
    assert.equal(c.stationary(), false);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 准备转头返回后复核：等待期间换 scope 不再观测或转头', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = blockedLookHarness();
    const c = context(fixture.adapter, h.svc, fixture.senses, { deadline: Date.now() + 10_000 });
    const running = runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
    await fixture.lookStarted;
    const observesBefore = fixture.observes();
    fixture.setDim('nether');
    fixture.resolveLook();
    const result = await running;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    assert.equal(result.data?.cancelBy, 'scope_changed');
    assert.equal(fixture.looks(), 1, '换 scope 后不得再转头');
    assert.equal(fixture.observes(), observesBefore, '换 scope 后不得再发观测请求');
    assert.equal(fixture.writes(), 0);
    assert.equal(c.stationary(), false);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 准备入口门禁：共享会话已暂停或未准入时零观测、零转头', { timeout: 10000 }, async () => {
  for (const mode of ['paused', 'interrupted'] as const) {
    const h = await openHarness();
    try {
      const fixture = blockedLookHarness();
      const c = context(fixture.adapter, h.svc, fixture.senses, { deadline: Date.now() + 10_000 });
      if (mode === 'paused') h.svc.setPaused(true);
      else h.svc.interrupt();
      assert.equal(h.svc.paused || !h.svc.observationAdmitted, true, `${mode}: 入口应已不可接纳`);

      const result = await runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

      assert.equal(result.status, 'cancelled', mode);
      assert.equal(result.data?.stage, 'CANCELLED', mode);
      assert.equal(result.data?.cancelBy, 'lifecycle', mode);
      assert.equal(fixture.observes(), 0, `${mode}: 不得发初始观测或后续批次`);
      assert.equal(fixture.looks(), 0, `${mode}: 不得发第一次转头`);
      assert.equal(fixture.writes(), 0, `${mode}: 不得写控制`);
      assert.equal(c.stationary(), false, `${mode}: stationary wait 应恢复`);
    } finally {
      await closeHarness(h);
    }
  }
});

test('walk_to 零边候选：共享会话 interrupt 在真实 pending 帧等待中有界取消，零控制零残留监听', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    const frames = eventEmitterTick();
    const fixture = scriptedHarness({ tick: frames.tick });
    const parent = new AbortController();
    const c = context(fixture.adapter, h.svc, h.perception.senses, { signal: parent.signal, deadline: Date.now() + 10_000 });
    const startedAt = Date.now();
    const running = runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    // 已进入真实 pending：帧源注册了 physicsTick/end，等待尚未返回。
    await frames.entered;
    assert.equal(frames.ownedListeners(), 2, 'pending 期间应保留 physicsTick/end 监听');
    h.svc.interrupt();
    const result = await running;
    const elapsed = Date.now() - startedAt;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    assert.equal(result.data?.noop, undefined);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.equal(nav.confirmed, false);
    assert.deepEqual(nav.trace, []);
    assert.ok(nav.problem.kind === 'cancelled');
    assert.equal(nav.problem.by, 'lifecycle');
    assert.equal(nav.lastPosition, undefined, '无帧中断不得伪造末位');
    assert.ok(elapsed < 2000, `interrupt 应在期限前有界唤醒，实际 ${elapsed}ms`);
    assert.equal(fixture.tickCalls(), 1, '无帧等待不应空转重试');
    assert.equal(frames.ownedListeners(), 0, 'abort 返回后帧源自有监听应全部解除');
    assert.equal(parent.signal.aborted, false, '生命周期取消不得中止父任务 signal');
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0, '返回后不应残留父 abort 监听');
    assert.equal(fixture.writes(), 0, '零边确认不得写任何控制');
    assert.equal(h.svc.observationAdmitted, false, 'interrupt 后观测准入应撤销');
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边候选：期限耗尽统一 nav TIMEOUT，不伪造末位且解除帧源监听', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    const frames = eventEmitterTick();
    const fixture = scriptedHarness({ tick: frames.tick });
    const c = context(fixture.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 200 });
    const running = runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    await frames.entered;
    assert.equal(frames.ownedListeners(), 2);
    const result = await running;

    assert.equal(result.status, 'failed');
    assert.equal(result.data?.stage, 'TIMEOUT');
    assert.equal(result.data?.noop, undefined);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'TIMEOUT');
    assert.equal(nav.confirmed, false);
    assert.deepEqual(nav.trace, []);
    assert.ok(nav.problem.kind === 'timeout');
    assert.equal(nav.lastPosition, undefined, '无帧超时不得伪造末位');
    assert.equal(fixture.tickCalls(), 1, '期限等待不应空转重试');
    assert.equal(frames.ownedListeners(), 0, '期限结束也应解除帧源自有监听');
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边确认：最后本可确认帧遇作用域变化不确认且不覆盖旧 lastObservation', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    let dim = DIM;
    let frame = 0;
    const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
      if (signal.aborted) { resolve(null); return; }
      const onAbort = () => { clearTimeout(timer); resolve(null); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        frame++;
        const value: EntityFrame = {
          position: { x: START.x + frame * 0.001, y: START.y, z: START.z },
          velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
        };
        // 第 4 帧本已满足 stableMs；但帧返回时作用域已变，不能确认，也不能覆盖旧末位。
        if (frame === 4) dim = 'nether';
        resolve(value);
      }, 60);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const fixture = scriptedHarness({ tick, state: () => ({ dim }) });
    const c = context(fixture.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 10_000 });
    const result = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.equal(nav.confirmed, false);
    assert.deepEqual(nav.trace, []);
    assert.ok(nav.problem.kind === 'cancelled');
    assert.equal(nav.problem.by, 'lifecycle');
    assert.ok(nav.lastPosition, '此前已接受的真实帧应保留');
    assert.ok(Math.abs(nav.lastPosition.x - (START.x + 3 * 0.001)) < 1e-9, `旧末位不得被换 scope 的帧覆盖，实际 ${nav.lastPosition.x}`);
    assert.ok(nav.lastObservation);
    assert.equal(nav.lastObservation.dim, DIM, 'lastObservation 应来自旧作用域的真实接受帧');
    assert.equal(nav.lastObservation.worldId, WORLD);
    assert.equal(nav.lastObservation.sessionId, SESSION);
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边确认：最后本可确认帧遇暂停不确认且不覆盖旧 lastObservation', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    let frame = 0;
    const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
      if (signal.aborted) { resolve(null); return; }
      const onAbort = () => { clearTimeout(timer); resolve(null); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        frame++;
        const value: EntityFrame = {
          position: { x: START.x + frame * 0.001, y: START.y, z: START.z },
          velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
        };
        if (frame === 4) {
          // 先交付本帧再同步暂停：等待返回后必须复核到生命周期取消，不能接受这一帧。
          resolve(value);
          h.svc.setPaused(true);
          return;
        }
        resolve(value);
      }, 60);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const fixture = scriptedHarness({ tick });
    const c = context(fixture.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 10_000 });
    const result = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });

    assert.equal(h.svc.paused, true);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.equal(nav.confirmed, false);
    assert.deepEqual(nav.trace, []);
    assert.ok(nav.problem.kind === 'cancelled');
    assert.equal(nav.problem.by, 'lifecycle');
    assert.ok(nav.lastPosition, '暂停前已接受的真实帧应保留');
    assert.ok(Math.abs(nav.lastPosition.x - (START.x + 3 * 0.001)) < 1e-9, `旧末位不得被暂停时的帧覆盖，实际 ${nav.lastPosition.x}`);
    assert.ok(nav.lastObservation);
    assert.equal(nav.lastObservation.dim, DIM);
    assert.equal(nav.lastObservation.worldId, WORLD);
    assert.equal(nav.lastObservation.sessionId, SESSION);
    assert.equal(fixture.writes(), 0);
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 准备等待返回时同 session ready 丢失：一次 interrupt、旧证据 STALE、verifier 非 OPEN', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    seedCorridor(h);
    const verifier = openCorridorVerifier(h);
    const beforeA = cellEvidence(h, 0, -1, 0).observation.observedAt;
    const beforeB = cellEvidence(h, 1, -1, 0).observation.observedAt;
    const interrupts = countInterrupts(h.svc, verifier);

    let ready = true;
    const fixture = blockedLookHarness({ observationReady: () => ready });
    const parent = new AbortController();
    const c = context(fixture.adapter, h.svc, fixture.senses, { signal: parent.signal, deadline: Date.now() + 10_000 });
    const running = runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });
    await fixture.lookStarted;
    assert.equal(interrupts(), 0, '准备期间尚未中断');
    ready = false;
    fixture.resolveLook();
    const result = await running;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    assert.equal(result.data?.cancelBy, 'lifecycle');
    assert.equal(interrupts(), 1, '同一 ready gap 只 interrupt 一次');
    assert.equal(h.svc.observationAdmitted, false, 'interrupt 后不得再准入观测');
    assert.equal(cellEvidence(h, 0, -1, 0).freshness, 'STALE');
    assert.equal(cellEvidence(h, 1, -1, 0).freshness, 'STALE');
    assert.equal(cellEvidence(h, 0, -1, 0).observation.observedAt, beforeA, '旧证据时间不改');
    assert.notEqual(verifier.status()!.verdict, 'OPEN', '真实 lifecycle 报告必须让原 verifier 失效');
    assert.equal(fixture.writes(), 0, '未开始移动不得写控制');

    // ready 恢复走真实 beginSession 入口；只重新观察一格，另一格保持 STALE、原时间不改。
    h.svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const recoveryReport = h.svc.observe([{
      name: 'minecraft:stone', properties: {}, stateComplete: true, pos: { x: 1, y: -1, z: 0 },
      worldId: WORLD, sessionId: SESSION, dimension: DIM,
      observationId: 9001, observedAt: Date.now() + 1000, source: 'vision',
    }]);
    verifier.apply(recoveryReport, 10);
    assert.equal(cellEvidence(h, 1, -1, 0).freshness, 'FRESH', '只有真实重新观察的一格恢复');
    assert.equal(cellEvidence(h, 0, -1, 0).freshness, 'STALE', '未重新观察的格不得自行刷新');
    assert.equal(cellEvidence(h, 0, -1, 0).observation.observedAt, beforeA, '未刷新格保留原证据时间');
    assert.ok(cellEvidence(h, 1, -1, 0).observation.observedAt > beforeB);
    assert.notEqual(verifier.status()!.verdict, 'OPEN', '单格恢复不足以让整条路线重新 OPEN');
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 零边帧等待返回时同 session ready 丢失：一次 interrupt、保留旧 lastObservation、verifier 非 OPEN', { timeout: 10000 }, async () => {
  const h = await openHarness();
  try {
    seedCorridor(h);
    const verifier = openCorridorVerifier(h);
    const beforeA = cellEvidence(h, 0, -1, 0).observation.observedAt;
    const beforeB = cellEvidence(h, 1, -1, 0).observation.observedAt;
    const interrupts = countInterrupts(h.svc, verifier);

    let ready = true;
    let frame = 0;
    const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
      if (signal.aborted) { resolve(null); return; }
      const onAbort = () => { clearTimeout(timer); resolve(null); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        frame++;
        if (frame === 4) ready = false; // 帧返回前同一 session 的 ready 已丢失
        resolve({
          position: { x: START.x + frame * 0.001, y: START.y, z: START.z },
          velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
        });
      }, 60);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const fixture = scriptedHarness({ tick, state: () => ({ observationReady: ready }) });
    const c = context(fixture.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 10_000 });
    const result = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });

    assert.equal(result.status, 'cancelled');
    assert.equal(result.data?.stage, 'CANCELLED');
    assert.equal(interrupts(), 1, '同一 ready gap 只 interrupt 一次');
    assert.equal(h.svc.observationAdmitted, false);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.ok(nav.problem.kind === 'cancelled');
    assert.equal(nav.problem.by, 'lifecycle');
    assert.ok(nav.lastPosition, '此前接受的真实帧应保留');
    assert.ok(Math.abs(nav.lastPosition.x - (START.x + 3 * 0.001)) < 1e-9, `ready 丢失帧不得覆盖旧末位，实际 ${nav.lastPosition.x}`);
    assert.ok(nav.lastObservation);
    assert.equal(nav.lastObservation.dim, DIM, '旧 lastObservation 作用域保持');
    assert.equal(nav.lastObservation.worldId, WORLD);
    assert.equal(nav.lastObservation.sessionId, SESSION);
    assert.deepEqual(nav.trace, []);
    assert.equal(cellEvidence(h, 0, -1, 0).freshness, 'STALE');
    assert.equal(cellEvidence(h, 1, -1, 0).freshness, 'STALE');
    assert.equal(cellEvidence(h, 0, -1, 0).observation.observedAt, beforeA, '旧证据时间不改');
    assert.notEqual(verifier.status()!.verdict, 'OPEN');
    assert.equal(fixture.writes(), 0);

    h.svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const recoveryReport = h.svc.observe([{
      name: 'minecraft:stone', properties: {}, stateComplete: true, pos: { x: 1, y: -1, z: 0 },
      worldId: WORLD, sessionId: SESSION, dimension: DIM,
      observationId: 9002, observedAt: Date.now() + 1000, source: 'vision',
    }]);
    verifier.apply(recoveryReport, 10);
    assert.equal(cellEvidence(h, 1, -1, 0).freshness, 'FRESH');
    assert.equal(cellEvidence(h, 0, -1, 0).freshness, 'STALE');
    assert.equal(cellEvidence(h, 0, -1, 0).observation.observedAt, beforeA);
    assert.ok(cellEvidence(h, 1, -1, 0).observation.observedAt > beforeB);
    assert.notEqual(verifier.status()!.verdict, 'OPEN');
  } finally {
    await closeHarness(h);
  }
});
