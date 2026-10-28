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
import { makeCtx } from './survival-helpers.ts';

test('the key action and its ascent parameter are visible in ordinary and quick thinking', () => {
  for (const text of [movesCatalog(), glanceSystem('test', new Set())]) {
    const line = text.split('\n').find((entry) => entry.startsWith('- press_keys '));
    assert.ok(line);
    assert.match(line, /jump/);
    assert.match(line, /水中.*jump|jump.*水中/);
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
