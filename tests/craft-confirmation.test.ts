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

// ------------------------------------------------------------ 床：日志里连续 20 多次 MISSING_MATERIALS 的复现
function bedWorld(items: [string, number][], tableNearby = true) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const server = new Map<number, number>(items.map(([n, c]) => [data.itemsByName[n].id, c]));
  let client = new Map(server);
  const blocks = new Map<string, any>();
  if (tableNearby) blocks.set(new Vec3(2, 64, 0).toString(), { name: 'crafting_table', position: new Vec3(2, 64, 0) });
  const available = (recipe: any, count: number, table: any) => (!recipe.requiresTable || table) && recipe.delta.every((d: any) => d.count >= 0 || (client.get(d.id) ?? 0) >= -d.count * Math.ceil(count / recipe.result.count));
  const crafted: any[] = [];
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    inventory: { items: () => [...client].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count, name: data.items[type].name })) },
    recipesAll: (id: number, _m: any, table: any) => Recipe.find(id, null).filter((r: any) => !r.requiresTable || table),
    recipesFor: (id: number, _m: any, count: number, table: any) => Recipe.find(id, null).filter((r: any) => available(r, count, table)),
    async craft(recipe: any, times: number, table: any) {
      if (recipe.requiresTable && !table) throw new Error('Recipe requires craftingTable');
      // 按实际放进格子的物品扣料（混用木板时由 inShape 决定）
      for (const d of recipe.delta) {
        const left = (server.get(d.id) ?? 0) + d.count * times;
        if (left < 0) throw new Error('missing ingredient');
        server.set(d.id, left);
      }
      crafted.push(recipe);
    },
    async _syncWindow() { client = new Map(server); },
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
  return { adapter, server, crafted, count: (n: string) => server.get(data.itemsByName[n].id) ?? 0 };
}

test('床：羊毛和木板够、旁边有工作台时能做出来（原来误判成不需要工作台，只试 2×2 染色配方）', async () => {
  const w = bedWorld([['white_wool', 4], ['oak_planks', 5]]);
  const r = await w.adapter.craft('white_bed', 1, new AbortController().signal);
  assert.equal(r.ok, true, `${r.reason} ${r.detail ?? ''}`);
  assert.equal(w.count('white_bed'), 1);
  assert.equal(w.count('white_wool'), 1);
  assert.deepEqual(r.tablePos, { x: 2, y: 64, z: 0 }, '返回用到的工作台位置，便于记住');
});

test('床：混着几种木板也能做（原版允许任意木板）', async () => {
  const w = bedWorld([['white_wool', 3], ['oak_planks', 1], ['birch_planks', 2]]);
  const r = await w.adapter.craft('white_bed', 1, new AbortController().signal);
  assert.equal(r.ok, true, `${r.reason} ${r.detail ?? ''}`);
  assert.equal(w.count('white_bed'), 1);
  assert.equal(w.count('oak_planks') + w.count('birch_planks'), 0);
});

test('床：材料真不够时说清楚缺什么', async () => {
  const w = bedWorld([['white_wool', 2], ['oak_planks', 3]]);
  const r = await w.adapter.craft('white_bed', 1, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'MISSING_MATERIALS');
  assert.match(r.detail ?? '', /white_wool 还差 1/);
});

test('2×2 合成格里有被打断留下的材料：合成前先收回背包，免得一直卡到超时', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const recipe = Recipe.find(data.itemsByName.acacia_planks.id, null)[0];
  const slots: any[] = [];
  slots[2] = { name: 'acacia_planks', count: 1 }; slots[3] = { name: 'acacia_planks', count: 1 };
  const clicks: number[] = [];
  let gridAtCraft: any[] = [];
  adapter.bot = {
    entity: {}, game: { dimension: 'overworld' },
    inventory: { slots, items: () => [{ name: 'acacia_log', type: data.itemsByName.acacia_log.id, count: 1 }], selectedItem: null },
    recipesAll: () => [recipe], recipesFor: () => [recipe],
    async clickWindow(slot: number, _b: number, mode: number) { clicks.push(slot); if (mode === 1) slots[slot] = undefined; },
    async craft() { gridAtCraft = [1, 2, 3, 4].map((i) => slots[i]).filter(Boolean); },
    async _syncWindow() {},
  };
  adapter.mcData = data; (adapter as any).connectedFlag = true;
  await adapter.craft('acacia_planks', 4, new AbortController().signal);
  assert.deepEqual(clicks, [2, 3]);
  assert.equal(gridAtCraft.length, 0, '合成时格子是空的');
});

test('交互卫生：动作被打断后，收回合成格和光标上的东西，并记一笔 interaction_repaired', async () => {
  const bus = new EventBus();
  const events: any[] = [];
  bus.on('event', (e: any) => { if (e.type === 'interaction_repaired') events.push(e); });
  const adapter = new MineflayerAdapter(config, bus);
  const slots: any[] = [];
  slots[1] = { name: 'acacia_planks', count: 2 };
  const inventory: any = { slots, selectedItem: { name: 'stick', count: 1 }, firstEmptyInventorySlot: () => 20, items: () => [] };
  const clicks: [number, number][] = [];
  adapter.bot = {
    entity: {}, game: { dimension: 'overworld' }, inventory,
    async clickWindow(slot: number, _b: number, mode: number) { clicks.push([slot, mode]); if (mode === 1) slots[slot] = undefined; else inventory.selectedItem = null; },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
  };
  adapter.mcData = data; (adapter as any).connectedFlag = true;
  adapter.stopAll();
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(clicks, [[1, 1], [20, 0]]);
  assert.equal(events.length, 1);
  assert.match(events[0].msg, /合成格里有 acacia_planks×2；光标上拿着 stick×1/);
  assert.deepEqual(events[0].data.left, []);
});
