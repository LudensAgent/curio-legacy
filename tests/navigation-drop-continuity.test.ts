import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { MoveOpts, Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { feetGoal } from '../src/skills/movement/goal.ts';
import { runNavigationSegment } from '../src/skills/movement/segment.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

function setup() {
  const adapter = new FakeAdapter();
  adapter.pos = { x: -495.37228723784824, y: 99.9375, z: -291.4394734980101 };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 60_000 });
  let sequence = 0;
  const observe = (pos: Vec3Like, name: string) => map.observe({
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
    observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name, properties: {} }, pos,
  });
  for (let x = -498; x <= -490; x++) for (let z = -294; z <= -289; z++) for (let y = 96; y <= 103; y++) {
    const surface = x <= -495 ? 99 : 97;
    observe({ x, y, z }, y === surface ? 'dirt_path' : y < surface ? 'stone' : 'air');
  }
  const spatial = {
    worldId: adapter.worldId, session: { voxel: map }, closing: false, paused: false, observationAdmitted: true,
  } as unknown as SharedSpatialSession;
  const ctx = { ...makeCtx(adapter), spatial };
  const to = { x: adapter.pos.x + 3, y: 97.9375, z: adapter.pos.z };
  const request = {
    goal: feetGoal(to), allowed: ['walk', 'step', 'drop'] as ('walk' | 'step' | 'drop')[], historical: false,
    maxTransitions: 8, allowUnknownCorridor: false, deadline: ctx.deadline, searchBudget: 2,
    corridor: { origin: { ...adapter.pos }, bearing: { x: 1, z: 0 }, maxLateral: 0.1 },
  };
  return { adapter, ctx, observe, to, request };
}

test('travel_to traverses a non-centred two-block dirt_path drop and continues on the frozen route', async (t) => {
  const { adapter, ctx, to } = setup();
  t.after(() => ctx.memory.close());
  Object.assign(adapter, { settleMovement: async () => assert.fail('大落差各端点完整停稳，不需要中间交接收尾') });
  const calls: { target: Vec3Like; opts: MoveOpts }[] = [];
  t.mock.method(adapter, 'moveTo', async (target, opts) => {
    assert.equal(target.kind, 'feet');
    if (target.kind !== 'feet') return;
    calls.push({ target: { x: target.x, y: target.y, z: target.z }, opts });
    adapter.pos = { x: target.x - 0.0324, y: target.y, z: target.z + 0.00015 };
  });
  const destination = { ...to, x: to.x + 1 };
  const validated = travelTo.validate({ to: destination, range: 1 }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await travelTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.opts.maxDropDown === 4), '允许 drop 时每段的实测落差上限与搜索一致（4 格），滑下边缘不在半空判失败');
  assert.ok(calls.every(call => call.opts.settleAtTarget === undefined), '大落差及其前一段仍使用完整停稳');
  assert.deepEqual(calls[1]!.target, { x: to.x - 1, y: 97.9375, z: to.z });
  assert.deepEqual(calls.at(-1)!.target, to, '落点不改成格心，不让实测残差累计到后续计划');
  assert.deepEqual(result.data?.resolvedTarget, destination, '进入原目标 range 后停下，仍保留原目标');
  assert.equal((result.data?.counters as { searches: number }).searches, 1);
  assert.deepEqual(result.data?.position, adapter.pos);
});

test('连续 drop 在上一段之后重新检查实际通道，不执行刚出现的碰撞', async (t) => {
  const { adapter, ctx, observe, request } = setup();
  t.after(() => ctx.memory.close());
  let moves = 0;
  t.mock.method(adapter, 'moveTo', async (target) => {
    assert.equal(target.kind, 'feet');
    if (target.kind !== 'feet') return;
    moves++;
    adapter.pos = { x: target.x - 0.0324, y: target.y, z: target.z + 0.00015 };
    observe({ x: -494, y: 99, z: -292 }, 'stone');
  });
  const result = await runNavigationSegment(ctx, request);
  assert.equal(result.outcome, 'blocked', result.detail);
  assert.equal(result.currentCheck?.status, 'BLOCKED');
  assert.equal(moves, 1);
  assert.equal(result.confirmed.length, 1);
});

test('连续 drop 拒绝 Promise 成功但仍在空中的身体，也保留取消位移', async (t) => {
  for (const cancelled of [false, true]) {
    const { adapter, ctx, request } = setup();
    t.after(() => ctx.memory.close());
    let moves = 0;
    t.mock.method(adapter, 'moveTo', async (target) => {
      assert.equal(target.kind, 'feet');
      if (target.kind !== 'feet') return;
      adapter.pos = { x: target.x, y: target.y, z: target.z };
      if (++moves === 2) {
        adapter.onGround = false;
        if (cancelled) throw new AbortedError('cancel during continuous drop');
      }
    });
    const result = await runNavigationSegment(ctx, request);
    assert.equal(result.outcome, cancelled ? 'cancelled' : 'physical_failure', result.detail);
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.partialDisplacement?.atTarget, false);
    assert.deepEqual(result.measuredEnd, adapter.pos);
    assert.equal(moves, 2);
  }
});

test('连续多格 drop 保留既有生命余量门槛', async (t) => {
  const { adapter, ctx, request } = setup();
  t.after(() => ctx.memory.close());
  adapter.hp = 7;
  let moves = 0;
  t.mock.method(adapter, 'moveTo', async (target) => {
    if (target.kind !== 'feet') return;
    moves++;
    adapter.pos = { x: target.x, y: target.y, z: target.z };
  });
  const result = await runNavigationSegment(ctx, request);
  assert.equal(result.failureCode, 'LOW_HP');
  assert.equal(result.confirmed.length, 1);
  assert.equal(moves, 1);
});
