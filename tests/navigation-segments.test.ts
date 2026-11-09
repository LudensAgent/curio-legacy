import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VoxelMap, type RoutePlan, type RoutePlanRegistryProblem } from 'curio-minecraft-3d-memory';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, beginStep, createActivity, describeActivity, markContinuation, noteNavigationDispatch, nextStep, retargetNavigation } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { ROUTE_REGISTRY_PROBLEM_KINDS, clearRouteRecords, consumeRoutePlan, isRouteRegistryProblem, noteRouteScope, planRoute } from '../src/skills/movement/route.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { walkPath } from '../src/skills/movement/walk.ts';
import { fail, ok, validateSkill, type LandingOption, type SkillCtx } from '../src/skills/types.ts';
import type { MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const SCOPE = { worldId: WORLD, dim: DIM, sessionId: SESSION };
const DESTINATION = { x: 100, y: 64, z: 0 };

function flatMap(xMax: number, zMax = 1) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= xMax; x++) for (let z = -zMax; z <= zMax; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: y === 63 ? 'stone' : 'air', properties: {} }, pos: { x, y, z },
    });
  }
  return map;
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
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
    attach: () => ({}),
    detach: () => {},
  } as unknown as SharedSpatialSession;
}

function flatAdapter() {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  return adapter;
}

function activityWith(adapter: FakeAdapter, steps: { skill: string; args?: unknown }[], extra: Record<string, unknown> = {}) {
  return createActivity({ what: '走到远处的目标', why: '先过去看看', kind: 'explore', repeat: 1, steps, ...extra } as Parameters<typeof createActivity>[0], '', 'llm', adapter.state());
}

function ctxFor(adapter: FakeAdapter, map: VoxelMap): SkillCtx {
  return { ...makeCtx(adapter, { deadlineMs: 300_000 }), spatial: fakeSpatial(map) };
}

const routeProblem = (value: RoutePlan | RoutePlanRegistryProblem) => (value as { kind?: string }).kind;

function mindFixture(t: TestContext) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'mock' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, {
    name: 'nav-segments-test',
    complete: async () => ({ text: JSON.stringify({ decision: 'continue', monologue: '继续观察' }), latencyMs: 1 }),
  }, adapter, memory, bus, null);
  const mind = new Mind({
    adapter, arbiter, perception, memory, bus, self: new SelfModel(null, []), persona: '你叫 Curio。',
    thinker: new Thinker(planner, adapter, memory, bus, null),
  });
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); });
  return { adapter, mind, arbiter };
}

/**
 * 100 格目标由同一委托的多段 navigate_to 完成。每段都是一次显式派发：
 * 起点必须等于上一段实测终点，单段上限保持 16，绝不为凑距离提高上限。
 */
test('100 格目标由同委托多段 navigate_to 完成；每段起点=上段实测终点', async (t) => {
  const map = flatMap(101);
  const adapter = flatAdapter();
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());
  // 显式写 7 段 navigate_to（16×7 > 100），全程同一 Activity/同一 delegation。
  const steps = Array.from({ length: 7 }, () => ({ skill: 'navigate_to', args: { to: DESTINATION, allowed: ['walk', 'step'], historical: true, maxSteps: 16 } }));
  const activity = activityWith(adapter, steps, { repeat: 1 });
  const nav = activity.navigation!;

  let previousEnd = { ...adapter.pos };
  let segments = 0;
  // P25-F 指标：实测段数、确认段数、实测位移累计、失效数。段界 maxSteps 不是失效；
  // 这里不单独统计“重规划事件”——每个显式步骤都是一次新的搜索，没有单独的重规划计数器。
  let executedTotal = 0, actualDistance = 0;
  const invalidations: string[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const step = nextStep(activity);
    if (!step) break;
    const template = activity.steps[Math.max(0, activity.index - 1)] ?? step;
    const budget = beginStep(activity, template, adapter.state());
    noteNavigationDispatch(activity, template, adapter.state(), { deadlineMs: budget.deadlineMs });
    assert.deepEqual(nav.segmentStart, previousEnd, `第 ${segments + 1} 段起点必须是上段实测终点`);
    assert.deepEqual(nav.measured.pos, previousEnd, '派发前先用实测位置复核');
    assert.equal(nav.destination?.x, DESTINATION.x, '原目的地不被中间段替换');
    const described = describeActivity(activity, adapter.state()).navigation as Record<string, unknown>;
    assert.equal(described.parent_deadline_ms, budget.deadlineMs);
    assert.ok(typeof described.parent_budget_remaining_ms === 'number'
      && (described.parent_budget_remaining_ms as number) >= 0, '父预算剩余按现有账本如实展示');

    const validated = validateSkill(navigateTo, step.args, adapter);
    assert.ok(validated.ok, validated.ok ? '' : validated.error);
    const result = await navigateTo.run(ctx, validated.args);
    const state = adapter.state();
    const segment = result.data?.segment as {
      startStance?: { x: number }; backend?: string;
      requestedDistance?: { horizontal: number; euclidean: number };
      displacement?: { horizontal: number };
      invalidation?: string | null;
    } | undefined;
    assert.equal(segment?.startStance?.x, previousEnd.x, '执行器报告的段起点与实测一致');
    assert.equal(segment?.backend, 'land-search', '段回执写明路线 backend');
    const expectedRequested = Math.hypot(DESTINATION.x - previousEnd.x, DESTINATION.z - previousEnd.z);
    assert.ok(Math.abs((segment?.requestedDistance?.horizontal ?? -1) - expectedRequested) < 0.01,
      '请求距离按实测起点→原目标如实计算，不用计划点冒充');
    const verdict = afterStep(activity, step, result, 0, state);
    const executed = Number(result.data?.executed ?? 0);
    executedTotal += executed;
    actualDistance += segment?.displacement?.horizontal ?? 0;
    const invalidation = segment?.invalidation;
    if (invalidation && !['max_steps', 'deadline', 'prefix_boundary'].includes(invalidation)) invalidations.push(invalidation);
    segments += 1;
    previousEnd = { ...state.pos };
    if (verdict.kind !== 'continue') break;
  }

  assert.ok(segments >= 2, '100 格必须由多段完成，而不是单段全走完');
  assert.ok(executedTotal >= 100, `确认段数跨段累计 ≥100（实际 ${executedTotal}）`);
  assert.ok(Math.abs(actualDistance - 100) < 0.5, `实测位移累计≈100（实际 ${actualDistance.toFixed(2)}）`);
  assert.deepEqual(invalidations, [], '正常段界不计为 route handle 失效');
  assert.equal(activity.failures, 0, '有确认段的段结束不按失败累计');
  assert.equal(Math.floor(adapter.pos.x), DESTINATION.x, '最终到达原目的地');
  assert.equal(nav.phase, 'arrived');
  assert.equal(nav.destination?.x, DESTINATION.x, '到达后原目的地仍是 100');
  assert.deepEqual(nav.remaining, []);
  assert.ok(nav.completedSegments >= 100, `确认段数跨段累计（实际 ${nav.completedSegments}）`);
  assert.equal(adapter.actions.filter((a) => a.startsWith('dig') || a.startsWith('place')).length, 0, '多段续接不自动挖/放');
  assert.equal(adapter.actions.every((a) => a === 'moveTo:xyz' || a === 'moveTo:pos'), true, '只用已规划路线移动，没有 pathfinder/施工动作');
});

test('段正常结束（未到）不算失败；超时/取消保留确认段与剩余目标', () => {
  const adapter = flatAdapter();
  const activity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 80, y: 64, z: 0 }, maxSteps: 16 } },
    { skill: 'navigate_to', args: { to: { x: 80, y: 64, z: 0 }, maxSteps: 16 } },
  ]);
  const nav = activity.navigation!;
  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 16.5, y: 64, z: 0.5 };
  // 单段上限耗尽：有实测确认的行进，但没到原目的地。
  let verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '已执行前 16 段，未到终点', {
    executed: 16, to: { x: 80, y: 64, z: 0 }, position: { ...adapter.pos },
    remaining: [{ to: { x: 17, y: 64, z: 0 } }], segment: { arrivedAtTarget: false, invalidation: 'max_steps' },
  }), 0, adapter.state());
  assert.equal(verdict.kind, 'continue', '段正常结束还有下一段，是进展不是失败');
  assert.equal(activity.failures, 0);
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.completedSegments, 16);
  assert.equal(nav.destination?.x, 80);
  assert.ok(nav.remaining.length > 0, '未到的原目的地仍在剩余目标里');

  // 超时：保留已确认段、实测位置和原目的地。
  step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[1]!, adapter.state());
  adapter.pos = { x: 20.5, y: 64, z: 0.5 };
  verdict = afterStep(activity, step, fail('TIMEOUT', 'navigate_to 期限耗尽：已执行 4/… 段', {
    executed: 4, to: { x: 80, y: 64, z: 0 }, position: { ...adapter.pos },
    remaining: [{ to: { x: 21, y: 64, z: 0 } }], segment: { arrivedAtTarget: false, invalidation: 'deadline' },
  }), 0, adapter.state());
  // 这是活动声明的最后一段：未到终点时收工为“未满足”，不是失败，也不重放。
  assert.equal(verdict.kind, 'done', '最后一段超时收工为 done（未满足），不是 stuck');
  assert.equal(verdict.kind === 'done' ? verdict.met : undefined, false, '收工未满足，不是到达');
  assert.equal(nav.completedSegments, 20, '超时不清空已确认段');
  assert.equal(nav.destination?.x, 80);
  assert.deepEqual(nav.measured.pos, { ...adapter.pos });
  assert.ok(nav.remaining.length > 0, '超时后当前计划的剩余目标仍保留');
  assert.equal(nav.remaining[0]?.x, 21, '剩余目标按回执更新，不丢当前计划');

  // 取消：已确认段与实测位置保留，交回 Agent，不按整趟失败重放。
  const cancelledActivity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 80, y: 64, z: 0 }, maxSteps: 16 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const cancelledNav = cancelledActivity.navigation!;
  const cancelledStep = nextStep(cancelledActivity)!;
  noteNavigationDispatch(cancelledActivity, cancelledActivity.steps[0]!, adapter.state());
  adapter.pos = { x: 24.5, y: 64, z: 0.5 };
  verdict = afterStep(cancelledActivity, cancelledStep, {
    status: 'cancelled', summary: 'navigate_to 被取消', data: {
      executed: 2, to: { x: 80, y: 64, z: 0 }, position: { ...adapter.pos },
      remaining: [{ to: { x: 25, y: 64, z: 0 } }], segment: { arrivedAtTarget: false },
    },
  }, 0, adapter.state());
  assert.equal(verdict.kind, 'continue', '取消不触发重试/重放');
  assert.equal(cancelledNav.phase, 'cancelled');
  assert.equal(cancelledNav.completedSegments, 2, '取消保留确认段');
  assert.equal(cancelledNav.destination?.x, 80, '取消保留原目的地');
  assert.deepEqual(cancelledNav.measured.pos, { ...adapter.pos });
});

test('executed=0 的段失败也保留当前计划剩余目标，且不自动重试', () => {
  const adapter = flatAdapter();
  const activity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  // 身体没有位移，executed=0；回执仍带逾期前计划的剩余段。
  const verdict = afterStep(activity, step, fail('TIMEOUT', 'navigate_to 期限耗尽：已执行 0 段', {
    executed: 0, to: { x: 40, y: 64, z: 0 }, position: { ...adapter.pos },
    remaining: [{ to: { x: 1, y: 64, z: 0 } }], segment: { arrivedAtTarget: false, invalidation: 'deadline' },
  }), 0, adapter.state());
  assert.equal(verdict.kind, 'stuck', 'executed=0 且身体没动：不自动重试');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  assert.equal(nav.phase, 'failed');
  assert.equal(nav.destination?.x, 40, '原目的地保留');
  assert.deepEqual(nav.measured.pos, { ...adapter.pos }, '实测位置保留');
  assert.deepEqual(nav.remaining, [{ x: 1, y: 64, z: 0 }], 'executed=0 的失败也保留当前计划剩余目标');
});

test('route-handle 谓词收口：注册表 6 种与库失效原因保持区分', () => {
  assert.deepEqual([...ROUTE_REGISTRY_PROBLEM_KINDS].sort(), [
    'invalid_request', 'route_consumed', 'route_expired', 'route_not_executable', 'route_not_found', 'scope_mismatch',
  ]);
  assert.equal(isRouteRegistryProblem('route_consumed'), true);
  assert.equal(isRouteRegistryProblem('route_invalidated'), false, '库失效原因不是注册表问题');
  assert.equal(isRouteRegistryProblem('route_start_changed'), false);
  assert.equal(isRouteRegistryProblem(undefined), false);
});

test('STARTED/FOUND/空 trace/Promise 完成都不算到达', () => {
  const cases: Record<string, unknown>[] = [
    { stage: 'STARTED' },
    { outcome: 'STARTED' },
    { outcome: 'FOUND' },
    { trace: [] },
    { outcome: 'PARTIAL', confirmedSegments: 0, trace: [] },
    { segment: { arrivedAtTarget: false }, trace: [] },
  ];
  for (const data of cases) {
    const adapter = flatAdapter();
    const activity = activityWith(adapter, [{ skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 8 } }]);
    const nav = activity.navigation!;
    const step = nextStep(activity)!;
    noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
    afterStep(activity, step, ok('动作调用完成', data), 0, adapter.state());
    assert.notEqual(nav.phase, 'arrived', `不得从 ${JSON.stringify(data)} 推断到达`);
    assert.equal(nav.destination?.x, 40, '未到达时原目的地保留');
    assert.equal(nav.lastConfirmed, undefined, '没有实测落点证据不写 lastConfirmed');
  }

  // 只有明确 ARRIVED / segment.arrivedAtTarget 才算到达（正例）。
  for (const data of [
    { outcome: 'ARRIVED', requestedTarget: { x: 40, y: 64, z: 0 }, position: { x: 40.5, y: 64, z: 0.5 } },
    { segment: { arrivedAtTarget: true }, requestedTarget: { x: 40, y: 64, z: 0 }, position: { x: 40.5, y: 64, z: 0.5 } },
  ]) {
    const adapter = flatAdapter();
    const activity = activityWith(adapter, [{ skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 8 } }]);
    const nav = activity.navigation!;
    const step = nextStep(activity)!;
    noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
    afterStep(activity, step, ok('到达', data), 0, adapter.state());
    assert.equal(nav.phase, 'arrived', `明确到达证据应判到达：${JSON.stringify(data)}`);
    assert.deepEqual(nav.lastConfirmed?.pos, { x: 40.5, y: 64, z: 0.5 });
  }
});

class DropWorld extends FakeAdapter {
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'xyz') { this.pos = { x: target.x, y: target.y, z: target.z }; return; }
    return super.moveTo(target, opts);
  }
}

function observeAs(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], startSequence = 0) {
  let sequence = startSequence;
  for (const pos of cells) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
  return sequence;
}

test('段回执 backend 按实际产出区分：land-search / direct-drop / none', async (t) => {
  // land-search 已在 100 格用例断言；这里补 direct-drop 与完全无路线。
  const dropMap = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 60; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  const seq = observeAs(dropMap, 'minecraft:air', air);
  observeAs(dropMap, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }, { x: 1, y: 61, z: 0 }], seq);
  const dropAdapter = new DropWorld();
  dropAdapter.groundY = -100;
  dropAdapter.pos = { x: 0.5, y: 64, z: 0.5 };
  dropAdapter.worldId = WORLD; dropAdapter.sessionId = SESSION; dropAdapter.dim = DIM;
  dropAdapter.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }, { name: 'stone', pos: { x: 1, y: 61, z: 0 } });
  const dropCtx = { ...makeCtx(dropAdapter), spatial: fakeSpatial(dropMap) };
  const option: LandingOption = {
    target: { x: 1.5, y: 62, z: 0.5 }, support: { pos: { x: 1, y: 61, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 62, drop: 2, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, at: Date.now(), from: { ...dropAdapter.pos }, onGround: true },
  };
  dropCtx.senses.landingOptions = () => [{ ...option, receipt: { ...option.receipt, at: Date.now(), from: { ...dropAdapter.pos }, observationId: dropAdapter.state().observationId } }];
  t.after(() => dropCtx.memory.close());
  const dropped = await navigateTo.run(dropCtx, {
    to: { x: 1, y: 62, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(dropped.status, 'succeeded', dropped.summary);
  assert.equal((dropped.data?.segment as { backend?: string } | undefined)?.backend, 'direct-drop', '相邻下落直执行不能标成 land-search');

  // 完全无可用路线：段回执标 none，不冒充 land-search。
  const barren = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  observeAs(barren, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  observeAs(barren, 'minecraft:air', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }], 1);
  const barrenCtx = ctxFor(flatAdapter(), barren);
  t.after(() => barrenCtx.memory.close());
  const none = await navigateTo.run(barrenCtx, {
    to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(none.status, 'failed');
  assert.equal((none.data?.segment as { backend?: string } | undefined)?.backend, 'none');
});

test('navigate_to 单段上限保持 64，不允许用更大上限代替续接', () => {
  const adapter = flatAdapter();
  const base = { to: { x: 10, y: 64, z: 0 } };
  assert.equal(validateSkill(navigateTo, { ...base, maxSteps: 64 }, adapter).ok, true);
  const tooLarge = validateSkill(navigateTo, { ...base, maxSteps: 65 }, adapter);
  assert.equal(tooLarge.ok, false, '超过 64 的单段上限必须被拒绝');
});

test('repeat>1 里已消费的注册表 routeId 诚实停止：不自动重试、不静默重放', async (t) => {
  clearRouteRecords();
  t.after(clearRouteRecords);
  const map = flatMap(4);
  const adapter = flatAdapter();
  const ctx = ctxFor(adapter, map);
  t.after(() => ctx.memory.close());
  // 先由真实 plan_route 签发 routeId，再真消费一次（等价于第一次 walk_path 的语义）。
  noteRouteScope(SCOPE);
  const planned = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  assert.match(routeId, /^rt_\d+_\d+$/);
  const consumed = consumeRoutePlan(routeId, SCOPE);
  assert.ok('backend' in consumed, '第一次消费拿到真实计划，不是未注册 handle');
  assert.equal(routeProblem(consumeRoutePlan(routeId, SCOPE)), 'route_consumed');

  const activity = activityWith(adapter, [{ skill: 'walk_path', args: { routeId } }], { repeat: 2 });
  const nav = activity.navigation!;
  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 2.5, y: 64, z: 0.5 };
  // 第一轮部分确认，索引正常前进。
  let verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '只确认了部分路段', {
    routeId, outcome: 'PARTIAL', confirmedSegments: 2, confirmed: false,
    requestedTarget: { x: 10, y: 64, z: 0 }, position: { ...adapter.pos },
    remainingPoints: [{ x: 3, y: 64, z: 0 }],
  }), 0, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.equal(nav.completedSegments, 2);

  // 第二轮重复同一 routine：既有路径会再次派出同一个已消费 handle，交给真实 walk_path 执行。
  step = nextStep(activity)!;
  assert.equal(step.skill, 'walk_path');
  assert.equal((step.args as { routeId?: string }).routeId, routeId, '既有 repeat 路径确实会重复同一逻辑步骤');
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 2.5, y: 64, z: 0.5 };
  const indexBefore = activity.index;
  const walked = await walkPath.run(ctx, { routeId });
  assert.equal(walked.status, 'failed');
  assert.equal(walked.data?.outcome, 'INVALIDATED');
  assert.equal((walked.data?.invalidation as { reason?: string } | null)?.reason, 'route_consumed', '注册表真实拒绝已消费 handle');
  verdict = afterStep(activity, step, walked, 0, adapter.state());
  assert.equal(verdict.kind, 'stuck', '已消费 handle 必须诚实停止并交回 Agent');
  assert.equal(activity.index, indexBefore, '不把已消费 handle 重新插回执行队列');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不进入通用自动重试');
  assert.deepEqual(adapter.actions, [], '没有执行任何重放动作');
  assert.equal(nav.lastRoute?.id, routeId);
  assert.equal(nav.lastRoute?.valid, false, '旧 handle 被标记为失效');
  assert.equal(nav.phase, 'replanning', 'Activity 导航状态如实标记需要重规划');
  assert.equal(nav.destination?.x, 10);
  assert.equal(nav.completedSegments, 2, '已确认段不因 handle 失效丢失');
});

test('仅换维（sessionId 不变）也作废旧 route handle，保留目的地与已完成段', (t) => {
  const { adapter, mind } = mindFixture(t);
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  mind.tick(); // 建立 lastSession/lastDim/seenAlive

  const activity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 30, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'navigate_to', args: { to: { x: 30, y: 64, z: 0 }, maxSteps: 8 } },
  ]);
  const nav = activity.navigation!;
  nav.completedSegments = 3;
  nav.lastRoute = { id: 'rt_old', source: 'search', valid: true, confirmed: 3 };
  mind.activity = activity;

  // 暂停保证这一拍只处理“仅换维”分支，不接着派发下一步（否则 noteNavigationDispatch 会把 phase 改成 executing）。
  mind.paused = true;
  // 只改维度，sessionId/世界保持不变：走 mind.ts 的“仅换维”分支，而不是 session 变更分支。
  adapter.pos = { x: 6.5, y: 64, z: 0.5 };
  adapter.dim = 'the_nether';
  mind.tick();

  assert.equal(mind.activity, activity, '仅换维不丢弃当前 Activity（没有 session 变更）');
  assert.equal(nav.phase, 'replanning');
  assert.equal(nav.lastRoute?.valid, false, '旧维度 handle 不可复用');
  assert.equal(nav.destination?.x, 30, '换维不改写原目的地');
  assert.equal(nav.completedSegments, 3, '已完成段保留');
  assert.deepEqual(nav.measured.pos, { ...adapter.pos }, '实测位置更新为换维后的位置');
  assert.equal(nav.dim, 'the_nether');
  assert.equal(nav.worldId, WORLD);
});

test('过期/失效 route handle 不会在自动续跑里被原样重放', () => {
  for (const invalidation of ['route_expired', 'route_start_changed', 'route_invalidated']) {
    const adapter = flatAdapter();
    const activity = activityWith(adapter, [{ skill: 'walk_path', args: { routeId: 'rt_stale' } }]);
    const nav = activity.navigation!;
    const step = nextStep(activity)!;
    activity.stepStart = { pos: { ...adapter.pos } };
    noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
    adapter.pos = { x: 2.5, y: 64, z: 0.5 };
    const indexBefore = activity.index;
    const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', `路线失效（${invalidation}）`, {
      routeId: 'rt_stale', outcome: 'INVALIDATED', confirmedSegments: 0, confirmed: false,
      invalidation: { reason: invalidation }, unsupported: { reason: invalidation },
      requestedTarget: { x: 10, y: 64, z: 0 }, position: { ...adapter.pos }, trace: [],
    }), 0, adapter.state());
    assert.equal(verdict.kind, 'stuck', `${invalidation} 必须诚实停止，不能继续自动重放`);
    assert.equal(activity.index, indexBefore, '不把失效 handle 重新插回队列');
    assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不进通用自动重试');
    assert.equal(nav.lastRoute?.valid, false);
    assert.equal(nav.phase, 'replanning');
    assert.deepEqual(adapter.actions, []);
  }
});

test('连续两段导航都没有实测进展时停止自动续接', () => {
  const adapter = flatAdapter();
  const activity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const nav = activity.navigation!;
  activity.stepStart = { pos: { ...adapter.pos } };
  adapter.pos = { x: 1.5, y: 64, z: 0.5 };
  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  // 第一次无进展：身体动过，允许一次有界复验（仍属同一委托）。
  let verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '当前证据里没有可执行路线', {
    to: { x: 40, y: 64, z: 0 }, position: { ...adapter.pos }, executed: 0, remaining: [],
    segment: { arrivedAtTarget: false },
  }), 0, adapter.state());
  assert.equal(verdict.kind, 'continue', '第一次无进展允许一次有界复验');
  assert.equal(nav.phase, 'failed');
  assert.deepEqual(nav.remaining, [], '回执的空剩余数组照实写空，不用旧计划冒充');
  assert.equal(activity.index, 0, '复验回到同一步');

  step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '当前证据里仍然没有可执行路线', {
    to: { x: 40, y: 64, z: 0 }, position: { ...adapter.pos }, executed: 0, remaining: [],
    segment: { arrivedAtTarget: false },
  }), 0, adapter.state());
  assert.equal(verdict.kind, 'stuck', '连续两次无进展后停止，不再自动续接');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 1, '只允许一次有界复验，不无限重试');
  assert.equal(nav.destination?.x, 40, '停止时原目的地与实测位置保留');
});

test('显式改目标会作废旧 route handle，不清空已完成段与实测位置', () => {
  const adapter = flatAdapter();
  const activity = activityWith(adapter, [
    { skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const nav = activity.navigation!;
  nav.completedSegments = 3;
  nav.lastRoute = { id: 'rt_old_goal', source: 'search', valid: true, confirmed: 3 };
  adapter.pos = { x: 5.5, y: 64, z: 0.5 };
  nav.measured = { pos: { ...adapter.pos }, at: Date.now() };

  retargetNavigation(activity, [
    { skill: 'navigate_to', args: { to: { x: 80, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);

  assert.equal(nav.destination?.x, 80, '显式 adjust 改写原目的地');
  assert.deepEqual(nav.remaining, [{ x: 80, y: 64, z: 0 }]);
  assert.equal(nav.phase, 'planning');
  assert.equal(nav.lastRoute?.valid, false, '旧目标的 step handle 不能复用');
  assert.equal(nav.completedSegments, 3, '改目标不清空已完成段');
  assert.deepEqual(nav.measured.pos, { x: 5.5, y: 64, z: 0.5 });
});

test('路线的部分进展即使遇到失效也保留确认段与实测落点', () => {
  const adapter = flatAdapter();
  const activity = activityWith(adapter, [
    { skill: 'walk_path', args: { routeId: 'rt_partial_invalid' } },
    { skill: 'plan_route', args: { to: { x: 40, y: 64, z: 0 }, source: 'search' } },
  ]);
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '路线失效', {
    routeId: 'rt_partial_invalid', outcome: 'INVALIDATED', confirmedSegments: 3, confirmed: false,
    invalidation: { reason: 'route_invalidated' }, requestedTarget: { x: 40, y: 64, z: 0 },
    position: { ...adapter.pos }, remainingPoints: [{ x: 5, y: 64, z: 0 }], trace: [],
  }), 0, adapter.state());

  assert.equal(verdict.kind, 'continue', '已确认段是进展，索引照常前进到后续重规划步骤');
  assert.equal(nav.completedSegments, 3);
  assert.equal(nav.phase, 'replanning');
  assert.deepEqual(nav.lastConfirmed?.pos, { x: 4.5, y: 64, z: 0.5 }, '失效前的实测落点保留');
  assert.deepEqual(nav.remaining, [{ x: 5, y: 64, z: 0 }], '失效前的剩余目标保留');
  assert.equal(nav.destination?.x, 40);
});

test('真实 Arbiter 派发链：同 delegation 的新 taskId 不改 delegationId、不重置父预算', async (t) => {
  const map = flatMap(5);
  const adapter = flatAdapter();
  const memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision, fakeSpatial(map));
  t.after(() => { arbiter.cancel('test end'); memory.close(); });

  const activity = activityWith(adapter, [{ skill: 'navigate_to', args: { to: { x: 4, y: 64, z: 0 }, maxSteps: 1 } }]);
  const nav = activity.navigation!;
  const template = activity.steps[0]!;

  const first = beginStep(activity, template, adapter.state());
  noteNavigationDispatch(activity, template, adapter.state(), { deadlineMs: first.deadlineMs });
  const firstDone = new Promise<void>((resolve) => arbiter.once('done', () => resolve()));
  const firstTask = arbiter.start({ skill: template.skill, args: template.args }, 'llm', { planId: activity.id });
  assert.ok(!('error' in firstTask), '第一次派发应成功');
  assert.equal(arbiter.info()?.planId, activity.id);
  await firstDone;

  // 身体自动续跑同一逻辑动作：Arbiter 会签发新的 taskId，但仍是同一 delegation。
  activity.index = 0;
  markContinuation(activity, template);
  const continuationStep = nextStep(activity)!;
  const second = beginStep(activity, template, adapter.state());
  assert.equal(second.continuation, true, '同 delegation 的续跑是 continuation');
  assert.equal(second.deadlineMs, first.deadlineMs, '父预算不延长');
  noteNavigationDispatch(activity, continuationStep, adapter.state(), { deadlineMs: second.deadlineMs });
  const secondDone = new Promise<void>((resolve) => arbiter.once('done', () => resolve()));
  const secondTask = arbiter.start({ skill: template.skill, args: template.args }, 'llm', { planId: activity.id, deadlineMs: second.deadlineMs });
  assert.ok(!('error' in secondTask), '第二次派发应成功');
  const secondInfo = arbiter.info()!;
  assert.notEqual(secondInfo.id, firstTask.id, 'Arbiter 每次派发签发新的 taskId');
  assert.equal(secondInfo.planId, activity.id, '新 taskId 仍属于同一 Activity/delegation');
  assert.equal(secondInfo.deadline, first.deadlineMs, 'Arbiter 任务期限沿用父预算，没有被新 taskId 重置');
  assert.equal(activity.navigation!.delegationId, activity.id, 'navigation.delegationId 不随 taskId 改变');
  assert.equal(activity.navigation!.parentDeadlineMs, first.deadlineMs);
  await secondDone;

  // 新的显式 Activity 才是新 delegation，重新起算预算。
  const otherAdapter = flatAdapter();
  const other = activityWith(otherAdapter, [{ skill: 'navigate_to', args: { to: { x: 4, y: 64, z: 0 }, maxSteps: 1 } }]);
  const fresh = beginStep(other, other.steps[0]!, otherAdapter.state());
  assert.equal(fresh.continuation, false);
  assert.notEqual(other.navigation!.delegationId, activity.id);
  assert.ok(fresh.deadlineMs > first.deadlineMs, '新显式委托重新起算，不是同一父预算');
});
