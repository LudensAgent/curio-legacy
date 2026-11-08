import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, nextStep } from '../src/mind/activity.ts';
import { parseDecision, validateDraft } from '../src/mind/thinker.ts';
import { SKILLS } from '../src/skills/index.ts';
import { validateSkill } from '../src/skills/types.ts';
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
    // 生产派发在 arbiter.start 会拿当前身体状态重新校验同一 args；这里直接调用 run 时照同样顺序，
    // 避免把草案校验时记录的旧起点当成执行授权（连续两步本来就会改变起点）。
    const validated = SKILLS[step.skill].validate(step.args, adapter);
    if (!validated.ok) assert.fail(validated.error);
    const result = await SKILLS[step.skill].run(ctx, validated.args);
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

test('excavate_run 规范化后不再携带内部 entry，派发时的第二次校验仍能通过', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const draft = validateDraft({ what: '朝东开上行阶梯', steps: [
    { skill: 'excavate_run', args: { mode: 'stairs_up', direction: 'east', steps: 2 } },
  ] }, adapter, memory, []);
  assert.ok(!('error' in draft), JSON.stringify(draft));
  const step = draft.steps[0];
  assert.equal('entry' in (step.args as Record<string, unknown>), false, 'activity 不能保存内部注入的 entry');
  const dispatch = validateSkill(SKILLS.excavate_run, step.args, adapter);
  assert.ok(dispatch.ok, !dispatch.ok ? dispatch.error : '');
  // 参数写错时只报 mode/direction/steps，不再用 entry 误导模型。
  const bad = validateDraft({ what: '方向写错', steps: [
    { skill: 'excavate_run', args: { direction: 'down' } },
  ] }, adapter, memory, []);
  assert.ok('error' in bad);
  assert.doesNotMatch(bad.error, /entry/);
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

test('done_when 需要物品/位置时，只有只读步骤的活整段拒绝', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const readonly = validateDraft({
    what: '环视找树',
    steps: [
      { skill: 'resolve_target', args: { target: 'N 60' } },
      { skill: 'look_around', args: { seconds: 5 } },
    ],
    done_when: { type: 'inventory_min', item: 'oak_log', count: 3 },
  }, adapter, memory, []);
  assert.ok('error' in readonly);
  assert.match(readonly.error, /没有能产生|采集|制作/);

  memory.addLandmark('discovery', '北边目标', 'overworld', { x: 0, y: 64, z: -60 }, 1);
  const noMove = validateDraft({
    what: '算个落点就算走到了',
    steps: [{ skill: 'resolve_target', args: { target: 'N 60' } }],
    done_when: { type: 'location_near', dimension: 'overworld', pos: { x: 0, y: 64, z: -60 }, radius: 4 },
  }, adapter, memory, []);
  assert.ok('error' in noMove);
  assert.match(noMove.error, /没有真正移动|移动步骤/);

  const ok = validateDraft({
    what: '砍树',
    steps: [{ skill: 'gather', args: { block: 'oak_log', count: 3, dig: true } }],
    done_when: { type: 'inventory_min', item: 'oak_log', count: 3 },
  }, adapter, memory, []);
  assert.ok(!('error' in ok), 'error' in ok ? ok.error : '');
});
