import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import {
  FragmentStore,
  GROUNDED_ARRIVAL_DEFAULTS,
  VoxelMap,
  startKnownWalkRoute,
  type KnownWalkRouteStart,
  type PathFragment,
  type WalkRouteExecutor,
  type WalkRouteRequest,
} from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../src/adapter/walk-route.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/** 平坦石地面（y=-1），身体脚高 y=0。离线夹具，不连接真实 Bot/server。 */
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

/** 带真实物理的离线身体；controlWrites 统计所有控制写入，用于证明零控制。 */
function body(start: { x: number; z: number }) {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(start.x, 0, start.z), velocity: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  let controlWrites = 0;
  let controlClears = 0;
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { controlWrites++; control[name] = value; },
    clearControlStates() { controlClears++; for (const k of Object.keys(control)) control[k] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  let clock = 2000;
  const tick = () => {
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    clock += 50;
    return Promise.resolve(bot.entity);
  };
  return { bot, tick, now: () => clock, controlWrites: () => controlWrites, controlClears: () => controlClears };
}

function buildMap() {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = -1; y <= 2; y++) {
    map.observe({
      worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: y === -1 ? { name: 'minecraft:stone', properties: {} } : { name: 'minecraft:air', properties: {} },
      pos: { x, y, z },
    });
  }
  return map;
}

function request(points: WalkRouteRequest['points']): WalkRouteRequest {
  return {
    worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
    body: { feet: points[0]!, width: 0.6, height: 1.8, pose: 'standing' },
    points,
    arrival: { kind: 'exact' },
    bodyArrival: GROUNDED_ARRIVAL_DEFAULTS,
    shapeProvider: walkCollisionProvider,
    deadlineMs: 30_000,
    timeoutMs: 4000,
  };
}

function fragment(id: string, polyline: PathFragment['polyline']): PathFragment {
  return {
    id, worldId: 'world', dim: 'overworld', kind: 'walked', entrances: [], polyline,
    geometrySource: 'traversal', deepestY: 0, createdAt: 1000, lastUsedAt: 1000, uses: 1,
  };
}

/** 从 runWalkRoute 请求中去掉 points，再交给公开 helper；起点由历史 fragment 决定。 */
function knownStart(history: FragmentStore, loop: WalkRouteExecutor, walkRequest: WalkRouteRequest, fragmentId: string) {
  const { points: _ignored, ...rest } = walkRequest;
  return startKnownWalkRoute(history, loop, { ...rest, fragmentId });
}

test('STARTED 后继续驱动同一 WalkRouteExecutor 观察/采样/推进到终态，保留 scope 与期限', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const map = buildMap();
  const history = new FragmentStore('world');
  history.saveFragment(fragment('home', points));
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  const captured: {
    loop: WalkRouteExecutor | null;
    request: WalkRouteRequest | null;
    start: KnownWalkRouteStart | null;
  } = { loop: null, request: null, start: null };
  let observes = 0;

  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now,
    observe: () => { observes++; return null; },
    starter: (loop, startRequest) => {
      const start = knownStart(history, loop, startRequest, 'home');
      captured.loop = loop;
      captured.request = startRequest;
      captured.start = start;
      return start;
    },
  });

  assert.equal(result.outcome, 'ARRIVED', result.message);
  const start = captured.start;
  const loop = captured.loop;
  const startRequest = captured.request;
  assert.ok(start && loop && startRequest, 'starter 应收到并启动本次运行的 loop');
  assert.equal(start.kind, 'STARTED');
  if (start.kind !== 'STARTED') return;
  assert.equal(start.route.fragmentId, 'home');
  assert.deepEqual(start.route.points, points, '历史折线原序成为路线');
  // 同一个实例被继续驱动到终态：STARTED 本身只是委托开始，不是到达。
  const status = loop.status();
  assert.ok(status, 'STARTED 后应有活动委托');
  assert.equal(status.delegationId, start.status.delegationId);
  assert.equal(status.result?.outcome, 'ARRIVED', '同一 loop 应实际到达终态');
  assert.equal(status.nextPointIndex, points.length);
  assert.ok(observes > 0, 'observe-before-sample 路径仍应被调用');
  // 请求的作用域与有效期限原样交给 starter。
  assert.equal(startRequest.worldId, 'world');
  assert.equal(startRequest.dim, 'overworld');
  assert.equal(startRequest.sessionId, 's1');
  assert.equal(startRequest.deadlineMs, 30_000);
  // 实际取样推进产生了位移，而不是只断言 STARTED。
  assert.ok(bot.entity.position.x > 0.54 + 0.01, `应实际向前移动，实际 x=${bot.entity.position.x}`);
  for (const key of Object.keys(bot.control)) assert.equal(bot.control[key], false, `到达后 ${key} 键应释放`);
});

test('STARTED 后父期限仍有效：按父期限有界结束并保留已测部分位置', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const map = buildMap();
  const history = new FragmentStore('world');
  history.saveFragment(fragment('short', points));
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  const captured: { request: WalkRouteRequest | null; start: KnownWalkRouteStart | null } = { request: null, start: null };

  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now,
    deadlineMs: 2500,
    starter: (loop, startRequest) => {
      const start = knownStart(history, loop, startRequest, 'short');
      captured.request = startRequest;
      captured.start = start;
      return start;
    },
  });

  assert.equal(result.outcome, 'TIMEOUT', result.message);
  assert.ok(captured.start && captured.request);
  assert.equal(captured.start.kind, 'STARTED');
  assert.equal(captured.request.deadlineMs, 2500, '父期限应覆盖请求期限后交给 starter');
  assert.ok(result.lastPosition, '超时仍应保留已测位置');
  assert.ok(result.lastPosition.x > 0.54, `应保留实际发生的位移，实际 x=${result.lastPosition.x}`);
  assert.ok(result.lastPosition.x < 1.5 - 0.12, '部分位置不应伪报到达');
  for (const key of Object.keys(bot.control)) assert.equal(bot.control[key], false, `超时后 ${key} 键应释放`);
});

test('STARTED 后相关观测报告可真实撤销，保留已测位置并只解绑一次', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const map = buildMap();
  const history = new FragmentStore('world');
  history.saveFragment(fragment('revoked', points));
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  let removed = false;
  const observe = () => {
    if (!removed && now() >= 2500) {
      removed = true;
      return map.observe({
        worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: now(), sequence: 900,
        source: 'vision', evidence: 'seen', stateComplete: true,
        state: { name: 'minecraft:air', properties: {} }, pos: { x: 1, y: -1, z: 0 },
      });
    }
    return null;
  };
  const captured: { loop: WalkRouteExecutor | null } = { loop: null };
  let attaches = 0;
  let unbinds = 0;

  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now, observe,
    starter: (loop, startRequest) => {
      const start = knownStart(history, loop, startRequest, 'revoked');
      captured.loop = loop;
      return start;
    },
    bindActive: () => {
      attaches++;
      return () => { unbinds++; };
    },
  });

  assert.notEqual(result.outcome, 'ARRIVED', '相关报告撤销后不得误报到达');
  assert.ok(result.lastPosition, '撤销后应保留已发生位置');
  assert.ok(result.lastPosition.x > 0.54 + 0.01, `应保留实际位移，实际 x=${result.lastPosition.x}`);
  const loop = captured.loop;
  assert.ok(loop);
  const status = loop.status();
  assert.ok(status?.result, '撤销应真实终止同一 loop');
  assert.deepEqual(status.lastPosition, result.lastPosition, '返回末位应与该 loop 已记录位置一致');
  assert.equal(attaches, 1);
  assert.equal(unbinds, 1, '活动附着应只解绑一次');
  for (const key of Object.keys(bot.control)) assert.equal(bot.control[key], false, `撤销后 ${key} 键应释放`);
});

test('STARTED 后父取消真实终止，保留已测位置、解绑一次并释放全部按键', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const map = buildMap();
  const history = new FragmentStore('world');
  history.saveFragment(fragment('cancel', points));
  const { bot, tick: physicsTick, now } = body({ x: 0.54, z: 0.52 });
  const parent = new AbortController();
  let forwardFrames = 0;
  const tick = () => {
    if (parent.signal.aborted) return Promise.resolve(null);
    if (bot.control.forward) {
      forwardFrames++;
      if (forwardFrames > 5) parent.abort();
    }
    return physicsTick();
  };
  const captured: { loop: WalkRouteExecutor | null } = { loop: null };
  let attaches = 0;
  let unbinds = 0;

  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick, signal: parent.signal, now,
    starter: (loop, startRequest) => {
      const start = knownStart(history, loop, startRequest, 'cancel');
      captured.loop = loop;
      return start;
    },
    bindActive: () => {
      attaches++;
      return () => { unbinds++; };
    },
  });

  assert.equal(result.outcome, 'CANCELLED', result.message);
  assert.equal((result as { problem?: { by?: string } }).problem?.by, 'agent');
  assert.ok(result.lastPosition, '父取消后应保留已测位置');
  assert.ok(result.lastPosition.x > 0.54, `应保留实际发生的位移，实际 x=${result.lastPosition.x}`);
  assert.ok(result.lastPosition.x < 1.5 - 0.12, '部分位置不应伪报到达');
  const loop = captured.loop;
  assert.ok(loop);
  const status = loop.status();
  assert.ok(status?.result);
  assert.deepEqual(status.lastPosition, result.lastPosition, '返回末位应与该 loop 已记录位置一致');
  assert.equal(attaches, 1);
  assert.equal(unbinds, 1, '活动附着应只解绑一次');
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0, '返回后应移除父任务 abort 监听');
  for (const key of Object.keys(bot.control)) assert.equal(bot.control[key], false, `取消后 ${key} 键应释放`);
});

test('REJECTED 保留原 reason/message，且零帧/零控制/零附着、不启动委托', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const cases: Array<{ reason: string; fragmentId: string; stored: PathFragment | null }> = [
    { reason: 'missing_history', fragmentId: 'absent', stored: null },
    {
      reason: 'wrong_start', fragmentId: 'offset',
      stored: fragment('offset', [{ x: 0.6, y: 0, z: 0.5 }, { x: 1.6, y: 0, z: 0.5 }]),
    },
    {
      reason: 'unsupported_geometry', fragmentId: 'diagonal',
      stored: fragment('diagonal', [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }]),
    },
  ];

  for (const c of cases) {
    const map = buildMap();
    const history = new FragmentStore('world');
    if (c.stored !== null) history.saveFragment(c.stored);
    const { bot, tick, controlWrites, controlClears } = body({ x: 0.54, z: 0.52 });
    let frames = 0;
    const countingTick = () => { frames++; return tick(); };
    const signal = new AbortController().signal;
    const captured: { loop: WalkRouteExecutor | null; request: WalkRouteRequest | null; start: KnownWalkRouteStart | null } =
      { loop: null, request: null, start: null };
    let attaches = 0;

    const result = await runWalkRoute({
      map, body: bot as never, request: request(points), tick: countingTick, signal, now: () => 2000,
      bindActive: () => { attaches++; return () => {}; },
      starter: (loop, startRequest) => {
        const start = knownStart(history, loop, startRequest, c.fragmentId);
        captured.loop = loop;
        captured.request = startRequest;
        captured.start = start;
        return start;
      },
    });

    const start = captured.start;
    assert.ok(start && captured.loop && captured.request);
    assert.equal(start.kind, 'REJECTED', `${c.reason}: 应在 start 前被公开 helper 拒绝`);
    if (start.kind !== 'REJECTED') continue;
    assert.equal(start.reason, c.reason);
    assert.equal(result.outcome, 'FAILED', `${c.reason}: 拒绝不是到达/超时/世界堵塞`);
    assert.equal(result.message, start.message, '原 message 应原样保留');
    assert.equal(result.confirmed, false);
    assert.equal((result as { problem: { kind: string } }).problem.kind, 'unavailable');
    assert.match((result as { problem: { detail: string } }).problem.detail, new RegExp(c.reason), '原 reason 应保留在结构化问题中');
    assert.equal(captured.request.worldId, 'world');
    assert.equal(captured.request.sessionId, 's1');
    assert.equal(frames, 0, `${c.reason}: 不得订阅物理帧`);
    assert.equal(controlWrites(), 0, `${c.reason}: 不得写任何控制`);
    assert.equal(controlClears(), 0, `${c.reason}: 不得清理他人控制`);
    assert.equal(attaches, 0, `${c.reason}: 不得附着活动 loop`);
    const loop = captured.loop;
    assert.ok(loop);
    assert.equal(loop.status(), null, `${c.reason}: 不得启动委托`);
    assert.equal(getEventListeners(signal, 'abort').length, 0, `${c.reason}: 返回后不应残留父 abort 监听`);
    for (const key of Object.keys(bot.control)) assert.equal(bot.control[key], false, `${c.reason}: ${key} 键不应被按下`);
  }
});
