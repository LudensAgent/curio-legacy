/**
 * P25-F 导航基准 1/3/4/5/6（离线 Fake/回放）。
 *
 * - 基准 2（100 格多段、原目标保留、段正常结束、实测起点续接 + 指标）在
 *   `tests/navigation-segments.test.ts` 扩展，不在此处重复。
 * - 所有移动都走 FakeAdapter 的连续插值 `moveTo`（不是传送冒充）；观察由夹具显式
 *   注入，`memory.visit` 代表 Perception 在实测位置记录的“进入区块”事件，不是导航代写。
 * - 实机 Java 1.20.1 一律 NOT_RUN（P25-G）。离线不证明物理落地/服务端纠正。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { afterStep, beginStep, createActivity, noteNavigationDispatch, nextStep, recordOf, localStepFailure } from '../src/mind/activity.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { fail } from '../src/skills/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
type Cell = { x: number; y: number; z: number };
type Segment = { startStance?: Cell; endStance?: Cell; displacement?: { horizontal: number }; requestedDistance?: { horizontal: number }; invalidation?: string | null; arrivedAtTarget?: boolean };
let sequence = 0;
// 顺序观测使用单调时间戳，避免同一毫秒内覆盖被当成无法排序的冲突证据。
let observedClock = 0;

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

function observeRange(map: VoxelMap, from: number, to: number) {
  const air: Cell[] = [], floor: Cell[] = [];
  for (let x = from; x <= to; x++) for (const z of [-1, 0, 1]) {
    air.push({ x, y: 64, z }, { x, y: 65, z });
    floor.push({ x, y: 63, z });
  }
  observe(map, 'minecraft:air', air);
  observe(map, 'minecraft:stone', floor);
}

function flatGround(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  observeRange(map, -1, xMax);
  return map;
}

/** x=0..xMax 已观测、其余方向无证据的单格宽走廊。 */
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
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter, { deadlineMs: 180_000 }), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

const navArgs = (to: Cell, extra: Record<string, unknown> = {}) => ({
  to, allowed: ['walk', 'step'] as ('walk' | 'step' | 'drop')[],
  historical: true, maxSteps: 8, allowUnknownCorridor: false, ...extra,
});

const noBuild = (adapter: FakeAdapter) => adapter.actions.every((action) => !action.startsWith('dig') && !action.startsWith('place'));

test('基准1：平地 10/20/30 格、非格心起点，实测到达与位移', async (t) => {
  for (const distance of [10, 20, 30]) {
    const map = flatGround(distance + 2);
    const { adapter, ctx } = setup(map);
    t.after(() => ctx.memory.close());
    // 非格心起点：脚位在格内偏移，导航必须从实测位置出发并归位。
    adapter.pos = { x: 0.37, y: 64, z: 0.42 };
    const start = { ...adapter.pos };
    const result = await navigateTo.run(ctx, navArgs({ x: distance, y: 64, z: 0 }, { maxSteps: 64 }));
    assert.equal(result.status, 'succeeded', `${distance} 格：${result.summary}`);
    assert.equal(result.data?.executed, distance, `${distance} 格应有 ${distance} 段实测确认`);
    assert.deepEqual({ x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) }, { x: distance, y: 64, z: 0 });
    const segment = result.data?.segment as Segment;
    const actual = Math.hypot(adapter.pos.x - start.x, adapter.pos.z - start.z);
    const requested = Math.hypot(distance - start.x, 0 - start.z);
    assert.ok(Math.abs((segment.displacement?.horizontal ?? -1) - actual) < 0.01, '实测位移与身体位置一致');
    assert.ok(Math.abs((segment.requestedDistance?.horizontal ?? -1) - requested) < 0.01, '请求距离按实测起点→原目标计算');
    assert.ok(Math.abs(actual - requested) < 1, '到达位移与请求距离差不超过一格（格内偏移）');
    assert.equal(noBuild(adapter), true, '平地基准不挖/不建');
  }
});

test('基准3：小已知区域→未知目的地：走可达前缀、观察刷新证据后继续，不卡在首个 UNKNOWN', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 12, y: 64, z: 0 };

  const first = await navigateTo.run(ctx, navArgs(target));
  assert.equal(first.status, 'failed');
  assert.equal(Math.floor(adapter.pos.x), 3, '先走到已知可达前缀端点');
  assert.equal(first.data?.executed, 3);
  const boundary = first.data?.boundarySummary as { counts: Record<string, number>; observationMayResolve: boolean };
  assert.ok((boundary.counts.UNKNOWN ?? 0) > 0, '停在 UNKNOWN 边界');
  assert.equal(boundary.observationMayResolve, true, '额外观察可能刷新证据');

  // 证据没变：同一 UNKNOWN 边界不能靠原样重试换来移动。
  const actions = adapter.actions.length;
  const repeated = await navigateTo.run(ctx, navArgs(target));
  assert.equal(repeated.status, 'failed');
  assert.equal(adapter.actions.length, actions, '未变化的 UNKNOWN 不重复执行移动');
  assert.deepEqual(repeated.data?.boundarySummary, first.data?.boundarySummary, '同一证据边界如实相同');

  // 显式观察：更新地图（New cells 由夹具观测，不是导航自动写）。
  const observedBefore = map.checkpointFullCounts().observedCells;
  observeRange(map, 4, 7);
  const observedAfter = map.checkpointFullCounts().observedCells;
  assert.ok(observedAfter > observedBefore, '观察必须实际更新空间证据');
  const second = await navigateTo.run(ctx, navArgs(target));
  assert.ok((second.data?.executed as number) >= 3, '新证据下继续推进');
  assert.ok(Math.floor(adapter.pos.x) >= 7, '身体离开首个 UNKNOWN 边界');

  observeRange(map, 8, 12);
  const final = await navigateTo.run(ctx, navArgs(target));
  assert.equal(final.status, 'succeeded', final.summary);
  assert.equal(Math.floor(adapter.pos.x), target.x, '继续观察后到达原目的地');
  assert.equal(noBuild(adapter), true, '前缀/观察循环不挖不建');
  assert.deepEqual(final.data?.remaining, [], '已到达时不再保留剩余目标');
});

test('基准4：路线中阻挡 upcoming 段：立即停、保留实测进度、观察后从实测终点重新规划并继续', async (t) => {
  const map = flatGround(12);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 10, y: 64, z: 0 };
  const activity = createActivity({
    what: '走到 10 格外的目标', why: '验证途中阻挡后重规划', kind: 'explore', repeat: 1,
    steps: [{ skill: 'navigate_to', args: navArgs(target, { maxSteps: 16 }) }, { skill: 'navigate_to', args: navArgs(target, { maxSteps: 16 }) }],
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;

  // 夹具模拟服务器在已确认 3 步后放下墙，并在同一次观察中让 Agent 看见它；
  // voxel A* 只按当前证据决策，不能靠未观察的物理墙让它“凭空”停下。
  const originalMoveTo = adapter.moveTo.bind(adapter);
  let executedMoves = 0;
  adapter.moveTo = async (moveTarget, opts) => {
    await originalMoveTo(moveTarget, opts);
    executedMoves += 1;
    if (executedMoves === 3) {
      adapter.blocks.push({ name: 'stone', pos: { x: 4, y: 64, z: 0 } }, { name: 'stone', pos: { x: 4, y: 65, z: 0 } });
      observe(map, 'minecraft:stone', [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }]);
    }
  };
  const firstStep = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  const blocked = await navigateTo.run(ctx, navArgs(target, { maxSteps: 16 }));
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.data?.executed, 3, '在阻挡前立即停，保留 3 段实测进度');
  assert.deepEqual(adapter.pos, { x: 3.5, y: 64, z: 0.5 }, '身体停在最后实测位置');
  const blocker = blocked.data?.blocker as { status?: string; problem?: string; cell?: Cell };
  assert.equal(blocker.status, 'BLOCKED');
  assert.match(String(blocker.problem), /BLOCKED/);
  assert.deepEqual(blocker.cell, { x: 4, y: 64, z: 0 });
  assert.equal(adapter.actions.length, 3, '阻挡后没有继续迈步或自动挖');

  const verdict = afterStep(activity, firstStep, blocked, 0, adapter.state());
  assert.equal(verdict.kind, 'continue', '已确认段是进展，段结束不按整趟失败');
  assert.equal(activity.failures, 0);
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.completedSegments, 3, '进度保留');
  assert.equal(nav.destination?.x, target.x, '原目标保留');
  assert.ok(nav.remaining.length > 0, '未到的原目标仍在剩余目标里');

  // Agent 观察：墙面变实心，z=1 有可走旁路。
  observe(map, 'minecraft:stone', [{ x: 4, y: 63, z: 0 }, { x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }]);
  observe(map, 'minecraft:air', [3, 4, 5].flatMap((x) => [{ x, y: 64, z: 1 }, { x, y: 65, z: 1 }]));
  observe(map, 'minecraft:stone', [3, 4, 5].map((x) => ({ x, y: 63, z: 1 })));

  const secondStep = nextStep(activity)!;
  assert.equal(secondStep.skill, 'navigate_to');
  noteNavigationDispatch(activity, activity.steps[1]!, adapter.state());
  assert.deepEqual(nav.segmentStart, { x: 3.5, y: 64, z: 0.5 }, '新段从实测终点开始');
  const replanned = await navigateTo.run(ctx, navArgs(target, { maxSteps: 16 }));
  assert.equal(replanned.status, 'succeeded', replanned.summary);
  assert.equal(Math.floor(adapter.pos.x), target.x, '绕开新阻挡后到达原目标');
  assert.deepEqual((replanned.data?.segment as Segment).startStance, { x: 3.5, y: 64, z: 0.5 }, '回执段起点=实测终点');
  const done = afterStep(activity, secondStep, replanned, 0, adapter.state());
  assert.equal(done.kind, 'done');
  assert.equal(done.kind === 'done' ? done.met : undefined, true);
  assert.equal(nav.phase, 'arrived');
  assert.equal(nav.destination?.x, target.x);
  assert.equal(noBuild(adapter), true, '重规划不自动挖/建');
});

test('基准5：多段探索 ≥200 格；新区块/新观测/半径增长，不重复同一失败边界', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  observeRange(map, -1, 20);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 200, y: 64, z: 0 };
  const start = { ...adapter.pos };
  const activity = createActivity({
    what: '多段探索到 200 格外', why: '验证有界分段与观测推进', kind: 'explore', repeat: 1,
    steps: Array.from({ length: 13 }, () => ({ skill: 'navigate_to', args: navArgs(target, { maxSteps: 16 }) })),
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;

  let segments = 0, executedTotal = 0, actualDistance = 0, observedGrowth = 0, chunks = 0, maxRadius = 0;
  const invalidations: string[] = [];
  // P25-F 指标：派发/有进展派发用于完成率；elapsed 用真实性能时钟，不补常数。
  let dispatched = 0, progressDispatches = 0, totalElapsedMs = 0, maxProgressGapMs = 0, lastProgressEnd: number | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const step = nextStep(activity);
    if (step === null) break;
    const template = activity.steps[Math.max(0, activity.index - 1)] ?? step;
    const budget = beginStep(activity, template, adapter.state());
    noteNavigationDispatch(activity, template, adapter.state(), { deadlineMs: budget.deadlineMs });
    assert.equal(nav.destination?.x, target.x, '每一段都保留原目标');
    const startedAt = performance.now();
    const result = await navigateTo.run(ctx, navArgs(target, { maxSteps: 16 }));
    const elapsedMs = performance.now() - startedAt;
    dispatched += 1;
    totalElapsedMs += elapsedMs;
    const segment = result.data?.segment as Segment;
    const executed = Number(result.data?.executed ?? 0);
    assert.ok(executed > 0, `探索第 ${dispatched} 个派发必须有实测进展`);
    progressDispatches += 1;
    if (lastProgressEnd !== null) maxProgressGapMs = Math.max(maxProgressGapMs, startedAt - lastProgressEnd);
    lastProgressEnd = performance.now();
    segments += 1;
    executedTotal += executed;
    actualDistance += segment.displacement?.horizontal ?? 0;
    maxRadius = Math.max(maxRadius, Math.hypot(adapter.pos.x - start.x, adapter.pos.z - start.z));
    const invalidation = segment.invalidation;
    if (invalidation !== undefined && invalidation !== null && invalidation !== 'max_steps') invalidations.push(invalidation);

    const observedBefore = map.checkpointFullCounts().observedCells;
    observeRange(map, Math.floor(adapter.pos.x) + 1, Math.floor(adapter.pos.x) + 24);
    observedGrowth += map.checkpointFullCounts().observedCells - observedBefore;
    // Perception 在实测位置记录“进入区块”；夹具显式调用，不代表导航代写记忆。
    ctx.memory.visit(DIM, adapter.state().pos);
    chunks = ctx.memory.visitedChunkCount;

    const verdict = afterStep(activity, step, result, elapsedMs, adapter.state());
    if (verdict.kind !== 'continue') break;
  }

  assert.equal(Math.floor(adapter.pos.x), target.x, '最终到达原目标');
  assert.ok(segments >= 13, `200 格必须由多段完成（实际 ${segments} 段）`);
  assert.ok(executedTotal >= 200, `确认段数累计 ≥200（实际 ${executedTotal}）`);
  assert.ok(Math.abs(actualDistance - 200) < 1, `实测位移累计≈200（实际 ${actualDistance.toFixed(2)}）`);
  assert.ok(maxRadius >= 199.5, `实测离起点半径增长到目标（实际 ${maxRadius.toFixed(2)}）`);
  assert.ok(chunks >= 12, `进入新区块（实际 ${chunks}）`);
  assert.ok(observedGrowth >= 1000, `新观测格有实际增长（实际 ${observedGrowth}）`);
  assert.deepEqual(invalidations, [], '段边界只有有界 maxSteps，没有 route handle 失效率');
  assert.equal(activity.failures, 0, '有进展的段不按失败累计');
  assert.equal(nav.phase, 'arrived');
  assert.equal(nav.destination?.x, target.x, '原目标跨段保留');
  assert.deepEqual(nav.remaining, []);
  assert.equal(noBuild(adapter), true, '多段探索不自动挖/建');
  assert.equal(segments, 13, '探索由 13 个实测段组成');
  assert.ok(maxProgressGapMs >= 0, '有进展段之间的间隔由真实时间戳计算');

  // 到达后继续朝未观测区域（x=260）派发两次：同一未变化的 UNKNOWN 边界。
  // 第一次只能走到已观测前缀端点，第二次在同一证据下不得再移动；按 from→to+status
  // 去重后只允许 1 个边界键。若实现重新进入未知或把同一失败重复成新边界，下面会失败。
  const boundaryTarget: Cell = { x: 260, y: 64, z: 0 };
  const boundaryActivity = createActivity({
    what: '验证未变化的 UNKNOWN 边界不重复', why: '同一证据下第二次派发', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: navArgs(boundaryTarget, { maxSteps: 64 }) },
      { skill: 'navigate_to', args: navArgs(boundaryTarget, { maxSteps: 64 }) },
    ],
  }, '', 'llm', adapter.state());
  const boundaryNav = boundaryActivity.navigation!;
  const frontierKeyOf = (value: Awaited<ReturnType<typeof navigateTo.run>>): string | null => {
    const boundaries = (value.data?.boundaries ?? []) as { status?: string; direction?: string; from?: Cell; to?: Cell }[];
    const east = boundaries
      .filter((item) => item.status === 'UNKNOWN' && item.direction === 'E' && item.from !== undefined && item.to !== undefined && item.to.x > item.from.x)
      .sort((a, b) => (b.from!.x - a.from!.x))[0];
    return east ? `UNKNOWN|${east.from!.x},${east.from!.y},${east.from!.z}->${east.to!.x},${east.to!.y},${east.to!.z}` : null;
  };
  const attempts: { key: string; executed: number; elapsedMs: number; actions: number }[] = [];
  let stalledMs = 0;
  for (let index = 0; index < 2; index++) {
    const step = nextStep(boundaryActivity);
    assert.ok(step, '边界验证的第二段必须可派发');
    noteNavigationDispatch(boundaryActivity, boundaryActivity.steps[index]!, adapter.state());
    const startedAt = performance.now();
    const result = await navigateTo.run(ctx, navArgs(boundaryTarget, { maxSteps: 64 }));
    const elapsedMs = performance.now() - startedAt;
    dispatched += 1;
    totalElapsedMs += elapsedMs;
    const executed = Number(result.data?.executed ?? 0);
    const key = frontierKeyOf(result);
    assert.ok(key, '未到达时必须报告朝目标的 UNKNOWN 边界键');
    if (executed > 0) {
      progressDispatches += 1;
      if (lastProgressEnd !== null) maxProgressGapMs = Math.max(maxProgressGapMs, startedAt - lastProgressEnd);
      lastProgressEnd = performance.now();
    } else {
      stalledMs += elapsedMs;
    }
    attempts.push({ key, executed, elapsedMs, actions: adapter.actions.length });
    const verdict = afterStep(boundaryActivity, step, result, elapsedMs, adapter.state());
    assert.equal(verdict.kind, index === 0 ? 'continue' : 'stuck', index === 0
      ? '第一次边界尝试有实测前缀进展，应继续下一段'
      : '同一未变化边界第二次派发必须交回 Agent，不自动重试');
  }

  assert.equal(attempts.length, 2);
  assert.ok(attempts[0]!.executed > 0, '第一次只走到已观测前缀端点');
  assert.equal(attempts[1]!.executed, 0, '同一未变化边界第二次不再移动');
  assert.equal(attempts[0]!.key, attempts[1]!.key, '两次遇到的是同一个 from→to+status 边界');
  assert.equal(new Set(attempts.map((item) => item.key)).size, 1, '重复失败边界去重后只有 1 个');
  assert.equal(attempts[1]!.actions, attempts[0]!.actions, '第二次没有新增身体动作');
  assert.equal(boundaryNav.completedSegments, attempts[0]!.executed, '第一次边界前的进度保留');
  assert.equal(boundaryNav.destination?.x, boundaryTarget.x, '边界失败不改目的地');
  assert.equal(boundaryNav.phase, 'failed');
  assert.equal(boundaryActivity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不自动重试未变化边界');

  // 完成率：从实际派发结果计算，不是常数；故意保留一次未变化边界所以 <1。
  assert.equal(dispatched, 15, '13 个探索段 + 2 次边界派发');
  assert.equal(progressDispatches, 14, '13 个探索段 + 第一次边界前缀有实测进展');
  const completionRate = progressDispatches / dispatched;
  assert.ok(Math.abs(completionRate - 14 / 15) < 1e-9, `完成率由实测派发计算（实际 ${completionRate.toFixed(3)}）`);
  assert.ok(completionRate < 1, '存在一次未变化边界，完成率不能恒为 1');
  // 无进展时长：第二次边界派发的真实计时；Activity 回执同时记录该 durationMs。
  assert.ok(stalledMs > 0, `无进展派发必须有真实耗时（实际 ${stalledMs.toFixed(3)}ms）`);
  assert.ok(stalledMs <= totalElapsedMs, '无进展时长是全部派发耗时的一部分');
  assert.ok((boundaryActivity.results.at(-1)?.durationMs ?? 0) > 0, 'Activity 回执记录真实无进展 durationMs');
  // 指标中“每完成任务 LLM 调用数”需要真实 LLM，离线回放 NOT_RUN。
});

test('基准6：资源目标局部未见≠全局缺失；资源活动不自动换维度', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 40, y: 64, z: 0 };
  const activity = createActivity({
    what: '走远找树砍原木', why: '附近没看到树', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: navArgs(target) },
      { skill: 'look_around', args: { for: 'oak_log' } },
    ],
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;

  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  const prefix = await navigateTo.run(ctx, navArgs(target));
  assert.equal(prefix.status, 'failed');
  afterStep(activity, step, prefix, 0, adapter.state());

  step = nextStep(activity)!;
  assert.equal(step.skill, 'look_around');
  const miss = fail('NOT_FOUND', '视野内未见 oak_log', { problem: { kind: 'TARGET_NOT_OBSERVED' } });
  afterStep(activity, step, miss, 0, adapter.state());
  const record = recordOf(activity, 'done', '附近观察未发现', adapter.state(), { newChunks: 0 });

  assert.equal(record.exploration?.localOnly, true, '只在附近观察不能说明远处区域已搜索');
  assert.ok((record.exploration?.maxHorizontal ?? 99) < 8);
  assert.equal(record.resource?.located, false);
  assert.equal(record.resource?.acquired, false);
  assert.equal(record.resource?.goalIncomplete, true, '资源目标未完成只是缺口，不是“全局没有资源”');
  assert.equal(localStepFailure({ skill: 'look_around' }, miss, adapter.state(), 0), null, '观察未命中不是局部移动失败');
  assert.equal(activity.steps.every((item) => item.skill !== 'travel_portal'), true, '宿主没有自动加换维动作');
  assert.equal(adapter.dim, DIM, '资源搜索不自动换维度');
  assert.equal(nav.destination?.x, target.x, '局部未见不改写原导航目标');
  // “换维是 Agent 决策（无证据拒绝一次、有证据/理由放行、空闲不自动换维）”由
  // tests/resource-search-state.test.ts 与 tests/source-switch-gate.test.ts 覆盖，此处不重复。
});

// 基准2 的指标断言在 tests/navigation-segments.test.ts 的 100 格用例内扩展：
// observedSegments/executedTotal/actualDistance/invalidationKinds/activity.failures；
// 显式“重规划事件”数未单独统计，不做重规划计数的 PASS 声明。
