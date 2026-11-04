import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { GROUNDED_ARRIVAL_DEFAULTS, VoxelMap, type WalkRouteRequest } from 'curio-minecraft-3d-memory';
import { runWalkRoute, walkCollisionProvider } from '../src/adapter/walk-route.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/** 平坦石地面（y=-1），身体脚高 y=0。 */
function flatWorld() {
  const world = {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const stateId = p.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
  return world;
}

/** 带真实物理的身体：setControlState 驱动控制，tick 推 tickEvery 步物理并推进模拟时钟。 */
function body(start: { x: number; z: number }, tickEvery: number | number[] = 1) {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: new Vec3(start.x, 0, start.z), velocity: new Vec3(0, 0, 0), onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {} };
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  let clock = 2000;
  let ti = 0;
  const tick = () => {
    const n = Array.isArray(tickEvery) ? tickEvery[ti++ % tickEvery.length]! : tickEvery;
    for (let k = 0; k < n; k++) physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    clock += 50 * n;
    return Promise.resolve(bot.entity);
  };
  return { bot, tick, now: () => clock };
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

test('三段含转弯的偏移起点路线走通并 ARRIVED，末位用实际测量值', async () => {
  const map = buildMap();
  // 名义点列；身体实际起点带偏移（0.54,0.52），后续名义点沿 X/Z 相邻。
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }];
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now });
  assert.equal(result.outcome, 'ARRIVED', result.message);
  assert.ok(result.outcome === 'ARRIVED' && result.lastPosition);
  // 末位不是名义点 (2.5, 1.5)，而是实际测量位置。
  assert.ok(Math.abs((result as { lastPosition: { x: number; z: number } }).lastPosition.x - 2.5) <= 0.12);
  assert.ok(Math.abs((result as { lastPosition: { x: number; z: number } }).lastPosition.z - 1.5) <= 0.12);
  assert.equal(bot.control.forward, false, '到达后应松开前进键');
});

test('未知形状返回能力缺口，不当作可通行', () => {
  const r = walkCollisionProvider.resolve({ name: 'minecraft:oak_slab', properties: {} }, { x: 0, y: 0, z: 0 }, { cell: () => ({ kind: 'unknown' } as never) });
  assert.equal(r.kind, 'unsupported_shape');
  if (r.kind === 'unsupported_shape') assert.match(r.block, /oak_slab/);
});

test('无 physicsTick（断线/服务器停帧）时按期限有界退出，不挂起', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot } = body({ x: 0.54, z: 0.52 });
  const neverTick = () => new Promise<never>((_resolve) => {}); // 永不产生物理帧
  const start = Date.now();
  const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick: neverTick, signal: new AbortController().signal, now: Date.now, deadlineMs: Date.now() + 150 });
  const elapsed = Date.now() - start;
  assert.equal(result.outcome, 'TIMEOUT', `无物理帧且期限耗尽应归 TIMEOUT 而非 CANCELLED：${result.message}`);
  assert.ok(elapsed < 2000, `应在一段期限内结束，不挂起（实际 ${elapsed}ms）`);
  assert.equal(bot.control.forward, false, '退出后不得继续按前进键');
});

test('合法起点偏移（0.40/0.55）不冲过目标而超时，而是有限位置修正后到达', async () => {
  for (const sx of [0.40, 0.55]) {
    const map = buildMap();
    const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const { bot, tick, now } = body({ x: sx, z: 0.52 });
    const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now });
    assert.equal(result.outcome, 'ARRIVED', `起点 x=${sx} 应到达而非超时：${result.message}`);
    assert.equal(bot.control.forward, false, '到达后应松开前进键');
  }
});

test('每两 tick 采样仍到达，不前后振荡超时', async () => {
  for (const sx of [0.40, 0.50, 0.55]) {
    const map = buildMap();
    const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const { bot, tick, now } = body({ x: sx, z: 0.52 }, 2);
    const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now });
    assert.equal(result.outcome, 'ARRIVED', `起点 x=${sx} 每 2 tick 采样应到达而非振荡超时：${result.message}`);
    assert.equal(bot.control.forward, false, '到达后应松开前进键');
    assert.equal(bot.control.back, false, '到达后不应残留倒退键');
    assert.equal(bot.control.sneak, false, '到达后不应残留潜行键');
  }
});

test('不均匀采样 [1,1,3,1,2] 越过目标后及时制动并到达，不持续前进', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot, tick, now } = body({ x: 0.40, z: 0.52 }, [1, 1, 3, 1, 2]);
  const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now });
  assert.equal(result.outcome, 'ARRIVED', `不均匀采样应到达而非持续前进超时：${result.message}`);
  const last = result.lastPosition;
  assert.ok(last && Math.abs(last.x - 1.5) <= 0.12, `末位 ${last?.x.toFixed(2)} 偏离目标过大`);
});

test('首帧 scope 失效后不再等期限，立即返回', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot } = body({ x: 0.54, z: 0.52 });
  let frames = 0;
  const tick = () => {
    frames++;
    if (frames > 1) return new Promise<never>(() => {}); // 首帧后不再产生物理帧
    return Promise.resolve(bot.entity);
  };
  const start = Date.now();
  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick,
    signal: new AbortController().signal, now: Date.now, deadlineMs: Date.now() + 5000,
    lifecycle: () => ({ worldId: 'world', dim: 'overworld', sessionId: 'other', alive: true, connected: true, observationReady: true }),
  });
  const elapsed = Date.now() - start;
  assert.equal(result.outcome, 'FAILED');
  assert.equal((result as { problem?: { kind: string } }).problem?.kind, 'scope_changed');
  assert.ok(elapsed < 1000, `首帧失效应立即返回而非等到期限（实际 ${elapsed}ms）`);
});

test('宿主期限早于请求期限：返回后不再继续执行，保留部分位移', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now, deadlineMs: 2500 });
  assert.equal(result.outcome, 'TIMEOUT', result.message);
  assert.equal(bot.control.forward, false, '返回后不得继续按前进键');
});

test('可见支撑变化在到达前被处理，不误报 ARRIVED', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot, tick, now } = body({ x: 0.54, z: 0.52 });
  let removed = false;
  const observe = () => {
    if (!removed && now() >= 2500) {
      removed = true;
      return map.observe({ worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: now(), sequence: 900, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x: 1, y: -1, z: 0 } });
    }
    return null;
  };
  const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now, observe });
  assert.notEqual(result.outcome, 'ARRIVED', '支撑变化应导致失效，不能误报 ARRIVED');
});
