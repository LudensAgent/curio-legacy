import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { localStepFailure } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { SelfModel } from '../src/mind/self.ts';
import { FakeAdapter } from './fake-adapter.ts';

function harness() {
  const events: { type: string; msg: string }[] = [];
  const thinks: { reason: string; tier: string }[] = [];
  const taskFacts: unknown[] = [];
  const mind = Object.create(Mind.prototype) as any;
  mind.d = {
    adapter: { state: () => ({ worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0.5, y: 70, z: 0.5 } }) },
    memory: { visitedChunkCount: 5 },
    bus: { publish: (type: string, _severity: string, msg: string) => events.push({ type, msg }) },
    self: { setTaskFacts: (facts: unknown) => taskFacts.push(facts) },
  };
  Object.assign(mind, {
    noProgressRuns: [],
    lastLocalFailure: { at: Date.now(), skill: 'move_step', code: 'FOOT_HEIGHT_MISMATCH', summary: '目标脚高 72 没有支撑，只有 69', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0.5, y: 70, z: 0.5 }, chunks: 5 },
    sourceSwitchRejects: 0, order: null, userSuggestion: null,
  });
  mind.requestThink = (reason: string, tier: string) => thinks.push({ reason, tier });
  const activity = (steps: { skill: string; args?: unknown }[], what = '回主世界翻箱子') => ({ what, kind: 'explore', steps });
  return { mind, events, thinks, taskFacts, activity };
}

test('move_step 的 BAD_ARGS + data.problem.kind 才记为局部失败；观察类失败不算', () => {
  const state = { worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0.5, y: 70, z: 0.5 } };
  const local = localStepFailure({ skill: 'move_step' }, {
    failureCode: 'BAD_ARGS', summary: '目标脚高 72 没有支撑，只有 69', data: { problem: { kind: 'FOOT_HEIGHT_MISMATCH' } },
  }, state, 5);
  assert.equal(local?.skill, 'move_step');
  assert.equal(local?.chunks, 5);
  assert.equal(localStepFailure({ skill: 'look_around' }, {
    failureCode: 'NOT_FOUND', summary: '视野内未见', data: { problem: { kind: 'TARGET_NOT_OBSERVED' } },
  }, state, 5), null, '观察未命中不是局部移动失败');
});

test('局部失败后直接换维度、没有新证据：拒绝一次并要求重想', () => {
  const { mind, events, thinks, activity } = harness();
  const decision: any = { kind: 'new', notes: [], activity: activity([{ skill: 'go_near' }, { skill: 'travel_portal', args: { portalId: 'p' } }]) };
  assert.equal(mind.enforceSourceSwitchEvidence(decision, {}), false);
  assert.ok(decision.notes.some((note: string) => /只说明那一步|不能推出/.test(note)));
  assert.ok(events.some((event) => event.type === 'source_switch_rejected'));
  assert.equal(thinks[0]?.tier, 'deliberate');
});

test('先有开箱/远征搜索等新证据，或 plan 说明理由：允许换来源', () => {
  const opened = harness();
  const withChest: any = { kind: 'new', notes: [], activity: opened.activity([{ skill: 'take_items', args: { target: { x: 1, y: 70, z: 0 } } }, { skill: 'travel_portal' }]) };
  assert.equal(opened.mind.enforceSourceSwitchEvidence(withChest, {}), true);
  assert.equal(opened.mind.lastLocalFailure, null);

  const searched = harness();
  const withSearch: any = { kind: 'new', notes: [], activity: searched.activity([{ skill: 'expedition', args: { direction: 'E', distance: 120, find: 'crimson_stem' } }, { skill: 'travel_portal' }]) };
  assert.equal(searched.mind.enforceSourceSwitchEvidence(withSearch, {}), true);

  const planned = harness();
  const withPlan: any = { kind: 'new', notes: [], plan: { switchReason: '另一侧已知有箱子，先去核对' }, activity: planned.activity([{ skill: 'travel_portal' }]) };
  assert.equal(planned.mind.enforceSourceSwitchEvidence(withPlan, {}), true);
});

test('连续第二次仍无新证据：放行但标未验证，避免困死紧急返程', () => {
  const { mind, events, activity } = harness();
  const decision: any = { kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) };
  assert.equal(mind.enforceSourceSwitchEvidence(decision, {}), false);
  const second: any = { kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) };
  assert.equal(mind.enforceSourceSwitchEvidence(second, {}), true);
  assert.ok(events.some((event) => event.type === 'source_switch_unverified'));
});

test('重连后从持久化的任务事实恢复无进展记录和未过期的局部失败', () => {
  const self = new SelfModel(null);
  const now = Date.now();
  self.setTaskFacts({
    noProgressRuns: [{ at: now - 60_000, signature: 'gather:oak_log', what: '找木料', outcome: 'done', summary: '没找到' }],
    lastLocalFailure: { at: now - 60_000, skill: 'move_step', code: 'BAD_ARGS', summary: '这一步没支撑', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 }, chunks: 3 },
  });
  const memory = new WorldMemory(null);
  const mind = new Mind({
    adapter: new FakeAdapter(), arbiter: {} as any, perception: {} as any, memory, bus: new EventBus(), self, persona: '',
    thinker: { skillStats: undefined, successfulEmergencyVersions: undefined } as any,
  });
  assert.equal((mind as any).noProgressRuns.length, 1);
  assert.equal((mind as any).lastLocalFailure?.skill, 'move_step');

  self.setTaskFacts({ lastLocalFailure: { at: now - Mind.LOCAL_FAILURE_TTL_MS - 1, skill: 'move_step', code: 'BAD_ARGS', summary: '过期', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 } } });
  const fresh = new Mind({
    adapter: new FakeAdapter(), arbiter: {} as any, perception: {} as any, memory, bus: new EventBus(), self, persona: '',
    thinker: { skillStats: undefined, successfulEmergencyVersions: undefined } as any,
  });
  assert.equal((fresh as any).lastLocalFailure, null, '过期局部失败不能拿去拦当前决策');
  memory.close();
});

test('紧急/操作者指令不受局部失败证据门禁阻挡；任务事实可跨重连保留', () => {
  const { mind, activity } = harness();
  assert.equal(mind.enforceSourceSwitchEvidence({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) }, { urgent: true }), true);
  mind.order = { text: '快回主世界', at: Date.now(), status: 'doing', nudged: 0, kind: 'order' };
  assert.equal(mind.enforceSourceSwitchEvidence({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) }, {}), true);

  const self = new SelfModel(null);
  const facts = { noProgressRuns: [{ at: Date.now(), signature: 'gather:oak_log', what: '找木料', outcome: 'done', summary: '没找到' }],
    lastLocalFailure: { at: Date.now(), skill: 'move_step', code: 'FOOT_HEIGHT_MISMATCH', summary: '这一步没支撑', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 }, chunks: 3 } };
  self.setTaskFacts(facts);
  assert.deepEqual(self.taskFacts(), facts);
});
