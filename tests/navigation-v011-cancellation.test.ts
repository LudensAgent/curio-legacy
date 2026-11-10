import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { LandingOption } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { goalOf } from '../src/skills/movement/goal.ts';
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
    // 与现有夹具一致：每次观察的 observedAt 严格递增，避免同毫秒内把同一格的
    // 内容更新（air→stone）判成 STALE/conflict。
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: observedAt + sequence, sequence,
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

/** 只提供本文件需要的宿主空间端口。 */
function fakeSpatial(map: VoxelMap) {
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
      // 本文件只走 3D 体素路径，不依赖旧同高 search。
      effective: {
        execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true },
        plan: { walkSearch: false },
      },
      overclaims: [],
    }),
    attach: () => ({}), detach: () => {},
  } as unknown as SharedSpatialSession;
}

function ctxFor(adapter: FakeAdapter, map: VoxelMap) {
  return { ...makeCtx(adapter), spatial: fakeSpatial(map) };
}

/**
 * 0..5 列只有过期证据（当前搜索看不见），6..22 列是当前证据。
 * remembered 搜索能跨过过期桥接段找到 22 段候选；当前证据搜索在起点就被 STALE
 * 挡住，因此只能走历史体素候选 + 当前证据复验这条路。
 */
function rememberedRouteMap() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const now = Date.now();
  const air: Vec3Like[] = [];
  const floor: Vec3Like[] = [];
  for (let x = 0; x <= 22; x++) {
    air.push(at(x, 64, 0), at(x, 65, 0));
    floor.push(at(x, 63, 0));
  }
  const stale = (pos: Vec3Like) => pos.x <= 5;
  observe(map, 'minecraft:air', air.filter(stale), now - 120_000);
  observe(map, 'minecraft:stone', floor.filter(stale), now - 120_000);
  observe(map, 'minecraft:air', air.filter((pos) => !stale(pos)), now);
  observe(map, 'minecraft:stone', floor.filter((pos) => !stale(pos)), now);
  return map;
}

/**
 * plan_route 只读预览：历史体素候选 >16 段时，当前证据复验在取消时已检查 16 段并让出；
 * 公开结局是取消，但完整搜索的 FOUND、候选与部分复验覆盖都必须保留。
 */
test('plan_route 历史体素候选复验被取消：公开 status cancelled，searchStatus 仍是 FOUND 且候选/覆盖保留', async (t) => {
  const map = rememberedRouteMap();
  const adapter = new FakeAdapter();
  adapter.pos = at(0.5, 64, 0.5);
  const controller = new AbortController();
  const ctx = { ...ctxFor(adapter, map), signal: controller.signal };
  t.after(() => ctx.memory.close());

  // 复验的当前证据检查会经过宿主 verifyLandRoute 的 cellAt 读边界；
  // 搜索本身只读 sectionRef。第一次 cellAt 出现即复验已开始，在同步复验段内排入
  // 一个微任务，让取消落在紧随 16 段之后的让出点，而不是搜索阶段。
  const originalCellAt = map.cellAt.bind(map);
  let armed = false;
  map.cellAt = (dim, x, y, z) => {
    if (!armed) {
      armed = true;
      queueMicrotask(() => controller.abort());
    }
    return originalCellAt(dim, x, y, z);
  };

  const result = await planRoute.run(ctx, {
    to: at(22, 64, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' },
  });

  assert.equal(result.status, 'cancelled', result.summary);
  assert.match(result.summary, /取消/);
  assert.equal(result.data?.backend, 'spatial_voxel_search');
  assert.equal(result.data?.searchStatus, 'FOUND', '已完成的搜索不能被改写成 CANCELLED');
  assert.equal(result.data?.evidenceMode, 'historical');
  const transitions = result.data?.transitions as { kind: string; to: Vec3Like }[];
  const points = result.data?.points as Vec3Like[];
  assert.ok(transitions.length > 16, `候选必须超过 16 段：${transitions.length}`);
  assert.equal(points.length, transitions.length + 1, '候选路点与 transition 事实保留');
  assert.deepEqual(result.data?.requestedTarget, at(22, 64, 0), '原目标保留');

  const verification = result.data?.verification as {
    verdict: string;
    coverage?: { checked: number; total: number; complete: boolean; stopped?: string };
    transitions: unknown[];
  };
  assert.notEqual(verification.verdict, 'OPEN', '没有整条路线被评为当前 OPEN');
  assert.equal(verification.coverage?.stopped, 'cancelled', '真实取消必须如实标为 cancelled');
  assert.equal(verification.coverage?.complete, false);
  assert.equal(verification.coverage?.checked, 16, '取消落在 16 段后的有界让出点');
  assert.equal(verification.coverage?.total, transitions.length);
  assert.equal(verification.transitions.length, 16, '部分复验事实保留，未检查段不被伪造');
  assert.equal(result.data?.verifiedOpenSegments, 0, '首段为 STALE，不冒充可通行前缀');
  assert.equal(result.data?.routeId, undefined, '只读预览不签发 routeId');
});

/** 第三次 feet 派发先落下实测位置再抛项目的取消错误；位移由夹具独立设定。 */
class CancelThirdMoveAdapter extends FakeAdapter {
  feetTargets: Vec3Like[] = [];
  constructor(private readonly thirdStop: 'endpoint' | 'partial') { super(); }

  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind !== 'feet') return super.moveTo(target, opts);
    this.feetTargets.push(at(target.x, target.y, target.z));
    if (this.feetTargets.length === 3) {
      this.pos = this.thirdStop === 'endpoint'
        ? at(target.x, target.y, target.z)
        : at(target.x - 0.3, target.y, target.z);
      throw new AbortedError('test cancel after measured movement');
    }
    this.pos = at(target.x, target.y, target.z);
    this.actions.push('moveTo:feet');
  }
}

test('段内第三次 feet 派发先到达端点再取消：三段确认全部保留，不多派发', async (t) => {
  const map = flatMap(3);
  const adapter = new CancelThirdMoveAdapter('endpoint');
  adapter.pos = at(0.5, 64, 0.5);
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());

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
  assert.equal(segment.arrived, false, '取消不能变成到达');
  assert.deepEqual(segment.waypoint, at(3, 64, 0), '原目标保留');
  assert.equal(segment.confirmed.length, 3, '取消前第三次派发已实测到端点，必须计入确认');
  assert.deepEqual(segment.confirmed[0]?.measuredTo, at(1.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[1]?.measuredTo, at(2.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[2]?.measuredFrom, at(2.5, 64, 0.5));
  assert.deepEqual(segment.confirmed[2]?.measuredTo, at(3.5, 64, 0.5));
  assert.equal(segment.remaining.length, 0, '已确认的第三段不再留在 remaining');
  assert.ok(Math.abs(segment.pathLength - 3) < 1e-9, `确认路径长度应为 3：${segment.pathLength}`);
  assert.equal(segment.partialDisplacement?.atTarget, true);
  assert.deepEqual(segment.measuredEnd, at(3.5, 64, 0.5));
  assert.equal(adapter.feetTargets.length, 3, '取消后不得再派发动作');
  assert.deepEqual(adapter.feetTargets[2], at(3.5, 64, 0.5));
});

/** 第三段取消发生在端点之前：只保留前两段确认，部分位移与剩余段如实保留。 */
test('段内第三次 feet 派发未到端点就取消：仅前两段确认，部分位移与剩余段保留', async (t) => {
  const map = flatMap(3);
  const adapter = new CancelThirdMoveAdapter('partial');
  adapter.pos = at(0.5, 64, 0.5);
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());

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
  assert.equal(segment.arrived, false);
  assert.deepEqual(segment.waypoint, at(3, 64, 0));
  assert.equal(segment.confirmed.length, 2, '未到端点不得把第三段计入确认');
  assert.deepEqual(segment.confirmed[1]?.measuredTo, at(2.5, 64, 0.5));
  assert.equal(segment.remaining.length, 1);
  assert.deepEqual(segment.remaining[0]?.to, at(3.5, 64, 0.5), '剩余段仍是原计划第三段');
  assert.equal(segment.partialDisplacement?.atTarget, false);
  assert.deepEqual(segment.partialDisplacement?.to, at(3.2, 64, 0.5));
  assert.deepEqual(segment.measuredEnd, at(3.2, 64, 0.5), '取消时终点是实测位置，不是计划点');
  assert.equal(segment.pathLength, 2);
  assert.equal(adapter.feetTargets.length, 3, '取消后不得再派发动作');
});

/** 直接下落：沿用 1×1 平台夹具，验证取消后的搜索事实、部分位移与到点确认。 */
function directDropFixture(stop: 'endpoint' | 'partial') {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 60; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push(at(x, y, z));
  observe(map, 'minecraft:air', air);
  observe(map, 'minecraft:stone', [at(0, 63, 0), at(1, 61, 0)]);

  class CancelDropAdapter extends FakeAdapter {
    xyzTargets: Vec3Like[] = [];
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      if (target.kind !== 'xyz') return super.moveTo(target, opts);
      const landing = at(target.x, target.y, target.z);
      this.xyzTargets.push(landing);
      this.pos = stop === 'endpoint' ? landing : at(target.x, target.y + 0.5, target.z);
      throw new AbortedError('test cancel during direct drop');
    }
  }

  const adapter = new CancelDropAdapter();
  adapter.groundY = -100;
  adapter.pos = at(0.5, 64, 0.5);
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  adapter.blocks.push({ name: 'stone', pos: at(0, 63, 0) }, { name: 'stone', pos: at(1, 61, 0) });

  const ctx = ctxFor(adapter, map);
  const option: LandingOption = {
    target: at(1.5, 62, 0.5), support: { pos: at(1, 61, 0), name: 'stone' },
    surface: 'ground', surfaceY: 62, drop: 2, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  };
  ctx.senses.landingOptions = () => [{
    ...option,
    receipt: { ...option.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId },
  }];
  return { adapter, ctx };
}

test('直接下落取消：部分位移/剩余段与原搜索事实保留；到点取消计入确认但仍是 cancelled', async (t) => {
  // 1) 端点之前取消：搜索已耗尽节点预算，直接下落回退被取消，位移只到空中。
  const partial = directDropFixture('partial');
  t.after(() => partial.ctx.memory.close());
  const partialSegment = await runNavigationSegment(partial.ctx, {
    goal: goalOf(at(1, 62, 0)),
    allowed: ['walk', 'step', 'drop'],
    historical: false,
    maxTransitions: 8,
    allowUnknownCorridor: false,
    deadline: Date.now() + 60_000,
    searchBudget: 1,
    searchLimits: { maxNodes: 1 },
  });

  assert.equal(partialSegment.outcome, 'cancelled', partialSegment.detail);
  assert.equal(partialSegment.directDrop, true);
  assert.equal(partialSegment.arrived, false);
  assert.deepEqual(partialSegment.waypoint, at(1, 62, 0), '原目标保留');
  assert.equal(partialSegment.searchStatus, 'BUDGET_EXHAUSTED', '已完成搜索的终态保留');
  assert.equal(partialSegment.searches, 1);
  assert.equal(partialSegment.confirmed.length, 0);
  assert.equal(partialSegment.remaining.length, 1);
  assert.deepEqual(partialSegment.remaining[0]?.to, at(1, 62, 0));
  assert.equal(partialSegment.pathLength, 0);
  assert.equal(partialSegment.partialDisplacement?.atTarget, false);
  assert.deepEqual(partialSegment.partialDisplacement?.to, at(1.5, 62.5, 0.5));
  assert.equal(partial.adapter.xyzTargets.length, 1, '取消后不得再派发动作');
  assert.deepEqual(partial.adapter.xyzTargets[0], at(1.5, 62, 0.5), '派发目标仍是选定落点格心');

  // 2) 已到端点后取消：这段按实测确认，但结局仍是 cancelled、arrived 仍为 false。
  const endpoint = directDropFixture('endpoint');
  t.after(() => endpoint.ctx.memory.close());
  const endpointSegment = await runNavigationSegment(endpoint.ctx, {
    goal: goalOf(at(1, 62, 0)),
    allowed: ['walk', 'step', 'drop'],
    historical: false,
    maxTransitions: 8,
    allowUnknownCorridor: false,
    deadline: Date.now() + 60_000,
    searchBudget: 1,
    searchLimits: { maxNodes: 1 },
  });

  assert.equal(endpointSegment.outcome, 'cancelled', endpointSegment.detail);
  assert.equal(endpointSegment.arrived, false, '取消不能变成到达');
  assert.deepEqual(endpointSegment.waypoint, at(1, 62, 0));
  assert.equal(endpointSegment.searchStatus, 'BUDGET_EXHAUSTED');
  assert.equal(endpointSegment.searches, 1);
  assert.equal(endpointSegment.confirmed.length, 1, '到点取消按实测确认这段下落');
  assert.deepEqual(endpointSegment.confirmed[0]?.measuredFrom, at(0.5, 64, 0.5));
  assert.deepEqual(endpointSegment.confirmed[0]?.measuredTo, at(1.5, 62, 0.5));
  assert.equal(endpointSegment.remaining.length, 0);
  assert.equal(endpointSegment.pathLength, 2);
  assert.equal(endpointSegment.partialDisplacement?.atTarget, true);
  assert.deepEqual(endpointSegment.measuredEnd, at(1.5, 62, 0.5));
  assert.equal(endpoint.adapter.xyzTargets.length, 1, '取消后不得再派发动作');
});
