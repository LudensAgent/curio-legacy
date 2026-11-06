import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskInfo, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, runSkill, type Skill } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

type TaskEnd = Record<string, any>;

const setup = () => {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  const ends = new Map<string, TaskEnd>();
  bus.on('event', (ev) => {
    if (ev.type === 'task_end' && ev.data?.taskId) ends.set(String(ev.data.taskId), ev.data);
  });
  const next = () => new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  const close = () => memory.close();
  return { adapter, bus, memory, arbiter, ends, next, close };
};

function startTask(arbiter: Arbiter, step: { skill: string; args?: unknown }, source: 'llm' | 'filler' | 'reflex', meta?: Parameters<Arbiter['start']>[2]): TaskInfo {
  const started = arbiter.start(step, source, meta);
  if ('error' in started) throw new Error(started.error);
  return started;
}

const stub = (name: string, run: Skill['run'], timeoutMs = 5000): Skill => ({
  name, description: '', argsDoc: '{}', timeoutMs, movement: false,
  validate: (raw) => ({ ok: true, args: { ...((raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>), normalized: true } }),
  run,
});

test('task_end 的 origin 区分 Agent 选择与独立调度', async (t) => {
  const w = setup();
  t.after(w.close);
  SKILLS.test_origin = stub('test_origin', async () => ok('完成'));
  t.after(() => { delete SKILLS.test_origin; });
  const run = async (source: 'llm' | 'reflex' | 'filler') => {
    const started = startTask(w.arbiter, { skill: 'test_origin' }, source);
    await w.next();
    return w.ends.get(started.id)!;
  };
  assert.equal((await run('llm')).origin, 'agent');
  assert.equal((await run('reflex')).origin, 'scheduler');
  assert.equal((await run('filler')).origin, 'scheduler');
});

test('task_end 记录委托身份、作用域、目标、实测位置、背包消费和结果数据', async (t) => {
  const w = setup();
  t.after(w.close);
  w.adapter.inv.set('dirt', 1);
  SKILLS.test_envelope = stub('test_envelope', async (ctx) => {
    // 真实效果：移动、拿到东西；结果明确区分解析目标与实测位置。
    w.adapter.pos = { x: 2.5, y: 64, z: 1.5 };
    w.adapter.inv.set('dirt', 3);
    return ok('完成', { target: { x: 3, y: 64, z: 2 }, position: { x: 2.5, y: 64, z: 1.5 }, marker: 7 });
  });
  t.after(() => { delete SKILLS.test_envelope; });

  const started = startTask(w.arbiter, { skill: 'test_envelope', args: { target: '3,64,2', make: true } }, 'llm',
    { planId: 'act_parent', stepId: 'st_1', origin: 'agent' });
  const outcome = await w.next();
  const end = w.ends.get(started.id)!;
  assert.ok(end, '必须有 task_end');

  assert.equal(end.planId, 'act_parent');
  assert.equal(end.planVersion, started.planVersion);
  assert.equal(end.stepId, 'st_1');
  assert.equal(end.source, 'llm');
  assert.equal(end.origin, 'agent');
  assert.equal(end.parentTaskId, null, '当前没有任务派发任务的父链，明确 null');
  assert.equal(end.skill, 'test_envelope');
  assert.deepEqual(end.args, { target: '3,64,2', make: true }, 'args 是派发前的原始参数');
  assert.deepEqual(end.normalizedArgs, { target: '3,64,2', make: true, normalized: true }, '规范化参数单独保留');
  assert.equal(end.budget.make, true);
  assert.equal(end.budget.climb, null);

  assert.deepEqual(end.scope.start.worldId, 'fake-world');
  assert.deepEqual(end.scope.start.dim, 'overworld');
  assert.deepEqual(end.scope.start.sessionId, 'fake-session');
  assert.deepEqual(end.scope.end.worldId, 'fake-world');
  assert.deepEqual(end.scope.end.sessionId, 'fake-session');
  assert.equal(end.lateCompletion, false);

  assert.deepEqual(end.resolvedTarget, { x: 3, y: 64, z: 2 }, '解析目标来自显式 target');
  assert.equal(end.resolvedTargetFrom, 'data.target');
  assert.deepEqual(end.lastPosition, { x: 2.5, y: 64, z: 1.5 });
  assert.equal(end.lastPositionFrom, 'adapter.state');
  assert.deepEqual(end.inventoryDiff, { gained: { dirt: 2 }, lost: {} });
  assert.equal(end.data.marker, 7, '结果 data 原样保留');
  assert.equal(outcome.result.status, 'succeeded');
});

test('取消与 STUCK 不改写已确认的 result.data', async (t) => {
  const w = setup();
  t.after(w.close);
  SKILLS.test_cancelled_data = stub('test_cancelled_data', async () => {
    await sleep(40); // 忽略取消信号，模拟写得不好的技能
    w.adapter.pos = { x: 1, y: 64, z: 0 };
    return { status: 'cancelled', summary: '取消前已经放下一块', data: { placed: [{ x: 1, y: 64, z: 0 }], position: { x: 1, y: 64, z: 0 } } };
  });
  t.after(() => { delete SKILLS.test_cancelled_data; });

  const started = startTask(w.arbiter, { skill: 'test_cancelled_data' }, 'llm');
  const done = w.next();
  await sleep(10);
  w.arbiter.cancel('卡死：20 秒没挪动', 'STUCK');
  const outcome = await done;
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'STUCK');
  assert.deepEqual(outcome.result.data?.placed, [{ x: 1, y: 64, z: 0 }], '取消路径不能丢掉已确认效果');

  const end = w.ends.get(started.id)!;
  assert.equal(end.failureCode, 'STUCK');
  assert.deepEqual(end.data.placed, [{ x: 1, y: 64, z: 0 }], 'task_end 同样保留部分效果');
  assert.deepEqual(end.lastPosition, { x: 1, y: 64, z: 0 }, '没有新任务时用结束实测位置');
});

test('超时保留技能返回的部分 data', async (t) => {
  const w = setup();
  t.after(w.close);
  // timeoutMs + 2000 = 500ms 后触发 TIMEOUT；技能不理会信号，返回带部分事实的 cancelled。
  SKILLS.test_timeout_data = stub('test_timeout_data', async () => {
    await sleep(600);
    w.adapter.pos = { x: 4, y: 64, z: 0 };
    return { status: 'cancelled', summary: '超时前已经移动', data: { partial: true, position: { x: 4, y: 64, z: 0 } } };
  }, -1500);
  t.after(() => { delete SKILLS.test_timeout_data; });

  const started = startTask(w.arbiter, { skill: 'test_timeout_data' }, 'llm');
  const outcome = await w.next();
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'TIMEOUT');
  assert.equal(outcome.result.data?.partial, true);
  const end = w.ends.get(started.id)!;
  assert.equal(end.failureCode, 'TIMEOUT');
  assert.equal(end.data.partial, true, '超时转换保留原始 data');
  assert.deepEqual(end.lastPosition, { x: 4, y: 64, z: 0 });
  assert.equal(end.lastPositionFrom, 'adapter.state');
});

test('迟到回调不把新任务的背包/位置/作用域记到旧任务头上', async (t) => {
  const w = setup();
  t.after(w.close);
  SKILLS.test_late_old = stub('test_late_old', async () => {
    await sleep(120); // 旧任务被取消后仍会晚些落定
    return ok('旧任务晚到', { target: { x: 1, y: 64, z: 0 }, position: { x: 1, y: 64, z: 0 } });
  });
  SKILLS.test_late_new = stub('test_late_new', async () => {
    await sleep(250);
    w.adapter.pos = { x: 9.5, y: 70, z: 9.5 };
    w.adapter.inv.set('diamond', 5);
    w.adapter.dim = 'the_nether';
    return ok('新任务', { target: { x: 9, y: 70, z: 9 }, position: { x: 9.5, y: 70, z: 9.5 } });
  }, 5000);
  t.after(() => { delete SKILLS.test_late_old; delete SKILLS.test_late_new; });

  const oldStarted = startTask(w.arbiter, { skill: 'test_late_old', args: { which: 'old' } }, 'llm', { planId: 'old_plan' });
  const oldDone = w.next();
  await sleep(10);
  w.arbiter.cancel('换计划');

  const newStarted = startTask(w.arbiter, { skill: 'test_late_new', args: { which: 'new' } }, 'llm', { planId: 'new_plan' });
  assert.notEqual(newStarted.id, oldStarted.id);

  await oldDone;
  const oldEnd = w.ends.get(oldStarted.id)!;
  assert.equal(oldEnd.lateCompletion, true, '旧任务在新 planVersion 之后才落定');
  assert.equal(oldEnd.scope.end, null, '不能把新任务的作用域当成旧任务的结束作用域');
  assert.equal(oldEnd.inventoryDiff, null, '不能借新任务的背包算旧任务的消费');
  assert.deepEqual(oldEnd.lastPosition, { x: 1, y: 64, z: 0 }, '退回旧结果里明确记录的实测位置');
  assert.equal(oldEnd.lastPositionFrom, 'data.position');
  assert.deepEqual(oldEnd.resolvedTarget, { x: 1, y: 64, z: 0 });
  assert.equal(oldEnd.planId, 'old_plan');
  assert.equal(oldEnd.status, 'cancelled');

  await w.next();
  const newEnd = w.ends.get(newStarted.id)!;
  assert.equal(newEnd.lateCompletion, false);
  assert.deepEqual(newEnd.scope.end.dim, 'the_nether', '新任务自己记录新作用域');
  assert.deepEqual(newEnd.inventoryDiff.gained, { diamond: 5 });
  assert.deepEqual(newEnd.lastPosition, { x: 9.5, y: 70, z: 9.5 });
});

test('代码技能 api.useSkill 保留嵌套 data 外壳', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const inner = { name: 'inner-envelope', description: '', steps: [{ skill: 'test_inner_data', args: {} }] };
  const outer = {
    name: 'outer-code-envelope', description: '', steps: [],
    code: 'const r = await api.useSkill("inner-envelope"); return { innerOk: r.ok, code: r.code, hasData: Object.prototype.hasOwnProperty.call(r, "data"), marker: r.data && r.data.marker };',
  };
  setBehaviorRegistry({ get: (name: string) => name === inner.name ? inner : name === outer.name ? outer : undefined, list: () => [inner, outer] });
  setReliableSkills(() => null);
  SKILLS.test_inner_data = stub('test_inner_data', async () => fail('ERROR', '内层没成但已确认', { marker: 7 }));
  t.after(() => { delete SKILLS.test_inner_data; setBehaviorRegistry(null); setReliableSkills(null); });

  const result = await runSkill(ctx, useSkill, { name: outer.name });
  assert.equal(result.status, 'succeeded', result.summary);
  const parsed = result.data?.result as { innerOk: boolean; code: string | null; hasData: boolean; marker: number };
  assert.equal(parsed.innerOk, false);
  assert.equal(parsed.code, 'ERROR');
  assert.equal(parsed.hasData, true, 'api.useSkill 必须保留 data 字段');
  assert.equal(parsed.marker, 7, '嵌套失败的结构化事实不能被压成 ok/code/summary');
});

test('use_skill 嵌套步骤不能延长父委托 deadline', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  let nestedDeadline = 0;
  SKILLS.test_capture_deadline = stub('test_capture_deadline', async (inner) => {
    nestedDeadline = inner.deadline;
    return ok('看到了期限');
  }, 120_000);
  const behavior = { name: 'deadline-behavior', description: '', steps: [{ skill: 'test_capture_deadline', args: {} }] };
  setBehaviorRegistry({ get: (name: string) => name === behavior.name ? behavior : undefined, list: () => [behavior] });
  t.after(() => { delete SKILLS.test_capture_deadline; setBehaviorRegistry(null); });

  const parentDeadline = Date.now() + 1000;
  const result = await runSkill({ ...ctx, deadline: parentDeadline }, useSkill, { name: behavior.name });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(nestedDeadline > 0);
  assert.ok(nestedDeadline <= parentDeadline, '嵌套步骤只能缩短、不能延长父 deadline');

});

test('直接工具、宏和代码技能产生同一套 task_end 字段', async (t) => {
  const w = setup();
  t.after(w.close);
  w.adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  SKILLS.test_envelope_shared = stub('test_envelope_shared', async () => {
    w.adapter.pos = { x: 1.5, y: 64, z: 0.5 };
    return ok('完成', { target: { x: 2, y: 64, z: 0 }, position: { x: 1.5, y: 64, z: 0.5 } });
  });
  const macro = { name: 'macro-envelope', description: '', steps: [{ skill: 'test_envelope_shared', args: {} }] };
  const code = {
    name: 'code-envelope', description: '', steps: [],
    code: 'const r = await api.act("test_envelope_shared", {}); return { ok: r.ok, marker: r.data && r.data.target };',
  };
  setBehaviorRegistry({ get: (name: string) => name === macro.name ? macro : name === code.name ? code : undefined, list: () => [macro, code] });
  t.after(() => { delete SKILLS.test_envelope_shared; setBehaviorRegistry(null); });

  const entries: { taskId: string; skill: string; planId: string }[] = [];
  const runEntry = async (step: { skill: string; args?: unknown }, planId: string) => {
    const started = startTask(w.arbiter, step, 'llm', { planId });
    await w.next();
    entries.push({ taskId: started.id, skill: started.skill, planId });
  };
  await runEntry({ skill: 'test_envelope_shared', args: {} }, 'plan_direct');
  await runEntry({ skill: 'use_skill', args: { name: macro.name } }, 'plan_macro');
  await runEntry({ skill: 'use_skill', args: { name: code.name } }, 'plan_code');

  const required = ['taskId', 'planId', 'planVersion', 'source', 'origin', 'skill', 'args', 'normalizedArgs', 'scope', 'lastPosition', 'resolvedTarget', 'inventoryDiff', 'data', 'budget', 'parentTaskId'];
  for (const entry of entries) {
    const end = w.ends.get(entry.taskId)!;
    for (const key of required) assert.ok(key in end, `${entry.skill} 的 task_end 缺少 ${key}`);
    assert.equal(end.planId, entry.planId);
    assert.equal(end.origin, 'agent');
    assert.ok(end.scope.start && end.scope.end, `${entry.skill} 需要开始/结束作用域`);
    assert.notEqual(end.lastPosition, null);
    assert.ok(end.inventoryDiff, '背包 diff 必须是结构化对象');
    // 宏/代码技能的中间目标没有可靠冒泡时保持 null，不能用末位置冒充解析目标。
    if (end.resolvedTarget === null) assert.equal(end.resolvedTargetFrom, null);
    else assert.deepEqual(end.resolvedTarget, { x: 2, y: 64, z: 0 });
  }
  assert.deepEqual(w.ends.get(entries[0].taskId)!.resolvedTarget, { x: 2, y: 64, z: 0 }, '直接工具保留显式目标');
  assert.equal(w.ends.get(entries[1].taskId)!.resolvedTarget, null, '宏成功结果没有冒泡子目标时保持 null');
  assert.deepEqual(w.ends.get(entries[1].taskId)!.lastPosition, { x: 1.5, y: 64, z: 0.5 }, 'null 目标不能由末位置补出来');
  // 直接工具与宏的末位置来自 adapter 实测；代码技能同样从 adapter 结束态测。
  for (const entry of entries) assert.deepEqual(w.ends.get(entry.taskId)!.lastPosition, { x: 1.5, y: 64, z: 0.5 });
  // 代码技能的外层 data 保留内部 api.act 的返回值。
  const codeEnd = w.ends.get(entries[2].taskId)!;
  assert.deepEqual(codeEnd.data.result.marker, { x: 2, y: 64, z: 0 });
});
