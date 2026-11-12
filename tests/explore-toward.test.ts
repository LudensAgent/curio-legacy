import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { lookAround } from '../src/skills/movement.ts';
import { walkCollisionProvider } from '../src/adapter/walk-collision.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';
import { SUSPEND_ABORT_REASON } from '../src/util.ts';

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

test('方向探索跨四个规划窗口沿冻结方向推进 64 格，途中不为窗口停下扫视', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  const scan = t.mock.method(lookAround, 'run', async () => { throw Error('走已知走廊无需扫视'); });
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
  assert.equal(scan.mock.callCount(), 0);
  assert.ok(adapter.actions.every((action) => !/^moveTo:(xz|near|advance)/.test(action)));
});

test('until 在行走中首次亲眼看到时停步；前视帧中的旧候选须重新可见', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  const pos = { x: 13, y: 65, z: 0 };
  adapter.blocks.push({ name: 'oak_log', pos });
  const observe = ctx.senses.observeBlocks!;
  const scan = t.mock.method(lookAround, 'run', async () => { throw Error('已看见目标不需要转头'); });
  ctx.senses.currentBlockCandidates = () => [{ name: 'oak_log', pos }];
  ctx.senses.knownBlocks = () => { throw Error('行走时不应遍历所有历史目标'); };
  ctx.senses.observeBlocks = positions => adapter.pos.x >= 7.5 ? observe(positions) : [];
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, segment: 16, until: 'log' }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(adapter.pos.x, 7.5, '第七步即可看到，不能继续走到16步前瞻末端');
  assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 7);
  assert.deepEqual(result.data?.foundRef, { kind: 'block', pos });
  assert.equal(result.data?.source, 'current_vision');
  assert.equal(result.data?.arrived, false);
  assert.equal((result.data?.intent as { distance: number }).distance, 64);
});

test('带 until 在达到距离时仍检查当前视野，听声或背后的目标不会提前触发', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(20);
  t.after(() => ctx.memory.close());
  const scan = t.mock.method(lookAround, 'run', async () => { throw Error('达到冻结距离时不为扫描转头'); });
  ctx.senses.perceivedEntities = () => [
    { id: 17, name: 'cow', kind: 'passive', pos: { x: -2, y: 64, z: 0 }, dist: 6, perception: 'seen' },
    { id: 23, name: 'cow', kind: 'passive', pos: { x: 19, y: 64, z: 0 }, dist: 3, perception: adapter.pos.x >= 16.5 ? 'seen' : 'heard' },
  ];
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, segment: 16, until: 'cow' }, adapter));
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.deepEqual(result.data?.foundRef, { kind: 'entity', id: 23, name: 'cow' });
  assert.equal(result.data?.foundEntityId, 23);
  assert.equal((result.data?.progress as { along: number }).along, 16);
});

test('当前已看见 until 时直接按视野收工；读已完成会话不伪造本轮目击', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(0);
  t.after(() => ctx.memory.close());
  ctx.senses.perceivedEntities = () => [{ id: 37, name: 'cow', kind: 'passive', pos: { x: 4, y: 64, z: 0 }, dist: 4, perception: 'seen' }];
  const first = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, until: 'cow' }, adapter));
  assert.equal(first.data?.stopReason, 'UNTIL_SEEN');
  assert.equal(first.data?.foundEntityId, 37);
  ctx.senses.perceivedEntities = () => [];
  const resumed = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, until: 'cow', sessionId: first.data?.sessionId }, adapter));
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.data?.sighting, undefined);
  assert.equal(resumed.data?.found, undefined);
  assert.deepEqual(adapter.actions, []);
});

test('前方真实射线看到普通方块时也可作为 until，不要求它已进资源记忆', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(20);
  t.after(() => ctx.memory.close());
  const pos = { x: 4, y: 65, z: 0 };
  adapter.blocks.push({ name: 'red_wool', pos });
  const senses = new Vision(adapter);
  senses.scan();
  assert.equal(senses.seenAt(pos), 'red_wool');
  assert.deepEqual(senses.knownBlocks(['red_wool'], 96), []);
  const result = await exploreToward.run({ ...ctx, senses }, argsOf({ direction: 'E', distance: 16, until: 'red_wool' }, adapter));
  assert.equal(result.data?.stopReason, 'UNTIL_SEEN');
  assert.deepEqual(result.data?.foundRef, { kind: 'block', pos });
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
});

test('途中看见目标时仍要释放控制并确认停稳，超时不能报成功', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(32);
  t.after(() => ctx.memory.close());
  const settle = t.mock.fn(async () => { throw Error('TIMEOUT: no stop confirmation'); });
  Object.assign(adapter, { settleMovement: settle });
  ctx.senses.perceivedEntities = () => adapter.pos.x < 3.5 ? []
    : [{ id: 32, name: 'cow', kind: 'passive', pos: { x: 8, y: 64, z: 0 }, dist: 4, perception: 'seen' }];
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 32, until: 'cow' }, adapter));
  assert.equal(settle.mock.callCount(), 1);
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal((result.data?.stop as { reason: string }).reason, 'TIMEOUT');
  assert.equal(adapter.pos.x, 3.5);
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

test('显式挂起保留原方向、距离与累计预算，回来可续接同一 session', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  const move = adapter.moveTo.bind(adapter);
  const controller = new AbortController();
  let moves = 0;
  t.mock.method(adapter, 'moveTo', async (...args: Parameters<FakeAdapter['moveTo']>) => {
    const result = await move(...args);
    if (++moves === 3) controller.abort(SUSPEND_ABORT_REASON);
    return result;
  });
  const first = await exploreToward.run({ ...ctx, signal: controller.signal },
    argsOf({ direction: 'E', distance: 64, segment: 16 }, adapter));
  assert.equal(first.status, 'cancelled', first.summary);
  assert.equal((first.data?.stop as { reason: string }).reason, 'SUSPENDED');
  assert.equal((first.data?.continuation as { canContinue: boolean }).canContinue, true);
  const sessionId = first.data?.sessionId;
  assert.equal(typeof sessionId, 'string');
  const before = { ...adapter.pos };

  const resumed = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 64, segment: 16, sessionId }, adapter));
  assert.equal(resumed.status, 'succeeded', resumed.summary);
  assert.equal(resumed.data?.sessionId, sessionId);
  assert.deepEqual(resumed.data?.frozenOrigin, { x: 0.5, y: 64, z: 0.5 }, '原起点不变');
  assert.deepEqual((resumed.data?.intent as { direction: string; distance: number }).direction, 'E');
  assert.equal((resumed.data?.intent as { distance: number }).distance, 64);
  assert.equal((resumed.data?.progress as { along: number }).along, 64);
  assert.ok(adapter.pos.x > before.x, '续接从暂停时的实测位置继续，而不是从头走');
  assert.deepEqual(adapter.pos, { x: 64.5, y: 64, z: 0.5 });
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
