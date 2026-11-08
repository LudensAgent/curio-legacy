import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
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
  assert.match(thinks[0]?.reason ?? '', /没有物品\/清单\/新区块进展/);
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
  assert.ok(repeat.notes.some((note: string) => /不同地点\/不同方法/.test(note)));

  const different = {
    kind: 'new', notes: [], activity: {
      what: '沿路远征找木料',
      steps: [{ skill: 'expedition', args: { direction: 'E', distance: 160, find: 'oak_log' } }],
    },
  };
  assert.equal(mind.enforceProgressGate(different, {}), true);
  assert.equal(mind.progressGate, null);
});

test('有物品、清单或新区块进展就清空无进展记录', () => {
  const { mind, activity } = harness();
  for (let i = 0; i < 3; i++) mind.noteProgressOutcome(activity, { outcome: 'done', gained: {}, summary: '没找到' }, false);
  assert.equal(mind.noProgressRuns.length, 3);
  mind.noteProgressOutcome(activity, { outcome: 'done', gained: { oak_log: 2 }, summary: '拿到 2 根' }, true);
  assert.equal(mind.noProgressRuns.length, 0);
  assert.equal(mind.progressGate, null);
});
