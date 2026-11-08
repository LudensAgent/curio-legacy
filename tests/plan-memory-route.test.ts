import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PathFragment } from 'curio-minecraft-3d-memory';
import { planMemoryRoute } from '../src/skills/plan-memory-route.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'memory-route-world', DIM = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

function fragment(id: string, points: { x: number; y: number; z: number }[], overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id, worldId: WORLD, dim: DIM, kind: 'dug', entrances: [],
    polyline: points, geometrySource: 'traversal',
    deepestY: Math.min(...points.map((p) => p.y)),
    createdAt: 1, lastUsedAt: 2, uses: 1,
    ...overrides,
  };
}

function fakeSpatial(pages: PathFragment[][]) {
  const calls: Record<string, unknown>[] = [];
  let page = 0;
  const spatial = {
    closing: false,
    session: { lifecycle: 'open' },
    query(request: Record<string, unknown>) {
      calls.push(request);
      const items = pages[page] ?? [];
      const nextAfter = page + 1 < pages.length ? `cursor-${page + 1}` : undefined;
      page += 1;
      return {
        status: 'ok', contract: 'memory-host-contract/1', worldId: WORLD, dim: DIM,
        computedAt: 1, readOnly: true, executable: false,
        data: { kind: 'fragments', items, total: items.length, ...(nextAfter === undefined ? {} : { nextAfter }) },
        ...(nextAfter === undefined ? {} : { nextAfter }),
      };
    },
  };
  return { spatial: spatial as unknown as SharedSpatialSession, calls };
}

function ctxOf(spatial: SharedSpatialSession) {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.dim = DIM;
  return { w, ctx: { ...makeCtx(w, { deadlineMs: 30000 }), spatial } };
}

test('plan_memory_route：实测 dug 阶梯按段返回 step/可逆性/证据', async () => {
  const { spatial } = fakeSpatial([[fragment('stair', [at(0, 64, 0), at(1, 63, 0), at(2, 62, 0)])]]);
  const { w, ctx } = ctxOf(spatial);
  const r = await planMemoryRoute.run(ctx, { to: at(2, 62, 0), from: at(0, 64, 0), heal: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.status, 'route');
  assert.deepEqual((r.data?.waypoints as { x: number; y: number; z: number }[]).map((p) => `${p.x},${p.y},${p.z}`), ['0,64,0', '1,63,0', '2,62,0']);
  const legs = r.data?.legs as { transitions: string[]; reversible: boolean; evidence: string }[];
  assert.deepEqual(legs.map((leg) => leg.transitions), [['step'], ['step']]);
  assert.ok(legs.every((leg) => leg.reversible));
  assert.match(r.summary, /历史路线/);
  assert.match(r.summary, /未验证当前可通行/);
  assert.deepEqual(w.actions, [], '只读规划不能触发身体动作');
});

test('plan_memory_route：allowed 默认不含 drop；显式允许后才走纯垂直下坠', async () => {
  const { spatial } = fakeSpatial([[fragment('drop', [at(0, 64, 0), at(0, 62, 0)], {
    links: [{ a: at(0, 64, 0), b: at(0, 62, 0) }],
  })]]);
  const { ctx } = ctxOf(spatial);
  const blocked = await planMemoryRoute.run(ctx, { to: at(0, 62, 0), from: at(0, 64, 0) });
  assert.equal(blocked.data?.status, 'gap');
  assert.equal(blocked.data?.reason, 'disallowed_transition');
  assert.deepEqual((blocked.data?.rejectedLeg as { transitions: string[] }).transitions, ['drop']);

  const { spatial: allowedSpatial } = fakeSpatial([[fragment('drop', [at(0, 64, 0), at(0, 62, 0)], {
    links: [{ a: at(0, 64, 0), b: at(0, 62, 0) }],
  })]]);
  const { ctx: allowedCtx } = ctxOf(allowedSpatial);
  const allowed = await planMemoryRoute.run(allowedCtx, { to: at(0, 62, 0), from: at(0, 64, 0), allowed: ['walk', 'step', 'drop'] });
  assert.equal(allowed.data?.status, 'route');
  const legs = allowed.data?.legs as { transitions: string[]; reversible: boolean }[];
  assert.deepEqual(legs[0]?.transitions, ['drop']);
  assert.equal(legs[0]?.reversible, false);
});

test('plan_memory_route：heal 默认 false 不跨记录，显式 true 才连接并标 healed', async () => {
  const { spatial } = fakeSpatial([[
    fragment('a', [at(0, 64, 0), at(1, 64, 0)]),
    fragment('b', [at(1.5, 64, 0), at(3, 64, 0)]),
  ]]);
  const { ctx } = ctxOf(spatial);
  const closed = await planMemoryRoute.run(ctx, { to: at(3, 64, 0), from: at(0, 64, 0), heal: false });
  assert.equal(closed.data?.status, 'gap');
  assert.equal(closed.data?.reason, 'disconnected');
  assert.match(closed.summary, /heal:true/);
  const { spatial: healedSpatial } = fakeSpatial([[
    fragment('a', [at(0, 64, 0), at(1, 64, 0)]),
    fragment('b', [at(1.5, 64, 0), at(3, 64, 0)]),
  ]]);
  const { ctx: healedCtx } = ctxOf(healedSpatial);
  const healed = await planMemoryRoute.run(healedCtx, { to: at(3, 64, 0), from: at(0, 64, 0), heal: true });
  assert.equal(healed.data?.status, 'route');
  assert.ok((healed.data?.legs as { evidence: string }[]).some((leg) => leg.evidence === 'healed'));
});

test('plan_memory_route：legacy 稀疏路径/多步 mixed 可走，并标 evidence', async () => {
  const { spatial } = fakeSpatial([[fragment('sparse', [at(0, 60, 0), at(0, 54, 0)])]]);
  const { ctx } = ctxOf(spatial);
  const sparse = await planMemoryRoute.run(ctx, { to: at(0, 54, 0), from: at(0, 60, 0), allowed: ['walk', 'step', 'drop'] });
  assert.equal(sparse.data?.status, 'route');
  const sparseLeg = (sparse.data?.legs as { transitions: string[]; evidence: string }[])[0];
  assert.deepEqual(sparseLeg?.transitions, ['drop']);
  assert.equal(sparseLeg?.evidence, 'legacy');

  const { spatial: mixedSpatial } = fakeSpatial([[fragment('mixed', [at(0, 64, 0), at(1, 63, 0), at(1, 62, 0)], {
    links: [{ a: at(0, 64, 0), b: at(1, 62, 0) }],
  })]]);
  const { ctx: mixedCtx } = ctxOf(mixedSpatial);
  const mixed = await planMemoryRoute.run(mixedCtx, { to: at(1, 62, 0), from: at(0, 64, 0), allowed: ['walk', 'step', 'drop'] });
  assert.equal(mixed.data?.status, 'route');
  const mixedLeg = (mixed.data?.legs as { transitions: string[]; mixed?: boolean }[])[0];
  assert.deepEqual(mixedLeg?.transitions, ['step', 'drop']);
  assert.equal(mixedLeg?.mixed, true);
});

test('plan_memory_route：maxWaypoints 截断、snapRadius 命不中、目标/起点太远', async () => {
  const { spatial } = fakeSpatial([[fragment('stair', [at(0, 64, 0), at(1, 63, 0), at(2, 62, 0)])]]);
  const { ctx } = ctxOf(spatial);
  const capped = await planMemoryRoute.run(ctx, { to: at(2, 62, 0), from: at(0, 64, 0), maxWaypoints: 2 });
  assert.equal(capped.data?.status, 'gap');
  assert.equal(capped.data?.reason, 'truncated');
  assert.equal(capped.data?.truncated, true);

  const { spatial: farFromSpatial } = fakeSpatial([[fragment('near', [at(0, 64, 0), at(1, 64, 0)])]]);
  const { ctx: farFromCtx } = ctxOf(farFromSpatial);
  const farFrom = await planMemoryRoute.run(farFromCtx, { to: at(1, 64, 0), from: at(10, 64, 0), snapRadius: 1 });
  assert.equal(farFrom.data?.status, 'gap');
  assert.equal(farFrom.data?.reason, 'from_far_from_records');
  assert.deepEqual(farFrom.data?.nearest, at(1, 64, 0));
  assert.equal(farFrom.data?.nearestReachable, false);

  const { spatial: farToSpatial } = fakeSpatial([[fragment('near', [at(0, 64, 0), at(1, 64, 0)])]]);
  const { ctx: farToCtx } = ctxOf(farToSpatial);
  const farTo = await planMemoryRoute.run(farToCtx, { to: at(10, 64, 0), from: at(0, 64, 0), snapRadius: 1 });
  assert.equal(farTo.data?.status, 'gap');
  assert.equal(farTo.data?.reason, 'to_far_from_records');
  assert.deepEqual(farTo.data?.nearest, at(1, 64, 0));
  assert.equal(farTo.data?.nearestReachable, false);
});

test('plan_memory_route：maxPoints 截断如实报告；参数边界与只读', async () => {
  const { spatial } = fakeSpatial([[fragment('long', [at(0, 64, 0), at(1, 64, 0), at(2, 64, 0)])]]);
  const { ctx, w } = ctxOf(spatial);
  const truncated = await planMemoryRoute.run(ctx, { to: at(2, 64, 0), from: at(0, 64, 0), maxPoints: 1 });
  assert.equal(truncated.data?.status, 'gap');
  assert.equal(truncated.data?.reason, 'truncated');
  assert.equal(truncated.data?.truncated, true);
  assert.deepEqual(w.actions, []);
  const adapter = new FakeAdapter();
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), allowed: ['ladder'] }, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({}, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), snapRadius: 17 }, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), maxPoints: 0 }, adapter).ok, false);
});
