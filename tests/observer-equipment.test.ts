import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Item as InventoryItem } from 'prismarine-item';
import type { Window } from 'prismarine-windows';
import { Vec3 } from 'vec3';
import { ObserverFeed, installMineflayerObserver, type ObserverEvents } from 'curio-observer';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.20.1');
const Item = require('prismarine-item')(registry) as new (type: number, count: number) => InventoryItem;
const { createWindow } = require('prismarine-windows')(registry) as { createWindow(id: number, type: string, title: string): Window };

function fixture() {
  const inventory = createWindow(0, 'minecraft:inventory', '');
  inventory.updateSlot(9, new Item(registry.itemsByName.cobblestone.id, 64));
  const lifecycle: string[] = [], transfers: ObserverEvents['inventory_transfer'][] = [];
  const bot = Object.assign(new EventEmitter(), {
    username: 'Curio', version: '1.20.1', inventory, currentWindow: null,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, metadata: {} }, game: { dimension: 'overworld' },
    quickBarSlot: 0, heldItem: null as InventoryItem | null,
    beforeWindowClick: async (_slot: number, _button: number, _mode: number) => {},
    _syncWindow: async () => {}, craft: async () => {},
    getEquipmentDestSlot: () => 36 + bot.quickBarSlot,
    setQuickBarSlot(slot: number) { bot.quickBarSlot = slot; bot.heldItem = inventory.slots[36 + slot]; },
    async clickWindow(slot: number, mouseButton: number, mode: number) {
      await bot.beforeWindowClick(slot, mouseButton, mode);
      const click = { slot, mouseButton, mode, item: inventory.slots[slot] };
      inventory.acceptClick(click, 0);
      bot.heldItem = inventory.slots[36 + bot.quickBarSlot];
    },
    async equip(item: InventoryItem, _destination: string) {
      if (item.slot >= 36 && item.slot <= 44) { bot.setQuickBarSlot(item.slot - 36); return; }
      await bot.clickWindow(item.slot, 0, 0);
      await bot.clickWindow(36 + bot.quickBarSlot, 0, 0);
    },
    async unequip(_destination: string) {
      await bot.clickWindow(36 + bot.quickBarSlot, 0, 0);
      await bot.clickWindow(9, 0, 0);
    },
  });
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; Reflect.set(adapter, 'connectedFlag', true);
  Reflect.get(adapter, 'installUiPacing').call(adapter, bot);
  const feed = new ObserverFeed(), observer = installMineflayerObserver(bot, feed, { pacingMs: 0 });
  adapter.on('inventory_open', () => { lifecycle.push('open'); feed.openInventory(); });
  adapter.on('inventory_close', () => { lifecycle.push('close'); feed.closeInventory(); });
  feed.on('message', (event, data) => { if (event === 'inventory_transfer') transfers.push(data); });
  return { adapter, bot, inventory, lifecycle, transfers, dispose() { observer.dispose(); feed.dispose(); } };
}

test('direct internal equip and unequip expose their actual inventory transfers', async () => {
  const f = fixture();
  try {
    await f.bot.equip(f.inventory.slots[9]!, 'hand');
    assert.deepEqual(f.lifecycle, ['open', 'close']);
    assert.deepEqual(f.transfers.map(event => [event.kind, event.item.count]), [['take', 64], ['put', 64]]);
    assert.equal(f.inventory.slots[36]?.count, 64);
    await f.bot.unequip('hand');
    assert.deepEqual(f.lifecycle, ['open', 'close', 'open', 'close']);
    assert.equal(f.inventory.slots[9]?.count, 64);
  } finally { f.dispose(); }
});

test('explicit equipment observation nests once and hotbar-only switching opens no window', async () => {
  const f = fixture();
  try {
    const result = await f.adapter.equipItem('cobblestone', 'hand', new AbortController().signal, { sourceSlot: 9 });
    assert.equal(result.ok, true);
    assert.deepEqual(f.lifecycle, ['open', 'close']);
    f.lifecycle.length = 0;
    await f.bot.equip(f.inventory.slots[36]!, 'hand');
    assert.deepEqual(f.lifecycle, []);
  } finally { f.dispose(); }
});

test('cancelled equipment opening closes once and restores the original click hook', async () => {
  const f = fixture(), controller = new AbortController();
  const before = f.bot.beforeWindowClick;
  f.adapter.on('inventory_open', () => controller.abort());
  try {
    await assert.rejects(f.adapter.equipItem('cobblestone', 'hand', controller.signal, { sourceSlot: 9 }), { name: 'AbortedError' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(f.lifecycle, ['open', 'close']);
    assert.equal(f.bot.beforeWindowClick, before);
    assert.equal(f.inventory.slots[9]?.count, 64);
    assert.equal(f.inventory.selectedItem, null);
  } finally { f.dispose(); }
});
