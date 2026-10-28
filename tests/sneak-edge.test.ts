import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');

function walk(scene: 'isolated' | 'shore' | 'pane', sneak: boolean, z = 0.5) {
  // The pane is connected to the stone on its west; at z=0.1 its collision
  // shape does not overlap the player's bounding box.
  const paneState = Array.from(
    { length: data.blocksByName.glass_pane.maxStateId - data.blocksByName.glass_pane.minStateId + 1 },
    (_, i) => data.blocksByName.glass_pane.minStateId + i,
  ).find((id) => {
    const p = Block.fromStateId(id, 0).getProperties();
    return p.west && !p.east && !p.north && !p.south && !p.waterlogged;
  });
  assert.notEqual(paneState, undefined);
  const world = { getBlock(position: { floored(): { x: number; y: number; z: number } }) {
    const p = position.floored();
    const stone = scene === 'shore' ? p.x <= 0 && p.y <= 60 : p.x === 0 && p.y === 60 && p.z === 0;
    const water = scene === 'shore' && p.x >= 1 && p.y >= 56 && p.y <= 60;
    const pane = scene === 'pane' && p.x === 1 && p.y === 60 && p.z === 0;
    const state = pane ? paneState : data.blocksByName[stone ? 'stone' : water ? 'water' : 'air'].defaultState;
    const block = Block.fromStateId(state, 0);
    block.position = p;
    return block;
  } };
  const bot = {
    version: '1.20.1',
    entity: { position: new Vec3(0.5, 61, z), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
  };
  const control = { forward: false, back: false, left: false, right: true, jump: false, sprint: false, sneak };
  const physics = Physics(data, world);
  let lowestY = bot.entity.position.y;
  for (let i = 0; i < 100; i++) {
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    lowestY = Math.min(lowestY, bot.entity.position.y);
  }
  return { position: bot.entity.position, lowestY };
}

test('sneaking stops at the edge of an isolated full block', () => {
  const result = walk('isolated', true);
  assert.equal(result.lowestY, 61);
  assert.ok(result.position.x > 1 && result.position.x < 1.3);
});

test('a nearby pane outside the player collision box is not footing', () => {
  const result = walk('pane', true, 0.1);
  assert.equal(result.lowestY, 61);
  assert.ok(result.position.x < 1.3, `walked off the block to x=${result.position.x}`);
});

test('a pane that overlaps the player can support sneaking', () => {
  const result = walk('pane', true);
  assert.equal(result.lowestY, 61);
  assert.ok(result.position.x > 1.4, `did not advance onto the pane: x=${result.position.x}`);
  assert.ok(result.position.x < 1.8625, `walked off the pane: x=${result.position.x}`);
});

test('sneaking stops at a water shore, while normal walking falls in', () => {
  assert.equal(walk('shore', true).lowestY, 61);
  assert.ok(walk('shore', false).lowestY < 60);
});

test('normal walking can leave an isolated block', () => {
  assert.ok(walk('isolated', false).lowestY < 60);
});
