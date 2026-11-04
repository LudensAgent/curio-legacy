/**
 * walk_to 的定向验收：真实安装库的公开 WalkRouteSearch、真实公共 walk_route 执行后端
 * 与现有 prismarine 离线身体。地图由共享会话的公开 observe 写入（离线夹具，不连接
 * Bot/server，也不声称真实 Vision 集成通过）。
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import type { NavResult, Vec3Like, WalkSearchSnapshot } from 'curio-minecraft-3d-memory';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { walkTo } from '../src/skills/spatial-navigation.ts';
import { runSkill } from '../src/skills/types.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';

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

test('walk_to 参数边界：显式 arrival、有限坐标、near 正半径与上限，缺共享会话如实失败', async () => {
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
  assert.ok(!walkTo.validate({ to: [0, 0, 0], arrival: { kind: 'near', radius: 33 } }, {} as never).ok, 'near 半径上限');
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
    const nav = navOf(result);
    assert.equal(nav.outcome, 'ARRIVED', '候选末点确由执行器真实到达');
    assert.ok(nav.lastPosition, '执行 partial/实测位置必须保留');
    const position = result.data?.position as Vec3Like;
    const actual = distance3d(position, target);
    assert.ok(actual > 0.0451, `实测末位应越原半径，实际 ${actual}`);
    assert.deepEqual(position, nav.lastPosition);
    assert.deepEqual((result.data?.problem as { kind?: string }).kind, 'unconfirmed_arrival');
    assert.deepEqual(result.data?.originalRequest, { to: target, arrival: { kind: 'near', radius: 0.0451 } });
    for (const key of Object.keys(fixture.fixture.control)) {
      assert.equal(fixture.fixture.control[key], false, `结束后 ${key} 键应释放`);
    }
  } finally {
    await closeHarness(h);
  }
});

test('walk_to 未知证据不当作可走：INSUFFICIENT_EVIDENCE、零帧零控制', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null), look: true });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const result = await runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

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
    // 局部准备之外全是过期证据（超出 60s 有效窗口）。
    h.perception.seed({ xFrom: -2, xTo: 6, observedAt: Date.now() - 120_000 });
    const fixture = scriptedHarness({ tick: () => Promise.resolve(null) });
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const result = await runSkill(c.ctx, walkTo, { to: { x: 3.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.4 } });

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

test('walk_to 零边候选：真实连续稳定帧确认原完成条件，零控制、无伪段', { timeout: 30000 }, async () => {
  const h = await openHarness();
  try {
    const fixture = physicsHarness();
    const c = context(fixture.adapter, h.svc, h.perception.senses);
    const exact = await runSkill(c.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(exact.status, 'succeeded', exact.summary);
    assert.equal(exact.data?.stage, 'ARRIVED');
    assert.equal(exact.data?.zeroEdge, true);
    assert.equal(exact.data?.confirmed, true);
    assert.equal(searchOf(exact).candidate?.edgeCount, 0);
    const exactPos = exact.data?.position as Vec3Like;
    assert.ok(Math.abs(exactPos.x - START.x) < 1e-9 && Math.abs(exactPos.z - START.z) < 1e-9);
    assert.ok((exact.data?.stableSamples as number) >= 2);
    assert.equal(fixture.fixture.writes(), 0, '零边确认不得写任何控制');
    assert.equal(exact.data?.nav, undefined, '零边候选不应伪造执行段');

    const near = await runSkill(c.ctx, walkTo, { to: { x: START.x, y: 0.08, z: START.z }, arrival: { kind: 'near', radius: 0.1 } });
    assert.equal(near.status, 'succeeded', near.summary);
    assert.equal(near.data?.zeroEdge, true);
    assert.equal(near.data?.nav, undefined);
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
    assert.equal(unstable.writes(), 0, '零边不稳定也不得写控制');

    let tickCalls = 0;
    const noFrame = scriptedHarness({
      tick: () => { tickCalls++; return Promise.resolve(null); },
    });
    const c2 = context(noFrame.adapter, h.svc, h.perception.senses, { deadline: Date.now() + 5000 });
    const noFrameResult = await runSkill(c2.ctx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(noFrameResult.status, 'failed');
    assert.equal(noFrameResult.data?.stage, 'execution_failed');
    assert.equal(tickCalls, 1, '帧源结束应只请求一次，不空转重试');
    assert.equal(noFrame.writes(), 0);

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
      assert.equal(hanging.writes(), 0);
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
