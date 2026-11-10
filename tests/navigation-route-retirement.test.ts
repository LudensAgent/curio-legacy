import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { planRoute } from '../src/skills/movement/route.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { constrainRecoveryAction, recoveryContext } from '../src/skills/recovery.ts';
import { spatialExtrema } from '../src/skills/spatial-extrema.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'retirement-world', DIM = 'overworld', SESSION = 'retirement-session';
const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
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

/** x=0..maxX 的已知平地（脚高 64）。 */
function flatMap(maxX: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [], floor: Vec3Like[] = [];
  for (let x = 0; x <= maxX; x++) { air.push(at(x, 64, 0), at(x, 65, 0)); floor.push(at(x, 63, 0)); }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', floor);
  return map;
}

function fakeSpatial(map: VoxelMap, query: (request: unknown) => unknown = () => { throw new Error('unexpected query'); }): SharedSpatialSession {
  return {
    worldId: WORLD,
    session: { voxel: map, lifecycle: 'open' },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true } },
      overclaims: [],
    }),
    attach: () => ({}), detach: () => {},
    query,
  } as unknown as SharedSpatialSession;
}

function navCtx(maxX: number) {
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.pos = at(0.5, 64, 0.5);
  const map = flatMap(maxX);
  return { adapter, ctx: { ...makeCtx(adapter), spatial: fakeSpatial(map) } };
}

test('旧 route 入口已从注册表/目录移除；navigate_to 与 advance 是执行入口', () => {
  assert.equal(SKILLS.walk_path, undefined);
  assert.ok(SKILLS.navigate_to);
  assert.ok(SKILLS.advance);
  assert.ok(SKILLS.plan_route);
  assert.equal(SKILLS.plan_route.readOnly, true);
  assert.equal(SKILLS.plan_route.movement, false);
  const catalog = skillCatalog();
  assert.doesNotMatch(catalog, /walk_path/);
  assert.match(catalog, /navigate_to/);
  assert.match(catalog, /advance/);
});

test('plan_route 不再接受 memory/search；travel_to 不再接受 via history/fragment/auto', () => {
  const adapter = new FakeAdapter();
  for (const source of ['memory', 'search'] as const) {
    assert.equal(planRoute.validate({ to: at(1, 64, 0), source }, adapter).ok, false, `source:${source}`);
  }
  for (const via of ['auto', 'history', { fragment: 'f-1' }] as const) {
    assert.equal(travelTo.validate({ to: '10,10', via }, adapter).ok, false, `via:${JSON.stringify(via)}`);
  }
  assert.equal(travelTo.validate({ to: '10,10' }, adapter).ok, true, '默认体素导航外壳仍是合法入口');
});

test('travel_to 只沿体素证据移动，不查询 historyRoute/fragments', async (t) => {
  const { adapter, ctx } = navCtx(8);
  t.after(() => ctx.memory.close());
  const parsed = travelTo.validate({ to: { x: 6, y: 64, z: 0 }, range: 1 }, adapter);
  assert.ok(parsed.ok);
  const r = await travelTo.run(ctx, parsed.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.backend, 'voxel_astar');
  assert.ok(adapter.actions.some((a) => a.startsWith('moveTo:feet')));
  assert.ok(!adapter.actions.some((a) => /^moveTo:(xz|near|advance)/.test(a)));
  assert.equal(Math.floor(adapter.pos.x), 5, 'range=1 在第一处满足原到达条件的位置停止');
  assert.deepEqual(r.data?.requestedTarget, at(6, 64, 0), '范围验收保留原目的地');
});

test('代码技能 api.moveTo 直接使用 navigate_to 并到达精确目标', async (t) => {
  const { adapter, ctx } = navCtx(3);
  t.after(() => ctx.memory.close());
  const bridge = makeBridge(ctx);
  const result = await bridge('moveTo', [2, 64, 0]) as { ok: boolean; pos: Vec3Like; data?: Record<string, unknown> };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Math.floor(result.pos.x), 2);
  assert.equal(Math.floor(result.pos.z), 0);
  assert.ok(adapter.actions.length > 0, '确实派发了移动');
  // 新 wrapper 的回执仍保留原目标与实测位置，不返回 routeId。
  const data = result.data ?? {};
  assert.deepEqual(data.requestedTarget, at(2, 64, 0));
  assert.equal(data.routeId, undefined);
});

test('spatial_query 不再有旧路线兼容门面：未知 kind 原样交给库 validator', async () => {
  const adapter = new FakeAdapter();
  const forwarded: unknown[] = [];
  const spatial = fakeSpatial(flatMap(1), (request) => {
    forwarded.push(request);
    return {
      status: 'invalid_request', contract: 'memory-host-contract/2', worldId: WORLD, computedAt: 1,
      readOnly: true, executable: false, problem: { kind: 'invalid_request', detail: 'unknown query kind' },
    };
  });
  const ctx = { ...makeCtx(adapter), spatial };
  for (const kind of ['fragments', 'traversals', 'historyRoute', 'components', 'segments', 'edges'] as const) {
    const r = await spatialQuery.run(ctx, { kind });
    assert.equal(r.status, 'failed', r.summary);
    assert.equal(r.failureCode, 'BAD_ARGS');
    assert.equal(r.data?.status, 'invalid_request');
    assert.equal(r.data?.reason, undefined, '没有任何 route_retired 兼容原因');
  }
  assert.deepEqual(forwarded.map((request) => (request as { kind: string }).kind), ['fragments', 'traversals', 'historyRoute', 'components', 'segments', 'edges']);
});

test('spatial_extrema 只保留 explored；deepest/farthest/gaps 被拒绝', () => {
  const adapter = new FakeAdapter();
  for (const metric of ['deepest', 'farthest', 'gaps'] as const) {
    assert.equal(spatialExtrema.validate({ metric }, adapter).ok, false);
  }
  assert.ok(spatialExtrema.validate({ metric: 'explored' }, adapter).ok);
});

test('advance 恢复保留方向/距离/模式与预算，不能扩大或换向', () => {
  const parsed = recoveryContext({ skill: 'advance', args: { direction: 'E', distance: 10, maxLateralDrift: 4, allowed: ['walk', 'step'], historical: false } });
  assert.ok(!('error' in parsed));
  if ('error' in parsed) return;
  assert.equal(parsed.args.direction, 'E');
  const adapter = new FakeAdapter();
  const ctx = { ...makeCtx(adapter), recovery: { skill: 'advance', args: parsed.args } };
  const same = constrainRecoveryAction(ctx, 'advance', { direction: 'E', distance: 8, maxLateralDrift: 2, allowed: ['walk'], historical: false });
  assert.equal(same.distance, 8);
  assert.throws(() => constrainRecoveryAction(ctx, 'advance', { direction: 'W', distance: 8, allowed: ['walk'], historical: false }), /原方向/);
  assert.throws(() => constrainRecoveryAction(ctx, 'advance', { direction: 'E', distance: 11, allowed: ['walk'], historical: false }), /距离额度/);
  assert.throws(() => constrainRecoveryAction(ctx, 'advance', { direction: 'E', distance: 8, maxLateralDrift: 2, allowed: ['jump'], historical: false }), /移动模式/);
});

test('navigate_to 直接入口仍按原目标执行并返回原目的地', async (t) => {
  const { adapter, ctx } = navCtx(2);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: at(2, 64, 0), allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.requestedTarget, at(2, 64, 0));
  assert.equal(Math.floor(adapter.pos.x), 2);
});
