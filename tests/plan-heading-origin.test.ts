import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { validateDraft } from '../src/mind/thinker.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('计划里的“方向 + 距离”不在录入时冻结起点：到真正开始执行时按当时位置冻结', (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: -61.5, y: 70, z: -39.5 };
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  const draft = validateDraft({
    what: '往西推进', why: '', kind: 'explore',
    steps: [{ skill: 'travel_to', args: { to: 'W 96' } }, { skill: 'explore_toward', args: { direction: 'W', distance: 96 } }],
  }, adapter, memory, []);
  assert.ok(!('error' in draft), JSON.stringify(draft));
  const [travel, explore] = draft.steps;
  assert.deepEqual((travel.args as { to: unknown }).to, { heading: 'W', distance: 96 }, '录入时不写 origin');
  assert.equal((explore.args as { origin?: unknown }).origin, undefined);

  // 东行 95 格后才轮到这一步：开始时按当时的位置冻结。
  adapter.pos = { x: 33.2, y: 69, z: -39.5 };
  const atStart = SKILLS.travel_to.validate(travel.args, adapter);
  assert.ok(atStart.ok);
  assert.deepEqual((atStart.args as { to: { origin: unknown } }).to.origin, { x: 33.2, y: 69, z: -39.5 });

  // Agent 自己写了 origin：照原样保留。
  const pinned = validateDraft({ what: 'x', why: '', kind: 'explore',
    steps: [{ skill: 'travel_to', args: { to: { heading: 'W', distance: 96, origin: { x: 0, y: 64, z: 0 } } } }] }, adapter, memory, []);
  assert.ok(!('error' in pinned));
  assert.deepEqual((pinned.steps[0].args as { to: { origin: unknown } }).to.origin, { x: 0, y: 64, z: 0 });
});
