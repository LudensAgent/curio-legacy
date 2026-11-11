/**
 * P25-F 失败分类与有界恢复（离线 Fake 夹具）。
 *
 * 只驱动真实的 `navigate_to` / Activity 分类路径；身体用 FakeAdapter 的连续插值移动，
 * 不把传送当作物理执行。需要“服务器在两段之间纠正/阻挡身体”的场景用夹具显式注入，
 * 并在断言旁注明。实机（Java 1.20.1）一律 NOT_RUN，见 P25-G。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { afterStep, createActivity, noteNavigationDispatch, nextStep } from '../src/mind/activity.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import type { MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const TARGET = { x: 10, y: 64, z: 0 };
let sequence = 0;
// 观测是顺序发生的真实事件；给它们单调递增的时间戳，避免同一毫秒内
// 后一次“覆盖”被 VoxelMap 当成无法排序的冲突证据（conflict → STALE）。
let observedClock = 0;

type Cell = { x: number; y: number; z: number };
type BoundarySummary = { total: number; counts: Record<string, number>; observationMayResolve: boolean; needsExplicitActionOrOtherRoute: boolean };

function observe(map: VoxelMap, name: string, cells: Cell[], observedAt?: number) {
  for (const pos of cells) {
    sequence += 1;
    const at = observedAt ?? (observedClock = Math.max(Date.now(), observedClock + 1));
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: at, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** x=0..xMax 的已观测单格宽走廊；其余方向没有证据。 */
function knownCorridor(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Cell[] = [], floor: Cell[] = [];
  for (let x = 0; x <= xMax; x++) {
    air.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    floor.push({ x, y: 63, z: 0 });
  }
  observe(map, 'minecraft:air', air);
  observe(map, 'minecraft:stone', floor);
  return map;
}

/** 3 格宽平地，用于验证不旁路挖/建。 */
function flatGround(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Cell[] = [], floor: Cell[] = [];
  for (let x = -1; x <= xMax; x++) for (const z of [-1, 0, 1]) {
    air.push({ x, y: 64, z }, { x, y: 65, z });
    floor.push({ x, y: 63, z });
  }
  observe(map, 'minecraft:air', air);
  observe(map, 'minecraft:stone', floor);
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

function setup(map: VoxelMap, opts: { deadlineMs?: number; adapter?: FakeAdapter } = {}) {
  const adapter = opts.adapter ?? new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter, { deadlineMs: opts.deadlineMs ?? 120_000 }), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

const navArgs = (to: Cell = TARGET, extra: Record<string, unknown> = {}) => ({
  to, allowed: ['walk', 'step'] as ('walk' | 'step' | 'drop')[],
  historical: false, maxSteps: 8, allowUnknownCorridor: false, ...extra,
});

function activityFor(adapter: FakeAdapter, to: Cell = TARGET) {
  return createActivity({
    what: '走到远处的目标', why: '先过去看看', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: navArgs(to) },
      { skill: 'look_around', args: { seconds: 1 } },
    ],
  }, '', 'llm', adapter.state());
}

const noBuild = (adapter: FakeAdapter) => adapter.actions.every((action) => !action.startsWith('dig') && !action.startsWith('place'));

/**
 * 9 类失败里的四种“地形证据”分类：UNKNOWN / STALE / BLOCKED / UNSUPPORTED。
 * 同一导航入口、同一目标，只改变已观测证据；断言四类在 boundarySummary / blockerAhead
 * 上可区分，且都不改目的地、不自动挖/建/换材料。
 */
test('UNKNOWN/STALE/BLOCKED/UNSUPPORTED 在导航回执里可区分，且不改目的地', async (t) => {
  const cases: { name: string; status: string; blocker?: string; map: () => VoxelMap }[] = [
    { name: 'UNKNOWN', status: 'UNKNOWN', map: () => knownCorridor(3) },
    {
      name: 'STALE', status: 'STALE', map: () => {
        const map = knownCorridor(3);
        const old = Date.now() - 120_000;
        // 只把前方列观测成旧证据；当前证据不足，不是已观测阻挡。
        observe(map, 'minecraft:air', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }], old);
        observe(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }], old);
        return map;
      },
    },
    {
      name: 'BLOCKED', status: 'BLOCKED', blocker: 'BLOCKED', map: () => {
        const map = knownCorridor(3);
        observe(map, 'minecraft:stone', [63, 64, 65, 66].map((y) => ({ x: 4, y, z: 0 })));
        return map;
      },
    },
    {
      name: 'UNSUPPORTED', status: 'UNSUPPORTED', blocker: 'UNSUPPORTED', map: () => {
        const map = knownCorridor(3);
        // 有可站立地面，但头部是宿主碰撞形状无法判定的方块：能力缺口而非“没路”。
        observe(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }]);
        observe(map, 'minecraft:nether_portal', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }]);
        return map;
      },
    },
  ];
  const facts: Record<string, { counts: Record<string, number>; blocker?: string; observationMayResolve: boolean; needsAction: boolean }> = {};

  for (const item of cases) {
    const map = item.map();
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const inventoryBefore = JSON.stringify(adapter.state().inventory);
    const result = await navigateTo.run(ctx, navArgs());
    const summary = result.data?.boundarySummary as BoundarySummary;
    assert.equal(result.status, 'failed', `${item.name} 不应被当到达：${result.summary}`);
    assert.ok((summary.counts[item.status] ?? 0) > 0, `${item.name} 边界计数必须可读：${JSON.stringify(summary)}`);
    assert.deepEqual(result.data?.requestedTarget, TARGET, `${item.name} 保留原目的地`);
    assert.deepEqual((result.data?.segment as { remainingTarget?: Cell }).remainingTarget, TARGET, `${item.name} 剩余目标仍是原目的地`);
    assert.equal((result.data?.segment as { arrivedAtTarget?: boolean }).arrivedAtTarget, false);
    assert.equal(adapter.dim, DIM, `${item.name} 不换维度`);
    assert.equal(JSON.stringify(adapter.state().inventory), inventoryBefore, `${item.name} 不改材料预算`);
    assert.equal(noBuild(adapter), true, `${item.name} 不自动挖/建`);
    if (item.name === 'UNKNOWN' || item.name === 'STALE') {
      assert.equal(summary.observationMayResolve, true, `${item.name} 额外观察可能解决`);
      assert.equal(result.data?.blockerAhead, undefined, `${item.name} 不是已观测阻挡`);
    } else {
      assert.equal(summary.needsExplicitActionOrOtherRoute, true, `${item.name} 需要显式动作/换路线`);
      assert.equal((result.data?.blockerAhead as { status?: string } | undefined)?.status, item.blocker, `${item.name} blocker 状态`);
    }
    facts[item.name] = {
      counts: summary.counts, blocker: (result.data?.blockerAhead as { status?: string } | undefined)?.status,
      observationMayResolve: summary.observationMayResolve, needsAction: summary.needsExplicitActionOrOtherRoute,
    };
  }

  // 四类不是同一个事实：STALE 有 stale 计数，BLOCKED/UNSUPPORTED 有各自 blocker，UNKNOWN 只有证据缺口。
  assert.equal(facts.STALE!.counts.STALE! > 0, true);
  assert.equal(facts.BLOCKED!.blocker, 'BLOCKED');
  assert.equal(facts.UNSUPPORTED!.blocker, 'UNSUPPORTED');
  assert.equal(facts.UNKNOWN!.blocker, undefined);
  assert.notDeepEqual(facts.UNKNOWN!.counts, facts.STALE!.counts);
  assert.notEqual(facts.BLOCKED!.blocker, facts.UNSUPPORTED!.blocker);
});

test('STALE 刷新证据后重新规划；BLOCKED/UNSUPPORTED 在证据不变时不重复移动', async (t) => {
  // BLOCKED：同一证据下第二次调用不移动、相同边界；这不是自动重试。
  {
    const map = knownCorridor(3);
    observe(map, 'minecraft:stone', [63, 64, 65, 66].map((y) => ({ x: 4, y, z: 0 })));
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const first = await navigateTo.run(ctx, navArgs());
    const actions = adapter.actions.length;
    const second = await navigateTo.run(ctx, navArgs());
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    // 证据没变时只会绕向尚未试过的前沿点再看；不穿墙、不挖不放。
    assert.ok(adapter.actions.length >= actions);
    assert.ok(adapter.actions.every((action) => action.startsWith('moveTo')));
    assert.ok(Math.floor(adapter.pos.x) < 4, '没有穿过墙所在列');
  }
  // UNSUPPORTED：重新观测后能力缺口消失，可从原位置继续。
  {
    const map = knownCorridor(3);
    observe(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }]);
    observe(map, 'minecraft:nether_portal', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }]);
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const blocked = await navigateTo.run(ctx, navArgs());
    assert.equal((blocked.data?.blockerAhead as { status?: string } | undefined)?.status, 'UNSUPPORTED');
    assert.equal(adapter.actions.length, 0, '能力缺口前不自动前进');
    // 显式观察：同一格现在确认是空气（世界已变化/更清晰的证据），不是宿主改挖法。
    observe(map, 'minecraft:air', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }]);
    observe(map, 'minecraft:air', [5, 6].flatMap((x) => [{ x, y: 64, z: 0 }, { x, y: 65, z: 0 }]));
    observe(map, 'minecraft:stone', [5, 6].map((x) => ({ x, y: 63, z: 0 })));
    const progress = await navigateTo.run(ctx, navArgs());
    assert.ok((progress.data?.executed as number) > 0, '刷新证据后应沿新证据前进');
    assert.ok(Math.floor(adapter.pos.x) >= 4, '身体实际进入旧缺口后的位置');
  }
  // STALE：刷新过期列后重新规划到目标。
  {
    const map = knownCorridor(3);
    const old = Date.now() - 120_000;
    observe(map, 'minecraft:air', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }], old);
    observe(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }], old);
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const stale = await navigateTo.run(ctx, navArgs());
    assert.ok(((stale.data?.boundarySummary as BoundarySummary).counts.STALE ?? 0) > 0);
    // 刷新 x=4..10 的当前证据后再走同一目标。
    observe(map, 'minecraft:air', [4, 5, 6, 7, 8, 9, 10].flatMap((x) => [{ x, y: 64, z: 0 }, { x, y: 65, z: 0 }]));
    observe(map, 'minecraft:stone', [4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, y: 63, z: 0 })));
    const refreshed = await navigateTo.run(ctx, navArgs());
    assert.equal(refreshed.status, 'succeeded', refreshed.summary);
    assert.equal(Math.floor(adapter.pos.x), TARGET.x);
  }
});

test('START_CHANGED：起点漂移按实测位置重规划，不重放旧段；Activity 保留原目的地', async (t) => {
  const map = flatGround(8);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  // 夹具模拟“服务器在第一步确认后纠正了身体位置”，不是导航自己传送。
  let corrections = 1;
  const correctedCtx = {
    ...ctx,
    progress() {
      if (corrections > 0) { corrections -= 1; adapter.pos = { ...adapter.pos, x: adapter.pos.x + 1 }; }
    },
  };
  const activity = activityFor(adapter, { x: 5, y: 64, z: 0 });
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  const result = await navigateTo.run(correctedCtx, navArgs({ x: 5, y: 64, z: 0 }));
  // B5 的 Coordinator 契约：旧段起点与实测不一致时只丢弃该段几何，按实测位置
  // 重规划原目标；已确认的段和真实位置保留，不重放旧起点动作。
  assert.equal(result.status, 'succeeded', result.summary);
  const replans = result.data?.replans as { reason: string; plannedStart?: Cell; measuredEnd?: Cell }[] | undefined;
  assert.equal(replans?.length, 1, '应恰好丢弃一次旧段几何');
  assert.deepEqual(replans![0]!.plannedStart, { x: 1.5, y: 64, z: 0.5 }, '被丢弃的是旧计划起点');
  assert.deepEqual(replans![0]!.measuredEnd, { x: 2.5, y: 64, z: 0.5 }, '重规划使用实际纠正后的位置');
  assert.match(replans![0]!.reason, /不一致/);
  assert.deepEqual(adapter.pos, { x: 5.5, y: 64, z: 0.5 }, '最终实测位置应到达原目标');
  assert.deepEqual((result.data?.segment as { remainingTarget?: Cell }).remainingTarget, { x: 5, y: 64, z: 0 });
  assert.equal(noBuild(adapter), true);

  const verdict = afterStep(activity, step, result, 0, adapter.state());
  assert.equal(verdict.kind, 'continue', '成功到达后交给后续步骤');
  assert.equal(nav.destination?.x, 5, '原目的地保留');
  assert.deepEqual(nav.measured.pos, { x: 5.5, y: 64, z: 0.5 });
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  // 旧 walk_path route handle 已退役；本用例只补 navigate_to 的起点漂移分支。
});

test('NOT_CONFIRMED：身体没有实际位移时立即停，不自动重试、不改目标', async (t) => {
  // 夹具模拟服务器接受移动请求但没有移动身体：动作报完成而实测不成立。
  class NoMoveAdapter extends FakeAdapter {
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      this.actions.push(`moveTo:${target.kind}`);
      void opts;
    }
  }
  const map = flatGround(8);
  const { adapter, ctx } = setup(map, { adapter: new NoMoveAdapter() });
  t.after(() => ctx.memory.close());
  const result = await navigateTo.run(ctx, navArgs({ x: 5, y: 64, z: 0 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal((result.data?.segment as { invalidation?: string }).invalidation, 'effect_not_confirmed');
  // 子动作报“完成”但实测不成立，失败在分段层由实测位置确认；保留 PHYSICAL_FAILURE
  // 与 effect_not_confirmed 两个事实，不把未确认改写成成功。
  assert.equal((result.data?.stop as { reason?: string } | undefined)?.reason, 'PHYSICAL_FAILURE');
  assert.equal(result.data?.executed, 0);
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 }, '身体没动');
  assert.deepEqual((result.data?.segment as { remainingTarget?: Cell }).remainingTarget, { x: 5, y: 64, z: 0 });
  assert.equal(noBuild(adapter), true);

  const activity = activityFor(adapter, { x: 5, y: 64, z: 0 });
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  const verdict = afterStep(activity, step, result, 0, adapter.state());
  assert.equal(verdict.kind, 'stuck', '没有新位移/新证据时原样重放不会改变结果');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不进入自动重试');
  assert.equal(nav.phase, 'failed');
  assert.equal(nav.destination?.x, 5, '失败不改目的地');
  assert.equal(adapter.dim, DIM);
});

test('TIMEOUT/CANCELLED 只保留已测事实，不移动、不改目标', async (t) => {
  // 期限已过：规划回执仍给出剩余路线，但执行前即超时停。
  {
    const map = flatGround(8);
    const { adapter, ctx } = setup(map, { deadlineMs: -1 });
    t.after(() => ctx.memory.close());
    const result = await navigateTo.run(ctx, navArgs({ x: 5, y: 64, z: 0 }));
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'TIMEOUT');
    assert.equal(result.data?.executed, 0);
    assert.ok((result.data?.remaining as unknown[]).length > 0, '超时保留剩余路线');
    assert.deepEqual((result.data?.segment as { remainingTarget?: Cell }).remainingTarget, { x: 5, y: 64, z: 0 });
    assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
    assert.equal(adapter.actions.length, 0);

    const activity = activityFor(adapter, { x: 5, y: 64, z: 0 });
    const nav = activity.navigation!;
    const step = nextStep(activity)!;
    noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
    assert.equal(afterStep(activity, step, result, 0, adapter.state()).kind, 'stuck', '没有位移时超时不自动重放');
    assert.equal(nav.destination?.x, 5, '超时保留原目的地');
  }
  // 取消：不移动、不把请求坐标冒充实测位置。
  {
    const map = flatGround(8);
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    const controller = new AbortController();
    controller.abort();
    const result = await navigateTo.run({ ...ctx, signal: controller.signal }, navArgs({ x: 5, y: 64, z: 0 }));
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.data?.position, { x: 0.5, y: 64, z: 0.5 });
    assert.deepEqual(result.data?.requestedTarget, { x: 5, y: 64, z: 0 });
    assert.equal(adapter.actions.length, 0, '取消不产生身体动作');
  }
  // Cancelled 后 Activity 保留已确认段/原目的地由 tests/navigation-segments.test.ts
  // （取消：已确认段与实测位置保留）覆盖，本用例只补 navigate_to 的取消入口事实。
});

test('未变化的确定性失败不重复、不擅自改目的地/维度/挖法/材料', async (t) => {
  const map = knownCorridor(3);
  observe(map, 'minecraft:stone', [63, 64, 65, 66].map((y) => ({ x: 4, y, z: 0 })));
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const activity = createActivity({
    what: '走到被墙挡住的目标', why: '验证确定性失败不重放', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: navArgs(TARGET) },
      { skill: 'navigate_to', args: navArgs(TARGET) },
    ],
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;
  const inventory = JSON.stringify(adapter.state().inventory);

  const firstStep = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  const first = await navigateTo.run(ctx, navArgs(TARGET));
  assert.equal(first.status, 'failed');
  assert.equal((first.data?.blockerAhead as { status?: string } | undefined)?.status, 'BLOCKED');
  const verdict = afterStep(activity, firstStep, first, 0, adapter.state());
  assert.ok(verdict.kind === 'stuck' || verdict.kind === 'continue', '确定性阻挡交回 Agent；绕向前沿点有实测位移时按进展继续');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  assert.equal(nav.destination?.x, TARGET.x);
  assert.equal(adapter.dim, DIM);
  assert.equal(JSON.stringify(adapter.state().inventory), inventory, '不改材料预算');
  assert.ok(adapter.actions.every((action) => action.startsWith('moveTo')), '只迈步，不挖不放');
  assert.equal(noBuild(adapter), true);
});
