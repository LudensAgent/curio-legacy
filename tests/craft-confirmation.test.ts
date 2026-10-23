import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { TimeoutError } from '../src/util.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Recipe = require('prismarine-recipe')('1.20.1').Recipe;
const Vec3 = require('vec3').Vec3;

test('real recipe graph confirms 2x2 server inventory and replenishes planks consumed by stick subrecipes', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const server = new Map<number, number>([[data.itemsByName.acacia_log.id, 4]]);
  let client = new Map(server);
  let syncs = 0;
  const blocks = new Map<string, any>();
  const available = (recipe: any, count: number, table: any) => (!recipe.requiresTable || table) && recipe.delta.every((d: any) => d.count >= 0 || (client.get(d.id) ?? 0) >= -d.count * Math.ceil(count / recipe.result.count));
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    inventory: { items: () => [...client].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count, name: data.items[type].name })) },
    recipesAll: (id: number, _metadata: any, table: any) => Recipe.find(id, null).filter((r: any) => !r.requiresTable || table),
    recipesFor: (id: number, _metadata: any, count: number, table: any) => Recipe.find(id, null).filter((r: any) => available(r, count, table)),
    async craft(recipe: any, times: number) {
      for (const delta of recipe.delta) server.set(delta.id, (server.get(delta.id) ?? 0) + delta.count * times);
      // The local slot model deliberately remains stale until the server's
      // authoritative full inventory response is requested.
    },
    async _syncWindow() { syncs++; client = new Map(server); },
    findBlock: () => [...blocks.values()].find((b) => b.name === 'crafting_table') ?? null,
    blockAt(pos: any) { return blocks.get(pos.toString()) ?? { name: pos.y === 63 ? 'grass_block' : 'air', boundingBox: pos.y === 63 ? 'block' : 'empty', position: pos }; },
    async equip(item: any) { bot.heldItem = item; },
    async placeBlock(reference: any, face: any) {
      const position = reference.position.plus(face);
      blocks.set(position.toString(), { name: bot.heldItem.name, position });
      server.set(bot.heldItem.type, (server.get(bot.heldItem.type) ?? 0) - 1);
      client = new Map(server);
    },
  };
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  adapter.moveTo = async () => {};
  const result = await adapter.craft('wooden_pickaxe', 1, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.crafted, 1);
  assert.equal(server.get(data.itemsByName.wooden_pickaxe.id), 1);
  assert.ok([...blocks.values()].some((b) => b.name === 'crafting_table'));
  assert.ok(syncs >= 5, 'every dependency craft must await authoritative inventory');
  assert.ok([...server.values()].every((n) => n >= 0), 'no recipe can use the same planks twice');
});

test('an unconfirmed crafting timeout never issues a second ingredient-spending transaction', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  let calls = 0;
  const recipe = Recipe.find(data.itemsByName.acacia_planks.id, null)[0];
  adapter.bot = {
    entity: {}, game: { dimension: 'overworld' },
    inventory: { items: () => [{ name: 'acacia_log', type: data.itemsByName.acacia_log.id, count: 2 }] },
    recipesAll: () => [recipe], recipesFor: () => [recipe],
    async craft() { calls++; throw new TimeoutError('unconfirmed server transaction'); },
  };
  adapter.mcData = data; (adapter as any).connectedFlag = true;
  await assert.rejects(adapter.craft('acacia_planks', 4, new AbortController().signal), { name: 'TimeoutError' });
  assert.equal(calls, 1);
});
