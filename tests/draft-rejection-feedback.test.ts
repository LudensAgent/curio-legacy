import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, describeActivity } from '../src/mind/activity.ts';
import { validateDraft } from '../src/mind/thinker.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('a rejected learned skill keeps its actual reason in the activity feedback', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  setBehaviorRegistry({
    get: () => undefined,
    list: () => [],
    executionError: (name) => `没有技能 ${name}`,
  });
  t.after(() => { setBehaviorRegistry(null); memory.close(); });

  const notes: string[] = [];
  const draft = validateDraft({ what: '试用技能', steps: [
    { skill: 'use_skill', args: { name: 'short-iron-trip' }, optional: true },
    { skill: 'look_around', args: { seconds: 3 } },
  ] }, adapter, memory, notes);
  assert.ok(!('error' in draft));
  assert.equal(draft.steps.length, 1);
  assert.match(notes.join(' '), /校验失败：没有技能 short-iron-trip/);
  assert.match(draft.dropped?.[0] ?? '', /没有技能 short-iron-trip/);
  assert.doesNotMatch(draft.dropped?.[0] ?? '', /参数写错/);

  const activity = createActivity(draft, '试用技能', 'llm', adapter.state());
  assert.match(describeActivity(activity, adapter.state()).not_done_rejected?.[0] ?? '', /没有技能 short-iron-trip/);
});

test('a rejected parameter records the validator detail', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const draft = validateDraft({ what: '出发', steps: [
    { skill: 'plan_route', args: { mode: 'swim' }, optional: true },
    { skill: 'look_around', args: { seconds: 3 } },
  ] }, adapter, memory, []);
  assert.ok(!('error' in draft));
  assert.match(draft.dropped?.[0] ?? '', /to 需要绝对坐标/);
});

test('a required candidate skill without explicit trial rejects the whole activity', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  setBehaviorRegistry({
    get: (_name, trial) => trial ? { name: 'stairs', description: '下行', steps: [] } : undefined,
    list: () => [],
    executionError: (_name, trial) => trial ? null : 'stairs 尚为候选；用 use_skill {name:"stairs",trial:true} 显式试用',
  });
  t.after(() => { setBehaviorRegistry(null); memory.close(); });
  const activity = { what: '下行', steps: [
    { skill: 'look_around', args: { seconds: 3 } },
    { skill: 'use_skill', args: { name: 'stairs' } },
  ] };
  const rejected = validateDraft(activity, adapter, memory, []);
  assert.ok('error' in rejected);
  assert.match(rejected.error, /必需步骤无法执行.*steps\[1\].*trial:true/);

  const corrected = validateDraft({ ...activity, steps: [activity.steps[0],
    { skill: 'use_skill', args: { name: 'stairs', trial: true } },
  ] }, adapter, memory, []);
  assert.ok(!('error' in corrected));
  assert.equal(corrected.steps.length, 2);
  assert.deepEqual(corrected.steps[1].args, { name: 'stairs', trial: true });
});

test('an activity cannot silently discard required steps after the sixth', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const draft = validateDraft({ what: '长计划', steps: Array.from({ length: 7 }, () => ({ skill: 'look_around', args: { seconds: 3 } })) }, adapter, memory, []);
  assert.ok('error' in draft);
  assert.match(draft.error, /最多 6 个动作/);
});
