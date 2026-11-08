import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { DriveResult } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { glanceSystem, movesCatalog } from '../src/mind/prompt.ts';
import { pressKeys } from '../src/skills/actions.ts';
import { SKILLS } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('the key action and its ascent parameter are visible in ordinary and quick thinking', () => {
  for (const text of [movesCatalog(), glanceSystem('test')]) {
    const line = text.split('\n').find((entry) => entry.startsWith('- press_keys '));
    assert.ok(line);
    assert.match(line, /jump/);
    assert.match(line, /水中.*jump|jump.*水中/);
    assert.match(line, /方向键相对当前朝向/);
  }
});

test('press_keys is available to plans and reports the observed outcome without choosing an escape', async () => {
  const adapter = new FakeAdapter();
  adapter.inWater = true;
  adapter.oxygen = 3;
  let call: unknown;
  adapter.drive = async (keys, ms, _signal, options) => {
    call = { keys, ms, options };
    adapter.pos.y += 2;
    return { ok: true, ms, moved: 2 };
  };
  assert.equal(SKILLS.press_keys, pressKeys);
  const valid = pressKeys.validate({ keys: { jump: true }, ms: 5000, guard: false }, adapter);
  assert.ok(valid.ok);
  const result = await pressKeys.run(makeCtx(adapter), valid.args);
  assert.deepEqual(call, { keys: { jump: true }, ms: 5000, options: { guard: false } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.oxygen, 3);
  assert.equal(result.data?.inWater, true);
  assert.equal((result.data?.position as { y: number }).y, adapter.pos.y);
  assert.match(result.summary, /已松开.*在水中.*氧气 3\/20/);
  assert.ok(!adapter.actions.some((action) => /^(swim|move|dig|place):/.test(action)));
  assert.equal(pressKeys.validate({ keys: { jump: true }, ms: 10001 }, adapter).ok, false);
  assert.equal(pressKeys.validate({ keys: { jump: true, unknown: true }, ms: 500 }, adapter).ok, false);
});

for (const scenario of [
  { name: 'briefly breaching the water', inWater: false, onGround: false, summary: /离水但未触地，尚未确认上岸/ },
  { name: 'recovering oxygen while still swimming', inWater: true, onGround: false, summary: /在水中，未触地/ },
  { name: 'touching ground outside the water', inWater: false, onGround: true, summary: /当前未接触水，当前触地/ },
]) test(`key feedback reports the current state after ${scenario.name} without claiming a stable landing`, async (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  adapter.inWater = true; adapter.onGround = false; adapter.oxygen = 3;
  const drive = t.mock.method(adapter, 'drive', async () => {
    adapter.inWater = scenario.inWater; adapter.onGround = scenario.onGround; adapter.oxygen = 20;
    return { ok: true, ms: 1500, moved: 2 };
  });
  const result = await pressKeys.run(ctx, { keys: { jump: true }, ms: 1500, guard: true });
  assert.equal(result.status, 'succeeded', 'success confirms the requested key press, not the surrounding activity');
  assert.equal(result.data?.inWater, scenario.inWater);
  assert.equal(result.data?.onGround, scenario.onGround);
  assert.equal(result.data?.oxygenBefore, 3);
  assert.equal(result.data?.oxygen, 20);
  assert.match(result.summary, scenario.summary);
  assert.match(result.summary, /氧气 20\/20（按键前 3\/20）/);
  assert.doesNotMatch(result.summary, /已上岸|已换气|站稳|安全/);
  assert.equal(drive.mock.callCount(), 1);
  assert.deepEqual(adapter.actions, [], 'feedback does not add swimming or terrain work');
});

test('guard CLIFF with real displacement is reported as partial progress, not ERROR', async (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.onGround = true;
  adapter.drive = async (): Promise<DriveResult> => {
    adapter.pos = { x: 3.5, y: 63, z: 0.5 };
    return { ok: false, reason: 'CLIFF', stopped: 'cliff', moved: 3.1, ms: 2000 };
  };
  const result = await pressKeys.run(ctx, { keys: { forward: true, sprint: true }, ms: 2000, guard: true });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.stopped, 'cliff');
  assert.equal(result.data?.guardStop, true);
  assert.match(result.summary, /崖边提前停键/);
  assert.match(result.summary, /move_step/);
  assert.match(result.summary, /descend_to/);
});

test('guard CLIFF without displacement reports the stop as a failure with facts', async (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.onGround = true;
  adapter.drive = async (): Promise<DriveResult> => ({ ok: false, reason: 'CLIFF', stopped: 'cliff', moved: 0, ms: 500 });
  const result = await pressKeys.run(ctx, { keys: { forward: true }, ms: 500, guard: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(result.data?.stopped, 'cliff');
  assert.match(result.summary, /未前进/);
  assert.match(result.summary, /move_step|descend_to/);
});

test('a land jump is reported as airborne without inventing a water exit', async (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'drive', async () => {
    adapter.onGround = false;
    return { ok: true, ms: 100, moved: 0.5 };
  });
  const result = await pressKeys.run(ctx, { keys: { jump: true }, ms: 100, guard: true });
  assert.equal(result.data?.onGround, false);
  assert.match(result.summary, /当前未接触水，未触地/);
  assert.doesNotMatch(result.summary, /离水|上岸/);
});

test('the real key controller holds jump beyond one second and releases it on completion or cancellation', async () => {
  const states: Record<string, boolean> = {};
  const bot = {
    entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: false },
    setControlState(key: string, value: boolean) { states[key] = value; },
    clearControlStates() { for (const key of Object.keys(states)) states[key] = false; },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = {};
  Reflect.set(adapter, 'connectedFlag', true);
  const pending = adapter.drive({ jump: true }, 1300, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(states.jump, true);
  const result = await pending;
  assert.ok(result.ms >= 1000);
  assert.equal(states.jump, false);
  const controller = new AbortController();
  const cancelled = adapter.drive({ jump: true }, 5000, controller.signal);
  assert.equal(states.jump, true);
  controller.abort();
  await assert.rejects(cancelled);
  assert.equal(states.jump, false);
});

test('a learned combination can validate and execute the chosen key controls', async () => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  const calls: unknown[] = [];
  adapter.drive = async (keys, ms, _signal, options) => {
    calls.push({ keys, ms, options });
    return { ok: true, ms, moved: 0 };
  };
  const library = new SkillLibrary(null, adapter, ctx.memory, ctx.bus);
  const learned = library.learn({ name: 'test_keys', steps: [
    { skill: 'press_keys', args: { keys: { jump: true }, ms: 2500, guard: false } },
    { skill: 'press_keys', args: { keys: { forward: true }, ms: 100 } },
  ] });
  assert.ok(learned.ok);
  const result = await SKILLS[learned.name].run(ctx, {});
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, [
    { keys: { jump: true }, ms: 2500, options: { guard: false } },
    { keys: { forward: true }, ms: 100, options: { guard: true } },
  ]);
  library.forget(learned.name, '测试结束');
  ctx.memory.close();
});

test('a learned macro runs swim_path surface then a dry-shore target with the validated fractional/negative xyz surviving the round-trip', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  adapter.inWater = true; adapter.oxygen = 10;
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  ctx.deadline = now + 500; // 父预算 500ms；子步骤不得把它重置成自己的 20s
  const delegated: { target: { x: number; y: number; z: number } | null; signal: AbortSignal; timeoutMs?: number }[] = [];
  adapter.swimTo = async (target, signal, opts) => {
    delegated.push({ target, signal, timeoutMs: opts?.timeoutMs });
    if (delegated.length === 1) now += 100; // surface 的真实委托推进时钟：第二步只剩 400ms
    return target
      ? { ok: true, landed: true, surfaced: true, oxygen: 20 }
      : { ok: true, landed: false, surfaced: true, oxygen: 20 };
  };
  // 走真实 SkillLibrary 注册/校验路径执行 surface 与 swim_to，同时捕获它们收到的 ctx，验证继承的 signal/taskId 与父级剩余预算。
  const captured: { skill: string; signal: AbortSignal; taskId: string; deadline: number; remaining: number }[] = [];
  const origSwim = SKILLS.swim_path;
  SKILLS.swim_path = { ...origSwim, run: async (c, a) => { captured.push({ skill: 'swim_path', signal: c.signal, taskId: c.taskId, deadline: c.deadline, remaining: c.deadline - Date.now() }); return origSwim.run(c, a); } };
  const library = new SkillLibrary(null, adapter, ctx.memory, ctx.bus);
  const learned = library.learn({ name: 'surface_then_swim', steps: [
    { skill: 'swim_path', args: { mode: 'surface' } },
    { skill: 'swim_path', args: { mode: 'dry_shore', xyz: [-7.5, 64, 3.25] } },
  ] });
  assert.ok(learned.ok, 'swim_path 的两种模式现在都应可组合');
  try {
    const result = await SKILLS[learned.name].run(ctx, {});
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(delegated.map((d) => d.target), [null, { x: -7.5, y: 64, z: 3.25 }], '第一次上浮传 null，随后 swim_to 的 fractional/negative xyz 经 learn 校验并再校验后原样到达 swimTo（不取整、不加 0.5）');
    assert.deepEqual(delegated.map((d) => d.timeoutMs), [500, 400], 'surface 取得父级全部剩余 500ms；时钟推进后 swim_to 只取得剩余 400ms');
    assert.deepEqual(delegated.map((d) => d.signal), [ctx.signal, ctx.signal], '两次委托都继承调用方的同一个 signal');
    assert.deepEqual(captured.map((c) => c.skill), ['swim_path', 'swim_path'], '两个真实公共委托都按顺序执行');
    assert.deepEqual(captured.map((c) => c.remaining), [500, 400], '子步骤按真实父级剩余预算执行（不是各自的 20s 默认超时）');
    for (const c of captured) {
      assert.equal(c.signal, ctx.signal, `${c.skill} 继承了调用方的 signal`);
      assert.equal(c.taskId, ctx.taskId, `${c.skill} 继承了调用方的 taskId`);
      assert.equal(c.deadline, ctx.deadline, `${c.skill} 的 deadline 保持父级截止时刻，不被重置成 now + 自身超时`);
    }
  } finally {
    SKILLS.swim_path = origSwim;
    library.forget(learned.name, '测试结束');
    ctx.memory.close();
    t.mock.restoreAll();
  }
});
