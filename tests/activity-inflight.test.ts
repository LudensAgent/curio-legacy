import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { createActivity, describeActivity, recordOf } from '../src/mind/activity.ts';

const state = () => ({
  connected: true, alive: true, observationReady: true, observationId: 1, username: 'tester',
  sessionId: 's', worldId: 'w', dim: 'overworld', pos: { x: 0.5, y: 64, z: 0.5 },
  hp: 20, food: 20, oxygen: 20, timeOfDay: 0,
  inventory: [], emptySlots: 36, equipment: [], held: null,
} as unknown as AgentState);

const walking = (doneWhen?: { type: 'position_y'; max: number }) => {
  const a = createActivity({
    what: '往北走 96 格', why: '看看远处', kind: 'explore', repeat: 1,
    steps: [{ skill: 'travel_to', args: { to: { x: 0, y: 64, z: -96 }, range: 2 } }],
    ...(doneWhen ? { doneWhen } : {}),
  }, '走着看看', 'llm', state());
  a.index = 1; // 调度器派发后 index 指向下一步；正在跑的是第 1 步。
  return a;
};

const running = { skill: 'travel_to', args: { to: { x: 0, y: 64, z: -96 }, range: 2 }, source: 'llm', startedAt: Date.now() - 5_000 };

test('在途移动步：继续语义说明这一步仍会按原参数跑完，停/换会取消且不计完成', () => {
  const a = walking();
  const view = describeActivity(a, state(), undefined, running);
  assert.equal(view.continue_effect.position, 'in_flight_final_step');
  assert.match(view.continue_effect.executing ?? '', /travel_to/);
  assert.match(view.continue_effect.executes_if_continue, /这一步照原参数执行完/);
  assert.ok(view.stop_effect);
  assert.equal(view.stop_effect.cancels_running_step, true);
  assert.match(view.stop_effect.running_step, /travel_to/);
  assert.equal(view.stop_effect.partial_progress_recorded, true);
  assert.match(view.stop_effect.not_counted_as_completed, /不会记为完成/);
  assert.equal(view.done_when, undefined, '没写条件就不补一个假收工条件');
});

test('done_when 只在步骤之间评估：运行中的步不被它自动取消，也不证明原委托完成', () => {
  const a = walking({ type: 'position_y', max: 100 });
  const view = describeActivity(a, state(), undefined, running);
  assert.ok(view.done_when);
  assert.equal(view.done_when.status, 'satisfied');
  assert.equal(view.done_when.evaluated_at, 'between_steps');
  assert.equal(view.done_when.stops_running_step, false);
  assert.match(view.done_when.note, /不会取消正在执行的 travel_to/);
  assert.match(view.done_when.note, /不证明原委托/);
  assert.equal(view.continue_effect.done_when_can_stop_early, true, '下一念可以选择停，但不是程序自动停');
});

test('步骤之间没有在途动作时，continue 只描述下一步，不虚构 stop_effect', () => {
  const a = walking();
  const view = describeActivity(a, state());
  assert.equal(view.continue_effect.position, 'between_steps');
  assert.equal(view.stop_effect, undefined);
  assert.equal(view.running_step, undefined);
});

test('中断记录保留原导航目标/维度/已确认段，不保留可复用的 route handle', () => {
  const a = walking();
  a.navigation = {
    delegationId: a.id, worldId: 'w', dim: 'overworld', measured: { pos: { x: 0.5, y: 64, z: -63.34 }, at: Date.now() },
    destination: { x: 0, y: 64, z: -96 }, completedSegments: 2,
    remaining: [{ x: 0, y: 64, z: -64 }, { x: 0, y: 64, z: -96 }],
    lastInvalidation: { at: Date.now(), reason: '死了' }, phase: 'failed', updatedAt: Date.now(),
  };
  const record = recordOf(a, 'interrupted', '死了', state());
  assert.equal(record.navigation?.dim, 'overworld');
  assert.deepEqual(record.navigation?.destination, { x: 0, y: 64, z: -96 });
  assert.equal(record.navigation?.completedSegments, 2);
  assert.equal(record.navigation?.remaining.length, 2);
  assert.equal(record.navigation?.lastInvalidation, '死了');
  assert.equal(Object.hasOwn(record.navigation!, 'route'), false);
});

test('计划关联随活动进入投影，便于把结果记到成果/做法账上', () => {
  const a = createActivity({
    what: '沿旧路走向远处', why: '换一种做法', kind: 'explore', repeat: 1,
    steps: [{ skill: 'look_around', args: { seconds: 3 } }],
    outcomeId: 'po_abc', methodId: 'pm_def',
  }, '换做法再试', 'llm', state());
  const view = describeActivity(a, state());
  assert.equal(view.outcome_id, 'po_abc');
  assert.equal(view.method_id, 'pm_def');
});
