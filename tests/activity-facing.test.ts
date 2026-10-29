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

  const { facing: _, ...unframed } = draft;
  apply.call(mind, { ...decision, activity: unframed }, activity.id);
  assert.equal(Object.hasOwn(activity, 'facing'), false);
  assert.equal(Object.hasOwn(describeActivity(activity, adapter.state()), 'facing'), false);
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
    if (tier === 'deliberate') assert.equal(recent.recent_activities?.at(-1)?.facing, 'S');
    assert.equal(percept.self.local?.facing, 'S');
    assert.match(system.content, /"facing":"N\|E\|S\|W（含水平相对操作时必填）"/);
    assert.match(system.content, /子步骤省略 facing 就继承，显式冲突会退回/);
    assert.match(system.content, /绝对 xyz 和纯竖直操作不要求这个字段/);
    assert.match(system.content, /活动参考系独立于镜头朝向/);
    assert.match(system.content, /核对文字目标方向与坐标换算后的实际方向/);
    assert.match(system.content, /facing:"N" 的 \[-1,0,0\] 是向南/);
    assert.match(system.content, /明确声明新的 facing（包括 "S"），后退或换向仍由你决定/);
  }
});
