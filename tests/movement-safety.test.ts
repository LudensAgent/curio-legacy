import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);

test('walking preserves terrain by default and only explicit terrain work restores the untouched Pathfinder base', async () => {
  const registry = require('minecraft-data')('1.20.1');
  const { Movements } = require('mineflayer-pathfinder');
  const selected: any[] = [];
  const bot: any = {
    registry, entity: {}, game: { dimension: 'overworld' },
    inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 32 }, { type: registry.itemsByName.cobblestone.id, count: 64 }] },
    pathfinder: { setMovements: (movements: any) => selected.push(movements), goto: async () => {} },
  };
  const original = new Movements(bot);
  assert.equal(original.countScaffoldingItems(), 96);
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = original;
  const signal = new AbortController().signal;
  await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { signal, timeoutMs: 1000, constructionSafe: true });
  const safe = selected[0];
  assert.equal(safe instanceof Movements, true);
  assert.equal(safe.canDig, false);
  assert.equal(safe.allow1by1towers, false);
  assert.equal(safe.allowParkour, false);
  assert.deepEqual(safe.scafoldingBlocks, []);
  assert.equal(safe.countScaffoldingItems(), 0, 'horizontal bridges must not see any building materials');
  assert.equal(safe.getScaffoldingItem(), null);
  assert.equal(original.canDig, true);
  assert.equal(original.countScaffoldingItems(), 96, 'the base configuration and inventory remain intact');
  await adapter.moveTo({ kind: 'xz', x: 4, z: 0, range: 1 }, { signal, timeoutMs: 1000 });
  const walking = selected[1];
  assert.notEqual(walking, safe);
  assert.equal(walking instanceof Movements, true);
  assert.equal(walking.blocksCantBreak.has(registry.blocksByName.stone.id), true, 'ordinary walking must not tunnel through a wall');
  assert.equal(walking.blocksCantBreak.has(registry.blocksByName.dirt.id), true);
  assert.equal(walking.blocksCantBreak.has(registry.blocksByName.spruce_leaves.id), false, 'leaves can be pushed through like a player would');
  assert.equal(original.blocksCantBreak.has(registry.blocksByName.stone.id), false, 'the base configuration stays intact');
  assert.equal(walking.allow1by1towers, false, 'ordinary walking must not build pillars');
  assert.deepEqual(walking.scafoldingBlocks, [], 'ordinary walking must not bridge an unsupported edge');
  assert.equal(walking.allowParkour, false, 'parkour jumps from off-centre starts leave the bot stuck on edges');
  await adapter.moveTo({ kind: 'xz', x: 4, z: 0, range: 1 }, { signal, timeoutMs: 1000, allowTerrainChanges: true });
  const terrainWork = selected[2];
  assert.equal(terrainWork.canDig, original.canDig);
  assert.equal(terrainWork.allow1by1towers, original.allow1by1towers);
  assert.deepEqual(terrainWork.scafoldingBlocks, original.scafoldingBlocks);
  assert.equal(terrainWork.countScaffoldingItems(), 96);
});

function placementFixture(move: (goal: any, bot: any) => void) {
  const { Vec3 } = require('vec3');
  const reference = new Vec3(30, 63, 30);
  const world = {
    getBlock: (pos: any) => ({ position: pos, shapes: pos.equals(reference) ? [[0, 0, 0, 1, 1, 1]] : [] }),
    // A narrow corner occludes the face from x/z29.4, although the ideal node
    // centre29.5 sees it. This matches the live house failure geometry.
    raycast: (from: any) => from.x < 29.1 || from.x >= 29.45 && from.z >= 29.45 ? { position: reference, face: 1 } : null,
  };
  const bot: any = { entity: { position: new Vec3(29.41697, 64, 29.41393), eyeHeight: 1.62 }, game: { dimension: 'overworld' }, world,
    waitForTicks: async () => {}, pathfinder: { goto: async (goal: any) => move(goal, bot) } };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = require('minecraft-data')('1.20.1'); (adapter as any).connectedFlag = true;
  return { adapter, Vec3, world };
}

test('placement paths replan an occluded arrival through a different nominal endpoint with a real clickable face', async () => {
  let attempts = 0;
  const fixture = placementFixture((goal, bot) => {
    const { goals } = require('mineflayer-pathfinder');
    const nominal = new goals.GoalPlaceBlock(new fixture.Vec3(30, 64, 30), fixture.world, { range: 4, LOS: true });
    const corner = new fixture.Vec3(29, 64, 29), clear = new fixture.Vec3(28, 64, 29);
    assert.equal(nominal.isEnd(corner), true, 'the installed centre-only goal accepts the problematic corner');
    attempts++;
    if (attempts === 1) {
      assert.equal(goal.isEnd(corner), true, 'prospective nodes retain installed centre semantics');
      return; // goto falsely resolves while the actual off-centre eye is still occluded.
    }
    assert.equal(goal.isEnd(corner), false, 'a proven unusable arrival node must be excluded on replan');
    assert.equal(goal.isEnd(corner.offset(0, 1, 0)), false, 'the partial-block completion alias must also be excluded');
    assert.equal(goal.isEnd(clear), true);
    bot.entity.position = clear.offset(0.5, 0, 0.5);
  });
  await fixture.adapter.moveTo({ kind: 'place_block', pos: { x: 30, y: 64, z: 30 } }, { signal: new AbortController().signal, timeoutMs: 1000, constructionSafe: true });
  assert.equal(attempts, 2);
});

test('resolved empty placement paths cannot claim arrival and alternative replans are bounded', async () => {
  let attempts = 0;
  const { adapter } = placementFixture(() => { attempts++; });
  await assert.rejects(adapter.moveTo({ kind: 'place_block', pos: { x: 30, y: 64, z: 30 } },
    { signal: new AbortController().signal, timeoutMs: 1000, constructionSafe: true }), /PLACEMENT_NOT_REACHABLE/);
  assert.equal(attempts, 4);
});

test('placement replans stop immediately when cancellation arrives after nominal movement', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const { adapter } = placementFixture(() => { attempts++; controller.abort(); });
  await assert.rejects(adapter.moveTo({ kind: 'place_block', pos: { x: 30, y: 64, z: 30 } },
    { signal: controller.signal, timeoutMs: 1000, constructionSafe: true }), { name: 'AbortedError' });
  assert.equal(attempts, 1);
});

async function doorMovements(name: string, open: boolean) {
  const registry = require('minecraft-data')('1.20.1'), Block = require('prismarine-block')(registry);
  const { Vec3 } = require('vec3'), { Movements } = require('mineflayer-pathfinder');
  let selected: any;
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] },
    blockAt(position: any) {
      const p = position.floored();
      const block = p.x === 1 && p.z === 0 && [64, 65].includes(p.y)
        ? Block.fromProperties(name, { facing: 'north', half: p.y === 64 ? 'lower' : 'upper', hinge: 'left', open, powered: false }, 0)
        : Block.fromStateId(registry.blocksByName[p.y === 63 ? 'stone' : 'air'].defaultState, 0);
      block.position = p; return block;
    },
    pathfinder: { setMovements: (m: any) => { selected = m; }, goto: async () => {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = new Movements(bot);
  await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { signal: new AbortController().signal, timeoutMs: 1000 });
  const node = new (require('mineflayer-pathfinder/lib/move'))(0, 64, 0, 0, 0), neighbors: any[] = [];
  selected.getMoveForward(node, { x: 1, z: 0 }, neighbors);
  return { selected, node, neighbors };
}

test('installed Pathfinder opens a closed wooden door instead of breaking it and leaves an open door alone', async () => {
  for (const open of [false, true]) {
    const { selected, node, neighbors } = await doorMovements('birch_door', open);
    assert.equal(selected.canOpenDoors, true);
    assert.equal(neighbors.length, 1);
    assert.deepEqual(neighbors[0].toBreak, []);
    assert.equal(neighbors[0].toPlace.filter((p: any) => p.useOne).length, open ? 0 : 1);
    for (const y of [0, 1]) assert.equal(selected.getBlock(node, 1, y, 0).physical, false, 'neither door half can become a floor');
  }
});

test('installed Pathfinder cannot open or break through an iron door during ordinary walking', async () => {
  const { selected, node, neighbors } = await doorMovements('iron_door', false);
  assert.equal(selected.getBlock(node, 1, 0, 0).openable, false);
  assert.deepEqual(neighbors, []);
});

test('installed Pathfinder dry-walking permission blocks water steps and drops without disabling normal swimming', async () => {
  const registry = require('minecraft-data')('1.20.1'), Block = require('prismarine-block')(registry);
  const { Vec3 } = require('vec3'), { Movements } = require('mineflayer-pathfinder');
  const Move = require('mineflayer-pathfinder/lib/move');
  const selected: any[] = [];
  let edge: 'level' | 'drop' = 'level';
  const bot: any = {
    registry, game: { dimension: 'overworld', minY: -64 }, entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt(position: any) {
      const p = position.floored();
      const name = p.x === 1 && p.z === 0
        ? edge === 'level' ? p.y === 64 ? 'water' : p.y < 64 ? 'stone' : 'air'
          : p.y === 62 ? 'water' : p.y < 62 ? 'stone' : 'air'
        : p.y < 64 ? 'stone' : 'air';
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = p; return block;
    },
    pathfinder: { setMovements: (m: any) => selected.push(m), goto: async () => {} },
  };
  const original = new Movements(bot), adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = original;
  const signal = new AbortController().signal;
  // Only select the installed movement policies; no path search, walking or game ticks run.
  await adapter.moveTo({ kind: 'xz', x: 3, z: 0, range: 1 }, { signal, timeoutMs: 1000, allowSwimming: false });
  await adapter.moveTo({ kind: 'xz', x: 3, z: 0, range: 1 }, { signal, timeoutMs: 1000 });
  const [dry, ordinary] = selected;
  const node = new Move(0, 64, 0, 0, 0), dir = { x: 1, z: 0 };
  for (const policy of [dry, ordinary]) {
    edge = 'level';
    const steps: any[] = [];
    policy.getMoveForward(node, dir, steps);
    assert.equal(steps.length, policy === dry ? 0 : 1, 'level water entry follows this call’s permission');
    edge = 'drop';
    const drops: any[] = [];
    policy.getMoveDropDown(node, dir, drops);
    assert.equal(drops.length, policy === dry ? 0 : 1, 'liquid landing cannot bypass the dry-walking restriction');
    if (drops.length) assert.equal(drops[0].y, 62);
  }
  assert.equal(original.exclusionAreasStep.length, 0, 'the dry request does not mutate the shared base policy');
  assert.equal(original.infiniteLiquidDropdownDistance, true);
  assert.equal(ordinary.infiniteLiquidDropdownDistance, true);
});

test('够到没有碰撞箱的方块（浆果丛、作物）按距离算：视线射线穿过它，不能用“看得见这一面”判到达', async () => {
  const { Vec3 } = require('vec3');
  const goals: any[] = [];
  const bush = new Vec3(10, 64, 10), stone = new Vec3(20, 64, 20);
  const bot: any = { entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, game: { dimension: 'overworld' },
    world: { raycast: () => null, getBlock: () => null },
    blockAt: (p: any) => p.equals(bush) ? { name: 'sweet_berry_bush', position: bush, shapes: [] } : { name: 'stone', position: p, shapes: [[0, 0, 0, 1, 1, 1]] },
    waitForTicks: async () => {}, pathfinder: { goto: async (goal: any) => { goals.push(goal); bot.entity.position = new Vec3(11, 64, 10); } } };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = require('minecraft-data')('1.20.1'); (adapter as any).connectedFlag = true;
  const signal = new AbortController().signal;
  await adapter.moveTo({ kind: 'reach_block', pos: bush }, { signal, timeoutMs: 1000 }).catch(() => {});
  await adapter.moveTo({ kind: 'reach_block', pos: stone }, { signal, timeoutMs: 1000 }).catch(() => {});
  assert.equal(goals[0].constructor.name, 'GoalNear', '浆果丛按距离');
  assert.equal(goals[0].isEnd({ x: 11, y: 64, z: 10 }), true, '站在旁边一格就够得着');
  assert.equal(goals[1].constructor.name, 'GoalLookAtBlock', '实心方块照旧要看得见一面');
});

test('绕开哪些方块由调用的人说（avoid），身体默认不替它定；这一趟的设置不改动基础寻路', async () => {
  const registry = require('minecraft-data')('1.20.1');
  const { Movements } = require('mineflayer-pathfinder');
  const selected: any[] = [];
  const bot: any = { registry, entity: {}, game: { dimension: 'overworld' }, inventory: { items: () => [] },
    pathfinder: { setMovements: (m: any) => selected.push(m), goto: async () => {} } };
  const original = new Movements(bot);
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = original;
  const signal = new AbortController().signal, bush = registry.blocksByName.sweet_berry_bush.id;
  await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { signal, timeoutMs: 1000 });
  assert.equal(selected[0].blocksToAvoid.has(bush), false, '默认不绕');
  await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { signal, timeoutMs: 1000, avoid: ['sweet_berry_bush', 'cactus'] });
  assert.equal(selected[1].blocksToAvoid.has(bush), true);
  assert.equal(original.blocksToAvoid.has(bush), false, '基础寻路没被改');
});
