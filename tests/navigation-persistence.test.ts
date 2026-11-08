import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VoxelMap, type RoutePlan, type RoutePlanRegistryProblem } from 'curio-minecraft-3d-memory';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, beginStep, createActivity, describeActivity, invalidateNavigation, markContinuation, noteNavigationDispatch, nextStep, retargetNavigation } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { clearRouteRecords, consumeRoutePlan, noteRouteScope, planRoute } from '../src/skills/movement/route.ts';
import { fail, ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const SCOPE = { worldId: WORLD, dim: DIM, sessionId: SESSION };

function activityOf(steps: { skill: string; args?: unknown }[], extra: Record<string, unknown> = {}) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  const activity = createActivity({ what: '走到远处的目标', why: '先过去看看', kind: 'explore', repeat: 1, steps, ...extra } as Parameters<typeof createActivity>[0], '', 'llm', adapter.state());
  return { adapter, activity };
}

function flatVoxelMap(nameAt: (x: number, y: number, z: number) => string) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: nameAt(x, y, z), properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map },
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

const routeProblem = (value: RoutePlan | RoutePlanRegistryProblem) => (value as { kind?: string }).kind;

function mindFixture(t: TestContext) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const cfg = { ...config, llm: { ...config.llm, provider: 'mock' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, {
    name: 'nav-test',
    complete: async () => ({ text: JSON.stringify({ decision: 'continue', monologue: '继续观察' }), latencyMs: 1 }),
  }, adapter, memory, bus, null);
  const self = new SelfModel(null, []);
  const mind = new Mind({
    adapter, arbiter, perception, memory, bus, self, persona: '你叫 Curio。',
    thinker: new Thinker(planner, adapter, memory, bus, null),
  });
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); });
  return { adapter, mind, arbiter };
}

test('段结束保留原目的地与剩余目标，Activity 不按失败记录', () => {
  const { adapter, activity } = activityOf([
    { skill: 'plan_route', args: { to: { x: 10, y: 64, z: 0 }, source: 'search' } },
    { skill: 'walk_path', args: { routeId: 'rt_seg_1' } },
    { skill: 'walk_path', args: { routeId: 'rt_seg_2' } },
  ]);
  const nav = activity.navigation!;
  assert.equal(nav.destination?.x, 10, '开工时的绝对目的地被保留');
  assert.equal(nav.phase, 'planning');

  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  let verdict = afterStep(activity, step, ok('路线已规划', { routeId: 'rt_seg_1', source: 'search', requestedTarget: { x: 10, y: 64, z: 0 }, executable: true }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.equal(nav.phase, 'planning');

  // 第一段只到达中间 waypoint：原目的地不能变成这一段终点。
  step = nextStep(activity)!;
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  noteNavigationDispatch(activity, activity.steps[1]!, adapter.state());
  verdict = afterStep(activity, step, ok('walk_path 已按实测身体条件确认到达', {
    routeId: 'rt_seg_1', outcome: 'ARRIVED', confirmed: true, confirmedSegments: 2,
    position: { ...adapter.pos }, requestedTarget: { x: 4, y: 64, z: 0 }, routeKind: 'snapshot', backend: 'spatial_library',
  }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '还有下一段，不属于 Activity 失败');
  assert.equal(activity.failures, 0);
  assert.equal(nav.destination?.x, 10, '原目的地不被最后 waypoint 替换');
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.completedSegments, 2);
  assert.ok(nav.remaining.some((point) => point.x === 10), '未到的原目的地仍在剩余目标里');

  // 第二段到达原目的地：同一委托跨段累积已完成段。
  step = nextStep(activity)!;
  adapter.pos = { x: 10.5, y: 64, z: 0.5 };
  noteNavigationDispatch(activity, activity.steps[2]!, adapter.state());
  afterStep(activity, step, ok('到达', {
    routeId: 'rt_seg_2', outcome: 'ARRIVED', confirmed: true, confirmedSegments: 3,
    position: { ...adapter.pos }, requestedTarget: { x: 10, y: 64, z: 0 }, routeKind: 'search', backend: 'spatial_library',
  }), 100, adapter.state());
  assert.equal(nav.phase, 'arrived');
  assert.equal(nav.destination?.x, 10);
  assert.equal(nav.completedSegments, 5, '两段确认段数累计');
  assert.deepEqual(nav.remaining, []);
  assert.ok(describeActivity(activity, adapter.state()).navigation, '原目标和进度在描述里可见');
});

test('同一委托的新派发任务继承父期限；新的显式委托才重新起算', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { adapter, activity } = activityOf([{ skill: 'walk_path', args: { routeId: 'rt_parent' } }]);
  const nav = activity.navigation!;
  assert.equal(nav.delegationId, activity.id, '导航状态绑定稳定的委托 ID（Activity.id）');

  const first = beginStep(activity, activity.steps[0]!, adapter.state());
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state(), { deadlineMs: first.deadlineMs });
  assert.equal(first.continuation, false);
  assert.equal(nav.parentDeadlineMs, first.deadlineMs);

  // 身体自动续跑同一逻辑动作：Arbiter 会派发新的任务 ID，但预算仍属于同一份委托。
  now += 20_000;
  activity.index = 0;
  markContinuation(activity, activity.steps[0]);
  const secondStep = nextStep(activity)!;
  const second = beginStep(activity, activity.steps[0]!, adapter.state());
  noteNavigationDispatch(activity, secondStep, adapter.state(), { deadlineMs: second.deadlineMs });
  assert.equal(second.continuation, true);
  assert.equal(second.deadlineMs, first.deadlineMs, '新派发任务没有重新获得完整超时');
  assert.equal(nav.parentDeadlineMs, first.deadlineMs, '导航状态展示的是同一份父预算');
  assert.equal(nav.delegationId, activity.id, '跨派发/跨 LLM 轮次仍是同一委托');

  // 新的显式 Agent 委托（新 Activity）是新的 delegation，重新起算；不是全局配额。
  const other = activityOf([{ skill: 'walk_path', args: { routeId: 'rt_parent' } }]);
  const fresh = beginStep(other.activity, other.activity.steps[0]!, other.adapter.state());
  assert.equal(fresh.continuation, false);
  assert.ok(fresh.deadlineMs > first.deadlineMs);
  assert.notEqual(other.activity.navigation!.delegationId, activity.id);
});

test('walk_path 已确认部分路段：不重放已消费 routeId，Activity 不按失败收尾', () => {
  const { adapter, activity } = activityOf([
    { skill: 'walk_path', args: { routeId: 'rt_partial' } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 3.5, y: 64, z: 0.5 };
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '只确认了部分路段', {
    routeId: 'rt_partial', outcome: 'PARTIAL', confirmed: false, confirmedSegments: 2,
    requestedTarget: { x: 10, y: 64, z: 0 }, position: { ...adapter.pos },
    remainingPoints: [{ x: 6, y: 64, z: 0 }],
  }), 100, adapter.state());

  assert.equal(verdict.kind, 'continue', '部分段不是整段失败，也不自动重放');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  assert.equal(activity.index, 1, '索引照常前进，后续步骤/新 routeId 可以接着跑');
  assert.equal(activity.failures, 0);
  const nav = activity.navigation!;
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.completedSegments, 2);
  assert.equal(nav.destination?.x, 10);
  assert.equal(nextStep(activity)!.skill, 'look_around');
});

test('navigate_to 两次同参部分段都不自动重放、不按失败收尾', () => {
  const { adapter, activity } = activityOf([
    { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const nav = activity.navigation!;
  const first = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  const firstVerdict = afterStep(activity, first, fail('EFFECT_NOT_CONFIRMED', '已执行前 4 段，未到终点', {
    executed: 4, position: { ...adapter.pos }, remaining: [{ to: { x: 6, y: 64, z: 0 } }],
    to: { x: 12, y: 64, z: 0 }, segment: { arrivedAtTarget: false },
  }), 100, adapter.state());
  assert.equal(firstVerdict.kind, 'continue');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.completedSegments, 4);

  const second = nextStep(activity)!;
  assert.equal(second.skill, 'navigate_to');
  noteNavigationDispatch(activity, activity.steps[1]!, adapter.state());
  adapter.pos = { x: 7.5, y: 64, z: 0.5 };
  const secondVerdict = afterStep(activity, second, fail('EFFECT_NOT_CONFIRMED', '已执行前 2 段，未到终点', {
    executed: 2, position: { ...adapter.pos }, remaining: [{ to: { x: 10, y: 64, z: 0 } }],
    to: { x: 12, y: 64, z: 0 }, segment: { arrivedAtTarget: false },
  }), 100, adapter.state());
  assert.equal(secondVerdict.kind, 'continue', '第二次同参部分段也不再进通用重试');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
  assert.equal(activity.index, 2);
  assert.equal(activity.failures, 0);
  assert.equal(nav.phase, 'segment_completed');
  assert.equal(nav.destination?.x, 12, '原目的地没有被两次部分段改写');
  assert.equal(nextStep(activity)!.skill, 'look_around');
});

test('只有显式 adjust 能改写原目的地；路线 waypoint 不会', () => {
  const { adapter, activity } = activityOf([
    { skill: 'navigate_to', args: { to: { x: 10, y: 64, z: 0 } } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  afterStep(activity, step, ok('到达这一段终点', {
    outcome: 'ARRIVED', confirmed: true, confirmedSegments: 1, position: { ...adapter.pos },
    requestedTarget: { x: 4, y: 64, z: 0 }, remainingPoints: [{ x: 6, y: 64, z: 0 }],
  }), 100, adapter.state());
  assert.equal(nav.destination?.x, 10, '近处 waypoint 不替换原目的地');
  assert.equal(nav.phase, 'segment_completed');

  retargetNavigation(activity, [
    { skill: 'navigate_to', args: { to: { x: 20, y: 64, z: 0 } } },
    { skill: 'look_around', args: { seconds: 1 } },
  ]);
  assert.equal(nav.destination?.x, 20, '显式 adjust 可以改写目标');
  assert.equal(nav.phase, 'planning');
  assert.deepEqual(nav.remaining, [{ x: 20, y: 64, z: 0 }]);

  retargetNavigation(activity, [{ skill: 'walk_path', args: { routeId: 'rt_waypoint' } }]);
  assert.equal(nav.destination?.x, 20, '没有显式目的地的 adjust 不改原目的地');
});

test('Mind 观测到换维时作废旧 route handle，保留原目的地与已完成段', (t) => {
  const { adapter, mind } = mindFixture(t);
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  mind.tick(); // 建立 lastSession/lastDim/seenAlive

  const activity = createActivity({
    what: '去远处', why: '看看', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
      { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
    ],
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;
  nav.completedSegments = 2;
  nav.lastRoute = { id: 'rt_old', source: 'search', valid: true, confirmed: 2 };
  mind.activity = activity;

  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  adapter.sessionId = `${SESSION}-nether`;
  adapter.dim = 'the_nether';
  mind.tick();

  assert.equal(mind.activity, null);
  assert.equal(nav.phase, 'replanning');
  assert.equal(nav.lastRoute?.valid, false);
  assert.equal(nav.destination?.x, 12);
  assert.equal(nav.completedSegments, 2);
  assert.deepEqual(nav.measured.pos, { ...adapter.pos });
});

test('Mind 断线中断保留导航状态，下一段从实测位置派发', (t) => {
  const { adapter, mind } = mindFixture(t);
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  mind.tick();

  const activity = createActivity({
    what: '去远处', why: '看看', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
      { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
    ],
  }, '', 'llm', adapter.state());
  const nav = activity.navigation!;
  nav.completedSegments = 3;
  nav.lastRoute = { id: 'rt_old', source: 'search', valid: true, confirmed: 3 };
  activity.index = 1; // 第一段已派发/消费，下一段待派发
  mind.activity = activity;

  adapter.pos = { x: 6.5, y: 64, z: 0.5 };
  mind.onDisconnected();

  assert.equal(mind.activity, null);
  assert.equal(nav.phase, 'replanning');
  assert.equal(nav.lastRoute?.valid, false);
  assert.equal(nav.destination?.x, 12);
  assert.equal(nav.completedSegments, 3);
  assert.deepEqual(nav.measured.pos, { ...adapter.pos });

  // 重连后同一委托的下一段按实测位置开始，而不是旧起点/旧 handle。
  adapter.connected = true;
  mind.activity = activity;
  mind.tick();
  assert.deepEqual(nav.segmentStart, { ...adapter.pos });
  assert.equal(nav.phase, 'executing');
  assert.equal(nav.destination?.x, 12);
});

test('重启/换维/断线后旧 routeId 不可复用，导航从实测位置重规划', async (t) => {
  clearRouteRecords();
  t.after(clearRouteRecords);
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatVoxelMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());

  const planned = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);

  const { adapter, activity } = activityOf([{ skill: 'walk_path', args: { routeId } }]);
  const nav = activity.navigation!;
  const step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 1.5, y: 64, z: 0.5 };
  afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '只确认了部分路段', {
    routeId, outcome: 'PARTIAL', confirmed: false, confirmedSegments: 1,
    requestedTarget: { x: 2.5, y: 64, z: 0.5 }, position: { ...adapter.pos },
    remainingPoints: [{ x: 2.5, y: 64, z: 0.5 }],
  }), 100, adapter.state());
  assert.equal(nav.phase, 'segment_completed', '部分进展保留，不按整趟失败');
  assert.equal(nav.completedSegments, 1);
  const destination = { ...nav.destination! };

  // 断线重连：session 变化，旧注册表里的 handle 必须不可复用。
  adapter.sessionId = `${SESSION}-reconnect`;
  noteRouteScope({ worldId: WORLD, dim: DIM, sessionId: adapter.sessionId });
  const stale = consumeRoutePlan(routeId, { worldId: WORLD, dim: DIM, sessionId: adapter.sessionId });
  assert.equal(routeProblem(stale), 'route_not_found');

  invalidateNavigation(activity, '断线后会话失效', adapter.state());
  assert.equal(nav.phase, 'replanning');
  assert.equal(nav.lastRoute?.valid, false);
  assert.deepEqual(nav.destination, destination, '原目的地跨中断保留');
  assert.equal(nav.completedSegments, 1, '已完成段不因中断丢失');
  assert.deepEqual(nav.measured.pos, { ...adapter.pos }, '下一段从实测位置开始');

  // 下一段用全新 routeId 时，段起点严格等于实测位置。
  const nextTarget = { ...adapter.pos };
  noteNavigationDispatch(activity, { skill: 'walk_path', args: { routeId: 'rt_after_replan' } }, adapter.state());
  assert.deepEqual(nav.segmentStart, nextTarget);
  assert.equal(nav.phase, 'executing');
  assert.deepEqual(nav.destination, destination);

  // 进程重启（注册表重建）与换维同样让旧 handle 失效。
  clearRouteRecords();
  assert.equal(routeProblem(consumeRoutePlan(routeId, SCOPE)), 'route_not_found');
  noteRouteScope({ worldId: WORLD, dim: 'the_nether', sessionId: adapter.sessionId });
  assert.equal(routeProblem(consumeRoutePlan(routeId, { worldId: WORLD, dim: 'the_nether', sessionId: adapter.sessionId })), 'route_not_found');

  adapter.dim = 'the_nether';
  invalidateNavigation(activity, '换了维度', adapter.state());
  assert.equal(nav.phase, 'replanning');
  assert.deepEqual(nav.destination, destination, '换维不改写原目的地');
  assert.equal(nav.dim, 'the_nether');
});

test('部分移动后不复用旧相对目标，下一段前复核实测位置', () => {
  const { adapter, activity } = activityOf([
    { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } },
    { skill: 'move_step', args: { at: [1, 0, 0], facing: 'E' } },
  ]);
  const nav = activity.navigation!;
  assert.equal(nav.destination?.x, 12);

  let step = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, adapter.state());
  adapter.pos = { x: 4.5, y: 64, z: 0.5 };
  afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '已执行前 4 段，未到终点', {
    executed: 4, position: { ...adapter.pos }, remaining: [{ to: { x: 6, y: 64, z: 0 } }],
    segment: { arrivedAtTarget: false }, to: { x: 12, y: 64, z: 0 },
  }), 100, adapter.state());
  assert.equal(nav.destination?.x, 12, '目的地仍是原绝对目标');
  assert.equal(nav.phase, 'segment_completed');

  // 相对移动失败且身体已换位：不把 [1,0,0] 按新位置重解析，也不改目的地。
  const relative = nextStep(activity)!;
  activity.stepStart = { pos: { x: 4.5, y: 64, z: 0.5 } };
  adapter.pos = { x: 5.5, y: 64, z: 0.5 };
  const verdict = afterStep(activity, relative, fail('PATH_NOT_FOUND', '相对 step 失败后身体已换位', { position: { ...adapter.pos } }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.equal(nav.destination?.x, 12);
  assert.equal(JSON.stringify(nav).includes('"at":['), false, '相对目标没有写进导航状态');

  noteNavigationDispatch(activity, { skill: 'navigate_to', args: { to: { x: 12, y: 64, z: 0 }, maxSteps: 8 } }, adapter.state());
  assert.deepEqual(nav.measured.pos, { ...adapter.pos });
  assert.deepEqual(nav.segmentStart, { ...adapter.pos });
  assert.equal(nav.phase, 'executing');
});

test('导航状态只留当前目标/进度/失败/来源/策略，不复制空间历史（D-V4-027）', () => {
  const { adapter, activity } = activityOf([
    { skill: 'navigate_to', args: { to: { x: 40, y: 64, z: 0 }, maxSteps: 32 } },
    { skill: 'walk_path', args: { routeId: 'rt_last' } },
  ]);
  const nav = activity.navigation!;
  for (let i = 0; i < 20; i++) {
    const step = { skill: 'walk_path', args: { routeId: `rt_${i}` } };
    noteNavigationDispatch(activity, step, adapter.state());
    adapter.pos = { x: i + 1, y: 64, z: 0.5 };
    afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '部分路段', {
      routeId: `rt_${i}`, outcome: 'PARTIAL', confirmedSegments: 1,
      requestedTarget: { x: 40, y: 64, z: 0 }, position: { ...adapter.pos },
      remainingPoints: [{ x: 40, y: 64, z: 0 }],
      trace: [{ huge: 'geometry' }], lastObservation: { voxels: 'history' },
    }), 10, adapter.state());
  }

  assert.ok(activity.results.length <= 16, '活动回执仍有界');
  assert.equal(nav.completedSegments, 20);
  assert.equal(nav.remaining.length, 1, '剩余目标只保留当前计划，不累积历史');
  assert.equal(nav.remaining[0]!.x, 40);
  assert.ok(!Array.isArray(nav.lastInvalidation) && !Array.isArray(nav.lastFailure), '失效/失败只留最新一条');
  const keys = Object.keys(nav);
  for (const forbidden of ['history', 'traversals', 'fragments', 'voxels', 'visited', 'segments', 'trace', 'observations']) {
    assert.equal(keys.includes(forbidden), false, `导航状态不应包含 ${forbidden}`);
  }
  const described = describeActivity(activity, adapter.state()).navigation as Record<string, unknown>;
  assert.ok(described);
  assert.equal(described.remaining_count, 1);
  assert.equal(described.state, 'segment_completed');
  assert.equal(JSON.stringify(described).includes('huge'), false, '空间历史没有被复制进活动描述');
  assert.equal(JSON.stringify(described).includes('history'), false);
});
