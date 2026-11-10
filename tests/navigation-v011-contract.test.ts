import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { AbortedError } from '../src/util.ts';
import { cellReached, feetReached, goalOf } from '../src/skills/movement/goal.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { planRoute } from '../src/skills/movement/route.ts';
import { runNavigationSegment } from '../src/skills/movement/segment.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
let sequence = 0;

function observe(map: VoxelMap, name: string, cells: Vec3Like[], observedAt = Date.now()) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** 一条只有 z=0 列的已知平地：x=0..maxX，脚高 64。 */
function flatMap(maxX: number, observedAt = Date.now()) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [];
  const floor: Vec3Like[] = [];
  for (let x = 0; x <= maxX; x++) {
    air.push(at(x, 64, 0), at(x, 65, 0));
    floor.push(at(x, 63, 0));
  }
  observe(map, 'minecraft:air', air, observedAt);
  observe(map, 'minecraft:stone', floor, observedAt);
  return map;
}

/** 只提供本文件需要的宿主空间端口；query 可注入历史拓扑 spy。 */
function fakeSpatial(map: VoxelMap, query?: () => unknown) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) },
    },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      // 旧同高 search 的兼容能力显式关闭；请求的 3D 体素路径不依赖它。
      effective: {
        execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true },
        plan: { walkSearch: false },
      },
      overclaims: [],
    }),
    ...(query === undefined ? {} : { query }),
    attach: () => ({}), detach: () => {},
  } as unknown as SharedSpatialSession;
}

function ctxFor(adapter: FakeAdapter, map: VoxelMap, query?: () => unknown) {
  return { ...makeCtx(adapter), spatial: fakeSpatial(map, query) };
}

/** 测试用身体：记录每次 feet 目标，并独立决定“实测”落点；不证明真实物理控制。 */
class StopShortOnceAdapter extends FakeAdapter {
  feetTargets: Vec3Like[] = [];
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind !== 'feet') return super.moveTo(target, opts);
    this.feetTargets.push(at(target.x, target.y, target.z));
    // 第一次真实运动停在请求 endpoint 前 0.05 格；不调用会自行寻路的 moveTo。
    this.pos = this.feetTargets.length === 1
      ? at(target.x - 0.05, target.y, target.z)
      : at(target.x, target.y, target.z);
    this.actions.push('moveTo:feet');
  }
}

/** 第三次 feet 派发抛出项目真实的取消错误；前两次由夹具独立设定实测位置。 */
class CancelThirdMoveAdapter extends FakeAdapter {
  feetTargets: Vec3Like[] = [];
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind !== 'feet') return super.moveTo(target, opts);
    this.feetTargets.push(at(target.x, target.y, target.z));
    if (this.feetTargets.length === 3) throw new AbortedError('test cancel at third dispatch');
    this.pos = at(target.x, target.y, target.z);
    this.actions.push('moveTo:feet');
  }
}

/** 记录每次派发实际收到的 timeoutMs 与派发时刻。 */
class BudgetRecordingAdapter extends FakeAdapter {
  timeouts: { ms: number; at: number }[] = [];
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    this.timeouts.push({ ms: opts.timeoutMs, at: Date.now() });
    if (target.kind !== 'feet') return super.moveTo(target, opts);
    this.pos = at(target.x, target.y, target.z);
    this.actions.push('moveTo:feet');
  }
}

test('plan_route auto/spatial 只保留体素结果；off-lattice 仍 UNSUPPORTED；memory/search 退役', async (t) => {
  // off-lattice exact target：只有请求的 3D 体素路径提供该结果。
  const offLatticeMap = flatMap(3);
  const offLatticeAdapter = new FakeAdapter();
  offLatticeAdapter.pos = at(0.5, 64, 0.5);
  const offLatticeCtx = ctxFor(offLatticeAdapter, offLatticeMap);
  t.after(() => offLatticeCtx.memory.close());
  const unsupported = await planRoute.run(offLatticeCtx, {
    to: at(2.8, 64, 0.5), mode: 'walk', source: 'auto', arrival: { kind: 'exact' },
  });
  assert.equal(unsupported.status, 'failed', unsupported.summary);
  assert.equal(unsupported.data?.source, 'spatial', unsupported.summary);
  assert.equal(unsupported.data?.backend, 'spatial_voxel_search');
  assert.equal(unsupported.data?.searchStatus, 'UNSUPPORTED', '体素搜索的 UNSUPPORTED 必须直接保留');
  assert.deepEqual(unsupported.data?.requestedTarget, at(2.8, 64, 0.5), '原目标必须原样保留');
  assert.equal(unsupported.data?.routeId, undefined, '不再签发 routeId');

  // 只有起点证据：体素搜索的结构化缺口直接保留。
  const barrenMap = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  observe(barrenMap, 'minecraft:air', [at(0, 64, 0), at(0, 65, 0)]);
  observe(barrenMap, 'minecraft:stone', [at(0, 63, 0)]);
  const barrenAdapter = new FakeAdapter();
  barrenAdapter.pos = at(0.5, 64, 0.5);
  const barrenCtx = ctxFor(barrenAdapter, barrenMap);
  t.after(() => barrenCtx.memory.close());
  const evidenceGap = await planRoute.run(barrenCtx, {
    to: at(3, 64, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' },
  });
  assert.equal(evidenceGap.status, 'failed', evidenceGap.summary);
  assert.equal(evidenceGap.data?.source, 'spatial', evidenceGap.summary);
  assert.equal(evidenceGap.data?.backend, 'spatial_voxel_search');
  assert.equal(evidenceGap.data?.searchStatus, 'INSUFFICIENT_EVIDENCE', '缺失当前证据的体素终态必须直接保留');
  assert.deepEqual(evidenceGap.data?.requestedTarget, at(3, 64, 0), '原目标必须原样保留');
  assert.equal(evidenceGap.data?.routeId, undefined, '证据缺口不能变成 routeId');

  // 旧 source:"memory"/"search" 入口不再被接受，不能静默映射成体素规划。
  for (const source of ['memory', 'search'] as const) {
    const rejected = planRoute.validate({ to: at(3, 64, 0), mode: 'walk', source, arrival: { kind: 'exact' } }, new FakeAdapter());
    assert.equal(rejected.ok, false, `source:"${source}" 必须被拒绝`);
  }
});

test('cell 目标保留 0.01 脚高容差；feet 目标使用 0.12/0.05 且要求 onGround；原请求目标不变', async (t) => {
  const map = flatMap(3);

  // 同一格、Y 高 0.03：旧 0.01 容差不成立，不得在移动前报到达。
  const cellAdapter = new FakeAdapter();
  cellAdapter.pos = at(0.5, 64, 0.5);
  const cellCtx = ctxFor(cellAdapter, map);
  t.after(() => cellCtx.memory.close());
  const requestedCell = at(0, 64.03, 0);
  const cellRun = await navigateTo.run(cellCtx, {
    to: requestedCell, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(cellRun.status, 'failed', cellRun.summary);
  assert.notEqual(cellRun.data?.arrived, true, '脚高差 0.03 不得按 0.01 容差报到达');
  assert.deepEqual(cellRun.data?.requestedTarget, requestedCell, '原请求目标必须原样保留');
  assert.deepEqual(cellAdapter.pos, at(0.5, 64, 0.5), '没有为 0.03 的容差差发动作');
  assert.deepEqual(cellAdapter.actions, []);

  // 窄谓词：cell 仍是 0.01；feet 是独立的 0.12/0.05 且 onGround 是完成证据的一部分。
  assert.equal(cellReached(at(0.5, 64.03, 0.5), at(0.5, 64, 0.5), true), false);
  assert.equal(cellReached(at(0.5, 64, 0.5), at(0.5, 64.005, 0.5), true), true);
  const feet = at(2, 64, 2);
  assert.equal(feetReached(feet, at(2.11, 64.04, 2), true), true);
  assert.equal(feetReached(feet, at(2.11, 64.04, 2), false), false, 'feet 目标在 onGround=false 时不算到达');
  assert.equal(feetReached(feet, at(2.13, 64, 2), true), false, '水平 0.13 超出 0.12');
  assert.equal(feetReached(feet, at(2, 64.06, 2), true), false, '垂直 0.06 超出 0.05');

  // 公开 navigate 行为：容差内的 feet 目标由实测直接验收；去掉 onGround 后不得到达或移动。
  const feetAdapter = new FakeAdapter();
  feetAdapter.pos = at(0.5, 64, 0.5);
  feetAdapter.onGround = true;
  const feetCtx = ctxFor(feetAdapter, map);
  t.after(() => feetCtx.memory.close());
  const feetTarget = at(0.61, 64.02, 0.5);
  const grounded = await navigateTo.run(feetCtx, {
    to: feetTarget, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(grounded.status, 'succeeded', grounded.summary);
  const groundedSegment = grounded.data?.segment as { arrivedAtTarget?: boolean } | undefined;
  assert.equal(groundedSegment?.arrivedAtTarget, true, '容差内的 feet 目标按实测验收');
  assert.deepEqual(grounded.data?.requestedTarget, feetTarget, '精确脚位目标不被格心化');
  assert.deepEqual(feetAdapter.actions, [], '容差内已到位时不再发移动动作');

  feetAdapter.onGround = false;
  const airborne = await navigateTo.run(feetCtx, {
    to: feetTarget, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(airborne.status, 'failed', airborne.summary);
  assert.notEqual(airborne.data?.arrived, true, 'onGround=false 不得按水平/垂直容差报到达');
  assert.deepEqual(airborne.data?.requestedTarget, feetTarget);
  assert.deepEqual(feetAdapter.actions, [], '不能为了凑容差改写目标或移动');
});

test('实测 endpoint 漂移不改写冻结精确目标；下一评估从实际位置开始，无法继续时显式 UNSUPPORTED', async (t) => {
  const map = flatMap(3);
  const adapter = new StopShortOnceAdapter();
  adapter.pos = at(0.3, 64, 0.5);
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());
  const target = at(3.3, 64, 0.5);

  const r = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: false, maxSteps: 16, maxSegments: 4,
    maxSearches: 6, allowUnknownCorridor: false,
  });

  assert.equal(r.status, 'failed', r.summary);
  assert.notEqual(r.data?.arrived, true, '漂移后的残余距离不得被当成到达');
  assert.equal(adapter.feetTargets.length, 1, '从 1.25 到 3.3 不在受支持格点上，不应再派发移动');
  assert.equal(adapter.feetTargets[0]?.x, 1.3, '第一次请求的 endpoint 仍是计划点 1.3');
  assert.equal(adapter.pos.x, 1.25, '夹具实测停在请求 endpoint 前 0.05 格');
  assert.ok(adapter.feetTargets.every((point) => point.x !== 3.25), '不得把精确目标改写成 3.25');

  const requested = r.data?.requestedTarget as Vec3Like | undefined;
  const segment = r.data?.segment as {
    endStance?: Vec3Like; arrivedAtTarget?: boolean; remainingTarget?: Vec3Like;
  } | undefined;
  const replans = r.data?.replans as {
    plannedStart?: Vec3Like | null; measuredStart?: Vec3Like; measuredEnd?: Vec3Like;
  }[] | undefined;
  const counters = r.data?.counters as { searches?: number } | undefined;
  const resolved = r.data?.resolvedTarget as Vec3Like | undefined;

  assert.deepEqual(requested, target, '原精确脚位目标不被重锚');
  assert.deepEqual(segment?.remainingTarget, target, '剩余目标仍是原精确脚位');
  assert.equal(segment?.arrivedAtTarget, false);
  assert.equal(resolved?.x, 3.3, '搜索解析目标仍是原精确点，不是 3.25');
  assert.equal(segment?.endStance?.x, 1.25, '回执的实测终点是 1.25，不是计划点 1.3');
  assert.equal(replans?.[0]?.plannedStart?.x, 1.3, '重规划事实保留旧计划起点');
  assert.equal(replans?.[0]?.measuredEnd?.x, 1.25, '重规划事实保留实际测量终点');
  assert.equal(counters?.searches, 2, '漂移后确实从实测位置发起了第二次搜索');
  assert.equal(r.data?.searchStatus, 'UNSUPPORTED', '受支持格点无法继续时给出显式能力缺口');
});

test('段内第三次移动取消：保留前两条已确认 receipt、搜索次数与实际终点', async (t) => {
  const map = flatMap(3);
  const adapter = new CancelThirdMoveAdapter();
  adapter.pos = at(0.5, 64, 0.5);
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());

  // 当前实现可能在第三 dispatch 直接重抛 AbortedError 并丢掉活动段；这里坚持正确的回执契约。
  const segment = await runNavigationSegment(ctx, {
    goal: goalOf(at(3, 64, 0)),
    allowed: ['walk', 'step'],
    historical: false,
    maxTransitions: 8,
    allowUnknownCorridor: false,
    deadline: Date.now() + 60_000,
    searchBudget: 1,
  });

  assert.equal(segment.outcome, 'cancelled', segment.detail);
  assert.equal(segment.searches, 1, '取消前的搜索次数必须保留');
  assert.equal(segment.confirmed.length, 2, '取消前两次已确认移动必须保留');
  assert.deepEqual(segment.confirmed[0]?.measuredFrom, at(0.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[0]?.measuredTo, at(1.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[1]?.measuredFrom, at(1.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[1]?.measuredTo, at(2.5, 64, 0.5));
  assert.deepEqual(segment.measuredStart, at(0.5, 64, 0.5));
  assert.deepEqual(segment.measuredEnd, at(2.5, 64, 0.5), '取消时实测终点是第二次真实落点，不是第三次计划点');
  assert.equal(adapter.feetTargets.length, 3, '第三次确实发出派发并被取消');
  assert.deepEqual(adapter.feetTargets[2], at(3.5, 64, 0.5));
});

test('派发时只剩 50ms 不得扩成 1000ms；原 deadline 已过期时不得发出移动', async (t) => {
  const BASE = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => BASE);
  t.after(() => t.mock.reset());

  const map = flatMap(1, BASE - 1000);
  const adapter = new BudgetRecordingAdapter();
  adapter.pos = at(0.5, 64, 0.5);
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());

  const segment = await runNavigationSegment(ctx, {
    goal: goalOf(at(1, 64, 0)),
    allowed: ['walk', 'step'],
    historical: false,
    maxTransitions: 1,
    allowUnknownCorridor: false,
    deadline: BASE + 50,
    searchBudget: 1,
  });

  assert.equal(segment.outcome, 'reached_waypoint', segment.detail);
  assert.equal(adapter.timeouts.length, 1, '应有且只有一次真实派发');
  const dispatched = adapter.timeouts[0]!;
  assert.ok(dispatched.ms > 0, `timeoutMs 必须为正：${dispatched.ms}`);
  assert.ok(dispatched.ms <= 50, `timeoutMs 不得大于原 deadline 剩余量 50ms：${dispatched.ms}`);
  assert.ok(dispatched.at <= BASE + 50, '派发不得晚于原 deadline');

  // 原 deadline 在派发前已过期：搜索/执行都不得发出身体移动。
  const expiredAdapter = new BudgetRecordingAdapter();
  expiredAdapter.pos = at(0.5, 64, 0.5);
  const expiredCtx = ctxFor(expiredAdapter, map);
  t.after(() => expiredCtx.memory.close());
  const expired = await runNavigationSegment(expiredCtx, {
    goal: goalOf(at(1, 64, 0)),
    allowed: ['walk', 'step'],
    historical: false,
    maxTransitions: 1,
    allowUnknownCorridor: false,
    deadline: BASE - 1,
    searchBudget: 1,
  });

  assert.equal(expiredAdapter.timeouts.length, 0, '已过期的原 deadline 不得发出任何移动');
  assert.equal(expired.confirmed.length, 0);
  assert.deepEqual(expired.measuredEnd, at(0.5, 64, 0.5), '没有移动时实测终点仍是起点');
});
