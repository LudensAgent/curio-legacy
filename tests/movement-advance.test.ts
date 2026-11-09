import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { advance } from '../src/skills/movement/index.ts';
import { acquireSessionLease, clearMovementSessions, findMovementSession, releaseSessionLease } from '../src/skills/movement/session.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(map: VoxelMap, name: string, cells: Vec3Like[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** 一条沿 +X 的已观测走廊：z∈[-1,1]，y=63 地面、y=64..66 空气。 */
function corridor(maxX: number, minX = -1, zRange: [number, number] = [-1, 1], skip: (x: number, y: number, z: number) => boolean = () => false) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [], ground: Vec3Like[] = [];
  for (let x = minX; x <= maxX; x++) for (let z = zRange[0]; z <= zRange[1]; z++) {
    for (let y = 64; y <= 66; y++) if (!skip(x, y, z)) air.push({ x, y, z });
    if (!skip(x, 63, z)) ground.push({ x, y: 63, z });
  }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', ground);
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}


/** 边界探针会在同一 x/z 上同时请求 y-1/y/y+1；move_step 的 localMap 反馈是整行同 y，可据此区分。 */
const isBoundaryProbe = (positions: Vec3Like[]) => positions.some((a) => positions.some((b) => a.x === b.x && a.z === b.z && a.y === b.y - 1));

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx: SkillCtx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

function args(raw: Record<string, unknown>) {
  const validation = advance.validate(raw, new FakeAdapter());
  assert.equal(validation.ok, true, validation.ok ? '' : validation.error);
  return validation.ok ? validation.args : ({} as never);
}

test.beforeEach(() => clearMovementSessions());

test('A1 开阔地 20 格：单次 advance 完成，实测 along 达标，frozenOrigin 不变', async (t) => {
  const map = corridor(30);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const origin = { ...adapter.pos };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20 }));

  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.stop && (r.data.stop as { reason: string }).reason, 'DISTANCE_MET');
  const progress = r.data?.progress as { along: number; lateral: number; horizontalNet: number };
  assert.ok(progress.along >= 19.99, `along=${progress.along}`);
  assert.equal(progress.lateral, 0);
  assert.ok(Math.abs(progress.horizontalNet - progress.along) < 0.01);
  assert.deepEqual(r.data?.frozenOrigin, origin, '冻结起点不可变');
  assert.deepEqual((r.data?.intent as { direction: string; distance: number }), {
    kind: 'advance', direction: 'E', distance: 20, maxLateralDrift: 4, allowed: ['walk', 'step', 'drop'], historical: true,
  });
  assert.equal((r.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 20);
  assert.equal(Math.floor(adapter.pos.x), 20);
  assert.equal((r.data?.continuation as { canContinue: boolean }).canContinue, false);
  assert.ok(adapter.actions.every((action) => action === 'moveTo:xyz'), '只迈步，不挖/不放');
});

test('A2 开阔地 50 格：两次调用同一 session 完成，累计预算不重置', async (t) => {
  const map = corridor(60);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 50, maxSegments: 2, maxStepsPerSegment: 16, maxTransitions: 64 }));
  assert.equal(first.status, 'failed', first.summary);
  assert.equal((first.data?.stop as { reason: string }).reason, 'BUDGET_EXHAUSTED');
  const continuation = first.data?.continuation as { canContinue: boolean; sessionId?: string };
  assert.equal(continuation.canContinue, true);
  assert.ok(continuation.sessionId);
  const sessionId = continuation.sessionId!;
  const alongFirst = (first.data?.progress as { along: number }).along;
  assert.ok(alongFirst >= 31.9, `第一段 along=${alongFirst}`);
  const confirmedFirst = (first.data?.counters as { confirmedTransitions: number }).confirmedTransitions;

  const second = await advance.run(ctx, args({
    direction: 'E', distance: 50, sessionId, maxSegments: 2, maxStepsPerSegment: 16, maxTransitions: 64,
  }));
  assert.equal(second.status, 'succeeded', second.summary);
  assert.equal((second.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
  assert.equal(second.data?.sessionId, sessionId, '续接同一 session');
  const counters = second.data?.counters as { confirmedTransitions: number; segments: number };
  assert.ok(counters.confirmedTransitions >= 50, `累计确认 ${counters.confirmedTransitions}`);
  assert.ok(counters.confirmedTransitions > confirmedFirst, '累计预算与计数不被续接重置');
  assert.ok(Math.floor(adapter.pos.x) >= 50);
});

test('A2b sessionId 只续接同一冻结意图；方向/距离改变返回 INTENT_MISMATCH', async (t) => {
  const map = corridor(40);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 20, maxSegments: 1, maxStepsPerSegment: 8, maxTransitions: 8 }));
  const sessionId = (first.data?.continuation as { sessionId: string }).sessionId;
  const changed = await advance.run(ctx, args({ direction: 'E', distance: 24, sessionId }));
  assert.equal(changed.status, 'failed');
  assert.equal(changed.failureCode, 'BAD_ARGS');
  assert.match(changed.summary, /不匹配/);
  assert.equal((changed.data?.reason as string), 'INTENT_MISMATCH');
});

test('A4 两格高墙：停在墙前报 BLOCKED，不挖、不改目标', async (t) => {
  // 墙体格从一开始就是石头：同一格先记空气再记石头会被 VoxelMap 标成冲突/STALE。
  const map = corridor(12, -1, [-1, 1], (x) => x >= 6 && x <= 11);
  fill(map, 'minecraft:stone', [6, 7, 8, 9, 10, 11].flatMap((x) =>
    [-1, 0, 1].flatMap((z) => [63, 64, 65, 66].map((y) => ({ x, y, z })))));
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const inventory = JSON.stringify(adapter.state().inventory);
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20 }));

  assert.equal(r.status, 'failed', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'BLOCKED');
  assert.equal((r.data?.intent as { distance: number }).distance, 20, '冻结意图不变');
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 }, '已知阻挡方向不自动前进');
  assert.equal(adapter.actions.length, 0, '没有代挖/代放');
  assert.equal(JSON.stringify(adapter.state().inventory), inventory);
  assert.equal((r.data?.continuation as { canContinue: boolean }).canContinue, true, '清障后可用同一 session 续接');
});

test('A5 UNKNOWN 边界链：定向观察、相关证据变化、重搜并继续', async (t) => {
  const map = corridor(9);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  let frontier = 9;
  const reveal = () => {
    const upto = frontier + 6;
    const air: Vec3Like[] = [], ground: Vec3Like[] = [];
    for (let x = frontier + 1; x <= upto; x++) for (let z = -1; z <= 1; z++) {
      for (let y = 64; y <= 66; y++) air.push({ x, y, z });
      ground.push({ x, y: 63, z });
    }
    fill(map, 'minecraft:air', air);
    fill(map, 'minecraft:grass_block', ground);
    frontier = upto;
  };
  ctx.senses.observeBlocks = (positions) => {
    // 只模拟“定向观察边界”：move_step 的 localMap 反馈不是新的世界观测。
    if (!isBoundaryProbe(positions)) return [];
    reveal();
    return positions.map((pos) => ({ pos, name: 'minecraft:air', properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const }));
  };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20, historical: false }));

  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
  const counters = r.data?.counters as { observations: number; confirmedTransitions: number };
  assert.ok(counters.observations >= 1, `observations=${counters.observations}`);
  assert.equal(counters.confirmedTransitions, 20);
  const observation = r.data?.lastObservation as { relatedChanged: boolean } | undefined;
  assert.equal(observation?.relatedChanged, true, '相关边界证据变化后才重搜');
  assert.ok(adapter.actions.every((action) => action === 'moveTo:xyz'));
});

test('A6 无关格新增观测：不触发重搜', async (t) => {
  const map = corridor(5);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  ctx.senses.observeBlocks = (positions) => {
    if (!isBoundaryProbe(positions)) return [];
    // 模拟视野里只看到与当前边界无关的 z=6 一带；边界相关格仍不可见。
    const air: Vec3Like[] = [], ground: Vec3Like[] = [];
    for (let x = 0; x <= 5; x++) for (let z = 6; z <= 8; z++) {
      air.push({ x, y: 64, z }, { x, y: 65, z });
      ground.push({ x, y: 63, z });
    }
    fill(map, 'minecraft:air', air);
    fill(map, 'minecraft:grass_block', ground);
    return [];
  };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20, historical: false, maxSegments: 4 }));

  assert.equal(r.status, 'failed', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  const observation = r.data?.lastObservation as { relatedChanged: boolean; newObservedCells: number };
  assert.equal(observation.relatedChanged, false);
  assert.ok(observation.newObservedCells > 0, '确实新增了观测格');
  const counters = r.data?.counters as { searches: number; segments: number };
  assert.equal(counters.searches, 1, '没有相关证据变化就不得重搜');
  assert.equal(counters.segments, 1);
});

test('A16 取消：停止身体动作，无后台移动，保留实测位置', async (t) => {
  const map = corridor(30);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const controller = new AbortController();
  controller.abort();
  const r = await advance.run({ ...ctx, signal: controller.signal }, args({ direction: 'E', distance: 20 }));

  assert.equal(r.status, 'cancelled', r.summary);
  assert.deepEqual(r.data?.position, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(adapter.actions.length, 0, '取消后没有身体动作');
  const continuation = r.data?.continuation as { canContinue: boolean };
  assert.equal(continuation.canContinue, false);
});

test('A17 换维/scope 改变：旧 session 失效，不跨 scope 续接', async (t) => {
  const map = corridor(40);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 40, maxSegments: 1, maxStepsPerSegment: 8, maxTransitions: 64 }));
  const sessionId = (first.data?.continuation as { sessionId: string }).sessionId;

  adapter.dim = 'the_nether';
  const moved = await advance.run(ctx, args({ direction: 'E', distance: 40, sessionId }));
  assert.equal(moved.status, 'failed');
  assert.equal(moved.failureCode, 'WRONG_DIMENSION');
  assert.match(moved.summary, /作用域|scope|不一致/);
  const session = findMovementSession(sessionId);
  assert.equal(session?.stop?.reason, 'SCOPE_CHANGED');
  adapter.dim = DIM;
  const again = await advance.run(ctx, args({ direction: 'E', distance: 40, sessionId }));
  assert.equal(again.status, 'failed', '旧 session 不能跨 scope 复用');
});

test('A18 同一 session 的并发执行租约：第二个 invocation 被拒绝', async (t) => {
  const map = corridor(40);
  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 40, maxSegments: 1, maxStepsPerSegment: 8, maxTransitions: 64 }));
  const sessionId = (first.data?.continuation as { sessionId: string }).sessionId;
  const session = findMovementSession(sessionId)!;
  assert.equal(acquireSessionLease(session, 'other-invocation'), true);
  try {
    const busy = await advance.run(ctx, args({ direction: 'E', distance: 40, sessionId }));
    assert.equal(busy.status, 'failed');
    assert.equal((busy.data?.reason as string), 'BUSY');
  } finally {
    releaseSessionLease(session, 'other-invocation');
  }
  const resumed = await advance.run(ctx, args({ direction: 'E', distance: 40, sessionId, maxSegments: 8, maxTransitions: 64 }));
  assert.equal(resumed.status, 'succeeded', resumed.summary);
});

test('advance 参数校验：拒绝对角线、区域/until 与越界距离', () => {
  const adapter = new FakeAdapter();
  for (const raw of [
    { direction: 'NE', distance: 20 },
    { direction: 'E', distance: 2 },
    { direction: 'E', distance: 20, region: { center: { x: 0, y: 64, z: 0 }, radius: 8 } },
    { direction: 'E', distance: 20, until: 'oak_log' },
    { direction: 'E', distance: 20, allowed: ['walk', 'dig'] },
  ]) {
    assert.equal(advance.validate(raw, adapter).ok, false, JSON.stringify(raw));
  }
  assert.equal(advance.validate({ direction: 'E', distance: 20 }, adapter).ok, true);
});
