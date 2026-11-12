import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, localStepFailure, planCoverageGap, recordOf, softMiss } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';

const P = (x = 0.5, y = 64, z = 0.5) => ({ x, y, z });
const TASK_FACT_KEYS = new Set(['noProgressRuns', 'lastLocalFailure', 'lastSourceSwitch', 'lastRegionExpansion']);
const TASK_FACT_RUN_KEYS = new Set(['at', 'dim', 'signature', 'sourceKey', 'what', 'outcome', 'summary']);
const FORBIDDEN_SPATIAL_KEYS = /^(cells?|voxels?|fragments?|traversals?|nodes?|edges?|blocks?|blockStates?|containers?|containerContents|items?|slots?|geometry|shapes?|observations?|polyline)$/i;

/** Curio 任务事实只能有搜索状态；格点/几何/容器内容仍归共享空间库。 */
function assertNoSpatialPayload(value: unknown, path = 'taskFacts') {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, FORBIDDEN_SPATIAL_KEYS, `${path}.${key} 不应把空间历史复制进 Curio 任务事实`);
    assertNoSpatialPayload(child, `${path}.${key}`);
  }
}

/** 资源搜索状态只走 Mind 现有的任务事实/闸门；这里用同一套 deps 形状，不另造状态。 */
function searchHarness(opts: { dim?: string; pos?: { x: number; y: number; z: number }; chunks?: number } = {}) {
  const self = new SelfModel(null);
  self.setPlan('找木料砍 6 根原木', ['找树砍 6 根原木']);
  const events: { type: string; msg: string }[] = [];
  const thinks: { reason: string; tier: string }[] = [];
  const state = { worldId: 'w', sessionId: 's', dim: opts.dim ?? 'overworld', pos: { ...(opts.pos ?? P()) } };
  const mind = Object.create(Mind.prototype) as any;
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
  const goto = (dim: string, pos = P()) => Object.assign(state, { dim, pos: { ...pos } });
  return { mind, self, events, thinks, activity, state, goto };
}

test('局部 look_around 未见只否定这次观察，不推出区域/维度为空', () => {
  const state = { worldId: 'w', sessionId: 's', dim: 'overworld', pos: P(), inventory: [] } as any;
  const failure = { status: 'failed' as const, failureCode: 'NOT_FOUND' as const, summary: '视野内未见 oak_log', data: { problem: { kind: 'TARGET_NOT_OBSERVED' } } };
  assert.equal(localStepFailure({ skill: 'look_around' }, failure, state, 0), null, '观察未命中不是局部移动失败');

  const look = createActivity({
    what: '走远找树砍原木', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'look_around', args: { for: 'oak_log' } }],
  }, '', 'llm', state);
  look.index = 1;
  assert.equal(softMiss(look, { skill: 'look_around' }, failure), true, '只读观察没看到目标不判这段活失败');
  look.results.push({ skill: 'look_around', args: {}, status: 'failed', failureCode: 'NOT_FOUND', summary: failure.summary, at: Date.now(), durationMs: 2, pos: P() });
  const record = recordOf(look, 'done', '观察完成', state, { newChunks: 0 });
  assert.equal(record.exploration?.searchIntent, true);
  assert.equal(record.exploration?.localOnly, true, '原地观察只能算局部覆盖');
  assert.equal(record.exploration?.maxHorizontal, 0);
  assert.equal(record.exploration?.visitedCells, 1);
  assert.equal(record.resource?.located, false);
  assert.equal(record.resource?.acquired, null, '寻找类目标没有取得语义');
  assert.equal(record.resource?.goalIncomplete, true, '资源目标未完成只是缺口，不是“区域没有资源”');
  assert.match(planCoverageGap(look) ?? '', /不能当作远行或远处搜索/);

  const { mind, activity } = searchHarness();
  mind.noteProgressOutcome(activity(), { outcome: 'done', gained: {}, summary: failure.summary }, false);
  const facts = mind.d.self.taskFacts();
  assert.equal(facts.lastLocalFailure, null, '观察未命中不产生“换来源”门禁的局部失败');
  assert.equal(facts.noProgressRuns.length, 1);
  assert.match(facts.noProgressRuns[0].summary, /视野内未见/);
  const run: Record<string, unknown> = { ...facts.noProgressRuns[0] };
  assert.deepEqual(Object.keys(run).filter((key) => !TASK_FACT_RUN_KEYS.has(key)), [], '无进展记录只保留搜索状态字段');
});

test('同区域重复观察、无新区块、无位移判无进展；证据键带 world/session/dim/区域', () => {
  const { mind, self, activity, events } = searchHarness({ dim: 'overworld', chunks: 0 });
  const miss = { outcome: 'done', gained: {}, summary: '视野内未见 oak_log' };
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) mind.noteProgressOutcome(activity(), miss, false);

  const runs = self.taskFacts().noProgressRuns ?? [];
  assert.equal(runs.length, Mind.PROGRESS_GATE_ACTIVITIES, '无位移、无新区块、无物品的重复观察累计为无进展');
  assert.match(runs.at(-1)!.sourceKey!, /^look_around:log\|0,0\|w\|s\|overworld\|0\|/, '键含做法、区域、世界、会话、维度与证据版本');
  assert.ok(mind.progressGate);
  assert.ok(events.some((event) => event.type === 'progress_gate'));

  const repeat = { kind: 'new', notes: [], activity: { what: '再看一次', steps: [{ skill: 'look_around', args: { for: 'log' } }] } };
  assert.equal(mind.enforceProgressGate(repeat, {}), false, '同一区域、同一证据版本仍是重复');

  // 同一做法、同一区域坐标，但已换维度：不能把别的维度当成同一处重复。
  mind.d.adapter = { state: () => ({ worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0.5, y: 70, z: 0.5 } }) };
  const netherSame = { kind: 'new', notes: [], activity: { what: '在下界再看一次', steps: [{ skill: 'look_around', args: { for: 'log' } }] } };
  assert.equal(mind.enforceProgressGate(netherSame, {}), true, '维度不同不算同一区域重复');
  assert.equal(mind.progressGate, null);
});

test('换维是 Agent 决策：无证据被拒且不改写步骤，有证据/理由才放行；空闲不自动换维', () => {
  const { mind, events, thinks } = searchHarness({ dim: 'the_nether' });
  const failure = { at: Date.now(), skill: 'move_step', code: 'BAD_ARGS', summary: '目标脚高 70 没有支撑，只有 68', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: P(0.5, 68), chunks: 0 };
  mind.lastLocalFailure = { ...failure };
  const steps = [{ skill: 'travel_portal', args: { portalId: 'p1' } }];
  const denied: any = { kind: 'new', notes: [], activity: { what: '回主世界', kind: 'explore', steps } };
  assert.equal(mind.enforceSourceSwitchEvidence(denied, {}), false);
  assert.equal(denied.activity, undefined, '拒绝时不替 Agent 生成换维动作');
  assert.equal(denied.next, undefined, '拒绝时不排队替代动作');
  assert.equal(denied.kind, 'continue', '拒绝后交回 Agent 重新决定');
  assert.equal(mind.d.self.taskFacts().lastSourceSwitch ?? null, null, '被拒绝的换维不写入换维证据');
  assert.ok(events.some((event) => event.type === 'source_switch_rejected'));
  assert.equal(thinks.at(-1)?.tier, 'deliberate');

  const searched = searchHarness({ dim: 'the_nether' });
  searched.mind.lastLocalFailure = { ...failure };
  const allowed: any = { kind: 'new', notes: [], activity: { what: '先远征找证据', steps: [{ skill: 'expedition', args: { direction: 'E', distance: 120, find: 'crimson_stem' } }, { skill: 'recall_portal' }] } };
  assert.equal(searched.mind.enforceSourceSwitchEvidence(allowed, {}), true);
  assert.equal(searched.mind.lastLocalFailure, null, '带证据的换维通过一次后不再重复拦截');
  const sw = searched.self.taskFacts().lastSourceSwitch!;
  assert.deepEqual({ from: sw.from, to: sw.to, reason: sw.reason, worldId: sw.worldId, sessionId: sw.sessionId },
    { from: 'the_nether', to: 'overworld', reason: 'activity-evidence', worldId: 'w', sessionId: 's' }, '换维记录来源、目标、理由与作用域');

  const planned = searchHarness({ dim: 'the_nether' });
  planned.mind.lastLocalFailure = { ...failure };
  const withReason: any = { kind: 'new', notes: [], plan: { switchReason: '主世界存箱里有木料' }, activity: { what: '回主世界开箱', steps: [{ skill: 'travel_portal', args: { portalId: 'p1' } }] } };
  assert.equal(planned.mind.enforceSourceSwitchEvidence(withReason, {}), true);
  const plannedSwitch = planned.self.taskFacts().lastSourceSwitch!;
  assert.equal(plannedSwitch.reason, 'plan-reason');
  assert.equal(plannedSwitch.to, null, 'travel_portal 目的地未知，等实际换维后再补');

  // 空闲等待不是自动探索/换维：只维持视野，不排队 portal 或扫描。
  const started: { skill: string; source: string }[] = [];
  const idle = searchHarness({ dim: 'overworld' });
  idle.mind.thinking = {};
  idle.mind.fillerAt = 0;
  idle.mind.d.arbiter = { info: () => null, start: (task: { skill: string }, source: string) => started.push({ skill: task.skill, source }) };
  idle.mind.idle();
  assert.deepEqual(started.map((entry) => entry.skill), ['glance']);
  assert.equal(started[0]?.source, 'filler');
});

test('搜索状态跨重连保留，但任务事实不复制空间历史', () => {
  const { mind, self, activity } = searchHarness({ dim: 'the_nether', chunks: 2 });
  for (let i = 0; i < 3; i++) mind.noteProgressOutcome(activity(), { outcome: 'done', gained: {}, summary: '视野内未见 crimson_stem' }, false);

  const facts = self.taskFacts();
  assert.deepEqual(Object.keys(facts).filter((key) => !TASK_FACT_KEYS.has(key)), [], '任务事实不新增未声明的搜索/空间状态');
  assert.equal(facts.noProgressRuns?.length, 3);
  assert.equal(facts.lastLocalFailure, null);
  assertNoSpatialPayload(facts);

  const memory = new WorldMemory(null);
  const restored = new Mind({
    adapter: new FakeAdapter(), arbiter: {} as any, perception: {} as any, memory, bus: new EventBus(), self, persona: '',
    thinker: { skillStats: undefined, successfulEmergencyVersions: undefined } as any,
  });
  assert.equal((restored as any).noProgressRuns.length, 3, '重连后仍保留无进展次数');
  assert.match((restored as any).noProgressRuns[0].sourceKey, /\|w\|s\|the_nether\|2\|/, '重连后仍保留区域/世界/会话/维度/证据版本');
  memory.close();
});

test('最近换维/换区证据跨重连保留，过期或换了世界/会话不再恢复', () => {
  const self = new SelfModel(null);
  const now = Date.now();
  const fresh = {
    lastSourceSwitch: { at: now, from: 'overworld', to: 'the_nether', reason: 'plan-reason', worldId: 'fake-world', sessionId: 'fake-session' },
    lastRegionExpansion: { at: now, region: '0,0', chunks: 2, dim: 'overworld', worldId: 'fake-world', sessionId: 'fake-session' },
  };
  self.setTaskFacts(fresh);
  const memory = new WorldMemory(null);
  const build = () => new Mind({
    adapter: new FakeAdapter(), arbiter: {} as any, perception: {} as any, memory, bus: new EventBus(), self, persona: '',
    thinker: { skillStats: undefined, successfulEmergencyVersions: undefined } as any,
  }) as any;

  const restored = build();
  assert.equal(restored.lastSourceSwitch?.to, 'the_nether');
  assert.equal(restored.lastRegionExpansion?.chunks, 2);

  self.setTaskFacts({
    lastSourceSwitch: { ...fresh.lastSourceSwitch, sessionId: 'other-session' },
    lastRegionExpansion: { ...fresh.lastRegionExpansion, sessionId: 'other-session' },
  });
  const foreign = build();
  assert.equal(foreign.lastSourceSwitch, null, '别的会话的换维证据不拿来判当前状态');
  assert.equal(foreign.lastRegionExpansion, null);

  self.setTaskFacts({
    lastSourceSwitch: { ...fresh.lastSourceSwitch, at: now - Mind.SEARCH_STATE_TTL_MS - 1 },
    lastRegionExpansion: { ...fresh.lastRegionExpansion, at: now - Mind.SEARCH_STATE_TTL_MS - 1 },
  });
  const stale = build();
  assert.equal(stale.lastSourceSwitch, null, '过期换维证据不再恢复');
  assert.equal(stale.lastRegionExpansion, null);
  memory.close();
});

test('实测新区块写入换区证据并改变无进展证据版本；新区块不算无进展', () => {
  const h = searchHarness({ dim: 'overworld', chunks: 0 });
  const miss = { outcome: 'done', gained: {}, summary: '视野内未见 oak_log' };
  h.mind.noteProgressOutcome({ ...h.activity(), startChunks: 0 }, miss, false);
  const keyBefore = h.self.taskFacts().noProgressRuns![0]!.sourceKey!;
  assert.match(keyBefore, /\|0\|/);

  h.mind.d.memory.visitedChunkCount = 2;
  h.mind.noteProgressOutcome({ ...h.activity(), startChunks: 0 }, { outcome: 'done', gained: {}, summary: '走进新区块' }, true);
  const expansion = h.self.taskFacts().lastRegionExpansion!;
  assert.equal(expansion.chunks, 2);
  assert.equal(expansion.dim, 'overworld');
  assert.equal(expansion.worldId, 'w');
  assert.match(expansion.region, /^\d+,\d+$/);
  assert.equal(h.mind.noProgressRuns.length, 0, '实测新区块算进展，不计无进展');

  // 同一做法、同一区域、同一份任务事实，只把证据版本里的 visitedChunkCount 改成 2。
  h.mind.noteProgressOutcome({ ...h.activity(), startChunks: 2 }, miss, false);
  const keyAfter = h.self.taskFacts().noProgressRuns![0]!.sourceKey!;
  assert.notEqual(keyAfter, keyBefore, 'visitedChunkCount 变化会改变证据版本');
  assert.match(keyAfter, /\|2\|/);
});

test('新区块与实际位移是可测进展，局部观察仍不是远处覆盖', () => {
  const state = { worldId: 'w', sessionId: 's', dim: 'overworld', pos: P(), inventory: [] } as any;
  const a = createActivity({ what: '走远找树砍原木', why: '', kind: 'explore', repeat: 1, steps: [{ skill: 'move_step', args: { at: [20, 0, 0] } }] }, '', 'llm', state);
  a.results.push({ skill: 'move_step', args: {}, status: 'succeeded', summary: '走远 20 格', at: Date.now(), durationMs: 2, pos: { x: 20.5, y: 64, z: 0.5 } });
  const progressed = recordOf(a, 'done', '走远观察', state, { newChunks: 2 });
  assert.equal(progressed.exploration?.newChunks, 2);
  assert.ok((progressed.exploration?.maxHorizontal ?? 0) >= 16);
  assert.equal(progressed.exploration?.localOnly, false, '有实际位移和新区块，不是原地观察');
});

test('空间历史仍由共享空间库承担，Curio 任务事实不复制格点/几何/容器内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs04-spatial-'));
  const svc = await SharedSpatialSession.open({ worldId: 'rs04-world', databasePath: join(dir, 'memory.db'), timeoutMs: 5000 });
  let shutdown: ShutdownResult | null = null;
  const observedAt = Date.now();
  try {
    svc.beginSession({ worldId: 'rs04-world', dim: 'overworld', sessionId: 'rs04-session' });
    const block = (pos: { x: number; y: number; z: number }, name: string, observationId: number) => ({
      worldId: 'rs04-world', sessionId: 'rs04-session', dimension: 'overworld', source: 'vision' as const,
      stateComplete: true, observedAt, observationId, pos, name, properties: {},
    });
    const report = svc.observe([
      block({ x: 0, y: -1, z: 0 }, 'minecraft:stone', 1),
      block({ x: 0, y: 0, z: 0 }, 'minecraft:air', 2),
      block({ x: 0, y: 1, z: 0 }, 'minecraft:air', 3),
    ]);
    assert.ok(report.sections.length > 0, '真实观测应产生空间报告');
    assert.equal(svc.session.voxel.cellAt('overworld', 0, -1, 0).observed, true, 'voxel 证据可读');

    svc.session.facts.upsertPlace({
      id: 'p-rs04', kind: 'base', label: 'rs04 base', worldId: 'rs04-world', dim: 'overworld',
      location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } }, observedAt,
      source: { source: 'vision' }, gone: false,
    });
    const cells = svc.query({ kind: 'cells', dim: 'overworld', positions: [{ x: 0, y: -1, z: 0 }] });
    const places = svc.query({ kind: 'places', dim: 'overworld', limit: 5 });
    assert.equal(cells.status, 'ok');
    assert.equal((cells.data as { cells: { observed: boolean }[] }).cells[0]?.observed, true);
    assert.equal(places.status, 'ok');
    assert.equal((places.data as { items: { id: string }[] }).items[0]?.id, 'p-rs04');
    assert.equal(svc.session.legacyStoreSummary.fragments, 0, '普通语义事实不创建旧路线行');
  } finally {
    try { shutdown = await svc.shutdown(); } catch { /* 保留临时目录作为诊断证据 */ }
    if (shutdown?.close?.completed === true && shutdown.close.error === null) rmSync(dir, { recursive: true, force: true });
  }

  const h = searchHarness({ dim: 'overworld', chunks: 3 });
  h.mind.noteProgressOutcome({ ...h.activity(), startChunks: 0 }, { outcome: 'done', gained: {}, summary: '走进新区块，视野内未见 oak_log' }, true);
  const facts = h.self.taskFacts();
  assert.ok(facts.lastRegionExpansion, 'Curio 只留换区证据');
  assert.deepEqual(Object.keys(facts).filter((key) => !TASK_FACT_KEYS.has(key)), []);
  assertNoSpatialPayload(facts);
});

test('Overworld↔Nether 局部未见循环不算进展：两个维度的同区域重复都被拒', () => {
  const h = searchHarness({ dim: 'overworld', pos: P(0.5, 64), chunks: 0 });
  const miss = { outcome: 'done', gained: {}, summary: '视野内未见 oak_log' };
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) h.mind.noteProgressOutcome(h.activity(), miss, false);
  h.goto('the_nether', P(0.5, 70, 0.5));
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) h.mind.noteProgressOutcome(h.activity(), miss, false);

  const runs = h.self.taskFacts().noProgressRuns ?? [];
  assert.equal(runs.length, Mind.PROGRESS_GATE_ACTIVITIES * 2);
  assert.deepEqual([...new Set(runs.map((run) => run.sourceKey!.split('|')[4]))].sort(), ['overworld', 'the_nether'], '换维没有清空无进展记录');
  assert.ok(h.mind.progressGate);

  const look = (what: string) => ({ kind: 'new', notes: [], activity: { what, steps: [{ skill: 'look_around', args: { for: 'log' } }] } });
  h.goto('overworld', P(0.5, 64, 0.5));
  assert.equal(h.mind.enforceProgressGate(look('回主世界再看'), {}), false);
  h.goto('the_nether', P(0.5, 70, 0.5));
  assert.equal(h.mind.enforceProgressGate(look('去下界再看'), {}), false, '换维本身不是进展，不能清掉同区域重复');
  assert.ok(h.mind.progressGate, '来回振荡两次仍未通过闸门');

  h.goto('overworld', P(20.5, 64, 0.5));
  assert.equal(h.mind.enforceProgressGate(look('去东边看'), {}), true, '换了区域才是新证据');
  assert.equal(h.mind.progressGate, null);
});
