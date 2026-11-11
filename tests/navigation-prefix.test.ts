import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { planRoute } from '../src/skills/movement/route.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

type PrefixFacts = {
  endpoint: { x: number; y: number; z: number };
  points: unknown[];
  transitions: { kind: string }[];
  distanceToTarget: number;
  atTarget: boolean;
  atStart: boolean;
};
type BoundarySummary = {
  total: number;
  counts: Record<string, number>;
  observationMayResolve: boolean;
  needsExplicitActionOrOtherRoute: boolean;
};
type Segment = {
  arrivedAtTarget: boolean;
  invalidation: string | null;
  remainingTarget: { x: number; y: number; z: number };
  progress: { meaningful: boolean; reason: string };
};

function fillAt(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], observedAt: number) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[]) {
  fillAt(map, name, cells, Date.now());
}

/** 已知走廊 x=0..xMax（z=0），其余方向完全没有证据。 */
function knownCorridor(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  const floor: { x: number; y: number; z: number }[] = [];
  for (let x = 0; x <= xMax; x++) {
    air.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    floor.push({ x, y: 63, z: 0 });
  }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', floor);
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
    attach: () => ({}), detach: () => {},
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  return { adapter, ctx: { ...makeCtx(adapter), spatial: fakeSpatial(map) } };
}

const TARGET = { x: 10, y: 64, z: 0 };

test('navigate_to 执行已知最远前缀后停在 UNKNOWN 边界；前缀不是到达，原目的地保留', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());

  const r = await navigateTo.run(ctx, {
    to: TARGET, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });

  assert.equal(r.status, 'failed', r.summary);
  assert.equal(Math.floor(adapter.pos.x), 3, '身体只走到已知可通行的最远 approach');
  assert.match(r.summary, /不是到达/);
  assert.match(r.summary, /原目的地/);
  assert.doesNotMatch(r.summary, /navigate_to 到达/);
  const prefix = r.data?.prefix as PrefixFacts | undefined;
  assert.ok(prefix, '失败回执必须带可达前缀事实');
  assert.equal(Math.floor(prefix.endpoint.x), 3);
  assert.equal(prefix.atTarget, false);
  assert.equal(prefix.atStart, false);
  assert.deepEqual(r.data?.requestedTarget, TARGET, '原目的地按请求坐标返回');
  assert.deepEqual((r.data?.segment as Segment).remainingTarget, TARGET, '剩余目标仍是原目的地');
  assert.equal((r.data?.segment as Segment).arrivedAtTarget, false);
  const boundaries = r.data?.boundarySummary as BoundarySummary;
  assert.equal(boundaries.observationMayResolve, true, 'UNKNOWN 边界可由额外观察刷新');
  assert.equal(boundaries.needsExplicitActionOrOtherRoute, false);
  assert.ok((r.data?.executed as number) >= 3);
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'), '只执行已规划前缀，不挖/不放');
});

test('navigate_to 没有任何已确认前缀时不移动，prefix 如实标 atStart', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:air', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }]);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());

  const r = await navigateTo.run(ctx, {
    to: TARGET, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });

  assert.equal(r.status, 'failed', r.summary);
  assert.deepEqual(adapter.actions, [], '没有已确认前缀就不得移动');
  const prefix = r.data?.prefix as PrefixFacts | undefined;
  assert.ok(prefix);
  assert.equal(prefix.atStart, true);
  assert.equal(prefix.transitions.length, 0);
  assert.deepEqual(r.data?.requestedTarget, TARGET);
});

test('navigate_to 在已观测 BLOCKED 边界前不自动前进，返回前缀端点 + blocker 事实', async (t) => {
  const map = knownCorridor(3);
  // 有地板的整列实心墙：x=4 是已观测阻挡，而不是“没有可站立面”的未知列。
  fill(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }, { x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }, { x: 4, y: 66, z: 0 }]);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());

  const r = await navigateTo.run(ctx, {
    to: TARGET, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });

  assert.equal(r.status, 'failed', r.summary);
  // 已知 BLOCKED 时停下前会先绕向尚未试过的前沿点再看；只迈步，不穿墙。
  assert.ok(adapter.actions.every((action) => action === 'moveTo:feet'));
  assert.ok(Math.floor(adapter.pos.x) < 4, '没有穿过墙');
  const boundaries = r.data?.boundarySummary as BoundarySummary;
  assert.equal(typeof boundaries.needsExplicitActionOrOtherRoute, 'boolean', '边界摘要说明是否需要显式动作或其他路线');
  assert.match(r.summary, /不是到达/);
});

test('plan_route source:"spatial" 返回与 navigate_to 相同的前缀事实形状，不声称终点可达', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());

  const r = await planRoute.run(ctx, { to: TARGET, mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });

  assert.equal(r.status, 'failed', r.summary);
  assert.match(r.summary, /不是到达/);
  const prefix = r.data?.prefix as PrefixFacts | undefined;
  assert.ok(prefix, 'plan_route 失败也返回同一 prefix 形状');
  assert.equal(Math.floor(prefix.endpoint.x), 3);
  assert.equal(prefix.atTarget, false);
  assert.deepEqual(r.data?.requestedTarget, TARGET);
  const boundaries = r.data?.boundarySummary as BoundarySummary;
  assert.equal(boundaries.observationMayResolve, true);
  assert.equal(boundaries.needsExplicitActionOrOtherRoute, false);
  const prefixSteps = r.data?.prefixSteps as { skill: string }[] | undefined;
  assert.equal(prefixSteps?.length, 3, '前缀过渡翻译为现有动作，但不授权执行');
  assert.ok(prefixSteps?.every((step) => step.skill === 'move_step'));
  assert.deepEqual(adapter.actions, [], 'plan_route 只读，不移动');
});

test('navigate_to 在节点预算边界停止后仍执行当前证据前缀，不要求预算之后的时间', async (t) => {
  // 明确的小节点预算：确定性停在预算处并给出当前证据前缀，不靠真实耗时触发超时。
  const N = 200;
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  const floor: { x: number; y: number; z: number }[] = [];
  for (let x = 0; x <= N; x++) {
    air.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    floor.push({ x, y: 63, z: 0 });
  }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', floor);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const deadline = Date.now() + 5000;

  const r = await navigateTo.run(ctx, {
    to: { x: N, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8,
    allowUnknownCorridor: false, maxNodes: 96, deadlineMs: deadline,
  });

  assert.equal(r.status, 'failed', r.summary);
  assert.ok(r.data?.executed as number > 0, '预算停止的前缀仍被执行');
  assert.ok(adapter.pos.x > 0, `身体只走到当前证据前缀（实际 x=${adapter.pos.x}）`);
  assert.deepEqual(r.data?.requestedTarget, { x: N, y: 64, z: 0 }, '原目的地不被前缀替换');
  assert.equal((r.data?.segment as Segment).arrivedAtTarget, false);
  const prefix = r.data?.prefix as PrefixFacts | undefined;
  assert.ok(prefix, '预算停止必须带当前证据前缀事实');
  assert.equal(prefix.atTarget, false, '前缀不是到达');
  assert.ok(Date.now() <= deadline + 2000, '没有要求预算之后的时间');
});

test('搜索在节点/边预算停止但当前前缀 atTarget=true 时，执行实测到达后仍报告真实到达', async (t) => {
  // 目标边先入队；两侧有真实现测支撑，使下一次边预算检查在弹出目标前触发。
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  const floor: { x: number; y: number; z: number }[] = [];
  for (let x = 0; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    air.push({ x, y: 64, z }, { x, y: 65, z });
    floor.push({ x, y: 63, z });
  }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', floor);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());

  const r = await navigateTo.run(ctx, {
    to: { x: 1, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8,
    allowUnknownCorridor: false, maxEdges: 1,
  });

  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.arrived, true);
  assert.deepEqual(r.data?.remaining, []);
  assert.equal(Math.floor(adapter.pos.x), 1, '实测已到目标格');
  const prefix = r.data?.prefix as PrefixFacts | undefined;
  assert.equal(prefix?.atTarget, true, '预算停止时目标已经是当前证据前缀端点');
  const segment = r.data?.segment as Segment;
  assert.equal(segment.arrivedAtTarget, true);
  assert.equal(segment.invalidation, null);
  assert.doesNotMatch(r.summary, /不是到达/);
});

test('plan_route 历史候选回执的 boundarySummary 只汇总同源 boundaries，当前前缀单独命名', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const now = Date.now(), old = now - 120_000;
  const air: { x: number; y: number; z: number }[] = [];
  const floor: { x: number; y: number; z: number }[] = [];
  const walls: { x: number; y: number; z: number }[] = [];
  for (let x = 0; x <= 3; x++) {
    air.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    floor.push({ x, y: 63, z: 0 });
  }
  for (let x = -1; x <= 5; x++) for (const z of [-1, 1] as const) for (let y = 63; y <= 66; y++) walls.push({ x, y, z });
  for (let y = 63; y <= 66; y++) walls.push({ x: -1, y, z: 0 });
  fillAt(map, 'minecraft:air', air, now);
  fillAt(map, 'minecraft:stone', [...floor, ...walls], now);
  // x=4..5 是一条已过期观测的实心墙：strict 看到 STALE（证据不足），
  // historical 升级后看到 BLOCKED（历史几何无路）。
  const staleWall: { x: number; y: number; z: number }[] = [];
  // 覆盖库在该列评估的完整支撑范围（脚高 64, maxDrop 4 → y 59..65）；否则会先报 UNKNOWN。
  for (let x = 4; x <= 5; x++) for (let y = 59; y <= 66; y++) staleWall.push({ x, y, z: 0 });
  fillAt(map, 'minecraft:stone', staleWall, old);

  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await planRoute.run(ctx, { to: TARGET, mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });

  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.evidenceMode, 'historical');
  const boundaries = r.data?.boundaries as { status: string }[];
  const summary = r.data?.boundarySummary as BoundarySummary;
  assert.equal(summary.total, boundaries.length, 'boundarySummary 汇总与 boundaries 同一来源');
  assert.ok(boundaries.every((boundary) => boundary.status !== 'STALE'), '历史回执边界已按历史证据升级');
  assert.equal(summary.observationMayResolve, false);
  const currentBoundaries = r.data?.currentBoundaries as { status: string }[];
  const currentSummary = r.data?.currentBoundarySummary as BoundarySummary;
  assert.ok((currentSummary.counts.STALE ?? 0) > 0, '当前证据的过期边界单独命名');
  assert.equal(currentSummary.total, currentBoundaries.length);
  const currentPrefix = r.data?.currentPrefix as PrefixFacts | undefined;
  assert.equal(Math.floor(currentPrefix?.endpoint.x ?? -1), 3, '当前证据可达前缀保留');
  assert.equal(r.data?.prefix, undefined, '历史回执不把当前前缀混用为 prefix');
  assert.match(r.summary, /历史搜索无完整路线；当前证据下存在可达前缀/);
});
