import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { pathfinder } = require('mineflayer-pathfinder');

function fixture(options: { returnPos?: boolean; horizontal?: boolean; delayedEquip?: boolean } = {}) {
  const controls: Record<string, boolean> = {};
  let finishPlacement: () => void = () => {};
  let failPlacement: () => void = () => {};
  let finishEquip: () => void = () => {};
  let placements = 0;
  const bot = Object.assign(new EventEmitter(), {
    registry: require('minecraft-data')('1.20.1'),
    inventory: { items: () => [{ type: require('minecraft-data')('1.20.1').itemsByName.dirt.id, count: 10 }] },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true },
    blockAt: (position: { clone: () => unknown }) => ({ name: 'stone', position: position.clone() }),
    lookAt: async () => {},
    setControlState: (key: string, value: boolean) => { controls[key] = value; },
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false; },
    equip: () => options.delayedEquip ? new Promise<void>(resolve => { finishEquip = resolve; }) : Promise.resolve(),
    placeBlock: () => { placements++; return new Promise<void>((resolve, reject) => { finishPlacement = resolve; failPlacement = () => reject(new Error('placement failed')); }); },
  });
  pathfinder(bot);
  const injected = bot as typeof bot & { pathfinder: {
    setGoal: (goal: object | null) => void;
    getPathTo: () => { status: string; path: object[] };
  } };
  const placement = { x: 0, y: 63, z: 0, dx: 1, dy: options.horizontal === false ? 1 : 0, dz: 0,
    ...(options.returnPos ? { returnPos: new Vec3(0, 64, 0) } : {}) };
  injected.pathfinder.getPathTo = () => ({ status: 'success', path: [{ x: 0.5, y: 64, z: 0.5, toBreak: [], toPlace: [placement] }] });
  injected.pathfinder.setGoal({ isValid: () => true, hasChanged: () => false, isEnd: () => false });
  const tick = () => bot.emit('physicsTick');
  return { bot, controls, tick, cancel: () => injected.pathfinder.setGoal(null), finishPlacement: () => finishPlacement(), failPlacement: () => failPlacement(), finishEquip: () => finishEquip(), placements: () => placements };
}

test('bridge placement stays sneaking while returning to the supporting block', async () => {
  const w = fixture({ returnPos: true });
  w.tick();
  assert.equal(w.controls.sneak, true);
  w.bot.entity.position.x = 1.2;
  w.tick();
  await setImmediate();
  assert.equal(w.placements(), 1);
  assert.equal(w.controls.sneak, true);
  w.finishPlacement();
  await setImmediate();
  assert.equal(w.controls.sneak, true);
  w.tick();
  assert.equal(w.controls.forward, true);
  assert.equal(w.controls.sneak, true, 'return movement must stay crouched');
  w.bot.entity.position.x = 0.5;
  w.tick();
  assert.equal(w.controls.sneak, false, 'release after returning to the block centre');
});

test('placements without a return position do not retain sneak', async () => {
  for (const horizontal of [true, false]) {
    const w = fixture({ horizontal });
    w.tick();
    if (horizontal) { w.bot.entity.position.x = 1.2; w.tick(); }
    await setImmediate();
    assert.equal(w.placements(), 1);
    w.finishPlacement();
    await setImmediate();
    assert.equal(w.controls.sneak, false);
  }
});

test('cancellation clears return movement and ignores a late placement confirmation', async () => {
  const w = fixture({ returnPos: true });
  w.tick();
  w.bot.entity.position.x = 1.2;
  w.tick();
  await setImmediate();
  w.cancel();
  assert.equal(w.controls.sneak, false);
  w.finishPlacement();
  await setImmediate();
  w.tick();
  assert.equal(w.controls.sneak, false);
  assert.notEqual(w.controls.forward, true);
});

test('cancellation before equipping prevents a late placement', async () => {
  const w = fixture({ returnPos: true, delayedEquip: true });
  w.tick();
  w.bot.entity.position.x = 1.2;
  w.tick();
  w.cancel();
  w.finishEquip();
  await setImmediate();
  assert.equal(w.placements(), 0);
  assert.equal(w.controls.sneak, false);
});

test('a block update during placement preserves the crouched return', async () => {
  const w = fixture({ returnPos: true });
  w.tick();
  w.bot.entity.position.x = 1.2;
  w.tick();
  await setImmediate();
  w.bot.emit('blockUpdate', { position: new Vec3(0, 64, 0), type: 0 }, { type: 1 });
  w.finishPlacement();
  await setImmediate();
  w.tick();
  assert.equal(w.controls.forward, true);
  assert.equal(w.controls.sneak, true);
});

test('failed placement and cancellation during the return both clear movement', async () => {
  for (const fail of [true, false]) {
    const w = fixture({ returnPos: true });
    w.tick();
    w.bot.entity.position.x = 1.2;
    w.tick();
    await setImmediate();
    if (fail) w.failPlacement();
    else w.finishPlacement();
    await setImmediate();
    if (!fail) {
      w.tick();
      assert.equal(w.controls.forward, true);
      assert.equal(w.controls.sneak, true);
      w.cancel();
    }
    w.tick();
    assert.equal(w.controls.sneak, false);
    assert.notEqual(w.controls.forward, true);
  }
});
