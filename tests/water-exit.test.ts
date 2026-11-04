import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { surface } from '../src/skills/movement.ts';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const Vec3 = require('vec3').Vec3;

test('idle physics ticks in water do not press jump or change explicit controls', async () => {
  const mineflayer = require('mineflayer');
  const createBot = mineflayer.createBot;
  const client = Object.assign(new EventEmitter(), { state: 'play', version: '1.20.1', write() {}, end() {} });
  const bot = createBot({ version: '1.20.1', client, loadInternalPlugins: false });
  const controls: Record<string, boolean> = {};
  bot.entity = { position: new Vec3(2.5, 61, 2.5), eyeHeight: 1.62, onGround: false, isInWater: true, isInLava: false };
  bot.blockAt = () => ({ name: 'water', getProperties: () => ({}) });
  bot.setControlState = (name: string, value: boolean) => { controls[name] = value; };
  bot.getControlState = (name: string) => !!controls[name];
  bot.loadPlugin = () => {};
  mineflayer.createBot = () => bot;
  try {
    const adapter = new MineflayerAdapter(config, new EventBus());
    adapter.connect();
    await once(bot, 'inject_allowed');
    for (let i = 0; i < 20; i++) bot.emit('physicsTick');
    assert.notEqual(controls.jump, true, 'idle ticks must not start an ascent');
    bot.setControlState('sneak', true);
    bot.emit('physicsTick');
    assert.equal(controls.sneak, true, 'explicit descent remains under caller control');
    assert.notEqual(controls.jump, true);
  } finally { mineflayer.createBot = createBot; }
});
function shore() {
  const adapter = new FakeAdapter();
  adapter.groundY = 59;
  for (let x = -3; x <= 0; x++) for (let z = -2; z <= 2; z++) for (let y = 60; y <= 63; y++) adapter.blocks.push({ name: 'water', pos: { x, y, z } });
  for (let z = -2; z <= 2; z++) for (let y = 60; y <= 63; y++) adapter.blocks.push({ name: 'stone', pos: { x: 1, y, z } });
  adapter.pos = { x: 0.5, y: 62.4, z: 0.5 }; // 浮在水面：脚在 62 那格水里，岸的落脚处在 64
  adapter.inWater = true;
  return adapter;
}

test('step from water climbs onto a bank two blocks above the feet', async () => {
  const adapter = shore(), memory = new WorldMemory(null);
  let target: any = null;
  adapter.swimTo = async (to: any) => { target = to; adapter.pos = { x: 1.5, y: 64, z: 0.5 }; adapter.inWater = false; return { ok: true, landed: true, surfaced: true, oxygen: 20 }; };
  try {
    const v = stepTo.validate({ to: [1, 0, 0], facing: 'E' }, adapter);
    assert.equal(v.ok, true);
    const r = await stepTo.run({ adapter, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 8000, taskId: 'water-step', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] } } as any, (v as any).args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 1.5, y: 64, z: 0.5 });
    assert.match(r.summary, /爬上了岸 \[1,2,0\]/);
  } finally { memory.close(); }
});

test('step from water reports honestly when the climb did not land', async () => {
  const adapter = shore(), memory = new WorldMemory(null);
  adapter.swimTo = async () => ({ ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, surfaced: false, oxygen: 20 });
  try {
    const r = await stepTo.run({ adapter, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 8000, taskId: 'water-step', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] } } as any, { at: [1, 0, 0], facing: 'E' });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.match(r.summary, /高 2 格/);
  } finally { memory.close(); }
});

test('surface reports surfaced (not landed) when the adapter surfaces without dry footing', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  adapter.inWater = true; adapter.oxygen = 18;
  adapter.pos = { x: 0.5, y: 62.4, z: 0.5 };
  adapter.swimTo = async () => { adapter.oxygen = 20; return { ok: true, landed: false, surfaced: true, oxygen: 20 }; };
  try {
    const result = await surface.run({ adapter, memory, bus: new EventBus(), signal: new AbortController().signal,
      deadline: now + 32000, taskId: 'breathing-evidence', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] } }, {});
    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal(result.data?.surfaced, true);
    assert.equal(result.data?.landed, false, '浮出水面不等于上岸');
  } finally { memory.close(); }
});

test('surface refuses an exhausted budget without delegating an ascent', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  adapter.inWater = true; adapter.oxygen = 6;
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  let swims = 0;
  adapter.swimTo = async () => { swims++; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 6 }; };
  try {
    const result = await surface.run({ adapter, memory, bus: new EventBus(), signal: new AbortController().signal,
      deadline: now, taskId: 'surface-expired', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] } }, {});
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'TIMEOUT');
    assert.equal(swims, 0, '预算耗尽不强行上浮');
    assert.equal(result.data?.oxygen, 6, '保留实际氧气');
  } finally { memory.close(); }
});
