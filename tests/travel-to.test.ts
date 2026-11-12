import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';
import { clearMovementSessions, findMovementSession, remainingMakeWayEdits, type MovementIntent } from '../src/skills/movement/session.ts';
import { AbortedError, SUSPEND_ABORT_REASON } from '../src/util.ts';

const argsOf = (raw: unknown, adapter = new FakeAdapter()) => {
  const result = travelTo.validate(raw, adapter);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.args;
};

test('远端一条边碰墙时，走到已证实前缀端点再观察可通侧路', async (t) => {
  const { adapter, map, ctx } = voxelNavigationFixture(6);
  t.after(() => ctx.memory.close());
  let sequence = 10000;
  const wallX = 7;
  const observe = (pos: { x: number; y: number; z: number }) => {
    const name = pos.y < 64 || (pos.x === wallX && pos.z === 0 && pos.y <= 65) ? 'minecraft:stone' : 'minecraft:air';
    const observedAt = Date.now();
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt, sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos });
    return { pos, name, properties: {}, stateComplete: true, worldId: adapter.worldId,
      sessionId: adapter.sessionId, dimension: adapter.dim, observationId: sequence, observedAt, source: 'vision' as const };
  };
  for (let x = wallX; x <= 18; x++) for (const z of [0, 1]) for (const y of [63, 64, 65, 66]) {
    if (x !== wallX || z === 0) observe({ x, y, z });
  }
  const views: number[] = [];
  ctx.senses.observeBlocks = (positions) => {
    views.push(adapter.pos.x);
    return positions.filter(p => p.x === wallX && p.z === 1).map(observe);
  };
  const target = { x: 18, y: 64, z: 0 };
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(views.length > 0 && views.every(x => x >= 6), '只有在墙边才实测可见侧路');
  assert.deepEqual(result.data?.requestedTarget, target);
  assert.ok(Math.hypot(Math.floor(adapter.pos.x) - 18, Math.floor(adapter.pos.z)) <= 2);
});

test('travel_to 只接受公开参数，未知键无论值都拒绝，目标字段也须符合当前形状', () => {
  const adapter = new FakeAdapter();
  for (const option of ['allowDig', 'allowPlace', 'allowTower', 'allowSwim', 'allowHazard', 'sprint']) {
    for (const value of [true, false]) assert.equal(travelTo.validate({ to: '10,64,0', [option]: value }, adapter).ok, false, `${option}:${value}`);
  }
  for (const request of [
    { to: '10,64,0', avoid: [] }, { to: '10,64,0', extra: undefined }, { to: '10,64,0', corridor: 8 },
    { to: '10,64,0', via: 'direct' }, { to: '10,64,0', tool: 'stone_pickaxe' }, { target: '10,64,0' },
    { to: { heading: 'E', distance: 30, corridor: 8 } }, { to: { x: 10, y: 64, z: 0, corridor: 8 } },
    { to: { x: 10, z: 0, landmark: 'base' } }, { to: { landmark: 'base', name: 'x' } }, { to: { death: false } },
  ]) {
    assert.equal(travelTo.validate(request, adapter).ok, false, JSON.stringify(request));
  }
  const args = argsOf({ to: '10,64,0', range: 3, sessionId: 'original-session' });
  assert.deepEqual(travelTo.validate(args, adapter), { ok: true, args });
  for (const raw of [{ to: { landmark: 'base' } }, { to: { portal: 'p1' } }, { to: { death: true } }]) {
    const once = argsOf(raw);
    assert.deepEqual(travelTo.validate(once, adapter), { ok: true, args: once }, JSON.stringify(raw));
  }
  assert.equal(travelTo.validate({ to: '10,64,0', make: false }, adapter).ok, true, '通用 make 不应被当作未知参数');
});

test('travel_to 只有体素规划：到达已知目标，不发 broad pathfinder 目标', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const result = await travelTo.run(ctx, argsOf({ to: { x: 6, y: 64, z: 0 }, range: 1 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.backend, 'voxel_astar');
  assert.deepEqual(result.data?.requestedTarget, { x: 6, y: 64, z: 0 });
  assert.deepEqual(adapter.pos, { x: 5.5, y: 64, z: 0.5 }, '进入 range=1 就停止，不继续走到目标格');
  assert.deepEqual((result.data?.navigation as Record<string, unknown>)?.requestedTarget, { x: 6, y: 64, z: 0 }, 'range 只决定验收，不改写原目标');
  assert.ok(adapter.actions.some((action) => action.startsWith('moveTo:feet')));
  assert.ok(adapter.actions.every((action) => !/^moveTo:(xz|near|advance)/.test(action)));
});

test('缺共享体素时不使用 adapter.moveTo 兜底', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const result = await travelTo.run({ ...ctx, spatial: undefined }, argsOf({ to: '30,64,0' }, adapter));
  assert.equal(result.failureCode, 'NOT_CONNECTED');
  assert.equal(adapter.actions.length, 0);
});

test('委托保留坐标、期限、signal、sessionId 与未到达进展', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const target = { x: 30.25, y: 64, z: 0.75 };
  t.mock.method(navigateTo, 'run', async (nestedCtx, args) => {
    assert.deepEqual(args.to, target);
    assert.equal(args.sessionId, 'same');
    assert.deepEqual(args.arrival, { radius: 1, metric: '3d' });
    assert.equal(nestedCtx.signal, ctx.signal);
    assert.ok(args.deadlineMs <= ctx.deadline);
    adapter.pos.x = 3.5;
    return { status: 'failed', failureCode: 'ERROR', summary: '节点预算耗尽', data: { sessionId: 'same', searchStatus: 'BUDGET_EXHAUSTED', continuation: { canContinue: true, sessionId: 'same' } } };
  });
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 1, sessionId: 'same' }, adapter));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'ERROR', '搜索预算不翻译为时间超时或世界无路');
  assert.equal(result.data?.sessionId, 'same');
  assert.equal(result.data?.searchStatus, 'BUDGET_EXHAUSTED');
  assert.deepEqual(result.data?.position, adapter.pos);
});

test('取消即使已经进入范围也保留 cancelled 与实测位置', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  t.mock.method(navigateTo, 'run', async () => {
    adapter.pos = { x: 20.5, y: 64, z: 0.5 };
    return { status: 'cancelled', summary: '取消', data: { sessionId: 'cancelled-session' } };
  });
  const result = await travelTo.run(ctx, argsOf({ to: '20,64,0' }, adapter));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.data?.sessionId, 'cancelled-session');
  assert.deepEqual(result.data?.position, adapter.pos);
});

test('range 的既有到达条件在开始前生效，不强制走到格心', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const result = await travelTo.run(ctx, argsOf({ to: '2,64,0', range: 3 }, adapter));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.alreadyWithinRange, true);
  assert.equal(adapter.actions.length, 0);
});

test('无 y 且已经进入水平范围时，不要求远处目标列证据', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(0);
  t.after(() => ctx.memory.close());
  const result = await travelTo.run(ctx, argsOf({ to: { x: 2, z: 0 }, range: 3 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.alreadyWithinRange, true);
  assert.deepEqual(result.data?.requestedTarget, { x: 2, z: 0 });
  assert.equal(result.data?.targetFootY, undefined, '未使用目标列高度，不凭空报告已观测脚高');
  assert.equal(adapter.actions.length, 0);
});

test('travel_to 在原目标范围内按格距验收，停在第一处已站稳的位置', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const target = { x: 6, y: 64, z: 0 };
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(adapter.pos, { x: 4.5, y: 64, z: 0.5 });
  assert.equal(adapter.actions.filter(action => action.startsWith('moveTo:feet')).length, 4);
  assert.deepEqual(result.data?.requestedTarget, target);
  const intent = result.data?.intent as Extract<MovementIntent, { kind: 'navigate' }>;
  assert.deepEqual(intent.to, target);
  assert.deepEqual(intent.arrival, { radius: 2, metric: '3d' });
});

test('连续移动实测提前进入 range，但释放控制后停稳超时不算到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.9375, y: 64, z: 0.5 };
  const move = t.mock.method(adapter, 'moveTo', async (target, opts) => {
    assert.equal(opts.settleAtTarget, false);
    assert.equal(target.kind, 'feet');
    // 原计划的中间点 x=1.9375 在范围外；身体实际多走 0.08，进入 x=2 的范围边缘。
    adapter.pos = { x: target.x + 0.08, y: target.y, z: target.z };
  });
  const settle = t.mock.fn(async () => { throw new Error('TIMEOUT: no stop confirmation'); });
  Object.assign(adapter, { settleMovement: settle });
  const target = { x: 3, y: 64, z: 0 };
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 1 }, adapter));
  assert.equal(move.mock.callCount(), 1);
  assert.equal(settle.mock.callCount(), 1);
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(result.data?.stopReason, 'TIMEOUT');
  assert.equal((result.data?.lastSegment as { stopCode: string }).stopCode, 'settlement_failed');
  assert.deepEqual(result.data?.requestedTarget, target);
  const arrival = result.data?.arrival as { satisfied: boolean; measured: unknown };
  assert.equal(arrival.satisfied, false);
  assert.deepEqual(arrival.measured, { position: adapter.pos, distance: 1, onGround: true, settled: false });
  assert.equal((result.data?.nav as { confirmed: boolean }).confirmed, false);
});

test('目标格受阻但当前已证实前缀可进入 range 时，走到范围内并保留原目标', async (t) => {
  const { adapter, map, ctx } = voxelNavigationFixture(4);
  t.after(() => ctx.memory.close());
  let sequence = 10000;
  for (let x = 5; x <= 8; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 66; y++) {
    map.observe({
      worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, observedAt: Date.now(), sequence: sequence++,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: y === 63 || (x === 6 && z === 0 && y <= 65) ? 'minecraft:stone' : 'minecraft:air', properties: {} },
      pos: { x, y, z },
    });
  }
  const target = { x: 6, y: 64, z: 0 };
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(adapter.pos, { x: 4.5, y: 64, z: 0.5 });
  assert.equal(adapter.actions.filter(action => action.startsWith('moveTo:feet')).length, 4);
  assert.deepEqual(result.data?.requestedTarget, target);
  assert.deepEqual((result.data?.navigation as Record<string, unknown>)?.requestedTarget, target);
  assert.equal(result.data?.searchStatus, 'FOUND', '原 range 参与搜索，不必搜索到受阻的目标格');
  const search = result.data?.lastSearch as { arrival: unknown; goalMetric: string };
  assert.deepEqual(search.arrival, { kind: 'near', radius: 2, coordinates: 'cell' });
  assert.equal(search.goalMetric, '3d');
});

test('无 y 的范围搜索可在不同脚高的目标列旁按水平格距完成', async (t) => {
  // 平台到 x=4，目标列另建在 y=70，避免同一毫秒里先种地面再覆盖成空气。
  const { adapter, map, ctx } = voxelNavigationFixture(4);
  t.after(() => ctx.memory.close());
  [69, 70, 71].forEach((y) => map.observe({
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
    observedAt: Date.now(), sequence: 10000 + y, source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: y === 69 ? 'minecraft:stone' : 'minecraft:air', properties: {} }, pos: { x: 6, y, z: 0 },
  }));
  const target = { x: 6, z: 0 };
  const result = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.targetFootY, 70);
  assert.deepEqual(adapter.pos, { x: 4.5, y: 64, z: 0.5 });
  assert.deepEqual(result.data?.requestedTarget, target);
  assert.equal(result.data?.searchStatus, 'FOUND');
  assert.equal((result.data?.lastSearch as { goalMetric: string }).goalMetric, 'horizontal');
});

test('无 y 的移动范围保持水平格距，不被推导脚高改成三维距离', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  t.mock.method(navigateTo, 'run', async (_ctx, args) => {
    assert.deepEqual(args.to, { x: 6, y: 64, z: 0 });
    assert.deepEqual(args.arrival, { radius: 2, metric: 'horizontal' });
    adapter.pos = { x: 4.5, y: 70, z: 0.5 };
    return { status: 'failed', failureCode: 'NOT_FOUND', summary: '前方未知' };
  });
  const result = await travelTo.run(ctx, argsOf({ to: { x: 6, z: 0 }, range: 2 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.requestedTarget, { x: 6, z: 0 });
});

test('悬空经过 range 不能被包装成已经到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  t.mock.method(navigateTo, 'run', async () => {
    adapter.pos = { x: 5.5, y: 64, z: 0.5 };
    adapter.onGround = false;
    return { status: 'failed', failureCode: 'EFFECT_NOT_CONFIRMED', summary: '仍未落稳' };
  });
  const result = await travelTo.run(ctx, argsOf({ to: { x: 6, y: 64, z: 0 }, range: 2 }, adapter));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal((result.data?.arrival as { satisfied: boolean })?.satisfied, false);
});

test('有 y 的范围保留垂直距离，同 session 续接不能改验收范围', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const target = { x: 70, y: 64, z: 0 };
  const first = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(first.status, 'failed');
  assert.equal(typeof first.data?.sessionId, 'string');
  const second = await travelTo.run(ctx, argsOf({ to: target, range: 3, sessionId: first.data?.sessionId }, adapter));
  assert.equal(second.failureCode, 'BAD_ARGS');
  assert.equal(second.data?.reason, 'INTENT_MISMATCH');

  t.mock.method(navigateTo, 'run', async () => {
    adapter.pos = { x: 68.5, y: 70, z: 0.5 };
    return { status: 'failed', failureCode: 'NOT_FOUND', summary: '未到原脚高' };
  });
  const high = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(high.status, 'failed', '水平距 2 格但高 6 格，不能当成三维 range=2 已到达');
});

test('进入新范围不能绕过 session 原到达条件，合法续接可按实测收工', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const target = { x: 12, y: 64, z: 0 };
  const first = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(first.status, 'failed');
  assert.equal(adapter.pos.x, 8.5);
  const sessionId = first.data?.sessionId;
  assert.equal(typeof sessionId, 'string');
  const changed = await travelTo.run(ctx, argsOf({ to: target, range: 6, sessionId }, adapter));
  assert.equal(changed.status, 'failed');
  assert.equal(changed.failureCode, 'BAD_ARGS');
  assert.equal(changed.data?.reason, 'INTENT_MISMATCH');
  adapter.pos.x = 10.5;
  const before = adapter.actions.length;
  const unchanged = await travelTo.run(ctx, argsOf({ to: target, range: 2, sessionId }, adapter));
  assert.equal(unchanged.status, 'succeeded', unchanged.summary);
  assert.equal(unchanged.data?.sessionId, sessionId);
  assert.equal(adapter.actions.length, before, '合法同意图续接已在范围内，无须再次移动');
});

test('无 y 续接使用冻结脚高，不因新站位超出原脚高扫描范围而失败', async (t) => {
  const { adapter, map, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  for (const y of [63, 64, 65]) map.observe({
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, observedAt: Date.now(), sequence: y + 10000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: y === 63 ? 'minecraft:stone' : 'minecraft:air', properties: {} }, pos: { x: 12, y, z: 0 },
  });
  const target = { x: 12, z: 0 };
  const first = await travelTo.run(ctx, argsOf({ to: target, range: 2 }, adapter));
  assert.equal(first.status, 'failed');
  assert.equal(first.data?.targetFootY, 64);
  assert.equal(typeof first.data?.sessionId, 'string');
  // 新身体位置高出原目标脚高 16 格之外；无 y 的水平到达条件仍可被实测满足。
  adapter.pos = { x: 10.5, y: 90, z: 0.5 };
  const second = await travelTo.run(ctx, argsOf({ to: target, range: 2, sessionId: first.data?.sessionId }, adapter));
  assert.equal(second.status, 'succeeded', second.summary);
  assert.equal(second.data?.targetFootY, 64);
  assert.equal(second.data?.targetYSource, 'frozen_session');
  assert.deepEqual(second.data?.requestedTarget, target);
});
test('挂起后恢复仍在原目的地与原 range 上续接', async (t) => {
  clearMovementSessions();
  const { adapter, ctx } = voxelNavigationFixture(48);
  t.after(() => ctx.memory.close());
  const move = adapter.moveTo.bind(adapter);
  const controller = new AbortController();
  let moves = 0;
  t.mock.method(adapter, 'moveTo', async (...args: Parameters<FakeAdapter['moveTo']>) => {
    const result = await move(...args);
    if (++moves === 3) controller.abort(SUSPEND_ABORT_REASON);
    return result;
  });
  const target = { x: 40, y: 64, z: 0 };
  const first = await travelTo.run({ ...ctx, signal: controller.signal }, argsOf({ to: target, range: 1 }, adapter));
  assert.equal(first.status, 'cancelled', first.summary);
  assert.equal((first.data?.stop as { reason: string }).reason, 'SUSPENDED');
  assert.deepEqual(first.data?.requestedTarget, target, '挂起不替换原目标');
  const sessionId = first.data?.sessionId;
  assert.equal(typeof sessionId, 'string');
  assert.deepEqual((first.data?.continuation as { canContinue: boolean }).canContinue, true);
  const pausedAt = adapter.pos.x;

  const resumed = await travelTo.run(ctx, argsOf({ to: target, range: 1, sessionId }, adapter));
  assert.equal(resumed.status, 'succeeded', resumed.summary);
  assert.deepEqual(resumed.data?.requestedTarget, target);
  assert.deepEqual((resumed.data?.intent as Extract<MovementIntent, { kind: 'navigate' }>).arrival, { radius: 1, metric: '3d' });
  assert.ok(adapter.pos.x > pausedAt);
  assert.ok(Math.hypot(adapter.pos.x - 40, adapter.pos.z) <= 1);
});

test('插曲的新移动意图不会把已挂起的原委托标成 SUPERSEDED', async (t) => {
  clearMovementSessions();
  const { adapter, ctx } = voxelNavigationFixture(48);
  t.after(() => ctx.memory.close());
  const move = adapter.moveTo.bind(adapter);
  const controller = new AbortController();
  let moves = 0;
  t.mock.method(adapter, 'moveTo', async (...args: Parameters<FakeAdapter['moveTo']>) => {
    const result = await move(...args);
    if (++moves === 3) controller.abort(SUSPEND_ABORT_REASON);
    return result;
  });
  const target = { x: 40, y: 64, z: 0 };
  const first = await travelTo.run({ ...ctx, signal: controller.signal }, argsOf({ to: target, range: 1 }, adapter));
  assert.equal(first.status, 'cancelled');
  const sessionId = first.data?.sessionId;
  assert.equal(typeof sessionId, 'string');

  // 插曲借用身体走一小段：新 session 不能取代已挂起的原委托。
  const detour = await travelTo.run(ctx, argsOf({ to: { x: 5, y: 64, z: 0 }, range: 1 }, adapter));
  assert.equal(detour.status, 'succeeded', detour.summary);
  assert.notEqual(detour.data?.sessionId, sessionId);
  const resumed = await travelTo.run(ctx, argsOf({ to: target, range: 1, sessionId }, adapter));
  assert.equal(resumed.status, 'succeeded', resumed.summary);
  assert.equal(resumed.data?.sessionId, sessionId);
});

test('施工额度按会话累计：恢复后只剩余额，且不能借旧 sessionId 扩大授权', async (t) => {
  clearMovementSessions();
  const { adapter, map, ctx } = voxelNavigationFixture(12);
  t.after(() => ctx.memory.close());
  // 真实会话会把挖过的格标成“动作效果待确认”；这里只需记录写入成功。
  Object.assign(ctx.spatial!, { markModified: () => ({ status: 'written', report: { sections: [] }, deliveryError: null }) });
  let sequence = 10000;
  // 横跨整条走廊的墙，只能挖穿；y=64/65 两层各一格。
  for (const z of [-1, 0, 1]) for (const y of [64, 65]) {
    const pos = { x: 6, y, z };
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: 'minecraft:stone', properties: {} }, pos });
    adapter.blocks.push({ name: 'stone', pos });
  }
  const target = { x: 10, y: 64, z: 0 };
  const first = await travelTo.run(ctx, argsOf({ to: target, range: 1, dig: true, maxEdits: 1 }, adapter));
  assert.equal(first.status, 'failed', first.summary);
  assert.equal((first.data?.stop as { reason: string }).reason, 'MAKE_WAY_BUDGET_EXHAUSTED');
  assert.match(String((first.data?.stop as { detail?: string }).detail), /施工 1\/1/);
  assert.equal(adapter.actions.filter((action) => action.startsWith('dig:')).length, 1, '只挖开额度允许的第一格');
  const sessionId = first.data?.sessionId;
  assert.equal(typeof sessionId, 'string');
  assert.equal((first.data?.counters as { makeWayEdits: number }).makeWayEdits, 1);

  const widened = await travelTo.run(ctx, argsOf({ to: target, range: 1, dig: true, maxEdits: 2, sessionId }, adapter));
  assert.equal(widened.status, 'failed');
  assert.equal(widened.failureCode, 'BAD_ARGS');
  assert.equal(widened.data?.reason, 'INTENT_MISMATCH', '旧 session 不能获得更多施工授权');

  const digCount = adapter.actions.filter((action) => action.startsWith('dig:')).length;
  const again = await travelTo.run(ctx, argsOf({ to: target, range: 1, dig: true, maxEdits: 1, sessionId }, adapter));
  assert.equal(again.status, 'failed');
  assert.equal((again.data?.stop as { reason: string }).reason, 'MAKE_WAY_BUDGET_EXHAUSTED');
  assert.match(String((again.data?.stop as { detail?: string }).detail), /施工 1\/1/);
  assert.equal(adapter.actions.filter((action) => action.startsWith('dig:')).length, digCount, '额度用尽后不再自动开新的施工预算');
});

test('开路执行中被挂起：已确认的改动计入会话额度，恢复不重新获得预算', async (t) => {
  clearMovementSessions();
  const { adapter, map, ctx } = voxelNavigationFixture(12);
  t.after(() => ctx.memory.close());
  Object.assign(ctx.spatial!, { markModified: () => ({ status: 'written', report: { sections: [] }, deliveryError: null }) });
  let sequence = 20000;
  for (const z of [-1, 0, 1]) for (const y of [64, 65]) {
    const pos = { x: 6, y, z };
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: 'minecraft:stone', properties: {} }, pos });
    adapter.blocks.push({ name: 'stone', pos });
  }
  const controller = new AbortController();
  const realDig = adapter.dig.bind(adapter);
  let digs = 0;
  t.mock.method(adapter, 'dig', async (...args: Parameters<FakeAdapter['dig']>) => {
    // 第一格挖开并确认后，第二格执行时收到挂起：这一段没有返回 leg，但第一处改动已经发生。
    if (++digs === 2) { controller.abort(SUSPEND_ABORT_REASON); throw new AbortedError('cancelled'); }
    return realDig(...args);
  });
  const target = { x: 10, y: 64, z: 0 };
  const result = await travelTo.run({ ...ctx, signal: controller.signal },
    argsOf({ to: target, range: 1, dig: true, maxEdits: 12 }, adapter));
  assert.equal(result.status, 'cancelled', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'SUSPENDED');
  const edits = (result.data?.makeWay as { edits: { kind: string; pos: Vec3Like }[] } | undefined)?.edits ?? [];
  assert.equal(edits.length, 1, '已确认的一处改动保留在回执里');
  assert.match(result.summary, /已确认改动 1 处/);
  const session = findMovementSession(result.data?.sessionId as string);
  assert.ok(session);
  assert.equal(remainingMakeWayEdits(session), 11, '挂起前用掉的施工额度不能因回执中断而丢失');
});

test('开始前取消即使已在范围内，也不翻译为到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const controller = new AbortController(); controller.abort();
  const result = await travelTo.run({ ...ctx, signal: controller.signal }, argsOf({ to: '2,64,0', range: 3 }, adapter));
  assert.equal(result.status, 'cancelled');
  assert.equal(adapter.actions.length, 0);
});
