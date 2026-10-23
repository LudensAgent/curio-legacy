import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);

test('construction-safe movement disables all installed Pathfinder building and the next normal move restores its untouched base', async () => {
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
  const normal = selected[1];
  assert.notEqual(normal, safe);
  assert.equal(normal instanceof Movements, true);
  assert.equal(normal.canDig, true);
  assert.equal(normal.allow1by1towers, true);
  assert.equal(normal.allowParkour, true);
  assert.deepEqual(normal.scafoldingBlocks, original.scafoldingBlocks);
  assert.equal(normal.countScaffoldingItems(), 96);
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
