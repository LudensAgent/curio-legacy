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

/** 平台边缘世界：y=-1 支撑仅在 x<edgeX 为石，x>=edgeX 为空气（脚高 y=0 的身体越过即跌落）。 */
function platformWorld(edgeX: number) {
  return {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const solid = p.y <= -1 && p.x < edgeX;
      const stateId = solid ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
}

/** 脚部水平 AABB（半宽 0.3）与 y=-1 实心块是否有正面积交叠，即脚下存在几何支撑。 */
function supportedBy(world: { getBlock(p: { floored(): { x: number; y: number; z: number } }): { name: string } }, pos: { x: number; y: number; z: number }): boolean {
  if (pos.y !== 0) return false; // 本夹具固定脚高 y=0：只认可恰在平台面上的支撑，不在空中仅凭 XZ 交叠推断支撑。
  const half = 0.3;
  const minX = pos.x - half, maxX = pos.x + half;
  const minZ = pos.z - half, maxZ = pos.z + half;
  for (let bx = Math.floor(minX); bx <= Math.floor(maxX); bx++) {
    for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ); bz++) {
      const overlapX = Math.min(maxX, bx + 1) - Math.max(minX, bx);
      const overlapZ = Math.min(maxZ, bz + 1) - Math.max(minZ, bz);
      if (overlapX <= 0 || overlapZ <= 0) continue;
      if (world.getBlock({ floored: () => ({ x: bx, y: -1, z: bz }) }).name !== 'air') return true;
    }
  }
  return false;
}

/** 带真实物理的身体：setControlState 驱动控制，tick 推 tickEvery 步物理并推进模拟时钟。
 *  trace 记录每个模拟子步（含采样帧号），用于证明隐藏子步被逐帧观察而非只看到采样端点。 */
function body(start: { x: number; z: number }, tickEvery: number | number[] = 1, world = flatWorld()) {
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
  const physics = Physics(data, world);
  let clock = 2000;
  let ti = 0;
  let frame = 0;
  const trace: Array<{ frame: number; step: number; x: number; y: number; z: number; onGround: boolean; supported: boolean; forward: boolean; back: boolean; sneak: boolean }> = [];
  const tick = () => {
    const n = Array.isArray(tickEvery) ? tickEvery[ti++ % tickEvery.length]! : tickEvery;
    for (let k = 0; k < n; k++) {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      trace.push({ frame, step: k, x: entity.position.x, y: entity.position.y, z: entity.position.z,
        onGround: entity.onGround, supported: supportedBy(world, entity.position),
        forward: control.forward, back: control.back, sneak: control.sneak });
    }
    frame++;
    clock += 50 * n;
    return Promise.resolve(bot.entity);
  };
  return { bot, tick, now: () => clock, trace, frameCount: () => frame };
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

function buildPlatformMap(edgeX: number) {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = -1; y <= 2; y++) {
    map.observe({
      worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: y === -1 && x < edgeX ? { name: 'minecraft:stone', properties: {} } : { name: 'minecraft:air', properties: {} },
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

test('平台边缘 + 不均匀采样不滑出平台，每个子步都有支撑且末位仍在平台上', async () => {
  const edgeX = 2; // 支撑只在 x<2，目标 x=1.5 是最后一块实心
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const cases = [
    { sx: 0.55, cadence: [1, 2, 1, 1, 4] },
    { sx: 0.40, cadence: [1, 2, 1, 1, 4] },
    { sx: 0.55, cadence: [1, 1, 3, 1, 2] },
    { sx: 0.40, cadence: [1, 1, 3, 1, 2] },
  ];
  for (const { sx, cadence } of cases) {
    const map = buildPlatformMap(edgeX);
    const { bot, tick, now, trace, frameCount } = body({ x: sx, z: 0.52 }, cadence, platformWorld(edgeX));
    const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: new AbortController().signal, now });
    assert.equal(result.outcome, 'ARRIVED', `起点 x=${sx} cadence=${cadence} 不应滑落超时：${result.message}`);
    assert.ok(result.outcome === 'ARRIVED');
    assert.equal(result.confirmed, true, '到达结果应带已确认标记');
    const last = result.lastPosition;
    assert.ok(last, '应有末位');
    assert.equal(last!.y, 0, '末位脚高不应跌落');
    // 所有子步：脚高恒为 0（不跌落也不离地），且脚下始终有正面积几何支撑（最大偏移子步也保持支撑）。
    assert.equal(Math.min(...trace.map((t) => t.y)), 0, '任意子步脚高不得低于 0');
    assert.ok(trace.every((t) => t.supported), '每个子步脚下都应有几何支撑');
    // 最大水平偏移须保持脚部与平台的正面积交叠：中心 x 不超过 edgeX+0.3（脚半宽），而非仅中心在平台内。
    const maxX = Math.max(...trace.map((t) => t.x));
    assert.ok(maxX < edgeX + 0.3, `最大水平偏移 x=${maxX.toFixed(2)} 应保持脚下支撑（<${edgeX + 0.3}）`);
    // 隐藏子步确实被记录：trace 长度多于采样帧数。
    assert.ok(trace.length > frameCount(), `trace(${trace.length}) 应多于采样帧(${frameCount()})`);
    // 到达后所有控制释放（含冲刺键）。
    for (const key of Object.keys(bot.control)) {
      assert.equal(bot.control[key], false, `到达后 ${key} 键应释放`);
    }
  }
});

test('初始稳定窗口前八帧反复重置时不提前写控制，稳定后启动首段并到达', async () => {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = -1; y <= 2; y++) {
    map.observe({ worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: 1000, sequence: 1, source: 'vision', evidence: 'seen', stateComplete: true, state: y === -1 ? { name: 'minecraft:stone', properties: {} } : { name: 'minecraft:air', properties: {} }, pos: { x, y, z } });
  }
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  // 前八帧用交替 onGround 标志显式扰动，反复重置稳定窗口；第八帧后恢复正常物理采样。
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: new Vec3(0.54, 0, 0.52), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} };
  let frame = 0;
  let firstForwardFrame: number | null = null;
  const unreadyWrites: number[] = [];
  const bot = { version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) {
      control[name] = value;
      if (name === 'forward' && value && firstForwardFrame === null) firstForwardFrame = frame;
      if (['forward', 'back', 'sneak'].includes(name) && frame <= 8) unreadyWrites.push(frame);
    },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; } };
  const world = flatWorld();
  const physics = Physics(data, world);
  let clock = 1000;
  let pending = 0, maxPending = 0;
  const tick = (signal: AbortSignal) => {
    frame++;
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    if (frame <= 8) entity.onGround = false; // 显式扰动：前八帧强制不稳
    clock += 50;
    pending++;
    maxPending = Math.max(maxPending, pending);
    return Promise.resolve().then(() => { pending--; return bot.entity; });
  };
  // 模拟时钟只在 tick 时推进：若稳定窗口回归为「最多采样 8 帧」后停止喂帧，模拟时钟不再前进，
  // 宿主循环会按真实时间空转 20000 次才判 CANCELLED。加一个真实时间看门狗（1s）在到期时主动取消，
  // 让「停止采样」的回归在有限时间内以非 ARRIVED 失败，而不是挂起。这只约束测试失败时间，不改产品超时。
  const watchdog = new AbortController();
  const watchdogTimer = setTimeout(() => watchdog.abort(), 1000);
  try {
    const result = await runWalkRoute({ map, body: bot as never, request: request(points), tick, signal: watchdog.signal, now: () => clock });
    assert.equal(result.outcome, 'ARRIVED', `稳定后应启动首段并到达：${result.message}`);
    assert.ok(result.outcome === 'ARRIVED');
    assert.equal(result.confirmed, true, '到达结果应带已确认标记');
    assert.ok(firstForwardFrame !== null && firstForwardFrame > 8, `首段执行（首次按前进）应在第 8 帧之后，实际第 ${firstForwardFrame} 帧`);
    assert.equal(unreadyWrites.length, 0, `前八帧未就绪期间不得写任何移动键：帧 ${unreadyWrites.join(',')}`);
    assert.equal(maxPending, 1, `并发待处理 tick 请求应不超过 1，实际 ${maxPending}`);
    // 到达后所有控制释放（含冲刺键）。
    for (const key of Object.keys(control)) {
      assert.equal(control[key], false, `到达后 ${key} 键应释放`);
    }
  } finally {
    clearTimeout(watchdogTimer);
  }
});

test('断线（tick 立即返回 null 且 connected=false）在初始化阶段立即按 lifecycle 取消并清理', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot } = body({ x: 0.54, z: 0.52 });
  const tick = () => Promise.resolve(null); // 连接已结束：没有未来物理帧
  const start = Date.now();
  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick,
    signal: new AbortController().signal, now: Date.now, deadlineMs: Date.now() + 5000,
    lifecycle: () => ({ worldId: 'world', dim: 'overworld', sessionId: 's1', alive: true, connected: false, observationReady: true }),
  });
  const elapsed = Date.now() - start;
  assert.equal(result.outcome, 'CANCELLED', result.message);
  assert.equal((result as { problem?: { by?: string } }).problem?.by, 'lifecycle');
  assert.ok(elapsed < 1000, `断线应立即返回而非等到期限（实际 ${elapsed}ms）`);
  for (const key of Object.keys(bot.control)) {
    assert.equal(bot.control[key], false, `初始化阶段断线后 ${key} 键不应被按下`);
  }
});

test('活动移动中断线：保留部分末位位移并释放全部按键', async () => {
  const map = buildMap();
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const { bot, tick: physicsTick, now } = body({ x: 0.54, z: 0.52 });
  let connected = true;
  let forwardFrames = 0;
  const tick = (signal: AbortSignal) => {
    if (!connected || signal.aborted) return Promise.resolve(null);
    if (bot.control.forward) {
      forwardFrames += 1;
      if (forwardFrames > 3) { connected = false; return Promise.resolve(null); }
    }
    return physicsTick();
  };
  const result = await runWalkRoute({
    map, body: bot as never, request: request(points), tick,
    signal: new AbortController().signal, now,
    lifecycle: () => ({ worldId: 'world', dim: 'overworld', sessionId: 's1', alive: true, connected, observationReady: true }),
  });
  assert.equal(result.outcome, 'CANCELLED', result.message);
  assert.equal((result as { problem?: { by?: string } }).problem?.by, 'lifecycle');
  const last = (result as { lastPosition?: { x: number; z: number } }).lastPosition;
  assert.ok(last, '断线时应保留已测末位位移');
  assert.ok(last && last.x < 1.5 - 0.12, `末位 x=${last?.x.toFixed(2)} 应仍是部分位移而非到达目标`);
  for (const key of Object.keys(bot.control)) {
    assert.equal(bot.control[key], false, `断线后 ${key} 键应释放`);
  }
});
