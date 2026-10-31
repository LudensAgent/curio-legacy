import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
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
