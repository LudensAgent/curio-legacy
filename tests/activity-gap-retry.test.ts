import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, beginStep, clipFeedback, createActivity, describeActivity, nextStep } from '../src/mind/activity.ts';
import type { Condition } from '../src/projects/types.ts';
import { relativeCellAction } from '../src/skills/stance.ts';
import { fail, ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const gather = { skill: 'gather', args: { block: 'stone', count: 3 } };

function activityOf(steps: { skill: string; args?: unknown }[], repeat = 1, doneWhen?: Condition) {
  const adapter = new FakeAdapter();
  return { adapter, activity: createActivity({ what: '测试', why: '', kind: 'other', steps, repeat, ...(doneWhen ? { doneWhen } : {}) }, '', 'llm', adapter.state()) };
}

test('52ms→7ms：有界开挖的确定性预检失败，不因身体或视角变化再原样重试', () => {
  const { adapter, activity } = activityOf([{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 }, view: '{"around":"old"}' };
  // 身体实际位移 + 转头 + 附近出现新资源，都不是“下一落点支撑已改变”的证据。
  const percept = { self: { around: 'new' }, vision: { view: 'turned' }, nearby: { resources: [{ name: 'oak_log' }] } };
  const verdict = afterStep(activity, step, fail('ERROR', '有界开挖停止：下一落点下面是空的（air）：前面脚下是个坑/洞穴', { completedSteps: 0, excavatedBlocks: 0 }), 7, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '不做第二次相同缺口调用');
});

test('surface 只浮起、未触地时，inWater=false 的收工条件不能算完成', () => {
  const { adapter, activity } = activityOf([{ skill: 'swim_path', args: { mode: 'surface' } }], 1, { type: 'self_state', field: 'inWater', equals: false });
  adapter.inWater = false;
  adapter.onGround = false;
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, ok('结束时头已露出流体，还没上岸', { surfaced: true, landed: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'done');
  assert.equal((verdict as { met: boolean }).met, false, '水面浮动的瞬时 inWater=false 不能把活动标成完成');
  assert.match((verdict as { why: string }).why, /没有触地|未确认/);
});

test('相对 step 失败且身体已换位：不自动重试，避免用新站位重算 [1,-1,0]', () => {
  const { adapter, activity } = activityOf([{ skill: 'move_step', args: { at: [1, -1, 0], facing: 'S' } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '没有站到 [1,-1,0]：身体没有站稳', { targetCell: { x: 1, y: 63, z: 0 }, position: { x: 0, y: 64, z: 0 } }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /相对 step 失败后身体已换位/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
});

test('相对 step 失败后只挪 0.25 但跨过格边界，也算身体已换位', () => {
  const { adapter, activity } = activityOf([{ skill: 'move_step', args: { at: [1, 0, 0], facing: 'W' } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: -507.778, y: 102, z: -252.5 } };
  const state = { ...adapter.state(), pos: { x: -508.028, y: 102, z: -252.5 } };
  // 0.25 格 < 0.5，但 floor(-507.778)=-508 与 floor(-508.028)=-509 已换格。
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '没有站到 [1,0,0]', { targetCell: { x: -510, y: 102, z: -253 } }), 100, state);
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /相对 step 失败后身体已换位/);
});

test('place_support 轻推跨过格边界：下一步相对 move_step 先被 stanceGap 拦下', () => {
  const { adapter, activity } = activityOf([
    { skill: 'place_support', args: { at: [1, -1, 0], facing: 'W', item: 'netherrack' } },
    { skill: 'move_step', args: { at: [1, 0, 0], facing: 'W' } },
  ]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: -507.778, y: 102, z: -252.5 } };
  const state = { ...adapter.state(), pos: { x: -508.028, y: 102, z: -252.5 } };
  const verdict = afterStep(activity, step, ok('[1,-1,0] 形成可站立支撑', { placed: 'netherrack' }), 100, state);
  assert.equal(verdict.kind, 'continue');
  assert.equal(activity.stanceGap?.skill, 'place_support');
  assert.equal(relativeCellAction('move_step', { at: [1, 0, 0], facing: 'W' }), true, '后续相对 move_step 必须被缺口闸门识别');
});

test('move_step 头/脚被挡且这段活在挖：先插入回执给的 mine_cell 再重试', () => {
  const { adapter, activity } = activityOf([
    { skill: 'mine_cell', args: { at: [0, 2, 0], facing: 'N' } },
    { skill: 'move_step', args: { at: [1, 0, 0], facing: 'N' } },
  ]);
  nextStep(activity); // 原来的 mine_cell
  const step = nextStep(activity)!; // 要执行的 step
  const failure = fail('PATH_NOT_FOUND', '迈不到 [1,0,0]：目标格上方是 netherrack（会碰头；先 mine_cell [1,2,0]）', {
    movementNotAttempted: true, remediation: { dig: [1, 2, 0], reason: 'head' }, targetCell: { x: 1, y: 64, z: -1 },
  });
  const verdict = afterStep(activity, step, failure, 5, adapter.state());
  assert.equal(verdict.kind, 'continue', JSON.stringify(verdict));
  const inserted = nextStep(activity)!;
  assert.equal(inserted.skill, 'mine_cell');
  assert.deepEqual(inserted.args, { at: [1, 2, 0], facing: 'N' });
  assert.equal((inserted as { origin?: string }).origin, 'execution_helper');
  // 同一回执再失败一次就停，不会无限插步。
  activity.index = 2;
  const again = afterStep(activity, activity.steps[2]!, failure, 5, adapter.state());
  assert.equal(again.kind, 'stuck');
});

test('move_step 被挡但这段活没有挖掘授权：不自动插 mine_cell', () => {
  const { adapter, activity } = activityOf([{ skill: 'move_step', args: { at: [1, 0, 0], facing: 'N' } }]);
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '迈不到 [1,0,0]：目标格上方是 stone', {
    movementNotAttempted: true, remediation: { dig: [1, 2, 0], reason: 'head' },
  }), 5, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.steps.some((s) => s.skill === 'mine_cell'));
});

test('swim_path 游不动的物理停滞不原样重放，即使失败前身体移动过', () => {
  const { adapter, activity } = activityOf([{ skill: 'swim_path', args: { xyz: { x: -482, y: 64, z: -231 }, mode: 'dry_shore' } }]);
  const step = nextStep(activity)!;
  // 起点与当前状态相差很远：仅按“身体动过 >= 0.5 格”旧规则会允许重试。
  activity.stepStart = { pos: { x: -479.5, y: 59.6, z: -230.5 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '游不动；现在在 (-482.1,61.2,-231.0)，氧气 15/20', {
    reason: 'SWIM_NO_PROGRESS', position: { x: -482.1, y: 61.2, z: -231.0 }, goal: 'dry_shore', stage: 'swimming',
  }), 5012, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /重放不会改变结果/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不消耗自动重试额度');
});

test('同一缺口只重试一次：视角或无关资源变化不能再要一次重试额度', () => {
  const { adapter, activity } = activityOf([gather]);
  let step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const gap = { targetCell: { x: 1, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', gap), 100, adapter.state()).kind, 'continue', '身体实际移动后允许第一次重试');
  step = nextStep(activity)!;
  const percept = { self: { around: 'changed' }, vision: { view: 'turned' }, nearby: { resources: [{ name: 'dirt' }] } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', gap), 7, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck', '同一证据版本不得再原样重试');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 1);
});

test('相关证据变化允许复验，但同一技能的自动重试仍有次数上限', () => {
  const { adapter, activity } = activityOf([gather]);
  let step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', { targetCell: { x: 1, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } }), 100, adapter.state()).kind, 'continue');
  step = nextStep(activity)!;
  const changed = { targetCell: { x: 2, y: 64, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', changed), 7, adapter.state()).kind, 'continue', '目标格/支撑证据变了，允许复验');
  step = nextStep(activity)!;
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', changed), 7, adapter.state()).kind, 'stuck', '达到两次上限后停止');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 2);
});

test('place_cell 脚下被挡时不自动 mine_cell：交回事实且零耗材', () => {
  const { adapter, activity } = activityOf([{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  adapter.inv.set('cobblestone', 2);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { ...adapter.state().pos } };
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：脚下这格有 torch，方块放不进去', { pillarFailure: 'BLOCKED:torch' }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.deepEqual(activity.steps.map((item) => item.skill), ['place_cell'], '没有插入挖脚下的步骤');
  assert.equal(adapter.inv.get('cobblestone'), 2, '没有消耗垫脚材料');
  assert.ok(!adapter.actions.some((item) => item.startsWith('dig')), '没有发生未授权挖掘');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:') || item.startsWith('retry:')));
});

test('pillar_one 头顶被挡时不自动挖：交回事实，不插入 mine_cell', () => {
  const { adapter, activity } = activityOf([{ skill: 'pillar_one', args: { item: 'cobblestone' } }]);
  const step = nextStep(activity)!;
  const result = fail('PATH_NOT_FOUND', '原地垫高没成：头顶 (0,65,0) 是 stone', {
    failureCause: 'PILLAR_CLEARANCE', pillarClearance: { cells: [{ at: [0, 2, 0], facing: 'N' }] },
  });
  const verdict = afterStep(activity, step, result, 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.steps.some((item) => item.skill === 'mine_cell'), '不替 Agent 决定先挖头顶');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:')));
});

test('自动重试沿用原动作期限；新的 Agent 委托重新起算', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { adapter, activity } = activityOf([{ skill: 'mine_cell', args: { dir: 'down', blocks: 1 } }]);
  const firstStep = nextStep(activity)!;
  const template = activity.steps[0];
  const first = beginStep(activity, template, adapter.state());
  assert.equal(first.continuation, false);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  now += 25_000;
  const gap = { targetCell: { x: 0, y: 63, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, firstStep, fail('PATH_NOT_FOUND', '路被挡住', gap), 100, adapter.state()).kind, 'continue');

  const secondStep = nextStep(activity)!;
  const carried = beginStep(activity, activity.steps[0], adapter.state());
  assert.equal(carried.continuation, true);
  assert.equal(carried.deadlineMs, first.deadlineMs, '重试没有换一个新的绝对期限');
  assert.ok(carried.remainingMs <= 5000);

  now += 6_000;
  const verdict = afterStep(activity, secondStep, fail('PATH_NOT_FOUND', '路被挡住', { ...gap, targetCell: { x: 1, y: 63, z: 0 } }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /期限/);

  // 新的显式 Agent 委托（新的一段活）重新获得完整预算。
  const other = activityOf([{ skill: 'mine_cell', args: { dir: 'down', blocks: 1 } }]);
  const fresh = beginStep(other.activity, other.activity.steps[0], other.adapter.state());
  assert.equal(fresh.continuation, false);
  assert.ok(fresh.deadlineMs > first.deadlineMs);
});

test('place_cell 暂时性服务器拒绝在期限/材料额度内有限重试，确定性拒绝立即停止', () => {
  const { adapter, activity } = activityOf([{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  adapter.inv.set('cobblestone', 4);
  const server = () => fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：服务器拒绝', { pillarFailure: 'NOT_PLACED:Server rejected the place' });

  let step = nextStep(activity)!;
  beginStep(activity, activity.steps[0], adapter.state());
  assert.equal(afterStep(activity, step, server(), 50, adapter.state()).kind, 'continue', '暂时拒绝允许一次复验');
  step = nextStep(activity)!;
  beginStep(activity, activity.steps[0], adapter.state());
  assert.equal(afterStep(activity, step, server(), 50, adapter.state()).kind, 'continue', '第二次仍在有界范围内');
  step = nextStep(activity)!;
  beginStep(activity, activity.steps[0], adapter.state());
  assert.equal(afterStep(activity, step, server(), 50, adapter.state()).kind, 'stuck', '两次之后停止');
  assert.equal(activity.adaptations.filter((item) => item.startsWith('pillar-retry:')).length, 2);

  const deterministic = activityOf([{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  const detStep = nextStep(deterministic.activity)!;
  beginStep(deterministic.activity, deterministic.activity.steps[0], deterministic.adapter.state());
  const det = afterStep(deterministic.activity, detStep, fail('PATH_NOT_FOUND', '原地垫高没成：脚下没有支撑', { pillarFailure: 'NO_REFERENCE' }), 50, deterministic.adapter.state());
  assert.equal(det.kind, 'stuck', '确定性拒绝立即停止');
  assert.ok(!deterministic.activity.adaptations.some((item) => item.startsWith('pillar-retry:')), '确定性拒绝不领取重试额度');
});

test('自动重试不能超出原委托的材料额度', () => {
  // place_cell：一次放置最多花 1 个指定方块；已经用掉一个但效果未确认时不再自动重放。
  const place = activityOf([{ skill: 'place_cell', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  place.adapter.inv.set('cobblestone', 3);
  const placeStep = nextStep(place.activity)!;
  beginStep(place.activity, place.activity.steps[0], place.adapter.state());
  place.adapter.inv.set('cobblestone', 2);
  const placeVerdict = afterStep(place.activity, placeStep, fail('EFFECT_NOT_CONFIRMED', '没确认', { pillarFailure: 'NOT_PLACED:Server rejected' }), 50, place.adapter.state());
  assert.equal(placeVerdict.kind, 'stuck');
  assert.match(placeVerdict.why, /材料额度/);

  // pillar_one：一次原地垫高最多消耗 1 个方块；已用掉一个时不再自动重放。
  const pillar = activityOf([{ skill: 'pillar_one', args: { item: 'dirt' } }]);
  pillar.adapter.inv.set('dirt', 3);
  const pillarStep = nextStep(pillar.activity)!;
  beginStep(pillar.activity, pillar.activity.steps[0], pillar.adapter.state());
  pillar.adapter.inv.set('dirt', 2);
  const pillarVerdict = afterStep(pillar.activity, pillarStep, fail('EFFECT_NOT_CONFIRMED', '没确认', { pillarFailure: 'NOT_PLACED:Server rejected' }), 50, pillar.adapter.state());
  assert.equal(pillarVerdict.kind, 'stuck');
  assert.match(pillarVerdict.why, /材料额度/);
});

test('导航阶段按技能实际报告记录，没有报告的不编造', () => {
  const walk = activityOf([{ skill: 'walk_path', args: { routeId: 'rt_test' } }]);
  const walkStep = nextStep(walk.activity)!;
  afterStep(walk.activity, walkStep, fail('PATH_NOT_FOUND', '被挡住', { nav: { outcome: 'BLOCKED', message: 'x', trace: [] }, position: { x: 0.5, y: 64, z: 0.5 } }), 100, walk.adapter.state());
  assert.equal((walk.activity.results.at(-1) as { stage?: string }).stage, 'BLOCKED');
  const described = describeActivity(walk.activity, walk.adapter.state());
  assert.equal(described.last_nav_stage, 'BLOCKED');
  assert.ok(described.recent[0].includes('阶段 BLOCKED'));

  const plain = activityOf([{ skill: 'mine_cell', args: { dir: 'up', blocks: 1 } }]);
  const plainStep = nextStep(plain.activity)!;
  afterStep(plain.activity, plainStep, fail('PATH_NOT_FOUND', '没成', { position: { x: 0, y: 64, z: 0 } }), 100, plain.adapter.state());
  assert.equal((plain.activity.results.at(-1) as { stage?: string }).stage, undefined);
  assert.equal(describeActivity(plain.activity, plain.adapter.state()).last_nav_stage, undefined);
});

test('嵌套 use_skill 带回 connectionGap 时也按数据字段停止重试', () => {
  const { adapter, activity } = activityOf([{ skill: 'use_skill', args: { name: 'mine-back-macro' } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '技能「mine-back-macro」第 2 步 follow_passage 没成：通道断开', {
    position: { x: -2, y: 84, z: -52 }, connectionGap: { from: { x: -2, y: 84, z: -52 }, to: { x: -2, y: 84, z: -51 }, distance: 1 },
  }), 445, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /确定断口/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '嵌套 follow_passage 也不原样重试');
});

test('clipFeedback 在极小上限下也不超过上限', () => {
  for (const max of [0, 1, 3, 4, 5, 6]) {
    const out = clipFeedback('abcdefghijklmnopqrstuvwxyz', max);
    assert.ok(out.length <= max, `max=${max} 得到 ${out.length} 字：${out}`);
  }
});

test('长失败反馈保留可执行尾部，短反馈保持原文', () => {
  const tail = '→ mine_cell {"at":[-1,2,0],"facing":"N"}';
  const long = `${'前、上、右三格净空检查：脚下有支撑，前方两格是空气，'.repeat(14)}${tail}`;
  assert.ok(long.length > 320);
  const { adapter, activity } = activityOf([{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('ERROR', long, { completedSteps: 0, excavatedBlocks: 0 }), 50, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(verdict.why.includes('…'), '中间省略');
  assert.ok(verdict.why.endsWith(tail), '尾部的可执行事实没有被切掉');
  assert.ok(verdict.why.length <= 320, '截断后仍有长度上限');

  const short = activityOf([{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 3 } }]);
  const shortStep = nextStep(short.activity)!;
  const shortVerdict = afterStep(short.activity, shortStep, fail('ERROR', '短消息', { completedSteps: 0, excavatedBlocks: 0 }), 50, short.adapter.state());
  assert.equal(shortVerdict.kind, 'stuck');
  assert.equal(shortVerdict.why, '短消息');
});

test('current_activity 的最近结果也保留可执行尾巴', () => {
  const tail = '→ mine_cell {"at":[-1,2,0],"facing":"N"}';
  const long = `${'前、上、右三格净空检查：脚下有支撑，前方两格是空气，'.repeat(14)}${tail}`;
  const { adapter, activity } = activityOf([{ skill: 'excavate_run', args: { mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  afterStep(activity, step, fail('ERROR', long, { completedSteps: 0, excavatedBlocks: 0 }), 50, adapter.state());
  const recent = describeActivity(activity, adapter.state()).recent[0];
  assert.ok(recent.endsWith(tail), `最近结果应保留尾部动作：${recent}`);
});

test('surface 头顶被封不原样重放，把阻挡事实交回心智', () => {
  const { adapter, activity } = activityOf([{ skill: 'swim_path', args: { mode: 'surface' } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 1, y: 64, z: 1 } };
  const verdict = afterStep(activity, step, fail('STUCK', '上浮没动；头顶 (1,65,1) 是 grass_block', {
    reason: 'SWIM_NO_PROGRESS', blockedAbove: { x: 1, y: 65, z: 1, name: 'grass_block' },
  }), 1200, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /swim_path 上浮只按跳不能挖/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不消耗自动重试额度');
});

test('已在门方块里等到超时：不原样重放同一个 travel_portal，把时间线交回心智', () => {
  const { adapter, activity } = activityOf([{ skill: 'travel_portal', args: { portalId: 'portal_test' } }]);
  // 起点与当前状态相差很远：仅按“身体动过 >= 0.5 格”的旧规则会允许一次自动重试。
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('ERROR', '传送未验收（PORTAL_TRANSITION_TIMEOUT）：开始时身体已在门方块里；在门方块里连续 30.0s；维度 the_nether', {
    portalReason: 'PORTAL_TRANSITION_TIMEOUT',
    transition: { startedInPortal: true, entered: true, exitMs: 260, outsideMs: 320, insideMs: 30000, endDim: 'the_nether' },
  }), 30816, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /自动续跑不再原样重放/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '不消耗自动重试额度');
});

test('其它技能数据里的 transition 不会被当成穿门失败', () => {
  const { adapter, activity } = activityOf([gather]);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', {
    transition: { startedInPortal: true, entered: true, exitMs: null, outsideMs: null, insideMs: 30000, endDim: 'overworld' },
  }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '没有 portalReason 的 transition 不触发穿门规则');
});
