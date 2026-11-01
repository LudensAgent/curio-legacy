import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ObserverFeed, installMineflayerObserver, type ObserverEvents } from 'curio-observer';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.20.1');
const Item = require('prismarine-item')(registry);
const { createWindow } = require('prismarine-windows')(registry);
const { Vec3 } = require('vec3');

test('real inventory model sends a carried stack to the hotbar and one group for a partial toss', async () => {
  const inventory = createWindow(0, 'minecraft:inventory', '');
  inventory.updateSlot(9, new Item(registry.itemsByName.cobblestone.id, 64));
  const bot = Object.assign(new EventEmitter(), {
    username: 'Curio', version: '1.20.1', inventory, currentWindow: null,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, metadata: {} }, game: { dimension: 'overworld' },
    quickBarSlot: 0, heldItem: inventory.slots[36],
    beforeWindowClick: async (_slot: number, _button: number, _mode: number) => {},
    _syncWindow: async () => {}, craft: async () => {},
    async clickWindow(slot: number, mouseButton: number, mode: number) {
      await bot.beforeWindowClick(slot, mouseButton, mode);
      inventory.acceptClick({ slot, mouseButton, mode, item: slot === -999 ? null : inventory.slots[slot] });
    },
    async moveSlotItem(source: number, target: number) {
      await bot.clickWindow(source, 0, 0);
      await bot.clickWindow(target, 0, 0);
    },
    setQuickBarSlot(slot: number) { bot.quickBarSlot = slot; bot.heldItem = inventory.slots[36 + slot]; },
  });
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 20, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; Reflect.set(adapter, 'connectedFlag', true);
  Reflect.get(adapter, 'installUiPacing').call(adapter, bot);
  const feed = new ObserverFeed(), observer = installMineflayerObserver(bot, feed, { pacingMs: 0 });
  adapter.on('inventory_open', () => feed.openInventory());
  adapter.on('inventory_close', () => feed.closeInventory());
  const pointers: ObserverEvents['pointer'][] = [], transfers: ObserverEvents['inventory_transfer'][] = [];
  let drops = 0;
  feed.on('message', (type, value) => {
    if (type === 'pointer') pointers.push(value);
    if (type === 'inventory_transfer') transfers.push(value);
    if (type === 'action' && value.type === 'drop') drops++;
  });
  try {
    const held = await adapter.arrangeHotbar('cobblestone', 0, new AbortController().signal, { sourceSlot: 9 });
    assert.equal(held.ok, true);
    assert.deepEqual(pointers.map(p => [p.slot, p.item?.count ?? 0]), [[9, 0], [36, 64]]);
    const tossed = await adapter.tossItem('cobblestone', 40, new AbortController().signal, undefined, { sourceSlot: 36 });
    assert.equal(tossed.tossed, 40);
    assert.equal(inventory.slots[36].count, 24);
    assert.equal(drops, 1);
    assert.deepEqual(transfers.filter(t => t.kind === 'drop').map(t => [t.kind, t.item.count]), [['drop', 40]]);
    assert.equal(pointers.at(-1)?.slot, -999);
    assert.equal(pointers.at(-1)?.item?.count, 40);
  } finally {
    observer.dispose(); feed.dispose();
  }
});
