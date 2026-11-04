/**
 * manual 体素驻留的生产接线验收（M2a2）。
 *
 * 使用真实 curio-minecraft-3d-memory、真实 SharedSpatialSession 与临时 SQLite，
 * 穿过真实注册技能 run 链：walk_to / walk_known_route / walk_route / spatial_query。
 * 离线夹具只提供物理帧与观测源；不连接 Bot/server。
 *
 * 不伪造 manual session：spy 只包住真实 prepare/release 记录调用与 lease 结算。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { CloseResult, SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { Observation, SectionKey } from 'curio-minecraft-3d-memory';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { acquireRouteResidency, releaseRouteResidency } from '../src/spatial/skill-residency.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import { walkKnownRoute, walkTo } from '../src/skills/spatial-navigation.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import { runSkill, type Senses, type SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'manual-wiring-world';
const DIM = 'overworld';
const SESSION = 's1';
const START = { x: 0.54, y: 0, z: 0.52 };
const POINTS = [
  { x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 },
];

const rec = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, unknown>;
};

function keyAt(cx: number, sy = 0): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

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

type EntityFrame = { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; onGround: boolean; isInWater: boolean };

/** 真实 prismarine 物理身体（50ms 帧）。 */
function physicsHarness() {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(START.x, START.y, START.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false,
    isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  const bot = {
    version: '1.20.1', entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const key of Object.keys(control)) control[key] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      const frame: EntityFrame = {
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
        onGround: entity.onGround, isInWater: entity.isInWater,
      };
      cleanup(); resolve(frame);
    }, 50);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const adapter = {
    state: () => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
      pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, inventory: [],
    }),
    walkBody: () => ({
      setControlState: (name: string, value: boolean) => bot.setControlState(name, value),
      clearControlStates: () => bot.clearControlStates(),
      look: (yaw: number, pitch: number) => bot.look(yaw, pitch),
      entity: { position: entity.position, velocity: entity.velocity, onGround: entity.onGround, isInWater: entity.isInWater },
    }),
    walkTick: () => tick,
  } as unknown as GameAdapter;
  return {
    adapter,
    place(next: { x: number; y: number; z: number }) {
      bot.clearControlStates();
      entity.position.set(next.x, next.y, next.z);
      entity.velocity.set(0, 0, 0);
      entity.onGround = true;
      entity.isInWater = false;
    },
  };
}

/** FakeAdapter 上的静止身体：只用于零边确认与取消/期限测试。 */
function staticAdapter() {
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD; adapter.dim = DIM; adapter.sessionId = SESSION; adapter.pos = { ...START };
  const position = { ...START };
  (adapter as unknown as { walkBody: () => unknown }).walkBody = () => ({
    setControlState() {}, clearControlStates() {}, look() {},
    entity: { position, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  });
  (adapter as unknown as { walkTick: () => (signal: AbortSignal) => Promise<EntityFrame | null> }).walkTick = () => async (signal) => {
    if (signal.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (signal.aborted) return null;
    return { position: { ...position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  };
  return adapter;
}

function makeSenses(svc: SharedSpatialSession): Pick<Senses, 'observeBlocks'> {
  let sequence = 1;
  return {
    observeBlocks(positions) {
      const observations = positions.map((p): BlockObservation => ({
        name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p },
        worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: sequence++, observedAt: Date.now(), source: 'vision',
      }));
      if (observations.length > 0) svc.observe(observations);
      return observations;
    },
  };
}

function context(
  adapter: GameAdapter,
  svc: SharedSpatialSession,
  senses: Pick<SkillCtx['senses'], 'observeBlocks'>,
  opts: { deadline?: number; signal?: AbortSignal; taskId?: string } = {},
): SkillCtx {
  return {
    adapter, senses: senses as SkillCtx['senses'], spatial: svc, memory: new WorldMemory(null), bus: new EventBus(),
    signal: opts.signal ?? new AbortController().signal,
    deadline: opts.deadline ?? Date.now() + 30_000,
    taskId: opts.taskId ?? 'manual-wiring-task',
    progress() {}, setStationaryWait() {},
  } as unknown as SkillCtx;
}

/** 已提交体素种子：真实 eager 会话写入并 checkpoint。 */
async function seedCommitted(dbPath: string): Promise<void> {
  const session = await openSpatialSession({ worldId: WORLD, databasePath: dbPath });
  let close: CloseResult | null = null;
  const now = Date.now() - 1000;
  let sequence = 1;
  const observations: Observation[] = [];
  const rows = [...Array.from({ length: 24 }, (_, i) => i - 3), 40];
  for (const x of rows) {
    for (let z = -2; z <= 2; z += 1) {
      for (let y = -1; y <= 2; y += 1) {
        observations.push({
          worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: sequence++,
          source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {} },
          pos: { x, y, z },
        });
      }
    }
  }
  try {
    session.voxel.beginSession(SESSION);
    session.voxel.observeBatch({ observations, unobserved: [] });
    await session.checkpoint();
  } finally {
    close = await session.close();
  }
  assert.equal(close?.completed, true);
  assert.equal(close?.error, null);
  assert.equal(close?.unconfirmedRequest, false);
}

interface ManualHarness { svc: SharedSpatialSession; dir: string; dbPath: string }

async function openManual(options: { seed?: boolean; residencyLimits?: { maxResidentSections?: number } } = {}): Promise<ManualHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'manual-wiring-'));
  const dbPath = join(dir, 'memory.db');
  if (options.seed !== false) await seedCommitted(dbPath);
  const svc = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: dbPath,
    voxelLoading: 'manual',
    timeoutMs: 5000,
    ...(options.residencyLimits !== undefined ? { residencyLimits: options.residencyLimits } : {}),
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  return { svc, dir, dbPath };
}

async function closeManual(h: ManualHarness): Promise<void> {
  const shutdown: ShutdownResult = await h.svc.shutdown();
  assert.equal(shutdown.close?.completed, true, '真实 close 必须完成');
  assert.equal(shutdown.close?.error, null);
  assert.equal(shutdown.close?.unconfirmedRequest, false);
  rmSync(h.dir, { recursive: true, force: true });
}

/** 记录真实 prepare 结果与 release token；不替换会话。 */
function spyResidency(svc: SharedSpatialSession) {
  const prepares: { sections: number; status: string; token: string | null }[] = [];
  const released: string[] = [];
  const realPrepare = svc.prepare.bind(svc);
  svc.prepare = async (keys, opts) => {
    const outcome = await realPrepare(keys, opts);
    prepares.push({
      sections: keys.length,
      status: outcome.status,
      token: outcome.status === 'ready' ? outcome.lease.token : null,
    });
    return outcome;
  };
  const realRelease = svc.release.bind(svc);
  svc.release = (token) => { released.push(token); realRelease(token); };
  return {
    prepares,
    released,
    leases: () => prepares.flatMap((entry) => entry.token === null ? [] : [entry.token]),
  };
}

function assertBalanced(spy: ReturnType<typeof spyResidency>, svc: SharedSpatialSession): void {
  const leases = spy.leases();
  assert.ok(leases.length > 0, 'manual 执行应至少取得一个真实 lease');
  assert.deepEqual([...spy.released].sort(), [...leases].sort(), '每个 lease 必须精确释放一次');
  assert.equal(svc.workingSetStats().pinnedLeases, 0);
  assert.equal(svc.workingSetStats().pinnedSections, 0);
}

test('eager default keeps the original behavior: no working-set prepare', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-wiring-eager-'));
  let svc: SharedSpatialSession | null = null;
  let shutdown: ShutdownResult | null = null;
  try {
    svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db'), timeoutMs: 5000 });
    assert.equal(svc.session.voxelLoading, 'eager');
    let prepares = 0;
    const realPrepare = svc.prepare.bind(svc);
    svc.prepare = async (keys, opts) => { prepares++; return realPrepare(keys, opts); };

    const residency = await acquireRouteResidency(svc, [keyAt(0)]);
    assert.equal(residency.status, 'ready');
    assert.equal(residency.lease, null);
    assert.equal(prepares, 0, 'eager 模式不触达 manual prepare');
    releaseRouteResidency(svc, residency);
  } finally {
    shutdown = svc === null ? null : await svc.shutdown();
  }
  assert.equal(shutdown?.close?.completed, true);
  rmSync(dir, { recursive: true, force: true });
});

test('a first observation in a new manual world still works (zero-edge walk_to)', { timeout: 30_000 }, async () => {
  const h = await openManual({ seed: false });
  try {
    const adapter = staticAdapter();
    const spy = spyResidency(h.svc);
    const ctx = context(adapter, h.svc, makeSenses(h.svc), { deadline: Date.now() + 8000 });
    const result = await runSkill(ctx, walkTo, {
      to: { ...START }, arrival: { kind: 'near', radius: 0.5 },
    });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal(rec(result.data).zeroEdge, true);
    assert.equal(rec(result.data).noop, true);
    assert.equal(spy.released.length, spy.leases().length);
    assert.equal(h.svc.workingSetStats().pinnedLeases, 0);
  } finally {
    await closeManual(h);
  }
});

test('manual walk_to prepares real dependencies, leases, and releases on success; walk_known_route replays', { timeout: 60_000 }, async () => {
  const h = await openManual();
  try {
    const fixture = physicsHarness();
    const senses = makeSenses(h.svc);
    const spy = spyResidency(h.svc);
    const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'manual-producer', deadline: Date.now() + 25_000 });

    const produced = await runSkill(ctx, walkTo, {
      to: { x: 2.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 },
    });
    assert.equal(produced.status, 'succeeded', produced.summary);
    assert.ok(spy.prepares.some((entry) => entry.status === 'ready'), 'manual 执行前必须真实 prepare');
    assertBalanced(spy, h.svc);

    const history = rec(produced.data?.history);
    assert.equal(history.status, 'accepted_pending_checkpoint');
    const fragmentId = String(history.fragmentId);

    fixture.place(START);
    const replaySpy = { before: spy.released.length };
    const knownCtx = context(fixture.adapter, h.svc, senses, { taskId: 'manual-replay', deadline: Date.now() + 25_000 });
    const known = await runSkill(knownCtx, walkKnownRoute, { fragmentId });
    assert.equal(known.status, 'succeeded', known.summary);
    assertBalanced(spy, h.svc);
    assert.ok(spy.released.length > replaySpy.before, 'replay 也必须取得并释放自己的 lease');
  } finally {
    await closeManual(h);
  }
});

test('walk_route prepares, leases, and releases on success in manual mode', { timeout: 60_000 }, async () => {
  const h = await openManual();
  try {
    const fixture = physicsHarness();
    const spy = spyResidency(h.svc);
    const ctx = context(fixture.adapter, h.svc, makeSenses(h.svc), { taskId: 'manual-walk-route', deadline: Date.now() + 25_000 });
    const result = await runSkill(ctx, walkRoute, { points: POINTS });
    assert.equal(result.status, 'succeeded', result.summary);
    assertBalanced(spy, h.svc);
  } finally {
    await closeManual(h);
  }
});

test('manual lease is released exactly once after cancellation and after a scope change', { timeout: 40_000 }, async () => {
  // 取消：真实 prepare 返回 ready 后立刻中止父任务。
  const cancelled = await openManual();
  try {
    const adapter = staticAdapter();
    const controller = new AbortController();
    const spy = spyResidency(cancelled.svc);
    const realPrepare = cancelled.svc.prepare.bind(cancelled.svc);
    cancelled.svc.prepare = async (keys, opts) => {
      const outcome = await realPrepare(keys, opts);
      controller.abort();
      return outcome;
    };
    const ctx = context(adapter, cancelled.svc, makeSenses(cancelled.svc), {
      deadline: Date.now() + 8000, signal: controller.signal,
    });
    const result = await runSkill(ctx, walkTo, { to: { ...START }, arrival: { kind: 'near', radius: 0.5 } });
    assert.equal(result.status, 'cancelled', result.summary);
    assert.equal(spy.released.length, spy.leases().length);
    assert.equal(cancelled.svc.workingSetStats().pinnedLeases, 0);
  } finally {
    await closeManual(cancelled);
  }

  // 作用域变化：prepare 后适配器与共享会话都切到新 session。
  const scoped = await openManual();
  try {
    const adapter = staticAdapter();
    const spy = spyResidency(scoped.svc);
    const realPrepare = scoped.svc.prepare.bind(scoped.svc);
    scoped.svc.prepare = async (keys, opts) => {
      const outcome = await realPrepare(keys, opts);
      adapter.sessionId = 's2';
      scoped.svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: 's2' });
      return outcome;
    };
    const ctx = context(adapter, scoped.svc, makeSenses(scoped.svc), { deadline: Date.now() + 8000 });
    const result = await runSkill(ctx, walkTo, { to: { ...START }, arrival: { kind: 'near', radius: 0.5 } });
    assert.equal(result.status, 'cancelled', result.summary);
    assert.equal(rec(result.data).cancelBy, 'scope_changed');
    assert.equal(spy.released.length, spy.leases().length);
    assert.equal(scoped.svc.workingSetStats().pinnedLeases, 0);
  } finally {
    await closeManual(scoped);
  }
});

test('prepare cancelled by deadline grants no lease and is reported as a fact', { timeout: 30_000 }, async () => {
  const h = await openManual();
  try {
    const adapter = staticAdapter();
    const spy = spyResidency(h.svc);
    const realPrepare = h.svc.prepare.bind(h.svc);
    h.svc.prepare = async (keys, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return realPrepare(keys, opts);
    };
    const ctx = context(adapter, h.svc, makeSenses(h.svc), { deadline: Date.now() + 40 });
    const result = await runSkill(ctx, walkTo, { to: { ...START }, arrival: { kind: 'near', radius: 0.5 } });
    assert.equal(result.status, 'failed', result.summary);
    assert.equal(result.failureCode, 'TIMEOUT');
    assert.equal(spy.leases().length, 0, '期限取消不授予 lease');
    assert.equal(h.svc.workingSetStats().pinnedLeases, 0);
    const facts = rec(rec(result.data).residency);
    assert.equal(facts.status, 'not_ready');
    assert.equal(facts.reason, 'cancelled');
  } finally {
    await closeManual(h);
  }
});

test('capacity rejection is reported without a lease and leaves residency unchanged', { timeout: 30_000 }, async () => {
  const h = await openManual({ residencyLimits: { maxResidentSections: 1 } });
  try {
    const keys = [keyAt(0), keyAt(1)];
    const before = keys.map((key) => h.svc.session.sectionResidency(key).residency);
    assert.deepEqual(before, ['not_resident', 'not_resident']);

    const refused = await acquireRouteResidency(h.svc, keys, { deadline: Date.now() + 5000 });
    assert.equal(refused.status, 'not_ready');
    if (refused.status === 'not_ready') {
      assert.equal(refused.reason, 'failed');
      assert.match(refused.message, /maxResidentSections/);
    }
    assert.equal(h.svc.workingSetStats().pinnedLeases, 0);
    assert.deepEqual(keys.map((key) => h.svc.session.sectionResidency(key).residency), before);

    // 单 Section 仍可真实取得并释放 lease（容量拒绝没有留下残留 pin）。
    const single = await acquireRouteResidency(h.svc, [keyAt(0)], { deadline: Date.now() + 5000 });
    assert.equal(single.status, 'ready');
    if (single.status === 'ready') {
      assert.notEqual(single.lease, null);
      assert.equal(h.svc.workingSetStats().pinnedLeases, 1);
      releaseRouteResidency(h.svc, single);
    }
    assert.equal(h.svc.workingSetStats().pinnedLeases, 0);
  } finally {
    await closeManual(h);
  }
});

test('read-only spatial_query does not load, pin, observe, or save', { timeout: 30_000 }, async () => {
  const h = await openManual();
  try {
    const spy = spyResidency(h.svc);
    const key = { worldId: WORLD, dim: DIM, cx: 2, cz: 0, sy: 0 };
    // 该 Section 已提交但未驻留；只读查询只能报历史不可用，不得隐式加载。
    assert.equal(h.svc.session.sectionResidency(key).residency, 'not_resident');
    const revisionBefore = h.svc.session.voxel.saveRevision;

    const ctx = context(new FakeAdapter(), h.svc, { observeBlocks: () => [] });
    const result = await runSkill(ctx, spatialQuery, {
      kind: 'cells', dim: DIM, positions: [{ x: 40, y: 0, z: 0 }],
    });
    assert.equal(result.status, 'succeeded');
    const query = rec(rec(result.data).spatialQuery);
    const cell = rec((query.results as unknown[])[0]);
    assert.equal(cell.availability, 'unavailable_history');
    assert.equal(rec(cell.residency).residency, 'not_resident');
    assert.equal(spy.prepares.length, 0, '只读查询不得隐式 prepare');
    assert.equal(h.svc.workingSetStats().pinnedLeases, 0);
    assert.equal(h.svc.session.voxel.saveRevision, revisionBefore);
  } finally {
    await closeManual(h);
  }
});

test('manual shutdown reports unprocessed observations and still closes the real session', { timeout: 30_000 }, async () => {
  const h = await openManual();

  // 占住会话门后写入已保存但未驻留的 Section：加载只记录一次 busy，证据留在 pending。
  h.svc.session.acquireWorkingSetOperation();
  const pendingObservation: BlockObservation = {
    name: 'minecraft:dirt', properties: { axis: 'y' }, stateComplete: true,
    pos: { x: 0, y: 0, z: 0 }, worldId: WORLD, sessionId: SESSION, dimension: DIM,
    observationId: 100, observedAt: Date.now(), source: 'vision',
  };
  h.svc.observe([pendingObservation]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.svc.session.releaseWorkingSetOperation();
  assert.equal(h.svc.pendingObservations().observations, 1, '加载门被占用时应保留原始证据');

  // 不再 drain：关停必须如实报告未应用条数，同时完成真实 close。
  const shutdown = await h.svc.shutdown();
  assert.notEqual(shutdown.error, null, '未应用证据必须如实报告');
  assert.match(String(shutdown.error), /pending observation/);
  assert.equal(shutdown.close?.completed, true);
  assert.equal(shutdown.close?.error, null);
  rmSync(h.dir, { recursive: true, force: true });
});
