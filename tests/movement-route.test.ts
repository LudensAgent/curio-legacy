import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap, type PathFragment } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { planRoute, resolveTarget, walkPath, clearRouteRecords } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';

function flatMap(nameAt: (x: number, y: number, z: number) => string) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
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
    capabilities: () => ({
      owner: 'host_composed',
      contract: 'memory-host-contract/1',
      library: { execute: { walk: true } },
      host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
    attach: () => ({}),
    detach: () => {},
    recordWalkCorridor: (input: { fragment: PathFragment; segments: readonly unknown[] }) => ({
      status: 'written' as const, fragmentId: input.fragment.id,
      traversalIds: input.segments.map((_, i) => `offline-${i}`), stancesMarked: input.segments.length, deliveryError: null,
    }),
  } as unknown as SharedSpatialSession;
}

/** 测试用步行身体：按住 forward 时沿当前朝向每帧走一小步。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  private walkEntity = {
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

function flatAdapter() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

test('resolve_target 解析坐标、方向和地标，只读不动', async (t) => {
  const w = flatAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const point = await resolveTarget.run(ctx, { target: '3,64,-2' });
  assert.equal(point.status, 'succeeded', point.summary);
  assert.deepEqual(point.data?.target, { x: 3, y: 64, z: -2 });
  assert.equal(point.data?.kind, 'point');

  const horizontal = await resolveTarget.run(ctx, { target: '3,-2' });
  assert.equal(horizontal.status, 'succeeded', horizontal.summary);
  assert.equal(horizontal.data?.horizontalOnly, true);
  assert.equal((horizontal.data?.target as { y: number }).y, 64);

  const heading = await resolveTarget.run(ctx, { target: 'E 10' });
  assert.equal(heading.status, 'succeeded', heading.summary);
  assert.equal((heading.data?.target as { x: number }).x, 11);
  assert.equal(heading.data?.kind, 'heading');

  ctx.memory.addLandmark('discovery', '小屋', DIM, { x: 5, y: 64, z: 0 });
  const landmark = await resolveTarget.run(ctx, { target: '小屋' });
  assert.equal(landmark.status, 'succeeded', landmark.summary);
  assert.deepEqual(landmark.data?.target, { x: 5, y: 64, z: 0 });
  assert.equal(landmark.data?.source, 'memory');

  const missing = await resolveTarget.run(ctx, { target: '不存在的地方' });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.deepEqual(w.actions, [], 'resolve_target 不移动');
});

test('resolve_target 拒绝超过单次上限的方向，不缩短目标', () => {
  const w = flatAdapter();
  const v = resolveTarget.validate({ target: 'E 201' }, w);
  assert.equal(v.ok, false);
  assert.match(!v.ok ? v.error : '', /超过单次上限/);
});

test('plan_route 没有共享空间会话时明确失败，不回退 pathfinder', async (t) => {
  const w = flatAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await planRoute.run(ctx, { to: { x: 2, y: 64, z: 0 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_CONNECTED');
  assert.deepEqual(w.actions, []);
});

test('plan_route 参数边界：非 walk、near、非空 avoid、未知字段都拒绝', () => {
  const w = flatAdapter();
  assert.equal(planRoute.validate({ to: { x: 1, y: 64, z: 0 }, mode: 'swim' }, w).ok, false);
  assert.equal(planRoute.validate({ to: { x: 1, y: 64, z: 0 }, arrival: { kind: 'near', radius: 2 } }, w).ok, false);
  assert.equal(planRoute.validate({ to: { x: 1, y: 64, z: 0 }, constraints: { avoid: ['lava'] } }, w).ok, false);
  assert.equal(planRoute.validate({ to: { x: 1, y: 64, z: 0 }, nope: true }, w).ok, false);
});

test('plan_route source:"search" 用 WalkRouteSearch 返回候选路线，规划阶段零移动', async (t) => {
  const w = flatAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(r.data?.confidence === 'verified' || r.data?.confidence === 'candidate');
  assert.ok((r.data?.points as unknown[]).length >= 2);
  assert.match(String(r.data?.routeId), /^rt_/);
  assert.match(r.summary, /walk_path/, 'search 结果要明确下一步是 walk_path');
  assert.deepEqual(w.actions, []);
});

test('walk_path 拒绝 pending/占位 routeId，并指向 plan_route 的真实结果类型', () => {
  const adapter = flatAdapter();
  for (const routeId of ['pending', '$routeId', '<route>', 'auto', 'todo', 'later', '{routeId}']) {
    const v = walkPath.validate({ routeId }, adapter);
    assert.equal(v.ok, false, routeId);
    assert.match(!v.ok ? v.error : '', /占位符|routeId/);
  }
  const valid = walkPath.validate({ routeId: 'rt_1790000000000_1' }, adapter);
  assert.ok(valid.ok, !valid.ok ? valid.error : '');
});

test('walk_path 拒绝未知/过期 routeId 和缺失空间会话', async (t) => {
  const w = flatAdapter();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const unknown = await walkPath.run(ctx, { routeId: 'nope' });
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.failureCode, 'BAD_ARGS');

  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const planned = await planRoute.run({ ...ctx, spatial }, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  const noSpatial = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(noSpatial.status, 'failed');
  assert.equal(noSpatial.failureCode, 'NOT_CONNECTED');
});

test('walk_path 执行 search 路线并只在实测到达后返回成功', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const planned = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  // bodyArrival 的水平容差是 0.12；ARRIVED 是实测 grounded 到达，不是 1e-6 坐标。
  assert.ok(Math.abs(w.pos.x - 2.5) <= 0.13, `实际位置 x=${w.pos.x}`);
  assert.equal(w.control.forward, false, '结束时应松键');
});

test('walk_path 在起点漂移超过容差时拒绝执行，要求重新规划', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const planned = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.pos = { ...w.pos, x: w.pos.x + 0.2 };
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal((result.data?.unsupported as { reason?: string } | undefined)?.reason, 'route_start_changed');
  assert.notEqual(w.control.forward, true, '拒绝执行时不能按前进键');
});

test('plan_route 把整数方块目标归一化到当前脚位格点，不再因 .3/.7 偏移拒绝', async (t) => {
  const w = flatAdapter();
  w.pos = { x: 0.3, y: 64, z: 0.7 };
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: { x: 2, y: 64, z: 0 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: 2, y: 64, z: 0 });
  assert.deepEqual(r.data?.requestedTarget, { x: 2, y: 64, z: 0 });
  assert.deepEqual(r.data?.targetStance, { x: 2.3, y: 64, z: 0.7 });
  assert.ok((r.data?.points as unknown[]).length >= 2);
  assert.match(r.summary, /目标格 \(2,64,0\)/);
  assert.deepEqual(w.actions, [], '规划阶段不移动');
});

test('plan_route 目标与当前同格时按零段路线成功，而不是把 .7 当成非整数偏移', async (t) => {
  const w = flatAdapter();
  w.pos = { x: -0.3, y: 64, z: 0.7 };
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = fakeSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: { x: -1, y: 64, z: 0 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: -1, y: 64, z: 0 });
  assert.equal((r.data?.points as unknown[]).length, 1);
  assert.match(r.summary, /0 段/);
});

function memorySpatial(map: VoxelMap, inspection: Record<string, unknown>) {
  const base = fakeSpatial(map) as unknown as Record<string, unknown>;
  return {
    ...base,
    query: (request: Record<string, unknown>) => ({
      status: 'ok', contract: 'memory-host-contract/1', worldId: WORLD, dim: DIM,
      sessionId: SESSION, computedAt: Date.now(), readOnly: true, executable: false,
      data: { kind: 'historyRoute', inspection: { ...inspection, request } },
    }),
  } as unknown as SharedSpatialSession;
}

test('plan_route source:"memory" 从共享拓扑返回通用过渡，不发 routeId', async (t) => {
  const w = flatAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const evidence = (id: string, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => ({
    id, fragmentId: 'frag', from, to, worldId: WORLD, dim: DIM, sessionId: SESSION,
    observedAt: 1, source: 'confirmed_traversal', mode: 'walk',
  });
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }];
  const spatial = memorySpatial(map, {
    worldId: WORLD, dim: DIM, from: points[0], to: points[2], near: 5, status: 'FOUND',
    fromNodeId: 'n0', toNodeId: 'n2', points, nodeIds: ['n0', 'n1', 'n2'], edgeIds: ['e0', 'e1'],
    segments: [
      { edgeId: 'e0', from: 'n0', to: 'n1', type: 'HORIZONTAL', direction: 'forward', evidenceId: 't0', evidence: evidence('t0', points[0]!, points[1]!) },
      { edgeId: 'e1', from: 'n1', to: 'n2', type: 'STAIRCASE', direction: 'forward', evidenceId: 't1', evidence: evidence('t1', points[1]!, points[2]!) },
    ],
    gaps: [], stats: null, diagnostics: [], message: 'found',
    historicalGeometry: true, executable: false, currentPassability: 'UNKNOWN',
  });
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: { x: 2, y: 64, z: 0 }, mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'memory');
  assert.equal(r.data?.executable, false);
  assert.equal(r.data?.routeId, undefined);
  assert.deepEqual((r.data?.points as unknown[]).length, 3);
  assert.deepEqual((r.data?.legs as { transition: string }[]).map((leg) => leg.transition), ['walk', 'step']);
  assert.match(r.summary, /第1段 walk/, '记忆路线摘要要带出前几段坐标，模型才知道先执行什么');
  assert.deepEqual(r.data?.targetCell, { x: 2, y: 64, z: 0 });
  assert.deepEqual(w.actions, [], '记忆规划不移动');
  const auto = await planRoute.run(ctx, { to: { x: 2, y: 64, z: 0 }, mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(auto.status, 'succeeded', auto.summary);
  assert.equal(auto.data?.source, 'memory', 'auto 先查共享记忆');
  assert.deepEqual((auto.data?.legs as { transition: string }[]).map((leg) => leg.transition), ['walk', 'step']);
});
