import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap, type PathFragment } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { planRoute, walkPath, clearRouteRecords } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';

function flatMap(nameAt: (x: number, y: number, z: number) => string, validityWindowMs = 60_000) {
  const map = new VoxelMap(WORLD, { validityWindowMs });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: nameAt(x, y, z), properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

function fakeSpatial(map: VoxelMap, fragments: Record<string, PathFragment> = {}) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: {
        worldId: WORLD,
        getFragment: (id: string) => fragments[id] ?? null,
        fragments: () => ({ items: Object.values(fragments), total: Object.keys(fragments).length }),
      },
    },
    closing: false, paused: false, observationAdmitted: true,
    attach: () => ({}),
    detach: () => {},
  } as unknown as SharedSpatialSession;
}

/** 测试用步行身体：按住 forward 时沿当前朝向每帧走一小步。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  /** 测试可直接改样本位置，用来制造与 state.pos 不一致的实测偏离。 */
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const k of Object.keys(this.control)) this.control[k] = false; },
      look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
      entity: this.walkEntity,
    };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({
          position: { ...this.walkEntity.position },
          velocity: { ...this.walkEntity.velocity },
          onGround: true,
          isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

function walkingAdapter() {
  const w = new WalkingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

function fragment(id: string, polyline: PathFragment['polyline'], kind: PathFragment['kind'] = 'dug'): PathFragment {
  return { id, worldId: WORLD, dim: DIM, kind, entrances: [], polyline, geometrySource: 'traversal', deepestY: polyline[0]!.y, createdAt: 1000, lastUsedAt: 1000, uses: 1 };
}

const walk = (to: { x: number; y: number; z: number }, source: 'auto' | 'search' | 'history' = 'search', more: Record<string, unknown> = {}) => ({
  to, mode: 'walk' as const, source, arrival: { kind: 'exact' as const }, ...more,
});

const assertedMoved = (w: WalkingAdapter) => assert.notEqual(w.control.forward, true, '拒绝执行时不能按前进键');

test('walk_path 单次消费 routeId，并返回完整终态信封', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  const pointCount = (planned.data?.points as unknown[]).length;

  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.navOutcome, 'ARRIVED');
  assert.equal(result.data?.confirmed, true);
  assert.equal(result.data?.routeKind, 'snapshot');
  assert.equal(result.data?.pathId, null);
  assert.equal(result.data?.backend, 'spatial_library');
  assert.equal(result.data?.confirmedSegments, pointCount - 1);
  assert.deepEqual(result.data?.remainingPoints, []);
  assert.deepEqual(result.data?.consumption, [], 'walk_path 不做挖/放，consumption 必须为空');
  assert.deepEqual(result.data?.requestedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(result.data?.resolvedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.data?.invalidation, undefined);
  assert.deepEqual(w.actions, [], '只走已规划路线，不挖/放');

  const positionAfter = { ...w.pos };
  const second = await walkPath.run(ctx, { routeId });
  assert.equal(second.status, 'failed');
  assert.equal(second.data?.outcome, 'INVALIDATED');
  assert.equal((second.data?.invalidation as { reason?: string }).reason, 'route_consumed');
  assert.equal(second.data?.confirmed, false);
  assert.deepEqual(w.pos, positionAfter, '重复 routeId 不得再次执行');
  assertedMoved(w);
});

test('候选计划 executable:false 在执行前拒绝，不写控制', async (t) => {
  const w = walkingAdapter();
  const frag = fragment('frag-candidate', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-candidate': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-candidate' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal(planned.data?.executable, false);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'route_not_executable', '注册表 consume 是唯一的可执行性边界');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_executable');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.plan, null, '注册表拒绝时没有计划可报');
  assert.equal(result.data?.remainingPoints, undefined);
  assert.equal(result.data?.confirmedSegments, undefined);
  assert.deepEqual(result.data?.consumption, []);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '拒绝执行时身体不动');
  assertedMoved(w);
});

test('过期 routeId 由注册表拒绝，不启动身体', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air', 500)) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_expired');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('session_reset 清空旧 routeId（route_not_found），每个适配器只订阅一次', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const first = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(first.status, 'succeeded', first.summary);
  const firstWalk = await walkPath.run(ctx, { routeId: String(first.data?.routeId) });
  assert.equal(firstWalk.status, 'succeeded', firstWalk.summary);

  const listeners = (w as unknown as { listenerCount(event: string): number }).listenerCount('session_reset');
  assert.equal(listeners, 1, '每个适配器只订阅一次 session_reset');

  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const second = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }));
  assert.equal(second.status, 'succeeded', second.summary);
  const routeId = String(second.data?.routeId);
  const position = { ...w.pos };

  w.emit('session_reset');
  w.sessionId = `${SESSION}-2`;
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found', '旧会话 routeId 必须直接失效，而不是只在作用域校验时报错');
  assert.deepEqual(w.pos, position);
  assertedMoved(w);
  assert.equal((w as unknown as { listenerCount(event: string): number }).listenerCount('session_reset'), 1, '重复执行不得重复订阅');
});

test('session_reset 即使 sessionId 未变也立即清空 routeId（隔离监听器本身）', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 先触发一次 walk_path 入口，让 session_reset 监听器注册；这里不消费真实计划。
  await walkPath.run(ctx, { routeId: 'unknown-route' });
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);

  // 只发事件、不动 state：若没有监听器，入口作用域对账会看到同一会话并放行。
  w.emit('session_reset');
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found', '监听器必须单独让旧 routeId 失效');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('换维度后旧 routeId 被拒绝，不跨维执行', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.dim = 'nether';

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('起点漂移 >0.05 返回 INVALIDATED，不启动身体', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.pos = { ...w.pos, x: w.pos.x + 0.2 };

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string; segment?: number }).reason, 'route_start_changed');
  assert.equal((result.data?.invalidation as { segment?: number }).segment, 0);
  assert.equal((result.data?.unsupported as { reason?: string }).reason, 'route_start_changed');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, { x: 0.7, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('历史路线执行用 plan.start 作为 body.feet（0.03 漂移仍可执行）', async (t) => {
  const w = walkingAdapter();
  const frag = fragment('frag-near', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-near': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-near' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal(planned.data?.executable, true);
  // 规划后脚位小幅漂移（≤0.05）；执行仍应从 plan.start 出发，否则 startKnownWalkRoute 会以 wrong_start 拒绝。
  w.pos = { ...w.pos, x: w.pos.x + 0.03 };

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.routeKind, 'known');
  assert.equal(result.data?.pathId, 'frag-near');
  assert.equal(result.data?.confirmed, true);
  assert.equal(result.data?.confirmedSegments, 2);
  assert.deepEqual(result.data?.remainingPoints, []);
});

test('历史路线执行不能读到规划几何之外的点（maxRoutePoints）', async (t) => {
  const w = walkingAdapter();
  const fragments: Record<string, PathFragment> = {
    'frag-short': fragment('frag-short', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]),
  };
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), fragments) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-short' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal((planned.data?.points as unknown[]).length, 3);

  // 规划后历史被改写为更长的 polyline：执行必须按计划点数拒绝，不能走超出规划几何的部分。
  fragments['frag-short'] = fragment('frag-short', [
    { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 },
    { x: 3.5, y: 64, z: 0.5 }, { x: 4.5, y: 64, z: 0.5 },
  ]);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'ERROR', '启动边界拒绝是执行错误，不是 TIMEOUT');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'unavailable');
  assert.match(String((result.data?.problem as { detail?: string } | undefined)?.detail), /route_budget/);
  assert.match(String(result.summary), /exceeding maxRoutePoints 3/);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.equal((result.data?.remainingPoints as unknown[]).length, 3);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '拒绝时不能读到规划外几何、也不能移动');
  assertedMoved(w);
});

test('执行中证据 TTL 失效映射为 INVALIDATED，保留实测位置', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air', 800)) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 4.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'route_invalidated');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_invalidated');
  assert.equal(result.data?.confirmed, false);
  const position = result.data?.position as { x: number; y: number; z: number } | null | undefined;
  assert.ok(position !== null && position !== undefined && [position.x, position.y, position.z].every((v) => Number.isFinite(v)), '失效时保留有限的实测位置');
  const segments = result.data?.confirmedSegments as number | undefined;
  assert.ok(Number.isInteger(segments) && (segments as number) >= 0, 'confirmedSegments 来自执行器终态的非负整数投影');
});

test('段级 STALE 证据映射为 INVALIDATED，而不是没路', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  // 规划后整段证据被标记 stale：执行器逐段复验应以 stale 终止，而不是当成世界无路。
  map.markStale(DIM, 'expired');

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'stale');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'stale');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '证据失效时不得移动');
  assertedMoved(w);
});

test('身体实测偏离规划路线映射为 PARTIAL', async (t) => {
  const w = walkingAdapter();
  // 适配器 state.pos 仍是规划起点（0.5），但物理样本在 0.9：执行器据此判定 deviation。
  w.walkEntity.position = { x: 0.9, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'PARTIAL', '偏离是部分进展，不是到达也不是没路');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'deviation');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.equal((result.data?.invalidation as { reason?: string } | undefined)?.reason, undefined, 'PARTIAL 不是 INVALIDATED');
});

test('当前证据阻塞映射为 BLOCKED，不移动', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  // 规划后把第一步的目的站立格变成石头：执行器复验应报 blocked，不能自行挖开或绕路。
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence: 10_000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x: 1, y: 64, z: 0 },
  });
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'BLOCKED');
  assert.equal(result.data?.navOutcome, 'BLOCKED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'blocked');
  assert.equal(result.data?.confirmed, false);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '阻塞时不得自动施工或移动');
  assertedMoved(w);
});
