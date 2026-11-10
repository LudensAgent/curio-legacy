import assert from 'node:assert/strict';
import { test } from 'node:test';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';
import type { MovementIntent } from '../src/skills/movement/session.ts';

const argsOf = (raw: unknown, adapter = new FakeAdapter()) => {
  const result = travelTo.validate(raw, adapter);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.args;
};

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
  const { adapter, map, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  [63, 64, 65, 66, 67, 68, 69, 70, 71, 72].forEach((y) => map.observe({
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
test('开始前取消即使已在范围内，也不翻译为到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const controller = new AbortController(); controller.abort();
  const result = await travelTo.run({ ...ctx, signal: controller.signal }, argsOf({ to: '2,64,0', range: 3 }, adapter));
  assert.equal(result.status, 'cancelled');
  assert.equal(adapter.actions.length, 0);
});
