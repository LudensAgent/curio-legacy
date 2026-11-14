import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, describeActivity, recordOf } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import type { ActivityDraft, MindDecision } from '../src/mind/types.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('同一位置连续路径失败时，用户提醒保留失败事实，不把程序失败归因成缺少施工', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  const failures = [
    { skill: 'travel_to', failure_code: 'TIMEOUT', summary: '累计搜索预算 6 已用尽，已确认 6 段' },
    { skill: 'explore_toward', failure_code: 'PATH_NOT_FOUND', summary: 'INVALIDATED：搜索期间证据发生变化' },
    { skill: 'navigate_to', failure_code: 'BAD_ARGS', summary: 'to 缺少 y 坐标' },
  ].map((failure) => ({
    ...failure, args: {},
    position: { ...state.pos }, observed_at: new Date().toISOString(), repeats: 2,
  }));
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept, state, self, memory, activity: null,
    suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '',
    lastRecord: null, recentActionFailures: failures });
  assert.match(user.content, /【局部恢复】/);
  const recovery = user.content.split('\n').find((line) => line.includes('【局部恢复】'))!;
  for (const failure of failures) {
    assert.ok(recovery.includes(failure.skill));
    assert.ok(recovery.includes(failure.failure_code));
    assert.ok(recovery.includes(failure.summary));
  }
  assert.doesNotMatch(recovery, /不施工时没找到|没授权挖\/放|excavate_run|place_support|pillar_one|allowDig|allowPlace/);
});

test('activity reference frame survives creation, description, and the completed record', () => {
  const adapter = new FakeAdapter();
  adapter.yaw = Math.PI;
  const draft: ActivityDraft = { what: '继续试验', why: '核对坐标', kind: 'experiment', repeat: 2, facing: 'N',
    steps: [{ skill: 'step', args: { at: [1, 0, 0], facing: 'N' } }] };
  const activity = createActivity(draft, '', 'llm', adapter.state());
  assert.equal(activity.facing, 'N');
  adapter.yaw = -Math.PI / 2;
  assert.equal(describeActivity(activity, adapter.state()).facing, 'N');
  const record = recordOf(activity, 'unmet', '高度尚未达到目标', adapter.state());
  assert.equal(record.facing, 'N');

  const { facing: _, ...unframed } = draft;
  const oldActivity = createActivity(unframed, '', 'llm', adapter.state());
  assert.equal(Object.hasOwn(oldActivity, 'facing'), false);
  assert.equal(Object.hasOwn(describeActivity(oldActivity, adapter.state()), 'facing'), false);
  assert.equal(Object.hasOwn(recordOf(oldActivity, 'done', '结束', adapter.state()), 'facing'), false);
});

test('adjust replaces the activity reference frame and clears it when the new draft has none', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision), self = new SelfModel(null);
  const planner = new Planner(config, { name: 'activity-facing-test', complete: async () => { throw new Error('unexpected model call'); } }, adapter, memory, bus, null);
  const mind = new Mind({ adapter, memory, bus, arbiter, perception, self, persona: '', thinker: new Thinker(planner, adapter, memory, bus, null) });
  t.after(() => { mind.stop(); memory.close(); self.close(); });
  const draft: ActivityDraft = { what: '当前试验', why: '', kind: 'experiment', repeat: 1, facing: 'N',
    steps: [{ skill: 'wait', args: { seconds: 1 } }] };
  const activity = createActivity(draft, '', 'llm', adapter.state());
  mind.activity = activity;
  const apply = Reflect.get(mind, 'apply') as (decision: MindDecision, activityId: string) => void;
  const decision: MindDecision = { kind: 'adjust', monologue: '', notes: [], source: 'llm', tier: 'deliberate', requestedAt: Date.now(),
    activity: { ...draft, facing: 'S' } };
  apply.call(mind, decision, activity.id);
  assert.equal(mind.activity?.id, activity.id);
  assert.equal(mind.activity?.facing, 'S');

  const lesson = self.learn('向上开巷', { source: 'reflection' })!;
  apply.call(mind, { ...decision, activity: { ...draft, facing: 'S', applying: lesson.id } }, activity.id);
  assert.equal(mind.activity?.applying, lesson.id);
  assert.equal(mind.activity?.applyingText, lesson.text, '调整时重新快照当前说法');

  const { facing: _, ...unframed } = draft;
  apply.call(mind, { ...decision, activity: unframed }, activity.id);
  assert.equal(Object.hasOwn(activity, 'facing'), false);
  assert.equal(Object.hasOwn(describeActivity(activity, adapter.state()), 'facing'), false);
  assert.equal(mind.activity?.applying, undefined, '调整未重申 applying 时清掉旧关联');
  assert.equal(mind.activity?.applyingText, undefined);
});

test('瞥一眼同时看到原导航请求、仍在执行的动作、受伤中断和失败回执', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  const args = { to: { x: -96, y: 64, z: 0 }, range: 2, sessionId: 'ms_original' };
  const draft: ActivityDraft = { what: '走向西边已知位置', why: '', kind: 'explore', repeat: 1, steps: [{ skill: 'travel_to', args }] };
  const activity = createActivity(draft, '', 'llm', state);
  activity.lastInterruption = { at: Date.now() - 5000, kind: 'hurt', reason: '挨打了（血 12，僵尸 3格），手上的事先停了', skill: 'travel_to', pos: { ...state.pos } };
  activity.failures = 1;
  activity.results.push({ skill: 'travel_to', args, status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: '按当前授权没找到可执行路线', at: Date.now() - 1000, durationMs: 1000, pos: { ...state.pos } });
  const runningStep = { skill: 'travel_to', args, source: 'llm', startedAt: Date.now() - 70_000 };
  const [, user] = buildMindMessages({ tier: 'glance', reason: '核对执行状态', percept, state, self, memory, activity, runningStep, lastRecord: null,
    suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '' });
  const line = user.content.split('\n').find((item) => item.startsWith('【手上的活】'))!;
  const current = JSON.parse(line.slice('【手上的活】'.length)).current_activity;
  assert.match(current.routine[0], /"range":2/);
  assert.match(current.routine[0], /"sessionId":"ms_original"/);
  assert.equal(current.running_step.skill, 'travel_to');
  assert.deepEqual(current.running_step.args, args);
  assert.ok(current.running_step.elapsed_real_s >= 69);
  assert.equal(current.last_interruption.kind, 'hurt');
  assert.match(current.last_interruption.reason, /挨打了/);
  assert.match(current.recent[0], /travel_to → failed\(PATH_NOT_FOUND\)/, '失败回执与“还在执行/被打断”分开显示');
});

test('both prompt tiers expose the current and previous reference frames separately from the view', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  adapter.yaw = Math.PI;
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update(), state = adapter.state();
  const draft: ActivityDraft = { what: '继续试验', why: '', kind: 'experiment', repeat: 1, facing: 'N',
    steps: [{ skill: 'step', args: { at: [-1, 0, 0], facing: 'N' } }] };
  const activity = createActivity(draft, '', 'llm', state);
  const lastRecord = recordOf(createActivity({ ...draft, facing: 'S', what: '上一段试验',
    steps: [{ skill: 'step', args: { at: [1, 0, 0], facing: 'S' } }] }, '', 'llm', state), 'unmet', '继续观察', state);
  self.record(lastRecord);
  for (const tier of ['deliberate', 'glance'] as const) {
    const [system, user] = buildMindMessages({ tier, reason: '核对方向', percept, state, self, memory, activity, lastRecord,
      suspended: [], noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '' });
    const activityLine = user.content.split('\n').find((line) => line.startsWith('【手上的活】'));
    const recentLine = user.content.split('\n').find((line) => line.startsWith('【最近】'));
    assert.ok(activityLine && recentLine);
    const current: { current_activity: { facing: string } } = JSON.parse(activityLine.slice('【手上的活】'.length));
    const recent: { last_activity: { facing: string }; recent_activities?: { facing: string }[] } = JSON.parse(recentLine.slice('【最近】'.length));
    assert.equal(current.current_activity.facing, 'N');
    assert.equal(recent.last_activity.facing, 'S');
    if (tier === 'deliberate') assert.equal(recent.recent_activities?.length ?? 0, 0, '最近活动不再重复 last_activity');
    assert.equal(percept.self.local?.facing, 'S');
    assert.match(system.content, /"facing":"N\|E\|S\|W（含水平相对操作时必填）"/);
    assert.match(system.content, /子步骤省略 facing 就继承，显式冲突会退回/);
    assert.match(system.content, /绝对 xyz 和纯竖直操作不要求这个字段/);
    assert.match(system.content, /活动参考系独立于镜头朝向/);
    assert.match(system.content, /核对文字目标方向与坐标换算后的实际方向/);
    assert.match(system.content, /facing:"N" 的 \[-1,0,0\] 是向南/);
    assert.match(system.content, /明确声明新的 facing（包括 "S"）；后退\/换向写进步骤或 facing/);
  }
});
