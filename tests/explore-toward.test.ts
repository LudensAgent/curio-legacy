import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { lookAround } from '../src/skills/movement.ts';
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

test('方向探索以同一体素 session 分段推进并扫视，预算累计', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(80);
  t.after(() => ctx.memory.close());
  let scans = 0;
  t.mock.method(lookAround, 'run', async () => { scans++; return { status: 'succeeded', summary: '已扫视' }; });
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 48, segment: 16 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.planner, 'voxel_astar');
  assert.equal(result.data?.backend, 'land-search');
  assert.equal((result.data?.intent as { distance: number }).distance, 48);
  assert.ok((result.data?.progress as { along: number }).along >= 48);
  assert.ok((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions >= 48);
  assert.ok(scans >= 3);
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