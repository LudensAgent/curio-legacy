import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { shoreHint } from '../src/skills/movement.ts';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Vec3 = require('vec3').Vec3;

/** 真实物理的水塘：x<6 是 60..63 的水，x≥6 是到 63 的石岸，59 以下是石头 */
function pond(t: TestContext) {
  const { Physics, PlayerState } = require('prismarine-physics');
  const Block = require('prismarine-block')(data);
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const world = { getBlock(position: any) {
    const p = position.floored();
    const name = p.y <= 59 || p.x >= 6 && p.y <= 63 ? 'stone' : p.x < 6 && p.y <= 63 ? 'water' : 'air';
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
    block.position = p; return block;
  } };
  const physics = Physics(data, world);
  const bot: any = {
    version: '1.20.1', game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 61, 2.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, onGround: false, isInWater: true,
      isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, oxygenLevel: 20,
    inventory: { slots: [] }, pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    getControlState(name: string) { return !!controls[name]; },
    clearControlStates() { for (const key of Object.keys(controls)) bot.setControlState(key, false); },
    blockAt: (p: any) => world.getBlock(p),
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  const tick = (n: number, tread: boolean) => {
    for (let i = 0; i < n; i++) {
      if (tread) (adapter as any).treadWater(bot);
      physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
      const head = world.getBlock(bot.entity.position.offset(0, 1.62, 0));
      bot.oxygenLevel = head.name === 'water' ? Math.max(0, bot.oxygenLevel - 0.05) : Math.min(20, bot.oxygenLevel + 0.5);
      now += 50;
    }
  };
  return { adapter, bot, controls, tick };
}

test('idle in deep water: without treading the body sinks and holds its breath', (t) => {
  const { bot, tick } = pond(t);
  tick(200, false);
  assert.ok(bot.oxygenLevel < 15, `oxygen ${bot.oxygenLevel}`);
});

test('idle in deep water: treading keeps the head above the surface, like a player holding jump', (t) => {
  const { bot, tick } = pond(t);
  tick(200, true);
  assert.ok(bot.oxygenLevel >= 19, `oxygen ${bot.oxygenLevel} y=${bot.entity.position.y}`);
  assert.ok(bot.entity.position.y > 61.5);
});

test('treading hands the controls back as soon as an action moves the body', (t) => {
  const { bot, controls, tick } = pond(t);
  tick(20, true);
  assert.equal(controls.jump, true);
  bot.setControlState('forward', true); // 某个动作接手了
  tick(1, true);
  assert.equal(controls.jump, false, 'treading must not keep pressing jump under someone else\'s action');
  bot.setControlState('forward', false);
  bot.setControlState('jump', true); // 别的代码自己按着 jump：这时不归踩水管
  bot.entity.isInWater = false;
  tick(1, true);
  assert.equal(controls.jump, true, 'jump owned by other code is left alone');
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
  adapter.swimTo = async (to: any) => { target = to; adapter.pos = { x: 1.5, y: 64, z: 0.5 }; adapter.inWater = false; return { ok: true, landed: true, oxygen: 20 }; };
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
  adapter.swimTo = async () => ({ ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, oxygen: 20 });
  try {
    const r = await stepTo.run({ adapter, memory, bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 8000, taskId: 'water-step', progress() {},
      senses: { refresh() {}, markSweep() {}, perceivedEntities: () => [], knownBlocks: () => [] } } as any, { at: [1, 0, 0], facing: 'E' });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.match(r.summary, /高 2 格/);
  } finally { memory.close(); }
});

test('shore hint says how high the footing is and gives a copyable step when adjacent', () => {
  const near = shoreHint({ x: 0.5, y: 62.4, z: 0.5 }, { dir: 'E', dist: 1, pos: { x: 1, y: 63, z: 0 } });
  assert.match(near.text, /比脚高 2 格/);
  assert.match(near.text, /step \{"to":\[1,0,0\],"facing":"E"\}/);
  const far = shoreHint({ x: 0.5, y: 62.4, z: 0.5 }, { dir: 'NW', dist: 6, pos: { x: -4, y: 62, z: -4 } });
  assert.doesNotMatch(far.text, /step/);
  assert.match(far.text, /NW 6 格，落脚处比脚高 1 格/);
});
