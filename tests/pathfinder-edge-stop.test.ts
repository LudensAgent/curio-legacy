import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { pathfinder } = require('mineflayer-pathfinder');
const registry = require('minecraft-data')('1.20.1');

test('stopping a bridge placement does not move the player into the unsupported cell', () => {
  const controls = { sneak: true, back: true };
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: new Vec3(1.12, 64, 0.5), velocity: new Vec3(0.02, 0, 0) },
    pathfinder: { stop() {}, setGoal(_goal: null) {} },
    clearControlStates() { controls.sneak = false; controls.back = false; },
  });
  pathfinder(bot);
  const start = bot.entity.position.clone();

  // The feet overlap the edge of the block at x=0, even though their centre
  // is in the empty x=1 cell where Pathfinder is attempting placement.
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);

  assert.deepEqual(bot.entity.position, start);
  assert.equal(bot.entity.velocity.x, 0);
  assert.deepEqual(controls, { sneak: false, back: false });
});

test('stopping ordinary movement preserves the actual position and clears controls', () => {
  const controls = { forward: true };
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: new Vec3(3.15, 64, 4.88), velocity: new Vec3(0.1, 0, -0.1) },
    pathfinder: { stop() {}, setGoal(_goal: null) {} },
    clearControlStates() { controls.forward = false; },
  });
  pathfinder(bot);
  const start = bot.entity.position.clone();

  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);

  assert.deepEqual(bot.entity.position, start);
  assert.equal(bot.entity.velocity.x, 0);
  assert.equal(bot.entity.velocity.z, 0);
  assert.equal(controls.forward, false);
});
