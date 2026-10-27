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

test('空手挖黑曜石这种要挖半分钟以上的：仍然挖不动', async () => {
  const { bot, dug } = botWith('obsidian', 250_000);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(r, { ok: false, reason: 'TOOL_MISSING' });
  assert.deepEqual(dug, []);
});

test('有对应的镐：照常挖，有掉落', async () => {
  const { bot, dug } = botWith('stone', 1150, [{ name: 'wooden_pickaxe', type: 270 }]);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(dug, ['stone']);
});
