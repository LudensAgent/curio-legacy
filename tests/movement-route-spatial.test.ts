import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { clearRouteRecords, planRoute } from '../src/skills/movement/index.ts';
import { executionWindow } from '../src/skills/movement/route.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const at = (x: number, y: number, z: number) => ({ x, y, z });

let sequence = 0;
const BASE_TIME = Date.now();
function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], properties: Record<string, string> = {}) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: BASE_TIME + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties }, pos,
    });
  }
}

function fillBox(map: VoxelMap, name: string, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) cells.push(at(x, y, z));
  fill(map, name, cells);
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) },
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
    attach: () => ({}), detach: () => {},
  } as unknown as SharedSpatialSession;
}

function ctxAt(map: VoxelMap, pos: { x: number; y: number; z: number }) {
  const w = new FakeAdapter();
  w.pos = { ...pos };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return { w, ctx: { ...makeCtx(w), spatial: fakeSpatial(map) } };
}

function flatWorld() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(4, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  return map;
}

function memorySpatial(map: VoxelMap, inspection: Record<string, unknown>) {
  return {
    ...fakeSpatial(map),
    query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection } }),
  } as unknown as SharedSpatialSession;
}

test('历史候选 verification 中段 BLOCKED：执行窗口只含 blocker 前的前缀', () => {
  const hop = (x: number) => ({
    transition: { kind: 'walk' as const, from: at(x, 0, 0), to: at(x + 1, 0, 0), drop: 0 },
    status: 'OPEN', hazards: [],
  });
  const blocked = { ...hop(2), status: 'BLOCKED', reason: 'target blocked by current evidence' };
  const verification = { verdict: 'BLOCKED', openPrefix: 2, transitions: [hop(0), hop(1), blocked, hop(3)] };
  const { blocker, limit } = executionWindow(verification, 8, 4);
  assert.equal(limit, 2, '只把 blocker 前的前缀交给身体');
  assert.equal(blocker?.index, 2);
  assert.equal(blocker?.status, 'BLOCKED');
  assert.equal(blocker?.reason, 'target blocked by current evidence');
  assert.equal(blocker?.transition, blocked.transition, 'blocker 直接复用复验条目自带的 transition');
  assert.deepEqual(blocker?.hazards, []);

  const noBlocker = executionWindow({ verdict: 'STALE', openPrefix: 0, transitions: [hop(0), hop(1)] }, 8, 2);
  assert.equal(noBlocker.blocker, null, 'STALE/UNKNOWN 不是已观测阻挡');
  assert.equal(noBlocker.limit, 2, '没有 BLOCKED 时不截断，交给逐步执行复核');

  const capped = executionWindow(verification, 1, 4);
  assert.equal(capped.limit, 1, 'maxSteps 比 blocker 更早时按预算截断');
});

test('plan_route source:"memory" 多格历史 leg 保持历史几何，不当作一步 move_step', async (t) => {
  const map = flatWorld();
  const { w, ctx: base } = ctxAt(map, at(0.5, 0, 0.5));
  const points = [at(0.5, 0, 0.5), at(5.5, 0, 0.5), at(6.5, 0, 0.5)];
  const evidence = (id: string, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => ({
    id, fragmentId: 'f-dug', from, to, worldId: WORLD, dim: DIM, sessionId: SESSION,
    observedAt: 1, source: 'confirmed_walk', mode: 'walk',
  });
  const ctx = {
    ...base,
    spatial: memorySpatial(map, {
      worldId: WORLD, dim: DIM, from: points[0], to: points[2], near: 5, status: 'FOUND',
      fromNodeId: 'n0', toNodeId: 'n2', points, nodeIds: ['n0', 'n1', 'n2'], edgeIds: ['e0', 'e1'],
      segments: [
        { edgeId: 'e0', from: 'n0', to: 'n1', type: 'CAVE_PASSAGE', direction: 'forward', evidenceId: 't0', evidence: evidence('t0', points[0]!, points[1]!) },
        { edgeId: 'e1', from: 'n1', to: 'n2', type: 'HORIZONTAL', direction: 'forward', evidenceId: 't1', evidence: evidence('t1', points[1]!, points[2]!) },
      ],
      gaps: [], message: 'found',
      historicalGeometry: true, executable: false, currentPassability: 'UNKNOWN',
    }),
  };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(6, 0, 0), mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.executable, false);
  assert.equal(r.data?.currentPassability, 'UNKNOWN');
  assert.equal(r.data?.historicalGeometry, true);
  const legs = r.data?.legs as {
    transition: string; maxSpan: number; oneCellHop: boolean;
    executable: boolean; currentPassability: string; historicalGeometry: boolean;
  }[];
  assert.deepEqual(legs.map((leg) => leg.transition), ['walk', 'walk']);
  assert.equal(legs[0]!.maxSpan, 5);
  assert.equal(legs[0]!.oneCellHop, false, '多格 leg 不能被当成一步');
  assert.equal(legs[0]!.executable, false);
  assert.equal(legs[0]!.currentPassability, 'UNKNOWN');
  assert.equal(legs[0]!.historicalGeometry, true);
  assert.equal(legs[1]!.maxSpan, 1);
  assert.equal(legs[1]!.oneCellHop, true);
  assert.deepEqual(r.data?.selectedEndpoint, points[2]);
  assert.match(r.summary, /跨多格/);
  assert.match(r.summary, /不是一步 move_step/);
  assert.match(r.summary, /plan_route source:"search"/);
  assert.match(r.summary, /只到你选定的端点/);
  assert.match(r.summary, /第1段 walk/);
  assert.deepEqual(w.actions, [], '记忆规划不移动');
});

test('plan_route source:"spatial" 返回现有 move_step 步骤，不新增动作、不发 routeId', async (t) => {
  const map = flatWorld();
  const { w, ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'spatial');
  assert.equal(r.data?.routeId, undefined);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.ok(Array.isArray(steps) && steps.length > 0);
  assert.ok(steps.every((step) => step.skill === 'move_step' || step.skill === 'descend_to'));
  assert.ok(steps.every((step) => !!SKILLS[step.skill]), '步骤只能使用现有动作');
  const transitions = r.data?.transitions as { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }[];
  steps.forEach((step, index) => {
    w.pos = { ...transitions[index]!.from };
    const validated = SKILLS[step.skill]!.validate(step.args, w);
    assert.equal(validated.ok, true, `${step.skill} 参数应通过现有动作校验：${JSON.stringify(step.args)} ${JSON.stringify(validated)}`);
  });
  assert.equal(Math.floor(transitions.at(-1)!.to.x), 3, '路线只到选定的目标格，不越过');
  assert.deepEqual(w.actions, [], 'plan_route 只读，不移动');
});

test('plan_route source:"spatial" 对 1 格台阶生成 move_step', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(1, 0, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(1, 1, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.deepEqual(steps.map((step) => step.skill), ['move_step']);
  const transitions = r.data?.transitions as { kind: string }[];
  assert.deepEqual(transitions.map((transition) => transition.kind), ['step']);
});

test('plan_route source:"spatial" 对 2 格下落生成 descend_to', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 4, 1));
  fill(map, 'minecraft:stone', [at(0, 1, 0), at(0, -1, 0), at(1, -1, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 2, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(1, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.deepEqual(steps.map((step) => step.skill), ['descend_to']);
  const transitions = r.data?.transitions as { kind: string; drop: number }[];
  assert.equal(transitions[0]?.drop, 2);
  assert.ok(SKILLS.descend_to, 'descend_to 是现有 L2 动作');
});

test('plan_route source:"auto" 在没有历史查询端口时使用 spatial', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'spatial');
});

test('plan_route source:"auto" 目标脚高变化且 spatial 无路时，不回退到同高 search', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 5, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /this walk planner|fixed feet height/, '目标换层时不再调用必然失败的同高 search');
  assert.match(r.summary, /目标脚高 5 与当前 0 不同|不能表示换层/);
  assert.equal(r.data?.heightChange, 5);
  assert.ok(Array.isArray(r.data?.boundaries), '保留空间 3D 的边界事实');
});

test('plan_route source:"search" 仍明确报告固定脚高能力边界', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 1, 0), mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /fixed feet height 0/);
});

test('plan_route source:"spatial" 严格无路时用历史体素给出带 UNKNOWN 标记的候选路线', async (t) => {
  const map = flatWorld();
  map.markStale(DIM, 'expired');
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'historical');
  assert.equal(r.data?.assurance, 'historical_geometry');
  assert.equal(r.data?.currentPassability, 'UNKNOWN');
  assert.match(r.summary, /历史体素路线/);
  assert.match(r.summary, /当前可通行性未知/);
  const verification = r.data?.verification as { verdict?: string; openPrefix?: number; transitions: { status: string }[] } | undefined;
  assert.notEqual(verification?.verdict, 'OPEN', '历史路线必须暴露它不是当前已验证的 OPEN 路线');
  assert.equal(r.data?.verifiedOpenSegments, verification?.openPrefix, '逐段复验前缀原样暴露');
  assert.ok('blocker' in (r.data ?? {}), '历史候选暴露 blocker 槽位');
  assert.equal(verification?.transitions.length, (r.data?.transitions as unknown[]).length, '每段都有当前证据复验结论');
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[] | undefined;
  assert.ok(steps?.length, '历史路线仍应给出可逐步执行的现有动作');
  assert.ok(steps.every((step) => !!SKILLS[step.skill]));
});

test('plan_route auto 失败时带出历史拓扑缺口，而不是只说空间 3D 没路', async (t) => {
  const map = flatWorld();
  fillBox(map, 'minecraft:stone', at(2, 0, -1), at(2, 2, 1));
  const { w, ctx: base } = ctxAt(map, at(0.5, 0, 0.5));
  const spatial = {
    ...fakeSpatial(map),
    query: () => ({
      status: 'ok',
      data: {
        kind: 'historyRoute',
        inspection: {
          status: 'DISCONNECTED', message: 'history fragments are disconnected',
          points: [], segments: [], gaps: [], fromNodeId: null, toNodeId: null,
        },
      },
    }),
  } as unknown as SharedSpatialSession;
  const ctx = { ...base, spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /历史拓扑/);
  assert.match(r.summary, /DISCONNECTED|disconnected/);
  assert.ok(r.data?.memoryGap, '保留 memory gap facts');
  assert.equal((r.data?.memoryGap as { status?: string }).status, 'DISCONNECTED');
});

test('plan_route source:"spatial" 无法确认时返回边界事实，不伪造 steps', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.data?.steps, []);
  assert.ok(Array.isArray(r.data?.boundaries));
});
