import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap, type PathFragment } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { planRoute, resolveTarget, getRouteRecord, clearRouteRecords } from '../src/skills/movement/index.ts';
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
        getFragment: (id: string) => fragments[id] ?? null,
        fragments: () => ({ items: Object.values(fragments), total: Object.keys(fragments).length }),
      },
    },
    closing: false, paused: false, observationAdmitted: true,
  } as unknown as SharedSpatialSession;
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

test('plan_route source:"history" 可显式给 pathId，也可在附近记录路线中召回', async (t) => {
  const w = flatAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const frag = fragment('frag-dug', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const spatial = fakeSpatial(map, { 'frag-dug': frag });
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 没有匹配的记录路线：明确失败，不猜测。
  const missing = await planRoute.run(ctx, { to: { x: 20, y: 64, z: 20 }, mode: 'walk', source: 'history', arrival: { kind: 'exact' } });
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /记录路线/);

  const explicit = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'history', pathId: 'frag-dug', arrival: { kind: 'exact' } });
  assert.equal(explicit.status, 'succeeded', explicit.summary);
  assert.equal(explicit.data?.kind, 'dug');
  assert.equal(explicit.data?.confidence, 'verified');
  assert.equal((explicit.data?.points as unknown[]).length, 3);
  assert.ok(getRouteRecord(String(explicit.data?.routeId)), 'routeId 应可在进程内取回');

  const recalled = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'history', arrival: { kind: 'exact' } });
  assert.equal(recalled.status, 'succeeded', recalled.summary);
  assert.equal(recalled.data?.source, 'history');
  assert.equal(recalled.data?.pathId, 'frag-dug');
  assert.deepEqual(w.actions, [], '规划阶段不移动');
});

test('plan_route history 拒绝变高路线，不伪装成可执行', async (t) => {
  const w = flatAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const frag = fragment('frag-stairs', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 63, z: 0.5 }]);
  const spatial = fakeSpatial(map, { 'frag-stairs': frag });
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  const r = await planRoute.run(ctx, { to: { x: 2, y: 63, z: 0 }, mode: 'walk', source: 'history', pathId: 'frag-stairs', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /高度/);
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
  assert.equal(r.data?.confidence, 'candidate');
  assert.ok((r.data?.points as unknown[]).length >= 2);
  assert.ok(getRouteRecord(String(r.data?.routeId)));
  assert.deepEqual(w.actions, []);
});
