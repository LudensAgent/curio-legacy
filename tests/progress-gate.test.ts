import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
import { GOAL_SWITCH_RULE } from '../src/mind/self.ts';
import { SelfModel } from '../src/mind/self.ts';

function harness() {
  const self = new SelfModel(null);
  self.setPlan('补齐木料与工具', ['找树砍 6 根原木']);
  const events: { type: string; msg: string }[] = [];
  const thinks: { reason: string; tier: string }[] = [];
  const mind = Object.create(Mind.prototype) as any;
  mind.d = {
    self,
    bus: { publish: (type: string, _severity: string, msg: string) => events.push({ type, msg }) },
    memory: { visitedChunkCount: 0 },
  };
  Object.assign(mind, {
    noProgressRuns: [], progressGate: null, progressGateRejects: 0, lastProgressGateAt: 0,
    dangerUntil: 0, order: null, userSuggestion: null, review: null, activity: null,
  });
  mind.requestThink = (reason: string, tier: string) => thinks.push({ reason, tier });
  const activity = {
    agendaId: self.plan()!.agendaId,
    what: '在门厅找木料',
    steps: [{ skill: 'find_item', args: { item: 'oak_log' } }],
  };
  return { mind, self, events, thinks, activity };
}

test('连续无进展达到阈值：记录闸门并要求认真想，不替它选做法', () => {
  const { mind, events, thinks, activity } = harness();
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) {
    mind.noteProgressOutcome(activity, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  }
  assert.ok(mind.progressGate, '达到阈值后应有闸门');
  assert.ok(events.some((event) => event.type === 'progress_gate'));
  assert.equal(thinks[0]?.tier, 'deliberate');
  assert.match(thinks[0]?.reason ?? '', /没有物品、清单、新区块、出行最远点或准备度/);
  assert.doesNotMatch(thinks[0]?.reason ?? '', /调整主目标/);
  const facts = mind.progressGateFacts();
  assert.ok(thinks[0]?.reason.includes(GOAL_SWITCH_RULE), '闸门引用统一的换目标规则');
  assert.ok(facts.rule.includes(GOAL_SWITCH_RULE), '闸门事实引用统一的换目标规则');
  assert.match(thinks[0]?.reason ?? '', /阶段回顾/);
  // 只陈述量没变，不断言“同一条路没用”，也不要求必须换做法
  assert.doesNotMatch(thinks[0]?.reason ?? '', /不会产生新信息|必须换/);
});

test('闸门拒绝已出现过的动作签名，换成不同做法则放行并清除', () => {
  const { mind, activity } = harness();
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) {
    mind.noteProgressOutcome(activity, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  }
  const repeat = {
    kind: 'new', notes: [], activity: { what: '再查一次', steps: [{ skill: 'find_item', args: { item: 'oak_log' } }] },
  };
  assert.equal(mind.enforceProgressGate(repeat, {}), false);
  assert.ok(repeat.notes.some((note: string) => /先退回重新确认/.test(note)));

  const different = {
    kind: 'new', notes: [], activity: {
      what: '沿路远征找木料',
      steps: [{ skill: 'expedition', args: { direction: 'E', distance: 160, find: 'oak_log' } }],
    },
  };
  assert.equal(mind.enforceProgressGate(different, {}), true);
  assert.equal(mind.progressGate, null);
});

test('判重带上区域和证据版本：同一做法去了新区块就不再是重复', () => {
  const { mind, activity } = harness();
  mind.d.adapter = { state: () => ({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: { x: 0.5, y: 64, z: 0.5 } }) };
  mind.d.memory.visitedChunkCount = 0;
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) {
    mind.noteProgressOutcome({ ...activity, startPos: { x: 0.5, y: 64, z: 0.5 } }, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  }
  const repeat = {
    kind: 'new', notes: [], activity: { what: '再查一次', steps: [{ skill: 'find_item', args: { item: 'oak_log' } }] },
  };
  assert.equal(mind.enforceProgressGate(repeat, {}), false, '同一区域、同一证据版本仍是重复');

  const moved = harness();
  moved.mind.d.adapter = mind.d.adapter;
  moved.mind.d.memory.visitedChunkCount = 0;
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) {
    moved.mind.noteProgressOutcome({ ...moved.activity, startPos: { x: 0.5, y: 64, z: 0.5 } }, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  }
  moved.mind.d.memory.visitedChunkCount = 4; // 进了新区块：证据版本变了
  const afterExplore = {
    kind: 'new', notes: [], activity: { what: '再查一次', steps: [{ skill: 'find_item', args: { item: 'oak_log' } }] },
  };
  assert.equal(moved.mind.enforceProgressGate(afterExplore, {}), true);
  assert.equal(moved.mind.progressGate, null);
});

test('有物品、清单或新区块进展就清空无进展记录', () => {
  const { mind, activity } = harness();
  for (let i = 0; i < 3; i++) mind.noteProgressOutcome(activity, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  assert.equal(mind.noProgressRuns.length, 3);
  mind.noteProgressOutcome(activity, { outcome: 'done', gained: { oak_log: 2 }, summary: '拿到 2 根' }, true);
  assert.equal(mind.noProgressRuns.length, 0);
  assert.equal(mind.progressGate, null);
});

test('退回到上限后仍写同一做法：按确认原样放行并解除闸门', () => {
  const { mind, activity } = harness();
  for (let i = 0; i < Mind.PROGRESS_GATE_ACTIVITIES; i++) {
    mind.noteProgressOutcome(activity, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  }
  const repeat = () => ({ kind: 'new', notes: [] as string[], activity: { what: '接着查', steps: [{ skill: 'find_item', args: { item: 'oak_log' } }] } });
  for (let i = 0; i < Mind.PROGRESS_GATE_REJECT_LIMIT; i++) assert.equal(mind.enforceProgressGate(repeat(), {}), false);
  const confirmed = repeat();
  assert.equal(mind.enforceProgressGate(confirmed, {}), true);
  assert.ok(confirmed.activity, '确认后的活动不能被丢掉');
  assert.equal(mind.progressGate, null);
});
