import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const Vec3 = require('vec3').Vec3;

/** 一个最小的假 bot：脚边一格是 name，挖它要 ms 毫秒；背包里有 items */
function botWith(name: string, ms: number, items: { name: string; type: number }[] = []) {
  const dug: string[] = [];
  const block = { name, position: new Vec3(1, 64, 0), diggable: true, hardness: name === 'obsidian' ? 50 : 1.5,
    harvestTools: { 270: true }, digTime: () => ms };
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0), onGround: true, isInWater: false, effects: {} },
    heldItem: null, inventory: { items: () => items }, game: { dimension: 'overworld' },
    blockAt: () => block, canDigBlock: () => true,
    equip: async () => {}, unequip: async () => {},
    dig: async () => { dug.push(name); }, stopDigging() {},
  };
  return { bot, dug };
}

function adapterWith(bot: any) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = {}; (adapter as any).connectedFlag = true;
  return adapter;
}

test('空手挖石头：挖得掉，只是不掉东西（不再一律报“没有镐”）', async () => {
  const { bot, dug } = botWith('stone', 7500);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(r.noDrop, true);
  assert.deepEqual(dug, ['stone']);
});

test('空手挖黑曜石超出身体预算：报告时间限制，不冒充游戏规则或工具缺失', async () => {
  const { bot, dug } = botWith('obsidian', 250_000);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /HAND_DIG_TIMEOUT.*不代表游戏禁止空手/);
  assert.deepEqual(dug, []);
});

test('有对应的镐：照常挖，有掉落', async () => {
  const { bot, dug } = botWith('stone', 1150, [{ name: 'wooden_pickaxe', type: 270 }]);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(dug, ['stone']);
});

/** 背包里铁镐、钻石镐都有，记下挖的时候拿的是哪把 */
function twoPicks(held: string | null) {
  const items = [{ name: 'iron_pickaxe', type: 257, count: 1 }, { name: 'diamond_pickaxe', type: 871, count: 1 }];
  const used: string[] = [];
  const block = { name: 'stone', position: new Vec3(1, 64, 0), diggable: true, hardness: 1.5,
    harvestTools: { 257: true, 871: true }, digTime: (t: number | null) => t === 871 ? 300 : t === 257 ? 400 : 7500 };
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0), onGround: true, isInWater: false, effects: {} },
    heldItem: held ? items.find((i) => i.name === held) : null, inventory: { items: () => items, slots: [] }, game: { dimension: 'overworld' },
    blockAt: () => block, canDigBlock: () => true,
    equip: async (it: any) => { bot.heldItem = it; }, unequip: async () => { bot.heldItem = null; },
    dig: async () => { used.push(bot.heldItem?.name ?? 'hand'); }, stopDigging() {},
  };
  return { bot, used };
}

test('手上拿着能挖的铁镐：就用铁镐，身体不替它换成挖得更快的钻石镐', async () => {
  const { bot, used } = twoPicks('iron_pickaxe');
  await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(used, ['iron_pickaxe']);
});

test('它亲手拿过铁镐：之后手上换成别的东西，自动换工具时还拿铁镐', async () => {
  const { bot, used } = twoPicks(null);
  const adapter = adapterWith(bot);
  (adapter as any).noteToolChoice('iron_pickaxe');
  await adapter.dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(used, ['iron_pickaxe']);
});

test('没挑过工具：按挖得最快的拿', async () => {
  const { bot, used } = twoPicks(null);
  await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(used, ['diamond_pickaxe']);
});
