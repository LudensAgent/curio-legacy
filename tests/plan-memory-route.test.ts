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
  const { spatial: healedSpatial } = fakeSpatial([[
    fragment('a', [at(0, 64, 0), at(1, 64, 0)]),
    fragment('b', [at(1.5, 64, 0), at(3, 64, 0)]),
  ]]);
  const { ctx: healedCtx } = ctxOf(healedSpatial);
  const healed = await planMemoryRoute.run(healedCtx, { to: at(3, 64, 0), from: at(0, 64, 0), heal: true });
  assert.equal(healed.data?.status, 'route');
  assert.ok((healed.data?.legs as { evidence: string }[]).some((leg) => leg.evidence === 'healed'));
});

test('plan_memory_route：maxPoints 截断如实报告；参数边界与只读', async () => {
  const { spatial } = fakeSpatial([[fragment('long', [at(0, 64, 0), at(1, 64, 0), at(2, 64, 0)])]]);
  const { ctx, w } = ctxOf(spatial);
  const truncated = await planMemoryRoute.run(ctx, { to: at(2, 64, 0), from: at(0, 64, 0), maxPoints: 1 });
  assert.equal(truncated.data?.status, 'gap');
  assert.equal(truncated.data?.truncated, true);
  assert.deepEqual(w.actions, []);
  const adapter = new FakeAdapter();
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), allowed: ['ladder'] }, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({}, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), snapRadius: 17 }, adapter).ok, false);
  assert.equal(planMemoryRoute.validate({ to: at(0, 0, 0), maxPoints: 0 }, adapter).ok, false);
});
