import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, beginStep, clipFeedback, createActivity, describeActivity, nextStep } from '../src/mind/activity.ts';
import type { Condition } from '../src/projects/types.ts';
import { climbUp } from '../src/skills/body.ts';
import { fail, ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const gather = { skill: 'gather', args: { block: 'stone', count: 3 } };

function activityOf(steps: { skill: string; args?: unknown }[], repeat = 1, doneWhen?: Condition) {
  const adapter = new FakeAdapter();
  return { adapter, activity: createActivity({ what: '测试', why: '', kind: 'other', steps, repeat, ...(doneWhen ? { doneWhen } : {}) }, '', 'llm', adapter.state()) };
}

test('52ms→7ms：有界开挖的确定性预检失败，不因身体或视角变化再原样重试', () => {
  const { adapter, activity } = activityOf([{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 }, view: '{"around":"old"}' };
  // 身体实际位移 + 转头 + 附近出现新资源，都不是“下一落点支撑已改变”的证据。
  const percept = { self: { around: 'new' }, vision: { view: 'turned' }, nearby: { resources: [{ name: 'oak_log' }] } };
  const verdict = afterStep(activity, step, fail('ERROR', '有界开挖停止：下一落点下面是空的（air）：前面脚下是个坑/洞穴', { completedSteps: 0, excavatedBlocks: 0 }), 7, adapter.state(), percept as never);
  assert.equal(verdict.kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')), '不做第二次相同缺口调用');
});

test('surface 只浮起、未触地时，inWater=false 的收工条件不能算完成', () => {
  const { adapter, activity } = activityOf([{ skill: 'surface' }], 1, { type: 'self_state', field: 'inWater', equals: false });
  adapter.inWater = false;
  adapter.onGround = false;
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, ok('结束时头已露出流体，还没上岸', { surfaced: true, landed: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'done');
  assert.equal((verdict as { met: boolean }).met, false, '水面浮动的瞬时 inWater=false 不能把活动标成完成');
  assert.match((verdict as { why: string }).why, /没有触地|未确认/);
});

test('相对 step 失败且身体已换位：不自动重试，避免用新站位重算 [1,-1,0]', () => {
  const { adapter, activity } = activityOf([{ skill: 'step', args: { at: [1, -1, 0], facing: 'S' } }]);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '没有站到 [1,-1,0]：身体没有站稳', { targetCell: { x: 1, y: 63, z: 0 }, position: { x: 0, y: 64, z: 0 } }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /相对 step 失败后身体已换位/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0);
});

test('swim_to 游不动的物理停滞不原样重放，即使失败前身体移动过', () => {
  const { adapter, activity } = activityOf([{ skill: 'swim_to', args: { xyz: { x: -482, y: 64, z: -231 } } }]);
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

test('place_at 脚下被挡时不自动 dig_at：交回事实且零耗材', () => {
  const { adapter, activity } = activityOf([{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  adapter.inv.set('cobblestone', 2);
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { ...adapter.state().pos } };
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '原地垫高没成：脚下这格有 torch，方块放不进去', { pillarFailure: 'BLOCKED:torch' }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.deepEqual(activity.steps.map((item) => item.skill), ['place_at'], '没有插入挖脚下的步骤');
  assert.equal(adapter.inv.get('cobblestone'), 2, '没有消耗垫脚材料');
  assert.ok(!adapter.actions.some((item) => item.startsWith('dig')), '没有发生未授权挖掘');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('clearance:') || item.startsWith('retry:')));
});

test('climb_up 清障插步保留来源/授权链并说明消耗；同一障碍证据只清一次', () => {
  const { adapter, activity } = activityOf([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  const step = nextStep(activity)!;
  const result = fail('STUCK', '往上爬了 1 格后停下：头顶被挡', {
    climbed: 1, spent: 1, goalReached: false, failureCause: 'PILLAR_CLEARANCE', pillarClearance: { cells: [{ at: [0, 2, 0], facing: 'N' }] },
  });
  const verdict = afterStep(activity, step, result, 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.match((verdict as { adapted?: string }).adapted ?? '', /工具耐久/, '说明这次清障的消耗');
  const inserted = activity.steps[0];
  assert.equal(inserted.skill, 'dig_at');
  assert.equal(inserted.origin, 'execution_helper');
  assert.equal(inserted.authorizedBy?.skill, 'climb_up');
  assert.equal(inserted.authorizedBy?.stepId, step.id, '授权链指回原逻辑步骤');
  assert.equal(afterStep(activity, step, result, 100, adapter.state()).kind, 'stuck', '同一障碍证据不再插一次');
  assert.equal(activity.steps.filter((item) => item.skill === 'dig_at').length, 1);
});

test('清障只在障碍证据变化时再次插入，且最多两次', () => {
  const { adapter, activity } = activityOf([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  const step = nextStep(activity)!;
  const obstacle = (x: number) => fail('STUCK', '往上爬了 1 格后停下：头顶被挡', {
    climbed: 1, spent: 1, goalReached: false, failureCause: 'PILLAR_CLEARANCE', pillarClearance: { cells: [{ at: [x, 2, 0], facing: 'N' }] },
  });
  assert.equal(afterStep(activity, step, obstacle(0), 100, adapter.state()).kind, 'continue');
  nextStep(activity); // 执行第一次插入的清障
  assert.equal(afterStep(activity, step, obstacle(1), 100, adapter.state()).kind, 'continue', '障碍格变了，允许复验');
  nextStep(activity);
  assert.equal(afterStep(activity, step, obstacle(-1), 100, adapter.state()).kind, 'stuck', '两次之后即使证据再变也停止');
  assert.equal(activity.steps.filter((item) => item.skill === 'dig_at').length, 2);
});

test('18+18：climb 重试沿用剩余高度账本，不重新获得完整额度', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 73, z: 0.5 }; // 已确认爬了 9 格
  adapter.inv.set('dirt', 32);
  const activity = createActivity({ what: '爬 18 格', why: '', kind: 'other', repeat: 1, steps: [{ skill: 'climb_up', args: { height: 18, untilSky: false } }] }, '', 'llm', adapter.state());
  const step = nextStep(activity)!;
  const key = step.id!;
  activity.climb![key].spent = 9;
  activity.climb![key].startY = 64; // 第一次实际爬升时记录的逻辑起点
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const verdict = afterStep(activity, step, fail('STUCK', '往上爬了 9 格后停下', { climbed: 9, spent: 9, goalReached: false }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue');
  assert.equal(activity.climb![key].spent, 9, '已完成高度跨重试保留');
  assert.equal((activity.steps[0].args as { height: number }).height, 18, '模板目标不变');
  let moves = 0;
  adapter.moveTo = async () => { moves++; adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 }; };
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10000, senses: { refresh() {} }, make: false, climb: activity.climb![key] };
  const result = await climbUp.run(ctx as never, { height: 18, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves, 9, '只补剩余 9 格，不是再从 0 爬 18 格');
  assert.equal(activity.climb![key].spent, 18);
});

test('自动重试沿用原动作期限；新的 Agent 委托重新起算', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { adapter, activity } = activityOf([{ skill: 'dig', args: { dir: 'down', blocks: 1 } }]);
  const firstStep = nextStep(activity)!;
  const template = activity.steps[0];
  const first = beginStep(activity, template, adapter.state());
  assert.equal(first.continuation, false);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  now += 58_000;
  const gap = { targetCell: { x: 0, y: 63, z: 0 }, position: { x: 0, y: 64, z: 0 } };
  assert.equal(afterStep(activity, firstStep, fail('PATH_NOT_FOUND', '路被挡住', gap), 100, adapter.state()).kind, 'continue');

  const secondStep = nextStep(activity)!;
  const carried = beginStep(activity, activity.steps[0], adapter.state());
  assert.equal(carried.continuation, true);
  assert.equal(carried.deadlineMs, first.deadlineMs, '重试没有换一个新的绝对期限');
  assert.ok(carried.remainingMs <= 2000);

  now += 3_000;
  const verdict = afterStep(activity, secondStep, fail('PATH_NOT_FOUND', '路被挡住', { ...gap, targetCell: { x: 1, y: 63, z: 0 } }), 100, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /期限/);

  // 新的显式 Agent 委托（新的一段活）重新获得完整预算。
  const other = activityOf([{ skill: 'dig', args: { dir: 'down', blocks: 1 } }]);
  const fresh = beginStep(other.activity, other.activity.steps[0], other.adapter.state());
  assert.equal(fresh.continuation, false);
  assert.ok(fresh.deadlineMs > first.deadlineMs);
});

test('place_at 暂时性服务器拒绝在期限/材料额度内有限重试，确定性拒绝立即停止', () => {
  const { adapter, activity } = activityOf([{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
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

  const deterministic = activityOf([{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  const detStep = nextStep(deterministic.activity)!;
  beginStep(deterministic.activity, deterministic.activity.steps[0], deterministic.adapter.state());
  const det = afterStep(deterministic.activity, detStep, fail('PATH_NOT_FOUND', '原地垫高没成：脚下没有支撑', { pillarFailure: 'NO_REFERENCE' }), 50, deterministic.adapter.state());
  assert.equal(det.kind, 'stuck', '确定性拒绝立即停止');
  assert.ok(!deterministic.activity.adaptations.some((item) => item.startsWith('pillar-retry:')), '确定性拒绝不领取重试额度');
});

test('自动重试不能超出原委托的材料额度', () => {
  // place_at：一次放置最多花 1 个指定方块；已经用掉一个但效果未确认时不再自动重放。
  const place = activityOf([{ skill: 'place_at', args: { at: [0, 0, 0], item: 'cobblestone' } }]);
  place.adapter.inv.set('cobblestone', 3);
  const placeStep = nextStep(place.activity)!;
  beginStep(place.activity, place.activity.steps[0], place.adapter.state());
  place.adapter.inv.set('cobblestone', 2);
  const placeVerdict = afterStep(place.activity, placeStep, fail('EFFECT_NOT_CONFIRMED', '没确认', { pillarFailure: 'NOT_PLACED:Server rejected' }), 50, place.adapter.state());
  assert.equal(placeVerdict.kind, 'stuck');
  assert.match(placeVerdict.why, /材料额度/);

  // climb_up：height 就是最多消耗的垫脚方块数；已花光时不再重试。
  const climb = activityOf([{ skill: 'climb_up', args: { height: 3, untilSky: false } }]);
  climb.adapter.inv.set('dirt', 10);
  const climbStep = nextStep(climb.activity)!;
  beginStep(climb.activity, climb.activity.steps[0], climb.adapter.state());
  climb.activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  climb.activity.climb![climbStep.id!].spent = 1;
  climb.adapter.inv.set('dirt', 7);
  const climbVerdict = afterStep(climb.activity, climbStep, fail('STUCK', '往上爬了 1 格后停下', { climbed: 1, spent: 1, goalReached: false }), 50, climb.adapter.state());
  assert.equal(climbVerdict.kind, 'stuck');
  assert.match(climbVerdict.why, /材料额度/);
  assert.equal(climb.activity.climb![climbStep.id!].spent, 1, '已确认的高度进展仍保留');
});

test('导航阶段按技能实际报告记录，没有报告的不编造', () => {
  const walk = activityOf([{ skill: 'walk_to', args: { to: [1, 64, 1], arrival: { kind: 'exact' } } }]);
  const walkStep = nextStep(walk.activity)!;
  afterStep(walk.activity, walkStep, fail('PATH_NOT_FOUND', '被挡住', { nav: { outcome: 'BLOCKED', message: 'x', trace: [] }, position: { x: 0.5, y: 64, z: 0.5 } }), 100, walk.adapter.state());
  assert.equal((walk.activity.results.at(-1) as { stage?: string }).stage, 'BLOCKED');
  const described = describeActivity(walk.activity, walk.adapter.state());
  assert.equal(described.last_nav_stage, 'BLOCKED');
  assert.ok(described.recent[0].includes('阶段 BLOCKED'));

  const plain = activityOf([{ skill: 'dig', args: { dir: 'up', blocks: 1 } }]);
  const plainStep = nextStep(plain.activity)!;
  afterStep(plain.activity, plainStep, fail('PATH_NOT_FOUND', '没成', { position: { x: 0, y: 64, z: 0 } }), 100, plain.adapter.state());
  assert.equal((plain.activity.results.at(-1) as { stage?: string }).stage, undefined);
  assert.equal(describeActivity(plain.activity, plain.adapter.state()).last_nav_stage, undefined);
});

test('follow_passage 报出确定图断口时不原样重试，并保留断口两端', () => {
  const { adapter, activity } = activityOf([{ skill: 'follow_passage', args: { to: 'entrance' } }]);
  const step = nextStep(activity)!;
  // 身体确实移动过（否则通用分支本来就不会重试）；这里验证的是 connectionGap 例外先于 RETRYABLE。
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const from = { x: -2, y: 84, z: -52 }, to = { x: -2, y: 84, z: -51 };
  const verdict = afterStep(activity, step, fail('PATH_NOT_FOUND', '通道在 (-2,84,-52) 和 (-2,84,-51) 之间断开，相距 1 格', {
    position: { x: -2, y: 84, z: -52 }, connectionGap: { from, to, distance: 1, sameLevel: true, horizontal: 1, vertical: 0, note: '旧几何缺口' },
  }), 445, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.match(verdict.why, /\(-2,84,-52\)/);
  assert.match(verdict.why, /\(-2,84,-51\)/);
  assert.match(verdict.why, /确定断口/);
  assert.equal(activity.adaptations.filter((item) => item.startsWith('retry:')).length, 0, '确定断口不领取重试额度');
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
  const tail = '→ dig_at {"at":[-1,2,0],"facing":"N"}';
  const long = `${'前、上、右三格净空检查：脚下有支撑，前方两格是空气，'.repeat(14)}${tail}`;
  assert.ok(long.length > 320);
  const { adapter, activity } = activityOf([{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('ERROR', long, { completedSteps: 0, excavatedBlocks: 0 }), 50, adapter.state());
  assert.equal(verdict.kind, 'stuck');
  assert.ok(verdict.why.includes('…'), '中间省略');
  assert.ok(verdict.why.endsWith(tail), '尾部的可执行事实没有被切掉');
  assert.ok(verdict.why.length <= 320, '截断后仍有长度上限');

  const short = activityOf([{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }]);
  const shortStep = nextStep(short.activity)!;
  const shortVerdict = afterStep(short.activity, shortStep, fail('ERROR', '短消息', { completedSteps: 0, excavatedBlocks: 0 }), 50, short.adapter.state());
  assert.equal(shortVerdict.kind, 'stuck');
  assert.equal(shortVerdict.why, '短消息');
});

test('current_activity 的最近结果也保留可执行尾巴', () => {
  const tail = '→ dig_at {"at":[-1,2,0],"facing":"N"}';
  const long = `${'前、上、右三格净空检查：脚下有支撑，前方两格是空气，'.repeat(14)}${tail}`;
  const { adapter, activity } = activityOf([{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 3 } }]);
  const step = nextStep(activity)!;
  afterStep(activity, step, fail('ERROR', long, { completedSteps: 0, excavatedBlocks: 0 }), 50, adapter.state());
  const recent = describeActivity(activity, adapter.state()).recent[0];
  assert.ok(recent.endsWith(tail), `最近结果应保留尾部动作：${recent}`);
});

test('climb_up 采纳自动续跑的绝对期限：到期后不再执行', async () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('dirt', 8);
  let moves = 0;
  adapter.moveTo = async () => { moves++; adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 }; };
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 60_000, senses: { refresh() {} }, make: false };
  const result = await climbUp.run(ctx as never, { height: 3, untilSky: false, deadlineMs: Date.now() - 1 });
  assert.equal(result.status, 'failed');
  assert.equal(moves, 0, '原动作期限已过，不再垫/爬');
  const validated = climbUp.validate({ height: 2, untilSky: false, deadlineMs: Date.now() + 1000 }, adapter);
  assert.ok(validated.ok);
});
