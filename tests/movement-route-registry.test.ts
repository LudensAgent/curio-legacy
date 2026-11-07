import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RoutePlanRegistryImpl,
  VoxelMap,
  type PathFragment,
  type RoutePlan,
  type RoutePlanDraft,
  type RoutePlanRegistryProblem,
} from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import {
  clearRouteRecords,
  consumeRoutePlan,
  planRoute,
  releaseRoutePlan,
} from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const SCOPE = { worldId: WORLD, dim: DIM, sessionId: SESSION };

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
    attach: () => ({}),
    detach: () => {},
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

function isPlan(value: RoutePlan | RoutePlanRegistryProblem): value is RoutePlan {
  return 'backend' in value;
}

const ask = (to: { x: number; y: number; z: number }, source: 'auto' | 'search' | 'history', more: Record<string, unknown> = {}) => ({
  to, mode: 'walk' as const, source, arrival: { kind: 'exact' as const }, ...more,
});

test('plan_route 薄适配库 planRoute：库签发 routeId、保存完整计划、单次消费', async (t) => {
  const w = flatAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const r = await planRoute.run(ctx, ask({ x: 2.5, y: 64, z: 0.5 }, 'search'));
  assert.equal(r.status, 'succeeded', r.summary);
  const routeId = String(r.data?.routeId);
  assert.match(routeId, /^rt_\d+_\d+$/, 'routeId 必须由库注册表签发，不能是宿主 UUID');
  assert.equal(r.data?.backend, 'spatial_library');
  assert.equal(r.data?.source, 'search');
  assert.equal(r.data?.executable, true);
  assert.equal(r.data?.confidence, 'verified');
  assert.equal(r.data?.verdict, 'OPEN');
  assert.deepEqual(r.data?.start, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(r.data?.requestedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(r.data?.resolvedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(r.data?.scope, SCOPE);
  assert.ok((r.data?.evidence as { validUntil?: number }).validUntil !== undefined);
  assert.ok(Number(r.data?.expiresAt) <= Date.now() + 30_000 + 100);
  assert.ok(Array.isArray(r.data?.boundaries));

  const first = consumeRoutePlan(routeId, SCOPE);
  assert.ok(isPlan(first), '第一次消费应返回库计划');
  assert.equal(first.routeId, routeId);
  const second = consumeRoutePlan(routeId, SCOPE);
  assert.deepEqual(second, { kind: 'route_consumed', routeId });
  releaseRoutePlan(routeId);
  assert.deepEqual(w.actions, [], '规划阶段不移动');
});

test('候选计划 executable:false 仍可持 routeId，但消费返回 route_not_executable', async (t) => {
  const w = flatAdapter();
  const frag = fragment('frag-short', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-short': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 历史终点在 2.5，请求精确到 3.5：库保留几何但结论是候选，不是可执行到达。
  const r = await planRoute.run(ctx, ask({ x: 3.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-short' }));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.executable, false);
  assert.equal(r.data?.confidence, 'candidate');
  assert.equal((r.data?.unsupported as { kind?: string } | null)?.kind, 'unsupported_geometry');
  const routeId = String(r.data?.routeId);
  assert.match(routeId, /^rt_/);

  const consumed = consumeRoutePlan(routeId, SCOPE);
  assert.equal(isPlan(consumed), false);
  assert.equal(!isPlan(consumed) ? consumed.kind : null, 'route_not_executable');
  assert.deepEqual(consumeRoutePlan(routeId, SCOPE), { kind: 'route_consumed', routeId });
});

test('历史召回起点 >0.05 返回结构化 history_start_mismatch，不从别的起点硬套', async (t) => {
  const w = flatAdapter();
  const frag = fragment('frag-away', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-away': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  w.pos = { x: 2.5, y: 64, z: 0.5 }; // 实测脚位离历史首点 2 格
  const explicit = await planRoute.run(ctx, ask({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-away' }));
  assert.equal(explicit.status, 'failed');
  assert.equal(explicit.failureCode, 'PATH_NOT_FOUND');
  assert.equal(explicit.data?.classification, 'HISTORY_START_MISMATCH');
  assert.equal((explicit.data?.unsupported as { kind?: string } | undefined)?.kind, 'unsupported_geometry');
  assert.deepEqual(explicit.data?.start, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(explicit.data?.routeStart, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(explicit.data?.drift, 2);
  assert.equal(explicit.data?.routeId, undefined, '起点不符时不得签发可执行 routeId');

  const recalled = await planRoute.run(ctx, ask({ x: 2.5, y: 64, z: 0.5 }, 'history'));
  assert.equal(recalled.status, 'failed');
  assert.equal(recalled.data?.classification, 'HISTORY_START_MISMATCH');
  assert.equal(recalled.data?.pathId, 'frag-away');
});

test('历史召回不按终点过滤：起点匹配即交给库，保留 requested/resolvedTarget', async (t) => {
  const w = flatAdapter();
  const frag = fragment('frag-near', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-near': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 终点在 2.5，请求 3.5：宿主不按终点过滤，交给库给出 candidate + 两端目标。
  const r = await planRoute.run(ctx, ask({ x: 3.5, y: 64, z: 0.5 }, 'history'));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'history');
  assert.equal(r.data?.pathId, 'frag-near');
  assert.equal(r.data?.executable, false);
  assert.equal(r.data?.confidence, 'candidate');
  assert.deepEqual(r.data?.requestedTarget, { x: 3.5, y: 64, z: 0.5 });
  assert.deepEqual(r.data?.resolvedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.equal((r.data?.unsupported as { kind?: string } | null)?.kind, 'unsupported_geometry');
});

test('auto 无 pathId：没有起点匹配的历史时回退 search', async (t) => {
  const w = flatAdapter();
  const frag = fragment('frag-far', [{ x: 2.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-far': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const r = await planRoute.run(ctx, ask({ x: 1.5, y: 64, z: 0.5 }, 'auto'));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'search', '起点不符的历史不能硬套，应回退 search');
  assert.equal(r.data?.executable, true);
  assert.deepEqual(r.data?.start, { x: 0.5, y: 64, z: 0.5 });
});

test('能力缺失分类为 UNAVAILABLE，不折叠成证据不足', async (t) => {
  const w = flatAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const spatial = { ...fakeSpatial(map), session: { voxel: map } } as unknown as SharedSpatialSession;
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 没有历史 store：这是能力缺失，不是“世界没有证据”。
  const r = await planRoute.run(ctx, ask({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-x' }));
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_CONNECTED');
  assert.equal(r.data?.classification, 'UNAVAILABLE');
  assert.equal(r.data?.unsupported, undefined);
  assert.equal((r.data?.problem as { kind?: string } | undefined)?.kind, 'unavailable');
});

test('source:"auto" 历史起点不符时回退 search，不把历史当成可执行路线', async (t) => {
  const w = flatAdapter();
  const frag = fragment('frag-elsewhere', [{ x: 2.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-elsewhere': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const r = await planRoute.run(ctx, ask({ x: 1.5, y: 64, z: 0.5 }, 'auto', { pathId: 'frag-elsewhere' }));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'search', 'history 的起点不符不能变成可执行历史路线');
  assert.equal(r.data?.executable, true);
  assert.deepEqual(r.data?.start, { x: 0.5, y: 64, z: 0.5 });
});

test('失败分类结构化：UNSUPPORTED / BUDGET_EXHAUSTED / INSUFFICIENT_EVIDENCE / CANCELLED', async (t) => {
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const stairs = fragment('frag-stairs', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 63, z: 0.5 }]);
  const base = { ...makeCtx(flatAdapter()), spatial: fakeSpatial(map, { 'frag-stairs': stairs }) };
  t.after(() => base.memory.close());
  clearRouteRecords();

  const unsupported = await planRoute.run(base, ask({ x: 1.5, y: 63, z: 0.5 }, 'history', { pathId: 'frag-stairs' }));
  assert.equal(unsupported.status, 'failed');
  assert.equal(unsupported.failureCode, 'BAD_ARGS');
  assert.equal(unsupported.data?.classification, 'UNSUPPORTED');
  const unsupportedFact = unsupported.data?.unsupported as { kind?: string; detail?: string };
  assert.equal(unsupportedFact.kind, 'unsupported_geometry');
  assert.match(String(unsupportedFact.detail), /height/);

  const budget = await planRoute.run(base, ask({ x: 3.5, y: 64, z: 0.5 }, 'search', { constraints: { maxNodes: 1 } }));
  assert.equal(budget.status, 'failed');
  assert.equal(budget.data?.classification, 'BUDGET_EXHAUSTED');
  const budgetFact = budget.data?.unsupported as { kind?: string; limit?: string; detail?: string };
  assert.equal(budgetFact.kind, 'budget_exhausted');
  assert.equal(budgetFact.limit, 'nodes');
  assert.equal(typeof budgetFact.detail, 'string');
  assert.ok((budget.data?.counters as { nodesReached?: number }).nodesReached !== undefined);
  assert.ok((budget.data?.limits as { maxNodes?: number }).maxNodes !== undefined);

  const evidence = await planRoute.run(base, ask({ x: 20.5, y: 64, z: 0.5 }, 'search'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failureCode, 'NOT_FOUND');
  assert.equal(evidence.data?.classification, 'INSUFFICIENT_EVIDENCE');
  assert.ok(((evidence.data?.inspection as { boundaries?: unknown[] }).boundaries ?? []).length > 0, '保留 inspection.boundaries');
  assert.ok((evidence.data?.counters as { edgesUnknown?: number }).edgesUnknown !== undefined);

  const controller = new AbortController();
  controller.abort('user stop');
  const cancelled = await planRoute.run({ ...base, signal: controller.signal }, ask({ x: 2.5, y: 64, z: 0.5 }, 'search'));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.data?.classification, 'CANCELLED');
  assert.equal((cancelled.data?.problem as { kind?: string }).kind, 'cancelled');
});

test('库注册表容量/TTL/单次消费/pin 语义（宿主直接依赖）', async () => {
  const now = () => Date.now();
  const draft = (expiresAt: number, executable: boolean): RoutePlanDraft => ({
    backend: 'spatial_library', source: 'search',
    points: [{ x: 0, y: 64, z: 0 }],
    segments: [{ index: 0, mode: 'walk', points: [{ x: 0, y: 64, z: 0 }], cost: 0 }],
    cost: 0, confidence: executable ? 'verified' : 'candidate', executable,
    boundaries: [],
    evidence: { worldId: WORLD, dim: DIM, sessionId: SESSION, validUntil: expiresAt, ruleVersion: 'test' },
    expiresAt, requestedTarget: { x: 0, y: 64, z: 0 }, resolvedTarget: { x: 0, y: 64, z: 0 }, start: { x: 0, y: 64, z: 0 },
  });
  const future = now() + 10_000;

  const single = new RoutePlanRegistryImpl();
  const candidate = single.register(draft(future, false));
  const first = single.consume(candidate.routeId, SCOPE, now());
  assert.equal(isPlan(first), false);
  assert.equal(!isPlan(first) ? first.kind : null, 'route_not_executable');
  assert.deepEqual(single.consume(candidate.routeId, SCOPE, now()), { kind: 'route_consumed', routeId: candidate.routeId });

  const bounded = new RoutePlanRegistryImpl({ capacity: 2 });
  const a = bounded.register(draft(future, true));
  const b = bounded.register(draft(future, false));
  assert.equal(bounded.size, 2);
  assert.ok(isPlan(bounded.consume(a.routeId, SCOPE, now())), '可执行计划消费后 pin 住');
  bounded.register(draft(future, false));
  assert.equal(bounded.size, 2);
  assert.deepEqual(bounded.consume(b.routeId, SCOPE, now()), { kind: 'route_not_found', routeId: b.routeId });
  assert.deepEqual(bounded.consume(a.routeId, SCOPE, now()), { kind: 'route_consumed', routeId: a.routeId });
  // 释放 pin 后，消费过的墓碑才可被容量淘汰。
  bounded.release(a.routeId);
  bounded.register(draft(future, false));
  assert.deepEqual(bounded.consume(a.routeId, SCOPE, now()), { kind: 'route_not_found', routeId: a.routeId });

  const ttl = new RoutePlanRegistryImpl({ ttlMs: 20 });
  const shortLived = ttl.register(draft(future, true));
  assert.ok(shortLived.expiresAt <= now() + 30, 'TTL 不得延长计划自身 expiresAt');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const expired = ttl.consume(shortLived.routeId, SCOPE, now());
  assert.equal(!isPlan(expired) ? expired.kind : null, 'route_expired');
  assert.equal(!isPlan(expired) && expired.kind === 'route_expired' ? expired.expiresAt : null, shortLived.expiresAt);
});
