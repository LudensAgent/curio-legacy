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
    { skill: 'use_skill', args: { name: 'short-iron-trip' } },
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
    { skill: 'travel', args: {} },
    { skill: 'look_around', args: { seconds: 3 } },
  ] }, adapter, memory, []);
  assert.ok(!('error' in draft));
  assert.match(draft.dropped?.[0] ?? '', /to 不能为空/);
});
