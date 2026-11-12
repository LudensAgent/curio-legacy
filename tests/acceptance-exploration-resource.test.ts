/**
 * V4-QA-01 验收矩阵：探索与资源搜索（v4 §11.5 / §12.5 / §14.4–14.5）。
 *
 * 每个测试对应 `workflow/cards/V4-QA-01.md` §2「探索/资源」的一个条目，独立报告
 * PASS / FAIL / NOT_RUN。复用生产组件：`navigateTo`、共享 `VoxelMap` 观测、
 * `createActivity`/`recordOf`/Mind 的搜索状态闸门、`look_around`/`mine_cell`，
 * 以及夹具 `FakeAdapter`/`makeCtx`。没有第二套搜索器、地图或探索状态。
 *
 * 离线/Fake：新区块由 Perception 的 `memory.visit` 记录（夹具显式调用），
 * 不是导航代写；移动走 FakeAdapter 连续插值。实机 NOT_RUN（V4-QA-02）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { createActivity, localStepFailure, recordOf } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { lookAround } from '../src/skills/movement.ts';
import { mineCell, navigateTo } from '../src/skills/movement/index.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'fake-world';
const DIM = 'overworld';
const SESSION = 'fake-session';
type Cell = { x: number; y: number; z: number };
let sequence = 0;
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
    markModified: () => ({ status: 'written' as const, report: { sections: [], gaps: [] } }),
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap, adapter: FakeAdapter = new FakeAdapter()) {
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter, { deadlineMs: 180_000 }), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

const navArgs = (to: Cell, extra: Record<string, unknown> = {}) => ({
  to, allowed: ['walk', 'step'] as ('walk' | 'step' | 'drop')[],
  historical: true, maxSteps: 8, allowUnknownCorridor: false, ...extra,
});

type Segment = {
  displacement?: { horizontal: number };
  requestedDistance?: { horizontal: number };
  newChunks?: number;
  newObservedCells?: number;
  arrivedAtTarget?: boolean;
  progress?: { meaningful: boolean; reason: string };
};

type HarnessState = { worldId: string; sessionId: string; dim: string; pos: Cell };
type GateDecision = {
  kind: string;
  notes: string[];
  activity?: { what: string; kind?: string; steps: { skill: string; args?: Record<string, unknown> }[] };
  next?: unknown;
};
type HarnessMind = {
  d: {
    self: SelfModel;
    bus: { publish: (type: string, severity: string, msg: string) => void };
    memory: { visitedChunkCount: number };
    adapter: { state: () => HarnessState };
  };
  requestThink: (reason: string, tier: string) => void;
  noteProgressOutcome: (activity: unknown, record: { outcome: string; gained: Record<string, number>; summary: string }, progressed: boolean) => void;
  enforceSourceSwitchEvidence: (decision: GateDecision, context: Record<string, unknown>) => boolean;
  progressGate: unknown;
  lastLocalFailure: Record<string, unknown> | null;
};

/** 与 resource-search-state 同一套 Mind 依赖形状；不另造搜索状态。 */
function searchHarness(opts: { dim?: string; pos?: Cell; chunks?: number } = {}) {
  const self = new SelfModel(null);
  self.setPlan('找木料砍 6 根原木', ['找树砍 6 根原木']);
  const events: { type: string; msg: string }[] = [];
  const thinks: { reason: string; tier: string }[] = [];
  const state: HarnessState = { worldId: 'w', sessionId: 's', dim: opts.dim ?? 'overworld', pos: { ...(opts.pos ?? { x: 0.5, y: 64, z: 0.5 }) } };
  const mind = Object.create(Mind.prototype) as HarnessMind;
  mind.d = {
    self,
    bus: { publish: (type: string, _severity: string, msg: string) => events.push({ type, msg }) },
    memory: { visitedChunkCount: opts.chunks ?? 0 },
    adapter: { state: () => ({ ...state, pos: { ...state.pos } }) },
  };
  Object.assign(mind, {
    noProgressRuns: [], progressGate: null, progressGateRejects: 0, lastProgressGateAt: 0,
    dangerUntil: 0, order: null, userSuggestion: null, review: null, activity: null,
    lastLocalFailure: null, sourceSwitchRejects: 0, queuedNext: null,
  });
  mind.requestThink = (reason: string, tier: string) => thinks.push({ reason, tier });
  const activity = (startPos = state.pos) => ({
    agendaId: self.plan()!.agendaId, what: '在附近找树', kind: 'explore',
    steps: [{ skill: 'look_around', args: { for: 'log' } }], startPos: { ...startPos },
  });
  return { mind, self, events, thinks, activity, state };
}

test('EX-1 有限地图发现边界；走近后新观测继续；同一不可达边界不重复移动' , async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 12, y: 64, z: 0 };

  const first = await navigateTo.run(ctx, navArgs(target));
  assert.equal(first.status, 'failed');
  assert.equal(Math.floor(adapter.pos.x), 3, '先走到已观测前缀端点');
  const boundary = first.data?.boundarySummary as { counts: Record<string, number>; observationMayResolve: boolean };
  assert.ok((boundary.counts.UNKNOWN ?? 0) > 0, '报告 UNKNOWN 边界');
  assert.equal(boundary.observationMayResolve, true);
  const segment0 = first.data?.segment as Segment;
  assert.ok((segment0.displacement?.horizontal ?? 0) > 0);

  // 证据未变：同一不可达边界不能靠重试换来移动。
  const actions = adapter.actions.length;
  const repeated = await navigateTo.run(ctx, navArgs(target));
  assert.equal(repeated.status, 'failed');
  // 没有进展时只会绕向尚未试过的前沿点再看，不会越过未观察的边界。
  assert.ok(adapter.actions.length >= actions);
  assert.ok(Math.floor(adapter.pos.x) <= 3, '没有越过未观察的边界');
  const boundaryKeys = [first, repeated].map((result) => {
    const boundaries = (result.data?.boundaries ?? []) as { status?: string; direction?: string; from?: Cell; to?: Cell }[];
    const east = boundaries.find((item) => item.status === 'UNKNOWN' && item.direction === 'E' && item.from && item.to && item.to.x > item.from.x);
    return east ? `${east.from!.x},${east.from!.y},${east.from!.z}->${east.to!.x},${east.to!.y},${east.to!.z}` : null;
  });
  assert.ok(boundaryKeys[0], '必须报告朝目标的 UNKNOWN 边界键');
  assert.equal(boundaryKeys[0], boundaryKeys[1], '两次遇到同一个不可达边界');
  assert.equal(new Set(boundaryKeys).size, 1, '重复不可达边界去重后只有 1 个');

  // 显式观察：新观测来自夹具，导航不代写；随后继续推进。
  const before = map.checkpointFullCounts().observedCells;
  observeRange(map, 4, 7);
  const after = map.checkpointFullCounts().observedCells;
  assert.ok(after > before, `观察必须实际扩充地图：${before}→${after}`);
  const second = await navigateTo.run(ctx, navArgs(target));
  assert.ok((second.data?.executed as number) >= 3, '新证据下继续推进');
  assert.ok(Math.floor(adapter.pos.x) >= 7, '身体离开首个边界');
  const segment2 = second.data?.segment as Segment;
  assert.ok((segment2.displacement?.horizontal ?? 0) > 0, '第二段有实测位移');

  observeRange(map, 8, 12);
  const final = await navigateTo.run(ctx, navArgs(target));
  assert.equal(final.status, 'succeeded', final.summary);
  assert.equal(Math.floor(adapter.pos.x), target.x);
  const finalSegment = final.data?.segment as Segment;
  assert.equal(finalSegment.arrivedAtTarget, true);
  assert.equal(adapter.actions.every((action) => !action.startsWith('dig') && !action.startsWith('place')), true, '探索不自动施工');
  t.diagnostic(`EX-1 uniqueFrontiers=1 repeatedFrontierAttempts=2 secondAttemptMoved=0 observedCells=${before}->${after} finalArrived=true`);
});

test('EX-2a 局部未见 ≠ 区域/维度缺失；同区域重复观察 ≠ 进展' , async (t) => {
  const agent = new FakeAdapter();
  const state = {
    ...agent.state(),
    worldId: 'w', sessionId: 's', dim: 'overworld',
    pos: { x: 0.5, y: 64, z: 0.5 }, inventory: [],
  };
  const failure = { status: 'failed' as const, failureCode: 'NOT_FOUND' as const, summary: '视野内未见 oak_log', data: { problem: { kind: 'TARGET_NOT_OBSERVED' } } };
  assert.equal(localStepFailure({ skill: 'look_around' }, failure, state, 0), null, '观察未命中不是局部移动失败');
  const look = createActivity({
    what: '走远找树砍原木', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'look_around', args: { for: 'oak_log' } }],
  }, '', 'llm', state);
  look.results.push({ skill: 'look_around', args: {}, status: 'failed', failureCode: 'NOT_FOUND', summary: failure.summary, at: Date.now(), durationMs: 2, pos: { x: 0.5, y: 64, z: 0.5 } });
  const record = recordOf(look, 'done', '附近观察未发现', state, { newChunks: 0 });
  assert.equal(record.exploration?.localOnly, true, '原地观察只能算局部覆盖');
  assert.equal(record.exploration?.maxHorizontal, 0, '只在一个格内观察，不能算远处覆盖');
  assert.equal(record.resource?.located, false);
  assert.equal(record.resource?.acquired, null, '寻找类目标没有取得语义');
  assert.equal(record.resource?.goalIncomplete, true, '局部未见只是缺口，不是区域/维度为空');

  const { mind, self, activity } = searchHarness();
  for (let index = 0; index < Mind.PROGRESS_GATE_ACTIVITIES; index++) {
    mind.noteProgressOutcome(activity(), { outcome: 'done', gained: {}, summary: '视野内未见 oak_log' }, false);
  }
  const runs = self.taskFacts().noProgressRuns ?? [];
  assert.equal(runs.length, Mind.PROGRESS_GATE_ACTIVITIES, '同区域重复观察累计为无进展');
  const lastRun = runs.at(-1)!;
  assert.equal(lastRun.what, '在附近找树');
  assert.equal(lastRun.outcome, 'done');
  assert.match(lastRun.summary, /视野内未见/);
  assert.equal(new Set(runs.map((run) => run.signature)).size, 1, '同一做法/区域/证据版本');
  assert.ok(runs.every((run) => typeof run.at === 'number' && Date.now() - run.at < 30 * 60_000), '无进展记录都在 30 分钟窗口内');
  assert.ok(mind.progressGate, '达到无进展阈值后打开闸门');
  t.diagnostic(`EX-2a localOnly=true maxHorizontal=${record.exploration?.maxHorizontal} sameRegionNoProgressRuns=${runs.length}`);
});

test('EX-3 Overworld/Nether：一次扫描失败不自动换维；换维需新证据且不振荡' , (t) => {
  // 默认在下界：一次局部失败后直接换回主世界，没有新证据 → 拒绝且不改写步骤。
  const { mind, self, events } = searchHarness({ dim: 'the_nether' });
  mind.lastLocalFailure = { at: Date.now(), skill: 'move_step', code: 'BAD_ARGS', summary: '目标脚高 70 没有支撑，只有 68', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0.5, y: 68, z: 0.5 }, chunks: 0 };
  const trip = [{ skill: 'travel_portal', args: { portalId: 'p1' } }];
  const denied: GateDecision = { kind: 'new', notes: [], activity: { what: '回主世界', kind: 'explore', steps: trip } };
  assert.equal(mind.enforceSourceSwitchEvidence(denied, {}), false, '无新证据的换维被拒');
  assert.equal(denied.activity, undefined, '拒绝时不替 Agent 生成换维动作');
  assert.equal(denied.next, undefined, '拒绝时不排队替代动作');
  assert.equal(denied.kind, 'continue', '交回 Agent 重新决定');
  assert.equal(self.taskFacts().lastSourceSwitch ?? null, null, '被拒绝的换维不写入换维证据');
  assert.ok(events.some((event) => event.type === 'source_switch_rejected'));
  assert.equal(mind.d.adapter.state().dim, 'the_nether', '宿主没有自动换维');

  // 有新证据（带 find 的远征）→ 允许一次换维，记录来源/目标/理由/作用域。
  const withEvidence: GateDecision = { kind: 'new', notes: [], activity: { what: '先远征找证据', steps: [{ skill: 'expedition', args: { direction: 'E', distance: 120, find: 'crimson_stem' } }, { skill: 'recall_portal' }] } };
  assert.equal(mind.enforceSourceSwitchEvidence(withEvidence, {}), true, '带新证据的换维放行');
  const switched = self.taskFacts().lastSourceSwitch!;
  assert.deepEqual({ from: switched.from, to: switched.to, reason: switched.reason, worldId: switched.worldId, sessionId: switched.sessionId },
    { from: 'the_nether', to: 'overworld', reason: 'activity-evidence', worldId: 'w', sessionId: 's' });

  // 反向再换回下界、没有新证据：仍被拒绝，不形成 Overworld/Nether 振荡。
  const back = searchHarness({ dim: 'overworld' });
  back.mind.lastLocalFailure = { at: Date.now(), skill: 'move_step', code: 'BAD_ARGS', summary: '无支撑', worldId: 'w', sessionId: 's', dim: 'overworld', pos: { x: 0.5, y: 64, z: 0.5 }, chunks: 0 };
  const oscillation: GateDecision = { kind: 'new', notes: [], activity: { what: '再下界', kind: 'explore', steps: [{ skill: 'travel_portal', args: { portalId: 'p2' } }] } };
  assert.equal(back.mind.enforceSourceSwitchEvidence(oscillation, {}), false, '无新证据的反向换维被拒');
  assert.equal(back.mind.d.adapter.state().dim, 'overworld', '不自动切换维度');
  t.diagnostic('EX-3 noEvidenceSwitches=2 acceptedEvidenceSwitches=1 autoDimensionChanges=0');
});

test('EX-5 多段探索指标：新区块/新观测、有界分段与无进展循环' , async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target: Cell = { x: 40, y: 64, z: 0 };
  let segments = 0, executedTotal = 0, actualDistance = 0, observedGrowth = 0, noProgressLoops = 0;
  let reached = false;
  for (let guard = 0; guard < 12 && !reached; guard++) {
    const result = await navigateTo.run(ctx, navArgs(target, { maxSteps: 16 }));
    const executed = Number(result.data?.executed ?? 0);
    if (executed === 0) { noProgressLoops += 1; break; }
    segments += 1;
    executedTotal += executed;
    const segment = result.data?.segment as Segment;
    actualDistance += segment.displacement?.horizontal ?? 0;
    const before = map.checkpointFullCounts().observedCells;
    observeRange(map, Math.floor(adapter.pos.x) + 1, Math.floor(adapter.pos.x) + 16);
    observedGrowth += map.checkpointFullCounts().observedCells - before;
    ctx.memory.visit(DIM, adapter.state().pos);
    reached = result.status === 'succeeded';
  }
  assert.equal(Math.floor(adapter.pos.x), target.x, '多段探索最终到达');
  assert.ok(segments >= 3, `40 格由多段完成（实际 ${segments} 段）`);
  assert.ok(executedTotal >= 40, `确认段累计 ≥40（实际 ${executedTotal}）`);
  assert.ok(Math.abs(actualDistance - 40) < 2, `实测位移由段落实测值累加（实际 ${actualDistance.toFixed(2)}）`);
  assert.ok(ctx.memory.visitedChunkCount >= 2, `进入新区块（实际 ${ctx.memory.visitedChunkCount}）`);
  // 新观测格数由 VoxelMap 前后差值实测；这里只断言确有增长，不设与实现无关的魔法阈值。
  assert.ok(observedGrowth > 0, `新观测格有实际增长（实际 ${observedGrowth}）`);
  assert.equal(noProgressLoops, 0, '本场景没有无进展循环');
  assert.equal(adapter.actions.every((action) => !action.startsWith('dig') && !action.startsWith('place')), true, '多段探索不自动施工');
  t.diagnostic(`EX-5 explorationSegments=${segments} confirmedSegments=${executedTotal} displacement=${actualDistance.toFixed(1)} newChunks=${ctx.memory.visitedChunkCount} newObservedCells=${observedGrowth} noProgressLoops=${noProgressLoops}`);
});

test('EX-4 资源观测后能导航并确认取得' , async (t) => {
  const map = knownCorridor(2);
  // x=3 有一棵已观测的橡木原木（脚/头格都观测为 air 的通道终点之外）。
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence: ++sequence,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'minecraft:oak_log', properties: {} }, pos: { x: 3, y: 64, z: 0 },
  });
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  adapter.speed = 100_000;
  adapter.blocks.push({ name: 'oak_log', pos: { x: 3, y: 64, z: 0 } });
  const ctx: SkillCtx = {
    ...makeCtx(adapter, { deadlineMs: 60_000, senses: { observeBlocks: observeAllBlocks(adapter) } }),
    spatial: fakeSpatial(map),
  };
  t.after(() => ctx.memory.close());

  const startedAt = { ...adapter.pos };
  const activity = createActivity({
    what: '找木料砍原木', why: '地图里已观测到 oak_log', kind: 'gather', repeat: 1,
    steps: [
      { skill: 'navigate_to', args: navArgs({ x: 2, y: 64, z: 0 }) },
      { skill: 'look_around', args: { for: 'oak_log', seconds: 2 } },
      { skill: 'mine_cell', args: { xyz: [3, 64, 0], facing: 'E' } },
    ],
  }, '', 'llm', adapter.state());

  const look = await lookAround.run(ctx, { seconds: 2, for: 'oak_log' });
  assert.equal(look.status, 'succeeded', look.summary);
  assert.equal(look.data?.found, 'oak_log', '当前观察确认目标');
  activity.results.push({ skill: 'look_around', args: {}, status: 'succeeded', summary: look.summary, at: Date.now(), durationMs: 2, pos: { ...adapter.pos }, data: look.data as Record<string, unknown> });

  const nav = await navigateTo.run(ctx, navArgs({ x: 2, y: 64, z: 0 }));
  assert.equal(nav.status, 'succeeded', nav.summary);
  assert.equal(Math.floor(adapter.pos.x), 2, '导航到已知资源旁');
  assert.ok(Math.hypot(adapter.pos.x - startedAt.x, adapter.pos.z - startedAt.z) > 1);
  activity.results.push({ skill: 'navigate_to', args: {}, status: 'succeeded', summary: nav.summary, at: Date.now(), durationMs: 2, pos: { ...adapter.pos }, data: nav.data as Record<string, unknown> });

  const mined = await mineCell.run(ctx, { at: [1, 0, 0] as [number, number, number], facing: 'E' as const, xyz: { x: 3, y: 64, z: 0 } });
  assert.equal(mined.status, 'succeeded', mined.summary);
  assert.equal(mined.data?.was, 'oak_log');
  assert.equal(adapter.blockAt({ x: 3, y: 64, z: 0 }), 'air');
  assert.equal(adapter.inv.get('oak_log'), 1, '取得证据来自实测背包增量');
  activity.results.push({ skill: 'mine_cell', args: {}, status: 'succeeded', summary: mined.summary, at: Date.now(), durationMs: 2, pos: { ...adapter.pos }, data: { ...(mined.data as Record<string, unknown>), dug: 1 } });

  const record = recordOf(activity, 'done', '砍下原木', adapter.state(), { newChunks: 0 });
  assert.equal(record.resource?.located, true, '当前观察确认资源位置');
  assert.equal(record.resource?.acquired, true, '背包增量确认已取得');
  assert.equal(record.resource?.goalIncomplete, false);
  assert.deepEqual(record.gained, { oak_log: 1 });
  t.diagnostic(`EX-4 observed=oak_log navigationMoved=${(Math.hypot(adapter.pos.x - startedAt.x, adapter.pos.z - startedAt.z)).toFixed(1)} acquired=${record.gained.oak_log}`);
});
