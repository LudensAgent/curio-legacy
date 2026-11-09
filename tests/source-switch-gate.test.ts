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
  assert.equal(mind.lastLocalFailure, null, '未验证放行后不再拿这次失败继续拦截');
  assert.equal(mind.lastSourceSwitch.reason, 'unverified-second-attempt');
  assert.ok(second.notes.some((note: string) => /未验证放行/.test(note)), '未验证这件事要告诉 Agent，不能当来源耗尽证据');
});

test('中间做别的事不会重置拒绝计数：同一次换来源的第二次尝试直接放行', () => {
  const { mind, events, activity } = harness();
  const switchDecision = () => ({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal', args: { portalId: 'p' } }]) });
  assert.equal(mind.enforceSourceSwitchEvidence(switchDecision(), {}), false);
  const local: any = { kind: 'new', notes: [], activity: activity([{ skill: 'look_around' }], '看看附近') };
  assert.equal(mind.enforceSourceSwitchEvidence(local, {}), true, '普通原地活动本身不受来源门禁影响');
  assert.equal(mind.enforceSourceSwitchEvidence(switchDecision(), {}), true, '同一次失败的第二尝试应放行，不能无限重复第一次拒绝');
  assert.equal(events.filter((event) => event.type === 'source_switch_rejected').length, 1);
  assert.equal(events.filter((event) => event.type === 'source_switch_unverified').length, 1);
});

test('拒绝计数只属于同一次局部失败：新的失败重新获得一次先重想的机会', () => {
  const { mind, activity } = harness();
  const switchDecision = () => ({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) });
  assert.equal(mind.enforceSourceSwitchEvidence(switchDecision(), {}), false);
  mind.lastLocalFailure = { ...mind.lastLocalFailure, at: mind.lastLocalFailure.at + 1, summary: '另一个落点也没有支撑' };
  assert.equal(mind.enforceSourceSwitchEvidence(switchDecision(), {}), false, '新失败不是上一次失败的第二次尝试');
  assert.equal(mind.enforceSourceSwitchEvidence(switchDecision(), {}), true);
});

test('实测新区块算新证据；没有 find 的远征不算针对目标的搜索证据', () => {
  const chunks = harness();
  chunks.mind.d.memory.visitedChunkCount = 6;
  const withChunks: any = { kind: 'new', notes: [], activity: chunks.activity([{ skill: 'travel_portal' }]) };
  assert.equal(chunks.mind.enforceSourceSwitchEvidence(withChunks, {}), true);
  assert.equal(chunks.mind.lastSourceSwitch.reason, 'new-chunks');

  const noFind = harness();
  const unsearched: any = { kind: 'new', notes: [], activity: noFind.activity([{ skill: 'expedition', args: { direction: 'E', distance: 120 } }, { skill: 'travel_portal' }]) };
  assert.equal(noFind.mind.enforceSourceSwitchEvidence(unsearched, {}), false, '不带 find 的远征没有目标证据');
});

test('具体证据动作都算：开箱/存取/界面/采集/觅食/打猎/钓鱼/带 find 的远征', () => {
  const evidence: { skill: string; args?: unknown }[] = [
    { skill: 'take_items', args: { target: { x: 1, y: 70, z: 0 } } },
    { skill: 'store_items', args: { target: { x: 1, y: 70, z: 0 } } },
    { skill: 'use_gui' }, { skill: 'gather' }, { skill: 'forage' }, { skill: 'hunt' }, { skill: 'fish' },
    { skill: 'expedition', args: { find: 'crimson_stem' } },
  ];
  for (const step of evidence) {
    const h = harness();
    const decision: any = { kind: 'new', notes: [], activity: h.activity([step, { skill: 'travel_portal' }]) };
    assert.equal(h.mind.enforceSourceSwitchEvidence(decision, {}), true, `${step.skill} 应算新证据`);
    assert.equal(h.mind.lastSourceSwitch.reason, 'activity-evidence');
  }
});

test('顶层 switch_reason 与 plan.switch_reason 一样可作为换来源理由', () => {
  const { mind, activity } = harness();
  const decision: any = { kind: 'new', notes: [], switchReason: '主世界存箱里有木料', activity: activity([{ skill: 'travel_portal' }]) };
  assert.equal(mind.enforceSourceSwitchEvidence(decision, {}), true);
  assert.equal(mind.lastLocalFailure, null);
  assert.equal(mind.lastSourceSwitch.reason, 'plan-reason');
});

test('只排了 next 的换维同样受证据门禁；过期或换世界/会话的失败不再拦', () => {
  const nextOnly = harness();
  const decision: any = { kind: 'continue', notes: [], next: { what: '回主世界', steps: [{ skill: 'recall_portal' }] } };
  assert.equal(nextOnly.mind.enforceSourceSwitchEvidence(decision, {}), false, 'next 里的换维也不能绕过');

  const foreign = harness();
  foreign.mind.d.adapter = { state: () => ({ worldId: 'other-world', sessionId: 's', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 } }) };
  const switchDecision = () => ({ kind: 'new' as const, notes: [], activity: foreign.activity([{ skill: 'travel_portal' }]) });
  assert.equal(foreign.mind.enforceSourceSwitchEvidence(switchDecision(), {}), true);
  assert.equal(foreign.mind.lastLocalFailure, null, '别的世界的失败被清掉');

  const stale = harness();
  stale.mind.lastLocalFailure = { ...stale.mind.lastLocalFailure, at: Date.now() - Mind.LOCAL_FAILURE_TTL_MS - 1 };
  const staleSwitch: any = { kind: 'new', notes: [], activity: stale.activity([{ skill: 'travel_portal' }]) };
  assert.equal(stale.mind.enforceSourceSwitchEvidence(staleSwitch, {}), true);
  assert.equal(stale.mind.lastLocalFailure, null, '过期失败被清掉');
});

test('重连后按世界/会话与 TTL 恢复局部失败：同处未过期才拦当前决策', () => {
  const self = new SelfModel(null);
  const now = Date.now();
  const failure = { at: now - 60_000, skill: 'move_step', code: 'BAD_ARGS', summary: '这一步没支撑', worldId: 'fake-world', sessionId: 'fake-session', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 }, chunks: 3 };
  self.setTaskFacts({
    noProgressRuns: [{ at: now - 60_000, signature: 'gather:oak_log', what: '找木料', outcome: 'done', summary: '没找到' }],
    lastLocalFailure: failure,
  });
  const memory = new WorldMemory(null);
  const build = () => new Mind({
    adapter: new FakeAdapter(), arbiter: {} as any, perception: {} as any, memory, bus: new EventBus(), self, persona: '',
    thinker: { skillStats: undefined, successfulEmergencyVersions: undefined } as any,
  }) as any;
  const mind = build();
  assert.equal(mind.noProgressRuns.length, 1);
  assert.equal(mind.lastLocalFailure?.skill, 'move_step');

  self.setTaskFacts({ lastLocalFailure: { ...failure, sessionId: 'other-session' } });
  assert.equal(build().lastLocalFailure, null, '别的会话的局部失败不拿来拦当前决策');
  self.setTaskFacts({ lastLocalFailure: { ...failure, worldId: 'other-world' } });
  assert.equal(build().lastLocalFailure, null, '别的世界的局部失败不拿来拦当前决策');

  self.setTaskFacts({ lastLocalFailure: { ...failure, at: now - Mind.LOCAL_FAILURE_TTL_MS - 1 } });
  assert.equal(build().lastLocalFailure, null, '过期局部失败不能拿去拦当前决策');
  memory.close();
});

test('紧急/操作者指令不受局部失败证据门禁阻挡；任务事实可跨重连保留', () => {
  const { mind, activity } = harness();
  assert.equal(mind.enforceSourceSwitchEvidence({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) }, { urgent: true }), true);
  mind.order = { text: '快回主世界', at: Date.now(), status: 'doing', nudged: 0, kind: 'order' };
  assert.equal(mind.enforceSourceSwitchEvidence({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) }, {}), true);
  mind.order = null;
  mind.userSuggestion = '回主世界拿木料';
  assert.equal(mind.enforceSourceSwitchEvidence({ kind: 'new', notes: [], activity: activity([{ skill: 'travel_portal' }]) }, {}), true, '操作者建议也不受来源证据门禁阻挡');

  const self = new SelfModel(null);
  const facts = { noProgressRuns: [{ at: Date.now(), signature: 'gather:oak_log', what: '找木料', outcome: 'done', summary: '没找到' }],
    lastLocalFailure: { at: Date.now(), skill: 'move_step', code: 'FOOT_HEIGHT_MISMATCH', summary: '这一步没支撑', worldId: 'w', sessionId: 's', dim: 'the_nether', pos: { x: 0, y: 70, z: 0 }, chunks: 3 } };
  self.setTaskFacts(facts);
  assert.deepEqual(self.taskFacts(), facts);
});
