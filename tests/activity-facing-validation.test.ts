import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, nextStep } from '../src/mind/activity.ts';
import { parseDecision, validateDraft } from '../src/mind/thinker.ts';
import { SKILLS } from '../src/skills/index.ts';
import { makeCtx, observeAllBlocks, TestWorld } from './survival-helpers.ts';

test('the recorded north narrative with explicit south steps is rejected until the activity declares its frame', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const activity = { what: '清掉前方头位石头，踏上台阶继续往北下一级', repeat: 4, steps: [
    { skill: 'mine_cell', args: { at: [1, 1, 0], facing: 'S' } },
    { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'S' } },
    { skill: 'move_step', args: { to: [1, 0, 0], facing: 'S' } },
    { skill: 'mine_cell', args: { at: [0, -1, 0], facing: 'S' } },
  ] };
  const original = JSON.stringify(activity);
  const missing = parseDecision({ decision: 'continue', activity }, adapter, memory, false);
  assert.ok('error' in missing);
  assert.match(missing.error, /必须显式声明 activity.facing/);
  const conflict = validateDraft({ ...activity, facing: 'N' }, adapter, memory, []);
  assert.ok('error' in conflict);
  assert.match(conflict.error, /activity.facing=N.*facing=S.*冲突/);
  assert.equal(JSON.stringify(activity), original, 'validation must not silently rewrite south to north');
  assert.deepEqual(adapter.actions, []);
});

test('all horizontal primitive aliases bind to the declared frame and even optional conflicts are rejected', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  adapter.yaw = Math.PI;
  for (const step of [
    { skill: 'mine_cell', args: { offset: { forward: 1, up: 0, right: 0 } } },
    { skill: 'move_step', args: [1, 0, 0] },
    { skill: 'place_cell', args: { cell: '1,0,0', item: 'cobblestone' } },
  ]) {
    const draft = validateDraft({ what: '检查目标格', facing: 'N', steps: [step] }, adapter, memory, []);
    assert.ok(!('error' in draft), JSON.stringify(draft));
    assert.equal((draft.steps[0].args as { facing: string }).facing, 'N');
    const missing = validateDraft({ what: '检查目标格', steps: [step] }, adapter, memory, []);
    assert.ok('error' in missing);
  }
  const conflict = validateDraft({ what: '检查目标格', facing: 'N', steps: [
    { skill: 'look', args: { dir: 'S' } },
    { skill: 'mine_cell', args: { at: [1, 0, 0], facing: 'S' }, optional: true },
  ] }, adapter, memory, []);
  assert.ok('error' in conflict);
  assert.match(conflict.error, /冲突/);
});

test('camera turns do not change a declared north frame across routine repetitions', async (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } });
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = Math.PI;
  const draft = validateDraft({ what: '按北向坐标连续迈步', facing: 'N', repeat: 2, steps: [
    { skill: 'look', args: { dir: 'S' } },
    { skill: 'move_step', args: { to: [1, 0, 0] } },
  ] }, adapter, ctx.memory, []);
  assert.ok(!('error' in draft), JSON.stringify(draft));
  const activity = createActivity(draft, '', 'llm', adapter.state());
  for (let step = nextStep(activity); step; step = nextStep(activity)) {
    const result = await SKILLS[step.skill].run(ctx, step.args);
    assert.equal(result.status, 'succeeded', result.summary);
  }
  assert.equal(Math.floor(adapter.pos.z), -2);
  assert.equal(activity.facing, 'N');
});

test('changing the frame, backward steps, world coordinates, and vertical work remain expressible', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  for (const activity of [
    { what: '改用南向坐标', facing: 'S', steps: [{ skill: 'move_step', args: { to: [1, 0, 0], facing: 'S' } }] },
    { what: '在北向坐标下退后', facing: 'N', steps: [{ skill: 'move_step', args: { to: [-1, 0, 0] } }] },
    { what: '在北向坐标下向右', facing: 'N', steps: [{ skill: 'move_step', args: { to: [0, 0, 1] } }] },
    { what: '挖头顶', steps: [{ skill: 'mine_cell', args: { at: [0, 2, 0] } }] },
    { what: '走到世界格', steps: [{ skill: 'move_step', args: { xyz: [1, 64, 0] } }] },
    { what: '挖世界格', steps: [{ skill: 'mine_cell', args: { world: '1,64,0', facing: 'S' } }] },
    { what: '放到世界格', steps: [{ skill: 'place_cell', args: { abs: { x: 1, y: 64, z: 0 }, item: 'cobblestone' } }] },
  ]) {
    const draft = validateDraft(activity, adapter, memory, []);
    assert.ok(!('error' in draft), JSON.stringify(draft));
  }
  const invalid = validateDraft({ what: '错误坐标方向', facing: 'NE', steps: [{ skill: 'look_around' }] }, adapter, memory, []);
  assert.ok('error' in invalid);
  assert.match(invalid.error, /facing 必须是 N\/E\/S\/W/);
});

test('a queued next activity keeps its own declared frame and cannot borrow the current one', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const activity = { what: '第一段', facing: 'N', steps: [{ skill: 'move_step', args: { to: [1, 0, 0] } }] };
  const next = { what: '第二段', facing: 'S', steps: [{ skill: 'move_step', args: { to: [1, 0, 0] } }] };
  const parsed = parseDecision({ decision: 'new', activity, next }, adapter, memory, false);
  assert.ok(!('error' in parsed));
  assert.equal(parsed.activity?.facing, 'N');
  assert.equal(parsed.next?.facing, 'S');
  assert.equal((parsed.next?.steps[0].args as { facing: string }).facing, 'S');
  const rejected = parseDecision({ decision: 'new', activity, next: { what: next.what, steps: next.steps } }, adapter, memory, false);
  assert.ok(!('error' in rejected));
  assert.equal(rejected.next, undefined);
  assert.match(rejected.notes.join(' '), /next 已忽略.*必须显式声明 next.facing/);
});
