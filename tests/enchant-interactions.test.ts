import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const registry = minecraftData('1.20.1');
const Item = createRequire(import.meta.url)('prismarine-item')('1.20.1');

test('附魔确认等待目标物品变化，并读取附魔书的实际附魔', async () => {
  const slots = Array(38).fill(null);
  slots[0] = new Item(registry.itemsByName.book.id, 1);
  slots[1] = new Item(registry.itemsByName.lapis_lazuli.id, 3);
  const window = { id: 4, type: 'minecraft:enchantment', inventoryStart: 2, slots,
    enchantments: [{ level: 3 }, { level: 8 }, { level: 30 }] };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    inventory: { slots: [], items: () => [], selectedItem: null }, experience: { level: 10 },
    blockAt: () => ({ name: 'enchanting_table', position: new Vec3(1, 64, 0) }),
    async openEnchantmentTable() { return window; }, closeWindow() {},
    _client: { write() {
      slots[1].count--;
      setTimeout(() => {
        const book = new Item(registry.itemsByName.enchanted_book.id, 1);
        book.enchants = [{ name: 'efficiency', lvl: 1 }];
        slots[0] = book;
      }, 250);
    } },
  };
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus()) as any;
  adapter.bot = bot; adapter.mcData = registry; adapter.connectedFlag = true;
  adapter.moveTo = async () => {};
  const result = await adapter.useGui({ x: 1, y: 64, z: 0 }, [{ button: 0 }], new AbortController().signal);
  assert.equal(result.ok, true);
  assert.match(result.done[0], /附魔成功：enchanted_book 得到 efficiency 1/);
  assert.deepEqual(result.view.slots[0].enchants, ['efficiency 1']);
});
