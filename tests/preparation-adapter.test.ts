import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Recipe = require('prismarine-recipe')('1.20.1').Recipe;
const Vec3 = require('vec3').Vec3;

test('adapter craft defaults to the delegated item without manufacturing a table or intermediate planks', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  let crafts = 0, placements = 0;
  adapter.bot = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'oak_log', type: data.itemsByName.oak_log.id, count: 8 }] },
    findBlock: () => null,
    recipesAll: (id: number) => Recipe.find(id, null),
    recipesFor: () => [],
    craft: async () => { crafts++; }, placeBlock: async () => { placements++; },
  };
  adapter.mcData = data;
  Reflect.set(adapter, 'connectedFlag', true);
  const controller = new AbortController();
  const pickaxe = await adapter.craft('wooden_pickaxe', 1, controller.signal);
  assert.equal(pickaxe.reason, 'NO_CRAFTING_TABLE');
  const sticks = await adapter.craft('stick', 4, controller.signal);
  assert.equal(sticks.reason, 'MISSING_MATERIALS');
  assert.deepEqual({ crafts, placements }, { crafts: 0, placements: 0 });
});

test('adapter smelt cannot internally craft or place a furnace without explicit preparation', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  let crafts = 0, placements = 0;
  adapter.bot = {
    entity: {}, game: { dimension: 'overworld' },
    inventory: { items: () => ['raw_iron', 'coal', 'furnace', 'cobblestone'].map((name) => ({ name, count: 8 })) },
    findBlock: () => null,
    craft: async () => { crafts++; }, placeBlock: async () => { placements++; },
  };
  adapter.mcData = data;
  Reflect.set(adapter, 'connectedFlag', true);
  const r = await adapter.smelt('raw_iron', 1, 'coal', new AbortController().signal);
  assert.equal(r.reason, 'NO_FURNACE');
  assert.deepEqual({ crafts, placements }, { crafts: 0, placements: 0 });
});
