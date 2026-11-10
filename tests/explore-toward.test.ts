import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { lookAround } from '../src/skills/movement.ts';
import { walkCollisionProvider } from '../src/adapter/walk-collision.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

const argsOf = (raw: unknown, adapter: FakeAdapter) => {
  const result = exploreToward.validate(raw, adapter);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.args;
};

test('方向探索保留距离，明确拒绝不支持的对角/施工能力与未知参数', () => {
  const adapter = new FakeAdapter();
  const args = argsOf({ direction: 'E', distance: 512 }, adapter);
  assert.equal(args.distance, 512);
  assert.deepEqual(exploreToward.validate(args, adapter), { ok: true, args });
  for (const request of [
    { direction: 'NE', distance: 40 }, { direction: 'E', distance: 600 },
    { direction: 'E', distance: 40, allowDig: true }, { direction: 'E', distance: 40, allowDig: false },
    { direction: 'E', distance: 40, allowSwim: false }, { direction: 'E', distance: 40, tool: 'stone_pickaxe' },
    { direction: 'E', distance: 40, via: 'auto' }, { direction: 'E', distance: 40, avoid: [] },
    { direction: 'E', distance: 40, extra: undefined },
  ]) assert.equal(exploreToward.validate(request, adapter).ok, false, JSON.stringify(request));
  assert.equal(exploreToward.validate({ direction: 'E', distance: 40, make: false }, adapter).ok, true, '通用 make 不应被当作未知参数');
});

test('方向探索跨四个窗口沿冻结方向推进 64 格，扫描次数有界且不改变方向', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  const scanPositions: number[] = [];
  t.mock.method(lookAround, 'run', async (scanCtx, args) => {
    scanPositions.push(scanCtx.adapter.state().pos.x);
    assert.equal(args.direction, 'E');
    await scanCtx.adapter.look(Math.PI, -0.05);
    return { status: 'succeeded', summary: '已扫视，当前面朝南' };
  });
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, segment: 16 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.planner, 'voxel_astar');
  assert.equal(result.data?.backend, 'land-search');
  assert.equal((result.data?.intent as { distance: number; direction: string }).distance, 64);
  assert.equal((result.data?.intent as { direction: string }).direction, 'E');
  assert.deepEqual(result.data?.frozenOrigin, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(adapter.pos, { x: 64.5, y: 64, z: 0.5 });
  assert.equal((result.data?.progress as { along: number }).along, 64);
  assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 64);
  assert.deepEqual(scanPositions, [16.5, 32.5, 48.5], '只在仍需前进的三个窗口结束时扫描，抵达后直接返回');
  assert.ok(adapter.actions.every((action) => !/^moveTo:(xz|near|advance)/.test(action)));
});

test('until 只根据段后本轮扫视停止，不将其报为走完全部距离', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  t.mock.method(lookAround, 'run', async () => ({ status: 'succeeded', summary: '本轮看见原木', data: { found: 'oak_log' } }));
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, segment: 16, until: 'log' }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.ok(adapter.pos.x < 64);
  assert.equal((result.data?.intent as { distance: number }).distance, 64);
});

test('带 until 的最后一个窗口仍在终点扫描本轮目标', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(20);
  t.after(() => ctx.memory.close());
  const scan = t.mock.method(lookAround, 'run', async (_ctx, args) => {
    assert.equal(args.for, 'log');
    assert.deepEqual(adapter.pos, { x: 16.5, y: 64, z: 0.5 });
    return { status: 'succeeded', summary: '本轮看见原木', data: { found: 'oak_log' } };
  });
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, segment: 16, until: 'log' }, adapter));
  assert.equal(scan.mock.callCount(), 1);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.deepEqual(result.data?.sighting, { found: 'oak_log' });
  assert.equal((result.data?.progress as { along: number }).along, 16);
});

test('已做定向观察的短前沿不再追加广角扫描', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(3);
  t.after(() => ctx.memory.close());
  let scans = 0;
  t.mock.method(lookAround, 'run', async () => { scans++; return { status: 'succeeded', summary: '已扫视' }; });
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 48, segment: 16 }, adapter));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  assert.ok((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions > 0);
  assert.ok((result.data?.counters as { observations: number }).observations > 0);
  assert.equal(scans, 0, '未知前沿已有定向观察，不能在返回失败前再扫五个视角');
});

test('零推进或执行中途失败时没有无目标扫描', async (t) => {
  for (const successfulSteps of [0, 1]) {
    const { adapter, ctx } = voxelNavigationFixture(40);
    t.after(() => ctx.memory.close());
    const moveTo = adapter.moveTo.bind(adapter);
    let moves = 0, scans = 0;
    t.mock.method(adapter, 'moveTo', async (...args: Parameters<FakeAdapter['moveTo']>) => {
      if (moves++ >= successfulSteps) throw new Error('本次身体执行失败');
      return moveTo(...args);
    });
    const scan = t.mock.method(lookAround, 'run', async () => { scans++; return { status: 'succeeded', summary: '已扫视' }; });
    const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 32, segment: 16 }, adapter));
    assert.equal(result.status, 'failed', result.summary);
    assert.equal((result.data?.stop as { reason: string }).reason, 'PHYSICAL_FAILURE');
    assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, successfulSteps);
    assert.equal(scans, 0, '移动已经失败，不能追加与目标无关的扫描');
    scan.mock.restore();
  }
});

test('单次搜索硬预算耗尽后保留失败，不把同一静态地图反复搜索到累计预算用完', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(40);
  t.after(() => ctx.memory.close());
  const resolve = walkCollisionProvider.resolve.bind(walkCollisionProvider);
  // 真实进入库的单次 geometry 工作上限，避免为测试硬预算而穷举数千节点。
  t.mock.method(walkCollisionProvider, 'resolve', (...args: Parameters<typeof resolve>) => {
    const result = resolve(...args);
    return result.kind === 'shape' && result.shape.boxes.length > 0
      ? { ...result, shape: { ...result.shape, boxes: Array.from({ length: 4097 }, () => result.shape.boxes[0]!) } }
      : result;
  });
  const controller = new AbortController();
  let invocations = 0, scans = 0;
  t.mock.method(lookAround, 'run', async () => { scans++; return { status: 'succeeded', summary: '已扫视' }; });
  const result = await exploreToward.run({ ...ctx, signal: controller.signal, setStationaryWait: (waiting) => {
    // 限制旧实现的错误重试，避免回归测试真的重复几十次重搜索。
    if (waiting && ++invocations > 1) controller.abort();
  } }, argsOf({ direction: 'E', distance: 48, segment: 32, maxLateralDrift: 24 }, adapter));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.lastSegment as { outcome: string }).outcome, 'search_budget');
  assert.equal((result.data?.stop as { reason: string }).reason, 'BUDGET_EXHAUSTED');
  assert.equal(invocations, 1, '搜索硬预算不是身体窗口，不自动续接同参数搜索');
  assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 0);
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(scans, 0);
});

test('until 在短未知前沿仍能通过本轮扫描发现目标', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(3);
  t.after(() => ctx.memory.close());
  let scans = 0;
  t.mock.method(lookAround, 'run', async (_ctx, args) => {
    scans++;
    assert.equal(args.direction, 'E');
    assert.equal(args.for, 'log');
    return { status: 'succeeded', summary: '本轮看见原木', data: { found: 'oak_log' } };
  });
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 48, segment: 16, until: 'log' }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.equal(scans, 1);
  assert.ok((result.data?.progress as { along: number }).along < 16);
  assert.equal(result.data?.arrived, false, '看到目标不冒充完成原距离');
});

test('未知边界停止，取消保留实测进度，均不转直接寻路', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(6);
  t.after(() => ctx.memory.close());
  t.mock.method(lookAround, 'run', async () => ({ status: 'failed', failureCode: 'NOT_FOUND', summary: '未见' }));
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 48 }, adapter));
  assert.equal(result.status, 'failed');
  assert.ok(adapter.pos.x < 10);
  assert.equal((result.data?.intent as { distance: number }).distance, 48);
  assert.ok(typeof result.data?.sessionId === 'string');

  const other = voxelNavigationFixture(30);
  t.after(() => other.ctx.memory.close());
  const controller = new AbortController(); controller.abort();
  const cancelled = await exploreToward.run({ ...other.ctx, signal: controller.signal }, argsOf({ direction: 'E', distance: 20 }, other.adapter));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(other.adapter.actions.length, 0);
});
