import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { advance } from '../src/skills/movement/index.ts';
import { acquireSessionLease, clearMovementSessions, findMovementSession, releaseSessionLease } from '../src/skills/movement/session.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
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
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
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
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '只迈步，不挖/不放');
});

test('A1b 非格心起点 + maxLateralDrift 0：沿实测偏移连续推进，不被格心化偏移', async (t) => {
  const map = corridor(20);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.1 };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 8, maxLateralDrift: 0 }));

  assert.equal(r.status, 'succeeded', r.summary);
  const progress = r.data?.progress as { along: number; lateral: number };
  assert.ok(progress.along >= 7.99, `along=${progress.along}`);
  assert.ok(progress.lateral <= 0.01, `横向授权 0 时不得滑到格心：lateral=${progress.lateral}`);
  assert.ok(Math.abs(adapter.pos.z - 0.1) <= 0.01, `实际 z=${adapter.pos.z}`);
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '连续脚位执行，不经过格心 move_step');
});

test('A1c 实测横向 0.05 偏差不算授权：maxLateralDrift=0 时在第一步后停止，不再发下一段', async (t) => {
  const map = corridor(20);
  const adapter = new LateralDriftOnceWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.1 };
  const ctx: SkillCtx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const r = await advance.run(ctx, args({ direction: 'E', distance: 8, maxLateralDrift: 0 }));

  assert.equal(r.status, 'failed', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'LATERAL_DRIFT');
  assert.equal(adapter.actions.filter((action) => action === 'moveTo:feet').length, 1, '超授权后不再发下一段控制');
  assert.ok(Math.abs(adapter.pos.z - 0.15) <= 1e-9, `实测偏差保留：z=${adapter.pos.z}`);
  assert.equal((r.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 1, '已发生位移按实测确认并保留');
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

test('方向推进在已观测长上下坡完成 50 格，临时目标高度不截短前缀', async (t) => {
  for (const slope of [-1, 1]) {
    const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
    for (let x = -1; x <= 55; x++) for (let z = -1; z <= 1; z++) {
      const height = 64 + slope * Math.max(0, x);
      const cells = Array.from({ length: 15 }, (_, index) => ({ x, y: height - 6 + index, z }));
      fill(map, 'minecraft:stone', cells.filter((pos) => pos.y < height));
      fill(map, 'minecraft:air', cells.filter((pos) => pos.y >= height));
    }
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const result = await advance.run(ctx, args({ direction: 'E', distance: 50, maxStepsPerSegment: 32 }));
    assert.equal(result.status, 'succeeded', `${slope}: ${result.summary}`);
    assert.deepEqual(adapter.pos, { x: 50.5, y: 64 + slope * 50, z: 0.5 });
    assert.deepEqual(result.data?.frozenOrigin, { x: 0.5, y: 64, z: 0.5 });
    assert.equal((result.data?.lastSearch as { goalMetric: string }).goalMetric, 'horizontal');
    assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 50);
    assert.equal((result.data?.progress as { along: number }).along, 50);
  }
});

test('方向推进走到已知坡道的真实前沿，不在坡道中途声称未知边界', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  for (let x = -1; x <= 12; x++) for (let z = -1; z <= 1; z++) {
    const height = 64 - Math.max(0, x);
    const cells = Array.from({ length: 12 }, (_, index) => ({ x, y: height - 6 + index, z }));
    fill(map, 'minecraft:stone', cells.filter((pos) => pos.y < height));
    fill(map, 'minecraft:air', cells.filter((pos) => pos.y >= height));
  }
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const result = await advance.run(ctx, args({ direction: 'E', distance: 20, maxSegments: 1, maxStepsPerSegment: 16 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  assert.deepEqual(adapter.pos, { x: 12.5, y: 52, z: 0.5 });
  assert.equal((result.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 12);
  assert.equal((result.data?.progress as { along: number }).along, 12);
});

test('累计 transition 或搜索预算耗尽后不再承诺同一 session 可继续', async (t) => {
  // 搜索预算只计没有带来位移的搜索；有进展的委托不会因搜索次数被判为不可续接。
  for (const budget of [{ maxTransitions: 8 }]) {
    const { adapter, ctx } = setup(corridor(40));
    t.after(() => ctx.memory.close());
    const request = { direction: 'E', distance: 20, maxSegments: 1, maxStepsPerSegment: 8, ...budget };
    const first = await advance.run(ctx, args(request));
    assert.equal(first.status, 'failed', first.summary);
    const continuation = first.data?.continuation as { canContinue: boolean; sessionId?: string; requires: string[] };
    assert.equal(continuation.canContinue, false);
    assert.equal(continuation.sessionId, undefined);
    assert.match(continuation.requires.join(' '), /累计.*预算.*新建/);
    const moved = adapter.actions.length;
    const repeated = await advance.run(ctx, args({ ...request, sessionId: first.data?.sessionId }));
    assert.equal(repeated.status, 'failed');
    assert.equal(adapter.actions.length, moved, '硬预算不能通过续接重置');
    assert.equal((repeated.data?.continuation as { canContinue: boolean }).canContinue, false);
  }
});

test('A2b sessionId 只续接同一冻结意图；方向/距离改变返回 INTENT_MISMATCH', async (t) => {
  const map = corridor(40);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 20, maxSegments: 1, maxStepsPerSegment: 8, maxTransitions: 8 }));
  const sessionId = first.data?.sessionId;
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
  assert.ok(adapter.pos.x < 6, '没有穿过墙');
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '只迈步绕向前沿点，没有代挖/代放');
  assert.equal(JSON.stringify(adapter.state().inventory), inventory);
  assert.equal(typeof (r.data?.continuation as { canContinue: boolean }).canContinue, 'boolean', '回执说明能否续接');
});

test('A4b 单格宽阻挡：在 maxLateralDrift 内选择已验证的横向绕行', async (t) => {
  // 只堵住 z=0 的直行车道，z=±1 仍可走；air/ground 在同一格不能先记空气再记石头。
  const wall = (x: number, _y: number, z: number) => x >= 6 && x <= 8 && z === 0;
  const map = corridor(30, -1, [-1, 1], wall);
  fill(map, 'minecraft:stone', [6, 7, 8].flatMap((x) => [63, 64, 65, 66].map((y) => ({ x, y, z: 0 }))));
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20, maxLateralDrift: 1 }));

  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
  const progress = r.data?.progress as { along: number; lateral: number };
  assert.ok(progress.along >= 19.99, `along=${progress.along}`);
  assert.ok(progress.lateral <= 1.01, `final lateral=${progress.lateral}`);
  const counters = r.data?.counters as { confirmedRouteLength: number };
  // 绕过三格墙比直行 20 格长；斜向绕行比只横移更短（约 20 + 2(√2−1)）。
  assert.ok(counters.confirmedRouteLength > 20.5, `detour path=${counters.confirmedRouteLength}`);
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '绕行也只迈步，不挖/不放');
});

test('A4c 阻挡两侧先观察：侧向证据变化后选择已验证绕行', async (t) => {
  // 直行 z=0 有墙；z=±1 两侧未观察，但边界观察能看到并补进共享 VoxelMap。
  const skip = (x: number, _y: number, z: number) => (x >= 6 && x <= 8 && z === 0) || (x >= 5 && x <= 10 && z !== 0);
  const map = corridor(30, -1, [-1, 1], skip);
  fill(map, 'minecraft:stone', [6, 7, 8].flatMap((x) => [63, 64, 65, 66].map((y) => ({ x, y, z: 0 }))));
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  let observations = 0;
  ctx.senses.observeBlocks = (positions) => {
    // 只响应边界探针（同一 x/z 上同时有 y 与 y-1），不把 move_step 的局部反馈当成世界观察。
    if (!isBoundaryProbe(positions) || !positions.some((p) => p.z !== 0 && p.x >= 4 && p.x <= 11)) return [];
    observations += 1;
    const air: Vec3Like[] = [], ground: Vec3Like[] = [];
    for (let x = 4; x <= 12; x++) for (const z of [-1, 1]) {
      for (let y = 64; y <= 66; y++) air.push({ x, y, z });
      ground.push({ x, y: 63, z });
    }
    fill(map, 'minecraft:air', air);
    fill(map, 'minecraft:grass_block', ground);
    return positions.map((pos) => ({ pos, name: 'minecraft:air', properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const }));
  };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 20, maxLateralDrift: 1 }));

  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
  assert.ok(observations >= 1, '应先做边界侧向观察');
  assert.equal((r.data?.lastObservation as { relatedChanged: boolean }).relatedChanged, true);
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '绕行也只迈步，不挖/不放');
});

test('A4d 边界观察发现 3D 落点，沿已验证落差继续推进', async (t) => {
  // 上层脚高 64 到 x=5；下层地面 y=60（脚高 61）从 x=6 开始；共享地图尚未观察下层。
  const map = corridor(5, -1, [-1, 1]);
  class TwoLevelWorld extends FakeAdapter {
    override blockAt(pos: Vec3Like) {
      if (pos.x >= 6) return pos.y === 60 ? 'grass_block' : pos.y < 60 ? 'stone' : 'air';
      return pos.y === 63 ? 'grass_block' : pos.y < 63 ? 'stone' : 'air';
    }
    // descend_to 的 target 是连续站位；move_step 的 xyz 是方块格（FakeAdapter 会补到格心）。
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      if (target.kind === 'xyz' && (!Number.isInteger(target.x) || !Number.isInteger(target.z))) {
        this.actions.push('moveTo:xyz');
        this.pos = { x: target.x, y: target.y, z: target.z };
        return;
      }
      return super.moveTo(target, opts);
    }
  }
  const adapter = new TwoLevelWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx: SkillCtx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  ctx.senses.landingOptions = () => [{
    target: { x: 6.5, y: 61, z: 0.5 }, support: { pos: { x: 6, y: 60, z: 0 }, name: 'grass_block' },
    surface: 'ground', surfaceY: 61, horizontalDistance: 1, drop: 3, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: adapter.state().observationId, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  }];
  let revealed = false;
  ctx.senses.observeBlocks = (positions) => {
    if (!isBoundaryProbe(positions) || revealed) return [];
    revealed = true;
    const air: Vec3Like[] = [], ground: Vec3Like[] = [];
    for (let x = 6; x <= 20; x++) for (let z = -1; z <= 1; z++) {
      for (let y = 61; y <= 66; y++) air.push({ x, y, z });
      ground.push({ x, y: 60, z });
    }
    fill(map, 'minecraft:air', air);
    fill(map, 'minecraft:grass_block', ground);
    return positions.map((pos) => ({ pos, name: 'minecraft:air', properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const }));
  };
  const r = await advance.run(ctx, args({ direction: 'E', distance: 12 }));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
  assert.ok(Math.abs(adapter.pos.y - 61) <= 0.01, `final y=${adapter.pos.y}`);
  const observation = r.data?.lastObservation as { landingCandidates?: unknown[] } | undefined;
  assert.ok(observation?.landingCandidates?.length, '边界观察应带可见落点候选');
});

/** 第一次连续脚位移动产生 0.05 横向偏差：到达容差不能被当成走廊授权。 */
class LateralDriftOnceWorld extends FakeAdapter {
  drifted = false;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (target.kind === 'feet' && !this.drifted) {
      this.drifted = true;
      this.pos = { ...this.pos, z: this.pos.z + 0.05 };
    }
  }
}

class PartialMoveWorld extends FakeAdapter {
  failed = false;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'feet' && !this.failed) {
      this.failed = true;
      this.pos = { ...this.pos, x: this.pos.x + 0.5 };
      throw Object.assign(new Error('partial move timeout'), { name: 'TimeoutError' });
    }
    return super.moveTo(target, opts);
  }
}

test('A19 move_step 部分位移：身体仍站在地上时从实测位置重新规划，一次失败不结束整趟委托', async (t) => {
  const map = corridor(30);
  const adapter = new PartialMoveWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx: SkillCtx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const first = await advance.run(ctx, args({ direction: 'E', distance: 20 }));

  assert.ok(adapter.failed, '确实发生过一次部分位移失败');
  assert.equal(first.status, 'succeeded', first.summary);
  assert.ok(Math.floor(adapter.pos.x) >= 20);
});

test('最后下落虽已达到方向距离，仍须真实落地才能完成并关闭 session', async (t) => {
  for (const throws of [false, true]) {
    const map = corridor(7);
    fill(map, 'minecraft:grass_block', [8, 9, 10].flatMap((x) => [-1, 0, 1].map((z) => ({ x, y: 60, z }))));
    fill(map, 'minecraft:air', [8, 9, 10].flatMap((x) => [-1, 0, 1].flatMap((z) =>
      [61, 62, 63, 64, 65, 66].map((y) => ({ x, y, z })))));
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    let moves = 0;
    t.mock.method(adapter, 'moveTo', async (target) => {
      assert.equal(target.kind, 'feet');
      if (target.kind !== 'feet') return;
      moves += 1;
      adapter.pos = { x: target.x, y: target.y, z: target.z };
      if (target.x === 8.5) {
        assert.equal(target.y, 61, '最后一步确实是已规划的三格下落');
        adapter.pos.y = 62.5;
        adapter.onGround = false;
        if (throws) throw Object.assign(new Error('drop still airborne'), { name: 'TimeoutError' });
      }
    });
    const first = await advance.run(ctx, args({ direction: 'E', distance: 8 }));
    assert.equal(first.status, 'failed', first.summary);
    assert.equal((first.data?.stop as { reason: string }).reason, 'PHYSICAL_FAILURE');
    assert.equal((first.data?.progress as { along: number }).along, 8, '保留已发生的水平位移');
    assert.deepEqual(first.data?.position, { x: 8.5, y: 62.5, z: 0.5 });
    assert.equal((first.data?.partialDisplacement as { atTarget: boolean }).atTarget, false);
    assert.equal((first.data?.counters as { confirmedTransitions: number }).confirmedTransitions, 7);
    assert.equal(moves, 8);
    const sessionId = (first.data?.continuation as { sessionId?: string }).sessionId;
    assert.ok(sessionId, '悬空失败不能提前关闭冻结意图');

    adapter.pos.y = 61;
    adapter.onGround = true;
    const landed = await advance.run(ctx, args({ direction: 'E', distance: 8, sessionId }));
    assert.equal(landed.status, 'succeeded', landed.summary);
    assert.equal((landed.data?.stop as { reason: string }).reason, 'DISTANCE_MET');
    const measured = landed.data?.measured as { current: Vec3Like; onGround: boolean };
    assert.deepEqual(measured.current, { x: 8.5, y: 61, z: 0.5 });
    assert.equal(measured.onGround, true);
    assert.equal(moves, 8, '实测落地后确认完成，不再多走一步');
  }
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
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'));
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
  // 没有相关证据变化时，停下前只会绕向尚未试过的前沿点；搜索次数受绕行上限约束，不会无限重搜。
  assert.ok(counters.searches <= 1 + 4 * 4, `搜索次数 ${counters.searches}`);
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

test('前方有墙：像 pathfinder 一样先走到离目标最近的已达格，不在原地停下', async (t) => {
  const map = corridor(8, -1, [-3, 3]);
  // x=9 整面墙，墙后未知；走廊内全部已观测。
  fill(map, 'minecraft:netherrack', [-3, -2, -1, 0, 1, 2, 3].flatMap((z) => [63, 64, 65, 66, 67].map((y) => ({ x: 9, y, z }))));
  fill(map, 'minecraft:netherrack', [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((x) => [-4, 4].flatMap((z) => [63, 64, 65, 66].map((y) => ({ x, y, z })))));
  fill(map, 'minecraft:netherrack', [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((x) => [-3, -2, -1, 0, 1, 2, 3].map((z) => ({ x, y: 67, z }))));
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const result = await advance.run(ctx, args({ direction: 'E', distance: 32, maxLateralDrift: 4 }));
  assert.ok(Math.floor(adapter.pos.x) >= 7, `走到墙跟前（实测 x=${adapter.pos.x.toFixed(2)}）：${result.summary}`);
});
