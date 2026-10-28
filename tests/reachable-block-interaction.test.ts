import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const Vec3 = createRequire(import.meta.url)('vec3').Vec3;

function fixture() {
  const pos = new Vec3(1, 64, 0);
  let open = false, activations = 0, moves = 0;
  const door = { name: 'oak_door', position: pos, shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ open, half: 'lower' }) };
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    inventory: { items: () => [], emptySlotCount: () => 10 },
    blockAt: () => door,
    world: { raycast: () => door },
    async activateBlock() { activations++; open = true; },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = createRequire(import.meta.url)('minecraft-data')('1.20.1'); (adapter as any).connectedFlag = true;
  adapter.moveTo = async () => { moves++; throw new Error('No path'); };
  return { adapter, bot, pos, door, activations: () => activations, moves: () => moves };
}

test('a visible door within reach is interacted with without seeking a new position', async () => {
  const f = fixture();
  const result = await f.adapter.useBlockAt(f.pos, '', new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(f.moves(), 0);
  assert.equal(f.activations(), 1);
  assert.equal(result.effectEvidence?.changed, true);
});

test('an occluded or distant door still requires pathfinding before interaction', async () => {
  for (const mode of ['occluded', 'distant']) {
    const f = fixture();
    if (mode === 'occluded') f.bot.world.raycast = () => ({ ...f.door, position: new Vec3(0, 65, 0) });
    else f.bot.entity.position = new Vec3(-5, 64, 0.5);
    await assert.rejects(f.adapter.useBlockAt(f.pos, '', new AbortController().signal), /No path/);
    assert.equal(f.moves(), 1, mode);
    assert.equal(f.activations(), 0, mode);
  }
});

test('the ray ignores empty cells but stops at an intersecting obstacle before the target', async () => {
  for (const blocked of [false, true]) {
    const f = fixture();
    const air = { ...f.door, name: 'air', position: new Vec3(0, 65, 0), shapes: [] };
    const wall = { ...air, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]] };
    f.bot.world.raycast = ((_from: unknown, _direction: unknown, _range: number, match: (block: typeof f.door, ray: { intersect: (shapes: number[][]) => boolean }) => boolean) => {
      const ray = { intersect: (shapes: number[][]) => shapes.length > 0 };
      return [air, ...(blocked ? [wall] : []), f.door].find((block) => match(block, ray))!;
    }) as typeof f.bot.world.raycast;
    if (blocked) {
      await assert.rejects(f.adapter.useBlockAt(f.pos, '', new AbortController().signal), /No path/);
      assert.equal(f.activations(), 0);
    } else {
      assert.equal((await f.adapter.useBlockAt(f.pos, '', new AbortController().signal)).ok, true);
      assert.equal(f.moves(), 0);
    }
  }
});
