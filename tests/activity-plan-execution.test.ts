import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { validateDraft } from '../src/mind/thinker.ts';
import { moveStep } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const flat = () => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  return w;
};
const problemKind = (result: { data?: Record<string, unknown> }) => (result.data?.problem as { kind?: string } | undefined)?.kind;

test('多步绝对坐标计划在录入时不被当前起点拒绝', (t) => {
  const adapter = flat(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const notes: string[] = [];
  const steps = [1, 2, 3, 4, 5].map((i) => ({ skill: 'move_step', args: { xyz: [i, 64, 0] } }));
  const draft = validateDraft({ what: '向东走五步', steps }, adapter, memory, notes);
  assert.equal('error' in draft, false, 'error' in draft ? draft.error : '');
  if ('error' in draft) return;
  assert.equal(draft.steps.length, 5);
  // 计划里不保留录入时的起点快照：执行时每一步按最新位置重新预检。
  assert.equal(JSON.stringify(draft.steps).includes('origin'), false);
});

test('多步绝对坐标逐步执行：后一步按前一步实际落点预检，被挡时停在真实位置', async (t) => {
  const adapter = flat(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const notes: string[] = [];
  const steps = [1, 2, 3].map((i) => ({ skill: 'move_step', args: { xyz: [i, 64, 0] } }));
  const draft = validateDraft({ what: '走到第三格', steps }, adapter, memory, notes);
  assert.equal('error' in draft, false, 'error' in draft ? draft.error : '');
  if ('error' in draft) return;
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());

  const first = await moveStep.run(ctx, draft.steps[0]!.args as never);
  assert.equal(first.status, 'succeeded', first.summary);
  assert.equal(Math.floor(adapter.pos.x), 1);

  // 第二步执行前的预检按最新位置通过（x=2 与当前 x=1 相邻）。
  const second = moveStep.validate(draft.steps[1]!.args, adapter);
  assert.equal(second.ok, true, second.ok ? '' : second.error);
  if (!second.ok) return;

  // 人为堵住第二步：两格高的整块墙。预检必须拒绝，且只停在实际位置。
  adapter.blocks.push({ name: 'stone', pos: { x: 2, y: 64, z: 0 } }, { name: 'stone', pos: { x: 2, y: 65, z: 0 } });
  const blocked = await moveStep.run(ctx, second.args);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.data?.movementNotAttempted, true);
  assert.equal(Math.floor(adapter.pos.x), 1, '被挡时停在实际已到达的位置');

  // 未执行第三步：计划保存在内存里，但执行方只在实际到达的位置继续预检。
  const third = moveStep.validate(draft.steps[2]!.args, adapter);
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.error, /不在身边能迈到的范围/);
  assert.equal(Math.floor(adapter.pos.x), 1);
});
