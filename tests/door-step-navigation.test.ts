import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);

async function ascent(name: string, open: boolean, blockedHead = false, facing = 'east', hinge = 'left', fromEast = false, level = false) {
  const registry = require('minecraft-data')('1.20.1'), Block = require('prismarine-block')(registry);
  const { Vec3 } = require('vec3'), { Movements } = require('mineflayer-pathfinder');
  const Move = require('mineflayer-pathfinder/lib/move');
  let selected: any;
  const bot: any = {
    registry, game: { dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] },
    blockAt(position: any) {
      const p = position.floored();
      const doorY = level ? 64 : 65;
      const isDoor = p.x === 1 && p.z === 0 && [doorY, doorY + 1].includes(p.y) && !(level && blockedHead && p.y === doorY + 1);
      const block = isDoor && name !== 'air'
        ? Block.fromProperties(name, { facing, half: p.y === doorY ? 'lower' : 'upper', hinge, open, powered: false }, 0)
        : Block.fromStateId(registry.blocksByName[p.y < 64 || (!level && p.x === 1 && p.z === 0 && p.y === 64) || (blockedHead && (level ? p.x === 1 && p.y === 65 : p.x === 0 && p.y === 66) && p.z === 0) ? 'stone' : 'air'].defaultState, 0);
      block.position = p; return block;
    },
    pathfinder: { setMovements: (m: any) => { selected = m; }, goto: async () => {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = new Movements(bot);
  await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { signal: new AbortController().signal, timeoutMs: 1000 });
  const node = new Move(fromEast ? 2 : 0, 64, 0, 0, 0), neighbors: any[] = [];
  selected[level ? 'getMoveForward' : 'getMoveJumpUp'](node, { x: fromEast ? -1 : 1, z: 0 }, neighbors);
  return { selected, node, neighbors };
}

test('a wooden door one block above is opened before the jump, without breaking or placing terrain', async () => {
  for (const open of [false, true]) {
    const { selected, node, neighbors } = await ascent('oak_door', open);
    assert.equal(neighbors.length, 1);
    assert.deepEqual([neighbors[0].x, neighbors[0].y, neighbors[0].z], [1, 65, 0]);
    assert.deepEqual(neighbors[0].toBreak, []);
    assert.deepEqual(neighbors[0].toPlace, open ? [] : [{ x: 1, y: 65, z: 0, dx: 0, dy: 0, dz: 0, useOne: true }]);
    assert.equal(neighbors[0].remainingBlocks, 0);
    assert.equal(selected.getBlock(node, 1, 1, 0).safe, open, 'hypothetical opening must not change the actual state');
  }
});
test('door ascent does not bypass a blocked jump or treat an iron door as openable', async () => {
  assert.deepEqual((await ascent('oak_door', false, true)).neighbors, []);
  assert.deepEqual((await ascent('iron_door', false)).neighbors, []);
});

test('an open door panel across the approach blocks an uphill path, but side or far-edge panels do not', async () => {
  const blocked = await ascent('oak_door', true, false, 'north', 'left');
  const farEdge = await ascent('oak_door', true, false, 'north', 'right');
  const side = await ascent('oak_door', true, false, 'west', 'left');
  assert.deepEqual(blocked.selected.getBlock(blocked.node, 1, 1, 0).shapes, [[0, 0, 0, 0.1875, 1, 1]]);
  assert.deepEqual(blocked.neighbors, [], 'the open panel occupies the entrance');
  for (const result of [farEdge, side]) {
    assert.equal(result.neighbors.length, 1, 'the player width clears this open panel');
    assert.deepEqual(result.neighbors[0].toPlace, [], 'walking through an open door does not toggle it');
  }
});

test('the same door may be clear closed and blocked open, depending on approach direction', async () => {
  const closedWest = await ascent('oak_door', false, false, 'north', 'left');
  const openWest = await ascent('oak_door', true, false, 'north', 'left');
  const openEast = await ascent('oak_door', true, false, 'north', 'left', true);
  assert.equal(closedWest.neighbors.length, 1);
  assert.deepEqual(closedWest.neighbors[0].toPlace, [], 'do not open a closed door that already clears the path');
  assert.deepEqual(openWest.neighbors, [], 'do not route through the open panel or toggle it');
  assert.equal(openEast.neighbors.length, 1, 'the opposite approach clears the panel');
  assert.deepEqual(openEast.neighbors[0].toPlace, []);
});

test('level walking uses actual door shapes and opens only when this clears its approach', async () => {
  const blockedClosed = await ascent('oak_door', false, false, 'east', 'left', false, true);
  const clearClosed = await ascent('oak_door', false, false, 'north', 'left', false, true);
  const blockedOpen = await ascent('oak_door', true, false, 'north', 'left', false, true);
  const clearOpen = await ascent('oak_door', true, false, 'north', 'left', true, true);
  assert.equal(blockedClosed.neighbors.length, 1);
  assert.equal(blockedClosed.neighbors[0].toPlace[0].useOne, true, 'opening clears the panel from the near edge');
  assert.equal(clearClosed.neighbors.length, 1);
  assert.deepEqual(clearClosed.neighbors[0].toPlace, [], 'a clear closed door is left alone');
  assert.deepEqual(blockedOpen.neighbors, []);
  assert.equal(clearOpen.neighbors.length, 1);
  assert.deepEqual(clearOpen.neighbors[0].toPlace, []);
  assert.deepEqual((await ascent('iron_door', false, false, 'east', 'left', false, true)).neighbors, []);
  assert.deepEqual((await ascent('oak_door', false, true, 'east', 'left', false, true)).neighbors, [], 'opening a door does not bypass head clearance');
});
