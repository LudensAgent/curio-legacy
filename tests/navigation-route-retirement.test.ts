import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { planRoute } from '../src/skills/movement/route.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { constrainRecoveryAction, recoveryContext } from '../src/skills/recovery.ts';
import { spatialExtrema } from '../src/skills/spatial-extrema.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SkillCtx } from '../src/skills/types.ts';
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

function fakeSpatial(map: VoxelMap): SharedSpatialSession {
  return {
    worldId: WORLD,
    session: { voxel: map, lifecycle: 'open', history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true } },
      overclaims: [],
    }),
    attach: () => ({}), detach: () => {},
    query: () => { throw new Error('退役测试不应查询旧路线/片段'); },
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
  assert.equal(travelTo.validate({ to: '10,10' }, adapter).ok, true, '默认直接寻路仍是合法兜底');
});

test('travel_to 执行时不查询 historyRoute/fragments，也不会沿旧路线走', async (t) => {
  let queries = 0;
  let pos: Vec3Like = at(0.5, 64, 0.5);
  const calls: MoveTarget[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, dim: DIM, worldId: WORLD, alive: true, connected: true, riding: null, inWater: false, oxygen: 20, inventory: [] }),
    async moveTo(target: MoveTarget, _opts: MoveOpts) {
      calls.push(target);
      if (target.kind === 'xz') pos = at(target.x + 0.5, pos.y, target.z + 0.5);
      else if (target.kind === 'near') pos = at(target.pos.x + 0.5, target.pos.y, target.pos.z + 0.5);
    },
    recentDug: () => [], recentPlaced: () => [],
  } as unknown as GameAdapter;
  const memory = { visitedChunkCount: 0, lastDeath: () => null, findLandmark: () => undefined };
  const spySpatial = { query: () => { queries += 1; throw new Error('travel_to 不应查询旧路线'); } };
  const ctx = { adapter, memory, spatial: spySpatial, signal: new AbortController().signal, deadline: Date.now() + 60_000, progress() {} } as unknown as SkillCtx;
  t.after(() => {});
  const parsed = travelTo.validate({ to: { x: 3, z: 0 } }, adapter);
  assert.ok(parsed.ok);
  const r = await travelTo.run(ctx, parsed.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(queries, 0, '没有 historyRoute/fragments 查询');
  assert.ok(calls.length > 0);
  assert.equal(Math.floor(pos.x), 3);
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

test('spatial_query 对旧路线 kind 返回结构化 unsupported，不返回空列表', async () => {
  const adapter = new FakeAdapter();
  const ctx = { ...makeCtx(adapter), spatial: { closing: false, session: { lifecycle: 'open' } } as unknown as SharedSpatialSession };
  for (const kind of ['fragments', 'traversals', 'historyRoute', 'components', 'segments', 'edges'] as const) {
    const r = await spatialQuery.run(ctx, { kind });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.status, 'unsupported');
    assert.equal(r.data?.reason, 'route_retired');
    assert.equal(r.data?.items, undefined, '不能用空列表冒充无记录');
  }
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
