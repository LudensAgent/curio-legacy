import assert from 'node:assert/strict';
import { test } from 'node:test';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

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
test('开始前取消即使已在范围内，也不翻译为到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture();
  t.after(() => ctx.memory.close());
  const controller = new AbortController(); controller.abort();
  const result = await travelTo.run({ ...ctx, signal: controller.signal }, argsOf({ to: '2,64,0', range: 3 }, adapter));
  assert.equal(result.status, 'cancelled');
  assert.equal(adapter.actions.length, 0);
});
