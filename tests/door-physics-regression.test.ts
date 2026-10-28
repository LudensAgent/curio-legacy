import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

test('an open west-facing door can obstruct an ascent from its southern side', () => {
  const data = require('minecraft-data')('1.20.1');
  const Block = require('prismarine-block')(data), { Physics } = require('prismarine-physics');
  const PathfinderPhysics = require('mineflayer-pathfinder/lib/physics'), { Vec3 } = require('vec3');
  for (const open of [false, true]) {
    const environment = {
      getBlock(position: any) {
        const p = position.floored();
        const isDoor = p.x === 0 && p.z === 0 && [70, 71].includes(p.y);
        const wall = p.y >= 70 && p.y <= 71 && ((p.x === 0 && p.z === -1) || (p.x === -1 && p.z === 0) || (p.x === 1 && p.z === 1));
        // Only the observed door, support and three nearby walls are modelled;
        // other cells are assumed empty above a flat floor.
        const block = isDoor
          ? Block.fromProperties('oak_door', { facing: 'west', hinge: 'left', half: p.y === 70 ? 'lower' : 'upper', open, powered: false }, 0)
          : Block.fromStateId(data.blocksByName[wall ? 'cobblestone' : p.y <= 68 || p.x === 0 && p.z === 0 && p.y === 69 ? 'grass_block' : 'air'].defaultState, 0);
        block.position = p;
        return block;
      },
    };
    const bot: any = {
      version: '1.20.1', entity: { position: new Vec3(0.70, 69, 1.55), velocity: new Vec3(0, 0, 0), onGround: true,
        isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        yaw: 0, pitch: 0, effects: {}, attributes: {} }, inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false,
      fireworkRocketDuration: 0, controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
      blockAt: environment.getBlock,
    };
    bot.physics = Physics(data, environment);
    const physics = new PathfinderPhysics(bot), path = [new Vec3(0.5, 70, 0.5)];
    const door = environment.getBlock(new Vec3(0, 70, 0));
    assert.deepEqual(door.shapes, open ? [[0, 0, 0.8125, 1, 1, 1]] : [[0.8125, 0, 0, 1, 1, 1]]);
    assert.equal(physics.canStraightLine(path), !open);
    const state = physics.simulateUntil(physics.getReached(path), physics.getController(path[0], true, false), 20);
    if (open) {
      assert.equal(state.isCollidedHorizontally, true);
      assert.ok(Math.abs(state.pos.z - 1.3) < 1e-6, `door collision stopped at ${state.pos.z}`);
    } else assert.ok(state.pos.z < 1, `advanced beside closed door to ${state.pos.z}`);
  }
});
